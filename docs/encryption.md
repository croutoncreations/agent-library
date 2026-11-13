# Encryption at rest

Agent Library adds no encryption of its own to your content in this release. What protects stored content is the
storage provider.

## What protects content at rest

Everything Agent Library stores (documents and their versions, comments, files, and the search index) lives in your
installation's Cloudflare D1 database and private R2 bucket. Cloudflare encrypts D1 and R2 data at rest with keys that
Cloudflare manages ([D1](https://developers.cloudflare.com/d1/reference/data-security/),
[R2](https://developers.cloudflare.com/r2/reference/data-security/)). This is the storage provider's encryption, not
per-customer or end-to-end encryption: the Worker reads and writes plaintext to serve people and agents, and search is
ordinary full-text search over the stored words.

In the browser, unsaved drafts and offline copies are stored unencrypted in that browser's own storage.

## Who can read content

The installation's operator, meaning anyone who can read its D1 database or R2 bucket (for example through the
Cloudflare dashboard, Wrangler or an API token), can read the content stored there. New text and files are in R2; D1
holds titles, older inline text and the search index, which keeps up to the first 1 MiB of each current document's
text. So can anyone who holds a database export, a D1 Time Travel restore point or a project backup. Project backups
are plain JSON; store them privately and encrypted yourself ([operations.md](operations.md#backup-and-recovery)).

## Encryption settings are refused

A Worker refuses every request with `500 encryption_unsupported` while any of these is present:

- the var `CONTENT_MASTER_KEY_VERSION` (any value other than empty);
- any secret named `CONTENT_MASTER_KEY_V<n>` (n a number);
- the var `CONTENT_ENCRYPTION_REQUIRED` with any value other than empty or `0`.

The server log names the setting it found (`encryption_unsupported` with `setting`), never its value. Remove the
setting to recover. These settings belonged to a content-encryption design that is not part of this release; with
them set, some content would be encrypted and the rest would not, so the Worker refuses instead. The 15-minute cron
keeps running meanwhile ([operations.md](operations.md#monitoring)).

## Unused database schema

Migrations `0029` to `0032` (`0029_workspace_keys.sql`, `0030_content_fences.sql`, `0031_encrypted_blobs.sql`,
`0032_blind_search.sql`) add tables, columns, indexes and a view for that design. They are applied like every other
migration and are harmless: nothing in this release writes content to them. (`0032` seeds one bookkeeping row in
`search_tokens_state` and also adds a view and an index on `projects`; an installation that ran an earlier
development build may hold rows from it.) Don't remove them by hand.
