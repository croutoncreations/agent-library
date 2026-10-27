-- Agent Library prototype schema. Every project-owned row carries project_id.
CREATE TABLE principals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('human','agent')),
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (issuer, subject)
);
CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  csrf TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES principals(id),
  title TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE grants (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  token_hash TEXT NOT NULL UNIQUE,
  can_write INTEGER NOT NULL CHECK (can_write IN (0,1)),
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_by TEXT NOT NULL REFERENCES principals(id),
  created_at TEXT NOT NULL
);
CREATE INDEX grants_project ON grants(project_id);
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL CHECK (kind IN ('markdown','binary')),
  title TEXT NOT NULL,
  folder TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  head_rev INTEGER NOT NULL DEFAULT 0,
  head_revision_id TEXT,
  meta_version INTEGER NOT NULL DEFAULT 1,
  meta_request_id TEXT,
  trashed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id, project_id)
);
CREATE INDEX artifacts_project ON artifacts(project_id, updated_at);
CREATE TABLE revisions (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  rev_no INTEGER NOT NULL,
  author_id TEXT NOT NULL REFERENCES principals(id),
  body TEXT,
  blob_key TEXT,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  mime TEXT NOT NULL,
  restored_from INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (artifact_id, rev_no),
  FOREIGN KEY (artifact_id, project_id) REFERENCES artifacts(id, project_id)
);
CREATE TABLE uploads (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  base_rev INTEGER NOT NULL,
  expected_size INTEGER NOT NULL,
  expected_sha256 TEXT NOT NULL,
  mime TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','receiving','received','sealed','published','conflict','failed')),
  staging_key TEXT NOT NULL,
  final_revision_id TEXT,
  received_size INTEGER,
  received_sha256 TEXT,
  result TEXT,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (artifact_id, project_id) REFERENCES artifacts(id, project_id)
);
CREATE INDEX uploads_principal ON uploads(principal_id, state);
CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  rev_no INTEGER NOT NULL,
  author_id TEXT NOT NULL REFERENCES principals(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (artifact_id, project_id) REFERENCES artifacts(id, project_id)
);
CREATE TABLE idempotency (
  principal_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  op TEXT NOT NULL,
  key TEXT NOT NULL,
  digest TEXT NOT NULL,
  status INTEGER NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, project_id, op, key)
);
-- Audit rows never contain document bodies, tokens or transfer capabilities.
CREATE TABLE audits (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  project_id TEXT,
  action TEXT NOT NULL,
  object_id TEXT,
  rev_no INTEGER,
  result TEXT NOT NULL,
  request_id TEXT NOT NULL
);
