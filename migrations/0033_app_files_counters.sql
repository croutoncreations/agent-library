-- App Files lifetime counters per publisher (slice 5a). Additive; the previous Worker ignores them.
ALTER TABLE publishers ADD COLUMN app_files_created INTEGER NOT NULL DEFAULT 0;
ALTER TABLE publishers ADD COLUMN app_revisions_written INTEGER NOT NULL DEFAULT 0;
ALTER TABLE publishers ADD COLUMN app_bytes_written INTEGER NOT NULL DEFAULT 0;
