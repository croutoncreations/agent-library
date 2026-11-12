// Slice 3b, encrypted binary file versions, in real workerd (design test 1: the probe). The probe Worker
// (test/fixtures/workerd-encryption-probe.mjs) runs the real crypto/chunked.js against the local R2 binding; each
// workerd behaviour the encrypted PUT and read paths rely on is its own assertion, with the observed value in the
// failure message. Synthetic random bytes and keys only, generated inside the probe; no key material leaves it.
//
// A read that fails mid-body must fail closed: the client never gets a 200/206 whose body delivers all Content-Length
// bytes. Locally that is all (e1) gates on: wrangler dev's proxy may re-run a failed GET up to three times and answer
// 500 itself, so no Real (listener) test may count R2 requests on a read that fails mid-body; such counts belong in
// World tests (test/upload-world.mjs), which have no proxy. Whether production workerd aborts the body mid-stream is
// checked on a deployed Worker, not here.
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

/** Fetch the erroring body and read it to the end or the first error; reports what the client saw. */
async function readErroring(query) {
  const r = await fetch(probe.base + "/probe/e?" + query);
  const declared = r.headers.get("content-length") === null ? null : Number(r.headers.get("content-length"));
  let received = 0, error = null;
  try {
    const reader = r.body.getReader();
    for (;;) { const { done, value } = await reader.read(); if (done) break; received += value.byteLength; }
  } catch (e) { error = `${e.name}: ${e.message}${e.cause ? ` (cause: ${e.cause.message ?? e.cause})` : ""}`; }
  return { status: r.status, declared, received, readRejected: error !== null, error };
}

test("probe (e1): a response body that errors after its first chunk fails closed (never a complete 200/206)", async () => {
  const id = `e1-${Date.now()}`;
  const o = await readErroring(`id=${id}`);
  const complete = (o.status === 200 || o.status === 206) && !o.readRejected && o.declared !== null && o.received >= o.declared;
  assert.equal(complete, false, `the client got a response that looks complete: ${seen(o)}`);
  const { invocations } = await get(`/probe/e-count?id=${id}`);
  console.log(`probe (e1) observed: ${seen({ ...o, invocations })}`);
});

test("probe (e2), information only: the same body erroring 500 ms after the first chunk, and how often the handler ran", async () => {
  const id = `e2-${Date.now()}`;
  const o = await readErroring(`id=${id}&delay=500`);
  const { invocations } = await get(`/probe/e-count?id=${id}`);
  console.log(`probe (e2) observed: ${seen({ ...o, invocations })}`);
  assert.equal(typeof o.status, "number", seen(o));
});

test("probe (f), information only: does an R2 conditional put (onlyIf) refuse to overwrite an existing object", async () => {
  const r = await get("/probe/f");
  console.log(`probe (f) observed: ${seen(r)}`);
  assert.equal(typeof r.firstPutOnNewKey, "string", seen(r));
});
