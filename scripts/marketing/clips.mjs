// Marketing CLIPS: short real-UI screen recordings for the launch video, at 2x (desktop 2880x1800) / 3x (mobile
// 1170x2532), ~60 fps, via the Chrome DevTools screencast. Frames are timestamped and re-timed to a constant 60 fps,
// then encoded to near-lossless H.264 (CRF 12, yuv444 is avoided for compatibility) so Remotion can zoom/crop later.
// Usage: node scripts/marketing/clips.mjs [--out tmp/marketing/clips] [--only agent-save,editor-typing,...] [--scheme dark]
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { SERVER_PORTS } from "../../test/ports.mjs";
import { seedDemoLibrary } from "./seed.mjs";
import { PLAN_V4 } from "./demo-content.mjs";

const require = createRequire(import.meta.url);
const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg("out", "tmp/marketing/clips");
const PORT = Number(arg("port", String(SERVER_PORTS["marketing-clips"])));
const ONLY = (arg("only", "") || "").split(",").filter(Boolean);
const SCHEMES = (arg("scheme", "dark,light")).split(",");
const want = (k) => !ONLY.length || ONLY.includes(k);
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const puppeteer = require(`${process.env.HOME}/.npm-packages/lib/node_modules/puppeteer`);
const FPS = 60;
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const made = [];

const { h, owner, ids, save } = await seedDemoLibrary({ port: PORT, onStage: (s) => console.error("seed:", s) });
const APP = h.appUi;
// consent: a narrow desktop viewport at 3x, so the cropped consent card stays sharp when zoomed in the video.
const VIEW = {
  desktop: { width: 1440, height: 900, scale: 2, mobile: false },
  mobile: { width: 390, height: 844, scale: 3, mobile: true },
  consent: { width: 560, height: 900, scale: 3, mobile: false },
};
const MCP = h.issuer;
let browser;

// One browser per viewport kind: --force-device-scale-factor makes the screencast deliver full-resolution frames.
async function launch(kind) {
  const v = VIEW[kind];
  return puppeteer.launch({ executablePath: CHROME, headless: true, defaultViewport: null,
    args: ["--no-first-run", "--font-render-hinting=none", `--force-device-scale-factor=${v.scale}`, `--window-size=${v.width},${v.height}`, "--hide-scrollbars"] });
}
async function preparePage(b, kind, scheme) {
  const v = VIEW[kind];
  const page = (await b.pages())[0] ?? await b.newPage();
  const cdp = await page.createCDPSession();
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: v.width, height: v.height, deviceScaleFactor: v.scale, mobile: v.mobile });
  if (v.mobile) await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
  page.on("dialog", (d) => d.accept().catch(() => {}));
  await page.goto(APP + "/");
  const [cn, cv] = owner.cookie.split("=");
  await page.setCookie({ name: cn, value: cv.split(";")[0], url: APP });
  await page.goto(APP + "/#/"); await page.reload(); await page.waitForSelector("#nav a, .tabbar a, nav a", { timeout: 15000 });
  return { page, cdp };
}

// Record: start screencast, run the action, stop; write frames re-timed to a constant 60 fps; encode.
async function record(name, { page, cdp }, kind, action, { tail = 600 } = {}) {
  const v = VIEW[kind], W = v.width * v.scale, H = v.height * v.scale;
  const dir = join(OUT, `.frames-${name}`); rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  const frames = [];
  const onFrame = (f) => { frames.push({ t: f.metadata.timestamp, data: f.data }); cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {}); };
  cdp.on("Page.screencastFrame", onFrame);
  await cdp.send("Page.startScreencast", { format: "png", maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  await sleep(400);
  await action(page);
  await sleep(tail);
  await cdp.send("Page.stopScreencast");
  cdp.off("Page.screencastFrame", onFrame);
  if (frames.length < 2) throw Error("no frames for " + name);
  // Re-time: for each output tick, take the latest frame at or before it (screencast only emits on change).
  const t0 = frames[0].t, dur = frames.at(-1).t - t0 + tail / 1000;
  const n = Math.round(dur * FPS);
  let j = 0, written = 0, lastPath = null;
  for (let i = 0; i < n; i++) {
    const t = t0 + i / FPS;
    while (j + 1 < frames.length && frames[j + 1].t <= t) j++;
    const p = join(dir, `f${String(written++).padStart(5, "0")}.png`);
    if (frames[j].path && frames[j].path !== lastPath) { /* identical frame: reuse via copy */ }
    writeFileSync(p, Buffer.from(frames[j].data, "base64"));
  }
  const file = join(OUT, `${name}-${kind}.mp4`);
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-framerate", String(FPS), "-i", join(dir, "f%05d.png"),
    "-vf", `scale=${W}:${H}:flags=lanczos,format=yuv420p`, "-c:v", "libx264", "-preset", "slow", "-crf", "12", "-tune", "animation", "-movflags", "+faststart", file]);
  rmSync(dir, { recursive: true, force: true });
  made.push({ file, kind, seconds: +(n / FPS).toFixed(2), size: `${W}x${H}`, rawFrames: frames.length });
  console.error("clip:", file, n, "frames");
}

// Smooth scroll / cursor helpers (the screencast shows page content; we draw our own subtle cursor dot for taps).
const smoothScroll = (page, y, ms = 1600) => page.evaluate((y, ms) => new Promise((res) => {
  const s = window.scrollY, d = y - s, t0 = performance.now();
  const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  (function step(now) { const k = Math.min(1, (now - t0) / ms); window.scrollTo(0, s + d * ease(k)); k < 1 ? requestAnimationFrame(step) : res(); })(t0);
}), y, ms);
const typeSlow = async (page, text, delay = 55) => { for (const ch of text) { await page.keyboard.type(ch); await sleep(delay + (Math.random() * 30 | 0)); } };
const clickTab = (page, n) => page.evaluate((n) => [...document.querySelectorAll("[role=tab]")].find((t) => t.textContent.trim() === n).click(), n);

let rev = 4;
try {
  for (const scheme of SCHEMES) {
    // ---------------- desktop ----------------
    browser = await launch("desktop");
    let ctx = await preparePage(browser, "desktop", scheme);
    let { page } = ctx;
    const art = (pid, id, extra = "") => `${APP}/#/p/${pid}/a/${id}${extra}`;

    if (want("home-scroll")) {
      await page.goto(APP + "/#/"); await page.waitForFunction(() => document.body.innerText.includes("Launch plan")); await sleep(600);
      await record(`home-scroll-${scheme}`, ctx, "desktop", async (p) => { await sleep(500); await smoothScroll(p, 700, 2600); await sleep(400); await smoothScroll(p, 0, 1800); });
    }
    if (want("agent-save")) {
      // The doc is open (rendered). An agent (Claude, over MCP) saves a new revision; the open page picks it up
      // on its refresh poll ("Updated to rev N (changed elsewhere)") and the History tab shows Claude at the top.
      await page.goto(art("tidepool", ids.plan)); await page.waitForSelector(".preview h1"); await sleep(800);
      await smoothScroll(page, 0, 10);
      await record(`agent-save-${scheme}`, ctx, "desktop", async (p) => {
        await sleep(800);
        const body = PLAN_V4.replace("IMG_CHART", ids.chart) + `\n## Launch-day runbook\n\n| Time (PT) | Step | Owner |\n| --- | --- | --- |\n| 8:30 | Final smoke test | Claude Code |\n| 9:00 | Publish landing page | Codex |\n| 9:05 | Post Show HN | Maya |\n| 9:30 | First metrics check | Claude |\n`;
        await save("claude", "tidepool", ids.plan, rev, body, "Turned the checklist into a launch-day runbook"); rev++;
        // Trigger the page's focus refresh instead of waiting up to 10 s for the poll.
        await p.evaluate(() => window.dispatchEvent(new Event("focus")));
        await p.waitForFunction(() => /changed elsewhere/.test(document.body.innerText), { timeout: 15000 });
        await sleep(900);
        await smoothScroll(p, await p.evaluate(() => document.body.scrollHeight), 2600);
        await sleep(900);
        await smoothScroll(p, 0, 900);
        await clickTab(p, "History"); await p.waitForSelector(".vh-list .vh-row"); await sleep(1800);
      }, { tail: 800 });
    }
    if (want("editor-typing")) {
      // A hash-only navigation can leave puppeteer holding a detached frame after an in-app reload; recover by
      // retrying once (rare, timing dependent).
      try { await page.goto(art("tidepool", ids.plan, "/edit")); }
      catch {
        await browser.close(); browser = await launch("desktop");
        ctx = await preparePage(browser, "desktop", scheme); page = ctx.page;
        await page.goto(art("tidepool", ids.plan, "/edit"));
      }
      await page.waitForSelector(".cm-editor"); await sleep(800);
      await record(`editor-typing-${scheme}`, ctx, "desktop", async (p) => {
        await p.evaluate(() => { const ed = window.__alActiveEditor(); ed.focus(); const v = ed.value; const i = v.indexOf("\n", v.indexOf("- A Show HN post")); ed.setSelectionRange(i, i); });
        await sleep(500);
        // The editor continues the list on Enter, so type only the item text (no "- ").
        await p.keyboard.press("Enter");
        await typeSlow(p, "**Agents welcome:** works with Claude, ChatGPT, Codex and Pi");
        await sleep(1500);
        // Wait for autosave to settle ("Saved").
        await p.waitForFunction(() => document.querySelector(".status")?.dataset.state === "saved" || /Saved/.test(document.querySelector(".status")?.textContent || ""), { timeout: 15000 }).catch(() => {});
        await sleep(600);
        await clickTab(p, "Preview"); await p.waitForSelector(".preview h1"); await sleep(1600);
      });
      rev++;
    }
    if (want("copy-link")) {
      await page.goto(art("qa-runs", ids.qareport)); await page.waitForSelector(".preview img"); await sleep(800);
      await record(`copy-link-${scheme}`, ctx, "desktop", async (p) => {
        await sleep(700);
        const btn = await p.$('button[aria-label="Copy link"]');
        await p.evaluate(() => { navigator.clipboard.writeText = () => Promise.resolve(); });
        await btn.click(); await sleep(1600);
      });
    }
    if (want("diff")) {
      await page.goto(`${APP}/p/tidepool/a/${ids.plan}`); await page.waitForSelector(".preview h1");
      await clickTab(page, "History"); await page.waitForSelector(".vh-list .vh-row"); await sleep(700);
      await record(`history-diff-${scheme}`, ctx, "desktop", async (p) => {
        await sleep(600);
        await p.evaluate(() => document.querySelector('.vh-row[data-rev="2"] button').click());
        await p.waitForSelector(".vh-diff .vh-line.add"); await sleep(500);
        await p.evaluate(() => { const t = document.querySelector(".vh-detail"); window.scrollTo({ top: t.getBoundingClientRect().top + window.scrollY - 90, behavior: "smooth" }); });
        await sleep(2400);
      });
    }
    if (want("formats")) {
      // Quick tour across formats: HTML page -> video -> image -> PDF (navigations inside one recording).
      await page.goto(art("tidepool", ids.landing)); await page.waitForSelector("iframe.htmlview"); await sleep(1200);
      await record(`formats-tour-${scheme}`, ctx, "desktop", async (p) => {
        await sleep(1400);
        await p.goto(art("qa-runs", ids.qaVideo)); await p.waitForSelector(".media video");
        await p.evaluate(() => { const v = document.querySelector(".media video"); v.muted = true; v.play(); }); await sleep(2600);
        await p.goto(art("tidepool", ids.chart)); await p.waitForSelector(".media img"); await sleep(1600);
        await p.goto(art("qa-runs", ids.perf)); await p.waitForSelector("iframe.htmlview"); await sleep(1800);
      });
    }
    if (want("restore")) {
      // Claude's good v5 (the runbook, the same change the video's MCP scene hands to Codex), then ChatGPT makes a
      // clearly destructive v6 ("condensed" the plan down to almost nothing). History: open v5 → "Compare with
      // current" shows the wipe-out in red → "Restore this version" brings v5 back as v7 (nothing is deleted).
      if (rev === 4) {
        const body = PLAN_V4.replace("IMG_CHART", ids.chart) + `\n## Launch-day runbook\n\n| Time (PT) | Step | Owner |\n| --- | --- | --- |\n| 8:30 | Final smoke test | Claude Code |\n| 9:00 | Publish landing page | Codex |\n| 9:05 | Post Show HN | Maya |\n| 9:30 | First metrics check | Claude |\n`;
        await save("claude", "tidepool", ids.plan, rev, body, "Turned the checklist into a launch-day runbook"); rev++;
      }
      const goodRev = rev;
      await save("chatgpt", "tidepool", ids.plan, rev, "# Tidepool 1.0 launch plan\n\n**Launch:** TBD\n\n## Notes\n\n- Keep it simple\n", "Condensed the plan to the essentials"); rev++;
      await page.goto(`${APP}/p/tidepool/a/${ids.plan}`); await page.waitForSelector(".preview h1");
      await clickTab(page, "History"); await page.waitForSelector(`.vh-row[data-rev="${goodRev}"]`); await sleep(700);
      const btnByText = (p, t) => p.evaluateHandle((t) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === t), t);
      await record(`history-restore-${scheme}`, ctx, "desktop", async (p) => {
        await sleep(900);
        await (await p.$(`.vh-row[data-rev="${goodRev}"] button.vh-open`)).click();
        await p.waitForSelector(".vh-diff"); await sleep(500);
        await (await btnByText(p, "Compare with current")).click();
        await p.waitForFunction((g) => new RegExp(`compared with v${g}|Changes from v${g} to v${g + 1}`).test(document.body.innerText), {}, goodRev); await sleep(300);
        await p.evaluate(() => { const t = document.querySelector(".vh-diff .vh-line.del"); t && window.scrollTo({ top: t.getBoundingClientRect().top + window.scrollY - 330, behavior: "smooth" }); });
        await sleep(2000);
        await p.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" })); await sleep(500);
        await (await btnByText(p, "Restore this version")).click();
        await p.waitForFunction((g) => new RegExp(`restored from v${g}`).test(document.body.innerText), { timeout: 15000 }, goodRev);
        await p.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
        await sleep(2200);
      });
      rev++;
    }
    if (want("connections")) {
      await page.goto(APP + "/#/settings/apps"); await page.waitForFunction(() => document.body.innerText.includes("Grok Bot")); await sleep(700);
      await record(`connections-scroll-${scheme}`, ctx, "desktop", async (p) => { await sleep(500); await smoothScroll(p, await p.evaluate(() => document.body.scrollHeight), 3400); await sleep(500); });
    }
    await browser.close(); browser = null;

    // ---------------- consent (3x, real clicks on the per-project toggles) ----------------
    if (want("consent")) {
      browser = await launch("consent");
      ctx = await preparePage(browser, "consent", scheme);
      const cp = ctx.page;
      const redirect = "https://claude.ai/api/mcp/auth_callback";
      const reg = await fetch(`${MCP}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [redirect], token_endpoint_auth_method: "none" }) }).then((r) => r.json());
      if (!reg.client_id) throw Error("register " + JSON.stringify(reg));
      const b64u = (b) => Buffer.from(b).toString("base64url");
      const { createHash, randomBytes } = await import("node:crypto");
      const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: redirect, scope: "agentlib:read agentlib:write offline_access", state: "s" + randomBytes(4).toString("hex"), resource: `${MCP}/mcp`, code_challenge: createHash("sha256").update(b64u(randomBytes(32))).digest("base64url"), code_challenge_method: "S256" });
      await cp.goto(`${MCP}/authorize?${q}`); await sleep(500);
      await Promise.all([cp.waitForNavigation({ waitUntil: "load" }), cp.click('button[value="approve"]')]);
      await cp.waitForFunction(() => /Choose what/i.test(document.body.innerText), { timeout: 15000 });
      // ANTICIPATED COPY: the launch video assumes connected agents can read files and upload new versions (build
      // prompt art_b6bvY6PMT0xZ3iu1 in the owner's library). Until that ships, the real page still says "Files …
      // are never shared", so the recording swaps in the planned wording. Remove this once the fix lands and
      // re-record from the real page.
      await cp.evaluate(() => {
        const p = document.querySelector("p.fine");
        // Exact copy from the jf-read-write-files branch (src/web/connect-pages.js).
        if (p) p.innerHTML = "<strong>Read</strong>: view documents and files (images, PDFs, videos) and their history, and download files. <strong>Edit</strong>: also create and change documents, and upload new files and new versions of files. Comments, trash and settings are never shared.";
      });
      await sleep(600);
      const pickSeg = async (p, name, val) => {
        const lab = await p.evaluateHandle((n, v) => { const i = document.querySelector(`input[type=radio][name="${n}"][value="${v}"]`); return i.closest("label") || i.parentElement; }, name, val);
        await lab.click();
      };
      // One click per musical beat (~630 ms) so the edit can sync highlights to the music.
      await record(`consent-toggle-${scheme}`, ctx, "consent", async (p) => {
        await sleep(630);
        for (const [n, v] of [["access:tidepool", "write"], ["access:research", "read"], ["access:qa-runs", "read"], ["access:qa-runs", "none"], ["access:personal", "write"]]) {
          await pickSeg(p, n, v).catch(async () => { await pickSeg(p, n, v === "none" ? "off" : v); });
          await sleep(630);
        }
        await sleep(600);
      });
      await browser.close(); browser = null;
    }

    // ---------------- mobile ----------------
    if (want("mobile")) {
      browser = await launch("mobile");
      ctx = await preparePage(browser, "mobile", scheme);
      const mp = ctx.page;
      await mp.goto(APP + "/#/"); await mp.waitForFunction(() => document.body.innerText.includes("Launch plan")); await sleep(800);
      await record(`mobile-open-link-${scheme}`, ctx, "mobile", async (p) => {
        await sleep(700);
        // "Open the link on your phone": land on the shared doc and scroll through it.
        await p.goto(`${APP}/p/qa-runs/a/${ids.qareport}/preview`).catch(() => {});
        await p.waitForSelector(".preview img", { timeout: 15000 }); await sleep(1200);
        await smoothScroll(p, 900, 2600); await sleep(600);
      });
      await browser.close(); browser = null;
    }
  }
  writeFileSync(join(OUT, "clips.json"), JSON.stringify(made, null, 1));
  console.log(JSON.stringify(made, null, 1));
} finally {
  await browser?.close(); await h.stop();
}
