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
  "service.js": ["runBatch"]
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

test("fenceRefusal maps only the two fence messages", () => {
  const shredded = lib.fenceRefusal(new Error(KEY_ACTIVE_MESSAGE));
  assert.deepEqual([shredded.status, shredded.code, shredded.message], [410, "key_shredded", "This workspace's content key has been shredded"]);
  const started = lib.fenceRefusal(new Error(`D1_ERROR: ${NO_REAL_KEY_MESSAGE}: SQLITE_CONSTRAINT`));
  assert.deepEqual([started.status, started.code, started.message], [409, "encryption_started", "Encryption was turned on while this was being saved; try again"]);
  for (const other of [
    new Error(TEXT_DEADLINE_MESSAGE),
    new Error("UNIQUE constraint failed: idempotency.principal_id, idempotency.project_id, idempotency.op, idempotency.key"),
    new Error("NOT NULL constraint failed: artifacts.title"),
    new Error("no such table: content_fences"),
    new Error("NOT NULL constraint failed: content_fences.key_activex"),
    null, undefined, 42, {}
  ]) assert.equal(lib.fenceRefusal(other), null, String(other?.message ?? other));
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

test("runBatch rethrows both fence refusals unchanged, still maps UNIQUE to 409 conflict and rethrows the text deadline", async () => {
  const { sql, DB, env } = mkDB();
  addKey(sql, "wsp_a", "wk_a");
  const ctx = { env, requestId: "req_s", principal: { id: "hum_a", kind: "human", label: "Synthetic" } };
  const idem = { projectId: "proj-a", op: "synthetic", key: "k1", digest: "d" };
  const insert = (key) => DB.prepare("INSERT INTO content_writes (key, project_id, created_at) VALUES (?, 'proj-a', 1)").bind(key);
  const raw = async (stmts) => { try { await DB.batch(stmts); } catch (e) { return e; } };
  for (const fence of [lib.keyFence(env, { keyId: "wk_gone", workspaceId: "wsp_a" }), lib.plaintextFence(env), DB.prepare("INSERT INTO content_writes (key, project_id, created_at) VALUES (NULL, NULL, NULL)")]) {
    const expected = await raw([fence]);
    const got = await lib.runBatch(ctx, [insert("text/x"), fence], idem).then(() => null, (e) => e);
    assert.ok(got instanceof Error);
    assert.equal(got.message, expected.message);
    assert.equal(got.status, undefined, "raw error, not mapped to an HttpError");
  }
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM content_writes").get().n, 0);
  await lib.runBatch(ctx, [insert("text/dup")], idem);
  await assert.rejects(lib.runBatch(ctx, [insert("text/dup")], idem), (e) => e.status === 409 && e.code === "conflict");
});

test("commitTextWrites surfaces a key-fence refusal unchanged and leaves the text-write intent for the sweep", async () => {
  const { sql, DB, env } = mkDB();
  env.BLOBS = { async delete() { throw new Error("must not delete a refused write's object here"); } };
  sql.prepare("INSERT INTO content_writes (key, project_id, created_at) VALUES ('text/proj-a/a/r', 'proj-a', ?)").run(Date.now());
  const err = await lib.commitTextWrites(env, ["text/proj-a/a/r"], (guarded) => DB.batch(guarded([
    DB.prepare("INSERT INTO content_writes (key, project_id, created_at) VALUES ('text/should-rollback', 'proj-a', 1)"),
    lib.keyFence(env, { keyId: "wk_missing", workspaceId: "wsp_a" })
  ]))).then(() => null, (e) => e);
  assert.equal(err?.message, KEY_ACTIVE_MESSAGE);
  assert.equal(lib.isTextWriteFenceError(err), false);
  assert.equal(lib.fenceRefusal(err).code, "key_shredded");
  assert.deepEqual(sql.prepare("SELECT key FROM content_writes").all().map((r) => r.key), ["text/proj-a/a/r"]);
});
