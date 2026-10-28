-- Durable publication feed. No backfill: historical timestamps are not publication events.
-- Triggers run inside the existing publication transaction, including rollback/idempotency.
CREATE TABLE IF NOT EXISTS change_feed_key (id INTEGER PRIMARY KEY CHECK(id=1), secret TEXT NOT NULL);
INSERT OR IGNORE INTO change_feed_key VALUES (1, lower(hex(randomblob(32))));
-- New generation transactions opt into feed triggers. Older Workers retain their exact row-count
-- checks after rollback; their generation commits are detected as coverage gaps by the new reader.
CREATE TABLE IF NOT EXISTS change_generation_context (id INTEGER PRIMARY KEY CHECK(id=1));
CREATE TABLE IF NOT EXISTS change_generation_coverage (publisher_id TEXT PRIMARY KEY, snapshot_id TEXT);
INSERT OR IGNORE INTO change_generation_coverage SELECT id,current_snapshot_id FROM publishers;
CREATE TABLE IF NOT EXISTS project_change_state (
  project_id TEXT PRIMARY KEY, high INTEGER NOT NULL DEFAULT 0, floor INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS project_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
  project_id TEXT NOT NULL, artifact_id TEXT NOT NULL, kind TEXT NOT NULL,
  type TEXT NOT NULL, at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revision_id TEXT, revision INTEGER, sha256 TEXT, meta_version INTEGER,
  changed_fields TEXT NOT NULL, restored_from INTEGER, connection_label TEXT
);
CREATE INDEX IF NOT EXISTS project_changes_project ON project_changes(project_id, seq);
CREATE INDEX IF NOT EXISTS project_changes_artifact_meta ON project_changes(artifact_id,meta_version,type);
CREATE INDEX IF NOT EXISTS project_changes_retention ON project_changes(at, seq);
CREATE TRIGGER IF NOT EXISTS change_high AFTER INSERT ON project_changes BEGIN
  INSERT INTO project_change_state(project_id,high) VALUES(NEW.project_id,NEW.seq)
  ON CONFLICT(project_id) DO UPDATE SET high=NEW.seq;
END;
CREATE TRIGGER IF NOT EXISTS change_floor AFTER DELETE ON project_changes BEGIN
  UPDATE project_change_state SET floor=max(floor,OLD.seq) WHERE project_id=OLD.project_id;
END;
-- Scope epochs invalidate cursors even after a project is removed and re-added to the same connection.
CREATE TABLE IF NOT EXISTS change_scope_epochs (
  transport TEXT NOT NULL, connection_id TEXT NOT NULL, project_id TEXT NOT NULL, epoch INTEGER NOT NULL,
  PRIMARY KEY(transport,connection_id,project_id)
);
CREATE TRIGGER IF NOT EXISTS change_scope_oauth_insert AFTER INSERT ON oauth_connection_projects BEGIN
  INSERT INTO change_scope_epochs VALUES('oauth',NEW.connection_id,NEW.project_id,1)
  ON CONFLICT(transport,connection_id,project_id) DO UPDATE SET epoch=epoch+1;
END;
CREATE TRIGGER IF NOT EXISTS change_scope_oauth_update AFTER UPDATE ON oauth_connection_projects BEGIN
  INSERT INTO change_scope_epochs VALUES('oauth',NEW.connection_id,NEW.project_id,1)
  ON CONFLICT(transport,connection_id,project_id) DO UPDATE SET epoch=epoch+1;
END;
CREATE TRIGGER IF NOT EXISTS change_scope_oauth_delete AFTER DELETE ON oauth_connection_projects BEGIN
  INSERT INTO change_scope_epochs VALUES('oauth',OLD.connection_id,OLD.project_id,1)
  ON CONFLICT(transport,connection_id,project_id) DO UPDATE SET epoch=epoch+1;
END;
CREATE TRIGGER IF NOT EXISTS change_scope_api_insert AFTER INSERT ON api_credential_projects BEGIN
  INSERT INTO change_scope_epochs VALUES('api',NEW.credential_id,NEW.project_id,1)
  ON CONFLICT(transport,connection_id,project_id) DO UPDATE SET epoch=epoch+1;
END;
CREATE TRIGGER IF NOT EXISTS change_scope_api_update AFTER UPDATE ON api_credential_projects BEGIN
  INSERT INTO change_scope_epochs VALUES('api',NEW.credential_id,NEW.project_id,1)
  ON CONFLICT(transport,connection_id,project_id) DO UPDATE SET epoch=epoch+1;
END;
CREATE TRIGGER IF NOT EXISTS change_scope_api_delete AFTER DELETE ON api_credential_projects BEGIN
  INSERT INTO change_scope_epochs VALUES('api',OLD.credential_id,OLD.project_id,1)
  ON CONFLICT(transport,connection_id,project_id) DO UPDATE SET epoch=epoch+1;
END;
CREATE TRIGGER IF NOT EXISTS change_revision AFTER INSERT ON revisions
WHEN EXISTS(SELECT 1 FROM artifacts WHERE id=NEW.artifact_id AND head_revision_id=NEW.id AND head_rev>0 AND trashed_at IS NULL AND (generation_id IS NULL OR EXISTS(SELECT 1 FROM change_generation_context)))
BEGIN
  INSERT INTO project_changes(project_id,artifact_id,kind,type,revision_id,revision,sha256,meta_version,changed_fields,restored_from,connection_label) SELECT a.project_id,a.id,a.kind,CASE WHEN r.rev_no=1 THEN 'artifact.created' ELSE 'artifact.content_updated' END,r.id,r.rev_no,r.sha256,a.meta_version,'["content"]',r.restored_from,substr(COALESCE(r.via_label,CASE WHEN r.via_kind='browser' THEN 'Owner' END,pb.display_name,'Unknown connection'),1,120) FROM artifacts a JOIN revisions r ON r.id=a.head_revision_id
  LEFT JOIN publishers pb ON pb.id=a.publisher_id WHERE r.id=NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS change_head AFTER UPDATE OF head_revision_id ON artifacts
WHEN NEW.head_revision_id IS NOT OLD.head_revision_id AND NEW.head_rev>0 AND NEW.trashed_at IS NULL AND (NEW.generation_id IS NULL OR EXISTS(SELECT 1 FROM change_generation_context))
BEGIN
  INSERT INTO project_changes(project_id,artifact_id,kind,type,revision_id,revision,sha256,meta_version,changed_fields,restored_from,connection_label) SELECT a.project_id,a.id,a.kind,CASE WHEN r.rev_no=1 THEN 'artifact.created' ELSE 'artifact.content_updated' END,r.id,r.rev_no,r.sha256,a.meta_version,'["content"]',r.restored_from,substr(COALESCE(r.via_label,CASE WHEN r.via_kind='browser' THEN 'Owner' END,pb.display_name,'Unknown connection'),1,120) FROM artifacts a JOIN revisions r ON r.id=a.head_revision_id
  LEFT JOIN publishers pb ON pb.id=a.publisher_id WHERE a.id=NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS change_metadata AFTER UPDATE OF title,folder,folder_id,tags,trashed_at,meta_version ON artifacts
WHEN NEW.head_rev>0 AND (NEW.trashed_at IS NULL OR OLD.trashed_at IS NULL) AND (NEW.title IS NOT OLD.title OR NEW.folder IS NOT OLD.folder OR NEW.folder_id IS NOT OLD.folder_id
 OR NEW.tags IS NOT OLD.tags OR NEW.trashed_at IS NOT OLD.trashed_at OR NEW.meta_version IS NOT OLD.meta_version)
BEGIN
  INSERT INTO project_changes(project_id,artifact_id,kind,type,revision_id,revision,sha256,meta_version,changed_fields)
  SELECT NEW.project_id,NEW.id,NEW.kind,
    CASE WHEN NEW.trashed_at IS NOT NULL AND OLD.trashed_at IS NULL THEN 'artifact.trashed'
         WHEN NEW.trashed_at IS NULL AND OLD.trashed_at IS NOT NULL THEN 'artifact.restored' ELSE 'artifact.metadata_updated' END,
    NEW.head_revision_id,NEW.head_rev,(SELECT sha256 FROM revisions WHERE id=NEW.head_revision_id),NEW.meta_version,
    (SELECT json_group_array(value) FROM (
      SELECT 'title' value WHERE NEW.title IS NOT OLD.title UNION ALL SELECT 'folder' WHERE NEW.folder IS NOT OLD.folder
      UNION ALL SELECT 'folder_id' WHERE NEW.folder_id IS NOT OLD.folder_id UNION ALL SELECT 'tags' WHERE NEW.tags IS NOT OLD.tags
      UNION ALL SELECT 'trashed' WHERE NEW.trashed_at IS NOT OLD.trashed_at));
END;
-- Metadata provenance is inserted later in the same guarded batch. Baselines must not generate events.
CREATE TRIGGER IF NOT EXISTS change_metadata_provenance AFTER INSERT ON meta_versions BEGIN
  UPDATE project_changes SET connection_label=substr(COALESCE(NEW.via_label,CASE WHEN NEW.via_kind='browser' THEN 'Owner' END,'Unknown connection'),1,120),
    restored_from=NEW.restored_from WHERE artifact_id=NEW.artifact_id AND meta_version=NEW.version
    AND type IN ('artifact.metadata_updated','artifact.trashed','artifact.restored');
END;
CREATE TRIGGER IF NOT EXISTS change_folder_name AFTER UPDATE OF name ON folders WHEN NEW.name IS NOT OLD.name BEGIN
  INSERT INTO project_changes(project_id,artifact_id,kind,type,meta_version,changed_fields)
  SELECT project_id,id,kind,'artifact.metadata_updated',meta_version,'["folder"]' FROM artifacts
  WHERE folder_id=NEW.id AND project_id=NEW.project_id AND head_rev>0 AND trashed_at IS NULL;
END;
