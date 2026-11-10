-- Indexes for the cron's retention deletes (cleanup.js pruneExpiredRows): expired sessions, idempotency records older
-- than 30 days and audits older than AUDIT_RETENTION_DAYS. Each delete picks its oldest rows by these columns, so it
-- reads only the rows it removes instead of scanning the table every 15 minutes.
-- Also: the comments cursor (service.js listComments, newest first by created_at, id), a project's audit list
-- (service.js listAudit, newest seq first) and the owned_workspaces limit (limits.js, shared workspaces per creator).
-- Additive only: new indexes. The previous Worker never relies on them.
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idempotency_created ON idempotency(created_at);
CREATE INDEX IF NOT EXISTS audits_at ON audits(at);
CREATE INDEX IF NOT EXISTS comments_artifact ON comments(artifact_id, project_id, created_at, id);
CREATE INDEX IF NOT EXISTS audits_project ON audits(project_id, seq);
CREATE INDEX IF NOT EXISTS workspaces_created_by ON workspaces(created_by) WHERE personal = 0;
