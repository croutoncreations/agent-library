# Upload finalization and recovery

`build-upload-fixes.mjs` runs after `build-session-fixes.mjs` in `npm run build:design`.
It patches the production bundle from `src/upload-fixes/finish.js`; the older TypeScript
snapshot is not the deployed implementation. Commit `src/index.js` and
`upload-fixes-preservation.json` after rebuilding. `npm run check:bundle` verifies both.

Migration `0011_upload_finalize_lease.sql` must precede the new Worker. It adds:

- `finalize_token` and `finalize_until`: exclusive, expiring finalization ownership.
- `final_writes`: final-object writes registered before R2 PUT and released when PUT settles.

The first finalizer fixes one final R2 key per upload. Publication checks its ownership
inside the revision-insertion statement. Cleanup cannot fail an upload with a live
lease, and terminal final objects are purged only when no registered write remains.

## Interrupted writes

A terminated Worker or failed counter decrement can leave `final_writes > 0` on a
failed/conflicting upload. Its final object remains tracked and charged to project
quota rather than risking a late write escaping cleanup. There is deliberately no
automatic timeout that declares such a write complete.

Cleanup emits `upload_final_writes_retained` for failed, conflicting, or published
uploads with outstanding write accounting, with an aggregate count and
`oldest_expiry_age_ms` (age since the oldest affected upload expired, not proof that
its writer has stopped). A failed write-counter decrement emits
`upload_final_write_release_failed` without masking the original PUT error. Wire
these warning events into deployment log monitoring; neither event logs blob keys,
credentials, or artifact contents. A retained count is a recovery signal, not
permission to release accounting automatically. A failed decrement after a successful
PUT can leave accounting on a published upload too. Published bytes remain charged
through their revision (not double-charged through the counter), and cleanup never
deletes referenced bytes. Include published rows when diagnosing outstanding counters;
these may also represent a legitimately finishing older writer, not a stuck process.

Diagnose with a read-only query against uploads whose state is `failed` or `conflict`
and `final_writes > 0`. Do not blindly reset counters: a write may still be pending.
Recovery requires a planned maintenance window that prevents finalization,
establishes outstanding writers have ended, and confirms the final key is not referenced
by any revision before resetting accounting and allowing normal cleanup. Preserve a
database export and recovery record. Never delete a referenced key.

## Rollback

The migration is additive, so the old Worker accepts the schema, but it ignores leases
and write accounting and restores the original concurrency bugs. Drain in-flight
finishes before rollback; schema compatibility alone is not concurrency safety.
