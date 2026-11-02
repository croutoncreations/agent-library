// Core billing state (docs/limits.md#billing): applyBillingChange against the real migrations in node:sqlite (D1's
// engine). Replays change nothing, older events don't undo newer ones, payment failure suspends (read-only) and paying
// again lifts only a billing suspension, plans never delete data. Synthetic data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadWorker } from "./load-worker.mjs";
import { ROOT } from "./helpers.mjs";

const lib = await loadWorker({ "billing.js": ["applyBillingChange", "workspaceBilling"] });

function mkDB() {
  const sql = new DatabaseSync(":memory:");
  sql.exec("PRAGMA foreign_keys = ON");
  for (const f of readdirSync(join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort()) sql.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  const stmt = (q, p) => ({ q, p,
    async first(c) { const r = sql.prepare(q).get(...p); return c ? r?.[c] ?? null : r ?? null; },
    async all() { return { results: sql.prepare(q).all(...p) }; },
    async run() { const r = sql.prepare(q).run(...p); return { meta: { changes: Number(r.changes) } }; } });
  const DB = { prepare: (q) => ({ ...stmt(q, []), bind: (...p) => stmt(q, p) }),
    async batch(list) {
      sql.exec("BEGIN");
      try { const out = list.map((s) => ({ meta: { changes: Number(sql.prepare(s.q).run(...s.p).changes) } })); sql.exec("COMMIT"); return out; }
      catch (e) { sql.exec("ROLLBACK"); throw e; }
    } };
  const at = new Date().toISOString();
  sql.prepare("INSERT INTO principals (id, kind, issuer, subject, label, created_at) VALUES ('hum_o','human','synthetic','o','Owner',?)").run(at);
  sql.prepare("INSERT INTO workspaces (id, name, personal, status, plan, created_by, created_at) VALUES ('wsp_team','Team',0,'active','free','hum_o',?)").run(at);
  return { sql, env: { DB } };
}
const ws = (sql) => ({ ...sql.prepare("SELECT status, plan FROM workspaces WHERE id = 'wsp_team'").get() });
let n = 0;
const ev = (over) => ({ provider: "stripe", eventId: `evt_${++n}`, eventType: "customer.subscription.updated", eventAt: 1_000_000 + n * 1000, workspaceId: "wsp_team", customerId: "cus_1", subscriptionId: "sub_1", ...over });

test("paid plan applies; a redelivered event changes nothing", async () => {
  const { sql, env } = mkDB();
  const e = ev({ status: "active", plan: "pro", periodEnd: 2e12 });
  assert.deepEqual(await lib.applyBillingChange(env, e), { applied: true });
  assert.deepEqual(ws(sql), { status: "active", plan: "pro" });
  sql.prepare("UPDATE workspaces SET plan = 'manual' WHERE id = 'wsp_team'").run();
  assert.deepEqual(await lib.applyBillingChange(env, e), { applied: false, reason: "duplicate" });
  assert.equal(ws(sql).plan, "manual", "replay did nothing");
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM audits WHERE action = 'workspace.billing'").get().n, 1);
});

test("an older event can't undo a newer one", async () => {
  const { sql, env } = mkDB();
  const old = ev({ status: "active", plan: "pro" }), newer = ev({ status: "canceled", plan: null });
  await lib.applyBillingChange(env, newer);
  assert.deepEqual(ws(sql), { status: "active", plan: "free" });
  assert.deepEqual(await lib.applyBillingChange(env, old), { applied: false, reason: "stale" });
  assert.equal(ws(sql).plan, "free");
});

test("payment failure suspends (read-only); paying lifts it; an operator suspension is never lifted by billing", async () => {
  const { sql, env } = mkDB();
  await lib.applyBillingChange(env, ev({ status: "active", plan: "pro" }));
  await lib.applyBillingChange(env, ev({ status: "past_due", plan: "pro" }));
  assert.deepEqual(ws(sql), { status: "active", plan: "pro" }, "past_due: still retrying, still paid");
  await lib.applyBillingChange(env, ev({ status: "unpaid", plan: "pro" }));
  assert.deepEqual(ws(sql), { status: "suspended", plan: "free" });
  assert.equal((await lib.workspaceBilling(env, "wsp_team")).suspended_by_billing, 1);
  await lib.applyBillingChange(env, ev({ status: "active", plan: "pro" }));
  assert.deepEqual(ws(sql), { status: "active", plan: "pro" });
  // Operator suspends; billing failure then recovery must leave the operator's suspension in place.
  sql.prepare("UPDATE workspaces SET status = 'suspended' WHERE id = 'wsp_team'").run();
  await lib.applyBillingChange(env, ev({ status: "unpaid", plan: "pro" }));
  assert.equal((await lib.workspaceBilling(env, "wsp_team")).suspended_by_billing, 0);
  await lib.applyBillingChange(env, ev({ status: "active", plan: "pro" }));
  assert.equal(ws(sql).status, "suspended", "operator suspension kept");
});

test("deleting or unknown workspaces: recorded, nothing changes; bad input refused", async () => {
  const { sql, env } = mkDB();
  sql.prepare("UPDATE workspaces SET status = 'deleting' WHERE id = 'wsp_team'").run();
  assert.deepEqual(await lib.applyBillingChange(env, ev({ status: "active", plan: "pro" })), { applied: false, reason: "no_workspace" });
  assert.equal(ws(sql).plan, "free");
  assert.deepEqual(await lib.applyBillingChange(env, ev({ workspaceId: "wsp_nope", status: "active", plan: "pro" })), { applied: false, reason: "no_workspace" });
  await assert.rejects(lib.applyBillingChange(env, ev({ status: "active", plan: "Pro; DROP" })), /bad plan/);
  await assert.rejects(lib.applyBillingChange(env, ev({ eventAt: -1 })), /bad eventAt/);
});
