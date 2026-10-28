// SQLite mutation semantics and the exact maintained cleanup function, complementary to real D1 tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
function db() {
  const d = new DatabaseSync(":memory:");
  for (const n of readdirSync("migrations")
    .filter((n) => n.endsWith(".sql"))
    .sort())
    d.exec(readFileSync("migrations/" + n, "utf8"));
  d.exec(
    `INSERT INTO principals VALUES('owner','human','local','owner','Owner','2000-01-01');INSERT INTO projects VALUES('p','owner','Synthetic','2000-01-01');`,
  );
  return d;
}
const create = (d, id = "a", date = "1900-01-01") =>
  d.exec(
    `INSERT INTO artifacts(id,project_id,kind,title,head_rev,head_revision_id,created_at,updated_at) VALUES('${id}','p','markdown','Synthetic',1,'r-${id}','${date}','${date}');INSERT INTO revisions(id,artifact_id,project_id,rev_no,author_id,body,size,sha256,mime,created_at) VALUES('r-${id}','${id}','p',1,'owner','synthetic',9,'hash','text/markdown','${date}');`,
  );
test("no backfill; migration is retry-safe; old timestamps/reserved revision IDs cannot move later commits before a captured boundary", () => {
  const d = db();
  create(d);
  const boundary = d.prepare("SELECT max(seq) n FROM project_changes").get().n;
  create(d, "z", "1800-01-01");
  const later = d
    .prepare("SELECT * FROM project_changes WHERE seq>?")
    .all(boundary);
  assert.equal(later.length, 1);
  assert.equal(later[0].artifact_id, "z");
  assert.ok(later[0].at > "2020");
  d.exec(readFileSync("migrations/0015_project_changes.sql", "utf8"));
  assert.equal(d.prepare("SELECT count(*) n FROM project_changes").get().n, 2);
  d.close();
});
test("failed logical transaction rolls back revision, head, idempotency and event together", () => {
  const d = db();
  create(d);
  assert.throws(() =>
    d.exec(
      `BEGIN;INSERT INTO revisions(id,artifact_id,project_id,rev_no,author_id,size,sha256,mime,created_at) VALUES('r2','a','p',2,'owner',1,'h2','text/plain','old');UPDATE artifacts SET head_rev=2,head_revision_id='r2' WHERE id='a';INSERT INTO idempotency VALUES('owner','p','save','same','digest',200,'{}','old');INSERT INTO artifacts(id) VALUES('a');COMMIT;`,
    ),
  );
  d.exec("ROLLBACK");
  assert.equal(d.prepare("SELECT count(*) n FROM project_changes").get().n, 1);
  assert.equal(d.prepare("SELECT head_rev FROM artifacts").get().head_rev, 1);
  assert.equal(d.prepare("SELECT count(*) n FROM revisions").get().n, 1);
  assert.equal(d.prepare("SELECT count(*) n FROM idempotency").get().n, 0);
  d.close();
});
test("both head/revision insertion orders publish once; history import publishes only the readable head", () => {
  const d = db();
  create(d);
  d.exec(
    `INSERT INTO revisions(id,artifact_id,project_id,rev_no,author_id,size,sha256,mime,created_at,restored_from) VALUES('r2','a','p',2,'owner',1,'h2','text/plain','old',1);UPDATE artifacts SET head_rev=2,head_revision_id='r2' WHERE id='a';`,
  );
  assert.deepEqual(
    d
      .prepare(
        "SELECT type,revision,restored_from FROM project_changes ORDER BY seq",
      )
      .all()
      .map((x) => ({ ...x })),
    [
      { type: "artifact.created", revision: 1, restored_from: null },
      { type: "artifact.content_updated", revision: 2, restored_from: 1 },
    ],
  );
  d.exec(
    `INSERT INTO artifacts(id,project_id,kind,title,head_rev,head_revision_id,created_at,updated_at) VALUES('b','p','markdown','Imported',3,'b3','old','old');`,
  );
  for (let n = 1; n <= 3; n++)
    d.exec(
      `INSERT INTO revisions(id,artifact_id,project_id,rev_no,author_id,size,sha256,mime,created_at) VALUES('b${n}','b','p',${n},'owner',1,'h','text/plain','old');`,
    );
  assert.equal(
    d
      .prepare("SELECT count(*) n FROM project_changes WHERE artifact_id='b'")
      .get().n,
    1,
  );
  d.close();
});
test("folder rename emits artifact organization events; new empty folder and uncommitted uploads do not", () => {
  const d = db();
  create(d);
  d.exec(
    `INSERT INTO folders(id,project_id,name,name_key,created_at,created_by) VALUES('f','p','One','one','now','owner');UPDATE artifacts SET folder_id='f' WHERE id='a';UPDATE folders SET name='Two' WHERE id='f';INSERT INTO artifacts(id,project_id,kind,title,created_at,updated_at) VALUES('pending','p','binary','Upload','now','now');`,
  );
  const rows = d
    .prepare("SELECT changed_fields FROM project_changes ORDER BY seq")
    .all();
  assert.equal(rows.length, 3);
  assert.equal(rows.at(-1).changed_fields, '["folder"]');
  d.close();
});
test("cleanup deletes at most 1000 rows; preserves monotonic high and records floor even when all events expire", async () => {
  const d = db();
  for (let n = 0; n < 1005; n++)
    d.exec(
      `INSERT INTO project_changes(project_id,artifact_id,kind,type,changed_fields,at) VALUES('p','a','markdown','artifact.created','[]','1900-01-01');`,
    );
  const code = readFileSync("src/changes/service.js", "utf8");
  const warnings = [];
  const cleanup = vm.runInNewContext(code + ";cleanupChanges", {
    nowMs: () => Date.now(),
    console: { warn: (message) => warnings.push(JSON.parse(message)) },
  });
  const env = {
    DB: {
      prepare: (q) => ({ q, params: [], bind: (...params) => ({ q, params }) }),
      batch: async (statements) => {
        d.exec("BEGIN");
        try {
          const results = statements.map(({ q, params }) =>
            q.startsWith("SELECT")
              ? { results: d.prepare(q).all(...params) }
              : { meta: d.prepare(q).run(...params) },
          );
          d.exec("COMMIT");
          return results;
        } catch (e) {
          d.exec("ROLLBACK");
          throw e;
        }
      },
    },
  };
  await cleanup(env);
  assert.equal(d.prepare("SELECT count(*) n FROM project_changes").get().n, 5);
  let state = d.prepare("SELECT * FROM project_change_state").get();
  assert.equal(state.high, 1005);
  assert.equal(state.floor, 1000);
  assert.deepEqual(warnings, [
    { event: "project_changes_cleanup_batch_full", deleted: 1000, limit: 1000 },
  ]);
  await cleanup(env);
  state = d.prepare("SELECT * FROM project_change_state").get();
  assert.equal(state.high, 1005);
  assert.equal(state.floor, 1005);
  assert.equal(
    warnings.length,
    1,
    "a partial batch does not report saturation",
  );
  d.close();
});

test("OAuth kind gates independently apply App Connect and file approval", () => {
  const kinds = vm.runInNewContext(
    readFileSync("src/changes/service.js", "utf8") + ";chKinds",
    {
      appConnectEnabled: (env) => env.APP_CONNECT_ENABLED === "1",
    },
  );
  for (const enabled of [false, true]) {
    for (const files of [false, true]) {
      const ctx = {
        oauthConnection: true,
        env: { APP_CONNECT_ENABLED: enabled ? "1" : "0" },
        ftConn: { file_access: files ? 1 : 0 },
      };
      assert.deepEqual(Array.from(kinds(ctx)), [
        "markdown",
        "html",
        ...(enabled ? ["json", "csv"] : []),
        ...(files ? ["binary"] : []),
      ]);
    }
  }
  assert.deepEqual(Array.from(kinds({ env: {} })), [
    "markdown",
    "html",
    "json",
    "csv",
    "binary",
  ]);
});
test("older Worker generation writes do not trigger side effects that break its exact changes checks; new batches opt in", () => {
  const d = db();
  d.exec(
    `INSERT INTO artifacts(id,project_id,kind,title,head_rev,head_revision_id,generation_id,created_at,updated_at) VALUES('g','p','json','Generated',1,'g1','g_test','now','now');INSERT INTO revisions(id,artifact_id,project_id,rev_no,author_id,size,sha256,mime,created_at) VALUES('g1','g','p',1,'owner',1,'h','application/json','now');`,
  );
  assert.equal(d.prepare("SELECT total_changes() n").get().n > 0, true);
  assert.equal(d.prepare("SELECT count(*) n FROM project_changes").get().n, 0);
  d.exec(
    `BEGIN;INSERT INTO change_generation_context VALUES(1);INSERT INTO revisions(id,artifact_id,project_id,rev_no,author_id,size,sha256,mime,created_at) VALUES('g2','g','p',2,'owner',1,'h','application/json','now');UPDATE artifacts SET head_rev=2,head_revision_id='g2' WHERE id='g';`,
  );
  assert.equal(d.prepare("SELECT changes() n").get().n, 1);
  assert.equal(d.prepare("SELECT count(*) n FROM project_changes").get().n, 1);
  d.exec("DELETE FROM change_generation_context;COMMIT");
  d.close();
});

test("metadata changes made entirely inside trash produce no new reconciliation signal", () => {
  const d = db();
  create(d);
  d.exec("UPDATE artifacts SET trashed_at='now',meta_version=2 WHERE id='a'");
  assert.equal(d.prepare("SELECT count(*) n FROM project_changes").get().n, 2);
  d.exec(
    "UPDATE artifacts SET title='Hidden rename',meta_version=3 WHERE id='a'",
  );
  assert.equal(d.prepare("SELECT count(*) n FROM project_changes").get().n, 2);
  d.close();
});

test("opaque cursors hide global counters, use fresh nonces and reject ciphertext tampering", async () => {
  const code = readFileSync("src/changes/service.js", "utf8");
  class HttpError extends Error {
    constructor(status, code, message) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  const { chEncode, chDecode } = vm.runInNewContext(
    code + ";({chEncode,chDecode})",
    {
      crypto: webcrypto,
      TextEncoder,
      TextDecoder,
      Uint8Array,
      btoa,
      atob,
      HttpError,
    },
  );
  const key = await webcrypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const data = [
    "project-synthetic",
    "owner:synthetic",
    "markdown",
    12345,
    0,
    Date.now(),
    0,
    "coverage",
  ];
  const a = await chEncode(key, data),
    b = await chEncode(key, data);
  assert.notEqual(a, b);
  assert.equal(a.split(".")[1].length, 16);
  assert.equal(JSON.stringify(await chDecode(key, a)), JSON.stringify(data));
  assert.throws(() =>
    JSON.parse(Buffer.from(a.split(".")[2], "base64url").toString()),
  );
  const parts = a.split(".");
  parts[2] = (parts[2][0] === "a" ? "b" : "a") + parts[2].slice(1);
  await assert.rejects(
    () => chDecode(key, parts.join(".")),
    (e) => e.code === "invalid_cursor",
  );
});
