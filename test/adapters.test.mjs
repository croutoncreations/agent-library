// Phase 1 adapter seam (packages/core/src/adapters.js): createWorker(adapters) wires identity, entitlements, lifecycle
// and extra routes into the real core; the self-host entry supplies Cloudflare Access. Loaded from the real sources
// (test/load-worker.mjs); no network, synthetic values only.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./helpers.mjs";
import { loadWorker } from "./load-worker.mjs";

let W;
before(async () => {
  W = await loadWorker({
    "index.js": ["createWorker"],
    "adapters.js": ["resolveAdapters", "withAdapters", "adapters", "notify"],
    "tenancy.js": ["multiUserInstall"],
    "workspaces.js": ["createWorkspace"],
    "../../self-host/src/access-identity.js": ["accessIdentity"]
  });
});
const APP = "https://app.example.test";
const call = (w, path, init = {}, env = {}) => w.fetch(new Request(APP + path, init), { APP_HOST: "app.example.test", ...env }, { waitUntil() {} });

test("extra routes are reached only when no core route matches, and never shadow core routes", async () => {
  const seen = [];
  const w = W.createWorker({ routes: [
    { method: "GET", path: "/pricing", handler: async (_r, _e, x) => { seen.push(x.ctx); return new Response("pricing page"); } },
    { method: "GET", path: /^\/legal\/([a-z]+)$/, handler: async (_r, _e, x) => new Response("legal:" + x.match[1]) },
    { method: "GET", path: "/app.css", handler: async () => new Response("hijacked") }
  ] });
  const r = await call(w, "/pricing");
  assert.equal(r.status, 200); assert.equal(await r.text(), "pricing page"); assert.deepEqual(seen, [null]);
  assert.equal(await (await call(w, "/legal/terms")).text(), "legal:terms");
  // Security headers still apply to adapter responses.
  assert.equal(r.headers.get("x-frame-options"), "DENY");
  // Core wins over an adapter route on the same path.
  const css = await call(w, "/app.css");
  assert.notEqual(await css.text(), "hijacked");
  // Method mismatch and unknown paths fall through to 404.
  assert.equal((await call(w, "/pricing", { method: "POST" })).status, 404);
  assert.equal((await call(w, "/nope")).status, 404);
});

test("an /api/ adapter route is never reached without authentication", async () => {
  let reached = false;
  const w = W.createWorker({ routes: [{ path: "/api/billing", handler: async () => { reached = true; return new Response("x"); } }] });
  // No session or bearer: authentication fails (needs no DB) before any adapter route.
  const stmt = { bind() { return stmt; }, async first() { return 1; } };
  const r = await call(w, "/api/billing", {}, { DB: { prepare: () => stmt } });
  assert.equal(r.status, 401); assert.equal(reached, false);
});

test("identity adapter: no provider means no browser sign-in via /auth/access-login", async () => {
  const r = await call(W.createWorker({}), "/auth/access-login", { method: "POST" });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error.code, "access_not_configured");
});

test("multi-user is the identity adapter's call; MULTI_USER overrides it", () => {
  const single = W.resolveAdapters({ identity: { multiUser: () => false } });
  const multi = W.resolveAdapters({ identity: { multiUser: () => true } });
  assert.equal(W.multiUserInstall(W.withAdapters({}, single)), false);
  assert.equal(W.multiUserInstall(W.withAdapters({}, multi)), true);
  assert.equal(W.multiUserInstall(W.withAdapters({ MULTI_USER: "1" }, single)), true);
  assert.equal(W.multiUserInstall(W.withAdapters({ MULTI_USER: "0" }, multi)), false);
  // Without createWorker (unit tests, old callers): the default identity is multi-user, like local dev before.
  assert.equal(W.multiUserInstall({}), true);
});

test("self-host identity: Cloudflare Access configured -> single-user; not configured -> multi-user (local dev)", () => {
  const A = W.accessIdentity;
  assert.equal(A.multiUser({ ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "aud" }), false);
  assert.equal(A.multiUser({}), true);
  assert.equal(W.multiUserInstall(W.withAdapters({ ACCESS_AUD: "aud" }, W.resolveAdapters({ identity: A }))), false);
});

test("self-host entry is createWorker with the Access identity (the shipped default export)", () => {
  const entry = readFileSync(join(ROOT, "packages/self-host/src/index.js"), "utf8");
  assert.match(entry, /export default createWorker\(\{ identity: accessIdentity \}\);/);
  assert.equal(typeof W.default.fetch, "function"); assert.equal(typeof W.default.scheduled, "function");
});

test("entitlements can refuse an operation before anything is written", async () => {
  const writes = [];
  const DB = { prepare(q) { writes.push(q); return { bind() { return this; } }; }, async batch(s) { writes.push("batch"); return s.map(() => ({ meta: { changes: 1 } })); } };
  const A = W.resolveAdapters({ entitlements: { async check(_env, op) { if (op === "workspace.create") { const e = new Error("Upgrade to create more workspaces"); e.status = 402; throw e; } } } });
  const ctx = { env: W.withAdapters({ MULTI_USER: "1", DB }, A), principal: { id: "hum_synthetic", kind: "human" }, requestId: "req_t" };
  await assert.rejects(W.createWorkspace(ctx, { name: "Team" }), /Upgrade/);
  assert.deepEqual(writes, []);
});

test("lifecycle hooks run after the change and never break it", async () => {
  const got = [];
  const A = W.resolveAdapters({ lifecycle: { async workspaceCreated(_env, ws) { got.push(ws.name); throw new Error("mail down"); } } });
  const DB = { prepare() { return { bind() { return this; } }; }, async batch(s) { return s.map(() => ({ meta: { changes: 1 } })); } };
  const ctx = { env: W.withAdapters({ MULTI_USER: "1", DB }, A), principal: { id: "hum_synthetic", kind: "human" }, requestId: "req_t" };
  const ws = await W.createWorkspace(ctx, { name: "Team" });
  assert.equal(ws.name, "Team"); assert.deepEqual(got, ["Team"]);
  // Unknown hooks are a no-op.
  await W.notify(ctx.env, "noSuchHook", {});
});

test("adapters survive env spreads (OAuth provider passes {...env})", () => {
  const A = W.resolveAdapters({ identity: { name: "x" } });
  const env = W.withAdapters({ DB: 1 }, A);
  assert.equal(W.adapters({ ...env, extra: 1 }).identity.name, "x");
  assert.equal(W.withAdapters(env, A), env);
});
