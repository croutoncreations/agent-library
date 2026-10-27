// Synthetic media for the demo library, rendered from SVG with sharp (stills) and ffmpeg (video). No external assets.
import sharp from "sharp";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const FONT = `-apple-system, 'SF Pro Display', 'Helvetica Neue', Helvetica, Arial, sans-serif`;
const png = (svg) => sharp(Buffer.from(svg)).png().toBuffer();

export async function signupsChart() {
  const W = 1600, H = 820, pad = { l: 120, r: 60, t: 150, b: 110 };
  const data = [["Sep 14", 420], ["Sep 21", 510], ["Sep 28", 640], ["Oct 5", 780], ["Oct 12", 1190], ["Oct 19", 1430]];
  const max = 1600, cw = W - pad.l - pad.r, ch = H - pad.t - pad.b, bw = cw / data.length;
  const y = (v) => pad.t + ch - (v / max) * ch;
  const grid = [0, 400, 800, 1200, 1600].map((v) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="#e2e8f0" stroke-width="2"/>
    <text x="${pad.l - 20}" y="${y(v) + 9}" text-anchor="end" font-size="26" fill="#64748b">${v.toLocaleString("en-US")}</text>`).join("");
  const bars = data.map(([l, v], i) => {
    const x = pad.l + i * bw + bw * 0.18, w = bw * 0.64;
    return `<rect x="${x}" y="${y(v)}" width="${w}" height="${pad.t + ch - y(v)}" rx="14" fill="url(#g)"/>
      <text x="${x + w / 2}" y="${y(v) - 18}" text-anchor="middle" font-size="28" font-weight="700" fill="#0c4a6e">${v.toLocaleString("en-US")}</text>
      <text x="${x + w / 2}" y="${H - pad.b + 48}" text-anchor="middle" font-size="26" fill="#64748b">${l}</text>`;
  }).join("");
  return png(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="${FONT}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0ea5e9"/><stop offset="1" stop-color="#6366f1"/></linearGradient></defs>
    <rect width="${W}" height="${H}" rx="28" fill="#fff"/>
    <text x="${pad.l - 60}" y="72" font-size="40" font-weight="800" fill="#0f172a">Weekly beta sign-ups</text>
    <text x="${pad.l - 60}" y="112" font-size="26" fill="#64748b">Tidepool beta · synthetic demo data</text>
    <text x="${W - pad.r}" y="72" text-anchor="end" font-size="40" font-weight="800" fill="#16a34a">+240%</text>
    <text x="${W - pad.r}" y="112" text-anchor="end" font-size="26" fill="#64748b">in six weeks</text>${grid}${bars}</svg>`);
}

// A phone screen of the (fictional) Tidepool app. step: 0 = home, 1..3 = onboarding steps.
function phoneScreen(step = 0, w = 390, h = 844) {
  // Colored dots instead of emoji (librsvg draws emoji as monochrome silhouettes).
  const habits = [["Drink water", 6, "#0ea5e9"], ["Read 10 pages", 12, "#6366f1"], ["Stretch", 3, "#a855f7"], ["Walk 20 min", 9, "#22c55e"]];
  const dot = (x, y, c) => `<circle cx="${x}" cy="${y}" r="9" fill="${c}"/>`;
  if (step > 0) {
    const titles = ["Pick a habit", "When?", "Add the widget"];
    const opts = step === 2 ? [["Morning", "#f59e0b"], ["Lunch", "#0ea5e9"], ["Evening", "#6366f1"], ["Before bed", "#a855f7"]] : habits.map(([n, , c]) => [n, c]);
    const sel = step === 1 ? 0 : step === 2 ? 2 : 3;
    return `<rect width="${w}" height="${h}" fill="#f8fafc"/>
      <rect x="24" y="70" width="${w - 48}" height="6" rx="3" fill="#e2e8f0"/><rect x="24" y="70" width="${((w - 48) * step) / 3}" height="6" rx="3" fill="#6366f1"/>
      <text x="24" y="140" font-size="30" font-weight="800" fill="#0f172a">${titles[step - 1]}</text>
      ${opts.map(([n, c], i) => `<rect x="24" y="${190 + i * 92}" width="${w - 48}" height="76" rx="18" fill="${i === sel ? "#eef2ff" : "#fff"}" stroke="${i === sel ? "#6366f1" : "#e2e8f0"}" stroke-width="2"/>
        ${dot(56, 228 + i * 92, c)}<text x="78" y="${236 + i * 92}" font-size="22" fill="#0f172a">${n}</text>`).join("")}
      <rect x="24" y="${h - 110}" width="${w - 48}" height="60" rx="16" fill="#6366f1"/><text x="${w / 2}" y="${h - 72}" text-anchor="middle" font-size="20" font-weight="700" fill="#fff">Continue</text>`;
  }
  return `<rect width="${w}" height="${h}" fill="#f8fafc"/>
    <text x="24" y="110" font-size="34" font-weight="800" fill="#0f172a">Today</text><text x="24" y="142" font-size="17" fill="#64748b">Tuesday · 3 of 4 done</text>
    ${habits.map(([n, s, c], i) => `<rect x="24" y="${176 + i * 104}" width="${w - 48}" height="88" rx="20" fill="#fff" stroke="#e2e8f0" stroke-width="2"/>
      ${dot(56, 220 + i * 104, c)}<text x="78" y="${228 + i * 104}" font-size="23" fill="#0f172a">${n}</text>
      <text x="${w - 92}" y="${228 + i * 104}" text-anchor="end" font-size="17" fill="#64748b">${s} days</text>
      <circle cx="${w - 60}" cy="${220 + i * 104}" r="17" fill="${i < 3 ? c : "#fff"}" stroke="${c}" stroke-width="3"/>
      ${i < 3 ? `<path d="M${w - 68} ${220 + i * 104} l6 6 l11 -12" stroke="#fff" stroke-width="3.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>` : ""}`).join("")}
    <rect x="24" y="${h - 130}" width="${w - 48}" height="80" rx="20" fill="url(#hg)"/><text x="48" y="${h - 82}" font-size="20" font-weight="700" fill="#fff">9-day streak. Keep it going!</text>`;
}
const phone = (inner, x, y, s = 1) => `<g transform="translate(${x} ${y}) scale(${s})"><rect x="-14" y="-14" width="418" height="872" rx="58" fill="#0f172a"/>
  <svg width="390" height="844" viewBox="0 0 390 844"><defs><clipPath id="c${x}"><rect width="390" height="844" rx="46"/></clipPath></defs><g clip-path="url(#c${x})">${inner}</g></svg></g>`;
const DEFS = `<defs><linearGradient id="hg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0ea5e9"/><stop offset="1" stop-color="#a855f7"/></linearGradient>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e0f2fe"/><stop offset="1" stop-color="#ede9fe"/></linearGradient></defs>`;

export async function heroArt() {
  return png(`<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="1000" font-family="${FONT}">${DEFS}<rect width="1800" height="1000" fill="url(#bg)"/>
    ${phone(phoneScreen(1), 290, 130, 0.9)}${phone(phoneScreen(3), 1145, 130, 0.9)}${phone(phoneScreen(0), 690, 70, 1.02)}</svg>`);
}

export async function appScreenshot(step = 0) {
  // A device-sized PNG like an agent's simulator screenshot.
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="390" height="844" font-family="${FONT}">${DEFS}${phoneScreen(step)}</svg>`)).resize(780, 1688).png().toBuffer();
}

export async function lisbonPhoto() {
  const W = 1600, H = 1000;
  const roofs = Array.from({ length: 14 }, (_, i) => {
    const x = i * 120 - 20, h = 260 + ((i * 97) % 180), c = ["#f97316", "#fb923c", "#ea580c", "#fdba74"][i % 4];
    return `<rect x="${x}" y="${H - h}" width="130" height="${h}" fill="${c}"/><polygon points="${x - 10},${H - h} ${x + 65},${H - h - 60} ${x + 140},${H - h}" fill="#9a3412"/>
      <rect x="${x + 30}" y="${H - h + 50}" width="26" height="36" fill="#fef3c7"/><rect x="${x + 76}" y="${H - h + 50}" width="26" height="36" fill="#fef3c7"/>`;
  }).join("");
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1e3a8a"/><stop offset="0.55" stop-color="#f472b6"/><stop offset="1" stop-color="#fde68a"/></linearGradient></defs>
    <rect width="${W}" height="${H}" fill="url(#sky)"/><circle cx="1150" cy="520" r="130" fill="#fef08a" opacity="0.9"/>
    <rect y="600" width="${W}" height="120" fill="#38bdf8" opacity="0.5"/>${roofs}</svg>`)).jpeg({ quality: 88 }).toBuffer();
}

// A short MP4 "QA run": the onboarding steps with a tap indicator, encoded with ffmpeg (H.264, faststart, < 5 MiB).
export async function qaRunVideo() {
  const dir = mkdtempSync(join(tmpdir(), "qa-video-"));
  try {
    const W = 540, H = 960, fps = 30, perStep = 30, steps = [0, 1, 2, 3, 0];
    let n = 0;
    for (const [si, step] of steps.entries()) {
      for (let f = 0; f < perStep; f++, n++) {
        const tap = f > perStep * 0.6 ? `<circle cx="195" cy="${step === 0 ? 220 : 765}" r="${10 + (f - perStep * 0.6) * 2}" fill="#6366f1" opacity="${Math.max(0, 0.5 - (f - perStep * 0.6) / 24)}"/>` : "";
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="${FONT}">${DEFS}<rect width="${W}" height="${H}" fill="#0f172a"/>
          <g transform="translate(${(W - 390 * 1.08) / 2} 18) scale(1.08)"><svg width="390" height="844">${phoneScreen(step)}${tap}</svg></g>
          <rect x="0" y="${H - 40}" width="${W}" height="40" fill="#020617"/><text x="16" y="${H - 14}" font-size="16" fill="#94a3b8">Pi · QA run · iPhone 16 Pro · step ${si + 1}/5</text></svg>`;
        writeFileSync(join(dir, `f${String(n).padStart(4, "0")}.png`), await sharp(Buffer.from(svg)).png().toBuffer());
      }
    }
    const out = join(dir, "qa.mp4");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-framerate", String(fps), "-i", join(dir, "f%04d.png"),
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "26", "-movflags", "+faststart", out]);
    return readFileSync(out);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
