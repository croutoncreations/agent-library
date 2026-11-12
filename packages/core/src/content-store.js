import { HttpError } from "./util.js";
import { ACTIVE_KEY_SQL, KEY_SHREDDED_MESSAGE, NO_REAL_KEY_SQL } from "./crypto/keys.js";

// ContentStore: the one place the Worker reads or writes stored file bytes (R2 `BLOBS`).
//
// Today content is encrypted at rest by the storage provider (Cloudflare D1/R2), so these are pass-throughs.
// Per-workspace envelope encryption (hosted plan, "Encryption at rest") plugs in here: a KeyProvider wraps
// per-workspace data keys and R2 objects become chunked AES-GCM so Range reads keep working.
// test/content-store.test.mjs fails if any other module touches env.BLOBS. Text versions and comments use
// staged immutable writes and getText; legacy inline bodies still pass through readText.

/** Read a stored object, optionally a byte range ({ offset, length }). Returns an R2ObjectBody or null. */
export async function getBlob(env, key, range) {
  return range ? env.BLOBS.get(key, { range }) : env.BLOBS.get(key);
}

/** Read a whole stored object as bytes, or null if missing. */
export async function getBlobBytes(env, key) {
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

/** R2 accepts at most 1,000 keys in one delete call. Callers remove intents only after this succeeds. */
export async function deleteBlobs(env, keys) {
  for (let i = 0; i < keys.length; i += 1000) await env.BLOBS.delete(keys.slice(i, i + 1000));
}

/** Up to `limit` object keys under a prefix (one page), for cleanup sweeps. */
export async function listBlobKeys(env, prefix, limit = 100) {
  const r = await env.BLOBS.list({ prefix, limit });
  return r.objects.map((o) => o.key);
}


// Inline compatibility codec: publisher generation copies still write inline; legacy versions and comments
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

// Publication fences (docs/encryption.md#rules-for-code-that-uses-this). Each is an INSERT into the always-empty
// content_fences table that puts NULL into a NOT NULL column when its condition no longer holds, so the statement
// fails and D1 rolls back the whole batch. The failing column names the condition; fenceRefusal maps it.
// Never add a conflict clause (OR IGNORE, OR REPLACE, ON CONFLICT) to a fence: it would turn a refusal into a pass.

/**
 * Fence for a write under a workspace key: fails (content_fences.key_active) unless the key row `keyId` of
 * `workspaceId` is still active. Place the fence LAST in the batch, after every statement whose result the caller
 * reads; one statement that fails rolls back the whole batch wherever it sits.
 */
export function keyFence(env, { keyId, workspaceId } = {}) {
  if (typeof keyId !== "string" || !keyId || typeof workspaceId !== "string" || !workspaceId)
    throw new HttpError(500, "fence_invalid", "A key fence needs a key id and a workspace id");
  return env.DB.prepare(`INSERT INTO content_fences (key_active, no_real_key) SELECT NULL, 0
    WHERE NOT EXISTS (SELECT 1 FROM workspace_keys WHERE key_id = ? AND workspace_id = ? AND ${ACTIVE_KEY_SQL})`).bind(keyId, workspaceId);
}

/**
 * Fence for a plaintext write: fails (content_fences.no_real_key) once any real key row exists. Place the fence LAST
 * in the batch, after every statement whose result the caller reads; one statement that fails rolls back the whole
 * batch wherever it sits.
 */
export function plaintextFence(env) {
  return env.DB.prepare(`INSERT INTO content_fences (key_active, no_real_key) SELECT 0, NULL WHERE NOT ${NO_REAL_KEY_SQL}`);
}

/**
 * The HttpError a fence refusal answers (410 key_shredded, 409 encryption_started), or null for any other error.
 * An HttpError with one of those codes is returned unchanged, so mapping twice is safe. Otherwise the message of
 * `error`, its `cause` and that cause's `cause` (three levels at most; a bare string counts as a message) is matched.
 * runBatch and commitTextWrites already map refusals; call this only for a batch you run yourself.
 * Depends on D1's SQLite constraint text; tested against local D1. Place fences LAST in the batch, after every statement
 * whose result the caller reads; one statement that fails rolls back the whole batch wherever it sits.
 */
export function fenceRefusal(error) {
  if (error instanceof HttpError && (error.code === "key_shredded" || error.code === "encryption_started")) return error;
  let current = error;
  for (let depth = 0; depth < 3 && current != null; depth++) {
    const message = typeof current === "string" ? current : String(current.message ?? "");
    const m = /NOT NULL constraint failed: content_fences\.(key_active|no_real_key)\b/.exec(message);
    if (m) return m[1] === "key_active"
      ? new HttpError(410, "key_shredded", KEY_SHREDDED_MESSAGE)
      : new HttpError(409, "encryption_started", "Encryption was turned on while this was being saved; send it again");
    current = typeof current === "object" || typeof current === "function" ? current.cause : undefined;
  }
  return null;
}

/**
 * Atomic publication fence and best-effort disposal of objects known not to have published. A `commit` callback should
 * throw key_shredded / encryption_started only when nothing was published; either way the cleanup deletes only keys
 * that no revision or comment refers to. A slice that publishes text or objects some other way must extend that check.
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
    // A recognised refusal: clean up at once, like the text deadline below (only unreferenced keys go).
    const refusal = fenceRefusal(error);
    if (refusal) { settled = true; throw refusal; }
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
