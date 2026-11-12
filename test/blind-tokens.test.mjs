// Blind-index search tokens (slice 4a), lifecycle deletes: the project-purge step in purgeDueProjects and the cron
// orphan sweep (search/tokens.js sweepSearchTokenOrphans). Exact call and row counts run on the real code over
// node:sqlite with every migration (test/load-worker.mjs, test/blind-tokens-world.mjs); the cron end to end, query
// plans and timing run against a local `wrangler dev` (port SERVER_PORTS["blind-tokens"]), with documents seeded
// through SQL. Synthetic data only; every INSERT names its columns.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadWorker } from "./load-worker.mjs";
import { startServer, LOCAL_CONFIG, ROOT } from "./helpers.mjs";
import { SERVER_PORTS } from "./ports.mjs";
import * as W from "./blind-tokens-world.mjs";

const lib = await loadWorker({
  "project-deletion.js": ["purgeDueProjects"],
  "search/tokens.js": ["sweepSearchTokenOrphans", "indexSearchJobs", "sweepReadSql", "SEARCH_SQL", "lifecycleStatements", "PURGE_ELIGIBLE", "stableReadSql", "named", "PURGE_SELECT_SQL"],
  "adapters.js": ["withAdapters", "resolveAdapters"],
});
const AT = "2026-11-11T00:00:00.000Z";
/** Text jobs carry their stored UTF-8 size (textBytes is required: admission never scans the text). */
const withBytes = (j) => typeof j.text === "string" && j.textBytes === undefined ? { ...j, textBytes: Buffer.byteLength(j.text) } : j;
const indexJobs = (env, jobs, opts) => lib.indexSearchJobs(env, jobs.map(withBytes), opts);
const QUARTER = 900000;
const quiet = async (fn) => {
  const { log, error } = console, out = [];
  const grab = (...a) => { try { out.push(JSON.parse(a[0])); } catch { /* not JSON */ } };
  console.log = grab; console.error = grab;
  try { return { result: await fn(), events: out }; } finally { console.log = log; console.error = error; }
};
const envOf = (world, vars = {}) => lib.withAdapters({ DB: world.DB, BLOBS: { async delete() {}, async list() { return { objects: [] }; } }, ...vars }, lib.resolveAdapters({}));
const assertExact = (world) => assert.deepEqual(W.counters(world), W.expectedCounters(world));
/** Rows that claim a revision hold exactly term_count tokens. */
function assertClaims(world) {
  for (const r of W.all(world, "SELECT d.artifact_id, d.term_count, (SELECT COUNT(*) FROM search_tokens s WHERE s.doc_id = d.doc_id) AS n FROM search_token_docs d WHERE revision_id <> ''"))
    assert.equal(r.n, r.term_count, `${r.artifact_id} claims a revision with ${r.n} tokens`);
}
/**
 * Seed token rows straight through SQL (as an earlier writer left them): `docs` complete rows of `tokens` tokens each
 * in `project`, counted exactly. Token values are distinct per document.
 */
let seedSeq = 0;
function seedTokens(world, { project, workspace, owner, docs, tokens, artifacts = true, complete = true }) {
  const ids = [];
  for (let i = 0; i < docs; i++) {
    const a = `t${++seedSeq}`;
    if (artifacts) W.seedDoc(world, { project, artifact: a });
    W.run(world, `INSERT INTO search_token_docs (artifact_id, project_id, workspace_id, owner_id, revision_id, key_id, token_digest, writer, gen, term_count, truncated, truncated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, 'sk_seed', '', '', 1, ?, 0, '', 1)`, a, project, workspace, owner, complete ? `rev_${a}` : "", complete ? tokens : 0);
    const d = W.one(world, "SELECT doc_id FROM search_token_docs WHERE artifact_id = ?", a).doc_id;
    if (tokens) W.run(world, `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
      INSERT INTO search_tokens (doc_id, token) SELECT ?, unhex(printf('%016x%016x', ?, i)) FROM n`, tokens, d, d);
    ids.push(a);
  }
  const units = docs * (5 + tokens);
  for (const scope of [`w:${workspace}`, `o:${owner}`, "i"])
    W.run(world, "INSERT INTO search_term_counters (scope, terms) VALUES (?, ?) ON CONFLICT (scope) DO UPDATE SET terms = terms + excluded.terms", scope, units);
  return ids;
}
const project = (world, id, { workspace = "wsp_a", owner = "hum_a", due = false, purged = false } = {}) =>
  W.run(world, "INSERT INTO projects (id, owner_id, title, created_at, workspace_id, deleted_at, purge_at, purged_at) VALUES (?, ?, 'Synthetic', ?, ?, ?, ?, ?)",
    id, owner, AT, workspace, due || purged ? 1 : null, due || purged ? 1 : null, purged ? 2 : null);
function world0() {
  const world = W.mkWorld();
  W.seedWorkspace(world);
  return world;
}
const docCount = (world, pid) => W.one(world, "SELECT COUNT(*) AS n FROM search_token_docs WHERE project_id = ?", pid).n;
const purgedAt = (world, pid) => W.one(world, "SELECT purged_at FROM projects WHERE id = ?", pid).purged_at;

// --- Test 14: the project-purge step -------------------------------------------------------------------------------
test("test 14: the purge removes a project's token rows before STEPS over several runs, charging rowBudget, counters exact", async () => {
  const world = world0();
  project(world, "p_due", { due: true });
  seedTokens(world, { project: "p_due", workspace: "wsp_a", owner: "hum_a", docs: 3, tokens: 20 });
  const other = seedTokens(world, { project: "proj_a", workspace: "wsp_a", owner: "hum_a", docs: 1, tokens: 4 });
  const start = W.counters(world);
  let runs = 0, out;
  do {
    const before = W.counters(world).i, rowsBefore = W.one(world, "SELECT (SELECT COUNT(*) FROM search_tokens) + (SELECT COUNT(*) FROM search_token_docs) AS n").n;
    out = (await quiet(() => lib.purgeDueProjects(envOf(world), { projectId: "p_due", rowBudget: 25 }))).result;
    runs++;
    const removed = rowsBefore - W.one(world, "SELECT (SELECT COUNT(*) FROM search_tokens) + (SELECT COUNT(*) FROM search_token_docs) AS n").n;
    assertExact(world);
    assert.ok(out.rows <= 25 + 20, `a run overruns its budget by at most 20 document rows (${out.rows})`);
    if (docCount(world, "p_due")) {
      assert.equal(purgedAt(world, "p_due"), null, "not marked purged while token rows remain");
      assert.equal(W.one(world, "SELECT COUNT(*) AS n FROM artifacts WHERE project_id = 'p_due'").n, 3, "STEPS wait for the token rows");
      assert.equal(out.rows, removed, "rows charged = token and document rows deleted");
      assert.ok(W.counters(world).i < before);
    }
  } while (!out.projects && runs < 20);
  assert.ok(runs >= 3, `${runs} runs`);
  assert.equal(out.projects, 1);
  assert.ok(purgedAt(world, "p_due") > 0);
  assert.equal(docCount(world, "p_due"), 0);
  assert.deepEqual(W.counters(world), { "w:wsp_a": start["w:wsp_a"] - 75, "o:hum_a": start["o:hum_a"] - 75, i: start.i - 75 });
  assert.equal(W.docRow(world, other[0]).revision_id, `rev_${other[0]}`, "another project's rows untouched");
});

test("test 14 (i): restored between two rounds: the next round's stillDue ends the purge; no selection, no STEPS, not purged", async () => {
  const world = world0();
  project(world, "p_r", { due: true });
  seedTokens(world, { project: "p_r", workspace: "wsp_a", owner: "hum_a", docs: 25, tokens: 1 });
  let restoredAt = null;
  world.after = ({ kind, qs }) => {
    if (kind === "batch" && !restoredAt && qs.some((q) => /DELETE FROM search_tokens/.test(q))) {
      W.run(world, "UPDATE projects SET deleted_at = NULL, purge_at = NULL WHERE id = 'p_r'");
      restoredAt = world.calls;
    }
  };
  await quiet(() => lib.purgeDueProjects(envOf(world), { projectId: "p_r" }));
  world.after = null;
  const later = world.log.slice(restoredAt);
  assert.equal(later.length, 1, "only the stillDue read after the restore");
  assert.match(later[0].q, /SELECT 1 AS ok WHERE EXISTS/);
  assert.equal(docCount(world, "p_r"), 5);
  assert.equal(purgedAt(world, "p_r"), null);
  assert.equal(W.one(world, "SELECT COUNT(*) AS n FROM artifacts WHERE project_id = 'p_r'").n, 25, "STEPS did not run");
  assertExact(world);
});

test("test 14 (ii): restored after the check and before the batch: the round deletes nothing, the step ends and the run moves on", async () => {
  const world = world0();
  project(world, "p_a", { due: true });
  project(world, "p_b", { due: true });
  W.run(world, "UPDATE projects SET purge_at = 0 WHERE id = 'p_a'");
  seedTokens(world, { project: "p_a", workspace: "wsp_a", owner: "hum_a", docs: 3, tokens: 2 });
  seedTokens(world, { project: "p_b", workspace: "wsp_a", owner: "hum_a", docs: 2, tokens: 2 });
  let hooked = false;
  world.before = ({ kind, qs }) => {
    if (kind === "batch" && !hooked && qs.some((q) => /DELETE FROM search_tokens/.test(q))) { hooked = true; W.run(world, "UPDATE projects SET deleted_at = NULL, purge_at = NULL WHERE id = 'p_a'"); }
  };
  const { result } = await quiet(() => lib.purgeDueProjects(envOf(world)));
  world.before = null;
  const selections = world.log.filter((c) => c.kind === "all" && /FROM search_token_docs d WHERE d\.project_id = \?1/.test(c.q));
  assert.equal(selections.length, 3, "p_a selected once; p_b twice (its rows, then none)");
  assert.equal(docCount(world, "p_a"), 3, "nothing of p_a deleted");
  assert.ok(W.all(world, "SELECT writer FROM search_token_docs WHERE project_id = 'p_a'").every((r) => r.writer === ""), "no lease taken");
  assert.equal(purgedAt(world, "p_a"), null);
  assert.deepEqual(result.finished, ["p_b"], "the run went on to the next due project");
  assert.equal(docCount(world, "p_b"), 0);
  assertExact(world);
});

test("test 14 (iii): the cron and the immediate purge at once both end, counters exact, the project purged exactly once", async () => {
  const world = world0();
  project(world, "p_c", { due: true });
  seedTokens(world, { project: "p_c", workspace: "wsp_a", owner: "hum_a", docs: 30, tokens: 30 });
  const start = W.counters(world).i;
  for (let i = 0; i < 40 && !purgedAt(world, "p_c"); i++) {
    const [a, b] = await Promise.all([
      quiet(() => lib.purgeDueProjects(envOf(world), { rowBudget: 200, scheduledTime: i * QUARTER })),
      quiet(() => lib.purgeDueProjects(envOf(world), { projectId: "p_c", rowBudget: 150 }))]);
    assert.ok(a.result && b.result, "both end");
    assertExact(world);
  }
  assert.ok(purgedAt(world, "p_c") > 0);
  assert.equal(W.one(world, "SELECT COUNT(*) AS n FROM audits WHERE action = 'project.purge' AND project_id = 'p_c'").n, 1, "marked purged once");
  assert.equal(W.counters(world).i ?? 0, start - 30 * 35);
});

test("test 14: a project restored between rounds keeps its remaining rows, which are listed missing and re-indexed by the next writer", async () => {
  const world = world0();
  project(world, "p_s", { due: true });
  W.seedDoc(world, { project: "p_s", artifact: "keep_1" });
  const env = envOf(world);
  W.run(world, "UPDATE projects SET deleted_at = NULL, purge_at = NULL WHERE id = 'p_s'");
  await quiet(() => indexJobs(env, [{ artifactId: "keep_1", projectId: "p_s", revisionId: "rev_keep_1", text: "one two three four five six" }]));
  W.run(world, "UPDATE projects SET deleted_at = 1, purge_at = 1 WHERE id = 'p_s'");
  assert.ok(!W.missing(world).includes("keep_1"), "a soft-deleted project's documents are not missing");
  // One round with a tiny budget: the purge leases the row and deletes 2 tokens.
  await quiet(() => lib.purgeDueProjects(env, { projectId: "p_s", rowBudget: 2 }));
  assert.equal(W.docRow(world, "keep_1").revision_id, "");
  W.run(world, "UPDATE projects SET deleted_at = NULL, purge_at = NULL WHERE id = 'p_s'");
  assert.ok(W.missing(world).includes("keep_1"), "back after the restore, listed missing");
  const { result } = await quiet(() => indexJobs(env, [{ artifactId: "keep_1", projectId: "p_s", revisionId: "rev_keep_1", text: "one two three four five six" }]));
  assert.equal(result.completed, 1);
  assert.equal(W.tokensOf(world, "keep_1").length, 6);
  assert.ok(!W.missing(world).includes("keep_1"));
  assertExact(world); assertClaims(world);
});

test("test 14: counters return to their start after the purge and sweep path C delete every row of a new workspace", async () => {
  const world = world0();
  W.seedWorkspace(world, { principal: "hum_n", workspace: "wsp_n", project: "proj_n1" });
  project(world, "proj_n2", { workspace: "wsp_n", owner: "hum_n" });
  const start = W.counters(world);
  const env = envOf(world);
  const jobs = [];
  for (const [p, n] of [["proj_n1", 3], ["proj_n2", 3]]) for (let i = 0; i < n; i++) {
    const a = `${p}_d${i}`;
    W.seedDoc(world, { project: p, artifact: a });
    jobs.push({ artifactId: a, projectId: p, revisionId: `rev_${a}`, text: `alpha beta ${a} gamma${i}` });
  }
  assert.equal((await quiet(() => indexJobs(env, jobs))).result.completed, 6);
  assert.notDeepEqual(W.counters(world), start);
  W.run(world, "UPDATE projects SET deleted_at = 1, purge_at = 1 WHERE id = 'proj_n1'");
  for (let i = 0; i < 5 && !purgedAt(world, "proj_n1"); i++) await quiet(() => lib.purgeDueProjects(env, { projectId: "proj_n1" }));
  assert.ok(purgedAt(world, "proj_n1"));
  W.run(world, "UPDATE workspaces SET status = 'deleting' WHERE id = 'wsp_n'");
  for (let i = 0; i < 3; i++) await quiet(() => lib.sweepSearchTokenOrphans(env, { scheduledTime: i * QUARTER }));
  assert.equal(W.one(world, "SELECT COUNT(*) AS n FROM search_token_docs WHERE workspace_id = 'wsp_n'").n, 0);
  assert.deepEqual(W.counters(world), start);
  assertExact(world);
});

test("test 14: multi-batch path C cleanup of 3 documents × 20,000 tokens stays within each run's budget; a writer mid-cleanup changes nothing", async () => {
  const world = world0();
  W.seedWorkspace(world, { principal: "hum_c", workspace: "wsp_c", project: "proj_c" });
  const ids = seedTokens(world, { project: "proj_c", workspace: "wsp_c", owner: "hum_c", docs: 3, tokens: 20000 });
  W.run(world, "UPDATE workspaces SET status = 'deleting' WHERE id = 'wsp_c'");
  const env = envOf(world, { SEARCH_SWEEP_WRITES_MAX: "10000" });
  let runs = 0;
  while (W.one(world, "SELECT COUNT(*) AS n FROM search_token_docs WHERE workspace_id = 'wsp_c'").n && runs < 20) {
    const before = W.counters(world)["w:wsp_c"];
    const t = (await quiet(() => lib.sweepSearchTokenOrphans(env, { scheduledTime: runs * QUARTER }))).result;
    runs++;
    assert.ok(t.calls <= 10 && t.rows <= 10000, JSON.stringify(t));
    assert.equal(before - (W.counters(world)["w:wsp_c"] ?? 0), t.tokens + 5 * t.docs, "counters drop by exactly what was deleted");
    assertExact(world);
    // A writer tries mid-cleanup: $LIVE fails for a deleting workspace, so it writes nothing.
    const w = (await quiet(() => indexJobs(env, [{ artifactId: ids[0], projectId: "proj_c", revisionId: `rev_${ids[0]}`, text: "alpha" }]))).result;
    assert.equal(w.completed, 0);
    assertClaims(world);
  }
  assert.ok(runs >= 6, `${runs} runs for 60,000 tokens`);
  assert.equal(W.counters(world)["w:wsp_c"] ?? 0, 0);
});

// --- Test 24: sweep progress, packing and writes --------------------------------------------------------------------
/** n healthy rows (live artifacts) with 1 token each, seeded in one statement each. */
function seedHealthy(world, n) { return seedTokens(world, { project: "proj_a", workspace: "wsp_a", owner: "hum_a", docs: n, tokens: 1 }); }
const sweep = async (world, opts = {}, vars = {}) => (await quiet(() => lib.sweepSearchTokenOrphans(envOf(world, vars), opts))).result;
const stateRow = (world) => W.one(world, "SELECT sweep_doc_after, sweep_purged_after, sweep_workspace_after FROM search_tokens_state WHERE id = 1");

test("test 24: an empty installation: one read call, no rows written, no cursor write", async () => {
  const world = world0();
  const before = W.one(world, "SELECT total_changes() AS n").n;
  const t = await sweep(world, { scheduledTime: 0 });
  assert.equal(t.calls, 1);
  assert.equal(t.cursor, false);
  assert.equal(W.one(world, "SELECT total_changes() AS n").n, before);
  assert.equal(world.calls, 1);
});

test("test 24: a healthy 1,000-candidate window advances in 2 calls; an orphan in the next window is found on the next run", async () => {
  const world = world0();
  const ids = seedHealthy(world, 1001);
  W.run(world, "DELETE FROM artifacts WHERE id = ?", ids[1000]);
  const t1 = await sweep(world, { scheduledTime: 2 * QUARTER });
  assert.equal(t1.calls, 2, JSON.stringify(t1));
  assert.equal(t1.docs, 0);
  assert.equal(stateRow(world).sweep_doc_after, W.docRow(world, ids[999]).doc_id);
  const t2 = await sweep(world, { scheduledTime: 3 * QUARTER });
  assert.equal(t2.docs, 1);
  assert.equal(W.docRow(world, ids[1000]), undefined);
  assert.equal(stateRow(world).sweep_doc_after, 0, "a short window wraps");
  assertExact(world);
});

test("test 24: 60 small documents in 3 packed calls; 160 empty documents in one run within 1,280 rows", async () => {
  const world = world0();
  project(world, "p_gone", { purged: true });
  seedTokens(world, { project: "p_gone", workspace: "wsp_a", owner: "hum_a", docs: 60, tokens: 2, artifacts: false });
  const t = await sweep(world, { scheduledTime: 0 });
  assert.equal(t.paths.find((p) => p.path === "A").calls, 3);
  assert.equal(t.docs, 60);
  assertExact(world);
  project(world, "p_empty", { purged: true });
  seedTokens(world, { project: "p_empty", workspace: "wsp_a", owner: "hum_a", docs: 160, tokens: 0, artifacts: false });
  const e = await sweep(world, { scheduledTime: 0 });
  assert.equal(e.docs, 160);
  assert.ok(e.rows - (e.cursor ? 2 : 0) <= 1280, JSON.stringify(e));
  assert.ok(e.calls <= 10);
  assertExact(world);
});

test("test 24: shares: with all three paths busy each gets at least 2 calls, at most 10 per run; rotation follows scheduledTime", async () => {
  const firsts = [];
  for (const [q, skipCursor] of [[0, false], [1, false], [2, false], [0, true], [1, true], [2, true]]) {
    const world = world0();
    project(world, "p_gone", { purged: true });
    seedTokens(world, { project: "p_gone", workspace: "wsp_a", owner: "hum_a", docs: 100, tokens: 1, artifacts: false });
    W.seedWorkspace(world, { principal: "hum_d", workspace: "wsp_d", project: "proj_d", status: "deleting" });
    seedTokens(world, { project: "proj_d", workspace: "wsp_d", owner: "hum_d", docs: 100, tokens: 1 });
    seedTokens(world, { project: "proj_a", workspace: "wsp_a", owner: "hum_a", docs: 100, tokens: 1, artifacts: false });
    if (skipCursor) { const prep = world.DB.prepare; world.DB.prepare = (q) => prep(/UPDATE search_tokens_state/.test(q) ? "SELECT ?1, ?2, ?3" : q); }
    const t = await sweep(world, { scheduledTime: 1767225600000 + q * QUARTER + 1234 });
    assert.ok(t.calls <= 10, JSON.stringify(t));
    assert.equal(t.paths.length, 3);
    for (const p of t.paths) assert.ok(p.calls >= 2, JSON.stringify(t.paths));
    firsts.push(t.paths[0].path);
    assertExact(world);
  }
  const base = Math.floor(1767225600000 / QUARTER) % 3;
  const expected = [0, 1, 2].map((q) => [["A", "C", "B"], ["C", "B", "A"], ["B", "A", "C"]][(base + q) % 3][0]);
  assert.deepEqual(firsts, [...expected, ...expected], "A, C, B in turn; the same with every cursor write skipped");
  assert.deepEqual(new Set(expected), new Set(["A", "B", "C"]));
});

test("test 24: write budgets: 250 bounds the admitted cost; 0 is off; 20 behaves as 50; 15 rows delete one token", async () => {
  const mk = () => { const world = world0(); project(world, "p_gone", { purged: true }); seedTokens(world, { project: "p_gone", workspace: "wsp_a", owner: "hum_a", docs: 40, tokens: 50, artifacts: false }); return world; };
  let world = mk();
  let before = W.counters(world).i;
  const t = await sweep(world, { scheduledTime: 0 }, { SEARCH_SWEEP_WRITES_MAX: "250" });
  assert.ok(t.rows <= 250, JSON.stringify(t));
  assert.equal(before - W.counters(world).i, t.tokens + 5 * t.docs);
  // Rows written: 2 per token (table and index) + at most 11 per document touched (L 1, Kc 3, X 4, Xc 3) + cursor 2.
  const touched = W.one(world, "SELECT COUNT(*) AS n FROM search_token_docs WHERE writer LIKE 'purge:%'").n + t.docs;
  assert.ok(2 * t.tokens + 11 * touched + (t.cursor ? 2 : 0) <= 250);
  world = mk();
  const off = await sweep(world, { scheduledTime: 0 }, { SEARCH_SWEEP_WRITES_MAX: "0" });
  assert.deepEqual([off.calls, world.calls], [0, 0]);
  world = mk();
  const twenty = await sweep(world, { scheduledTime: 0 }, { SEARCH_SWEEP_WRITES_MAX: "20" });
  assert.ok(twenty.rows > 20 && twenty.rows <= 50, JSON.stringify(twenty));
  world = mk();
  before = W.counters(world).i;
  const fifteen = await sweep(world, { scheduledTime: 0, writes: 15 });
  assert.equal(fifteen.tokens, 1);
  assert.equal(before - W.counters(world).i, 1);
});

test("test 24: a document that does not fit ends only its own path's turn", async () => {
  const world = world0();
  project(world, "p_gone", { purged: true });
  seedTokens(world, { project: "p_gone", workspace: "wsp_a", owner: "hum_a", docs: 2, tokens: 50, artifacts: false });
  W.seedWorkspace(world, { principal: "hum_d", workspace: "wsp_d", project: "proj_d", status: "deleting" });
  seedTokens(world, { project: "proj_d", workspace: "wsp_d", owner: "hum_d", docs: 2, tokens: 50 });
  // 30 rows: 28 after the cursor; A first (quarter 0) gets 14 → 1 token; C then 14 → 1 token. At 26 A gets 12 → none.
  const t = await sweep(world, { scheduledTime: 0, writes: 26 });
  const a = t.paths.find((p) => p.path === "A"), c = t.paths.find((p) => p.path === "C");
  assert.equal(t.paths[0].path, "A");
  assert.equal(a.calls, 0, "A's document did not fit its share");
  assert.equal(c.calls, 1, "C still ran with the share A did not use");
  assert.equal(t.tokens, Math.floor((24 - 11) / 2));
  assertExact(world);
});

test("test 24: a direct call with projectId runs no sweep; the cron call does", async () => {
  const world = world0();
  await quiet(() => lib.purgeDueProjects(envOf(world), { projectId: "proj_a" }));
  assert.ok(!world.log.some((c) => (c.q ?? c.qs.join(";")).includes("search_tokens_state")));
  await quiet(() => lib.purgeDueProjects(envOf(world), { scheduledTime: 0 }));
  assert.ok(world.log.some((c) => (c.q ?? c.qs.join(";")).includes("search_tokens_state")));
});

test("test 20 (sweep part): the previous Worker's purge leaves token rows; sweep path A removes them and credits exactly", async () => {
  const world = world0();
  project(world, "p_prev", { due: true });
  seedTokens(world, { project: "p_prev", workspace: "wsp_a", owner: "hum_a", docs: 4, tokens: 7 });
  const start = W.counters(world).i;
  // The previous Worker's STEPS and tombstone (no token step): artifacts go, the project is purged.
  W.run(world, "DELETE FROM artifacts WHERE project_id = 'p_prev'");
  W.run(world, "UPDATE projects SET purged_at = 5, title = 'Deleted project' WHERE id = 'p_prev'");
  const t = await sweep(world, { scheduledTime: 0 });
  assert.equal(t.docs, 4);
  assert.equal(W.counters(world).i ?? 0, start - 4 * 12);
  assertExact(world);
});

// --- Server (local wrangler dev): cron end to end, query plans (test 23) and timing (test 21) -------------------------
const PORT = SERVER_PORTS["blind-tokens"];
let h;
const d1 = async (q) => JSON.parse((await promisify(execFile)("wrangler", ["d1", "--config", LOCAL_CONFIG, "execute", "DB", "--local", "--persist-to", h.dir, "--json", "--command", q],
  { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })).stdout);
const d1one = async (q) => (await d1(q))[0].results;
const cron = (time) => fetch(`${h.base}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent("*/15 * * * *")}&time=${time}`);
before(async () => { h = await startServer("blind-tokens", PORT); });
after(async () => { await h?.stop(); });

const SEED_SERVER = `
INSERT INTO principals (id, kind, issuer, subject, label, created_at) VALUES ('hum_srv', 'human', 'synthetic', 'srv', 'Synthetic', '${AT}');
INSERT INTO workspaces (id, name, personal, status, plan, created_by, created_at) VALUES ('wsp_srv', 'Synthetic', 0, 'active', 'free', 'hum_srv', '${AT}');
INSERT INTO workspaces (id, name, personal, status, plan, created_by, created_at) VALUES ('wsp_del', 'Synthetic', 0, 'deleting', 'free', 'hum_srv', '${AT}');
INSERT INTO projects (id, owner_id, title, created_at, workspace_id, deleted_at, purge_at) VALUES ('p_srv_due', 'hum_srv', 'Synthetic', '${AT}', 'wsp_srv', 1, 1);
INSERT INTO projects (id, owner_id, title, created_at, workspace_id, deleted_at, purge_at, purged_at) VALUES ('p_srv_purged', 'hum_srv', 'Synthetic', '${AT}', 'wsp_srv', 1, 1, 2);
INSERT INTO projects (id, owner_id, title, created_at, workspace_id) VALUES ('p_srv_del', 'hum_srv', 'Synthetic', '${AT}', 'wsp_del');
INSERT INTO projects (id, owner_id, title, created_at, workspace_id) VALUES ('p_srv_live', 'hum_srv', 'Synthetic', '${AT}', 'wsp_srv');
INSERT INTO artifacts (id, project_id, kind, title, head_rev, head_revision_id, created_at, updated_at)
  WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3)
  SELECT 'a_' || p.id || '_' || n.i, p.id, 'markdown', 'Synthetic', 1, 'rev_' || p.id || '_' || n.i, '${AT}', '${AT}'
  FROM projects p, n WHERE p.id IN ('p_srv_due', 'p_srv_del', 'p_srv_live');
INSERT INTO search_token_docs (artifact_id, project_id, workspace_id, owner_id, revision_id, key_id, token_digest, writer, gen, term_count, truncated, truncated_by, updated_at)
  WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3)
  SELECT 'a_' || p.id || '_' || n.i, p.id, p.workspace_id, 'hum_srv', 'rev_' || p.id || '_' || n.i, 'sk_srv', '', '', 1, 10, 0, '', 1
  FROM projects p, n WHERE p.id IN ('p_srv_due', 'p_srv_purged', 'p_srv_del', 'p_srv_live');
INSERT INTO search_tokens (doc_id, token) WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10)
  SELECT d.doc_id, unhex(printf('%016x%016x', d.doc_id, n.i)) FROM search_token_docs d, n;
INSERT INTO search_term_counters (scope, terms) SELECT 'w:' || workspace_id, 15 * COUNT(*) FROM search_token_docs GROUP BY workspace_id;
INSERT INTO search_term_counters (scope, terms) SELECT 'o:hum_srv', 15 * COUNT(*) FROM search_token_docs;
INSERT INTO search_term_counters (scope, terms) SELECT 'i', 15 * COUNT(*) FROM search_token_docs;`;
const COUNTERS_EXACT = `SELECT c.scope, c.terms, COALESCE(x.n, 0) AS want FROM search_term_counters c LEFT JOIN (
  SELECT s, SUM(n) AS n FROM (SELECT 'w:' || workspace_id AS s, 5 + (SELECT COUNT(*) FROM search_tokens t WHERE t.doc_id = d.doc_id) AS n FROM search_token_docs d
    UNION ALL SELECT 'o:' || owner_id, 5 + (SELECT COUNT(*) FROM search_tokens t WHERE t.doc_id = d.doc_id) FROM search_token_docs d
    UNION ALL SELECT 'i', 5 + (SELECT COUNT(*) FROM search_tokens t WHERE t.doc_id = d.doc_id) FROM search_token_docs d) GROUP BY s) x ON x.s = c.scope`;

test("test 14 (server): the cron purges a due project's token rows before its STEPS and sweeps purged and deleting ones, counters exact", async () => {
  await d1(SEED_SERVER);
  const t0 = 1767225600000;
  for (let i = 0; i < 10; i++) {
    const r = await cron(t0 + i * QUARTER);
    assert.equal(r.status, 200);
    await r.text();
    const left = (await d1one("SELECT COUNT(*) AS n FROM search_token_docs WHERE project_id <> 'p_srv_live'"))[0].n;
    const purged = (await d1one("SELECT purged_at FROM projects WHERE id = 'p_srv_due'"))[0].purged_at;
    if (!left && purged) break;
    await new Promise((r2) => setTimeout(r2, 300));
  }
  assert.equal((await d1one("SELECT COUNT(*) AS n FROM search_token_docs WHERE project_id <> 'p_srv_live'"))[0].n, 0);
  assert.ok((await d1one("SELECT purged_at FROM projects WHERE id = 'p_srv_due'"))[0].purged_at > 0);
  assert.equal((await d1one("SELECT COUNT(*) AS n FROM search_token_docs WHERE project_id = 'p_srv_live' AND revision_id <> ''"))[0].n, 3, "live rows untouched");
  for (const r of await d1one(COUNTERS_EXACT)) assert.equal(r.terms, r.want, r.scope);
});

/** Bind values for EXPLAIN only: integers where a name is numeric, else a text literal. */
const NUMERIC = new Set(["D", "CHUNK", "SEEN_DOC", "SEEN_GEN", "N", "WB", "OB", "IB", "NOW"]);
const literal = (st) => st.sql.replace(/\?(\d+)/g, (_, i) => NUMERIC.has(st.names[i - 1]) ? "1" : "'x'");

test("test 23 (local D1): no token, purge or sweep statement scans search_tokens; paths A and C use their indexes; the stable read looks up by key", async () => {
  const S = lib.SEARCH_SQL, plans = {};
  const statements = { ...Object.fromEntries(Object.entries(S).filter(([, v]) => v.sql)), "existing.R": S.existing.R, "existing.A": S.existing.A, "existing.T4": S.existing.T4,
    "fresh.R": S.fresh.R, "fresh.A": S.fresh.A, "fresh.T4": S.fresh.T4 };
  for (const [k, v] of Object.entries(lib.lifecycleStatements(lib.PURGE_ELIGIBLE))) statements["purge." + k] = v;
  const sw = lib.sweepReadSql(5001);
  const texts = Object.entries(statements).map(([k, v]) => [k, literal(v)]);
  for (const [k, q] of Object.entries(sw)) texts.push(["sweep." + k, q]);
  texts.push(["stable", lib.stableReadSql(3).replace(/\?(\d+)/g, "1")]);
  texts.push(["purge.select", "SELECT d.doc_id FROM search_token_docs d WHERE d.project_id = 'x' LIMIT 20"]);
  const out = await d1(texts.map(([, q]) => "EXPLAIN QUERY PLAN " + q).join(";\n"));
  texts.forEach(([k], i) => { plans[k] = out[i].results.map((r) => r.detail); });
  for (const [k, lines] of Object.entries(plans)) {
    assert.ok(lines.length, k);
    for (const l of lines) assert.doesNotMatch(l, /^SCAN (search_tokens|s|search_token_docs|d)\b/, `${k}: ${l}`);
  }
  assert.ok(plans["sweep.aWindow"].some((l) => /projects_purged/.test(l)), plans["sweep.aWindow"].join("\n"));
  assert.ok(plans["sweep.aDocs"].some((l) => /search_token_docs_project/.test(l)));
  assert.ok(plans["sweep.cDocs"].some((l) => /search_token_docs_workspace/.test(l)));
  assert.ok(plans["purge.select"].some((l) => /search_token_docs_project/.test(l)));
  const stable = plans.stable.join("\n");
  assert.match(stable, /MULTI-INDEX OR/);
  assert.match(stable, /SEARCH d USING INTEGER PRIMARY KEY \(rowid=\?\)/);
  assert.match(stable, /SEARCH s USING PRIMARY KEY \(doc_id=\?\)/);
  mkdirSync(join(ROOT, "tmp", "test-evidence"), { recursive: true });
  writeFileSync(join(ROOT, "tmp", "test-evidence", "blind-tokens-plans.json"), JSON.stringify(plans, null, 1));
});

test("test 21 (timing): one cron sweep run over about 1 million token rows on local D1; writer timings on node:sqlite", async () => {
  // 50 documents × 20,000 tokens in a purged project (sweep path A).
  await d1(`INSERT INTO projects (id, owner_id, title, created_at, workspace_id, deleted_at, purge_at, purged_at) VALUES ('p_bench', 'hum_srv', 'Synthetic', '${AT}', 'wsp_srv', 1, 1, 3);
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50)
    INSERT INTO search_token_docs (artifact_id, project_id, workspace_id, owner_id, revision_id, key_id, token_digest, writer, gen, term_count, truncated, truncated_by, updated_at)
      SELECT 'a_bench_' || i, 'p_bench', 'wsp_srv', 'hum_srv', 'rev_bench', 'sk_srv', '', '', 1, 20000, 0, '', 1 FROM n;`);
  const seedStart = Date.now();
  for (let part = 0; part < 5; part++) {
    await d1(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000)
      INSERT INTO search_tokens (doc_id, token) SELECT d.doc_id, unhex(printf('%016x%016x', d.doc_id, n.i)) FROM search_token_docs d, n
      WHERE d.artifact_id IN (${Array.from({ length: 10 }, (_, k) => `'a_bench_${part * 10 + k + 1}'`).join(", ")});`);
  }
  await d1(`UPDATE search_term_counters SET terms = terms + 50 * 20005 WHERE scope IN ('w:wsp_srv', 'o:hum_srv', 'i')`);
  const seedMs = Date.now() - seedStart;
  const total = (await d1one("SELECT COUNT(*) AS n FROM search_tokens"))[0].n;
  assert.ok(total >= 1000000, `${total} token rows`);
  const before = (await d1one("SELECT terms FROM search_term_counters WHERE scope = 'i'"))[0].terms;
  // Wait for this cron run's own completion signal: its search_sweep log line (bounded at 5 minutes, not 10 s).
  const logPath = join(ROOT, "tmp", "test-state-blind-tokens.log");
  const sweepsBefore = readFileSync(logPath, "utf8").split('"event":"search_sweep"').length;
  const t0 = Date.now();
  const r = await cron(1767225600000);
  await r.text();
  while (readFileSync(logPath, "utf8").split('"event":"search_sweep"').length === sweepsBefore) {
    assert.ok(Date.now() - t0 < 300000, "the cron's sweep finished within 5 minutes");
    await new Promise((r2) => setTimeout(r2, 100));
  }
  const sweepMs = Date.now() - t0;
  const after = (await d1one("SELECT terms FROM search_term_counters WHERE scope = 'i'"))[0].terms;
  assert.ok(before - after > 0 && before - after <= 5000 + 5 * 20, `one run deleted ${before - after} units`);
  for (const row of await d1one(COUNTERS_EXACT)) assert.equal(row.terms, row.want, row.scope);
  // Writer timings on node:sqlite over about 1 million existing entries.
  const world = world0();
  W.seedWorkspace(world, { principal: "hum_b", workspace: "wsp_b", project: "proj_b" });
  seedTokens(world, { project: "proj_b", workspace: "wsp_b", owner: "hum_b", docs: 50, tokens: 20000 });
  W.seedDoc(world, { artifact: "bench_1" });
  const env = envOf(world);
  const words = (n, p) => Array.from({ length: n }, (_, i) => p + i.toString(36).padStart(6, "0")).join(" ");
  let t = Date.now();
  const first = (await quiet(() => indexJobs(env, [{ artifactId: "bench_1", projectId: "proj_a", revisionId: "rev_bench_1", text: words(25000, "a") }]))).result;
  const firstMs = Date.now() - t;
  W.setHead(world, "bench_1", "rev_bench_2");
  t = Date.now();
  const rewrite = (await quiet(() => indexJobs(env, [{ artifactId: "bench_1", projectId: "proj_a", revisionId: "rev_bench_2", text: words(20000, "b") }]))).result;
  const rewriteMs = Date.now() - t;
  assert.equal(first.completed, 1); assert.equal(rewrite.completed, 1);
  // One A statement of 5,000 tokens, sorted against unsorted.
  const A = lib.SEARCH_SQL.existing.A, d = W.docRow(world, "bench_1").doc_id;
  const hex = (i) => i.toString(16).padStart(32, "f");
  const timeA = (tokens) => {
    W.run(world, "UPDATE search_token_docs SET revision_id = '', writer = 'bench' WHERE doc_id = ?", d);
    const v = { A: "bench_1", R: "rev_bench_2", P: "proj_a", W: "wsp_a", O: "hum_a", D: d, NONCE: "bench", WB: 1e9, OB: 1e9, IB: 1e9, ADD: JSON.stringify(tokens) };
    const s = Date.now();
    const n = world.sql.prepare(A.sql).run(...A.names.map((k) => v[k])).changes;
    return { ms: Date.now() - s, n };
  };
  const sorted = Array.from({ length: 5000 }, (_, i) => hex(i)), shuffled = sorted.slice().sort(() => Math.random() - 0.5).map((x) => x.replace(/^f/, "e"));
  const aSorted = timeA(sorted), aUnsorted = timeA(shuffled);
  const bench = { local_d1: { token_rows: total, seed_ms: seedMs, one_sweep_run_ms: sweepMs, units_deleted: before - after },
    node_sqlite: { existing_entries: 1000000, capped_first_index_ms: firstMs, capped_first_index_calls: first.calls, capped_rewrite_ms: rewriteMs, rewrite_calls: rewrite.calls,
      add_5000_sorted_ms: aSorted.ms, add_5000_unsorted_ms: aUnsorted.ms } };
  mkdirSync(join(ROOT, "tmp", "test-evidence"), { recursive: true });
  writeFileSync(join(ROOT, "tmp", "test-evidence", "blind-tokens-benchmark.json"), JSON.stringify(bench, null, 1));
  console.log("BLIND_TOKENS_BENCHMARK " + JSON.stringify(bench));
});

test("server log: the cron logs search_sweep with counts only, never content", () => {
  const log = readFileSync(join(ROOT, "tmp", "test-state-blind-tokens.log"), "utf8");
  const lines = log.split("\n").filter((l) => l.includes('"event":"search_sweep"'));
  assert.ok(lines.length >= 1, "at least one search_sweep line");
  for (const l of lines) {
    const j = JSON.parse(l.slice(l.indexOf("{")));
    assert.deepEqual(Object.keys(j).sort(), ["calls", "docs", "event", "rows", "tokens"]);
  }
});

// --- Review fixes: purge and sweep cost, purge errors (commit B items 7, 8) ------------------------------------------
test("review B7 (i): a dead writer's row whose term_count understates its tokens is fully purged", async () => {
  const world = world0();
  project(world, "p_dw", { due: true });
  // A writer's row: inserted with term_count 0, 7,000 tokens added, the writer died holding the lease.
  const [a] = seedTokens(world, { project: "p_dw", workspace: "wsp_a", owner: "hum_a", docs: 1, tokens: 7000 });
  W.run(world, "UPDATE search_token_docs SET revision_id = '', writer = 'sw_dead', term_count = 0 WHERE artifact_id = ?", a);
  let runs = 0;
  while (!purgedAt(world, "p_dw") && runs < 10) {
    const before = W.one(world, "SELECT (SELECT COUNT(*) FROM search_tokens) + (SELECT COUNT(*) FROM search_token_docs) AS n").n;
    await quiet(() => lib.purgeDueProjects(envOf(world), { projectId: "p_dw", rowBudget: 3000 }));
    const after = W.one(world, "SELECT (SELECT COUNT(*) FROM search_tokens) + (SELECT COUNT(*) FROM search_token_docs) AS n").n;
    assert.ok(after < before || purgedAt(world, "p_dw"), `run ${runs} made progress`);
    assertExact(world);
    runs++;
  }
  assert.ok(purgedAt(world, "p_dw"));
  assert.equal(docCount(world, "p_dw"), 0);
});

/**
 * Watches lifecycle batches: every L that takes a row still held by a writer counts that row's tokens (once); every
 * other read of tokens is in K, proportional to what K deletes. Returns per-doc count tallies and per-batch figures.
 */
function watchCounts(world) {
  const counted = new Map(), batchesSeen = [];
  let selectionReads = 0;
  // A selection that reads search_tokens (its plan names it) costs, per row it returns, that row's tokens up to 5,001.
  const readsTokens = (q) => W.all(world, "EXPLAIN QUERY PLAN " + q.replace(/\?1/g, "'x'")).some((r) => /search_tokens\b| s USING/.test(r.detail));
  world.after = ({ kind, q, qs, out }) => {
    const sels = kind === "all" && /FROM search_token_docs d WHERE/.test(q) ? [[q, out.results]]
      : kind === "batch" ? qs.map((x, i) => [x, out[i]?.results ?? []]).filter(([x]) => /FROM search_token_docs d WHERE/.test(x)) : [];
    for (const [sq, rows] of sels) if (rows.length && readsTokens(sq))
      for (const r of rows) selectionReads += Math.min(5001, W.one(world, "SELECT COUNT(*) AS n FROM search_tokens WHERE doc_id = ?", r.doc_id).n);
  };
  world.before = ({ kind, qs, ps }) => {
    if (kind !== "batch" || !qs.some((q) => /^UPDATE search_token_docs SET revision_id = '', writer = \?/.test(q))) return;
    let reads = 0;
    qs.forEach((q, i) => {
      if (!/^UPDATE search_token_docs SET revision_id = '', writer = \?/.test(q)) return;
      const d = ps[i][1];   // L: ?1 = PN, ?2 = D
      const r = W.one(world, "SELECT revision_id, writer FROM search_token_docs WHERE doc_id = ?", d);
      if (r && r.revision_id === "" && !r.writer.startsWith("purge:")) {
        counted.set(d, (counted.get(d) ?? 0) + 1);
        reads += W.one(world, "SELECT COUNT(*) AS n FROM search_tokens WHERE doc_id = ?", d).n;
      }
    });
    batchesSeen.push({ countReads: reads, tokensBefore: W.one(world, "SELECT COUNT(*) AS n FROM search_tokens").n });
  };
  return { counted, batchesSeen, selectionReads: () => selectionReads, stop: () => { world.before = null; world.after = null; } };
}

test("review B7 (ii): the purge reads no tokens to select; each writer-held row is counted once, at its first lease", async () => {
  const world = world0();
  project(world, "p_big", { due: true });
  const ids = seedTokens(world, { project: "p_big", workspace: "wsp_a", owner: "hum_a", docs: 20, tokens: 5000 });
  // Half the rows are at '' under dead writers (term_count understated), half complete.
  for (const a of ids.slice(0, 10)) W.run(world, "UPDATE search_token_docs SET revision_id = '', writer = 'sw_dead', term_count = 0 WHERE artifact_id = ?", a);
  const w = watchCounts(world);
  let rounds = 0;
  for (let i = 0; i < 40 && !purgedAt(world, "p_big"); i++) { await quiet(() => lib.purgeDueProjects(envOf(world), { projectId: "p_big" })); rounds++; }
  w.stop();
  assert.ok(purgedAt(world, "p_big"));
  assert.equal(w.counted.size, 10, "every dead writer's row counted");
  assert.ok([...w.counted.values()].every((n) => n === 1), "each exactly once");
  // Count reads total exactly the dead rows' tokens (each counted once); the selections read none, and K reads what it
  // deletes. This assumes K reads only the entries it deletes (its plan: a primary-key prefix lookup with LIMIT ?CHUNK);
  // how real D1 counts rows_read is a staging check. So rows read over the whole purge stay within 1.5 × the 100,000 tokens deleted (plus document rows).
  assert.equal(w.batchesSeen.reduce((n, b) => n + b.countReads, 0), 50000);
  assert.equal(w.selectionReads(), 0, "the selections read no token entry");
  assert.ok(w.batchesSeen.every((b) => b.countReads <= 20001), "one row's bounded count at most per round");
  // Per round, after a row's first lease: index entries read (counts + K's own entries) ≤ 2 × tokens deleted + 20.
  for (let i = 1; i < w.batchesSeen.length; i++) {
    const deleted = w.batchesSeen[i - 1].tokensBefore - w.batchesSeen[i].tokensBefore;
    const reads = w.batchesSeen[i - 1].countReads + deleted;
    if (w.batchesSeen[i - 1].countReads === 0) assert.ok(reads <= 2 * deleted + 20, `round ${i}: ${reads} read for ${deleted} deleted`);
  }
  assert.ok(rounds >= 20, `${rounds} rounds`);
  assertExact(world);
});

test("review B7 (iii): the sweep on a deleting workspace counts each writer-held row once and reads no tokens to select", async () => {
  const world = world0();
  W.seedWorkspace(world, { principal: "hum_x", workspace: "wsp_x", project: "proj_x" });
  const ids = seedTokens(world, { project: "proj_x", workspace: "wsp_x", owner: "hum_x", docs: 20, tokens: 5000 });
  for (const a of ids.slice(0, 5)) W.run(world, "UPDATE search_token_docs SET revision_id = '', writer = 'sw_dead', term_count = 0 WHERE artifact_id = ?", a);
  W.run(world, "UPDATE workspaces SET status = 'deleting' WHERE id = 'wsp_x'");
  const w = watchCounts(world);
  let runs = 0;
  for (; runs < 60 && W.one(world, "SELECT COUNT(*) AS n FROM search_token_docs WHERE workspace_id = 'wsp_x'").n; runs++) {
    const t = (await quiet(() => lib.sweepSearchTokenOrphans(envOf(world), { scheduledTime: 0 }))).result;
    assert.ok(t.tokens + t.docs > 0, `run ${runs} made progress`);
    assertExact(world);
  }
  w.stop();
  assert.equal(W.one(world, "SELECT COUNT(*) AS n FROM search_token_docs WHERE workspace_id = 'wsp_x'").n, 0);
  assert.equal(w.counted.size, 5);
  assert.ok([...w.counted.values()].every((n) => n === 1), "each exactly once");
  assert.equal(w.batchesSeen.reduce((n, b) => n + b.countReads, 0), 25000, "count reads total the dead rows' tokens, once");
  assert.equal(w.selectionReads(), 0, "the sweep's reads read no token entry");
});

test("review B7: the purge and sweep selections read no search_tokens entry (query plan)", () => {
  const world = world0();
  const plan = (q) => W.all(world, "EXPLAIN QUERY PLAN " + q.replace(/\?1/g, "'x'")).map((r) => r.detail).join("\n");
  const sw = lib.sweepReadSql();
  for (const [name, q] of [["purge", lib.PURGE_SELECT_SQL], ["sweep A", sw.aDocs], ["sweep C", sw.cDocs], ["sweep B", sw.bDocs]])
    assert.doesNotMatch(plan(q), /search_tokens\b|\bs USING/, name);
});

test("review B7 (iv): purge, restore, a writer takes over a row holding the lifecycle's upper bound, and ends exact", async () => {
  const world = world0();
  project(world, "p_iv", { due: true });
  W.seedDoc(world, { project: "p_iv", artifact: "iv_1" });
  const env = envOf(world);
  W.run(world, "UPDATE projects SET deleted_at = NULL, purge_at = NULL WHERE id = 'p_iv'");
  const text = Array.from({ length: 300 }, (_, i) => "w" + i).join(" ");
  await quiet(() => lib.indexSearchJobs(env, [{ artifactId: "iv_1", projectId: "p_iv", revisionId: "rev_iv_1", text, textBytes: text.length }]));
  W.run(world, "UPDATE projects SET deleted_at = 1, purge_at = 1 WHERE id = 'p_iv'");
  await quiet(() => lib.purgeDueProjects(env, { projectId: "p_iv", rowBudget: 100 }));
  const leased = W.docRow(world, "iv_1");
  assert.match(leased.writer, /^purge:/);
  assert.ok(leased.term_count >= W.tokensOf(world, "iv_1").length, "an upper bound");
  W.run(world, "UPDATE projects SET deleted_at = NULL, purge_at = NULL WHERE id = 'p_iv'");
  const { result } = await quiet(() => lib.indexSearchJobs(env, [{ artifactId: "iv_1", projectId: "p_iv", revisionId: "rev_iv_1", text, textBytes: text.length }]));
  assert.equal(result.completed, 1);
  const row = W.docRow(world, "iv_1");
  assert.equal(row.term_count, W.tokensOf(world, "iv_1").length, "after the restore the writer's T4 sets term_count to the exact count");
  assert.equal(W.tokensOf(world, "iv_1").length, 300);
  assertExact(world); assertClaims(world);
});

test("review B8: an error in the token purge step logs search_purge_failed and moves to the next project", async () => {
  const world = world0();
  project(world, "p_e1", { due: true });
  project(world, "p_e2", { due: true });
  W.run(world, "UPDATE projects SET purge_at = 0 WHERE id = 'p_e1'");
  seedTokens(world, { project: "p_e1", workspace: "wsp_a", owner: "hum_a", docs: 2, tokens: 3 });
  seedTokens(world, { project: "p_e2", workspace: "wsp_a", owner: "hum_a", docs: 2, tokens: 3 });
  let failed = false;
  world.before = ({ kind, q }) => { if (!failed && kind === "all" && /WHERE d\.project_id = \?1/.test(q)) { failed = true; throw Object.assign(new Error("synthetic"), { code: "synthetic_failure" }); } };
  const { result, events } = await quiet(() => lib.purgeDueProjects(envOf(world), { scheduledTime: 0 }));
  world.before = null;
  assert.deepEqual(events.filter((e) => e.event === "search_purge_failed"), [{ event: "search_purge_failed", projectId: "p_e1", code: "synthetic_failure" }]);
  assert.deepEqual(result.finished, ["p_e2"]);
  assert.equal(purgedAt(world, "p_e1"), null, "not marked purged");
  assert.equal(W.one(world, "SELECT COUNT(*) AS n FROM artifacts WHERE project_id = 'p_e1'").n, 2, "its STEPS did not run");
  // The next run retries it.
  await quiet(() => lib.purgeDueProjects(envOf(world), { scheduledTime: 0 }));
  assert.ok(purgedAt(world, "p_e1"));
  assertExact(world);
});

test("review B8: the immediate purge of one project still throws", async () => {
  const world = world0();
  project(world, "p_e3", { due: true });
  seedTokens(world, { project: "p_e3", workspace: "wsp_a", owner: "hum_a", docs: 1, tokens: 3 });
  world.before = ({ kind, q }) => { if (kind === "all" && /WHERE d\.project_id = \?1/.test(q)) throw Object.assign(new Error("synthetic"), { code: "synthetic_failure" }); };
  await assert.rejects(quiet(() => lib.purgeDueProjects(envOf(world), { projectId: "p_e3" })), (e) => e.code === "synthetic_failure");
  world.before = null;
  assert.equal(purgedAt(world, "p_e3"), null);
});
