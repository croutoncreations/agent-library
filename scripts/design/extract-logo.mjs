// Extract the approved "Fold" mark (leftmost large blue A, sheet column 01) from the owner-supplied concept sheet.
// Crops by pixel analysis (no redrawing), makes the light background transparent with soft edges, trims to the
// mark's bounding box and pads it square. Uses headless Chrome canvas (no image libraries needed).
// Usage: node scripts/design/extract-logo.mjs <sheet.png> <out-dir>
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const puppeteer = require(`${process.env.HOME}/.npm-packages/lib/node_modules/puppeteer`);
const [sheet, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const b64 = readFileSync(sheet).toString("base64");
const browser = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
try {
  const page = await browser.newPage();
  const res = await page.evaluate(async (data) => {
    const img = new Image(); img.src = "data:image/png;base64," + data; await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const x = c.getContext("2d"); x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    // Region: column 01 (left of the first divider ~x=594), above the wordmark (~y<490).
    const R = { x0: 60, y0: 120, x1: 580, y1: 495 };
    const blue = (i) => { const r = d[i], g = d[i + 1], b = d[i + 2]; return b > 150 && b - r > 60 && b - g > 40; };
    let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1, n = 0;
    for (let y = R.y0; y < R.y1; y++) for (let X = R.x0; X < R.x1; X++) { const i = (y * c.width + X) * 4; if (blue(i)) { n++; if (X < minX) minX = X; if (X > maxX) maxX = X; if (y < minY) minY = y; if (y > maxY) maxY = y; } }
    const pad = 4; minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const w = maxX - minX + 1, h = maxY - minY + 1, side = Math.max(w, h);
    // Background colour sampled near the mark (paper tone of the sheet).
    const bi = ((minY + 2) * c.width + (minX + 2)) * 4; const bg = [d[bi], d[bi + 1], d[bi + 2]];
    const o = document.createElement("canvas"); o.width = side; o.height = side;
    const ox = o.getContext("2d"); const od = ox.createImageData(side, side);
    const offX = Math.floor((side - w) / 2), offY = Math.floor((side - h) / 2);
    for (let y = 0; y < h; y++) for (let X = 0; X < w; X++) {
      const i = ((minY + y) * c.width + (minX + X)) * 4, j = ((offY + y) * side + (offX + X)) * 4;
      const r = d[i], g = d[i + 1], b = d[i + 2];
      // Alpha from colour distance to the paper tone; un-premultiply against the background (soft anti-aliased edge).
      const dist = Math.sqrt((r - bg[0]) ** 2 + (g - bg[1]) ** 2 + (b - bg[2]) ** 2);
      const a = Math.max(0, Math.min(1, (dist - 18) / 150));
      if (a <= 0) continue;
      const un = (v, k) => Math.max(0, Math.min(255, Math.round((v - bg[k] * (1 - a)) / a)));
      od.data[j] = un(r, 0); od.data[j + 1] = un(g, 1); od.data[j + 2] = un(b, 2); od.data[j + 3] = Math.round(a * 255);
    }
    ox.putImageData(od, 0, 0);
    const scaled = (s) => { const k = document.createElement("canvas"); k.width = s; k.height = s; const kx = k.getContext("2d"); kx.imageSmoothingQuality = "high"; kx.drawImage(o, 0, 0, s, s); return k.toDataURL("image/png"); };
    return { box: { minX, minY, w, h }, bluePixels: n, bg, full: o.toDataURL("image/png"), s256: scaled(256), s64: scaled(64), s128: scaled(128) };
  }, b64);
  for (const [k, f] of [["full", "fold-mark-full.png"], ["s256", "fold-mark-256.png"], ["s64", "fold-mark-64.png"], ["s128", "fold-mark-128.png"]])
    writeFileSync(join(out, f), Buffer.from(res[k].split(",")[1], "base64"));
  console.log(JSON.stringify({ box: res.box, bluePixels: res.bluePixels, bg: res.bg }));
} finally { await browser.close(); }
