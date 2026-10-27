-- Files for OAuth (MCP) connections (build-file-tools-fixes.mjs; docs/agent-setup.md#files). Additive only: two new
-- columns (nullable or defaulted) and a new table. The previous Worker keeps working on this schema: it never reads
-- these columns or the table, and its inserts get the safe defaults.
-- oauth_connections.file_access: 1 when the owner approved the connection on a consent page that offered files
--   (read and download files; with Edit also upload new files and versions). Existing connections stay 0 and keep
--   exactly what their consent page said (documents and history) until the owner reconnects them.
-- uploads.change_note: the uploader's one-line "why", recorded on the published version like any other edit.
-- transfer_links: short-lived capability links for one file revision (download) or one upload (PUT). Only the
--   SHA-256 of the token is stored. Every use re-checks the live connection, its project and its permissions.
-- Retry: applied as one unit with its d1_migrations row (see 0010_version_history.sql).
ALTER TABLE oauth_connections ADD COLUMN file_access INTEGER NOT NULL DEFAULT 0;
ALTER TABLE uploads ADD COLUMN change_note TEXT;
CREATE TABLE IF NOT EXISTS transfer_links (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('download','upload')),
  connection_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  rev_no INTEGER,
  upload_id TEXT,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS transfer_links_expiry ON transfer_links(expires_at);
CREATE INDEX IF NOT EXISTS transfer_links_upload ON transfer_links(upload_id);
