// App Files API (/v1/app/files): an app's own files, addressed by path, in its approved destination. Text (Markdown,
// HTML, JSON, CSV) and binary files (images, PDF, video, octet-stream) share one path model, one precondition model and
// one idempotency model. A file's path is artifacts.export_name (unique per publisher); its folder segments are real
// subfolders of the destination, created on first write and marked as the app's (folders.publisher_id). Every request
// re-checks the publisher's current authorization (assertStillAuthorized, and the BASE_SQL fence inside every write).
// Handlers take a database handle (`db`) for their own queries; nothing here keeps state between requests.
import { authzSql } from "../auth.js";
import { blobPrefix, blobWriteFence, dropBlobWrite, isBlobWriteError, stageBlobWrite, textWriteComplete, writeUploadBlob } from "../content-store.js";
import { MIME, checkFile } from "../formats.js";
import { fdEnsure, fdPathOf } from "../folders.js";
import { BINARY_TYPES, audit, createMarkdown, idemInsert, idemLookup, mdBody, publishRevision, runBatch, servedContentType } from "../service.js";
import { metaBaselineInsert, metaVersionInsert } from "../history/service.js";
import { explainLimit, fileTooLarge, projectLimitGuard } from "../limits.js";
import { indexDocument, unindexDocument } from "../search/indexing.js";
import { appOrigin, artifactWebUrl, previewWebUrl } from "../links.js";
import { serveContent } from "../uploads.js";
import { HttpError, b64url, idemKey, int, json, nowIso, randomId, sha256Hex } from "../util.js";
import { assertStillAuthorized, pubCtx, testPause } from "./app-auth.js";

/**
 * SQL fence: the publisher is live, its app client enabled and its destination still valid. Params, in order:
 * publisher id, token epoch, project id, folder id (or null).
 */
export const BASE_SQL = `EXISTS (SELECT 1 FROM publishers pb JOIN app_clients ac ON ac.id = pb.app_client_id
  WHERE pb.id = ? AND pb.token_epoch = ? AND pb.revoked_at IS NULL AND ac.disabled_at IS NULL
    AND pb.project_id = ? AND pb.folder_id IS ?
    AND (pb.folder_id IS NULL OR EXISTS (SELECT 1 FROM folders f WHERE f.id = pb.folder_id AND f.project_id = pb.project_id)))`;
/** Params for BASE_SQL, for the publisher row `p`. */
export const baseParams = (p) => [p.id, p.token_epoch, p.project_id, p.folder_id ?? null];

export const APP_PATH_MAX_CHARS = 200;
export const APP_PATH_MAX_SEGMENTS = 8;
export const APP_FILES_PAGE_MAX = 100;
/** A text file sent to App Files: at most 1 MiB, declared by Content-Length and refused before any byte is read. */
export const APP_FILE_MAX_BYTES = 1048576;
/** A binary file: at most the workspace plan's file_bytes (limits.js, default 25 MiB, never above 90 MiB). */

const ROOT = "/v1/app/files";
// Lowercase only, so a path is unique by name alone (no case-folding rules needed); the last segment's extension
// chooses the kind. A folder segment may contain '.' ("v1.0") but never ends in a text extension (as before).
const SEGMENT = /^[a-z0-9_-][a-z0-9._-]*$/;
const TEXT_EXT_RE = /\.(md|html|json|csv)$/;
const TEXT_EXT = new Map([["md", "markdown"], ["html", "html"], ["json", "json"], ["csv", "csv"]]);
/** Binary extensions with a fixed type; any other 1-10 character [a-z0-9] extension is application/octet-stream. */
const BINARY_EXT = new Map([["png", "image/png"], ["jpg", "image/jpeg"], ["jpeg", "image/jpeg"], ["webp", "image/webp"], ["gif", "image/gif"],
  ["pdf", "application/pdf"], ["mp4", "video/mp4"], ["webm", "video/webm"]]);
// Extensions that are never stored as octet-stream: they name a text kind or a format the library refuses (SVG,
// which is active content on any origin that renders it).
const REFUSED_EXT = new Set(["svg", "svgz", "htm", "xhtml", "txt", "markdown"]);
const invalidPath = () => new HttpError(400, "invalid_path", "File path must be 1-8 segments of lowercase letters, digits, '.', '_' or '-' (not starting with '.'), at most 200 characters; the last segment ends in a file extension (e.g. .md, .json, .png, .pdf) and no folder segment ends in .md, .html, .json or .csv");
const tooLargeText = () => new HttpError(413, "file_too_large", "A text file sent to this API can be at most 1 MiB (1,048,576 bytes)", { limit_bytes: APP_FILE_MAX_BYTES });

/**
 * Headers every App Files content answer carries, 304 included. A copy of serveContent's fixed set
 * (uploads.js, the non-spreadsheet branch); test/app-files.test.mjs checks a 304 and a 200 agree.
 */
export const APP_FILE_RESPONSE_HEADERS = Object.freeze({
  "x-content-type-options": "nosniff",
  "cache-control": "private, no-store, no-transform",
  "content-security-policy": "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'; sandbox",
  "cross-origin-resource-policy": "same-origin"
});

/** Is this an App Files request (list or file)? Matched on the parsed pathname; the raw path is checked later. */
export const isAppFilesPath = (pathname) => /^\/v1\/app\/files(\/|$)/.test(pathname);
/** Is this an App Files file (content) request? Its answers carry stored bytes and are never link-rewritten. */
export const isAppFileContentPath = (pathname) => pathname.startsWith(`${ROOT}/`);

/**
 * The request path exactly as sent: it must equal the parsed pathname (no dot segments, no '\', nothing the URL
 * parser would change) and be the list or a file below it. Returns "" for the list, else the path after the root.
 */
export function appFilesRawPath(req) {
  const raw = req.url.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*/, "").split(/[?#]/, 1)[0];
  if (raw !== new URL(req.url).pathname || raw.includes("\\")) throw invalidPath();
  if (raw === ROOT) return "";
  if (!raw.startsWith(`${ROOT}/`) || raw.length === ROOT.length + 1) throw invalidPath();
  return raw.slice(ROOT.length + 1);
}

/**
 * Validate an App Files path. Returns { path, kind, mime, folders, name }: kind is markdown/html/json/csv or binary;
 * mime the one Content-Type a PUT must declare; folders the folder segments (subfolders of the destination).
 */
export function parseAppPath(rest) {
  if (typeof rest !== "string" || rest.length > APP_PATH_MAX_CHARS) throw invalidPath();
  const segments = rest.split("/");
  if (segments.length > APP_PATH_MAX_SEGMENTS) throw invalidPath();
  const name = segments.at(-1), folders = segments.slice(0, -1);
  // Folder segments become folder names (1-80 characters, docs/folders.md).
  if (!SEGMENT.test(name) || !folders.every((s) => SEGMENT.test(s) && s.length <= 80 && !TEXT_EXT_RE.test(s))) throw invalidPath();
  const ext = /\.([a-z0-9]{1,10})$/.exec(name)?.[1];
  if (!ext || name === "." + ext || REFUSED_EXT.has(ext)) throw invalidPath();
  const kind = TEXT_EXT.get(ext);
  if (kind) return { path: rest, kind, mime: kind === "markdown" ? "text/markdown" : kind === "html" ? "text/html" : MIME[kind], folders, name };
  return { path: rest, kind: "binary", mime: BINARY_EXT.get(ext) ?? "application/octet-stream", folders, name };
}

/** Every artifact lookup is confined to this publisher's live files (in its destination or the app's subfolders). */
const OWN = "a.publisher_id = ? AND a.project_id = ? AND a.export_name IS NOT NULL AND a.head_rev > 0 AND a.trashed_at IS NULL";
const ownParams = (p) => [p.id, p.project_id];

function fileItem(env, a) {
  const o = appOrigin(env.APP_HOST);
  const linkable = a.kind !== "binary";
  return {
    path: a.export_name,
    file_id: a.id,
    kind: a.kind,
    mime: a.mime,
    content_type: servedContentType(a.mime),
    title: a.title,
    folder: a.folder_id ? { id: a.folder_id, path: a.folder_path } : null,
    revision: a.head_rev,
    etag: `"${a.sha256}"`,
    sha256: a.sha256,
    size: a.size,
    created_at: a.created_at,
    updated_at: a.updated_at,
    ...o ? { web_url: artifactWebUrl(o, a.project_id, a.id), ...linkable ? { preview_url: previewWebUrl(o, a.project_id, a.id) } : {} } : {}
  };
}

function listParams(url) {
  const sp = url.searchParams;
  const prefix = sp.get("prefix") ?? "";
  if (!/^[a-z0-9._/-]{0,200}$/.test(prefix)) throw new HttpError(400, "invalid_input", "prefix must be at most 200 characters of lowercase letters, digits, '.', '_', '-' or '/'");
  let after = "";
  const cursor = sp.get("cursor");
  if (cursor !== null) {
    const bad = () => new HttpError(400, "invalid_input", "cursor is not valid");
    if (!/^[A-Za-z0-9_-]{1,268}$/.test(cursor)) throw bad();
    try { after = atob(cursor.replace(/-/g, "+").replace(/_/g, "/")); } catch { throw bad(); }
    if (!/^[a-z0-9._/-]{1,200}$/.test(after)) throw bad();
  }
  const limit = sp.get("limit") === null ? APP_FILES_PAGE_MAX : int(Number(sp.get("limit")), "limit", 1, APP_FILES_PAGE_MAX);
  return { prefix, after, limit };
}

/** The list: keyset pagination on (publisher_id, export_name), the artifacts_publisher_name index; '~' sorts after every path character. */
export const LIST_SQL = `SELECT a.id, a.project_id, a.export_name, a.kind, a.title, a.folder_id, a.head_rev, a.created_at, a.updated_at, r.sha256, r.size, r.mime,
    (SELECT COALESCE(f.path, f.name) FROM folders f WHERE f.id = a.folder_id) AS folder_path
    FROM artifacts a JOIN revisions r ON r.id = a.head_revision_id
    WHERE ${OWN} AND a.export_name >= ? AND a.export_name < ? AND a.export_name > ?
    ORDER BY a.export_name LIMIT ?`;
async function list({ env, db, p, req }) {
  const { prefix, after, limit } = listParams(new URL(req.url));
  const rows = (await db.prepare(LIST_SQL).bind(...ownParams(p), prefix, prefix + "~", after, limit + 1).all()).results;
  const page = rows.slice(0, limit);
  const next = rows.length > limit ? b64url(new TextEncoder().encode(page.at(-1).export_name)) : null;
  return json({ files: page.map((a) => fileItem(env, a)), next_cursor: next });
}

/** If-None-Match against a strong etag: '*', or any listed tag under weak comparison (W/ ignored). */
export function etagMatches(header, etag) {
  if (header === null) return false;
  if (header.trim() === "*") return true;
  return header.split(",").some((t) => t.trim().replace(/^W\//, "") === etag);
}

async function read({ req, env, db, p, requestId }, rest) {
  const { path } = parseAppPath(rest);
  const a = await db.prepare(`SELECT a.id, r.sha256 FROM artifacts a JOIN revisions r ON r.id = a.head_revision_id WHERE ${OWN} AND a.export_name = ?`)
    .bind(...ownParams(p), path).first();
  if (!a) throw new HttpError(404, "not_found", "File not found");
  const etag = `"${a.sha256}"`;
  if (etagMatches(req.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers: { ...APP_FILE_RESPONSE_HEADERS, etag } });
  // Only Range reaches serveContent: format, download and rev never apply here. serveContent decides inline vs
  // attachment (images, video and Markdown inline; PDF, HTML, JSON, CSV and octet-stream as attachments).
  const range = req.headers.get("range");
  const clean = new Request(new URL(req.url).origin + "/content", { method: req.method, headers: range === null ? {} : { range } });
  const res = await serveContent(pubCtx(env, p, requestId), clean, p.project_id, a.id, null);
  // no-transform: an edge that compresses the body (text) would otherwise weaken the ETag to W/"…", which the app
  // then can't send back as If-Match. The bytes and the strong ETag stay exactly what was stored.
  const headers = new Headers(res.headers);
  headers.set("cache-control", APP_FILE_RESPONSE_HEADERS["cache-control"]);
  return new Response(res.body, { status: res.status, headers });
}

/** /v1/app/files and /v1/app/files/{path}. route() has already checked the token (livePublisher) and the rate limit. */
export async function routeAppFiles(a) {
  const rest = appFilesRawPath(a.req);
  const m = a.req.method;
  if (m === "PUT" && rest !== "") return put(a, rest);
  if (m === "DELETE" && rest !== "") return remove(a, rest);
  if (m !== "GET" && m !== "HEAD") throw new HttpError(405, "method_not_allowed", "Method not allowed");
  await assertStillAuthorized(a.db, a.p, { read: true });
  return rest === "" ? list(a) : read(a, rest);
}

const TEXT_TYPES = new Map([["text/markdown", "markdown"], ["text/html", "html"], ["application/json", "json"], ["text/csv", "csv"]]);
const ALLOWED_TYPES = [...TEXT_TYPES.keys(), ...Object.keys(BINARY_TYPES)];
const unsupportedType = () => new HttpError(415, "unsupported_type", "Allowed: " + ALLOWED_TYPES.join(", "));
const trashedErr = (path, id) => new HttpError(409, "destination_file_trashed", "The owner moved this app's file to trash; ask the owner to restore it", { name: path, file_id: id });
const exists = () => new HttpError(412, "precondition_failed", "A file already exists at this path");
const missing = () => new HttpError(412, "precondition_failed", "No file exists at this path");
const stale = (row) => new HttpError(412, "precondition_failed", "If-Match does not match the file's current version", { current_revision: row.head_rev, current_etag: `"${row.sha256}"` });

/** Content-Type of a create or replace: exactly the path's type (text: charset only utf-8; binaries: no parameters). */
function contentType(req, parsed) {
  const [type, ...params] = (req.headers.get("content-type") ?? "").split(";").map((x) => x.trim().toLowerCase());
  if (!TEXT_TYPES.has(type) && !Object.hasOwn(BINARY_TYPES, type)) throw unsupportedType();
  for (const param of params) {
    const [k, v] = param.split("=").map((x) => x?.trim());
    if (parsed.kind === "binary" || k !== "charset" || v?.replace(/^"|"$/g, "") !== "utf-8") throw unsupportedType();
  }
  if (type !== parsed.mime) throw new HttpError(415, "unsupported_type", `Content-Type does not match the file extension (expected ${parsed.mime})`, { expected: parsed.mime });
}
/** If-Match "<sha256>" (replace, delete) or If-None-Match: * (create, only when `allowCreate`). Returns { create, etag?, cond }. */
function parsePrecondition(req, allowCreate) {
  const im = req.headers.get("if-match"), inm = req.headers.get("if-none-match");
  const what = allowCreate ? "PUT needs If-Match (a quoted SHA-256 ETag) or If-None-Match: * to create" : "DELETE needs If-Match (a quoted SHA-256 ETag)";
  if (im === null && inm === null) throw new HttpError(428, "precondition_required", what);
  const bad = () => new HttpError(400, "invalid_input", allowCreate ? "If-Match must be one quoted SHA-256 ETag; If-None-Match must be *; not both" : "If-Match must be one quoted SHA-256 ETag");
  if (im !== null && inm !== null) throw bad();
  if (inm !== null) { if (!allowCreate || inm.trim() !== "*") throw bad(); return { create: true, cond: "*" }; }
  // A W/ prefix is accepted: an edge that compressed a read may have weakened the ETag the app received. The tag is
  // the content's SHA-256 either way, and the match below is on those bytes.
  const m = /^(?:W\/)?"([0-9a-f]{64})"$/.exec(im.trim());
  if (!m) throw bad();
  return { create: false, etag: m[1], cond: im.trim().replace(/^W\//, "") };
}
const fileView = (path, id, kind, mime, revision, sha256, size, folder) => ({ path, file_id: id, kind, mime, revision, etag: `"${sha256}"`, sha256, size, folder });
/** A stored or fresh answer as App Files sends it (publishRevision stores its own shape; map it). */
function answer(res, view) {
  const b = res.body;
  const body = b.file ? b : { file: view(b), ...b.idempotent_replay ? { idempotent_replay: true } : {} };
  return json(body, res.status, { etag: body.file.etag });
}

/** Read exactly `declared` bytes (already known to be within the limit); a body that differs in length is refused. */
async function readBody(req, declared) {
  const incomplete = () => new HttpError(400, "incomplete_body", "Body does not match Content-Length; PUT the whole file again");
  const reader = req.body?.getReader();
  const chunks = [];
  let n = 0;
  if (reader) for (;;) {
    const r = await reader.read().catch(() => { throw incomplete(); });
    if (r.done) break;
    n += r.value.byteLength;
    if (n > declared) { reader.cancel().catch(() => {}); throw incomplete(); }
    chunks.push(r.value);
  }
  if (n !== declared) throw incomplete();
  const bytes = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { bytes.set(c, o); o += c.byteLength; }
  return bytes;
}

/**
 * The folder a file at `parsed` lives in: the destination itself, or the subfolders of its path below it (created
 * now, marked as this app's, fenced on the app still being live). Returns { id, path } (id null = project root).
 */
async function folderFor(ctx, p, parsed, create) {
  const base = p.folder_id ? await ctx.env.DB.prepare("SELECT * FROM folders WHERE id = ? AND project_id = ?").bind(p.folder_id, p.project_id).first() : null;
  if (p.folder_id && !base) throw new HttpError(403, "scope_mismatch", "Publisher destination unavailable or changed");
  if (!parsed.folders.length) return { id: base?.id ?? null, path: fdPathOf(base) };
  if (!create) return null;
  try {
    const f = await fdEnsure(ctx, p.project_id, parsed.folders, { base, publisherId: p.id, fence: { sql: BASE_SQL, params: baseParams(p) } });
    return { id: f.id, path: fdPathOf(f) };
  } catch (e) {
    if (e instanceof HttpError && (e.status === 400 || e.status === 413)) throw new HttpError(400, "invalid_path", `This path's folders would not fit under the destination: ${e.message}`);
    throw e;
  }
}

/** The SHA-256 a binary PUT declares (X-Content-SHA256, 64 lowercase hex), checked by R2 as the bytes are stored. */
function declaredSha(req) {
  const v = req.headers.get("x-content-sha256");
  if (v === null) throw new HttpError(428, "precondition_required", "A binary PUT needs X-Content-SHA256 (the body's SHA-256, 64 lowercase hex)");
  if (!/^[0-9a-f]{64}$/.test(v.trim())) throw new HttpError(400, "invalid_input", "X-Content-SHA256 must be 64 lowercase hex characters");
  return v.trim();
}

/**
 * PUT: create (If-None-Match: *) or replace (If-Match: "<sha256>") one file. Nothing is read before the headers pass.
 * Text is read into memory (1 MiB) and validated; a binary streams straight to storage (R2 checks length and the
 * declared SHA-256) and its first bytes must carry the type's signature.
 */
async function put({ req, env, db, p, requestId }, rest) {
  await assertStillAuthorized(db, p);
  const parsed = parseAppPath(rest);
  const { path, kind } = parsed;
  contentType(req, parsed);
  const key = idemKey(req.headers.get("idempotency-key"));
  const pre = parsePrecondition(req, true);
  const cl = req.headers.get("content-length");
  if (cl === null) throw new HttpError(411, "length_required", "Content-Length is required");
  if (!/^\d+$/.test(cl)) throw new HttpError(400, "invalid_input", "Content-Length must be a non-negative integer");
  const declared = Number(cl);
  const ctx = pubCtx(env, p, requestId);
  if (kind !== "binary") {
    if (req.headers.get("x-content-sha256") !== null) throw new HttpError(400, "invalid_input", "X-Content-SHA256 is for binary files only");
    if (declared > APP_FILE_MAX_BYTES) throw tooLargeText();
    return putText({ req, env, db, p, ctx, key, pre, parsed, declared });
  }
  const sha = declaredSha(req);
  if (declared === 0) throw new HttpError(422, "signature_mismatch", `An empty body is not a valid ${parsed.mime}`);
  const lg = await projectLimitGuard(env, p.project_id, { storage_bytes: declared });
  if (declared > lg.limits.file_bytes) throw fileTooLarge(lg.limits.file_bytes);
  // Storage is checked before any byte is read (and again inside the publish statement).
  if (lg.workspaceId && !(await db.prepare(`SELECT ${lg.sql} AS ok`).bind(...lg.params).first("ok"))) {
    await explainLimit(env, lg.workspaceId, { storage_bytes: declared }, lg.limits, p.project_id);
    throw new HttpError(402, "limit_reached", "This workspace has reached its storage limit");
  }
  return putBinary({ req, env, db, p, ctx, key, pre, parsed, declared, sha });
}

/** The row and precondition checks shared by text and binary PUT. Returns the row to replace, or null to create. */
async function rowChecks(db, p, path, pre) {
  const row = await db.prepare(`SELECT a.id, a.kind, a.head_rev, a.trashed_at, a.folder_id, r.sha256, r.size, r.mime FROM artifacts a
    LEFT JOIN revisions r ON r.id = a.head_revision_id
    WHERE a.publisher_id = ? AND a.project_id = ? AND a.export_name = ? AND a.head_rev > 0`).bind(...ownParams(p), path).first();
  if (row?.trashed_at) throw trashedErr(path, row.id);
  if (pre.create) {
    if (row) throw exists();
    return null;
  }
  if (!row) throw missing();
  if (pre.etag !== row.sha256) throw stale(row);
  return row;
}
/** The fence of a replace: the publisher is still live and the row is still the one checked. */
const rowFence = (p, cur, path) => ({ sql: `${BASE_SQL} AND EXISTS (SELECT 1 FROM artifacts WHERE id = ? AND publisher_id = ? AND project_id = ? AND export_name = ? AND trashed_at IS NULL)`,
  params: [...baseParams(p), cur.id, ...ownParams(p), path] });
const folderOf = (row) => row?.folder_id ? { id: row.folder_id } : null;
const folderView = (f) => f?.id ? { id: f.id, path: f.path } : null;
/**
 * A replace also files the app's file into its path's folder (files written before paths became folders sit in the
 * destination itself). Gated on the new revision, like every extra statement of publishRevision.
 */
function refileStatement(db, cur, folder, revId) {
  return db.prepare("UPDATE artifacts SET folder_id = ?, folder = ? WHERE id = ? AND folder_id IS NOT ? AND EXISTS (SELECT 1 FROM revisions WHERE id = ?)")
    .bind(folder.id, folder.path, cur.id, folder.id, revId);
}

async function putText({ req, env, db, p, ctx, key, pre, parsed, declared }) {
  const { path, kind, mime } = parsed;
  const bytes = await readBody(req, declared);
  const sha256 = await sha256Hex(bytes);
  const op = "app.put";
  const idem = { op, key, projectId: p.project_id, digest: await sha256Hex(JSON.stringify([op, path, pre.cond, kind, sha256])) };
  const prior = await idemLookup(ctx, idem);
  if (prior) return answer(prior, (b) => fileView(path, b.artifact_id, kind, mime, b.revision, b.sha256, bytes.byteLength, null));
  const cur = await rowChecks(db, p, path, pre);
  if (cur && cur.sha256 === sha256)
    return json({ file: fileView(path, cur.id, cur.kind, cur.mime, cur.head_rev, cur.sha256, cur.size, folderOf(cur)), unchanged: true }, 200, { etag: `"${cur.sha256}"` });

  let text;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new HttpError(422, "invalid_content", `Invalid ${kind}: bytes are not valid UTF-8`, { format: kind, detail: "bytes are not valid UTF-8" }); }
  if (kind === "markdown" || kind === "html") mdBody(text, kind);
  else checkFile(kind, text, null, path);
  await testPause(env, req);

  const fence = { sql: BASE_SQL, params: baseParams(p) };
  try {
    if (!cur) {
      const folder = await folderFor(ctx, p, parsed, true);
      const res = await createMarkdown(ctx, p.project_id,
        { title: parsed.name, folder_id: folder.id, [kind === "markdown" || kind === "html" ? "body" : "content"]: text, schema: null }, key, kind,
        { publisherId: p.id, exportName: path, idem, revId: randomId("rev"), extra: [], fence,
          body: (x) => ({ file: fileView(path, x.artId, kind, mime, 1, x.sha256, x.size, folder.id ? { id: folder.id, path: folder.path } : null) }) });
      return answer(res, (b) => fileView(path, b.artifact_id, kind, mime, b.revision, b.sha256, bytes.byteLength, null));
    }
    const folder = await folderFor(ctx, p, parsed, true);
    const revId = randomId("rev");
    const res = await publishRevision(ctx, p.project_id, cur.id, cur.head_rev, idem,
      { revId, body: text, size: bytes.byteLength, sha256, mime, fence: rowFence(p, cur, path) }, [refileStatement(db, cur, folder, revId)]);
    return answer(res, (b) => fileView(path, b.artifact_id, kind, mime, b.revision, b.sha256, bytes.byteLength, folderView(folder)));
  } catch (e) {
    if (!(e instanceof HttpError) || [400, 402, 413, 422, 500, 503].includes(e.status)) throw e;
    // A refused publish: an authorization change answers first, then the row as it is now (another writer won).
    await assertStillAuthorized(db, p);
    await rowChecks(db, p, path, pre);
    throw e.status === 409 ? e : new HttpError(409, "conflict", "Concurrent modification");
  }
}

/**
 * A stream that passes `body` through unchanged and keeps its first 16 bytes (the type signature). Length is R2's
 * check (FixedLengthStream refuses any other length; writeUploadBlob classifies it).
 */
function signatureTap(body) {
  const head = new Uint8Array(16);
  let seen = 0;
  const stream = body.pipeThrough(new TransformStream({
    transform(chunk, out) {
      if (seen < head.length) head.set(chunk.subarray(0, head.length - seen), seen);
      seen += chunk.byteLength;
      out.enqueue(chunk);
    }
  }));
  return { stream, head: () => head.subarray(0, Math.min(seen, head.length)) };
}

async function putBinary({ req, env, db, p, ctx, key, pre, parsed, declared, sha }) {
  const { path, mime } = parsed;
  const op = "app.put";
  // The declared SHA-256 is part of the request: a same-key retry with the same bytes replays before any byte is read.
  const idem = { op, key, projectId: p.project_id, digest: await sha256Hex(JSON.stringify([op, path, pre.cond, "binary", mime, sha, declared])) };
  const view = (folder) => (b) => fileView(path, b.artifact_id, "binary", mime, b.revision, b.sha256, b.size ?? declared, folder);
  const prior = await idemLookup(ctx, idem);
  if (prior) return answer(prior, view(null));
  const cur = await rowChecks(db, p, path, pre);
  if (cur && cur.sha256 === sha && cur.size === declared)
    return json({ file: fileView(path, cur.id, cur.kind, cur.mime, cur.head_rev, cur.sha256, cur.size, folderOf(cur)), unchanged: true }, 200, { etag: `"${cur.sha256}"` });
  if (cur && cur.kind !== "binary") throw new HttpError(409, "conflict", "A text file exists at this path");
  if (!req.body) throw new HttpError(400, "incomplete_body", "Body does not match Content-Length; PUT the whole file again");

  const artId = cur?.id ?? randomId("art");
  const revId = randomId("rev");
  const blobKey = blobPrefix(p.project_id, artId) + revId;
  // Intent first: a request that dies after this leaves the object for the sweep (cleanup.js sweepContentWrites).
  if (!(await stageBlobWrite(env, p.project_id, blobKey)))
    throw new HttpError(429, "rate_limited", "Too many file writes in progress in this project; retry shortly", { retry_after_seconds: 5 });
  let stored, replaceFolder = null;
  const tap = signatureTap(req.body);
  try {
    stored = await writeUploadBlob(env, { key: blobKey, body: tap.stream, size: declared, sha256: sha, contentType: mime });
  } catch (e) {
    await dropBlobWrite(env, blobKey);
    if (e instanceof HttpError) throw e;
    const k = isBlobWriteError(e);
    if (k === "digest") throw new HttpError(422, "integrity_mismatch", "The body's SHA-256 does not match X-Content-SHA256");
    if (k === "too_long" || k === "too_short") throw new HttpError(400, "incomplete_body", "Body does not match Content-Length; PUT the whole file again");
    throw e;
  }
  const published = await (async () => {
    if (stored.sha256 !== sha || stored.size !== declared) throw new HttpError(422, "integrity_mismatch", "The stored bytes do not match the declared size and SHA-256");
    if (!BINARY_TYPES[mime](tap.head())) throw new HttpError(422, "signature_mismatch", `Bytes are not a valid ${mime}`, { expected: mime });
    await testPause(env, req);
    const wf = blobWriteFence(blobKey);
    if (cur) {
      // A new version of the app's own file: fenced on the live publisher, the row as checked and the intent.
      const fence = rowFence(p, cur, path);
      replaceFolder = await folderFor(ctx, p, parsed, true);
      return publishRevision(ctx, p.project_id, cur.id, cur.head_rev, idem,
        { revId, blobKey, size: declared, sha256: sha, mime, chargeBlob: true, fence: { sql: `${fence.sql} AND ${wf.sql}`, params: [...fence.params, ...wf.params] } },
        [refileStatement(db, cur, replaceFolder, revId), textWriteComplete(env, blobKey)]);
    }
    return createBinary(ctx, p, parsed, { artId, revId, blobKey, size: declared, sha256: sha, idem, wf });
  })().catch(async (e) => {
    // Only a definite refusal drops the object; an unknown failure (a lost acknowledgement may hide a commit) is left
    // to the sweep, which deletes it only if no revision references it.
    if (!(e instanceof HttpError)) throw e;
    await dropBlobWrite(env, blobKey);
    if ([400, 402, 413, 422, 500, 503].includes(e.status)) throw e;
    const replay = await idemLookup(ctx, idem);
    if (replay) return replay;
    await assertStillAuthorized(db, p);
    await rowChecks(db, p, path, pre);
    throw e.status === 409 ? e : new HttpError(409, "conflict", "Concurrent modification");
  });
  return answer(published, view(folderView(replaceFolder)));
}

/** A new binary file of the app: its folder (created as needed), artifact and first revision in one fenced batch. */
async function createBinary(ctx, p, parsed, { artId, revId, blobKey, size, sha256, idem, wf }) {
  const { path, mime } = parsed;
  const folder = await folderFor(ctx, p, parsed, true);
  const adds = { storage_bytes: size };
  const lg = await projectLimitGuard(ctx.env, p.project_id, adds);
  const az0 = authzSql(ctx, p.project_id);
  const az = { sql: `${az0.sql} AND ${lg.sql} AND ${BASE_SQL} AND ${wf.sql}`, params: [...az0.params, ...lg.params, ...baseParams(p), ...wf.params] };
  const now = nowIso();
  const body = { file: fileView(path, artId, "binary", mime, 1, sha256, size, folder.id ? { id: folder.id, path: folder.path } : null) };
  const db = ctx.env.DB;
  const created = "EXISTS (SELECT 1 FROM artifacts WHERE id = ?)";
  const out = await runBatch(ctx, [
    idemInsert(ctx, idem, 201, body, az.sql, az.params),
    db.prepare(`INSERT INTO artifacts (id, project_id, kind, title, folder, folder_id, schema_id, publisher_id, export_name, head_rev, head_revision_id, created_at, updated_at)
      SELECT ?, ?, 'binary', ?, ?, ?, NULL, ?, ?, 1, ?, ?, ? WHERE ${az.sql}
        AND (? IS NULL OR EXISTS (SELECT 1 FROM folders WHERE id = ? AND project_id = ?))`)
      .bind(artId, p.project_id, parsed.name, folder.path, folder.id, p.id, path, revId, now, now, ...az.params, folder.id, folder.id, p.project_id),
    db.prepare(`INSERT INTO revisions (id, artifact_id, project_id, rev_no, author_id, body, body_key, blob_key, size, sha256, mime, created_at, via_kind, via_id, via_label, client_info, change_note)
      SELECT ?, ?, ?, 1, ?, NULL, NULL, ?, ?, ?, ?, ?, 'publisher', ?, ?, NULL, NULL WHERE ${created}`)
      .bind(revId, artId, p.project_id, ctx.principal.id, blobKey, size, sha256, mime, now, p.id, p.display_name, artId),
    audit(ctx, p.project_id, "artifact.create", artId, 1, "ok", created, [artId]),
    // A file is indexed by its title only.
    ...indexDocument(db, { artifactId: artId, revisionId: revId, sha256, text: "" }),
    textWriteComplete(ctx.env, blobKey)
  ], idem);
  if (!Array.isArray(out)) return out;
  if (!out[1].meta.changes) {
    if (lg.workspaceId) await explainLimit(ctx.env, lg.workspaceId, adds, lg.limits, p.project_id);
    throw new HttpError(403, "forbidden", "Grant no longer valid");
  }
  return { status: 201, body };
}

/** DELETE: move the file to the owner's trash. It keeps publisher_id (still the app's file), loses export_name (the path is free again). */
async function remove({ req, env, db, p, requestId }, rest) {
  await assertStillAuthorized(db, p);
  const { path } = parseAppPath(rest);
  const key = idemKey(req.headers.get("idempotency-key"));
  const pre = parsePrecondition(req, false);
  const ctx = pubCtx(env, p, requestId);
  const i = { op: "app.delete", key, projectId: p.project_id, digest: await sha256Hex(JSON.stringify(["app.delete", path, pre.cond])) };
  const prior = await idemLookup(ctx, i);
  if (prior) return json(prior.body, prior.status);
  // A same-key request that committed meanwhile wins over a state refusal.
  const refuse = async (err) => {
    const again = await idemLookup(ctx, i);
    if (again) return json(again.body, again.status);
    throw err;
  };
  const load = () => db.prepare(`SELECT a.*, r.sha256 FROM artifacts a LEFT JOIN revisions r ON r.id = a.head_revision_id
    WHERE a.publisher_id = ? AND a.project_id = ? AND a.export_name = ? AND a.head_rev > 0`).bind(...ownParams(p), path).first();
  const check = (row) => {
    if (!row) return missing();
    if (row.trashed_at) return trashedErr(path, row.id);
    if (pre.etag !== row.sha256) return stale(row);
    return null;
  };
  const a = await load();
  const bad = check(a);
  if (bad) return refuse(bad);
  await testPause(env, req);
  const az = authzSql(ctx, p.project_id);
  const next = a.meta_version + 1;
  const now = nowIso();
  const gate = "EXISTS (SELECT 1 FROM artifacts WHERE id = ? AND meta_version = ? AND meta_request_id = ?)";
  const gp = [a.id, next, requestId];
  const body = { file: { path, file_id: a.id, trashed: true, revision: a.head_rev } };
  const out = await runBatch(ctx, [
    db.prepare(`UPDATE artifacts SET trashed_at = ?, export_name = NULL, meta_version = ?, meta_request_id = ?, updated_at = ?
      WHERE id = ? AND publisher_id = ? AND project_id = ? AND export_name = ? AND trashed_at IS NULL
        AND head_rev = ? AND meta_version = ? AND ${BASE_SQL} AND ${az.sql}`)
      .bind(now, next, requestId, now, a.id, ...ownParams(p), path, a.head_rev, a.meta_version, ...baseParams(p), ...az.params),
    metaBaselineInsert(ctx, a, gate, gp),
    metaVersionInsert(ctx, a, next, { title: a.title, folder: a.folder, tags: a.tags, trashed: true, description: a.template_description, restoredFrom: null }, {}, gate, gp),
    idemInsert(ctx, i, 200, body, gate, gp),
    audit(ctx, p.project_id, "artifact.trash", a.id, null, "ok", gate, gp),
    ...unindexDocument(db, a.id)
  ], i);
  if (!Array.isArray(out)) return json(out.body, out.status);
  if (!out[0].meta.changes) {
    // Authorization first, then the row as it is now.
    await assertStillAuthorized(db, p);
    return refuse(check(await load()) ?? new HttpError(409, "conflict", "Concurrent modification"));
  }
  return json(body, 200);
}
