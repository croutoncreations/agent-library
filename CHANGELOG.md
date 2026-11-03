# Changelog

## Unreleased

- The installed app opens instantly from a cached app shell, even offline or on a slow connection ([docs/offline.md](docs/offline.md)). If this device has offline copies and signing in takes more than 3 seconds, the saved copies open right away. When the connection comes through, a banner offers the live library. Only the app shell (HTML, script, styles, icons) is cached, never library data. Each launch checks a tiny version endpoint (`/shell-version`). The app downloads in the background only when a deploy changed it, and the update takes effect on the next launch.
- Optional review per document ([docs/review-gating.md](docs/review-gating.md)). **Required**: edits by OAuth apps, API keys and agent tokens become proposals that the owner, or an agent the owner allows to review, approves, edits and approves, or rejects; everyone else keeps reading the approved version. **Advisory**: edits go live, and versions can be marked reviewed so agents can read `reviewed: true`. A project default can apply to new documents. New MCP tools `list_proposals`, `read_proposal`, `withdraw_proposal`, `review_proposal`, `review_revision`; `/v1` proposal routes; Home "Needs review", a review screen, a project Review tab, review status on documents and History, and per-connection review permission on the Connections pages. Owner edits and App Connect files are never gated. Backups move to `agent-library-backup/3`. Needs migration `0017` (additive; database triggers keep an older Worker fail-closed on required documents).

## 0.1.0 (2026-10-28)

First open-source release.

- Projects, folders and artifacts (Markdown, HTML, JSON, CSV, images, PDF, video) with immutable version history (who, via which client, why), diff and restore.
- Remote MCP server with OAuth (ChatGPT, Claude, Cursor and local clients), per-connection project scopes and revocation; scoped API keys for the `/v1` HTTP API.
- App Connect: owner-registered apps that store and update only their own files in a chosen project and folder. Apps can suggest a destination (`agentlib_project`, `agentlib_folder`), and owners can set a default per app (migration `0012`).
- Revision-pinned chunked text reads for long documents: `read_artifact` `max_bytes`/`cursor` on both MCP endpoints, `GET /v1/projects/:p/files/:f/text` and the browser API ([docs/chunked-reads.md](docs/chunked-reads.md)).
- Installable browser UI (desktop and phone) behind Cloudflare Access.
- Offline self-host generator (`npm run setup:self-host`) and an optional GitHub deploy pipeline with read-only preflight, additive-only migrations, smoke checks and receipts.
- All installation-specific values come from configuration. New `OAUTH_EXTRA_REDIRECT_URIS` var for trusting extra exact OAuth callbacks (for example your own MCP gateway).
- App Connect generation formats are now `agentlib.generation.index/1` and `agentlib.generation.part/1`. The earlier format names are still accepted.
- Files for MCP connections: agents connected through OAuth can list files (images, PDFs, video) alongside documents, read them (images inline, any file through a 10-minute single-version download link that honours revocation) and, with Edit, upload new files and new versions (`upload_begin` → PUT to a single-upload link → `upload_finish`, with expected revision, idempotency keys and a required change note shown in History). The consent page now says files are included. Connections approved before this keep documents only until reconnected. Needs migration `0013`. Hosted clients that can't make HTTP requests can use `upload_file` (base64, up to 2 MiB). Rate-limited MCP calls now return a readable `rate_limited` tool error with the limit and seconds to wait.
- Browser lists show a file's actual type (PNG image, MP4 video, PDF…) instead of "File", with small thumbnails for images and videos on Home, project lists, search and offline copies. Home adds a Type filter and a Sort by type option, saved with the other Home preferences.
- MIT license, third-party notices and reproducible embedded-editor provenance.
