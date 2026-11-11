// Chunked AES-GCM object format, version 1 (packages/core/src/crypto/chunked.js). Real WebCrypto, no listeners.
// The module is loaded from its shipped source through test/module-source.mjs (never a copy). The known-answer
// test recomputes the stored bytes independently with node:crypto so the format is pinned, not just self-consistent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, hkdfSync, randomBytes } from "node:crypto";
import { moduleScript } from "./module-source.mjs";

const EXPORTS = [
  "CHUNKED_HEADER_BYTES", "CHUNKED_CHUNK_BYTES", "CHUNKED_TAG_BYTES", "CHUNKED_MAX_PLAINTEXT_BYTES",
  "chunkedStoredLength", "chunkedPlaintextLength", "encodeChunkedHeader", "parseChunkedHeader",
  "encryptChunkedStream", "encryptChunkedStreamWithSaltForTestOnly", "decryptChunkedStream",
  "planChunkedRange", "decryptChunkedRange",
];
const mod = new Function(`${moduleScript("packages/core/src/crypto/chunked.js")}\nreturn { ${EXPORTS.join(", ")} };`)();
const {
  CHUNKED_HEADER_BYTES, CHUNKED_CHUNK_BYTES, CHUNKED_TAG_BYTES, CHUNKED_MAX_PLAINTEXT_BYTES,
  chunkedStoredLength, chunkedPlaintextLength, encodeChunkedHeader, parseChunkedHeader,
  encryptChunkedStream, encryptChunkedStreamWithSaltForTestOnly, decryptChunkedStream,
  planChunkedRange, decryptChunkedRange,
} = mod;

const C = 65536;
const H = 48;
const T = 16;
const SC = C + T; // stored size of one full chunk

/** The workspace data key as the key provider hands it over: HKDF, not extractable, deriveKey only. */
async function dataKeyFrom(bytes) {
  return crypto.subtle.importKey("raw", bytes, "HKDF", false, ["deriveKey"]);
}
const DATA_KEY_BYTES = new Uint8Array(32).map((_, i) => i + 1);
const DATA_KEY = await dataKeyFrom(DATA_KEY_BYTES);
const OTHER_DATA_KEY = await dataKeyFrom(new Uint8Array(32).fill(7));
const OBJECT_KEY = "blobs/prj_example/art_example/ver_1";

function plaintextOf(length, seed = 1) {
  const out = new Uint8Array(length);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) { x = (x * 1103515245 + 12345) >>> 0; out[i] = x >>> 24; }
  return out;
}

/** A pull-driven source delivering `bytes` in pieces of the given sizes (cycled). */
function sourceOf(bytes, pieceSizes = [C]) {
  let offset = 0;
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      const size = pieceSizes[i++ % pieceSizes.length];
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  }, { highWaterMark: 0 });
}

/** Read a stream to the end; returns the bytes released before any error, and the error. */
async function drain(stream) {
  const parts = [];
  let error = null;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }
  } catch (e) { error = e; }
  return { bytes: concat(parts), error };
}

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function encryptBytes(plaintext, { pieces, objectKey = OBJECT_KEY, dataKey = DATA_KEY, declared = plaintext.length } = {}) {
  const { bytes, error } = await drain(encryptChunkedStream(sourceOf(plaintext, pieces), { plaintextLength: declared, dataKey, objectKey }));
  if (error) throw error;
  return bytes;
}

async function decryptBytes(stored, { dataKey = DATA_KEY, objectKey = OBJECT_KEY, pieces = [7, C + 3, 1] } = {}) {
  return drain(decryptChunkedStream(sourceOf(stored, pieces), { dataKey, objectKey }));
}

async function assertDecryptFails(stored, message, options) {
  const { bytes, error } = await decryptBytes(stored, options);
  assert.ok(error, `${message}: decryption must fail`);
  return bytes;
}

function chunkSlice(stored, index, plaintextLength) {
  const start = H + index * SC;
  const plain = Math.min(C, plaintextLength - index * C);
  return stored.slice(start, start + plain + T);
}

// ---------------------------------------------------------------- lengths and header

test("chunkedStoredLength follows 48 + len + 16 × max(1, ceil(len / 65536)) and chunkedPlaintextLength reverses it", () => {
  assert.equal(CHUNKED_HEADER_BYTES, 48);
  assert.equal(CHUNKED_CHUNK_BYTES, 65536);
  assert.equal(CHUNKED_TAG_BYTES, 16);
  assert.equal(CHUNKED_MAX_PLAINTEXT_BYTES, 2 ** 40);
  assert.equal(chunkedStoredLength(0), 64);
  assert.equal(chunkedStoredLength(1), 65);
  assert.equal(chunkedStoredLength(65535), 48 + 65535 + 16);
  assert.equal(chunkedStoredLength(65536), 48 + 65536 + 16);
  assert.equal(chunkedStoredLength(65537), 48 + 65537 + 32);
  assert.equal(chunkedStoredLength(90 * 1024 * 1024), 48 + 90 * 1024 * 1024 + 16 * 1440);
  for (const len of [0, 1, 15, 16, 17, 65535, 65536, 65537, 2 * C, 2 * C + 1, 3.5 * C, 90 * 1024 * 1024, 2 ** 40]) {
    assert.equal(chunkedPlaintextLength(chunkedStoredLength(len)), len, `reverse of ${len}`);
  }
  // Stored lengths no plaintext length produces are refused.
  for (const bad of [0, 47, 48, 63, 48 + SC + 1, 48 + SC + 16, 48 + 2 * SC + 5, -1, 1.5]) {
    assert.throws(() => chunkedPlaintextLength(bad), undefined, `stored length ${bad}`);
  }
  for (const bad of [-1, 1.5, 2 ** 40 + 1, Number.MAX_SAFE_INTEGER, NaN, "1"]) {
    assert.throws(() => chunkedStoredLength(bad), undefined, `plaintext length ${String(bad)}`);
  }
});

test("encodeChunkedHeader writes magic, version, exponent, reserved, big-endian length and salt; parseChunkedHeader reads it back", () => {
  const salt = new Uint8Array(32).map((_, i) => 0xa0 + i);
  const header = encodeChunkedHeader({ plaintextLength: 0x0102030405, salt });
  assert.equal(header.length, 48);
  assert.deepEqual([...header.slice(0, 16)], [0x41, 0x4c, 0x45, 0x31, 1, 16, 0, 0, 0, 0, 0, 0x01, 0x02, 0x03, 0x04, 0x05]);
  assert.deepEqual([...header.slice(16)], [...salt]);
  const parsed = parseChunkedHeader(header);
  assert.equal(parsed.plaintextLength, 0x0102030405);
  assert.deepEqual([...parsed.salt], [...salt]);
  assert.throws(() => encodeChunkedHeader({ plaintextLength: 1, salt: new Uint8Array(31) }));
  assert.throws(() => encodeChunkedHeader({ plaintextLength: 2 ** 40 + 1, salt }));
});

test("parseChunkedHeader rejects wrong magic, version, exponent, reserved bytes, length and size", () => {
  const good = encodeChunkedHeader({ plaintextLength: 10, salt: new Uint8Array(32) });
  const mutate = (i, v) => { const h = good.slice(); h[i] = v; return h; };
  assert.throws(() => parseChunkedHeader(mutate(0, 0x42)), /magic/i, "magic");
  assert.throws(() => parseChunkedHeader(mutate(3, 0x32)), /magic/i, "magic last byte");
  assert.throws(() => parseChunkedHeader(mutate(4, 2)), /version/i, "version");
  assert.throws(() => parseChunkedHeader(mutate(4, 0)), /version/i, "version zero");
  assert.throws(() => parseChunkedHeader(mutate(5, 15)), /exponent/i, "exponent");
  assert.throws(() => parseChunkedHeader(mutate(6, 1)), /reserved/i, "reserved byte 6");
  assert.throws(() => parseChunkedHeader(mutate(7, 1)), /reserved/i, "reserved byte 7");
  assert.throws(() => parseChunkedHeader(mutate(10, 1)), /length/i, "length 2^40 + 10");
  assert.throws(() => parseChunkedHeader(mutate(8, 0x80)), /length/i, "length top bit");
  assert.throws(() => parseChunkedHeader(good.slice(0, 47)), /header/i, "short header");
  // Exactly 2^40 is the largest accepted length.
  const max = good.slice(); max.set([0, 0, 1, 0, 0, 0, 0, 0], 8);
  assert.equal(parseChunkedHeader(max).plaintextLength, 2 ** 40);
});

// ---------------------------------------------------------------- round trips

const LENGTHS = [0, 1, 65535, 65536, 65537, 3.5 * C];
const PIECES = { "1 byte": [1], "7 bytes": [7], "larger than a chunk": [C + 1001], "mixed": [1, 7, C + 3, 13] };

for (const len of LENGTHS) {
  for (const [name, pieces] of Object.entries(PIECES)) {
    if (name === "1 byte" && len > C + 1) continue; // 1-byte pieces over 3.5 chunks are covered by "mixed"
    test(`round trip of ${len} bytes with input in ${name} pieces; stored length matches the formula`, async () => {
      const plain = plaintextOf(len, len + 3);
      const stored = await encryptBytes(plain, { pieces });
      assert.equal(stored.length, 48 + len + 16 * Math.max(1, Math.ceil(len / C)));
      assert.equal(stored.length, chunkedStoredLength(len));
      assert.equal(parseChunkedHeader(stored.slice(0, 48)).plaintextLength, len);
      const { bytes, error } = await decryptBytes(stored, { pieces });
      assert.equal(error, null);
      assert.deepEqual(bytes, plain);
    });
  }
}

test("1-byte input pieces over 3.5 chunks round trip", async () => {
  const plain = plaintextOf(3.5 * C, 9);
  const stored = await encryptBytes(plain, { pieces: [1] });
  const { bytes, error } = await decryptBytes(stored, { pieces: [1] });
  assert.equal(error, null);
  assert.deepEqual(bytes, plain);
});

test("two writes of the same plaintext to the same storage key use different salts and ciphertext, and both decrypt", async () => {
  const plain = plaintextOf(2 * C + 10, 4);
  const a = await encryptBytes(plain);
  const b = await encryptBytes(plain);
  assert.notDeepEqual(a.slice(16, 48), b.slice(16, 48), "salts differ");
  assert.deepEqual(a.slice(0, 16), b.slice(0, 16), "fixed header fields are equal");
  for (let i = 0; i < 3; i++) assert.notDeepEqual(chunkSlice(a, i, plain.length), chunkSlice(b, i, plain.length), `chunk ${i} differs`);
  assert.deepEqual((await decryptBytes(a)).bytes, plain);
  assert.deepEqual((await decryptBytes(b)).bytes, plain);
});

// ---------------------------------------------------------------- encrypt input checks

test("encrypt errors when the input is shorter than declared", async () => {
  for (const [declared, actual] of [[100, 99], [1, 0], [C, C - 1], [C + 1, C], [3.5 * C, 3 * C]]) {
    const { bytes, error } = await drain(encryptChunkedStream(sourceOf(plaintextOf(actual)), { plaintextLength: declared, dataKey: DATA_KEY, objectKey: OBJECT_KEY }));
    assert.ok(error, `declared ${declared}, got ${actual}`);
    assert.ok(bytes.length < chunkedStoredLength(declared), "never a complete object");
  }
});

test("encrypt errors when the input is longer than declared, before the final chunk is released", async () => {
  for (const [declared, actual] of [[100, 101], [0, 1], [C, C + 1], [C - 1, C], [3.5 * C, 3.5 * C + 7]]) {
    const { bytes, error } = await drain(encryptChunkedStream(sourceOf(plaintextOf(actual), [actual]), { plaintextLength: declared, dataKey: DATA_KEY, objectKey: OBJECT_KEY }));
    assert.ok(error, `declared ${declared}, got ${actual}`);
    assert.ok(bytes.length < chunkedStoredLength(declared), "the final chunk is withheld");
  }
});

test("encrypt refuses lengths above 2^40 and non-integer lengths, and requires an HKDF data key and an object key", async () => {
  for (const plaintextLength of [2 ** 40 + 1, -1, 0.5, NaN]) {
    assert.throws(() => encryptChunkedStream(sourceOf(new Uint8Array(0)), { plaintextLength, dataKey: DATA_KEY, objectKey: OBJECT_KEY }), undefined, String(plaintextLength));
  }
  assert.throws(() => encryptChunkedStream(sourceOf(new Uint8Array(0)), { plaintextLength: 0, dataKey: DATA_KEY, objectKey: "" }));
  const aesKey = await crypto.subtle.importKey("raw", new Uint8Array(32), "AES-GCM", false, ["encrypt"]);
  assert.throws(() => encryptChunkedStream(sourceOf(new Uint8Array(0)), { plaintextLength: 0, dataKey: aesKey, objectKey: OBJECT_KEY }));
});

test("encrypt is pull-driven: reading only the header does not drain the input", async () => {
  let pulled = 0;
  const source = new ReadableStream({ pull(c) { pulled += 1; c.enqueue(new Uint8Array(1024)); } }, { highWaterMark: 0 });
  const reader = encryptChunkedStream(source, { plaintextLength: 64 * C, dataKey: DATA_KEY, objectKey: OBJECT_KEY }).getReader();
  const first = await reader.read();
  assert.equal(first.value.length, 48);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(pulled <= 2 * (C / 1024) + 2, `pulled ${pulled} KiB after reading the header`);
  await reader.cancel();
});

// ---------------------------------------------------------------- known answer

test("known answer: fixed key, salt and plaintext give the stored bytes node:crypto computes independently", async () => {
  const salt = new Uint8Array(32).map((_, i) => 0x10 + i);
  const plain = plaintextOf(2 * C + 100, 77);
  const { bytes: stored, error } = await drain(encryptChunkedStreamWithSaltForTestOnly(sourceOf(plain, [5000]), {
    plaintextLength: plain.length, dataKey: DATA_KEY, objectKey: OBJECT_KEY, salt,
  }));
  assert.equal(error, null);

  // Independent computation of version 1.
  const header = Buffer.alloc(48);
  header.write("ALE1", 0, "latin1");
  header[4] = 1; header[5] = 16;
  header.writeBigUInt64BE(BigInt(plain.length), 8);
  Buffer.from(salt).copy(header, 16);
  const info = Buffer.concat([Buffer.from("al-obj/1", "utf8"), Buffer.from([0]), Buffer.from(OBJECT_KEY, "utf8")]);
  const key = Buffer.from(hkdfSync("sha256", Buffer.from(DATA_KEY_BYTES), Buffer.from(salt), info, 32));
  const parts = [header];
  const n = Math.ceil(plain.length / C);
  for (let i = 0; i < n; i++) {
    const index = Buffer.alloc(8); index.writeBigUInt64BE(BigInt(i));
    const nonce = Buffer.concat([Buffer.alloc(4), index]);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.concat([header, index, Buffer.from([i === n - 1 ? 1 : 0])]));
    parts.push(cipher.update(plain.subarray(i * C, Math.min(plain.length, (i + 1) * C))), cipher.final(), cipher.getAuthTag());
  }
  const expected = Buffer.concat(parts);
  assert.equal(stored.length, expected.length);
  assert.ok(Buffer.from(stored).equals(expected), "stored bytes equal the independent computation");
  assert.equal(Buffer.from(stored.slice(0, 16)).toString("hex"), "414c4531011000000000000000020064");
  assert.deepEqual((await decryptBytes(stored)).bytes, plain);
});

test("the test-only salt parameter is refused by the production encrypt function", () => {
  assert.throws(() => encryptChunkedStream(sourceOf(new Uint8Array(0)), { plaintextLength: 0, dataKey: DATA_KEY, objectKey: OBJECT_KEY, salt: new Uint8Array(32) }), /salt/i);
});

// ---------------------------------------------------------------- decrypt failures

const LEN = 3.5 * C; // chunks 0..2 full, chunk 3 half
const PLAIN = plaintextOf(LEN, 21);
const STORED = await encryptBytes(PLAIN);
const STORED_LEN = chunkedStoredLength(LEN);

test("decrypt fails on a flipped byte anywhere, releasing nothing from the failing chunk", async () => {
  const cases = [
    ["magic", 0, 0], ["version", 4, 0], ["exponent", 5, 0], ["reserved", 6, 0],
    ["length field", 15, 0], ["salt first byte", 16, 0], ["salt last byte", 47, 0],
    ["chunk 0 first ciphertext byte", H, 0], ["chunk 0 tag", H + C + 5, 0],
    ["chunk 1 ciphertext", H + SC + 100, 1], ["chunk 2 tag last byte", H + 3 * SC - 1, 2],
    ["final chunk ciphertext", H + 3 * SC + 10, 3], ["final chunk last tag byte", STORED_LEN - 1, 3],
  ];
  for (const [name, position, failingChunk] of cases) {
    const bad = STORED.slice();
    bad[position] ^= 0x01;
    const released = await assertDecryptFails(bad, `flipped ${name}`);
    assert.equal(released.length, failingChunk * C, `${name}: only chunks before ${failingChunk} released`);
    assert.deepEqual(released, PLAIN.slice(0, released.length));
  }
});

test("decrypt fails on a missing middle chunk", async () => {
  const bad = concat([STORED.slice(0, H + SC), STORED.slice(H + 2 * SC)]);
  const released = await assertDecryptFails(bad, "missing chunk 1");
  assert.ok(released.length <= C);
});

test("decrypt fails on a missing chunk even when the header length is rewritten to match", async () => {
  const header = encodeChunkedHeader({ plaintextLength: LEN - C, salt: STORED.slice(16, 48) });
  const bad = concat([header, STORED.slice(H, H + SC), STORED.slice(H + 2 * SC)]);
  assert.equal(bad.length, chunkedStoredLength(LEN - C));
  const released = await assertDecryptFails(bad, "missing chunk with matching header");
  assert.equal(released.length, 0);
});

test("decrypt fails on a repeated chunk", async () => {
  const bad = concat([STORED.slice(0, H + SC), STORED.slice(H, H + SC), STORED.slice(H + 2 * SC)]);
  assert.equal(bad.length, STORED_LEN);
  const released = await assertDecryptFails(bad, "chunk 0 repeated in place of chunk 1");
  assert.equal(released.length, C);
});

test("decrypt fails when two full chunks of equal length are swapped", async () => {
  const bad = concat([STORED.slice(0, H), STORED.slice(H + SC, H + 2 * SC), STORED.slice(H, H + SC), STORED.slice(H + 2 * SC)]);
  assert.equal(bad.length, STORED_LEN);
  const released = await assertDecryptFails(bad, "chunks 0 and 1 swapped");
  assert.equal(released.length, 0);
});

test("decrypt fails on truncation at any point, including right after the header and at a chunk boundary", async () => {
  const cuts = [0, 1, 47, 48, 49, H + C, H + SC - 1, H + SC, H + SC + 1, H + 2 * SC, H + 3 * SC, STORED_LEN - 17, STORED_LEN - 16, STORED_LEN - 1];
  for (const cut of cuts) {
    const released = await assertDecryptFails(STORED.slice(0, cut), `truncated at ${cut}`);
    assert.ok(released.length < LEN, `truncated at ${cut}: not all plaintext released`);
    assert.ok(released.length <= Math.max(0, Math.floor((cut - H) / SC)) * C, `truncated at ${cut}: no partial chunk released`);
  }
});

test("decrypt fails when the final chunk is dropped exactly at a chunk boundary, and when an empty object loses its only chunk", async () => {
  const exact = plaintextOf(2 * C, 5);
  const stored = await encryptBytes(exact);
  await assertDecryptFails(stored.slice(0, H + SC), "two-chunk object cut after chunk 0");
  const empty = await encryptBytes(new Uint8Array(0));
  assert.equal(empty.length, 64);
  await assertDecryptFails(empty.slice(0, 48), "empty object cut after the header");
});

test("decrypt fails on trailing extra bytes and releases nothing from the final chunk", async () => {
  for (const extra of [1, 16, SC]) {
    const released = await assertDecryptFails(concat([STORED, new Uint8Array(extra)]), `${extra} trailing bytes`);
    assert.equal(released.length, 3 * C, "the final chunk is withheld");
  }
  const empty = await encryptBytes(new Uint8Array(0));
  await assertDecryptFails(concat([empty, new Uint8Array(1)]), "trailing byte after an empty object");
});

test("decrypt fails when the header length disagrees with the chunks", async () => {
  const salt = STORED.slice(16, 48);
  for (const claimed of [LEN - 1, LEN + 1, 3 * C, 4 * C, 0]) {
    const header = encodeChunkedHeader({ plaintextLength: claimed, salt });
    const released = await assertDecryptFails(concat([header, STORED.slice(H)]), `header claims ${claimed}`);
    assert.equal(released.length, 0, `header claims ${claimed}: nothing released`);
  }
});

test("decrypt fails with the wrong data key", async () => {
  const released = await assertDecryptFails(STORED, "wrong data key", { dataKey: OTHER_DATA_KEY });
  assert.equal(released.length, 0);
});

test("decrypt fails with the wrong storage object key", async () => {
  for (const objectKey of [OBJECT_KEY + "x", OBJECT_KEY.slice(0, -1), "blobs/prj_example/art_example/ver_2"]) {
    const released = await assertDecryptFails(STORED, `object key ${objectKey}`, { objectKey });
    assert.equal(released.length, 0);
  }
});

test("chunks from two writes of the same plaintext under the same storage key cannot be mixed", async () => {
  const other = await encryptBytes(PLAIN);
  // Header and chunk 0 from write A, chunk 1 onwards from write B (same plaintext, same storage key, different salt).
  const mixed = concat([STORED.slice(0, H + SC), other.slice(H + SC)]);
  const released = await assertDecryptFails(mixed, "mixed writes");
  assert.equal(released.length, C);
  // Write B's header over write A's chunks.
  await assertDecryptFails(concat([other.slice(0, H), STORED.slice(H)]), "header from another write");
});

// ---------------------------------------------------------------- ranges

test("planChunkedRange maps plaintext ranges to exactly the stored chunks needed", () => {
  assert.deepEqual(planChunkedRange(LEN, 0, 0), { firstChunk: 0, lastChunk: 0, storedStart: 48, storedEnd: 48 + SC - 1, skip: 0, take: 1 });
  assert.deepEqual(planChunkedRange(LEN, LEN - 1, LEN - 1), { firstChunk: 3, lastChunk: 3, storedStart: H + 3 * SC, storedEnd: STORED_LEN - 1, skip: C / 2 - 1, take: 1 });
  assert.deepEqual(planChunkedRange(LEN, C + 10, C + 20), { firstChunk: 1, lastChunk: 1, storedStart: H + SC, storedEnd: H + 2 * SC - 1, skip: 10, take: 11 });
  assert.deepEqual(planChunkedRange(LEN, C - 5, C + 4), { firstChunk: 0, lastChunk: 1, storedStart: H, storedEnd: H + 2 * SC - 1, skip: C - 5, take: 10 });
  assert.deepEqual(planChunkedRange(LEN, 0, LEN - 1), { firstChunk: 0, lastChunk: 3, storedStart: H, storedEnd: STORED_LEN - 1, skip: 0, take: LEN });
  for (const [start, end] of [[-1, 0], [1, 0], [0, LEN], [0.5, 1]]) assert.throws(() => planChunkedRange(LEN, start, end), undefined, `${start}-${end}`);
  assert.throws(() => planChunkedRange(0, 0, 0), undefined, "empty object has no byte range");
});

const RANGES = [
  ["first byte", 0, 0, 48, 48 + SC - 1],
  ["last byte", LEN - 1, LEN - 1, H + 3 * SC, STORED_LEN - 1],
  ["span inside one chunk", C + 10, C + 20, H + SC, H + 2 * SC - 1],
  ["span across a chunk boundary", C - 5, C + 4, H, H + 2 * SC - 1],
  ["whole object", 0, LEN - 1, H, STORED_LEN - 1],
  ["suffix (last 100 000 bytes)", LEN - 100000, LEN - 1, H + 1 * SC, STORED_LEN - 1],
];

async function readRange(stored, start, end, { calls = [], dataKey = DATA_KEY, objectKey = OBJECT_KEY, header = stored.slice(0, 48), tamper } = {}) {
  const fetchStored = async (storedStart, storedEnd) => {
    calls.push([storedStart, storedEnd]);
    const bytes = stored.slice(storedStart, storedEnd + 1);
    return tamper ? tamper(bytes) : bytes;
  };
  return drain(decryptChunkedRange({ header, dataKey, objectKey, start, end, fetchStored }));
}

for (const [name, start, end, storedStart, storedEnd] of RANGES) {
  test(`range: ${name} returns exactly the right bytes and fetches the planned stored range once`, async () => {
    const calls = [];
    const { bytes, error } = await readRange(STORED, start, end, { calls });
    assert.equal(error, null);
    assert.deepEqual(bytes, PLAIN.slice(start, end + 1));
    assert.deepEqual(calls, [[storedStart, storedEnd]]);
  });
}

test("range: fetchStored may return a ReadableStream or an ArrayBuffer", async () => {
  const header = STORED.slice(0, 48);
  for (const shape of ["stream", "arraybuffer"]) {
    const fetchStored = async (s, e) => {
      const bytes = STORED.slice(s, e + 1);
      return shape === "stream" ? sourceOf(bytes, [9, C]) : bytes.buffer;
    };
    const { bytes, error } = await drain(decryptChunkedRange({ header, dataKey: DATA_KEY, objectKey: OBJECT_KEY, start: C - 5, end: 2 * C + 5, fetchStored }));
    assert.equal(error, null, shape);
    assert.deepEqual(bytes, PLAIN.slice(C - 5, 2 * C + 6), shape);
  }
});

test("range: a flipped byte in a touched chunk fails without releasing that chunk's bytes", async () => {
  const { bytes, error } = await readRange(STORED, C - 5, C + 4, { tamper: (b) => { b[SC + 3] ^= 1; return b; } });
  assert.ok(error);
  assert.equal(bytes.length, 5, "only the authenticated first chunk's 5 bytes");
  const first = await readRange(STORED, 0, 0, { tamper: (b) => { b[0] ^= 1; return b; } });
  assert.ok(first.error);
  assert.equal(first.bytes.length, 0);
});

test("range: a tampered header copy, the wrong keys, a short or long fetch, and a chunk from elsewhere all fail", async () => {
  const salt = STORED.slice(16, 48);
  const lengthLie = encodeChunkedHeader({ plaintextLength: LEN + 1, salt });
  assert.ok((await readRange(STORED, 0, 0, { header: lengthLie })).error, "header length changed");
  const saltLie = STORED.slice(0, 48); saltLie[20] ^= 1;
  assert.ok((await readRange(STORED, 0, 0, { header: saltLie })).error, "header salt changed");
  const shortClaim = encodeChunkedHeader({ plaintextLength: 3 * C, salt });
  assert.ok((await readRange(STORED, 2 * C, 3 * C - 1, { header: shortClaim })).error, "header shortened so chunk 2 looks final");
  assert.ok((await readRange(STORED, 0, 0, { dataKey: OTHER_DATA_KEY })).error, "wrong data key");
  assert.ok((await readRange(STORED, 0, 0, { objectKey: OBJECT_KEY + "x" })).error, "wrong object key");
  assert.ok((await readRange(STORED, 0, 0, { tamper: (b) => b.slice(0, -1) })).error, "fetch one byte short");
  assert.ok((await readRange(STORED, 0, 0, { tamper: (b) => concat([b, new Uint8Array(1)]) })).error, "fetch one byte long");
  assert.ok((await readRange(STORED, C + 1, C + 1, { tamper: () => STORED.slice(H, H + SC) })).error, "chunk 0 served for chunk 1");
  assert.ok((await readRange(STORED, 0, 0, { header: STORED.slice(0, 47) })).error, "short header");
});

test("range: chunks from another write of the same plaintext and storage key are refused", async () => {
  const other = await encryptBytes(PLAIN);
  const { error } = await readRange(STORED, C, C + 1, { tamper: () => other.slice(H + SC, H + 2 * SC) });
  assert.ok(error);
});

// ---------------------------------------------------------------- memory

test("memory: 32 MiB through encrypt then decrypt keeps at most a few chunks in flight", async () => {
  // Counts bytes the source has handed out minus bytes the sink has received: everything buffered anywhere in the
  // pipeline (input leftovers, the codec's working chunks, stream queues). It proves the codec does not read ahead of
  // its consumer; it does not measure heap usage, GC timing or copies made inside WebCrypto.
  const total = 32 * 1024 * 1024;
  const piece = 10000;
  let produced = 0;
  let consumed = 0;
  let peak = 0;
  const block = plaintextOf(piece, 3);
  const source = new ReadableStream({
    pull(c) {
      if (produced >= total) { c.close(); return; }
      const n = Math.min(piece, total - produced);
      produced += n;
      peak = Math.max(peak, produced - consumed);
      c.enqueue(block.slice(0, n));
    },
  }, { highWaterMark: 0 });
  const stored = encryptChunkedStream(source, { plaintextLength: total, dataKey: DATA_KEY, objectKey: OBJECT_KEY });
  const plain = decryptChunkedStream(stored, { dataKey: DATA_KEY, objectKey: OBJECT_KEY });
  const reader = plain.getReader();
  let checked = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (let i = 0; i < value.length; i += 4099) assert.equal(value[i], block[(consumed + i) % piece]);
    consumed += value.length;
    checked += 1;
  }
  assert.equal(consumed, total);
  assert.equal(checked, total / C);
  assert.ok(peak <= 6 * C, `peak in flight ${peak} bytes (${(peak / C).toFixed(2)} chunks)`);
});
