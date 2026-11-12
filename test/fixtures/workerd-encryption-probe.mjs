// Scratch Worker for test/encryption-files.test.mjs test 1 (the slice 3b probe): runs the real crypto/chunked.js in
// workerd against the local R2 binding and reports what it observed. Synthetic random bytes and keys only; nothing
// here returns key material. Never deployed.
import { encryptChunkedStream, decryptChunkedStream, chunkedStoredLength } from "../../packages/core/src/crypto/chunked.js";

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const random = (n) => { const out = new Uint8Array(n); for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536))); return out; };
const dataKey = () => crypto.subtle.importKey("raw", random(32), "HKDF", false, ["deriveKey"]);
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const errorText = (e) => `${e?.name ?? "Error"}: ${e?.message ?? String(e)}`;

/** Byte stream of `bytes` in pieces of the given sizes (cycled), pull-driven. */
function piecewise(bytes, sizes) {
  let at = 0, i = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) { controller.close(); return; }
      const n = sizes[i++ % sizes.length];
      controller.enqueue(bytes.slice(at, at + n));
      at += n;
    },
  }, { highWaterMark: 0 });
}

/** The design's plainTap: count, copy, enqueue, then hash the copy; flush checks count and SHA-256. */
function plainTap(size, sha256) {
  const digest = new crypto.DigestStream("SHA-256");
  const digestWriter = digest.getWriter();
  const flags = { tooLong: false, tooShort: false, mismatch: false, count: 0, sha256: null };
  const stream = new TransformStream({
    async transform(chunk, out) {
      flags.count += chunk.byteLength;
      if (flags.count > size) { flags.tooLong = true; throw new Error("body is longer than declared"); }
      const copy = chunk.slice();
      out.enqueue(chunk);
      await digestWriter.write(copy);
    },
    async flush() {
      await digestWriter.close();
      if (flags.count < size) { flags.tooShort = true; throw new Error("body is shorter than declared"); }
      flags.sha256 = hex(await digest.digest);
      if (flags.sha256 !== sha256) { flags.mismatch = true; throw new Error("body SHA-256 differs from the declaration"); }
    },
  });
  return { stream, flags };
}

async function readAll(stream) {
  const parts = []; let n = 0;
  const reader = stream.getReader();
  for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); n += value.byteLength; }
  const out = new Uint8Array(n); let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}
const equal = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// (a) DigestStream over chunked writes, and plainTap's copy-enqueue-hash order leaving the encryptor's input intact.
async function probeDigest() {
  const bytes = random(200_000);
  const expected = hex(await crypto.subtle.digest("SHA-256", bytes));
  const ds = new crypto.DigestStream("SHA-256");
  const w = ds.getWriter();
  for (let at = 0, i = 0; at < bytes.length; i++) { const n = [1, 7, 4096, 65536, 100_000][i % 5]; await w.write(bytes.slice(at, at + n)); at += n; }
  await w.close();
  const digestStreamHex = hex(await ds.digest);
  const key = await dataKey();
  const tap = plainTap(bytes.length, expected);
  const stored = await readAll(encryptChunkedStream(piecewise(bytes, [1000, 65536, 3]).pipeThrough(tap.stream), { plaintextLength: bytes.length, dataKey: key, objectKey: "probe/a" }));
  const plain = await readAll(decryptChunkedStream(piecewise(stored, [stored.length]), { dataKey: key, objectKey: "probe/a" }));
  return { expected, digestStreamHex, tapSha256: tap.flags.sha256, tapCount: tap.flags.count, storedLength: stored.length,
    expectedStoredLength: chunkedStoredLength(bytes.length), roundTrip: equal(plain, bytes) };
}

// (b) 200,000 bytes, pull-driven encryptor through FixedLengthStream(chunkedStoredLength(n)) into BLOBS.put.
async function probePut(env) {
  const n = 200_000, bytes = random(n), objectKey = `probe/b/${hex(random(8))}`;
  const key = await dataKey();
  const sha = hex(await crypto.subtle.digest("SHA-256", bytes));
  const tap = plainTap(n, sha);
  const body = encryptChunkedStream(piecewise(bytes, [8192]).pipeThrough(tap.stream), { plaintextLength: n, dataKey: key, objectKey })
    .pipeThrough(new FixedLengthStream(chunkedStoredLength(n)));
  const put = await env.BLOBS.put(objectKey, body, { httpMetadata: { contentType: "application/octet-stream" }, customMetadata: { "al-enc": "1", "al-key": "key_probe" } });
  const head = await env.BLOBS.head(objectKey);
  const got = await env.BLOBS.get(objectKey);
  const plain = await readAll(decryptChunkedStream(got.body, { dataKey: key, objectKey }));
  return { putSize: put?.size ?? null, headSize: head?.size ?? null, expectedStoredLength: chunkedStoredLength(n), decrypts: equal(plain, bytes) };
}

// (c) plainTap throwing in flush (wrong SHA-256) makes put reject; head then returns null.
async function probeFlushThrow(env, n) {
  const bytes = random(n), objectKey = `probe/c/${n}/${hex(random(8))}`;
  const tap = plainTap(n, "0".repeat(64));
  const body = encryptChunkedStream(piecewise(bytes, [4096]).pipeThrough(tap.stream), { plaintextLength: n, dataKey: await dataKey(), objectKey })
    .pipeThrough(new FixedLengthStream(chunkedStoredLength(n)));
  let putRejected = false, putError = null, putSize = null;
  try { const r = await env.BLOBS.put(objectKey, body, { customMetadata: { "al-enc": "1", "al-key": "key_probe" } }); putSize = r?.size ?? null; }
  catch (e) { putRejected = true; putError = errorText(e); }
  const head = await env.BLOBS.head(objectKey);
  return { size: n, putRejected, putError, putSize, mismatchFlag: tap.flags.mismatch, headIsNull: head === null, headSize: head?.size ?? null };
}

// (d) a ranged get returns customMetadata and the whole-object size.
async function probeRange(env) {
  const objectKey = `probe/d/${hex(random(8))}`;
  await env.BLOBS.put(objectKey, random(100_000), { customMetadata: { "al-enc": "1", "al-key": "key_probe" } });
  const o = await env.BLOBS.get(objectKey, { range: { offset: 65_584, length: 100 } });
  const body = new Uint8Array(await o.arrayBuffer());
  return { size: o.size, customMetadata: o.customMetadata ?? null, range: o.range ?? null, bodyLength: body.length };
}

// (e) a body that errors after its first chunk, with a Content-Length.
function erroringBody() {
  const length = 300_000;
  let sent = false;
  const body = new ReadableStream({
    pull(controller) {
      if (!sent) { sent = true; controller.enqueue(random(65_536)); return; }
      controller.error(new Error("probe: chunk 1 failed authentication"));
    },
  }, { highWaterMark: 0 });
  return new Response(body.pipeThrough(new FixedLengthStream(length)), { headers: { "content-type": "application/octet-stream" } });
}

// (f) does an R2 conditional put refuse to overwrite an existing object? Information only.
async function probeOnlyIf(env) {
  const objectKey = `probe/f/${hex(random(8))}`;
  const first = random(32), second = random(32);
  const r1 = await env.BLOBS.put(objectKey, first, { onlyIf: { etagDoesNotMatch: "*" } });
  let r2 = undefined, r2Error = null;
  try { r2 = await env.BLOBS.put(objectKey, second, { onlyIf: { etagDoesNotMatch: "*" } }); } catch (e) { r2Error = errorText(e); }
  const now = new Uint8Array(await (await env.BLOBS.get(objectKey)).arrayBuffer());
  let r3 = undefined, r3Error = null;
  const etag = r1?.etag;
  try { r3 = await env.BLOBS.put(objectKey, second, { onlyIf: { etagDoesNotMatch: etag } }); } catch (e) { r3Error = errorText(e); }
  const after3 = new Uint8Array(await (await env.BLOBS.get(objectKey)).arrayBuffer());
  return {
    firstPutOnNewKey: r1 === null ? "null (refused)" : "object (stored)",
    secondPutEtagDoesNotMatchStar: r2Error ?? (r2 === null ? "null (refused)" : "object (stored)"),
    objectAfterSecondPut: equal(now, first) ? "first bytes (not overwritten)" : equal(now, second) ? "second bytes (overwritten)" : "other",
    thirdPutEtagDoesNotMatchOwnEtag: r3Error ?? (r3 === null ? "null (refused)" : "object (stored)"),
    objectAfterThirdPut: equal(after3, first) ? "first bytes (not overwritten)" : equal(after3, second) ? "second bytes (overwritten)" : "other",
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case "/api/me": return json({ error: "unauthenticated" }, 401); // startServer's readiness check
        case "/probe/a": return json(await probeDigest());
        case "/probe/b": return json(await probePut(env));
        case "/probe/c": return json(await probeFlushThrow(env, Number(url.searchParams.get("size"))));
        case "/probe/d": return json(await probeRange(env));
        case "/probe/e": return erroringBody();
        case "/probe/f": return json(await probeOnlyIf(env));
        default: return json({ error: "not_found" }, 404);
      }
    } catch (e) {
      return json({ probeError: errorText(e), stack: String(e?.stack ?? "") }, 500);
    }
  },
};
