// Deleting a project (decision D21 B, docs/workspaces.md#deleting-a-project) against a real local server: delete closes
// it to everyone at once (people, API keys, legacy grants, OAuth agents and publishers: same 404 as a project that
// never existed), frees its projects-limit slot and its address, and can be restored within 30 days with everything
// back, including agent access. After the retention period (or "delete permanently") the cron removes its rows and R2
// files and keeps a tombstone. Only workspace admins can delete, restore or purge, and only with the typed name.
// Synthetic data only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { key, sha256, mcpClient, LOCAL_CONFIG, ROOT } from "./helpers.mjs";
import { SERVER_PORTS } from "./ports.mjs";
import { makePng } from "./make-fixtures.mjs";
import { startAppConnectServer } from "./fixtures/app-connect-harness.mjs";

const PORT = SERVER_PORTS["project-deletion"];
let h, owner, bob, carol, WS, P = {}, cred = {};
const png = makePng(8, 8);
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
// Async on purpose (as in app-connect-phase3.test.mjs): a synchronous child process blocks the event loop for seconds,
// so fetch can't retire keep-alive sockets wrangler dev has already closed, and the next request fails ECONNRESET.
const sql = async (q) => JSON.parse((await promisify(execFile)("wrangler", ["d1", "--config", LOCAL_CONFIG, "execute", "DB", "--local", "--persist-to", h.dir, "--json", "--command", q],
  { cwd: ROOT, encoding: "utf8" })).stdout)[0].results;
const n = async (q) => (await sql(q))[0].n;
async function http(base, token, method, path, body) {
  const hd = { authorization: `Bearer ${token}` };
  if (body !== undefined) { hd["content-type"] = "application/json"; hd["idempotency-key"] = key("pd"); }
  const r = await fetch(base + path, { method, headers: hd, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, text: await r.text() };
}
const sha = (s) => createHash("sha256").update(s).digest("hex");
// A publisher commits one generation (two JSON parts) into the project, so the purge has generations and a snapshot.
async function publishGeneration(pub) {
  const gid = "g_pd", data = JSON.stringify({ format: "agentlib.generation.part/1", generation_id: gid, source_revision: 1, records: [{ synthetic: true }] });
  const root = JSON.stringify({ format: "agentlib.generation.index/1", generation_id: gid, source_revision: 1,
    entries: [{ name: "part.json", sha256: sha(data), bytes: Buffer.byteLength(data), kind: "synthetic", count: 1, file: "part.json", utf8_bytes: Buffer.byteLength(data) }] });
  const base = "/publisher/generations";
  let x = await h.pub(pub.access_token, "POST", base, { body: { generation_id: gid, source_revision: 1, expected_current_snapshot_id: null, root_name: "root.json",
    root_sha256: sha(root), part_count: 2, total_bytes: Buffer.byteLength(data) + Buffer.byteLength(root) }, idem: key() });
  assert.equal(x.status, 201, JSON.stringify(x.json));
  for (const [name, content] of [["part.json", data], ["root.json", root]]) {
    x = await h.pub(pub.access_token, "PUT", `${base}/${gid}/parts/${name}`, { body: { content, sha256: sha(content), bytes: Buffer.byteLength(content) } });
    assert.ok([200, 201].includes(x.status), JSON.stringify(x.json));
  }
  x = await h.pub(pub.access_token, "POST", `${base}/${gid}/commit`, { body: {}, idem: key() });
  assert.equal(x.status, 201, JSON.stringify(x.json));
}
// MCP tool errors carry the HTTP-like status and code; a refusal must be a real not_found/forbidden, not a crash.
const toolCode = (r) => r.data?.error?.code ?? r.data?.code ?? null;
const toolStatus = (r) => !r.isError ? 200 : (r.data?.error?.status ?? r.data?.status ?? (r.status >= 400 ? r.status : 500));
// Every way to reach a project, per credential. Each returns an HTTP status.
const reach = {
  bob: (p, d) => bob.req("GET", `/api/projects/${p}/artifacts/${d}`).then((r) => r.status),
  bobAddress: async (path) => (await bob.req("GET", `/api/projects/${encodeURIComponent(path)}/artifacts`)).status,
  key: (p, d) => http(h.issuer, cred.key, "GET", `/v1/projects/${p}/files/${d}`).then((r) => r.status),
  grant: (p, d) => http(h.appUi, cred.grant, "GET", `/api/projects/${p}/artifacts/${d}`).then((r) => r.status),
  oauth: async (p, d) => { const r = await cred.oauth.call("read_artifact", { project_id: p, artifact_id: d }); const s = toolStatus(r); return s === 200 ? 200 : `${s}:${toolCode(r)}`; },
  publisher: async () => (await h.pub(cred.pub.access_token, "GET", "/publisher/me")).status,
  // The SDK client throws when the server refuses the token itself (401 at the transport).
  grantMcp: async (p, d) => { try { return toolStatus(await cred.grantMcp.call("read_artifact", { project_id: p, artifact_id: d })); } catch (e) { return /401|-32001/.test(String(e.message)) ? 401 : 500; } },
};

before(async () => {
  h = await startAppConnectServer({ port: PORT });
  owner = await h.owner();
  // Link the owner's upstream sign-in while they are the only person, then add the others.
  const scratch = ok(await owner.req("POST", "/api/projects", { title: "Scratch" }), 201).id;
  await h.connectMcpAgent({ [scratch]: "read" }, { clientName: "link" });
  bob = await h.person("bob"); carol = await h.person("carol");
  WS = ok(await owner.req("POST", "/api/workspaces", { name: "Delete Team" }), 201).id;
  for (const [who, role] of [[bob, "admin"], [carol, "member"]]) {
    const inv = ok(await owner.req("POST", `/api/workspaces/${WS}/invites`, { email: `${who === bob ? "bob" : "carol"}@example.test`, role }), 201);
    ok(await who.req("POST", "/api/invites/accept", { token: inv.accept_url.split("/").pop() }));
  }
  const p = ok(await owner.req("POST", "/api/projects", { title: "Old Notes", workspace_id: WS }), 201);
  P.id = p.id; P.path = p.path; P.slug = p.slug;
  P.doc = ok(await owner.req("POST", `/api/projects/${P.id}/artifacts`, { title: "Synthetic doc", body: "synthetic one" }), 201).artifact_id;
  ok(await owner.req("PUT", `/api/projects/${P.id}/artifacts/${P.doc}`, { expected_revision: 1, body: "synthetic two" }));
  ok(await owner.req("POST", `/api/projects/${P.id}/artifacts/${P.doc}/comments`, { revision: 2, body: "synthetic comment" }), 201);
  const b = ok(await owner.req("POST", `/api/projects/${P.id}/uploads`, { title: "img", mime: "image/png", size: png.length, sha256: sha256(png) }), 201);
  assert.equal((await fetch(h.appUi + b.put_url, { method: "PUT", headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf, "content-type": "application/octet-stream" }, body: png })).status, 200);
  P.file = ok(await owner.req("POST", `/api/projects/${P.id}/uploads/${b.upload_id}/finish`)).artifact_id;
  cred.key = ok(await owner.req("POST", "/api/api-keys", { label: "pd key", projects: [{ project_id: P.id, access: "read_write" }] }), 201).secret;
  cred.grant = ok(await owner.req("POST", `/api/projects/${P.id}/grants`, { label: "pd grant", can_write: true }), 201).token;
  cred.grantMcp = await mcpClient(h.appUi, cred.grant, "pd-grant");
  cred.oauth = await h.connectMcpAgent({ [P.id]: "write" }, { clientName: "PD agent" });
  cred.app = await h.registerApp({ display_name: "PD Publisher", redirect_uris: ["http://127.0.0.1:5995/cb"] });
  cred.pub = await h.connectPublisher(cred.app, { project_id: P.id, destination: "root" });
  await publishGeneration(cred.pub);
  assert.ok(await n(`SELECT COUNT(*) AS n FROM snapshots WHERE publisher_id = '${cred.pub.publisher_id}'`) >= 1);
});
after(async () => { await cred.grantMcp?.close(); await h?.stop(); });

test("before deleting: every way in works", async () => {
  for (const [name, f] of Object.entries(reach)) if (name !== "bobAddress") assert.equal(await f(P.id, P.doc), 200, name);
  assert.equal(await reach.bobAddress(P.path), 200);
});

test("only admins can delete, and only with the project's name typed", async () => {
  assert.equal((await carol.req("DELETE", `/api/projects/${P.id}`, { confirm_title: "Old Notes" })).status, 403, "a member can't");
  assert.ok([403, 404, 405].includes((await http(h.issuer, cred.key, "DELETE", `/v1/projects/${P.id}`, { confirm_title: "Old Notes" })).status), "an API key can't");
  assert.equal(await n(`SELECT COUNT(*) AS n FROM projects WHERE id = '${P.id}' AND deleted_at IS NULL`), 1);
  assert.equal((await http(h.appUi, cred.grant, "DELETE", `/api/projects/${P.id}`, { confirm_title: "Old Notes" })).status, 403, "a grant token can't");
  const e = await bob.req("DELETE", `/api/projects/${P.id}`, { confirm_title: "old notes" });
  assert.equal(e.status, 400); assert.equal(e.body.error.code, "confirmation_required");
  assert.equal(await n(`SELECT COUNT(*) AS n FROM projects WHERE id = '${P.id}' AND deleted_at IS NOT NULL`), 0);
});

test("delete: closed to everyone at once (same 404 as unknown), frees the limit slot and the address", async () => {
  const usage0 = ok(await owner.req("GET", `/api/workspaces/${WS}/usage`)).projects.used;
  const d = ok(await bob.req("DELETE", `/api/projects/${P.id}`, { confirm_title: "Old Notes" }));
  assert.ok(Date.parse(d.purge_at) - Date.parse(d.deleted_at) === 30 * 864e5);
  const unknown = await bob.req("GET", `/api/projects/prj_doesnotexist/artifacts/${P.doc}`);
  assert.equal(await reach.publisher(), 401, "the publisher's token is refused (its project is gone)");
  for (const [name, f] of Object.entries(reach)) {
    if (name === "bobAddress") continue;
    const s = await f(P.id, P.doc);
    // 404 like an unknown project; an API key whose only project is gone is inactive as a whole (401
    // credential_inactive, the same as when its creator loses access; a legacy grant token likewise); the OAuth
    // connection likewise (401 at the MCP transport: it has no live project left); the publisher's token is refused (401).
    const want = { bob: [404], key: [401], grant: [401], grantMcp: [401], oauth: ["401:-32001"], publisher: [401, 403] }[name];
    assert.ok(want.includes(s), `${name} after delete: ${s}`);
  }
  assert.equal((await bob.req("GET", `/api/projects/${P.id}/artifacts/${P.doc}`)).body.error.message, unknown.body.error.message, "indistinguishable from unknown");
  assert.equal(await reach.bobAddress(P.path), 404, "the address no longer resolves");
  assert.ok(!ok(await bob.req("GET", "/api/projects")).projects.some((p) => p.id === P.id), "gone from the list");
  assert.equal(ok(await owner.req("GET", `/api/workspaces/${WS}/usage`)).projects.used, usage0 - 1, "no longer counts toward projects");
  // A file download and an MCP write are refused too.
  assert.equal((await owner.req("GET", `/api/projects/${P.id}/artifacts/${P.file}/content`)).status, 404);
  assert.ok((await cred.oauth.call("save_markdown", { project_id: P.id, artifact_id: P.doc, expected_revision: 2, body: "x", idempotency_key: key("w") })).isError);
  // Deleting again: 404 (it's not there).
  assert.equal((await bob.req("DELETE", `/api/projects/${P.id}`, { confirm_title: "Old Notes" })).status, 404);
  // The address is free: a new project can take it.
  const fresh = ok(await owner.req("POST", "/api/projects", { title: "Old Notes", workspace_id: WS, slug: P.slug }), 201);
  assert.equal(fresh.slug, P.slug);
  P.taker = fresh.id;
  assert.equal(await n(`SELECT COUNT(*) AS n FROM audits WHERE action = 'project.delete' AND project_id = '${P.id}'`), 1);
});

test("recently deleted: admins see it with its purge date; members don't", async () => {
  const l = ok(await bob.req("GET", `/api/workspaces/${WS}/deleted-projects`));
  // 2 documents plus the publisher's 3 generation files (2 parts and its manifest).
  assert.deepEqual(l.projects.map((p) => [p.id, p.title, p.items, p.deleted_by]), [[P.id, "Old Notes", 5, "Bob"]]);
  assert.equal((await carol.req("GET", `/api/workspaces/${WS}/deleted-projects`)).status, 403);
});

test("restore: content, history and agent access come back; a taken address gets a fresh one", async () => {
  // A member learns nothing about deleted projects: the same 404 as an unknown id.
  assert.equal((await carol.req("POST", `/api/projects/${P.id}/restore`)).status, 404);
  const r = ok(await owner.req("POST", `/api/projects/${P.id}/restore`));
  assert.notEqual(r.slug, P.slug, "its old address was taken meanwhile");
  assert.equal(r.address_changed, true, "the app is told the address changed");
  for (const [name, f] of Object.entries(reach)) if (name !== "bobAddress") assert.equal(await f(P.id, P.doc), 200, `${name} after restore`);
  const hist = ok(await bob.req("GET", `/api/projects/${P.id}/artifacts/${P.doc}/history`));
  assert.equal(hist.revisions?.length ?? hist.items?.length, 2);
  assert.equal((await owner.req("GET", `/api/projects/${P.id}/artifacts/${P.file}/content`)).status, 200, "the file's bytes are still there");
  assert.equal(ok(await bob.req("GET", `/api/workspaces/${WS}/deleted-projects`)).projects.length, 0);
});

test("restore keeps the address it had when deleted, if still free", async () => {
  // (Restoring over the projects limit is covered in plan-limits.test.mjs.)
  const before = ok(await bob.req("GET", "/api/projects")).projects.find((x) => x.id === P.id).path;
  ok(await owner.req("DELETE", `/api/projects/${P.taker}`, { confirm_title: "Old Notes" }));
  ok(await bob.req("DELETE", `/api/projects/${P.id}`, { confirm_title: "Old Notes" }));
  const r = ok(await owner.req("POST", `/api/projects/${P.id}/restore`));
  assert.equal(`${before.split("/")[0]}/${r.slug}`, before);
});

test("restore closes an hour before the purge (it may already be running)", async () => {
  const q = ok(await owner.req("POST", "/api/projects", { title: "Late", workspace_id: WS }), 201).id;
  ok(await owner.req("DELETE", `/api/projects/${q}`, { confirm_title: "Late" }));
  await sql(`UPDATE projects SET purge_at = ${Date.now() + 30 * 60e3} WHERE id = '${q}'`);
  const r = await owner.req("POST", `/api/projects/${q}/restore`);
  assert.equal(r.status, 409); assert.equal(r.body.error.code, "purge_started");
  assert.equal(await n(`SELECT COUNT(*) AS n FROM projects WHERE id = '${q}' AND deleted_at IS NOT NULL`), 1);
});

test("delete permanently: rows and R2 files are removed, a tombstone stays, credentials stay closed", async () => {
  // Control: a file in another project, which must survive.
  const keep = ok(await owner.req("POST", "/api/projects", { title: "Keep", workspace_id: WS }), 201).id;
  const kb = ok(await owner.req("POST", `/api/projects/${keep}/uploads`, { title: "keep", mime: "image/png", size: png.length, sha256: sha256(png) }), 201);
  assert.equal((await fetch(h.appUi + kb.put_url, { method: "PUT", headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf, "content-type": "application/octet-stream" }, body: png })).status, 200);
  ok(await owner.req("POST", `/api/projects/${keep}/uploads/${kb.upload_id}/finish`));
  ok(await bob.req("DELETE", `/api/projects/${P.id}`, { confirm_title: "Old Notes" }));
  const keys = (await sql(`SELECT blob_key AS key FROM revisions WHERE project_id = '${P.id}' AND blob_key IS NOT NULL
    UNION SELECT body_key FROM revisions WHERE project_id = '${P.id}' AND body_key IS NOT NULL
    UNION SELECT body_key FROM comments WHERE project_id = '${P.id}' AND body_key IS NOT NULL`)).map((r) => r.key);
  assert.ok(keys.some(k => k.startsWith(`blobs/${P.id}/`)), "binary object is covered");
  assert.ok(keys.some(k => k.startsWith(`text/${P.id}/`) && k.includes("/cmt_")), "comment object is covered");
  assert.ok(keys.every(k => k.startsWith(`blobs/${P.id}/`) || k.startsWith(`text/${P.id}/`)));
  const e = await bob.req("POST", `/api/projects/${P.id}/purge`, { confirm_title: "nope" });
  assert.equal(e.status, 400);
  assert.equal((await carol.req("POST", `/api/projects/${P.id}/purge`, { confirm_title: "Old Notes" })).status, 404);
  // A user-content view link (CONTENT_HOST) for this project goes too.
  await sql(`INSERT INTO view_links (token_hash, session_hash, principal_id, project_id, artifact_id, rev_no, purpose, expires_at, created_at) VALUES ('vlh_pd', 's', 'p', '${P.id}', 'art_x', 1, 'render', ${Date.now() + 864e5}, 'now')`);
  ok(await bob.req("POST", `/api/projects/${P.id}/purge`, { confirm_title: "Old Notes" }));
  for (const t of ["artifacts", "revisions", "comments", "meta_versions", "uploads", "project_changes", "folders", "idempotency", "transfer_links", "view_links",
    "project_members", "project_change_state", "change_scope_epochs", "publisher_generations"])
    assert.equal(await n(`SELECT COUNT(*) AS n FROM ${t} WHERE project_id = '${P.id}'`), 0, `${t} purged`);
  assert.equal(await n(`SELECT COUNT(*) AS n FROM snapshots WHERE publisher_id = '${cred.pub.publisher_id}'`), 0, "snapshots purged");
  assert.equal(await n(`SELECT COUNT(*) AS n FROM publisher_generation_parts WHERE publisher_id = '${cred.pub.publisher_id}'`), 0, "generation parts purged");
  // Credentials whose only project this was are revoked (they'd otherwise hold an agents slot forever).
  assert.equal(await n(`SELECT COUNT(*) AS n FROM publishers WHERE id = '${cred.pub.publisher_id}' AND revoked_at IS NOT NULL`), 1);
  assert.equal(await n(`SELECT COUNT(*) AS n FROM api_credential_projects acp JOIN api_credentials k ON k.id = acp.credential_id WHERE acp.project_id = '${P.id}' AND k.revoked_at IS NULL`), 0);
  assert.equal(await n(`SELECT COUNT(*) AS n FROM oauth_connection_projects cp JOIN oauth_connections c ON c.id = cp.connection_id WHERE cp.project_id = '${P.id}' AND c.revoked_at IS NULL`), 0);
  assert.equal(await n(`SELECT COUNT(*) AS n FROM grants WHERE project_id = '${P.id}' AND revoked_at IS NULL`), 0);
  const row = (await sql(`SELECT title, slug, purged_at FROM projects WHERE id = '${P.id}'`))[0];
  assert.equal(row.title, "Deleted project"); assert.equal(row.slug, null); assert.ok(row.purged_at > 0);
  assert.equal(await n(`SELECT COUNT(*) AS n FROM artifact_search_keys WHERE artifact_id IN ('${P.doc}', '${P.file}')`), 0, "search index cleared");
  // Not restorable, not listed; credentials still closed.
  assert.equal((await owner.req("POST", `/api/projects/${P.id}/restore`)).status, 404);
  assert.ok(!ok(await bob.req("GET", `/api/workspaces/${WS}/deleted-projects`)).projects.some((x) => x.id === P.id), "no longer under Recently deleted");
  // The API key is revoked now (401); the OAuth agent's connection is revoked, so its token stops working.
  assert.equal(await reach.key(P.id, P.doc), 401);
  assert.equal((await fetch(`${h.issuer}/mcp`, { method: "POST", headers: { authorization: `Bearer ${cred.oauth.access_token}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).status, 401);
  assert.equal(await n(`SELECT COUNT(*) AS n FROM audits WHERE action = 'project.purge' AND project_id = '${P.id}'`), 1);
  // R2: the objects are gone from the local bucket. Read miniflare's object index directly (read-only): a second
  // wrangler process on the live persist dir would disturb the running server.
  const dir = join(h.dir, "v3", "r2", "miniflare-R2BucketObject");
  const r2db = readdirSync(dir).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite");
  const r2 = new DatabaseSync(join(dir, r2db), { readOnly: true });
  try {
    const r2keys = r2.prepare("SELECT key FROM _mf_objects").all().map((r) => r.key);
    assert.ok(r2keys.some((k) => k.startsWith(`blobs/${keep}/`)), "control: another project's file is still there");
    for (const k of keys) assert.ok(!r2keys.includes(k), `R2 object ${k} removed`);
    assert.ok(!r2keys.some((k) => k.startsWith(`blobs/${P.id}/`) || k.startsWith(`staging/${P.id}/`) || k.startsWith(`text/${P.id}/`)), "nothing left under the project's prefixes");
  } finally { r2.close(); }
});

test("the cron purges projects whose 30 days have passed", async () => {
  const q = ok(await owner.req("POST", "/api/projects", { title: "Expiring", workspace_id: WS }), 201).id;
  const docs = [];
  for (let i = 0; i < 3; i++) docs.push(ok(await owner.req("POST", `/api/projects/${q}/artifacts`, { title: `d${i}`, body: `synthetic ${i}` }), 201).artifact_id);
  ok(await owner.req("DELETE", `/api/projects/${q}`, { confirm_title: "Expiring" }));
  // Not due yet: the cron leaves it alone.
  await fetch(`${h.issuer}/cdn-cgi/handler/scheduled`);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(await n(`SELECT COUNT(*) AS n FROM artifacts WHERE project_id = '${q}'`), 3, "kept during the 30 days");
  // Its 30 days are over.
  await sql(`UPDATE projects SET purge_at = 1 WHERE id = '${q}'`);
  const t = await fetch(`${h.issuer}/cdn-cgi/handler/scheduled`);
  assert.equal(t.status, 200, "wrangler dev runs the cron on /cdn-cgi/handler/scheduled");
  for (let i = 0; i < 20 && await n(`SELECT COUNT(*) AS n FROM projects WHERE id = '${q}' AND purged_at IS NOT NULL`) === 0; i++) await new Promise((r) => setTimeout(r, 300));
  assert.equal(await n(`SELECT COUNT(*) AS n FROM artifacts WHERE project_id = '${q}'`), 0);
  assert.equal(await n(`SELECT COUNT(*) AS n FROM projects WHERE id = '${q}' AND purged_at IS NOT NULL`), 1);
});

test("browser: delete from Project settings, see it under Recently deleted, restore it", async (t) => {
  const { createRequire } = await import("node:module");
  const { existsSync, mkdirSync } = await import("node:fs");
  const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const PUP = `${process.env.HOME}/.npm-packages/lib/node_modules/puppeteer`;
  if (!existsSync(CHROME) || !existsSync(PUP)) return t.skip("Chrome/puppeteer not installed");
  mkdirSync("tmp/test-evidence", { recursive: true });
  const pid = ok(await bob.req("POST", "/api/projects", { title: "Q3 Research", workspace_id: WS }), 201).id;
  ok(await bob.req("POST", `/api/projects/${pid}/artifacts`, { title: "Notes", body: "synthetic" }), 201);
  const browser = await createRequire(import.meta.url)(PUP).launch({ executablePath: CHROME, headless: true, args: ["--no-first-run"] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1000 });
    await page.goto(h.appUi + "/");
    await page.evaluate(async (passphrase) => fetch("/auth/dev-login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase, user: "bob" }) }), h.passphrase());
    await page.goto(`${h.appUi}/#/p/${pid}`); await page.reload();
    await (await page.waitForSelector("button.addr-settings")).click();
    const zone = await page.waitForSelector(".proj-delete");
    assert.match(await zone.evaluate((e) => e.innerText), /Closes it right away for everyone[\s\S]*restore it, with everything in it, from the workspace page for 30 days/);
    const del = await page.$(".proj-delete button.danger");
    assert.equal(await del.evaluate((b) => b.disabled), true, "disabled until the name is typed");
    await page.type(".proj-delete input", "Q3 Research");
    assert.equal(await del.evaluate((b) => b.disabled), false);
    await page.screenshot({ path: "tmp/test-evidence/project-delete-confirm.png", fullPage: true });
    await del.click();
    await page.waitForFunction(() => /^#\/workspaces\//.test(location.hash));
    await page.waitForSelector(".deleted-project");
    const row = await page.evaluate(() => [...document.querySelectorAll(".deleted-project")].map((e) => e.innerText).find((x) => /Q3 Research/.test(x)) ?? "");
    assert.match(row, /Q3 Research[\s\S]*1 item · deleted .* by Bob · removed for good on /);
    assert.doesNotMatch(await page.$eval("[aria-label^='Projects in']", (e) => e.innerText), /Q3 Research/, "not in the live list");
    await page.screenshot({ path: "tmp/test-evidence/project-recently-deleted.png", fullPage: true });
    // Delete permanently asks inline (typed name); Cancel collapses it and nothing changes.
    const rowX = "xpath/.//li[contains(@class,'deleted-project')][.//strong[normalize-space()='Q3 Research']]";
    await (await page.waitForSelector(`${rowX}//button[normalize-space()='Delete permanently']`)).click();
    const box = await page.waitForSelector(".purge-confirm");
    assert.match(await box.evaluate((e) => e.innerText), /1 item and all their versions, comments and files are removed now\. This can't be undone\.[\s\S]*Type “Q3 Research” to delete it permanently/);
    assert.equal(await page.evaluate(() => document.activeElement?.closest(".purge-confirm") !== null), true, "focus moves into the confirmation");
    assert.equal(await page.$eval(".purge-confirm button.danger", (b) => b.disabled), true);
    await page.screenshot({ path: "tmp/test-evidence/project-purge-confirm.png", fullPage: true });
    await page.keyboard.press("Escape");
    assert.equal(await page.$(".purge-confirm"), null, "Escape collapses it");
    assert.match(await page.evaluate(() => document.activeElement?.textContent ?? ""), /Delete permanently/, "focus returns to the button");
    await (await page.waitForSelector(`${rowX}//button[normalize-space()='Restore']`)).click();
    await page.waitForFunction(() => /Q3 Research/.test(document.querySelector("[aria-label^='Projects in']")?.innerText ?? ""));
    assert.doesNotMatch(await page.evaluate(() => [...document.querySelectorAll(".deleted-project")].map((e) => e.innerText).join("\n")), /Q3 Research/, "no longer under Recently deleted");
    // Mobile: the settings panel and danger zone fit.
    await page.setViewport({ width: 390, height: 900 });
    await page.goto(`${h.appUi}/#/p/${pid}`); await page.reload();
    await (await page.waitForSelector("button.addr-settings")).click();
    await page.waitForSelector(".proj-delete");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no horizontal scroll");
    await page.screenshot({ path: "tmp/test-evidence/project-delete-mobile.png", fullPage: true });
  } finally { await browser.close(); }
});

test("the purge is bounded: a small budget stops part-way and the next run finishes (unit, real migrations)", async () => {
  const { loadWorker } = await import("./load-worker.mjs");
  const { DatabaseSync } = await import("node:sqlite");
  const { readFileSync, readdirSync: rd } = await import("node:fs");
  const lib = await loadWorker({ "project-deletion.js": ["purgeDueProjects"] });
  const db = new DatabaseSync(":memory:");
  for (const f of rd(join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  const stmt = (q, p) => ({ async first(c) { const r = db.prepare(q).get(...p); return c ? r?.[c] ?? null : r ?? null; }, async all() { return { results: db.prepare(q).all(...p) }; },
    runSync() { return { meta: { changes: Number(db.prepare(q).run(...p).changes) } }; }, async run() { return this.runSync(); } });
  const DB = { prepare(q) { return { bind: (...p) => stmt(q, p), ...stmt(q, []) }; }, async batch(ss) { db.exec("BEGIN"); try { const r = ss.map((s) => s.runSync()); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; } } };
  const gone = [];
  const env = { DB, BLOBS: { async delete(k) { gone.push(k); }, async list() { return { objects: [] }; } } };
  const at = new Date().toISOString();
  db.prepare("INSERT INTO principals (id, kind, issuer, subject, label, created_at) VALUES ('hum_u','human','synthetic','u','U',?)").run(at);
  db.prepare("INSERT INTO projects (id, owner_id, title, created_at, deleted_at, purge_at) VALUES ('prj_u','hum_u','U',?,1,1)").run(at);
  for (let i = 0; i < 30; i++) {
    db.prepare("INSERT INTO artifacts (id, project_id, kind, title, created_at, updated_at, head_rev) VALUES (?, 'prj_u', 'binary', 'f', ?, ?, 1)").run(`art_${i}`, at, at);
    db.prepare("INSERT INTO revisions (id, artifact_id, project_id, rev_no, author_id, blob_key, size, sha256, mime, created_at) VALUES (?, ?, 'prj_u', 1, 'hum_u', ?, 1, 'x', 'image/png', ?)")
      .run(`rev_${i}`, `art_${i}`, `blobs/prj_u/art_${i}/f`, at);
  }
  // A key outside the project's prefix is never deleted.
  db.prepare("INSERT INTO artifacts (id, project_id, kind, title, created_at, updated_at, head_rev) VALUES ('art_x', 'prj_u', 'binary', 'x', ?, ?, 1)").run(at, at);
  db.prepare("INSERT INTO revisions (id, artifact_id, project_id, rev_no, author_id, blob_key, size, sha256, mime, created_at) VALUES ('rev_x', 'art_x', 'prj_u', 1, 'hum_u', 'blobs/prj_other/art_x/f', 1, 'x', 'image/png', ?)").run(at);
  const orig = console.error; console.error = () => {};
  try {
    const a = await lib.purgeDueProjects(env, { rowBudget: 10, blobBudget: 12 });
    assert.equal(a.projects, 0, "not finished within the budget");
    assert.ok(gone.length >= 1 && gone.length <= 12, `at most the R2 budget (${gone.length})`);
    let runs = 1, r;
    do { r = await lib.purgeDueProjects(env, { rowBudget: 10, blobBudget: 12 }); runs++; } while (!r.projects && runs < 40);
    assert.equal(r.projects, 1, "a later run finishes it");
    assert.ok(runs > 3, "it really took several bounded runs");
  } finally { console.error = orig; }
  assert.deepEqual([...new Set(gone)].sort(), Array.from({ length: 30 }, (_, i) => `blobs/prj_u/art_${i}/f`).sort(), "every project file, once, and nothing outside it");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE project_id = 'prj_u'").get().n, 0);
  assert.ok(db.prepare("SELECT purged_at FROM projects WHERE id = 'prj_u'").get().purged_at > 0);
});

// One in-memory world over every migration (node:sqlite), with an R2 double that lists and deletes by key.
async function unitWorld() {
  const { loadWorker } = await import("./load-worker.mjs");
  const { DatabaseSync: D } = await import("node:sqlite");
  const { readFileSync, readdirSync: rd } = await import("node:fs");
  const lib = await loadWorker({ "project-deletion.js": ["purgeDueProjects", "restoreProject"] });
  const db = new D(":memory:");
  for (const f of rd(join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  const stmt = (q, p) => ({ async first(c) { const r = db.prepare(q).get(...p); return c ? r?.[c] ?? null : r ?? null; }, async all() { return { results: db.prepare(q).all(...p) }; },
    runSync() { return { meta: { changes: Number(db.prepare(q).run(...p).changes) } }; }, async run() { return this.runSync(); } });
  const hooks = {};
  const DB = { prepare(q) { return { bind: (...p) => stmt(q, p), ...stmt(q, []) }; },
    async batch(ss) { if (hooks.beforeBatch) { const h2 = hooks.beforeBatch; hooks.beforeBatch = null; await h2(); } db.exec("BEGIN"); try { const r = ss.map((s) => s.runSync()); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; } } };
  const objects = new Set();
  const BLOBS = { async delete(k) { objects.delete(k); }, async list({ prefix, limit }) { return { objects: [...objects].filter((k) => k.startsWith(prefix)).slice(0, limit).map((key) => ({ key })) }; } };
  const at = new Date().toISOString();
  db.prepare("INSERT INTO principals (id, kind, issuer, subject, label, created_at) VALUES ('hum_u','human','synthetic','u','U',?)").run(at);
  db.prepare("INSERT INTO principals (id, kind, issuer, subject, label, created_at) VALUES ('agt_k','agent','synthetic','k','K',?)").run(at);
  db.prepare("INSERT INTO workspaces (id, name, personal, created_by, created_at) VALUES ('wsp_t','T',0,'hum_u',?)").run(at);
  db.prepare("INSERT INTO workspace_members (workspace_id, principal_id, role, created_at) VALUES ('wsp_t','hum_u','owner',?)").run(at);
  return { lib, db, hooks, objects, env: { DB, BLOBS }, at };
}

test("purge: a key over two deleted projects survives the first purge (the other can still be restored); orphaned R2 files are swept", async () => {
  const w = await unitWorld();
  for (const id of ["prj_a", "prj_b"]) w.db.prepare("INSERT INTO projects (id, owner_id, title, created_at, workspace_id, deleted_at, purge_at) VALUES (?,'hum_u','X',?,'wsp_t',1,?)").run(id, w.at, id === "prj_a" ? 1 : Date.now() + 864e5);
  w.db.prepare("INSERT INTO api_credentials (id, owner_principal_id, principal_id, label, token_hash, created_at, expires_at) VALUES ('akey_1','hum_u','agt_k','k','h',?,?)").run(w.at, Date.now() + 864e5);
  for (const id of ["prj_a", "prj_b"]) w.db.prepare("INSERT INTO api_credential_projects (credential_id, project_id, can_write) VALUES ('akey_1', ?, 0)").run(id);
  w.objects.add("blobs/prj_a/art_lost/f"); w.objects.add("staging/prj_a/upl_lost"); w.objects.add("blobs/prj_b/art_keep/f"); w.objects.add("blobs/prj_ab/x/f");
  const r = await w.lib.purgeDueProjects(w.env);
  assert.equal(r.projects, 1);
  assert.equal(w.db.prepare("SELECT revoked_at FROM api_credentials WHERE id = 'akey_1'").get().revoked_at, null, "B is still restorable, so the key stays");
  assert.deepEqual([...w.objects].sort(), ["blobs/prj_ab/x/f", "blobs/prj_b/art_keep/f"], "A's unreferenced files swept; B's and a look-alike prefix kept");
  // Now B is purged too: the key has nothing left and is revoked.
  w.db.prepare("UPDATE projects SET purge_at = 1 WHERE id = 'prj_b'").run();
  await w.lib.purgeDueProjects(w.env);
  assert.ok(w.db.prepare("SELECT revoked_at FROM api_credentials WHERE id = 'akey_1'").get().revoked_at > 0);
});

test("purge vs restore: a restore that lands mid-purge stops it, and nothing is tombstoned or revoked", async () => {
  const w = await unitWorld();
  w.db.prepare("INSERT INTO projects (id, owner_id, title, created_at, workspace_id, deleted_at, purge_at) VALUES ('prj_r','hum_u','R',?,'wsp_t',1,1)").run(w.at);
  w.db.prepare("INSERT INTO grants (id, project_id, principal_id, token_hash, can_write, expires_at, created_by, created_at) VALUES ('g1','prj_r','agt_k','t',0,?,'hum_u',?)").run(Date.now() + 864e5, w.at);
  // Simulate a restore committing between the purge's steps (as if from another clock): clear deleted_at.
  w.hooks.beforeBatch = async () => { w.db.prepare("UPDATE projects SET deleted_at = NULL, purge_at = NULL WHERE id = 'prj_r'").run(); };
  w.objects.add("blobs/prj_r/a/f");
  await w.lib.purgeDueProjects(w.env);
  const row = w.db.prepare("SELECT title, purged_at FROM projects WHERE id = 'prj_r'").get();
  assert.deepEqual([row.title, row.purged_at], ["R", null], "not tombstoned");
  assert.equal(w.db.prepare("SELECT revoked_at FROM grants WHERE id = 'g1'").get().revoked_at, null, "its grant isn't revoked");
});
