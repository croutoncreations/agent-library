-- App Connect staged generations (local fixture only; owner-approved local contract change).
-- Bounded multi-part publisher exports: parts are staged invisibly, verified, then materialized as immutable
-- artifacts and a snapshot row in ONE gated batch at commit. Legacy snapshot tables/constraints are unchanged.
--
-- Bounds enforced by src/api/generations.ts (not by SQL CHECKs, so they can be advertised and tuned in one place):
--   part <= 32768 UTF-8 bytes; <= 2048 parts and <= 32 MiB per generation; <= 2 staged generations per publisher;
--   staged TTL 24 h; retained (committed + staged) bytes <= 256 MiB and committed parts <= 16384 per publisher.
-- Cleanup may delete ONLY rows with state IN ('staged','abandoned') whose staging is expired/abandoned, and only
-- their part rows. Committed generations, their part receipts and materialized artifacts are never deleted.

-- Materialized generation artifacts are tagged so the legacy 32-file quota / name map can exclude them.
-- Existing rows get NULL (= legacy). The existing UNIQUE (publisher_id, export_name) index is kept as is,
-- so a generation part name can never collide with a legacy file name or another generation's part name.
ALTER TABLE artifacts ADD COLUMN generation_id TEXT;
CREATE INDEX artifacts_generation ON artifacts(publisher_id, generation_id) WHERE generation_id IS NOT NULL;

CREATE TABLE publisher_generations (
  publisher_id TEXT NOT NULL REFERENCES publishers(id),
  id TEXT NOT NULL,                          -- client generation_id: g_[A-Za-z0-9_-]{1,64}
  project_id TEXT NOT NULL REFERENCES projects(id),  -- scope bound at begin (must equal publisher's project)
  folder_id TEXT,                            -- destination bound at begin (NULL = project root)
  token_epoch INTEGER NOT NULL,              -- epoch at begin; commit re-checks the live epoch in its gate
  source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
  expected_current_snapshot_id TEXT,         -- CAS value, checked only on the first (non-replay) commit
  root_name TEXT NOT NULL,
  root_sha256 TEXT NOT NULL CHECK (length(root_sha256) = 64),
  part_count INTEGER NOT NULL CHECK (part_count BETWEEN 1 AND 2048),
  total_bytes INTEGER NOT NULL CHECK (total_bytes BETWEEN 1 AND 33554432),
  coverage TEXT,                             -- JSON {from,to} verbatim or NULL
  exported_at TEXT,
  begin_digest TEXT NOT NULL,                -- sha256 of canonical begin metadata: retries must match exactly
  state TEXT NOT NULL CHECK (state IN ('staged','committed','abandoned')),
  created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL,               -- ms epoch; meaningful only while state = 'staged'
  committed_at TEXT,
  snapshot_id TEXT,                          -- snp_… set atomically with state = 'committed'
  receipt TEXT,                              -- original commit response JSON, replayed for committed retries
  abandoned_at TEXT,
  PRIMARY KEY (publisher_id, id),
  CHECK ((state = 'committed') = (snapshot_id IS NOT NULL AND receipt IS NOT NULL AND committed_at IS NOT NULL))
);
CREATE INDEX publisher_generations_active ON publisher_generations(publisher_id, expires_at) WHERE state = 'staged';
CREATE INDEX publisher_generations_cleanup ON publisher_generations(state, expires_at);
CREATE UNIQUE INDEX publisher_generations_snapshot ON publisher_generations(snapshot_id) WHERE snapshot_id IS NOT NULL;

CREATE TABLE publisher_generation_parts (
  publisher_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128),   -- [A-Za-z0-9._-]{1,128}, immutable once uploaded
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  bytes INTEGER NOT NULL CHECK (bytes BETWEEN 1 AND 32768),     -- exact UTF-8 byte length
  body TEXT,                                 -- staged content; set to NULL at commit (bytes then live in revisions)
  artifact_id TEXT,                          -- materialized immutable artifact, set at commit
  revision_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (publisher_id, generation_id, name),
  FOREIGN KEY (publisher_id, generation_id) REFERENCES publisher_generations(publisher_id, id),
  CHECK ((body IS NULL) = (artifact_id IS NOT NULL))
);
CREATE INDEX publisher_generation_parts_artifact ON publisher_generation_parts(artifact_id) WHERE artifact_id IS NOT NULL;
