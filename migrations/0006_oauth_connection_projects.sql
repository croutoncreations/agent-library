-- Multi-project OAuth connections. Authoritative per-project permissions for a connection.
-- oauth_connections.project_id stays (NOT NULL, legacy) and holds the first chosen project only;
-- authorization always uses this table. Existing single-project connections are backfilled.
CREATE TABLE oauth_connection_projects (
  connection_id TEXT NOT NULL REFERENCES oauth_connections(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  can_write INTEGER NOT NULL CHECK (can_write IN (0,1)),
  PRIMARY KEY (connection_id, project_id)
);
CREATE INDEX oauth_connection_projects_project ON oauth_connection_projects(project_id);
INSERT INTO oauth_connection_projects (connection_id, project_id, can_write)
  SELECT id, project_id, can_write FROM oauth_connections;
