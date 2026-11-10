// Lists that used to cut off silently, against a real local server (App Connect on, so folders and the publishing
// consent page exist): comments page with next_cursor (app API and legacy MCP list_comments, real SDK client) and the
// UI's "Show older comments"; at most 1,000 folders per project on every creation path (409 too_many_folders, consent
// page error) and lists that show all of them; capped lists report `truncated: [names]`, and the UI shows
// "Showing the first N". Also: tags up to 50 characters, and the 2 MiB app/legacy-MCP body caps count UTF-8 bytes.
// Rows past a cap are inserted with wrangler d1 execute (synthetic data only). Real Chrome for the UI checks.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { key, mcpClient, LOCAL_CONFIG, ROOT } from "./helpers.mjs";
import { SERVER_PORTS } from "./ports.mjs";
import { startAppConnectServer } from "./fixtures/app-connect-harness.mjs";

const PORT = SERVER_PORTS["list-limits"];
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PUP = `${process.env.HOME}/.npm-packages/lib/node_modules/puppeteer`;
const haveChrome = existsSync(CHROME) && existsSync(PUP);
let h, owner, me, P, doc;
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
// Async on purpose (see project-deletion.test.mjs): a synchronous child process stalls keep-alive sockets.
const sql = async (q) => JSON.parse((await promisify(execFile)("wrangler", ["d1", "--config", LOCAL_CONFIG, "execute", "DB", "--local", "--persist-to", h.dir, "--json", "--command", q],
  { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })).stdout)[0].results;
// One multi-row INSERT ... SELECT over a counter (recursive CTE), so thousands of rows need one wrangler call.
const series = (n) => `WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < ${n})`;

before(async () => {
  h = await startAppConnectServer({ port: PORT });
  owner = await h.owner();
  me = ok(await owner.req("GET", "/api/me")).principal.id;
  P = ok(await owner.req("POST", "/api/projects", { title: "Limits" }), 201).id;
  doc = ok(await owner.req("POST", `/api/projects/${P}/artifacts`, { title: "Commented", body: "synthetic" }), 201).artifact_id;
});
after(async () => { await h?.stop(); });

test("comments: newest 200 (oldest first), next_cursor pages back in created_at,id order; app API and legacy MCP", async () => {
  // 450 comments: 449 share one timestamp in groups (ties ordered by id), plus one through the API (newest).
  await sql(`${series(449)} INSERT INTO comments (id, project_id, artifact_id, rev_no, author_id, body, created_at)
    SELECT printf('cmt_%04d', i), '${P}', '${doc}', 1, '${me}', 'synthetic comment ' || i, printf('2026-01-01T00:00:%02d.000Z', i / 10) FROM s`);
  ok(await owner.req("POST", `/api/projects/${P}/artifacts/${doc}/comments`, { revision: 1, body: "newest synthetic comment" }), 201);
  const pages = [];
  let cursor = null;
  do {
    const r = ok(await owner.req("GET", `/api/projects/${P}/artifacts/${doc}/comments${cursor ? "?cursor=" + encodeURIComponent(cursor) : ""}`));
    pages.push(r.comments); cursor = r.next_cursor;
  } while (cursor && pages.length < 10);
  assert.deepEqual(pages.map((p) => p.length), [200, 200, 50]);
  assert.equal(pages[0].at(-1).body, "newest synthetic comment", "the first page ends with the newest");
  const all = pages.reverse().flat();
  assert.equal(new Set(all.map((c) => c.id)).size, 450, "no comment repeated or skipped");
  const key2 = (c) => c.created_at + "|" + c.id;
  assert.deepEqual(all.map(key2), [...all.map(key2)].sort(), "chronological (created_at, id) across pages");
  assert.equal(ok(await owner.req("GET", `/api/projects/${P}/artifacts/${doc}/comments?cursor=not*valid`), 400).error.code, "invalid_cursor");
  // A small list is the same as before plus next_cursor: null.
  const d2 = ok(await owner.req("POST", `/api/projects/${P}/artifacts`, { title: "Few", body: "x" }), 201).artifact_id;
  ok(await owner.req("POST", `/api/projects/${P}/artifacts/${d2}/comments`, { revision: 1, body: "one" }), 201);
  const few = ok(await owner.req("GET", `/api/projects/${P}/artifacts/${d2}/comments`));
  assert.deepEqual(Object.keys(few).sort(), ["comments", "next_cursor"]);
  assert.equal(few.next_cursor, null);
  // Legacy MCP (grant token, official SDK client): the same pages.
  const g = ok(await owner.req("POST", `/api/projects/${P}/grants`, { label: "comments reader", can_write: false }), 201);
  const m = await mcpClient(h.appUi, g.token, "comments-reader");
  try {
    const tool = (await m.client.listTools()).tools.find((t) => t.name === "list_comments");
    assert.equal(tool.inputSchema.properties.cursor.type, "string");
    const a = await m.call("list_comments", { project_id: P, artifact_id: doc });
    assert.equal(a.data.comments.length, 200);
    const b = await m.call("list_comments", { project_id: P, artifact_id: doc, cursor: a.data.next_cursor });
    assert.equal(b.data.comments.length, 200);
    assert.ok(b.data.comments.at(-1).created_at <= a.data.comments[0].created_at);
  } finally { await m.close(); }
});

test("MCP add_comment then list_comments round-trips UTF-8 through the real SDK", async () => {
  const g = ok(await owner.req("POST", `/api/projects/${P}/grants`, { label: "comments writer", can_write: true }), 201);
  const m = await mcpClient(h.appUi, g.token, "comments-writer");
  const aid = ok(await owner.req("POST", `/api/projects/${P}/artifacts`, { title: "MCP comments", body: "synthetic" }), 201).artifact_id;
  try {
    const body = "MCP café 🙂 漢字";
    const added = await m.call("add_comment", { project_id: P, artifact_id: aid, revision: 1, body, idempotency_key: key("comment") });
    assert.ok(added.data.comment_id);
    const listed = await m.call("list_comments", { project_id: P, artifact_id: aid });
    assert.equal(listed.data.comments.find(c => c.id === added.data.comment_id)?.body, body);
  } finally { await m.close(); }
});

test("folders: 1,000 per project on create (409 too_many_folders, also /v1 and the consent page); lists show all 1,000", async () => {
  const F = ok(await owner.req("POST", "/api/projects", { title: "Folders" }), 201).id;
  ok(await owner.req("POST", `/api/projects/${F}/folders`, { name: "First" }), 201);
  // Folders in another project that sort before F's: the consent picker's cap is per project, so F still shows all of its own.
  await sql(`${series(5)} INSERT INTO folders (id, project_id, name, name_key, created_at, created_by) SELECT printf('fld_lla%04d', i), '${P}', printf('Aaa %04d', i), printf('aaa %04d', i), '2026-01-01T00:00:00.000Z', '${me}' FROM s`);
  await sql(`${series(999)} INSERT INTO folders (id, project_id, name, name_key, created_at, created_by) SELECT printf('fld_ll%04d', i), '${F}', printf('Folder %04d', i), printf('folder %04d', i), '2026-01-01T00:00:00.000Z', '${me}' FROM s`);
  const full = await owner.req("POST", `/api/projects/${F}/folders`, { name: "One too many" });
  assert.equal(full.status, 409, JSON.stringify(full.body));
  assert.deepEqual([full.body.error.code, full.body.error.message], ["too_many_folders", "A project can have up to 1,000 folders"]);
  assert.equal(ok(await owner.req("GET", `/api/projects/${F}/folders`)).folders.length, 1000, "every folder listed");
  // /v1 (API key): same service, same refusal.
  const k = ok(await owner.req("POST", "/api/api-keys", { label: "folders key", projects: [{ project_id: F, access: "read_write" }] }), 201).secret;
  const v1 = await fetch(`${h.api}/projects/${F}/folders`, { method: "POST", headers: { authorization: `Bearer ${k}`, "content-type": "application/json", "idempotency-key": key("f") }, body: JSON.stringify({ name: "Via v1" }) });
  assert.equal(v1.status, 409); assert.equal((await v1.json()).error.code, "too_many_folders");
  const list = await fetch(`${h.api}/projects/${F}/folders`, { headers: { authorization: `Bearer ${k}` } });
  assert.equal((await list.json()).folders.length, 1000);
  // Publishing consent: a new folder is refused with a page the owner can act on; an existing one still works.
  const app = await h.registerApp({ display_name: "Folder Cap App", redirect_uris: ["http://127.0.0.1:5994/cb"], origins: [] });
  const a = await h.authorize(app, { project_id: F, destination: "new", new_folder_name: "Another" });
  assert.equal(a.error, 400);
  assert.match(a.html, /already has 1,000 folders, the most a project can have/);
  assert.equal(await sql(`SELECT COUNT(*) AS n FROM folders WHERE project_id = '${F}'`).then((r) => r[0].n), 1000, "nothing created");
  const group = (pid) => a.consentHtml.match(new RegExp(`<optgroup label="Folders in ${pid === F ? "Folders" : "Limits"}"[^>]*>(.*?)</optgroup>`))?.[1] ?? "";
  assert.equal((group(F).match(/value="folder:fld_/g) ?? []).length, 1000, "the consent picker lists all 1,000 of the capped project's folders");
  assert.equal((group(P).match(/value="folder:fld_lla/g) ?? []).length, 5, "and the other project's folders");
  const pub = await h.connectPublisher(app, { project_id: F, destination: "folder:fld_ll0001" });
  assert.ok(pub.publisher_id);
  if (haveChrome) {
    const browser = await createRequire(import.meta.url)(PUP).launch({ executablePath: CHROME, headless: true, args: ["--no-first-run"] });
    try {
      const page = await browser.newPage();
      // Reduced motion: the consent card's fade-in is off, so the screenshot shows the settled page.
      await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
      for (const [w, name] of [[1280, "desktop"], [390, "mobile"]]) {
        await page.setViewport({ width: w, height: 900 });
        await page.setContent(a.html.replace(/<meta http-equiv="refresh"[^>]*>/, ""));
        await page.waitForSelector('[role="alert"]');
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `no horizontal scroll at ${w}`);
        await page.screenshot({ path: `tmp/test-evidence/limits-folder-cap-${name}.png`, fullPage: false });
      }
    } finally { await browser.close(); }
  }
});

test("capped lists say truncated: [names]; complete lists say []", async () => {
  // Defaults: everything complete.
  assert.deepEqual(ok(await owner.req("GET", "/api/projects")).truncated, []);
  assert.deepEqual(ok(await owner.req("GET", "/api/workspaces")).truncated, []);
  assert.deepEqual(ok(await owner.req("GET", "/api/api-keys")).truncated, []);
  assert.deepEqual(ok(await owner.req("GET", "/api/access")).truncated, []);
  assert.deepEqual(ok(await owner.req("GET", "/api/app-clients")).truncated, []);
  assert.deepEqual(ok(await owner.req("GET", `/api/projects/${P}/connections`)).truncated, []);
  assert.deepEqual(ok(await owner.req("GET", `/api/projects/${P}/audit`)).truncated, []);
  const W = ok(await owner.req("POST", "/api/workspaces", { name: "Big Team" }), 201).id;
  const mem = ok(await owner.req("GET", `/api/workspaces/${W}/members`));
  assert.deepEqual(mem.truncated, []);
  assert.deepEqual(ok(await owner.req("GET", `/api/workspaces/${W}/deleted-projects`)).truncated, []);
  // Past each cap (synthetic rows).
  const now = Date.now(), at = "2026-01-02T00:00:00.000Z";
  await sql(`${series(501)} INSERT INTO principals (id, kind, issuer, subject, label, created_at) SELECT printf('hum_ll%04d', i), 'human', 'synthetic', printf('ll%04d', i), printf('Member %04d', i), '${at}' FROM s`);
  await sql(`${series(501)} INSERT INTO workspace_members (workspace_id, principal_id, role, added_by, created_at) SELECT '${W}', printf('hum_ll%04d', i), 'viewer', '${me}', '${at}' FROM s`);
  await sql(`${series(201)} INSERT INTO workspace_invites (id, workspace_id, email, role, token_hash, invited_by, created_at, expires_at) SELECT printf('inv_ll%04d', i), '${W}', printf('i%04d@example.test', i), 'viewer', printf('tok%04d', i), '${me}', '${at}', ${now + 864e5} FROM s`);
  await sql(`${series(1001)} INSERT INTO projects (id, owner_id, title, created_at, workspace_id) SELECT printf('prj_ll%04d', i), '${me}', printf('Project %04d', i), '${at}', '${W}' FROM s`);
  await sql(`${series(201)} INSERT INTO projects (id, owner_id, title, created_at, workspace_id, deleted_at, deleted_by, purge_at) SELECT printf('prj_lld%04d', i), '${me}', printf('Deleted %04d', i), '${at}', '${W}', ${now - 1000} - i, '${me}', ${now + 864e5} FROM s`);
  await sql(`${series(201)} INSERT INTO principals (id, kind, issuer, subject, label, created_at) SELECT printf('agt_ll%04d', i), 'agent', 'synthetic', printf('agt%04d', i), 'k', '${at}' FROM s`);
  await sql(`${series(201)} INSERT INTO api_credentials (id, owner_principal_id, principal_id, label, token_hash, created_at, expires_at, workspace_id, created_by) SELECT printf('akey_ll%04d', i), '${me}', printf('agt_ll%04d', i), printf('Key %04d', i), printf('kh%04d', i), '${at}', ${now + 864e5}, '${W}', '${me}' FROM s`);
  await sql(`${series(201)} INSERT INTO oauth_connections (id, owner_principal_id, project_id, client_id, client_name, redirect_uri, resource, can_read, can_write, created_at, expires_at, workspace_id, created_by) SELECT printf('oac_ll%04d', i), '${me}', '${P}', 'c', printf('Conn %04d', i), 'https://example.test/cb', 'r', 1, 0, '${at}', ${now + 864e5}, NULL, '${me}' FROM s`);
  await sql(`${series(201)} INSERT INTO oauth_connection_projects (connection_id, project_id, can_write) SELECT printf('oac_ll%04d', i), '${P}', 0 FROM s`);
  await sql(`${series(201)} INSERT INTO grants (id, project_id, principal_id, token_hash, can_write, expires_at, created_by, created_at) SELECT printf('grt_ll%04d', i), '${P}', printf('agt_ll%04d', i), printf('gh%04d', i), 0, ${now + 864e5}, '${me}', '${at}' FROM s`);
  await sql(`${series(101)} INSERT INTO app_clients (id, owner_principal_id, client_id, display_name, redirect_uris, origins, created_at) SELECT printf('apc_ll%04d', i), '${me}', printf('cid_ll%04d', i), printf('App %04d', i), '[]', '[]', '${at}' FROM s`);
  await sql(`${series(201)} INSERT INTO workspaces (id, name, personal, created_by, created_at) SELECT printf('wsp_ll%04d', i), printf('Team %04d', i), 0, '${me}', '${at}' FROM s`);
  await sql(`${series(201)} INSERT INTO workspace_members (workspace_id, principal_id, role, added_by, created_at) SELECT printf('wsp_ll%04d', i), '${me}', 'member', '${me}', '${at}' FROM s`);
  await sql(`${series(201)} INSERT INTO audits (at, actor_id, project_id, action, object_id, result, request_id) SELECT '${at}', '${me}', '${P}', 'synthetic', NULL, 'ok', 'req' FROM s`);

  const m = ok(await owner.req("GET", `/api/workspaces/${W}/members`));
  assert.deepEqual([m.members.length, m.invites.length, m.truncated], [500, 200, ["members", "invites"]]);
  const pr = ok(await owner.req("GET", "/api/projects"));
  assert.deepEqual([pr.projects.length, pr.truncated], [1000, ["projects"]]);
  const dl = ok(await owner.req("GET", `/api/workspaces/${W}/deleted-projects`));
  assert.deepEqual([dl.projects.length, dl.truncated], [200, ["projects"]]);
  const ks = ok(await owner.req("GET", "/api/api-keys"));
  assert.deepEqual([ks.keys.length, ks.truncated], [200, ["keys"]]);
  const ac = ok(await owner.req("GET", "/api/access"));
  assert.deepEqual([ac.connections.length, ac.grants.length, ac.truncated], [200, 200, ["connections", "grants"]]);
  const pc = ok(await owner.req("GET", `/api/projects/${P}/connections`));
  assert.deepEqual([pc.connections.length, pc.truncated], [100, ["connections"]]);
  const apps = ok(await owner.req("GET", "/api/app-clients"));
  assert.deepEqual([apps.app_clients.length, apps.truncated], [100, ["app_clients"]]);
  const ws = ok(await owner.req("GET", "/api/workspaces"));
  assert.deepEqual([ws.workspaces.length, ws.truncated], [200, ["workspaces"]]);
  const au = ok(await owner.req("GET", `/api/projects/${P}/audit`));
  assert.deepEqual([au.audits.length, au.truncated], [200, ["audits"]]);
  // The consent pages list the first 500 projects and say so (agent grant page and publishing page).
  const pubApp = await h.registerApp({ display_name: "Many Projects App", redirect_uris: ["http://127.0.0.1:5994/cb"], origins: [] });
  const consent = await h.authorize(pubApp, {}, { stopAtConsent: true });
  assert.match(consent.consentHtml, /Showing the first 500 projects\./);
  assert.equal((consent.consentHtml.match(/<option value="prj_/g) ?? []).length, 500);
  if (!haveChrome) return;
  const browser = await createRequire(import.meta.url)(PUP).launch({ executablePath: CHROME, headless: true, args: ["--no-first-run"] });
  try {
    const page = await browser.newPage();
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    await page.goto(h.appUi + "/");
    await page.evaluate(async (passphrase) => fetch("/auth/dev-login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase }) }), h.passphrase());
    const note = (sel) => page.evaluate((s) => [...document.querySelectorAll(".truncated-note")].map((e) => e.textContent).filter((t) => t.includes(s)), sel);
    for (const [w, name] of [[1280, "desktop"], [390, "mobile"]]) {
      await page.setViewport({ width: w, height: 900 });
      await page.goto(`${h.appUi}/#/workspaces/${W}`); await page.reload();
      await page.waitForFunction(() => document.querySelectorAll(".truncated-note").length >= 4, { timeout: 30_000 });
      assert.deepEqual(await note("members"), ["Showing the first 500 members."]);
      assert.deepEqual(await note("invitations"), ["Showing the 200 most recent pending invitations."]);
      assert.deepEqual(await note("deleted"), ["Showing the first 200 deleted projects."]);
      assert.deepEqual(await note("open"), ["Showing the first 1,000 projects you can open."]);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `no horizontal scroll at ${w}`);
      await (await page.$("xpath/.//p[contains(@class,'truncated-note')][contains(., 'members')]")).evaluate((e) => e.scrollIntoView({ block: "center" }));
      await page.screenshot({ path: `tmp/test-evidence/limits-truncated-members-${name}.png` });
    }
    await page.setViewport({ width: 1280, height: 900 });
    for (const [hash, text] of [["#/settings/api-keys", "Showing the first 200 API keys."], ["#/settings/apps", "Showing the first 200 connections."],
      ["#/settings/tokens", "Showing the first 200 agent tokens."], ["#/projects", "Showing the first 1,000 projects you can open."]]) {
      await page.goto(h.appUi + "/" + hash);
      await page.waitForFunction((t) => [...document.querySelectorAll(".truncated-note")].some((e) => e.textContent === t), { timeout: 30_000 }, text);
    }
  } finally { await browser.close(); }
});

test("UI: comments are newest first under the comment box; \"Show older comments\" below the list appends earlier pages (desktop and mobile)", async (t) => {
  if (!haveChrome) return t.skip("Chrome/puppeteer not installed");
  mkdirSync("tmp/test-evidence", { recursive: true });
  const browser = await createRequire(import.meta.url)(PUP).launch({ executablePath: CHROME, headless: true, args: ["--no-first-run"] });
  try {
    const page = await browser.newPage();
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    await page.goto(h.appUi + "/");
    await page.evaluate(async (passphrase) => fetch("/auth/dev-login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase }) }), h.passphrase());
    for (const [w, name] of [[1280, "desktop"], [390, "mobile"]]) {
      await page.setViewport({ width: w, height: 900 });
      await page.goto(`${h.appUi}/#/p/${P}/a/${doc}`); await page.reload();
      await page.waitForFunction(() => [...document.querySelectorAll("[role=tab]")].some((t) => t.textContent.trim() === "Comments"), { timeout: 30_000 });
      await page.evaluate(() => [...document.querySelectorAll("[role=tab]")].find((t) => t.textContent.trim() === "Comments").click());
      const older = await page.waitForSelector("button.com-older:not([hidden])");
      const LIST = "ul.com-list";
      const rows = () => page.evaluate((l) => document.querySelector(l).children.length, LIST);
      assert.equal(await rows(), 200);
      const panel = await page.evaluateHandle(() => document.querySelector("button.com-older").closest("[role=tabpanel]"));
      // Layout: comment box, then the list (newest first), then the button.
      assert.equal(await panel.evaluate((p) => { const f = p.querySelector("form"), l = p.querySelector("ul.com-list"), b = p.querySelector("button.com-older");
        return !!(f.compareDocumentPosition(l) & Node.DOCUMENT_POSITION_FOLLOWING) && !!(l.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING); }), true);
      assert.equal(await page.$eval(`${LIST} li:first-child .raw-text`, (e) => e.textContent), "newest synthetic comment");
      await older.evaluate((b) => b.scrollIntoView({ block: "center" }));
      await page.screenshot({ path: `tmp/test-evidence/limits-comments-load-more-${name}.png` });
      await older.evaluate((b) => b.click());
      const list = LIST;
      await page.waitForFunction((l) => document.querySelector(l).children.length === 400, {}, list);
      // Focus is on the first comment of the loaded page (the 201st row); the status next to the button says how many loaded.
      assert.equal(await page.evaluate((l) => document.activeElement === document.querySelector(l).children[200], list), true);
      assert.equal(await page.$eval("button.com-older + .msg", (e) => [e.textContent, e.getAttribute("aria-live")].join("|")), "Loaded 200 older comments|polite");
      assert.equal(await page.$eval(list, (e) => e.hasAttribute("aria-busy")), false);
      assert.match(await page.$eval(`${list} li .muted`, (e) => e.textContent), /^.* · rev 1 · /);
      await older.evaluate((b) => b.click());
      await page.waitForFunction((l) => document.querySelector(l).children.length === 450, {}, list);
      assert.equal(await page.$eval("button.com-older", (b) => b.hidden), true, "no more pages");
      const texts = await panel.evaluate((p) => [...p.querySelectorAll(".raw-text")].map((e) => e.textContent));
      assert.equal(texts[0], "newest synthetic comment");
      // Newest to oldest, all the way down: comments 450..1 after the newest (seeded oldest = 1).
      assert.equal(texts[1], "synthetic comment 449"); assert.equal(texts.at(-1), "synthetic comment 1");
      assert.equal(new Set(texts).size, 450);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `no horizontal scroll at ${w}`);
    }
  } finally { await browser.close(); }
});

test("tags: up to 50 characters (as backup import); 51 refused", async () => {
  const a = ok(await owner.req("GET", `/api/projects/${P}/artifacts/${doc}`)).artifact;
  const t50 = "t".repeat(50);
  const r = ok(await owner.req("PATCH", `/api/projects/${P}/artifacts/${doc}`, { expected_meta_version: a.meta_version, tags: [t50] }));
  assert.deepEqual(r.tags, [t50]);
  const bad = await owner.req("PATCH", `/api/projects/${P}/artifacts/${doc}`, { expected_meta_version: r.meta_version, tags: ["t".repeat(51)] });
  assert.equal(bad.status, 413); assert.match(bad.body.error.message, /tag exceeds 50 characters/);
});

test("request bodies: the 2 MiB app API and legacy MCP caps count UTF-8 bytes, not characters", async () => {
  // 0.8 Mi characters of "€" = 2.4 MiB of UTF-8: under the cap by characters, over it by bytes.
  const big = "€".repeat(800 * 1024);
  const r = await owner.req("POST", `/api/projects/${P}/artifacts`, { title: "Too big", body: big });
  assert.equal(r.status, 413); assert.equal(r.body.error.code, "too_large");
  const g = ok(await owner.req("POST", `/api/projects/${P}/grants`, { label: "body cap", can_write: true }), 201);
  const mcp = await fetch(`${h.appUi}/mcp`, { method: "POST", headers: { authorization: `Bearer ${g.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_markdown", arguments: { project_id: P, title: "x", body: big, idempotency_key: key("b") } } }) });
  assert.equal(mcp.status, 413);
  // A multi-byte body under both caps still works (800 KiB of UTF-8; the exact boundary is in retention-cleanup.test.mjs).
  const okBody = await owner.req("POST", `/api/projects/${P}/artifacts`, { title: "Fits", body: "é".repeat(400 * 1024) });
  assert.equal(okBody.status, 201, JSON.stringify(okBody.body));
});
