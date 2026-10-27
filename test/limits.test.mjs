// Limits: per-identity rate limits (API + MCP + transfer), auth-failure throttling, one-active-upload
// (concurrent begin race), upload expiry, project storage quota (incl. concurrent reservations),
// and PDF download-only headers. Uses deliberately low deploy-time limits on an isolated server.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { startServer, agentHttp, mcpClient, setupProject, grant, sha256, key, barrier } from "./helpers.mjs";
import { SERVER_PORTS } from "./ports.mjs";

const P = "proj-limits";
const QUOTA = 64 * 1024;
let s, h;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A fresh 60s window, so counts in one test are not split across two windows.
async function freshWindow() { const ms = 60_000 - (Date.now() % 60_000); if (ms < 15_000) await sleep(ms + 200); }
const png = (n) => { const b = Buffer.alloc(n); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); randomBytes(n - 8).copy(b, 8); return b; };

before(async () => {
  s = await startServer("limits", SERVER_PORTS.limits, {
    vars: { RATE_READS_PER_MIN: "15", RATE_WRITES_PER_MIN: "8", RATE_AUTHFAIL_PER_MIN: "10", UPLOAD_TTL_SECONDS: "3", PROJECT_BINARY_BYTES: String(QUOTA) },
  });
  h = await s.login();
  await setupProject(h, P);
});
after(async () => { await s?.stop(); });

test("API reads: per-identity limit -> 429 with Retry-After; other identity unaffected", async () => {
  await freshWindow();
  const A = agentHttp(s.base, (await grant(h, P, "reader-a", false)).token);
  const B = agentHttp(s.base, (await grant(h, P, "reader-b", false)).token);
  const codes = [];
  for (let i = 0; i < 18; i++) codes.push((await A("GET", `/api/projects/${P}/artifacts`)).status);
  assert.equal(codes.filter((c) => c === 200).length, 15, codes.join(","));
  const last = await A("GET", `/api/projects/${P}/artifacts`);
  assert.equal(last.status, 429);
  assert.equal(last.body.error.code, "rate_limited");
  assert.ok(Number(last.headers.get("retry-after")) > 0);
  assert.equal((await B("GET", `/api/projects/${P}/artifacts`)).status, 200);
});

test("API writes: concurrent burst admits exactly the write budget", async () => {
  await freshWindow();
  const A = agentHttp(s.base, (await grant(h, P, "writer-burst")).token);
  const rs = await barrier(Array.from({ length: 12 }, (_, i) => () => A("POST", `/api/projects/${P}/artifacts`, { title: "burst " + i, body: "x" })));
  const ok = rs.filter((r) => r.status === 201).length, limited = rs.filter((r) => r.status === 429).length;
  assert.equal(ok, 8, rs.map((r) => r.status).join(","));
  assert.equal(limited, 4);
});

test("MCP: rate limit returns HTTP 429 to the real client; mutations use the write budget", async () => {
  await freshWindow();
  const g = await grant(h, P, "mcp-limited");
  const m = await mcpClient(s.base, g.token, "mcp-limited"); // initialize + initialized count as reads
  let ok = 0, err;
  for (let i = 0; i < 12; i++) {
    try { const r = await m.call("create_markdown", { project_id: P, title: "m" + i, idempotency_key: key("m") }); if (!r.isError) ok++; }
    catch (e) { err = e; break; }
  }
  assert.equal(ok, 8);
  assert.match(String(err?.message), /429|Too many requests/);
  await m.close().catch(() => {});
});

test("auth failures from one source are throttled to 429", async () => {
  await freshWindow();
  const bad = agentHttp(s.base, "alt_" + "x".repeat(40));
  const codes = [];
  for (let i = 0; i < 12; i++) codes.push((await bad("GET", `/api/projects/${P}/artifacts`)).status);
  // Limit is 10 failures/min per source; earlier failures in the same window (e.g. readiness probes) also count.
  const first429 = codes.indexOf(429);
  assert.ok(first429 > 0 && first429 <= 10, codes.join(","));
  assert.ok(codes.slice(0, first429).every((c) => c === 401));
  assert.ok(codes.slice(first429).every((c) => c === 429));
  await sleep(60_000 - (Date.now() % 60_000) + 200); // let the shared "local" auth-failure window reset
});

test("one active upload per identity: concurrent begins -> exactly one 201, others 429", async () => {
  await freshWindow();
  const A = agentHttp(s.base, (await grant(h, P, "uploader-race")).token);
  const b = png(1000);
  const rs = await barrier(Array.from({ length: 4 }, (_, i) => () =>
    A("POST", `/api/projects/${P}/uploads`, { title: "race" + i, mime: "image/png", size: b.length, sha256: sha256(b) })));
  assert.equal(rs.filter((r) => r.status === 201).length, 1, rs.map((r) => r.status).join(","));
  assert.ok(rs.filter((r) => r.status === 429).every((r) => r.body.error.code === "upload_in_progress"));
  const listed = await h.req("GET", `/api/projects/${P}/artifacts?q=race`);
  assert.equal(listed.body.artifacts.length, 0, "no placeholder artifacts become visible");
});

test("upload expiry: PUT after expiry -> 410, finish cannot publish, slot and reservation released", async () => {
  await freshWindow();
  const A = agentHttp(s.base, (await grant(h, P, "uploader-expiry")).token);
  const b = png(2000);
  const begin = await A("POST", `/api/projects/${P}/uploads`, { title: "expiring", mime: "image/png", size: b.length, sha256: sha256(b) });
  assert.equal(begin.status, 201);
  await sleep(3500);
  const put = await A("PUT", begin.body.put_url, undefined, { raw: b });
  assert.equal(put.status, 410);
  const fin = await A("POST", `/api/projects/${P}/uploads/${begin.body.upload_id}/finish`, {});
  assert.ok([409, 410].includes(fin.status), "finish status " + fin.status);
  const again = await A("POST", `/api/projects/${P}/uploads`, { title: "after-expiry", mime: "image/png", size: b.length, sha256: sha256(b) });
  assert.equal(again.status, 201, "expired upload no longer blocks the identity");
  const listed = await h.req("GET", `/api/projects/${P}/artifacts?q=expiring`);
  assert.equal(listed.body.artifacts.length, 0);
});

test("project quota: concurrent reservations from two identities cannot exceed the cap", async () => {
  await freshWindow();
  const A = agentHttp(s.base, (await grant(h, P, "quota-a")).token);
  const B = agentHttp(s.base, (await grant(h, P, "quota-b")).token);
  const C = agentHttp(s.base, (await grant(h, P, "quota-c")).token);
  const big = png(40 * 1024); // 2 x 40 KiB > 64 KiB quota
  const [ra, rb] = await barrier([A, B].map((X, i) => () =>
    X("POST", `/api/projects/${P}/uploads`, { title: "q" + i, mime: "image/png", size: big.length, sha256: sha256(big) })));
  const st = [ra.status, rb.status].sort();
  assert.deepEqual(st, [201, 413], JSON.stringify([ra.body, rb.body]));
  const winner = ra.status === 201 ? [A, ra] : [B, rb];
  // Publish the winner; published bytes stay charged (immutable history).
  assert.equal((await winner[0]("PUT", winner[1].body.put_url, undefined, { raw: big })).status, 200);
  assert.equal((await winner[0]("POST", `/api/projects/${P}/uploads/${winner[1].body.upload_id}/finish`, {})).status, 200);
  const over = await C("POST", `/api/projects/${P}/uploads`, { title: "over", mime: "image/png", size: big.length, sha256: sha256(big) });
  assert.equal(over.status, 413);
  assert.equal(over.body.error.code, "quota_exceeded");
  const fits = png(8 * 1024);
  assert.equal((await C("POST", `/api/projects/${P}/uploads`, { title: "fits", mime: "image/png", size: fits.length, sha256: sha256(fits) })).status, 201);
});

test("transfer PUT counts against the write budget", async () => {
  await freshWindow();
  const g = await grant(h, P, "put-spammer");
  const A = agentHttp(s.base, g.token);
  const b = png(500);
  const begin = await A("POST", `/api/projects/${P}/uploads`, { title: "spam", mime: "image/png", size: b.length, sha256: sha256(b) });
  assert.equal(begin.status, 201, JSON.stringify(begin.body)); // expired reservations no longer hold quota
  const codes = [];
  for (let i = 0; i < 10; i++) codes.push((await A("PUT", begin.body.put_url, undefined, { raw: Buffer.alloc(600) })).status); // oversize -> 413 each time
  assert.ok(codes.includes(429), codes.join(","));
});

test("PDF content is download-only: attachment + sandbox CSP + nosniff", async () => {
  await sleep(60_000 - (Date.now() % 60_000) + 200);
  const g = await grant(h, P, "pdf-check");
  const A = agentHttp(s.base, g.token);
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
  const begin = await A("POST", `/api/projects/${P}/uploads`, { title: "doc.pdf", mime: "application/pdf", size: pdf.length, sha256: sha256(pdf) });
  assert.equal(begin.status, 201, JSON.stringify(begin.body));
  assert.equal((await A("PUT", begin.body.put_url, undefined, { raw: pdf })).status, 200);
  const fin = await A("POST", `/api/projects/${P}/uploads/${begin.body.upload_id}/finish`, {});
  assert.equal(fin.status, 200);
  const r = await A("HEAD", `/api/projects/${P}/artifacts/${fin.body.artifact_id}/content`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-disposition"), /^attachment;/);
  assert.match(r.headers.get("content-security-policy"), /sandbox/);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
});
