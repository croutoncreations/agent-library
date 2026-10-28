# Connecting agents

Agents connect to your installation's MCP host (`MCP_HOST`). No account with any third-party service, SDK or gateway is required.

## MCP (preferred)

In your client's MCP or connector settings, add a remote server at `https://YOUR_MCP_HOST/mcp`. The client opens a sign-in page: sign in, pick which projects it may use, and choose read-only or edit for each (start with read-only). Give each agent its own connection, and disconnect it under **Connections** when you're done.

ChatGPT, Claude and Cursor work out of the box, as do local clients that use a `127.0.0.1`/`localhost` callback. Another hosted service, such as your own MCP gateway, needs its exact callback URL added to `OAUTH_EXTRA_REDIRECT_URIS` (or `extraRedirectUris` in `.self-host.json`). Wildcards are never accepted.

Tell the agent:

> Use Agent Library for files I should read or edit across devices. Start by listing the projects your connection permits. Keep Markdown as Markdown. Read the current revision before editing, include the expected revision and a fresh idempotency key for each new mutation, and preserve my changes on a conflict. Return the library's human-facing file URL. Do not request broader access or change grants.

Templates: use `list_templates`, inspect a pinned revision with `read_artifact`, then `create_from_template` with an explicit date when required. Fill the independent copy using `save_markdown`. Template definitions are maintained by the owner. See [Document templates](templates.md).

Tools: `list_projects`, `list_artifacts`, `read_artifact`, `read_file`, `create_markdown`, `save_markdown`, `upload_file`, `upload_begin`, `upload_finish`, `artifact_history`, `diff_revisions`, `restore_revision`, `restore_metadata`, `list_templates` and `create_from_template` (plus `read_records` with App Connect enabled). Read-only connections only see the read tools. Clients that can't do remote MCP with OAuth can use the HTTP API below.

### Files

Connections see files (images, PDFs, videos and other uploads), not just documents:

- **List:** `list_artifacts` returns documents and files. Each item has `kind` (files are `binary`), `mime`, `size`, `revision` and `web_url`. Filter with `kind: "binary"` or `mime_prefix` (for example `image/`).
- **Read** (Read access): `read_file` (or `read_artifact` on a file) returns metadata and a `download_url`, for the current version or a given `revision`. PNG, JPEG, WebP and GIF images up to 1 MiB also come back inline as MCP `image` content, so the model can see them. `download_url` is also sent as a `resource_link`. It is a capability for that one version: a plain GET with no Authorization header, Range supported. It expires after 10 minutes and stops working as soon as the connection is revoked or loses the project. It is not a share link; give people `web_url`. Files are served with the same content type, `nosniff` and sandbox CSP as in the app, and HTML or SVG never runs on the app origin.
- **Upload** (Edit access): `upload_begin` with `title` (new file) or `artifact_id` + `expected_revision` (new version; a stale revision gets `revision_conflict`), plus `mime`, exact `size`, `sha256` and a required `change_note`. Then HTTP PUT the raw bytes to the returned `put_url`, a single-upload link that needs no Authorization header and expires with the upload (15 minutes). Then call `upload_finish`, which verifies size, hash and file signature and publishes one version. History shows it with the connection and the note. Limits are the same as everywhere else: 5 MiB per file, the project quota, and the types in the README. Each connection can have one upload open at a time. Retries with the same idempotency key replay.
- **Upload in one call** (Edit access): `upload_file` takes the bytes as `content_base64` (up to 2 MiB decoded) with the same `title` or `artifact_id` + `expected_revision`, `mime` and `change_note`. It runs the same begin/PUT/finish steps on the server, so checks, quotas, history and retries are identical. It is meant for hosted agents that can't make HTTP requests; MCP request bodies for connections with files may be up to 3 MiB for this.
- **Rate limits:** each connection gets 20 changes and 60 reads per minute. Going over returns a tool error the agent can read: code `rate_limited`, `retry_after_seconds`, `limit_per_minute`, and a message saying to wait and retry the same call.

Connections approved before files were offered (including a consent page opened before the upgrade and submitted after it) keep documents only, as their consent page said: files are absent for every tool, including history, diff and restore. Settings → Connections marks them **Documents only**. Reconnect the app to include files.

## HTTP API

Under **Connections → API keys**, create one key per agent or script, with an expiry and read or read/write access to specific projects. The key is shown once. Store it in your agent's secret store, never in Git or a prompt, and send it as `Authorization: Bearer <key>` to `https://YOUR_MCP_HOST/v1`. Keys can only use their projects; they can't manage other keys or connections.

Routes (all under `https://YOUR_MCP_HOST`):

| Route | Methods | |
|---|---|---|
| `/v1/projects` | GET | projects this key can use |
| `/v1/projects/{project}/files` | GET, POST | list or search; create a document |
| `/v1/projects/{project}/files/{file}` | GET, PUT | read; save a new revision (send `expected_revision`) |
| `/v1/projects/{project}/files/{file}/content` | GET | raw bytes or text of a revision |
| `/v1/projects/{project}/files/{file}/text` | GET | a long text document in revision-pinned chunks ([chunked reads](chunked-reads.md)) |
| `…/files/{file}/revisions`, `…/diff`, `…/revisions/{n}/restore` | GET, GET, POST | version history |
| `…/files/{file}/meta-versions`, `…/meta-versions/{n}/restore` | GET, POST | title, folder and tag history |
| `/v1/projects/{project}/folders`, `…/files/{file}/records` | GET (+POST folders) | folders and data records (with App Connect enabled) |

Writes need an `Idempotency-Key` header. Request and response shapes are in `src/api/v1.ts`, and `test/api-v1.test.mjs` has working examples. Don't log request headers.

## Security and conflicts

After connecting a new agent, check that it can't see other projects, that a read-only connection can't write, and that it loses access as soon as you revoke it.

- **Links:** share an artifact's `web_url`, never a token or an upload URL. Uploaded HTML and SVG are never run on your library's origin.
- **Conflicts:** a save based on an old revision gets `409 revision_conflict`. Keep the unsaved text, re-read the current revision and merge.
- **Retries:** retrying a write with the same `Idempotency-Key` returns the original result instead of applying it twice. Use a new key for each new change.
