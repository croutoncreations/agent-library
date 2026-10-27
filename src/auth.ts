import { accessEnabled, verifyAccess } from "./access";
import { HttpError, nowMs, sha256Hex } from "./util";

export interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  LOCAL_DEV_LOGIN?: string;
  ALLOWED_ORIGINS?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  OWNER_EMAIL?: string;
  ACCESS_CERTS_URL?: string;
  UPLOAD_CLEANUP_GRACE_SECONDS?: string;
  APP_HOST?: string; // exact owner-app host; other hosts (except MCP_HOST) get 404
  // Optional operator overrides (deploy-time vars only; used by tests to exercise limits quickly).
  RATE_READS_PER_MIN?: string;
  RATE_WRITES_PER_MIN?: string;
  RATE_AUTHFAIL_PER_MIN?: string;
  UPLOAD_TTL_SECONDS?: string;
  PROJECT_BINARY_BYTES?: string;
}

/** Effective limits. Defaults are per identity per minute; humans get 3x the per-identity request rate. */
export function limitsFor(env: Env) {
  const n = (v: string | undefined, d: number) => (v && /^\d{1,12}$/.test(v) ? Number(v) : d);
  return {
    readsPerMin: n(env.RATE_READS_PER_MIN, 60),
    writesPerMin: n(env.RATE_WRITES_PER_MIN, 20),
    authFailPerMin: n(env.RATE_AUTHFAIL_PER_MIN, 30),
    uploadTtlMs: n(env.UPLOAD_TTL_SECONDS, 15 * 60) * 1000,
    projectBinaryBytes: n(env.PROJECT_BINARY_BYTES, 100 * 1024 * 1024),
    cleanupGraceMs: n(env.UPLOAD_CLEANUP_GRACE_SECONDS, 10 * 60) * 1000,
  };
}

/** Atomic fixed-window counter in D1 (single statement upsert, so concurrent requests cannot both slip under). */
export async function rateLimit(env: Env, key: string, limit: number): Promise<void> {
  const now = Date.now();
  const win = Math.floor(now / 60_000);
  const n = await env.DB.prepare(
    "INSERT INTO rate_counters (k, win, n) VALUES (?, ?, 1) ON CONFLICT (k, win) DO UPDATE SET n = n + 1 RETURNING n",
  ).bind(key, win).first<number>("n");
  if (Math.random() < 0.02) await env.DB.prepare("DELETE FROM rate_counters WHERE win < ?").bind(win - 2).run();
  if ((n ?? 0) > limit)
    throw new HttpError(429, "rate_limited", "Too many requests; slow down", { retry_after_seconds: 60 - Math.floor((now % 60_000) / 1000) });
}

/** Per-identity request rate: separate read and mutation budgets. */
export async function enforceRate(ctx: Ctx, write: boolean) {
  const l = limitsFor(ctx.env);
  const mult = ctx.principal.kind === "human" ? 3 : 1;
  await rateLimit(ctx.env, `${write ? "w" : "r"}:${ctx.principal.id}`, (write ? l.writesPerMin : l.readsPerMin) * mult);
}

export type Principal = { id: string; kind: "human" | "agent"; label: string };
export type Grant = { id: string; project_id: string; can_write: number };
export type Ctx = {
  env: Env;
  principal: Principal;
  grant?: Grant; // present for agents only
  csrf?: string; // present for cookie sessions
  requestId: string;
  // OAuth connection principal: grant.id is the oauth_connections id; authorization is checked against that row.
  oauthConnection?: boolean;
  // API credential (alk_) principal: grant.id is the api_credentials id; authorization is checked against
  // that row and its api_credential_projects entry (inside every write batch as well).
  apiCredential?: boolean;
  // Publisher principal (App Connect): grant.id is the publishers id. Writes are checked against the live
  // publisher row inside the batch; reads are confined to its own files by the publisher API.
  publisher?: boolean;
};

export const SESSION_COOKIE = "al_session";

function cookie(req: Request, name: string): string | null {
  const h = req.headers.get("cookie") ?? "";
  for (const part of h.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

/**
 * Authenticate a request. Grants and sessions are re-read on every request (no caching), so revocation is
 * immediate. Failed attempts are counted per source address; past the limit the caller gets 429.
 */
export async function authenticate(req: Request, env: Env, requestId: string): Promise<Ctx> {
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

async function authenticateInner(req: Request, env: Env, requestId: string): Promise<Ctx> {
  const authz = req.headers.get("authorization");
  if (authz) {
    const m = /^Bearer ([A-Za-z0-9._~-]{20,200})$/.exec(authz);
    if (!m) throw new HttpError(401, "unauthenticated", "Malformed bearer token");
    // Hosted: the outer Cloudflare Access layer (user or service token) must also be present and valid.
    // It never grants anything by itself; the project-scoped grant below is always required.
    if (accessEnabled(env)) await verifyAccess(req, env, { requireOwner: false });
    const row = await env.DB.prepare(
      `SELECT g.id, g.project_id, g.can_write, g.expires_at, g.revoked_at, p.id AS pid, p.kind, p.label
       FROM grants g JOIN principals p ON p.id = g.principal_id WHERE g.token_hash = ?`,
    ).bind(await sha256Hex(m[1])).first<any>();
    if (!row || row.kind !== "agent") throw new HttpError(401, "unauthenticated", "Unknown token");
    if (row.revoked_at !== null) throw new HttpError(401, "grant_revoked", "Grant revoked");
    if (row.expires_at <= nowMs()) throw new HttpError(401, "grant_expired", "Grant expired");
    return {
      env, requestId,
      principal: { id: row.pid, kind: "agent", label: row.label },
      grant: { id: row.id, project_id: row.project_id, can_write: row.can_write },
    };
  }
  const sid = cookie(req, SESSION_COOKIE);
  if (sid) {
    const row = await env.DB.prepare(
      `SELECT s.csrf, s.expires_at, s.revoked_at, p.id, p.kind, p.label FROM sessions s
       JOIN principals p ON p.id = s.principal_id WHERE s.id_hash = ?`,
    ).bind(await sha256Hex(sid)).first<any>();
    if (row && row.revoked_at === null && row.expires_at > nowMs() && row.kind === "human") {
      // Hosted: the app session is only valid together with a currently valid Access identity
      // for the same issuer/subject (Access logout/expiry immediately ends app access).
      if (accessEnabled(env)) {
        const id = await verifyAccess(req, env);
        const p = await env.DB.prepare("SELECT issuer, subject FROM principals WHERE id = ?").bind(row.id).first<any>();
        if (!p || p.issuer !== id.issuer || p.subject !== id.subject) throw new HttpError(401, "unauthenticated", "Session does not match Access identity");
      }
      return { env, requestId, principal: { id: row.id, kind: "human", label: row.label }, csrf: row.csrf };
    }
  }
  throw new HttpError(401, "unauthenticated", "Login or bearer token required");
}

/** Cookie-authenticated mutations require a matching CSRF header (bearer requests are not ambient). */
export function requireCsrf(ctx: Ctx, req: Request) {
  if (ctx.csrf !== undefined && req.headers.get("x-csrf-token") !== ctx.csrf)
    throw new HttpError(403, "csrf", "Missing or invalid CSRF token");
}

export function requireHuman(ctx: Ctx) {
  if (ctx.principal.kind !== "human") throw new HttpError(403, "forbidden", "Human owner only");
}

/** Read-time project authorization. Out-of-scope projects are reported as 404 to avoid existence leaks. */
export async function authorizeProject(ctx: Ctx, projectId: string, write: boolean) {
  if (ctx.principal.kind === "agent") {
    if (!ctx.grant || ctx.grant.project_id !== projectId) throw new HttpError(404, "not_found", "Project not found");
    if (write && !ctx.grant.can_write) throw new HttpError(403, "forbidden", "Grant is read-only");
    return;
  }
  const p = await ctx.env.DB.prepare("SELECT owner_id FROM projects WHERE id = ?").bind(projectId).first<any>();
  if (!p || p.owner_id !== ctx.principal.id) throw new HttpError(404, "not_found", "Project not found");
}

/**
 * SQL predicate re-checking authorization *inside* an atomic write batch, so a grant revoked
 * between the read-time check and the write cannot publish anything.
 */
/**
 * Source protection (App Connect §9.5): for every non-owner, non-publisher principal, a write that targets a
 * publisher-owned artifact is refused inside the batch. `artifactId` is the artifact the statement writes
 * (undefined for creates, which can never target an existing publisher file).
 */
export function protectSql(ctx: Ctx, artifactId: string | undefined): { sql: string; params: unknown[] } {
  if (ctx.principal.kind !== "agent" || ctx.publisher || artifactId === undefined) return { sql: "1", params: [] };
  return { sql: "NOT EXISTS (SELECT 1 FROM artifacts WHERE id = ? AND publisher_id IS NOT NULL)", params: [artifactId] };
}

/** Owner (human) content edits on publisher files are also refused: the source of truth is the app. */
export function contentWriteSql(ctx: Ctx, artifactId: string | undefined): { sql: string; params: unknown[] } {
  if (ctx.publisher || artifactId === undefined) return { sql: "1", params: [] };
  return { sql: "NOT EXISTS (SELECT 1 FROM artifacts WHERE id = ? AND publisher_id IS NOT NULL)", params: [artifactId] };
}

export function authzSql(ctx: Ctx, projectId: string): { sql: string; params: unknown[] } {
  if (ctx.principal.kind === "agent" && ctx.publisher)
    return {
      sql: `EXISTS (SELECT 1 FROM publishers pb JOIN projects pj ON pj.id = pb.project_id
              WHERE pb.id = ? AND pb.project_id = ? AND pb.revoked_at IS NULL AND pj.owner_id = pb.owner_principal_id)`,
      params: [ctx.grant!.id, projectId],
    };
  if (ctx.principal.kind === "agent" && ctx.apiCredential)
    return {
      sql: `EXISTS (SELECT 1 FROM api_credentials ac
              JOIN api_credential_projects acp ON acp.credential_id = ac.id
              JOIN projects pj ON pj.id = acp.project_id
              WHERE ac.id = ? AND acp.project_id = ? AND ac.revoked_at IS NULL AND ac.expires_at > ? AND acp.can_write = 1
                AND pj.owner_id = ac.owner_principal_id)`,
      params: [ctx.grant!.id, projectId, nowMs()],
    };
  if (ctx.principal.kind === "agent" && ctx.oauthConnection)
    return {
      sql: `EXISTS (SELECT 1 FROM oauth_connections oc
              JOIN oauth_connection_projects cp ON cp.connection_id = oc.id
              JOIN projects pj ON pj.id = cp.project_id
              WHERE oc.id = ? AND cp.project_id = ? AND oc.revoked_at IS NULL AND oc.expires_at > ? AND cp.can_write = 1
                AND pj.owner_id = oc.owner_principal_id)`,
      params: [ctx.grant!.id, projectId, nowMs()],
    };
  if (ctx.principal.kind === "agent")
    return {
      sql: "EXISTS (SELECT 1 FROM grants WHERE id = ? AND project_id = ? AND revoked_at IS NULL AND expires_at > ? AND can_write = 1)",
      params: [ctx.grant!.id, projectId, nowMs()],
    };
  return { sql: "EXISTS (SELECT 1 FROM projects WHERE id = ? AND owner_id = ?)", params: [projectId, ctx.principal.id] };
}
