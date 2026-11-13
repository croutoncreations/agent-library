-- App Files case-insensitive path index (slice 5a). Additive; the previous Worker ignores it; the App Files path-conflict check requires it.
CREATE INDEX IF NOT EXISTS artifacts_publisher_lname ON artifacts(publisher_id, lower(export_name)) WHERE publisher_id IS NOT NULL AND export_name IS NOT NULL;
