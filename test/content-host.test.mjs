// The user-content host (CONTENT_HOST, decision D4 A; docs/architecture.md#user-content-host) against a real local
// server: a person's browser opens rendered HTML pages and PDFs on a separate site through short-lived view links,
// never on the app origin. Links carry no cookies, re-check the session and the person's access on every request,
// and serve only that one revision (and the project's own images inside the page). fetch() callers (the offline copy)
// and agents keep the app-host response. `content.localhost` is the second site here (Chrome resolves *.localhost to
// loopback). Synthetic data only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startServer, grant, agentHttp, sha256, LOCAL_CONFIG, ROOT } from "./helpers.mjs";
import { SERVER_PORTS } from "./ports.mjs";
import { makePng, makePdf } from "./make-fixtures.mjs";

const require = createRequire(import.meta.url);
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PUPPETEER = `${process.env.HOME}/.npm-packages/lib/node_modules/puppeteer`;
const haveChrome = existsSync(CHROME) && existsSync(PUPPETEER);
const PORT = SERVER_PORTS["content-host"];
const APP = `http://localhost:${PORT}`, CONTENT = `content.localhost:${PORT}`;
let s, alice, bob, WS, PID, OTHER, html, pdf, img, otherImg, tok;
const sql = async (q) => JSON.parse((await promisify(execFile)("wrangler", ["d1", "--config", LOCAL_CONFIG, "execute", "DB", "--local", "--persist-to", s.dir, "--json", "--command", q],
  { cwd: ROOT, encoding: "utf8" })).stdout)[0].results;
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };

// Node can't set Host on fetch(); talk to the content host over loopback with an explicit Host header.
function content(path, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const rq = request({ host: "127.0.0.1", port: PORT, path, method, headers: { host: CONTENT, ...headers } }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    rq.on("error", reject); rq.end();
  });
}
const linkPath = (loc) => { const u = new URL(loc); assert.equal(u.host, CONTENT); assert.match(u.pathname, /^\/c\/vl_[A-Za-z0-9_-]{20,64}$/); return u.pathname; };
const nav = (who, path, dest = "iframe") => fetch(APP + path, { headers: { cookie: who.cookie, "sec-fetch-dest": dest }, redirect: "manual" });

async function upload(token, pid, title, mime, bytes) {
  const a = agentHttp(APP, token);
  const b = ok(await a("POST", `/api/projects/${pid}/uploads`, { title, mime, size: bytes.length, sha256: sha256(bytes) }), 201);
  assert.equal((await a("PUT", b.put_url, undefined, { raw: bytes, headers: { "content-type": "application/octet-stream" } })).status, 200);
  return ok(await a("POST", `/api/projects/${pid}/uploads/${b.upload_id}/finish`, {})).artifact_id;
}

before(async () => {
  s = await startServer("content-host", PORT, { readyBase: APP, vars: { APP_HOST: `localhost:${PORT}`, MCP_HOST: `127.0.0.1:${PORT}`, CONTENT_HOST: CONTENT,
    RATE_READS_PER_MIN: "100000", RATE_WRITES_PER_MIN: "100000", RATE_AUTHFAIL_PER_MIN: "100000" } });
  alice = await s.loginAt(APP, "alice"); bob = await s.loginAt(APP, "bob");
  WS = ok(await alice.req("POST", "/api/workspaces", { name: "Content Co" }), 201).id;
  PID = ok(await alice.req("POST", "/api/projects", { title: "Pages", workspace_id: WS }), 201).id;
  OTHER = ok(await alice.req("POST", "/api/projects", { title: "Elsewhere", workspace_id: WS }), 201).id;
  tok = (await grant(alice, PID, "uploader", true)).token;
  img = await upload(tok, PID, "Chart", "image/png", makePng(40, 30));
  otherImg = await upload((await grant(alice, OTHER, "other", true)).token, OTHER, "Other chart", "image/png", makePng(8, 8));
  pdf = await upload(tok, PID, "Report", "application/pdf", makePdf());
  html = ok(await alice.req("POST", `/api/projects/${PID}/artifacts`, { title: "Page", kind: "html",
    body: `<h1>synthetic heron</h1><img src="${img}" alt="chart"><img src="${otherImg}" alt="other"><script>alert(1)</script>` }), 201).artifact_id;
  // bob is a viewer in the workspace (removed later).
  const inv = ok(await alice.req("POST", `/api/workspaces/${WS}/invites`, { email: "bob@example.test", role: "viewer" }), 201);
  ok(await bob.req("POST", "/api/invites/accept", { token: inv.accept_url.split("/").pop() }));
});
after(async () => { await s?.stop(); });

test("a browser frame asking for /render is sent to a view link on the content host; fetch() and agents keep the app-host page", async () => {
  const r = await nav(alice, `/api/projects/${PID}/artifacts/${html}/render?rev=1`);
  assert.equal(r.status, 302);
  const path = linkPath(r.headers.get("location"));
  const page = await content(path);
  assert.equal(page.status, 200);
  const body = page.body.toString();
  assert.match(body, /synthetic heron/);
  assert.doesNotMatch(body, /<script|alert\(1\)/, "sanitized as before");
  assert.match(body, new RegExp(`<img src="/c/vl_[^"]+/m/${img}"`), "same-project image served through the link");
  assert.doesNotMatch(body, new RegExp(otherImg), "another project's image isn't");
  const csp = page.headers["content-security-policy"];
  assert.match(csp, /script-src 'none'/); assert.match(csp, /sandbox/); assert.match(csp, new RegExp(`frame-ancestors ${APP.replace(/[.:/]/g, "\\$&")}`));
  assert.equal(page.headers["set-cookie"], undefined); assert.equal(page.headers["x-frame-options"], undefined);
  // The image inside it, and nothing else from the project.
  const im = await content(body.match(/src="(\/c\/vl_[^"]+\/m\/art_[^"]+)"/)[1]);
  assert.equal(im.status, 200); assert.equal(im.headers["content-type"], "image/png");
  assert.equal((await content(path.replace(/$/, `/m/${otherImg}`))).status, 404, "another project's file");
  assert.equal((await content(path.replace(/$/, `/m/${pdf}`))).status, 404, "not an image or video");
  // A same-project image the page doesn't show isn't reachable through its link either.
  const unrelated = await upload(tok, PID, "Unrelated", "image/png", makePng(4, 4));
  assert.equal((await content(path.replace(/$/, `/m/${unrelated}`))).status, 404, "not referenced by the page");
  // fetch() (offline copy: Sec-Fetch-Dest empty) and an agent get the page from the app host, as before.
  const f = await fetch(APP + `/api/projects/${PID}/artifacts/${html}/render?rev=1`, { headers: { cookie: alice.cookie, "sec-fetch-dest": "empty" }, redirect: "manual" });
  assert.equal(f.status, 200); assert.match(await f.text(), /synthetic heron/);
  const ag = await agentHttp(APP, tok)("GET", `/api/projects/${PID}/artifacts/${html}/render`, undefined, { headers: { "sec-fetch-dest": "iframe" } });
  assert.equal(ag.status, 200);
});

test("a PDF opened in a tab (?open=1) goes to the content host; plain content and downloads stay on the app host", async () => {
  const r = await nav(alice, `/api/projects/${PID}/artifacts/${pdf}/content?open=1`, "document");
  assert.equal(r.status, 302);
  const f = await content(linkPath(r.headers.get("location")));
  assert.equal(f.status, 200);
  assert.equal(f.headers["content-type"], "application/pdf");
  assert.match(f.headers["content-disposition"], /^inline; filename="Report\.pdf"/);
  assert.match(f.headers["content-security-policy"], /sandbox/);
  assert.equal(Buffer.compare(f.body, makePdf()), 0);
  // Range still works there.
  const part = await content(new URL(r.headers.get("location")).pathname, { headers: { range: "bytes=0-4" } });
  assert.equal(part.status, 206); assert.equal(part.body.toString(), "%PDF-");
  assert.equal((await nav(alice, `/api/projects/${PID}/artifacts/${pdf}/content?open=1&download=1`, "document")).status, 200, "download stays");
  assert.equal((await nav(alice, `/api/projects/${PID}/artifacts/${img}/content?open=1`, "image")).status, 200, "images stay");
  assert.equal((await nav(alice, `/api/projects/${PID}/artifacts/${img}/content?open=1`, "document")).status, 200, "only PDFs move");
});

test("the content host has no app: no API, no sign-in, no cookies; unknown links and paths are refused", async () => {
  for (const p of ["/", "/api/me", "/auth/methods", "/mcp", `/api/projects/${PID}/artifacts/${html}/render`, "/c/vl_unknownunknownunknown00"]) {
    const r = await content(p, { headers: { cookie: alice.cookie } });
    assert.ok([401, 404].includes(r.status), `${p} -> ${r.status}`);
    assert.equal(r.headers["set-cookie"], undefined);
  }
  assert.equal((await content("/robots.txt")).body.toString(), "User-agent: *\nDisallow: /\n");
  const post = await content("/c/vl_unknownunknownunknown00", { method: "POST" });
  assert.equal(post.status, 405); assert.equal(post.headers["x-content-type-options"], "nosniff");
});

test("links expire (pages after 5 minutes, PDFs after 30) and the cleanup removes them", async () => {
  const r = await nav(alice, `/api/projects/${PID}/artifacts/${html}/render?rev=1`);
  const path = linkPath(r.headers.get("location"));
  const row = (await sql(`SELECT expires_at - CAST(strftime('%s','now') AS INTEGER) * 1000 AS left, purpose FROM view_links WHERE token_hash = '${sha256(path.slice(3))}'`))[0];
  assert.equal(row.purpose, "render"); assert.ok(row.left > 4 * 60e3 && row.left <= 5 * 60e3 + 2000, String(row.left));
  await sql(`UPDATE view_links SET expires_at = 1 WHERE token_hash = '${sha256(path.slice(3))}'`);
  assert.equal((await content(path)).status, 401, "expired");
  ok(await alice.req("POST", `/api/projects/${PID}/maintenance/reconcile-uploads`, {}));
  assert.equal((await sql(`SELECT COUNT(*) AS n FROM view_links WHERE token_hash = '${sha256(path.slice(3))}'`))[0].n, 0, "removed by cleanup");
});

test("links stop working when the person loses access, the project is deleted, or they sign out", async () => {
  const mk = async (who) => linkPath((await nav(who, `/api/projects/${PID}/artifacts/${html}/render?rev=1`)).headers.get("location"));
  const bobLink = await mk(bob);
  assert.equal((await content(bobLink)).status, 200, "viewer can read");
  ok(await alice.req("DELETE", `/api/workspaces/${WS}/members/${(await bob.req("GET", "/api/me")).body.principal.id}`));
  assert.equal((await content(bobLink)).status, 404, "removed member");
  const aliceLink = await mk(alice);
  ok(await alice.req("DELETE", `/api/projects/${PID}`, { confirm_title: "Pages" }));
  assert.equal((await content(aliceLink)).status, 404, "deleted project");
  ok(await alice.req("POST", `/api/projects/${PID}/restore`));
  assert.equal((await content(aliceLink)).status, 200, "restored project");
  ok(await alice.req("POST", "/api/logout"));
  assert.equal((await content(aliceLink)).status, 401, "signed out");
  alice = await s.loginAt(APP, "alice");
});

test("Chrome: the HTML preview frame shows the page from the content host, with its image; the PDF opens there too", { timeout: 90000, skip: !haveChrome && "Chrome/puppeteer not installed" }, async () => {
  const browser = await require(PUPPETEER).launch({ executablePath: CHROME, headless: true, args: ["--no-first-run"] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 900 });
    await page.goto(APP + "/");
    await page.waitForSelector('input[name="passphrase"]');
    await page.evaluate(async (passphrase) => (await fetch("/auth/dev-login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase, user: "alice" }) })).status, s.passphrase());
    await page.goto(`${APP}/#/p/${PID}/a/${html}`);
    await page.reload(); // the hash change alone doesn't restart the app after signing in
    const frameEl = await page.waitForSelector("iframe.htmlview");
    // Preview is the default view for documents that have a body.
    let fr = null;
    for (let i = 0; i < 50 && !fr; i++) { fr = page.frames().find((f) => f.url().startsWith(`http://${CONTENT}/c/vl_`)); if (!fr) await new Promise((r) => setTimeout(r, 200)); }
    assert.ok(fr, "frame navigated to the content host: " + page.frames().map((f) => f.url()).join(", "));
    await fr.waitForFunction(() => document.body && /synthetic heron/.test(document.body.innerText));
    await fr.waitForFunction(() => { const i = document.querySelector("img[alt=chart]"); return i && i.complete && i.naturalWidth === 40; });
    assert.equal(await fr.evaluate(() => document.cookie), "", "no cookies on the content site");
    // Readable in the device theme: the page paints its own background (the frame is white behind it).
    const [fg, bg] = await fr.evaluate(() => [getComputedStyle(document.querySelector("h1")).color, getComputedStyle(document.documentElement).backgroundColor]);
    assert.notEqual(fg, bg, `heading ${fg} on ${bg}`);
    assert.notEqual(bg, "rgba(0, 0, 0, 0)", "opaque page background");
    await page.screenshot({ path: "tmp/test-evidence/content-host-html.png" });
    // PDF: Open goes to a new tab, which lands on the content host.
    await page.goto(`${APP}/#/p/${PID}/a/${pdf}`);
    const href = await (await page.waitForSelector(".filecard a[target=_blank]")).evaluate((a) => a.href);
    const tab = await browser.newPage();
    const resp = await tab.goto(href);
    assert.ok(tab.url().startsWith(`http://${CONTENT}/c/vl_`), tab.url());
    assert.equal(resp.headers()["content-type"], "application/pdf");
    await tab.close();
  } finally { await browser.close(); }
});
