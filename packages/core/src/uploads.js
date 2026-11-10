import { blobSha256Hex, deleteBlob, getBlob, getBlobHead, headBlob, putBlobStream, readText } from "./content-store.js";
import { authenticate, authorizeProject, authzSql, enforceRate, limitsFor, requireCsrf } from "./auth.js";
import { PUT_MARGIN_MS, reconcileUploads } from "./cleanup.js";
import { CONTENT_TYPE, spreadsheetSafeCsv } from "./formats.js";
import { __name } from "./runtime.js";
import { explainLimit, fileTooLarge, guardSql, projectLimitGuard } from "./limits.js";
import { BINARY_TYPES, IMAGE_TYPES, VIDEO_TYPES, assertWritable, audit, idemLookup, loadArtifact, publishRevision } from "./service.js";
import { HttpError, int, nowIso, nowMs, randomId, sha256Hex, str } from "./util.js";

var db2 = /* @__PURE__ */ __name((ctx) => ctx.env.DB, "db");
// Bytes charged to a project: published revisions, live reservations, and each ended (or expired) upload once while
// any object it may have written is not yet deleted: its staging_key (written only by an older Worker, which a rollback
// can bring back, so an unpurged one counts) or its final_key. One SUM with an OR, so a row is never charged twice.
var quotaUsedSql = (now) => `(SELECT COALESCE(SUM(size),0) FROM revisions WHERE project_id = ?1 AND blob_key IS NOT NULL)
  + (SELECT COALESCE(SUM(expected_size),0) FROM uploads WHERE project_id = ?1
       AND (state IN ('receiving','sealed') OR (state IN ('pending','received') AND expires_at > ${Math.trunc(now)})))
  + (SELECT COALESCE(SUM(expected_size),0) FROM uploads WHERE project_id = ?1
       AND (state IN ('failed','conflict') OR (state IN ('pending','received') AND expires_at <= ${Math.trunc(now)}))
       AND (staging_purged_at IS NULL OR (final_key IS NOT NULL AND final_purged_at IS NULL)))`;
async function purgeStaging(env, u) {
  try {
    await deleteBlob(env, u.staging_key);
    await env.DB.prepare("UPDATE uploads SET staging_purged_at = ? WHERE id = ? AND staging_purged_at IS NULL").bind(nowMs(), u.id).run();
  } catch {
  }
}
// An object this upload wrote that no revision references. Deleted only when the upload is terminal (so no new write
// can start) and no write is in flight (so none can re-create it afterwards); otherwise cleanup purges it once the last
// write settles. Absent is harmless (R2 delete of a missing key is a no-op).
async function dropUnpublished(env, uploadId, finalKey) {
  const idle = await env.DB.prepare("SELECT 1 AS x FROM uploads u WHERE id = ? AND state IN ('failed','conflict') AND final_writes = 0 AND final_purged_at IS NULL AND NOT EXISTS (SELECT 1 FROM revisions r WHERE r.blob_key = u.final_key)").bind(uploadId).first("x");
  if (!idle) return;
  await deleteBlob(env, finalKey);
  await env.DB.prepare("UPDATE uploads SET final_purged_at = ? WHERE id = ? AND final_purged_at IS NULL").bind(nowMs(), uploadId).run();
}
// The immutable R2 key of an upload's bytes, which the revision publishing them references.
var finalKeyFor = (projectId, artifactId) => `blobs/${projectId}/${artifactId}/${randomId("rev")}`;
async function uploadBegin(ctx, projectId, input, key) {
  await authorizeProject(ctx, projectId, true);
  const mime = str(input.mime, "mime", 100);
  if (!BINARY_TYPES[mime]) throw new HttpError(415, "unsupported_type", "Allowed: " + Object.keys(BINARY_TYPES).join(", "));
  const size = int(input.size, "size", 1, Number.MAX_SAFE_INTEGER);
  // Workspace limits (limits.js): file size, storage (the reservation counts as used until it publishes or is
  // released) and, for a new file, its placeholder document counts toward the project's items.
  const adds = input.artifact_id ? { storage_bytes: size } : { storage_bytes: size, items_per_project: 1 };
  const lg = await projectLimitGuard(ctx.env, projectId, adds);
  if (size > lg.limits.file_bytes) throw fileTooLarge(lg.limits.file_bytes);
  const sha2 = str(input.sha256, "sha256", 64);
  if (!/^[0-9a-f]{64}$/.test(sha2)) throw new HttpError(400, "invalid_input", "sha256 must be 64 lowercase hex chars");
  const i = { op: "upload.begin", key, projectId, digest: await sha256Hex(JSON.stringify([mime, size, sha2, input.artifact_id ?? null, input.expected_revision ?? null, input.title ?? null])) };
  const prior = await idemLookup(ctx, i);
  if (prior) return prior;
  await reconcileUploads(ctx.env, { projectId, limit: 20 });
  const limits = limitsFor(ctx.env);
  let artifactId;
  let baseRev;
  const stmts = [];
  const az = authzSql(ctx, projectId);
  if (input.artifact_id) {
    artifactId = str(input.artifact_id, "artifact_id", 64);
    const a = await loadArtifact(ctx, projectId, artifactId);
    assertWritable(ctx, a, "content");
    if (a.kind !== "binary") throw new HttpError(400, "invalid_input", "Not a binary artifact");
    baseRev = int(input.expected_revision, "expected_revision", 1);
  } else {
    const title = str(input.title, "title", 200, { min: 1 });
    artifactId = randomId("art");
    baseRev = 0;
    stmts.push(db2(ctx).prepare(`INSERT INTO artifacts (id, project_id, kind, title, folder, head_rev, created_at, updated_at)
      SELECT ?, ?, 'binary', ?, ?, 0, ?, ? WHERE ${az.sql} AND ${lg.sql}`).bind(artifactId, projectId, title, str(input.folder, "folder", 200, { optional: true }), nowIso(), nowIso(), ...az.params, ...lg.params));
  }
  const uploadId = randomId("upl", 18);
  const expires = nowMs() + limits.uploadTtlMs;
  const body2 = {
    upload_id: uploadId,
    artifact_id: artifactId,
    base_revision: baseRev,
    put_url: `/api/transfers/${uploadId}`,
    method: "PUT",
    expires_at: new Date(expires).toISOString(),
    instructions: "PUT the raw file bytes to put_url with the same Authorization, then call upload_finish."
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
    db2(ctx).prepare(`INSERT INTO uploads (id, project_id, artifact_id, principal_id, base_rev, expected_size, expected_sha256, mime, state, staging_key, final_key, expires_at, created_at)
      SELECT ?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', ?9, ?13, ?10, ?11
      WHERE (?12 = 0 OR ${quotaUsedSql(nowMs())} + ?6 <= ?12) AND EXISTS (SELECT 1 FROM artifacts WHERE id = ?3 AND project_id = ?1)
        AND ${az.sql} AND ${sg.sql}`).bind(projectId, uploadId, artifactId, ctx.principal.id, baseRev, size, sha2, mime, `staging/${projectId}/${uploadId}`, expires, nowIso(), limits.projectBinaryBytes, finalKeyFor(projectId, artifactId), ...az.params, ...sg.params),
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
    if (limits.projectBinaryBytes > 0 && (used ?? 0) + size > limits.projectBinaryBytes)
      throw new HttpError(413, "quota_exceeded", "Project binary storage quota exceeded", { used_bytes: used, limit_bytes: limits.projectBinaryBytes });
    if (lg.workspaceId) await explainLimit(ctx.env, lg.workspaceId, adds, lg.limits, projectId);
    throw new HttpError(403, "forbidden", "Grant no longer valid");
  }
  return { status: 201, body: body2 };
}
async function uploadPut(req, env, requestId, uploadId, linkCtx) {
  // linkCtx: built by handleFileTransfer from a live OAuth connection (no cookie, so no CSRF).
  const ctx = linkCtx ?? await authenticate(req, env, requestId);
  if (!linkCtx) requireCsrf(ctx, req);
  await enforceRate(ctx, true);
  const u = await env.DB.prepare("SELECT * FROM uploads WHERE id = ?").bind(uploadId).first();
  if (!u || u.principal_id !== ctx.principal.id) throw new HttpError(404, "not_found", "Upload not found");
  await authorizeProject(ctx, u.project_id, true);
  if (u.expires_at <= nowMs()) throw new HttpError(410, "upload_expired", "Upload expired");
  // R2 checks the stored length against the declared size anyway: refuse any other Content-Length before writing.
  const cl = req.headers.get("content-length");
  if (cl !== null && !/^\d+$/.test(cl)) throw new HttpError(400, "invalid_input", "Content-Length must be a non-negative integer");
  const declared = cl === null ? NaN : Number(cl);
  if (Number.isFinite(declared) && declared > u.expected_size) throw new HttpError(413, "too_large", "Body exceeds declared size");
  if (Number.isFinite(declared) && declared < u.expected_size) throw new HttpError(400, "incomplete_body", "Content-Length is smaller than the declared size; PUT the whole file");
  if (!req.body) throw new HttpError(400, "invalid_input", "Missing body");
  const az = authzSql(ctx, u.project_id);
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
    let stored, bodyCtl, abortTimer, marginTimer, timedOut = false, abandoned = false;
    const body = req.body.pipeThrough(new TransformStream({
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
      const put = putBlobStream(env, finalKey, body, u.expected_size, { sha256: u.expected_sha256, httpMetadata: { contentType: u.mime } });
      // An abandoned put may still reject later; never let that surface as an unhandled rejection (it carries R2's message).
      put.catch(() => {
      });
      stored = await Promise.race([put, margin]);
    } catch (e) {
      const m = String(e?.message ?? e);
      // A digest rejection is a real answer even if a timer fired meanwhile: report it (and end the upload) as 422.
      if (!abandoned && /SHA-256 checksum you specified did not match|10037/.test(m)) throw new HttpError(422, "integrity_mismatch", "The body's SHA-256 does not match the declared sha256; this upload has ended, start a new one with upload_begin");
      if (timedOut) throw expired();
      if (/too many bytes/i.test(m)) throw new HttpError(413, "too_large", "Body exceeds declared size");
      if (/did not see all expected bytes/i.test(m)) throw new HttpError(400, "incomplete_body", "Body ended before the declared size; PUT the whole file again");
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
    const n = stored?.size ?? null;
    const sha2 = blobSha256Hex(stored);
    // Re-checks the grant (same as the claim): access revoked mid-transfer leaves the upload unreceived.
    const rec = await env.DB.prepare(`UPDATE uploads SET state = 'received', received_size = ?, received_sha256 = ? WHERE id = ? AND state = 'receiving' AND ${az.sql}`).bind(n, sha2, uploadId, ...az.params).run();
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
    // The declared SHA-256 can't match on any retry of these bytes: end the upload so finish replays the 422 and a new
    // upload_begin can start. Nothing was stored, so the slot and quota are freed at once. 400 and 413 stay retryable.
    if (e instanceof HttpError && e.code === "integrity_mismatch") {
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
//    verifying length and SHA-256. Finish writes nothing: it checks R2's recorded size and checksum and the first
//    bytes' type signature, then publishes that object. Every attempt and takeover publishes the same object.
//  - Every final-object write is counted in uploads.final_writes (taken in the PUT's claim, released when the put
//    settles). Cleanup purges a failed upload's final object only once no write is in flight; a failed upload can
//    start no new write, so nothing re-creates the object afterwards. A Worker that dies mid-put leaves the count
//    raised: the object stays tracked and counted against quota until the count is stale (cleanup.js PUT_MARGIN_MS).
//  - A finisher that lost its lease never deletes or publishes; it replays the upload's recorded outcome, or answers
//    409 finish_in_progress while another finisher still holds the lease.
var FINALIZE_LEASE_MS = 60 * 1e3;
var FINALIZE_WAIT_MS = 3e3;
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
  const current = () => db2(ctx).prepare("SELECT state, result, final_key, finalize_token, finalize_until FROM uploads WHERE id = ?").bind(uploadId).first();
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
  try {
    const held = await current();
    const finalKey = held?.final_key;
    const prefix = `blobs/${projectId}/${u.artifact_id}/`;
    if (held?.finalize_token !== token || typeof finalKey !== "string" || !finalKey.startsWith(prefix) || !/^rev_[A-Za-z0-9_-]+$/.test(finalKey.slice(prefix.length)))
      throw new HttpError(500, "publish_failed", "Upload finalization state is inconsistent");
    const revId = finalKey.slice(prefix.length);
    // Ends the upload with an error, only while this finisher still holds the lease.
    const end = async (status, code, message, state, extra) => {
      const r = await db2(ctx).prepare("UPDATE uploads SET state = ?, result = ?, finalize_token = NULL, finalize_until = NULL WHERE id = ? AND state = 'sealed' AND finalize_token = ?").bind(state, JSON.stringify({ status, code, message, extra }), uploadId, token).run();
      if (!r.meta.changes) return false;
      await audit(ctx, projectId, "upload.finish", u.artifact_id, null, "failed:" + code).run();
      return true;
    };
    const fail = async (status, code, message, state, extra) => {
      if (!await end(status, code, message, state, extra)) return lost();
      await dropUnpublished(ctx.env, uploadId, finalKey);
      await purgeStaging(ctx.env, u);
      throw new HttpError(status, code, message, extra);
    };
    // Lost the lease before publishing: if cleanup ended the upload, remove the unreferenced object now (cleanup would
    // too). A takeover finisher (upload still sealed) publishes the same object.
    const lostAfterWrite = async () => {
      const row = await current();
      if (row && (row.state === "failed" || row.state === "conflict")) await dropUnpublished(ctx.env, uploadId, finalKey);
      return lost();
    };
    // No write and no whole-object read: the upload's PUT already stored the bytes at final_key, and R2 checked their
    // length and the declared SHA-256 on the way in. Confirm what R2 recorded (fail closed without a checksum), then
    // check the type signature on the first bytes (BINARY_TYPES checks need at most 13).
    const stored = await headBlob(ctx.env, finalKey);
    if (!stored) return fail(409, "missing_bytes", "Uploaded bytes missing", "failed");
    const size = stored.size;
    const sha2 = blobSha256Hex(stored);
    if (sha2 === null) return fail(500, "publish_failed", "Stored object has no SHA-256 checksum", "failed");
    if (size !== u.expected_size || sha2 !== u.expected_sha256)
      return fail(422, "integrity_mismatch", "Byte length or SHA-256 does not match declaration", "failed", { received_size: size, received_sha256: sha2 });
    const head = await getBlobHead(ctx.env, finalKey, 16);
    if (!head) return fail(409, "missing_bytes", "Uploaded bytes missing", "failed");
    if (!BINARY_TYPES[u.mime](head)) return fail(415, "signature_mismatch", `Bytes are not a valid ${u.mime}`, "failed");
    // Still the finisher? Renew the lease for the publication.
    const renew = await db2(ctx).prepare("UPDATE uploads SET finalize_until = ? WHERE id = ? AND state = 'sealed' AND finalize_token = ?").bind(nowMs() + FINALIZE_LEASE_MS, uploadId, token).run();
    if (!renew.meta.changes) return lostAfterWrite();
    const ok2 = { artifact_id: u.artifact_id, revision: u.base_rev + 1, revision_id: revId, sha256: sha2, size };
    const gate = "EXISTS (SELECT 1 FROM revisions WHERE id = ?)";
    try {
      const res = await publishRevision(
        ctx,
        projectId,
        u.artifact_id,
        u.base_rev,
        i,
        // change_note: recorded at upload_begin by OAuth connections (migration 0013); undefined on older schemas.
        { blobKey: finalKey, size, sha256: sha2, mime: u.mime, revId, change_note: u.change_note ?? void 0, fence: { sql: fenced, params: [uploadId, token] } },
        [db2(ctx).prepare(`UPDATE uploads SET state = 'published', final_revision_id = ?, result = ?, finalize_token = NULL, finalize_until = NULL WHERE id = ? AND state = 'sealed' AND finalize_token = ? AND ${gate}`).bind(revId, JSON.stringify({ status: 200, body: ok2 }), uploadId, token, revId)],
        "upload.publish"
      );
      if (!res.body?.idempotent_replay) {
        await purgeStaging(ctx.env, u);
        return { status: 200, body: ok2 };
      }
      return res;
    } catch (e) {
      // The fenced insert also fails when the lease was lost; only the current finisher may record a conflict.
      const row = await current();
      if (!row || row.state !== "sealed" || row.finalize_token !== token) return lostAfterWrite();
      if (e instanceof HttpError && (e.status === 409 || e.code === "protected_source")) {
        if (!await end(e.status, e.code, e.message, "conflict", e.extra)) return lost();
        await dropUnpublished(ctx.env, uploadId, finalKey);
        await purgeStaging(ctx.env, u);
        throw new HttpError(e.status, e.code, e.message, e.extra);
      }
      throw e;
    }
  } finally {
    // Unexpected errors release the lease at once so a retry can take over; a no-op once it was cleared or taken.
    await db2(ctx).prepare("UPDATE uploads SET finalize_token = NULL, finalize_until = NULL WHERE id = ? AND finalize_token = ?").bind(uploadId, token).run().catch(() => {
    });
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
    const safe = new TextEncoder().encode(spreadsheetSafeCsv(readText(r.body)));
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
    const b = new TextEncoder().encode(readText(r.body)).slice(start, end + 1);
    return new Response(b, { status, headers });
  }
  const obj2 = await getBlob(ctx.env, r.blob_key, partial ? { offset: start, length: end - start + 1 } : void 0);
  if (!obj2) throw new HttpError(500, "blob_missing", "Stored bytes missing");
  return new Response(obj2.body, { status, headers });
}

export { quotaUsedSql, serveContent, uploadBegin, uploadFinish, uploadPut };
