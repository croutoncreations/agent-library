-- Database size history: the cron (cleanup.js recordDbSize) keeps the first sample of each UTC day and prunes samples
-- older than 400 days. Additive and retry-safe; the previous Worker never reads or writes this table, and the new
-- Worker logs and carries on if it is missing.
CREATE TABLE IF NOT EXISTS db_size_samples (
  day TEXT PRIMARY KEY,        -- UTC date, YYYY-MM-DD
  size_bytes INTEGER NOT NULL, -- D1 meta.size_after
  sampled_at TEXT NOT NULL     -- ISO time of the sample
);
