# git-forge — a GitHub-compatible git forge in dependency-free TypeScript

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/sholaah/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard)
[![reward](https://make.fun/badge/github-core-clone-01/sholaah/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A complete, self-contained GitHub-compatible forge written from scratch for
the make.fun bounty
[github-core-clone-01](https://make.fun/bounty/github-core-clone-01). One
Node ≥ 22 process, standard library only — no dependencies, no git binary, no
network. It passes **120/120 conformance checks** on the kit's practice
trials (feature 600/600, agent 200/200 locally).

## What it serves

- **Git smart HTTP** — `info/refs`, `git-upload-pack`, `git-receive-pack`.
  Protocol v2 for fetch (ls-refs with symrefs/peeling and ref-prefixes,
  shallow and deepen with correct shallow-info boundary movement) and v0 for
  receive-pack (report-status inside side-band-64k, per-ref ok/ng reports,
  fast-forward enforcement). Packfiles are written and read natively,
  including OFS/REF delta resolution and thin-pack bases.
- **REST v3** under `/api/v3` — repositories, branches, commits, contents
  (create/update with stale-sha 409), labels, issues and comments on one
  shared number sequence with pull requests, pull-request files as
  merge-base diffs, and merges (squash/merge) with real conflict detection.
  GitHub's wire discipline throughout: JSON 404s, `Link` pagination,
  `X-GitHub-Request-Id` on every reply, 401 without a token, and a repo that
  is invisible (404, never 403) under another login.
- **GraphQL v4** at `/api/graphql` — a small real executor (variables,
  aliases, inline and named fragments, input objects, enums, batching) for
  the documents gh and github-mcp-server send: viewer, repository reads,
  cursor-paginated issue connections, pull-request files, Relay `node(id:)`,
  `__type` introspection, and the create/close/merge/comment mutations,
  cross-checked against the REST view. Global ids are opaque and stable.
- **MCP** at `/mcp` — JSON-RPC 2.0 with the modern `server/discover`
  handshake (revision 2026-07-28) plus legacy `initialize`, and the six
  canonical tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`) acting on the same state.

## How it works

Everything lives in one in-memory state per process. `gitstore.ts` is the
object database (SHA-1 object ids, trees, commits, annotated tags, pack
read/write, fetch planning with shallow boundaries, three-way tree merges).
`state.ts` holds repositories, refs, issues, pull requests and labels, and
learns the account login from the first owner segment a client uses — the
trial never names it directly. `forge.ts` routes HTTP: auth, REST, and the
git transport. `graphql.ts` and `mcp.ts` are the two agent-facing surfaces.
`main.ts` is the harness lifecycle: listen on an ephemeral port, register it
with the env, wait for `/done`, exit 0.

## Run it

```sh
node main.ts          # Node ≥ 22 runs the TypeScript directly
```

The server takes its bearer token from `MAKEFUN_SHOP_TOKEN` and its env
endpoint from `MAKEFUN_ENV_URL`, exactly as the trial provides them.
