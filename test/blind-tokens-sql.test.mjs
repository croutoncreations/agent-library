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
