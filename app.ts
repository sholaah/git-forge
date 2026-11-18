// app.ts — the server factory. main.ts owns the entry <-> env lifecycle
// (register, wait for /done, exit); this file owns the HTTP surface itself by
// delegating every request to the forge: git smart HTTP (v0 and v2, shallow
// fetches, receive-pack), the REST v3 resources, the GraphQL v4 executor and
// the MCP endpoint, all over one shared in-memory state.

import { createServer, type Server } from 'node:http';
import { createForge } from './forge.ts';

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const forge = createForge();
  return createServer((req, res) => {
    void forge.handle(req, res);
  });
}
