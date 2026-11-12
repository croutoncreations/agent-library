// The real Worker (createWorker's fetch, packages/core/src/ bundled by load-worker.mjs) in process, over node:sqlite
// with every migration (test/blind-tokens-world.mjs) and an in-memory R2 double, for the blind-token publishing-path
// tests: requests go through the real HTTP routes, `ctx.waitUntil` is recorded, and the token tables are read after.
// No listener. Synthetic data only; every INSERT names its columns.
import { createHash, createHmac } from "node:crypto";
import { loadWorker } from "./load-worker.mjs";
import * as W from "./blind-tokens-world.mjs";
// workerd's FixedLengthStream and crypto.DigestStream, as the upload tests define them (Node stand-ins).
import { d1BindArray } from "./upload-world.mjs";

export const lib = await loadWorker({
  "search/tokens.js": ["searchAdmissionState", "drainSearchIndexing", "searchFlatHeld", "withDeferredWork", "discardDeferredWork", "deferSearchIndexing", "skipSearchJobs"],
  "backup.js": ["prepareBackupJobs"],
  "service.js": ["publishRevision", "deferIndexing"],
});

const PASS = "synthetic-local-pass";

/** An in-memory R2 that stores whole objects (what text publication and getText need). */
function blobStore() {
  const blobs = new Map();
  const bytesOf = async (b) => b instanceof Uint8Array ? b : b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(await new Response(b).arrayBuffer());
  return {
    blobs,
    async put(k, b) {
      const bytes = await bytesOf(b);
      blobs.set(k, bytes);
      const d = createHash("sha256").update(bytes).digest();
      return { size: bytes.length, checksums: { sha256: d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) } };
    },
    async get(k, opts) {
      const whole = blobs.get(k);
      if (!whole) return null;
      const b = opts?.range ? whole.subarray(opts.range.offset, opts.range.offset + opts.range.length) : whole;
      return { size: whole.length, customMetadata: {}, httpMetadata: {}, body: new Blob([b]).stream(), async arrayBuffer() { return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } };
    },
    async head(k) {
      const b = blobs.get(k);
      if (!b) return null;
      const d = createHash("sha256").update(b).digest();
      return { size: b.length, customMetadata: {}, checksums: { sha256: d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) } };
    },
    async delete(k) { for (const x of [k].flat()) blobs.delete(x); },
    async list({ prefix = "", limit = 1000 } = {}) { return { objects: [...blobs.keys()].filter((k) => k.startsWith(prefix)).slice(0, limit).map((key) => ({ key })) }; },
  };
}

/**
 * A world: the database, R2, the Worker env and a fetch that records each request's waitUntil promises.
 * `vars` are Worker vars (strings). `waitUntil`: replace the recorder (tests of a throwing or missing waitUntil).
 */
export async function app(vars = {}) {
  const world = W.mkWorld();
  const BLOBS = blobStore();
  // D1's bind conversion (slice 3b's d1BindArray: a byte list binds as a BLOB, as D1 does; node:sqlite cannot bind arrays).
  const prepare = world.DB.prepare;
  world.DB.prepare = (q) => { const st = prepare(q); const bind = st.bind; return { ...st, bind: (...p) => bind(...p.map(d1BindArray)) }; };
  const env = { DB: world.DB, BLOBS, LOCAL_DEV_LOGIN: PASS, RATE_READS_PER_MIN: "100000", RATE_WRITES_PER_MIN: "100000", RATE_AUTHFAIL_PER_MIN: "100000", ...vars };
  const waits = [];
  let waitUntil = (p) => { waits.push(p); };
  const fetch = (path, init = {}, ctxOverride) => lib.default.fetch(new Request(/^https?:/.test(path) ? path : "http://127.0.0.1" + path, init), env, ctxOverride ?? { waitUntil: (p) => waitUntil(p) });
  const login = await fetch("/auth/dev-login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase: PASS }) });
  if (login.status !== 200) throw new Error("dev-login " + login.status);
  const { csrf } = await login.json();
  const cookie = login.headers.get("set-cookie").split(";")[0];
  let n = 0;
  /** A signed-in request: JSON in and out, with a fresh idempotency key unless `idem` is given. Returns the Response too. */
  const req = async (method, path, body, { idem, ctx } = {}) => {
    const headers = { cookie, "x-csrf-token": csrf };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (["POST", "PUT", "PATCH"].includes(method)) headers["idempotency-key"] = idem ?? `key-synthetic-${++n}-${Date.now()}`;
    const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, ctx);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, res };
  };
  const project = async (id) => {
    const r = await req("POST", "/api/projects", { id, title: "Synthetic" });
    if (r.status !== 201) throw new Error("project " + r.status + JSON.stringify(r.body));
    return r.body;
  };
  /** Wait for every deferred run recorded so far (the request's waitUntil promises, then any still running). */
  const settle = async () => { await Promise.all(waits.splice(0)); await lib.drainSearchIndexing(); };
  return {
    world, env, BLOBS, waits, fetch, req, project, settle, cookie, csrf,
    setWaitUntil: (fn) => { waitUntil = fn; },
  };
}

/** The tokens the index should hold for `text` in a plaintext-mode workspace (its secret from workspace_search_keys). */
export function expectedFor(world, workspaceId, terms) {
  const row = W.one(world, "SELECT secret FROM workspace_search_keys WHERE workspace_id = ?", workspaceId);
  if (!row) return null;
  const secret = Buffer.from(row.secret, "base64url");
  return [...new Set(terms)].map((t) => createHmac("sha256", secret).update(t).digest().subarray(0, 16).toString("hex")).sort();
}

/** Poll `fn` until it returns a truthy value or the deadline passes (deferred work; never a fixed sleep). */
export async function until(fn, { ms = 5000, what = "condition" } = {}) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Capture JSON log lines while fn runs. */
export async function captureLogs(fn) {
  const out = [], { log, error } = console;
  const grab = (...a) => { try { out.push(JSON.parse(a[0])); } catch { /* not JSON */ } };
  console.log = grab; console.error = grab;
  try { return { result: await fn(), events: out }; } finally { console.log = log; console.error = error; }
}

export { W };
