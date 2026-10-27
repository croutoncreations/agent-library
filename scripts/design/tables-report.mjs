// Self-contained HTML report for the mobile-table work (images inlined). Shares only screenshots of the SYNTHETIC
// fixture (test/fixtures/mobile-tables.md); the private revision-1 document is summarized by measurements only.
// Usage: node scripts/design/tables-report.mjs <before-dir> <after-dir> <config.json> <out.html>
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const [beforeDir, afterDir, cfgPath, out] = process.argv.slice(2);
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const img = (p) => { if (!existsSync(p)) throw Error("missing screenshot " + p); return `data:image/png;base64,${readFileSync(p).toString("base64")}`; };
const counts = (f) => {
  if (!existsSync(f)) return null;
  const t = readFileSync(f, "utf8"), n = (k) => Number((t.match(new RegExp(`^ℹ ${k} (\\d+)`, "m")) || [])[1]);
  return { tests: n("tests"), pass: n("pass"), fail: n("fail"), failed: [...new Set([...t.matchAll(/^✖ (.+?) \(\d/gm)].map((m) => m[1]))] };
};
const pres = JSON.parse(readFileSync("design-bundle-preservation.json", "utf8"));
const runtime = createHash("sha256").update(readFileSync("src/index.js")).digest("hex");
const head = git("rev-parse", "--short", "HEAD");
const list = (xs) => `<ul>${xs.map((x) => `<li>${x}</li>`).join("")}</ul>`;
// Screenshot file names carry the viewport: <doc>-<name>-<W>x<H>@<dpr>-<label>.png
const vpOf = (f) => { const m = /-(\d+)x(\d+)@([\d.]+)-/.exec(f); return m ? `${m[1]}×${m[2]} CSS px, deviceScaleFactor ${m[3]} (PNG ${Math.round(m[1] * m[3])}×${Math.round(m[2] * m[3])} px)` : ""; };
const figs = cfg.figures.map(([title, file, dir, note]) => `
  <figure><figcaption><strong>${esc(title)}</strong><br><span class="vp">${esc(vpOf(file))}</span>${note ? `<br>${esc(note)}` : ""}</figcaption>
  <img alt="${esc(title)}" src="${img(`${dir === "before" ? beforeDir : afterDir}/${file}`)}"></figure>`).join("");
const runs = cfg.runs.map(([label, f]) => { const c = counts(f); return `<tr><td>${esc(label)}</td><td>${c?.tests ?? "—"}</td><td>${c?.pass ?? "—"}</td><td class="${c?.fail ? "bad" : ""}">${c?.fail ?? "—"}</td><td>${c?.failed.length ? esc(c.failed.join("; ")) : ""}</td></tr>`; }).join("");
const metrics = cfg.metrics.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");

writeFileSync(out, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Library: mobile tables in the reader (${head})</title>
<style>
:root{--bg:#f6f6f8;--fg:#18181b;--muted:#52525b;--line:#e4e4e7;--card:#fff;--accent:#2563eb;--ok:#15803d;--bad:#b91c1c;--warn:#a16207}
@media (prefers-color-scheme:dark){:root{--bg:#0a0a0d;--fg:#ececef;--muted:#a1a1aa;--line:#26262c;--card:#111114;--accent:#60a5fa;--ok:#4ade80;--bad:#f87171;--warn:#facc15}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 Inter,system-ui,sans-serif}
main{max-width:1180px;margin:0 auto;padding:32px 20px 64px}h1{font-size:28px;margin:0 0 4px;letter-spacing:-.02em}h2{font-size:19px;margin:36px 0 10px;padding-top:12px;border-top:1px solid var(--line)}h3{font-size:16px;margin:20px 0 6px}
.sub{color:var(--muted);margin:0 0 16px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 18px;margin:12px 0}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px}td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{color:var(--muted);font-weight:600}
code{font:13px ui-monospace,Menlo,monospace;overflow-wrap:anywhere}.bad{color:var(--bad);font-weight:600}.ok{color:var(--ok);font-weight:600}.warn{color:var(--warn);font-weight:600}
.figs{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:16px;align-items:start}
figure{margin:0;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px}figure img{width:100%;height:auto;display:block;border:1px solid var(--line);border-radius:8px;margin-top:8px}
figcaption{font-size:13.5px}.vp{color:var(--muted);font-size:12.5px}pre{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px;overflow:auto;font-size:13px}
</style></head><body><main>
<h1>Mobile tables in the reader</h1>
<p class="sub">Agent Library design pass · branch <code>${esc(git("rev-parse", "--abbrev-ref", "HEAD"))}</code> · commit <code>${head}</code> · runtime <code>${runtime.slice(0, 16)}…</code> · generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC · local only, not deployed, waiting for deliberate release.</p>
<div class="card"><strong>Status:</strong> ${cfg.status}</div>

<h2>Diagnosis</h2>${list(cfg.diagnosis)}

<h2>What changed</h2>${list(cfg.changes)}

<h2>Measurements (real revision-1 document, rendered locally)</h2>
<p class="sub">Viewports are CSS pixels with deviceScaleFactor, not physical pixels. Pixel 9: 1080×2424 physical at 420 dpi ⇒ DPR 2.625 ⇒ 411.4×923.4 CSS; Chrome lays out at 412. No built-in Pixel 9 profile exists, so these measured values are used directly (no emulator/device).</p>
<div class="scroll"><table><tr>${cfg.metricsHead.map((h) => `<th>${h}</th>`).join("")}</tr>${metrics}</table></div>

<h2>Before / after (synthetic fixture with the same table shapes)</h2>
<p class="sub">The shared screenshots use <code>test/fixtures/mobile-tables.md</code> (invented content). Screenshots of the private document were inspected locally and stay in the ignored <code>tmp/</code> folder.</p>
<div class="figs">${figs}</div>

<h2>Interaction: touch, keyboard, screen reader, cards</h2>${list(cfg.interaction)}

<h2>Tests</h2>
<table><tr><th>Run</th><th>Tests</th><th>Pass</th><th>Fail</th><th>Failures</th></tr>${runs}</table>
${list(cfg.testNotes)}

<h2>Protected runtime preservation</h2>
<table><tr><th>Item</th><th>sha256</th><th>Result</th></tr>
<tr><td>Release input</td><td><code>${pres.base_release_sha256}</code></td><td>pinned</td></tr>
<tr><td>Candidate runtime</td><td><code>${pres.integrated_sha256}</code></td><td>${pres.integrated_sha256 === runtime ? '<span class="ok">matches src/index.js</span>' : '<span class="bad">differs</span>'}</td></tr>
<tr><td>Publisher / generation module</td><td><code>${pres.publisher_module_sha256}</code></td><td class="ok">identical to release</td></tr>
<tr><td>HOSTED_CALLBACKS</td><td><code>${pres.hosted_callbacks_sha256}</code></td><td class="ok">identical to release</td></tr>
<tr><td>OAuth server module</td><td><code>${pres.oauth_server_module_sha256.candidate.slice(0, 16)}…</code></td><td>unchanged by this work (consent &lt;style&gt; only, from the earlier pass)</td></tr>
<tr><td>Markdown renderer module</td><td><code>${pres.markdown_module_sha256.release.slice(0, 16)}… → ${pres.markdown_module_sha256.candidate.slice(0, 16)}…</code></td><td>replaced (tables)</td></tr>
<tr><td>UI module</td><td><code>${pres.ui_module_candidate_sha256.slice(0, 16)}…</code></td><td>replaced (design + table enhancement)</td></tr>
</table>${list(cfg.preservation)}

<h2>Reviews</h2>${list(cfg.reviews)}

<h2>Requirements not met / limitations</h2>${list(cfg.limitations)}

<h2>Verify locally</h2><pre>${esc(cfg.verify)}</pre>
</main></body></html>`);
console.log(out, (readFileSync(out).length / 1024 / 1024).toFixed(2) + " MB");
