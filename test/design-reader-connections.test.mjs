// Design pass (reader/editor, conflict, connections, settings): real Chrome against the real local runtime
// (loopback, synthetic data, App Connect harness with a stand-in OIDC owner). Verifies behaviour, not CSS:
// - reader opens rendered-first with readable line length and a quiet metadata line; missing docs show a state
// - a real 409 conflict keeps the local draft, announces itself, focuses "Your text" and offers only existing actions
// - Connections separates reader apps from publishing apps and shows the SERVER's saved access (incl. revoked state)
// - a registered-but-unconnected publisher is not shown as having access
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { startAppConnectServer } from "./fixtures/app-connect-harness.mjs";
import { SERVER_PORTS } from "./ports.mjs";

const require = createRequire(import.meta.url);
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PUPPETEER = `${process.env.HOME}/.npm-packages/lib/node_modules/puppeteer`;
const haveChrome = existsSync(CHROME) && existsSync(PUPPETEER);
let h, owner, browser, page, docId, APP;

before(async () => {
  h = await startAppConnectServer({ port: SERVER_PORTS["design-reader"] });
  APP = h.appUi;
  owner = await h.owner();
  for (const [id, title] of [["read-a", "Reading A"], ["read-b", "Reading B"], ["solo", "Solo"]]) assert.equal((await owner.req("POST", "/api/projects", { id, title })).status, 201);
  docId = (await owner.req("POST", "/api/projects/read-a/artifacts", { title: "Long read", body: "# Long read\n\n" + "word ".repeat(400) + "\n" })).body.artifact_id;
  await h.connectMcpAgent({ "read-a": "write", "read-b": "read" });
  const app = await h.registerApp({ display_name: "Publisher Connected", redirect_uris: ["http://localhost:5173/cb"], origins: ["http://localhost:5173"] });
  await h.connectPublisher(app, { project_id: "solo", destination: "new", new_folder_name: "Exports" });
  await h.registerApp({ display_name: "Publisher Unconnected", redirect_uris: ["http://localhost:5174/cb"], origins: [] });
  if (!haveChrome) return;
  browser = await require(PUPPETEER).launch({ executablePath: CHROME, headless: true, args: ["--no-first-run"] });
  page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const [cn, cv] = owner.cookie.split("=");
  await page.setCookie({ name: cn, value: cv, url: APP });
  await page.goto(APP + "/#/"); await page.waitForSelector("#nav a");
});
after(async () => { await browser?.close(); await h?.stop(); });

test("reader: a document opened before project titles load shows the title once they arrive", { skip: !haveChrome && "Chrome not installed" }, async () => {
  const ctx = await browser.createBrowserContext(); const p = await ctx.newPage();
  try {
    const [cn, cv] = owner.cookie.split("=");
    await p.setCookie({ name: cn, value: cv, url: APP });
    let holding = true; const held = [];
    await p.setRequestInterception(true);
    const hold = (r) => { if (r.isInterceptResolutionHandled()) return; if (holding && new URL(r.url()).pathname === "/api/projects") held.push(r); else r.continue(); };
    p.on("request", hold);
    await p.goto(`${APP}/#/p/read-a/a/${docId}`); await p.waitForSelector(".preview p");
    assert.match(await p.$eval(".doc-meta", (e) => e.textContent), /^Doc · read-a · updated /, "project id while titles are unknown");
    assert.ok(held.length >= 1);
    holding = false; held.forEach((r) => r.continue());
    await p.waitForFunction(() => /^Doc · Reading A · updated /.test(document.querySelector(".doc-meta").textContent));
    p.off("request", hold); await p.setRequestInterception(false);
  } finally { await ctx.close(); }
});

test("reader: rendered first, readable measure, quiet metadata; missing document shows a recoverable state", { skip: !haveChrome && "Chrome not installed" }, async () => {
  await page.goto(`${APP}/#/p/read-a/a/${docId}`); await page.waitForSelector(".preview p");
  const m = await page.evaluate(() => {
    const p = document.querySelector(".preview p"), cs = getComputedStyle(p);
    const ch = (() => { const s = document.createElement("span"); s.textContent = "0".repeat(100); s.style.font = cs.font; s.style.position = "absolute"; document.body.append(s); const w = s.getBoundingClientRect().width / 100; s.remove(); return w; })();
    return { chars: p.getBoundingClientRect().width / ch, tab: document.querySelector(".tabs button[aria-selected=true]").textContent, meta: document.querySelector(".doc-meta")?.textContent };
  });
  assert.equal(m.tab, "Preview");
  assert.ok(m.chars <= 80, `line length ~${Math.round(m.chars)}ch`);
  // The project title may arrive after the document (fetched in the background); the line must then show it.
  await page.waitForFunction(() => /^Doc · Reading A · updated /.test(document.querySelector(".doc-meta")?.textContent ?? ""), { timeout: 5000 })
    .catch(() => assert.fail(`metadata line: ${m.meta}`));
  await page.goto(`${APP}/#/p/read-a/a/art_doesnotexist000`);
  await page.waitForFunction(() => document.body.innerText.includes("This item isn't available"));
  assert.equal(await page.$eval(".state.error", (e) => e.getAttribute("role")), "alert");
  assert.ok(await page.evaluate(() => [...document.querySelectorAll("main a")].some((a) => a.textContent === "Back to project")));
});

test("conflict: real 409 keeps the local draft, announces, focuses 'Your text', no automatic merge", { skip: !haveChrome && "Chrome not installed" }, async () => {
  await page.goto(`${APP}/#/p/read-a/a/${docId}/edit`);
  await page.waitForFunction(() => window.__alActiveEditor && window.__alActiveEditor());
  const before = await owner.req("GET", `/api/projects/read-a/artifacts/${docId}`);
  // Someone else saves first.
  assert.equal((await owner.req("PUT", `/api/projects/read-a/artifacts/${docId}`, { expected_revision: before.body.revision.rev, body: before.body.body + "\nElsewhere.\n" })).status, 200);
  await page.evaluate(() => { const ed = window.__alActiveEditor(); ed.focus(); try { ed.setSelectionRange(ed.value.length, ed.value.length); } catch {} });
  await page.keyboard.type(" Mine-local-change");
  await page.waitForFunction(() => document.querySelector(".status")?.dataset.state === "conflict", { timeout: 15000 });
  const st = await page.evaluate(() => ({
    status: document.querySelector(".status").textContent, live: document.querySelector(".status").getAttribute("aria-live"),
    region: document.querySelector(".conflict")?.getAttribute("role"), heading: document.querySelector("#conflict-title")?.textContent,
    mine: document.querySelector("#conflict-mine")?.value, theirs: document.querySelector("#conflict-theirs")?.value,
    focused: document.activeElement?.id, buttons: [...document.querySelectorAll(".conflict button")].map((b) => b.textContent),
  }));
  assert.equal(st.status, "Conflict - not saved"); assert.equal(st.live, "polite"); assert.equal(st.region, "region");
  assert.match(st.heading, /Not saved/);
  assert.match(st.mine, /Mine-local-change/, "local draft kept");
  await page.waitForFunction(() => /Elsewhere\./.test(document.querySelector("#conflict-theirs").value));
  assert.doesNotMatch(await page.$eval("#conflict-theirs", (t) => t.value), /Mine-local-change/, "no automatic merge");
  assert.equal(st.focused, "conflict-mine");
  assert.deepEqual(st.buttons, ["Copy my text", "Load latest (discard mine)", "Save mine over latest"]);
  // Nothing was saved by the conflict itself.
  const after = await owner.req("GET", `/api/projects/read-a/artifacts/${docId}`);
  assert.equal(after.body.revision.rev, before.body.revision.rev + 1);
  assert.doesNotMatch(after.body.body, /Mine-local-change/);
  await page.evaluate(() => { for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k.startsWith("al:draft:")) localStorage.removeItem(k); } });
});

test("connections: reader apps show the server's saved per-project access; revoking updates from the server", { skip: !haveChrome && "Chrome not installed" }, async () => {
  page.on("dialog", (d) => d.accept());
  await page.goto(`${APP}/#/settings/apps`); await page.waitForSelector("article.conn");
  const card = await page.$eval("article.conn", (c) => ({ name: c.getAttribute("aria-label"), access: [...c.querySelectorAll(".conn-access li")].map((l) => l.textContent), badge: c.querySelector(".badge").textContent }));
  assert.equal(card.name, "synthetic agent");
  assert.deepEqual(card.access.sort(), ["Reading Aread & edit", "Reading Bread"]);
  assert.equal(card.badge, "Active");
  assert.equal(await page.$eval("#nav a[aria-current=page]", (a) => a.dataset.nav), "connections");
  await page.evaluate(() => [...document.querySelectorAll("article.conn button")].find((b) => b.textContent === "Disconnect").click());
  await page.waitForFunction(() => document.body.innerText.includes("No active reader apps"));
  const api = await owner.req("GET", "/api/access");
  assert.equal(api.body.connections[0].status, "revoked");
  await page.evaluate(() => document.querySelector("input[type=checkbox]").click());
  await page.waitForFunction(() => document.querySelector("article.conn .badge")?.textContent === "Revoked");
  assert.match(await page.$eval("article.conn", (c) => c.innerText), /Had access to \(no longer active\)/);
});

test("connections: publishing apps are separate; only a connected publisher shows a destination", { skip: !haveChrome && "Chrome not installed" }, async () => {
  await page.goto(`${APP}/#/settings/publishing`);
  await page.waitForFunction(() => document.querySelectorAll("article.conn").length === 2);
  const cards = await page.$$eval("article.conn", (cs) => Object.fromEntries(cs.map((c) => [c.getAttribute("aria-label"), { badge: c.querySelector(".badge").textContent, access: [...c.querySelectorAll(".conn-access li")].map((l) => l.textContent), text: c.innerText }])));
  assert.equal(cards["Publisher Connected"].badge, "Active");
  assert.deepEqual(cards["Publisher Connected"].access, ["Soloown folder · no exports yet"]);
  assert.equal(cards["Publisher Unconnected"].badge, "Registered");
  assert.deepEqual(cards["Publisher Unconnected"].access, []);
  assert.match(cards["Publisher Unconnected"].text, /Not connected to any project yet/);
  assert.equal(await page.$eval(".tabs a[aria-current=page]", (b) => b.textContent), "Publishing apps");
});

test("connections: API key project picker is one aligned list with a live selected count", { skip: !haveChrome && "Chrome not installed" }, async () => {
  await page.goto(`${APP}/#/settings/api-keys`); await page.waitForSelector(".scope-row");
  await page.evaluate(() => {
    [...document.querySelectorAll("details")].find((d) => d.querySelector("summary")?.textContent === "Create an API key").open = true;
  });
  const info = () => page.evaluate(() => {
    const rows = [...document.querySelectorAll(".scope-row")];
    return { count: document.querySelector(".scope-count").textContent, on: rows.filter((r) => r.classList.contains("on")).length,
      selectLefts: new Set(rows.map((r) => Math.round(r.querySelector("select").getBoundingClientRect().left))).size,
      visibleRows: rows.filter((r) => { const b = r.querySelector("select").getBoundingClientRect(); return b.width > 0 && b.height > 0; }).length, n: rows.length };
  });
  const a = await info();
  assert.ok(a.n >= 2); assert.equal(a.count, "None selected"); assert.equal(a.on, 0);
  assert.equal(a.visibleRows, a.n, "measure the open, visible project picker rather than hidden zero-width controls");
  assert.equal(a.selectLefts, 1, "access selects share one column");
  await page.evaluate(() => { const s = document.querySelector(".scope-row select"); s.value = "read_write"; s.dispatchEvent(new Event("change")); });
  const b = await info();
  assert.equal(b.count, `1 of ${b.n} selected`); assert.equal(b.on, 1);
});

test("settings: own section; loading/error state for connections keeps nothing optimistic", { skip: !haveChrome && "Chrome not installed" }, async () => {
  await page.goto(`${APP}/#/settings/device`); await page.waitForFunction(() => document.body.innerText.includes("Storage limit"));
  assert.equal(await page.$eval("#nav a[aria-current=page]", (a) => a.dataset.nav), "settings");
  assert.equal(await page.$eval("main h1", (e) => e.textContent), "Settings");
  await page.setRequestInterception(true);
  const fail = (r) => (new URL(r.url()).pathname === "/api/access" ? r.respond({ status: 503, contentType: "application/json", body: '{"error":{"code":"unavailable","message":"Synthetic outage"}}' }) : r.continue());
  page.on("request", fail);
  await page.goto(`${APP}/#/settings/apps`);
  await page.waitForFunction(() => document.body.innerText.includes("Connections couldn't load"));
  assert.match(await page.$eval(".state.error", (e) => e.innerText), /No access was changed/);
  assert.equal(await page.$("article.conn"), null, "no cards rendered from a failed load");
  page.off("request", fail); await page.setRequestInterception(false);
});
