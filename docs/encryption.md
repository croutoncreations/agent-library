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
Deleting a workspace's data key then makes all of its content unreadable (crypto-shredding).
