// Upgrade test: a library written by an OLD release keeps working after this checkout's migrations (including the
// destructive 0031) and Worker are applied to the same local state, and what a Worker rollback does is on record.
//
// For each old release (the v0.1.0 tag and public main as of the merge-base work, 2bac798), the test
//   1. checks the release out with `git worktree` (tmp/old-<label>, node_modules symlinked) and builds it with its own build command,
//   2. runs that Worker under local wrangler dev with ITS migrations (0001..0016 / 0001..0017) and seeds synthetic data through its real APIs
//      (test/fixtures/upgrade-seed.mjs: Markdown and HTML with versions and notes, PNG and PDF uploads, comments, a template, a trashed
//      document, an API key, an MCP OAuth connection, a legacy agent token, an App Connect app with a published snapshot),
//   3. stops it, applies THIS branch's migrations to the same --persist-to state, and starts THIS Worker on it (same port, so the OAuth
//      issuer and audience are unchanged): verifies bytes, history, comments, templates, trash, search after the cron rebuild, file hashes,
//      the API key, the OAuth connection, the old publisher's files and credentials, and backup export and import,
//   4. stops it and runs the OLD Worker against the NEW schema (rollback) for basic reads and writes, then this Worker again.
// Findings are printed and written to tmp/test-evidence/upgrade-findings-<label>.json. Synthetic data only; loopback only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { startAppConnectServer } from "./fixtures/app-connect-harness.mjs";
import { checkoutRelease, removeRelease, revisionAvailable } from "./fixtures/old-release.mjs";
import { seedLibrary, COMMENTS, TEMPLATE_SOURCE } from "./fixtures/upgrade-seed.mjs";
import { ROOT, LOCAL_CONFIG, key, sha256 } from "./helpers.mjs";
import { SERVER_PORTS } from "./ports.mjs";

/** The old releases: the first public release, and public main when the migration history was rewritten. */
const RELEASES = [
  { label: "v010", rev: "v0.1.0", port: SERVER_PORTS["upgrade-v010"], templates: false, oldSearchUi: "not_found" },
  { label: "main", rev: "2bac798", port: SERVER_PORTS["upgrade-main"], templates: true, oldSearchUi: "initializing" },
];
const LAST_OLD_MIGRATION = "0017_review_gating.sql";
const NEW_MIGRATIONS = readdirSync(join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort();
const checkouts = [];
const stateDirs = [];
const exec = promisify(execFile);
const wrangler = (args) => exec("wrangler", args, { cwd: ROOT, encoding: "utf8", env: { ...process.env, CI: "1", NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" } });
const sql = async (dir, command) => JSON.parse((await wrangler(["d1", "execute", "DB", "--config", LOCAL_CONFIG, "--local", "--persist-to", dir, "--json", "--command", command])).stdout)[0].results;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

after(() => { for (const c of checkouts) removeRelease(c); for (const d of stateDirs) rmSync(d, { recursive: true, force: true }); });

for (const rel of RELEASES) {
  test(`upgrade from ${rel.rev}: data, search, credentials, backups; rollback behaviour`, { skip: !revisionAvailable(rel.rev) && `${rel.rev} is not in this clone (fetch the full history and tags)` }, async (t) => {
    const findings = { release: rel.rev, sha: null, oldMigrations: [], newMigrations: NEW_MIGRATIONS, untested: [], upgrade: {}, rollback: {} };
    const old = checkoutRelease(rel.label, rel.rev);
    checkouts.push(old.dir);
    findings.sha = old.sha; findings.oldMigrations = old.migrations;
    const state = join(ROOT, "tmp", `upgrade-${rel.label}`);
    stateDirs.push(state);
    rmSync(state, { recursive: true, force: true });
    const start = (opts) => startAppConnectServer({ port: rel.port, persistDir: state, fresh: false, migrate: false, ...opts });
    let seed;

    await t.test("the old release's migrations are byte-identical in this branch and it builds to its committed Worker", () => {
      for (const m of old.migrations) assert.equal(readFileSync(join(ROOT, "migrations", m), "utf8"), readFileSync(join(old.dir, "migrations", m), "utf8"), `${m} was edited`);
      assert.ok(old.migrations.at(-1) <= LAST_OLD_MIGRATION && NEW_MIGRATIONS.length > old.migrations.length);
    });

    await t.test("seed the old Worker (its own migrations) through its real APIs", async () => {
      let h = await start({ root: old.dir, migrate: true, fresh: true });
      try { seed = await seedLibrary(h, { templates: rel.templates, publisherApi: true }); } finally { await h.stop(); }
      findings.untested.push(...seed.untested);
      assert.deepEqual(seed.untested, [], "every seeded feature worked on the old release");
      const applied = (await sql(state, "SELECT name FROM d1_migrations ORDER BY id")).map((r) => r.name);
      assert.deepEqual(applied, old.migrations, "the old Worker ran exactly its own migrations");
    });

    await t.test("apply this branch's migrations to the same state, including the destructive 0031", async () => {
      const out = await wrangler(["d1", "migrations", "apply", "DB", "--config", LOCAL_CONFIG, "--local", "--persist-to", state]);
      assert.match(out.stdout, /0031_search_contentless\.sql/);
      const applied = (await sql(state, "SELECT name FROM d1_migrations ORDER BY id")).map((r) => r.name);
      assert.deepEqual(applied, NEW_MIGRATIONS);
      assert.equal((await sql(state, "PRAGMA foreign_key_check")).length, 0, "no foreign key violations");
      assert.equal((await sql(state, "SELECT count(*) AS n FROM workspaces WHERE personal = 1"))[0].n, 1, "the owner got a personal workspace");
      assert.equal((await sql(state, "SELECT ready FROM artifact_search_state"))[0].ready, 0, "search starts unavailable until the cron rebuilds it");
    });

    await t.test("this Worker on the upgraded state: documents, history, comments, templates, trash, files, keys, connections", async () => {
      const h = await start();
      try {
        const o = await h.owner(), P = seed.project, art = (id = "", q = "") => `/api/projects/${P}/artifacts${id ? "/" + id : ""}${q}`;
        const plan = seed.docs.plan;
        // Documents: every version's bytes and hash, and every change note.
        for (const r of plan.revisions) {
          const got = (await o.req("GET", art(plan.id, `?rev=${r.rev}`))).body;
          assert.equal(got.body, r.body); assert.equal(got.revision.sha256, r.sha256);
        }
        const cur = (await o.req("GET", art(plan.id))).body;
        assert.deepEqual([cur.artifact.title, cur.artifact.tags, cur.revision.rev], [plan.title, plan.tags, 3]);
        const hist = (await o.req("GET", art(plan.id) + "/history")).body;
        assert.deepEqual(hist.revisions.map((v) => v.change_note).reverse(), plan.notes);
        assert.deepEqual(hist.revisions.map((v) => v.via.kind).reverse(), ["browser", "browser", "api_key"]);
        assert.equal(hist.revisions[0].who, "Synthetic upgrade key");
        assert.ok(hist.meta_versions.length >= 2 && hist.meta_versions.at(-1).baseline, "the details history keeps its baseline");
        const diff = (await o.req("GET", art(plan.id) + "/diff?from=1&to=3")).body;
        assert.equal(diff.identical, false);
        // HTML.
        for (const r of seed.docs.html.revisions) assert.equal((await o.req("GET", art(seed.docs.html.id, `?rev=${r.rev}`))).body.body, r.body);
        assert.equal((await o.req("GET", art(seed.docs.html.id))).body.artifact.kind, "html");
        // Comments.
        const comments = (await o.req("GET", art(plan.id) + "/comments")).body.comments;
        assert.deepEqual(comments.map((c) => [c.revision, c.body]).sort(), COMMENTS.map((c) => [c.revision, c.body]).sort());
        // Binary files: bytes download with the hashes recorded at upload; the PDF over Range.
        for (const name of ["png", "pdf"]) {
          const f = seed.docs[name];
          const c = await o.req("GET", art(f.id) + "/content", undefined, { binary: true });
          assert.equal(c.status, 200); assert.equal(c.headers.get("content-type"), f.mime); assert.equal(sha256(c.body), f.sha256);
        }
        const range = await o.req("GET", art(seed.docs.pdf.id) + "/content", undefined, { binary: true, headers: { range: "bytes=0-7" } });
        assert.equal(range.status, 206); assert.equal(range.body.toString("latin1"), Buffer.from(seed.docs.pdf.base64, "base64").subarray(0, 8).toString("latin1"));
        // Trash: still there, still trashed, not in the ordinary list.
        assert.deepEqual((await o.req("GET", art("", "?trashed=1"))).body.artifacts.map((a) => a.id), [seed.docs.trashed.id]);
        assert.ok(!(await o.req("GET", art())).body.artifacts.some((a) => a.id === seed.docs.trashed.id));
        // Templates (releases that had them): listed, and a copy fills in exactly as before.
        if (rel.templates) {
          const tpl = (await o.req("GET", `/api/projects/${P}/templates`)).body.templates;
          assert.deepEqual(tpl.map((x) => x.id), [seed.docs.template.id]);
          const made = await o.req("POST", art("from-template"), { template_id: seed.docs.template.id, template_revision: 1, title: "Weekly note", date: "2026-11-01" });
          assert.equal(made.status, 201, JSON.stringify(made.body));
          const body = (await o.req("GET", art(made.body.artifact_id))).body.body;
          assert.equal(body, TEMPLATE_SOURCE.replace("{{title}}", "Weekly note").replace("{{project}}", "Upgrade notes").replace("{{date}}", "2026-11-01"));
        }
        // Search: unavailable until the cron has rebuilt the index from stored text, then finds the old documents (not the trashed one).
        const early = await o.req("GET", "/api/search?query=zebrafish");
        assert.deepEqual([early.status, early.body.error.code], [503, "search_initializing"]);
        assert.equal((await o.req("GET", "/api/search/status")).body.ready, false);
        let ready = false;
        for (let i = 0; i < 80 && !ready; i++) {
          assert.equal((await fetch(h.issuer + "/cdn-cgi/handler/scheduled")).status, 200);
          ready = (await o.req("GET", "/api/search/status")).body.ready && (await sql(state, "SELECT count(*) AS n FROM artifact_search_missing"))[0].n === 0;
          if (!ready) await wait(150);
        }
        assert.ok(ready, "the cron rebuilt the search index");
        const find = async (q) => (await o.req("GET", "/api/search?" + new URLSearchParams({ query: q }))).body.results.map((r) => r.artifact_id);
        assert.deepEqual(await find("zebrafish"), [plan.id]);
        assert.deepEqual(await find("narwhal"), [plan.id]);
        assert.deepEqual(await find("pangolin"), [seed.docs.html.id]);
        assert.deepEqual(await find("quokka"), [], "a trashed document is not searchable");
        // API key: the old secret still authenticates, reads the old bytes, searches and writes.
        const keyed = (path, init = {}) => fetch(h.api + path, { ...init, headers: { authorization: `Bearer ${seed.apiKey.secret}`, ...(init.headers ?? {}) } });
        const read = await keyed(`/projects/${P}/files/${plan.id}`);
        assert.equal(read.status, 200); assert.equal((await read.json()).body, plan.revisions[2].body);
        assert.equal((await keyed("/search?query=narwhal")).status, 200);
        const created = await keyed(`/projects/${P}/files`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key("up") }, body: JSON.stringify({ title: "After upgrade (key)", body: "written with the old key okapi" }) });
        assert.equal(created.status, 201);
        // Legacy agent token (real MCP) and MCP OAuth connection: both still work, and OAuth renews.
        const mcp = async (token, name, args, base = h.issuer) => {
          const r = await fetch(base + "/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
          return { status: r.status, data: (await r.json().catch(() => ({}))).result?.structuredContent };
        };
        for (const [token, base] of [[seed.legacyGrant, h.appUi], [seed.oauth.access_token, h.issuer]]) {
          const r = await mcp(token, "read_artifact", { project_id: P, artifact_id: plan.id }, base);
          assert.equal(r.status, 200); assert.equal(r.data.text ?? r.data.body, plan.revisions[2].body);
        }
        const renewed = await h.token({ grant_type: "refresh_token", refresh_token: seed.oauth.refresh_token, client_id: seed.oauth.client_id });
        assert.equal(renewed.status, 200, JSON.stringify(renewed.body));
        assert.equal((await mcp(renewed.body.access_token, "list_artifacts", { project_id: P })).status, 200);
        const access = (await o.req("GET", "/api/access")).body;
        assert.ok(JSON.stringify(access).includes("Synthetic upgrade agent"), "the OAuth connection is listed for the owner");
        // App Connect: the old publisher's files are now ordinary App Files at /v1/app; the old API is gone.
        const pub = seed.publisher;
        assert.equal((await h.pub(pub.access_token, "GET", "/publisher/me")).status, 404, "/v1/publisher/* is removed");
        const pr = await h.token({ grant_type: "refresh_token", refresh_token: pub.refresh_token, client_id: pub.client_id, resource: h.resource });
        assert.equal(pr.status, 200, "the publisher's refresh token still renews");
        const me = (await h.pub(pr.body.access_token, "GET", "/app")).json;
        assert.deepEqual([me.project.id, me.folder.name], [seed.appProject, "Upgrade App"]);
        const files = (await h.pub(pr.body.access_token, "GET", "/app/files")).json.files;
        const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
        assert.deepEqual(Object.keys(byPath).sort(), ["manifest.json", "measurements.csv", "measurements.json"], "the snapshot's files keep their names; the old manifest is an ordinary file");
        for (const name of ["measurements.json", "measurements.csv"]) {
          const f = pub.files.find((x) => x.name === name);
          assert.equal(byPath[name].sha256, f.sha256);
          const bytes = await h.pub(pr.body.access_token, "GET", `/app/files/${name}`);
          assert.equal(bytes.text, pub.content[name]); assert.equal(sha256(Buffer.from(bytes.text)), f.sha256);
        }
        assert.equal(byPath["manifest.json"].sha256, pub.manifest.sha256);
        // The old files can be replaced through the new API (If-Match with the sha256 recorded by the old snapshot).
        const next = JSON.stringify({ schema: "agentlib.measurements/1", meta: { source_app: "synthetic" }, records: [] });
        const replaced = await fetch(h.api + "/app/files/measurements.json", { method: "PUT", headers: { authorization: `Bearer ${pr.body.access_token}`, "content-type": "application/json",
          "idempotency-key": key("app"), "if-match": byPath["measurements.json"].etag }, body: next });
        assert.equal(replaced.status, 200, await replaced.clone().text());
        assert.equal((await h.pub(pr.body.access_token, "GET", "/app/files/measurements.json")).text, next);
        // The owner still sees the files in the app project, marked as an app's (protected) files.
        const appDocs = (await o.req("GET", `/api/projects/${seed.appProject}/artifacts`)).body.artifacts;
        assert.ok(appDocs.every((a) => a.publisher?.protected === true) && appDocs.length === 3, "the app project still shows exactly the three files");
        assert.deepEqual(appDocs.map((a) => a.app_path).sort(), ["manifest.json", "measurements.csv", "measurements.json"]);
        findings.upgrade.appFiles = Object.keys(byPath).sort();
      } finally { await h.stop(); }
    });

    await t.test("backups: this Worker exports the upgraded library, imports it, and imports the old Worker's own backup", async () => {
      const h = await start();
      try {
        const o = await h.owner(), P = seed.project, plan = seed.docs.plan;
        const exp = (await o.req("GET", `/api/projects/${P}/backup`));
        assert.equal(exp.status, 200, JSON.stringify(exp.body).slice(0, 300));
        const backup = exp.body;
        assert.match(backup.schema, /^agent-library-backup\/[123]$/);
        assert.deepEqual(backup.comments.map((c) => c.body).sort(), COMMENTS.map((c) => c.body).sort());
        const ws = (await o.req("GET", "/api/workspaces")).body.workspaces.find((w) => w.personal).id;
        const imported = await o.req("POST", `/api/workspaces/${ws}/import`, { backup, title: "Imported after upgrade" });
        assert.equal(imported.status, 201, JSON.stringify(imported.body));
        const copy = (await o.req("GET", `/api/projects/${imported.body.project_id}/artifacts`)).body.artifacts;
        const copyPlan = copy.find((a) => a.title === plan.title);
        assert.ok(copyPlan);
        for (const r of plan.revisions) assert.equal((await o.req("GET", `/api/projects/${imported.body.project_id}/artifacts/${copyPlan.id}?rev=${r.rev}`)).body.revision.sha256, r.sha256);
        const copyPng = copy.find((a) => a.title === "Synthetic png");
        const png = await o.req("GET", `/api/projects/${imported.body.project_id}/artifacts/${copyPng.id}/content`, undefined, { binary: true });
        assert.equal(sha256(png.body), seed.docs.png.sha256);
        // The old Worker's own export (its schema) imports too.
        const fromOld = await o.req("POST", `/api/workspaces/${ws}/import`, { backup: seed.oldBackup, title: "Imported old export" });
        assert.equal(fromOld.status, 201, JSON.stringify(fromOld.body));
        assert.equal(fromOld.body.comments, 2);
        // The app project exports with the app's files marked (no longer refused as in 0.1.0).
        const appExp = await o.req("GET", `/api/projects/${seed.appProject}/backup`);
        assert.equal(appExp.status, 200);
        assert.deepEqual(appExp.body.artifacts.map((a) => a.app?.path).sort(), ["manifest.json", "measurements.csv", "measurements.json"]);
        findings.upgrade.backupSchema = backup.schema; findings.upgrade.oldBackupSchema = seed.oldBackup.schema;
      } finally { await h.stop(); }
    });

    await t.test("rollback: the OLD Worker on the NEW schema (0031 applied), then this Worker again", async () => {
      // A document made by this Worker first: its text lives in R2 (migration 0028), which a Worker before 0028 does not read.
      let h = await start();
      let nowDoc;
      try {
        const o = await h.owner();
        nowDoc = (await o.req("POST", `/api/projects/${seed.project}/artifacts`, { title: "Made by the new Worker", body: "newera body text" })).body.artifact_id;
        assert.ok(nowDoc);
      } finally { await h.stop(); }

      h = await start({ root: old.dir });
      const rb = findings.rollback, P = seed.project, plan = seed.docs.plan;
      let wrote;
      try {
        const o = await h.owner(), art = (id = "", q = "") => `/api/projects/${P}/artifacts${id ? "/" + id : ""}${q}`;
        const list = await o.req("GET", art()); rb.list = list.status; assert.equal(list.status, 200);
        const read = await o.req("GET", art(plan.id)); rb.readOld = read.status; assert.equal(read.body.body, plan.revisions[2].body);
        assert.equal((await o.req("GET", art(plan.id) + "/history")).status, 200);
        assert.equal((await o.req("GET", art(plan.id) + "/comments")).body.comments.length, 2);
        const png = await o.req("GET", art(seed.docs.png.id) + "/content", undefined, { binary: true });
        assert.equal(sha256(png.body), seed.docs.png.sha256);
        const keyRead = await fetch(`${h.api}/projects/${P}/files/${plan.id}`, { headers: { authorization: `Bearer ${seed.apiKey.secret}` } });
        rb.apiKey = keyRead.status; assert.equal(keyRead.status, 200);
        // Writes by the old Worker on the new schema.
        const save = await o.req("PUT", art(plan.id), { expected_revision: 3, body: "rolled back save with the word platypus", change_note: "Saved by the old Worker" });
        rb.save = save.status; assert.equal(save.status, 200, JSON.stringify(save.body));
        wrote = save.body.sha256;
        const made = await o.req("POST", art(), { title: "Made while rolled back", body: "rollbackdoc body" });
        rb.create = made.status; assert.equal(made.status, 201);
        assert.equal((await o.req("POST", art(plan.id) + "/comments", { revision: 4, body: "Comment while rolled back" })).status, 201);
        const trashedNow = await o.req("PATCH", art(seed.docs.trashed.id), { expected_meta_version: 2, trashed: false });
        rb.untrash = trashedNow.status; assert.equal(trashedNow.status, 200);
        // The new Worker's document: a Worker before 0028 does not read text kept in R2.
        const newDoc = await o.req("GET", art(nowDoc));
        rb.newWorkerDoc = { status: newDoc.status, body: newDoc.body?.body ?? null };
        assert.notEqual(rb.newWorkerDoc.body, "newera body text", "documented: text written by this Worker is unreadable to a Worker before 0028");
        // Search: 0031 removed the old search index and its triggers.
        const search = await o.req("GET", "/api/search?query=zebrafish");
        rb.searchUi = search.status === 404 ? "not_found" : search.status === 503 ? "initializing" : `status ${search.status}`;
        assert.equal(rb.searchUi, rel.oldSearchUi);
        rb.projectFilterQ = (await o.req("GET", art("", "?q=platypus"))).status;
        const exp = await o.req("GET", `/api/projects/${seed.appProject}/backup`);
        rb.appProjectBackup = exp.status; // 0.1.0 and main refuse projects that hold app files
        assert.equal(exp.status, 409);
      } finally { await h.stop(); }

      // Forward again: the new Worker sees the old Worker's writes; its cron re-indexes them (the old Worker had no way to).
      h = await start();
      try {
        const o = await h.owner();
        const back = (await o.req("GET", `/api/projects/${P}/artifacts/${plan.id}`)).body;
        assert.deepEqual([back.revision.rev, back.revision.sha256, back.body], [4, wrote, "rolled back save with the word platypus"]);
        const hist = (await o.req("GET", `/api/projects/${P}/artifacts/${plan.id}/history`)).body.revisions;
        assert.equal(hist[0].change_note, "Saved by the old Worker");
        let found = [];
        for (let i = 0; i < 80 && !found.includes(plan.id); i++) {
          await fetch(h.issuer + "/cdn-cgi/handler/scheduled");
          found = (await o.req("GET", "/api/search?query=platypus")).body.results?.map((r) => r.artifact_id) ?? [];
          if (!found.includes(plan.id)) await wait(150);
        }
        assert.ok(found.includes(plan.id), "rolled-back writes become searchable after the cron rebuild");
        assert.equal((await o.req("GET", `/api/projects/${P}/artifacts/${nowDoc}`)).body.body, "newera body text");
        rb.forwardAgain = "ok";
      } finally { await h.stop(); }
    });

    mkdirSync(join(ROOT, "tmp", "test-evidence"), { recursive: true });
    writeFileSync(join(ROOT, "tmp", "test-evidence", `upgrade-findings-${rel.label}.json`), JSON.stringify(findings, null, 2));
    console.log(`upgrade findings ${rel.rev}: ${JSON.stringify({ upgrade: findings.upgrade, rollback: findings.rollback })}`);
  });
}
