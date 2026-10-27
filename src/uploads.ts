// Real byte transfer. begin -> authenticated PUT of bytes -> finish.
// Staging keys are only writable through the authenticated transfer route while state='pending';
// finish atomically seals the upload first (no further PUT can land), verifies staged bytes, then
// copies to a separate server-controlled immutable final key and publishes a guarded revision.
import { authenticate, authorizeProject, authzSql, enforceRate, limitsFor, requireCsrf, type Ctx, type Env } from "./auth";
import { CONTENT_TYPE, spreadsheetSafeCsv } from "./formats";
import { BINARY_TYPES, LIMITS, assertWritable, audit, idemLookup, loadArtifact, publishRevision, type Idem } from "./service";
import { reconcileUploads } from "./cleanup";
import { HttpError, int, nowIso, nowMs, randomId, sha256Hex, str } from "./util";

const db = (ctx: Ctx) => ctx.env.DB;

/**
 * Bytes charged to a project: published binary revisions (immutable history included) + reservations of
 * active uploads + staged bytes of failed/conflicted uploads not yet cleaned up (their staging objects
 * still occupy storage). Used as an SQL predicate inside the reservation insert so it is evaluated
 * atomically with the insert.
 */
// Expired, never-finished reservations stop counting immediately (sealed uploads are being finished and
// still count); bytes actually staged by them keep counting until cleanup removes the staging object.
// Charged bytes = published revisions + live reservations + every R2 object an unfinished/failed upload may
// still own (staging until staging_purged_at, unreferenced final copy until final_purged_at). An object
// stops counting only after its delete is confirmed, so nothing in R2 is ever uncounted.
const quotaUsedSql = (now: number) => `(SELECT COALESCE(SUM(size),0) FROM revisions WHERE project_id = ?1 AND blob_key IS NOT NULL)
  + (SELECT COALESCE(SUM(expected_size),0) FROM uploads WHERE project_id = ?1
       AND (state IN ('receiving','sealed') OR (state IN ('pending','received') AND expires_at > ${Math.trunc(now)})))
  + (SELECT COALESCE(SUM(expected_size),0) FROM uploads WHERE project_id = ?1 AND staging_purged_at IS NULL
       AND (state IN ('failed','conflict') OR (state IN ('pending','received') AND expires_at <= ${Math.trunc(now)})))
  + (SELECT COALESCE(SUM(expected_size),0) FROM uploads WHERE project_id = ?1 AND final_key IS NOT NULL AND final_purged_at IS NULL
       AND state IN ('failed','conflict'))`;

/** Best-effort immediate delete of an upload's staging object; the reconciler retries if this fails. */
async function purgeStaging(env: Env, u: { id: string; staging_key: string }) {
  try {
    await env.BLOBS.delete(u.staging_key);
    await env.DB.prepare("UPDATE uploads SET staging_purged_at = ? WHERE id = ? AND staging_purged_at IS NULL").bind(nowMs(), u.id).run();
  } catch { /* left for reconcileUploads */ }
}

export async function uploadBegin(ctx: Ctx, projectId: string, input: any, key: string) {
  await authorizeProject(ctx, projectId, true);
  const mime = str(input.mime, "mime", 100);
  if (!BINARY_TYPES[mime]) throw new HttpError(415, "unsupported_type", "Allowed: image/png, application/pdf, video/mp4, application/octet-stream");
  const size = int(input.size, "size", 1, Number.MAX_SAFE_INTEGER);
  if (size > LIMITS.binaryBytes) throw new HttpError(413, "too_large", `Binary exceeds ${LIMITS.binaryBytes} bytes`);
  const sha = str(input.sha256, "sha256", 64);
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new HttpError(400, "invalid_input", "sha256 must be 64 lowercase hex chars");
  const i: Idem = { op: "upload.begin", key, projectId, digest: await sha256Hex(JSON.stringify([mime, size, sha, input.artifact_id ?? null, input.expected_revision ?? null, input.title ?? null])) };
  const prior = await idemLookup(ctx, i);
  if (prior) return prior;

  // Reconcile this project's abandoned uploads first: expires them and deletes their R2 objects, so the
  // identity's slot and the project's quota are released only once the bytes are actually gone.
  await reconcileUploads(ctx.env, { projectId, limit: 20 });
  const limits = limitsFor(ctx.env);

  let artifactId: string;
  let baseRev: number;
  const stmts: D1PreparedStatement[] = [];
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
    // head_rev = 0 artifacts are invisible until the first version publishes.
    stmts.push(db(ctx).prepare(`INSERT INTO artifacts (id, project_id, kind, title, folder, head_rev, created_at, updated_at)
      SELECT ?, ?, 'binary', ?, ?, 0, ?, ? WHERE ${az.sql}`)
      .bind(artifactId, projectId, title, str(input.folder, "folder", 200, { optional: true }), nowIso(), nowIso(), ...az.params));
  }
  const uploadId = randomId("upl", 18);
  const expires = nowMs() + limits.uploadTtlMs;
  const body = {
    upload_id: uploadId, artifact_id: artifactId, base_revision: baseRev,
    put_url: `/api/transfers/${uploadId}`, method: "PUT", expires_at: new Date(expires).toISOString(),
    instructions: "PUT the raw file bytes to put_url with the same Authorization, then call upload_finish.",
  };
  const gate = "EXISTS (SELECT 1 FROM uploads WHERE id = ?)";
  stmts.push(
    // Reservation: inserted only if the project quota still has room, evaluated in the same statement.
    // The partial unique index uploads_one_active rejects a second concurrent active upload outright.
    db(ctx).prepare(`INSERT INTO uploads (id, project_id, artifact_id, principal_id, base_rev, expected_size, expected_sha256, mime, state, staging_key, expires_at, created_at)
      SELECT ?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', ?9, ?10, ?11
      WHERE ${quotaUsedSql(nowMs())} + ?6 <= ?12 AND ${az.sql}`) /* plain ? in az.sql become ?13.. (SQLite numbering) */
      .bind(projectId, uploadId, artifactId, ctx.principal.id, baseRev, size, sha, mime, `staging/${projectId}/${uploadId}`, expires, nowIso(), limits.projectBinaryBytes, ...az.params),
    db(ctx).prepare(`INSERT INTO idempotency (principal_id, project_id, op, key, digest, status, response, created_at)
      SELECT ?, ?, ?, ?, ?, 201, ?, ? WHERE ${gate}`).bind(ctx.principal.id, projectId, i.op, i.key, i.digest, JSON.stringify(body), nowIso(), uploadId),
    audit(ctx, projectId, "upload.begin", artifactId, baseRev, "ok", gate, [uploadId]),
  );
  const res = await db(ctx).batch(stmts).catch(async (e) => {
    const p = await idemLookup(ctx, i);
    if (p) return p;
    if (/uploads\.principal_id|UNIQUE/i.test(String(e?.message ?? e)))
      throw new HttpError(429, "upload_in_progress", "One active upload per identity; finish or let it expire first");
    throw e;
  });
  if (!Array.isArray(res)) return res;
  const uploadRow = res[input.artifact_id ? 0 : 1];
  if (!uploadRow.meta.changes) {
    // Either quota is full or the grant was revoked. The batch already rolled nothing visible:
    // remove the invisible placeholder artifact if one was inserted.
    if (!input.artifact_id) await db(ctx).prepare("DELETE FROM artifacts WHERE id = ? AND head_rev = 0 AND NOT EXISTS (SELECT 1 FROM uploads WHERE artifact_id = ?)").bind(artifactId, artifactId).run();
    const used = await db(ctx).prepare(`SELECT ${quotaUsedSql(nowMs())} AS n`).bind(projectId).first<number>("n");
    if ((used ?? 0) + size > limits.projectBinaryBytes)
      throw new HttpError(413, "quota_exceeded", "Project binary storage quota exceeded", { used_bytes: used, limit_bytes: limits.projectBinaryBytes });
    throw new HttpError(403, "forbidden", "Grant no longer valid");
  }
  return { status: 201, body };
}

/** Authenticated byte transfer. Only the uploading principal, with a still-valid write grant, while state='pending'. */
export async function uploadPut(req: Request, env: Env, requestId: string, uploadId: string): Promise<Response> {
  const ctx = await authenticate(req, env, requestId);
  requireCsrf(ctx, req); // cookie-authenticated transfers need the CSRF header like any mutation
  await enforceRate(ctx, true);
  const u = await env.DB.prepare("SELECT * FROM uploads WHERE id = ?").bind(uploadId).first<any>();
  if (!u || u.principal_id !== ctx.principal.id) throw new HttpError(404, "not_found", "Upload not found");
  await authorizeProject(ctx, u.project_id, true);
  if (u.expires_at <= nowMs()) throw new HttpError(410, "upload_expired", "Upload expired");
  // Serialize: claim the transfer slot. A sealed/published upload can never be written again, and an
  // expired one cannot be claimed (checked atomically, not only above).
  const az = authzSql(ctx, u.project_id);
  const claim = await env.DB.prepare(`UPDATE uploads SET state = 'receiving' WHERE id = ? AND state = 'pending' AND expires_at > ? AND ${az.sql}`)
    .bind(uploadId, nowMs(), ...az.params).run();
  if (!claim.meta.changes) throw new HttpError(409, "upload_not_writable", "Upload is not accepting bytes (in progress, sealed or published)");
  try {
    const declared = Number(req.headers.get("content-length") ?? "NaN");
    if (Number.isFinite(declared) && declared > u.expected_size) throw new HttpError(413, "too_large", "Body exceeds declared size");
    if (!req.body) throw new HttpError(400, "invalid_input", "Missing body");
    // Bounded streaming read (prototype cap 5 MiB): abort as soon as we pass the declared size.
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > u.expected_size) { await reader.cancel(); throw new HttpError(413, "too_large", "Body exceeds declared size"); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(n);
    let off = 0;
    for (const c of chunks) { bytes.set(c, off); off += c.byteLength; }
    const sha = await sha256Hex(bytes);
    await env.BLOBS.put(u.staging_key, bytes, { httpMetadata: { contentType: "application/octet-stream" } });
    const rec = await env.DB.prepare("UPDATE uploads SET state = 'received', received_size = ?, received_sha256 = ? WHERE id = ? AND state = 'receiving'")
      .bind(n, sha, uploadId).run();
    if (!rec.meta.changes) {
      // The reconciler expired this transfer while it streamed: the object is now owned by a failed upload.
      await purgeStaging(env, u);
      throw new HttpError(410, "upload_expired", "Upload expired during transfer");
    }
    await audit(ctx, u.project_id, "upload.put", u.artifact_id, null, "ok").run();
    return new Response(JSON.stringify({ upload_id: uploadId, received_bytes: n, sha256: sha, matches_declared: n === u.expected_size && sha === u.expected_sha256 }), {
      status: 200, headers: { "content-type": "application/json", "cache-control": "private, no-store" },
    });
  } catch (e) {
    // Interrupted/invalid transfer: return to pending so the client may retry; nothing is published.
    await env.DB.prepare("UPDATE uploads SET state = 'pending' WHERE id = ? AND state = 'receiving'").bind(uploadId).run();
    throw e;
  }
}

export async function uploadFinish(ctx: Ctx, projectId: string, uploadId: string, key: string) {
  await authorizeProject(ctx, projectId, true);
  const u = await db(ctx).prepare("SELECT * FROM uploads WHERE id = ? AND project_id = ?").bind(uploadId, projectId).first<any>();
  if (!u || u.principal_id !== ctx.principal.id) throw new HttpError(404, "not_found", "Upload not found");
  // Repeat-safe: a finished upload returns its recorded outcome regardless of key.
  if (u.state === "published" || u.state === "conflict" || u.state === "failed") {
    if (u.result) {
      const r = JSON.parse(u.result);
      if (r.status >= 400) throw new HttpError(r.status, r.code, r.message, r.extra);
      return { status: 200, body: { ...r.body, idempotent_replay: true } };
    }
  }
  const i: Idem = { op: "upload.finish:" + uploadId, key, projectId, digest: await sha256Hex(uploadId) };
  const prior = await idemLookup(ctx, i);
  if (prior) return prior;
  if (u.expires_at <= nowMs() && u.state !== "sealed") throw new HttpError(410, "upload_expired", "Upload expired");
  const az = authzSql(ctx, projectId);
  // Seal: from now on no PUT can write the staging key (claim requires state='pending').
  const seal = await db(ctx).prepare(`UPDATE uploads SET state = 'sealed' WHERE id = ? AND state = 'received' AND ${az.sql}`).bind(uploadId, ...az.params).run();
  if (!seal.meta.changes) {
    const cur = await db(ctx).prepare("SELECT state FROM uploads WHERE id = ?").bind(uploadId).first<string>("state");
    if (cur !== "sealed") throw new HttpError(409, "upload_not_ready", `Upload state is ${cur}; PUT the bytes first`);
  }
  const fail = async (status: number, code: string, message: string, state: string, extra?: Record<string, unknown>) => {
    await db(ctx).prepare("UPDATE uploads SET state = ?, result = ? WHERE id = ? AND state = 'sealed'")
      .bind(state, JSON.stringify({ status, code, message, extra }), uploadId).run();
    await audit(ctx, projectId, "upload.finish", u.artifact_id, null, "failed:" + code).run();
    await purgeStaging(ctx.env, u); // failed/conflicted bytes are never published; free them now
    throw new HttpError(status, code, message, extra);
  };
  const staged = await ctx.env.BLOBS.get(u.staging_key);
  if (!staged) return fail(409, "missing_bytes", "Staged bytes missing", "failed");
  const bytes = new Uint8Array(await staged.arrayBuffer());
  const sha = await sha256Hex(bytes);
  if (bytes.length !== u.expected_size || sha !== u.expected_sha256)
    return fail(422, "integrity_mismatch", "Byte length or SHA-256 does not match declaration", "failed", { received_size: bytes.length, received_sha256: sha });
  if (!BINARY_TYPES[u.mime](bytes)) return fail(415, "signature_mismatch", `Bytes are not a valid ${u.mime}`, "failed");

  // Server-controlled immutable final key; never reachable by any transfer route.
  const revId = randomId("rev");
  const finalKey = `blobs/${projectId}/${u.artifact_id}/${revId}`;
  // Record the key before writing it, so a crash after the put leaves a findable, still-charged object.
  await db(ctx).prepare("UPDATE uploads SET final_key = ? WHERE id = ? AND state = 'sealed'").bind(finalKey, uploadId).run();
  await ctx.env.BLOBS.put(finalKey, bytes, { httpMetadata: { contentType: u.mime }, sha256: sha });
  const check = await ctx.env.BLOBS.head(finalKey);
  if (!check || check.size !== bytes.length) return fail(500, "publish_failed", "Final object verification failed", "failed");

  const ok = { artifact_id: u.artifact_id, revision: u.base_rev + 1, revision_id: revId, sha256: sha, size: bytes.length };
  const gate = "EXISTS (SELECT 1 FROM revisions WHERE id = ?)";
  try {
    const res = await publishRevision(ctx, projectId, u.artifact_id, u.base_rev, i,
      { blobKey: finalKey, size: bytes.length, sha256: sha, mime: u.mime, revId },
      [db(ctx).prepare(`UPDATE uploads SET state = 'published', final_revision_id = ?, result = ? WHERE id = ? AND state = 'sealed' AND ${gate}`)
        .bind(revId, JSON.stringify({ status: 200, body: ok }), uploadId, revId)],
      "upload.publish");
    await purgeStaging(ctx.env, u);
    return res.body?.idempotent_replay ? res : { status: 200, body: ok };
  } catch (e) {
    if (e instanceof HttpError && (e.status === 409 || e.code === "protected_source")) {
      await ctx.env.BLOBS.delete(finalKey); // never referenced by a revision
      await db(ctx).prepare("UPDATE uploads SET final_purged_at = ? WHERE id = ?").bind(nowMs(), uploadId).run();
      return fail(e.status, e.code, e.message, "conflict", e.extra);
    }
    throw e; // grant revoked etc.: upload stays sealed, final object is unreferenced
  }
}

/** Authorized content delivery: re-checks grant/project/trash every request. Single-range support. */
export async function serveContent(ctx: Ctx, req: Request, projectId: string, artifactId: string, revParam: string | null): Promise<Response> {
  await authorizeProject(ctx, projectId, false);
  const a = await loadArtifact(ctx, projectId, artifactId);
  const revNo = revParam ? int(Number(revParam), "rev", 1) : a.head_rev;
  const r = await db(ctx).prepare("SELECT * FROM revisions WHERE artifact_id = ? AND project_id = ? AND rev_no = ?").bind(artifactId, projectId, revNo).first<any>();
  if (!r) throw new HttpError(404, "not_found", "Revision not found");
  // PDFs: download by default; "?open=1" serves the raw file inline so the browser's own PDF viewer shows
  // it in a top-level tab (owner decision 2026-10-02). The strict sandbox CSP stays on every response, so
  // nothing in a PDF can run with the app origin; the app never embeds PDFs (frame-ancestors is not loosened
  // and the UI opens them in a new tab only).
  const sp = new URL(req.url).searchParams;
  // CSV "format=spreadsheet": formula-neutralized copy for spreadsheet apps (never stored; canonical by default).
  if (sp.get("format") === "spreadsheet" && (ctx.env as any).APP_CONNECT_ENABLED === "1") {
    if (r.mime !== "text/csv") throw new HttpError(400, "invalid_input", "format=spreadsheet applies to CSV files only");
    const safe = new TextEncoder().encode(spreadsheetSafeCsv(r.body));
    const nm = (a.title.replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 100) || "download").replace(/\.csv$/i, "") + ".spreadsheet.csv";
    return new Response(req.method === "HEAD" ? null : safe, { status: 200, headers: {
      "content-type": CONTENT_TYPE["text/csv"], "x-content-type-options": "nosniff", "cache-control": "private, no-store",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'; sandbox", "cross-origin-resource-policy": "same-origin",
      "content-disposition": `attachment; filename="${nm}"`, "content-length": String(safe.length) } });
  }
  const forceDownload = sp.get("download") === "1";
  const openPdf = r.mime === "application/pdf" && sp.get("open") === "1";
  const inline = !forceDownload && (openPdf || r.mime === "image/png" || r.mime === "video/mp4" || r.mime === "text/markdown");
  const ext: Record<string, string> = { "image/png": ".png", "application/pdf": ".pdf", "video/mp4": ".mp4", "text/markdown": ".md", "application/json": ".json", "text/csv": ".csv" };
  let safeName = a.title.replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 100) || "download";
  if (ext[r.mime] && !safeName.toLowerCase().endsWith(ext[r.mime])) safeName += ext[r.mime];
  const headers: Record<string, string> = {
    // JSON/CSV: data, never rendered by the browser (always attachment, sandbox CSP, nosniff).
    "content-type": CONTENT_TYPE[r.mime] ?? r.mime,
    "x-content-type-options": "nosniff",
    "cache-control": "private, no-store",
    "content-security-policy": "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'; sandbox",
    "cross-origin-resource-policy": "same-origin",
    etag: `"${r.sha256}"`,
    "accept-ranges": "bytes",
    "content-disposition": `${inline ? "inline" : "attachment"}; filename="${safeName}"`,
  };
  const total = r.size;
  const range = req.headers.get("range");
  let start = 0, end = total - 1, partial = false;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (m[1] === "" && m[2] === "")) return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${total}` } });
    if (m[1] === "") { const n = Number(m[2]); start = Math.max(0, total - n); }
    else { start = Number(m[1]); if (m[2] !== "") end = Math.min(Number(m[2]), total - 1); }
    if (start >= total || start > end) return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${total}` } });
    partial = true;
    headers["content-range"] = `bytes ${start}-${end}/${total}`;
  }
  headers["content-length"] = String(end - start + 1);
  const status = partial ? 206 : 200;
  if (req.method === "HEAD") return new Response(null, { status, headers });
  if (r.blob_key === null) {
    const b = new TextEncoder().encode(r.body).slice(start, end + 1);
    return new Response(b, { status, headers });
  }
  const obj = await ctx.env.BLOBS.get(r.blob_key, partial ? { range: { offset: start, length: end - start + 1 } } : undefined);
  if (!obj) throw new HttpError(500, "blob_missing", "Stored bytes missing");
  return new Response(obj.body, { status, headers });
}
