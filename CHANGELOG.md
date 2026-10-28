# Changelog

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
- MIT license, third-party notices and reproducible embedded-editor provenance.
