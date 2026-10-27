-- API credentials (alk_ bearer keys) for machine clients such as Muse's REST skill.
-- General model: one owner, any number of owner-selected projects, per-project read or read+write.
-- Only the SHA-256 of the secret is stored. Expiry is mandatory (<= 90 days, enforced in code).
CREATE TABLE api_credentials (
  id TEXT PRIMARY KEY,
  owner_principal_id TEXT NOT NULL REFERENCES principals(id),
  principal_id TEXT NOT NULL REFERENCES principals(id), -- distinct agent principal (author of its writes)
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_used_at INTEGER,
  replaces_id TEXT REFERENCES api_credentials(id) -- set when created via "Replace key"
);
CREATE INDEX api_credentials_owner ON api_credentials(owner_principal_id);
CREATE TABLE api_credential_projects (
  credential_id TEXT NOT NULL REFERENCES api_credentials(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  can_write INTEGER NOT NULL CHECK (can_write IN (0,1)),
  PRIMARY KEY (credential_id, project_id)
);
CREATE INDEX api_credential_projects_project ON api_credential_projects(project_id);
