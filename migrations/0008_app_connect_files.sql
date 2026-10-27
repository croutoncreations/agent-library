-- App Connect Phase 2 + 3 schema (contract app-connect/0.4).
-- Rebuilds artifacts to widen the kind CHECK (json, csv) and add folder_id / publisher_id / schema_id /
-- export_name. Existing rows are copied unchanged; dependent tables (revisions, uploads, comments) keep
-- their composite FK to artifacts(id, project_id), which is re-checked at commit (defer_foreign_keys).
PRAGMA defer_foreign_keys = on;

CREATE TABLE artifacts_v7 AS SELECT * FROM artifacts;
DROP TABLE artifacts;
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL CHECK (kind IN ('markdown','binary','json','csv')),
  title TEXT NOT NULL,
  folder TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  head_rev INTEGER NOT NULL DEFAULT 0,
  head_revision_id TEXT,
  meta_version INTEGER NOT NULL DEFAULT 1,
  meta_request_id TEXT,
  trashed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  folder_id TEXT,            -- fld_… in the same project, NULL = project root
  schema_id TEXT,            -- registered schema (agentlib.measurements/1) or NULL
  publisher_id TEXT,         -- pub_… owner of a source export, NULL = ordinary file
  export_name TEXT,          -- publisher's stable file name (unique per publisher)
  UNIQUE (id, project_id)
);
INSERT INTO artifacts (id, project_id, kind, title, folder, tags, head_rev, head_revision_id, meta_version, meta_request_id, trashed_at, created_at, updated_at)
  SELECT id, project_id, kind, title, folder, tags, head_rev, head_revision_id, meta_version, meta_request_id, trashed_at, created_at, updated_at FROM artifacts_v7;
DROP TABLE artifacts_v7;
CREATE INDEX artifacts_project ON artifacts(project_id, updated_at);
CREATE INDEX artifacts_folder ON artifacts(project_id, folder_id);
CREATE UNIQUE INDEX artifacts_publisher_name ON artifacts(publisher_id, export_name) WHERE publisher_id IS NOT NULL;

CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,     -- lower(trim(name)) for case-insensitive uniqueness
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  publisher_id TEXT,          -- set when created for a publisher at consent
  UNIQUE (project_id, name_key)
);

-- Owner-registered app clients (publishers' OAuth clients). Never created by dynamic registration.
CREATE TABLE app_clients (
  id TEXT PRIMARY KEY,                       -- apc_…
  owner_principal_id TEXT NOT NULL REFERENCES principals(id),
  client_id TEXT NOT NULL UNIQUE,            -- OAuth client_id (KV client record)
  display_name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,               -- JSON array
  origins TEXT NOT NULL,                     -- JSON array
  created_at TEXT NOT NULL,
  disabled_at INTEGER
);

CREATE TABLE publishers (
  id TEXT PRIMARY KEY,                       -- pub_…
  owner_principal_id TEXT NOT NULL REFERENCES principals(id),
  principal_id TEXT NOT NULL REFERENCES principals(id),  -- author of its revisions
  app_client_id TEXT NOT NULL REFERENCES app_clients(id),
  display_name TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  folder_id TEXT,                            -- NULL = project root
  created_at TEXT NOT NULL,
  revoked_at INTEGER,
  resumed_at TEXT,
  token_epoch INTEGER NOT NULL DEFAULT 1,    -- bumped on resume: older tokens stop working
  current_snapshot_id TEXT,
  current_source_revision INTEGER,
  retention TEXT NOT NULL DEFAULT '{"mode":"keep_all"}',
  auto_prune_enabled INTEGER NOT NULL DEFAULT 0 CHECK (auto_prune_enabled = 0)  -- cannot be enabled (coordination limit)
);
CREATE INDEX publishers_client ON publishers(app_client_id, owner_principal_id);

CREATE TABLE snapshots (
  id TEXT PRIMARY KEY,                       -- snp_…
  publisher_id TEXT NOT NULL REFERENCES publishers(id),
  source_revision INTEGER NOT NULL,
  committed_at TEXT NOT NULL,
  exported_at TEXT,
  coverage TEXT,                             -- JSON {from,to} verbatim or NULL
  manifest_file_id TEXT NOT NULL,
  manifest_revision INTEGER NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  files TEXT NOT NULL,                       -- JSON array of snapshot file objects (contract §9.3)
  UNIQUE (publisher_id, source_revision)
);
