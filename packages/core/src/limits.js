// Workspace limits (Phase 4 entitlements; docs/limits.md). The entitlements adapter says what a workspace's plan
// allows (hosted: PLAN_LIMITS; self-host: unlimited). Core enforces each limit **inside the statement that writes**:
// every gated INSERT carries `AND <limitSql>` (or the upload reservation's quota clause), so two concurrent requests
// can never both pass a check that only one fits. A refusal is 402 limit_reached with { limit, used, allowed }.
// Over-limit workspaces (after a downgrade) keep everything; they just can't grow.
import { adapters } from "./adapters.js";
import { HttpError } from "./util.js";

/** The limit names an entitlements adapter may return (missing or null = unlimited). */
export const LIMIT_KEYS = ["storage_bytes", "projects", "members", "agents", "owned_workspaces"];
const LABEL = {
  storage_bytes: "storage", projects: "projects", members: "members (including pending invitations)",
  agents: "connected agents (apps, API keys and publishers)", owned_workspaces: "shared workspaces you own"
};

/**
 * Limits for a workspace: { storage_bytes?, projects?, members?, agents? } (numbers; absent = unlimited). Adapters
 * implement limits(env, { workspaceId }); the default (and self-host) has none.
 */
export async function workspaceLimits(env, workspaceId) {
  const f = adapters(env).entitlements.limits;
  if (typeof f !== "function") return {};
  const l = (await f(env, { workspaceId })) ?? {};
  return Object.fromEntries(LIMIT_KEYS.filter((k) => Number.isSafeInteger(l[k]) && l[k] >= 0).map((k) => [k, l[k]]));
}
export async function personLimits(env, principalId) {
  const f = adapters(env).entitlements.limits;
  if (typeof f !== "function") return {};
  const l = (await f(env, { principalId })) ?? {};
  return Number.isSafeInteger(l.owned_workspaces) && l.owned_workspaces >= 0 ? { owned_workspaces: l.owned_workspaces } : {};
}

// --- Usage, as SQL over one workspace (wsExpr: an SQL expression for the workspace id) ---------------------------
// Index-friendly: legacy rows (workspace_id NULL) belong to 'wsp_' || owner, matched via the owner index.
const inWs = (wsCol, ownerCol, ws) => `(${wsCol} = ${ws} OR (${wsCol} IS NULL AND ${ownerCol} = substr(${ws}, 5) AND 'wsp_' || ${ownerCol} = ${ws}))`;
// Storage counts every project's content until it's purged (deleted projects still hold their bytes for 30 days);
// the projects and grant counts are over live projects only (D21: a deleted project frees its slot at once).
const PROJECTS_OF = (ws) => `SELECT id FROM projects WHERE ${inWs("workspace_id", "owner_id", ws)}`;
const LIVE_PROJECTS_OF = (ws) => `${PROJECTS_OF(ws)} AND deleted_at IS NULL`;
const NOW_MS = "CAST(strftime('%s','now') AS INTEGER) * 1000";
/** Bytes stored: every revision (text and files) plus reservations in flight (uploads, staged app generations). */
export const usageSql = {
  storage_bytes: (ws) => `((SELECT COALESCE(SUM(size), 0) FROM revisions WHERE project_id IN (${PROJECTS_OF(ws)}))
    + (SELECT COALESCE(SUM(expected_size), 0) FROM uploads WHERE project_id IN (${PROJECTS_OF(ws)})
         AND (state IN ('receiving','sealed') OR (state IN ('pending','received') AND expires_at > ${NOW_MS})))
    + (SELECT COALESCE(SUM(total_bytes), 0) FROM publisher_generations WHERE project_id IN (${PROJECTS_OF(ws)}) AND state = 'staged' AND expires_at > ${NOW_MS}))`,
  projects: (ws) => `(SELECT COUNT(*) FROM (${LIVE_PROJECTS_OF(ws)}))`,
  members: (ws) => `((SELECT COUNT(*) FROM workspace_members WHERE workspace_id = ${ws})
    + (SELECT COUNT(*) FROM workspace_invites WHERE workspace_id = ${ws} AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > CAST(strftime('%s','now') AS INTEGER) * 1000))`,
  // Live OAuth connections, API keys, publishing apps and (legacy) project grant tokens.
  agents: (ws) => `((SELECT COUNT(*) FROM oauth_connections c WHERE ${inWs("c.workspace_id", "c.owner_principal_id", ws)} AND c.revoked_at IS NULL AND c.expires_at > ${NOW_MS})
    + (SELECT COUNT(*) FROM api_credentials k WHERE ${inWs("k.workspace_id", "k.owner_principal_id", ws)} AND k.revoked_at IS NULL AND k.expires_at > ${NOW_MS})
    + (SELECT COUNT(*) FROM publishers p WHERE ${inWs("p.workspace_id", "p.owner_principal_id", ws)} AND p.revoked_at IS NULL)
    + (SELECT COUNT(*) FROM grants g WHERE g.project_id IN (${LIVE_PROJECTS_OF(ws)}) AND g.revoked_at IS NULL AND g.expires_at > ${NOW_MS}))`,
  owned_workspaces: (who) => `(SELECT COUNT(*) FROM workspaces w WHERE w.created_by = ${who} AND w.personal = 0 AND w.status <> 'deleting')`
};

/**
 * SQL guard for one write: "usage + adding <= limit" for each named limit the workspace has ("1" when unlimited).
 * ws: SQL expression (usually "?") bound to params[0..]. Returns { sql, params, limits } to splice into the WHERE.
 */
export async function limitGuard(env, workspaceId, adds) {
  const lim = await workspaceLimits(env, workspaceId);
  const parts = [], params = [];
  for (const [k, n] of Object.entries(adds)) {
    if (lim[k] === undefined) continue;
    const s = usageSql[k]("?");
    const count = (s.match(/\?/g) ?? []).length;
    parts.push(`${s} + ? <= ?`);
    params.push(...Array(count).fill(workspaceId), n, lim[k]);
  }
  return { sql: parts.length ? parts.join(" AND ") : "1", params, limits: lim };
}

/** After a guarded write changed nothing: if a limit is why, throw 402 limit_reached (else return to the caller). */
export async function explainLimit(env, workspaceId, adds, limits) {
  for (const [k, n] of Object.entries(adds)) {
    if (limits?.[k] === undefined) continue;
    const s = usageSql[k]("?");
    const used = await env.DB.prepare(`SELECT ${s} AS n`).bind(...Array((s.match(/\?/g) ?? []).length).fill(workspaceId)).first("n");
    if ((used ?? 0) + n > limits[k]) throw limitError(k, used ?? 0, limits[k]);
  }
}
// What frees room, per limit (no in-app upgrade yet; owners/admins can do these).
const FIX = {
  storage_bytes: "Delete documents or files you no longer need (deleted items stop counting once they're removed from the trash, and deleted projects once they're deleted permanently under Recently deleted), or ask the workspace owner about a bigger plan.",
  projects: "Delete a project you no longer need (Project settings), or ask the workspace owner about a bigger plan.",
  members: "Cancel a pending invitation or remove a member, or ask the workspace owner about a bigger plan.",
  agents: "Disconnect an app or revoke an API key you no longer use (Connections), or ask the workspace owner about a bigger plan.",
  owned_workspaces: "Delete a shared workspace you no longer need."
};
export function limitError(k, used, allowed) {
  return new HttpError(402, "limit_reached", `This workspace has reached its limit for ${LABEL[k] ?? k} (${k === "storage_bytes" ? fmtBytes(allowed) : allowed}). ${FIX[k] ?? ""}`.trim(),
    { limit: k, used, allowed });
}
/** Same scale and wording as the app's usage panel (1024-based, "KB/MB/GB", one decimal). */
export const fmtBytes = (n) => {
  const u = [[1073741824, "GB"], [1048576, "MB"], [1024, "KB"]].find(([d]) => n >= d);
  return u ? `${+(n / u[0]).toFixed(1)} ${u[1]}` : `${n} bytes`;
};

/** Current usage and limits of a workspace (for the app and GET /api/workspaces/:id/usage). */
export async function workspaceUsage(env, workspaceId, role = "viewer") {
  const limits = await workspaceLimits(env, workspaceId);
  // Billing (plan, payment status, upgrade/manage links) is for admins and owners only.
  const billing = role === "admin" || role === "owner" ? await adapters(env).entitlements.billing?.(env, { workspaceId }) ?? null : null;
  const keys = ["storage_bytes", "projects", "members", "agents"];
  const row = await env.DB.prepare(`SELECT ${keys.map((k) => `${usageSql[k]("?1")} AS ${k}`).join(", ")}`).bind(workspaceId).first();
  return { ...Object.fromEntries(keys.map((k) => [k, { used: row?.[k] ?? 0, limit: limits[k] ?? null }])), ...billing ? { billing } : {} };
}

/** limitGuard for a write inside an existing project (its workspace resolved the same way as everywhere else). */
export async function projectLimitGuard(env, projectId, adds) {
  const ws = await env.DB.prepare("SELECT COALESCE(workspace_id, 'wsp_' || owner_id) AS w FROM projects WHERE id = ?").bind(projectId).first("w");
  if (!ws) return { sql: "1", params: [], limits: {}, workspaceId: null };
  return { ...await limitGuard(env, ws, adds), workspaceId: ws };
}
/** Owned shared workspaces guard (per person). */
export async function ownedWorkspacesGuard(env, principalId) {
  const lim = await personLimits(env, principalId);
  if (lim.owned_workspaces === undefined) return { sql: "1", params: [], limits: {} };
  return { sql: `${usageSql.owned_workspaces("?")} + 1 <= ?`, params: [principalId, lim.owned_workspaces], limits: lim };
}

/**
 * Entitlements from the PLAN_LIMITS var: JSON { "<plan>": { storage_bytes, projects, members, agents,
 * owned_workspaces }, ... }. A workspace's plan is workspaces.plan ("free" by default; billing sets it). A plan that
 * isn't listed, or a limit that's missing, is unlimited; PLAN_LIMITS unset = no limits at all. owned_workspaces is per
 * person and uses the "free" plan's number (people have no plan of their own yet).
 */
export const planEntitlements = {
  name: "plan-limits",
  async check() {},
  async limits(env, { workspaceId, principalId } = {}) {
    let plans;
    try { plans = env.PLAN_LIMITS ? JSON.parse(env.PLAN_LIMITS) : null; } catch { console.error("plan_limits_invalid"); plans = null; }
    if (!plans || typeof plans !== "object") return {};
    if (principalId && !workspaceId) return { owned_workspaces: plans.free?.owned_workspaces };
    const plan = await env.DB.prepare("SELECT plan FROM workspaces WHERE id = ?").bind(workspaceId).first("plan");
    return plans[plan ?? "free"] ?? {};
  }
};
