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

/** Write bytes under an immutable key. */
export async function putBlob(env, key, bytes, options) {
  return options ? env.BLOBS.put(key, bytes, options) : env.BLOBS.put(key, bytes);
}

/** Object metadata (size), or null. */
export async function headBlob(env, key) {
  return env.BLOBS.head(key);
}

export async function deleteBlob(env, key) {
  return env.BLOBS.delete(key);
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
