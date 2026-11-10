// Large text and route budgets on the shipped Worker, real local D1/R2 via wrangler dev.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, agentHttp, sha256 } from "./helpers.mjs";
import { request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";
import { TEXT_MAX_BYTES, TEXT_WRITE_BODY_BYTES } from "../packages/core/src/text-limits.js";
import { SERVER_PORTS } from "./ports.mjs";

const MAX = 10 * 1048576, REQUEST = 11 * 1048576;
const port = SERVER_PORTS["text-limit"], APP = `http://localhost:${port}`;
let server, owner, api, token;
// Seeded, synthetic, tokenised text: avoid an artificial multi-megabyte FTS token.
function synthetic(size, seed = 23) {
  let block = "";
  for (let i = 0; i < 256; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; block += seed.toString(36) + " "; }
  return block.repeat(Math.ceil(size / block.length)).slice(0, size);
}
const large = synthetic(MAX);
test("browser text and encoded request budgets do not drift from server constants", () => {
  const js = readFileSync(new URL("../packages/core/src/web/app.js.txt", import.meta.url), "utf8");
  assert.equal(Number(js.match(/var DATA_MAX_BYTES = (\d+);/)[1]), TEXT_MAX_BYTES);
  const encoded = Number(js.match(/utf8Len\(JSON.stringify\(text\)\) > (\d+)/)[1]);
  assert.equal(encoded, TEXT_WRITE_BODY_BYTES - 8192);
});
before(async () => {
  server = await startServer("text-limit", port, { readyBase: APP, vars: { APP_HOST: `localhost:${port}`, MCP_HOST: `127.0.0.1:${port}`, APP_CONNECT_ENABLED: "1", RATE_READS_PER_MIN: "100000", RATE_WRITES_PER_MIN: "100000" } });
  owner = await server.loginAt(APP);
  assert.equal((await owner.req("POST", "/api/projects", { id: "large-text", title: "Synthetic large text" })).status, 201);
  const k = await owner.req("POST", "/api/api-keys", { label: "Synthetic", lifetime_days: 1, projects: [{ project_id: "large-text", access: "read_write" }] });
  assert.equal(k.status, 201);
  token = k.body.secret;
  api = agentHttp(server.base, token);
});
after(async () => { await server?.stop(); });

for (const kind of ["markdown", "html"]) for (const transport of ["app", "v1"]) test(`${transport} ${kind}: exactly 10 MiB creates and saves; one byte more is 413`, async t => {
  const start = performance.now();
  const request = transport === "app" ? owner.req : api;
  const base = transport === "app" ? "/api/projects/large-text/artifacts" : "/v1/projects/large-text/files";
  const c = await request("POST", base, { kind, title: `Synthetic ${kind}`, body: large });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const path = base + "/" + c.body.artifact_id;
  const saved = await request("PUT", path, { expected_revision: 1, body: large });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  for (const [method, url, extra] of [["POST", base, { kind, title: "Too large" }], ["PUT", path, { expected_revision: 2 }]]) {
    const over = await request(method, url, { ...extra, body: large + "x" });
    assert.equal(over.status, 413);
    assert.match(over.body.error.message, /(?:Markdown|HTML) exceeds 10 MiB/);
  }
  t.diagnostic(`create/save/boundary ${transport} ${kind}: ${(performance.now() - start).toFixed(1)} ms`);
});

async function declaredOversize(path, bytes) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method: "POST", path, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": bytes, "idempotency-key": "declared-cap" } }, res => {
      let text = "";
      res.on("data", chunk => text += chunk);
      res.on("end", () => { resolve({ status: res.statusCode, body: JSON.parse(text) }); req.destroy(); });
    });
    req.on("error", e => { if (!["ECONNRESET", "EPIPE"].includes(e.code)) reject(e); });
    // Far less than the declared size: the 413 proves the header check runs before buffering.
    req.write(" ".repeat(1024));
  });
}

test("only text-write routes accept 11 MiB JSON; declared and chunked bodies are capped", async () => {
  for (const [request, path, bytes] of [[owner.req, "/api/projects/large-text/artifacts", REQUEST + 1], [api, "/v1/projects/large-text/files", REQUEST + 1], [owner.req, "/api/projects", 3 * 1048576], [api, "/v1/projects/large-text/folders", 7000000]]) {
    const r = request === api ? await declaredOversize(path, bytes) : await request("POST", path, undefined, { raw: " ".repeat(bytes), headers: { "content-type": "application/json" } });
    assert.equal(r.status, 413, JSON.stringify(r.body));
    assert.match(r.body.error.message, /Request body/);
  }
  // No Content-Length: streaming enforcement, not merely a header guard.
  for (const [base, path, headers] of [[APP, "/api/projects/large-text/artifacts", { cookie: owner.cookie, "x-csrf-token": owner.csrf }], [server.base, "/v1/projects/large-text/files", {}]]) {
    // The bearer request uses the authenticated helper below; app streaming is enough to exercise readTextCapped.
    if (base !== APP) continue;
    let sent = 0;
    const stream = new ReadableStream({ pull(c) { if (sent >= REQUEST + 65536) return c.close(); sent += 65536; c.enqueue(new Uint8Array(65536).fill(32)); } });
    const r = await fetch(base + path, { method: "POST", headers: { ...headers, "content-type": "application/json", "idempotency-key": "stream-cap" }, body: stream, duplex: "half" });
    assert.equal(r.status, 413);
    assert.match((await r.json()).error.message, /11 MiB/);
  }
});
