// Files for OAuth (MCP) connections: list, read (inline image + short-lived download link) and upload new files or
// versions (begin -> HTTP PUT to a single-upload link -> finish). Spliced in by build-file-tools-fixes.mjs right
// before // src/api/publisher.ts; docs/agent-setup.md#files. Needs migration 0013_oauth_file_access.sql.
//  - Only connections approved on a consent page that offered files (oauth_connections.file_access = 1) get these
//    tools. Older connections keep exactly what they were shown (documents and history) until the owner reconnects.
//  - Uploads reuse uploadBegin/uploadPut/uploadFinish (quota, BINARY_TYPES, LIMITS.binaryBytes, finalize lease).
//    They run as a per-connection agent principal, so "one active upload per identity" applies per connection and
//    an agent's upload never blocks the owner's own uploads. Authorship in History is the connection (via oauth).
//  - Transfer links are capabilities for one revision (download) or one upload (PUT). Only their SHA-256 is stored.
//    Every request re-checks the live connection, the project and (for PUT) edit permission, so revoking a
//    connection stops links minted before the revoke. Never log or print link URLs.
var FT_DOWNLOAD_TTL_MS = 10 * 60 * 1e3;
var FT_INLINE_IMAGE_BYTES = 1024 * 1024;
// upload_file: bytes inline as base64 in the tool call, for agents that cannot make HTTP requests (owner-approved
// 2026-10-27). Same upload machinery as begin/PUT/finish. MCP request bodies of connections with files may be up to
// FT_MCP_BODY_MAX so a full-size inline upload fits (base64 is 4/3 the size, plus JSON).
var FT_INLINE_UPLOAD_BYTES = 2 * 1024 * 1024;
var FT_INLINE_B64_MAX = Math.ceil(FT_INLINE_UPLOAD_BYTES / 3) * 4;
var FT_MCP_BODY_MAX = 3 * 1024 * 1024;
function ftMcpBodyMax(conn) {
  return conn?.file_access === 1 ? FT_MCP_BODY_MAX : 1024 * 1024;
}
__name(ftMcpBodyMax, "ftMcpBodyMax");
// Reads at most max bytes of a request body (counted while streaming, so a body without Content-Length cannot make
// the Worker buffer more); null when it is larger.
async function ftReadCapped(req, max) {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks = [];
  let n = 0;
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => {
      });
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(n);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(all);
}
__name(ftReadCapped, "ftReadCapped");
// Rate limits answered as a tool result the model can read (limit, budget, seconds to wait), not a bare HTTP 429.
function ftRateLimited(msg, tool, write, e, lim) {
  const limit = write ? 20 : 60;
  const wait = Math.max(1, Math.min(60, Number(e?.extra?.retry_after_seconds) || 60));
  const what = write ? "changes (create, save, upload, restore)" : "reads";
  const err2 = { status: 429, code: "rate_limited", message: `Rate limit: this connection allows ${limit} ${what} per minute. Wait ${wait} seconds, then retry the same call (reuse its idempotency_key).`, retry_after_seconds: wait, limit_per_minute: limit, budget: write ? "write" : "read" };
  if (msg.method === "tools/call" && tool) return new Response(rtFit(rpc(msg.id, toolError(err2)), lim), { status: 200, headers: { ...HDR, "retry-after": String(wait) } });
  return new Response(rtFit(rpcErr(msg.id, -32002, err2.message), lim), { status: 429, headers: { ...HDR, "retry-after": String(wait) } });
}
__name(ftRateLimited, "ftRateLimited");
var FT_LINK = /^\/files\/([du])\/(ft_[A-Za-z0-9_-]{40,60})$/;
function ftUploadPrincipal(conn) {
  return { id: "oap_" + conn.id.slice(4), kind: "agent", label: `oauth:${conn.client_name}`.slice(0, 200) };
}
__name(ftUploadPrincipal, "ftUploadPrincipal");
async function ftUploadCtx(c, create) {
  const principal = ftUploadPrincipal(c.ftConn);
  if (create) await c.env.DB.prepare("INSERT OR IGNORE INTO principals (id, kind, issuer, subject, label, created_at) VALUES (?, 'agent', 'agent-library-oauth', ?, ?, ?)").bind(principal.id, c.ftConn.id, principal.label, nowIso()).run();
  return { ...c, principal };
}
__name(ftUploadCtx, "ftUploadCtx");
async function ftMint(c, kind, projectId, artifactId, revNo, uploadId, expiresAt) {
  const token = randomId("ft", 32);
  await c.env.DB.prepare("INSERT INTO transfer_links (token_hash, kind, connection_id, project_id, artifact_id, rev_no, upload_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(await sha256Hex(token), kind, c.ftConn.id, projectId, artifactId, revNo, uploadId, expiresAt, nowIso()).run();
  return `${c.ftOrigin}/files/${kind === "download" ? "d" : "u"}/${token}`;
}
__name(ftMint, "ftMint");
function ftBase64(bytes) {
  if (typeof bytes.toBase64 === "function") return bytes.toBase64();
  let s = "";
  for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(s);
}
__name(ftBase64, "ftBase64");
function ftWebUrl(c, projectId, artifactId) {
  const o = appOrigin(c.env.APP_HOST);
  return o ? { web_url: artifactWebUrl(o, projectId, artifactId) } : {};
}
__name(ftWebUrl, "ftWebUrl");
// Extra MCP content blocks (image, resource_link) ride on a symbol key: never part of structuredContent or its text.
var FT_BLOCKS = Symbol("ftBlocks");
function ftContent(result, protocolVersion) {
  // resource_link exists from MCP 2025-06-18. A missing MCP-Protocol-Version header means 2025-03-26 (spec), so those
  // clients get the image only; download_url is always in the text.
  const v = protocolVersion || "2025-03-26";
  const blocks = (result?.[FT_BLOCKS] ?? []).filter((b) => b.type !== "resource_link" || v !== "2025-03-26");
  return [{ type: "text", text: JSON.stringify(result) }, ...blocks];
}
__name(ftContent, "ftContent");
async function ftReadFile(c, p, a) {
  const r = await getArtifact(c, p, a.artifact_id, a.revision);
  if (r.artifact.kind !== "binary") throw new HttpError(415, "unsupported_kind", "Not a file; use read_artifact for documents");
  const rev = r.revision;
  const expires = nowMs() + FT_DOWNLOAD_TTL_MS;
  const url = await ftMint(c, "download", p, a.artifact_id, rev.rev, null, expires);
  const canInline = IMAGE_TYPES.includes(rev.mime) && rev.size <= FT_INLINE_IMAGE_BYTES;
  const wantInline = canInline && a.include_image !== false;
  const blocks = [];
  if (wantInline) {
    const row = await db(c).prepare("SELECT blob_key FROM revisions WHERE id = ? AND project_id = ?").bind(rev.id, p).first();
    const obj2 = row?.blob_key ? await c.env.BLOBS.get(row.blob_key) : null;
    if (!obj2) throw new HttpError(500, "blob_missing", "Stored bytes missing");
    blocks.push({ type: "image", data: ftBase64(new Uint8Array(await obj2.arrayBuffer())), mimeType: rev.mime });
  }
  blocks.push({ type: "resource_link", uri: url, name: r.artifact.title, mimeType: rev.mime, size: rev.size, description: "Short-lived download link for this version (expires in minutes; not a share link)" });
  const result = {
    artifact: { ...r.artifact, ...ftWebUrl(c, p, a.artifact_id) },
    revision: rev,
    image_inline: wantInline,
    ...!wantInline && IMAGE_TYPES.includes(rev.mime) ? { image_note: canInline ? "include_image was false" : `Image is over ${FT_INLINE_IMAGE_BYTES} bytes; fetch download_url` } : {},
    download_url: url,
    download_expires_at: new Date(expires).toISOString(),
    web_url_opens: "current_document"
  };
  Object.defineProperty(result, FT_BLOCKS, { value: blocks, enumerable: true });
  return result;
}
__name(ftReadFile, "ftReadFile");
async function ftUploadBegin(c, p, a, opts = {}) {
  const note = provenance(c, a)[4];
  if (!note) throw new HttpError(400, "change_note_required", "change_note is required: one line on why you are adding or changing this file");
  const isNew = a.artifact_id === void 0;
  if (isNew ? a.title === void 0 || a.expected_revision !== void 0 : a.title !== void 0 || a.expected_revision === void 0)
    throw new HttpError(400, "invalid_input", "Pass title for a new file, or artifact_id and expected_revision for a new version");
  const uc = await ftUploadCtx(c, true);
  const key = idemKey(a.idempotency_key);
  if (!isNew) {
    const cur = await loadArtifact(c, p, str(a.artifact_id, "artifact_id", 64));
    if (cur.kind !== "binary") throw new HttpError(415, "unsupported_kind", "Not a file; use save_markdown for documents");
    // Fail early on a stale revision, except when retrying a begin that already succeeded (it replays below).
    const retry = await db(c).prepare("SELECT 1 AS x FROM idempotency WHERE principal_id = ? AND project_id = ? AND op = 'upload.begin' AND key = ?").bind(uc.principal.id, p, key).first("x");
    if (!retry && cur.head_rev !== a.expected_revision) throw new HttpError(409, "revision_conflict", "Expected revision is stale", { current_revision: cur.head_rev, expected_revision: a.expected_revision });
  }
  const r = unwrap(await uploadBegin(uc, p, { title: a.title, folder: a.folder, artifact_id: a.artifact_id, expected_revision: a.expected_revision, mime: a.mime, size: a.size, sha256: a.sha256 }, key));
  const u = await db(c).prepare("SELECT state, expires_at FROM uploads WHERE id = ? AND principal_id = ?").bind(r.upload_id, uc.principal.id).first();
  if (!u) throw new HttpError(404, "not_found", "Upload not found");
  const open = u.state === "pending" && u.expires_at > nowMs();
  if (open) await db(c).prepare("UPDATE uploads SET change_note = ? WHERE id = ? AND state = 'pending' AND change_note IS NULL").bind(note, r.upload_id).run();
  const { put_url: _apiPath, instructions: _i, ...rest } = r;
  return {
    ...rest,
    state: u.state,
    ...open && opts.link === false ? {} : open ? {
      put_url: await ftMint(c, "upload", p, r.artifact_id, null, r.upload_id, u.expires_at),
      method: "PUT",
      instructions: "HTTP PUT the raw file bytes (exactly size bytes) to put_url; no Authorization header is needed. Then call upload_finish with upload_id. put_url works for this one upload only and expires at expires_at."
    } : { instructions: "This upload is no longer accepting bytes; call upload_finish with upload_id to get its outcome." }
  };
}
__name(ftUploadBegin, "ftUploadBegin");
async function ftUploadFinish(c, p, a) {
  const uc = await ftUploadCtx(c, false);
  const r = unwrap(await uploadFinish(uc, p, str(a.upload_id, "upload_id", 64), idemKey(a.idempotency_key)));
  await db(c).prepare("DELETE FROM transfer_links WHERE upload_id = ?").bind(a.upload_id).run().catch(() => {
  });
  return { ...r, ...r.artifact_id ? ftWebUrl(c, p, r.artifact_id) : {} };
}
__name(ftUploadFinish, "ftUploadFinish");
function ftDecodeBase64(v) {
  const s = str(v, "content_base64", FT_INLINE_B64_MAX + 4096).replace(/\s+/g, "");
  const tooBig = () => new HttpError(413, "too_large", `upload_file takes up to ${FT_INLINE_UPLOAD_BYTES} bytes; use upload_begin + HTTP PUT for larger files (up to ${LIMITS.binaryBytes} bytes)`);
  if (s.length > FT_INLINE_B64_MAX + 4) throw tooBig();
  if (!s || s.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new HttpError(400, "invalid_input", "content_base64 must be non-empty standard base64");
  let out2;
  try {
    if (typeof Uint8Array.fromBase64 === "function") out2 = Uint8Array.fromBase64(s);
    else {
      const bin = atob(s);
      out2 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out2[i] = bin.charCodeAt(i);
    }
  } catch {
    throw new HttpError(400, "invalid_input", "content_base64 must be standard base64");
  }
  if (out2.length > FT_INLINE_UPLOAD_BYTES) throw tooBig();
  return out2;
}
__name(ftDecodeBase64, "ftDecodeBase64");
// One call: begin (idempotent), the same PUT handler with the decoded bytes, then finish (idempotent). A retry with
// the same idempotency_key resumes wherever the first attempt stopped and never publishes twice.
async function ftUploadInline(c, p, a) {
  const bytes = ftDecodeBase64(a.content_base64);
  const { content_base64: _b, ...rest } = a;
  const begun = await ftUploadBegin(c, p, { ...rest, size: bytes.length, sha256: await sha256Hex(bytes) }, { link: false });
  if (begun.state === "pending") {
    const uc = await ftUploadCtx(c, false);
    await uploadPut(new Request("https://upload.invalid/inline", { method: "PUT", body: bytes, headers: { "content-length": String(bytes.length) } }), c.env, c.requestId, begun.upload_id, uc);
  }
  return ftUploadFinish(c, p, { upload_id: begun.upload_id, idempotency_key: a.idempotency_key });
}
__name(ftUploadInline, "ftUploadInline");
async function ftList(c, p, a) {
  const prefix = a.mime_prefix === void 0 ? "" : str(a.mime_prefix, "mime_prefix", 100).toLowerCase();
  const r = await listArtifacts(c, p, { query: a.query, cursor: a.cursor, kind: a.kind, folderId: appConnectEnabled(c.env) ? a.folder_id : void 0 });
  const ids = r.artifacts.map((x) => x.id);
  const info = /* @__PURE__ */ new Map();
  if (ids.length) {
    const rows = await db(c).prepare(`SELECT a.id, r.mime, r.size FROM artifacts a JOIN revisions r ON r.artifact_id = a.id AND r.project_id = a.project_id AND r.rev_no = a.head_rev
      WHERE a.project_id = ? AND a.id IN (${ids.map(() => "?").join(",")})`).bind(p, ...ids).all();
    for (const x of rows.results) info.set(x.id, x);
  }
  // JSON/CSV data files are App Connect features; without it they stay hidden from connections, as before.
  const shown = appConnectEnabled(c.env) ? r.artifacts : r.artifacts.filter((x) => x.kind !== "json" && x.kind !== "csv");
  const artifacts = shown.map((x) => ({ ...x, mime: info.get(x.id)?.mime ?? null, size: info.get(x.id)?.size ?? null })).filter((x) => !prefix || (x.mime ?? "").startsWith(prefix));
  return { ...r, artifacts };
}
__name(ftList, "ftList");
// Tool definitions are built lazily: S, P, A, K, NOTE, RO and RW are set when the OAuth MCP module initialises.
var ftDefs = null;
// Documents-only connections (approved before files were offered): every tool that names an artifact refuses files,
// as if they were not there (history, diff, restores included), so they get exactly what their consent page said.
var ftDocsOnlyCache = /* @__PURE__ */ new WeakMap();
function ftDocsOnly(base) {
  let out2 = ftDocsOnlyCache.get(base);
  if (out2) return out2;
  out2 = base.map((t) => !t.inputSchema.properties.artifact_id ? t : { ...t, run: /* @__PURE__ */ __name(async (c, p, a) => {
    const k = await db(c).prepare("SELECT kind FROM artifacts WHERE id = ? AND project_id = ?").bind(String(a.artifact_id ?? ""), p).first("kind");
    if (k === "binary") throw new HttpError(404, "not_found", "Artifact not found");
    return t.run(c, p, a);
  }, "run") });
  ftDocsOnlyCache.set(base, out2);
  return out2;
}
__name(ftDocsOnly, "ftDocsOnly");
function ftToolsFor(env, conn) {
  const base = toolsFor(env);
  if (!conn || conn.file_access !== 1) return ftDocsOnly(base);
  ftDefs ??= {
    read_file: {
      name: "read_file",
      title: "Read file",
      description: `Read a file (image, PDF, video or other upload), current or a given revision. Returns metadata (mime, size, sha256, revision), a download_url and a resource_link. Images (PNG, JPEG, WebP, GIF) up to ${FT_INLINE_IMAGE_BYTES / 1048576} MiB are also returned inline so you can see them. download_url is a short-lived link to this one version (about 10 minutes; plain GET, supports Range); it is not a share link, so do not give it to people. web_url is for the user's browser.`,
      inputSchema: S({ project_id: P, artifact_id: A, revision: { type: "integer", minimum: 1 }, include_image: { type: "boolean", description: "Return images inline (default true)" } }, ["artifact_id"]),
      annotations: RO,
      write: false,
      run: /* @__PURE__ */ __name((c, p, a) => ftReadFile(c, p, a), "run")
    },
    upload_begin: {
      name: "upload_begin",
      title: "Upload a file",
      description: `Start uploading a new file (pass title) or a new version of a file (pass artifact_id and expected_revision; revision_conflict if it is stale). Allowed: PNG, JPEG, WebP, GIF, PDF, MP4, WebM or other binary (application/octet-stream, download-only), up to ${LIMITS.binaryBytes / 1048576} MiB. Declare the exact size and SHA-256 of the bytes. Then HTTP PUT the raw bytes to the returned put_url (single-use upload link, expires in minutes) and call upload_finish. If you cannot make HTTP requests, use upload_file instead (up to ${FT_INLINE_UPLOAD_BYTES / 1048576} MiB). Each version is kept; always set change_note to why.`,
      inputSchema: S({
        project_id: P,
        title: { type: "string", minLength: 1, maxLength: 200, description: "Title of a new file" },
        folder: { type: "string", maxLength: 200 },
        artifact_id: { ...A, description: "File to add a new version to" },
        expected_revision: { type: "integer", minimum: 1, description: "Current revision of artifact_id" },
        mime: { type: "string", enum: Object.keys(BINARY_TYPES) },
        size: { type: "integer", minimum: 1, maximum: LIMITS.binaryBytes },
        sha256: { type: "string", pattern: "^[0-9a-f]{64}$", description: "SHA-256 of the bytes, lowercase hex" },
        change_note: NOTE,
        idempotency_key: K
      }, ["mime", "size", "sha256", "change_note", "idempotency_key"]),
      annotations: RW,
      write: true,
      run: /* @__PURE__ */ __name((c, p, a) => ftUploadBegin(c, p, a), "run")
    },
    upload_file: {
      name: "upload_file",
      title: "Upload a small file",
      description: `Upload a file in one call, bytes as content_base64 (up to ${FT_INLINE_UPLOAD_BYTES / 1048576} MiB decoded). New file: pass title. New version: pass artifact_id and expected_revision (revision_conflict if stale). Allowed: PNG, JPEG, WebP, GIF, PDF, MP4, WebM or application/octet-stream. For larger files (up to ${LIMITS.binaryBytes / 1048576} MiB), use upload_begin + HTTP PUT + upload_finish. Safe to retry with the same idempotency_key. Returns artifact_id, revision and web_url (for the user's browser). Always set change_note to why.`,
      inputSchema: S({
        project_id: P,
        title: { type: "string", minLength: 1, maxLength: 200, description: "Title of a new file" },
        folder: { type: "string", maxLength: 200 },
        artifact_id: { ...A, description: "File to add a new version to" },
        expected_revision: { type: "integer", minimum: 1, description: "Current revision of artifact_id" },
        mime: { type: "string", enum: Object.keys(BINARY_TYPES) },
        content_base64: { type: "string", maxLength: FT_INLINE_B64_MAX + 4, contentEncoding: "base64", description: "The file's bytes, standard base64" },
        change_note: NOTE,
        idempotency_key: K
      }, ["mime", "content_base64", "change_note", "idempotency_key"]),
      annotations: RW,
      write: true,
      run: /* @__PURE__ */ __name((c, p, a) => ftUploadInline(c, p, a), "run")
    },
    upload_finish: {
      name: "upload_finish",
      title: "Finish upload",
      description: "Finish an upload after the PUT: verifies size, SHA-256 and file type, then publishes exactly one new version (shown in History with your change_note). Safe to retry; returns artifact_id, revision and web_url (for the user's browser).",
      inputSchema: S({ project_id: P, upload_id: { type: "string", maxLength: 64 }, idempotency_key: K }, ["upload_id", "idempotency_key"]),
      annotations: RW,
      write: true,
      run: /* @__PURE__ */ __name((c, p, a) => ftUploadFinish(c, p, a), "run")
    }
  };
  const out2 = [];
  for (const t of base) {
    if (t.name === "list_artifacts") {
      out2.push({
        ...t,
        title: "List documents and files",
        description: 'List or search documents (Markdown, HTML, JSON, CSV) and files (images, PDFs, video: kind "binary") in a connected project. Each item has kind, mime, size and revision. Paginated (50 per page; pass next_cursor).',
        inputSchema: S({
          project_id: P,
          query: { type: "string", maxLength: 200 },
          cursor: { type: "string", maxLength: 12 },
          kind: { type: "string", enum: ["markdown", "html", "json", "csv", "binary"], description: 'Only this kind; "binary" means files (images, PDFs, video)' },
          mime_prefix: { type: "string", maxLength: 100, description: 'Only items whose MIME type starts with this, e.g. "image/" or "application/pdf". A page can then hold fewer than 50 items; keep following next_cursor.' },
          ...appConnectEnabled(env) ? { folder_id: AC_LIST_PROPS.folder_id } : {}
        }, []),
        run: /* @__PURE__ */ __name((c, p, a) => ftList(c, p, a), "run")
      });
    } else if (t.name === "read_artifact") {
      out2.push({
        ...t,
        title: "Read document or file",
        description: "Read a document (Markdown, HTML, JSON, CSV: returns its text, revision and sha256) or a file (image, PDF, video: same result as read_file), current or a given revision.",
        inputSchema: S({ ...t.inputSchema.properties, include_image: { type: "boolean", description: "For images: return them inline (default true)" } }, t.inputSchema.required),
        run: /* @__PURE__ */ __name(async (c, p, a) => {
          const { include_image: _x, ...rest } = a;
          try {
            return await t.run(c, p, rest);
          } catch (e) {
            // A chunked read (cursor/max_bytes) of a file returns the link only: an inline image could never fit max_bytes.
            if (e instanceof HttpError && e.code === "unsupported_kind") return ftReadFile(c, p, a.cursor != null || a.max_bytes != null ? { ...a, include_image: false } : a);
            throw e;
          }
        }, "run")
      }, ftDefs.read_file);
    } else out2.push(t);
    if (t.name === "save_markdown") out2.push(ftDefs.upload_file, ftDefs.upload_begin, ftDefs.upload_finish);
  }
  return out2;
}
__name(ftToolsFor, "ftToolsFor");
var FT_INSTRUCTIONS = "Agent Library: documents (Markdown, HTML, JSON, CSV) and files (images, PDFs, video) in owner-approved projects. Call list_projects first; pass project_id when more than one project is connected. Read before editing; saves need expected_revision and a fresh idempotency_key. read_file returns images inline and a short-lived download_url for any file. To add a file or a new version: upload_file (bytes as base64, up to 2 MiB), or upload_begin, HTTP PUT the bytes to put_url, then upload_finish. Every change is kept as a version the owner reviews in History: whenever a tool has a change_note field, always set it to one line on why.";
// GET/HEAD /files/d/<token> (download one revision) and PUT /files/u/<token> (bytes of one upload), on the MCP host.
async function handleFileTransfer(req, env, url) {
  const requestId = randomId("req", 9);
  try {
    const m = FT_LINK.exec(url.pathname);
    if (!m) throw new HttpError(404, "not_found", "Not found");
    const kind = m[1] === "d" ? "download" : "upload";
    if (kind === "download" ? req.method !== "GET" && req.method !== "HEAD" : req.method !== "PUT")
      return new Response(null, { status: 405, headers: { allow: kind === "download" ? "GET, HEAD" : "PUT" } });
    const row = await env.DB.prepare("SELECT * FROM transfer_links WHERE token_hash = ? AND kind = ?").bind(await sha256Hex(m[2]), kind).first();
    if (!row || row.expires_at <= nowMs()) {
      await rateLimit(env, "authfail:" + (req.headers.get("cf-connecting-ip") ?? "local"), limitsFor(env).authFailPerMin);
      throw new HttpError(401, "link_expired", kind === "download" ? "Link expired or unknown; call read_file again for a fresh one" : "Upload link expired or unknown; start again with upload_begin");
    }
    const conn = await liveConnection(env, row.connection_id);
    if (!conn || conn.can_read !== 1 || conn.file_access !== 1) throw new HttpError(401, "connection_revoked", "Connection revoked or expired");
    const proj = conn.projects.find((x) => x.id === row.project_id);
    if (!proj) throw new HttpError(403, "forbidden", "This connection no longer has access to this project");
    const canWrite = conn.can_write === 1 && proj.can_write === 1;
    const ctx = {
      env,
      requestId,
      principal: { id: conn.owner_principal_id, kind: "agent", label: `oauth:${conn.client_name}` },
      grant: { id: conn.id, project_id: proj.id, can_write: canWrite ? 1 : 0 },
      oauthConnection: true,
      via: { kind: "oauth", id: conn.id, label: conn.client_name }
    };
    if (kind === "download") {
      await rateLimit(env, `dl:oauth:${conn.id}`, 300);
      return await serveContent(ctx, req, row.project_id, row.artifact_id, String(row.rev_no));
    }
    if (!canWrite) throw new HttpError(403, "forbidden", "This connection is read-only for this project");
    return await uploadPut(req, env, requestId, row.upload_id, { ...ctx, principal: ftUploadPrincipal(conn) });
  } catch (e) {
    if (e instanceof HttpError) return json(errorBody(e), e.status, { "x-request-id": requestId });
    console.error("file_transfer_error", requestId, e?.message);
    return json({ error: { code: "internal", message: "Internal error", request_id: requestId } }, 500);
  }
}
__name(handleFileTransfer, "handleFileTransfer");
