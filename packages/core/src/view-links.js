// The user-content host (CONTENT_HOST; docs/architecture.md#user-content-host). Rendered HTML pages and PDFs opened in
// the browser are served there, on a separate site with no cookies, instead of on the app's origin. The app host
// answers a navigation to /render or to a PDF's ?open=1 with a redirect to a short-lived link for that one revision.
import { enforceRate, limitsFor, rateLimit } from "./auth.js";
import { RENDER_CSP, htmlRefs, renderHtmlDocument } from "./html.js";
import { originFor } from "./oauth/server.js";
import { IMAGE_TYPES, VIDEO_TYPES } from "./service.js";
import { getRenderSource } from "./render-source.js";
import { serveContent } from "./uploads.js";
import { HttpError, nowIso, nowMs, randomId, sha256Hex } from "./util.js";

// A link works for whoever holds it until it expires (like a signed URL), so it is short: a page frame asks for a new
// one each time it opens; a PDF tab keeps its link for the viewer's range requests.
export const VIEW_LINK_TTL_MS = { render: 5 * 60e3, file: 30 * 60e3 };
const LINK = /^\/c\/(vl_[A-Za-z0-9_-]{20,64})(?:\/m\/(art_[A-Za-z0-9_-]{1,64}))?$/;

// Off unless set to its own host (the same host as the app or agents would give no isolation).
const contentHost = (env) => { const c = env.CONTENT_HOST?.toLowerCase(); return c && c !== env.APP_HOST?.toLowerCase() && c !== env.MCP_HOST?.toLowerCase() ? c : null; };
export const contentOrigin = (env) => contentHost(env) ? originFor(contentHost(env)) : null;
export const isContentHost = (env, host) => !!contentHost(env) && host === contentHost(env);
const appOrigin = (env) => env.APP_HOST ? originFor(env.APP_HOST) : "'none'";

/** Image and video files of this project referenced by a document, mapped to the URL that serves them. */
export async function projectMedia(env, pid, refs, urlFor) {
  const ok = new Map();
  if (refs.length) {
    const types = [...IMAGE_TYPES, ...VIDEO_TYPES];
    const q = await env.DB.prepare(
      `SELECT a.id, v.mime FROM artifacts a JOIN revisions v ON v.id = a.head_revision_id
       WHERE a.project_id = ? AND a.trashed_at IS NULL AND v.mime IN (${types.map(() => "?").join(",")}) AND a.id IN (${refs.map(() => "?").join(",")})`
    ).bind(pid, ...types, ...refs).all();
    for (const row of q.results) ok.set(row.id, row.mime);
  }
  return (ref) => { const mime = ok.get(ref); return mime ? { url: urlFor(ref), mime } : null; };
}

/**
 * True when this request is a browser navigation (an iframe or a tab) by a signed-in person and a content host is
 * configured. fetch() calls (the offline copy) and agents keep the app-host response. Browsers that don't send
 * Sec-Fetch-Dest keep today's sandboxed app-host rendering.
 */
export function wantsContentHost(env, req, ctx) {
  if (!contentHost(env) || ctx.principal.kind !== "human" || !ctx.sessionHash) return false;
  return ["iframe", "frame", "document"].includes(req.headers.get("sec-fetch-dest") ?? "");
}

/** 302 to a fresh content-host link for one revision ("render": an HTML page; "file": a PDF). Caller has authorized. */
export async function viewLinkRedirect(ctx, projectId, artifactId, revNo, purpose) {
  const token = randomId("vl", 24);
  await ctx.env.DB.prepare(`INSERT INTO view_links (token_hash, session_hash, principal_id, project_id, artifact_id, rev_no, purpose, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(await sha256Hex(token), ctx.sessionHash, ctx.principal.id, projectId, artifactId, revNo, purpose, nowMs() + VIEW_LINK_TTL_MS[purpose], nowIso()).run();
  return new Response(null, { status: 302, headers: { location: `${contentOrigin(ctx.env)}/c/${token}`, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}

function textPage(env, status, text) {
  return new Response(text, { status, headers: {
    "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
    "content-security-policy": `default-src 'none'; frame-ancestors ${appOrigin(env)}; sandbox`
  } });
}
// Only the Range header goes to serveContent (it reads ?open from the URL it is given).
const inner = (req, url, query = "") => new Request(url.origin + url.pathname + query, { method: req.method, headers: req.headers.get("range") ? { range: req.headers.get("range") } : {} });

/** Every request to CONTENT_HOST. Nothing here reads or sets cookies. */
export async function handleContentHost(req, env, url) {
  const requestId = randomId("req", 9);
  try {
    if (url.pathname === "/robots.txt") return textPage(env, 200, "User-agent: *\nDisallow: /\n");
    const m = LINK.exec(url.pathname);
    if (!m) return textPage(env, 404, "Not found");
    if (req.method !== "GET" && req.method !== "HEAD") { const r = textPage(env, 405, "Method not allowed"); r.headers.set("allow", "GET, HEAD"); return r; }
    const now = nowMs();
    const row = await env.DB.prepare(`SELECT v.*, s.revoked_at AS s_revoked, s.expires_at AS s_expires FROM view_links v
      LEFT JOIN sessions s ON s.id_hash = v.session_hash WHERE v.token_hash = ?`).bind(await sha256Hex(m[1])).first();
    if (!row || row.expires_at <= now || row.s_revoked !== null || !(row.s_expires > now)) {
      await rateLimit(env, "authfail:" + (req.headers.get("cf-connecting-ip") ?? "local"), limitsFor(env).authFailPerMin);
      return textPage(env, 401, "This link has expired, or you signed out. Open the page again from Agent Library.");
    }
    // The person behind the session, checked live on every request (role, workspace, deleted project).
    const ctx = { env, requestId, principal: { id: row.principal_id, kind: "human", label: "" } };
    await enforceRate(ctx, false);
    if (row.purpose === "file") {
      if (m[2]) return textPage(env, 404, "Not found");
      return await serveContent(ctx, inner(req, url, "?open=1"), row.project_id, row.artifact_id, String(row.rev_no));
    }
    const r = await getRenderSource(ctx, row.project_id, row.artifact_id, row.rev_no, "html");
    if (m[2]) {
      // An image or video this revision of the page shows (same project; the file's current version, as in the app).
      if (!htmlRefs(r.body).includes(m[2])) return textPage(env, 404, "Not found");
      const media = await projectMedia(env, row.project_id, [m[2]], () => "");
      if (!media(m[2])) return textPage(env, 404, "Not found");
      return await serveContent(ctx, inner(req, url), row.project_id, m[2], null);
    }
    const media = await projectMedia(env, row.project_id, htmlRefs(r.body), (ref) => `/c/${m[1]}/m/${encodeURIComponent(ref)}`);
    const page = renderHtmlDocument(r.body, media, r.artifact.title);
    return new Response(req.method === "HEAD" ? null : page, { status: 200, headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      // Same policy as the app-host render (no scripts, sandbox), framed only by the app.
      "content-security-policy": RENDER_CSP.replace("frame-ancestors 'self'", `frame-ancestors ${appOrigin(env)}`),
      "referrer-policy": "no-referrer",
      "x-revision": String(r.revision.rev_no)
    } });
  } catch (e) {
    if (e instanceof HttpError && e.code === "render_too_large") return textPage(env, 413, e.message + " Open it in Agent Library to see its source.");
    if (e instanceof HttpError) return textPage(env, e.status === 429 ? 429 : 404, e.status === 429 ? "Too many requests" : "Not found");
    console.error("content_host_error", requestId, e?.message);
    return textPage(env, 500, "Internal error");
  }
}
