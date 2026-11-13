import { test } from "node:test";
import assert from "node:assert/strict";
import { putText, getText, getTextRange, textKey } from "../packages/core/src/content-store.js";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./helpers.mjs";
import { loadWorker } from "./load-worker.mjs";
import { SERVER_PORTS } from "./ports.mjs";
import { MARKDOWN_PREVIEW_MAX_BYTES } from "../packages/core/src/text-limits.js";
import { commitTextWrites, isTextWriteFenceError } from "../packages/core/src/content-store.js";

async function harness() {
  const lib = await loadWorker({ "service.js": ["createMarkdown", "saveMarkdown", "getArtifact", "restoreRevision", "updateMetadata", "listArtifacts", "addComment", "listComments"], "reads/service.js": ["readTextChunk"], "uploads.js": ["serveContent"], "history/service.js": ["diffRevisions"], "backup.js": ["exportBackup", "restoreBackup", "importBackup"], "cleanup.js": ["reconcileUploads"], "project-deletion.js": ["purgeDueProjects"], "render-source.js": ["getRenderSource"], "content-store.js": ["stageTextWrites", "commitTextWrites"], "adapters.js": ["withAdapters", "defaultAdapters"] });
  const sql = new DatabaseSync(":memory:");
  for (const f of readdirSync(join(ROOT, "migrations")).filter(f => f.endsWith(".sql")).sort()) sql.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  const stmt = (q, p = []) => ({ q, p, bind: (...p) => stmt(q, p), async first(c) { const r = sql.prepare(q).get(...p); return c ? r?.[c] ?? null : r ?? null; }, async all() { return { results: sql.prepare(q).all(...p) }; }, async run() { return { meta: { changes: sql.prepare(q).run(...p).changes } }; } });
  const DB = { prepare: q => stmt(q), async batch(stmts) { sql.exec("BEGIN"); try { const out = stmts.map(s => /^\s*(SELECT|WITH)/i.test(s.q) || /RETURNING/i.test(s.q) ? { results: sql.prepare(s.q).all(...s.p), meta: { changes: 0 } } : { meta: { changes: sql.prepare(s.q).run(...s.p).changes } }); sql.exec("COMMIT"); return out; } catch (e) { sql.exec("ROLLBACK"); throw e; } } };
  const objects = new Map();
  const BLOBS = { async put(k, b) { objects.set(k, new Uint8Array(b)); }, async delete(k) { for (const key of Array.isArray(k) ? k : [k]) objects.delete(key); }, async get(k, o) { let b = objects.get(k); if (!b) return null; if (o?.range) b = b.slice(o.range.offset, o.range.offset + o.range.length); return { async arrayBuffer() { return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } }; } };
  const env = lib.withAdapters({ DB, BLOBS }, lib.defaultAdapters());
  const at = new Date().toISOString();
  sql.prepare("INSERT INTO principals (id, kind, issuer, subject, label, created_at) VALUES ('hum_s','human','synthetic','s','Owner',?)").run(at);
  sql.prepare("INSERT INTO projects (id, owner_id, title, created_at) VALUES ('proj-s','hum_s','Synthetic',?)").run(at);
  const ctx = { env, requestId: "req_s", principal: { id: "hum_s", kind: "human", label: "Owner" } };
  return { lib, sql, ctx, env, objects };
}

test("search bridge caps UTF-8 at 1 MiB on real local D1 (known suffix search gap)", async () => {
  const { Miniflare, convertV4MiniflareOptions } = await import("miniflare");
  const mf = new Miniflare(convertV4MiniflareOptions({ port: SERVER_PORTS["text-r2"], name: "bridge-bound", modules: true, script: "export default { fetch() { return new Response('test'); } }", compatibilityDate: "2026-10-24", d1Databases: { DB: "bridge-bound" } }));
  try {
    const DB = await mf.getD1Database("DB");
    await DB.batch([
      DB.prepare("CREATE TABLE artifact_search (rowid INTEGER PRIMARY KEY, body TEXT, revision_id TEXT)"),
      DB.prepare("CREATE TABLE artifact_search_keys (artifact_id TEXT, search_id INTEGER)"),
      DB.prepare("CREATE TABLE artifacts (id TEXT, head_revision_id TEXT)"),
      DB.prepare("INSERT INTO artifact_search (rowid, body, revision_id) VALUES (1, '', 'r')"),
      DB.prepare("INSERT INTO artifact_search_keys (artifact_id, search_id) VALUES ('a', 1)"),
      DB.prepare("INSERT INTO artifacts (id, head_revision_id) VALUES ('a', 'r')")
    ]);
    const lib = await loadWorker({ "search/service.js": ["textSearchBridge"] });
    const prefix = "firstneedle " + "a".repeat(1048576 - 14);
    await lib.textSearchBridge({ DB }, "a", "r", prefix + "🙂 suffixneedle " + "z".repeat(3 * 1048576)).run();
    const stored = await DB.prepare("SELECT body FROM artifact_search").first("body");
    assert.equal(stored, prefix);
    assert.ok(Buffer.byteLength(stored) <= 1048576);
    assert.ok(!stored.includes("\ufffd"));
  } finally { await mf.dispose(); }
});

test("backup text export refuses over 32 MiB before any object read and allows the boundary", async () => {
  const h = await harness();
  const body = "synthetic ".repeat(Math.ceil(8 * 1048576 / 10)).slice(0, 8 * 1048576);
  const made = await h.lib.createMarkdown(h.ctx, "proj-s", { title: "Export cap", body }, "export-cap");
  const id = made.body.artifact_id;
  for (let rev = 1; rev < 4; rev++) await h.lib.saveMarkdown(h.ctx, "proj-s", id, { expected_revision: rev, body }, `export-cap-${rev}`);
  const counts = spyBindings(h.env);
  const backup = await h.lib.exportBackup(h.ctx, "proj-s");
  assert.equal(backup.revisions.reduce((n, r) => n + Buffer.byteLength(r.body), 0), 32 * 1048576);
  assert.equal(counts.gets, 4);
  counts.gets = 0;
  await h.lib.saveMarkdown(h.ctx, "proj-s", id, { expected_revision: 4, body: "x" }, "export-cap-over");
  await assert.rejects(h.lib.exportBackup(h.ctx, "proj-s"), e => e.status === 413 && e.code === "backup_too_large" && /32 MiB/.test(e.message));
  assert.equal(counts.gets, 0);
});

test("comments publish immutable UTF-8 objects, replay without another put, and retain the length limit", async () => {
  const { lib, ctx, sql, objects, env } = await harness();
  const created = await lib.createMarkdown(ctx, "proj-s", { title: "Comments", body: "document" }, "comments-create");
  const aid = created.body.artifact_id, input = { revision: 1, body: "café 🙂 漢字" };
  const counts = spyBindings(env);
  const result = await lib.addComment(ctx, "proj-s", aid, input, "comment-one");
  const row = sql.prepare("SELECT * FROM comments").get();
  assert.equal(row.body, "");
  assert.equal(row.body_key, textKey("proj-s", aid, result.body.comment_id));
  assert.equal(new TextDecoder().decode(objects.get(row.body_key)), input.body);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM content_writes").get().n, 0);
  const replay = await lib.addComment(ctx, "proj-s", aid, input, "comment-one");
  assert.deepEqual(replay.body, { ...result.body, idempotent_replay: true });
  assert.equal(counts.puts, 1);
  assert.equal(objects.size, 2);
  await assert.rejects(lib.addComment(ctx, "proj-s", aid, { revision: 1, body: "x".repeat(10001) }, "too-long"), e => e.status === 413);
});

test("comment pages preserve mixed legacy and R2 bodies, order and cursors with bounded reads", async () => {
  const { lib, ctx, sql, objects, env } = await harness();
  const created = await lib.createMarkdown(ctx, "proj-s", { title: "Pages", body: "document" }, "pages-create");
  const aid = created.body.artifact_id, expected = [];
  for (let i = 0; i < 405; i++) {
    const id = `cmt_${String(i).padStart(4, "0")}`, body = `comment ${i} café🙂`;
    const key = i % 2 ? textKey("proj-s", aid, id) : null;
    if (key) objects.set(key, new TextEncoder().encode(body));
    sql.prepare("INSERT INTO comments (id, project_id, artifact_id, rev_no, author_id, body, body_key, created_at) VALUES (?, 'proj-s', ?, 1, 'hum_s', ?, ?, '2026-01-01')").run(id, aid, key ? "" : body, key);
    expected.push({ id, revision: 1, body, created_at: "2026-01-01", author: "Owner" });
  }
  const counts = spyBindings(env);
  let cursor, end = expected.length;
  do {
    const page = await lib.listComments(ctx, "proj-s", aid, cursor);
    const start = Math.max(0, end - 200);
    assert.deepEqual(page.comments, expected.slice(start, end));
    const wantedCursor = start ? Buffer.from(JSON.stringify(["2026-01-01", expected[start].id])).toString("base64url") : null;
    assert.equal(page.next_cursor, wantedCursor);
    cursor = page.next_cursor; end = start;
  } while (cursor);
  assert.equal(counts.gets, 202);
  assert.ok(counts.maxInFlight > 1 && counts.maxInFlight <= 6);
});

test("refused or expired comment publication leaves no objects or intents; sweep keeps referenced comments", async () => {
  for (const mode of ["missing-revision", "lost-access", "expired"]) {
    const { lib, ctx, sql, env, objects } = await harness();
    const c = await lib.createMarkdown(ctx, "proj-s", { title: "Refusal", body: "document" }, "refusal-create");
    const put = env.BLOBS.put;
    env.BLOBS.put = async (...args) => {
      await put(...args);
      if (mode === "lost-access") sql.exec("DELETE FROM workspace_members WHERE principal_id = 'hum_s'");
      if (mode === "expired") sql.exec("UPDATE content_writes SET created_at = 0");
    };
    await assert.rejects(lib.addComment(ctx, "proj-s", c.body.artifact_id, { revision: mode === "missing-revision" ? 99 : 1, body: "refused" }, "refused-comment"), e => e.status === (mode === "expired" ? 503 : 404));
    assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM comments").get().n, 0);
    assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM content_writes").get().n, 0);
    assert.equal(objects.size, 1);
  }
  const { lib, ctx, sql, objects, env } = await harness();
  const c = await lib.createMarkdown(ctx, "proj-s", { title: "Sweep", body: "document" }, "sweep-create");
  await lib.addComment(ctx, "proj-s", c.body.artifact_id, { revision: 1, body: "keep comment" }, "sweep-comment");
  const key = sql.prepare("SELECT body_key FROM comments").get().body_key;
  sql.prepare("INSERT INTO content_writes (key, project_id, created_at) VALUES (?, 'proj-s', 0)").run(key);
  await lib.reconcileUploads(env);
  assert.equal(new TextDecoder().decode(objects.get(key)), "keep comment");
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM content_writes").get().n, 0);
});

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

test("large Markdown rendering only reads a 256 KiB range and resolves references from that prefix", async () => {
  const { lib, ctx, env } = await harness();
  const prefix = "# early\n" + "word ".repeat(209720);
  const c = await lib.createMarkdown(ctx, "proj-s", { title: "Bounded preview", body: prefix + "\n![late](art_late)" + " word".repeat(1800000) }, "render-range");
  const reads = [], get = env.BLOBS.get;
  env.BLOBS.get = async (...args) => { reads.push(args); return get(...args); };
  const r = await lib.getRenderSource(ctx, "proj-s", c.body.artifact_id, undefined, "markdown");
  assert.equal(r.truncated, true);
  assert.deepEqual(reads.map(args => args[1]), [{ range: { offset: 0, length: MARKDOWN_PREVIEW_MAX_BYTES } }]);
  assert.ok(Buffer.byteLength(r.body) <= MARKDOWN_PREVIEW_MAX_BYTES);
  assert.doesNotMatch(r.body, /art_late/);
});

test("render-only reads preserve legacy inline versions and recheck access after R2", async () => {
  const { lib, ctx, env, sql } = await harness();
  const c = await lib.createMarkdown(ctx, "proj-s", { title: "Legacy preview", body: "# café 🙂" }, "legacy-render");
  const id = c.body.artifact_id;
  sql.prepare("UPDATE revisions SET body = ?, body_key = NULL WHERE artifact_id = ?").run("# café 🙂", id);
  const counts = spyBindings(env);
  const legacy = await lib.getRenderSource(ctx, "proj-s", id, 1, "markdown");
  assert.equal(legacy.body, "# café 🙂"); assert.equal(legacy.truncated, false); assert.equal(counts.gets, 0);
  await lib.saveMarkdown(ctx, "proj-s", id, { expected_revision: 1, body: "# R2" }, "fenced-render");
  const get = env.BLOBS.get;
  env.BLOBS.get = async (...args) => { const object = await get(...args); sql.exec("DELETE FROM workspace_members WHERE principal_id = 'hum_s'"); return object; };
  await assert.rejects(lib.getRenderSource(ctx, "proj-s", id, 2, "markdown"), e => e.status === 404);
});

test("oversized HTML rendering refuses before any object read", async () => {
  const { lib, ctx, env } = await harness();
  const c = await lib.createMarkdown(ctx, "proj-s", { title: "Large page", body: " ".repeat(1048577) }, "render-html", "html");
  const counts = spyBindings(env);
  await assert.rejects(lib.getRenderSource(ctx, "proj-s", c.body.artifact_id, undefined, "html"), e => e.status === 413 && e.code === "render_too_large");
  assert.equal(counts.gets, 0);
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

test("owner filter is title-only for legacy inline and R2 text", async () => {
  const { lib, sql, ctx } = await harness();
  const legacy = await lib.createMarkdown(ctx, "proj-s", { title: "Legacy", body: "legacybodyword" }, "legacy-filter");
  sql.prepare("UPDATE revisions SET body = 'legacybodyword', body_key = NULL WHERE artifact_id = ?").run(legacy.body.artifact_id);
  await lib.createMarkdown(ctx, "proj-s", { title: "Titleneedle", body: "r2bodyword" }, "r2-filter");
  assert.equal((await lib.listArtifacts(ctx, "proj-s", { query: "legacybodyword" })).artifacts.length, 0);
  assert.equal((await lib.listArtifacts(ctx, "proj-s", { query: "Legacy" })).artifacts.length, 1);
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

test("chunked R2 reads recheck expiration against the time after the object await", async () => {
  const { lib, sql, ctx, env } = await harness();
  const c = await lib.createMarkdown(ctx, "proj-s", { title: "Expiration", body: "private text" }, "expire-create");
  const realNow = Date.now;
  let clock = realNow();
  const at = new Date(clock).toISOString();
  sql.prepare("INSERT INTO principals (id, kind, issuer, subject, label, created_at) VALUES ('ag','agent','synthetic','ag','Agent',?)").run(at);
  sql.prepare("INSERT INTO grants (id, project_id, principal_id, token_hash, can_write, expires_at, created_by, created_at) VALUES ('g','proj-s','ag','synthetic-hash',0,?,'hum_s',?)").run(clock + 1000, at);
  const agent = { ...ctx, principal: { id: "ag", kind: "agent" }, grant: { id: "g", project_id: "proj-s", can_write: 0 } };
  const get = env.BLOBS.get;
  env.BLOBS.get = async (...args) => { const object = await get(...args); clock += 2000; return object; };
  Date.now = () => clock;
  try { await assert.rejects(lib.readTextChunk(agent, "proj-s", c.body.artifact_id), e => e.status === 404); }
  finally { Date.now = realNow; }
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
    await DB.prepare("CREATE TABLE comments (body TEXT)").run();
    // Apply the actual migration's index statements through local D1, not a simulated planner.
    const migration = readFileSync(join(ROOT, "migrations/0028_text_in_r2.sql"), "utf8");
    for (const table of ["revisions", "comments"]) {
      if (table === "comments") await DB.prepare("ALTER TABLE comments ADD COLUMN body_key TEXT").run();
      const index = migration.split(";").find(s => s.includes(`CREATE INDEX IF NOT EXISTS ${table}_body_key`));
      assert.ok(index, `${table} body_key index is in migration 0028`);
      await DB.prepare(index).run();
      const plan = await DB.prepare(`EXPLAIN QUERY PLAN SELECT 1 FROM ${table} WHERE body_key = ? LIMIT 1`).bind("text/p/a/r").all();
      assert.match(plan.results.map(r => r.detail).join("\n"), new RegExp(`USING (?:COVERING )?INDEX ${table}_body_key`));
    }
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

test("real D1 purge key query bounds all six key sources within the global blob budget", async () => {
  const { Miniflare, convertV4MiniflareOptions } = await import("miniflare");
  const mf = new Miniflare(convertV4MiniflareOptions({ port: SERVER_PORTS["text-r2"], name: "purge-keys", modules: true, script: "export default { fetch() { return new Response('test'); } }", compatibilityDate: "2026-10-24", d1Databases: { DB: "purge-keys" } }));
  try {
    const DB = await mf.getD1Database("DB");
    await DB.batch([
      DB.prepare("CREATE TABLE projects (id TEXT PRIMARY KEY, deleted_at INTEGER, purged_at INTEGER, purge_at INTEGER)"),
      DB.prepare("CREATE TABLE revisions (project_id TEXT, blob_key TEXT, body_key TEXT)"),
      DB.prepare("CREATE TABLE comments (project_id TEXT, body_key TEXT)"),
      DB.prepare("CREATE TABLE content_writes (key TEXT PRIMARY KEY, project_id TEXT, created_at INTEGER)"),
      DB.prepare("CREATE TABLE uploads (project_id TEXT, staging_key TEXT, final_key TEXT, staging_purged_at INTEGER, final_purged_at INTEGER, finalize_until INTEGER, final_writes INTEGER, state TEXT, expires_at INTEGER)"),
      DB.prepare("INSERT INTO projects (id, deleted_at, purge_at) VALUES ('p', 1, 1)"),
      DB.prepare("INSERT INTO revisions (project_id, blob_key, body_key) VALUES ('p', 'blobs/p/a/r', 'text/p/a/rev')"),
      DB.prepare("INSERT INTO comments (project_id, body_key) VALUES ('p', 'text/p/a/cmt')"),
      DB.prepare("INSERT INTO content_writes (key, project_id, created_at) VALUES ('text/p/a/intent', 'p', 0)"),
      DB.prepare("INSERT INTO uploads (project_id, staging_key, final_key, finalize_until, final_writes, state, expires_at) VALUES ('p', 'staging/p/u', 'blobs/p/a/u', 0, 0, 'done', 0)")
    ]);
    const objects = new Set(["blobs/p/a/r", "text/p/a/rev", "text/p/a/cmt", "text/p/a/intent", "staging/p/u", "blobs/p/a/u"]);
    const deleted = [];
    const env = { DB, BLOBS: { async delete(key) { assert.ok(objects.delete(key), `only delete a referenced object once: ${key}`); deleted.push(key); } } };
    const lib = await loadWorker({ "project-deletion.js": ["purgeDueProjects"] });
    for (let i = 0; i < 3; i++) {
      const result = await lib.purgeDueProjects(env, { projectId: "p", rowBudget: 0, blobBudget: 2 });
      assert.equal(result.files, 2);
      assert.equal(deleted.length, (i + 1) * 2);
      assert.equal(objects.size, 6 - deleted.length);
    }
    assert.equal(await DB.prepare("SELECT body_key FROM comments").first("body_key"), null);
    assert.equal(await DB.prepare("SELECT COUNT(*) AS n FROM content_writes").first("n"), 0);
  } finally { await mf.dispose(); }
});

test("restore preserves unusual legacy IDs without aliasing text keys and refuses oversized keys before writing", async () => {
  const source = await harness();
  await source.lib.createMarkdown(source.ctx, "proj-s", { title: "First", body: "first distinct body" }, "key-first");
  await source.lib.createMarkdown(source.ctx, "proj-s", { title: "Second", body: "second distinct body" }, "key-second");
  const backup = await source.lib.exportBackup(source.ctx, "proj-s");
  const pairs = [["a/b", "c"], ["a", "b/c"]];
  for (let i = 0; i < pairs.length; i++) {
    const artifact = backup.artifacts[i], oldId = artifact.id;
    const revision = backup.revisions.find(r => r.artifact_id === oldId);
    [artifact.id, artifact.head_revision_id] = pairs[i];
    [revision.artifact_id, revision.id] = pairs[i];
  }
  const target = await harness();
  target.sql.exec("DELETE FROM projects");
  await target.lib.restoreBackup(target.ctx, backup);
  assert.equal(target.objects.size, 2);
  const keys = [...target.objects.keys()].sort();
  assert.match(keys[0], /^text\/proj-s\/a%2Fb\/c\/[^/]+$/);
  assert.match(keys[1], /^text\/proj-s\/a\/b%2Fc\/[^/]+$/);
  assert.equal(keys[0].split("/").at(-1), keys[1].split("/").at(-1));
  const roundTrip = await harness();
  roundTrip.sql.exec("DELETE FROM projects");
  await roundTrip.lib.restoreBackup(roundTrip.ctx, await target.lib.exportBackup(target.ctx, "proj-s"));
  assert.deepEqual((await roundTrip.lib.exportBackup(roundTrip.ctx, "proj-s")).revisions, backup.revisions);
  for (const revision of backup.revisions) assert.equal((await target.lib.getArtifact(target.ctx, "proj-s", revision.artifact_id)).body, revision.body);
  const tooLong = structuredClone(backup);
  // The three-segment form fits exactly; restore's attempt suffix must be included in preflight.
  tooLong.revisions[1].id = "x".repeat(1024 - new TextEncoder().encode(textKey("proj-s", tooLong.revisions[1].artifact_id, "")).length);
  assert.equal(new TextEncoder().encode(textKey("proj-s", tooLong.revisions[1].artifact_id, tooLong.revisions[1].id)).length, 1024);
  const empty = await harness();
  empty.sql.exec("DELETE FROM projects");
  await assert.rejects(empty.lib.restoreBackup(empty.ctx, tooLong), e => e.status === 400 && e.code === "bad_backup");
  assert.equal(empty.objects.size, 0);
  assert.equal(empty.sql.prepare("SELECT COUNT(*) AS n FROM content_writes").get().n, 0);
});

function spyBindings(env) {
  const counts = { db: 0, puts: 0, gets: 0, deletes: 0, inFlight: 0, maxInFlight: 0 };
  const prepare = env.DB.prepare;
  const wrap = statement => new Proxy(statement, { get(target, prop) {
    if (prop === "bind") return (...args) => wrap(target.bind(...args));
    if (["first", "all", "run"].includes(prop)) return (...args) => { counts.db++; return target[prop](...args); };
    return target[prop];
  } });
  env.DB.prepare = (...args) => wrap(prepare(...args));
  const batch = env.DB.batch;
  env.DB.batch = async statements => { counts.db++; return batch(statements); };
  for (const method of ["put", "get", "delete"]) {
    const original = env.BLOBS[method];
    env.BLOBS[method] = async (...args) => {
      counts[method === "delete" ? "deletes" : `${method}s`]++;
      counts.maxInFlight = Math.max(counts.maxInFlight, ++counts.inFlight);
      try { await new Promise(resolve => setImmediate(resolve)); return await original(...args); }
      finally { counts.inFlight--; }
    };
  }
  return counts;
}

async function bulkBackup(n = 250) {
  const backup = await twoVersionBackup();
  const revision = backup.revisions[0];
  backup.revisions = await Promise.all(Array.from({ length: n }, async (_, i) => {
    const body = `version ${i + 1} café🙂`;
    return { ...revision, id: `bulk-rev-${i + 1}`, rev_no: i + 1, body, size: new TextEncoder().encode(body).length,
      sha256: Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))).toString("hex") };
  }));
  backup.artifacts[0].head_rev = n;
  backup.artifacts[0].head_revision_id = backup.revisions.at(-1).id;
  return backup;
}

test("250-version import batches intents, bounds object concurrency and exports every body", async t => {
  const backup = await bulkBackup();
  const target = await harness();
  const counts = spyBindings(target.env);
  const batch = target.env.DB.batch;
  let beforePublish;
  target.env.DB.batch = async statements => {
    if (statements.some(s => /INSERT INTO revisions/.test(s.q))) beforePublish = counts.db;
    return batch(statements);
  };
  const result = await target.lib.importBackup(target.ctx, "wsp_hum_s", { backup }, "bulk-import");
  assert.equal(counts.puts, 250);
  assert.ok(beforePublish <= 10, `D1 calls before publication: ${beforePublish}`);
  assert.ok(counts.maxInFlight <= 6, `object concurrency: ${counts.maxInFlight}`);
  assert.ok(counts.maxInFlight > 1, "multi-key puts run concurrently");
  assert.equal(target.sql.prepare("SELECT COUNT(*) AS n FROM content_writes").get().n, 0);
  const putMaxInFlight = counts.maxInFlight;
  counts.maxInFlight = 0;
  const exported = await target.lib.exportBackup(target.ctx, result.project_id);
  assert.equal(counts.gets, 250);
  assert.ok(counts.maxInFlight <= 6, `export concurrency: ${counts.maxInFlight}`);
  assert.deepEqual(exported.revisions.sort((a,b) => a.rev_no - b.rev_no).map(r => r.body), backup.revisions.map(r => r.body));
  t.diagnostic(JSON.stringify({ beforePublish, puts: counts.puts, putMaxInFlight, exportGets: counts.gets, exportMaxInFlight: counts.maxInFlight }));
});

test("settled failed 250-key publication cleans objects and intents with bounded calls", async t => {
  const backup = await bulkBackup();
  const target = await harness();
  const counts = spyBindings(target.env);
  const batch = target.env.DB.batch;
  let atFailure;
  target.env.DB.batch = async statements => {
    if (statements.some(s => /INSERT INTO revisions/.test(s.q))) {
      target.sql.exec("UPDATE content_writes SET created_at = 0");
      atFailure = counts.db;
    }
    return batch(statements);
  };
  await assert.rejects(target.lib.importBackup(target.ctx, "wsp_hum_s", { backup }, "bulk-expire"), e => e.code === "text_write_expired");
  assert.equal(counts.puts, 250);
  assert.ok(counts.db - atFailure <= 3, `failed batch plus cleanup D1 calls: ${counts.db - atFailure}`);
  assert.equal(counts.deletes, 1);
  assert.equal(target.objects.size, 0);
  assert.equal(target.sql.prepare("SELECT COUNT(*) AS n FROM content_writes").get().n, 0);
  t.diagnostic(JSON.stringify({ failedBatchAndCleanupDb: counts.db - atFailure, objectDeletes: counts.deletes }));
});

test("multi-key staging inserts only each current chunk and waits for in-flight puts on failure", async () => {
  const target = await harness();
  const writes = Array.from({ length: 250 }, (_, i) => ({ projectId: "proj-s", artifactId: "chunk", revisionId: `r${i}`, text: `body ${i}` }));
  const batch = target.env.DB.batch;
  const sizes = [];
  target.env.DB.batch = async statements => { sizes.push(statements.length); return batch(statements); };
  const put = target.env.BLOBS.put;
  const stagedAtPut = [];
  target.env.BLOBS.put = async (key, bytes) => {
    const i = Number(key.split("/").at(-1).slice(1));
    assert.equal(target.sql.prepare("SELECT COUNT(*) AS n FROM content_writes").get().n, Math.min(250, (Math.floor(i / 100) + 1) * 100));
    if (i % 100 === 0) stagedAtPut.push(i);
    return put(key, bytes);
  };
  await target.lib.stageTextWrites(target.env, writes);
  assert.deepEqual(sizes, [100, 100, 50]);
  assert.deepEqual(stagedAtPut, [0, 100, 200]);
  const failed = await harness();
  let inFlight = 0;
  failed.env.BLOBS.put = async key => {
    inFlight++;
    try {
      if (key.endsWith("/r1")) throw new Error("synthetic chunk failure");
      await new Promise(resolve => setImmediate(resolve));
    } finally { inFlight--; }
  };
  await assert.rejects(failed.lib.stageTextWrites(failed.env, writes), /chunk failure/);
  assert.equal(inFlight, 0);
  assert.equal(failed.sql.prepare("SELECT COUNT(*) AS n FROM content_writes").get().n, 100);
});

test("bulk disposal splits R2 deletes at 1000 and retains referenced text and intents on delete failure", async () => {
  const target = await harness();
  const created = await target.lib.createMarkdown(target.ctx, "proj-s", { title: "Referenced", body: "keep" }, "bulk-keep");
  const referenced = target.sql.prepare("SELECT body_key FROM revisions").get().body_key;
  const commentKey = "text/proj-s/comment/key";
  target.sql.prepare("INSERT INTO comments (id, project_id, artifact_id, rev_no, author_id, body, body_key, created_at) VALUES ('comment', 'proj-s', ?, 1, 'hum_s', 'synthetic comment', ?, ?)").run(created.body.artifact_id, commentKey, new Date().toISOString());
  const keys = Array.from({ length: 2005 }, (_, i) => `text/proj-s/dispose/r${i}`);
  for (const key of [...keys, referenced, commentKey]) {
    target.sql.prepare("INSERT INTO content_writes (key, project_id, created_at) VALUES (?, 'proj-s', ?)").run(key, Date.now());
    if (!target.objects.has(key)) target.objects.set(key, new TextEncoder().encode("synthetic"));
  }
  const remove = target.env.BLOBS.delete, sizes = [];
  target.env.BLOBS.delete = async keys => { sizes.push(keys.length); return remove(keys); };
  await target.lib.commitTextWrites(target.env, [...keys, referenced, commentKey], async () => []);
  assert.deepEqual(sizes, [1000, 1000, 5]);
  assert.equal(target.objects.size, 2);
  assert.ok(target.objects.has(referenced));
  assert.ok(target.objects.has(commentKey));
  assert.equal(target.sql.prepare("SELECT COUNT(*) AS n FROM content_writes").get().n, 2);
  const key = keys[0];
  target.sql.prepare("INSERT INTO content_writes (key, project_id, created_at) VALUES (?, 'proj-s', ?)").run(key, Date.now());
  target.objects.set(key, new TextEncoder().encode("retry later"));
  target.env.BLOBS.delete = async () => { throw new Error("synthetic bulk delete failure"); };
  await target.lib.commitTextWrites(target.env, [key], async () => []);
  assert.ok(target.objects.has(key));
  assert.ok(target.sql.prepare("SELECT 1 FROM content_writes WHERE key = ?").get(key));
});

test("comment backups keep their JSON shape and restore/import old inline and new R2 sources", async () => {
  for (const legacy of [true, false]) {
    const source = await harness();
    const c = await source.lib.createMarkdown(source.ctx, "proj-s", { title: "Backup comments", body: "document" }, "backup-create");
    await source.lib.addComment(source.ctx, "proj-s", c.body.artifact_id, { revision: 1, body: "backup comment café🙂" }, "backup-comment");
    if (legacy) source.sql.exec("UPDATE comments SET body = 'backup comment café🙂', body_key = NULL");
    const backup = await source.lib.exportBackup(source.ctx, "proj-s");
    assert.deepEqual(Object.keys(backup.comments[0]).sort(), ["id", "artifact_id", "rev_no", "author_id", "body", "created_at"].sort());
    assert.equal(backup.comments[0].body, "backup comment café🙂");
    for (const operation of ["restore", "import"]) {
      const target = await harness();
      let pid = "proj-s";
      if (operation === "restore") {
        target.sql.exec("DELETE FROM projects");
        await target.lib.restoreBackup(target.ctx, backup);
      } else {
        pid = (await target.lib.importBackup(target.ctx, "wsp_hum_s", { backup }, `comment-import-${legacy}`)).project_id;
      }
      const row = target.sql.prepare("SELECT * FROM comments WHERE project_id = ?").get(pid);
      assert.equal(row.body, "");
      assert.equal(new TextDecoder().decode(target.objects.get(row.body_key)), backup.comments[0].body);
      assert.equal(row.body_key.split("/").length, operation === "restore" ? 5 : 4);
      assert.equal(target.sql.prepare("SELECT COUNT(*) AS n FROM content_writes").get().n, 0);
      const exported = await target.lib.exportBackup(target.ctx, pid);
      assert.equal(exported.comments[0].body, backup.comments[0].body);
      if (operation === "restore") assert.deepEqual(exported.comments, backup.comments);
      assert.equal((await target.lib.listComments(target.ctx, pid, row.artifact_id)).comments[0].body, backup.comments[0].body);
    }
  }
});

test("project purge deletes referenced comment objects before deleting comment rows", async () => {
  const target = await harness();
  const c = await target.lib.createMarkdown(target.ctx, "proj-s", { title: "Purge", body: "document" }, "purge-create");
  await target.lib.addComment(target.ctx, "proj-s", c.body.artifact_id, { revision: 1, body: "purge comment" }, "purge-comment");
  target.sql.exec("UPDATE projects SET deleted_at = 1, purge_at = 1");
  await target.lib.purgeDueProjects(target.env, { projectId: "proj-s", rowBudget: 0, blobBudget: 10 });
  assert.equal(target.objects.size, 0);
  assert.equal(target.sql.prepare("SELECT body_key FROM comments").get().body_key, null);
});

async function twoVersionBackup(withComments = false) {
  const source = await harness();
  const created = await source.lib.createMarkdown(source.ctx, "proj-s", { title: "Retry", body: "first café" }, "retry-create");
  await source.lib.saveMarkdown(source.ctx, "proj-s", created.body.artifact_id, { expected_revision: 1, body: "second 🙂" }, "retry-save");
  if (withComments) await source.lib.addComment(source.ctx, "proj-s", created.body.artifact_id, { revision: 2, body: "retry comment café🙂" }, "retry-comment");
  return source.lib.exportBackup(source.ctx, "proj-s");
}

test("failed restore retries immediately with distinct immutable keys and every version intact", async () => {
  const backup = await twoVersionBackup(true);
  const target = await harness();
  target.sql.exec("DELETE FROM projects");
  const put = target.env.BLOBS.put;
  let calls = 0;
  target.env.BLOBS.put = async (...args) => { if (++calls === 2) throw new Error("synthetic midway outage"); return put(...args); };
  await assert.rejects(target.lib.restoreBackup(target.ctx, backup), /midway outage/);
  const abandoned = [...target.objects.keys()];
  target.env.BLOBS.put = put;
  await target.lib.restoreBackup(target.ctx, backup);
  const exported = await target.lib.exportBackup(target.ctx, "proj-s");
  assert.deepEqual(exported.revisions, backup.revisions);
  assert.deepEqual(exported.comments, backup.comments);
  for (const r of target.sql.prepare("SELECT body_key FROM revisions UNION ALL SELECT body_key FROM comments").all()) assert.ok(!abandoned.includes(r.body_key));
});

test("concurrent restores publish once and refuse the loser cleanly without overwriting bytes", async () => {
  const backup = await twoVersionBackup();
  const target = await harness();
  target.sql.exec("DELETE FROM projects");
  const put = target.env.BLOBS.put;
  target.env.BLOBS.put = async (...args) => { await new Promise(resolve => setImmediate(resolve)); return put(...args); };
  const outcomes = await Promise.allSettled([target.lib.restoreBackup(target.ctx, backup), target.lib.restoreBackup(target.ctx, backup)]);
  assert.equal(outcomes.filter(r => r.status === "fulfilled").length, 1);
  const loser = outcomes.find(r => r.status === "rejected");
  assert.equal(loser.reason.status, 409);
  assert.equal(loser.reason.code, "store_not_empty");
  assert.equal(target.sql.prepare("SELECT COUNT(*) AS n FROM projects").get().n, 1);
  for (const r of target.sql.prepare("SELECT body_key, sha256 FROM revisions").all()) {
    const hash = Buffer.from(await crypto.subtle.digest("SHA-256", target.objects.get(r.body_key))).toString("hex");
    assert.equal(hash, r.sha256);
  }
  assert.deepEqual((await target.lib.exportBackup(target.ctx, "proj-s")).revisions, backup.revisions);
});

test("a missing text object is 500 blob_missing for a document read, a chunked read and a Range read", async () => {
  const h = await harness();
  const made = await h.lib.createMarkdown(h.ctx, "proj-s", { title: "Gone", body: "soon gone words" }, "missing-1");
  const id = made.body.artifact_id;
  const key = h.sql.prepare("SELECT body_key FROM revisions WHERE artifact_id = ?").get(id).body_key;
  h.objects.delete(key);
  const blobMissing = (e) => e.status === 500 && e.code === "blob_missing";
  await assert.rejects(h.lib.getArtifact(h.ctx, "proj-s", id), blobMissing);
  await assert.rejects(h.lib.readTextChunk(h.ctx, "proj-s", id, { maxBytes: 4096 }), blobMissing);
  await assert.rejects(h.lib.serveContent(h.ctx, new Request("https://example.test/content", { headers: { range: "bytes=0-1" } }), "proj-s", id), blobMissing);
});

test("restore refuses a lone-surrogate document, version or comment id with 400 bad_backup before any write; import still succeeds", async () => {
  const at = "2026-01-01T00:00:00.000Z", body = "synthetic words";
  const sha256 = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))).toString("hex");
  const fixture = ({ id, rev = "rev_s_0001", ref = id, cmt, cref = id }) => ({
    schema: "agent-library-backup/1", exported_at: at, project: { id: "src-proj", title: "Synthetic", created_at: at },
    artifacts: [{ id, kind: "markdown", title: "Synthetic", folder: "", tags: "[]", head_rev: 1, head_revision_id: rev, meta_version: 1, trashed_at: null, created_at: at, updated_at: at }],
    revisions: [{ id: rev, artifact_id: ref, rev_no: 1, author_id: "hum_s", body, blob_key: null, size: Buffer.byteLength(body), sha256, mime: "text/markdown", restored_from: null, created_at: at }],
    comments: cmt === undefined ? [] : [{ id: cmt, artifact_id: cref, rev_no: 1, author_id: "hum_s", body: "c", created_at: at }],
    meta_versions: [], blobs: {}
  });
  const DOCUMENT = "A document id in this backup cannot be stored", VERSION_OR_COMMENT = "A version or comment id in this backup cannot be stored";
  const cases = [
    ["(a) document id", fixture({ id: "lone\ud800x" }), DOCUMENT],
    ["(b) revision id", fixture({ id: "art_s_0001", rev: "rev\ud800" }), VERSION_OR_COMMENT],
    ["(c) comment id", fixture({ id: "art_s_0001", cmt: "c\udc00" }), VERSION_OR_COMMENT],
    ["(d) comment's document id", fixture({ id: "x\ud800", ref: "x\ufffd", cmt: "cmt_s_0001", cref: "x\udc00" }), DOCUMENT],
  ];
  for (const [label, backup, message] of cases) {
    const h = await harness();
    h.sql.exec("DELETE FROM projects");
    await assert.rejects(h.lib.restoreBackup(h.ctx, backup), (e) => e.status === 400 && e.code === "bad_backup" && e.message === message, label);
    assert.equal(h.objects.size, 0, label);
    assert.equal(h.sql.prepare("SELECT COUNT(*) AS n FROM content_writes").get().n, 0, label);
    assert.equal(h.sql.prepare("SELECT COUNT(*) AS n FROM projects").get().n, 0, label);
  }
  // Import replaces every id with a fresh one, so the same backup imports.
  const h = await harness();
  const ws = h.sql.prepare("SELECT id FROM workspaces LIMIT 1").get().id;
  const result = await h.lib.importBackup(h.ctx, ws, { backup: cases[0][1] }, "lone-surrogate-import");
  const artifact = h.sql.prepare("SELECT id FROM artifacts WHERE project_id = ?").all(result.project_id);
  assert.equal(artifact.length, 1);
  assert.equal((await h.lib.getArtifact(h.ctx, result.project_id, artifact[0].id)).body, "synthetic words");
});
