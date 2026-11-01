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
  // A path, not a #fragment, so it survives a sign-in redirect.
  assert.match(link, new RegExp(`^${APP}/invite/inv_`));
  // The pending list refreshes while the link stays on screen.
  await waitText(alice, /bob@example\.test[\s\S]*Viewer · expires/);
  await alice.screenshot({ path: "tmp/test-evidence/tenancy-owner-invite.png", fullPage: true });

  // Signed-out invitee: the link survives signing in (passphrase form here; Access is a server-side redirect to the
  // same path), then shows the invitation. The token is never saved for resume.
  const bobCtx = await browser.createBrowserContext();
  const bob = await bobCtx.newPage();
  await bob.setViewport({ width: 1280, height: 900 });
  await bob.goto(link);
  await bob.waitForSelector('input[name="passphrase"]');
  assert.match(await bob.evaluate(() => location.hash), /^#\/invite\/inv_/);
  await bob.evaluate(async (passphrase) => fetch("/auth/dev-login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase, user: "bob" }) }), s.passphrase());
  await bob.reload();
  await waitText(bob, /Join Synthetic Lab/);
  assert.match(await text(bob), /Alice invited you as Viewer/);
  assert.doesNotMatch(await text(bob), /\bnull\b/);
  await (await bob.waitForSelector("xpath/.//button[normalize-space()='Join Synthetic Lab']")).click();
  await waitText(bob, /Your role: Viewer/);
  assert.equal(await bob.evaluate(() => Object.keys(localStorage).some((k) => /invite/.test(localStorage.getItem(k) || ""))), false, "invite token never stored");
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
  const heads = await alice.$$eval(".ws-group h2", (els) => els.map((e) => e.textContent));
  assert.deepEqual(heads.map((x) => x.toLowerCase()), ["personal", "synthetic lab"]);
  // Role changes are a pending choice: arrowing through the menu changes nothing until Save role (and owner/admin asks).
  await alice.goto(APP + "/#/workspaces"); await alice.reload();
  await (await alice.waitForSelector("xpath/.//a[normalize-space()='Synthetic Lab']")).click();
  const sel = await alice.waitForSelector("select[aria-label='Role for Bob']");
  await sel.focus(); await alice.keyboard.press("ArrowDown"); await alice.keyboard.press("ArrowDown");
  await new Promise((r) => setTimeout(r, 500));
  const roles = await alice.evaluate(async () => (await (await fetch(location.pathname.replace(/.*/, "/api/workspaces/") + location.hash.split("/")[2] + "/members")).json()).members.map((m) => m.role));
  assert.deepEqual(roles, ["owner", "viewer"], "no role saved without Save role");
  // Bob (viewer) sees the lab project marked view-only and can't create projects anywhere but his personal workspace.
  await bob.goto(APP + "/#/projects"); await bob.reload();
  await waitText(bob, /Lab notes/);
  assert.match(await text(bob), /View only/);
  // In the project, a viewer gets no New document / Upload and a view-only note instead.
  await (await bob.waitForSelector("xpath/.//a[normalize-space()='Lab notes']")).click();
  await waitText(bob, /view-only access/);
  assert.equal(await bob.$("xpath/.//button[contains(., 'New document')]"), null);
  assert.equal(await bob.$("xpath/.//button[contains(., 'Upload')]"), null);
  await bob.screenshot({ path: "tmp/test-evidence/tenancy-viewer-project.png", fullPage: true });
});

test("a demoted viewer's unsaved draft is never saved; it stays readable with Copy and Discard", { skip: !available && "Chrome/puppeteer not installed" }, async () => {
  const alice = await pageAs("alice");
  const bob = await pageAs("bob");
  // Alice writes a document in Lab notes (Bob is a viewer there after the test above).
  const ids = await alice.evaluate(async () => {
    const me = await (await fetch("/api/me")).json();
    const p = (await (await fetch("/api/projects")).json()).projects.find((x) => x.title === "Lab notes");
    const d = await (await fetch(`/api/projects/${p.id}/artifacts`, { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": me.csrf, "idempotency-key": "doc-draft-1" }, body: JSON.stringify({ title: "Draft target", body: "synthetic saved text" }) })).json();
    return { pid: p.id, aid: d.artifact_id };
  });
  // Bob left a local draft from when he could edit (same key format as the app: al:draft:<me>:<pid>:<aid>).
  const puts = [];
  bob.on("request", (r) => { if (r.method() === "PUT" && r.url().includes(ids.aid)) puts.push(r.url()); });
  await bob.evaluate(async (ids) => {
    const me = await (await fetch("/api/me")).json();
    localStorage.setItem(`al:draft:${me.principal.id}:${ids.pid}:${ids.aid}`, JSON.stringify({ base: 1, body: "synthetic unsaved words", at: Date.now() }));
  }, ids);
  // Fresh load straight into the editor link: no cached project list, so access comes with the document.
  await bob.goto(`${APP}/#/p/${ids.pid}/a/${ids.aid}/edit`); await bob.reload();
  await waitText(bob, /weren't saved/);
  await new Promise((r) => setTimeout(r, 2000)); // longer than the 800 ms draft autosave
  assert.deepEqual(puts, [], "no save attempted for a viewer");
  assert.equal(await bob.$("[role=tab][aria-controls*=edit], .ed-host"), null, "no editor for a viewer");
  const kept = await bob.$eval(".unsaved-draft textarea", (t) => ({ value: t.value, ro: t.readOnly }));
  assert.deepEqual(kept, { value: "synthetic unsaved words", ro: true });
  assert.ok(await bob.$("xpath/.//button[normalize-space()='Copy text']"));
  await bob.screenshot({ path: "tmp/test-evidence/tenancy-viewer-unsaved-draft.png", fullPage: true });
  // Discard clears the local draft.
  bob.once("dialog", (d) => d.accept());
  await (await bob.$("xpath/.//button[normalize-space()='Discard']")).click();
  const left = await bob.evaluate((ids) => Object.keys(localStorage).filter((k) => k.endsWith(`${ids.pid}:${ids.aid}`)).length, ids);
  assert.equal(left, 0);
  await alice.browserContext().close(); await bob.browserContext().close();
});
