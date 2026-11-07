// Deleting a project (decision D21 B, docs/workspaces.md#deleting-a-project) against a real local server: delete closes
// it to everyone at once (people, API keys, legacy grants, OAuth agents and publishers: same 404 as a project that
// never existed), frees its projects-limit slot and its address, and can be restored within 30 days with everything
// back, including agent access. After the retention period (or "delete permanently") the cron removes its rows and R2
// files and keeps a tombstone. Only workspace admins can delete, restore or purge, and only with the typed name.
// Synthetic data only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { key, sha256, mcpClient, LOCAL_CONFIG, ROOT } from "./helpers.mjs";
import { SERVER_PORTS } from "./ports.mjs";
import { makePng } from "./make-fixtures.mjs";
import { startAppConnectServer } from "./fixtures/app-connect-harness.mjs";

const PORT = SERVER_PORTS["project-deletion"];
let h, owner, bob, carol, WS, P = {}, cred = {};
const png = makePng(8, 8);
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const sql = (q) => JSON.parse(execFileSync("wrangler", ["d1", "--config", LOCAL_CONFIG, "execute", "DB", "--local", "--persist-to", h.dir, "--json", "--command", q],
  { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }))[0].results;
const n = (q) => sql(q)[0].n;
async function http(base, token, method, path, body) {
  const hd = { authorization: `Bearer ${token}` };
  if (body !== undefined) { hd["content-type"] = "application/json"; hd["idempotency-key"] = key("pd"); }
  const r = await fetch(base + path, { method, headers: hd, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, text: await r.text() };
}
const toolStatus = (r) => !r.isError ? 200 : (r.data?.error?.status ?? r.data?.status ?? (r.status >= 400 ? r.status : 500));
// Every way to reach a project, per credential. Each returns an HTTP status.
const reach = {
  bob: (p, d) => bob.req("GET", `/api/projects/${p}/artifacts/${d}`).then((r) => r.status),
  bobAddress: async (path) => (await bob.req("GET", `/api/projects/${encodeURIComponent(path)}/artifacts`)).status,
  key: (p, d) => http(h.issuer, cred.key, "GET", `/v1/projects/${p}/files/${d}`).then((r) => r.status),
  grant: (p, d) => http(h.appUi, cred.grant, "GET", `/api/projects/${p}/artifacts/${d}`).then((r) => r.status),
  oauth: async (p, d) => toolStatus(await cred.oauth.call("read_artifact", { project_id: p, artifact_id: d })),
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
});
after(async () => { await cred.grantMcp?.close(); await h?.stop(); });

test("before deleting: every way in works", async () => {
  for (const [name, f] of Object.entries(reach)) if (name !== "bobAddress") assert.equal(await f(P.id, P.doc), 200, name);
  assert.equal(await reach.bobAddress(P.path), 200);
});

test("only admins can delete, and only with the project's name typed", async () => {
  assert.equal((await carol.req("DELETE", `/api/projects/${P.id}`, { confirm_title: "Old Notes" })).status, 403, "a member can't");
  assert.equal((await http(h.issuer, cred.key, "DELETE", `/v1/projects/${P.id}`, { confirm_title: "Old Notes" })).status === 200, false, "an API key can't");
  assert.equal((await http(h.appUi, cred.grant, "DELETE", `/api/projects/${P.id}`, { confirm_title: "Old Notes" })).status, 403, "a grant token can't");
  const e = await bob.req("DELETE", `/api/projects/${P.id}`, { confirm_title: "old notes" });
  assert.equal(e.status, 400); assert.equal(e.body.error.code, "confirmation_required");
  assert.equal(n(`SELECT COUNT(*) AS n FROM projects WHERE id = '${P.id}' AND deleted_at IS NOT NULL`), 0);
});

test("delete: closed to everyone at once (same 404 as unknown), frees the limit slot and the address", async () => {
  const usage0 = ok(await owner.req("GET", `/api/workspaces/${WS}/usage`)).projects.used;
  const d = ok(await bob.req("DELETE", `/api/projects/${P.id}`, { confirm_title: "Old Notes" }));
  assert.ok(Date.parse(d.purge_at) - Date.parse(d.deleted_at) === 30 * 864e5);
  const unknown = await bob.req("GET", `/api/projects/prj_doesnotexist/artifacts/${P.doc}`);
  for (const [name, f] of Object.entries(reach)) {
    if (name === "bobAddress") continue;
    const s = await f(P.id, P.doc);
    // 404 like an unknown project; an API key whose only project is gone is inactive as a whole (401
    // credential_inactive, the same as when its creator loses access; a legacy grant token likewise); MCP tools answer
    // with a tool error.
    assert.ok(s === 404 || ((name === "key" || name === "grant") && s === 401) || (name === "oauth" || name === "grantMcp") && s >= 400, `${name} after delete: ${s}`);
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
  assert.equal(n(`SELECT COUNT(*) AS n FROM audits WHERE action = 'project.delete' AND project_id = '${P.id}'`), 1);
});

test("recently deleted: admins see it with its purge date; members don't", async () => {
  const l = ok(await bob.req("GET", `/api/workspaces/${WS}/deleted-projects`));
  assert.deepEqual(l.projects.map((p) => [p.id, p.title, p.items, p.deleted_by]), [[P.id, "Old Notes", 2, "Bob"]]);
  assert.equal((await carol.req("GET", `/api/workspaces/${WS}/deleted-projects`)).status, 403);
});

test("restore: content, history and agent access come back; a taken address gets a fresh one", async () => {
  assert.equal((await carol.req("POST", `/api/projects/${P.id}/restore`)).status, 403);
  const r = ok(await owner.req("POST", `/api/projects/${P.id}/restore`));
  assert.notEqual(r.slug, P.slug, "its old address was taken meanwhile");
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

test("delete permanently: rows and R2 files are removed, a tombstone stays, credentials stay closed", async () => {
  ok(await bob.req("DELETE", `/api/projects/${P.id}`, { confirm_title: "Old Notes" }));
  const keys = sql(`SELECT blob_key FROM revisions WHERE project_id = '${P.id}' AND blob_key IS NOT NULL`).map((r) => r.blob_key);
  assert.ok(keys.length >= 1 && keys.every((k) => k.startsWith(`blobs/${P.id}/`)));
  const e = await bob.req("POST", `/api/projects/${P.id}/purge`, { confirm_title: "nope" });
  assert.equal(e.status, 400);
  assert.equal((await carol.req("POST", `/api/projects/${P.id}/purge`, { confirm_title: "Old Notes" })).status, 403);
  ok(await bob.req("POST", `/api/projects/${P.id}/purge`, { confirm_title: "Old Notes" }));
  for (const t of ["artifacts", "revisions", "comments", "meta_versions", "uploads", "project_changes", "folders", "idempotency"])
    assert.equal(n(`SELECT COUNT(*) AS n FROM ${t} WHERE project_id = '${P.id}'`), 0, `${t} purged`);
  const row = sql(`SELECT title, slug, purged_at FROM projects WHERE id = '${P.id}'`)[0];
  assert.equal(row.title, "Deleted project"); assert.equal(row.slug, null); assert.ok(row.purged_at > 0);
  assert.equal(n(`SELECT COUNT(*) AS n FROM artifact_search_keys WHERE artifact_id IN ('${P.doc}', '${P.file}')`), 0, "search index cleared");
  // R2: the objects are gone from the local bucket (miniflare keeps object metadata in SQLite under the persist dir).
  const r2db = readdirSync(join(h.dir, "v3", "r2", "miniflare-R2BucketObject")).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite");
  const r2keys = new DatabaseSync(join(h.dir, "v3", "r2", "miniflare-R2BucketObject", r2db), { readOnly: true }).prepare("SELECT key FROM _mf_objects").all().map((r) => r.key);
  for (const k of keys) assert.ok(!r2keys.includes(k), `R2 object ${k} removed`);
  assert.ok(!r2keys.some((k) => k.startsWith(`blobs/${P.id}/`) || k.startsWith(`staging/${P.id}/`)), "nothing left under the project's prefixes");
  // Not restorable, not listed; credentials still closed.
  assert.equal((await owner.req("POST", `/api/projects/${P.id}/restore`)).status, 404);
  assert.ok(!ok(await bob.req("GET", `/api/workspaces/${WS}/deleted-projects`)).projects.some((x) => x.id === P.id), "no longer under Recently deleted");
  // The API key's only project is gone, so the key is inactive (401); the OAuth agent gets a tool error.
  assert.equal(await reach.key(P.id, P.doc), 401);
  assert.ok((await reach.oauth(P.id, P.doc)) >= 400);
  assert.equal(n(`SELECT COUNT(*) AS n FROM audits WHERE action = 'project.purge' AND project_id = '${P.id}'`), 1);
});

test("the cron purges projects whose 30 days have passed, in bounded batches", async () => {
  const q = ok(await owner.req("POST", "/api/projects", { title: "Expiring", workspace_id: WS }), 201).id;
  const docs = [];
  for (let i = 0; i < 3; i++) docs.push(ok(await owner.req("POST", `/api/projects/${q}/artifacts`, { title: `d${i}`, body: `synthetic ${i}` }), 201).artifact_id);
  ok(await owner.req("DELETE", `/api/projects/${q}`, { confirm_title: "Expiring" }));
  // Not due yet: the cron leaves it alone.
  await fetch(`${h.issuer}/cdn-cgi/handler/scheduled`);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(n(`SELECT COUNT(*) AS n FROM artifacts WHERE project_id = '${q}'`), 3, "kept during the 30 days");
  // Its 30 days are over.
  sql(`UPDATE projects SET purge_at = 1 WHERE id = '${q}'`);
  const t = await fetch(`${h.issuer}/cdn-cgi/handler/scheduled`);
  assert.equal(t.status, 200, "wrangler dev runs the cron on /cdn-cgi/handler/scheduled");
  for (let i = 0; i < 20 && n(`SELECT COUNT(*) AS n FROM projects WHERE id = '${q}' AND purged_at IS NOT NULL`) === 0; i++) await new Promise((r) => setTimeout(r, 300));
  assert.equal(n(`SELECT COUNT(*) AS n FROM artifacts WHERE project_id = '${q}'`), 0);
  assert.equal(n(`SELECT COUNT(*) AS n FROM projects WHERE id = '${q}' AND purged_at IS NOT NULL`), 1);
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
    assert.match(row, /Q3 Research[\s\S]*1 item · deleted .* by Bob · removed for good in 30 days/);
    assert.doesNotMatch(await page.$eval("[aria-label^='Projects in']", (e) => e.innerText), /Q3 Research/, "not in the live list");
    await page.screenshot({ path: "tmp/test-evidence/project-recently-deleted.png", fullPage: true });
    await (await page.waitForSelector("xpath/.//li[contains(@class,'deleted-project')][.//strong[normalize-space()='Q3 Research']]//button[normalize-space()='Restore']")).click();
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
