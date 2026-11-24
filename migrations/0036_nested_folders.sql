-- Nested folders (docs/folders.md). Folders form a tree per project: parent_id points at the parent folder (NULL =
-- project root) and path is the folder's full display path ("Reports/2026/Q1"; NULL for a top-level folder, whose path
-- is its name). Additive and retry-safe: two new nullable columns and an index. The existing UNIQUE (project_id,
-- name_key) constraint is kept as is: name_key now holds the lower-cased full path, so sibling names stay unique
-- case-insensitively while the same name can appear under different parents. Top-level folders keep name_key =
-- lower(name), exactly what older Workers wrote and read, so a rolled-back Worker keeps working (it sees nested
-- folders as extra entries named by their leaf).
-- Same columns and index as public main's 0018_nested_folders.sql (renumbered: this line's 0018 is workspaces). An
-- installation that already ran that file has both columns: see docs/self-hosting.md#upgrading-from-01x.
-- Legacy free-text artifacts.folder labels are adopted into the tree by the Worker on first use (no data UPDATE here).
ALTER TABLE folders ADD COLUMN parent_id TEXT;
ALTER TABLE folders ADD COLUMN path TEXT;
CREATE INDEX IF NOT EXISTS folders_parent ON folders(project_id, parent_id);
