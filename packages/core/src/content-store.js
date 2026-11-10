import { HttpError } from "./util.js";

// ContentStore: the one place the Worker reads or writes stored file bytes (R2 `BLOBS`).
//
// Today content is encrypted at rest by the storage provider (Cloudflare D1/R2), so these are pass-throughs.
// Per-workspace envelope encryption (hosted plan, "Encryption at rest") plugs in here: a KeyProvider wraps
// per-workspace data keys and R2 objects become chunked AES-GCM so Range reads keep working.
// test/content-store.test.mjs fails if any other module touches env.BLOBS. Text versions use putText/getText;
// comments and legacy inline bodies still pass through storeText/readText.

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


// Inline compatibility codec: comments and publisher generation copies still write inline; legacy text versions
// are decoded here by getText/getTextRange. SQL-side plaintext uses are listed in docs/encryption.md.
export function storeText(text) {
  return text;
}
export function readText(stored) {
  return stored;
}

/** Write one immutable text version; scope is reserved for the workspace codec. */
export async function putText(env, scope, key, text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  await putBlob(env, key, bytes, { sha256: digest });
  return { size: bytes.length, sha256 };
}

/** Byte ranges must not decode partial UTF-8 characters before the caller chooses a character boundary. */
export async function getTextRange(env, row, offset, length) {
  if (!row.body_key) return new TextEncoder().encode(readText(row.body)).slice(offset, offset + length);
  if (length === 0) return new Uint8Array();
  const object = await getBlob(env, row.body_key, { offset, length });
  if (!object) throw new Error("Missing text object");
  return new Uint8Array(await object.arrayBuffer());
}

/** Legacy inline rows remain readable while new versions store only a key in D1. */
export async function getText(env, row) {
  if (!row.body_key) return readText(row.body);
  const bytes = await getBlobBytes(env, row.body_key);
  if (!bytes) throw new Error("Missing text object");
  return new TextDecoder().decode(bytes);
}

/** Encode each ID independently so unusual legacy backup IDs cannot alias another version's object. */
export function textKey(projectId, artifactId, revisionId) {
  const key = `text/${encodeURIComponent(projectId)}/${encodeURIComponent(artifactId)}/${encodeURIComponent(revisionId)}`;
  if (new TextEncoder().encode(key).length > 1024) throw new HttpError(400, "bad_backup", "Text revision object key exceeds R2's 1024-byte limit");
  return key;
}

/** Persist intent before bytes: a dead request remains sweepable even if put succeeds after it dies. */
export async function stageTextWrite(env, projectId, artifactId, revisionId, text) {
  const key = textKey(projectId, artifactId, revisionId);
  await env.DB.prepare("INSERT INTO content_writes (key, project_id, created_at) VALUES (?, ?, ?)").bind(key, projectId, Date.now()).run();
  await putText(env, { projectId }, key, text);
  return key;
}

/** Include in the same transaction that references the immutable key. */
export function textWriteComplete(env, key) {
  return env.DB.prepare("DELETE FROM content_writes WHERE key = ? AND EXISTS (SELECT 1 FROM revisions WHERE body_key = ?)").bind(key, key);
}

// The sweep age must stay well above the publish deadline: an intent eligible for deletion can never publish.
export const TEXT_WRITE_DEADLINE_MS = 10 * 60 * 1000;
export const TEXT_WRITE_STALE_MS = 60 * 60 * 1000;

// Depends on D1's SQLite constraint text; tested against local D1, not just a simulated error.
export function isTextWriteFenceError(error) {
  return /NOT NULL constraint failed: content_writes\.(?:project_id|created_at)\b/.test(String(error?.message ?? error));
}

/** Atomic publication fence and best-effort disposal of objects known not to have published. */
export async function commitTextWrites(env, keys, commit) {
  keys = keys.filter(Boolean);
  let settled = false;
  try {
    const guarded = (statements) => {
      if (!keys.length) return statements;
      // Intentionally violate NOT NULL if any intent expired/disappeared: D1 rolls the whole batch back,
      // including metadata, so a sweep racing a slow R2 write cannot leave a published but missing object.
      const fence = env.DB.prepare(`INSERT INTO content_writes (key, project_id, created_at)
        SELECT NULL, NULL, NULL WHERE EXISTS (SELECT 1 FROM json_each(?) j
          LEFT JOIN content_writes w ON w.key = j.value WHERE w.key IS NULL OR w.created_at < ?)`)
        .bind(JSON.stringify(keys), Date.now() - TEXT_WRITE_DEADLINE_MS);
      return [fence, ...statements];
    };
    const result = await commit(guarded);
    settled = true;
    return keys.length && Array.isArray(result) ? result.slice(1) : result;
  } catch (error) {
    if (!isTextWriteFenceError(error)) throw error;
    settled = true;
    throw new HttpError(503, "text_write_expired", "Text write expired before publication; retry with the same idempotency key");
  } finally {
    // Unknown errors may be a lost acknowledgement of a successful commit. Leave their intent/bytes to cron.
    if (settled) for (const key of keys) {
      try {
        const referenced = await env.DB.prepare("SELECT 1 FROM revisions WHERE body_key = ? LIMIT 1").bind(key).first();
        if (!referenced) {
          await deleteBlob(env, key);
          await env.DB.prepare("DELETE FROM content_writes WHERE key = ?").bind(key).run();
        }
      } catch { console.error(JSON.stringify({ event: "text_write_cleanup_failed" })); }
    }
  }
}
