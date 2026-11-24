// App Files display headers on PUT /v1/app/files/{path} (docs/app-connect.md#title-author-and-change-note):
// X-Agentlib-Title (the file's title: on create, and on a replace that changes it, as a new details version),
// X-Agentlib-Author (a per-write label shown in History as "<label> via <app>"; the app stays the actor) and
// X-Agentlib-Change-Note (the version's change note). None changes paths, ETags or authorization; all three are part of
// the idempotency fingerprint. Real local wrangler dev, the real App Connect flows, real HTTP and Chrome; synthetic data.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync } from "node:fs";
import { startAppConnectServer } from "./fixtures/app-connect-harness.mjs";
import { makePng } from "./make-fixtures.mjs";
import { SERVER_PORTS } from "./ports.mjs";

const require = createRequire(import.meta.url);
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PUPPETEER = `${process.env.HOME}/.npm-packages/lib/node_modules/puppeteer`;
const haveChrome = existsSync(CHROME) && existsSync(PUPPETEER);

const PID = "meta-own";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const etagOf = (b) => `"${sha(b)}"`;
let h, owner, n = 0;
const uniq = (p) => `${p}-${++n}-key`;
const enc = (s) => encodeURIComponent(s);
const rfc8187 = (s) => "UTF-8''" + enc(s);

async function connect(name = "Brigade") {
  const label = uniq("meta").replace("-key", "");
  const app = await h.registerApp({ display_name: name, redirect_uris: [`https://${label}.example.test/cb`], origins: [`https://${label}.example.test`] });
  const P = await h.connectPublisher(app, { project_id: PID, destination: "new", new_folder_name: label });
  return { app, P, tok: P.access_token, origin: `https://${label}.example.test` };
}
async function reply(r) {
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, headers: r.headers, text, json };
}
/** PUT text or bytes with the display headers given in `meta` ({ title, author, note } as raw header values). */
async function put(tok, path, body, { create, match, type = "text/markdown", key = uniq("put"), meta = {} } = {}) {
  const hd = { authorization: `Bearer ${tok}`, "content-type": type, "idempotency-key": key, ...create ? { "if-none-match": "*" } : { "if-match": match } };
  if (type !== "text/markdown") hd["x-content-sha256"] = sha(body);
  if (meta.title !== undefined) hd["x-agentlib-title"] = meta.title;
  if (meta.author !== undefined) hd["x-agentlib-author"] = meta.author;
  if (meta.note !== undefined) hd["x-agentlib-change-note"] = meta.note;
  return reply(await fetch(`${h.api}/app/files/${path}`, { method: "PUT", headers: hd, body }));
}
const err = (r, status, code) => { assert.equal(r.status, status, r.text); assert.equal(r.json.error.code, code, r.text); };
const history = async (id) => (await owner.req("GET", `/api/projects/${PID}/artifacts/${id}/history`)).body;
const artifact = async (id) => (await owner.req("GET", `/api/projects/${PID}/artifacts/${id}`)).body.artifact;

before(async () => {
  h = await startAppConnectServer({ port: SERVER_PORTS["app-files-meta"] });
  owner = await h.owner();
  assert.equal((await owner.req("POST", "/api/projects", { id: PID, title: "App file details" })).status, 201);
});
after(async () => { await h?.stop(); });

test("Unicode titles (percent-encoded and RFC 8187) set the title on create, for text and binary; without the header the title is the path's name", async () => {
  const c = await connect();
  const t1 = "Résumé — 第3週 · 🚀 plan";
  const a = await put(c.tok, "notes/brief.md", "# Brief\n", { create: true, meta: { title: enc(t1) } });
  assert.equal(a.status, 201, a.text);
  assert.equal(a.json.file.title, t1);
  assert.equal((await artifact(a.json.file.file_id)).title, t1);

  const t2 = "Ünïcödé shot ✓";
  const png = makePng(12, 12);
  const b = await put(c.tok, "shots/one.png", png, { create: true, type: "image/png", meta: { title: rfc8187(t2) } });
  assert.equal(b.status, 201, b.text);
  assert.equal(b.json.file.title, t2);
  assert.equal(b.json.file.etag, etagOf(png), "the ETag is still the bytes' SHA-256");

  const plain = await put(c.tok, "notes/plain.md", "# Plain\n", { create: true });
  assert.equal(plain.json.file.title, "plain.md");

  // The list and the owner's search see the titles.
  const files = (await reply(await fetch(`${h.api}/app/files`, { headers: { authorization: `Bearer ${c.tok}` } }))).json.files;
  assert.deepEqual(files.map((f) => [f.path, f.title]), [["notes/brief.md", t1], ["notes/plain.md", "plain.md"], ["shots/one.png", t2]]);
  const found = (await owner.req("GET", `/api/projects/${PID}/artifacts?q=${enc("Ünïcödé")}`)).body.artifacts.map((x) => x.id);
  assert.ok(found.includes(b.json.file.file_id), JSON.stringify(found));
});

test("title validation: same rules as a document title (1-200 characters); bad percent-encoding and raw non-ASCII are refused before anything is written", async () => {
  const c = await connect();
  err(await put(c.tok, "v/long.md", "# x\n", { create: true, meta: { title: enc("é".repeat(201)) } }), 413, "too_large");
  assert.equal((await put(c.tok, "v/edge.md", "# x\n", { create: true, meta: { title: enc("é".repeat(200)) } })).status, 201);
  err(await put(c.tok, "v/empty.md", "# x\n", { create: true, meta: { title: "" } }), 400, "invalid_input");
  err(await put(c.tok, "v/badpct.md", "# x\n", { create: true, meta: { title: "50%" } }), 400, "invalid_input");
  err(await put(c.tok, "v/badutf.md", "# x\n", { create: true, meta: { title: "%C3%28" } }), 400, "invalid_input");
  const files = (await reply(await fetch(`${h.api}/app/files?prefix=v/`, { headers: { authorization: `Bearer ${c.tok}` } }))).json.files.map((f) => f.path);
  assert.deepEqual(files, ["v/edge.md"], "refused writes stored nothing");
});

test("a replace with the same bytes and a new title: one details version, no content version, same ETag; sending the same title again changes nothing", async () => {
  const c = await connect();
  const md = "# Weekly\n";
  const a = await put(c.tok, "weekly.md", md, { create: true, meta: { title: enc("Week 1") } });
  const id = a.json.file.file_id, etag = a.json.file.etag;
  const metaBefore = (await artifact(id)).meta_version;

  const r = await put(c.tok, "weekly.md", md, { match: etag, meta: { title: enc("Week 1 — final"), author: "Chief", note: enc("Renamed for the archive") } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.file.title, "Week 1 — final");
  assert.equal(r.json.file.revision, 1, "no content version");
  assert.equal(r.json.file.etag, etag);
  assert.equal(r.json.unchanged, undefined);
  const art = await artifact(id);
  assert.equal(art.title, "Week 1 — final");
  assert.equal(art.meta_version, metaBefore + 1);
  const hist = await history(id);
  assert.equal(hist.revisions.length, 1);
  const mv = hist.meta_versions[0];
  assert.deepEqual([mv.title, mv.who, mv.change_note, mv.on_behalf_of], ["Week 1 — final", "Chief via Brigade", "Renamed for the archive", "Chief"]);

  // Same title again: unchanged, nothing written.
  const same = await put(c.tok, "weekly.md", md, { match: etag, meta: { title: enc("Week 1 — final") } });
  assert.equal(same.json.unchanged, true);
  assert.equal((await artifact(id)).meta_version, metaBefore + 1);
  // No title header: the title stays.
  const none = await put(c.tok, "weekly.md", md, { match: etag });
  assert.equal(none.json.unchanged, true);
  assert.equal(none.json.file.title, "Week 1 — final");

  // Binary: same bytes, new title.
  const png = makePng(10, 10);
  const b = await put(c.tok, "weekly.png", png, { create: true, type: "image/png" });
  const rb = await put(c.tok, "weekly.png", png, { match: b.json.file.etag, type: "image/png", meta: { title: enc("Chart ✓") } });
  assert.equal(rb.status, 200, rb.text);
  assert.deepEqual([rb.json.file.title, rb.json.file.revision, rb.json.file.etag], ["Chart ✓", 1, etagOf(png)]);
});

test("a replace with new bytes and a new title: one content version and one details version in the same write; the author and note are on the content version", async () => {
  const c = await connect();
  const a = await put(c.tok, "report.md", "# v1\n", { create: true, meta: { author: "Scout" } });
  const id = a.json.file.file_id;
  const r = await put(c.tok, "report.md", "# v2\n", { match: a.json.file.etag, meta: { title: enc("Report (v2)"), author: rfc8187("Chëf"), note: enc("Second pass") } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.json.file.title, r.json.file.revision], ["Report (v2)", 2]);
  const hist = await history(id);
  const [v2, v1] = hist.revisions;
  assert.deepEqual([v2.rev, v2.who, v2.change_note, v2.on_behalf_of, v2.via.kind, v2.via.label], [2, "Chëf via Brigade", "Second pass", "Chëf", "publisher", "Brigade"]);
  assert.deepEqual([v1.who, v1.change_note], ["Scout via Brigade", null]);
  assert.equal(hist.meta_versions[0].title, "Report (v2)");
  // The app is still the actor: the version's author is the app's principal, not a person.
  assert.equal(v2.author_id, v1.author_id);

  // Without an author label the app's own name is shown, as before.
  const r3 = await put(c.tok, "report.md", "# v3\n", { match: r.json.file.etag });
  assert.equal((await history(id)).revisions[0].who, "Brigade");
  assert.equal(r3.json.file.title, "Report (v2)", "the title is kept without the header");
});

test("author label: control characters, empty and over 80 characters are refused; the label never changes authorization", async () => {
  const c = await connect();
  // Controls, invisible/bidi formatting, blank fillers, no letter or digit, and names the UI uses for people.
  for (const bad of ["Chief%0Aadmin", "Chief%09", "%7F", "a%C2%85b", "%20%20", enc("\u202Eadmin"), enc("Chief\u200B"), enc("\u3164"), "---",
    "You", "owner", "UNKNOWN", enc("Owner via Chrome")])
    err(await put(c.tok, "x/a.md", "# x\n", { create: true, meta: { author: bad } }), 400, "invalid_input");
  // Titles from an app refuse controls and invisible formatting too.
  for (const bad of [enc("a\nb"), enc("\u202Etitle"), enc("x\u200By"), enc("   ")])
    assert.ok([400, 413].includes((await put(c.tok, "x/t.md", "# x\n", { create: true, meta: { title: bad } })).status), bad);
  // Whitespace runs collapse; the stored label is the clean one.
  const sp = await put(c.tok, "x/s.md", "# x\n", { create: true, meta: { author: enc("  Night   shift ") } });
  assert.equal((await history(sp.json.file.file_id)).revisions[0].who, "Night shift via Brigade");
  err(await put(c.tok, "x/a.md", "# x\n", { create: true, meta: { author: "a".repeat(81) } }), 413, "too_large");
  assert.equal((await put(c.tok, "x/a.md", "# x\n", { create: true, meta: { author: "a".repeat(80) } })).status, 201);
  err(await put(c.tok, "x/n.md", "# x\n", { create: true, meta: { note: enc("x".repeat(281)) } }), 413, "too_large");
  // Claiming to be the owner changes nothing: a revoked app with a label is still refused.
  const r = await owner.req("POST", `/api/publishers/${c.P.publisher_id}/revoke`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  err(await put(c.tok, "x/b.md", "# x\n", { create: true, meta: { author: "Owner" } }), 401, "publisher_revoked");
});

test("the same Idempotency-Key with a different title, author or note is 422; with the same headers it replays the first answer", async () => {
  const c = await connect();
  const key = uniq("idem");
  const first = await put(c.tok, "i/a.md", "# a\n", { create: true, key, meta: { title: enc("Alpha"), author: "Chief", note: "one" } });
  assert.equal(first.status, 201, first.text);
  for (const meta of [{ title: enc("Beta"), author: "Chief", note: "one" }, { title: enc("Alpha"), author: "Other", note: "one" }, { title: enc("Alpha"), author: "Chief", note: "two" }, {}])
    err(await put(c.tok, "i/a.md", "# a\n", { create: true, key, meta }), 422, "idempotency_key_reused");
  const again = await put(c.tok, "i/a.md", "# a\n", { create: true, key, meta: { title: enc("Alpha"), author: "Chief", note: "one" } });
  assert.equal(again.status, 201);
  assert.equal(again.json.idempotent_replay, true);
  assert.equal(again.json.file.title, "Alpha");

  // A replace (stored in the revision's shape) replays with the file's title.
  const rk = uniq("idem-r");
  const rep = await put(c.tok, "i/a.md", "# a2\n", { match: first.json.file.etag, key: rk, meta: { title: enc("Alpha 2") } });
  assert.equal(rep.status, 200, rep.text);
  const rep2 = await put(c.tok, "i/a.md", "# a2\n", { match: first.json.file.etag, key: rk, meta: { title: enc("Alpha 2") } });
  assert.deepEqual([rep2.status, rep2.json.idempotent_replay, rep2.json.file.title, rep2.json.file.revision], [200, true, "Alpha 2", 2]);
  // A title-only replace replays too.
  const tk = uniq("idem-t");
  const t1 = await put(c.tok, "i/a.md", "# a2\n", { match: rep.json.file.etag, key: tk, meta: { title: enc("Alpha 3") } });
  const t2 = await put(c.tok, "i/a.md", "# a2\n", { match: rep.json.file.etag, key: tk, meta: { title: enc("Alpha 3") } });
  assert.deepEqual([t1.status, t2.status, t2.json.idempotent_replay, t2.json.file.title], [200, 200, true, "Alpha 3"]);
});

test("a no-op write with display headers records its key: after the owner renames the file, its retry replays and keeps the rename", async () => {
  const c = await connect();
  for (const [path, body, type] of [["n/doc.md", "# same\n", "text/markdown"], ["n/pic.png", makePng(9, 9), "image/png"]]) {
    const a = await put(c.tok, path, body, { create: true, type, meta: { title: enc("App title") } });
    const id = a.json.file.file_id;
    const key = uniq("noop");
    const first = await put(c.tok, path, body, { match: a.json.file.etag, type, key, meta: { title: enc("App title") } });
    assert.deepEqual([first.status, first.json.unchanged], [200, true]);
    // The owner renames the file.
    const art = await artifact(id);
    assert.equal((await owner.req("PATCH", `/api/projects/${PID}/artifacts/${id}`, { expected_meta_version: art.meta_version, title: "Owner's name" })).status, 200);
    // The same request again replays the first answer; it does not put the app's title back.
    const retry = await put(c.tok, path, body, { match: a.json.file.etag, type, key, meta: { title: enc("App title") } });
    assert.deepEqual([retry.status, retry.json.idempotent_replay, retry.json.unchanged], [200, true, true]);
    assert.equal((await artifact(id)).title, "Owner's name");
  }
});

test("change note: controls and invisible formatting are refused; an empty note is the same as none", async () => {
  const c = await connect();
  for (const bad of [enc("line\nbreak"), enc("\u202Enote"), enc("a\u200Bb")])
    err(await put(c.tok, "cn/a.md", "# a\n", { create: true, meta: { note: bad } }), 400, "invalid_input");
  const key = uniq("cn");
  const a = await put(c.tok, "cn/a.md", "# a\n", { create: true, key, meta: { note: "" } });
  assert.equal(a.status, 201, a.text);
  assert.equal((await history(a.json.file.file_id)).revisions[0].change_note, null);
  // Same fingerprint as sending no header at all.
  const replay = await put(c.tok, "cn/a.md", "# a\n", { create: true, key });
  assert.equal(replay.json.idempotent_replay, true);
});

test("the browser preflight allows the three headers; a project backup keeps the author label", async () => {
  const c = await connect();
  const pre = await fetch(`${h.api}/app/files/a.md`, { method: "OPTIONS", headers: { origin: c.origin, "access-control-request-method": "PUT", "access-control-request-headers": "x-agentlib-title, x-agentlib-author, x-agentlib-change-note" } });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get("access-control-allow-headers"), /X-Agentlib-Title, X-Agentlib-Author, X-Agentlib-Change-Note/);
  const a = await put(c.tok, "b/kept.md", "# kept\n", { create: true, meta: { author: "Chief", note: "first" } });
  const backup = (await owner.req("GET", `/api/projects/${PID}/backup`)).body;
  const rev = backup.revisions.find((r) => r.artifact_id === a.json.file.file_id);
  assert.deepEqual([rev.on_behalf_of, rev.change_note, rev.via_label], ["Chief", "first", "Brigade"]);
});

test("Chrome: History shows '<label> via <app>' and the change note", { skip: !haveChrome }, async () => {
  const c = await connect();
  const a = await put(c.tok, "ui/brief.md", "# Brief\n\nOne\n", { create: true, meta: { title: enc("Daily brief"), author: "Chief" } });
  await put(c.tok, "ui/brief.md", "# Brief\n\nTwo\n", { match: a.json.file.etag, meta: { author: "Scout", note: enc("Added the second line") } });
  mkdirSync("tmp/test-evidence", { recursive: true });
  const browser = await require(PUPPETEER).launch({ executablePath: CHROME, headless: true, args: ["--no-first-run"] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    const [name, value] = owner.cookie.split("=");
    await page.setCookie({ name, value, url: h.appUi, httpOnly: true });
    await page.goto(h.appUi + `/#/p/${PID}/a/${a.json.file.file_id}?tab=history`);
    await page.waitForFunction(() => document.querySelectorAll(".vh-who").length >= 2);
    const rows = await page.$$eval(".vh-list li", (els) => els.map((e) => e.innerText));
    const text = rows.join("\n");
    assert.match(text, /Scout via Brigade/);
    assert.match(text, /Chief via Brigade/);
    assert.match(text, /Added the second line/);
    assert.match(await page.$eval("h1", (e) => e.textContent), /Daily brief/);
    await page.screenshot({ path: "tmp/test-evidence/app-files-author-history.png" });
  } finally { await browser.close(); }
});
