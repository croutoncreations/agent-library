-- Every R2 object an upload can create is recorded *before* it is written (staging_key at begin,
-- final_key before the final put), so DB-driven cleanup can always find it, and quota counts it
-- until the delete is confirmed.
ALTER TABLE uploads ADD COLUMN staging_purged_at INTEGER;
ALTER TABLE uploads ADD COLUMN final_key TEXT;
ALTER TABLE uploads ADD COLUMN final_purged_at INTEGER;
CREATE INDEX uploads_cleanup ON uploads(state, staging_purged_at);
