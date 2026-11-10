// Large text and route budgets on the shipped Worker, real local D1/R2 via wrangler dev.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, agentHttp, sha256 } from "./helpers.mjs";
import { request as httpRequest } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
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
let documentId;
const artifactPath = id => `/api/projects/large-text/artifacts/${id}`;
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
  if (kind === "markdown" && transport === "app") documentId = c.body.artifact_id;
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

test("10 MiB search prefix is ranked; known gap excludes suffix-only words; rename and trash restore work", async t => {
  const start = performance.now();
  const ascii = "prefixneedle " + large.slice(13, 1048576) + " suffixneedle " + large.slice(1048590);
  const body = ascii.slice(0, 524286) + "é🙂" + ascii.slice(524292);
  assert.equal(Buffer.byteLength(body), MAX);
  assert.equal((await owner.req("PUT", artifactPath(documentId), { expected_revision: 2, body })).status, 200);
  for (const [word, count] of [["prefixneedle", 1], ["suffixneedle", 0]]) {
    const found = await owner.req("GET", `/api/search?query=${word}&project_ids=large-text`);
    assert.equal(found.status, 200, JSON.stringify(found.body));
    assert.equal(found.body.results.length, count, "known 1 MiB search gap");
  }
  for (const [version, change] of [[1, { title: "Renamed large document" }], [2, { trashed: true }], [3, { trashed: false }]]) {
    const r = await owner.req("PATCH", artifactPath(documentId), { expected_meta_version: version, ...change });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const found = await owner.req("GET", "/api/search?query=prefixneedle&project_ids=large-text");
  assert.equal(found.body.results[0].artifact_id, documentId);
  t.diagnostic(`real D1 save/search/rename/trash/restore: ${(performance.now() - start).toFixed(1)} ms`);
});

test("10 MiB chunks and HTTP Range reconstruct identical UTF-8 SHA-256", async () => {
  const expected = (await owner.req("GET", artifactPath(documentId))).body.body;
  const chunks = [];
  let cursor;
  do {
    const r = await api("GET", `/v1/projects/large-text/files/${documentId}/text?max_bytes=524288${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    chunks.push(r.body.text); cursor = r.body.next_cursor;
  } while (cursor);
  assert.equal(sha256(chunks.join("")), sha256(expected));
  const ranges = [];
  for (let start = 0; start < MAX; start += 524287) {
    const r = await owner.req("GET", artifactPath(documentId) + "/content", undefined, { binary: true, headers: { range: `bytes=${start}-${Math.min(MAX - 1, start + 524286)}` } });
    assert.equal(r.status, 206); ranges.push(r.body);
  }
  assert.equal(sha256(Buffer.concat(ranges)), sha256(expected));
});

test("two 10 MiB revisions return a bounded summary within 5 seconds", async t => {
  const start = performance.now();
  const diff = await owner.req("GET", artifactPath(documentId) + "/diff?from=2&to=3");
  const elapsed = performance.now() - start;
  assert.equal(diff.status, 200, JSON.stringify(diff.body).slice(0, 200));
  assert.equal(diff.body.truncated, true);
  assert.deepEqual(diff.body.hunks, []);
  assert.ok(JSON.stringify(diff.body).length < 2048);
  assert.ok(elapsed < 5000, `${elapsed} ms`);
  t.diagnostic(`10 MiB history diff: ${elapsed.toFixed(1)} ms`);
});

test("10 MiB template copy and restore-from-history retain the exact body", async () => {
  const source = (await owner.req("GET", artifactPath(documentId))).body.body;
  const template = await owner.req("POST", "/api/projects/large-text/templates", { source_artifact_id: documentId, source_revision: 3, title: "Large template" });
  assert.equal(template.status, 201, JSON.stringify(template.body));
  const copy = await owner.req("POST", "/api/projects/large-text/artifacts/from-template", { template_id: template.body.artifact_id, template_revision: 1, title: "Large copy" });
  assert.equal(copy.status, 201, JSON.stringify(copy.body));
  assert.equal(sha256((await owner.req("GET", artifactPath(copy.body.artifact_id))).body.body), sha256(source));
  const restored = await owner.req("POST", artifactPath(documentId) + "/restore", { expected_revision: 3, from_revision: 1 });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal(sha256((await owner.req("GET", artifactPath(documentId))).body.body), sha256(large));
});

test("near-10 MiB JSON measurements and CSV validate, preview, query and replace with an added record/row", async t => {
  const M = "agentlib.measurements/1";
  const records = Array.from({ length: 1100 }, (_, i) => ({ id: `syn-${i}`, recorded_at: "synthetic-clock", date: "2026-01-02", metric: "counter", value: i, unit: "n" }));
  const doc = { schema: M, records, meta: { padding: "" } };
  doc.meta.padding = "x".repeat(MAX - 4096 - Buffer.byteLength(JSON.stringify(doc)));
  const json = JSON.stringify(doc);
  const csv = "id,padding\n" + Array.from({ length: 2000 }, (_, i) => `syn-${i},${"x".repeat(5220)}\n`).join("");
  assert.ok(Buffer.byteLength(json) > MAX - 1048576 && Buffer.byteLength(json) < MAX);
  assert.ok(Buffer.byteLength(csv) > MAX - 1048576 && Buffer.byteLength(csv) < MAX);
  const files = {};
  for (const [kind, content, schema] of [["json", json, M], ["csv", csv, undefined]]) {
    const made = await owner.req("POST", "/api/projects/large-text/artifacts", { title: `Large ${kind}`, kind, content, schema });
    assert.equal(made.status, 201, JSON.stringify(made.body)); files[kind] = made.body.artifact_id;
  }
  const start = performance.now();
  const first = await owner.req("GET", artifactPath(files.json) + "/records?from=2026-01-01&to=2026-01-03&limit=500");
  const elapsed = performance.now() - start;
  assert.equal(first.status, 200); assert.deepEqual(first.body.records, records.slice(0, 500));
  const queried = [...first.body.records];
  let cursor = first.body.next_cursor;
  while (cursor) {
    const page = await owner.req("GET", artifactPath(files.json) + `/records?from=2026-01-01&to=2026-01-03&limit=500&cursor=${cursor}`);
    assert.equal(page.status, 200); queried.push(...page.body.records); cursor = page.body.next_cursor;
  }
  assert.deepEqual(queried, records);
  const csvQuery = await owner.req("GET", artifactPath(files.csv) + "/records");
  assert.equal(csvQuery.status, 422); assert.equal(csvQuery.body.error.code, "schema_not_queryable");
  const spreadsheet = await owner.req("GET", artifactPath(files.csv) + "/content?format=spreadsheet", undefined, { binary: true });
  assert.equal(spreadsheet.status, 200);
  assert.equal(sha256(spreadsheet.body), sha256(csv.replace(/\n/g, "\r\n")));
  const extra = { ...records[0], id: "syn-added", value: 1100 };
  doc.records.push(extra);
  assert.equal((await owner.req("PUT", artifactPath(files.json), { expected_revision: 1, content: JSON.stringify(doc) })).status, 200);
  const added = await owner.req("GET", artifactPath(files.json) + "/records?cursor=1100");
  assert.deepEqual(added.body.records, [extra]);
  const nextCsv = csv + "syn-added,new-row\n";
  assert.equal((await owner.req("PUT", artifactPath(files.csv), { expected_revision: 1, content: nextCsv })).status, 200);
  assert.equal(sha256((await owner.req("GET", artifactPath(files.csv))).body.content), sha256(nextCsv));

  const chrome = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const modulePath = `${process.env.HOME}/.npm-packages/lib/node_modules/puppeteer`;
  assert.ok(existsSync(chrome) && existsSync(modulePath), "Chrome and Puppeteer required for the real preview check");
  const puppeteer = createRequire(import.meta.url)(modulePath);
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    const [name, value] = owner.cookie.split("=");
    await page.setCookie({ name, value, url: APP });
    const errors = []; page.on("pageerror", e => errors.push(e.message));
    for (const kind of ["json", "csv"]) {
      await page.goto(`${APP}/#/p/large-text/a/${files[kind]}`);
      await page.waitForSelector(".datafile .data-summary");
      const summary = await page.$eval(".data-summary", el => el.textContent);
      assert.match(summary, kind === "csv" ? /2,001 rows/ : /Object/);
      if (kind === "csv") assert.ok(await page.$(".data-table td"));
    }
    const opened = performance.now();
    await page.goto(`${APP}/#/p/large-text/a/${documentId}`);
    await page.waitForFunction(() => document.querySelector(".preview p")?.textContent.length > 1000000);
    const previewMs = performance.now() - opened;
    await page.evaluate(() => [...document.querySelectorAll('[role="tab"]')].find(el => el.textContent === "Edit").click());
    await page.waitForSelector(".cm-editor");
    assert.equal(await page.$eval("textarea.editor", el => el.value.length), MAX);
    t.diagnostic(`Chrome 10 MiB Markdown preview ${previewMs.toFixed(1)} ms; editor mounted by ${(performance.now() - opened).toFixed(1)} ms`);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
  t.diagnostic(`JSON ${Buffer.byteLength(json)} bytes; CSV ${Buffer.byteLength(csv)} bytes; JSON read_records ${elapsed.toFixed(1)} ms`);
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
  const escaped = await owner.req("POST", "/api/projects/large-text/artifacts", { title: "Escaped request", body: '"'.repeat(6 * 1048576) });
  assert.equal(escaped.status, 413); assert.match(escaped.body.error.message, /11 MiB request-size/);
  // No Content-Length: streaming enforcement, not merely a header guard.
  for (const [base, path, headers] of [[APP, "/api/projects/large-text/artifacts", { cookie: owner.cookie, "x-csrf-token": owner.csrf }]]) {
    let sent = 0;
    const stream = new ReadableStream({ pull(c) { if (sent >= REQUEST + 65536) return c.close(); sent += 65536; c.enqueue(new Uint8Array(65536).fill(32)); } });
    const r = await fetch(base + path, { method: "POST", headers: { ...headers, "content-type": "application/json", "idempotency-key": "stream-cap" }, body: stream, duplex: "half" });
    assert.equal(r.status, 413);
    assert.match((await r.json()).error.message, /11 MiB/);
  }
  const streamed = await new Promise((resolve, reject) => {
    let sent = 0, stopped = false;
    const req = httpRequest({ host: "127.0.0.1", port, method: "POST", path: "/v1/projects/large-text/files", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": "stream-v1-cap" } }, res => {
      stopped = true;
      let text = ""; res.on("data", chunk => text += chunk);
      res.on("end", () => { resolve({ status: res.statusCode, body: JSON.parse(text) }); req.destroy(); });
    });
    req.on("error", e => { if (!["ECONNRESET", "EPIPE"].includes(e.code)) reject(e); });
    const send = () => {
      if (stopped) return;
      if (sent > REQUEST + 65536) return req.end();
      sent += 65536;
      if (req.write(Buffer.alloc(65536, 32))) setImmediate(send); else req.once("drain", send);
    };
    send();
  });
  assert.equal(streamed.status, 413); assert.match(streamed.body.error.message, /11 MiB/);
});
