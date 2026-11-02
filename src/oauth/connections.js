import { authorizeProject, requireHuman } from "../auth.js";
import { _servers, originFor } from "./server.js";
import { memberRoleSql, workspaceRoleSql } from "../tenancy.js";
import { HttpError, nowIso, nowMs } from "../util.js";

// A connection is managed by the person who created it, or an admin of its workspace.
const MANAGE = `(COALESCE(c.created_by, c.owner_principal_id) = ? OR ${workspaceRoleSql("COALESCE(c.workspace_id, 'wsp_' || c.owner_principal_id)", "admin", "?", true)})`; // list/revoke work while suspended

async function listConnections(ctx, projectId) {
  requireHuman(ctx);
  await authorizeProject(ctx, projectId, false);
  const r = await ctx.env.DB.prepare(
    `SELECT c.id, c.client_name, c.client_id, c.redirect_uri, cp.can_write, c.created_at, c.expires_at, c.revoked_at, c.last_used_at,
            (SELECT COUNT(*) FROM oauth_connection_projects x WHERE x.connection_id = c.id) AS project_count
     FROM oauth_connections c JOIN oauth_connection_projects cp ON cp.connection_id = c.id AND cp.project_id = ?
     WHERE ${MANAGE} ORDER BY c.created_at DESC LIMIT 100`
  ).bind(projectId, ctx.principal.id, ctx.principal.id).all();
  return { connections: r.results.map((c) => ({
    id: c.id,
    client_name: c.client_name,
    client_id: c.client_id,
    redirect_host: safeHost(c.redirect_uri),
    access: c.can_write ? "read+write" : "read",
    project_count: c.project_count,
    created_at: c.created_at,
    expires_at: new Date(c.expires_at).toISOString(),
    revoked: c.revoked_at !== null,
    last_used_at: c.last_used_at ? new Date(c.last_used_at).toISOString() : null
  })) };
}
var safeHost = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return "";
  }
};
async function listAccess(ctx) {
  requireHuman(ctx);
  const me2 = ctx.principal.id;
  const conns = await ctx.env.DB.prepare(
    `SELECT id, client_name, client_id, redirect_uri, created_at, expires_at, revoked_at, last_used_at, file_access, workspace_id, created_by, owner_principal_id
     FROM oauth_connections c WHERE ${MANAGE} ORDER BY created_at DESC LIMIT 200`
  ).bind(me2, me2).all();
  const cps = await ctx.env.DB.prepare(
    `SELECT cp.connection_id, cp.project_id, cp.can_write, p.title FROM oauth_connection_projects cp
     JOIN oauth_connections c ON c.id = cp.connection_id JOIN projects p ON p.id = cp.project_id
     WHERE ${MANAGE}`
  ).bind(me2, me2).all();
  const byConn = /* @__PURE__ */ new Map();
  for (const r of cps.results) {
    const l = byConn.get(r.connection_id) ?? [];
    l.push({ id: r.project_id, title: r.title, access: r.can_write ? "read+write" : "read" });
    byConn.set(r.connection_id, l);
  }
  const grants = await ctx.env.DB.prepare(
    `SELECT g.id, g.project_id, pr.title, pl.label, g.can_write, g.expires_at, g.revoked_at, g.created_at
     FROM grants g JOIN projects pr ON pr.id = g.project_id JOIN principals pl ON pl.id = g.principal_id
     WHERE (g.created_by = ? OR ${memberRoleSql("pr.id", "admin", "?", true)}) ORDER BY g.created_at DESC LIMIT 200`
  ).bind(me2, me2).all();
  const now = nowMs();
  return {
    connections: conns.results.map((c) => ({
      id: c.id,
      client_name: c.client_name,
      client_id: c.client_id,
      redirect_host: safeHost(c.redirect_uri),
      workspace_id: c.workspace_id ?? `wsp_${c.owner_principal_id}`,
      created_by: c.created_by ?? c.owner_principal_id,
      projects: byConn.get(c.id) ?? [],
      files: c.file_access === 1,
      status: c.revoked_at !== null ? "revoked" : c.expires_at <= now ? "expired" : "active",
      used: c.last_used_at !== null,
      created_at: c.created_at,
      expires_at: new Date(c.expires_at).toISOString(),
      last_used_at: c.last_used_at ? new Date(c.last_used_at).toISOString() : null
    })),
    grants: grants.results.map((g) => ({
      id: g.id,
      project_id: g.project_id,
      project_title: g.title,
      label: g.label,
      access: g.can_write ? "read+write" : "read",
      status: g.revoked_at !== null ? "revoked" : g.expires_at <= now ? "expired" : "active",
      created_at: g.created_at,
      expires_at: new Date(g.expires_at).toISOString()
    }))
  };
}
async function revokeConnectionById(ctx, connectionId) {
  requireHuman(ctx);
  const row = await ctx.env.DB.prepare(
    `SELECT cp.project_id FROM oauth_connections c JOIN oauth_connection_projects cp ON cp.connection_id = c.id
     WHERE c.id = ? AND ${MANAGE} LIMIT 1`
  ).bind(connectionId, ctx.principal.id, ctx.principal.id).first("project_id");
  if (!row) throw new HttpError(404, "not_found", "Connection not found");
  return revokeConnection(ctx, row, connectionId);
}
async function revokeConnection(ctx, projectId, connectionId) {
  requireHuman(ctx);
  await authorizeProject(ctx, projectId, false);
  const r = await ctx.env.DB.prepare(`UPDATE oauth_connections AS c SET revoked_at = ? WHERE id = ? AND ${MANAGE} AND revoked_at IS NULL
      AND EXISTS (SELECT 1 FROM oauth_connection_projects cp WHERE cp.connection_id = c.id AND cp.project_id = ?)`).bind(nowMs(), connectionId, ctx.principal.id, ctx.principal.id, projectId).run();
  if (!r.meta.changes) throw new HttpError(404, "not_found", "Active connection not found");
  await ctx.env.DB.prepare("INSERT INTO audits (at, actor_id, project_id, action, object_id, result, request_id) VALUES (?, ?, ?, 'oauth.revoke', ?, 'ok', ?)").bind(nowIso(), ctx.principal.id, projectId, connectionId, ctx.requestId).run();
  const env = ctx.env;
  let kv = "skipped";
  if (env.OAUTH_KV && env.MCP_HOST) {
    try {
      const _servers2 = _servers, originFor2 = originFor;
      const oauth = _servers2(originFor2(env.MCP_HOST)).as.getOAuthApi(env);
      const grants = await oauth.listUserGrants(connectionId);
      for (const g of grants.items) await oauth.revokeGrant(g.id, connectionId);
      kv = "revoked";
    } catch {
      kv = "pending";
    }
  }
  return { ok: true, oauth_grant: kv };
}

export { listAccess, listConnections, revokeConnection, revokeConnectionById };
