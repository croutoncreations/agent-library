// Single-pass binary uploads: a file passes through the Worker once. uploadPut streams the body straight to the
// upload's final_key with R2 verifying the declared SHA-256 and length; uploadFinish writes nothing and reads only R2's
// recorded checksum and the first bytes. Unit tests drive the production code in upload-world.mjs (BLOBS spy); the
// local wrangler tests check real R2 (miniflare) behaviour end to end. Synthetic data only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ROOT, startServer, agentHttp, setupProject, grant, sha256 } from "./helpers.mjs";
import { SERVER_PORTS } from "./ports.mjs";
import { P, PNG, SHA, lib, world } from "./upload-world.mjs";
import { moduleScript } from "./module-source.mjs";

test("uploads.js: no direct byte buffering or stream hashing; one binary write call site and one plaintext text PUT call site", () => {
  const src = readFileSync(join(ROOT, "packages", "core", "src", "uploads.js"), "utf8");
  assert.doesNotMatch(src, /DigestStream|getBlobBytes|\.arrayBuffer\(\)/);
  // Stored bytes are read only through content-store's checked readers (readBlob, inspectUploadedBlob, getUploadedText).
  assert.doesNotMatch(src, /\b(?:getBlob|getBlobHead|headBlob|blobSha256Hex)\b/, "a raw R2 reader in uploads.js");
  assert.equal([...src.matchAll(/writeUploadBlob\(/g)].length, 1, "exactly one writeUploadBlob call site (the binary PUT)");
  assert.equal([...src.matchAll(/putBlobStream\(/g)].length, 1, "exactly one putBlobStream call site (the text PUT)");
});

test("uploadFinish: every fail/lost/lostAfterWrite outcome is awaited before its finally releases the lease", () => {
  const src = moduleScript("packages/core/src/uploads.js");
  const start = src.indexOf("async function uploadFinish(");
  assert.ok(start >= 0, "uploadFinish found");
  const end = src.indexOf("\nasync function ", start + 1);
  const body = src.slice(start, end < 0 ? void 0 : end);
  assert.match(body, /return await fail\(/, "guard sees the real body");
  assert.deepEqual(body.match(/return (?:fail|lost|lostAfterWrite)\(/g), null, "un-awaited return of fail/lost/lostAfterWrite in uploadFinish");
  // Whatever the statement form (return, bare call, extra spaces): every call of a helper that records, reads or cleans
  // up an outcome is awaited where it is made.
  const calls = [...body.matchAll(/\b(?:fail|lost|lostAfterWrite|end|dropUnpublished|purgeStaging)\s*\(/g)];
  assert.ok(calls.length >= 20, `guard found the helper calls (${calls.length})`);
  const bare = calls.filter((m) => !/\bawait\s+$/.test(body.slice(Math.max(0, m.index - 12), m.index))).map((m) => body.slice(Math.max(0, m.index - 30), m.index + 20));
  assert.deepEqual(bare, [], "helper call in uploadFinish that is not awaited where it is made");
});

// begin -> PUT -> finish against the BLOBS spy, as a human (no CSRF needed with the linkCtx path).
async function beginAs(w, bytes, sha = SHA) {
  const ctx = { ...w.ctx, env: lib.withAdapters(w.env, lib.defaultAdapters()) };
  const b = await lib.uploadBegin(ctx, P, { mime: "image/png", size: bytes.length, sha256: sha, title: "Synthetic image" }, "begin-" + randomBytes(4).toString("hex"));
  assert.equal(b.status, 201, JSON.stringify(b.body));
  return b.body.upload_id;
}
const quotaUsed = (w) => w.env.DB.prepare(`SELECT ${lib.quotaUsedSql(Date.now())} AS n`).bind(P).first("n");
function spy(w) {
  const calls = { put: [], get: [], head: [] };
  const { put, get, head } = w.env.BLOBS;
  w.env.BLOBS.put = (k, b, o) => { calls.put.push({ k, o }); return put(k, b, o); };
  w.env.BLOBS.get = (k, o) => { calls.get.push({ k, o }); return get(k, o); };
  w.env.BLOBS.head = (k) => { calls.head.push(k); return head(k); };
  return calls;
}

test("begin -> PUT -> finish: one R2 put (to final_key, with sha256), no full get, finish reads at most 16 bytes", async () => {
  const w = world();
  const calls = spy(w);
  const id = await beginAs(w, PNG);
  const row = w.row(id);
  assert.match(row.final_key, new RegExp(`^blobs/${P}/${row.artifact_id}/rev_[A-Za-z0-9_-]+$`), "final_key fixed at begin");
  assert.equal(row.staging_key, `staging/${P}/${id}`, "staging_key still filled in");
  const p = await w.put(id, PNG);
  assert.equal(p.status, 200);
  assert.deepEqual(await p.json(), { upload_id: id, received_bytes: PNG.length, sha256: SHA, matches_declared: true });
  assert.deepEqual([w.row(id).received_size, w.row(id).received_sha256, w.row(id).final_writes], [PNG.length, SHA, 0]);
  const f = await lib.uploadFinish(w.ctx, P, id, "finish-1");
  assert.equal(f.status, 200, JSON.stringify(f.body));
  assert.deepEqual(calls.put.map((c) => [c.k, c.o.sha256, c.o.httpMetadata.contentType]), [[row.final_key, SHA, "image/png"]]);
  assert.ok(calls.get.every((c) => c.o?.range && c.o.range.length <= 16), JSON.stringify(calls.get));
  assert.equal(calls.get.length, 1);
  assert.deepEqual(w.revisions(row.artifact_id).map((r) => r.blob_key), [row.final_key]);
  assert.equal(w.blobs.has(row.staging_key), false, "nothing is ever at staging_key");
  assert.equal(w.row(id).state, "published");
});

test("wrong bytes at the right length: 422 integrity_mismatch ends the upload; re-PUT 409, finish replays 422, a new begin succeeds", async () => {
  const w = world();
  const id = await beginAs(w, PNG);
  const key = w.row(id).final_key;
  const evil = Buffer.from(PNG); evil[PNG.length - 3] ^= 0xff;
  await assert.rejects(w.put(id, evil), (e) => e.status === 422 && e.code === "integrity_mismatch");
  assert.equal(w.blobs.has(key), false, "nothing at final_key");
  const row = w.row(id);
  assert.deepEqual([row.state, row.final_writes, JSON.parse(row.result).code], ["failed", 0, "integrity_mismatch"]);
  assert.ok(row.final_purged_at > 0 && row.staging_purged_at > 0, "nothing stored, so nothing left to purge");
  assert.equal(await quotaUsed(w), 0, "quota freed at once");
  await assert.rejects(w.put(id, PNG), (e) => e.status === 409 && e.code === "upload_not_writable");
  await assert.rejects(lib.uploadFinish(w.ctx, P, id, "finish-after-422"), (e) => e.status === 422 && e.code === "integrity_mismatch");
  // The identity's one upload slot is free again.
  const again = await beginAs(w, PNG);
  assert.equal((await w.put(again, PNG)).status, 200);
  const f = await lib.uploadFinish(w.ctx, P, again, "finish-new");
  assert.equal(f.status, 200);
  assert.equal(f.body.sha256, SHA);
});

test("Content-Length other than the declared size is refused before any R2 write; short and long streams are mapped", async () => {
  const w = world();
  const calls = spy(w);
  const id = await beginAs(w, PNG);
  await assert.rejects(w.put(id, PNG.subarray(0, 10)), (e) => e.status === 400 && e.code === "incomplete_body");
  await assert.rejects(w.put(id, Buffer.concat([PNG, Buffer.alloc(1)])), (e) => e.status === 413);
  assert.deepEqual(calls.put, [], "no R2 write");
  assert.deepEqual([w.row(id).state, w.row(id).final_writes], ["pending", 0]);
  // A body that disagrees with its own (absent) length: R2's FixedLengthStream decides, mapped to the same codes.
  const stream = (b) => new ReadableStream({ start(c) { c.enqueue(new Uint8Array(b)); c.close(); } });
  const raw = (b) => lib.uploadPut(new Request("https://example.test/api/transfers/" + id, { method: "PUT", body: stream(b), duplex: "half" }), w.env, w.ctx.requestId, id, w.ctx);
  await assert.rejects(raw(PNG.subarray(0, 10)), (e) => e.status === 400 && e.code === "incomplete_body");
  await assert.rejects(raw(Buffer.concat([PNG, Buffer.alloc(1)])), (e) => e.status === 413);
  assert.deepEqual([w.row(id).state, w.row(id).final_writes], ["pending", 0]);
  assert.equal((await raw(PNG)).status, 200);
});

// F2: final_key is set at begin, so a terminal row matches both "staging not purged" and "final_key not purged".
test("quota: one failed upload is charged exactly once (staging and final_key both unpurged), and old staging-only rows once", async () => {
  const w = world();
  const { id } = w.upload({ state: "failed", expiresAt: Date.now() - 1000 });
  assert.deepEqual([w.row(id).staging_purged_at, w.row(id).final_purged_at], [null, null]);
  assert.equal(await quotaUsed(w), PNG.length, "charged once");
  // An old-Worker row: bytes at staging_key, no final_key.
  const old = w.upload({ state: "failed", expiresAt: Date.now() - 1000 });
  w.sql.prepare("UPDATE uploads SET final_key = NULL WHERE id = ?").run(old.id);
  assert.equal(await quotaUsed(w), 2 * PNG.length, "the old row once too");
  // Purged in R2: no longer charged.
  w.sql.prepare("UPDATE uploads SET staging_purged_at = 1, final_purged_at = 1").run();
  assert.equal(await quotaUsed(w), 0);
});

test("a malformed Content-Length is refused 400 invalid_input before the claim", async () => {
  const w = world();
  const calls = spy(w);
  const id = await beginAs(w, PNG);
  // A Request normalises its own headers, so the handler sees exactly these values through a plain request-like object.
  for (const cl of ["abc", "-1", "1.5", "1e2", "", " ", "0x44"]) {
    const req = { headers: new Headers([["content-length", cl]]), body: new Blob([PNG]).stream() };
    await assert.rejects(lib.uploadPut(req, w.env, w.ctx.requestId, id, w.ctx), (e) => e.status === 400 && e.code === "invalid_input", JSON.stringify(cl));
  }
  assert.deepEqual([w.row(id).state, w.row(id).final_writes, calls.put.length], ["pending", 0, 0], "never claimed, nothing written");
  assert.equal((await w.put(id, PNG)).status, 200);
});

test("the PUT re-checks the grant when it records the bytes: revoked mid-transfer gives 403 and the upload is not received", async () => {
  const w = world();
  const id = await beginAs(w, PNG);
  // Revoke write access (here: the owner leaves the project's workspace) while the R2 write is in flight.
  w.r2.beforeCommit = async () => { w.r2.beforeCommit = null; w.sql.prepare("UPDATE projects SET deleted_at = 1 WHERE id = ?").run(P); };
  await assert.rejects(w.put(id, PNG), (e) => e.status === 403);
  assert.notEqual(w.row(id).state, "received");
});

test("finish fails closed (500 publish_failed) when R2 recorded no SHA-256, and leaves final_key purgeable", async () => {
  const w = world();
  const id = await beginAs(w, PNG);
  assert.equal((await w.put(id, PNG)).status, 200);
  const head = w.env.BLOBS.head;
  w.env.BLOBS.head = async (k) => ({ size: (await head(k)).size });
  await assert.rejects(lib.uploadFinish(w.ctx, P, id, "finish-nosha"), (e) => e.status === 500 && e.code === "publish_failed");
  assert.equal(w.row(id).state, "failed");
  assert.ok(w.row(id).final_purged_at, "unreferenced object removed");
  assert.deepEqual(w.finals(), []);
});

// F4: an upload the previous Worker already PUT has its bytes at staging_key and no final_key.
for (const state of ["received", "sealed"]) {
  test(`deploy: an old-Worker upload (${state}, bytes at staging_key, final_key NULL) fails 409 reupload_required and its staging object is purged`, async () => {
    const w = world();
    const { id, art } = w.upload({ state });
    const u = w.row(id);
    w.blobs.delete(u.final_key);
    w.blobs.set(u.staging_key, PNG);
    w.sql.prepare("UPDATE uploads SET final_key = NULL WHERE id = ?").run(id);
    await assert.rejects(lib.uploadFinish(w.ctx, P, id, "finish-old-" + state), (e) => e.status === 409 && e.code === "reupload_required" && /upload_begin/.test(e.message));
    assert.deepEqual([w.row(id).state, w.row(id).final_key, JSON.parse(w.row(id).result).code], ["failed", null, "reupload_required"]);
    await assert.rejects(lib.uploadFinish(w.ctx, P, id, "finish-old-again"), (e) => e.code === "reupload_required", "replayed");
    await lib.reconcileUploads(w.env);
    assert.equal(w.blobs.has(u.staging_key), false, "staging object purged");
    assert.ok(w.row(id).staging_purged_at > 0);
    assert.deepEqual(w.finals(), []);
    assert.deepEqual(w.revisions(art), []);
  });
}

test("rollback: the previous Worker's staging cleanup on a published row touches nothing referenced", async () => {
  const w = world();
  const id = await beginAs(w, PNG);
  assert.equal((await w.put(id, PNG)).status, 200);
  assert.equal((await lib.uploadFinish(w.ctx, P, id, "finish-rb")).status, 200);
  const u = w.row(id);
  // The previous Worker's cleanup deletes staging_key for every terminal upload with staging_purged_at NULL.
  const [rev] = w.revisions(u.artifact_id);
  assert.notEqual(u.staging_key, rev.blob_key);
  w.blobs.delete(u.staging_key);
  assert.ok(w.blobs.has(rev.blob_key), "published bytes survive");
});

// End to end under local wrangler (miniflare R2 enforces the put sha256 option).
const MiB = 1024 * 1024;
let s, A, token;
const E = "proj-single-pass";
before(async () => {
  s = await startServer("single-pass-uploads", SERVER_PORTS["single-pass-uploads"], {
    vars: { RATE_READS_PER_MIN: "100000", RATE_WRITES_PER_MIN: "100000", RATE_AUTHFAIL_PER_MIN: "100000", FILE_MAX_BYTES: String(40 * MiB), PROJECT_BINARY_BYTES: "0" },
  });
  const h = await s.login();
  await setupProject(h, E);
  token = (await grant(h, E, "single-pass uploader")).token;
  A = agentHttp(s.base, token);
});
after(async () => { await s?.stop(); });
const pngLike = (n) => { const b = randomBytes(n); Buffer.from("89504e470d0a1a0a", "hex").copy(b); return b; };
const begin = (title, size, digest) => A("POST", `/api/projects/${E}/uploads`, { title, mime: "image/png", size, sha256: digest });
const putHttp = (url, body) => A("PUT", url, undefined, { raw: body, headers: { "content-type": "application/octet-stream" } });
const finish = (id) => A("POST", `/api/projects/${E}/uploads/${id}/finish`);

test("local R2: wrong bytes at the right length are refused 422 at PUT and end the upload; a new begin publishes", async () => {
  const bytes = pngLike(2 * MiB);
  const b = await begin("tampered", bytes.length, sha256(bytes));
  const evil = Buffer.from(bytes); evil[MiB] ^= 0xff;
  const bad = await putHttp(b.body.put_url, evil);
  assert.equal(bad.status, 422, JSON.stringify(bad.body));
  assert.equal(bad.body.error.code, "integrity_mismatch");
  // (Re-PUT 409 is checked in the unit test above and in a6: local wrangler answers the request after a refused, unread
  // multi-MiB body with 503 "worker restarted mid-request".)
  const f1 = await finish(b.body.upload_id);
  assert.deepEqual([f1.status, f1.body?.error?.code], [422, "integrity_mismatch"], JSON.stringify(f1.body));
  const b2 = await begin("tampered", bytes.length, sha256(bytes));
  assert.equal(b2.status, 201, JSON.stringify(b2.body));
  const ok = await putHttp(b2.body.put_url, bytes);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const f = await finish(b2.body.upload_id);
  assert.equal(f.status, 200, JSON.stringify(f.body));
  assert.equal(f.body.sha256, sha256(bytes));
});

test("local R2: a 30 MiB file publishes in one pass and reads back whole and by Range", async () => {
  const big = pngLike(30 * MiB + 321);
  const b = await begin("large single pass", big.length, sha256(big));
  assert.equal(b.status, 201, JSON.stringify(b.body));
  const p = await putHttp(b.body.put_url, big);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.deepEqual([p.body.received_bytes, p.body.sha256, p.body.matches_declared], [big.length, sha256(big), true]);
  const f = await finish(b.body.upload_id);
  assert.equal(f.status, 200, JSON.stringify(f.body));
  const url = `/api/projects/${E}/artifacts/${f.body.artifact_id}/content`;
  const whole = await A("GET", url, undefined, { binary: true });
  assert.equal(whole.status, 200);
  assert.equal(sha256(whole.body), sha256(big));
  const at = 23 * MiB + 9;
  const r = await A("GET", url, undefined, { binary: true, headers: { range: `bytes=${at}-${at + 8191}` } });
  assert.equal(r.status, 206);
  assert.ok(r.body.equals(big.subarray(at, at + 8192)));
});
