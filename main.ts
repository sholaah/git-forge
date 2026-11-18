// git-forge entrypoint: the small process the trial harness drives.
//
// The harness hands this process a single environment variable and expects
// one conversation in return: announce the port the server bound, then stay
// alive until the environment reports the trial finished. The contest
// surface itself lives in app.ts and the modules behind it; nothing in this
// file answers a client.
//
// The conversation, step by step:
//   - Without MAKEFUN_ENV_URL there is no environment to announce to, so
//     the process says so on stderr and stops with status 1.
//   - The server binds port 0 and the kernel picks a free one. The
//     environment owns 8080, so a fixed port is never requested.
//   - POST /register carries the bound port. The first announcement wins;
//     a 409 only means another process announced first, and it counts as
//     accepted exactly like a 200. A refusal that signals a broken request
//     (400 or 405) stops the process; anything else is retried, because the
//     environment may still be starting.
//   - GET /done is polled until it answers {"done": true}. It answers at
//     once either way, so polling with a short backoff is the whole wait,
//     and a failed poll is never fatal.
//   - Once done is true the server stops and the process exits 0.

import { createApp } from "./app.ts";

const ENV_ORIGIN = (process.env.MAKEFUN_ENV_URL ?? "").replace(/\/+$/, "");
const CALL_BUDGET_MS = 30_000;
const BACKOFF_FIRST_MS = 250;
const BACKOFF_CEILING_MS = 2_000;

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

const backoffFor = (tries: number): number => Math.min(BACKOFF_CEILING_MS, BACKOFF_FIRST_MS * 2 ** Math.min(tries, 8));

const fail = (message: string): never => {
  process.stderr.write(`[forge-entry] ${message}\n`);
  return process.exit(1); };

const announce = async (port: number, tries: number): Promise<void> => {
  const res = await fetch(`${ENV_ORIGIN}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ port }), signal: AbortSignal.timeout(CALL_BUDGET_MS) }).catch(() => null);
  if (res !== null && (res.status === 200 || res.status === 409)) return;
  if (res !== null && (res.status === 400 || res.status === 405)) fail(`register refused with HTTP ${res.status}`);
  await pause(backoffFor(tries));
  return announce(port, tries + 1); };

const awaitFinished = async (tries: number): Promise<void> => {
  const res = await fetch(`${ENV_ORIGIN}/done`, { signal: AbortSignal.timeout(CALL_BUDGET_MS) }).catch(() => null);
  const body = res !== null && res.ok ? ((await res.json().catch(() => null)) as { done?: unknown } | null) : null;
  if (body?.done === true) return;
  await pause(backoffFor(tries));
  return awaitFinished(tries + 1); };

const run = async (): Promise<void> => {
  if (!ENV_ORIGIN) fail("MAKEFUN_ENV_URL is missing: no environment to announce to");
  const app = createApp();
  await new Promise<void>((resolve, reject) => { app.once("error", reject); app.listen(0, () => resolve()); });
  const bound = app.address();
  if (bound === null || typeof bound === "string") fail("the server did not bind a TCP port");
  process.stdout.write(`[forge-entry] bound port ${bound.port}\n`);
  await announce(bound.port, 0);
  process.stdout.write("[forge-entry] announced; waiting for the environment to finish\n");
  await awaitFinished(0); app.close();
  process.stdout.write("[forge-entry] finished\n"); };

const report = (err: unknown): void => {
  process.stderr.write(`[forge-entry] ${err instanceof Error ? err.message : String(err)}\n`); process.exit(1); };

run().then(() => process.exit(0), report);
