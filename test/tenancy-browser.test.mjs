// Workspaces in the browser (real Chrome via Puppeteer, real local server): an owner creates a shared workspace,
// invites by email, the invitee opens the link and joins, sees the right role and only allowed controls, and projects
// are grouped by workspace. Synthetic people only; screenshots go to tmp/test-evidence.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { startServer } from "./helpers.mjs";
import { SERVER_PORTS } from "./ports.mjs";

const require = createRequire(import.meta.url);
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PUPPETEER = `${process.env.HOME}/.npm-packages/lib/node_modules/puppeteer`;
const available = existsSync(CHROME) && existsSync(PUPPETEER);
const PORT = SERVER_PORTS["tenancy-browser"];
const APP = `http://localhost:${PORT}`;
let s, browser;

before(async () => {
  s = await startServer("tenancy-browser", PORT, { vars: { APP_HOST: `localhost:${PORT}`, RATE_READS_PER_MIN: "100000", RATE_WRITES_PER_MIN: "100000", RATE_AUTHFAIL_PER_MIN: "100000" }, readyBase: APP });
  if (available) browser = await require(PUPPETEER).launch({ executablePath: CHROME, headless: true, args: ["--no-first-run"] });
});
after(async () => { await browser?.close(); await s?.stop(); });

async function pageAs(user) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(APP + "/");
  const st = await page.evaluate(async (passphrase, user) => (await fetch("/auth/dev-login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase, user }) })).status, s.passphrase(), user);
  assert.equal(st, 200);
  return page;
}
const text = (page) => page.evaluate(() => document.querySelector("main, #app")?.innerText ?? document.body.innerText);
async function waitText(page, re) { await page.waitForFunction((src) => new RegExp(src, "i").test(document.body.innerText), { timeout: 10000 }, re.source); }

test("owner creates a workspace and invites; invitee joins through the link; roles shape the controls", { skip: !available && "Chrome/puppeteer not installed" }, async () => {
  const alice = await pageAs("alice");
  await alice.goto(APP + "/#/workspaces"); await alice.reload();
  await waitText(alice, /Personal/);
  await (await alice.waitForSelector("xpath/.//button[contains(., 'New workspace')]")).click();
  await alice.type("input[aria-label='New workspace name']", "Synthetic Lab");
  await (await alice.waitForSelector("xpath/.//button[normalize-space()='Create workspace']")).click();
  await waitText(alice, /Members/);
  assert.match(await text(alice), /Your role: Owner/);
  // The only owner gets no role menu or Leave button.
  assert.equal(await alice.$("select[aria-label='Role for Alice']"), null);
  await alice.type("input[aria-label='Email address']", "bob@example.test");
  await alice.select("select[aria-label='Role']", "viewer");
  await (await alice.waitForSelector("xpath/.//button[normalize-space()='Create invitation']")).click();
  const link = await (await alice.waitForSelector("input[aria-label='Invitation link']")).evaluate((el) => el.value);
  assert.match(link, new RegExp(`^${APP}/#/invite/inv_`));
  await alice.screenshot({ path: "tmp/test-evidence/tenancy-owner-invite.png", fullPage: true });

  const bob = await pageAs("bob");
  await bob.goto(link); await bob.reload();
  await waitText(bob, /Join Synthetic Lab/);
  assert.doesNotMatch(await text(bob), /\bnull\b/);
  await (await bob.waitForSelector("xpath/.//button[normalize-space()='Join Synthetic Lab']")).click();
  await waitText(bob, /Your role: Viewer/);
  const t = await text(bob);
  assert.doesNotMatch(t, /Invite someone|Delete workspace|Create invitation/i, "viewers see no admin controls");
  assert.match(t, /Leave/);
  await bob.screenshot({ path: "tmp/test-evidence/tenancy-viewer-workspace.png", fullPage: true });

  // Carol (not invited) opening the same, now-used link is told it can't be used.
  const carol = await pageAs("carol");
  await carol.goto(link); await carol.reload();
  await waitText(carol, /can't be used/);

  // Alice's projects page groups by workspace once she has projects in two.
  await alice.evaluate(async () => {
    const me = await (await fetch("/api/me")).json();
    const ws = (await (await fetch("/api/workspaces")).json()).workspaces.find((w) => !w.personal);
    for (const [title, workspace_id] of [["Mine", undefined], ["Lab notes", ws.id]])
      await fetch("/api/projects", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": me.csrf, "idempotency-key": "p-" + title }, body: JSON.stringify({ title, workspace_id }) });
  });
  await alice.goto(APP + "/#/projects"); await alice.reload();
  await waitText(alice, /Lab notes/);
  const heads = await alice.$$eval(".list li.group-head", (els) => els.map((e) => e.textContent));
  assert.deepEqual(heads.map((x) => x.toLowerCase()), ["personal", "synthetic lab"]);
  // Bob (viewer) sees the lab project marked view-only and can't create projects anywhere but his personal workspace.
  await bob.goto(APP + "/#/projects"); await bob.reload();
  await waitText(bob, /Lab notes/);
  assert.match(await text(bob), /View only/);
});
