// Real Worker/D1/R2 and Chrome coverage for bounded server rendering. Synthetic text only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { request } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startServer, LOCAL_CONFIG, ROOT, sha256 } from "./helpers.mjs";
import { SERVER_PORTS } from "./ports.mjs";
import { RENDER_MAX_BYTES } from "../packages/core/src/text-limits.js";
const MAX = RENDER_MAX_BYTES, port = SERVER_PORTS["render-limit"], APP = `http://localhost:${port}`, CONTENT = `content.localhost:${port}`;
const NOTE = "Preview shows the first 1 MB. Open Edit for the full text.";
const NOTICE = "This page is larger than 1 MB, so it isn't shown here. Open Edit to see its source.";
const VIEW_NOTE = "Preview shows the first 1 MB. Use Show full text in History for the full text.";
const VIEW_NOTICE = "This page is larger than 1 MB, so it isn't shown here. Use Show full text in History to see its source.";
const CONTENT_NOTICE = "This page is larger than 1 MB and cannot be shown.";
let s, owner, viewer, pid, ws, blockedPath;
const ids = {};
const base = id => `/api/projects/${pid}/artifacts/${id}`;
const sql = async q => JSON.parse((await promisify(execFile)("wrangler", ["d1", "--config", LOCAL_CONFIG, "execute", "DB", "--local", "--persist-to", s.dir, "--json", "--command", q], { cwd: ROOT, encoding: "utf8" })).stdout)[0].results;
const nav = id => fetch(APP + base(id) + "/render", { headers: { cookie: owner.cookie, "sec-fetch-dest": "iframe" }, redirect: "manual" });
function content(path) {
  return new Promise((resolve, reject) => {
    const rq = request({ host: "127.0.0.1", port, path, headers: { host: CONTENT } }, r => {
      let body = ""; r.on("data", b => body += b); r.on("end", () => resolve({ status: r.statusCode, body }));
    }); rq.on("error", reject); rq.end();
  });
}
async function make(kind, body, key) {
  const r = await owner.req("POST", `/api/projects/${pid}/artifacts`, { title: `Synthetic ${key}`, kind, body });
  assert.equal(r.status, 201, JSON.stringify(r.body)); return ids[key] = r.body.artifact_id;
}
before(async () => {
  s = await startServer("render-limit", port, { readyBase: APP, vars: { APP_HOST: `localhost:${port}`, MCP_HOST: `127.0.0.1:${port}`, CONTENT_HOST: CONTENT, RATE_READS_PER_MIN: "100000", RATE_WRITES_PER_MIN: "100000" } });
  owner = await s.loginAt(APP); viewer = await s.loginAt(APP, "viewer");
  ws = (await owner.req("POST", "/api/workspaces", { name: "Synthetic rendering" })).body.id;
  pid = (await owner.req("POST", "/api/projects", { title: "Render limits", workspace_id: ws })).body.id;
  const invite = await owner.req("POST", `/api/workspaces/${ws}/invites`, { email: "viewer@example.test", role: "viewer" });
  assert.equal((await viewer.req("POST", "/api/invites/accept", { token: invite.body.accept_url.split("/").pop() })).status, 200);
  const early = "# early-render-marker\n";
  const largeMarkdown = early + "word ".repeat(Math.ceil(MAX / 5)).slice(0, MAX - early.length - 2) + "\né";
  await make("markdown", largeMarkdown, "largeMarkdown");
  await make("markdown", "# Small Markdown", "smallMarkdown");
  await make("html", "<h1>Exact HTML</h1>".padEnd(MAX, " "), "exactHtml");
  await make("html", "<h1>Large HTML source</h1>".padEnd(MAX + 1, " "), "largeHtml");
  await make("html", "<h1>Small HTML</h1>", "smallHtml");
  for (const kind of ["markdown", "html"]) {
    const heading = kind === "markdown" ? "# Crossing Markdown\n" : "<h1>Crossing HTML</h1>\n";
    const line = kind === "markdown" ? "word ".repeat(40) + "\n" : "<!-- " + "word ".repeat(40) + " -->\n";
    const body = (heading + line.repeat(Math.ceil(MAX / line.length))).slice(0, MAX - 16);
    assert.equal(Buffer.byteLength(body), MAX - 16);
    await make(kind, body, `crossing-${kind}`);
  }
  // A previously issued link from before this restriction: repoint a small-page link.
  const old = await nav(ids.exactHtml); blockedPath = new URL(old.headers.get("location")).pathname;
  await sql(`UPDATE view_links SET artifact_id = '${ids.largeHtml}' WHERE token_hash = '${sha256(blockedPath.slice(3))}'`);
});
after(async () => { await s?.stop(); });
test("browser render budget matches the one server constant", () => {
  const js = readFileSync(new URL("../packages/core/src/web/app.js.txt", import.meta.url), "utf8");
  assert.equal(Number(js.match(/var RENDER_MAX_BYTES = (\d+);/)[1]), RENDER_MAX_BYTES);
});
test("Markdown boundary, line cut, UTF-8 boundary, suffix references and 10 MiB preview", async () => {
  const early = "# early-render-marker\n";
  const body = early + "word ".repeat(Math.ceil(MAX / 5)).slice(0, MAX - early.length - 2) + "\né";
  assert.equal(Buffer.byteLength(body), MAX + 1); // é straddles the read boundary
  const r = await owner.req("GET", base(ids.largeMarkdown) + "/preview");
  assert.equal(r.status, 200); assert.equal(r.body.truncated, true);
  assert.match(r.body.html, /early-render-marker/); assert.doesNotMatch(r.body.html, /é|\ufffd/);
  const noLine = early + "word ".repeat(Math.ceil(MAX / 5)).slice(0, MAX - early.length - 1) + "🙂";
  await make("markdown", noLine, "utf8Markdown");
  const utf8 = await owner.req("GET", base(ids.utf8Markdown) + "/preview");
  assert.equal(utf8.status, 200); assert.equal(utf8.body.truncated, true);
  assert.doesNotMatch(utf8.body.html, /🙂|\ufffd/);
  assert.ok(utf8.body.html.length > MAX - 100, "without a nearby line break only the partial character is removed");
  const small = early + "word ".repeat(Math.ceil(MAX / 5)).slice(0, MAX - early.length - 18) + " exact-end-marker!";
  assert.equal(Buffer.byteLength(small), MAX);
  await make("markdown", small, "exactMarkdown");
  const exact = await owner.req("GET", base(ids.exactMarkdown) + "/preview");
  assert.equal(exact.status, 200); assert.equal(exact.body.truncated, false); assert.match(exact.body.html, /exact-end-marker!/);
  const lastLine = "\nlast-complete-line\n";
  const prefix = early + "word ".repeat(Math.ceil(MAX / 5)).slice(0, MAX - early.length - lastLine.length - 100) + lastLine;
  const suffix = "after-cut-marker ![late](art_aftercut)";
  const large = prefix + "x".repeat(100) + suffix + " word".repeat(Math.ceil(10 * MAX / 5));
  await make("markdown", large.slice(0, 10 * MAX), "tenMarkdown");
  const ten = await owner.req("GET", base(ids.tenMarkdown) + "/preview");
  assert.equal(ten.status, 200); assert.equal(ten.body.truncated, true);
  assert.match(ten.body.html, /early-render-marker/); assert.match(ten.body.html, /last-complete-line/);
  assert.doesNotMatch(ten.body.html, /after-cut-marker|art_aftercut|x{100}/);
  assert.ok(Buffer.byteLength(JSON.stringify(ten.body)) < MAX + 1024);
});
test("HTML boundary, refusal before redirect, old large links/media and still-valid small links", async () => {
  const exact = await owner.req("GET", base(ids.exactHtml) + "/render");
  assert.equal(exact.status, 200); assert.match(exact.body, /Exact HTML/);
  const good = await nav(ids.exactHtml), goodPath = new URL(good.headers.get("location")).pathname;
  assert.equal((await content(goodPath)).status, 200);
  const linkCount = (await sql(`SELECT COUNT(*) AS n FROM view_links WHERE artifact_id = '${ids.largeHtml}'`))[0].n;
  const tooLarge = await owner.req("GET", base(ids.largeHtml) + "/render");
  assert.equal(tooLarge.status, 413); assert.equal(tooLarge.body.error.code, "render_too_large");
  assert.equal((await nav(ids.largeHtml)).status, 413);
  assert.equal((await sql(`SELECT COUNT(*) AS n FROM view_links WHERE artifact_id = '${ids.largeHtml}'`))[0].n, linkCount);
  for (const path of [blockedPath, blockedPath + "/m/art_aftercut"]) {
    const r = await content(path); assert.equal(r.status, 413); assert.equal(r.body, CONTENT_NOTICE);
  }
  assert.equal((await content(goodPath)).status, 200);
});
test("wrong-kind render routes look up the revision before checking kind", async () => {
  for (const [key, route, message] of [["smallHtml", "preview", "Not Markdown"], ["smallMarkdown", "render", "Not an HTML document"]]) {
    for (const rev of [999, 1]) {
      const r = await owner.req("GET", base(ids[key]) + `/${route}?rev=${rev}`);
      assert.equal(r.status, rev === 999 ? 404 : 400);
      assert.equal(r.body.error.code, rev === 999 ? "not_found" : "invalid_input");
      assert.equal(r.body.error.message, rev === 999 ? "Revision not found" : message);
    }
  }
});
test("Chrome: saved editor changes cross the render limit in both directions without reloading", { timeout: 180000 }, async () => {
  const puppeteer = createRequire(import.meta.url)(`${process.env.HOME}/.npm-packages/lib/node_modules/puppeteer`);
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    const [name, value] = owner.cookie.split("="); await page.setCookie({ name, value, url: APP });
    const errors = [], renders = [];
    page.on("pageerror", e => errors.push(e.message));
    page.on("request", r => { if (new URL(r.url()).pathname.endsWith("/render")) renders.push(r.url()); });
    const tab = async text => {
      await page.evaluate(text => [...document.querySelectorAll('[role="tab"]')].find(e => e.textContent === text).click(), text);
    };
    const saved = async rev => page.waitForFunction(rev => document.querySelector(".status")?.textContent === `Saved - rev ${rev}`, {}, rev);
    const loadedPage = async () => {
      const frame = await page.waitForFrame(f => f.url().startsWith(`http://${CONTENT}/c/`));
      await frame.waitForFunction(() => document.querySelector("h1")?.textContent === "Crossing HTML");
    };
    for (const kind of ["markdown", "html"]) {
      const id = ids[`crossing-${kind}`], html = kind === "html", view = html ? "Page" : "Preview";
      await page.goto(`${APP}/#/p/${pid}/a/${id}`);
      if (html) await loadedPage();
      else await page.waitForFunction(() => document.querySelector(".preview h1")?.textContent === "Crossing Markdown");
      assert.equal(await page.$eval(html ? ".render-notice" : ".preview-note", e => e.hidden), true);
      // A document-local marker proves neither crossing reloads the app document.
      await page.evaluate(() => { window.renderLimitDocument = true; });
      await tab("Edit"); await page.waitForSelector(".cm-content", { visible: true });
      renders.length = 0;
      await page.click(".cm-content");
      await page.keyboard.sendCharacter("x".repeat(64));
      await page.click(".footbar button"); await saved(2);
      const over = await owner.req("GET", base(id));
      assert.equal(over.body.revision.size, MAX + 48);
      await tab(view);
      const note = html ? NOTICE : NOTE;
      await page.waitForFunction((selector, text) => {
        const e = document.querySelector(selector); return e && !e.hidden && e.textContent === text;
      }, {}, html ? ".render-notice" : ".preview-note", note);
      if (html) {
        assert.deepEqual(renders, [], "over-limit saved version never requests /render");
        assert.equal(await page.$eval("iframe.htmlview", e => e.getAttribute("src")), null);
      }
      await tab("Edit"); await page.click(".cm-content");
      // Undo the single insertion through the editor, then use the normal Save now path again.
      const modifier = process.platform === "darwin" ? "Meta" : "Control";
      await page.keyboard.down(modifier); await page.keyboard.press("z"); await page.keyboard.up(modifier);
      await page.click(".footbar button"); await saved(3);
      const under = await owner.req("GET", base(id));
      assert.equal(under.body.revision.size, MAX - 16);
      await tab(view);
      if (html) {
        await page.waitForFunction(() => document.querySelector("iframe.htmlview")?.getAttribute("src")?.endsWith("/render?rev=3"));
        await loadedPage();
        assert.ok(renders.some(url => url.endsWith("/render?rev=3")));
      } else await page.waitForFunction(() => document.querySelector(".preview h1")?.textContent === "Crossing Markdown" && document.querySelector(".preview-note")?.hidden);
      assert.equal(await page.$eval(html ? ".render-notice" : ".preview-note", e => e.hidden), true);
      assert.equal(await page.$eval(html ? ".render-notice" : ".preview-note", e => e.textContent), "");
      assert.equal(await page.evaluate(() => window.renderLimitDocument), true);
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
test("Chrome: exact owner/viewer notes, small views, offline copies, and synthetic design captures", { timeout: 180000 }, async () => {
  const puppeteer = createRequire(import.meta.url)(`${process.env.HOME}/.npm-packages/lib/node_modules/puppeteer`);
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--no-sandbox"] });
  const captures = process.env.AGENT_LIBRARY_RENDER_CAPTURES === "1";
  const out = "tmp/design-captures/s2b2-render"; if (captures) mkdirSync(out, { recursive: true });
  try {
    for (const [who, role] of [[owner, "owner"], [viewer, "viewer"]]) {
      const page = await browser.newPage(); const [name, value] = who.cookie.split("="); await page.setCookie({ name, value, url: APP });
      const requests = []; page.on("request", r => { if (r.url().includes("/render")) requests.push(r.url()); });
      const errors = []; page.on("pageerror", e => errors.push(e.message));
      for (const width of captures ? [1280, 390] : [1280]) {
        await page.setViewport({ width, height: 900 });
        for (const key of ["largeMarkdown", "largeHtml", "smallMarkdown", "smallHtml"]) {
          requests.length = 0;
          await page.goto(`${APP}/#/p/${pid}/a/${ids[key]}`);
          const large = key.startsWith("large"), html = key.endsWith("Html");
          if (large) {
            const text = html ? role === "owner" ? NOTICE : VIEW_NOTICE : role === "owner" ? NOTE : VIEW_NOTE;
            await page.waitForFunction(text => document.body.innerText.includes(text), {}, text);
            assert.equal(await page.$eval(html ? ".render-notice" : ".preview-note", e => e.textContent), text);
            if (html) { assert.deepEqual(requests, []); assert.equal(await page.$eval("iframe.htmlview", e => e.getAttribute("src")), null); }
            else await page.waitForFunction(() => document.querySelector(".preview h1")?.textContent === "early-render-marker");
            if (captures) await page.screenshot({ path: `${out}/${role}-${key}-${width}.png` });
          } else {
            if (html) await page.waitForFunction(() => document.querySelector("iframe.htmlview")?.getAttribute("src"));
            else await page.waitForFunction(() => document.querySelector(".preview h1")?.textContent === "Small Markdown");
            assert.equal(await page.$eval(".preview-note", e => e.textContent), "");
            if (html) assert.equal(await page.$eval(".render-notice", e => e.hidden), true);
          }
          assert.deepEqual(await page.$eval(".preview-note", e => [e.getAttribute("role"), e.getAttribute("aria-live")]), [null, null]);
          if (role === "viewer") assert.equal(await page.evaluate(() => [...document.querySelectorAll('[role="tab"]')].some(el => el.textContent === "Edit")), false);
        }
      }
      if (role === "owner") {
        await page.goto(`${APP}/#/p/${pid}/a/${ids.largeMarkdown}`);
        await page.waitForFunction(() => document.querySelector(".preview h1")?.textContent === "early-render-marker");
        await page.evaluate(() => { const button = [...document.querySelectorAll("button")].find(el => el.textContent === "Save as template"); button.closest("details").open = true; button.click(); });
        const templateNote = "Preview shows the first 1 MB. The template copies the full saved revision.";
        await page.waitForFunction(text => document.querySelector(".template-preview")?.innerText.includes(text), {}, templateNote);
        const savedTemplate = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith("/templates"));
        await page.click('.template-form button[type="submit"]');
        const response = await savedTemplate; assert.equal(response.status(), 201);
        const copied = await response.json();
        assert.equal((await owner.req("GET", base(copied.artifact_id))).body.body, (await owner.req("GET", base(ids.largeMarkdown))).body.body);
        for (const key of ["largeMarkdown", "largeHtml"]) {
          await page.goto(`${APP}/#/p/${pid}/a/${ids[key]}`);
          const toggle = await page.waitForSelector('[aria-label="Make available offline"]'); await toggle.click();
          await page.waitForSelector('[aria-label="Available offline (tap to remove from this device)"]');
        }
        await page.setOfflineMode(true);
        for (const key of ["largeMarkdown", "largeHtml"]) {
          await page.goto(`${APP}/#/p/${pid}/a/${ids[key]}`); await page.reload();
          const text = key === "largeMarkdown" ? "Preview shows the first 1 MB. Open Text for the full text." : "This page is larger than 1 MB, so it isn't shown here. Open Source to see its source.";
          await page.waitForFunction(text => document.body.innerText.includes(text), {}, text);
        }
        await page.setOfflineMode(false);
      }
      assert.deepEqual(errors, []); await page.close();
    }
    if (captures) {
      const page = await browser.newPage();
      for (const width of [1280, 390]) { await page.setViewport({ width, height: 900 }); await page.goto(`http://${CONTENT}${blockedPath}`); await page.screenshot({ path: `${out}/content-413-${width}.png`, fullPage: true }); }
    }
  } finally { await browser.close(); }
});
