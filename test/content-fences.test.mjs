// Publication fences (keyFence, plaintextFence, fenceRefusal in packages/core/src/content-store.js;
// docs/encryption.md#rules-for-code-that-uses-this), loaded from the real sources (test/load-worker.mjs) on node:sqlite
// with every migration applied. No listeners; local D1 coverage is in test/text-r2.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadWorker } from "./load-worker.mjs";
import { ROOT } from "./helpers.mjs";

const lib = await loadWorker({
  "content-store.js": ["keyFence", "plaintextFence", "fenceRefusal", "commitTextWrites", "isTextWriteFenceError"],
  "crypto/keys.js": ["shredWorkspaceKeys", "NO_REAL_KEY_SQL"],
  "service.js": ["runBatch"],
  "util.js": ["HttpError"]
});

const MIGRATIONS = readdirSync(join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort();
const KEY_ACTIVE_MESSAGE = "NOT NULL constraint failed: content_fences.key_active";
const NO_REAL_KEY_MESSAGE = "NOT NULL constraint failed: content_fences.no_real_key";
const TEXT_DEADLINE_MESSAGE = "NOT NULL constraint failed: content_writes.project_id";

/** node:sqlite with D1's prepare/bind/run/first/all/batch surface; batch is one transaction. */
function mkDB() {
  const sql = new DatabaseSync(":memory:");
  for (const f of MIGRATIONS) sql.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  const exec = (s) => /^\s*(SELECT|WITH|EXPLAIN)/i.test(s.q) ? { results: sql.prepare(s.q).all(...s.p), meta: { changes: 0 } } : { meta: { changes: sql.prepare(s.q).run(...s.p).changes } };
  const stmt = (q, p = []) => ({ q, p, bind: (...b) => stmt(q, b),
    async first(c) { const r = sql.prepare(q).get(...p); return c ? r?.[c] ?? null : r ?? null; },
    async all() { return { results: sql.prepare(q).all(...p) }; },
    async run() { return exec({ q, p }); } });
  const DB = { prepare: (q) => stmt(q), async batch(stmts) {
    sql.exec("BEGIN");
    try { const out = stmts.map(exec); sql.exec("COMMIT"); return out; } catch (e) { sql.exec("ROLLBACK"); throw e; }
  } };
  const at = new Date().toISOString();
  sql.prepare("INSERT INTO principals (id, kind, issuer, subject, label, created_at) VALUES ('hum_a', 'human', 'synthetic', 'a', 'Synthetic', ?)").run(at);
  sql.prepare("INSERT INTO projects (id, owner_id, title, created_at) VALUES ('proj-a', 'hum_a', 'Synthetic', ?)").run(at);
  return { sql, DB, env: { DB } };
}
const addKey = (sql, workspaceId, keyId, masterVersion = 1) =>
  sql.prepare("INSERT INTO workspace_keys (workspace_id, key_id, master_version, wrapped, created_at, shredded_at) VALUES (?, ?, ?, 'c3ludGhldGlj', 1, NULL)").run(workspaceId, keyId, masterVersion);
const fenceRows = (sql) => sql.prepare("SELECT COUNT(*) AS n FROM content_fences").get().n;
const errorMessage = async (p) => { try { await p; } catch (e) { return e.message; } return null; };

test("migration 0030 applies twice, adds both NOT NULL columns and an index NO_REAL_KEY_SQL uses", () => {
  const { sql } = mkDB();
  const migration = readFileSync(join(ROOT, "migrations", "0030_content_fences.sql"), "utf8");
  sql.exec(migration);
  sql.exec(migration);
  const cols = sql.prepare("PRAGMA table_info(content_fences)").all().map((c) => [c.name, c.notnull]);
  assert.deepEqual(cols, [["key_active", 1], ["no_real_key", 1]]);
  assert.ok(sql.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'index' AND name = 'workspace_keys_real'").get());
  const plan = sql.prepare(`EXPLAIN QUERY PLAN SELECT ${lib.NO_REAL_KEY_SQL}`).all().map((r) => r.detail).join("\n");
  assert.match(plan, /workspace_keys_real/);
});

test("keyFence passes while the key row is active and refuses shredded, unknown and other-workspace keys", async () => {
  const { sql, env } = mkDB();
  addKey(sql, "wsp_a", "wk_a");
  addKey(sql, "wsp_b", "wk_b");
  const ok = await lib.keyFence(env, { keyId: "wk_a", workspaceId: "wsp_a" }).run();
  assert.equal(ok.meta.changes, 0);
  assert.equal(fenceRows(sql), 0);
  assert.equal(await errorMessage(lib.keyFence(env, { keyId: "wk_unknown", workspaceId: "wsp_a" }).run()), KEY_ACTIVE_MESSAGE);
  assert.equal(await errorMessage(lib.keyFence(env, { keyId: "wk_b", workspaceId: "wsp_a" }).run()), KEY_ACTIVE_MESSAGE);
  await lib.shredWorkspaceKeys(env, "wsp_a");
  assert.equal(await errorMessage(lib.keyFence(env, { keyId: "wk_a", workspaceId: "wsp_a" }).run()), KEY_ACTIVE_MESSAGE);
  assert.equal((await lib.keyFence(env, { keyId: "wk_b", workspaceId: "wsp_b" }).run()).meta.changes, 0);
  assert.equal(fenceRows(sql), 0);
});

test("keyFence refuses to build a fence without both ids", () => {
  const { env } = mkDB();
  for (const args of [{}, { keyId: "wk_a" }, { workspaceId: "wsp_a" }, { keyId: "", workspaceId: "wsp_a" }, { keyId: "wk_a", workspaceId: "" }, { keyId: 1, workspaceId: "wsp_a" }, { keyId: "wk_a", workspaceId: null }]) {
    assert.throws(() => lib.keyFence(env, args), (e) => e.status === 500 && e.code === "fence_invalid", JSON.stringify(args));
  }
  assert.throws(() => lib.keyFence(env), (e) => e.status === 500 && e.code === "fence_invalid");
});

test("plaintextFence passes with no real key row and refuses once one exists, shredded or not", async () => {
  const { sql, env } = mkDB();
  assert.equal((await lib.plaintextFence(env).run()).meta.changes, 0);
  await lib.shredWorkspaceKeys(env, "wsp_t"); // a tombstone only (master_version 0)
  assert.equal(sql.prepare("SELECT master_version FROM workspace_keys").get().master_version, 0);
  assert.equal((await lib.plaintextFence(env).run()).meta.changes, 0);
  addKey(sql, "wsp_a", "wk_a");
  assert.equal(await errorMessage(lib.plaintextFence(env).run()), NO_REAL_KEY_MESSAGE);
  await lib.shredWorkspaceKeys(env, "wsp_a");
  assert.equal(await errorMessage(lib.plaintextFence(env).run()), NO_REAL_KEY_MESSAGE);
  assert.equal(fenceRows(sql), 0);
});

const STARTED_MESSAGE = "Encryption was turned on while this was being saved; send it again";

test("fenceRefusal maps only the two fence messages", () => {
  const shredded = lib.fenceRefusal(new Error(KEY_ACTIVE_MESSAGE));
  assert.deepEqual([shredded.status, shredded.code, shredded.message], [410, "key_shredded", "This workspace's content key has been shredded"]);
  const started = lib.fenceRefusal(new Error(`D1_ERROR: ${NO_REAL_KEY_MESSAGE}: SQLITE_CONSTRAINT`));
  assert.deepEqual([started.status, started.code, started.message], [409, "encryption_started", STARTED_MESSAGE]);
  for (const other of [
    new Error(TEXT_DEADLINE_MESSAGE),
    new Error("UNIQUE constraint failed: idempotency.principal_id, idempotency.project_id, idempotency.op, idempotency.key"),
    new Error("NOT NULL constraint failed: artifacts.title"),
    new Error("no such table: content_fences"),
    new Error("NOT NULL constraint failed: content_fences.key_activex"),
    new Error("CHECK constraint failed: key_active IS NULL AND no_real_key IS NULL"),
    null, undefined, 42, {}, ""
  ]) assert.equal(lib.fenceRefusal(other), null, String(other?.message ?? other));
});

test("fenceRefusal returns an already mapped refusal unchanged and so is safe to call twice", () => {
  const shredded = lib.fenceRefusal(new Error(KEY_ACTIVE_MESSAGE));
  const started = lib.fenceRefusal(new Error(NO_REAL_KEY_MESSAGE));
  assert.equal(lib.fenceRefusal(shredded), shredded);
  assert.equal(lib.fenceRefusal(started), started);
  assert.equal(lib.fenceRefusal(lib.fenceRefusal(shredded)), shredded);
  // An HttpError with another code is not a refusal, even if its message happens to quote one.
  const other = Object.assign(new Error(KEY_ACTIVE_MESSAGE), { status: 409, code: "conflict" });
  assert.equal(lib.fenceRefusal(other).code, "key_shredded");
});

test("fenceRefusal reads a bare string and a cause chain of at most three levels", () => {
  assert.equal(lib.fenceRefusal(KEY_ACTIVE_MESSAGE).code, "key_shredded");
  assert.equal(lib.fenceRefusal(`D1_ERROR: ${NO_REAL_KEY_MESSAGE}`).code, "encryption_started");
  const d1Error = new Error(`D1_ERROR: ${KEY_ACTIVE_MESSAGE}: SQLITE_CONSTRAINT`);
  assert.equal(lib.fenceRefusal(new Error("publication failed", { cause: d1Error })).status, 410);
  assert.equal(lib.fenceRefusal(new Error("outer", { cause: new Error("middle", { cause: d1Error }) })).status, 410);
  assert.equal(lib.fenceRefusal(new Error("outer", { cause: NO_REAL_KEY_MESSAGE })).status, 409);
  assert.equal(lib.fenceRefusal({ message: "wrapper", cause: { cause: NO_REAL_KEY_MESSAGE } }).status, 409);
  assert.equal(lib.fenceRefusal(new Error("1", { cause: new Error("2", { cause: new Error("3", { cause: d1Error }) }) })), null);
  assert.equal(lib.fenceRefusal(new Error("publication failed", { cause: new Error("network timeout") })), null);
});

test("content_fences refuses every row: NULLs by NOT NULL with the column name, anything else by its CHECK", () => {
  const { sql } = mkDB();
  assert.throws(() => sql.prepare("INSERT INTO content_fences (key_active, no_real_key) VALUES (1, 1)").run(), /CHECK constraint failed/);
  assert.throws(() => sql.prepare("INSERT INTO content_fences (key_active, no_real_key) VALUES (0, 0)").run(), /CHECK constraint failed/);
  assert.throws(() => sql.prepare("INSERT INTO content_fences (key_active, no_real_key) VALUES (NULL, 0)").run(), { message: KEY_ACTIVE_MESSAGE });
  assert.throws(() => sql.prepare("INSERT INTO content_fences (key_active, no_real_key) VALUES (0, NULL)").run(), { message: NO_REAL_KEY_MESSAGE });
  assert.equal(fenceRows(sql), 0);
});

test("a refusing fence placed last rolls back the whole batch; a passing one leaves earlier results in place", async () => {
  const { sql, DB, env } = mkDB();
  addKey(sql, "wsp_a", "wk_a");
  const insert = (key) => DB.prepare("INSERT INTO content_writes (key, project_id, created_at) VALUES (?, 'proj-a', 1)").bind(key);
  const out = await DB.batch([insert("text/ok"), insert("text/ok2"), lib.keyFence(env, { keyId: "wk_a", workspaceId: "wsp_a" })]);
  assert.equal(out.length, 3);
  assert.equal(out[0].meta.changes, 1);
  assert.equal(out[2].meta.changes, 0);
  await assert.rejects(DB.batch([insert("text/no"), lib.keyFence(env, { keyId: "wk_missing", workspaceId: "wsp_a" })]), { message: KEY_ACTIVE_MESSAGE });
  await assert.rejects(DB.batch([insert("text/no2"), lib.plaintextFence(env)]), { message: NO_REAL_KEY_MESSAGE });
  assert.deepEqual(sql.prepare("SELECT key FROM content_writes ORDER BY key").all().map((r) => r.key), ["text/ok", "text/ok2"]);
  assert.equal(fenceRows(sql), 0);
});

test("runBatch answers both fence refusals as their HttpError, still maps UNIQUE to 409 conflict and rethrows the text deadline", async () => {
  const { sql, DB, env } = mkDB();
  addKey(sql, "wsp_a", "wk_a");
  const ctx = { env, requestId: "req_s", principal: { id: "hum_a", kind: "human", label: "Synthetic" } };
  const idem = { projectId: "proj-a", op: "synthetic", key: "k1", digest: "d" };
  const insert = (key) => DB.prepare("INSERT INTO content_writes (key, project_id, created_at) VALUES (?, 'proj-a', 1)").bind(key);
  const outcome = (p) => p.then(() => null, (e) => e);
  const shredded = await outcome(lib.runBatch(ctx, [insert("text/x"), lib.keyFence(env, { keyId: "wk_gone", workspaceId: "wsp_a" })], idem));
  assert.deepEqual([shredded.status, shredded.code], [410, "key_shredded"]);
  const started = await outcome(lib.runBatch(ctx, [insert("text/x"), lib.plaintextFence(env)], idem));
  assert.deepEqual([started.status, started.code, started.message], [409, "encryption_started", STARTED_MESSAGE]);
  const deadline = await outcome(lib.runBatch(ctx, [insert("text/x"), DB.prepare("INSERT INTO content_writes (key, project_id, created_at) VALUES (NULL, NULL, NULL)")], idem));
  assert.equal(deadline.message, TEXT_DEADLINE_MESSAGE);
  assert.equal(deadline.status, undefined, "the text deadline stays raw for commitTextWrites");
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM content_writes").get().n, 0);
  await lib.runBatch(ctx, [insert("text/dup")], idem);
  await assert.rejects(lib.runBatch(ctx, [insert("text/dup")], idem), (e) => e.status === 409 && e.code === "conflict");
});

test("a replay whose idempotency row already committed returns the stored response, not the refusal of a later fence", async () => {
  const { sql, DB, env } = mkDB();
  const ctx = { env, requestId: "req_s", principal: { id: "hum_a", kind: "human", label: "Synthetic" } };
  const idem = { projectId: "proj-a", op: "synthetic", key: "replay-1", digest: "d" };
  const stored = { artifact_id: "art_synthetic" };
  const idemRow = () => DB.prepare(`INSERT INTO idempotency (principal_id, project_id, op, key, digest, status, response, created_at)
    VALUES ('hum_a', 'proj-a', 'synthetic', 'replay-1', 'd', 201, ?, ?)`).bind(JSON.stringify(stored), new Date().toISOString());
  const insert = (key) => DB.prepare("INSERT INTO content_writes (key, project_id, created_at) VALUES (?, 'proj-a', 1)").bind(key);
  await lib.runBatch(ctx, [idemRow(), insert("text/first"), lib.plaintextFence(env)], idem);
  addKey(sql, "wsp_a", "wk_a"); // the plaintext fence now refuses
  await assert.rejects(DB.batch([lib.plaintextFence(env)]), { message: NO_REAL_KEY_MESSAGE });
  const replay = await lib.runBatch(ctx, [idemRow(), insert("text/second"), lib.plaintextFence(env)], idem);
  assert.deepEqual(replay, { status: 201, body: { ...stored, idempotent_replay: true } });
  assert.deepEqual(sql.prepare("SELECT key FROM content_writes ORDER BY key").all().map((r) => r.key), ["text/first"]);
});

test("commitTextWrites answers a fence refusal as its HttpError and at once removes only the unreferenced staged text", async () => {
  const { sql, DB, env } = mkDB();
  const objects = new Set(["text/proj-a/a/staged", "text/proj-a/a/published"]);
  env.BLOBS = { async delete(keys) { for (const k of [keys].flat()) objects.delete(k); } };
  const at = new Date().toISOString();
  sql.prepare("INSERT INTO artifacts (id, project_id, kind, title, created_at, updated_at) VALUES ('a', 'proj-a', 'markdown', 'Synthetic', ?, ?)").run(at, at);
  sql.prepare(`INSERT INTO revisions (id, artifact_id, project_id, rev_no, author_id, size, sha256, mime, created_at, body_key)
    VALUES ('r1', 'a', 'proj-a', 1, 'hum_a', 1, 'x', 'text/markdown', ?, 'text/proj-a/a/published')`).run(at);
  for (const key of objects) sql.prepare("INSERT INTO content_writes (key, project_id, created_at) VALUES (?, 'proj-a', ?)").run(key, Date.now());
  const keys = ["text/proj-a/a/staged", "text/proj-a/a/published"];
  const err = await lib.commitTextWrites(env, keys, (guarded) => DB.batch(guarded([
    DB.prepare("INSERT INTO content_writes (key, project_id, created_at) VALUES ('text/should-rollback', 'proj-a', 1)"),
    lib.keyFence(env, { keyId: "wk_missing", workspaceId: "wsp_a" })
  ]))).then(() => null, (e) => e);
  assert.deepEqual([err?.status, err?.code], [410, "key_shredded"]);
  // Cleanup ran for the refused write; the object and intent a revision refers to were kept.
  assert.deepEqual([...objects], ["text/proj-a/a/published"]);
  assert.deepEqual(sql.prepare("SELECT key FROM content_writes").all().map((r) => r.key), ["text/proj-a/a/published"]);
  assert.equal(sql.prepare("SELECT body_key FROM revisions").get().body_key, "text/proj-a/a/published");

  // The same through runBatch (already mapped there) and for a plaintext refusal.
  objects.add("text/proj-a/a/staged2");
  sql.prepare("INSERT INTO content_writes (key, project_id, created_at) VALUES ('text/proj-a/a/staged2', 'proj-a', ?)").run(Date.now());
  addKey(sql, "wsp_a", "wk_a");
  const ctx = { env, requestId: "req_s", principal: { id: "hum_a", kind: "human", label: "Synthetic" } };
  const err2 = await lib.commitTextWrites(env, ["text/proj-a/a/staged2"], (guarded) => lib.runBatch(ctx, guarded([lib.plaintextFence(env)]), { projectId: "proj-a", op: "synthetic", key: "k2", digest: "d" })).then(() => null, (e) => e);
  assert.deepEqual([err2?.status, err2?.code], [409, "encryption_started"]);
  assert.deepEqual([...objects], ["text/proj-a/a/published"]);
  assert.deepEqual(sql.prepare("SELECT key FROM content_writes").all().map((r) => r.key), ["text/proj-a/a/published"]);
});

// A retry with the same idempotency key that runs while the first attempt commits: its own lookup missed, its guarded
// statements and its guarded idempotency INSERT change no row (the head moved), so no UNIQUE error fires, and then a
// fence refuses. The request did succeed, so the stored response wins over the refusal.
const synthCtx = (env) => ({ env, requestId: "req_s", principal: { id: "hum_a", kind: "human", label: "Synthetic" } });
const storeIdem = (sql, key, digest, response) => sql.prepare(`INSERT INTO idempotency (principal_id, project_id, op, key, digest, status, response, created_at)
  VALUES ('hum_a', 'proj-a', 'synthetic', ?, ?, 201, ?, ?)`).run(key, digest, JSON.stringify(response), new Date().toISOString());
/** The retry's batch: a head-guarded statement and a guarded idempotency INSERT, both changing 0 rows, then `fence`. */
const lostRaceBatch = (DB, key, fence) => [
  DB.prepare("INSERT INTO content_writes (key, project_id, created_at) SELECT 'text/lost-race', 'proj-a', 1 WHERE EXISTS (SELECT 1 FROM artifacts WHERE id = 'a' AND head_rev = 99)"),
  DB.prepare(`INSERT INTO idempotency (principal_id, project_id, op, key, digest, status, response, created_at)
    SELECT 'hum_a', 'proj-a', 'synthetic', ?, 'd', 201, '{}', ? WHERE EXISTS (SELECT 1 FROM revisions WHERE id = 'r_lost_race')`).bind(key, new Date().toISOString()),
  fence
];
const refusingFences = (env) => [["key_shredded", lib.keyFence(env, { keyId: "wk_gone", workspaceId: "wsp_a" })], ["encryption_started", lib.plaintextFence(env)]];

test("runBatch: a stored response with the same key and digest wins over the refusal of the retry's fence", async () => {
  const { sql, DB, env } = mkDB();
  addKey(sql, "wsp_a", "wk_a"); // makes the plaintext fence refuse
  const stored = { artifact_id: "art_synthetic", revision: 1 };
  for (const [code, fence] of refusingFences(env)) {
    const key = "race-" + code;
    storeIdem(sql, key, "d", stored);
    const out = await lib.runBatch(synthCtx(env), lostRaceBatch(DB, key, fence), { projectId: "proj-a", op: "synthetic", key, digest: "d" });
    assert.deepEqual(out, { status: 201, body: { ...stored, idempotent_replay: true } }, code);
  }
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM content_writes").get().n, 0);
});

test("runBatch: without a stored response the retry's fence refusal is answered as before", async () => {
  const { sql, DB, env } = mkDB();
  addKey(sql, "wsp_a", "wk_a");
  for (const [code, fence] of refusingFences(env)) {
    const key = "none-" + code;
    const err = await lib.runBatch(synthCtx(env), lostRaceBatch(DB, key, fence), { projectId: "proj-a", op: "synthetic", key, digest: "d" }).then(() => null, (e) => e);
    assert.equal(err?.code, code);
  }
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM idempotency").get().n, 0);
});

test("runBatch: a stored response under the same key with a different digest answers what idemLookup answers (422)", async () => {
  const { sql, DB, env } = mkDB();
  addKey(sql, "wsp_a", "wk_a");
  for (const [code, fence] of refusingFences(env)) {
    const key = "reused-" + code;
    storeIdem(sql, key, "other-digest", { artifact_id: "art_other" });
    const err = await lib.runBatch(synthCtx(env), lostRaceBatch(DB, key, fence), { projectId: "proj-a", op: "synthetic", key, digest: "d" }).then(() => null, (e) => e);
    assert.deepEqual([err?.status, err?.code], [422, "idempotency_key_reused"], code);
  }
});

/** An artifact 'a' with revision r1 (body_key `revisionKey`) and, optionally, comment c1 (body_key `commentKey`). */
function seedPublished(sql, { revisionKey, commentKey } = {}) {
  const at = new Date().toISOString();
  sql.prepare("INSERT INTO artifacts (id, project_id, kind, title, head_rev, created_at, updated_at) VALUES ('a', 'proj-a', 'markdown', 'Synthetic', 1, ?, ?)").run(at, at);
  if (revisionKey) sql.prepare(`INSERT INTO revisions (id, artifact_id, project_id, rev_no, author_id, size, sha256, mime, created_at, body_key)
    VALUES ('r1', 'a', 'proj-a', 1, 'hum_a', 1, 'x', 'text/markdown', ?, ?)`).run(at, revisionKey);
  if (commentKey) sql.prepare(`INSERT INTO comments (id, project_id, artifact_id, rev_no, author_id, body, created_at, body_key)
    VALUES ('c1', 'proj-a', 'a', 1, 'hum_a', '', ?, ?)`).run(at, commentKey);
}
/** Objects in a fake bucket, each with a fresh text-write intent. */
function stageObjects(sql, env, keys) {
  const objects = new Set(keys);
  env.BLOBS = { async delete(ks) { for (const k of [ks].flat()) objects.delete(k); } };
  for (const key of keys) sql.prepare("INSERT INTO content_writes (key, project_id, created_at) VALUES (?, 'proj-a', ?)").run(key, Date.now());
  return objects;
}
const intentKeys = (sql) => sql.prepare("SELECT key FROM content_writes ORDER BY key").all().map((r) => r.key);

test("commitTextWrites: when runBatch returns the stored replay, the retry's staged text goes at once and referenced text stays", async () => {
  const { sql, DB, env } = mkDB();
  addKey(sql, "wsp_a", "wk_a");
  const first = "text/proj-a/a/r1", retry = "text/proj-a/a/r_retry";
  seedPublished(sql, { revisionKey: first });
  const stored = { artifact_id: "a", revision: 1, revision_id: "r1" };
  for (const [code, fence] of refusingFences(env)) {
    const key = "replay-" + code;
    storeIdem(sql, key, "d", stored);
    sql.prepare("DELETE FROM content_writes").run();
    // The first attempt's key is passed too (with a live intent, so the deadline fence passes): the cleanup must keep
    // it because a revision refers to it.
    const objects = stageObjects(sql, env, [retry, first]);
    const out = await lib.commitTextWrites(env, [retry, first], (guarded) => lib.runBatch(synthCtx(env), guarded(lostRaceBatch(DB, key, fence)), { projectId: "proj-a", op: "synthetic", key, digest: "d" }));
    assert.deepEqual(out, { status: 201, body: { ...stored, idempotent_replay: true } }, code);
    assert.deepEqual([...objects], [first], code);
    assert.deepEqual(intentKeys(sql), [first], code);
    assert.equal(sql.prepare("SELECT body_key FROM revisions WHERE id = 'r1'").get().body_key, first);
  }
});

// A commit callback may throw a refusal-coded HttpError that no fence statement raised. The cleanup is still safe because
// it deletes only keys no revision or comment refers to, not because the batch is known to have rolled back.
test("commitTextWrites: a key_shredded thrown by the callback before any batch removes the staged unreferenced text", async () => {
  const { sql, env } = mkDB();
  const staged = "text/proj-a/a/staged";
  const objects = stageObjects(sql, env, [staged]);
  const err = await lib.commitTextWrites(env, [staged], async () => { throw new lib.HttpError(410, "key_shredded", "synthetic"); }).then(() => null, (e) => e);
  assert.deepEqual([err?.status, err?.code], [410, "key_shredded"]);
  assert.deepEqual([...objects], []);
  assert.deepEqual(intentKeys(sql), []);
});

for (const holder of ["revision", "comment"]) {
  test(`commitTextWrites: a key_shredded thrown after the callback's batch committed keeps the text a ${holder} refers to`, async () => {
    const { sql, DB, env } = mkDB();
    const published = "text/proj-a/a/published", spare = "text/proj-a/a/spare";
    seedPublished(sql, {});
    const objects = stageObjects(sql, env, [published, spare]);
    const at = new Date().toISOString();
    const publish = holder === "revision"
      ? DB.prepare(`INSERT INTO revisions (id, artifact_id, project_id, rev_no, author_id, size, sha256, mime, created_at, body_key)
          VALUES ('r1', 'a', 'proj-a', 1, 'hum_a', 1, 'x', 'text/markdown', ?, ?)`).bind(at, published)
      : DB.prepare(`INSERT INTO comments (id, project_id, artifact_id, rev_no, author_id, body, created_at, body_key)
          VALUES ('c1', 'proj-a', 'a', 1, 'hum_a', '', ?, ?)`).bind(at, published);
    const err = await lib.commitTextWrites(env, [published, spare], async (guarded) => {
      await DB.batch(guarded([publish]));
      throw new lib.HttpError(410, "key_shredded", "synthetic");
    }).then(() => null, (e) => e);
    assert.deepEqual([err?.status, err?.code], [410, "key_shredded"]);
    assert.deepEqual([...objects], [published]);
    assert.deepEqual(intentKeys(sql), [published]);
    const table = holder === "revision" ? "revisions" : "comments";
    assert.equal(sql.prepare(`SELECT body_key FROM ${table}`).get().body_key, published);
  });
}
