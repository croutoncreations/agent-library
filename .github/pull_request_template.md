## What and why

<!-- The problem this solves and the behavior change. Link an issue if there is one. -->

## How I tested it

<!-- Commands run and anything checked by hand. Note any skipped tests. -->

## Checklist

- [ ] Read [AGENTS.md](https://github.com/croutoncreations/agent-library/blob/main/AGENTS.md) and [CONTRIBUTING.md](https://github.com/croutoncreations/agent-library/blob/main/CONTRIBUTING.md)
- [ ] If anything that ships changed: ran `npm run build:design` and committed `src/index.js` with the changed `*-preservation.json` files
- [ ] `npm run typecheck`, `npm run check:bundle` and `npm test` pass locally
- [ ] Migrations (if any) are additive and retry-safe
- [ ] Synthetic test data only; no credentials, real hostnames or personal data
- [ ] Docs updated if behavior or setup changed
