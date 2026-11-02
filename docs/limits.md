# Workspace limits (entitlements)

Self-hosted installations have no usage limits beyond core's own hard limits (file size, documents per project,
per-project file storage, rate limits). A hosted installation sets **plan limits** per workspace; this page describes
how core enforces them. (Plan phase 4; decision D18 sets the hosted free tier's starting numbers.)

## What is limited

| Limit | Counts | Scope |
|---|---|---|
| `storage_bytes` | Every stored version of every document and file, plus uploads and app generations still in flight | workspace |
| `projects` | Projects | workspace |
| `members` | Members plus pending invitations | workspace |
| `agents` | Live OAuth connections (ChatGPT, Claude…), API keys, publishing apps and project grant tokens | workspace |
| `owned_workspaces` | Shared workspaces a person created (not deleted) | person |

## How it's enforced

- Each limit is checked **inside the statement that writes** (the project, revision, upload reservation, invitation,
  key, connection or publisher INSERT), so concurrent requests can't both pass a check only one fits.
- A refusal is `402 limit_reached` with `{ limit, used, allowed }` and a message saying what to remove or upgrade.
  Nothing is written. The OAuth and publishing consent pages say so before the consent is used, so the person can go
  back and change their choice.
- **Downgrades never lose data** (decision D19, pending; this is the proposed default). A workspace over its new
  limits keeps everything and stays readable; it just can't grow until it's under the limit again: no new projects,
  members or agents, and over the storage limit no new versions (every save adds a version, so text edits are refused
  too; title, folder and tag changes, trash and deletion still work). A failed payment is different: the workspace
  becomes read-only (D11 B / D13 A).
- Replacing an OAuth connection in the same workspace doesn't need a free slot (the old one is revoked in the same
  step). Replacing an API key does, because the old key keeps working until you revoke it. Revoking frees a slot.
- Expired upload reservations and app generations stop counting when they expire. Comments and title/tag history are
  small and not counted.
- Not plan limits yet: maximum file size and version retention stay the installation-wide limits (docs/README limits)
  for every plan.
- `GET /api/workspaces/:id/usage` (any member) returns `{ storage_bytes, projects, members, agents }`, each
  `{ used, limit }` (`limit: null` = unlimited).

## Configuration (hosted)

The hosted Worker uses core's `planEntitlements`, configured by the `PLAN_LIMITS` var:

```json
{ "free": { "storage_bytes": 524288000, "projects": 10, "members": 5, "agents": 5, "owned_workspaces": 3 },
  "pro":  { "storage_bytes": 21474836480, "projects": 500, "members": 50, "agents": 50 } }
```

- A workspace's plan is `workspaces.plan` (`free` by default; billing sets it).
- A plan that isn't listed, or a missing limit, is unlimited. `PLAN_LIMITS` unset (self-host) = no limits.
- `owned_workspaces` is per person and uses the `free` plan's number.
- Invalid JSON logs `plan_limits_invalid` and applies no limits (plan data never decides access).

Other installations can supply their own `entitlements.limits(env, { workspaceId } | { principalId })` adapter.
