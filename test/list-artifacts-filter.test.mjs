// Catalog wording and title-only list queries travel together through the real runtime and official MCP SDK.
// App Connect off/on and pre-files/current OAuth consent cover all list_artifacts description variants.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { LOCAL_CONFIG, ROOT, mcpClient } from "./helpers.mjs";
import { startAppConnectServer } from "./fixtures/app-connect-harness.mjs";
import { SERVER_PORTS } from "./ports.mjs";

const SEARCH_NOTE = "To search document text, use search_artifacts if it is listed.";
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };

for (const appConnect of [false, true]) test(`list_artifacts: title-only description and query (App Connect ${appConnect ? "on" : "off"})`, async () => {
  const h = await startAppConnectServer({ port: SERVER_PORTS["list-artifacts-filter"], vars: { APP_CONNECT_ENABLED: appConnect ? "1" : "0" } });
  const clients = [];
  const sql = async (query) => promisify(execFile)("wrangler", ["d1", "--config", LOCAL_CONFIG, "execute", "DB", "--local", "--persist-to", h.dir, "--json", "--command", query], { cwd: ROOT });
  try {
    const owner = await h.owner();
    const project = ok(await owner.req("POST", "/api/projects", { title: "Synthetic filter catalog" }), 201).id;
    const doc = ok(await owner.req("POST", `/api/projects/${project}/artifacts`, { title: "Titleword guide", body: "A bodyword appears only here." }), 201).artifact_id;
    const grant = ok(await owner.req("POST", `/api/projects/${project}/grants`, { label: "Synthetic title filter reader", can_write: false }), 201);
    const legacy = await mcpClient(h.appUi, grant.token, "title-filter-legacy"); clients.push(legacy);
    const agent = await h.connectMcpAgent({ [project]: "read" });
    const oauth = await mcpClient(h.issuer, agent.access_token, "title-filter-oauth"); clients.push(oauth);

    const check = async (client, catalog, expectedDetails) => {
      // The conditional search pointer stays accurate both before and after the search index is ready.
      for (const ready of [1, 0]) {
        await sql(`UPDATE artifact_search_state SET ready = ${ready} WHERE id = 1`);
        const tools = (await client.client.listTools()).tools;
        const description = tools.find((t) => t.name === "list_artifacts")?.description;
        assert.ok(description, catalog);
        assert.match(description, /optional query filters by title\./, catalog);
        assert.ok(description.includes(SEARCH_NOTE), catalog);
        assert.doesNotMatch(description.replace(SEARCH_NOTE, ""), /\b(body|bodies|text|contents?)\b/i, catalog);
        for (const detail of expectedDetails) assert.ok(description.includes(detail), `${catalog}: ${detail}`);
        assert.equal(tools.some((t) => t.name === "search_artifacts"), !!ready, catalog);
      }
      const body = await client.call("list_artifacts", { project_id: project, query: "bodyword" });
      assert.equal(body.isError, false, catalog);
      assert.deepEqual(body.data.artifacts, [], `${catalog}: no body-only matches`);
      const title = await client.call("list_artifacts", { project_id: project, query: "Titleword" });
      assert.equal(title.isError, false, catalog);
      assert.deepEqual(title.data.artifacts.map((a) => a.id), [doc], `${catalog}: title match`);
    };

    await check(legacy, "legacy", ["List artifacts", "Paginated (50)."]);
    await check(oauth, "OAuth files", ["Markdown, HTML, JSON, CSV", 'kind "binary"', "kind, mime, size and revision", "50 per page; pass next_cursor"]);
    // Simulate a still-valid connection consented before files were offered (same path as oauth-files tests).
    await sql("UPDATE oauth_connections SET file_access = 0");
    await check(oauth, appConnect ? "OAuth documents and data" : "OAuth documents", [appConnect ? "documents and data files (Markdown, JSON, CSV)" : "documents (Markdown and HTML)", "Paginated."]);
  } finally {
    for (const client of clients) await client.close();
    await h.stop();
  }
});
