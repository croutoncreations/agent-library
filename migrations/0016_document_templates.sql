-- Additive; D1 applies each migration with its migration record (same retry policy as 0010).
-- Older Workers ignore these defaulted/nullable fields. Roll back Worker code without undoing schema.
ALTER TABLE artifacts ADD COLUMN is_template INTEGER NOT NULL DEFAULT 0 CHECK (is_template IN (0,1));
ALTER TABLE artifacts ADD COLUMN template_description TEXT NOT NULL DEFAULT '' CHECK (length(template_description) <= 280);
ALTER TABLE artifacts ADD COLUMN source_artifact_id TEXT;
ALTER TABLE artifacts ADD COLUMN source_revision INTEGER;
ALTER TABLE artifacts ADD COLUMN source_role TEXT CHECK (source_role IN ('document','template'));
ALTER TABLE artifacts ADD COLUMN template_date TEXT;
ALTER TABLE meta_versions ADD COLUMN template_description TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS artifacts_templates ON artifacts(project_id, is_template, trashed_at, id);
