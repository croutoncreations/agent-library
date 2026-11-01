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
5. **Suspended or deleting workspaces are closed.** People get `workspace_suspended` (403) or 404. Agent credentials
   whose creator no longer has an active workspace role stop working: API keys, legacy grants and OAuth tokens get 401
   (`credential_inactive`, or the OAuth error), like a revoked credential. A key that still reaches another active
   project keeps working there. OAuth refresh for a *suspended* workspace answers `temporarily_unavailable` (503),
   so the provider keeps the connection and it works again when the workspace is reactivated; refresh for a revoked
   connection or removed creator is `invalid_grant`. Owners can still delete a suspended workspace.

## Data model (migration 0017, additive)

- `workspaces(id, name, personal, status, plan, created_by, created_at)`
- `workspace_members(workspace_id, principal_id, role, added_by, created_at)`
- `workspace_invites(id, workspace_id, email, role, token_hash, invited_by, created_at, expires_at, accepted_at,
  accepted_by, revoked_at)`; only the token's SHA-256 is stored.
- `project_members(project_id, principal_id, role)`
- `principals.email` (verified email from sign-in, used to match invitations)
- `workspace_id` on `projects`, `oauth_connections`, `api_credentials`, `app_clients`, `publishers`, `audits`;
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
- `PATCH /api/workspaces/:id` `{name}` (owner); `DELETE` marks it `deleting` (owner; not the personal one).
- `GET /api/workspaces/:id/members`, `PATCH …/members/:principal` `{role}`, `DELETE …/members/:principal`
  (admin+; can't remove or demote the last owner; admins can't change owners; anyone may remove themselves except
  the last owner).
- `GET|POST /api/workspaces/:id/invites` `{email, role}` (admin+); `POST …/invites/:id/revoke`. Creating an invite
  returns the accept link once (the token is never shown again). Hosted sends it by email; self-host shows it to copy.
- `POST /api/invites/accept` `{token}`: the signed-in user's verified email must match. Single use, ≤ 14 days.
- `GET /api/projects` returns projects from every workspace I can see, each with `workspace_id`; `POST /api/projects`
  takes `workspace_id` (default: my personal workspace).
- Settings lists (`/api/access`, `/api/api-keys`, `/api/app-clients`) show credentials across my workspaces:
  the ones I created, plus, in workspaces where I'm an admin, everyone's. `/api/app-clients` lists the apps I
  registered or administer (each with `workspace_id`) and, in `other_publishers`, publishers of other apps that I
  connected or can revoke as a project admin. `POST /api/app-clients` takes `workspace_id` (default personal; admin).
- `POST /api/backup/restore` works only on a single-owner installation with no projects (`MULTI_USER` unset and at
  most one person); shared installations answer 403 `restore_unavailable`.

## OAuth consent

The consent page lists projects from every workspace where the signer can grant access, grouped under workspace
headings when there is more than one. A connection covers projects from one workspace only (its `workspace_id`;
the server refuses a mix). A new project created on the consent page goes in the workspace of the picked projects,
or the one chosen in "New projects go in" (offered for workspaces where the signer is an admin). Projects where the
signer is a viewer offer Read only.

## Isolation tests

`test/tenancy.test.mjs`, `test/tenancy-oauth.test.mjs` and `test/tenancy-matrix.test.mjs` run several workspaces
and people against a real local server. They cover sessions, API keys (`/v1`), legacy grants (HTTP and MCP), OAuth
connections (MCP) and publishers: another workspace's projects, documents, content, history and search are 404 or
absent, roles are enforced, removal and demotion cut off the agents a person connected on the next request, and a
suspended workspace is closed. `test/tenancy-browser.test.mjs` covers the UI in Chrome (it skips without Chrome, and
a skip is not a pass).
