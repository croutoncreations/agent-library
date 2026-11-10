import { requireHuman } from "../auth.js";
import { ROLE_RANK, memberRoleSql, projectRole, workspaceRoleSql, readOnlyError } from "../tenancy.js";
import { HttpError, NEVER_EXPIRES_AT, cutLists, nowIso, nowMs, randomId, sha256Hex, str } from "../util.js";
import { explainLimit, limitGuard, workspaceLimits } from "../limits.js";


// "never": expires_at = NEVER_EXPIRES_AT (the same far-future value as OAuth connections). A plan's
// max_key_lifetime_days caps the choice (absent = any, including never).
var KEY_LIFETIMES_DAYS = [1, 7, 30, 90, 365, "never"];
var DEFAULT_LIFETIME_DAYS = 90;
var MAX_PROJECTS_PER_KEY = 50;
var KEY_RE = /^alk_[A-Za-z0-9_-]{43}$/;
// A key is managed by the person who created it, or an admin of its workspace. Columns are qualified: inside
// workspaceRoleSql a bare workspace_id would bind to workspace_members.workspace_id (any admin anywhere).
var KEY_MANAGER = `(COALESCE(k.created_by, k.owner_principal_id) = ? OR ${workspaceRoleSql("COALESCE(k.workspace_id, 'wsp_' || k.owner_principal_id)", "admin", "?", true)})`; // list/revoke work while suspended
async function validateScope(env, ownerId, raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_PROJECTS_PER_KEY)
    throw new HttpError(400, "invalid_input", `projects must list 1-${MAX_PROJECTS_PER_KEY} projects`);
  const seen = /* @__PURE__ */ new Set();
  const out2 = [];
  for (const r of raw) {
    const pid = str(r?.project_id, "project_id", 64);
    if (seen.has(pid)) throw new HttpError(400, "invalid_input", "Duplicate project in scope");
    seen.add(pid);
    if (r.access !== "read" && r.access !== "read_write") throw new HttpError(400, "invalid_input", "access must be read or read_write");
    out2.push({ project_id: pid, can_write: r.access === "read_write" });
  }
  // Every project must be visible to the creator, all in one workspace, and read_write needs member or above.
  const roles = await Promise.all(out2.map((s) => projectRole(env, ownerId, s.project_id)));
  if (roles.some((r) => !r || !r.role || r.status === "deleting")) throw new HttpError(404, "not_found", "Project not found");
  // Suspended (read-only) workspaces: no new, replaced or rescoped keys at all (existing keys keep reading).
  if (roles.some((r) => r.status !== "active")) throw readOnlyError();
  if (new Set(roles.map((r) => r.workspace_id)).size !== 1) throw new HttpError(400, "invalid_input", "A key covers projects from one workspace");
  if (out2.some((s, i) => s.can_write && ROLE_RANK[roles[i].role] < ROLE_RANK.member)) throw new HttpError(403, "forbidden", "Your role in this workspace is read-only");
  out2.workspaceId = roles[0].workspace_id;
  return out2;
}
function lifetime(raw) {
  const d = raw === void 0 ? DEFAULT_LIFETIME_DAYS : raw === "never" ? "never" : Number(raw);
  if (!KEY_LIFETIMES_DAYS.includes(d)) throw new HttpError(400, "invalid_input", `lifetime_days must be one of ${KEY_LIFETIMES_DAYS.join(", ")}`);
  return d;
}
/** The workspace plan's max_key_lifetime_days: refuses a longer lifetime (402 limit_reached). */
async function checkLifetime(env, workspaceId, days) {
  const max = (await workspaceLimits(env, workspaceId)).max_key_lifetime_days;
  if (max === undefined || (days !== "never" && days <= max)) return;
  throw new HttpError(402, "limit_reached", `Keys on this plan can last up to ${max} day${max === 1 ? "" : "s"}. Choose a shorter lifetime and replace the key before it expires, or ask the workspace owner about a bigger plan.`,
    { limit: "max_key_lifetime_days", allowed: max });
}
function auditStmt(env, ctx, projectId, action, objectId, result, gate, gateParams = []) {
  if (gate) return env.DB.prepare(`INSERT INTO audits (at, actor_id, project_id, action, object_id, result, request_id) SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${gate}`).bind(nowIso(), ctx.principal.id, projectId, action, objectId, result, ctx.requestId, ...gateParams);
  return env.DB.prepare("INSERT INTO audits (at, actor_id, project_id, action, object_id, result, request_id) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(nowIso(), ctx.principal.id, projectId, action, objectId, result, ctx.requestId);
}
async function insertKey(ctx, label, days, scope, replacesId) {
  const env = ctx.env;
  const secret = randomId("alk", 32);
  const id = randomId("akey", 12);
  const principalId = randomId("agt");
  await checkLifetime(env, scope.workspaceId, days);
  const expires = days === "never" ? NEVER_EXPIRES_AT : nowMs() + days * 864e5;
  // Connected-agents limit (Phase 4), checked in the INSERT; the rows after it are gated on the key existing.
  const lg = await limitGuard(env, scope.workspaceId, { agents: 1 });
  const exists = "EXISTS (SELECT 1 FROM api_credentials WHERE id = ?)";
  const [prin] = await env.DB.batch([
    // The agent principal is written only while the limit has room; the key row needs it (principal_id).
    env.DB.prepare(`INSERT INTO principals (id, kind, issuer, subject, label, created_at) SELECT ?, 'agent', 'agent-library-api', ?, ?, ? WHERE ${lg.sql}`).bind(principalId, principalId, label, nowIso(), ...lg.params),
    env.DB.prepare(`INSERT INTO api_credentials (id, owner_principal_id, principal_id, label, token_hash, created_at, expires_at, replaces_id, workspace_id, created_by)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM principals WHERE id = ?)`).bind(id, ctx.principal.id, principalId, label, await sha256Hex(secret), nowIso(), expires, replacesId, scope.workspaceId, ctx.principal.id, principalId),
    ...scope.map((s) => env.DB.prepare(`INSERT INTO api_credential_projects (credential_id, project_id, can_write) SELECT ?, ?, ? WHERE ${exists}`).bind(id, s.project_id, s.can_write ? 1 : 0, id)),
    ...scope.map((s) => auditStmt(env, ctx, s.project_id, replacesId ? "apikey.replace" : "apikey.create", id, s.can_write ? "ok:read_write" : "ok:read", exists, [id]))
  ]);
  if (!prin.meta.changes) {
    await explainLimit(env, scope.workspaceId, { agents: 1 }, lg.limits);
    throw new HttpError(409, "conflict", "The key couldn't be created; try again");
  }
  return { id, label, expires_at: new Date(expires).toISOString(), projects: scope.map((s) => ({ project_id: s.project_id, access: s.can_write ? "read_write" : "read" })), secret };
}
async function createApiKey(ctx, input) {
  requireHuman(ctx);
  const label = str(input?.label, "label", 80, { min: 1 });
  const days = lifetime(input?.lifetime_days);
  const scope = await validateScope(ctx.env, ctx.principal.id, input?.projects);
  return insertKey(ctx, label, days, scope, null);
}
async function ownKey(ctx, id) {
  // The creator, or an admin of the key's workspace, manages a key. Anyone else gets 404.
  const k = await ctx.env.DB.prepare(`SELECT k.* FROM api_credentials k WHERE k.id = ? AND ${KEY_MANAGER}`).bind(id, ctx.principal.id, ctx.principal.id).first();
  if (!k) throw new HttpError(404, "not_found", "API key not found");
  return k;
}
/** The API keys list shows at most this many keys (the UI's "Showing the first N" note uses the same number). */
const API_KEYS_LIST_MAX = 200;
async function listApiKeys(ctx) {
  requireHuman(ctx);
  // Keys I created, plus every key in workspaces where I'm an admin.
  const mine = `SELECT k.id FROM api_credentials k WHERE ${KEY_MANAGER} ORDER BY k.created_at DESC LIMIT ${API_KEYS_LIST_MAX + 1}`;
  const keys = await ctx.env.DB.prepare(`SELECT * FROM api_credentials WHERE id IN (${mine}) ORDER BY created_at DESC`).bind(ctx.principal.id, ctx.principal.id).all();
  const scopes = await ctx.env.DB.prepare(
    `SELECT acp.credential_id, acp.project_id, acp.can_write, p.title FROM api_credential_projects acp
     JOIN projects p ON p.id = acp.project_id AND p.deleted_at IS NULL
     WHERE acp.credential_id IN (${mine})`
  ).bind(ctx.principal.id, ctx.principal.id).all();
  const now = nowMs();
  return { keys: keys.results.slice(0, API_KEYS_LIST_MAX).map((k) => ({
    id: k.id,
    label: k.label,
    created_at: k.created_at,
    expires_at: new Date(k.expires_at).toISOString(),
    last_used_at: k.last_used_at ? new Date(k.last_used_at).toISOString() : null,
    replaces_id: k.replaces_id,
    status: k.revoked_at !== null ? "revoked" : k.expires_at <= now ? "expired" : "active",
    workspace_id: k.workspace_id ?? `wsp_${k.owner_principal_id}`,
    created_by: k.created_by ?? k.owner_principal_id,
    projects: scopes.results.filter((s) => s.credential_id === k.id).map((s) => ({ project_id: s.project_id, title: s.title, access: s.can_write ? "read_write" : "read" }))
  })), truncated: cutLists({ keys: keys.results.length > API_KEYS_LIST_MAX }) };
}
async function replaceApiKey(ctx, id, input) {
  requireHuman(ctx);
  const old = await ownKey(ctx, id);
  if (old.revoked_at !== null) throw new HttpError(409, "revoked", "Revoked keys cannot be replaced; create a new key");
  const cur = await ctx.env.DB.prepare("SELECT project_id, can_write FROM api_credential_projects WHERE credential_id = ?").bind(id).all();
  if (!cur.results.length) throw new HttpError(409, "empty_scope", "Key has no projects left");
  // The new key belongs to whoever replaces it, so its scope is re-validated against their own role.
  const scope = await validateScope(ctx.env, ctx.principal.id, cur.results.map((r) => ({ project_id: r.project_id, access: r.can_write ? "read_write" : "read" })));
  return insertKey(ctx, old.label, lifetime(input?.lifetime_days), scope, id);
}
async function setApiKeyScope(ctx, id, input) {
  requireHuman(ctx);
  const k = await ownKey(ctx, id);
  if (k.revoked_at !== null || k.expires_at <= nowMs()) throw new HttpError(409, "inactive", "Key is revoked or expired");
  // The scope can never exceed the key's creator (who it acts for), nor the acting person.
  const creator = k.created_by ?? k.owner_principal_id;
  const scope = await validateScope(ctx.env, creator, input?.projects);
  if (creator !== ctx.principal.id) await validateScope(ctx.env, ctx.principal.id, input?.projects);
  if (scope.workspaceId !== (k.workspace_id ?? `wsp_${k.owner_principal_id}`)) throw new HttpError(400, "invalid_input", "A key covers projects from one workspace");
  const env = ctx.env;
  const cur = await env.DB.prepare("SELECT project_id, can_write FROM api_credential_projects WHERE credential_id = ?").bind(id).all();
  const added = scope.filter((s) => {
    const c = cur.results.find((r) => r.project_id === s.project_id);
    return !c || s.can_write && !c.can_write;
  });
  if (added.length && input?.confirm_new_access !== true)
    throw new HttpError(
      409,
      "confirmation_required",
      "This change gives the key new access; confirm it explicitly",
      { new_access: added.map((s) => ({ project_id: s.project_id, access: s.can_write ? "read_write" : "read" })) }
    );
  await env.DB.batch([
    env.DB.prepare("DELETE FROM api_credential_projects WHERE credential_id = ?").bind(id),
    ...scope.map((s) => env.DB.prepare("INSERT INTO api_credential_projects (credential_id, project_id, can_write) VALUES (?, ?, ?)").bind(id, s.project_id, s.can_write ? 1 : 0)),
    ...scope.map((s) => auditStmt(env, ctx, s.project_id, "apikey.scope", id, s.can_write ? "ok:read_write" : "ok:read"))
  ]);
  return { ok: true, projects: scope.map((s) => ({ project_id: s.project_id, access: s.can_write ? "read_write" : "read" })) };
}
async function revokeApiKey(ctx, id) {
  requireHuman(ctx);
  await ownKey(ctx, id);
  const at = nowMs();
  const env = ctx.env;
  const [r] = await env.DB.batch([
    env.DB.prepare("UPDATE api_credentials SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(at, id),
    env.DB.prepare(`INSERT INTO audits (at, actor_id, project_id, action, object_id, result, request_id)
      SELECT ?, ?, NULL, 'apikey.revoke', ?, 'ok', ? WHERE EXISTS (SELECT 1 FROM api_credentials WHERE id = ? AND revoked_at = ?)`).bind(nowIso(), ctx.principal.id, id, ctx.requestId, id, at)
  ]);
  if (!r.meta.changes) throw new HttpError(409, "already_revoked", "Key already revoked");
  return { ok: true };
}
async function verifyApiKey(env, authz) {
  if (!authz) throw new HttpError(401, "unauthenticated", "Missing bearer credential", { reason: "missing_header" });
  const m = /^Bearer (\S+)$/i.exec(authz);
  if (!m) throw new HttpError(401, "unauthenticated", "Malformed or unknown credential", { reason: /^bearer\b/i.test(authz) ? "bearer_malformed" : "not_bearer_scheme" });
  if (!KEY_RE.test(m[1])) throw new HttpError(
    401,
    "unauthenticated",
    "Malformed or unknown credential",
    { reason: m[1].startsWith("alk_") ? "alk_wrong_length_or_chars" : "not_alk_shape" }
  );
  const row = await env.DB.prepare("SELECT * FROM api_credentials WHERE token_hash = ?").bind(await sha256Hex(m[1])).first();
  if (!row) throw new HttpError(401, "unauthenticated", "Malformed or unknown credential", { reason: "unknown_key" });
  if (row.revoked_at !== null) throw new HttpError(401, "credential_revoked", "Credential revoked", { reason: "revoked", key_id: row.id });
  if (row.expires_at <= nowMs()) throw new HttpError(401, "credential_expired", "Credential expired", { reason: "expired", key_id: row.id });
  // The workspace's plan may have lowered max_key_lifetime_days since the key was made: it then lasts that long from
  // its creation, at most (the stored expiry is left alone, so moving back to a bigger plan restores it).
  const maxDays = (await workspaceLimits(env, row.workspace_id ?? `wsp_${row.owner_principal_id}`)).max_key_lifetime_days;
  if (maxDays !== undefined && Date.parse(row.created_at) + maxDays * 864e5 <= nowMs())
    throw new HttpError(401, "credential_expired", "Credential expired (the workspace's plan allows keys up to " + maxDays + " days)", { reason: "plan_lifetime", key_id: row.id });
  const ps = await env.DB.prepare(
    `SELECT p.id, p.title, acp.can_write AND ${memberRoleSql("p.id", "member")} AS can_write,
       acp.can_write AND ${memberRoleSql("p.id", "member", "?", true)} AND NOT ${memberRoleSql("p.id", "member")} AS read_only
     FROM api_credential_projects acp JOIN projects p ON p.id = acp.project_id
     WHERE acp.credential_id = ? AND ${memberRoleSql("p.id", "viewer")} ORDER BY p.created_at LIMIT ${MAX_PROJECTS_PER_KEY}`
  ).bind(...Array(3).fill(row.created_by ?? row.owner_principal_id), row.id, row.created_by ?? row.owner_principal_id).all();
  // The key's creator no longer reaches any of its projects (removed, or workspace closed): the key is inactive.
  if (!ps.results.length) throw new HttpError(401, "credential_inactive", "Credential has no active projects", { reason: "no_active_projects", key_id: row.id });
  if (!row.last_used_at || nowMs() - row.last_used_at > 6e4)
    await env.DB.prepare("UPDATE api_credentials SET last_used_at = ? WHERE id = ?").bind(nowMs(), row.id).run().catch(() => {
    });
  return {
    expiresAt: row.expires_at,
    lastActivityAt: row.last_used_at,
    credentialId: row.id,
    ownerId: row.owner_principal_id,
    workspaceId: row.workspace_id ?? `wsp_${row.owner_principal_id}`,
    principalId: row.principal_id,
    label: row.label,
    projects: ps.results.map((p) => ({ id: p.id, title: p.title, can_write: !!p.can_write, read_only: !!p.read_only }))
  };
}

export { API_KEYS_LIST_MAX, createApiKey, listApiKeys, replaceApiKey, revokeApiKey, setApiKeyScope, verifyApiKey };
