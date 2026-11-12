// Blind-index search tokens (slice 4a, Part 2): a create through the OAuth host's MCP endpoint (workers-oauth-provider
// → handleOAuthMcp, the official SDK client) reaches the request's deferred work, so the new document gets its tokens.
// Local `wrangler dev` with the App Connect harness (port SERVER_PORTS["blind-tokens-oauth"]); rows are polled with a
// deadline, never a fixed sleep. Synthetic data only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startAppConnectServer } from "./fixtures/app-connect-harness.mjs";
import { SERVER_PORTS } from "./ports.mjs";
import { LOCAL_CONFIG, ROOT } from "./helpers.mjs";

let h, sdk;
const P = "blind-tokens-oauth";
const d1 = async (q) => JSON.parse((await promisify(execFile)("wrangler", ["d1", "--config", LOCAL_CONFIG, "execute", "DB", "--local", "--persist-to", h.dir, "--json", "--command", q],
  { cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })).stdout)[0].results;
before(async () => {
  h = await startAppConnectServer({ port: SERVER_PORTS["blind-tokens-oauth"] });
  const owner = await h.owner();
  assert.equal((await owner.req("POST", "/api/projects", { id: P, title: "Synthetic" })).status, 201);
  const agent = await h.connectMcpAgent({ [P]: "write" }, { clientName: "Synthetic blind tokens" });
  sdk = new Client({ name: "synthetic-blind-tokens", version: "1" });
  await sdk.connect(new StreamableHTTPClientTransport(new URL(h.issuer + "/mcp"), { requestInit: { headers: { authorization: `Bearer ${agent.access_token}` } } }));
});
after(async () => { await sdk?.close(); await h?.stop(); });

test("OAuth-host MCP create (provider path, official SDK client): the new document ends with its expected tokens", async () => {
  const body = "oauth provider alpha beta";
  const r = await sdk.callTool({ name: "create_markdown", arguments: { project_id: P, title: "Synthetic", body, idempotency_key: "oauth-create-0001" } });
  assert.ok(!r.isError, JSON.stringify(r));
  const id = r.structuredContent.artifact_id;
  const end = Date.now() + 20000;
  let row;
  for (;;) {
    row = (await d1(`SELECT d.revision_id, a.head_revision_id AS head FROM search_token_docs d JOIN artifacts a ON a.id = d.artifact_id WHERE d.artifact_id = '${id}'`))[0];
    if (row && row.revision_id === row.head) break;
    if (Date.now() > end) throw new Error("not indexed: " + JSON.stringify(row));
    await new Promise((x) => setTimeout(x, 100));
  }
  const ws = (await d1(`SELECT workspace_id FROM projects WHERE id = '${P}'`))[0].workspace_id;
  const secret = Buffer.from((await d1(`SELECT secret FROM workspace_search_keys WHERE workspace_id = '${ws}'`))[0].secret, "base64url");
  const want = [...new Set(body.split(" "))].map((t) => createHmac("sha256", secret).update(t).digest().subarray(0, 16).toString("hex")).sort();
  const got = (await d1(`SELECT lower(hex(s.token)) AS t FROM search_tokens s JOIN search_token_docs d ON d.doc_id = s.doc_id WHERE d.artifact_id = '${id}' ORDER BY s.token`)).map((x) => x.t);
  assert.deepEqual(got, want);
});
