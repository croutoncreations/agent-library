// Installed app under bad networks (docs/offline.md): the hosted app behind a stand-in for Cloudflare Access, with the
// cached shell, in real Chrome. Each scenario sets how the network fails (airplane mode, refused connections, a dead
// link whose requests are never answered, a very slow link, a captive portal, a 502, an expired Access session,
// flapping), whether anything is saved offline, what the user does (Try again, reopen, wait, read a document), and
// what must be on screen afterwards and how soon. Every scenario runs with and without saved copies.
// Synthetic data only. ONLY=<regex> runs a subset.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer, request as httpRequest } from "node:http";
import { generateKeyPairSync, createSign, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { startServer, ROOT } from "./helpers.mjs";
import { SERVER_PORTS, AUX_PORTS } from "./ports.mjs";
const require = createRequire(import.meta.url);
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PUPPETEER = `${process.env.HOME}/.npm-packages/lib/node_modules/puppeteer`;
const haveChrome = existsSync(CHROME) && existsSync(PUPPETEER);
const TEAM = "test-team.cloudflareaccess.com", AUD = "aud-" + randomBytes(4).toString("hex"), OWNER = "owner@example.invalid";
const WORKER = SERVER_PORTS["offline-network"], JWKS = AUX_PORTS.offlineNetworkJwks, ACCESS = AUX_PORTS.offlineNetworkAccess;
const HOST = "library.test", APP = `http://${HOST}:${ACCESS}`;
const OUT = ROOT + "/tmp/test-evidence/offline-network"; mkdirSync(OUT, { recursive: true });
const SIGNIN = "Stand-in Cloudflare Access sign-in";
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = () => { const now = Math.floor(Date.now() / 1000); const head = b64u({ alg: "RS256", kid: "k1", typ: "JWT" }) + "." + b64u({ iss: `https://${TEAM}`, aud: [AUD], iat: now, nbf: now - 5, exp: now + 600, sub: "user-owner-1", email: OWNER }); return head + "." + createSign("RSA-SHA256").update(head).sign(privateKey).toString("base64url"); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Network modes:
//   up      normal
//   dead    connection refused/reset at once (browser sees a network error)
//   stall   accepted, never answered (a phone on a dead link that still reports a connection)
//   slow    answered after 8 s (very slow link)
//   portal  every request answered 200 text/html by a "captive portal" (hotel/airport Wi-Fi before login)
//   expired Cloudflare Access session expired (401 for API calls, sign-in page for page loads)
//   err502  the edge answers 502 (upstream trouble)
const net = { mode: "up", sockets: new Set() };
let jwks, srv, access, browser, page;
function startJwks() { return createServer((q, s) => { s.setHeader("content-type", "application/json"); s.end(JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" }] })); }).listen(JWKS, "127.0.0.1"); }
function startWorker() { return startServer("offline-network", WORKER, { vars: { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, OWNER_EMAIL: OWNER, ACCESS_CERTS_URL: `http://127.0.0.1:${JWKS}/certs`, RATE_READS_PER_MIN: "100000", RATE_WRITES_PER_MIN: "100000", RATE_AUTHFAIL_PER_MIN: "100000" }, readyHeaders: { "cf-access-jwt-assertion": "x" } }); }
const fwd = (req, res) => {
  const up = httpRequest({ host: "127.0.0.1", port: WORKER, method: req.method, path: req.url, headers: { ...req.headers, "cf-access-jwt-assertion": jwt() } }, (r) => {
    const h = { ...r.headers }; if (h["set-cookie"]) h["set-cookie"] = h["set-cookie"].map((c) => c.replace(/; Secure/i, ""));
    res.writeHead(r.statusCode, h); r.pipe(res);
  });
  up.on("error", () => { res.writeHead(502); res.end(); }); req.pipe(up);
};
function startAccess() { return createServer((req, res) => {
  const m = net.mode;
  if (m === "dead") { req.socket.destroy(); return; }
  if (m === "stall") { net.sockets.add(req.socket); req.socket.on("close", () => net.sockets.delete(req.socket)); return; }
  if (m === "portal") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<!doctype html><title>Wi-Fi login</title><h1>Accept the terms to continue</h1>"); }
  if (m === "err502") { res.writeHead(502, { "content-type": "text/html" }); return res.end("<h1>502 Bad Gateway</h1>"); }
  if (m === "expired") {
    if ((req.headers["x-requested-with"] || "").toLowerCase() === "xmlhttprequest") { res.writeHead(401); return res.end(); }
    res.writeHead(200, { "content-type": "text/html" }); return res.end(`<!doctype html><title>${SIGNIN}</title><h1>${SIGNIN}</h1>`);
  }
  if (m === "slow") { setTimeout(() => fwd(req, res), 8000); return; }
  fwd(req, res);
}).listen(ACCESS, "127.0.0.1"); }
const launchBrowser = () => require(PUPPETEER).launch({ executablePath: CHROME, headless: true, protocolTimeout: 15000, args: ["--no-first-run", `--host-resolver-rules=MAP ${HOST} 127.0.0.1`, `--unsafely-treat-insecure-origin-as-secure=${APP}`] });
const errors = [];
// What the screen is: live | offline-saved | offline-empty | signin-app | signin-access | portal | blank | other
async function screen() {
  try {
    return await Promise.race([sleep(3000).then(() => ({ kind: "busy" })), page.evaluate((SIGNIN) => {
      const t = document.body ? document.body.innerText : "";
      const banner = (document.querySelector(".offline-banner")?.innerText || "").replace(/\s+/g, " ").slice(0, 60);
      let kind = "other";
      if (document.title === SIGNIN) kind = "signin-access";
      else if (/Accept the terms/.test(t)) kind = "portal";
      else if (/502 Bad Gateway/.test(t)) kind = "error-page";
      else if (document.querySelectorAll("#nav a").length === 4) kind = "live";
      else if (/Sign in with your Cloudflare Access account/.test(t)) kind = "signin-app";
      else if (/Nothing is saved/.test(t)) kind = "offline-empty";
      else if (/Saved on this device|Packing list/.test(t)) kind = /You.re connected/.test(banner) ? "offline-saved-connected" : "offline-saved";
      else if (/Loading/.test(t) || !t.trim()) kind = "blank";
      return { kind, banner };
    }, SIGNIN)]);
  } catch (e) { return { kind: "busy" }; }
}
async function waitFor(kinds, ms) {
  const t0 = Date.now(); let s;
  while (Date.now() - t0 < ms) { s = await screen(); if (kinds.includes(s.kind)) return { ...s, ms: Date.now() - t0 }; await sleep(250); }
  return { ...(s || await screen()), ms: null };
}
async function launch() { await page.goto("about:blank").catch(() => {}); page.goto(APP + "/?source=pwa").catch(() => {}); await sleep(300); }
const tap = (text) => page.evaluate((text) => { const a = [...document.querySelectorAll("a,button")].find((x) => x.textContent.trim() === text); if (!a) return false; a.click(); return true; }, text).catch(() => false);
async function setSaved(on) {
  await page.evaluate(async (on) => {
    await new Promise((res) => { const r = indexedDB.open("al-offline", 1); r.onsuccess = () => { const d = r.result; const t = d.transaction(["items", "projects"], "readwrite"); if (!on) { t.objectStore("items").clear(); t.objectStore("projects").clear(); } t.oncomplete = () => res(); }; });
  }, on);
}
async function resetNet() { net.mode = "up"; for (const s of net.sockets) s.destroy(); net.sockets.clear(); await page.setOfflineMode(false).catch(() => {}); }
let aid;
async function onlineHome() { await resetNet(); await launch(); return waitFor(["live"], 15000); }
async function saveDoc() {
  await page.goto(APP + "/#/p/trip/a/" + aid); await page.waitForFunction(() => /Passport/.test(document.body.innerText), { timeout: 15000 });
  const on = await page.$('button[aria-label="Make available offline"]');
  if (on) { await on.click(); await page.waitForFunction(() => /Available offline/.test(document.body.innerText), { timeout: 15000 }); }
}
function scenario(name, saved, fail, steps) {
  const title = `${name} (${saved ? "saved copies" : "nothing saved"})`;
  test(title, { skip: (!haveChrome && "Chrome not installed") || (process.env.ONLY && !new RegExp(process.env.ONLY).test(name) && "not in ONLY") }, async () => {
  const r = { result: "PASS", notes: [] };
  try {
    const home = await onlineHome(); if (home.kind !== "live") throw new Error("setup: not live (" + home.kind + ")");
    if (saved) await saveDoc(); else await setSaved(false);
    await page.goto("about:blank").catch(() => {}); await sleep(300);
    await fail();
    for (const [what, act, want, ms] of steps) {
      await act();
      const s = await waitFor(want, ms);
      const ok = s.ms !== null;
      r.notes.push(`${what}: ${s.kind}${ok ? ` (${(s.ms / 1000).toFixed(1)}s)` : ` after ${ms / 1000}s, wanted ${want.join("/")}`}${s.banner ? ` [${s.banner}]` : ""}`);
      if (!ok) { r.result = "FAIL"; await page.screenshot({ path: `${OUT}/${name.replace(/\W+/g, "-")}.png` }).catch(() => {}); break; }
    }
  } catch (e) { r.result = "ERROR"; r.notes.push(String(e.message).slice(0, 160)); }
  finally { await resetNet(); }
  assert.equal(r.result, "PASS", r.notes.join("\n"));
  });
}
const OFFLINE = ["offline-saved", "offline-empty"];
const offlineFor = (saved) => saved ? ["offline-saved", "offline-saved-connected"] : ["offline-empty"];
before(async () => {
  jwks = startJwks(); srv = await startWorker(); access = startAccess();
  if (!haveChrome) return;
  browser = await launchBrowser();
  page = await browser.newPage();
  await page.setViewport({ width: 390, height: 760, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page.on("pageerror", (e) => errors.push(e.message.slice(0, 100)));
  // Setup: owner signs in, one project and document, worker installed.
  await page.goto(APP + "/#/"); await page.waitForSelector("#nav a", { timeout: 20000 });
  const csrf = await page.evaluate(async () => (await (await fetch("/api/me", { headers: { "x-requested-with": "XMLHttpRequest" } })).json()).csrf);
  aid = await page.evaluate(async (csrf) => {
    const post = (u, b) => fetch(u, { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf, "x-requested-with": "XMLHttpRequest", "idempotency-key": "m" + Math.random() }, body: JSON.stringify(b) }).then((r) => r.json());
    await post("/api/projects", { id: "trip", title: "Trip notes" });
    return (await post("/api/projects/trip/artifacts", { title: "Packing list", body: "# Packing\n\nPassport.\n" })).artifact_id;
  }, csrf);
  // The app registers its worker on https and loopback; this plain-HTTP test host registers it as production would.
  await page.evaluate(async () => { await navigator.serviceWorker.register("/sw.js", { scope: "/" }); await navigator.serviceWorker.ready; });
});
after(async () => { await browser?.close(); access?.close(); jwks?.close(); await srv?.stop(); });

for (const saved of [true, false]) {
    const OFF = offlineFor(saved);
    // A. Launch with no connection at all (airplane mode): offline page at once; back online + Try again -> live.
    scenario("A airplane launch, then back online + Try again", saved, async () => { await page.setOfflineMode(true); }, [
      ["launch", launch, OFF, 3000],
      ["online + Try again", async () => { await page.setOfflineMode(false); await tap("Try again"); }, ["live"], 10000],
    ]);
    // B. Launch on a refused/reset connection (browser thinks it's online).
    scenario("B refused-connection launch, then fixed + Try again", saved, async () => { net.mode = "dead"; }, [
      ["launch", launch, OFF, 6000],
      ["net back + Try again", async () => { net.mode = "up"; await tap("Try again"); }, ["live"], 10000],
    ]);
    // C. Launch on a dead link (requests hang), stays dead a long time: still the offline page, still usable.
    scenario("C dead-link launch, stays dead 25s", saved, async () => { net.mode = "stall"; }, [
      ["launch", launch, OFF, 6000],
      ["25s later", () => sleep(25000), OFF, 3000],
      ["Try again while still dead", () => tap("Try again"), OFF, 20000],
    ]);
    // D. Dead link, signal comes back (stuck requests stay stuck), user taps Try again.
    scenario("D dead-link launch, signal back + Try again", saved, async () => { net.mode = "stall"; }, [
      ["launch", launch, OFF, 6000],
      ["signal back + Try again", async () => { net.mode = "up"; await tap("Try again"); }, ["live"], 20000],
    ]);
    // E. Dead link, signal comes back, user does nothing (no online event: the OS never thought it was offline).
    scenario("E dead-link launch, signal back, no tap, no event", saved, async () => { net.mode = "stall"; }, [
      ["launch", launch, OFF, 6000],
      ["signal back, wait", async () => { net.mode = "up"; }, saved ? ["offline-saved-connected"] : ["live"], 45000],
    ]);
    // F. Dead link, signal back, user closes and reopens the app.
    scenario("F dead-link launch, signal back, reopen app", saved, async () => { net.mode = "stall"; }, [
      ["launch", launch, OFF, 6000],
      ["signal back + reopen", async () => { net.mode = "up"; await launch(); }, ["live"], 20000],
    ]);
    // G. Signal dies while using the live app, then the user relaunches (the scenario from the field).
    scenario("G dies while live, relaunch, then back", saved, async () => {}, [
      ["live first", launch, ["live"], 10000],
      ["dies + relaunch", async () => { net.mode = "stall"; await launch(); }, OFF, 8000],
      ["back + Try again", async () => { net.mode = "up"; await tap("Try again"); }, ["live"], 20000],
    ]);
    // H. Very slow link (8 s per request): opens the offline page, then gets online without a tap.
    scenario("H very slow link (8s per request)", saved, async () => { net.mode = "slow"; }, [
      ["launch", launch, OFF, 6000],
      ["eventually connected", () => sleep(0), saved ? ["offline-saved-connected"] : ["live"], 30000],
    ]);
    // I. Captive portal answers everything with its own page: never the app's sign-in, never the portal as the app.
    scenario("I captive portal Wi-Fi", saved, async () => { net.mode = "portal"; }, [
      ["launch", launch, OFF, 8000],
      ["portal gone + Try again", async () => { net.mode = "up"; await tap("Try again"); }, ["live"], 15000],
    ]);
    // J. The edge answers 502 for a while.
    scenario("J server/edge 502", saved, async () => { net.mode = "err502"; }, [
      ["launch", launch, OFF, 8000],
      ["fixed + Try again", async () => { net.mode = "up"; await tap("Try again"); }, ["live"], 15000],
    ]);
    // K. Cloudflare Access signed out (real sign-out): saved copies + sign-in link, or Access's own sign-in page.
    scenario("K Access signed out", saved, async () => { net.mode = "expired"; await page.evaluate(() => sessionStorage.removeItem("al:signin-reload")).catch(() => {}); }, saved ? [
      ["launch", launch, ["offline-saved"], 8000],
      ["tap Sign in link", () => tap("Sign in to open the live library"), ["signin-access"], 10000],
    ] : [
      ["launch", launch, ["signin-access"], 10000],
    ]);
    // L. Rapid flapping: dead, back, dead, back, with Try again taps in between; must end live.
    scenario("L flapping network with repeated Try again", saved, async () => { net.mode = "stall"; }, [
      ["launch", launch, OFF, 6000],
      ["back, tap", async () => { net.mode = "up"; await tap("Try again"); net.mode = "stall"; await sleep(500); await tap("Try again"); }, OFF.concat(["live"]), 8000],
      ["back for good, tap", async () => { net.mode = "up"; await tap("Try again"); }, ["live"], 25000],
    ]);
}
// M. Reading a saved document when the connection returns: never switched away from it.
  scenario("M reading a saved doc when connection returns", true, async () => { net.mode = "stall"; }, [
    ["launch", launch, ["offline-saved"], 6000],
    ["open the doc", async () => { await tap("Packing list"); await page.waitForFunction(() => /Passport/.test(document.body.innerText), { timeout: 5000 }).catch(() => {}); }, ["offline-saved"], 5000],
    ["connection back (online event)", async () => { net.mode = "up"; await page.evaluate(() => window.dispatchEvent(new Event("online"))).catch(() => {}); }, ["offline-saved-connected"], 10000],
    ["still on the document", async () => { if (!(await page.evaluate(() => /Passport/.test(document.body.innerText)).catch(() => false))) throw new Error("switched away from the document"); }, ["offline-saved-connected"], 1000],
  ]);
test("the app threw no errors in any scenario", { skip: !haveChrome && "Chrome not installed" }, () => {
  assert.deepEqual([...new Set(errors)], []);
});
