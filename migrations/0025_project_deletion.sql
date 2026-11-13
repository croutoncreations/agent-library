-- Deleting a project (decision D21 B). deleted_at set: the project is closed to everyone and every agent (404) and no
-- longer counts toward the projects limit. It can be restored until purge_at (30 days later, or now for "delete now").
-- After that the cron removes its content (rows and R2 files) and sets purged_at, keeping this row as a tombstone
-- (title "Deleted project", no address) because credentials and audits still reference it. Its address is released
-- at once (deleted_slug keeps it for a restore).
-- Rollback: the previous Worker ignores these columns, so deleted projects that aren't purged yet reappear, and purged
-- ones show up as empty "Deleted project" rows.
ALTER TABLE projects ADD COLUMN deleted_at INTEGER;
ALTER TABLE projects ADD COLUMN deleted_by TEXT;
ALTER TABLE projects ADD COLUMN purge_at INTEGER;
ALTER TABLE projects ADD COLUMN purged_at INTEGER;
-- The address while deleted (slug is set to NULL so a new project can use it; restore puts it back if still free).
ALTER TABLE projects ADD COLUMN deleted_slug TEXT;
CREATE INDEX IF NOT EXISTS projects_purge_due ON projects(purge_at) WHERE purge_at IS NOT NULL AND purged_at IS NULL;
CREATE INDEX IF NOT EXISTS projects_deleted ON projects(workspace_id, deleted_at) WHERE deleted_at IS NOT NULL;
