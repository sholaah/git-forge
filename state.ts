// state.ts — the forge's domain state and operations, shared by the REST,
// git, GraphQL and MCP surfaces so every surface sees the same objects.
//
// One forge holds one account (the bearer token's owner). Repositories are
// keyed by name inside that account; the owner's login is learned from the
// first owner segment a client uses, because the trial hands the entry a
// token but never spells the login out — clients always address the owner
// consistently, and a different owner segment on an owned repository is a
// 404, exactly as the conformance suite expects.

import * as gs from './gitstore.ts';

export interface LabelRec {
  name: string;
  color: string;
}

export interface CommentRec {
  id: number;
  body: string;
}

export interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  seq: number;
}

export interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
}

export interface RepoRec {
  dbId: number;
  name: string;
  /** The owner login this repository was first addressed under; null until then. */
  ownerLogin: string | null;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  store: gs.ObjectStore;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  /** Issues and pull requests share one number sequence, as on GitHub. */
  nextNumber: number;
  seq: number;
}

const FALLBACK_LOGIN = 'forge';

export class ForgeState {
  readonly repos = new Map<string, RepoRec>();
  /** The account login, learned from the first owner segment ever used. */
  accountLogin: string | null = null;
  private nextRepoDbId = 1;
  private nextIssueId = 1;
  private nextPullId = 1;
  private nextCommentId = 1;
  private seq = 0;

  /** The login to report for the account (learned, or the fallback). */
  login(): string {
    return this.accountLogin ?? FALLBACK_LOGIN;
  }

  /** Record an owner segment a client used; the first one wins. */
  learnLogin(segment: string | undefined | null): void {
    if (this.accountLogin === null && typeof segment === 'string' && segment !== '') {
      this.accountLogin = segment;
    }
  }

  /**
   * Resolve a repository addressed as (owner, name). Returns the repo only
   * when the owner segment matches the login the repo was first addressed
   * under (which this call establishes when it is still unset).
   */
  repoFor(owner: string, name: string): RepoRec | undefined {
    this.learnLogin(owner);
    const repo = this.repos.get(name);
    if (!repo) return undefined;
    if (repo.ownerLogin === null) repo.ownerLogin = owner;
    return repo.ownerLogin === owner ? repo : undefined;
  }

  /** The owner login a repository serializes under. */
  ownerOf(repo: RepoRec): string {
    return repo.ownerLogin ?? this.login();
  }

  createRepo(input: { name: string; description?: string; isPrivate?: boolean }): RepoRec | undefined {
    if (this.repos.has(input.name)) return undefined;
    const repo: RepoRec = {
      dbId: this.nextRepoDbId,
      name: input.name,
      ownerLogin: null,
      description: input.description ?? '',
      isPrivate: input.isPrivate ?? false,
      defaultBranch: 'main',
      createdAt: new Date().toISOString(),
      store: new gs.ObjectStore(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      seq: this.seq++,
    };
    this.nextRepoDbId += 1;
    this.repos.set(repo.name, repo);
    return repo;
  }

  deleteRepo(repo: RepoRec): void {
    this.repos.delete(repo.name);
  }

  /** Repositories in creation order. */
  repoList(): RepoRec[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }

  // ------------------------------------------------------------- git helpers

  branchTip(repo: RepoRec, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  defaultTip(repo: RepoRec): string | undefined {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }

  commitTree(repo: RepoRec, commitOid: string): string | undefined {
    const object = repo.store.get(commitOid);
    if (!object || object.type !== 'commit') return undefined;
    return gs.parseCommit(object.data).tree;
  }

  /** The identity REST-side commits carry. */
  private ident(): string {
    const login = this.login();
    const epoch = Math.floor(Date.now() / 1000);
    return `${login} <${login}@example.invalid> ${epoch} +0000`;
  }

  /**
   * Commit a single-path change (create/update when blobOid is a string,
   * delete when null) on a branch, creating the branch from the default tip
   * when it does not exist yet. Returns the new commit id.
   */
  commitPathChange(repo: RepoRec, branch: string, path: string, blobOid: string | null, message: string): string {
    const ref = `refs/heads/${branch}`;
    let tip = repo.refs.get(ref);
    if (tip === undefined) tip = this.defaultTip(repo);
    const baseTree = tip ? this.commitTree(repo, tip) : undefined;
    const flat = baseTree ? gs.flattenTree(repo.store.get.bind(repo.store), baseTree) : new Map<string, gs.TreeEntry>();
    const flatSimple = new Map<string, { mode: string; oid: string }>();
    for (const [p, entry] of flat) flatSimple.set(p, { mode: entry.mode, oid: entry.oid });
    if (blobOid === null) flatSimple.delete(path);
    else flatSimple.set(path, { mode: '100644', oid: blobOid });
    const newTree = gs.buildTreeFromFlat(repo.store, flatSimple);
    const ident = this.ident();
    const commitData = gs.buildCommit({
      tree: newTree,
      parents: tip ? [tip] : [],
      author: ident,
      committer: ident,
      message,
    });
    const sha = repo.store.put('commit', commitData);
    const hadRefs = repo.refs.size > 0;
    repo.refs.set(ref, sha);
    if (!hadRefs && branch !== repo.defaultBranch) repo.defaultBranch = branch;
    return sha;
  }

  // ------------------------------------------------------------- issues

  createIssue(repo: RepoRec, input: { title: string; body?: string; labels?: string[] }): IssueRec {
    const issue: IssueRec = {
      id: this.nextIssueId,
      number: repo.nextNumber,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labels: [...(input.labels ?? [])],
      comments: [],
      seq: this.seq++,
    };
    this.nextIssueId += 1;
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  addComment(repo: RepoRec, issue: IssueRec, body: string): CommentRec {
    const comment: CommentRec = { id: this.nextCommentId, body };
    this.nextCommentId += 1;
    issue.comments.push(comment);
    return comment;
  }

  // ------------------------------------------------------------- pulls

  createPull(repo: RepoRec, input: { title: string; body?: string; head: string; base: string }): PullRec {
    const pull: PullRec = {
      id: this.nextPullId,
      number: repo.nextNumber,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      head: input.head,
      base: input.base,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      seq: this.seq++,
    };
    this.nextPullId += 1;
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  /** The changed files of a pull request, diffed from its merge base. */
  pullFiles(repo: RepoRec, pull: PullRec): gs.FileChange[] {
    const baseTip = this.branchTip(repo, pull.base);
    const headTip = this.branchTip(repo, pull.head);
    if (!baseTip || !headTip) return [];
    const mb = gs.mergeBase(repo.store.get.bind(repo.store), baseTip, headTip);
    const fromTree = mb ? this.commitTree(repo, mb) : undefined;
    const toTree = this.commitTree(repo, headTip);
    return gs.diffTrees(repo.store.get.bind(repo.store), fromTree, toTree);
  }

  /** Whether a pull request merges cleanly onto its base's current tip. */
  pullMergeable(repo: RepoRec, pull: PullRec): boolean {
    if (pull.state !== 'open') return false;
    const outcome = this.tryMerge(repo, pull, false);
    return outcome.ok;
  }

  /**
   * Merge a pull request into its base branch. With method 'merge' the merge
   * commit has two parents; otherwise it is a squash (one parent, the head's
   * tree changes applied). Returns the merge commit id, or undefined when
   * the merge conflicts or is otherwise impossible.
   */
  tryMerge(repo: RepoRec, pull: PullRec, commitIt: boolean, method: 'merge' | 'squash' | 'rebase' = 'squash'): { ok: boolean; sha?: string } {
    const lookup = repo.store.get.bind(repo.store);
    const baseTip = this.branchTip(repo, pull.base);
    const headTip = this.branchTip(repo, pull.head);
    if (!baseTip || !headTip) return { ok: false };
    const mb = gs.mergeBase(lookup, baseTip, headTip);
    if (!mb || mb === headTip) return { ok: false };
    const baseTree = this.commitTree(repo, baseTip);
    const mbTree = this.commitTree(repo, mb);
    const headTree = this.commitTree(repo, headTip);
    if (!baseTree || !mbTree || !headTree) return { ok: false };
    const outcome = gs.mergeTrees(lookup, baseTree, mbTree, headTree);
    if (!outcome.ok || !outcome.flat) return { ok: false };
    if (!commitIt) return { ok: true };
    const newTree = gs.buildTreeFromFlat(repo.store, outcome.flat);
    const ident = this.ident();
    const isMerge = method === 'merge';
    const commitData = gs.buildCommit({
      tree: newTree,
      parents: isMerge ? [baseTip, headTip] : [baseTip],
      author: ident,
      committer: ident,
      message: isMerge ? `Merge pull request #${pull.number}` : `${pull.title} (#${pull.number})`,
    });
    const sha = repo.store.put('commit', commitData);
    repo.refs.set(`refs/heads/${pull.base}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = new Date().toISOString();
    pull.mergeCommitSha = sha;
    return { ok: true, sha };
  }
}

// ---------------------------------------------------------------------------
// serializers (the REST view of the domain objects)

export function repoJson(state: ForgeState, repo: RepoRec): Record<string, unknown> {
  const owner = state.ownerOf(repo);
  return {
    id: repo.dbId,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner, id: 1000 },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
  };
}

export function issueJson(state: ForgeState, repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed' };
    }),
    user: { login: state.ownerOf(repo) },
    comments: issue.comments.length,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
  };
}

export function pullJson(state: ForgeState, repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const owner = state.ownerOf(repo);
  const headSha = state.branchTip(repo, pull.head) ?? gs.ZERO_OID;
  const baseSha = state.branchTip(repo, pull.base) ?? gs.ZERO_OID;
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.head, sha: headSha, label: `${owner}:${pull.head}` },
    base: { ref: pull.base, sha: baseSha, label: `${owner}:${pull.base}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: owner },
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
  };
}
