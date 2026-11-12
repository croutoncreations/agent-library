// Baseline literals observed through the official SDK against c980189 (not inferred from the new guard).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startAppConnectServer } from "./fixtures/app-connect-harness.mjs";
import { SERVER_PORTS } from "./ports.mjs";
import { ROOT, LOCAL_CONFIG, key, mcpClient, grant, sha256, agentHttp } from "./helpers.mjs";
import { PNG } from "./upload-world.mjs";
let h, sdk, legacy, legacyToken, owner;
const P = "text-inline-guard";
const expected = { status: 415, code: "unsupported_type", message: "Allowed: image/png, image/jpeg, image/webp, image/gif, application/pdf, video/mp4, video/webm, application/octet-stream" };
before(async () => {
  h = await startAppConnectServer({ port: SERVER_PORTS["text-uploads-oauth"] });
  owner = await h.owner(); assert.equal((await owner.req("POST", "/api/projects", { id: P, title: "Synthetic inline guard" })).status, 201);
  const rw = await h.connectMcpAgent({ [P]: "write" }, { clientName: "Synthetic inline guard" });
  sdk = new Client({ name: "synthetic-text-inline-guard", version: "1" });
  await sdk.connect(new StreamableHTTPClientTransport(new URL(h.issuer + "/mcp"), { requestInit: { headers: { authorization: `Bearer ${rw.access_token}` } } }));
  legacyToken = (await grant(owner, P, "Synthetic legacy guard")).token;
  legacy = await mcpClient(h.appUi, legacyToken);
});
after(async () => { await legacy?.close(); await sdk?.close(); await h?.stop(); });
const call = more => sdk.callTool({ name: "upload_file", arguments: { title: "Synthetic", mime: "text/markdown", content_base64: "eA==", change_note: "Synthetic guard regression", idempotency_key: key(), ...more } });
const counts = () => {
  const result = JSON.parse(execFileSync("wrangler", ["d1", "--config", LOCAL_CONFIG, "execute", "DB", "--local", "--persist-to", h.dir, "--json", "--command", "SELECT (SELECT COUNT(*) FROM artifacts) AS artifacts, (SELECT COUNT(*) FROM uploads) AS uploads"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }))[0].results[0];
  const dir = join(h.dir, "v3/r2/miniflare-R2BucketObject");
  let objects = 0;
  for (const f of readdirSync(dir).filter(f => f.endsWith(".sqlite") && f !== "metadata.sqlite")) {
    const db = new DatabaseSync(join(dir, f), { readOnly: true });
    try { objects += db.prepare("SELECT COUNT(*) AS n FROM _mf_objects").get().n; } finally { db.close(); }
  }
  return { ...result, objects };
};
test("upload_file retains literal baseline 415 tool error for all text MIME types, without any publication or reservation", async () => {
  const before = counts();
  for (const mime of ["text/markdown", "text/html", "application/json", "text/csv"]) {
    const r = await call({ mime }); assert.equal(r.isError, true); assert.deepEqual(r.structuredContent.error, expected);
    assert.deepEqual(counts(), before);
  }
});
test("upload_file preserves baseline validation error precedence for doubly invalid input", async () => {
  for (const [args, error] of [
    [{ content_base64: "!" }, { status: 400, code: "invalid_input", message: "content_base64 must be non-empty standard base64" }],
    [{ content_base64: "eA==".repeat(700000) }, { status: 413, code: "too_large", message: "upload_file takes up to 2097152 bytes; use upload_begin + HTTP PUT for larger files (up to this plan's file size limit)" }],
    [{ change_note: "" }, { status: 400, code: "change_note_required", message: "change_note is required: one line on why you are adding or changing this file" }],
    [{ title: undefined }, { status: 400, code: "invalid_input", message: "Pass title for a new file, or artifact_id and expected_revision for a new version" }]
  ]) { const r = await call(args); assert.equal(r.isError, true); assert.deepEqual(r.structuredContent.error, error); }
});
test("binary upload_file continues to publish normally", async () => {
  const r = await call({ mime: "image/png", content_base64: PNG.toString("base64") });
  assert.equal(r.isError, false, JSON.stringify(r.structuredContent)); assert.equal(r.structuredContent.revision, 1);
});
test("OAuth and legacy upload_begin refuse an unsupported type without writing anything (text types are accepted: test/text-uploads-mcp.test.mjs)", async () => {
  const before = counts();
  const all = { status: 415, code: "unsupported_type", message: expected.message + ", text/markdown, text/html, application/json, text/csv" };
  const args = { project_id: P, title: "Synthetic refused type", mime: "text/plain", size: 1, sha256: sha256("x"), idempotency_key: key() };
  const oauth = await sdk.callTool({ name: "upload_begin", arguments: { ...args, change_note: "Synthetic refused begin" } });
  assert.equal(oauth.isError, true); assert.deepEqual(oauth.structuredContent.error, all);
  const old = await legacy.call("upload_begin", args); assert.equal(old.isError, true); assert.deepEqual(old.data.error, all);
  assert.deepEqual(counts(), before);
});
test("MCP principals cannot PUT or finish an app-owner text upload", async () => {
  const b = await owner.req("POST", `/api/projects/${P}/uploads`, { title: "Synthetic owner-only input", mime: "text/markdown", size: 1, sha256: sha256("x") });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  const put = await agentHttp(h.appUi, legacyToken)("PUT", b.body.put_url, undefined, { raw: "x" });
  assert.equal(put.status, 404); assert.equal(put.body.error.code, "not_found");
  const finish = await sdk.callTool({ name: "upload_finish", arguments: { project_id: P, upload_id: b.body.upload_id, idempotency_key: key() } });
  assert.equal(finish.isError, true); assert.equal(finish.structuredContent.error.status, 404); assert.equal(finish.structuredContent.error.code, "not_found");
});
