// Screenshots of App Connect shared editing (docs/app-connect.md#shared-editing) against the REAL local runtime:
// the consent page's "Let people and agents edit these files too" box, the per-connection switch in
// Settings -> Connections -> Publishing apps (off and on), and an app's file edited by the owner with sharing on.
// Synthetic fixtures only (stand-in OIDC owner, synthetic projects, loopback callbacks that are never contacted).
// Usage: node scripts/design/shared-edit-capture.mjs --out tmp/design-captures/shared-edit [--port 21035]
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { startAppConnectServer } from "../../test/fixtures/app-connect-harness.mjs";
import { SERVER_PORTS } from "../../test/ports.mjs";

const require = createRequire(import.meta.url);
const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg("out", "tmp/design-captures/shared-edit");
const PORT = Number(arg("port", String(SERVER_PORTS["consent-capture"])));
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const puppeteer = require(`${process.env.HOME}/.npm-packages/lib/node_modules/puppeteer`);
mkdirSync(OUT, { recursive: true });
const b64u = (b) => Buffer.from(b).toString("base64url");
const s256 = (v) => createHash("sha256").update(v).digest("base64url");
const VIEW = { desktop: { width: 1280, height: 900 }, mobile: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shots = [], errors = [];

const h = await startAppConnectServer({ port: PORT });
const MCP = h.issuer, APP = h.appUi;
let browser;
try {
  const owner = await h.owner();
  for (const [id, title] of [["brigade", "Brigade"], ["notes", "Notes"]]) await owner.req("POST", "/api/projects", { id, title });
  const app = await h.registerApp({ display_name: "Brigade", redirect_uris: ["http://127.0.0.1:7320/v1/library/callback"] });
  // Two connections: one shared (ticked at consent), one app-only, so the Settings card shows both states.
  const shared = await h.connectPublisher(app, { project_id: "brigade", destination: "root", shared_edit: "1" });
  await h.connectPublisher(app, { project_id: "notes", destination: "new", new_folder_name: "Brigade exports" });
  const put = await fetch(`${h.api}/app/files/chief/reports/weekly.md`, { method: "PUT", body: "# Weekly report\n\nThree tasks closed.\n",
    headers: { authorization: `Bearer ${shared.access_token}`, "content-type": "text/markdown", "idempotency-key": "capture-weekly-1", "if-none-match": "*" } });
  const file = (await put.json()).file;
  // The owner edits the app's file (allowed only because sharing is on): History then shows both authors.
  const edit = await owner.req("PUT", `/api/projects/brigade/artifacts/${file.file_id}`, { expected_revision: 1, content: "# Weekly report\n\nThree tasks closed.\n\nOwner note: follow up on the billing task.\n" });
  if (edit.status !== 200) throw Error(`owner edit ${edit.status} ${JSON.stringify(edit.body)}`);

  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-first-run"] });
  const page = async (v, sc) => {
    const ctx = await browser.createBrowserContext(); const p = await ctx.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    await p.setViewport(VIEW[v]); await p.emulateMediaFeatures([{ name: "prefers-color-scheme", value: sc }, { name: "prefers-reduced-motion", value: "reduce" }]);
    return { ctx, p };
  };
  const save = async (p, name, full = true) => { const f = join(OUT, `${name}.png`); await p.screenshot({ path: f, fullPage: full }); shots.push(f); };

  // 1. Consent page: the new box (unticked by default, then ticked).
  for (const v of ["desktop", "mobile"]) for (const sc of ["light", "dark"]) {
    const { ctx, p } = await page(v, sc);
    const q = new URLSearchParams({ response_type: "code", client_id: app.client_id, redirect_uri: app.redirect_uris[0], scope: "agentlib:publish offline_access", state: "s" + randomBytes(4).toString("hex"), resource: `${MCP}/v1`, code_challenge: s256(b64u(randomBytes(32))), code_challenge_method: "S256", agentlib_project: "Brigade" });
    await p.goto(`${MCP}/authorize?${q}`);
    await Promise.all([p.waitForNavigation({ waitUntil: "load" }), p.click("button.primary")]);
    await p.addStyleTag({ content: ".bar{position:static!important}" });
    await p.click('input[name="resume"][value="new"]');
    if (await p.$eval('input[name="shared_edit"]', (e) => e.checked)) throw Error("shared_edit must start unticked");
    await wait(250); await save(p, `1-consent-unticked-${v}-${sc}`);
    await p.click('input[name="shared_edit"]'); await wait(150);
    const box = await p.$('label.check:has(input[name="shared_edit"])');
    await box.scrollIntoView(); await wait(150);
    const f = join(OUT, `2-consent-ticked-detail-${v}-${sc}.png`); await box.screenshot({ path: f, captureBeyondViewport: true }); shots.push(f);
    await ctx.close();
  }

  // 2. Settings -> Connections -> Publishing apps: one switch per connection (Brigade: on; Notes: off).
  const [cn, cv] = owner.cookie.split("=");
  for (const v of ["desktop", "mobile"]) for (const sc of ["light", "dark"]) {
    const { ctx, p } = await page(v, sc);
    await p.setCookie({ name: cn, value: cv, url: APP });
    await p.goto(`${APP}/#/settings/publishing`);
    await p.waitForFunction(() => document.querySelectorAll('input[aria-label^="Let people and agents edit"]').length === 2, { timeout: 15000 });
    await wait(400);
    await save(p, `3-settings-publishing-${v}-${sc}`);
    const card = await p.$('article.conn[aria-label="Brigade"]');
    if (card) { const f = join(OUT, `4-settings-card-detail-${v}-${sc}.png`); await card.screenshot({ path: f, captureBeyondViewport: true }); shots.push(f); }
    await ctx.close();
  }

  // 3. The app's file after the owner's edit: History shows the owner's version on top of the app's.
  for (const sc of ["light", "dark"]) {
    const { ctx, p } = await page("desktop", sc);
    await p.setCookie({ name: cn, value: cv, url: APP });
    await p.goto(`${APP}/#/p/brigade/a/${file.file_id}?tab=history`);
    await p.waitForFunction(() => /Owner note|Version 2|v2/.test(document.body.innerText), { timeout: 15000 }).catch(() => {});
    await wait(600);
    await save(p, `5-shared-file-history-desktop-${sc}`);
    await ctx.close();
  }
  writeFileSync(join(OUT, "capture-log.json"), JSON.stringify({ shots, errors }, null, 1));
  console.log(JSON.stringify({ shots: shots.length, errors }, null, 1));
} finally {
  await browser?.close(); await h.stop();
}
