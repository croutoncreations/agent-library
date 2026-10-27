// API credentials (alk_ bearer keys) for machine clients (e.g. Muse's REST skill).
// Owner management (create / list / replace / change scope / revoke) runs on the owner host behind Access +
// app session. Verification runs on the machine host (/v1). Only SHA-256(secret) is stored; the secret is
// returned exactly once, at creation. General model: any number of owner-selected projects with per-project
// read or read+write; the scope can only change through an explicit, audited owner action.
import { requireHuman, type Ctx, type Env } from "../auth";
import { HttpError, nowIso, nowMs, randomId, sha256Hex, str } from "../util";

export const KEY_LIFETIMES_DAYS = [1, 7, 30, 90] as const;
export const DEFAULT_LIFETIME_DAYS = 90;
export const MAX_PROJECTS_PER_KEY = 50;
const KEY_RE = /^alk_[A-Za-z0-9_-]{43}$/;

type Scope = { project_id: string; can_write: boolean };

/** Validate an owner-supplied scope list against the owner's projects. */
async function validateScope(env: Env, ownerId: string, raw: unknown): Promise<Scope[]> {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_PROJECTS_PER_KEY)
    throw new HttpError(400, "invalid_input", `projects must list 1-${MAX_PROJECTS_PER_KEY} projects`);
  const seen = new Set<string>();
  const out: Scope[] = [];
  for (const r of raw as any[]) {
    const pid = str(r?.project_id, "project_id", 64);
    if (seen.has(pid)) throw new HttpError(400, "invalid_input", "Duplicate project in scope");
    seen.add(pid);
    if (r.access !== "read" && r.access !== "read_write") throw new HttpError(400, "invalid_input", "access must be read or read_write");
    out.push({ project_id: pid, can_write: r.access === "read_write" });
  }
  const owned = await env.DB.prepare(`SELECT id FROM projects WHERE owner_id = ? AND id IN (${out.map(() => "?").join(",")})`)
    .bind(ownerId, ...out.map((s) => s.project_id)).all<any>();
  if (owned.results.length !== out.length) throw new HttpError(404, "not_found", "Project not found");
  return out;
}

function lifetime(raw: unknown): number {
  const d = raw === undefined ? DEFAULT_LIFETIME_DAYS : Number(raw);
  if (!(KEY_LIFETIMES_DAYS as readonly number[]).includes(d)) throw new HttpError(400, "invalid_input", `lifetime_days must be one of ${KEY_LIFETIMES_DAYS.join(", ")}`);
  return d;
}

function auditStmt(env: Env, ctx: Ctx, projectId: string | null, action: string, objectId: string, result: string) {
  return env.DB.prepare("INSERT INTO audits (at, actor_id, project_id, action, object_id, result, request_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(nowIso(), ctx.principal.id, projectId, action, objectId, result, ctx.requestId);
}

async function insertKey(ctx: Ctx, label: string, days: number, scope: Scope[], replacesId: string | null) {
  const env = ctx.env;
  const secret = randomId("alk", 32); // 256-bit, base64url
  const id = randomId("akey", 12);
  const principalId = randomId("agt");
  const expires = nowMs() + days * 86_400_000;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO principals (id, kind, issuer, subject, label, created_at) VALUES (?, 'agent', 'agent-library-api', ?, ?, ?)")
      .bind(principalId, principalId, label, nowIso()),
    env.DB.prepare(`INSERT INTO api_credentials (id, owner_principal_id, principal_id, label, token_hash, created_at, expires_at, replaces_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, ctx.principal.id, principalId, label, await sha256Hex(secret), nowIso(), expires, replacesId),
    ...scope.map((s) => env.DB.prepare("INSERT INTO api_credential_projects (credential_id, project_id, can_write) VALUES (?, ?, ?)").bind(id, s.project_id, s.can_write ? 1 : 0)),
    ...scope.map((s) => auditStmt(env, ctx, s.project_id, replacesId ? "apikey.replace" : "apikey.create", id, s.can_write ? "ok:read_write" : "ok:read")),
  ]);
  return { id, label, expires_at: new Date(expires).toISOString(), projects: scope.map((s) => ({ project_id: s.project_id, access: s.can_write ? "read_write" : "read" })), secret };
}

/** Owner: create a key. The secret appears only in this response. */
export async function createApiKey(ctx: Ctx, input: any) {
  requireHuman(ctx);
  const label = str(input?.label, "label", 80, { min: 1 });
  const days = lifetime(input?.lifetime_days);
  const scope = await validateScope(ctx.env, ctx.principal.id, input?.projects);
  return insertKey(ctx, label, days, scope, null);
}

async function ownKey(ctx: Ctx, id: string) {
  const k = await ctx.env.DB.prepare("SELECT * FROM api_credentials WHERE id = ? AND owner_principal_id = ?").bind(id, ctx.principal.id).first<any>();
  if (!k) throw new HttpError(404, "not_found", "API key not found");
  return k;
}

/** Owner: list keys (never secrets). */
export async function listApiKeys(ctx: Ctx) {
  requireHuman(ctx);
  const keys = await ctx.env.DB.prepare("SELECT * FROM api_credentials WHERE owner_principal_id = ? ORDER BY created_at DESC LIMIT 200").bind(ctx.principal.id).all<any>();
  const scopes = await ctx.env.DB.prepare(
    `SELECT acp.credential_id, acp.project_id, acp.can_write, p.title FROM api_credential_projects acp
     JOIN projects p ON p.id = acp.project_id
     WHERE acp.credential_id IN (SELECT id FROM api_credentials WHERE owner_principal_id = ? ORDER BY created_at DESC LIMIT 200)`,
  ).bind(ctx.principal.id).all<any>();
  const now = nowMs();
  return { keys: keys.results.map((k) => ({
    id: k.id, label: k.label, created_at: k.created_at, expires_at: new Date(k.expires_at).toISOString(),
    last_used_at: k.last_used_at ? new Date(k.last_used_at).toISOString() : null, replaces_id: k.replaces_id,
    status: k.revoked_at !== null ? "revoked" : k.expires_at <= now ? "expired" : "active",
    projects: scopes.results.filter((s) => s.credential_id === k.id).map((s) => ({ project_id: s.project_id, title: s.title, access: s.can_write ? "read_write" : "read" })),
  })) };
}

/**
 * Owner: create a successor with the same scope (optionally a new lifetime). The old key stays valid until revoked or
 * expired. Replacing an *expired* key is intentionally allowed (the normal recovery path); revoked keys are not.
 */
export async function replaceApiKey(ctx: Ctx, id: string, input: any) {
  requireHuman(ctx);
  const old = await ownKey(ctx, id);
  if (old.revoked_at !== null) throw new HttpError(409, "revoked", "Revoked keys cannot be replaced; create a new key");
  const scope = await ctx.env.DB.prepare(
    "SELECT acp.project_id, acp.can_write FROM api_credential_projects acp JOIN projects p ON p.id = acp.project_id WHERE acp.credential_id = ? AND p.owner_id = ?",
  ).bind(id, ctx.principal.id).all<any>();
  if (!scope.results.length) throw new HttpError(409, "empty_scope", "Key has no projects left");
  return insertKey(ctx, old.label, lifetime(input?.lifetime_days), scope.results.map((r) => ({ project_id: r.project_id, can_write: !!r.can_write })), id);
}

/** Owner: set the key's project scope (explicit, audited). Never callable by the key itself. */
export async function setApiKeyScope(ctx: Ctx, id: string, input: any) {
  requireHuman(ctx);
  const k = await ownKey(ctx, id);
  if (k.revoked_at !== null || k.expires_at <= nowMs()) throw new HttpError(409, "inactive", "Key is revoked or expired");
  const scope = await validateScope(ctx.env, ctx.principal.id, input?.projects);
  const env = ctx.env;
  // Any new project, or read -> read_write, is an expansion and needs explicit owner confirmation.
  const cur = await env.DB.prepare("SELECT project_id, can_write FROM api_credential_projects WHERE credential_id = ?").bind(id).all<any>();
  const added = scope.filter((s) => {
    const c = cur.results.find((r) => r.project_id === s.project_id);
    return !c || (s.can_write && !c.can_write);
  });
  if (added.length && input?.confirm_new_access !== true)
    throw new HttpError(409, "confirmation_required", "This change gives the key new access; confirm it explicitly",
      { new_access: added.map((s) => ({ project_id: s.project_id, access: s.can_write ? "read_write" : "read" })) });
  await env.DB.batch([
    env.DB.prepare("DELETE FROM api_credential_projects WHERE credential_id = ?").bind(id),
    ...scope.map((s) => env.DB.prepare("INSERT INTO api_credential_projects (credential_id, project_id, can_write) VALUES (?, ?, ?)").bind(id, s.project_id, s.can_write ? 1 : 0)),
    ...scope.map((s) => auditStmt(env, ctx, s.project_id, "apikey.scope", id, s.can_write ? "ok:read_write" : "ok:read")),
  ]);
  return { ok: true, projects: scope.map((s) => ({ project_id: s.project_id, access: s.can_write ? "read_write" : "read" })) };
}

/** Owner: revoke immediately (every request and every write batch checks the row). */
export async function revokeApiKey(ctx: Ctx, id: string) {
  requireHuman(ctx);
  await ownKey(ctx, id);
  const at = nowMs();
  const env = ctx.env;
  // Revoke and its audit row commit together (the audit row only if this request did the revoke).
  const [r] = await env.DB.batch([
    env.DB.prepare("UPDATE api_credentials SET revoked_at = ? WHERE id = ? AND owner_principal_id = ? AND revoked_at IS NULL").bind(at, id, ctx.principal.id),
    env.DB.prepare(`INSERT INTO audits (at, actor_id, project_id, action, object_id, result, request_id)
      SELECT ?, ?, NULL, 'apikey.revoke', ?, 'ok', ? WHERE EXISTS (SELECT 1 FROM api_credentials WHERE id = ? AND revoked_at = ?)`)
      .bind(nowIso(), ctx.principal.id, id, ctx.requestId, id, at),
  ]);
  if (!r.meta.changes) throw new HttpError(409, "already_revoked", "Key already revoked");
  return { ok: true };
}

export type ApiKeyCtx = {
  credentialId: string; ownerId: string; principalId: string; label: string;
  projects: { id: string; title: string; can_write: boolean }[];
};

/**
 * Verify an Authorization header on the machine host. Distinguishes missing/unknown (unauthenticated),
 * expired and revoked (all 401). Fails closed on lookup errors. Never logs the secret.
 */
export async function verifyApiKey(env: Env, authz: string | null): Promise<ApiKeyCtx> {
  // `reason` (in HttpError.extra, stripped before responding) feeds a safe diagnostic log line; it never
  // contains any part of the credential.
  if (!authz) throw new HttpError(401, "unauthenticated", "Missing bearer credential", { reason: "missing_header" });
  const m = /^Bearer (\S+)$/i.exec(authz);
  if (!m) throw new HttpError(401, "unauthenticated", "Malformed or unknown credential", { reason: /^bearer\b/i.test(authz) ? "bearer_malformed" : "not_bearer_scheme" });
  if (!KEY_RE.test(m[1])) throw new HttpError(401, "unauthenticated", "Malformed or unknown credential",
    { reason: m[1].startsWith("alk_") ? "alk_wrong_length_or_chars" : "not_alk_shape" });
  const row = await env.DB.prepare("SELECT * FROM api_credentials WHERE token_hash = ?").bind(await sha256Hex(m[1])).first<any>();
  if (!row) throw new HttpError(401, "unauthenticated", "Malformed or unknown credential", { reason: "unknown_key" });
  if (row.revoked_at !== null) throw new HttpError(401, "credential_revoked", "Credential revoked", { reason: "revoked", key_id: row.id });
  if (row.expires_at <= nowMs()) throw new HttpError(401, "credential_expired", "Credential expired", { reason: "expired", key_id: row.id });
  const ps = await env.DB.prepare(
    `SELECT p.id, p.title, acp.can_write FROM api_credential_projects acp JOIN projects p ON p.id = acp.project_id
     WHERE acp.credential_id = ? AND p.owner_id = ? ORDER BY p.created_at LIMIT ${MAX_PROJECTS_PER_KEY}`,
  ).bind(row.id, row.owner_principal_id).all<any>();
  // last_used_at at most once a minute (bounded write amplification)
  if (!row.last_used_at || nowMs() - row.last_used_at > 60_000)
    await env.DB.prepare("UPDATE api_credentials SET last_used_at = ? WHERE id = ?").bind(nowMs(), row.id).run().catch(() => {});
  return { credentialId: row.id, ownerId: row.owner_principal_id, principalId: row.principal_id, label: row.label,
    projects: ps.results.map((p) => ({ id: p.id, title: p.title, can_write: !!p.can_write })) };
}
