// The deleted-workspace purge (packages/core/src/workspace-purge.js, docs/workspaces.md#deleting-a-workspace) against
// the real packages/core/src bundle and every migration (node:sqlite, test/sqlite-world.mjs), with the real
// purgeDeletingWorkspaces, purgeDueProjects and deleteWorkspace and an in-memory R2. No listener. Synthetic data only.
// Two cases build states production can't write, on purpose and named: (g) a personal workspace marked deleting, and
// (v) a marked workspace forced back to active by off-script SQL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { loadWorker } from "./load-worker.mjs";
import { ROOT } from "./helpers.mjs";
import * as W from "./sqlite-world.mjs";

const lib = await loadWorker({ "workspace-purge.js": ["purgeDeletingWorkspaces", "WORKSPACE_PURGE_GRACE_DAYS"], "project-deletion.js": ["purgeDueProjects"],
  "workspaces.js": ["deleteWorkspace"], "adapters.js": ["withAdapters", "defaultAdapters"] });
const DAY = 864e5, AT = "2026-11-11T00:00:00.000Z";

function setup() {
  const world = W.mkWorld();
  const objects = new Set();
  const BLOBS = {
    async delete(k) { for (const x of [k].flat()) objects.delete(x); },
    async list({ prefix, limit }) { return { objects: [...objects].filter((k) => k.startsWith(prefix)).slice(0, limit).map((key) => ({ key })) }; },
  };
  const env = lib.withAdapters({ DB: world.DB, BLOBS }, lib.defaultAdapters());
  // The file's only raw-SQL writer (per-workspace rule C9).
  const sql = (q, ...p) => W.run(world, q, ...p);
  return { world, env, objects, sql };
}
function team(s, { ws, owner = "hum_a", name = "Synthetic team", projects = [] }) {
  if (!W.one(s.world, "SELECT 1 AS x FROM principals WHERE id = ?", owner))
    s.sql("INSERT INTO principals (id, kind, issuer, subject, label, created_at) VALUES (?, 'human', 'synthetic', ?, 'Synthetic', ?)", owner, owner, AT);
  s.sql("INSERT INTO workspaces (id, name, personal, status, plan, created_by, created_at, handle) VALUES (?, ?, 0, 'active', 'free', ?, ?, ?)", ws, name, owner, AT, ws.replace("wsp_", "t-"));
  s.sql("INSERT INTO workspace_members (workspace_id, principal_id, role, added_by, created_at) VALUES (?, ?, 'owner', ?, ?)", ws, owner, owner, AT);
  for (const p of projects) {
    const { id, slug } = typeof p === "string" ? { id: p } : p;
    s.sql("INSERT INTO projects (id, owner_id, title, created_at, workspace_id, slug) VALUES (?, ?, 'Synthetic', ?, ?, ?)", id, owner, AT, ws, slug ?? null);
  }
}
function doc(s, project, artifact, marker) {
  s.sql("INSERT INTO artifacts (id, project_id, kind, title, head_rev, head_revision_id, created_at, updated_at) VALUES (?, ?, 'markdown', ?, 1, ?, ?, ?)", artifact, project, marker, `rev_${artifact}`, AT, AT);
  s.sql("INSERT INTO revisions (id, artifact_id, project_id, rev_no, author_id, body, size, sha256, mime, created_at) VALUES (?, ?, ?, 1, 'hum_a', ?, 1, 'x', 'text/markdown', ?)", `rev_${artifact}`, artifact, project, marker, AT);
}
const ctxOf = (env, principal) => ({ env, principal: { id: principal, kind: "human", label: "Synthetic" }, requestId: "req_synthetic" });
// Ages a workspace by fixture. Never pass a future `now` to a run that goes on into purgeDueProjects: the projects would
// get a purge_at its real clock never reaches.
const aged = (s, ws, days) => s.sql("UPDATE workspaces SET status = 'deleting', deleting_at = ? WHERE id = ?", Date.now() - days * DAY, ws);
const row = (s, q, ...p) => W.one(s.world, q, ...p);
async function logs(fn) {
  const lines = [], real = { log: console.log, error: console.error };
  console.log = (...a) => lines.push(a.join(" ")); console.error = (...a) => lines.push(a.join(" "));
  try { return { result: await fn(), lines }; } finally { console.log = real.log; console.error = real.error; }
}
// The operator's undo, exactly as docs/operations.md gives it.
const UNDO = "UPDATE workspaces SET status = 'active', deleting_at = NULL WHERE id = ? AND status = 'deleting' AND purge_marked_at IS NULL";
const isMarker = (c) => c.kind === "run" && /SET purge_marked_at = \?/.test(c.q);
const isProjectMarking = (c) => c.kind === "run" && /UPDATE projects SET deleted_at = \?, deleted_by = 'system'/.test(c.q);
async function purgeUntilFinished(s, ws, max = 10) {
  for (let i = 0; i < max; i++) {
    await lib.purgeDeletingWorkspaces(s.env);
    if (row(s, "SELECT purged_at FROM workspaces WHERE id = ?", ws).purged_at) return i + 1;
    await lib.purgeDueProjects(s.env);
  }
  return 0;
}
function scanForMarker(s, m) {
  const hits = [...s.objects].filter((k) => k.includes(m)).map((k) => `r2:${k}`);
  for (const { name } of W.all(s.world, "SELECT name FROM sqlite_master WHERE type = 'table'")) {
    let rows; try { rows = W.all(s.world, `SELECT * FROM "${name}"`); } catch { continue; }
    for (const r of rows) for (const [c, v] of Object.entries(r)) if (typeof v === "string" && v.includes(m)) hits.push(`d1:${name}.${c}`);
  }
  return hits;
}
const EMPTY = { marked: 0, recovered: 0, projects_marked: 0, pending: 0, finished: 0 };

test("(a) deleteWorkspace sets deleting_at; an empty run issues exactly four statements and logs nothing", async () => {
  const s = setup();
  team(s, { ws: "wsp_a" });
  await lib.deleteWorkspace(ctxOf(s.env, "hum_a"), "wsp_a", { confirm_name: "Synthetic team" });
  const w = row(s, "SELECT status, deleting_at, purge_marked_at, purged_at FROM workspaces WHERE id = 'wsp_a'");
  assert.equal(w.status, "deleting"); assert.ok(Math.abs(w.deleting_at - Date.now()) < 60e3); assert.equal(w.purge_marked_at, null); assert.equal(w.purged_at, null);
  const t = setup();
  team(t, { ws: "wsp_b" });
  const before = t.world.calls;
  const { result, lines } = await logs(() => lib.purgeDeletingWorkspaces(t.env));
  assert.equal(t.world.calls - before, 4);
  assert.deepEqual(lines, []);
  assert.deepEqual(result, EMPTY);
});

test("(b) 29 days: untouched; 31 days: marker set, then the projects are marked deleted and due", async () => {
  const s = setup();
  team(s, { ws: "wsp_a", projects: [{ id: "prj_1", slug: "one" }] });
  await lib.deleteWorkspace(ctxOf(s.env, "hum_a"), "wsp_a", { confirm_name: "Synthetic team" });
  const t0 = row(s, "SELECT deleting_at FROM workspaces WHERE id = 'wsp_a'").deleting_at;
  await lib.purgeDeletingWorkspaces(s.env, { now: t0 + 29 * DAY });
  assert.deepEqual(row(s, "SELECT deleted_at, slug FROM projects WHERE id = 'prj_1'"), { deleted_at: null, slug: "one" });
  assert.equal(row(s, "SELECT purge_marked_at FROM workspaces WHERE id = 'wsp_a'").purge_marked_at, null);
  const now = t0 + 31 * DAY;
  const r = await lib.purgeDeletingWorkspaces(s.env, { now });
  assert.deepEqual(r, { ...EMPTY, marked: 1, projects_marked: 1, pending: 1 });
  assert.deepEqual(row(s, "SELECT deleted_at, deleted_by, purge_at, slug, deleted_slug FROM projects WHERE id = 'prj_1'"),
    { deleted_at: now, deleted_by: "system", purge_at: now, slug: null, deleted_slug: "one" });
  assert.equal(row(s, "SELECT purge_marked_at FROM workspaces WHERE id = 'wsp_a'").purge_marked_at, now);
});

test("(c) after purgeDueProjects nothing of the workspace's projects remains in D1 string cells or R2", async () => {
  // Scans every D1 string cell (including every table) and every R2 key. It does not cover BLOB
  // cells or the full-text index's internal segments (artifact_search_data), which may keep word fragments until FTS5
  // merges them (docs/workspaces.md#deleting-a-workspace).
  const s = setup();
  team(s, { ws: "wsp_a", projects: ["prj_1", "prj_2"] });
  doc(s, "prj_1", "art_1", "SYNTHETIC-PURGE-MARKER-1"); doc(s, "prj_2", "art_2", "SYNTHETIC-PURGE-MARKER-1");
  for (const k of ["blobs/prj_1/art_1/rev_1", "staging/prj_1/upl_1", "text/prj_2/art_2/rev_2", "blobs/prj_keep/x"]) s.objects.add(k);
  aged(s, "wsp_a", 31);
  assert.ok(await purgeUntilFinished(s, "wsp_a") > 0, "finished within 10 runs");
  assert.deepEqual(scanForMarker(s, "SYNTHETIC-PURGE-MARKER-1"), []);
  assert.deepEqual([...s.objects], ["blobs/prj_keep/x"]);
  for (const p of ["prj_1", "prj_2"]) { const r = row(s, "SELECT title, purged_at FROM projects WHERE id = ?", p); assert.equal(r.title, "Deleted project"); assert.ok(r.purged_at > 0); }
  assert.deepEqual(row(s, "SELECT name, handle, status FROM workspaces WHERE id = 'wsp_a'"), { name: "Synthetic team", handle: "t-a", status: "deleting" });
  assert.equal(row(s, "SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = 'wsp_a'").n, 1);
});

test("(d) a failing marker commits nothing, logs code only, and the next run marks", async () => {
  const s = setup();
  team(s, { ws: "wsp_a", projects: ["prj_1"] });
  aged(s, "wsp_a", 31);
  let once = true;
  s.world.before = async (c) => { if (once && isMarker(c)) { once = false; throw Object.assign(new Error("synthetic secret text"), { code: "SYNTH" }); } };
  const { lines } = await logs(() => lib.purgeDeletingWorkspaces(s.env));
  assert.equal(row(s, "SELECT deleted_at FROM projects WHERE id = 'prj_1'").deleted_at, null);
  assert.equal(row(s, "SELECT purge_marked_at FROM workspaces WHERE id = 'wsp_a'").purge_marked_at, null);
  assert.deepEqual(lines, ['{"event":"workspace_purge_failed","workspaceId":"wsp_a","step":"mark","code":"SYNTH"}']);
  const r = await lib.purgeDeletingWorkspaces(s.env);
  assert.equal(r.marked, 1); assert.equal(r.projects_marked, 1);
});

test("(d2) a failed project marking after the marker is completed by the same run's recovery selection", async () => {
  const s = setup();
  team(s, { ws: "wsp_a", projects: ["prj_1", "prj_2"] });
  aged(s, "wsp_a", 31);
  let once = true;
  s.world.before = async (c) => { if (once && isProjectMarking(c)) { once = false; throw Object.assign(new Error("synthetic"), { code: "SYNTH" }); } };
  const { result, lines } = await logs(() => lib.purgeDeletingWorkspaces(s.env));
  assert.deepEqual(result, { ...EMPTY, marked: 1, recovered: 1, projects_marked: 2, pending: 1 });
  assert.ok(lines.includes('{"event":"workspace_purge_failed","workspaceId":"wsp_a","step":"mark_projects","code":"SYNTH"}'), lines.join("\n"));
  assert.equal(row(s, "SELECT COUNT(*) AS n FROM projects WHERE workspace_id = 'wsp_a' AND deleted_at IS NOT NULL").n, 2);
  assert.ok(await purgeUntilFinished(s, "wsp_a") > 0);
});

test("(d3) when the recovery fails too, the projects stay unmarked, the finish waits, and the next run's recovery marks them", async () => {
  const s = setup();
  team(s, { ws: "wsp_a", projects: ["prj_1"] });
  aged(s, "wsp_a", 31);
  let fails = 2;
  s.world.before = async (c) => { if (fails && isProjectMarking(c)) { fails--; throw Object.assign(new Error("synthetic"), { code: "SYNTH" }); } };
  const { lines } = await logs(() => lib.purgeDeletingWorkspaces(s.env));
  assert.ok(lines.includes('{"event":"workspace_purge_failed","workspaceId":"wsp_a","step":"recover","code":"SYNTH"}'), lines.join("\n"));
  assert.equal(row(s, "SELECT deleted_at FROM projects WHERE id = 'prj_1'").deleted_at, null, "nothing marked yet");
  assert.equal(row(s, "SELECT purged_at FROM workspaces WHERE id = 'wsp_a'").purged_at, null, "an unmarked live project holds the finish");
  assert.deepEqual(await lib.purgeDeletingWorkspaces(s.env), { ...EMPTY, recovered: 1, projects_marked: 1, pending: 1 });
});

test("(r) recovery is not starved: an unmarked workspace behind ten older unfinished ones is still marked", async () => {
  const s = setup();
  for (let i = 0; i < 10; i++) { const ws = `wsp_o${i}`; team(s, { ws, projects: [`prj_o${i}`] }); aged(s, ws, 40 + i); }
  await lib.purgeDeletingWorkspaces(s.env);
  await lib.purgeDeletingWorkspaces(s.env);
  team(s, { ws: "wsp_new", projects: ["prj_new"] });
  aged(s, "wsp_new", 31);
  let once = true;
  s.world.before = async (c) => { if (once && isProjectMarking(c)) { once = false; throw Object.assign(new Error("synthetic"), { code: "SYNTH" }); } };
  await logs(() => lib.purgeDeletingWorkspaces(s.env));
  assert.ok(row(s, "SELECT deleted_at FROM projects WHERE id = 'prj_new'").deleted_at > 0, "marked by the recovery selection, not by the finish order");
});

test("(u) the documented undo after the marker changes no row, and the projects are still marked", async () => {
  const s = setup();
  team(s, { ws: "wsp_a", projects: ["prj_1"] });
  aged(s, "wsp_a", 31);
  let changes = null;
  s.world.before = async (c) => { if (changes === null && isProjectMarking(c)) changes = Number(s.sql(UNDO, "wsp_a").changes); };
  await lib.purgeDeletingWorkspaces(s.env);
  assert.equal(changes, 0);
  assert.equal(row(s, "SELECT status FROM workspaces WHERE id = 'wsp_a'").status, "deleting");
  assert.ok(row(s, "SELECT deleted_at FROM projects WHERE id = 'prj_1'").deleted_at > 0);
});

test("(u2) the documented undo before the marker changes one row, and no project is ever marked", async () => {
  const s = setup();
  team(s, { ws: "wsp_a", projects: ["prj_1"] });
  aged(s, "wsp_a", 31);
  let changes = null;
  s.world.before = async (c) => { if (changes === null && isMarker(c)) changes = Number(s.sql(UNDO, "wsp_a").changes); };
  const { lines } = await logs(() => lib.purgeDeletingWorkspaces(s.env));
  assert.equal(changes, 1);
  assert.deepEqual(lines, ['{"event":"workspace_purge_skipped","workspaceId":"wsp_a","reason":"no_longer_due"}']);
  s.world.before = null;
  for (let i = 0; i < 3; i++) await lib.purgeDeletingWorkspaces(s.env);
  assert.deepEqual(row(s, "SELECT status, purge_marked_at FROM workspaces WHERE id = 'wsp_a'"), { status: "active", purge_marked_at: null });
  assert.equal(row(s, "SELECT deleted_at FROM projects WHERE id = 'prj_1'").deleted_at, null);
});

test("(v) off-script: a marked workspace forced back to active and deleted again waits its full 30 days", async () => {
  // Builds a state only off-script SQL can make (the documented undo refuses a marked workspace): status forced back
  // to active with purge_marked_at left set. deleteWorkspace clears the stale marker, so the new deletion gets its 30 days.
  const s = setup();
  team(s, { ws: "wsp_a", projects: ["prj_1"] });
  aged(s, "wsp_a", 31);
  s.world.before = async (c) => { if (isProjectMarking(c)) throw Object.assign(new Error("synthetic"), { code: "SYNTH" }); };
  await logs(() => lib.purgeDeletingWorkspaces(s.env));
  s.world.before = null;
  assert.ok(row(s, "SELECT purge_marked_at FROM workspaces WHERE id = 'wsp_a'").purge_marked_at > 0);
  s.sql("UPDATE workspaces SET status = 'active' WHERE id = 'wsp_a'");
  await lib.deleteWorkspace(ctxOf(s.env, "hum_a"), "wsp_a", { confirm_name: "Synthetic team" });
  assert.deepEqual(row(s, "SELECT purge_marked_at, purged_at FROM workspaces WHERE id = 'wsp_a'"), { purge_marked_at: null, purged_at: null });
  const t0 = row(s, "SELECT deleting_at FROM workspaces WHERE id = 'wsp_a'").deleting_at;
  await lib.purgeDeletingWorkspaces(s.env);
  await lib.purgeDeletingWorkspaces(s.env, { now: t0 + 29 * DAY });
  assert.equal(row(s, "SELECT deleted_at FROM projects WHERE id = 'prj_1'").deleted_at, null);
  assert.equal(row(s, "SELECT purge_marked_at FROM workspaces WHERE id = 'wsp_a'").purge_marked_at, null);
});

test("(e) an already-deleted, already-due project keeps its deleted_by and date; a live one is marked", async () => {
  const s = setup();
  team(s, { ws: "wsp_a", projects: ["prj_live", "prj_due"] });
  const now = Date.now();
  s.sql("UPDATE projects SET deleted_at = ?, deleted_by = 'hum_a', purge_at = ?, deleted_slug = slug, slug = NULL WHERE id = 'prj_due'", now - 40 * DAY, now - 10 * DAY);
  aged(s, "wsp_a", 31);
  const r = await lib.purgeDeletingWorkspaces(s.env);
  assert.equal(r.projects_marked, 1);
  assert.deepEqual(row(s, "SELECT deleted_by, purge_at FROM projects WHERE id = 'prj_due'"), { deleted_by: "hum_a", purge_at: now - 10 * DAY });
  assert.ok(row(s, "SELECT deleted_at FROM projects WHERE id = 'prj_live'").deleted_at > 0);
});

test("(f) six due workspaces, every marker failing: at most five attempts per run; all six marked within two runs once the failures stop", async () => {
  const s = setup();
  for (let i = 1; i <= 6; i++) { team(s, { ws: `wsp_${i}`, projects: [`prj_${i}`] }); aged(s, `wsp_${i}`, 31 + i); }
  const SIX = "('wsp_1','wsp_2','wsp_3','wsp_4','wsp_5','wsp_6')";
  let attempts = 0, failing = true;
  s.world.before = async (c) => { if (isMarker(c)) { attempts++; if (failing) throw Object.assign(new Error("synthetic"), { code: "SYNTH" }); } };
  const { lines } = await logs(() => lib.purgeDeletingWorkspaces(s.env));
  assert.equal(attempts, 5);
  assert.equal(lines.filter((l) => /"event":"workspace_purge_failed"/.test(l)).length, 5);
  assert.equal(row(s, `SELECT COUNT(*) AS n FROM workspaces WHERE id IN ${SIX} AND purge_marked_at IS NOT NULL`).n, 0);
  failing = false;
  const a = await lib.purgeDeletingWorkspaces(s.env), b = await lib.purgeDeletingWorkspaces(s.env);
  assert.deepEqual([a.marked, b.marked], [5, 1]);
  assert.equal(row(s, `SELECT COUNT(*) AS n FROM workspaces WHERE id IN ${SIX} AND purge_marked_at IS NOT NULL`).n, 6);
});

test("(g) the selection never picks a personal or an active workspace", async () => {
  const s = setup();
  team(s, { ws: "wsp_a", projects: ["prj_a"] });
  // prj_legacy has workspace_id NULL (it belongs to hum_a's personal workspace). It is excluded by `workspace_id = ?`
  // (NULL never matches), not by the personal guard.
  s.sql("INSERT INTO projects (id, owner_id, title, created_at) VALUES ('prj_legacy', 'hum_a', 'Synthetic', ?)", AT);
  // The one unreachable state of this kind, built on purpose: a personal workspace marked deleting. Production refuses
  // to write it (workspaces.js deleteWorkspace). This shows the selection never picks a personal workspace; the
  // marker's own `personal = 0` is defence in depth and is not separately tested.
  s.sql("UPDATE workspaces SET status = 'deleting', deleting_at = ? WHERE id = 'wsp_hum_a'", Date.now() - 40 * DAY);
  const r = await lib.purgeDeletingWorkspaces(s.env);
  assert.deepEqual(r, EMPTY);
  for (const p of ["prj_a", "prj_legacy"]) assert.equal(row(s, "SELECT deleted_at FROM projects WHERE id = ?", p).deleted_at, null);
  assert.equal(row(s, "SELECT purge_marked_at FROM workspaces WHERE id = 'wsp_hum_a'").purge_marked_at, null);
});

test("(h) a run whose first statement fails resolves and logs step run with no message", async () => {
  const fail = () => { throw new Error("synthetic secret text"); };
  const { result, lines } = await logs(() => lib.purgeDeletingWorkspaces({ DB: { prepare: fail, batch: fail } }));
  assert.deepEqual(result, EMPTY);
  assert.deepEqual(lines, ['{"event":"workspace_purge_failed","step":"run","code":"Error"}']);
});

test("(i) the legacy fill stamps at most 100 rows per run and starts their 30 days then", async () => {
  const s = setup();
  for (let i = 0; i <= 100; i++) team(s, { ws: `wsp_l${String(i).padStart(3, "0")}` });
  s.sql("UPDATE workspaces SET status = 'deleting' WHERE id LIKE 'wsp_l%'");
  const T = Date.now();
  await lib.purgeDeletingWorkspaces(s.env, { now: T });
  assert.equal(row(s, "SELECT COUNT(*) AS n FROM workspaces WHERE id LIKE 'wsp_l%' AND deleting_at = ?", T).n, 100);
  assert.equal(row(s, "SELECT COUNT(*) AS n FROM workspaces WHERE id LIKE 'wsp_l%' AND deleting_at IS NULL").n, 1);
  assert.equal(row(s, "SELECT COUNT(*) AS n FROM workspaces WHERE id LIKE 'wsp_l%' AND purge_marked_at IS NOT NULL").n, 0);
  await lib.purgeDeletingWorkspaces(s.env, { now: T + 1000 });
  assert.equal(row(s, "SELECT COUNT(*) AS n FROM workspaces WHERE id LIKE 'wsp_l%' AND deleting_at = ?", T + 1000).n, 1);
  assert.equal(row(s, "SELECT COUNT(*) AS n FROM workspaces WHERE id LIKE 'wsp_l%' AND deleting_at = ?", T).n, 100);
});

test("(z) a workspace with no projects is marked and finished in the same run", async () => {
  const s = setup();
  team(s, { ws: "wsp_a" });
  aged(s, "wsp_a", 31);
  assert.deepEqual(await lib.purgeDeletingWorkspaces(s.env), { ...EMPTY, marked: 1, finished: 1 });
});

test("(m) seven projects: the finish waits while some are unpurged, then succeeds", async () => {
  const s = setup();
  team(s, { ws: "wsp_a", projects: Array.from({ length: 7 }, (_, i) => `prj_${i}`) });
  aged(s, "wsp_a", 31);
  await lib.purgeDeletingWorkspaces(s.env);
  assert.equal((await lib.purgeDueProjects(s.env)).projects, 5, "purgeDueProjects' own per-run limit");
  const r = await lib.purgeDeletingWorkspaces(s.env);
  assert.deepEqual([r.finished, r.pending, r.recovered], [0, 1, 0]);
  assert.equal(row(s, "SELECT purged_at FROM workspaces WHERE id = 'wsp_a'").purged_at, null);
  await lib.purgeDueProjects(s.env);
  assert.equal((await lib.purgeDeletingWorkspaces(s.env)).finished, 1);
  assert.equal(row(s, "SELECT COUNT(*) AS n FROM projects WHERE workspace_id = 'wsp_a' AND purged_at IS NULL").n, 0);
});

test("(s) a suspended workspace deleted by its owner is purged like an active one", async () => {
  const s = setup();
  team(s, { ws: "wsp_a", projects: ["prj_1"] });
  s.sql("UPDATE workspaces SET status = 'suspended' WHERE id = 'wsp_a'");
  await lib.deleteWorkspace(ctxOf(s.env, "hum_a"), "wsp_a", { confirm_name: "Synthetic team" });
  s.sql("UPDATE workspaces SET deleting_at = deleting_at - ? WHERE id = 'wsp_a'", 31 * DAY);
  assert.ok(await purgeUntilFinished(s, "wsp_a") > 0);
});

test("(q) D1 calls per run: 14 in the steady state with ten pending, 29 at most", async () => {
  const s = setup();
  for (let i = 0; i < 10; i++) { const ws = `wsp_p${i}`; team(s, { ws, projects: [`prj_p${i}`] }); aged(s, ws, 40 + i); }
  await lib.purgeDeletingWorkspaces(s.env);
  await lib.purgeDeletingWorkspaces(s.env);
  let before = s.world.calls;
  assert.deepEqual(await lib.purgeDeletingWorkspaces(s.env), { ...EMPTY, pending: 10 });
  assert.equal(s.world.calls - before, 14, "steady state: fill, selection 1, recovery selection, selection 2, 10 finishes");
  // Worst case: 5 due workspaces whose project marking fails, so the recovery selection also returns 5.
  for (let i = 0; i < 5; i++) { const ws = `wsp_n${i}`; team(s, { ws, projects: [`prj_n${i}`] }); aged(s, ws, 31); }
  s.world.before = async (c) => { if (isProjectMarking(c)) throw Object.assign(new Error("synthetic"), { code: "SYNTH" }); };
  before = s.world.calls;
  await logs(() => lib.purgeDeletingWorkspaces(s.env));
  assert.equal(s.world.calls - before, 29);
});

test("(p) the purge's selections and the project marking use migration 0032's partial indexes", async () => {
  const s = setup();
  team(s, { ws: "wsp_a", projects: ["prj_1"] });
  aged(s, "wsp_a", 31);
  await lib.purgeDeletingWorkspaces(s.env);
  const seen = new Map();
  for (const e of s.world.log) if ((e.kind === "all" || e.kind === "run") && e.q && !seen.has(e.q)) seen.set(e.q, e);
  const issued = [...seen.values()];
  const plan = (e) => W.all(s.world, "EXPLAIN QUERY PLAN " + e.q, ...Array(e.params).fill(1)).map((r) => r.detail).join(" | ");
  const pick = (re) => {
    const hits = issued.filter((e) => re.test(e.q.trim()));
    assert.equal(hits.length, 1, `exactly one issued statement matches ${re}`);
    return plan(hits[0]);
  };
  const fill = pick(/^UPDATE workspaces SET deleting_at = \?/);
  assert.match(fill, /workspaces_purge_due/);
  const sel1 = pick(/^SELECT id FROM workspaces WHERE status = 'deleting' AND purge_marked_at IS NULL/);
  assert.match(sel1, /workspaces_purge_due/); assert.doesNotMatch(sel1, /TEMP B-TREE/);
  const recovery = pick(/^SELECT w\.id FROM workspaces w/);
  assert.match(recovery, /workspaces_purge_pending/); assert.match(recovery, /projects_live/); assert.doesNotMatch(recovery, /TEMP B-TREE/);
  const sel2 = pick(/^SELECT id FROM workspaces WHERE status = 'deleting' AND purge_marked_at IS NOT NULL/);
  assert.match(sel2, /workspaces_purge_pending/); assert.doesNotMatch(sel2, /TEMP B-TREE/);
  const marking = pick(/^UPDATE projects SET deleted_at = \?, deleted_by = 'system'/);
  assert.match(marking, /projects_live/);
});

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === "node_modules" ? [] : sourceFiles(p);
    return /\.(m?js|txt)$/.test(n) ? [p] : [];
  });
}
test("(j) the cron calls purgeDeletingWorkspaces(env) and nothing else calls it; WORKSPACE_PURGE_GRACE_DAYS is 30", () => {
  const calls = sourceFiles(join(ROOT, "packages")).filter((f) => !f.endsWith("workspace-purge.js"))
    .flatMap((f) => (readFileSync(f, "utf8").match(/purgeDeletingWorkspaces\([^)]*\)/g) ?? []).map((c) => `${relative(ROOT, f)}: ${c}`));
  assert.deepEqual(calls, ["packages/core/src/index.js: purgeDeletingWorkspaces(env)"]);
  assert.equal(lib.WORKSPACE_PURGE_GRACE_DAYS, 30);
});

test("(k) the delete-workspace dialog states the grace period", () => {
  const app = readFileSync(join(ROOT, "packages/core/src/web/app.js.txt"), "utf8");
  assert.ok(app.includes(`Export any project you need first (project backup). Its documents and files start being deleted after ${lib.WORKSPACE_PURGE_GRACE_DAYS} days; this can't be undone from the app.`));
});

test("(x) deleteWorkspace requires the workspace's name: missing, wrong, padded, renamed; earlier checks come first", async () => {
  const s = setup();
  team(s, { ws: "wsp_a", name: "Synthetic team" });
  s.sql("INSERT INTO principals (id, kind, issuer, subject, label, created_at) VALUES ('hum_m', 'human', 'synthetic', 'hum_m', 'Synthetic', ?)", AT);
  s.sql("INSERT INTO principals (id, kind, issuer, subject, label, created_at) VALUES ('hum_o', 'human', 'synthetic', 'hum_o', 'Synthetic', ?)", AT);
  s.sql("INSERT INTO workspace_members (workspace_id, principal_id, role, added_by, created_at) VALUES ('wsp_a', 'hum_m', 'admin', 'hum_a', ?)", AT);
  const del = (input, who = "hum_a", ws = "wsp_a") => lib.deleteWorkspace(ctxOf(s.env, who), ws, input);
  for (const input of [undefined, null, [], {}, { confirm_name: "synthetic team" }, { confirm_name: 3 }, { confirm_name: "   " }])
    await assert.rejects(del(input), (e) => e.status === 400 && e.code === "confirmation_required" && e.message === "Type the workspace's name to confirm");
  await assert.rejects(del({ confirm_name: "Synthetic team" }, "hum_m"), (e) => e.status === 403);
  await assert.rejects(del({ confirm_name: "Personal" }, "hum_a", "wsp_hum_a"), (e) => e.status === 409);
  await assert.rejects(del({ confirm_name: "Synthetic team" }, "hum_o"), (e) => e.status === 404);
  assert.equal(row(s, "SELECT status FROM workspaces WHERE id = 'wsp_a'").status, "active");
  s.sql("UPDATE workspaces SET name = 'Renamed team' WHERE id = 'wsp_a'");
  await assert.rejects(del({ confirm_name: "Synthetic team" }), (e) => e.code === "confirmation_required");
  assert.deepEqual(await del({ confirm_name: "  Renamed team " }), { ok: true, status: "deleting" });
});
