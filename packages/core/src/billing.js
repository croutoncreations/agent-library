// Billing state for hosted installations (docs/limits.md#billing). Provider-neutral: a billing adapter (hosted:
// Stripe) verifies the provider's webhook, maps it to a change and calls applyBillingChange(). Core owns what a change
// does to the workspace, in one batch:
//   - replay-safe: each provider event id is applied at most once (billing_events primary key);
//   - ordered: an event older than the last applied one changes nothing (last_event_at);
//   - paid plan -> workspaces.plan; lapsed/cancelled -> 'free' (over-limit data is kept: D19);
//   - payment failure (provider says unpaid) -> status 'suspended' (read-only, D11/D13), and only billing lifts a
//     suspension billing set (suspended_by_billing), never an operator's own suspension.
import { HttpError, nowIso, randomId } from "./util.js";

/**
 * Provider statuses that make the workspace read-only until paid (D11 B / D13 A): a renewal that stayed unpaid after
 * the provider's retries (Stripe: set "if all retries fail: mark the subscription as unpaid"). A first payment that
 * never completed (incomplete_expired) is not a debt: the workspace just stays on its old plan.
 */
export const SUSPENDING = new Set(["unpaid"]);
/** Statuses where a subscription is over (a new one may replace it). */
export const ENDED = new Set(["canceled", "incomplete_expired"]);
/** Provider statuses where the paid plan applies (past_due: the provider is still retrying the payment). */
export const PAID = new Set(["active", "trialing", "past_due"]);
const ID = /^[A-Za-z0-9_-]{1,200}$/;
const PLAN = /^[a-z0-9_-]{1,40}$/;

/**
 * Apply one verified provider event: the subscription's current state. change: { provider, eventId, eventType,
 * eventAt (ms), workspaceId, customerId, subscriptionId, status, plan (the plan this subscription is for, or null),
 * periodEnd? (ms) }. Returns { applied: boolean, reason? }; reasons: duplicate, no_workspace, stale,
 * other_customer (the workspace's stored customer differs), other_subscription (the workspace already has another
 * open subscription: the provider is charging for a duplicate; refund it).
 * A workspace has at most one billing customer (never overwritten) and one open subscription at a time.
 */
export async function applyBillingChange(env, c) {
  for (const k of ["provider", "eventId", "eventType", "workspaceId"]) if (typeof c[k] !== "string" || !ID.test(c[k].replace(/\./g, "_"))) throw new HttpError(400, "invalid_input", `bad ${k}`);
  if (!Number.isSafeInteger(c.eventAt) || c.eventAt < 0) throw new HttpError(400, "invalid_input", "bad eventAt");
  for (const k of ["customerId", "subscriptionId"]) if (typeof c[k] !== "string" || !ID.test(c[k])) throw new HttpError(400, "invalid_input", `bad ${k}`);
  if (c.plan != null && !PLAN.test(c.plan)) throw new HttpError(400, "invalid_input", "bad plan");
  if (typeof c.status !== "string" || !/^[a-z_]{1,40}$/.test(c.status)) throw new HttpError(400, "invalid_input", "bad status");
  const DB = env.DB, now = nowIso(), ws = c.workspaceId, nonce = randomId("bev", 12);
  const exists = await DB.prepare("SELECT status FROM workspaces WHERE id = ?").bind(ws).first("status");
  // Unknown or deleting workspaces: the event is recorded (so redelivery is a no-op) and nothing else changes.
  const live = exists === "active" || exists === "suspended";
  // The plan in force: the subscription's plan while it's paid, else free.
  const plan = PAID.has(c.status) && c.plan ? c.plan : "free";
  const suspend = SUSPENDING.has(c.status) ? 1 : 0;
  // Every statement after the first runs only if this call recorded the event (received_at carries this call's nonce,
  // so a redelivery changes nothing), the event is not older than the last one applied (ties apply: adapters send the
  // subscription's current state, fetched from the provider), the customer is the stored one (or none is stored yet),
  // and the subscription is the stored one (or the stored one has ended).
  const mine = "EXISTS (SELECT 1 FROM billing_events WHERE provider = ? AND event_id = ? AND received_at = ?)";
  const fits = `NOT EXISTS (SELECT 1 FROM workspace_billing b WHERE b.workspace_id = ? AND (b.last_event_at > ?
      OR (b.customer_id IS NOT NULL AND b.customer_id <> ?)
      OR (b.subscription_id IS NOT NULL AND b.subscription_id <> ? AND COALESCE(b.subscription_status, 'canceled') NOT IN ('canceled', 'incomplete_expired'))))`;
  const gate = `${mine} AND ${fits}`;
  const gp = [c.provider, c.eventId, `${now} ${nonce}`, ws, c.eventAt, c.customerId, c.subscriptionId];
  const stmts = [
    DB.prepare("INSERT OR IGNORE INTO billing_events (provider, event_id, type, workspace_id, received_at) VALUES (?, ?, ?, ?, ?)")
      .bind(c.provider, c.eventId, c.eventType, ws, `${now} ${nonce}`)
  ];
  if (live) {
    stmts.push(
      // workspace_billing.plan is the subscription's plan (shown while payment is due); workspaces.plan is the one in force.
      DB.prepare(`INSERT INTO workspace_billing (workspace_id, provider, customer_id, subscription_id, subscription_status, plan, current_period_end, suspended_by_billing, last_event_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, 0, ?, ? WHERE ${gate}
        ON CONFLICT (workspace_id) DO UPDATE SET customer_id = COALESCE(customer_id, excluded.customer_id),
          subscription_id = excluded.subscription_id, subscription_status = excluded.subscription_status, plan = excluded.plan,
          current_period_end = COALESCE(excluded.current_period_end, current_period_end),
          last_event_at = MAX(last_event_at, excluded.last_event_at), updated_at = excluded.updated_at`)
        .bind(ws, c.provider, c.customerId, c.subscriptionId, c.status, c.plan ?? null, c.periodEnd ?? null, c.eventAt, now, ...gp)
    );
    {
      // After the upsert: applies only if this call recorded the event and the upsert stored this subscription's state.
      const g2 = `${mine} AND (SELECT last_event_at = ? AND subscription_id = ? FROM workspace_billing WHERE workspace_id = ?)`;
      const gp2 = [c.provider, c.eventId, `${now} ${nonce}`, c.eventAt, c.subscriptionId, ws];
      const flag = (sql, ...p) => DB.prepare(`UPDATE workspace_billing SET suspended_by_billing = ${sql} WHERE workspace_id = ? AND ${g2}`).bind(...p, ws, ...gp2);
      stmts.push(DB.prepare(`UPDATE workspaces SET plan = ? WHERE id = ? AND status <> 'deleting' AND ${g2}`).bind(plan ?? "free", ws, ...gp2));
      if (suspend) stmts.push(
        // Billing owns the suspension only if it is the one suspending (an operator's suspension stays theirs).
        flag("CASE WHEN (SELECT status FROM workspaces WHERE id = ?) = 'active' THEN 1 ELSE suspended_by_billing END", ws),
        DB.prepare(`UPDATE workspaces SET status = 'suspended' WHERE id = ? AND status = 'active' AND ${g2}`).bind(ws, ...gp2)
      );
      else stmts.push(
        DB.prepare(`UPDATE workspaces SET status = 'active' WHERE id = ? AND status = 'suspended' AND ${g2}
            AND (SELECT suspended_by_billing FROM workspace_billing WHERE workspace_id = ?) = 1`).bind(ws, ...gp2, ws),
        flag("0")
      );
      stmts.push(DB.prepare(`INSERT INTO audits (at, actor_id, project_id, action, object_id, result, request_id, workspace_id)
          SELECT ?, 'system:billing', NULL, 'workspace.billing', ?, ?, ?, ? WHERE ${g2}`)
        .bind(now, c.eventId, `${c.status}:${plan ?? "free"}${suspend ? ":suspended" : ""}`.slice(0, 120), "billing:" + c.eventId.slice(0, 80), ws, ...gp2));
    }
  }
  const res = await DB.batch(stmts);
  if (!res[0].meta.changes) return { applied: false, reason: "duplicate" };
  if (!live) return { applied: false, reason: "no_workspace" };
  if (!res[1].meta.changes) {
    const b = await DB.prepare("SELECT customer_id, subscription_id, subscription_status, last_event_at FROM workspace_billing WHERE workspace_id = ?").bind(ws).first();
    const reason = b && b.customer_id && b.customer_id !== c.customerId ? "other_customer"
      : b && b.subscription_id !== c.subscriptionId && !ENDED.has(b.subscription_status ?? "canceled") ? "other_subscription" : "stale";
    if (reason !== "stale") console.error("billing_event_refused", reason, c.provider, c.eventId);
    return { applied: false, reason };
  }
  return { applied: true };
}

/**
 * The workspace's billing customer: stores customerId if none is stored yet and returns the stored one (an earlier
 * one wins, so concurrent checkouts share a customer). Call before sending anyone to the provider's checkout.
 */
export async function linkBillingCustomer(env, workspaceId, provider, customerId) {
  if (typeof customerId !== "string" || !ID.test(customerId)) throw new HttpError(400, "invalid_input", "bad customerId");
  await env.DB.prepare(`INSERT INTO workspace_billing (workspace_id, provider, customer_id, suspended_by_billing, last_event_at, updated_at)
      SELECT ?, ?, ?, 0, 0, ? WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND status IN ('active','suspended'))
      ON CONFLICT (workspace_id) DO UPDATE SET customer_id = COALESCE(customer_id, excluded.customer_id)`)
    .bind(workspaceId, provider, customerId, nowIso(), workspaceId).run();
  return env.DB.prepare("SELECT customer_id FROM workspace_billing WHERE workspace_id = ?").bind(workspaceId).first("customer_id");
}

/** Billing row of a workspace (for the app and the billing adapter). */
export async function workspaceBilling(env, workspaceId) {
  return env.DB.prepare("SELECT provider, customer_id, subscription_id, subscription_status, plan, current_period_end, suspended_by_billing FROM workspace_billing WHERE workspace_id = ?")
    .bind(workspaceId).first();
}
