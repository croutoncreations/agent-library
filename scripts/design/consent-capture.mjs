// Screenshots of the OAuth connect flows (reader/MCP agent and publisher app) against the REAL local runtime.
// Synthetic fixtures only (stand-in OIDC owner, synthetic projects, loopback callbacks that are never contacted).
// Usage: node scripts/design/consent-capture.mjs --out tmp/design-captures/consent [--port 21024]
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { startAppConnectServer } from "../../test/fixtures/app-connect-harness.mjs";
import { SERVER_PORTS } from "../../test/ports.mjs";

const require = createRequire(import.meta.url);
const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg("out", "tmp/design-captures/consent");
const PORT = Number(arg("port", String(SERVER_PORTS["consent-capture"])));
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const puppeteer = require(`${process.env.HOME}/.npm-packages/lib/node_modules/puppeteer`);
mkdirSync(OUT, { recursive: true });
const b64u = (b) => Buffer.from(b).toString("base64url");
const s256 = (v) => createHash("sha256").update(v).digest("base64url");
const VIEW = { desktop: { width: 1280, height: 900 }, mobile: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } };
const shots = [], errors = [];

const h = await startAppConnectServer({ port: PORT });
const MCP = h.issuer;
let browser;
try {
  const owner = await h.owner();
  for (const [id, title] of [["notes", "Notes"], ["field-guide", "Field Guide"], ["planning", "Planning 2027"]])
    await owner.req("POST", "/api/projects", { id, title });
  // An earlier connection of each kind, so the "reuse" paths are visible.
  await h.connectMcpAgent({ "field-guide": "write" });
  const app = await h.registerApp({ display_name: "Run Receipt", redirect_uris: ["http://localhost:5173/agent-library/callback"], origins: ["http://localhost:5173"] });
  await h.connectPublisher(app, { project_id: "notes", destination: "new", new_folder_name: "Run Receipt" });

  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-first-run"] });
  const flows = {
    reader: async () => {
      const redirect = "http://127.0.0.1:5998/cb";
      const reg = await fetch(`${MCP}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Example Agent", redirect_uris: [redirect], token_endpoint_auth_method: "none" }) }).then((r) => r.json());
      return new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: redirect, scope: "agentlib:read agentlib:write offline_access", state: "s" + randomBytes(4).toString("hex"), resource: `${MCP}/mcp`, code_challenge: s256(b64u(randomBytes(32))), code_challenge_method: "S256" });
    },
    publisher: async () => new URLSearchParams({ response_type: "code", client_id: app.client_id, redirect_uri: app.redirect_uris[0], scope: "agentlib:publish offline_access", state: "s" + randomBytes(4).toString("hex"), resource: `${MCP}/v1`, code_challenge: s256(b64u(randomBytes(32))), code_challenge_method: "S256" }),
  };
  for (const [flow, mk] of Object.entries(flows)) for (const v of ["desktop", "mobile"]) for (const sc of ["dark", "light"]) {
    const ctx = await browser.createBrowserContext(); const p = await ctx.newPage();
    p.on("pageerror", (e) => errors.push(`${flow}: ${e.message}`));
    p.on("console", (m) => { if (/Content Security Policy|error/i.test(m.type() + m.text())) errors.push(`${flow}: ${m.text()}`); });
    await p.setViewport(VIEW[v]); await p.emulateMediaFeatures([{ name: "prefers-color-scheme", value: sc }, { name: "prefers-reduced-motion", value: "reduce" }]);
    await p.goto(`${MCP}/authorize?${await mk()}`);
    // Full-page captures pin position:sticky to the first viewport; show the bar where it settles at the end of the page.
    const unstick = () => p.addStyleTag({ content: ".bar{position:static!important}" });
    const shot = async (n) => { await unstick(); await new Promise((r) => setTimeout(r, 250)); const f = join(OUT, `${flow}-${n}-${v}-${sc}.png`); await p.screenshot({ path: f, fullPage: true }); shots.push(f); };
    await shot("1-start");
    await Promise.all([p.waitForNavigation({ waitUntil: "load" }), p.click('button.primary')]);
    await shot("2-choose");
    if (flow === "reader") {
      // Selections made: one project at Edit, a new project typed in (shows the live count and the next empty row).
      await p.click('input[name="access:notes"][value="write"]');
            await p.type('input[name="new_title"]', "Agent notes");
      await shot("3-selected");
      if (v === "mobile") { // a real phone viewport: the action bar stays pinned while the list scrolls
        await p.evaluate(() => document.querySelectorAll("style").forEach((e) => { if (e.textContent.includes("position:static!important")) e.remove(); }));
        await p.evaluate(() => window.scrollTo(0, 260)); await new Promise((r) => setTimeout(r, 250));
        const f = join(OUT, `${flow}-3b-sticky-bar-${v}-${sc}.png`); await p.screenshot({ path: f }); shots.push(f);
      }
      // Connect without the typed project so each capture doesn't add another fixture project.
      await p.$eval('input[name="new_title"]', (e) => { e.value = ""; });
    } else {
      await p.click('input[name="resume"][value="new"]');
      await shot("3-somewhere-new");
      await p.click('input[name="resume"]:not([value="new"])'); // continue the earlier destination
    }
    // The final screen redirects to the app's callback at once (meta refresh). Render its HTML without the refresh.
    const done = p.waitForResponse((r) => r.url().endsWith("/authorize") && r.request().method() === "POST");
    await p.setRequestInterception(true);
    p.on("request", (r) => (/127\.0\.0\.1:5998|localhost:5173/.test(r.url()) ? r.abort() : r.continue()));
    await p.click('button.primary');
    const html = (await (await done).text()).replace(/<meta http-equiv="refresh"[^>]*>/, "");
    const p2 = await ctx.newPage(); await p2.setViewport(VIEW[v]); await p2.emulateMediaFeatures([{ name: "prefers-color-scheme", value: sc }, { name: "prefers-reduced-motion", value: "reduce" }]);
    await p2.setContent(html); await new Promise((r) => setTimeout(r, 250));
    { const f = join(OUT, `${flow}-4-connected-${v}-${sc}.png`); await p2.screenshot({ path: f, fullPage: true }); shots.push(f); }
    await ctx.close();
  }
  // Reconnecting the same reader app: earlier access is prefilled and the old connection is offered for replacement.
  {
    const redirect = "http://127.0.0.1:5998/cb";
    const reg = await fetch(`${MCP}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Example Agent", redirect_uris: [redirect], token_endpoint_auth_method: "none" }) }).then((r) => r.json());
    const q = () => new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: redirect, scope: "agentlib:read agentlib:write offline_access", state: "s" + randomBytes(4).toString("hex"), resource: `${MCP}/mcp`, code_challenge: s256(b64u(randomBytes(32))), code_challenge_method: "S256" });
    const go = async (fn) => { const ctx = await browser.createBrowserContext(); const p = await ctx.newPage(); try { return await fn(p); } finally { await ctx.close(); } };
    await go(async (p) => {
      await p.goto(`${MCP}/authorize?${q()}`);
      await Promise.all([p.waitForNavigation(), p.click('button.primary')]);
      await p.click('input[name="access:field-guide"][value="write"]'); await p.click('input[name="access:planning"][value="read"]');
      await Promise.all([p.waitForNavigation().catch(() => null), p.click('button.primary')]);
    });
    for (const v of ["desktop", "mobile"]) for (const sc of ["dark", "light"]) await go(async (p) => {
      await p.setViewport(VIEW[v]); await p.emulateMediaFeatures([{ name: "prefers-color-scheme", value: sc }, { name: "prefers-reduced-motion", value: "reduce" }]);
      await p.goto(`${MCP}/authorize?${q()}`);
      await Promise.all([p.waitForNavigation(), p.click('button.primary')]);
      await p.addStyleTag({ content: ".bar{position:static!important}" }); await new Promise((r) => setTimeout(r, 250));
      if (!/Welcome back/.test(await p.content())) throw Error("reconnect page did not show the earlier connection");
      const f = join(OUT, `reader-5-welcome-back-${v}-${sc}.png`); await p.screenshot({ path: f, fullPage: true }); shots.push(f);
    });
    // Error screen (an unregistered callback).
    for (const sc of ["dark", "light"]) await go(async (p) => {
      await p.setViewport(VIEW.desktop); await p.emulateMediaFeatures([{ name: "prefers-color-scheme", value: sc }, { name: "prefers-reduced-motion", value: "reduce" }]);
      const bad = q(); bad.set("resource", `${MCP}/v1`);
      await p.goto(`${MCP}/authorize?${bad}`);
      const f = join(OUT, `error-desktop-${sc}.png`); await p.screenshot({ path: f, fullPage: true }); shots.push(f);
    });
  }
  writeFileSync(join(OUT, "capture-log.json"), JSON.stringify({ shots, errors }, null, 1));
  console.log(JSON.stringify({ shots: shots.length, errors }, null, 1));
} finally {
  await browser?.close(); await h.stop();
}
