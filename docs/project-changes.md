# Changes since last check

`list_changes` is a durable, read-only polling feed for **one explicit project**. It does not wake an agent. Use it through either MCP implementation, `GET /v1/projects/:project/changes` with an API key, or the authenticated owner `GET /api/projects/:project/changes` route.

## Checkpoint and consumption

Request arguments are `project_id` (required even for a single-project MCP connection), optional `cursor`, and `limit` (integer 1–50, default 50). HTTP routes take `cursor` and `limit` query parameters.

Without a cursor, the server returns **no historical changes**, `initialized: true`, `checkpoint: true`, `has_more: false`, and a `next_cursor` at the current committed boundary. This does not mean the project is empty. Discover existing content with normal list/search tools.

Subsequent calls return `initialized: false`, `checkpoint: false`, `changes`, `next_cursor`, `has_more`, and `retention_days: 30`. Store `next_cursor` only after processing the page. Always continue with it, including after an empty page. While `has_more` is true, pages share the first page's captured upper bound. At the end of the batch the cursor advances to that bound; the next poll captures a new one. Events committed during paging therefore arrive in the following batch. Kind-filtered events may be skipped, so an empty result can still advance a checkpoint.

This is at-least-once consumption. Deduplicate by `event_id`, and reread current artifacts rather than assuming each event is still their latest version. Cursors carry no mutable server-side consumption state. Retrying a page cursor repeats eligible events; retrying the start of a new poll may also include newly committed events because its upper boundary had not yet been captured in that input cursor. Current visibility is re-evaluated on retries, so an artifact trashed in the meantime becomes a tombstone.

```json
{"project_id":"example-project","limit":25}
```

```json
{
  "changes":[],
  "next_cursor":"pc1.<nonce>.<authenticated-ciphertext>",
  "has_more":false,
  "initialized":true,
  "checkpoint":true,
  "retention_days":30
}
```

```js
// Official MCP SDK Client, already connected and authorized by the owner.
const checkpoint = (await client.callTool({
  name: 'list_changes', arguments: {project_id: projectId}
})).structuredContent;
// Other agents now publish their work. Persist this checkpoint until processing succeeds.
let cursor = checkpoint.next_cursor;
const seen = new Set(); // persist event IDs with the consumer's state in a real application
for (;;) {
  const result = await client.callTool({
    name: 'list_changes', arguments: {project_id: projectId, cursor, limit: 25}
  });
  if (result.isError) throw new Error(JSON.stringify(result.structuredContent));
  const page = result.structuredContent;
  for (const event of page.changes) {
    if (seen.has(event.event_id)) continue;
    // Reread through this connection's existing read_artifact/read_file capability,
    // or remove the local artifact if event.tombstone is true.
    await reconcileArtifact(event);
    seen.add(event.event_id);
  }
  cursor = page.next_cursor; // persist after successful processing
  if (!page.has_more) break; // retain cursor for the next poll
}
```

```sh
# Use an existing owner-approved API key from your environment; never paste it in source.
curl -sS -H "Authorization: Bearer $AGENT_LIBRARY_API_KEY" \
  "https://mcp.example.com/v1/projects/example-project/changes"
# Pass the returned cursor, URL-encoded, on subsequent polls.
```

`test/project-changes.test.mjs` demonstrates checkpoint → an OAuth agent's create/save → owner save → a second agent's catch-up through the official legacy MCP SDK and machine API. The fixture writes a synthetic catch-up transcript to `tmp/proof-of-work/project-changes/catch-up.json`.

## Event schema and audience

Every event has a random stable `event_id`, `type`, `project_id`, `artifact_id` and server publication `occurred_at`. Visible events also have available `revision`, `sha256`, `meta_version`, `changed_fields`, `restored_from`, `connection_label`, and an authenticated owner `web_url` when `APP_HOST` is configured. Values can be null if unavailable (for example an organization-only folder event). Labels are bounded to 120 characters and control characters removed. No bodies, old titles, change notes, client info, credentials or audit entries are returned. Links open current artifacts; the feed deliberately adds no historical download or revision link capability.

Types: `artifact.created`, `artifact.content_updated`, `artifact.metadata_updated`, `artifact.trashed`, `artifact.restored`. Restoring a content version is `artifact.content_updated` with `restored_from`. Metadata restore records its source metadata version in that same field. Changed-field names are `content`, `title`, `folder`, `folder_id`, `tags`, `trashed`. A no-op metadata version may have an empty field list.

Trash events are always minimal tombstones: only the five identity/type/time fields and `tombstone: true`. **All earlier events for a currently trashed, missing or unpublished artifact are reduced to this same shape**, including for the owner. Restoring the artifact makes normal metadata available again, but the trash event itself stays minimal. Revision comments are outside this contract.

Existing project read authorization is checked again in the same D1 batch that selects events. Revoked/expired grants, OAuth connections, API keys and removed projects fail; a cursor confers no access. API/legacy grant/owner readers retain their existing file access. OAuth connections approved only for documents exclude binaries; their JSON/CSV access follows the existing App Connect flag. File-enabled OAuth connections can also observe binaries, but JSON/CSV remain hidden for every OAuth connection when App Connect is disabled. Toggling that flag changes the cursor kind audience and requires a fresh checkpoint. Publishers cannot call this project-wide tool or either project changes API; their existing own-file API remains separate.

Cursors are versioned, authenticated and encrypted with AES-GCM using a random database-local key, and bound to project, identity/connection, kind audience and scope epoch. Encryption hides global sequence values so cursors do not reveal other projects' activity counts. A connection cannot reuse another connection's checkpoint. Scope table changes (including remove/re-add) invalidate old cursors. A newly granted connection takes a new checkpoint and reconciles current content; there is no grant-time historical backfill. No permission is granted or upgraded by this feature.

The entire encoded MCP response, including duplicated text/structured content and the JSON-RPC envelope, is capped at 65,536 bytes. RPC IDs over 1,024 encoded bytes are refused without echoing them. A page may contain fewer events than `limit` to fit. HTTP responses have the same event/page bounds.

## Retention, errors and resync

Retention is fixed at 30 days in this first cut. The existing 15-minute cron deletes at most 1,000 expired rows per invocation. Under sustained overload physical cleanup can lag; cursor age still enforces the 30-day consumption window. The high sequence and deletion floor survive cleanup, including an entirely empty feed. When a batch deletes all 1,000 allowed rows, the Worker logs the structured `project_changes_cleanup_batch_full` warning with `deleted` and `limit` counts only. This signals possible cleanup saturation without leaking project or artifact IDs. Direct deletes are measured with same-batch SQLite `changes()` because D1 `meta.changes` includes retention-floor trigger writes. No new scheduler or configuration variable is required.

Errors are explicit: `invalid_cursor` (malformed/authentication failure), `unsupported_cursor_version`, `cursor_wrong_project`, `cursor_scope_changed`, `cursor_expired` (HTTP 410, `resync_required: true`), normal authorization errors and storage errors. Storage failures are never reported as an empty poll. Expiry includes an opaque `oldest_usable_cursor` at the greater of the retention floor and the supplied checkpoint, so it cannot move a reader backwards into earlier history. This describes the available boundary; it does **not** recover deleted events. Never silently substitute it for reconciliation.

Race-safe resync:

1. Call without a cursor **first**, and retain that checkpoint.
2. List/reconcile current project content using normal authorized tools.
3. Consume changes after the retained checkpoint. Deduplicate/re-read by artifact ID and revision.

Listing before taking a checkpoint can lose intervening updates.

## Publication and mutation coverage

The additive `0015_project_changes.sql` installs a dedicated event table, bounded indexes, persistent high/floor state, cursor key, scope epochs, generation coverage/context tables and publication triggers. No existing timestamp history is converted into events. Existing content is discovered normally. The event sequence is allocated by SQLite `AUTOINCREMENT` **inside the publication transaction**, never reserved by a client or based on revision timestamps.

| Mutation path | Publication boundary / event |
|---|---|
| Browser, legacy MCP, OAuth MCP, machine API document/file creation | Head revision insert; `artifact.created` |
| Browser/API/MCP saves and content restore | Guarded head move/revision insert in the existing D1 batch; `artifact.content_updated` |
| Owner/API/MCP title, tags, folder, trash, untrash, metadata restore | Guarded artifact metadata update; metadata/trash/restored event; provenance filled by same-batch metadata-version insert |
| Upload begin / PUT / abandoned or failed finalization | No readable head; no event |
| Upload finish, including OAuth file tools and replacement versions | Guarded head publication after immutable R2 validation; created/content event; retries replay existing result |
| Legacy App Connect snapshots | Guarded artifact head/revision statements inside existing atomic snapshot batch; created/content event for each visible file |
| App Connect generation staging / abandoned parts / failed gates | No materialized readable head; no event |
| App Connect generation commit | Context-gated triggers inside the existing atomic generation batch, including manifest; one creation per materialized artifact; receipt replay adds none |
| Backup restore | New project's import transaction emits only each currently readable head, never every historical revision; source revision numbers/hashes retained; a restored head above revision 1 is a content-update event |
| Folder rename | One organization metadata event per visible artifact referencing that folder; empty-folder creation has no artifact event; no folder-delete API exists in this release |
| Reads, failed writes/conflicts, comments, grants, security/admin audit | No artifact event |

Triggers handle both supported statement orders (revision before head and head before revision). They see only the successful guarded SQL writes and roll back with the surrounding transaction, including idempotency result failures. Metadata provenance updates do not create another event. Edits made entirely inside trash generate no event, so a new reader cannot discover previously invisible artifact IDs from hidden renames. Bulk imports/generations retain their existing all-or-nothing publication semantics; event writes are proportional to their existing bounded artifact counts, with no per-artifact network round trips.

D1 [batch executes statements in a transaction](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch), and each [database is single-threaded](https://developers.cloudflare.com/d1/reference/faq/). Feed queries use a single primary-bound batch for live authorization, high/floor capture and ordered selection. They do not opt into replica sessions; [without Sessions API, reads still use the primary](https://developers.cloudflare.com/d1/best-practices/read-replication/). Consequently a transaction committed after a captured high cannot later appear below it, even with an old revision timestamp or a previously allocated application revision ID. Storage tests cover timestamp/ID order, rollback and both head insertion orders; real D1 tests cover changes during paging and empty polling boundaries.

## Infrastructure and rollback

Apply migration 0014 before deploying the new bundle through the normal pipeline. It creates no Cloudflare resources, bindings, secrets, hostnames or credentials and changes no grants. It adds D1 storage/write work for publication and cleanup; monitor D1 usage against the installation's quotas. The cursor key is created locally in D1 by the migration. Backup exports contain project content, not feed cursors or keys: after a restore clients must establish fresh checkpoints.

The prior Worker remains operational on the added schema. Generation feed triggers require a marker that only the new generation batch creates and removes inside its transaction. The new implementation uses same-batch SQLite `changes()` to preserve the exact direct-write cardinality guard despite trigger side effects. Older generation code does not opt in, so its original exact-count checks remain valid after rollback. On re-upgrade the feed compares current generation pointers with tracked publication coverage: untracked generation publication invalidates existing cursors with `cursor_scope_changed` and requires resync. If a later tracked generation replaces an untracked pointer before polling, the newer immutable generation's complete publication events reconcile current state; intermediate generations published by the older Worker have no feed contract. Polling is unavailable while running the old Worker, and clients should resync after any downgrade.

For simultaneous local test runs in separate checkouts, set `AGENT_LIBRARY_TEST_PORT_SHIFT=3000` to shift every allocator-owned server/inspector/OIDC/helper port; the default remains unchanged.

Remaining limits: no UI inbox, push/webhooks, global feed, configurable retention or comments; no production deployment was performed. Local tests do not establish production latency or large-installation cleanup throughput. Browser screenshots demonstrate the existing project UI with synthetic content; there are no UI changes in this feature.
