import { deleteBlob, getBlob, headBlob, putBlob, readText } from "./content-store.js";
import { authenticate, authorizeProject, authzSql, enforceRate, limitsFor, requireCsrf } from "./auth.js";
import { reconcileUploads } from "./cleanup.js";
import { CONTENT_TYPE, spreadsheetSafeCsv } from "./formats.js";
import { __name } from "./runtime.js";
import { BINARY_TYPES, IMAGE_TYPES, LIMITS, VIDEO_TYPES, assertWritable, audit, idemLookup, loadArtifact, publishRevision } from "./service.js";
import { HttpError, int, nowIso, nowMs, randomId, sha256Hex, str } from "./util.js";

var db2 = /* @__PURE__ */ __name((ctx) => ctx.env.DB, "db");
var quotaUsedSql = (now) => `(SELECT COALESCE(SUM(size),0) FROM revisions WHERE project_id = ?1 AND blob_key IS NOT NULL)
  + (SELECT COALESCE(SUM(expected_size),0) FROM uploads WHERE project_id = ?1
       AND (state IN ('receiving','sealed') OR (state IN ('pending','received') AND expires_at > ${Math.trunc(now)})))
  + (SELECT COALESCE(SUM(expected_size),0) FROM uploads WHERE project_id = ?1 AND staging_purged_at IS NULL
       AND (state IN ('failed','conflict') OR (state IN ('pending','received') AND expires_at <= ${Math.trunc(now)})))
  + (SELECT COALESCE(SUM(expected_size),0) FROM uploads WHERE project_id = ?1 AND final_key IS NOT NULL AND final_purged_at IS NULL
       AND state IN ('failed','conflict'))`;
async function purgeStaging(env, u) {
  try {
    await deleteBlob(env, u.staging_key);
    await env.DB.prepare("UPDATE uploads SET staging_purged_at = ? WHERE id = ? AND staging_purged_at IS NULL").bind(nowMs(), u.id).run();
  } catch {
  }
}
async function uploadBegin(ctx, projectId, input, key) {
  await authorizeProject(ctx, projectId, true);
  const mime = str(input.mime, "mime", 100);
  if (!BINARY_TYPES[mime]) throw new HttpError(415, "unsupported_type", "Allowed: " + Object.keys(BINARY_TYPES).join(", "));
  const size = int(input.size, "size", 1, Number.MAX_SAFE_INTEGER);
  if (size > LIMITS.binaryBytes) throw new HttpError(413, "too_large", `Binary exceeds ${LIMITS.binaryBytes} bytes`);
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
      SELECT ?, ?, 'binary', ?, ?, 0, ?, ? WHERE ${az.sql}`).bind(artifactId, projectId, title, str(input.folder, "folder", 200, { optional: true }), nowIso(), nowIso(), ...az.params));
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
  stmts.push(
    // Reservation: inserted only if the project quota still has room, evaluated in the same statement.
    // The partial unique index uploads_one_active rejects a second concurrent active upload outright.
    db2(ctx).prepare(`INSERT INTO uploads (id, project_id, artifact_id, principal_id, base_rev, expected_size, expected_sha256, mime, state, staging_key, expires_at, created_at)
      SELECT ?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', ?9, ?10, ?11
      WHERE ${quotaUsedSql(nowMs())} + ?6 <= ?12 AND ${az.sql}`).bind(projectId, uploadId, artifactId, ctx.principal.id, baseRev, size, sha2, mime, `staging/${projectId}/${uploadId}`, expires, nowIso(), limits.projectBinaryBytes, ...az.params),
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
    if ((used ?? 0) + size > limits.projectBinaryBytes)
      throw new HttpError(413, "quota_exceeded", "Project binary storage quota exceeded", { used_bytes: used, limit_bytes: limits.projectBinaryBytes });
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
  const az = authzSql(ctx, u.project_id);
  const claim = await env.DB.prepare(`UPDATE uploads SET state = 'receiving' WHERE id = ? AND state = 'pending' AND expires_at > ? AND ${az.sql}`).bind(uploadId, nowMs(), ...az.params).run();
  if (!claim.meta.changes) throw new HttpError(409, "upload_not_writable", "Upload is not accepting bytes (in progress, sealed or published)");
  try {
    const declared = Number(req.headers.get("content-length") ?? "NaN");
    if (Number.isFinite(declared) && declared > u.expected_size) throw new HttpError(413, "too_large", "Body exceeds declared size");
    if (!req.body) throw new HttpError(400, "invalid_input", "Missing body");
    const reader = req.body.getReader();
    const chunks = [];
    let n = 0;
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > u.expected_size) {
        await reader.cancel();
        throw new HttpError(413, "too_large", "Body exceeds declared size");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(n);
    let off = 0;
    for (const c of chunks) {
      bytes.set(c, off);
      off += c.byteLength;
    }
    const sha2 = await sha256Hex(bytes);
    await putBlob(env, u.staging_key, bytes, { httpMetadata: { contentType: "application/octet-stream" } });
    const rec = await env.DB.prepare("UPDATE uploads SET state = 'received', received_size = ?, received_sha256 = ? WHERE id = ? AND state = 'receiving'").bind(n, sha2, uploadId).run();
    if (!rec.meta.changes) {
      await purgeStaging(env, u);
      throw new HttpError(410, "upload_expired", "Upload expired during transfer");
    }
    await audit(ctx, u.project_id, "upload.put", u.artifact_id, null, "ok").run();
    return new Response(JSON.stringify({ upload_id: uploadId, received_bytes: n, sha256: sha2, matches_declared: n === u.expected_size && sha2 === u.expected_sha256 }), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "private, no-store" }
    });
  } catch (e) {
    await env.DB.prepare("UPDATE uploads SET state = 'pending' WHERE id = ? AND state = 'receiving'").bind(uploadId).run();
    throw e;
  }
}
// Exclusive upload finalization (security review 2026-10-23, findings 1 and 3). Spliced over the hash-pinned
// uploadFinish of // src/uploads.ts by build-upload-fixes.mjs; needs migration 0011_upload_finalize_lease.sql.
//  - One finisher at a time holds an expiring lease (uploads.finalize_token/finalize_until). Cleanup never fails a
//    sealed upload while its lease is live, and the revision insert is fenced on "still sealed and still my token",
//    so cleanup can never delete bytes under a publication that then succeeds.
//  - The final R2 key is fixed per upload at the first lease (uploads.final_key, kept by COALESCE): every attempt
//    writes the same object with the same verified bytes, so a retry or takeover can never leave an untracked object.
//  - Every final-object write is counted in uploads.final_writes (taken only while holding the lease of a sealed upload,
//    released when the put settles). Cleanup purges a failed upload's final object only once no write is in flight;
//    a failed upload can start no new write, so nothing re-creates the object afterwards. A Worker that dies mid-put
//    leaves the count raised: the object then stays tracked and counted against quota instead of escaping both.
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
      WHERE id = ? AND state = 'sealed' AND (finalize_until IS NULL OR finalize_until <= ?) AND ${az.sql}`).bind(token, nowMs() + FINALIZE_LEASE_MS, `blobs/${projectId}/${u.artifact_id}/${randomId("rev")}`, uploadId, nowMs(), ...az.params).run();
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
      await purgeStaging(ctx.env, u);
      throw new HttpError(status, code, message, extra);
    };
    // An object this upload wrote that no revision references (cleanup may already have ended the upload).
    // Deleted only when the upload is terminal (so no new write can start) and no write is in flight (so none can
    // re-create it afterwards); otherwise cleanup purges it once the last write settles.
    const dropUnpublished = async () => {
      const idle = await db2(ctx).prepare("SELECT 1 AS x FROM uploads u WHERE id = ? AND state IN ('failed','conflict') AND final_writes = 0 AND final_purged_at IS NULL AND NOT EXISTS (SELECT 1 FROM revisions r WHERE r.blob_key = u.final_key)").bind(uploadId).first("x");
      if (!idle) return;
      await deleteBlob(ctx.env, finalKey);
      await db2(ctx).prepare("UPDATE uploads SET final_purged_at = ? WHERE id = ? AND final_purged_at IS NULL").bind(nowMs(), uploadId).run();
    };
    // Lost the lease after writing the final object: if cleanup ended the upload, its delete may have run before this
    // write re-created the object, so remove it again. A takeover finisher (upload still sealed) reuses the object.
    const lostAfterWrite = async () => {
      const row = await current();
      if (row && (row.state === "failed" || row.state === "conflict")) await dropUnpublished();
      return lost();
    };
    const staged = await getBlob(ctx.env, u.staging_key);
    if (!staged) return fail(409, "missing_bytes", "Staged bytes missing", "failed");
    const bytes = new Uint8Array(await staged.arrayBuffer());
    const sha2 = await sha256Hex(bytes);
    if (bytes.length !== u.expected_size || sha2 !== u.expected_sha256)
      return fail(422, "integrity_mismatch", "Byte length or SHA-256 does not match declaration", "failed", { received_size: bytes.length, received_sha256: sha2 });
    if (!BINARY_TYPES[u.mime](bytes)) return fail(415, "signature_mismatch", `Bytes are not a valid ${u.mime}`, "failed");
    // Register the write before it starts, only while still the finisher of a sealed upload.
    const begin = await db2(ctx).prepare("UPDATE uploads SET final_writes = final_writes + 1 WHERE id = ? AND state = 'sealed' AND finalize_token = ?").bind(uploadId, token).run();
    if (!begin.meta.changes) return lost();
    try {
      await putBlob(ctx.env, finalKey, bytes, { httpMetadata: { contentType: u.mime }, sha256: sha2 });
    } finally {
      // A release failure leaves accounting raised (fail closed). Log it without replacing the PUT's own error;
      // reconciliation also reports retained terminal uploads for operator recovery. Never log blob keys or errors.
      await db2(ctx).prepare("UPDATE uploads SET final_writes = final_writes - 1 WHERE id = ? AND final_writes > 0").bind(uploadId).run().catch(() => {
        console.warn(JSON.stringify({ event: "upload_final_write_release_failed" }));
      });
    }
    const check = await headBlob(ctx.env, finalKey);
    if (!check || check.size !== bytes.length) return fail(500, "publish_failed", "Final object verification failed", "failed");
    // Still the finisher after the write? Renew the lease for the publication.
    const renew = await db2(ctx).prepare("UPDATE uploads SET finalize_until = ? WHERE id = ? AND state = 'sealed' AND finalize_token = ?").bind(nowMs() + FINALIZE_LEASE_MS, uploadId, token).run();
    if (!renew.meta.changes) return lostAfterWrite();
    const ok2 = { artifact_id: u.artifact_id, revision: u.base_rev + 1, revision_id: revId, sha256: sha2, size: bytes.length };
    const gate = "EXISTS (SELECT 1 FROM revisions WHERE id = ?)";
    try {
      const res = await publishRevision(
        ctx,
        projectId,
        u.artifact_id,
        u.base_rev,
        i,
        // change_note: recorded at upload_begin by OAuth connections (migration 0013); undefined on older schemas.
        { blobKey: finalKey, size: bytes.length, sha256: sha2, mime: u.mime, revId, change_note: u.change_note ?? void 0, fence: { sql: fenced, params: [uploadId, token] } },
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
        await dropUnpublished();
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

export { serveContent, uploadBegin, uploadFinish, uploadPut };
