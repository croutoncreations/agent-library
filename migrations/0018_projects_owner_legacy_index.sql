-- Additive and retry-safe. Project lists are driven from the person's memberships (tenancy.js visibleProjects):
-- rows with workspace_id use projects_workspace (0017); rows without it (created before 0017, or by a rolled-back
-- Worker) belong to the owner's personal workspace and are found through this partial index instead of a scan.
CREATE INDEX IF NOT EXISTS projects_owner_legacy ON projects(owner_id) WHERE workspace_id IS NULL;
