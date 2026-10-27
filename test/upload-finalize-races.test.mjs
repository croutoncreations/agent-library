// Upload finalization races (build-upload-fixes.mjs; security review 2026-10-23, findings 1 and 3). Drives the
// production uploadFinish/reconcileUploads from the deploy bundle (src/index.js) over every migration applied to an
// in-memory SQLite (node:sqlite) and a controlled R2 double, so each interleaving is scheduled exactly, not hoped for.
// The bundle's cloudflare:workers import is replaced by an inert class only so Node can load it. Synthetic data only.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./helpers.mjs";

const dir = mkdtempSync(join(tmpdir(), "al-upload-races-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const src = readFileSync(join(ROOT, "src/index.js"), "utf8");
assert.equal(src.split('import { WorkerEntrypoint } from "cloudflare:workers";').length, 2);
writeFileSync(join(dir, "bundle.mjs"), src.replace('import { WorkerEntrypoint } from "cloudflare:workers";', "class WorkerEntrypoint {}") + "\nexport { uploadFinish, reconcileUploads };");
const lib = await import(join(dir, "bundle.mjs"));

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082", "hex");
const SHA = createHash("sha256").update(PNG).digest("hex");
const P = "prj_synthetic";

function world() {
  const sql = new DatabaseSync(":memory:");
  for (const f of readdirSync(join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort()) sql.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  const hooks = { beforeBatch: null, beforeRun: null };
  const stmt = (q, p) => ({
    async first(c) { const r = sql.prepare(q).get(...p); return c ? r?.[c] ?? null : r ?? null; },
    async all() { return { results: sql.prepare(q).all(...p) }; },
    runSync() { const r = sql.prepare(q).run(...p); return { meta: { changes: Number(r.changes) } }; },
    async run() { if (hooks.beforeRun) await hooks.beforeRun(q); return this.runSync(); },
  });
  const DB = {
    withSession() { return DB; },
    prepare(q) { return { bind: (...p) => stmt(q, p), ...stmt(q, []) }; },
    async batch(ss) {
      if (hooks.beforeBatch) { const h = hooks.beforeBatch; hooks.beforeBatch = null; await h(); }
      sql.exec("BEGIN");
      try { const r = ss.map((s) => s.runSync()); sql.exec("COMMIT"); return r; } catch (e) { sql.exec("ROLLBACK"); throw e; }
    },
  };
  const blobs = new Map();
  const r2 = { onPut: null, beforeCommit: null, failHead: false };
  const BLOBS = {
    async get(k) { const b = blobs.get(k); return b ? { async arrayBuffer() { return b; } } : null; },
    async put(k, b) { if (r2.beforeCommit) await r2.beforeCommit(k); blobs.set(k, b); if (r2.onPut) await r2.onPut(k); },
    async head(k) { if (r2.failHead) throw new Error("synthetic R2 head failure"); return blobs.has(k) ? { size: blobs.get(k).length } : null; },
    async delete(k) { blobs.delete(k); },
  };
  const at = new Date().toISOString();
  sql.prepare("INSERT INTO principals VALUES ('hum_synthetic','human','synthetic','owner','Synthetic owner',?)").run(at);
  sql.prepare("INSERT INTO projects VALUES (?,'hum_synthetic','Synthetic project',?)").run(P, at);
  const env = { DB, BLOBS };
  const ctx = { env, principal: { id: "hum_synthetic", kind: "human", label: "Synthetic owner" }, requestId: "req_synthetic" };
  let n = 0;
  const upload = ({ state = "received", expiresAt = Date.now() + 900000 } = {}) => {
    const id = "upl_s" + ++n, art = "art_s" + n;
    sql.prepare("INSERT INTO artifacts(id,project_id,kind,title,created_at,updated_at) VALUES (?,?, 'binary','Synthetic image',?,?)").run(art, P, at, at);
    sql.prepare("INSERT INTO uploads(id,project_id,artifact_id,principal_id,base_rev,expected_size,expected_sha256,mime,state,staging_key,expires_at,created_at) VALUES (?,?,?,'hum_synthetic',0,?,?,'image/png',?,?,?,?)")
      .run(id, P, art, PNG.length, SHA, state, "staging/" + id, expiresAt, at);
    blobs.set("staging/" + id, PNG);
    return { id, art };
  };
  const finals = () => [...blobs.keys()].filter((k) => k.startsWith("blobs/"));
  const revisions = (art) => sql.prepare("SELECT id, blob_key FROM revisions WHERE artifact_id = ?").all(art);
  const row = (id) => sql.prepare("SELECT * FROM uploads WHERE id = ?").get(id);
  const quota = () => sql.prepare("SELECT COALESCE(SUM(expected_size),0) AS n FROM uploads WHERE project_id = ? AND final_key IS NOT NULL AND final_purged_at IS NULL AND state IN ('failed','conflict')").get(P).n;
  return { sql, env, ctx, hooks, r2, blobs, upload, finals, revisions, row, quota };
}

test("finding 1: cleanup racing an expired sealed retry can no longer leave a revision without bytes", async () => {
  const w = world();
  const { id, art } = w.upload({ state: "sealed", expiresAt: Date.now() - 3600000 });
  // Cleanup runs right before the publication batch, as in the review's reproduction.
  w.hooks.beforeBatch = () => lib.reconcileUploads(w.env);
  const res = await lib.uploadFinish(w.ctx, P, id, "expired-key-1");
  assert.equal(res.status, 200);
  const [rev] = w.revisions(art);
  assert.ok(rev, "published");
  assert.ok(w.blobs.has(rev.blob_key), "published bytes exist");
  assert.equal(w.row(id).state, "published");
  assert.equal(w.row(id).finalize_token, null, "lease released");
});

test("finding 1: cleanup that wins first (lease expired) fails the upload and the late finisher never publishes", async () => {
  const w = world();
  const { id, art } = w.upload({ state: "sealed", expiresAt: Date.now() - 3600000 });
  // Between the final write and the publication, the finisher's lease lapses and cleanup ends the upload.
  w.r2.onPut = async (k) => {
    if (!k.startsWith("blobs/")) return;
    w.r2.onPut = null;
    w.sql.prepare("UPDATE uploads SET finalize_until = ? WHERE id = ?").run(Date.now() - 1, id);
    await lib.reconcileUploads(w.env);
  };
  await assert.rejects(lib.uploadFinish(w.ctx, P, id, "late-key-1"), (e) => e.status === 500 && e.code === "finish_abandoned");
  assert.deepEqual(w.revisions(art), [], "no revision");
  assert.deepEqual(w.finals(), [], "no orphaned final object (the finisher removes what it wrote)");
  assert.equal(w.row(id).state, "failed");
});

test("finding 1: a live lease protects a sealed upload from cleanup", async () => {
  const w = world();
  const { id } = w.upload({ state: "sealed", expiresAt: Date.now() - 3600000 });
  w.sql.prepare("UPDATE uploads SET finalize_token = 'fin_other', finalize_until = ? WHERE id = ?").run(Date.now() + 60000, id);
  await lib.reconcileUploads(w.env);
  assert.equal(w.row(id).state, "sealed");
  w.sql.prepare("UPDATE uploads SET finalize_until = ? WHERE id = ?").run(Date.now() - 1, id);
  await lib.reconcileUploads(w.env);
  assert.equal(w.row(id).state, "failed", "an expired lease no longer protects it");
  assert.equal(w.row(id).finalize_token, null);
});

test("finding 3: concurrent same-key finishes publish once and leave exactly one final object", async () => {
  const w = world();
  const { id, art } = w.upload();
  // Hold the first finisher inside its R2 write until the second has started.
  let release; const gate = new Promise((r) => (release = r));
  w.r2.onPut = async (k) => { if (k.startsWith("blobs/")) { w.r2.onPut = null; await gate; } };
  const a = lib.uploadFinish(w.ctx, P, id, "same-key-123");
  await new Promise((r) => setTimeout(r, 20));
  const b = lib.uploadFinish(w.ctx, P, id, "same-key-123");
  await new Promise((r) => setTimeout(r, 300));
  release();
  const res = await Promise.all([a, b]);
  assert.deepEqual(res.map((r) => r.status), [200, 200]);
  assert.equal(res[0].body.revision_id, res[1].body.revision_id, "both report the one revision");
  const revs = w.revisions(art);
  assert.equal(revs.length, 1);
  assert.deepEqual(w.finals(), [revs[0].blob_key], "one final object, the published one");
  await lib.reconcileUploads(w.env);
  assert.deepEqual(w.finals(), [revs[0].blob_key]);
});

test("finding 3: a finisher stuck past its lease is taken over without a second object", async () => {
  const w = world();
  const { id, art } = w.upload();
  let release; const gate = new Promise((r) => (release = r));
  w.r2.onPut = async (k) => { if (k.startsWith("blobs/")) { w.r2.onPut = null; await gate; } };
  const slow = lib.uploadFinish(w.ctx, P, id, "slow-key-1");
  await new Promise((r) => setTimeout(r, 20));
  const key = w.row(id).final_key;
  w.sql.prepare("UPDATE uploads SET finalize_until = ? WHERE id = ?").run(Date.now() - 1, id); // lease lapses
  const fresh = await lib.uploadFinish(w.ctx, P, id, "fresh-key-1");
  assert.equal(fresh.status, 200);
  release();
  const late = await slow;
  assert.equal(late.status, 200);
  assert.equal(late.body.revision_id, fresh.body.revision_id, "the stale finisher replays the takeover's result");
  const revs = w.revisions(art);
  assert.equal(revs.length, 1);
  assert.equal(revs[0].blob_key, key, "the final key was fixed at the first lease");
  assert.deepEqual(w.finals(), [key]);
});

test("conflict at publication removes the unpublished object and records the conflict once", async () => {
  const w = world();
  const { id, art } = w.upload();
  w.sql.prepare("UPDATE artifacts SET head_rev = 3 WHERE id = ?").run(art); // base_rev 0 is stale
  await assert.rejects(lib.uploadFinish(w.ctx, P, id, "conflict-key-1"), (e) => e.status === 409 && e.code === "revision_conflict");
  assert.deepEqual(w.finals(), []);
  assert.equal(w.row(id).state, "conflict");
  assert.ok(w.row(id).final_purged_at);
  await assert.rejects(lib.uploadFinish(w.ctx, P, id, "conflict-key-1"), (e) => e.status === 409 && e.code === "revision_conflict");
});

test("a final write still in flight when cleanup fails the upload is purged only after it settles (even if HEAD then fails)", async () => {
  const w = world();
  const { id, art } = w.upload({ state: "sealed", expiresAt: Date.now() - 3600000 });
  // The finisher's put is in flight; meanwhile its lease lapses and cleanup fails the upload. Cleanup must not purge
  // (and stop tracking) the key while the write can still commit. The put then commits and HEAD throws, so the
  // finisher never reaches its own clean-up path.
  w.r2.beforeCommit = async (k) => {
    if (!k.startsWith("blobs/")) return;
    w.r2.beforeCommit = null;
    w.sql.prepare("UPDATE uploads SET finalize_until = ? WHERE id = ?").run(Date.now() - 1, id);
    await lib.reconcileUploads(w.env);
    assert.equal(w.row(id).state, "failed");
    assert.equal(w.row(id).final_writes, 1);
    assert.equal(w.row(id).final_purged_at, null, "not purged while a write is in flight");
    w.r2.failHead = true;
  };
  await assert.rejects(lib.uploadFinish(w.ctx, P, id, "late-commit-1"), /synthetic R2 head failure/);
  w.r2.failHead = false;
  const key = w.row(id).final_key;
  assert.equal(w.row(id).final_writes, 0, "write settled");
  assert.deepEqual(w.finals(), [key], "the late write committed");
  assert.equal(w.quota(), PNG.length, "still tracked and counted against quota");
  await lib.reconcileUploads(w.env);
  assert.deepEqual(w.finals(), [], "purged once no write was in flight");
  assert.ok(w.row(id).final_purged_at);
  assert.equal(w.quota(), 0);
  assert.deepEqual(w.revisions(art), []);
});

test("a Worker that dies mid-write leaves the object tracked and counted, never orphaned", async () => {
  const w = world();
  const { id } = w.upload({ state: "sealed", expiresAt: Date.now() - 3600000 });
  // Simulate termination: a write registered but never settled, object present, lease lapsed.
  const key = "blobs/" + P + "/" + w.row(id).artifact_id + "/rev_synthetic_dead";
  w.sql.prepare("UPDATE uploads SET final_key = ?, final_writes = 1, finalize_token = 'fin_dead', finalize_until = ? WHERE id = ?").run(key, Date.now() - 1, id);
  w.blobs.set(key, PNG);
  await lib.reconcileUploads(w.env);
  assert.equal(w.row(id).state, "failed");
  assert.ok(w.blobs.has(key));
  assert.equal(w.row(id).final_purged_at, null, "still tracked by cleanup");
  assert.equal(w.quota(), PNG.length, "still counted against quota");
});

test("cleanup never deletes a final object a revision references", async () => {
  const w = world();
  const { id, art } = w.upload();
  const res = await lib.uploadFinish(w.ctx, P, id, "published-key-1");
  assert.equal(res.status, 200);
  const [rev] = w.revisions(art);
  // Even if the row were (wrongly) terminal with an old purge mark, a referenced key is kept.
  w.sql.prepare("UPDATE uploads SET state = 'failed' WHERE id = ?").run(id);
  await lib.reconcileUploads(w.env);
  assert.ok(w.blobs.has(rev.blob_key));
});

test("decrement failures preserve the PUT error and retained accounting is visible without private identifiers", async () => {
  const w = world();
  const { id } = w.upload({ state: "sealed", expiresAt: Date.now() - 3600000 });
  w.hooks.beforeRun = (q) => { if (q.includes("final_writes = final_writes - 1")) throw new Error("synthetic decrement failure"); };
  w.r2.beforeCommit = () => { throw new Error("synthetic original PUT failure"); };
  const warnings = [];
  const warn = console.warn;
  console.warn = (s) => warnings.push(JSON.parse(s));
  try {
    await assert.rejects(lib.uploadFinish(w.ctx, P, id, "release-failure"), /synthetic original PUT failure/);
    assert.equal(w.row(id).final_writes, 1, "failure leaves accounting raised");
    await lib.reconcileUploads(w.env);
    assert.equal(w.row(id).state, "failed");
    assert.deepEqual(warnings[0], { event: "upload_final_write_release_failed" });
    assert.equal(warnings[1].event, "upload_final_writes_retained");
    assert.equal(warnings[1].count, 1);
    assert.ok(warnings[1].oldest_expiry_age_ms >= 3600000);
    assert.equal(JSON.stringify(warnings).includes(id), false, "warnings contain no upload identifier");
    assert.equal(w.row(id).final_purged_at, null, "still retained for operator recovery");
  } finally { console.warn = warn; }
});

test("a successful PUT with a failed decrement publishes safely and remains visible to reconciliation", async () => {
  const w = world();
  const { id, art } = w.upload();
  w.hooks.beforeRun = (q) => { if (q.includes("final_writes = final_writes - 1")) throw new Error("synthetic decrement failure"); };
  const warnings = [];
  const warn = console.warn;
  console.warn = (s) => warnings.push(JSON.parse(s));
  try {
    assert.equal((await lib.uploadFinish(w.ctx, P, id, "published-release-failure")).status, 200);
    assert.equal(w.row(id).state, "published");
    assert.equal(w.row(id).final_writes, 1);
    assert.equal(w.quota(), 0, "published revision is not double-charged through the upload");
    const [rev] = w.revisions(art);
    await lib.reconcileUploads(w.env);
    assert.ok(w.blobs.has(rev.blob_key), "referenced bytes are never purged");
    assert.deepEqual(warnings[0], { event: "upload_final_write_release_failed" });
    assert.equal(warnings[1].event, "upload_final_writes_retained");
    assert.equal(warnings[1].count, 1, "published outstanding accounting is visible");
  } finally { console.warn = warn; }
});

test("a conflicting takeover never deletes the object while another finisher's write is in flight", async () => {
  const w = world();
  const { id, art } = w.upload();
  w.sql.prepare("UPDATE artifacts SET head_rev = 3 WHERE id = ?").run(art); // publication will conflict
  // A's put is held before commit; its lease lapses and B takes over, writes, and hits the conflict.
  let releaseA; const holdA = new Promise((r) => (releaseA = r));
  let first = true;
  w.r2.beforeCommit = async (k) => { if (k.startsWith("blobs/") && first) { first = false; await holdA; } };
  const a = lib.uploadFinish(w.ctx, P, id, "takeover-a");
  await new Promise((r) => setTimeout(r, 20));
  w.sql.prepare("UPDATE uploads SET finalize_until = ? WHERE id = ?").run(Date.now() - 1, id);
  await assert.rejects(lib.uploadFinish(w.ctx, P, id, "takeover-b"), (e) => e.code === "revision_conflict");
  assert.equal(w.row(id).state, "conflict");
  assert.equal(w.row(id).final_purged_at, null, "B left the purge to cleanup: A's write is in flight");
  // A's put now commits, then its HEAD fails.
  w.r2.failHead = true; releaseA();
  await assert.rejects(a);
  w.r2.failHead = false;
  assert.equal(w.row(id).final_writes, 0);
  assert.equal(w.finals().length, 1, "A re-created the object");
  assert.equal(w.quota(), PNG.length, "still counted");
  await lib.reconcileUploads(w.env);
  assert.deepEqual(w.finals(), [], "cleanup purged it once idle");
  assert.equal(w.quota(), 0);
});
