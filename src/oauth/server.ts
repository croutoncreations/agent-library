// OAuth surface for artifacts-mcp.<zone>. Only this module handles that host. It never falls back to the
// owner app, REST API, legacy grants, cookies or Cloudflare Access headers.
import {
  AuthorizationError, CimdFetchError, OAuthAuthorizationServer, OAuthError, OAuthResourceServer,
  authorizationErrorRedirect, insufficientScope, type AuthRequest, type OAuthResourceContext,
} from "@cloudflare/workers-oauth-provider";
import type { Env } from "../auth";
import { rateLimit } from "../auth";
import { nowIso, nowMs, randomId } from "../util";
import { authorizationUrl, exchangeAndVerify, newUpstreamSecrets, oidcConfig, type OidcEnv } from "./oidc";
import { handleOAuthMcp, type ConnProps } from "./mcp";
import { handlePublisherApi } from "../api/publisher";
import { folderName } from "../service";

export type OAuthEnv = Env & OidcEnv & { OAUTH_KV: KVNamespace; MCP_HOST?: string; CONSENT_SECRET?: string; OAUTH_RATE_MULTIPLIER?: string; APP_CONNECT_ENABLED?: string };
const acOn = (env: { APP_CONNECT_ENABLED?: string }) => env.APP_CONNECT_ENABLED === "1";
// Per-IP limits on the OAuth host (production defaults). OAUTH_RATE_MULTIPLIER is a test-only knob.
const LIM = { authorize: 30, token: 60, register: 10 };
const lim = (env: OAuthEnv, k: keyof typeof LIM) => LIM[k] * (env.OAUTH_RATE_MULTIPLIER && /^\d{1,6}$/.test(env.OAUTH_RATE_MULTIPLIER) ? Number(env.OAUTH_RATE_MULTIPLIER) : 1);

export const SCOPES = { read: "agentlib:read", write: "agentlib:write", offline: "offline_access", publish: "agentlib:publish" } as const;
const CATALOGUE = [SCOPES.read, SCOPES.write, SCOPES.offline];
// App Connect (flag on): a second resource /v1 for publishers. /mcp stays the default for clients that omit resource.
const AC_CATALOGUE = [SCOPES.read, SCOPES.write, SCOPES.offline, SCOPES.publish];
const CONNECTION_TTL_MS = 30 * 24 * 3600_000;

// Host-specific singletons (the library validates canonical URLs at construction).
export type PubProps = { publisher_id: string; epoch: number };
type Servers = { as: OAuthAuthorizationServer<OAuthEnv>; rs: OAuthResourceServer<OAuthEnv, ConnProps>; v1?: OAuthResourceServer<OAuthEnv, PubProps> };
const cache = new Map<string, Servers>();
export function originFor(host: string) {
  return /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) ? `http://${host}` : `https://${host}`;
}
function servers(origin: string, appConnect = false): Servers {
  const cacheKey = origin + (appConnect ? "#ac" : "");
  let s = cache.get(cacheKey);
  if (s) return s;
  const resource = `${origin}/mcp`;
  const v1Resource = `${origin}/v1`;
  const as = new OAuthAuthorizationServer<OAuthEnv>({
    issuer: origin,
    resources: appConnect ? [resource, v1Resource] : [resource],
    ...(appConnect ? { defaultResource: resource } : {}),
    scopesSupported: appConnect ? AC_CATALOGUE : CATALOGUE,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    clientIdMetadataDocumentEnabled: true,
    accessTokenTTL: 15 * 60,
    refreshTokenTTL: 30 * 24 * 3600,
    clientRegistrationTTL: 30 * 24 * 3600,
    // Every refresh rechecks the D1 connection; revoked or expired connections cannot refresh.
    tokenExchangeCallback: async ({ grantType, props, env }) => {
      if (grantType !== "refresh_token") return;
      const pp = props as Partial<PubProps> & Partial<ConnProps>;
      if (pp?.publisher_id) {
        const ok = await livePublisher(env, pp as PubProps).catch(() => null);
        // livePublisher returns a row marked revoked (for 401 publisher_revoked on the API); refresh must refuse it.
        if (!ok || ok.revoked) throw new OAuthError("invalid_grant", { description: "Publisher revoked or token superseded" });
        return;
      }
      const ok = await liveConnection(env, pp?.connection_id).catch(() => null);
      if (!ok) throw new OAuthError("invalid_grant", { description: "Connection revoked or expired" });
      return;
    },
    // Registration is rate-limited in the dispatcher (per IP, 10/min) before this runs.
    clientRegistrationCallback: async ({ clientMetadata }) => {
      // Publisher scope is never available to dynamically registered clients.
      if (typeof clientMetadata.scope === "string" && clientMetadata.scope.split(/\s+/).includes(SCOPES.publish))
        return { description: "agentlib:publish is only available to owner-registered apps" };
      const uris = Array.isArray(clientMetadata.redirect_uris) ? clientMetadata.redirect_uris : [];
      const ok = registrableRedirects(uris);
      logRegistration(ok ? "accepted" : "rejected", clientMetadata);
      if (!ok) return { description: "redirect_uris must be verified ChatGPT, Cursor/Grok Bot or Claude callbacks, or loopback for local clients" };
      return;
    },
    onError: ({ code, internal }) => { console.log("oauth_error", code, internal?.reason ?? ""); },
  });
  const rs = new OAuthResourceServer<OAuthEnv, ConnProps>({
    resourceMetadata: { resource, authorization_servers: [origin], bearer_methods_supported: ["header"], resource_name: "Agent Library" },
    requiredScopes: [SCOPES.read],
    validateToken: (env) => (res, token) => as.validateToken<ConnProps>(res, token, env),
    handler: { fetch: (req, env, ctx) => handleOAuthMcp(req, env, ctx as OAuthResourceContext<ConnProps>) },
  });
  s = { as, rs };
  if (appConnect) {
    s.v1 = new OAuthResourceServer<OAuthEnv, PubProps>({
      resourceMetadata: { resource: v1Resource, authorization_servers: [origin], bearer_methods_supported: ["header"], resource_name: "Agent Library publisher API" },
      requiredScopes: [SCOPES.publish],
      validateToken: (env) => (res, token) => as.validateToken<PubProps>(res, token, env),
      handler: { fetch: (req, env, ctx) => handlePublisherApi(req, env, ctx as OAuthResourceContext<PubProps>) },
    });
  }
  cache.set(cacheKey, s);
  return s;
}

/**
 * Live publisher check (every API call and refresh): not revoked, token epoch current. Disabling the app client
 * only stops NEW connections (contract §6, §8.4); existing publishers keep working until revoked individually.
 */
export async function livePublisher(env: Env, p: PubProps) {
  if (!p || typeof p.publisher_id !== "string" || !/^pub_[A-Za-z0-9_-]{10,64}$/.test(p.publisher_id)) return null;
  const row = await env.DB.prepare(
    `SELECT pb.*, ac.client_id, ac.disabled_at AS client_disabled, ac.id AS apc_id FROM publishers pb JOIN app_clients ac ON ac.id = pb.app_client_id
     JOIN projects pj ON pj.id = pb.project_id WHERE pb.id = ? AND pj.owner_id = pb.owner_principal_id`,
  ).bind(p.publisher_id).first<any>();
  if (!row) return null;
  if (row.revoked_at !== null) return { ...row, revoked: true };
  if (row.token_epoch !== p.epoch) return null;
  return row;
}

/**
 * Hosted OAuth callbacks, exact string match only (no wildcards, no ports, no query), each taken from the
 * client vendor's own documentation (see docs/chatgpt-oauth-design.md "Client registration policy"):
 * - ChatGPT apps/connectors (OpenAI developer docs)
 * - Cursor web/Cloud Agents and Grok Bot (cursor.com/docs/context/mcp + Cursor staff on forum.cursor.com)
 * - Claude hosted apps: claude.ai web, Desktop, mobile, Cowork (claude.com/docs/connectors/building/authentication)
 * client_name is never used for this decision.
 */
const HOSTED_CALLBACKS = new Set([
  "https://chatgpt.com/connector_platform_oauth_redirect",
  "https://www.cursor.com/agents/mcp/oauth/callback",
  "https://claude.ai/api/mcp/auth_callback",
]);
/**
 * Listed by Cursor / Grok Bot in every registration next to its https and loopback callbacks. Tolerated in
 * the registration list only; it can never receive a code here (custom schemes are refused at /authorize,
 * by allowedRedirect below and by the library, which has allowPrivateUseRedirectUris off).
 */
const LISTED_ONLY = new Set(["cursor://anysphere.cursor-mcp/oauth/callback"]);
/**
 * Leaving the consent flow for the client (Allow / Deny). Browsers apply CSP form-action to every redirect
 * that follows a form POST, including hops inside the client's own site that we cannot know in advance
 * (observed: www.cursor.com -> cursor.com -> further Cursor redirects, 2026-10-02). So the POST answers with
 * this small same-origin page, and the page navigates to the client (meta refresh + a visible link); that
 * navigation is not a form submission, so form-action no longer applies. Same-tab, no script, no framing,
 * no-store, no-referrer. The target is the library-built redirect to the registered redirect URI only.
 */
function toClient(location: string, headers: Headers, clientHost: string) {
  const u = new URL(location);
  if (!/^https?:$/.test(u.protocol)) return errorPage("This app's callback address is not allowed to connect.");
  const href = esc(location);
  return page("Returning to the app", `<meta http-equiv="refresh" content="0;url=${href}">
<h1>Returning to ${esc(clientHost)}…</h1><p>If nothing happens, <a href="${href}">continue to ${esc(clientHost)}</a>.</p>`, headers, 200);
}
/**
 * Native/local clients (Claude Code, Cursor and Grok Bot desktop, local tests): plain-http loopback.
 * The library matches loopback redirects port-agnostically (RFC 8252 §7.3) and everything else exactly.
 */
const isLoopbackRedirect = (u: string) => /^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?\/[A-Za-z0-9/_.-]*$/.test(u);

/** A redirect URI that may receive an authorization code. Checked at registration and at every /authorize. */
export function allowedRedirect(u: string) {
  return HOSTED_CALLBACKS.has(u)
    || /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]{1,128}$/.test(u)
    || isLoopbackRedirect(u);
}
/** Registration policy: every listed URI is usable or listed-only, and at least one is usable. */
export function registrableRedirects(uris: unknown[]) {
  if (!uris.length || uris.length > 5 || !uris.every((u) => typeof u === "string")) return false;
  const list = uris as string[];
  return list.every((u) => allowedRedirect(u) || LISTED_ONLY.has(u)) && list.some(allowedRedirect);
}
/** Redacted registration record for diagnosis: redirect URIs and descriptive metadata only, never secrets. */
function logRegistration(outcome: string, m: Record<string, unknown>) {
  const s = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : undefined);
  const arr = (v: unknown) => (Array.isArray(v) ? v.slice(0, 8).map((x) => String(x).slice(0, 200)) : undefined);
  console.log("oauth_register " + JSON.stringify({
    outcome, redirect_uris: arr(m.redirect_uris), client_name: s(m.client_name, 100), client_uri: s(m.client_uri, 200),
    grant_types: arr(m.grant_types), response_types: arr(m.response_types), token_endpoint_auth_method: s(m.token_endpoint_auth_method, 40),
    scope: s(m.scope, 200), software_id: s(m.software_id, 100), software_version: s(m.software_version, 40),
  }));
}

export type ConnProject = { id: string; title: string; can_write: number };
/**
 * Live connection lookup used on every MCP call and refresh. Fails closed. Returns the connection row
 * plus its authoritative per-project permissions (only projects still owned by the connection's owner).
 */
export async function liveConnection(env: Env, id: unknown): Promise<null | (Record<string, any> & { projects: ConnProject[] })> {
  if (typeof id !== "string" || !/^oac_[A-Za-z0-9_-]{10,64}$/.test(id)) return null;
  const row = await env.DB.prepare("SELECT * FROM oauth_connections WHERE id = ?").bind(id).first<any>();
  if (!row || row.revoked_at !== null || row.expires_at <= nowMs()) return null;
  const ps = await env.DB.prepare(
    `SELECT p.id, p.title, cp.can_write FROM oauth_connection_projects cp JOIN projects p ON p.id = cp.project_id
     WHERE cp.connection_id = ? AND p.owner_id = ? ORDER BY p.created_at LIMIT ${MAX_CONN_PROJECTS}`,
  ).bind(id, row.owner_principal_id).all<ConnProject>();
  if (!ps.results.length) return null;
  return { ...row, projects: ps.results };
}
export const MAX_CONN_PROJECTS = 50;
const NEW_PROJECT_SLOTS = 5;

// ---------- HTML ----------
const esc = (v: string) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// CSP form-action also governs the redirect that follows a form POST (Chrome enforces it on the redirect
// chain). Each page therefore allows exactly the origin its form will redirect to: the Access-for-SaaS
// origin for "Continue to sign in", and the already-validated client redirect origin for Allow/Deny.
const page = (title: string, body: string, headers?: Headers, status = 200, formTargets: string[] = []) => {
  const h = headers ?? new Headers();
  h.set("content-type", "text/html; charset=utf-8");
  const targets = ["'self'", ...formTargets.filter((o) => /^https:\/\/[a-z0-9.-]+$|^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(o))].join(" ");
  h.set("content-security-policy", `default-src 'none'; style-src 'unsafe-inline'; form-action ${targets}; frame-ancestors 'none'; base-uri 'none'`);
  h.set("x-frame-options", "DENY");
  h.set("cache-control", "no-store");
  h.set("referrer-policy", "no-referrer");
  h.set("x-content-type-options", "nosniff");
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem}fieldset{border:1px solid #ccc;border-radius:8px;margin:1rem 0}button{min-height:44px;padding:.4rem 1rem}label{display:block;margin:.4rem 0}.warn{color:#a12}
.row{display:flex;gap:.75rem;align-items:center;justify-content:space-between;padding:.45rem 0;border-bottom:1px solid #eee}.row:last-child{border-bottom:0}.row .name{flex:1;min-width:0;overflow-wrap:anywhere}
select,input[type=text]{font:inherit;min-height:40px;padding:.2rem .4rem;border:1px solid #bbb;border-radius:6px;background:#fff}input[type=text]{flex:1;min-width:0}small{color:#555}.hint{font-size:.9rem;color:#555}</style>${body}`, { status, headers: h });
};
const errorPage = (msg: string, status = 400) => page("Cannot connect", `<h1>Cannot connect</h1><p>${esc(msg)}</p>`, undefined, status);

function clientFacts(d: { clientName: string; clientDomain?: string; redirectHost: string; redirectIsLoopback: boolean }) {
  return `<p><strong>${esc(d.clientName)}</strong> — ${d.clientDomain ? `published by <strong>${esc(d.clientDomain)}</strong>` : '<span class="warn">self-registered app; its name is not verified</span>'}.
  Access will be sent to <strong>${esc(d.redirectHost)}</strong>.</p>${d.redirectIsLoopback ? '<p class="warn"><strong>This sends access to an app on this computer.</strong> Continue only if you just started connecting from it.</p>' : ""}`;
}

// ---------- authorize / callback ----------
/** Registered (owner-created) App Connect client for this OAuth client_id, if any. */
async function appClientFor(env: OAuthEnv, clientId: string) {
  if (!acOn(env)) return null;
  return env.DB.prepare("SELECT * FROM app_clients WHERE client_id = ?").bind(clientId).first<any>();
}
/** Publisher authorization requests: registered, enabled app client; exact redirect; resource /v1; publish scope only. */
async function checkPublisherRequest(env: OAuthEnv, parsed: AuthRequest, origin: string) {
  const app = await appClientFor(env, parsed.clientId);
  const wantsV1 = parsed.resource === `${origin}/v1`;
  if (!app) return wantsV1 ? { error: "This app is not registered for publishing. The owner must register it in Agent Library first." } : null;
  if (app.disabled_at !== null) return { error: "This app has been disabled by the owner." };
  if (!wantsV1) return { error: "This app can only connect as a publisher (resource " + origin + "/v1)." };
  if (!(JSON.parse(app.redirect_uris) as string[]).includes(parsed.redirectUri)) return { error: "This app's callback address is not registered." };
  const scopes = new Set(parsed.scope);
  if (!scopes.has(SCOPES.publish) || [...scopes].some((x) => x !== SCOPES.publish && x !== SCOPES.offline)) return { error: "Publishers may request only agentlib:publish and offline_access." };
  return { app };
}

async function authorizeGet(req: Request, env: OAuthEnv, as: OAuthAuthorizationServer<OAuthEnv>, origin: string) {
  const oauth = as.getOAuthApi(env);
  const parsed = await oauth.parseAuthRequest(req); // client, exact redirect, PKCE S256 (public), resource
  if (!parsed.codeChallenge || parsed.codeChallengeMethod !== "S256")
    throw new AuthorizationError("invalid_request", { description: "PKCE S256 is required", redirectUri: parsed.redirectUri, state: parsed.state, issuer: parsed.issuer } as any);
  const pubCheck = await checkPublisherRequest(env, parsed, origin);
  if (pubCheck?.error) return errorPage(pubCheck.error);
  if (pubCheck?.app) {
    if (!parsed.state) return errorPage("state is required.");
    const consent = await oauth.beginConsent(parsed);
    const targets = [new URL(oidcConfig(env).authorization).origin];
    const app = pubCheck.app;
    return page("Connect an app to Agent Library", `<h1>Connect ${esc(app.display_name)} to Agent Library?</h1>
<p><strong>${esc(app.display_name)}</strong> (registered by you; app id <code>${esc(app.id)}</code>) wants to <strong>publish its own files</strong>. Access will be sent to <strong>${esc(new URL(parsed.redirectUri).host)}</strong>.</p>
<p>Next you will sign in as the owner, then choose the project and folder for this app's files. Nothing is shared yet.</p>
<form method="post" action="/authorize"><input type="hidden" name="handle" value="${esc(consent.handle)}"><input type="hidden" name="step" value="signin">
<button name="decision" value="approve">Continue to sign in</button> <button name="decision" value="deny">Cancel</button></form>`, consent.headers, 200, targets);
  }
  if (!allowedRedirect(parsed.redirectUri)) return errorPage("This app's callback address is not allowed to connect.");
  const details = await oauth.describeConsent(parsed);
  const consent = await oauth.beginConsent(parsed);
  const targets = [new URL(oidcConfig(env).authorization).origin]; // Continue -> Access; Cancel -> same-origin interstitial
  return page("Connect an app to Agent Library", `<h1>Connect an app to Agent Library?</h1>${clientFacts(details)}
<p>Next you will sign in with Cloudflare Access as the owner, then choose <strong>which projects</strong> to share and what the app may do in each. Nothing is shared yet.</p>
<form method="post" action="/authorize"><input type="hidden" name="handle" value="${esc(consent.handle)}"><input type="hidden" name="step" value="signin">
<button name="decision" value="approve">Continue to sign in</button> <button name="decision" value="deny">Cancel</button></form>`, consent.headers, 200, targets);
}

async function authorizePost(req: Request, env: OAuthEnv, as: OAuthAuthorizationServer<OAuthEnv>, origin: string) {
  const oauth = as.getOAuthApi(env);
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > 16 * 1024) return errorPage("Request too large.", 413);
  const form = await req.formData();
  const handle = String(form.get("handle") ?? "");
  const step = String(form.get("step") ?? "");
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(req, handle);
    const loc = denied.headers.get("location")!;
    denied.headers.delete("location");
    return toClient(loc, denied.headers, new URL(loc).host);
  }
  if (step === "signin") {
    // Step 1 approved: start the upstream Access login. Fresh PKCE verifier + nonce per login, held only in
    // the library's encrypted, single-use, browser-bound transaction (beginUpstream data).
    // (Scope here is provisional; the final grant scope is decided at the last consent step.)
    const approved = await oauth.approveConsent(req, handle, { scope: [SCOPES.read] });
    const secrets = newUpstreamSecrets();
    const { state, headers } = await oauth.beginUpstream(approved.request, { data: secrets, headers: approved.headers });
    headers.set("location", await authorizationUrl(env, { redirectUri: `${origin}/callback`, state, nonce: secrets.nonce, verifier: secrets.verifier }));
    return new Response(null, { status: 302, headers });
  }
  if (step === "publish") return publishConsentPost(req, env, oauth, form, handle, origin);
  if (step === "grant") {
    // Step 2: per-project permission consent (after verified owner sign-in). Validate everything before the
    // single-use consent handle is consumed, so a validation error lets the owner go back and fix the form.
    const sess = await env.OAUTH_KV.get(`consentctx:${await sha(handle)}`, "json") as null | { principal_id: string; app_client_id?: string };
    if (!sess) return errorPage("This consent page expired. Start connecting again from the app.");
    if (sess.app_client_id) return errorPage("This app connects as a publisher. Start connecting again from the app.");
    const owned = await env.DB.prepare("SELECT id, title FROM projects WHERE owner_id = ? ORDER BY created_at LIMIT 500").bind(sess.principal_id).all<any>();
    const chosen: { id: string; write: boolean; isNew?: string }[] = [];
    for (const p of owned.results) {
      const a = String(form.get(`access:${p.id}`) ?? "none");
      if (a === "read" || a === "write") chosen.push({ id: p.id, write: a === "write" });
      else if (a !== "none") return errorPage("Unexpected access choice. Go back and try again.");
    }
    // Up to NEW_PROJECT_SLOTS new projects (fields new_title/new_access, new_title_2/new_access_2, ...).
    const seenTitles = new Set<string>();
    for (let i = 1; i <= NEW_PROJECT_SLOTS; i++) {
      const sfx = i === 1 ? "" : `_${i}`;
      const newTitle = String(form.get(`new_title${sfx}`) ?? "").trim();
      const newAccess = String(form.get(`new_access${sfx}`) ?? "");
      if (!newTitle) continue;
      if (newTitle.length > 200) return errorPage("A new project name is too long (200 characters max). Go back and shorten it.");
      if (newAccess !== "read" && newAccess !== "write") return errorPage(`Choose what the app may do in new project “${newTitle.slice(0, 60)}”. Go back and pick an access level.`);
      if (seenTitles.has(newTitle.toLowerCase())) return errorPage(`“${newTitle.slice(0, 60)}” is listed twice. Go back and remove the duplicate.`);
      seenTitles.add(newTitle.toLowerCase());
      chosen.push({ id: randomId("prj"), write: newAccess === "write", isNew: newTitle });
    }
    if (!chosen.length) return errorPage("Choose at least one project (or create one). Go back and pick an access level.");
    if (chosen.length > MAX_CONN_PROJECTS) return errorPage(`Choose at most ${MAX_CONN_PROJECTS} projects.`);
    const anyWrite = chosen.some((c) => c.write);
    // Token scope ceiling = union; per-project permissions are enforced from D1 on every call.
    const scope = anyWrite ? [SCOPES.read, SCOPES.write, SCOPES.offline] : [SCOPES.read, SCOPES.offline];
    const approved = await oauth.approveConsent(req, handle, { scope });
    await env.OAUTH_KV.delete(`consentctx:${await sha(handle)}`);
    const ar = approved.request;
    const client = await oauth.lookupClient(ar.clientId);
    const connectionId = randomId("oac", 18);
    const at = nowIso(), rid = randomId("req", 9);
    const audit = (projectId: string, action: string, object: string, result: string) =>
      env.DB.prepare("INSERT INTO audits (at, actor_id, project_id, action, object_id, result, request_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(at, sess.principal_id, projectId, action, object, result, rid);
    // One atomic batch: optional new project, connection, per-project permissions, audits.
    await env.DB.batch([
      ...chosen.filter((c) => c.isNew).flatMap((c) => [
        env.DB.prepare("INSERT INTO projects (id, owner_id, title, created_at) VALUES (?, ?, ?, ?)").bind(c.id, sess.principal_id, c.isNew, at),
        audit(c.id, "project.create", c.id, "ok:oauth-consent"),
      ]),
      env.DB.prepare(`INSERT INTO oauth_connections (id, owner_principal_id, project_id, client_id, client_name, redirect_uri, resource, can_read, can_write, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
        .bind(connectionId, sess.principal_id, chosen[0].id, ar.clientId, (client?.clientName ?? ar.clientId).slice(0, 200), ar.redirectUri, `${origin}/mcp`, anyWrite ? 1 : 0, at, nowMs() + CONNECTION_TTL_MS),
      ...chosen.flatMap((c) => [
        env.DB.prepare("INSERT INTO oauth_connection_projects (connection_id, project_id, can_write) VALUES (?, ?, ?)").bind(connectionId, c.id, c.write ? 1 : 0),
        audit(c.id, "oauth.connect", connectionId, c.write ? "ok:read+write" : "ok:read"),
      ]),
    ]);
    const { redirectTo } = await oauth.completeAuthorization({
      request: ar,
      userId: connectionId, // one grant per connection: re-authorizing never broadens/revokes another connection
      metadata: { projects: chosen.length },
      scope: ar.scope,
      props: { connection_id: connectionId } satisfies ConnProps,
      revokeExistingGrants: false,
    });
    return toClient(redirectTo, approved.headers, new URL(redirectTo).host);
  }
  return errorPage("Unexpected form.");
}

/**
 * Strongly consistent single use (D1) for authorization codes and refresh tokens, enforced before the
 * library sees the request. KV (eventually consistent) holds the protocol records; D1's primary key
 * decides the one winner. Any presented value is consumed on first attempt (even a failing one), so a
 * code or refresh token can never be redeemed twice. Trade-off: the library's "retry with the previous
 * refresh token after a lost response" convenience is disabled; such a client re-authorizes.
 */
async function singleUseGate(req: Request, env: OAuthEnv): Promise<Request | Response> {
  const raw = await req.text();
  const p = new URLSearchParams(raw);
  const gt = p.get("grant_type");
  const secret = gt === "authorization_code" ? p.get("code") : gt === "refresh_token" ? p.get("refresh_token") : null;
  if (secret) {
    const h = await sha(`${gt}:${secret}`);
    let won = false;
    try {
      const r = await env.DB.prepare("INSERT INTO oauth_code_redemptions (code_hash, redeemed_at) VALUES (?, ?) ON CONFLICT (code_hash) DO NOTHING")
        .bind(h, nowMs()).run();
      won = (r.meta.changes ?? 0) === 1;
    } catch {
      return oauthJson(503, { error: "temporarily_unavailable", error_description: "Try again" }); // fail closed
    }
    if (!won) return oauthJson(400, { error: "invalid_grant", error_description: gt === "authorization_code" ? "Authorization code already used" : "Refresh token already used" });
  }
  return new Request(req, { body: raw });
}
/** Read at most `max` bytes of a request body; null when it is larger. */
async function readCapped(req: Request, max: number): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { await reader.cancel().catch(() => {}); return null; }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}
const oauthJson = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", pragma: "no-cache" } });

async function sha(v: string) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)));
  return [...d].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function callback(req: Request, env: OAuthEnv, as: OAuthAuthorizationServer<OAuthEnv>, origin: string) {
  const oauth = as.getOAuthApi(env);
  // State: single use, 10 min, bound to this browser by a __Host- cookie. Data (verifier, nonce) is
  // decrypted from server-side storage only; nothing security-relevant comes from the query besides code.
  const resumed = await oauth.finishUpstream<{ verifier: string; nonce: string }>(req);
  const url = new URL(req.url);
  if (url.searchParams.get("error") || !url.searchParams.get("code")) {
    resumed.headers.set("location", authorizationErrorRedirect(resumed.request, "access_denied"));
    return new Response(null, { status: 302, headers: resumed.headers });
  }
  let ident;
  try {
    ident = await exchangeAndVerify(env, { code: url.searchParams.get("code")!, redirectUri: `${origin}/callback`, verifier: resumed.data.verifier, nonce: resumed.data.nonce });
  } catch (e: any) {
    console.log("upstream_signin_failed", e?.code ?? "error");
    resumed.headers.set("location", authorizationErrorRedirect(resumed.request, "access_denied", "Owner sign-in failed"));
    return new Response(null, { status: 302, headers: resumed.headers });
  }
  // Map the verified (issuer, subject) to the owner principal. First link requires exactly one human owner.
  let principalId = await env.DB.prepare("SELECT principal_id FROM upstream_identities WHERE issuer = ? AND subject = ?").bind(ident.issuer, ident.subject).first<string>("principal_id");
  if (!principalId) {
    const humans = await env.DB.prepare("SELECT id FROM principals WHERE kind = 'human' AND issuer <> 'restored'").all<any>();
    if (humans.results.length !== 1) return errorPage("No unique owner account to link. Sign in to the Agent Library web app first.", 403);
    principalId = humans.results[0].id as string;
    await env.DB.prepare("INSERT INTO upstream_identities (issuer, subject, principal_id, email, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(ident.issuer, ident.subject, principalId, ident.email, nowIso()).run();
  }
  const projects = await env.DB.prepare("SELECT id, title FROM projects WHERE owner_id = ? ORDER BY created_at LIMIT 500").bind(principalId).all<any>();
  const pubApp = await appClientFor(env, resumed.request.clientId);
  if (pubApp && resumed.request.resource === `${origin}/v1`) {
    if (pubApp.owner_principal_id !== principalId) return errorPage("This app is registered to a different owner.", 403);
    return publishConsentPage(env, oauth, resumed, pubApp, principalId, ident.email, projects.results);
  }
  // Step-2 consent: a new browser-bound handle for the same (library-stored) request.
  const details = await oauth.describeConsent(resumed.request);
  const consent = await oauth.beginConsent(resumed.request);
  await env.OAUTH_KV.put(`consentctx:${await sha(consent.handle)}`, JSON.stringify({ principal_id: principalId }), { expirationTtl: 600 });
  for (const [k, v] of resumed.headers) if (k.toLowerCase() === "set-cookie") consent.headers.append("set-cookie", v);
  const accessSelect = (name: string, label: string, withNone: boolean) => `<select name="${esc(name)}" aria-label="${esc(label)}">${withNone ? '<option value="none" selected>No access</option>' : '<option value="" selected>Choose access…</option>'}<option value="read">Read</option><option value="write">Read and edit</option></select>`;
  const rows = projects.results.map((p: any) => `<div class="row"><span class="name">${esc(p.title)} <small>(${esc(p.id)})</small></span>${accessSelect(`access:${p.id}`, `Access to ${p.title}`, true)}</div>`).join("");
  return page("Choose access", `<h1>Choose what to share</h1>${clientFacts(details)}
<p>Signed in as <strong>${esc(ident.email)}</strong>. Pick what the app may do in each project. Projects left at <em>No access</em> are not shared. You can revoke this connection any time in Agent Library.</p>
<form method="post" action="/authorize"><input type="hidden" name="handle" value="${esc(consent.handle)}"><input type="hidden" name="step" value="grant">
<fieldset><legend>Projects</legend>${rows || '<p class="hint">You have no projects yet. Create one below.</p>'}</fieldset>
<fieldset><legend>Create new projects (optional)</legend>
${Array.from({ length: NEW_PROJECT_SLOTS }, (_, k) => { const sfx = k === 0 ? "" : `_${k + 1}`; return `<div class="row"><input type="text" name="new_title${sfx}" maxlength="200" placeholder="New project name" aria-label="New project ${k + 1} name">${accessSelect(`new_access${sfx}`, `Access to new project ${k + 1}`, false)}</div>`; }).join("")}
<p class="hint">Fill in as many rows as you need (up to ${NEW_PROJECT_SLOTS}); empty rows are skipped. Projects are created when you click Allow, and you can always add more in Agent Library.</p></fieldset>
<p class="hint"><strong>Read</strong>: read Markdown documents and history. <strong>Read and edit</strong>: also create and edit Markdown documents.
Files, comments, trash and project/grant administration are never available to connected apps.</p>
<button name="decision" value="approve">Allow</button> <button name="decision" value="deny">Deny</button></form>`, consent.headers, 200); // Allow/Deny answer with a same-origin interstitial (toClient)
}

// ---------- App Connect: publisher consent (contract §8) ----------
async function readerAudience(env: OAuthEnv, ownerId: string, projectId: string) {
  const conns = await env.DB.prepare(
    `SELECT oc.client_name AS name, cp.can_write FROM oauth_connections oc JOIN oauth_connection_projects cp ON cp.connection_id = oc.id
     WHERE cp.project_id = ? AND oc.owner_principal_id = ? AND oc.revoked_at IS NULL AND oc.expires_at > ? ORDER BY oc.created_at`,
  ).bind(projectId, ownerId, nowMs()).all<any>();
  const keys = await env.DB.prepare(
    `SELECT ac.label AS name, acp.can_write FROM api_credentials ac JOIN api_credential_projects acp ON acp.credential_id = ac.id
     WHERE acp.project_id = ? AND ac.owner_principal_id = ? AND ac.revoked_at IS NULL AND ac.expires_at > ? ORDER BY ac.created_at`,
  ).bind(projectId, ownerId, nowMs()).all<any>();
  return [...conns.results.map((c) => ({ kind: "Connected app", ...c })), ...keys.results.map((k) => ({ kind: "API key", ...k }))];
}

async function publishConsentPage(env: OAuthEnv, oauth: any, resumed: any, app: any, principalId: string, email: string, projects: any[]) {
  const consent = await oauth.beginConsent(resumed.request);
  await env.OAUTH_KV.put(`consentctx:${await sha(consent.handle)}`, JSON.stringify({ principal_id: principalId, app_client_id: app.id }), { expirationTtl: 600 });
  for (const [k, v] of resumed.headers) if (k.toLowerCase() === "set-cookie") consent.headers.append("set-cookie", v);
  const preselected = projects[0];
  const projOpts = projects.map((p) => `<option value="${esc(p.id)}"${preselected && p.id === preselected.id ? " selected" : ""}>${esc(p.title)} (${esc(p.id)})</option>`).join("");
  const folders = await env.DB.prepare(`SELECT f.id, f.name, f.project_id, p.title FROM folders f JOIN projects p ON p.id = f.project_id WHERE p.owner_id = ? ORDER BY p.title, f.name_key LIMIT 500`).bind(principalId).all<any>();
  const folderOpts = folders.results.map((f) => `<option value="folder:${esc(f.id)}">Existing folder: ${esc(f.title)} / ${esc(f.name)}</option>`).join("");
  const prev = await env.DB.prepare(
    `SELECT pb.id, pb.created_at, pb.current_source_revision, pb.revoked_at, p.title AS project_title, f.name AS folder_name FROM publishers pb
     JOIN projects p ON p.id = pb.project_id LEFT JOIN folders f ON f.id = pb.folder_id WHERE pb.app_client_id = ? AND pb.owner_principal_id = ? ORDER BY pb.created_at DESC LIMIT 20`,
  ).bind(app.id, principalId).all<any>();
  const resumeRows = prev.results.filter((r) => r.revoked_at === null).map((r) => `<label><input type="radio" name="resume" value="${esc(r.id)}"> Resume <code>${esc(r.id)}</code>: ${esc(r.project_title)} / ${r.folder_name ? esc(r.folder_name) : "(project root)"}, created ${esc(r.created_at.slice(0, 10))}, last export revision ${r.current_source_revision ?? "none"}</label>`).join("");
  const audiences = await Promise.all(projects.map(async (p) => [p.id, await readerAudience(env, principalId, p.id)] as const));
  const audienceHtml = audiences.map(([pid, a]) => `<div class="hint" data-project="${esc(pid)}"><strong>${esc(projects.find((p) => p.id === pid)!.title)}</strong>: ${a.length ? a.map((x) => `${esc(x.kind)} “${esc(x.name)}” (${x.can_write ? "read & edit" : "read"})`).join(", ") : "no connected apps or API keys yet"}</div>`).join("");
  return page("Choose where this app publishes", `<h1>Where should ${esc(app.display_name)} publish?</h1>
<p>Signed in as <strong>${esc(email)}</strong>. The app will be able to <strong>create files and read/update only the files it creates</strong>. It can't see any other file, even in the same folder or project.</p>
<form method="post" action="/authorize"><input type="hidden" name="handle" value="${esc(consent.handle)}"><input type="hidden" name="step" value="publish">
<fieldset><legend>Project</legend><select name="project_id" aria-label="Project">${projOpts}</select></fieldset>
<fieldset><legend>Folder</legend>
<select name="destination" aria-label="Destination"><option value="new" selected>New folder (name below)</option><option value="root">No folder (project root)</option>${folderOpts}</select>
<label>New folder name <input type="text" name="new_folder_name" maxlength="80" value="${esc(app.display_name.replace(/\s*\(.*\)\s*$/, "") || "App files")}" aria-label="New folder name"></label>
<p class="hint">An existing folder must be in the chosen project.</p></fieldset>
<fieldset><legend>Who can already read these files</legend>
<p class="hint">Everyone below can already read the chosen project. They will be able to read this app's files, <strong>including future exports</strong>, and <strong>cannot edit them</strong>. Nothing new is granted to them by this step.</p>${audienceHtml}</fieldset>
<fieldset><legend>Earlier connections of this app</legend>${resumeRows ? `<label><input type="radio" name="resume" value="new" checked> Start a new publisher (separate files)</label>${resumeRows}<p class="hint">Resuming continues an earlier publisher's files, project and folder. Its older sign-ins stop working. Nothing resumes unless you choose it here.</p>` : '<input type="hidden" name="resume" value="new"><p class="hint">None. A new publisher will be created.</p>'}</fieldset>
<button name="decision" value="approve">Allow</button> <button name="decision" value="deny">Deny</button></form>`, consent.headers, 200);
}

async function publishConsentPost(req: Request, env: OAuthEnv, oauth: any, form: FormData, handle: string, origin: string) {
  const sess = await env.OAUTH_KV.get(`consentctx:${await sha(handle)}`, "json") as null | { principal_id: string; app_client_id?: string };
  if (!sess?.app_client_id) return errorPage("This consent page expired. Start connecting again from the app.");
  const app = await env.DB.prepare("SELECT * FROM app_clients WHERE id = ? AND owner_principal_id = ? AND disabled_at IS NULL").bind(sess.app_client_id, sess.principal_id).first<any>();
  if (!app) return errorPage("This app is no longer registered or has been disabled.");
  const resume = String(form.get("resume") ?? "new");
  const at = nowIso(), rid = randomId("req", 9);
  const audit = (projectId: string, action: string, object: string, result: string) =>
    env.DB.prepare("INSERT INTO audits (at, actor_id, project_id, action, object_id, result, request_id) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(at, sess.principal_id, projectId, action, object, result, rid);
  let publisherId: string, epoch: number;
  const stmts: D1PreparedStatement[] = [];
  if (resume !== "new") {
    // Owner-approved resume of an earlier publisher of the SAME app client and owner (never by name).
    const prev = await env.DB.prepare("SELECT * FROM publishers WHERE id = ? AND app_client_id = ? AND owner_principal_id = ? AND revoked_at IS NULL")
      .bind(resume, app.id, sess.principal_id).first<any>();
    if (!prev) return errorPage("That earlier connection can't be resumed. Go back and choose again.");
    publisherId = prev.id; epoch = prev.token_epoch + 1;
    stmts.push(env.DB.prepare("UPDATE publishers SET token_epoch = ?, resumed_at = ? WHERE id = ? AND token_epoch = ? AND revoked_at IS NULL").bind(epoch, at, publisherId, prev.token_epoch),
      audit(prev.project_id, "publisher.resume", publisherId, "ok"));
  } else {
    const projectId = String(form.get("project_id") ?? "");
    const proj = await env.DB.prepare("SELECT id FROM projects WHERE id = ? AND owner_id = ?").bind(projectId, sess.principal_id).first();
    if (!proj) return errorPage("Choose one of your projects. Go back and try again.");
    const dest = String(form.get("destination") ?? "");
    let folderId: string | null = null;
    publisherId = randomId("pub", 15); epoch = 1;
    const principalId = randomId("agt");
    if (dest === "root") folderId = null;
    else if (dest.startsWith("folder:")) {
      const f = await env.DB.prepare("SELECT id FROM folders WHERE id = ? AND project_id = ?").bind(dest.slice(7), projectId).first<string>("id");
      if (!f) return errorPage("That folder is not in the chosen project. Go back and choose again.");
      folderId = f;
    } else if (dest === "new") {
      let nm: { name: string; key: string };
      try { nm = folderName(form.get("new_folder_name")); } catch (e: any) { return errorPage(`${e.message}. Go back and fix the folder name.`); }
      const ex = await env.DB.prepare("SELECT id FROM folders WHERE project_id = ? AND name_key = ?").bind(projectId, nm.key).first<string>("id");
      if (ex) return errorPage(`A folder named “${nm.name}” already exists in this project. Go back and choose “Existing folder”, or pick another name.`);
      folderId = randomId("fld");
      stmts.push(env.DB.prepare("INSERT INTO folders (id, project_id, name, name_key, created_at, created_by, publisher_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(folderId, projectId, nm.name, nm.key, at, sess.principal_id, publisherId), audit(projectId, "folder.create", folderId, "ok:publisher-consent"));
    } else return errorPage("Choose a folder option. Go back and try again.");
    stmts.push(
      env.DB.prepare("INSERT INTO principals (id, kind, issuer, subject, label, created_at) VALUES (?, 'agent', 'agent-library-publisher', ?, ?, ?)").bind(principalId, publisherId, `publisher:${app.display_name}`.slice(0, 200), at),
      env.DB.prepare(`INSERT INTO publishers (id, owner_principal_id, principal_id, app_client_id, display_name, project_id, folder_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(publisherId, sess.principal_id, principalId, app.id, app.display_name, projectId, folderId, at),
      audit(projectId, "publisher.connect", publisherId, folderId ? "ok:folder" : "ok:root"));
  }
  const approved = await oauth.approveConsent(req, handle, { scope: [SCOPES.publish, SCOPES.offline] });
  await env.OAUTH_KV.delete(`consentctx:${await sha(handle)}`);
  let res: D1Result[];
  try { res = await env.DB.batch(stmts); }
  catch (e: any) {
    if (/UNIQUE/i.test(String(e?.message))) return errorPage("A folder with that name was just created in this project. Start connecting again from the app and choose it as an existing folder, or pick another name.");
    throw e;
  }
  if (resume !== "new" && !res[0].meta.changes) return errorPage("That connection changed while you were deciding. Start again from the app.");
  const ar = approved.request;
  const { redirectTo } = await oauth.completeAuthorization({
    request: ar, userId: `${publisherId}.e${epoch}`, metadata: { publisher: publisherId }, scope: [SCOPES.publish, SCOPES.offline],
    props: { publisher_id: publisherId, epoch } satisfies PubProps, revokeExistingGrants: false,
  });
  return toClient(redirectTo, approved.headers, new URL(redirectTo).host);
}

// ---------- dispatcher for the OAuth host ----------
const AS_PATHS = new Set(["/.well-known/oauth-authorization-server", "/oauth/token", "/oauth/register"]);
const RS_META = "/.well-known/oauth-protected-resource/mcp";

export async function handleOAuthHost(req: Request, env: OAuthEnv, ctx: ExecutionContext, host: string): Promise<Response> {
  const origin = originFor(host);
  const url = new URL(req.url);
  const { as, rs, v1 } = servers(origin, acOn(env));
  const json404 = () => new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  if (!env.OAUTH_KV) return new Response(JSON.stringify({ error: "temporarily_unavailable" }), { status: 503, headers: { "content-type": "application/json" } });
  try {
    const ip = req.headers.get("cf-connecting-ip") ?? "local";
    if (url.pathname === "/authorize") {
      await rateLimit(env, "oauthauthz:" + ip, lim(env, "authorize"));
      if (req.method === "GET") return await authorizeGet(req, env, as, origin);
      if (req.method === "POST") return await authorizePost(req, env, as, origin);
      return new Response(null, { status: 405, headers: { allow: "GET, POST" } });
    }
    if (url.pathname === "/callback" && req.method === "GET") { await rateLimit(env, "oauthauthz:" + ip, lim(env, "authorize")); return await callback(req, env, as, origin); }
    if (AS_PATHS.has(url.pathname)) {
      // Browser publisher apps call the token endpoint cross-origin: CORS only for registered app origins.
      if (url.pathname === "/oauth/token" && req.method === "OPTIONS" && acOn(env)) return await publisherPreflight(req, env);
      if (req.method === "POST") {
        // Bounded read that also accepts bodies without Content-Length (chunked clients). Never logs the body.
        const declared = req.headers.get("content-length");
        const tooLarge = () => new Response(JSON.stringify({ error: "invalid_request", error_description: "Body too large" }), { status: 413, headers: { "content-type": "application/json" } });
        if (declared !== null && !(Number(declared) <= 16 * 1024)) return tooLarge();
        const buf = await readCapped(req, 16 * 1024);
        if (!buf) return tooLarge();
        console.log("oauth_post " + JSON.stringify({ path: url.pathname, length: buf.byteLength, has_length: declared !== null, ct: (req.headers.get("content-type") ?? "").slice(0, 60), ua: (req.headers.get("user-agent") ?? "").slice(0, 80) }));
        req = new Request(req, { body: buf });
        if (url.pathname === "/oauth/token") await rateLimit(env, "oauthtok:" + ip, lim(env, "token"));
        if (url.pathname === "/oauth/register") await rateLimit(env, "oauthreg:" + ip, lim(env, "register"));
      }
      if (url.pathname === "/oauth/token" && req.method === "POST") {
        const gated = await singleUseGate(req, env);
        const res = gated instanceof Response ? gated : await as.fetch(gated, env, ctx);
        return acOn(env) ? await withPublisherCors(req, env, res) : res;
      }
      return await as.fetch(req, env, ctx);
    }
    if (url.pathname === RS_META || url.pathname === "/mcp") return await rs.fetch(req, env, ctx);
    // App Connect publisher API (flag on only): /v1/publisher/* and its resource metadata.
    if (v1 && (url.pathname === "/.well-known/oauth-protected-resource/v1" || url.pathname.startsWith("/v1/publisher/") || url.pathname === "/v1/publisher")) {
      if (req.method === "OPTIONS") return await publisherPreflight(req, env);
      return await withPublisherCors(req, env, await v1.fetch(req, env, ctx));
    }
    return json404();
  } catch (e) {
    if (e instanceof AuthorizationError) {
      if (e.redirectTo) return Response.redirect(e.redirectTo, 302);
      return errorPage(e.description);
    }
    if (e instanceof CimdFetchError) return errorPage("This app could not be verified.");
    if ((e as any)?.status === 429) return new Response(JSON.stringify({ error: "temporarily_unavailable" }), { status: 429, headers: { "content-type": "application/json", "retry-after": "60" } });
    console.log("oauth_host_error", (e as any)?.code ?? (e as Error)?.name ?? "error", env.APP_CONNECT_ENABLED === "1" && /^(127\.0\.0\.1|localhost)/.test(host) ? String((e as Error)?.stack ?? "").slice(0, 600) : "");
    return new Response(JSON.stringify({ error: "server_error" }), { status: 500, headers: { "content-type": "application/json" } });
  }
}

export function _servers(origin: string, appConnect = false) { return servers(origin, appConnect); }

// ---------- App Connect: CORS for registered app origins only (contract §9.6) ----------
async function registeredOrigin(env: OAuthEnv, origin: string | null) {
  if (!origin || !/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(origin)) return false;
  // Enabled clients, plus disabled clients that still have live publishers (disable only stops new connections).
  const rows = await env.DB.prepare(`SELECT origins FROM app_clients ac WHERE ac.disabled_at IS NULL
      OR EXISTS (SELECT 1 FROM publishers pb WHERE pb.app_client_id = ac.id AND pb.revoked_at IS NULL)`).all<any>();
  return rows.results.some((r) => (JSON.parse(r.origins) as string[]).includes(origin));
}
async function publisherPreflight(req: Request, env: OAuthEnv) {
  const origin = req.headers.get("origin");
  if (!(await registeredOrigin(env, origin))) return new Response(null, { status: 403, headers: { vary: "Origin" } });
  return new Response(null, { status: 204, headers: {
    "access-control-allow-origin": origin!, "access-control-allow-methods": "GET, POST",
    "access-control-allow-headers": "Authorization, Content-Type, Idempotency-Key", "access-control-max-age": "600", vary: "Origin" } });
}
/** Replace any library CORS headers: exact registered origin or none (bearer only, never credentials). */
async function withPublisherCors(req: Request, env: OAuthEnv, res: Response) {
  const r = new Response(res.body, res);
  for (const h of ["access-control-allow-origin", "access-control-allow-methods", "access-control-allow-headers", "access-control-max-age", "access-control-allow-credentials"]) r.headers.delete(h);
  const origin = req.headers.get("origin");
  if (await registeredOrigin(env, origin)) {
    r.headers.set("access-control-allow-origin", origin!);
    r.headers.set("access-control-expose-headers", "WWW-Authenticate, Retry-After, X-Request-Id");
  }
  r.headers.set("vary", "Origin");
  return r;
}
export type { AuthRequest };
