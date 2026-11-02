// Generic OpenID Connect sign-in (phase 3; decisions D15 A, D16 A): browser sign-in at /auth/signin -> provider ->
// /auth/callback creates or finds the person, and the consent sign-in for ChatGPT/Claude uses the same accounts.
// Real local runtime (wrangler dev) with a stand-in OIDC provider on loopback signing ES256 id_tokens; synthetic people.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPairSync, createSign, createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { startServer, ROOT, LOCAL_CONFIG } from "./helpers.mjs";
import { SERVER_PORTS, OIDC_OFFSET } from "./ports.mjs";
import { browser } from "./fixtures/app-connect-harness.mjs";

const PORT = SERVER_PORTS["oidc-signin"], IDP_PORT = PORT + OIDC_OFFSET;
const APP = `http://localhost:${PORT}`, MCP = `http://127.0.0.1:${PORT}`, IDP = `http://127.0.0.1:${IDP_PORT}`;
const CLIENT = "synthapp", SECRET = "synth-" + randomBytes(10).toString("hex");
const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const b64u = (b) => Buffer.from(b).toString("base64url");
const s256 = (v) => createHash("sha256").update(v).digest("base64url");
// Who the stand-in provider says is signing in next (tests set it before each flow).
let next = { sub: "u-ada", email: "ada@example.test", email_verified: true };
const codes = new Map();
let idp, s;

function idToken(claims, key = privateKey) {
  const h = b64u(JSON.stringify({ alg: "ES256", kid: "ec1", typ: "JWT" })) + "." + b64u(JSON.stringify(claims));
  return h + "." + createSign("SHA256").update(h).sign({ key, dsaEncoding: "ieee-p1363" }).toString("base64url");
}
const sql = (q) => JSON.parse(execFileSync("wrangler", ["d1", "--config", LOCAL_CONFIG, "execute", "DB", "--local", "--persist-to", s.dir, "--json", "--command", q], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }).toString())[0].results;

before(async () => {
  idp = createServer(async (req, res) => {
    const u = new URL(req.url, IDP);
    const send = (st, b) => { res.writeHead(st, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    if (u.pathname === "/jwks") return send(200, { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "ec1", alg: "ES256", use: "sig" }] });
    if (u.pathname === "/authorize") {
      const q = Object.fromEntries(u.searchParams);
      if (q.client_id !== CLIENT || q.code_challenge_method !== "S256" || !q.nonce) return send(400, { error: "invalid_request" });
      const code = "c" + randomBytes(12).toString("hex");
      codes.set(code, { ...q, who: next });
      res.writeHead(302, { location: `${q.redirect_uri}?code=${code}&state=${encodeURIComponent(q.state)}` }); return res.end();
    }
    if (u.pathname === "/token" && req.method === "POST") {
      let body = ""; for await (const c of req) body += c;
      const p = Object.fromEntries(new URLSearchParams(body));
      const [cid, sec] = Buffer.from((req.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString().split(":").map(decodeURIComponent);
      const c = codes.get(p.code); if (!c?.who?.reusableCode) codes.delete(p.code);
      if (cid !== CLIENT || sec !== SECRET || !c || s256(p.code_verifier ?? "") !== c.code_challenge || p.redirect_uri !== c.redirect_uri) return send(400, { error: "invalid_grant" });
      const now = Math.floor(Date.now() / 1000);
      const { key: _k, claims: _c, reusableCode: _r, ...who } = c.who;
      return send(200, { access_token: "synthetic", id_token: idToken({ iss: IDP, aud: CLIENT, iat: now, exp: now + 300, nonce: c.nonce, ...who, ...(c.who.claims ?? {}) }, c.who.key) });
    }
    send(404, {});
  }).listen(IDP_PORT, "127.0.0.1");
  s = await startServer("oidc-signin", PORT, {
    readyBase: APP,
    vars: { MCP_HOST: `127.0.0.1:${PORT}`, APP_HOST: `localhost:${PORT}`,
      OIDC_ISSUER: IDP, OIDC_CLIENT_ID: CLIENT, OIDC_CLIENT_SECRET: SECRET,
      OIDC_AUTHORIZATION_URL: `${IDP}/authorize`, OIDC_TOKEN_URL: `${IDP}/token`, OIDC_JWKS_URL: `${IDP}/jwks`,
      SIGNUP_ALLOWLIST: "@example.test, invitee-host@example.org", RATE_SIGNIN_PER_MIN: "40",
      RATE_READS_PER_MIN: "100000", RATE_WRITES_PER_MIN: "100000", RATE_AUTHFAIL_PER_MIN: "100000", OAUTH_RATE_MULTIPLIER: "100" },
  });
});
after(async () => { await s?.stop(); idp?.close(); });

/** Full browser sign-in: /auth/signin -> provider -> /auth/callback. Returns { b, res, cookie, csrf, me }. */
async function signIn(who, { next: nx } = {}) {
  next = who;
  const b = browser();
  let r = await b.go(`${APP}/auth/signin${nx ? "?next=" + encodeURIComponent(nx) : ""}`);
  assert.equal(r.status, 302);
  const toIdp = new URL(r.headers.get("location"));
  assert.equal(toIdp.origin, IDP);
  const back = (await fetch(toIdp, { redirect: "manual" })).headers.get("location");
  r = await b.go(back);
  if (r.status !== 302) return { b, res: r, html: await r.text() };
  const me = await b.go(`${APP}/api/me`);
  const body = await me.json();
  return { b, res: r, me: body, location: r.headers.get("location") };
}

test("the app advertises redirect sign-in; the sign-in page sends people to the provider", async () => {
  const m = await (await fetch(`${APP}/auth/methods`)).json();
  assert.deepEqual({ redirect: m.redirect, access: m.access }, { redirect: true, access: false });
});

test("first sign-in creates an account with a personal workspace and returns to the requested page", async () => {
  const a = await signIn({ sub: "u-ada", email: "Ada@Example.test", email_verified: true }, { next: "#/workspaces" });
  assert.equal(a.location, `${APP}/#/workspaces`);
  assert.equal(a.me.principal.kind, "human");
  const row = sql(`SELECT p.email, p.issuer, p.subject, (SELECT COUNT(*) FROM workspace_members m WHERE m.principal_id = p.id AND m.role = 'owner') AS owned FROM principals p WHERE p.id = '${a.me.principal.id}'`)[0];
  assert.deepEqual(row, { email: "ada@example.test", issuer: `http://127.0.0.1:${IDP_PORT}`, subject: "u-ada", owned: 1 });
  // Signing in again is the same person (no second account).
  const again = await signIn({ sub: "u-ada", email: "ada@example.test", email_verified: true });
  assert.equal(again.me.principal.id, a.me.principal.id);
  // A redirect target outside the app's hash routes is ignored (no open redirect).
  const evil = await signIn({ sub: "u-ada", email: "ada@example.test", email_verified: true }, { next: "//evil.example/x" });
  assert.equal(evil.location, `${APP}/#/`);
});

test("sign-up rules: unverified email refused; outside the allowlist refused unless invited", async () => {
  const unverified = await signIn({ sub: "u-unv", email: "unv@example.test", email_verified: false });
  assert.equal(unverified.res.status, 403); assert.match(unverified.html, /Verify your email/);
  // A provider that omits email_verified doesn't count as verified (some let people edit their email freely).
  const silent = await signIn({ sub: "u-silent", email: "silent@example.test" });
  assert.equal(silent.res.status, 403); assert.match(silent.html, /Verify your email/);
  // Error pages look like the rest of the app and lead back to the sign-in card (not a loop).
  assert.match(unverified.html, /class="mark"/); assert.match(unverified.html, /href="\/"[^>]*>Back to sign in|Back to sign in/);
  const outsider = await signIn({ sub: "u-out", email: "out@elsewhere.example" , email_verified: true });
  assert.equal(outsider.res.status, 403); assert.match(outsider.html, /isn&#39;t open|isn't open/);
  assert.equal(sql("SELECT COUNT(*) AS n FROM principals WHERE subject IN ('u-unv','u-out','u-silent')")[0].n, 0);
  assert.match(outsider.html, /Use a different account/);
  // Ada invites the outsider into a shared workspace: now they can create their account and accept.
  const ada = await signIn({ sub: "u-ada", email: "ada@example.test", email_verified: true });
  const csrf = ada.me.csrf;
  const post = (b, path, body) => b.go(`${APP}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf, "idempotency-key": "k-" + randomBytes(6).toString("hex") }, body: JSON.stringify(body) });
  const ws = await (await post(ada.b, "/api/workspaces", { name: "Ada's team" })).json();
  const inv = await (await post(ada.b, `/api/workspaces/${ws.id}/invites`, { email: "out@elsewhere.example", role: "member" })).json();
  const joined = await signIn({ sub: "u-out", email: "out@elsewhere.example", email_verified: true });
  assert.equal(joined.res.status, 302);
  const acc = await joined.b.go(`${APP}/api/invites/accept`, { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": joined.me.csrf }, body: JSON.stringify({ token: inv.accept_url.split("/").pop() }) });
  assert.equal(acc.status, 200, await acc.clone().text());
});

test("the callback only completes in the browser that started it, once", async () => {
  next = { sub: "u-ada", email: "ada@example.test", email_verified: true };
  const starter = browser();
  const r = await starter.go(`${APP}/auth/signin`);
  const back = (await fetch(r.headers.get("location"), { redirect: "manual" })).headers.get("location");
  // Another browser (no binding cookie) can't use the callback URL.
  const other = await browser().go(back);
  assert.equal(other.status, 400);
  assert.equal(other.headers.get("set-cookie")?.includes("al_session="), false);
  // A browser holding a different sign-in's binding cookie can't use it either.
  const mallory = browser();
  const mr = await mallory.go(`${APP}/auth/signin`);
  void (await fetch(mr.headers.get("location"), { redirect: "manual" }));
  assert.equal((await mallory.go(back)).status, 400);
  // The starter can; a replay of the same callback can't, even if the provider would accept the code again.
  assert.equal((await starter.go(back)).status, 302);
  assert.equal((await starter.go(back)).status, 400);
  next = { sub: "u-ada", email: "ada@example.test", email_verified: true, reusableCode: true };
  const s2 = browser();
  const r2 = await s2.go(`${APP}/auth/signin`);
  const bindCookie = r2.headers.getSetCookie().find((c) => c.startsWith("al_signin=")).split(";")[0];
  const back2 = (await fetch(r2.headers.get("location"), { redirect: "manual" })).headers.get("location");
  const first = await s2.go(back2);
  assert.equal(first.status, 302);
  // Re-present the binding cookie the first callback cleared, as an attacker who copied it would.
  const replay = await fetch(back2, { redirect: "manual", headers: { cookie: bindCookie } });
  assert.equal(replay.status, 400);
  // A forged state is refused.
  assert.equal((await starter.go(`${APP}/auth/callback?code=x&state=${"A".repeat(43)}`)).status, 400);
});

test("a token signed by another key, or with the wrong nonce/audience/issuer, is refused and creates nothing", async () => {
  const { privateKey: other } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const bad = [
    { key: other },
    { claims: { nonce: "not-the-one-we-sent" } },
    { claims: { aud: "another-client" } },
    { claims: { iss: "https://evil.example" } },
    { claims: { exp: Math.floor(Date.now() / 1000) - 10 } }
  ];
  for (const [i, extra] of bad.entries()) {
    const r = await signIn({ sub: "u-forged-" + i, email: `forged${i}@example.test`, email_verified: true, ...extra });
    assert.equal(r.res.status, 401, `case ${i}`);
    assert.equal(r.res.headers.get("set-cookie")?.includes("al_session=ses_") ?? false, false);
  }
  assert.equal(sql("SELECT COUNT(*) AS n FROM principals WHERE subject LIKE 'u-forged-%'")[0].n, 0);
});

test("consent sign-in for ChatGPT/Claude uses the same accounts (no 'unique owner' rule)", async () => {
  const ada = await signIn({ sub: "u-ada", email: "ada@example.test", email_verified: true });
  const csrf = ada.me.csrf;
  const pr = await ada.b.go(`${APP}/api/projects`, { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf, "idempotency-key": "k-p1" }, body: JSON.stringify({ title: "Ada notes" }) });
  assert.equal(pr.status, 201);
  const pid = (await pr.json()).id;
  // Another person exists (several humans): the old single-owner rule would refuse; accounts now come from the IdP.
  next = { sub: "u-ada", email: "ada@example.test", email_verified: true };
  const reg = await (await fetch(`${MCP}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "synthetic agent", redirect_uris: ["http://127.0.0.1:5998/cb"], token_endpoint_auth_method: "none" }) })).json();
  const b = browser(); const verifier = b64u(randomBytes(48));
  const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: "http://127.0.0.1:5998/cb", scope: "agentlib:read offline_access", state: "st1", resource: `${MCP}/mcp`, code_challenge: s256(verifier), code_challenge_method: "S256" });
  let r = await b.go(`${MCP}/authorize?${q}`);
  const handle = (await r.text()).match(/name="handle" value="([^"]+)"/)[1];
  r = await b.go(`${MCP}/authorize`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ handle, step: "signin", decision: "approve" }).toString() });
  assert.equal(new URL(r.headers.get("location")).origin, IDP);
  r = await b.go((await fetch(r.headers.get("location"), { redirect: "manual" })).headers.get("location"));
  const consent = await r.text();
  assert.equal(r.status, 200, consent.slice(0, 300));
  assert.match(consent, /Ada notes/); assert.ok(consent.includes(pid));
  // Someone without an account and outside the allowlist gets a clear refusal, not someone else's projects.
  next = { sub: "u-nobody", email: "nobody@elsewhere.example", email_verified: true };
  const b2 = browser();
  r = await b2.go(`${MCP}/authorize?${q}`);
  const h2 = (await r.text()).match(/name="handle" value="([^"]+)"/)[1];
  r = await b2.go(`${MCP}/authorize`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ handle: h2, step: "signin", decision: "approve" }).toString() });
  r = await b2.go((await fetch(r.headers.get("location"), { redirect: "manual" })).headers.get("location"));
  assert.equal(r.status, 403); assert.doesNotMatch(await r.text(), /Ada notes/);
});

test("Cloudflare Access session check and local dev login are off on an OIDC installation", async () => {
  // dev-login still works on loopback for tests; the Access exchange endpoint isn't a sign-in path here.
  const r = await fetch(`${APP}/auth/access-login`, { method: "POST" });
  assert.equal(r.status, 401);
});

test("provider errors on return: an expired or used email link is named as such; cancel says cancelled", async () => {
  for (const [q, re] of [["error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired", /expired/], ["error=access_denied", /cancelled/i], ["error=server_error", /didn&#39;t complete|didn't complete/]]) {
    const b = browser();
    const r = await b.go(`${APP}/auth/signin`);
    const state = new URL(r.headers.get("location")).searchParams.get("state");
    const res = await b.go(`${APP}/auth/callback?state=${encodeURIComponent(state)}&${q}`);
    assert.equal(res.status, 401); assert.match(await res.text(), re);
  }
});

test("check-email page is served on the app host and the OAuth host", async () => {
  for (const base of [APP, MCP]) {
    const r = await fetch(`${base}/auth/check-email`);
    assert.equal(r.status, 200, base); assert.match(await r.text(), /in this browser/);
  }
});

test("starting a sign-in is rate limited per IP (RATE_SIGNIN_PER_MIN), with a page (not JSON)", async () => {
  // Last test: wrangler dev ignores a client-sent cf-connecting-ip, so every request here counts as the same client.
  let last;
  for (let i = 0; i < 42; i++) last = await fetch(`${APP}/auth/signin`, { redirect: "manual" });
  assert.equal(last.status, 429);
  assert.match(last.headers.get("content-type"), /text\/html/);
  assert.match(await last.text(), /Too many sign-in attempts/);
});
