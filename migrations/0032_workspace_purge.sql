-- Deleted-workspace purge (docs/workspaces.md#deleting-a-workspace). Additive; NULL = not yet. Wrangler applies this
-- file and its d1_migrations row atomically per file, so a failed apply leaves nothing and is retried whole. The
-- previous Worker never reads these columns or the index.
ALTER TABLE workspaces ADD COLUMN deleting_at INTEGER DEFAULT NULL;      -- epoch ms of the delete
ALTER TABLE workspaces ADD COLUMN purge_marked_at INTEGER DEFAULT NULL;  -- the point of no return: its projects are (being) marked due
ALTER TABLE workspaces ADD COLUMN purged_at INTEGER DEFAULT NULL;        -- every project of it purged
CREATE INDEX IF NOT EXISTS workspaces_purge_due ON workspaces(deleting_at)
  WHERE status = 'deleting' AND purge_marked_at IS NULL;
CREATE INDEX IF NOT EXISTS workspaces_purge_pending ON workspaces(purge_marked_at)
  WHERE status = 'deleting' AND purge_marked_at IS NOT NULL AND purged_at IS NULL;
-- Live projects per workspace: the purge's recovery selection and project marking read only these.
CREATE INDEX IF NOT EXISTS projects_live ON projects(workspace_id) WHERE deleted_at IS NULL;
