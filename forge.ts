// forge.ts — the HTTP surface of the forge: routing, auth, the REST v3 API
// and the git smart-HTTP protocol (v0 and v2), all over the shared state in
// state.ts. GraphQL and MCP live in their own modules and are mounted here.
//
// Wire discipline the suite checks: every API reply is JSON with an
// X-GitHub-Request-Id header, errors are {"message": ...}, a request with no
// (or a wrong) bearer token is a 401, a malformed JSON body is a 400, and an
// unknown route is a JSON 404.

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as gs from './gitstore.ts';
import { ForgeState, issueJson, pullJson, repoJson, type RepoRec } from './state.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMCP } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const API_ROOT = '/api/v3';

export interface Forge {
  state: ForgeState;
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function fail(status: number, message: string): never {
  throw new HttpError(status, message);
}

export function createForge(): Forge {
  const state = new ForgeState();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  const authorized = (req: IncomingMessage): boolean => {
    if (token === '') return true;
    return (req.headers.authorization ?? '') === `Bearer ${token}`;
  };

  const sendJson = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
    const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
    res.writeHead(status, {
      'content-type': JSON_TYPE,
      'x-github-request-id': randomUUID(),
      ...(text === '' ? {} : { 'content-length': Buffer.byteLength(text) }),
      ...headers,
    });
    res.end(text);
  };

  const sendRaw = (res: ServerResponse, status: number, body: Buffer, contentType: string): void => {
    res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'x-github-request-id': randomUUID() });
    res.end(body);
  };

  const readBody = async (req: IncomingMessage): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    return Buffer.concat(chunks);
  };

  const readJson = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    const raw = await readBody(req);
    if (raw.length === 0) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      fail(400, 'Problems parsing JSON');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) fail(400, 'Problems parsing JSON');
    return parsed as Record<string, unknown>;
  };

  // ------------------------------------------------------------ REST helpers

  const repoOr404 = (owner: string, name: string): RepoRec => {
    const repo = state.repoFor(owner, name);
    if (!repo) fail(404, 'Not Found');
    return repo!;
  };

  const pagination = (url: URL): { page: number; perPage: number } => {
    const perPageRaw = Number(url.searchParams.get('per_page') ?? '30');
    const pageRaw = Number(url.searchParams.get('page') ?? '1');
    return {
      perPage: Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.floor(perPageRaw)) : 30,
      page: Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1,
    };
  };

  const linkHeader = (req: IncomingMessage, url: URL, total: number, page: number, perPage: number): string | undefined => {
    const lastPage = Math.max(1, Math.ceil(total / perPage));
    if (page >= lastPage) return undefined;
    const origin = `http://${req.headers.host ?? 'localhost'}`;
    const next = new URL(url.pathname, origin);
    for (const [key, value] of url.searchParams) next.searchParams.set(key, value);
    next.searchParams.set('per_page', String(perPage));
    next.searchParams.set('page', String(page + 1));
    const last = new URL(url.pathname, origin);
    for (const [key, value] of url.searchParams) last.searchParams.set(key, value);
    last.searchParams.set('per_page', String(perPage));
    last.searchParams.set('page', String(lastPage));
    return `<${next.toString()}>; rel="next", <${last.toString()}>; rel="last"`;
  };

  // ------------------------------------------------------------ REST: repos

  const restRoot = (res: ServerResponse): void => {
    sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      current_user_repositories_url: '/api/v3/user/repos',
    }, { 'x-oauth-scopes': 'repo, read:org' });
  };

  const createRepo = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readJson(req);
    const name = typeof body.name === 'string' ? body.name : '';
    if (name === '') fail(422, 'Validation Failed: name is required');
    const repo = state.createRepo({
      name,
      description: typeof body.description === 'string' ? body.description : '',
      isPrivate: typeof body.private === 'boolean' ? body.private : false,
    });
    if (!repo) fail(422, 'Repository creation failed: name already exists on this account');
    sendJson(res, 201, repoJson(state, repo!));
  };

  const listUserRepos = (req: IncomingMessage, res: ServerResponse, url: URL): void => {
    const { page, perPage } = pagination(url);
    const all = state.repoList();
    const slice = all.slice((page - 1) * perPage, page * perPage);
    const headers: Record<string, string> = {};
    const link = linkHeader(req, url, all.length, page, perPage);
    if (link) headers.link = link;
    sendJson(res, 200, slice.map((repo) => repoJson(state, repo)), headers);
  };

  const getRepo = (res: ServerResponse, owner: string, name: string): void => {
    sendJson(res, 200, repoJson(state, repoOr404(owner, name)));
  };

  const patchRepo = async (req: IncomingMessage, res: ServerResponse, owner: string, name: string): Promise<void> => {
    const repo = repoOr404(owner, name);
    const body = await readJson(req);
    if (typeof body.description === 'string') repo.description = body.description;
    if (typeof body.private === 'boolean') repo.isPrivate = body.private;
    if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
      state.repos.delete(repo.name);
      repo.name = body.name;
      state.repos.set(repo.name, repo);
    }
    sendJson(res, 200, repoJson(state, repo));
  };

  const deleteRepo = (res: ServerResponse, owner: string, name: string): void => {
    const repo = repoOr404(owner, name);
    state.deleteRepo(repo);
    res.writeHead(204, { 'x-github-request-id': randomUUID() });
    res.end();
  };

  // ------------------------------------------------------------ REST: git data

  const listBranches = (res: ServerResponse, repo: RepoRec): void => {
    const branches: Array<{ name: string; commit: { sha: string } }> = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha } });
    }
    branches.sort((a, b) => (a.name < b.name ? -1 : 1));
    sendJson(res, 200, branches);
  };

  const getBranch = (res: ServerResponse, repo: RepoRec, branch: string): void => {
    const sha = state.branchTip(repo, branch);
    if (!sha) fail(404, 'Not Found');
    sendJson(res, 200, { name: branch, commit: { sha } });
  };

  const getGitRef = (res: ServerResponse, repo: RepoRec, ref: string): void => {
    const sha = repo.refs.get(ref);
    if (!sha) fail(404, 'Not Found');
    const object = repo.store.get(sha!);
    sendJson(res, 200, { ref, object: { sha, type: object?.type ?? 'commit' } });
  };

  const createGitRef = async (req: IncomingMessage, res: ServerResponse, repo: RepoRec): Promise<void> => {
    const body = await readJson(req);
    const ref = typeof body.ref === 'string' ? body.ref : '';
    const sha = typeof body.sha === 'string' ? body.sha : '';
    if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) fail(422, 'Validation Failed');
    const object = repo.store.get(sha);
    if (!object) fail(422, 'Validation Failed: object does not exist');
    const existing = repo.refs.get(ref);
    if (existing !== undefined && existing !== sha) fail(422, 'Reference already exists');
    const hadRefs = repo.refs.size > 0;
    repo.refs.set(ref, sha);
    if (!hadRefs && ref.startsWith('refs/heads/')) repo.defaultBranch = ref.slice('refs/heads/'.length);
    sendJson(res, 201, { ref, object: { sha, type: object!.type } });
  };

  const listCommits = (res: ServerResponse, repo: RepoRec, url: URL): void => {
    const { perPage } = pagination(url);
    const shaParam = url.searchParams.get('sha');
    let tip: string | undefined;
    if (shaParam) {
      tip = repo.refs.get(`refs/heads/${shaParam}`) ?? repo.refs.get(shaParam) ?? (repo.store.has(shaParam) ? shaParam : undefined);
    } else {
      tip = state.defaultTip(repo);
    }
    if (!tip) {
      sendJson(res, 200, []);
      return;
    }
    const walk = gs.walkHistory(repo.store.get.bind(repo.store), tip, perPage);
    const items = walk.map((sha) => {
      const commit = gs.parseCommit(repo.store.get(sha)!.data);
      const person = (line: string): { name: string; email: string; date: string } => {
        const match = /^(.*)<([^>]*)>\s+(\d+)\s+/.exec(line) ?? /^(.*)<([^>]*)>\s+(\d+)/.exec(line);
        const epoch = match ? Number(match[3]) : 0;
        return {
          name: (match?.[1] ?? '').trim(),
          email: match?.[2] ?? '',
          date: new Date(epoch * 1000).toISOString(),
        };
      };
      return {
        sha,
        commit: {
          message: commit.message.replace(/\n$/, ''),
          author: person(commit.author),
          committer: person(commit.committer),
          tree: { sha: commit.tree },
        },
        parents: commit.parents.map((parent) => ({ sha: parent })),
      };
    });
    sendJson(res, 200, items);
  };

  // ------------------------------------------------------------ REST: contents

  const resolveRefTip = (repo: RepoRec, ref: string | null): string | undefined => {
    if (ref === null || ref === '') return state.defaultTip(repo);
    return repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(ref) ?? (repo.store.has(ref) ? ref : undefined);
  };

  const getContents = (res: ServerResponse, repo: RepoRec, path: string, url: URL): void => {
    const tip = resolveRefTip(repo, url.searchParams.get('ref'));
    if (!tip) fail(404, 'Not Found');
    const tree = state.commitTree(repo, tip);
    if (!tree) fail(404, 'Not Found');
    const lookup = repo.store.get.bind(repo.store);
    if (path === '') {
      const entries = gs.parseTree(repo.store.get(tree!)!.data);
      sendJson(res, 200, entries.map((entry) => dirEntryJson(repo, entry, '')));
      return;
    }
    const entry = gs.treeEntryAt(lookup, tree!, path);
    if (!entry) fail(404, 'Not Found');
    if (entry!.mode === '40000') {
      const entries = gs.treeLevelAt(lookup, tree!, path);
      if (!entries) fail(404, 'Not Found');
      sendJson(res, 200, entries!.map((child) => dirEntryJson(repo, child, path)));
      return;
    }
    const blob = repo.store.get(entry!.oid);
    if (!blob) fail(404, 'Not Found');
    sendJson(res, 200, {
      type: 'file',
      encoding: 'base64',
      content: blob!.data.toString('base64'),
      name: path.split('/').pop(),
      path,
      sha: entry!.oid,
      size: blob!.data.length,
    });
  };

  const dirEntryJson = (repo: RepoRec, entry: gs.TreeEntry, prefix: string): Record<string, unknown> => {
    const isDir = entry.mode === '40000';
    const blob = isDir ? undefined : repo.store.get(entry.oid);
    return {
      type: isDir ? 'dir' : 'file',
      name: entry.name,
      path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
      sha: entry.oid,
      size: blob ? blob.data.length : 0,
    };
  };

  const putContents = async (req: IncomingMessage, res: ServerResponse, repo: RepoRec, path: string): Promise<void> => {
    const body = await readJson(req);
    const message = typeof body.message === 'string' ? body.message : 'Update file';
    const contentB64 = typeof body.content === 'string' ? body.content : '';
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const tip = state.branchTip(repo, branch) ?? state.defaultTip(repo);
    const tree = tip ? state.commitTree(repo, tip) : undefined;
    const existing = tree ? gs.treeEntryAt(repo.store.get.bind(repo.store), tree, path) : undefined;
    let status = 201;
    if (existing) {
      if (existing.mode === '40000') fail(422, 'Validation Failed: path is a directory');
      const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
      if (givenSha === undefined) fail(422, '"sha" wasn\'t supplied');
      if (givenSha !== existing.oid) fail(409, 'Conflict: sha does not match');
      status = 200;
    }
    const data = Buffer.from(contentB64, 'base64');
    const blobOid = repo.store.put('blob', data);
    const commitSha = state.commitPathChange(repo, branch, path, blobOid, message);
    sendJson(res, status, {
      content: { name: path.split('/').pop(), path, sha: blobOid, size: data.length, type: 'file', encoding: 'base64' },
      commit: { sha: commitSha, message },
    });
  };

  const deleteContents = async (req: IncomingMessage, res: ServerResponse, repo: RepoRec, path: string): Promise<void> => {
    const body = await readJson(req);
    const message = typeof body.message === 'string' ? body.message : 'Delete file';
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const tip = state.branchTip(repo, branch);
    if (!tip) fail(404, 'Not Found');
    const tree = state.commitTree(repo, tip);
    const existing = tree ? gs.treeEntryAt(repo.store.get.bind(repo.store), tree, path) : undefined;
    if (!existing || existing.mode === '40000') fail(404, 'Not Found');
    const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
    if (givenSha !== undefined && givenSha !== existing!.oid) fail(409, 'Conflict: sha does not match');
    const commitSha = state.commitPathChange(repo, branch, path, null, message);
    sendJson(res, 200, { content: null, commit: { sha: commitSha, message } });
  };

  // ------------------------------------------------------------ REST: issues

  const createLabel = async (req: IncomingMessage, res: ServerResponse, repo: RepoRec): Promise<void> => {
    const body = await readJson(req);
    const name = typeof body.name === 'string' ? body.name : '';
    if (name === '') fail(422, 'Validation Failed: name is required');
    if (repo.labels.has(name)) fail(422, 'Validation Failed: label already exists');
    const label = { name, color: typeof body.color === 'string' ? body.color : 'ededed' };
    repo.labels.set(name, label);
    sendJson(res, 201, { name: label.name, color: label.color });
  };

  const validateLabels = (repo: RepoRec, labels: unknown): string[] => {
    if (!Array.isArray(labels)) return [];
    const names = labels.map((entry) => (typeof entry === 'string' ? entry : '')).filter((name) => name !== '');
    for (const name of names) {
      if (!repo.labels.has(name)) fail(422, `Validation Failed: label "${name}" does not exist`);
    }
    return names;
  };

  const createIssueRest = async (req: IncomingMessage, res: ServerResponse, repo: RepoRec): Promise<void> => {
    const body = await readJson(req);
    const labels = validateLabels(repo, body.labels);
    const issue = state.createIssue(repo, {
      title: typeof body.title === 'string' ? body.title : '',
      body: typeof body.body === 'string' ? body.body : '',
      labels,
    });
    sendJson(res, 201, issueJson(state, repo, issue));
  };

  const listIssuesRest = (res: ServerResponse, repo: RepoRec, url: URL): void => {
    const stateFilter = url.searchParams.get('state') ?? 'open';
    const direction = url.searchParams.get('direction') ?? 'desc';
    let issues = [...repo.issues.values()];
    if (stateFilter === 'open') issues = issues.filter((issue) => issue.state === 'open');
    else if (stateFilter === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
    issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
    const { page, perPage } = pagination(url);
    const slice = issues.slice((page - 1) * perPage, page * perPage);
    sendJson(res, 200, slice.map((issue) => issueJson(state, repo, issue)));
  };

  const getIssueRest = (res: ServerResponse, repo: RepoRec, number: number): void => {
    const issue = repo.issues.get(number);
    if (!issue) fail(404, 'Not Found');
    sendJson(res, 200, issueJson(state, repo, issue!));
  };

  const patchIssueRest = async (req: IncomingMessage, res: ServerResponse, repo: RepoRec, number: number): Promise<void> => {
    const issue = repo.issues.get(number);
    if (!issue) fail(404, 'Not Found');
    const body = await readJson(req);
    if (typeof body.title === 'string') issue!.title = body.title;
    if (typeof body.body === 'string') issue!.body = body.body;
    if (body.state === 'open' || body.state === 'closed') issue!.state = body.state;
    if (body.labels !== undefined) issue!.labels = validateLabels(repo, body.labels);
    sendJson(res, 200, issueJson(state, repo, issue!));
  };

  const createCommentRest = async (req: IncomingMessage, res: ServerResponse, repo: RepoRec, number: number): Promise<void> => {
    const issue = repo.issues.get(number);
    if (!issue) fail(404, 'Not Found');
    const body = await readJson(req);
    const comment = state.addComment(repo, issue!, typeof body.body === 'string' ? body.body : '');
    sendJson(res, 201, { id: comment.id, body: comment.body, user: { login: state.ownerOf(repo) } });
  };

  const listCommentsRest = (res: ServerResponse, repo: RepoRec, number: number): void => {
    const issue = repo.issues.get(number);
    if (!issue) fail(404, 'Not Found');
    sendJson(res, 200, issue!.comments.map((comment) => ({ id: comment.id, body: comment.body, user: { login: state.ownerOf(repo) } })));
  };

  // ------------------------------------------------------------ REST: pulls

  const branchFromRef = (value: unknown): string => {
    if (typeof value !== 'string') return '';
    const colon = value.lastIndexOf(':');
    return colon >= 0 ? value.slice(colon + 1) : value;
  };

  const createPullRest = async (req: IncomingMessage, res: ServerResponse, repo: RepoRec): Promise<void> => {
    const body = await readJson(req);
    const head = branchFromRef(body.head);
    const base = branchFromRef(body.base) || repo.defaultBranch;
    if (!state.branchTip(repo, head)) fail(422, 'Validation Failed: head branch does not exist');
    if (!state.branchTip(repo, base)) fail(422, 'Validation Failed: base branch does not exist');
    for (const pull of repo.pulls.values()) {
      if (pull.state === 'open' && pull.head === head && pull.base === base) {
        fail(422, 'Validation Failed: a pull request already exists for this branch combination');
      }
    }
    const pull = state.createPull(repo, {
      title: typeof body.title === 'string' ? body.title : '',
      body: typeof body.body === 'string' ? body.body : '',
      head,
      base,
    });
    sendJson(res, 201, pullJson(state, repo, pull));
  };

  const listPullsRest = (res: ServerResponse, repo: RepoRec, url: URL): void => {
    const stateFilter = url.searchParams.get('state') ?? 'open';
    let pulls = [...repo.pulls.values()];
    if (stateFilter === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
    else if (stateFilter === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
    pulls.sort((a, b) => a.seq - b.seq);
    const { page, perPage } = pagination(url);
    const slice = pulls.slice((page - 1) * perPage, page * perPage);
    sendJson(res, 200, slice.map((pull) => pullJson(state, repo, pull)));
  };

  const getPullRest = (res: ServerResponse, repo: RepoRec, number: number): void => {
    const pull = repo.pulls.get(number);
    if (!pull) fail(404, 'Not Found');
    sendJson(res, 200, pullJson(state, repo, pull!));
  };

  const listPullFilesRest = (res: ServerResponse, repo: RepoRec, number: number): void => {
    const pull = repo.pulls.get(number);
    if (!pull) fail(404, 'Not Found');
    const lookup = repo.store.get.bind(repo.store);
    const files = state.pullFiles(repo, pull!).map((change) => {
      const oldText = change.oldOid ? (repo.store.get(change.oldOid)?.data.toString('utf8') ?? '') : '';
      const newText = change.newOid ? (repo.store.get(change.newOid)?.data.toString('utf8') ?? '') : '';
      const counts = change.status === 'added'
        ? { additions: countLines(newText), deletions: 0 }
        : change.status === 'removed'
          ? { additions: 0, deletions: countLines(oldText) }
          : gs.lineDiffCounts(oldText, newText);
      return {
        filename: change.path,
        status: change.status,
        additions: counts.additions,
        deletions: counts.deletions,
        changes: counts.additions + counts.deletions,
        sha: change.newOid ?? change.oldOid ?? gs.ZERO_OID,
      };
    });
    void lookup;
    sendJson(res, 200, files);
  };

  const countLines = (text: string): number => {
    if (text === '') return 0;
    const lines = text.split('\n');
    return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  };

  const mergePullRest = async (req: IncomingMessage, res: ServerResponse, repo: RepoRec, number: number): Promise<void> => {
    const pull = repo.pulls.get(number);
    if (!pull) fail(404, 'Not Found');
    const body = await readJson(req);
    if (pull!.state !== 'open' || pull!.merged) fail(405, 'Pull Request is not mergeable');
    const method = body.merge_method === 'merge' ? 'merge' : body.merge_method === 'rebase' ? 'rebase' : 'squash';
    const outcome = state.tryMerge(repo, pull!, true, method);
    if (!outcome.ok || !outcome.sha) fail(405, 'Pull Request is not mergeable');
    sendJson(res, 200, { sha: outcome.sha!, merged: true, message: 'Pull Request successfully merged' });
  };

  // ------------------------------------------------------------ git transport

  const pkt = (payload: string | Buffer): Buffer => {
    const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
    const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
    return Buffer.concat([header, data]);
  };
  const FLUSH = Buffer.from('0000', 'ascii');
  const DELIM = Buffer.from('0001', 'ascii');

  interface PktRead {
    packets: Array<Buffer | 'flush' | 'delim'>;
    rest: Buffer;
  }

  /** Decode pkt-lines from the front of a buffer; stops at the first non-pkt byte. */
  const readPkts = (buf: Buffer): PktRead => {
    const packets: Array<Buffer | 'flush' | 'delim'> = [];
    let offset = 0;
    while (offset + 4 <= buf.length) {
      const head = buf.subarray(offset, offset + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
      const length = Number.parseInt(head, 16);
      if (length === 0) {
        packets.push('flush');
        offset += 4;
        break; // a flush ends the command section for our purposes
      }
      if (length === 1) {
        packets.push('delim');
        offset += 4;
        continue;
      }
      if (length === 2) {
        offset += 4;
        break;
      }
      if (length < 4 || offset + length > buf.length) break;
      packets.push(buf.subarray(offset + 4, offset + length));
      offset += length;
    }
    return { packets, rest: buf.subarray(offset) };
  };

  /** Decode a full pkt-line stream (ls-refs / fetch requests have no pack tail). */
  const readAllPkts = (buf: Buffer): Array<Buffer | 'flush' | 'delim'> => {
    const packets: Array<Buffer | 'flush' | 'delim'> = [];
    let offset = 0;
    while (offset + 4 <= buf.length) {
      const head = buf.subarray(offset, offset + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
      const length = Number.parseInt(head, 16);
      if (length === 0) {
        packets.push('flush');
        offset += 4;
        continue;
      }
      if (length === 1) {
        packets.push('delim');
        offset += 4;
        continue;
      }
      if (length === 2) {
        packets.push('flush');
        offset += 4;
        continue;
      }
      if (length < 4 || offset + length > buf.length) break;
      packets.push(buf.subarray(offset + 4, offset + length));
      offset += length;
    }
    return packets;
  };

  const sortedRefs = (repo: RepoRec): Array<[string, string]> =>
    [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));

  const peeledOf = (repo: RepoRec, oid: string): string | undefined => {
    const object = repo.store.get(oid);
    if (!object || object.type !== 'tag') return undefined;
    return gs.peelToCommit(repo.store.get.bind(repo.store), oid);
  };

  const advertise = (res: ServerResponse, repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack', wantsV2: boolean): void => {
    const contentType = `application/x-${service}-advertisement`;
    if (wantsV2 && service === 'git-upload-pack') {
      const body = Buffer.concat([
        pkt('version 2\n'),
        pkt('agent=forge/1.0.0\n'),
        pkt('ls-refs=symrefs peel\n'),
        pkt('fetch=shallow\n'),
        pkt('object-format=sha1\n'),
        FLUSH,
      ]);
      sendRaw(res, 200, body, contentType);
      return;
    }
    const defaultRef = `refs/heads/${repo.defaultBranch}`;
    const caps = service === 'git-upload-pack'
      ? `side-band-64k thin-pack ofs-delta shallow agent=forge/1.0.0 symref=HEAD:${defaultRef}`
      : `report-status side-band-64k delete-refs ofs-delta agent=forge/1.0.0 symref=HEAD:${defaultRef}`;
    const parts: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
    const refs = sortedRefs(repo);
    if (refs.length === 0) {
      parts.push(pkt(Buffer.concat([Buffer.from(`${gs.ZERO_OID} capabilities^{}\0${caps}`, 'utf8')])));
    } else {
      const headOid = repo.refs.get(defaultRef) ?? gs.ZERO_OID;
      parts.push(pkt(Buffer.concat([Buffer.from(`${headOid} HEAD\0${caps}`, 'utf8')])));
      for (const [name, oid] of refs) {
        parts.push(pkt(`${oid} ${name}`));
        const peeled = peeledOf(repo, oid);
        if (peeled) parts.push(pkt(`${peeled} ${name}^{}`));
      }
    }
    parts.push(FLUSH);
    sendRaw(res, 200, Buffer.concat(parts), contentType);
  };

  const lsRefs = (res: ServerResponse, repo: RepoRec, packets: Array<Buffer | 'flush' | 'delim'>): void => {
    let sawDelim = false;
    let peel = false;
    let symrefs = false;
    const prefixes: string[] = [];
    for (const packet of packets) {
      if (packet === 'delim') {
        sawDelim = true;
        continue;
      }
      if (packet === 'flush') break;
      if (!sawDelim) continue;
      const line = packet.toString('utf8').replace(/\n$/, '');
      if (line === 'peel') peel = true;
      else if (line === 'symrefs') symrefs = true;
      else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
    }
    const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
    const parts: Buffer[] = [];
    const defaultRef = `refs/heads/${repo.defaultBranch}`;
    if (prefixes.length === 0) {
      const headOid = repo.refs.get(defaultRef) ?? gs.ZERO_OID;
      parts.push(pkt(`${headOid} HEAD${symrefs ? ` symref-target:${defaultRef}` : ''}\n`));
    }
    for (const [name, oid] of sortedRefs(repo)) {
      if (!matches(name)) continue;
      let line = `${oid} ${name}`;
      if (peel) {
        const peeled = peeledOf(repo, oid);
        if (peeled) line += ` peeled:${peeled}`;
      }
      parts.push(pkt(`${line}\n`));
    }
    parts.push(FLUSH);
    sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
  };

  const sidebandPack = (pack: Buffer): Buffer[] => {
    const parts: Buffer[] = [];
    const CHUNK = 32768;
    for (let offset = 0; offset < pack.length; offset += CHUNK) {
      const chunk = pack.subarray(offset, Math.min(offset + CHUNK, pack.length));
      parts.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
    }
    if (parts.length === 0) parts.push(pkt(Buffer.concat([Buffer.from([1]), pack])));
    return parts;
  };

  interface FetchArgs {
    wants: string[];
    haves: string[];
    shallow: string[];
    depth: number | null;
    done: boolean;
  }

  const runFetch = (repo: RepoRec, args: FetchArgs): { plan: gs.FetchPlan; pack: Buffer } => {
    const lookup = repo.store.get.bind(repo.store);
    const plan = gs.planFetch(lookup, args.wants, args.haves, args.shallow, args.depth);
    const pack = gs.writePack(lookup, plan.objects);
    return { plan, pack };
  };

  const fetchV2 = (res: ServerResponse, repo: RepoRec, packets: Array<Buffer | 'flush' | 'delim'>): void => {
    const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
    let sawDelim = false;
    for (const packet of packets) {
      if (packet === 'delim') {
        sawDelim = true;
        continue;
      }
      if (packet === 'flush') break;
      if (!sawDelim) continue;
      const line = packet.toString('utf8').replace(/\n$/, '');
      if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7), 10);
      else if (line === 'done') args.done = true;
    }
    const { plan, pack } = runFetch(repo, args);
    const parts: Buffer[] = [pkt('acknowledgments\n')];
    const common = args.haves.find((have) => repo.store.has(have));
    if (common) parts.push(pkt(`ACK ${common}\n`));
    else parts.push(pkt('NAK\n'));
    if (args.done) parts.push(pkt('ready\n'));
    parts.push(DELIM);
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      parts.push(pkt('shallow-info\n'));
      for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
      parts.push(DELIM);
    }
    parts.push(pkt('packfile\n'));
    parts.push(...sidebandPack(pack));
    parts.push(FLUSH);
    sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
  };

  const fetchV0 = (res: ServerResponse, repo: RepoRec, body: Buffer): void => {
    const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
    // Two sections: wants/shallow/deepen, flush, haves/done, flush.
    let section = 0;
    let offset = 0;
    while (offset + 4 <= body.length) {
      const head = body.subarray(offset, offset + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
      const length = Number.parseInt(head, 16);
      if (length === 0) {
        section += 1;
        offset += 4;
        if (section >= 2) break;
        continue;
      }
      if (length < 4 || offset + length > body.length) break;
      const line = body.subarray(offset + 4, offset + length).toString('utf8').replace(/\n$/, '');
      if (line.startsWith('want ')) args.wants.push(line.slice(5).trim().split(' ')[0]!);
      else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7), 10);
      else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
      else if (line === 'done') args.done = true;
      offset += length;
    }
    const { plan, pack } = runFetch(repo, args);
    const parts: Buffer[] = [];
    for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    const common = args.haves.find((have) => repo.store.has(have));
    if (common) parts.push(pkt(`ACK ${common}\n`));
    else parts.push(pkt('NAK\n'));
    parts.push(...sidebandPack(pack));
    parts.push(FLUSH);
    sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
  };

  const uploadPack = async (req: IncomingMessage, res: ServerResponse, repo: RepoRec): Promise<void> => {
    const body = await readBody(req);
    const packets = readAllPkts(body);
    const first = packets.find((packet) => Buffer.isBuffer(packet));
    const firstLine = first ? (first as Buffer).toString('utf8').replace(/\n$/, '') : '';
    if (firstLine === 'command=ls-refs') {
      lsRefs(res, repo, packets);
      return;
    }
    if (firstLine === 'command=fetch') {
      fetchV2(res, repo, packets);
      return;
    }
    // No command line: a protocol v0 negotiation.
    fetchV0(res, repo, body);
  };

  interface PushCommand {
    oldOid: string;
    newOid: string;
    ref: string;
  }

  const receivePack = async (req: IncomingMessage, res: ServerResponse, repo: RepoRec): Promise<void> => {
    const body = await readBody(req);
    const { packets, rest } = readPkts(body);
    const commands: PushCommand[] = [];
    let sideband = false;
    let firstLine = true;
    for (const packet of packets) {
      if (!Buffer.isBuffer(packet)) continue;
      let line = packet.toString('utf8').replace(/\n$/, '');
      if (firstLine) {
        firstLine = false;
        const nul = line.indexOf('\0');
        if (nul >= 0) {
          const caps = line.slice(nul + 1);
          if (caps.split(' ').includes('side-band-64k')) sideband = true;
          line = line.slice(0, nul);
        }
      }
      const parts = line.split(' ');
      if (parts.length === 3 && /^[0-9a-f]{40}$/.test(parts[0]!) && /^[0-9a-f]{40}$/.test(parts[1]!)) {
        commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
      }
    }
    if (commands.length === 0) fail(400, 'no push commands');

    let unpackError: string | null = null;
    const wantsPack = commands.some((command) => command.newOid !== gs.ZERO_OID);
    if (wantsPack && rest.length > 0) {
      try {
        const read = gs.readPack(rest, repo.store.get.bind(repo.store));
        for (const [oid, object] of read.objects) repo.store.putKnown(oid, object.type, object.data);
      } catch (err) {
        unpackError = err instanceof Error ? err.message : 'unpack failed';
      }
    }

    const lookup = repo.store.get.bind(repo.store);
    const reportLines: string[] = [`unpack ${unpackError === null ? 'ok' : `error ${unpackError}`}`];
    const hadRefs = repo.refs.size > 0;
    for (const command of commands) {
      if (unpackError !== null) {
        reportLines.push(`ng ${command.ref} unpack failed`);
        continue;
      }
      const current = repo.refs.get(command.ref) ?? gs.ZERO_OID;
      let reason: string | null = null;
      if (command.oldOid !== current) reason = 'stale info';
      else if (command.newOid === gs.ZERO_OID) {
        if (current === gs.ZERO_OID) reason = 'reference does not exist';
      } else if (!repo.store.has(command.newOid)) reason = 'missing object';
      else if (current !== gs.ZERO_OID && command.ref.startsWith('refs/heads/')) {
        const currentCommit = gs.peelToCommit(lookup, current);
        const newCommit = gs.peelToCommit(lookup, command.newOid);
        if (currentCommit && newCommit && !gs.isAncestor(lookup, currentCommit, newCommit)) reason = 'non-fast-forward';
      }
      if (reason !== null) {
        reportLines.push(`ng ${command.ref} ${reason}`);
        continue;
      }
      if (command.newOid === gs.ZERO_OID) repo.refs.delete(command.ref);
      else repo.refs.set(command.ref, command.newOid);
      if (!hadRefs && command.ref.startsWith('refs/heads/') && command.newOid !== gs.ZERO_OID) {
        repo.defaultBranch = command.ref.slice('refs/heads/'.length);
      }
      reportLines.push(`ok ${command.ref}`);
    }

    const reportStream = Buffer.concat([...reportLines.map((line) => pkt(`${line}\n`)), FLUSH]);
    let payload: Buffer;
    if (sideband) {
      const parts: Buffer[] = [];
      const CHUNK = 32768;
      for (let offset = 0; offset < reportStream.length; offset += CHUNK) {
        parts.push(pkt(Buffer.concat([Buffer.from([1]), reportStream.subarray(offset, Math.min(offset + CHUNK, reportStream.length))])));
      }
      parts.push(FLUSH);
      payload = Buffer.concat(parts);
    } else {
      payload = reportStream;
    }
    sendRaw(res, 200, payload, 'application/x-git-receive-pack-result');
  };

  // ------------------------------------------------------------ routing

  const handleRest = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const method = req.method ?? 'GET';
    const path = url.pathname;
    if (!authorized(req)) fail(401, 'Unauthorized');
    if (path === API_ROOT || path === `${API_ROOT}/`) {
      if (method === 'GET') return restRoot(res);
      fail(404, 'Not Found');
    }
    const segments = path.slice(API_ROOT.length).split('/').filter((segment) => segment !== '').map((segment) => decodeURIComponent(segment));
    if (segments.length === 1 && segments[0] === 'meta' && method === 'GET') {
      return sendJson(res, 200, { installed_version: '1.0.0' });
    }
    if (segments.length === 1 && segments[0] === 'user' && method === 'GET') {
      return sendJson(res, 200, { login: state.login(), id: 1000 });
    }
    if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
      if (method === 'POST') return createRepo(req, res);
      if (method === 'GET') return listUserRepos(req, res, url);
    }
    if (segments.length >= 3 && segments[0] === 'repos') {
      const owner = segments[1]!;
      const name = segments[2]!;
      const rest = segments.slice(3);
      if (rest.length === 0) {
        if (method === 'GET') return getRepo(res, owner, name);
        if (method === 'PATCH') return patchRepo(req, res, owner, name);
        if (method === 'DELETE') return deleteRepo(res, owner, name);
        fail(404, 'Not Found');
      }
      const repo = repoOr404(owner, name);
      if (rest[0] === 'branches') {
        if (rest.length === 1 && method === 'GET') return listBranches(res, repo);
        if (rest.length >= 2 && method === 'GET') return getBranch(res, repo, rest.slice(1).join('/'));
      }
      if (rest[0] === 'git' && rest[1] === 'refs') {
        if (rest.length === 2 && method === 'POST') return createGitRef(req, res, repo);
        if (rest.length >= 3 && method === 'GET') return getGitRef(res, repo, `refs/${rest.slice(2).join('/')}`);
      }
      if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') return listCommits(res, repo, url);
      if (rest[0] === 'contents') {
        const filePath = rest.slice(1).join('/');
        if (method === 'GET') return getContents(res, repo, filePath, url);
        if (method === 'PUT') return putContents(req, res, repo, filePath);
        if (method === 'DELETE') return deleteContents(req, res, repo, filePath);
      }
      if (rest[0] === 'labels') {
        if (rest.length === 1 && method === 'POST') return createLabel(req, res, repo);
        if (rest.length === 1 && method === 'GET') {
          return sendJson(res, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
        }
      }
      if (rest[0] === 'issues') {
        if (rest.length === 1 && method === 'POST') return createIssueRest(req, res, repo);
        if (rest.length === 1 && method === 'GET') return listIssuesRest(res, repo, url);
        if (rest.length === 2) {
          const number = Number(rest[1]);
          if (method === 'GET') return getIssueRest(res, repo, number);
          if (method === 'PATCH') return patchIssueRest(req, res, repo, number);
        }
        if (rest.length === 3 && rest[2] === 'comments') {
          const number = Number(rest[1]);
          if (method === 'POST') return createCommentRest(req, res, repo, number);
          if (method === 'GET') return listCommentsRest(res, repo, number);
        }
      }
      if (rest[0] === 'pulls') {
        if (rest.length === 1 && method === 'POST') return createPullRest(req, res, repo);
        if (rest.length === 1 && method === 'GET') return listPullsRest(res, repo, url);
        if (rest.length === 2) {
          const number = Number(rest[1]);
          if (method === 'GET') return getPullRest(res, repo, number);
        }
        if (rest.length === 3 && rest[2] === 'files' && method === 'GET') return listPullFilesRest(res, repo, Number(rest[1]));
        if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') return mergePullRest(req, res, repo, Number(rest[1]));
      }
    }
    fail(404, 'Not Found');
  };

  const handleGit = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const method = req.method ?? 'GET';
    const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(url.pathname);
    if (!match) fail(404, 'Not Found');
    const owner = decodeURIComponent(match[1]!);
    const name = decodeURIComponent(match[2]!);
    const tail = match[3] ?? '';
    if (!authorized(req)) fail(401, 'Unauthorized');
    const repo = state.repoFor(owner, name);
    if (!repo) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'x-github-request-id': randomUUID() });
      res.end('not found\n');
      return;
    }
    if (tail === '/info/refs' && method === 'GET') {
      const service = url.searchParams.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') fail(400, 'bad service');
      const wantsV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
      return advertise(res, repo!, service as 'git-upload-pack' | 'git-receive-pack', wantsV2);
    }
    if (tail === '/git-upload-pack' && method === 'POST') return uploadPack(req, res, repo!);
    if (tail === '/git-receive-pack' && method === 'POST') return receivePack(req, res, repo!);
    fail(404, 'Not Found');
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? '/', 'http://entry');
      const path = url.pathname;
      if (path === '/healthz' && (req.method ?? 'GET') === 'GET') {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (path === '/api/graphql' && (req.method ?? '') === 'POST') {
        await handleGraphQL(state, req, res, authorized(req), readBody);
        return;
      }
      if (path === '/mcp') {
        await handleMCP(state, req, res, authorized(req), readBody);
        return;
      }
      if (path === API_ROOT || path.startsWith(`${API_ROOT}/`)) {
        await handleRest(req, res, url);
        return;
      }
      if (/^\/[^/]+\/[^/]+\.git(\/.*)?$/.test(path)) {
        await handleGit(req, res, url);
        return;
      }
      if (!authorized(req)) fail(401, 'Unauthorized');
      fail(404, 'Not Found');
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof HttpError) {
        sendJson(res, err.status, { message: err.message });
      } else {
        sendJson(res, 500, { message: 'Internal Server Error' });
      }
    }
  };

  return { state, handle };
}
