// File types in the browser UI: specific type labels from the stored MIME type, the Home type filter and type sort,
// and list thumbnails for images and videos (Home, project list, search). Server responses only gain the MIME type
// where the owner's browser asks for it. Real local runtime and real Chrome; synthetic fixtures only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import vm from "node:vm";
import { startServer, setupProject, grant, agentHttp, mcpClient, sha256, key } from "./helpers.mjs";
import { SERVER_PORTS } from "./ports.mjs";
import { makeFixtures } from "./make-fixtures.mjs";

const require = createRequire(import.meta.url);
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PUPPETEER = `${process.env.HOME}/.npm-packages/lib/node_modules/puppeteer`;
const haveChrome = existsSync(CHROME) && existsSync(PUPPETEER);
const PORT = SERVER_PORTS["file-types"], ORIGIN = `http://127.0.0.1:${PORT}`;
const P = "ft-media", Q = "ft-docs";
let s, h, fx, browser, page;
const ids = {};

async function upload(pid, title, mime, bytes) {
  const b = await h.req("POST", `/api/projects/${pid}/uploads`, { title, mime, size: bytes.length, sha256: sha256(bytes) }, { idem: key("ub") });
  assert.ok([200, 201].includes(b.status), JSON.stringify(b.body));
  const put = await h.req("PUT", b.body.put_url, undefined, { raw: bytes, headers: { "content-type": "application/octet-stream" } });
  assert.ok([200, 201].includes(put.status), JSON.stringify(put.body));
  const f = await h.req("POST", `/api/projects/${pid}/uploads/${b.body.upload_id}/finish`, {}, { idem: key("uf") });
  assert.ok([200, 201].includes(f.status), JSON.stringify(f.body));
  return f.body.artifact_id;
}

before(async () => {
  fx = makeFixtures();
  s = await startServer("file-types", PORT);
  h = await s.login();
  await setupProject(h, P, "Media");
  await setupProject(h, Q, "Notes");
  ids.png = await upload(P, "Sunset photo", "image/png", readFileSync(fx.png));
  ids.mp4 = await upload(P, "Demo clip", "video/mp4", readFileSync(fx.mp4));
  ids.pdf = await upload(P, "Invoice", "application/pdf", readFileSync(fx.pdf));
  ids.doc = (await h.req("POST", `/api/projects/${Q}/artifacts`, { title: "Meeting notes", body: "# Notes\n" })).body.artifact_id;
  if (!haveChrome) return;
  browser = await require(PUPPETEER).launch({ executablePath: CHROME, headless: true, args: ["--no-first-run"] });
  page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(ORIGIN + "/");
  await page.waitForSelector('input[name="passphrase"]');
  await page.type('input[name="passphrase"]', s.passphrase());
  await Promise.all([page.waitForFunction(() => document.querySelectorAll("#nav a").length === 4), page.click('button[type="submit"]')]);
});
after(async () => { await browser?.close(); await s?.stop(); });

test("owner list adds the head revision MIME type only with include=mime; other shapes unchanged", async () => {
  const plain = await h.req("GET", `/api/projects/${P}/artifacts`);
  assert.equal(plain.status, 200);
  for (const a of plain.body.artifacts) assert.ok(!("mime" in a), "no mime without include=mime");
  const withMime = await h.req("GET", `/api/projects/${P}/artifacts?include=mime`);
  const byId = Object.fromEntries(withMime.body.artifacts.map((a) => [a.id, a.mime]));
  assert.deepEqual(byId, { [ids.png]: "image/png", [ids.mp4]: "video/mp4", [ids.pdf]: "application/pdf" });
  const docs = await h.req("GET", `/api/projects/${Q}/artifacts?include=mime`);
  assert.equal(docs.body.artifacts[0].mime, "text/markdown");
  // Machine and agent surfaces keep their shapes.
  const g = await grant(h, P, "reader", false);
  const agentList = await agentHttp(s.base, g.token)("GET", `/api/projects/${P}/artifacts?include=mime`);
  assert.equal(agentList.status, 200);
  for (const a of agentList.body.artifacts) assert.ok(!("mime" in a), "agent bearer list ignores include=mime");
  const m = await mcpClient(s.base, g.token);
  try {
    const r = await m.call("list_artifacts", { project_id: P });
    assert.equal(r.isError, false);
    for (const a of r.data.artifacts) assert.ok(!("mime" in a));
  } finally { await m.close(); }
});

test("owner search results carry the MIME type for the browser; agent search does not", async () => {
  const r = await h.req("GET", "/api/search?query=sunset");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.results[0].mime, "image/png");
  const g = await grant(h, P, "searcher", false), m = await mcpClient(s.base, g.token);
  try {
    const x = await m.call("search_artifacts", { query: "sunset" });
    assert.equal(x.isError, false, JSON.stringify(x.data));
    assert.ok(x.data.results.length && !("mime" in x.data.results[0]), "MCP search shape unchanged");
  } finally { await m.close(); }
  const agent = await agentHttp(s.base, g.token)("GET", "/api/search?query=sunset");
  assert.notEqual(agent.status, 200, "owner search stays human-only");
});

test("HOME: type grouping, type sort and the saved type filter", () => {
  const src = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  const START = "var HOME_JS = String.raw`", END = "`;\n\n// src/editor-bundle.ts\n";
  const store = new Map(), localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
  const HOME = vm.runInNewContext(src.slice(src.indexOf(START) + START.length, src.indexOf(END)) + "\nHOME", { localStorage, sessionStorage: localStorage });
  const t = (kind, mime) => HOME.typeOf({ kind, mime });
  assert.deepEqual([t("markdown"), t("html"), t("csv"), t("json"), t("binary", "image/png"), t("binary", "VIDEO/MP4"), t("binary", "application/pdf"), t("binary", null), t("binary", "application/zip")],
    ["doc", "page", "csv", "json", "image", "video", "pdf", "file", "file"]);
  const row = (id, title, kind, mime, at) => ({ pid: "p", id, title, kind, mime, updated_at: at });
  const rows = [row("1", "b clip", "binary", "video/mp4", "2026-10-01T00:00:00Z"), row("2", "z notes", "markdown", null, "2026-10-02T00:00:00Z"),
    row("3", "a photo", "binary", "image/png", "2026-10-03T00:00:00Z"), row("4", "a notes", "markdown", null, "2026-09-01T00:00:00Z")];
  assert.deepEqual(HOME.order(rows, "type").map((r) => r.id), ["4", "2", "3", "1"], "docs, then images, then videos; titles within a type");
  assert.deepEqual(HOME.read("u").type, "all");
  HOME.prefs("u", "recent", "type", "image");
  assert.deepEqual([HOME.read("u").sort, HOME.read("u").type], ["type", "image"]);
  HOME.prefs("u", "favorites", "newest");
  assert.equal(HOME.read("u").type, "image", "prefs without a type keeps the saved filter");
  store.set("al:home:u", JSON.stringify({ favorites: [], sort: "bogus", type: "<script>" }));
  assert.deepEqual([HOME.read("u").sort, HOME.read("u").type], ["newest", "all"], "unknown saved values fall back");
});

const rowsOf = (sel) => page.$$eval(sel, (li) => li.map((x) => ({ title: x.querySelector(".grow a, .grow span")?.textContent, meta: x.querySelector(".meta")?.textContent ?? "",
  type: x.querySelector(".ficon-sm")?.dataset.type, thumb: x.querySelector(".ficon-sm")?.classList.contains("has-thumb") ?? false })));

test("project list: specific labels and thumbnails for the image and video", { skip: !haveChrome && "Chrome not installed" }, async () => {
  await page.goto(ORIGIN + "/#/p/" + P);
  await page.waitForFunction(() => document.querySelectorAll("main ul.list li.link").length === 3);
  await page.waitForFunction(() => document.querySelectorAll("main ul.list .ficon-sm.has-thumb").length === 2, { timeout: 20000 });
  const rows = await rowsOf("main ul.list li.link");
  const by = Object.fromEntries(rows.map((r) => [r.title, r]));
  assert.match(by["Sunset photo"].meta, /^PNG image · /);
  assert.match(by["Demo clip"].meta, /^MP4 video · /);
  assert.match(by["Invoice"].meta, /^PDF · /);
  assert.deepEqual([by["Sunset photo"].thumb, by["Demo clip"].thumb, by["Invoice"].thumb], [true, true, false], "PDF keeps its icon");
  assert.deepEqual([by["Sunset photo"].type, by["Demo clip"].type, by["Invoice"].type], ["image", "video", "pdf"]);
  // Thumbnails are small generated images, not the content itself.
  const src = await page.$eval("main ul.list .ficon-sm.has-thumb img", (i) => i.src);
  assert.match(src, /^blob:/);
  await page.screenshot({ path: "tmp/test-evidence/file-types-project.png" });
});

test("Home: type filter and type sort, saved across reloads", { skip: !haveChrome && "Chrome not installed" }, async () => {
  await page.goto(ORIGIN + "/#/");
  await page.waitForFunction(() => document.querySelectorAll(".home-list li.link").length === 4);
  const typeSel = 'select[aria-label="Filter by type"]', sortSel = 'select[aria-label="Sort documents"]';
  await page.select(typeSel, "image");
  await page.waitForFunction(() => document.querySelectorAll(".home-list li.link").length === 1);
  let rows = await rowsOf(".home-list li.link");
  assert.equal(rows[0].title, "Sunset photo");
  await page.waitForFunction(() => document.querySelector(".home-list .ficon-sm.has-thumb"), { timeout: 20000 });
  await page.screenshot({ path: "tmp/test-evidence/file-types-home-images.png" });
  await page.select(typeSel, "csv");
  await page.waitForFunction(() => document.body.innerText.includes("No CSV files here"));
  await page.click("main .empty button, main button.secondary");
  await page.waitForFunction(() => document.querySelectorAll(".home-list li.link").length === 4);
  assert.equal(await page.$eval(typeSel, (s) => s.value), "all");
  await page.select(sortSel, "type");
  await page.waitForFunction(() => document.querySelector(".home-list li.link .grow a")?.textContent === "Meeting notes");
  rows = await rowsOf(".home-list li.link");
  assert.deepEqual(rows.map((r) => r.type), ["doc", "image", "video", "pdf"]);
  await page.select(typeSel, "video");
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll(".home-list li.link").length === 1);
  assert.deepEqual([await page.$eval(typeSel, (s) => s.value), await page.$eval(sortSel, (s) => s.value)], ["video", "type"]);
  assert.equal((await rowsOf(".home-list li.link"))[0].title, "Demo clip");
  await page.select(typeSel, "all");
  await page.waitForFunction(() => document.querySelectorAll(".home-list li.link").length === 4);
  await page.waitForFunction(() => document.querySelectorAll(".home-list .ficon-sm.has-thumb").length === 2, { timeout: 20000 });
  await page.screenshot({ path: "tmp/test-evidence/file-types-home.png" });
  await page.setViewport({ width: 412, height: 900, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll(".home-list .ficon-sm.has-thumb").length === 2, { timeout: 20000 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "no horizontal overflow on a phone");
  await page.screenshot({ path: "tmp/test-evidence/file-types-home-mobile.png" });
  await page.setViewport({ width: 1280, height: 900 });
});

test("search results show the type label and thumbnail", { skip: !haveChrome && "Chrome not installed" }, async () => {
  await page.goto(ORIGIN + "/#/search");
  await page.waitForSelector("#global-search-query");
  await page.type("#global-search-query", "sunset");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".search-hit .ficon-sm.has-thumb"), { timeout: 20000 });
  assert.match(await page.$eval(".search-hit .meta", (m) => m.textContent), /PNG image/);
  await page.screenshot({ path: "tmp/test-evidence/file-types-search.png" });
});

test("trash rows show type icons and never fetch content", { skip: !haveChrome && "Chrome not installed" }, async () => {
  const meta = (await h.req("GET", `/api/projects/${P}/artifacts/${ids.pdf}`)).body.artifact.meta_version;
  assert.equal((await h.req("PATCH", `/api/projects/${P}/artifacts/${ids.pdf}`, { expected_meta_version: meta, trashed: true })).status, 200);
  const seen = [];
  const onReq = (r) => { if (r.url().includes("/content")) seen.push(r.url()); };
  page.on("request", onReq);
  await page.goto(ORIGIN + "/#/p/" + P + "/trash");
  await page.waitForFunction(() => document.body.innerText.includes("Invoice"));
  await new Promise((r) => setTimeout(r, 500));
  page.off("request", onReq);
  assert.deepEqual(seen, [], "trash rows show icons only");
  assert.equal(await page.$eval("main ul.list li .ficon-sm", (b) => b.dataset.type), "pdf");
});
