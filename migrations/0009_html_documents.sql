-- HTML documents: widen the artifacts.kind CHECK to include 'html'. Same table-rebuild pattern as 0008;
-- all columns and rows are copied unchanged. Dependent tables keep their composite FK to artifacts(id, project_id),
-- re-checked at commit (defer_foreign_keys). No other schema changes.
PRAGMA defer_foreign_keys = on;

CREATE TABLE artifacts_v8 AS SELECT * FROM artifacts;
DROP TABLE artifacts;
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL CHECK (kind IN ('markdown','binary','json','csv','html')),
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
  folder_id TEXT,
  schema_id TEXT,
  publisher_id TEXT,
  export_name TEXT,
  UNIQUE (id, project_id)
);
INSERT INTO artifacts (id, project_id, kind, title, folder, tags, head_rev, head_revision_id, meta_version, meta_request_id, trashed_at, created_at, updated_at, folder_id, schema_id, publisher_id, export_name)
  SELECT id, project_id, kind, title, folder, tags, head_rev, head_revision_id, meta_version, meta_request_id, trashed_at, created_at, updated_at, folder_id, schema_id, publisher_id, export_name FROM artifacts_v8;
DROP TABLE artifacts_v8;
CREATE INDEX artifacts_project ON artifacts(project_id, updated_at);
CREATE INDEX artifacts_folder ON artifacts(project_id, folder_id);
CREATE UNIQUE INDEX artifacts_publisher_name ON artifacts(publisher_id, export_name) WHERE publisher_id IS NOT NULL;
