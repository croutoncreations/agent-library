import { test } from "node:test";
import assert from "node:assert/strict";
import { putText, getText, getTextRange } from "../packages/core/src/content-store.js";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./helpers.mjs";
import { loadWorker } from "./load-worker.mjs";

async function harness() {
  const lib = await loadWorker({ "service.js": ["createMarkdown", "saveMarkdown", "getArtifact", "restoreRevision"], "reads/service.js": ["readTextChunk"], "uploads.js": ["serveContent"], "history/service.js": ["diffRevisions"], "backup.js": ["exportBackup", "restoreBackup"], "cleanup.js": ["reconcileUploads"], "adapters.js": ["withAdapters", "defaultAdapters"] });
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
