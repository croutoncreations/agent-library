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

**Projects that contain App Connect files can't be backed up yet.** If any file in a project was created by a publishing app, the whole project's export is refused (`backup_unsupported`), even after you revoke the app or trash the file. Keep app data in its own project, and don't use App Connect for content you need to restore from these backups. (Exporting app files safely needs a new backup format that preserves which app owns each file; that's planned.)

## Backup and recovery

**Connections → Agent tokens → Backup** (owner only) downloads one project as a JSON file: its documents and files, every revision, comments and the binary data they reference, each with a hash. It never includes credentials, sessions or agent grants. Store backups privately and encrypted, outside your Cloudflare account, and try a restore with test data before you rely on them.

Limits:
- It's one project at a time, held in memory, so very large projects may exceed Worker limits. There's no whole-account backup yet.
- Folders and App Connect data aren't included (see above).
- Cloudflare D1's own point-in-time recovery restores the database but not R2 files, so it isn't a complete backup on its own.

Restoring has no UI yet. Send the backup JSON to `POST /api/restore` from a signed-in owner session (with the CSRF header); `test/a12-durability.test.mjs` shows a full round trip. Restore only into an **empty** library, such as a fresh installation. It refuses a library that already has content, checks every hash and creates no agent access. Reconnect your agents afterwards.

## Rollback

Note the current Worker version ID before each upgrade. To roll back the code, run `npx wrangler rollback <version-id>` with your config. (If you use the [deploy pipeline](deploy-pipeline.md), its next run will refuse because a hand-made version is live; follow its [Recovery](deploy-pipeline.md#recovery) table instead.) **Rollback only reverts the Worker.** D1 migrations, R2 files, KV state and secrets stay as they are. Migrations are additive, so the previous version keeps working on the newer schema. If it ever can't, stop and restore a backup into an empty installation instead of reversing SQL by hand.

## Monitoring

Watch Worker errors and your D1, R2 and KV usage in the Cloudflare dashboard, and check that the 15-minute cleanup job runs. Free tiers cover a typical personal library, but usage above them is billed to your account. Review connected agents now and then, and revoke the ones you no longer use. Never widen your Access policy to work around a sign-in problem.
