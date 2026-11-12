// OAuth MCP upload_begin with App Connect off (APP_CONNECT_ENABLED unset in production): the tool offers Markdown,
// HTML and binaries only, refuses App Connect fields and JSON/CSV without writing anything, and Markdown still uploads
// end to end. Real local Worker (wrangler dev), real OAuth consent (DCR + owner consent), the official MCP SDK client
// and a real HTTP PUT. The legacy server with the flag off: test/app-connect-flag-off.test.mjs. Synthetic data only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startAppConnectServer } from "./fixtures/app-connect-harness.mjs";
import { SERVER_PORTS } from "./ports.mjs";
import { ROOT, LOCAL_CONFIG, key, sha256 } from "./helpers.mjs";

const P = "text-mcp-off";
const BINARIES = ["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf", "video/mp4", "video/webm", "application/octet-stream"];
const MIME_OFF = "Exact MIME type: text/markdown, text/html, or a supported binary type.";
const ALLOWED_OFF = `Allowed: ${BINARIES.join(", ")}, text/markdown, text/html`;
const NOT_FOUND = { status: 404, code: "not_found", message: "Not found" };
let h, owner, sdk, raw;

const sql = (q) => JSON.parse(execFileSync("wrangler", ["d1", "--config", LOCAL_CONFIG, "execute", "DB", "--local", "--persist-to", h.dir, "--json", "--command", q], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1", NO_COLOR: "1" } }))[0].results;
// Rows written, including unpublished placeholders (head_rev = 0).
const rowCounts = () => sql("SELECT (SELECT COUNT(*) FROM uploads) AS uploads, (SELECT COUNT(*) FROM artifacts) AS artifacts")[0];
const call = async (args) => { const r = await sdk.callTool({ name: "upload_begin", arguments: { project_id: P, change_note: "Synthetic", idempotency_key: key("ub"), ...args } }); return { isError: !!r.isError, data: r.structuredContent }; };

before(async () => {
  // The App Connect harness (stand-in IdP for the owner's sign-in) with the flag explicitly off.
  h = await startAppConnectServer({ port: SERVER_PORTS["text-uploads-mcp-off"], vars: { APP_CONNECT_ENABLED: "0" } });
  owner = await h.owner();
  assert.equal((await owner.req("POST", "/api/projects", { id: P, title: "Synthetic flag off" })).status, 201);
  raw = await h.connectMcpAgent({ [P]: "write" }, { clientName: "Synthetic flag-off uploader" });
  sdk = new Client({ name: "synthetic-flag-off", version: "1" });
  await sdk.connect(new StreamableHTTPClientTransport(new URL(h.issuer + "/mcp"), { requestInit: { headers: { authorization: `Bearer ${raw.access_token}` } } }));
});
after(async () => { await sdk?.close(); await h?.stop(); });

test("OAuth upload_begin with the flag off: no schema or folder_id, binaries plus Markdown and HTML, flag-off mime wording", async () => {
  const b = (await sdk.listTools()).tools.find((t) => t.name === "upload_begin");
  assert.ok(!("schema" in b.inputSchema.properties) && !("folder_id" in b.inputSchema.properties));
  assert.deepEqual(b.inputSchema.properties.mime.enum, [...BINARIES, "text/markdown", "text/html"]);
  assert.equal(b.inputSchema.properties.mime.description, MIME_OFF);
});

test("OAuth with the flag off: schema/folder_id are unknown arguments, JSON/CSV and unknown types are refused, nothing written", async () => {
  const before = rowCounts();
  const md = Buffer.from("# x\n");
  const decl = { title: "Refused", mime: "text/markdown", size: md.length, sha256: sha256(md) };
  for (const extra of [{ schema: "agentlib.measurements/1" }, { folder_id: "fld_synthetic" }]) {
    const r = await raw.call("upload_begin", { project_id: P, change_note: "x", idempotency_key: key("ub"), ...decl, ...extra });
    assert.deepEqual([r.isError, r.data], [true, { code: -32602, message: `Unknown argument ${Object.keys(extra)[0]}` }]);
  }
  for (const mime of ["application/json", "text/csv"]) for (const size of [2, 10 * 1024 * 1024 + 1]) {
    const r = await call({ title: "Data", mime, size, sha256: sha256("{}") });
    assert.deepEqual(r.data.error, NOT_FOUND, `${mime} ${size}`);
  }
  assert.deepEqual((await call({ title: "Plain", mime: "text/plain", size: 1, sha256: sha256("x") })).data.error, { status: 415, code: "unsupported_type", message: ALLOWED_OFF });
  assert.deepEqual(rowCounts(), before);
});

test("OAuth with the flag off: a Markdown upload works end to end", async () => {
  const md = Buffer.from("# Synthetic flag-off upload\n\nBody.\n");
  const b = await call({ title: "Flag-off Markdown", mime: "text/markdown", size: md.length, sha256: sha256(md) });
  assert.equal(b.isError, false, JSON.stringify(b.data));
  assert.equal((await fetch(b.data.put_url, { method: "PUT", body: md })).status, 200);
  const f = await sdk.callTool({ name: "upload_finish", arguments: { project_id: P, upload_id: b.data.upload_id, idempotency_key: key("uf") } });
  assert.equal(!!f.isError, false, JSON.stringify(f.structuredContent));
  assert.equal(f.structuredContent.revision, 1);
  const read = await fetch(`${h.appUi}/api/projects/${P}/artifacts/${f.structuredContent.artifact_id}/content`, { headers: { cookie: owner.cookie } });
  assert.equal(Buffer.from(await read.arrayBuffer()).toString("utf8"), md.toString("utf8"));
  assert.equal(sql(`SELECT kind FROM artifacts WHERE id = '${f.structuredContent.artifact_id}'`)[0].kind, "markdown");
});
