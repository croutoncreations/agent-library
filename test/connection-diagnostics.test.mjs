import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { startAppConnectServer } from "./fixtures/app-connect-harness.mjs";
import { grant, mcpClient, ROOT, LOCAL_CONFIG, key } from "./helpers.mjs";
import { SERVER_PORTS } from "./ports.mjs";
let h, owner, browser, firstInfo, firstAgent;
const sql = (q) => JSON.parse(execFileSync("wrangler", ["d1", "--config", LOCAL_CONFIG, "execute", "DB", "--local", "--persist-to", h.dir, "--command", q, "--json"], { cwd: ROOT, encoding: "utf8", env: { ...process.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"] }))[0].results;
const request = async (token, path = "/connection-info", method = "GET") => {
  const r = await fetch(h.api + path, { method, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.status, data: await r.json(), cache: r.headers.get("cache-control") };
};
function safe(d, secret) {
  const s = JSON.stringify(d);
  assert.ok(s.length < 16000);
  assert.ok(!s.includes(secret));
  assert.doesNotMatch(s, /token_hash|owner@example|owner_principal|refresh_token|client_secret|Authorization/);
  assert.equal(d.successful_operations, "not measured");
  assert.ok(Number.isFinite(Date.parse(d.checked_at)));
}
before(async () => {
  h = await startAppConnectServer({ port: SERVER_PORTS.diagnostics }); owner = await h.owner();
  for (const [id, title] of [["diag-a", "Shared notes"], ["diag-b", "Intended project"]]) assert.equal((await owner.req("POST", "/api/projects", { id, title })).status, 201);
});
after(async () => { await browser?.close(); await h?.stop(); });

test("API key: effective mixed scope, parameter rejection, scope removal, revocation and expiry on next request", async () => {
  const k = (await owner.req("POST", "/api/api-keys", { label: "Same name", lifetime_days: 1, projects: [{ project_id: "diag-a", access: "read" }, { project_id: "diag-b", access: "read_write" }] })).body;
  const a = await request(k.secret); assert.equal(a.status, 200); assert.equal(a.cache, "no-store"); safe(a.data, k.secret);
  assert.equal(a.data.connection.id, k.id);
  assert.equal(a.data.last_activity_at, null, "first diagnostic returns the activity snapshot before its own authentication telemetry");
  const second = await request(k.secret);
  assert.ok(Number.isFinite(Date.parse(second.data.last_activity_at)));
  assert.ok(Date.parse(second.data.last_activity_at) <= Date.parse(second.data.checked_at));
  assert.deepEqual(a.data.projects.map((p) => [p.id, p.can_read, p.can_write]), [["diag-a", true, false], ["diag-b", true, true]]);
  assert.equal((await request(k.secret, "/connection-info?connection_id=other")).status, 400);
  assert.equal((await request(k.secret, "/connection-info", "POST")).status, 405);
  assert.equal((await request(null)).status, 401);
  assert.equal((await owner.req("PUT", `/api/api-keys/${k.id}/scope`, { projects: [{ project_id: "diag-b", access: "read" }] })).status, 200);
  assert.deepEqual((await request(k.secret)).data.projects.map((p) => [p.id, p.can_write]), [["diag-b", false]]);
  sql(`UPDATE api_credentials SET expires_at = 1 WHERE id = '${k.id}'`);
  assert.equal((await request(k.secret)).status, 401);
  const k2 = (await owner.req("POST", "/api/api-keys", { label: "Same name", lifetime_days: 1, projects: [{ project_id: "diag-a", access: "read" }] })).body;
  assert.notEqual(k.id, k2.id);
  await owner.req("POST", `/api/api-keys/${k2.id}/revoke`, {});
  assert.equal((await request(k2.secret)).status, 401);
});

test("OAuth MCP: same name, different actual connections; SDK read-only discovery, wrong-project comparison, live changes", async () => {
  const a = await h.connectMcpAgent({ "diag-a": "read" }, { clientName: "Same name" });
  const b = await h.connectMcpAgent({ "diag-a": "read", "diag-b": "write" }, { clientName: "Same name" });
  const sdk = await mcpClient(h.issuer, a.access_token);
  try {
    const t = (await sdk.client.listTools()).tools.find((t) => t.name === "connection_info");
    assert.equal(t.annotations.readOnlyHint, true); assert.deepEqual(t.inputSchema.properties, {});
    assert.ok(!(await sdk.client.listTools()).tools.some((t) => t.name === "save_markdown"));
    const r = await sdk.call("connection_info", {}); assert.equal(r.isError, false); safe(r.data, a.access_token); firstInfo = r.data; firstAgent = a;
    assert.deepEqual(r.data.projects.map((p) => [p.id, p.can_write]), [["diag-a", false]]);
    const other = (await b.call("connection_info", {})).data; safe(other, b.access_token);
    assert.notEqual(r.data.connection.id, other.connection.id);
    assert.deepEqual(other.projects.map((p) => [p.id, p.can_write]), [["diag-a", false], ["diag-b", true]]);
    assert.equal((await a.call("connection_info", { connection_id: other.connection.id })).isError, true);
    const before = sql("SELECT (SELECT count(*) FROM artifacts) AS files, (SELECT count(*) FROM revisions) AS versions, (SELECT count(*) FROM audits) AS audits");
    await a.call("connection_info", {});
    assert.deepEqual(sql("SELECT (SELECT count(*) FROM artifacts) AS files, (SELECT count(*) FROM revisions) AS versions, (SELECT count(*) FROM audits) AS audits"), before);
    sql(`DELETE FROM oauth_connection_projects WHERE connection_id = '${other.connection.id}' AND project_id = 'diag-b'`);
    assert.deepEqual((await b.call("connection_info", {})).data.projects.map((p) => p.id), ["diag-a"]);
    sql(`UPDATE oauth_connections SET expires_at = 1 WHERE id = '${other.connection.id}'`);
    assert.equal((await b.call("connection_info", {})).status, 401);
  } finally { await sdk.close(); }
});

test("legacy grant SDK: read-only effective access, revocation and no arbitrary identity", async () => {
  const g = await grant(owner, "diag-b", "Legacy reader", false);
  const c = await mcpClient(h.appUi, g.token);
  try {
    assert.equal((await c.client.listTools()).tools.find((t) => t.name === "connection_info").annotations.readOnlyHint, true);
    const r = await c.call("connection_info", {}); safe(r.data, g.token);
    assert.equal(r.data.connection.id, g.grant_id); assert.equal(r.data.connection.type, "legacy_grant");
    assert.deepEqual(r.data.projects.map((p) => [p.id, p.can_write]), [["diag-b", false]]);
    await owner.req("PATCH", `/api/projects/diag-b/grants/${g.grant_id}`, { revoke: true });
    await assert.rejects(() => c.call("connection_info", {}));
  } finally { await c.close(); }
});

test("publisher: only its own destination, no project browser or credential details", async () => {
  const app = await h.registerApp({ display_name: "Synthetic publisher", redirect_uris: ["http://localhost:5173/cb"], origins: [] });
  const pub = await h.connectPublisher(app, { project_id: "diag-b", destination: "new", new_folder_name: "Diagnostic exports" });
  const r = await h.pub(pub.access_token, "GET", "/publisher/connection-info");
  assert.equal(r.status, 200); safe(r.json, pub.access_token);
  assert.equal(r.json.connection.id, pub.publisher_id); assert.deepEqual(r.json.projects, []);
  assert.equal(r.json.destination.project_id, "diag-b"); assert.equal(r.json.destination.can_read_own_files, true);
  assert.match(r.json.restrictions.join(" "), /no general project browsing/);
  assert.equal((await h.pub(pub.access_token, "GET", "/connection-info")).status, 401);
  assert.equal((await h.pub(pub.access_token, "GET", "/publisher/connection-info?connection_id=other")).status, 400);
});

test("publisher diagnostic follows the actual write gate for disabled apps and missing or foreign folders", async () => {
  // Own fixtures: failure of the ordinary publisher diagnostic test cannot cascade here.
  const publisherApp = await h.registerApp({ display_name: "Write gate publisher", redirect_uris: ["http://localhost:5174/cb"], origins: [] });
  const publisherConnection = await h.connectPublisher(publisherApp, { project_id: "diag-b", destination: "new", new_folder_name: "Write gate exports" });
  const token = publisherConnection.access_token;
  const info = () => h.pub(token, "GET", "/publisher/connection-info");
  const initial = await info();
  assert.equal(initial.json.destination.can_write_own_files, true);
  const folder = initial.json.destination.folder_id;
  assert.ok(folder);
  const write = () => h.pub(token, "POST", "/publisher/generations", { idem: key("blocked"), body: {
    generation_id: "g_diagnostic", source_revision: 1, expected_current_snapshot_id: null,
    root_name: "root.json", root_sha256: "a".repeat(64), part_count: 1, total_bytes: 16
  } });
  const blocked = async (reason, status) => {
    const r = await info(); assert.equal(r.status, 200); safe(r.json, token);
    assert.equal(r.json.destination.can_read_own_files, true);
    assert.equal(r.json.destination.can_write_own_files, false);
    assert.match(r.json.restrictions.join(" "), reason);
    assert.equal((await write()).status, status);
  };
  assert.equal((await owner.req("POST", `/api/app-clients/${publisherApp.app_client_id}/disable`, {})).status, 200);
  await blocked(/app client disabled/, 401);
  sql(`UPDATE app_clients SET disabled_at = NULL WHERE id = '${publisherApp.app_client_id}'`);
  assert.equal((await info()).json.destination.can_write_own_files, true);
  sql(`UPDATE folders SET project_id = 'diag-a' WHERE id = '${folder}'`);
  await blocked(/destination unavailable or changed/, 403);
  sql(`UPDATE folders SET project_id = 'diag-b' WHERE id = '${folder}'`);
  sql(`DELETE FROM folders WHERE id = '${folder}'`);
  await blocked(/destination unavailable or changed/, 403);
  sql(`UPDATE publishers SET folder_id = NULL WHERE id = '${publisherConnection.publisher_id}'`);
  assert.equal((await info()).json.destination.can_write_own_files, true);
});

test("real owner UI: matching safe ID and copy output, configured setup URL, existing status/actions, screenshots and failure states", async () => {
  const disabledApp = await h.registerApp({ display_name: "Disabled summary fixture", redirect_uris: ["http://localhost:5174/cb"], origins: [] });
  const disabledPub = await h.connectPublisher(disabledApp, { project_id: "diag-b", destination: "new", new_folder_name: "Disabled summary exports" });
  assert.equal((await owner.req("POST", `/api/app-clients/${disabledApp.app_client_id}/disable`, {})).status, 200);
  const require = createRequire(import.meta.url);
  const puppeteer = require(`${process.env.HOME}/.npm-packages/lib/node_modules/puppeteer`);
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  const page = await browser.newPage(); await page.setViewport({ width: 1440, height: 1100 });
  const [name, value] = owner.cookie.split("="); await page.setCookie({ name, value, url: h.appUi });
  const out = "tmp/proof-of-work/connection-diagnostics"; mkdirSync(out, { recursive: true });
  await page.goto(h.appUi + "/#/settings/apps"); await page.waitForSelector("article.conn .connection-summary");
  await page.evaluate((id) => {
    window.copiedDiagnostic = null;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (s) => { window.copiedDiagnostic = s; } } });
    document.querySelector(".connection-help").open = true;
    const d = [...document.querySelectorAll(".connection-summary")].find((e) => e.textContent.includes(id)); d.open = true; d.querySelector("button").click();
  }, firstInfo.connection.id);
  const copied = JSON.parse(await page.evaluate(() => window.copiedDiagnostic));
  assert.equal(copied.connection.id, firstInfo.connection.id); assert.equal(copied.successful_operations, "not measured");
  assert.match(copied.check, /Saved access checked/); assert.doesNotMatch(JSON.stringify(copied), /token_hash|secret/);
  assert.ok(await page.evaluate((url) => document.querySelector(".connection-help").innerText.includes(url), h.issuer + "/mcp"));
  await page.evaluate(() => { document.querySelector(".connection-summary textarea").setSelectionRange(0, 0); document.activeElement.blur(); });
  await page.screenshot({ path: `${out}/reader-desktop.png`, fullPage: true });
  await page.setViewport({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: `${out}/reader-mobile.png`, fullPage: true });
  await page.setViewport({ width: 1440, height: 1100 });
  for (const [tab, selector] of [["api-keys", ".connection-summary"], ["tokens", ".connection-summary"], ["publishing", "article.conn .connection-summary"]]) {
    await page.goto(h.appUi + "/#/settings/" + tab);
    // Hash navigation returns before the SPA replaces the previous tab. Wait for the
    // destination before touching its filter, or we can toggle the old reader filter.
    await page.waitForFunction((tab) => document.querySelector('.tabs a[aria-current="page"]')?.getAttribute("href") === "#/settings/" + tab, {}, tab);
    if (tab === "api-keys" || tab === "tokens") {
      // The selected tab is rendered before its API response populates the list.
      // Wait for that final layout, then target the labelled filter (not a scope
      // checkbox in the creation form). The locator also waits for a stable box
      // before sending real pointer input, including after the mobile resize.
      await page.waitForSelector("ul.list > li");
      const filter = "label.muted.small input[type=checkbox]";
      await page.locator(filter).click();
      assert.equal(await page.$eval(filter, (el) => el.checked), true);
    }
    await page.waitForSelector(selector); await page.evaluate(() => document.querySelectorAll(".connection-summary").forEach((d) => { d.open = true; }));
    const cards = await page.$$eval(".connection-summary", (ds) => ds.map((d) => JSON.parse(d.querySelector("textarea").value)));
    assert.ok(cards.every((c) => typeof c.connection.id === "string" && c.connection.id.length > 0));
    if (tab === "api-keys") assert.ok(cards.every((c) => c.check.includes("GET /v1/connection-info")));
    if (tab === "publishing") {
      assert.ok(cards.every((c) => c.check.includes("GET /v1/publisher/connection-info")));
      const pub = (await owner.req("GET", "/api/app-clients")).body.app_clients[0].publishers[0];
      assert.ok(cards.some((c) => c.connection.id === pub.publisher_id));
      assert.equal(cards.find((c) => c.connection.id === disabledPub.publisher_id).status, "disabled");
    }
    await page.screenshot({ path: `${out}/${tab}.png`, fullPage: true });
  }
  await page.setRequestInterception(true);
  let mode = "loading", held;
  page.on("request", (r) => {
    if (new URL(r.url()).pathname !== "/api/access") return r.continue();
    if (mode === "loading") { held = r; return; }
    if (mode === "offline") return r.abort("internetdisconnected");
    return r.respond({ status: 503, contentType: "application/json", body: '{"error":{"message":"Service temporarily unavailable"}}' });
  });
  await page.goto(h.appUi + "/#/settings/apps"); await page.waitForFunction(() => document.body.innerText.includes("Loading connections"));
  await page.screenshot({ path: `${out}/loading.png`, fullPage: true });
  mode = "error"; await held.respond({ status: 503, contentType: "application/json", body: '{"error":{"message":"Service temporarily unavailable"}}' });
  await page.waitForSelector(".state.error"); assert.equal(await page.$("article.conn"), null);
  await page.screenshot({ path: `${out}/server-error.png`, fullPage: true });
  mode = "offline"; await page.evaluate(() => document.querySelector(".state.error button").click());
  await page.waitForFunction(() => document.body.innerText.includes("offline")); await page.screenshot({ path: `${out}/offline.png`, fullPage: true });
  // Preserve disconnect behavior and show the genuine empty state from the server.
  page.removeAllListeners("request");
  await page.setRequestInterception(false);
  await owner.req("POST", `/api/connections/${firstInfo.connection.id}/revoke`, {});
  assert.equal((await firstAgent.call("connection_info", {})).status, 401);
  await page.reload(); await page.waitForFunction(() => document.body.innerText.includes("No active reader apps"));
  await page.screenshot({ path: `${out}/empty.png`, fullPage: true });
});
