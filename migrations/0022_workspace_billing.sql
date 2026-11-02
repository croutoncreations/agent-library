-- Workspace billing state (hosted installations; docs/limits.md#billing). Provider-neutral: the hosted billing adapter
-- (Stripe) writes it from verified webhooks; self-host never uses it. Additive and retry-safe.
CREATE TABLE IF NOT EXISTS workspace_billing (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
  provider TEXT NOT NULL,                       -- e.g. 'stripe'
  customer_id TEXT,
  subscription_id TEXT,
  subscription_status TEXT,                     -- provider's status (active, past_due, unpaid, canceled, ...)
  plan TEXT,                                    -- plan the subscription pays for (mirrored into workspaces.plan)
  current_period_end INTEGER,                   -- ms
  suspended_by_billing INTEGER NOT NULL DEFAULT 0 CHECK (suspended_by_billing IN (0,1)),
  last_event_at INTEGER NOT NULL DEFAULT 0,     -- provider event time (ms) of the last applied change: older events are ignored
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_billing_customer ON workspace_billing(provider, customer_id) WHERE customer_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS workspace_billing_subscription ON workspace_billing(provider, subscription_id) WHERE subscription_id IS NOT NULL;

-- Webhook events already processed (replay safety: a redelivered event changes nothing).
CREATE TABLE IF NOT EXISTS billing_events (
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  type TEXT NOT NULL,
  workspace_id TEXT,
  received_at TEXT NOT NULL,                    -- ISO time + ' ' + a per-call nonce (marks which call recorded it)
  PRIMARY KEY (provider, event_id)
);
