# Architecture

## Pieces

One Cloudflare Worker (`packages/core/src/index.js`) answers on two hostnames:

- **`APP_HOST` (owner).** The browser UI (an installable PWA), `/api/*` for the UI, and authenticated content and preview routes. The whole host sits behind a Cloudflare Access self-hosted application. The Worker verifies the Access JWT (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`) on every request and requires the verified email to be `OWNER_EMAIL`. It then issues an HttpOnly app session with CSRF protection.
- **`MCP_HOST` (agents and apps).** It serves:
  - OAuth 2.1 (`@cloudflare/workers-oauth-provider`), with protected-resource and authorization-server metadata, dynamic client registration, PKCE S256 and refresh tokens;
  - the Streamable HTTP MCP endpoint `/mcp`;
  - the HTTP API `/v1`, used with API keys, OAuth tokens and App Connect publisher tokens.

  Consent sign-in goes through an Access for SaaS OIDC application (`ACCESS_OIDC_*`), so only the owner can approve a connection.

- **`CONTENT_HOST` (optional; user content).** See [User-content host](#user-content-host).

Storage:

| Binding | Holds |
|---|---|
| D1 `DB` | projects, folders, artifacts, revisions and comments (object keys for new bodies; older bodies may remain inline), principals, grants, API credentials, OAuth connections, publishers, uploads, idempotency records, audit log |
| R2 `BLOBS` (private) | immutable text and binary versions and comment bodies (keys derived from project/artifact/version or comment IDs; never a mutable "latest" key) |
| KV `OAUTH_KV` | OAuth provider state (clients, grants, tokens), consent context |

A `*/15` cron cleans up expired uploads and their staging objects (bounded and idempotent).

## Identities and access

- **Owner:** the one human. Only the owner manages projects, grants, API keys, connected apps and App Connect registrations.
- **Agents**, which connect in one of three ways:
  - **OAuth MCP connection.** For example ChatGPT, Claude or Cursor adding `https://MCP_HOST/mcp`. The owner picks projects and read/write access on the consent page. The connection lasts until it is revoked (access tokens are 15 minutes; refresh slides).
  - **API key** (`alk_…`). Expiring, per-project read or read/write, for scripts and REST clients.
  - **Legacy grant token.** A project-scoped bearer token for `/mcp`.
- **Publishers (App Connect):** apps the owner registers. A publisher can create files and read or update only the files it created, inside one owner-chosen project and folder: file by file by path (App Files, `/v1/app/files`). Every App Files request re-checks the publisher's authorization and is fenced in the same D1 statement that writes; request bodies are at most 1 MiB and are refused from `Content-Length` before they are read. See [app-connect.md](app-connect.md).

Every request re-checks the current grant and project scope. Nothing caches authorization in a way that would delay revocation. API, MCP and App Connect call the same service layer. Every request is authenticated, checked against its grant and project, validated, applied as a revision-guarded mutation and audited.

OAuth redirect URIs are exact-match only:
- the built-in hosted callbacks for ChatGPT, Claude and Cursor;
- loopback URIs for local clients;
- anything listed in the `OAUTH_EXTRA_REDIRECT_URIS` var, for example your own MCP gateway.

## Artifacts and versions

Artifact kinds are `markdown`, `html` (sanitized and rendered sandboxed, never executed on the app origin), `json`, `csv` and `binary` (PNG, JPEG, WebP, GIF, PDF, MP4 and WebM, signature-checked). Every save appends an immutable version. A save must name the expected revision, and on conflict the client keeps the unsaved draft. Mutations carry idempotency keys, so a retried request replays the stored result. Version history records who saved each version (browser, OAuth client, API key or publisher), which client it came through, and an optional change note. Restoring an old version appends a copy of it. See [version-history.md](version-history.md).

Unsaved text in the browser editor (Markdown and HTML documents) is kept in that browser's local storage as you type,
when a save fails, on a conflict and when you leave the page, under the signed-in person, project and document. When
you open the document again, a draft based on the current version is put back into the editor and saved; a draft
based on an older version opens in the conflict view next to the latest text. If your session ends, the draft stays
and is offered again after you sign in as the same person. Signing out removes all drafts from that browser, and
another person signing in removes yours. Drafts are not recovered on another device or browser, and a draft that no
longer fits in the browser's storage for this site is not kept, without a warning; the last draft that fitted stays
instead. JSON and CSV files have no editor and no drafts.

Binary uploads go through `upload_begin`, then an authenticated PUT of the bytes, then `upload_finish`. PUT streams once to its fixed immutable key; finish verifies size, SHA-256 and the file signature without moving or rewriting the object. Published upload objects cannot be overwritten through the upload endpoints. The app API, `/v1` and both MCP transports (`upload_begin`) also accept text uploads: finish validates UTF-8 and publishes through the ordinary text writer. OAuth (MCP) connections use the same flow; their `put_url` and file `download_url` are short-lived single-purpose links on the MCP host (`/files/u/…`, `/files/d/…`, stored hashed in `transfer_links`, migration `0013`), re-authorized against the live connection on every request. See [upload-finalization.md](upload-finalization.md).

New Markdown, HTML, JSON and CSV versions live in immutable R2 objects at `text/{project}/{artifact}/{revision}`;
D1 keeps `revisions.body = NULL` and `body_key` names the object. Versions written before text moved to R2 stay
inline in D1 and are read where they are: all JavaScript version reads go through `getText` or `getTextRange`
(`packages/core/src/content-store.js`), which fall back to the inline body. New comments are stored the same way at
`text/{project}/{artifact}/{comment}` (`comments.body = ''`). Only older versions and comments may still hold inline bodies.

Text writes record a `content_writes` intent before the object is written, and the publication batch clears it. Every
text publication batch first asserts that each of its intents still exists and is at most ten minutes old; otherwise
the whole batch rolls back with a retryable `503 text_write_expired`. The cron sweeps intents older than one hour,
deleting their unreferenced R2 objects before the rows; the sweep never deletes an object that a version or comment
refers to. Restore keeps revision ids but adds a random attempt segment to each text key, so a retry never overwrites
another attempt's objects.

Every artifact has a stable owner URL: `https://APP_HOST/p/<project>/a/<artifact>` (add `?v=N` for a specific version). MCP and API responses include it, so agents can hand links to people or to each other.

## User-content host

Server rendering has [separate limits](limits.md#documents--files): larger Markdown previews show the first 256 KiB, cut back to a nearby line break; HTML pages over 1 MiB are not rendered in the app or through view links (including existing links). A cut-off preview is still useful but a cut-off page is not, and the Markdown renderer costs more memory per byte. Editing, download, history and agent reads still work up to 10 MiB.

Uploaded HTML documents and PDFs are written by agents and other people, so they are never run on the app's origin.
Without `CONTENT_HOST`, HTML pages are sanitized and shown in a sandboxed frame with `script-src 'none'` on the app
host, and PDFs open there as sandboxed attachments. With `CONTENT_HOST` set to a hostname on a **different registrable
domain** (for example `usercontent.example.net`, the googleusercontent.com pattern), a person's browser gets them from
that site instead, so a browser bug in rendering them can't reach the app's cookies, storage or same-site requests:

- When the app's preview frame (or a tab opening a PDF with `?open=1`) navigates to `/render` or `/content`, the app
  host checks access as usual and answers `302` to `https://CONTENT_HOST/c/<link>`. The link (`view_links`, migration
  0026) names one revision of one document, the session that asked for it and its person; only its SHA-256 is stored.
  It lasts 5 minutes for a page (the frame asks for a new one each time it opens) and 30 minutes for a PDF tab (the
  viewer's range requests reuse it).
- Every request to the content host re-checks that the session hasn't been signed out or expired and that its person
  can still read the project (removed members, deleted projects and suspended-workspace rules apply at once), with the
  same rate limits. Images and videos the page shows are served through the same link (`/c/<link>/m/<file>`): only
  files that revision references, from that project.
- **Limits.** A link works for whoever holds it until it expires, like a signed URL: a PDF tab's address copied to
  someone else gives them that one PDF, as its creator, for the rest of the 30 minutes. The sign-in provider's own
  check (self-host: the Access JWT) runs when the link is issued, not on the content host, which never sees that
  provider's cookies; signing out of the app ends the link at once.
- The content host has no app: no sign-in, API, MCP or cookies; anything else is `404`. Rendered pages keep the strict
  CSP and sandbox and may be framed only by `APP_HOST` (`frame-ancestors`).
- `fetch()` callers (the offline copy reads the rendered page with `Sec-Fetch-Dest: empty`), agents and browsers that
  don't send `Sec-Fetch-Dest` get the app-host response as before. Downloads (`?download=1`) and images stay on the
  app host.

To turn it on: add the hostname to the Worker's routes (a custom domain on its own zone; **not** behind Cloudflare
Access, since the frame can't carry an Access sign-in) and set `CONTENT_HOST`. It is ignored if it equals `APP_HOST`
or `MCP_HOST`, and needs `APP_HOST` set (pages may only be framed by it). Rolling back to a Worker without it serves
everything from the app host again.

## How the Worker is built

The Worker is ordinary ES modules in two packages. `packages/core/src/` holds everything that decides who can see what (service layer, authorization, workspaces, MCP, OAuth, App Connect, UI, migrations). `packages/self-host/src/` is the thin self-hosted entry: `createWorker({ identity: accessIdentity })`, with Cloudflare Access as the sign-in provider. That entry is what gets built. `npm run build` bundles them with the pinned esbuild into one module, `dist/worker/index.js`, which the deploy pipeline and the self-host setup upload unchanged (`no_bundle`). `npm run dev` and the test servers build first and run that same file under `wrangler dev` (`wrangler.local.toml` sets `no_bundle`). Nothing generated is committed.

- `packages/core/src/web/*.txt` are the browser assets (UI shell, styles, app script, Home loader, prebuilt CodeMirror editor). They are imported as text and served verbatim; `app.js.txt` has three build-free placeholders filled in `packages/core/src/ui.js`.
- `packages/core/src/service.js` is the shared service layer used by the browser API, `/v1`, MCP and App Connect. Focused modules split from it: `search/`, `changes/`, `reads/`, `history/`, `templates/`.
- `packages/core/src/content-store.js` is the only module that touches R2 (`BLOBS`). Stored data relies on Cloudflare's at-rest encryption for D1 and R2; Agent Library adds no encryption of its own.
- `packages/core/src/oauth/` is the OAuth server, consent pages and MCP-over-OAuth; `packages/core/src/api/` holds `/v1`, API keys, app clients and the publisher API.

`npm run check:bundle` builds twice in fresh directories and fails if the outputs differ, if the bundle imports anything but `cloudflare:workers`, or if an installation-specific value appears. The editor bundle's provenance is checked separately (`npm run check:editor`).

The modules were recovered mechanically from the previous byte-pinned bundle (Phase 0 of the hosted plan). The existing test suite passed on the old bundle and passes on this build; test servers run the built `dist/worker/index.js` itself (`wrangler.local.toml` uses `no_bundle`).

### Packages and adapters

`createWorker(adapters)` (`packages/core/src/index.js`) returns the Worker's `fetch`/`scheduled` handlers with the installation's adapters attached to `env` (`packages/core/src/adapters.js`). Every adapter is optional; the defaults are below.

| Adapter | Self-host | Hosted (private repo) | Default |
|---|---|---|---|
| `identity`: `login`, `session`, `bearer`, `multiUser`, `upstream`, `browserSignIn`, `createAccounts`, `linkSoleOwner`, `linkVerifiedEmail` | Cloudflare Access (`packages/self-host/src/access-identity.js`): one owner, single-user; or any OpenID Connect provider when `OIDC_ISSUER` is set (`packages/core/src/identity/oidc-identity.js`) | Supabase PKCE sign-in, and Google directly through core's OIDC client (private repo; decision D15 A); opts in to `linkVerifiedEmail` | No provider: local dev sign-in only, multi-user |
| `entitlements.check(env, op, info)` | Unlimited | Plan limits (throws 402) | Unlimited |
| `entitlements.limits(env, {workspaceId} \| {principalId})` | None | `planEntitlements` (`PLAN_LIMITS`; [limits.md](limits.md)) | None |
| `lifecycle`: `workspaceCreated`, `workspaceDeleted`, `inviteCreated` | None | Billing customer, invitation email | None |
| `routes`: `{ method?, path, handler }` | None | Billing, sign-up, legal pages | None |
| `mailer.send` | Logs only | Not used (invitation email is sent by `lifecycle.inviteCreated`, SendGrid) | Logs only |

Not yet adapters (deferred from the plan's interface list): an external `AuditSink`/metrics (phase 5; audits stay in D1), UI slots such as settings tabs (phase 3/4, with the hosted billing UI) and a `workspaceSuspended` hook (core has no suspend operation yet). Core doesn't call `mailer` yet; hosted mail is sent from lifecycle hooks. The plan's `createWorker(config, adapters)` became `createWorker(adapters)`: configuration stays in Worker vars.

Sign-in by redirect (`packages/core/src/identity/`): `GET|POST /auth/signin` starts it (PKCE S256, nonce, state; the transaction is bound to the browser by an HttpOnly cookie and kept in KV for 10 minutes, single use), `GET /auth/callback` finishes it, and `GET /auth/methods` tells the browser app which sign-in screen to show. `identity/accounts.js` maps a verified identity to a person for both browser sign-in and the agent consent sign-in: an existing link, the sole owner (only for owner-only upstreams such as Access for SaaS), or a new account with a personal workspace when the adapter allows sign-up (verified email; `SIGNUP_ALLOWLIST`; invited emails always). Provider claims never grant access. Starting a sign-in is rate limited per IP (`RATE_SIGNIN_PER_MIN`, default 20) and email links also per IP (`RATE_SIGNIN_EMAIL_PER_MIN`, default 5) and per address (`RATE_SIGNIN_EMAIL_PER_ADDRESS_PER_MIN`, default 2), each times `OAUTH_RATE_MULTIPLIER`. Email-link providers create a provider-side user only for addresses that could create an account. Optional human check on email links: set `TURNSTILE_SITE_KEY` (var) and `TURNSTILE_SECRET_KEY` (secret) and every email-link request, on the app and on the consent page, needs a token Cloudflare's siteverify accepts, checked before anything is counted, stored or sent (a site key without its secret refuses rather than skipping the check). Only then do the app shell and the consent page allow `https://challenges.cloudflare.com` in `script-src`/`frame-src`. Provider buttons don't need it. On https the session cookie is `__Host-al_session` (no sibling subdomain can set or overwrite it); the plain `al_session` is still read for sessions issued before this, and is the name on http (local dev).

The wiring fails closed: core code throws if `env` didn't come through `createWorker()`, and a build with no sign-in provider refuses requests where `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` is set. An enabled identity provider must return the current identity on every cookie request; `null` is refused.

Rules: adapters never decide access to content (that stays in core's SQL gates). Extra routes are tried only after every core route missed, so they can't shadow one; under `/api/` they run after authentication, CSRF and rate limiting, get the authenticated `ctx`, and refuse agent credentials unless the route sets `agents: true`. Routes outside `/api/` get no authentication or CSRF check (only the cross-origin check), so a route that reads the session cookie must check CSRF itself. Core forces its framing, sniffing and referrer protection onto every adapter response; RegExp paths can't use the `g` or `y` flag. Entitlement checks run before anything is written. Lifecycle hooks run after the change is committed; a failing or slow hook (cut off after 5 s) is logged by error name only, without undoing the change. Hook arguments can include an invitation's one-time link, so hooks must not log them. Entitlement checks are not atomic with the write; count-based plan limits that must hold under concurrency belong inside the statement (phase 4). `MULTI_USER=1`/`0` still overrides the identity adapter's single/multi-user answer.

## Configuration

Nothing installation-specific is compiled in. Each installation sets these Worker vars:
- `APP_HOST` and `MCP_HOST`;
- `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` and `OWNER_EMAIL`;
- `ACCESS_OIDC_ISSUER` and `ACCESS_OIDC_CLIENT_ID` (with the `ACCESS_OIDC_CLIENT_SECRET` Worker secret);
- `APP_CONNECT_ENABLED`;
- optionally, `OAUTH_EXTRA_REDIRECT_URIS` and `CONTENT_HOST`.

Limits (sizes, counts, rate limits, upload TTLs, retention) have defaults and optional vars. See [Limits](limits.md) and [wrangler.example.toml](../wrangler.example.toml).

## Ranked search

[Ranked search](ranked-search.md) adds a contentless D1 FTS5 index (inverted index only: titles and text are not stored in D1; text lives in R2) over current published heads, written in the same batch as every change by one module (`search/indexing.js`) and rebuilt from R2 by the cron, live permission filtering, opaque query-bound pagination, a Home search view, `/api/search`, `/v1/search` and the `search_artifacts` MCP tool. Sources: `packages/core/src/search/`.

## Templates

Project-scoped Markdown templates reuse artifact revisions and metadata history; identity and copy provenance are additive fields. Owner-only definition maintenance is enforced in the shared service and transaction fences. Both MCP transports, /v1 and the owner picker use the same implementation (`packages/core/src/templates/`). See [Document templates](templates.md) for date/retry semantics, /2 backup compatibility and rollback notes.

## File types

File types in the browser UI (`packages/core/src/web/app.js.txt`, `packages/core/src/web/home.js.txt`): lists label files by their stored MIME type ("PNG image", "MP4 video", "PDF"), Home can filter and sort by type, and list rows show small thumbnails for images and videos. Thumbnails are drawn in the browser from the revision-pinned `/content` URL, lazily and within a per-minute budget, kept as 96px object URLs for the session and dropped on sign-out. The owner list route adds `mime` only with `?include=mime`, and owner search adds it for human sessions only, so MCP, `/v1` and default `/api` shapes are unchanged. No migration.
