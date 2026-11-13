-- The cron's orphan-placeholder cleanup and uploadBegin's per-project reconcile (cleanup.js deleteOrphanPlaceholders)
-- select head-0 artifacts of every kind. This partial index avoids reading published artifacts on either path.
-- Additive only: one new index. The previous Worker never relies on it; the binary-only 0027 index stays in place.
CREATE INDEX IF NOT EXISTS artifacts_unpublished ON artifacts(project_id) WHERE head_rev = 0;
