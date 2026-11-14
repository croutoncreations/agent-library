-- owner-approved-destructive: owner 2026-11-13 drops the derived FTS5 index and its triggers; the Worker's cron rebuilds it from stored text (no production users)
-- Contentless full-text index (docs/ranked-search.md). D1 keeps only the inverted index: no copy of any title or body.
-- Text lives in R2 (or inline in revisions.body for legacy rows); excerpts read it from there, and the Worker writes the
-- index in the same D1 batch as every change to a current head, title or trash state (search/indexing.js). The
-- triggers that maintained the old index from revisions.body are gone, so every writer must use that module.
-- Index identity (current revision, hash, indexed title) moves from UNINDEXED FTS columns into artifact_search_keys,
-- which keeps its stable INTEGER PRIMARY KEY search ids. Existing rows get NULLs there, so the completeness probe
-- reports every document missing until the cron rebuild (search/indexing.js rebuildSearchIndex) has re-indexed it.
-- contentless_delete=1 (SQLite 3.43+) lets the Worker delete and replace one document's entries by rowid.
DROP TRIGGER IF EXISTS search_artifact_insert;
DROP TRIGGER IF EXISTS search_artifact_update;
DROP TRIGGER IF EXISTS search_revision_insert;
DROP TRIGGER IF EXISTS search_artifact_delete;
DROP VIEW IF EXISTS artifact_search_missing;
DROP TABLE IF EXISTS artifact_search;
CREATE VIRTUAL TABLE IF NOT EXISTS artifact_search USING fts5(
  title, body,
  content='', contentless_delete=1,
  tokenize='unicode61 remove_diacritics 2'
);
ALTER TABLE artifact_search_keys ADD COLUMN revision_id TEXT;
ALTER TABLE artifact_search_keys ADD COLUMN sha256 TEXT;
ALTER TABLE artifact_search_keys ADD COLUMN indexed_title TEXT;
-- Existing installations rebuild; a fresh empty installation stays complete.
UPDATE artifact_search_state SET ready = 0 WHERE EXISTS (SELECT 1 FROM artifacts);

-- Metadata-only completeness probe. No document text is read or returned. artifact_rowid is the rebuild's cursor.
CREATE VIEW IF NOT EXISTS artifact_search_missing AS
SELECT a.id, a.rowid AS artifact_rowid FROM artifacts a JOIN revisions r ON r.id=a.head_revision_id AND r.artifact_id=a.id AND r.project_id=a.project_id AND r.rev_no=a.head_rev
WHERE a.head_rev>0 AND a.trashed_at IS NULL
AND (a.generation_id IS NULL OR EXISTS(SELECT 1 FROM publisher_generations pg WHERE pg.id=a.generation_id AND pg.publisher_id=a.publisher_id AND pg.state='committed'))
AND NOT EXISTS(SELECT 1 FROM artifact_search_keys k WHERE k.artifact_id=a.id AND k.revision_id=r.id AND k.sha256=r.sha256 AND k.indexed_title=a.title
  AND EXISTS(SELECT 1 FROM artifact_search s WHERE s.rowid=k.search_id));
