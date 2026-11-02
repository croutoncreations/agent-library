// Workspace limits (Phase 4, docs/limits.md) against a real local server built with the PLAN_LIMITS entitlements:
// every limit refuses with 402 limit_reached and writes nothing; concurrent requests can't overshoot (the check is in
// the INSERT); an over-limit workspace keeps its data; a paid plan lifts the limit; self-host (no PLAN_LIMITS) is
// unlimited. Synthetic data only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { startServer, agentHttp, key, ROOT, LOCAL_CONFIG } from "./helpers.mjs";
import { SERVER_PORTS } from "./ports.mjs";
import { buildWorker } from "../scripts/build.mjs";

const PORT = SERVER_PORTS["plan-limits"];
const APP = `http://localhost:${PORT}`, API = `http://127.0.0.1:${PORT}`;
const PLANS = {
  free: { storage_bytes: 4000, projects: 3, members: 3, agents: 2, owned_workspaces: 1 },
  pro: { storage_bytes: 1000000, projects: 50, members: 20, agents: 20 }
};
let s, alice, bob;
const sql = (q) => JSON.parse(execFileSync("wrangler", ["d1", "--config", LOCAL_CONFIG, "execute", "DB", "--local", "--persist-to", s.dir, "--json", "--command", q], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }))[0].results;
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const refused = (r, limit) => {
  assert.equal(r.status, 402, JSON.stringify(r.body));
  assert.equal(r.body.error.code, "limit_reached"); assert.equal(r.body.error.limit, limit);
  assert.ok(Number.isInteger(r.body.error.used) && Number.isInteger(r.body.error.allowed));
  return r.body.error;
};
const W = {};

before(async () => {
  const out = join(ROOT, "tmp", "test-worker-limits", "index.js");
  await buildWorker({ entry: join(ROOT, "test/fixtures/limits-worker.js"), outfile: out });
  s = await startServer("plan-limits", PORT, { worker: out, readyBase: APP, vars: {
    MCP_HOST: `127.0.0.1:${PORT}`, APP_HOST: `localhost:${PORT}`, PLAN_LIMITS: JSON.stringify(PLANS),
    RATE_READS_PER_MIN: "100000", RATE_WRITES_PER_MIN: "100000", RATE_AUTHFAIL_PER_MIN: "100000" } });
  alice = await s.loginAt(APP, "alice"); bob = await s.loginAt(APP, "bob");
});
after(async () => { await s?.stop(); });

test("projects: the limit refuses the next one (402) and writes nothing; usage endpoint reports it", async () => {
  W.team = ok(await alice.req("POST", "/api/workspaces", { name: "Team" }), 201).id;
  for (let i = 0; i < 3; i++) ok(await alice.req("POST", "/api/projects", { title: `P${i}`, workspace_id: W.team }), 201);
  const before = sql(`SELECT COUNT(*) AS n FROM projects WHERE workspace_id = '${W.team}'`)[0].n;
  const e = refused(await alice.req("POST", "/api/projects", { title: "P3", workspace_id: W.team }), "projects");
  assert.deepEqual([e.used, e.allowed], [3, 3]);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM projects WHERE workspace_id = '${W.team}'`)[0].n, before);
  const u = ok(await alice.req("GET", `/api/workspaces/${W.team}/usage`));
  assert.deepEqual(u.projects, { used: 3, limit: 3 });
  assert.equal(u.storage_bytes.limit, 4000);
  // Bob isn't a member: no usage for him.
  assert.equal((await bob.req("GET", `/api/workspaces/${W.team}/usage`)).status, 404);
});

test("concurrent creates can't overshoot (the check is inside the INSERT)", async () => {
  const ws = (await alice.req("GET", "/api/workspaces")).body.workspaces.find((w) => w.personal).id;
  const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => alice.req("POST", "/api/projects", { title: `Race ${i}` })));
  const made = rs.filter((r) => r.status === 201).length;
  assert.equal(made, 3, rs.map((r) => r.status).join(","));
  assert.ok(rs.filter((r) => r.status !== 201).every((r) => r.status === 402));
  assert.equal(sql(`SELECT COUNT(*) AS n FROM projects WHERE workspace_id = '${ws}'`)[0].n, 3);
});

test("storage: text saves count; the save that would exceed it is refused; the document keeps its last revision", async () => {
  const p = ok(await alice.req("GET", "/api/projects")).projects.find((x) => x.workspace_id === W.team).id;
  W.p = p;
  const doc = ok(await alice.req("POST", `/api/projects/${p}/artifacts`, { title: "Notes", body: "x".repeat(1500) }), 201);
  ok(await alice.req("PUT", `/api/projects/${p}/artifacts/${doc.artifact_id}`, { expected_revision: 1, body: "y".repeat(1500) }));
  // 3000 used of 4000: a 1500-byte save doesn't fit (every revision is kept, so it counts).
  refused(await alice.req("PUT", `/api/projects/${p}/artifacts/${doc.artifact_id}`, { expected_revision: 2, body: "z".repeat(1500) }), "storage_bytes");
  const cur = ok(await alice.req("GET", `/api/projects/${p}/artifacts/${doc.artifact_id}`));
  assert.equal(cur.revision.rev, 2);
  refused(await alice.req("POST", `/api/projects/${p}/artifacts`, { title: "More", body: "w".repeat(1500) }), "storage_bytes");
  // A small one still fits.
  ok(await alice.req("POST", `/api/projects/${p}/artifacts`, { title: "Small", body: "tiny" }), 201);
  // Files: an upload reserves its size when it begins, so a second upload (another identity) sees that reservation.
  const used = ok(await alice.req("GET", `/api/workspaces/${W.team}/usage`)).storage_bytes.used;
  const room = 4000 - used;
  const png = (n) => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(n - 8)]);
  const begin = (who, buf) => who.req("POST", `/api/projects/${p}/uploads`, { title: "img.png", mime: "image/png", size: buf.length, sha256: createHash("sha256").update(buf).digest("hex") }, { headers: { "idempotency-key": key("u") } });
  const big = png(room + 1);
  refused(await begin(alice, big), "storage_bytes");
  const half = png(Math.floor(room / 2) + 10);
  const g = ok(await alice.req("POST", `/api/projects/${p}/grants`, { label: "uploader", can_write: true }), 201);
  const agent = agentHttp(APP, g.token);
  const up = await agent("POST", `/api/projects/${p}/uploads`, { title: "a.png", mime: "image/png", size: half.length, sha256: createHash("sha256").update(half).digest("hex") });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const second = await begin(alice, half);
  refused(second, "storage_bytes");
  // Finish the first upload; restoring that file version adds another revision of its size, which doesn't fit.
  assert.equal((await agent("PUT", up.body.put_url, undefined, { raw: half })).status, 200);
  const fin = await agent("POST", `/api/projects/${p}/uploads/${up.body.upload_id}/finish`, {});
  assert.equal(fin.status, 200, JSON.stringify(fin.body));
  const rs = await agent("POST", `/api/projects/${p}/artifacts/${fin.body.artifact_id}/restore`, { expected_revision: 1, from_revision: 1 });
  refused(rs, "storage_bytes");
  assert.equal(sql(`SELECT COUNT(*) AS n FROM revisions WHERE artifact_id = '${fin.body.artifact_id}'`)[0].n, 1);
  ok(await alice.req("PATCH", `/api/projects/${p}/grants/${g.grant_id}`, { revoke: true }));
});

test("members: members + pending invitations; refused invite creates nothing", async () => {
  ok(await alice.req("POST", `/api/workspaces/${W.team}/invites`, { email: "bob@example.test", role: "member" }), 201);
  ok(await alice.req("POST", `/api/workspaces/${W.team}/invites`, { email: "carol@example.test", role: "viewer" }), 201);
  refused(await alice.req("POST", `/api/workspaces/${W.team}/invites`, { email: "dave@example.test", role: "viewer" }), "members");
  assert.equal(sql(`SELECT COUNT(*) AS n FROM workspace_invites WHERE workspace_id = '${W.team}' AND email = 'dave@example.test'`)[0].n, 0);
  // Re-inviting a pending address replaces it (doesn't need another slot)... only if room: alice + bob + carol = 3.
  // Revoking one frees a slot.
  const pending = ok(await alice.req("GET", `/api/workspaces/${W.team}/members`)).invites;
  ok(await alice.req("POST", `/api/workspaces/${W.team}/invites/${pending.find((i) => i.email === "carol@example.test").id}/revoke`, {}));
  ok(await alice.req("POST", `/api/workspaces/${W.team}/invites`, { email: "dave@example.test", role: "viewer" }), 201);
  // Over the limit (a downgrade): re-inviting a pending address is refused and leaves the pending invitation working.
  sql(`INSERT INTO workspace_members (workspace_id, principal_id, role, created_at) SELECT '${W.team}', id, 'viewer', '2026-01-01T00:00:00Z' FROM principals WHERE kind = 'human' AND id NOT IN (SELECT principal_id FROM workspace_members WHERE workspace_id = '${W.team}') LIMIT 1`);
  refused(await alice.req("POST", `/api/workspaces/${W.team}/invites`, { email: "dave@example.test", role: "member" }), "members");
  assert.equal(sql(`SELECT COUNT(*) AS n FROM workspace_invites WHERE workspace_id = '${W.team}' AND email = 'dave@example.test' AND revoked_at IS NULL`)[0].n, 1);
});

test("connected agents: API keys and grant tokens count; replacing a key needs a slot; revoking frees one", async () => {
  const mk = (label) => alice.req("POST", "/api/api-keys", { label, projects: [{ project_id: W.p, access: "read" }] });
  const k1 = ok(await mk("one"), 201);
  const g = ok(await alice.req("POST", `/api/projects/${W.p}/grants`, { label: "grant-two" }), 201);
  refused(await alice.req("POST", `/api/projects/${W.p}/grants`, { label: "grant-three" }), "agents");
  assert.equal(sql("SELECT COUNT(*) AS n FROM principals WHERE label = 'grant-three'")[0].n, 0, "refused grant wrote nothing");
  ok(await alice.req("PATCH", `/api/projects/${W.p}/grants/${g.grant_id}`, { revoke: true }));
  const k2 = ok(await mk("two"), 201);
  refused(await mk("three"), "agents");
  // The old key keeps working until it's revoked, so a replacement needs a free slot too.
  refused(await alice.req("POST", `/api/api-keys/${k1.id}/replace`, {}), "agents");
  assert.equal(sql("SELECT COUNT(*) AS n FROM api_credentials WHERE label = 'three'")[0].n, 0);
  assert.equal(sql("SELECT COUNT(*) AS n FROM principals WHERE label = 'three'")[0].n, 0, "no orphan agent principal");
  // The refused key's would-be secret is useless; existing keys still work.
  const A = agentHttp(API, k1.secret);
  assert.equal((await fetch(`${API}/v1/projects`, { headers: { authorization: `Bearer ${k1.secret}` } })).status, 200); void A;
  ok(await alice.req("POST", `/api/api-keys/${k2.id}/revoke`, {}));
  ok(await mk("three"), 201);
});

test("shared workspaces per person; a paid plan lifts the limits; over-limit keeps data (downgrade)", async () => {
  refused(await alice.req("POST", "/api/workspaces", { name: "Second" }), "owned_workspaces");
  // Billing moves Team to pro: more projects fit.
  sql(`UPDATE workspaces SET plan = 'pro' WHERE id = '${W.team}'`);
  ok(await alice.req("POST", "/api/projects", { title: "P4", workspace_id: W.team }), 201);
  ok(await alice.req("POST", "/api/projects", { title: "P5", workspace_id: W.team }), 201);
  // Downgrade: 5 projects on a 3-project plan. Everything stays readable; new projects are refused.
  sql(`UPDATE workspaces SET plan = 'free' WHERE id = '${W.team}'`);
  const list = ok(await alice.req("GET", "/api/projects")).projects.filter((p) => p.workspace_id === W.team);
  assert.equal(list.length, 5);
  for (const p of list) ok(await alice.req("GET", `/api/projects/${p.id}/artifacts`));
  refused(await alice.req("POST", "/api/projects", { title: "P6", workspace_id: W.team }), "projects");
  // An unknown plan is unlimited (fail-open on plan data, never on access).
  sql(`UPDATE workspaces SET plan = 'legacy-unlisted' WHERE id = '${W.team}'`);
  ok(await alice.req("POST", "/api/projects", { title: "P6", workspace_id: W.team }), 201);
});

test("browser: the workspace page shows plan usage; a refused project says why", async (t) => {
  const { createRequire } = await import("node:module");
  const { existsSync, mkdirSync } = await import("node:fs");
  const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const PUP = `${process.env.HOME}/.npm-packages/lib/node_modules/puppeteer`;
  if (!existsSync(CHROME) || !existsSync(PUP)) return t.skip("Chrome/puppeteer not installed");
  mkdirSync("tmp/test-evidence", { recursive: true });
  sql(`UPDATE workspaces SET plan = 'free' WHERE id = '${W.team}'`);
  const browser = await createRequire(import.meta.url)(PUP).launch({ executablePath: CHROME, headless: true, args: ["--no-first-run"] });
  try {
    for (const [w, name] of [[1280, "limits-usage"], [390, "limits-usage-mobile"]]) {
      const page = await browser.newPage();
      await page.setViewport({ width: w, height: 1000 });
      await page.goto(APP + "/");
      await page.evaluate(async (passphrase) => fetch("/auth/dev-login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase, user: "alice" }) }), s.passphrase());
      await page.goto(`${APP}/#/workspaces/${W.team}`); await page.reload();
      await page.waitForSelector(".usage");
      const txt = await page.$eval(".usage", (e) => e.innerText);
      assert.match(txt, /Storage\s+[\d.]+ KB of [\d.]+ KB/);
      assert.match(txt, /Projects\s+6 of 3 · over the limit/);
      if (w === 1280) {
        await page.type("input[aria-label='New project name']", "One too many");
        await (await page.waitForSelector("xpath/.//button[normalize-space()='Create project']")).click();
        await page.waitForFunction(() => /reached its limit for projects \(3\)\. Delete a project/.test(document.body.innerText), { timeout: 10000 });
        assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /402|limit_reached|upgrade/);
      }
      await new Promise((r) => setTimeout(r, 400));
      await page.screenshot({ path: `tmp/test-evidence/${name}.png`, fullPage: true });
      await page.close();
    }
  } finally { await browser.close(); }
});
