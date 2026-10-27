// Mobile tables (GFM pipe tables in the rendered reader). Two layers:
//  1. Renderer unit tests on the exact module that is spliced into the runtime (src/render/markdown.module.js):
//     tables are parsed, escaped, aligned and bounded; non-tables stay paragraphs.
//  2. Real Chrome against the real local runtime (loopback, synthetic owner) at a Pixel 9 portrait CSS viewport
//     (412x923 @ 2.625, mobile + touch), a 320 px Android viewport and 1440 desktop, using a synthetic fixture
//     that mirrors a real planning document's table shapes (test/fixtures/mobile-tables.md).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { startAppConnectServer } from "./fixtures/app-connect-harness.mjs";
import { SERVER_PORTS } from "./ports.mjs";

const require = createRequire(import.meta.url);
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PUPPETEER = `${process.env.HOME}/.npm-packages/lib/node_modules/puppeteer`;
const haveChrome = existsSync(CHROME) && existsSync(PUPPETEER);
const PIXEL9 = { width: 412, height: 923, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true };
const ANDROID_320 = { width: 320, height: 658, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const DESKTOP = { width: 1440, height: 900, deviceScaleFactor: 1 };

const moduleSrc = readFileSync(new URL("../src/render/markdown.module.js", import.meta.url), "utf8");
const { renderMarkdown } = new Function("__name", moduleSrc + "; return { renderMarkdown };")((f) => f);
const FIXTURE = readFileSync(new URL("./fixtures/mobile-tables.md", import.meta.url), "utf8");

test("renderer: pipe table -> semantic table with column headers, alignment classes and escaped inline content", () => {
  const html = renderMarkdown("| A | <b>B</b> | C |\n|:--|:-:|--:|\n| `x \\| y` | pipe \\| esc | [l](https://e.com/a?b=1&c=2) |\n| short |");
  assert.match(html, /^<table><thead><tr><th scope="col" class="al-left">A<\/th><th scope="col" class="al-center">&lt;b&gt;B&lt;\/b&gt;<\/th><th scope="col" class="al-right">C<\/th><\/tr><\/thead><tbody>/);
  assert.match(html, /<td class="al-left"><code>x \| y<\/code><\/td><td class="al-center">pipe \| esc<\/td>/, "escaped pipes are literal, inside and outside code");
  assert.match(html, /<a href="https:\/\/e\.com\/a\?b=1&amp;c=2" rel="noopener noreferrer nofollow" target="_blank">l<\/a>/);
  assert.match(html, /<tr><td class="al-left">short<\/td><td class="al-center"><\/td><td class="al-right"><\/td><\/tr><\/tbody><\/table>$/, "short rows padded to the header width");
});

test("renderer: pipes inside inline code don't split cells; extra cells are dropped; table ends at a non-table line", () => {
  assert.equal(renderMarkdown("| a | b |\n|---|---|\n| `x | y` | z |"), '<table><thead><tr><th scope="col">a</th><th scope="col">b</th></tr></thead><tbody><tr><td><code>x | y</code></td><td>z</td></tr></tbody></table>');
  assert.match(renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 | 3 |"), /<tr><td>1<\/td><td>2<\/td><\/tr>/);
  assert.equal(renderMarkdown("| h |\n|---|\n| v |\nafter"), '<table><thead><tr><th scope="col">h</th></tr></thead><tbody><tr><td>v</td></tr></tbody></table>\n<p>after</p>');
});

test("renderer: things that are not GFM tables stay paragraphs (column-count mismatch, no delimiter row, setext-like ---)", () => {
  assert.equal(renderMarkdown("| a | b |\n|---|---|---|\n| 1 | 2 |"), "<p>| a | b | |---|---|---| | 1 | 2 |</p>");
  assert.equal(renderMarkdown("a | b\nc | d"), "<p>a | b c | d</p>");
  assert.equal(renderMarkdown("text\n---\nmore"), "<p>text --- more</p>");
});

test("renderer: no raw HTML or unsafe links can come out of a table cell", () => {
  const html = renderMarkdown('| <img src=x onerror=alert(1)> | "q" |\n|---|---|\n| <script>x</script> | [x](javascript:alert(1)) |');
  assert.doesNotMatch(html, /<img|<script|<a |href=/i, "no live tags, attributes or links");
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("renderer: bounded and linear on hostile input (long delimiter lines, huge column counts, many rows)", () => {
  const time = (md) => { const t = performance.now(); const out = renderMarkdown(md); return { ms: performance.now() - t, out }; };
  const a = time("| a |\n" + " ".repeat(1 << 20) + "x");
  assert.ok(a.ms < 500, `1 MiB whitespace delimiter line: ${a.ms.toFixed(0)}ms`);
  const b = time("|" + "a|".repeat(2000) + "\n|" + "-|".repeat(2000) + "\n" + "|\n".repeat(2000));
  assert.doesNotMatch(b.out, /<table>/, "over 64 columns: not a table"); assert.ok(b.out.length < 20000, "no padding blow-up");
  const c = time("|" + "a|".repeat(64) + "\n|" + "-|".repeat(64) + "\n" + "|\n".repeat(5000));
  assert.ok(c.out.length < 400000, `cell budget bounds the output (${c.out.length} bytes)`);
  assert.equal((c.out.match(/<tr>/g) || []).length * 64 <= 20000 && (c.out.match(/<tr>/g) || []).length, 20000 / 64 | 0, "header + body cells stay within the document cell budget; the rest stays text");
  // Budget is document-wide: a 1 MiB document of repeated near-budget 64-column tables stays proportional.
  const one = "|" + "abcdefghijklmnopqrstuvwxyzabcdefghijklmno|".repeat(64) + "\n|" + "-|".repeat(64) + "\n" + "|\n".repeat(311);
  const e = time(one.repeat(Math.ceil((1 << 20) / one.length)));
  assert.ok(e.out.length < 8 * (1 << 20), `repeated tables: ${(e.out.length / 1048576).toFixed(1)} MiB out for 1 MiB in`);
  assert.ok(e.ms < 3000, `repeated tables: ${e.ms.toFixed(0)}ms`);
  // A row longer than the line limit ends the table; the rest renders as text (documented limit).
  assert.match(renderMarkdown("| a |\n|---|\n| " + "x".repeat(5000) + " |\n| b |"), /^<table>.*<\/table>\n<p>\| x{5000}/s);
  const d = time("|x|\n|-|\n" + "|x|\n".repeat(200000));
  assert.ok(d.ms < 2000 && d.out.startsWith("<table>"), `200k rows do not throw (${d.ms.toFixed(0)}ms)`);
});

test("client: no regex lookbehind in the shipped UI (older Safari cannot parse it and would load nothing)", () => {
  const js = readFileSync(new URL("../src/web/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(js, /\(\?<[=!]/);
});

test("renderer: multiline cells — <br>, <br/>, <br /> (any case) become line breaks only inside table cells", () => {
  const cell = (md) => renderMarkdown("| a |\n|---|\n| " + md + " |").replace(/^.*<tbody><tr><td[^>]*>|<\/td>.*$/gs, "");
  assert.equal(cell("one<br>two"), "one <br>two", "joined with \" <br>\" so textContent keeps words apart");
  assert.equal(cell("one<BR/>two"), "one <br>two");
  assert.equal(cell("one <Br  /> two"), "one <br>two");
  assert.equal(cell("<br><br>"), " <br> <br>", "empty lines are kept");
  // Links, code, escaped pipes and emphasis still work on each line.
  assert.equal(cell("[link](https://e.com)<br>`code | pipe`<br>pipe \\| esc"),
    '<a href="https://e.com" rel="noopener noreferrer nofollow" target="_blank">link</a> <br><code>code | pipe</code> <br>pipe | esc');
  // Literal code keeps the text; a backslash-escaped <br> stays text.
  assert.equal(cell("`a<br>b`"), "<code>a&lt;br&gt;b</code>");
  assert.equal(cell("one\\<br>two"), "one\\&lt;br&gt;two");
  // An unclosed backtick is plain text (as in paragraphs), so breaks after it still count; a closed span is code.
  assert.equal(cell("`a<br>b"), "`a <br>b");
  assert.equal(cell("`a<br>b` c<br>d"), "<code>a&lt;br&gt;b</code> c <br>d");
  // Markup spanning a break is not joined across lines: it stays literal text on each line (pinned behavior).
  assert.equal(cell("**x<br>y**"), "**x <br>y**");
  // Only exact ASCII spaces/tabs may precede "/>"; other whitespace (NBSP) stays text. At most 32 breaks per cell.
  assert.equal(cell("a<br\u00a0/>b"), "a&lt;br\u00a0/&gt;b");
  assert.equal((cell("<br>".repeat(40)).match(/<br>/g) || []).length, 32);
  // Text typed as entities stays exactly that text.
  assert.equal(cell("one&lt;br&gt;two"), "one&amp;lt;br&amp;gt;two");
  // A raw newline still ends the row (GFM): nothing is merged across lines.
  assert.match(renderMarkdown("| a | b |\n|---|---|\n| one\ntwo | x |"), /<tr><td>one<\/td><td><\/td><\/tr><tr><td>two<\/td><td>x<\/td><\/tr>/);
  // Outside tables nothing changes: no raw HTML in paragraphs.
  assert.equal(renderMarkdown("para<br>two"), "<p>para&lt;br&gt;two</p>");
});

test("renderer: only the exact break token is honored — other tags and attributes stay escaped", () => {
  const cell = (md) => renderMarkdown("| a |\n|---|\n| " + md + " |").replace(/^.*<tbody><tr><td[^>]*>|<\/td>.*$/gs, "");
  for (const [md, want] of [
    ["<br onclick=alert(1)>", "&lt;br onclick=alert(1)&gt;"],
    ["<br/ onmouseover=x>", "&lt;br/ onmouseover=x&gt;"],
    ['<br style="x">', "&lt;br style=&quot;x&quot;&gt;"],
    ["<bra>", "&lt;bra&gt;"], ["<b>bold</b>", "&lt;b&gt;bold&lt;/b&gt;"], ["a<br", "a&lt;br"], ["</br>", "&lt;/br&gt;"],
    ["<script>x</script><br>y", "&lt;script&gt;x&lt;/script&gt; <br>y"],
    ['<img src=x onerror=alert(1)><br><a href="javascript:x">j</a>', '&lt;img src=x onerror=alert(1)&gt; <br>&lt;a href=&quot;javascript:x&quot;&gt;j&lt;/a&gt;'],
    ["[x](javascript:alert(1))<br>ok", "x) <br>ok"],
  ]) assert.equal(cell(md), want, md);
  const all = renderMarkdown("| <br onclick=x> | <svg onload=x><br>ok |\n|---|---|\n| <iframe src=x><br/> | <BR > |");
  assert.doesNotMatch(all.replace(/<br>/g, ""), /<(?!\/?(table|thead|tbody|tr|th|td|code|a|strong|em)\b)[a-z]/i, "no tag other than table parts and <br>");
  // Event-handler text only ever appears escaped, never as an attribute of a real tag.
  assert.doesNotMatch(all, /<[^>]*\son[a-z]+=/i);
  assert.equal((all.match(/<br>/g) || []).length, 3, "only the three exact break tokens became <br>");
});

test("renderer: width hints come from visible text so prose columns get a readable minimum", () => {
  const html = renderMarkdown(FIXTURE);
  assert.equal((html.match(/<table>/g) || []).length, 7, "all seven fixture tables render as tables");
  assert.doesNotMatch(html, /<p>\|/, "no table left as a pipe paragraph");
  const matrix = html.split("<table>")[2];
  assert.match(matrix, /<th scope="col">Repo<\/th>/);
  assert.match(matrix, /<th scope="col" class="w-long">CI<\/th>/, "long prose column is marked w-long");
});

let h, owner, browser, docId;
before(async () => {
  h = await startAppConnectServer({ port: SERVER_PORTS["mobile-tables"] });
  owner = await h.owner();
  assert.equal((await owner.req("POST", "/api/projects", { id: "tables", title: "Tables" })).status, 201);
  docId = (await owner.req("POST", "/api/projects/tables/artifacts", { title: "Synthetic table shapes", body: FIXTURE })).body.artifact_id;
  if (haveChrome) browser = await require(PUPPETEER).launch({ executablePath: CHROME, headless: true, args: ["--no-first-run"] });
});
after(async () => { await browser?.close(); await h?.stop(); });

async function open(vp, scheme = "light") {
  const ctx = await browser.createBrowserContext(); const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message)); page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
  await page.setViewport(vp);
  const [cn, cv] = owner.cookie.split("="); await page.setCookie({ name: cn, value: cv, url: h.appUi });
  await page.goto(`${h.appUi}/#/p/tables/a/${docId}`); await page.waitForSelector(".preview .table-wrap");
  return { page, ctx, errors };
}
const layout = (page) => page.evaluate(() => ({
  viewport: [innerWidth, innerHeight, devicePixelRatio],
  pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  tables: [...document.querySelectorAll(".preview .table-wrap")].map((w) => {
    const s = w.querySelector(".table-scroll"), t = w.querySelector("table"), sr = s.getBoundingClientRect(), pr = document.querySelector(".preview").getBoundingClientRect();
    // A column is "squeezed" if it is narrower than its longest header word or (for prose columns) below ~8em.
    const squeezed = [...t.tHead.rows[0].cells].filter((c) => {
      const words = c.textContent.split(/\s+/), probe = document.createElement("span"); probe.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap;font:" + getComputedStyle(c).font;
      document.body.append(probe); const longest = Math.max(...words.map((w) => { probe.textContent = w; return probe.getBoundingClientRect().width; })); probe.remove();
      const cs = getComputedStyle(c), inner = c.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      return inner + 1 < longest || (c.classList.contains("w-long") && inner < 8 * parseFloat(cs.fontSize));
    }).map((c) => c.textContent);
    return { cols: t.tHead.rows[0].cells.length, squeezed, minCol: Math.min(...[...t.tHead.rows[0].cells].map((c) => c.getBoundingClientRect().width)),
      contained: sr.left >= pr.left - 0.5 && sr.right <= pr.right + 0.5, scrolls: s.scrollWidth > s.clientWidth + 1, hint: !w.querySelector(".table-hint").hidden,
      font: parseFloat(getComputedStyle(t.querySelector("td")).fontSize), region: s.getAttribute("role"), label: s.getAttribute("aria-label"), focusable: s.getAttribute("tabindex") === "0",
      described: !!s.getAttribute("aria-describedby"), toggle: !!w.querySelector(".table-toggle:not([hidden])") };
  }),
}));

test("Pixel 9 portrait (412x923 CSS @2.625): tables are contained, columns readable, page never scrolls sideways", { skip: !haveChrome && "Chrome not installed" }, async () => {
  const { page, ctx, errors } = await open(PIXEL9);
  const l = await layout(page);
  assert.deepEqual(l.viewport, [412, 923, 2.625], "CSS viewport and device scale factor (not physical pixels)");
  assert.equal(l.pageOverflow, 0, "no page-wide horizontal overflow");
  assert.equal(l.tables.length, 7);
  for (const t of l.tables) {
    assert.ok(t.contained, "table scroller stays inside the reader column");
    assert.deepEqual(t.squeezed, [], "no column narrower than its longest header word; prose columns keep >= 8em");
    assert.ok(t.font >= 14, `readable cell font (${t.font}px)`);
    assert.equal(t.region, "region"); assert.match(t.label, /^Table: /);
    assert.equal(t.hint, t.scrolls, "the sideways hint appears exactly when columns are hidden");
    assert.equal(t.focusable, t.scrolls, "only a table that hides columns is a tab stop");
    assert.equal(t.described, t.scrolls, "the hint is announced only when it applies");
  }
  const wide = l.tables.find((t) => t.cols === 7);
  assert.ok(wide.scrolls && wide.hint, "the 7-column matrix scrolls inside its container and says so");
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("touch: a horizontal swipe scrolls the table, not the page; edge cues follow the position", { skip: !haveChrome && "Chrome not installed" }, async () => {
  const { page, ctx } = await open(PIXEL9);
  const wrapIdx = await page.evaluate(() => [...document.querySelectorAll(".preview .table-wrap")].findIndex((w) => w.querySelectorAll("th").length === 7));
  const box = await page.evaluate((i) => { const s = document.querySelectorAll(".preview .table-scroll")[i]; s.scrollIntoView({ block: "center" }); const r = s.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 200), w: r.width }; }, wrapIdx);
  const state = () => page.evaluate((i) => { const w = document.querySelectorAll(".preview .table-wrap")[i], s = w.querySelector(".table-scroll"); return { left: s.scrollLeft, pageX: scrollX, cls: w.className }; }, wrapIdx);
  assert.match((await state()).cls, /more-right/); assert.doesNotMatch((await state()).cls, /more-left/);
  // Real touch points (CDP Input.dispatchTouchEvent): a right-to-left drag across 70% of the scroller. Chrome's
  // synthesizeScrollGesture(touch) never starts a scroll in Linux headless Chrome (no touchmove reaches the page).
  const x0 = box.x + box.w * 0.35;
  await page.touchscreen.touchStart(x0, box.y);
  for (let i = 1; i <= 10; i++) await page.touchscreen.touchMove(x0 - box.w * 0.07 * i, box.y);
  await page.touchscreen.touchEnd();
  let s = await state();
  for (const end = Date.now() + 3000; !(s.left > 50 && /more-left/.test(s.cls)) && Date.now() < end; s = await state()) await new Promise((r) => setTimeout(r, 50));
  assert.ok(s.left > 50, `table scrolled sideways (${s.left}px)`);
  assert.equal(s.pageX, 0, "page did not scroll sideways");
  assert.match(s.cls, /more-left/, "left edge cue appears once scrolled");
  await ctx.close();
});

test("keyboard + screen reader: scroll region is focusable and labelled; arrow keys scroll it; header cells are column headers", { skip: !haveChrome && "Chrome not installed" }, async () => {
  const { page, ctx } = await open(DESKTOP);
  const i = await page.evaluate(() => [...document.querySelectorAll(".preview .table-wrap")].findIndex((w) => w.querySelectorAll("th").length === 7));
  await page.evaluate((k) => document.querySelectorAll(".preview .table-scroll")[k].focus(), i);
  const desc = await page.evaluate(() => { const a = document.activeElement; return { label: a.getAttribute("aria-label"), described: document.getElementById(a.getAttribute("aria-describedby"))?.textContent }; });
  assert.equal(desc.label, "Table: Repo, CI, Auto-merge, …");
  assert.match(desc.described, /7 columns/);
  for (let n = 0; n < 6; n++) await page.keyboard.press("ArrowRight");
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(await page.evaluate(() => document.activeElement.scrollLeft) > 0, "arrow keys scroll the focused table");
  const cdp = await page.createCDPSession();
  const { nodes } = await cdp.send("Accessibility.getFullAXTree");
  const roles = new Set(nodes.map((n) => n.role && n.role.value));
  const hdr = nodes.find((n) => n.role?.value === "columnheader" && n.name?.value === "Readiness");
  assert.ok(roles.has("table") && roles.has("cell") && hdr, "exposed as a table with named column headers");
  await ctx.close();
});

test("rows as cards: labelled values, table semantics kept, no overflow; toggling back restores the table", { skip: !haveChrome && "Chrome not installed" }, async () => {
  const { page, ctx } = await open(ANDROID_320);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, "320 px: no page overflow");
  const toggles = await page.$$eval(".preview .table-toggle:not([hidden])", (b) => b.map((x) => x.closest(".table-wrap").querySelectorAll("th").length));
  assert.ok(toggles.length && toggles.every((n) => n >= 3), "card toggle only on comparison tables (3+ columns) that hide columns");
  const i = await page.evaluate(() => [...document.querySelectorAll(".preview .table-wrap")].findIndex((w) => w.querySelectorAll("th").length === 7));
  await page.evaluate((k) => document.querySelectorAll(".preview .table-wrap")[k].querySelector(".table-toggle").click(), i);
  const cards = await page.evaluate((k) => {
    const w = document.querySelectorAll(".preview .table-wrap")[k], td = w.querySelector("tbody td:nth-child(2)");
    return { pressed: w.querySelector(".table-toggle").getAttribute("aria-pressed"), label: getComputedStyle(td, "::before").content, display: getComputedStyle(td).display,
      tableRole: w.querySelector("table").getAttribute("role"), cellRole: td.getAttribute("role"), overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      hint: w.querySelector(".table-hint").hidden, text: w.querySelector("table").textContent.length };
  }, i);
  assert.equal(cards.pressed, "true"); assert.equal(cards.label, '"CI"'); assert.equal(cards.display, "block");
  assert.equal(cards.tableRole, "table"); assert.equal(cards.cellRole, "cell"); assert.equal(cards.overflow, 0); assert.equal(cards.hint, true);
  await page.evaluate((k) => document.querySelectorAll(".preview .table-wrap")[k].querySelector(".table-toggle").click(), i);
  const back = await page.evaluate((k) => { const w = document.querySelectorAll(".preview .table-wrap")[k]; return { cls: w.className, role: w.querySelector("table").getAttribute("role"), display: getComputedStyle(w.querySelector("tbody td")).display, text: w.querySelector("table").textContent.length }; }, i);
  assert.doesNotMatch(back.cls, /as-cards/); assert.equal(back.role, null); assert.equal(back.display, "table-cell"); assert.equal(back.text, cards.text, "same text in both layouts");
  // A header with a line break keeps its words apart in the cards label and the region label.
  const brHead = await page.evaluate(() => { const w = [...document.querySelectorAll(".preview .table-wrap")].find((x) => x.querySelector("th")?.textContent.startsWith("Service"));
    return { region: w.querySelector(".table-scroll").getAttribute("aria-label"), label: w.querySelector("tbody td:nth-child(3)").dataset.label }; });
  assert.equal(brHead.label, "Needed by quarter");
  assert.match(brHead.region, /Needed by quarter/);
  // The choice survives a preview refresh (e.g. after a save elsewhere re-renders the preview).
  await page.evaluate((k) => document.querySelectorAll(".preview .table-wrap")[k].querySelector(".table-toggle").click(), i);
  await page.evaluate(() => [...document.querySelectorAll("main .tabs [role=tab]")].find((b) => b.textContent === "History").click());
  await page.evaluate(() => [...document.querySelectorAll("main .tabs [role=tab]")].find((b) => b.textContent === "Preview").click());
  await page.waitForFunction((k) => document.querySelectorAll(".preview .table-wrap")[k]?.classList.contains("as-cards"), {}, i);
  await ctx.close();
});

test("fidelity: code, links, alignment, long identifiers and URLs are preserved; copying a cell yields the source text", { skip: !haveChrome && "Chrome not installed" }, async () => {
  const { page, ctx } = await open(PIXEL9, "dark");
  const f = await page.evaluate(() => {
    const cells = [...document.querySelectorAll(".preview td")];
    const id = cells.find((c) => c.textContent.includes("svc_7f3c2a9e"));
    const url = cells.find((c) => c.textContent.includes("example.com/docs/a/very/long"));
    const right = document.querySelector(".preview td.al-right"), center = document.querySelector(".preview th.al-center");
    const sel = getSelection(); sel.removeAllRanges(); const r = document.createRange(); r.selectNodeContents(url); sel.addRange(r);
    return { id: id.textContent, idInView: id.getBoundingClientRect().width <= id.closest(".table-scroll").scrollWidth, url: sel.toString(),
      code: [...document.querySelectorAll(".preview td code")].map((c) => c.textContent).filter((t) => t.includes("vitest")), link: document.querySelector('.preview td a[href="https://example.com/x"]')?.textContent,
      rightAlign: getComputedStyle(right).textAlign, centerAlign: getComputedStyle(center).textAlign, pipe: cells.some((c) => c.textContent === "pipe | escaped") };
  });
  assert.equal(f.id, "svc_7f3c2a9e1b4d4f6a8c0e2b5d7f9a1c3e5b7d9f1a", "long identifier intact (soft breaks add no characters)");
  assert.match(f.url, /https:\/\/example\.com\/docs\/a\/very\/long\/path\/that\/should\/wrap\/without\/overflowing\/the\/page/, "selected/copied text equals the source URL");
  assert.deepEqual(f.code, ["npx vitest run --changed origin/main -- src/features/billing/invoice-preview.test.ts"]);
  assert.equal(f.link, "link text"); assert.equal(f.rightAlign, "right"); assert.equal(f.centerAlign, "center"); assert.ok(f.pipe);
  // Multiline cell: rendered as separate lines; selecting/copying the cell gives the lines, never the markup.
  const ml = await page.evaluate(() => {
    const td = [...document.querySelectorAll(".preview td")].find((c) => c.textContent.startsWith("Owner: platform team"));
    const sel = getSelection(); sel.removeAllRanges(); const r = document.createRange(); r.selectNodeContents(td); sel.addRange(r);
    return { brs: td.querySelectorAll("br").length, copied: sel.toString(), lines: Math.round(td.getBoundingClientRect().height / parseFloat(getComputedStyle(td).lineHeight)) };
  });
  assert.equal(ml.brs, 2);
  assert.equal(ml.copied.replace(/\r/g, ""), "Owner: platform team\nReviewer: on-call\nSee runbook.md");
  assert.ok(ml.lines >= 3, "rendered on separate lines");
  await ctx.close();
});

test("desktop 1440: narrow tables fit the reading column without scrolling; wide matrices scroll inside it", { skip: !haveChrome && "Chrome not installed" }, async () => {
  const { page, ctx, errors } = await open(DESKTOP);
  const l = await layout(page);
  assert.equal(l.pageOverflow, 0);
  const backlog = l.tables.find((t) => t.cols === 4);
  assert.equal(backlog.scrolls, false, "4-column backlog fits on desktop"); assert.equal(backlog.hint, false);
  assert.equal(backlog.toggle, false, "no cards option for a table that already fits"); assert.equal(backlog.focusable, false, "no extra tab stop");
  assert.ok(l.tables.every((t) => t.contained));
  assert.deepEqual(errors, []);
  await ctx.close();
});
