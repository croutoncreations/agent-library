# Self-hosting on Cloudflare

This guide sets up your own Agent Library in your Cloudflare account. It's written for you and a coding agent to work through together. The agent prepares files and commands; you create resources in the dashboard, enter secrets and approve anything that changes your account.

> **Agents:** do the steps in order and confirm each one with the user. Never ask the user to paste a secret into chat. Secrets go directly into `wrangler secret put` prompts. Put all identifiers in `.self-host.json` (gitignored). Don't create, delete or change Cloudflare resources the user didn't ask for. If something looks missing, stop and ask.

What you'll end up with:
- `https://library.YOUR-DOMAIN`: your library UI, gated by Cloudflare Access (only you can sign in).
- `https://library-mcp.YOUR-DOMAIN`: where agents connect (`/mcp`) and apps call the API (`/v1`).

Cost: Workers, D1, R2 and KV all have free tiers that comfortably cover one person's library. Check Cloudflare's current limits for your account.

## 0. Prerequisites

- A Cloudflare account with a domain (zone) on it.
- Node 24 (see `.node-version`) and npm.
- A clone of this repo with `npm ci` run. Use the pinned Wrangler through `npx wrangler` or `npm exec -- wrangler`, not a global or `@latest` one.
- `npx wrangler login` (or a scoped API token in your shell). `npx wrangler whoami` should show the right account. Note your **account ID**.

## 1. Create storage

Pick a short name, for example `agent-library`. Then:

```sh
npx wrangler d1 create agent-library-db             # note the database_id (UUID)
npx wrangler kv namespace create agent-library-oauth # note the namespace id (32 hex)
npx wrangler r2 bucket create agent-library-blobs
```

Keep the R2 bucket **private**. Don't enable an r2.dev URL or a custom domain for it. The Worker serves all bytes itself, after checking access.

## 2. Choose two hostnames

You need two different hostnames in your zone, for example:
- `library.example.com` (`appHost`): the owner UI;
- `library-mcp.example.com` (`mcpHost`): for agents and apps.

You don't need to create DNS records. The deploy attaches both as Worker custom domains.

## 3. Owner sign-in: a Cloudflare Access application

In Zero Trust → Access → Applications → *Add an application* → **Self-hosted**:
- Domain: your `appHost` (the whole host, all paths).
- Policy: Allow, with Include → Emails → your email only.
- Identity: any login method (one-time PIN by email works).

After you save it, copy the **Application Audience (AUD) tag** (`accessAudience`). Your **team domain** is `YOUR-TEAM.cloudflareaccess.com` (`accessTeamDomain`), under Zero Trust → Settings → Custom pages / Team domain.

Do **not** put an Access application in front of `mcpHost`. Agents must reach its OAuth discovery, token, `/mcp` and `/v1` endpoints directly. Those endpoints enforce their own OAuth or API-key authentication and per-project authorization.

## 4. Agent consent sign-in: an Access for SaaS (OIDC) application

When an agent connects, you approve it on a consent page. Signing in to that page uses a second Access application:

Zero Trust → Access → Applications → *Add an application* → **SaaS** → choose **OIDC**:
- Redirect URL: `https://YOUR-MCP-HOST/callback`.
- Policy: the same as above (only your email).

Copy the **Client ID** (`oidcClientId`) and **Issuer** (`oidcIssuer`, which looks like `https://YOUR-TEAM.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client id>`). Also copy the **Client secret**, but keep it out of any file. You'll enter it in step 6.

See Cloudflare's [generic OIDC SaaS guide](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/saas-apps/generic-oidc-saas/) if the dashboard differs.

## 5. Generate your config

```sh
cp scripts/self-host/example.json .self-host.json
```

Fill in `.self-host.json`:

| Field | From |
|---|---|
| `workerName` | your choice, e.g. `agent-library` |
| `accountId` | `wrangler whoami` |
| `databaseName`, `databaseId` | step 1 (D1) |
| `kvNamespaceId` | step 1 (KV) |
| `bucketName` | step 1 (R2) |
| `appHost`, `mcpHost` | step 2 |
| `accessTeamDomain`, `accessAudience`, `ownerEmail` | step 3 |
| `oidcClientId`, `oidcIssuer` | step 4 |
| `extraRedirectUris` (optional) | exact https OAuth callbacks to trust besides ChatGPT, Claude and Cursor, e.g. your own MCP gateway |

Then:

```sh
npm run setup:self-host -- --input .self-host.json --dry-run   # validate only
npm run setup:self-host -- --input .self-host.json             # writes dist/self-host/
```

The generator works offline. It validates the fields (it rejects unknown keys, so a secret can't end up in the file) and writes `dist/self-host/`:
- `wrangler.json`;
- the Worker (`worker/index.js`, a byte-for-byte copy of `dist/worker/index.js`, which the generator builds from `packages/core/src/` with `npm run build`);
- all migrations;
- a `manifest.json` with hashes.

It refuses to overwrite an existing output directory. For upgrades, use `--out dist/self-host-NEXT`.

Optional local check (no account access):

```sh
npx wrangler deploy --config dist/self-host/wrangler.json --dry-run --outdir dist/self-host-upload
npx wrangler d1 migrations apply DB --config dist/self-host/wrangler.json --local
```

## 6. Deploy (changes your account)

```sh
npx wrangler secret put ACCESS_OIDC_CLIENT_SECRET --config dist/self-host/wrangler.json   # paste the step 4 secret at the prompt
npx wrangler d1 migrations apply DB --config dist/self-host/wrangler.json --remote
npx wrangler deploy --config dist/self-host/wrangler.json
```

For a brand-new Worker, `secret put` may offer to create it first. That's expected. Stop if anything unexpected comes up, such as a different account, a billing prompt or another resource.

## 7. Check it works

1. Open `https://YOUR-APP-HOST` and sign in through Access. You should land in an empty library. A private window with a different email should be denied.
2. Create a project and a Markdown document. Edit it on your phone too.
3. Connect an agent ([agent-setup.md](agent-setup.md)): add `https://YOUR-MCP-HOST/mcp` as a remote MCP server. Approve one project read-only, ask the agent to list files, and confirm it can't write or see other projects. Then revoke it under Settings → Connections and confirm it loses access.
4. Upload an image or PDF and download it again.

If sign-in fails, check the Access audience, team domain, owner email, OIDC client ID, issuer and secret, and the exact `/callback` URL. Don't work around a failure by widening Access policies or disabling checks.

## Alternative: a hand-written wrangler.toml

If you prefer, copy `wrangler.example.toml` to `wrangler.toml` (gitignored), fill in the `[env.hosted]` section, run `npm run stage:hosted`, and pass `--env hosted` to every wrangler command. This is the layout the optional [deploy pipeline](deploy-pipeline.md) uses.

## Sign in with OpenID Connect

By default one person signs in, through Cloudflare Access (`OWNER_EMAIL`). To let several people sign in (shared workspaces, invitations), point the installation at an OpenID Connect provider you already use (Auth0, Okta, Keycloak, Google, Cloudflare Access for SaaS, ...) instead:

1. Create a confidential "web" client at the provider with the callbacks `https://<APP_HOST>/auth/callback` (browser sign-in) and `https://<MCP_HOST>/callback` (connecting ChatGPT, Claude and other agents), scopes `openid email`, PKCE allowed.
2. Set `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_AUTHORIZATION_URL`, `OIDC_TOKEN_URL` and `OIDC_JWKS_URL` (from the provider's `/.well-known/openid-configuration`), and the secret `OIDC_CLIENT_SECRET`. Remove `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` and the Access application in front of `APP_HOST`: the app signs people in itself.
3. Decide who can create an account: `SIGNUP_ALLOWLIST` (comma-separated emails or `@domain`s) or `SIGNUP_OPEN = "1"`. With neither, only people you invite can join. Invited people can always create their account. The provider must report a verified email: `email_verified` must be `true` in the ID token. For a provider that only ever issues verified addresses but never sends that claim, set `OIDC_TRUST_EMAIL = "1"`; never do this for providers that let people change their email freely (for example multi-tenant Entra ID), because the email decides sign-up and invitations.

**Switching an existing installation from Access to OIDC:** accounts are keyed by the sign-in provider's user ID, never matched by email, so your first OIDC sign-in creates a new, empty account. To keep your data, export each project before switching and import it into your new workspace afterwards (`Workspaces → Import`).

Signing in only proves who someone is. What they can see comes from their workspace memberships, never from the provider's claims. Tokens are checked against the provider's keys (RS256 or ES256), issuer, audience, expiry and the per-sign-in nonce, and a sign-in only completes in the browser that started it.

## Upgrading

Pull a new release. Regenerate the config into a new directory, apply any new migrations, then deploy. See [operations.md](operations.md) (including restore's `store_not_empty` note: if a restore answers 409 after you started it on an empty store, reload and check your projects before retrying). Migrations are additive, so the previous Worker keeps working if you need to roll back. Worker rollback does not undo migrations.

### Upgrading from 0.1.x

This release adds migrations `0018` to `0033` (0.1.0 shipped `0001` to `0013`; public `main` before this release had `0001` to `0017`, which are byte-identical here and never edited). Everything is additive except **`0031_search_contentless.sql`**, which drops the derived search index and its triggers and recreates it as a contentless table. It carries an `owner-approved-destructive` marker, so the deploy pipeline refuses to apply it and a person must run it. It loses no documents: the index is rebuilt from stored text.

1. **Back up** the projects you care about, and note the current Worker version ID ([operations.md](operations.md#upgrade)).
2. **Manual window for 0031** (pipeline users, per [deploy-pipeline.md](deploy-pipeline.md#destructive-migrations): record a D1 Time Travel bookmark first; hand-run installations can do the same). `npx wrangler d1 migrations apply DB --config <your config> --remote` applies `0018` to `0032` in order. Then deploy the new Worker straight away (pipeline users: push to `main` afterwards; the preflight sees the migration as applied).
3. **Search is unavailable until the cron has rebuilt the index.** Search answers `503 search_initializing` and Home hides the search entry. The cron (every 15 minutes) re-indexes 15 documents per run from R2 or legacy inline text and then turns search on; nothing is run by hand ([ranked-search.md](ranked-search.md#required-infrastructure--rollout)). Allow about one run per 15 documents.
4. **App Connect apps must resync.** `/v1/publisher/*` (snapshots, staged generations, upload slots, `GET /publisher/me`) is removed with no replacement; apps use `/v1/app` and `/v1/app/files/{path}` ([app-connect.md](app-connect.md)). An existing connection keeps working: its tokens and refresh tokens still authenticate on `/v1/app`, and the files it published are now ordinary App Files under their old names (`measurements.json`, `measurements.csv`, and the old snapshot `manifest.json` as one more file), with their bytes and hashes unchanged and still protected from edits by anyone but the app. The app has to stop calling snapshot routes (they answer 404) and write files itself; it can replace the old files with `If-Match` set to their `sha256`.
5. **Worker vars.** Nothing is required. New optional vars are listed with defaults in `wrangler.example.toml`: `PROJECT_ARTIFACT_LIMIT` (documents and files per project, default 1,000), `FILE_MAX_BYTES`, `PROJECT_BINARY_BYTES`, `RATE_*`, `AUDIT_RETENTION_DAYS`, `UPLOAD_TTL_SECONDS`, `DB_SIZE_WARN_BYTES`, `CONTENT_HOST`, and for several people `MULTI_USER` and the `OIDC_*`, `SIGNUP_*` and `TURNSTILE_*` vars (single-owner installations behind Access need none). Pipeline users add a new var through `pendingVars`. **Removed:** `PROJECT_ITEMS_MAX`, which only development builds read and no public release ever did, is no longer read; use `PROJECT_ARTIFACT_LIMIT`. The per-project document cap was a fixed 100 in 0.1.x; it now defaults to 1,000. The Worker is now built from `packages/` into `dist/worker/index.js` (`main` in the generated config); regenerate your config as usual.
6. **Backups.** A project export is schema `agent-library-backup/1`, `/2` (with templates) or `/4` (when it holds review data, App Connect files or folders: files carry `app: { name, path }`, documents `folder_name`; see [review-gating.md](review-gating.md)). 0.1.0 refused to export a project with app files; this release does not. Import and restore accept `/1` to `/4`, including exports made by 0.1.0. A 0.1.x Worker refuses a `/4` export rather than dropping its data.
7. **Check** that you can sign in, an agent can read and write, an API key and an MCP connection still work, and search comes back after the cron runs.

**What the upgrade test found.** `test/upgrade-from-0.1.test.mjs` seeds synthetic libraries through the real APIs of `v0.1.0` and of public `main` at `2bac798` (Markdown and HTML with versions and change notes, PNG and PDF uploads, comments, a template on `main`, a trashed document, an API key, a legacy agent token, an MCP OAuth connection and an App Connect app with a published snapshot), applies this branch's migrations including `0031` to the same local state and starts this Worker on it. After the upgrade every version's bytes and hash, the history (who, how, why), comments, templates, trash, file downloads (and Range), the API key, the legacy token, the OAuth connection (including a refresh) and the publisher's files are intact, search finds the old documents once the cron has run, and an export imports. It exercised local dev login, not Cloudflare Access or a real identity provider, and not a real app connector.

**Rolling back the Worker after the upgrade** (the test runs the old Worker on the new schema):
- Works: reading and saving documents, creating documents, comments, un-trashing, downloading files, API keys, project-list text filter, and moving forward again. This Worker then finds the rolled-back writes and re-indexes them.
- Does not work: **search**. `0031` removed the old index, so a rolled-back 0.1.0 has none (it never had search) and a rolled-back `main` answers `503` until you go forward again. Documents written meanwhile are not indexed by the old Worker; the new Worker's cron picks them up. Project exports of a project that holds app files are refused by both old Workers (`409 backup_unsupported`). Text written by this Worker is kept in R2 (migration `0028`) and reads as empty to an older Worker, so it can show an empty document and a save from it would store empty text: treat a rolled-back library as read-only ([operations.md](operations.md#rollback)). Fix forward instead of rolling back where you can.
