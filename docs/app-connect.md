# App Connect: let your apps keep their data in your library

App Connect is like Google Drive's app data folder, but in your own library. You register an app, and it signs in through OAuth. Inside one project and folder that you choose, the app can create, read, replace and delete **only the files it created**. You see those files in your library like any others, and agents read them through the projects you've shared.

Turn it on with `APP_CONNECT_ENABLED = "1"` (the example config and the self-host generator do this).

## Who can do what

| | App | You (owner) | Agents with access to the project |
|---|---|---|---|
| Create, replace, delete its files | yes | no (protected source), unless you allow [shared editing](#shared-editing) | no, unless you allow shared editing |
| Read its own files | yes | yes | yes (read-only without shared editing) |
| Read anything else in the library | **no** | yes | per their grant |

To edit an app's file, make a copy, or allow shared editing. Revoking the app (Settings → Publishing apps) stops it at once; its files stay in your library. Disabling an app stops every connection it has, reads included (`401`).

## Connect

1. **Register the app** (owner, once): Settings → Publishing apps. Enter a display name, 1–3 exact callback URLs and 0–3 web origins. This creates a public OAuth client (PKCE, no secret). Registration grants nothing.
2. **The app sends you to** `https://MCP_HOST/authorize` with `response_type=code`, its `client_id`, an exact `redirect_uri`, `scope=agentlib:publish offline_access`, `resource=https://MCP_HOST/v1`, `state` and a PKCE S256 `code_challenge`. You sign in and pick the project and destination (a new folder, an existing folder or the project root), or resume the app's earlier connection. The page lists who can already read that project.
3. **Token exchange:** `POST https://MCP_HOST/oauth/token` returns an access token (15 minutes) and a refresh token. Dynamic client registration can never obtain `agentlib:publish`.

**Shared editing.** The consent page has a box, **Let people and agents edit these files too**, which is off by default. See [Shared editing](#shared-editing).

**Suggested destination.** The app may add `agentlib_project` (an id or title) and `agentlib_folder` (a top-level folder name, 1–80 characters, no `/`) to the authorize URL; you can also set defaults when registering (`suggested_project`, `suggested_folder` on `PUT /api/app-clients/{id}`). These only pre-fill the consent page. You always choose, and invalid values are ignored.

## API (`https://MCP_HOST/v1/app...`, `Authorization: Bearer <access token>`)

One path-addressed API for every kind of file: text (Markdown, HTML, JSON, CSV) and binary (images, PDF, video, any other bytes).

| Request | Answer |
|---|---|
| `GET /v1/app` | `{ app_id, publisher_id, display_name, project: {id, title}, folder: {id, name, path} or null, shared_edit (see [Shared editing](#shared-editing)), limits: { max_file_bytes, max_text_bytes, max_binary_bytes, max_path_chars, max_path_segments } }` (`max_file_bytes` is the text limit, kept for older apps) |
| `GET /v1/app/files?prefix=&cursor=&limit=` | `{ files, next_cursor }` in path order, `limit` 1–100. Each file: `path`, `file_id`, `kind`, `mime`, `content_type`, `title`, `folder: {id, path}` (or null at the project root), `revision`, `etag`, `sha256`, `size`, `created_at`, `updated_at`, `web_url` (and `preview_url` for text) |
| `GET` / `HEAD /v1/app/files/{path}` | The bytes, with `ETag: "<sha256>"`. Supports `If-None-Match` (`304`) and `Range` (`206`, `416`) |
| `PUT /v1/app/files/{path}` | Needs `Content-Type` (the path's type), `Content-Length`, `Idempotency-Key`, and `If-None-Match: *` (create) or `If-Match: "<sha256>"` (replace). Binary files also need `X-Content-SHA256: <64 hex>`. Optional: `X-Agentlib-Title`, `X-Agentlib-Author`, `X-Agentlib-Change-Note` ([below](#title-author-and-change-note)). `201`/`200 { file }` (`file.title` included); `200 { file, unchanged: true }` when the bytes are the current ones (nothing is written); `412` with `current_etag` and `current_revision` when the precondition fails |
| `DELETE /v1/app/files/{path}` | Needs `If-Match` and `Idempotency-Key`. Moves the file to your trash and frees the path |
| `GET /v1/app/connection-info` | Diagnostic: the app's destination and whether writes are allowed |

The ETag is always the quoted SHA-256 of the bytes, and the same value is in `etag` in every listing and answer. Reads are sent `Cache-Control: private, no-store, no-transform`. If something on the way still weakens it to `W/"<sha256>"`, that form is accepted in `If-Match` too.

**Paths.** Lowercase `[a-z0-9._-]` segments, not starting with `.`; 1–8 segments, at most 200 characters. The last segment is the file name and ends in an extension; no folder segment ends in `.md`, `.html`, `.json` or `.csv`. Lowercase only means a path is unique by its name alone, for every kind of file. `notes/2026-11-22-brief.md` and `shots/a.png` are fine; `Brief.md`, `a.json/b.csv`, `notes.txt` and `logo.svg` are `400 invalid_path`.

**Folders.** The folder segments of a path are real folders inside the destination you approved: `neo/reports/2026-11-22-brief.md` lives in `<destination>/neo/reports`, created on the first write and shown in your library like any folder. They belong to the app while it is connected: you can't rename or move them, or a folder below the destination that contains them (`409 folder_app_owned`), and you can't move its files elsewhere. You can delete an empty one; the app recreates it on its next write. An app can create at most 200 folders (`409 limit_reached`). You can rename or move the destination itself; the app keeps writing to the same folders. The app can never reach anything outside its destination. Files written before paths became folders sit in the destination itself and move into their path's folder on their next replace.

**Kinds and types.** The extension chooses the kind and the one `Content-Type` a `PUT` must send:

| Extension | Kind | Content-Type | Limit |
|---|---|---|---|
| `.md`, `.html`, `.json`, `.csv` | text (`markdown`, `html`, `json`, `csv`) | `text/markdown`, `text/html`, `application/json`, `text/csv` (`charset=utf-8` if given) | 1 MiB |
| `.png`, `.jpg`/`.jpeg`, `.webp`, `.gif` | `binary` | `image/png`, `image/jpeg`, `image/webp`, `image/gif` | plan `file_bytes` (default 25 MiB) |
| `.pdf`, `.mp4`, `.webm` | `binary` | `application/pdf`, `video/mp4`, `video/webm` | plan `file_bytes` |
| any other 1–10 character `[a-z0-9]` extension (`.bin`, `.gz`, …) | `binary` | `application/octet-stream` | plan `file_bytes` |

Text is validated (strict UTF-8, valid JSON or CSV). A binary is streamed to storage in one pass: its length must equal `Content-Length` and its SHA-256 must equal `X-Content-SHA256`, or nothing is stored (`400 incomplete_body`, `422 integrity_mismatch`); its first bytes must carry the type's signature (`422 signature_mismatch`; octet-stream takes any non-empty bytes). A 5 MiB (or 25 MiB) file is one `PUT`; there is no separate upload session.

**Safe serving.** Reads carry `X-Content-Type-Options: nosniff`, a sandboxing `Content-Security-Policy` and `Cross-Origin-Resource-Policy: same-origin`. Markdown, HTML, JSON and CSV come back as data (`text/plain` or their data type); images and video are inline; PDF, HTML, JSON, CSV and octet-stream are `Content-Disposition: attachment`. SVG is not accepted. Nothing an app stores ever runs on the library's origin.

### Title, author and change note

Three optional `PUT` headers, for display only. They don't change the rules for paths, ETags, idempotency keys or authorization.

| Header | Value | Effect |
|---|---|---|
| `X-Agentlib-Title` | 1–200 characters (the document title rule), trimmed; no control or invisible formatting characters | The file's title. Set on create; on a replace, whenever it differs from the file's current title, as a new details version. So an app that sends its title on every write also puts it back after you rename the file; an app that wants to respect your renames sends the header only on create. With the same bytes and a new title, nothing but the title changes: no new content version, same ETag. Without the header a new file is titled by its file name (`brief.md`) and a replace keeps the title |
| `X-Agentlib-Author` | 1–80 characters with at least one letter or digit; whitespace runs collapse; no control, invisible formatting (bidi, zero-width) or blank characters; not `You`, `Owner` or `Unknown`, and no ` via ` | Who in the app made this write. History shows "`<label> via <app>`" (for example "Chief via Brigade"). The app is still the actor: the label is stored on the version and never changes what the app may do. Without it, History shows the app's name |
| `X-Agentlib-Change-Note` | at most 280 characters, no control or invisible formatting characters; empty is the same as none | The version's change note (on a title-only replace, the note of the details version) |

Header values are ASCII. Send any other character as percent-encoded UTF-8 (`R%C3%A9sum%C3%A9`), either plain or as an RFC 8187 value (`UTF-8''R%C3%A9sum%C3%A9`); a literal `%` is `%25`, and a title that itself starts with `UTF-8''` must send its `'` as `%27`. A header sent twice is read as both values joined by `, ` (standard HTTP). A value that is too long is `413 too_large`; an empty, malformed or control-character value is `400 invalid_input`, before anything is read. Browser apps may send all three (they are in the CORS preflight's allowed headers).

**Idempotency.** Every `PUT` and `DELETE` needs an `Idempotency-Key` (8–128 characters). A retry with the same key and request (for a binary: the same declared SHA-256 and length; and the same title, author and change note headers, sent or not) replays the first answer (`idempotent_replay: true`) without reading the body again; the same key with a different request is `422`. A client that lost a response can also treat `412` with `current_etag` equal to the SHA-256 of its own body as success. A `200 unchanged` answer to a request that sent any of the three display headers is recorded under its key too, so its retry replays it even if the owner has renamed the file since.

**Every request re-checks authorization:** a revoked or disabled app, a superseded token, a removed creator, a deleted project or destination stop it at once, and writes are fenced in the same D1 statement that stores them. A suspended workspace stops writes (`403 workspace_read_only`) but not reads. Other limits: the workspace storage limit (`402 limit_reached`) and a per-app request rate (`429`, `Retry-After`).

| Status | Code | When |
|---|---|---|
| 400 | `invalid_path`, `invalid_input`, `incomplete_body` | Path rule (or folders too deep under the destination); malformed headers, `prefix`, `cursor` or `limit`; body length differs from `Content-Length` |
| 411 / 413 | `length_required`, `file_too_large` (text), `too_large` (binary) | No `Content-Length`; over the limit (refused from the headers) |
| 415 | `unsupported_type` | `Content-Type` is not the path's type |
| 422 | `invalid_content`, `integrity_mismatch`, `signature_mismatch`, `idempotency_key_reused` | Invalid UTF-8, JSON or CSV; SHA-256 differs from `X-Content-SHA256`; bytes are not the declared type; key reused for another request |
| 428 / 412 | `precondition_required`, `precondition_failed` | No precondition (or no `X-Content-SHA256` on a binary); stale `If-Match`, or the file exists or is missing |
| 409 | `destination_file_trashed`, `conflict`, `folder_conflict` | You moved the file to trash (restore it first); another writer won; a folder on the path changed meanwhile |
| 401 / 403 | `unauthenticated`, `publisher_revoked`, `scope_mismatch`, `workspace_read_only` | Authorization changed |
| 402 / 429 | `limit_reached`, `rate_limited` | Workspace storage (checked before the body is read); request rate, or more than 20 file uploads in progress in the project at once (retry after `retry_after_seconds`) |
| 409 | `limit_reached` | The app has created 200 folders; reuse or delete some |

## Updating several files at once: index last

There is no multi-file transaction. To publish a consistent set of files:

1. `PUT` each data file. Each answer has `file_id`, `revision` and `sha256`.
2. `PUT` `index.json` **last**, with `If-Match` set to the index's ETag from the previous run (`If-None-Match: *` the first time). The index lists `{ path, file_id, revision, sha256, size }` for every file of this update.
3. After the index is stored, `DELETE` the files it no longer lists.

A `412` on the index means another writer won: re-read the index, rebuild and retry. A crash between steps leaves the previous index in place, and repeating the run with the same keys is safe: unchanged files answer `unchanged: true`.

**Readers** (agents, bots, other apps) read `index.json` first. Find it with `list_artifacts` and `app_path: "index.json"` (also `GET /v1/projects/{id}/files?app_path=index.json` with an API key). Then read each listed file **at its pinned revision** (`read_artifact` takes a `revision`) and check its `sha256`. A reader that arrives during a run sees the old index and the old revisions, never a mix. Every file's metadata carries `app_path` (null for files that are not an app's), so a title match is never needed.

## Shared editing

By default only the app changes its files, so the app stays the source of truth. Some apps are shared workspaces instead, for example a bot library where you and your agents keep notes next to the bot's reports. For those, tick **Let people and agents edit these files too** on the consent page, or turn it on later in **Settings → Connections → Publishing apps** (one switch per connection). With it on:

- People with edit access to the project, and agents connected with edit access to it (MCP, API keys, agent tokens), can save new versions of the app's files, upload a new version of a binary file (same type), rename them, change tags, comment, restore older versions and trash them. History shows who made each version.
- The app still owns the paths. Files stay in its folders and can't be moved out, and its folders keep their rules (see **Folders** above). The app keeps reading and writing them at the same paths.
- **The app must expect outside changes.** `GET /v1/app` reports `shared_edit: true`. Always replace with `If-Match`: a `412 precondition_failed` answer carries `current_etag` and `current_revision`. Re-read, merge, and `PUT` again with the new ETag. Never overwrite blindly. A file someone trashed answers `409 destination_file_trashed` until you restore it.
- Review doesn't apply: app files never wait for review, so an agent's edit is saved directly, even in a project that requires review. The consent page and the Settings confirmation say so.
- An outside edit of a text file must fit the app's own 1 MiB text limit (`413 too_large`), so the app can always replace the file again.

Changing the setting takes effect on the next write. It is `PUT /api/publishers/{publisher_id}/sharing` with `{ "shared_edit": true | false }`. The person who connected the app (while they can still edit the project) or a project admin may change it. Each change is audited as `publisher.sharing`. Turning it on needs an active connection in an active workspace. Turning it off is always allowed, even for a revoked connection or in a suspended workspace. Re-sending the current value changes nothing and isn't audited. Turning it off protects the files again; edits already made stay in their history. **Revoking the app turns shared editing off**, so a revoked app's files are protected, as before. A resumed connection keeps its setting. A Worker rolled back before this release ignores the setting, and every app file is protected again.

## Backup

A project backup includes app files as ordinary files, each marked `app: { name, path }` (`path` is null for a trashed file; backup schema 3). Restoring or importing makes them ordinary, editable files in your project: title = the path, tag `app:<name>`, in the same folder path as before (`folder_name` in the backup holds the full path; recreated, owned by you), no connection to an app. See [operations.md](operations.md#what-backups-cover).

## Limits

See [limits.md](limits.md#app-connect-publishers). One destination per connection; connect again to publish elsewhere. Agent Library adds no encryption of its own (see [architecture.md](architecture.md#how-the-worker-is-built)).

## Not yet

Sharing only one app's folder with agents; binary files larger than the plan's file limit (a resumable upload session).
