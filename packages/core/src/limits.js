// Workspace limits (Phase 4 entitlements; docs/limits.md). The entitlements adapter says what a workspace's plan
// allows (hosted: PLAN_LIMITS; self-host: unlimited). Core enforces each limit **inside the statement that writes**:
// every gated INSERT carries `AND <limitSql>` (or the upload reservation's quota clause), so two concurrent requests
// can never both pass a check that only one fits. A refusal is 402 limit_reached with { limit, used, allowed }.
// Over-limit workspaces (after a downgrade) keep everything; they just can't grow.
import { adapters } from "./adapters.js";
import { HttpError } from "./util.js";

/**
 * The limit names an entitlements adapter may return (missing or null = unlimited, except where core has a default:
 * items_per_project, file_bytes and rate_multiplier). items_per_project is counted per project; rate_multiplier
 * multiplies the agent rate limits; max_key_lifetime_days caps API key lifetimes.
 */
export const LIMIT_KEYS = ["storage_bytes", "projects", "members", "pending_invites", "agents", "owned_workspaces",
  "items_per_project", "file_bytes", "rate_multiplier", "max_key_lifetime_days"];
const LABEL = {
  storage_bytes: "storage", projects: "projects", members: "members", pending_invites: "pending invitations",
  agents: "connected agents (apps, API keys and publishers)", owned_workspaces: "shared workspaces you own",
  items_per_project: "documents and files in one project"
};
/**
 * Largest file core accepts, whatever the configuration: Cloudflare refuses request bodies over 100 MB, and a file
 * travels in one PUT, so 90 MiB leaves room for the request around it.
 */
export const FILE_BYTES_CEILING = 90 * 1024 * 1024;
const envInt = (v, d) => typeof v === "string" && /^\d{1,12}$/.test(v) ? Number(v) : d;
/** Core defaults when the entitlements adapter gives no value (self-host): Worker vars, else these numbers. */
export const defaultLimits = (env) => ({
  items_per_project: envInt(env.PROJECT_ITEMS_MAX, 10000),
  file_bytes: Math.min(envInt(env.FILE_MAX_BYTES, 25 * 1024 * 1024), FILE_BYTES_CEILING),
  rate_multiplier: 1
});

/**
 * Limits for a workspace: the adapter's numbers (absent = unlimited) plus core's defaults for items_per_project,
 * file_bytes (never above FILE_BYTES_CEILING) and rate_multiplier (>= 1). Adapters implement
 * limits(env, { workspaceId }); the default (and self-host) has none.
 */
export async function workspaceLimits(env, workspaceId) {
  // Within one request (withRequestMemo) each workspace's limits are read once; never cached across requests.
  const memo = env?.[LIMITS_MEMO];
  if (!memo) return readWorkspaceLimits(env, workspaceId);
  if (!memo.has(workspaceId)) memo.set(workspaceId, readWorkspaceLimits(env, workspaceId).catch((e) => { memo.delete(workspaceId); throw e; }));
  return memo.get(workspaceId);
}
const LIMITS_MEMO = Symbol("agent-library.limits-memo");
/** A request's env with its own workspace-limits memo (createWorker attaches one per fetch). */
export const withRequestMemo = (env) => ({ ...env, [LIMITS_MEMO]: new Map() });
async function readWorkspaceLimits(env, workspaceId) {
  const f = adapters(env).entitlements.limits;
  const l = (typeof f === "function" ? await f(env, { workspaceId }) : null) ?? {};
  const out = Object.fromEntries(LIMIT_KEYS.filter((k) => Number.isSafeInteger(l[k]) && l[k] >= (k === "rate_multiplier" ? 1 : 0)).map((k) => [k, l[k]]));
  const d = defaultLimits(env);
  return { ...d, ...out, file_bytes: Math.min(out.file_bytes ?? d.file_bytes, FILE_BYTES_CEILING) };
}
/** Workspace of a project (legacy rows: the owner's personal workspace), or null. */
export async function projectWorkspaceId(env, projectId) {
  return await env.DB.prepare("SELECT COALESCE(workspace_id, 'wsp_' || owner_id) AS w FROM projects WHERE id = ?").bind(projectId).first("w") ?? null;
}
/** The plan's agent rate-limit multiplier for a workspace (1 when unknown). */
export async function rateMultiplier(env, workspaceId) {
  if (!workspaceId) return 1;
  try { return (await workspaceLimits(env, workspaceId)).rate_multiplier ?? 1; }
  catch { console.error(JSON.stringify({ event: "rate_multiplier_unavailable" })); return 1; }
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
  // Accepted members only; live pending invitations are their own limit.
  members: (ws) => `(SELECT COUNT(*) FROM workspace_members WHERE workspace_id = ${ws})`,
  pending_invites: (ws) => `(SELECT COUNT(*) FROM workspace_invites WHERE workspace_id = ${ws} AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ${NOW_MS})`,
  // Live OAuth connections, API keys, publishing apps and (legacy) project grant tokens.
  agents: (ws) => `((SELECT COUNT(*) FROM oauth_connections c WHERE ${inWs("c.workspace_id", "c.owner_principal_id", ws)} AND c.revoked_at IS NULL AND c.expires_at > ${NOW_MS})
    + (SELECT COUNT(*) FROM api_credentials k WHERE ${inWs("k.workspace_id", "k.owner_principal_id", ws)} AND k.revoked_at IS NULL AND k.expires_at > ${NOW_MS})
    + (SELECT COUNT(*) FROM publishers p WHERE ${inWs("p.workspace_id", "p.owner_principal_id", ws)} AND p.revoked_at IS NULL)
    + (SELECT COUNT(*) FROM grants g WHERE g.project_id IN (${LIVE_PROJECTS_OF(ws)}) AND g.revoked_at IS NULL AND g.expires_at > ${NOW_MS}))`,
  owned_workspaces: (who) => `(SELECT COUNT(*) FROM workspaces w WHERE w.created_by = ${who} AND w.personal = 0 AND w.status <> 'deleting')`,
  // Per project (the expression is a project id): documents and files, including trashed ones and upload placeholders.
  items_per_project: (pj) => `(SELECT COUNT(*) FROM artifacts WHERE project_id = ${pj} AND publisher_id IS NULL)`
};
// The id each usage expression is evaluated over: the project for items_per_project, else the workspace.
const scopeOf = (k, workspaceId, projectId) => k === "items_per_project" ? projectId : workspaceId;

/**
 * SQL guard for one write, given the workspace's limits: "usage + adding <= limit" for each named limit it has ("1"
 * when unlimited). Returns { sql, params } to splice into the WHERE. projectId: needed for items_per_project.
 */
export function guardSql(limits, workspaceId, adds, projectId) {
  const parts = [], params = [];
  for (const [k, n] of Object.entries(adds)) {
    if (limits[k] === undefined) continue;
    const s = usageSql[k]("?");
    const count = (s.match(/\?/g) ?? []).length;
    parts.push(`${s} + ? <= ?`);
    params.push(...Array(count).fill(scopeOf(k, workspaceId, projectId)), n, limits[k]);
  }
  return { sql: parts.length ? parts.join(" AND ") : "1", params };
}
/** guardSql with the workspace's limits looked up. Returns { sql, params, limits }. */
export async function limitGuard(env, workspaceId, adds, projectId) {
  const lim = await workspaceLimits(env, workspaceId);
  return { ...guardSql(lim, workspaceId, adds, projectId), limits: lim };
}

/** Current usage for one limit (projectId: for items_per_project). */
export async function usageOf(env, k, workspaceId, projectId) {
  const s = usageSql[k]("?");
  return await env.DB.prepare(`SELECT ${s} AS n`).bind(...Array((s.match(/\?/g) ?? []).length).fill(scopeOf(k, workspaceId, projectId))).first("n") ?? 0;
}
/** After a guarded write changed nothing: if a limit is why, throw 402 limit_reached (else return to the caller). */
export async function explainLimit(env, workspaceId, adds, limits, projectId) {
  for (const [k, n] of Object.entries(adds)) {
    if (limits?.[k] === undefined) continue;
    const used = await usageOf(env, k, workspaceId, projectId);
    if (used + n > limits[k]) throw limitError(k, used, limits[k]);
  }
}
// What frees room, per limit (no in-app upgrade yet; owners/admins can do these).
const FIX = {
  storage_bytes: "Delete documents or files you no longer need (deleted items stop counting once they're removed from the trash, and deleted projects once they're deleted permanently under Recently deleted), or ask the workspace owner about a bigger plan.",
  projects: "Delete a project you no longer need (Project settings), or ask the workspace owner about a bigger plan.",
  members: "Remove a member you no longer work with, or ask the workspace owner about a bigger plan.",
  pending_invites: "Cancel a pending invitation you no longer need (Pending invitations), or ask the workspace owner about a bigger plan.",
  items_per_project: "Delete or empty the trash of documents you no longer need in this project, or ask the workspace owner about a bigger plan.",
  agents: "Disconnect an app or revoke an API key you no longer use (Connections), or ask the workspace owner about a bigger plan.",
  owned_workspaces: "Delete a shared workspace you no longer need."
};
export function limitError(k, used, allowed) {
  return new HttpError(402, "limit_reached", `This workspace has reached its limit for ${LABEL[k] ?? k} (${k === "storage_bytes" ? fmtBytes(allowed) : allowed}). ${FIX[k] ?? ""}`.trim(),
    { limit: k, used, allowed });
}
/** 413 for a file over the plan's file_bytes. */
export function fileTooLarge(allowed) {
  return new HttpError(413, "too_large", `Files can be up to ${fmtBytes(allowed)} on this plan`, { limit: "file_bytes", allowed });
}
/** Same scale and wording as the app's usage panel (1024-based, "KB/MB/GB", one decimal). */
export const fmtBytes = (n) => {
  const u = [[1073741824, "GB"], [1048576, "MB"], [1024, "KB"]].find(([d]) => n >= d);
  return u ? `${+(n / u[0]).toFixed(1)} ${u[1]}` : `${n} bytes`;
};

/**
 * Current usage and limits of a workspace (for the app and GET /api/workspaces/:id/usage). Also the per-file and
 * key-lifetime limits ({ limit }, null = unlimited), so the app can say what fits.
 */
export async function workspaceUsage(env, workspaceId, role = "viewer") {
  const limits = await workspaceLimits(env, workspaceId);
  // Billing (plan, payment status, upgrade/manage links) is for admins and owners only.
  const billing = role === "admin" || role === "owner" ? await adapters(env).entitlements.billing?.(env, { workspaceId }) ?? null : null;
  const keys = ["storage_bytes", "projects", "members", "pending_invites", "agents"];
  const row = await env.DB.prepare(`SELECT ${keys.map((k) => `${usageSql[k]("?1")} AS ${k}`).join(", ")}`).bind(workspaceId).first();
  return { ...Object.fromEntries(keys.map((k) => [k, { used: row?.[k] ?? 0, limit: limits[k] ?? null }])),
    file_bytes: { limit: limits.file_bytes }, max_key_lifetime_days: { limit: limits.max_key_lifetime_days ?? null }, ...billing ? { billing } : {} };
}

/**
 * limitGuard for a write inside an existing project (its workspace resolved the same way as everywhere else).
 * Unknown project: no guard, but core's default limits (the write's own authorization refuses it anyway).
 */
export async function projectLimitGuard(env, projectId, adds) {
  const ws = await projectWorkspaceId(env, projectId);
  if (!ws) return { sql: "1", params: [], limits: defaultLimits(env), workspaceId: null, projectId };
  return { ...await limitGuard(env, ws, adds, projectId), workspaceId: ws, projectId };
}
/** Owned shared workspaces guard (per person). */
export async function ownedWorkspacesGuard(env, principalId) {
  const lim = await personLimits(env, principalId);
  if (lim.owned_workspaces === undefined) return { sql: "1", params: [], limits: {} };
  return { sql: `${usageSql.owned_workspaces("?")} + 1 <= ?`, params: [principalId, lim.owned_workspaces], limits: lim };
}

/**
 * Entitlements from the PLAN_LIMITS var: JSON { "<plan>": { <LIMIT_KEYS>... }, ... }. A workspace's plan is
 * workspaces.plan ("free" by default; billing sets it). A plan that isn't listed, or a limit that's missing, is
 * unlimited (or core's default); PLAN_LIMITS unset = no plan limits at all. owned_workspaces is per person: the plan
 * of the person's personal workspace (billing can upgrade it), falling back to the "free" plan's number.
 */
export const planEntitlements = {
  name: "plan-limits",
  async check() {},
  async limits(env, { workspaceId, principalId } = {}) {
    let plans;
    try { plans = env.PLAN_LIMITS ? JSON.parse(env.PLAN_LIMITS) : null; } catch { console.error("plan_limits_invalid"); plans = null; }
    if (!plans || typeof plans !== "object") return {};
    if (principalId && !workspaceId) {
      const own = await env.DB.prepare("SELECT plan FROM workspaces WHERE id = ?").bind(`wsp_${principalId}`).first("plan");
      // A listed plan without owned_workspaces is unlimited, as for every other limit; no or an unlisted plan uses free's.
      const plan = own ?? "free";
      return { owned_workspaces: plans[plan] ? plans[plan].owned_workspaces : plans.free?.owned_workspaces };
    }
    const plan = await env.DB.prepare("SELECT plan FROM workspaces WHERE id = ?").bind(workspaceId).first("plan");
    return plans[plan ?? "free"] ?? {};
  }
};
