import { authorizeProject, requireHuman } from "../auth.js";
import { MAX_CONN_PROJECTS, _servers, cleanConnectionName, originFor } from "./server.js";
import { ROLE_RANK, memberRoleSql, projectRole, projectWorkspaceSql, readOnlyError, workspaceRoleSql } from "../tenancy.js";
import { HttpError, cutLists, nowIso, nowMs, str } from "../util.js";

// A connection is managed by the person who created it, or an admin of its workspace.
const MANAGE = `(COALESCE(c.created_by, c.owner_principal_id) = ? OR ${workspaceRoleSql("COALESCE(c.workspace_id, 'wsp_' || c.owner_principal_id)", "admin", "?", true)})`; // list/revoke work while suspended

async function listConnections(ctx, projectId) {
  requireHuman(ctx);
  await authorizeProject(ctx, projectId, false);
  const r = await ctx.env.DB.prepare(
    `SELECT c.id, c.client_name, c.label, c.client_id, c.redirect_uri, cp.can_write, c.created_at, c.expires_at, c.revoked_at, c.last_used_at,
            (SELECT COUNT(*) FROM oauth_connection_projects x WHERE x.connection_id = c.id) AS project_count
     FROM oauth_connections c JOIN oauth_connection_projects cp ON cp.connection_id = c.id AND cp.project_id = ?
     WHERE ${MANAGE} ORDER BY c.created_at DESC LIMIT 101`
  ).bind(projectId, ctx.principal.id, ctx.principal.id).all();
  return { truncated: cutLists({ connections: r.results.length > 100 }), connections: r.results.slice(0, 100).map((c) => ({
    id: c.id,
    display_name: c.label ?? c.client_name,
    label: c.label,
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
/** Connections settings list at most this many connections and agent tokens each (the UI's notes use the same number). */
const ACCESS_LIST_MAX = 200;
async function listAccess(ctx) {
  requireHuman(ctx);
  const me2 = ctx.principal.id;
  const conns = await ctx.env.DB.prepare(
    `SELECT id, client_name, label, client_id, redirect_uri, created_at, expires_at, revoked_at, last_used_at, file_access, workspace_id, created_by, owner_principal_id
     FROM oauth_connections c WHERE ${MANAGE} ORDER BY created_at DESC LIMIT ${ACCESS_LIST_MAX + 1}`
  ).bind(me2, me2).all();
  const connsCut = conns.results.length > ACCESS_LIST_MAX;
  conns.results = conns.results.slice(0, ACCESS_LIST_MAX);
  const cps = await ctx.env.DB.prepare(
    `SELECT cp.connection_id, cp.project_id, cp.can_write, p.title FROM oauth_connection_projects cp
     JOIN oauth_connections c ON c.id = cp.connection_id JOIN projects p ON p.id = cp.project_id AND p.deleted_at IS NULL
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
     FROM grants g JOIN projects pr ON pr.id = g.project_id AND pr.deleted_at IS NULL JOIN principals pl ON pl.id = g.principal_id
     WHERE (g.created_by = ? OR ${memberRoleSql("pr.id", "admin", "?", true)}) ORDER BY g.created_at DESC LIMIT ${ACCESS_LIST_MAX + 1}`
  ).bind(me2, me2).all();
  const grantsCut = grants.results.length > ACCESS_LIST_MAX;
  grants.results = grants.results.slice(0, ACCESS_LIST_MAX);
  const now = nowMs();
  return {
    connections: conns.results.map((c) => ({
      id: c.id,
      display_name: c.label ?? c.client_name,
      label: c.label,
      client_name: c.client_name,
      client_id: c.client_id,
      redirect_uri: c.redirect_uri,
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
    })),
    truncated: cutLists({ connections: connsCut, grants: grantsCut })
  };
}
async function revokeConnectionById(ctx, connectionId) {
  requireHuman(ctx);
  // Disconnecting needs only the right to manage the connection (creator or workspace admin), not any project: a
  // connection may have none, or only ones that were deleted since.
  const row = await ctx.env.DB.prepare(`SELECT c.id, (SELECT cp.project_id FROM oauth_connection_projects cp WHERE cp.connection_id = c.id ORDER BY cp.rowid LIMIT 1) AS project_id
      FROM oauth_connections c WHERE c.id = ? AND ${MANAGE}`).bind(connectionId, ctx.principal.id, ctx.principal.id).first();
  if (!row) throw new HttpError(404, "not_found", "Connection not found");
  const r = await ctx.env.DB.prepare(`UPDATE oauth_connections AS c SET revoked_at = ? WHERE id = ? AND ${MANAGE} AND revoked_at IS NULL`).bind(nowMs(), connectionId, ctx.principal.id, ctx.principal.id).run();
  if (!r.meta.changes) throw new HttpError(404, "not_found", "Active connection not found");
  return finishRevoke(ctx, connectionId, row.project_id ?? null);
}
async function revokeConnection(ctx, projectId, connectionId) {
  requireHuman(ctx);
  await authorizeProject(ctx, projectId, false);
  const r = await ctx.env.DB.prepare(`UPDATE oauth_connections AS c SET revoked_at = ? WHERE id = ? AND ${MANAGE} AND revoked_at IS NULL
      AND EXISTS (SELECT 1 FROM oauth_connection_projects cp WHERE cp.connection_id = c.id AND cp.project_id = ?)`).bind(nowMs(), connectionId, ctx.principal.id, ctx.principal.id, projectId).run();
  if (!r.meta.changes) throw new HttpError(404, "not_found", "Active connection not found");
  return finishRevoke(ctx, connectionId, projectId);
}
async function finishRevoke(ctx, connectionId, projectId) {
  await ctx.env.DB.prepare("DELETE FROM review_grants WHERE path_kind = 'oauth' AND path_id = ?").bind(connectionId).run();
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

const accessName = (can_write) => can_write ? "read_write" : "read";
// Raises "malformed JSON" (a SQLite error) while `cond` holds, which rolls back the whole D1 batch it is part of.
const abortWhen = (env, cond, ...params) => env.DB.prepare(`SELECT json('!') WHERE ${cond}`).bind(...params);
/**
 * Replace which projects an OAuth connection can use (PUT /api/connections/{id}/projects), like setApiKeyScope but an
 * empty list is allowed: a connection with no projects is connected, not revoked. The change takes effect on the agent's
 * next request (credentialGate and liveConnection read oauth_connection_projects on every request). One D1 batch changes
 * only what differs (unchanged projects keep their change-feed cursors); each write repeats its guards in the statement
 * (connection still live and manageable, project in the connection's workspace, role) and a guard that failed aborts the
 * whole batch, so the scope is replaced completely or not at all.
 */
async function setConnectionProjects(ctx, connectionId, input) {
  requireHuman(ctx);
  const env = ctx.env, me2 = ctx.principal.id;
  const conn = await env.DB.prepare(`SELECT c.* FROM oauth_connections c WHERE c.id = ? AND ${MANAGE}`).bind(connectionId, me2, me2).first();
  if (!conn) throw new HttpError(404, "not_found", "Connection not found");
  if (conn.revoked_at !== null || conn.expires_at <= nowMs()) throw new HttpError(409, "inactive", "Connection is disconnected or expired");
  const raw = input?.projects;
  if (!Array.isArray(raw) || raw.length > MAX_CONN_PROJECTS) throw new HttpError(400, "invalid_input", `projects must be a list of at most ${MAX_CONN_PROJECTS} projects (an empty list shares nothing)`);
  const seen = /* @__PURE__ */ new Set();
  const want = raw.map((r) => {
    const projectId = str(r?.project_id, "project_id", 64, { min: 1 });
    if (seen.has(projectId)) throw new HttpError(400, "invalid_input", "Duplicate project in the list");
    seen.add(projectId);
    if (r.access !== "read" && r.access !== "read_write") throw new HttpError(400, "invalid_input", "access must be read or read_write");
    return { project_id: projectId, can_write: r.access === "read_write" ? 1 : 0 };
  });
  const workspaceId = conn.workspace_id ?? `wsp_${conn.owner_principal_id}`;
  const creator = conn.created_by ?? conn.owner_principal_id;
  const people = [...new Set([me2, creator])];
  const cur = (await env.DB.prepare("SELECT cp.project_id, cp.can_write FROM oauth_connection_projects cp JOIN projects p ON p.id = cp.project_id AND p.deleted_at IS NULL WHERE cp.connection_id = ?").bind(connectionId).all()).results;
  // (A project in Recently deleted keeps its row, so restoring it brings the access back; it isn't listed or edited here.)
  const before = new Map(cur.map((r) => [r.project_id, r.can_write]));
  const added = want.filter((w) => !before.has(w.project_id));
  const changed = want.filter((w) => before.has(w.project_id) && before.get(w.project_id) !== w.can_write);
  const removed = cur.filter((r) => !seen.has(r.project_id));
  // Granting more (a new project, or Read -> Read & edit) needs an active workspace; reducing access never does.
  const widening = new Set([...added, ...changed.filter((w) => w.can_write)].map((w) => w.project_id));
  // Every project must exist, be reachable by the person editing and by the connection's creator (whose access the agent
  // actually uses), sit in the connection's workspace, and edit access needs member or above.
  for (const who of people) {
    const roles = await Promise.all(want.map((w) => projectRole(env, who, w.project_id)));
    if (roles.some((r) => !r || !r.role || r.status === "deleting")) throw new HttpError(404, "not_found", "Project not found");
    if (roles.some((r) => r.workspace_id !== workspaceId)) throw new HttpError(400, "invalid_input", "A connection covers projects from one workspace");
    if (want.some((w, i) => w.can_write && ROLE_RANK[roles[i].role] < ROLE_RANK.member)) throw new HttpError(403, "forbidden", "Your role in this workspace is read-only");
    if (want.some((w, i) => widening.has(w.project_id) && roles[i].status !== "active")) throw readOnlyError();
  }
  const live = `EXISTS (SELECT 1 FROM oauth_connections c WHERE c.id = ? AND c.revoked_at IS NULL AND c.expires_at > ? AND ${MANAGE})`;
  const liveParams = () => [connectionId, nowMs(), me2, me2];
  const inWorkspace = `EXISTS (SELECT 1 FROM projects pw WHERE pw.id = ? AND ${projectWorkspaceSql("pw")} = ?)`;
  // The person editing and the creator both still reach the project (member for edit, viewer for read; active workspace to widen).
  const reachSql = (w) => people.map(() => memberRoleSql("?", w.can_write ? "member" : "viewer", "?", !widening.has(w.project_id))).join(" AND ");
  const reachParams = (w) => people.flatMap((who) => [who, w.project_id]);
  const rowIs = "EXISTS (SELECT 1 FROM oauth_connection_projects WHERE connection_id = ? AND project_id = ? AND can_write = ?)";
  const audit = (projectId, result) => env.DB.prepare(`INSERT INTO audits (at, actor_id, project_id, action, object_id, result, request_id, workspace_id)
    VALUES (?, ?, ?, 'oauth.scope', ?, ?, ?, ?)`).bind(nowIso(), me2, projectId, connectionId, result, ctx.requestId, workspaceId);
  await env.DB.batch([
    // Nothing below happens unless the connection is still live and manageable; the legacy project_id column follows the list.
    env.DB.prepare(`UPDATE oauth_connections AS c SET project_id = ? WHERE c.id = ? AND c.revoked_at IS NULL AND c.expires_at > ? AND ${MANAGE}`).bind(want[0]?.project_id ?? null, ...liveParams(), ),
    abortWhen(env, `NOT ${live}`, ...liveParams()),
    ...removed.flatMap((r) => [
      env.DB.prepare(`DELETE FROM oauth_connection_projects WHERE connection_id = ? AND project_id = ? AND ${live}`).bind(connectionId, r.project_id, ...liveParams()),
      abortWhen(env, "EXISTS (SELECT 1 FROM oauth_connection_projects WHERE connection_id = ? AND project_id = ?)", connectionId, r.project_id),
      audit(r.project_id, "ok:removed")
    ]),
    ...added.flatMap((w) => [
      env.DB.prepare(`INSERT INTO oauth_connection_projects (connection_id, project_id, can_write) SELECT ?, ?, ? WHERE ${live} AND ${inWorkspace} AND ${reachSql(w)}`)
        .bind(connectionId, w.project_id, w.can_write, ...liveParams(), w.project_id, workspaceId, ...reachParams(w)),
      abortWhen(env, `NOT ${rowIs}`, connectionId, w.project_id, w.can_write),
      audit(w.project_id, `ok:added:${accessName(w.can_write)}`)
    ]),
    ...changed.flatMap((w) => [
      env.DB.prepare(`UPDATE oauth_connection_projects SET can_write = ? WHERE connection_id = ? AND project_id = ? AND ${live} AND ${reachSql(w)}`)
        .bind(w.can_write, connectionId, w.project_id, ...liveParams(), ...reachParams(w)),
      abortWhen(env, `NOT ${rowIs}`, connectionId, w.project_id, w.can_write),
      audit(w.project_id, `ok:changed:${accessName(w.can_write)}`)
    ]),
    // The connection-level can_write is the switch the gates read; it follows the projects (any with edit access = on).
    env.DB.prepare(`UPDATE oauth_connections AS c SET can_write = EXISTS (SELECT 1 FROM oauth_connection_projects x JOIN projects px ON px.id = x.project_id AND px.deleted_at IS NULL WHERE x.connection_id = c.id AND x.can_write = 1)
      WHERE c.id = ? AND c.revoked_at IS NULL AND c.expires_at > ? AND ${MANAGE}`).bind(...liveParams())
  ]).catch((e) => {
    if (/malformed JSON/i.test(String(e?.message ?? e))) throw new HttpError(409, "conflict", "The connection or your access changed while saving. Nothing was changed; reload and try again.");
    throw e;
  });
  return { ok: true, can_write: want.some((w) => w.can_write === 1), projects: want.map((w) => ({ project_id: w.project_id, access: accessName(w.can_write) })) };
}
/** Rename (PATCH /api/connections/{id}): the owner's name for it; the app's own client_name is never changed. */
async function renameConnection(ctx, connectionId, input) {
  requireHuman(ctx);
  const env = ctx.env, me2 = ctx.principal.id;
  const label = cleanConnectionName(input?.label);
  const conn = await env.DB.prepare(`SELECT c.id, c.revoked_at, c.expires_at, c.client_name, COALESCE(c.workspace_id, 'wsp_' || c.owner_principal_id) AS ws FROM oauth_connections c WHERE c.id = ? AND ${MANAGE}`).bind(connectionId, me2, me2).first();
  if (!conn) throw new HttpError(404, "not_found", "Connection not found");
  if (conn.revoked_at !== null || conn.expires_at <= nowMs()) throw new HttpError(409, "inactive", "Connection is disconnected or expired");
  const [r] = await env.DB.batch([
    env.DB.prepare(`UPDATE oauth_connections AS c SET label = ? WHERE c.id = ? AND c.revoked_at IS NULL AND c.expires_at > ? AND ${MANAGE}`).bind(label, connectionId, nowMs(), me2, me2),
    env.DB.prepare(`INSERT INTO audits (at, actor_id, project_id, action, object_id, result, request_id, workspace_id) SELECT ?, ?, NULL, 'oauth.rename', ?, 'ok', ?, ? WHERE changes() = 1`).bind(nowIso(), me2, connectionId, ctx.requestId, conn.ws)
  ]);
  if (!r.meta.changes) throw new HttpError(409, "inactive", "Connection is disconnected or expired");
  return { ok: true, label, display_name: label, client_name: conn.client_name };
}

export { ACCESS_LIST_MAX, listAccess, listConnections, renameConnection, revokeConnection, revokeConnectionById, setConnectionProjects };
