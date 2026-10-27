// Isolated synthetic App Connect harness (contract app-connect/0.4 §12). Needs NO existing credentials:
// everything (local dev passphrase, stand-in OIDC owner identity + RSA key + client secret, app client,
// publisher tokens) is generated per run, in memory, and only loopback is used. Never reads ~/.pi,
// .dev.vars, Cloudflare credentials or production hosts.
import { createServer } from "node:http";
import { generateKeyPairSync, createSign, createHash, randomBytes } from "node:crypto";
import { startServer } from "../helpers.mjs";
import { OIDC_OFFSET } from "../ports.mjs";

const b64u = (b) => Buffer.from(b).toString("base64url");
const s256 = (v) => createHash("sha256").update(v).digest("base64url");

/** Stand-in Access-for-SaaS OIDC provider (PKCE S256 + client secret required), loopback only. */
function startOidc(port, { clientId, secret, owner }) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const issuer = "https://synthetic.cloudflareaccess.com/cdn-cgi/access/sso/oidc/" + clientId;
  const codes = new Map();
  const idToken = (nonce) => {
    const now = Math.floor(Date.now() / 1000);
    const h = b64u(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" })) + "." + b64u(JSON.stringify({ iss: issuer, aud: clientId, sub: "synthetic-owner", email: owner, iat: now, exp: now + 300, nonce }));
    return h + "." + createSign("RSA-SHA256").update(h).sign(privateKey).toString("base64url");
  };
  const srv = createServer(async (req, res) => {
    const u = new URL(req.url, `http://127.0.0.1:${port}`);
    const send = (s, b, h = {}) => { res.writeHead(s, { "content-type": "application/json", ...h }); res.end(JSON.stringify(b)); };
    if (u.pathname.endsWith("/jwks")) return send(200, { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" }] });
    if (u.pathname.endsWith("/authorization")) {
      const q = Object.fromEntries(u.searchParams);
      if (q.code_challenge_method !== "S256" || q.client_id !== clientId) return send(400, { error: "invalid_request" });
      const code = "c" + randomBytes(12).toString("hex");
      codes.set(code, { challenge: q.code_challenge, nonce: q.nonce, redirect_uri: q.redirect_uri });
      res.writeHead(302, { location: `${q.redirect_uri}?code=${code}&state=${encodeURIComponent(q.state)}` }); return res.end();
    }
    if (u.pathname.endsWith("/token") && req.method === "POST") {
      let body = ""; for await (const c of req) body += c;
      const p = Object.fromEntries(new URLSearchParams(body));
      const [cid, sec] = Buffer.from((req.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString().split(":").map(decodeURIComponent);
      if (cid !== clientId || sec !== secret) return send(401, { error: "invalid_client" });
      const c = codes.get(p.code); codes.delete(p.code);
      if (!c || s256(p.code_verifier ?? "") !== c.challenge || p.redirect_uri !== c.redirect_uri) return send(400, { error: "invalid_grant" });
      return send(200, { access_token: "synthetic", token_type: "Bearer", id_token: idToken(c.nonce) });
    }
    send(404, {});
  }).listen(port, "127.0.0.1");
  return { issuer, close: () => srv.close() };
}

/** Browser-like client: cookie jar per host, no automatic redirects. */
export function browser() {
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
  return { go };
}
const form = (o) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString() });
const hidden = (html, name) => (html.match(new RegExp(`name="${name}" value="([^"]+)"`)) ?? [])[1];
function interstitialTarget(html) {
  const m = html.match(/<meta http-equiv="refresh" content="0;url=([^"]+)">/);
  if (!m) throw new Error("no interstitial redirect");
  return new URL(m[1].replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c))));
}

/**
 * Start an isolated local server with App Connect enabled.
 * port: one of test/ports.mjs SERVER_PORTS; oidcPort: loopback port for the stand-in identity provider (default port + OIDC_OFFSET).
 */
export async function startAppConnectServer({ port, oidcPort = port + OIDC_OFFSET, vars = {}, fresh = true } = {}) {
  const UP_CLIENT = "synthclient" + randomBytes(4).toString("hex");
  const UP_SECRET = "synthsecret-" + randomBytes(12).toString("hex");
  const OWNER = "owner@example.invalid";
  const oidc = startOidc(oidcPort, { clientId: UP_CLIENT, secret: UP_SECRET, owner: OWNER });
  const issuer = `http://127.0.0.1:${port}`, appUi = `http://localhost:${port}`;
  const s = await startServer(`ac-${port}`, port, {
    vars: {
      MCP_HOST: `127.0.0.1:${port}`, APP_HOST: `localhost:${port}`, APP_CONNECT_ENABLED: "1", AC_TEST_HOOKS: "1",
      ACCESS_OIDC_ISSUER: oidc.issuer, ACCESS_OIDC_CLIENT_ID: UP_CLIENT, ACCESS_OIDC_CLIENT_SECRET: UP_SECRET, OWNER_EMAIL: OWNER,
      OIDC_TEST_ENDPOINT_BASE: `http://127.0.0.1:${oidcPort}`,
      RATE_READS_PER_MIN: "100000", RATE_WRITES_PER_MIN: "100000", RATE_AUTHFAIL_PER_MIN: "100000", OAUTH_RATE_MULTIPLIER: "100",
      ...vars,
    },
    readyBase: appUi,
    fresh,
  });
  let ownerSession = null;
  const h = {
    issuer, api: `${issuer}/v1`, appUi, resource: `${issuer}/v1`, dir: s.dir,
    /** Owner session on the owner UI host (local dev login, per-run random passphrase). */
    async owner() { return (ownerSession ??= await s.loginAt(appUi)); },
    /** Register a publisher app (owner action). */
    async registerApp(body) {
      const o = await h.owner();
      const r = await o.req("POST", "/api/app-clients", body);
      if (r.status !== 201) throw new Error(`registerApp ${r.status} ${JSON.stringify(r.body)}`);
      return r.body;
    },
    /**
     * Run the full publisher authorization flow with the owner choosing on the consent page.
     * choice: { project_id, destination: "root" | "new" | "folder:<fld_>", new_folder_name?, resume?: "new" | "<pub_>", decision?: "approve"|"deny" }
     * Returns { code, state, iss, verifier, redirect_uri, consentHtml } or { error, html } (no tokens yet).
     */
    async authorize(app, choice, { redirect_uri = app.redirect_uris[0], scope = "agentlib:publish offline_access", resource = h.resource, extraQuery = {}, stopAtConsent = false } = {}) {
      const b = browser();
      const verifier = b64u(randomBytes(48)), state = "st" + randomBytes(6).toString("hex");
      const q = new URLSearchParams({ response_type: "code", client_id: app.client_id, redirect_uri, scope, state, resource, code_challenge: s256(verifier), code_challenge_method: "S256", ...extraQuery });
      let r = await b.go(`${issuer}/authorize?${q}`);
      let html = await r.text();
      if (r.status !== 200 || !hidden(html, "handle")) return { error: r.status, html };
      r = await b.go(`${issuer}/authorize`, form({ handle: hidden(html, "handle"), step: "signin", decision: "approve" }));
      if (r.status !== 302) return { error: r.status, html: await r.text() };
      const cbUrl = (await fetch(r.headers.get("location"), { redirect: "manual" })).headers.get("location");
      r = await b.go(cbUrl);
      html = await r.text();
      if (r.status !== 200 || !hidden(html, "handle")) return { error: r.status, html };
      const consentHtml = html;
      if (stopAtConsent) return { consentHtml, browser: b };
      const fields = { handle: hidden(html, "handle"), step: "publish", resume: "new", decision: "approve", ...choice };
      r = await b.go(`${issuer}/authorize`, form(fields));
      html = await r.text();
      if (r.status !== 200 || !/http-equiv="refresh"/.test(html)) return { error: r.status, html, consentHtml };
      const loc = interstitialTarget(html);
      return { code: loc.searchParams.get("code"), state: loc.searchParams.get("state"), iss: loc.searchParams.get("iss"),
        error_param: loc.searchParams.get("error"), sentState: state, verifier, redirect_uri, consentHtml };
    },
    /**
     * Connect an ordinary MCP agent (like ChatGPT/Claude) through DCR + owner consent, for reader/protection tests.
     * grants: { [projectId]: "read" | "write" }. Returns { access_token, call(name, args) } (token in memory only).
     */
    async connectMcpAgent(grants, { clientName = "synthetic agent", onConsent, redirect = "http://127.0.0.1:5998/cb" } = {}) {
      // redirect is never contacted: the code is read from the consent interstitial.
      const reg = await fetch(`${issuer}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: clientName, redirect_uris: [redirect], token_endpoint_auth_method: "none" }) }).then((r) => r.json());
      const b = browser();
      const verifier = b64u(randomBytes(48)), state = "st" + randomBytes(6).toString("hex");
      const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: redirect, scope: "agentlib:read agentlib:write offline_access", state, resource: `${issuer}/mcp`, code_challenge: s256(verifier), code_challenge_method: "S256" });
      let r = await b.go(`${issuer}/authorize?${q}`);
      r = await b.go(`${issuer}/authorize`, form({ handle: hidden(await r.text(), "handle"), step: "signin", decision: "approve" }));
      r = await b.go((await fetch(r.headers.get("location"), { redirect: "manual" })).headers.get("location"));
      const per = Object.fromEntries(Object.entries(grants).map(([p, a]) => [`access:${p}`, a]));
      const consentHtml = await r.text();
      await onConsent?.(consentHtml);
      r = await b.go(`${issuer}/authorize`, form({ handle: hidden(consentHtml, "handle"), step: "grant", ...per, decision: "approve" }));
      const code = interstitialTarget(await r.text()).searchParams.get("code");
      const t = await h.token({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: reg.client_id, code_verifier: verifier, resource: `${issuer}/mcp` });
      const at = t.body.access_token;
      let id = 0;
      const call = async (name, args) => {
        const res = await fetch(`${issuer}/mcp`, { method: "POST", headers: { authorization: `Bearer ${at}`, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) });
        const t = await res.text();
        let j = {};
        try { j = JSON.parse(t); } catch {}
        return { status: res.status, isError: res.status >= 400 || (j.result?.isError ?? !!j.error), data: j.result?.structuredContent ?? j.error ?? null };
      };
      const list = async () => (await fetch(`${issuer}/mcp`, { method: "POST", headers: { authorization: `Bearer ${at}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/list" }) }).then((x) => x.json())).result.tools;
      return { access_token: at, call, list };
    },
    async token(params, headers = {}) {
      const r = await fetch(`${issuer}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(params).toString() });
      let body = null; try { body = await r.json(); } catch {}
      return { status: r.status, body, headers: r.headers };
    },
    /** authorize + code exchange. Returns { publisher_id, access_token, refresh_token, iss, state } (tokens in memory only). */
    async connectPublisher(app, choice) {
      const a = await h.authorize(app, choice);
      if (!a.code) throw new Error(`connectPublisher: no code (${a.error ?? a.error_param}) ${(a.html ?? "").replace(/<[^>]+>/g, " ").slice(0, 300)}`);
      const t = await h.token({ grant_type: "authorization_code", code: a.code, redirect_uri: a.redirect_uri, client_id: app.client_id, code_verifier: a.verifier, resource: h.resource });
      if (t.status !== 200) throw new Error(`token ${t.status} ${JSON.stringify(t.body)}`);
      const me = await h.pub(t.body.access_token, "GET", "/publisher/me");
      return { publisher_id: me.json?.publisher_id, access_token: t.body.access_token, refresh_token: t.body.refresh_token, iss: a.iss, state: a.state, sentState: a.sentState, token: t.body };
    },
    /** Call the publisher API. */
    async pub(token, method, path, { body, idem, headers = {} } = {}) {
      const hd = { "user-agent": "app-connect-harness", ...headers };
      if (token) hd.authorization = `Bearer ${token}`;
      if (body !== undefined) hd["content-type"] = "application/json";
      if (idem) hd["idempotency-key"] = idem;
      const r = await fetch(`${h.api}${path}`, { method, headers: hd, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
      const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
      return { status: r.status, headers: r.headers, json, text };
    },
    async stop() { await s.stop(); oidc.close(); },
  };
  return h;
}
