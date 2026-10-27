-- Version history (docs/version-history.md). Additive only: new nullable columns and a new table.
-- The previous Worker keeps working on this schema (it never reads or writes these columns/table).
-- Retry: wrangler (4.90.1) sends this whole file plus its d1_migrations row as one D1 query, which applies as a
-- unit. Verified locally: a failure anywhere in the file leaves no column, table or d1_migrations row behind,
-- and the next apply runs the file from the start. (SQLite has no ADD COLUMN IF NOT EXISTS.)

-- Who and why, per content version. Server-derived: via_kind/via_id/via_label (the access path and the
-- connection, API key, grant or publisher it used; via_label is a snapshot of its name at write time).
-- Self-reported by the client, shown as such: client_info (MCP clientInfo "name version") and change_note.
-- NULL on versions written before this migration.
ALTER TABLE revisions ADD COLUMN via_kind TEXT;
ALTER TABLE revisions ADD COLUMN via_id TEXT;
ALTER TABLE revisions ADD COLUMN via_label TEXT;
ALTER TABLE revisions ADD COLUMN client_info TEXT;
ALTER TABLE revisions ADD COLUMN change_note TEXT;

-- Last MCP clientInfo seen at initialize, for clients that do not repeat it on each request (MCP < 2026-07-28).
-- Self-reported; used only as a display hint on versions written through that connection or grant.
ALTER TABLE oauth_connections ADD COLUMN client_info TEXT;
ALTER TABLE grants ADD COLUMN client_info TEXT;

-- Immutable metadata versions (title, folder, tags, trash state). version equals artifacts.meta_version
-- after the change. A document's first change after this migration also records its prior state as a
-- 'baseline' row, so history always starts from a known state. Rows are never updated or deleted.
CREATE TABLE IF NOT EXISTS meta_versions (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  title TEXT NOT NULL,
  folder TEXT NOT NULL,
  tags TEXT NOT NULL,
  trashed INTEGER NOT NULL CHECK (trashed IN (0,1)),
  author_id TEXT NOT NULL,
  via_kind TEXT,
  via_id TEXT,
  via_label TEXT,
  client_info TEXT,
  change_note TEXT,
  restored_from INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (artifact_id, version),
  FOREIGN KEY (artifact_id, project_id) REFERENCES artifacts(id, project_id)
);
CREATE INDEX IF NOT EXISTS meta_versions_artifact ON meta_versions(artifact_id, project_id, version);
