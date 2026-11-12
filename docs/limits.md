# Limits

This page lists every limit Agent Library enforces. It is checked against the code (`packages/core/src`). If you change
a limit, change this page too.

There are three kinds of limit:

- **Fixed:** set in code, the same on every installation.
- **Configurable:** a Worker var with a default (set it in `wrangler.toml` under `[env.hosted.vars]`; see
  [wrangler.example.toml](../wrangler.example.toml)). Leave it unset to keep the default.
- **Plan:** an entitlement key, set per workspace plan by the entitlements adapter (the hosted service uses
  `PLAN_LIMITS`, see [Plan limits](#plan-limits-entitlements)). A self-hosted installation has no plans: plan limits
  are unlimited, except `items_per_project`, `file_bytes` and `rate_multiplier`, which fall back to the var or default
  shown.

Sizes are binary: 1 KiB = 1,024 bytes, 1 MiB = 1,048,576 bytes. The app shows them as "KB" and "MB". **Platform
ceilings** are set by Cloudflare and can't be raised by configuration; they're marked _ceiling_.

Common error shapes: a plan limit is `402 limit_reached` with `{ limit, used, allowed }` and a message saying what to
remove. A string that's too long is `413 too_large`; a number out of range is `400 invalid_input`. Rate limits are
`429 rate_limited` with `retry_after_seconds`.

## Documents & files

| Limit | Default | Scope | Configure | When you hit it |
|---|---|---|---|---|
| Text document size (Markdown, HTML, JSON, CSV) | 10 MiB (10,485,760 UTF-8 bytes) | document version | fixed; text versions are stored in R2, not a D1 row | `413 too_large` "Markdown exceeds 10 MiB" |
| File size (images, PDF, video, other uploads) | 25 MiB | file version | `FILE_MAX_BYTES`; plan `file_bytes`. Never above 90 MiB (_ceiling_: Cloudflare refuses requests over 100 MB, and a file is sent in one PUT). Measured on Cloudflare (Workers Paid, 2026-11-10): 25 MiB works; 50 and 80 MiB uploads fail with 1102 (resource limits), so keep `file_bytes` at 25 MiB or less until uploads stop passing the file through the Worker twice | `413 too_large` "Files can be up to 25 MB on this plan", `{ limit: "file_bytes", allowed }` |
| Storage | unlimited | workspace | plan `storage_bytes` | `402 limit_reached` |
| JSON nesting | 64 levels | document | fixed | `422 invalid_content` |
| CSV columns | 16,384 | header row (data rows must match the header's width) | fixed (`MAX_CSV_COLUMNS`) | `422 invalid_content`, format `csv`, line 1: "Invalid csv: more than 16384 columns"; also refused on spreadsheet export of older files |
| Measurement records | 100,000 per file; JSON records at most 16,384 characters each | JSON and CSV measurements documents | fixed (`MAX_MEASUREMENT_RECORD_CHARS` for JSON record size) | `422 invalid_content`; oversized JSON record: "Invalid schema: record larger than 16384 characters" |
| Title | 1–200 characters | document, file, project, template | fixed | `413 too_large` |
| Tags | 20 per document, each 1–50 characters | document | fixed | `400 invalid_input` / `413 too_large` |
| Change note | 280 characters | version | fixed | `413 too_large` |
| Comment | 1–10,000 characters | comment | fixed; new bodies are stored in R2, legacy inline D1 bodies remain readable | `413 too_large` |
| Versions kept | all, forever | document | fixed (only `storage_bytes` bounds them) | — |

Server rendering has separate limits: Markdown preview shows the first 256 KiB (shown as 256 KB in the app) of a larger document, cut back to a line break within the final 16 KiB; HTML pages over 1 MiB (shown as 1 MB) are not rendered in the app or through view links. A cut-off preview is still useful but a cut-off page is not, and the Markdown renderer costs more memory per byte. Editing, download, history and agent reads still work up to 10 MiB.

For non-identical text versions, history diff returns a summary with no line hunks when either version exceeds 1 MiB; identical hashes still return the identical result.

The text limit is a storage bound, not a memory guarantee. Server CSV validation and spreadsheet export handle rows one at a time; one row's cells, at most the header's column count (bounded by 16,384), are held at a time. Export allocates output bytes after counting their size; HEAD only counts. Measurements validation also retains at most 100,000 ids for duplicate detection. There is no generic CSV row-count or cell-size cap beyond the text size limit. Browser CSV preview still parses whole files; JSON files are validated without being built in memory, and record queries read one record at a time, but concurrent requests still share the Worker's 128 MB memory ceiling.

## Projects & folders

| Limit | Default | Scope | Configure | When you hit it |
|---|---|---|---|---|
| Projects | unlimited | workspace | plan `projects` | `402 limit_reached` |
| Documents and files | 10,000 (including trashed items and uploads in progress; not App Connect files) | project | `PROJECT_ITEMS_MAX`; plan `items_per_project` | `402 limit_reached` `{ limit: "items_per_project" }` |
| File bytes per project | 100 MiB | project | `PROJECT_BINARY_BYTES` (`"0"` = no per-project cap; workspace `storage_bytes` still applies) | `413 quota_exceeded` `{ used_bytes, limit_bytes }` |
| Folders | 1,000 | project | fixed | `409 too_many_folders` |
| Folder name | 1–80 characters, no `/` | folder | fixed | `400 invalid_input` |
| Deleted project kept | 30 days (restore closes 1 hour before) | project | fixed | `409` when restore is too late |

## Workspaces & members

| Limit | Default | Scope | Configure | When you hit it |
|---|---|---|---|---|
| Members (accepted only) | unlimited | workspace | plan `members` | invite refused while the workspace is already full; accepting refused when full: `402 limit_reached` "This workspace is full…" |
| Pending invitations | unlimited | workspace | plan `pending_invites` | `402 limit_reached` |
| Shared workspaces you own | unlimited | person | plan `owned_workspaces`, from the plan of your personal workspace (else the `free` plan's number) | `402 limit_reached` |
| Invitation lifetime | 14 days | invitation | fixed | `410 invite_used` |
| Workspace name | 1–80 characters | workspace | fixed | `400 invalid_input` |

## Agents, keys & connections

| Limit | Default | Scope | Configure | When you hit it |
|---|---|---|---|---|
| Connected agents (OAuth connections, API keys, publishing apps, project grant tokens) | unlimited | workspace | plan `agents` | `402 limit_reached` (consent pages say so first) |
| API key lifetime | choice of 1, 7, 30, 90 (default), 365 days or never | key | plan `max_key_lifetime_days` (absent = any, including never) | `400 invalid_input` for other values; `402 limit_reached` `{ limit: "max_key_lifetime_days" }` over the plan |
| Projects per API key | 1–50 | key | fixed | `400 invalid_input` |
| Projects per OAuth connection | 50 (one workspace) | connection | fixed | consent page: "Pick at most 50 projects." |
| New projects created on a consent page | 5 | consent | fixed | — |
| OAuth connection lifetime | never expires (until revoked); access tokens last 15 minutes and refresh | connection | fixed | — |
| Project grant token lifetime | 1–720 hours (default 24) | token | fixed | `400 invalid_input` |
| Publishing app snapshots | 32 files, 256 MiB per app | app | fixed | `413 quota_exceeded` |

## Search & lists

The owner's document-list filter matches titles only, for both legacy inline and R2-backed documents. Body matching
will return through the blind index in slice 4b. The separate ranked search searches titles and the first 1 MiB of stored text until the blind-index slice.

| Limit | Default | Scope | Configure | When you hit it |
|---|---|---|---|---|
| Document list page | 50 per page, offset up to 100,000 | request | fixed | `next_cursor`; `400` past the offset |
| Ranked search | query 1–200 characters and 1–16 words; up to 20 project ids; limit 1–50 (default 20); reply up to 64 KiB | request | fixed | `400 invalid_input`; a full reply sets `has_more` |
| Search cursor | 15 minutes | cursor | fixed | `400 invalid_cursor` "start again" |
| Change feed (`list_changes`) | 1–50 per page (default 50), reply up to 64 KiB | request | fixed | `has_more`; old cursors `410 cursor_expired` |
| Chunked reads (`max_bytes`) | 64 KiB, range 4 KiB–512 KiB | request | fixed | `400 invalid_input` |
| History | 50 versions per page | request | fixed | `next_cursor` |
| Data records | 1–500 per page (default 100) | request | fixed | `400 invalid_input` |
| Comments | 200 per page, newest page first | request | fixed | `next_cursor` for older comments |
| Capped lists: projects you can see 1,000 (consent page 500), workspaces 200, members 500, invitations 200, API keys 200, connections 100 per project / 200 overall, grant tokens 200, app clients 100, publishers 500, recently deleted 200, project audit 200 | as listed | request | fixed | The first N are returned and `truncated` names the cut lists (`[]` = complete); the app shows "Showing the first N" |

## Uploads & transfers

The app API and `/v1` upload endpoints accept Markdown, HTML, JSON and CSV text up to 10 MiB (10,485,760 bytes).
Normally one text finish runs at a time per isolate. The slot covers reading, validating and publishing the document.
Another text finish (of a different upload) receives retryable `503 text_finish_busy` with `retry_after_seconds: 1`; retry with the same idempotency key.
The slot expires with the 60-second finalize lease. A finish that stalls past its lease can overlap with the next one.
The slot does not bound other operations on large text.
MCP `upload_begin` (legacy and OAuth) accepts text as well as binary files; OAuth upload tools still require file-enabled consent, and JSON/CSV still require App Connect. `upload_file` stays binary-only. `/v1` uploads accept text only.

Before rolling the Worker back to a version from before text uploads, let text uploads finish or expire.
The older Worker returns `500` when finishing one and does not clean up its text placeholder or temporary object.
Its cron can mark `staging_purged_at` without removing the temporary object. After rolling forward, that object
is no longer found by cleanup and remains until the project is purged.

| Limit | Default | Scope | Configure | When you hit it |
|---|---|---|---|---|
| Upload reservation | 15 minutes, at most 24 hours | upload | `UPLOAD_TTL_SECONDS` (larger values are capped at 86400) | `410 upload_expired` |
| Uploads at once | 1 | agent or person | fixed | `429 upload_in_progress` |
| Upload body | exactly the declared size and SHA-256, checked at the PUT (a `Content-Length` other than the declared size is refused before anything is stored) | upload | fixed | `413 too_large` (longer) or `400 incomplete_body` (shorter): the upload stays writable, PUT the whole file again; `422 integrity_mismatch` (other bytes): the upload ends, start a new one with `upload_begin` |
| MCP `upload_file` (inline base64) | 2 MiB decoded | call | fixed | `413 too_large`: use `upload_begin` + PUT |
| MCP inline image in `read_file` | 1 MiB | call | fixed | only a download link |
| MCP download links | 10 minutes | link | fixed | link expires |
| View links (rendered page / file) | 5 / 30 minutes | link | fixed | the app asks for a new one |
| Request body: app API | 11 MiB (11,534,336 bytes) for document/data create and save; 2 MiB for every other route (including backup import/restore) | request | fixed | `413 too_large`; message names the request-size limit |
| Request body: legacy MCP (`/mcp` with a grant token) | 2 MiB | request | fixed | `413` JSON-RPC `-32600` |
| Request body: OAuth MCP | 1 MiB; 3 MiB for connections with file access | request | fixed | `413` JSON-RPC `-32600` |
| Request body: `/v1` API and publisher snapshots | 11 MiB for `/v1` file create and save; the `/v1` upload PUT takes raw bytes up to the declared size (10 MiB for text); 6.5 MB (6,500,000 bytes) for other `/v1` routes and publisher snapshots | request | fixed | `413 too_large`; message names the request-size limit |
| Request body: publisher generation parts | 256 KiB | request | fixed | `413` |

App API, `/v1` and legacy MCP bodies are counted in UTF-8 bytes as they arrive and never buffered past the cap. `Content-Length` is checked before buffering. The 10 MiB storage limit depends on the transport: JSON escaping can push a smaller document above the 11 MiB request cap, producing `413`. MCP caps are unchanged; not every transport can write a 10 MiB document inline.

The three-step upload path also accepts Markdown, HTML, JSON and CSV as raw UTF-8, up to 10 MiB per version, independent of `file_bytes`. Document content is validated at finish. These versions are ordinary text and count against workspace storage; they do not consume the project binary-byte allowance. Upload reservations count before publication. The JSON routes still have their existing request caps, so JSON escaping can make a valid document too large for those routes; use a raw upload from an HTTP-capable client instead. OAuth upload tools still require file-enabled consent; JSON/CSV still require App Connect.

For app API and legacy MCP, an over-cap body is read and discarded (up to 16 MiB) before the `413` is sent, so a client that sends the whole body still sees
the error instead of a reset connection.

## Import & export

| Limit | Default | Scope | Configure | When you hit it |
|---|---|---|---|---|
| Backup export | 16 MiB of files (distinct file versions), and 32 MiB of text (sum of text revision sizes) | project | fixed; checked before reading any object | `413 backup_too_large`; download documents/files individually or export a smaller project |
| Export of a project with App Connect files | refused | project | fixed | `409 backup_unsupported` |
| Backup import request | 2 MiB | request | fixed | `413 backup_too_large` |
| Imported documents and files | `items_per_project` (10,000 by default), and at most 2,000 per import (one D1 batch) | import | `PROJECT_ITEMS_MAX`; plan `items_per_project` | `400 bad_backup` |
| Imported versions, comments, details versions | 2,000 each | import | fixed | `400 bad_backup` |
| Imported file bytes | `PROJECT_BINARY_BYTES` (`"0"` = no cap) | import | `PROJECT_BINARY_BYTES` | `400 bad_backup` |
| Workspace limits on import | `projects`, `storage_bytes` | workspace | plan | `402 limit_reached` |

Comments are not counted in the 32 MiB backup export text budget.

Text versions and comments cost one R2 call per body on import, restore and export (export of legacy inline bodies
needs no R2 read). Import and restore also use about one D1 call per 100 bodies for staging, plus the publication
batch and fixed validation/cleanup calls. All object operations run with at most six in flight.
Cloudflare's [subrequest limits](https://developers.cloudflare.com/workers/platform/limits/#subrequests) mean
the combined 2,000-version and 2,000-comment import caps fit Workers Paid (10,000 subrequests). On Workers Free
(1,000 calls to Cloudflare services), an import, restore or export with more than roughly 900 R2 text/comment bodies fails. This is a platform ceiling,
not a plan check; file versions and other request work also consume calls.

## Sign-in & sessions

| Limit | Default | Scope | Configure | When you hit it |
|---|---|---|---|---|
| Browser session | 30 days | session | fixed | signed out |
| Sign-in in progress | 10 minutes | sign-in | fixed | "start again" |
| Email address | up to 254 characters | sign-in | fixed | "That doesn't look like an email address" |

## Rate limits

Fixed one-minute windows, counted in D1. Over the limit: `429 rate_limited` with `retry_after_seconds`. OAuth MCP
returns a tool error the agent can read instead (`rate_limited`, `retry_after_seconds`, `limit_per_minute`).

| Limit | Default | Scope | Configure | When you hit it |
|---|---|---|---|---|
| Reads | 240 per minute for agents; 720 for people (3×) | agent identity or person | `RATE_READS_PER_MIN`; agents × plan `rate_multiplier` | `429 rate_limited` |
| Writes | 60 per minute for agents; 180 for people (3×) | agent identity or person | `RATE_WRITES_PER_MIN`; agents × plan `rate_multiplier` | `429 rate_limited` |
| OAuth MCP file downloads | 300 per minute | connection | fixed | `429` |
| Failed authentication | 30 per minute | IP | `RATE_AUTHFAIL_PER_MIN` | `429` |
| OAuth authorize / token / register | 30 / 60 / 10 per minute | IP | × `OAUTH_RATE_MULTIPLIER` | `429` |
| Sign-in starts | 20 per minute | IP | `RATE_SIGNIN_PER_MIN` × `OAUTH_RATE_MULTIPLIER` | `429` |
| Sign-in emails | 5 per minute | IP | `RATE_SIGNIN_EMAIL_PER_MIN` × `OAUTH_RATE_MULTIPLIER` | `429` |
| Sign-in emails | 2 per minute | email address | `RATE_SIGNIN_EMAIL_PER_ADDRESS_PER_MIN` × `OAUTH_RATE_MULTIPLIER` | `429` |

"Agents" are OAuth connections, API keys, publishing apps and project grant tokens. `rate_multiplier` is 1 unless the
workspace plan sets it.

## Retention & cleanup

The cron job runs every 15 minutes. Each step is bounded per run and later runs catch up.

| Limit | Default | Scope | Configure | When you hit it |
|---|---|---|---|---|
| Audit log | 365 days | installation | `AUDIT_RETENTION_DAYS` (`"0"` = keep forever) | older rows removed, up to 5,000 per run |
| Idempotency records | 30 days | installation | fixed | a retry older than that is treated as a new request; up to 5,000 per run |
| Sign-in sessions | removed once expired | installation | fixed | up to 5,000 per run |
| Change feed | 30 days, up to 10,000 rows per run | project | fixed | `410 cursor_expired` for older cursors |
| Deleted projects | purged after 30 days | project | fixed | large projects take several runs |
| Abandoned uploads | removed after their reservation plus a 10-minute grace | upload | `UPLOAD_CLEANUP_GRACE_SECONDS` | — |
| A new document or file whose upload never finished | its hidden placeholder is removed a day after the upload expired, up to 100 per run | project | fixed | until then it counts toward `items_per_project` |

A full batch logs a warning (`retention_cleanup_batch_full`, `project_changes_cleanup_batch_full`); a failed
retention run logs `retention_failed` and the next run tries again.

## Plan limits (entitlements)

A hosted installation sets plan limits per workspace; core enforces them. (Plan phase 4; decision D18 sets the hosted
free tier's starting numbers, D22 the current keys.)

| Key | Counts | Scope | Without a value |
|---|---|---|---|
| `storage_bytes` | Every stored version of every document and file, plus uploads and app generations in flight | workspace | unlimited |
| `projects` | Live projects | workspace | unlimited |
| `members` | Accepted members | workspace | unlimited |
| `pending_invites` | Invitations not yet accepted, revoked or expired | workspace | unlimited |
| `agents` | Live OAuth connections, API keys, publishing apps and project grant tokens | workspace | unlimited |
| `owned_workspaces` | Shared workspaces a person created (not deleted) | person | unlimited |
| `items_per_project` | Documents and files in one project, including trashed ones and upload placeholders | project | `PROJECT_ITEMS_MAX`, default 10,000 |
| `file_bytes` | Size of one file version | file | `FILE_MAX_BYTES`, default 25 MiB; never above 90 MiB |
| `rate_multiplier` | Multiplies agent read and write rate limits (integer ≥ 1) | workspace | 1 |
| `max_key_lifetime_days` | Longest API key lifetime | workspace | any, including never |

### How it's enforced

- Each limit is checked **inside the statement that writes** (the project, document, revision, upload reservation,
  invitation, membership, key, connection or publisher INSERT), so concurrent requests can't both pass a check only
  one fits.
- A refusal is `402 limit_reached` with `{ limit, used, allowed }` and a message saying what to remove or upgrade.
  Nothing is written. The OAuth and publishing consent pages say so before the consent is used, so the person can go
  back and change their choice. `file_bytes` is the exception: `413 too_large` with `{ limit: "file_bytes", allowed }`.
- Inviting needs a free `pending_invites` slot, and is refused when the workspace already has no room for another
  member. Accepting checks `members` again. Someone who is already a member takes no new slot.
- Replacing an OAuth connection in the same workspace doesn't need a free slot (the old one is revoked in the same
  step). Replacing an API key does, because the old key keeps working until you revoke it. Revoking frees a slot.
- Expired upload reservations and app generations stop counting when they expire. Comments and title/tag history are
  small and not counted.
- `GET /api/workspaces/:id/usage` (any member) returns `storage_bytes`, `projects`, `members`, `pending_invites` and
  `agents`, each `{ used, limit }`, plus `file_bytes` and `max_key_lifetime_days` as `{ limit }` (`limit: null` =
  unlimited). The app uses these to show usage, the file size limit and the key lifetimes you can pick.

### Downgrades

**Downgrades never lose data** (decision D19, pending; this is the proposed default). A workspace over its new limits
keeps everything and stays readable; it just can't grow until it's under the limit again:

- no new projects, members, invitations or agents, and no new documents in a project over `items_per_project`;
- over the storage limit, no new versions (every save adds a version, so text edits are refused too; title, folder and
  tag changes, trash and deletion still work);
- files already stored stay, but new uploads must fit the new `file_bytes`; existing API keys keep their expiry, new
  keys must fit `max_key_lifetime_days`; a lower `rate_multiplier` applies at once.

Deleting a project (Project settings) frees its projects slot at once; its storage is freed when it's removed for good
(after 30 days, or with Delete permanently). A failed payment is different: the workspace becomes read-only (D11 B /
D13 A).

### Rolling back the Worker

Migration 0026 only adds indexes, so an earlier Worker runs on the new schema and no data is corrupted. Worker
rollback doesn't undo data written under these limits, and the earlier Worker treats it differently:

- It caps a project at 100 documents and files, so projects that grew past 100 can't take new items.
- Its backup export has no 16 MiB cap, so exporting a large project can run the Worker out of memory.
- It counts pending invitations as members, so it may refuse invitations this version allowed.
- API keys created with "Never expires" (stored with `expires_at` 9999-01-01) stay valid.

### Configuration (hosted)

The hosted Worker uses core's `planEntitlements`, configured by the `PLAN_LIMITS` var: JSON
`{ "<plan>": { <key>: <integer>, ... }, ... }` with the keys above. For example:

```json
{ "free": { "storage_bytes": 524288000, "projects": 10, "members": 2, "pending_invites": 2, "agents": 5,
            "owned_workspaces": 1, "items_per_project": 500, "file_bytes": 26214400, "max_key_lifetime_days": 90 },
  "pro":  { "storage_bytes": 21474836480, "projects": 500, "members": 5, "pending_invites": 20, "agents": 50,
            "owned_workspaces": 20, "items_per_project": 5000, "file_bytes": 26214400, "rate_multiplier": 2 } }
```

- A workspace's plan is `workspaces.plan` (`free` by default; billing sets it).
- A plan that isn't listed, or a missing key, is unlimited (or core's default for `items_per_project`, `file_bytes`
  and `rate_multiplier`). `PLAN_LIMITS` unset (self-host) = no plan limits.
- `owned_workspaces` is per person: the plan of the person's personal workspace, else the `free` plan's number.
- Invalid JSON logs `plan_limits_invalid` and applies no plan limits (plan data never decides access).
- With workspace storage governing, the hosted service sets `PROJECT_BINARY_BYTES = "0"` (no per-project file cap).

Other installations can supply their own `entitlements.limits(env, { workspaceId } | { principalId })` adapter.

## Billing

Core keeps a provider-neutral billing state per workspace (`workspace_billing`, `billing_events`; migration 0022) and
decides what a billing change does, in one batch (`billing.js` `applyBillingChange`):

- **Replay-safe:** each provider event id is applied at most once; a redelivered event changes nothing.
- **Ordered:** an event older than the last applied status change is ignored, so a late delivery can't undo a newer one.
  Adapters send the subscription's *current* state, fetched from the provider, not the event's payload.
- **Paid** (`active`, `trialing`, and `past_due` while the provider retries) sets `workspaces.plan` to the paid plan.
  Cancelled or lapsed sets it back to `free`, and over-limit data is kept (D19).
- **Payment failure** (`unpaid`: a renewal still unpaid after the provider's retries) suspends the workspace:
  read-only, nothing deleted (D11 B / D13 A). Free limits apply until it's paid. Paying lifts it; cancelling the
  unpaid subscription also lifts it (Free, over-limit growth blocked). Billing lifts only a suspension it set itself.
  A first payment that never completed (`incomplete_expired`) doesn't suspend anything.
- **One customer, one open subscription per workspace.** The stored customer is never replaced; events for another
  customer, or for a second subscription while one is open, are refused and logged (`billing_event_refused`) so the
  duplicate can be refunded.
- Operators who suspend a workspace by hand should also set `workspace_billing.suspended_by_billing = 0`, so a later
  payment can't lift their suspension.
- Every applied change is audited as `workspace.billing` (actor `system:billing`).

The entitlements adapter may add `billing(env, { workspaceId })`. Its result shows on the workspace page for admins and
owners only: plan, status, a notice, and actions (same-origin POST routes that answer `{ url }` on the provider's page).
The hosted Worker's Stripe adapter is in the private hosted repository.
