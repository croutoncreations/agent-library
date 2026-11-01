// Every stored-bytes access goes through src/content-store.js (the encryption seam; docs/encryption.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./helpers.mjs";

function jsFiles(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === "web" ? [] : jsFiles(p);
    return p.endsWith(".js") ? [p] : [];
  });
}

test("only src/content-store.js touches the R2 binding", () => {
  const offenders = jsFiles(join(ROOT, "src"))
    .filter((f) => !f.endsWith("content-store.js"))
    .filter((f) => /\bBLOBS\b/.test(readFileSync(f, "utf8")))
    .map((f) => f.slice(ROOT.length + 1));
  assert.deepEqual(offenders, []);
});

// Text bodies in D1 (revisions.body, comments.body). Two checks:
// 1. Static: every statement in src/ that inserts into revisions or comments either binds storeText(...) or is an
//    SQL-side copy marked "content-store: sql-side" (listed in docs/encryption.md).
// 2. Behavioural: the build is made with storeText/readText replaced by a reversible marker codec and the main write
//    and read paths (documents, comments, history, restore, templates, JSON files and records, backup export and
//    restore) run against the migrated schema in node:sqlite. A covered path that skips the seam leaves the marker
//    out of the stored row or leaks it into a response. Paths not exercised here are covered only by check 1 (writes).
test("every INSERT of a text body binds storeText or is a marked SQL-side copy", () => {
  const bad = [];
  for (const f of jsFiles(join(ROOT, "src"))) {
    const text = readFileSync(f, "utf8");
    const re = /INSERT INTO (revisions|comments) \(([^)]*)\)/g;
    for (let m; (m = re.exec(text));) {
      if (!/\bbody\b/.test(m[2])) continue;
      const before = text.slice(Math.max(0, m.index - 300), m.index), after = text.slice(m.index, m.index + 1500);
      const bind = after.slice(after.indexOf(".bind("), after.indexOf(".bind(") + 600);
      if (/content-store: sql-side/.test(before)) continue;
      if (after.indexOf(".bind(") < 0 || !/storeText\(/.test(bind)) bad.push(`${f.slice(ROOT.length + 1)}:${text.slice(0, m.index).split("\n").length}`);
    }
  }
  assert.deepEqual(bad, [], "text-body INSERT without storeText(...) in its bind (or a 'content-store: sql-side' marker)");
});
test("main JS write and read paths of text bodies go through storeText/readText (marker codec)", async () => {
  const { loadWorker } = await import("./load-worker.mjs");
  const lib = await loadWorker({ "service.js": ["createMarkdown", "createFile", "saveFile", "readRecords", "saveMarkdown", "getArtifact", "addComment", "listComments", "restoreRevision"], "templates/service.js": ["saveAsTemplate", "createFromTemplate"], "backup.js": ["exportBackup", "restoreBackup"], "history/service.js": ["diffRevisions"] },
    { "content-store.js": "export * from \"./src/content-store.js\"; export function storeText(t) { return \"ENC:\" + t; } export function readText(s) { if (!String(s).startsWith(\"ENC:\")) throw new Error(\"unencoded body read: \" + String(s).slice(0, 20)); return String(s).slice(4); }" });
  const { DatabaseSync } = await import("node:sqlite");
  const sql = new DatabaseSync(":memory:");
  for (const f of readdirSync(join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort()) sql.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  const mkDB = (sql) => { const stmt = (q, p) => ({ q, p, async first(c) { const r = sql.prepare(q).get(...p); return c ? r?.[c] ?? null : r ?? null; }, async all() { return { results: sql.prepare(q).all(...p) }; }, async run() { const r = sql.prepare(q).run(...p); return { meta: { changes: r.changes } }; } });
  return { prepare: (q) => ({ ...stmt(q, []), bind: (...p) => stmt(q, p) }), async batch(list) { sql.exec("BEGIN"); try { const out = list.map((s) => /^\s*(SELECT|WITH)/i.test(s.q) || /RETURNING/i.test(s.q) ? { results: sql.prepare(s.q).all(...s.p), meta: { changes: 0 } } : { meta: { changes: sql.prepare(s.q).run(...s.p).changes } }); sql.exec("COMMIT"); return out; } catch (e) { sql.exec("ROLLBACK"); throw e; } } }; };
  const DB = mkDB(sql);
  const at = new Date().toISOString();
  sql.prepare("INSERT INTO principals (id, kind, issuer, subject, label, created_at) VALUES ('hum_s','human','synthetic','s','Owner',?)").run(at);
  sql.prepare("INSERT INTO projects (id, owner_id, title, created_at) VALUES ('proj-s','hum_s','Synthetic',?)").run(at);
  const ctx = { env: { DB }, requestId: "req_s", principal: { id: "hum_s", kind: "human", label: "Owner" } };
  const c = await lib.createMarkdown(ctx, "proj-s", { title: "Doc", body: "first body" }, "idem-create-1");
  const aid = c.body.artifact_id;
  await lib.saveMarkdown(ctx, "proj-s", aid, { expected_revision: 1, body: "second body" }, "idem-save-1");
  await lib.addComment(ctx, "proj-s", aid, { revision: 2, body: "a comment" }, "idem-comment-1");
  await lib.restoreRevision(ctx, "proj-s", aid, { from_revision: 1, expected_revision: 2 }, "idem-restore-1");
  assert.deepEqual(sql.prepare("SELECT body FROM revisions ORDER BY rev_no").all().map((r) => r.body), ["ENC:first body", "ENC:second body", "ENC:first body"]);
  assert.equal(sql.prepare("SELECT body FROM comments").get().body, "ENC:a comment");
  assert.equal((await lib.getArtifact(ctx, "proj-s", aid, 2)).body, "second body");
  assert.deepEqual((await lib.listComments(ctx, "proj-s", aid)).comments.map((x) => x.body), ["a comment"]);
  const d = await lib.diffRevisions(ctx, "proj-s", aid, 1, 2);
  assert.ok(JSON.stringify(d).includes("second body") && !JSON.stringify(d).includes("ENC:"));
  // Templates: definition copies the source text; use copies the template text.
  const tpl = await lib.saveAsTemplate(ctx, "proj-s", { source_artifact_id: aid, source_revision: 2, title: "Tpl" }, "idem-tpl-1");
  const used = await lib.createFromTemplate(ctx, "proj-s", { template_id: tpl.body.artifact_id, template_revision: 1, title: "From tpl" }, "idem-tpl-2");
  assert.equal((await lib.getArtifact(ctx, "proj-s", used.body.artifact_id)).body, "second body");
  // JSON file + records query (App Connect paths).
  const actx = { ...ctx, env: { DB, APP_CONNECT_ENABLED: "1" } };
  const records = JSON.stringify({ schema: "agentlib.measurements/1", records: [{ id: "r1", recorded_at: "2026-01-02T08:00:00Z", date: "2026-01-02", metric: "steps", value: 1, unit: "count" }] });
  const jf = await lib.createFile(actx, "proj-s", { kind: "json", title: "M", content: records, schema: "agentlib.measurements/1" }, "idem-json-1");
  assert.equal(sql.prepare("SELECT body FROM revisions WHERE artifact_id = ?").get(jf.body.artifact_id).body, "ENC:" + records);
  assert.equal((await lib.getArtifact(actx, "proj-s", jf.body.artifact_id)).content, records);
  await lib.readRecords(actx, "proj-s", jf.body.artifact_id, {});
  await lib.saveFile(actx, "proj-s", jf.body.artifact_id, { expected_revision: 1, content: records }, "idem-json-2");
  for (const r of sql.prepare("SELECT body FROM revisions WHERE body IS NOT NULL").all()) assert.ok(r.body.startsWith("ENC:"), "every stored body is encoded");
  // Backup: export gives plaintext; restore into an empty store writes encoded rows again.
  const bk = await lib.exportBackup(ctx, "proj-s");
  assert.ok(bk.revisions.every((r) => r.body === null || !r.body.startsWith("ENC:")) && bk.comments.every((c) => !c.body.startsWith("ENC:")));
  const sql2 = new DatabaseSync(":memory:");
  for (const f of readdirSync(join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort()) sql2.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  sql2.prepare("INSERT INTO principals (id, kind, issuer, subject, label, created_at) VALUES ('hum_s','human','synthetic','s','Owner',?)").run(at);
  const DB2 = mkDB(sql2);
  await lib.restoreBackup({ ...ctx, env: { DB: DB2 } }, bk);
  for (const r of sql2.prepare("SELECT body FROM revisions WHERE body IS NOT NULL UNION ALL SELECT body FROM comments").all()) assert.ok(r.body.startsWith("ENC:"), "restored bodies are encoded");
});
