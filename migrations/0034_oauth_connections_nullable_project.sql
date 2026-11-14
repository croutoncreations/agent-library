-- owner-approved-destructive: Jon Fox 2026-11-14 make legacy oauth_connections.project_id nullable so a connection can have zero projects
-- Zero-project OAuth connections ("connect now, share projects later", docs/architecture.md#agent-access). Authorization has used
-- oauth_connection_projects since 0006; oauth_connections.project_id is legacy (first chosen project) and was NOT NULL,
-- so a connection without projects could not be stored. Same table-rebuild pattern as 0008/0009: every column keeps its
-- name, order and type, only project_id loses NOT NULL; all rows are copied unchanged; all four indexes are recreated.
-- No trigger or view references oauth_connections. oauth_connection_projects keeps its foreign key to
-- oauth_connections(id), re-checked at commit (defer_foreign_keys).
-- The previous Worker keeps working on this schema: it reads project_id only for the replace-audit fallback and
-- project purge (NULL is fine there), but it treats a connection with no projects as revoked (see docs/self-hosting.md).
PRAGMA defer_foreign_keys = on;

CREATE TABLE oauth_connections_v33 AS SELECT * FROM oauth_connections;
DROP TABLE oauth_connections;
CREATE TABLE oauth_connections (
  id TEXT PRIMARY KEY,
  owner_principal_id TEXT NOT NULL REFERENCES principals(id),
  project_id TEXT REFERENCES projects(id),
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  resource TEXT NOT NULL,
  can_read INTEGER NOT NULL CHECK (can_read = 1),
  can_write INTEGER NOT NULL CHECK (can_write IN (0,1)),
  oauth_grant_id TEXT,
  created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_used_at INTEGER,
  client_info TEXT,
  file_access INTEGER NOT NULL DEFAULT 0,
  workspace_id TEXT REFERENCES workspaces(id),
  created_by TEXT REFERENCES principals(id)
);
INSERT INTO oauth_connections (id, owner_principal_id, project_id, client_id, client_name, redirect_uri, resource, can_read, can_write, oauth_grant_id, created_at, expires_at, revoked_at, last_used_at, client_info, file_access, workspace_id, created_by)
  SELECT id, owner_principal_id, project_id, client_id, client_name, redirect_uri, resource, can_read, can_write, oauth_grant_id, created_at, expires_at, revoked_at, last_used_at, client_info, file_access, workspace_id, created_by FROM oauth_connections_v33;
DROP TABLE oauth_connections_v33;
CREATE INDEX oauth_connections_project ON oauth_connections(project_id);
CREATE INDEX oauth_connections_owner ON oauth_connections(owner_principal_id);
CREATE INDEX oauth_connections_workspace ON oauth_connections(workspace_id);
CREATE INDEX oauth_connections_owner_legacy ON oauth_connections(owner_principal_id) WHERE workspace_id IS NULL;
