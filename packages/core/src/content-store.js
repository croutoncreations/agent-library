// ContentStore: the one place the Worker reads or writes stored file bytes (R2 `BLOBS`).
//
// Today content is encrypted at rest by the storage provider (Cloudflare D1/R2), so these are pass-throughs.
// Per-workspace envelope encryption (hosted plan, "Encryption at rest") plugs in here: a KeyProvider wraps
// per-workspace data keys and R2 objects become chunked AES-GCM so Range reads keep working.
// test/content-store.test.mjs fails if any other module touches env.BLOBS. Text bodies stored inline in D1 go
// through storeText/readText below.

/** Read a stored object, optionally a byte range ({ offset, length }). Returns an R2ObjectBody or null. */
export async function getBlob(env, key, range) {
  return range ? env.BLOBS.get(key, { range }) : env.BLOBS.get(key);
}

/** Read a whole stored object as bytes, or null if missing. */
export async function getBlobBytes(env, key) {
  const o = await env.BLOBS.get(key);
  return o ? new Uint8Array(await o.arrayBuffer()) : null;
}

/** The first `length` bytes of a stored object (fewer if it is shorter), or null if missing. */
export async function getBlobHead(env, key, length) {
  const o = await env.BLOBS.get(key, { range: { offset: 0, length } });
  return o ? new Uint8Array(await o.arrayBuffer()) : null;
}

/** Write bytes under an immutable key. */
export async function putBlob(env, key, bytes, options) {
  return options ? env.BLOBS.put(key, bytes, options) : env.BLOBS.put(key, bytes);
}

/**
 * Write a stream of exactly `length` bytes under an immutable key without buffering it (R2 accepts a stream only
 * with a known length, hence FixedLengthStream). Rejects, storing nothing, if the stream errors or is not exactly
 * `length` bytes long, or if `options.sha256` is given and the stored bytes hash differently. Returns the R2 object
 * (size, checksums).
 */
export async function putBlobStream(env, key, stream, length, options) {
  return env.BLOBS.put(key, stream.pipeThrough(new FixedLengthStream(length)), options);
}

/** The SHA-256 (lowercase hex) R2 recorded for an object from put() or head(), or null if it has none. */
export function blobSha256Hex(obj) {
  const b = obj?.checksums?.sha256;
  return b ? [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("") : null;
}

/** Object metadata (size, checksums), or null. */
export async function headBlob(env, key) {
  return env.BLOBS.head(key);
}

export async function deleteBlob(env, key) {
  return env.BLOBS.delete(key);
}

/** Up to `limit` object keys under a prefix (one page), for cleanup sweeps. */
export async function listBlobKeys(env, prefix, limit = 100) {
  const r = await env.BLOBS.list({ prefix, limit });
  return r.objects.map((o) => o.key);
}


// Text bodies stored inline in D1 (revisions.body, comments.body). Every JS write passes the plaintext through
// storeText before binding it, and every JS read passes the column through readText. Identity until per-workspace
// encryption lands; then storeText encrypts (and sets a key_version column) and readText decrypts. Bodies also read
// inside SQL (search index, chunked reads, publisher batch copies, owner LIKE filter) are listed in
// docs/encryption.md; test/content-store.test.mjs keeps the JS paths on these two functions.
export function storeText(text) {
  return text;
}
export function readText(stored) {
  return stored;
}
