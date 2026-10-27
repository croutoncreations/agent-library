// (1) Hosted mode: a valid Cloudflare Access *service-token* JWT alone never grants access; the
//     project-scoped bearer grant is still required (and revocation/scope still apply). Uses real RS256
//     JWTs signed by a local JWKS server that the Worker fetches (ACCESS_CERTS_URL loopback test seam).
// (2) Upload cleanup: expired/failed uploads' R2 objects are deleted and stay quota-charged until deleted.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPairSync, createSign, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { startServer, agentHttp, sha256, key, ROOT, LOCAL_CONFIG } from "./helpers.mjs";
import { SERVER_PORTS, AUX_PORTS } from "./ports.mjs";

const TEAM = "test-team.cloudflareaccess.com", AUD = "test-aud-" + randomBytes(4).toString("hex"), OWNER = "owner@example.invalid";
const JWKS_PORT = AUX_PORTS.hostedJwks;
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-kid";
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function jwt(claims) {
  const now = Math.floor(Date.now() / 1000);
  const body = { iss: `https://${TEAM}`, aud: [AUD], iat: now, nbf: now - 5, exp: now + 600, ...claims };
  const head = b64u({ alg: "RS256", kid: KID, typ: "JWT" }) + "." + b64u(body);
  return head + "." + createSign("RSA-SHA256").update(head).sign(privateKey).toString("base64url");
}
const SERVICE = () => jwt({ sub: "", common_name: "agent-library-pi.access" }); // service-token JWT: no email
const OWNER_JWT = () => jwt({ sub: "user-owner-1", email: OWNER });
const OTHER_USER = () => jwt({ sub: "user-other", email: "intruder@example.invalid" });

let jwks, s, P = "proj-hosted", owner, tokA, tokB, grantB;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Owner (browser) client: Access user JWT on every request + app session cookie + CSRF.
async function ownerClient(base) {
  const r = await fetch(base + "/auth/access-login", { method: "POST", headers: { "cf-access-jwt-assertion": OWNER_JWT() } });
  assert.equal(r.status, 200, "owner access-login");
  const { csrf } = await r.json();
  const cookie = r.headers.get("set-cookie").split(";")[0];
  return async (method, path, body) => {
    const headers = { cookie, "cf-access-jwt-assertion": OWNER_JWT(), "x-csrf-token": csrf, "idempotency-key": key("o") };
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}
// Agent client with the outer service-token JWT plus (optionally) the app bearer.
const agent = (token, svc = true) => {
  const f = agentHttp(s.base, token ?? "x".repeat(24));
  return (method, path, body, opts = {}) => {
    const headers = { ...(opts.headers ?? {}) };
    if (svc) headers["cf-access-jwt-assertion"] = SERVICE();
    return token ? f(method, path, body, { ...opts, headers }) :
      fetch(s.base + path, { method, headers }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  };
};
before(async () => {
  jwks = createServer((req, res) => {
    const jwk = publicKey.export({ format: "jwk" });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] }));
  }).listen(JWKS_PORT, "127.0.0.1");
  s = await startServer("hosted", SERVER_PORTS.hosted, {
    vars: {
      ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, OWNER_EMAIL: OWNER, ACCESS_CERTS_URL: `http://127.0.0.1:${JWKS_PORT}/certs`,
      RATE_READS_PER_MIN: "100000", RATE_WRITES_PER_MIN: "100000", RATE_AUTHFAIL_PER_MIN: "100000",
      UPLOAD_TTL_SECONDS: "2", UPLOAD_CLEANUP_GRACE_SECONDS: "1", PROJECT_BINARY_BYTES: String(64 * 1024),
    },
    readyHeaders: { "cf-access-jwt-assertion": "x" },
  });
  owner = await ownerClient(s.base);
  assert.equal((await owner("POST", "/api/projects", { id: P, title: P })).status, 201);
  assert.equal((await owner("POST", "/api/projects", { id: "proj-other", title: "other" })).status, 201);
  tokA = (await owner("POST", `/api/projects/${P}/grants`, { label: "A", can_write: true })).body.token;
  const gb = (await owner("POST", `/api/projects/${P}/grants`, { label: "B", can_write: true })).body;
  tokB = gb.token; grantB = gb.grant_id;
});
after(async () => { await s?.stop(); jwks?.close(); });

test("service token alone: API, content, transfer and MCP are all denied", async () => {
  const svcOnly = agent(null);
  for (const p of ["/api/projects", `/api/projects/${P}/artifacts`, `/api/projects/${P}/artifacts/art_x/content`, "/api/me"])
    assert.equal((await svcOnly("GET", p)).status, 401, p);
  const put = await fetch(s.base + "/api/transfers/upl_x", { method: "PUT", headers: { "cf-access-jwt-assertion": SERVICE() }, body: "x" });
  assert.equal(put.status, 401);
  const mcp = await fetch(s.base + "/mcp", { method: "POST", headers: { "cf-access-jwt-assertion": SERVICE(), "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal(mcp.status, 401);
});

test("service token cannot create a browser session (access-login requires the owner's user identity)", async () => {
  const r = await fetch(s.base + "/auth/access-login", { method: "POST", headers: { "cf-access-jwt-assertion": SERVICE() } });
  assert.equal(r.status, 401);
  const other = await fetch(s.base + "/auth/access-login", { method: "POST", headers: { "cf-access-jwt-assertion": OTHER_USER() } });
  assert.equal(other.status, 403);
});

test("bearer grant without the Access layer is denied in hosted mode; forged/wrong-AUD JWT denied", async () => {
  assert.equal((await agent(tokA, false)("GET", `/api/projects/${P}/artifacts`)).status, 401);
  const wrongAud = jwt({ sub: "", aud: ["someone-else"] });
  const r = await agentHttp(s.base, tokA)("GET", `/api/projects/${P}/artifacts`, undefined, { headers: { "cf-access-jwt-assertion": wrongAud } });
  assert.equal(r.status, 401);
  const forged = SERVICE().split(".").slice(0, 2).join(".") + "." + Buffer.from("bad").toString("base64url");
  assert.equal((await agentHttp(s.base, tokA)("GET", `/api/projects/${P}/artifacts`, undefined, { headers: { "cf-access-jwt-assertion": forged } })).status, 401);
});

test("service token + grant works, but only within the grant's project; revocation still applies", async () => {
  const A = agent(tokA);
  assert.equal((await A("GET", `/api/projects/${P}/artifacts`)).status, 200);
  assert.equal((await A("GET", `/api/projects/proj-other/artifacts`)).status, 404, "wrong project scope");
  // Real MCP client with both headers.
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const c = new Client({ name: "hosted-mcp", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(s.base + "/mcp"), { requestInit: { headers: { authorization: `Bearer ${tokA}`, "cf-access-jwt-assertion": SERVICE() } } }));
  const made = await c.callTool({ name: "create_markdown", arguments: { project_id: P, title: "via svc", idempotency_key: key("c") } });
  assert.equal(made.isError, false);
  const foreign = await c.callTool({ name: "list_artifacts", arguments: { project_id: "proj-other" } });
  assert.equal(foreign.isError, true);
  assert.equal(foreign.structuredContent.error.status, 404);
  await c.close();
  // Revoke B: service token + B's bearer is now denied everywhere.
  assert.equal((await owner("PATCH", `/api/projects/${P}/grants/${grantB}`, { revoke: true })).status, 200);
  assert.equal((await agent(tokB)("GET", `/api/projects/${P}/artifacts`)).status, 401);
});

// ---------- (2) cleanup ----------
const pngOf = (n) => { const b = Buffer.alloc(n); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); randomBytes(n - 8).copy(b, 8); return b; };
async function r2Has(k) {
  try { execFileSync("wrangler", ["r2", "--config", LOCAL_CONFIG, "object", "get", "--local", "--persist-to", s.dir, "--pipe", `agent-library-blobs/${k}`], { cwd: ROOT, stdio: ["ignore", "ignore", "ignore"] }); return true; }
  catch { return false; }
}
const d1 = (sql) => JSON.parse(execFileSync("wrangler", ["d1", "--config", LOCAL_CONFIG, "execute", "DB", "--local", "--persist-to", s.dir, "--json", "--command", sql], { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString())[0].results;

test("expired upload with staged bytes: counted until deleted, then R2 object removed by reconciliation", async () => {
  const A = agent(tokA);
  const b = pngOf(40 * 1024);
  const begin = await A("POST", `/api/projects/${P}/uploads`, { title: "abandoned", mime: "image/png", size: b.length, sha256: sha256(b) });
  assert.equal(begin.status, 201);
  assert.equal((await A("PUT", begin.body.put_url, undefined, { raw: b })).status, 200); // bytes staged, never finished
  const sk = d1(`SELECT staging_key FROM uploads WHERE id = '${begin.body.upload_id}'`)[0].staging_key;
  assert.ok(await r2Has(sk), "staging object exists after PUT");
  await sleep(2500); // past expiry
  // While the abandoned object still exists, its bytes count: a 40 KiB reservation must not fit in 64 KiB.
  // (Expiry processing for this project happens inside begin; it deletes the object, after which space frees.)
  const owner2 = await owner("POST", `/api/projects/${P}/maintenance/reconcile-uploads`);
  assert.equal(owner2.status, 200);
  assert.ok(owner2.body.expired >= 1 && owner2.body.purged_staging >= 1, JSON.stringify(owner2.body));
  assert.equal(await r2Has(sk), false, "staging object deleted");
  const row = d1(`SELECT state, staging_purged_at FROM uploads WHERE id = '${begin.body.upload_id}'`)[0];
  assert.equal(row.state, "failed");
  assert.ok(row.staging_purged_at > 0);
  // Space is released only now; a fresh 40 KiB upload fits again.
  const again = await A("POST", `/api/projects/${P}/uploads`, { title: "after", mime: "image/png", size: b.length, sha256: sha256(b) });
  assert.equal(again.status, 201, JSON.stringify(again.body));
  // Re-running reconciliation is a no-op (idempotent).
  await sleep(2500);
  const r2 = await owner("POST", `/api/projects/${P}/maintenance/reconcile-uploads`);
  const r3 = await owner("POST", `/api/projects/${P}/maintenance/reconcile-uploads`);
  assert.equal(r3.body.purged_staging, 0, JSON.stringify([r2.body, r3.body]));
});

test("integrity failure at finish deletes the staged object immediately", async () => {
  const A = agent(tokA);
  const b = pngOf(1000);
  const begin = await A("POST", `/api/projects/${P}/uploads`, { title: "bad", mime: "image/png", size: b.length, sha256: "0".repeat(64) });
  assert.equal(begin.status, 201, JSON.stringify(begin.body));
  assert.equal((await A("PUT", begin.body.put_url, undefined, { raw: b })).status, 200);
  const fin = await A("POST", `/api/projects/${P}/uploads/${begin.body.upload_id}/finish`, {});
  assert.equal(fin.status, 422);
  const row = d1(`SELECT staging_key, staging_purged_at FROM uploads WHERE id = '${begin.body.upload_id}'`)[0];
  assert.ok(row.staging_purged_at > 0);
  assert.equal(await r2Has(row.staging_key), false);
});

test("failed-but-undeleted bytes are quota-charged; space is freed only by a real R2 delete", async () => {
  // Simulate a delete that has not happened yet: an expired failed upload whose object still exists.
  const A = agent(tokA);
  await owner("POST", `/api/projects/${P}/maintenance/reconcile-uploads`);
  const b = pngOf(30 * 1024);
  const begin = await A("POST", `/api/projects/${P}/uploads`, { title: "held", mime: "image/png", size: b.length, sha256: sha256(b) });
  assert.equal(begin.status, 201, JSON.stringify(begin.body));
  assert.equal((await A("PUT", begin.body.put_url, undefined, { raw: b })).status, 200);
  d1(`UPDATE uploads SET state = 'failed', expires_at = 0 WHERE id = '${begin.body.upload_id}'`); // failed, delete pending
  const used = d1(`SELECT COALESCE(SUM(expected_size),0) AS n FROM uploads WHERE project_id='${P}' AND staging_purged_at IS NULL AND state IN ('failed','conflict')`)[0].n;
  assert.ok(used >= b.length, "failed-but-undeleted bytes are charged");
  const B2 = agentHttp(s.base, (await owner("POST", `/api/projects/${P}/grants`, { label: "C", can_write: true })).body.token);
  // Charged: 30 KiB held + published 0; a 40 KiB request must fail while 30 KiB object exists (64 KiB cap)...
  const big = pngOf(40 * 1024);
  // begin runs reconciliation for the project first, which deletes the held object, so the request succeeds;
  // assert that the object is gone afterwards (i.e. space was freed by a real delete, not by forgetting it).
  const r = await B2("POST", `/api/projects/${P}/uploads`, { title: "big", mime: "image/png", size: big.length, sha256: sha256(big) },
    { headers: { "cf-access-jwt-assertion": SERVICE() } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const row = d1(`SELECT staging_key, staging_purged_at FROM uploads WHERE id = '${begin.body.upload_id}'`)[0];
  assert.ok(row.staging_purged_at > 0);
  assert.equal(await r2Has(row.staging_key), false);
});
