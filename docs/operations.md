# Self-host operations

How to upgrade, back up and roll back your installation. Keep your config, the release you deployed, Worker version IDs and backups somewhere private. Never put credentials or real library data into Git. If you deploy from GitHub, see [deploy-pipeline.md](deploy-pipeline.md).

## Upgrade

1. Read the [changelog](../CHANGELOG.md) for the new release, including any new migrations. Use a tagged release and the Node version in `.node-version`.
2. Back up the projects you care about (see below).
3. In the new checkout, run `npm ci`, then generate config into a **new** directory with the same `.self-host.json`: `npm run setup:self-host -- --input .self-host.json --out dist/self-host-NEXT`. Compare it with your previous `dist/self-host/wrangler.json`. The generator never overwrites existing output or touches your Cloudflare resources.
4. See what will change: `npx wrangler d1 migrations list DB --config dist/self-host-NEXT/wrangler.json --remote`. Migrations shipped here are additive only.
5. Apply and deploy: `npx wrangler d1 migrations apply DB --config dist/self-host-NEXT/wrangler.json --remote`, then `npx wrangler deploy --config dist/self-host-NEXT/wrangler.json`. (Pipeline users: merge to `main` instead; never deploy by hand alongside the pipeline.)
6. Check that you can sign in, an agent can read and write, revoking still works, and an upload round-trips. Keep the previous output directory until you're happy.

## What backups cover

Project backups cover projects, documents and files you and your agents create, through the browser, MCP or `/v1` keys.

**Projects with more than 16 MB of files can't be backed up as one file yet.** A backup embeds every file (base64) in one JSON response built in Worker memory, so the export is refused (`413 backup_too_large`) when the project's distinct file versions add up to more than 16 MB; download large files individually. (A streamed backup format is planned.)

**App Connect files are backed up as ordinary files.** An app's file is exported with `app: { name, path }` (the path is null once the file is trashed; backup schema 3). Restoring or importing such a backup creates ordinary, editable files in the project: the title is the path, the tag is `app:<name>`, they stay in a folder of the same name (a document's folder is exported as `folder_name` and recreated by name), and they are no longer tied to any app, so a re-connected app writes fresh files beside them.

## Backup and recovery

**Connections → Agent tokens → Backup** (owner only) downloads one project as a JSON file: its documents and files, every revision, comments and the binary data they reference, each with a hash. It never includes credentials, sessions or agent grants. Store backups privately and encrypted, outside your Cloudflare account, and try a restore with test data before you rely on them.

Limits:
- It's one project at a time, held in memory, so projects with more than 16 MB of files are refused (see above and [Limits](limits.md#import--export)). There's no whole-account backup yet.
- Folders aren't included (see above).
- Cloudflare D1's own point-in-time recovery restores the database but not R2 files, so it isn't a complete backup on its own.

Restoring has no UI yet. Send the backup JSON to `POST /api/restore` from a signed-in owner session (with the CSRF header); `test/a12-durability.test.mjs` shows a full round trip. Restore only into an **empty** library, such as a fresh installation. It refuses a library that already has content, checks every hash and creates no agent access. Reconnect your agents afterwards.

Restore stores a backup's values as given. A hand-edited backup can therefore put values the app never writes into your own installation (for example binary values in text fields, or document ids the UI cannot address); restore refuses only what could never be stored. Import, by contrast, checks every value against the app's own rules.

If a restore answers `store_not_empty` (409) after you started it on an empty store, it may have completed despite the error. Reload the app and check your projects before retrying.

Restored file keys carry a per-attempt suffix, so a retried restore never overwrites an earlier attempt's objects. A restore or import failure whose outcome is unknown (for example a lost connection after the database committed) deletes nothing and logs `backup_cleanup_skipped`; such unreferenced objects are not reclaimed by this release.

## Rollback

Note the current Worker version ID before each upgrade. To roll back the code, run `npx wrangler rollback <version-id>` with your config. (If you use the [deploy pipeline](deploy-pipeline.md), its next run will refuse because a hand-made version is live; follow its [Recovery](deploy-pipeline.md#recovery) table instead.) **Rollback only reverts the Worker.** D1 migrations, R2 files, KV state and secrets stay as they are. Migrations are additive, but schema compatibility does not guarantee data compatibility. A Worker from before this release cannot restore a history version larger than about 2 MB; the restore fails without changing data.

**Do not roll back past the text-in-R2 release (migration 0028) once it has taken text writes; fix forward.** A Worker from before 0028 reads those text versions as empty: saving one stores empty text as a new version, restoring one creates a broken version, record reads and backup export fail, and they drop out of search. If rollback is unavoidable, treat the library as read-only until the newer Worker is back.

## Monitoring

File storage and backup log events (ids, counts and codes only; never headers or content):

| Event | Meaning |
|---|---|
| `blob_corrupt` with `reason` | a file read found the stored object inconsistent with its database row (`reason` names the check); the client gets `500 blob_corrupt` |
| `upload_blob_inconsistent` with `reason` | upload finish found the stored object unlike the upload's record; the upload ends `500 publish_failed` |
| `backup_cleanup_skipped` with `count`, `reason` | a backup import or restore left `count` written file objects in place: `outcome_unknown` (the batch may have committed), `reference_query_failed` or `delete_failed` |

Five catch-all log lines record an unexpected error. `unhandled` (the app and its API on the app host),
`file_transfer_error` (`/files/` transfer links on the MCP host) and `content_host_error` (view links on the content
host) carry the request id, the error's name (or its type, if it has none) and its message; a parse error
(`SyntaxError`) is logged without its message, because the message quotes the input. `v1_unhandled` (`/v1`) and
`app_api_unhandled` (the App Connect API, `/v1/app`) carry the request id and the error's name only. Every reply
except the content host's includes the same request id as `request_id`.

Watch Worker errors and your D1, R2 and KV usage in the Cloudflare dashboard, and check that the 15-minute cleanup job runs. Each run also removes, at most 5,000 rows per table, expired sign-in sessions, idempotency records older than 30 days (a retried request older than that is treated as new) and audit rows older than `AUDIT_RETENTION_DAYS` (default 365; `0` keeps them forever). A `retention_cleanup_batch_full` warning means a table had more to remove; the next runs catch up. Free tiers cover a typical personal library, but usage above them is billed to your account. Review connected agents now and then, and revoke the ones you no longer use. Never widen your Access policy to work around a sign-in problem.

### Database size

Each 15-minute cleanup run measures the D1 database with one trivial query (`SELECT 1`) and reads the size D1 reports
with it. It logs one line per run, with no workspace, project or user data:

| Event | Meaning |
|---|---|
| `db_size` `{size_bytes}` | the database size in bytes; `size_bytes` is `null` when the platform did not report one (local development) |
| `db_size_warning` `{size_bytes, warn_bytes}` | `size_bytes` reached `DB_SIZE_WARN_BYTES` (logged on every run while it does) |
| `db_size_config_invalid` | `DB_SIZE_WARN_BYTES` is set but is not a positive integer; no warning is logged (once per Worker isolate) |
| `db_size_failed` `{message}` | the measurement failed; the other cleanup steps are not affected and the next run tries again |

`DB_SIZE_WARN_BYTES` is optional (a Worker var in bytes, see `wrangler.example.toml`); unset means `db_size` is logged
and nothing warns. A D1 database is capped at 10 GB and cannot grow past it. On Workers Paid, 3 GB, 5 GB and 7 GB are
reasonable thresholds: set `3221225472` for an early notice, and move it up (or watch `size_bytes` yourself) as you
plan a split or an export. On Workers Free (500 MB per database) use about 400 MB (`419430400`).

To alert, turn on [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
(`[observability] enabled = true` in your `wrangler.toml`), then in the dashboard's Observability section filter on the
event name (`db_size_warning`), save the query and add a notification, or watch `size_bytes` over time from `db_size`.
The first run of each UTC day also stores its size in the `db_size_samples` table (`day`, `size_bytes`, `sampled_at`;
migration 0032), pruned after 400 days: `SELECT day, size_bytes FROM db_size_samples ORDER BY day DESC LIMIT 30;`.
The step costs two D1 queries per run (three on the first run of a day), counted with the other cleanup steps
(limits.md#retention--cleanup).

Deleted workspaces (workspaces.md#deleting-a-workspace) log ids, counts and error codes only:
- `workspace_purge` `{marked, recovered, projects_marked, pending, finished}` once per run when any count is non-zero
  (`recovered`: workspaces whose failed project marking was completed; `pending`: marked workspaces still waiting for
  their projects to be purged);
- `workspace_purge_skipped` `{workspaceId, reason: "no_longer_due"}` when a workspace was undone, or marked by
  another run, between selection and marking;
- `workspace_purge_failed` `{workspaceId, step: "mark" | "mark_projects" | "recover" | "finish", code}` or
  `{step: "run", code}`; later runs try again.
A run marks at most 5 workspaces, completes at most 5 failed project markings and checks at most 10 marked workspaces
for the finish. A workspace whose marking always fails holds one of the 5 marking slots and is logged every run (five
such would block the ones behind them). A workspace whose project marking failed is retried by the recovery step, at
most 5 per run. Ten unfinished workspaces delay only the finish marker of later ones, not the removal of their content.

Content is deleted from 30 days after a workspace is deleted, not exactly then; database rows stay recoverable through
D1 Time Travel for its retention window, and in any export or backup you made (see workspaces.md for what is deleted
and what stays).

To undo a workspace deletion:
`UPDATE workspaces SET status = 'active', deleting_at = NULL WHERE id = '<workspace id>' AND status = 'deleting' AND purge_marked_at IS NULL;`
(use `'suspended'` if billing had suspended it). 1 row changed = undone; nothing of the workspace was marked. 0 rows:
the id is wrong, the workspace is not deleting, or it is already marked and cannot be undone; check with
`SELECT status, deleting_at, purge_marked_at FROM workspaces WHERE id = '<workspace id>';`. Never change `status` of
a workspace whose `purge_marked_at` is set. Before upgrading to the version with migration 0030, check
`SELECT id, name FROM workspaces WHERE status = 'deleting'`: those workspaces' 30 days start at the upgrade.
