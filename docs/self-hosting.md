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
- the Worker (`worker/index.js`, a byte-for-byte copy of the committed `src/index.js`);
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

## Upgrading

Pull a new release. Regenerate the config into a new directory, apply any new migrations, then deploy. See [operations.md](operations.md). Migrations are additive, so the previous Worker keeps working if you need to roll back. Worker rollback does not undo migrations.
