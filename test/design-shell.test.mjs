// Design pass (shell + project list): primary navigation, current crumb, labelled account menu, responsive
// bottom tab bar, narrow-width overflow and purposeful empty/no-match/error states. Real Chrome against the
// real local runtime (loopback, synthetic data).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { startServer, setupProject } from "./helpers.mjs";
import { SERVER_PORTS } from "./ports.mjs";

const require = createRequire(import.meta.url);
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PUPPETEER = `${process.env.HOME}/.npm-packages/lib/node_modules/puppeteer`;
const haveChrome = existsSync(CHROME) && existsSync(PUPPETEER);
const PORT = SERVER_PORTS["design-shell"], ORIGIN = `http://127.0.0.1:${PORT}`;
let s, h, browser, page;

before(async () => {
  s = await startServer("design-shell", PORT);
  h = await s.login();
  await setupProject(h, "alpha", "Alpha notes");
  await setupProject(h, "empty-one", "Empty project");
  await h.req("POST", "/api/projects/alpha/artifacts", { title: "First doc", body: "# First\n" });
  if (!haveChrome) return;
  browser = await require(PUPPETEER).launch({ executablePath: CHROME, headless: true, args: ["--no-first-run"] });
  page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(ORIGIN + "/");
  await page.waitForSelector('input[name="passphrase"]');
  assert.equal(await page.evaluate(() => document.body.classList.contains("signed-out")), true, "no app navigation before sign-in");
  assert.equal(await page.$$eval("#nav a", (a) => a.length), 0);
  await page.type('input[name="passphrase"]', s.passphrase());
  await Promise.all([page.waitForFunction(() => document.querySelectorAll("#nav a").length === 4), page.click('button[type="submit"]')]);
});
after(async () => { await browser?.close(); await s?.stop(); });

const current = () => page.evaluate(() => [...document.querySelectorAll("#nav a[aria-current=page]")].map((a) => a.dataset.nav));

test("primary navigation marks exactly the current section (home, projects, project, connections, settings)", { skip: !haveChrome && "Chrome not installed" }, async () => {
  for (const [hash, want, wait] of [["#/", "home", "First doc"], ["#/projects", "projects", "Alpha notes"], ["#/p/alpha", "projects", "First doc"],
    ["#/settings/apps", "connections", "Reader apps"], ["#/settings/api-keys", "connections", "API keys"], ["#/settings/device", "settings", "Storage limit"]]) {
    await page.goto(ORIGIN + "/" + hash); await page.waitForFunction((w) => document.body.innerText.includes(w), {}, wait);
    assert.deepEqual(await current(), [want], hash);
  }
  // Accessible name = visible text (WCAG 2.5.3): no aria-label overriding it.
  const names = await page.$$eval("#nav a", (a) => a.map((x) => [x.getAttribute("aria-label"), x.innerText.trim()]));
  assert.deepEqual(names, [[null, "Home"], [null, "Projects"], [null, "Connections"], [null, "Settings"]]);
});

test("brand: the approved Fold mark renders in the sidebar and mobile header (exact original crop, not the fallback tile)", { skip: !haveChrome && "Chrome not installed" }, async () => {
  const want = createHash("sha256").update(readFileSync(new URL("../src/web/brand/fold-mark-128.png", import.meta.url))).digest("hex");
  assert.equal(want, "ed862b3e0f232612e7dcab6541475509ff9d51600dc3df3bcf0020f8f66a8e68", "committed original crop unchanged");
  for (const vp of [{ width: 1440, height: 900 }, { width: 412, height: 923, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true }]) {
    await page.setViewport(vp);
    await page.goto(ORIGIN + "/#/"); await page.waitForSelector("#nav a");
    const r = await page.evaluate(async () => {
      const logo = [...document.querySelectorAll(".logo")].find((l) => l.getBoundingClientRect().width > 0);
      const img = logo.querySelector("img"); await img.decode();
      return { kind: logo.dataset.logo, hidden: logo.getAttribute("aria-hidden"), w: img.naturalWidth, shown: Math.round(img.getBoundingClientRect().width), src: img.src, text: logo.textContent };
    });
    // The page CSP (connect-src 'self') rightly blocks fetch(blob:), so read the decoded bytes through the shipped
    // script's own constant instead: the image's source data must be exactly the committed original crop.
    const shipped = await (await fetch(ORIGIN + "/app.js")).text();
    const b64 = /var FOLD_MARK_PNG = "([^"]+)"/.exec(shipped)[1];
    r.hash = createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex");
    assert.match(r.src, /^blob:/); delete r.src;
    assert.deepEqual(r, { kind: "fold", hidden: "true", w: 128, shown: 28, hash: want, text: "" }, JSON.stringify(vp));
  }
  await page.setViewport({ width: 1440, height: 900 });
});

test("installed-app icons are the Fold mark: manifest, favicon and touch icon serve the committed PNGs; old URLs serve them too", async () => {
  const brand = (f) => readFileSync(new URL("../src/web/brand/" + f, import.meta.url));
  const hash = (b) => createHash("sha256").update(b).digest("hex");
  const get = async (p) => { const r = await fetch(ORIGIN + p); assert.equal(r.status, 200, p); return r; };
  const bytes = async (p) => { const r = await get(p); assert.equal(r.headers.get("content-type"), "image/png", p); return hash(Buffer.from(await r.arrayBuffer())); };
  const manifest = await (await get("/manifest.webmanifest")).json();
  assert.deepEqual(manifest.icons.map((i) => [i.src, i.sizes, i.purpose]), [
    ["/icons/app-icon-192.png", "192x192", "any"], ["/icons/app-icon-512.png", "512x512", "any"], ["/icons/app-maskable-512.png", "512x512", "maskable"]]);
  for (const i of manifest.icons) assert.equal(await bytes(i.src), hash(brand(i.src.slice("/icons/".length))), i.src);
  const html = await (await get("/")).text();
  assert.match(html, /<link rel="icon" type="image\/png" sizes="192x192" href="\/icons\/app-icon-192\.png">/);
  assert.match(html, /<link rel="apple-touch-icon" href="\/icons\/app-apple-180\.png">/);
  assert.equal(await bytes("/icons/app-apple-180.png"), hash(brand("app-apple-180.png")));
  // Pages and launchers still holding the old URLs get the new mark, not the retired book icon.
  for (const [old, now] of [["icon-192.png", "app-icon-192.png"], ["icon-512.png", "app-icon-512.png"], ["maskable-512.png", "app-maskable-512.png"], ["apple-180.png", "app-apple-180.png"]])
    assert.equal(await bytes("/icons/" + old), hash(brand(now)), old);
  // A new shell cache name makes installed apps drop cached copies of the old shell and icons.
  const sw = await (await get("/sw.js")).text();
  assert.match(sw, /var SHELL = "al-shell-v2"/);
  assert.match(sw, /"\/icons\/app-icon-192\.png","\/icons\/app-apple-180\.png"/);
  assert.equal((await fetch(ORIGIN + "/icons/nope.png")).status, 404);
});

test("breadcrumb: earlier crumbs are links, the current page is text with aria-current", { skip: !haveChrome && "Chrome not installed" }, async () => {
  await page.goto(ORIGIN + "/#/projects"); await page.waitForFunction(() => document.body.innerText.includes("Alpha notes"));
  const crumbs = await page.$$eval("#crumbs > *:not(.sep)", (xs) => xs.map((x) => [x.tagName, x.textContent, x.getAttribute("aria-current")]));
  assert.deepEqual(crumbs, [["A", "Home", null], ["SPAN", "Projects", "page"]]);
  await page.goto(ORIGIN + "/#/p/alpha"); await page.waitForFunction(() => document.querySelector("#crumbs [aria-current=page]")?.textContent === "Alpha notes");
});

test("account menu is labelled with the signed-in account, keyboard operable, and returns focus", { skip: !haveChrome && "Chrome not installed" }, async () => {
  await page.goto(ORIGIN + "/#/"); await page.waitForSelector("button.acct");
  assert.equal(await page.$eval("button.acct", (b) => b.getAttribute("aria-label")), "Account: Owner");
  await page.focus("button.acct"); await page.keyboard.press("Enter");
  await page.waitForSelector(".menu:not([hidden])");
  assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), "Connected apps");
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), "API keys");
  await page.keyboard.press("Escape");
  assert.equal(await page.$(".menu:not([hidden])"), null);
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains("acct")), true, "focus returns to the account button");
});

test("project list: whole-row link without nested controls; distinct empty, no-match and error states", { skip: !haveChrome && "Chrome not installed" }, async () => {
  await page.goto(ORIGIN + "/#/projects"); await page.waitForFunction(() => document.body.innerText.includes("Alpha notes"));
  assert.equal(await page.$$eval(".list li.link a.stretch a, .list li.link a.stretch button", (x) => x.length), 0);
  await Promise.all([page.waitForFunction(() => location.hash === "#/p/alpha"), page.evaluate(() => { const li = [...document.querySelectorAll(".list li.link")].find((l) => l.innerText.includes("Alpha notes")); const r = li.getBoundingClientRect(); document.elementFromPoint(r.right - 40, r.top + r.height / 2).click(); })]);
  await page.goto(ORIGIN + "/#/p/empty-one"); await page.waitForFunction(() => document.body.innerText.includes("This project is empty"));
  await page.goto(ORIGIN + "/#/p/alpha"); await page.waitForFunction(() => document.body.innerText.includes("First doc"));
  await page.type("input[type=search]", "no-such-text-zz");
  await page.waitForFunction(() => document.body.innerText.includes("No matches for"));
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent === "Clear search").click());
  await page.waitForFunction(() => document.body.innerText.includes("First doc"));
  // Server error keeps the session and offers a retry; nothing is replaced optimistically.
  await page.setRequestInterception(true);
  const fail = (r) => (new URL(r.url()).pathname === "/api/projects" && r.method() === "GET" ? r.respond({ status: 500, contentType: "application/json", body: '{"error":{"code":"internal","message":"Synthetic failure"}}' }) : r.continue());
  page.on("request", fail);
  await page.goto(ORIGIN + "/#/projects"); await page.waitForFunction(() => document.body.innerText.includes("Projects couldn't load"));
  assert.equal(await page.$eval(".state.error", (e) => e.getAttribute("role")), "alert");
  page.off("request", fail); await page.setRequestInterception(false);
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Try again")).click());
  await page.waitForFunction(() => document.body.innerText.includes("Alpha notes"));
});

test("mobile: bottom tab bar with four labelled 44px+ destinations; no horizontal overflow at 390 or 320", { skip: !haveChrome && "Chrome not installed" }, async () => {
  for (const width of [390, 320]) {
    await page.setViewport({ width, height: 760, isMobile: true, hasTouch: true });
    for (const hash of ["#/", "#/projects", "#/p/alpha", "#/settings/apps"]) {
      await page.goto(ORIGIN + "/" + hash); await page.waitForSelector("#nav a");
      await new Promise((r) => setTimeout(r, 300));
      const m = await page.evaluate(() => ({ over: document.documentElement.scrollWidth - innerWidth, pos: getComputedStyle(document.querySelector(".side")).position,
        tabs: [...document.querySelectorAll("#nav a")].map((a) => { const r = a.getBoundingClientRect(); return [Math.round(r.height), r.bottom <= innerHeight + 1]; }) }));
      assert.ok(m.over <= 0, `${width} ${hash} overflows by ${m.over}px`);
      assert.equal(m.pos, "fixed");
      assert.equal(m.tabs.length, 4);
      assert.ok(m.tabs.every(([hgt, inView]) => hgt >= 44 && inView), JSON.stringify(m.tabs));
    }
  }
  await page.setViewport({ width: 1440, height: 900 });
});

test("navigation that starts inside main (row link, project tab, document row) never strands focus on <body>", { skip: !haveChrome && "Chrome not installed" }, async () => {
  const where = () => page.evaluate(() => (document.activeElement === document.body ? "BODY" : document.activeElement.id || document.activeElement.tagName));
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(ORIGIN + "/#/projects"); await page.waitForFunction(() => document.body.innerText.includes("Alpha notes"));
  await page.evaluate(() => [...document.querySelectorAll(".list li.link a.stretch")].find((a) => a.textContent === "Alpha notes").focus());
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => location.hash === "#/p/alpha" && document.body.innerText.includes("First doc"));
  assert.equal(await where(), "app", "project row -> project page");
  await page.evaluate(() => [...document.querySelectorAll("main .tabs a")].find((b) => b.textContent === "Trash").focus());
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.body.innerText.includes("Trash is empty"));
  assert.equal(await where(), "app", "project tab -> trash");
  await page.focus("#crumbs a"); await page.keyboard.press("Enter");
  await page.waitForFunction(() => location.hash === "#/p/alpha" && document.body.innerText.includes("First doc"));
  assert.equal(await where(), "app", "breadcrumb -> project");
  await page.focus(".list li.link a.stretch"); await page.keyboard.press("Enter");
  await page.waitForFunction(() => /#\/p\/alpha\/a\//.test(location.hash) && document.querySelector(".preview"));
  assert.equal(await where(), "app", "document row -> reader");
  // Document tabs switch views in place (not a route change): focus stays on the tab the user pressed.
  await page.evaluate(() => [...document.querySelectorAll("main .tabs button")].find((b) => b.textContent === "History").focus());
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => document.activeElement.textContent), "History");
  // WAI-ARIA tabs: one tab stop, arrows move + select, each tab controls a labelled tabpanel.
  await page.keyboard.press("ArrowRight");
  const t = await page.evaluate(() => { const a = document.activeElement, p = document.getElementById(a.getAttribute("aria-controls"));
    return { name: a.textContent, role: a.getAttribute("role"), sel: a.getAttribute("aria-selected"), stops: [...document.querySelectorAll("main [role=tab]")].filter((b) => b.tabIndex === 0).length,
      panel: p && p.getAttribute("role"), labelled: p && p.getAttribute("aria-labelledby") === a.id, visible: p && !p.hidden }; });
  assert.deepEqual(t, { name: "Comments", role: "tab", sel: "true", stops: 1, panel: "tabpanel", labelled: true, visible: true });
  await page.keyboard.press("Home");
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute("aria-selected") === "true" && document.activeElement.textContent), "Preview");
});

test("home filter is a pressed-button group over one list; errors are alerts, other messages polite", { skip: !haveChrome && "Chrome not installed" }, async () => {
  await page.goto(ORIGIN + "/#/"); await page.waitForFunction(() => document.body.innerText.includes("First doc"));
  const g = await page.evaluate(() => { const grp = document.querySelector("main [role=group]"); return { label: grp.getAttribute("aria-label"), btns: [...grp.querySelectorAll("button")].map((b) => [b.textContent, b.getAttribute("aria-pressed")]),
    tabs: document.querySelectorAll("main [role=tab]").length, listRole: document.querySelector("ul.home-list").getAttribute("role") }; });
  assert.deepEqual(g, { label: "Show", btns: [["Recently edited", "true"], ["Favorites", "false"]], tabs: 0, listRole: null });
  await page.evaluate(() => [...document.querySelectorAll("main [role=group] button")][1].click());
  await page.waitForFunction(() => document.body.innerText.includes("No favorites yet"));
  assert.equal(await page.$eval("main [role=group] button[aria-pressed=true]", (b) => b.textContent), "Favorites");
  await page.evaluate(() => [...document.querySelectorAll("main [role=group] button")][0].click());
  // Sign-in error is an alert; the same element would be a polite status for non-errors.
  const ctx = await browser.createBrowserContext(); const p2 = await ctx.newPage();
  await p2.goto(ORIGIN + "/"); await p2.waitForSelector('input[name="passphrase"]');
  await p2.type('input[name="passphrase"]', "wrong-passphrase"); await p2.click('button[type="submit"]');
  await p2.waitForFunction(() => { const m = document.querySelector("form .msg"); return m && m.textContent.length > 0; });
  assert.equal(await p2.$eval("form .msg", (m) => m.getAttribute("role")), "alert");
  await ctx.close();
});

test("in-app navigation moves focus to the new page content", { skip: !haveChrome && "Chrome not installed" }, async () => {
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(ORIGIN + "/#/"); await page.reload(); await page.waitForFunction(() => document.body.innerText.includes("First doc"));
  await page.focus('#nav a[data-nav="projects"]'); await page.keyboard.press("Enter");
  await page.waitForFunction(() => location.hash === "#/projects" && document.body.innerText.includes("Alpha notes"));
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === "app", { timeout: 3000 });
  assert.equal(await page.evaluate(() => document.activeElement.id), "app");
});

test("home: switching filters does not refetch; a return visit shows this tab's last list at once; sign-out clears it", { skip: !haveChrome && "Chrome not installed" }, async () => {
  const ctx = await browser.createBrowserContext(); const p = await ctx.newPage();
  try {
    await p.setViewport({ width: 1440, height: 900 });
    await p.goto(ORIGIN + "/"); await p.waitForSelector('input[name="passphrase"]');
    await p.type('input[name="passphrase"]', s.passphrase());
    await Promise.all([p.waitForFunction(() => document.querySelectorAll("#nav a").length === 4), p.click('button[type="submit"]')]);
    await p.goto(ORIGIN + "/#/"); await p.waitForFunction(() => document.body.innerText.includes("First doc"));
    await p.waitForFunction(() => Object.keys(sessionStorage).some((k) => k.startsWith("al:homecache:")));
    const fetched = []; p.on("request", (r) => { if (new URL(r.url()).pathname.startsWith("/api/projects")) fetched.push(r.url()); });
    await p.evaluate(() => [...document.querySelectorAll("main [role=group] button")][1].click());
    await p.waitForFunction(() => document.body.innerText.includes("No favorites yet"));
    await p.evaluate(() => [...document.querySelectorAll("main [role=group] button")][0].click());
    await p.waitForFunction(() => document.body.innerText.includes("First doc"));
    assert.deepEqual(fetched, [], "filters redraw the loaded list");

    // Hold the project list: on return, the rows can only come from the cache, and the refresh is still pending.
    await p.goto(ORIGIN + "/#/settings"); await p.waitForFunction(() => location.hash === "#/settings");
    let holding = true; const held = [];
    await p.setRequestInterception(true);
    const hold = (r) => { if (r.isInterceptResolutionHandled()) return; if (holding && new URL(r.url()).pathname === "/api/projects") held.push(r); else r.continue(); };
    p.on("request", hold);
    await p.evaluate(() => { location.hash = "#/"; });
    await p.waitForFunction(() => document.body.innerText.includes("First doc"));
    assert.ok(held.length >= 1, "refresh request is in flight while the cached list is shown");
    assert.equal(await p.$eval("main button.ghost", (b) => b.disabled), true, "Refresh is busy during the in-place refresh");
    assert.equal(await p.$("main ul.home-list[aria-busy]"), null, "no loading skeleton over the cached list");
    holding = false; held.forEach((r) => r.continue());
    await p.waitForFunction(() => !document.querySelector("main button.ghost").disabled);
    assert.ok((await p.evaluate(() => document.body.innerText)).includes("First doc"));
    p.off("request", hold);

    // A project that errors during an in-place refresh keeps the rows already shown for it.
    const fail = (r) => { if (r.isInterceptResolutionHandled()) return;
      if (new URL(r.url()).pathname === "/api/projects/alpha/artifacts") r.respond({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal" } }) }); else r.continue(); };
    p.on("request", fail);
    await p.click("main button.ghost");
    await p.waitForFunction(() => document.querySelector("main .msg").textContent.includes("couldn't refresh"));
    assert.ok((await p.evaluate(() => document.body.innerText)).includes("First doc"), "earlier rows stay");
    p.off("request", fail); await p.setRequestInterception(false);

    await p.click("button.acct"); await p.waitForSelector(".menu:not([hidden])");
    await Promise.all([p.waitForSelector('input[name="passphrase"]'),
      p.evaluate(() => [...document.querySelectorAll(".menu [role=menuitem]")].find((b) => b.textContent.trim() === "Sign out").click())]);
    assert.deepEqual(await p.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith("al:homecache:"))), []);
  } finally { await ctx.close(); }
});


test("reader connections show until disconnected instead of the storage sentinel date", { skip: !haveChrome && "Chrome not installed" }, async () => {
  const intercept = (r) => {
    if (new URL(r.url()).pathname !== "/api/access") return r.continue();
    return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ connections: [{
      id: "oac_synthetic12345", client_name: "Synthetic enduring reader", redirect_host: "reader.example.test",
      status: "active", projects: [{title: "Alpha notes", access: "read"}],
      created_at: new Date().toISOString(), expires_at: "9999-01-01T00:00:00.000Z", last_used_at: null
    }] }) });
  };
  await page.setRequestInterception(true); page.on("request", intercept);
  try {
    await page.goto(ORIGIN + "/#/settings/apps");
    await page.waitForFunction(() => document.body.innerText.includes("Synthetic enduring reader"));
    const text = await page.evaluate(() => document.body.innerText);
    assert.match(text, /Until you disconnect/); assert.doesNotMatch(text, /9999/);
    await page.screenshot({ path: new URL("../tmp/test-evidence/mcp-until-disconnected.png", import.meta.url).pathname, fullPage: true });
  } finally { page.off("request", intercept); await page.setRequestInterception(false); }
});
