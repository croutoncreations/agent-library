-- Workspace data keys for content encryption (docs/encryption.md#workspace-keys). Additive and retry-safe.
-- One row per data key: `wrapped` is the key wrapped by the keyProvider adapter under master version
-- `master_version`; `created_at` and `shredded_at` are epoch milliseconds. A workspace has at most one active
-- (unshredded) key. Nothing reads or writes this table yet outside packages/core/src/crypto/keys.js.
CREATE TABLE IF NOT EXISTS workspace_keys (
  workspace_id TEXT NOT NULL,
  key_id TEXT PRIMARY KEY,
  master_version INTEGER NOT NULL,
  wrapped TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  shredded_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_keys_active ON workspace_keys(workspace_id) WHERE shredded_at IS NULL;
-- Lookups by workspace that the partial index cannot serve (shredded rows, the NOT EXISTS guard on first use).
CREATE INDEX IF NOT EXISTS workspace_keys_workspace ON workspace_keys(workspace_id);
