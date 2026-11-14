-- The owner's own name for an OAuth connection (docs/architecture.md#agent-access). NULL = none chosen: the connection is shown
-- under oauth_connections.client_name, the name the app reported about itself. Display name = COALESCE(label, client_name).
-- Additive and nullable: the previous Worker never reads it and keeps showing client_name.
ALTER TABLE oauth_connections ADD COLUMN label TEXT;
