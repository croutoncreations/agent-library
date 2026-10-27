// Security: Markdown XSS escaped, javascript: links dropped, cross-origin 403, cookie CSRF, MCP rejects cookies/foreign Origin.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startServer, agentHttp, setupProject, grant, sha256 } from "./helpers.mjs";
import { SERVER_PORTS } from "./ports.mjs";
import { makeFixtures } from "./make-fixtures.mjs";

const P = "proj-sec";
let s, h, A, token;
before(async () => {
  s = await startServer("sec", SERVER_PORTS.sec);
  h = await s.login();
  await setupProject(h, P);
  token = (await grant(h, P, "agent A")).token;
  A = agentHttp(s.base, token);
});
after(async () => { await s?.stop(); });

const PAYLOADS = [
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  "[click](javascript:alert(1))",
  "[click2](JaVaScRiPt:alert(1))",
  "[data](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
  "[vb](vbscript:msgbox(1))",
  '[q](https://ok.example/"onmouseover="alert(1))',
  "![img](javascript:alert(1))",
  "<svg onload=alert(1)>",
  "`<script>x</script>`",
  "```\n<iframe src=javascript:alert(1)></iframe>\n```",
  "# <b onclick=alert(1)>h</b>",
  "**<a href=javascript:alert(1)>x</a>**",
  "[ok](https://example.com/safe)",
];

test("Markdown preview escapes HTML and drops dangerous links", async () => {
  const c = await A("POST", `/api/projects/${P}/artifacts`, { title: "xss", body: PAYLOADS.join("\n\n") });
  assert.equal(c.status, 201);
  const pv = await A("GET", `/api/projects/${P}/artifacts/${c.body.artifact_id}/preview`);
  assert.equal(pv.status, 200);
  const html = pv.body.html;
  assert.doesNotMatch(html, /<(script|img|svg|iframe|b|object|embed)\b/i);
  // Event-handler text may appear *escaped* as visible text; it must never appear inside a real tag.
  for (const tag of html.match(/<[a-z][^>]*>/gi) ?? []) assert.doesNotMatch(tag, /\son\w+\s*=/i, tag);
  assert.deepEqual([...new Set((html.match(/<([a-z0-9]+)\b/gi) ?? []).map((t) => t.slice(1).toLowerCase()))].filter(
    (t) => !["p", "a", "code", "pre", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "em", "ul", "ol", "li", "blockquote"].includes(t)), []);
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
  for (const href of hrefs) assert.match(href, /^(https?:|mailto:)/i, href);
  assert.doesNotMatch(html, /href="\s*(javascript|data|vbscript):/i);
  assert.ok(hrefs.includes("https://example.com/safe"));
  // all anchors are inert-ish
  for (const a of html.match(/<a\b[^>]*>/g) ?? []) assert.match(a, /rel="noopener noreferrer nofollow"/);
  assert.match(html, /&lt;script&gt;/);
});

test("raw Markdown content is served as text/plain with nosniff and sandbox CSP", async () => {
  const c = await A("POST", `/api/projects/${P}/artifacts`, { title: "raw", body: "<script>alert(1)</script>" });
  const r = await A("GET", `/api/projects/${P}/artifacts/${c.body.artifact_id}/content`);
  assert.match(r.headers.get("content-type"), /^text\/plain/);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.match(r.headers.get("content-security-policy") ?? "", /sandbox/);
});

test("cross-origin Origin -> 403 on API (cookie and bearer) and MCP", async () => {
  const evil = { origin: "https://evil.example" };
  assert.equal((await h.req("POST", "/api/projects", { title: "x" }, { headers: evil })).status, 403);
  assert.equal((await h.req("GET", "/api/projects", undefined, { headers: evil })).status, 403);
  assert.equal((await A("GET", `/api/projects/${P}/artifacts`, undefined, { headers: evil })).status, 403);
  const m = await fetch(s.base + "/mcp", { method: "POST", headers: { ...evil, authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal(m.status, 403);
  // Same-origin header is allowed.
  assert.equal((await h.req("GET", "/api/projects", undefined, { headers: { origin: s.base } })).status, 200);
});

test("cookie mutations without (or with wrong) CSRF token -> 403 and nothing written", async () => {
  const before = (await h.req("GET", "/api/projects")).body.projects.length;
  assert.equal((await h.req("POST", "/api/projects", { title: "nocsrf" }, { noCsrf: true })).status, 403);
  assert.equal((await h.req("POST", "/api/projects", { title: "badcsrf" }, { noCsrf: true, headers: { "x-csrf-token": "csrf_wrong" } })).status, 403);
  assert.equal((await h.req("POST", `/api/projects/${P}/grants`, { label: "x", can_write: true }, { noCsrf: true })).status, 403);
  assert.equal((await h.req("GET", "/api/projects")).body.projects.length, before);
});

test("cookie transfer PUT without CSRF -> 403 (contract: cookie needs csrf header)", async () => {
  const png = readFileSync(makeFixtures().png);
  const b = await h.req("POST", `/api/projects/${P}/uploads`, { title: "human img", mime: "image/png", size: png.length, sha256: sha256(png) });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  const r = await h.req("PUT", b.body.put_url, undefined, { raw: png, noCsrf: true, idem: false });
  assert.equal(r.status, 403, `transfer PUT without csrf returned ${r.status}`);
  const ok = await h.req("PUT", b.body.put_url, undefined, { raw: png, idem: false });
  assert.equal(ok.status, 200);
});

test("MCP requires a bearer agent token: none or cookie -> 401 with resource_metadata", async () => {
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } };
  for (const headers of [{}, { cookie: h.cookie }, { authorization: "Bearer " + "y".repeat(40) }]) {
    const r = await fetch(s.base + "/mcp", { method: "POST", headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(init) });
    assert.equal(r.status, 401);
    assert.match(r.headers.get("www-authenticate") ?? "", /resource_metadata=/);
  }
});

test("security headers present on app shell", async () => {
  const r = await fetch(s.base + "/");
  assert.equal(r.headers.get("x-frame-options"), "DENY");
  assert.match(r.headers.get("content-security-policy") ?? "", /script-src 'self'/);
});
