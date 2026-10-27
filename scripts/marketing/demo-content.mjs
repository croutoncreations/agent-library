// Synthetic demo library for marketing screenshots/video: things AGENTS produce while one person ships a side
// project ("Tidepool", a made-up habit-tracker app). Fictional people, numbers and products only. No real user,
// health or production content.

export const OWNER_NAME = "Maya Chen";

export const PROJECTS = [
  { id: "tidepool", title: "Tidepool app" },
  { id: "research", title: "Market research" },
  { id: "qa-runs", title: "QA runs" },
  { id: "personal", title: "Personal" },
];

// Agents that write into the library. kind: "oauth" connects through the real consent flow and writes over MCP;
// "token" is a project token (also used for uploads); "apikey" is a /v1 API key.
// redirect: the hosted callback each assistant really uses (allow-listed by the server); never contacted here.
const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback", CHATGPT_CB = "https://chatgpt.com/connector_platform_oauth_redirect";
export const AGENTS = {
  claude: { name: "Claude", kind: "oauth", redirect: CLAUDE_CB, grants: { tidepool: "write", research: "write", "qa-runs": "read", personal: "write" } },
  chatgpt: { name: "ChatGPT", kind: "oauth", redirect: CHATGPT_CB, grants: { tidepool: "write", research: "write", personal: "write" } },
  grok: { name: "Grok Bot", kind: "oauth", redirect: "https://www.cursor.com/agents/mcp/oauth/callback", grants: { research: "write" } },
  duet: { name: "Claude Duet", kind: "oauth", redirect: CLAUDE_CB, grants: { personal: "write", tidepool: "read" } },
  dot: { name: "ChatGPT Dot", kind: "oauth", redirect: CHATGPT_CB, grants: { personal: "write" } },
  cc: { name: "Claude Code", kind: "token", projects: ["tidepool", "qa-runs"] },
  codex: { name: "Codex", kind: "token", projects: ["tidepool", "qa-runs"] },
  pi: { name: "Pi", kind: "token", projects: ["qa-runs"] },
  muse: { name: "Muse", kind: "apikey", projects: [{ project_id: "research", access: "read_write" }, { project_id: "personal", access: "read" }] },
};

// ---------- hero doc: a launch plan several agents revise (drives History + diff) ----------
export const PLAN_V1 = `# Tidepool 1.0 launch plan

**Launch:** Tuesday, November 17 · **Owner:** Maya · **Status:** On track

Tidepool is a tiny habit tracker that syncs offline. This is the plan for 1.0; my agents and I both edit it.

## Goals

- 2,000 sign-ups in the first two weeks
- 40% of new users log a habit three days in a row
- A Show HN post that reaches the front page

## Timeline

| Week | Milestone | Who | Status |
| --- | --- | --- | :---: |
| Nov 2 | Release candidate | Claude Code | Done |
| Nov 9 | Landing page and docs | Codex | In progress |
| Nov 13 | Press kit | ChatGPT | Scheduled |
| Nov 17 | Launch day | Everyone | Planned |

## Messaging

> Build a habit in two taps. Works on a plane.
`;
export const PLAN_V2 = PLAN_V1.replace("## Messaging", `## Early signal

![Weekly beta sign-ups](IMG_CHART)

Beta sign-ups grew **3.4x** in six weeks, with the biggest jump after the widget preview.

## Messaging`);
export const PLAN_V3 = PLAN_V2 + `
## Risks

| Risk | Likelihood | Mitigation |
| --- | :---: | --- |
| Sync bug on older iPhones | Medium | QA run on iOS 17 devices (see QA runs) |
| Launch-day traffic | Low | Static landing page on a CDN |
| App Store review delay | High | Submit on Nov 10 |

## Launch-day checklist

- Publish the landing page at 9:00 PT
- Post Show HN and reply to every comment
- Send the beta list email

\`\`\`bash
# Flip the paywall flag for everyone
tidepool flags set paywall_v2 --rollout 100
\`\`\`
`;
export const PLAN_V4 = PLAN_V3.replace("2,000 sign-ups in the first two weeks", "2,500 sign-ups in the first two weeks (raised after the beta)");

// ---------- HTML pages agents generate ----------
const pageCss = `body{margin:0;font-family:-apple-system,"SF Pro Display",Inter,system-ui,sans-serif;color:#0f172a;background:#f8fafc}
@media (max-width:640px){.pad{padding-left:22px!important;padding-right:22px!important}h1{font-size:34px!important}.grid{grid-template-columns:1fr!important}}`;

export const LANDING_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Tidepool</title><style>${pageCss}
.hero{padding:64px 56px 56px;background:linear-gradient(135deg,#0ea5e9 0%,#6366f1 55%,#a855f7 100%);color:#fff}
.eyebrow{display:inline-block;padding:6px 12px;border-radius:999px;background:rgba(255,255,255,.2);font-size:13px;font-weight:700;letter-spacing:.05em;text-transform:uppercase}
h1{font-size:54px;line-height:1.04;margin:20px 0 16px;letter-spacing:-.03em}.hero p{font-size:20px;max-width:600px;opacity:.93;margin:0}
.cta{display:inline-block;margin-top:28px;padding:14px 22px;background:#fff;color:#4338ca;border-radius:12px;font-weight:700;text-decoration:none}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;padding:40px 56px}
.card{background:#fff;border-radius:16px;padding:24px;box-shadow:0 1px 2px rgba(15,23,42,.06),0 8px 24px rgba(15,23,42,.06)}
.card b{display:block;font-size:18px;margin-bottom:6px}.card span{color:#475569}
.shot{padding:0 56px 56px}.shot img{width:100%;border-radius:16px;display:block;box-shadow:0 12px 40px rgba(15,23,42,.18)}</style></head><body>
<section class="hero pad"><span class="eyebrow">Launching November 17</span><h1>Build a habit<br>in two taps.</h1>
<p>Tidepool is a tiny habit tracker that works offline and never nags. Your streaks sync the moment you're back online.</p>
<a class="cta" href="https://example.com/tidepool">Join the beta</a></section>
<section class="grid pad"><div class="card"><b>🌊 Two taps</b><span>Log a habit from the widget without opening the app.</span></div>
<div class="card"><b>✈️ Offline</b><span>Works on a plane. Syncs when you land.</span></div>
<div class="card"><b>🔒 Private</b><span>Your data stays on your devices unless you choose sync.</span></div></section>
<section class="shot pad"><img src="IMG_HERO" alt="Tidepool app screens"></section></body></html>`;

export const PERF_REPORT_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Performance audit</title><style>${pageCss}
.wrap{padding:40px 56px}.top{display:flex;align-items:center;justify-content:space-between;margin-bottom:28px}
h1{font-size:30px;margin:0;letter-spacing:-.02em}.sub{color:#64748b;margin-top:6px}
.scores{display:grid;grid-template-columns:repeat(4,1fr);gap:18px}
.score{background:#fff;border-radius:16px;padding:22px;text-align:center;box-shadow:0 1px 2px rgba(15,23,42,.06),0 8px 24px rgba(15,23,42,.05)}
.ring{width:96px;height:96px;margin:0 auto 12px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:30px;font-weight:800}
.g{border:8px solid #22c55e;color:#15803d}.o{border:8px solid #f59e0b;color:#b45309}
table{width:100%;border-collapse:collapse;margin-top:28px;background:#fff;border-radius:14px;overflow:hidden}
td,th{padding:12px 16px;text-align:left;border-bottom:1px solid #e2e8f0;font-size:15px}th{background:#f1f5f9}
.pill{padding:3px 10px;border-radius:999px;font-size:12px;font-weight:700}.ok{background:#dcfce7;color:#166534}.warn{background:#fef3c7;color:#92400e}</style></head><body>
<div class="wrap pad"><div class="top"><div><h1>tidepool.example · performance audit</h1><div class="sub">Generated by Codex · mobile, slow 4G · run 3 of 3</div></div></div>
<div class="scores grid"><div class="score"><div class="ring g">98</div>Performance</div><div class="score"><div class="ring g">100</div>Accessibility</div>
<div class="score"><div class="ring o">86</div>Best practices</div><div class="score"><div class="ring g">100</div>SEO</div></div>
<table><tr><th>Metric</th><th>Value</th><th>Status</th></tr>
<tr><td>Largest Contentful Paint</td><td>1.1 s</td><td><span class="pill ok">Good</span></td></tr>
<tr><td>Total Blocking Time</td><td>40 ms</td><td><span class="pill ok">Good</span></td></tr>
<tr><td>Cumulative Layout Shift</td><td>0.02</td><td><span class="pill ok">Good</span></td></tr>
<tr><td>Image formats</td><td>2 PNGs could be WebP</td><td><span class="pill warn">Fix</span></td></tr></table></div></body></html>`;

// ---------- Markdown docs (project, key, title, author, body) ----------
export const DOCS = [
  ["tidepool", "refactor", "Refactor plan: sync engine", "cc", `# Refactor plan: sync engine

*Written by Claude Code after reading \`src/sync/\` (14 files, 2,310 lines).*

## Problem

\`SyncQueue\` mixes retry logic, conflict handling and persistence, so every bug fix touches all three.

## Plan

1. Extract \`RetryPolicy\` (pure, unit-testable)
2. Move conflict handling behind \`resolveConflict(local, remote)\`
3. Keep the on-disk format unchanged; no migration

\`\`\`ts
export function resolveConflict(local: Entry, remote: Entry): Entry {
  return local.updatedAt > remote.updatedAt ? local : remote;
}
\`\`\`

| Step | Files | Risk |
| --- | ---: | :---: |
| RetryPolicy | 3 | Low |
| Conflict handling | 5 | Medium |
| Cleanup | 6 | Low |
`],
  ["tidepool", "release", "Release notes 1.0", "codex", `# Tidepool 1.0 release notes

## New

- **Home screen widget**: log a habit in two taps
- **Offline mode**: everything works without a connection
- **Streak freeze**: one free skip per week

## Fixed

- Sync no longer duplicates entries after airplane mode
- Dark mode contrast on the stats screen
`],
  ["tidepool", "presskit", "Press kit", "chatgpt", `# Tidepool press kit

**One-liner:** Tidepool is a tiny habit tracker that works offline and never nags.

> "I built Tidepool because every habit app wanted my email before my first habit." (Maya Chen, maker)

## Facts

- Launch: November 17
- Platforms: iOS, Android, web
- Price: free, with a $2/month Plus plan
`],
  ["research", "brief", "Research brief: habit-app market", "chatgpt", `# Research brief: habit-app market

*Compiled by ChatGPT from 23 public sources.*

## Summary

The category is crowded but most apps are account-first and online-only. **Offline-first** and **no sign-up to start** are both rare.

| App | Offline | Sign-up required | Price |
| --- | :---: | :---: | ---: |
| Tidepool | ✅ | No | $0 / $2 |
| App A | ❌ | Yes | $5 |
| App B | Partial | Yes | $8 |
| App C | ✅ | Yes | $3 |

## Recommendation

Lead with "works on a plane" and "no account needed".
`],
  ["research", "trends", "Trend watch: what people say about habit apps", "grok", `# Trend watch: habit apps

*Grok Bot, weekly scan of public posts.*

- **"Streak anxiety"** is up 40% month over month. People want gentler streaks.
- Widgets are the most-requested feature in 3 of the top 5 threads.
- "Works offline" shows up mostly in travel and commuting posts.

> Takeaway: the streak-freeze feature is worth calling out at launch.
`],
  ["research", "interviews", "Interview notes: 8 beta testers", "muse", `# Interview notes: 8 beta testers

*Summarized by Muse from call transcripts.*

1. **The widget is the product.** 7 of 8 log from the home screen.
2. **Notifications feel naggy.** Most turned them off by day 3.
3. **They want export.** "My data, my CSV."

| Tester | Uses widget | Wants export |
| --- | :---: | :---: |
| T1 | ✅ | ✅ |
| T2 | ✅ | ❌ |
| T3 | ✅ | ✅ |
| T4 | ❌ | ✅ |
`],
  ["qa-runs", "qareport", "QA report: onboarding on iPhone", "pi", `# QA report: onboarding on iPhone

*Pi drove the app on 3 simulators and recorded each run.*

![Onboarding run](IMG_QA_SHOT)

| Device | Result | Time |
| --- | :---: | ---: |
| iPhone 16 Pro | ✅ Pass | 41 s |
| iPhone SE | ✅ Pass | 44 s |
| iPhone 13 mini | ⚠️ Text clipped on step 2 | 47 s |

**Next:** shorten the step 2 headline; re-run on the mini.
`],
  ["personal", "trip", "Lisbon trip plan", "duet", `# Lisbon trip plan

*Planned with Claude Duet.*

![Lisbon rooftops at sunset](IMG_PHOTO)

| Day | Plan |
| --- | --- |
| Thu | Fly in, Alfama walk, dinner at 8 |
| Fri | Belém, pastéis de nata, LX Factory |
| Sat | Sintra day trip |
| Sun | Slow morning, fly home |

- Book Sintra tickets by Wednesday
- Pack comfortable shoes (hills!)
`],
  ["personal", "groceries", "Weekly groceries + meal plan", "dot", `# Weekly groceries + meal plan

*From ChatGPT Dot, based on what's in the fridge.*

| Day | Dinner |
| --- | --- |
| Mon | Lemon pasta |
| Tue | Sheet-pan chicken |
| Wed | Leftovers |
| Thu | Tacos |

## List

- Lemons, parsley, garlic
- Chicken thighs, tortillas
- Greek yogurt, berries
`],
  ["personal", "reading", "Reading list", "owner", `# Reading list

- *The Design of Everyday Things*: re-read chapter 2
- *Shape Up*: for the post-launch roadmap
- *Working in Public*: before open-sourcing anything
`],
];

export const CSV_SIGNUPS = `week,signups,activated,widget_users
2026-09-14,420,171,88
2026-09-21,510,214,121
2026-09-28,640,282,170
2026-10-05,780,351,233
2026-10-12,1190,547,402
2026-10-19,1430,672,515
`;

export const JSON_CONFIG = JSON.stringify({
  app: "tidepool",
  version: "1.0.0",
  flags: { paywall_v2: { rollout: 10 }, streak_freeze: { rollout: 100 }, widget: { rollout: 100 } },
  release: { date: "2026-11-17", channels: ["ios", "android", "web"] },
}, null, 2);
