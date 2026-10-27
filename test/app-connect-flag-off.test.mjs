// Contract §0: with APP_CONNECT_ENABLED unset (production), every App Connect surface is unreachable and the
// shared responses keep their exact Phase 1 shapes (security review F3). Migration 0008 is applied locally.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, key } from "./helpers.mjs";
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
  for (const p of [`/projects/off-test/files/${aid}/records`, "/projects/off-test/folders", "/publisher/me", "/publisher/snapshots"]) {
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
