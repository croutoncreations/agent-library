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
    "adapters.js": ["resolveAdapters", "withAdapters", "adapters", "notify", "defaultAdapters", "HOOK_MS"],
    "auth.js": ["authenticate", "sessionCookie"],
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
  const stmt = { bind() { return stmt; }, async first() { return 1; }, async run() { return { meta: { changes: 0 } }; } };
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
  // Fails closed: an env that didn't come through createWorker is a wiring bug, not "no provider".
  assert.throws(() => W.multiUserInstall({}), /createWorker/);
  assert.throws(() => W.adapters({ ACCESS_AUD: "aud" }), /createWorker/);
  assert.equal(W.multiUserInstall(W.withAdapters({}, W.defaultAdapters())), true);
});

test("self-host identity: Cloudflare Access configured -> single-user; not configured -> multi-user (local dev)", () => {
  const A = W.accessIdentity;
  assert.equal(A.multiUser({ ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "aud" }), false);
  assert.equal(A.multiUser({}), true);
  assert.equal(W.multiUserInstall(W.withAdapters({ ACCESS_AUD: "aud" }, W.resolveAdapters({ identity: A }))), false);
});

test("self-host entry is createWorker with the Access identity (the shipped default export)", () => {
  const entry = readFileSync(join(ROOT, "packages/self-host/src/index.js"), "utf8");
  assert.match(entry, /export default createWorker\(\{ identity: selfHostIdentity \}\);/);
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

test("a build without a sign-in provider refuses to run where Access is configured", async () => {
  const r = await call(W.createWorker({}), "/", {}, { ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "aud" });
  assert.equal(r.status, 500); assert.equal((await r.json()).error.code, "misconfigured");
});

test("enabled provider: a session without the provider's identity is refused (null fails closed)", async () => {
  const row = { csrf: "c", expires_at: Date.now() + 1e6, revoked_at: null, id: "hum_s", kind: "human", label: "S" };
  const stmt = { bind() { return stmt; }, async first() { return row; }, async run() { return { meta: { changes: 0 } }; } }; // run(): the limiter's occasional (2%) counter cleanup
  const mk = (session) => W.withAdapters({ DB: { prepare: () => stmt } }, W.resolveAdapters({ identity: { name: "x", enabled: () => true, session } }));
  const req = () => new Request(APP + "/api/me", { headers: { cookie: "al_session=ses_synthetic" } });
  await assert.rejects(W.authenticate(req(), mk(async () => null), "r"), (e) => e.status === 401);
  // Disabled provider: session() is not consulted.
  let called = false;
  const off = W.withAdapters({ DB: { prepare: () => stmt } }, W.resolveAdapters({ identity: { enabled: () => false, session: async () => { called = true; return null; } } }));
  const ctx = await W.authenticate(req(), off, "r").catch((e) => e);
  assert.equal(called, false); void ctx;
});

test("/api/ adapter routes refuse agent credentials unless they opt in; responses keep framing protection", async () => {
  const W2 = (agents) => W.createWorker({ routes: [{ path: "/api/billing", agents, handler: async () => new Response("ok", { headers: { "x-frame-options": "ALLOWALL", "content-security-policy": "default-src *" } }) }] });
  // A legacy-grant bearer: the grant row authenticates an agent (creator still a member).
  const grant = { id: "g", project_id: "p", can_write: 0, expires_at: Date.now() + 1e6, revoked_at: null, client_info: null, pid: "agt", kind: "agent", label: "A", creator_ok: 1 };
  const stmt = { bind() { return stmt; }, async first() { return grant; }, async run() { return {}; } };
  const env = { APP_HOST: "app.example.test", DB: { prepare: () => stmt }, RATE_READS_PER_MIN: "100000" };
  const hit = (w) => w.fetch(new Request(APP + "/api/billing", { headers: { authorization: "Bearer " + "a".repeat(40) } }), env, { waitUntil() {} });
  const denied = await hit(W2(undefined));
  assert.equal(denied.status, 403);
  // A person's cookie session reaches the route with ctx (no provider configured).
  const sess = { csrf: "c", expires_at: Date.now() + 1e6, revoked_at: null, id: "hum_s", kind: "human", label: "S" };
  const s2 = { bind() { return s2; }, async first() { return sess; }, async run() { return {}; } };
  const human = await W2(undefined).fetch(new Request(APP + "/api/billing", { headers: { cookie: "al_session=ses_synthetic" } }), { ...env, DB: { prepare: () => s2 } }, { waitUntil() {} });
  assert.equal(human.status, 200, await human.clone().text());
  const ok = await hit(W2(true));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("x-frame-options"), "DENY");
  assert.match(ok.headers.get("content-security-policy"), /frame-ancestors 'none'/);
});

test("adapter route RegExps with g/y flags are rejected (lastIndex would leak between requests)", () => {
  assert.throws(() => W.createWorker({ routes: [{ path: /^\/x$/g, handler: async () => new Response("") }] }), /g or y/);
});

test("a hanging lifecycle hook is cut off and logs no details", async () => {
  const logs = []; const orig = console.error; console.error = (...a) => logs.push(a.join(" "));
  const realSet = globalThis.setTimeout; globalThis.setTimeout = (f) => realSet(f, 5);
  try {
    const env = W.withAdapters({}, W.resolveAdapters({ lifecycle: { inviteCreated: () => new Promise(() => {}) } }));
    await W.notify(env, "inviteCreated", { acceptUrl: "https://app.example.test/invite/inv_secret", email: "x@example.test" });
    const env2 = W.withAdapters({}, W.resolveAdapters({ lifecycle: { inviteCreated: async () => { throw new Error("rejected x@example.test inv_secret"); } } }));
    await W.notify(env2, "inviteCreated", {});
  } finally { console.error = orig; globalThis.setTimeout = realSet; }
  assert.equal(logs.length, 2); assert.match(logs[0], /HookTimeout/);
  assert.ok(!logs.join("\n").includes("example.test") && !logs.join("\n").includes("inv_secret"));
  assert.equal(W.HOOK_MS, 5000);
});

test("session cookie: __Host- on https (legacy name cleared, still read); plain name on http", async () => {
  const https = W.sessionCookie(new URL("https://app.example.test/x"), "ses_abc", 60);
  assert.match(https[0], /^__Host-al_session=ses_abc; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=60$/);
  assert.doesNotMatch(https[0], /Domain=/);
  assert.match(https[1], /^al_session=; .*Max-Age=0$/);
  assert.deepEqual(W.sessionCookie(new URL("http://localhost:1/"), "ses_abc", 60), ["al_session=ses_abc; HttpOnly; SameSite=Strict; Path=/; Max-Age=60"]);
  const row = { csrf: "c", expires_at: Date.now() + 1e6, revoked_at: null, id: "hum_s", kind: "human", label: "S" };
  const seen = [];
  const stmt = { bind(h) { seen.push(h); return stmt; }, async first() { return row; }, async run() { return { meta: { changes: 0 } }; } };
  const env = W.withAdapters({ DB: { prepare: () => stmt } }, W.defaultAdapters());
  const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  // https: the __Host- cookie wins over a planted plain cookie (a sibling subdomain can only set the plain name).
  await W.authenticate(new Request("https://app.example.test/api/me", { headers: { cookie: "al_session=planted; __Host-al_session=real" } }), env, "r");
  assert.equal(seen.at(-1), await sha("real"));
  // Sessions issued before this release (plain name) still work.
  await W.authenticate(new Request("https://app.example.test/api/me", { headers: { cookie: "al_session=old" } }), env, "r");
  assert.equal(seen.at(-1), await sha("old"));
});

test("Turnstile fails closed on configuration mistakes (never silently off)", async () => {
  const T = await loadWorker({ "identity/turnstile.js": ["requireHuman"] });
  const realFetch = globalThis.fetch, logs = [], err = console.error;
  console.error = (...a) => logs.push(a.join(" "));
  try {
    // Off when unset.
    await T.requireHuman({}, undefined, "1.2.3.4", "app.example.test");
    // A copy-pasted key with a trailing newline: refuse (503), don't skip.
    await assert.rejects(T.requireHuman({ TURNSTILE_SITE_KEY: "0x4AAAAAAAsynthetic\n", TURNSTILE_SECRET_KEY: "s" }, "tok", null, "app.example.test"), (e) => e.status === 503 && e.code === "turnstile_not_configured");
    // Key without secret.
    await assert.rejects(T.requireHuman({ TURNSTILE_SITE_KEY: "0x4AAAAAAAsynthetic" }, "tok", null, "app.example.test"), (e) => e.status === 503);
    // Cloudflare says the secret is wrong: a configuration error (503), not "try again" for the visitor.
    globalThis.fetch = async () => new Response(JSON.stringify({ success: false, "error-codes": ["invalid-input-secret"] }), { headers: { "content-type": "application/json" } });
    await assert.rejects(T.requireHuman({ TURNSTILE_SITE_KEY: "0x4AAAAAAAsynthetic", TURNSTILE_SECRET_KEY: "wrong" }, "tok", null, "app.example.test"), (e) => e.status === 503);
    // A token solved on another hostname.
    globalThis.fetch = async () => new Response(JSON.stringify({ success: true, hostname: "evil.example" }), { headers: { "content-type": "application/json" } });
    await assert.rejects(T.requireHuman({ TURNSTILE_SITE_KEY: "0x4AAAAAAAsynthetic", TURNSTILE_SECRET_KEY: "s" }, "tok", null, "app.example.test"), (e) => e.status === 400);
    globalThis.fetch = async () => new Response(JSON.stringify({ success: true, hostname: "app.example.test" }), { headers: { "content-type": "application/json" } });
    await T.requireHuman({ TURNSTILE_SITE_KEY: "0x4AAAAAAAsynthetic", TURNSTILE_SECRET_KEY: "s" }, "tok", null, "app.example.test");
  } finally { globalThis.fetch = realFetch; console.error = err; }
  assert.ok(logs.some((l) => /turnstile_not_configured bad_site_key/.test(l)));
});
