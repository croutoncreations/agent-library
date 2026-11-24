-- App Files (docs/app-connect.md#title-author-and-change-note): the per-write author label an app sends with
-- X-Agentlib-Author, kept next to the version it describes. History shows "<label> via <app>"; the app (via_*) stays the
-- actor and nothing reads this column for authorization. NULL = no label (every write before this, and every other path).
-- Additive and nullable: the previous Worker never reads it.
ALTER TABLE revisions ADD COLUMN on_behalf_of TEXT;
ALTER TABLE meta_versions ADD COLUMN on_behalf_of TEXT;
