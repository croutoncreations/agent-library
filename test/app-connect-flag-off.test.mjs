// Contract §0: with APP_CONNECT_ENABLED unset (production), every App Connect surface is unreachable and the
// shared responses keep their exact Phase 1 shapes (security review F3). Migration 0008 is applied locally.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { startServer, key, ROOT, LOCAL_CONFIG, mcpClient, grant, sha256 } from "./helpers.mjs";
import { SERVER_PORTS } from "./ports.mjs";

const PORT = SERVER_PORTS.acoff;
const API = `http://127.0.0.1:${PORT}`, APP = `http://localhost:${PORT}`;
const P1_ARTIFACT_KEYS = ["folder", "id", "kind", "meta_version", "project_id", "revision", "tags", "title", "trashed", "updated_at"];
let s, owner, rw, aid;

before(async () => {
  s = await startServer("acoff", PORT, {
    vars: { MCP_HOST: `127.0.0.1:${PORT}`, APP_HOST: `localhost:${PORT}`, RATE_READS_PER_MIN: "100000", RATE_WRITES_PER_MIN: "100000", RATE_AUTHFAIL_PER_MIN: "100000" },
    readyBase: APP,
  });
  owner = await s.loginAt(APP);
  assert.equal((await owner.req("POST", "/api/projects", { id: "off-test", title: "Off" })).status, 201);
  rw = (await owner.req("POST", "/api/api-keys", { label: "off rw", lifetime_days: 1, projects: [{ project_id: "off-test", access: "read_write" }] })).body.secret;
  aid = (await owner.req("POST", "/api/projects/off-test/artifacts", { title: "doc", body: "# one" })).body.artifact_id;
});
after(async () => { await s?.stop(); });

const v1 = (method, path, { token = rw, body } = {}) => fetch(`${API}/v1${path}`, { method, headers: { "user-agent": "t", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json", "idempotency-key": key("o") } : {}) }, body: body && JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

test("owner /api artifact shapes are exactly Phase 1", async () => {
  const g = await owner.req("GET", `/api/projects/off-test/artifacts/${aid}`);
  assert.deepEqual(Object.keys(g.body.artifact).sort(), P1_ARTIFACT_KEYS);
  const l = await owner.req("GET", "/api/projects/off-test/artifacts");
  assert.deepEqual(Object.keys(l.body.artifacts[0]).sort(), P1_ARTIFACT_KEYS);
});

test("owner /api: no json/csv create, no folders/records/app-clients, spreadsheet param ignored, PUT is Markdown-only", async () => {
  // Phase 1 behaviour: unknown fields (kind/content) are ignored and a Markdown file is created; never a JSON file.
  const j = await owner.req("POST", "/api/projects/off-test/artifacts", { kind: "json", title: "j", content: "{}" });
  if (j.status === 201) assert.equal((await owner.req("GET", `/api/projects/off-test/artifacts/${j.body.artifact_id}`)).body.artifact.kind, "markdown");
  for (const p of ["/api/projects/off-test/folders", `/api/projects/off-test/artifacts/${aid}/records`, "/api/app-clients"])
    assert.ok([400, 404].includes((await owner.req("GET", p)).status), p);
  const c = await fetch(`${APP}/api/projects/off-test/artifacts/${aid}/content?format=spreadsheet`, { headers: { cookie: owner.cookie } });
  assert.equal(c.status, 200, "format=spreadsheet is ignored with the flag off");
  // Same-key retry after trash still replays (Phase 1 idempotency-before-load semantics).
  const k = key("put");
  const save = await owner.req("PUT", `/api/projects/off-test/artifacts/${aid}`, { expected_revision: 1, body: "# two" }, { idem: k });
  assert.equal(save.status, 200);
  const meta = (await owner.req("GET", `/api/projects/off-test/artifacts/${aid}`)).body.artifact.meta_version;
  assert.equal((await owner.req("PATCH", `/api/projects/off-test/artifacts/${aid}`, { expected_meta_version: meta, trashed: true })).status, 200);
  const replay = await owner.req("PUT", `/api/projects/off-test/artifacts/${aid}`, { expected_revision: 1, body: "# two" }, { idem: k });
  assert.equal(replay.status, 200); assert.equal(replay.body.idempotent_replay, true);
});

test("/v1: records/folders/publisher are 404 before auth; Phase 1 file shape", async () => {
  for (const p of [`/projects/off-test/files/${aid}/records`, "/projects/off-test/folders", "/app", "/app/files"]) {
    const r = await v1("GET", p, { token: null });
    assert.equal(r.status, 404, p);
  }
  const f = await v1("GET", "/projects/off-test/files?trashed=0");
  assert.equal(f.status, 200);
  for (const x of f.json.files) for (const k of ["folder_id", "schema", "publisher"]) assert.ok(!(k in x), k);
});

test("OAuth metadata has no /v1 resource and no publish scope", async () => {
  const asm = await (await fetch(`${API}/.well-known/oauth-authorization-server`)).json();
  assert.ok(!JSON.stringify(asm).includes("agentlib:publish"));
  assert.equal((await fetch(`${API}/.well-known/oauth-protected-resource/v1`)).status, 404);
});

// Browser (CSV/JSON previews): with App Connect off the app must not offer what the server refuses. The browser
// detects the feature with GET .../artifacts?kind=csv, which is an App Connect query (404 here).
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PUPPETEER = `${process.env.HOME}/.npm-packages/lib/node_modules/puppeteer`;
const haveChrome = existsSync(CHROME) && existsSync(PUPPETEER);

test("browser: the feature probe is 404 with the flag off, and Upload file offers only media and PDF", { skip: !haveChrome && "Chrome not installed" }, async () => {
  assert.equal((await owner.req("GET", "/api/projects/off-test/artifacts?kind=csv")).status, 404, "kind filter is App Connect only");
  const browser = await createRequire(import.meta.url)(PUPPETEER).launch({ executablePath: CHROME, headless: true, args: ["--no-first-run"] });
  try {
    const page = await browser.newPage();
    const [cn, cv] = owner.cookie.split("="); await page.setCookie({ name: cn, value: cv, url: APP });
    await page.goto(`${APP}/#/p/off-test`); await page.waitForSelector(".list li");
    await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Upload file").click());
    await page.waitForFunction(() => { const i = document.querySelector('input[type=file][aria-label="File to upload"]'); return i && !/\.csv/.test(i.accept); }, { polling: 100, timeout: 10000 });
    const help = await page.evaluate(() => document.querySelector('input[type=file][aria-label="File to upload"]').closest(".card").querySelector("p").textContent);
    assert.doesNotMatch(help, /CSV|JSON/);
  } finally { await browser.close(); }
});

// "Nothing written" is read from the database: uploads rows and artifacts rows, unpublished (head_rev = 0) included.
const rowCounts = () => JSON.parse(execFileSync("wrangler", ["d1", "--config", LOCAL_CONFIG, "execute", "DB", "--local", "--persist-to", s.dir, "--json", "--command",
  "SELECT (SELECT COUNT(*) FROM uploads) AS uploads, (SELECT COUNT(*) FROM artifacts) AS artifacts"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1", NO_COLOR: "1" } }))[0].results[0];
// The 415 list with the flag off names Markdown and HTML only (flag on: test/text-uploads-mcp.test.mjs, test/text-uploads-v1.test.mjs).
const BINARIES = "image/png, image/jpeg, image/webp, image/gif, application/pdf, video/mp4, video/webm, application/octet-stream";
const ALLOWED_OFF = `Allowed: ${BINARIES}, text/markdown, text/html`;
const NOT_FOUND = { status: 404, code: "not_found", message: "Not found" };
const LEGACY_INSTRUCTIONS_OFF = "Agent Library: project-scoped Markdown and HTML documents, plus binary artifacts. Saves require expected_revision; mutations require idempotency_key. When saving, creating or restoring a document (tools with a change_note field), always set change_note to one line on why; the owner reads it in History. Large text uses upload_begin \u2192 HTTP PUT raw UTF-8 \u2192 upload_finish; this needs an HTTP-capable client.";

test("app API and /v1 with the flag off: the 415 list names Markdown and HTML only; JSON/CSV begin is 404 whatever its size; nothing written", async () => {
  const before = rowCounts();
  const a = await owner.req("POST", "/api/projects/off-test/uploads", { title: "x", mime: "text/plain", size: 1, sha256: sha256("x") });
  assert.deepEqual([a.status, a.body.error.code, a.body.error.message], [415, "unsupported_type", ALLOWED_OFF]);
  const v = await v1("POST", "/projects/off-test/uploads", { body: { title: "x", mime: "text/plain", size: 1, sha256: sha256("x") } });
  assert.deepEqual([v.status, v.json.error.code, v.json.error.message], [415, "unsupported_type", "Allowed: text/markdown, text/html"]);
  for (const mime of ["application/json", "text/csv"]) for (const size of [2, 10 * 1024 * 1024 + 1]) {
    const r = await owner.req("POST", "/api/projects/off-test/uploads", { title: "x", mime, size, sha256: sha256("{}") });
    assert.deepEqual([r.status, r.body.error], [404, { code: "not_found", message: "Not found" }], `app ${mime} ${size}`);
    const w = await v1("POST", "/projects/off-test/uploads", { body: { title: "x", mime, size, sha256: sha256("{}") } });
    assert.equal(w.status, 404, `/v1 ${mime} ${size}`); assert.deepEqual([w.json.error.code, w.json.error.message], ["not_found", "Not found"]);
  }
  assert.deepEqual(rowCounts(), before);
});

test("legacy MCP upload_begin with the flag off: Markdown/HTML wording and instructions only; JSON/CSV refused as on /api, nothing written", async () => {
  const g = await grant(owner, "off-test", "Synthetic off uploader");
  const m = await mcpClient(APP, g.token);
  try {
    assert.equal(m.client.getInstructions(), LEGACY_INSTRUCTIONS_OFF);
    const b = (await m.client.listTools()).tools.find((t) => t.name === "upload_begin");
    assert.equal(b.inputSchema.properties.mime.description, "Exact MIME type: text/markdown, text/html, or a supported binary type.");
    assert.ok(!("schema" in b.inputSchema.properties) && !("folder_id" in b.inputSchema.properties));
    const before = rowCounts();
    for (const mime of ["application/json", "text/csv"]) for (const size of [2, 10 * 1024 * 1024 + 1]) {
      const r = await m.call("upload_begin", { project_id: "off-test", title: "x", mime, size, sha256: sha256("{}"), idempotency_key: key("ub") });
      assert.deepEqual(r.data.error, NOT_FOUND, `${mime} ${size}`);
    }
    const plain = await m.call("upload_begin", { project_id: "off-test", title: "x", mime: "text/plain", size: 1, sha256: sha256("x"), idempotency_key: key("ub") });
    assert.deepEqual(plain.data.error, { status: 415, code: "unsupported_type", message: ALLOWED_OFF });
    assert.deepEqual(rowCounts(), before);
    const md = Buffer.from("# off\n");
    const ok = await m.call("upload_begin", { project_id: "off-test", title: "off md", mime: "text/markdown", size: md.length, sha256: sha256(md), idempotency_key: key("ub") });
    assert.equal(ok.isError, false, JSON.stringify(ok.data));
    assert.equal((await fetch(APP + ok.data.put_url, { method: "PUT", body: md, headers: { authorization: `Bearer ${g.token}` } })).status, 200);
    const f = await m.call("upload_finish", { project_id: "off-test", upload_id: ok.data.upload_id, idempotency_key: key("uf") });
    assert.equal(f.isError, false, JSON.stringify(f.data)); assert.equal(f.data.revision, 1);
  } finally { await m.close(); }
});
