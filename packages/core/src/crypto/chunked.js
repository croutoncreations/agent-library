// Chunked AES-256-GCM object format, version 1 (docs/encryption.md#object-format-version-1). WebCrypto only.
//
// Stored object = 48-byte header ‖ chunk 0 ‖ chunk 1 ‖ … ; each chunk is the AES-GCM ciphertext of up to 65,536
// plaintext bytes followed by its 16-byte tag. Each write derives its own AES key from the workspace data key with
// HKDF (salt = the header's 32 random bytes, info = "al-obj/1" ‖ 0x00 ‖ storage object key), so nonces (the chunk
// index) never repeat under one key even when the same storage key is written twice. Every chunk authenticates the
// full header, its index and whether it is the final chunk, which pins length, order, truncation and the header.
//
// Nothing calls this yet: reads and writes still store plaintext (content-store.js). This module never touches R2.

const MAGIC = [0x41, 0x4c, 0x45, 0x31]; // "ALE1"
const FORMAT_VERSION = 1;
const CHUNK_EXPONENT = 16;
const SALT_BYTES = 32;
const INDEX_LIMIT = 2 ** 32;
const INFO_PREFIX = "al-obj/1";

export const CHUNKED_HEADER_BYTES = 48;
export const CHUNKED_CHUNK_BYTES = 2 ** CHUNK_EXPONENT;
export const CHUNKED_TAG_BYTES = 16;
export const CHUNKED_MAX_PLAINTEXT_BYTES = 2 ** 40;

const STORED_CHUNK_BYTES = CHUNKED_CHUNK_BYTES + CHUNKED_TAG_BYTES;

function chunkedError(message) {
  return new Error(`chunked object: ${message}`);
}

function checkPlaintextLength(length) {
  if (!Number.isSafeInteger(length) || length < 0 || length > CHUNKED_MAX_PLAINTEXT_BYTES) {
    throw chunkedError(`plaintext length must be an integer from 0 to 2^40, got ${String(length)}`);
  }
}

function chunkCount(plaintextLength) {
  const count = Math.max(1, Math.ceil(plaintextLength / CHUNKED_CHUNK_BYTES));
  if (count > INDEX_LIMIT) throw chunkedError("too many chunks");
  return count;
}

function chunkPlaintextBytes(plaintextLength, index) {
  return Math.min(CHUNKED_CHUNK_BYTES, plaintextLength - index * CHUNKED_CHUNK_BYTES);
}

/** Stored size of an object holding plaintextLength bytes: 48 + len + 16 × max(1, ceil(len / 65536)). */
export function chunkedStoredLength(plaintextLength) {
  checkPlaintextLength(plaintextLength);
  return CHUNKED_HEADER_BYTES + plaintextLength + CHUNKED_TAG_BYTES * chunkCount(plaintextLength);
}

/** Plaintext length for a stored size; throws if no plaintext length produces exactly that stored size. */
export function chunkedPlaintextLength(storedLength) {
  if (!Number.isSafeInteger(storedLength) || storedLength < CHUNKED_HEADER_BYTES + CHUNKED_TAG_BYTES) {
    throw chunkedError(`invalid stored length ${String(storedLength)}`);
  }
  const rest = storedLength - CHUNKED_HEADER_BYTES;
  const full = Math.floor(rest / STORED_CHUNK_BYTES);
  const tail = rest % STORED_CHUNK_BYTES;
  const length = tail === 0 ? full * CHUNKED_CHUNK_BYTES : full * CHUNKED_CHUNK_BYTES + tail - CHUNKED_TAG_BYTES;
  if (length < 0 || length > CHUNKED_MAX_PLAINTEXT_BYTES || chunkedStoredLength(length) !== storedLength) {
    throw chunkedError(`invalid stored length ${storedLength}`);
  }
  return length;
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw chunkedError("stream chunks must be bytes");
}

/** The 48-byte version 1 header for a plaintext length and a 32-byte salt. */
export function encodeChunkedHeader({ plaintextLength, salt }) {
  checkPlaintextLength(plaintextLength);
  const saltBytes = asBytes(salt);
  if (saltBytes.length !== SALT_BYTES) throw chunkedError("salt must be 32 bytes");
  const header = new Uint8Array(CHUNKED_HEADER_BYTES);
  header.set(MAGIC, 0);
  header[4] = FORMAT_VERSION;
  header[5] = CHUNK_EXPONENT;
  const view = new DataView(header.buffer);
  view.setUint32(8, Math.floor(plaintextLength / 2 ** 32));
  view.setUint32(12, plaintextLength % 2 ** 32);
  header.set(saltBytes, 16);
  return header;
}

/** Parse and validate a header. Returns { header (a 48-byte copy), plaintextLength, salt }. */
export function parseChunkedHeader(bytes) {
  const input = asBytes(bytes);
  if (input.length !== CHUNKED_HEADER_BYTES) throw chunkedError(`header must be ${CHUNKED_HEADER_BYTES} bytes`);
  const header = input.slice();
  for (let i = 0; i < MAGIC.length; i++) if (header[i] !== MAGIC[i]) throw chunkedError("wrong magic");
  if (header[4] !== FORMAT_VERSION) throw chunkedError(`unsupported format version ${header[4]}`);
  if (header[5] !== CHUNK_EXPONENT) throw chunkedError(`unsupported chunk-size exponent ${header[5]}`);
  if (header[6] !== 0 || header[7] !== 0) throw chunkedError("reserved bytes are not zero");
  const view = new DataView(header.buffer);
  const high = view.getUint32(8);
  const plaintextLength = high * 2 ** 32 + view.getUint32(12);
  if (high > CHUNKED_MAX_PLAINTEXT_BYTES / 2 ** 32 || plaintextLength > CHUNKED_MAX_PLAINTEXT_BYTES) {
    throw chunkedError("plaintext length out of range");
  }
  return { header, plaintextLength, salt: header.slice(16, 48) };
}

function checkDataKey(dataKey) {
  const algorithm = /** @type {any} */ (dataKey)?.algorithm;
  if (algorithm?.name !== "HKDF" || !dataKey.usages?.includes("deriveKey")) {
    throw chunkedError("data key must be a WebCrypto HKDF key with usage deriveKey");
  }
}

function checkObjectKey(objectKey) {
  if (typeof objectKey !== "string" || objectKey === "") throw chunkedError("storage object key must be a non-empty string");
}

/** The per-write AES-256-GCM key: HKDF-SHA-256(data key, salt, "al-obj/1" ‖ 0x00 ‖ UTF-8(objectKey)). */
async function deriveObjectKey(dataKey, salt, objectKey, usage) {
  const name = new TextEncoder().encode(objectKey);
  const info = new Uint8Array(INFO_PREFIX.length + 1 + name.length);
  info.set(new TextEncoder().encode(INFO_PREFIX), 0);
  info.set(name, INFO_PREFIX.length + 1);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info }, dataKey, { name: "AES-GCM", length: 256 }, false, [usage],
  );
}

/** Nonce = 4 zero bytes ‖ index (u64 BE); AAD = header ‖ index (u64 BE) ‖ final flag. */
function chunkParams(header, index, final) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= INDEX_LIMIT) throw chunkedError("chunk index out of range");
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setUint32(8, index);
  const additionalData = new Uint8Array(CHUNKED_HEADER_BYTES + 9);
  additionalData.set(header, 0);
  new DataView(additionalData.buffer).setUint32(CHUNKED_HEADER_BYTES + 4, index);
  additionalData[CHUNKED_HEADER_BYTES + 8] = final ? 1 : 0;
  return { name: "AES-GCM", iv, additionalData, tagLength: 128 };
}

async function decryptChunk(aesKey, header, index, final, stored) {
  try {
    return new Uint8Array(await crypto.subtle.decrypt(chunkParams(header, index, final), aesKey, stored));
  } catch {
    throw chunkedError(`chunk ${index} failed authentication`);
  }
}

/** Reads exact byte counts from a stream with arbitrary chunk boundaries; holds at most one input piece back. */
function byteReader(stream) {
  const reader = stream.getReader();
  let pending = null;
  let ended = false;
  async function nextPiece() {
    if (pending) { const piece = pending; pending = null; return piece; }
    while (!ended) {
      const { done, value } = await reader.read();
      if (done) { ended = true; break; }
      const piece = asBytes(value);
      if (piece.length) return piece;
    }
    return null;
  }
  return {
    /** Up to n bytes; fewer only at the end of the stream. */
    async read(n) {
      const out = new Uint8Array(n);
      let filled = 0;
      while (filled < n) {
        const piece = await nextPiece();
        if (!piece) return out.subarray(0, filled);
        const take = Math.min(n - filled, piece.length);
        out.set(piece.subarray(0, take), filled);
        filled += take;
        if (take < piece.length) pending = piece.subarray(take);
      }
      return out;
    },
    async atEnd() {
      const piece = await nextPiece();
      if (piece) { pending = piece; return false; }
      return true;
    },
    cancel(reason) {
      pending = null;
      return reader.cancel(reason).catch(() => {});
    },
  };
}

/**
 * A pull-driven ReadableStream whose step() runs once per consumer pull. Errors from step() error the stream and
 * cancel the source.
 */
function pullStream(step, source) {
  return new ReadableStream({
    async pull(controller) {
      try {
        await step(controller);
      } catch (error) {
        controller.error(error);
        await source?.cancel(error);
      }
    },
    async cancel(reason) {
      await source?.cancel(reason);
    },
  }, { highWaterMark: 0 });
}

function encryptStream(input, { plaintextLength, dataKey, objectKey }, salt) {
  checkPlaintextLength(plaintextLength);
  checkDataKey(dataKey);
  checkObjectKey(objectKey);
  const header = encodeChunkedHeader({ plaintextLength, salt });
  const count = chunkCount(plaintextLength);
  const source = byteReader(input);
  let aesKey = null;
  let index = -1;
  return pullStream(async (controller) => {
    if (index === -1) {
      aesKey = await deriveObjectKey(dataKey, header.slice(16, 48), objectKey, "encrypt");
      index = 0;
      controller.enqueue(header.slice());
      return;
    }
    const size = chunkPlaintextBytes(plaintextLength, index);
    const plain = await source.read(size);
    if (plain.length < size) throw chunkedError("input is shorter than the declared length");
    const final = index === count - 1;
    if (final && !(await source.atEnd())) throw chunkedError("input is longer than the declared length");
    const stored = new Uint8Array(await crypto.subtle.encrypt(chunkParams(header, index, final), aesKey, plain));
    controller.enqueue(stored);
    index += 1;
    if (final) controller.close();
  }, source);
}

/**
 * Encrypt a byte stream of exactly plaintextLength bytes for storage under objectKey. Returns a pull-driven
 * ReadableStream of exactly chunkedStoredLength(plaintextLength) bytes; it errors if the input is shorter or longer
 * than declared (the final chunk is never released in that case). A fresh random salt is drawn for every call.
 * dataKey: the workspace data key, a non-extractable WebCrypto HKDF key with usage "deriveKey".
 */
export function encryptChunkedStream(input, options) {
  if (options && "salt" in options) throw chunkedError("salt is chosen randomly for every write and cannot be supplied");
  return encryptStream(input, options, crypto.getRandomValues(new Uint8Array(SALT_BYTES)));
}

/**
 * Test only, deliberately not exported: encryptChunkedStream with a fixed salt for the known-answer test, which reaches
 * it through test/module-source.mjs. Reusing a salt for the same data key and object key reuses (key, nonce) pairs.
 */
function encryptChunkedStreamWithSaltForTestOnly(input, { salt, plaintextLength, dataKey, objectKey }) {
  return encryptStream(input, { plaintextLength, dataKey, objectKey }, salt);
}

/**
 * Decrypt a whole stored object. Returns a ReadableStream of plaintext, released one authenticated chunk at a time.
 * It errors, without releasing the failing chunk, on any modification, missing, repeated or reordered chunk,
 * truncation, trailing bytes, a header length that disagrees with the chunks, or the wrong data or object key.
 */
export function decryptChunkedStream(stored, { dataKey, objectKey }) {
  checkDataKey(dataKey);
  checkObjectKey(objectKey);
  const source = byteReader(stored);
  let parsed = null;
  let aesKey = null;
  let count = 0;
  let index = 0;
  return pullStream(async (controller) => {
    if (!parsed) {
      const headerBytes = await source.read(CHUNKED_HEADER_BYTES);
      if (headerBytes.length < CHUNKED_HEADER_BYTES) throw chunkedError("truncated header");
      parsed = parseChunkedHeader(headerBytes);
      count = chunkCount(parsed.plaintextLength);
      aesKey = await deriveObjectKey(dataKey, parsed.salt, objectKey, "decrypt");
    }
    const size = chunkPlaintextBytes(parsed.plaintextLength, index) + CHUNKED_TAG_BYTES;
    const storedChunk = await source.read(size);
    if (storedChunk.length < size) throw chunkedError(`truncated at chunk ${index}`);
    const final = index === count - 1;
    const plain = await decryptChunk(aesKey, parsed.header, index, final, storedChunk);
    if (final && !(await source.atEnd())) throw chunkedError("trailing bytes after the final chunk");
    if (plain.length) controller.enqueue(plain);
    index += 1;
    if (final) controller.close();
  }, source);
}

/**
 * Map the inclusive plaintext byte range [start, end] of an object of plaintextLength bytes to the stored byte range
 * (inclusive) covering exactly the chunks it touches. skip/take: bytes to drop from the first touched chunk's
 * plaintext, then bytes to return.
 */
export function planChunkedRange(plaintextLength, start, end) {
  checkPlaintextLength(plaintextLength);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= plaintextLength) {
    throw chunkedError(`invalid range ${String(start)}-${String(end)} for ${plaintextLength} bytes`);
  }
  const firstChunk = Math.floor(start / CHUNKED_CHUNK_BYTES);
  const lastChunk = Math.floor(end / CHUNKED_CHUNK_BYTES);
  return {
    firstChunk,
    lastChunk,
    storedStart: CHUNKED_HEADER_BYTES + firstChunk * STORED_CHUNK_BYTES,
    storedEnd: CHUNKED_HEADER_BYTES + lastChunk * STORED_CHUNK_BYTES + chunkPlaintextBytes(plaintextLength, lastChunk) + CHUNKED_TAG_BYTES - 1,
    skip: start - firstChunk * CHUNKED_CHUNK_BYTES,
    take: end - start + 1,
  };
}

function storedSource(value) {
  if (value instanceof ReadableStream) return value;
  const bytes = asBytes(value);
  return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}

/**
 * Plaintext for the inclusive range [start, end], authenticating every chunk it touches. header: the object's 48
 * header bytes from wherever the caller keeps them; it is authenticated in every chunk's additional data, so a
 * tampered copy makes decryption fail. fetchStored(storedStart, storedEnd) is called exactly once with the inclusive
 * stored range from planChunkedRange and must resolve to those bytes (Uint8Array, ArrayBuffer or ReadableStream).
 * Returns a ReadableStream; every validation or authentication failure errors it, and a chunk's bytes are released
 * only after that chunk authenticates.
 */
export function decryptChunkedRange({ header, dataKey, objectKey, start, end, fetchStored }) {
  let source = null;
  let plan = null;
  let parsed = null;
  let aesKey = null;
  let count = 0;
  let index = 0;
  const sourceHandle = { cancel: (reason) => source?.cancel(reason) };
  return pullStream(async (controller) => {
    if (!plan) {
      checkDataKey(dataKey);
      checkObjectKey(objectKey);
      parsed = parseChunkedHeader(header);
      plan = planChunkedRange(parsed.plaintextLength, start, end);
      count = chunkCount(parsed.plaintextLength);
      aesKey = await deriveObjectKey(dataKey, parsed.salt, objectKey, "decrypt");
      source = byteReader(storedSource(await fetchStored(plan.storedStart, plan.storedEnd)));
      index = plan.firstChunk;
    }
    const size = chunkPlaintextBytes(parsed.plaintextLength, index) + CHUNKED_TAG_BYTES;
    const storedChunk = await source.read(size);
    if (storedChunk.length < size) throw chunkedError(`fetched range is truncated at chunk ${index}`);
    const last = index === plan.lastChunk;
    const plain = await decryptChunk(aesKey, parsed.header, index, index === count - 1, storedChunk);
    if (last && !(await source.atEnd())) throw chunkedError("fetched range is longer than planned");
    const from = index === plan.firstChunk ? plan.skip : 0;
    const to = last ? plan.skip + plan.take - (plan.lastChunk - plan.firstChunk) * CHUNKED_CHUNK_BYTES : plain.length;
    controller.enqueue(plain.subarray(from, to));
    index += 1;
    if (last) controller.close();
  }, sourceHandle);
}
