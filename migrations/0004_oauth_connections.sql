-- OAuth connections (ChatGPT etc.). One row per owner-approved connection; server-generated id.
-- Bound to: verified owner principal, OAuth client + redirect URI, one project, one resource,
-- a scope ceiling, an expiry and revocation state. Checked live on every MCP call.
CREATE TABLE oauth_connections (
  id TEXT PRIMARY KEY,
  owner_principal_id TEXT NOT NULL REFERENCES principals(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  resource TEXT NOT NULL,
  can_read INTEGER NOT NULL CHECK (can_read = 1),
  can_write INTEGER NOT NULL CHECK (can_write IN (0,1)),
  oauth_grant_id TEXT,
  created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_used_at INTEGER
);
CREATE INDEX oauth_connections_project ON oauth_connections(project_id);
CREATE INDEX oauth_connections_owner ON oauth_connections(owner_principal_id);
-- Upstream (Access for SaaS) identities linked to the owner principal: (issuer, subject) -> principal.
CREATE TABLE upstream_identities (
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (issuer, subject)
);
