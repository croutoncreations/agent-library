// Design screenshots against the REAL local runtime (src/index.js under wrangler dev, loopback only).
// Synthetic fixtures only: per-run random dev passphrase, stand-in OIDC owner, synthetic projects/documents,
// a synthetic reader (DCR) connection and a synthetic publisher. Nothing is read from ~/.pi, .dev.vars or
// Cloudflare; no tokens are written to disk or printed.
// Usage: node scripts/design/capture.mjs --out .artifacts/design/<name> [--only shell,reader,...] [--port 49892]
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { startAppConnectServer } from "../../test/fixtures/app-connect-harness.mjs";
import { makePng } from "../../test/make-fixtures.mjs";

const require = createRequire(import.meta.url);
const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg("out", "tmp/design-captures/capture");
const PORT = Number(arg("port", "49892"));
const ONLY = (arg("only", "") || "").split(",").filter(Boolean);
const want = (k) => !ONLY.length || ONLY.includes(k);
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const puppeteer = require(`${process.env.HOME}/.npm-packages/lib/node_modules/puppeteer`);
mkdirSync(OUT, { recursive: true });
const sha = (b) => createHash("sha256").update(b).digest("hex");
const b64u = (b) => Buffer.from(b).toString("base64url");
const s256 = (v) => createHash("sha256").update(v).digest("base64url");
const log = [];

const h = await startAppConnectServer({ port: PORT });
const APP = h.appUi, MCP = h.issuer;
let browser;
try {
  const owner = await h.owner();
  const P = async (id, title) => { const r = await owner.req("POST", "/api/projects", { id, title }); if (r.status !== 201) throw Error("project " + r.status); };
  await P("field-guide", "Field Guide");
  await P("planning", "Planning 2027");
  await P("archive", "Archive");
  await P("long-names", "A project with an intentionally very long name to check wrapping across narrow phones");
  const doc = async (pid, title, body, extra = {}) => {
    const r = await owner.req("POST", `/api/projects/${pid}/artifacts`, { title, body, ...extra });
    if (r.status !== 201) throw Error("doc " + r.status + JSON.stringify(r.body)); return r.body.artifact_id;
  };
  const reader = await doc("field-guide", "Trail notes: the north ridge loop",
    "# Trail notes\n\nThe north ridge loop is about **11 km** with 640 m of climbing. Start early; the upper switchbacks get full sun after ten.\n\n## Water\n\n- Spring at km 3 (reliable through August)\n- Creek crossing at km 7.5\n\n## Notes\n\nThe old fire road is closed for restoration. Use the marked detour; it adds roughly 400 m. A very long unbroken identifier for wrapping: field-guide-north-ridge-loop-segment-identifier-0000000000000000000000.\n\n> Leave no trace. Pack out everything.\n");
  await doc("field-guide", "Gear checklist", "# Gear\n\n- Map\n- Headlamp\n- First aid\n");
  // NOTE: no HTML-kind fixture: this baseline lacks migration 0009_html_documents (kind CHECK rejects html).
  await doc("planning", "Q1 roadmap", "# Q1\n\nDraft.\n");
  await doc("long-names", "A document title that keeps going well beyond what a phone header can show on one line", "# Long\n\nBody.\n");
  // Upload a small PNG through an agent grant (real begin/PUT/finish).
  const g = await owner.req("POST", "/api/projects/field-guide/grants", { label: "synthetic uploader", can_write: true });
  const png = makePng(64, 48);
  const hdr = (t) => ({ authorization: "Bearer " + t, "content-type": "application/json", "idempotency-key": "k" + randomBytes(6).toString("hex") });
  const b = await (await fetch(`${APP}/api/projects/field-guide/uploads`, { method: "POST", headers: hdr(g.body.token), body: JSON.stringify({ title: "Ridge profile", mime: "image/png", size: png.length, sha256: sha(png) }) })).json();
  await fetch(APP + b.put_url, { method: "PUT", headers: { authorization: "Bearer " + g.body.token, "content-type": "application/octet-stream" }, body: png });
  await fetch(`${APP}/api/projects/field-guide/uploads/${b.upload_id}/finish`, { method: "POST", headers: hdr(g.body.token), body: "{}" });
  // Reader connection (synthetic DCR agent) and a publisher (registered app + consent), both via real OAuth flows.
  await h.connectMcpAgent({ "field-guide": "write", "planning": "read" });
  const app = await h.registerApp({ display_name: "Field Notes (local)", redirect_uris: ["http://localhost:5173/agent-library/callback"], origins: ["http://localhost:5173"] });
  await h.connectPublisher(app, { project_id: "field-guide", destination: "new", new_folder_name: "Field notes" });
  await owner.req("POST", "/api/api-keys", { label: "Muse (synthetic)", lifetime_days: 30, projects: [{ project_id: "planning", access: "read" }] });

  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-first-run"] });
  const page = await browser.newPage();
  const errors = [];
  // Viewport changes between desktop/mobile reload the page; the dirty-editor beforeunload guard is expected. Accept it
  // (the draft is already persisted per keystroke and is cleared below between conflict runs).
  page.on("dialog", (d) => { log.push({ dialog: d.type() }); d.accept().catch(() => {}); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  const VIEW = { desktop: { width: 1440, height: 1000 }, mobile: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, narrow: { width: 320, height: 720, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } };
  const settle = () => new Promise((r) => setTimeout(r, 350));
  const overflow = () => page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth,
    offenders: [...document.querySelectorAll("body *")].filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.right > window.innerWidth + 1 && getComputedStyle(e).position !== "fixed" && !e.closest(".cm-scroller,pre,.preview,iframe,.tabs,.lightbox"); }).slice(0, 5).map((e) => e.tagName + "." + e.className + " " + (e.textContent || "").slice(0, 40)) }));
  async function shot(name, { view = "desktop", scheme = "dark", full = false } = {}) {
    await page.setViewport(VIEW[view]); await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }, { name: "prefers-reduced-motion", value: "reduce" }]);
    await settle();
    const file = join(OUT, `${name}-${view}-${scheme}.png`);
    await page.screenshot({ path: file, fullPage: full });
    const o = await overflow();
    log.push({ file, view, scheme, overflow_px: Math.max(0, o.doc - o.win), offenders: o.offenders });
  }
  const go = async (hash, waitText) => { await page.evaluate(() => { try { for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k.startsWith("al:resume")) localStorage.removeItem(k); } } catch {} }).catch(() => {}); await page.goto(APP + "/" + hash); if (waitText) await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout: 15000 }, waitText).catch(async (e) => { console.error("WAIT FAILED for", JSON.stringify(waitText), "at", hash, "\n", (await page.evaluate(() => document.body.innerText)).slice(0, 600), "\n", errors.join("\n")); throw e; }); await settle(); };
  // Sign in through the real form.
  await page.setViewport(VIEW.desktop);
  await page.goto(APP + "/");
  await page.waitForSelector('input[name="passphrase"]');
  if (want("login")) for (const v of ["desktop", "mobile"]) for (const sc of ["dark", "light"]) { await page.setViewport(VIEW[v]); await page.goto(APP + "/"); await page.waitForSelector('input[name="passphrase"]'); await shot("00-sign-in", { view: v, scheme: sc }); }
  // Reuse the synthetic owner's session (harness dev-login with a per-run random passphrase); never printed.
  const [cn, cv] = owner.cookie.split("=");
  await page.setCookie({ name: cn, value: cv.split(";")[0], url: APP });
  // A hash-only goto would not re-run boot; reload so the app picks up the session.
  await page.goto(APP + "/#/"); await page.reload(); await page.waitForSelector("#nav a", { timeout: 15000 });

  const each = async (name, hash, waitText, views = ["desktop", "mobile"], schemes = ["dark", "light"], opts = {}) => {
    for (const v of views) for (const sc of schemes) { await page.setViewport(VIEW[v]); await go(hash, waitText); if (opts.before) await opts.before(); await shot(name, { view: v, scheme: sc, full: opts.full }); }
  };
  if (want("shell")) {
    await each("01-home", "#/", "Trail notes");
    await each("02-projects", "#/projects", "Planning 2027");
    await each("03-project", "#/p/field-guide", "Gear checklist");
    await each("04-project-empty", "#/p/archive", "Archive", ["desktop", "mobile"], ["dark"]);
    await each("05-search-none", "#/p/field-guide", "Field Guide", ["desktop"], ["dark", "light"], { before: async () => { await page.$eval('input[type=search]', (e) => { e.value = ""; }); await page.type('input[type=search]', "zzzz-nothing"); await new Promise((r) => setTimeout(r, 900)); } });
    await each("06-long-names", "#/p/long-names", "A document title", ["narrow"], ["dark", "light"]);
    await each("06-projects-narrow", "#/projects", "Planning 2027", ["narrow"], ["dark"]);
  }
  if (want("reader")) {
    await each("10-reader", `#/p/field-guide/a/${reader}`, "north ridge loop", ["desktop", "mobile"], ["dark", "light"], { full: false });
    await each("11-editor", `#/p/field-guide/a/${reader}/edit`, "Trail notes", ["desktop", "mobile"], ["dark", "light"]);
    await each("12-reader-narrow", `#/p/field-guide/a/${reader}`, "north ridge loop", ["narrow"], ["dark"]);
    // Conflict: someone else saves rev 2 while this editor is dirty at rev 1.
    for (const sc of ["dark", "light"]) for (const v of ["desktop", "mobile"]) {
      const cur = await owner.req("GET", `/api/projects/field-guide/artifacts/${reader}`);
      await page.setViewport(VIEW[v]); await go(`#/p/field-guide/a/${reader}/edit`, "Trail notes");
      await owner.req("PUT", `/api/projects/field-guide/artifacts/${reader}`, { expected_revision: cur.body.revision.rev, body: cur.body.body + "\nEdited elsewhere " + sc + v + ".\n" });
      await page.waitForFunction(() => window.__alActiveEditor && window.__alActiveEditor()); await page.evaluate(() => { const ed = window.__alActiveEditor(); ed.focus(); try { ed.setSelectionRange(ed.value.length, ed.value.length); } catch {} }); await page.keyboard.type(" My local change.");
      await page.waitForFunction(() => document.querySelector(".status")?.dataset.state === "conflict", { timeout: 15000 });
      await settle(); await shot("13-conflict", { view: v, scheme: sc });
      // Discard local draft so the next iteration starts clean.
      await page.evaluate(() => { for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k.startsWith("al:draft:")) localStorage.removeItem(k); } });
    }
  }
  if (want("connections")) {
    await each("20-connections", "#/settings/apps", "synthetic agent");
    await each("21-publishing", "#/settings/publishing", "Field Notes");
    await each("22-api-keys", "#/settings/api-keys", "Muse (synthetic)", ["desktop", "mobile"], ["dark"]);
    await each("23-tokens", "#/settings/tokens", "synthetic uploader", ["desktop", "mobile"], ["dark"]);
    await each("24-device", "#/settings/device", "Storage limit", ["desktop", "mobile"], ["dark", "light"]);
  }
  if (want("states")) {
    // Error state: the projects API fails (synthetic 500) while the session stays valid.
    await page.setRequestInterception(true);
    const fail = (r) => { const u = new URL(r.url()); if (u.pathname === "/api/projects" && r.method() === "GET") r.respond({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "Synthetic failure" } }) }); else r.continue(); };
    page.on("request", fail);
    for (const sc of ["dark", "light"]) { await page.setViewport(VIEW.desktop); await page.goto(APP + "/#/projects"); await page.waitForFunction(() => /Synthetic failure|could not|couldn/i.test(document.body.innerText), { timeout: 15000 }); await shot("30-error-projects", { scheme: sc }); }
    await page.setViewport(VIEW.mobile); await page.goto(APP + "/#/projects"); await page.waitForFunction(() => /Synthetic failure|could not|couldn/i.test(document.body.innerText), { timeout: 15000 }); await shot("30-error-projects", { view: "mobile" });
    page.off("request", fail); await page.setRequestInterception(false);
  }
  if (want("consent")) {
    // Reader consent in a real browser: DCR client with a loopback callback (never contacted).
    const redirect = "http://127.0.0.1:5998/cb";
    const reg = await fetch(`${MCP}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Synthetic Research Agent", redirect_uris: [redirect], token_endpoint_auth_method: "none" }) }).then((r) => r.json());
    const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: redirect, scope: "agentlib:read agentlib:write offline_access", state: "s" + randomBytes(4).toString("hex"), resource: `${MCP}/mcp`, code_challenge: s256(b64u(randomBytes(32))), code_challenge_method: "S256" });
    for (const v of ["desktop", "mobile"]) for (const sc of ["dark", "light"]) {
      const ctx = await browser.createBrowserContext(); const p2 = await ctx.newPage();
      await p2.setViewport(VIEW[v]); await p2.emulateMediaFeatures([{ name: "prefers-color-scheme", value: sc }]);
      await p2.goto(`${MCP}/authorize?${q}`); await settle();
      await p2.screenshot({ path: join(OUT, `40-consent-start-${v}-${sc}.png`), fullPage: true }); log.push({ file: join(OUT, `40-consent-start-${v}-${sc}.png`) });
      await Promise.all([p2.waitForNavigation({ waitUntil: "load" }), p2.click('button[value="approve"]')]);
      await p2.waitForFunction(() => document.body.innerText.includes("Choose what to share"), { timeout: 15000 });
      await p2.screenshot({ path: join(OUT, `41-consent-projects-${v}-${sc}.png`), fullPage: true }); log.push({ file: join(OUT, `41-consent-projects-${v}-${sc}.png`) });
      await ctx.close();
    }
  }
  writeFileSync(join(OUT, "capture-log.json"), JSON.stringify({ origin: "loopback synthetic", errors, shots: log }, null, 1));
  console.log(JSON.stringify({ shots: log.length, errors, overflow: log.filter((l) => l.overflow_px > 0) }, null, 1));
} finally {
  await browser?.close(); await h.stop();
}
