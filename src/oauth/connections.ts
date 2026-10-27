// Owner-side management of OAuth connections (served only on the owner host, behind Access + session).
import { authorizeProject, requireHuman, type Ctx } from "../auth";
import { HttpError, nowIso, nowMs } from "../util";
import type { OAuthEnv } from "./server";

export async function listConnections(ctx: Ctx, projectId: string) {
  requireHuman(ctx);
  await authorizeProject(ctx, projectId, false);
  // Connections that include this project; "access" is the permission for this project specifically.
  const r = await ctx.env.DB.prepare(
    `SELECT c.id, c.client_name, c.client_id, c.redirect_uri, cp.can_write, c.created_at, c.expires_at, c.revoked_at, c.last_used_at,
            (SELECT COUNT(*) FROM oauth_connection_projects x WHERE x.connection_id = c.id) AS project_count
     FROM oauth_connections c JOIN oauth_connection_projects cp ON cp.connection_id = c.id AND cp.project_id = ?
     WHERE c.owner_principal_id = ? ORDER BY c.created_at DESC LIMIT 100`,
  ).bind(projectId, ctx.principal.id).all<any>();
  return { connections: r.results.map((c) => ({
    id: c.id, client_name: c.client_name, client_id: c.client_id, redirect_host: safeHost(c.redirect_uri),
    access: c.can_write ? "read+write" : "read", project_count: c.project_count, created_at: c.created_at, expires_at: new Date(c.expires_at).toISOString(),
    revoked: c.revoked_at !== null, last_used_at: c.last_used_at ? new Date(c.last_used_at).toISOString() : null,
  })) };
}
const safeHost = (u: string) => { try { return new URL(u).host; } catch { return ""; } };

/**
 * All of the owner's connected apps (OAuth connections, every project) and agent grants, for the
 * "Connected apps" page. Human-only; only rows owned by the signed-in owner. No secrets: grant tokens
 * are hash-stored and never returned; OAuth tokens live in KV and are never read here.
 */
export async function listAccess(ctx: Ctx) {
  requireHuman(ctx);
  const me = ctx.principal.id;
  const conns = await ctx.env.DB.prepare(
    `SELECT id, client_name, client_id, redirect_uri, created_at, expires_at, revoked_at, last_used_at
     FROM oauth_connections WHERE owner_principal_id = ? ORDER BY created_at DESC LIMIT 200`,
  ).bind(me).all<any>();
  const cps = await ctx.env.DB.prepare(
    `SELECT cp.connection_id, cp.project_id, cp.can_write, p.title FROM oauth_connection_projects cp
     JOIN oauth_connections c ON c.id = cp.connection_id JOIN projects p ON p.id = cp.project_id
     WHERE c.owner_principal_id = ? AND p.owner_id = ?`,
  ).bind(me, me).all<any>();
  const byConn = new Map<string, any[]>();
  for (const r of cps.results) {
    const l = byConn.get(r.connection_id) ?? [];
    l.push({ id: r.project_id, title: r.title, access: r.can_write ? "read+write" : "read" });
    byConn.set(r.connection_id, l);
  }
  const grants = await ctx.env.DB.prepare(
    `SELECT g.id, g.project_id, pr.title, pl.label, g.can_write, g.expires_at, g.revoked_at, g.created_at
     FROM grants g JOIN projects pr ON pr.id = g.project_id JOIN principals pl ON pl.id = g.principal_id
     WHERE pr.owner_id = ? ORDER BY g.created_at DESC LIMIT 200`,
  ).bind(me).all<any>();
  const now = nowMs();
  return {
    connections: conns.results.map((c) => ({
      id: c.id, client_name: c.client_name, client_id: c.client_id, redirect_host: safeHost(c.redirect_uri),
      projects: byConn.get(c.id) ?? [],
      status: c.revoked_at !== null ? "revoked" : c.expires_at <= now ? "expired" : "active",
      used: c.last_used_at !== null,
      created_at: c.created_at, expires_at: new Date(c.expires_at).toISOString(),
      last_used_at: c.last_used_at ? new Date(c.last_used_at).toISOString() : null,
    })),
    grants: grants.results.map((g) => ({
      id: g.id, project_id: g.project_id, project_title: g.title, label: g.label, access: g.can_write ? "read+write" : "read",
      status: g.revoked_at !== null ? "revoked" : g.expires_at <= now ? "expired" : "active",
      created_at: g.created_at, expires_at: new Date(g.expires_at).toISOString(),
    })),
  };
}

/** Revoke one OAuth connection by id (owner-wide; same D1-first semantics as revokeConnection). */
export async function revokeConnectionById(ctx: Ctx, connectionId: string) {
  requireHuman(ctx);
  const row = await ctx.env.DB.prepare(
    `SELECT cp.project_id FROM oauth_connections c JOIN oauth_connection_projects cp ON cp.connection_id = c.id
     WHERE c.id = ? AND c.owner_principal_id = ? LIMIT 1`,
  ).bind(connectionId, ctx.principal.id).first<string>("project_id");
  if (!row) throw new HttpError(404, "not_found", "Connection not found");
  return revokeConnection(ctx, row, connectionId);
}

/**
 * Revoke one connection (all of its projects): D1 first (blocks every existing access token immediately,
 * since each MCP call checks the row), then the library grant in KV (kills refresh). Other connections
 * are untouched. Reachable from any project the connection includes.
 */
export async function revokeConnection(ctx: Ctx, projectId: string, connectionId: string) {
  requireHuman(ctx);
  await authorizeProject(ctx, projectId, true);
  const r = await ctx.env.DB.prepare(`UPDATE oauth_connections SET revoked_at = ? WHERE id = ? AND owner_principal_id = ? AND revoked_at IS NULL
      AND EXISTS (SELECT 1 FROM oauth_connection_projects cp WHERE cp.connection_id = oauth_connections.id AND cp.project_id = ?)`)
    .bind(nowMs(), connectionId, ctx.principal.id, projectId).run();
  if (!r.meta.changes) throw new HttpError(404, "not_found", "Active connection not found");
  await ctx.env.DB.prepare("INSERT INTO audits (at, actor_id, project_id, action, object_id, result, request_id) VALUES (?, ?, ?, 'oauth.revoke', ?, 'ok', ?)")
    .bind(nowIso(), ctx.principal.id, projectId, connectionId, ctx.requestId).run();
  const env = ctx.env as OAuthEnv;
  let kv = "skipped";
  if (env.OAUTH_KV && env.MCP_HOST) {
    try {
      const { _servers, originFor } = await import("./server");
      const oauth = _servers(originFor(env.MCP_HOST)).as.getOAuthApi(env);
      const grants = await oauth.listUserGrants(connectionId);
      for (const g of grants.items) await oauth.revokeGrant(g.id, connectionId);
      kv = "revoked";
    } catch { kv = "pending"; } // D1 revocation already blocks access and refresh (tokenExchangeCallback)
  }
  return { ok: true, oauth_grant: kv };
}
