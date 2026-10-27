// Generates small synthetic fixtures into tmp/fixtures: PNG (zlib-built), minimal PDF, MP4 (ffmpeg lavfi testsrc).
import { mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { deflateSync, crc32 } from "node:zlib";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const FIXTURE_DIR = join(ROOT, "tmp", "fixtures");
const MAX = 5 * 1024 * 1024;

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

export function makePng(w = 32, h = 32) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGB
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 3);
    raw[row] = 0;
    for (let x = 0; x < w; x++) { const o = row + 1 + x * 3; raw[o] = x * 8; raw[o + 1] = y * 8; raw[o + 2] = 128; }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

export function makePdf() {
  const stream = "BT /F1 18 Tf 20 100 Td (Synthetic fixture) Tj ET";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

export function makeFixtures() {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const png = join(FIXTURE_DIR, "fixture.png");
  const pdf = join(FIXTURE_DIR, "fixture.pdf");
  const mp4 = join(FIXTURE_DIR, "fixture.mp4");
  writeFileSync(png, makePng());
  writeFileSync(pdf, makePdf());
  if (!existsSync(mp4)) {
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=160x120:rate=10",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4], { stdio: "inherit" });
  }
  for (const f of [png, pdf, mp4]) if (statSync(f).size > MAX) throw new Error(`${f} exceeds 5 MiB`);
  return { png, pdf, mp4 };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const f = makeFixtures();
  for (const [k, p] of Object.entries(f)) console.log(k, p, statSync(p).size, "bytes");
}
