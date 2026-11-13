# App Connect: let your apps keep their data in your library

App Connect is like Google Drive's app data folder, but in your own library. You register an app, and it signs in through OAuth. Inside one project and folder that you choose, the app can create files and read or update **only the files it created**. You can see those files in your library like any others, open and link them, and let agents read them through the projects you've shared.

Typical uses:
- a personal tracker app exporting its data, such as measurements, logs or notes;
- a script that publishes reports;
- a side project that needs somewhere durable to put files, without its own storage or auth.

Turn it on with `APP_CONNECT_ENABLED = "1"` (the example config and the self-host generator do this).

## What the app can and can't do

| | App (publisher) | You (owner) | Agents with access to the project |
|---|---|---|---|
| Create files in its folder | yes | yes | no (folder is the app's) |
| Read its own files | yes | yes | yes, read-only |
| Read anything else in the library | **no** | yes | per their grant |
| Change its files' content | yes | no (protected source) | no |
| See other apps' files | **no** | yes | per their grant |

The protection exists so the app stays the source of truth for its own data. If you want to edit something, make a copy. Revoking the app (Settings → Publishing apps) stops it immediately. Its files stay in your library.

## Flow

1. **Register the app** (owner, once): Settings → Publishing apps → *Register a publishing app*. Enter a display name, 1–3 exact callback URLs and 0–3 web origins. This creates a public OAuth client (PKCE, no client secret) and shows its `client_id`. Registration alone grants nothing.
2. **The app connects.** It sends the user to `https://MCP_HOST/authorize` with:
   - `response_type=code` and your `client_id`;
   - an exact `redirect_uri`;
   - `scope=agentlib:publish offline_access`;
   - `resource=https://MCP_HOST/v1`;
   - `state` and a PKCE S256 `code_challenge`.

   You sign in and pick the project and destination (a new folder, an existing folder or the project root). If the app connected before, you can resume its earlier publisher. The page lists who can already read that project, so you know who will see the app's files. The app can suggest a destination (see [Suggested destination](#suggested-destination)), but you can always change it.
3. **Token exchange.** The app calls `POST https://MCP_HOST/oauth/token` with the code and `code_verifier`, and gets back an access token (15 minutes) and a refresh token. Dynamic client registration can never obtain `agentlib:publish`. Only owner-registered apps can.
4. **The app uses `/v1/publisher/*`** with `Authorization: Bearer <access token>`.

## Suggested destination

There are two ways to give the consent page a sensible default. Neither one creates or grants anything; you still choose, and you can override both.

1. **The app suggests it on each connect.** Add optional parameters to the authorize URL:
   - `agentlib_project`: a project ID or title (case-insensitive);
   - `agentlib_folder`: a folder name.

   Each must be 1–80 characters, without `/` or control characters. Invalid values are silently ignored.
2. **You set a default when registering the app.** Fill in *Suggested project* and *Suggested folder* in Settings → Publishing apps, or call `PUT /api/app-clients/{app_client_id}` with `suggested_project` and `suggested_folder` (an empty string clears one).

The app's hint wins over the registration default. On the consent page:
- the suggested project is pre-selected if it exists, otherwise your first project;
- if a folder with the suggested name already exists in that project, it's pre-selected;
- otherwise "New folder" is pre-filled with the suggested name (or the app's name if there's no suggestion).

```
https://MCP_HOST/authorize?response_type=code&client_id=…&redirect_uri=…&scope=agentlib%3Apublish%20offline_access
  &resource=https%3A%2F%2FMCP_HOST%2Fv1&state=…&code_challenge=…&code_challenge_method=S256
  &agentlib_project=Notes&agentlib_folder=Daily%20exports
```

## API (`https://MCP_HOST/v1/publisher/...`)

| Method and path | Purpose |
|---|---|
| `GET /me` | Who am I: project, destination folder, current snapshot, limits (`generation_contract`) |
| `GET /files`, `GET /files/{id}`, `GET /files/{id}/content[?revision=N]` | List and read this app's own files |
| `POST /snapshots` | Atomically publish a set of JSON/CSV files (with a manifest) as the new current state |
| `GET /snapshots`, `GET /snapshots/current`, `GET /snapshots/{id}` | Snapshot history |
| `POST /generations`, `PUT /generations/{gid}/parts/{name}`, `POST /generations/{gid}/commit`, `DELETE /generations/{gid}` | Large exports: stage up to 2048 parts of ≤ 32 KiB each, then commit them all at once |

`GET /v1/publisher/files*` lists only files that have a name. A file the app deleted through App Files (below) is not listed there either. This route is kept for existing apps and is deprecated; new apps should use App Files.

Rules that apply to every call:
- Every mutation takes an `Idempotency-Key`. Retries replay the stored result.
- Snapshots use a monotonic `source_revision`, plus an optional compare-and-swap on the current snapshot.
- Files are JSON or CSV. An optional schema (`agentlib.measurements/1`) validates time-series records.
- For staged generations, the root must be an `agentlib.generation.index/1` document that references every part. Each part is an `agentlib.generation.part/1` document. The legacy names `healthconnect.readable.index/1` and `healthconnect.readable.part/1` are still accepted.

The exact request and response shapes are in `packages/core/src/api/publisher.js` (`GENERATION_CONTRACT` and the routes). Working examples are in `test/app-connect-phase2.test.mjs`, `test/app-connect-phase3.test.mjs`, `test/generations-regression.test.mjs` and the harness `test/fixtures/app-connect-harness.mjs`.

## App Files (`https://MCP_HOST/v1/app/files...`)

App Files lets an app keep ordinary text files by path, one request per file, like an app data folder. It uses the same publisher token as `/v1/publisher/*`. Every request checks the publisher's current authorization again: a revoked publisher, a superseded token, a removed creator or a deleted project or destination stop it at once. A suspended workspace stops the app's writes (`403 workspace_read_only`); its reads continue.

| Method and path | Needs | Answer |
|---|---|---|
| `GET /v1/app/files?prefix=&cursor=&limit=` (and `HEAD`) | `Authorization` | `200 { files, next_cursor }`, in path order, `limit` 1–100 (default 100). Each file: `path`, `file_id`, `kind`, `content_type`, `revision`, `etag`, `sha256`, `size`, `created_at`, `updated_at` and links |
| `GET` or `HEAD /v1/app/files/{path}` | `Authorization`; optional `Range`, `If-None-Match` | `200` or `206` with the bytes; `304` when `If-None-Match` matches (`*`, a weak `W/"…"` tag, or a list), with the same headers |
| `PUT /v1/app/files/{path}` | `Authorization`, `Content-Type`, `Idempotency-Key`, and `If-Match` (replace) or `If-None-Match: *` (create); optional `Content-Length`, `X-Content-SHA256` | `201` create or `200` replace: `{ file: { path, file_id, kind, revision, etag, sha256, size } }` and `ETag`. `200 { file, unchanged: true }` when the bytes equal the current version (nothing is written) |
| `DELETE /v1/app/files/{path}` | `Authorization`, `Idempotency-Key`, `If-Match` | `200 { file: { path, file_id, trashed: true, revision } }` |

**Files are text.** Markdown (`.md`, `.markdown`), HTML (`.html`, `.htm`), JSON (`.json`) and CSV (`.csv`). The extension chooses the kind; `Content-Type` must be `text/markdown`, `text/html`, `application/json` or `text/csv` and match it, with `charset=utf-8` if a charset is given. Content is checked like any other document (strict UTF-8, valid JSON or CSV). Reads are always served as data: HTML and Markdown come back as `text/plain`, with `X-Content-Type-Options: nosniff` and a sandboxing `Content-Security-Policy`, so nothing an app stores ever runs on the library's origin. Stored content is returned byte for byte; links in it are never rewritten.

**One request body is at most 1 MiB (1,048,576 bytes).** Larger single files for apps are planned; the three-step upload flow does not accept an app's token today. Until then, an app's larger exports go through the staged export route (`/v1/publisher/generations`), or must be split into files of at most 1 MiB. A body must arrive within 15 seconds in total, with no gap longer than 5 seconds; that is about 70 KB/s for a full 1 MiB. Clients on weak links should send smaller files, or retry with the same `Idempotency-Key`.

When the API refuses a `PUT` (or answers "unchanged") before it has taken the body, it first reads and discards the rest of the body, up to about 16 MiB and within the same time limits as an upload, so the answer reaches a client that is still sending. A larger or slower body is cut off, and the client may see a closed connection instead of the answer. This takes no upload slot and keeps none of the body: a discard uses constant space (the request's state, its timers and one chunk at a time), whatever the body's size. Discarding has its own budget: at most 8 bodies per server instance, 2 per workspace and 2 per person (the person who connected the app); beyond it the body is cut off at once and the answer may be lost. An undeclared body that passes 1 MiB is discarded the same way, after its upload slot is freed. A discard that the runtime cuts short without releasing its place is recovered: its place is dropped after 60 seconds (logged `app_files_drain_reclaimed`).

These are answered **without** reading the body, so a client still sending may see a closed connection instead: a missing or invalid token; every write-authorization refusal (a revoked or disabled app, a suspended workspace, a removed creator, a deleted project or destination); the rate limit (`429`); and a raw path refused before the file handler runs (`400 invalid_path`: a path the URL parser would change, such as `.` or `..` segments (also escaped as `%2e`) or `\`, or `/v1/app/files/` with nothing after it). A path that passes that check but is refused by the file handler (an empty segment, other `%` escapes, a bad segment or extension, or the reserved `manifest.json`) is answered after the body is discarded, like any other refusal.

### Paths

- 1–8 segments separated by `/`, each 1–64 characters of letters, digits, `.`, `_` and `-`, not starting with `.`; at most 200 characters; ending in one of the extensions above. ASCII only, no `%` escapes, no `\`, no empty segments. The path must be exactly what was sent (no `.` or `..` segments).
- **Conflicts ignore case.** Within one app, no two files may have paths that differ only by case, and no file may sit where another file's path needs a folder (folder names may contain dots). With `Notes.md` stored, `notes.md` and `NOTES.MD/x.md` are refused; with `Notes.md/x.md` stored, `notes.md` is refused. Each refusal is `409 path_conflict`.
- **`manifest.json` is reserved.** Any path whose first segment is `manifest.json` in any case (`Manifest.json`, `MANIFEST.JSON`, `manifest.json/x.md`) is refused on `PUT` and `DELETE` (`400`), and never listed or read (`404`).
- The path never chooses where a file goes: every file lives in the project and folder you approved for the app. Files of other apps and your own files are invisible to the app.

### Preconditions, idempotency and replay

- `PUT` needs either `If-None-Match: *` (create; refused if a file exists) or `If-Match` (replace). `DELETE` needs `If-Match`. `If-Match` is either the file's `ETag` (`"<sha256>"`) or a revision, written `rev:N` or `"rev:N"`. A revision is judged by number: if the content went A → B → A, `rev:1` is stale although the bytes match again.
- `X-Content-SHA256` (64 lowercase hex characters) is optional. When it equals the current version's hash on a replace, the answer is `200 unchanged` without keeping the body, taking a slot or writing anything, even when the app is at a limit; the body sent is then not checked against the hash. Otherwise, when the body does not match it, the answer is `422 integrity_mismatch`.
- Every `PUT` and `DELETE` needs an `Idempotency-Key`. A retry with the same key and the same request replays the first answer (with `idempotent_replay: true`), even if the file or the limits changed since, and even when the retry races the first request. The same key with a different request is `422 idempotency_key_reused`. A refusal can arrive up to the upload time limit (15 s) after it was decided, while the body is discarded; if a request with the same key committed in between, retrying with that key returns that request's answer. When a stored answer exists for the key, a busy server may answer `503` or `429` instead of the refusal; retry later with the same key and the stored answer is replayed.

### Delete

`DELETE` moves the file to your trash. The app can no longer see it, and its path is free for a new file. The file still counts toward the app's lifetime limits. If you restore it, it comes back as a read-only copy of that app's data, without a path: you can open, rename, link or delete it, but not edit it (make a copy to edit), and the app does not see it again.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `invalid_path` | The path breaks a rule above (N1) |
| 409 | `path_conflict` | "This path conflicts with another file of this app (the same path in another case, a file where a folder is needed, or a reserved export file)" (N2): another file of this app has the path in another case, a file is where a folder is needed or the reverse, or the path is reserved for a file of the app's staged exports (generations) |
| 415 | `unsupported_type` | `Content-Type` does not match the extension (N3), or is not one of the four types (`Allowed: …`) |
| 428 | `precondition_required` | No `If-Match` / `If-None-Match` (N4) |
| 412 | `precondition_failed` | `If-Match` does not match the current version (N5, with `current_revision` and `current_etag`); a file already exists (N6); no file exists (N7) |
| 400 | `invalid_input` | Malformed `If-Match` / `If-None-Match` (N8), malformed `X-Content-SHA256` (N9), bad `prefix` (N10) or `cursor` (N11), `manifest.json` reserved, bad `Content-Length` |
| 503 | `app_files_busy` | This server instance is receiving as many files as it can (N12); `Retry-After: 1` |
| 413 | `file_too_large` | The body is over 1 MiB (N14) |
| 408 | `request_timeout` | The body arrived too slowly (N15) |
| 429 | `app_files_concurrency` | This workspace or its owner is already sending 2 files to this server instance (N16); `Retry-After: 1` |
| 429 | `rate_limited` | The publisher's request rate; `Retry-After` |
| 409 | `destination_file_trashed` | You moved the file to trash; restore it first |
| 413 | `quota_exceeded` | A lifetime limit (below), with `max_files`, `max_revisions`, `max_bytes`; or the snapshot quota |
| 402 | `limit_reached` | The workspace is out of storage |
| 401 / 403 | `unauthenticated`, `publisher_revoked`, `scope_mismatch`, `workspace_read_only` | Authorization changed (reconnect, or ask the owner) |
| 422 | `invalid_content`, `integrity_mismatch`, `idempotency_key_reused` | Content invalid, hash mismatch, key reused |

`unchanged: true` (N13) is a field of a `200` answer, not an error.

### Upload slots

A server instance admits at most **4** uploads at a time, at most **2 per workspace** and at most **2 per person** (the person who connected the app). A body holds its slot until its request finishes, whatever its size. An upload still holding its slot after 10 minutes is treated as stuck and stops counting toward the 4, but at most 2 such older uploads are tracked this way, so an instance holds at most 6 bodies. These limits are **per server instance**, not a global guarantee: the same workspace can send more through other instances, and there is no fairness between callers. When admission is full, new uploads from anyone on that instance are refused with `503 app_files_busy`; clients should wait for `Retry-After` and retry with the same `Idempotency-Key`. Reads, `DELETE` and an unchanged `PUT` with a matching `X-Content-SHA256` take no slot and keep working.

### Lifetime limits per app

| Limit | Value |
|---|---|
| Files created through App Files | 10,000 |
| Versions written through App Files | 100,000 |
| Bytes written through App Files | 1 GiB |

These never go down: deleting a file does not give them back. They are separate from the workspace storage limit (`402`), which also applies.

**App Files and snapshots interact one way.** App Files has its own limits (above: 10,000 files, 100,000 versions and 1 GiB per app, for the app's lifetime). Snapshot commits are limited to **32 files and 256 MiB per app**, and that count includes the app's App Files rows (also ones the app deleted). So once an app holds about 32 App Files, it can no longer commit a snapshot (`413 quota_exceeded`). The reverse does not apply: snapshot files do not count toward the App Files limits.

Names follow one rule for the whole app, across App Files, snapshots and generations: no two names that differ only by case, and no file where a folder is needed (`409 path_conflict`, with `name` and `conflicts_with`). Names an app already has are kept. `manifest.json` is reserved in any case. Snapshot and generation commits need migration 0031 applied before the Worker that enforces this.

A generation commit answers `409 path_conflict` for a part or manifest name that breaks this rule. A part with exactly the name of an existing file still answers `409 generation_conflict`. Generation ids that differ only by case (`g_A`, `g_a`) produce manifest names that differ only by case, so the second one to commit is refused.

### What a disabled app can do

When you disable an app, every connection it has stops at once: reads and writes fail with `401` ("This app has been disabled by the owner of this library"), including a write already in progress, and token renewal is refused. A read that has already started finishes. The app's next token renewal ends that connection for good, so disabling cannot be undone; register the app again if you need it back. New connections are refused.

A disabled app's connections still count toward your connected-agents limit, and its web origins stay allowed for cross-origin requests, until you revoke each connection.

### Operator notes

- Watch the log events `app_files_drain_skipped` (`scope`, `count`; at most once a minute per instance: refused bodies were cut off because the discard budget was full) and `app_files_drain_reclaimed` (a discard's place was dropped after 60 seconds; it should never appear, and means a discard was cut short by the runtime). Neither carries ids, paths or content.
- Alert on the log events `app_files_slot_reclaimed` and `app_files_slots_stuck`. They mean a request held an upload slot for over 10 minutes; at most 2 such slots are set aside per instance, and if more stay stuck that instance answers `503 app_files_busy` to every upload until it is recycled. `app_files_slots_stuck` repeats at most every 10 minutes while it lasts. The events carry no ids, paths or content.
- App Files are stored as text like any other document; Agent Library adds no encryption of its own (see [architecture.md](architecture.md#how-the-worker-is-built)).
- The memory used per upload (6–10 MiB for a 1 MiB body) is an estimate; it has not been measured anywhere.
- The release of an upload slot when a client disconnects mid-upload has been observed in local development only.

## Current limits

- **Formats.** Snapshots and generations write JSON and CSV only; App Files adds Markdown and HTML (text). Binary publishing is planned.
- **Backup.** The built-in project backup doesn't yet cover projects that contain App Connect files (`backup_unsupported`). See [operations.md](operations.md#what-backups-cover).
- **One destination.** Each connection writes into one project and folder. To publish somewhere else, connect again (a new publisher).

## Roadmap toward "app data folder" parity

1. **Any artifact kind for publishers.** Markdown, HTML and binary uploads through the same file APIs agents use, scoped to the publisher's own files.
2. **Simple per-file CRUD**: done for text files (App Files, above). Larger and binary files through the upload flow are planned.
3. **Owner "share with agents" from the app folder.** Today agents see app files through their project grant. A per-folder grant would let you share only one app's folder.
4. **Publisher-aware backup and restore** that preserves source protection.
