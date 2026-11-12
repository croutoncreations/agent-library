// List title filters up to the 200-character limit (D1 refuses LIKE patterns over 50 bytes), with unchanged matching:
// title substring, ASCII-only case folding, and % _ \ matched literally. Real local Worker: app API (project list and
// trash), /v1 and legacy MCP list calls, which all reach listArtifacts. Plus a table that pins the old LIKE matching
// against the new expression in plain SQLite, because the local D1 may not enforce the 50-byte limit.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mcpClient, grant } from "./helpers.mjs";
import { SERVER_PORTS } from "./ports.mjs";
import { startAppConnectServer } from "./fixtures/app-connect-harness.mjs";

const PORT = SERVER_PORTS["list-filter-long"], APP = `http://localhost:${PORT}`, API = `http://127.0.0.1:${PORT}`;
let h, owner;
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const LONG60 = "Quarterly planning notes for the synthetic research team ABC"; // 60 characters
const LONG200 = ("Synthetic long title segment " + "x".repeat(200)).slice(0, 200);
assert.equal(LONG60.length, 60);
const ids = {};

before(async () => {
  h = await startAppConnectServer({ port: PORT });
  owner = await h.owner();
  ok(await owner.req("POST", "/api/projects", { id: "filter-long", title: "Filter long" }), 201);
  for (const [name, title] of [["l60", "Prefix " + LONG60 + " suffix"], ["l200", LONG200], ["other", "Unrelated title"], ["trashed", LONG60 + " (old)"]])
    ids[name] = ok(await owner.req("POST", "/api/projects/filter-long/artifacts", { title, body: "synthetic" }), 201).artifact_id;
  ok(await owner.req("PATCH", `/api/projects/filter-long/artifacts/${ids.trashed}`, { expected_meta_version: 1, trashed: true }));
});
after(async () => { await h?.stop(); });

const list = async (q, extra = "") => ok(await owner.req("GET", `/api/projects/filter-long/artifacts?q=${encodeURIComponent(q)}${extra}`)).artifacts.map((a) => a.id).sort();

test("60- and 200-character filters return 200 with the right rows (project list and trash)", async () => {
  assert.deepEqual(await list(LONG60), [ids.l60]);
  assert.deepEqual(await list(LONG60.toLowerCase()), [ids.l60]);
  assert.deepEqual(await list(LONG60.replace("ABC", "ABD")), []);
  assert.deepEqual(await list(LONG200), [ids.l200]);
  assert.deepEqual(await list(LONG200.toUpperCase()), [ids.l200]);
  assert.deepEqual(await list(LONG200.slice(0, 199) + "y"), []);
  assert.deepEqual(await list(LONG60, "&trashed=1"), [ids.trashed]);
  assert.equal((await owner.req("GET", `/api/projects/filter-long/artifacts?q=${"x".repeat(201)}`)).status, 413); // existing str() limit: too_large
});

test("/v1 and legacy MCP list calls accept long filters", async () => {
  const k = ok(await owner.req("POST", "/api/api-keys", { label: "long filter key", lifetime_days: 1, projects: [{ project_id: "filter-long", access: "read" }] }), 201);
  const r = await fetch(`${API}/v1/projects/filter-long/files?query=${encodeURIComponent(LONG60)}`, { headers: { authorization: "Bearer " + k.secret } });
  const body = await r.json();
  assert.equal(r.status, 200, JSON.stringify(body));
  assert.deepEqual(body.files.map((a) => a.id), [ids.l60]);
  const g = await grant(owner, "filter-long", "long filter reader", false), m = await mcpClient(APP, g.token);
  try {
    const res = await m.call("list_artifacts", { project_id: "filter-long", query: LONG200 });
    assert.equal(res.isError, false, JSON.stringify(res));
    assert.deepEqual(res.data.artifacts.map((a) => a.id), [ids.l200]);
  } finally { await m.close(); }
});

test("special characters and non-ASCII titles match exactly as before (short filters, real Worker)", async () => {
  const titles = ["100% sure", "100 percent sure", "snake_case name", "snakeXcase name", "back\\slash path", "backslash path", "Ünïcode Straße", "ünïcode strasse", "ÉCOLE", "école"];
  const made = {};
  ok(await owner.req("POST", "/api/projects", { id: "filter-special", title: "Filter special" }), 201);
  for (const t of titles) made[t] = ok(await owner.req("POST", "/api/projects/filter-special/artifacts", { title: t, body: "x" }), 201).artifact_id;
  const got = async (q) => ok(await owner.req("GET", `/api/projects/filter-special/artifacts?q=${encodeURIComponent(q)}`)).artifacts.map((a) => a.id).sort();
  const want = (...ts) => ts.map((t) => made[t]).sort();
  assert.deepEqual(await got("0%"), want("100% sure"));
  assert.deepEqual(await got("e_c"), want("snake_case name"));
  assert.deepEqual(await got("k\\s"), want("back\\slash path"));
  assert.deepEqual(await got("ÜNÏCODE"), []); // non-ASCII letters are not case-folded
  assert.deepEqual(await got("Ünïcode"), want("Ünïcode Straße"));
  assert.deepEqual(await got("STRAßE"), want("Ünïcode Straße"));
  assert.deepEqual(await got("école"), want("école"));
  assert.deepEqual(await got("COLE"), want("ÉCOLE", "école"));
});

// The old expression, exactly as listArtifacts built it, against the new one, on SQLite's own lower() and LIKE.
test("old LIKE matching and the new expression agree on a table of cases (plain SQLite)", () => {
  const db = new DatabaseSync(":memory:");
  const oldMatch = db.prepare("SELECT ? LIKE ? ESCAPE '\\' AS m");
  const newMatch = db.prepare("SELECT instr(lower(?), lower(?)) > 0 AS m");
  const titles = ["100% sure", "snake_case", "back\\slash", "Ünïcode Straße", "ÉCOLE école", "Mixed CASE Title", "ǅemal", "ΣΊΣΥΦΟΣ σίσυφος", "İstanbul", "emoji 😀 here", "tab\there", "  spaced  ", "a", ""];
  const terms = ["%", "_", "\\", "0%", "e_c", "k\\s", "ü", "Ü", "ünïcode", "STRASSE", "straße", "é", "É", "cole", "COLE", "mixed case", "ǆ", "σ", "Σ", "i̇", "istanbul", "😀", "\t", "  ", "a", "A", "aa", "x".repeat(60)];
  const like = (t) => "%" + t.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
  let n = 0;
  for (const title of titles) for (const term of terms) {
    assert.equal(newMatch.get(title, term).m, oldMatch.get(title, like(term)).m, JSON.stringify([title, term]));
    n++;
  }
  assert.equal(n, titles.length * terms.length);
});
