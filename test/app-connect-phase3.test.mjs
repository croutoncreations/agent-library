// App Connect OAuth and consent (contract app-connect/0.4 §6-§10): owner-registered apps, publisher OAuth (/v1 audience),
// consent (project + optional folder/root), owner-approved resume, revocation and disabling, CORS.
// Isolated synthetic harness only (no existing credentials, loopback only).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomBytes } from "node:crypto";
import { startAppConnectServer } from "./fixtures/app-connect-harness.mjs";
import { ROOT, key, mcpClient, LOCAL_CONFIG } from "./helpers.mjs";
import { SERVER_PORTS } from "./ports.mjs";

const PORT = SERVER_PORTS.acp3, CB = "http://localhost:5173/agent-library/callback", ORIGIN = "http://localhost:5173";
const M = "agentlib.measurements/1";
let h, owner, app, app2, P;
const sha = (s) => createHash("sha256").update(s).digest("hex");
// Async on purpose: a synchronous child process blocks the event loop for seconds, so fetch cannot retire idle keep-alive
// sockets that wrangler dev (Node http, 5 s keepAliveTimeout) has already closed, and the next request fails "other side closed".
const sql = async (q) => (await promisify(execFile)("wrangler", ["d1", "--config", LOCAL_CONFIG, "execute", "DB", "--local", "--persist-to", h.dir, "--json", "--command", q], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1", NO_COLOR: "1" } })).stdout.toString();
const rows = async (q) => JSON.parse(await sql(q))[0].results;

before(async () => {
  h = await startAppConnectServer({ port: PORT });
  owner = await h.owner();
  for (const [id, title] of [["notes-test", "Notes"], ["other-test", "Other"]]) assert.equal((await owner.req("POST", "/api/projects", { id, title })).status, 201);
  app = await h.registerApp({ display_name: "Field Notes (local)", redirect_uris: [CB], origins: [ORIGIN] });
  app2 = await h.registerApp({ display_name: "Trip Log (local)", redirect_uris: ["http://127.0.0.1:5174/cb"], origins: [] });
  P = await h.connectPublisher(app, { project_id: "notes-test", destination: "new", new_folder_name: "Field Notes" });
});
after(async () => { await h?.stop(); });

test("committed configs: test hooks absent; no pruning possible (schema CHECK)", async () => {
  for (const f of ["wrangler.local.toml", "wrangler.example.toml", "scripts/self-host/setup.mjs"])
    assert.ok(!/AC_TEST_HOOKS/.test(readFileSync(join(ROOT, f), "utf8")), `test hooks never in ${f}`);
  // App Connect is opt-in per installation, never on in the local config (see app-connect-phase2.test.mjs).
  assert.equal(parseToml(readFileSync(join(ROOT, "wrangler.local.toml"), "utf8")).vars?.APP_CONNECT_ENABLED, undefined);
  // The CHECK constraint makes auto_prune_enabled = 1 impossible (wrangler reports it on stdout).
  await assert.rejects(() => sql(`INSERT INTO publishers (id, owner_principal_id, principal_id, app_client_id, display_name, project_id, created_at, auto_prune_enabled) VALUES ('pub_x','h','h','a','x','p','t',1)`),
    (e) => /CHECK constraint failed/.test(String(e.stdout) + String(e.stderr) + e.message));
});

test("app registration is owner-only; DCR cannot obtain publish; bad redirect/origin refused", async () => {
  const r = await fetch(`${h.appUi}/api/app-clients`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(r.status, 401);
  for (const bad of [{ redirect_uris: ["http://evil.example/cb"] }, { redirect_uris: ["https://x.example/cb#f"] }, { redirect_uris: [CB], origins: ["http://evil.example"] }, { redirect_uris: [] }])
    assert.equal((await owner.req("POST", "/api/app-clients", { display_name: "x", origins: [], ...bad })).status, 400, JSON.stringify(bad));
  const dcr = await fetch(`${h.issuer}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "sneaky", redirect_uris: ["http://127.0.0.1:5999/cb"], token_endpoint_auth_method: "none", scope: "agentlib:publish" }) });
  assert.equal(dcr.status, 400, "DCR with agentlib:publish refused");
  // A DCR client (no publish scope) can't get a /v1 token either.
  const dcr2 = await fetch(`${h.issuer}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "mcp-ish", redirect_uris: ["http://127.0.0.1:5999/cb"], token_endpoint_auth_method: "none" }) });
  const cid = (await dcr2.json()).client_id;
  const a = await h.authorize({ client_id: cid, redirect_uris: ["http://127.0.0.1:5999/cb"] }, {}, { resource: h.resource });
  assert.ok(!a.code, "unregistered app cannot reach publisher consent");
  assert.match(a.html ?? "", /not registered for publishing/);
});

test("OAuth: issuer/iss/state, /v1 audience, publish scope only, token separation from /mcp", async () => {
  assert.equal(P.iss, h.issuer); assert.equal(P.state, P.sentState);
  assert.equal(P.token.resource, h.resource); assert.equal(P.token.scope, "agentlib:publish offline_access");
  assert.equal(P.token.expires_in, 900); assert.ok(P.refresh_token);
  const prm = await (await fetch(`${h.issuer}/.well-known/oauth-protected-resource/v1`)).json();
  assert.equal(prm.resource, h.resource); assert.deepEqual(prm.authorization_servers, [h.issuer]);
  // publisher token on /mcp -> 401; on non-publisher /v1 -> 401 (those accept only alk_ keys)
  const mcp = await fetch(`${h.issuer}/mcp`, { method: "POST", headers: { authorization: `Bearer ${P.access_token}`, "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
  assert.equal(mcp.status, 401);
  assert.equal((await h.pub(P.access_token, "GET", "/projects")).status, 401);
  // wrong scope / extra scope / wrong redirect / wrong resource are refused before consent
  for (const opts of [{ scope: "agentlib:read" }, { scope: "agentlib:publish agentlib:write" }, { redirect_uri: "http://localhost:5173/other" }])
    assert.ok(!(await h.authorize(app, { project_id: "notes-test", destination: "root" }, opts)).code, JSON.stringify(opts));
  const toMcp = await h.authorize(app, { project_id: "notes-test", destination: "root" }, { resource: `${h.issuer}/mcp` });
  assert.ok(!toMcp.code && /only connect as a publisher/.test(toMcp.html));
  // anonymous publisher API -> 401 JSON challenge
  const anon = await h.pub(null, "GET", "/app");
  assert.equal(anon.status, 401); assert.match(anon.headers.get("www-authenticate") ?? "", /Bearer/);
});

test("consent page shows project/destination choices, first project preselected, Field Notes default, reader audience", async () => {
  const a = await h.authorize(app, { project_id: "notes-test", destination: "root", decision: "deny" });
  assert.equal(a.error_param, "access_denied"); assert.equal(a.code, null);
  const html = a.consentHtml;
  assert.match(html, /<option value="notes-test" selected>Notes/);
  assert.match(html, /name="new_folder_name"[^>]*value="Field Notes"/, "default folder name is the app name without its (suffix)");
  assert.match(html, /No folder \(project root\)/);
  // One folder field (hidden controls still submit; /authorize caps bodies at 16 KiB), grouped per project.
  assert.equal(html.match(/name="destination"/g).length, 1, "exactly one destination control");
  assert.doesNotMatch(html, /name="destination:/);
  assert.match(html, /<optgroup label="Folders in Notes" data-i="0"><option value="folder:fld_[^"]+">Field Notes</);
  assert.match(html, /including future exports/); assert.match(html, /cannot edit them/);
  assert.match(html, new RegExp(`name="resume" value="${P.publisher_id}">`), "earlier publisher offered for owner-approved resume, not preselected");
  assert.match(html, /Keep publishing to Notes \/ Field Notes/);
  assert.match(html, /name="resume" value="new" checked>/, "a new destination stays the default: resuming signs out the older session");
});

test("refresh: rotation, single use, resource pinned; resume is owner-approved, keeps identity, invalidates old tokens", async () => {
  const t1 = await h.token({ grant_type: "refresh_token", refresh_token: P.refresh_token, client_id: app.client_id });
  assert.equal(t1.status, 200, JSON.stringify(t1.body)); assert.notEqual(t1.body.refresh_token, P.refresh_token);
  const again = await h.token({ grant_type: "refresh_token", refresh_token: P.refresh_token, client_id: app.client_id });
  assert.equal(again.status, 400); assert.equal(again.body.error, "invalid_grant");
  const wrongRes = await h.token({ grant_type: "refresh_token", refresh_token: t1.body.refresh_token, client_id: app.client_id, resource: `${h.issuer}/mcp` });
  assert.ok([400].includes(wrongRes.status) && ["invalid_target", "invalid_grant"].includes(wrongRes.body.error), JSON.stringify(wrongRes.body));
  const at = t1.body.access_token;
  const before = (await h.pub(at, "GET", "/app")).json;
  // A plain reconnect (resume=new) creates a NEW publisher with separate files, never by name.
  const fresh = await h.connectPublisher(app, { project_id: "notes-test", destination: "root", resume: "new" });
  assert.notEqual(fresh.publisher_id, P.publisher_id);
  assert.equal((await h.pub(fresh.access_token, "GET", "/app/files")).json.files.length, 0);
  // Owner-approved resume of P: same id/project/folder/current revision; old access + refresh tokens stop working.
  const R = await h.connectPublisher(app, { resume: P.publisher_id });
  assert.equal(R.publisher_id, P.publisher_id);
  const after = (await h.pub(R.access_token, "GET", "/app")).json;
  assert.equal(after.publisher_id, before.publisher_id); assert.deepEqual(after.project, before.project); assert.deepEqual(after.folder, before.folder);
  assert.equal((await rows(`SELECT token_epoch AS e FROM publishers WHERE id = '${P.publisher_id}'`))[0].e, 2);
  assert.equal((await h.pub(at, "GET", "/app")).status, 401, "old access token dead after resume");
  assert.equal((await h.token({ grant_type: "refresh_token", refresh_token: t1.body.refresh_token, client_id: app.client_id })).status, 400, "old refresh dead");
  // resuming another app's publisher is impossible (only same-client publishers are offered/accepted)
  const Qid = (await rows(`SELECT id FROM publishers WHERE app_client_id = '${app2.app_client_id}'`))[0].id;
  const bad = await h.authorize(app, { resume: Qid });
  assert.ok(!bad.code && /can(&#39;|')t be resumed/.test(bad.html));
  P = { ...P, ...R };
});

test("revocation: publisher revoked -> 401 publisher_revoked, refresh invalid_grant, disabled app blocks connect", async () => {
  const X = await h.connectPublisher(app2, { project_id: "other-test", destination: "new", new_folder_name: "Trip Log" });
  assert.equal((await owner.req("POST", `/api/publishers/${X.publisher_id}/revoke`, {})).status, 200);
  const r = await h.pub(X.access_token, "GET", "/app");
  assert.equal(r.status, 401); assert.equal(r.json.error.code, "publisher_revoked"); assert.match(r.headers.get("www-authenticate"), /revoked/);
  assert.equal((await h.token({ grant_type: "refresh_token", refresh_token: X.refresh_token, client_id: app2.client_id })).body.error, "invalid_grant");
  const files = (await rows(`SELECT id FROM artifacts WHERE publisher_id = '${X.publisher_id}'`));
  assert.ok(files.length >= 3, "files remain after revocation");
  const own = await owner.req("PUT", `/api/projects/other-test/artifacts/${files[0].id}`, { expected_revision: 1, content: "{}" });
  assert.equal(own.body.error.code, "protected_source");
  assert.equal((await owner.req("POST", `/api/app-clients/${app2.app_client_id}/disable`, {})).status, 200);
  const blocked = await h.authorize(app2, { project_id: "other-test", destination: "root" });
  assert.ok(!blocked.code && /disabled/.test(blocked.html));
});

const APP_DISABLED_TEXT = "This app has been disabled by the owner of this library";
test("review F1: disabling an app client blocks every route and refresh for its existing connections; the browser can still read why", async () => {
  const app3 = await h.registerApp({ display_name: "Disable probe", redirect_uris: ["http://127.0.0.1:5175/cb"], origins: ["http://127.0.0.1:5175"] });
  const D = await h.connectPublisher(app3, { project_id: "other-test", destination: "root" });
  assert.equal((await owner.req("POST", `/api/app-clients/${app3.app_client_id}/disable`, {})).status, 200);
  for (const path of ["/app", "/app/files", "/app/connection-info"]) {
    const r = await h.pub(D.access_token, "GET", path);
    assert.equal(r.status, 401, `${path}: ${r.text}`); assert.equal(r.json.error.code, "unauthenticated", path);
    assert.equal(r.json.error.message, APP_DISABLED_TEXT, path);
    assert.match(r.headers.get("www-authenticate"), /^Bearer error="invalid_token"$/, path);
  }
  const w = await h.pub(D.access_token, "PUT", "/app/files/a.md", { body: undefined, idem: key("dis"), headers: { "content-type": "text/markdown", "if-none-match": "*", "content-length": "0" } });
  assert.equal(w.status, 401, w.text); assert.equal(w.json.error.message, APP_DISABLED_TEXT);
  const t = await h.token({ grant_type: "refresh_token", refresh_token: D.refresh_token, client_id: app3.client_id });
  assert.equal(t.status, 400, JSON.stringify(t.body)); assert.equal(t.body.error, "invalid_grant"); assert.equal(t.body.error_description, "App disabled by the owner");
  const pre = await fetch(`${h.api}/app`, { method: "OPTIONS", headers: { origin: "http://127.0.0.1:5175", "access-control-request-method": "GET" } });
  assert.equal(pre.status, 204, "CORS kept for a disabled app's live publisher");
  const cors = await h.pub(D.access_token, "GET", "/app", { headers: { origin: "http://127.0.0.1:5175" } });
  assert.equal(cors.status, 401); assert.equal(cors.headers.get("access-control-allow-origin"), "http://127.0.0.1:5175", "the browser can read the 401 body");
  assert.ok(!(await h.authorize(app3, { project_id: "other-test", destination: "root" })).code, "no new connection");
});

// Addendum B, D 2.
test("refresh of a disabled app's connection: invalid_grant, and the grant is gone", async () => {
  const appR = await h.registerApp({ display_name: "Disable refresh", redirect_uris: ["http://127.0.0.1:5179/cb"], origins: [] });
  const D = await h.connectPublisher(appR, { project_id: "other-test", destination: "root" });
  assert.equal((await owner.req("POST", `/api/app-clients/${appR.app_client_id}/disable`, {})).status, 200);
  const t = await h.token({ grant_type: "refresh_token", refresh_token: D.refresh_token, client_id: appR.client_id });
  assert.equal(t.status, 400, JSON.stringify(t.body)); assert.equal(t.body.error, "invalid_grant"); assert.equal(t.body.error_description, "App disabled by the owner");
  const t2 = await h.token({ grant_type: "refresh_token", refresh_token: D.refresh_token, client_id: appR.client_id });
  assert.equal(t2.status, 400, JSON.stringify(t2.body)); assert.equal(t2.body.error, "invalid_grant");
  assert.equal(t2.body.error_description, "Refresh token is no longer current", "the first refusal revoked the grant");
  assert.equal((await rows(`SELECT revoked_at FROM publishers WHERE id = '${D.publisher_id}'`))[0].revoked_at, null);
});

// Addendum B, D 3.
test("a code minted before the disable cannot be exchanged after it", async () => {
  const appC = await h.registerApp({ display_name: "Disable code", redirect_uris: ["http://127.0.0.1:5180/cb"], origins: [] });
  const a = await h.authorize(appC, { project_id: "other-test", destination: "root" });
  assert.ok(a.code, JSON.stringify(a.html ?? a.error));
  assert.equal((await owner.req("POST", `/api/app-clients/${appC.app_client_id}/disable`, {})).status, 200);
  const exchange = () => h.token({ grant_type: "authorization_code", code: a.code, redirect_uri: a.redirect_uri, client_id: appC.client_id, code_verifier: a.verifier, resource: h.resource });
  const t = await exchange();
  assert.equal(t.status, 400, JSON.stringify(t.body)); assert.equal(t.body.error, "invalid_grant"); assert.equal(t.body.error_description, "App disabled by the owner");
  assert.ok(t.body.access_token === undefined && t.body.refresh_token === undefined, "no token issued");
  const t2 = await exchange();
  assert.equal(t2.status, 400, JSON.stringify(t2.body)); assert.equal(t2.body.error, "invalid_grant"); assert.equal(t2.body.error_description, "Authorization code already used");
  assert.ok(t2.body.access_token === undefined && t2.body.refresh_token === undefined, "still no token");
});

// Addendum B, D 5.
test("revoked wins over disabled", async () => {
  const appV = await h.registerApp({ display_name: "Revoked then disabled", redirect_uris: ["http://127.0.0.1:5181/cb"], origins: [] });
  const D = await h.connectPublisher(appV, { project_id: "other-test", destination: "root" });
  assert.equal((await owner.req("POST", `/api/publishers/${D.publisher_id}/revoke`, {})).status, 200);
  assert.equal((await owner.req("POST", `/api/app-clients/${appV.app_client_id}/disable`, {})).status, 200);
  const r = await h.pub(D.access_token, "GET", "/app");
  assert.equal(r.status, 401, r.text); assert.equal(r.json.error.code, "publisher_revoked");
});

test("review F8: a publisher consent handle cannot be submitted as an MCP grant", async () => {
  const a = await h.authorize(app, { project_id: "notes-test", destination: "root" }, { stopAtConsent: true });
  const handle = (a.consentHtml.match(/name="handle" value="([^"]+)"/) ?? [])[1];
  assert.ok(handle);
  const r = await a.browser.go(`${h.issuer}/authorize`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ handle, step: "grant", "access:notes-test": "write", decision: "approve" }).toString() });
  assert.equal(r.status, 400); assert.match(await r.text(), /connects as a publisher/);
  assert.equal((await rows(`SELECT COUNT(*) AS n FROM oauth_connections WHERE resource LIKE '%/v1'`))[0].n, 0);
});

test("CORS: only registered origins, no credentials; preflight for token endpoint and the app API", async () => {
  const pre = await fetch(`${h.api}/app/files/a.md`, { method: "OPTIONS", headers: { origin: ORIGIN, "access-control-request-method": "PUT", "access-control-request-headers": "authorization,content-type,idempotency-key" } });
  assert.equal(pre.status, 204); assert.equal(pre.headers.get("access-control-allow-origin"), ORIGIN);
  assert.match(pre.headers.get("access-control-allow-headers"), /Idempotency-Key/); assert.equal(pre.headers.get("access-control-allow-credentials"), null);
  const evil = await fetch(`${h.api}/app/files/a.md`, { method: "OPTIONS", headers: { origin: "http://evil.example", "access-control-request-method": "PUT" } });
  assert.equal(evil.status, 403); assert.equal(evil.headers.get("access-control-allow-origin"), null);
  const real = await fetch(`${h.api}/app`, { headers: { origin: ORIGIN, authorization: `Bearer ${P.access_token}` } });
  assert.equal(real.headers.get("access-control-allow-origin"), ORIGIN);
  const realEvil = await fetch(`${h.api}/app`, { headers: { origin: "http://evil.example", authorization: `Bearer ${P.access_token}` } });
  assert.equal(realEvil.headers.get("access-control-allow-origin"), null);
  const tok = await fetch(`${h.issuer}/oauth/token`, { method: "OPTIONS", headers: { origin: ORIGIN, "access-control-request-method": "POST" } });
  assert.equal(tok.status, 204); assert.equal(tok.headers.get("access-control-allow-origin"), ORIGIN);
});

test("existing MCP OAuth clients unaffected: /mcp still the default resource, metadata adds /v1 only with the flag", async () => {
  const asm = await (await fetch(`${h.issuer}/.well-known/oauth-authorization-server`)).json();
  assert.ok(asm.protected_resources.includes(`${h.issuer}/mcp`) && asm.protected_resources.includes(h.resource));
  const prm = await (await fetch(`${h.issuer}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(prm.resource, `${h.issuer}/mcp`);
});

test("publisher consent: a fixable mistake re-renders with the error and the owner's choices; a folder from another project is refused inline", async () => {
  const a = await h.authorize(app, {}, { stopAtConsent: true });
  const handle = (a.consentHtml.match(/name="handle" value="([^"]+)"/) ?? [])[1];
  const post = (o) => a.browser.go(`${h.issuer}/authorize`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ handle, step: "publish", decision: "approve", ...o }).toString() });
  let r = await post({ resume: "new", project_id: "notes-test", destination: "new", new_folder_name: "Field Notes" });
  assert.equal(r.status, 400);
  const html = await r.text();
  assert.match(html, /role="alert"[^]*already exists in this project/);
  assert.match(html, /name="new_folder_name"[^>]*value="Field Notes"/);
  assert.match(html, new RegExp(`name="handle" value="${handle}"`));
  const fld = (html.match(/value="(folder:fld_[^"]+)">Field Notes</) ?? [])[1];
  r = await post({ resume: "new", project_id: "other-test", destination: fld });
  assert.equal(r.status, 400); assert.match(await r.text(), /role="alert"[^]*different project/);
  r = await post({ resume: "new", project_id: "other-test", destination: "root" });
  assert.equal(r.status, 200, "same handle succeeds after the fix");
  assert.match(await r.text(), /http-equiv="refresh"[^>]*code=/);
});

// Suggested destination (docs/app-connect.md#suggested-destination): the app's agentlib_* hint and the owner-set
// registration default only pre-fill the consent page; the owner's submitted choice always decides.
test("suggested destination: app hint and registration default pre-fill the consent page; owner choice wins", async () => {
  const owner = await h.owner();
  const proj = (html) => (html.match(/<option value="([^"]+)" selected>/) ?? [])[1];
  const folderName = (html) => (html.match(/name="new_folder_name"[^>]*value="([^"]*)"/) ?? [])[1];
  // Registration default: by project title (case-insensitive), with an invalid suggestion rejected at registration.
  assert.equal((await owner.req("POST", "/api/app-clients", { display_name: "Bad suggest", redirect_uris: ["http://127.0.0.1:5175/cb"], suggested_folder: "a/b" })).status, 400);
  const sApp = await h.registerApp({ display_name: "Suggest app (local)", redirect_uris: ["http://127.0.0.1:5175/cb"], origins: [], suggested_project: "other", suggested_folder: "Daily exports" });
  assert.equal(sApp.suggested_project, "other"); assert.equal(sApp.suggested_folder, "Daily exports");
  let c = await h.authorize(sApp, {}, { stopAtConsent: true });
  assert.equal(proj(c.consentHtml), "other-test", "registration default project (matched by title)");
  assert.equal(folderName(c.consentHtml), "Daily exports");
  assert.match(c.consentHtml, /<option value="new" selected>New folder/);
  // The app's own hint wins over the registration default; an existing folder of that name is pre-selected.
  c = await h.authorize(sApp, {}, { stopAtConsent: true, extraQuery: { agentlib_project: "notes-test", agentlib_folder: "field notes" } });
  assert.equal(proj(c.consentHtml), "notes-test", "app hint by project id");
  assert.match(c.consentHtml, /<option value="folder:fld_[^"]+" selected>Field Notes</, "existing folder (case-insensitive) pre-selected");
  // Unknown project falls back to the first project; hostile/oversized hints are ignored and escaped, never errors.
  c = await h.authorize(sApp, {}, { stopAtConsent: true, extraQuery: { agentlib_project: "no-such-project", agentlib_folder: "<script>x</script>" } });
  assert.equal(proj(c.consentHtml), "notes-test", "unknown project -> first project");
  // "/" is not allowed in folder names, so this hint is dropped and the registration default is used.
  assert.doesNotMatch(c.consentHtml, /<script>x/); assert.equal(folderName(c.consentHtml), "Daily exports");
  c = await h.authorize(sApp, {}, { stopAtConsent: true, extraQuery: { agentlib_folder: "<b>\"x\"" } });
  assert.doesNotMatch(c.consentHtml, /<b>"x"/); assert.equal(folderName(c.consentHtml), "&#60;b&#62;&#34;x&#34;", "hint is HTML-escaped");
  c = await h.authorize(sApp, {}, { stopAtConsent: true, extraQuery: { agentlib_folder: "x".repeat(81) } });
  assert.equal(folderName(c.consentHtml), "Daily exports", "oversized hint ignored; registration default used");
  // Owner overrides: a different project and folder name than suggested.
  const a = await h.authorize(sApp, { project_id: "notes-test", destination: "new", new_folder_name: "Owner pick" }, { extraQuery: { agentlib_project: "other-test", agentlib_folder: "App pick" } });
  assert.ok(a.code, a.html);
  const t = await h.token({ grant_type: "authorization_code", code: a.code, redirect_uri: a.redirect_uri, client_id: sApp.client_id, code_verifier: a.verifier, resource: h.resource });
  const me = (await h.pub(t.body.access_token, "GET", "/app")).json;
  assert.equal(me.project.id, "notes-test"); assert.equal(me.folder.name, "Owner pick");
  // Owner can change or clear the registration default.
  const up = await owner.req("PUT", `/api/app-clients/${sApp.app_client_id}`, { suggested_project: "", suggested_folder: "Renamed" });
  assert.equal(up.status, 200, JSON.stringify(up.body)); assert.equal(up.body.suggested_project, null); assert.equal(up.body.suggested_folder, "Renamed");
  assert.equal((await owner.req("PUT", `/api/app-clients/${sApp.app_client_id}`, { suggested_folder: "x".repeat(81) })).status, 400);
  assert.equal((await owner.req("PUT", "/api/app-clients/apc_nope", { suggested_folder: "x" })).status, 404);
  c = await h.authorize(sApp, {}, { stopAtConsent: true });
  assert.equal(proj(c.consentHtml), "notes-test"); assert.equal(folderName(c.consentHtml), "Renamed");
});

