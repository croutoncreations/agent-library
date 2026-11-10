// Large files (up to FILE_BYTES_CEILING, 90 MiB) stream through uploadPut/uploadFinish in constant Worker memory:
// a ~30 MiB synthetic file goes begin -> PUT -> finish under local wrangler with FILE_MAX_BYTES raised, then is read
// whole and by Range; signature, integrity, short/long body and backup-export checks still hold. The static guard
// keeps whole-object reads out of uploads.js. (Miniflare may buffer internally; the Worker code path does not.)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ROOT, startServer, agentHttp, setupProject, grant, sha256, key } from "./helpers.mjs";
import { SERVER_PORTS } from "./ports.mjs";

const P = "proj-large";
const MiB = 1024 * 1024;
let s, A, token;
before(async () => {
  s = await startServer("large-uploads", SERVER_PORTS["large-uploads"], {
    vars: { RATE_READS_PER_MIN: "100000", RATE_WRITES_PER_MIN: "100000", RATE_AUTHFAIL_PER_MIN: "100000", FILE_MAX_BYTES: String(40 * MiB), PROJECT_BINARY_BYTES: "0" },
  });
  const h = await s.login();
  await setupProject(h, P);
  token = (await grant(h, P, "large uploader")).token;
  A = agentHttp(s.base, token);
});
after(async () => { await s?.stop(); });

// Synthetic PNG-signed bytes: the PNG magic number, then random filler.
const pngLike = (n) => { const b = randomBytes(n); Buffer.from("89504e470d0a1a0a", "hex").copy(b); return b; };
const begin = (title, mime, size, digest) => A("POST", `/api/projects/${P}/uploads`, { title, mime, size, sha256: digest });
const put = (url, body, headers = {}) => A("PUT", url, undefined, { raw: body, headers: { "content-type": "application/octet-stream", ...headers } });
const finish = (id) => A("POST", `/api/projects/${P}/uploads/${id}/finish`);
// A body without Content-Length (chunked transfer), sent in 1 MiB pieces.
const chunked = (bytes) => new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += MiB) c.enqueue(bytes.subarray(i, i + MiB)); c.close(); } });
const putChunked = (url, bytes) => fetch(s.base + url, { method: "PUT", body: chunked(bytes), duplex: "half", headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" } });

let big, bigId;
test("a 30 MiB file: begin -> PUT -> finish, sha256 matches, whole and Range reads return its bytes", async () => {
  big = pngLike(30 * MiB + 123);
  const b = await begin("large synthetic", "image/png", big.length, sha256(big));
  assert.equal(b.status, 201, JSON.stringify(b.body));
  const p = await put(b.body.put_url, big);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.deepEqual([p.body.received_bytes, p.body.sha256, p.body.matches_declared], [big.length, sha256(big), true]);
  const f = await finish(b.body.upload_id);
  assert.equal(f.status, 200, JSON.stringify(f.body));
  assert.deepEqual([f.body.sha256, f.body.size], [sha256(big), big.length]);
  bigId = f.body.artifact_id;
  const url = `/api/projects/${P}/artifacts/${bigId}/content`;
  const whole = await A("GET", url, undefined, { binary: true });
  assert.equal(whole.status, 200);
  assert.equal(sha256(whole.body), sha256(big));
  const at = 17 * MiB + 5;
  const r = await A("GET", url, undefined, { binary: true, headers: { range: `bytes=${at}-${at + 4095}` } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get("content-range"), `bytes ${at}-${at + 4095}/${big.length}`);
  assert.ok(r.body.equals(big.subarray(at, at + 4096)));
});

test("a chunked body (no Content-Length) of the declared size streams and publishes", async () => {
  const bytes = pngLike(3 * MiB + 7);
  const b = await begin("chunked", "image/png", bytes.length, sha256(bytes));
  const p = await putChunked(b.body.put_url, bytes);
  assert.equal(p.status, 200, await p.clone().text());
  assert.equal((await p.json()).matches_declared, true);
  const f = await finish(b.body.upload_id);
  assert.equal(f.status, 200, JSON.stringify(f.body));
  assert.equal(f.body.sha256, sha256(bytes));
});

test("a chunked body shorter than declared is refused 400 and the upload stays writable; longer is 413", async () => {
  const bytes = pngLike(2 * MiB);
  const b = await begin("chunked short", "image/png", bytes.length, sha256(bytes));
  const short = await putChunked(b.body.put_url, bytes.subarray(0, MiB + 3));
  assert.equal(short.status, 400);
  assert.equal((await short.json()).error.code, "incomplete_body");
  const long = await putChunked(b.body.put_url, Buffer.concat([bytes, Buffer.alloc(10)]));
  assert.equal(long.status, 413);
  const ok = await put(b.body.put_url, bytes);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await finish(b.body.upload_id)).status, 200);
});

test("declared image/png with random bytes still fails 415 signature_mismatch", async () => {
  const bytes = randomBytes(5 * MiB);
  bytes[0] = 0; // never the PNG magic number
  const b = await begin("not a png", "image/png", bytes.length, sha256(bytes));
  assert.equal((await put(b.body.put_url, bytes)).status, 200);
  const f = await finish(b.body.upload_id);
  assert.equal(f.status, 415);
  assert.equal(f.body.error.code, "signature_mismatch");
});

test("one tampered byte fails 422 integrity_mismatch at PUT and ends the upload; a new upload of the correct bytes publishes", async () => {
  const bytes = pngLike(8 * MiB);
  const b = await begin("tampered", "image/png", bytes.length, sha256(bytes));
  const evil = Buffer.from(bytes); evil[6 * MiB] ^= 0xff;
  const p = await put(b.body.put_url, evil);
  assert.equal(p.status, 422);
  assert.equal(p.body.error.code, "integrity_mismatch");
  assert.equal((await finish(b.body.upload_id)).status, 422, "finish replays the 422 (re-PUT 409: single-pass-uploads, a6)");
  const b2 = await begin("tampered", "image/png", bytes.length, sha256(bytes));
  assert.equal((await put(b2.body.put_url, bytes)).status, 200);
  assert.equal((await finish(b2.body.upload_id)).status, 200);
});

test("a file over the configured limit is refused 413 at begin", async () => {
  const r = await begin("too big", "image/png", 40 * MiB + 1, "c".repeat(64));
  assert.equal(r.status, 413);
  assert.deepEqual([r.body.error.limit, r.body.error.allowed], ["file_bytes", 40 * MiB]);
});

test("backup export refuses a project whose files exceed 16 MB, before reading them", async () => {
  const h = await s.login();
  const r = await h.req("GET", `/api/projects/${P}/backup`);
  assert.equal(r.status, 413);
  assert.equal(r.body.error.code, "backup_too_large");
  assert.match(r.body.error.message, /over 16 MB\). Download large files individually\.$/);
});

test("uploads.js never reads a whole stored object into memory", () => {
  const src = readFileSync(join(ROOT, "packages", "core", "src", "uploads.js"), "utf8");
  assert.doesNotMatch(src, /\.arrayBuffer\(\)|getBlobBytes|new Uint8Array\(n\)/);
});
