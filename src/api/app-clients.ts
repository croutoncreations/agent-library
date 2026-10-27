// Owner registration of App Connect publisher apps (contract app-connect/0.4 §6). Owner session + CSRF on the
// owner host only. Creates a public OAuth client (no secret) through the library's createClient(); dynamic
// registration can never obtain agentlib:publish. Flag-gated: 404 unless APP_CONNECT_ENABLED=1.
import { requireHuman, type Ctx } from "../auth";
import { _servers, originFor, type OAuthEnv } from "../oauth/server";
import { requireAppConnect } from "../service";
import { HttpError, nowIso, nowMs, randomId, str } from "../util";

const LOOPBACK_CB = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?\/[A-Za-z0-9/_.~-]*$/;
const HTTPS_CB = /^https:\/\/[a-z0-9.-]+(:\d{1,5})?\/[A-Za-z0-9/_.~-]*$/;
const ORIGIN = /^(https:\/\/[a-z0-9.-]+|http:\/\/(localhost|127\.0\.0\.1))(:\d{1,5})?$/;

function list(v: unknown, name: string, min: number, max: number, re: RegExp): string[] {
  if (!Array.isArray(v) || v.length < min || v.length > max) throw new HttpError(400, "invalid_input", `${name} must list ${min}-${max} entries`);
  const out = v.map((x) => str(x, name, 300));
  for (const x of out) if (!re.test(x)) throw new HttpError(400, "invalid_input", `${name}: ${x.slice(0, 80)} is not allowed`);
  if (new Set(out).size !== out.length) throw new HttpError(400, "invalid_input", `${name} has duplicates`);
  return out;
}

const view = (r: any) => ({ app_client_id: r.id, client_id: r.client_id, display_name: r.display_name, redirect_uris: JSON.parse(r.redirect_uris),
  origins: JSON.parse(r.origins), suggested_project: r.suggested_project ?? null, suggested_folder: r.suggested_folder ?? null,
  created_at: r.created_at, disabled: r.disabled_at !== null });
// NOTE: the shipped behavior (validation, insert, PUT /api/app-clients/:id) is patched in by build-app-connect-fixes.mjs.

export async function registerAppClient(ctx: Ctx, input: any) {
  requireHuman(ctx); requireAppConnect(ctx);
  const env = ctx.env as OAuthEnv;
  if (!env.MCP_HOST || !env.OAUTH_KV) throw new HttpError(503, "unavailable", "OAuth host is not configured");
  const display = str(input?.display_name, "display_name", 80, { min: 1 }).trim();
  const redirects = list(input?.redirect_uris, "redirect_uris", 1, 3, new RegExp(`${LOOPBACK_CB.source}|${HTTPS_CB.source}`));
  const origins = list(input?.origins ?? [], "origins", 0, 3, ORIGIN);
  const { as } = _servers(originFor(env.MCP_HOST.toLowerCase()), true);
  const client = await as.getOAuthApi(env).createClient({
    redirectUris: redirects, clientName: display, tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code", "refresh_token"], responseTypes: ["code"],
  });
  const id = randomId("apc", 12);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO app_clients (id, owner_principal_id, client_id, display_name, redirect_uris, origins, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(id, ctx.principal.id, client.clientId, display, JSON.stringify(redirects), JSON.stringify(origins), nowIso()),
    env.DB.prepare("INSERT INTO audits (at, actor_id, project_id, action, object_id, result, request_id) VALUES (?, ?, NULL, 'app_client.register', ?, 'ok', ?)")
      .bind(nowIso(), ctx.principal.id, id, ctx.requestId),
  ]);
  return view(await env.DB.prepare("SELECT * FROM app_clients WHERE id = ?").bind(id).first());
}

export async function listAppClients(ctx: Ctx) {
  requireHuman(ctx); requireAppConnect(ctx);
  const r = await ctx.env.DB.prepare("SELECT * FROM app_clients WHERE owner_principal_id = ? ORDER BY created_at DESC LIMIT 100").bind(ctx.principal.id).all<any>();
  const pubs = await ctx.env.DB.prepare(
    `SELECT pb.id, pb.app_client_id, pb.project_id, pb.folder_id, pb.created_at, pb.revoked_at, pb.current_source_revision, pb.current_snapshot_id
     FROM publishers pb WHERE pb.owner_principal_id = ? ORDER BY pb.created_at DESC LIMIT 500`).bind(ctx.principal.id).all<any>();
  return { app_clients: r.results.map((c) => ({ ...view(c), publishers: pubs.results.filter((p) => p.app_client_id === c.id).map((p) => ({
    publisher_id: p.id, project_id: p.project_id, folder_id: p.folder_id, created_at: p.created_at, status: p.revoked_at === null ? "active" : "revoked",
    current_source_revision: p.current_source_revision, current_snapshot_id: p.current_snapshot_id })) })) };
}

export async function disableAppClient(ctx: Ctx, id: string) {
  requireHuman(ctx); requireAppConnect(ctx);
  const r = await ctx.env.DB.prepare("UPDATE app_clients SET disabled_at = ? WHERE id = ? AND owner_principal_id = ? AND disabled_at IS NULL").bind(nowMs(), id, ctx.principal.id).run();
  if (!r.meta.changes) throw new HttpError(404, "not_found", "App not found or already disabled");
  await ctx.env.DB.prepare("INSERT INTO audits (at, actor_id, project_id, action, object_id, result, request_id) VALUES (?, ?, NULL, 'app_client.disable', ?, 'ok', ?)").bind(nowIso(), ctx.principal.id, id, ctx.requestId).run();
  return { ok: true };
}

export async function revokePublisher(ctx: Ctx, id: string) {
  requireHuman(ctx); requireAppConnect(ctx);
  const r = await ctx.env.DB.prepare("UPDATE publishers SET revoked_at = ? WHERE id = ? AND owner_principal_id = ? AND revoked_at IS NULL").bind(nowMs(), id, ctx.principal.id).run();
  if (!r.meta.changes) throw new HttpError(404, "not_found", "Publisher not found or already revoked");
  const p = await ctx.env.DB.prepare("SELECT project_id FROM publishers WHERE id = ?").bind(id).first<string>("project_id");
  await ctx.env.DB.prepare("INSERT INTO audits (at, actor_id, project_id, action, object_id, result, request_id) VALUES (?, ?, ?, 'publisher.revoke', ?, 'ok', ?)").bind(nowIso(), ctx.principal.id, p, id, ctx.requestId).run();
  return { ok: true };
}
