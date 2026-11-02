// Project addresses in the browser (real Chrome via Puppeteer, real local server): an address link opens the
// document after signing in, the project page shows and copies its address, an admin changes it (old link then says
// "not available"), and someone without access gets the same "not available" as for an unknown address.
// Synthetic people only; screenshots go to tmp/test-evidence.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdirSync } from "node:fs";
import { startServer } from "./helpers.mjs";
import { SERVER_PORTS } from "./ports.mjs";

const require = createRequire(import.meta.url);
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PUPPETEER = `${process.env.HOME}/.npm-packages/lib/node_modules/puppeteer`;
const available = existsSync(CHROME) && existsSync(PUPPETEER);
const PORT = SERVER_PORTS["addresses-browser"];
const APP = `http://localhost:${PORT}`;
const EV = "tmp/test-evidence";
let s, browser, alice, bob, P, DOC;

before(async () => {
  mkdirSync(EV, { recursive: true });
  s = await startServer("addresses-browser", PORT, { vars: { APP_HOST: `localhost:${PORT}`, RATE_READS_PER_MIN: "100000", RATE_WRITES_PER_MIN: "100000", RATE_AUTHFAIL_PER_MIN: "100000" }, readyBase: APP });
  alice = await s.loginAt(APP, "alice"); bob = await s.loginAt(APP, "bob");
  const ws = (await alice.req("POST", "/api/workspaces", { name: "Acme Research", handle: "acme" })).body;
  P = (await alice.req("POST", "/api/projects", { title: "Q3 Notes", workspace_id: ws.id })).body;
  DOC = (await alice.req("POST", `/api/projects/${P.id}/artifacts`, { title: "Plan", body: "# Plan\n\nsynthetic quokka" })).body.artifact_id;
  if (available) browser = await require(PUPPETEER).launch({ executablePath: CHROME, headless: true, args: ["--no-first-run"] });
});
after(async () => { await browser?.close(); await s?.stop(); });

async function signedOutPage(width = 1280) {
  const ctx = await browser.createBrowserContext();
  await ctx.overridePermissions(APP, ["clipboard-read", "clipboard-write", "clipboard-sanitized-write"]);
  const page = await ctx.newPage();
  await page.setViewport({ width, height: 900 });
  return page;
}
async function signIn(page, user) {
  // The local passphrase form (Access and OIDC are server-side redirects that keep the same path).
  await page.waitForSelector("input[type=password]");
  await page.evaluate(async (passphrase, user) => (await fetch("/auth/dev-login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase, user }) })).status, s.passphrase(), user);
  await page.reload();
}
const waitText = (page, re) => page.waitForFunction((src) => new RegExp(src, "i").test(document.body.innerText), { timeout: 10000 }, re.source);

test("an address link opens the document after sign-in; the project page shows and copies its address", { timeout: 60000, skip: !available && "Chrome/puppeteer not installed" }, async () => {
  const page = await signedOutPage();
  await page.goto(`${APP}/acme/q3-notes/a/${DOC}`);
  await signIn(page, "alice");
  await waitText(page, /synthetic quokka/);
  assert.match(page.url(), new RegExp(`#/p/${P.id}/a/${DOC}`), "continues on the id route");
  // Copy link gives the address form.
  await (await page.waitForSelector("button[aria-label='Copy link']")).click();
  await waitText(page, /copied/);
  // (Documents open rendered; Copy link then names the Preview tab, as before.)
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `${APP}/acme/q3-notes/a/${DOC}/preview`);
  // Project page: address shown with a copy button and (admin) Project settings.
  await page.goto(`${APP}/acme/q3-notes`);
  await page.waitForSelector(".proj-addr code");
  assert.equal(await page.$eval(".proj-addr code", (c) => c.textContent), "/acme/q3-notes");
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: `${EV}/addresses-project.png` });
  await page.close();
});

test("an admin changes the project address; the old link then says not available, the new one works", { timeout: 60000, skip: !available && "Chrome/puppeteer not installed" }, async () => {
  const page = await signedOutPage();
  await page.goto(`${APP}/acme/q3-notes`);
  await signIn(page, "alice");
  await (await page.waitForSelector("xpath/.//button[normalize-space()='Project settings']")).click();
  await page.waitForSelector("#proj-slug");
  assert.equal(await page.evaluate(() => document.activeElement.id), "proj-title", "focus moves into the form");
  await page.$eval("#proj-slug", (i) => { i.value = ""; });
  await page.type("#proj-slug", "quarterly");
  await page.screenshot({ path: `${EV}/addresses-settings.png` });
  // Accept first (an assertion throwing inside the handler would leave the dialog open), then check its text.
  let dialogText = "";
  page.once("dialog", (d) => { dialogText = d.message(); d.accept(); });
  await (await page.waitForSelector("xpath/.//form[@aria-label='Project settings']//button[normalize-space()='Save']")).click();
  await page.waitForFunction(() => document.querySelector(".proj-addr code")?.textContent === "/acme/quarterly", { timeout: 10000 });
  assert.match(dialogText, /links to \/acme\/q3-notes will stop working\. Nobody loses access/);
  await page.goto(`${APP}/acme/q3-notes`); await page.reload();
  await waitText(page, /Project not available/);
  await page.goto(`${APP}/acme/quarterly`); await page.reload();
  await waitText(page, /Q3 Notes/);
  await page.close();
});

test("someone without access gets the same 'not available' as for an unknown address (mobile)", { timeout: 60000, skip: !available && "Chrome/puppeteer not installed" }, async () => {
  const page = await signedOutPage(390);
  await page.goto(`${APP}/acme/quarterly`);
  await signIn(page, "bob");
  await waitText(page, /Project not available/);
  const a = await page.evaluate(() => document.querySelector(".state")?.innerText);
  await page.screenshot({ path: `${EV}/addresses-not-available-mobile.png` });
  await page.goto(`${APP}/nope/nothing`); await page.reload();
  await waitText(page, /Project not available/);
  assert.equal(await page.evaluate(() => document.querySelector(".state")?.innerText), a);
  await page.close();
});
