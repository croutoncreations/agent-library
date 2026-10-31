# Architecture

## Pieces

One Cloudflare Worker (`src/index.js`) answers on two hostnames:

- **`APP_HOST` (owner).** The browser UI (an installable PWA), `/api/*` for the UI, and authenticated content and preview routes. The whole host sits behind a Cloudflare Access self-hosted application. The Worker verifies the Access JWT (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`) on every request and requires the verified email to be `OWNER_EMAIL`. It then issues an HttpOnly app session with CSRF protection.
- **`MCP_HOST` (agents and apps).** It serves:
  - OAuth 2.1 (`@cloudflare/workers-oauth-provider`), with protected-resource and authorization-server metadata, dynamic client registration, PKCE S256 and refresh tokens;
  - the Streamable HTTP MCP endpoint `/mcp`;
  - the HTTP API `/v1`, used with API keys, OAuth tokens and App Connect publisher tokens.

  Consent sign-in goes through an Access for SaaS OIDC application (`ACCESS_OIDC_*`), so only the owner can approve a connection.

Storage:

| Binding | Holds |
|---|---|
| D1 `DB` | projects, folders, artifacts, revisions (Markdown text inline), comments, principals, grants, API credentials, OAuth connections, publishers, uploads, idempotency records, audit log |
| R2 `BLOBS` (private) | immutable binary versions (keys derived from project/artifact/version IDs; never a mutable "latest" key) |
| KV `OAUTH_KV` | OAuth provider state (clients, grants, tokens), consent context |

A `*/15` cron cleans up expired uploads and their staging objects (bounded and idempotent).

## Identities and access

- **Owner:** the one human. Only the owner manages projects, grants, API keys, connected apps and App Connect registrations.
- **Agents**, which connect in one of three ways:
  - **OAuth MCP connection.** For example ChatGPT, Claude or Cursor adding `https://MCP_HOST/mcp`. The owner picks projects and read/write access on the consent page. The connection lasts until it is revoked (access tokens are 15 minutes; refresh slides).
  - **API key** (`alk_…`). Expiring, per-project read or read/write, for scripts and REST clients.
  - **Legacy grant token.** A project-scoped bearer token for `/mcp`.
- **Publishers (App Connect):** apps the owner registers. A publisher can create files and read or update only the files it created, inside one owner-chosen project and folder. See [app-connect.md](app-connect.md).

Every request re-checks the current grant and project scope. Nothing caches authorization in a way that would delay revocation. API, MCP and App Connect call the same service layer. Every request is authenticated, checked against its grant and project, validated, applied as a revision-guarded mutation and audited.

OAuth redirect URIs are exact-match only:
- the built-in hosted callbacks for ChatGPT, Claude and Cursor;
- loopback URIs for local clients;
- anything listed in the `OAUTH_EXTRA_REDIRECT_URIS` var, for example your own MCP gateway.

## Artifacts and versions

Artifact kinds are `markdown`, `html` (sanitized and rendered sandboxed, never executed on the app origin), `json`, `csv` and `binary` (PNG, JPEG, WebP, GIF, PDF, MP4 and WebM, signature-checked). Every save appends an immutable version. A save must name the expected revision, and on conflict the client keeps the unsaved draft. Mutations carry idempotency keys, so a retried request replays the stored result. Version history records who saved each version (browser, OAuth client, API key or publisher), which client it came through, and an optional change note. Restoring an old version appends a copy of it. See [version-history.md](version-history.md).

Binary uploads go through `upload_begin`, then an authenticated PUT of the bytes, then `upload_finish`. Finish verifies the size and SHA-256 and moves the object to a final immutable key before publishing a version. A presigned URL can never overwrite a published version. OAuth (MCP) connections use the same flow; their `put_url` and file `download_url` are short-lived single-purpose links on the MCP host (`/files/u/…`, `/files/d/…`, stored hashed in `transfer_links`, migration `0013`), re-authorized against the live connection on every request. See [upload-finalization.md](upload-finalization.md).

Every artifact has a stable owner URL: `https://APP_HOST/p/<project>/a/<artifact>` (add `?v=N` for a specific version). MCP and API responses include it, so agents can hand links to people or to each other.

## How `src/index.js` is built

The deployable Worker is a committed, byte-pinned bundle. `npm run build:design` produces it from `baseline/index.js` through a chain of small build steps (`build-*.mjs`). Each step replaces exact, hash-pinned regions with maintained sources:
- `src/web/*` for the UI;
- `src/render/markdown.module.js`;
- `src/api/publisher.ts` and `generations.ts`;
- `src/history/*`;
- `src/web/connect-pages.js`;
- `src/upload-fixes/*`;
- `src/oauth-renewal/*`;
- `src/file-tools/*` (files for OAuth connections, `build-file-tools-fixes.mjs`, the last step).

Each step must leave every other byte unchanged and records hashes in a `*-preservation.json` manifest. CI's `npm run check:bundle` rebuilds in a temporary copy and fails on any difference. Because of this, every change to what ships is a reviewable source diff, and the shipped bytes are reproducible.

Most of `src/**/*.ts` is an older snapshot of the code `baseline/index.js` was built from. It typechecks and documents intent, but it does not rebuild the Worker. Moving to a conventional build from TypeScript is planned future work.

## Configuration

Nothing installation-specific is compiled in. Each installation sets these Worker vars:
- `APP_HOST` and `MCP_HOST`;
- `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` and `OWNER_EMAIL`;
- `ACCESS_OIDC_ISSUER` and `ACCESS_OIDC_CLIENT_ID` (with the `ACCESS_OIDC_CLIENT_SECRET` Worker secret);
- `APP_CONNECT_ENABLED`;
- optionally, `OAUTH_EXTRA_REDIRECT_URIS`.

Rate limits and upload TTLs have defaults and optional vars. See [wrangler.example.toml](../wrangler.example.toml).

## Ranked search

[Ranked search](ranked-search.md) adds a D1 FTS5 index over current published heads, live permission filtering, opaque query-bound pagination, a Home search view, `/api/search`, `/v1/search` and the `search_artifacts` MCP tool. Maintained sources in `src/search/` are integrated by the preservation-checked final `build-search.mjs` step. Rollout requires migration 0014 and a bounded existing-data backfill; see the guide for export/rollback considerations.

## Templates

Project-scoped Markdown templates reuse artifact revisions and metadata history; identity and copy provenance are additive fields. Owner-only definition maintenance is enforced in the shared service and transaction fences. Both MCP transports, /v1 and the owner picker use the same implementation, integrated by `build-template-fixes.mjs`. See [Document templates](templates.md) for date/retry semantics, /2 backup compatibility and rollback notes.

## File types

File types in the browser UI (`src/file-types/`, integrated by the final `build-file-types.mjs` step): lists label files by their stored MIME type ("PNG image", "MP4 video", "PDF"), Home can filter and sort by type, and list rows show small thumbnails for images and videos. Thumbnails are drawn in the browser from the revision-pinned `/content` URL, lazily and within a per-minute budget, kept as 96px object URLs for the session and dropped on sign-out. The owner list route adds `mime` only with `?include=mime`, and owner search adds it for human sessions only, so MCP, `/v1` and default `/api` shapes are unchanged. No migration.
