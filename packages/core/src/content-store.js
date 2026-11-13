import { HttpError } from "./util.js";

// ContentStore: the one place the Worker reads or writes stored file bytes (R2 `BLOBS`).
//
// Content is encrypted at rest by the storage provider (Cloudflare D1/R2); the Worker adds no encryption of its own,
// so these functions pass bytes through. test/content-store.test.mjs fails if any other module touches env.BLOBS.
// Text versions and comments use staged immutable writes and getText; legacy inline bodies still pass through readText.

/** Read a stored object, optionally a byte range ({ offset, length }). Returns an R2ObjectBody or null. */
async function getBlob(env, key, range) {
  return range ? env.BLOBS.get(key, { range }) : env.BLOBS.get(key);
}

/** Read a whole stored object as bytes, or null if missing. */
async function getBlobBytes(env, key) {
  const o = await env.BLOBS.get(key);
  return o ? new Uint8Array(await o.arrayBuffer()) : null;
}

/** Decode upload-owned raw text once, strictly, without consuming a leading BOM. */
export async function getUploadedText(env, key, kind) {
  const bytes = await getBlobBytes(env, key);
  if (bytes === null) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    const detail = "bytes are not valid UTF-8";
    throw new HttpError(422, "invalid_content", `Invalid ${kind}: ${detail}`, { format: kind, detail });
  }
}

/** The first `length` bytes of a stored object (fewer if it is shorter), or null if missing. */
async function getBlobHead(env, key, length) {
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
 * `length` bytes long, or if `options.sha256` is given and the stored bytes hash differently. Returns what R2
 * recorded: { size, sha256 (lowercase hex, or null without a checksum) }. Used by the text upload PUT and by
 * writeUploadBlob.
 */
export async function putBlobStream(env, key, stream, length, options) {
  const stored = await env.BLOBS.put(key, stream.pipeThrough(new FixedLengthStream(length)), options);
  return { size: stored?.size ?? null, sha256: blobSha256Hex(stored) };
}

/** The SHA-256 (lowercase hex) R2 recorded for an object from put() or head(), or null if it has none. */
function blobSha256Hex(obj) {
  const b = obj?.checksums?.sha256;
  return b ? [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("") : null;
}

/** Object metadata (size, checksums), or null. */
async function headBlob(env, key) {
  return env.BLOBS.head(key);
}

export async function deleteBlob(env, key) {
  return env.BLOBS.delete(key);
}

/** R2 accepts at most 1,000 keys in one delete call. Callers remove intents only after this succeeds. */
export async function deleteBlobs(env, keys) {
  for (let i = 0; i < keys.length; i += 1000) await env.BLOBS.delete(keys.slice(i, i + 1000));
}

const blobMissing = () => new HttpError(500, "blob_missing", "Stored bytes missing");

/**
 * Read a binary version: the whole object, or the inclusive byte range { start, end }. One R2 request. Returns the
 * object's body stream. Throws 500 blob_missing.
 * @param {string} key
 * @param {null | { start: number, end: number }} range
 * @returns {Promise<ReadableStream<Uint8Array>>}
 */
export async function readBlob(env, key, range) {
  const object = await getBlob(env, key, range ? { offset: range.start, length: range.end - range.start + 1 } : undefined);
  if (!object) throw blobMissing();
  return object.body;
}

/** A whole binary version as bytes. Throws 500 blob_missing. */
export async function readBlobBytes(env, key) {
  const bytes = await getBlobBytes(env, key);
  if (!bytes) throw blobMissing();
  return bytes;
}

/** A classified write failure: kind is "digest" | "too_long" | "too_short"; the original error is its cause. */
function blobWriteError(kind, cause) {
  const e = new Error(`blob write failed: ${kind}`, { cause });
  /** @type {any} */ (e).blobWrite = kind;
  return e;
}

/** The class of a failed writeUploadBlob: "digest" | "too_long" | "too_short", or null (any other failure). */
export function isBlobWriteError(error) {
  const k = error?.blobWrite;
  return k === "digest" || k === "too_long" || k === "too_short" ? k : null;
}

/**
 * Write a binary upload's body (a byte stream of exactly `size` bytes with SHA-256 `sha256`, lowercase hex) to `key`,
 * in one pass, R2 checking length and SHA-256. Returns { size, sha256 } as R2 recorded them. A classified failure
 * (isBlobWriteError) stores no complete object.
 * @returns {Promise<{ size: number|null, sha256: string|null }>}
 */
export async function writeUploadBlob(env, { key, body, size, sha256, contentType }) {
  try { return await putBlobStream(env, key, body, size, { sha256, httpMetadata: { contentType } }); }
  catch (e) {
    const m = String(/** @type {any} */ (e)?.message ?? e);
    if (/SHA-256 checksum you specified did not match|10037/.test(m)) throw blobWriteError("digest", e);
    if (/too many bytes/i.test(m)) throw blobWriteError("too_long", e);
    if (/did not see all expected bytes/i.test(m)) throw blobWriteError("too_short", e);
    throw e;
  }
}

/** Write a whole object held in memory (backup import and restore, at most the backup's 16 MiB file cap) to `key`. */
export async function writeBlobBytes(env, { key, bytes }) {
  await putBlob(env, key, bytes);
}

/**
 * A string as the database stores it: each lone surrogate becomes U+FFFD. Probed on local workerd D1: the id
 * "x\ud800" is stored as hex 78EFBFBD, and a second id "x\udc00" then fails UNIQUE on the primary key (node:sqlite
 * stores it the same way). Two such ids are one stored value, so they collide as the database's keys collide.
 */
export function storedText(v) {
  return String(v).replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd");
}

/**
 * The storage-key prefix of one document's file objects. Each segment is URI-encoded, as textKey does, so no
 * document's prefix is a prefix of another's ("a" and "a/b", or "a/b" and a literal "a%2Fb"). Ids the app creates
 * ([A-Za-z0-9_-], every project id) are unchanged by encoding; only a document id kept by restore can differ. Each
 * segment is the id as stored (storedText: a lone surrogate is stored as U+FFFD), so encoding never throws and two
 * ids that collide in the database share a prefix, never two different documents.
 */
export function blobPrefix(projectId, artifactId) {
  const seg = (v) => encodeURIComponent(storedText(v));
  return `blobs/${seg(projectId)}/${seg(artifactId)}/`;
}

/** R2's object-key limit, in UTF-8 bytes. */
const OBJECT_KEY_MAX_BYTES = 1024;

/** Can an object be written under this storage key? UTF-8 length at most R2's 1,024-byte limit. */
export function blobKeyFits(key) {
  return typeof key === "string" && key !== "" && new TextEncoder().encode(key).length <= OBJECT_KEY_MAX_BYTES;
}

/**
 * Upload finish's check of what the PUT stored, without reading the whole object: one head and, when `headBytes` is
 * positive, one ranged get of the first `headBytes` bytes.
 * Returns { ok: true, size, sha256, head } or { ok: false, reason: "missing" | "no_checksum" | "mismatch", size?,
 * sha256? } (mismatch carries R2's recorded values).
 */
export async function inspectUploadedBlob(env, { key, size, sha256 }, headBytes) {
  const stored = await headBlob(env, key);
  if (!stored) return { ok: false, reason: "missing" };
  const got = blobSha256Hex(stored);
  if (got === null) return { ok: false, reason: "no_checksum" };
  if (stored.size !== size || got !== sha256) return { ok: false, reason: "mismatch", size: stored.size, sha256: got };
  if (!headBytes) return { ok: true, size, sha256: got, head: new Uint8Array(0) };
  const head = await getBlobHead(env, key, headBytes);
  if (!head) return { ok: false, reason: "missing" };
  return { ok: true, size, sha256: got, head };
}

/**
 * For an outcome settled as NOT published only: delete those of `keys` that no revisions.blob_key refers to. If the
 * reference query (or a delete) fails it logs backup_cleanup_skipped and resolves; never throws.
 */
export async function dropUnreferencedBlobs(env, keys) {
  keys = keys.filter(Boolean);
  if (!keys.length) return;
  let unreferenced;
  try {
    unreferenced = (await env.DB.prepare(`SELECT j.value AS key FROM json_each(?) j
      WHERE NOT EXISTS (SELECT 1 FROM revisions WHERE blob_key = j.value)`).bind(JSON.stringify(keys)).all()).results.map((r) => r.key);
  } catch {
    console.error(JSON.stringify({ event: "backup_cleanup_skipped", count: keys.length, reason: "reference_query_failed" }));
    return;
  }
  try { await deleteBlobs(env, unreferenced); }
  catch { console.error(JSON.stringify({ event: "backup_cleanup_skipped", count: unreferenced.length, reason: "delete_failed" })); }
}

/** Up to `limit` object keys under a prefix (one page), for cleanup sweeps. */
export async function listBlobKeys(env, prefix, limit = 100) {
  const r = await env.BLOBS.list({ prefix, limit });
  return r.objects.map((o) => o.key);
}


// Inline compatibility codec: publisher generation copies still write inline; legacy versions and comments
// are decoded here by getText/getTextRange.
export function storeText(text) {
  return text;
}
export function readText(stored) {
  return stored;
}

/** Write one immutable text version; `scope` is not used. */
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
  if (!object) throw blobMissing();
  return new Uint8Array(await object.arrayBuffer());
}

/** Legacy inline rows remain readable while new versions store only a key in D1. */
export async function getText(env, row) {
  if (!row.body_key) return readText(row.body);
  const bytes = await getBlobBytes(env, row.body_key);
  if (!bytes) throw blobMissing();
  return new TextDecoder().decode(bytes);
}

/** Encode each ID independently; restore's optional attempt segment prevents retries overwriting prior bytes. */
export function textKey(projectId, artifactId, revisionId, attempt) {
  const key = `text/${encodeURIComponent(projectId)}/${encodeURIComponent(artifactId)}/${encodeURIComponent(revisionId)}${attempt ? `/${encodeURIComponent(attempt)}` : ""}`;
  if (new TextEncoder().encode(key).length > 1024) throw new HttpError(400, "bad_backup", "Text revision object key exceeds R2's 1024-byte limit");
  return key;
}

/** Persist intent before bytes: a dead request remains sweepable even if put succeeds after it dies. */
export async function stageTextWrite(env, projectId, artifactId, revisionId, text, attempt) {
  const key = textKey(projectId, artifactId, revisionId, attempt);
  await env.DB.prepare("INSERT INTO content_writes (key, project_id, created_at) VALUES (?, ?, ?)").bind(key, projectId, Date.now()).run();
  await putText(env, { projectId }, key, text);
  return key;
}

// Stay within Workers' six simultaneous connections, and await every in-flight operation on failure.
const CONTENT_CONCURRENCY = 6;
export async function mapContent(items, operation) {
  const results = new Array(items.length);
  let next = 0, failed = false, failure;
  await Promise.all(Array.from({ length: Math.min(CONTENT_CONCURRENCY, items.length) }, async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try { results[i] = await operation(items[i], i); }
      catch (error) { if (!failed) { failed = true; failure = error; } }
    }
  }));
  if (failed) throw failure;
  return results;
}

/** Stage multi-version operations in fresh 100-intent batches immediately before each chunk's bounded puts. */
export async function stageTextWrites(env, writes) {
  const staged = writes.map(w => ({ ...w, key: textKey(w.projectId, w.artifactId, w.revisionId, w.attempt) }));
  for (let i = 0; i < staged.length; i += 100) {
    const chunk = staged.slice(i, i + 100), now = Date.now();
    await env.DB.batch(chunk.map(w => env.DB.prepare("INSERT INTO content_writes (key, project_id, created_at) VALUES (?, ?, ?)").bind(w.key, w.projectId, now)));
    await mapContent(chunk, w => putText(env, { projectId: w.projectId }, w.key, w.text));
  }
  return staged.map(w => w.key);
}

/** Include in the same transaction that references the immutable key. */
export function textWriteComplete(env, key) {
  return env.DB.prepare("DELETE FROM content_writes WHERE key = ? AND (EXISTS (SELECT 1 FROM revisions WHERE body_key = ?) OR EXISTS (SELECT 1 FROM comments WHERE body_key = ?))").bind(key, key, key);
}

// The sweep age must stay well above the publish deadline: an intent eligible for deletion can never publish.
export const TEXT_WRITE_DEADLINE_MS = 10 * 60 * 1000;
export const TEXT_WRITE_STALE_MS = 60 * 60 * 1000;

// Depends on D1's SQLite constraint text; tested against local D1, not just a simulated error.
export function isTextWriteFenceError(error) {
  return /NOT NULL constraint failed: content_writes\.(?:project_id|created_at)\b/.test(String(error?.message ?? error));
}

/**
 * Atomic publication fence (the text-write deadline) and best-effort disposal of staged text objects known not to
 * have published: the cleanup deletes only keys that no revision or comment refers to. A slice that publishes text or
 * objects some other way must extend that check.
 */
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
    if (settled && keys.length) {
      try {
        const unreferenced = await env.DB.prepare(`SELECT j.value AS key FROM json_each(?) j
          WHERE NOT EXISTS (SELECT 1 FROM revisions WHERE body_key = j.value)
            AND NOT EXISTS (SELECT 1 FROM comments WHERE body_key = j.value)`).bind(JSON.stringify(keys)).all();
        const orphanKeys = unreferenced.results.map(r => r.key);
        if (orphanKeys.length) {
          await deleteBlobs(env, orphanKeys);
          await env.DB.prepare("DELETE FROM content_writes WHERE key IN (SELECT value FROM json_each(?))").bind(JSON.stringify(orphanKeys)).run();
        }
      } catch { console.error(JSON.stringify({ event: "text_write_cleanup_failed" })); }
    }
  }
}
