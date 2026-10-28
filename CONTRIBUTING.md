# Contributing

Thanks for helping. Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md). Read [AGENTS.md](AGENTS.md) before editing, whether you're a person or an agent. It explains how the Worker is built and the rules every change must keep. By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE). Keep third-party notices intact.

## Setup

Use the Node version in `.node-version`, then:

```sh
npm ci
npm ci --prefix editor
npm run dev   # local server on http://127.0.0.1:8787 using wrangler.local.toml
```

To sign in locally, start `wrangler dev` with a passphrase: `npx wrangler dev --config wrangler.local.toml --local --var LOCAL_DEV_LOGIN:<some passphrase>`. Then use that passphrase on the sign-in form. The dev login only works on localhost.

## Checks

```sh
npm run typecheck
npm run test:self-host
npm run test:deploy
npm run check:editor
npm run check:bundle
npm run check:self-host-upload
npm test
```

The full suite starts real local Wrangler services and uses the official MCP SDK client. Browser tests need Google Chrome and Puppeteer 24.16.2 at `~/.npm-packages/lib/node_modules/puppeteer` (set `CHROME_PATH` for a nonstandard Chrome location). Fixtures need ffmpeg. `.github/workflows/ci.yml` shows the Linux setup. A test skipped because of a missing browser is not a pass, so report skips. New test listeners get their port in `test/ports.mjs`. When another worktree is running tests, set `AGENT_LIBRARY_TEST_PORT_OFFSET=6000` (one of 0, 3000 or 6000; these ranges do not overlap) to use a separate listener range; do not stop another worktree's servers. The older `AGENT_LIBRARY_TEST_PORT_SHIFT` alias is still accepted with the same values; `OFFSET` takes precedence when both are set.

## Changing what ships

The Worker is the committed `src/index.js`. Edit the maintained source or the build patch (see AGENTS.md), run `npm run build:design`, and commit `src/index.js` with every changed `*-preservation.json`. `npm run check:bundle` must pass. An edit to an older `.ts` snapshot on its own changes nothing.

## Pull requests

Keep PRs scoped: describe the problem, the behavior change, how you validated it and any limitations. Migrations must be additive and retry-safe. Use synthetic test data only, and never add credentials or installation-specific hostnames. For security issues, see [SECURITY.md](SECURITY.md).

## Publishing a copy (maintainers and forks)

If you keep a private working repository and publish a public one, export with `git archive`, never by copying a working folder. A working folder holds gitignored installation files (`wrangler.toml`, `deploy/production.json`, `AGENTS.local.md`, `.self-host*.json`).

```sh
node scripts/release/export-public.mjs /tmp/agent-library-public main
```

This exports exactly the committed tree and refuses if it finds secret-shaped strings or forbidden files. Put your own identifiers (hostnames, account IDs, names) one regex per line in the gitignored `.release-denylist` so the export checks them too. Deliberate exceptions go in `.release-allowlist` as `path:regex`.
