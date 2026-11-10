import { test } from "node:test";
import assert from "node:assert/strict";
import { putText, getText, getTextRange } from "../packages/core/src/content-store.js";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./helpers.mjs";
import { loadWorker } from "./load-worker.mjs";
import { SERVER_PORTS } from "./ports.mjs";
import { commitTextWrites, isTextWriteFenceError } from "../packages/core/src/content-store.js";

async function harness() {
  const lib = await loadWorker({ "service.js": ["createMarkdown", "saveMarkdown", "getArtifact", "restoreRevision", "updateMetadata", "listArtifacts"], "reads/service.js": ["readTextChunk"], "uploads.js": ["serveContent"], "history/service.js": ["diffRevisions"], "backup.js": ["exportBackup", "restoreBackup"], "cleanup.js": ["reconcileUploads"], "adapters.js": ["withAdapters", "defaultAdapters"] });
  const sql = new DatabaseSync(":memory:");
  for (const f of readdirSync(join(ROOT, "migrations")).filter(f => f.endsWith(".sql")).sort()) sql.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  const stmt = (q, p = []) => ({ q, p, bind: (...p) => stmt(q, p), async first(c) { const r = sql.prepare(q).get(...p); return c ? r?.[c] ?? null : r ?? null; }, async all() { return { results: sql.prepare(q).all(...p) }; }, async run() { return { meta: { changes: sql.prepare(q).run(...p).changes } }; } });
  const DB = { prepare: q => stmt(q), async batch(stmts) { sql.exec("BEGIN"); try { const out = stmts.map(s => /^\s*(SELECT|WITH)/i.test(s.q) || /RETURNING/i.test(s.q) ? { results: sql.prepare(s.q).all(...s.p), meta: { changes: 0 } } : { meta: { changes: sql.prepare(s.q).run(...s.p).changes } }); sql.exec("COMMIT"); return out; } catch (e) { sql.exec("ROLLBACK"); throw e; } } };
  const objects = new Map();
  const BLOBS = { async put(k, b) { objects.set(k, new Uint8Array(b)); }, async delete(k) { objects.delete(k); }, async get(k, o) { let b = objects.get(k); if (!b) return null; if (o?.range) b = b.slice(o.range.offset, o.range.offset + o.range.length); return { async arrayBuffer() { return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } }; } };
  const env = lib.withAdapters({ DB, BLOBS }, lib.defaultAdapters());
  const at = new Date().toISOString();
  sql.prepare("INSERT INTO principals (id, kind, issuer, subject, label, created_at) VALUES ('hum_s','human','synthetic','s','Owner',?)").run(at);
  sql.prepare("INSERT INTO projects (id, owner_id, title, created_at) VALUES ('proj-s','hum_s','Synthetic',?)").run(at);
  const ctx = { env, requestId: "req_s", principal: { id: "hum_s", kind: "human", label: "Owner" } };
  return { lib, sql, ctx, env, objects };
}

test("R2 chunked reads match legacy UTF-8 bytes; legacy rows still diff, restore and export", async () => {
  const { lib, sql, ctx, env } = await harness();
  const body = "a".repeat(3567) + "é🙂\n".repeat(1800);
  const created = await lib.createMarkdown(ctx, "proj-s", { title: "Doc", body }, "create-read");
  const id = created.body.artifact_id;
  const original = sql.prepare("SELECT * FROM revisions WHERE artifact_id = ?").get(id);
  // Explicit legacy fixture, even after new writes switch to R2.
  sql.prepare("UPDATE revisions SET body = ?, body_key = NULL WHERE id = ?").run(body, original.id);
  const chunks = async () => { const out = []; let cursor; do { const r = await lib.readTextChunk(ctx, "proj-s", id, { maxBytes: 4096, cursor }); out.push(r.text); cursor = r.next_cursor; } while (cursor); return out; };
  const legacy = await chunks();
  const key = `text/proj-s/${id}/${original.id}`;
  await putText(env, { projectId: "proj-s" }, key, body);
  sql.prepare("UPDATE revisions SET body = NULL, body_key = ? WHERE id = ?").run(key, original.id);
  assert.deepEqual(await chunks(), legacy);
  assert.equal(legacy.join(""), body);
  const response = await lib.serveContent(ctx, new Request("https://example.test/content", { headers: { range: "bytes=3568-3572" } }), "proj-s", id);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new TextEncoder().encode(body).slice(3568, 3573));
  sql.prepare("UPDATE revisions SET body = ?, body_key = NULL WHERE id = ?").run(body, original.id);
  assert.equal((await lib.getArtifact(ctx, "proj-s", id)).body, body);
  await lib.saveMarkdown(ctx, "proj-s", id, { expected_revision: 1, body: "changed" }, "save-read");
  assert.equal((await lib.diffRevisions(ctx, "proj-s", id, 1, 2)).binary, false);
  await lib.restoreRevision(ctx, "proj-s", id, { from_revision: 1, expected_revision: 2 }, "restore-read");
  assert.equal((await lib.getArtifact(ctx, "proj-s", id)).body, body);
  assert.equal((await lib.exportBackup(ctx, "proj-s")).revisions.find(r => r.rev_no === 1).body, body);
});

test("text storage and legacy fallback preserve UTF-8 byte ranges", async () => {
  const objects = new Map();
  const env = { BLOBS: {
    async put(key, bytes) { objects.set(key, bytes); },
    async get(key, options) {
      let bytes = objects.get(key);
      if (!bytes) return null;
      if (options?.range) bytes = bytes.slice(options.range.offset, options.range.offset + options.range.length);
      return { async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); } };
    }
  } };
  const text = "aé🙂z", key = "text/p/a/r";
  const stored = await putText(env, { projectId: "p" }, key, text);
  assert.equal(stored.size, 8);
  assert.match(stored.sha256, /^[a-f0-9]{64}$/);
  assert.equal(await getText(env, { body_key: key, body: null }), text);
  assert.equal(await getText(env, { body: text }), text);
  for (let offset = 0; offset < 8; offset++) {
    assert.deepEqual(await getTextRange(env, { body_key: key }, offset, 2), await getTextRange(env, { body: text }, offset, 2));
  }
});

test("new saves store only R2 keys, conflicts leave no orphan, search and backups retain bodies", async () => {
  const { lib, sql, ctx, objects, env } = await harness();
  const c = await lib.createMarkdown(ctx, "proj-s", { title: "Plain title", body: "first" }, "create-r2");
  const id = c.body.artifact_id;
  await lib.saveMarkdown(ctx, "proj-s", id, { expected_revision: 1, body: "quasarneedle café🙂" }, "save-r2");
  const row = sql.prepare("SELECT * FROM revisions WHERE artifact_id = ? AND rev_no = 2").get(id);
  assert.equal(row.body, null);
  assert.equal(row.body_key, `text/proj-s/${id}/${row.id}`);
  assert.equal(new TextDecoder().decode(objects.get(row.body_key)), "quasarneedle café🙂");
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM artifact_search WHERE artifact_search MATCH 'quasarneedle'").get().n, 1);
  const before = [...objects.keys()].sort();
  await assert.rejects(lib.saveMarkdown(ctx, "proj-s", id, { expected_revision: 1, body: "loser" }, "conflict-r2"), e => e.code === "revision_conflict");
  const remove = env.BLOBS.delete;
  env.BLOBS.delete = async () => { throw new Error("synthetic delete outage"); };
  await assert.rejects(lib.saveMarkdown(ctx, "proj-s", id, { expected_revision: 1, body: "deferred loser" }, "deferred-conflict-r2"), e => e.code === "revision_conflict");
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM content_writes").get().n, 1);
  env.BLOBS.delete = remove;
  sql.exec("UPDATE content_writes SET created_at = 0");
  // Crash remnants: stale unreferenced intent is swept, but a referenced key must never be deleted.
  sql.prepare("INSERT INTO content_writes (key, project_id, created_at) VALUES (?, 'proj-s', 0)").run("text/proj-s/orphan/rev");
  objects.set("text/proj-s/orphan/rev", new TextEncoder().encode("orphan"));
  sql.prepare("INSERT INTO content_writes (key, project_id, created_at) VALUES (?, 'proj-s', 0)").run(row.body_key);
  await lib.reconcileUploads(env);
  assert.deepEqual([...objects.keys()].sort(), before);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM content_writes").get().n, 0);
  await lib.updateMetadata(ctx, "proj-s", id, { expected_meta_version: 1, title: "Renamed title" }, "rename-r2");
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM artifact_search WHERE artifact_search MATCH 'quasarneedle'").get().n, 1);
  await lib.updateMetadata(ctx, "proj-s", id, { expected_meta_version: 2, trashed: true }, "trash-r2");
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM artifact_search WHERE artifact_search MATCH 'quasarneedle'").get().n, 0);
  await lib.updateMetadata(ctx, "proj-s", id, { expected_meta_version: 3, trashed: false }, "untrash-r2");
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM artifact_search WHERE artifact_search MATCH 'quasarneedle'").get().n, 1);
  const backup = await lib.exportBackup(ctx, "proj-s");
  const other = await harness();
  other.sql.exec("DELETE FROM projects");
  await other.lib.restoreBackup(other.ctx, backup);
  assert.equal((await other.lib.getArtifact(other.ctx, "proj-s", id)).body, "quasarneedle café🙂");
  assert.deepEqual((await other.lib.exportBackup(other.ctx, "proj-s")).revisions, backup.revisions);
});

test("owner filter retains legacy body matching and is title-only for R2 text", async () => {
  const { lib, sql, ctx } = await harness();
  const legacy = await lib.createMarkdown(ctx, "proj-s", { title: "Legacy", body: "legacybodyword" }, "legacy-filter");
  sql.prepare("UPDATE revisions SET body = 'legacybodyword', body_key = NULL WHERE artifact_id = ?").run(legacy.body.artifact_id);
  await lib.createMarkdown(ctx, "proj-s", { title: "Titleneedle", body: "r2bodyword" }, "r2-filter");
  assert.equal((await lib.listArtifacts(ctx, "proj-s", { query: "legacybodyword" })).artifacts.length, 1);
  assert.equal((await lib.listArtifacts(ctx, "proj-s", { query: "r2bodyword" })).artifacts.length, 0);
  assert.equal((await lib.listArtifacts(ctx, "proj-s", { query: "Titleneedle" })).artifacts.length, 1);
});

test("chunked R2 reads recheck trash and version after the object await", async () => {
  const { lib, sql, ctx, env } = await harness();
  const c = await lib.createMarkdown(ctx, "proj-s", { title: "Fence", body: "fenced text" }, "fence-create");
  const id = c.body.artifact_id;
  const get = env.BLOBS.get;
  env.BLOBS.get = async (...args) => {
    const object = await get(...args);
    sql.prepare("UPDATE artifacts SET trashed_at = '2026-01-01' WHERE id = ?").run(id);
    return object;
  };
  await assert.rejects(lib.readTextChunk(ctx, "proj-s", id), e => e.status === 404);
  sql.prepare("UPDATE artifacts SET trashed_at = NULL WHERE id = ?").run(id);
  env.BLOBS.get = async (...args) => {
    const object = await get(...args);
    sql.prepare("UPDATE revisions SET sha256 = ? WHERE artifact_id = ?").run("0".repeat(64), id);
    return object;
  };
  await assert.rejects(lib.readTextChunk(ctx, "proj-s", id), e => e.code === "revision_changed");
  env.BLOBS.get = async (...args) => {
    const object = await get(...args);
    sql.exec("DELETE FROM workspace_members WHERE principal_id = 'hum_s'");
    return object;
  };
  await assert.rejects(lib.readTextChunk(ctx, "proj-s", id), e => e.status === 404);
});

test("expired or swept intents cannot publish, even after a successful put", async () => {
  for (const mode of ["expired", "swept"]) {
    const { lib, sql, ctx, env, objects } = await harness();
    const c = await lib.createMarkdown(ctx, "proj-s", { title: "Fence", body: "original" }, "deadline-create");
    const put = env.BLOBS.put;
    env.BLOBS.put = async (key, bytes) => {
      await put(key, bytes);
      if (mode === "expired") sql.prepare("UPDATE content_writes SET created_at = 0 WHERE key = ?").run(key);
      else sql.prepare("DELETE FROM content_writes WHERE key = ?").run(key);
    };
    await assert.rejects(lib.saveMarkdown(ctx, "proj-s", c.body.artifact_id, { expected_revision: 1, body: "too late" }, "deadline-save"), e => e.status === 503 && e.code === "text_write_expired");
    assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM revisions").get().n, 1);
    assert.equal(sql.prepare("SELECT head_rev FROM artifacts").get().head_rev, 1);
    assert.equal(objects.size, 1);
    assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM content_writes").get().n, 0);
  }
});

test("unknown batch errors retain bytes and intent until the reference-aware sweep", async () => {
  const { lib, sql, ctx, env, objects } = await harness();
  const batch = env.DB.batch;
  env.DB.batch = async () => { throw new Error("synthetic lost acknowledgement"); };
  await assert.rejects(lib.createMarkdown(ctx, "proj-s", { title: "Unknown", body: "retained" }, "unknown-create"), /lost acknowledgement/);
  assert.equal(objects.size, 1);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM content_writes").get().n, 1);
  env.DB.batch = batch;
  // A fresh intent is not stale, even if it is unreferenced.
  await lib.reconcileUploads(env);
  assert.equal(objects.size, 1);
  sql.exec("UPDATE content_writes SET created_at = 0");
  await lib.reconcileUploads(env);
  assert.equal(objects.size, 0);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM content_writes").get().n, 0);
});

test("publication fence matches real local D1 constraint text and rolls back a multi-key batch", async () => {
  const { Miniflare, convertV4MiniflareOptions } = await import("miniflare");
  const mf = new Miniflare(convertV4MiniflareOptions({ port: SERVER_PORTS["text-r2"], name: "text-r2", modules: true, script: "export default { fetch() { return new Response('test'); } }", compatibilityDate: "2026-10-24", d1Databases: { DB: "text-r2" } }));
  try {
    const DB = await mf.getD1Database("DB");
    await DB.prepare("CREATE TABLE content_writes (key TEXT PRIMARY KEY, project_id TEXT NOT NULL, created_at INTEGER NOT NULL)").run();
    await DB.prepare("CREATE TABLE revisions (body_key TEXT)").run();
    let raw;
    try { await DB.prepare("INSERT INTO content_writes (key, project_id, created_at) VALUES (NULL, NULL, NULL)").run(); } catch (error) { raw = error; }
    assert.match(raw.message, /NOT NULL constraint failed: content_writes\.project_id/);
    assert.ok(isTextWriteFenceError(raw));
    assert.equal(isTextWriteFenceError(new Error("NOT NULL constraint failed: artifacts.title")), false);
    assert.equal(isTextWriteFenceError(new Error("network timeout")), false);
    await DB.prepare("INSERT INTO content_writes (key, project_id, created_at) VALUES ('fresh', 'p', ?)").bind(Date.now()).run();
    const env = { DB, BLOBS: { async delete() {} } };
    await assert.rejects(commitTextWrites(env, ["fresh", "missing"], guarded => DB.batch(guarded([
      DB.prepare("INSERT INTO content_writes (key, project_id, created_at) VALUES ('should-rollback', 'p', 0)")
    ]))), e => e.status === 503 && e.code === "text_write_expired");
    assert.equal(await DB.prepare("SELECT COUNT(*) AS n FROM content_writes WHERE key = 'should-rollback'").first("n"), 0);
  } finally { await mf.dispose(); }
});
