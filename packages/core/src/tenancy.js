// Workspaces, members and roles (docs/workspaces.md). D1 is the only source of access: a human reaches a project
// only through workspace_members of the project's workspace (optionally narrowed by project_members), and every
// delegated credential (OAuth connection, API key, legacy grant, publisher) works only while the human who created
// it still has enough role there. All checks are SQL fragments evaluated in the same statement as the operation,
// so removal or demotion takes effect on the very next request.
import { adapters } from "./adapters.js";
import { HttpError } from "./util.js";

export const ROLES = ["viewer", "member", "admin", "owner"];
/**
 * Can more than one person sign in? The identity adapter decides (self-host behind Cloudflare Access admits only
 * OWNER_EMAIL, so it is single-user; local dev with no provider is multi-user so the flows can be tested).
 * MULTI_USER=1 / MULTI_USER=0 override it.
 */
export function multiUserInstall(env) {
  if (env?.MULTI_USER === "1") return true;
  if (env?.MULTI_USER === "0") return false;
  return !!adapters(env).identity.multiUser(env);
}
export const ROLE_RANK = { none: 0, viewer: 1, member: 2, admin: 3, owner: 4 };
/** Minimum role for an operation class. */
export const NEED = { read: "viewer", write: "member", manage: "admin", own: "owner" };

/** Workspace of a project, also for rows written before migration 0017 (workspace_id NULL). SQL expression. */
export const projectWorkspaceSql = (alias) => `COALESCE(${alias}.workspace_id, 'wsp_' || ${alias}.owner_id)`;
export const personalWorkspaceId = (principalId) => `wsp_${principalId}`;

/**
 * Suspended workspaces are read-only (decisions D11 B / D13 A): reading (viewer) works, writing and most
 * administration need an active workspace. A few cleanup actions pass allowSuspended=true explicitly (revoking
 * credentials, removing members, export, audit). 'deleting' workspaces are closed to everything.
 */
const statusOk = (alias, allowSuspended) => allowSuspended ? `${alias}.status IN ('active','suspended')` : `${alias}.status = 'active'`;
const rankCase = (expr) => `CASE ${expr} WHEN 'owner' THEN 4 WHEN 'admin' THEN 3 WHEN 'member' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END`;

/**
 * SQL: does the human `principalExpr` have at least `need` on the project `projectIdExpr`?
 * Both are SQL expressions ("?" placeholders are bound by the caller, principal first, then project).
 * Effective role = workspace role, capped by a project_members row if present; the workspace must be active.
 */
export function memberRoleSql(projectIdExpr, need, principalExpr = "?", allowSuspended = need === "viewer") {
  const min = ROLE_RANK[need];
  if (!min) throw new Error("bad role " + need);
  return `EXISTS (SELECT 1 FROM projects t_p
      JOIN workspaces t_w ON t_w.id = ${projectWorkspaceSql("t_p")}
      JOIN workspace_members t_m ON t_m.workspace_id = t_w.id AND t_m.principal_id = ${principalExpr}
      LEFT JOIN project_members t_pm ON t_pm.project_id = t_p.id AND t_pm.principal_id = t_m.principal_id
      WHERE t_p.id = ${projectIdExpr} AND ${statusOk("t_w", allowSuspended)}
        AND MIN(${rankCase("t_m.role")}, CASE WHEN t_pm.role IS NULL THEN 4 ELSE ${rankCase("t_pm.role")} END) >= ${min})`;
}

/** SQL: human `principalExpr` has at least `need` in active workspace `workspaceExpr` (both SQL expressions). */
export function workspaceRoleSql(workspaceExpr, need, principalExpr = "?", allowSuspended = need === "viewer") {
  return `EXISTS (SELECT 1 FROM workspaces t_w JOIN workspace_members t_m ON t_m.workspace_id = t_w.id AND t_m.principal_id = ${principalExpr}
      WHERE t_w.id = ${workspaceExpr} AND ${statusOk("t_w", allowSuspended)} AND ${rankCase("t_m.role")} >= ${ROLE_RANK[need]})`;
}

/** SQL fragment + params: human principal has `need` on project `projectId`. */
export function humanGate(principalId, projectId, need) {
  return { sql: memberRoleSql("?", need), params: [principalId, projectId] };
}

/** Role of a principal in a workspace (null if not a member). */
export async function workspaceRole(env, workspaceId, principalId) {
  return env.DB.prepare("SELECT role FROM workspace_members WHERE workspace_id = ? AND principal_id = ?").bind(workspaceId, principalId).first("role");
}

/** Workspace row a project belongs to, or null. */
export async function projectWorkspace(env, projectId) {
  return env.DB.prepare(`SELECT w.* FROM projects p JOIN workspaces w ON w.id = ${projectWorkspaceSql("p")} WHERE p.id = ?`).bind(projectId).first();
}

export const readOnlyError = () => new HttpError(403, "workspace_read_only", "This workspace is suspended and read-only. Reading and export still work.");

/** Throw unless the human has `need` in the workspace (404 when not a member at all, 403 when the role is too low). */
export async function requireWorkspaceRole(ctx, workspaceId, need, allowSuspended = need === "viewer") {
  if (ctx.principal.kind !== "human") throw new HttpError(403, "forbidden", "People only");
  const ws = await ctx.env.DB.prepare(
    "SELECT w.id, w.status, w.personal, w.name, w.handle, m.role FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id AND m.principal_id = ? WHERE w.id = ?"
  ).bind(ctx.principal.id, workspaceId).first();
  if (!ws || ws.status === "deleting") throw new HttpError(404, "not_found", "Workspace not found");
  if (ws.status !== "active" && !allowSuspended) throw readOnlyError();
  if (ROLE_RANK[ws.role] < ROLE_RANK[need]) throw new HttpError(403, "forbidden", `Needs the ${need} role in this workspace`);
  return ws;
}

/**
 * Human's effective role on a project, or null when the project is unknown or not visible to them.
 * Returns { role, workspace_id, status }.
 */
export async function projectRole(env, principalId, projectId) {
  return env.DB.prepare(
    `SELECT t_w.id AS workspace_id, t_w.status,
       CASE MIN(${rankCase("t_m.role")}, CASE WHEN t_pm.role IS NULL THEN 4 ELSE ${rankCase("t_pm.role")} END)
         WHEN 4 THEN 'owner' WHEN 3 THEN 'admin' WHEN 2 THEN 'member' WHEN 1 THEN 'viewer' ELSE NULL END AS role
     FROM projects t_p JOIN workspaces t_w ON t_w.id = ${projectWorkspaceSql("t_p")}
     JOIN workspace_members t_m ON t_m.workspace_id = t_w.id AND t_m.principal_id = ?
     LEFT JOIN project_members t_pm ON t_pm.project_id = t_p.id AND t_pm.principal_id = t_m.principal_id
     WHERE t_p.id = ?`
  ).bind(principalId, projectId).first();
}

/** Throw 404 / 403 unless the human has `need` on the project. */
export async function requireProjectRole(ctx, projectId, need, allowSuspended = need === "viewer") {
  const r = await projectRole(ctx.env, ctx.principal.id, projectId);
  if (!r || !r.role || r.status === "deleting") throw new HttpError(404, "not_found", "Project not found");
  if (r.status !== "active" && !allowSuspended) throw readOnlyError();
  if (ROLE_RANK[r.role] < ROLE_RANK[need]) throw new HttpError(403, "forbidden", need === "write" || need === "member" ? "Your role in this workspace is read-only" : `Needs the ${need} role`);
  return r;
}

/**
 * Projects a human can see, with their effective role (excludes 'none' and deleting workspaces; suspended ones are
 * included as read-only, see workspace_status).
 * Driven from the person's memberships: projects_workspace serves current rows, projects_owner_legacy (0018) the
 * rows a rolled-back Worker wrote without workspace_id (they belong to the owner's personal workspace).
 */
export async function visibleProjects(env, principalId) {
  const cols = `t_p.id, t_p.title, t_p.slug, t_p.created_at, t_w.id AS workspace_id, t_w.name AS workspace_name, t_w.handle AS workspace_handle, t_w.personal, t_w.status AS workspace_status, t_w.created_at AS ws_created, t_m.role AS ws_role,
       CASE MIN(${rankCase("t_m.role")}, CASE WHEN t_pm.role IS NULL THEN 4 ELSE ${rankCase("t_pm.role")} END)
         WHEN 4 THEN 'owner' WHEN 3 THEN 'admin' WHEN 2 THEN 'member' WHEN 1 THEN 'viewer' ELSE NULL END AS role`;
  const from = (join) => `FROM workspace_members t_m JOIN workspaces t_w ON t_w.id = t_m.workspace_id AND ${statusOk("t_w", true)}
     JOIN projects t_p ON ${join}
     LEFT JOIN project_members t_pm ON t_pm.project_id = t_p.id AND t_pm.principal_id = t_m.principal_id
     WHERE t_m.principal_id = ?`;
  const r = await env.DB.prepare(
    `SELECT * FROM (SELECT ${cols} ${from("t_p.workspace_id = t_w.id")}
     UNION ALL SELECT ${cols} ${from("t_p.workspace_id IS NULL AND t_w.personal = 1 AND t_p.owner_id = substr(t_w.id, 5)")})
     ORDER BY personal DESC, ws_created, created_at LIMIT 1000`
  ).bind(principalId, principalId).all();
  return r.results.filter((p) => p.role);
}
