-- Blind-index search tokens (docs/encryption.md#search-tokens, slice 4a). Additive and retry-safe; nothing reads the
-- tokens until slice 4b. The previous Worker never reads or writes these tables. Documents it publishes appear in
-- search_tokens_missing. Projects it purges keep their token rows until the new Worker's cron sweep
-- (search/tokens.js sweepSearchTokenOrphans) deletes them.
CREATE TABLE IF NOT EXISTS search_token_docs (
  doc_id INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,             -- immutable after insert
  owner_id TEXT NOT NULL,                 -- immutable after insert: charged owner (workspaces.created_by, fallback projects.owner_id)
  revision_id TEXT NOT NULL DEFAULT '',   -- '' = not complete (a writer or purge holds the lease, or first index)
  key_id TEXT NOT NULL,
  token_digest TEXT NOT NULL DEFAULT '',
  writer TEXT NOT NULL DEFAULT '',        -- lease nonce while revision_id = ''; 'purge:…' for purge and sweep
  gen INTEGER NOT NULL DEFAULT 0,
  term_count INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0,
  truncated_by TEXT NOT NULL DEFAULT '',  -- '', cap, size, off, workspace, owner, installation
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS search_token_docs_project ON search_token_docs(project_id);
CREATE INDEX IF NOT EXISTS search_token_docs_workspace ON search_token_docs(workspace_id);
CREATE TABLE IF NOT EXISTS search_tokens (
  doc_id INTEGER NOT NULL,
  token BLOB NOT NULL,
  PRIMARY KEY (doc_id, token)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS search_tokens_token ON search_tokens(token, doc_id);
-- Exact charged units (tokens + 5 per document row) per scope: 'i', 'w:<workspace>', 'o:<owner>'.
CREATE TABLE IF NOT EXISTS search_term_counters (
  scope TEXT PRIMARY KEY,
  terms INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS workspace_search_keys (
  workspace_id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL UNIQUE,
  secret TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS search_tokens_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  ready INTEGER NOT NULL DEFAULT 0 CHECK (ready IN (0, 1)),   -- a backfill pass has completed (slice 4b)
  backfill_after TEXT NOT NULL DEFAULT '',
  sweep_doc_after INTEGER NOT NULL DEFAULT 0,
  sweep_purged_after TEXT NOT NULL DEFAULT '',
  sweep_workspace_after TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO search_tokens_state (id, ready, backfill_after, sweep_doc_after, sweep_purged_after, sweep_workspace_after)
  VALUES (1, 0, '', 0, '', '');
CREATE INDEX IF NOT EXISTS projects_purged ON projects(purged_at, id) WHERE purged_at IS NOT NULL;
-- Text heads of live projects (not deleted, not purged) whose workspace is not 'deleting' (a project without a
-- workspace row counts as live), with tokens absent, in progress ('') or for another revision.
-- Slice 4b must never evaluate this view per search. Changing it later needs DROP VIEW (a destructive migration).
CREATE VIEW IF NOT EXISTS search_tokens_missing AS
SELECT a.id, a.project_id FROM artifacts a
JOIN projects p ON p.id = a.project_id AND p.deleted_at IS NULL AND p.purged_at IS NULL
LEFT JOIN search_token_docs d ON d.artifact_id = a.id
WHERE a.head_rev > 0 AND a.kind <> 'binary' AND a.generation_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = COALESCE(p.workspace_id, 'wsp_' || p.owner_id) AND w.status = 'deleting')
  AND (d.revision_id IS NULL OR d.revision_id <> a.head_revision_id);
