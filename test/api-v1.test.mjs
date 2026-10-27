// /v1 machine REST API with alk_ API credentials (Muse contract), synthetic data only.
// Proves the server contract; it does NOT prove the real Muse connector (that needs a live Muse test).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { startServer, key, barrier, ROOT, LOCAL_CONFIG } from "./helpers.mjs";
import { SERVER_PORTS } from "./ports.mjs";

const PORT = SERVER_PORTS.apiv1;
const API = `http://127.0.0.1:${PORT}`;   // machine host (MCP_HOST)
const APP = `http://localhost:${PORT}`;   // owner host (APP_HOST)
const PA = "syn-a", PB = "syn-b", PC = "syn-c";
let s, owner;

async function call(method, path, { token, body, idem, headers = {}, raw, redirect = "manual" } = {}) {
  const h = { ...headers };
  if (token !== undefined) h.authorization = `Bearer ${token}`;
  let payload = raw;
  if (body !== undefined) { h["content-type"] ??= "application/json"; payload = JSON.stringify(body); }
  if (idem) h["idempotency-key"] = idem;
  const r = await fetch(API + path, { method, headers: h, body: payload, redirect });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: r.status, headers: r.headers, json, text };
}
const mkKey = async (projects, extra = {}) => {
  const r = await owner.req("POST", "/api/api-keys", { label: "Muse test", lifetime_days: 1, projects, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
};
const sql = (q) => execFileSync("wrangler", ["d1", "--config", LOCAL_CONFIG, "execute", "DB", "--local", "--persist-to", s.dir, "--command", q], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1", NO_COLOR: "1" } }).toString();

before(async () => {
  s = await startServer("apiv1", PORT, {
    vars: { MCP_HOST: `127.0.0.1:${PORT}`, APP_HOST: `localhost:${PORT}`, V1_TEST_ENDPOINTS: "1",
      RATE_READS_PER_MIN: "100000", RATE_WRITES_PER_MIN: "100000", RATE_AUTHFAIL_PER_MIN: "100000", OAUTH_RATE_MULTIPLIER: "100" },
    readyBase: APP,
  });
  owner = await s.loginAt(APP);
  for (const p of [PA, PB, PC]) assert.equal((await owner.req("POST", "/api/projects", { id: p, title: p.toUpperCase() })).status, 201);
  await owner.req("POST", `/api/projects/${PC}/artifacts`, { title: "C secret", body: "project c only" });
});
after(async () => { await s?.stop(); });

test("authenticated owner discovers the configured machine API base", async () => {
  const r = await owner.req("GET", "/api/me");
  assert.equal(r.status, 200);
  assert.equal(r.body.api_base, API + "/v1");
  assert.equal((await fetch(APP + "/api/me")).status, 401);
});

test("owner creates a multi-project key: per-project access, secret shown once, hash-only storage", async () => {
  const k = await mkKey([{ project_id: PA, access: "read_write" }, { project_id: PB, access: "read" }]);
  assert.match(k.secret, /^alk_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(k.projects.map((p) => p.access), ["read_write", "read"]);
  const list = await owner.req("GET", "/api/api-keys");
  const row = list.body.keys.find((x) => x.id === k.id);
  assert.equal(row.status, "active");
  assert.ok(!JSON.stringify(list.body).includes(k.secret), "list never returns the secret");
  assert.ok(!sql("SELECT * FROM api_credentials").includes(k.secret), "DB stores only the hash");
  // Lifetime choices only; never unlimited or > 90 days.
  for (const lifetime_days of [0, 91, 365, "forever"])
    assert.equal((await owner.req("POST", "/api/api-keys", { label: "x", lifetime_days, projects: [{ project_id: PA, access: "read" }] })).status, 400);
  const d = await owner.req("POST", "/api/api-keys", { label: "default", projects: [{ project_id: PA, access: "read" }] });
  const days = (Date.parse(d.body.expires_at) - Date.now()) / 86400000;
  assert.ok(days > 89.9 && days <= 90, "default lifetime is 90 days");
  // Unknown project → 404, not created.
  assert.equal((await owner.req("POST", "/api/api-keys", { label: "x", projects: [{ project_id: "nope", access: "read" }] })).status, 404);
});

test("key management is owner-only (no bearer, no CSRF-less cookie, not on the machine host)", async () => {
  const k = await mkKey([{ project_id: PA, access: "read_write" }]);
  const viaKey = await fetch(APP + "/api/api-keys", { headers: { authorization: `Bearer ${k.secret}` } });
  assert.equal(viaKey.status, 401, "alk_ keys are not owner-app credentials");
  const noCsrf = await owner.req("POST", "/api/api-keys", { label: "x", projects: [{ project_id: PA, access: "read" }] }, { noCsrf: true });
  assert.equal(noCsrf.status, 403);
  for (const p of ["/v1/api-keys", "/api/api-keys", "/v1/projects/" + PA + "/grants"]) {
    const r = await call("GET", p, { token: k.secret });
    assert.equal(r.status, 404, p);
  }
});

test("Muse round trip: list, create, read, update, stale 409, idempotent replay, no redirects or HTML", async () => {
  const k = await mkKey([{ project_id: PA, access: "read_write" }, { project_id: PB, access: "read" }]);
  const t = k.secret;
  const lp = await call("GET", "/v1/projects", { token: t });
  assert.equal(lp.status, 200);
  assert.deepEqual(lp.json.projects.map((p) => [p.id, p.access]).sort(), [[PA, "read_write"], [PB, "read"]]);
  assert.equal(lp.json.projects[0].web_url.startsWith(APP + "/p/"), true, "web_url points at the owner host");
  assert.match(lp.headers.get("content-type"), /^application\/json/);
  assert.equal(lp.headers.get("set-cookie"), null);

  const ik = key("muse");
  const c = await call("POST", `/v1/projects/${PA}/files`, { token: t, idem: ik, body: { title: "Synthetic note", body: "# Hello\nsynthetic" } });
  assert.equal(c.status, 201, c.text);
  const fid = c.json.artifact_id;
  assert.equal(c.json.revision, 1);
  assert.ok(c.json.web_url.endsWith(`/p/${PA}/a/${fid}`) && c.json.preview_url.endsWith("/preview"));
  const replay = await call("POST", `/v1/projects/${PA}/files`, { token: t, idem: ik, body: { title: "Synthetic note", body: "# Hello\nsynthetic" } });
  assert.equal(replay.status, 201); assert.equal(replay.json.artifact_id, fid); assert.equal(replay.json.idempotent_replay, true);
  const reuse = await call("POST", `/v1/projects/${PA}/files`, { token: t, idem: ik, body: { title: "Different", body: "x" } });
  assert.equal(reuse.status, 422); assert.equal(reuse.json.error.code, "idempotency_key_reused");
  assert.equal((await call("POST", `/v1/projects/${PA}/files`, { token: t, body: { title: "no key" } })).status, 400);

  const r = await call("GET", `/v1/projects/${PA}/files/${fid}`, { token: t });
  assert.equal(r.status, 200);
  assert.equal(r.json.body, "# Hello\nsynthetic");
  assert.equal(r.json.file.id, fid); assert.equal(r.json.revision.rev, 1);
  assert.equal(r.json.content_path, `/v1/projects/${PA}/files/${fid}/content?revision=1`);

  const list = await call("GET", `/v1/projects/${PA}/files?query=Synthetic`, { token: t });
  assert.equal(list.status, 200); assert.equal(list.json.files.length, 1);

  const u = await call("PUT", `/v1/projects/${PA}/files/${fid}`, { token: t, idem: key("u"), body: { expected_revision: 1, body: "v2" } });
  assert.equal(u.status, 200, u.text); assert.equal(u.json.revision, 2);
  const stale = await call("PUT", `/v1/projects/${PA}/files/${fid}`, { token: t, idem: key("u"), body: { expected_revision: 1, body: "stale" } });
  assert.equal(stale.status, 409); assert.equal(stale.json.error.code, "revision_conflict"); assert.equal(stale.json.error.current_revision, 2);

  const cont = await call("GET", `/v1/projects/${PA}/files/${fid}/content?revision=1&open=1`, { token: t });
  assert.equal(cont.status, 200); assert.equal(cont.text, "# Hello\nsynthetic");
  assert.match(cont.headers.get("content-type"), /^text\/plain/);
  const revs = await call("GET", `/v1/projects/${PA}/files/${fid}/revisions`, { token: t });
  assert.deepEqual(revs.json.revisions.map((x) => x.rev), [2, 1]);
  // Unknown paths and wrong methods: JSON, never HTML, never 3xx.
  for (const [m, p] of [["GET", "/v1"], ["GET", "/v1/"], ["GET", "/v1/nope"], ["DELETE", `/v1/projects/${PA}/files/${fid}`], ["GET", "/v1/projects/../api/me"]]) {
    const x = await call(m, p, { token: t });
    assert.ok(x.status >= 400 && x.status < 500, `${m} ${p} -> ${x.status}`);
    assert.match(x.headers.get("content-type") ?? "", /^application\/json/, `${m} ${p}`);
    assert.ok(!/<html/i.test(x.text));
  }
  // Wrong content type and oversized bodies.
  assert.equal((await call("POST", `/v1/projects/${PA}/files`, { token: t, idem: key(), raw: "title=x", headers: { "content-type": "application/x-www-form-urlencoded" } })).status, 415);
  assert.equal((await call("POST", `/v1/projects/${PA}/files`, { token: t, idem: key(), raw: "{", headers: { "content-type": "application/json" } })).status, 400);
  assert.equal((await call("POST", `/v1/projects/${PA}/files`, { token: t, idem: key(), raw: "x".repeat(6_600_000), headers: { "content-type": "application/json" } })).status, 413);
  // Cookies are refused (no ambient browser auth on the API).
  assert.equal((await call("GET", "/v1/projects", { token: t, headers: { cookie: "al_session=x" } })).status, 400);
});

test("403 for read-only writes; 404 for out-of-scope projects/files; never broader access", async () => {
  const k = await mkKey([{ project_id: PA, access: "read_write" }, { project_id: PB, access: "read" }]);
  const ro = await call("POST", `/v1/projects/${PB}/files`, { token: k.secret, idem: key(), body: { title: "x" } });
  assert.equal(ro.status, 403); assert.equal(ro.json.error.code, "forbidden");
  assert.match(ro.headers.get("www-authenticate"), /insufficient_scope/);
  const out = await call("GET", `/v1/projects/${PC}/files`, { token: k.secret });
  assert.equal(out.status, 404);
  const outW = await call("POST", `/v1/projects/${PC}/files`, { token: k.secret, idem: key(), body: { title: "x" } });
  assert.equal(outW.status, 404);
  // A file id from another project is not reachable through an authorized project.
  const cFile = (await owner.req("GET", `/api/projects/${PC}/artifacts`)).body.artifacts[0].id;
  assert.equal((await call("GET", `/v1/projects/${PA}/files/${cFile}`, { token: k.secret })).status, 404);
  assert.equal((await call("GET", `/v1/projects/${PA}/files/${cFile}/content`, { token: k.secret })).status, 404);
});

test("401 distinguishes unauthenticated / expired / revoked; revoke is immediate", async () => {
  for (const tok of [undefined, "", "alk_short", "Basic abc", "alk_" + "A".repeat(43)]) {
    const r = await call("GET", "/v1/projects", tok === undefined ? {} : { headers: { authorization: tok.startsWith("Basic") ? tok : `Bearer ${tok}` } });
    assert.equal(r.status, 401); assert.equal(r.json.error.code, "unauthenticated");
    assert.match(r.headers.get("www-authenticate"), /invalid_token/);
  }
  // Diagnostic categories stay server-side: response bodies never carry reason/key_id.
  for (const tok of ["hsurr_fake", "alk_short", "alk_" + "B".repeat(43)]) {
    const r = await call("GET", "/v1/projects", { token: tok });
    assert.equal(r.json.error.reason, undefined); assert.equal(r.json.error.key_id, undefined);
  }
  const k = await mkKey([{ project_id: PA, access: "read_write" }]);
  assert.equal((await call("GET", "/v1/projects", { token: k.secret })).status, 200);
  assert.equal((await owner.req("POST", `/api/api-keys/${k.id}/revoke`, {})).status, 200);
  const rv = await call("GET", "/v1/projects", { token: k.secret });
  assert.equal(rv.status, 401); assert.equal(rv.json.error.code, "credential_revoked");
  assert.match(rv.headers.get("www-authenticate"), /revoked/);

  const e = await mkKey([{ project_id: PA, access: "read" }]);
  sql(`UPDATE api_credentials SET expires_at = 1 WHERE id = '${e.id}'`);
  const ex = await call("GET", "/v1/projects", { token: e.secret });
  assert.equal(ex.status, 401); assert.equal(ex.json.error.code, "credential_expired");
  const list = (await owner.req("GET", "/api/api-keys")).body.keys;
  assert.equal(list.find((x) => x.id === e.id).status, "expired");
  assert.equal(list.find((x) => x.id === k.id).status, "revoked");
});

test("scope downgrade applies to the next request (no cached permissions)", async () => {
  const k = await mkKey([{ project_id: PA, access: "read_write" }]);
  sql(`UPDATE api_credential_projects SET can_write = 0 WHERE credential_id = '${k.id}'`);
  const r = await call("POST", `/v1/projects/${PA}/files`, { token: k.secret, idem: key(), body: { title: "should not exist" } });
  assert.equal(r.status, 403);
  assert.ok(!sql(`SELECT title FROM artifacts WHERE title = 'should not exist'`).includes("should not exist"));
});

test("revoke racing concurrent writes: every success is durable, every failure published nothing", async () => {
  const k = await mkKey([{ project_id: PA, access: "read_write" }]);
  const tag = "race-" + Date.now();
  const writes = Array.from({ length: 16 }, (_, i) => () => call("POST", `/v1/projects/${PA}/files`, { token: k.secret, idem: key(), body: { title: `${tag}-${i}` } }));
  const res = await barrier([...writes.slice(0, 8), () => owner.req("POST", `/api/api-keys/${k.id}/revoke`, {}), ...writes.slice(8)]);
  const outcomes = res.filter((_, i) => i !== 8);
  const ok = outcomes.filter((r) => r.status === 201).length;
  assert.ok(outcomes.every((r) => [201, 401, 403].includes(r.status)), outcomes.map((r) => r.status).join(","));
  // Rejected-in-batch writes after revoke report the credential state, not a generic 403.
  assert.ok(outcomes.filter((r) => r.status === 403).length === 0, "post-revoke failures are 401 credential_revoked");
  const rows = sql(`SELECT COUNT(*) AS n FROM artifacts WHERE title LIKE '${tag}-%'`);
  assert.match(rows, new RegExp(`"n": ${ok}\\b`), `artifacts == successful responses (${ok})`);
  assert.equal((await call("POST", `/v1/projects/${PA}/files`, { token: k.secret, idem: key(), body: { title: "after" } })).status, 401);
});

test("PUT path: read-only 403, cross-project 404, revoke racing saves publishes only acknowledged revisions", async () => {
  const k = await mkKey([{ project_id: PA, access: "read_write" }, { project_id: PB, access: "read" }]);
  // Read-only project: create a doc there as owner, then try to save via the key.
  const bDoc = (await owner.req("POST", `/api/projects/${PB}/artifacts`, { title: "B doc", body: "b" })).body.artifact_id;
  const ro = await call("PUT", `/v1/projects/${PB}/files/${bDoc}`, { token: k.secret, idem: key(), body: { expected_revision: 1, body: "nope" } });
  assert.equal(ro.status, 403); assert.equal(ro.json.error.code, "forbidden");
  const cFile = (await owner.req("GET", `/api/projects/${PC}/artifacts`)).body.artifacts[0].id;
  const xp = await call("PUT", `/v1/projects/${PA}/files/${cFile}`, { token: k.secret, idem: key(), body: { expected_revision: 1, body: "nope" } });
  assert.equal(xp.status, 404);
  assert.equal((await owner.req("GET", `/api/projects/${PC}/artifacts/${cFile}`)).body.revision.rev, 1, "other project's file untouched");
  // Race: sequential-chain of saves vs a revoke. Every 200 is a durable revision; nothing else is.
  const doc = (await call("POST", `/v1/projects/${PA}/files`, { token: k.secret, idem: key(), body: { title: "race-put" } })).json.artifact_id;
  const results = await barrier([
    ...Array.from({ length: 8 }, (_, i) => () => call("PUT", `/v1/projects/${PA}/files/${doc}`, { token: k.secret, idem: key(), body: { expected_revision: 1, body: "v" + i } })),
    () => owner.req("POST", `/api/api-keys/${k.id}/revoke`, {}),
  ]);
  const puts = results.slice(0, 8);
  const ok = puts.filter((r) => r.status === 200).length;
  assert.ok(ok <= 1, "revision guard: at most one save at expected_revision 1 wins");
  assert.ok(puts.every((r) => [200, 401, 409].includes(r.status)), puts.map((r) => r.status).join(","));
  const head = (await owner.req("GET", `/api/projects/${PA}/artifacts/${doc}`)).body.revision.rev;
  assert.equal(head, 1 + ok, "head revision == acknowledged saves + 1");
});

test("contract details: case-insensitive Bearer scheme; escaped non-ASCII Markdown under 1 MiB accepted", async () => {
  const k = await mkKey([{ project_id: PA, access: "read_write" }]);
  assert.equal((await call("GET", "/v1/projects", { headers: { authorization: `bearer ${k.secret}` } })).status, 200);
  // ~300k CJK chars = ~900 KB UTF-8 (< 1 MiB) but ~1.8 MB as \uXXXX-escaped JSON (Python's default).
  const body = "漢".repeat(300_000);
  const escaped = JSON.stringify({ title: "SYNTHETIC cjk", body }).replace(/[\u0080-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  const r = await call("POST", `/v1/projects/${PA}/files`, { token: k.secret, idem: key(), raw: escaped, headers: { "content-type": "application/json" } });
  assert.equal(r.status, 201, r.text.slice(0, 200));
  const back = await call("GET", `/v1/projects/${PA}/files/${r.json.artifact_id}`, { token: k.secret });
  assert.equal(back.json.body, body);
  // Over 1 MiB decoded is still refused by the service limit.
  const big = await call("POST", `/v1/projects/${PA}/files`, { token: k.secret, idem: key(), body: { title: "big", body: "漢".repeat(400_000) } });
  assert.equal(big.status, 413);
  // Revoke writes exactly one audit row, atomically.
  await owner.req("POST", `/api/api-keys/${k.id}/revoke`, {});
  assert.equal((await owner.req("POST", `/api/api-keys/${k.id}/revoke`, {})).status, 409);
  assert.equal((sql(`SELECT COUNT(*) AS n FROM audits WHERE object_id = '${k.id}' AND action = 'apikey.revoke'`).match(/"n": (\d+)/) ?? [])[1], "1");
});

test("replace key: same scope, new secret, old key works until revoked; scope change is owner-only + audited", async () => {
  const k = await mkKey([{ project_id: PA, access: "read_write" }, { project_id: PB, access: "read" }]);
  const r = await owner.req("POST", `/api/api-keys/${k.id}/replace`, { lifetime_days: 30 });
  assert.equal(r.status, 201);
  assert.notEqual(r.body.secret, k.secret);
  assert.deepEqual(r.body.projects, k.projects);
  assert.equal((await call("GET", "/v1/projects", { token: k.secret })).status, 200, "old key still valid");
  assert.equal((await call("GET", "/v1/projects", { token: r.body.secret })).status, 200);
  const listed = (await owner.req("GET", "/api/api-keys")).body.keys.find((x) => x.id === r.body.id);
  assert.equal(listed.replaces_id, k.id);
  await owner.req("POST", `/api/api-keys/${k.id}/revoke`, {});
  assert.equal((await call("GET", "/v1/projects", { token: k.secret })).status, 401);
  assert.equal((await owner.req("POST", `/api/api-keys/${k.id}/replace`, {})).status, 409, "revoked keys cannot be replaced");

  // Adding access without explicit confirmation is refused (409) and changes nothing.
  const scopeBody = { projects: [{ project_id: PA, access: "read_write" }, { project_id: PC, access: "read" }] };
  const unconfirmed = await owner.req("PUT", `/api/api-keys/${r.body.id}/scope`, scopeBody);
  assert.equal(unconfirmed.status, 409); assert.equal(unconfirmed.body.error.code, "confirmation_required");
  assert.deepEqual(unconfirmed.body.error.new_access, [{ project_id: PC, access: "read" }]);
  assert.deepEqual((await call("GET", "/v1/projects", { token: r.body.secret })).json.projects.map((p) => p.id).sort(), [PA, PB]);
  // Owner adds project C (explicit, confirmed action); key sees it immediately; audit rows recorded.
  const sc = await owner.req("PUT", `/api/api-keys/${r.body.id}/scope`, { ...scopeBody, confirm_new_access: true });
  assert.equal(sc.status, 200);
  const narrow = await owner.req("PUT", `/api/api-keys/${r.body.id}/scope`, { projects: [{ project_id: PA, access: "read_write" }, { project_id: PC, access: "read" }] });
  assert.equal(narrow.status, 200, "same scope, nothing new");
  // A key can never manage keys (owner routes need a cookie session + CSRF).
  assert.equal((await fetch(APP + `/api/api-keys/${r.body.id}/scope`, { method: "PUT", headers: { authorization: `Bearer ${r.body.secret}`, "content-type": "application/json" }, body: JSON.stringify({ ...scopeBody, confirm_new_access: true }) })).status, 401);
  const lp = await call("GET", "/v1/projects", { token: r.body.secret });
  assert.deepEqual(lp.json.projects.map((p) => p.id).sort(), [PA, PC]);
  assert.match(sql(`SELECT action, project_id FROM audits WHERE object_id = '${r.body.id}'`), /apikey\.scope[\s\S]*syn-c/);
});

test("test-only redirect probe exists only behind the flag, only on loopback, and points off-host", async () => {
  // The code refuses non-loopback Host headers even with the flag on (node:http can set Host; fetch can't).
  const status = await new Promise((res, rej) => {
    const rq = httpRequest({ host: "127.0.0.1", port: PORT, path: "/v1/_test/redirect?code=307", headers: { host: "library-mcp.example.com" } }, (r) => { r.resume(); res(r.statusCode); });
    rq.on("error", rej); rq.end();
  });
  assert.notEqual(status, 307, "probe never served for a production-shaped host");
  // And no committed config sets the flag (local, example and generated self-host configs).
  for (const f of ["wrangler.local.toml", "wrangler.example.toml", "scripts/self-host/setup.mjs"])
    assert.ok(!/V1_TEST_ENDPOINTS/.test(readFileSync(join(ROOT, f), "utf8")), `redirect probe flag must not be in ${f}`);
  const r = await call("GET", "/v1/_test/redirect?code=307");
  assert.equal(r.status, 307);
  assert.equal(new URL(r.headers.get("location")).host, "redirect-probe.invalid");
  // Normal API paths never redirect, including trailing-slash variants.
  for (const p of ["/v1/projects/", `/v1/projects/${PA}/files/`]) assert.ok((await call("GET", p)).status < 300 || (await call("GET", p)).status >= 400);
});

test("owner host and /mcp unchanged: /v1 is not served on the owner host", async () => {
  const r = await fetch(APP + "/v1/projects");
  assert.notEqual(r.status, 200);
  assert.ok(!(await r.text()).includes("projects\":"));
  const meta = await fetch(API + "/.well-known/oauth-protected-resource/mcp");
  assert.equal(meta.status, 200);
});

// ---------- real Chrome: Settings → API keys (create shown once, expiry, replace, revoke) ----------
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PUPPETEER = `${process.env.HOME}/.npm-packages/lib/node_modules/puppeteer`;
const haveChrome = existsSync(CHROME) && existsSync(PUPPETEER);

test("browser: create multi-project key (shown once), expiry visible, replace + revoke", { skip: !haveChrome && "Chrome not installed" }, async () => {
  const browser = await createRequire(import.meta.url)(PUPPETEER).launch({ executablePath: CHROME, headless: true, args: ["--no-first-run"] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 1000 });
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
    await page.goto(APP + "/");
    await page.waitForSelector('input[name="passphrase"]');
    await page.type('input[name="passphrase"]', s.passphrase());
    await Promise.all([page.waitForFunction(() => document.body.innerText.includes("SYN-A")), page.click('button[type="submit"]')]);
    await page.goto(APP + "/#/settings/api-keys");
    await page.waitForFunction(() => document.querySelector("h1")?.textContent === "Connections" && document.querySelector('select[data-pid="syn-a"]'));
    await page.evaluate(() => { document.querySelector("details summary").click(); });
    await page.type('input[aria-label="Key label"]', "Muse (browser)");
    await page.select('select[aria-label="Lifetime"]', "7");
    await page.select('select[data-pid="syn-a"]', "read_write");
    await page.select('select[data-pid="syn-b"]', "read");
    await page.click('form button[type="submit"]');
    await page.waitForSelector('input[aria-label="API key"]');
    const secret = await page.$eval('input[aria-label="API key"]', (e) => e.value);
    assert.match(secret, /^alk_/);
    assert.equal(await page.evaluate((base) => document.body.innerText.includes("Base URL: " + base), API + "/v1"), true);
    assert.equal(await page.evaluate(() => document.body.innerText.includes("library-mcp.example.com")), false);
    await page.waitForFunction(() => document.body.innerText.includes("expires in 7 days"));
    await page.screenshot({ path: "tmp/test-evidence/ui-api-keys-created.png", fullPage: true });
    // The new key works against /v1 with exactly the chosen scope.
    const lp = await call("GET", "/v1/projects", { token: secret });
    assert.deepEqual(lp.json.projects.map((p) => [p.id, p.access]).sort(), [["syn-a", "read_write"], ["syn-b", "read"]]);
    // Done hides the secret; reloading never shows it again.
    await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent === "Done").click());
    await page.reload();
    await page.waitForFunction(() => document.body.innerText.includes("Muse (browser)"));
    assert.ok(!(await page.content()).includes(secret));
    // Replace: successor with same scope; old key still valid.
    await page.evaluate(() => {
      const li = [...document.querySelectorAll("li")].find((l) => l.innerText.includes("Muse (browser)") && l.innerText.includes("7 days"));
      [...li.querySelectorAll("button")].find((b) => b.textContent === "Replace").click();
    });
    await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent === "Create replacement").click());
    await page.waitForSelector('input[aria-label="API key"]');
    const second = await page.$eval('input[aria-label="API key"]', (e) => e.value);
    assert.notEqual(second, secret);
    await page.waitForFunction(() => document.body.innerText.includes("replacement key"));
    await page.screenshot({ path: "tmp/test-evidence/ui-api-keys-replaced.png", fullPage: true });
    assert.equal((await call("GET", "/v1/projects", { token: secret })).status, 200);
    // Revoke the old one through the UI.
    page.once("dialog", (d) => d.accept());
    await page.evaluate(() => {
      const li = [...document.querySelectorAll("li")].find((l) => l.innerText.includes("Muse (browser)") && l.innerText.includes("expires in 7 days") && !l.innerText.includes("replacement key"));
      [...li.querySelectorAll("button")].find((b) => b.textContent === "Revoke").click();
    });
    await page.waitForFunction(() => document.querySelector(".toast") && document.querySelector(".toast").innerText.includes("Revoked"));
    assert.equal((await call("GET", "/v1/projects", { token: secret })).status, 401);
    assert.equal((await call("GET", "/v1/projects", { token: second })).status, 200);
  } finally { await browser.close(); }
});
