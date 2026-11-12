// Slice 3b uploads (design commit 4): the production uploadBegin -> uploadPut -> uploadFinish for binary files with
// encryption on (synthetic key settings) and off, in the World of test/upload-world.mjs (no listener, so R2 calls are
// counted exactly; listener tests never count R2 requests on a read that fails mid-body). Synthetic data only.
// Design tests: 2 (World), 4, 5, 6, 7, 8, 9 (World), 10, 11, 12, 16 (finish), 24, 26.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { P, PNG, lib, world } from "./upload-world.mjs";
import { CHUNKED_HEADER_BYTES, chunkedStoredLength } from "../packages/core/src/crypto/chunked.js";

const WS = "wsp_hum_synthetic";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const MiB = 1024 * 1024;
const pngLike = (n) => { const b = randomBytes(n); PNG.copy(b, 0, 0, Math.min(PNG.length, n)); return b; };
const status = (s, code) => (e) => e?.status === s && e?.code === code;

/** A World (encryption on unless off) with BLOBS and batch spies; begin/put/finish through the production code. */
function setup({ encryption = true, vars = {} } = {}) {
  const w = world({ encryption });
  Object.assign(w.env, { FILE_MAX_BYTES: String(40 * MiB), PROJECT_BINARY_BYTES: "0", ...vars });
  const env = lib.withAdapters(w.env, lib.defaultAdapters());
  w.ctx.env = env;
  const calls = { put: [], get: [], head: [] };
  const { put, get, head } = w.env.BLOBS;
  w.env.BLOBS.put = (k, b, o) => { calls.put.push({ k, o }); return put(k, b, o); };
  w.env.BLOBS.get = (k, o) => { calls.get.push({ k, o }); return get(k, o); };
  w.env.BLOBS.head = (k) => { calls.head.push(k); return head(k); };
  const batches = [];
  const prepare = w.env.DB.prepare, batch = w.env.DB.batch;
  w.env.DB.prepare = (q) => { const o = prepare(q); const bind = o.bind; return { ...o, q, bind: (...p) => ({ ...bind(...p), q }) }; };
  w.env.DB.batch = (ss) => { batches.push(ss.map((s) => s.q)); return batch.call(w.env.DB, ss); };
  const begin = async (bytes, extra = {}) => {
    const b = await lib.uploadBegin(w.ctx, P, { mime: "image/png", size: bytes.length, sha256: sha(bytes), title: "Synthetic image", ...extra }, "begin-" + randomBytes(4).toString("hex"));
    assert.equal(b.status, 201, JSON.stringify(b.body));
    return b.body.upload_id;
  };
  const stream = (b, piece = 64 * 1024) => { let i = 0; return new ReadableStream({ pull(c) { if (i >= b.length) return c.close(); c.enqueue(new Uint8Array(b.subarray(i, i + piece))); i += piece; } }); };
  // A PUT without Content-Length (the body decides), as a chunked transfer would.
  const putRaw = (id, body) => lib.uploadPut(new Request("https://example.test/api/transfers/" + id, { method: "PUT", body, duplex: "half" }), env, w.ctx.requestId, id, w.ctx);
  const finish = (id, k = "finish-" + randomBytes(4).toString("hex")) => lib.uploadFinish(w.ctx, P, id, k);
  const download = async (art, range) => {
    const r = await lib.serveContent(w.ctx, new Request("https://example.test/content", { headers: range ? { range } : {} }), P, art);
    return { status: r.status, bytes: Buffer.from(await r.arrayBuffer()) };
  };
  const publishBatch = () => batches.find((b) => /^\s*INSERT INTO revisions/.test(b.find((q) => /INSERT INTO revisions/.test(q)) ?? "") && b.some((q) => /INSERT INTO revisions/.test(q)));
  return { w, env, calls, batches, begin, putRaw, stream, finish, download, publishBatch };
}
/** Begin, PUT and finish one file; returns the upload id, artifact id and the finish result. */
async function publish(s, bytes, extra) {
  const id = await s.begin(bytes, extra);
  assert.equal((await s.w.put(id, bytes)).status, 200);
  const f = await s.finish(id);
  assert.equal(f.status, 200, JSON.stringify(f.body));
  return { id, art: f.body.artifact_id, f };
}
const fenceOf = (batch) => batch.filter((q) => /content_fences/.test(q));

test("design test 2 (World) and 7: a 3.5-chunk encrypted upload publishes; the stored object is ciphertext of the stored length; download is identical; the batch ends with a key fence", async () => {
  const s = setup();
  const bytes = pngLike(Math.floor(3.5 * 65536));
  const { id, art } = await publish(s, bytes);
  const row = s.w.row(id);
  assert.match(row.enc_key_id, /^wk_/); assert.match(row.enc_header, /^[A-Za-z0-9_-]{64}$/);
  const rev = s.w.sql.prepare("SELECT blob_key, blob_key_id, blob_header, size, sha256 FROM revisions WHERE artifact_id = ?").get(art);
  assert.deepEqual([rev.blob_key_id, rev.blob_header, rev.size, rev.sha256], [row.enc_key_id, row.enc_header, bytes.length, sha(bytes)]);
  const stored = s.w.blobs.get(rev.blob_key);
  assert.equal(stored.length, chunkedStoredLength(bytes.length));
  assert.equal(Buffer.from(stored).indexOf(bytes.subarray(5000, 5016)), -1, "no 16-byte window of the plaintext");
  assert.ok(Buffer.from(stored.subarray(0, CHUNKED_HEADER_BYTES)).equals(Buffer.from(rev.blob_header, "base64url")));
  const last = s.batches.find((b) => b.some((q) => /INSERT INTO revisions/.test(q)));
  assert.match(last.at(-1), /content_fences[\s\S]*key_active|SELECT NULL, 0/, "the key fence is last");
  assert.equal(fenceOf(last).length, 1);
  const d = await s.download(art);
  assert.ok(d.bytes.equals(bytes));
  assert.equal(s.w.row(id).state, "published");
});

test("design test 7: a mixed history (a plaintext version, then encrypted) reads both", async () => {
  const s = setup({ encryption: false });
  const v1 = pngLike(3000);
  const { art } = await publish(s, v1);
  Object.assign(s.w.env, { CONTENT_MASTER_KEY_VERSION: "1", CONTENT_MASTER_KEY_V1: Buffer.from(randomBytes(32)).toString("base64") });
  const v2 = pngLike(70_000);
  const id2 = await s.begin(v2, { artifact_id: art, expected_revision: 1, title: undefined });
  assert.equal((await s.w.put(id2, v2)).status, 200);
  assert.equal((await s.finish(id2)).status, 200);
  const revs = s.w.sql.prepare("SELECT rev_no, blob_key_id FROM revisions WHERE artifact_id = ? ORDER BY rev_no").all(art);
  assert.equal(revs[0].blob_key_id, null); assert.match(revs[1].blob_key_id, /^wk_/);
  const r1 = await lib.serveContent(s.w.ctx, new Request("https://example.test/c?rev=1"), P, art, "1");
  assert.ok(Buffer.from(await r1.arrayBuffer()).equals(v1));
  assert.ok((await s.download(art)).bytes.equals(v2));
});

test("design test 4: a wrong SHA-256, encrypted, at 1, 65,536, 131,072 and 200,000 bytes is 422, stores nothing and ends the upload failed; the right SHA succeeds", async () => {
  for (const n of [1, 65_536, 131_072, 200_000]) {
    const s = setup();
    const bytes = pngLike(n);
    const evil = Buffer.from(bytes); evil[n - 1] ^= 0xff;
    const id = await s.begin(bytes);
    const key = s.w.row(id).final_key;
    await assert.rejects(s.w.put(id, evil), status(422, "integrity_mismatch"), `size ${n}`);
    assert.equal(s.w.blobs.has(key), false, `nothing stored at ${n}`);
    assert.equal(s.w.row(id).state, "failed");
    const ok = await s.begin(bytes);
    assert.equal((await s.w.put(ok, bytes)).status, 200, `right SHA at ${n}`);
  }
});

test("design test 5: a short body without Content-Length is 400 and back to pending, then a re-PUT succeeds; a long body is 413, pending; classified by the tap even when storage answers generically", async () => {
  const s = setup();
  const bytes = pngLike(100_000);
  const id = await s.begin(bytes);
  await assert.rejects(s.putRaw(id, s.stream(bytes.subarray(0, 70_000))), status(400, "incomplete_body"));
  assert.deepEqual([s.w.row(id).state, s.w.row(id).final_writes], ["pending", 0]);
  await assert.rejects(s.putRaw(id, s.stream(Buffer.concat([bytes, Buffer.alloc(5)]))), status(413, "too_large"));
  assert.equal(s.w.row(id).state, "pending");
  const put = s.w.env.BLOBS.put;
  s.w.env.BLOBS.put = async (k, b) => { try { await new Response(b).arrayBuffer(); } catch {} throw new Error("synthetic generic storage failure"); };
  await assert.rejects(s.putRaw(id, s.stream(bytes.subarray(0, 10))), status(400, "incomplete_body"));
  s.w.env.BLOBS.put = put;
  assert.equal((await s.putRaw(id, s.stream(bytes))).status, 200);
  assert.equal((await s.finish(id)).status, 200);
});

test("design test 6: with no key configured, the put is today's ({ sha256, httpMetadata }), the columns stay NULL, GET reads no workspace_keys, and finish carries a plaintext fence last", async () => {
  const s = setup({ encryption: false });
  const queries = [];
  const prepare = s.w.env.DB.prepare;
  s.w.env.DB.prepare = (q) => { queries.push(q); return prepare(q); };
  const bytes = pngLike(5000);
  const { id, art } = await publish(s, bytes);
  assert.deepEqual(s.calls.put.map((c) => c.o), [{ sha256: sha(bytes), httpMetadata: { contentType: "image/png" } }]);
  assert.deepEqual([s.w.row(id).enc_key_id, s.w.row(id).enc_header], [null, null]);
  assert.deepEqual({ ...s.w.sql.prepare("SELECT blob_key_id, blob_header FROM revisions WHERE artifact_id = ?").get(art) }, { blob_key_id: null, blob_header: null });
  const last = s.batches.find((b) => b.some((q) => /INSERT INTO revisions/.test(q)));
  assert.match(last.at(-1), /content_fences/); assert.match(last.at(-1), /SELECT 0, NULL/, "plaintext fence");
  queries.length = 0;
  assert.ok((await s.download(art)).bytes.equals(bytes));
  assert.equal(queries.filter((q) => /workspace_keys/.test(q)).length, 0, "no key query on GET");
  assert.deepEqual(s.calls.get.at(-1).o, undefined, "one whole get, as today");
});

test("design test 8: a 30 MiB encrypted upload makes one put; finish makes one head and one get of at most 65,552 bytes", async () => {
  const s = setup();
  const bytes = pngLike(30 * MiB + 321);
  const id = await s.begin(bytes);
  assert.equal((await s.w.put(id, bytes)).status, 200);
  s.calls.get.length = 0; s.calls.head.length = 0;
  assert.equal((await s.finish(id)).status, 200);
  assert.equal(s.calls.put.length, 1);
  assert.equal(s.calls.head.length, 1);
  assert.equal(s.calls.get.length, 1);
  assert.ok(s.calls.get[0].o.range.length <= 65_552, JSON.stringify(s.calls.get[0].o));
});

test("design test 9 (World): the key shredded between PUT and finish answers 410 key_shredded; the upload ends failed (not conflict) and its object is reclaimed", async () => {
  const s = setup();
  const bytes = pngLike(2000);
  const id = await s.begin(bytes);
  assert.equal((await s.w.put(id, bytes)).status, 200);
  const key = s.w.row(id).final_key;
  await lib.shredWorkspaceKeys(s.env, WS);
  await assert.rejects(s.finish(id), status(410, "key_shredded"));
  const row = s.w.row(id);
  assert.equal(row.state, "failed");
  assert.equal(JSON.parse(row.result).code, "key_shredded");
  assert.equal(s.w.blobs.has(key), false, "reclaimed");
  await assert.rejects(s.finish(id), status(410, "key_shredded"), "a retry replays");
  // A PUT after a shred also ends failed with nothing stored.
  const s2 = setup();
  const id2 = await s2.begin(bytes);
  await lib.shredWorkspaceKeys(s2.env, WS);
  await assert.rejects(s2.w.put(id2, bytes), status(410, "key_shredded"));
  assert.equal(s2.w.row(id2).state, "failed");
  assert.equal(s2.calls.put.length, 0);
});

test("design test 10: a shred racing finish (after the checks, before the batch) is refused by the key fence: 410, full rollback, failed, reclaimed", async () => {
  const s = setup();
  const bytes = pngLike(3000);
  const id = await s.begin(bytes);
  assert.equal((await s.w.put(id, bytes)).status, 200);
  const key = s.w.row(id).final_key;
  const art = s.w.row(id).artifact_id;
  s.w.hooks.beforeBatch = async () => { await lib.shredWorkspaceKeys(s.env, WS); };
  await assert.rejects(s.finish(id), status(410, "key_shredded"));
  assert.equal(s.w.sql.prepare("SELECT COUNT(*) AS n FROM revisions WHERE artifact_id = ?").get(art).n, 0, "nothing published");
  assert.equal(s.w.sql.prepare("SELECT head_rev FROM artifacts WHERE id = ?").get(art).head_rev, 0);
  assert.equal(s.w.row(id).state, "failed");
  assert.equal(s.w.blobs.has(key), false);
});

test("design test 11: the first key appearing while a plaintext finish runs is refused by the plaintext fence: 409 encryption_started, rollback, failed (not conflict), reclaimed", async () => {
  const s = setup({ encryption: false });
  const bytes = pngLike(3000);
  const id = await s.begin(bytes);
  assert.equal((await s.w.put(id, bytes)).status, 200);
  const key = s.w.row(id).final_key;
  s.w.hooks.beforeBatch = async () => {
    const keyed = lib.withAdapters({ ...s.w.env, CONTENT_MASTER_KEY_VERSION: "1", CONTENT_MASTER_KEY_V1: Buffer.from(randomBytes(32)).toString("base64") }, lib.defaultAdapters());
    await lib.workspaceDataKey(keyed, "wsp_hum_someone_else");
  };
  await assert.rejects(s.finish(id), status(409, "encryption_started"));
  assert.equal(s.w.row(id).state, "failed");
  assert.equal(JSON.parse(s.w.row(id).result).code, "encryption_started");
  assert.equal(s.w.sql.prepare("SELECT COUNT(*) AS n FROM revisions WHERE artifact_id = ?").get(s.w.row(id).artifact_id).n, 0);
  assert.equal(s.w.blobs.has(key), false);
});

test("design test 12: a late write before publication (another write of the same key) makes finish 500 publish_failed; the upload ends failed and is reclaimed", async () => {
  const s = setup();
  const bytes = pngLike(3000);
  const id = await s.begin(bytes);
  assert.equal((await s.w.put(id, bytes)).status, 200);
  const key = s.w.row(id).final_key;
  // A second (late) write of the same storage key commits after the first: a different salt, so a different header.
  const dk = await lib.workspaceDataKey(s.env, WS);
  const late = await lib.writeBlobBytes(s.env, { key, bytes, contentType: "image/png", workspaceId: WS });
  assert.equal(late.keyId, dk.keyId);
  assert.notEqual(late.header, s.w.row(id).enc_header);
  await assert.rejects(s.finish(id), status(500, "publish_failed"));
  assert.equal(s.w.row(id).state, "failed");
  assert.equal(s.w.blobs.has(key), false);
});

test("finish fails closed 500 publish_failed on inconsistent stored metadata or size; received values unlike the declaration are 422", async () => {
  for (const [label, tamper] of [
    ["al-key", (s, k) => { s.w.meta.get(k).customMetadata["al-key"] = "wk_other"; }],
    ["al-enc", (s, k) => { s.w.meta.get(k).customMetadata = {}; }],
    ["size", (s, k) => { s.w.blobs.set(k, Buffer.concat([s.w.blobs.get(k), Buffer.from([0])])); }],
    ["chunk 0", (s, k) => { const b = Buffer.from(s.w.blobs.get(k)); b[CHUNKED_HEADER_BYTES + 1] ^= 1; s.w.blobs.set(k, b); }],
  ]) {
    const s = setup();
    const bytes = pngLike(2000);
    const id = await s.begin(bytes);
    assert.equal((await s.w.put(id, bytes)).status, 200);
    tamper(s, s.w.row(id).final_key);
    await assert.rejects(s.finish(id), status(500, "publish_failed"), label);
    assert.equal(s.w.row(id).state, "failed", label);
  }
  const s = setup();
  const bytes = pngLike(2000);
  const id = await s.begin(bytes);
  assert.equal((await s.w.put(id, bytes)).status, 200);
  s.w.sql.prepare("UPDATE uploads SET received_sha256 = ? WHERE id = ?").run(sha(randomBytes(3)), id);
  await assert.rejects(s.finish(id), status(422, "integrity_mismatch"));
});

test("design test 16 (finish): a 0-byte binary row at finish is 415 signature_mismatch with no R2 read", async () => {
  const s = setup();
  const { id } = s.w.upload({ state: "received" });
  s.w.sql.prepare("UPDATE uploads SET expected_size = 0, expected_sha256 = ?, received_size = 0, received_sha256 = ? WHERE id = ?").run(sha(Buffer.alloc(0)), sha(Buffer.alloc(0)), id);
  s.calls.get.length = 0; s.calls.head.length = 0;
  await assert.rejects(s.finish(id), status(415, "signature_mismatch"));
  assert.deepEqual([s.calls.get.length, s.calls.head.length], [0, 0]);
  assert.equal(s.w.row(id).state, "failed");
});

test("design test 24: an abort mid-PUT stores nothing and leaves the upload pending; a re-PUT succeeds", async () => {
  const s = setup();
  const bytes = pngLike(200_000);
  const id = await s.begin(bytes);
  let sent = 0;
  const aborting = new ReadableStream({ pull(c) { if (sent >= 70_000) { c.error(new Error("synthetic client abort")); return; } c.enqueue(new Uint8Array(bytes.subarray(sent, sent + 35_000))); sent += 35_000; } });
  await assert.rejects(s.putRaw(id, aborting));
  assert.equal(s.w.blobs.has(s.w.row(id).final_key), false);
  assert.deepEqual([s.w.row(id).state, s.w.row(id).final_writes], ["pending", 0]);
  assert.equal((await s.w.put(id, bytes)).status, 200);
  assert.equal((await s.finish(id)).status, 200);
});

test("design test 26: a finish whose publish committed, retried concurrently while a fence would refuse, gets the stored answer and the upload stays published", async () => {
  const s = setup();
  const bytes = pngLike(3000);
  const id = await s.begin(bytes);
  assert.equal((await s.w.put(id, bytes)).status, 200);
  const k = "finish-replay-1";
  const first = await s.finish(id, k);
  assert.equal(first.status, 200);
  // The key is shredded afterwards; a retry with the same key must replay, not answer 410.
  await lib.shredWorkspaceKeys(s.env, WS);
  const again = await s.finish(id, k);
  assert.equal(again.status, 200);
  assert.equal(again.body.idempotent_replay, true);
  assert.equal(again.body.revision_id, first.body.revision_id);
  assert.equal(s.w.row(id).state, "published");
});

test("design test 26: when the batch itself hits a fence but this request's answer is already stored, runBatch returns it and finish does not end the upload", async () => {
  const s = setup();
  const bytes = pngLike(3000);
  const id = await s.begin(bytes);
  assert.equal((await s.w.put(id, bytes)).status, 200);
  const k = "finish-replay-2";
  // Just before this finish's batch: a racing finish under the same idempotency key stored its answer, then the key
  // was shredded. The batch hits the key fence; runBatch finds the stored answer and returns it in place of the refusal.
  s.w.hooks.beforeBatch = async () => {
    const digest = sha(id);
    s.w.sql.prepare("INSERT INTO idempotency (principal_id, project_id, op, key, digest, status, response, created_at) VALUES ('hum_synthetic', ?, ?, ?, ?, 200, ?, ?)")
      .run(P, "upload.finish:" + id, k, digest, JSON.stringify({ artifact_id: s.w.row(id).artifact_id, revision: 1, revision_id: "rev_racer", sha256: sha(bytes), size: bytes.length }), new Date().toISOString());
    await lib.shredWorkspaceKeys(s.env, WS);
  };
  const r = await s.finish(id, k);
  assert.equal(r.status, 200);
  assert.equal(r.body.idempotent_replay, true);
  assert.equal(r.body.revision_id, "rev_racer");
  assert.notEqual(s.w.row(id).state, "failed", "a stored answer is never turned into a failed upload");
});

test("text uploads are untouched: the raw input stays plaintext with R2's sha256 check, even with encryption on", async () => {
  const s = setup();
  s.w.env.APP_CONNECT_ENABLED = "1";
  const body = "# synthetic heading\n";
  const b = await lib.uploadBegin(s.w.ctx, P, { mime: "text/markdown", size: Buffer.byteLength(body), sha256: sha(Buffer.from(body)), title: "Doc" }, "begin-text", { allowText: true });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  const id = b.body.upload_id;
  assert.equal((await s.w.put(id, Buffer.from(body))).status, 200);
  assert.deepEqual(s.calls.put.at(-1).o, { sha256: sha(Buffer.from(body)), httpMetadata: { contentType: "text/markdown" } });
  assert.deepEqual([s.w.row(id).enc_key_id, s.w.row(id).enc_header], [null, null]);
  assert.equal((await s.finish(id)).status, 200);
});
