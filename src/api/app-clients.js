import { requireHuman } from "../auth.js";
import { memberRoleSql, personalWorkspaceId, requireWorkspaceRole, workspaceRoleSql } from "../tenancy.js";

// App registrations belong to a workspace (default: the registrant's personal workspace). The registrant or an admin
// of that workspace manages one (columns qualified: see KEY_MANAGER in credentials.js).
// The registrant must still be a member of the app's (active) workspace: someone removed loses the app too.
var APP_WS = "COALESCE(c.workspace_id, 'wsp_' || c.owner_principal_id)";
var APP_MANAGER = `((c.owner_principal_id = ? AND ${workspaceRoleSql(APP_WS, "viewer")}) OR ${workspaceRoleSql(APP_WS, "admin")})`;
import { _servers, originFor } from "../oauth/server.js";
import { requireAppConnect } from "../service.js";
import { HttpError, nowIso, nowMs, randomId, str } from "../util.js";

var LOOPBACK_CB = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?\/[A-Za-z0-9/_.~-]*$/;
var HTTPS_CB = /^https:\/\/[a-z0-9.-]+(:\d{1,5})?\/[A-Za-z0-9/_.~-]*$/;
var ORIGIN = /^(https:\/\/[a-z0-9.-]+|http:\/\/(localhost|127\.0\.0\.1))(:\d{1,5})?$/;
function list(v, name, min, max, re) {
  if (!Array.isArray(v) || v.length < min || v.length > max) throw new HttpError(400, "invalid_input", `${name} must list ${min}-${max} entries`);
  const out2 = v.map((x) => str(x, name, 300));
  for (const x of out2) if (!re.test(x)) throw new HttpError(400, "invalid_input", `${name}: ${x.slice(0, 80)} is not allowed`);
  if (new Set(out2).size !== out2.length) throw new HttpError(400, "invalid_input", `${name} has duplicates`);
  return out2;
}
var view = (r) => ({
  app_client_id: r.id,
  client_id: r.client_id,
  display_name: r.display_name,
  redirect_uris: JSON.parse(r.redirect_uris),
  origins: JSON.parse(r.origins),
  suggested_project: r.suggested_project ?? null,
  suggested_folder: r.suggested_folder ?? null,
  created_at: r.created_at,
  disabled: r.disabled_at !== null
});
// Optional owner-set default destination. Plain text, 1-80 chars, no "/" or control characters; empty clears it.
function suggestion(v, name) {
  if (v === void 0 || v === null) return null;
  const t = str(v, name, 200).trim();
  if (!t) return null;
  if (t.length > 80 || /[\/\u0000-\u001f\u007f]/.test(t)) throw new HttpError(400, "invalid_input", `${name} must be 1-80 characters without / or control characters`);
  return t;
}
async function updateAppClient(ctx, id, input) {
  requireHuman(ctx);
  requireAppConnect(ctx);
  const sp = suggestion(input?.suggested_project, "suggested_project"), sf = suggestion(input?.suggested_folder, "suggested_folder");
  const r = await ctx.env.DB.prepare(`UPDATE app_clients AS c SET suggested_project = ?, suggested_folder = ? WHERE c.id = ? AND ${APP_MANAGER}`).bind(sp, sf, id, ctx.principal.id, ctx.principal.id, ctx.principal.id).run();
  if (!r.meta.changes) throw new HttpError(404, "not_found", "App not found");
  await ctx.env.DB.prepare("INSERT INTO audits (at, actor_id, project_id, action, object_id, result, request_id, workspace_id) VALUES (?, ?, NULL, 'app_client.update', ?, 'ok', ?, (SELECT COALESCE(workspace_id, 'wsp_' || owner_principal_id) FROM app_clients WHERE id = ?))").bind(nowIso(), ctx.principal.id, id, ctx.requestId, id).run();
  return view(await ctx.env.DB.prepare("SELECT * FROM app_clients WHERE id = ?").bind(id).first());
}
async function registerAppClient(ctx, input) {
  requireHuman(ctx);
  requireAppConnect(ctx);
  const env = ctx.env;
  if (!env.MCP_HOST || !env.OAUTH_KV) throw new HttpError(503, "unavailable", "OAuth host is not configured");
  const display = str(input?.display_name, "display_name", 80, { min: 1 }).trim();
  const redirects = list(input?.redirect_uris, "redirect_uris", 1, 3, new RegExp(`${LOOPBACK_CB.source}|${HTTPS_CB.source}`));
  const origins = list(input?.origins ?? [], "origins", 0, 3, ORIGIN);
  const suggestedProject = suggestion(input?.suggested_project, "suggested_project"), suggestedFolder = suggestion(input?.suggested_folder, "suggested_folder");
  // Registering an app is an admin action in the chosen workspace (plan: "Manage members, apps").
  const ws = await requireWorkspaceRole(ctx, input?.workspace_id === void 0 ? personalWorkspaceId(ctx.principal.id) : str(input.workspace_id, "workspace_id", 80), "admin");
  const { as } = _servers(originFor(env.MCP_HOST.toLowerCase()), true);
  const client = await as.getOAuthApi(env).createClient({
    redirectUris: redirects,
    clientName: display,
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"]
  });
  const id = randomId("apc", 12);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO app_clients (id, owner_principal_id, client_id, display_name, redirect_uris, origins, created_at, suggested_project, suggested_folder, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, ctx.principal.id, client.clientId, display, JSON.stringify(redirects), JSON.stringify(origins), nowIso(), suggestedProject, suggestedFolder, ws.id),
    env.DB.prepare("INSERT INTO audits (at, actor_id, project_id, action, object_id, result, request_id, workspace_id) VALUES (?, ?, NULL, 'app_client.register', ?, 'ok', ?, ?)").bind(nowIso(), ctx.principal.id, id, ctx.requestId, ws.id)
  ]);
  return view(await env.DB.prepare("SELECT * FROM app_clients WHERE id = ?").bind(id).first());
}
async function listAppClients(ctx) {
  requireHuman(ctx);
  requireAppConnect(ctx);
  const r = await ctx.env.DB.prepare(`SELECT c.* FROM app_clients c WHERE ${APP_MANAGER} ORDER BY c.created_at DESC LIMIT 100`).bind(ctx.principal.id, ctx.principal.id, ctx.principal.id).all();
  // Publishers of these apps, plus any publisher connected into a project where I'm an admin or connected it myself.
  const pubs = await ctx.env.DB.prepare(
    `SELECT pb.id, pb.app_client_id, pb.project_id, pb.folder_id, pb.created_at, pb.revoked_at, pb.current_source_revision, pb.current_snapshot_id
     FROM publishers pb WHERE (pb.app_client_id IN (SELECT c.id FROM app_clients c WHERE ${APP_MANAGER})
         AND (COALESCE(pb.created_by, pb.owner_principal_id) = ? OR ${memberRoleSql("pb.project_id", "viewer")}))
       OR COALESCE(pb.created_by, pb.owner_principal_id) = ? OR ${memberRoleSql("pb.project_id", "admin", "?", true)} ORDER BY pb.created_at DESC LIMIT 500`
  ).bind(ctx.principal.id, ctx.principal.id, ctx.principal.id, ctx.principal.id, ctx.principal.id, ctx.principal.id, ctx.principal.id).all();
  const pv = (p) => ({
    publisher_id: p.id,
    project_id: p.project_id,
    folder_id: p.folder_id,
    created_at: p.created_at,
    status: p.revoked_at === null ? "active" : "revoked",
    current_source_revision: p.current_source_revision,
    current_snapshot_id: p.current_snapshot_id
  });
  const mine = new Set(r.results.map((c) => c.id));
  return {
    app_clients: r.results.map((c) => ({ ...view(c), workspace_id: c.workspace_id ?? `wsp_${c.owner_principal_id}`, publishers: pubs.results.filter((p) => p.app_client_id === c.id).map(pv) })),
    // Publishers of someone else's app that I can revoke (connected by me, or in a project where I'm an admin).
    other_publishers: pubs.results.filter((p) => !mine.has(p.app_client_id)).map(pv)
  };
}
async function disableAppClient(ctx, id) {
  requireHuman(ctx);
  requireAppConnect(ctx);
  const r = await ctx.env.DB.prepare(`UPDATE app_clients AS c SET disabled_at = ? WHERE c.id = ? AND (c.owner_principal_id = ? OR ${workspaceRoleSql(APP_WS, "admin", "?", true)}) AND c.disabled_at IS NULL`).bind(nowMs(), id, ctx.principal.id, ctx.principal.id).run();
  if (!r.meta.changes) throw new HttpError(404, "not_found", "App not found or already disabled");
  await ctx.env.DB.prepare("INSERT INTO audits (at, actor_id, project_id, action, object_id, result, request_id, workspace_id) VALUES (?, ?, NULL, 'app_client.disable', ?, 'ok', ?, (SELECT COALESCE(workspace_id, 'wsp_' || owner_principal_id) FROM app_clients WHERE id = ?))").bind(nowIso(), ctx.principal.id, id, ctx.requestId, id).run();
  return { ok: true };
}
async function revokePublisher(ctx, id) {
  requireHuman(ctx);
  requireAppConnect(ctx);
  // The person who connected the publisher, or an admin of the project's workspace.
  const r = await ctx.env.DB.prepare(`UPDATE publishers AS pb SET revoked_at = ? WHERE pb.id = ? AND pb.revoked_at IS NULL
      AND (COALESCE(pb.created_by, pb.owner_principal_id) = ? OR ${memberRoleSql("pb.project_id", "admin", "?", true)})`).bind(nowMs(), id, ctx.principal.id, ctx.principal.id).run();
  if (!r.meta.changes) throw new HttpError(404, "not_found", "Publisher not found or already revoked");
  const p = await ctx.env.DB.prepare("SELECT project_id FROM publishers WHERE id = ?").bind(id).first("project_id");
  await ctx.env.DB.prepare("INSERT INTO audits (at, actor_id, project_id, action, object_id, result, request_id) VALUES (?, ?, ?, 'publisher.revoke', ?, 'ok', ?)").bind(nowIso(), ctx.principal.id, p, id, ctx.requestId).run();
  return { ok: true };
}

export { disableAppClient, listAppClients, registerAppClient, revokePublisher, updateAppClient };
