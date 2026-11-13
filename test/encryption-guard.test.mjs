// createWorker (packages/core/src/index.js) refuses content encryption in this release: while any content-encryption
// setting is present, every request answers 500 encryption_unsupported and the log names the setting, never its value.
// In process (test/load-worker.mjs) over the in-process D1 world; no listeners. Values are synthetic, per run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadWorker } from "./load-worker.mjs";
import { ROOT } from "./helpers.mjs";
import * as W from "./blind-tokens-world.mjs";

const lib = await loadWorker({ "index.js": ["createWorker"] });
const world = W.mkWorld();
const call = (env, adapters) => lib.createWorker(adapters).fetch(new Request("https://app.example.test/api/me"), { APP_HOST: "app.example.test", DB: world.DB, ...env }, { waitUntil() {} });
const SECRET = "SYNTH-VALUE-" + randomBytes(6).toString("hex");
const BODY = { error: { code: "encryption_unsupported", message: "Content encryption settings are present, but this release does not support content encryption; remove them" } };
const PROVIDER = () => ({ name: "synthetic-kms", configured: () => { throw new Error(SECRET); }, currentVersion: () => 1, wrap: async () => "x", unwrap: async () => null });

async function captureErrors(fn) {
  const lines = [], real = console.error;
  console.error = (...a) => lines.push(a.map(String).join(" "));
  try { await fn(); } finally { console.error = real; }
  return lines;
}
const unsupportedLines = (lines) => lines.filter((l) => l.includes("encryption_unsupported")).map((l) => JSON.parse(l));

test("each content-encryption setting refuses every request and logs its name, never its value", async () => {
  const rows = [
    ...["1", 1, "0", 0, SECRET].map((v) => [{ CONTENT_MASTER_KEY_VERSION: v }, undefined, "CONTENT_MASTER_KEY_VERSION"]),
    [{ CONTENT_MASTER_KEY_V1: SECRET }, undefined, "CONTENT_MASTER_KEY_V1"],
    [{ CONTENT_MASTER_KEY_V12: SECRET }, undefined, "CONTENT_MASTER_KEY_V12"],
    ...["1", 1, "true", "yes", true, false, "false", " 1", " 0", "0 ", SECRET].map((v) => [{ CONTENT_ENCRYPTION_REQUIRED: v }, undefined, "CONTENT_ENCRYPTION_REQUIRED"]),
    [{}, { keyProvider: PROVIDER() }, "keyProvider"],
  ];
  for (const [env, adapters, setting] of rows) {
    const label = JSON.stringify({ env: Object.keys(env), setting, value: typeof Object.values(env)[0] });
    let res, text;
    const lines = await captureErrors(async () => { res = await call(env, adapters); text = await res.text(); });
    assert.equal(res.status, 500, label);
    assert.deepEqual(JSON.parse(text), BODY, label);
    assert.deepEqual(unsupportedLines(lines), [{ event: "encryption_unsupported", setting }], label);
    assert.ok(!lines.some((l) => l.includes(SECRET)) && !text.includes(SECRET), label);
    assert.ok(!lines.some((l) => l.includes("encryption_misconfigured")), label);
  }
});

test("off values and unrelated settings do not refuse; CONTENT_HOST is a live hosted setting", async () => {
  // core only ever sees {...env} (adapters.js withAdapters), so own enumerable properties are everything the encryption code could read; do not narrow or widen the scan
  const rows = [
    [{}],
    ...[undefined, null, "", "0", 0].map((x) => [{ CONTENT_ENCRYPTION_REQUIRED: x }]),
    [{ CONTENT_MASTER_KEY_VERSION: "" }],
    [{ CONTENT_MASTER_KEY_VERSION: null }],
    [{ CONTENT_MASTER_KEY_V1: "" }],
    [{ CONTENT_HOST: "usercontent.example.test" }],
    [{ CONTENT_HOST: "usercontent.example.test", CONTENT_ENCRYPTION_REQUIRED: "0" }],
    [{ CONTENT_MASTER_KEY_V: SECRET }],
    [{ CONTENT_MASTER_KEY_V1X: SECRET }],
    [{}, { keyProvider: undefined }],
    [{}, { keyProvider: null }],
  ];
  for (const [env, adapters] of rows) {
    const label = JSON.stringify({ env: Object.keys(env), adapters: adapters && Object.keys(adapters) });
    let res, text;
    const lines = await captureErrors(async () => { res = await call(env, adapters); text = await res.text(); });
    assert.equal(res.status, 401, label + " " + text);
    assert.equal(JSON.parse(text).error.code, "unauthenticated", label);
    assert.deepEqual(unsupportedLines(lines), [], label);
  }
});

test("several settings: one line naming the first found, one line per request", async () => {
  const env = { CONTENT_ENCRYPTION_REQUIRED: "1", CONTENT_MASTER_KEY_VERSION: "1", CONTENT_MASTER_KEY_V1: SECRET };
  const lines = await captureErrors(async () => {
    for (let i = 0; i < 2; i++) {
      const res = await call(env);
      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), BODY);
    }
  });
  const want = { event: "encryption_unsupported", setting: "CONTENT_MASTER_KEY_VERSION" };
  assert.deepEqual(unsupportedLines(lines), [want, want]);
  assert.ok(!lines.some((l) => l.includes(SECRET)));
});

test("the cron keeps running its jobs while refused and logs once per run", async () => {
  const w = lib.createWorker();
  const BLOBS = { async list() { return { objects: [] }; }, async delete() {} };
  const run = async (extra) => {
    const waits = [];
    await w.scheduled({}, { DB: world.DB, BLOBS, ...extra }, { waitUntil: (p) => waits.push(p) });
    return { count: waits.length, settled: await Promise.allSettled(waits) };
  };
  const statements = () => world.log.flatMap((e) => e.q ? [e.q] : e.qs ?? []);
  const ranJobs = (qs) => qs.some((q) => q.trimStart().startsWith("DELETE FROM project_changes"))
    && qs.some((q) => q.trimStart().startsWith("SELECT id FROM projects WHERE purge_at"));

  world.log.length = 0;
  let base;
  const baseLines = await captureErrors(async () => { base = await run({}); });
  assert.ok(base.count >= 4, String(base.count));
  assert.ok(base.settled.every((s) => s.status === "fulfilled"), JSON.stringify(base.settled.map((s) => s.reason?.message)));
  assert.deepEqual(unsupportedLines(baseLines), []);
  assert.ok(ranJobs(statements()), JSON.stringify(statements()));

  world.log.length = 0;
  let ref;
  const refLines = await captureErrors(async () => { ref = await run({ CONTENT_MASTER_KEY_VERSION: "1" }); });
  assert.equal(ref.count, base.count);
  assert.ok(ref.settled.every((s) => s.status === "fulfilled"), JSON.stringify(ref.settled.map((s) => s.reason?.message)));
  assert.ok(ranJobs(statements()), JSON.stringify(statements()));
  assert.deepEqual(unsupportedLines(refLines), [{ event: "encryption_unsupported", setting: "CONTENT_MASTER_KEY_VERSION" }]);
});

test("index.js names the encryption settings exactly, never by a CONTENT prefix", () => {
  // CONTENT_HOST is a live hosted setting; a prefix test would refuse production.
  const src = readFileSync(join(ROOT, "packages", "core", "src", "index.js"), "utf8");
  assert.doesNotMatch(src, /CONTENT_(?![A-Z0-9])|\^CONTENT_(?!MASTER_KEY_V\\d\+\$\/)|startsWith\(\s*["'`]CONTENT|CONTENT(?![_A-Z])/);
  assert.ok(src.includes("/^CONTENT_MASTER_KEY_V\\d+$/"));
});

test("a supplied keyProvider is decided at construction: deleting it from the config afterwards still refuses", async () => {
  const cfg = { keyProvider: PROVIDER() };
  const w = lib.createWorker(cfg);
  delete cfg.keyProvider;
  let res;
  const lines = await captureErrors(async () => {
    res = await w.fetch(new Request("https://app.example.test/api/me"), { APP_HOST: "app.example.test", DB: world.DB }, { waitUntil() {} });
  });
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), BODY);
  assert.deepEqual(unsupportedLines(lines), [{ event: "encryption_unsupported", setting: "keyProvider" }]);
  assert.ok(!lines.some((l) => l.includes(SECRET)));
});

test("an Access misconfiguration is answered first; no encryption line is logged", async () => {
  let res;
  const lines = await captureErrors(async () => {
    res = await call({ ACCESS_TEAM_DOMAIN: "team.example.test", ACCESS_AUD: "synthetic-aud", CONTENT_MASTER_KEY_VERSION: "1" });
  });
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: { code: "misconfigured", message: "This build has no sign-in provider but Access is configured" } });
  assert.ok(!lines.some((l) => l.includes("encryption_unsupported")));
});
