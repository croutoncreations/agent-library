import { accessEnabled, verifyAccess } from "./access.js";
import { humanGate, memberRoleSql, requireProjectRole, readOnlyError } from "./tenancy.js";
import { HttpError, nowMs, sha256Hex } from "./util.js";

function limitsFor(env) {
  const n = (v, d) => v && /^\d{1,12}$/.test(v) ? Number(v) : d;
  return {
    readsPerMin: n(env.RATE_READS_PER_MIN, 60),
    writesPerMin: n(env.RATE_WRITES_PER_MIN, 20),
    authFailPerMin: n(env.RATE_AUTHFAIL_PER_MIN, 30),
    uploadTtlMs: n(env.UPLOAD_TTL_SECONDS, 15 * 60) * 1e3,
    projectBinaryBytes: n(env.PROJECT_BINARY_BYTES, 100 * 1024 * 1024),
    cleanupGraceMs: n(env.UPLOAD_CLEANUP_GRACE_SECONDS, 10 * 60) * 1e3
  };
}
async function rateLimit(env, key, limit) {
  const now = Date.now();
  const win = Math.floor(now / 6e4);
  const n = await env.DB.prepare(
    "INSERT INTO rate_counters (k, win, n) VALUES (?, ?, 1) ON CONFLICT (k, win) DO UPDATE SET n = n + 1 RETURNING n"
  ).bind(key, win).first("n");
  if (Math.random() < 0.02) await env.DB.prepare("DELETE FROM rate_counters WHERE win < ?").bind(win - 2).run();
  if ((n ?? 0) > limit)
    throw new HttpError(429, "rate_limited", "Too many requests; slow down", { retry_after_seconds: 60 - Math.floor(now % 6e4 / 1e3) });
}
async function enforceRate(ctx, write) {
  const l = limitsFor(ctx.env);
  const mult = ctx.principal.kind === "human" ? 3 : 1;
  await rateLimit(ctx.env, `${write ? "w" : "r"}:${ctx.principal.id}`, (write ? l.writesPerMin : l.readsPerMin) * mult);
}
function cookie(req, name) {
  const h = req.headers.get("cookie") ?? "";
  for (const part of h.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}
async function authenticate(req, env, requestId) {
  try {
    return await authenticateInner(req, env, requestId);
  } catch (e) {
    if (e instanceof HttpError && e.status === 401) {
      const src = req.headers.get("cf-connecting-ip") ?? "local";
      await rateLimit(env, "authfail:" + src, limitsFor(env).authFailPerMin);
    }
    throw e;
  }
}
async function authenticateInner(req, env, requestId) {
  const authz = req.headers.get("authorization");
  if (authz) {
    const m = /^Bearer ([A-Za-z0-9._~-]{20,200})$/.exec(authz);
    if (!m) throw new HttpError(401, "unauthenticated", "Malformed bearer token");
    if (accessEnabled(env)) await verifyAccess(req, env, { requireOwner: false });
    const row = await env.DB.prepare(
      `SELECT g.id, g.project_id, g.can_write, g.expires_at, g.revoked_at, g.client_info, p.id AS pid, p.kind, p.label,
              ${memberRoleSql("g.project_id", "viewer", "g.created_by")} AS creator_ok
       FROM grants g JOIN principals p ON p.id = g.principal_id WHERE g.token_hash = ?`
    ).bind(await sha256Hex(m[1])).first();
    if (!row || row.kind !== "agent") throw new HttpError(401, "unauthenticated", "Unknown token");
    if (row.revoked_at !== null) throw new HttpError(401, "grant_revoked", "Grant revoked");
    if (row.expires_at <= nowMs()) throw new HttpError(401, "grant_expired", "Grant expired");
    // The person who created the grant lost access (removed, or the workspace is closed): the token is inactive.
    if (!row.creator_ok) throw new HttpError(401, "credential_inactive", "The person who created this token no longer has access");
    return {
      env,
      requestId,
      principal: { id: row.pid, kind: "agent", label: row.label },
      grant: { id: row.id, project_id: row.project_id, can_write: row.can_write },
      grantClientInfo: row.client_info ?? null
    };
  }
  const sid = cookie(req, SESSION_COOKIE);
  if (sid) {
    const row = await env.DB.prepare(
      `SELECT s.csrf, s.expires_at, s.revoked_at, p.id, p.kind, p.label FROM sessions s
       JOIN principals p ON p.id = s.principal_id WHERE s.id_hash = ?`
    ).bind(await sha256Hex(sid)).first();
    if (row && row.revoked_at === null && row.expires_at > nowMs() && row.kind === "human") {
      if (accessEnabled(env)) {
        const id = await verifyAccess(req, env);
        const p = await env.DB.prepare("SELECT issuer, subject FROM principals WHERE id = ?").bind(row.id).first();
        if (!p || p.issuer !== id.issuer || p.subject !== id.subject) throw new HttpError(401, "unauthenticated", "Session does not match Access identity");
      }
      return { env, requestId, principal: { id: row.id, kind: "human", label: row.label }, csrf: row.csrf };
    }
  }
  throw new HttpError(401, "unauthenticated", "Login or bearer token required");
}
function requireCsrf(ctx, req) {
  if (ctx.csrf !== void 0 && req.headers.get("x-csrf-token") !== ctx.csrf)
    throw new HttpError(403, "csrf", "Missing or invalid CSRF token");
}
function requireHuman(ctx) {
  if (ctx.principal.kind !== "human") throw new HttpError(403, "forbidden", "Human owner only");
}
async function authorizeProject(ctx, projectId, write) {
  if (ctx.principal.kind === "agent") {
    if (!ctx.grant || ctx.grant.project_id !== projectId) throw new HttpError(404, "not_found", "Project not found");
    if (write && !ctx.grant.can_write) throw new HttpError(403, "forbidden", "Grant is read-only");
    // The credential's creator must still be a member with enough role (checked again inside every mutation).
    const g = credentialGate(ctx, projectId, write ? "write" : "read");
    const ok = await ctx.env.DB.prepare(`SELECT ${g.sql} AS ok`).bind(...g.params).first("ok");
    if (!ok && write && await ctx.env.DB.prepare(`SELECT 1 FROM projects p JOIN workspaces w ON w.id = COALESCE(p.workspace_id, 'wsp_' || p.owner_id) WHERE p.id = ? AND w.status = 'suspended'`).bind(projectId).first()) {
      const r = credentialGate(ctx, projectId, "read");
      if (await ctx.env.DB.prepare(`SELECT ${r.sql} AS ok`).bind(...r.params).first("ok")) throw readOnlyError();
    }
    if (!ok) throw new HttpError(write ? 403 : 404, write ? "forbidden" : "not_found", write ? "No write access to this project" : "Project not found");
    return;
  }
  await requireProjectRole(ctx, projectId, write ? "member" : "viewer");
}
function protectSql(ctx, artifactId) {
  if (ctx.principal.kind !== "agent" || ctx.publisher || artifactId === void 0) return { sql: "1", params: [] };
  return { sql: "NOT EXISTS (SELECT 1 FROM artifacts WHERE id = ? AND (publisher_id IS NOT NULL OR is_template = 1))", params: [artifactId] };
}
function contentWriteSql(ctx, artifactId) {
  if (ctx.principal.kind === "agent" && artifactId !== void 0) return { sql: "NOT EXISTS (SELECT 1 FROM artifacts WHERE id = ? AND (is_template = 1 OR (publisher_id IS NOT NULL AND ? = 0)))", params: [artifactId, ctx.publisher ? 1 : 0] };
  if (ctx.publisher || artifactId === void 0) return { sql: "1", params: [] };
  return { sql: "NOT EXISTS (SELECT 1 FROM artifacts WHERE id = ? AND publisher_id IS NOT NULL)", params: [artifactId] };
}
/**
 * SQL gate for one credential on one project, evaluated inside each statement. need: "read" | "write".
 * Every agent credential works only while its creator (COALESCE(created_by, owner)) still has at least
 * viewer (read) or member (write) in the project's active workspace.
 */
function credentialGate(ctx, projectId, need) {
  const now = nowMs();
  const roleNeed = need === "write" ? "member" : "viewer";
  if (ctx.principal.kind === "agent" && ctx.publisher)
    return {
      sql: `EXISTS (SELECT 1 FROM publishers pb JOIN projects pj ON pj.id = pb.project_id
              WHERE pb.id = ? AND pb.project_id = ? AND pb.revoked_at IS NULL
                AND ${memberRoleSql("pj.id", roleNeed, "COALESCE(pb.created_by, pb.owner_principal_id)")})`,
      params: [ctx.grant.id, projectId]
    };
  if (ctx.principal.kind === "agent" && ctx.apiCredential)
    return {
      sql: `EXISTS (SELECT 1 FROM api_credentials ac
              JOIN api_credential_projects acp ON acp.credential_id = ac.id
              JOIN projects pj ON pj.id = acp.project_id
              WHERE ac.id = ? AND acp.project_id = ? AND ac.revoked_at IS NULL AND ac.expires_at > ?${need === "write" ? " AND acp.can_write = 1" : ""}
                AND ${memberRoleSql("pj.id", roleNeed, "COALESCE(ac.created_by, ac.owner_principal_id)")})`,
      params: [ctx.grant.id, projectId, now]
    };
  if (ctx.principal.kind === "agent" && ctx.oauthConnection)
    return {
      sql: `EXISTS (SELECT 1 FROM oauth_connections oc
              JOIN oauth_connection_projects cp ON cp.connection_id = oc.id
              JOIN projects pj ON pj.id = cp.project_id
              WHERE oc.id = ? AND cp.project_id = ? AND oc.revoked_at IS NULL AND oc.expires_at > ?${need === "write" ? " AND cp.can_write = 1" : " AND oc.can_read = 1"}
                AND ${memberRoleSql("pj.id", roleNeed, "COALESCE(oc.created_by, oc.owner_principal_id)")})`,
      params: [ctx.grant.id, projectId, now]
    };
  if (ctx.principal.kind === "agent")
    return {
      sql: `EXISTS (SELECT 1 FROM grants gr WHERE gr.id = ? AND gr.project_id = ? AND gr.revoked_at IS NULL AND gr.expires_at > ?${need === "write" ? " AND gr.can_write = 1" : ""}
              AND ${memberRoleSql("gr.project_id", roleNeed, "gr.created_by")})`,
      params: [ctx.grant.id, projectId, now]
    };
  const h = humanGate(ctx.principal.id, projectId, roleNeed);
  return { sql: h.sql, params: h.params };
}
function authzSql(ctx, projectId) {
  return credentialGate(ctx, projectId, "write");
}
var SESSION_COOKIE;
SESSION_COOKIE = "al_session";

export { SESSION_COOKIE, authenticate, authorizeProject, authzSql, credentialGate, contentWriteSql, enforceRate, limitsFor, protectSql, rateLimit, requireCsrf, requireHuman };
