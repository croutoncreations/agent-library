-- Nullable keys preserve inline reads for existing revisions and comments. Comments remain inline for now.
ALTER TABLE revisions ADD COLUMN body_key TEXT;
ALTER TABLE comments ADD COLUMN body_key TEXT;
CREATE INDEX IF NOT EXISTS revisions_body_key ON revisions(body_key) WHERE body_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS comments_body_key ON comments(body_key) WHERE body_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS content_writes (
  key TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS content_writes_created ON content_writes(created_at);
