// Hosted sign-in lifetime (build-session-fixes.mjs): real Chrome on a non-loopback hostname, in front of the real
// local Worker through a stand-in for Cloudflare Access. The stand-in signs an owner Access JWT onto every
// request (RS256, local JWKS) or, when "Access has expired", answers API requests that carry
// X-Requested-With with 401 and page loads with its own sign-in page, as Access does. It also strips the
// cookie Secure flag because this test runs on plain HTTP (in production Access/Cloudflare terminates HTTPS).
// Synthetic data only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { generateKeyPairSync, createSign, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { startServer, ROOT, LOCAL_CONFIG } from "./helpers.mjs";
import { SERVER_PORTS, AUX_PORTS } from "./ports.mjs";

const require = createRequire(import.meta.url);
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PUPPETEER = `${process.env.HOME}/.npm-packages/lib/node_modules/puppeteer`;
const haveChrome = existsSync(CHROME) && existsSync(PUPPETEER);
const skip = !haveChrome && "Chrome not installed";

const TEAM = "test-team.cloudflareaccess.com", AUD = "test-aud-" + randomBytes(4).toString("hex"), OWNER = "owner@example.invalid";
const WORKER_PORT = SERVER_PORTS["hosted-session"], JWKS_PORT = AUX_PORTS.hostedSessionJwks, ACCESS_PORT = AUX_PORTS.hostedSessionAccess;
const HOST = "library.test", APP = `http://${HOST}:${ACCESS_PORT}`;
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function jwt(claims) {
  const now = Math.floor(Date.now() / 1000);
  const body = { iss: `https://${TEAM}`, aud: [AUD], iat: now, nbf: now - 5, exp: now + 600, ...claims };
  const head = b64u({ alg: "RS256", kid: "k1", typ: "JWT" }) + "." + b64u(body);
  return head + "." + createSign("RSA-SHA256").update(head).sign(privateKey).toString("base64url");
}

let jwks, access, s, browser, page;
const accessState = { expired: false, sub: "user-owner-1", xhr401: 0, logoutDelayMs: 0 };
const SIGNIN_TITLE = "Stand-in Cloudflare Access sign-in";

function startAccess() {
  return createServer((req, res) => {
    if (accessState.expired) {
      if ((req.headers["x-requested-with"] || "").toLowerCase() === "xmlhttprequest") { accessState.xhr401++; res.writeHead(401); return res.end(); }
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(`<!doctype html><title>${SIGNIN_TITLE}</title><h1>${SIGNIN_TITLE}</h1>`);
    }
    const headers = { ...req.headers, "cf-access-jwt-assertion": jwt({ sub: accessState.sub, email: OWNER }) };
    const delay = req.url === "/api/logout" ? accessState.logoutDelayMs : 0;
    setTimeout(() => forward(req, res, headers), delay);
  }).listen(ACCESS_PORT, "127.0.0.1");
}
function forward(req, res, headers) {
  {
    const up = httpRequest({ host: "127.0.0.1", port: WORKER_PORT, method: req.method, path: req.url, headers }, (r) => {
      const h = { ...r.headers };
      if (h["set-cookie"]) h["set-cookie"] = h["set-cookie"].map((c) => c.replace(/; Secure/i, ""));
      res.writeHead(r.statusCode, h); r.pipe(res);
    });
    up.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  }
}
const d1 = (sql) => JSON.parse(execFileSync("wrangler", ["d1", "--config", LOCAL_CONFIG, "execute", "DB", "--local", "--persist-to", s.dir, "--json", "--command", sql], { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString())[0].results;
const endAppSessions = () => d1("UPDATE sessions SET expires_at = 0");
const liveSessions = () => d1(`SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL AND expires_at > ${Date.now()}`)[0].n;
async function openHome() {
  accessState.expired = false;
  await page.goto("about:blank"); // a hash-only goto would not reload the page
  await page.goto(APP + "/#/");
  await page.waitForSelector("#nav a");
  await page.evaluate(() => { window.__sameDocument = true; });
}

before(async () => {
  jwks = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" }] }));
  }).listen(JWKS_PORT, "127.0.0.1");
  s = await startServer("hosted-session", WORKER_PORT, {
    vars: { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, OWNER_EMAIL: OWNER, ACCESS_CERTS_URL: `http://127.0.0.1:${JWKS_PORT}/certs`,
      RATE_READS_PER_MIN: "100000", RATE_WRITES_PER_MIN: "100000", RATE_AUTHFAIL_PER_MIN: "100000" },
    readyHeaders: { "cf-access-jwt-assertion": "x" },
  });
  access = startAccess();
  if (!haveChrome) return;
  browser = await require(PUPPETEER).launch({ executablePath: CHROME, headless: true,
    args: ["--no-first-run", `--host-resolver-rules=MAP ${HOST} 127.0.0.1`] });
  page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });
});
after(async () => { await browser?.close(); access?.close(); await s?.stop(); jwks?.close(); });

test("server: Access sign-in gives a 30-day app session", async () => {
  const r = await fetch(`http://127.0.0.1:${ACCESS_PORT}/auth/access-login`, { method: "POST", headers: { host: `${HOST}:${ACCESS_PORT}` } });
  assert.equal(r.status, 200, await r.clone().text());
  assert.match(r.headers.get("set-cookie"), /al_session=[^;]+; HttpOnly; SameSite=Strict; Path=\/; Max-Age=2592000/);
  const exp = d1("SELECT MAX(expires_at) AS e FROM sessions")[0].e;
  assert.ok(Math.abs(exp - (Date.now() + 30 * 864e5)) < 120000, "session row expires in 30 days");
});

test("hosted boot signs in through Access, never with the loopback passphrase form", { skip }, async () => {
  await openHome();
  assert.equal(await page.$('input[name="passphrase"]'), null);
});

test("app session ended, Access still signed in: requests renew it in place (no reload, no sign-in screen)", { skip }, async () => {
  await openHome();
  endAppSessions();
  assert.equal(liveSessions(), 0);
  // The projects page renders its New project button before its API read finishes. Wait for the actual renewal,
  // not that optimistic DOM, before asserting the server-side session exists.
  const renewed = page.waitForResponse((r) => new URL(r.url()).pathname === "/auth/access-login" && r.request().method() === "POST" && r.status() === 200);
  await page.evaluate(() => { location.hash = "#/projects"; });
  await renewed;
  await page.waitForFunction(() => /New project/.test(document.body.innerText));
  assert.equal(await page.evaluate(() => window.__sameDocument), true, "same page, not reloaded");
  assert.equal(await page.$('input[name="passphrase"]'), null);
  assert.equal(liveSessions(), 1, "a fresh session was issued");
});

test("a write after the app session ended is renewed and retried once with the new CSRF token", { skip }, async () => {
  await openHome();
  await page.evaluate(() => { location.hash = "#/projects"; });
  await page.waitForFunction(() => /New project/.test(document.body.innerText));
  endAppSessions();
  const before = d1("SELECT COUNT(*) AS n FROM projects")[0].n;
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => /New project/.test(b.textContent)).click());
  await page.type('input[placeholder="Project name"]', "Renewed write");
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent === "Create project").click());
  await page.waitForFunction(() => /Renewed write/.test(document.body.innerText));
  assert.equal(d1("SELECT COUNT(*) AS n FROM projects")[0].n, before + 1, "created exactly once");
  assert.equal(await page.evaluate(() => window.__sameDocument), true);
});

test("Access itself expired: the app reloads into Access sign-in instead of a dead login form", { skip }, async () => {
  await openHome();
  await page.evaluate(() => sessionStorage.removeItem("al:signin-reload"));
  endAppSessions();
  accessState.expired = true; accessState.xhr401 = 0;
  await page.evaluate(() => { location.hash = "#/projects"; });
  await page.waitForFunction((t) => document.title === t, {}, SIGNIN_TITLE);
  assert.ok(accessState.xhr401 >= 1, "API requests got Access's 401, not a redirect");
});

test("a second expiry within a minute shows a hosted Sign in button (no reload loop, no passphrase form)", { skip }, async () => {
  await openHome(); // the reload stamp from the previous test is still recent
  endAppSessions();
  accessState.expired = true;
  await page.evaluate(() => { location.hash = "#/projects"; });
  await page.waitForFunction(() => /Sign in with your Cloudflare Access account/.test(document.body.innerText));
  assert.equal(await page.evaluate(() => window.__sameDocument), true);
  assert.equal(await page.$('input[name="passphrase"]'), null);
  accessState.expired = false;
  await Promise.all([page.waitForNavigation(), page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent === "Sign in").click())]);
  await page.waitForSelector("#nav a");
});

test("sign-out during a session renewal leaves no live session behind", { skip }, async () => {
  await openHome();
  endAppSessions();
  // Start a request that triggers renewal, then sign out at once while the renewal is in flight.
  await page.evaluate(() => { location.hash = "#/projects"; });
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => /Sign out/.test(b.textContent))?.click());
  await page.waitForFunction(() => /Signed out/.test(document.body.innerText), { timeout: 20000 });
  assert.equal(liveSessions(), 0, "no session survives sign-out");
});

test("sign-out with an expired session and a request in flight finishes clearing local data (no reload)", { skip }, async () => {
  await openHome();
  await page.evaluate(() => { sessionStorage.removeItem("al:signin-reload"); localStorage.setItem("al:draft:" + "x:p:a", "{}"); });
  endAppSessions();
  accessState.logoutDelayMs = 1500; // the in-flight request's 401 arrives while logout() is still waiting
  try {
    await page.evaluate(() => {
      [...document.querySelectorAll("button")].find((b) => /Sign out/.test(b.textContent)).click();
      location.hash = "#/projects";
    });
    await page.waitForFunction(() => /Signed out/.test(document.body.innerText), { timeout: 20000 });
  } finally { accessState.logoutDelayMs = 0; }
  assert.equal(await page.evaluate(() => window.__sameDocument), true, "no reload cut sign-out short");
  assert.equal(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("al:draft:")).length), 0, "drafts cleared");
  assert.equal(liveSessions(), 0);
});

test("server: a new Access user ID for the owner email keeps the same owner account and library", async () => {
  const humans = () => d1("SELECT id FROM principals WHERE kind = 'human'");
  const [owner] = humans();
  assert.ok(owner, "owner exists from earlier sign-ins");
  accessState.sub = "user-owner-reissued";
  try {
    const r = await fetch(`http://127.0.0.1:${ACCESS_PORT}/auth/access-login`, { method: "POST" });
    assert.equal(r.status, 200, await r.clone().text());
    const cookie = r.headers.get("set-cookie").split(";")[0];
    const me = await (await fetch(`http://127.0.0.1:${ACCESS_PORT}/api/me`, { headers: { cookie } })).json();
    assert.equal(me.principal.id, owner.id);
    assert.deepEqual(humans(), [owner], "no second owner account");
    const projects = await (await fetch(`http://127.0.0.1:${ACCESS_PORT}/api/projects`, { headers: { cookie } })).json();
    assert.ok(projects.projects.some((p) => p.title === "Renewed write") || !haveChrome, "existing library is visible");
  } finally { accessState.sub = "user-owner-1"; }
});
