// Real app API plus deterministic SQLite/R2 tests of the bundled production text upload path.
import { test, before, after } from "node:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { buildWorker } from "../scripts/build.mjs";
import { csvFixture } from "./formats-memory-fixtures.mjs";
import { jsonFixture } from "./formats-json-memory-fixtures.mjs";
import assert from "node:assert/strict";
import { ROOT, LOCAL_CONFIG, startServer, setupProject, sha256, key, grant, agentHttp } from "./helpers.mjs";
import { SERVER_PORTS } from "./ports.mjs";
import { P, lib, world } from "./upload-world.mjs";

const kinds = { markdown: "text/markdown", html: "text/html", json: "application/json", csv: "text/csv" };
const source = { markdown: "# upload-marker\nraw 😀\n", html: "<h1>upload-marker 😀</h1>", json: '{"marker":"upload-marker 😀"}', csv: "marker,value\nupload-marker,😀\n" };
const configured = () => { const w = world(); w.env.APP_CONNECT_ENABLED = "1"; w.ctx.env = lib.withAdapters(w.env, lib.defaultAdapters()); return w; };
async function begin(w, kind, text, extra = {}, idem = key()) {
  const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text);
  const r = await lib.uploadBegin(w.ctx, P, { title: "Synthetic document", mime: kinds[kind], size: bytes.length, sha256: sha256(bytes), ...extra }, idem);
  return { ...r.body, bytes };
}
async function received(w, kind, text, extra = {}) { const b = await begin(w, kind, text, extra); await w.put(b.upload_id, b.bytes); return b; }
for (const kind of Object.keys(kinds)) {
  test(`${kind}: ordinary text publication, replay, one read/two writes, no temporary bytes`, async () => {
    const w = configured(), b = await received(w, kind, source[kind]);
    await assert.rejects(lib.loadArtifact(w.ctx, P, b.artifact_id), e => e.status === 404);
    const f = await lib.uploadFinish(w.ctx, P, b.upload_id, "finish");
    assert.equal(f.body.size, b.bytes.length);
    const r = w.sql.prepare("SELECT body, body_key, blob_key, size, sha256, mime, rev_no FROM revisions WHERE artifact_id = ?").get(b.artifact_id);
    assert.equal(r.body, null); assert.equal(r.blob_key, null); assert.match(r.body_key, /^text\//);
    assert.deepEqual([r.size, r.sha256, r.mime, r.rev_no], [b.bytes.length, sha256(b.bytes), kinds[kind], 1]);
    assert.deepEqual(Buffer.from(w.blobs.get(r.body_key)), b.bytes);
    assert.equal(w.blobs.has(w.row(b.upload_id).final_key), false);
    assert.equal(w.sql.prepare("SELECT COUNT(*) AS n FROM content_writes").get().n, 0);
    assert.deepEqual(w.r2.gets, [null], "one whole input read, no signature read");
    const replay = await lib.uploadFinish(w.ctx, P, b.upload_id, "finish");
    assert.equal(replay.body.revision_id, f.body.revision_id);
    assert.equal(w.r2.gets.length, 1);
    assert.deepEqual(JSON.parse(w.sql.prepare("SELECT response FROM idempotency WHERE op = ?").get("upload.finish:" + b.upload_id).response), JSON.parse(w.row(b.upload_id).result).body);
  });
}
for (const bytes of [Buffer.from([0xe2, 0x82]), Buffer.from([0xc0, 0xaf]), Buffer.from([0xed, 0xa0, 0x80])]) {
  test(`strict UTF-8 ${bytes.toString("hex")}: terminal and replayable`, async () => {
    const w = configured(), b = await received(w, "markdown", bytes);
    for (let n = 0; n < 2; n++) await assert.rejects(lib.uploadFinish(w.ctx, P, b.upload_id, "utf8"), e => e.status === 422 && e.code === "invalid_content" && e.message === "Invalid markdown: bytes are not valid UTF-8" && e.extra.format === "markdown");
    assert.equal(w.sql.prepare("SELECT COUNT(*) AS n FROM revisions").get().n, 0);
    assert.equal(w.sql.prepare("SELECT COUNT(*) AS n FROM artifact_search").get().n, 0);
    assert.equal(w.row(b.upload_id).state, "failed");
    assert.equal(w.blobs.size, 0);
  });
}
test("text metadata digest covers normalized folders/schema/note; replacement MIME/schema are immutable", async () => {
  const w = configured(), k = key(), b = await begin(w, "json", "{}", {}, k);
  await assert.rejects(begin(w, "json", "{}", { change_note: "different" }, k), e => e.code === "idempotency_key_reused");
  await w.put(b.upload_id, b.bytes); await lib.uploadFinish(w.ctx, P, b.upload_id, key());
  await assert.rejects(begin(w, "csv", "a\n", { title: undefined, artifact_id: b.artifact_id, expected_revision: 1 }), e => e.message === "mime must match the existing document kind");
  await assert.rejects(begin(w, "json", "{}", { title: undefined, artifact_id: b.artifact_id, expected_revision: 1, schema: "agentlib.measurements/1" }), e => e.message === "schema must match the existing document schema");
});
test("temporary delete failure is retried by cron without deleting published text", async () => {
  const w = configured(), b = await received(w, "markdown", source.markdown), raw = w.row(b.upload_id).final_key;
  const del = w.env.BLOBS.delete; w.env.BLOBS.delete = async k => { if (k === raw) throw new Error("synthetic delete failure"); return del(k); };
  await lib.uploadFinish(w.ctx, P, b.upload_id, key());
  assert.ok(w.blobs.has(raw));
  w.env.BLOBS.delete = del; await lib.reconcileUploads(w.env);
  assert.equal(w.blobs.has(raw), false);
  const r = w.sql.prepare("SELECT body_key FROM revisions WHERE artifact_id = ?").get(b.artifact_id);
  assert.ok(w.blobs.has(r.body_key));
});
test("text begin limit precedes placeholder/reservation; binary quota ignores text", async () => {
  const w = configured(); w.env.PROJECT_BINARY_BYTES = "1";
  for (const kind of Object.keys(kinds)) await assert.rejects(begin(w, kind, "x", { size: 10485761 }), e => e.status === 413);
  assert.equal(w.sql.prepare("SELECT COUNT(*) AS n FROM artifacts").get().n, 0);
  const b = await received(w, "markdown", "text");
  assert.equal(await w.env.DB.prepare(`SELECT ${lib.quotaUsedSql(Date.now())} AS n`).bind(P).first("n"), 0);
  await lib.uploadFinish(w.ctx, P, b.upload_id, key());
});

test("reservation replaces its charge exactly once; current-plan downgrade refuses without double increment", async () => {
  const w = configured(); let allowed = 4;
  const adapters = { ...lib.defaultAdapters(), entitlements: { limits: async () => ({ storage_bytes: allowed, file_bytes: 1 }) } };
  w.ctx.env = lib.withAdapters(w.env, adapters);
  const b = await received(w, "markdown", "four");
  const result = await lib.uploadFinish(w.ctx, P, b.upload_id, key()); assert.equal(result.body.size, 4);
  await lib.uploadFinish(w.ctx, P, b.upload_id, key());
  assert.equal(w.sql.prepare("SELECT SUM(size) AS n FROM revisions").get().n, 4);
  allowed = 8;
  const next = await received(w, "markdown", "four", { title: undefined, artifact_id: b.artifact_id, expected_revision: 1 });
  allowed = 7;
  await assert.rejects(lib.uploadFinish(w.ctx, P, next.upload_id, "downgrade"), e => e.status === 402 && e.extra.used === 8 && e.extra.allowed === 7);
  assert.equal(w.row(next.upload_id).state, "sealed");
  allowed = 8; await lib.uploadFinish(w.ctx, P, next.upload_id, "downgrade");
  assert.equal(w.sql.prepare("SELECT SUM(size) AS n FROM revisions").get().n, 8);
});
test("ordinary save wins a race after upload text staging; losing upload is terminal conflict", async () => {
  const w = configured(), b = await received(w, "markdown", "first"); await lib.uploadFinish(w.ctx, P, b.upload_id, key());
  const next = await received(w, "markdown", "upload", { title: undefined, artifact_id: b.artifact_id, expected_revision: 1 });
  w.r2.onPut = async k => { if (!k.startsWith("text/")) return; w.r2.onPut = null; await lib.saveFile(w.ctx, P, b.artifact_id, { expected_revision: 1, body: "ordinary" }, key()); };
  await assert.rejects(lib.uploadFinish(w.ctx, P, next.upload_id, key()), e => e.code === "revision_conflict");
  assert.equal(w.row(next.upload_id).state, "conflict");
  assert.equal(w.sql.prepare("SELECT head_rev FROM artifacts WHERE id = ?").get(b.artifact_id).head_rev, 2);
  assert.equal(w.sql.prepare("SELECT COUNT(*) AS n FROM content_writes").get().n, 0);
});
test("lease takeover after text staging uses fresh text keys and the old finisher replays the winner", async () => {
  const { loadWorker } = await import("./load-worker.mjs");
  const otherIsolate = await loadWorker({ "uploads.js": ["uploadFinish"] });
  const w = configured(), b = await received(w, "markdown", "takeover");
  let release, staged;
  const gate = new Promise(r => { release = r; }), ready = new Promise(r => { staged = r; });
  w.r2.onPut = async k => { if (!k.startsWith("text/")) return; w.r2.onPut = null; staged(); await gate; };
  const slow = lib.uploadFinish(w.ctx, P, b.upload_id, "takeover");
  await ready;
  const oldKey = w.sql.prepare("SELECT key FROM content_writes").get().key;
  w.sql.prepare("UPDATE uploads SET finalize_until = 0 WHERE id = ?").run(b.upload_id);
  const fresh = await otherIsolate.uploadFinish(w.ctx, P, b.upload_id, "takeover");
  release(); const late = await slow;
  assert.equal(late.body.revision_id, fresh.body.revision_id);
  const row = w.sql.prepare("SELECT body_key FROM revisions WHERE artifact_id = ?").get(b.artifact_id);
  assert.notEqual(row.body_key, oldKey); assert.ok(w.blobs.has(row.body_key)); assert.equal(w.blobs.has(oldKey), false);
  assert.equal(w.sql.prepare("SELECT COUNT(*) AS n FROM revisions").get().n, 1);
});
test("unknown commit acknowledgement resolves terminal publication; cron removes temporary input", async () => {
  const w = configured(), b = await received(w, "markdown", "unknown ack");
  const batch = w.env.DB.batch;
  w.env.DB.batch = async ss => { w.env.DB.batch = batch; await batch(ss); throw new Error("synthetic lost acknowledgement"); };
  const f = await lib.uploadFinish(w.ctx, P, b.upload_id, key()); assert.equal(f.status, 200);
  assert.equal(w.sql.prepare("SELECT COUNT(*) AS n FROM revisions").get().n, 1);
  await lib.reconcileUploads(w.env);
  assert.equal(w.blobs.has(w.row(b.upload_id).final_key), false);
  assert.ok(w.blobs.has(w.sql.prepare("SELECT body_key FROM revisions").get().body_key));
});
test("abandoned text placeholder is hidden even to trash/history loaders and removed after grace", async () => {
  const w = configured(), b = await received(w, "markdown", "abandoned");
  await assert.rejects(lib.loadArtifact(w.ctx, P, b.artifact_id, { allowTrashed: true }), e => e.status === 404);
  w.sql.prepare("UPDATE uploads SET expires_at = ? WHERE id = ?").run(Date.now() - 2 * 86400000, b.upload_id);
  await lib.reconcileUploads(w.env);
  assert.equal(w.row(b.upload_id), undefined);
  assert.equal(w.sql.prepare("SELECT COUNT(*) AS n FROM artifacts").get().n, 0); assert.equal(w.blobs.size, 0);
});
test("folder pairing and maintenance restrictions are rechecked at publication", async () => {
  const w = configured(), at = new Date().toISOString();
  w.sql.prepare("INSERT INTO folders (id, project_id, name, name_key, created_at, created_by) VALUES ('fld_synthetic', ?, 'Synthetic folder', 'synthetic folder', ?, 'hum_synthetic')").run(P, at);
  const b = await received(w, "markdown", "folder", { folder_id: "fld_synthetic" });
  w.r2.onPut = async k => { if (!k.startsWith("text/")) return; w.r2.onPut = null; w.sql.prepare("UPDATE folders SET project_id = 'prj_other' WHERE id = 'fld_synthetic'").run(); };
  // Foreign keys require a real second project for the deliberate mismatch.
  w.sql.prepare("INSERT INTO projects (id, owner_id, title, created_at) VALUES ('prj_other', 'hum_synthetic', 'Other synthetic', ?)").run(at);
  await assert.rejects(lib.uploadFinish(w.ctx, P, b.upload_id, key()), e => e.status === 403);
  assert.equal(w.sql.prepare("SELECT COUNT(*) AS n FROM revisions").get().n, 0);
});

for (const condition of ["missing", "expired"]) test(`text intent ${condition} after staging is retryable, never publishes a missing body`, async () => {
  const w = configured(), b = await received(w, "markdown", "intent fence");
  const keys = [];
  w.r2.onPut = async k => {
    if (!k.startsWith("text/")) return;
    keys.push(k); w.r2.onPut = null;
    w.sql.prepare(condition === "missing" ? "DELETE FROM content_writes WHERE key = ?" : "UPDATE content_writes SET created_at = 0 WHERE key = ?").run(k);
  };
  await assert.rejects(lib.uploadFinish(w.ctx, P, b.upload_id, "intent-retry"), e => e.code === "text_write_expired");
  assert.equal(w.row(b.upload_id).state, "sealed"); assert.equal(w.row(b.upload_id).finalize_token, null);
  assert.equal(w.sql.prepare("SELECT COUNT(*) AS n FROM revisions").get().n, 0); assert.equal(w.blobs.has(keys[0]), false);
  await lib.uploadFinish(w.ctx, P, b.upload_id, "intent-retry");
  assert.notEqual(w.sql.prepare("SELECT body_key FROM revisions").get().body_key, keys[0]);
});
test("staged R2 failure stays retryable and its intent is swept; project deletion during staging prevents publication", async () => {
  const w = configured(), b = await received(w, "markdown", "retry then delete");
  w.r2.beforeCommit = async k => { if (!k.startsWith("text/")) return; w.r2.beforeCommit = null; throw new Error("synthetic R2 failure"); };
  await assert.rejects(lib.uploadFinish(w.ctx, P, b.upload_id, key()), /synthetic R2 failure/);
  assert.equal(w.row(b.upload_id).state, "sealed"); assert.equal(w.row(b.upload_id).finalize_token, null);
  w.sql.prepare("UPDATE content_writes SET created_at = 0").run(); await lib.reconcileUploads(w.env);
  assert.equal(w.sql.prepare("SELECT COUNT(*) AS n FROM content_writes").get().n, 0);
  w.r2.onPut = async k => {
    if (!k.startsWith("text/")) return; w.r2.onPut = null;
    w.sql.prepare("UPDATE projects SET deleted_at = ?, purge_at = ? WHERE id = ?").run(Date.now() - 86400000, 1, P);
    await lib.purgeDueProjects(w.env);
    assert.equal(w.sql.prepare("SELECT purged_at FROM projects WHERE id = ?").get(P).purged_at, null, "live finalization lease holds purge");
  };
  await assert.rejects(lib.uploadFinish(w.ctx, P, b.upload_id, key()), e => e.status === 403);
  assert.equal(w.sql.prepare("SELECT COUNT(*) AS n FROM revisions").get().n, 0);
  await lib.purgeDueProjects(w.env);
  assert.ok(w.sql.prepare("SELECT purged_at FROM projects WHERE id = ?").get(P).purged_at);
  assert.equal(w.blobs.size, 0);
});
test("JSON/CSV feature gates and folder gates apply before reservations", async () => {
  const w = configured(); w.ctx.env.APP_CONNECT_ENABLED = "0";
  for (const kind of ["json", "csv"]) await assert.rejects(begin(w, kind, source[kind]), e => e.status === 404);
  await assert.rejects(begin(w, "markdown", "folder", { folder_id: "fld_synthetic" }), e => e.status === 404);
  assert.equal(w.sql.prepare("SELECT COUNT(*) AS n FROM artifacts").get().n, 0);
  const b = await received(w, "markdown", "available without App Connect"); await lib.uploadFinish(w.ctx, P, b.upload_id, key());
});

let server, h;
const project = "proj-text-uploads";
before(async () => {
  const worker = join(ROOT, "tmp", "text-uploads-worker", "index.js");
  await buildWorker({ entry: join(ROOT, "test/fixtures/limits-worker.js"), outfile: worker });
  server = await startServer("text-uploads", SERVER_PORTS["text-uploads"], { worker, vars: { APP_CONNECT_ENABLED: "1", RATE_WRITES_PER_MIN: "100000", RATE_READS_PER_MIN: "100000", PROJECT_BINARY_BYTES: "1", PLAN_LIMITS: JSON.stringify({ free: { storage_bytes: 64 * 1048576, file_bytes: 1 }, exact: { storage_bytes: 4, file_bytes: 1 }, downgraded: { storage_bytes: 3, file_bytes: 1 } }) } });
  h = await server.login(); await setupProject(h, project);
});
const sql = q => JSON.parse(execFileSync("wrangler", ["d1", "--config", LOCAL_CONFIG, "execute", "DB", "--local", "--persist-to", server.dir, "--json", "--command", q], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }))[0].results;
after(async () => { await server?.stop(); });
const base = `/api/projects/${project}`;
async function httpUpload(kind, text, extra = {}) {
  const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text);
  const b = await h.req("POST", base + "/uploads", { title: "Synthetic " + kind, mime: kinds[kind], size: bytes.length, sha256: sha256(bytes), ...extra });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  if (!extra.artifact_id) {
    const hidden = base + `/artifacts/${b.body.artifact_id}`;
    for (const suffix of ["", "/history", "/text", "/comments"]) assert.equal((await h.req("GET", hidden + suffix)).status, 404, "placeholder hidden: " + suffix);
  }
  const p = await h.req("PUT", b.body.put_url, undefined, { raw: bytes });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const f = await h.req("POST", base + `/uploads/${b.body.upload_id}/finish`);
  return { b, f };
}
for (const kind of Object.keys(kinds)) test(`app API ${kind}: upload create/save interoperate with JSON saves, full and Range reads`, async () => {
  const { b, f } = await httpUpload(kind, source[kind]);
  assert.equal(f.status, 200, JSON.stringify(f.body));
  const path = base + `/artifacts/${b.body.artifact_id}`;
  const r = await h.req("GET", path);
  assert.equal(r.body.artifact.kind, kind); assert.equal(r.body.body ?? r.body.content, source[kind]);
  const save = await h.req("PUT", path, { expected_revision: 1, body: source[kind], content: source[kind] });
  assert.equal(save.status, 200, JSON.stringify(save.body));
  const again = await httpUpload(kind, source[kind], { title: undefined, artifact_id: b.body.artifact_id, expected_revision: 2 });
  assert.equal(again.f.status, 200, JSON.stringify(again.f.body)); assert.equal(again.f.body.revision, 3);
  const whole = await h.req("GET", path + "/content", undefined, { binary: true }); assert.deepEqual(whole.body, Buffer.from(source[kind]));
  const range = await h.req("GET", path + "/content", undefined, { binary: true, headers: { range: "bytes=1-5" } }); assert.equal(range.status, 206); assert.deepEqual(range.body, whole.body.subarray(1, 6));
  const history = await h.req("GET", path + "/history"); assert.equal(history.body.revisions.length, 3);
  const chunk = await h.req("GET", path + "/text?max_bytes=8192"); assert.equal(chunk.body.text, source[kind]); assert.equal(chunk.body.eof, true);
  const found = await h.req("GET", `/api/search?query=upload&project_ids=${project}`); assert.ok(found.body.results.some(r => r.artifact_id === b.body.artifact_id));
  const rows = sql(`SELECT r.body, r.body_key, r.blob_key, r.size, r.sha256, r.mime, a.schema_id, a.head_rev FROM revisions r JOIN artifacts a ON a.id = r.artifact_id WHERE r.artifact_id = '${b.body.artifact_id}' ORDER BY r.rev_no`);
  assert.equal(rows.length, 3);
  for (const row of rows) { assert.equal(row.body, null); assert.match(row.body_key, /^text\//); assert.equal(row.blob_key, null); assert.equal(row.size, Buffer.byteLength(source[kind])); assert.equal(row.sha256, sha256(source[kind])); assert.equal(row.mime, kinds[kind]); assert.equal(row.schema_id, null); assert.equal(row.head_rev, 3); }
});
for (const [kind, values] of Object.entries({ markdown: ["", "\ufeff# BOM"], html: ["", "\ufeff<p>BOM</p>"], json: ["", "\ufeff{}", "{", '{"a":1,}'], csv: ["", "\ufeffa\n", 'a,b\n"unclosed'] })) {
  for (const text of values) test(`app API ${kind}: validator parity ${JSON.stringify(text)}`, async () => {
    const ordinary = await h.req("POST", base + "/artifacts", { kind, title: "Parity", body: text, content: text });
    const { f } = await httpUpload(kind, text);
    assert.equal(f.status, ordinary.status === 201 ? 200 : ordinary.status, JSON.stringify(f.body));
    if (ordinary.status >= 400) assert.deepEqual(f.body.error, ordinary.body.error);
    else { const got = await h.req("GET", base + `/artifacts/${f.body.artifact_id}/content`, undefined, { binary: true }); assert.deepEqual(got.body, Buffer.from(text)); }
  });
}
test("app API: exactly 10 MiB raw Markdown accepted; one byte more refused at begin", async () => {
  const text = "x".repeat(10485760), { f } = await httpUpload("markdown", text);
  assert.equal(f.status, 200, JSON.stringify(f.body)); assert.equal(f.body.size, 10485760);
  const bad = await h.req("POST", base + "/uploads", { title: "Too large", mime: kinds.markdown, size: 10485761, sha256: sha256("x") });
  assert.equal(bad.status, 413); assert.equal(bad.body.error.message, "Markdown exceeds 10 MiB");
});
test("app API: malformed UTF-8 is rejected only at finish and replays exactly", async () => {
  for (const bytes of [Buffer.from([0xe2, 0x82]), Buffer.from([0xc0, 0xaf]), Buffer.from([0xed, 0xa0, 0x80])]) {
    const { b, f } = await httpUpload("markdown", bytes);
    assert.equal(f.status, 422); assert.equal(f.body.error.message, "Invalid markdown: bytes are not valid UTF-8");
    const replay = await h.req("POST", base + `/uploads/${b.body.upload_id}/finish`); assert.deepEqual(replay.body.error, f.body.error);
  }
});
test("app API: exactly full workspace reservation publishes once, downgrade is retryable and checked", async () => {
  const ws = (await h.req("POST", "/api/workspaces", { name: "Synthetic quota" })).body.id;
  const p = (await h.req("POST", "/api/projects", { title: "Quota", workspace_id: ws })).body.id;
  const path = `/api/projects/${p}`;
  sql(`UPDATE workspaces SET plan = 'exact' WHERE id = '${ws}'`);
  const reserve = () => h.req("POST", path + "/uploads", { title: "Full", mime: kinds.markdown, size: 4, sha256: sha256("four") });
  const b = await reserve(); assert.equal(b.status, 201, JSON.stringify(b.body));
  assert.equal((await h.req("PUT", b.body.put_url, undefined, { raw: "four" })).status, 200);
  sql(`UPDATE workspaces SET plan = 'downgraded' WHERE id = '${ws}'`);
  const f = await h.req("POST", path + `/uploads/${b.body.upload_id}/finish`, undefined, { idem: "downgrade-finish" });
  assert.equal(f.status, 402, JSON.stringify(f.body)); assert.equal(f.body.error.used, 4); assert.equal(f.body.error.allowed, 3);
  sql(`UPDATE workspaces SET plan = 'exact' WHERE id = '${ws}'`);
  for (let n = 0; n < 2; n++) assert.equal((await h.req("POST", path + `/uploads/${b.body.upload_id}/finish`, undefined, { idem: "downgrade-finish" })).status, 200);
  assert.equal((await h.req("GET", `/api/workspaces/${ws}/usage`)).body.storage_bytes.used, 4);
});
test("app API: backup contains uploaded revisions as text, never temporary blobs", async () => {
  const backup = await h.req("GET", base + "/backup"); assert.equal(backup.status, 200, JSON.stringify(backup.body));
  assert.ok(backup.body.revisions.some(r => r.body === source.markdown));
  assert.ok(backup.body.revisions.every(r => r.blob_key == null));
});
test("app API: PUT refuses wrong length before storage and checksum mismatch is terminal", async () => {
  const bytes = Buffer.from("declared"), body = { title: "Integrity", mime: kinds.markdown, size: bytes.length, sha256: sha256(bytes) };
  const b = await h.req("POST", base + "/uploads", body); assert.equal(b.status, 201);
  assert.equal((await h.req("PUT", b.body.put_url, undefined, { raw: "short" })).status, 400);
  assert.equal((await h.req("PUT", b.body.put_url, undefined, { raw: "far too long" })).status, 413);
  const bad = await h.req("PUT", b.body.put_url, undefined, { raw: "modified" }); assert.equal(bad.status, 422); assert.equal(bad.body.error.code, "integrity_mismatch");
  const f = await h.req("POST", base + `/uploads/${b.body.upload_id}/finish`); assert.equal(f.status, 422); assert.deepEqual(f.body.error, bad.body.error);
});
test("app API: live grant revocation stops PUT and finish; protected sources refuse begin and publication", async () => {
  for (const stage of ["put", "finish"]) {
    const g = await grant(h, project, "Synthetic revocable uploader"), a = agentHttp(server.base, g.token);
    const b = await a("POST", base + "/uploads", { title: "Revoked", mime: kinds.markdown, size: 1, sha256: sha256("x") }); assert.equal(b.status, 201);
    if (stage === "finish") assert.equal((await a("PUT", b.body.put_url, undefined, { raw: "x" })).status, 200);
    assert.equal((await h.req("PATCH", base + `/grants/${g.grant_id}`, { revoke: true })).status, 200);
    const r = stage === "put" ? await a("PUT", b.body.put_url, undefined, { raw: "x" }) : await a("POST", base + `/uploads/${b.body.upload_id}/finish`);
    assert.equal(r.status, 401); assert.equal(r.body.error.code, "grant_revoked");
    assert.equal(sql(`SELECT COUNT(*) AS n FROM revisions WHERE artifact_id = '${b.body.artifact_id}'`)[0].n, 0);
  }
  const made = await httpUpload("markdown", "source");
  const id = made.f.body.artifact_id;
  const next = await h.req("POST", base + "/uploads", { artifact_id: id, expected_revision: 1, mime: kinds.markdown, size: 1, sha256: sha256("x") });
  assert.equal(next.status, 201); assert.equal((await h.req("PUT", next.body.put_url, undefined, { raw: "x" })).status, 200);
  sql(`UPDATE artifacts SET publisher_id = 'pub_synthetic_guard' WHERE id = '${id}'`);
  const f = await h.req("POST", base + `/uploads/${next.body.upload_id}/finish`); assert.equal(f.status, 403); assert.equal(f.body.error.code, "protected_source");
  const b = await h.req("POST", base + "/uploads", { artifact_id: id, expected_revision: 1, mime: kinds.markdown, size: 1, sha256: sha256("x") }); assert.equal(b.status, 403); assert.equal(b.body.error.code, "protected_source");
  sql(`UPDATE artifacts SET publisher_id = NULL WHERE id = '${id}'`);
  // End the owner's still-retryable upload so later cases can reserve another.
  sql(`UPDATE uploads SET expires_at = 1, finalize_until = NULL WHERE id = '${next.body.upload_id}'`);
  const templateGrant = await grant(h, project, "Synthetic template guard"), agent = agentHttp(server.base, templateGrant.token);
  const replacement = { artifact_id: id, expected_revision: 1, mime: kinds.markdown, size: 1, sha256: sha256("x") };
  sql(`UPDATE artifacts SET is_template = 1 WHERE id = '${id}'`);
  const denied = await agent("POST", base + "/uploads", replacement); assert.equal(denied.status, 403); assert.equal(denied.body.error.code, "template_owner_only");
  sql(`UPDATE artifacts SET is_template = 0 WHERE id = '${id}'`);
  const pending = await agent("POST", base + "/uploads", replacement); assert.equal(pending.status, 201);
  sql(`UPDATE artifacts SET is_template = 1 WHERE id = '${id}'`);
  assert.equal((await agent("PUT", pending.body.put_url, undefined, { raw: "x" })).status, 403);
  sql(`UPDATE artifacts SET is_template = 0 WHERE id = '${id}'`);
  assert.equal((await agent("PUT", pending.body.put_url, undefined, { raw: "x" })).status, 200);
  sql(`UPDATE artifacts SET is_template = 1 WHERE id = '${id}'`);
  const deniedFinish = await agent("POST", base + `/uploads/${pending.body.upload_id}/finish`); assert.equal(deniedFinish.status, 403); assert.equal(deniedFinish.body.error.code, "template_owner_only");
});
test("app API: full 10 MiB one-character-row CSV uploads and exports to spreadsheet with exact hash", async () => {
  const { text, rows, outputLength } = csvFixture("tiny"); assert.equal(Buffer.byteLength(text), 10485760);
  const { f } = await httpUpload("csv", text); assert.equal(f.status, 200, JSON.stringify(f.body));
  const response = await fetch(server.base + base + `/artifacts/${f.body.artifact_id}/content?format=spreadsheet`, { headers: { cookie: h.cookie } });
  assert.equal(response.status, 200);
  const digest = createHash("sha256"); let size = 0;
  for await (const bytes of response.body) { size += bytes.length; digest.update(bytes); }
  const expected = createHash("sha256").update("h\r\n");
  // Hash bounded batches rather than retain another full spreadsheet copy.
  for (let left = rows; left > 0;) { const n = Math.min(left, 10000); expected.update("a\r\n".repeat(n)); left -= n; }
  assert.equal(size, outputLength); assert.equal(digest.digest("hex"), expected.digest("hex"));
});
test("app API: 100,000 seven-field measurement records upload, query first/last/filter; JSON envelope remains capped", async () => {
  const { text, count } = jsonFixture("ordinary"); assert.equal(count, 100000); assert.equal(Buffer.byteLength(text), 10052060);
  const input = { title: "Measurements", kind: "json", schema: "agentlib.measurements/1", content: text };
  assert.ok(Buffer.byteLength(JSON.stringify(input)) > 11 * 1048576);
  assert.equal((await h.req("POST", base + "/artifacts", input)).status, 413);
  const { f } = await httpUpload("json", text, { schema: "agentlib.measurements/1" }); assert.equal(f.status, 200, JSON.stringify(f.body));
  const path = base + `/artifacts/${f.body.artifact_id}/records`;
  const first = await h.req("GET", path + "?limit=2"), last = await h.req("GET", path + "?cursor=99998&limit=2"), filter = await h.req("GET", path + "?metric=m&from=2000-01-01&to=2000-01-01&limit=1");
  for (const r of [first, last, filter]) assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(first.body.records[0].id, "0"); assert.equal(Object.keys(first.body.records[0]).length, 7);
  assert.equal(last.body.records[1].id, (99999).toString(36)); assert.equal(last.body.next_cursor, null);
  assert.equal(filter.body.records[0].recorded_at, "x"); assert.equal(filter.body.records[0].metric, "m");
  const replacement = await httpUpload("json", text, { title: undefined, artifact_id: f.body.artifact_id, expected_revision: 1 });
  assert.equal(replacement.f.status, 200, JSON.stringify(replacement.f.body));
  assert.equal((await h.req("GET", base + `/artifacts/${f.body.artifact_id}`)).body.artifact.schema, "agentlib.measurements/1");
});
