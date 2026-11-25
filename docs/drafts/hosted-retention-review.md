# Hosted Agent Library Backup and Retention Review

Reviewed November 16, 2026. Internal review; not part of the public privacy policy.

Sixty days is a reasonable operational target for deleting content from active systems, but extending the policy alone does not establish compliance. The implementation has a 30-day recovery period followed by bounded cleanup, without a completion deadline. Account and workspace metadata need a separate deletion process. Backups have a separate clock.

## Evidence and limits

The hosted production release manifest identifies core commit `5e7ea30979cd094c21b50a9776cf4b828cd86928` and hosted commit `0498da1c8c1330e1a6eb0b82be741041022e4360`. This review used that core's deletion, storage, export, and cleanup code, plus hosted production configuration and deployment workflows. The separate self-host deployment repository was checked for scheduled backup jobs as well.

Read-only production D1 information and R2 lifecycle-list requests both failed with Cloudflare authentication error 10000: the available local login does not include the hosted account. No credentials were extracted, no data was exported, and no cloud settings were changed. Live plan, lifecycle rules, bucket locks, manually created exports, external backup jobs, and actual purge completion remain unverified.

## What exists today

| Information or mechanism | Behavior in the reviewed setup | Implication |
| --- | --- | --- |
| Documents, files, and historical versions | New content is stored in private object storage; database rows hold metadata, indexes, and some older inline content. Revision history retains earlier content. | File storage and database recovery must be considered together. Trashing an item does not erase it or its versions. |
| Deleted project | Access closes immediately. Permanent deletion becomes due after 30 days. An administrator can request permanent deletion sooner. | The normal recovery window consumes half of a 60-day active-system target. |
| Deleted shared workspace | Access closes immediately. After 30 days the workspace cleanup marks its projects due for deletion. | It does not impose another 30-day project wait: those projects become due immediately. |
| Purge queue | Production configuration schedules cleanup every 15 minutes. The default project purge selects up to five projects per run, with shared budgets of 5,000 rows and 500 object deletions, plus bounded workspace marking. | These are workload limits, not a maximum completion time. Backlog, failures, or blocked uploads can delay completion. Workspace marking and project purge run independently, so newly marked projects may wait for another run. |
| Account and workspace metadata | Workspace purge leaves the workspace record, memberships, invitations, billing records, audits, app registrations, and credential records. No complete account-erasure workflow was found in the reviewed core. | Content purge is not account deletion. A deletion request needs an operator procedure and a justified retention schedule for each surviving category. |
| Audit history | Default retention is 365 days. The reviewed production config does not override `AUDIT_RETENTION_DAYS`. Cleanup removes up to 5,000 old audit rows per run. | The public draft now discloses general one-year audit retention. Live overrides still need verification. Security retention is not permission to retain all account information indefinitely. |
| Retry records and changes feed | Both normally expire after 30 days, with bounded cleanup. Retry records can contain mutation results and import titles. | Include them in erasure and restoration review; they are not necessarily content-free. |
| Sessions and authorization state | Expired sessions are pruned. Connections, API credentials, upstream sign-in identities, and OAuth state have separate lifecycles. | Revoke access and remove or de-identify unnecessary identity records across the app and sign-in provider. Revocation alone is not erasure. |
| Abandoned uploads | Scheduled reconciliation cleans expired and failed uploads, staging objects, and abandoned placeholders. | This is upload housekeeping, not a backup system or account-erasure process. |
| User project export | A manually requested JSON export includes content, history, comments, and embedded file bytes. Export and import have size limits. | This is a downloadable user backup, not a scheduled operator backup. Copies already downloaded are outside our deletion controls. |
| Deployment restore point | Hosted deploy workflows request a database recovery bookmark before migrations. | A bookmark identifies a point in the existing database recovery history. It does not create a separate file-storage backup or preserve that point forever. |

Core evidence: `packages/core/src/project-deletion.js` (`RETENTION_DAYS`, `purgeProjectNow`, `purgeDueProjects`, `STEPS`), `workspace-purge.js`, `cleanup.js` (`pruneExpiredRows`), `index.js` (`scheduled`), `content-store.js`, `backup.js`, `oauth/server.js`, and `docs/operations.md`, `docs/workspaces.md`, `docs/limits.md`. Hosted evidence: `deploy/production.toml`, `.github/workflows/deploy-production.yml`, `deploy-staging.yml`, and reset workflows. The self-host deploy workflow's 90-day artifact retention applies to deployment receipts, not a library-content backup.

## Recovery copies and file storage

D1 Time Travel is automatic database recovery. Cloudflare documents a rolling 30-day window on Workers Paid and seven days on Workers Free. It restores the database, not the separately stored file objects. A saved bookmark does not extend that window. The hosted reset workflow assumes a 30-day restore window, but live entitlement was not verified. [Cloudflare D1 recovery documentation](https://developers.cloudflare.com/d1/reference/time-travel/).

File versions are separate objects managed by Agent Library. Removing their database references is insufficient; the project purge deletes referenced content and sweeps project storage prefixes. Storage durability does not establish an independently restorable backup. No scheduled database export, second-bucket copy, or combined database-and-files backup was found in the reviewed repositories.

R2 supports configurable object expiry and bucket locks; actual rules were not readable with the available login. Its default seven-day expiry for unfinished multipart uploads is not an expiry for completed content or backups. Do not apply an age-based expiry to the live content bucket as a substitute for deletion: old objects can still be current files or needed history. [Cloudflare object lifecycle documentation](https://developers.cloudflare.com/r2/buckets/object-lifecycles/).

Manual database exports and project backups can outlive automatic recovery history. The reviewed code does not establish a retention limit for operator-created exports. Any such copies require an inventory, access restrictions, and a defined expiry before describing their retention as bounded.

## Does 60 days fit

For active-system content, the normal path is approximately **30 days of recovery time plus cleanup queue time**. Sixty days leaves a substantial cleanup margin under normal load, but the system does not enforce or measure that deadline. A verified request should be tracked from receipt and checked for completion, with escalation well before day 60.

For database recovery copies, the clock starts after the last active copy is removed. For example, content purged on day 31 may remain recoverable in database history until about day 61. A purge completed on day 60 may leave database recovery copies until about day 90. These are illustrative upper-window calculations under the documented Paid plan, not measurements of this installation. Exported backups may last longer unless separately expired.

The drafts therefore commit to active-system deletion within 60 days, preserve a separate backup exception, and expressly honor shorter legal deadlines. They do not promise erasure of every copy everywhere within 60 days. Legal obligations to respond to requests, or delete sooner, still take precedence over the stated service target.

## Work needed before making the promise live

1. Define a verified-request workflow covering personal workspaces, shared content, identity-provider records, authorization state, surviving metadata, and processor requests. Record a due date and completion evidence without retaining the deleted content itself.
2. Monitor the oldest pending deletion and purge failures; escalate requests before the deadline. Verify that the worker's scheduled cleanup is running in production. A queue that usually finishes quickly is insufficient evidence of a guaranteed deadline.
3. Inventory operator backups, lifecycle rules, locks, logs, and any external jobs through an account-authorized read-only review. Document what is backed up, how long it remains, and what can actually be restored.
4. Maintain a restricted deletion ledger outside the database being restored. Reapply deletions and access revocations before reopening a restored service. No automatic mechanism for this was found in the reviewed code.
5. Test deletion and restoration with synthetic fixtures, including a large project, shared-workspace membership removal, app files, history, and an interrupted purge. Do not test erasure on real customer content for this drafting task.

No operational change or deletion test is included in this documentation PR. The findings are publication prerequisites, not claims that the gaps have already been fixed.
