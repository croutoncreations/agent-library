# Encryption at rest

## Today

All content is encrypted at rest by the storage provider: Cloudflare encrypts D1 and R2 with AES-256. Accurate
wording for a hosted service: "encrypted at rest by our infrastructure provider". It is not per-customer or
end-to-end encryption: the Worker reads plaintext to serve people and agents.

## The seam for per-workspace encryption

Stored file bytes (R2 `BLOBS`) are read and written only through `src/content-store.js` (`getBlob`,
`getBlobBytes`, `putBlob`, `headBlob`, `deleteBlob`). `test/content-store.test.mjs` fails if any other module
touches `env.BLOBS`. Per-workspace envelope encryption replaces those functions with ones that:

- look up the object's workspace data key through a `KeyProvider` (data keys wrapped by a versioned master key held
  as a Worker secret, later an external KMS);
- write objects as fixed-size AES-GCM chunks (for example 64 KiB) with a small header, so Range requests decrypt
  only the chunks they cover;
- keep upload integrity checks (size, SHA-256) on the plaintext.

Objects are immutable and keyed per version, so existing objects can be re-encrypted in the background by writing a
new key and updating the revision's `blob_key` in a revision-guarded statement.

## Text stored inline in D1

Markdown, HTML, JSON and CSV bodies live in `revisions.body`; comments in `comments.body`. Every JavaScript write
binds `storeText(text)` and every JavaScript read of a selected body goes through `readText(stored)` (both in
`src/content-store.js`). `test/content-store.test.mjs` builds the Worker with a marker codec in place of those two
functions and runs real creates, saves, restores, comments and reads against the migrated schema, so a path that
skips the seam fails.

Some features also read the body **inside SQL**, which a JavaScript codec can't reach. These need their own change
when text encryption is built:

| Where | What reads the body in SQL |
|---|---|
| `migrations/0014_ranked_search.sql` triggers, `src/search/service.js` | FTS5 index of title and body |
| `src/reads/service.js` | byte-range `substr` of the body for chunked reads |
| `src/service.js` (`listArtifacts`) | owner `LIKE` filter over the head body |
| `src/api/publisher.js` | generation commit copies staged part bodies into revisions with `INSERT … SELECT`; `json_extract` over staged parts |

Plan when per-workspace encryption is built: add a nullable `key_version` to `revisions` and `comments` (NULL =
plaintext, read both), encrypt in the Worker before insert, and replace the SQL-side uses above. Search is the hard
part: options are a title-only index, a bounded decrypt-and-scan within one project, or an index of keyed HMAC
tokens. Old plaintext remains in D1 Time Travel and backups until they age out; any announcement should say so.
Deleting a workspace's data key then makes all of its content unreadable (crypto-shredding).
