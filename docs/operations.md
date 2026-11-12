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

**Projects that contain App Connect files can't be backed up yet.** If any file in a project was created by a publishing app, the whole project's export is refused (`backup_unsupported`), even after you revoke the app or trash the file. Keep app data in its own project, and don't use App Connect for content you need to restore from these backups. (Exporting app files safely needs a new backup format that preserves which app owns each file; that's planned.)

## Backup and recovery

**Connections → Agent tokens → Backup** (owner only) downloads one project as a JSON file: its documents and files, every revision, comments and the binary data they reference, each with a hash. It never includes credentials, sessions or agent grants. Store backups privately and encrypted, outside your Cloudflare account, and try a restore with test data before you rely on them.

Limits:
- It's one project at a time, held in memory, so projects with more than 16 MB of files are refused (see above and [Limits](limits.md#import--export)). There's no whole-account backup yet.
- Folders and App Connect data aren't included (see above).
- Cloudflare D1's own point-in-time recovery restores the database but not R2 files, so it isn't a complete backup on its own.

Restoring has no UI yet. Send the backup JSON to `POST /api/restore` from a signed-in owner session (with the CSRF header); `test/a12-durability.test.mjs` shows a full round trip. Restore only into an **empty** library, such as a fresh installation. It refuses a library that already has content, checks every hash and creates no agent access. Reconnect your agents afterwards.

Restore stores a backup's values as given. A hand-edited backup can therefore put values the app never writes into your own installation (for example binary values in text fields, or document ids the UI cannot address); restore refuses only what could never be stored. Import, by contrast, checks every value against the app's own rules.

If a restore answers `store_not_empty` (409) after you started it on an empty store, it may have completed despite the error. Reload the app and check your projects before retrying.

With encryption configured, restore and import re-encrypt every file under the target workspace's key; restored file keys carry a per-attempt suffix. A failure whose outcome is unknown (for example a lost connection after the database committed) deletes nothing and logs `backup_cleanup_skipped`; such unreferenced objects are not reclaimed by this release (see [encryption.md](encryption.md#files)).

## Rollback

Note the current Worker version ID before each upgrade. To roll back the code, run `npx wrangler rollback <version-id>` with your config. (If you use the [deploy pipeline](deploy-pipeline.md), its next run will refuse because a hand-made version is live; follow its [Recovery](deploy-pipeline.md#recovery) table instead.) **Rollback only reverts the Worker.** D1 migrations, R2 files, KV state and secrets stay as they are. Migrations are additive, but schema compatibility does not guarantee data compatibility. A Worker from before this release cannot restore a history version larger than about 2 MB; the restore fails without changing data.

**Do not roll back past the text-in-R2 release (migration 0027) once it has taken text writes; fix forward.** A Worker from before 0027 reads those text versions as empty: saving one stores empty text as a new version, restoring one creates a broken version, record reads and backup export fail, and they drop out of search. If rollback is unavoidable, treat the library as read-only until the newer Worker is back.

## Monitoring

Log events and reasons added with file encryption (ids, counts and codes only; never keys, headers or content):

| Event | Meaning |
|---|---|
| `blob_corrupt` with `reason` | a file read refused stored bytes (`prefix`, `header_invalid`, `header_length_mismatch`, `key_id_mismatch`, `encrypted_row_plaintext_object`, `plaintext_row_encrypted_object`, `stored_size_mismatch`, `half_column_pair`, `header_pin`, `first_chunk`, `later_chunk`, …); the client gets `500 blob_corrupt` |
| `blob_corrupt` with `reason: "read_failed"` | the storage read itself failed while reading a file (not a verification failure); the client gets the same `500 blob_corrupt` |
| `upload_blob_inconsistent` | upload finish found the stored object's metadata, size or first chunk unlike what the PUT recorded; the upload ends `500 publish_failed` |
| `upload_blob_write_inconsistent` | an encrypted PUT's own consistency check failed after the put; the object is deleted and the upload returns to pending |
| `upload_finish_key_error` with `code` | finish found the upload's key id unknown to its workspace or its key row malformed; the upload ends `500 publish_failed` |
| `backup_cleanup_skipped` with `count`, `reason` | a backup import or restore left `count` written file objects in place: `outcome_unknown` (the batch may have committed), `reference_query_failed` or `delete_failed` |

Watch Worker errors and your D1, R2 and KV usage in the Cloudflare dashboard, and check that the 15-minute cleanup job runs. Each run also removes, at most 5,000 rows per table, expired sign-in sessions, idempotency records older than 30 days (a retried request older than that is treated as new) and audit rows older than `AUDIT_RETENTION_DAYS` (default 365; `0` keeps them forever). A `retention_cleanup_batch_full` warning means a table had more to remove; the next runs catch up. Free tiers cover a typical personal library, but usage above them is billed to your account. Review connected agents now and then, and revoke the ones you no longer use. Never widen your Access policy to work around a sign-in problem.
