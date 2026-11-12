-- App Files lifetime counters per publisher (slice 5a). Additive; the previous Worker ignores them.
ALTER TABLE publishers ADD COLUMN app_files_created INTEGER NOT NULL DEFAULT 0;
ALTER TABLE publishers ADD COLUMN app_revisions_written INTEGER NOT NULL DEFAULT 0;
ALTER TABLE publishers ADD COLUMN app_bytes_written INTEGER NOT NULL DEFAULT 0;
-- App Files path conflicts are case-insensitive; this index answers them without reading the publisher's rows.
CREATE INDEX IF NOT EXISTS artifacts_publisher_lname ON artifacts(publisher_id, lower(export_name)) WHERE publisher_id IS NOT NULL AND export_name IS NOT NULL;
