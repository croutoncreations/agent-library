-- Indexes for the cron's retention deletes (cleanup.js pruneExpiredRows): expired sessions, idempotency records older
-- than 30 days and audits older than AUDIT_RETENTION_DAYS. Each delete picks its oldest rows by these columns, so it
-- reads only the rows it removes instead of scanning the table every 15 minutes.
-- Additive only: new indexes. The previous Worker never relies on them.
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idempotency_created ON idempotency(created_at);
CREATE INDEX IF NOT EXISTS audits_at ON audits(at);
