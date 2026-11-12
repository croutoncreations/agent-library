-- Publication fences (docs/encryption.md#rules-for-code-that-uses-this). Always empty: a fence statement inserts NULL
-- into a NOT NULL column here to fail, and so roll back, the batch it is in. The column names which condition refused.
-- The CHECK makes "always empty" structural: NOT NULL refuses a NULL and the CHECK refuses anything else.
CREATE TABLE IF NOT EXISTS content_fences (key_active INTEGER NOT NULL, no_real_key INTEGER NOT NULL,
  CHECK (key_active IS NULL AND no_real_key IS NULL));
-- Serves NO_REAL_KEY_SQL (the encryptionEnabled probe and every plaintext publication fence) without a table scan.
CREATE INDEX IF NOT EXISTS workspace_keys_real ON workspace_keys(master_version) WHERE master_version > 0;
