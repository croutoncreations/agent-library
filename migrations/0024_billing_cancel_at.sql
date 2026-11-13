-- When a subscription is set to end (e.g. cancelled at period end in the provider's portal): ms, NULL = renews.
-- Additive and retry-safe through the deploy pipeline's applied-migrations tracking; the previous Worker ignores it.
ALTER TABLE workspace_billing ADD COLUMN cancel_at INTEGER;
