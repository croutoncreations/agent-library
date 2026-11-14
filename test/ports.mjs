// Every loopback port the suite listens on, in one place. Each local server (and each helper listener)
// owns its own port, so no two test files or servers ever share one, even if a previous process is slow
// to exit. All ports, including wrangler's inspector (port + INSPECTOR_OFFSET) and the App Connect
// stand-in IdP (port + OIDC_OFFSET), sit below 32768: outside the Linux (32768-60999) and macOS
// (49152-65535) ephemeral ranges, so an outgoing socket or a wrangler/workerd internal listener can never
// take one by chance. test/ports.test.mjs enforces this.
export const INSPECTOR_OFFSET = 1000;
export const OIDC_OFFSET = 2000;

/** wrangler dev servers, by startServer() name (App Connect harness servers are named `ac-<port>`). */
// Parallel worktrees may choose separate deterministic ranges; never reuse another run's listeners.
const offset = Number(process.env.AGENT_LIBRARY_TEST_PORT_OFFSET ?? process.env.AGENT_LIBRARY_TEST_PORT_SHIFT ?? 0);
// One complete run spans 2098 ports, including derived inspector/OIDC ports.
// A 3000-port stride keeps every supported pair of runs disjoint below 32768.
if (!Number.isInteger(offset) || offset < 0 || offset > 6000 || offset % 3000 !== 0) throw new Error("AGENT_LIBRARY_TEST_PORT_OFFSET must be 0, 3000 or 6000");
const range = (ports) => Object.freeze(Object.fromEntries(Object.entries(ports).map(([name, port]) => [name, port + offset])));
export const SERVER_PORTS = range({
  a2: 21010, a4: 21011, a6: 21012, a9: 21013, a11: 21014, a12: 21015, "a12-restore": 21016,
  sec: 21017, limits: 21018, hosted: 21019, acp2: 21020, acoff: 21021, apiv1: 21022, acp3: 21023,
  "design-shell": 21024, "design-reader": 21026, "mobile-tables": 21027,
  uipolish: 21028, weblinks: 21029, "oauth-browser": 21030, oauth: 21031,
  "bridge-contract": 21032, "readable-generation-contract": 21033, history: 21034, "consent-capture": 21035, "hosted-session": 21036,
  "data-preview": 21037, "chunked-reads": 21038, "ranked-search": 21041, "project-changes": 21042, "oauth-files": 21039, "smoke-setup": 21040,
  templates: 21043, "templates-restore": 21044, "templates-legacy-restore": 21047,
  diagnostics: 21048, "file-types": 21049, "marketing-capture": 21045, "marketing-clips": 21046, tenancy: 21050, "tenancy-oauth": 21051, "tenancy-browser": 21052, "tenancy-matrix": 21053, "oidc-signin": 21054,
  // Used by the hosted (private) repository's tests, which run its bundle through this harness.
  "hosted-supabase": 21055,
  addresses: 21056, "addresses-browser": 21057, "plan-limits": 21058, "project-deletion": 21059, "content-host": 21060, "large-uploads": 21061, "list-limits": 21062, "single-pass-uploads": 21063, "text-r2": 21064, "list-artifacts-filter": 21065, "text-limit": 21066, "render-limit": 21067, "text-uploads": 21068, "text-uploads-oauth": 21069, "text-uploads-v1": 21070, "search-excerpt-bounds": 21071, "list-filter-long": 21072, "text-uploads-mcp": 21073, "text-uploads-mcp-off": 21074, "app-files": 21076, "app-files-hooks-off": 21078,
  "offline-shell": 21080, "offline-network": 21081, "offline-hosted": 21082,
  "review-gating": 21083, "review-gating-restore": 21084, "review-ui": 21085,
  "artifact-cap": 21090, "artifact-cap-guards": 21091, "upgrade-v010": 21092, "upgrade-main": 21093,
});

/** Plain node:http listeners that tests start next to a server. */
export const AUX_PORTS = range({
  hostedJwks: 23100, oauthBrowserOidc: 23101, oauthBrowserCallback: 23102, oauthBrowserHop: 23103,
  chatgptOidc: 23104, chatgptCallback: 23105, hostedSessionJwks: 23106, hostedSessionAccess: 23107,
  hostedTurnstile: 23108, hostedStripe: 23109, hostedSendgrid: 23110,
  offlineShellProxy: 23111, offlineNetworkJwks: 23112, offlineNetworkAccess: 23113, offlineHostedProxy: 23114,
});

/** Every port bound during a run, for the uniqueness check. */
export function allBoundPorts() {
  const servers = Object.values(SERVER_PORTS);
  return [...servers, ...servers.map((p) => p + INSPECTOR_OFFSET), ...servers.map((p) => p + OIDC_OFFSET), ...Object.values(AUX_PORTS)];
}
