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

Rules that apply to every call:
- Every mutation takes an `Idempotency-Key`. Retries replay the stored result.
- Snapshots use a monotonic `source_revision`, plus an optional compare-and-swap on the current snapshot.
- Files are JSON or CSV. An optional schema (`agentlib.measurements/1`) validates time-series records.
- For staged generations, the root must be an `agentlib.generation.index/1` document that references every part. Each part is an `agentlib.generation.part/1` document. The legacy names `healthconnect.readable.index/1` and `healthconnect.readable.part/1` are still accepted.

The exact request and response shapes are in `src/api/publisher.ts` and `src/api/generations.ts`. Working examples are in `test/app-connect-phase2.test.mjs`, `test/app-connect-phase3.test.mjs`, `test/generations-regression.test.mjs` and the harness `test/fixtures/app-connect-harness.mjs`.

## Current limits

- **Formats.** Publishers write JSON and CSV only. Markdown and binary publishing are planned.
- **Backup.** The built-in project backup doesn't yet cover projects that contain App Connect files (`backup_unsupported`). See [operations.md](operations.md#supported-release-scope).
- **One destination.** Each connection writes into one project and folder. To publish somewhere else, connect again (a new publisher).

## Roadmap toward "app data folder" parity

1. **Any artifact kind for publishers.** Markdown, HTML and binary uploads through the same file APIs agents use, scoped to the publisher's own files.
2. **Simple per-file CRUD** alongside snapshots and generations, for apps that just want to save and load documents.
3. **Owner "share with agents" from the app folder.** Today agents see app files through their project grant. A per-folder grant would let you share only one app's folder.
4. **Publisher-aware backup and restore** that preserves source protection.
