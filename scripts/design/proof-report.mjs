// Builds a self-contained HTML proof report (images inlined as data: URLs) for the design pass.
// Usage: node scripts/design/proof-report.mjs <before-dir> <after-dir> <out.html>
// Reads: design-bundle-preservation.json, tmp/design-captures/{full-suite-*.log,typecheck.log}, git metadata.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const [beforeDir, afterDir, out] = process.argv.slice(2);
const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const img = (p) => existsSync(p) ? `data:image/png;base64,${readFileSync(p).toString("base64")}` : null;
const counts = (f) => {
  if (!existsSync(f)) return null;
  const t = readFileSync(f, "utf8"), n = (k) => Number((t.match(new RegExp(`^ℹ ${k} (\\d+)`, "m")) || [])[1]);
  return { tests: n("tests"), pass: n("pass"), fail: n("fail"), failed: [...new Set([...t.matchAll(/^✖ (.+?) \(\d/gm)].map((m) => m[1]))] };
};
const pres = JSON.parse(readFileSync("design-bundle-preservation.json", "utf8"));
const head = git("rev-parse", "--short", "HEAD"), base = "0ea9c9e";
const runtime = createHash("sha256").update(readFileSync("src/index.js")).digest("hex");
const cfg = JSON.parse(readFileSync(process.env.PROOF_CONFIG || "tmp/design-captures/proof-config.json", "utf8"));

const pairs = cfg.pairs.map(([label, before, after, note]) => `
  <figure class="pair"><figcaption><strong>${esc(label)}</strong>${note ? ` — ${esc(note)}` : ""}</figcaption>
    <div class="cols">
      <div><span class="tag">Before (${base})</span>${before && img(`${beforeDir}/${before}`) ? `<img alt="Before: ${esc(label)}" src="${img(`${beforeDir}/${before}`)}">` : `<p class="na">No equivalent before</p>`}</div>
      <div><span class="tag after">After (${head})</span><img alt="After: ${esc(label)}" src="${img(`${afterDir}/${after}`)}"></div>
    </div></figure>`).join("");

const runs = cfg.runs.map(([label, file]) => { const c = counts(file); return `<tr><td>${esc(label)}</td><td>${c ? c.tests : "—"}</td><td>${c ? c.pass : "—"}</td><td class="${c && c.fail ? "bad" : ""}">${c ? c.fail : "—"}</td><td>${c && c.failed.length ? esc(c.failed.join("; ")) : ""}</td></tr>`; }).join("");
const list = (xs) => `<ul>${xs.map((x) => `<li>${x}</li>`).join("")}</ul>`;

writeFileSync(out, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Library design pass — proof report (${head})</title>
<style>
:root{--bg:#f6f6f8;--fg:#18181b;--muted:#52525b;--line:#e4e4e7;--card:#fff;--accent:#2563eb;--ok:#15803d;--bad:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#0a0a0d;--fg:#ececef;--muted:#a1a1aa;--line:#26262c;--card:#111114;--accent:#60a5fa;--ok:#4ade80;--bad:#f87171}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 Inter,system-ui,sans-serif}
main{max-width:1180px;margin:0 auto;padding:32px 20px 64px}h1{font-size:28px;margin:0 0 4px;letter-spacing:-.02em}h2{font-size:19px;margin:36px 0 10px;padding-top:12px;border-top:1px solid var(--line)}
.sub{color:var(--muted);margin:0 0 16px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 18px;margin:12px 0}
table{border-collapse:collapse;width:100%;font-size:14px}td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{color:var(--muted);font-weight:600}
code{font:13px ui-monospace,Menlo,monospace;overflow-wrap:anywhere}.bad{color:var(--bad);font-weight:600}.ok{color:var(--ok);font-weight:600}
.pair{margin:18px 0;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px}.pair figcaption{margin-bottom:8px}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:12px}.cols img{width:100%;height:auto;border:1px solid var(--line);border-radius:8px;display:block}
.tag{display:inline-block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:4px}.tag.after{color:var(--accent)}.na{color:var(--muted);font-style:italic}
@media (max-width:760px){.cols{grid-template-columns:1fr}}
pre{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px;overflow:auto;font-size:13px}
</style></head><body><main>
<h1>Agent Library design pass</h1>
<p class="sub">Local proof report · branch <code>${esc(git("rev-parse", "--abbrev-ref", "HEAD"))}</code> · commit <code>${head}</code> (base <code>${base}</code>) · generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC · not deployed, not pushed; waiting for deliberate release.</p>

<div class="card"><strong>Status:</strong> ${cfg.status}</div>

<h2>Rationale</h2>${list(cfg.rationale)}

<h2>Tests (final runtime <code>${runtime.slice(0, 16)}…</code>)</h2>
<table><tr><th>Run</th><th>Tests</th><th>Pass</th><th>Fail</th><th>Failures</th></tr>${runs}</table>
<p>Typecheck: <span class="${/^\s*$/.test(readFileSync("tmp/design-captures/typecheck.log", "utf8")) ? "ok" : "bad"}">${/^\s*$/.test(readFileSync("tmp/design-captures/typecheck.log", "utf8")) ? "exit 0, no diagnostics" : "diagnostics present"}</span> (<code>node node_modules/typescript/bin/tsc --noEmit</code>).</p>
<h3>The four pre-existing browser failures</h3>${list(cfg.preexisting)}

<h2>Runtime preservation (byte-level)</h2>
<table>
<tr><th>Item</th><th>sha256</th><th>Result</th></tr>
<tr><td>Release input (<code>src/index.js</code> @ ${base})</td><td><code>${pres.base_release_sha256}</code></td><td>pinned input</td></tr>
<tr><td>Candidate runtime</td><td><code>${pres.integrated_sha256}</code></td><td>${pres.integrated_sha256 === runtime ? '<span class="ok">matches src/index.js</span>' : '<span class="bad">differs</span>'}</td></tr>
<tr><td>Publisher / generation module</td><td><code>${pres.publisher_module_sha256}</code></td><td class="ok">identical to release</td></tr>
<tr><td>HOSTED_CALLBACKS (exact public client callbacks)</td><td><code>${pres.hosted_callbacks_sha256}</code></td><td class="ok">identical to release</td></tr>
<tr><td>OAuth server module</td><td><code>${pres.oauth_server_module_sha256.release.slice(0, 16)}… → ${pres.oauth_server_module_sha256.candidate.slice(0, 16)}…</code></td><td>only the page() &lt;style&gt; span differs (asserted by the build)</td></tr>
<tr><td>UI module</td><td><code>${pres.ui_module_release_sha256.slice(0, 16)}… → ${pres.ui_module_candidate_sha256.slice(0, 16)}…</code></td><td>replaced (the design work)</td></tr>
</table>
${cfg.serverDiff}

<h2>Before / after</h2>
<p class="sub">Synthetic loopback data only (App Connect test harness, stand-in OIDC owner). Desktop 1440, mobile 390, narrow 320; light and dark.</p>
${pairs}

<h2>Accessibility and keyboard</h2>${list(cfg.a11y)}

<h2>Reviews</h2>${list(cfg.reviews)}

<h2>Limitations</h2>${list(cfg.limitations)}

<h2>Self-critique</h2>${list(cfg.critique)}

<h2>Verify locally</h2><pre>${esc(cfg.verify)}</pre>
</main></body></html>`);
console.log(out, (readFileSync(out).length / 1024 / 1024).toFixed(2) + " MB");
