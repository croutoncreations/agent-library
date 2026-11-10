# Upload finalization and recovery

Upload finalization lives in `packages/core/src/uploads.js` (`uploadFinish`) with the cron reconciler in `packages/core/src/cleanup.js`.

Files reach 90 MiB (`FILE_BYTES_CEILING`) and a Worker has 128 MB, so no step holds a whole file in memory, and a
file passes through the Worker once:

- `uploadBegin` fixes the upload's `final_key` (`blobs/{project}/{artifact}/rev_…`) in the reservation insert.
  `staging_key` is still filled in but nothing is ever written there.
- `uploadPut` refuses a `Content-Length` other than the declared size before writing (`413` longer, `400
  incomplete_body` shorter). It claims the upload (`pending → receiving`) and registers the write
  (`final_writes + 1`) in one statement, then pipes the body through `FixedLengthStream(expected_size)` into
  `R2.put(final_key, { sha256: expected_sha256 })`. R2 stores nothing if the length or the SHA-256 is wrong: `422
  integrity_mismatch`, `400 incomplete_body` or `413`, and the upload goes back to `pending` so the whole file can be
  PUT again. `final_writes - 1` runs when the put settles. On success it records R2's `size` and `checksums.sha256`.
  Each PUT has a deadline: the body is aborted at the upload's `expires_at`, and the put is abandoned at `expires_at +
  PUT_MARGIN_MS` (60 s; `410 upload_expired`), so no put commits later than that.
- `uploadFinish` writes nothing. Under its lease it checks `head(final_key)` (size equals the declaration and the
  recorded SHA-256 equals the declared one; no recorded checksum fails closed with `500 publish_failed`) and the type
  signature on the first 16 bytes, then publishes that object with the fenced revision insert.

Why this is safe:

- PUT writes only from `pending`, and finish only from `sealed` (via `received`), so a write and a finish never
  overlap.
- A PUT that dies leaves `final_writes > 0`: the object stays tracked and charged, never orphaned, until the count
  is stale (see below).
- A retried PUT overwrites the same key, but only before any revision references it (still `pending`).
- Published is terminal, so no write can follow it.
- A failed, conflicting or expired upload's `final_key` is purged by the existing cleanup rule (terminal,
  `final_writes = 0`, unreferenced by any revision); finish also removes it at once when that holds.
- Rollback: the previous Worker's cleanup deletes `staging_key` for published uploads. Live bytes are never at
  `staging_key`, so that deletes nothing referenced.

Migration `0011_upload_finalize_lease.sql` must precede the new Worker. It adds:

- `finalize_token` and `finalize_until`: exclusive, expiring finalization ownership.
- `final_writes`: final-object writes (the upload PUT's) registered before the R2 put and released when it settles.

The final R2 key is fixed at upload begin (an upload begun by an older Worker gets it at its PUT or first lease).
Publication checks its ownership
inside the revision-insertion statement. Cleanup cannot fail an upload with a live
lease, and terminal final objects are purged only when no registered write remains.

## Interrupted writes

A terminated Worker (whose `finally` never runs) or a failed counter decrement can leave
`final_writes > 0` on a failed/conflicting upload. Its final object remains tracked and
charged to project quota while a late write could still land.

Because every PUT ends by `expires_at + PUT_MARGIN_MS` (above), a count is **stale** once
`now > expires_at + UPLOAD_CLEANUP_GRACE_SECONDS + PUT_MARGIN_MS`. On a terminal row,
cleanup (`reconcileUploads`), orphan-placeholder deletion and the project purge's waits
(`purgeDueProjects`) treat a stale count as `final_writes = 0`: cleanup deletes `final_key`
(absent is harmless) and sets `final_writes = 0, final_purged_at = now`, which releases the
quota. Live (not stale) counts behave as before.

Cleanup emits `upload_final_writes_retained` for failed or conflicting uploads with live
(not stale) write accounting, and for published ones, with an aggregate count and
`oldest_expiry_age_ms` (age since the oldest affected upload expired, not proof that
its writer has stopped). A failed write-counter decrement emits
`upload_final_write_release_failed` without masking the original PUT error. Wire
these warning events into deployment log monitoring; neither event logs blob keys,
credentials, or artifact contents. A retained count is a recovery signal, not
permission to release accounting automatically. A failed decrement after a successful
PUT can leave accounting on a published upload too. Published bytes remain charged
through their revision (not double-charged through the counter), and cleanup never
deletes referenced bytes (a stale count on a published row is left alone).

Diagnose with a read-only query against uploads whose state is `failed` or `conflict`
and `final_writes > 0`. Don't reset counters by hand: cleanup releases them once stale.

## Rollback

The migration is additive, so the old Worker accepts the schema, but it ignores leases
and write accounting and restores the original concurrency bugs. Drain in-flight
finishes before rollback; schema compatibility alone is not concurrency safety.
