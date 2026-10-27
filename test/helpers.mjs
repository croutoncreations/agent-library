// Shared harness: isolated wrangler dev server per test file, human (cookie+csrf) and agent (bearer) clients, real MCP client.
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, rmSync, openSync, closeSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { createServer as createNetServer } from "node:net";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SERVER_PORTS, INSPECTOR_OFFSET } from "./ports.mjs";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Local-only wrangler config (placeholder IDs); never an installation's wrangler.toml. */
export const LOCAL_CONFIG = join(ROOT, "wrangler.local.toml");
// Browser tests save screenshots here; a fresh checkout has no tmp/.
mkdirSync(join(ROOT, "tmp", "test-evidence"), { recursive: true });
export const sha256 = (b) => createHash("sha256").update(b).digest("hex");
export const key = (p = "k") => `${p}-${randomBytes(8).toString("hex")}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Start an isolated local server. A random per-server LOCAL_DEV_LOGIN passphrase is injected with --var
 * (synthetic test value, never printed); wrangler output goes to tmp/test-state-<name>.log only.
 */
// Functional suites drive many requests per minute through one identity; raise rate limits there.
// test/limits.test.mjs passes low explicit values to exercise the limiter itself.
const FUNCTIONAL_VARS = { RATE_READS_PER_MIN: "100000", RATE_WRITES_PER_MIN: "100000", RATE_AUTHFAIL_PER_MIN: "100000" };
export async function startServer(name, port, { fresh = true, persistDir, vars = FUNCTIONAL_VARS, readyHeaders = {}, readyBase } = {}) {
  if (!Object.values(SERVER_PORTS).includes(port)) throw new Error(`port ${port} is not in test/ports.mjs SERVER_PORTS`);
  for (const p of [port, port + INSPECTOR_OFFSET]) if (!(await portFree(p))) throw new Error(`port ${p} for server ${name} is already in use (a previous server did not exit?)`);
  const dir = persistDir ?? join(ROOT, "tmp", `test-state-${name}`);
  if (fresh) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const env = { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" };
  const logPath = join(ROOT, "tmp", `test-state-${name}.log`);
  const fd = openSync(logPath, "a");
  execFileSync("wrangler", ["d1", "--config", LOCAL_CONFIG, "migrations", "apply", "DB", "--local", "--persist-to", dir], { cwd: ROOT, env, stdio: ["ignore", fd, fd] });
  const passphrase = "test-" + randomBytes(18).toString("hex");
  const child = spawn("wrangler", ["dev", "--config", LOCAL_CONFIG, "--local", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", dir,
    "--var", `LOCAL_DEV_LOGIN:${passphrase}`, ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`]),
    "--show-interactive-dev-session=false", "--inspector-port", String(port + INSPECTOR_OFFSET)],
    { cwd: ROOT, env, stdio: ["ignore", fd, fd], detached: true });
  closeSync(fd);
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`wrangler exited early; see ${logPath}`);
    try { const r = await fetch((readyBase ?? base) + "/api/me", { headers: readyHeaders }); if (r.status === 401) break; } catch {}
    if (Date.now() > deadline) { stopProc(child); throw new Error(`server ${name} not ready; see ${logPath}`); }
    await sleep(300);
  }
  return {
    base, dir, port,
    login: () => humanLogin(base, passphrase),
    loginAt: (b) => humanLogin(b, passphrase),
    passphrase: () => passphrase, // for real-browser login forms in tests only
    stop: async () => { stopProc(child); await waitExit(child); await waitPortsFree([port, port + INSPECTOR_OFFSET]); },
  };
}

/** True if nothing is listening on 127.0.0.1:port (we can bind it ourselves). */
function portFree(port) {
  return new Promise((resolve) => {
    const srv = createNetServer().once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}
// workerd is a grandchild and can outlive wrangler by a moment; the next start (same file or the next one) must not race it.
async function waitPortsFree(ports) {
  for (const p of ports) {
    for (let i = 0; i < 50 && !(await portFree(p)); i++) await sleep(100);
  }
}

function stopProc(child) {
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
}
async function waitExit(child) {
  for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++) await sleep(100);
  try { process.kill(-child.pid, "SIGKILL"); } catch {}
  await sleep(300);
}

async function parse(r) {
  const t = await r.text();
  try { return t ? JSON.parse(t) : null; } catch { return t; }
}

/** Human cookie session. req() adds cookie + csrf for non-GET unless opts.noCsrf. */
export async function humanLogin(base, passphrase) {
  const r = await fetch(base + "/auth/dev-login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase }) });
  if (r.status !== 200) throw new Error("dev-login failed " + r.status);
  const { csrf } = await r.json();
  const cookie = r.headers.get("set-cookie").split(";")[0];
  const req = async (method, path, body, opts = {}) => {
    const headers = { cookie, ...(opts.headers ?? {}) };
    if (method !== "GET" && method !== "HEAD" && !opts.noCsrf) headers["x-csrf-token"] = csrf;
    let payload;
    if (opts.raw !== undefined) payload = opts.raw;
    else if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
    if (opts.idem !== false && ["POST", "PUT", "PATCH"].includes(method)) headers["idempotency-key"] ??= opts.idem ?? key("h");
    const res = await fetch(base + path, { method, headers, body: payload });
    const buf = opts.binary ? Buffer.from(await res.arrayBuffer()) : null;
    return { status: res.status, headers: res.headers, body: buf ?? (await parse(res)) };
  };
  return { req, cookie, csrf };
}

/** Bearer agent HTTP client. */
export function agentHttp(base, token) {
  return async (method, path, body, opts = {}) => {
    const headers = { authorization: `Bearer ${token}`, ...(opts.headers ?? {}) };
    let payload;
    if (opts.raw !== undefined) payload = opts.raw;
    else if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
    if (opts.idem !== false && ["POST", "PUT", "PATCH"].includes(method) && !path.startsWith("/api/transfers/")) headers["idempotency-key"] ??= opts.idem ?? key("a");
    const res = await fetch(base + path, { method, headers, body: payload });
    const buf = opts.binary ? Buffer.from(await res.arrayBuffer()) : null;
    return { status: res.status, headers: res.headers, body: buf ?? (await parse(res)) };
  };
}

/** Real MCP client via the official SDK Streamable HTTP transport with a bearer header. */
export async function mcpClient(base, token, name = "test-agent") {
  const transport = new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  const call = async (tool, args) => {
    const r = await client.callTool({ name: tool, arguments: args });
    return { isError: !!r.isError, data: r.structuredContent };
  };
  return { client, call, close: () => client.close() };
}

export async function setupProject(h, id, title = id) {
  const r = await h.req("POST", "/api/projects", { id, title });
  if (r.status !== 201) throw new Error("create project " + r.status + JSON.stringify(r.body));
  return id;
}
export async function grant(h, pid, label, can_write = true) {
  const r = await h.req("POST", `/api/projects/${pid}/grants`, { label, can_write });
  if (r.status !== 201) throw new Error("grant " + r.status);
  return r.body; // {grant_id, token, ...} — token never logged
}

/** Release all functions at the same instant (barrier), return their settled results in order. */
export async function barrier(fns) {
  let release;
  const gate = new Promise((r) => (release = r));
  const ps = fns.map((fn) => gate.then(fn));
  release();
  return Promise.all(ps);
}
