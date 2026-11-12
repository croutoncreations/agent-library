// Blind-index search tokens (slice 4a): migrations/0032_blind_search.sql and the token, purge and sweep statements of
// packages/core/src/search/tokens.js, on node:sqlite with every migration applied in order. No listeners. Synthetic
// fixtures only; every INSERT names its columns. node:sqlite does not enforce D1's limits (bound values per statement,
// statement size): those are checked against the design's bounds in code, and confirmed only on real D1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ROOT } from "./helpers.mjs";

const MIGRATIONS = readdirSync(join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort();
const BLIND = "0032_blind_search.sql";

function freshDb({ upTo } = {}) {
  const sql = new DatabaseSync(":memory:");
  for (const f of MIGRATIONS) {
    if (upTo && f > upTo) break;
    sql.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  }
  return sql;
}
const at = "2026-11-11T00:00:00.000Z";
function seedBase(sql) {
  sql.prepare("INSERT INTO principals (id, kind, issuer, subject, label, created_at) VALUES (?, 'human', 'synthetic', ?, 'Synthetic', ?)").run("hum_a", "a", at);
  sql.prepare("INSERT INTO principals (id, kind, issuer, subject, label, created_at) VALUES (?, 'human', 'synthetic', ?, 'Synthetic', ?)").run("hum_b", "b", at);
  sql.prepare("INSERT INTO workspaces (id, name, personal, status, plan, created_by, created_at) VALUES ('wsp_live', 'Live', 0, 'active', 'free', 'hum_a', ?)").run(at);
  sql.prepare("INSERT INTO workspaces (id, name, personal, status, plan, created_by, created_at) VALUES ('wsp_gone', 'Gone', 0, 'deleting', 'free', 'hum_a', ?)").run(at);
  const project = (id, ws, extra = {}) => sql.prepare("INSERT INTO projects (id, owner_id, title, created_at, workspace_id, deleted_at, purge_at, purged_at) VALUES (?, 'hum_a', 'Synthetic', ?, ?, ?, ?, ?)")
    .run(id, at, ws, extra.deleted_at ?? null, extra.purge_at ?? null, extra.purged_at ?? null);
  project("p_live", "wsp_live");
  project("p_deleted", "wsp_live", { deleted_at: 1, purge_at: 2 });
  project("p_purged", "wsp_live", { deleted_at: 1, purge_at: 2, purged_at: 3 });
  project("p_wsgone", "wsp_gone");
  // A legacy project (no workspace_id): its workspace 'wsp_hum_b' has no row, so it counts as live.
  sql.prepare("INSERT INTO projects (id, owner_id, title, created_at) VALUES ('p_legacy', 'hum_b', 'Synthetic', ?)").run(at);
  const doc = (id, pid, kind = "markdown", head = 1, gen = null) => sql.prepare(`INSERT INTO artifacts (id, project_id, kind, title, head_rev, head_revision_id, generation_id, created_at, updated_at)
    VALUES (?, ?, ?, 'Synthetic', ?, ?, ?, ?, ?)`).run(id, pid, kind, head, head ? `rev_${id}` : null, gen, at, at);
  for (const p of ["p_live", "p_deleted", "p_purged", "p_wsgone", "p_legacy"]) doc(`a_${p}`, p);
  doc("a_bin", "p_live", "binary");
  doc("a_empty", "p_live", "markdown", 0);
  doc("a_gen", "p_live", "json", 1, "g_1");
  doc("a_done", "p_live");
  doc("a_old", "p_live");
  const tokenDoc = (artifact, rev) => sql.prepare(`INSERT INTO search_token_docs (artifact_id, project_id, workspace_id, owner_id, revision_id, key_id, token_digest, writer, gen, term_count, truncated, truncated_by, updated_at)
    VALUES (?, 'p_live', 'wsp_live', 'hum_a', ?, 'sk_1', '', '', 1, 0, 0, '', 1)`).run(artifact, rev);
  tokenDoc("a_done", "rev_a_done");
  tokenDoc("a_old", "rev_stale");
}
const missing = (sql) => sql.prepare("SELECT id FROM search_tokens_missing ORDER BY id").all().map((r) => r.id);

test("test 1: migration 0032 applies twice, starts not ready, and creates its tables and indexes", () => {
  const sql = freshDb();
  sql.exec(readFileSync(join(ROOT, "migrations", BLIND), "utf8"));
  sql.exec(readFileSync(join(ROOT, "migrations", BLIND), "utf8"));
  assert.deepEqual({ ...sql.prepare("SELECT id, ready, backfill_after, sweep_doc_after, sweep_purged_after, sweep_workspace_after FROM search_tokens_state").get() },
    { id: 1, ready: 0, backfill_after: "", sweep_doc_after: 0, sweep_purged_after: "", sweep_workspace_after: "" });
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM search_tokens_state").get().n, 1);
  const names = sql.prepare("SELECT name FROM sqlite_master WHERE type IN ('index', 'table', 'view')").all().map((r) => r.name);
  for (const n of ["search_token_docs", "search_tokens", "search_term_counters", "workspace_search_keys", "search_tokens_state", "search_tokens_missing",
    "search_token_docs_project", "search_token_docs_workspace", "search_tokens_token", "projects_purged"]) assert.ok(names.includes(n), n);
  // WITHOUT ROWID: no rowid column to select.
  assert.throws(() => sql.prepare("SELECT rowid FROM search_tokens").all(), /no such column: rowid/);
  assert.match(sql.prepare("SELECT sql FROM sqlite_master WHERE name = 'search_tokens'").get().sql, /WITHOUT ROWID/);
  const purgedIdx = sql.prepare("EXPLAIN QUERY PLAN SELECT id FROM projects WHERE purged_at IS NOT NULL AND purged_at > 5 ORDER BY purged_at, id LIMIT 20").all().map((r) => r.detail).join("\n");
  assert.match(purgedIdx, /projects_purged/);
});

test("test 1: AUTOINCREMENT never reuses a deleted doc_id", () => {
  const sql = freshDb();
  const ins = sql.prepare(`INSERT INTO search_token_docs (artifact_id, project_id, workspace_id, owner_id, revision_id, key_id, token_digest, writer, gen, term_count, truncated, truncated_by, updated_at)
    VALUES (?, 'p', 'w', 'o', '', 'k', '', '', 1, 0, 0, '', 1)`);
  ins.run("a1"); const second = Number(ins.run("a2").lastInsertRowid);
  sql.prepare("DELETE FROM search_token_docs WHERE doc_id = ?").run(second);
  const third = Number(ins.run("a2").lastInsertRowid);
  assert.ok(third > second, `${third} > ${second}`);
});

test("test 1: the missing view lists live text heads without a current row, and nothing else", () => {
  const sql = freshDb();
  seedBase(sql);
  // Excluded: soft-deleted and purged projects, a deleting workspace, binaries, no head, generations, a current row.
  // Included: a project whose workspace row does not exist, a legacy project (no workspace_id), a stale row.
  assert.deepEqual(missing(sql), ["a_old", "a_p_legacy", "a_p_live"]);
  // A row in progress ('') is missing too.
  sql.prepare("UPDATE search_token_docs SET revision_id = '' WHERE artifact_id = 'a_done'").run();
  assert.ok(missing(sql).includes("a_done"));
  // Restoring the soft-deleted project brings its document back.
  sql.prepare("UPDATE projects SET deleted_at = NULL, purge_at = NULL WHERE id = 'p_deleted'").run();
  assert.ok(missing(sql).includes("a_p_deleted"));
});

test("test 20: the previous Worker keeps working on the new schema (its writes and the view)", () => {
  // Every migration applied, then the previous Worker's own writes (an artifact insert, a project purge tombstone):
  // they still work, and the view reflects them without any token row.
  const sql = freshDb();
  seedBase(sql);
  sql.prepare(`INSERT INTO artifacts (id, project_id, kind, title, head_rev, head_revision_id, created_at, updated_at)
    VALUES ('a_prev', 'p_live', 'markdown', 'Synthetic', 1, 'rev_prev', ?, ?)`).run(at, at);
  assert.ok(missing(sql).includes("a_prev"));
  sql.prepare("UPDATE projects SET deleted_at = 1, purge_at = 2, purged_at = 3, title = 'Deleted project' WHERE id = 'p_live'").run();
  assert.ok(!missing(sql).includes("a_prev"));
  // DROP and re-create (what a destructive change of the view would need) is not part of this migration.
  assert.doesNotMatch(readFileSync(join(ROOT, "migrations", BLIND), "utf8").replace(/--.*$/gm, ""), /\bDROP\b/i);
});

// --- Statements (tests 3, 4, 26): the real compiled statements of search/tokens.js, executed on node:sqlite ---------
const { loadWorker } = await import("./load-worker.mjs");
const W = await import("./blind-tokens-world.mjs");
const lib = await loadWorker({ "search/tokens.js": ["SEARCH_SQL", "lifecycleStatements", "stableReadSql", "named", "SEARCH_WRITER_ELIGIBLE"] });
const S = lib.SEARCH_SQL;
const STILL_DUE_NAMED = "EXISTS (SELECT 1 FROM projects d WHERE d.id = ?P AND d.deleted_at IS NOT NULL AND d.purged_at IS NULL AND d.purge_at <= ?NOW)";
const PATH_A = "EXISTS (SELECT 1 FROM projects WHERE id = ?P AND purged_at IS NOT NULL)";
const tok = (i) => i.toString(16).padStart(32, "0");
const BOUNDS = { WB: 1000, OB: 3000, IB: 50000 };
/** Run one compiled statement by name bindings; returns changes (writes) or rows (reads). */
function exec(world, stmt, values) {
  const p = world.sql.prepare(stmt.sql);
  const args = stmt.names.map((n) => { assert.ok(n in values, `binding ${n}`); return values[n]; });
  return p.columns().length ? p.all(...args) : Number(p.run(...args).changes);
}
/** Statements in one transaction, as a D1 batch. */
function batch(world, list) {
  world.sql.exec("BEGIN");
  try { const out = list.map(([s, v]) => exec(world, s, v)); world.sql.exec("COMMIT"); return out; } catch (e) { world.sql.exec("ROLLBACK"); throw e; }
}
function setup() {
  const world = W.mkWorld();
  W.seedWorkspace(world);
  W.seedDoc(world, { artifact: "art_1" });
  W.seedDoc(world, { artifact: "art_2" });
  return world;
}
const base = (extra = {}) => ({ A: "art_1", P: "proj_a", R: "rev_art_1", W: "wsp_a", O: "hum_a", K: "sk_1", NONCE: "nonce_x", NOW: 1, ...BOUNDS, ...extra });
const assertExact = (world) => assert.deepEqual(W.counters(world), W.expectedCounters(world));
/** Rows that claim a revision are exact (count = term_count, digest set) or clipped (truncated_by set). */
function assertClaims(world) {
  for (const r of W.all(world, "SELECT d.*, (SELECT COUNT(*) FROM search_tokens s WHERE s.doc_id = d.doc_id) AS n FROM search_token_docs d WHERE revision_id <> ''")) {
    assert.ok(r.n === r.term_count, `row ${r.artifact_id} claims ${r.revision_id} with ${r.n} tokens, term_count ${r.term_count}`);
  }
}
/** New document: T0, T1n, T1nc, A, Ac, T4 (fresh $D). */
function indexNew(world, tokens, v = base()) {
  const add = JSON.stringify(tokens);
  return batch(world, [[S.T0, v], [S.T1n, v], [S.T1nc, v], [S.fresh.A, { ...v, ADD: add }], [S.Ac, v],
    [S.fresh.T4, { ...v, N: tokens.length, REASON: "", DIGEST: "dg" }]]);
}

test("test 3: every statement's placeholders are numbered once per distinct name, and the pins are in the text", () => {
  const all = { ...S, ...Object.fromEntries(Object.entries(S.existing).map(([k, v]) => ["existing." + k, v])), ...Object.fromEntries(Object.entries(S.fresh).map(([k, v]) => ["fresh." + k, v])) };
  delete all.existing; delete all.fresh;
  const lifecycle = lib.lifecycleStatements(STILL_DUE_NAMED);
  for (const [k, v] of Object.entries(lifecycle)) all["purge." + k] = v;
  for (const [k, v] of Object.entries(lib.lifecycleStatements(PATH_A))) all["sweepA." + k] = v;
  for (const [k, v] of Object.entries(lib.lifecycleStatements(lib.SEARCH_WRITER_ELIGIBLE))) all["oversize." + k] = v;
  for (const [name, st] of Object.entries(all)) {
    const nums = [...st.sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]));
    const distinctNames = [...new Set([...st.template.matchAll(/\?([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]))];
    assert.equal(new Set(nums).size, distinctNames.length, `${name}: one number per distinct name`);
    assert.equal(Math.max(0, ...nums), distinctNames.length, `${name}: numbers 1..n`);
    assert.deepEqual([...st.names], distinctNames, name);
    assert.doesNotMatch(st.sql, /\?[A-Z]/, `${name}: no named placeholder left`);
    // node:sqlite agrees on the parameter count (D1 limit: 100 per statement).
    const world = W.mkWorld();
    assert.ok(distinctNames.length <= 100);
    world.sql.prepare(st.sql);
  }
  const stable = lib.stableReadSql(40);
  assert.equal(new Set([...stable.matchAll(/\?(\d+)/g)].map((m) => m[1])).size, 81, "40 pairs and the LIMIT");
  const t = (st) => st.template.replace(/\s+/g, " ");
  assert.match(t(S.T1s), /WHERE doc_id = \?SEEN_DOC AND artifact_id = \?A AND gen = \?SEEN_GEN AND revision_id <> '' AND workspace_id = \?W AND owner_id = \?O/);
  for (const k of ["L", "K", "X"]) assert.match(t(lifecycle[k]), /workspace_id = \?W AND owner_id = \?O/, k);
  for (const k of ["Kc", "Xc"]) {
    assert.match(t(lifecycle[k]), /WHERE scope IN \('w:' \|\| \?W, 'o:' \|\| \?O, 'i'\) AND changes\(\) > 0$/, k);
    assert.doesNotMatch(lifecycle[k].template, /search_token_docs/, k);
  }
  assert.match(t(S.T1nc), /AND changes\(\) > 0$/);
  for (const st of [S.existing.R, S.existing.A, S.fresh.R, S.fresh.A]) {
    const x = t(st);
    assert.match(x, /head_revision_id = \?R/); assert.match(x, /p\.deleted_at IS NULL AND p\.purged_at IS NULL/);
    assert.match(x, /revision_id = '' AND writer = \?NONCE/); assert.match(x, /workspace_id = \?W AND owner_id = \?O/);
  }
  // Only T1n and T1z set workspace_id or owner_id.
  for (const [name, st] of Object.entries(all)) {
    if (/^T1[nz]$/.test(name)) continue;
    const set = /\bSET\b([\s\S]*?)(\bFROM\b|\bWHERE\b)/.exec(st.template)?.[1] ?? "";
    assert.doesNotMatch(set, /\b(workspace_id|owner_id)\s*=/, name);
    if (/^\s*INSERT INTO search_token_docs/.test(st.template)) assert.fail(`${name} inserts a document row`);
  }
});

test("test 3: unhex round-trips, T1n is refused without 5 units in any scope, and T1nc then writes nothing", () => {
  const world = setup();
  assert.equal(W.one(world, "SELECT lower(hex(unhex(?))) AS h", tok(255)).h, tok(255));
  for (const [scope, bound] of [["w:wsp_a", "WB"], ["o:hum_a", "OB"], ["i", "IB"]]) {
    W.run(world, "DELETE FROM search_term_counters");
    W.run(world, "INSERT INTO search_term_counters (scope, terms) VALUES (?, ?)", scope, 96);
    const v = base({ [bound]: 100 });
    const [, ins, cnt] = batch(world, [[S.T0, v], [S.T1n, v], [S.T1nc, v]]);
    assert.equal(ins, 0, scope); assert.equal(cnt, 0, scope);
    assert.equal(W.docRow(world, "art_1"), undefined);
    assert.deepEqual(W.counters(world), { [scope]: 96 });
  }
  W.run(world, "DELETE FROM search_term_counters");
  const [, ins, cnt] = batch(world, [[S.T0, base()], [S.T1n, base()], [S.T1nc, base()]]);
  assert.equal(ins, 1); assert.equal(cnt, 3);
  assertExact(world);
  // A conflicting second insert changes nothing and credits nothing.
  const [, again, cnt2] = batch(world, [[S.T0, base()], [S.T1n, base({ NONCE: "other" })], [S.T1nc, base()]]);
  assert.equal(again, 0); assert.equal(cnt2, 0);
  assertExact(world);
});

test("test 3: a new document indexes exactly; T1s pins doc_id and gen; T1u steals the lease", () => {
  const world = setup();
  const tokens = [tok(1), tok(2), tok(3)];
  indexNew(world, tokens);
  assert.deepEqual(W.tokensOf(world, "art_1"), tokens);
  const row = W.docRow(world, "art_1");
  assert.equal(row.revision_id, "rev_art_1"); assert.equal(row.term_count, 3); assert.equal(row.token_digest, "dg"); assert.equal(row.truncated, 0);
  assertExact(world); assertClaims(world);
  // Stale gen: nothing.
  assert.equal(exec(world, S.T1s, base({ NONCE: "n2", SEEN_DOC: row.doc_id, SEEN_GEN: row.gen - 1 })), 0);
  // Different doc_id (deleted and re-inserted with gen = 1): nothing.
  W.run(world, "DELETE FROM search_tokens WHERE doc_id = ?", row.doc_id);
  W.run(world, "DELETE FROM search_token_docs WHERE doc_id = ?", row.doc_id);
  W.run(world, "DELETE FROM search_term_counters");
  indexNew(world, []);
  const re = W.docRow(world, "art_1");
  assert.ok(re.doc_id > row.doc_id);
  assert.equal(exec(world, S.T1s, base({ NONCE: "n2", SEEN_DOC: row.doc_id, SEEN_GEN: re.gen })), 0, "old doc_id");
  assert.equal(exec(world, S.T1s, base({ NONCE: "n2", SEEN_DOC: re.doc_id, SEEN_GEN: re.gen, W: "wsp_other" })), 0, "wrong workspace");
  assert.equal(exec(world, S.T1s, base({ NONCE: "n2", SEEN_DOC: re.doc_id, SEEN_GEN: re.gen })), 1);
  assert.equal(W.docRow(world, "art_1").writer, "n2");
  // T1u steals the lease from n2.
  assert.equal(exec(world, S.T1u, base({ NONCE: "n3" })), 1);
  const stolen = W.docRow(world, "art_1");
  assert.equal(stolen.writer, "n3"); assert.equal(stolen.gen, re.gen + 2);
});

test("test 3: R and A do nothing without $MINE, $H, $LIVE or the row's own scopes; T4 counts once", () => {
  const world = setup();
  indexNew(world, [tok(1), tok(2)]);
  const d = W.docRow(world, "art_1").doc_id;
  exec(world, S.T1u, base()); // revision_id is '' only after T1s; take the lease the stable way
  exec(world, S.T1s, base({ SEEN_DOC: d, SEEN_GEN: W.docRow(world, "art_1").gen }));
  const v = base({ D: d });
  const tries = { notMine: { NONCE: "other" }, notHead: { R: "rev_other" }, wrongW: { W: "wsp_b" }, wrongO: { O: "hum_b" } };
  for (const [why, x] of Object.entries(tries)) {
    const [r, rc, a, ac] = batch(world, [[S.existing.R, { ...v, ...x, REM: JSON.stringify([tok(1)]) }], [S.Rc, { ...v, ...x }],
      [S.existing.A, { ...v, ...x, ADD: JSON.stringify([tok(9)]) }], [S.Ac, { ...v, ...x }]]);
    assert.deepEqual([r, a], [0, 0], why);
    assertExact(world);
  }
  W.run(world, "UPDATE projects SET deleted_at = 1, purge_at = 2 WHERE id = 'proj_a'");
  // Rc has no changes() > 0 (the design keeps it unconditional): it rewrites the counters with - 0.
  assert.equal(batch(world, [[S.existing.R, { ...v, REM: JSON.stringify([tok(1)]) }], [S.Rc, v]])[0], 0, "not live");
  assertExact(world);
  W.run(world, "UPDATE projects SET deleted_at = NULL, purge_at = NULL WHERE id = 'proj_a'");
  const [r, , a] = batch(world, [[S.existing.R, { ...v, REM: JSON.stringify([tok(1)]) }], [S.Rc, v], [S.existing.A, { ...v, ADD: JSON.stringify([tok(3), tok(2)]) }], [S.Ac, v]]);
  assert.deepEqual([r, a], [1, 1], "tok(2) already present");
  assertExact(world);
  // T4 refused when short and not clipped; then exact.
  assert.equal(exec(world, S.existing.T4, { ...v, N: 3, REASON: "", DIGEST: "dg2" }), 0);
  assert.equal(exec(world, S.existing.T4, { ...v, N: 2, REASON: "", DIGEST: "dg2" }), 1);
  const row = W.docRow(world, "art_1");
  assert.deepEqual([row.revision_id, row.term_count, row.token_digest, row.truncated, row.truncated_by], ["rev_art_1", 2, "dg2", 0, ""]);
  assertClaims(world);
});

test("test 3: T4 clips by each full scope; $LIVE fails for deleting, deleted and purged, holds without a workspace row", () => {
  for (const [scope, bound, label] of [["w:wsp_a", "WB", "workspace"], ["o:hum_a", "OB", "owner"], ["i", "IB", "installation"]]) {
    const world = setup();
    // Room for the row (5) and 2 tokens in the bounded scope only.
    const v = base({ [bound]: 7 });
    const out = batch(world, [[S.T0, v], [S.T1n, v], [S.T1nc, v], [S.fresh.A, { ...v, ADD: JSON.stringify([tok(1), tok(2), tok(3), tok(4)]) }], [S.Ac, v],
      [S.fresh.T4, { ...v, N: 4, REASON: "", DIGEST: "dg" }]]);
    assert.equal(out[3], 2, label);
    const row = W.docRow(world, "art_1");
    assert.deepEqual([row.revision_id, row.truncated, row.truncated_by, row.token_digest, row.term_count], ["rev_art_1", 1, label, "", 2], label);
    assertExact(world); assertClaims(world);
    assert.ok(W.counters(world)[scope] <= 7, `${label} never exceeds its bound`);
  }
  const world = setup();
  const live = (pid) => W.one(world, `SELECT (${lib.named(lib.SEARCH_WRITER_ELIGIBLE).sql.replace(/\?1/g, "'art_1'").replace(/\?2/g, "'rev_art_1'").replace(/\?3/g, `'${pid}'`)}) AS ok`).ok;
  assert.deepEqual(lib.named(lib.SEARCH_WRITER_ELIGIBLE).names, ["A", "R", "P"]);
  assert.equal(live("proj_a"), 1);
  W.run(world, "INSERT INTO principals (id, kind, issuer, subject, label, created_at) VALUES ('hum_l', 'human', 'synthetic', 'l', 'Synthetic', 'x')");
  W.run(world, "INSERT INTO projects (id, owner_id, title, created_at) VALUES ('proj_legacy', 'hum_l', 'Synthetic', 'x')");
  W.run(world, "UPDATE artifacts SET project_id = 'proj_legacy' WHERE id = 'art_2'");
  // No workspace row (legacy project): live. Through the real T1n: art_2 in the legacy project is admitted.
  const vl = base({ A: "art_2", R: "rev_art_2", P: "proj_legacy", W: "wsp_hum_l", O: "hum_l" });
  assert.equal(batch(world, [[S.T0, vl], [S.T1n, vl], [S.T1nc, vl]])[1], 1);
  for (const [why, sqlText] of [["deleted", "UPDATE projects SET deleted_at = 1, purge_at = 2 WHERE id = 'proj_a'"], ["purged", "UPDATE projects SET purged_at = 3 WHERE id = 'proj_a'"]]) {
    W.run(world, sqlText);
    assert.equal(batch(world, [[S.T0, base()], [S.T1n, base()], [S.T1nc, base()]])[1], 0, why);
  }
  W.run(world, "UPDATE projects SET deleted_at = NULL, purge_at = NULL, purged_at = NULL WHERE id = 'proj_a'");
  W.run(world, "UPDATE workspaces SET status = 'deleting' WHERE id = 'wsp_a'");
  assert.equal(batch(world, [[S.T0, base()], [S.T1n, base()], [S.T1nc, base()]])[1], 0, "deleting");
  assertExact(world);
});

test("test 3: changes() stays constant across the three-row counter UPDATE, including in its WHERE clause", () => {
  const world = setup();
  W.run(world, "INSERT INTO search_term_counters (scope, terms) VALUES ('w:wsp_a', 0), ('o:hum_a', 0), ('i', 0)");
  world.sql.exec("CREATE TEMP TABLE t4 (x INTEGER PRIMARY KEY)");
  world.sql.exec("INSERT INTO t4 (x) VALUES (1), (2), (3), (4)");
  exec(world, S.Ac, { W: "wsp_a", O: "hum_a" });
  assert.deepEqual(W.counters(world), { "w:wsp_a": 4, "o:hum_a": 4, i: 4 });
  world.sql.exec("DELETE FROM t4 WHERE x <= 2");
  exec(world, lib.lifecycleStatements(PATH_A).Kc, { W: "wsp_a", O: "hum_a" });
  assert.deepEqual(W.counters(world), { "w:wsp_a": 2, "o:hum_a": 2, i: 2 });
  world.sql.exec("DELETE FROM t4 WHERE x = 99");
  assert.equal(exec(world, lib.lifecycleStatements(PATH_A).Kc, { W: "wsp_a", O: "hum_a" }), 0, "Kc writes no row after a delete of nothing");
  assert.equal(exec(world, lib.lifecycleStatements(PATH_A).Xc, { W: "wsp_a", O: "hum_a" }), 0);
});

/** Purge-step bindings for one document (STILL_DUE as eligibility). */
const purgeValues = (world, artifact, pn, extra = {}) => {
  const r = W.docRow(world, artifact);
  return { PN: pn, P: "proj_a", NOW: 100, D: r.doc_id, W: r.workspace_id, O: r.owner_id, CHUNK: 5000, ...extra };
};
function purgeRound(world, artifact, pn, extra = {}) {
  const s = lib.lifecycleStatements(STILL_DUE_NAMED), v = purgeValues(world, artifact, pn, extra);
  const [l, k, kc, x, xc] = batch(world, [[s.L, v], [s.K, v], [s.Kc, v], [s.X, v], [s.Xc, v]]);
  return { l, k, kc, x, xc };
}
const markDue = (world) => W.run(world, "UPDATE projects SET deleted_at = 1, purge_at = 50 WHERE id = 'proj_a'");

test("test 3: X and Xc with a wrong bound ?W or ?O delete nothing and credit nothing; Kc and Xc then write no row", () => {
  const world = setup();
  indexNew(world, [tok(1)]);
  markDue(world);
  for (const bad of [{ W: "wsp_b" }, { O: "hum_b" }]) {
    const before = W.counters(world);
    const r = purgeRound(world, "art_1", "purge:a", bad);
    assert.deepEqual([r.l, r.k, r.kc, r.x, r.xc], [0, 0, 0, 0, 0], JSON.stringify(bad));
    assert.deepEqual(W.counters(world), before);
  }
  const r = purgeRound(world, "art_1", "purge:a");
  assert.deepEqual([r.l, r.k, r.kc, r.x, r.xc], [1, 1, 3, 1, 3]);
  assert.deepEqual(W.counters(world), {});
  assertExact(world);
});

test("test 4: interleavings keep every claiming row exact or clipped, and counters exact", () => {
  const world = setup();
  const X = base({ NONCE: "X" }), Y = base({ NONCE: "Y" });
  // X takes a new row and adds part of its target, then Y steals the lease (T1u), reads under it and completes.
  batch(world, [[S.T0, X], [S.T1n, X], [S.T1nc, X], [S.fresh.A, { ...X, ADD: JSON.stringify([tok(1), tok(2)]) }], [S.Ac, X], [S.Am, X]]);
  assertClaims(world); assertExact(world);
  assert.equal(exec(world, S.T1u, Y), 1);
  const leased = exec(world, S.LEASE_READ, Y);
  assert.deepEqual(leased.map((r) => r.writer), ["Y", "Y"]);
  assert.deepEqual(leased.map((r) => r.t), [tok(1), tok(2)]);
  // X's later statements fail $MINE, its T4 included.
  const late = batch(world, [[S.fresh.A, { ...X, ADD: JSON.stringify([tok(3)]) }], [S.Ac, X], [S.fresh.T4, { ...X, N: 3, REASON: "", DIGEST: "x" }]]);
  assert.deepEqual([late[0], late[2]], [0, 0]);
  assertExact(world);
  // Y's target is {2, 4}: remove 1, add 4.
  batch(world, [[S.fresh.R, { ...Y, REM: JSON.stringify([tok(1)]) }], [S.Rc, Y], [S.fresh.A, { ...Y, ADD: JSON.stringify([tok(4)]) }], [S.Ac, Y],
    [S.fresh.T4, { ...Y, N: 2, REASON: "", DIGEST: "y" }]]);
  assert.deepEqual(W.tokensOf(world, "art_1"), [tok(2), tok(4)]);
  assert.equal(W.docRow(world, "art_1").token_digest, "y");
  assertClaims(world); assertExact(world);
  // A later head: every statement of a writer on the old head fails $H.
  W.setHead(world, "art_1", "rev_2");
  const d = W.docRow(world, "art_1");
  assert.equal(exec(world, S.T1s, base({ NONCE: "Z", SEEN_DOC: d.doc_id, SEEN_GEN: d.gen })), 0);
  // Stable rewrite on the new head.
  const Z = base({ NONCE: "Z", R: "rev_2", D: d.doc_id, SEEN_DOC: d.doc_id, SEEN_GEN: d.gen });
  batch(world, [[S.T0, Z], [S.T1s, Z], [S.existing.R, { ...Z, REM: JSON.stringify([tok(2)]) }], [S.Rc, Z], [S.existing.T4, { ...Z, N: 1, REASON: "", DIGEST: "z" }]]);
  assert.deepEqual(W.tokensOf(world, "art_1"), [tok(4)]);
  assertClaims(world); assertExact(world);
});

test("test 4: purge reset, restore, writer completes, then the purge's next chunk deletes nothing", () => {
  const world = setup();
  indexNew(world, [tok(1), tok(2), tok(3)]);
  markDue(world);
  // The purge takes the lease and deletes one token.
  const s = lib.lifecycleStatements(STILL_DUE_NAMED);
  const pv = purgeValues(world, "art_1", "purge:p1", { CHUNK: 1 });
  batch(world, [[s.L, pv], [s.K, pv], [s.Kc, pv]]);
  assert.equal(W.tokensOf(world, "art_1").length, 2);
  assertExact(world);
  // Restored; a writer's T1u takes the lease, reads its exact base and completes its target {1, 2, 3}.
  W.run(world, "UPDATE projects SET deleted_at = NULL, purge_at = NULL WHERE id = 'proj_a'");
  const V = base({ NONCE: "V" });
  assert.equal(exec(world, S.T1u, V), 1);
  const have = exec(world, S.LEASE_READ, V).map((r) => r.t);
  const add = [tok(1), tok(2), tok(3)].filter((t) => !have.includes(t));
  batch(world, [[S.fresh.A, { ...V, ADD: JSON.stringify(add) }], [S.Ac, V], [S.fresh.T4, { ...V, N: 3, REASON: "", DIGEST: "v" }]]);
  assert.equal(W.docRow(world, "art_1").revision_id, "rev_art_1");
  // The purge's next chunk (project due again) deletes nothing: its lease is gone.
  markDue(world);
  const [k, kc, x, xc] = batch(world, [[s.K, pv], [s.Kc, pv], [s.X, pv], [s.Xc, pv]]);
  assert.deepEqual([k, kc, x, xc], [0, 0, 0, 0]);
  assert.equal(W.tokensOf(world, "art_1").length, 3);
  assertClaims(world); assertExact(world);
});

test("test 4: a sweep and an immediate purge alternating on one document both progress, counters exact", () => {
  const world = setup();
  indexNew(world, [tok(1), tok(2), tok(3), tok(4)]);
  markDue(world);
  let turn = 0;
  while (W.docRow(world, "art_1")) {
    const pn = turn % 2 ? "purge:cron" : "purge:now";
    const r = purgeRound(world, "art_1", pn, { CHUNK: 1 });
    assert.ok(r.k + r.x > 0, `turn ${turn} made progress`);
    assertExact(world);
    turn++;
  }
  assert.equal(turn, 4, "one token per turn; the last turn also deletes the row");
  assert.deepEqual(W.counters(world), {});
});

test("test 4: a writer marks the row clipped (Am) and dies; the next T1u resets it and T4 ends exact with its own reason", () => {
  const world = setup();
  const X = base({ NONCE: "X", WB: 7 });
  batch(world, [[S.T0, X], [S.T1n, X], [S.T1nc, X], [S.fresh.A, { ...X, ADD: JSON.stringify([tok(1), tok(2), tok(3)]) }], [S.Ac, X], [S.Am, X]]);
  assert.equal(W.docRow(world, "art_1").truncated_by, "workspace");
  const Y = base({ NONCE: "Y" });
  assert.equal(exec(world, S.T1u, Y), 1);
  assert.deepEqual([W.docRow(world, "art_1").truncated, W.docRow(world, "art_1").truncated_by], [0, ""]);
  batch(world, [[S.fresh.A, { ...Y, ADD: JSON.stringify([tok(3)]) }], [S.Ac, Y], [S.fresh.T4, { ...Y, N: 3, REASON: "cap", DIGEST: "y" }]]);
  const row = W.docRow(world, "art_1");
  assert.deepEqual([row.revision_id, row.truncated, row.truncated_by, row.token_digest], ["rev_art_1", 1, "cap", "y"]);
  assertClaims(world); assertExact(world);
});

test("test 20: the previous Worker's purge (STEPS and tombstone) then sweep path A removes the rows and credits exactly", () => {
  const world = setup();
  indexNew(world, [tok(1), tok(2)]);
  indexNew(world, [tok(3)], base({ A: "art_2", R: "rev_art_2" }));
  // The previous Worker purges: artifacts and revisions go, the project is tombstoned; token rows stay.
  W.run(world, "DELETE FROM artifacts WHERE project_id = 'proj_a'");
  W.run(world, "UPDATE projects SET deleted_at = 1, purge_at = 2, purged_at = 3, title = 'Deleted project' WHERE id = 'proj_a'");
  assertExact(world);
  const s = lib.lifecycleStatements(PATH_A);
  for (const r of W.all(world, "SELECT doc_id, workspace_id, owner_id FROM search_token_docs WHERE project_id IN ('proj_a')")) {
    const v = { PN: "purge:sweep", P: "proj_a", D: r.doc_id, W: r.workspace_id, O: r.owner_id, CHUNK: 5000 };
    batch(world, [[s.L, v], [s.K, v], [s.Kc, v], [s.X, v], [s.Xc, v]]);
    assertExact(world);
  }
  assert.equal(W.one(world, "SELECT COUNT(*) AS n FROM search_token_docs").n, 0);
  assert.deepEqual(W.counters(world), {});
});

test("test 26: a dead writer between two caps never leaves more than its bound; the oversize delete holds its own lease", () => {
  // Size invariant at a small scale: base 6 tokens, target 6 different tokens, chunks of 2 values; removes go first, so
  // after every batch adds <= removes + max(0, |target| − |base|), and the set never exceeds 6.
  const world = setup();
  const baseSet = [1, 2, 3, 4, 5, 6].map(tok), target = [11, 12, 13, 14, 15, 16].map(tok);
  indexNew(world, baseSet);
  const d = W.docRow(world, "art_1");
  const V = base({ NONCE: "V", D: d.doc_id, SEEN_DOC: d.doc_id, SEEN_GEN: d.gen });
  exec(world, S.T1s, V);
  for (let i = 0; i < 6; i += 2) {
    batch(world, [[S.existing.R, { ...V, REM: JSON.stringify(baseSet.slice(i, i + 2)) }], [S.Rc, V], [S.existing.A, { ...V, ADD: JSON.stringify(target.slice(i, i + 2)) }], [S.Ac, V]]);
    assert.ok(W.tokensOf(world, "art_1").length <= 6);
    assertExact(world);
    if (i === 2) break; // the writer dies here
  }
  assert.equal(W.docRow(world, "art_1").revision_id, "", "dead writer leaves the row missing");
  assert.ok(W.missing(world).includes("art_1"));
  // Oversize path: under the writer's own lease, K/Kc with $H AND $LIVE delete the whole set in chunks.
  const s = lib.lifecycleStatements(lib.SEARCH_WRITER_ELIGIBLE);
  const ov = { PN: "V", A: "art_1", R: "rev_art_1", P: "proj_a", D: d.doc_id, W: "wsp_a", O: "hum_a", CHUNK: 3 };
  assert.equal(exec(world, s.K, { ...ov, PN: "not-mine" }), 0, "another lease deletes nothing");
  while (batch(world, [[s.K, ov], [s.Kc, ov]])[0] > 0) assertExact(world);
  assert.equal(W.tokensOf(world, "art_1").length, 0);
  const row = W.docRow(world, "art_1");
  assert.deepEqual([row.revision_id, row.writer], ["", "V"]);
  assertExact(world);
});
