// A fresh install with every migration applied (including 0017_review_gating.sql, whose schema is present but unused
// until review gating is ported) can create, edit (owner and agent) and upload (owner text, agent binary), and the review
// tables stay empty. The real Worker (packages/core/src/ bundled by load-worker.mjs) runs in process over node:sqlite
// (test/sqlite-world.mjs) with an in-memory R2. No listener. Synthetic data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadWorker } from "./load-worker.mjs";
import { PNG } from "./upload-world.mjs"; // also installs the FixedLengthStream stand-in the upload PUT needs
import * as W from "./sqlite-world.mjs";

const lib = await loadWorker({ "cleanup.js": ["reconcileUploads"], "uploads.js": ["uploadBegin", "uploadPut", "uploadFinish"], "adapters.js": ["withAdapters", "defaultAdapters"] });
const PASS = "synthetic-local-pass";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

function blobStore() {
  const blobs = new Map();
  const bytesOf = async (b) => b instanceof Uint8Array ? b : b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(await new Response(b).arrayBuffer());
  const digest = (bytes) => { const d = createHash("sha256").update(bytes).digest(); return d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength); };
  return {
    async put(k, b, opts) {
      const bytes = await bytesOf(b);
      if (opts?.sha256 && sha(bytes) !== (typeof opts.sha256 === "string" ? opts.sha256 : Buffer.from(opts.sha256).toString("hex"))) throw new Error("put: The SHA-256 checksum you specified did not match what we received. (10037)");
      blobs.set(k, bytes);
      return { size: bytes.length, checksums: { sha256: digest(bytes) } };
    },
    async get(k, opts) {
      const whole = blobs.get(k);
      if (!whole) return null;
      const b = opts?.range ? whole.subarray(opts.range.offset, opts.range.offset + opts.range.length) : whole;
      return { size: whole.length, customMetadata: {}, httpMetadata: {}, body: new Blob([b]).stream(), async arrayBuffer() { return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } };
    },
    async head(k) { const b = blobs.get(k); return b ? { size: b.length, customMetadata: {}, checksums: { sha256: digest(b) } } : null; },
    async delete(k) { for (const x of [k].flat()) blobs.delete(x); },
    async list({ prefix = "", limit = 1000 } = {}) { return { objects: [...blobs.keys()].filter((k) => k.startsWith(prefix)).slice(0, limit).map((key) => ({ key })) }; },
  };
}

/** The Worker over a fresh World: the app host is localhost, the agent API (/v1) is on 127.0.0.1. */
async function install() {
  const world = W.mkWorld();
  const env = { DB: world.DB, BLOBS: blobStore(), LOCAL_DEV_LOGIN: PASS, APP_HOST: "localhost", MCP_HOST: "127.0.0.1", RATE_READS_PER_MIN: "100000", RATE_WRITES_PER_MIN: "100000", RATE_AUTHFAIL_PER_MIN: "100000" };
  const fetch = (url, init = {}) => lib.default.fetch(new Request(url, init), env, { waitUntil() {} });
  const login = await fetch("http://localhost/auth/dev-login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase: PASS }) });
  assert.equal(login.status, 200, "dev-login");
  const { csrf } = await login.json();
  const cookie = login.headers.get("set-cookie").split(";")[0];
  let n = 0;
  const call = async (base, headers, method, path, body, raw) => {
    const h = { ...headers };
    if (body !== undefined) h["content-type"] = "application/json";
    if (method !== "GET") h["idempotency-key"] = `key-synthetic-fresh-${++n}`;
    const res = await fetch(base + path, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* a non-JSON body */ }
    return { status: res.status, body: json, text };
  };
  const owner = (method, path, body, raw) => call("http://localhost", { cookie, "x-csrf-token": csrf }, method, path, body, raw);
  const agentWith = (secret) => (method, path, body, raw) => call("http://127.0.0.1", { authorization: `Bearer ${secret}` }, method, path, body, raw);
  return { world, env, owner, agentWith };
}

test("fresh install, every migration: create, edit (owner and agent) and upload (owner text, agent binary) work and no review state appears", async () => {
  const { world, env, owner, agentWith } = await install();

  const p = await owner("POST", "/api/projects", { id: "p-fresh", title: "Synthetic" });
  assert.equal(p.status, 201, p.text);
  const key = await owner("POST", "/api/api-keys", { label: "Synthetic agent", lifetime_days: 1, projects: [{ project_id: "p-fresh", access: "read_write" }] });
  assert.equal(key.status, 201, key.text);
  const agent = agentWith(key.body.secret);

  // Owner: create and edit.
  const md = await owner("POST", "/api/projects/p-fresh/artifacts", { title: "Owner note", body: "first words" });
  assert.equal(md.status, 201, md.text);
  const ownerEdit = await owner("PUT", `/api/projects/p-fresh/artifacts/${md.body.artifact_id}`, { expected_revision: 1, body: "second words" });
  assert.equal(ownerEdit.status, 200, ownerEdit.text);

  // Agent: create, then edit its own file and the owner's.
  const made = await agent("POST", "/v1/projects/p-fresh/files", { title: "Agent note", body: "agent words" });
  assert.equal(made.status, 201, made.text);
  const agentEdit = await agent("PUT", `/v1/projects/p-fresh/files/${made.body.artifact_id}`, { expected_revision: 1, body: "agent words, edited" });
  assert.equal(agentEdit.status, 200, agentEdit.text);
  const agentEditsOwner = await agent("PUT", `/v1/projects/p-fresh/files/${md.body.artifact_id}`, { expected_revision: 2, body: "third words" });
  assert.equal(agentEditsOwner.status, 200, agentEditsOwner.text);

  // Owner: text upload (begin, PUT, finish). The app API takes text only; binary files arrive from agents.
  const text = Buffer.from("uploaded words");
  const up = await owner("POST", "/api/projects/p-fresh/uploads", { title: "Uploaded note", mime: "text/markdown", size: text.length, sha256: sha(text) });
  assert.equal(up.status, 201, up.text);
  assert.equal((await owner("PUT", up.body.put_url, undefined, text)).status, 200);
  const upDone = await owner("POST", `/api/projects/p-fresh/uploads/${up.body.upload_id}/finish`);
  assert.equal(upDone.status, 200, upDone.text);

  // Agent: binary upload (begin, PUT, finish). /v1 uploads text only; binary files reach the same functions through
  // the MCP file tools, so the call carries the context /v1 builds for an API key (api/v1.js projectCtx).
  const cred = W.one(world, "SELECT id, principal_id FROM api_credentials WHERE id = ?", key.body.id);
  const env2 = lib.withAdapters(env, lib.defaultAdapters());
  const actx = { env: env2, requestId: "req_synthetic_fresh", apiCredential: true, principal: { id: cred.principal_id, kind: "agent", label: "api:Synthetic agent" },
    grant: { id: cred.id, project_id: "p-fresh", can_write: 1 }, via: { kind: "api_key", id: cred.id, label: "Synthetic agent" } };
  const begun = await lib.uploadBegin(actx, "p-fresh", { title: "agent.png", mime: "image/png", size: PNG.length, sha256: sha(PNG) }, "key-synthetic-fresh-begin");
  assert.equal(begun.status, 201, JSON.stringify(begun.body));
  const put = await lib.uploadPut(new Request("https://example.test/put", { method: "PUT", body: PNG, headers: { "content-length": String(PNG.length) } }), env2, actx.requestId, begun.body.upload_id, actx);
  assert.equal(put.status, 200, await put.text());
  const done = await lib.uploadFinish(actx, "p-fresh", begun.body.upload_id, "key-synthetic-fresh-finish");
  assert.equal(done.status, 200, JSON.stringify(done.body));

  // Both actors' versions exist, and the review schema stayed inert.
  const kinds = W.all(world, "SELECT DISTINCT via_kind FROM revisions WHERE via_kind IS NOT NULL").map((r) => r.via_kind).sort();
  assert.deepEqual(kinds, ["api_key", "browser"]);
  assert.equal(W.one(world, "SELECT COUNT(*) AS n FROM revisions WHERE blob_key IS NOT NULL").n, 1, "the agent's binary version");
  assert.deepEqual(W.all(world, "SELECT DISTINCT review_mode, pending_review FROM artifacts"), [{ review_mode: "off", pending_review: 0 }]);
  for (const t of ["proposals", "reviews", "review_grants", "project_review_settings", "review_restore_context"])
    assert.equal(W.one(world, `SELECT COUNT(*) AS n FROM ${t}`).n, 0, `${t} stays empty`);
  assert.equal(W.one(world, "SELECT COUNT(*) AS n FROM revisions WHERE proposal_id IS NOT NULL").n, 0);
});

test("fresh install: the cleanup job deletes an orphan placeholder but never a pending_review document", async () => {
  const { world, env } = await install();
  W.seedWorkspace(world, { principal: "hum_c", workspace: "wsp_c", project: "proj_c" });
  const at = "2026-01-01T00:00:00.000Z";
  const placeholder = (id, pendingReview) => W.run(world, `INSERT INTO artifacts (id, project_id, kind, title, head_rev, head_revision_id, created_at, updated_at, pending_review)
    VALUES (?, 'proj_c', 'binary', 'Synthetic placeholder', 0, NULL, ?, ?, ?)`, id, at, at, pendingReview);
  placeholder("art_orphan", 0);
  placeholder("art_pending", 1);
  await lib.reconcileUploads(env, { limit: 100 });
  assert.equal(W.one(world, "SELECT 1 AS x FROM artifacts WHERE id = 'art_orphan'"), undefined, "the ordinary orphan placeholder is removed");
  assert.deepEqual(W.one(world, "SELECT id FROM artifacts WHERE id = 'art_pending'"), { id: "art_pending" }, "a document that exists only as a proposal is kept");
});
