# Connection diagnostics implementation

`connection_info` (both MCP implementations), `GET /v1/connection-info`
(API keys) and `GET /v1/publisher/connection-info` (App Connect) report only the
request's authenticated connection. There is no identity parameter. Existing
live authorization, project scope and rate limiting run before diagnostics.
OAuth uses the same connection projects and token/project write intersection
as `list_projects`; keys use `verifyApiKey`; legacy grants use `authenticate`
and `listProjects`; publishers use `livePublisher` and their sole destination. Their write flag also calls the existing `assertStillAuthorized` gate, so a disabled app or missing/foreign destination folder reports blocked writes while authorized metadata reads remain available.
Only IDs, labels, permitted project metadata, capabilities and timestamps are
serialized; credential records, owner identity and secrets never enter results.

The maintained serializer is `src/diagnostics/service.js`. The last build step,
`build-diagnostics-fixes.mjs` (after ranked search and the project-changes feed), applies exact once-matching patches within named
modules and emits `diagnostics-preservation.json`. Bundle reproducibility
includes this step. The UI comes from `src/web/app.js`; earlier whole-bundle
pins were re-reviewed and updated for that UI change, without weakening checks.

Owner summaries describe saved access, status and safe IDs. They neither probe
clients nor promise a successful read/write. Existing disconnect, replacement
and project-selection controls remain explicit owner actions. Diagnostics add
no document, grant, audit-content or trace writes; ordinary authentication/rate
telemetry may still run.

Infrastructure: **none added or changed**. No migrations, backfills, bindings,
secrets, environment variables, Cloudflare resources, DNS, callback allowlists
or deploy workflow changes. Current main already includes migration 0014 (ranked search and its existing-data backfill, docs/ranked-search.md) and migration 0015 (the durable changes feed, docs/project-changes.md). Those upstream requirements are preserved by this rebase; this diagnostic feature adds no migration or backfill. No deployment performed. Test infrastructure only: the optional `AGENT_LIBRARY_TEST_PORT_OFFSET` environment variable accepts only 0, 3000 or 6000, selecting disjoint listener ranges for concurrent worktrees; it is not a Worker setting.
Previous Workers remain compatible because storage is unchanged.

Verification: `test/connection-diagnostics.test.mjs` uses real local Wrangler,
D1, OAuth consent, official MCP SDK and Chrome with synthetic data. It checks
mixed read/write scope, identical labels with distinct IDs, scope removal,
expiry/revocation, bounded safe output, no document/revision/audit mutation,
publisher-only destination, disabled apps, missing/foreign folders, owner ID/copy comparison and UI states. The browser harness waits for the selected SPA tab before toggling its filter; hash navigation alone does not establish that the new controls have rendered. Screenshots
are written under `tmp/proof-of-work/connection-diagnostics/`.

Limitations: no remote client correlation challenge, local configuration
inspection, content/write/transfer probes, successful-operation history or
production authentication test. Null activity means unavailable. Publisher
expiry is not recorded; reader expiry describes its grant, not the access token.
See [setup and examples](agent-setup.md#check-which-connection-your-agent-is-using).
