// Build the installed-app (PWA) icons from the approved "Fold" brand mark, the same mark the nav shows.
// Input: the full-resolution transparent mark from extract-logo.mjs (fold-mark-full.png, 358 px; its 128 px
// output is byte-identical to the nav's FOLD_MARK_PNG, sha256 ed862b3e…). The mark is only scaled and centred,
// never redrawn. Uses headless Chrome canvas (no image libraries needed).
//   any-purpose icons: transparent background, mark fills the safe area
//   maskable + Apple touch icon: opaque white tile (launchers/iOS crop or matte these), mark inside the safe zone
// Usage: node scripts/design/make-app-icons.mjs <fold-mark-full.png> <out-dir>
// fold-mark-full.png is not committed: regenerate it with extract-logo.mjs from the approved design export. The
// committed outputs are pinned by hash (icon-fixes-preservation.json), so CI never needs to rerun this script.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const require = createRequire(import.meta.url);
// CHROME_PATH (as in test/design-shell.test.mjs) and PUPPETEER_PATH override the macOS defaults.
const puppeteer = require(process.env.PUPPETEER_PATH ?? `${process.env.HOME}/.npm-packages/lib/node_modules/puppeteer`);
const [mark, out] = process.argv.slice(2);
if (!mark || !out) throw Error("Usage: node scripts/design/make-app-icons.mjs <fold-mark-full.png> <out-dir>");
mkdirSync(out, { recursive: true });
// [file, size, mark size as a fraction of the icon, background or null]
const SPECS = [
  ["app-icon-192.png", 192, 0.86, null],
  ["app-icon-512.png", 512, 0.86, null],
  // Maskable safe zone is the centred circle of 80% diameter; the mark's square box fits inside at ~0.56.
  ["app-maskable-512.png", 512, 0.56, "#ffffff"],
  ["app-apple-180.png", 180, 0.72, "#ffffff"],
];
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
try {
  const page = await browser.newPage();
  const res = await page.evaluate(async (data, specs) => {
    const img = new Image(); img.src = "data:image/png;base64," + data; await img.decode();
    return specs.map(([name, size, frac, bg]) => {
      const c = document.createElement("canvas"); c.width = size; c.height = size;
      const x = c.getContext("2d");
      if (bg) { x.fillStyle = bg; x.fillRect(0, 0, size, size); }
      x.imageSmoothingEnabled = true; x.imageSmoothingQuality = "high";
      const m = Math.round(size * frac), o = Math.round((size - m) / 2);
      x.drawImage(img, o, o, m, m);
      return [name, c.toDataURL("image/png")];
    });
  }, readFileSync(mark).toString("base64"), SPECS);
  for (const [name, url] of res) writeFileSync(join(out, name), Buffer.from(url.split(",")[1], "base64"));
  console.log(res.map(([n]) => n).join("\n"));
} finally { await browser.close(); }
