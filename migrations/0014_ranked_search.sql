-- Current heads only. Additive; old Workers maintain the index through these triggers too.
-- D1 supports FTS5/unicode61. Search never uses corpus-wide BM25 statistics.
-- Explicit INTEGER PRIMARY KEY values survive VACUUM and logical copies; never use artifacts.rowid as the index identity.
CREATE TABLE IF NOT EXISTS artifact_search_keys (search_id INTEGER PRIMARY KEY, artifact_id TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS artifact_search_state (id INTEGER PRIMARY KEY CHECK(id=1), ready INTEGER NOT NULL DEFAULT 0 CHECK(ready IN(0,1)), cursor_key TEXT NOT NULL);
-- Fresh empty installations are complete. Existing installations stay disabled until backfilled.
INSERT OR IGNORE INTO artifact_search_state(id,ready,cursor_key) SELECT 1, CASE WHEN EXISTS(SELECT 1 FROM artifacts) THEN 0 ELSE 1 END, lower(hex(randomblob(32)));
CREATE VIRTUAL TABLE IF NOT EXISTS artifact_search USING fts5(
  artifact_id UNINDEXED, revision_id UNINDEXED, sha256 UNINDEXED, title, body,
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS search_artifact_insert AFTER INSERT ON artifacts WHEN new.generation_id IS NULL BEGIN
  INSERT OR IGNORE INTO artifact_search_keys(artifact_id) VALUES(new.id);
  DELETE FROM artifact_search WHERE rowid=(SELECT search_id FROM artifact_search_keys WHERE artifact_id=new.id);
  INSERT INTO artifact_search (rowid, artifact_id, revision_id, sha256, title, body) SELECT k.search_id, a.id, r.id, r.sha256, a.title, CASE WHEN a.kind = 'binary' THEN '' ELSE COALESCE(r.body,'') END
  FROM artifacts a JOIN artifact_search_keys k ON k.artifact_id=a.id JOIN revisions r ON r.id=a.head_revision_id AND r.artifact_id=a.id AND r.project_id=a.project_id AND r.rev_no=a.head_rev
  WHERE a.id=new.id AND a.head_rev>0 AND a.trashed_at IS NULL;
END;
CREATE TRIGGER IF NOT EXISTS search_artifact_update AFTER UPDATE OF title, head_rev, head_revision_id, trashed_at ON artifacts BEGIN
  INSERT OR IGNORE INTO artifact_search_keys(artifact_id) VALUES(new.id);
  DELETE FROM artifact_search WHERE rowid=(SELECT search_id FROM artifact_search_keys WHERE artifact_id=new.id);
  INSERT INTO artifact_search (rowid, artifact_id, revision_id, sha256, title, body) SELECT k.search_id, a.id, r.id, r.sha256, a.title, CASE WHEN a.kind = 'binary' THEN '' ELSE COALESCE(r.body,'') END
  FROM artifacts a JOIN artifact_search_keys k ON k.artifact_id=a.id JOIN revisions r ON r.id=a.head_revision_id AND r.artifact_id=a.id AND r.project_id=a.project_id AND r.rev_no=a.head_rev
  WHERE a.id=new.id AND a.head_rev>0 AND a.trashed_at IS NULL;
END;
CREATE TRIGGER IF NOT EXISTS search_revision_insert AFTER INSERT ON revisions WHEN EXISTS (SELECT 1 FROM artifacts WHERE id=new.artifact_id AND generation_id IS NULL) BEGIN
  INSERT OR IGNORE INTO artifact_search_keys(artifact_id) VALUES(new.artifact_id);
  DELETE FROM artifact_search WHERE rowid=(SELECT search_id FROM artifact_search_keys WHERE artifact_id=new.artifact_id);
  INSERT INTO artifact_search (rowid, artifact_id, revision_id, sha256, title, body) SELECT k.search_id, a.id, r.id, r.sha256, a.title, CASE WHEN a.kind = 'binary' THEN '' ELSE COALESCE(r.body,'') END
  FROM artifacts a JOIN artifact_search_keys k ON k.artifact_id=a.id JOIN revisions r ON r.id=a.head_revision_id AND r.artifact_id=a.id AND r.project_id=a.project_id AND r.rev_no=a.head_rev
  WHERE a.id=new.artifact_id AND a.head_rev>0 AND a.trashed_at IS NULL;
END;
CREATE TRIGGER IF NOT EXISTS search_artifact_delete AFTER DELETE ON artifacts BEGIN
  DELETE FROM artifact_search WHERE rowid=(SELECT search_id FROM artifact_search_keys WHERE artifact_id=old.id);
  DELETE FROM artifact_search_keys WHERE artifact_id=old.id;
END;

-- Generation inserts are excluded above: old Workers validate exact D1 change counts.
-- New Workers index them explicitly in the publication batch. Backfill covers old-Worker generation writes.

-- Metadata-only completeness probe. No document bodies are scanned or returned.
CREATE VIEW IF NOT EXISTS artifact_search_missing AS
SELECT a.id FROM artifacts a JOIN revisions r ON r.id=a.head_revision_id AND r.artifact_id=a.id AND r.project_id=a.project_id AND r.rev_no=a.head_rev
LEFT JOIN artifact_search_keys k ON k.artifact_id=a.id
WHERE a.head_rev>0 AND a.trashed_at IS NULL
AND (a.generation_id IS NULL OR EXISTS(SELECT 1 FROM publisher_generations pg WHERE pg.id=a.generation_id AND pg.publisher_id=a.publisher_id AND pg.state='committed'))
AND NOT EXISTS(SELECT 1 FROM artifact_search s WHERE s.rowid=k.search_id AND s.artifact_id=a.id AND s.revision_id=r.id AND s.sha256=r.sha256 AND s.title=a.title);
