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

// Text bodies in D1 (revisions.body, comments.body): the build is made with storeText/readText replaced by a
// reversible marker codec, and real writes and reads run against the migrated schema in node:sqlite. If any JS path
// wrote plaintext or returned a stored body without readText, the marker would be missing or leak into a response.
test("every JS write and read of a text body goes through storeText/readText", async () => {
  const { loadWorker } = await import("./load-worker.mjs");
  const lib = await loadWorker({ "service.js": ["createMarkdown", "saveMarkdown", "getArtifact", "addComment", "listComments", "restoreRevision"], "history/service.js": ["diffRevisions"] },
    { "content-store.js": "export * from \"./src/content-store.js\"; export function storeText(t) { return \"ENC:\" + t; } export function readText(s) { if (!String(s).startsWith(\"ENC:\")) throw new Error(\"unencoded body read: \" + String(s).slice(0, 20)); return String(s).slice(4); }" });
  const { DatabaseSync } = await import("node:sqlite");
  const sql = new DatabaseSync(":memory:");
  for (const f of readdirSync(join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort()) sql.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  const stmt = (q, p) => ({ q, p, async first(c) { const r = sql.prepare(q).get(...p); return c ? r?.[c] ?? null : r ?? null; }, async all() { return { results: sql.prepare(q).all(...p) }; }, async run() { const r = sql.prepare(q).run(...p); return { meta: { changes: r.changes } }; } });
  const DB = { prepare: (q) => ({ ...stmt(q, []), bind: (...p) => stmt(q, p) }), async batch(list) { sql.exec("BEGIN"); try { const out = list.map((s) => /^\s*(SELECT|WITH)/i.test(s.q) || /RETURNING/i.test(s.q) ? { results: sql.prepare(s.q).all(...s.p), meta: { changes: 0 } } : { meta: { changes: sql.prepare(s.q).run(...s.p).changes } }); sql.exec("COMMIT"); return out; } catch (e) { sql.exec("ROLLBACK"); throw e; } } };
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
});
