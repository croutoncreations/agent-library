-- Review gating (docs/review-gating.md, build-review.mjs). Additive and retry-safe: new columns with defaults,
-- new tables and indexes with IF NOT EXISTS, and triggers. The previous Worker keeps working on this schema:
-- it never reads these columns or tables, and its inserts get the defaults.
--
-- Fail closed on rollback: review_gate_revisions / review_gate_meta refuse an agent (oauth, api_key, grant)
-- version or details version on a document whose review_mode is 'required', unless the row comes from an approved
-- proposal (proposal_id set, and that proposal is in the 'approving' state inside the same transaction). The
-- previous Worker never sets proposal_id, so after a rollback its agent writes to gated documents fail instead of
-- bypassing review. Owner (browser) and App Connect (publisher) writes are never gated.
-- review_default_on_insert applies the project default to every new non-publisher document, whichever Worker
-- creates it (publisher files keep 'off').
-- Retry: applied as one unit with its d1_migrations row (see 0010_version_history.sql). ALTER TABLE ADD COLUMN is
-- not retry-safe on its own in SQLite; D1 applies each migration file in one transaction, so a failed apply leaves
-- nothing behind and a retry starts clean.

ALTER TABLE artifacts ADD COLUMN review_mode TEXT NOT NULL DEFAULT 'off';
-- 1 while a new document exists only as a proposal (head_rev = 0, placeholder title). Hidden from everyone's
-- lists and reads (lists, search, the feed and reads already skip head_rev = 0) and not counted against the
-- project's document limit until approved.
ALTER TABLE artifacts ADD COLUMN pending_review INTEGER NOT NULL DEFAULT 0;
-- Title and folder of a gated new file upload, held until upload_finish turns the upload into a proposal.
ALTER TABLE uploads ADD COLUMN review_meta TEXT;
-- Project default for new documents, in its own table (projects keeps its columns: tools and fixtures insert into it
-- positionally). No row = off. kinds: JSON array of kinds the default applies to; NULL = every kind.
CREATE TABLE IF NOT EXISTS project_review_settings (
  project_id TEXT PRIMARY KEY,
  review_default TEXT NOT NULL CHECK (review_default IN ('off','advisory','required')),
  kinds TEXT
);
ALTER TABLE revisions ADD COLUMN proposal_id TEXT;
ALTER TABLE meta_versions ADD COLUMN proposal_id TEXT;
-- OAuth reviewers fetch a proposed file's bytes through a short-lived transfer link (kind 'download', proposal_id set):
-- the link serves the proposal, re-checking the live connection, file access and reviewer/proposer on every use.
-- Older Workers never read this column and never see such links as anything but a revision download of rev_no NULL,
-- which they refuse (Revision not found).
ALTER TABLE transfer_links ADD COLUMN proposal_id TEXT;

-- Can review: a separate, owner-granted permission per access path and project. Never granted to publishers.
-- path_kind: 'oauth' (oauth_connections.id), 'api_key' (api_credentials.id) or 'grant' (grants.id).
CREATE TABLE IF NOT EXISTS review_grants (
  path_kind TEXT NOT NULL CHECK (path_kind IN ('oauth','api_key','grant')),
  path_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (path_kind, path_id, project_id)
);
CREATE INDEX IF NOT EXISTS review_grants_project ON review_grants(project_id);

-- Pending edits of required documents. Never revisions: the approved line (artifacts.head_rev) only ever holds
-- approved, owner-written or pre-review content.
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approving','approved','rejected','superseded','withdrawn')),
  is_new INTEGER NOT NULL DEFAULT 0,
  supersedes_id TEXT,
  base_rev INTEGER NOT NULL,
  base_meta_version INTEGER NOT NULL,
  -- content (NULL when the proposal changes details only)
  has_content INTEGER NOT NULL DEFAULT 0,
  body TEXT,
  blob_key TEXT,
  size INTEGER,
  sha256 TEXT,
  mime TEXT,
  restored_from INTEGER,
  -- details (NULL when the proposal changes content only)
  has_meta INTEGER NOT NULL DEFAULT 0,
  title TEXT,
  folder TEXT,
  folder_id TEXT,
  tags TEXT,
  meta_restored_from INTEGER,
  -- who and why (same fields as revisions)
  author_id TEXT NOT NULL,
  via_kind TEXT NOT NULL,
  via_id TEXT,
  via_label TEXT,
  client_info TEXT,
  change_note TEXT,
  created_at TEXT NOT NULL,
  -- outcome
  decided_at TEXT,
  result_rev INTEGER,
  result_meta_version INTEGER,
  review_id TEXT,
  upload_id TEXT,
  blob_purged_at TEXT
);
-- One open proposal per author per document.
CREATE UNIQUE INDEX IF NOT EXISTS proposals_one_open ON proposals(artifact_id, via_kind, via_id) WHERE status IN ('pending','approving');
CREATE INDEX IF NOT EXISTS proposals_project_status ON proposals(project_id, status, created_at);
CREATE INDEX IF NOT EXISTS proposals_artifact ON proposals(artifact_id, status);
CREATE INDEX IF NOT EXISTS proposals_blob ON proposals(blob_key) WHERE blob_key IS NOT NULL;

-- Review records, bound to one exact version (rev_no) and/or details version (meta_version) or a proposal.
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  rev_no INTEGER,
  meta_version INTEGER,
  proposal_id TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('approved','approved_with_edits','rejected')),
  author_id TEXT NOT NULL,
  via_kind TEXT,
  via_id TEXT,
  via_label TEXT,
  client_info TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reviews_artifact_rev ON reviews(artifact_id, rev_no);
CREATE INDEX IF NOT EXISTS reviews_proposal ON reviews(proposal_id);

-- Backup restore imports history as it was (including agent versions from before a document required review):
-- the restore batch inserts this row first and deletes it last, and the triggers below skip while it exists.
CREATE TABLE IF NOT EXISTS review_restore_context (id INTEGER PRIMARY KEY CHECK (id = 1));

CREATE TRIGGER IF NOT EXISTS review_gate_revisions BEFORE INSERT ON revisions
WHEN NEW.via_kind IN ('oauth','api_key','grant')
  AND NOT EXISTS (SELECT 1 FROM review_restore_context)
  AND EXISTS (SELECT 1 FROM artifacts WHERE id = NEW.artifact_id AND review_mode = 'required')
  AND NOT EXISTS (SELECT 1 FROM proposals WHERE id = NEW.proposal_id AND artifact_id = NEW.artifact_id AND status = 'approving')
BEGIN
  SELECT RAISE(ABORT, 'review_required');
END;
CREATE TRIGGER IF NOT EXISTS review_gate_meta BEFORE INSERT ON meta_versions
WHEN NEW.via_kind IN ('oauth','api_key','grant')
  AND NOT EXISTS (SELECT 1 FROM review_restore_context)
  AND EXISTS (SELECT 1 FROM artifacts WHERE id = NEW.artifact_id AND review_mode = 'required')
  AND NOT EXISTS (SELECT 1 FROM proposals WHERE id = NEW.proposal_id AND artifact_id = NEW.artifact_id AND status = 'approving')
BEGIN
  SELECT RAISE(ABORT, 'review_required');
END;
CREATE TRIGGER IF NOT EXISTS review_default_on_insert AFTER INSERT ON artifacts
WHEN NEW.publisher_id IS NULL AND NEW.review_mode = 'off'
  AND NOT EXISTS (SELECT 1 FROM review_restore_context)
  AND EXISTS (SELECT 1 FROM project_review_settings s WHERE s.project_id = NEW.project_id AND s.review_default <> 'off'
    AND (s.kinds IS NULL OR EXISTS (SELECT 1 FROM json_each(s.kinds) WHERE value = NEW.kind)))
BEGIN
  UPDATE artifacts SET review_mode = (SELECT review_default FROM project_review_settings WHERE project_id = NEW.project_id) WHERE id = NEW.id;
END;
