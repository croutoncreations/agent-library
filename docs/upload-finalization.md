# Upload finalization and recovery

Upload finalization lives in `packages/core/src/uploads.js` (`uploadFinish`) with the cron reconciler in `packages/core/src/cleanup.js`.

Binary files reach 90 MiB (`FILE_BYTES_CEILING`) and a Worker has 128 MB, so no binary step holds a whole file in
memory. Binary bytes pass through the Worker once. Text uploads are limited to 10 MiB:

- `uploadBegin` fixes the upload's `final_key` (`blobs/{project}/{artifact}/rev_…`) in the reservation insert.
  `staging_key` is still filled in but nothing is ever written there.
- `uploadPut` refuses a `Content-Length` other than the declared size before writing (`413` longer, `400
  incomplete_body` shorter). It claims the upload (`pending → receiving`) and registers the write
  (`final_writes + 1`) in one statement, then pipes the body through `FixedLengthStream(expected_size)` into
  `R2.put(final_key, { sha256: expected_sha256 })`. R2 stores nothing if the length or the SHA-256 is wrong. On `400
  incomplete_body` or `413` the upload goes back to `pending` so the whole file can be PUT again. On `422
  integrity_mismatch` the same guarded update (`state = 'receiving'`) ends it `failed` with that result: finish replays
  the 422, a re-PUT gets `409`, and the identity's upload slot and the quota are freed at once (nothing was stored).
  Start again with a new `upload_begin`. `final_writes - 1` runs when the put settles. On success it records R2's `size` and `checksums.sha256`.
  Each PUT has a deadline: the body is aborted at the upload's `expires_at`, and the put is abandoned at `expires_at +
  PUT_MARGIN_MS` (60 s; `410 upload_expired`), so no put commits later than that.
- `uploadFinish` checks `head(final_key)` under its lease: size and recorded SHA-256 must match the declaration.
  No recorded checksum fails closed with `500 publish_failed`. Binary finish checks the type signature in the first
  16 bytes and publishes that object without moving or rewriting it. Text finish reads the temporary input once,
  decodes strict UTF-8, runs the ordinary document validator and publishes through the intent-fenced text writer.
  Its isolate-local finish slot expires with its lease, follows renewal and can only be released by its holder.

Why this is safe:

- PUT writes only from `pending`, and finish only from `sealed` (via `received`), so a write and a finish never
  overlap.
- A PUT that dies leaves `final_writes > 0`: the object stays tracked and charged, never orphaned, until the count
  is stale (see below).
- A retried PUT overwrites the same key, but only before any revision references it (still `pending`).
- Published is terminal, so no write can follow it.
- A project purge (`purgeDueProjects`, and the immediate run of "delete permanently") waits while any of the project's
  uploads holds a live finish lease, is `receiving`, or has a live (not stale) write count. A PUT whose row was ended
  or removed mid-transfer deletes the object it just stored (best effort; a fresh `rev_` key is never referenced
  before publish), and the purge's prefix sweep catches anything left.
- Failed or conflicting uploads retain the reference-guarded final-key cleanup: no live write and no revision
  referencing the key. Published binary objects are never final-key cleanup candidates. Published text inputs are
  purged immediately or by the indexed staging-cleanup lane once writes are idle or stale. Text `staging_purged_at`
  is set only after `final_purged_at`, so a failed temporary-input delete remains discoverable without revisiting
  every published binary upload.

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
`now > expires_at + max(UPLOAD_CLEANUP_GRACE_SECONDS, 10 min) + PUT_MARGIN_MS`. The handler stops
waiting at the margin, but R2 has no way to abort a put whose body has fully arrived, so the
minimum 10 minutes lets a slow commit land first. Cleanup also deletes each ended upload's
`final_key` a second time 1 to 3 hours after the first purge, which removes a put that committed
after it. Remaining assumption: R2 commits or fails a put within about an hour of receiving the
whole body, and before the upload row itself is removed with its orphan placeholder. On a terminal row,
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

## Rollback and deploy

- Uploads received by a pre-single-pass Worker must restart. Their bytes are at `staging_key` with no `final_key`;
  this Worker's finish ends them with `409 reupload_required`, and cleanup deletes `staging_key`.
- A pre-single-pass Worker reads `staging_key`, so it cannot finish this Worker's binary uploads at `final_key`.
  Such a rollback also restores the original concurrency bugs: those Workers ignore leases and write accounting.
- Before rolling back to a Worker from before text uploads, let text uploads finish or expire. The older Worker
  returns `500` when finishing one and does not clean up its text placeholder or temporary input. Its cron can mark
  `staging_purged_at` without removing that input; after rolling forward, cleanup no longer finds the object and it
  remains until the project is purged. See also [limits.md#uploads--transfers](limits.md#uploads--transfers).

Additive schema compatibility alone is not rollback safety.
