// Every loopback port the suite listens on, in one place. Each local server (and each helper listener)
// owns its own port, so no two test files or servers ever share one, even if a previous process is slow
// to exit. All ports, including wrangler's inspector (port + INSPECTOR_OFFSET) and the App Connect
// stand-in IdP (port + OIDC_OFFSET), sit below 32768: outside the Linux (32768-60999) and macOS
// (49152-65535) ephemeral ranges, so an outgoing socket or a wrangler/workerd internal listener can never
// take one by chance. test/ports.test.mjs enforces this.
export const INSPECTOR_OFFSET = 1000;
export const OIDC_OFFSET = 2000;

// Concurrent checkouts can reserve a different bank without changing any listener individually.
const bankOffset = Number(process.env.AGENT_LIBRARY_TEST_PORT_OFFSET ?? process.env.AGENT_LIBRARY_TEST_PORT_SHIFT ?? 0);
if (!Number.isInteger(bankOffset) || bankOffset < 0 || bankOffset > 5000) throw Error("AGENT_LIBRARY_TEST_PORT_OFFSET must be an integer from 0 to 5000");
const bank = (ports) => Object.fromEntries(Object.entries(ports).map(([name, port]) => [name, port + bankOffset]));

/** wrangler dev servers, by startServer() name (App Connect harness servers are named `ac-<port>`). */
export const SERVER_PORTS = Object.freeze(bank({
  a2: 21010, a4: 21011, a6: 21012, a9: 21013, a11: 21014, a12: 21015, "a12-restore": 21016,
  sec: 21017, limits: 21018, hosted: 21019, acp2: 21020, acoff: 21021, apiv1: 21022, acp3: 21023,
  "design-shell": 21024, generations: 21025, "design-reader": 21026, "mobile-tables": 21027,
  uipolish: 21028, weblinks: 21029, "oauth-browser": 21030, oauth: 21031,
  "bridge-contract": 21032, "readable-generation-contract": 21033, history: 21034, "consent-capture": 21035, "hosted-session": 21036,
  "data-preview": 21037, "chunked-reads": 21038, "ranked-search": 21041, "project-changes": 21042, "oauth-files": 21039, "smoke-setup": 21040,
  "marketing-capture": 21045, "marketing-clips": 21046,
}));

/** Plain node:http listeners that tests start next to a server. */
export const AUX_PORTS = Object.freeze(bank({
  hostedJwks: 23100, oauthBrowserOidc: 23101, oauthBrowserCallback: 23102, oauthBrowserHop: 23103,
  chatgptOidc: 23104, chatgptCallback: 23105, hostedSessionJwks: 23106, hostedSessionAccess: 23107,
}));

/** Every port bound during a run, for the uniqueness check. */
export function allBoundPorts() {
  const servers = Object.values(SERVER_PORTS);
  return [...servers, ...servers.map((p) => p + INSPECTOR_OFFSET), ...servers.map((p) => p + OIDC_OFFSET), ...Object.values(AUX_PORTS)];
}
