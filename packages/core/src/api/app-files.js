// App Files API (/v1/app/files): an app's own text files, addressed by path, in its approved destination.
// A file's path is artifacts.export_name (unique per publisher). Every request re-checks the publisher's current
// authorization (assertStillAuthorized, and the baseSql fence inside every write). Handlers take a database handle
// (`db`) for their own queries; nothing here keeps state between requests or looks across workspaces.
import { authzSql } from "../auth.js";
import { MIME, checkFile } from "../formats.js";
import { audit, createMarkdown, idemInsert, idemLookup, mdBody, publishRevision, runBatch, servedContentType } from "../service.js";
import { metaBaselineInsert, metaVersionInsert } from "../history/service.js";
import { unindexDocument } from "../search/indexing.js";
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
/** A file sent to App Files: at most 1 MiB, declared by Content-Length and refused before any byte is read. */
export const APP_FILE_MAX_BYTES = 1048576;

const ROOT = "/v1/app/files";
const SEGMENT = /^[a-z0-9_-][a-z0-9._-]*$/;
const KIND_BY_EXT = new Map([["md", "markdown"], ["html", "html"], ["json", "json"], ["csv", "csv"]]);
const EXTENSION = /\.(md|html|json|csv)$/;
const invalidPath = () => new HttpError(400, "invalid_path", "File path must be 1-8 segments of lowercase letters, digits, '.', '_' or '-' (not starting with '.'), at most 200 characters; the last segment ends in .md, .html, .json or .csv and no other segment does");
const tooLarge = () => new HttpError(413, "file_too_large", "A file sent to this API can be at most 1 MiB (1,048,576 bytes)");

/**
 * Headers every App Files content answer carries, 304 included. A copy of serveContent's fixed set
 * (uploads.js, the non-spreadsheet branch); test/app-files.test.mjs checks a 304 and a 200 agree.
 */
export const APP_FILE_RESPONSE_HEADERS = Object.freeze({
  "x-content-type-options": "nosniff",
  "cache-control": "private, no-store",
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

/** Validate an App Files path; returns { path, kind }. Lowercase and extension rules make every path unique by name alone. */
export function parseAppPath(rest) {
  if (typeof rest !== "string" || rest.length > APP_PATH_MAX_CHARS) throw invalidPath();
  const segments = rest.split("/");
  if (segments.length > APP_PATH_MAX_SEGMENTS || !segments.every((s) => SEGMENT.test(s))) throw invalidPath();
  const ext = EXTENSION.exec(segments.at(-1))?.[1];
  if (!ext || segments.slice(0, -1).some((s) => EXTENSION.test(s))) throw invalidPath();
  return { path: rest, kind: KIND_BY_EXT.get(ext) };
}

/** Every artifact lookup is confined to this publisher's live files in its destination. */
const OWN = "a.publisher_id = ? AND a.project_id = ? AND a.folder_id IS ? AND a.export_name IS NOT NULL AND a.head_rev > 0 AND a.trashed_at IS NULL";
const ownParams = (p) => [p.id, p.project_id, p.folder_id ?? null];

function fileItem(env, a) {
  const o = appOrigin(env.APP_HOST);
  return {
    path: a.export_name,
    file_id: a.id,
    kind: a.kind,
    content_type: servedContentType(a.mime),
    revision: a.head_rev,
    etag: `"${a.sha256}"`,
    sha256: a.sha256,
    size: a.size,
    created_at: a.created_at,
    updated_at: a.updated_at,
    ...o ? { web_url: artifactWebUrl(o, a.project_id, a.id), preview_url: previewWebUrl(o, a.project_id, a.id) } : {}
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
export const LIST_SQL = `SELECT a.id, a.project_id, a.export_name, a.kind, a.head_rev, a.created_at, a.updated_at, r.sha256, r.size, r.mime
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
  // Only Range reaches serveContent: format, download and rev never apply here.
  const range = req.headers.get("range");
  const clean = new Request(new URL(req.url).origin + "/content", { method: req.method, headers: range === null ? {} : { range } });
  return serveContent(pubCtx(env, p, requestId), clean, p.project_id, a.id, null);
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
const unsupportedType = () => new HttpError(415, "unsupported_type", "Allowed: " + [...TEXT_TYPES.keys()].join(", "));
const trashedErr = (path, id) => new HttpError(409, "destination_file_trashed", "The owner moved this app's file to trash; ask the owner to restore it", { name: path, file_id: id });
const exists = () => new HttpError(412, "precondition_failed", "A file already exists at this path");
const missing = () => new HttpError(412, "precondition_failed", "No file exists at this path");
const stale = (row) => new HttpError(412, "precondition_failed", "If-Match does not match the file's current version", { current_revision: row.head_rev, current_etag: `"${row.sha256}"` });

/** Content-Type of a create or replace: one of the four text types, matching the path's kind; charset only utf-8. */
function contentKind(req, kind) {
  const [type, ...params] = (req.headers.get("content-type") ?? "").split(";").map((x) => x.trim().toLowerCase());
  const t = TEXT_TYPES.get(type);
  if (!t) throw unsupportedType();
  for (const param of params) {
    const [k, v] = param.split("=").map((x) => x?.trim());
    if (k === "charset" && v?.replace(/^"|"$/g, "") !== "utf-8") throw unsupportedType();
  }
  if (t !== kind) throw new HttpError(415, "unsupported_type", "Content-Type does not match the file extension");
}
/** If-Match "<sha256>" (replace, delete) or If-None-Match: * (create, only when `allowCreate`). Returns { create, etag?, cond }. */
function parsePrecondition(req, allowCreate) {
  const im = req.headers.get("if-match"), inm = req.headers.get("if-none-match");
  const what = allowCreate ? "PUT needs If-Match (a quoted SHA-256 ETag) or If-None-Match: * to create" : "DELETE needs If-Match (a quoted SHA-256 ETag)";
  if (im === null && inm === null) throw new HttpError(428, "precondition_required", what);
  const bad = () => new HttpError(400, "invalid_input", allowCreate ? "If-Match must be one quoted SHA-256 ETag; If-None-Match must be *; not both" : "If-Match must be one quoted SHA-256 ETag");
  if (im !== null && inm !== null) throw bad();
  if (inm !== null) { if (!allowCreate || inm.trim() !== "*") throw bad(); return { create: true, cond: "*" }; }
  const m = /^"([0-9a-f]{64})"$/.exec(im.trim());
  if (!m) throw bad();
  return { create: false, etag: m[1], cond: im.trim() };
}
const fileView = (path, id, kind, revision, sha256, size) => ({ path, file_id: id, kind, revision, etag: `"${sha256}"`, sha256, size });
/** A stored or fresh answer as App Files sends it (publishRevision stores its own shape; map it). */
function answer(res, path, kind, size) {
  const b = res.body;
  const body = b.file ? b : { file: fileView(path, b.artifact_id, kind, b.revision, b.sha256, size), ...b.idempotent_replay ? { idempotent_replay: true } : {} };
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

/** PUT: create (If-None-Match: *) or replace (If-Match: "<sha256>") one file. Nothing is read before the headers pass. */
async function put({ req, env, db, p, requestId }, rest) {
  await assertStillAuthorized(db, p);
  const { path, kind } = parseAppPath(rest);
  contentKind(req, kind);
  const key = idemKey(req.headers.get("idempotency-key"));
  const pre = parsePrecondition(req, true);
  const cl = req.headers.get("content-length");
  if (cl === null) throw new HttpError(411, "length_required", "Content-Length is required");
  if (!/^\d+$/.test(cl)) throw new HttpError(400, "invalid_input", "Content-Length must be a non-negative integer");
  const declared = Number(cl);
  if (declared > APP_FILE_MAX_BYTES) throw tooLarge();
  const bytes = await readBody(req, declared);
  const sha256 = await sha256Hex(bytes);
  const ctx = pubCtx(env, p, requestId);
  const op = "app.put";
  const idem = { op, key, projectId: p.project_id, digest: await sha256Hex(JSON.stringify([op, path, pre.cond, kind, sha256])) };

  const prior = await idemLookup(ctx, idem);
  if (prior) return answer(prior, path, kind, bytes.byteLength);
  /** The row and precondition checks. Returns the row to replace, or null to create. */
  const rowChecks = async () => {
    const row = await db.prepare(`SELECT a.id, a.kind, a.head_rev, a.trashed_at, r.sha256, r.size FROM artifacts a
      LEFT JOIN revisions r ON r.id = a.head_revision_id
      WHERE a.publisher_id = ? AND a.project_id = ? AND a.folder_id IS ? AND a.export_name = ? AND a.head_rev > 0`).bind(...ownParams(p), path).first();
    if (row?.trashed_at) throw trashedErr(path, row.id);
    if (pre.create) {
      if (row) throw exists();
      return null;
    }
    if (!row) throw missing();
    if (pre.etag !== row.sha256) throw stale(row);
    return row;
  };
  const cur = await rowChecks();
  if (cur && cur.sha256 === sha256)
    return json({ file: fileView(path, cur.id, cur.kind, cur.head_rev, cur.sha256, cur.size), unchanged: true }, 200, { etag: `"${cur.sha256}"` });

  let text;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new HttpError(422, "invalid_content", `Invalid ${kind}: bytes are not valid UTF-8`, { format: kind, detail: "bytes are not valid UTF-8" }); }
  if (kind === "markdown" || kind === "html") mdBody(text, kind);
  else checkFile(kind, text, null, path);
  await testPause(env, req);

  // Publish, fenced: the publisher is still live and the row (replace) is still the one checked.
  const fence = { sql: BASE_SQL, params: baseParams(p) };
  try {
    if (!cur) {
      const res = await createMarkdown(ctx, p.project_id,
        { title: path, folder: "", folder_id: p.folder_id ?? null, [kind === "markdown" || kind === "html" ? "body" : "content"]: text, schema: null }, key, kind,
        { publisherId: p.id, exportName: path, idem, revId: randomId("rev"), extra: [], fence, body: (x) => ({ file: fileView(path, x.artId, kind, 1, x.sha256, x.size) }) });
      return answer(res, path, kind, bytes.byteLength);
    }
    const rowFence = { sql: `${fence.sql} AND EXISTS (SELECT 1 FROM artifacts WHERE id = ? AND publisher_id = ? AND project_id = ? AND folder_id IS ? AND export_name = ? AND trashed_at IS NULL)`,
      params: [...fence.params, cur.id, ...ownParams(p), path] };
    const res = await publishRevision(ctx, p.project_id, cur.id, cur.head_rev, idem,
      { revId: randomId("rev"), body: text, size: bytes.byteLength, sha256, mime: MIME[kind] ?? (kind === "html" ? "text/html" : "text/markdown"), fence: rowFence });
    return answer(res, path, kind, bytes.byteLength);
  } catch (e) {
    if (!(e instanceof HttpError) || [402, 413, 422, 500, 503].includes(e.status)) throw e;
    // A refused publish: an authorization change answers first, then the row as it is now (another writer won).
    await assertStillAuthorized(db, p);
    await rowChecks();
    throw e.status === 409 ? e : new HttpError(409, "conflict", "Concurrent modification");
  }
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
    WHERE a.publisher_id = ? AND a.project_id = ? AND a.folder_id IS ? AND a.export_name = ? AND a.head_rev > 0`).bind(...ownParams(p), path).first();
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
      WHERE id = ? AND publisher_id = ? AND project_id = ? AND folder_id IS ? AND export_name = ? AND trashed_at IS NULL
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
