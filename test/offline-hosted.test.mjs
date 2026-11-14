// Installed app on a hosted installation (docs/offline.md): OpenID Connect sign-in at /auth/signin (stand-in provider on
// loopback), several hosts (app, MCP, user content), a cached shell, real Chrome on a non-loopback hostname. The only
// "sign-in required" signal is a 401, which leads to the sign-in screen and /auth/signin; an unreachable library
// shows saved copies. The service worker answers project addresses (/<workspace>/<project>) but never sign-in pages,
// invitations or installation routes, and the content and MCP hosts never serve the shell or the worker.
// Synthetic data only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { generateKeyPairSync, createSign, randomBytes } from "node:crypto";
import { startServer } from "./helpers.mjs";
import { SERVER_PORTS, AUX_PORTS, OIDC_OFFSET } from "./ports.mjs";

const require = createRequire(import.meta.url);
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PUPPETEER = `${process.env.HOME}/.npm-packages/lib/node_modules/puppeteer`;
const haveChrome = existsSync(CHROME) && existsSync(PUPPETEER);
const skip = !haveChrome && "Chrome not installed";
const WORKER = SERVER_PORTS["offline-hosted"], PROXY = AUX_PORTS.offlineHostedProxy, IDP_PORT = WORKER + OIDC_OFFSET;
const HOST = `library.test:${PROXY}`, APP = `http://${HOST}`, MCP_HOST = `mcp.library.test:${PROXY}`, CONTENT_HOST = `content.library.test:${PROXY}`;
const IDP = `http://127.0.0.1:${IDP_PORT}`, CLIENT = "offlineapp", SECRET = "synth-" + randomBytes(10).toString("hex");
const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const b64u = (b) => Buffer.from(b).toString("base64url");
const s256 = (v) => require("node:crypto").createHash("sha256").update(v).digest("base64url");
const idToken = (claims) => {
  const h = b64u(JSON.stringify({ alg: "ES256", kid: "ec1", typ: "JWT" })) + "." + b64u(JSON.stringify(claims));
  return h + "." + createSign("SHA256").update(h).sign({ key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
};
// up: normal. stall: /api/ and /auth/ requests are accepted and never answered (a dead link that still reports a connection).
const net = { mode: "up", sockets: new Set(), navHits: 0 };
let idp, proxy, srv, browser, page, projectPath, docId;
const codes = new Map();
const errors = [];

function startIdp() {
  return createServer(async (req, res) => {
    const u = new URL(req.url, IDP);
    const send = (st, b) => { res.writeHead(st, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    if (u.pathname === "/jwks") return send(200, { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "ec1", alg: "ES256", use: "sig" }] });
    if (u.pathname === "/authorize") {
      const q = Object.fromEntries(u.searchParams);
      const code = "c" + randomBytes(12).toString("hex");
      codes.set(code, q);
      res.writeHead(302, { location: `${q.redirect_uri}?code=${code}&state=${encodeURIComponent(q.state)}` }); return res.end();
    }
    if (u.pathname === "/token" && req.method === "POST") {
      let body = ""; for await (const c of req) body += c;
      const p = Object.fromEntries(new URLSearchParams(body));
      const c = codes.get(p.code); codes.delete(p.code);
      if (!c || s256(p.code_verifier ?? "") !== c.code_challenge) return send(400, { error: "invalid_grant" });
      const now = Math.floor(Date.now() / 1000);
      return send(200, { access_token: "synthetic", id_token: idToken({ iss: IDP, aud: CLIENT, iat: now, exp: now + 300, nonce: c.nonce, sub: "u-offline", email: "offline@example.test", email_verified: true }) });
    }
    send(404, {});
  }).listen(IDP_PORT, "127.0.0.1");
}
function startProxy() {
  return createServer((req, res) => {
    const path = new URL(req.url, APP).pathname;
    if (req.headers["sec-fetch-mode"] === "navigate") net.navHits++;
    if (net.mode === "stall" && (path.startsWith("/api/") || path.startsWith("/auth/"))) { net.sockets.add(req.socket); req.socket.on("close", () => net.sockets.delete(req.socket)); return; }
    const up = httpRequest({ host: "127.0.0.1", port: WORKER, method: req.method, path: req.url, headers: { ...req.headers, host: /^127\.0\.0\.1:/.test(req.headers.host ?? "") ? HOST : req.headers.host } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  }).listen(PROXY, "127.0.0.1");
}
const reset = async () => { net.mode = "up"; for (const s of net.sockets) s.destroy(); net.sockets.clear(); await page.setOfflineMode(false).catch(() => {}); };
// A request straight to the Worker as another host (the proxy forwards the Host header; this skips the browser).
const asHost = (host, path) => new Promise((resolve, reject) => {
  const q = httpRequest({ host: "127.0.0.1", port: WORKER, path, headers: { host } }, (r) => {
    const chunks = []; r.on("data", (c) => chunks.push(c));
    r.on("end", () => { const body = Buffer.concat(chunks).toString(); resolve({ status: r.statusCode, headers: { get: (k) => r.headers[k.toLowerCase()] ?? null }, text: async () => body, json: async () => JSON.parse(body) }); });
  });
  q.on("error", reject); q.end();
});
const text = () => page.evaluate(() => document.body.innerText);
const live = () => page.waitForFunction(() => document.querySelectorAll("#nav a").length >= 4, { timeout: 20000 });
// Signs in through the real flow: the app's sign-in screen, /auth/signin, the stand-in provider, /auth/callback.
async function signIn() {
  await page.goto("about:blank");
  await page.goto(APP + "/#/");
  await page.waitForFunction(() => /Sign in to Agent Library/.test(document.body.innerText), { timeout: 15000 });
  await Promise.all([page.waitForNavigation(), page.evaluate(() => [...document.querySelectorAll("a")].find((a) => /Continue to sign in/.test(a.textContent)).click())]);
  await live();
}
const launch = async (url = APP + "/?source=pwa") => { await page.goto("about:blank"); return page.goto(url); };
const tap = (label) => page.evaluate((label) => { const a = [...document.querySelectorAll("a,button")].find((x) => x.textContent.trim() === label); if (a) a.click(); return !!a; }, label);

before(async () => {
  idp = startIdp();
  proxy = startProxy(); // the app host is reached through it (the Worker answers by Host)
  srv = await startServer("offline-hosted", WORKER, { readyBase: `http://127.0.0.1:${PROXY}`, vars: {
    APP_HOST: HOST, MCP_HOST, CONTENT_HOST,
    OIDC_ISSUER: IDP, OIDC_CLIENT_ID: CLIENT, OIDC_CLIENT_SECRET: SECRET, OIDC_AUTHORIZATION_URL: `${IDP}/authorize`, OIDC_TOKEN_URL: `${IDP}/token`, OIDC_JWKS_URL: `${IDP}/jwks`,
    SIGNUP_ALLOWLIST: "@example.test", RATE_READS_PER_MIN: "100000", RATE_WRITES_PER_MIN: "100000", RATE_AUTHFAIL_PER_MIN: "100000", RATE_SIGNIN_PER_MIN: "1000",
    PRIVACY_URL: "/privacy", TERMS_URL: "javascript:alert(1)" } });
  if (!haveChrome) return;
  browser = await require(PUPPETEER).launch({ executablePath: CHROME, headless: true, protocolTimeout: 20000,
    // Treat the plain-HTTP test host as secure so the service worker runs, as it does on https in production.
    args: ["--no-first-run", `--host-resolver-rules=MAP *.library.test 127.0.0.1, MAP library.test 127.0.0.1`, `--unsafely-treat-insecure-origin-as-secure=${APP}`] });
  page = await browser.newPage();
  await page.setViewport({ width: 412, height: 900, isMobile: true, hasTouch: true });
  page.on("pageerror", (e) => errors.push(e.message.slice(0, 100)));
  await signIn();
  const made = await page.evaluate(async () => {
    const csrf = (await (await fetch("/api/me")).json()).csrf;
    const post = (u, b) => fetch(u, { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf, "idempotency-key": "k" + Math.random() }, body: JSON.stringify(b) }).then((r) => r.json());
    const p = await post("/api/projects", { title: "Trip notes" });
    const d = await post("/api/projects/" + p.id + "/artifacts", { title: "Packing list", body: "# Packing\n\nPassport and charger.\n" });
    const list = (await (await fetch("/api/projects")).json()).projects;
    return { aid: d.artifact_id, path: list.find((x) => x.id === p.id).path, pid: p.id };
  });
  docId = made.aid; projectPath = made.path;
  assert.match(projectPath, /^[a-z0-9-]+\/trip-notes$/);
  // The app registers its worker on https and loopback; this plain-HTTP test host registers it as production would.
  await page.evaluate(async () => { await navigator.serviceWorker.register("/sw.js", { scope: "/" }); await navigator.serviceWorker.ready; });
  await page.goto(APP + `/#/p/${made.pid}/a/${docId}`);
  await page.waitForFunction(() => /Passport and charger/.test(document.body.innerText));
  await page.click('button[aria-label="Make available offline"]');
  await page.waitForFunction(() => /Available offline/.test(document.body.innerText));
});
after(async () => { await reset().catch(() => {}); await browser?.close(); proxy?.close(); idp?.close(); await srv?.stop(); });

test("content and MCP hosts never serve the shell, the worker or the shell version", async () => {
  const own = await asHost(HOST, "/shell-version");
  assert.equal(own.status, 200);
  assert.match((await own.json()).version, /^[0-9a-z]+$/);
  for (const host of [CONTENT_HOST, MCP_HOST]) for (const path of ["/sw.js", "/shell-version", "/app.js", "/app.css", "/", "/manifest.webmanifest"]) {
    const r = await asHost(host, path);
    assert.notEqual(r.status, 200, `${host}${path}`);
    assert.equal(r.headers.get("x-shell-version"), null, `${host}${path} carries no shell version`);
    assert.notEqual(r.headers.get("service-worker-allowed"), "/", `${host}${path} is no service worker`);
  }
});

test("the shell keeps its Content-Security-Policy and carries one version; the worker stays on its own origin", async () => {
  const page1 = await asHost(HOST, "/");
  const csp = page1.headers.get("content-security-policy");
  assert.match(csp, /script-src 'self'(;|$)/, "scripts stay same-origin only");
  assert.doesNotMatch(csp, /unsafe-/);
  assert.ok(csp.includes(`frame-src 'self' https://${CONTENT_HOST}`), "the content host is the only extra frame source");
  const v = (await (await asHost(HOST, "/shell-version")).json()).version;
  for (const path of ["/", "/app.js", "/app.css", "/manifest.webmanifest", "/icons/app-icon-192.png", "/icons/app-apple-180.png"])
    assert.equal((await asHost(HOST, path)).headers.get("x-shell-version"), v, path);
  assert.equal((await asHost(HOST, "/sw.js")).headers.get("x-shell-version"), null);
  const sw = await (await asHost(HOST, "/sw.js")).text();
  assert.match(sw, /u\.origin !== location\.origin\) return;/, "other origins (content host, MCP host) are never intercepted");
  assert.match(sw, /var SHELL = "al-shell-v3"/);
});

test("signed in: the shell is cached, and a project address opens from the cache", { skip }, async () => {
  const res = await launch(`${APP}/${projectPath}`);
  assert.equal(res.fromServiceWorker(), true, "a project address is answered by the cached shell");
  await live();
  assert.equal(await page.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith("al-shell")).join()), "al-shell-v3");
});

test("sign-in pages, invitations and installation routes are never answered by the worker", { skip }, async () => {
  for (const path of ["/invite/inv_" + "a".repeat(24), "/billing/plans", "/auth/check-email", "/about/team"]) {
    const res = await launch(APP + path);
    assert.equal(res.fromServiceWorker(), false, path);
  }
  // The sign-in flow redirects through the provider and back to the app; its first response came from the network.
  const res = await launch(APP + "/auth/signin?next=" + encodeURIComponent("#/"));
  assert.equal(res.request().redirectChain()[0].response().fromServiceWorker(), false, "/auth/signin goes to the network");
  await live();
});

test("airplane mode: the saved copy opens from the cache, by id and by project address, with no sign-in screen", { skip }, async () => {
  await page.setOfflineMode(true);
  try {
    const t0 = Date.now();
    const res = await launch(APP + "/?source=pwa");
    assert.equal(res.fromServiceWorker(), true);
    await page.waitForFunction(() => /Packing list/.test(document.body.innerText) && /Offline/.test(document.body.innerText), { timeout: 5000 });
    assert.ok(Date.now() - t0 < 3000, "no wait when the browser knows it is offline");
    assert.doesNotMatch(await text(), /Sign in to Agent Library/);
    await launch(`${APP}/${projectPath}/a/${docId}`);
    await page.waitForFunction(() => /Passport and charger/.test(document.body.innerText), { timeout: 5000 });
  } finally { await reset(); }
});

test("a dead link: saved copies open within seconds with no sign-in screen, and Try again reaches the live library", { skip }, async () => {
  net.mode = "stall";
  try {
    const t0 = Date.now();
    await launch(APP + "/?source=pwa");
    await page.waitForFunction(() => /Packing list/.test(document.body.innerText) && /Connecting/.test(document.querySelector(".offline-banner")?.innerText || ""), { timeout: 8000 });
    assert.ok(Date.now() - t0 < 6000);
    assert.doesNotMatch(await text(), /Sign in to Agent Library/);
    net.mode = "up";
    assert.equal(await tap("Try again"), true);
    await live().catch(async (e) => { throw new Error("not live: " + (await text()).slice(0, 300).replace(/\s+/g, " ")); });
    assert.equal(await page.$(".offline-banner"), null);
  } finally { await reset(); }
});

test("session ended while online (a 401): the sign-in screen, not saved copies; signing in returns to the live library", { skip }, async () => {
  await page.deleteCookie({ name: "al_session", url: APP });
  const before = net.navHits;
  const res = await launch(APP + "/?source=pwa");
  assert.equal(res.fromServiceWorker(), true, "the shell came from the cache");
  await page.waitForFunction(() => /Sign in to Agent Library/.test(document.body.innerText), { timeout: 10000 });
  assert.doesNotMatch(await text(), /Saved on this device|Packing list/, "a signed-out device does not open saved copies");
  // The installation's policy links sit under the sign-in card; a value that isn't https or a path is dropped.
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll(".signin-legal a")].map((x) => [x.textContent, x.getAttribute("href")])),
    [["Privacy Policy", "/privacy"]]);
  assert.equal(await page.$(".offline-banner"), null);
  assert.equal(net.navHits, before, "the launch reached the network only for the sign-in check, not as a page load");
  await Promise.all([page.waitForNavigation(), tap("Continue to sign in")]);
  await live();
  assert.equal(await page.evaluate(() => location.pathname + location.search), "/");
});

test("signed out, then the link is slow: the saved copies stay on screen with a sign-in link that reaches the sign-in screen", { skip }, async () => {
  await page.deleteCookie({ name: "al_session", url: APP });
  net.mode = "stall";
  try {
    await launch(APP + "/?source=pwa");
    await page.waitForFunction(() => /Packing list/.test(document.body.innerText) && /Connecting/.test(document.querySelector(".offline-banner")?.innerText || ""), { timeout: 8000 });
    net.mode = "up";
    await tap("Try again");
    // The server answered 401: the copies already on screen stay, with a link to the sign-in screen.
    await page.waitForFunction(() => /Sign in to open the live library/.test(document.body.innerText), { timeout: 20000 });
    assert.match(await text(), /Packing list/);
  } finally { await reset(); }
  await tap("Sign in to open the live library");
  await page.waitForFunction(() => /Sign in to Agent Library/.test(document.body.innerText));
  await Promise.all([page.waitForNavigation(), tap("Continue to sign in")]);
  await live();
});

test("the app threw no errors", { skip }, () => { assert.deepEqual([...new Set(errors)], []); });
