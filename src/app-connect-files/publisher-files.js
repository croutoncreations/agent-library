// App Connect binary files: publishers upload images, PDFs, video and other files into their own destination, as
// new files or new versions of their own files. Spliced in by build-app-connect-files.mjs right before
// // src/api/publisher.ts and reached from the publisher router (docs/app-connect.md#binary-files). No migration.
//  - Same upload machinery as browser and MCP uploads (uploadBegin -> uploadPut -> uploadFinish): BINARY_TYPES and
//    signature checks, LIMITS.binaryBytes, the project binary quota, the exclusive finalize lease and R2 storage.
//    They run as the publisher's own principal, so "one active upload per identity" applies per publisher.
//  - A file is addressed by its stable name (export_name), like snapshot files. A new name creates a file in the
//    publisher's destination; an existing name needs expected_revision (revision_conflict if stale).
//  - Ownership: a new file's placeholder (head_rev 0, invisible to everyone) is claimed for the publisher right after
//    begin and re-checked before every PUT and finish, so bytes can only ever be published as this publisher's file.
//    Everyone else keeps the usual protected_source rules (owner, agents, API keys cannot write publisher files).
//  - Per-publisher quota (PUB_QUOTA: files and stored bytes) is checked at begin, next to the project binary quota.
var PF_UPLOADS = /^\/v1\/publisher\/uploads$/;
var PF_UPLOAD = /^\/v1\/publisher\/uploads\/(upl_[A-Za-z0-9_-]{1,64})(\/finish)?$/;
// A file name, optionally inside subfolders of the destination: "shot.png" or "2026/11/shot.png". Each segment is
// [A-Za-z0-9._-]{1,64} (no "." or ".." segments), at most 4 subfolder levels and 200 characters in all.
var PF_SEG = /^[A-Za-z0-9._-]{1,64}$/;
var PF_MAX_SUBDIRS = 4;
function pfNameOk(name) {
  if (typeof name !== "string" || name.length > 200) return false;
  const segs = name.split("/");
  return segs.length <= PF_MAX_SUBDIRS + 1 && segs.every((s) => PF_SEG.test(s) && s !== "." && s !== "..");
}
__name(pfNameOk, "pfNameOk");
// Subfolders of a nested name, created under the publisher's destination and marked as the publisher's.
// pfFolderCheck runs before the upload begins, so a name that can't fit (depth, path length) fails with nothing
// started; pfFolderFor then finds or creates the folders.
async function pfFolderCheck(env, p, name) {
  const segs = name.split("/").slice(0, -1);
  if (!segs.length) return null;
  const base = p.folder_id ? await env.DB.prepare("SELECT * FROM folders WHERE id = ? AND project_id = ?").bind(p.folder_id, p.project_id).first() : null;
  if (p.folder_id && !base) throw new HttpError(403, "scope_mismatch", "Publisher destination unavailable or changed");
  const full = (base ? fdPathOf(base) + "/" : "") + segs.join("/");
  if (full.length > FD_MAX_PATH) throw new HttpError(400, "invalid_input", `The folder path of ${name} would exceed ${FD_MAX_PATH} characters`, { name });
  if (full.split("/").length > FD_MAX_DEPTH) throw new HttpError(400, "invalid_input", `The folders of ${name} would be nested more than ${FD_MAX_DEPTH} levels deep`, { name });
  return { segs, base };
}
__name(pfFolderCheck, "pfFolderCheck");
async function pfFolderFor(p, ctx, plan) {
  if (!plan) return p.folder_id ?? null;
  return (await fdEnsure(ctx, p.project_id, plan.segs, { base: plan.base, publisherId: p.id })).id;
}
__name(pfFolderFor, "pfFolderFor");
var PF_BODY_MAX = 16 * 1024;
// An upload that is not finished for good. Expired-but-not-yet-reconciled uploads count as unfinished: uploadFinish
// can still seal one that passed its expiry check a moment earlier, so a placeholder is only released once every
// upload on it is terminal (failed/conflict; published ones have content and are never placeholders).
var PF_UNFINISHED = "state NOT IN ('failed','conflict','published')";
// An upload that may still publish (for quota counting of placeholders).
var PF_LIVE = (now) => `(state IN ('receiving','sealed') OR (state IN ('pending','received') AND expires_at > ${Math.trunc(now)}))`;
function pfContract(env) {
  return {
    version: "agentlib.publisher-files/1",
    mime_types: Object.keys(BINARY_TYPES),
    max_bytes: LIMITS.binaryBytes,
    upload_ttl_seconds: Math.floor(limitsFor(env).uploadTtlMs / 1e3),
    active_uploads_per_publisher: 1
  };
}
__name(pfContract, "pfContract");
function pfUnwrap(r) {
  return r && typeof r.status === "number" && "body" in r ? { status: r.status, body: r.body } : { status: 200, body: r };
}
__name(pfUnwrap, "pfUnwrap");
async function pfJsonBody(req) {
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/json");
  const declared = req.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= PF_BODY_MAX)) throw new HttpError(413, "too_large", "Request body too large");
  const text = await ftReadCapped(req, PF_BODY_MAX);
  if (text === null) throw new HttpError(413, "too_large", "Request body too large");
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw 0;
    return v;
  } catch {
    throw new HttpError(400, "invalid_json", "Body must be a JSON object");
  }
}
__name(pfJsonBody, "pfJsonBody");
// Writes need a destination that still exists. Like snapshot commits, a disabled app client stops new connections
// only; its live publishers keep writing (revoking the publisher stops them).
async function pfAssertWritable(env, p) {
  if (p.folder_id) {
    const f = await env.DB.prepare("SELECT 1 AS x FROM folders WHERE id = ? AND project_id = ?").bind(p.folder_id, p.project_id).first("x");
    if (!f) throw new HttpError(403, "scope_mismatch", "Publisher destination unavailable or changed");
  }
}
__name(pfAssertWritable, "pfAssertWritable");
// The upload must be this publisher's, and its artifact this publisher's file (never anyone else's).
async function pfOwnUpload(env, p, ctx, uploadId) {
  const u = await env.DB.prepare("SELECT u.artifact_id, a.publisher_id FROM uploads u JOIN artifacts a ON a.id = u.artifact_id AND a.project_id = u.project_id WHERE u.id = ? AND u.principal_id = ? AND u.project_id = ?").bind(uploadId, ctx.principal.id, p.project_id).first();
  if (!u || u.publisher_id !== p.id) throw new HttpError(404, "not_found", "Upload not found");
  return u;
}
__name(pfOwnUpload, "pfOwnUpload");
async function pfFailUpload(env, uploadId, code, message) {
  await env.DB.prepare("UPDATE uploads SET state = 'failed', result = ? WHERE id = ? AND state IN ('pending','received')").bind(JSON.stringify({ status: 409, code, message }), uploadId).run();
}
__name(pfFailUpload, "pfFailUpload");
function pfLinks(env, projectId, fileId) {
  const o = appOrigin(env.APP_HOST);
  return o ? { web_url: artifactWebUrl(o, projectId, fileId), preview_url: previewWebUrl(o, projectId, fileId) } : {};
}
__name(pfLinks, "pfLinks");
async function pfBegin(req, env, p, ctx, quota) {
  const key = idemKey(req.headers.get("idempotency-key"));
  const b = await pfJsonBody(req);
  const name = b.name;
  if (!pfNameOk(name)) throw new HttpError(400, "invalid_input", `name must be [A-Za-z0-9._-]{1,64}, optionally inside up to ${PF_MAX_SUBDIRS} subfolders ("2026/11/shot.png")`);
  if (name === "manifest.json" || /^g_.*\.manifest\.json$/.test(name)) throw new HttpError(400, "invalid_input", `${name} is reserved for the server`);
  if (b.expected_revision !== void 0 && (!Number.isSafeInteger(b.expected_revision) || b.expected_revision < 0)) throw new HttpError(400, "invalid_input", "expected_revision must be a non-negative integer");
  const note = provenance(ctx, b)[4];
  await pfAssertWritable(env, p);
  // Placeholders left by failed begins (never any content) keep names reserved and count against the file quota of
  // snapshots too; release this publisher's, like the invisible placeholder any abandoned upload leaves. Only once
  // every upload on one is terminal: an unfinished (even expired) upload keeps it until cleanup ends that upload.
  await env.DB.prepare(`UPDATE artifacts SET publisher_id = NULL, export_name = NULL WHERE publisher_id = ? AND head_rev = 0 AND kind = 'binary' AND generation_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM uploads WHERE artifact_id = artifacts.id AND ${PF_UNFINISHED})`).bind(p.id).run();
  // A retry of a begin that already succeeded replays it exactly (uploadBegin checks the request digest).
  const prior = await env.DB.prepare("SELECT response FROM idempotency WHERE principal_id = ? AND project_id = ? AND op = 'upload.begin' AND key = ?").bind(ctx.principal.id, p.project_id, key).first("response");
  const ex = await env.DB.prepare("SELECT id, kind, head_rev, trashed_at FROM artifacts WHERE publisher_id = ? AND export_name = ?").bind(p.id, name).first();
  let artifactId;
  if (prior) {
    const pr = JSON.parse(prior);
    artifactId = pr.base_revision === 0 ? void 0 : pr.artifact_id;
    // A replay must name the same file (the upload digest does not include the name for existing files).
    const own = await env.DB.prepare("SELECT export_name FROM artifacts WHERE id = ? AND publisher_id = ?").bind(pr.artifact_id, p.id).first("export_name");
    if (own && own !== name) throw new HttpError(422, "idempotency_key_reused", "Idempotency key was used with a different request");
  } else if (ex && ex.head_rev > 0) {
    if (ex.trashed_at) throw new HttpError(409, "destination_file_trashed", "The owner moved this app's file to trash; ask the owner to restore it", { name, file_id: ex.id });
    if (ex.kind !== "binary") throw new HttpError(422, "unsupported_kind", `${name} is a ${ex.kind} file; binary uploads can only create or update binary files`, { name, file_id: ex.id });
    if (b.expected_revision === void 0 || b.expected_revision === 0) throw new HttpError(409, "file_exists", `${name} already exists; pass expected_revision to upload a new version`, { name, file_id: ex.id, current_revision: ex.head_rev });
    if (b.expected_revision !== ex.head_rev) throw new HttpError(409, "revision_conflict", "Expected revision is stale", { name, file_id: ex.id, current_revision: ex.head_rev, expected_revision: b.expected_revision });
    artifactId = ex.id;
  } else {
    if (b.expected_revision !== void 0 && b.expected_revision !== 0) throw new HttpError(409, "revision_conflict", `${name} does not exist yet; omit expected_revision (or pass 0) to create it`, { name, current_revision: 0, expected_revision: b.expected_revision });
    // ex here is a placeholder that survived the release above: an earlier upload of this name is unfinished.
    if (ex) throw new HttpError(429, "upload_in_progress", `An earlier upload of ${name} is not finished; finish it or let it expire first`, { name, file_id: ex.id });
  }
  if (!prior) {
    const size = Number.isSafeInteger(b.size) && b.size > 0 ? b.size : 0;
    // Files with content, plus placeholders of uploads that may still publish (failed ones do not count).
    const q = await env.DB.prepare(`SELECT (SELECT COUNT(*) FROM artifacts a WHERE a.publisher_id = ? AND a.generation_id IS NULL
          AND (a.head_rev > 0 OR EXISTS (SELECT 1 FROM uploads u WHERE u.artifact_id = a.id AND ${PF_LIVE(nowMs())}))) AS n,
        (SELECT COALESCE(SUM(r.size), 0) FROM revisions r JOIN artifacts a ON a.id = r.artifact_id WHERE a.publisher_id = ?)
        + (SELECT COALESCE(SUM(total_bytes), 0) FROM publisher_generations WHERE publisher_id = ? AND state = 'staged') AS bytes`).bind(p.id, p.id, p.id).first();
    if (q && (q.n + (artifactId ? 0 : 1) > quota.files || q.bytes + size > quota.bytes))
      throw new HttpError(413, "quota_exceeded", "This app has reached its storage quota in the library; ask the owner", { max_files: quota.files, max_bytes: quota.bytes });
  }
  const fdPlan = artifactId ? null : await pfFolderCheck(env, p, name);
  const r = pfUnwrap(await uploadBegin(ctx, p.project_id, artifactId ? { artifact_id: artifactId, expected_revision: b.expected_revision, mime: b.mime, size: b.size, sha256: b.sha256 } : { title: name.split("/").pop(), mime: b.mime, size: b.size, sha256: b.sha256 }, key));
  const up = r.body;
  if (up.base_revision === 0) {
    // Claim the new file for this publisher: its name, its folder (the destination or a subfolder of it), never
    // review-gated (App Connect files are not).
    let folderId;
    try { folderId = await pfFolderFor(p, ctx, fdPlan); }
    catch (e) {
      await pfFailUpload(env, up.upload_id, "conflict", "The file's folder could not be created");
      throw e;
    }
    const folderPath = folderId ? await env.DB.prepare("SELECT COALESCE(path, name) AS p FROM folders WHERE id = ?").bind(folderId).first("p") : "";
    let claimed = false;
    try {
      await env.DB.prepare(`UPDATE artifacts SET publisher_id = ?, export_name = ?, folder_id = ?, folder = ?, review_mode = 'off'
          WHERE id = ? AND project_id = ? AND kind = 'binary' AND head_rev = 0 AND publisher_id IS NULL`).bind(p.id, name, folderId, folderPath ?? "", up.artifact_id, p.project_id).run();
    } catch {
    }
    const a = await env.DB.prepare("SELECT publisher_id, export_name FROM artifacts WHERE id = ? AND project_id = ?").bind(up.artifact_id, p.project_id).first();
    claimed = a?.publisher_id === p.id && a?.export_name === name;
    if (!claimed) {
      await pfFailUpload(env, up.upload_id, "conflict", "Another file took this name");
      throw new HttpError(409, "conflict", `A concurrent write took the name ${name}; nothing was uploaded. Re-list your files and retry`, { name });
    }
  }
  const u = await env.DB.prepare("SELECT state, expires_at, mime, expected_size, expected_sha256 FROM uploads WHERE id = ?").bind(up.upload_id).first();
  if (!u) throw new HttpError(404, "not_found", "Upload not found");
  const open = u.state === "pending" && u.expires_at > nowMs();
  if (open && note) await env.DB.prepare("UPDATE uploads SET change_note = ? WHERE id = ? AND state = 'pending' AND change_note IS NULL").bind(note, up.upload_id).run();
  const origin = new URL(req.url).origin;
  return json({
    upload_id: up.upload_id,
    file_id: up.artifact_id,
    name,
    base_revision: up.base_revision,
    mime: u.mime,
    size: u.expected_size,
    sha256: u.expected_sha256,
    state: u.state,
    expires_at: up.expires_at,
    put_url: `${origin}/v1/publisher/uploads/${up.upload_id}`,
    method: "PUT",
    finish_url: `${origin}/v1/publisher/uploads/${up.upload_id}/finish`,
    instructions: open ? "PUT the raw file bytes (exactly size bytes) to put_url with the same Authorization header, then POST finish_url with an Idempotency-Key." : "This upload no longer accepts bytes; POST finish_url to get its outcome.",
    ...up.idempotent_replay ? { idempotent_replay: true } : {}
  }, r.status);
}
__name(pfBegin, "pfBegin");
async function pfPut(req, env, p, ctx, uploadId) {
  await pfAssertWritable(env, p);
  await pfOwnUpload(env, p, ctx, uploadId);
  return uploadPut(req, env, ctx.requestId, uploadId, ctx);
}
__name(pfPut, "pfPut");
async function pfFinish(req, env, p, ctx, uploadId) {
  const key = idemKey(req.headers.get("idempotency-key"));
  // The body is empty or {}; read it (bounded) so the connection stays reusable.
  const raw = await ftReadCapped(req, PF_BODY_MAX);
  if (raw === null || raw.trim() !== "" && raw.trim() !== "{}") throw new HttpError(400, "invalid_input", "Finish body must be empty or {}");
  await pfAssertWritable(env, p);
  const u = await pfOwnUpload(env, p, ctx, uploadId);
  const r = pfUnwrap(await uploadFinish(ctx, p.project_id, uploadId, key)).body;
  const a = await env.DB.prepare("SELECT a.export_name, rv.mime FROM artifacts a JOIN revisions rv ON rv.artifact_id = a.id AND rv.rev_no = ? WHERE a.id = ? AND a.publisher_id = ?").bind(r.revision, u.artifact_id, p.id).first();
  return json({
    file: { file_id: u.artifact_id, name: a?.export_name ?? null, kind: "binary", mime: a?.mime ?? null, revision: r.revision, sha256: r.sha256, size: r.size, ...pfLinks(env, p.project_id, u.artifact_id) },
    ...r.idempotent_replay ? { idempotent_replay: true } : {}
  }, 200);
}
__name(pfFinish, "pfFinish");
// Bytes of one binary revision of the publisher's own file: always a download (attachment, sandbox CSP, nosniff),
// with Range support. Called from GET/HEAD /v1/publisher/files/{id}/content.
async function pfServeBlob(req, env, a, r) {
  const total = r.size;
  const headers = {
    "content-type": r.mime,
    "content-disposition": `attachment; filename="${String(a.export_name).split("/").pop()}"`,
    "x-content-type-options": "nosniff",
    "cache-control": "private, no-store",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'; sandbox",
    etag: `"${r.sha256}"`,
    "accept-ranges": "bytes"
  };
  let start = 0, end = total - 1, partial = false;
  const range = req.headers.get("range");
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || m[1] === "" && m[2] === "") return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${total}` } });
    if (m[1] === "") start = Math.max(0, total - Number(m[2]));
    else {
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
  const obj2 = await env.BLOBS.get(r.blob_key, partial ? { range: { offset: start, length: end - start + 1 } } : void 0);
  if (!obj2) throw new HttpError(500, "blob_missing", "Stored bytes missing");
  return new Response(obj2.body, { status, headers });
}
__name(pfServeBlob, "pfServeBlob");
// Publisher router hook: answers /v1/publisher/uploads[/...], otherwise null.
async function pfRoute(req, env, p, requestId, ctx, quota) {
  const path = new URL(req.url).pathname.replace(/\/$/, "");
  if (!path.startsWith("/v1/publisher/uploads")) return null;
  if (PF_UPLOADS.test(path)) {
    if (req.method !== "POST") throw new HttpError(405, "method_not_allowed", "Method not allowed");
    return pfBegin(req, env, p, ctx, quota);
  }
  const m = PF_UPLOAD.exec(path);
  if (!m) throw new HttpError(404, "not_found", "Not found");
  if (m[2]) {
    if (req.method !== "POST") throw new HttpError(405, "method_not_allowed", "Method not allowed");
    return pfFinish(req, env, p, ctx, m[1]);
  }
  if (req.method !== "PUT") throw new HttpError(405, "method_not_allowed", "Method not allowed");
  return pfPut(req, env, p, ctx, m[1]);
}
__name(pfRoute, "pfRoute");
