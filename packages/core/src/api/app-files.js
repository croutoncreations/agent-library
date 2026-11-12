// App Files API (/v1/app/files): an app's own text files, addressed by path, in its approved destination.
// A file's path is artifacts.export_name (unique per publisher); generation rows and the snapshot manifest are
// invisible here. Every request re-checks the publisher's current authorization (assertStillAuthorized).
import { CONTENT_TYPE } from "../formats.js";
import { appOrigin, artifactWebUrl, previewWebUrl } from "../links.js";
import { clientLiveSql } from "../oauth/server.js";
import { serveContent } from "../uploads.js";
import { HttpError, b64url, int, json } from "../util.js";
import { assertStillAuthorized, pubCtx } from "./publisher.js";

/**
 * SQL fence: the publisher is live and its destination is still valid. write: also require an enabled app client
 * (DISABLED_CLIENT_BLOCKS). Params, in order: publisher id, token epoch, project id, folder id (or null).
 */
export function baseSql(write) {
  return `EXISTS (SELECT 1 FROM publishers pb JOIN app_clients ac ON ac.id = pb.app_client_id
  WHERE pb.id = ? AND pb.token_epoch = ? AND pb.revoked_at IS NULL AND ${clientLiveSql(write)}
    AND pb.project_id = ? AND pb.folder_id IS ?
    AND (pb.folder_id IS NULL OR EXISTS (SELECT 1 FROM folders f WHERE f.id = pb.folder_id AND f.project_id = pb.project_id)))`;
}
/** Params for baseSql, for the publisher row `p`. */
export const baseParams = (p) => [p.id, p.token_epoch, p.project_id, p.folder_id ?? null];

export const APP_PATH_MAX_CHARS = 200;
export const APP_PATH_MAX_SEGMENTS = 8;
export const APP_PATH_SEGMENT_MAX_CHARS = 64;
export const APP_FILES_PAGE_MAX = 100;
const ROOT = "/v1/app/files";
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/;
const KIND_BY_EXT = { md: "markdown", markdown: "markdown", html: "html", htm: "html", json: "json", csv: "csv" };
const MANIFEST = "manifest.json";
const invalidPath = () => new HttpError(400, "invalid_path", "File path must be 1-8 segments of letters, digits, '.', '_' or '-' (1-64 characters each, not starting with '.'), at most 200 characters, ending in .md, .markdown, .html, .htm, .json or .csv");
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

/** Validate an App Files path; returns { path, kind }. */
export function parseAppPath(rest) {
  if (typeof rest !== "string" || rest.includes("%") || rest.length > APP_PATH_MAX_CHARS) throw invalidPath();
  const segments = rest.split("/");
  if (segments.length < 1 || segments.length > APP_PATH_MAX_SEGMENTS || !segments.every((s) => SEGMENT.test(s))) throw invalidPath();
  const ext = /\.([A-Za-z]+)$/.exec(segments.at(-1))?.[1]?.toLowerCase();
  const kind = ext ? KIND_BY_EXT[ext] : void 0;
  if (!kind) throw invalidPath();
  return { path: rest, kind };
}

/** Every artifact lookup is confined to this publisher's files in its destination, excluding generation rows. */
const OWN = "a.publisher_id = ? AND a.project_id = ? AND a.folder_id IS ? AND a.generation_id IS NULL AND a.export_name IS NOT NULL AND a.head_rev > 0 AND a.trashed_at IS NULL";
const ownParams = (p) => [p.id, p.project_id, p.folder_id ?? null];

function fileItem(env, a) {
  const o = appOrigin(env.APP_HOST);
  return {
    path: a.export_name,
    file_id: a.id,
    kind: a.kind,
    content_type: CONTENT_TYPE[a.mime] ?? a.mime,
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
  if (!/^[A-Za-z0-9._/-]{0,200}$/.test(prefix)) throw new HttpError(400, "invalid_input", "prefix must be at most 200 characters of letters, digits, '.', '_', '-' or '/'");
  let after = "";
  const cursor = sp.get("cursor");
  if (cursor !== null) {
    const bad = () => new HttpError(400, "invalid_input", "cursor is not valid");
    if (!/^[A-Za-z0-9_-]{1,268}$/.test(cursor)) throw bad();
    try { after = atob(cursor.replace(/-/g, "+").replace(/_/g, "/")); } catch { throw bad(); }
    if (!/^[A-Za-z0-9._/-]{1,200}$/.test(after)) throw bad();
  }
  const limit = sp.get("limit") === null ? APP_FILES_PAGE_MAX : int(Number(sp.get("limit")), "limit", 1, APP_FILES_PAGE_MAX);
  return { prefix, after, limit };
}

async function list(env, p, url) {
  const { prefix, after, limit } = listParams(url);
  // Keyset pagination on (publisher_id, export_name); '~' sorts after every character a path may contain.
  const rows = (await env.DB.prepare(`SELECT a.id, a.project_id, a.export_name, a.kind, a.head_rev, a.created_at, a.updated_at, r.sha256, r.size, r.mime
    FROM artifacts a JOIN revisions r ON r.id = a.head_revision_id
    WHERE ${OWN} AND a.export_name <> '${MANIFEST}' AND a.export_name >= ? AND a.export_name < ? AND a.export_name > ?
    ORDER BY a.export_name LIMIT ?`).bind(...ownParams(p), prefix, prefix + "~", after, limit + 1).all()).results;
  const page = rows.slice(0, limit);
  const next = rows.length > limit ? b64url(new TextEncoder().encode(page.at(-1).export_name)) : null;
  return json({ files: page.map((a) => fileItem(env, a)), next_cursor: next });
}

const etagMatches = (header, etag) => header !== null && header.split(",").some((t) => t.trim() === etag);

async function read(req, env, p, requestId, rest) {
  const { path } = parseAppPath(rest);
  if (path === MANIFEST) throw new HttpError(404, "not_found", "File not found");
  const a = await env.DB.prepare(`SELECT a.id, r.sha256 FROM artifacts a JOIN revisions r ON r.id = a.head_revision_id WHERE ${OWN} AND a.export_name = ?`)
    .bind(...ownParams(p), path).first();
  if (!a) throw new HttpError(404, "not_found", "File not found");
  const etag = `"${a.sha256}"`;
  if (etagMatches(req.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers: { ...APP_FILE_RESPONSE_HEADERS, etag } });
  // Only Range reaches serveContent: format, download and rev never apply here.
  const range = req.headers.get("range");
  const clean = new Request(new URL(req.url).origin + "/content", { method: req.method, headers: range === null ? {} : { range } });
  return serveContent(pubCtx(env, p, requestId), clean, p.project_id, a.id, null);
}

/**
 * /v1/app/files and /v1/app/files/{path}. route() has already checked the token (livePublisher) and the rate limit;
 * execCtx (the request's execution context) and wsId (the project's workspace) are for the write routes.
 */
export async function routeAppFiles(req, env, execCtx, p, requestId, wsId) {
  const rest = appFilesRawPath(req);
  const m = req.method;
  if (m !== "GET" && m !== "HEAD") throw new HttpError(405, "method_not_allowed", "Method not allowed");
  await assertStillAuthorized(env, p, { read: true });
  return rest === "" ? list(env, p, new URL(req.url)) : read(req, env, p, requestId, rest);
}
