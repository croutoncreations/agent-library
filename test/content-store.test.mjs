// Every stored-bytes access goes through packages/core/src/content-store.js (the encryption seam; docs/encryption.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./helpers.mjs";
import { getText, getTextRange, textKey } from "../packages/core/src/content-store.js";

test("text keys preserve normal IDs and escape legacy separators without aliasing", () => {
  assert.equal(textKey("proj-s", "art_123", "rev_123"), "text/proj-s/art_123/rev_123");
  assert.equal(textKey("proj-s", "a%2Fb", "c"), "text/proj-s/a%252Fb/c");
  assert.notEqual(textKey("proj-s", "a/b", "c"), textKey("proj-s", "a", "b/c"));
});

test("legacy text reads retain byte-exact UTF-8 ranges", async () => {
  const body = "aé🙂z";
  assert.equal(await getText({}, { body }), body);
  assert.deepEqual(await getTextRange({}, { body }, 2, 3), new TextEncoder().encode(body).slice(2, 5));
});

function jsFiles(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === "web" ? [] : jsFiles(p);
    return p.endsWith(".js") ? [p] : [];
  });
}

test("only packages/core/src/content-store.js touches the R2 binding", () => {
  const offenders = jsFiles(join(ROOT, "packages", "core", "src"))
    .filter((f) => !f.endsWith("content-store.js"))
    .filter((f) => /\bBLOBS\b/.test(readFileSync(f, "utf8")))
    .map((f) => f.slice(ROOT.length + 1));
  assert.deepEqual(offenders, []);
});

// Slice 3b seam (design test 25, the rules that apply once the read side exists): only content-store.js uses the
// object codec, the data keys and R2 object metadata, and the raw R2 readers stay inside it.
const rel = (f) => f.slice(ROOT.length + 1);
test("only content-store.js (and crypto/ itself) imports crypto/chunked.js, workspaceDataKey or dataKeyById", () => {
  const users = jsFiles(join(ROOT, "packages"))
    .filter((f) => !rel(f).startsWith("packages/core/src/crypto/"))
    .filter((f) => /crypto\/chunked\.js|\b(?:workspaceDataKey|dataKeyById)\b/.test(readFileSync(f, "utf8")))
    .map(rel);
  assert.deepEqual(users, ["packages/core/src/content-store.js"]);
});
test("customMetadata appears in no source file other than content-store.js", () => {
  const users = jsFiles(join(ROOT, "packages")).filter((f) => /\bcustomMetadata\b/.test(readFileSync(f, "utf8"))).map(rel);
  assert.deepEqual(users, ["packages/core/src/content-store.js"]);
});
test("the raw R2 readers (getBlob, getBlobHead, getBlobBytes, headBlob, blobSha256Hex) are module-internal to content-store.js", () => {
  const store = readFileSync(join(ROOT, "packages", "core", "src", "content-store.js"), "utf8");
  assert.doesNotMatch(store, /export\s+(?:async\s+)?function\s+(?:getBlob|getBlobHead|getBlobBytes|headBlob|blobSha256Hex)\b/);
  const importers = jsFiles(join(ROOT, "packages"))
    .filter((f) => !f.endsWith("content-store.js"))
    .filter((f) => [...readFileSync(f, "utf8").matchAll(/import\s*\{([^}]*)\}\s*from\s*["'][^"']*content-store\.js["']/g)].some((m) => /\b(?:getBlob|getBlobHead|getBlobBytes|headBlob|blobSha256Hex)\b/.test(m[1])))
    .map(rel);
  assert.deepEqual(importers, []);
});
test("backup.js writes and cleans up files only through writeBlobBytes and the phase-based cleanup: no putBlob, deleteBlob or raw reader", () => {
  const src = readFileSync(join(ROOT, "packages", "core", "src", "backup.js"), "utf8");
  const imported = [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'][^"']*content-store\.js["']/g)].flatMap((m) => m[1].split(",").map((x) => x.trim()));
  for (const name of ["putBlob", "deleteBlob", "getBlob", "getBlobBytes", "getBlobHead", "headBlob", "blobSha256Hex", "putBlobStream"]) assert.ok(!imported.includes(name), name);
  assert.ok(imported.includes("writeBlobBytes") && imported.includes("dropUnreferencedBlobs") && imported.includes("deleteBlobs"));
});
test("ACTIVE_KEY_SQL and NO_REAL_KEY_SQL are imported only by content-store.js (crypto/keys.js defines them)", () => {
  const importers = jsFiles(join(ROOT, "packages"))
    .filter((f) => !rel(f).startsWith("packages/core/src/crypto/"))
    .filter((f) => [...readFileSync(f, "utf8").matchAll(/import\s*\{([^}]*)\}\s*from/g)].some((m) => /\b(?:ACTIVE_KEY_SQL|NO_REAL_KEY_SQL)\b/.test(m[1])))
    .map(rel);
  assert.deepEqual(importers, ["packages/core/src/content-store.js"]);
});
test("exactly one writeUploadBlob( call site and one putBlobStream( call site outside content-store.js", () => {
  const count = (re) => jsFiles(join(ROOT, "packages")).filter((f) => !f.endsWith("content-store.js")).reduce((n, f) => n + [...readFileSync(f, "utf8").matchAll(re)].length, 0);
  assert.equal(count(/\bwriteUploadBlob\(/g), 1);
  assert.equal(count(/\bputBlobStream\(/g), 1);
});

// Publication conditions are written once (docs/encryption.md#rules-for-code-that-uses-this): crypto/keys.js defines
// them, content-store.js builds the fences from them, and nothing else hand-writes or touches the fence table.
test("only content-store.js and crypto/keys.js use ACTIVE_KEY_SQL and NO_REAL_KEY_SQL", () => {
  const users = jsFiles(join(ROOT, "packages", "core", "src"))
    .filter((f) => /\b(?:ACTIVE_KEY_SQL|NO_REAL_KEY_SQL)\b/.test(readFileSync(f, "utf8")))
    .map((f) => f.slice(ROOT.length + 1)).sort();
  assert.deepEqual(users, ["packages/core/src/content-store.js", "packages/core/src/crypto/keys.js"]);
});
test("content_fences appears in no source file other than content-store.js", () => {
  const users = jsFiles(join(ROOT, "packages"))
    .filter((f) => readFileSync(f, "utf8").includes("content_fences"))
    .map((f) => f.slice(ROOT.length + 1));
  assert.deepEqual(users, ["packages/core/src/content-store.js"]);
});

// A conflict clause would turn a fence refusal into a pass (INSERT OR IGNORE skips the NOT NULL failure).
test("the fence statements in content-store.js carry no conflict clause", () => {
  const text = readFileSync(join(ROOT, "packages", "core", "src", "content-store.js"), "utf8");
  const fences = [...text.matchAll(/\bprepare\(\s*(["'`])([\s\S]*?)\1/g)].map((m) => m[2]).filter((q) => q.includes("content_fences"));
  assert.equal(fences.length, 2);
  for (const q of fences) assert.doesNotMatch(q, /\bOR\s+(?:IGNORE|REPLACE|ABORT|FAIL|ROLLBACK)\b|\bON\s+CONFLICT\b/i, q);
});

// Legacy fallback SELECTs still fetch inline bodies, but SQL must not match against them. The temporary FTS
// bridge and publisher generation copies remain plaintext until later slices (docs/encryption.md).
test("SQL never matches revision or comment body columns", () => {
  const bad = [];
  for (const f of jsFiles(join(ROOT, "packages", "core", "src"))) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/\bprepare\(\s*(["'`])([\s\S]*?)\1/g)) {
      if (/\b(?:revisions|comments)\b/.test(m[2]) && /\b(?:\w+\.)?body\s+(?:LIKE|GLOB|MATCH|REGEXP)\b/i.test(m[2])) {
        bad.push(`${f.slice(ROOT.length + 1)}:${text.slice(0, m.index).split("\n").length}`);
      }
    }
  }
  assert.deepEqual(bad, [], "inline bodies are compatibility reads, not SQL search inputs");
});

// Every new body is staged through the content store. Only publisher generation commits may still write inline:
// staged-part SQL copies and the manifest's storeText call. The marker-codec test exercises actual reads/writes,
// including inline compatibility, and fails if encoded bytes are missing or leak into a response.
test("body INSERTs use NULL revisions or empty comments, except allow-listed publisher generation copies", () => {
  const bad = [];
  for (const f of jsFiles(join(ROOT, "packages", "core", "src"))) {
    const text = readFileSync(f, "utf8");
    const re = /INSERT INTO (revisions|comments) \(([^)]*)\)/g;
    for (let m; (m = re.exec(text));) {
      if (!/\bbody\b/.test(m[2])) continue;
      const before = text.slice(Math.max(0, m.index - 300), m.index), after = text.slice(m.index, m.index + 1500);
      const bind = after.slice(after.indexOf(".bind("), after.indexOf(".bind(") + 600);
      if (m[1] === "revisions") {
        const sql = after.slice(0, after.indexOf(".bind("));
        const generationCommit = f.endsWith("/api/publisher.js") && text.lastIndexOf("async function commit(", m.index) > text.lastIndexOf("async function commitSnapshot(", m.index);
        if (generationCommit && /content-store: sql-side/.test(before) && /t\.body, t\.bytes, t\.sha256/.test(sql)) continue;
        if (generationCommit && /storeText\(manifestText\)/.test(bind)) continue;
      }
      const sql = after.slice(0, after.indexOf(".bind("));
      const bodyIndex = m[2].split(",").map(c => c.trim()).indexOf("body");
      const values = sql.slice(sql.indexOf(")") + 1).match(/(?:SELECT|VALUES\s*\()\s*([\s\S]*?)(?:\bWHERE\b|\)\s*[`"])/i)?.[1].split(",").map(v => v.trim());
      if (/\bbody_key\b/.test(m[2]) && values?.[bodyIndex] === (m[1] === "revisions" ? "NULL" : "''")) continue;
      bad.push(`${f.slice(ROOT.length + 1)}:${text.slice(0, m.index).split("\n").length}`);
    }
  }
  assert.deepEqual(bad, [], "text-body INSERT outside the explicit inline generation allow-list");
});
test("main JS text and comment paths go through the content store (marker codec)", async () => {
  const { loadWorker } = await import("./load-worker.mjs");
  const lib = await loadWorker({ "service.js": ["createMarkdown", "createFile", "saveFile", "readRecords", "saveMarkdown", "getArtifact", "addComment", "listComments", "restoreRevision"], "templates/service.js": ["saveAsTemplate", "createFromTemplate"], "backup.js": ["exportBackup", "restoreBackup"], "history/service.js": ["diffRevisions"], "adapters.js": ["withAdapters", "defaultAdapters"] },
    { "content-store.js": "export * from \"./packages/core/src/content-store.js\"; import { getText as actualGetText, stageTextWrite as actualStage, stageTextWrites as actualStageMany } from \"./packages/core/src/content-store.js\"; export async function stageTextWrite(env, p, a, r, t, attempt) { return actualStage(env, p, a, r, storeText(t), attempt); } export async function stageTextWrites(env, writes) { return actualStageMany(env, writes.map(w => ({ ...w, text: storeText(w.text) }))); } export async function getText(env, row) { return readText(await actualGetText(env, row)); } export function storeText(t) { return \"ENC:\" + t; } export function readText(s) { if (!String(s).startsWith(\"ENC:\")) throw new Error(\"unencoded body read: \" + String(s).slice(0, 20)); return String(s).slice(4); }" });
  const { DatabaseSync } = await import("node:sqlite");
  const sql = new DatabaseSync(":memory:");
  for (const f of readdirSync(join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort()) sql.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  const mkDB = (sql) => { const stmt = (q, p) => ({ q, p, async first(c) { const r = sql.prepare(q).get(...p); return c ? r?.[c] ?? null : r ?? null; }, async all() { return { results: sql.prepare(q).all(...p) }; }, async run() { const r = sql.prepare(q).run(...p); return { meta: { changes: r.changes } }; } });
  return { prepare: (q) => ({ ...stmt(q, []), bind: (...p) => stmt(q, p) }), async batch(list) { sql.exec("BEGIN"); try { const out = list.map((s) => /^\s*(SELECT|WITH)/i.test(s.q) || /RETURNING/i.test(s.q) ? { results: sql.prepare(s.q).all(...s.p), meta: { changes: 0 } } : { meta: { changes: sql.prepare(s.q).run(...s.p).changes } }); sql.exec("COMMIT"); return out; } catch (e) { sql.exec("ROLLBACK"); throw e; } } }; };
  const DB = mkDB(sql);
  const at = new Date().toISOString();
  sql.prepare("INSERT INTO principals (id, kind, issuer, subject, label, created_at) VALUES ('hum_s','human','synthetic','s','Owner',?)").run(at);
  sql.prepare("INSERT INTO projects (id, owner_id, title, created_at) VALUES ('proj-s','hum_s','Synthetic',?)").run(at);
  const objects = new Map();
  const BLOBS = { async put(k, b) { objects.set(k, new Uint8Array(b)); }, async delete(k) { for (const key of Array.isArray(k) ? k : [k]) objects.delete(key); }, async get(k) { const b = objects.get(k); return b ? { async arrayBuffer() { return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } } : null; } };
  const E = (env) => lib.withAdapters({ ...env, BLOBS }, lib.defaultAdapters());
  const ctx = { env: E({ DB }), requestId: "req_s", principal: { id: "hum_s", kind: "human", label: "Owner" } };
  const c = await lib.createMarkdown(ctx, "proj-s", { title: "Doc", body: "first body" }, "idem-create-1");
  const aid = c.body.artifact_id;
  await lib.saveMarkdown(ctx, "proj-s", aid, { expected_revision: 1, body: "second body" }, "idem-save-1");
  await lib.addComment(ctx, "proj-s", aid, { revision: 2, body: "a comment" }, "idem-comment-1");
  await lib.restoreRevision(ctx, "proj-s", aid, { from_revision: 1, expected_revision: 2 }, "idem-restore-1");
  assert.deepEqual(sql.prepare("SELECT body FROM revisions ORDER BY rev_no").all().map((r) => r.body), [null, null, null]);
  assert.deepEqual(sql.prepare("SELECT body_key FROM revisions ORDER BY rev_no").all().map(r => new TextDecoder().decode(objects.get(r.body_key))), ["ENC:first body", "ENC:second body", "ENC:first body"]);
  assert.equal(sql.prepare("SELECT body FROM comments").get().body, "");
  assert.equal(new TextDecoder().decode(objects.get(sql.prepare("SELECT body_key FROM comments").get().body_key)), "ENC:a comment");
  assert.equal((await lib.getArtifact(ctx, "proj-s", aid, 2)).body, "second body");
  assert.deepEqual((await lib.listComments(ctx, "proj-s", aid)).comments.map((x) => x.body), ["a comment"]);
  const d = await lib.diffRevisions(ctx, "proj-s", aid, 1, 2);
  assert.ok(JSON.stringify(d).includes("second body") && !JSON.stringify(d).includes("ENC:"));
  // Templates: definition copies the source text; use copies the template text.
  const tpl = await lib.saveAsTemplate(ctx, "proj-s", { source_artifact_id: aid, source_revision: 2, title: "Tpl" }, "idem-tpl-1");
  const used = await lib.createFromTemplate(ctx, "proj-s", { template_id: tpl.body.artifact_id, template_revision: 1, title: "From tpl" }, "idem-tpl-2");
  assert.equal((await lib.getArtifact(ctx, "proj-s", used.body.artifact_id)).body, "second body");
  // JSON file + records query (App Connect paths).
  const actx = { ...ctx, env: E({ DB, APP_CONNECT_ENABLED: "1" }) };
  const records = JSON.stringify({ schema: "agentlib.measurements/1", records: [{ id: "r1", recorded_at: "2026-01-02T08:00:00Z", date: "2026-01-02", metric: "steps", value: 1, unit: "count" }] });
  const jf = await lib.createFile(actx, "proj-s", { kind: "json", title: "M", content: records, schema: "agentlib.measurements/1" }, "idem-json-1");
  assert.equal(new TextDecoder().decode(objects.get(sql.prepare("SELECT body_key FROM revisions WHERE artifact_id = ?").get(jf.body.artifact_id).body_key)), "ENC:" + records);
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
  await lib.restoreBackup({ ...ctx, env: E({ DB: DB2 }) }, bk);
  for (const r of sql2.prepare("SELECT body FROM revisions WHERE body IS NOT NULL").all()) assert.ok(r.body.startsWith("ENC:"), "restored inline bodies are encoded");
  const restoredComment = sql2.prepare("SELECT body, body_key FROM comments").get();
  assert.equal(restoredComment.body, "");
  assert.equal(new TextDecoder().decode(objects.get(restoredComment.body_key)), "ENC:a comment");
});
