// OAuth host (ChatGPT-compatible): discovery, PKCE S256 both legs, upstream OIDC (Access for SaaS stand-in that
// REQUIRES PKCE S256 + client secret), consent, connection binding, scopes, isolation, revocation, replay,
// host isolation. Real workers-oauth-provider 1.2.1 in workerd via wrangler dev; real MCP SDK client.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPairSync, createSign, createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { startServer, key, ROOT, LOCAL_CONFIG } from "./helpers.mjs";
import { SERVER_PORTS, AUX_PORTS } from "./ports.mjs";

const OIDC_PORT = AUX_PORTS.chatgptOidc, PORT = SERVER_PORTS.oauth;
const MCP = `http://127.0.0.1:${PORT}`;                 // OAuth host (MCP_HOST)
const APP = `http://localhost:${PORT}`;                 // owner host (APP_HOST)
const RESOURCE = `${MCP}/mcp`;
const UP_CLIENT = "upstreamclient123", UP_SECRET = "s3cret-" + randomBytes(8).toString("hex");
const ISS = "https://test-team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/" + UP_CLIENT;
const OWNER = "owner@example.invalid";
const CB = `http://127.0.0.1:${AUX_PORTS.chatgptCallback}/cb`; // downstream (ChatGPT-like) loopback redirect
// An operator-configured extra callback (OAUTH_EXTRA_REDIRECT_URIS), e.g. a self-run MCP gateway. Exact match only.
const GATEWAY_CALLBACK = "https://mcp-gateway.example.test/upstream/callback/library";
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const b64u = (b) => Buffer.from(b).toString("base64url");
const s256 = (v) => createHash("sha256").update(v).digest("base64url");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- fake Access-for-SaaS OIDC provider: PKCE S256 + client secret both REQUIRED ----------
const up = { codes: new Map(), seen: [], email: OWNER, sub: "access-user-1", tamper: null };
let oidc;
function idToken(claims) {
  const now = Math.floor(Date.now() / 1000);
  const body = { iss: ISS, aud: UP_CLIENT, sub: up.sub, email: up.email, iat: now, exp: now + 300, ...claims };
  const h = b64u(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" })) + "." + b64u(JSON.stringify(body));
  return h + "." + createSign("RSA-SHA256").update(h).sign(privateKey).toString("base64url");
}
function startOidc() {
  return createServer(async (req, res) => {
    const u = new URL(req.url, `http://127.0.0.1:${OIDC_PORT}`);
    const send = (s, b, h = {}) => { res.writeHead(s, { "content-type": "application/json", ...h }); res.end(JSON.stringify(b)); };
    if (u.pathname.endsWith("/jwks")) return send(200, { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" }] });
    if (u.pathname.endsWith("/authorization")) {
      const q = Object.fromEntries(u.searchParams);
      up.seen.push({ kind: "authorize", q });
      if (q.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge ?? "")) return send(400, { error: "invalid_request", error_description: "PKCE S256 required" });
      if (q.client_id !== UP_CLIENT || q.response_type !== "code") return send(400, { error: "invalid_request" });
      const code = "c" + randomBytes(12).toString("hex");
      up.codes.set(code, { challenge: q.code_challenge, nonce: q.nonce, redirect_uri: q.redirect_uri, used: false });
      res.writeHead(302, { location: `${q.redirect_uri}?code=${code}&state=${encodeURIComponent(q.state)}` }); return res.end();
    }
    if (u.pathname.endsWith("/token") && req.method === "POST") {
      let body = ""; for await (const c of req) body += c;
      const p = Object.fromEntries(new URLSearchParams(body));
      const auth = req.headers.authorization ?? "";
      const [cid, sec] = Buffer.from(auth.replace(/^Basic /, ""), "base64").toString().split(":").map(decodeURIComponent);
      up.seen.push({ kind: "token", hasBasic: auth.startsWith("Basic "), hasVerifier: !!p.code_verifier });
      if (cid !== UP_CLIENT || sec !== UP_SECRET) return send(401, { error: "invalid_client" });
      const c = up.codes.get(p.code);
      if (!c || c.used) return send(400, { error: "invalid_grant", error_description: "code" });
      c.used = true;
      if (!p.code_verifier || s256(p.code_verifier) !== c.challenge) return send(400, { error: "invalid_grant", error_description: "PKCE verifier mismatch" });
      if (p.redirect_uri !== c.redirect_uri) return send(400, { error: "invalid_grant" });
      const t = up.tamper; up.tamper = null;
      return send(200, { access_token: "up-at", token_type: "Bearer", id_token: idToken({ nonce: c.nonce, ...(t ?? {}) }) });
    }
    send(404, {});
  }).listen(OIDC_PORT, "127.0.0.1");
}

// ---------- browser-like client with a cookie jar per host ----------
function browser() {
  const jar = new Map();
  const cookieFor = (u) => [...(jar.get(new URL(u).host) ?? new Map())].map(([k, v]) => `${k}=${v}`).join("; ");
  async function go(url, init = {}) {
    const headers = { ...(init.headers ?? {}) };
    const c = cookieFor(url); if (c) headers.cookie = c;
    const r = await fetch(url, { ...init, headers, redirect: "manual" });
    const h = new URL(url).host;
    for (const sc of r.headers.getSetCookie?.() ?? []) {
      const [kv] = sc.split(";"); const i = kv.indexOf("=");
      const m = jar.get(h) ?? new Map(); jar.set(h, m);
      if (/max-age=0/i.test(sc)) m.delete(kv.slice(0, i)); else m.set(kv.slice(0, i), kv.slice(i + 1));
    }
    return r;
  }
  return { go, jar };
}
const form = (o) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString() });
const hidden = (html, name) => (html.match(new RegExp(`name="${name}" value="([^"]+)"`)) ?? [])[1];
/** Allow/Deny answer with a same-origin interstitial that navigates to the client (no script, meta refresh). */
async function clientTarget(r) {
  assert.equal(r.status, 200, `expected interstitial, got ${r.status}`);
  const html = await r.clone().text();
  assert.doesNotMatch(html, /<script/i);
  const m = html.match(/<meta http-equiv="refresh" content="0;url=([^"]+)">/);
  assert.ok(m, "interstitial has meta refresh");
  return new URL(m[1].replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c))));
}

// Register a DCR client (ChatGPT-like) with a loopback redirect.
async function register(redirect = CB) {
  const r = await fetch(`${MCP}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "ChatGPT test", redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) });
  assert.equal(r.status, 201, await r.clone().text());
  return (await r.json()).client_id;
}

/** Full authorization: returns { code, verifier, state, params }. opts: project, access, tamper hooks. */
async function authorize(clientId, { project, access = "read", grants, extra = {}, scope = "agentlib:read agentlib:write offline_access", b = browser(), skipPkce = false, method = "S256", redirect = CB } = {}) {
  const verifier = b64u(randomBytes(48)), state = "st" + randomBytes(6).toString("hex");
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect, scope, state, resource: RESOURCE });
  if (!skipPkce) { q.set("code_challenge", method === "S256" ? s256(verifier) : verifier); q.set("code_challenge_method", method); }
  let r = await b.go(`${MCP}/authorize?${q}`);
  if (r.status !== 200) return { early: r, verifier, state };
  let html = await r.text();
  r = await b.go(`${MCP}/authorize`, form({ handle: hidden(html, "handle"), step: "signin", decision: "approve" }));
  assert.equal(r.status, 302);
  const upUrl = r.headers.get("location");
  r = await fetch(upUrl, { redirect: "manual" }); // upstream (no cookies there)
  const cb = r.headers.get("location");
  if (!cb?.startsWith(MCP + "/callback")) return { upstream: r, verifier, state };
  r = await b.go(cb);
  if (r.status === 302) return { denied: r, verifier, state };
  html = await r.text();
  // grants: { [projectId]: "read" | "write" } (multi-project); default: single project + access.
  const perProject = Object.fromEntries(Object.entries(grants ?? { [project]: access }).map(([p, a]) => [`access:${p}`, a]));
  r = await b.go(`${MCP}/authorize`, form({ handle: hidden(html, "handle"), step: "grant", ...perProject, ...extra, decision: "approve" }));
  assert.equal(r.status, 200, `grant step: ${r.status} ${(await r.clone().text()).slice(0, 200)}`);
  const loc = await clientTarget(r);
  assert.ok(loc.searchParams.get("code"), `no code in redirect: ${loc.search.replace(/code=[^&]+/, "code=…")}`);
  return { code: loc.searchParams.get("code"), state: loc.searchParams.get("state"), iss: loc.searchParams.get("iss"), verifier, loc, upUrl, b };
}
async function token(params) {
  const r = await fetch(`${MCP}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString() });
  return { status: r.status, body: await r.json() };
}
async function mcp(tokenValue, method, params = {}, id = 1) {
  const r = await fetch(`${MCP}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(tokenValue ? { authorization: `Bearer ${tokenValue}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  const text = await r.text();
  let body = null; try { body = JSON.parse(text); } catch {}
  return { status: r.status, body, text, www: r.headers.get("www-authenticate"), ct: r.headers.get("content-type") };
}
const call = (t, name, args) => mcp(t, "tools/call", { name, arguments: args });

let s, owner, PA, PB, clientId;
before(async () => {
  oidc = startOidc();
  s = await startServer("oauth", PORT, {
    vars: {
      MCP_HOST: `127.0.0.1:${PORT}`, APP_HOST: `localhost:${PORT}`,
      ACCESS_OIDC_ISSUER: ISS, ACCESS_OIDC_CLIENT_ID: UP_CLIENT, ACCESS_OIDC_CLIENT_SECRET: UP_SECRET, OWNER_EMAIL: OWNER,
      OIDC_TEST_ENDPOINT_BASE: `http://127.0.0.1:${OIDC_PORT}`, OAUTH_EXTRA_REDIRECT_URIS: `${GATEWAY_CALLBACK} https://second-gateway.example.test/cb`,
      RATE_READS_PER_MIN: "100000", RATE_WRITES_PER_MIN: "100000", RATE_AUTHFAIL_PER_MIN: "100000", OAUTH_RATE_MULTIPLIER: "100",
    },
    readyBase: APP,
  });
  owner = await s.loginAt(APP);
  PA = "proj-a"; PB = "proj-b";
  for (const p of [PA, PB]) assert.equal((await owner.req("POST", "/api/projects", { id: p, title: p.toUpperCase() })).status, 201);
  const d = await owner.req("POST", `/api/projects/${PB}/artifacts`, { title: "Secret B", body: "project b only" });
  assert.equal(d.status, 201);
  clientId = await register();
});
after(async () => { await s?.stop(); oidc?.close(); });

test("anonymous discovery; private MCP call gets an OAuth JSON challenge, not HTML", async () => {
  const prm = await (await fetch(`${MCP}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(prm.resource, RESOURCE);
  assert.deepEqual(prm.authorization_servers, [MCP]);
  const asm = await (await fetch(`${MCP}/.well-known/oauth-authorization-server`)).json();
  assert.equal(asm.issuer, MCP);
  assert.deepEqual(asm.code_challenge_methods_supported, ["S256"]);
  assert.equal(asm.authorization_response_iss_parameter_supported, true);
  assert.ok(asm.registration_endpoint);
  assert.ok(asm.scopes_supported.includes("agentlib:write"));
  const r = await mcp(null, "tools/list");
  assert.equal(r.status, 401);
  assert.match(r.www, /^Bearer /);
  assert.match(r.www, /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);
  assert.doesNotMatch(r.ct ?? "", /html/);
});

test("upstream login uses a fresh PKCE S256 verifier + client secret, scopes openid email only", async () => {
  up.seen.length = 0;
  const a1 = await authorize(clientId, { project: PA });
  const a2 = await authorize(clientId, { project: PA });
  const auths = up.seen.filter((x) => x.kind === "authorize").map((x) => x.q);
  assert.equal(auths.length, 2);
  for (const q of auths) {
    assert.equal(q.code_challenge_method, "S256");
    assert.equal(q.scope, "openid email");
    assert.ok(q.nonce && q.state);
    assert.equal(q.redirect_uri, `${MCP}/callback`);
  }
  assert.notEqual(auths[0].code_challenge, auths[1].code_challenge, "fresh verifier per login");
  assert.notEqual(auths[0].nonce, auths[1].nonce);
  const toks = up.seen.filter((x) => x.kind === "token");
  assert.ok(toks.every((t) => t.hasBasic && t.hasVerifier), "token exchange sends client secret AND code_verifier");
  assert.ok(a1.code && a2.code);
  // The verifier/nonce never appear in the upstream URL (only the challenge does)
  assert.doesNotMatch(a1.upUrl, /code_verifier/);
});

test("upstream rejections: wrong nonce, wrong audience, non-owner email, expired ID token -> access_denied, no code", async () => {
  for (const t of [{ nonce: "evil" }, { aud: "other-client" }, { email: "intruder@example.invalid" }, { exp: Math.floor(Date.now() / 1000) - 10 }, { iss: "https://evil.example/" }]) {
    up.tamper = t;
    const r = await authorize(clientId, { project: PA });
    assert.ok(r.denied, JSON.stringify(t));
    const loc = new URL(r.denied.headers.get("location"));
    assert.equal(loc.searchParams.get("error"), "access_denied", JSON.stringify(t));
    assert.equal(loc.searchParams.get("code"), null);
  }
});

test("upstream callback: state replay and cross-browser state are refused", async () => {
  const b = browser();
  const verifier = b64u(randomBytes(48));
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: CB, scope: "agentlib:read", state: "x1", resource: RESOURCE, code_challenge: s256(verifier), code_challenge_method: "S256" });
  let r = await b.go(`${MCP}/authorize?${q}`);
  r = await b.go(`${MCP}/authorize`, form({ handle: hidden(await r.text(), "handle"), step: "signin", decision: "approve" }));
  const cb = (await fetch(r.headers.get("location"), { redirect: "manual" })).headers.get("location");
  const other = browser();
  assert.equal((await other.go(cb)).status, 400, "callback from another browser (no binding cookie) is refused");
  assert.equal((await b.go(cb)).status, 200, "owner browser proceeds");
  assert.equal((await b.go(cb)).status, 400, "state is single-use");
});

test("downstream PKCE: missing PKCE, plain method, wrong verifier, code replay all fail", async () => {
  const noPkce = await authorize(clientId, { project: PA, skipPkce: true });
  assert.ok(noPkce.early && noPkce.early.status !== 200);
  const plain = await authorize(clientId, { project: PA, method: "plain" });
  assert.ok(plain.early && plain.early.status !== 200);
  const a = await authorize(clientId, { project: PA });
  const bad = await token({ grant_type: "authorization_code", code: a.code, redirect_uri: CB, client_id: clientId, code_verifier: b64u(randomBytes(48)), resource: RESOURCE });
  assert.equal(bad.status, 400); assert.equal(bad.body.error, "invalid_grant");
  const a2 = await authorize(clientId, { project: PA });
  const ok = await token({ grant_type: "authorization_code", code: a2.code, redirect_uri: CB, client_id: clientId, code_verifier: a2.verifier, resource: RESOURCE });
  assert.equal(ok.status, 200);
  const replay = await token({ grant_type: "authorization_code", code: a2.code, redirect_uri: CB, client_id: clientId, code_verifier: a2.verifier, resource: RESOURCE });
  assert.equal(replay.status, 400, "authorization code is single-use");
});

test("redirect tampering and wrong resource fail; state and iss are returned", async () => {
  const b = browser();
  const v = b64u(randomBytes(48));
  const q = (o) => new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: CB, scope: "agentlib:read", state: "s", resource: RESOURCE, code_challenge: s256(v), code_challenge_method: "S256", ...o });
  const evil = await b.go(`${MCP}/authorize?${q({ redirect_uri: "https://evil.example/cb" })}`);
  assert.equal(evil.status, 400); assert.equal(evil.headers.get("location"), null, "never redirect to an unregistered URI");
  const wrongRes = await b.go(`${MCP}/authorize?${q({ resource: "https://other.example/mcp" })}`);
  assert.notEqual(wrongRes.status, 200);
  const a = await authorize(clientId, { project: PA });
  assert.match(a.state, /^st/); assert.equal(a.iss, MCP);
  const wrongRedirect = await token({ grant_type: "authorization_code", code: a.code, redirect_uri: `http://127.0.0.1:${AUX_PORTS.chatgptCallback}/other`, client_id: clientId, code_verifier: a.verifier, resource: RESOURCE });
  assert.equal(wrongRedirect.status, 400);
});

let rwToken, rwRefresh, roToken, rwConn;
test("read+write connection: real MCP SDK client initializes, lists tools, creates/reads/edits Markdown; owner sees it", async () => {
  const a = await authorize(clientId, { project: PA, access: "write" });
  const t = await token({ grant_type: "authorization_code", code: a.code, redirect_uri: CB, client_id: clientId, code_verifier: a.verifier, resource: RESOURCE });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  assert.equal(t.body.resource, RESOURCE);
  assert.ok(t.body.refresh_token);
  assert.ok(t.body.expires_in <= 900);
  rwToken = t.body.access_token; rwRefresh = t.body.refresh_token;
  const connections = (await owner.req("GET", `/api/projects/${PA}/connections`)).body.connections;
  assert.equal(connections[0].expires_at, new Date(Date.UTC(9999, 0, 1)).toISOString(), "new MCP connection lasts until revoked");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const c = new Client({ name: "chatgpt-sim", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(RESOURCE), { requestInit: { headers: { authorization: `Bearer ${rwToken}` } } }));
  const tools = (await c.listTools()).tools;
  assert.deepEqual(tools.map((x) => x.name).sort(), ["artifact_history", "connection_info", "create_from_template", "create_markdown", "diff_revisions", "list_artifacts", "list_changes", "list_projects", "list_templates", "read_artifact", "read_file", "restore_metadata", "restore_revision", "save_markdown", "search_artifacts", "upload_begin", "upload_file", "upload_finish"]);
  assert.equal(tools.find((x) => x.name === "connection_info").annotations.readOnlyHint, true);
  assert.equal(tools.find((x) => x.name === "restore_revision").annotations.readOnlyHint, false);
  assert.equal(tools.find((x) => x.name === "diff_revisions").annotations.readOnlyHint, true);
  assert.equal(tools.find((x) => x.name === "read_artifact").annotations.readOnlyHint, true);
  assert.equal(tools.find((x) => x.name === "search_artifacts").annotations.readOnlyHint, true);
  assert.equal(tools.find((x) => x.name === "list_changes").annotations.readOnlyHint, true);
  assert.equal(tools.find((x) => x.name === "save_markdown").annotations.readOnlyHint, false);
  // Agents are asked to always say why they changed something (shown to the owner in History).
  assert.match(c.getInstructions() ?? "", /whenever a tool has a change_note field, always set it/);
  for (const t of tools) if (/Always set change_note|Set change_note to why/.test(t.description)) assert.ok(t.inputSchema.properties.change_note, t.name);
  assert.match(tools.find((x) => x.name === "save_markdown").description, /Always set change_note/);
  for (const n of ["create_markdown", "save_markdown", "restore_revision", "restore_metadata"])
    assert.match(tools.find((x) => x.name === n).inputSchema.properties.change_note.description, /^Always include: why/, n);
  const proj = await c.callTool({ name: "list_projects", arguments: {} });
  assert.deepEqual(proj.structuredContent.projects.map((p) => p.id), [PA]);
  const made = await c.callTool({ name: "create_markdown", arguments: { title: "From ChatGPT", body: "# hello\nv1", idempotency_key: key("c") } });
  assert.equal(made.isError, false, JSON.stringify(made.structuredContent));
  const id = made.structuredContent.artifact_id;
  const rd = await c.callTool({ name: "read_artifact", arguments: { artifact_id: id } });
  assert.equal(rd.structuredContent.body, "# hello\nv1");
  const ed = await c.callTool({ name: "save_markdown", arguments: { artifact_id: id, expected_revision: 1, body: "# hello\nv2", idempotency_key: key("s") } });
  assert.equal(ed.structuredContent.revision, 2);
  const stale = await c.callTool({ name: "save_markdown", arguments: { artifact_id: id, expected_revision: 1, body: "stale", idempotency_key: key("s") } });
  assert.equal(stale.structuredContent.error.code, "revision_conflict");
  await c.close();
  const seen = await owner.req("GET", `/api/projects/${PA}/artifacts/${id}`);
  assert.equal(seen.body.body, "# hello\nv2", "owner sees the same content");
  // Version history names the OAuth connection (not the owner) and the client's self-reported MCP clientInfo.
  const v2 = (await owner.req("GET", `/api/projects/${PA}/artifacts/${id}/history`)).body.revisions[0];
  assert.deepEqual([v2.rev, v2.via.kind, v2.who, v2.client_info], [2, "oauth", "ChatGPT test", "chatgpt-sim 1"]);
  rwConn = (await owner.req("GET", `/api/projects/${PA}/connections`)).body.connections.find((x) => x.access === "read+write" && !x.revoked).id;
});

test("read-only connection cannot write; Project A connection cannot reach Project B", async () => {
  const a = await authorize(clientId, { project: PA, access: "read" });
  const t = await token({ grant_type: "authorization_code", code: a.code, redirect_uri: CB, client_id: clientId, code_verifier: a.verifier, resource: RESOURCE });
  roToken = t.body.access_token;
  assert.ok(!t.body.scope.split(" ").includes("agentlib:write"), "ceiling enforced at consent");
  const tl = await mcp(roToken, "tools/list");
  assert.ok(!tl.body.result.tools.some((x) => x.name === "create_markdown"));
  const w = await call(roToken, "create_markdown", { title: "nope", idempotency_key: key("x") });
  assert.equal(w.status, 403); assert.match(w.www, /insufficient_scope/);
  const list = await call(rwToken, "list_artifacts", {});
  assert.ok(!list.body.result.structuredContent.artifacts.some((x) => x.title === "Secret B"));
  const bDocs = await owner.req("GET", `/api/projects/${PB}/artifacts`);
  const bId = bDocs.body.artifacts[0].id;
  const cross = await call(rwToken, "read_artifact", { artifact_id: bId });
  assert.equal(cross.body.result.isError, true);
  assert.equal(cross.body.result.structuredContent.error.status, 404);
  const extra = await call(rwToken, "read_artifact", { artifact_id: bId, project_id: PB });
  assert.equal(extra.body.result.isError, true, "project_id outside the connection is refused");
  assert.equal(extra.body.result.structuredContent.error.status, 404);
  assert.equal(JSON.stringify(extra.body).includes("project b only"), false);
});

test("read_artifact chunks: >256 KiB document reconstructs exactly, each response <= max_bytes on the wire; revoke stops the next chunk", async () => {
  // Synthetic text with JSON escapes and multi-byte UTF-8 (2, 3 and 4 bytes).
  const unit = "line \"q\" \\ é 中 😀\n";
  const body = unit.repeat(Math.ceil(300 * 1024 / Buffer.byteLength(unit)));
  const id = (await owner.req("POST", `/api/projects/${PA}/artifacts`, { title: "Long", body })).body.artifact_id;
  // Small reads are unchanged: whole body, no chunk fields.
  const whole = await call(roToken, "read_artifact", { artifact_id: id });
  assert.equal(whole.body.result.structuredContent.body, body);
  assert.equal(whole.body.result.structuredContent.next_cursor, undefined);
  let r = await call(roToken, "read_artifact", { artifact_id: id, max_bytes: 16384 }), text = "", n = 0;
  for (;;) {
    const out = r.body.result.structuredContent;
    assert.equal(r.body.result.isError, false, JSON.stringify(out));
    assert.ok(Buffer.byteLength(r.text) <= 16384, `wire ${Buffer.byteLength(r.text)}`);
    assert.equal(out.revision, 1); assert.equal(out.encoding, "mcp");
    text += out.text; n++;
    if (out.eof) break;
    r = await call(roToken, "read_artifact", { artifact_id: id, cursor: out.next_cursor, max_bytes: 16384 });
  }
  assert.equal(text, body); assert.ok(n > 20);
  // The echoed JSON-RPC id counts toward the bound.
  const li = await mcp(roToken, "tools/call", { name: "read_artifact", arguments: { artifact_id: id, max_bytes: 8192 } }, "id-" + "y".repeat(1019));
  assert.equal(li.body.result.isError, false); assert.ok(Buffer.byteLength(li.text) <= 8192, `long id wire ${Buffer.byteLength(li.text)}`);
  // Error replies are bounded too: over-long id refused before it is echoed; an oversized project_required error
  // (multi-project connection lists its projects) or long unknown-argument name is replaced by a compact error.
  // A separate connection, so these calls do not use roToken's fixed 60 reads/min budget.
  const ea = await authorize(clientId, { project: PA, access: "read" });
  const et = (await token({ grant_type: "authorization_code", code: ea.code, redirect_uri: CB, client_id: clientId, code_verifier: ea.verifier, resource: RESOURCE })).body.access_token;
  for (const args of [{ artifact_id: id, max_bytes: 4096 }, { artifact_id: "art_missing", max_bytes: 4096 }, { artifact_id: id, cursor: "rc1.zz", max_bytes: 4096 }]) {
    const e = await mcp(et, "tools/call", { name: "read_artifact", arguments: args }, "i".repeat(100000));
    assert.equal(e.status, 400); assert.equal(e.body.id, null); assert.ok(Buffer.byteLength(e.text) <= 4096, `oauth long-id error ${Buffer.byteLength(e.text)}`);
    const ok = await mcp(et, "tools/call", { name: "read_artifact", arguments: args }, "j".repeat(1022));
    assert.ok(Buffer.byteLength(ok.text) <= 4096, `oauth id-1022 reply ${Buffer.byteLength(ok.text)}`);
  }
  const longArg = await mcp(et, "tools/call", { name: "read_artifact", arguments: { artifact_id: id, max_bytes: 4096, ["k".repeat(9000)]: 1 } }, "j".repeat(1022));
  assert.ok(Buffer.byteLength(longArg.text) <= 4096); assert.equal(longArg.body.error.code, -32602);
  // Revoking the connection between chunks: the next chunk is refused.
  const a = await authorize(clientId, { project: PA, access: "read" });
  const t = (await token({ grant_type: "authorization_code", code: a.code, redirect_uri: CB, client_id: clientId, code_verifier: a.verifier, resource: RESOURCE })).body.access_token;
  const c1 = await call(t, "read_artifact", { artifact_id: id, max_bytes: 4096 });
  assert.equal(c1.body.result.isError, false);
  const conn = (await owner.req("GET", `/api/projects/${PA}/connections`)).body.connections[0];
  assert.equal((await owner.req("POST", `/api/projects/${PA}/connections/${conn.id}/revoke`, {})).status, 200);
  const c2 = await call(t, "read_artifact", { artifact_id: id, cursor: c1.body.result.structuredContent.next_cursor });
  assert.equal(c2.status, 401);
  assert.equal(c2.text.includes("😀"), false);
});

test("multi-project consent: per-project permissions (A read, B write); project_id required and confined to the connection", async () => {
  const PC = "proj-c";
  assert.equal((await owner.req("POST", "/api/projects", { id: PC, title: "Not shared" })).status, 201);
  const cDoc = (await owner.req("POST", `/api/projects/${PC}/artifacts`, { title: "Secret C", body: "project c only" })).body.artifact_id;
  const aDoc = (await owner.req("POST", `/api/projects/${PA}/artifacts`, { title: "A doc", body: "a body" })).body.artifact_id;
  const a = await authorize(clientId, { grants: { [PA]: "read", [PB]: "write" }, extra: { [`access:${PC}`]: "none" } });
  const t = await token({ grant_type: "authorization_code", code: a.code, redirect_uri: CB, client_id: clientId, code_verifier: a.verifier, resource: RESOURCE });
  assert.equal(t.status, 200);
  const at = t.body.access_token;
  const lp = await call(at, "list_projects", {});
  assert.deepEqual(lp.body.result.structuredContent.projects.map((p) => [p.id, p.can_write]).sort(), [[PA, false], [PB, true]]);
  const tl = await mcp(at, "tools/list");
  assert.ok(tl.body.result.tools.some((x) => x.name === "create_markdown"), "write tools listed when any project allows edits");
  // Exposed schemas: every project-scoped tool accepts project_id (never required), list_projects takes none
  for (const n of ["list_artifacts", "read_artifact", "artifact_history", "create_markdown", "save_markdown"]) {
    const t = tl.body.result.tools.find((x) => x.name === n);
    assert.equal(t.inputSchema.properties.project_id?.type, "string", `${n} exposes project_id`);
    assert.ok(!t.inputSchema.required.includes("project_id"), `${n}: project_id optional`);
    assert.doesNotMatch(t.description, /the connected project|one project/i, `${n} description not single-project`);
  }
  assert.deepEqual(Object.keys(tl.body.result.tools.find((x) => x.name === "list_projects").inputSchema.properties), []);
  // Missing project_id with several projects -> project_required, naming the choices
  const noP = await call(at, "list_artifacts", {});
  assert.equal(noP.body.result.structuredContent.error.code, "project_required");
  assert.deepEqual(noP.body.result.structuredContent.error.projects.map((p) => p.id).sort(), [PA, PB].sort());
  // The same project_required error on a chunked read stays within max_bytes (with the largest allowed id).
  const noPc = await mcp(at, "tools/call", { name: "read_artifact", arguments: { artifact_id: "art_x", max_bytes: 4096 } }, "j".repeat(1022));
  assert.ok(Buffer.byteLength(noPc.text) <= 4096, `project_required chunk error ${Buffer.byteLength(noPc.text)}`);
  assert.equal(noPc.body.result.structuredContent.error.code, "project_required");
  // Argument forwarding: list in each project returns that project's docs only; create in B lands in B
  const listB = await call(at, "list_artifacts", { project_id: PB });
  assert.ok(listB.body.result.structuredContent.artifacts.every((x) => x.project_id === PB));
  assert.ok(listB.body.result.structuredContent.artifacts.some((x) => x.title === "Secret B"));
  const listA = await call(at, "list_artifacts", { project_id: PA, query: "A doc" });
  assert.deepEqual(listA.body.result.structuredContent.artifacts.map((x) => x.project_id), [PA]);
  // Write in B allowed; write in A (read-only for this connection) refused; nothing written to A
  const wB = await call(at, "create_markdown", { project_id: PB, title: "Made in B", body: "b2", idempotency_key: key("mb") });
  assert.equal(wB.body.result.isError, false, JSON.stringify(wB.body));
  const madeB = (await owner.req("GET", `/api/projects/${PB}/artifacts/${wB.body.result.structuredContent.artifact_id}`));
  assert.equal(madeB.status, 200); assert.equal(madeB.body.artifact.project_id, PB);
  assert.match(wB.body.result.structuredContent.web_url, new RegExp(`/p/${PB}/a/`));
  const wA = await call(at, "create_markdown", { project_id: PA, title: "Should not exist", body: "x", idempotency_key: key("ma") });
  assert.equal(wA.body.result.structuredContent.error.code, "forbidden");
  const eA = await call(at, "save_markdown", { project_id: PA, artifact_id: aDoc, expected_revision: 1, body: "hijack", idempotency_key: key("sa") });
  assert.equal(eA.body.result.structuredContent.error.code, "forbidden");
  assert.equal((await owner.req("GET", `/api/projects/${PA}/artifacts/${aDoc}`)).body.body, "a body");
  assert.equal((await owner.req("GET", `/api/projects/${PA}/artifacts?q=Should not exist`)).body.artifacts.length, 0);
  // Read in A allowed; project C (No access) and cross-project artifact IDs unreachable
  assert.equal((await call(at, "read_artifact", { project_id: PA, artifact_id: aDoc })).body.result.structuredContent.body, "a body");
  for (const args of [{ project_id: PC, artifact_id: cDoc }, { project_id: PA, artifact_id: cDoc }, { project_id: PB, artifact_id: aDoc }]) {
    const r = await call(at, "read_artifact", args);
    assert.equal(r.body.result.isError, true, JSON.stringify(args));
    assert.equal(JSON.stringify(r.body).includes("project c only"), false);
  }
  // Owner sees the connection under both projects (per-project access), not under C
  const ca = (await owner.req("GET", `/api/projects/${PA}/connections`)).body.connections.find((c) => c.project_count === 2 && !c.revoked);
  const cb = (await owner.req("GET", `/api/projects/${PB}/connections`)).body.connections.find((c) => c.id === ca.id);
  assert.equal(ca.access, "read"); assert.equal(cb.access, "read+write");
  assert.equal((await owner.req("GET", `/api/projects/${PC}/connections`)).body.connections.some((c) => c.id === ca.id), false);
  // Revoking from either project revokes the whole connection; revoking via an unrelated project is refused
  assert.equal((await owner.req("POST", `/api/projects/${PC}/connections/${ca.id}/revoke`, {})).status, 404);
  assert.equal((await owner.req("POST", `/api/projects/${PB}/connections/${ca.id}/revoke`, {})).status, 200);
  assert.equal((await call(at, "list_projects", {})).status, 401);
});

test("consent can create a new project; it is owned by the owner and shared with the chosen access only", async () => {
  const a = await authorize(clientId, { grants: {}, extra: { new_title: "Made during consent <b>x</b>", new_access: "write" } });
  const t = await token({ grant_type: "authorization_code", code: a.code, redirect_uri: CB, client_id: clientId, code_verifier: a.verifier, resource: RESOURCE });
  const lp = (await call(t.body.access_token, "list_projects", {})).body.result.structuredContent.projects;
  assert.equal(lp.length, 1);
  assert.equal(lp[0].title, "Made during consent <b>x</b>"); assert.equal(lp[0].can_write, true);
  assert.match(lp[0].id, /^prj_/);
  const w = await call(t.body.access_token, "create_markdown", { title: "first", body: "hi", idempotency_key: key("n") });
  assert.equal(w.body.result.isError, false, "single project: project_id optional");
  const mine = (await owner.req("GET", "/api/projects")).body.projects.find((p) => p.id === lp[0].id);
  assert.ok(mine, "owner sees the new project in the web app");
});

test("consent can create several new projects at once with different access", async () => {
  const before = (await owner.req("GET", "/api/projects")).body.projects.length;
  const a = await authorize(clientId, { grants: {}, extra: { new_title: "Multi one", new_access: "read", new_title_2: "", new_access_2: "write", new_title_4: "Multi four", new_access_4: "write" } });
  const t = await token({ grant_type: "authorization_code", code: a.code, redirect_uri: CB, client_id: clientId, code_verifier: a.verifier, resource: RESOURCE });
  const lp = (await call(t.body.access_token, "list_projects", {})).body.result.structuredContent.projects;
  assert.deepEqual(lp.map((p) => [p.title, p.can_write]).sort(), [["Multi four", true], ["Multi one", false]]);
  assert.equal((await owner.req("GET", "/api/projects")).body.projects.length, before + 2, "empty row skipped");
});

test("consent validation: nothing chosen, new name without access, unknown values -> error page, handle not consumed", async () => {
  const b = browser();
  const verifier = b64u(randomBytes(48));
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: CB, scope: "agentlib:read", state: "v1", resource: RESOURCE, code_challenge: s256(verifier), code_challenge_method: "S256" });
  let html = await (await b.go(`${MCP}/authorize?${q}`)).text();
  let r = await b.go(`${MCP}/authorize`, form({ handle: hidden(html, "handle"), step: "signin", decision: "approve" }));
  r = await fetch(r.headers.get("location"), { redirect: "manual" });
  r = await b.go(r.headers.get("location"));
  html = await r.text();
  assert.match(html, /<input type="radio" name="access:proj-a" value="none" checked>/);
  assert.match(html, /name="new_title"/);
  assert.doesNotMatch(html, /<script/i);
  const handle = hidden(html, "handle");
  const projectsBefore = (await owner.req("GET", "/api/projects")).body.projects.length;
  for (const bad of [{}, { new_title: "No access chosen" }, { [`access:${PA}`]: "admin" }, { new_title: "x".repeat(201), new_access: "read" },
    { new_title: "Dup", new_access: "read", new_title_3: "dup", new_access_3: "write" }, { new_title_2: "Second only", new_access_2: "bogus" }]) {
    r = await b.go(`${MCP}/authorize`, form({ handle, step: "grant", decision: "approve", ...bad }));
    assert.equal(r.status, 400, JSON.stringify(bad).slice(0, 60));
    // Fixable mistakes re-render the consent page with the error and the owner's choices kept (no dead-end page).
    const again = await r.text();
    assert.match(again, /class="callout bad" role="alert"/);
    assert.equal(hidden(again, "handle"), handle, "same handle, so the owner can fix and submit");
    for (const [k, v] of Object.entries(bad)) if (k.startsWith("new_title") && v.length <= 200) assert.match(again, new RegExp(`name="${k}" [^>]*value="${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`), `${k} kept`);
  }
  assert.equal((await owner.req("GET", "/api/projects")).body.projects.length, projectsBefore, "no project created by invalid submissions");
  // Same handle still works after validation errors
  r = await b.go(`${MCP}/authorize`, form({ handle, step: "grant", decision: "approve", [`access:${PA}`]: "read" }));
  assert.ok((await clientTarget(r)).searchParams.get("code"));
});

test("missing, malformed, wrong-audience, garbage and expired-format tokens fail with 401 challenge", async () => {
  for (const t of [null, "garbage", "a:b:c", rwToken.slice(0, -2) + "xx", "alt_" + "x".repeat(40)]) {
    const r = await mcp(t, "tools/list");
    assert.equal(r.status, 401, String(t).slice(0, 8)); assert.match(r.www, /Bearer/);
  }
});

test("legacy grants, owner cookies and spoofed Access headers do not authorize the OAuth host", async () => {
  const g = (await owner.req("POST", `/api/projects/${PA}/grants`, { label: "legacy", can_write: true })).body.token;
  assert.equal((await mcp(g, "tools/list")).status, 401);
  const r = await fetch(`${MCP}/mcp`, { method: "POST", headers: { cookie: owner.cookie, "cf-access-jwt-assertion": "x.y.z", "cf-access-authenticated-user-email": OWNER, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal(r.status, 401);
});

test("OAuth host exposes no owner/admin/REST routes; owner host rejects OAuth tokens; unknown hosts 404", async () => {
  for (const p of ["/", "/app.js", "/api/projects", `/api/projects/${PA}/grants`, "/api/me", "/auth/dev-login", "/api/transfers/upl_x", "/api/restore", `/api/projects/${PA}/backup`]) {
    const r = await fetch(MCP + p, { headers: { authorization: `Bearer ${rwToken}`, cookie: owner.cookie } });
    assert.equal(r.status, 404, p);
  }
  const ownerHost = await fetch(`${APP}/api/projects`, { headers: { authorization: `Bearer ${rwToken}` } });
  assert.equal(ownerHost.status, 401, "OAuth access token is not a legacy grant");
  const ownerMcp = await fetch(`${APP}/mcp`, { method: "POST", headers: { authorization: `Bearer ${rwToken}`, "content-type": "application/json" }, body: "{}" });
  assert.equal(ownerMcp.status, 401);
  // Real Host-header override (curl): unknown hosts reach neither surface.
  for (const h of [`evil.example:${PORT}`, `agent-library.example.workers.dev`]) {
    for (const p of ["/api/projects", "/mcp", "/.well-known/oauth-authorization-server", "/"]) {
      const code = execFileSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "-H", `Host: ${h}`, "-H", `authorization: Bearer ${rwToken}`, `http://127.0.0.1:${PORT}${p}`]).toString();
      assert.equal(code, "404", `${h}${p}`);
    }
  }
});

test("connection expiry (D1) blocks an unexpired access token", async () => {
  const a = await authorize(clientId, { project: PA, access: "read" });
  const t = (await token({ grant_type: "authorization_code", code: a.code, redirect_uri: CB, client_id: clientId, code_verifier: a.verifier, resource: RESOURCE })).body.access_token;
  assert.equal((await call(t, "list_projects", {})).status, 200);
  // Connections list is ordered newest first; the one just created is this token's connection.
  const conn = (await owner.req("GET", `/api/projects/${PA}/connections`)).body.connections[0];
  assert.equal(conn.revoked, false); assert.equal(conn.access, "read");
  execFileSync("wrangler", ["d1", "--config", LOCAL_CONFIG, "execute", "DB", "--local", "--persist-to", s.dir, "--command", `UPDATE oauth_connections SET expires_at = 1 WHERE id = '${conn.id}'`], { cwd: ROOT, stdio: "ignore" });
  const after = await call(t, "list_projects", {});
  assert.equal(after.status, 401);
  assert.match(after.www, /invalid_token/);
});

test("refresh rotates; revocation blocks existing access + refresh while another connection keeps working", async () => {
  const r1 = await token({ grant_type: "refresh_token", refresh_token: rwRefresh, client_id: clientId, resource: RESOURCE });
  assert.equal(r1.status, 200);
  assert.notEqual(r1.body.refresh_token, rwRefresh);
  const freshAccess = r1.body.access_token;
  assert.equal((await call(freshAccess, "list_projects", {})).status, 200);
  const rv = await owner.req("POST", `/api/projects/${PA}/connections/${rwConn}/revoke`, {});
  assert.equal(rv.status, 200, JSON.stringify(rv.body));
  assert.equal((await call(freshAccess, "list_projects", {})).status, 401, "unexpired access token blocked");
  assert.equal((await call(rwToken, "list_projects", {})).status, 401);
  const r2 = await token({ grant_type: "refresh_token", refresh_token: r1.body.refresh_token, client_id: clientId, resource: RESOURCE });
  assert.equal(r2.status, 400, "refresh blocked"); assert.equal(r2.body.error, "invalid_grant");
  assert.equal((await call(roToken, "list_projects", {})).status, 200, "independent read-only connection still works");
  // Legacy Pi grant path unaffected
  const g = (await owner.req("POST", `/api/projects/${PA}/grants`, { label: "pi", can_write: false })).body.token;
  assert.equal((await fetch(`${APP}/api/projects`, { headers: { authorization: `Bearer ${g}` } })).status, 200);
});

test("revocation between authorization and commit: write publishes nothing", async () => {
  const a = await authorize(clientId, { project: PA, access: "write" });
  const t = (await token({ grant_type: "authorization_code", code: a.code, redirect_uri: CB, client_id: clientId, code_verifier: a.verifier, resource: RESOURCE })).body.access_token;
  const conns = (await owner.req("GET", `/api/projects/${PA}/connections`)).body.connections.filter((x) => !x.revoked && x.access === "read+write");
  const before = (await owner.req("GET", `/api/projects/${PA}/artifacts?q=race-doc`)).body.artifacts.length;
  const [w] = await Promise.all([
    call(t, "create_markdown", { title: "race-doc", idempotency_key: key("r") }),
    ...conns.map((c) => owner.req("POST", `/api/projects/${PA}/connections/${c.id}/revoke`, {})),
  ]);
  const after = (await owner.req("GET", `/api/projects/${PA}/artifacts?q=race-doc`)).body.artifacts.length;
  if (w.status === 200 && !w.body.result?.isError) assert.equal(after, before + 1, "committed before revoke");
  else assert.equal(after, before, "revoked write publishes nothing");
  assert.equal((await call(t, "list_projects", {})).status, 401);
});

test("authorization code: 8 concurrent redemptions -> exactly one token (D1 single-use gate)", async () => {
  const a = await authorize(clientId, { project: PA, access: "read" });
  const rs = await Promise.all(Array.from({ length: 8 }, () =>
    token({ grant_type: "authorization_code", code: a.code, redirect_uri: CB, client_id: clientId, code_verifier: a.verifier, resource: RESOURCE })));
  assert.equal(rs.filter((r) => r.status === 200).length, 1, rs.map((r) => r.status).join(","));
  assert.ok(rs.filter((r) => r.status !== 200).every((r) => r.body.error === "invalid_grant"));
});

test("refresh token: concurrent and repeated use -> exactly one rotation", async () => {
  const a = await authorize(clientId, { project: PA, access: "read" });
  const t = (await token({ grant_type: "authorization_code", code: a.code, redirect_uri: CB, client_id: clientId, code_verifier: a.verifier, resource: RESOURCE })).body;
  const rs = await Promise.all(Array.from({ length: 6 }, () => token({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: clientId, resource: RESOURCE })));
  assert.equal(rs.filter((r) => r.status === 200).length, 1, rs.map((r) => r.status).join(","));
  const again = await token({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: clientId, resource: RESOURCE });
  assert.equal(again.status, 400);
});

test("revocation is decided by D1 even while the KV grant still exists", async () => {
  const a = await authorize(clientId, { project: PA, access: "read" });
  const t = (await token({ grant_type: "authorization_code", code: a.code, redirect_uri: CB, client_id: clientId, code_verifier: a.verifier, resource: RESOURCE })).body;
  const conn = (await owner.req("GET", `/api/projects/${PA}/connections`)).body.connections[0];
  // Revoke ONLY in D1 (simulates KV revocation not yet visible / failed); KV grant + tokens untouched.
  execFileSync("wrangler", ["d1", "--config", LOCAL_CONFIG, "execute", "DB", "--local", "--persist-to", s.dir, "--command", `UPDATE oauth_connections SET revoked_at = 1 WHERE id = '${conn.id}'`], { cwd: ROOT, stdio: "ignore" });
  const r = await call(t.access_token, "list_projects", {});
  assert.equal(r.status, 401, "access token rejected by live D1 check");
  const rf = await token({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: clientId, resource: RESOURCE });
  assert.equal(rf.status, 400, "refresh rejected by D1 check in tokenExchangeCallback");
});

test("OAuth host route allow-list: every non-OAuth path and method is 404/405, never the owner app", async () => {
  const paths = ["/", "/index.html", "/app.js", "/app.css", "/api", "/api/me", "/api/logout", "/api/projects", `/api/projects/${PA}/artifacts`,
    `/api/projects/${PA}/grants`, `/api/projects/${PA}/connections`, `/api/projects/${PA}/audit`, `/api/projects/${PA}/backup`,
    `/api/projects/${PA}/maintenance/reconcile-uploads`, "/api/restore", "/api/transfers/upl_x", "/auth/dev-login", "/auth/access-login",
    "/.well-known/oauth-protected-resource", "/mcp/../api/projects", "/MCP", "/oauth", "/oauth/other", "/callback/x", "/authorize/x", "/favicon.ico"];
  for (const p of paths) for (const m of ["GET", "POST"]) {
    const r = await fetch(MCP + p, { method: m, headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf, "content-type": "application/json" }, body: m === "POST" ? "{}" : undefined });
    const body = await r.text();
    assert.ok([404, 405].includes(r.status) || (p === "/mcp/../api/projects" && r.status === 401), `${m} ${p} -> ${r.status}`);
    assert.doesNotMatch(body, /Agent Library<\/title>|projects":\[|"grants"|"token":"alt_/, `${m} ${p} leaked owner content`);
  }
});

test("registration policy: non-ChatGPT/non-loopback redirect URIs refused", async () => {
  const r = await fetch(`${MCP}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "evil", redirect_uris: ["https://evil.example/cb"], token_endpoint_auth_method: "none" }) });
  assert.equal(r.status, 400);
  const ok = await fetch(`${MCP}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"], token_endpoint_auth_method: "none" }) });
  assert.equal(ok.status, 201);
});

// ---------- Cursor / Grok Bot and Claude client registration ----------
// Exact Cursor/Grok Bot DCR redirect_uris as published by Cursor staff (forum.cursor.com/t/171877) and
// cursor.com/docs/context/mcp. Grok Bot desktop authorizes with the loopback entry.
const CURSOR_URIS = ["cursor://anysphere.cursor-mcp/oauth/callback", "https://www.cursor.com/agents/mcp/oauth/callback", "http://localhost:8787/callback"];
const reg = (body) => fetch(`${MCP}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const authUrl = (clientId, redirect, extra = {}) => `${MCP}/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect, scope: "agentlib:read", state: "s1", resource: RESOURCE, code_challenge: s256(b64u(randomBytes(48))), code_challenge_method: "S256", ...extra })}`;

test("Cursor/Grok Bot: exact DCR request registers; only https + loopback entries can receive codes", async () => {
  const r = await reg({ client_name: "Grok Bot", redirect_uris: CURSOR_URIS, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
  assert.equal(r.status, 201, await r.clone().text());
  const c = await r.json();
  assert.deepEqual(c.redirect_uris, CURSOR_URIS);
  // The custom scheme is listed but can never be used to receive a code (local error, no redirect)
  const cs = await fetch(authUrl(c.client_id, CURSOR_URIS[0]), { redirect: "manual" });
  assert.ok(cs.status >= 400 && !cs.headers.get("location"), `cursor:// at authorize -> ${cs.status}`);
  // Hosted web callback and desktop loopback (any port, RFC 8252) reach the consent page
  for (const u of [CURSOR_URIS[1], CURSOR_URIS[2], "http://localhost:51234/callback"]) {
    const a = await fetch(authUrl(c.client_id, u), { redirect: "manual" });
    assert.equal(a.status, 200, u);
    assert.match(await a.text(), /Connect an app to Agent Library/);
  }
});

test("Grok Bot desktop: full authorization on the loopback callback; tokens work; PKCE and redirect binding enforced", async () => {
  const c = await (await reg({ client_name: "Grok Bot", redirect_uris: CURSOR_URIS, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] })).json();
  const redirect = "http://localhost:8787/callback";
  const a = await authorize(c.client_id, { project: PA, access: "read", redirect });
  assert.equal(`${a.loc.origin}${a.loc.pathname}`, redirect);
  assert.equal(a.state, a.loc.searchParams.get("state")); assert.equal(a.iss, MCP);
  // redirect substitution at the token endpoint (other registered URI) -> refused
  const sub = await token({ grant_type: "authorization_code", code: a.code, redirect_uri: CURSOR_URIS[1], client_id: c.client_id, code_verifier: a.verifier, resource: RESOURCE });
  assert.equal(sub.status, 400);
  // that attempt consumed the code (D1 single-use gate): even the correct request now fails
  const again = await token({ grant_type: "authorization_code", code: a.code, redirect_uri: redirect, client_id: c.client_id, code_verifier: a.verifier, resource: RESOURCE });
  assert.equal(again.status, 400);
  const b = await authorize(c.client_id, { project: PA, access: "read", redirect });
  const wrongPkce = await token({ grant_type: "authorization_code", code: b.code, redirect_uri: redirect, client_id: c.client_id, code_verifier: b64u(randomBytes(48)), resource: RESOURCE });
  assert.equal(wrongPkce.status, 400, "wrong PKCE verifier refused");
  const d = await authorize(c.client_id, { project: PA, access: "read", redirect });
  const ok = await token({ grant_type: "authorization_code", code: d.code, redirect_uri: redirect, client_id: c.client_id, code_verifier: d.verifier, resource: RESOURCE });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.resource, RESOURCE);
  const lp = await call(ok.body.access_token, "list_projects", {});
  assert.deepEqual(lp.body.result.structuredContent.projects.map((p) => p.id), [PA]);
  assert.equal((await call(ok.body.access_token, "create_markdown", { title: "x", idempotency_key: key("g") })).status, 403, "read-only consent: no write");
});

test("authorize: missing PKCE, plain PKCE and redirect substitution are refused for Cursor/Grok clients", async () => {
  const c = await (await reg({ client_name: "Grok Bot", redirect_uris: CURSOR_URIS, token_endpoint_auth_method: "none" })).json();
  const base = { response_type: "code", client_id: c.client_id, scope: "agentlib:read", state: "s", resource: RESOURCE };
  const noPkce = await fetch(`${MCP}/authorize?${new URLSearchParams({ ...base, redirect_uri: CURSOR_URIS[2] })}`, { redirect: "manual" });
  assert.notEqual(noPkce.status, 200);
  const plain = await fetch(`${MCP}/authorize?${new URLSearchParams({ ...base, redirect_uri: CURSOR_URIS[2], code_challenge: "x".repeat(43), code_challenge_method: "plain" })}`, { redirect: "manual" });
  assert.notEqual(plain.status, 200);
  for (const u of ["https://www.cursor.com/agents/mcp/oauth/callback/x", "https://cursor.com/agents/mcp/oauth/callback", "https://www.cursor.com/bot/mcp/oauth/callback",
    "https://claude.ai/api/mcp/auth_callback", "https://chatgpt.com/connector_platform_oauth_redirect", "http://localhost:8787/other", "http://127.0.0.1:8787/callback"]) {
    const r = await fetch(authUrl(c.client_id, u), { redirect: "manual" });
    assert.ok(r.status >= 400 && !r.headers.get("location"), `${u} must not be usable by this client -> ${r.status}`);
  }
});

test("registration: lookalike hosts, unapproved paths, schemes and client_name spoofing are refused", async () => {
  const bad = [
    ["https://www.cursor.com.evil.example/agents/mcp/oauth/callback"], ["https://evilcursor.com/agents/mcp/oauth/callback"],
    ["https://www.cursor.com/agents/mcp/oauth/callback?x=1"], ["https://www.cursor.com/agents/mcp/oauth/callback/"], ["https://www.cursor.com/bot/mcp/oauth/callback"],
    ["https://www.cursor.com:8443/agents/mcp/oauth/callback"], ["http://www.cursor.com/agents/mcp/oauth/callback"], ["https://cursor.com/agents/mcp/oauth/callback"],
    ["https://claude.ai.evil.example/api/mcp/auth_callback"], ["https://claude.ai/api/mcp/auth_callback/x"], ["https://claude.com/api/mcp/auth_callback"],
    ["cursor://anysphere.cursor-mcp/oauth/callback"], // listed-only entry alone can never sign in
    ["cursor://evil/oauth/callback", "http://localhost:8787/callback"], ["javascript:alert(1)//", "http://localhost:8787/callback"],
    ["http://localhost.evil.example/callback"], ["http://10.0.0.5:8787/callback"], ["http://[::1]:8787/callback"],
  ];
  for (const uris of bad) {
    const r = await reg({ client_name: "Claude", redirect_uris: uris, token_endpoint_auth_method: "none" });
    assert.equal(r.status, 400, JSON.stringify(uris));
  }
  assert.equal((await reg({ client_name: "ChatGPT", redirect_uris: ["https://evil.example/cb"], token_endpoint_auth_method: "none" })).status, 400, "client_name is not identity");
});

test("Claude: hosted callback and Claude Code loopback (localhost + 127.0.0.1, any port) register and reach consent", async () => {
  const hosted = await reg({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
  assert.equal(hosted.status, 201);
  const hc = await hosted.json();
  assert.equal((await fetch(authUrl(hc.client_id, "https://claude.ai/api/mcp/auth_callback"), { redirect: "manual" })).status, 200);
  const code = await reg({ client_name: "Claude Code", redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"], token_endpoint_auth_method: "none" });
  assert.equal(code.status, 201);
  const cc = await code.json();
  for (const u of ["http://localhost:3118/callback", "http://127.0.0.1:61001/callback"]) assert.equal((await fetch(authUrl(cc.client_id, u), { redirect: "manual" })).status, 200, u);
  assert.notEqual((await fetch(authUrl(cc.client_id, "http://localhost:3118/other"), { redirect: "manual" })).status, 200, "path must match");
});

test("token endpoint accepts a chunked body without Content-Length; oversized chunked bodies are refused", async () => {
  const a = await authorize(clientId, { project: PA, access: "read" });
  const body = new URLSearchParams({ grant_type: "authorization_code", code: a.code, redirect_uri: CB, client_id: clientId, code_verifier: a.verifier, resource: RESOURCE }).toString();
  const stream = (s) => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(s)); c.close(); } });
  const r = await fetch(`${MCP}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: stream(body), duplex: "half" });
  assert.equal(r.status, 200, await r.clone().text());
  assert.ok((await r.json()).access_token);
  const big = await fetch(`${MCP}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: stream("x=" + "a".repeat(20000)), duplex: "half" });
  assert.equal(big.status, 413);
  const reg = await fetch(`${MCP}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, duplex: "half",
    body: stream(JSON.stringify({ client_name: "chunked", redirect_uris: ["http://localhost:8787/callback"], token_endpoint_auth_method: "none" })) });
  assert.equal(reg.status, 201, "registration also accepts chunked bodies");
});

const GATEWAY_BAD_CALLBACKS = [
 GATEWAY_CALLBACK+'/', GATEWAY_CALLBACK+'/extra', GATEWAY_CALLBACK+'?x=1', GATEWAY_CALLBACK+'#fragment',
 GATEWAY_CALLBACK.replace('/library','/other'), GATEWAY_CALLBACK.replace('/library','/%6cibrary'),
 GATEWAY_CALLBACK.replace('mcp-gateway','another-gateway'),
 GATEWAY_CALLBACK.replace('example.test','example.other'),
 GATEWAY_CALLBACK.replace('example.test','example.test.evil.example'),
 GATEWAY_CALLBACK.replace('mcp-gateway','*'),
 GATEWAY_CALLBACK.replace('https:','http:'), GATEWAY_CALLBACK.replace('example.test/','example.test:8443/'),
];
test('configured extra callback: only the exact configured callback registers and reaches authorization; two clients remain distinct',async()=>{
 const ids=[];for(const agent of ['chatgpt','muse']){const r=await reg({client_name:'cc-gateway-'+agent+'-library',redirect_uris:[GATEWAY_CALLBACK],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code'],scope:'agentlib:read offline_access'});assert.equal(r.status,201);const c=await r.json();ids.push(c.client_id);assert.equal((await fetch(authUrl(c.client_id,GATEWAY_CALLBACK),{redirect:'manual'})).status,200);
 for(const redirect of GATEWAY_BAD_CALLBACKS){const denied=await fetch(authUrl(c.client_id,redirect),{redirect:'manual'});assert.ok(denied.status>=400,redirect);assert.equal(denied.headers.get('location'),null);}
 }assert.notEqual(ids[0],ids[1]);
 for(const redirect of ['https://chatgpt.com/connector_platform_oauth_redirect','https://claude.ai/api/mcp/auth_callback','https://www.cursor.com/agents/mcp/oauth/callback'])assert.ok((await fetch(authUrl(ids[0],redirect),{redirect:'manual'})).status>=400);
});
test('configured extra callback: registration rejects paths, query, fragment, wildcard, sibling Workers and lookalike hosts',async()=>{
 for(const redirect of GATEWAY_BAD_CALLBACKS)assert.equal((await reg({client_name:'cc-gateway-chatgpt-library',redirect_uris:[redirect],token_endpoint_auth_method:'none'})).status,400,redirect);
 assert.equal((await reg({client_name:'cc-gateway-chatgpt-library',redirect_uris:[GATEWAY_CALLBACK,GATEWAY_BAD_CALLBACKS[0]],token_endpoint_auth_method:'none'})).status,400,'valid entry does not admit an invalid sibling');
});

test("reconnect: earlier access is preselected; replacing revokes the earlier connection (tokens and refresh), a forged replace id is refused", async () => {
  const cid = await register();
  const first = await authorize(cid, { grants: { [PA]: "write", [PB]: "read" } });
  const t1 = await token({ grant_type: "authorization_code", code: first.code, redirect_uri: CB, client_id: cid, code_verifier: first.verifier, resource: RESOURCE });
  assert.equal(t1.status, 200);
  // Second connect from the same app: open the consent page and inspect it.
  const b = browser(), verifier = b64u(randomBytes(48));
  const q = new URLSearchParams({ response_type: "code", client_id: cid, redirect_uri: CB, scope: "agentlib:read agentlib:write offline_access", state: "re1", resource: RESOURCE, code_challenge: s256(verifier), code_challenge_method: "S256" });
  let html = await (await b.go(`${MCP}/authorize?${q}`)).text();
  let r = await b.go(`${MCP}/authorize`, form({ handle: hidden(html, "handle"), step: "signin", decision: "approve" }));
  r = await b.go((await fetch(r.headers.get("location"), { redirect: "manual" })).headers.get("location"));
  html = await r.text();
  assert.match(html, /Welcome back/);
  assert.match(html, new RegExp(`name="access:${PA}" value="write" checked`));
  assert.match(html, new RegExp(`name="access:${PB}" value="read" checked`));
  const replaceId = (html.match(/name="replace" value="([^"]+)" checked/) ?? [])[1];
  assert.match(replaceId ?? "", /^oac_/, "replace offered and on by default");
  const handle = hidden(html, "handle");
  r = await b.go(`${MCP}/authorize`, form({ handle, step: "grant", decision: "approve", [`access:${PA}`]: "read", replace: "oac_forgedforgedforged" }));
  assert.equal(r.status, 400, "only the offered connection can be replaced");
  r = await b.go(`${MCP}/authorize`, form({ handle, step: "grant", decision: "approve", [`access:${PA}`]: "read", replace: replaceId }));
  const loc = await clientTarget(r);
  const t2 = await token({ grant_type: "authorization_code", code: loc.searchParams.get("code"), redirect_uri: CB, client_id: cid, code_verifier: verifier, resource: RESOURCE });
  assert.equal(t2.status, 200);
  assert.equal((await call(t1.body.access_token, "list_projects", {})).status, 401, "replaced connection's access token stops working");
  assert.equal((await token({ grant_type: "refresh_token", refresh_token: t1.body.refresh_token, client_id: cid })).body.error, "invalid_grant", "and its refresh token");
  const lp = (await call(t2.body.access_token, "list_projects", {})).body.result.structuredContent.projects;
  assert.deepEqual(lp.map((p) => [p.id, p.can_write]), [[PA, false]]);
  const conns = (await owner.req("GET", "/api/access")).body.connections.filter((c) => c.client_id === cid);
  assert.deepEqual(conns.map((c) => c.status).sort(), ["active", "revoked"], "exactly one live connection for the app");
  // The replacement is audited in every project the old connection covered (PA and PB), not only its first.
  const audited = JSON.parse(execFileSync("wrangler", ["d1", "--config", LOCAL_CONFIG, "execute", "DB", "--local", "--persist-to", s.dir, "--json", "--command", `SELECT project_id FROM audits WHERE action = 'oauth.revoke' AND object_id = '${replaceId}' AND result = 'ok:replaced'`], { cwd: ROOT, env: { ...process.env, CI: "1", NO_COLOR: "1" } }).toString())[0].results.map((r) => r.project_id).sort();
  assert.deepEqual(audited, [PA, PB].sort());
});

test("reconnect is matched by exact client only: a look-alike registration (same name and callback) inherits nothing", async () => {
  const real = await register();
  const a = await authorize(real, { grants: { [PA]: "write" } });
  assert.equal((await token({ grant_type: "authorization_code", code: a.code, redirect_uri: CB, client_id: real, code_verifier: a.verifier, resource: RESOURCE })).status, 200);
  const spoof = await register(); // same client_name ("ChatGPT test") and same loopback callback, different client_id
  assert.notEqual(spoof, real);
  const b = browser();
  const q = new URLSearchParams({ response_type: "code", client_id: spoof, redirect_uri: CB, scope: "agentlib:read agentlib:write offline_access", state: "sp1", resource: RESOURCE, code_challenge: s256(b64u(randomBytes(48))), code_challenge_method: "S256" });
  let r = await b.go(`${MCP}/authorize?${q}`);
  r = await b.go(`${MCP}/authorize`, form({ handle: hidden(await r.text(), "handle"), step: "signin", decision: "approve" }));
  const html = await (await b.go((await fetch(r.headers.get("location"), { redirect: "manual" })).headers.get("location"))).text();
  assert.doesNotMatch(html, /Welcome back/);
  assert.doesNotMatch(html, /name="replace"/, "no replacement of another client's connection is offered");
  assert.match(html, new RegExp(`name="access:${PA}" value="none" checked`), "no access prefilled");
  const r2 = await b.go(`${MCP}/authorize`, form({ handle: hidden(html, "handle"), step: "grant", decision: "approve", [`access:${PB}`]: "read", replace: (await owner.req("GET", "/api/access")).body.connections.find((c) => c.client_id === real && c.status === "active").id }));
  assert.equal(r2.status, 400, "a replace id that was not offered is refused");
});

test("reconnect race: two open consent pages replace the same connection -> the second is refused, exactly one live successor", async () => {
  const cid = await register();
  const first = await authorize(cid, { grants: { [PA]: "read" } });
  assert.equal((await token({ grant_type: "authorization_code", code: first.code, redirect_uri: CB, client_id: cid, code_verifier: first.verifier, resource: RESOURCE })).status, 200);
  // Open two reconnect consent pages (two tabs) before submitting either.
  const open = async () => {
    const b = browser(), verifier = b64u(randomBytes(48));
    const q = new URLSearchParams({ response_type: "code", client_id: cid, redirect_uri: CB, scope: "agentlib:read offline_access", state: "rc" + randomBytes(3).toString("hex"), resource: RESOURCE, code_challenge: s256(verifier), code_challenge_method: "S256" });
    let r = await b.go(`${MCP}/authorize?${q}`);
    r = await b.go(`${MCP}/authorize`, form({ handle: hidden(await r.text(), "handle"), step: "signin", decision: "approve" }));
    const html = await (await b.go((await fetch(r.headers.get("location"), { redirect: "manual" })).headers.get("location"))).text();
    return { b, handle: hidden(html, "handle"), replace: (html.match(/name="replace" value="([^"]+)"/) ?? [])[1] };
  };
  const [t1, t2] = [await open(), await open()];
  assert.ok(t1.replace && t1.replace === t2.replace, "both pages offer the same predecessor");
  const submit = (t) => t.b.go(`${MCP}/authorize`, form({ handle: t.handle, step: "grant", decision: "approve", [`access:${PA}`]: "read", replace: t.replace }));
  const results = await Promise.all([submit(t1), submit(t2)]);
  const ok = results.filter((r) => r.status === 200), refused = results.filter((r) => r.status === 400);
  assert.equal(ok.length, 1, "one tab connects"); assert.equal(refused.length, 1, "the other is refused");
  assert.match(await refused[0].text(), /already replaced|just replaced/);
  const live = (await owner.req("GET", "/api/access")).body.connections.filter((c) => c.client_id === cid && c.status === "active");
  assert.equal(live.length, 1, "exactly one live connection for the app");
  // Only the winning tab audits the replacement: one "replaced" row (the old connection covered one project).
  const rows = JSON.parse(execFileSync("wrangler", ["d1", "--config", LOCAL_CONFIG, "execute", "DB", "--local", "--persist-to", s.dir, "--json", "--command", `SELECT request_id FROM audits WHERE action = 'oauth.revoke' AND object_id = '${t1.replace}' AND result = 'ok:replaced'`], { cwd: ROOT, env: { ...process.env, CI: "1", NO_COLOR: "1" } }).toString())[0].results;
  assert.equal(rows.length, 1, "the losing tab writes no replaced audit row");
});

test("full dispatcher: a partial D1 outage after the refresh claim remains retryable", async () => {
  const a = await authorize(clientId, { project: PA, access: "read" });
  const issued = await token({ grant_type: "authorization_code", code: a.code, redirect_uri: CB, client_id: clientId, code_verifier: a.verifier, resource: RESOURCE });
  assert.equal(issued.status, 200);
  const execute = (sql) => execFileSync("wrangler", ["d1", "--config", LOCAL_CONFIG, "execute", "DB", "--local", "--persist-to", s.dir, "--command", sql], { cwd: ROOT, stdio: "ignore" });
  execute("CREATE TRIGGER synthetic_renewal_outage BEFORE UPDATE ON oauth_connections BEGIN SELECT RAISE(ABORT,'synthetic storage outage'); END");
  const params = { grant_type: "refresh_token", refresh_token: issued.body.refresh_token, client_id: clientId, resource: RESOURCE };
  try {
    const failed = await token(params); assert.equal(failed.status, 503); assert.equal(failed.body.error, "temporarily_unavailable");
  } finally { execute("DROP TRIGGER synthetic_renewal_outage"); }
  const cooling = await token(params); assert.equal(cooling.status, 503, "claim cooldown is retryable, never invalid_grant");
  // Synthetic passage of the five-minute claim cooldown, with the original token unchanged.
  execute("UPDATE oauth_code_redemptions SET redeemed_at = redeemed_at - 300001");
  const recovered = await token(params); assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  assert.equal((await call(recovered.body.access_token, "list_projects", {})).status, 200);
});
