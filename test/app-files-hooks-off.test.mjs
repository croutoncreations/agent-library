// App Files on a server WITHOUT AC_TEST_HOOKS (as every installation runs): the test-hook headers do nothing. Real
// local wrangler dev, the official App Connect flows, synthetic data only. Design addendum A4.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startAppConnectServer } from "./fixtures/app-connect-harness.mjs";
import { SERVER_PORTS } from "./ports.mjs";

let h, tok;
before(async () => {
  h = await startAppConnectServer({ port: SERVER_PORTS["app-files-hooks-off"], vars: { AC_TEST_HOOKS: null } });
  const owner = await h.owner();
  assert.equal((await owner.req("POST", "/api/projects", { id: "hooks-off", title: "Hooks off" })).status, 201);
  const app = await h.registerApp({ display_name: "Hooks off", redirect_uris: ["https://hooks-off.example.test/cb"], origins: [] });
  tok = (await h.connectPublisher(app, { project_id: "hooks-off", destination: "root" })).access_token;
});
after(async () => { await h?.stop(); });

const HOOKS = { "x-test-hold-publish-ms": "5000", "x-test-slot-reclaim-ms": "1", "x-test-pause-before-batch-ms": "5000",
  "x-test-pause-after-record-check-ms": "5000", "x-test-receive-deadline-ms": "1", "x-test-pause-tag": "hooksoff" };

test("hooks off: hook headers cause no delay, no x-test-slots-in-use header and no test_pause_entered line", async () => {
  const t0 = Date.now();
  const r = await fetch(`${h.api}/app/files/off.md`, { method: "PUT", body: "synthetic",
    headers: { authorization: `Bearer ${tok}`, "content-type": "text/markdown", "if-none-match": "*", "idempotency-key": "hooks-off-key-1", ...HOOKS } });
  const ms = Date.now() - t0;
  assert.equal(r.status, 201, await r.text());
  assert.equal(r.headers.get("x-test-slots-in-use"), null);
  assert.ok(ms < 2000, `no hook delay (${ms} ms)`);
  const g = await fetch(`${h.api}/app/files`, { headers: { authorization: `Bearer ${tok}`, ...HOOKS } });
  assert.equal(g.status, 200); assert.equal(g.headers.get("x-test-slots-in-use"), null);
  const t1 = Date.now();
  const snap = await fetch(`${h.api}/publisher/snapshots`, { method: "POST", body: JSON.stringify({ source_revision: 1, files: [{ name: "e.json", kind: "json", content: "{}" }] }),
    headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", "idempotency-key": "hooks-off-key-2", ...HOOKS } });
  assert.equal(snap.status, 201); assert.ok(Date.now() - t1 < 2000, "the snapshot pause hook does nothing");
  assert.doesNotMatch(readFileSync(h.logPath, "utf8"), /test_pause_entered/);
});
