// Mobile-table evidence: renders Markdown documents through the REAL local runtime (loopback, synthetic owner via the
// App Connect harness) and measures the rendered preview at named viewports. Writes PNGs + metrics.json.
// Usage: node scripts/design/tables-capture.mjs --out <dir> [--doc <file.md>]... [--port 49893] [--only pixel9,desktop]
// Documents are created in a throwaway local database; nothing is sent anywhere else.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename } from "node:path";
import { startAppConnectServer } from "../../test/fixtures/app-connect-harness.mjs";

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : d; };
const all = (k) => args.flatMap((a, i) => (a === "--" + k ? [args[i + 1]] : []));
const OUT = arg("out", "tmp/mobile-tables/capture");
const PORT = Number(arg("port", "49893"));
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// Pixel 9: 1080x2424 physical px at 420 dpi -> deviceScaleFactor 2.625 -> 411.4x923.4 CSS px; Chrome reports a 412 CSS px
// layout width. These are CSS viewports (not physical pixels); screenshots are taken at the device scale factor.
export const VIEWPORTS = {
  pixel9: { width: 412, height: 923, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true },
  pixel9dark: { width: 412, height: 923, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, dark: true },
  "android-360": { width: 360, height: 780, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  "android-320": { width: 320, height: 658, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  desktopdark: { width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false, dark: true },
};
const only = (arg("only", "") || Object.keys(VIEWPORTS).join(",")).split(",");
const docs = all("doc");
if (!docs.length) docs.push("test/fixtures/mobile-tables.md");
mkdirSync(OUT, { recursive: true });

const h = await startAppConnectServer({ port: PORT });
const owner = await h.owner();
const browser = await require(`${process.env.HOME}/.npm-packages/lib/node_modules/puppeteer`).launch({ executablePath: CHROME, headless: true, args: ["--no-first-run"] });
const metrics = { origin: "loopback synthetic owner", viewports: VIEWPORTS, docs: [] };
try {
  if ((await owner.req("POST", "/api/projects", { id: "tables-check", title: "Tables check" })).status !== 201) throw Error("project");
  for (const file of docs) {
    const body = readFileSync(file, "utf8");
    const cr = await owner.req("POST", "/api/projects/tables-check/artifacts", { title: basename(file, ".md"), body });
    if (cr.status !== 201) throw Error("create " + cr.status + " " + JSON.stringify(cr.body));
    const id = cr.body.artifact_id, entry = { file: basename(file), bytes: Buffer.byteLength(body), artifact: id, shots: [] };
    metrics.docs.push(entry);
    for (const name of only) {
      const vp = VIEWPORTS[name]; if (!vp) continue;
      const ctx = await browser.createBrowserContext(); const page = await ctx.newPage();
      const errors = []; page.on("pageerror", (e) => errors.push(e.message)); page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: vp.dark ? "dark" : "light" }]);
      await page.setViewport(vp);
      const [cn, cv] = owner.cookie.split("="); await page.setCookie({ name: cn, value: cv, url: h.appUi });
      await page.goto(`${h.appUi}/#/p/tables-check/a/${id}`); await page.waitForSelector(".preview > *", { timeout: 15000 });
      await new Promise((r) => setTimeout(r, 300));
      const m = await page.evaluate(() => {
        const pv = document.querySelector(".preview"), r = (e) => { const b = e.getBoundingClientRect(); return { x: Math.round(b.left), w: Math.round(b.width), h: Math.round(b.height) }; };
        const tables = [...pv.querySelectorAll("table")].map((t) => {
          const wrap = t.closest(".table-scroll") || t;
          const cols = [...(t.tHead?.rows[0]?.cells || t.rows[0]?.cells || [])].map((c) => Math.round(c.getBoundingClientRect().width));
          const td = t.querySelector("td"), cs = td && getComputedStyle(td);
          return { cols: cols.length, colWidths: cols, minCol: Math.min(...cols), maxCol: Math.max(...cols), wrap: r(wrap), tableW: Math.round(t.scrollWidth), scrollable: wrap.scrollWidth > wrap.clientWidth + 1,
            wrapClientW: wrap.clientWidth, fontPx: cs && parseFloat(cs.fontSize), th: t.querySelectorAll("th").length, scopeCol: t.querySelectorAll("th[scope=col]").length };
        });
        const pipeParas = [...pv.querySelectorAll("p")].filter((p) => /\|\s*-{3,}\s*\|/.test(p.textContent) || (p.textContent.match(/\|/g) || []).length >= 6).length;
        return { viewport: { innerWidth, innerHeight, dpr: devicePixelRatio, clientWidth: document.documentElement.clientWidth },
          pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth, preview: r(pv), tables, pipeParagraphs: pipeParas };
      });
      m.name = name; m.errors = errors;
      // Screenshots (CSS viewport x deviceScaleFactor): first table, the widest table (most columns), that table
      // scrolled to its right edge, and the same table as cards.
      const wraps = await page.$$(".preview .table-wrap");
      const widest = await page.evaluate(() => { const w = [...document.querySelectorAll(".preview .table-wrap")]; let b = 0; w.forEach((x, i) => { if (x.querySelectorAll("th").length > w[b].querySelectorAll("th").length) b = i; }); return b; }).catch(() => 0);
      const snap = async (label, el, prep) => {
        if (!el) return;
        await el.evaluate((e) => e.scrollIntoView({ block: "start" })); await page.evaluate(() => window.scrollBy(0, -72));
        if (prep) await prep(el);
        await new Promise((r) => setTimeout(r, 150));
        const png = `${OUT}/${basename(file, ".md")}-${name}-${vp.width}x${vp.height}@${vp.deviceScaleFactor}-${label}.png`;
        await page.screenshot({ path: png }); m[label] = png;
      };
      if (wraps.length) {
        await snap("t1", wraps[0]);
        await snap("wide", wraps[widest]);
        await snap("wide-scrolled", wraps[widest], (el) => el.evaluate((e) => { const s = e.querySelector(".table-scroll"); s.scrollLeft = s.scrollWidth; }));
        m.wideScroll = await wraps[widest].evaluate((e) => { const s = e.querySelector(".table-scroll"); return { scrollLeft: Math.round(s.scrollLeft), max: s.scrollWidth - s.clientWidth, cls: e.className, hint: !e.querySelector(".table-hint").hidden }; });
        await snap("wide-cards", wraps[widest], async (el) => { await el.evaluate((e) => { e.querySelector(".table-scroll").scrollLeft = 0; const b = e.querySelector(".table-toggle"); if (b) b.click(); }); });
        m.cardsOverflowX = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        // First table containing a cell with a line break (multiline cell), if any; cards mode switched off first.
        await wraps[widest].evaluate((e) => { const b = e.querySelector(".table-toggle"); if (b && b.getAttribute("aria-pressed") === "true") b.click(); });
        const ml = await page.$$eval(".preview .table-wrap", (ws) => ws.findIndex((w) => w.querySelector("td br")));
        if (ml >= 0) await snap("multiline", (await page.$$(".preview .table-wrap"))[ml]);
      } else {
        const p0 = await page.evaluateHandle(() => [...document.querySelectorAll(".preview p")].find((p) => (p.textContent.match(/\|/g) || []).length >= 6) || document.querySelector(".preview"));
        await snap("t1", p0.asElement());
      }
      entry.shots.push(m);
      await ctx.close();
    }
  }
} finally { await browser.close(); await h.stop(); }
writeFileSync(`${OUT}/metrics.json`, JSON.stringify(metrics, null, 1));
for (const d of metrics.docs) for (const s of d.shots)
  console.log(d.file, s.name, `${s.viewport.innerWidth}x${s.viewport.innerHeight}@${s.viewport.dpr}`, "overflowX", s.pageOverflowX, "tables", s.tables.length, "pipeParas", s.pipeParagraphs,
    s.tables.map((t) => `${t.cols}c ${t.minCol}-${t.maxCol} ${t.scrollable ? "scroll" : "fit"} ${t.fontPx}px`).join(" | "), s.errors.length ? "ERR " + s.errors.join(";") : "");
