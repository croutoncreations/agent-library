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
import { MARKDOWN_PREVIEW_MAX_BYTES, HTML_RENDER_MAX_BYTES, TEXT_MAX_BYTES } from "../packages/core/src/text-limits.js";
import { runInNewContext } from "node:vm";
const MAX = MARKDOWN_PREVIEW_MAX_BYTES, HTML_MAX = HTML_RENDER_MAX_BYTES, port = SERVER_PORTS["render-limit"], APP = `http://localhost:${port}`, CONTENT = `content.localhost:${port}`;
const PREVIEW_PREFIX = `Preview shows the first ${MAX / 1024} KB.`;
const NOTE = PREVIEW_PREFIX + " Open Edit for the full text.";
const NOTICE = `This page is larger than ${HTML_MAX / 1048576} MB, so it isn't shown here.`;
const TITLE = "Page too large to show here";
const VIEW_NOTE = PREVIEW_PREFIX + " Show full text in History";
const API_NOTICE = `This page is larger than ${HTML_MAX / 1048576} MB and cannot be shown.`;
const CONTENT_NOTICE = API_NOTICE + " Open it in Agent Library to see its source.";
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
  await make("html", "<h1>Exact HTML</h1>".padEnd(HTML_MAX, " "), "exactHtml");
  await make("html", "<h1>Large HTML source</h1>".padEnd(HTML_MAX + 1, " "), "largeHtml");
  await make("html", "<h1>Small HTML</h1>", "smallHtml");
  for (const kind of ["markdown", "html"]) {
    const MAX = kind === "html" ? HTML_MAX : MARKDOWN_PREVIEW_MAX_BYTES;
    const heading = kind === "markdown" ? "# Crossing Markdown\n" : "<h1>Crossing HTML</h1>\n";
    const line = kind === "markdown" ? "word ".repeat(40) + "\n" : "<!-- " + "word ".repeat(40) + " -->\n";
    const body = (heading + line.repeat(Math.ceil(MAX / line.length))).slice(0, MAX - 16);
    assert.equal(Buffer.byteLength(body), MAX - 16);
    await make(kind, body, `crossing-${kind}`);
  }
  for (const key of ["largeMarkdown", "largeHtml"]) {
    const current = await owner.req("GET", base(ids[key]));
    assert.equal((await owner.req("PUT", base(ids[key]), { expected_revision: 1, body: current.body.body })).status, 200);
  }
  // A previously issued link from before this restriction: repoint a small-page link.
  const old = await nav(ids.exactHtml); blockedPath = new URL(old.headers.get("location")).pathname;
  await sql(`UPDATE view_links SET artifact_id = '${ids.largeHtml}' WHERE token_hash = '${sha256(blockedPath.slice(3))}'`);
});
after(async () => { await s?.stop(); });
for (const [name, bytes] of Object.entries({ MARKDOWN_PREVIEW_MAX_BYTES, HTML_RENDER_MAX_BYTES })) {
  test(`browser ${name} matches the server constant`, () => {
    const js = readFileSync(new URL("../packages/core/src/web/app.js.txt", import.meta.url), "utf8");
    assert.equal(Number(js.match(new RegExp(`var ${name} = (\\d+);`))[1]), bytes);
  });
}
test("visible render sizes stay tied to their kind's threshold", () => {
  const js = readFileSync(new URL("../packages/core/src/web/app.js.txt", import.meta.url), "utf8");
  const helpers = js.match(/^function (?:previewLimitNote|pageLimitNotice)\(.*$/gm).join("\n");
  const context = {}; runInNewContext(helpers, context);
  assert.equal(context.previewLimitNote("Open Edit"), NOTE);
  assert.equal(context.previewLimitNote(), PREVIEW_PREFIX);
  assert.equal(context.previewLimitNote("Open Text"), PREVIEW_PREFIX + " Open Text for the full text.");
  assert.equal(context.pageLimitNotice(), NOTICE);
  assert.equal(context.pageLimitNotice("Open Source"), NOTICE + " Open Source to see its source.");
  assert.ok(js.includes(PREVIEW_PREFIX + " The template copies the full saved revision."));
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
  const large = prefix + "x".repeat(100) + suffix + " word".repeat(Math.ceil(TEXT_MAX_BYTES / 5));
  await make("markdown", large.slice(0, TEXT_MAX_BYTES), "tenMarkdown");
  const ten = await owner.req("GET", base(ids.tenMarkdown) + "/preview");
  assert.equal(ten.status, 200); assert.equal(ten.body.truncated, true);
  assert.match(ten.body.html, /early-render-marker/); assert.match(ten.body.html, /last-complete-line/);
  assert.doesNotMatch(ten.body.html, /after-cut-marker|art_aftercut|x{100}/);
  assert.ok(Buffer.byteLength(JSON.stringify(ten.body)) < MAX + 1024);
  await make("markdown", "word ".repeat(Math.ceil(HTML_MAX / 5)).slice(0, HTML_MAX), "oneMiBMarkdown");
  assert.equal((await owner.req("GET", base(ids.oneMiBMarkdown) + "/preview")).body.truncated, true);
  // A newline just outside the final 16 KiB must not discard a quarter of the prefix.
  const outside = MAX - MAX / 16 - 1;
  await make("markdown", "a".repeat(outside) + "\n" + "b".repeat(MAX - outside), "outsideLineWindow");
  const outsideResult = await owner.req("GET", base(ids.outsideLineWindow) + "/preview");
  assert.equal(outsideResult.body.truncated, true); assert.match(outsideResult.body.html, /b{16384}/);
  for (const [key, prefix] of [
    ["crLineWindow", "a".repeat(MAX - 100) + "\r"],
    ["lastByteLine", "a".repeat(MAX - 1) + "\n"]
  ]) {
    await make("markdown", prefix + "b".repeat(MAX + 1 - prefix.length), key);
    const cut = await owner.req("GET", base(ids[key]) + "/preview");
    assert.equal(cut.body.truncated, true);
    assert.doesNotMatch(cut.body.html, /b/);
    assert.match(cut.body.html, new RegExp("a{" + (prefix.length - 1) + "}"));
  }
});
test("HTML boundary, refusal before redirect, old large links/media and still-valid small links", async () => {
  await make("html", "<h1>Between thresholds</h1>".padEnd(MAX + 1, " "), "mediumHtml");
  const medium = await owner.req("GET", base(ids.mediumHtml) + "/render");
  assert.equal(medium.status, 200); assert.match(medium.body, /Between thresholds/);
  const exact = await owner.req("GET", base(ids.exactHtml) + "/render");
  assert.equal(exact.status, 200); assert.match(exact.body, /Exact HTML/);
  const good = await nav(ids.exactHtml), goodPath = new URL(good.headers.get("location")).pathname;
  assert.equal((await content(goodPath)).status, 200);
  const linkCount = (await sql(`SELECT COUNT(*) AS n FROM view_links WHERE artifact_id = '${ids.largeHtml}'`))[0].n;
  const tooLarge = await owner.req("GET", base(ids.largeHtml) + "/render");
  assert.equal(tooLarge.status, 413); assert.equal(tooLarge.body.error.code, "render_too_large");
  assert.equal(tooLarge.body.error.message, API_NOTICE);
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
test("Chrome: overlapping previews and viewer refresh keep the body, note and revision link together", { timeout: 180000 }, async () => {
  const puppeteer = createRequire(import.meta.url)(`${process.env.HOME}/.npm-packages/lib/node_modules/puppeteer`);
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--no-sandbox"] });
  try {
    const standalone = await make("markdown", "# standalone\n" + "word ".repeat(MAX), "standaloneMarkdown");
    const legacyPage = await browser.newPage();
    const [on, ov] = viewer.cookie.split("="); await legacyPage.setCookie({ name: on, value: ov, url: APP });
    // Exercise the supported list-projects response without an address (the server normally assigns one).
    await legacyPage.setRequestInterception(true);
    legacyPage.on("request", async r => {
      if (new URL(r.url()).pathname === "/api/projects") {
        const response = await viewer.req("GET", "/api/projects");
        for (const project of response.body.projects) delete project.path;
        await r.respond({ status: response.status, contentType: "application/json", body: JSON.stringify(response.body) });
      } else await r.continue();
    });
    await legacyPage.goto(`${APP}/#/p/${pid}/a/${standalone}`);
    await legacyPage.waitForSelector(".preview-note a");
    assert.equal(await legacyPage.$eval(".preview-note a", e => e.href), `${APP}/p/${pid}/a/${standalone}?v=1`);
    await legacyPage.close();
    const id = await make("markdown", "# first-overlap\n" + "word ".repeat(MAX), "overlapMarkdown");
    const page = await browser.newPage();
    const [name, value] = viewer.cookie.split("="); await page.setCookie({ name, value, url: APP });
    let release, started;
    const intercepted = new Promise(resolve => { started = resolve; });
    let first = true;
    await page.setRequestInterception(true);
    page.on("request", async r => {
      if (first && r.url().endsWith(base(id) + "/preview?rev=1")) {
        first = false;
        const response = await viewer.req("GET", base(id) + "/preview?rev=1");
        release = () => r.respond({ status: response.status, contentType: "application/json", body: JSON.stringify(response.body) });
        started();
      } else await r.continue();
    });
    await page.goto(`${APP}/#/p/${pid}/a/${id}`); await intercepted;
    await owner.req("PUT", base(id), { expected_revision: 1, body: "# latest-overlap\n" + "word ".repeat(MAX) });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForFunction(() => document.querySelector(".preview h1")?.textContent === "latest-overlap");
    const latest = `${APP}/synthetic-rendering/render-limits/a/${id}?v=2`;
    assert.equal(await page.$eval(".preview-note a", e => e.href), latest, "refresh updates the viewer link to the new revision");
    await release(); await page.waitForNetworkIdle({ idleTime: 100 });
    assert.equal(await page.$eval(".preview h1", e => e.textContent), "latest-overlap");
    assert.equal(await page.$eval(".preview-note", e => e.textContent), VIEW_NOTE);
    assert.equal(await page.$eval(".preview-note a", e => e.href), latest);
    await page.close();
  } finally { await browser.close(); }
});
async function withPreviewPage(who, run) {
  const puppeteer = createRequire(import.meta.url)(`${process.env.HOME}/.npm-packages/lib/node_modules/puppeteer`);
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    // A claimed service worker can otherwise bypass page-level interception after the first preview.
    await page.setBypassServiceWorker(true);
    const [name, value] = who.cookie.split("="); await page.setCookie({ name, value, url: APP });
    const errors = []; page.on("pageerror", e => errors.push(e.message));
    await run(page);
    assert.deepEqual(errors, [], "pending previews do not throw in Chrome");
  } finally { await browser.close(); }
}
async function holdPreviews(page, id, { holdWrites = false } = {}) {
  const queued = [], waiting = [];
  await page.setRequestInterception(true);
  page.on("request", async r => {
    // Keep autosave pending until this page closes, so the controlled calls stay on one revision.
    if (holdWrites && r.method() === "PUT" && new URL(r.url()).pathname === base(id)) return;
    if (new URL(r.url()).pathname === base(id) + "/preview") {
      if (waiting.length) waiting.shift()(r); else queued.push(r);
    } else await r.continue();
  });
  return () => queued.length ? Promise.resolve(queued.shift()) : new Promise(resolve => waiting.push(resolve));
}
async function answerPreview(r, fail = false) {
  const response = fail ? { status: 503, body: { error: { code: "synthetic_preview_failure", message: "synthetic preview unavailable" } } } : await owner.req("GET", new URL(r.url()).pathname + new URL(r.url()).search);
  await r.respond({ status: response.status, contentType: "application/json", body: JSON.stringify(response.body) });
}
const previewTab = (page, label) => page.evaluate(label => [...document.querySelectorAll('[role="tab"]')].find(e => e.textContent === label).click(), label);
const previewFailed = page => page.waitForFunction(() => document.querySelector('.preview [role="alert"]')?.textContent === "Preview failed: synthetic preview unavailable");
async function assertFailedPreviewRevision(page, rev) {
  assert.equal(await page.$eval(".preview-note", e => e.textContent), "", "failed preview clears the previous revision's truncation note");
  assert.equal(await page.$eval(".preview-note", e => e.hidden), true);
  assert.equal(await page.$(".preview-note a"), null, "failed preview removes the previous revision's History link");
  // A retained link invokes the real History callback, exposing its captured shownRev without app hooks.
  await page.evaluate(() => window.previousPreviewLink.click());
  await page.waitForSelector('.vh-row[aria-current="true"]');
  assert.equal(await page.$eval('.vh-row[aria-current="true"]', e => e.dataset.rev), String(rev), "History targets the failed request's revision");
}
test("Chrome: newest preview request fails without retaining the previous revision note or History target", { timeout: 180000 }, async () => {
  const id = await make("markdown", "# failure-first\n" + "word ".repeat(MAX), "failureMarkdown");
  await withPreviewPage(viewer, async page => {
    await page.goto(`${APP}/#/p/${pid}/a/${id}`); await page.waitForSelector(".preview-note a");
    await page.evaluate(() => { window.previousPreviewLink = document.querySelector('.preview-note a'); });
    const next = await holdPreviews(page, id);
    await owner.req("PUT", base(id), { expected_revision: 1, body: "# failure-second" });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const pending = await next(); assert.ok(pending.url().endsWith("?rev=2"));
    await answerPreview(pending, true); await previewFailed(page);
    await assertFailedPreviewRevision(page, 2);
  });
});
test("Chrome: superseded preview cannot replace a newer failure on late arrival", { timeout: 180000 }, async () => {
  const id = await make("markdown", "# failure-initial\n" + "word ".repeat(MAX), "supersededFailureMarkdown");
  await withPreviewPage(viewer, async page => {
    await page.goto(`${APP}/#/p/${pid}/a/${id}`); await page.waitForSelector(".preview-note a");
    await page.evaluate(() => { window.previousPreviewLink = document.querySelector('.preview-note a'); });
    const next = await holdPreviews(page, id);
    await owner.req("PUT", base(id), { expected_revision: 1, body: "# superseded-response-marker" });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const older = await next(); assert.ok(older.url().endsWith("?rev=2"));
    await owner.req("PUT", base(id), { expected_revision: 2, body: "# newer-failure-marker" });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const newer = await next(); assert.ok(newer.url().endsWith("?rev=3"));
    await answerPreview(newer, true); await previewFailed(page);
    const before = await page.$eval(".preview", e => e.innerHTML);
    await answerPreview(older); await page.waitForNetworkIdle({ idleTime: 100 });
    assert.equal(await page.$eval(".preview", e => e.innerHTML), before, "late superseded response leaves the error untouched");
    assert.equal(await page.$(".preview h1"), null, "no older response body appears");
    await assertFailedPreviewRevision(page, 3);
  });
});
test("Chrome: same-revision preview calls preserve the newer unsaved-edits note", { timeout: 180000 }, async () => {
  const id = await make("markdown", "# same-revision", "sameRevisionMarkdown");
  await withPreviewPage(owner, async page => {
    const next = await holdPreviews(page, id, { holdWrites: true });
    await page.goto(`${APP}/#/p/${pid}/a/${id}`); const older = await next();
    await previewTab(page, "Edit"); await page.waitForSelector(".cm-content", { visible: true });
    await page.click(".cm-content"); await page.keyboard.sendCharacter("unsaved ");
    await page.waitForFunction(() => document.querySelector('.status')?.textContent === "Unsaved changes");
    await previewTab(page, "Preview"); const newer = await next();
    assert.equal(newer.url(), older.url(), "both calls request the same saved revision");
    await answerPreview(newer);
    const note = "Showing saved rev 1 (unsaved edits are not included).";
    await page.waitForFunction(note => document.querySelector('.preview-note')?.textContent === note, {}, note);
    await answerPreview(older); await page.waitForNetworkIdle({ idleTime: 100 });
    assert.equal(await page.$eval(".preview-note", e => e.textContent), note, "older same-revision response must not erase the newer unsaved-edits note");
  });
});
// Protection for existing A.alive behaviour, covering both successful and failed late completions.
test("Chrome: closed document ignores pending preview success and failure", { timeout: 180000 }, async () => {
  await withPreviewPage(viewer, async page => {
    for (const fail of [false, true]) {
      const id = await make("markdown", "# closed-preview-marker", `closedPreview${fail}`);
      const next = await holdPreviews(page, id);
      await page.goto(`${APP}/#/p/${pid}/a/${id}`); const pending = await next();
      await page.evaluate(() => {
        window.closedPreviewMutations = [];
        new MutationObserver(records => window.closedPreviewMutations.push(...records.map(r => r.type)))
          .observe(document.querySelector('.preview'), { childList: true, subtree: true, characterData: true });
      });
      await page.evaluate((hash) => { location.hash = hash; }, `#/p/${pid}/a/${ids.smallMarkdown}`);
      await page.waitForFunction(() => document.querySelector('.preview h1')?.textContent === "Small Markdown");
      const nextView = await page.$eval("main", e => e.innerHTML);
      await answerPreview(pending, fail); await page.waitForNetworkIdle({ idleTime: 100 });
      assert.equal(await page.$eval("main", e => e.innerHTML), nextView, "late completion writes nothing to the next view");
      assert.deepEqual(await page.evaluate(() => window.closedPreviewMutations), [], `closed preview ${fail ? "error" : "success"} must not mutate its detached view`);
      await page.setRequestInterception(false); page.removeAllListeners("request");
    }
  });
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
      const MAX = kind === "html" ? HTML_MAX : MARKDOWN_PREVIEW_MAX_BYTES;
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
      await page.waitForFunction((selector, text, html) => {
        const e = document.querySelector(selector); return e && !e.hidden && (html ? e.querySelector("p")?.textContent : e.textContent) === text;
      }, {}, html ? ".render-notice" : ".preview-note", note, html);
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
        assert.deepEqual(await page.$eval(".render-notice", e => [e.tagName, e.className, e.getAttribute("role"), e.getAttribute("aria-live"), e.hidden]), ["P", "muted small render-notice", "status", "polite", true]);
        assert.equal(await page.$$eval(".render-notice", es => es.length), 1);
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
test("Chrome: refresh, conflict reload, History restore and reload use each kind's budget; saved-revision notes coexist", { timeout: 180000 }, async () => {
  const puppeteer = createRequire(import.meta.url)(`${process.env.HOME}/.npm-packages/lib/node_modules/puppeteer`);
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    const [name, value] = owner.cookie.split("="); await page.setCookie({ name, value, url: APP });
    page.on("dialog", d => d.accept());
    const tab = async label => page.evaluate(label => [...document.querySelectorAll('[role="tab"]')].find(e => e.textContent === label).click(), label);
    const saved = rev => page.waitForFunction(rev => document.querySelector(".status")?.textContent === `Saved - rev ${rev}`, {}, rev);
    for (const kind of ["markdown", "html"]) {
      const html = kind === "html", limit = html ? HTML_MAX : MAX, view = html ? "Page" : "Preview";
      const small = html ? "<h1>Refresh source</h1>" : "# Refresh source\n";
      const large = small + "word ".repeat(Math.ceil(limit / 5));
      const id = await make(kind, small, `refresh-${kind}`);
      await page.goto(`${APP}/#/p/${pid}/a/${id}`); await saved(1);
      await owner.req("PUT", base(id), { expected_revision: 1, body: large, change_note: "Synthetic large revision" });
      await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await saved(2);
      await page.waitForFunction(html => html ? !document.querySelector(".render-notice")?.hidden : document.querySelector(".preview-note")?.textContent.includes("Preview shows"), {}, html);
      // Pause the real save request, not its response/body: both notices remain readable while edits are unsaved.
      let resolveSave; const pausedSave = new Promise(resolve => { resolveSave = resolve; });
      await page.setRequestInterception(true);
      const intercept = r => { if (r.method() === "PUT" && r.url().endsWith(base(id))) resolveSave(r); else r.continue(); };
      page.on("request", intercept);
      await tab("Edit"); await page.waitForSelector(".cm-content", { visible: true }); await page.click(".cm-content");
      await page.keyboard.sendCharacter("local edit"); await tab(view);
      const expected = "Showing saved rev 2 (unsaved edits are not included)." + (html ? "" : " " + NOTE);
      await page.waitForFunction(text => document.querySelector(".preview-note")?.textContent === text, {}, expected);
      assert.deepEqual(await page.$eval(".preview-note", e => [e.getAttribute("role"), e.getAttribute("aria-live")]), [null, null]);
      await owner.req("PUT", base(id), { expected_revision: 2, body: small });
      await page.click(".footbar button"); await (await pausedSave).continue();
      await page.waitForSelector(".conflict:not([hidden])");
      await page.waitForFunction(() => document.querySelector("#conflict-theirs")?.value.startsWith("<h1>") || document.querySelector("#conflict-theirs")?.value.startsWith("# Refresh"));
      await page.$$eval(".conflict button", es => es.find(e => e.textContent === "Load latest (discard mine)").click());
      await saved(3); await page.setRequestInterception(false); page.off("request", intercept);
      await tab(view);
      await page.waitForFunction(html => document.querySelector(html ? ".render-notice" : ".preview-note")?.hidden, {}, html);
      // Restoring invokes A.reload without reloading the browser document.
      await page.evaluate(() => { window.renderLimitDocument = true; });
      for (const [from, rev, isLarge] of [[2, 4, true], [3, 5, false]]) {
        await tab("History"); await page.waitForSelector(`.vh-row[data-rev="${from}"] button`);
        await page.click(`.vh-row[data-rev="${from}"] button`);
        await page.waitForFunction(() => [...document.querySelectorAll(".vh-detail button")].some(e => e.textContent === "Restore this version"));
        await page.$$eval(".vh-detail button", es => es.find(e => e.textContent === "Restore this version").click());
        await saved(rev); await tab(view);
        await page.waitForFunction((html, isLarge) => document.querySelector(html ? ".render-notice" : ".preview-note")?.hidden === !isLarge, {}, html, isLarge);
        assert.equal(await page.evaluate(() => window.renderLimitDocument), true);
        if (isLarge) {
          await page.reload(); await saved(rev);
          await page.waitForFunction(html => !document.querySelector(html ? ".render-notice" : ".preview-note")?.hidden, {}, html);
          await page.evaluate(() => { window.renderLimitDocument = true; });
        }
      }
    }
  } finally { await browser.close(); }
});
test("Chrome: exact owner/viewer notes, small views, offline copies, and synthetic design captures", { timeout: 180000 }, async () => {
  const puppeteer = createRequire(import.meta.url)(`${process.env.HOME}/.npm-packages/lib/node_modules/puppeteer`);
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--no-sandbox"] });
  const captures = process.env.AGENT_LIBRARY_RENDER_CAPTURES === "1";
  const out = "tmp/design-captures/s2b2-ui3"; if (captures) mkdirSync(out, { recursive: true });
  const onlineGaps = {};
  async function measureLayout(page, view, width) {
    await page.setViewport({ width, height: 900 });
    const layout = await page.evaluate(() => {
      const tabs = document.querySelector('.tabs');
      const first = [...document.querySelectorAll('main .state, main .preview, main pre.raw, main iframe.htmlview, main p.muted.small')]
        .find(e => e.getBoundingClientRect().height && e.getBoundingClientRect().top >= tabs.getBoundingClientRect().bottom);
      const rect = e => { const r = e.getBoundingClientRect(); return [r.x, r.y + scrollY, r.width, r.height]; };
      const snapshot = () => ({ gap: first.getBoundingClientRect().top - tabs.getBoundingClientRect().bottom, elements: [...document.querySelectorAll('main, main *')].map(e => [e.tagName, e.className?.baseVal ?? e.className, ...rect(e)]) });
      const after = snapshot();
      // Compare the exact same saved copy with and without the scoped rule: timestamps cannot change the geometry.
      const sheet = [...document.styleSheets].find(s => [...s.cssRules].some(r => r.selectorText === '.offline-page-limit'));
      if (!sheet) return after;
      const index = [...sheet.cssRules].findIndex(r => r.selectorText === '.offline-page-limit');
      const rule = sheet.cssRules[index].cssText;
      sheet.deleteRule(index);
      const before = snapshot();
      sheet.insertRule(rule, index);
      return { ...after, before };
    });
    if (layout.before && view !== "offline-too-large-html") assert.deepEqual(layout.elements, layout.before.elements, `${view} at ${width}px: every element rectangle is identical without the scoped rule`);
    console.log('render-limit layout ' + JSON.stringify({ view, width, ...layout }));
    return layout.gap;
  }
  try {
    for (const [who, role] of [[owner, "owner"], [viewer, "viewer"]]) {
      const page = await browser.newPage(); const [name, value] = who.cookie.split("="); await page.setCookie({ name, value, url: APP });
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
      const requests = []; page.on("request", r => { if (r.url().includes("/render")) requests.push(r.url()); });
      const errors = []; page.on("pageerror", e => errors.push(e.message));
      for (const width of [1280, 390]) {
        await page.setViewport({ width, height: 900 });
        for (const key of ["largeMarkdown", "largeHtml", "smallMarkdown", "smallHtml"]) {
          requests.length = 0;
          await page.goto(`${APP}/#/p/${pid}/a/${ids[key]}`);
          const large = key.startsWith("large"), html = key.endsWith("Html");
          if (large) {
            const text = html ? NOTICE : role === "owner" ? NOTE : VIEW_NOTE;
            await page.waitForFunction((text, html) => html ? document.querySelector(".render-notice p")?.textContent === text : document.querySelector(".preview-note")?.textContent === text, {}, text, html);
            assert.equal(await page.$eval(html ? ".render-notice p" : ".preview-note", e => e.textContent), text);
            if (html) {
              assert.equal(await page.$eval(".render-notice h3", e => e.textContent), TITLE);
              assert.equal(await page.$eval(".render-notice button", e => e.textContent), role === "owner" ? "Open Edit" : "Show source in History");
              assert.equal(await page.$eval(".render-notice button", e => e.className), "", "keep the existing primary button");
              assert.equal(await page.$eval(".render-notice .state", e => e.classList.contains("error")), false);
              assert.deepEqual(await page.$eval(".render-notice", e => [e.getAttribute("role"), e.getAttribute("aria-live")]), [null, null]);
            } else {
              assert.equal(await page.$eval(".preview-note", e => e.nextElementSibling.nextElementSibling.className), "preview");
              if (role === "viewer") {
                assert.equal(await page.$eval(".preview-note a", e => e.textContent), "Show full text in History");
                assert.equal(await page.$eval(".preview-note a", e => e.href), `${APP}/synthetic-rendering/render-limits/a/${ids[key]}?v=2`);
              }
            }
            if (html) { assert.deepEqual(requests, []); assert.equal(await page.$eval("iframe.htmlview", e => e.getAttribute("src")), null); }
            else await page.waitForFunction(() => document.querySelector(".preview h1")?.textContent === "early-render-marker");
            if (role === "owner" && html) onlineGaps[width] = await measureLayout(page, "online-too-large-html", width);
            if (captures && role === "owner" && html && width === 1280) await page.screenshot({ path: `${out}/1-button-owner-1280.png` });
            if (html || role === "viewer") {
              // Start at the tab row, walk with real Tab keys, then activate the supported next step.
              await page.$eval('[role="tab"][aria-selected="true"]', e => e.focus());
              await page.evaluate(() => { window.renderLimitDocument = true; });
              const selector = html ? ".render-notice button" : ".preview-note a";
              let reached = false;
              for (let i = 0; i < 12; i++) {
                await page.keyboard.press("Tab");
                reached = await page.$eval(selector, e => e === document.activeElement);
                if (reached) break;
              }
              assert.equal(reached, true, "limit action is reachable from tab row");
              await page.keyboard.press("Enter");
              if (role === "owner") {
                await page.waitForFunction(() => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent === "Edit");
                await page.waitForSelector(".cm-content", { visible: true });
              } else {
                await page.waitForFunction(() => document.activeElement?.textContent === "Version 2 (current)");
                assert.equal(await page.$eval('[role="tab"][aria-selected="true"]', e => e.textContent), "History");
                assert.equal(await page.$eval('.vh-row[aria-current="true"]', e => e.dataset.rev), "2");
                assert.equal(await page.$$eval(".vh-detail .row button", es => es.some(e => e.textContent === "Show full text")), true);
                assert.match(await page.$eval(".vh-body", e => e.textContent), /identical/);
                assert.equal(await page.$(".vh-body pre.raw"), null, "limit actions keep the diff landing");
                await page.$$eval(".vh-detail .row button", es => es.find(e => e.textContent === "Show full text").click());
                await page.waitForSelector(".vh-body pre.raw");
                assert.equal(await page.$eval(".vh-body pre.raw", e => e.textContent), (await owner.req("GET", base(ids[key]))).body.body);
                assert.equal(await page.evaluate(() => window.renderLimitDocument), true, "History opens without a reload");
                if (!html) {
                  const linked = await browser.newPage();
                  await linked.goto(`${APP}/synthetic-rendering/render-limits/a/${ids[key]}?v=2`);
                  await linked.waitForFunction(() => document.activeElement?.textContent === "Version 2 (current)");
                  assert.equal(await linked.$eval('[role="tab"][aria-selected="true"]', e => e.textContent), "History");
                  assert.match(await linked.$eval(".vh-body", e => e.textContent), /identical/);
                  assert.equal(await linked.$(".vh-body pre.raw"), null);
                  await linked.close();
                  // Showing Preview reloads it, and the reload rebuilds the note with a new link. Wait for that link:
                  // the one from before the reload is removed from the page, and a click aimed at it fails.
                  const staleLink = await page.$(".preview-note a");
                  await page.evaluate(() => [...document.querySelectorAll('[role="tab"]')].find(e => e.textContent === "Preview").click());
                  await page.waitForFunction(stale => { const a = document.querySelector(".preview-note a"); return a && a !== stale; }, {}, staleLink);
                  assert.equal(await staleLink.evaluate(e => e.isConnected), false, "the reload replaced the link");
                  await page.waitForSelector(".preview-note a", { visible: true });
                  await page.evaluate(() => { window.renderLimitDocument = true; });
                  if (width === 390) {
                    const placement = await page.$eval(".preview-note a", e => {
                      const r = e.getBoundingClientRect();
                      return { top: r.top, bottom: r.bottom, scrollY, hit: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest("a") === e };
                    });
                    console.log("390px kept diff landing → Preview link placement:", JSON.stringify(placement));
                    assert.equal(placement.hit, true, "the repeated link click is not under the sticky header");
                    if (captures) await page.screenshot({ path: `${out}/markdown-history-link-return-390.png` });
                  }
                  await page.click(".preview-note a");
                  await page.waitForFunction(() => document.activeElement?.textContent === "Version 2 (current)");
                  assert.equal(await page.evaluate(() => window.renderLimitDocument), true);
                  assert.equal(await page.$$eval(".vh-detail .row button", es => es.some(e => e.textContent === "Show full text")), true);
                  assert.equal(await page.$(".vh-body pre.raw"), null, "repeated link entry still lands on the diff");
                }
              }
            }
          } else {
            if (html) await page.waitForFunction(() => document.querySelector("iframe.htmlview")?.getAttribute("src"));
            else await page.waitForFunction(() => document.querySelector(".preview h1")?.textContent === "Small Markdown");
            assert.equal(await page.$eval(".preview-note", e => e.textContent), "");
            if (html) {
              assert.deepEqual(await page.$eval(".render-notice", e => [e.hidden, e.tagName, e.className, e.getAttribute("role"), e.getAttribute("aria-live")]), [true, "P", "muted small render-notice", "status", "polite"]);
              assert.equal(await page.$(".render-notice .state"), null);
            }
          }
          assert.deepEqual(await page.$eval(".preview-note", e => [e.getAttribute("role"), e.getAttribute("aria-live")]), [null, null]);
          if (role === "viewer") assert.equal(await page.evaluate(() => [...document.querySelectorAll('[role="tab"]')].some(el => el.textContent === "Edit")), false);
        }
      }
      if (role === "owner") {
        await page.goto(`${APP}/#/p/${pid}/a/${ids.largeMarkdown}`);
        await page.waitForFunction(() => document.querySelector(".preview h1")?.textContent === "early-render-marker");
        await page.evaluate(() => { const button = [...document.querySelectorAll("button")].find(el => el.textContent === "Save as template"); button.closest("details").open = true; button.click(); });
        const templateNote = PREVIEW_PREFIX + " The template copies the full saved revision.";
        const templateHelp = "Project: Render limits. Copies saved revision v2 shown below. Unsaved edits are excluded. {{title}}, {{project}} and {{date}} are replaced once when used; other braces stay literal.";
        await page.waitForFunction(text => document.querySelector(".template-preview")?.previousElementSibling?.textContent === text, {}, templateHelp + " " + templateNote);
        assert.equal(await page.$$eval(".template-form > p.muted.small", es => es.length), 1, "the truncation sentence is part of the existing help paragraph, not a separate note");
        assert.deepEqual(await page.$eval(".template-preview", e => [e.previousElementSibling.getAttribute("role"), e.previousElementSibling.getAttribute("aria-live")]), [null, null]);
        if (captures) for (const width of [1280, 390]) {
          await page.setViewport({ width, height: 900 });
          await page.$eval(".template-preview", e => e.previousElementSibling.scrollIntoView({ block: "center" }));
          await page.screenshot({ path: `${out}/3-template-${width}.png` });
        }
        const savedTemplate = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith("/templates"));
        await page.click('.template-form button[type="submit"]');
        const response = await savedTemplate; assert.equal(response.status(), 201);
        const copied = await response.json();
        assert.equal((await owner.req("GET", base(copied.artifact_id))).body.body, (await owner.req("GET", base(ids.largeMarkdown))).body.body);
        await page.goto(`${APP}/#/p/${pid}/a/${ids.smallMarkdown}`);
        await page.waitForSelector(".preview h1");
        await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find(e => e.textContent === "Save as template"); b.closest("details").open = true; b.click(); });
        await page.waitForSelector(".template-preview");
        assert.deepEqual(await page.$eval(".template-preview", e => [e.previousElementSibling.tagName, e.previousElementSibling.className, e.previousElementSibling.textContent.startsWith("Project: ")]), ["P", "muted small", true]);
        assert.equal(await page.$eval(".template-form", (e, prefix) => e.textContent.includes(prefix), PREVIEW_PREFIX), false);
        assert.equal(await page.$eval(".template-preview", e => e.previousElementSibling.textContent), templateHelp.replace("v2", "v1"));
        for (const key of ["largeMarkdown", "largeHtml", "smallMarkdown", "smallHtml"]) {
          await page.goto(`${APP}/#/p/${pid}/a/${ids[key]}`);
          const toggle = await page.waitForSelector('[aria-label="Make available offline"]'); await toggle.click();
          await page.waitForSelector('[aria-label="Available offline (tap to remove from this device)"]');
        }
        await page.setOfflineMode(true);
        for (const key of ["largeMarkdown", "largeHtml"]) {
          await page.goto(`${APP}/#/p/${pid}/a/${ids[key]}`); await page.reload();
          const text = key === "largeMarkdown" ? PREVIEW_PREFIX + " Open Text for the full text." : NOTICE + " Open Source to see its source.";
          await page.waitForFunction(text => document.body.innerText.includes(text), {}, text);
          if (key === "largeMarkdown") {
            assert.deepEqual(await page.$eval(".preview", e => [e.previousElementSibling.textContent, e.previousElementSibling.getAttribute("role"), e.previousElementSibling.getAttribute("aria-live")]), [text, null, null]);
          } else {
            assert.equal(await page.$eval(".state h3", e => e.textContent), TITLE);
            assert.equal(await page.evaluate(() => document.body.innerText.includes("Images and videos in pages need a connection.")), false);
            assert.equal(await page.$(".state button"), null);
            assert.deepEqual(await page.$eval(".state", e => [e.getAttribute("role"), e.getAttribute("aria-live"), e.classList.contains("error")]), ["tabpanel", null, false]);
          }
          for (const width of [1280, 390]) {
            const gap = await measureLayout(page, key === "largeHtml" ? "offline-too-large-html" : "offline-markdown", width);
            if (key === "largeHtml") {
              assert.ok(gap >= 8, `${width}px offline too-large box has at least 8px below the tabs`);
              assert.ok(Math.abs(gap - onlineGaps[width]) <= 1, `${width}px offline gap matches the online gap within 1px`);
            }
            if (captures && key === "largeHtml") await page.screenshot({ path: `${out}/4-offline-html-${width}.png` });
          }
          await previewTab(page, key === "largeHtml" ? "Source" : "Text");
          for (const width of [1280, 390]) await measureLayout(page, key === "largeHtml" ? "offline-too-large-html-source" : "offline-markdown-text", width);
        }
        for (const key of ["smallMarkdown", "smallHtml"]) {
          await page.goto(`${APP}/#/p/${pid}/a/${ids[key]}`); await page.reload();
          await page.waitForSelector(key === "smallHtml" ? "iframe.htmlview" : ".preview h1");
          const selector = key === "smallHtml" ? "iframe.htmlview" : ".preview";
          if (key === "smallHtml") {
            assert.equal(await page.$eval(selector, e => e.previousElementSibling.textContent), "Images and videos in pages need a connection.");
            for (const width of [1280, 390]) {
              await measureLayout(page, "offline-small-html", width);
              if (captures && width === 1280) await page.screenshot({ path: `${out}/4-offline-html-small-1280.png` });
            }
            await page.evaluate(() => [...document.querySelectorAll('[role="tab"]')].find(e => e.textContent === "Source").click());
            for (const width of [1280, 390]) await measureLayout(page, "offline-small-html-source", width);
          }
          if (key === "smallMarkdown") {
            for (const width of [1280, 390]) await measureLayout(page, "offline-small-markdown", width);
            await previewTab(page, "Text");
            for (const width of [1280, 390]) await measureLayout(page, "offline-small-markdown-text", width);
          }
          assert.deepEqual(await page.$eval(selector, e => [e.tagName, e.getAttribute("role"), e.parentElement.className]), [key === "smallHtml" ? "IFRAME" : "DIV", "tabpanel", ""]);
        }
        await page.setOfflineMode(false);
      }
      assert.deepEqual(errors, []); await page.close();
    }
  } finally { await browser.close(); }
});
