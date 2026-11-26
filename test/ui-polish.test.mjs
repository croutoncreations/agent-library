// Browser UI polish: device theme (light/dark), quick-copy buttons, save/details below the document,
// inline same-project PNG images with a full-size overlay and download, no redundant "Projects" crumb,
// and the owner-wide Connected apps page (OAuth connections + grants) with revoke. Real Chrome.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { startServer, setupProject, grant, agentHttp, sha256, key, ROOT } from "./helpers.mjs";
import { SERVER_PORTS } from "./ports.mjs";
import { makePng, makePdf } from "./make-fixtures.mjs";
import { execFileSync } from "node:child_process";

const require = createRequire(import.meta.url);
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PUPPETEER = `${process.env.HOME}/.npm-packages/lib/node_modules/puppeteer`;
const haveChrome = existsSync(CHROME) && existsSync(PUPPETEER);
const PORT = SERVER_PORTS.uipolish, ORIGIN = `http://127.0.0.1:${PORT}`;
const PID = "ui-polish", OTHER = "ui-other";
let s, h, browser, page, docId, imgId, otherImg, img2Id, galleryDocId, longDocId, pageId, textOnlyPageId, darkPageId;

async function uploadPng(token, pid, title, bytes) {
  const a = agentHttp(ORIGIN, token);
  const b = await a("POST", `/api/projects/${pid}/uploads`, { title, mime: "image/png", size: bytes.length, sha256: sha256(bytes) });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  assert.equal((await a("PUT", b.body.put_url, undefined, { raw: bytes, headers: { "content-type": "application/octet-stream" } })).status, 200);
  const f = await a("POST", `/api/projects/${pid}/uploads/${b.body.upload_id}/finish`, {});
  assert.equal(f.status, 200, JSON.stringify(f.body));
  return f.body.artifact_id;
}

before(async () => {
  s = await startServer("uipolish", PORT);
  h = await s.login();
  await setupProject(h, PID, "UI Polish");
  await setupProject(h, OTHER, "Other");
  const tok = (await grant(h, PID, "uploader", true)).token;
  imgId = await uploadPng(tok, PID, "Diagram", makePng(64, 48));
  otherImg = await uploadPng((await grant(h, OTHER, "other-up", true)).token, OTHER, "Other image", makePng(16, 16));
  const body = `# Doc\n\nInline: ![A diagram](${imgId})\n\nOther project: ![nope](${otherImg})\n\nExternal: ![ext](https://example.com/x.png)\n\nUnknown: ![u](art_doesnotexist)`;
  docId = (await h.req("POST", `/api/projects/${PID}/artifacts`, { title: "Polish doc", body })).body.artifact_id;
  img2Id = await uploadPng(tok, PID, "Second", makePng(40, 30));
  galleryDocId = (await h.req("POST", `/api/projects/${PID}/artifacts`, { title: "Gallery doc", body: `# G\n\n![First](${imgId})\n\nText between.\n\n![Second](${img2Id})\n` })).body.artifact_id;
  pageId = (await h.req("POST", `/api/projects/${PID}/artifacts`, { title: "Synthetic page", kind: "html", body: "<h1>Synthetic page</h1><p>Plain text.</p>" })).body.artifact_id;
  textOnlyPageId = (await h.req("POST", `/api/projects/${PID}/artifacts`, { title: "Text color page", kind: "html", body: "<style>body{color:#333}</style><h1>Text color page</h1>" })).body.artifact_id;
  darkPageId = (await h.req("POST", `/api/projects/${PID}/artifacts`, { title: "Self-styled page", kind: "html",
    body: "<style>body{background:#fff;color:#111}@media (prefers-color-scheme:dark){body{background:#1d2330;color:#e8ecf3}}</style><h1>Self-styled page</h1>" })).body.artifact_id;
  longDocId = (await h.req("POST", `/api/projects/${PID}/artifacts`, { title: "Long doc", body: "# Long\n\n" + Array.from({ length: 60 }, (_, i) => `## Section ${i + 1}\n\nParagraph ${i + 1} of synthetic filler text for scrolling.`).join("\n\n") })).body.artifact_id;
  if (haveChrome) {
    browser = await require(PUPPETEER).launch({ executablePath: CHROME, headless: true, args: ["--no-first-run"] });
    page = await browser.newPage();
    await page.setViewport({ width: 900, height: 900 });
    await page.goto(ORIGIN + "/");
    await page.waitForSelector('input[name="passphrase"]');
    await page.type('input[name="passphrase"]', s.passphrase());
    await Promise.all([page.waitForFunction(() => document.body.innerText.includes("UI Polish")), page.click('button[type="submit"]')]);
  }
});
after(async () => { await browser?.close(); await s?.stop(); });

test("preview API: same-project PNG renders as <img>; other-project, external and unknown refs stay text", async () => {
  const r = await h.req("GET", `/api/projects/${PID}/artifacts/${docId}/preview`);
  const html = r.body.html;
  assert.match(html, new RegExp(`<img src="/api/projects/${PID}/artifacts/${imgId}/content" alt="A diagram"`));
  assert.equal((html.match(/<img /g) ?? []).length, 1, "only the same-project image is an <img>");
  assert.match(html, /\[image: nope\]/); assert.match(html, /\[image: ext\]/); assert.match(html, /\[image: u\]/);
  assert.doesNotMatch(html, /example\.com|ui-other/);
  // alt text injection stays escaped
  const evil = (await h.req("POST", `/api/projects/${PID}/artifacts`, { title: "evil", body: `![" onerror="alert(1)](${imgId})` })).body.artifact_id;
  const e = (await h.req("GET", `/api/projects/${PID}/artifacts/${evil}/preview`)).body.html;
  assert.doesNotMatch(e, /onerror="alert/);
  assert.match(e, /alt="&quot; onerror=&quot;alert\(1\)"/);
});

test("content route: ?download=1 forces attachment with an extension; default PNG stays inline; auth still required", async () => {
  const inline = await h.req("GET", `/api/projects/${PID}/artifacts/${imgId}/content`, undefined, { binary: true });
  assert.match(inline.headers.get("content-disposition"), /^inline; filename="Diagram\.png"/);
  const dl = await h.req("GET", `/api/projects/${PID}/artifacts/${imgId}/content?download=1`, undefined, { binary: true });
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get("content-disposition"), /^attachment; filename="Diagram\.png"/);
  assert.equal((await fetch(`${ORIGIN}/api/projects/${PID}/artifacts/${imgId}/content?download=1`)).status, 401);
});

test("owner access API lists OAuth connections and grants across projects; human-only", async () => {
  const r = await h.req("GET", "/api/access");
  assert.equal(r.status, 200);
  assert.ok(r.body.grants.some((g) => g.label === "uploader" && g.project_id === PID && g.status === "active"));
  assert.ok(r.body.grants.some((g) => g.label === "other-up" && g.project_id === OTHER));
  assert.ok(Array.isArray(r.body.connections));
  assert.doesNotMatch(JSON.stringify(r.body), /alt_|token_hash/);
  const tok = (await grant(h, PID, "agent-reader", false)).token;
  assert.equal((await agentHttp(ORIGIN, tok)("GET", "/api/access")).status, 403, "agents cannot list access");
  assert.equal((await agentHttp(ORIGIN, tok)("POST", "/api/connections/oac_xxxxxxxxxxxx/revoke", {})).status, 403);
  assert.equal((await h.req("POST", "/api/connections/oac_doesnotexist0/revoke", {})).status, 404);
});

test("browser: follows the device theme (light and dark)", { skip: !haveChrome && "Chrome not installed" }, async () => {
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  await page.goto(`${ORIGIN}/#/p/${PID}/a/${docId}/edit`); await page.waitForSelector(".cm-doc-editor .cm-content");
  const light = await bg();
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
  const dark = await bg();
  assert.equal(light, "rgb(246, 246, 248)");
  assert.equal(dark, "rgb(10, 10, 13)");
  const fieldDark = await page.evaluate(() => getComputedStyle(document.querySelector(".cm-doc-editor")).backgroundColor);
  assert.notEqual(fieldDark, "rgb(255, 255, 255)", "editor is not white in dark mode");
  await page.screenshot({ path: "tmp/test-evidence/ui-dark-editor.png" });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  await page.screenshot({ path: "tmp/test-evidence/ui-light-editor.png" });
});

test("browser: copy link/title/contents; save + details below the document; no 'Projects' crumb", { skip: !haveChrome && "Chrome not installed" }, async () => {
  const ctx = browser.defaultBrowserContext();
  await ctx.overridePermissions(ORIGIN, ["clipboard-read", "clipboard-write", "clipboard-sanitized-write"]);
  await page.goto(`${ORIGIN}/#/p/${PID}/a/${docId}/edit`); await page.waitForSelector(".cm-doc-editor .cm-content");
  const clip = async (label) => {
    await page.evaluate((l) => document.querySelector(`.titlebar button[aria-label="${l}"]`).click(), label);
    await page.waitForFunction((l) => document.querySelector(".toast") && !document.querySelector(".toast").hidden && document.querySelector(".toast").textContent.toLowerCase().startsWith(l.replace("Copy ", "")), { timeout: 5000 }, label);
    return page.evaluate(() => navigator.clipboard.readText());
  };
  const path = await page.evaluate(async () => (await (await fetch("/api/projects")).json()).projects.find((p) => p.id === "ui-polish").path);
  assert.equal(await clip("Copy link"), `${ORIGIN}/${path}/a/${docId}`);
  assert.equal(await clip("Copy title"), "Polish doc");
  assert.match(await clip("Copy contents"), /^# Doc\n\nInline: !\[A diagram\]/);
  // Layout: editor panel comes before the Save button and the Details card
  const order = await page.evaluate(() => {
    const pos = (el) => el.getBoundingClientRect().top + window.scrollY;
    const save = [...document.querySelectorAll("button")].find((b) => b.textContent === "Save now");
    return { editor: pos(document.querySelector(".cm-doc-editor")), save: pos(save), details: pos(document.querySelector("details")) };
  });
  assert.ok(order.editor < order.save && order.save < order.details, JSON.stringify(order));
  // copy controls are compact icon buttons (no visible text), labelled for screen readers
  const icons = await page.evaluate(() => [...document.querySelectorAll(".titlebar .icons button")].map((b) => [b.getAttribute("aria-label"), b.innerText.trim(), Math.round(b.getBoundingClientRect().width)]));
  // Upstream cf8af9e added favorite + offline controls to the title bar.
  assert.deepEqual(icons.map((i) => i[0]), ["Copy link", "Copy title", "Copy contents", "Add to favorites", "Make available offline"]);
  assert.ok(icons.every((i) => (/^Add to favorites/.test(i[0]) ? i[1] === "☆" : i[1] === "") && i[2] <= 44), JSON.stringify(icons));
  const crumbs = await page.evaluate(() => document.getElementById("crumbs").innerText);
  assert.doesNotMatch(crumbs, /Projects/);
  assert.match(crumbs, /UI Polish/);
});

test("browser: inline image in preview opens a full-size overlay with download; Escape closes", { skip: !haveChrome && "Chrome not installed" }, async () => {
  await page.goto(`${ORIGIN}/#/p/${PID}/a/${docId}`);
  await page.waitForSelector(".preview img[data-artifact]");
  const loaded = await page.waitForFunction(() => { const i = document.querySelector(".preview img[data-artifact]"); return i.complete && i.naturalWidth === 64; }, { timeout: 5000 }).then(() => true, () => false);
  assert.ok(loaded, "inline image loaded (64px wide)");
  await page.click(".preview img[data-artifact]");
  await page.waitForSelector(".lightbox img");
  const dl = await page.evaluate(() => [...document.querySelectorAll(".lightbox a")].map((a) => [a.getAttribute("aria-label"), a.getAttribute("href")]));
  assert.ok(dl.some(([t, href]) => t === "Download" && /\/content\?download=1$/.test(href)), JSON.stringify(dl));
  await page.screenshot({ path: "tmp/test-evidence/ui-lightbox.png" });
  await page.keyboard.press("Escape");
  assert.equal(await page.$(".lightbox"), null);
  // Binary PNG view: View full size + Download
  await page.goto(`${ORIGIN}/#/p/${PID}/a/${imgId}`); await page.waitForSelector(".media img");
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "View full size").click());
  await page.waitForSelector(".lightbox img");
  await page.click('.lightbox .bar button[aria-label="Close"]');
  assert.equal(await page.$(".lightbox"), null);
});

test("browser: rendered HTML pages stay readable in dark mode", { skip: !haveChrome && "Chrome not installed" }, async () => {
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
  // Text color and the effective background behind it (the frame is a white canvas unless the page paints its own).
  const colors = async () => {
    const frame = await (await page.waitForSelector("iframe.htmlview")).contentFrame();
    await frame.waitForFunction(() => document.querySelector("h1"));
    const inner = await frame.evaluate(() => ({ text: getComputedStyle(document.querySelector("h1")).color, body: getComputedStyle(document.body).backgroundColor, root: getComputedStyle(document.documentElement).backgroundColor }));
    const canvas = await page.$eval("iframe.htmlview", (f) => getComputedStyle(f).backgroundColor);
    const clear = "rgba(0, 0, 0, 0)";
    return { text: inner.text, bg: inner.body !== clear ? inner.body : inner.root !== clear ? inner.root : canvas };
  };
  const lum = (rgb) => { const [r, g, b] = rgb.match(/\d+/g).map(Number); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
  try {
    // A page with no colors of its own, and one that only sets a dark text color: dark text on the white canvas.
    for (const id of [pageId, textOnlyPageId]) {
      await page.goto(`${ORIGIN}/#/p/${PID}/a/${id}`);
      const c = await colors();
      assert.equal(c.bg, "rgb(255, 255, 255)", JSON.stringify(c)); assert.ok(lum(c.text) < 0.3, "page text is dark: " + JSON.stringify(c));
      if (id === pageId) await page.screenshot({ path: "tmp/test-evidence/ui-html-page-dark.png" });
    }
    // A page that styles itself for dark mode still does.
    await page.goto(`${ORIGIN}/#/p/${PID}/a/${darkPageId}`);
    assert.deepEqual(await colors(), { text: "rgb(232, 236, 243)", bg: "rgb(29, 35, 48)" });
  } finally {
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  }
});

test("browser: document media open as a gallery with Previous/Next, arrow keys and a position counter", { skip: !haveChrome && "Chrome not installed" }, async () => {
  await page.goto(`${ORIGIN}/#/p/${PID}/a/${galleryDocId}`);
  await page.waitForFunction(() => document.querySelectorAll(".preview img[data-artifact]").length === 2);
  const state = () => page.evaluate(() => ({ cap: document.querySelector(".lightbox .cap").textContent, count: document.querySelector(".lightbox .count").textContent, src: document.querySelector(".lightbox .stage img").getAttribute("src") }));
  // Opening the second image starts the gallery there.
  await page.evaluate(() => document.querySelectorAll(".preview img[data-artifact]")[1].click());
  await page.waitForSelector(".lightbox .stage img");
  let st = await state();
  assert.equal(st.count, "2 / 2"); assert.match(st.cap, /^Second/); assert.match(st.src, new RegExp(img2Id));
  await page.click('.lightbox button[aria-label="Next"]'); // wraps to the first
  st = await state(); assert.equal(st.count, "1 / 2"); assert.match(st.cap, /^First/);
  assert.match(await page.evaluate(() => document.querySelector('.lightbox a[aria-label="Download"]').getAttribute("href")), new RegExp(`${imgId}/content\\?download=1$`));
  await page.keyboard.press("ArrowRight");
  st = await state(); assert.equal(st.count, "2 / 2");
  // The page behind the dialog is inert (Tab stays in the gallery); the position is announced with the item name.
  assert.equal(await page.evaluate(() => !!document.querySelector("#app, main")?.closest("[inert]")), true);
  assert.match(await page.evaluate(() => document.querySelector(".lightbox .sr[aria-live]").textContent), /^Second, 2 of 2$/);
  await page.click('.lightbox button[aria-label="Previous"]');
  st = await state(); assert.equal(st.count, "1 / 2");
  await page.screenshot({ path: "tmp/test-evidence/ui-gallery.png" });
  await page.keyboard.press("Escape");
  assert.equal(await page.$(".lightbox"), null);
  // A single image has no gallery controls.
  await page.goto(`${ORIGIN}/#/p/${PID}/a/${docId}`);
  await page.waitForSelector(".preview img[data-artifact]");
  await page.click(".preview img[data-artifact]");
  await page.waitForSelector(".lightbox img");
  assert.equal(await page.$(".lightbox .gnav"), null);
  await page.keyboard.press("Escape");
});

test("browser: Preview has a full-screen mode that covers the app chrome; Escape and Exit leave it", { skip: !haveChrome && "Chrome not installed" }, async () => {
  for (const vp of [{ width: 900, height: 900 }, { width: 390, height: 800, isMobile: true, hasTouch: true }]) {
    await page.setViewport(vp);
    await page.goto(`${ORIGIN}/#/p/${PID}/a/${galleryDocId}`);
    await page.waitForSelector(".preview img[data-artifact]");
    await page.click('button[aria-label="Full screen"]');
    await page.waitForSelector("section.fs-on .fs-bar");
    const cover = await page.evaluate(() => {
      const r = document.querySelector("section.fs-on").getBoundingClientRect();
      // The element at the very top and bottom of the viewport belongs to the full-screen panel, not the app header/tab bar.
      const topEl = document.elementFromPoint(innerWidth / 2, 4), botEl = document.elementFromPoint(innerWidth / 2, innerHeight - 4);
      const sec = document.querySelector("section.fs-on");
      // Hidden app chrome (header, nav, tabs) is inert, so Tab cannot reach controls behind the panel.
      const chromeInert = [".top", ".side", "[role=tablist]"].every((s) => { const el = document.querySelector(s); return !el || el.closest("[inert]"); });
      return { x: r.x, y: r.y, w: Math.round(r.width) === innerWidth, h: Math.round(r.height) === innerHeight, top: sec.contains(topEl), bottom: sec.contains(botEl), title: sec.querySelector(".fs-title").textContent, focusInPanel: document.activeElement === sec, chromeInert };
    });
    assert.deepEqual(cover, { x: 0, y: 0, w: true, h: true, top: true, bottom: true, title: "Gallery doc", focusInPanel: true, chromeInert: true }, JSON.stringify(vp));
    // Tab and Shift+Tab never reach the covered app chrome.
    for (let k = 0; k < 6; k++) await page.keyboard.press("Tab");
    assert.ok(await page.evaluate(() => document.querySelector("section.fs-on").contains(document.activeElement)), "Tab stays in full screen");
    await page.keyboard.down("Shift"); for (let k = 0; k < 8; k++) await page.keyboard.press("Tab"); await page.keyboard.up("Shift");
    assert.ok(await page.evaluate(() => document.querySelector("section.fs-on").contains(document.activeElement) || document.activeElement === document.body), "Shift+Tab stays in full screen");
    // The gallery still opens on top of full screen; Escape closes only the gallery first.
    await page.click("section.fs-on .preview img[data-artifact]");
    await page.waitForSelector(".lightbox");
    await page.keyboard.press("Escape");
    assert.equal(await page.$(".lightbox"), null);
    assert.ok(await page.$("section.fs-on"));
    await page.screenshot({ path: `tmp/test-evidence/ui-fullscreen-${vp.width}.png` });
    if (vp.isMobile) await page.click(".fs-bar button");
    else await page.keyboard.press("Escape");
    assert.equal(await page.$("section.fs-on"), null);
    assert.equal(await page.evaluate(() => document.body.classList.contains("reading")), false);
    assert.equal(await page.evaluate(() => document.querySelectorAll("[inert]").length), 0, "inert is fully undone");
    // Not offered on the Edit tab.
    await page.evaluate(() => [...document.querySelectorAll("[role=tab]")].find((b) => b.textContent === "Edit").click());
    assert.equal(await page.evaluate(() => document.querySelector('button[aria-label="Full screen"]').hidden), true);
  }
  await page.setViewport({ width: 900, height: 900 });
});

test("browser: Escape typed inside a rendered HTML page leaves full screen", { skip: !haveChrome && "Chrome not installed" }, async () => {
  await page.setViewport({ width: 900, height: 900 });
  await page.goto(`${ORIGIN}/#/p/${PID}/a/${pageId}`);
  await page.waitForSelector("iframe.htmlview");
  const frame = await (await page.$("iframe.htmlview")).contentFrame();
  await frame.waitForFunction(() => document.body?.innerText.includes("Plain text"));
  await page.click('button[aria-label="Full screen"]');
  await page.waitForSelector("section.fs-on iframe.htmlview");
  // Focus moves into the frame's document (as a click in the page would); its keys don't reach the app document.
  await page.click("section.fs-on iframe.htmlview");
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), "IFRAME");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("section.fs-on"), { timeout: 3000 });
  // The frame stays scriptless and sandboxed exactly as before.
  assert.equal(await page.$eval("iframe.htmlview", (f) => f.getAttribute("sandbox")), "allow-same-origin allow-popups allow-popups-to-escape-sandbox");
});

test("browser: entering and leaving full screen keeps the reading position", { skip: !haveChrome && "Chrome not installed" }, async () => {
  await page.setViewport({ width: 900, height: 900 });
  await page.goto(`${ORIGIN}/#/p/${PID}/a/${longDocId}`);
  await page.waitForFunction(() => document.querySelectorAll(".preview h2").length === 60);
  // The first heading visible below the sticky header (the fixed full-screen bar when it is shown).
  const topHeading = () => page.evaluate(() => {
    const bar = document.querySelector(".fs-bar") || document.querySelector(".top"), line = bar.getBoundingClientRect().bottom;
    return [...document.querySelectorAll(".preview h2")].find((e) => e.getBoundingClientRect().bottom > line)?.textContent;
  });
  await page.evaluate(() => [...document.querySelectorAll(".preview h2")][29].scrollIntoView({ block: "start" }));
  await page.evaluate(() => window.scrollBy(0, -80)); // clear of the sticky header
  const before = await topHeading();
  assert.match(before, /^Section (29|30)$/);
  await page.evaluate(() => document.querySelector('button[aria-label="Full screen"]').click());
  await page.waitForSelector("section.fs-on");
  assert.equal(await topHeading(), before, "same place in full screen");
  await page.evaluate(() => { document.querySelector("section.fs-on").scrollTop += 600; });
  const moved = await topHeading();
  assert.notEqual(moved, before);
  await page.keyboard.press("Escape");
  assert.equal(await page.$("section.fs-on"), null);
  assert.equal(await topHeading(), moved, "same place after leaving full screen");
});

test("browser: account menu -> Connected apps and Agent tokens (advanced); revoke a token", { skip: !haveChrome && "Chrome not installed" }, async () => {
  await page.goto(`${ORIGIN}/#/`); await page.waitForFunction(() => document.body.innerText.includes("UI Polish"));
  // Home content carries no settings links; they live in the account menu (labelled with the signed-in account)
  assert.match(await page.evaluate(() => document.querySelector("button.acct").getAttribute("aria-label")), /^Account: /);
  assert.equal(await page.evaluate(() => [...document.querySelectorAll("main a, main button")].some((e) => /Connected apps|Grants/.test(e.textContent))), false);
  await page.click('button[aria-haspopup="menu"].acct');
  await page.waitForSelector(".menu:not([hidden])");
  assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), "Connected apps", "focus moves into the menu");
  await page.screenshot({ path: "tmp/test-evidence/ui-settings-menu.png" });
  await page.keyboard.press("Escape");
  assert.equal(await page.$(".menu:not([hidden])"), null);
  await page.click('button[aria-haspopup="menu"].acct');
  await Promise.all([page.waitForFunction(() => location.hash === "#/settings/tokens"), page.evaluate(() => [...document.querySelectorAll(".menu a")].find((a) => a.textContent.includes("Agent tokens")).click())]);
  await page.waitForFunction(() => document.body.innerText.includes("agent-reader"));
  await page.screenshot({ path: "tmp/test-evidence/ui-tokens.png", fullPage: true });
  page.once("dialog", (d) => d.accept());
  await page.evaluate(() => {
    const li = [...document.querySelectorAll(".list li")].find((l) => l.innerText.includes("agent-reader"));
    li.querySelector("button.danger").click();
  });
  await page.waitForFunction(() => document.querySelector(".toast") && document.querySelector(".toast").textContent.includes("Revoked agent-reader"));
  const r = await h.req("GET", "/api/access");
  assert.equal(r.body.grants.find((g) => g.label === "agent-reader").status, "revoked");
});

test("PDF: ?open=1 serves inline (raw file for the browser viewer) with the sandbox CSP; default stays attachment", async () => {
  const tok = (await grant(h, PID, "pdf-up", true)).token;
  const a = agentHttp(ORIGIN, tok);
  const bytes = makePdf();
  const b = await a("POST", `/api/projects/${PID}/uploads`, { title: "Report", mime: "application/pdf", size: bytes.length, sha256: sha256(bytes) });
  await a("PUT", b.body.put_url, undefined, { raw: bytes, headers: { "content-type": "application/octet-stream" } });
  const pdfId = (await a("POST", `/api/projects/${PID}/uploads/${b.body.upload_id}/finish`, {})).body.artifact_id;
  const def = await h.req("GET", `/api/projects/${PID}/artifacts/${pdfId}/content`, undefined, { binary: true });
  assert.match(def.headers.get("content-disposition"), /^attachment; filename="Report\.pdf"/);
  const open = await h.req("GET", `/api/projects/${PID}/artifacts/${pdfId}/content?open=1`, undefined, { binary: true });
  assert.equal(open.status, 200);
  assert.match(open.headers.get("content-disposition"), /^inline; filename="Report\.pdf"/);
  assert.equal(open.headers.get("content-type"), "application/pdf");
  assert.match(open.headers.get("content-security-policy"), /sandbox/);
  assert.match(open.headers.get("content-security-policy"), /default-src 'none'/);
  assert.equal(open.headers.get("x-content-type-options"), "nosniff");
  assert.equal(Buffer.compare(open.body, bytes), 0);
  assert.equal((await fetch(`${ORIGIN}/api/projects/${PID}/artifacts/${pdfId}/content?open=1`)).status, 401, "still requires auth");
  // ?open=1 on a non-PDF binary changes nothing special; on PNG it is just inline as before
  const png = await h.req("GET", `/api/projects/${PID}/artifacts/${imgId}/content?open=1`, undefined, { binary: true });
  assert.match(png.headers.get("content-disposition"), /^inline;/);
  if (!haveChrome) return;
  // UI: PDF card has Open (new tab, ?open=1) and Download; nothing is embedded in the app page
  await page.goto(`${ORIGIN}/#/p/${PID}/a/${pdfId}`); await page.waitForSelector(".filecard");
  const links = await page.evaluate(() => [...document.querySelectorAll(".filecard a")].map((x) => [x.textContent.trim(), x.getAttribute("href"), x.getAttribute("target")]));
  assert.deepEqual(links.map((l) => l[0]), ["Open", "Download"]);
  assert.match(links[0][1], /\/content\?(rev=\d+&)?open=1$/); assert.equal(links[0][2], "_blank");
  assert.match(links[1][1], /\/content\?(rev=\d+&)?download=1$/);
  assert.equal(await page.$("main iframe, main embed, main object"), null, "PDF never embedded in the app page");
  await page.screenshot({ path: "tmp/test-evidence/ui-pdf-card.png" });
  // The browser renders the raw file in its own viewer (top-level tab)
  const tab = await browser.newPage();
  await tab.goto(`${ORIGIN}/api/projects/${PID}/artifacts/${pdfId}/content?open=1`);
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(tab.url().endsWith("open=1"));
  await tab.close();
});

test("browser: dark and light screenshots of the main pages (visual evidence)", { skip: !haveChrome && "Chrome not installed" }, async () => {
  for (const scheme of ["dark", "light"]) {
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
    for (const [name, hash, wait] of [["projects", "#/", "UI Polish"], ["project", `#/p/${PID}`, "Polish doc"], ["doc", `#/p/${PID}/a/${docId}`, "Details"], ["apps", "#/settings/apps", "Reader apps"]]) {
      await page.goto(`${ORIGIN}/${hash}`); await page.waitForFunction((w) => document.body.innerText.includes(w), {}, wait);
      await page.screenshot({ path: `tmp/test-evidence/ui-${name}-${scheme}.png` });
    }
  }
  await page.setViewport({ width: 390, height: 844 });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
  await page.goto(`${ORIGIN}/#/p/${PID}/a/${docId}`); await page.waitForSelector(".preview");
  await page.screenshot({ path: "tmp/test-evidence/ui-doc-mobile-dark.png" });
  await page.setViewport({ width: 900, height: 900 });
});

test("browser: Save now is the accent (primary) button only while there are unsaved changes", { skip: !haveChrome && "Chrome not installed" }, async () => {
  await page.goto(`${ORIGIN}/#/p/${PID}/a/${docId}/edit`); await page.waitForSelector(".cm-doc-editor .cm-content");
  const isPrimary = () => page.evaluate(() => !document.querySelector(".footbar button").classList.contains("secondary"));
  assert.equal(await isPrimary(), false, "clean: secondary");
  await page.click(".cm-content"); await page.keyboard.type(" x");
  assert.equal(await isPrimary(), true, "dirty: primary (accent)");
  await page.screenshot({ path: "tmp/test-evidence/ui-save-dirty.png" });
  await page.waitForFunction(() => document.querySelector(".status").dataset.state === "saved", { timeout: 8000 });
  assert.equal(await isPrimary(), false, "saved again: secondary");
});
