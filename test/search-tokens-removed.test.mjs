// The search-token writer (slice 4a) is gone: search stays the plaintext full-text index. Saves, version saves and
// template copies through the real HTTP routes (createWorker's fetch, packages/core/src/ bundled by load-worker.mjs,
// in process over node:sqlite with every migration: test/blind-tokens-world.mjs) write no row to the token tables,
// and the full-text search still finds the document. No listener. Synthetic data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { loadWorker } from "./load-worker.mjs";
import { ROOT } from "./helpers.mjs";
import * as W from "./blind-tokens-world.mjs";

const lib = await loadWorker();
const PASS = "synthetic-local-pass";
const TOKEN_TABLES = ["search_token_docs", "search_tokens", "search_term_counters", "workspace_search_keys"];

/** An in-memory R2 holding whole objects (what text publication and reads need). */
function blobStore() {
  const blobs = new Map();
  const bytesOf = async (b) => b instanceof Uint8Array ? b : b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(await new Response(b).arrayBuffer());
  const sha = (bytes) => { const d = createHash("sha256").update(bytes).digest(); return d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength); };
  return {
    async put(k, b) { const bytes = await bytesOf(b); blobs.set(k, bytes); return { size: bytes.length, checksums: { sha256: sha(bytes) } }; },
    async get(k, opts) {
      const whole = blobs.get(k);
      if (!whole) return null;
      const b = opts?.range ? whole.subarray(opts.range.offset, opts.range.offset + opts.range.length) : whole;
      return { size: whole.length, customMetadata: {}, httpMetadata: {}, body: new Blob([b]).stream(), async arrayBuffer() { return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } };
    },
    async head(k) { const b = blobs.get(k); return b ? { size: b.length, customMetadata: {}, checksums: { sha256: sha(b) } } : null; },
    async delete(k) { for (const x of [k].flat()) blobs.delete(x); },
    async list({ prefix = "", limit = 1000 } = {}) { return { objects: [...blobs.keys()].filter((k) => k.startsWith(prefix)).slice(0, limit).map((key) => ({ key })) }; },
  };
}

/** The Worker over a fresh World, signed in through dev-login; every request's waitUntil promises are recorded. */
async function app() {
  const world = W.mkWorld();
  const env = { DB: world.DB, BLOBS: blobStore(), LOCAL_DEV_LOGIN: PASS, RATE_READS_PER_MIN: "100000", RATE_WRITES_PER_MIN: "100000", RATE_AUTHFAIL_PER_MIN: "100000" };
  const waits = [];
  const fetch = (path, init = {}) => lib.default.fetch(new Request("http://127.0.0.1" + path, init), env, { waitUntil: (p) => { waits.push(p); } });
  const login = await fetch("/auth/dev-login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase: PASS }) });
  assert.equal(login.status, 200, "dev-login");
  const { csrf } = await login.json();
  const cookie = login.headers.get("set-cookie").split(";")[0];
  let n = 0;
  const req = async (method, path, body) => {
    const headers = { cookie, "x-csrf-token": csrf };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (method !== "GET") headers["idempotency-key"] = `key-synthetic-removed-${++n}`;
    const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  // Everything a request handed to waitUntil has finished (so deferred work, if any existed, has run).
  const settle = async () => { while (waits.length) await Promise.allSettled(waits.splice(0)); };
  return { world, req, settle };
}
const rowCounts = (world) => Object.fromEntries(TOKEN_TABLES.map((t) => [t, W.one(world, `SELECT COUNT(*) AS n FROM ${t}`).n]));
const zero = Object.fromEntries(TOKEN_TABLES.map((t) => [t, 0]));

test("create, save a new version and create from a template write no search-token rows; full-text search still finds them", async () => {
  const a = await app();
  const p = await a.req("POST", "/api/projects", { id: "p-removed", title: "Synthetic" });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  const md = await a.req("POST", "/api/projects/p-removed/artifacts", { title: "Synthetic note", body: "alpha quokkafirst beta" });
  assert.equal(md.status, 201, JSON.stringify(md.body));
  const id = md.body.artifact_id;
  await a.settle();
  assert.deepEqual(rowCounts(a.world), zero, "after create");
  const s = await a.req("PUT", `/api/projects/p-removed/artifacts/${id}`, { expected_revision: 1, body: "gamma wombatsecond delta" });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  await a.settle();
  assert.deepEqual(rowCounts(a.world), zero, "after a version save");
  const def = await a.req("POST", "/api/projects/p-removed/templates", { source_artifact_id: id, source_revision: 2, title: "Synthetic template" });
  assert.equal(def.status, 201, JSON.stringify(def.body));
  const use = await a.req("POST", "/api/projects/p-removed/artifacts/from-template", { template_id: def.body.artifact_id, template_revision: 1, title: "Synthetic copy" });
  assert.equal(use.status, 201, JSON.stringify(use.body));
  await a.settle();
  assert.deepEqual(rowCounts(a.world), zero, "after a template is made and used");
  // The plaintext full-text index has the new version's words (and no longer the old version's).
  const found = await a.req("GET", `/api/search?query=${encodeURIComponent("wombatsecond")}`);
  assert.equal(found.status, 200, JSON.stringify(found.body));
  const titles = (found.body?.results ?? []).map((r) => r.title).sort();
  assert.ok(titles.includes("Synthetic note"), JSON.stringify(found.body));
  assert.ok(titles.includes("Synthetic copy"), JSON.stringify(found.body));
  const old = await a.req("GET", `/api/search?query=${encodeURIComponent("quokkafirst")}`);
  assert.equal(old.status, 200, JSON.stringify(old.body));
  assert.deepEqual(old.body?.results ?? [], [], "the replaced version is not found");
});

/** Every .js/.mjs file under dir. */
function jsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== "node_modules") out.push(...jsFiles(p)); }
    else if (/\.(m?js|txt)$/.test(name)) out.push(p);
  }
  return out;
}

test("no source under packages/ names the search-token writer", () => {
  const hits = jsFiles(join(ROOT, "packages"))
    .filter((f) => /search\/tokens|search-key|deferSearchIndexing|search_token/.test(readFileSync(f, "utf8")))
    .map((f) => relative(ROOT, f));
  assert.deepEqual(hits, []);
});

test("migrations/0032_blind_search.sql is kept unchanged", () => {
  // Kept because it is applied on existing databases (the deploy check refuses a release that lacks an applied
  // migration); its tables and view are unused. SHA-256 of the file as slice 4a shipped it (5ad9f2d).
  const sql = readFileSync(join(ROOT, "migrations", "0032_blind_search.sql"));
  assert.equal(createHash("sha256").update(sql).digest("hex"), "d065b1abe9622994755be96e2d8c15d9c51df58650605ee8fa0b633a115139a3");
});
