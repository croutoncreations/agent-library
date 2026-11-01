import { requireHuman } from "../auth.js";
import { HttpError, nowIso, nowMs, randomId, sha256Hex, str } from "../util.js";

var KEY_LIFETIMES_DAYS = [1, 7, 30, 90];
var DEFAULT_LIFETIME_DAYS = 90;
var MAX_PROJECTS_PER_KEY = 50;
var KEY_RE = /^alk_[A-Za-z0-9_-]{43}$/;
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
  const owned = await env.DB.prepare(`SELECT id FROM projects WHERE owner_id = ? AND id IN (${out2.map(() => "?").join(",")})`).bind(ownerId, ...out2.map((s) => s.project_id)).all();
  if (owned.results.length !== out2.length) throw new HttpError(404, "not_found", "Project not found");
  return out2;
}
function lifetime(raw) {
  const d = raw === void 0 ? DEFAULT_LIFETIME_DAYS : Number(raw);
  if (!KEY_LIFETIMES_DAYS.includes(d)) throw new HttpError(400, "invalid_input", `lifetime_days must be one of ${KEY_LIFETIMES_DAYS.join(", ")}`);
  return d;
}
function auditStmt(env, ctx, projectId, action, objectId, result) {
  return env.DB.prepare("INSERT INTO audits (at, actor_id, project_id, action, object_id, result, request_id) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(nowIso(), ctx.principal.id, projectId, action, objectId, result, ctx.requestId);
}
async function insertKey(ctx, label, days, scope, replacesId) {
  const env = ctx.env;
  const secret = randomId("alk", 32);
  const id = randomId("akey", 12);
  const principalId = randomId("agt");
  const expires = nowMs() + days * 864e5;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO principals (id, kind, issuer, subject, label, created_at) VALUES (?, 'agent', 'agent-library-api', ?, ?, ?)").bind(principalId, principalId, label, nowIso()),
    env.DB.prepare(`INSERT INTO api_credentials (id, owner_principal_id, principal_id, label, token_hash, created_at, expires_at, replaces_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, ctx.principal.id, principalId, label, await sha256Hex(secret), nowIso(), expires, replacesId),
    ...scope.map((s) => env.DB.prepare("INSERT INTO api_credential_projects (credential_id, project_id, can_write) VALUES (?, ?, ?)").bind(id, s.project_id, s.can_write ? 1 : 0)),
    ...scope.map((s) => auditStmt(env, ctx, s.project_id, replacesId ? "apikey.replace" : "apikey.create", id, s.can_write ? "ok:read_write" : "ok:read"))
  ]);
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
  const k = await ctx.env.DB.prepare("SELECT * FROM api_credentials WHERE id = ? AND owner_principal_id = ?").bind(id, ctx.principal.id).first();
  if (!k) throw new HttpError(404, "not_found", "API key not found");
  return k;
}
async function listApiKeys(ctx) {
  requireHuman(ctx);
  const keys = await ctx.env.DB.prepare("SELECT * FROM api_credentials WHERE owner_principal_id = ? ORDER BY created_at DESC LIMIT 200").bind(ctx.principal.id).all();
  const scopes = await ctx.env.DB.prepare(
    `SELECT acp.credential_id, acp.project_id, acp.can_write, p.title FROM api_credential_projects acp
     JOIN projects p ON p.id = acp.project_id
     WHERE acp.credential_id IN (SELECT id FROM api_credentials WHERE owner_principal_id = ? ORDER BY created_at DESC LIMIT 200)`
  ).bind(ctx.principal.id).all();
  const now = nowMs();
  return { keys: keys.results.map((k) => ({
    id: k.id,
    label: k.label,
    created_at: k.created_at,
    expires_at: new Date(k.expires_at).toISOString(),
    last_used_at: k.last_used_at ? new Date(k.last_used_at).toISOString() : null,
    replaces_id: k.replaces_id,
    status: k.revoked_at !== null ? "revoked" : k.expires_at <= now ? "expired" : "active",
    projects: scopes.results.filter((s) => s.credential_id === k.id).map((s) => ({ project_id: s.project_id, title: s.title, access: s.can_write ? "read_write" : "read" }))
  })) };
}
async function replaceApiKey(ctx, id, input) {
  requireHuman(ctx);
  const old = await ownKey(ctx, id);
  if (old.revoked_at !== null) throw new HttpError(409, "revoked", "Revoked keys cannot be replaced; create a new key");
  const scope = await ctx.env.DB.prepare(
    "SELECT acp.project_id, acp.can_write FROM api_credential_projects acp JOIN projects p ON p.id = acp.project_id WHERE acp.credential_id = ? AND p.owner_id = ?"
  ).bind(id, ctx.principal.id).all();
  if (!scope.results.length) throw new HttpError(409, "empty_scope", "Key has no projects left");
  return insertKey(ctx, old.label, lifetime(input?.lifetime_days), scope.results.map((r) => ({ project_id: r.project_id, can_write: !!r.can_write })), id);
}
async function setApiKeyScope(ctx, id, input) {
  requireHuman(ctx);
  const k = await ownKey(ctx, id);
  if (k.revoked_at !== null || k.expires_at <= nowMs()) throw new HttpError(409, "inactive", "Key is revoked or expired");
  const scope = await validateScope(ctx.env, ctx.principal.id, input?.projects);
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
    env.DB.prepare("UPDATE api_credentials SET revoked_at = ? WHERE id = ? AND owner_principal_id = ? AND revoked_at IS NULL").bind(at, id, ctx.principal.id),
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
  const ps = await env.DB.prepare(
    `SELECT p.id, p.title, acp.can_write FROM api_credential_projects acp JOIN projects p ON p.id = acp.project_id
     WHERE acp.credential_id = ? AND p.owner_id = ? ORDER BY p.created_at LIMIT ${MAX_PROJECTS_PER_KEY}`
  ).bind(row.id, row.owner_principal_id).all();
  if (!row.last_used_at || nowMs() - row.last_used_at > 6e4)
    await env.DB.prepare("UPDATE api_credentials SET last_used_at = ? WHERE id = ?").bind(nowMs(), row.id).run().catch(() => {
    });
  return {
    expiresAt: row.expires_at,
    lastActivityAt: row.last_used_at,
    credentialId: row.id,
    ownerId: row.owner_principal_id,
    principalId: row.principal_id,
    label: row.label,
    projects: ps.results.map((p) => ({ id: p.id, title: p.title, can_write: !!p.can_write }))
  };
}

export { createApiKey, listApiKeys, replaceApiKey, revokeApiKey, setApiKeyScope, verifyApiKey };
