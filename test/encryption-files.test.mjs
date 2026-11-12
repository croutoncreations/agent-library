// Slice 3b, encrypted binary file versions, in real workerd (design test 1: the probe). The probe Worker
// (test/fixtures/workerd-encryption-probe.mjs) runs the real crypto/chunked.js against the local R2 binding; each
// workerd behaviour the encrypted PUT and read paths rely on is its own assertion, with the observed value in the
// failure message. Synthetic random bytes and keys only, generated inside the probe; no key material leaves it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { startServer, ROOT } from "./helpers.mjs";
import { SERVER_PORTS } from "./ports.mjs";
import { buildWorker } from "../scripts/build.mjs";

const PORT = SERVER_PORTS["encryption-files"];
let probe;
const get = async (path) => {
  const r = await fetch(probe.base + path);
  const body = await r.json();
  assert.equal(r.status, 200, `probe ${path} failed: ${JSON.stringify(body)}`);
  return body;
};
const seen = (v) => JSON.stringify(v);

before(async () => {
  const out = join(ROOT, "tmp", "test-worker-encryption-probe", "index.js");
  await buildWorker({ entry: join(ROOT, "test/fixtures/workerd-encryption-probe.mjs"), outfile: out });
  probe = await startServer("encryption-files", PORT, { worker: out, vars: {} });
});
after(async () => { await probe?.stop(); });

test("probe (a): crypto.DigestStream over chunked writes, and plainTap's copy-enqueue-hash order", async () => {
  const r = await get("/probe/a");
  assert.equal(r.digestStreamHex, r.expected, `DigestStream over chunked writes: ${seen(r)}`);
  assert.equal(r.tapSha256, r.expected, `plainTap's SHA-256: ${seen(r)}`);
  assert.equal(r.tapCount, 200_000, `plainTap's count: ${seen(r)}`);
  assert.equal(r.storedLength, r.expectedStoredLength, `encryptor output length: ${seen(r)}`);
  assert.equal(r.roundTrip, true, `encryptor input intact after plainTap (decrypts to the original): ${seen(r)}`);
});

test("probe (b): a pull-driven encryptor through FixedLengthStream(chunkedStoredLength) into BLOBS.put", async () => {
  const r = await get("/probe/b");
  assert.equal(r.putSize, r.expectedStoredLength, `put() size: ${seen(r)}`);
  assert.equal(r.headSize, r.expectedStoredLength, `head() size: ${seen(r)}`);
  assert.equal(r.decrypts, true, `stored object decrypts to the original: ${seen(r)}`);
});

for (const size of [1, 65_536]) {
  test(`probe (c): a plainTap flush throw (wrong SHA-256) at ${size} bytes makes put reject and stores nothing`, async () => {
    const r = await get(`/probe/c?size=${size}`);
    assert.equal(r.mismatchFlag, true, `plainTap flagged the mismatch: ${seen(r)}`);
    assert.equal(r.putRejected, true, `put() rejected: ${seen(r)}`);
    assert.equal(r.headIsNull, true, `head() after the rejected put is null: ${seen(r)}`);
  });
}

test("probe (d): a ranged get returns customMetadata and the whole-object size", async () => {
  const r = await get("/probe/d");
  assert.deepEqual(r.customMetadata, { "al-enc": "1", "al-key": "key_probe" }, `ranged get customMetadata: ${seen(r)}`);
  assert.equal(r.size, 100_000, `ranged get size is the whole object's: ${seen(r)}`);
  assert.equal(r.bodyLength, 100, `ranged get body length: ${seen(r)}`);
});

test("probe (e): a response body that errors after its first chunk makes the client's read reject short of Content-Length", async () => {
  const r = await fetch(probe.base + "/probe/e");
  assert.equal(r.status, 200);
  const declared = Number(r.headers.get("content-length"));
  const reader = r.body.getReader();
  let received = 0, error = null;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; received += value.byteLength; }
  } catch (e) { error = e; }
  const observed = { declared, received, error: error ? `${error.name}: ${error.message}${error.cause ? ` (cause: ${error.cause.message ?? error.cause})` : ""}` : null };
  assert.equal(declared, 300_000, `Content-Length: ${seen(observed)}`);
  assert.ok(error, `the body read rejected: ${seen(observed)}`);
  assert.ok(received < declared, `fewer bytes than Content-Length: ${seen(observed)}`);
});

test("probe (f), information only: does an R2 conditional put (onlyIf) refuse to overwrite an existing object", async () => {
  const r = await get("/probe/f");
  console.log(`probe (f) observed: ${seen(r)}`);
  assert.equal(typeof r.firstPutOnNewKey, "string", seen(r));
});
