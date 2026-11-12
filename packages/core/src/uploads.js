import { blobPrefix, blobRef, deleteBlob, fenceRefusal, getText, getTextRange, getUploadedText, inspectUploadedBlob, isBlobWriteError, keyFence, plaintextFence, putBlobStream, readBlob, writeUploadBlob } from "./content-store.js";
import { authenticate, authorizeProject, authzSql, contentWriteSql, enforceRate, limitsFor, requireCsrf } from "./auth.js";
import { PUT_MARGIN_MS, reconcileUploads } from "./cleanup.js";
import { CONTENT_TYPE, MEASUREMENTS, checkFile, spreadsheetSafeCsv } from "./formats.js";
import { __name } from "./runtime.js";
import { FILE_BYTES_CEILING, explainLimit, fileTooLarge, guardSql, projectLimitGuard, projectWorkspaceId } from "./limits.js";
import { BINARY_TYPES, IMAGE_TYPES, VIDEO_TYPES, appConnectEnabled, assertWritable, audit, idemLookup, loadArtifact, mdBody, provenance, publishRevision, requireAppConnect, textCreateMetadata } from "./service.js";
import { TEXT_MAX_BYTES } from "./text-limits.js";
import { HttpError, int, nowIso, nowMs, randomId, sha256Hex, str } from "./util.js";
import { deferSearchIndexing, extractUploadTerms, releaseUploadTerms, reserveUploadTerms, searchDocCap } from "./search/tokens.js";

var db2 = /* @__PURE__ */ __name((ctx) => ctx.env.DB, "db");
const TEXT_UPLOAD_KINDS = { "text/markdown": "markdown", "text/html": "html", "application/json": "json", "text/csv": "csv" };
// Text MIME types an installation offers: JSON and CSV only with App Connect enabled. One list for the MCP tool enums
// and the 415 "Allowed: …" message on every transport (app API, /v1, both MCP servers).
const textUploadMimes = (appConnect) => Object.keys(TEXT_UPLOAD_KINDS).filter((m) => appConnect || TEXT_UPLOAD_KINDS[m] === "markdown" || TEXT_UPLOAD_KINDS[m] === "html");
const BINARY_UPLOAD_SQL = "mime NOT IN ('text/markdown','text/html','application/json','text/csv')";
// Bytes charged to a project: published revisions, live reservations, and each ended (or expired) upload once while
// any object it may have written is not yet deleted: its staging_key (written only by an older Worker, which a rollback
// can bring back, so an unpurged one counts) or its final_key. One SUM with an OR, so a row is never charged twice.
var quotaUsedSql = (now) => `(SELECT COALESCE(SUM(size),0) FROM revisions WHERE project_id = ?1 AND blob_key IS NOT NULL)
  + (SELECT COALESCE(SUM(expected_size),0) FROM uploads WHERE project_id = ?1 AND ${BINARY_UPLOAD_SQL}
       AND (state IN ('receiving','sealed') OR (state IN ('pending','received') AND expires_at > ${Math.trunc(now)})))
  + (SELECT COALESCE(SUM(expected_size),0) FROM uploads WHERE project_id = ?1 AND ${BINARY_UPLOAD_SQL}
       AND (state IN ('failed','conflict') OR (state IN ('pending','received') AND expires_at <= ${Math.trunc(now)}))
       AND (staging_purged_at IS NULL OR (final_key IS NOT NULL AND final_purged_at IS NULL)))`;
// From the first deployed text-upload version, text staging_purged_at is set only after final_purged_at (raw input purged).
async function purgeStaging(env, u) {
  try {
    await deleteBlob(env, u.staging_key);
    await env.DB.prepare("UPDATE uploads SET staging_purged_at = ? WHERE id = ? AND staging_purged_at IS NULL AND (mime NOT IN ('text/markdown','text/html','application/json','text/csv') OR final_purged_at IS NOT NULL)").bind(nowMs(), u.id).run();
  } catch {
  }
}
// An object this upload wrote that no revision references. Deleted only when the upload is terminal (so no new write
// can start) and no write is in flight (so none can re-create it afterwards); otherwise cleanup purges it once the last
// write settles. Absent is harmless (R2 delete of a missing key is a no-op).
async function dropUnpublished(env, uploadId, finalKey) {
  const publishedText = await env.DB.prepare("SELECT 1 AS x FROM uploads WHERE id = ? AND state = 'published' AND mime IN ('text/markdown','text/html','application/json','text/csv') AND final_writes = 0 AND final_purged_at IS NULL").bind(uploadId).first("x");
  // Published text uses body_key, never this raw input key. Failed/conflicting uploads retain the binary reference guard.
  if (!publishedText) {
    const idle = await env.DB.prepare("SELECT 1 AS x FROM uploads u WHERE id = ? AND state IN ('failed','conflict') AND final_writes = 0 AND final_purged_at IS NULL AND NOT EXISTS (SELECT 1 FROM revisions r WHERE r.blob_key = u.final_key)").bind(uploadId).first("x");
    if (!idle) return;
  }
  await deleteBlob(env, finalKey);
  await env.DB.prepare("UPDATE uploads SET final_purged_at = ? WHERE id = ? AND final_purged_at IS NULL").bind(nowMs(), uploadId).run();
}
// MCP upload_begin/upload_finish wording and text-upload fields, shared by the legacy and OAuth transports.
// JSON/CSV fields are listed only with App Connect enabled (the server refuses them otherwise).
const UPLOAD_BEGIN_DESCRIPTION = "Start a text document (UTF-8, up to 10 MiB) or binary upload (plan file limit, at most 90 MiB). New: pass title; new version: artifact_id and expected_revision. Declare mime, exact size and SHA-256; HTTP PUT raw bytes to put_url, then call upload_finish. Keep your local file on conflict. Set change_note to why.";
const UPLOAD_FINISH_DESCRIPTION = "Validate uploaded bytes and publish one immutable version: UTF-8 and document rules for text, type signature for binaries. Safe to retry with the same key. Validation failure ends the upload; correct the file and start upload_begin again. A revision conflict requires re-reading and merging.";
function uploadBeginFields(appConnect) {
  return {
    mime: { type: "string", description: appConnect ? "Exact MIME type: text/markdown, text/html, application/json, text/csv, or a supported binary type." : "Exact MIME type: text/markdown, text/html, or a supported binary type." },
    mimeTypes: [...Object.keys(BINARY_TYPES), ...textUploadMimes(appConnect)],
    size: { type: "integer", minimum: 0, maximum: FILE_BYTES_CEILING, description: "Raw byte length, not JSON-escaped length. Text: at most 10,485,760 bytes; binaries: plan file limit." },
    title: "Title for a new document or file.",
    artifact_id: "Existing document or file to add a version to; also pass expected_revision.",
    folder: "Legacy folder label for a new document or file.",
    appConnect: appConnect ? {
      schema: { type: ["string", "null"], enum: [MEASUREMENTS, null], description: "New JSON/CSV: agentlib.measurements/1 to validate measurement records; omit for no schema. Existing documents keep their stored schema." },
      folder_id: { type: "string", maxLength: 64, description: "Same-project folder ID for a new text document (App Connect required); omit for project root." }
    } : {}
  };
}
// Upload-owned bytes: immutable published binary content, or temporary raw input for text publication.
var finalKeyFor = (projectId, artifactId) => blobPrefix(projectId, artifactId) + randomId("rev");
// Options are transport-owned, never request fields. transfer(uploadId) gives the transport's own { put_url, instructions }.
async function uploadBegin(ctx, projectId, input, key, { allowText = false, allowBinary = true, transfer } = {}) {
  await authorizeProject(ctx, projectId, true);
  const mime = str(input.mime, "mime", 100);
  // Text acceptance is transport-owned, never a request field (MCP upload_file stays binary-only).
  const kind = allowText && Object.hasOwn(TEXT_UPLOAD_KINDS, mime) ? TEXT_UPLOAD_KINDS[mime] : null;
  // Own properties only: an inherited name ("constructor", "__proto__", …) is not a supported type.
  if (!kind && !(allowBinary && Object.hasOwn(BINARY_TYPES, mime))) throw new HttpError(415, "unsupported_type", "Allowed: " + [...allowBinary ? Object.keys(BINARY_TYPES) : [], ...allowText ? textUploadMimes(appConnectEnabled(ctx.env)) : []].join(", "));
  // With App Connect off, JSON/CSV are not found whatever their declared size.
  if (kind === "json" || kind === "csv") requireAppConnect(ctx);
  const size = int(input.size, "size", kind ? 0 : 1, Number.MAX_SAFE_INTEGER);
  if (kind && size > TEXT_MAX_BYTES) throw new HttpError(413, "too_large", kind === "markdown" ? "Markdown exceeds 10 MiB" : kind === "html" ? "HTML exceeds 10 MiB" : `${kind} file exceeds 10 MiB`);
  // Workspace limits (limits.js): file size, storage (the reservation counts as used until it publishes or is
  // released) and, for a new file, its placeholder document counts toward the project's items.
  const adds = input.artifact_id ? { storage_bytes: size } : { storage_bytes: size, items_per_project: 1 };
  const lg = await projectLimitGuard(ctx.env, projectId, adds);
  if (!kind && size > lg.limits.file_bytes) throw fileTooLarge(lg.limits.file_bytes);
  const sha2 = str(input.sha256, "sha256", 64);
  if (!/^[0-9a-f]{64}$/.test(sha2)) throw new HttpError(400, "invalid_input", "sha256 must be 64 lowercase hex chars");
  let metadata, note = null, targetId, target;
  if (kind) {
    note = provenance(ctx, input)[4];
    if (input.artifact_id) {
      if (input.title !== void 0 || input.folder !== void 0 || input.folder_id !== void 0) throw new HttpError(400, "invalid_input", "Pass title and optional create metadata for a new document, or artifact_id and expected_revision for a new version");
      targetId = str(input.artifact_id, "artifact_id", 64);
      int(input.expected_revision, "expected_revision", 1);
    } else {
      if (input.expected_revision !== void 0) throw new HttpError(400, "invalid_input", "Pass title and optional create metadata for a new document, or artifact_id and expected_revision for a new version");
      metadata = await textCreateMetadata(ctx, projectId, input, kind);
    }
  }
  // Preserve the binary digest byte-for-byte for old replay compatibility.
  const parts = [mime, size, sha2, input.artifact_id ?? null, input.expected_revision ?? null, input.title ?? null];
  // Replacement digests depend only on the request, so replay needs no read of a changed or trashed document.
  const i = { op: "upload.begin", key, projectId, digest: await sha256Hex(JSON.stringify(kind ? [mime, size, sha2, targetId ?? null, input.expected_revision ?? null, metadata ?? input.schema ?? null, note] : parts)) };
  const prior = await idemLookup(ctx, i);
  if (prior) return prior;
  if (targetId) {
    target = await loadArtifact(ctx, projectId, targetId);
    assertWritable(ctx, target, "content");
    if (target.kind !== kind) throw new HttpError(400, "invalid_input", "mime must match the existing document kind");
    if (input.schema !== void 0 && (input.schema == null ? null : String(input.schema)) !== target.schema_id) throw new HttpError(400, "invalid_input", "schema must match the existing document schema");
  }
  await reconcileUploads(ctx.env, { projectId, limit: 20 });
  const limits = limitsFor(ctx.env);
  let artifactId;
  let baseRev;
  const stmts = [];
  const azBase = authzSql(ctx, projectId);
  const cw = kind && target ? contentWriteSql(ctx, target.id) : { sql: "1", params: [] };
  const az = { sql: `${azBase.sql} AND ${cw.sql}`, params: [...azBase.params, ...cw.params] };
  if (input.artifact_id) {
    artifactId = str(input.artifact_id, "artifact_id", 64);
    const a = target ?? await loadArtifact(ctx, projectId, artifactId);
    assertWritable(ctx, a, "content");
    if (!kind && a.kind !== "binary") throw new HttpError(400, "invalid_input", "Not a binary artifact");
    baseRev = int(input.expected_revision, "expected_revision", 1);
  } else {
    const title = metadata?.title ?? str(input.title, "title", 200, { min: 1 });
    artifactId = randomId("art");
    baseRev = 0;
    stmts.push(db2(ctx).prepare(`INSERT INTO artifacts (id, project_id, kind, title, folder, folder_id, schema_id, head_rev, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, 0, ?, ? WHERE ${az.sql} AND ${lg.sql}
      AND (? IS NULL OR EXISTS (SELECT 1 FROM folders WHERE id = ? AND project_id = ?))`).bind(artifactId, projectId, kind ?? "binary", title, metadata?.folder ?? str(input.folder, "folder", 200, { optional: true }), metadata?.folderId ?? null, metadata?.schema ?? null, nowIso(), nowIso(), ...az.params, ...lg.params, metadata?.folderId ?? null, metadata?.folderId ?? null, projectId));
  }
  const uploadId = randomId("upl", 18);
  const expires = nowMs() + limits.uploadTtlMs;
  const own = transfer?.(uploadId);
  const body2 = {
    upload_id: uploadId,
    artifact_id: artifactId,
    base_revision: baseRev,
    put_url: own?.put_url ?? `/api/transfers/${uploadId}`,
    method: "PUT",
    expires_at: new Date(expires).toISOString(),
    instructions: own?.instructions ?? (kind ? "PUT the raw bytes to put_url with the same credentials (and CSRF token for a cookie session), then call upload_finish. Text must be UTF-8." : "PUT the raw file bytes to put_url with the same Authorization, then call upload_finish.")
  };
  const gate = "EXISTS (SELECT 1 FROM uploads WHERE id = ?)";
  // The reservation re-checks storage only: a new file's placeholder (above) already passed the items limit, and the
  // reservation needs it to exist. PROJECT_BINARY_BYTES "0" = no per-project file cap (workspace storage governs).
  const sg = guardSql(lg.limits, lg.workspaceId, { storage_bytes: size }, projectId);
  stmts.push(
    // Reservation: inserted only if the project quota still has room, evaluated in the same statement.
    // The partial unique index uploads_one_active rejects a second concurrent active upload outright.
    // final_key, the one object this upload ever writes (by its PUT), is fixed here. staging_key is still filled in
    // because the previous Worker's cleanup deletes it for published uploads, but nothing is ever written there.
    db2(ctx).prepare(`INSERT INTO uploads (id, project_id, artifact_id, principal_id, base_rev, expected_size, expected_sha256, mime, state, staging_key, final_key, expires_at, created_at, change_note)
      SELECT ?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', ?9, ?13, ?10, ?11, ?14
      WHERE (?12 = 0 OR ${quotaUsedSql(nowMs())} + ?6 <= ?12) AND EXISTS (SELECT 1 FROM artifacts WHERE id = ?3 AND project_id = ?1)
        AND ${az.sql} AND ${sg.sql}`).bind(projectId, uploadId, artifactId, ctx.principal.id, baseRev, size, sha2, mime, `staging/${projectId}/${uploadId}`, expires, nowIso(), kind ? 0 : limits.projectBinaryBytes, finalKeyFor(projectId, artifactId), note, ...az.params, ...sg.params),
    db2(ctx).prepare(`INSERT INTO idempotency (principal_id, project_id, op, key, digest, status, response, created_at)
      SELECT ?, ?, ?, ?, ?, 201, ?, ? WHERE ${gate}`).bind(ctx.principal.id, projectId, i.op, i.key, i.digest, JSON.stringify(body2), nowIso(), uploadId),
    audit(ctx, projectId, "upload.begin", artifactId, baseRev, "ok", gate, [uploadId])
  );
  const res = await db2(ctx).batch(stmts).catch(async (e) => {
    const p = await idemLookup(ctx, i);
    if (p) return p;
    if (/uploads\.principal_id|UNIQUE/i.test(String(e?.message ?? e)))
      throw new HttpError(429, "upload_in_progress", "One active upload per identity; finish or let it expire first");
    throw e;
  });
  if (!Array.isArray(res)) return res;
  const uploadRow = res[input.artifact_id ? 0 : 1];
  if (!uploadRow.meta.changes) {
    if (!input.artifact_id) await db2(ctx).prepare("DELETE FROM artifacts WHERE id = ? AND head_rev = 0 AND NOT EXISTS (SELECT 1 FROM uploads WHERE artifact_id = ?)").bind(artifactId, artifactId).run();
    const used = await db2(ctx).prepare(`SELECT ${quotaUsedSql(nowMs())} AS n`).bind(projectId).first("n");
    if (!kind && limits.projectBinaryBytes > 0 && (used ?? 0) + size > limits.projectBinaryBytes)
      throw new HttpError(413, "quota_exceeded", "Project binary storage quota exceeded", { used_bytes: used, limit_bytes: limits.projectBinaryBytes });
    if (lg.workspaceId) await explainLimit(ctx.env, lg.workspaceId, adds, lg.limits, projectId);
    throw new HttpError(403, "forbidden", "Grant no longer valid");
  }
  return { status: 201, body: body2 };
}
async function uploadPut(req, env, requestId, uploadId, linkCtx, { projectId, rateCharged = false } = {}) {
  // linkCtx: built by the server from a live credential, never from the request: handleFileTransfer's OAuth connection,
  // or /v1's verified API key (no cookie on either, so no CSRF). /v1 passes its route's projectId and has already
  // charged this request to the write rate limit (rateCharged).
  const ctx = linkCtx ?? await authenticate(req, env, requestId);
  if (!linkCtx) requireCsrf(ctx, req);
  if (!rateCharged) await enforceRate(ctx, true);
  const u = await env.DB.prepare("SELECT * FROM uploads WHERE id = ?").bind(uploadId).first();
  if (!u || u.principal_id !== ctx.principal.id || projectId !== void 0 && u.project_id !== projectId) throw new HttpError(404, "not_found", "Upload not found");
  await authorizeProject(ctx, u.project_id, true);
  if (u.expires_at <= nowMs()) throw new HttpError(410, "upload_expired", "Upload expired");
  // R2 checks the stored length against the declared size anyway: refuse any other Content-Length before writing.
  const cl = req.headers.get("content-length");
  if (cl !== null && !/^\d+$/.test(cl)) throw new HttpError(400, "invalid_input", "Content-Length must be a non-negative integer");
  const declared = cl === null ? NaN : Number(cl);
  if (Number.isFinite(declared) && declared > u.expected_size) throw new HttpError(413, "too_large", "Body exceeds declared size");
  if (Number.isFinite(declared) && declared < u.expected_size) throw new HttpError(400, "incomplete_body", "Content-Length is smaller than the declared size; PUT the whole file");
  if (!req.body && u.expected_size !== 0) throw new HttpError(400, "invalid_input", "Missing body");
  const textKind = Object.hasOwn(TEXT_UPLOAD_KINDS, u.mime) ? TEXT_UPLOAD_KINDS[u.mime] : null;
  if (textKind) {
    if (textKind === "json" || textKind === "csv") requireAppConnect(ctx);
    assertWritable(ctx, await loadArtifact(ctx, u.project_id, u.artifact_id, { allowUnpublished: u.base_rev === 0 }), "content");
  }
  // Binary uploads write under the server-side project's workspace key when encryption is on (never a request field).
  const workspaceId = textKind ? null : await projectWorkspaceId(env, u.project_id);
  const azBase = authzSql(ctx, u.project_id);
  const cw = textKind ? contentWriteSql(ctx, u.artifact_id) : { sql: "1", params: [] };
  const az = { sql: `${azBase.sql} AND ${cw.sql}`, params: [...azBase.params, ...cw.params] };
  // Claim the upload and register the write in one statement: cleanup purges final_key only once final_writes is 0.
  // An upload begun by the previous Worker has no final_key yet; it is fixed here (nothing else writes it while pending).
  const finalKey = u.final_key ?? finalKeyFor(u.project_id, u.artifact_id);
  const claim = await env.DB.prepare(`UPDATE uploads SET state = 'receiving', final_writes = final_writes + 1, final_key = COALESCE(final_key, ?)
    WHERE id = ? AND state = 'pending' AND expires_at > ? AND ${az.sql}`).bind(finalKey, uploadId, nowMs(), ...az.params).run();
  if (!claim.meta.changes) throw new HttpError(409, "upload_not_writable", "Upload is not accepting bytes (in progress, sealed or published)");
  try {
    // One pass, constant memory (files reach FILE_BYTES_CEILING, Workers have 128 MB): the body streams straight to
    // final_key. R2 checks the length (FixedLengthStream) and the declared SHA-256, and stores nothing if either is wrong.
    // Deadline (cleanup.js PUT_MARGIN_MS): the body is aborted at expires_at (a chunk after it, or a timer, errors the
    // stream), and the put is abandoned at expires_at + PUT_MARGIN_MS, so cleanup can treat older write counts as stale.
    const deadline = u.expires_at;
    const expired = () => new HttpError(410, "upload_expired", "Upload expired during transfer");
    let written, bodyCtl, abortTimer, marginTimer, timedOut = false, abandoned = false;
    const body = (req.body ?? new ReadableStream({ start(c) { c.close(); } })).pipeThrough(new TransformStream({
      start(c) { bodyCtl = c; },
      transform(chunk, out) {
        if (nowMs() > deadline) { timedOut = true; throw expired(); }
        out.enqueue(chunk);
      }
    }));
    try {
      abortTimer = setTimeout(() => { timedOut = true; bodyCtl.error(expired()); }, Math.max(0, deadline - nowMs()));
      const margin = new Promise((_, reject) => {
        marginTimer = setTimeout(() => { timedOut = abandoned = true; bodyCtl.error(expired()); reject(expired()); }, Math.max(0, deadline + PUT_MARGIN_MS - nowMs()));
      });
      // Text input stays plaintext (slice 3c); a binary goes through writeUploadBlob, which encrypts when enabled.
      const put = textKind
        ? putBlobStream(env, finalKey, body, u.expected_size, { sha256: u.expected_sha256, httpMetadata: { contentType: u.mime } })
          .then((stored) => ({ ...stored, keyId: null, header: null }))
        : writeUploadBlob(env, { key: finalKey, body, size: u.expected_size, sha256: u.expected_sha256, contentType: u.mime, workspaceId });
      // An abandoned put may still reject later; never let that surface as an unhandled rejection (it carries R2's message).
      put.catch(() => {
      });
      written = await Promise.race([put, margin]);
    } catch (e) {
      const m = String(e?.message ?? e);
      const kind = isBlobWriteError(e);
      // A digest rejection is a real answer even if a timer fired meanwhile: report it (and end the upload) as 422.
      if (!abandoned && (kind === "digest" || textKind && /SHA-256 checksum you specified did not match|10037/.test(m))) throw new HttpError(422, "integrity_mismatch", "The body's SHA-256 does not match the declared sha256; this upload has ended, start a new upload");
      if (timedOut) throw expired();
      if (kind === "too_long" || textKind && /too many bytes/i.test(m)) throw new HttpError(413, "too_large", "Body exceeds declared size");
      if (kind === "too_short" || textKind && /did not see all expected bytes/i.test(m)) throw new HttpError(400, "incomplete_body", "Body ended before the declared size; PUT the whole file again");
      throw e;
    } finally {
      clearTimeout(abortTimer);
      clearTimeout(marginTimer);
      // A release failure leaves accounting raised (fail closed): the object stays tracked and charged. Log it without
      // replacing the PUT's own error. Never log blob keys or errors. An abandoned put might still commit, so its count
      // is left for cleanup to treat as stale.
      if (!abandoned) await env.DB.prepare("UPDATE uploads SET final_writes = final_writes - 1 WHERE id = ? AND final_writes > 0").bind(uploadId).run().catch(() => {
        console.warn(JSON.stringify({ event: "upload_final_write_release_failed" }));
      });
    }
    const n = written?.size ?? null;
    const sha2 = written?.sha256 ?? null;
    // Re-checks the grant (same as the claim): access revoked mid-transfer leaves the upload unreceived. The
    // encryption pair (NULL for plaintext) is always bound: finish reads the object under exactly this header.
    const rec = await env.DB.prepare(`UPDATE uploads SET state = 'received', received_size = ?, received_sha256 = ?, enc_key_id = ?, enc_header = ? WHERE id = ? AND state = 'receiving' AND ${az.sql}`).bind(n, sha2, written?.keyId ?? null, written?.header ?? null, uploadId, ...az.params).run();
    if (!rec.meta.changes) {
      if (await env.DB.prepare("SELECT 1 AS x FROM uploads WHERE id = ? AND state = 'receiving'").bind(uploadId).first("x"))
        throw new HttpError(403, "forbidden", "Grant no longer valid");
      // Cleanup ended the upload, or a project purge removed its row, mid-transfer: remove the object just stored, best
      // effort (cleanup or the purge's prefix sweep catch a failure). A fresh rev_ key is never referenced before
      // publish; dropUnpublished re-checks that and that no write is in flight.
      await (async () => {
        if (await env.DB.prepare("SELECT 1 AS x FROM uploads WHERE id = ?").bind(uploadId).first("x")) return dropUnpublished(env, uploadId, finalKey);
        if (!await env.DB.prepare("SELECT 1 AS x FROM revisions WHERE blob_key = ?").bind(finalKey).first("x")) await deleteBlob(env, finalKey);
      })().catch(() => {});
      throw new HttpError(410, "upload_expired", "Upload expired during transfer");
    }
    await audit(ctx, u.project_id, "upload.put", u.artifact_id, null, "ok").run();
    return new Response(JSON.stringify({ upload_id: uploadId, received_bytes: n, sha256: sha2, matches_declared: n === u.expected_size && sha2 === u.expected_sha256 }), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "private, no-store" }
    });
  } catch (e) {
    // The declared SHA-256 can't match on any retry of these bytes (or the workspace key is shredded, which is
    // permanent): end the upload so finish replays the answer and a new upload_begin can start. Nothing was stored, so
    // the slot and quota are freed at once. 400, 413 and 500 encryption_misconfigured go back to pending (retryable).
    if (e instanceof HttpError && (e.code === "integrity_mismatch" || e.code === "key_shredded")) {
      const failed = await env.DB.prepare("UPDATE uploads SET state = 'failed', result = ? WHERE id = ? AND state = 'receiving'")
        .bind(JSON.stringify({ status: e.status, code: e.code, message: e.message }), uploadId).run();
      if (failed.meta.changes) {
        await audit(ctx, u.project_id, "upload.put", u.artifact_id, null, "failed:" + e.code).run();
        await dropUnpublished(env, uploadId, finalKey);
        await purgeStaging(env, u);
      }
      throw e;
    }
    await env.DB.prepare("UPDATE uploads SET state = 'pending' WHERE id = ? AND state = 'receiving'").bind(uploadId).run();
    throw e;
  }
}
// Exclusive upload finalization (security review 2026-10-23, findings 1 and 3); needs migration
// 0011_upload_finalize_lease.sql.
//  - One finisher at a time holds an expiring lease (uploads.finalize_token/finalize_until). Cleanup never fails a
//    sealed upload while its lease is live, and the revision insert is fenced on "still sealed and still my token",
//    so cleanup can never delete bytes under a publication that then succeeds.
//  - Single pass (docs/upload-finalization.md): the final R2 key is fixed at upload begin (uploads.final_key; the lease
//    COALESCE only covers rows begun by an older Worker) and only uploadPut writes it, from 'pending', with R2
//    verifying length and SHA-256. Binary finish writes nothing: it checks metadata and the first bytes' signature.
//    Text finish reads this temporary input once and publishes through the ordinary intent-fenced text writer.
//  - Every final-object write is counted in uploads.final_writes (taken in the PUT's claim, released when the put
//    settles). Cleanup purges a failed upload's final object only once no write is in flight; a failed upload can
//    start no new write, so nothing re-creates the object afterwards. A Worker that dies mid-put leaves the count
//    raised: the object stays tracked and counted against quota until the count is stale (cleanup.js PUT_MARGIN_MS).
//  - A finisher that lost its lease never deletes or publishes; it replays the upload's recorded outcome, or answers
//    409 finish_in_progress while another finisher still holds the lease.
var FINALIZE_LEASE_MS = 60 * 1e3;
var FINALIZE_WAIT_MS = 3e3;
// Isolate-local, non-queuing backpressure before any full text read. Expiry follows the holder's finalize lease,
// including renewal; token-owned release cannot clear a successor if an expired request settles late.
let textFinishSlot = null;
async function uploadFinish(ctx, projectId, uploadId, key) {
  await authorizeProject(ctx, projectId, true);
  const u = await db2(ctx).prepare("SELECT * FROM uploads WHERE id = ? AND project_id = ?").bind(uploadId, projectId).first();
  if (!u || u.principal_id !== ctx.principal.id) throw new HttpError(404, "not_found", "Upload not found");
  const recorded = (row) => {
    if (!row || !row.result || !(row.state === "published" || row.state === "conflict" || row.state === "failed")) return null;
    const r = JSON.parse(row.result);
    if (r.status >= 400) throw new HttpError(r.status, r.code, r.message, r.extra);
    return { status: 200, body: { ...r.body, idempotent_replay: true } };
  };
  {
    const r = recorded(u);
    if (r) return r;
  }
  const i = { op: "upload.finish:" + uploadId, key, projectId, digest: await sha256Hex(uploadId) };
  const prior = await idemLookup(ctx, i);
  if (prior) return prior;
  if (u.expires_at <= nowMs() && u.state !== "sealed") throw new HttpError(410, "upload_expired", "Upload expired");
  const az = authzSql(ctx, projectId);
  // Received or sealed with no final_key: the previous Worker took this PUT, so its bytes are at staging_key, which
  // this Worker never publishes from. End it (unless an older finisher holds the lease) and purge staging_key.
  if (u.final_key === null && (u.state === "received" || u.state === "sealed")) {
    const msg = "This upload started before an update; start it again with upload_begin";
    const ended = await db2(ctx).prepare(`UPDATE uploads SET state = 'failed', result = ? WHERE id = ? AND state IN ('received','sealed') AND final_key IS NULL
      AND (finalize_until IS NULL OR finalize_until <= ?) AND ${az.sql}`).bind(JSON.stringify({ status: 409, code: "reupload_required", message: msg }), uploadId, nowMs(), ...az.params).run();
    if (ended.meta.changes) {
      await audit(ctx, projectId, "upload.finish", u.artifact_id, null, "failed:reupload_required").run();
      await purgeStaging(ctx.env, u);
      throw new HttpError(409, "reupload_required", msg);
    }
    const r = recorded(await db2(ctx).prepare("SELECT state, result FROM uploads WHERE id = ?").bind(uploadId).first());
    if (r) return r;
    throw new HttpError(409, "finish_in_progress", "Another finish of this upload is in progress; retry shortly", { retry_after_seconds: 1 });
  }
  const seal = await db2(ctx).prepare(`UPDATE uploads SET state = 'sealed' WHERE id = ? AND state = 'received' AND ${az.sql}`).bind(uploadId, ...az.params).run();
  if (!seal.meta.changes) {
    const cur = await db2(ctx).prepare("SELECT state FROM uploads WHERE id = ?").bind(uploadId).first("state");
    if (cur !== "sealed") throw new HttpError(409, "upload_not_ready", `Upload state is ${cur}; PUT the bytes first`);
  }
  const token = randomId("fin");
  const current = () => db2(ctx).prepare("SELECT state, result, final_key, finalize_token, finalize_until, received_size, received_sha256, enc_key_id, enc_header FROM uploads WHERE id = ?").bind(uploadId).first();
  const busy = (row) => new HttpError(409, "finish_in_progress", "Another finish of this upload is in progress; retry shortly", { retry_after_seconds: Math.max(1, Math.ceil(((row?.finalize_until ?? nowMs()) - nowMs()) / 1e3)) });
  const pause = () => new Promise((r2) => setTimeout(r2, 250));
  // Not (or no longer) the finisher: replay the recorded outcome, waiting briefly for the finisher that holds the lease.
  const lost = async () => {
    for (const deadline = nowMs() + FINALIZE_WAIT_MS; ; await pause()) {
      const row = await current();
      const r = recorded(row);
      if (r) return r;
      if (!row || row.state !== "sealed") throw new HttpError(409, "upload_not_ready", `Upload state is ${row?.state}`);
      if (nowMs() >= deadline || row.finalize_until === null || row.finalize_until <= nowMs()) throw busy(row);
    }
  };
  // Take the lease (re-checking the grant in the same statement); while another finisher holds it, wait briefly.
  for (let deadline = nowMs() + FINALIZE_WAIT_MS, free = 0; ; await pause()) {
    const lease = await db2(ctx).prepare(`UPDATE uploads SET finalize_token = ?, finalize_until = ?, final_key = COALESCE(final_key, ?)
      WHERE id = ? AND state = 'sealed' AND (finalize_until IS NULL OR finalize_until <= ?) AND ${az.sql}`).bind(token, nowMs() + FINALIZE_LEASE_MS, finalKeyFor(projectId, u.artifact_id), uploadId, nowMs(), ...az.params).run();
    if (lease.meta.changes) break;
    const row = await current();
    const r = recorded(row);
    if (r) return r;
    if (!row || row.state !== "sealed") throw new HttpError(409, "upload_not_ready", `Upload state is ${row?.state}`);
    // The lease was free yet not taken twice: the grant check in the statement refused it.
    if (row.finalize_until === null || row.finalize_until <= nowMs()) {
      if (++free >= 2) throw new HttpError(403, "forbidden", "Grant no longer valid");
    } else if (nowMs() >= deadline) throw busy(row);
  }
  const fenced = "EXISTS (SELECT 1 FROM uploads WHERE id = ? AND state = 'sealed' AND finalize_token = ?)";
  let text;
  // Blind-index search terms of a text finish: the payload reservation (taken in the slot before extraction) and the
  // packed terms. Every exit releases what no admitted job holds (finally below).
  let searchTicket = null, searchFlat = null, searchUnits = 0, searchCap = 0;
  let hasTextFinishSlot = false;
  const releaseTextFinishSlot = () => {
    text = null;
    if (hasTextFinishSlot && textFinishSlot?.token === token) textFinishSlot = null;
  };
  // Every outcome is awaited before returning (`return await`): the finally must not release the lease before it is recorded.
  try {
    const held = await current();
    const finalKey = held?.final_key;
    // The encoded prefix only. The unencoded form of one id can be another's encoded prefix (a document literally named
    // "a%2Fb" vs "a/b"), so accepting it would let one document's key pass for the other. For every id the app creates
    // the two are the same string; an upload begun by the previous Worker on a restored document whose id needs
    // encoding is refused here and must be started again.
    const prefix = blobPrefix(projectId, u.artifact_id);
    if (held?.finalize_token !== token || typeof finalKey !== "string" || !finalKey.startsWith(prefix) || !/^rev_[A-Za-z0-9_-]+$/.test(finalKey.slice(prefix.length)))
      throw new HttpError(500, "publish_failed", "Upload finalization state is inconsistent");
    const kind = Object.hasOwn(TEXT_UPLOAD_KINDS, u.mime) ? TEXT_UPLOAD_KINDS[u.mime] : null;
    const revId = kind ? randomId("rev") : finalKey.slice(prefix.length);
    // Ends the upload with an error, only while this finisher still holds the lease.
    const end = async (status, code, message, state, extra) => {
      const r = await db2(ctx).prepare("UPDATE uploads SET state = ?, result = ?, finalize_token = NULL, finalize_until = NULL WHERE id = ? AND state = 'sealed' AND finalize_token = ?").bind(state, JSON.stringify({ status, code, message, extra }), uploadId, token).run();
      if (!r.meta.changes) return false;
      releaseTextFinishSlot();
      await audit(ctx, projectId, "upload.finish", u.artifact_id, null, "failed:" + code).run();
      return true;
    };
    const fail = async (status, code, message, state, extra) => {
      if (!await end(status, code, message, state, extra)) return await lost();
      await dropUnpublished(ctx.env, uploadId, finalKey).catch((e) => { if (!kind) throw e; });
      await purgeStaging(ctx.env, u);
      throw new HttpError(status, code, message, extra);
    };
    // Lost the lease before publishing: if cleanup ended the upload, remove the unreferenced object now (cleanup would
    // too). A takeover finisher (upload still sealed) publishes the same object.
    const lostAfterWrite = async () => {
      releaseTextFinishSlot();
      const row = await current();
      if (row && (row.state === "failed" || row.state === "conflict")) await dropUnpublished(ctx.env, uploadId, finalKey);
      return await lost();
    };
    // A binary is never empty (uploadBegin refuses size 0): no signature can match, so refuse before any R2 read.
    if (!kind && u.expected_size === 0) return await fail(415, "signature_mismatch", `Bytes are not a valid ${u.mime}`, "failed");
    // No write and no whole-object read: the upload's PUT already stored the bytes at final_key. One head, plus (for a
    // binary) one ranged get of the first bytes. Plaintext: R2 checked length and the declared SHA-256 on the way in;
    // confirm what it recorded (fail closed without a checksum). Encrypted: the PUT's plainTap counted and hashed the
    // plaintext; the object's metadata and stored size must match and chunk 0 must authenticate under the recorded
    // header. Then check the type signature on the first bytes (BINARY_TYPES checks need at most 13).
    const workspaceId = held.enc_key_id ? await projectWorkspaceId(ctx.env, projectId) : null;
    let check;
    try {
      check = await inspectUploadedBlob(ctx.env, { key: finalKey, projectId, artifactId: u.artifact_id, workspaceId, size: u.expected_size, sha256: u.expected_sha256,
        keyId: held.enc_key_id ?? null, header: held.enc_header ?? null, receivedSize: held.received_size, receivedSha256: held.received_sha256 }, kind ? 0 : 16);
    } catch (e) {
      if (e instanceof HttpError && e.code === "key_shredded") return await fail(e.status, e.code, e.message, "failed");
      // The recorded key id names no key of this workspace, or its row is malformed: retrying this upload cannot heal
      // that, so it ends failed (publish_failed). This assumes key rows are read from the primary database (a key
      // created moments ago is always visible); revisit if D1 read replicas are ever enabled for this request. Configuration and provider errors (encryption_misconfigured,
      // encryption_not_configured, master_key_*, key_unwrap_failed, key_provider_invalid) can heal: the upload stays
      // sealed and retryable.
      if (e instanceof HttpError && (e.code === "key_not_found" || e.code === "key_row_invalid" || e.code === "invalid_key_id")) {
        console.error(JSON.stringify({ event: "upload_finish_key_error", code: e.code, projectId, artifactId: u.artifact_id }));
        return await fail(500, "publish_failed", "Stored object failed verification", "failed");
      }
      throw e;
    }
    if (!check.ok && check.reason === "missing") return await fail(409, "missing_bytes", "Uploaded bytes missing", "failed");
    if (!check.ok && check.reason === "no_checksum") return await fail(500, "publish_failed", "Stored object has no SHA-256 checksum", "failed");
    if (!check.ok && check.reason === "mismatch")
      return await fail(422, "integrity_mismatch", "Byte length or SHA-256 does not match declaration", "failed", { received_size: check.size, received_sha256: check.sha256 });
    if (!check.ok) return await fail(500, "publish_failed", "Stored object failed verification", "failed");
    const size = check.size;
    const sha2 = check.sha256;
    if (kind) {
      if (kind === "json" || kind === "csv") requireAppConnect(ctx);
      const a = await loadArtifact(ctx, projectId, u.artifact_id, { allowUnpublished: u.base_rev === 0 });
      assertWritable(ctx, a, "content");
      if (a.kind !== kind) throw new HttpError(400, "invalid_input", "mime must match the existing document kind");
      if (textFinishSlot && textFinishSlot.until > nowMs()) throw new HttpError(503, "text_finish_busy", "Another text upload is being finalized on this server; retry the finish request shortly with the same idempotency key", { retry_after_seconds: 1 });
      textFinishSlot = { token, until: held.finalize_until };
      hasTextFinishSlot = true;
      try {
        text = await getUploadedText(ctx.env, finalKey, kind);
        if (textFinishSlot?.token !== token || textFinishSlot.until <= nowMs()) return await lostAfterWrite();
        if (text === null) return await fail(409, "missing_bytes", "Uploaded bytes missing", "failed");
        if (kind === "markdown" || kind === "html") mdBody(text, kind);
        else checkFile(kind, text, a.schema_id);
        // Search terms, beside the validation and before the response: reserve, then extract (the text is not kept by
        // search). A failure here never refuses the upload: the document is counted skipped and stays missing.
        searchCap = searchDocCap(ctx.env, check.size);
        searchUnits = text.length;
        if (searchCap > 0) {
          // The ticket owns the terms: when the run settles, detaches or is discarded, they are released and dropped.
          searchTicket = reserveUploadTerms(ctx.env, text, check.size);
          if (searchTicket) searchFlat = extractUploadTerms(ctx.env, searchTicket, text);
        }
      } catch (e) {
        // Only document validation errors are terminal. R2/D1 failures retain their retryable sealed state.
        if (e instanceof HttpError && (e.code === "invalid_content" || e.code === "too_large" || e.code === "invalid_input")) return await fail(e.status, e.code, e.message, "failed", e.extra);
        throw e;
      }
    } else {
      // Binary finish must never read the whole object or perform a second write: check.head is its first 16 bytes.
      const head = check.head;
      // An upload begun before own-property checking may carry an inherited name: it is never a valid type.
      if (!Object.hasOwn(BINARY_TYPES, u.mime) || !BINARY_TYPES[u.mime](head)) return await fail(415, "signature_mismatch", `Bytes are not a valid ${u.mime}`, "failed");
    }
    // Still the finisher? Renew the lease for the publication.
    const renewedUntil = nowMs() + FINALIZE_LEASE_MS;
    const renew = await db2(ctx).prepare(`UPDATE uploads SET finalize_until = ? WHERE id = ? AND state = 'sealed' AND finalize_token = ?${kind ? " AND finalize_until > ?" : ""}`).bind(renewedUntil, uploadId, token, ...kind ? [nowMs()] : []).run();
    if (!renew.meta.changes) return await lostAfterWrite();
    if (hasTextFinishSlot && textFinishSlot?.token === token) textFinishSlot.until = renewedUntil;
    const ok2 = { artifact_id: u.artifact_id, revision: u.base_rev + 1, revision_id: revId, sha256: sha2, size };
    const gate = "EXISTS (SELECT 1 FROM revisions WHERE id = ?)";
    // publishRevision's own "committed, not a replay" decision, without keeping its job (which holds the text).
    let committedRevId = null;
    const onSearchJob = (job) => { committedRevId = job.revisionId; };
    let res;
    try {
      res = await publishRevision(
        ctx,
        projectId,
        u.artifact_id,
        u.base_rev,
        i,
        // change_note: recorded at upload_begin by OAuth connections (migration 0013); undefined on older schemas.
        // A binary carries its publication fence LAST (docs/encryption.md): its key must still be active, or (plaintext)
        // no real key may exist yet. Text publication is unchanged until slice 3c.
        // With search on, the upload supplies its own (flat) job; off (SEARCH_TERMS_MAX = 0), publishRevision defers its
        // off job as every path does (the text is not kept).
        { ...kind ? { body: text, reservedUpload: { id: uploadId, token }, ...searchCap > 0 ? { onSearchJob } : {} } : { blobKey: finalKey, blobKeyId: held.enc_key_id ?? null, blobHeader: held.enc_header ?? null,
          contentFences: [held.enc_key_id ? keyFence(ctx.env, { keyId: held.enc_key_id, workspaceId }) : plaintextFence(ctx.env)] }, size, sha256: sha2, mime: u.mime, revId, change_note: u.change_note ?? void 0, fence: { sql: fenced, params: [uploadId, token] } },
        [db2(ctx).prepare(`UPDATE uploads SET state = 'published', final_revision_id = ?, result = ?, finalize_token = NULL, finalize_until = NULL WHERE id = ? AND state = 'sealed' AND finalize_token = ? AND ${gate}`).bind(revId, JSON.stringify({ status: 200, body: ok2 }), uploadId, token, revId)],
        "upload.publish"
      );
    } catch (e) {
      // The fenced insert also fails when the lease was lost; only the current finisher may record a conflict.
      const row = await current();
      if (!row || row.state !== "sealed" || row.finalize_token !== token) return await lostAfterWrite();
      // A fence refusal (410 key_shredded, 409 encryption_started) BEFORE the conflict branch: nothing was published
      // (runBatch already returned any stored answer instead), so the upload ends failed, never conflict, and its object
      // is reclaimed. A retry is a new upload.
      const refusal = fenceRefusal(e);
      if (refusal) {
        if (!await end(refusal.status, refusal.code, refusal.message, "failed")) return await lost();
        await dropUnpublished(ctx.env, uploadId, finalKey);
        await purgeStaging(ctx.env, u);
        throw refusal;
      }
      if (e instanceof HttpError && (e.status === 409 || e.code === "protected_source")) {
        if (!await end(e.status, e.code, e.message, "conflict", e.extra)) return await lost();
        await dropUnpublished(ctx.env, uploadId, finalKey);
        await purgeStaging(ctx.env, u);
        throw new HttpError(e.status, e.code, e.message, e.extra);
      }
      throw e;
    }
    // Published (or replayed). Slot release, cleanup and the search defer are outside the publish try.
    releaseTextFinishSlot();
    if (!res.body?.idempotent_replay) {
      if (committedRevId !== null && searchFlat !== null)
        deferSearchIndexing(ctx.env, [{ artifactId: u.artifact_id, projectId, revisionId: committedRevId, flat: searchFlat, textUnits: searchUnits, textBytes: size, ticket: searchTicket }]);
      if (kind) await dropUnpublished(ctx.env, uploadId, finalKey).catch(() => {});
      await purgeStaging(ctx.env, u);
      return { status: 200, body: ok2 };
    }
    return res;
  } finally {
    // Releases an unconsumed reservation and drops terms no admitted job holds (idempotent; never throws).
    releaseUploadTerms(ctx.env, searchTicket, searchFlat);
    searchTicket = searchFlat = null;
    // Unexpected errors release the lease at once so a retry can take over; a no-op once it was cleared or taken.
    try {
      await db2(ctx).prepare("UPDATE uploads SET finalize_token = NULL, finalize_until = NULL WHERE id = ? AND finalize_token = ?").bind(uploadId, token).run().catch(() => {
      });
    } finally {
      releaseTextFinishSlot();
    }
  }
}
async function serveContent(ctx, req, projectId, artifactId, revParam) {
  await authorizeProject(ctx, projectId, false);
  const a = await loadArtifact(ctx, projectId, artifactId);
  const revNo = revParam ? int(Number(revParam), "rev", 1) : a.head_rev;
  const r = await db2(ctx).prepare("SELECT * FROM revisions WHERE artifact_id = ? AND project_id = ? AND rev_no = ?").bind(artifactId, projectId, revNo).first();
  if (!r) throw new HttpError(404, "not_found", "Revision not found");
  const sp = new URL(req.url).searchParams;
  if (sp.get("format") === "spreadsheet" && ctx.env.APP_CONNECT_ENABLED === "1") {
    if (r.mime !== "text/csv") throw new HttpError(400, "invalid_input", "format=spreadsheet applies to CSV files only");
    const safe = spreadsheetSafeCsv(await getText(ctx.env, r), { headOnly: req.method === "HEAD" });
    const nm = (a.title.replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 100) || "download").replace(/\.csv$/i, "") + ".spreadsheet.csv";
    return new Response(req.method === "HEAD" ? null : safe, { status: 200, headers: {
      "content-type": CONTENT_TYPE["text/csv"],
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'; sandbox",
      "cross-origin-resource-policy": "same-origin",
      "content-disposition": `attachment; filename="${nm}"`,
      "content-length": String(safe.length)
    } });
  }
  const forceDownload = sp.get("download") === "1";
  const openPdf = r.mime === "application/pdf" && sp.get("open") === "1";
  const inline2 = !forceDownload && (openPdf || IMAGE_TYPES.includes(r.mime) || VIDEO_TYPES.includes(r.mime) || r.mime === "text/markdown");
  const ext = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "application/pdf": ".pdf",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "text/markdown": ".md",
    "text/html": ".html",
    "application/json": ".json",
    "text/csv": ".csv"
  };
  let safeName = a.title.replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 100) || "download";
  if (ext[r.mime] && !safeName.toLowerCase().endsWith(ext[r.mime])) safeName += ext[r.mime];
  const headers = {
    // JSON/CSV: data, never rendered by the browser (always attachment, sandbox CSP, nosniff).
    "content-type": CONTENT_TYPE[r.mime] ?? r.mime,
    "x-content-type-options": "nosniff",
    "cache-control": "private, no-store",
    "content-security-policy": "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'; sandbox",
    "cross-origin-resource-policy": "same-origin",
    etag: `"${r.sha256}"`,
    "accept-ranges": "bytes",
    "content-disposition": `${inline2 ? "inline" : "attachment"}; filename="${safeName}"`
  };
  const total = r.size;
  const range = req.headers.get("range");
  let start = 0, end = total - 1, partial = false;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || m[1] === "" && m[2] === "") return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${total}` } });
    if (m[1] === "") {
      const n = Number(m[2]);
      start = Math.max(0, total - n);
    } else {
      start = Number(m[1]);
      if (m[2] !== "") end = Math.min(Number(m[2]), total - 1);
    }
    if (start >= total || start > end) return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${total}` } });
    partial = true;
    headers["content-range"] = `bytes ${start}-${end}/${total}`;
  }
  headers["content-length"] = String(end - start + 1);
  const status = partial ? 206 : 200;
  if (req.method === "HEAD") return new Response(null, { status, headers });
  if (r.blob_key === null) {
    const b = await getTextRange(ctx.env, r, start, end - start + 1);
    return new Response(b, { status, headers });
  }
  // One R2 request; an encrypted version's first chunk is authenticated before the headers go out, and a later
  // failure errors the body (docs/encryption.md#rules-for-code-that-uses-this).
  const body = await readBlob(ctx.env, await blobRef(ctx.env, r, { projectId, artifactId }), partial ? { start, end } : null);
  return new Response(body, { status, headers });
}

export { TEXT_UPLOAD_KINDS, UPLOAD_BEGIN_DESCRIPTION, UPLOAD_FINISH_DESCRIPTION, quotaUsedSql, serveContent, uploadBegin, uploadBeginFields, uploadFinish, uploadPut };
