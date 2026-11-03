-- Detached one-off imports. No Google credentials are persisted.
CREATE TABLE IF NOT EXISTS drive_import_sessions (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES principals(id),
 account_id TEXT NOT NULL, account_label TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS drive_import_jobs (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), owner_id TEXT NOT NULL,
 session_id TEXT NOT NULL, account_id TEXT NOT NULL, account_label TEXT NOT NULL, folder_id TEXT,
 state TEXT NOT NULL DEFAULT 'review', manifest_version INTEGER NOT NULL DEFAULT 1,
 confirmed_version INTEGER, lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS drive_jobs_owner ON drive_import_jobs(owner_id,project_id,created_at);
CREATE TABLE IF NOT EXISTS drive_import_items (
 id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES drive_import_jobs(id), source_id TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'selected', metadata TEXT, title TEXT, mime TEXT, kind TEXT,
 size INTEGER, sha256 TEXT, preview TEXT, stage_key TEXT, stage_writes INTEGER NOT NULL DEFAULT 0,
 stage_purged INTEGER NOT NULL DEFAULT 0, upload_id TEXT, artifact_id TEXT,
 another_copy INTEGER NOT NULL DEFAULT 0, attempt INTEGER NOT NULL DEFAULT 0, error_code TEXT, error_message TEXT,
 UNIQUE(job_id, source_id)
);
CREATE INDEX IF NOT EXISTS drive_items_job ON drive_import_items(job_id,id);
CREATE TABLE IF NOT EXISTS artifact_sources (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), artifact_id TEXT NOT NULL REFERENCES artifacts(id),
 provider TEXT NOT NULL DEFAULT 'google-drive', account_id TEXT NOT NULL, source_id TEXT NOT NULL,
 is_primary INTEGER NOT NULL DEFAULT 1, provenance TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS drive_primary_source ON artifact_sources(provider,account_id,source_id,project_id) WHERE is_primary=1;
