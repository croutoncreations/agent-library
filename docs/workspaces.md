# Workspaces, members and roles

Every project belongs to exactly one **workspace**. People get access to projects only through workspace
membership, which lives in D1 and is checked on every request. A self-hosted installation has one workspace (the
owner's) and looks exactly as before; the hosted service gives each new user a personal workspace and lets them
create shared ones and invite people.

## Roles

| Action | owner | admin | member | viewer |
|---|---|---|---|---|
| See the workspace's projects and read documents and files | ✓ | ✓ | ✓ | ✓ |
| Create and edit documents, upload files, comment | ✓ | ✓ | ✓ | – |
| Connect agents (OAuth) and create API keys, up to their own access | ✓ | ✓ | ✓ | read-only |
| Create projects; manage legacy grants, project audit and backup | ✓ | ✓ | – | – |
| Register App Connect apps in the workspace; list and disable them and revoke any publisher in its projects | ✓ | ✓ | – | – |
| Invite and remove members, change roles (admins can't touch owners) | ✓ | ✓ | – | – |
| Rename or delete the workspace, billing, transfer ownership | ✓ | – | – | – |

A workspace always has at least one owner. A `project_members` row can narrow one person's role for one project
(`none` hides it); it never widens.

## Rules

1. **D1 is the only source of access.** The identity provider (Cloudflare Access, Supabase) only says who someone
   is. Roles and membership are never read from token claims.
2. **Agents never exceed the person who connected them.** Every delegated credential records the human who created
   it (`created_by`): OAuth connections, API keys, legacy grants and App Connect publishers. On every request the
   credential works only while that person is still a member of the project's workspace with a role that allows the
   operation (read: viewer+, write: member+, publish: member+), and the credential's own scope allows it.
   Removing someone, or lowering their role, takes effect on the next request of every agent they connected.
3. **Other workspaces' things are 404**, never 403, so IDs can't be probed. On a shared installation project ids
   are always assigned by the server: a chosen id (`POST /api/projects {id}`) is refused (400), because "already
   exists" would reveal another workspace's project. Single-owner installations keep chosen ids.
4. **Administration is human-only** and needs the admin role in that workspace. No agent tool manages members,
   grants or keys.
5. **Suspended workspaces are read-only; deleting workspaces are closed** (decisions D11 B, D13 A). While suspended
   (e.g. a failed payment), people and agents can still read, download, search, see history and export; OAuth and
   publisher refresh keep working, so connections survive. Every write is refused with 403 `workspace_read_only`:
   saves, uploads, restores, comments, trash and rename, folders and templates, publishing, new projects and imports,
   new or replaced API keys, Edit grants, app settings, invitations, role changes and renaming. Cleanup still works: revoking keys, connections, grants and
   publishers, removing members, leaving and deleting the workspace. A workspace being deleted is closed: people get
   404, agent credentials 401, and refresh is `invalid_grant`, like a revoked connection or a removed creator.
   Its documents and files start being deleted 30 days after deletion ([below](#deleting-a-workspace)).

## Data model (migration 0017, additive)

- `workspaces(id, name, personal, status, plan, created_by, created_at)`
- `workspace_members(workspace_id, principal_id, role, added_by, created_at)`
- `workspace_invites(id, workspace_id, email, role, token_hash, invited_by, created_at, expires_at, accepted_at,
  accepted_by, revoked_at)`; only the token's SHA-256 is stored.
- `project_members(project_id, principal_id, role)`
- `principals.email` (verified email from sign-in, used to match invitations)
- `workspace_id` on `projects`, `oauth_connections`, `api_credentials`, `app_clients`, `publishers`, `audits`
  (migration 0019 fills it for every project-scoped audit row; app audits write it explicitly);
  `created_by` on `oauth_connections`, `api_credentials`, `publishers` (`grants.created_by` already exists).

**Existing data needs no rewrite.** A human's personal workspace has the deterministic id `wsp_<principal id>`. The
migration inserts one for every existing human (with them as owner). Rows written before 0017, or by a rolled-back
Worker, have `workspace_id` NULL and mean "the owner's personal workspace": queries resolve
`COALESCE(projects.workspace_id, 'wsp_' || projects.owner_id)`, and a credential's creator is
`COALESCE(created_by, owner_principal_id)`. The new Worker still fills `projects.owner_id` (with the workspace's
creator) so the previous Worker keeps working after a rollback. Migration 0018 adds a partial index so project lists
find those legacy rows without scanning.

**Rolling back past 0017 re-grants workspace creators.** The previous Worker knows only `projects.owner_id`. After a
rollback, the person who created a shared workspace gets full access to all of its projects (even if they were
removed, or the workspace is suspended), and every other member is locked out. Only roll back past 0017 while no
shared workspace exists, or accept this for the rollback window.

## Browser API

- `GET /api/workspaces`: workspaces I belong to, with my role and member count.
- `POST /api/workspaces` `{name}`: create a shared workspace (I'm its owner). Self-host: allowed for the owner.
- `PATCH /api/workspaces/:id` `{name?, handle?}` (owner); `DELETE` `{confirm_name}` marks it `deleting` and records when (owner; not the personal one; the workspace's name must be typed, else 400 `confirmation_required`); its content is deleted from 30 days later.
- `GET /api/workspaces/:id/members`, `PATCH …/members/:principal` `{role}`, `DELETE …/members/:principal`
  (admin+; can't remove or demote the last owner; admins can't change owners; anyone may remove themselves except
  the last owner).
- `GET|POST /api/workspaces/:id/invites` `{email, role}` (admin+); `POST …/invites/:id/revoke`. Creating an invite
  returns the accept link once (the token is never shown again) and `emailed`: true if the installation's
  `inviteCreated` hook sent it (hosted, SendGrid). The link is always returned too, so it can be copied if the email is
  late or filtered; self-host (no hook) shows it to copy.
- `POST /api/invites/accept` `{token}`: the signed-in user's verified email must match. Single use, ≤ 14 days.
- `GET /api/projects` returns projects from every workspace I can see, each with `workspace_id` and `path`;
  `POST /api/projects` takes `workspace_id` (default: my personal workspace) and optional `slug`;
  `PATCH /api/projects/:id` `{title?, slug?}` (project admin).
- Deleting a project ([below](#deleting-a-project)): `DELETE /api/projects/:id {confirm_title}`,
  `POST /api/projects/:id/restore`, `POST /api/projects/:id/purge {confirm_title}` (delete permanently now), and
  `GET /api/workspaces/:id/deleted-projects` (workspace admins).
- Settings lists (`/api/access`, `/api/api-keys`, `/api/app-clients`) show credentials across my workspaces:
  the ones I created, plus, in workspaces where I'm an admin, everyone's. `/api/app-clients` lists the apps I
  registered (while I'm still a member of the app's workspace) or administer, each with `workspace_id`; each app's
  publishers are listed only where I connected them or can see their project. `other_publishers` lists publishers of
  other apps that I connected or can revoke as a project admin. `POST /api/app-clients` takes `workspace_id` (default
  personal; admin). A member may connect an app they registered into a project where they can write (like an API key
  it never exceeds their role); that project's admins see and can revoke it.
- `POST /api/workspaces/:id/import` `{backup, title?}` (admin of an active workspace): imports a project backup as a
  **new** project in that workspace. Every id is new (project, documents, versions, comments, file keys), so nothing
  collides with or reveals another workspace's ids. Authors in the backup aren't trusted as accounts: every version
  and comment is attributed to the importer, keeping the original provenance labels. The workspace page offers it as
  "Import a project from a backup". The whole backup is checked (hashes, kinds, tags, version numbers, the
  per-project document and file limits, see [Limits](limits.md#import--export)) before anything is written, and file bytes are removed again if the
  database write fails. Requests are capped at 2 MB (`413 backup_too_large`; about 1.5 MB of files, since backups
  embed files as base64), so larger projects can't be imported yet. At most 2,000 versions and 2,000 comments per import. Send an `Idempotency-Key` to make retries safe (reusing
  it with a different backup is `422 idempotency_key_reused`).
  Imported version labels are marked "(imported)". (Decision D8 B.)
- `POST /api/restore` (whole-store restore with original ids) works only on a single-owner installation with no
  projects (`MULTI_USER` unset and at most one person); shared installations answer 403 `restore_unavailable`.

## Deleting a project

Decision D21 B. Workspace owners and admins delete a project from Project settings by typing its name.
- **At once:** it is closed to everyone and to every agent. `memberRoleSql` excludes deleted projects, and every human,
  API key, grant, OAuth and publisher gate is built from it. A deleted project answers like one that never existed (404),
  and a credential whose only project it was is inactive (401 `credential_inactive`). It is removed from every list, stops counting
  toward the `projects` limit, and its address is free for a new project. Its files still count toward storage.
- **30 days:** admins see it under **Recently deleted** on the workspace page, and can restore it (if the projects limit
  has room) with all its content, history and agent access. It gets its old address back, or a fresh one if that was
  taken meanwhile. **Delete permanently** skips the wait.
- **Who:** deleting, restoring and deleting permanently all need the admin or owner role in the workspace (a
  per-project role cap doesn't change that), in an active workspace. Restoring needs room in the projects limit, and in
  the agents limit for its legacy grant tokens.
- **Then:** the 15-minute cron (`purgeDueProjects`) removes its R2 files and its content rows (documents, versions,
  comments, details history, folders, uploads, change feed, idempotency, publisher generations and snapshots, per-project
  roles), in bounded batches, skipping a project while an upload is inside its finish lease. Kept, all closed: the
  `projects` row as a tombstone (title "Deleted project", no address), grants, API keys, OAuth connections and their
  project scopes, publishers, and audits. At purge, its grants and publishers are revoked, and so are API keys and OAuth
  connections that have no live project left. Audits `project.delete`, `project.restore`, `project.purge_requested` and `project.purge`.
- **Restore closes an hour before `purge_at`** (409 `purge_started`), so a restore and a purge on different clocks can't
  overlap; each purge step also re-checks that the project is still deleted and due, and the final tombstone and
  revocations run only if it is. After the rows, both R2 prefixes (`blobs/<id>/`, `staging/<id>/`) are swept for files
  no row names. Credentials are revoked only when every project they cover is purged, so a project still in Recently
  deleted keeps its agent access for a restore.
- **Migration 0024** adds `deleted_at`, `deleted_by`, `purge_at`, `purged_at` and `deleted_slug` to `projects`.
  **Rollback risk:** a Worker from before this change doesn't know `deleted_at`, so after a rollback deleted (not yet
  purged) projects are open again to their members and agents, under no address. Purged ones show as empty "Deleted
  project" rows. Roll back across this change only in an emergency, and delete any project that must stay closed again
  once the new Worker is back.

## Deleting a workspace

Owners delete a shared workspace on its page by typing its name. The personal workspace can't be deleted.
- **At once:** it is closed to everyone and every agent (rule 5), and `deleting_at` records when.
- **From 30 days later** (`WORKSPACE_PURGE_GRACE_DAYS`, as for a deleted project), the 15-minute cron
  (`purgeDeletingWorkspaces`, `workspace-purge.js`) first marks the workspace (`purge_marked_at`), then marks every
  live project of it deleted and due. The project purge ([above](#deleting-a-project)) removes their content:
  documents, versions, comments, files and their R2 objects, and the rest it lists. Projects already in Recently
  deleted have reached their own purge date by then and go with the rest. Once no project is left, the workspace gets
  `purged_at`.
- **30 days is the earliest, not an exact time.** The project purge handles 5 projects per run across the whole
  installation, in the order they fell due, so a large workspace takes several runs and shares that queue with
  ordinary project deletions. A project's purge waits while an upload into it is finishing; none can still be running
  30 days after a workspace was closed.
- **What "deleted" means.** Files are deleted from R2 when the purge reaches them; Agent Library keeps no other copy.
  Database rows are deleted, but the whole database can still be restored to an earlier moment with D1 Time Travel
  for its retention window (30 days on Workers Paid, 7 on Free), and any database export or backup the operator made
  still holds them. The full-text search index may keep word fragments in its internal segments until it compacts
  them; they can't be reached through the app (the same is true of the project purge). An import's retry record
  (`backup.import` idempotency) holds the imported project's title for up to 30 days from the import.
- **What stays:** the workspace row (its name and address, which stays taken), its members, invitations, billing
  record and audits, its app registrations, revoked credentials (agent credentials are revoked as their projects are
  purged), and the projects' tombstones. Deleting a workspace does not cancel its subscription.
- **Undoing a deletion** is an operator job, possible only until the workspace is marked
  ([operations](operations.md#monitoring)).
- **Migration 0035** adds `deleting_at`, `purge_marked_at` and `purged_at` to `workspaces`, and the index
  `projects_live`. Workspaces deleted before it get `deleting_at` from the first cron run after the upgrade (up to 100
  per run), so their 30 days start then. A rolled-back Worker marks no new workspaces, but projects already marked
  keep being purged; the new Worker finishes the workspace afterwards. A workspace deleted while the older Worker runs
  gets its 30 days from the new Worker's first cron run.

## Addresses

Decisions D10 B and D14 A. Every workspace has a **handle** that is unique on the installation (`acme`) and every
project a **slug** that is unique inside its workspace (`notes`), so a project's **path** is `acme/notes` and its link
is `https://<app>/acme/notes` (documents: `…/acme/notes/a/<id>`, with `/preview` or `/edit`).

- **Storage keys don't change.** Projects keep their `prj_…` id everywhere (tables, R2 keys, API ids). A path is an
  alias, resolved to the id on each request; authorization then runs on the id as before. A path someone can't open
  answers exactly like an unknown one (404 `not_found`, same body).
- **Accepted wherever a project id is**: browser API (`/api/projects/acme%2Fnotes/…`), `/v1` (`/v1/projects/acme%2Fnotes/…`),
  MCP `project_id` (`"acme/notes"`), and search `project_ids`. `list_projects`, `GET /v1/projects` and
  `GET /api/projects` return each project's `path`.
- **Links** (`web_url`, `preview_url`, `version_url`) use the path, only for projects the caller can open, and only in
  the fields this code generates (top level, `artifact`/`file`/`template`, and items of its result lists). Stored
  content (files, records, text, backups, renders) is never rewritten. Old `/p/<id>` links keep working.
- **Handles**: 1–39 of `a-z 0-9 -`, not starting or ending with `-`, and not a reserved word (app and API routes such
  as `api`, `p`, `settings`, `auth`, `billing`; see `RESERVED_HANDLES` in `packages/core/src/paths.js`). A shared
  workspace's handle is chosen at creation (`{handle}`) or derived from its name (`-2`… then a random suffix when
  taken). A personal workspace's handle is **random** (`u-k3x9m2p7`): never derived from a name or email, and never
  confirming that someone has an account. Its owner can change it.
- **Slugs**: 1–64 of `a-z 0-9 -`; derived from the title (`Q3 Notes!` → `q3-notes`, then `-2`, `-3` … in that
  workspace) unless one is chosen.
- **Changing** a handle (workspace owner) or slug (project admin) changes every link that used the old one; those
  links then answer "not available" (ids still work). The app asks for confirmation. A released handle can be taken by
  another workspace, which is one reason a path never grants anything by itself. Changes are audited
  (`workspace.handle`, `project.address`).
- **Migration 0020** adds `workspaces.handle` (unique) and `projects.slug` (unique per `workspace_id`), both nullable.
  Rows without them, including rows a rolled-back Worker writes, get them on first use (at most 20 per request, to stay
  within D1's per-request query limit; the rest on later requests); a project given a slug also
  gets its `workspace_id` filled in (the personal workspace, as resolved today), so the previous Worker keeps working.
- **Later**: subdomains (`acme.<domain>`) as an optional alias (D14).

## OAuth consent

The consent page lists projects from every workspace where the signer can grant access, grouped under workspace
headings when there is more than one. A connection covers projects from one workspace only (its `workspace_id`;
the server refuses a mix). A new project created on the consent page goes in the workspace of the picked projects,
or the one chosen in "New projects go in" (offered for every active workspace where the signer is an admin, even one
without projects; checked again inside the insert). Projects where the signer is a viewer offer Read only. Lists
show at most 500 projects on the consent page and 1000 in the app.

## Isolation tests

`test/tenancy.test.mjs`, `test/tenancy-oauth.test.mjs` and `test/tenancy-matrix.test.mjs` run several workspaces
and people against a real local server. They cover sessions, API keys (`/v1`), legacy grants (HTTP and MCP), OAuth
connections (MCP) and publishers: another workspace's projects, documents, content, history and search are 404 or
absent, roles are enforced, removal and demotion cut off the agents a person connected on the next request, and a
suspended workspace is read-only and a deleting one closed. `test/tenancy-browser.test.mjs` covers the UI in Chrome (it skips without Chrome, and
a skip is not a pass).
