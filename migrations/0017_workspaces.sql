-- Workspaces, members and roles (docs/workspaces.md). Additive and retry-safe; the previous Worker keeps working:
-- it ignores the new tables and columns and keeps using projects.owner_id / *.owner_principal_id, which stay
-- populated (owner_id = the workspace's creator) for every row the new Worker writes.
--
-- Model: every project belongs to exactly one workspace. A human's access to a project comes only from
-- workspace_members (D1 is the source of truth; identity-provider claims never grant access). Delegated
-- credentials (OAuth connections, API keys, legacy grants, publishers) record the human who created them and
-- work only while that human is still a member with enough role in the project's workspace.

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,                     -- wsp_…
  name TEXT NOT NULL,
  personal INTEGER NOT NULL DEFAULT 0 CHECK (personal IN (0,1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleting')),
  plan TEXT NOT NULL DEFAULT 'free',       -- entitlements key (hosted); self-host ignores it
  created_by TEXT NOT NULL REFERENCES principals(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  role TEXT NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
  added_by TEXT REFERENCES principals(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, principal_id)
);
CREATE INDEX IF NOT EXISTS workspace_members_principal ON workspace_members(principal_id);

-- Invitations: only the SHA-256 of the token is stored. Accepting requires a signed-in human whose verified
-- email matches (case-insensitive). Single use; expiry enforced in code (<= 14 days).
CREATE TABLE IF NOT EXISTS workspace_invites (
  id TEXT PRIMARY KEY,                     -- inv_…
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  email TEXT NOT NULL,                     -- lower-cased
  role TEXT NOT NULL CHECK (role IN ('admin','member','viewer')),
  token_hash TEXT NOT NULL UNIQUE,
  invited_by TEXT NOT NULL REFERENCES principals(id),
  created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  accepted_by TEXT REFERENCES principals(id),
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS workspace_invites_workspace ON workspace_invites(workspace_id);

-- Optional narrower per-project roles (UI later). A row here caps a member's role for one project.
CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL REFERENCES projects(id),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  role TEXT NOT NULL CHECK (role IN ('admin','member','viewer','none')),
  PRIMARY KEY (project_id, principal_id)
);

-- Verified email for human principals (from the identity provider at sign-in), used to match invitations.
ALTER TABLE principals ADD COLUMN email TEXT;

ALTER TABLE projects ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
CREATE INDEX IF NOT EXISTS projects_workspace ON projects(workspace_id, created_at);

-- Workspace of each owner-level object, and the human who created each delegated credential.
ALTER TABLE oauth_connections ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
ALTER TABLE oauth_connections ADD COLUMN created_by TEXT REFERENCES principals(id);
ALTER TABLE api_credentials ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
ALTER TABLE api_credentials ADD COLUMN created_by TEXT REFERENCES principals(id);
ALTER TABLE app_clients ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
ALTER TABLE publishers ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
ALTER TABLE publishers ADD COLUMN created_by TEXT REFERENCES principals(id);
ALTER TABLE audits ADD COLUMN workspace_id TEXT;
CREATE INDEX IF NOT EXISTS oauth_connections_workspace ON oauth_connections(workspace_id);
CREATE INDEX IF NOT EXISTS api_credentials_workspace ON api_credentials(workspace_id);
CREATE INDEX IF NOT EXISTS app_clients_workspace ON app_clients(workspace_id);
CREATE INDEX IF NOT EXISTS publishers_workspace ON publishers(workspace_id);
CREATE INDEX IF NOT EXISTS audits_workspace ON audits(workspace_id, seq);

-- Every human principal has a personal workspace 'wsp_' || principal id, owned by them. Existing humans are
-- backfilled here; the trigger covers humans created later by any Worker version (including a rolled-back one).
-- Projects with workspace_id NULL (written before 0017 or by a rolled-back Worker) belong to the personal workspace
-- of their owner_id: code resolves COALESCE(projects.workspace_id, 'wsp_' || projects.owner_id). Nothing existing
-- is rewritten.
INSERT OR IGNORE INTO workspaces (id, name, personal, status, plan, created_by, created_at)
  SELECT 'wsp_' || id, 'Personal', 1, 'active', 'free', id, created_at FROM principals WHERE kind = 'human';
INSERT OR IGNORE INTO workspace_members (workspace_id, principal_id, role, added_by, created_at)
  SELECT 'wsp_' || id, id, 'owner', id, created_at FROM principals WHERE kind = 'human';
CREATE TRIGGER IF NOT EXISTS principals_personal_workspace AFTER INSERT ON principals WHEN NEW.kind = 'human'
BEGIN
  INSERT OR IGNORE INTO workspaces (id, name, personal, status, plan, created_by, created_at)
    VALUES ('wsp_' || NEW.id, 'Personal', 1, 'active', 'free', NEW.id, NEW.created_at);
  INSERT OR IGNORE INTO workspace_members (workspace_id, principal_id, role, added_by, created_at)
    VALUES ('wsp_' || NEW.id, NEW.id, 'owner', NEW.id, NEW.created_at);
END;
