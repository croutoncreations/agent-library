# App Connect: let your apps keep their data in your library

App Connect is like Google Drive's app data folder, but in your own library. You register an app, and it signs in through OAuth. Inside one project and folder that you choose, the app can create, read, replace and delete **only the files it created**. You see those files in your library like any others, and agents read them through the projects you've shared.

Turn it on with `APP_CONNECT_ENABLED = "1"` (the example config and the self-host generator do this).

## Who can do what

| | App | You (owner) | Agents with access to the project |
|---|---|---|---|
| Create, replace, delete its files | yes | no (protected source) | no |
| Read its own files | yes | yes | yes, read-only |
| Read anything else in the library | **no** | yes | per their grant |

To edit an app's file, make a copy. Revoking the app (Settings → Publishing apps) stops it at once; its files stay in your library. Disabling an app stops every connection it has, reads included (`401`).

## Connect

1. **Register the app** (owner, once): Settings → Publishing apps. Enter a display name, 1–3 exact callback URLs and 0–3 web origins. This creates a public OAuth client (PKCE, no secret). Registration grants nothing.
2. **The app sends you to** `https://MCP_HOST/authorize` with `response_type=code`, its `client_id`, an exact `redirect_uri`, `scope=agentlib:publish offline_access`, `resource=https://MCP_HOST/v1`, `state` and a PKCE S256 `code_challenge`. You sign in and pick the project and destination (a new folder, an existing folder or the project root), or resume the app's earlier connection. The page lists who can already read that project.
3. **Token exchange:** `POST https://MCP_HOST/oauth/token` returns an access token (15 minutes) and a refresh token. Dynamic client registration can never obtain `agentlib:publish`.

**Suggested destination.** The app may add `agentlib_project` (an id or title) and `agentlib_folder` (a name, 1–80 characters, no `/`) to the authorize URL; you can also set defaults when registering (`suggested_project`, `suggested_folder` on `PUT /api/app-clients/{id}`). These only pre-fill the consent page. You always choose, and invalid values are ignored.

## API (`https://MCP_HOST/v1/app...`, `Authorization: Bearer <access token>`)

| Request | Answer |
|---|---|
| `GET /v1/app` | `{ app_id, publisher_id, display_name, project: {id, title}, folder: {id, name} or null, limits: { max_file_bytes } }` |
| `GET /v1/app/files?prefix=&cursor=&limit=` | `{ files, next_cursor }` in path order, `limit` 1–100. Each file: `path`, `file_id`, `kind`, `revision`, `etag`, `sha256`, `size`, `updated_at` |
| `GET` / `HEAD /v1/app/files/{path}` | The bytes, with `ETag: "<sha256>"`. Supports `If-None-Match` (`304`) and `Range` |
| `PUT /v1/app/files/{path}` | Needs `Content-Type`, `Content-Length` (at most 1 MiB, refused before the body is read), `Idempotency-Key`, and `If-None-Match: *` (create) or `If-Match: "<sha256>"` (replace). `201`/`200 { file }`; `200 { file, unchanged: true }` when the bytes are the current ones (nothing is written); `412` with `current_etag` and `current_revision` when the precondition fails |
| `DELETE /v1/app/files/{path}` | Needs `If-Match` and `Idempotency-Key`. Moves the file to your trash and frees the path |
| `GET /v1/app/connection-info` | Diagnostic: the app's destination and whether writes are allowed |

**Paths.** Lowercase `[a-z0-9._-]` segments, not starting with `.`; 1–8 segments, at most 200 characters. The last segment ends in `.md`, `.html`, `.json` or `.csv`, and no other segment does. So `summary/steps.json` is fine and `Steps.json`, `a.json/b.csv` and `notes.txt` are `400 invalid_path`. The path never chooses where a file goes: every file lives in the folder you approved.

**Files are text.** The extension chooses the kind. `Content-Type` must be `text/markdown`, `text/html`, `application/json` or `text/csv` and match it (`charset=utf-8` if given). Content is validated (strict UTF-8, valid JSON or CSV). Reads come back as data (`text/plain`, `nosniff`, a sandboxing CSP), so nothing an app stores ever runs on the library's origin. Binary files and files over 1 MiB are not supported yet.

**Idempotency.** Every `PUT` and `DELETE` needs an `Idempotency-Key` (8–128 characters). A retry with the same key and request replays the first answer (`idempotent_replay: true`); the same key with a different request is `422`. A client that lost a response can also treat `412` with `current_etag` equal to the SHA-256 of its own body as success.

**Every request re-checks authorization:** a revoked or disabled app, a superseded token, a removed creator, a deleted project or destination stop it at once, and writes are fenced in the same D1 statement that stores them. A suspended workspace stops writes (`403 workspace_read_only`) but not reads. Other limits: the workspace storage limit (`402 limit_reached`) and a per-app request rate (`429`, `Retry-After`).

| Status | Code | When |
|---|---|---|
| 400 | `invalid_path`, `invalid_input` | Path rule, malformed headers, `prefix`, `cursor` or `limit` |
| 411 / 413 | `length_required`, `file_too_large` | No `Content-Length`; over 1 MiB |
| 415 / 422 | `unsupported_type`, `invalid_content` | Wrong `Content-Type`; invalid UTF-8, JSON or CSV |
| 428 / 412 | `precondition_required`, `precondition_failed` | No precondition; stale `If-Match`, or the file exists or is missing |
| 409 | `destination_file_trashed` | You moved the file to trash; restore it first |
| 401 / 403 | `unauthenticated`, `publisher_revoked`, `scope_mismatch`, `workspace_read_only` | Authorization changed |

## Updating several files at once: index last

There is no multi-file transaction. To publish a consistent set of files:

1. `PUT` each data file. Each answer has `file_id`, `revision` and `sha256`.
2. `PUT` `index.json` **last**, with `If-Match` set to the index's ETag from the previous run (`If-None-Match: *` the first time). The index lists `{ path, file_id, revision, sha256, size }` for every file of this update.
3. After the index is stored, `DELETE` the files it no longer lists.

A `412` on the index means another writer won: re-read the index, rebuild and retry. A crash between steps leaves the previous index in place, and repeating the run with the same keys is safe: unchanged files answer `unchanged: true`.

**Readers** (agents, bots, other apps) read `index.json` first. Find it with `list_artifacts` and `app_path: "index.json"` (also `GET /v1/projects/{id}/files?app_path=index.json` with an API key). Then read each listed file **at its pinned revision** (`read_artifact` takes a `revision`) and check its `sha256`. A reader that arrives during a run sees the old index and the old revisions, never a mix. Every file's metadata carries `app_path` (null for files that are not an app's), so a title match is never needed.

## Backup

A project backup includes app files as ordinary files, each marked `app: { name, path }` (`path` is null for a trashed file; backup schema 3). Restoring or importing makes them ordinary, editable files in your project: title = the path, tag `app:<name>`, no connection to an app. See [operations.md](operations.md#what-backups-cover).

## Limits

See [limits.md](limits.md#app-connect-publishers). One destination per connection; connect again to publish elsewhere. Agent Library adds no encryption of its own (see [architecture.md](architecture.md#how-the-worker-is-built)).

## Not yet

Binary app files and files over 1 MiB (planned through the upload flow); sharing only one app's folder with agents.
