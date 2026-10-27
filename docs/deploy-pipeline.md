# Optional: deploy from GitHub

You can run Agent Library by deploying with `wrangler` by hand ([self-hosting.md](self-hosting.md)). If you'd rather have every push to `main` tested and deployed automatically, use a **private deploy repository**. It holds your installation's config and the deploy workflow; the app repository (public, or your fork) stays free of account IDs, hostnames and Cloudflare credentials.

```
app repo (public)                                   deploy repo (private)
  push to main -> CI -> deploy.yml ----dispatch---->   deploy.yml
                                  (commit sha)        checks out app@sha + its own wrangler.toml / production.json
                                                      preflight -> migrate -> deploy -> smoke -> receipt
```

Nothing deploys from a fork or a fresh clone unless you set it up.

| Workflow (app repo) | Trigger | What it does | Needs |
|---|---|---|---|
| `ci.yml` | every PR; also called by `deploy.yml` | typecheck, deploy-guard and migration tests, bundle reproducibility, offline self-host upload check, full test suite (Chrome, real MCP client) | nothing |
| `claude-review.yml` | PR opened or pushed | advisory Claude review, full first and then the delta per push; skipped if no credential | `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` (repo secret) |
| `deploy.yml` | push to `main` | CI on the exact commit, then asks your deploy repo to deploy it | `DEPLOY_REPO` variable and `DEPLOY_DISPATCH_TOKEN` secret; otherwise CI only |
| `release.yml` | manual | verifies an existing version tag (CI, license, changelog); publishes nothing | nothing |

### Runners

Workflows run on GitHub's `ubuntu-24.04` unless you set the repository variable `CI_RUNNER` (app repo) or `DEPLOY_RUNNER` (deploy repo) to another label, for example `blacksmith-4vcpu-ubuntu-2404` for [Blacksmith](https://www.blacksmith.sh/). Forks without that runner provider fall back to GitHub's runners automatically. Pull requests **from forks** always run CI on GitHub's runners (free for public repositories), never on `CI_RUNNER`, so outside contributors can't use your paid runner minutes. Keeping "Require approval for first-time contributors" on (Settings → Actions → General) is still a good default for a public repository.

## Set up the deploy repository

1. **Create a private repo** (e.g. `my-org/agent-library-deploy`) from [`deploy/template/`](../deploy/template/): copy `.github/workflows/deploy.yml` into it.
2. **Add your config** to that repo:
   - `wrangler.toml`: from `wrangler.example.toml`, with `[env.hosted]` filled in;
   - `deploy/production.json`: from `deploy/production.example.json`.

   They must describe the same installation. Check from an app checkout with both files copied in (both are gitignored there):
   ```sh
   npm run test:deploy           # includes "own wrangler.toml matches deploy/production.json"
   npm run check:deploy-config   # offline wrangler --dry-run uploads exactly src/index.js with your bindings
   ```
   `baseline` in `deploy/production.json` is the Worker version that's live before the pipeline's first deploy (`npx wrangler deployments status --env hosted`). The pipeline only deploys over that version or over versions it deployed itself.
3. **Cloudflare API token.** Create a custom token scoped to your account and zone with these permissions:
   - Workers Scripts: Edit;
   - D1: Edit;
   - Workers KV Storage: Read;
   - Workers R2 Storage: Read;
   - Account Settings: Read;
   - for the zone: Workers Routes: Edit and Zone: Read.

   Give it no DNS, Access, R2-write or KV-write permissions, and set an expiry.
4. **Deploy repo settings.** Create an environment `production` (optionally with yourself as required reviewer, so each deploy is a one-click approval).

   | Where (deploy repo) | Name | Value |
   |---|---|---|
   | `production` secret | `CLOUDFLARE_API_TOKEN` | the token above |
   | `production` secret (optional) | `AL_SMOKE_API_TOKEN` | an API key for one **synthetic** smoke project |
   | `production` variables (optional) | `AL_SMOKE_PROJECT_ID`, `AL_SMOKE_FILE_ID` | that project and one Markdown file in it |
   | repository variable | `APP_REPO` | the app repo, e.g. `my-org/agent-library` |
   | repository secret (only if the app repo is private) | `APP_REPO_TOKEN` | fine-grained token on the app repo: **Contents: read**, plus **Actions: read** so manual runs can confirm CI passed |
   | repository variables (optional) | `DEPLOY_RUNNER`, `PRODUCTION_URL` | runner label; your app URL |
   | repository variable | `PRODUCTION_DEPLOY_ENABLED` | `true` to activate; anything else deactivates |
5. **App repo settings.** So that a green `main` triggers a deploy:

   | Where (app repo) | Name | Value |
   |---|---|---|
   | repository variable | `DEPLOY_REPO` | e.g. `my-org/agent-library-deploy` |
   | repository secret | `DEPLOY_DISPATCH_TOKEN` | fine-grained token, **only** the deploy repo, **Contents: read and write** (required to send `repository_dispatch`) |
6. **Activate.** Optionally run the preflight read-only from your machine first (from an app checkout with your config copied in):
   ```sh
   CLOUDFLARE_ACCOUNT_ID=<your account id> node scripts/deploy/preflight.mjs /tmp/state.json --check-only
   ```
   Then set `PRODUCTION_DEPLOY_ENABLED=true` in the deploy repo and run *Deploy Agent Library* from its Actions tab (or push to the app's `main`).
7. **Optional: authenticated smoke checks.** Without them, post-deploy checks only prove the boundaries (Access redirect, 401s). To also run the "app" level (a scoped API call) and the "workflow" level (an expected-revision save and read-back of one synthetic file):
   1. In the app, create a project used **only** for this, e.g. "Deploy smoke (synthetic)". Then create an API key (Connections → API keys) with **read and write on that project only**, valid for 90 days. Real content never goes in it; every deploy rewrites its one file.
   2. Run `node scripts/deploy/smoke-setup.mjs` and paste the key at the hidden prompt. You can also set `AL_SMOKE_API_TOKEN` or pipe the key in. Run it from an app checkout that has `deploy/production.json`, or point at that file with `--target path/to/production.json`. It checks the key's scope, creates or finds the synthetic file, and writes the non-secret IDs to `deploy/smoke.json`. That file is gitignored here; commit it to the deploy repo next to `production.json`.
   3. `node scripts/deploy/smoke-apply.mjs OWNER/DEPLOY_REPO deploy/smoke.json --set-secret` sets `AL_SMOKE_PROJECT_ID` and `AL_SMOKE_FILE_ID` as `production` environment variables. It then lets `gh` prompt for the key, which becomes the `AL_SMOKE_API_TOKEN` secret.

   Both scripts are idempotent. After a repo move or rename, a new deploy repo, or a key rotation, re-run step 3 (and step 2 if the key changed). The next receipt shows the app and workflow levels as PASS.

Changing config is a normal reviewed commit in the deploy repo. To deploy a specific app commit (or redeploy), run the deploy workflow manually with its SHA. A manual run refuses unless the app repo's own *Deploy* workflow ran CI (`ci / checks`, `ci / test`) successfully on a push of that exact commit to `main` (dispatched runs come from that workflow and are already gated).

**Adding or changing a var.** The preflight refuses when a target var is missing from the live Worker or has a different value there, because it may have been changed or removed on purpose (for example a kill switch). To add a var or change a value on purpose, set the new value in `vars` and add an entry to the target's `pendingVars` object recording the value it replaces: `"pendingVars": { "NAME": "<current live value>" }`, or `null` for a new var. Deploy, then empty `pendingVars`. The change applies only while live still holds the recorded value, so a forgotten entry can never override a later live change. The preflight refuses an entry that is already live with the target value, so the next deploy reminds you to clear it. Removing a var is still a manual, reviewed change.

## What a deploy does

1. Runs **CI** on the pushed commit (app repo), then dispatches the commit to the deploy repo.
2. The deploy repo checks out the app at that commit, adds its `wrangler.toml` and `deploy/production.json`, and runs the offline config check.
3. Runs the **preflight**, which is read-only and refuses on any doubt:
   - the config matches the target, with no placeholder IDs or hostnames;
   - the commit is still the tip of `main` (otherwise it skips as stale);
   - the live Worker's vars, secret names, bindings and compatibility settings match the target. Drift is refused, never overwritten;
   - the release rule: deploy only over the recorded baseline, or over a `gh-<sha>` version whose commit is an ancestor of this one;
   - the D1, KV and R2 resources exist, and R2 is still private;
   - the migration plan against the real `d1_migrations` table;
   - a D1 Time Travel bookmark is recorded as a restore point.
4. **Migrates** (only additive migrations), then **deploys** with tag `gh-<sha12>` and verifies the tag is live.
5. Runs **smoke checks**:
   - boundary: the app host redirects to Access, `/mcp` returns 401 with a challenge, OAuth metadata is served;
   - optionally, an authenticated API call and a synthetic save and read-back.
6. Writes a **receipt** (job summary and artifact) with the versions, migrations, bookmark and exact rollback commands.

## Migrations

New migrations must be **additive and retry-safe**: `CREATE TABLE/INDEX … IF NOT EXISTS`, or `ALTER TABLE … ADD COLUMN` with a default. Name them `NNNN_snake_case.sql`, sorting after the last one. The previous Worker must keep working on the new schema. `test/migrations-order.test.mjs` and the preflight enforce this.

### Destructive migrations

Only these statements are auto-applied:
- `CREATE TABLE/INDEX/VIEW/TRIGGER`;
- `ALTER TABLE … ADD`;
- `INSERT [OR IGNORE] INTO`.

Anything else, such as `DROP`, `DELETE`, `UPDATE`, `REPLACE`, renames, `PRAGMA` or table rebuilds, needs:
1. a `-- owner-approved-destructive: <who> <date> <reason>` line in the file (CI fails without it);
2. a manual window. Take a private export (`npx wrangler d1 export DB --remote --env hosted --output backup.sql`), note a Time Travel bookmark, then run `npx wrangler d1 migrations apply DB --remote --env hosted` yourself;
3. a push to `main`. The preflight sees the migration as applied and continues.

## Recovery

| Situation | Action |
|---|---|
| Preflight refused | Nothing changed. Read the error and fix the config or source drift in a PR. Never "fix" production by hand. |
| Migration failed | The old Worker is still live. Fix forward with a new additive migration and re-run. |
| Migrations succeeded, deploy failed | The new schema runs with the old Worker, which works because migrations are additive. Re-run the deploy workflow (only if the commit is still the tip of `main`) or push a fix. Don't restore D1. |
| Deploy succeeded, smoke failed | Judge severity from the receipt. To revert the code: `npx wrangler rollback <previous-version-id> --env hosted` (the ID is in the receipt). |
| Bad data change | D1 Time Travel restore to the receipt's bookmark. This is **destructive** (it loses later writes): `npx wrangler d1 time-travel restore DB --env hosted --bookmark <bookmark>`. |
| Secret rotated | Nothing to do. The preflight looks through `secret`-triggered versions to the code version underneath. |
| Out-of-band deploy (dashboard edit or manual deploy) | The preflight refuses. Bring that source into `main`; if it should become the new baseline, update `baseline` in the deploy repo's `deploy/production.json`. |

Worker rollback restores code and config only, not D1, R2 or KV.

## Branch protection

Use a ruleset for `main`:
- require a PR;
- require the `checks` and `test` status checks (from `CI`);
- block force pushes;
- require linear history.

`Claude PR review` is advisory; don't make it required.

## Claude PR review

The review runs on `pull_request` (never `pull_request_target`). It is skipped for forks, drafts and Dependabot, and has read-only contents plus PR-comment permissions. Claude only reads the checkout and git metadata through allow-listed tools; PR code is never executed in this job. If no credential is configured, the job passes with a notice.
