-- view_links (CONTENT_HOST, decision D4 A): short-lived links that open one rendered HTML page or one PDF on the
-- installation's user-content host, a separate site, so uploaded content never runs with the app's origin or cookies.
-- Only the SHA-256 of the token is stored. Every use re-checks that the session that asked for it is still live and
-- that its person can still read the project (deleted projects and removed members get 404 at once).
-- Additive only: a new table. The previous Worker never reads it.
CREATE TABLE IF NOT EXISTS view_links (
  token_hash TEXT PRIMARY KEY,
  session_hash TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  rev_no INTEGER NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('render','file')),
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS view_links_expiry ON view_links(expires_at);
CREATE INDEX IF NOT EXISTS view_links_project ON view_links(project_id);
