# Agent instructions

Agent Library is a self-hosted home for everything your agents make: one Cloudflare Worker (UI, HTTP API, Streamable HTTP MCP and OAuth) on D1, private R2 and KV. See [README.md](README.md) for the product, and [docs/architecture.md](docs/architecture.md) for how it fits together.

**If `AGENTS.local.md` exists, read it first.** It holds the operator's installation-specific rules (their production, accounts, deploy approvals). It is gitignored and its rules take precedence over this file.

## Two kinds of task

1. **Setting up an installation for a user.** Follow [docs/self-hosting.md](docs/self-hosting.md) step by step. The user creates Cloudflare resources and enters secrets themselves; you prepare config and commands, and explain each account-changing step before it runs. Never paste, print or store secrets (`ACCESS_OIDC_CLIENT_SECRET`, API tokens). Put the installation's config in gitignored files only (`.self-host.json`, `wrangler.toml`, `deploy/production.json`). For automatic deploys from GitHub, see [Deploying](#deploying) below.
2. **Changing the code.** Read the rest of this file.

## How the deployable Worker is built

- The Worker is ordinary ES modules under `src/` (entry `src/index.js`). `npm run build` bundles them with the pinned esbuild into `dist/worker/index.js`, which deploys and self-host setup upload unchanged. Nothing generated is committed.
- Browser assets are `src/web/*.txt`, imported as text and served verbatim (`src/ui.js` fills three placeholders in `app.js.txt`). The prebuilt editor (`src/web/editor.js.txt`) is pinned by `editor/provenance.json`; `npm run check:editor` reproduces it.
- `npm run check:bundle` (CI) builds twice in fresh directories and fails on any difference, an unexpected runtime import, or an installation-specific value.
- Tests that need internals in Node use `test/load-worker.mjs` (bundles the real `src/`) or `test/module-source.mjs` (one module's body for vm-based tests). Never test a copy of the code.
- No installation-specific value belongs in code: hostnames, owners, gateways and callbacks all come from Worker vars (see `wrangler.example.toml`). Use `example.com`, `example.test` or `.invalid` names in code, tests and docs.

## Configuration files

| File | Committed | Purpose |
|---|---|---|
| `wrangler.local.toml` | yes | Local dev and tests only. Placeholder IDs; never deploy. |
| `wrangler.example.toml` | yes | Template for an installation's `wrangler.toml`. |
| `deploy/production.example.json` | yes | Template for the optional deploy pipeline's target. |
| `deploy/template/` | yes | Template for a private deploy repository (workflow and README). |
| `scripts/self-host/example.json` | yes | Template input for `npm run setup:self-host`. |
| `wrangler.toml`, `deploy/production.json`, `.self-host*.json` | **no** (gitignored) | One installation's real config. |

For a real installation, always pass `--env hosted` (or `--config <generated file>`) to wrangler. Without it, wrangler resolves the placeholder config.

## Deploying

Optional automation is described in [docs/deploy-pipeline.md](docs/deploy-pipeline.md). This repository holds no installation config or Cloudflare credentials. Each installation has its own **private deploy repository**, created from `deploy/template/`, which holds `wrangler.toml` and `deploy/production.json` (kept identical) and the deploy workflow.

- `.github/workflows/deploy.yml` runs CI on `main` and, if `vars.DEPLOY_REPO` and `secrets.DEPLOY_DISPATCH_TOKEN` are set, dispatches the commit to the deploy repo. Otherwise it only runs CI, so forks never deploy.
- The deploy repo checks out that exact commit, adds its config, runs a read-only preflight (config match, live drift, release ancestry, resources, migration plan, D1 restore point), applies additive migrations, deploys with tag `gh-<sha12>`, smoke-tests and writes a receipt. Manual runs refuse unless the app repo's `main` CI passed for the commit.
- **Live drift refuses; it is never overwritten.** A target var missing from the live Worker or with a different value there, or a live var absent from the target, refuses, because it may have been changed on purpose (e.g. a kill switch). To add or change a var deliberately, record it in the target's `pendingVars` as `{ NAME: <exact current live value, or null if new> }`, deploy, then empty `pendingVars`. Removing a var stays manual.
- Never deploy by hand while the pipeline is active (the preflight refuses out-of-band versions), and never "fix" a refusal by editing production.
- Runners come from `vars.CI_RUNNER` (this repo) and `vars.DEPLOY_RUNNER` (deploy repo), falling back to `ubuntu-24.04`. Never hard-code a paid or self-hosted runner label in a workflow here: forks would queue forever.

## Rules for changes

- **Authorization:** API, MCP and App Connect share the same service and authorization logic. Every operation requires project scope and a currently valid grant, checked on every request, including content, Range and transfer requests. Administration and grant changes are human-only. There is no permanent-purge agent tool.
- **Concurrency:** every save sends the expected revision and keeps unsaved work on conflict. Retried mutations use idempotency keys. Keep the design small: sequential, revision-guarded edits, no CRDT.
- **Browser safety:** never execute uploaded HTML or SVG on the app origin. Binary tools must perform a real authenticated HTTP byte transfer.
- **OAuth callbacks:** exact-match only. Built-in public client callbacks live in `HOSTED_CALLBACKS`. Anything installation-specific goes in the `OAUTH_EXTRA_REDIRECT_URIS` var, never in code. No wildcards.
- **App Connect hints:** `agentlib_project`/`agentlib_folder` and an app's registered suggested destination only pre-fill the consent form. They are bounded, escaped and never trusted: the owner confirms the destination and the server validates the project and folder pairing.
- **Migrations:** additive and retry-safe (`CREATE … IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN` with a default), named `NNNN_snake_case.sql` and sorting after the last one. The previous Worker must keep working on the new schema, because Worker rollback does not undo migrations. Destructive SQL needs an explicit `-- owner-approved-destructive:` marker and a manual window (docs/deploy-pipeline.md#destructive-migrations).
- **Tests:** fixtures name their columns in every `INSERT` (migrations add columns). Synthetic fixtures only; never real user content or health or other personal data. Use real harnesses (local `wrangler dev`, the official MCP SDK client, Chrome via Puppeteer), not just mocks. Every local listener takes its port from `test/ports.mjs` (`test/ports.test.mjs` enforces this). Don't make failing checks non-blocking or add retries to hide failures; find the cause.
- **Verification:** report honestly. A Cloudflare Access login redirect proves the gate, not that the app works. Skipped browser tests are not a pass.
- **Secrets and accounts:** never ask for secrets in chat, print token values, feed them into prompts or commit them. Don't create cloud resources, DNS, Access policies, OAuth apps or billing changes unless the user explicitly asks for that step. If config looks missing, stop and report; never create replacement resources.
- **Toolchain:** Node per `.node-version`; Wrangler and esbuild are pinned exactly (the build checks the esbuild version). Upgrade them deliberately, with a full test run and `check:bundle`.

## Checks before handing back

```sh
npm run typecheck && npm run test:self-host && npm run test:deploy && npm run check:bundle && npm run check:editor && npm run check:self-host-upload && npm test
```
