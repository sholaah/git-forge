// mcp.ts — the Model Context Protocol endpoint: JSON-RPC 2.0 over POST /mcp,
// speaking both the modern discovery handshake (server/discover, revision
// 2026-07-28) and the legacy initialize flow, exposing the forge's six core
// tools under their canonical github-mcp-server names. Tool calls operate on
// the same state as the REST, GraphQL and git surfaces, so an object created
// over MCP reads back identically over REST.

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ForgeState, issueJson, pullJson, repoJson } from './state.ts';

const PROTOCOL_VERSION = '2026-07-28';
const SERVER_INFO = { name: 'forge-mcp', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

/** The tool catalogue. Constant: tools/list must be byte-identical across calls. */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated account.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository to create.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get the details of a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create a new issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body text of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        head: { type: 'string', description: 'The head branch to merge from.' },
        base: { type: 'string', description: 'The base branch to merge into.' },
        body: { type: 'string', description: 'The body text of the pull request.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'number', description: 'The number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

type JsonRpcId = string | number | null;

interface ToolOutcome {
  isError: boolean;
  payload: unknown;
}

function callTool(state: ForgeState, name: string, rawArgs: unknown): ToolOutcome | null {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return null;
  const args = (typeof rawArgs === 'object' && rawArgs !== null ? rawArgs : {}) as Record<string, unknown>;
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return { isError: true, payload: { message: `missing required argument: ${required}` } };
    }
  }
  const str = (key: string): string => String(args[key] ?? '');
  const findRepo = (): ReturnType<ForgeState['repoFor']> => state.repoFor(str('owner'), str('repo'));
  switch (name) {
    case 'create_repo': {
      const repo = state.createRepo({
        name: str('name'),
        description: typeof args.description === 'string' ? args.description : undefined,
        isPrivate: args.private === true,
      });
      if (!repo) return { isError: true, payload: { message: 'Repository already exists' } };
      return { isError: false, payload: repoJson(state, repo) };
    }
    case 'get_repo': {
      const repo = findRepo();
      if (!repo) return { isError: true, payload: { message: 'Not Found' } };
      return { isError: false, payload: repoJson(state, repo) };
    }
    case 'create_issue': {
      const repo = findRepo();
      if (!repo) return { isError: true, payload: { message: 'Not Found' } };
      const issue = state.createIssue(repo, {
        title: str('title'),
        body: typeof args.body === 'string' ? args.body : '',
      });
      return { isError: false, payload: issueJson(state, repo, issue) };
    }
    case 'list_issues': {
      const repo = findRepo();
      if (!repo) return { isError: true, payload: { message: 'Not Found' } };
      const wanted = typeof args.state === 'string' ? args.state : 'open';
      const issues = [...repo.issues.values()]
        .filter((issue) => wanted === 'all' || issue.state === wanted)
        .sort((a, b) => a.seq - b.seq)
        .map((issue) => issueJson(state, repo, issue));
      return { isError: false, payload: issues };
    }
    case 'create_pull_request': {
      const repo = findRepo();
      if (!repo) return { isError: true, payload: { message: 'Not Found' } };
      if (!state.branchTip(repo, str('head'))) return { isError: true, payload: { message: `head branch ${str('head')} does not exist` } };
      if (!state.branchTip(repo, str('base'))) return { isError: true, payload: { message: `base branch ${str('base')} does not exist` } };
      const existing = [...repo.pulls.values()].find(
        (pull) => pull.state === 'open' && pull.head === str('head') && pull.base === str('base'),
      );
      if (existing) return { isError: true, payload: { message: 'A pull request already exists for this head and base' } };
      const pull = state.createPull(repo, {
        title: str('title'),
        body: typeof args.body === 'string' ? args.body : '',
        head: str('head'),
        base: str('base'),
      });
      return { isError: false, payload: pullJson(state, repo, pull) };
    }
    case 'merge_pull_request': {
      const repo = findRepo();
      if (!repo) return { isError: true, payload: { message: 'Not Found' } };
      const pull = repo.pulls.get(Number(args.pull_number));
      if (!pull) return { isError: true, payload: { message: 'Not Found' } };
      const outcome = state.tryMerge(repo, pull, true, 'squash');
      if (!outcome.ok) return { isError: true, payload: { message: 'Pull Request is not mergeable' } };
      return { isError: false, payload: pullJson(state, repo, pull) };
    }
    default:
      return null;
  }
}

function resultResponse(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function errorResponse(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function handleOne(state: ForgeState, request: unknown): Record<string, unknown> | null {
  if (typeof request !== 'object' || request === null) return errorResponse(null, -32600, 'Invalid Request');
  const record = request as Record<string, unknown>;
  const id = (typeof record.id === 'string' || typeof record.id === 'number' ? record.id : null) as JsonRpcId;
  const isNotification = record.id === undefined;
  const method = typeof record.method === 'string' ? record.method : '';
  const params = (typeof record.params === 'object' && record.params !== null ? record.params : {}) as Record<string, unknown>;

  if (method === 'server/discover' || method === 'discover') {
    return resultResponse(id, {
      supportedVersions: [PROTOCOL_VERSION],
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      _meta: { serverInfo: SERVER_INFO },
    });
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
    return resultResponse(id, {
      protocolVersion: requested,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === 'ping') return resultResponse(id, {});
  if (method.startsWith('notifications/')) return null;
  if (isNotification) return null;
  if (method === 'tools/list') {
    return resultResponse(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const outcome = callTool(state, name, params.arguments);
    if (outcome === null) return errorResponse(id, -32602, `unknown tool: ${name}`);
    const text = JSON.stringify(outcome.payload);
    return resultResponse(id, {
      content: [{ type: 'text', text }],
      structuredContent: outcome.payload,
      isError: outcome.isError,
    });
  }
  return errorResponse(id, -32601, `method not found: ${method}`);
}

export async function handleMCP(
  state: ForgeState,
  req: IncomingMessage,
  res: ServerResponse,
  authorized: boolean,
  readBody: (req: IncomingMessage) => Promise<Buffer>,
): Promise<void> {
  const send = (status: number, body: unknown): void => {
    const text = typeof body === 'string' ? body : `${JSON.stringify(body)}\n`;
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'x-github-request-id': randomUUID(),
    });
    res.end(text);
  };
  // Auth is checked before any method dispatch, for every /mcp request.
  if (!authorized) {
    send(401, { message: 'Unauthorized' });
    return;
  }
  if ((req.method ?? 'GET') !== 'POST') {
    send(405, { message: 'Method Not Allowed' });
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    send(400, errorResponse(null, -32700, 'Parse error'));
    return;
  }
  if (Array.isArray(parsed)) {
    const responses = parsed.map((entry) => handleOne(state, entry)).filter((entry) => entry !== null);
    if (responses.length === 0) {
      send(202, '');
      return;
    }
    send(200, responses);
    return;
  }
  const response = handleOne(state, parsed);
  if (response === null) {
    send(202, '');
    return;
  }
  send(200, response);
}
