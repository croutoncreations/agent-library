// Installed app opens instantly offline or on a stalled connection (build-offline-shell.mjs, src/offline/*).
// Real Chrome and the real local Worker behind a small proxy that can stall /api/* (a "spotty network": requests
// are accepted but get no answer). Synthetic data only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { startServer, setupProject } from "./helpers.mjs";
import { SERVER_PORTS, AUX_PORTS } from "./ports.mjs";

const require = createRequire(import.meta.url);
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PUPPETEER = `${process.env.HOME}/.npm-packages/lib/node_modules/puppeteer`;
const haveChrome = existsSync(CHROME) && existsSync(PUPPETEER);
const skip = !haveChrome && "Chrome not installed";
const WORKER_PORT = SERVER_PORTS["offline-shell"], PROXY_PORT = AUX_PORTS.offlineShellProxy, APP = `http://127.0.0.1:${PROXY_PORT}`;
let s, h, proxy, browser, page, docId;
// navHits: page loads that reached the network (the background shell refresh is not a navigation).
// shellGets: background shell file downloads (non-navigation GETs of /app.js). deploy: when set, the proxy plays
// a new deploy: every shell response (and /shell-version) reports this version, and /app.js gains a marker comment.
const net = { stallApi: false, held: [], navHits: 0, shellGets: 0, versionChecks: 0, deploy: null };

function forward(req, res) {
  const path = new URL(req.url, APP).pathname;
  const up = httpRequest({ host: "127.0.0.1", port: WORKER_PORT, method: req.method, path: req.url, headers: { ...req.headers, "accept-encoding": "identity" } }, (r) => {
    if (!net.deploy || !(path === "/shell-version" || r.headers["x-shell-version"])) { res.writeHead(r.statusCode, r.headers); return r.pipe(res); }
    const chunks = []; r.on("data", (c) => chunks.push(c)); r.on("end", () => {
      let body = Buffer.concat(chunks);
      if (path === "/shell-version") body = Buffer.from(JSON.stringify({ version: net.deploy }));
      // The marker comment identifies the copy; the global shows which copy the page actually ran.
      if (path === "/app.js") body = Buffer.concat([body, Buffer.from("\n// deploy " + net.deploy + "\nself.__deploy = " + JSON.stringify(net.deploy) + ";\n")]);
      if (path === "/app.css") body = Buffer.concat([body, Buffer.from("\n:root{--deploy:" + JSON.stringify(net.deploy) + "}\n")]);
      const headers = { ...r.headers, "content-length": String(body.length) };
      if (r.headers["x-shell-version"]) headers["x-shell-version"] = net.deploy;
      res.writeHead(r.statusCode, headers); res.end(body);
    });
  });
  up.on("error", () => { res.writeHead(502); res.end(); });
  req.pipe(up);
}
function release() { const held = net.held; net.held = []; held.forEach((f) => f()); }
async function shellCached() {
  return page.evaluate(async () => {
    const c = await caches.open("al-shell-v3");
    return (await Promise.all(["/", "/app.js", "/app.css", "/manifest.webmanifest"].map((p) => c.match(p)))).every(Boolean);
  });
}

before(async () => {
  s = await startServer("offline-shell", WORKER_PORT);
  h = await s.login();
  await setupProject(h, "trip", "Trip notes");
  docId = (await h.req("POST", "/api/projects/trip/artifacts", { title: "Packing list", body: "# Packing\n\nPassport and charger.\n" })).body.artifact_id;
  proxy = createServer((req, res) => {
    const path = new URL(req.url, APP).pathname;
    if (req.headers["sec-fetch-mode"] === "navigate") net.navHits++;
    else if (path === "/app.js") net.shellGets++;
    if (path === "/shell-version") net.versionChecks++;
    if (net.stallApi && (path.startsWith("/api/") || path.startsWith("/auth/"))) { net.held.push(() => forward(req, res)); return; }
    forward(req, res);
  }).listen(PROXY_PORT, "127.0.0.1");
  if (!haveChrome) return;
  browser = await require(PUPPETEER).launch({ executablePath: CHROME, headless: true, args: ["--no-first-run"] });
  page = await browser.newPage();
  await page.setViewport({ width: 412, height: 900, isMobile: true, hasTouch: true });
  await page.goto(APP + "/");
  await page.waitForSelector('input[name="passphrase"]');
  await page.type('input[name="passphrase"]', s.passphrase());
  await Promise.all([page.waitForFunction(() => document.querySelectorAll("#nav a").length === 4), page.click('button[type="submit"]')]);
});
after(async () => { release(); await browser?.close(); proxy?.close(); await s?.stop(); });

test("service worker serves the cache-first shell and only for app routes", async () => {
  const sw = await (await fetch(APP + "/sw.js")).text();
  assert.match(sw, /var SHELL = "al-shell-v3"/);
  assert.match(sw, /\/\^\\\/p\\\/\(\[\^\/\]\+\)/, "deep-link regex survives the template literal");
  // Ordinary launches answer from the cache first (network-first only for sign-in navigations, tested below).
  assert.match(sw, /e\.respondWith\(ready\.then\(function \(\) \{ return fromCache\(key\); \}\)/, "cache-first shell");
});

test("the shell is cached and the app is controlled by the service worker", { skip }, async () => {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); await page.waitForSelector("#nav a");
  assert.equal(await page.evaluate(() => !!navigator.serviceWorker.controller), true);
  assert.equal(await shellCached(), true);
  // Save one document for offline reading through the real UI.
  await page.goto(APP + `/#/p/trip/a/${docId}`); await page.waitForFunction(() => /Packing/.test(document.body.innerText));
  await page.click('button[aria-label="Make available offline"]');
  await page.waitForFunction(() => /Available offline/.test(document.body.innerText));
});

test("stalled network: the app opens saved copies within seconds, then offers the live library once connected", { skip }, async () => {
  net.stallApi = true;
  try {
    const hits = net.navHits, t0 = Date.now();
    await page.goto(APP + "/");
    await page.waitForFunction(() => /Saved on this device/.test(document.body.innerText) && /Packing list/.test(document.body.innerText), { timeout: 8000 });
    const ms = Date.now() - t0;
    assert.ok(ms < 6000, `saved copies shown after ${ms} ms`);
    assert.equal(net.navHits, hits, "the page came from the cached shell, not the network");
    assert.match(await page.$eval(".offline-banner", (b) => b.innerText), /Connecting/);
    await page.evaluate(() => [...document.querySelectorAll("a")].find((a) => a.textContent === "Packing list").click());
    await page.waitForFunction(() => /Passport and charger/.test(document.body.innerText));
    assert.ok(net.held.length >= 1, "sign-in is still waiting on the network");
  } finally { net.stallApi = false; release(); }
  await page.waitForFunction(() => /Open the live library/.test(document.body.innerText));
  assert.match(await page.evaluate(() => document.body.innerText), /Passport and charger/, "the reader is not switched away");
  await page.evaluate(() => [...document.querySelectorAll("a")].find((a) => a.textContent === "Open the live library").click());
  await page.waitForSelector("#nav a");
  await page.waitForFunction(() => !document.querySelector(".offline-banner") && /Passport and charger/.test(document.body.innerText));
});

test("dead link that comes back: Try again reaches the live library in place, even with requests still stuck", { skip }, async () => {
  net.stallApi = true;
  try {
    await page.goto("about:blank");
    page.goto(APP + "/").catch(() => {});
    await page.waitForFunction(() => /Connecting/.test(document.querySelector(".offline-banner")?.innerText || ""), { timeout: 10000 });
    // The network comes back, but the requests sent while it was dead stay stuck (they are never answered).
    net.stallApi = false;
    const stuck = net.held.length;
    assert.ok(stuck >= 1, "sign-in requests are stuck");
    await page.evaluate(() => [...document.querySelectorAll(".offline-banner a")].find((a) => a.textContent === "Try again").click());
    // In place (no page load that would queue behind the stuck requests): the live library opens.
    await page.waitForSelector("#nav a", { timeout: 20000 });
    assert.equal(await page.$(".offline-banner"), null);
  } finally { net.stallApi = false; net.held = []; }
});

test("dead link that comes back on its own: the app notices (online event) and offers the live library", { skip }, async () => {
  net.stallApi = true;
  try {
    await page.goto("about:blank");
    page.goto(APP + "/").catch(() => {});
    await page.waitForFunction(() => /Connecting/.test(document.querySelector(".offline-banner")?.innerText || ""), { timeout: 10000 });
    await page.waitForFunction(() => /Saved on this device/.test(document.body.innerText));
    net.stallApi = false;
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.waitForFunction(() => /Open the live library/.test(document.body.innerText), { timeout: 20000 });
    assert.match(await page.evaluate(() => document.body.innerText), /Saved on this device/, "the reader is not switched away");
  } finally { net.stallApi = false; net.held = []; }
});

test("no network at all: the installed app opens from cache straight to saved copies", { skip }, async () => {
  await page.setOfflineMode(true);
  try {
    const t0 = Date.now();
    await page.goto(APP + "/?source=pwa");
    await page.waitForFunction(() => /Packing list/.test(document.body.innerText) && /Offline/.test(document.body.innerText), { timeout: 5000 });
    assert.ok(Date.now() - t0 < 3000, "no wait when the browser knows it is offline");
    assert.equal(await page.evaluate(() => location.search), "");
    // A deep link to the saved document opens it too.
    await page.goto(APP + `/p/trip/a/${docId}`);
    await page.waitForFunction(() => /Passport and charger/.test(document.body.innerText));
  } finally { await page.setOfflineMode(false); }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function launch() {
  await page.goto("about:blank"); // a hash-only goto would not reload the page
  const checks = net.versionChecks;
  await page.goto(APP + "/#/");
  await page.waitForSelector("#nav a");
  // The worker checks the version in the background (its own requests are invisible to the page).
  for (let i = 0; i < 100 && net.versionChecks === checks; i++) await sleep(100);
  assert.ok(net.versionChecks > checks, "the launch checked the shell version");
  await sleep(1000); // let any background download finish
}
const appJs = () => page.evaluate(async () => (await (await caches.open("al-shell-v3")).match("/app.js")).text());

test("unchanged app: a launch checks the version (a few bytes) and downloads nothing", { skip }, async () => {
  const v = (await (await fetch(APP + "/shell-version")).json()).version;
  assert.match(v, /^[0-9a-z]+$/);
  assert.equal((await fetch(APP + "/app.js")).headers.get("x-shell-version"), v, "shell files carry the same version");
  await launch();
  const gets = net.shellGets;
  await launch(); await launch();
  assert.equal(net.shellGets, gets, "no shell re-download while the version is unchanged");
  assert.equal(await page.$(".offline-banner"), null);
  assert.deepEqual((await page.evaluate(() => caches.keys())).filter((k) => k.startsWith("al-shell")), ["al-shell-v3"]);
});

test("new deploy: the shell downloads once in the background and the next launch uses it", { skip }, async () => {
  net.deploy = "testdeploy1";
  try {
    const gets = net.shellGets;
    await launch();
    assert.equal(net.shellGets, gets + 1, "downloaded once");
    assert.doesNotMatch(await appJs(), /deploy testdeploy1/, "this launch still runs the cached version");
    assert.equal(await page.evaluate(() => self.__deploy), undefined, "the page ran the cached script");
    await launch();
    assert.match(await appJs(), /deploy testdeploy1/, "the next launch swapped the new version in");
    assert.equal(net.shellGets, gets + 1, "and did not download it again");
    assert.equal(await shellCached(), true);
  } finally { net.deploy = null; }
  // Back to the real version (like a rollback): downloaded once more, then quiet again.
  await launch(); await launch();
  assert.doesNotMatch(await appJs(), /deploy testdeploy1/);
});

test("sign-in navigations (?al_net=1) bypass the cached shell", { skip }, async () => {
  const hits = net.navHits;
  await page.goto(APP + "/?al_net=1&t=1#/");
  await page.waitForSelector("#nav a");
  assert.equal(net.navHits, hits + 1, "the page came from the network");
  assert.equal(await page.evaluate(() => location.search), "", "the marker is dropped from the address bar");
});

test("a sign-in navigation right after a deploy loads its script from the same (new) version, not the cache", { skip }, async () => {
  net.deploy = "signindeploy";
  try {
    await page.goto("about:blank");
    await page.goto(APP + "/?al_net=1&t=2#/");
    await page.waitForSelector("#nav a");
    // The script and styles this page actually loaded are the network (new) copies, not the cached ones.
    assert.equal(await page.evaluate(() => self.__deploy), "signindeploy", "the page ran the new script");
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--deploy").trim()), '"signindeploy"', "the page applied the new styles");
    assert.doesNotMatch(await appJs(), /deploy signindeploy/, "the cached shell is unchanged until the next launch swaps it");
  } finally { net.deploy = null; }
  await launch(); await launch();
});
