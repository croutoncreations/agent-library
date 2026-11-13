-- Workspace usage (plan limits, docs/limits.md) sums per project inside guarded writes; index the project columns.
CREATE INDEX IF NOT EXISTS revisions_project_size ON revisions(project_id, size);
CREATE INDEX IF NOT EXISTS uploads_project_state ON uploads(project_id, state);
CREATE INDEX IF NOT EXISTS publisher_generations_project_state ON publisher_generations(project_id, state);
CREATE INDEX IF NOT EXISTS oauth_connections_owner_legacy ON oauth_connections(owner_principal_id) WHERE workspace_id IS NULL;
CREATE INDEX IF NOT EXISTS api_credentials_owner_legacy ON api_credentials(owner_principal_id) WHERE workspace_id IS NULL;
CREATE INDEX IF NOT EXISTS publishers_owner_legacy ON publishers(owner_principal_id) WHERE workspace_id IS NULL;
