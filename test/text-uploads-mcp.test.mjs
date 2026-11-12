// Text uploads through both MCP transports (legacy bearer grants and OAuth connections), against a running Worker
// (wrangler dev), with the official MCP SDK client. Small tool calls for begin/finish; the bytes go by a real HTTP PUT.
// Synthetic data only; tokens and upload links stay in memory.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startAppConnectServer } from "./fixtures/app-connect-harness.mjs";
import { SERVER_PORTS } from "./ports.mjs";
import { ROOT, LOCAL_CONFIG, key, grant, sha256 } from "./helpers.mjs";
import { makePng } from "./make-fixtures.mjs";

const P = "text-mcp";
const MIB10 = 10 * 1024 * 1024;
let h, owner, oauth, oauthToken, legacy, legacyToken, roGrantToken;

// Plan section 5 wording (App Connect enabled).
const BEGIN_COMMON = "Start a text document (UTF-8, up to 10 MiB) or binary upload (plan file limit, at most 90 MiB). New: pass title; new version: artifact_id and expected_revision. Declare mime, exact size and SHA-256; HTTP PUT raw bytes to put_url, then call upload_finish. Keep your local file on conflict. Set change_note to why.";
const BEGIN_LEGACY = BEGIN_COMMON + " Resolve a relative put_url against this server and use the same bearer credential.";
const BEGIN_OAUTH = BEGIN_COMMON + " The returned upload link needs no Authorization header. Binary-only upload_file is available up to 2 MiB if HTTP PUT is unavailable.";
const FINISH = "Validate uploaded bytes and publish one immutable version: UTF-8 and document rules for text, type signature for binaries. Safe to retry with the same key. Validation failure ends the upload; correct the file and start upload_begin again. A revision conflict requires re-reading and merging.";
const SAVE_ADD = "For large Markdown or HTML that will not fit a tool request, use upload_begin → HTTP PUT raw UTF-8 → upload_finish, if those tools are available and you can make HTTP requests.";
const CREATE_ADD = "For large text, use upload_begin → HTTP PUT → upload_finish when available.";
const DIFF = "Compare two versions (default: current against previous). Text diffs return unified hunks and added/removed counts when bounded; non-identical inputs over 1 MiB or 20,000 lines return no hunks and null counts. Identical hashes still report identical.";
const FIELDS = {
  mime: "Exact MIME type: text/markdown, text/html, application/json, text/csv, or a supported binary type.",
  size: "Raw byte length, not JSON-escaped length. Text: at most 10,485,760 bytes; binaries: plan file limit.",
  title: "Title for a new document or file.",
  artifact_id: "Existing document or file to add a version to; also pass expected_revision.",
  schema: "New JSON/CSV: agentlib.measurements/1 to validate measurement records; omit for no schema. Existing documents keep their stored schema.",
  folder: "Legacy folder label for a new document or file.",
  folder_id: "Same-project folder ID for a new text document (App Connect required); omit for project root.",
};
const OAUTH_BEGIN_INSTRUCTIONS = "HTTP PUT exactly size raw bytes to put_url; no Authorization header is needed. Text must be UTF-8. Then call upload_finish with upload_id. This link is only for this upload and expires at expires_at.";
const LEGACY_TEXT_INSTRUCTIONS = "PUT the raw bytes to put_url with the same credentials (and CSRF token for a cookie session), then call upload_finish. Text must be UTF-8.";
const OVER_LEGACY = "Payload too large. For document content, use upload_begin, HTTP PUT raw UTF-8 bytes to put_url with your bearer credential, then upload_finish (text up to 10 MiB). This requires an HTTP-capable client; otherwise send a smaller document.";
const OVER_FILES = "Payload too large. For document content, use upload_begin, HTTP PUT raw UTF-8 bytes to put_url, then upload_finish (text up to 10 MiB). This requires an HTTP-capable client; otherwise send a smaller document.";
const OVER_DOCS = "Payload too large. This connection has no upload tools. Send a smaller document, or ask the owner to reconnect with file access and use upload_begin → HTTP PUT → upload_finish from an HTTP-capable client.";

const sql = (q) => JSON.parse(execFileSync("wrangler", ["d1", "--config", LOCAL_CONFIG, "execute", "DB", "--local", "--persist-to", h.dir, "--json", "--command", q], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1", NO_COLOR: "1" } }))[0].results;
async function sdkClient(base, token, name) {
  const c = new Client({ name, version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  const call = async (tool, args) => { const r = await c.callTool({ name: tool, arguments: args }); return { isError: !!r.isError, data: r.structuredContent }; };
  return { client: c, call };
}
// Exactly n bytes of text with a distinct first line (more than 20,000 lines in total at 10 MiB).
function bigText(kind, tag, n = MIB10) {
  const head = kind === "html" ? `<h1>${tag}</h1>\n` : `# ${tag}\n`;
  const line = (kind === "html" ? "<p>" + "x".repeat(92) + "</p>" : "y".repeat(99)) + "\n";
  const body = Buffer.alloc(n, 0x20);
  body.write(head, 0, "utf8");
  for (let o = head.length; o + line.length <= n; o += line.length) body.write(line, o, "utf8");
  assert.equal(body.length, n);
  return body;
}
const MIME = { markdown: "text/markdown", html: "text/html", json: "application/json", csv: "text/csv" };
// One upload through a transport: begin (tool) → real HTTP PUT → finish (tool).
async function upload(t, transport, args, bytes) {
  const begin = await t.call("upload_begin", { project_id: P, size: bytes.length, sha256: sha256(bytes), idempotency_key: key("ub"), change_note: "Synthetic upload", ...args });
  if (begin.isError) return { begin };
  const put = transport === "legacy"
    ? await fetch(new URL(begin.data.put_url, h.appUi), { method: "PUT", body: bytes, headers: { authorization: `Bearer ${legacyToken}` } })
    : await fetch(begin.data.put_url, { method: "PUT", body: bytes });
  const finishKey = key("uf");
  const finish = await t.call("upload_finish", { project_id: P, upload_id: begin.data.upload_id, idempotency_key: finishKey });
  return { begin, put, finish, finishKey };
}
const content = async (id, rev) => Buffer.from(await (await fetch(`${h.appUi}/api/projects/${P}/artifacts/${id}/content${rev ? "?rev=" + rev : ""}`, { headers: { cookie: owner.cookie } })).arrayBuffer());

before(async () => {
  h = await startAppConnectServer({ port: SERVER_PORTS["text-uploads-mcp"] });
  owner = await h.owner();
  assert.equal((await owner.req("POST", "/api/projects", { id: P, title: "Synthetic text MCP" })).status, 201);
  const rw = await h.connectMcpAgent({ [P]: "write" }, { clientName: "Synthetic OAuth uploader" });
  oauthToken = rw.access_token;
  oauth = await sdkClient(h.issuer, oauthToken, "synthetic-oauth");
  legacyToken = (await grant(owner, P, "Synthetic legacy uploader")).token;
  legacy = await sdkClient(h.appUi, legacyToken, "synthetic-legacy");
  roGrantToken = (await grant(owner, P, "Synthetic legacy reader", false)).token;
});
after(async () => { await oauth?.client.close(); await legacy?.client.close(); await h?.stop(); });

test("tool lists: upload_begin, upload_finish, save/create and diff descriptions and schemas on both transports (App Connect on)", async () => {
  for (const [transport, c] of [["legacy", legacy], ["oauth", oauth]]) {
    const tools = Object.fromEntries((await c.client.listTools()).tools.map((t) => [t.name, t]));
    const b = tools.upload_begin;
    assert.equal(b.description, transport === "legacy" ? BEGIN_LEGACY : BEGIN_OAUTH, transport);
    for (const [f, d] of Object.entries(FIELDS)) assert.equal(b.inputSchema.properties[f]?.description, d, `${transport} ${f}`);
    assert.equal(b.inputSchema.properties.size.minimum, 0);
    assert.equal(b.inputSchema.properties.size.maximum, 90 * 1024 * 1024);
    assert.deepEqual(b.inputSchema.properties.schema.enum, ["agentlib.measurements/1", null]);
    assert.ok(b.inputSchema.properties.change_note, transport);
    assert.equal(tools.upload_finish.description, FINISH, transport);
    assert.ok(tools.save_markdown.description.endsWith(" " + SAVE_ADD), transport);
    assert.match(tools.save_markdown.description, /Always set change_note/);
    assert.ok(tools.create_markdown.description.endsWith(" " + CREATE_ADD), transport);
    assert.equal(tools.diff_revisions.description, DIFF, transport);
    if (transport === "oauth") {
      assert.equal(b.title, "Start upload");
      assert.deepEqual(b.inputSchema.properties.mime.enum.slice(-4), ["text/markdown", "text/html", "application/json", "text/csv"]);
      assert.deepEqual(b.inputSchema.required.sort(), ["change_note", "idempotency_key", "mime", "sha256", "size"]);
      // upload_file stays binary-only.
      assert.ok(!tools.upload_file.inputSchema.properties.mime.enum.some((m) => m.startsWith("text/") || m === "application/json"));
      assert.match(tools.upload_file.description, /^Upload a file in one call, bytes as content_base64/);
      const instr = c.client.getInstructions();
      assert.match(instr, /For large text \(up to 10 MiB\), use upload_begin, HTTP PUT raw UTF-8 bytes to put_url, then upload_finish\. Binary files use the same flow, or binary-only upload_file for up to 2 MiB inline\./);
      assert.doesNotMatch(instr, /To add a file or a new version/);
    } else {
      assert.equal(c.client.getInstructions(), "Agent Library: project-scoped Markdown, HTML and supported data documents, plus binary artifacts. Saves require expected_revision; mutations require idempotency_key. When saving, creating or restoring a document (tools with a change_note field), always set change_note to one line on why; the owner reads it in History. Large text uses upload_begin → HTTP PUT raw UTF-8 → upload_finish; this needs an HTTP-capable client.");
      assert.doesNotMatch(b.description, /5 MiB/);
    }
  }
});

for (const kind of ["markdown", "html"]) for (const transport of ["legacy", "oauth"]) {
  test(`${transport} ${kind}: exactly 10 MiB create and a second 10 MiB version, read back, history, stale conflict, diff summary`, async () => {
    const c = transport === "legacy" ? legacy : oauth;
    const v1 = bigText(kind, `${transport}-${kind}-v1`), v2 = bigText(kind, `${transport}-${kind}-v2`);
    const a = await upload(c, transport, { title: `Big ${kind} via ${transport}`, mime: MIME[kind] }, v1);
    assert.equal(a.begin.isError, false, JSON.stringify(a.begin.data));
    if (transport === "legacy") {
      assert.equal(a.begin.data.put_url, `/api/transfers/${a.begin.data.upload_id}`, "relative URL");
      assert.equal(a.begin.data.instructions, LEGACY_TEXT_INSTRUCTIONS);
    } else {
      assert.match(a.begin.data.put_url, new RegExp(`^${h.issuer}/files/u/ft_`), "absolute capability link");
      assert.equal(a.begin.data.instructions, OAUTH_BEGIN_INSTRUCTIONS);
    }
    assert.equal(a.put.status, 200);
    assert.equal(a.finish.isError, false, JSON.stringify(a.finish.data));
    assert.equal(a.finish.data.revision, 1); assert.equal(a.finish.data.size, MIB10);
    const id = a.finish.data.artifact_id;
    const b = await upload(c, transport, { artifact_id: id, expected_revision: 1, mime: MIME[kind] }, v2);
    assert.equal(b.finish.isError, false, JSON.stringify(b.finish.data ?? b.begin.data));
    assert.equal(b.finish.data.revision, 2);
    assert.equal(sha256(await content(id, 1)), sha256(v1));
    assert.equal(sha256(await content(id, 2)), sha256(v2));
    const row = sql(`SELECT a.kind, a.head_rev, r.body_key, r.blob_key, r.size, r.sha256 FROM artifacts a JOIN revisions r ON r.artifact_id = a.id AND r.rev_no = a.head_rev WHERE a.id = '${id}'`)[0];
    assert.deepEqual([row.kind, row.head_rev, row.blob_key, row.size, row.sha256], [kind, 2, null, MIB10, sha256(v2)]);
    assert.match(row.body_key, /^text\//);
    // Chunked read through the same transport: the first two chunks are exactly the stored prefix.
    const c1 = await c.call("read_artifact", { project_id: P, artifact_id: id, max_bytes: 65536 });
    assert.equal(c1.isError, false, JSON.stringify(c1.data));
    const c2 = await c.call("read_artifact", { project_id: P, artifact_id: id, cursor: c1.data.next_cursor });
    assert.equal(c2.isError, false, JSON.stringify(c2.data));
    const prefix = c1.data.text + c2.data.text;
    assert.equal(prefix, v2.subarray(0, Buffer.byteLength(prefix)).toString("utf8"));
    assert.equal(c1.data.revision, 2); assert.equal(c1.data.eof, false);
    const hist = await c.call("artifact_history", { project_id: P, artifact_id: id });
    assert.deepEqual(hist.data.revisions.map((r) => [r.rev, r.change_note]), [[2, "Synthetic upload"], [1, "Synthetic upload"]]);
    // Non-identical versions over 1 MiB: no hunks, null counts.
    const d = await c.call("diff_revisions", { project_id: P, artifact_id: id });
    assert.deepEqual([d.data.identical, d.data.added, d.data.removed, d.data.hunks, d.data.truncated], [false, null, null, [], true]);
    // A stale expected_revision is a revision_conflict (OAuth at begin, legacy at finish); nothing is published.
    const small = Buffer.from(kind === "html" ? "<p>stale</p>" : "# stale\n");
    const stale = await upload(c, transport, { artifact_id: id, expected_revision: 1, mime: MIME[kind] }, small);
    const err = stale.finish?.data?.error ?? stale.begin.data.error;
    assert.equal(err.code, "revision_conflict");
    assert.equal(sql(`SELECT head_rev FROM artifacts WHERE id = '${id}'`)[0].head_rev, 2);
  });
}

test("diff_revisions on uploaded text: identical versions report identical; small versions give hunks and counts", async () => {
  for (const [transport, c] of [["legacy", legacy], ["oauth", oauth]]) {
    const one = Buffer.from("# small\none\n"), two = Buffer.from("# small\ntwo\n");
    const a = await upload(c, transport, { title: "Small diff " + transport, mime: "text/markdown" }, one);
    const id = a.finish.data.artifact_id;
    assert.equal((await upload(c, transport, { artifact_id: id, expected_revision: 1, mime: "text/markdown" }, one)).finish.data.revision, 2);
    assert.equal((await upload(c, transport, { artifact_id: id, expected_revision: 2, mime: "text/markdown" }, two)).finish.data.revision, 3);
    const same = await c.call("diff_revisions", { project_id: P, artifact_id: id, from: 1, to: 2 });
    assert.deepEqual([same.data.identical, same.data.added, same.data.removed, same.data.hunks], [true, 0, 0, []]);
    const diff = await c.call("diff_revisions", { project_id: P, artifact_id: id, from: 2, to: 3 });
    assert.deepEqual([diff.data.identical, diff.data.added, diff.data.removed, diff.data.truncated], [false, 1, 1, false]);
    assert.ok(diff.data.hunks[0].lines.includes("-one") && diff.data.hunks[0].lines.includes("+two"));
  }
});

test("OAuth: measurements JSON by upload, then read_records", async () => {
  const records = Array.from({ length: 30 }, (_, i) => ({ id: "m" + i, recorded_at: `2000-01-${String(i + 1).padStart(2, "0")}T08:00:00Z`, date: `2000-01-${String(i + 1).padStart(2, "0")}`, metric: "steps", value: i, unit: "count", source_id: "" }));
  const bytes = Buffer.from(JSON.stringify({ schema: "agentlib.measurements/1", records }));
  const u = await upload(oauth, "oauth", { title: "Measurements", mime: "application/json", schema: "agentlib.measurements/1" }, bytes);
  assert.equal(u.finish.isError, false, JSON.stringify(u.finish.data ?? u.begin.data));
  const r = await oauth.call("read_records", { project_id: P, artifact_id: u.finish.data.artifact_id, from: "2000-01-10", to: "2000-01-12" });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  assert.deepEqual(r.data.records.map((x) => [x.id, x.recorded_at]), [["m9", "2000-01-10T08:00:00Z"], ["m10", "2000-01-11T08:00:00Z"], ["m11", "2000-01-12T08:00:00Z"]]);
  // CSV through legacy, too.
  const csv = Buffer.from("a,b\n1,2\n");
  const l = await upload(legacy, "legacy", { title: "Table", mime: "text/csv" }, csv);
  assert.equal(l.finish.isError, false, JSON.stringify(l.finish.data ?? l.begin.data));
  assert.equal(sql(`SELECT kind FROM artifacts WHERE id = '${l.finish.data.artifact_id}'`)[0].kind, "csv");
});

test("retries: begin replay returns the same upload and keeps metadata; double finish returns the same revision", async () => {
  for (const [transport, c] of [["legacy", legacy], ["oauth", oauth]]) {
    const bytes = Buffer.from("# retry " + transport + "\n");
    const args = { project_id: P, title: "Retry " + transport, folder: "Synthetic folder", mime: "text/markdown", size: bytes.length, sha256: sha256(bytes), change_note: "Retry note", idempotency_key: key("ub") };
    const b1 = await c.call("upload_begin", args), b2 = await c.call("upload_begin", args);
    assert.equal(b1.isError, false, JSON.stringify(b1.data));
    assert.equal(b2.data.upload_id, b1.data.upload_id);
    assert.equal(b2.data.artifact_id, b1.data.artifact_id);
    const row = sql(`SELECT u.change_note, a.title, a.folder FROM uploads u JOIN artifacts a ON a.id = u.artifact_id WHERE u.id = '${b1.data.upload_id}'`)[0];
    assert.deepEqual(row, { change_note: "Retry note", title: "Retry " + transport, folder: "Synthetic folder" });
    const put = transport === "legacy"
      ? await fetch(new URL(b2.data.put_url, h.appUi), { method: "PUT", body: bytes, headers: { authorization: `Bearer ${legacyToken}` } })
      : await fetch(b2.data.put_url, { method: "PUT", body: bytes });
    assert.equal(put.status, 200);
    const fk = key("uf");
    const f1 = await c.call("upload_finish", { project_id: P, upload_id: b1.data.upload_id, idempotency_key: fk });
    const f2 = await c.call("upload_finish", { project_id: P, upload_id: b1.data.upload_id, idempotency_key: fk });
    assert.equal(f1.isError, false, JSON.stringify(f1.data));
    assert.deepEqual([f2.data.revision, f2.data.revision_id], [f1.data.revision, f1.data.revision_id]);
    const hist = await c.call("artifact_history", { project_id: P, artifact_id: f1.data.artifact_id });
    assert.deepEqual(hist.data.revisions.map((r) => r.change_note), ["Retry note"]);
  }
});

test("refusals: read-only, revoked, expired link, another connection's upload, kind mismatches, upload_file with text", async () => {
  const bytes = Buffer.from("# refused\n");
  const decl = { project_id: P, title: "Refused", mime: "text/markdown", size: bytes.length, sha256: sha256(bytes), change_note: "x" };
  // Read-only: OAuth token without write scope is refused before the tool; a read-only legacy grant gets 403.
  const ro = await h.connectMcpAgent({ [P]: "read" }, { clientName: "Synthetic reader" });
  assert.ok(!(await ro.list()).some((t) => t.name === "upload_begin"));
  assert.equal((await ro.call("upload_begin", { ...decl, idempotency_key: key("ub") })).status, 403);
  const roLegacy = await sdkClient(h.appUi, roGrantToken, "synthetic-ro");
  try {
    const r = await roLegacy.call("upload_begin", { ...decl, idempotency_key: key("ub") });
    assert.equal(r.isError, true); assert.equal(r.data.error.status, 403);
  } finally { await roLegacy.client.close(); }
  // Expired link.
  const ex = await h.connectMcpAgent({ [P]: "write" }, { clientName: "Synthetic expiring" });
  const b = await ex.call("upload_begin", { ...decl, idempotency_key: key("ub") });
  assert.equal(b.isError, false, JSON.stringify(b.data));
  sql(`UPDATE transfer_links SET expires_at = 1 WHERE upload_id = '${b.data.upload_id}'`);
  const expired = await fetch(b.data.put_url, { method: "PUT", body: bytes });
  assert.equal(expired.status, 401); assert.equal((await expired.json()).error.code, "link_expired");
  // Another connection cannot finish it.
  const other = await oauth.call("upload_finish", { project_id: P, upload_id: b.data.upload_id, idempotency_key: key("uf") });
  assert.equal(other.data.error.code, "not_found");
  sql(`UPDATE uploads SET expires_at = 1 WHERE id = '${b.data.upload_id}'`);
  // Revoked: the link and finish stop working.
  const rv = await h.connectMcpAgent({ [P]: "write" }, { clientName: "Synthetic revoked" });
  const rb = await rv.call("upload_begin", { ...decl, idempotency_key: key("ub") });
  assert.equal(rb.isError, false, JSON.stringify(rb.data));
  const conn = (await owner.req("GET", "/api/access")).body.connections.find((x) => x.client_name === "Synthetic revoked" && x.status === "active");
  assert.equal((await owner.req("POST", `/api/connections/${conn.id}/revoke`, {})).status, 200);
  assert.equal((await fetch(rb.data.put_url, { method: "PUT", body: bytes })).status, 401);
  assert.equal((await rv.call("upload_finish", { project_id: P, upload_id: rb.data.upload_id, idempotency_key: key("uf") })).status, 401);
  // Kind mismatches: text onto a binary file, binary onto a document.
  const png = makePng(4, 4);
  const pic = await oauth.call("upload_file", { project_id: P, title: "pic.png", mime: "image/png", content_base64: png.toString("base64"), change_note: "x", idempotency_key: key("uf") });
  assert.equal(pic.isError, false, JSON.stringify(pic.data));
  const doc = (await owner.req("POST", `/api/projects/${P}/artifacts`, { title: "Doc", body: "# doc" })).body.artifact_id;
  for (const [transport, c] of [["legacy", legacy], ["oauth", oauth]]) {
    const t = await c.call("upload_begin", { project_id: P, artifact_id: pic.data.artifact_id, expected_revision: 1, mime: "text/markdown", size: bytes.length, sha256: sha256(bytes), change_note: "x", idempotency_key: key("ub") });
    assert.deepEqual([t.data.error.status, t.data.error.code, t.data.error.message], [400, "invalid_input", "mime must match the existing document kind"], transport);
    const r = await c.call("upload_begin", { project_id: P, artifact_id: doc, expected_revision: 1, mime: "image/png", size: png.length, sha256: sha256(png), change_note: "x", idempotency_key: key("ub") });
    assert.deepEqual([r.data.error.status, r.data.error.code], transport === "legacy" ? [400, "invalid_input"] : [415, "unsupported_kind"], transport);
  }
  // upload_file never accepts text.
  const inline = await oauth.call("upload_file", { project_id: P, title: "x", mime: "text/markdown", content_base64: bytes.toString("base64"), change_note: "x", idempotency_key: key("uf") });
  assert.deepEqual([inline.data.error.status, inline.data.error.code], [415, "unsupported_type"]);
});

test("over-cap MCP bodies: legacy, file-enabled OAuth and documents-only OAuth advice, with Content-Length and streamed", async () => {
  const docsOnly = await h.connectMcpAgent({ [P]: "write" }, { clientName: "Synthetic documents only" });
  sql("UPDATE oauth_connections SET file_access = 0 WHERE client_name = 'Synthetic documents only'");
  const names = (await docsOnly.list()).map((t) => t.name);
  assert.ok(!names.includes("upload_begin") && !names.includes("upload_finish") && !names.includes("upload_file"));
  const body = (n) => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "save_markdown", arguments: { body: "x".repeat(n) } } });
  const stream = (s) => new ReadableStream({ start(ctl) { const b = Buffer.from(s); for (let o = 0; o < b.length; o += 65536) ctl.enqueue(b.subarray(o, o + 65536)); ctl.close(); } });
  const cases = [
    ["legacy", h.appUi, legacyToken, 2 * 1024 * 1024, OVER_LEGACY],
    ["oauth files", h.issuer, oauthToken, 3 * 1024 * 1024, OVER_FILES],
    ["oauth documents only", h.issuer, docsOnly.access_token, 1024 * 1024, OVER_DOCS],
  ];
  for (const [what, base, token, cap, message] of cases) for (const streamed of [false, true]) {
    const s = body(cap);
    const r = await fetch(base + "/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: streamed ? stream(s) : s, ...streamed ? { duplex: "half" } : {} });
    assert.equal(r.status, 413, `${what} streamed=${streamed}`);
    const j = await r.json();
    assert.deepEqual([j.error.code, j.error.message], [-32600, message], `${what} streamed=${streamed}`);
  }
});
