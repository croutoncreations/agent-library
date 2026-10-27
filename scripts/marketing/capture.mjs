// Marketing STILLS of Agent Library against the REAL local runtime (src/index.js under wrangler dev, loopback).
// Seeds the synthetic demo library (seed.mjs), then captures app screens and per-artifact "collage tiles".
// Usage: node scripts/marketing/capture.mjs [--out tmp/marketing] [--only home,reader,...]
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { SERVER_PORTS } from "../../test/ports.mjs";
import { seedDemoLibrary } from "./seed.mjs";

const require = createRequire(import.meta.url);
const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg("out", "tmp/marketing");
const PORT = Number(arg("port", String(SERVER_PORTS["marketing-capture"])));
const ONLY = (arg("only", "") || "").split(",").filter(Boolean);
const want = (k) => !ONLY.length || ONLY.includes(k);
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const puppeteer = require(`${process.env.HOME}/.npm-packages/lib/node_modules/puppeteer`);
mkdirSync(join(OUT, "tiles"), { recursive: true });
const b64u = (b) => Buffer.from(b).toString("base64url");
const s256 = (v) => createHash("sha256").update(v).digest("base64url");
const shots = [];

const { h, owner, ids } = await seedDemoLibrary({ port: PORT, onStage: (s) => console.error("seed:", s) });
const APP = h.appUi, MCP = h.issuer;
let browser;
try {
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-first-run", "--font-render-hinting=none"] });
  const page = await browser.newPage();
  const errors = [];
  page.on("dialog", (d) => d.accept().catch(() => {}));
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });
  const VIEW = {
    desktop: { width: 1440, height: 900, deviceScaleFactor: 2 },
    mobile: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
  };
  const settle = (ms = 500) => new Promise((r) => setTimeout(r, ms));
  let cur = { view: "desktop", scheme: "dark" };
  async function setMode(view, scheme) {
    cur = { view, scheme };
    await page.setViewport(VIEW[view]);
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }, { name: "prefers-reduced-motion", value: "reduce" }]);
  }
  async function shot(name, { full = false } = {}) {
    await settle();
    await page.evaluate(() => document.activeElement?.blur?.());
    const file = join(OUT, `${name}-${cur.view}-${cur.scheme}${full ? "-full" : ""}.png`);
    await page.screenshot({ path: file, fullPage: full });
    shots.push({ file, ...cur, full });
  }
  async function go(path, waitFor) {
    await page.goto(APP + path);
    if (typeof waitFor === "string") await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout: 15000 }, waitFor);
    else if (waitFor) await waitFor();
    await settle(400);
  }
  // Sign in with the synthetic owner session (per-run random passphrase; never printed).
  await setMode("desktop", "dark");
  await page.goto(APP + "/");
  const [cn, cv] = owner.cookie.split("=");
  await page.setCookie({ name: cn, value: cv.split(";")[0], url: APP });
  await page.goto(APP + "/#/"); await page.reload(); await page.waitForSelector("#nav a", { timeout: 15000 });
  const uid = (await owner.req("GET", "/api/me")).body.principal.id;
  await page.evaluate((uid, favorites) => { localStorage.setItem("al:home:" + encodeURIComponent(uid), JSON.stringify({ favorites, tab: "recent", sort: "newest" })); },
    uid, [{ pid: "tidepool", aid: ids.plan }, { pid: "qa-runs", aid: ids.qareport }, { pid: "personal", aid: ids.trip }]);

  const art = (pid, id, extra = "") => `/#/p/${pid}/a/${id}${extra}`;
  const tab = async (name) => {
    await page.waitForFunction((n) => [...document.querySelectorAll("[role=tab]")].some((t) => t.textContent.trim() === n), { timeout: 15000 }, name);
    await page.evaluate((n) => [...document.querySelectorAll("[role=tab]")].find((t) => t.textContent.trim() === n).click(), name);
  };
  const scenes = {
    home: () => go("/#/", "Launch plan"),
    projects: () => go("/#/projects", "Market research"),
    project: () => go("/#/p/tidepool", "Landing page draft"),
    qaproject: () => go("/#/p/qa-runs", "QA run: onboarding"),
    reader: () => go(art("tidepool", ids.plan), () => page.waitForSelector(".preview h1")),
    editor: async () => { await go(art("tidepool", ids.plan, "/edit"), () => page.waitForSelector(".cm-editor", { timeout: 15000 })); },
    landing: () => go(art("tidepool", ids.landing), async () => { await page.waitForSelector("iframe.htmlview"); await settle(1200); }),
    perf: () => go(art("qa-runs", ids.perf), async () => { await page.waitForSelector("iframe.htmlview"); await settle(1200); }),
    video: () => go(art("qa-runs", ids.qaVideo), async () => { await page.waitForSelector(".media video"); await page.evaluate(() => { const v = document.querySelector(".media video"); v.muted = true; v.currentTime = 2.4; }); await settle(800); }),
    screenshot: () => go(art("qa-runs", ids.qaShot), () => page.waitForSelector(".media img")),
    chart: () => go(art("tidepool", ids.chart), () => page.waitForSelector(".media img")),
    pdf: () => go(art("tidepool", ids.archPdf), () => page.waitForSelector(".filecard")),
    qareport: () => go(art("qa-runs", ids.qareport), () => page.waitForSelector(".preview img")),
    refactor: () => go(art("tidepool", ids.refactor), () => page.waitForSelector(".preview pre")),
    brief: () => go(art("research", ids.brief), () => page.waitForSelector(".preview table")),
    trip: () => go(art("personal", ids.trip), () => page.waitForSelector(".preview img")),
    history: async () => { await go(art("tidepool", ids.plan), () => page.waitForSelector(".preview h1")); await tab("History"); await page.waitForSelector(".vh-list .vh-row", { timeout: 15000 }); },
    diff: async () => {
      await go(`/p/tidepool/a/${ids.plan}?v=2`, () => page.waitForSelector(".vh-diff .vh-line.add", { timeout: 15000 }));
      await settle(800);
      await page.evaluate(() => { const t = document.querySelector(".vh-detail"); if (t) window.scrollTo(0, t.getBoundingClientRect().top + window.scrollY - 90); });
    },
    comments: async () => { await go(art("tidepool", ids.plan), () => page.waitForSelector(".preview h1")); await tab("Comments"); await page.waitForFunction(() => document.body.innerText.includes("runbook"), { timeout: 15000 }); },
    connections: () => go("/#/settings/apps", "Grok Bot"),
    tokens: () => go("/#/settings/tokens", "Claude Code"),
    apikeys: () => go("/#/settings/api-keys", "Muse"),
    csv: () => go(art("tidepool", ids.csv), "Beta sign-ups"),
    json: () => go(art("tidepool", ids.json), "Feature flags"),
  };
  const plan = [
    ["01-home", "home", ["desktop", "mobile"], ["dark", "light"]],
    ["02-projects", "projects", ["desktop"], ["dark", "light"]],
    ["03-project", "project", ["desktop", "mobile"], ["dark", "light"]],
    ["03-qa-project", "qaproject", ["desktop"], ["dark", "light"]],
    ["04-reader", "reader", ["desktop", "mobile"], ["dark", "light"], { full: true }],
    ["05-editor", "editor", ["desktop", "mobile"], ["dark", "light"]],
    ["06-html-landing", "landing", ["desktop", "mobile"], ["dark", "light"]],
    ["06-html-perf", "perf", ["desktop"], ["dark", "light"]],
    ["07-video", "video", ["desktop", "mobile"], ["dark", "light"]],
    ["07-screenshot", "screenshot", ["desktop"], ["dark", "light"]],
    ["07-chart", "chart", ["desktop"], ["dark", "light"]],
    ["08-pdf", "pdf", ["desktop"], ["dark", "light"]],
    ["09-history", "history", ["desktop", "mobile"], ["dark", "light"]],
    ["10-diff", "diff", ["desktop", "mobile"], ["dark", "light"]],
    ["11-qa-report", "qareport", ["desktop", "mobile"], ["dark", "light"]],
    ["11-refactor", "refactor", ["desktop"], ["dark", "light"]],
    ["11-brief", "brief", ["desktop"], ["dark", "light"]],
    ["11-trip", "trip", ["desktop", "mobile"], ["dark", "light"]],
    ["12-comments", "comments", ["desktop"], ["dark", "light"]],
    ["14-connections", "connections", ["desktop", "mobile"], ["dark", "light"]],
    ["14-tokens", "tokens", ["desktop"], ["dark"]],
    ["14-api-keys", "apikeys", ["desktop"], ["dark"]],
    // Data files render as a table / tree inline (PR #19).
    ["15-csv", "csv", ["desktop"], ["dark", "light"]],
    ["15-json", "json", ["desktop"], ["dark", "light"]],
  ];
  for (const [name, scene, views, schemes, opts = {}] of plan) {
    if (!want(scene) || (opts.optIn && !ONLY.includes(scene))) continue;
    for (const v of views) for (const sc of schemes) {
      await setMode(v, sc);
      await scenes[scene]();
      await shot(name);
      if (opts.full) await shot(name, { full: true });
    }
  }

  // ---- collage tiles: each artifact's main content alone, light theme, transparent-friendly crops ----
  if (want("tiles")) {
    await setMode("desktop", "light");
    const tile = async (name, path, sel, wait) => {
      await go(path, wait ?? (() => page.waitForSelector(sel, { timeout: 15000 })));
      await settle(sel.includes("iframe") ? 1200 : 300);
      // Element screenshots of tall tiles scroll the page; hide sticky chrome so it can't overlap the tile.
      // (CSSOM property writes are allowed under the app's style-src CSP; injected <style> is not.)
      await page.evaluate(() => { for (const e of document.querySelectorAll("header, .topbar, .tabbar, nav.bottom, .toast")) e.style.setProperty("display", "none", "important"); });
      const el = await page.$(sel);
      const file = join(OUT, "tiles", `${name}.png`);
      await el.screenshot({ path: file });
      shots.push({ file, tile: true });
    };
    await tile("md-launch-plan", art("tidepool", ids.plan), ".preview");
    await tile("md-refactor-plan", art("tidepool", ids.refactor), ".preview");
    await tile("md-research-brief", art("research", ids.brief), ".preview");
    await tile("md-trend-watch", art("research", ids.trends), ".preview");
    await tile("md-interviews", art("research", ids.interviews), ".preview");
    await tile("md-qa-report", art("qa-runs", ids.qareport), ".preview");
    await tile("md-trip", art("personal", ids.trip), ".preview");
    await tile("md-groceries", art("personal", ids.groceries), ".preview");
    await tile("md-release-notes", art("tidepool", ids.release), ".preview");
    await tile("md-press-kit", art("tidepool", ids.presskit), ".preview");
    await tile("html-landing", art("tidepool", ids.landing), "iframe.htmlview");
    await tile("html-perf-audit", art("qa-runs", ids.perf), "iframe.htmlview");
    await tile("img-chart", art("tidepool", ids.chart), ".media img");
    await tile("img-app-screens", art("tidepool", ids.hero), ".media img");
    await tile("img-qa-screenshot", art("qa-runs", ids.qaShot), ".media img");
    await tile("img-photo", art("personal", ids.photo), ".media img");
    await tile("video-qa-run", art("qa-runs", ids.qaVideo), ".media video", async () => { await page.waitForSelector(".media video"); await page.evaluate(() => { const v = document.querySelector(".media video"); v.muted = true; v.currentTime = 2.4; }); await settle(800); });
    await tile("pdf-card", art("tidepool", ids.archPdf), ".filecard");
  }

  // ---- consent: a hosted-style agent (registered with Claude's real callback) choosing per-project access ----
  if (want("consent")) {
    const redirect = "https://claude.ai/api/mcp/auth_callback";
    const reg = await fetch(`${MCP}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [redirect], token_endpoint_auth_method: "none" }) }).then((r) => r.json());
    if (!reg.client_id) throw Error("register " + JSON.stringify(reg));
    const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: redirect, scope: "agentlib:read agentlib:write offline_access", state: "s" + randomBytes(4).toString("hex"), resource: `${MCP}/mcp`, code_challenge: s256(b64u(randomBytes(32))), code_challenge_method: "S256" });
    for (const v of ["desktop", "mobile"]) for (const sc of ["dark", "light"]) {
      const ctx = await browser.createBrowserContext(); const p2 = await ctx.newPage();
      await p2.setViewport(VIEW[v]); await p2.emulateMediaFeatures([{ name: "prefers-color-scheme", value: sc }]);
      await p2.goto(`${MCP}/authorize?${q}`); await settle();
      await Promise.all([p2.waitForNavigation({ waitUntil: "load" }), p2.click('button[value="approve"]')]);
      await p2.waitForFunction(() => /Choose what/i.test(document.body.innerText), { timeout: 15000 });
      await p2.evaluate(() => {
        const pick = { "access:tidepool": "write", "access:research": "read", "access:personal": "write" };
        for (const [name, val] of Object.entries(pick)) document.querySelector(`input[type=radio][name="${name}"][value="${val}"]`)?.click();
      });
      await settle();
      const f = join(OUT, `13-consent-${v}-${sc}.png`);
      await p2.screenshot({ path: f }); shots.push({ file: f, view: v, scheme: sc });
      await ctx.close();
    }
  }
  writeFileSync(join(OUT, "capture-log.json"), JSON.stringify({ origin: "loopback synthetic", errors, shots }, null, 1));
  console.log(JSON.stringify({ shots: shots.length, errors }, null, 1));
} finally {
  await browser?.close(); await h.stop();
}
