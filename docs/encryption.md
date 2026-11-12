# Encryption at rest

## Today

All content is encrypted at rest by the storage provider: Cloudflare encrypts D1 and R2 with AES-256. Accurate
wording for a hosted service: "encrypted at rest by our infrastructure provider". It is not per-customer or
end-to-end encryption: the Worker reads plaintext to serve people and agents.

## The seam for per-workspace encryption

Stored file bytes (R2 `BLOBS`) are read and written only through `packages/core/src/content-store.js` (`getBlob`,
`getBlobBytes`, `getBlobHead`, `putBlob`, `putBlobStream`, `headBlob`, `deleteBlob`). `test/content-store.test.mjs` fails if any other module
touches `env.BLOBS`. Per-workspace envelope encryption replaces those functions with ones that:

- look up the object's workspace data key through a `KeyProvider` (data keys wrapped by a versioned master key held
  as a Worker secret, later an external KMS);
- write objects as fixed-size AES-GCM chunks (for example 64 KiB) with a small header, so Range requests decrypt
  only the chunks they cover;
- keep upload integrity checks (size, SHA-256) on the plaintext.

Objects are immutable and keyed per version, so existing objects can be re-encrypted in the background by writing a
new key and updating the revision's `blob_key` in a revision-guarded statement.

## Workspace keys

**Nothing is encrypted yet.** The key layer below exists and is tested, but no read or write calls it, and content is
stored exactly as described under [Today](#today).

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

- **Shredding is recorded in the database.** It does not protect against someone who can write to the database: they
  can put back a key row they saved earlier. Nor does it reach database restore points, D1 Time Travel (about 30
  days) or exported backups, which still hold the wrapped key. Content is beyond recovery only once those have aged
  out, or once the master key version that wrapped its key has been retired and its secret deleted.
- **Each write is authenticated, not that it is the latest.** Someone who can write to object storage can put back an
  older complete write of the same storage key, and it decrypts.
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
- **A refused condition must abort the whole publication.** A D1 `batch` rolls back only when a statement fails, and
  a guarded statement that matches no rows does not fail: the rest of the batch would still commit. In a batch,
  write the condition as an assertion that fails its statement, the way the
  [text write deadline](#text-write-deadline-and-orphan-safety) deliberately violates a NOT NULL constraint. For a
  single publishing statement, check that it changed exactly the expected rows and treat anything else as an error.
  Nothing may be published in part, and the caller gets a retryable error.
- **A refusal must leave the staged object reclaimable.** The row that lets cleanup find the object (the text-write
  intent, the upload row) must survive the refusal, and an upload must end failed, so that the existing cleanup (the
  intent sweep, upload cleanup) removes the object.
- Worker versions from before these conditions existed do not honour them, so encryption may be configured only
  after a Worker that fences its writes is fully deployed. Set `CONTENT_ENCRYPTION_REQUIRED="1"` in the same deploy
  as the master-key settings: set earlier, it refuses every request until they arrive.
- Only the operator purge of a deleted workspace (a later slice) may call `shredWorkspaceKeys`. It is safe on an
  installation without encryption: its tombstone does not make `encryptionEnabled` refuse.
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

## Text versions and inline compatibility

New Markdown, HTML, JSON and CSV versions live in immutable R2 objects at `text/{project}/{artifact}/{revision}`.
D1 keeps `revisions.body = NULL` and `body_key` names the object. All JavaScript version reads use `getText` or
`getTextRange`, which fall back to legacy inline bodies. Ranges return raw bytes, including partial UTF-8 sequences;
chunked readers choose character boundaries only after fetching the bytes. Text writes record a `content_writes`
intent before `putText`; the publication batch clears it. No encryption codec is enabled yet. Raw text uploads publish through this same text writer; upload-owned temporary objects also remain behind content-store, and no upload handler bypasses the future codec. The text storage limit is
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

**Nothing is encrypted yet.** `packages/core/src/crypto/chunked.js` implements the format below, but no read or
write path calls it, and every stored object is still plaintext. Wiring it into `content-store.js` is a later slice.
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
  returned. The range path needs the 48 header bytes; where they come from (a copy in object metadata or a separate
  small read) is decided when this is wired in. Because the header is authenticated in every chunk's additional data,
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
