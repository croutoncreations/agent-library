// CSV and JSON inline previews in the browser app (src/web/app.js renderDataFile / dataPreview).
//  1. Parser parity: the browser CSV parser and the server's parseCsv (src/formats.ts) accept and reject the same
//     inputs and produce the same cells, so a preview never disagrees with validation.
//  2. Real Chrome against the real local runtime (loopback, synthetic owner, App Connect on so the owner can
//     create csv/json files): cells, tree, Table toggle, Raw text, mobile overflow, hostile content, large-file caps.
// Synthetic fixtures only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { transformSync } from "esbuild";
import { ROOT } from "./helpers.mjs";
import { startAppConnectServer } from "./fixtures/app-connect-harness.mjs";
import { SERVER_PORTS } from "./ports.mjs";

const require = createRequire(import.meta.url);
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PUPPETEER = `${process.env.HOME}/.npm-packages/lib/node_modules/puppeteer`;
const haveChrome = existsSync(CHROME) && existsSync(PUPPETEER);
const DESKTOP = { width: 1280, height: 900, deviceScaleFactor: 1 };
const PHONE_390 = { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const PHONE_320 = { width: 320, height: 658, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

// ---------- 1. parser parity ----------
const appJs = readFileSync(join(ROOT, "src/web/app.js"), "utf8");
const slice = (from, to) => { const a = appJs.indexOf(from), b = appJs.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return appJs.slice(a, b); };
const csvParse = new Function(slice("function csvParse(", "\n// JSON numbers keep") + "; return csvParse;")();
// The real formatting helpers and JSON code from app.js (cut at function boundaries, not comments).
const J = new Function(slice("function fmtCount(", "\n// RFC 4180") + slice("function RawNum(", "\nfunction isJsonContainer(") +
  slice("function isJsonContainer(", "\n// An array of flat objects") + slice("var NUMERIC_CELL", "\nfunction dataNote(") +
  slice("function jsonPath(", "\nfunction jsonSummary(") + slice("function jsonErrorText(", "\nfunction jsonScalar(") +
  "; return { jsonParse, jsonChanges, jsonBrief, isNumericCell, jsonErrorText, JSON_EXACT_NUMBERS };")();
// Production's parseCsv is the one inside the deployed bundle (src/index.js); src/formats.ts is an older snapshot.
// Both are checked so neither can drift from the browser parser unnoticed.
const bundle = readFileSync(join(ROOT, "src/index.js"), "utf8");
const bslice = (from, to) => { const a = bundle.indexOf(from), b = bundle.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return bundle.slice(a, b); };
const bundleParseCsv = new Function("HttpError", "MAX_FILE_BYTES", "invalid", bslice("function byteLength(", "\nfunction depthOk(") + bslice("function parseCsv(", "\nfunction strField(") + "; return parseCsv;")(
  class HttpError extends Error { constructor(s, c, m) { super(m); this.code = c; } }, 1048576,
  (x) => Object.assign(new Error(`Invalid ${x.format}: ${x.detail}`), { code: "invalid_content" }));
let serverParseCsv;
before(async () => {
  const dir = join(ROOT, "tmp", "data-preview-test");
  mkdirSync(dir, { recursive: true });
  for (const f of ["util", "formats"]) {
    const out = transformSync(readFileSync(join(ROOT, "src", `${f}.ts`), "utf8"), { loader: "ts", format: "esm", target: "es2022" }).code;
    writeFileSync(join(dir, `${f}.mjs`), out.replace(/from "\.\/util"/g, 'from "./util.mjs"'));
  }
  serverParseCsv = (await import(join(dir, "formats.mjs") + "?t=" + Date.now())).parseCsv;
});

const CORPUS = [
  "a,b\n1,2\n", "a,b\r\n1,2\r\n", "a,b\n1,2", "a\n", "a", "a,b\n\"x, y\",\"line1\nline2\"\n", "a,b\n\"he said \"\"hi\"\"\",2\n",
  "a,b\n,\n", "a,b\n1,2\n\n", "a,b\n1\n", "a,b\n1,2,3\n", "a,a\n1,2\n", " ,b\n1,2\n", "a,b\n\"x\"y,2\n", "a,b\nx\"y,2\n",
  "a,b\n\"unterminated,2\n", "a,b\r1,2\r", "\ufeffa,b\n1,2\n", "", "\"a\nb\",c\n1,2\n", "a,b\n\"\",\"\"\n", "a,b\r\n\"x\r\ny\",2\r\n",
  "name,note\n<img src=x onerror=alert(1)>,=HYPERLINK(\"http://example.invalid\",\"x\")\n",
  "\n", "a,b\n1,\n", "a\n\"x\ry\"\n", "\"h1\",\"h,2\"\n1,2\n", " \t,b\n1,2\n", "a,b\n1,2\r\n3,4", "a,,b\n1,2,3\n",
];
test("CSV parser parity: the browser preview and server validation (deployed bundle and formats.ts) accept, reject and split identically", () => {
  for (const [name, server] of [["bundle", bundleParseCsv], ["formats.ts", serverParseCsv]]) for (const text of CORPUS) {
    let s, c;
    try { s = { ok: server(text) }; } catch (e) { s = { err: e.message }; }
    try { c = { ok: csvParse(text) }; } catch (e) { c = { err: e.message }; }
    assert.equal(!!c.ok, !!s.ok, `${name}: same verdict for ${JSON.stringify(text)}: server ${s.err ?? "ok"}, client ${c.err ?? "ok"}`);
    if (s.ok) assert.deepEqual(c.ok, s.ok, `same cells for ${JSON.stringify(text)}`);
    else assert.equal(c.err.replace(/ \(line \d+\)$/, ""), s.err.replace(/^Invalid csv/, "Invalid CSV"), `same reason for ${JSON.stringify(text)}`);
  }
});

test("data preview code builds the DOM from text only (no innerHTML / insertAdjacentHTML / document.write)", () => {
  const code = slice("// ---------- data files (CSV / JSON)", "\nfunction renderMarkdownEditor(");
  assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\.style\b/);
});

test("JSON diff: added, removed and changed values by path; formatting-only edits are not changes; capped", () => {
  const c = J.jsonChanges(J.jsonParse('{"a":1,"b":{"c":"x","d":[1,2]},"odd key":true,"n":1.0}'), J.jsonParse('{\n  "a": 2,\n  "b": {"c": "x", "d": [1]},\n  "e": null,\n  "n": 1.0\n}'), 50);
  assert.deepEqual(c.list.map((x) => [x.op, x.path]), [["changed", "$.a"], ["removed", "$.b.d[1]"], ["removed", '$["odd key"]'], ["added", "$.e"]]);
  assert.equal(J.jsonChanges(J.jsonParse('{"a":[1,2]}'), J.jsonParse('{ "a" : [ 1 , 2 ] }'), 50).total, 0);
  assert.equal(J.jsonChanges(J.jsonParse('{"a":{"x":1}}'), J.jsonParse('{"a":[1]}'), 50).list[0].op, "changed", "object -> array is a change");
  // Exact numbers: distinct big integers / decimals are changes; the same value written differently is not.
  const num = (a, b) => J.jsonChanges(J.jsonParse(a), J.jsonParse(b), 10).total;
  assert.equal(J.JSON_EXACT_NUMBERS, true, "Node 24 supports JSON.parse source text access");
  {
    assert.equal(num("9007199254740992", "9007199254740993"), 1);
    assert.equal(num('{"n":12345678901234567890}', '{"n":12345678901234567891}'), 1);
    assert.equal(num("0.1", "0.1000000000000000001"), 1);
    assert.equal(num("1e400", "2e400"), 1);
  }
  assert.equal(num("1", "1.0"), 0); assert.equal(num("1.50", "1.5"), 0); assert.equal(num("100", "1e2"), 0); assert.equal(num("-2.50", "-2.5"), 0); assert.equal(num("-2", "2"), 1, "sign kept");
  assert.equal(num("1", '"1"'), 1, "number vs string"); assert.equal(num('"a"', '"b"'), 1, "scalar roots");
  assert.deepEqual(J.jsonChanges(J.jsonParse('{"__proto__":{"x":1}}'), J.jsonParse('{"__proto__":{"x":2}}'), 10).list.map((x) => x.path), ['$.__proto__.x']);
  assert.equal(Object.prototype.x, undefined, "no prototype pollution");
  assert.equal(Object.getPrototypeOf(J.jsonParse('{"__proto__":{"x":1}}')), Object.prototype, "__proto__ key is an own property");
  // Pathological numbers: linear, and exponents too long for exact arithmetic only match identical text.
  const t0 = performance.now();
  assert.equal(num("1" + "0".repeat(80000) + "1", "1" + "0".repeat(80000) + "2"), 1);
  assert.ok(performance.now() - t0 < 500, "long digit runs stay linear");
  assert.equal(num("1e9007199254740992", "1e9007199254740993"), 1);
  assert.equal(num("1e9007199254740992", "1e9007199254740992"), 0);
  // An unfinished walk says so instead of reporting "no changes".
  const huge = (last) => J.jsonParse("[" + Array(200001).fill(0).join(",") + "," + last + "]");
  const hz = J.jsonChanges(huge(0), huge(1), 300);
  assert.equal(hz.incomplete, true); assert.equal(hz.total, 0);
  assert.equal(J.jsonChanges(J.jsonParse("[1]"), J.jsonParse("[1]"), 300).incomplete, false);
  const big = J.jsonChanges(J.jsonParse(JSON.stringify(Array.from({ length: 1000 }, (_, i) => i))), J.jsonParse("[]"), 300);
  assert.equal(big.total, 1000); assert.equal(big.list.length, 300);
  assert.equal(J.jsonBrief(J.jsonParse("12345678901234567890")), "12345678901234567890");
  assert.equal(J.jsonBrief(J.jsonParse('{"a":1,"b":2}')), "{2 keys}");
  assert.ok(J.jsonBrief("x".repeat(500)).length <= 120);
});

test("numeric cell detection is linear on hostile whitespace and still recognises numbers", () => {
  const t = performance.now();
  assert.equal(J.isNumericCell(" ".repeat(100000) + "X"), false);
  assert.equal(J.isNumericCell(" ".repeat(60) + "1"), true);
  assert.ok(performance.now() - t < 50, "fast");
  for (const v of ["1", " -3 ", "12.50", "1,000", "1e5", "45%"]) assert.equal(J.isNumericCell(v), true, v);
  for (const v of ["", " ", "-", "1-2", "abc", "2026-10-01"]) assert.equal(J.isNumericCell(v), false, v);
});

test("invalid JSON is reported by line and column", () => {
  const text = '{\n  "a": 1,\n  "b"';
  let err; try { JSON.parse(text); } catch (e) { err = e; }
  assert.match(J.jsonErrorText(err, text), /^Invalid JSON near line 3, column \d+$/, err.message);
  assert.equal(J.jsonErrorText(new SyntaxError("JSON.parse: expected ':' at line 4 column 7 of the JSON data"), ""), "Invalid JSON near line 4, column 7");
  assert.equal(J.jsonErrorText(new SyntaxError("JSON Parse error: Expected '}'"), "x"), "Invalid JSON");
});

// ---------- 2. real browser ----------
const CSV_TRICKY = "id,name,note,amount\r\n1,\"Smith, Jane\",\"line one\nline two\",12.50\r\n2,Bob,\"she said \"\"hi\"\"\",-3\r\n3,Ann,,1000\r\n";
// Written as text so the big integer and 1.50 reach the server exactly as typed.
const JSON_OBJECT = '{\n  "title": "Synthetic metrics",\n  "version": 1.50,\n  "active": true,\n  "missing": null,\n  "big": 12345678901234567890,\n  "nested": { "level2": { "level3": { "deep": "folded" } } },\n  "tags": ["a", "b"]\n}\n';
const JSON_ROWS = JSON.stringify([{ week: "2026-W01", visits: 120, signups: 7 }, { week: "2026-W02", visits: 143, signups: 9 }, { week: "2026-W03", visits: 98, signups: 4 }]);
const HOSTILE = '<img src=x onerror="window.__pwned=1">';
const CSV_HOSTILE = `"${HOSTILE.replace(/"/g, '""')}",plain\n"=HYPERLINK(""http://example.invalid"",""x"")","</script><script>window.__pwned=2</script>"\n`;
const JSON_HOSTILE = JSON.stringify({ [HOSTILE]: "</script><script>window.__pwned=3</script>", list: [{ [HOSTILE]: "=HYPERLINK(\"http://example.invalid\")", n: 1 }] });
const CSV_LARGE = "n,label\n" + Array.from({ length: 1200 }, (_, i) => `${i + 1},row ${i + 1}`).join("\n") + "\n";
const JSON_LARGE = JSON.stringify(Array.from({ length: 1240 }, (_, i) => i));
const WIDE_CSV = Array.from({ length: 14 }, (_, i) => `column_heading_${i}`).join(",") + "\n" + Array.from({ length: 14 }, () => "a fairly long synthetic cell value").join(",") + "\n";

let h, owner, browser;
const ids = {};
before(async () => {
  h = await startAppConnectServer({ port: SERVER_PORTS["data-preview"] });
  owner = await h.owner();
  assert.equal((await owner.req("POST", "/api/projects", { id: "data", title: "Data" })).status, 201);
  const files = { tricky: ["csv", "Survey.csv", CSV_TRICKY], obj: ["json", "Settings.json", JSON_OBJECT], rows: ["json", "Weekly metrics.json", JSON_ROWS],
    hcsv: ["csv", "Hostile.csv", CSV_HOSTILE], hjson: ["json", "Hostile.json", JSON_HOSTILE], large: ["csv", "Large.csv", CSV_LARGE],
    ljson: ["json", "Large.json", JSON_LARGE], wide: ["csv", "Wide.csv", WIDE_CSV] };
  for (const [k, [kind, title, content]] of Object.entries(files)) {
    const r = await owner.req("POST", "/api/projects/data/artifacts", { kind, title, content });
    assert.equal(r.status, 201, `${title}: ${JSON.stringify(r.body)}`);
    ids[k] = r.body.artifact_id;
  }
  if (haveChrome) browser = await require(PUPPETEER).launch({ executablePath: CHROME, headless: true, args: ["--no-first-run"] });
});
after(async () => { await browser?.close(); await h?.stop(); });

async function open(key, vp = DESKTOP, scheme = "light") {
  const ctx = await browser.createBrowserContext(); const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message)); page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
  await page.setViewport(vp);
  const [cn, cv] = owner.cookie.split("="); await page.setCookie({ name: cn, value: cv, url: h.appUi });
  await page.goto(`${h.appUi}/#/p/data/a/${ids[key]}`); await page.waitForSelector(".datafile");
  return { page, ctx, errors };
}
const clickTab = (page, name) => page.evaluate((n) => [...document.querySelectorAll("[role=tab]")].find((b) => b.textContent.trim() === n).click(), name);
const cells = (page) => page.evaluate(() => [...document.querySelectorAll(".data-table tr")].map((r) => [...r.cells].map((c) => c.textContent)));
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test("CSV: quoted commas, embedded newlines and \"\" escapes land in the right cells; numbers right-aligned; summary", { skip: !haveChrome && "Chrome not installed" }, async () => {
  const { page, ctx, errors } = await open("tricky");
  assert.deepEqual(await cells(page), [["id", "name", "note", "amount"], ["1", "Smith, Jane", "line one\nline two", "12.50"], ["2", "Bob", 'she said "hi"', "-3"], ["3", "Ann", "", "1000"]]);
  const info = await page.evaluate(() => ({
    summary: document.querySelector(".data-summary").textContent,
    numCols: [...document.querySelectorAll(".data-table thead th")].map((th) => th.classList.contains("num")),
    align: getComputedStyle(document.querySelector(".data-table tbody td.num")).textAlign,
    sticky: getComputedStyle(document.querySelector(".data-table thead th")).position,
    tabs: [...document.querySelectorAll("[role=tablist] [role=tab]")].map((b) => b.textContent),
    downloads: null,
  }));
  assert.match(info.summary, /^3 rows · 4 columns · \d+ B$/);
  assert.deepEqual(info.numCols, [true, false, false, true]);
  assert.equal(info.align, "right"); assert.equal(info.sticky, "sticky");
  assert.deepEqual(info.tabs, ["Preview", "Raw", "History", "Comments"]);
  // The spreadsheet export appears once the app has confirmed the server serves it (App Connect on here).
  await page.waitForFunction(() => document.querySelectorAll(".data-actions a").length === 2, { polling: 50 });
  info.downloads = await page.evaluate(() => [...document.querySelectorAll(".data-actions a")].map((a) => [a.textContent, new URL(a.href).search]));
  assert.deepEqual(info.downloads.map((d) => d[0]), ["Download", "Download for spreadsheets"]);
  assert.match(info.downloads[1][1], /format=spreadsheet/);
  // Raw shows the exact stored text (CRLF and all).
  await page.evaluate(() => [...document.querySelectorAll("[role=tab]")].find((b) => b.textContent === "Raw").click());
  assert.equal(await page.evaluate(() => document.querySelector("pre.raw").textContent), CSV_TRICKY);
  assert.equal(await page.evaluate(() => !document.querySelector("pre.raw").closest("[hidden]")), true);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("JSON object: collapsible tree with coloured tokens, deeper levels folded, exact numbers, summary", { skip: !haveChrome && "Chrome not installed" }, async () => {
  const { page, ctx, errors } = await open("obj");
  const t = await page.evaluate(() => ({
    summary: document.querySelector(".data-summary").textContent,
    keys: [...document.querySelectorAll(".j-key")].filter((k) => !k.closest("[hidden]")).map((k) => k.textContent),
    big: [...document.querySelectorAll(".j-num")].map((n) => n.textContent),
    classes: ["j-str", "j-num", "j-bool", "j-null"].map((c) => !!document.querySelector("." + c)),
    deepVisible: [...document.querySelectorAll(".j-str")].some((s) => s.textContent === '"folded"' && !s.closest("[hidden]")),
    toggle: !!document.querySelector(".data-views"),
  }));
  assert.match(t.summary, /^Object · 7 keys · /);
  assert.ok(t.keys.includes('"title"') && t.keys.includes('"level2"'), "two levels open");
  assert.ok(!t.keys.includes('"level3"'), "level 3 folded");
  assert.ok(t.big.includes("12345678901234567890") && t.big.includes("1.50"), "numbers shown as written: " + t.big);
  assert.deepEqual(t.classes, [true, true, true, true]);
  assert.equal(t.deepVisible, false); assert.equal(t.toggle, false, "no Table view for a non-tabular object");
  // Expanding level2 reveals level3; collapsing hides it again.
  await page.evaluate(() => [...document.querySelectorAll(".j-toggle")].find((b) => /level2/.test(b.getAttribute("aria-label"))).click());
  assert.ok(await page.evaluate(() => [...document.querySelectorAll(".j-key")].some((k) => k.textContent === '"level3"' && !k.closest("[hidden]"))));
  await page.evaluate(() => [...document.querySelectorAll("[role=tab]")].find((b) => b.textContent === "Raw").click());
  assert.equal(await page.evaluate(() => document.querySelector("pre.raw").textContent), JSON_OBJECT);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("JSON array of flat objects offers Table, rendered like CSV", { skip: !haveChrome && "Chrome not installed" }, async () => {
  const { page, ctx, errors } = await open("rows");
  assert.match(await page.evaluate(() => document.querySelector(".data-summary").textContent), /^Array · 3 items/);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll(".data-actions a")].map((a) => a.textContent)), ["Download"], "JSON has one download and no stray text");
  assert.equal(await page.evaluate(() => document.querySelector(".data-actions").textContent), "Download");
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll(".data-views button")].map((b) => [b.textContent, b.getAttribute("aria-pressed")])), [["Tree", "true"], ["Table", "false"]]);
  await page.evaluate(() => [...document.querySelectorAll(".data-views button")].find((b) => b.textContent === "Table").click());
  assert.deepEqual(await cells(page), [["week", "visits", "signups"], ["2026-W01", "120", "7"], ["2026-W02", "143", "9"], ["2026-W03", "98", "4"]]);
  assert.equal(await page.evaluate(() => document.querySelector(".data-views button[aria-pressed=true]").textContent), "Table");
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("hostile cells and keys stay inert text (no elements, no script runs)", { skip: !haveChrome && "Chrome not installed" }, async () => {
  for (const key of ["hcsv", "hjson"]) {
    const { page, ctx } = await open(key);
    if (key === "hjson") await page.evaluate(() => { const b = [...document.querySelectorAll(".data-views button")].find((x) => x.textContent === "Table"); if (b) b.click(); else [...document.querySelectorAll(".j-toggle[aria-expanded=false]")].forEach((x) => x.click()); });
    if (key === "hjson") await page.waitForFunction(() => !!document.querySelector(".data-table td") || !document.querySelector(".j-toggle[aria-expanded=false]"), { polling: 50 });
    const r = await page.evaluate(() => ({ pwned: window.__pwned, tags: document.querySelectorAll(".datafile img, .datafile script, main pre.raw *").length, text: document.querySelector(".datafile").textContent }));
    assert.equal(r.pwned, undefined, key); assert.equal(r.tags, 0, key);
    assert.ok(r.text.includes('<img src=x onerror="window.__pwned=1">') || r.text.includes('"<img src=x onerror=\\"window.__pwned=1\\">"'), key + ": hostile markup shown as text");
    assert.ok(/=HYPERLINK\(/.test(r.text), key + ": formula shown as text");
    await ctx.close();
  }
});

test("large files: first 500 rows with a download note; JSON arrays render in batches", { skip: !haveChrome && "Chrome not installed" }, async () => {
  let { page, ctx } = await open("large");
  const r = await page.evaluate(() => ({ rows: document.querySelectorAll(".data-table tbody tr").length, note: document.querySelector(".data-note").textContent, summary: document.querySelector(".data-summary").textContent }));
  assert.equal(r.rows, 500); assert.match(r.summary, /^1,200 rows · 2 columns/);
  assert.equal(r.note, "Showing 500 of 1,200 rows · Download for the full file");
  await ctx.close();
  ({ page, ctx } = await open("ljson"));
  const j = await page.evaluate(() => ({ nums: document.querySelectorAll(".j-num").length, more: document.querySelector(".j-showmore")?.textContent, note: document.querySelector(".data-note")?.textContent }));
  assert.equal(j.nums, 500); assert.match(j.more, /^Show 500 more \(740 not shown\)$/); assert.match(j.note, /1,240 in all/);
  await page.click(".j-showmore");
  assert.equal(await page.evaluate(() => document.querySelectorAll(".j-num").length), 1000);
  await ctx.close();
});

for (const [name, vp] of [["390", PHONE_390], ["320", PHONE_320]]) {
  test(`mobile ${name}px: data previews never scroll the page sideways`, { skip: !haveChrome && "Chrome not installed" }, async () => {
    for (const key of ["wide", "tricky", "obj", "hjson"]) {
      const { page, ctx, errors } = await open(key, vp, "dark");
      assert.equal(await overflow(page), 0, `${key}: page overflow`);
      if (key === "wide") assert.ok(await page.evaluate(() => { const s = document.querySelector(".data-scroll"); return s.scrollWidth > s.clientWidth; }), "wide table scrolls inside its box");
      await page.evaluate(() => [...document.querySelectorAll("[role=tab]")].find((b) => b.textContent === "Raw").click());
      assert.equal(await overflow(page), 0, `${key}: raw overflow`);
      assert.deepEqual(errors, []);
      await ctx.close();
    }
  });
}

test("lists label CSV and JSON files with their own badge and icon", { skip: !haveChrome && "Chrome not installed" }, async () => {
  const { page, ctx } = await open("tricky");
  await page.goto(`${h.appUi}/#/p/data`); await page.waitForSelector(".list li .badge");
  const badges = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll(".list li")].map((li) => [li.querySelector("a")?.textContent, li.querySelector(".badge")?.textContent])));
  assert.equal(badges["Survey.csv"], "CSV"); assert.equal(badges["Settings.json"], "JSON");
  await ctx.close();
});

// ---------- uploads and version history ----------
import { tmpdir } from "node:os";
const upDir = join(tmpdir(), "al-data-preview-uploads"); mkdirSync(upDir, { recursive: true });
const upFile = (name, content) => { const f = join(upDir, name); writeFileSync(f, content); return f; };

async function uploadNew(page, file, title) {
  await page.goto("about:blank"); await page.goto(`${h.appUi}/#/p/data`); await page.waitForSelector(".list li .badge");
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Upload file").click());
  const input = await page.waitForSelector('input[type=file][aria-label="File to upload"]');
  assert.match(await input.evaluate((i) => i.accept), /\.csv/); assert.match(await input.evaluate((i) => i.accept), /\.json/);
  await input.uploadFile(file);
  if (title) await page.type('input[placeholder^="Title"]', title);
  await page.evaluate(() => document.querySelector('input[type=file][aria-label="File to upload"]').closest("form").querySelector("button[type=submit]").click());
  await page.waitForFunction(() => /Uploaded revision|\(4\d\d|Fix the file/.test(document.querySelector('input[type=file][aria-label="File to upload"]').closest("form").nextElementSibling.textContent), { polling: 100 });
  return page.evaluate(() => document.querySelector('input[type=file][aria-label="File to upload"]').closest("form").nextElementSibling.textContent);
}

test("upload: a CSV (with a spreadsheet BOM) and a JSON file become CSV / JSON items with previews", { skip: !haveChrome && "Chrome not installed" }, async () => {
  const { page, ctx, errors } = await open("tricky");
  assert.match(await uploadNew(page, upFile("Uploaded survey.csv", "\ufeffq,score\r\n\"Hello, world\",5\r\n"), null), /Uploaded revision 1/);
  assert.match(await uploadNew(page, upFile("upload.json", '{"ok":true,"items":[1,2]}'), "Uploaded settings"), /Uploaded revision 1/);
  const list = await owner.req("GET", "/api/projects/data/artifacts");
  const csv = list.body.artifacts.find((a) => a.title === "Uploaded survey.csv"), json = list.body.artifacts.find((a) => a.title === "Uploaded settings");
  assert.equal(csv?.kind, "csv"); assert.equal(json?.kind, "json");
  const stored = await owner.req("GET", `/api/projects/data/artifacts/${csv.id}`);
  assert.equal(stored.body.content, 'q,score\r\n"Hello, world",5\r\n', "BOM dropped, everything else byte-exact");
  await page.goto(`${h.appUi}/#/p/data/a/${csv.id}`); await page.waitForSelector(".data-table");
  assert.deepEqual(await cells(page), [["q", "score"], ["Hello, world", "5"]]);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("upload: invalid CSV is refused with the server's reason; non-UTF-8 and oversized files never leave the browser", { skip: !haveChrome && "Chrome not installed" }, async () => {
  const { page, ctx } = await open("tricky");
  const before = (await owner.req("GET", "/api/projects/data/artifacts")).body.artifacts.length;
  const bad = await uploadNew(page, upFile("bad.csv", "a,b\n1,2,3\n"), null);
  assert.match(bad, /^bad\.csv: Invalid CSV: expected 2 columns, found 3 \(line 2\)\. Fix the file and upload it again\.$/, "checked in the browser, no status code or retry hint");
  await page.evaluate(() => { document.querySelector('input[type=file][aria-label="File to upload"]').closest("form").nextElementSibling.textContent = ""; });
  await page.evaluate(() => { document.querySelector('input[type=file][aria-label="File to upload"]').value = ""; });
  const latin1 = join(upDir, "latin1.csv"); writeFileSync(latin1, Buffer.from([0x61, 0x0a, 0xe9, 0x0a]));
  const input = await page.$('input[type=file][aria-label="File to upload"]'); await input.uploadFile(latin1);
  await page.evaluate(() => document.querySelector('input[type=file][aria-label="File to upload"]').closest("form").querySelector("button[type=submit]").click());
  await page.waitForFunction(() => /UTF-8/.test(document.querySelector('input[type=file][aria-label="File to upload"]').closest("form").nextElementSibling.textContent), { polling: 100 });
  assert.equal((await owner.req("GET", "/api/projects/data/artifacts")).body.artifacts.length, before, "nothing created");
  await ctx.close();
});

test("replace a CSV with a new version, then History shows a line diff; a stale tab gets a conflict, not an overwrite", { skip: !haveChrome && "Chrome not installed" }, async () => {
  const id = (await owner.req("POST", "/api/projects/data/artifacts", { kind: "csv", title: "Versions.csv", content: "city,temp\nOslo,4\nLima,19\n" })).body.artifact_id;
  const { page, ctx, errors } = await open("tricky");
  const stale = await ctx.newPage(); const [cn, cv] = owner.cookie.split("="); await stale.setCookie({ name: cn, value: cv, url: h.appUi });
  for (const p of [page, stale]) { await p.goto(`${h.appUi}/#/p/data/a/${id}`); await p.waitForSelector(".datafile"); }
  const replace = async (p, file) => {
    await p.evaluate(() => { const d = [...document.querySelectorAll("details")].find((x) => /Replace with a new version/.test(x.textContent)); d.open = true; });
    const input = await p.$('details input[type=file]');
    assert.equal(await input.evaluate((i) => i.accept), ".csv,text/csv");
    await input.uploadFile(file);
    await p.evaluate(() => [...document.querySelectorAll("details button[type=submit]")].find((b) => /Upload new version/.test(b.textContent)).click());
    await p.waitForFunction(() => /Uploaded revision|changed since|Choose a|\(4\d\d/.test([...document.querySelectorAll("details .msg")].map((m) => m.textContent).join(" ")), { polling: 100 });
    return p.evaluate(() => [...document.querySelectorAll("details .msg")].map((m) => m.textContent).join(" "));
  };
  assert.match(await replace(page, upFile("v2.csv", "city,temp\nOslo,5\nLima,19\nCairo,30\n")), /Uploaded revision 2/);
  await page.waitForFunction(() => /rev 2/.test(document.querySelector("main .muted.small")?.textContent || ""), { polling: 100 });
  assert.deepEqual((await cells(page)).slice(1), [["Oslo", "5"], ["Lima", "19"], ["Cairo", "30"]], "preview reloads to the new version");
  await stale.bringToFront();
  assert.match(await replace(stale, upFile("v2b.csv", "city,temp\nOslo,0\n")), /changed since you opened it \(now at rev 2\)/);
  assert.equal((await owner.req("GET", `/api/projects/data/artifacts/${id}`)).body.revision.rev, 2, "stale tab did not overwrite");
  // A JSON file picked for a CSV is refused in the browser.
  assert.equal((await replace(stale, upFile("wrong.json", "{}"))).trim(), "Choose a CSV file to replace this one.", "local check: no retry hint");

  await page.bringToFront();
  await clickTab(page, "History"); await page.waitForSelector('.vh-row[data-rev="2"] button');
  await page.click('.vh-row[data-rev="2"] button');
  await page.waitForSelector(".vh-diff .vh-line.add");
  const lines = await page.$$eval(".vh-diff .vh-line", (ls) => ls.map((l) => [l.className.replace("vh-line ", ""), l.querySelector(".vh-t").textContent]));
  const changed = lines.filter((l) => l[0] !== "ctx").map((l) => l.join(" ")).sort();
  assert.deepEqual(changed, ["add Cairo,30", "add Oslo,5", "del Oslo,4"]);
  assert.match(await page.$eval(".vh-detail .vh-body > p.muted.small", (p) => p.textContent), /2 added, 1 removed/);
  // Preview of an older version renders the same table.
  await page.click('.vh-row[data-rev="1"] button');
  await page.waitForFunction(() => [...document.querySelectorAll(".vh-detail button")].some((b) => b.textContent === "Preview v1"));
  await page.evaluate(() => [...document.querySelectorAll(".vh-detail button")].find((b) => b.textContent === "Preview v1").click());
  await page.waitForSelector(".vh-detail .data-table");
  assert.deepEqual(await page.$$eval(".vh-detail .data-table tbody tr", (rs) => rs.map((r) => [...r.cells].map((c) => c.textContent))), [["Oslo", "4"], ["Lima", "19"]]);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("JSON History compares values by path (minified one-line JSON too), with hostile keys as text", { skip: !haveChrome && "Chrome not installed" }, async () => {
  const id = (await owner.req("POST", "/api/projects/data/artifacts", { kind: "json", title: "Config.json", content: '{"name":"a","limits":{"rows":10},"tags":["x"]}' })).body.artifact_id;
  assert.equal((await owner.req("PUT", `/api/projects/data/artifacts/${id}`, { expected_revision: 1, content: JSON.stringify({ name: "b", limits: { rows: 10, cols: 4 }, [HOSTILE]: 1 }) })).status, 200);
  const { page, ctx, errors } = await open("tricky");
  await page.goto(`${h.appUi}/#/p/data/a/${id}`); await page.waitForSelector(".datafile");
  await clickTab(page, "History"); await page.waitForSelector('.vh-row[data-rev="2"] button');
  await page.click('.vh-row[data-rev="2"] button');
  await page.waitForSelector(".vh-json .vh-jrow");
  const rows = await page.$$eval(".vh-json .vh-jrow", (rs) => rs.map((r) => [r.className.replace("vh-jrow ", ""), r.querySelector(".vh-jpath").textContent, r.querySelector(".vh-jold")?.textContent ?? null, r.querySelector(".vh-jnew")?.textContent ?? null]));
  const byPath = Object.fromEntries(rows.map((r) => [r[1], r]));
  assert.equal(rows.length, 4);
  assert.deepEqual(byPath["$.name"], ["changed", "$.name", '"a"', '"b"']);
  assert.deepEqual(byPath["$.tags"], ["removed", "$.tags", "[1 item]", null]);
  assert.deepEqual(byPath["$.limits.cols"], ["added", "$.limits.cols", null, "4"]);
  const hp = `$[${JSON.stringify(HOSTILE)}]`;
  assert.deepEqual(byPath[hp], ["added", hp, null, "1"], "hostile key shown as its literal text");
  assert.match(await page.$eval(".vh-detail .vh-body > p.muted.small", (p) => p.textContent), /^Changes from v1 to v2 · 1 changed, 2 added, 1 removed$/);
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.equal(await page.$$eval(".vh-json img", (x) => x.length), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("a 409 that is not a revision conflict (replacing a trashed file) shows the server's reason and a retry hint", { skip: !haveChrome && "Chrome not installed" }, async () => {
  const id = (await owner.req("POST", "/api/projects/data/artifacts", { kind: "csv", title: "Trashed later.csv", content: "a\n1\n" })).body.artifact_id;
  const { page, ctx } = await open("tricky");
  await page.goto(`${h.appUi}/#/p/data/a/${id}`); await page.waitForSelector(".datafile");
  const meta = (await owner.req("GET", `/api/projects/data/artifacts/${id}`)).body.artifact;
  const trash = await owner.req("PATCH", `/api/projects/data/artifacts/${id}`, { expected_meta_version: meta.meta_version, trashed: true });
  assert.equal(trash.status, 200, JSON.stringify(trash.body));
  await page.evaluate(() => { const d = [...document.querySelectorAll("details")].find((x) => /Replace with a new version/.test(x.textContent)); d.open = true; });
  const input = await page.$("details input[type=file]"); await input.uploadFile(upFile("v2-trashed.csv", "a\n2\n"));
  await page.evaluate(() => [...document.querySelectorAll("details button[type=submit]")].find((b) => /Upload new version/.test(b.textContent)).click());
  await page.waitForFunction(() => /\(4\d\d|changed since/.test([...document.querySelectorAll("details .msg")].map((m) => m.textContent).join(" ")), { polling: 100 });
  const text = await page.evaluate(() => [...document.querySelectorAll("details .msg")].map((m) => m.textContent).join(" "));
  assert.doesNotMatch(text, /changed since you opened it/);
  assert.match(text, /\(4\d\d [a-z_]+\) - press Upload again to retry\./);
  await ctx.close();
});
