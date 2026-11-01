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
| Create, rename, trash projects; manage legacy grants, app registrations, publishers | ✓ | ✓ | – | – |
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
3. **Other workspaces' things are 404**, never 403, so IDs can't be probed.
4. **Administration is human-only** and needs the admin role in that workspace. No agent tool manages members,
   grants or keys.
5. **Suspended or deleting workspaces are closed**: every request for their projects fails (`workspace_suspended`,
   403) for people and agents, and OAuth refresh fails.

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
creator) so the previous Worker keeps working after a rollback.

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
- Settings lists (`/api/access`, `/api/api-keys`, `/api/app-clients`) take `?workspace=` (default personal) and
  show that workspace's credentials. Members see the ones they created; admins see all.

## OAuth consent

The consent page lists projects from every workspace where the signer can grant access, grouped by workspace. A
connection covers projects from one workspace only (its `workspace_id`); creating a new project on the consent page
puts it in the chosen workspace. Viewers can grant read access only.

## Isolation tests

`test/tenancy.test.mjs` runs two workspaces with several people against a real local server and checks every
credential type (session, API key, OAuth connection, legacy grant, publisher) against the browser API, `/v1` and MCP:
another workspace's projects and documents are 404, roles are enforced, removal and demotion cut off the agents a
person connected on the very next request, and a suspended workspace is closed.
