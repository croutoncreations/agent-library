// Real-browser OAuth consent flow (CSP enforced): clicks "Continue to sign in" and "Allow" in Chrome and
// follows the cross-origin redirects (upstream IdP, then client callback). Regression for the CSP
// form-action bug where Chrome silently blocked the redirect after the form POST.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { generateKeyPairSync, createSign, createHash, randomBytes } from "node:crypto";
import { startServer } from "./helpers.mjs";
import { SERVER_PORTS, AUX_PORTS } from "./ports.mjs";

const require = createRequire(import.meta.url);
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PUPPETEER = `${process.env.HOME}/.npm-packages/lib/node_modules/puppeteer`;
const available = existsSync(CHROME) && existsSync(PUPPETEER);

const OIDC_PORT = AUX_PORTS.oauthBrowserOidc, PORT = SERVER_PORTS["oauth-browser"], CB_PORT = AUX_PORTS.oauthBrowserCallback;
const MCP = `http://127.0.0.1:${PORT}`, APP = `http://localhost:${PORT}`, RESOURCE = `${MCP}/mcp`;
const UP_CLIENT = "browserclient1", UP_SECRET = "s-" + randomBytes(8).toString("hex");
const ISS = "https://test-team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/" + UP_CLIENT;
const OWNER = "owner@example.invalid";
const CB = `http://127.0.0.1:${CB_PORT}/cb`;
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const b64u = (b) => Buffer.from(b).toString("base64url");
const s256 = (v) => createHash("sha256").update(v).digest("base64url");
const codes = new Map();
let oidc, cbServer, s, owner, browser, received = null;

before(async () => {
  if (!available) return;
  oidc = createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname.endsWith("/jwks")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256" }] })); }
    if (u.pathname.endsWith("/authorization")) {
      const q = Object.fromEntries(u.searchParams);
      if (q.code_challenge_method !== "S256") { res.writeHead(400); return res.end("PKCE required"); }
      const code = "c" + randomBytes(8).toString("hex"); codes.set(code, q);
      res.writeHead(302, { location: `${q.redirect_uri}?code=${code}&state=${encodeURIComponent(q.state)}` }); return res.end();
    }
    if (u.pathname.endsWith("/token")) {
      let body = ""; for await (const c of req) body += c;
      const p = Object.fromEntries(new URLSearchParams(body)); const q = codes.get(p.code); codes.delete(p.code);
      const [cid, sec] = Buffer.from((req.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString().split(":").map(decodeURIComponent);
      if (!q || cid !== UP_CLIENT || sec !== UP_SECRET || s256(p.code_verifier ?? "") !== q.code_challenge) { res.writeHead(400, { "content-type": "application/json" }); return res.end('{"error":"invalid_grant"}'); }
      const now = Math.floor(Date.now() / 1000);
      const h = b64u(JSON.stringify({ alg: "RS256", kid: "k1" })) + "." + b64u(JSON.stringify({ iss: ISS, aud: UP_CLIENT, sub: "u1", email: OWNER, nonce: q.nonce, iat: now, exp: now + 300 }));
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ id_token: h + "." + createSign("RSA-SHA256").update(h).sign(privateKey).toString("base64url") }));
    }
    res.writeHead(404); res.end();
  }).listen(OIDC_PORT, "127.0.0.1");
  cbServer = createServer((req, res) => {
    const u = new URL(req.url, CB);
    if (u.pathname === "/cb") received = u; // ignore favicon etc.
    res.writeHead(200, { "content-type": "text/html" }); res.end("<h1>client callback</h1>");
  }).listen(CB_PORT, "127.0.0.1");
  s = await startServer("oauth-browser", PORT, {
    vars: { MCP_HOST: `127.0.0.1:${PORT}`, APP_HOST: `localhost:${PORT}`, ACCESS_OIDC_ISSUER: ISS, ACCESS_OIDC_CLIENT_ID: UP_CLIENT, ACCESS_OIDC_CLIENT_SECRET: UP_SECRET,
      OWNER_EMAIL: OWNER, OIDC_TEST_ENDPOINT_BASE: `http://127.0.0.1:${OIDC_PORT}`, RATE_READS_PER_MIN: "100000", RATE_WRITES_PER_MIN: "100000", RATE_AUTHFAIL_PER_MIN: "100000", OAUTH_RATE_MULTIPLIER: "100" },
    readyBase: APP,
  });
  owner = await s.loginAt(APP);
  await owner.req("POST", "/api/projects", { id: "proj-browser", title: "Browser project" });
  const puppeteer = require(PUPPETEER);
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-first-run"] });
});
after(async () => { await browser?.close(); await s?.stop(); oidc?.close(); cbServer?.close(); });

// No gateway or other installation-specific callback is trusted unless the operator configures
// OAUTH_EXTRA_REDIRECT_URIS (this server does not; test/oauth-chatgpt.test.mjs covers the configured case).
test("without OAUTH_EXTRA_REDIRECT_URIS, arbitrary https callbacks (e.g. a gateway) cannot register", async () => {
  for (const cb of ["https://mcp-gateway.example.test/upstream/callback/library", "https://some-gateway.example.workers.dev/upstream/callback/library"]) {
    const r = await fetch(`${MCP}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "gateway", redirect_uris: [cb], token_endpoint_auth_method: "none" }) });
    assert.equal(r.status, 400, cb);
  }
});

test("Chrome: Continue to sign in -> upstream -> project consent -> Allow -> client callback with code+state+iss (no CSP block)", { skip: !available && "Chrome/puppeteer not installed" }, async () => {
  const reg = await (await fetch(`${MCP}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Browser client", redirect_uris: [CB], token_endpoint_auth_method: "none" }) })).json();
  const v = b64u(randomBytes(48));
  const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: CB, scope: "agentlib:read", state: "bstate", resource: RESOURCE, code_challenge: s256(v), code_challenge_method: "S256" });
  const page = await browser.newPage();
  const cspViolations = [];
  page.on("console", (m) => { if (/Content Security Policy|form-action/i.test(m.text())) cspViolations.push(m.text()); });
  await page.goto(`${MCP}/authorize?${q}`);
  assert.match(await page.content(), /Connect an app to Agent Library/);
  await Promise.all([page.waitForNavigation({ timeout: 10000 }), page.click('button.primary')]);
  assert.match(await page.content(), /Choose what to share/, "reached project consent after upstream sign-in");
  assert.deepEqual(cspViolations, []);
  // Access is a segmented control (radio inputs under labels); nothing is shared until picked.
  assert.equal(await page.$eval('input[name="access:proj-browser"]:checked', (e) => e.value), "none");
  await page.click('input[name="access:proj-browser"][value="write"]');
  const shown = (sel) => page.$eval(sel, (e) => e.closest(".newp").offsetParent !== null);
  assert.ok(await shown('input[name="new_title"]') && !(await shown('input[name="new_title_2"]')), "one empty new-project row offered");
  await page.type('input[name="new_title"]', "Browser-made project");
  assert.equal(await page.$eval('input[name="new_access"]:checked', (e) => e.value), "read", "new projects default to Read (least privilege)");
  // Regression (design review H1): a filled row never hides, even when an earlier row is cleared.
  await page.type('input[name="new_title_2"]', "Second");
  await page.$eval('input[name="new_title"]', (e) => { e.value = ""; e.dispatchEvent(new Event("input", { bubbles: true })); });
  assert.ok(await shown('input[name="new_title_2"]'), "filled row 2 stays visible after row 1 is cleared");
  await page.$eval('input[name="new_title_2"]', (e) => { e.value = ""; });
  await page.type('input[name="new_title"]', "Browser-made project");
  // Live selection count (CSS counter; generated content, so read it through getComputedStyle).
  assert.equal(await page.$eval(".count .some", (e) => getComputedStyle(e).display), "inline");
  assert.equal(await page.$eval(".count .n", (e) => getComputedStyle(e, "::before").content), "counter(sel)");
  assert.equal(await page.$eval(".count .none", (e) => getComputedStyle(e).display), "none");
  await page.screenshot({ path: "tmp/test-evidence/oauth-consent-multi.png", fullPage: true }); // inspect: footer reads "2 selected"
  // Tab order follows the screen (Cancel, then Connect); the off-screen Enter target is skipped.
  assert.deepEqual(await page.$$eval(".bar button", (bs) => bs.map((b) => b.value)), ["deny", "approve"]);
  assert.equal(await page.$eval("form.grant button", (b) => b.value + ":" + b.tabIndex), "approve:-1", "Enter submits Connect");
  const resp = [];
  page.on("response", (r) => resp.push(`${r.status()} ${r.url().slice(0, 70)} csp=${(r.headers()["content-security-policy"] ?? "").match(/form-action [^;]+/)?.[0] ?? "-"}`));
  // Submit with Enter from the name field: it must connect, not cancel.
  await page.focus('input[name="new_title"]');
  await Promise.all([page.waitForNavigation({ timeout: 10000 }).catch(() => null), page.keyboard.press("Enter")]);
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(received, "client callback reached; responses: " + JSON.stringify(resp) + " csp: " + JSON.stringify(cspViolations) + " url=" + page.url());
  assert.equal(received.searchParams.get("state"), "bstate", received.search.replace(/code=[^&]+/, "code=…"));
  assert.equal(received.searchParams.get("iss"), MCP);
  const code = received.searchParams.get("code");
  assert.ok(code);
  const t = await (await fetch(`${MCP}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: CB, client_id: reg.client_id, code_verifier: v, resource: RESOURCE }) })).json();
  assert.ok(t.access_token, JSON.stringify(t));
  assert.deepEqual(cspViolations, []);
  const lp = await (await fetch(`${MCP}/mcp`, { method: "POST", headers: { authorization: `Bearer ${t.access_token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_projects", arguments: {} } }) })).json();
  assert.deepEqual(lp.result.structuredContent.projects.map((p) => [p.title, p.can_write]).sort(), [["Browser project", true], ["Browser-made project", false]]);
});

test("Chrome: Cancel on first page redirects to the client with access_denied", { skip: !available && "Chrome/puppeteer not installed" }, async () => {
  received = null;
  const reg = await (await fetch(`${MCP}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Browser client", redirect_uris: [CB], token_endpoint_auth_method: "none" }) })).json();
  const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: CB, scope: "agentlib:read", state: "cstate", resource: RESOURCE, code_challenge: s256(b64u(randomBytes(48))), code_challenge_method: "S256" });
  const page = await browser.newPage();
  await page.goto(`${MCP}/authorize?${q}`);
  await page.click('button[value="deny"]');
  for (let i = 0; i < 50 && !received; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(received?.searchParams.get("error"), "access_denied");
  assert.equal(received?.searchParams.get("state"), "cstate");
});

// Regression: Cursor's registered callback (https://www.cursor.com/...) answers with a 308 to another origin
// (https://cursor.com/...). Chrome applies CSP form-action to every hop after the form POST, so a policy
// naming only the registered origin silently blocked "Allow". Simulated with two loopback origins:
// 127.0.0.1:HOP (registered) redirects to localhost:HOP (different origin).
test("Chrome: Allow completes when the client's callback redirects through other origins (Cursor www -> apex -> app)", { skip: !available && "Chrome/puppeteer not installed" }, async () => {
  const HOP = AUX_PORTS.oauthBrowserHop, REG_CB = `http://127.0.0.1:${HOP}/cb`;
  let landed = null;
  const hop = createServer((req, res) => {
    const u = new URL(req.url, `http://${req.headers.host}`);
    // Like Cursor: registered origin -> 308 to another origin -> further redirect within it (origins we never list)
    if (req.headers.host.startsWith("127.0.0.1")) { res.writeHead(308, { location: `http://localhost:${HOP}/hop1${u.search}` }); return res.end(); }
    if (u.pathname === "/hop1") { res.writeHead(302, { location: `http://localhost:${HOP}/cb${u.search}` }); return res.end(); }
    if (u.pathname === "/cb") landed = u;
    res.writeHead(200, { "content-type": "text/html" }); res.end("<h1>landed</h1>");
  }).listen(HOP, "127.0.0.1");
  try {
    const reg = await (await fetch(`${MCP}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Hop client", redirect_uris: [REG_CB], token_endpoint_auth_method: "none" }) })).json();
    const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: REG_CB, scope: "agentlib:read", state: "hstate", resource: RESOURCE, code_challenge: s256(b64u(randomBytes(48))), code_challenge_method: "S256" });
    const page = await browser.newPage();
    const csp = [];
    page.on("console", (m) => { if (/Content Security Policy|form-action/i.test(m.text())) csp.push(m.text()); });
    await page.goto(`${MCP}/authorize?${q}`);
    await Promise.all([page.waitForNavigation({ timeout: 10000 }), page.click('button.primary')]);
    await page.click('input[name="access:proj-browser"][value="read"]');
    await Promise.all([page.waitForNavigation({ timeout: 10000 }).catch(() => null), page.click('button.primary')]);
    for (let i = 0; i < 30 && !landed; i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(landed, `client never received the code; page stuck at ${page.url().replace(/code=[^&]+/, "code=…")}`);
    assert.deepEqual(csp, [], "no CSP violations");
    assert.equal(landed.searchParams.get("state"), "hstate");
    assert.ok(landed.searchParams.get("code"));
    await page.close();
  } finally { hop.close(); }
});
