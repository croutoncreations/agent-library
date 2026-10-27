// web_url links in MCP results: canonical owner-browser deep links for projects and documents.
// Uses the real MCP SDK client (existing grant-based /mcp) and real Chrome for the browser checks.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { startServer, setupProject, grant, mcpClient, key } from "./helpers.mjs";
import { SERVER_PORTS } from "./ports.mjs";

const require = createRequire(import.meta.url);
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PUPPETEER = `${process.env.HOME}/.npm-packages/lib/node_modules/puppeteer`;
const haveChrome = existsSync(CHROME) && existsSync(PUPPETEER);
const PORT = SERVER_PORTS.weblinks, ORIGIN = `http://127.0.0.1:${PORT}`;
// Project IDs allow [a-z0-9-]; prj_ IDs allow _ and -. Use one with characters that matter for paths.
const PID = "web-links-proj", OTHER = "web-links-other";
let s, h, m, ro, browser, docId, otherDoc, rwToken;

before(async () => {
  s = await startServer("weblinks", PORT, { vars: { RATE_READS_PER_MIN: "100000", RATE_WRITES_PER_MIN: "100000", RATE_AUTHFAIL_PER_MIN: "100000", APP_HOST: `127.0.0.1:${PORT}` } });
  h = await s.login();
  await setupProject(h, PID, "Links <project>");
  await setupProject(h, OTHER, "Other");
  otherDoc = (await h.req("POST", `/api/projects/${OTHER}/artifacts`, { title: "Other doc", body: "secret other" })).body.artifact_id;
  rwToken = (await grant(h, PID, "links-rw", true)).token;
  m = await mcpClient(ORIGIN, rwToken, "links-rw");
  ro = await mcpClient(ORIGIN, (await grant(h, PID, "links-ro", false)).token, "links-ro");
  if (haveChrome) browser = await require(PUPPETEER).launch({ executablePath: CHROME, headless: true, args: ["--no-first-run"] });
});
after(async () => { await browser?.close(); await m?.close(); await ro?.close(); await s?.stop(); });

const expectDocUrl = (u, pid, aid) => assert.equal(u, `${ORIGIN}/p/${encodeURIComponent(pid)}/a/${encodeURIComponent(aid)}`);

test("create, list, read, history and save the same document: every web_url identifies it", async () => {
  const lp = await m.call("list_projects", {});
  assert.equal(lp.data.projects[0].web_url, `${ORIGIN}/p/${PID}`);
  const c = await m.call("create_markdown", { project_id: PID, title: "Linked doc", body: "# v1", idempotency_key: key("c") });
  assert.equal(c.isError, false);
  docId = c.data.artifact_id;
  expectDocUrl(c.data.web_url, PID, docId);
  const l = await m.call("list_artifacts", { project_id: PID });
  const row = l.data.artifacts.find((a) => a.id === docId);
  expectDocUrl(row.web_url, PID, docId);
  const r = await m.call("read_artifact", { project_id: PID, artifact_id: docId });
  expectDocUrl(r.data.artifact.web_url, PID, docId);
  assert.equal(r.data.web_url_opens, "current_document");
  const sv = await m.call("save_markdown", { project_id: PID, artifact_id: docId, expected_revision: 1, body: "# v2", idempotency_key: key("s") });
  assert.equal(sv.data.revision, 2);
  expectDocUrl(sv.data.web_url, PID, docId);
  const old = await m.call("read_artifact", { project_id: PID, artifact_id: docId, revision: 1 });
  assert.equal(old.data.body, "# v1");
  expectDocUrl(old.data.artifact.web_url, PID, docId); // no per-revision browser route: current document, labelled
  assert.equal(old.data.web_url_opens, "current_document");
  const hi = await m.call("artifact_history", { project_id: PID, artifact_id: docId });
  expectDocUrl(hi.data.web_url, PID, docId);
  assert.equal(hi.data.web_url_opens, "current_document");
  // Idempotent replay of the create returns the same link
  // (and existing fields are unchanged: additive only)
  assert.deepEqual(Object.keys(c.data).filter((k) => k !== "web_url" && k !== "preview_url").sort(), ["artifact_id", "revision", "revision_id", "sha256"]);
  // preview_url: rendered read-only view, Markdown only, on every result that returns a document link
  const prev = `${ORIGIN}/p/${PID}/a/${docId}/preview`;
  for (const u of [c.data.preview_url, row.preview_url, r.data.artifact.preview_url, sv.data.preview_url, old.data.artifact.preview_url]) assert.equal(u, prev);
});

test("preview_url is only for Markdown; binaries keep web_url only", async () => {
  const { makePng } = await import("./make-fixtures.mjs");
  const { createHash } = await import("node:crypto");
  const png = makePng(8, 8);
  const b = await m.call("upload_begin", { project_id: PID, title: "pixel", mime: "image/png", size: png.length, sha256: createHash("sha256").update(png).digest("hex"), idempotency_key: key("u") });
  assert.equal(b.isError, false, JSON.stringify(b.data));
  const put = await fetch(ORIGIN + b.data.put_url, { method: "PUT", headers: { authorization: `Bearer ${rwToken}`, "content-type": "application/octet-stream" }, body: png });
  assert.equal(put.status, 200);
  const f = await m.call("upload_finish", { project_id: PID, upload_id: b.data.upload_id, idempotency_key: key("f") });
  assert.equal(f.isError, false, JSON.stringify(f.data));
  const bin = (await m.call("list_artifacts", { project_id: PID })).data.artifacts.find((a) => a.id === f.data.artifact_id);
  assert.ok(bin.web_url); assert.equal(bin.preview_url, undefined);
  const rd = await m.call("read_artifact", { project_id: PID, artifact_id: f.data.artifact_id });
  assert.ok(rd.data.artifact.web_url); assert.equal(rd.data.artifact.preview_url, undefined);
});

test("tools/list documents web_url (descriptions + permissive outputSchema); existing fields unchanged", async () => {
  const tools = (await m.client.listTools()).tools;
  for (const n of ["list_projects", "list_artifacts", "read_artifact", "artifact_history", "create_markdown", "save_markdown"]) {
    const t = tools.find((x) => x.name === n);
    assert.match(t.description, /web_url/, n);
    assert.match(t.description, /preview_url/, n);
    assert.match(JSON.stringify(t.outputSchema), /may require the user to sign in/, n);
  }
  assert.equal(tools.find((x) => x.name === "upload_begin").outputSchema, undefined);
});

test("no secrets or signed params in URLs; errors carry no web_url; inaccessible docs give no link", async () => {
  const all = JSON.stringify([(await m.call("list_projects", {})).data, (await m.call("list_artifacts", { project_id: PID })).data]);
  for (const u of all.match(/"web_url":"[^"]+"/g)) {
    assert.doesNotMatch(u, /alt_|token|grant|sig=|signature|exp=|\?/i, u);
  }
  const miss = await m.call("read_artifact", { project_id: PID, artifact_id: "art_doesnotexist" });
  assert.equal(miss.isError, true);
  assert.equal(JSON.stringify(miss.data).includes("web_url"), false);
  const cross = await m.call("read_artifact", { project_id: OTHER, artifact_id: otherDoc });
  assert.equal(cross.isError, true);
  assert.equal(JSON.stringify(cross.data).includes("web_url"), false);
  const roWrite = await ro.call("save_markdown", { project_id: PID, artifact_id: docId, expected_revision: 2, body: "x", idempotency_key: key("x") });
  assert.equal(roWrite.isError, true);
  assert.equal(JSON.stringify(roWrite.data).includes("web_url"), false);
});

test("deep-link routes serve only the data-free app shell; data still requires auth; unknown paths 404", async () => {
  for (const p of [`/p/${PID}`, `/p/${PID}/a/${docId}`, `/p/${PID}/a/${docId}/preview`, `/p/${PID}/`, `/p/x%2Fy/a/z`]) {
    const r = await fetch(ORIGIN + p);
    assert.equal(r.status, 200, p);
    const t = await r.text();
    assert.match(t, /<script src="\/app.js"/);
    assert.doesNotMatch(t, /Linked doc|# v2|Links &lt;project|secret other/, "shell has no data");
  }
  for (const p of [`/p`, `/p/${PID}/a`, `/p/${PID}/a/${docId}/extra`, `/p/${PID}/a/${docId}/preview/x`, `/p/${PID}/grants`, `/x/${PID}`]) assert.equal((await fetch(ORIGIN + p)).status, 404, p);
  assert.equal((await fetch(`${ORIGIN}/api/projects/${PID}/artifacts/${docId}`)).status, 401, "API still requires auth");
});

test("URL encoding: path-significant characters are percent-encoded; host validation", async () => {
  const { projectWebUrl, artifactWebUrl, appOrigin } = await import("../src/links.ts"); // Node strips TS types
  assert.equal(projectWebUrl("https://x", "a/b?c#d"), "https://x/p/a%2Fb%3Fc%23d");
  assert.equal(artifactWebUrl("https://x", "p", "a b"), "https://x/p/p/a/a%20b");
  assert.equal(appOrigin("evil.com/path"), null);
  assert.equal(appOrigin("library.example.com"), "https://library.example.com");
});

test("browser: signed-out user keeps the destination through sign-in; authenticated open shows the document", { skip: !haveChrome && "Chrome not installed" }, async () => {
  const url = (await m.call("read_artifact", { project_id: PID, artifact_id: docId })).data.artifact.web_url;
  const page = await browser.newPage();
  await page.goto(url);
  await page.waitForSelector('input[name="passphrase"]', { timeout: 10000 });
  assert.match(page.url(), new RegExp(`#/p/${PID}/a/${docId}$`), "destination preserved while signed out");
  // Sign in through the real login form (passphrase from the test server)
  const pass = s.passphrase();
  await page.type('input[name="passphrase"]', pass);
  await Promise.all([page.waitForFunction(() => document.body.innerText.includes("Linked doc"), { timeout: 10000 }), page.click('button[type="submit"]')]);
  assert.match(page.url(), new RegExp(`#/p/${PID}/a/${docId}$`));
  await page.waitForFunction(() => /\bv2\b/.test(document.body.innerText) || [...document.querySelectorAll("textarea")].some((t) => t.value.includes("v2")), { timeout: 10000 })
    .catch(async (e) => { await page.screenshot({ path: "tmp/test-evidence/web-link-document-fail.png" }); throw e; });
  await page.screenshot({ path: "tmp/test-evidence/web-link-document.png" });
  // Project link opens the project list view
  await page.goto(`${ORIGIN}/p/${PID}`);
  await page.waitForFunction(() => document.body.innerText.includes("Linked doc"), { timeout: 10000 });
  assert.match(page.url(), new RegExp(`#/p/${PID}$`));
  // A link to a document the user cannot see shows an error, not data (here: a doc from another project under this project)
  await page.goto(`${ORIGIN}/p/${PID}/a/${otherDoc}`);
  await page.waitForFunction(() => /not found/i.test(document.body.innerText), { timeout: 10000 });
  assert.equal((await page.content()).includes("secret other"), false);
  await page.close();
});

test("browser: preview_url opens the rendered Preview tab directly (also through sign-in); tab switches keep the link in sync", { skip: !haveChrome && "Chrome not installed" }, async () => {
  const url = (await m.call("read_artifact", { project_id: PID, artifact_id: docId })).data.artifact.preview_url;
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.goto(url);
  await page.waitForSelector('input[name="passphrase"]', { timeout: 10000 });
  assert.match(page.url(), new RegExp(`#/p/${PID}/a/${docId}/preview$`), "preview destination preserved while signed out");
  await page.type('input[name="passphrase"]', s.passphrase());
  await page.click('button[type="submit"]');
  await page.waitForSelector(".preview h1", { timeout: 10000 });
  assert.equal(await page.evaluate(() => document.querySelector(".preview h1").textContent), "v2");
  assert.equal(await page.evaluate(() => document.querySelector(".tabs button[aria-selected=true]").textContent), "Preview");
  assert.equal(await page.evaluate(() => { const e = document.querySelector(".ed-host"); return !!e && e.closest("section").hidden; }), true, "editor hidden");
  await page.evaluate(() => [...document.querySelectorAll(".tabs button")].find((b) => b.textContent === "Edit").click());
  // Since upstream cf8af9e (rendered-first documents) the Edit tab is its own deep link (/edit), not the bare doc URL.
  assert.match(page.url(), new RegExp(`#/p/${PID}/a/${docId}/edit$`));
  await page.evaluate(() => [...document.querySelectorAll(".tabs button")].find((b) => b.textContent === "Preview").click());
  // Rendered view is the default document URL since cf8af9e; /preview links still open it (asserted above).
  assert.match(page.url(), new RegExp(`#/p/${PID}/a/${docId}$`));
  await ctx.close();
});
