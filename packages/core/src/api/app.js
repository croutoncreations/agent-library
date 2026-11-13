// App Connect's HTTP surface (/v1/app/*): the token and authorization shell around App Files, plus "who am I".
// Routes: GET /v1/app, GET /v1/app/connection-info, and /v1/app/files* (api/app-files.js). Every request re-reads the
// publisher's current authorization (assertStillAuthorized); nothing here is cached between requests.
import { agentRate, rateLimit } from "../auth.js";
import { addressLinksResponse } from "../paths.js";
import { projectWorkspaceId } from "../limits.js";
import { SCOPES, livePublisher } from "../oauth/server.js";
import { APP_FILE_MAX_BYTES, isAppFileContentPath, isAppFilesPath, routeAppFiles } from "./app-files.js";
import { connectionInfo } from "../service.js";
import { APP_DISABLED, assertStillAuthorized } from "./app-auth.js";
import { HttpError, errorBody, json, randomId } from "../util.js";

async function me(db, p) {
  const proj = await db.prepare("SELECT id, title FROM projects WHERE id = ?").bind(p.project_id).first();
  const f = p.folder_id ? await db.prepare("SELECT id, name FROM folders WHERE id = ?").bind(p.folder_id).first() : null;
  return {
    app_id: p.app_client_id,
    publisher_id: p.id,
    display_name: p.display_name,
    project: { id: proj.id, title: proj.title },
    folder: f ? { id: f.id, name: f.name } : null,
    limits: { max_file_bytes: APP_FILE_MAX_BYTES }
  };
}

async function connectionDiagnostic(db, p, url) {
  if (url.search) throw new HttpError(400, "invalid_input", "This diagnostic accepts no parameters");
  const project = await db.prepare("SELECT id, title FROM projects WHERE id = ?").bind(p.project_id).first();
  // Reuse the actual write gate; metadata reads remain available when writes are blocked.
  let canWrite = true;
  const writeRestrictions = [];
  try { await assertStillAuthorized(db, p); }
  catch (e) {
    if (!(e instanceof HttpError) || ![401, 403].includes(e.status)) throw e;
    canWrite = false;
    writeRestrictions.push("Writes blocked: " + e.message);
  }
  return json(connectionInfo("publisher", p.id, p.display_name, [], null, null, {
    destination: { project_id: project.id, title: project.title, folder_id: p.folder_id, can_read_own_files: true, can_write_own_files: canWrite },
    restrictions: ["Only this app's own files in its approved destination; no general project browsing.", "File rules, limits and revisions still apply. No rendering, transfer or write was tested."].concat(writeRestrictions)
  }), 200, { "cache-control": "no-store" });
}

async function route(req, env, p, requestId) {
  const url = new URL(req.url);
  const m = req.method;
  const write = m !== "GET" && m !== "HEAD";
  const db = env.DB;
  const wsId = p.workspace_id ?? await projectWorkspaceId(env, p.project_id);
  await rateLimit(env, `${write ? "w" : "r"}:${p.principal_id}`, await agentRate(env, wsId, write));
  if (isAppFilesPath(url.pathname)) return routeAppFiles({ req, env, db, p, requestId });
  if (url.pathname !== "/v1/app" && url.pathname !== "/v1/app/connection-info") throw new HttpError(404, "not_found", "Not found");
  if (m !== "GET" && m !== "HEAD") throw new HttpError(405, "method_not_allowed", "Method not allowed");
  if (url.pathname === "/v1/app") return json(await me(db, p));
  return connectionDiagnostic(db, p, url);
}

/** The /v1/app handler behind the OAuth resource server (scope agentlib:publish). */
export async function handleAppApi(req, env, ctx) {
  const requestId = randomId("req", 9);
  const fail = (e) => {
    const h = { "x-request-id": requestId };
    if (e.status === 401) h["www-authenticate"] = `Bearer error="invalid_token"${e.code === "publisher_revoked" ? ', error_description="revoked"' : ""}`;
    if (e.status === 403 && e.code === "insufficient_scope") h["www-authenticate"] = `Bearer error="insufficient_scope", scope="${SCOPES.publish}"`;
    if ((e.status === 429 || e.status === 503) && e.extra?.retry_after_seconds) h["retry-after"] = String(e.extra.retry_after_seconds);
    const b = errorBody(e);
    b.error.request_id = requestId;
    return json(b, e.status, h);
  };
  try {
    if (req.headers.get("cookie")) throw new HttpError(400, "invalid_request", "Cookies are not accepted on the API");
    if (!ctx.auth.scope.includes(SCOPES.publish)) throw new HttpError(403, "insufficient_scope", "Token lacks agentlib:publish");
    const p = await livePublisher(env, ctx.props).catch(() => null);
    if (!p) throw new HttpError(401, "unauthenticated", "Token is no longer valid; reconnect the app");
    if (p.revoked) throw new HttpError(401, "publisher_revoked", "This publisher has been revoked by the owner");
    if (p.disabled) throw new HttpError(401, "unauthenticated", APP_DISABLED);
    const pathname = new URL(req.url).pathname;
    const routed = await route(req, env, p, requestId);
    // App Files content carries stored bytes: never rewritten (lists are, like every other JSON answer).
    const res = isAppFileContentPath(pathname) ? routed : await addressLinksResponse(env, routed, pathname, [p.project_id]);
    const r = new Response(res.body, res);
    r.headers.set("x-request-id", requestId);
    return r;
  } catch (e) {
    if (e instanceof HttpError) return fail(e);
    console.error("app_api_unhandled", requestId, e?.name ?? "error");
    return json({ error: { code: "internal", message: "Internal error", request_id: requestId } }, 500, { "x-request-id": requestId });
  }
}
