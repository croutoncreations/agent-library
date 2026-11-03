# One-time Google Drive import

Owner UI: open a regular project → **Import → Google Drive**. Authorize the intended Google account, select up to 25 files in Google Picker, review each measured representation and the destination, remove unwanted files, then confirm. Existing blank-document and upload flows are unchanged. Choose an existing supported folder when folders are enabled; create projects/folders through their existing owner flows first.

Copies use library permissions independently of Drive. The review lists currently active OAuth connections, legacy grants and API keys for the project. Imported Markdown is editable and has normal immutable history. Drive links remain links; their targets and images are not fetched. Google Docs Markdown conversion can change tables, images, footnotes and links: inspect the bounded source preview before confirming. Current content only is imported, without comments, permissions, suggestions or revision history.

Google Sheets and Slides become `.xlsx` and `.pptx` snapshots. Uploaded Office files retain their bytes. These are download-only `application/octet-stream` artifacts with their filename extension, size, import date and source provenance; agents retrieve them using the ordinary authenticated binary routes. Client support for parsing these files varies. No Office editor, archive extraction or external preview service is added. Optional PDF companions are **omitted** from this release: download the primary file or open the source.

## Installation configuration

No OAuth client secret or new cloud resource is required by this implementation. An operator must configure an existing Google Cloud project (not done by this change):

1. Enable Google Drive API and Google Picker API in the same Google Cloud project.
2. Configure the Google consent screen and a Web application OAuth client. Register the installation's exact `https://APP_HOST` as an authorized JavaScript origin (localhost origins for local development as appropriate). This uses Google Identity Services' **popup token model**, not an OAuth redirect/code callback, so there is no new server callback URL or refresh token.
3. Create a browser API key restricted to the installation's HTTP referrers **and `https://docs.google.com/*`** (Picker runs in that iframe), with API restrictions allowing Google Picker API and Google Drive API. Use that Google project's numeric project number for the Picker app ID. Follow Google's current verification/publication requirements for the consent screen and your audience.
4. Set the public Worker vars below in the installation's private config. Keep pipeline target configuration in agreement and use its documented deliberate-var-change workflow. Do not place installation values in repository source.

```toml
# Inside the installation's Worker [vars] / [env.hosted.vars] section:
GOOGLE_DRIVE_CLIENT_ID = "YOUR_WEB_CLIENT_ID.apps.googleusercontent.com"
GOOGLE_PICKER_API_KEY = "YOUR_REFERRER_RESTRICTED_BROWSER_API_KEY"
GOOGLE_PICKER_APP_ID = "YOUR_NUMERIC_GOOGLE_CLOUD_PROJECT_NUMBER"
```

These are public browser configuration, not Google access tokens. An incomplete configuration displays setup guidance while the rest of the library remains usable. Only when all three vars are set, the owner UI document (and nothing else) gets a Content-Security-Policy that also admits the exact Google sources GIS and Picker load: `accounts.google.com/gsi/client` and `apis.google.com/js/api.js` plus its `/_/scs/` loader scripts, the GIS stylesheet and `/gsi/` endpoints, and frames from `accounts.google.com/gsi/` and `docs.google.com`. API, content, transfer and render responses keep the strict `script-src 'self'` policy, as does every response on an installation without Drive import configured. Neither `www.gstatic.com` nor `www.googleapis.com` is admitted: the browser never calls Drive directly. If a live Picker build loads from another Google path, add that exact path to `GD_CSP` in `src/imports/service.js` rather than a whole host.

Authorization requests `https://www.googleapis.com/auth/drive.file` alone, with `include_granted_scopes:false`. This scope can grant write capability to selected files: the importer is read-only **in behavior**, and implements only Google GET calls. It never expands to `drive.readonly`, follows folders/shortcuts, changes sharing or writes to Google.

References checked during implementation:

- [Google Picker overview](https://developers.google.com/workspace/drive/picker/guides/overview)
- [Picker example and project/API-key setup](https://developers.google.com/workspace/drive/picker/guides/sample)
- [GIS popup token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model)
- [Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Native export formats](https://developers.google.com/workspace/drive/api/guides/ref-export-formats)
- [Download and export](https://developers.google.com/workspace/drive/api/guides/manage-downloads)

## Security and lifetime

The browser holds a short-lived access token only in the import view's closure. It sends the token in `x-google-access-token` on authenticated same-origin owner requests, protected by the normal session, origin and CSRF checks. There is no token in URLs, local/session storage, D1, R2, metadata, idempotency input or audit records. Google tokens are discarded on navigation, successful completion or cancellation. The Worker forwards them only to fixed `www.googleapis.com/drive/v3` endpoints; redirects are refused. It reads the source account using `about.user.permissionId` and binds sessions/jobs to that identity. Reauthorization must use the same Google account. When Google authorization expires, the import view asks you to authorize again in place; your library session is not affected.

GIS owns popup OAuth validation; this implementation adds no incoming Google callback that could accept a caller-supplied code/state. Import management is human-only on the owner API; agent/publisher tokens cannot list, inspect, authorize or operate imports. A job ID alone grants nothing. Artifact reads, provenance and downloads retain normal project authorization and revocation behavior. Source links do not grant access to Google.

Authorization session metadata expires after one hour. Jobs/staging expire after 24 hours. Each request processes at most one item; the browser drives bounded sequential batches. Closing the browser pauses work after the current request, without losing durable D1 state. Reopen an import from the project, authorize the same account and resume. No in-memory queue, unattended fetching, watcher, refresh token, scheduler or write-back endpoint exists.

## Owner API

All paths start with `/api/projects/:project/drive-import`. Non-GET operations require the normal `x-csrf-token` and `idempotency-key`. Requests use explicit file IDs; never send arbitrary source URLs or asserted owner IDs. Operations using Google also require `x-google-access-token`.

| Method / suffix | Request | Result |
| --- | --- | --- |
| GET root | none | Public Google config, max selection, last 20 jobs, access summary, existing folders |
| POST `/sessions` | `{}` + token | `{session_id, account, expires_at}` |
| DELETE `/sessions/:id` | none | Disconnect that owner's import authorization session; copies remain |
| POST `/jobs` | `{session_id,file_ids:[id...],folder_id?:id}` + token | `{job_id}`; at most 25 IDs and remaining artifact capacity |
| GET `/jobs/:id?cursor=N` | offset cursor | Job and at most 10 items, `next_cursor` |
| POST `/jobs/:id/process` | `{}` + token | Inspect one selected file during review, or publish one ready file after confirmation; durable state |
| POST `/jobs/:id/edit` | `{manifest_version,item_id,remove?:true,another_copy?:true}` | Remove/reinspect an item; increments manifest version |
| POST `/jobs/:id/confirm` | `{manifest_version}` | Bind publication to the current reviewed manifest |
| POST `/jobs/:id/retry` | `{}` + token | Retry eligible failures, invalidate confirmation and return to review |
| POST `/jobs/:id/resume` | `{session_id}` + token | Bind new short-lived authorization for the original account |
| POST `/jobs/:id/cancel` | `{}` | Stop unfinished items, disconnect session, preserve successful artifacts |

Reusing a mutation key with different inputs is `422 idempotency_key_reused`. Reusing the same key returns its stored result; GET current state after an uncertain response. Bounded process keys identify each request; retain the key if retrying a lost response. A job in `confirmed` with all items terminal is finished; no background work follows. The UI can reopen saved jobs without retaining credentials.

Item transitions: `selected → inspecting → ready → publishing → imported`; terminal alternatives are `skipped` and `cancelled`, with recoverable `failed` / `needs_reauthorization`. Retry never revisits imported items. Unsupported files/folders/shortcuts are skipped with an explanation. Cancellation atomically fences further publication; a publication already committed remains. A two-minute job lease serializes processing, and the normal upload finalizer still owns its own lease/write accounting. Interrupted requests can resume once their lease expires.

Error codes include `invalid_selection`, `invalid_source_id`, `unsupported_type`, `source_access`, `too_large`, `quota_exceeded`, `signature_mismatch`, `invalid_utf8`, `integrity_mismatch`, `source_rate_limit`, `google_unavailable`, `needs_reauthorization`, `wrong_account`, `source_changed`, `manifest_changed`, `import_busy`, `staging_expired`, `association_unavailable`, and existing upload errors. Failures are per-file except authorization/session/owner errors. Retry rate-limited or transient operations later. `source_changed` returns the job to review; retry inspection and confirm the refreshed manifest.

## Publication, quota and concurrency

Private staging keys are not artifacts and are never returned by the API. Inspect validates `canDownload`, allowed type, bounded streaming byte count, UTF-8/signature and exact SHA-256; compares metadata before/after reading; and reserves measured binary staging bytes against the existing project quota. Unknown bytes remain Checking until inspected. Native export metadata is a change signal, not a pinned historical revision: a Google change after the final metadata check can still happen. Confirmation publication rechecks source metadata but publishes the exact staged representation the owner reviewed.

Mappings are keyed by provider + source account + stable Drive ID + project. A unique partial index permits one primary association. Repeat import defaults to Already imported; **Import another copy** explicitly creates a detached duplicate without taking over the association. Trashed/unavailable associations require that explicit choice. Filenames are never identity keys.

Creation/publication and initial revision, source mapping, baseline, item completion and audit are in the same D1 batch. Mapping conflicts roll back publication. Binary publication reuses verified staged transfer and `uploadFinish` finalization; mapping hooks execute in its revision transaction. Retries reconcile the existing upload, and terminal failed uploads get a fresh attempt after reinspection. If the source changed, the item's unfinished upload is retired (marked failed, releasing the owner's active-upload slot) and the retry re-reads the source; a stale snapshot is never resumed. Ordinary uploads account for private binary import reservations too. Existing 1 MiB text, 5 MiB binary, 100 MiB default project binary budget and 100 regular artifact limit remain in place. Text creation counts artifacts atomically, closing the existing parallel-creation race. New binary artifacts created by an import are counted in the same statement and fail with `quota_exceeded`; ordinary binary uploads are unchanged.

The existing cron performs bounded idempotent import staging cleanup alongside upload reconciliation. Published artifacts are never deleted by import cleanup. Staging writes are registered before R2 PUT; cleanup waits for settled writes and the processing lease. An interrupted Worker during a staging write may leave `stage_writes > 0`; those bytes remain tracked and charged rather than risking deletion/recreation races. Operator recovery requires confirming the writer has ended before releasing that accounting, as for upload final writes. Never delete referenced immutable blobs. This conservative crash-retention limitation is intentional.

Migration `0018_google_drive_import.sql` is additive; the previous Worker ignores the new tables. Before rollback drain active imports; an older Worker cannot resume them or clean private staging. No existing table is replaced or permission broadened.

## Provenance and backup

Authenticated artifact reads include `source` with the Drive file ID, canonical source link, observed source version/time, export MIME/profile, exact imported representation hash, baseline revision/hash/title/metadata version, import time and detached/no-sync state. The owner also sees the source account ID, importing owner and job/item IDs; agents, OAuth apps and API keys do not. The Google account's email address is shown during import but never stored in provenance or backups. Credentials are separate and never retained. Ordinary project backup adds optional `sources` records. Restore validates each baseline, preserves provenance and usable artifacts, sets mappings detached/non-primary and does not restore sessions, tokens, grants or live source ownership. Older backups without sources remain accepted.

Future manual refresh can compare the stored baseline against current library and source content, then use ordinary guarded revisions and conflict review. Persistent one-way sync needs separate opt-in authorization and reconciliation policy. Neither feature is implemented here.

## Verification and remaining live check

`npm test` includes `test/drive-import.test.mjs`: real local Wrangler/D1/R2 with synthetic Google GET endpoints, plus Chrome with synthetic GIS/Picker scripts. The loopback-only test adapter requires `LOCAL_DEV_LOGIN`, a loopback incoming origin and a loopback `GOOGLE_DRIVE_TEST_ORIGIN`; production cannot redirect Google calls through it.

Synthetic coverage verifies the complete selection/review/publication flow, account binding, integrity/type limits, duplicate/source-change behavior, interruption/restart and backup restoration. Browser evidence is saved under `tmp/test-evidence/drive-import/`. Real Google consent, Picker grants, native conversion fidelity and browser provider CSP behavior need an operator-configured installation and dedicated synthetic Google files. No live Google smoke test, deployment, OAuth registration or cloud provisioning was performed.

### Mutation/state coverage summary

| Invariant | Automated evidence |
| --- | --- |
| Owner session, CSRF, account binding | Agent denied; missing CSRF/token denied; wrong-account resume denied |
| Selection → private review → ordinary artifacts | Real D1/R2 through local Worker; Doc/PDF/Sheet/Slides, uploaded Office bytes |
| Snapshot identity/integrity | Exact hashes, byte downloads, native export MIME, UTF-8/signature/size/truncated-source checks |
| Review consistency | Stale manifest conflict; before/after source change; changed source after review requires reinspection |
| Duplicate/retry behavior | Primary duplicate skip; explicit another copy; key reuse conflict; parallel jobs publish one primary |
| Lifetime and interruption | Cancel preserves published copy; local Worker restart preserves job and resumes same account |
| Backup | Optional sources exported; restore into empty library leaves detached mappings and preserved artifacts |
| Browser | Synthetic GIS/Picker against real local backend, keyboard focus and 390px layout |

Live consent/account-popup behavior, Google-native conversion fidelity, and production hosting configuration are intentionally separate smoke checks. The automated fixture does not prove those external behaviors.

If browser automation from another checkout occupies test ports, set `AGENT_LIBRARY_TEST_PORT_OFFSET=4000` for the entire run. This shifts every registered listener and helper port together without changing production configuration.
