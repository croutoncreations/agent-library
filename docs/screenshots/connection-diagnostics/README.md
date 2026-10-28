# Connection diagnostics UI evidence

Captured in real Chrome against the local Worker, using synthetic fixtures only.
No production content or credentials appear in these screenshots. Connection
IDs are safe identifiers from the isolated local database.

| View | Screenshot |
| --- | --- |
| Reader apps and configured setup help | [Desktop](reader-desktop.png) |
| Reader apps at 390px | [Mobile](reader-mobile.png) |
| API key IDs, saved scope and statuses | [API keys](api-keys.png) |
| Legacy grant ID and scope | [Agent tokens](tokens.png) |
| Publisher ID and own destination | [Publishing apps](publishing.png) |
| Waiting for server access data | [Loading](loading.png) |
| Network request failure | [Offline](offline.png) |
| Server request failure | [Server error](server-error.png) |
| No active reader grants after revocation | [Empty](empty.png) |

Reproduce with Chrome/Puppeteer installed (see CONTRIBUTING.md):

```sh
AGENT_LIBRARY_TEST_PORT_OFFSET=6000 npm exec -- node --test test/connection-diagnostics.test.mjs
```

Fresh captures appear in `tmp/proof-of-work/connection-diagnostics/`. The test
verifies that the copied reader ID matches its actual authenticated MCP
connection and that the publisher card ID matches the owner API. Scope,
status, copy behavior and layout assertions run before capture. Loading and
failure captures use intercepted access requests; empty access is real server
state after revocation. The test closes its local services when finished.
