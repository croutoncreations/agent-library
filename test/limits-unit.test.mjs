// Limits internals against the real packages/core/src/ bundle (node:sqlite with every migration, no server): the
// PLAN_LIMITS owned_workspaces fallback, the backup import's per-import document cap, the per-request plan memo
// (agent rate limits read each workspace's plan once per request, never across requests) and migration 0026's
// indexes for the comments cursor, a project's audit list and the owned-workspaces count. Synthetic data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadWorker } from "./load-worker.mjs";
import { ROOT } from "./helpers.mjs";

const lib = await loadWorker({
  "limits.js": ["planEntitlements", "workspaceLimits", "withRequestMemo"], "adapters.js": ["withAdapters", "resolveAdapters"],
  "auth.js": ["agentRate"], "backup.js": ["checkImportRows", "IMPORT_MAX_ROWS"]
});

function mkDB() {
  const sql = new DatabaseSync(":memory:");
  for (const f of readdirSync(join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort()) sql.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  const reads = [];
  const stmt = (q, p) => ({ async first(c) { reads.push(q); const r = sql.prepare(q).get(...p); return c ? r?.[c] ?? null : r ?? null; },
    async all() { reads.push(q); return { results: sql.prepare(q).all(...p) }; } });
  const DB = { prepare: (q) => ({ ...stmt(q, []), bind: (...p) => stmt(q, p) }) };
  const at = new Date().toISOString();
  sql.prepare("INSERT INTO principals (id, kind, issuer, subject, label, created_at) VALUES ('hum_o','human','synthetic','o','Owner',?)").run(at);
  sql.prepare("INSERT INTO workspaces (id, name, personal, status, plan, created_by, created_at) VALUES ('wsp_hum_o','Personal',1,'active','free','hum_o',?) ON CONFLICT (id) DO UPDATE SET plan = 'free'").run(at);
  return { sql, DB, reads };
}
const PLANS = { free: { owned_workspaces: 1, rate_multiplier: 1 }, pro: { projects: 50, rate_multiplier: 2 } };

test("owned_workspaces: a listed plan without the key is unlimited; an unlisted plan uses free's", async () => {
  const { sql, DB } = mkDB();
  const env = { DB, PLAN_LIMITS: JSON.stringify(PLANS) };
  const owned = async () => (await lib.planEntitlements.limits(env, { principalId: "hum_o" })).owned_workspaces;
  assert.equal(await owned(), 1);
  sql.prepare("UPDATE workspaces SET plan = 'pro' WHERE id = 'wsp_hum_o'").run();
  assert.equal(await owned(), undefined, "pro lists no owned_workspaces: unlimited");
  sql.prepare("UPDATE workspaces SET plan = 'legacy-unlisted' WHERE id = 'wsp_hum_o'").run();
  assert.equal(await owned(), 1, "an unlisted plan falls back to free");
});

test("backup import: at most IMPORT_MAX_ROWS (2,000) documents and files per import, whatever the plan allows", () => {
  assert.equal(lib.IMPORT_MAX_ROWS, 2000);
  const backup = (n) => ({ artifacts: Array.from({ length: n }, (_, i) => ({ id: `art_${i}`, kind: "markdown", title: "t", head_rev: 1, meta_version: 1, created_at: "x", updated_at: "x" })), revisions: [], comments: [] });
  assert.throws(() => lib.checkImportRows({}, backup(2001), new Map(), { items_per_project: 10000 }),
    (e) => e.code === "bad_backup" && e.message === "One import can bring in at most 2,000 documents and files");
  // The plan's smaller number is reported first.
  assert.throws(() => lib.checkImportRows({}, backup(2001), new Map(), { items_per_project: 100 }), /at most 100 documents and files on this plan/);
  // 2,000 passes the count checks (these synthetic rows then fail a later field check, which is fine here).
  assert.throws(() => lib.checkImportRows({}, backup(2000), new Map(), { items_per_project: 10000 }), (e) => !/at most/.test(e.message));
});

test("agent rate limits read a workspace's plan once per request; a new request reads it again", async () => {
  const { sql, DB, reads } = mkDB();
  const base = lib.withAdapters({ DB, PLAN_LIMITS: JSON.stringify(PLANS) }, lib.resolveAdapters({ entitlements: lib.planEntitlements }));
  const planReads = () => reads.filter((q) => /SELECT plan FROM workspaces/.test(q)).length;
  const req1 = lib.withRequestMemo(base);
  assert.equal(await lib.agentRate(req1, "wsp_hum_o", true), 60);
  assert.equal(await lib.agentRate(req1, "wsp_hum_o", false), 240);
  await lib.workspaceLimits(req1, "wsp_hum_o");
  assert.equal(planReads(), 1, "one plan read for the whole request");
  sql.prepare("UPDATE workspaces SET plan = 'pro' WHERE id = 'wsp_hum_o'").run();
  assert.equal(await lib.agentRate(lib.withRequestMemo(base), "wsp_hum_o", true), 120, "the next request sees the new plan");
  assert.equal(planReads(), 2);
  // Without a request memo (cron, direct calls) nothing is cached.
  await lib.workspaceLimits(base, "wsp_hum_o"); await lib.workspaceLimits(base, "wsp_hum_o");
  assert.equal(planReads(), 4);
});

test("migration 0026: the comments cursor, a project's audit list and the owned-workspaces count use indexes", () => {
  const { sql } = mkDB();
  const plan = (q, ...p) => sql.prepare(`EXPLAIN QUERY PLAN ${q}`).all(...p).map((r) => r.detail).join(" | ");
  const comments = plan(`SELECT c.id FROM comments c WHERE c.artifact_id = ? AND c.project_id = ? AND (c.created_at, c.id) < (?, ?) ORDER BY c.created_at DESC, c.id DESC LIMIT 201`, "a", "p", "z", "z");
  assert.match(comments, /USING (COVERING )?INDEX comments_artifact/, comments);
  assert.doesNotMatch(comments, /TEMP B-TREE/, comments);
  const audits = plan("SELECT seq FROM audits WHERE project_id = ? ORDER BY seq DESC LIMIT 201", "p");
  assert.match(audits, /INDEX audits_project/, audits);
  assert.doesNotMatch(audits, /TEMP B-TREE/, audits);
  const owned = plan("SELECT COUNT(*) FROM workspaces w WHERE w.created_by = ? AND w.personal = 0 AND w.status <> 'deleting'", "hum_o");
  assert.match(owned, /INDEX workspaces_created_by/, owned);
});
