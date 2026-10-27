// Files for OAuth (MCP) connections: list, read (inline image + short-lived download link), upload new files and
// versions (upload_begin -> HTTP PUT to the single-upload link -> upload_finish), history, revoke, limits and safety.
// Real local runtime (wrangler dev), real OAuth consent flow (DCR + owner consent), the official MCP SDK client and
// Chrome for History and the consent page. Synthetic fixtures only; tokens and links stay in memory, never printed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ROOT, LOCAL_CONFIG, sha256, key } from "./helpers.mjs";
import { startAppConnectServer } from "./fixtures/app-connect-harness.mjs";
import { SERVER_PORTS } from "./ports.mjs";
import { makeFixtures, makePng } from "./make-fixtures.mjs";
import { randomBytes } from "node:crypto";

const require = createRequire(import.meta.url);
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PUPPETEER = `${process.env.HOME}/.npm-packages/lib/node_modules/puppeteer`;
const haveChrome = existsSync(CHROME) && existsSync(PUPPETEER);
const P = "files", Q = "other";
let h, owner, fx, rw, ro, sdk;
const ids = {};
// Expire one upload (simulates its 15-minute window running out).
const expireUpload = (id) => sql(`UPDATE uploads SET expires_at = 1 WHERE id = '${id}'`);
const sql = async (q) => JSON.parse((await promisify(execFile)("wrangler", ["d1", "--config", LOCAL_CONFIG, "execute", "DB", "--local", "--persist-to", h.dir, "--json", "--command", q], { cwd: ROOT, env: { ...process.env, CI: "1", NO_COLOR: "1" } })).stdout)[0].results;

// Owner uploads through the browser API (begin -> PUT -> finish).
async function ownerUpload(pid, title, mime, bytes) {
  const b = await owner.req("POST", `/api/projects/${pid}/uploads`, { title, mime, size: bytes.length, sha256: sha256(bytes) });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  assert.equal((await owner.req("PUT", b.body.put_url, undefined, { raw: bytes, idem: false })).status, 200);
  const f = await owner.req("POST", `/api/projects/${pid}/uploads/${b.body.upload_id}/finish`, {});
  assert.equal(f.status, 200, JSON.stringify(f.body));
  return f.body.artifact_id;
}
// Agent upload through MCP tools and a plain HTTP PUT (no Authorization header) to the returned link.
async function agentUpload(agent, args, bytes, { put = bytes } = {}) {
  const b = await agent.call("upload_begin", { project_id: P, size: bytes.length, sha256: sha256(bytes), idempotency_key: key("ub"), ...args });
  if (b.isError) return { begin: b };
  const r = await fetch(b.data.put_url, { method: "PUT", body: put });
  const finishKey = key("uf");
  const f = await agent.call("upload_finish", { project_id: P, upload_id: b.data.upload_id, idempotency_key: finishKey });
  return { begin: b, put: r, finish: f, finishKey };
}

before(async () => {
  fx = makeFixtures();
  h = await startAppConnectServer({ port: SERVER_PORTS["oauth-files"], vars: { PROJECT_BINARY_BYTES: String(4 * 1024 * 1024) } });
  owner = await h.owner();
  for (const [id, title] of [[P, "Files"], [Q, "Other"]]) assert.equal((await owner.req("POST", "/api/projects", { id, title })).status, 201);
  ids.png = await ownerUpload(P, "Chart.png", "image/png", readFileSync(fx.png));
  ids.pdf = await ownerUpload(P, "Report.pdf", "application/pdf", readFileSync(fx.pdf));
  ids.mp4 = await ownerUpload(P, "Demo.mp4", "video/mp4", readFileSync(fx.mp4));
  ids.doc = (await owner.req("POST", `/api/projects/${P}/artifacts`, { title: "Notes", body: "# notes" })).body.artifact_id;
  ids.other = await ownerUpload(Q, "Elsewhere.png", "image/png", makePng(8, 8));
  // Owner's second PNG version, so revision N-1 exists.
  const b = await owner.req("POST", `/api/projects/${P}/uploads`, { artifact_id: ids.png, expected_revision: 1, mime: "image/png", size: makePng(16, 16).length, sha256: sha256(makePng(16, 16)) });
  await owner.req("PUT", b.body.put_url, undefined, { raw: makePng(16, 16), idem: false });
  assert.equal((await owner.req("POST", `/api/projects/${P}/uploads/${b.body.upload_id}/finish`, {})).status, 200);
  let consent = "";
  rw = await h.connectMcpAgent({ [P]: "write" }, { clientName: "Claude", onConsent: (html) => { consent = html; } });
  ids.consentHtml = consent;
  ro = await h.connectMcpAgent({ [P]: "read" }, { clientName: "Reader" });
  sdk = new Client({ name: "claude-sim", version: "2.1" });
  await sdk.connect(new StreamableHTTPClientTransport(new URL(`${h.issuer}/mcp`), { requestInit: { headers: { authorization: `Bearer ${rw.access_token}` } } }));
});
after(async () => { await sdk?.close(); await h?.stop(); });

test("consent page states that files are included and what Read and Edit allow", () => {
  const text = ids.consentHtml.replace(/<[^>]+>/g, "");
  assert.match(text, /Read: view documents and files \(images, PDFs, videos\) and their history, and download files\./);
  assert.match(text, /Edit: also create and change documents, and upload new files and new versions of files\./);
  assert.match(text, /Comments, trash and settings are never shared\./);
  assert.doesNotMatch(text, /Files, comments/);
});

test("tools: read connections get read_file and no upload tools; edit connections also get upload_begin/upload_finish", async () => {
  const roTools = (await ro.list()).map((t) => t.name);
  assert.ok(roTools.includes("read_file"));
  assert.ok(!roTools.includes("upload_begin") && !roTools.includes("upload_finish"));
  const tools = (await sdk.listTools()).tools;
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.ok(by.upload_begin && by.upload_finish && by.read_file);
  assert.deepEqual(by.upload_begin.inputSchema.required.sort(), ["change_note", "idempotency_key", "mime", "sha256", "size"]);
  assert.equal(by.read_file.annotations.readOnlyHint, true);
  assert.equal(by.upload_begin.annotations.readOnlyHint, false);
  assert.match(by.read_file.description, /not a share link/);
  assert.match(by.read_file.description, /web_url is for the user's browser/);
  assert.match(by.upload_begin.description, /5 MiB/);
  assert.match(sdk.getInstructions() ?? "", /read_file returns images inline/);
});

test("list: documents and files with kind, mime, size and revision; kind and mime_prefix filters", async () => {
  const all = (await sdk.callTool({ name: "list_artifacts", arguments: {} })).structuredContent.artifacts;
  const by = Object.fromEntries(all.map((a) => [a.title, a]));
  assert.deepEqual([by["Chart.png"].kind, by["Chart.png"].mime, by["Chart.png"].revision], ["binary", "image/png", 2]);
  assert.equal(by["Report.pdf"].mime, "application/pdf");
  assert.equal(by["Report.pdf"].size, readFileSync(fx.pdf).length);
  assert.equal(by["Demo.mp4"].mime, "video/mp4");
  assert.equal(by.Notes.kind, "markdown", "documents are still listed");
  assert.match(by["Chart.png"].web_url, new RegExp(`/p/${P}/a/${ids.png}$`));
  assert.ok(!all.some((a) => a.title === "Elsewhere.png"), "other projects are never listed");
  const imgs = (await sdk.callTool({ name: "list_artifacts", arguments: { mime_prefix: "image/" } })).structuredContent.artifacts;
  assert.deepEqual(imgs.map((a) => a.title), ["Chart.png"]);
  const bins = (await sdk.callTool({ name: "list_artifacts", arguments: { kind: "binary" } })).structuredContent.artifacts;
  assert.deepEqual(bins.map((a) => a.title).sort(), ["Chart.png", "Demo.mp4", "Report.pdf"]);
});

test("read: PNG comes back inline as MCP image content; PDF fetched through the download link with the right bytes", async () => {
  const png = await sdk.callTool({ name: "read_file", arguments: { artifact_id: ids.png } });
  assert.equal(png.isError, false);
  const img = png.content.find((c) => c.type === "image");
  assert.equal(img.mimeType, "image/png");
  assert.equal(sha256(Buffer.from(img.data, "base64")), sha256(makePng(16, 16)));
  assert.ok(png.content.some((c) => c.type === "resource_link" && c.uri === png.structuredContent.download_url));
  assert.equal(png.structuredContent.image_inline, true);
  assert.ok(!JSON.stringify(png.structuredContent).includes(img.data.slice(0, 40)), "image bytes are not duplicated into the JSON");
  const pdf = await sdk.callTool({ name: "read_artifact", arguments: { artifact_id: ids.pdf } });
  assert.equal(pdf.isError, false, "read_artifact handles files too");
  assert.ok(!pdf.content.some((c) => c.type === "image"));
  const exp = Date.parse(pdf.structuredContent.download_expires_at) - Date.now();
  assert.ok(exp > 0 && exp <= 10 * 60 * 1000 + 5000, "download link lives at most ~10 minutes");
  const r = await fetch(pdf.structuredContent.download_url);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/pdf");
  assert.match(r.headers.get("content-security-policy"), /sandbox/);
  assert.equal(sha256(Buffer.from(await r.arrayBuffer())), sha256(readFileSync(fx.pdf)));
  assert.equal((await fetch(pdf.structuredContent.download_url, { method: "POST" })).status, 405);
  // A chunked read (max_bytes) of an image returns the link, never an inline image that could not fit.
  const chunked = await sdk.callTool({ name: "read_artifact", arguments: { artifact_id: ids.png, max_bytes: 4096 } });
  assert.equal(chunked.isError, false, JSON.stringify(chunked.structuredContent));
  assert.ok(!chunked.content.some((c) => c.type === "image"));
  assert.equal(chunked.structuredContent.image_inline, false);
  // Without an MCP-Protocol-Version header (= 2025-03-26) there is no resource_link block; the link is in the text.
  const raw = await fetch(`${h.issuer}/mcp`, { method: "POST", headers: { authorization: `Bearer ${rw.access_token}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_file", arguments: { artifact_id: ids.pdf } } }) }).then((r) => r.json());
  assert.ok(!raw.result.content.some((c) => c.type === "resource_link"));
  assert.match(raw.result.content[0].text, /download_url/);
});

test("read: revision N-1 of the PNG; Range on the MP4", async () => {
  const old = await sdk.callTool({ name: "read_file", arguments: { artifact_id: ids.png, revision: 1 } });
  assert.equal(old.structuredContent.revision.rev, 1);
  const r = await fetch(old.structuredContent.download_url);
  assert.equal(sha256(Buffer.from(await r.arrayBuffer())), sha256(readFileSync(fx.png)));
  const mp4 = await sdk.callTool({ name: "read_file", arguments: { artifact_id: ids.mp4 } });
  const total = readFileSync(fx.mp4).length;
  const part = await fetch(mp4.structuredContent.download_url, { headers: { range: "bytes=0-99" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), `bytes 0-99/${total}`);
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), readFileSync(fx.mp4).subarray(0, 100));
  assert.equal((await fetch(mp4.structuredContent.download_url, { headers: { range: `bytes=${total + 5}-` } })).status, 416);
});

test("read: other project's file is not found; documents via read_file are refused; a forged link is 401", async () => {
  const cross = await sdk.callTool({ name: "read_file", arguments: { artifact_id: ids.other } });
  assert.equal(cross.structuredContent.error.status, 404);
  const doc = await sdk.callTool({ name: "read_file", arguments: { artifact_id: ids.doc } });
  assert.equal(doc.structuredContent.error.code, "unsupported_kind");
  assert.equal((await fetch(`${h.issuer}/files/d/ft_${"A".repeat(43)}`)).status, 401);
  assert.equal((await fetch(`${h.issuer}/files/d/nope`)).status, 404);
});

test("edit: create a PNG with a change note, then a new version; History shows the connection and the note", async () => {
  const made = await agentUpload(rw, { title: "Agent chart.png", mime: "image/png", change_note: "First chart" }, makePng(24, 24));
  assert.equal(made.put.status, 200);
  assert.equal(made.finish.isError, false, JSON.stringify(made.finish.data));
  assert.equal(made.finish.data.revision, 1);
  ids.agent = made.finish.data.artifact_id;
  const v2 = await agentUpload(rw, { artifact_id: ids.agent, expected_revision: 1, mime: "image/png", change_note: "Updated chart colours" }, makePng(32, 32));
  assert.equal(v2.finish.data.revision, 2);
  assert.match(v2.finish.data.web_url, new RegExp(`/a/${ids.agent}$`));
  const hist = (await owner.req("GET", `/api/projects/${P}/artifacts/${ids.agent}/history`)).body.revisions;
  assert.deepEqual(hist.map((v) => [v.rev, v.via?.kind, v.who, v.change_note]), [[2, "oauth", "Claude", "Updated chart colours"], [1, "oauth", "Claude", "First chart"]]);
  // A retried finish (same key) replays, no extra version.
  const again = await rw.call("upload_finish", { project_id: P, upload_id: v2.begin.data.upload_id, idempotency_key: v2.finishKey });
  assert.equal(again.data.revision_id, v2.finish.data.revision_id);
  assert.equal((await owner.req("GET", `/api/projects/${P}/artifacts/${ids.agent}/history`)).body.revisions.length, 2);
  // The owner can still upload while an agent upload is open (separate identities).
  const open = await rw.call("upload_begin", { project_id: P, title: "pending", mime: "image/png", size: 10, sha256: "a".repeat(64), change_note: "x", idempotency_key: key("ub") });
  assert.equal(open.isError, false);
  ids.openUpload = open.data.upload_id;
  ids.ownerWhileOpen = await ownerUpload(P, "Owner while agent uploads.png", "image/png", makePng(5, 5));
});

test("edit: stale expected_revision -> revision_conflict; retried begin replays; change_note required", async () => {
  const bytes = makePng(12, 12);
  const stale = await rw.call("upload_begin", { project_id: P, artifact_id: ids.agent, expected_revision: 1, mime: "image/png", size: bytes.length, sha256: sha256(bytes), change_note: "stale", idempotency_key: key("ub") });
  assert.equal(stale.data.error.code, "revision_conflict");
  assert.equal(stale.data.error.current_revision, 2);
  const noNote = await rw.call("upload_begin", { project_id: P, title: "x", mime: "image/png", size: bytes.length, sha256: sha256(bytes), change_note: "  ", idempotency_key: key("ub") });
  assert.equal(noNote.data.error.code, "change_note_required");
  const both = await rw.call("upload_begin", { project_id: P, title: "x", artifact_id: ids.agent, expected_revision: 2, mime: "image/png", size: bytes.length, sha256: sha256(bytes), change_note: "x", idempotency_key: key("ub") });
  assert.equal(both.data.error.code, "invalid_input");
});

test("edit: one active upload per connection; idempotent begin replay keeps the same upload", async () => {
  // Upload left open by the previous test still occupies this connection's slot.
  const bytes = makePng(13, 13);
  const k = key("ub");
  const blocked = await rw.call("upload_begin", { project_id: P, title: "second", mime: "image/png", size: bytes.length, sha256: sha256(bytes), change_note: "x", idempotency_key: k });
  assert.equal(blocked.data.error.code, "upload_in_progress");
  await expireUpload(ids.openUpload);
  const b1 = await rw.call("upload_begin", { project_id: P, title: "second", mime: "image/png", size: bytes.length, sha256: sha256(bytes), change_note: "x", idempotency_key: k });
  assert.equal(b1.isError, false, JSON.stringify(b1.data));
  const b2 = await rw.call("upload_begin", { project_id: P, title: "second", mime: "image/png", size: bytes.length, sha256: sha256(bytes), change_note: "x", idempotency_key: k });
  assert.equal(b2.data.upload_id, b1.data.upload_id);
  assert.equal((await fetch(b2.data.put_url, { method: "PUT", body: bytes })).status, 200);
  assert.equal((await rw.call("upload_finish", { project_id: P, upload_id: b1.data.upload_id, idempotency_key: key("uf") })).data.revision, 1);
  // Upload link is single-upload: after finish it no longer works.
  assert.equal((await fetch(b1.data.put_url, { method: "PUT", body: bytes })).status, 401);
});

test("limits and safety: size, MIME outside BINARY_TYPES, signature mismatch, SVG/HTML never served inline, upload link only PUT", async () => {
  // A fresh connection: the OAuth MCP endpoint allows 20 writes per minute per connection.
  const rw = await h.connectMcpAgent({ [P]: "write" }, { clientName: "Limits" });
  const big = await rw.call("upload_begin", { project_id: P, title: "big", mime: "video/mp4", size: 5 * 1024 * 1024 + 1, sha256: "a".repeat(64), change_note: "x", idempotency_key: key("ub") });
  assert.ok(big.isError);
  for (const mime of ["image/svg+xml", "text/html"]) {
    const bad = await rw.call("upload_begin", { project_id: P, title: "bad", mime, size: 10, sha256: "a".repeat(64), change_note: "x", idempotency_key: key("ub") });
    assert.ok(bad.isError, mime);
  }
  // SVG markup declared as PNG: the signature check refuses it at finish.
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const spoof = await agentUpload(rw, { title: "spoof.png", mime: "image/png", change_note: "spoof" }, svg);
  assert.equal(spoof.begin.isError, false, JSON.stringify(spoof.begin.data));
  assert.equal(spoof.finish.data.error.code, "signature_mismatch");
  // Raw markup as application/octet-stream is stored, but served only as a sandboxed attachment, never inline.
  const raw = await agentUpload(rw, { title: "page.html", mime: "application/octet-stream", change_note: "raw" }, Buffer.from("<html><script>alert(1)</script></html>"));
  assert.equal(raw.finish.isError, false, JSON.stringify(raw.finish.data));
  const rd = await rw.call("read_file", { project_id: P, artifact_id: raw.finish.data.artifact_id });
  const r = await fetch(rd.data.download_url);
  assert.equal(r.headers.get("content-type"), "application/octet-stream");
  assert.match(r.headers.get("content-disposition"), /^attachment/);
  assert.match(r.headers.get("content-security-policy"), /sandbox/);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  // Body larger than declared is refused by the PUT.
  const b = await rw.call("upload_begin", { project_id: P, title: "short", mime: "image/png", size: 10, sha256: "a".repeat(64), change_note: "x", idempotency_key: key("ub") });
  assert.equal(b.isError, false, JSON.stringify(b.data));
  assert.equal((await fetch(b.data.put_url, { method: "PUT", body: makePng(4, 4) })).status, 413);
  assert.equal((await fetch(b.data.put_url, { method: "GET" })).status, 405);
});

test("limits: an expired upload refuses the PUT; quota is enforced", async () => {
  const rw = await h.connectMcpAgent({ [P]: "write" }, { clientName: "Limits 2" });
  const bytes = makePng(9, 9);
  const b = await rw.call("upload_begin", { project_id: P, title: "late", mime: "image/png", size: bytes.length, sha256: sha256(bytes), change_note: "x", idempotency_key: key("ub") });
  assert.equal(b.isError, false, JSON.stringify(b.data));
  await expireUpload(b.data.upload_id);
  assert.equal((await fetch(b.data.put_url, { method: "PUT", body: bytes })).status, 410);
  await sql(`UPDATE transfer_links SET expires_at = 1 WHERE upload_id = '${b.data.upload_id}'`);
  assert.equal((await fetch(b.data.put_url, { method: "PUT", body: bytes })).status, 401, "expired link");
  const fin = await rw.call("upload_finish", { project_id: P, upload_id: b.data.upload_id, idempotency_key: key("uf") });
  assert.ok(fin.isError);
  // Quota: this server allows 4 MiB of files per project; a 5 MiB file (at the per-file cap) is refused.
  const q = await rw.call("upload_begin", { project_id: P, title: "too much", mime: "application/octet-stream", size: 5 * 1024 * 1024, sha256: "b".repeat(64), change_note: "q", idempotency_key: key("ub") });
  assert.equal(q.data.error.code, "quota_exceeded");
});

test("read-only connection: can list, read and download; every upload tool is refused and nothing changes", async () => {
  const before = (await owner.req("GET", `/api/projects/${P}/artifacts?kind=binary`)).body.artifacts.length;
  const list = await ro.call("list_artifacts", { project_id: P, kind: "binary" });
  assert.equal(list.isError, false);
  assert.equal(list.data.artifacts.length, before);
  const rd = await ro.call("read_file", { project_id: P, artifact_id: ids.pdf });
  assert.equal(rd.isError, false);
  assert.equal((await fetch(rd.data.download_url)).status, 200);
  const png = makePng(6, 6);
  const calls = {
    upload_begin: { project_id: P, title: "no", mime: "image/png", size: png.length, sha256: sha256(png), change_note: "x", idempotency_key: key("ub") },
    upload_file: { project_id: P, title: "no", mime: "image/png", content_base64: png.toString("base64"), change_note: "x", idempotency_key: key("uf") },
    upload_finish: { project_id: P, upload_id: "upl_doesnotexist", idempotency_key: key("uf") },
  };
  for (const [name, args] of Object.entries(calls)) {
    const r = await ro.call(name, args);
    assert.equal(r.status, 403, `${name}: a read-only token lacks the write scope`);
  }
  // Mixed connection (Edit on one project, Read on another): the write tools exist but refuse the read-only project.
  const mixed = await h.connectMcpAgent({ [P]: "write", [Q]: "read" }, { clientName: "Mixed" });
  const begun = await mixed.call("upload_begin", { project_id: P, title: "mixed", mime: "image/png", size: png.length, sha256: sha256(png), change_note: "x", idempotency_key: key("ub") });
  assert.equal(begun.isError, false, JSON.stringify(begun.data));
  for (const [name, args] of Object.entries({ ...calls, upload_finish: { upload_id: begun.data.upload_id, idempotency_key: key("uf") } })) {
    const r = await mixed.call(name, { ...args, project_id: Q });
    assert.equal(r.data.error.code, "forbidden", name);
    assert.match(r.data.error.message, /read-only for this project/);
  }
  assert.equal((await mixed.call("read_file", { project_id: Q, artifact_id: ids.other })).isError, false, "still reads the read-only project");
  await expireUpload(begun.data.upload_id);
  assert.equal((await owner.req("GET", `/api/projects/${P}/artifacts?kind=binary`)).body.artifacts.length, before, "nothing was created");
  assert.equal((await owner.req("GET", `/api/projects/${Q}/artifacts?kind=binary`)).body.artifacts.length, 1);
});

test("upload_file: one call with base64 bytes creates a file and a new version; retries replay; caps and bad input", async () => {
  const agent = await h.connectMcpAgent({ [P]: "write" }, { clientName: "Inline" });
  const v1 = makePng(20, 20);
  const k = key("uf");
  const made = await agent.call("upload_file", { project_id: P, title: "Inline.png", mime: "image/png", content_base64: v1.toString("base64"), change_note: "Inline screenshot", idempotency_key: k });
  assert.equal(made.isError, false, JSON.stringify(made.data));
  assert.equal(made.data.revision, 1);
  const again = await agent.call("upload_file", { project_id: P, title: "Inline.png", mime: "image/png", content_base64: v1.toString("base64"), change_note: "Inline screenshot", idempotency_key: k });
  assert.deepEqual([again.data.artifact_id, again.data.revision_id], [made.data.artifact_id, made.data.revision_id], "retry replays");
  // 1.5 MiB (a body over the old 1 MiB MCP limit) as a new version; the PNG signature check only reads the header.
  const big = Buffer.concat([makePng(4, 4), randomBytes(1.5 * 1024 * 1024)]);
  const v2 = await agent.call("upload_file", { project_id: P, artifact_id: made.data.artifact_id, expected_revision: 1, mime: "image/png", content_base64: big.toString("base64"), change_note: "Bigger", idempotency_key: key("uf") });
  assert.equal(v2.isError, false, JSON.stringify(v2.data));
  assert.equal(v2.data.revision, 2);
  const rd = await agent.call("read_file", { project_id: P, artifact_id: made.data.artifact_id, include_image: false });
  assert.equal(sha256(Buffer.from(await (await fetch(rd.data.download_url)).arrayBuffer())), sha256(big));
  const hist = (await owner.req("GET", `/api/projects/${P}/artifacts/${made.data.artifact_id}/history`)).body.revisions;
  assert.deepEqual(hist.map((v) => [v.rev, v.who, v.change_note]), [[2, "Inline", "Bigger"], [1, "Inline", "Inline screenshot"]]);
  const stale = await agent.call("upload_file", { project_id: P, artifact_id: made.data.artifact_id, expected_revision: 1, mime: "image/png", content_base64: v1.toString("base64"), change_note: "stale", idempotency_key: key("uf") });
  assert.equal(stale.data.error.code, "revision_conflict");
  const tooBig = await agent.call("upload_file", { project_id: P, title: "x", mime: "application/octet-stream", content_base64: randomBytes(2 * 1024 * 1024 + 1).toString("base64"), change_note: "x", idempotency_key: key("uf") });
  assert.equal(tooBig.data.error.code, "too_large");
  assert.match(tooBig.data.error.message, /upload_begin/);
  const bad = await agent.call("upload_file", { project_id: P, title: "x", mime: "image/png", content_base64: "not base64!!", change_note: "x", idempotency_key: key("uf") });
  assert.equal(bad.data.error.code, "invalid_input");
  const spoof = await agent.call("upload_file", { project_id: P, title: "x.png", mime: "image/png", content_base64: Buffer.from("<svg/>").toString("base64"), change_note: "x", idempotency_key: key("uf") });
  assert.equal(spoof.data.error.code, "signature_mismatch");
});

test("rate limit: the agent gets a readable tool error with the limit and how long to wait", async () => {
  const agent = await h.connectMcpAgent({ [P]: "write" }, { clientName: "Busy" });
  const c = new Client({ name: "busy", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${h.issuer}/mcp`), { requestInit: { headers: { authorization: `Bearer ${agent.access_token}` } } }));
  try {
    // The limiter counts calendar minutes: start well inside one so all 25 calls share a window.
    const left = 60_000 - (Date.now() % 60_000);
    if (left < 20_000) await new Promise((r) => setTimeout(r, left + 200));
    let limited = null;
    for (let i = 0; i < 25 && !limited; i++) {
      const r = await c.callTool({ name: "upload_finish", arguments: { upload_id: "upl_none", idempotency_key: key("uf") } });
      if (r.structuredContent?.error?.code === "rate_limited") limited = r;
    }
    assert.ok(limited, "21st write in a minute is limited");
    assert.equal(limited.isError, true);
    const e = limited.structuredContent.error;
    assert.equal(e.limit_per_minute, 20);
    assert.ok(e.retry_after_seconds >= 1 && e.retry_after_seconds <= 60);
    assert.match(e.message, /20 changes .* per minute\. Wait \d+ seconds, then retry/);
    assert.match(limited.content[0].text, /rate_limited/, "the model sees it in the text content too");
    assert.equal((await c.callTool({ name: "list_artifacts", arguments: {} })).isError, false, "reads have their own budget");
  } finally { await c.close(); }
});

test("restore: the owner restores the agent's first version; History records it", async () => {
  const r = await owner.req("POST", `/api/projects/${P}/artifacts/${ids.agent}/restore`, { expected_revision: 2, from_revision: 1, change_note: "Back to the first chart" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const hist = (await owner.req("GET", `/api/projects/${P}/artifacts/${ids.agent}/history`)).body.revisions;
  assert.deepEqual([hist[0].rev, hist[0].restored_from, hist[0].change_note], [3, 1, "Back to the first chart"]);
  const rd = await sdk.callTool({ name: "read_file", arguments: { artifact_id: ids.agent } });
  assert.equal(sha256(Buffer.from(rd.content.find((c) => c.type === "image").data, "base64")), sha256(makePng(24, 24)));
});

test("browser: History shows the agent's file version with who and why; Settings shows file access", { skip: !haveChrome && "Chrome not installed" }, async () => {
  const browser = await require(PUPPETEER).launch({ executablePath: CHROME, headless: true, args: ["--no-first-run"] });
  try {
    for (const scheme of ["light", "dark"]) {
      const page = await browser.newPage();
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
      await page.setViewport({ width: 1280, height: 900 });
      const [cn, cv] = owner.cookie.split("="); await page.setCookie({ name: cn, value: cv, url: h.appUi });
      await page.goto(`${h.appUi}/p/${P}/a/${ids.agent}`);
      await page.waitForFunction(() => [...document.querySelectorAll("[role=tab]")].some((t) => t.textContent.trim() === "History"));
      await page.evaluate(() => [...document.querySelectorAll("[role=tab]")].find((t) => t.textContent.trim() === "History").click());
      await page.waitForSelector(".vh-list .vh-row");
      const rows = await page.$$eval(".vh-list > li", (ls) => ls.map((l) => l.innerText.replace(/\s+/g, " ").trim()));
      assert.ok(rows.some((r) => /v2 .*Claude.*connected app.*via claude-sim 2\.1/.test(r) && /Updated chart colours/.test(r)), JSON.stringify(rows));
      await page.screenshot({ path: `tmp/test-evidence/oauth-files-history-${scheme}.png`, fullPage: true });
      await page.goto(`${h.appUi}/#/settings/apps`);
      await page.waitForSelector("article.conn");
      const cards = await page.$$eval("article.conn", (as) => as.map((a) => a.innerText));
      assert.ok(cards.some((c) => /Claude/.test(c)) && !cards.some((c) => /Documents only/.test(c)), "new connections include files");
      await page.close();
    }
  } finally { await browser.close(); }
});

test("browser: consent page wording renders in light and dark", { skip: !haveChrome && "Chrome not installed" }, async () => {
  const browser = await require(PUPPETEER).launch({ executablePath: CHROME, headless: true, args: ["--no-first-run"] });
  try {
    for (const scheme of ["light", "dark"]) {
      const page = await browser.newPage();
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
      await page.setContent(ids.consentHtml.replace(/<head>|<meta charset="utf-8">/, (m) => `${m}<base href="${h.issuer}/">`), { waitUntil: "load" });
      const fine = await page.$eval("p.fine", (p) => ({ text: p.innerText, color: getComputedStyle(p).color, bg: getComputedStyle(document.body).backgroundColor }));
      assert.match(fine.text, /images, PDFs, videos/);
      assert.match(fine.text, /upload new files and new versions of files/);
      assert.notEqual(fine.color, fine.bg);
      await page.screenshot({ path: `tmp/test-evidence/oauth-files-consent-${scheme}.png`, fullPage: true });
      await page.close();
    }
  } finally { await browser.close(); }
});

test("existing connections (approved before files) keep documents only until reconnected", async () => {
  const legacy = await h.connectMcpAgent({ [P]: "write" }, { clientName: "Legacy" });
  await sql("UPDATE oauth_connections SET file_access = 0 WHERE client_name = 'Legacy'");
  const names = (await legacy.list()).map((t) => t.name);
  assert.ok(!names.includes("read_file") && !names.includes("upload_begin"));
  const list = (await legacy.call("list_artifacts", { project_id: P })).data.artifacts;
  assert.ok(!list.some((a) => a.kind === "binary"), "no files listed");
  const rd = await legacy.call("read_artifact", { project_id: P, artifact_id: ids.png });
  assert.equal(rd.data.error.code, "not_found");
  // Every tool that names an artifact treats files as absent: history, diff and both restores too.
  const head = (await owner.req("GET", `/api/projects/${P}/artifacts/${ids.png}`)).body.artifact;
  for (const [name, args] of [["artifact_history", {}], ["diff_revisions", { from: 1, to: 2 }],
    ["restore_revision", { expected_revision: head.revision, from_revision: 1, change_note: "x", idempotency_key: key("r") }],
    ["restore_metadata", { expected_meta_version: head.meta_version, from_version: 1, change_note: "x", idempotency_key: key("m") }]]) {
    const r = await legacy.call(name, { project_id: P, artifact_id: ids.png, ...args });
    assert.equal(r.data.error.code, "not_found", name);
  }
  assert.equal((await owner.req("GET", `/api/projects/${P}/artifacts/${ids.png}`)).body.artifact.revision, head.revision, "nothing restored");
  assert.equal((await legacy.call("artifact_history", { project_id: P, artifact_id: ids.doc })).isError, false, "documents still work");
  const access = (await owner.req("GET", "/api/access")).body.connections.find((c) => c.client_name === "Legacy");
  assert.equal(access.files, false);
  // A download link minted before the downgrade stops working too.
  const minted = await rw.call("read_file", { project_id: P, artifact_id: ids.pdf });
  await sql("UPDATE oauth_connections SET file_access = 0 WHERE client_name = 'Claude'");
  assert.equal((await fetch(minted.data.download_url)).status, 401);
  await sql("UPDATE oauth_connections SET file_access = 1 WHERE client_name = 'Claude'");
});

test("a consent page shown before files were offered (no 'offered' marker) gives a documents-only connection", async () => {
  const wr = (args) => promisify(execFile)("wrangler", ["kv", "key", ...args, "--binding", "OAUTH_KV", "--local", "--config", LOCAL_CONFIG, "--persist-to", h.dir], { cwd: ROOT, env: { ...process.env, CI: "1", NO_COLOR: "1" } });
  const old = await h.connectMcpAgent({ [P]: "read" }, { clientName: "Old page", onConsent: async () => {
    // The page was rendered by the previous Worker: its stored context has no offered marker.
    const keys = JSON.parse((await wr(["list", "--prefix", "consentctx:"])).stdout);
    for (const { name } of keys) {
      const v = JSON.parse((await wr(["get", name])).stdout);
      if (v.offered !== "files") continue;
      delete v.offered;
      await wr(["put", name, JSON.stringify(v)]);
    }
  } });
  assert.ok(!(await old.list()).some((t) => t.name === "read_file"));
  assert.equal((await sql("SELECT file_access FROM oauth_connections WHERE client_name = 'Old page'"))[0].file_access, 0);
});

test("permission changes after minting: write downgrade stops the PUT; removing the project stops downloads", async () => {
  const agent = await h.connectMcpAgent({ [P]: "write" }, { clientName: "Downgraded" });
  const bytes = makePng(7, 7);
  const b = await agent.call("upload_begin", { project_id: P, title: "downgrade", mime: "image/png", size: bytes.length, sha256: sha256(bytes), change_note: "x", idempotency_key: key("ub") });
  assert.equal(b.isError, false, JSON.stringify(b.data));
  const rd = await agent.call("read_file", { project_id: P, artifact_id: ids.pdf });
  assert.equal((await fetch(rd.data.download_url, { method: "HEAD" })).status, 200);
  const cid = (await sql("SELECT id FROM oauth_connections WHERE client_name = 'Downgraded'"))[0].id;
  await sql(`UPDATE oauth_connection_projects SET can_write = 0 WHERE connection_id = '${cid}'`);
  assert.equal((await fetch(b.data.put_url, { method: "PUT", body: bytes })).status, 403);
  assert.equal((await fetch(rd.data.download_url)).status, 200, "still readable");
  await sql(`DELETE FROM oauth_connection_projects WHERE connection_id = '${cid}'`);
  assert.equal((await fetch(rd.data.download_url)).status, 401, "no projects left: connection is no longer live");
});

test("revoke: list, read, download link minted before revoke, PUT and finish all fail on the next request", async () => {
  const rw = await h.connectMcpAgent({ [P]: "write" }, { clientName: "Revoked" });
  const minted = await rw.call("read_file", { project_id: P, artifact_id: ids.pdf });
  assert.equal((await fetch(minted.data.download_url)).status, 200);
  const bytes = makePng(11, 11);
  const b = await rw.call("upload_begin", { project_id: P, title: "after", mime: "image/png", size: bytes.length, sha256: sha256(bytes), change_note: "x", idempotency_key: key("ub") });
  assert.equal(b.isError, false, JSON.stringify(b.data));
  const conn = (await owner.req("GET", "/api/access")).body.connections.find((c) => c.client_name === "Revoked" && c.status === "active");
  assert.equal((await owner.req("POST", `/api/connections/${conn.id}/revoke`, {})).status, 200);
  assert.equal((await rw.call("list_artifacts", { project_id: P })).status, 401);
  assert.equal((await rw.call("read_file", { project_id: P, artifact_id: ids.pdf })).status, 401);
  assert.equal((await fetch(minted.data.download_url)).status, 401);
  assert.equal((await fetch(b.data.put_url, { method: "PUT", body: bytes })).status, 401);
  assert.equal((await rw.call("upload_finish", { project_id: P, upload_id: b.data.upload_id, idempotency_key: key("uf") })).status, 401);
});
