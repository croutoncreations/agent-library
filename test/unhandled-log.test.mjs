// The catch-all loggers (index.js "unhandled", oauth/mcp.js "file_transfer_error", view-links.js "content_host_error")
// log the request id, the error's name (or type) and its message, except a SyntaxError's message, which quotes the
// input it failed to parse (content). Real bundle (test/load-worker.mjs) over a D1 stand-in whose every call throws.
// Synthetic values only; no listeners.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { loadWorker } from "./load-worker.mjs";

const W2 = await loadWorker({});
const m = "SYN-" + randomBytes(3).toString("hex");
let parseError;
try { JSON.parse(m); } catch (e) { parseError = e; }
assert.ok(parseError instanceof SyntaxError);
assert.ok(parseError.message.includes(m));

const TABLE = [
  [parseError, "SyntaxError", ""],
  [new Error("synthetic constraint text"), "Error", "synthetic constraint text"],
  ["a thrown string", "string", undefined],
];
const throwingDB = (thrown) => ({ prepare() { throw thrown; }, batch() { throw thrown; }, withSession() { return this; } });

async function captureErrors(fn) {
  const lines = [], real = console.error;
  console.error = (...a) => lines.push(a);
  try { await fn(); } finally { console.error = real; }
  return lines;
}

/** Runs one logger over the whole table: request(thrown) answers per check(res); its line follows the rule. */
async function eachThrown(event, request, check) {
  for (const [thrown, expectName, expectMessage] of TABLE) {
    let res;
    const lines = await captureErrors(async () => { res = await request(thrown); await check(res, expectName); });
    const line = lines.find((a) => a[0] === event);
    assert.ok(line, `${expectName}: no ${event} line in ${JSON.stringify(lines.map((a) => a.map(String)))}`);
    assert.match(String(line[1]), /^req_/);
    assert.equal(line[2], expectName);
    if (expectMessage !== undefined) assert.equal(line[3], expectMessage);
    assert.ok(!lines.some((a) => a.map(String).join(" ").includes(m)), `${expectName}: a line contains the parsed input`);
  }
}

test("the unhandled log names a SyntaxError and drops its message (it quotes content); other errors keep theirs", async () => {
  await eachThrown("unhandled",
    (thrown) => W2.default.fetch(new Request("http://127.0.0.1/api/projects", { headers: { cookie: "al_session=synthetic" } }), { LOCAL_DEV_LOGIN: "synthetic-local-pass", DB: throwingDB(thrown) }, { waitUntil() {} }),
    async (res, label) => {
      assert.equal(res.status, 500, label);
      assert.equal((await res.json()).error.code, "internal", label);
    });
});

test("file_transfer_error: the same rule", async () => {
  await eachThrown("file_transfer_error",
    (thrown) => W2.default.fetch(new Request("https://mcp.example.test/files/d/ft_" + "a".repeat(43)), { MCP_HOST: "mcp.example.test", APP_HOST: "app.example.test", DB: throwingDB(thrown) }, { waitUntil() {} }),
    async (res, label) => {
      assert.equal(res.status, 500, label);
      assert.equal((await res.json()).error.code, "internal", label);
    });
});

test("content_host_error: the same rule", async () => {
  await eachThrown("content_host_error",
    (thrown) => W2.default.fetch(new Request("https://usercontent.example.test/c/vl_" + "a".repeat(24)), { CONTENT_HOST: "usercontent.example.test", APP_HOST: "app.example.test", MCP_HOST: "mcp.example.test", DB: throwingDB(thrown) }, { waitUntil() {} }),
    async (res, label) => {
      assert.equal(res.status, 500, label);
      assert.equal(await res.text(), "Internal error", label);
    });
});
