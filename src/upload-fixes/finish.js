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
  const recorded = /* @__PURE__ */ __name((row) => {
    if (!row || !row.result || !(row.state === "published" || row.state === "conflict" || row.state === "failed")) return null;
    const r = JSON.parse(row.result);
    if (r.status >= 400) throw new HttpError(r.status, r.code, r.message, r.extra);
    return { status: 200, body: { ...r.body, idempotent_replay: true } };
  }, "recorded");
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
  const current = /* @__PURE__ */ __name(() => db2(ctx).prepare("SELECT state, result, final_key, finalize_token, finalize_until FROM uploads WHERE id = ?").bind(uploadId).first(), "current");
  const busy = /* @__PURE__ */ __name((row) => new HttpError(409, "finish_in_progress", "Another finish of this upload is in progress; retry shortly", { retry_after_seconds: Math.max(1, Math.ceil(((row?.finalize_until ?? nowMs()) - nowMs()) / 1e3)) }), "busy");
  const pause = /* @__PURE__ */ __name(() => new Promise((r2) => setTimeout(r2, 250)), "pause");
  // Not (or no longer) the finisher: replay the recorded outcome, waiting briefly for the finisher that holds the lease.
  const lost = /* @__PURE__ */ __name(async () => {
    for (const deadline = nowMs() + FINALIZE_WAIT_MS; ; await pause()) {
      const row = await current();
      const r = recorded(row);
      if (r) return r;
      if (!row || row.state !== "sealed") throw new HttpError(409, "upload_not_ready", `Upload state is ${row?.state}`);
      if (nowMs() >= deadline || row.finalize_until === null || row.finalize_until <= nowMs()) throw busy(row);
    }
  }, "lost");
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
    const end = /* @__PURE__ */ __name(async (status, code, message, state, extra) => {
      const r = await db2(ctx).prepare("UPDATE uploads SET state = ?, result = ?, finalize_token = NULL, finalize_until = NULL WHERE id = ? AND state = 'sealed' AND finalize_token = ?").bind(state, JSON.stringify({ status, code, message, extra }), uploadId, token).run();
      if (!r.meta.changes) return false;
      await audit(ctx, projectId, "upload.finish", u.artifact_id, null, "failed:" + code).run();
      return true;
    }, "end");
    const fail = /* @__PURE__ */ __name(async (status, code, message, state, extra) => {
      if (!await end(status, code, message, state, extra)) return lost();
      await purgeStaging(ctx.env, u);
      throw new HttpError(status, code, message, extra);
    }, "fail");
    // An object this upload wrote that no revision references (cleanup may already have ended the upload).
    // Deleted only when the upload is terminal (so no new write can start) and no write is in flight (so none can
    // re-create it afterwards); otherwise cleanup purges it once the last write settles.
    const dropUnpublished = /* @__PURE__ */ __name(async () => {
      const idle = await db2(ctx).prepare("SELECT 1 AS x FROM uploads u WHERE id = ? AND state IN ('failed','conflict') AND final_writes = 0 AND final_purged_at IS NULL AND NOT EXISTS (SELECT 1 FROM revisions r WHERE r.blob_key = u.final_key)").bind(uploadId).first("x");
      if (!idle) return;
      await ctx.env.BLOBS.delete(finalKey);
      await db2(ctx).prepare("UPDATE uploads SET final_purged_at = ? WHERE id = ? AND final_purged_at IS NULL").bind(nowMs(), uploadId).run();
    }, "dropUnpublished");
    // Lost the lease after writing the final object: if cleanup ended the upload, its delete may have run before this
    // write re-created the object, so remove it again. A takeover finisher (upload still sealed) reuses the object.
    const lostAfterWrite = /* @__PURE__ */ __name(async () => {
      const row = await current();
      if (row && (row.state === "failed" || row.state === "conflict")) await dropUnpublished();
      return lost();
    }, "lostAfterWrite");
    const staged = await ctx.env.BLOBS.get(u.staging_key);
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
      await ctx.env.BLOBS.put(finalKey, bytes, { httpMetadata: { contentType: u.mime }, sha256: sha2 });
    } finally {
      // A release failure leaves accounting raised (fail closed). Log it without replacing the PUT's own error;
      // reconciliation also reports retained terminal uploads for operator recovery. Never log blob keys or errors.
      await db2(ctx).prepare("UPDATE uploads SET final_writes = final_writes - 1 WHERE id = ? AND final_writes > 0").bind(uploadId).run().catch(() => {
        console.warn(JSON.stringify({ event: "upload_final_write_release_failed" }));
      });
    }
    const check = await ctx.env.BLOBS.head(finalKey);
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
