-- Workspace handles and per-workspace project slugs (docs/workspaces.md#addresses). Additive and retry-safe; the
-- previous Worker ignores both columns. Project ids stay the storage key everywhere (R2 keys, foreign keys, API ids);
-- an address <handle>/<slug> is an alias resolved to the id on every request.
--
-- Handles are lower-case [a-z0-9-], unique across the installation. Slugs are unique inside one workspace. Both are
-- filled in by the Worker (new rows at creation, older rows on first use), never by this migration.
ALTER TABLE workspaces ADD COLUMN handle TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS workspaces_handle ON workspaces(handle);

ALTER TABLE projects ADD COLUMN slug TEXT;
-- A project gets workspace_id set (if it was NULL) in the same statement that gives it a slug, so this index covers
-- every addressed project.
CREATE UNIQUE INDEX IF NOT EXISTS projects_workspace_slug ON projects(workspace_id, slug) WHERE slug IS NOT NULL;
