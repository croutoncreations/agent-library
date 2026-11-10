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
intent before `putText`; the revision batch clears it. No encryption codec is enabled yet, and the text limit remains
1 MiB. Restore preserves revision IDs but adds a random attempt segment to each text key
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
text prefix. Multi-put imports and snapshots remain sequential: an operation taking over ten minutes expires its
early intents and rolls back atomically rather than publishing partial data.

Comments remain inline through `storeText`/`readText`. Publisher generation commits also remain inline until a later
slice. `test/content-store.test.mjs` checks NULL revision inserts (with explicit generation exceptions), restricts R2
binding access to the seam, and exercises main body paths with a marker codec. `test/text-r2.test.mjs` covers R2 and
legacy reads, byte ranges, conflicts, orphan cleanup, search and backup round trips.

Some features also read the body **inside SQL**, which a JavaScript codec can't reach. These need their own change
when text encryption is built:

| Where | What reads the body in SQL |
|---|---|
| `migrations/0014_ranked_search.sql` triggers, `packages/core/src/search/service.js` | FTS5 index of title and body; temporary plaintext R2 bridge refreshed after version and metadata writes |
| `packages/core/src/service.js` (`listArtifacts`) | owner `LIKE` filter over the legacy head body (R2 versions match titles only until blind search) |
| `packages/core/src/api/publisher.js` | generation commit copies staged part bodies into revisions with `INSERT … SELECT` (marked `content-store: sql-side`) and refreshes the search index from them; `json_extract` over staged parts |
| `publisher_generation_parts.body` | staged App Connect parts are plaintext in D1 from upload until commit (then cleared) |

Plan when per-workspace encryption is built: add a nullable `key_version` to `revisions` and `comments` (NULL =
plaintext, read both), encrypt in the Worker before insert, and replace the SQL-side uses above. Search is the hard
part: options are a title-only index, a bounded decrypt-and-scan within one project, or an index of keyed HMAC
tokens. Old plaintext remains in D1 Time Travel and backups until they age out; any announcement should say so.
Deleting a workspace's data key then makes all of its content unreadable (crypto-shredding).
