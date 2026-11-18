// graphql.ts — a compact GraphQL executor for the forge's v4 surface: the
// query/mutation documents gh and github-mcp-server send (viewer, repository
// reads, issue and pull-request connections with cursor pagination, the
// create/close/merge/comment mutations, Relay node(id:) reads, __type
// introspection probes and operation batching), executed against the same
// state the REST and git surfaces use.
//
// It implements the slice of the language those documents use: operations
// with variable definitions, aliases, arguments (variables, enums, lists,
// input objects, null), inline fragments and named fragments. Unknown fields
// are validation errors in the GitHub shape: HTTP 200 with an errors array.

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as gs from './gitstore.ts';
import { ForgeState, type IssueRec, type PullRec, type RepoRec } from './state.ts';

// ---------------------------------------------------------------------------
// syntax

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Map<string, Value> };

interface FieldNode {
  name: string;
  alias?: string;
  args: Map<string, Value>;
  selections: Selection[];
}

type Selection =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inline'; typeCondition: string; selections: Selection[] }
  | { kind: 'spread'; name: string };

interface Operation {
  operation: 'query' | 'mutation';
  name?: string;
  selections: Selection[];
}

interface Fragment {
  typeCondition: string;
  selections: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, Fragment>;
}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}()[]:=@!|&'.includes(c)) {
      tokens.push(c);
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        const text = source.slice(i + 3, end < 0 ? source.length : end);
        tokens.push(`"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let text = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          text += source[j + 1] === 'n' ? '\n' : source[j + 1] === 't' ? '\t' : source[j + 1]!;
          j += 2;
        } else {
          text += source[j];
          j += 1;
        }
      }
      tokens.push(`"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
      i = j + 1;
      continue;
    }
    if (c === '$') {
      let j = i + 1;
      while (j < source.length && isNameChar(source[j]!)) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j]!)) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j]!)) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    i += 1;
  }
  return tokens;
}

class Parser {
  private tokens: string[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private next(): string {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token}, got ${got}`);
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, Fragment>();
    while (this.pos < this.tokens.length) {
      const token = this.peek()!;
      if (token === '{') {
        operations.push({ operation: 'query', selections: this.parseSelectionSet() });
      } else if (token === 'query' || token === 'mutation' || token === 'subscription') {
        const operation = this.next() as Operation['operation'];
        let name: string | undefined;
        if (this.peek() !== undefined && /^[A-Za-z_]/.test(this.peek()!)) name = this.next();
        if (this.peek() === '(') this.skipVariableDefinitions();
        // Directives on the operation are skipped.
        while (this.peek() === '@') {
          this.next();
          this.next();
          if (this.peek() === '(') this.skipBalanced();
        }
        operations.push({ operation, name, selections: this.parseSelectionSet() });
      } else if (token === 'fragment') {
        this.next();
        const fragName = this.next();
        this.expect('on');
        const typeCondition = this.next();
        fragments.set(fragName, { typeCondition, selections: this.parseSelectionSet() });
      } else {
        this.next();
      }
    }
    return { operations, fragments };
  }

  private skipVariableDefinitions(): void {
    this.skipBalanced();
  }

  private skipBalanced(): void {
    const open = this.next();
    const close = open === '(' ? ')' : open === '[' ? ']' : '}';
    let depth = 1;
    while (this.pos < this.tokens.length && depth > 0) {
      const token = this.next();
      if (token === open) depth += 1;
      else if (token === close) depth -= 1;
    }
  }

  private parseSelectionSet(): Selection[] {
    this.expect('{');
    const selections: Selection[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeCondition = this.next();
          selections.push({ kind: 'inline', typeCondition, selections: this.parseSelectionSet() });
        } else {
          selections.push({ kind: 'spread', name: this.next() });
        }
        continue;
      }
      selections.push({ kind: 'field', field: this.parseField() });
    }
    this.expect('}');
    return selections;
  }

  private parseField(): FieldNode {
    let name = this.next();
    let alias: string | undefined;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args = new Map<string, Value>();
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args.set(argName, this.parseValue());
      }
      this.expect(')');
    }
    // Directives on fields are skipped.
    while (this.peek() === '@') {
      this.next();
      this.next();
      if (this.peek() === '(') this.skipBalanced();
    }
    let selections: Selection[] = [];
    if (this.peek() === '{') selections = this.parseSelectionSet();
    return { name, alias, args, selections };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.startsWith('$')) return { kind: 'var', name: token.slice(1) };
    if (token.startsWith('"')) return { kind: 'string', value: JSON.parse(token) as string };
    if (token === '[') {
      const items: Value[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields = new Map<string, Value>();
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.set(name, this.parseValue());
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token === 'true' || token === 'false') return { kind: 'boolean', value: token === 'true' };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number.parseInt(token, 10) };
    if (/^-?\d+\.\d+/.test(token)) return { kind: 'float', value: Number.parseFloat(token) };
    return { kind: 'enum', value: token };
  }
}

// ---------------------------------------------------------------------------
// schema (for validation and the __type probes)

const OBJECT_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'nodes', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'url', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate',
    'url', 'createdAt', 'updatedAt', 'isFork', 'parent',
  ],
  Ref: ['name', 'prefix', 'target'],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'author', 'comments', 'labels', 'repository',
    'url', 'createdAt', 'updatedAt', 'closed', 'locked',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'files', 'author', 'repository', 'url', 'createdAt', 'updatedAt', 'mergeCommit', 'additions', 'deletions', 'changedFiles',
  ],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFileConnection: ['nodes', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'url'],
  Label: ['id', 'name', 'color'],
  LabelConnection: ['nodes', 'totalCount'],
  Commit: ['id', 'oid', 'message'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  Actor: ['login'],
  Node: ['id'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType', 'specifiedByURL'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  __Schema: ['types', 'queryType', 'mutationType', 'subscriptionType', 'directives'],
};

const ENUM_VALUES: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  StatusState: ['EXPECTED', 'ERROR', 'FAILURE', 'PENDING', 'SUCCESS'],
};

// ---------------------------------------------------------------------------
// values and ids

type Variables = Record<string, unknown>;

function resolveValue(value: Value, variables: Variables): unknown {
  switch (value.kind) {
    case 'var':
      return variables[value.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of value.fields) out[key] = resolveValue(inner, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Variables): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of field.args) out[key] = resolveValue(value, variables);
  return out;
}

/** Opaque, stable global ids: base64 of "<Type>:<key>". */
function encodeId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

function decodeId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { type: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// execution

/** A runtime value: a tagged object the executor can recurse into. */
interface Tagged {
  __typename: string;
  data: unknown;
}

const tagged = (__typename: string, data: unknown): Tagged => ({ __typename, data });

interface ExecContext {
  state: ForgeState;
  variables: Variables;
  fragments: Map<string, Fragment>;
  errors: Array<{ message: string }>;
}

interface IssueConnData {
  repo: RepoRec;
  items: IssueRec[];
  hasNextPage: boolean;
  endCursor: string | null;
}

const cursorOf = (number: number): string => Buffer.from(`n:${number}`, 'utf8').toString('base64');

function repoByGlobalId(state: ForgeState, id: string): RepoRec | undefined {
  const decoded = decodeId(id);
  if (!decoded || decoded.type !== 'Repository') return undefined;
  const dbId = Number(decoded.key);
  for (const repo of state.repos.values()) if (repo.dbId === dbId) return repo;
  return undefined;
}

function issueByGlobalId(state: ForgeState, id: string): { repo: RepoRec; issue: IssueRec } | undefined {
  const decoded = decodeId(id);
  if (!decoded || decoded.type !== 'Issue') return undefined;
  const [dbId, number] = decoded.key.split(':').map(Number);
  for (const repo of state.repos.values()) {
    if (repo.dbId !== dbId) continue;
    const issue = repo.issues.get(number!);
    if (issue) return { repo, issue };
  }
  return undefined;
}

function pullByGlobalId(state: ForgeState, id: string): { repo: RepoRec; pull: PullRec } | undefined {
  const decoded = decodeId(id);
  if (!decoded || decoded.type !== 'PullRequest') return undefined;
  const [dbId, number] = decoded.key.split(':').map(Number);
  for (const repo of state.repos.values()) {
    if (repo.dbId !== dbId) continue;
    const pull = repo.pulls.get(number!);
    if (pull) return { repo, pull };
  }
  return undefined;
}

function resolveField(ctx: ExecContext, typeName: string, source: Tagged | null, field: FieldNode): unknown {
  const { state } = ctx;
  const args = argsOf(field, ctx.variables);
  const data = source?.data as never;
  switch (typeName) {
    case 'Query': {
      if (field.name === 'viewer') return tagged('User', { login: state.login() });
      if (field.name === 'repository') {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        state.learnLogin(owner);
        const repo = state.repoFor(owner, name);
        return repo ? tagged('Repository', repo) : null;
      }
      if (field.name === 'node') {
        const id = String(args.id ?? '');
        const decoded = decodeId(id);
        if (!decoded) return null;
        if (decoded.type === 'Repository') {
          const repo = repoByGlobalId(state, id);
          return repo ? tagged('Repository', repo) : null;
        }
        if (decoded.type === 'Issue') {
          const found = issueByGlobalId(state, id);
          return found ? tagged('Issue', found) : null;
        }
        if (decoded.type === 'PullRequest') {
          const found = pullByGlobalId(state, id);
          return found ? tagged('PullRequest', found) : null;
        }
        return null;
      }
      if (field.name === '__type') {
        const name = String(args.name ?? '');
        if (OBJECT_FIELDS[name]) return tagged('__Type', { name, kind: 'OBJECT' });
        if (ENUM_VALUES[name]) return tagged('__Type', { name, kind: 'ENUM' });
        return null;
      }
      if (field.name === '__schema') return tagged('__Schema', {});
      return null;
    }
    case 'Mutation': {
      if (field.name === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = repoByGlobalId(state, String(input.repositoryId ?? ''));
        if (!repo) throw new Error('repository not found');
        const issue = state.createIssue(repo, {
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
        });
        return tagged('CreateIssuePayload', { repo, issue });
      }
      if (field.name === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = issueByGlobalId(state, String(input.issueId ?? ''));
        if (!found) throw new Error('issue not found');
        found.issue.state = 'closed';
        return tagged('CloseIssuePayload', found);
      }
      if (field.name === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = repoByGlobalId(state, String(input.repositoryId ?? ''));
        if (!repo) throw new Error('repository not found');
        const head = String(input.headRefName ?? '');
        const base = String(input.baseRefName ?? repo.defaultBranch);
        if (!state.branchTip(repo, head)) throw new Error(`head branch ${head} does not exist`);
        if (!state.branchTip(repo, base)) throw new Error(`base branch ${base} does not exist`);
        const pull = state.createPull(repo, {
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
          head,
          base,
        });
        return tagged('CreatePullRequestPayload', { repo, pull });
      }
      if (field.name === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = pullByGlobalId(state, String(input.pullRequestId ?? ''));
        if (!found) throw new Error('pull request not found');
        const method = input.mergeMethod === 'MERGE' ? 'merge' : input.mergeMethod === 'REBASE' ? 'rebase' : 'squash';
        const outcome = state.tryMerge(found.repo, found.pull, true, method);
        if (!outcome.ok) throw new Error('pull request is not mergeable');
        return tagged('MergePullRequestPayload', found);
      }
      if (field.name === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = issueByGlobalId(state, String(input.subjectId ?? ''));
        if (!found) throw new Error('subject not found');
        const comment = state.addComment(found.repo, found.issue, String(input.body ?? ''));
        return tagged('AddCommentPayload', { repo: found.repo, issue: found.issue, comment });
      }
      return null;
    }
    case 'User': {
      const user = data as { login: string };
      if (field.name === 'login') return user.login;
      if (field.name === 'id') return encodeId('User', user.login);
      if (field.name === 'name') return user.login;
      return null;
    }
    case 'Repository': {
      const repo = data as RepoRec;
      switch (field.name) {
        case 'id':
          return encodeId('Repository', String(repo.dbId));
        case 'databaseId':
          return repo.dbId;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${state.ownerOf(repo)}/${repo.name}`;
        case 'owner':
          return tagged('User', { login: state.ownerOf(repo) });
        case 'defaultBranchRef': {
          const tip = state.defaultTip(repo);
          return tip ? tagged('Ref', { name: repo.defaultBranch }) : null;
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'description':
          return repo.description;
        case 'isPrivate':
          return repo.isPrivate;
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return issue ? tagged('Issue', { repo, issue }) : null;
        }
        case 'issues': {
          let items = [...repo.issues.values()];
          const states = Array.isArray(args.states) ? (args.states as string[]) : null;
          if (states && states.length > 0) {
            items = items.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
          }
          const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
          const descending = orderBy.direction === 'DESC';
          items.sort((a, b) => (descending ? b.seq - a.seq : a.seq - b.seq));
          const first = typeof args.first === 'number' ? args.first : items.length;
          let start = 0;
          if (typeof args.after === 'string' && args.after !== '') {
            const afterNumber = Number(Buffer.from(args.after, 'base64').toString('utf8').replace('n:', ''));
            const index = items.findIndex((issue) => issue.number === afterNumber);
            if (index >= 0) start = index + 1;
          }
          const page = items.slice(start, start + first);
          const conn: IssueConnData = {
            repo,
            items: page,
            hasNextPage: start + first < items.length,
            endCursor: page.length > 0 ? cursorOf(page[page.length - 1]!.number) : null,
          };
          return tagged('IssueConnection', conn);
        }
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          return pull ? tagged('PullRequest', { repo, pull }) : null;
        }
        case 'pullRequests': {
          let items = [...repo.pulls.values()];
          const states = Array.isArray(args.states) ? (args.states as string[]) : null;
          if (states && states.length > 0) {
            items = items.filter((pull) => states.includes(pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED'));
          }
          items.sort((a, b) => a.seq - b.seq);
          const first = typeof args.first === 'number' ? args.first : items.length;
          return tagged('PullRequestConnection', { repo, items: items.slice(0, first) });
        }
        default:
          return null;
      }
    }
    case 'Ref': {
      const ref = data as { name: string };
      if (field.name === 'name') return ref.name;
      if (field.name === 'prefix') return 'refs/heads/';
      return null;
    }
    case 'Issue': {
      const { repo, issue } = data as { repo: RepoRec; issue: IssueRec };
      switch (field.name) {
        case 'id':
          return encodeId('Issue', `${repo.dbId}:${issue.number}`);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'state':
          return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'body':
          return issue.body;
        case 'closed':
          return issue.state === 'closed';
        case 'repository':
          return tagged('Repository', repo);
        case 'author':
          return tagged('User', { login: state.ownerOf(repo) });
        default:
          return null;
      }
    }
    case 'PullRequest': {
      const { repo, pull } = data as { repo: RepoRec; pull: PullRec };
      switch (field.name) {
        case 'id':
          return encodeId('PullRequest', `${repo.dbId}:${pull.number}`);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged':
          return pull.merged;
        case 'mergeable': {
          if (pull.state !== 'open') return 'UNKNOWN';
          return state.pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
        }
        case 'headRefName':
          return pull.head;
        case 'baseRefName':
          return pull.base;
        case 'repository':
          return tagged('Repository', repo);
        case 'author':
          return tagged('User', { login: state.ownerOf(repo) });
        case 'files': {
          const first = typeof args.first === 'number' ? args.first : 100;
          const files = state.pullFiles(repo, pull).slice(0, first);
          return tagged('PullRequestChangedFileConnection', { files });
        }
        default:
          return null;
      }
    }
    case 'IssueConnection': {
      const conn = data as IssueConnData;
      if (field.name === 'nodes') return conn.items.map((issue) => tagged('Issue', { repo: conn.repo, issue }));
      if (field.name === 'pageInfo') {
        return tagged('PageInfo', {
          hasNextPage: conn.hasNextPage,
          hasPreviousPage: false,
          startCursor: conn.items.length > 0 ? cursorOf(conn.items[0]!.number) : null,
          endCursor: conn.endCursor,
        });
      }
      if (field.name === 'totalCount') return conn.items.length;
      return null;
    }
    case 'PullRequestConnection': {
      const conn = data as { repo: RepoRec; items: PullRec[] };
      if (field.name === 'nodes') return conn.items.map((pull) => tagged('PullRequest', { repo: conn.repo, pull }));
      if (field.name === 'totalCount') return conn.items.length;
      if (field.name === 'pageInfo') {
        return tagged('PageInfo', { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null });
      }
      return null;
    }
    case 'PullRequestChangedFileConnection': {
      const conn = data as { files: gs.FileChange[] };
      if (field.name === 'nodes') return conn.files.map((file) => tagged('PullRequestChangedFile', file));
      if (field.name === 'totalCount') return conn.files.length;
      return null;
    }
    case 'PullRequestChangedFile': {
      const file = data as gs.FileChange;
      if (field.name === 'path') return file.path;
      if (field.name === 'additions') return 0;
      if (field.name === 'deletions') return 0;
      if (field.name === 'changeType') return file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED';
      return null;
    }
    case 'PageInfo': {
      const info = data as Record<string, unknown>;
      return info[field.name] ?? null;
    }
    case 'CreateIssuePayload': {
      const payload = data as { repo: RepoRec; issue: IssueRec };
      if (field.name === 'issue') return tagged('Issue', payload);
      return null;
    }
    case 'CloseIssuePayload': {
      const payload = data as { repo: RepoRec; issue: IssueRec };
      if (field.name === 'issue') return tagged('Issue', payload);
      return null;
    }
    case 'CreatePullRequestPayload': {
      const payload = data as { repo: RepoRec; pull: PullRec };
      if (field.name === 'pullRequest') return tagged('PullRequest', payload);
      return null;
    }
    case 'MergePullRequestPayload': {
      const payload = data as { repo: RepoRec; pull: PullRec };
      if (field.name === 'pullRequest') return tagged('PullRequest', payload);
      return null;
    }
    case 'AddCommentPayload': {
      const payload = data as { repo: RepoRec; issue: IssueRec; comment: { id: number; body: string } };
      if (field.name === 'commentEdge') return tagged('IssueCommentEdge', payload);
      if (field.name === 'subject') return tagged('Issue', { repo: payload.repo, issue: payload.issue });
      return null;
    }
    case 'IssueCommentEdge': {
      const payload = data as { repo: RepoRec; issue: IssueRec; comment: { id: number; body: string } };
      if (field.name === 'node') return tagged('IssueComment', payload);
      if (field.name === 'cursor') return cursorOf(payload.issue.number);
      return null;
    }
    case 'IssueComment': {
      const payload = data as { repo: RepoRec; issue: IssueRec; comment: { id: number; body: string } };
      if (field.name === 'id') return encodeId('IssueComment', `${payload.repo.dbId}:${payload.issue.number}:${payload.comment.id}`);
      if (field.name === 'body') return payload.comment.body;
      if (field.name === 'author') return tagged('User', { login: state.ownerOf(payload.repo) });
      return null;
    }
    case '__Type': {
      const type = data as { name: string; kind: string };
      if (field.name === 'name') return type.name;
      if (field.name === 'kind') return type.kind;
      if (field.name === 'fields') {
        const fields = OBJECT_FIELDS[type.name];
        return fields ? fields.map((name) => tagged('__Field', { name })) : null;
      }
      if (field.name === 'enumValues') {
        const values = ENUM_VALUES[type.name];
        return values ? values.map((name) => tagged('__EnumValue', { name })) : null;
      }
      return null;
    }
    case '__Field': {
      const fieldData = data as { name: string };
      if (field.name === 'name') return fieldData.name;
      if (field.name === 'isDeprecated') return false;
      return null;
    }
    case '__EnumValue': {
      const valueData = data as { name: string };
      if (field.name === 'name') return valueData.name;
      if (field.name === 'isDeprecated') return false;
      return null;
    }
    case '__Schema': {
      if (field.name === 'queryType') return tagged('__Type', { name: 'Query', kind: 'OBJECT' });
      if (field.name === 'mutationType') return tagged('__Type', { name: 'Mutation', kind: 'OBJECT' });
      return null;
    }
    default:
      return null;
  }
}

function executeSelections(ctx: ExecContext, typeName: string, source: Tagged | null, selections: Selection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (source && (selection.typeCondition === source.__typename || selection.typeCondition === 'Node')) {
        Object.assign(out, executeSelections(ctx, source.__typename, source, selection.selections));
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment && source && (fragment.typeCondition === source.__typename || fragment.typeCondition === 'Node')) {
        Object.assign(out, executeSelections(ctx, source.__typename, source, fragment.selections));
      }
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = source?.__typename ?? typeName;
      continue;
    }
    const knownFields = OBJECT_FIELDS[typeName];
    if (knownFields && !knownFields.includes(field.name) && typeName !== 'Query' && field.name !== '__type' && field.name !== '__schema') {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    if (typeName === 'Query' && field.name !== '__type' && field.name !== '__schema' && knownFields && !knownFields.includes(field.name)) {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type 'Query'` });
      out[key] = null;
      continue;
    }
    let value: unknown;
    try {
      value = resolveField(ctx, typeName, source, field);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(ctx, value, field.selections);
  }
  return out;
}

function completeValue(ctx: ExecContext, value: unknown, selections: Selection[]): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(ctx, item, selections));
  if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
    const taggedValue = value as Tagged;
    if (selections.length === 0) return taggedValue.data;
    return executeSelections(ctx, taggedValue.__typename, taggedValue, selections);
  }
  return value;
}

export function executeGraphQL(state: ForgeState, query: string, variables: Variables): { data: unknown; errors?: Array<{ message: string }> } {
  const parser = new Parser(query);
  const document = parser.parseDocument();
  const operation = document.operations[0];
  if (!operation) return { data: null, errors: [{ message: 'no operation in the document' }] };
  const ctx: ExecContext = { state, variables, fragments: document.fragments, errors: [] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(ctx, rootType, tagged(rootType, {}), operation.selections);
  const result: { data: unknown; errors?: Array<{ message: string }> } = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

// ---------------------------------------------------------------------------
// HTTP

export async function handleGraphQL(
  state: ForgeState,
  req: IncomingMessage,
  res: ServerResponse,
  authorized: boolean,
  readBody: (req: IncomingMessage) => Promise<Buffer>,
): Promise<void> {
  const send = (status: number, body: unknown): void => {
    const text = `${JSON.stringify(body)}\n`;
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'x-github-request-id': randomUUID(),
    });
    res.end(text);
  };
  if (!authorized) {
    send(401, { message: 'Unauthorized' });
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    send(400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  const runOne = (entry: unknown): unknown => {
    if (typeof entry !== 'object' || entry === null) return { errors: [{ message: 'invalid operation' }] };
    const record = entry as Record<string, unknown>;
    const query = typeof record.query === 'string' ? record.query : '';
    const variables = (typeof record.variables === 'object' && record.variables !== null ? record.variables : {}) as Variables;
    try {
      return executeGraphQL(state, query, variables);
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
  };
  if (Array.isArray(parsed)) {
    send(200, parsed.map(runOne));
    return;
  }
  send(200, runOne(parsed));
}
