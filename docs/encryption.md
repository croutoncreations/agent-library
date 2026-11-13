# Encryption at rest

## Today

All content is encrypted at rest by the storage provider: Cloudflare encrypts D1 and R2 with AES-256. Accurate
wording for a hosted service: "encrypted at rest by our infrastructure provider". It is not per-customer or
end-to-end encryption: the Worker reads plaintext to serve people and agents.

**What this release encrypts: binary files only.** When master-key settings are configured
([Workspace keys](#workspace-keys)), new binary file versions (images, PDFs, videos and other uploaded files) are
stored encrypted under their workspace's key ([Files](#files)). **Text versions (Markdown, HTML, JSON, CSV), comments
and the raw input of text uploads are not encrypted until the next release (slice 3c)**: they are stored exactly as
described above. Do not describe an installation as having "encrypted content" until that release is deployed.

## The seam for per-workspace encryption

Stored bytes (R2 `BLOBS`) are read and written only through `packages/core/src/content-store.js`.
`test/content-store.test.mjs` fails if any other module touches `env.BLOBS`, imports `crypto/chunked.js`,
`workspaceDataKey` or `dataKeyById`, uses `customMetadata`, or imports one of its raw readers. Binary files go
through `writeUploadBlob` (upload PUT), `writeBlobBytes` (backup import and restore), `inspectUploadedBlob` (upload
finish), and `blobRef` with `readBlob` / `readBlobBytes` (downloads, `read_file`, backup export).

Objects are immutable and keyed per version, so existing objects can be re-encrypted in the background by writing a
new key and updating the revision's `blob_key` in a revision-guarded statement (not built yet).

## Workspace keys

Binary file versions use the key layer below ([Files](#files)); text versions and comments do not yet.

- **Master keys.** Worker secrets `CONTENT_MASTER_KEY_V<n>` (n a positive integer), each the base64 or base64url
  encoding of exactly 32 random bytes; the var `CONTENT_MASTER_KEY_VERSION` names the current n. Encryption is
  configured when that var is set (a string of digits or a number) and its secret decodes to 32 bytes. Unset or `""`
  means not configured; a malformed version or secret is an error (`master_key_version_invalid`,
  `master_key_invalid`, `master_key_missing`), never "off". Error messages name no secret, since they can reach a
  client; the server log names the secret, never its value.
- **Fail closed.** The var `CONTENT_ENCRYPTION_REQUIRED="1"` makes encryption required: while the master key settings
  are missing or malformed, `createWorker` refuses every HTTP request with a 500 `encryption_misconfigured` ("Content
  encryption is required but not configured") and logs the reason. Scheduled (cron) work is not behind this refusal:
  it relies on `encryptionEnabled` and `workspaceDataKey` refusing on their own. Unset, `""` or `"0"`, nothing
  changes; any other value (`"true"`, a TOML boolean, `" 1"`) is refused the same way (logged as
  `required_value_invalid`), never read as "off". `encryptionEnabled(env)` is the one decision for writing: true when
  configured; false only when not configured, not required and `workspace_keys` has no real key row
  (`master_version > 0`, shredded or not; a shred's tombstone does not count); otherwise the same 500, so losing the
  configuration after keys exist never turns into plaintext. **Every installation that turns encryption on must also
  set `CONTENT_ENCRYPTION_REQUIRED="1"`**, which lives in the Worker's configuration and not in the database; with it
  set, a missing configuration refuses requests whatever the database says ([Limits](#limits)).
  `workspaceDataKey` also refuses unless the configuration is present and well-formed, even for a workspace that
  already has a key.
- **Table** `workspace_keys` (migration `0029_workspace_keys.sql`): `workspace_id`, `key_id` (`wk_…`, primary key),
  `master_version`, `wrapped`, `created_at` and `shredded_at` (epoch milliseconds). A partial unique index allows one
  unshredded key per workspace; a plain index on `workspace_id` serves the other lookups by workspace.
- **Data keys.** 32 bytes from `crypto.getRandomValues`, wrapped with AES-256-GCM under the current master key with a
  fresh random 96-bit IV. The additional data binds the wrapped key to its row: `al-dek/1`, workspace id, key id and
  master version, each as a 4-byte big-endian length followed by its UTF-8 bytes. `wrapped` is base64url of
  IV ‖ ciphertext ‖ tag. A wrapped value copied to another workspace, key id or master version does not unwrap.
- **In memory** a data key is only a non-extractable HKDF `CryptoKey` (usages `["deriveKey"]`), unwrapped directly to
  HKDF. The raw bytes exist only while a key is created and are zeroed afterwards. When content encryption is wired
  in, each object's key will be derived from it ([Object format](#object-format-version-1)); the data key itself will
  never encrypt content.
- **First use** (`workspaceDataKey(env, workspaceId)` in `packages/core/src/crypto/keys.js`): an `INSERT` that does
  nothing when it loses to a concurrent first use (`ON CONFLICT … DO NOTHING` on the one-active-key index), then
  re-select the active row, so concurrent first use yields one key for every caller. Any other insert failure is
  `key_create_failed`. A workspace with any shredded key row gets no new key (`key_shredded`).
- **Decryption lookup** (`dataKeyById(env, workspaceId, keyId)`): refuses an unknown key id, a shredded key and a key
  of another workspace than the caller expects.
- **Shredding** (`shredWorkspaceKeys(env, workspaceId)`, not called by anything yet): marks every key row of the
  workspace shredded and overwrites its wrapped key with the empty string; a workspace that never had a key gets a
  shredded tombstone row, so it can never get one later. Idempotent. A shredded row (or one whose wrapped key is
  empty) never reaches the key provider. See [Limits](#limits).
- **Rotation.** New keys are wrapped under the current version; an older row unwraps as long as its
  `CONTENT_MASTER_KEY_V<n>` is still set. If it is not, the request fails with `master_key_missing` and the server
  log names the missing secret. Rewrapping old rows is
  not built yet.
- **One unwrap per request.** `createWorker` gives each request its own memo (`withDataKeyMemo`, like
  `withRequestMemo`); nothing is cached across requests. The memo holds unwrapped keys by everything the wrap
  authenticates (workspace id, key id, master version, wrapped value), so a row that changes during a request is
  unwrapped afresh. Which key is active, and whether it is shredded, is read from the database on every call.
- **Seam.** The `keyProvider` adapter (`packages/core/src/adapters.js`) wraps and unwraps a data key for
  `{ workspaceId, keyId, masterVersion }`; the default (`crypto/worker-secret-keys.js`) uses the Worker secrets above
  and a hosted installation may replace it with an external KMS. A supplied provider replaces the default whole and
  must define `configured`, `currentVersion`, `wrap` and `unwrap`. Core checks what it returns: `configured` a
  boolean, synchronously; `currentVersion` a positive integer; `wrap` a non-empty string; `unwrap` a
  non-extractable HKDF key whose only usage is `deriveKey`. Row storage, first use and the memo stay in core.
  Workspace ids are the usual ones (`projectWorkspaceId`, including legacy `wsp_` + owner).

### Limits

- **Sizes and hashes stay visible in the database.** The database keeps the plaintext SHA-256 and byte size of every version (and of every upload's declaration). Someone who can read the database can confirm whether a workspace holds a known file, or guess a low-entropy one; the format does not hide sizes either.
- **The database is trusted for which object a version reads.** File encryption protects against someone who can
  read or write object storage, including someone who can also read the database. Someone who can write the database
  can point a version at another historical object and header of the same key (it then reads as that other content),
  or, with object-write access as well, clear a version's encryption columns and plant a plaintext object. They can
  also undo database-only shredding (below).

- **Shredding is recorded in the database.** It does not protect against someone who can write to the database: they
  can put back a key row they saved earlier. Nor does it reach database restore points, D1 Time Travel (about 30
  days) or exported backups, which still hold the wrapped key. Content is beyond recovery only once those have aged
  out, or once the master key version that wrapped its key has been retired and its secret deleted.
- **Each write is authenticated, not that it is the latest.** This is a property of the format: a whole older
  object written under the same storage key with the same data key authenticates on its own, so the codec alone
  would decrypt it. For files the application closes this: the header recorded in the database at publication pins
  the one write a version reads, so an older or different write put back under the key is refused as `blob_corrupt`
  (unavailable, never different content). Someone who can write to the database as well can change that header.
- **`encryptionEnabled` trusts the database.** It decides "encryption was in use" from rows in the database, so
  someone who can write to the database (deleting key rows or setting their `master_version` to 0) could make an
  installation whose master-key settings are later removed fall back to plaintext. Therefore **every installation
  that turns encryption on must also set `CONTENT_ENCRYPTION_REQUIRED="1"`**, which lives in the Worker's
  configuration and not in the database; with it set, a missing configuration refuses requests whatever the database
  says.
- **Master key usage.** Data keys are wrapped with random 96-bit IVs, so one master key should wrap at most 2^32 data
  keys. Usage is about one per workspace. Rotation means adding `CONTENT_MASTER_KEY_V<n+1>` and raising
  `CONTENT_MASTER_KEY_VERSION`.

### Rules for code that uses this

For the slices that wire this into reads and writes:

- The workspace id comes from the server-side project, never from the stored object.
- Whether to **decrypt** is decided by the stored object (its metadata or header), never by the current
  configuration. Whether to **encrypt** is decided by `encryptionEnabled(env)`, never by `encryptionConfigured()`
  alone.
- **A write under a key.** A key shredded during a request may still be held by that request. The statement or
  `batch` that publishes the write must itself carry the condition
  `EXISTS (SELECT 1 FROM workspace_keys WHERE key_id = ? AND workspace_id = ? AND ${ACTIVE_KEY_SQL})`.
  `ACTIVE_KEY_SQL` is exported from `keys.js` (never a hand-written copy) and names columns of `workspace_keys`
  without a table prefix, so use it only inside such a subquery. A separate check before the publishing statement is
  not enough.
- Ask `encryptionEnabled` again immediately before each write decision; never carry its answer across awaits that
  could span a configuration or rollout change.
- **A plaintext write.** The statement or `batch` that publishes it must itself carry `NO_REAL_KEY_SQL` (exported
  from `keys.js`; the same test `encryptionEnabled` makes), for the same reason: encryption may start in the meantime.
  The condition holds until the first real key row exists, so a plaintext write decided before encryption was
  configured can still publish until some workspace gets its first key; it is stored and read as plaintext.
- **A refused condition must abort the whole publication.** A D1 `batch` rolls back only when a statement fails, and
  a guarded statement that matches no rows does not fail: the rest of the batch would still commit. So write the
  condition as an assertion that fails its statement, the way the
  [text write deadline](#text-write-deadline-and-orphan-safety) deliberately violates a NOT NULL constraint. This is
  required for every `batch` and for any statement that can publish more than one row: a statement that skips some
  rows has already committed the others by the time a row count is read. Only a single statement that publishes at
  most one row may instead check that it changed exactly that row and treat anything else as an error. Nothing may
  be published in part.
- **Write these conditions with the fences in `content-store.js`**, never by hand: `keyFence(env, { keyId,
  workspaceId })` for a write under a key and `plaintextFence(env)` for a plaintext write (both fail by violating a
  NOT NULL constraint on the always-empty `content_fences` table, migration `0030_content_fences.sql`, whose CHECK
  also refuses any non-NULL row). Never give a fence a conflict clause (`OR IGNORE`, `OR REPLACE`, `ON CONFLICT`):
  it would turn a refusal into a pass. Put the fence last in the batch, after every statement whose result the
  caller reads. A refusal answers `410 key_shredded` for a key fence and `409 encryption_started` for a plaintext
  fence. `runBatch` and `commitTextWrites` already return the refusal as that HTTP answer. If the same request already
  succeeded under the same idempotency key, `runBatch` returns that stored response in place of the refusal.
  `fenceRefusal(error)` is for code that runs a batch itself (it returns the answer, or `null` for any other error,
  and is safe to call on an answer it already returned).
- **A refusal must be told apart from other failures**, so that it is not reported as an expired text-write intent
  (`text_write_expired`) or a conflict. A refusal is recognised from the constraint the failed statement names
  (`fenceRefusal`), not by probing. A refused plaintext write is retryable (the retry re-evaluates encryption and
  cannot publish plaintext: it encrypts while the master-key settings are present, and is refused otherwise). This
  code never deletes a key row, never changes a row's master version and never clears a shred, so within the code
  both conditions only move one way. A database restore or a manual edit can undo that; it is the same limit as for
  shredding (see [Limits](#limits)). Any later code that removes workspace data must keep the rows of
  `workspace_keys`. A write refused because its key was shredded answers `410 key_shredded`. A refused upload ends
  failed, and a retry starts a new upload.
- An error that is not recognised as a refusal says nothing about the outcome: the batch may have failed, or it may
  have committed with its acknowledgement lost. Never retry it with a write that carries no fence; retry the same
  request with the same idempotency key, and delete nothing that the batch might have published.
- **A refusal must leave the staged object reclaimable.** The row that lets cleanup find the object (the text-write
  intent, the upload row) must survive the refusal, and an upload must end failed, so that the existing cleanup (the
  intent sweep, upload cleanup) removes the object. `commitTextWrites` removes the unreferenced staged text of a
  recognised refusal at once, as it does for an expired intent (a failed fence statement means the batch rolled back;
  the cleanup in any case removes only objects that no revision or comment refers to); if that cleanup fails, the
  intent stays for the sweep.
- Worker versions from before these conditions existed do not honour them, so encryption may be configured only
  after a Worker that fences its writes is fully deployed. Set `CONTENT_ENCRYPTION_REQUIRED="1"` in the same deploy
  as the master-key settings: set earlier, it refuses every request until they arrive.
- Nothing calls `shredWorkspaceKeys`. The deleted-workspace purge (`workspace-purge.js`) removes content without it. If
  something calls it later, it is safe on an installation without encryption: its tombstone does not make
  `encryptionEnabled` refuse.
- A project's content is under the key of the workspace it belonged to when it was written. Nothing moves projects
  between workspaces today; if that is ever added, the moved content must be re-encrypted.
- **Rollback.** A Worker from before decryption existed would serve stored ciphertext as if it were content. Once
  anything is written encrypted, the Worker must not be rolled back past the slice that reads it; that slice must
  say so in its deploy notes.
- A decrypt stream that errors is a failed read, even though earlier chunks were delivered: nothing may act on
  partial plaintext.
- Range reads authenticate only the chunks they touch.
- **Uploads.** Once bodies are encrypted, R2's own SHA-256 check sees ciphertext. The plaintext hash must be computed
  in front of the encryptor, and a mismatch must fail before the final chunk is released (the encryptor releases the
  final chunk only after the input ends, so no valid object is stored). The stored length passed to storage is
  `chunkedStoredLength(size)`.
- Before decrypting, check that the storage key lies under the prefix the request is authorized for (the project's
  and document's own prefix), so a database row pointed at another object in the same workspace is refused.
- The header used for a range read must be pinned to the write the database refers to (stored with the revision, or
  read with the same conditional ETag as the range), and its plaintext length must equal the size the database
  records.
- Content type is served from the database, never from object metadata.
- Range callbacks (`fetchStored`) should return storage's stream, not a buffer of the whole range.
- An encrypted object cannot be copied byte for byte to another storage key (backup import, moves): decrypt and
  re-encrypt.
- **HTTP.** Declare the plaintext length. On a decrypt error, abort the response so the client sees a failed body.
  Never send validators or cache headers that imply a complete object.

## Files

Binary file versions written while `encryptionEnabled(env)` is true are stored in the chunked format
([Object format](#object-format-version-1)) under their workspace's data key. Each version decides from its own
stored state whether it is encrypted, never from today's configuration, so a history can mix plaintext versions from
before encryption was configured with encrypted ones after.

- **Where "encrypted, under key K" is recorded.** Migration `0031_encrypted_blobs.sql` adds `revisions.blob_key_id`
  and `revisions.blob_header` (and the same pair on `uploads` as `enc_key_id`, `enc_header`); NULL means plaintext.
  The 48-byte header is stored in the database (base64url). The object carries R2 metadata `al-enc: "1"` and
  `al-key: <key id>` and the content type `application/octet-stream`; the content type a client sees always comes
  from the database. Both places must agree: one set without the other is refused as `500 blob_corrupt`.
- **Storage keys.** A file's storage key is `blobs/<project>/<document>/<name>`, with the project and document
  parts URI-encoded (a lone surrogate first becomes U+FFFD, as the database stores it), and every read checks that
  encoded prefix. Ids the app creates are unchanged by encoding; only a document id kept by restore can differ. No
  encrypted object was written before this rule (no environment had a key), so no key needs migrating. An upload
  begun before the upgrade on a restored document whose id needs encoding fails at finish
  (`500 publish_failed`) and must be started again.
- **The header lives in the database.** Every write of the same storage key has a fresh salt, and every chunk
  authenticates the full header, so the database header pins a read to the exact write that was published. A later
  write of the same key does not decrypt under it.
- **Uploads.** The PUT streams the body once: it counts and hashes the plaintext (`crypto.DigestStream`) in front of
  the encryptor, and a wrong length or SHA-256 fails before the final chunk is released, so no complete object is
  stored. R2 receives exactly the stored length and no checksum (R2 would see ciphertext). Finish makes one `head` and
  one ranged read of chunk 0 and **authenticates only the first chunk**; later chunks are verified when they are read.
  Publication carries a fence last in its batch: the key must still be active (else `410 key_shredded`), or, for a
  plaintext upload, no real key may exist yet (else `409 encryption_started`). A refused upload ends `failed` and its
  object is reclaimed; a new upload is the retry.
- **Reads.** Each read makes one R2 request. Before decrypting, the read checks that the storage key lies under the
  version's own project and document, that the header's plaintext length equals the version's size, and then looks up
  the key (`410 key_shredded` once it is shredded). It then checks the object's metadata and stored size, and
  authenticates the first chunk before any header or byte is sent (`500 blob_corrupt` otherwise). A chunk that fails
  later errors the response body, so the client sees a failed or short transfer, never a complete one. This was
  verified with the local runtime only; it must be confirmed on a deployed Worker before a production key is
  configured (see the checklist below). Range reads
  fetch and authenticate only the chunks they cover. `read_file` (inline images) and backup export authenticate the
  whole object before returning anything.
- **Restoring a plaintext version.** Restoring an older file version that was stored before encryption was turned on publishes a new revision that refers to the existing plaintext object; no plaintext is written. It therefore carries no plaintext condition. The restored version stays plaintext (and is not covered by shredding) until it is re-encrypted, which is not built yet.
  Restoring an encrypted version reuses its object and header and is fenced on its key (`410 key_shredded` once the
  key is shredded).
- **ETag.** The `ETag` of a file stays the plaintext SHA-256, even on an encrypted body that can fail part-way: it
  names the version's content, the server answers no conditional requests, responses are `private, no-store`, and
  `Content-Length` exposes a truncated transfer.
- **Backup.** Export decrypts and writes plaintext blobs; it never includes `blob_key_id` or `blob_header`, so the
  backup format is unchanged. Import re-encrypts every file under the target workspace's key (the workspace the
  import was authorized for, never anything named in the file) at the new project's keys. Restore re-encrypts under
  the restoring owner's personal workspace key, and every restored file key carries a per-attempt suffix
  (`_restore_<16 characters>`), so a retried restore never overwrites an earlier attempt's objects. Both publish with
  the fences last. Before the batch is sent, a failure deletes the file objects this attempt wrote (best effort: a
  failed delete is logged as `backup_cleanup_skipped`), and leaves text already staged for the attempt, with its
  write intents, to the content-writes sweep ([below](#text-write-deadline-and-orphan-safety)). If the batch itself
  was refused (a fence, the text deadline, a constraint), only objects no version refers to are deleted. Any other
  failure may have committed with its acknowledgement lost: nothing is deleted and the server logs
  `backup_cleanup_skipped` (a count and a reason). **Such unreferenced objects are not reclaimed by this release.**
- **Not encrypted in this release:** text versions, comments and the raw input of text uploads (next release, 3c);
  the plaintext SHA-256 and size in the database (see [Limits](#limits)).
- **Not measured yet:** CPU time, wall time and memory for large encrypted uploads and downloads on a deployed Worker.
  Local Node measurements (about 80 ms to encrypt and 70 ms to decrypt 90 MiB) say nothing about the Workers runtime.

### Rollout and rollback

- **Rule.** An environment may configure master-key settings only once the release that encrypts, reads and fences every content kind (files, text versions, comments, text-upload input; slice 3c) is fully deployed there, with `CONTENT_ENCRYPTION_REQUIRED="1"` in the same deploy. From that moment the environment must never run an older Worker, whether or not any key row exists yet, and must not restore its database to a point before encrypted content was written. Until then encryption is exercised only with synthetic keys in tests.
- **(a) Minimum reader.** This release is the first that can read encrypted file objects. An older Worker serves an
  encrypted object's ciphertext as if it were the file.
- **(b) No older Worker once keys are configured.** An older Worker with master-key settings configured would write
  text (and, before this release, files) as plaintext without ever creating a key row. Before configuration, any
  rollback is safe: nothing is encrypted and every migration is additive. A staging environment that needs an older
  Worker after a key was configured removes the key settings and wipes its D1 and R2; it does not roll back with keys
  in place.
- **(c) A database restore is a rollback too.** Restoring D1 (Time Travel or an export) to a point before the
  environment's first key row loses the wrapped keys: every object encrypted since then becomes unreadable unless the
  corresponding wrapped keys are recovered. Restoring to a point after the key existed but before a version's
  encryption columns were written leaves a plaintext-shaped row next to an encrypted object, which fails closed as
  `blob_corrupt`. Do not use restore points from before encryption was configured once encrypted content exists,
  except to recover unencrypted data deliberately.
- **Before configuring a key in production.** An operator checklist; every item must hold:
  1. The release that encrypts every content kind (files, text versions, comments, text-upload input) is fully
     deployed to the environment.
  2. `CONTENT_ENCRYPTION_REQUIRED="1"` is set in the same deploy that adds the master-key settings.
  3. CI passed for the exact commit that is deployed.
  4. On a staging environment with a key and synthetic data only:
     - a corrupted first, middle and final chunk each answer a failed or short transfer, never a complete one, on
       full downloads and on Range reads;
     - CPU time, wall time and memory are measured for the largest file the environment allows: upload, finish, a
       full download and a Range read near its end;
     - real object storage is checked for overwrite ordering when an earlier upload's put arrives late.
  5. The decision on late writes (below) is made.
  6. The operator knows the two floors: never run an older Worker, and never restore the database to a point before
     encrypted content was written.
  7. Staging first: a key is configured on staging, and the checks above pass there, before production. Production is
     configured only on the owner's explicit go-ahead.
  8. The cost of the plaintext-write condition (the "no real key exists" query over `workspace_keys`, served by the
     `workspace_keys_real` index) is measured on staging, where every plaintext write and publication runs it.
- **Late writes.** An R2 put the Worker stopped waiting for can still commit later. Before publication, finish
  catches it (chunk 0 does not authenticate under the recorded header: `500 publish_failed`, upload failed). After
  publication it would make that version read as `blob_corrupt` (unavailable, never wrong content). Closing this is a
  precondition for production keys.

## Text versions and inline compatibility

New Markdown, HTML, JSON and CSV versions live in immutable R2 objects at `text/{project}/{artifact}/{revision}`.
D1 keeps `revisions.body = NULL` and `body_key` names the object. All JavaScript version reads use `getText` or
`getTextRange`, which fall back to legacy inline bodies. Ranges return raw bytes, including partial UTF-8 sequences;
chunked readers choose character boundaries only after fetching the bytes. Text writes record a `content_writes`
intent before `putText`; the publication batch clears it. Text is not encrypted in this release (slice 3c). Raw text uploads publish through this same text writer; upload-owned temporary objects also remain behind content-store, and no upload handler bypasses the future codec. The text storage limit is
10 MiB; app and `/v1` create/save requests have an 11 MiB JSON envelope cap, while MCP caps remain unchanged. Restore preserves revision IDs but adds a random attempt segment to each text key
(`text/{project}/{artifact}/{revision}/{attempt}`), so retries never overwrite another attempt's objects or
collide with its intents. Failed attempts remain unreferenced and are reclaimed by the normal sweep.

### Text write deadline and orphan safety

Every text publication batch begins with a shared SQL assertion: every intent key must still exist and be no older
than ten minutes, measured immediately before the batch. A missing or expired intent deliberately violates the
`content_writes` NOT NULL constraint, rolling back the entire batch (including metadata), and becomes a retryable
`503 text_write_expired`. The cron sweeps intents older than one hour, deleting unreferenced R2 objects before their
rows. The fifty-minute gap prevents a reclaimed intent from publishing, even if an R2 put outlives its request.
Referenced keys are never deleted. Best-effort conflict cleanup retains the intent if deleting the object fails;
unknown batch errors retain bytes because the transaction may have committed despite a lost acknowledgement.

One leak remains: if a put lands after the sweep deleted its intent, and the Worker dies before best-effort cleanup,
the late unreferenced object has no intent left for another sweep. It can never publish; project purge sweeps the
text prefix. Imports, restores and snapshot commits insert intents in chunks of 100 immediately before each
chunk's puts, with at most six object operations in flight. Exports use the same bounded read concurrency.
An operation taking over ten minutes can still expire its early intents and rolls back atomically rather than
publishing partial data. Settled-batch cleanup queries all unreferenced keys together, deletes objects in R2
batches of at most 1,000, then removes their intents in one statement; failed deletes leave intents for cron.

New comments use the same staged R2 writes and fence at `text/{project}/{artifact}/{comment}`; D1 keeps
`comments.body = ''` and `body_key` names the object. Lists and exports use `getText` with legacy inline fallback
and at most six reads in flight. Restore adds the same per-attempt segment as versions, and imports use fresh IDs.
Both reference checks and project purge include comment keys. The comment limit remains 10,000 characters.

Publisher generation commits remain inline until a later slice. `test/content-store.test.mjs` checks NULL revision
and empty comment inserts (with explicit generation exceptions), disallows body matching in SQL, restricts R2
binding access to the seam, and exercises main body paths with a marker codec. `test/text-r2.test.mjs` covers R2 and
legacy reads, byte ranges, conflicts, orphan cleanup, search and backup round trips.

Some features also read the body **inside SQL**, which a JavaScript codec can't reach. These need their own change
when text encryption is built:

| Where | What reads the body in SQL |
|---|---|
| `migrations/0014_ranked_search.sql` triggers, `packages/core/src/search/service.js` | FTS5 index of title and body; temporary plaintext R2 bridge refreshed after version and metadata writes |
| `packages/core/src/api/publisher.js` | generation commit copies staged part bodies into revisions with `INSERT … SELECT` (marked `content-store: sql-side`) and refreshes the search index from them; `json_extract` over staged parts |
| `publisher_generation_parts.body` | staged App Connect parts are plaintext in D1 from upload until commit (then cleared) |

The owner document-list filter matches titles only, for both legacy and R2-backed rows; body matching returns
through the blind index in slice 4b. Ranked search still uses the temporary FTS bridge above.

Plan when per-workspace encryption is built: add a nullable `key_version` to `revisions` and `comments` (NULL =
plaintext, read both), encrypt in the Worker before insert, and replace the SQL-side uses above. Search is the hard
part: options are a title-only index, a bounded decrypt-and-scan within one project, or an index of keyed HMAC
tokens. Old plaintext remains in D1 Time Travel and backups until they age out; any announcement should say so.
Shredding a workspace's data key then makes its content unreadable (crypto-shredding), within the
[limits](#limits) above.

## Object format (version 1)

`packages/core/src/crypto/chunked.js` implements the format below; binary file objects use it ([Files](#files)).
The module uses WebCrypto only and never touches R2.

A stored object is a 48-byte header followed by chunks:

| Bytes | Field |
|---|---|
| 0–3 | magic `ALE1` |
| 4 | format version `1` |
| 5 | chunk-size exponent `16` (65,536-byte chunks) |
| 6–7 | reserved, zero |
| 8–15 | plaintext length, unsigned 64-bit big-endian, at most 2^40 |
| 16–47 | salt: 32 random bytes, fresh for every write |

- **Per-write key.** `HKDF-SHA-256(workspace data key, salt = header salt, info = "al-obj/1" ‖ 0x00 ‖ UTF-8 of the
  storage object key)` gives a non-extractable AES-256-GCM key. The data key (a non-extractable WebCrypto HKDF key
  from the key provider) never encrypts content directly.
- **Chunks.** The plaintext is cut into 65,536-byte chunks; the last may be shorter, and an empty plaintext is one
  empty final chunk. Chunk *i* is AES-GCM with nonce = 4 zero bytes ‖ *i* (u64 big-endian) and additional data =
  the 48 header bytes ‖ *i* (u64 big-endian) ‖ `1` for the final chunk, `0` otherwise. Each stored chunk is its
  ciphertext followed by the 16-byte tag.
- **Stored length** = `48 + len + 16 × max(1, ceil(len / 65536))`. Lengths above 2^40 and chunk indexes of 2^32 or
  more are refused.

What each binding prevents:

| Binding | Prevents |
|---|---|
| Fresh salt per write in the HKDF salt | (key, nonce) reuse when the same storage key is written twice, for example a retried upload: each write gets its own key, so the chunk-index nonce is unique per key. Two salts collide with probability about 2^-256 per pair (in practice negligible). |
| Storage object key in the HKDF info | Moving or copying a stored object to another key: it no longer decrypts. |
| Workspace data key as the HKDF input | Reading one workspace's objects with another's key; shredding the data key makes every object unreadable. |
| Header in every chunk's additional data | Changing the length, salt, version or exponent; splicing chunks from another write (even of the same plaintext under the same storage key). |
| Chunk index in the nonce and additional data | Missing, repeated or reordered chunks. |
| Final-chunk flag | Truncation at a chunk boundary: a non-final chunk cannot end the object. Trailing bytes after the final chunk are refused too. |

Reads:

- **Whole object** (`decryptChunkedStream`): releases plaintext one authenticated chunk at a time. On any failure the
  stream errors and the failing chunk's bytes are never released, but **earlier chunks have already been released**.
  A caller that must not act on partial content (for example parsing a whole document) has to buffer until the stream
  ends, or treat an errored stream as a failed read.
- **Ranges** (`planChunkedRange`, `decryptChunkedRange`): a plaintext range maps to the stored bytes of exactly the
  chunks it touches, fetched with one call, and every touched chunk is authenticated before any of its bytes are
  returned. The range path needs the 48 header bytes; files take them from the revision row in the database
  ([Files](#files)). Because the header is authenticated in every chunk's additional data,
  a tampered copy makes decryption fail. A range read only proves the chunks it touched; it does not prove that the
  rest of the object is intact.

Limits:

- Authenticity is per data key: anyone holding the workspace data key can produce valid objects for that workspace.
- The format hides content, not size: the stored length reveals the plaintext length exactly.
- Encryption is pull-driven and holds about two chunks (one input chunk plus its ciphertext); it errors if the input
  is shorter or longer than declared, withholding the final chunk, so a mis-sized upload is never a valid object.
- Version 1 fixes the chunk size; a different size needs a new exponent or version, which this parser refuses.
- The test-only fixed-salt function exists only for the known-answer test and is not exported.
- The storage object key must be well-formed Unicode (no lone surrogates, which would encode to the same bytes as
  U+FFFD) and at most 1,015 UTF-8 bytes, so the HKDF info stays within 1,024 bytes.
- The data key must be a non-extractable HKDF key whose only usage is `deriveKey`.

Two decisions, both of which would change the stored bytes, so they must be revisited before real content is first
written, not after:

- **The header carries no key id.** The key id travels in the object's metadata; a wrong one only makes
  authentication fail.
- **The workspace id is not in the HKDF info.** The data key is already per workspace, so it would add nothing: a
  wrong workspace's key fails either way.
