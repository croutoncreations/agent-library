// Seed the synthetic demo library into a local, throwaway wrangler dev state, through REAL code paths:
// - agents connect via OAuth consent and write over MCP (Claude, ChatGPT, Grok Bot, Claude Duet, ChatGPT Dot),
// - project tokens (Claude Code, Codex, Pi) do real upload begin/PUT/finish and HTTP writes,
// - a /v1 API key (Muse) writes over the machine API,
// - the owner writes through the browser API.
// Then the server is stopped, timestamps are backdated in the local D1 file, and it is restarted on the same state.
// No tokens are written to disk or printed.
import { readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { startAppConnectServer } from "../../test/fixtures/app-connect-harness.mjs";
import { makePdf } from "../../test/make-fixtures.mjs";
import * as C from "./demo-content.mjs";
import { signupsChart, heroArt, lisbonPhoto, appScreenshot, qaRunVideo } from "./demo-images.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const idem = () => "k" + randomBytes(8).toString("hex");
const H = 60, D = 24 * 60;

function backdate(dir, offsets, ownerName) {
  const d1 = join(dir, "v3", "d1", "miniflare-D1DatabaseObject");
  const file = readdirSync(d1).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite");
  const db = new DatabaseSync(join(d1, file));
  const now = Date.now(), ago = (m) => new Date(now - m * 60000).toISOString();
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite%'").all()) {
    for (const c of db.prepare(`PRAGMA table_info(${name})`).all()) {
      if (!/_at$/.test(c.name) || /expires|revoked|trashed|exported|abandoned/.test(c.name) || c.type !== "TEXT") continue;
      db.prepare(`UPDATE ${name} SET ${c.name} = strftime('%Y-%m-%dT%H:%M:%fZ', ${c.name}, '-16 days') WHERE ${c.name} LIKE '____-__-__T%'`).run();
    }
  }
  for (const [aid, mins] of Object.entries(offsets)) {
    mins.forEach((m, i) => {
      db.prepare("UPDATE revisions SET created_at = ? WHERE artifact_id = ? AND rev_no = ?").run(ago(m), aid, i + 1);
      db.prepare("UPDATE meta_versions SET created_at = ? WHERE artifact_id = ? AND version = ?").run(ago(m), aid, i + 1);
    });
    db.prepare("UPDATE artifacts SET created_at = ?, updated_at = ? WHERE id = ?").run(ago(mins[0]), ago(mins[mins.length - 1]), aid);
    db.prepare("UPDATE comments SET created_at = ? WHERE artifact_id = ?").run(ago(Math.max(1, mins[mins.length - 1] - 20)), aid);
  }
  db.prepare("UPDATE principals SET label = ? WHERE issuer = 'local-dev' AND subject = 'owner'").run(ownerName);
  db.close();
}

/**
 * Seed and return { h, owner, ids, agents } with the server running (restarted after backdating).
 * agents: { claude, chatgpt, ... } with write(pid, ...) helpers that keep working after the restart.
 */
export async function seedDemoLibrary(opts) {
  const state = {};
  try { return await seed(opts, state); }
  catch (e) { await state.h?.stop().catch(() => {}); throw e; }
}
async function seed({ port, onStage = () => {} }, state) {
  let h = state.h = await startAppConnectServer({ port });
  let owner = await h.owner();
  const ok = (r, what) => { if (r.status >= 300) throw Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
  for (const p of C.PROJECTS) ok(await owner.req("POST", "/api/projects", p), "project " + p.id);
  onStage("projects");

  // ---- agents ----
  const agents = {};
  for (const [key, a] of Object.entries(C.AGENTS)) {
    if (a.kind === "oauth") agents[key] = { ...a, mcp: await h.connectMcpAgent(a.grants, { clientName: a.name, redirect: a.redirect }) };
    else if (a.kind === "token") {
      const tok = {};
      for (const pid of a.projects) tok[pid] = ok(await owner.req("POST", `/api/projects/${pid}/grants`, { label: a.name, can_write: true }), "grant").token;
      agents[key] = { ...a, tok };
    } else if (a.kind === "apikey") agents[key] = { ...a, secret: ok(await owner.req("POST", "/api/api-keys", { label: a.name, lifetime_days: 90, projects: a.projects }), "apikey").secret };
  }
  onStage("agents");
  const APP = () => h.appUi;

  async function mcp(agent, tool, args) {
    const r = await agent.mcp.call(tool, { ...args, idempotency_key: idem() });
    if (r.isError) throw Error(`${agent.name} ${tool}: ${JSON.stringify(r.data)}`);
    return r.data;
  }
  async function http(token, method, path, body) {
    // /v1 (API keys) lives on the machine host (MCP_HOST); /api on the owner app host.
    const r = await fetch((path.startsWith("/v1/") ? h.issuer : APP()) + path, { method, headers: { authorization: "Bearer " + token, "content-type": "application/json", "idempotency-key": idem() }, body: body && JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Error(`${method} ${path}: ${r.status} ${JSON.stringify(j)}`);
    return j;
  }
  // Create a document as any author kind.
  async function create(who, pid, title, body, { change_note = "First draft", format } = {}) {
    if (who === "owner") return ok(await owner.req("POST", `/api/projects/${pid}/artifacts`, { title, body, change_note, ...(format === "html" ? { kind: "html" } : {}) }), title).artifact_id;
    const a = agents[who];
    if (a.kind === "oauth") return (await mcp(a, "create_markdown", { project_id: pid, title, body, change_note, ...(format ? { format } : {}) })).artifact_id;
    if (a.kind === "token") return (await http(a.tok[pid], "POST", `/api/projects/${pid}/artifacts`, { title, body, change_note, ...(format === "html" ? { kind: "html" } : {}) })).artifact_id;
    return (await http(a.secret, "POST", `/v1/projects/${pid}/files`, { title, body, change_note, ...(format === "html" ? { kind: "html" } : {}) })).artifact_id;
  }
  async function save(who, pid, aid, expected_revision, body, change_note) {
    if (who === "owner") return ok(await owner.req("PUT", `/api/projects/${pid}/artifacts/${aid}`, { expected_revision, body, change_note }), "save");
    const a = agents[who];
    if (a.kind === "oauth") return mcp(a, "save_markdown", { project_id: pid, artifact_id: aid, expected_revision, body, change_note });
    if (a.kind === "token") return http(a.tok[pid], "PUT", `/api/projects/${pid}/artifacts/${aid}`, { expected_revision, body, change_note });
    return http(a.secret, "PUT", `/v1/projects/${pid}/files/${aid}`, { expected_revision, body, change_note });
  }
  async function upload(who, pid, title, mime, bytes) {
    const t = agents[who].tok[pid];
    const b = await http(t, "POST", `/api/projects/${pid}/uploads`, { title, mime, size: bytes.length, sha256: sha(bytes) });
    const put = await fetch(APP() + b.put_url, { method: "PUT", headers: { authorization: "Bearer " + t, "content-type": "application/octet-stream" }, body: bytes });
    if (!put.ok) throw Error("upload put " + put.status);
    return (await http(t, "POST", `/api/projects/${pid}/uploads/${b.upload_id}/finish`, {})).artifact_id;
  }

  // ---- media (agents' outputs) ----
  const ids = {};
  ids.chart = await upload("cc", "tidepool", "Beta sign-ups chart", "image/png", await signupsChart());
  ids.hero = await upload("codex", "tidepool", "App screens (marketing)", "image/png", await heroArt());
  const qaVideo = await qaRunVideo();
  // Keep a copy for the launch video's collage tile (marketing/video/scripts/sync-assets.mjs reads it).
  const qaOut = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tmp", "media", "qa.mp4");
  mkdirSync(dirname(qaOut), { recursive: true });
  writeFileSync(qaOut, qaVideo);
  ids.qaVideo = await upload("pi", "qa-runs", "QA run: onboarding, iPhone 16 Pro", "video/mp4", qaVideo);
  ids.qaShot = await upload("pi", "qa-runs", "Screenshot: onboarding step 2", "image/png", await appScreenshot(2));
  ids.qaShotHome = await upload("cc", "qa-runs", "Screenshot: home screen", "image/png", await appScreenshot(0));
  ids.archPdf = await upload("cc", "tidepool", "Architecture overview", "application/pdf", makePdf());
  // Claude Duet (an OAuth assistant) can't upload bytes over MCP; its photo arrives through a project token of the same name.
  agents.duetFiles = { name: "Claude Duet", kind: "token", tok: { personal: ok(await owner.req("POST", "/api/projects/personal/grants", { label: "Claude Duet", can_write: true }), "grant").token } };
  ids.photo = await upload("duetFiles", "personal", "Lisbon rooftops at sunset", "image/jpeg", await lisbonPhoto());
  ids.csv = ok(await owner.req("POST", "/api/projects/tidepool/artifacts", { kind: "csv", title: "Beta sign-ups.csv", content: C.CSV_SIGNUPS }), "csv").artifact_id;
  ids.json = ok(await owner.req("POST", "/api/projects/tidepool/artifacts", { kind: "json", title: "Feature flags.json", content: C.JSON_CONFIG }), "json").artifact_id;
  onStage("media");

  // ---- documents ----
  const fill = (s) => s.replace("IMG_CHART", ids.chart).replace("IMG_HERO", ids.hero).replace("IMG_QA_SHOT", ids.qaShot).replace("IMG_PHOTO", ids.photo);
  for (const [pid, key, title, who, body] of C.DOCS) {
    ids[key] = await create(who, pid, title, fill(body));
    if (!ids[key]) throw Error(`no artifact id for ${key} (${who})`);
  }
  {
    // A second Duet revision on the trip (shows up in its History).
    const cur = ok(await owner.req("GET", `/api/projects/personal/artifacts/${ids.trip}`), "read");
    await save("duet", "personal", ids.trip, cur.revision.rev, cur.body + "\n> Sintra tickets booked for Saturday 10:00.\n", "Booked Sintra tickets");
  }
  ids.landing = await create("codex", "tidepool", "Landing page draft", fill(C.LANDING_HTML), { format: "html", change_note: "Static landing page for launch" });
  ids.perf = await create("codex", "qa-runs", "Performance audit: tidepool.example", C.PERF_REPORT_HTML, { format: "html", change_note: "Lighthouse-style audit, mobile" });

  // Hero doc with a four-version story.
  ids.plan = await create("owner", "tidepool", "Launch plan", fill(C.PLAN_V1), { change_note: "Kickoff draft" });
  await save("claude", "tidepool", ids.plan, 1, fill(C.PLAN_V2), "Added beta sign-up chart and early signal summary");
  await save("chatgpt", "tidepool", ids.plan, 2, fill(C.PLAN_V3), "Added risks table and launch-day checklist");
  await save("owner", "tidepool", ids.plan, 3, fill(C.PLAN_V4), "Raised sign-up goal after the beta");
  await owner.req("POST", `/api/projects/tidepool/artifacts/${ids.plan}/comments`, { revision: 4, body: "Looks great. Claude, can you turn the checklist into a launch-day runbook?" });
  onStage("docs");

  // ---- backdate + restart ----
  const offsets = {
    [ids.plan]: [6 * D + 3 * H, 4 * D + 5 * H, 1 * D + 2 * H, 38],
    [ids.landing]: [2 * H + 10], [ids.perf]: [3 * H + 20], [ids.qaVideo]: [55], [ids.qaShot]: [52], [ids.qaShotHome]: [5 * H],
    [ids.qareport]: [48], [ids.refactor]: [9 * H], [ids.release]: [26 * H], [ids.presskit]: [2 * D], [ids.brief]: [3 * D],
    [ids.trends]: [20 * H], [ids.interviews]: [4 * D], [ids.trip]: [5 * D, 4 * D + 2 * H],
    [ids.groceries]: [7 * H], [ids.reading]: [11 * D], [ids.chart]: [4 * D + 5 * H + 5], [ids.hero]: [2 * H + 30], [ids.archPdf]: [12 * D],
    [ids.photo]: [5 * D + 10], [ids.csv]: [7 * D], [ids.json]: [30 * H],
  };
  const dir = h.dir;
  await h.stop();
  backdate(dir, offsets, C.OWNER_NAME);
  state.h = null;
  h = state.h = await startAppConnectServer({ port, fresh: false });
  owner = await h.owner();
  onStage("restarted");
  // The MCP access tokens survive the restart (same KV/D1 state); token/API-key secrets are unchanged too.
  return { h, owner, ids, agents, create, save, upload };
}
