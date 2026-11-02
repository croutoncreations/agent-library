// Billing state for hosted installations (docs/limits.md#billing). Provider-neutral: a billing adapter (hosted:
// Stripe) verifies the provider's webhook, maps it to a change and calls applyBillingChange(). Core owns what a change
// does to the workspace, in one batch:
//   - replay-safe: each provider event id is applied at most once (billing_events primary key);
//   - ordered: an event older than the last applied one changes nothing (last_event_at);
//   - paid plan -> workspaces.plan; lapsed/cancelled -> 'free' (over-limit data is kept: D19);
//   - payment failure (provider says unpaid) -> status 'suspended' (read-only, D11/D13), and only billing lifts a
//     suspension billing set (suspended_by_billing), never an operator's own suspension.
import { HttpError, nowIso, randomId } from "./util.js";

/** Provider statuses that make the workspace read-only until paid (D11 B / D13 A). */
export const SUSPENDING = new Set(["unpaid", "incomplete_expired"]);
/** Provider statuses where the paid plan applies (past_due: the provider is still retrying the payment). */
export const PAID = new Set(["active", "trialing", "past_due"]);
const ID = /^[A-Za-z0-9_-]{1,200}$/;
const PLAN = /^[a-z0-9_-]{1,40}$/;

/**
 * Apply one verified provider event. change: { provider, eventId, eventType, eventAt (ms), workspaceId,
 * customerId?, subscriptionId?, status?, plan?, periodEnd? (ms) }. status/plan absent = only link the customer.
 * Returns { applied: boolean, reason? }.
 */
export async function applyBillingChange(env, c) {
  for (const k of ["provider", "eventId", "eventType", "workspaceId"]) if (typeof c[k] !== "string" || !ID.test(c[k].replace(/\./g, "_"))) throw new HttpError(400, "invalid_input", `bad ${k}`);
  if (!Number.isSafeInteger(c.eventAt) || c.eventAt < 0) throw new HttpError(400, "invalid_input", "bad eventAt");
  for (const k of ["customerId", "subscriptionId"]) if (c[k] != null && (typeof c[k] !== "string" || !ID.test(c[k]))) throw new HttpError(400, "invalid_input", `bad ${k}`);
  if (c.plan != null && !PLAN.test(c.plan)) throw new HttpError(400, "invalid_input", "bad plan");
  if (c.status != null && !/^[a-z_]{1,40}$/.test(c.status)) throw new HttpError(400, "invalid_input", "bad status");
  const DB = env.DB, now = nowIso(), ws = c.workspaceId, nonce = randomId("bev", 12);
  const exists = await DB.prepare("SELECT status FROM workspaces WHERE id = ?").bind(ws).first("status");
  // Unknown or deleting workspaces: the event is recorded (so redelivery is a no-op) and nothing else changes.
  const live = exists === "active" || exists === "suspended";
  const plan = c.status == null ? null : PAID.has(c.status) ? c.plan ?? null : "free";
  const suspend = c.status != null && SUSPENDING.has(c.status) ? 1 : 0;
  // Every statement after the first runs only if this call recorded the event and, for status changes, the event is
  // not older than the last status applied (ties apply; adapters should send the subscription's current state,
  // fetched from the provider, so a tie or reordering can't apply a stale state). Customer links carry no status and
  // don't move last_event_at.
  const fresh = c.status == null ? "? IS NOT NULL AND ? IS NOT NULL" : "(SELECT COALESCE(MAX(last_event_at), -1) FROM workspace_billing WHERE workspace_id = ?) <= ?";
  // received_at carries this call's nonce, so "the event row has my nonce" = this call recorded it (not a replay).
  const mine = "EXISTS (SELECT 1 FROM billing_events WHERE provider = ? AND event_id = ? AND received_at = ?)";
  const gate = `${mine} AND ${fresh}`;
  const gp = [c.provider, c.eventId, `${now} ${nonce}`, ws, c.eventAt];
  const stmts = [
    DB.prepare("INSERT OR IGNORE INTO billing_events (provider, event_id, type, workspace_id, received_at) VALUES (?, ?, ?, ?, ?)")
      .bind(c.provider, c.eventId, c.eventType, ws, `${now} ${nonce}`)
  ];
  if (live) {
    stmts.push(
      DB.prepare(`INSERT INTO workspace_billing (workspace_id, provider, customer_id, subscription_id, subscription_status, plan, current_period_end, suspended_by_billing, last_event_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, 0, ?, ? WHERE ${gate}
        ON CONFLICT (workspace_id) DO UPDATE SET customer_id = COALESCE(excluded.customer_id, customer_id),
          subscription_id = COALESCE(excluded.subscription_id, subscription_id),
          subscription_status = COALESCE(excluded.subscription_status, subscription_status),
          plan = CASE WHEN excluded.subscription_status IS NULL THEN plan ELSE excluded.plan END,
          current_period_end = COALESCE(excluded.current_period_end, current_period_end),
          last_event_at = MAX(last_event_at, excluded.last_event_at), updated_at = excluded.updated_at`)
        .bind(ws, c.provider, c.customerId ?? null, c.subscriptionId ?? null, c.status ?? null, plan, c.periodEnd ?? null, c.status == null ? 0 : c.eventAt, now, ...gp)
    );
    if (c.status != null) {
      // After the upsert: applies only if this call recorded the event and the upsert made it the latest.
      const g2 = `${mine} AND (SELECT last_event_at FROM workspace_billing WHERE workspace_id = ?) = ?`;
      const flag = (sql, ...p) => DB.prepare(`UPDATE workspace_billing SET suspended_by_billing = ${sql} WHERE workspace_id = ? AND ${g2}`).bind(...p, ws, ...gp);
      stmts.push(DB.prepare(`UPDATE workspaces SET plan = ? WHERE id = ? AND status <> 'deleting' AND ${g2}`).bind(plan ?? "free", ws, ...gp));
      if (suspend) stmts.push(
        // Billing owns the suspension only if it is the one suspending (an operator's suspension stays theirs).
        flag("CASE WHEN (SELECT status FROM workspaces WHERE id = ?) = 'active' THEN 1 ELSE suspended_by_billing END", ws),
        DB.prepare(`UPDATE workspaces SET status = 'suspended' WHERE id = ? AND status = 'active' AND ${g2}`).bind(ws, ...gp)
      );
      else stmts.push(
        DB.prepare(`UPDATE workspaces SET status = 'active' WHERE id = ? AND status = 'suspended' AND ${g2}
            AND (SELECT suspended_by_billing FROM workspace_billing WHERE workspace_id = ?) = 1`).bind(ws, ...gp, ws),
        flag("0")
      );
      stmts.push(DB.prepare(`INSERT INTO audits (at, actor_id, project_id, action, object_id, result, request_id, workspace_id)
          SELECT ?, 'system:billing', NULL, 'workspace.billing', ?, ?, ?, ? WHERE ${g2}`)
        .bind(now, c.eventId, `${c.status}:${plan ?? "free"}${suspend ? ":suspended" : ""}`.slice(0, 120), "billing:" + c.eventId.slice(0, 80), ws, ...gp));
    }
  }
  const res = await DB.batch(stmts);
  if (!res[0].meta.changes) return { applied: false, reason: "duplicate" };
  if (!live) return { applied: false, reason: "no_workspace" };
  if (!res[1].meta.changes) return { applied: false, reason: "stale" };
  return { applied: true };
}

/** Billing row of a workspace (for the app and the billing adapter). */
export async function workspaceBilling(env, workspaceId) {
  return env.DB.prepare("SELECT provider, customer_id, subscription_id, subscription_status, plan, current_period_end, suspended_by_billing FROM workspace_billing WHERE workspace_id = ?")
    .bind(workspaceId).first();
}
