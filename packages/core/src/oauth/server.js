import { AuthorizationError, CimdFetchError, OAuthAuthorizationServer, OAuthError, OAuthResourceServer, authorizationErrorRedirect } from "@cloudflare/workers-oauth-provider";
import { handlePublisherApi } from "../api/publisher.js";
import { rateLimit } from "../auth.js";
import { handleOAuthMcp } from "./mcp.js";
import { adapters } from "../adapters.js";
import { mayCreateAccount, principalForIdentity } from "../identity/accounts.js";
import { randomToken } from "../identity/jwt.js";
import { EMAIL_RE, checkEmailPage, limitSigninStart, startFailure } from "../identity/browser.js";
import { TURNSTILE_ORIGIN, requireHuman, turnstileSiteKey } from "../identity/turnstile.js";
import { limitGuard } from "../limits.js";
import { HttpError } from "../util.js";
import { __name } from "../runtime.js";
import { folderName } from "../service.js";
import { ROLE_RANK, memberRoleSql, personalWorkspaceId, visibleProjects, workspaceRoleSql } from "../tenancy.js";
import { nowIso, nowMs, randomId } from "../util.js";

function originFor(host) {
  // Loopback (local dev and tests; *.localhost names a second local site, e.g. the user-content host) is plain http.
  return /^(127\.0\.0\.1|([a-z0-9-]+\.)?localhost)(:\d+)?$/.test(host) ? `http://${host}` : `https://${host}`;
}
function servers(origin, appConnect = false) {
  const cacheKey = origin + (appConnect ? "#ac" : "");
  let s = cache.get(cacheKey);
  if (s) return s;
  const resource = `${origin}/mcp`;
  const v1Resource = `${origin}/v1`;
  const as = new OAuthAuthorizationServer({
    issuer: origin,
    resources: appConnect ? [resource, v1Resource] : [resource],
    ...appConnect ? { defaultResource: resource } : {},
    scopesSupported: appConnect ? AC_CATALOGUE : CATALOGUE,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    clientIdMetadataDocumentEnabled: true,
    accessTokenTTL: 15 * 60,
    refreshTokenTTL: 10 * 365 * 24 * 3600,
    refreshTokenIdleTTL: 10 * 365 * 24 * 3600,
    clientRegistrationTTL: 10 * 365 * 24 * 3600,
    // Every refresh rechecks the D1 connection; revoked or expired connections cannot refresh.
    tokenExchangeCallback: async ({ grantType, props, env }) => {
  if (grantType !== "refresh_token") return;
  const retry = () => new OAuthError("temporarily_unavailable", {
    description: "Token renewal is temporarily unavailable. Retry shortly.",
    statusCode: 503, headers: { "retry-after": "300" }
  });
  try {
    if (props?.publisher_id) {
      const publisher = await livePublisher(env, props);
      if (!publisher || publisher.revoked) throw new OAuthError("invalid_grant", { description: "Publisher revoked or token superseded" });
      if (env.__oauthRefreshClaimBusy) throw retry();
      return;
    }
    const connection = await liveConnection(env, props?.connection_id);
    // Suspended workspaces stay readable (read-only), so their connections and publishers keep refreshing;
    // revoked/expired connections, removed creators and deleting workspaces are invalid_grant.
    if (!connection) throw new OAuthError("invalid_grant", { description: "Connection revoked or expired" });
    if (env.__oauthRefreshClaimBusy) throw retry();
    // Preserve only currently valid connections. Never revive an expired/revoked grant or widen its projects.
    const renewed = await env.DB.prepare("UPDATE oauth_connections SET expires_at = ? WHERE id = ? AND revoked_at IS NULL AND expires_at > ? RETURNING id")
      .bind(Date.UTC(9999, 0, 1), connection.id, nowMs()).first();
    if (!renewed) throw new OAuthError("invalid_grant", { description: "Connection revoked or expired" });
  } catch (error) {
    if (error instanceof OAuthError) throw error;
    // The provider revokes grants on invalid_grant. A storage outage is retryable and must leave tokens intact.
    throw retry();
  }
},
    // Registration is rate-limited in the dispatcher (per IP, 10/min) before this runs.
    clientRegistrationCallback: async ({ clientMetadata }) => {
      if (typeof clientMetadata.scope === "string" && clientMetadata.scope.split(/\s+/).includes(SCOPES.publish))
        return { description: "agentlib:publish is only available to owner-registered apps" };
      const uris = Array.isArray(clientMetadata.redirect_uris) ? clientMetadata.redirect_uris : [];
      const ok2 = registrableRedirects(uris);
      logRegistration(ok2 ? "accepted" : "rejected", clientMetadata);
      if (!ok2) return { description: "redirect_uris must be verified ChatGPT, Cursor/Grok Bot or Claude callbacks, or loopback for local clients" };
      return;
    },
    onError: ({ code, internal }) => {
      console.log("oauth_error", code, internal?.reason ?? "");
    }
  });
  const rs = new OAuthResourceServer({
    resourceMetadata: { resource, authorization_servers: [origin], bearer_methods_supported: ["header"], resource_name: "Agent Library" },
    requiredScopes: [SCOPES.read],
    validateToken: (env) => (res, token) => as.validateToken(res, token, env),
    handler: { fetch: (req, env, ctx) => handleOAuthMcp(req, env, ctx) }
  });
  s = { as, rs };
  if (appConnect) {
    s.v1 = new OAuthResourceServer({
      resourceMetadata: { resource: v1Resource, authorization_servers: [origin], bearer_methods_supported: ["header"], resource_name: "Agent Library publisher API" },
      requiredScopes: [SCOPES.publish],
      validateToken: (env) => (res, token) => as.validateToken(res, token, env),
      handler: { fetch: (req, env, ctx) => handlePublisherApi(req, env, ctx) }
    });
  }
  cache.set(cacheKey, s);
  return s;
}
async function livePublisher(env, p) {
  if (!p || typeof p.publisher_id !== "string" || !/^pub_[A-Za-z0-9_-]{10,64}$/.test(p.publisher_id)) return null;
  const row = await env.DB.prepare(
    `SELECT pb.*, ac.client_id, ac.disabled_at AS client_disabled, ac.id AS apc_id FROM publishers pb JOIN app_clients ac ON ac.id = pb.app_client_id
     JOIN projects pj ON pj.id = pb.project_id WHERE pb.id = ?
       AND ${memberRoleSql("pj.id", "member", "COALESCE(pb.created_by, pb.owner_principal_id)", true)}`
  ).bind(p.publisher_id).first();
  if (!row) return null;
  if (row.revoked_at !== null) return { ...row, revoked: true };
  if (row.token_epoch !== p.epoch) return null;
  return row;
}
function toClient(location, headers, clientHost) {
  const u = new URL(location);
  if (!/^https?:$/.test(u.protocol)) return errorPage("This app's callback address is not allowed to connect.");
  const href = esc(location);
  const denied = u.searchParams.has("error");
  return page(denied ? "Cancelled" : "Connected", `<meta http-equiv="refresh" content="0;url=${href}">
${cxShell(`<div class="state ${denied ? "neutral" : "on"}"><span class="big" aria-hidden="true">${cxIcon(denied ? "x" : "check")}</span>
<h1>${denied ? "Cancelled" : "Connected"}</h1><p class="lede">${denied ? "Nothing was shared. " : ""}Taking you back to <strong>${esc(clientHost)}</strong>\u2026</p>
<p class="fine"><a href="${href}">Continue to ${esc(clientHost)}</a> if nothing happens.</p></div>`, !denied)}`, headers, 200);
}
// Module-level is safe: vars belong to a Worker version and an isolate runs exactly one version, so every request
// in an isolate sees the same value. (The OAuth library does not pass env to clientRegistrationCallback.)
var EXTRA_CALLBACKS = /* @__PURE__ */ new Set(), extraCallbacksRaw = "";
function configureExtraCallbacks(env) {
  const raw = typeof env?.OAUTH_EXTRA_REDIRECT_URIS === "string" ? env.OAUTH_EXTRA_REDIRECT_URIS : "";
  if (raw === extraCallbacksRaw) return;
  extraCallbacksRaw = raw;
  EXTRA_CALLBACKS = new Set(raw.split(/[\s,]+/).filter((u) => /^https:\/\/[a-z0-9.-]+(:\d{1,5})?\/[A-Za-z0-9\/_.~-]*$/.test(u)));
}
function allowedRedirect(u) {
  return HOSTED_CALLBACKS.has(u) || EXTRA_CALLBACKS.has(u) || /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]{1,128}$/.test(u) || isLoopbackRedirect(u);
}
function registrableRedirects(uris) {
  if (!uris.length || uris.length > 5 || !uris.every((u) => typeof u === "string")) return false;
  const list2 = uris;
  return list2.every((u) => allowedRedirect(u) || LISTED_ONLY.has(u)) && list2.some(allowedRedirect);
}
function logRegistration(outcome, m) {
  const s = (v, n) => typeof v === "string" ? v.slice(0, n) : void 0;
  const arr = (v) => Array.isArray(v) ? v.slice(0, 8).map((x) => String(x).slice(0, 200)) : void 0;
  console.log("oauth_register " + JSON.stringify({
    outcome,
    redirect_uris: arr(m.redirect_uris),
    client_name: s(m.client_name, 100),
    client_uri: s(m.client_uri, 200),
    grant_types: arr(m.grant_types),
    response_types: arr(m.response_types),
    token_endpoint_auth_method: s(m.token_endpoint_auth_method, 40),
    scope: s(m.scope, 200),
    software_id: s(m.software_id, 100),
    software_version: s(m.software_version, 40)
  }));
}
// Projects a person can connect an agent to: every visible project, with whether they may grant edit access.
async function consentProjects(env, principalId) {
  const list = (await visibleProjects(env, principalId)).slice(0, 500).map((p) => ({ id: p.id, title: p.title, workspace_id: p.workspace_id,
    workspace_name: p.personal ? null : p.workspace_name, can_write: ROLE_RANK[p.role] >= ROLE_RANK.member && p.workspace_status === "active" }));
  // Active workspaces where the signer may create projects (admin+), including ones with no projects yet.
  list.adminWorkspaces = (await env.DB.prepare(`SELECT w.id, w.name, w.personal FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
    WHERE m.principal_id = ? AND w.status = 'active' AND m.role IN ('owner','admin') ORDER BY w.personal DESC, w.created_at LIMIT 50`).bind(principalId).all()).results
    .map((w) => ({ id: w.id, name: w.personal ? null : w.name }));
  return list;
}
async function liveConnection(env, id) {
  if (typeof id !== "string" || !/^oac_[A-Za-z0-9_-]{10,64}$/.test(id)) return null;
  const row = await env.DB.prepare("SELECT * FROM oauth_connections WHERE id = ?").bind(id).first();
  if (!row || row.revoked_at !== null || row.expires_at <= nowMs()) return null;
  const ps = await env.DB.prepare(
    `SELECT p.id, p.title, cp.can_write AND ${memberRoleSql("p.id", "member")} AS can_write,
       cp.can_write AND ${memberRoleSql("p.id", "member", "?", true)} AND NOT ${memberRoleSql("p.id", "member")} AS read_only
     FROM oauth_connection_projects cp JOIN projects p ON p.id = cp.project_id
     WHERE cp.connection_id = ? AND ${memberRoleSql("p.id", "viewer")} ORDER BY p.created_at LIMIT ${MAX_CONN_PROJECTS}`
  ).bind(...Array(3).fill(row.created_by ?? row.owner_principal_id), id, row.created_by ?? row.owner_principal_id).all();
  if (!ps.results.length) return null;
  return { ...row, projects: ps.results };
}
// ---- connect page building blocks ----
function cxIcon(name) {
  const P = {
    check: "M20 6 9 17l-5-5",
    x: "M18 6 6 18M6 6l12 12",
    alert: "M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
    back: "M9 10l-5 5 5 5M20 4v7a4 4 0 0 1-4 4H4",
    plus: "M12 5v14M5 12h14",
    chev: "M9 6l6 6-6 6",
    next: "M5 12h14M13 6l6 6-6 6",
    redo: "M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5",
    lock: "M7 11V7a5 5 0 0 1 10 0v4M5 11h14v10H5z"
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${P[name]}"/></svg>`;
}
function cxShell(inner, foot = true) {
  return `<header class="top"><span class="mark" aria-hidden="true"></span><span>Agent Library</span></header>
<main class="card">${inner}</main>${foot ? `
<p class="foot">${cxIcon("lock")}You can disconnect apps any time in Agent Library settings.</p>` : ""}`;
}
// A fixable mistake, shown above the form it belongs to.
function cxErr(msg) {
  return msg ? `<div class="callout bad" role="alert">${cxIcon("alert")}<div>${esc(msg)}</div></div>` : "";
}
// The app's initial on a tile coloured from its name, joined to the Library mark.
function cxPair(name) {
  const s = String(name ?? "").trim();
  const ch = (s.match(/[A-Za-z0-9]/) ?? ["?"])[0].toUpperCase();
  let hue = 0;
  for (const c of s) hue = (hue * 31 + c.codePointAt(0)) % 360;
  return `<div class="pair" aria-hidden="true"><span class="av" style="--h:${hue}">${esc(ch)}</span><span class="link"><i></i><i></i><i></i></span><span class="mark lg"></span></div>`;
}
function cxChip(kind, icon, text) {
  return `<span class="chip${kind ? " " + kind : ""}">${cxIcon(icon)}<span>${text}</span></span>`;
}
function cxDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const opts = { month: "short", day: "numeric", timeZone: "UTC" };
  if (d.getUTCFullYear() !== new Date().getUTCFullYear()) opts.year = "numeric";
  return d.toLocaleDateString("en-US", opts);
}
// Projects whose titles collide also show their id.
function cxDupes(list) {
  const n = /* @__PURE__ */ new Map();
  for (const p of list) n.set(p.title.trim().toLowerCase(), (n.get(p.title.trim().toLowerCase()) ?? 0) + 1);
  return (p) => n.get(p.title.trim().toLowerCase()) > 1;
}
// Enter in a text field submits with the form's first submit button. This off-screen copy of Connect comes first, so
// Enter connects (not cancels) while the visible buttons keep their on-screen order for Tab.
var CX_ENTER = '<button name="decision" value="approve" class="enter" tabindex="-1" aria-hidden="true">Connect</button>';
function cxBar(lead) {
  return `<div class="bar">${lead}<button name="decision" value="deny">Cancel</button><button name="decision" value="approve" class="primary">Connect</button></div>`;
}
function cxStart(handle, choices = [], siteKey = null) {
  const head = `<form method="post" action="/authorize"><input type="hidden" name="handle" value="${esc(handle)}"><input type="hidden" name="step" value="signin"><input type="hidden" name="decision" value="approve">`;
  if (!choices.length) return `<form method="post" action="/authorize"><input type="hidden" name="handle" value="${esc(handle)}"><input type="hidden" name="step" value="signin">
<div class="bar"><button name="decision" value="deny">Cancel</button><button name="decision" value="approve" class="primary">Continue${cxIcon("next")}</button></div></form>`;
  // Several ways to sign in (hosted): provider buttons (secondary), then "or" and the email link (primary), plus Cancel.
  // Same hierarchy as the app's sign-in card.
  const opts = choices.map((c, i) => c.email
    ? `${i ? '<div class="or" aria-hidden="true">or</div>' : ""}${head}<input type="hidden" name="choice" value="${esc(c.id)}"><label class="fine" for="cx-email">Email</label>${siteKey ? `<div class="cf-turnstile" data-sitekey="${esc(siteKey)}" data-size="flexible" style="margin:4px 0 8px"></div>` : ""}<input id="cx-email" name="email" type="email" required autocomplete="email" placeholder="you@example.com" pattern="[^\\s@]+@[^\\s@]+\\.[^\\s@]{2,}" title="Enter an address like you@example.com" style="width:100%;min-height:44px;margin:4px 0 8px"><button class="primary" style="width:100%">${esc(c.label)}</button></form>`
    : `${head}<input type="hidden" name="choice" value="${esc(c.id)}"><button style="width:100%;margin-bottom:8px">${esc(c.label)}</button></form>`).join("\n");
  return `${opts}
<form method="post" action="/authorize"><input type="hidden" name="handle" value="${esc(handle)}"><input type="hidden" name="step" value="signin"><div class="bar"><button name="decision" value="deny">Cancel</button></div></form>`;
}
/** Turnstile site key for the consent page's email-link form (only when an email choice is offered). */
function cxTurnstile(env) {
  return cxChoices(env).some((c) => c.email) ? turnstileSiteKey(env) : null;
}
const cxTurnstileScript = (env) => cxTurnstile(env) ? `<script src="${TURNSTILE_ORIGIN}/turnstile/v0/api.js" async defer></script>` : "";
/** Sign-in options of the consent sign-in ([] = one Continue button). */
function cxChoices(env) {
  return (upstreamFor(env).choices?.() ?? []).filter((x) => typeof x?.id === "string" && /^[a-z0-9_-]{1,32}$/.test(x.id) && typeof x.label === "string").map((x) => ({ id: x.id, label: x.label.slice(0, 60), email: !!x.email }));
}
function clientFacts(d) {
  const chips = [
    d.clientDomain ? cxChip("ok", "check", `Verified \u00B7 ${esc(d.clientDomain)}`) : cxChip("warn", "alert", "Name not verified"),
    cxChip("", "back", `Returns to ${esc(d.redirectHost)}`)
  ];
  return `<div class="chips">${chips.join("")}</div>${d.redirectIsLoopback ? `<div class="callout warn">${cxIcon("alert")}<div><strong>This sends access to an app on this computer.</strong> Continue only if you just started connecting from it.</div></div>` : ""}`;
}
// The owner's most recent live connection for this exact client_id. Never matched by name: client names are
// self-asserted, so a look-alike registration must not inherit another app's access or be offered its replacement.
async function cxPreviousConnection(env, principalId, request) {
  const row = await env.DB.prepare(
    `SELECT id FROM oauth_connections WHERE owner_principal_id = ? AND client_id = ? AND revoked_at IS NULL AND expires_at > ?
     ORDER BY created_at DESC LIMIT 1`
  ).bind(principalId, request.clientId, nowMs()).first();
  return row ? await liveConnection(env, row.id) : null;
}
function cxSeg(name, label, value, withNone, readOnly = false) {
  const opts = (withNone ? [["none", "Off"]] : []).concat(readOnly ? [["read", "Read"]] : [["read", "Read"], ["write", "Edit"]]);
  return `<span class="seg" role="radiogroup" aria-label="${esc(label)}">${opts.map(([v, t]) => `<label><input type="radio" name="${esc(name)}" value="${v}"${v === value ? " checked" : ""}><span>${t}</span></label>`).join("")}</span>`;
}
// values: the submitted form when re-rendering after a fixable mistake (choices kept), else null.
function cxGrantPage(d, email, projects, prev, consent, values = null, error = "", status = 200) {
  // An earlier Edit grant on a project that is now view-only pre-selects Read (there is no Edit option to select).
  const viewOnly = new Set(projects.filter((p) => p.can_write === false).map((p) => p.id));
  const was = new Map((prev?.projects ?? []).map((p) => [p.id, p.can_write && !viewOnly.has(p.id) ? "write" : "read"]));
  const pick = (name, fallback) => values ? String(values.get(name) ?? fallback) : fallback;
  const dupe = cxDupes(projects);
  const row = (p) => `<li class="proj"><span class="pname">${esc(p.title)}${dupe(p) ? ` <small>${esc(p.id)}</small>` : ""}${p.can_write === false ? ` <span class="ro-badge">View only</span>` : ""}</span>${cxSeg(`access:${p.id}`, `Access to ${p.title}`, pick(`access:${p.id}`, values ? "none" : was.get(p.id) ?? "none"), true, p.can_write === false)}</li>`;
  // Projects grouped by workspace (one connection covers one workspace; the server enforces it). A single
  // workspace renders exactly as before.
  const groups = [];
  for (const p of projects) { const g = groups.find((x) => x.id === (p.workspace_id ?? "")); if (g) g.items.push(p); else groups.push({ id: p.workspace_id ?? "", name: p.workspace_name, items: [p] }); }
  // One group per workspace, each with its own heading, whenever any shared workspace is involved.
  const named = groups.length > 1 || groups.some((g) => g.name);
  const rows = projects.length ? (named
    ? groups.map((g, i) => `<div class="wsg" role="group" aria-labelledby="wsh-${i}"><h3 class="wsh" id="wsh-${i}">${esc(g.name ?? "Personal")}</h3><ul class="list">${g.items.map(row).join("")}</ul></div>`).join("")
    : `<ul class="list">${projects.map(row).join("")}</ul>`) : "";
  // New projects: by default they go in the workspace of the picked projects (else Personal); any other active
  // workspace where the signer is an admin can be chosen, including ones without projects yet.
  const admin = projects.adminWorkspaces ?? [];
  const wsPick = admin.length > 1 ? `<label class="field"><span>New projects go in</span><select name="new_workspace"><option value="">Same as picked projects (else Personal)</option>${admin.map((w) => `<option value="${esc(w.id)}"${pick("new_workspace", "") === w.id ? " selected" : ""}>${esc(w.name ?? "Personal")}</option>`).join("")}</select></label>` : "";
  // Rows reveal one at a time: every filled row stays visible, plus exactly one empty row (CSS).
  const fresh = Array.from({ length: NEW_PROJECT_SLOTS }, (_, k) => {
    const sfx = k === 0 ? "" : `_${k + 1}`;
    return `<div class="newp"><input type="text" name="new_title${sfx}" maxlength="200" pattern=".*\\S.*" value="${esc(pick(`new_title${sfx}`, ""))}" placeholder="${rows ? "New project (optional)" : "Project name"}" aria-label="New project ${k + 1} name">${cxSeg(`new_access${sfx}`, `Access to new project ${k + 1}`, pick(`new_access${sfx}`, "read"), false)}</div>`;
  }).join("");
  const welcome = prev && !values ? `<div class="callout info">${cxIcon("redo")}<div><strong>Welcome back.</strong> Access from your earlier connection (${esc(cxDate(prev.created_at))}) is already picked. Adjust anything below.</div></div>` : "";
  const replaceOn = values ? values.get("replace") === prev?.id : true;
  const replace = prev ? `<label class="check"><input type="checkbox" name="replace" value="${esc(prev.id)}"${replaceOn ? " checked" : ""}><span><strong>Replace the earlier connection</strong><small>Its old sign-in stops working as soon as you click Connect, so you don't end up with duplicates.</small></span></label>` : "";
  return page("Choose what to share", cxShell(`${cxPair(d.clientName)}
<h1>Choose what ${esc(d.clientName)} can use</h1><p class="lede">Signed in as ${esc(email)}</p>
${clientFacts(d)}${welcome}${cxErr(error)}
<form method="post" action="/authorize" class="grant"><input type="hidden" name="handle" value="${esc(consent.handle)}"><input type="hidden" name="step" value="grant">${CX_ENTER}
<section class="sec"><h2>Projects</h2>${groups.length > 1 ? `<p class="fine one-ws">Pick projects from one workspace. To share another workspace, connect again.</p>` : ""}${rows}
<h3 class="sub">${cxIcon("plus")}${rows ? "Or create a project" : "Create a project to share"}</h3>${wsPick}${fresh}</section>
${replace}
<p class="fine"><strong>Read</strong>: view documents and files (images, PDFs, videos) and their history, and download files. <strong>Edit</strong>: also create and change documents, and upload new files and new versions of files. Comments, trash and settings are never shared.</p>
${cxBar('<span class="count"><span class="some"><b class="n"></b> selected</span><span class="none">Pick at least one project</span></span>')}</form>`), consent.headers, status);
}
async function appClientFor(env, clientId) {
  if (!acOn(env)) return null;
  return env.DB.prepare("SELECT * FROM app_clients WHERE client_id = ?").bind(clientId).first();
}
async function checkPublisherRequest(env, parsed, origin) {
  const app = await appClientFor(env, parsed.clientId);
  const wantsV1 = parsed.resource === `${origin}/v1`;
  if (!app) return wantsV1 ? { error: "This app is not registered for publishing. The owner must register it in Agent Library first." } : null;
  if (app.disabled_at !== null) return { error: "This app has been disabled by the owner." };
  if (!wantsV1) return { error: "This app can only connect as a publisher (resource " + origin + "/v1)." };
  if (!JSON.parse(app.redirect_uris).includes(parsed.redirectUri)) return { error: "This app's callback address is not registered." };
  const scopes = new Set(parsed.scope);
  if (!scopes.has(SCOPES.publish) || [...scopes].some((x) => x !== SCOPES.publish && x !== SCOPES.offline)) return { error: "Publishers may request only agentlib:publish and offline_access." };
  return { app };
}
async function authorizeGet(req, env, as, origin) {
  const oauth = as.getOAuthApi(env);
  const parsed = await oauth.parseAuthRequest(req);
  if (!parsed.codeChallenge || parsed.codeChallengeMethod !== "S256")
    throw new AuthorizationError("invalid_request", { description: "PKCE S256 is required", redirectUri: parsed.redirectUri, state: parsed.state, issuer: parsed.issuer });
  const pubCheck = await checkPublisherRequest(env, parsed, origin);
  if (pubCheck?.error) return errorPage(pubCheck.error);
  if (pubCheck?.app) {
    if (!parsed.state) return errorPage("state is required.");
    // Optional destination hint from the app (agentlib_project / agentlib_folder). It only pre-fills the owner's
    // choices; keyed by the request's unique PKCE challenge so it survives the owner sign-in round trip.
    const hint = cxPublishHint(new URL(req.url).searchParams);
    if (hint) await env.OAUTH_KV.put(`pubhint:${await sha(parsed.clientId + " " + parsed.codeChallenge)}`, JSON.stringify(hint), { expirationTtl: 900 });
    const consent2 = await oauth.beginConsent(parsed);
    const targets2 = upstreamFor(env).origins();
    const app = pubCheck.app;
    return page("Connect an app to Agent Library", cxShell(`${cxPair(app.display_name)}
<h1>Connect ${esc(app.display_name)}</h1><p class="lede">It wants to publish its own files to your library. Sign in to choose where they go. Nothing is shared yet.</p>
<div class="chips">${cxChip("ok", "check", "Registered by you")}${cxChip("", "back", `Returns to ${esc(new URL(parsed.redirectUri).host)}`)}</div>
${cxStart(consent2.handle, cxChoices(env), cxTurnstile(env))}${cxTurnstileScript(env)}`), consent2.headers, 200, targets2, { turnstile: !!cxTurnstile(env) });
  }
  if (!allowedRedirect(parsed.redirectUri)) return errorPage("This app's callback address is not allowed to connect.");
  const details = await oauth.describeConsent(parsed);
  const consent = await oauth.beginConsent(parsed);
  const targets = upstreamFor(env).origins();
  return page("Connect an app to Agent Library", cxShell(`${cxPair(details.clientName)}
<h1>Connect ${esc(details.clientName)}</h1><p class="lede">It wants to use documents in your library. Sign in to pick which projects. Nothing is shared yet.</p>
${clientFacts(details)}
${cxStart(consent.handle, cxChoices(env), cxTurnstile(env))}${cxTurnstileScript(env)}`), consent.headers, 200, targets, { turnstile: !!cxTurnstile(env) });
}
async function authorizePost(req, env, as, origin) {
  const oauth = as.getOAuthApi(env);
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > 16 * 1024) return errorPage("Request too large.", 413);
  const form = await req.formData();
  const handle = String(form.get("handle") ?? "");
  const step = String(form.get("step") ?? "");
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(req, handle);
    const loc = denied.headers.get("location");
    denied.headers.delete("location");
    return toClient(loc, denied.headers, new URL(loc).host);
  }
  if (step === "signin") {
    // Validate the sign-in choice before the consent handle is used, so a typo can be fixed with Back.
    const choices = cxChoices(env);
    const picked = choices.find((c) => c.id === String(form.get("choice") ?? "")) ?? (choices.length ? null : undefined);
    if (picked === null) return errorPage("Pick one of the sign-in options.");
    let email = null;
    if (picked?.email) {
      email = String(form.get("email") ?? "").trim().toLowerCase();
      if (!EMAIL_RE.test(email) || email.length > 254) return errorPage("That doesn't look like an email address. Go back and check it.");
    }
    try {
      if (email) await requireHuman(env, String(form.get("cf-turnstile-response") ?? ""), req.headers.get("cf-connecting-ip"), new URL(req.url).hostname);
      await limitSigninStart(env, req, email);
    }
    catch (e) { const f = startFailure(e); return errorPage(`${f.title}. ${f.msg}`, f.status); }
    const approved = await oauth.approveConsent(req, handle, { scope: [SCOPES.read] });
    const secrets = { verifier: randomToken(64), nonce: randomToken(32) };
    const { state, headers } = await oauth.beginUpstream(approved.request, { data: secrets, headers: approved.headers });
    let target;
    try { target = await upstreamFor(env).start({ redirectUri: `${origin}/callback`, state, nonce: secrets.nonce, verifier: secrets.verifier, choice: picked?.id ?? null, email, mayCreateAccount: (e) => mayCreateAccount(env, e) }); }
    catch (e) { const f = startFailure(e); return errorPage(`${f.title}. ${f.msg}`, f.status); }
    headers.set("location", target.startsWith("/") && !target.startsWith("//") ? origin + target : target);
    return new Response(null, { status: 302, headers });
  }
  if (step === "publish") return publishConsentPost(req, env, oauth, form, handle, origin);
  if (step === "grant") {
    const sess = await env.OAUTH_KV.get(`consentctx:${await sha(handle)}`, "json");
    if (!sess) return errorPage("This consent page expired. Start connecting again from the app.");
    if (sess.app_client_id) return errorPage("This app connects as a publisher. Start connecting again from the app.");
    const owned = { results: await consentProjects(env, sess.principal_id) };
    // A fixable mistake re-renders the page with the owner's choices kept: the consent handle is still unused, and
    // the browser's Back button can't help (the sign-in callback that rendered the page is single-use).
    const retry = (msg) => sess.view ? cxGrantPage(sess.view.d, sess.view.email, owned.results, sess.view.prev, { handle, headers: new Headers() }, form, msg, 400) : errorPage(msg);
    const chosen = [];
    for (const p of owned.results) {
      const a = String(form.get(`access:${p.id}`) ?? "none");
      if (a === "read" || a === "write") chosen.push({ id: p.id, write: a === "write", workspace_id: p.workspace_id });
      else if (a !== "none") return retry("Unexpected access choice. Pick Off, Read or Edit for each project.");
      if (a === "write" && !p.can_write) return retry(`Your role in \u201C${p.title.slice(0, 60)}\u201D is read-only. Choose Read or Off.`);
    }
    // One connection covers one workspace. New projects go into that workspace (personal if none was picked).
    const wsIds = [...new Set(chosen.map((c) => c.workspace_id))];
    if (wsIds.length > 1) return retry("Pick projects from one workspace. Connect again for another workspace.");
    const pickedWs = String(form.get("new_workspace") ?? "");
    if (wsIds.length && pickedWs && pickedWs !== wsIds[0] && [...Array(NEW_PROJECT_SLOTS).keys()].some((i) => String(form.get(`new_title${i ? `_${i + 1}` : ""}`) ?? "").trim()))
      return retry("New projects must go in the same workspace as the projects you picked.");
    const connWs = wsIds[0] ?? (pickedWs || personalWorkspaceId(sess.principal_id));
    const seenTitles = /* @__PURE__ */ new Set();
    for (let i = 1; i <= NEW_PROJECT_SLOTS; i++) {
      const sfx = i === 1 ? "" : `_${i}`;
      const newTitle = String(form.get(`new_title${sfx}`) ?? "").trim();
      const newAccess = String(form.get(`new_access${sfx}`) ?? "");
      if (!newTitle) continue;
      if (newTitle.length > 200) return retry("A new project name is too long (200 characters max).");
      if (newAccess !== "read" && newAccess !== "write") return retry(`Choose Read or Edit for new project \u201C${newTitle.slice(0, 60)}\u201D.`);
      if (seenTitles.has(newTitle.toLowerCase())) return retry(`\u201C${newTitle.slice(0, 60)}\u201D is listed twice. Remove the duplicate.`);
      seenTitles.add(newTitle.toLowerCase());
      chosen.push({ id: randomId("prj"), write: newAccess === "write", isNew: newTitle, workspace_id: connWs });
    }
    if (!chosen.length) return retry("Pick at least one project, or create one.");
    if (chosen.some((c) => c.isNew)) {
      // Admin of an ACTIVE workspace (checked again inside the INSERT below).
      const ok = await env.DB.prepare(`SELECT ${workspaceRoleSql("?", "admin")} AS ok`).bind(sess.principal_id, connWs).first("ok");
      if (!ok) return retry("Only workspace admins can create projects here. Pick existing projects.");
    }
    const wsOwner = await env.DB.prepare("SELECT created_by FROM workspaces WHERE id = ?").bind(connWs).first("created_by");
    if (chosen.length > MAX_CONN_PROJECTS) return retry(`Pick at most ${MAX_CONN_PROJECTS} projects.`);
    const anyWrite = chosen.some((c) => c.write);
    const scope = anyWrite ? [SCOPES.read, SCOPES.write, SCOPES.offline] : [SCOPES.read, SCOPES.offline];
    // Replacing is offered only for the connection the consent page showed (stored server-side with the handle).
    // The predecessor must still be live: if another tab already replaced it, connecting here would leave two.
    const replaceId = String(form.get("replace") ?? "");
    let replaced = null;
    if (replaceId) {
      if (replaceId !== sess.replace_candidate) return retry("That earlier connection can't be replaced.");
      replaced = await env.DB.prepare("SELECT id, project_id, COALESCE(workspace_id, 'wsp_' || owner_principal_id) AS ws FROM oauth_connections WHERE id = ? AND owner_principal_id = ? AND revoked_at IS NULL").bind(replaceId, sess.principal_id).first();
      // Audit the revoke in every project it covered, like revoking from settings shows per project.
      if (replaced) replaced.projects = (await env.DB.prepare("SELECT project_id FROM oauth_connection_projects WHERE connection_id = ?").bind(replaced.id).all()).results.map((r) => r.project_id);
      if (!replaced) return errorPage("That earlier connection was already replaced, perhaps in another tab. Start connecting again from the app.");
    }
    // Workspace limits (Phase 4), checked before the consent is used up so the person can go back and fix it. The
    // same conditions are repeated inside the inserts below, so a concurrent request can't slip past.
    const newProjects = chosen.filter((c) => c.isNew).length;
    // Replacing a connection in the same workspace frees its slot in the same batch; one in another workspace doesn't.
    const swap = !!replaced && replaced.ws === connWs;
    const agentGuard = swap ? { sql: "1", params: [], limits: {} } : await limitGuard(env, connWs, { agents: 1 });
    const projGuard = newProjects ? await limitGuard(env, connWs, { projects: 1 }) : null;
    const preGuard = await limitGuard(env, connWs, swap ? { projects: newProjects } : { agents: 1, projects: newProjects });
    if (preGuard.sql !== "1" && !await env.DB.prepare(`SELECT ${preGuard.sql} AS ok`).bind(...preGuard.params).first("ok"))
      return retry(newProjects && preGuard.limits.projects !== undefined ? "This workspace can't take more projects or connected apps on its plan. Pick existing projects, or disconnect an app you no longer use (Connections), then try again." : "This workspace has reached its limit of connected apps and API keys. Disconnect one you no longer use (Connections), then try again.");
    const approved = await oauth.approveConsent(req, handle, { scope });
    await env.OAUTH_KV.delete(`consentctx:${await sha(handle)}`);
    const ar = approved.request;
    const client = await oauth.lookupClient(ar.clientId);
    const connectionId = randomId("oac", 18);
    const at = nowIso(), rid = randomId("req", 9);
    const audit2 = /* @__PURE__ */ __name((projectId, action, object, result) => env.DB.prepare("INSERT INTO audits (at, actor_id, project_id, action, object_id, result, request_id, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(at, sess.principal_id, projectId, action, object, result, rid, connWs), "audit");
    // Replacing claims the predecessor first, in the same transaction as the new rows. Revoking before the app
    // redeems its code is deliberate (fails closed): if the app never finishes, the new connection still exists, so
    // connecting again from the same app prefills it and offers to replace it.
    const claim = replaced ? env.DB.prepare("UPDATE oauth_connections SET revoked_at = ? WHERE id = ? AND owner_principal_id = ? AND revoked_at IS NULL").bind(nowMs(), replaced.id, sess.principal_id) : null;
    // Audited only if this request's claim won. The batch runs in order in one transaction, so changes() is 1 right
    // after a winning claim and stays 1 through each audit insert; a losing tab's claim changes 0 rows, so it
    // writes no "replaced" rows (no audits scan needed).
    const auditReplaced = (pid) => env.DB.prepare(`INSERT INTO audits (at, actor_id, project_id, action, object_id, result, request_id, workspace_id)
      SELECT ?, ?, ?, 'oauth.revoke', ?, 'ok:replaced', ?, (SELECT COALESCE(workspace_id, 'wsp_' || owner_id) FROM projects WHERE id = ?) WHERE changes() = 1`).bind(at, sess.principal_id, pid, replaced.id, rid, pid);
    let res;
    try { res = await env.DB.batch([
      ...claim ? [claim, ...(replaced.projects.length ? replaced.projects : [replaced.project_id]).map(auditReplaced)] : [],
      ...chosen.filter((c) => c.isNew).flatMap((c) => [
        // Gated in-statement: if the signer lost admin or the workspace closed since the check, no row is written and
        // the connection rows below fail their project foreign key, so the whole batch rolls back.
        env.DB.prepare(`INSERT INTO projects (id, owner_id, title, created_at, workspace_id) SELECT ?, ?, ?, ?, ? WHERE ${workspaceRoleSql("?", "admin")} AND ${projGuard.sql}`).bind(c.id, wsOwner ?? sess.principal_id, c.isNew, at, connWs, sess.principal_id, connWs, ...projGuard.params),
        audit2(c.id, "project.create", c.id, "ok:oauth-consent")
      ]),
      // file_access = 1 only when the page the owner saw offered files (offered: "files", set when it was shown). A page
      // opened before files were offered keeps documents only (migration 0013; build-file-tools-fixes.mjs).
      // A connection row refused by the limit makes oauth_connection_projects' foreign key fail below, which rolls the
      // whole batch back (reported like the admin race).
      env.DB.prepare(`INSERT INTO oauth_connections (id, owner_principal_id, project_id, client_id, client_name, redirect_uri, resource, can_read, can_write, file_access, created_at, expires_at, workspace_id, created_by)
        SELECT ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ? WHERE ${agentGuard.sql}`).bind(connectionId, sess.principal_id, chosen[0].id, ar.clientId, (client?.clientName ?? ar.clientId).slice(0, 200), ar.redirectUri, `${origin}/mcp`, anyWrite ? 1 : 0, sess.offered === "files" ? 1 : 0, at, CONNECTION_EXPIRES_AT, connWs, sess.principal_id, ...agentGuard.params),
      ...chosen.flatMap((c) => [
        env.DB.prepare("INSERT INTO oauth_connection_projects (connection_id, project_id, can_write) VALUES (?, ?, ?)").bind(connectionId, c.id, c.write ? 1 : 0),
        audit2(c.id, "oauth.connect", connectionId, c.write ? "ok:read+write" : "ok:read")
      ])
    ]); } catch (e) {
      // The in-statement admin check lost a race (demoted, or the workspace closed): nothing was written.
      if (/FOREIGN KEY/i.test(String(e?.message ?? e))) return errorPage("Your access to that workspace, or its plan limits, changed. Start connecting again from the app.", 403);
      throw e;
    }
    // Lost a race with another tab replacing the same connection: withdraw this one before any code is issued, so
    // exactly one live successor remains. (New projects made here stay; they are the owner's and empty.)
    if (claim && !res[0].meta.changes) {
      await env.DB.batch([
        env.DB.prepare("UPDATE oauth_connections SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(nowMs(), connectionId),
        audit2(chosen[0].id, "oauth.revoke", connectionId, "ok:lost-replace-race")
      ]);
      return errorPage("That earlier connection was just replaced in another tab. Use that connection, or start again from the app.");
    }
    if (replaced) {
      try {
        const old = await oauth.listUserGrants(replaced.id);
        for (const g of old.items) await oauth.revokeGrant(g.id, replaced.id);
      } catch {
        console.log("oauth_replace_grant_pending");
      }
    }
    const { redirectTo } = await oauth.completeAuthorization({
      request: ar,
      userId: connectionId,
      // one grant per connection: re-authorizing never broadens/revokes another connection
      metadata: { projects: chosen.length },
      scope: ar.scope,
      props: { connection_id: connectionId },
      revokeExistingGrants: false
    });
    return toClient(redirectTo, approved.headers, new URL(redirectTo).host);
  }
  return errorPage("Unexpected form.");
}
async function singleUseGate(req, env) {
  const raw = await req.text(), p = new URLSearchParams(raw), gt = p.get("grant_type");
  const secret = gt === "authorization_code" ? p.get("code") : gt === "refresh_token" ? p.get("refresh_token") : null;
  const retry = () => new Response(JSON.stringify({ error: "temporarily_unavailable", error_description: "Token renewal is in progress. Retry shortly." }), {
    status: 503, headers: { "content-type": "application/json", "cache-control": "no-store", "retry-after": "300" }
  });
  if (secret) {
    const h = await sha(`${gt}:${secret}`), at = nowMs();
    try {
      if (gt === "refresh_token") {
        // Only the CURRENT provider token may enter the gate. The provider also accepts its predecessor;
        // refusing it here prevents replay even after the 31-day redemption-history cleanup.
        const parts = secret.split(":");
        const grant = parts.length === 3 && secret.length <= 512 ? await env.OAUTH_KV.get(`grant:${parts[0]}:${parts[1]}`, { type: "json" }) : null;
        if (!grant || grant.refreshTokenId !== await sha(secret)) return oauthJson(400, { error: "invalid_grant", error_description: "Refresh token is no longer current" });
      }
      const inserted = await env.DB.prepare("INSERT INTO oauth_code_redemptions (code_hash, redeemed_at) VALUES (?, ?) ON CONFLICT (code_hash) DO NOTHING").bind(h, at).run();
      if (!(inserted.meta.changes ?? 0)) {
        if (gt !== "refresh_token") return oauthJson(400, { error: "invalid_grant", error_description: "Authorization code already used" });
        // A callback may have failed AFTER claiming this token. Do not burn a still-current token forever.
        // Wait five minutes (beyond KV's normal propagation/cache interval), then atomically reclaim only the
        // old attempt. Concurrent retries cannot both win. Used tokens fail the current-token check above.
        const reclaimed = await env.DB.prepare("UPDATE oauth_code_redemptions SET redeemed_at = ? WHERE code_hash = ? AND redeemed_at <= ? RETURNING code_hash").bind(at, h, at - 300000).first();
        if (!reclaimed) return { request: new Request(req, { body: raw }), refreshBusy: true };
      }
    } catch { return retry(); }
  }
  return new Request(req, { body: raw });
}
async function readCapped(req, max) {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const parts = [];
  let n = 0;
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => {
      });
      return null;
    }
    parts.push(value);
  }
  const out2 = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out2.set(p, o);
    o += p.byteLength;
  }
  return out2;
}
async function sha(v) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)));
  return [...d].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function callback(req, env, as, origin) {
  const oauth = as.getOAuthApi(env);
  const resumed = await oauth.finishUpstream(req);
  const url = new URL(req.url);
  if (url.searchParams.get("error") || !url.searchParams.get("code")) {
    resumed.headers.set("location", authorizationErrorRedirect(resumed.request, "access_denied"));
    return new Response(null, { status: 302, headers: resumed.headers });
  }
  let ident;
  try {
    ident = await upstreamFor(env).finish({ url, redirectUri: `${origin}/callback`, verifier: resumed.data.verifier, nonce: resumed.data.nonce });
  } catch (e) {
    console.log("upstream_signin_failed", e?.code ?? "error");
    resumed.headers.set("location", authorizationErrorRedirect(resumed.request, "access_denied", "Sign-in failed"));
    return new Response(null, { status: 302, headers: resumed.headers });
  }
  // The same account rules as browser sign-in (identity/accounts.js): an existing link, the single-user fallback, or
  // (hosted) a new account. Messages are fixable by the person; no account details are revealed.
  let principalId;
  try { principalId = (await principalForIdentity(env, ident)).principalId; }
  catch (e) {
    if (e instanceof HttpError && e.status === 403) return errorPage(e.message, 403);
    throw e;
  }
  const projects = { results: await consentProjects(env, principalId) };
  const pubApp = await appClientFor(env, resumed.request.clientId);
  if (pubApp && resumed.request.resource === `${origin}/v1`) {
    if (pubApp.owner_principal_id !== principalId) return errorPage("This app is registered to a different owner.", 403);
    return publishConsentPage(env, oauth, resumed, pubApp, principalId, ident.email, projects.results.filter((p) => p.can_write));
  }
  const details = await oauth.describeConsent(resumed.request);
  const consent = await oauth.beginConsent(resumed.request);
  const prev = await cxPreviousConnection(env, principalId, resumed.request);
  // view: what the page needs to re-render itself after a fixable mistake (owner-only data, same 10-minute TTL).
  const view = { email: ident.email, d: { clientName: details.clientName, clientDomain: details.clientDomain, redirectHost: details.redirectHost, redirectIsLoopback: details.redirectIsLoopback },
    prev: prev ? { id: prev.id, created_at: prev.created_at, projects: prev.projects.map((p) => ({ id: p.id, can_write: p.can_write })) } : null };
  await env.OAUTH_KV.put(`consentctx:${await sha(consent.handle)}`, JSON.stringify({ principal_id: principalId, view, offered: "files", ...prev ? { replace_candidate: prev.id } : {} }), { expirationTtl: 600 });
  for (const [k, v] of resumed.headers) if (k.toLowerCase() === "set-cookie") consent.headers.append("set-cookie", v);
  return cxGrantPage(details, ident.email, projects.results, prev, consent);
}
async function readerAudience(env, ownerId, projectId) {
  const conns = await env.DB.prepare(
    `SELECT oc.client_name AS name, cp.can_write FROM oauth_connections oc JOIN oauth_connection_projects cp ON cp.connection_id = oc.id
     WHERE cp.project_id = ? AND ? IS NOT NULL AND oc.revoked_at IS NULL AND oc.expires_at > ? ORDER BY oc.created_at`
  ).bind(projectId, ownerId, nowMs()).all();
  const keys = await env.DB.prepare(
    `SELECT ac.label AS name, acp.can_write FROM api_credentials ac JOIN api_credential_projects acp ON acp.credential_id = ac.id
     WHERE acp.project_id = ? AND ? IS NOT NULL AND ac.revoked_at IS NULL AND ac.expires_at > ? ORDER BY ac.created_at`
  ).bind(projectId, ownerId, nowMs()).all();
  return [...conns.results.map((c) => ({ kind: "Connected app", ...c })), ...keys.results.map((k) => ({ kind: "API key", ...k }))];
}
async function publishConsentPage(env, oauth, resumed, app, principalId, email, projects) {
  const consent = await oauth.beginConsent(resumed.request);
  // Suggested destination: the app's own hint for this request wins over the owner-set registration default.
  const hintKey = `pubhint:${await sha(resumed.request.clientId + " " + resumed.request.codeChallenge)}`;
  const reqHint = resumed.request.codeChallenge ? await env.OAUTH_KV.get(hintKey, "json") : null;
  if (reqHint) await env.OAUTH_KV.delete(hintKey);
  const suggest = { project: reqHint?.project ?? app.suggested_project ?? null, folder: reqHint?.folder ?? app.suggested_folder ?? null };
  await env.OAUTH_KV.put(`consentctx:${await sha(consent.handle)}`, JSON.stringify({ principal_id: principalId, app_client_id: app.id, email, suggest }), { expirationTtl: 600 });
  for (const [k, v] of resumed.headers) if (k.toLowerCase() === "set-cookie") consent.headers.append("set-cookie", v);
  return cxPublishPage(env, app, principalId, email, projects, consent, null, "", 200, suggest);
}
// App-supplied destination hint: bounded, plain strings only; anything invalid is ignored (never an error).
function cxPublishHint(params) {
  const clean = (v, max) => {
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t && t.length <= max && !/[\/\u0000-\u001f\u007f]/.test(t) ? t : null;
  };
  const project = clean(params.get("agentlib_project"), 80), folder = clean(params.get("agentlib_folder"), 80);
  return project || folder ? { project, folder } : null;
}
// A suggested project matches by id, else by title (case-insensitive); otherwise the first project.
function cxSuggestedProject(projects, hint) {
  if (!hint) return null;
  const k = hint.trim().toLowerCase();
  return projects.find((p) => p.id === hint) ?? projects.find((p) => p.title.trim().toLowerCase() === k) ?? null;
}
// values/error: the submitted form and the mistake to show when re-rendering (choices kept).
async function cxPublishPage(env, app, principalId, email, projects, consent, values = null, error = "", status = 200, suggest = null) {
  const pick = (n, fallback) => values ? String(values.get(n) ?? fallback) : fallback;
  const name = app.display_name;
  if (!projects.length) return page("Choose where this app publishes", cxShell(`${cxPair(name)}<div class="state neutral"><h1>Create a project first</h1>
<p class="lede">${esc(name)} publishes into one of your projects, and you don't have any yet. Create one in Agent Library, then connect again from the app.</p></div>`), consent.headers, status);
  const chosenProject = pick("project_id", (cxSuggestedProject(projects, suggest?.project) ?? projects[0]).id);
  const dupe = cxDupes(projects);
  const projOpts = projects.map((p) => `<option value="${esc(p.id)}"${p.id === chosenProject ? " selected" : ""}>${esc(p.title)}${dupe(p) ? ` (${esc(p.id)})` : ""}</option>`).join("");
  const folders = await env.DB.prepare(`SELECT f.id, f.name, f.project_id FROM folders f JOIN projects p ON p.id = f.project_id WHERE ${memberRoleSql("p.id", "member")} ORDER BY f.name_key LIMIT 500`).bind(principalId).all();
  const byProject = /* @__PURE__ */ new Map();
  for (const f of folders.results) byProject.set(f.project_id, [...byProject.get(f.project_id) ?? [], f]);
  // One folder field for all projects (a hidden control still submits, and /authorize caps bodies at 16 KiB), with
  // one labelled group per project; CSS shows only the chosen project's group. The server re-checks the pairing.
  // A suggested folder that already exists in the suggested project is pre-selected instead of "New folder".
  const suggestedFolder = suggest?.folder ? (byProject.get(chosenProject) ?? []).find((f) => f.name.trim().toLowerCase() === suggest.folder.toLowerCase()) : null;
  const cur = pick("destination", suggestedFolder ? `folder:${suggestedFolder.id}` : "new");
  const opt = (v, t) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(t)}</option>`;
  const folderGroups = projects.map((p, i) => byProject.has(p.id) ? `<optgroup label="Folders in ${esc(p.title)}" data-i="${i}">${byProject.get(p.id).map((f) => opt(`folder:${f.id}`, f.name)).join("")}</optgroup>` : "").join("");
  const folderSelect = `<select name="destination" aria-label="Folder">${opt("new", "New folder")}${opt("root", "No folder (project root)")}${folderGroups}</select>`;
  const prev = await env.DB.prepare(
    `SELECT pb.id, pb.created_at, pb.resumed_at, pb.current_source_revision, pb.revoked_at, p.title AS project_title, f.name AS folder_name FROM publishers pb
     JOIN projects p ON p.id = pb.project_id AND p.deleted_at IS NULL LEFT JOIN folders f ON f.id = pb.folder_id WHERE pb.app_client_id = ? AND pb.owner_principal_id = ? ORDER BY pb.created_at DESC LIMIT 20`
  ).bind(app.id, principalId).all();
  // Most recently used first. Nothing is resumed unless the owner picks it: resuming signs out the app's older session.
  const active = prev.results.filter((r) => r.revoked_at === null).sort((a, b) => String(b.resumed_at ?? b.created_at).localeCompare(String(a.resumed_at ?? a.created_at)));
  const resume = pick("resume", "new");
  const cards = active.map((r) => `<label class="choice"><input type="radio" name="resume" value="${esc(r.id)}"${resume === r.id ? " checked" : ""}><span><strong>Keep publishing to ${esc(r.project_title)} / ${r.folder_name ? esc(r.folder_name) : "project root"}</strong>
<small>${r.current_source_revision == null ? "No exports yet" : `Last export: revision ${esc(r.current_source_revision)}`} \u00B7 connected ${esc(cxDate(r.created_at))}${active.length > 1 ? ` \u00B7 <code>${esc(r.id)}</code>` : ""}</small></span></label>`).join("");
  const audiences = await Promise.all(projects.map(async (p) => [p.id, await readerAudience(env, principalId, p.id)]));
  const audienceHtml = audiences.map(([pid, a], i) => `<p class="aud" data-i="${i}"><strong>${esc(projects.find((p) => p.id === pid).title)}</strong>: ${a.length ? a.map((x) => `${esc(x.kind)} \u201C${esc(x.name)}\u201D (${x.can_write ? "read & edit" : "read"})`).join(", ") : "no connected apps or API keys yet"}</p>`).join("");
  // Show only the chosen project's folder list and readers (CSS; pages have no scripts).
  const projectCss = projects.map((_, i) => `.fresh:has(select[name=project_id] option:nth-child(${i + 1}):checked) :is(.aud,optgroup)[data-i="${i}"]{display:block}`).join("");
  const defaultFolder = suggest?.folder || name.replace(/\s*\(.*\)\s*$/, "").trim() || name;
  return page("Choose where this app publishes", cxShell(`${cxPair(name)}
<h1>${active.length ? `Connect ${esc(name)} again` : `Where should ${esc(name)} publish?`}</h1>
<p class="lede">It can create files and update only the ones it made. Nothing else in your library is visible to it. Signed in as ${esc(email)}.</p>${cxErr(error)}
<form method="post" action="/authorize" class="${active.length ? "has-prev" : ""}"><input type="hidden" name="handle" value="${esc(consent.handle)}"><input type="hidden" name="step" value="publish">${CX_ENTER}
${active.length ? `<section class="sec"><h2>Destination</h2>${cards}<label class="choice"><input type="radio" name="resume" value="new"${resume === "new" ? " checked" : ""}><span><strong>Somewhere new</strong><small>Start a separate set of files.</small></span></label>
<p class="fine">Continuing an earlier destination keeps its files and signs out the app's older session.</p></section>` : '<input type="hidden" name="resume" value="new">'}
<section class="sec fresh">${active.length ? "<h2>New destination</h2>" : ""}<style>${projectCss}</style>
<label class="field"><span>Project</span><select name="project_id" aria-label="Project">${projOpts}</select></label>
<label class="field"><span>Folder</span>${folderSelect}</label>
<label class="field newname"><span>Folder name</span><input type="text" name="new_folder_name" maxlength="80" value="${esc(pick("new_folder_name", defaultFolder))}" aria-label="New folder name"></label>
<details class="more"><summary>${cxIcon("chev")}Who else can read this project</summary><div class="inner"><p class="fine">They will be able to read this app's files, <strong>including future exports</strong>, and <strong>cannot edit them</strong>. Nothing new is granted to them.</p>${audienceHtml}</div></details>
</section>
${cxBar("")}</form>`), consent.headers, status);
}
async function publishConsentPost(req, env, oauth, form, handle, origin) {
  const sess = await env.OAUTH_KV.get(`consentctx:${await sha(handle)}`, "json");
  if (!sess?.app_client_id) return errorPage("This consent page expired. Start connecting again from the app.");
  const app = await env.DB.prepare("SELECT * FROM app_clients WHERE id = ? AND owner_principal_id = ? AND disabled_at IS NULL").bind(sess.app_client_id, sess.principal_id).first();
  if (!app) return errorPage("This app is no longer registered or has been disabled.");
  // A fixable mistake re-renders the page with the owner's choices kept (the consent handle is still unused).
  const retry = async (msg) => {
    if (!sess.email) return errorPage(msg);
    const owned = { results: await consentProjects(env, sess.principal_id) };
    return cxPublishPage(env, app, sess.principal_id, sess.email, owned.results.filter((p) => p.can_write), { handle, headers: new Headers() }, form, msg, 400, sess.suggest ?? null);
  };
  const resume = String(form.get("resume") ?? "new");
  const at = nowIso(), rid = randomId("req", 9);
  const audit2 = /* @__PURE__ */ __name((projectId, action, object, result) => env.DB.prepare("INSERT INTO audits (at, actor_id, project_id, action, object_id, result, request_id) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(at, sess.principal_id, projectId, action, object, result, rid), "audit");
  let publisherId, epoch;
  const stmts = [];
  if (resume !== "new") {
    const prev = await env.DB.prepare("SELECT * FROM publishers WHERE id = ? AND app_client_id = ? AND owner_principal_id = ? AND revoked_at IS NULL").bind(resume, app.id, sess.principal_id).first();
    if (!prev) return retry("That earlier connection can't be resumed. Choose again.");
    publisherId = prev.id;
    epoch = prev.token_epoch + 1;
    stmts.push(
      env.DB.prepare("UPDATE publishers SET token_epoch = ?, resumed_at = ? WHERE id = ? AND token_epoch = ? AND revoked_at IS NULL").bind(epoch, at, publisherId, prev.token_epoch),
      audit2(prev.project_id, "publisher.resume", publisherId, "ok")
    );
  } else {
    const projectId = String(form.get("project_id") ?? "");
    const proj = await env.DB.prepare(`SELECT p.id, COALESCE(p.workspace_id, 'wsp_' || p.owner_id) AS workspace_id FROM projects p WHERE p.id = ? AND ${memberRoleSql("p.id", "member")}`).bind(projectId, sess.principal_id).first();
    if (!proj) return retry("Choose one of your projects.");
    const dest = String(form.get("destination") ?? "");
    let folderId = null;
    publisherId = randomId("pub", 15);
    epoch = 1;
    const principalId = randomId("agt");
    if (dest === "root") folderId = null;
    else if (dest.startsWith("folder:")) {
      const f = await env.DB.prepare("SELECT id FROM folders WHERE id = ? AND project_id = ?").bind(dest.slice(7), projectId).first("id");
      if (!f) return retry("That folder is in a different project. Pick one of this project's folders, or a new folder.");
      folderId = f;
    } else if (dest === "new") {
      let nm;
      try {
        nm = folderName(form.get("new_folder_name"));
      } catch (e) {
        return retry(`${e.message}. Fix the folder name.`);
      }
      const ex = await env.DB.prepare("SELECT id FROM folders WHERE project_id = ? AND name_key = ?").bind(projectId, nm.key).first("id");
      if (ex) return retry(`A folder named \u201C${nm.name}\u201D already exists in this project. Pick it from the folder list, or choose another name.`);
      folderId = randomId("fld");
      stmts.push(env.DB.prepare("INSERT INTO folders (id, project_id, name, name_key, created_at, created_by, publisher_id) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(folderId, projectId, nm.name, nm.key, at, sess.principal_id, publisherId), audit2(projectId, "folder.create", folderId, "ok:publisher-consent"));
    } else return retry("Choose a folder option.");
    // Connected-agents limit (Phase 4): checked now (the person can go back), and again in the principal insert; a
    // refused principal makes the publisher row's foreign key fail, rolling the batch back.
    const pg = await limitGuard(env, proj.workspace_id, { agents: 1 });
    if (pg.sql !== "1" && !await env.DB.prepare(`SELECT ${pg.sql} AS ok`).bind(...pg.params).first("ok"))
      return retry("This workspace has reached its limit of connected apps and API keys. Disconnect one you no longer use (Connections), then try again.");
    stmts.push(
      env.DB.prepare(`INSERT INTO principals (id, kind, issuer, subject, label, created_at) SELECT ?, 'agent', 'agent-library-publisher', ?, ?, ? WHERE ${pg.sql}`).bind(principalId, publisherId, `publisher:${app.display_name}`.slice(0, 200), at, ...pg.params),
      env.DB.prepare(`INSERT INTO publishers (id, owner_principal_id, principal_id, app_client_id, display_name, project_id, folder_id, created_at, workspace_id, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(publisherId, sess.principal_id, principalId, app.id, app.display_name, projectId, folderId, at, proj.workspace_id, sess.principal_id),
      audit2(projectId, "publisher.connect", publisherId, folderId ? "ok:folder" : "ok:root")
    );
  }
  const approved = await oauth.approveConsent(req, handle, { scope: [SCOPES.publish, SCOPES.offline] });
  await env.OAUTH_KV.delete(`consentctx:${await sha(handle)}`);
  let res;
  try {
    res = await env.DB.batch(stmts);
  } catch (e) {
    if (/FOREIGN KEY/i.test(String(e?.message))) return errorPage("Your access to that project, or its workspace's plan limits, changed. Start connecting again from the app.", 403);
    if (/UNIQUE/i.test(String(e?.message))) return errorPage("A folder with that name was just created in this project. Start connecting again from the app and choose it as an existing folder, or pick another name.");
    throw e;
  }
  if (resume !== "new" && !res[0].meta.changes) return errorPage("That connection changed while you were deciding. Start again from the app.");
  const ar = approved.request;
  const { redirectTo } = await oauth.completeAuthorization({
    request: ar,
    userId: `${publisherId}.e${epoch}`,
    metadata: { publisher: publisherId },
    scope: [SCOPES.publish, SCOPES.offline],
    props: { publisher_id: publisherId, epoch },
    revokeExistingGrants: false
  });
  return toClient(redirectTo, approved.headers, new URL(redirectTo).host);
}
async function handleOAuthHost(req, env, ctx, host) {
  configureExtraCallbacks(env);
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
    // "Check your email" after asking for a sign-in link from the consent page (same page as on the app host).
    if (url.pathname === "/auth/check-email" && req.method === "GET") return checkEmailPage();
    if (url.pathname === "/callback" && req.method === "GET") {
      await rateLimit(env, "oauthauthz:" + ip, lim(env, "authorize"));
      return await callback(req, env, as, origin);
    }
    if (AS_PATHS.has(url.pathname)) {
      if (url.pathname === "/oauth/token" && req.method === "OPTIONS" && acOn(env)) return await publisherPreflight(req, env);
      if (req.method === "POST") {
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
        const res = gated instanceof Response ? gated : await as.fetch(gated.request ?? gated, { ...env, __oauthRefreshClaimBusy: gated.refreshBusy === true }, ctx);
        return acOn(env) ? await withPublisherCors(req, env, res) : res;
      }
      return await as.fetch(req, env, ctx);
    }
    if (url.pathname === RS_META || url.pathname === "/mcp") return await rs.fetch(req, env, ctx);
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
    if (e?.status === 429) return new Response(JSON.stringify({ error: "temporarily_unavailable" }), { status: 429, headers: { "content-type": "application/json", "retry-after": "60" } });
    console.log("oauth_host_error", e?.code ?? e?.name ?? "error", env.APP_CONNECT_ENABLED === "1" && /^(127\.0\.0\.1|localhost)/.test(host) ? String(e?.stack ?? "").slice(0, 600) : "");
    return new Response(JSON.stringify({ error: "server_error" }), { status: 500, headers: { "content-type": "application/json" } });
  }
}
function _servers(origin, appConnect = false) {
  return servers(origin, appConnect);
}
async function registeredOrigin(env, origin) {
  if (!origin || !/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(origin)) return false;
  const rows = await env.DB.prepare(`SELECT origins FROM app_clients ac WHERE ac.disabled_at IS NULL
      OR EXISTS (SELECT 1 FROM publishers pb WHERE pb.app_client_id = ac.id AND pb.revoked_at IS NULL)`).all();
  return rows.results.some((r) => JSON.parse(r.origins).includes(origin));
}
async function publisherPreflight(req, env) {
  const origin = req.headers.get("origin");
  if (!await registeredOrigin(env, origin)) return new Response(null, { status: 403, headers: { vary: "Origin" } });
  return new Response(null, { status: 204, headers: {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST",
    "access-control-allow-headers": "Authorization, Content-Type, Idempotency-Key",
    "access-control-max-age": "600",
    vary: "Origin"
  } });
}
async function withPublisherCors(req, env, res) {
  const r = new Response(res.body, res);
  for (const h of ["access-control-allow-origin", "access-control-allow-methods", "access-control-allow-headers", "access-control-max-age", "access-control-allow-credentials"]) r.headers.delete(h);
  const origin = req.headers.get("origin");
  if (await registeredOrigin(env, origin)) {
    r.headers.set("access-control-allow-origin", origin);
    r.headers.set("access-control-expose-headers", "WWW-Authenticate, Retry-After, X-Request-Id");
  }
  r.headers.set("vary", "Origin");
  return r;
}
/** The installation's consent sign-in (identity adapter); 503 when not configured. */
function upstreamFor(env) {
  const u = adapters(env).identity.upstream(env);
  if (!u) throw new HttpError(503, "oidc_not_configured", "Upstream sign-in is not configured");
  return u;
}
var acOn, LIM, lim, SCOPES, CATALOGUE, AC_CATALOGUE, CONNECTION_EXPIRES_AT, cache, HOSTED_CALLBACKS, LISTED_ONLY, isLoopbackRedirect, MAX_CONN_PROJECTS, NEW_PROJECT_SLOTS, esc, page, errorPage, oauthJson, AS_PATHS, RS_META;
acOn = (env) => env.APP_CONNECT_ENABLED === "1";
LIM = { authorize: 30, token: 60, register: 10 };
lim = (env, k) => LIM[k] * (env.OAUTH_RATE_MULTIPLIER && /^\d{1,6}$/.test(env.OAUTH_RATE_MULTIPLIER) ? Number(env.OAUTH_RATE_MULTIPLIER) : 1);
SCOPES = { read: "agentlib:read", write: "agentlib:write", offline: "offline_access", publish: "agentlib:publish" };
CATALOGUE = [SCOPES.read, SCOPES.write, SCOPES.offline];
AC_CATALOGUE = [SCOPES.read, SCOPES.write, SCOPES.offline, SCOPES.publish];
CONNECTION_EXPIRES_AT = Date.UTC(9999, 0, 1);
cache = /* @__PURE__ */ new Map();
HOSTED_CALLBACKS = /* @__PURE__ */ new Set([
  "https://chatgpt.com/connector_platform_oauth_redirect",
  "https://www.cursor.com/agents/mcp/oauth/callback",
  "https://claude.ai/api/mcp/auth_callback"
]);
LISTED_ONLY = /* @__PURE__ */ new Set(["cursor://anysphere.cursor-mcp/oauth/callback"]);
isLoopbackRedirect = (u) => /^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?\/[A-Za-z0-9/_.-]*$/.test(u);
MAX_CONN_PROJECTS = 50;
NEW_PROJECT_SLOTS = 5;
esc = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
page = (title, body2, headers, status = 200, formTargets = [], opts = {}) => {
  const h = headers ?? new Headers();
  h.set("content-type", "text/html; charset=utf-8");
  const targets = ["'self'", ...formTargets.filter((o) => /^https:\/\/[a-z0-9.-]+$|^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(o))].join(" ");
  // Pages with the Turnstile widget may load Cloudflare's script and frame, nothing else.
  const ts = opts.turnstile ? `; script-src ${TURNSTILE_ORIGIN}; frame-src ${TURNSTILE_ORIGIN}` : "";
  h.set("content-security-policy", `default-src 'none'; style-src 'unsafe-inline'; form-action ${targets}; frame-ancestors 'none'; base-uri 'none'${ts}`);
  h.set("x-frame-options", "DENY");
  h.set("cache-control", "no-store");
  h.set("referrer-policy", "no-referrer");
  h.set("x-content-type-options", "nosniff");
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>:root{--bg:#f6f6f8;--fg:#18181b;--muted:#52525b;--faint:#6b6b76;--line:#e4e4e7;--line2:#d4d4d8;--card:#fff;--field:#fff;--sunk:#efeff2;--hover:rgba(24,24,27,.05);--accent:#2563eb;--accent-soft:rgba(37,99,235,.09);--accent-line:rgba(37,99,235,.35);--on-accent:#fff;--ok:#15703f;--warn:#8a5a00;--bad:#b42318;--banner-bg:#fff8e6;--banner-line:#efd28a;--shadow:0 1px 2px rgba(16,16,24,.04),0 4px 16px rgba(16,16,24,.06);--r1:4px;--r2:8px;--r3:12px;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0a0a0d;--fg:#ececef;--muted:#a1a1aa;--faint:#8b8b95;--line:#1f1f25;--line2:#2e2e36;--card:#111114;--field:#0e0e11;--sunk:#18181b;--hover:rgba(255,255,255,.05);--accent:#60a5fa;--accent-soft:rgba(96,165,250,.12);--accent-line:rgba(96,165,250,.38);--on-accent:#08111e;--ok:#4ade80;--warn:#f0b54a;--bad:#ff7a6b;--banner-bg:#1f1a0e;--banner-line:#4a3c17;--shadow:none;color-scheme:dark}}
*{box-sizing:border-box}
html{background:var(--bg)}
body{margin:0 auto;max-width:31rem;min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;justify-content:center;padding:max(24px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(24px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));font:15px/1.55 Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--fg);background:var(--bg);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
svg{width:16px;height:16px;flex:none;stroke:currentColor;fill:none;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
.top{display:flex;align-items:center;justify-content:center;gap:8px;margin:0 0 16px;font-weight:700;font-size:14px;letter-spacing:-.01em;color:var(--muted)}
.mark{flex:none;width:22px;height:22px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;background:var(--accent);color:var(--on-accent);font:800 12px/1 Inter,system-ui,sans-serif;letter-spacing:-.04em}
.mark::before{content:"A"}
.mark.lg{width:44px;height:44px;border-radius:var(--r3);font-size:21px}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r3);padding:28px;box-shadow:var(--shadow);animation:rise .28s cubic-bezier(.2,.8,.2,1) both}
.card:has(.bar){padding-bottom:0;overflow:clip}
@keyframes rise{from{opacity:0;transform:translateY(6px)}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
.foot{margin:16px 0 0;font-size:12.5px;color:var(--faint);text-align:center;text-wrap:balance}
.foot svg{width:13px;height:13px;margin-right:5px;vertical-align:-2px}
.pair{display:flex;align-items:center;justify-content:center;gap:10px;margin:0 0 18px}
.av{width:44px;height:44px;border-radius:var(--r3);display:inline-flex;align-items:center;justify-content:center;font:700 20px/1 Inter,system-ui,sans-serif;color:#fff;background:linear-gradient(135deg,hsl(var(--h) 62% 52%),hsl(calc(var(--h) + 40) 62% 42%))}
.link{display:inline-flex;gap:4px}
.link i{width:4px;height:4px;border-radius:50%;background:var(--line2);animation:pulse 1.4s ease-in-out infinite}
.link i:nth-child(2){animation-delay:.18s}.link i:nth-child(3){animation-delay:.36s}
@keyframes pulse{50%{background:var(--accent)}}
h1{margin:0;font-size:22px;line-height:1.25;font-weight:700;letter-spacing:-.02em;text-align:center;overflow-wrap:anywhere}
h2{margin:0 0 8px;font-size:12.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.sub{display:flex;align-items:center;gap:6px;margin:14px 0 0;font-size:14px;font-weight:600;color:var(--muted)}
p{margin:0 0 12px;overflow-wrap:anywhere}
.lede{margin:6px 0 16px;color:var(--muted);text-align:center;font-size:14.5px}
.fine{font-size:13px;color:var(--faint)}
strong{font-weight:650}
small{display:block;color:var(--muted);font-size:13px;font-weight:400}
code{font:12px ui-monospace,Menlo,monospace;background:var(--sunk);padding:1px 5px;border-radius:var(--r1)}
.chips{display:flex;flex-wrap:wrap;justify-content:center;gap:6px;margin:0 0 16px}
.chip{display:inline-flex;align-items:center;gap:5px;max-width:100%;padding:3px 10px;border-radius:999px;font-size:12.5px;font-weight:550;color:var(--muted);background:var(--sunk)}
.chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip svg{width:13px;height:13px}
.chip.ok{color:var(--ok);background:color-mix(in srgb,var(--ok) 12%,transparent)}
.chip.warn{color:var(--warn);background:color-mix(in srgb,var(--warn) 13%,transparent)}
.callout{display:flex;gap:10px;align-items:flex-start;margin:0 0 16px;padding:10px 12px;border-radius:var(--r2);font-size:13.5px;border:1px solid var(--line)}
.callout svg{margin-top:2px}
.callout.warn{background:var(--banner-bg);border-color:var(--banner-line)}.callout.warn svg{color:var(--warn)}
.callout.bad{background:color-mix(in srgb,var(--bad) 8%,var(--card));border-color:color-mix(in srgb,var(--bad) 35%,transparent)}.callout.bad svg{color:var(--bad)}
.callout.info{background:var(--accent-soft);border-color:var(--accent-line)}.callout.info svg{color:var(--accent)}
form{margin:0}
.sec{margin:20px 0 0}
.list{list-style:none;margin:0;padding:0;border:1px solid var(--line);border-radius:var(--r3);overflow:hidden}
.proj{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 8px 8px 14px;border-top:1px solid var(--line);transition:background .15s}
.proj:first-child{border-top:0}
.wsg+.wsg{margin-top:14px}.wsh{margin:0 0 6px;font-size:13px;font-weight:650;letter-spacing:.02em;text-transform:uppercase;color:var(--muted);overflow-wrap:anywhere}
.ro-badge{display:inline-block;margin-left:6px;padding:1px 7px;border-radius:999px;font-size:11.5px;font-weight:600;color:var(--muted);background:var(--sunk);vertical-align:1px}
.grant:has(.wsg .proj input:is([value=read],[value=write]):checked) .wsg:not(:has(.proj input:is([value=read],[value=write]):checked)) .seg{opacity:.6}
.one-ws{transition:color .15s}.grant:has(.wsg .proj input:is([value=read],[value=write]):checked) .one-ws{color:var(--fg);font-weight:600}
.sec .field{display:flex;flex-direction:column;gap:6px;margin:10px 0;font-size:14px;font-weight:600}
.proj:has(input:is([value=read],[value=write]):checked){background:var(--accent-soft)}
.pname{min-width:0;font-weight:550;overflow-wrap:anywhere}
.pname small{display:inline;font:11.5px ui-monospace,Menlo,monospace;color:var(--faint)}
.seg{flex:none;display:inline-flex;padding:3px;gap:2px;background:var(--sunk);border-radius:var(--r2)}
.seg label{position:relative;display:block;cursor:pointer}
.seg input{position:absolute;inset:0;opacity:0;margin:0;cursor:pointer}
.seg span{display:block;min-width:46px;padding:5px 10px;border-radius:6px;font-size:13px;font-weight:550;text-align:center;color:var(--muted);transition:background .15s,color .15s}
.seg label:hover span{color:var(--fg)}
.seg input:checked+span{background:var(--card);color:var(--fg);box-shadow:0 1px 2px rgba(0,0,0,.12)}
.seg input[value=write]:checked+span,.seg input[value=read]:checked+span{color:var(--fg);background:color-mix(in srgb,var(--accent) 12%,var(--card));box-shadow:inset 0 0 0 1.5px var(--accent)}
.seg input[value=none]:checked+span{box-shadow:inset 0 0 0 1px var(--line2)}
.seg input:focus-visible+span{outline:2px solid var(--accent);outline-offset:1px}
.more{margin:10px 0 0}
.more summary{display:inline-flex;align-items:center;gap:6px;min-height:40px;cursor:pointer;list-style:none;color:var(--accent);font-weight:550;font-size:14px}
.more summary::-webkit-details-marker{display:none}
.more[open] summary svg{transform:rotate(90deg)}
.more summary svg{transition:transform .15s}
.more .inner{padding:6px 0 0}
.newp{display:flex;gap:8px;align-items:center;margin:8px 0 0}
.newp:has(input[type=text]:placeholder-shown)~.newp:has(input[type=text]:placeholder-shown){display:none}
.newp:has(input[type=text]:placeholder-shown) .seg{opacity:.45}
input[type=text],select{font:inherit;font-size:16px;width:100%;min-width:0;min-height:42px;padding:8px 12px;border:1px solid var(--line2);border-radius:var(--r2);background:var(--field);color:var(--fg);outline:none}
input::placeholder{color:var(--faint);opacity:1}
input[type=text]:focus,select:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.newp input[type=text]{flex:1}
.field{display:block;margin:0 0 12px}
.field>span{display:block;margin:0 0 4px;font-size:13px;font-weight:600;color:var(--muted)}
.fresh optgroup[data-i]{display:none}
.fresh:not(:has(select[name=destination] option[value=new]:checked)) .newname{display:none}
.has-prev:not(:has(input[name=resume][value=new]:checked)) .fresh{display:none}
.aud{display:none;margin:0;font-size:13.5px}
.choice,.check{position:relative;display:flex;gap:12px;align-items:flex-start;margin:0 0 8px;padding:12px 14px;border:1px solid var(--line);border-radius:var(--r3);cursor:pointer;transition:border-color .15s,background .15s}
.choice:hover,.check:hover{border-color:var(--line2)}
.choice:has(input:checked){border-color:var(--accent);background:var(--accent-soft)}
.check{margin:20px 0 0}
.choice input,.check input{flex:none;width:18px;height:18px;margin:2px 0 0;accent-color:var(--accent)}
.choice span,.check span{min-width:0;overflow-wrap:anywhere}
.grant{counter-reset:sel}
.proj input:is([value=read],[value=write]):checked,.newp:has(input[type=text]:not(:placeholder-shown):valid) input:checked{counter-increment:sel}
.n::before{content:counter(sel)}
.count{flex:1;font-size:13px;color:var(--faint)}
.count .some{display:none}
.enter{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
.grant:has(.proj input:is([value=read],[value=write]):checked,.newp input[type=text]:not(:placeholder-shown):valid) .count .some{display:inline}
.grant:has(.proj input:is([value=read],[value=write]):checked,.newp input[type=text]:not(:placeholder-shown):valid) .count .none{display:none}
.grant:not(:has(.proj input:is([value=read],[value=write]):checked,.newp input[type=text]:not(:placeholder-shown):valid)) button.primary{opacity:.55}
.n{color:var(--fg);font-weight:650}
.bar{position:sticky;bottom:0;z-index:1;display:flex;align-items:center;justify-content:flex-end;gap:8px;margin:20px -28px 0;padding:14px 28px;border-top:1px solid var(--line);background:color-mix(in srgb,var(--sunk) 50%,var(--card));border-radius:0 0 var(--r3) var(--r3)}
button{font:inherit;display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:40px;padding:6px 16px;border-radius:var(--r2);border:1px solid var(--line2);background:var(--card);color:var(--fg);font-size:14.5px;font-weight:500;cursor:pointer;white-space:nowrap;transition:filter .15s,background .15s,transform .05s}
button:hover{background:var(--sunk)}
button:active{transform:translateY(1px)}
button.primary{border-color:var(--accent);background:var(--accent);color:var(--on-accent);font-weight:600}
button.primary:hover{background:var(--accent);filter:brightness(1.08)}
a.btnlink{font:inherit;display:inline-flex;align-items:center;justify-content:center;min-height:40px;padding:6px 16px;border-radius:var(--r2);border:1px solid var(--line2);background:var(--card);color:var(--fg);text-decoration:none}
a.btnlink.primary{border-color:var(--accent);background:var(--accent);color:var(--on-accent);font-weight:600}
.or{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:13px;margin:14px 0 4px}.or::before,.or::after{content:"";flex:1;border-top:1px solid var(--line)}
.state{text-align:center;padding:8px 0}
.state .big{display:inline-flex;align-items:center;justify-content:center;width:52px;height:52px;margin:0 0 14px;border-radius:50%}
.state .big svg{width:26px;height:26px;stroke-width:2.2}
.state.on .big{color:var(--ok);background:color-mix(in srgb,var(--ok) 14%,transparent);animation:pop .35s cubic-bezier(.2,1.4,.4,1) both}
.state.neutral .big{color:var(--muted);background:var(--sunk)}
.state.off .big{color:var(--bad);background:color-mix(in srgb,var(--bad) 12%,transparent)}
.state .lede{margin-bottom:8px}
@keyframes pop{from{transform:scale(.6);opacity:0}}
@media (max-width:480px){body{justify-content:flex-start;padding-top:max(16px,env(safe-area-inset-top))}.card{padding:22px 18px}.bar{margin:20px -18px 0;padding:12px 18px;flex-wrap:wrap}.count{flex-basis:100%}.bar button{flex:1}h1{font-size:20px}.proj{flex-wrap:wrap}}
@media (pointer:coarse){.seg span{min-height:40px;display:flex;align-items:center;justify-content:center;padding:0 12px}.more summary,button,input[type=text],select{min-height:44px}}
@supports not selector(:has(*)){.fresh optgroup[data-i]{display:block}.newp .seg{opacity:1}.has-prev .fresh h2::after{content:" (used only for Somewhere new)";text-transform:none;letter-spacing:0}.aud{display:block}.count{visibility:hidden}}</style>${body2}`, { status, headers: h });
};
errorPage = (msg, status = 400) => page("Cannot connect", cxShell(`<div class="state off"><span class="big" aria-hidden="true">${cxIcon("alert")}</span><h1>Couldn't connect</h1><p class="lede">${esc(msg)}</p><p class="fine">You can close this tab and start again from the app.</p></div>`, false), void 0, status);
oauthJson = (status, body2) => new Response(JSON.stringify(body2), { status, headers: { "content-type": "application/json", "cache-control": "no-store", pragma: "no-cache" } });
AS_PATHS = /* @__PURE__ */ new Set(["/.well-known/oauth-authorization-server", "/oauth/token", "/oauth/register"]);
RS_META = "/.well-known/oauth-protected-resource/mcp";

/**
 * A branded status page (sign-in errors, "check your email") in the consent pages' look: mark, card, icon, heading,
 * message and link-style actions [{ href, label, primary? }]. Same-origin hrefs only.
 */
function statusPage(title, msg, { status = 200, icon = "alert", actions = [], headers } = {}) {
  const links = actions.filter((a) => typeof a.href === "string" && a.href.startsWith("/") && !a.href.startsWith("//"))
    .map((a) => `<a class="btnlink${a.primary ? " primary" : ""}" href="${esc(a.href)}">${esc(a.label)}</a>`).join("");
  return page(title, cxShell(`<div class="state${icon === "alert" ? " off" : icon === "check" ? " on" : " neutral"}"><span class="big" aria-hidden="true">${cxIcon(icon)}</span><h1>${esc(title)}</h1><p class="lede">${esc(msg)}</p></div>${links ? `<div class="bar">${links}</div>` : ""}`, false), headers, status);
}
export { SCOPES, _servers, handleOAuthHost, liveConnection, livePublisher, originFor, servers, statusPage };
