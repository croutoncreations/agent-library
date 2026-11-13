// In-memory world for driving the production uploadPut/uploadFinish/reconcileUploads (packages/core/src/, bundled by
// load-worker.mjs), and purgeDueProjects, over every migration applied to node:sqlite and a controlled R2 double, so each interleaving is
// scheduled exactly. The R2 double behaves like R2 for what uploads rely on: put consumes a stream, refuses (storing
// nothing) bytes that don't match options.sha256, and put/head return size and checksums.sha256. Synthetic data only.
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ROOT } from "./helpers.mjs";
import { loadWorker } from "./load-worker.mjs";

export const lib = await loadWorker({ "uploads.js": ["quotaUsedSql", "uploadBegin", "uploadFinish", "uploadPut", "serveContent"], "cleanup.js": ["reconcileUploads"], "project-deletion.js": ["purgeDueProjects"], "adapters.js": ["withAdapters", "defaultAdapters"], "service.js": ["loadArtifact", "createMarkdown", "saveMarkdown", "saveFile", "restoreRevision", "getArtifact", "updateMetadata"], "templates/service.js": ["saveAsTemplate"], "backup.js": ["exportBackup", "restoreBackup", "importBackup"], "content-store.js": ["readBlob", "readBlobBytes", "writeUploadBlob", "writeBlobBytes", "isBlobWriteError", "inspectUploadedBlob", "blobKeyFits", "dropUnreferencedBlobs"] });
// The workerd stream class uploadPut uses, a minimal Node stand-in with workerd's messages: FixedLengthStream (errors
// unless exactly n bytes).
globalThis.FixedLengthStream ??= class extends TransformStream {
  constructor(n) {
    let seen = 0;
    super({ transform(c, out) { seen += c.byteLength; if (seen > n) throw new RangeError("Attempt to write too many bytes through a FixedLengthStream."); out.enqueue(c); }, flush() { if (seen !== n) throw new RangeError("FixedLengthStream did not see all expected bytes before close()."); } });
  }
};

export const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082", "hex");
export const SHA = createHash("sha256").update(PNG).digest("hex");
export const P = "prj_synthetic";

/**
 * D1's bind for a list, as workerd's D1 shim does it (probed on local D1): a list whose every element is a number
 * >= 0 and < 256 binds as a BLOB of Uint8Array.from(list) (fractions truncated); any other list throws D1_TYPE_ERROR at
 * bind. Other values pass through unchanged.
 */
export function d1BindArray(v) {
  if (!Array.isArray(v)) return v;
  if (v.every((b) => typeof b === "number" && b >= 0 && b < 256)) return Uint8Array.from(v);
  throw new Error(`D1_TYPE_ERROR: Type 'object' not supported for value '${v}'`);
}

export function world() {
  const sql = new DatabaseSync(":memory:");
  for (const f of readdirSync(join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort()) sql.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  // beforeBatch runs before BEGIN (reject before the commit); afterBatch runs after COMMIT (throw after the commit).
  const hooks = { beforeBatch: null, beforeRun: null, afterBatch: null };
  const stmt = (q, p) => ({
    async first(c) { const r = sql.prepare(q).get(...p); return c ? r?.[c] ?? null : r ?? null; },
    async all() { return { results: sql.prepare(q).all(...p) }; },
    // In a batch a SELECT returns its rows, as D1's batch does (backup export batches SELECTs).
    runSync() { if (/^\s*(SELECT|WITH)\b/i.test(q)) return { results: sql.prepare(q).all(...p), meta: { changes: 0 } }; const r = sql.prepare(q).run(...p); return { meta: { changes: Number(r.changes) } }; },
    async run() { if (hooks.beforeRun) await hooks.beforeRun(q); return this.runSync(); },
  });
  const DB = {
    withSession() { return DB; },
    prepare(q) { return { bind: (...p) => stmt(q, p.map(d1BindArray)), ...stmt(q, []) }; },
    async batch(ss) {
      if (hooks.beforeBatch) { const h = hooks.beforeBatch; hooks.beforeBatch = null; await h(); }
      sql.exec("BEGIN");
      let r;
      try { r = ss.map((s) => s.runSync()); sql.exec("COMMIT"); } catch (e) { sql.exec("ROLLBACK"); throw e; }
      if (hooks.afterBatch) { const h = hooks.afterBatch; hooks.afterBatch = null; await h(r); }
      return r;
    },
  };
  const blobs = new Map();
  // customMetadata and httpMetadata per stored key, as R2 keeps them with the object.
  const meta = new Map();
  const r2 = { onPut: null, beforeCommit: null, onGet: null, failHead: false, gets: [], deletes: [], cancels: [] };
  const digest = (b) => new Uint8Array(createHash("sha256").update(b).digest()).buffer;
  const BLOBS = {
    // R2ObjectBody-like: size (always the whole object's, as on a ranged get), customMetadata, a byte stream and
    // arrayBuffer, optionally of a range; put consumes a stream and, like R2, stores nothing when the stream errors or
    // the bytes do not match options.sha256.
    async get(k, opts) {
      r2.gets.push(opts?.range ?? null);
      if (r2.onGet) await r2.onGet(k);
      const whole = blobs.get(k);
      if (!whole) return null;
      const b = opts?.range ? whole.subarray(opts.range.offset, opts.range.offset + opts.range.length) : whole;
      // The body records a cancel in r2.cancels (the reader must release a body it refuses to read).
      const inner = new Blob([b]).stream().getReader();
      const body = new ReadableStream({ async pull(c) { const { done, value } = await inner.read(); if (done) c.close(); else c.enqueue(value); }, cancel(reason) { r2.cancels.push(k); return inner.cancel(reason); } }, { highWaterMark: 0 });
      return { size: whole.length, customMetadata: { ...meta.get(k)?.customMetadata }, httpMetadata: { ...meta.get(k)?.httpMetadata }, body, async arrayBuffer() { return b; } };
    },
    async put(k, b, opts) {
      const bytes = b instanceof ReadableStream ? Buffer.from(await new Response(b).arrayBuffer()) : b;
      if (opts?.sha256 && createHash("sha256").update(bytes).digest("hex") !== (typeof opts.sha256 === "string" ? opts.sha256 : Buffer.from(opts.sha256).toString("hex"))) throw new Error("put: The SHA-256 checksum you specified did not match what we received. (10037)");
      if (r2.beforeCommit) await r2.beforeCommit(k);
      blobs.set(k, bytes);
      meta.set(k, { customMetadata: { ...opts?.customMetadata }, httpMetadata: { ...opts?.httpMetadata } });
      if (r2.onPut) await r2.onPut(k);
      return { size: bytes.length, checksums: { sha256: digest(bytes) } };
    },
    async head(k) { if (r2.failHead) throw new Error("synthetic R2 head failure"); return blobs.has(k) ? { size: blobs.get(k).length, customMetadata: { ...meta.get(k)?.customMetadata }, checksums: { sha256: digest(blobs.get(k)) } } : null; },
    async delete(k) { for (const key of Array.isArray(k) ? k : [k]) { r2.deletes.push(key); blobs.delete(key); meta.delete(key); } },
    async list({ prefix, limit }) { return { objects: [...blobs.keys()].filter((k) => k.startsWith(prefix)).slice(0, limit).map((key) => ({ key })) }; },
  };
  const at = new Date().toISOString();
  sql.prepare("INSERT INTO principals (id, kind, issuer, subject, label, created_at) VALUES ('hum_synthetic','human','synthetic','owner','Synthetic owner',?)").run(at);
  sql.prepare("INSERT INTO projects (id, owner_id, title, created_at) VALUES (?,'hum_synthetic','Synthetic project',?)").run(P, at);
  // With the default adapters attached, as createWorker does for every request.
  const env = lib.withAdapters({ DB, BLOBS }, lib.defaultAdapters());
  const ctx = { env, principal: { id: "hum_synthetic", kind: "human", label: "Synthetic owner" }, requestId: "req_synthetic" };
  let n = 0;
  const upload = ({ state = "received", expiresAt = Date.now() + 900000 } = {}) => {
    const id = "upl_s" + ++n, art = "art_s" + n;
    // As uploadBegin writes it: final_key fixed at reservation, staging_key filled in but never written. Past
    // 'pending', the PUT has stored the bytes at final_key.
    const finalKey = `blobs/${P}/${art}/rev_s${n}`;
    sql.prepare("INSERT INTO artifacts(id,project_id,kind,title,created_at,updated_at) VALUES (?,?, 'binary','Synthetic image',?,?)").run(art, P, at, at);
    sql.prepare("INSERT INTO uploads(id,project_id,artifact_id,principal_id,base_rev,expected_size,expected_sha256,mime,state,staging_key,final_key,expires_at,created_at) VALUES (?,?,?,'hum_synthetic',0,?,?,'image/png',?,?,?,?,?)")
      .run(id, P, art, PNG.length, SHA, state, "staging/" + id, finalKey, expiresAt, at);
    if (state !== "pending") blobs.set(finalKey, PNG);
    return { id, art, finalKey };
  };
  const finals = () => [...blobs.keys()].filter((k) => k.startsWith("blobs/"));
  const revisions = (art) => sql.prepare("SELECT id, blob_key FROM revisions WHERE artifact_id = ?").all(art);
  const row = (id) => sql.prepare("SELECT * FROM uploads WHERE id = ?").get(id);
  const quota = () => sql.prepare("SELECT COALESCE(SUM(expected_size),0) AS n FROM uploads WHERE project_id = ? AND final_key IS NOT NULL AND final_purged_at IS NULL AND state IN ('failed','conflict')").get(P).n;
  // uploadPut over the transfer link path (linkCtx: no cookie, so no CSRF).
  const put = (id, body, length = body.length) => lib.uploadPut(new Request("https://example.test/api/transfers/" + id, { method: "PUT", body, headers: { "content-length": String(length) } }), env, ctx.requestId, id, ctx);
  return { sql, env, ctx, hooks, r2, blobs, meta, upload, put, finals, revisions, row, quota };
}

