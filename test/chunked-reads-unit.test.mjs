// Revision-pinned chunked reads (src/reads/service.js), run directly against the real migrations in node:sqlite.
// Deterministic coverage of what a live server can only hit by timing: access that ends between authentication and
// the chunk's own statement, and exact encoded-size bounds for random text. Synthetic data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ROOT } from "./helpers.mjs";

class HttpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
let clock = Date.now();
function load() {
  const src = readFileSync(join(ROOT, "src/reads/service.js"), "utf8");
  const int = (v, name, min = 0, max = Number.MAX_SAFE_INTEGER) => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new HttpError(400, "invalid_input", `${name} must be an integer in [${min}, ${max}]`);
    return v;
  };
  const authorizeProject = async (ctx, pid) => { if (ctx.principal.kind === "agent" && ctx.grant.project_id !== pid) throw new HttpError(404, "not_found", "Project not found"); };
  const db = (ctx) => ctx.env.DB;
  return new Function("HttpError", "nowMs", "int", "authorizeProject", "db",
    src + "\nreturn { readTextChunk, rtQuery, rtIdBytes, rtChunkLimit, rtFit, RT_ID_TOO_LONG, RT_KINDS_ALL, RT_KINDS_DOCS };")(HttpError, () => clock, int, authorizeProject, db);
}
const M = load();
const sha = (s) => createHash("sha256").update(s).digest("hex");

function d1(sqlite) {
  return { prepare: (sql) => ({ bind: (...p) => ({ first: async () => sqlite.prepare(sql).get(...p) ?? null }) }) };
}
function fixture() {
  const s = new DatabaseSync(":memory:");
  for (const f of readdirSync(join(ROOT, "migrations")).sort()) s.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  const now = new Date().toISOString(), far = clock + 864e5;
  s.exec(`INSERT INTO principals VALUES ('own','human','i','s1','Owner','${now}'), ('ag','agent','i','s2','Agent','${now}'), ('ak','agent','i','s3','Key','${now}');
    INSERT INTO projects VALUES ('pa','own','A','${now}'), ('pb','own','B','${now}');
    INSERT INTO grants (id, project_id, principal_id, token_hash, can_write, expires_at, created_by, created_at) VALUES ('g1','pa','ag','h1',0,${far},'own','${now}');
    INSERT INTO api_credentials (id, owner_principal_id, principal_id, label, token_hash, created_at, expires_at) VALUES ('k1','own','ak','key','h2','${now}',${far});
    INSERT INTO api_credential_projects VALUES ('k1','pa',0);
    INSERT INTO oauth_connections (id, owner_principal_id, project_id, client_id, client_name, redirect_uri, resource, can_read, can_write, created_at, expires_at) VALUES ('oc1','own','pa','c','C','r','res',1,0,'${now}',${far});
    INSERT INTO oauth_connection_projects VALUES ('oc1','pa',0);`);
  return s;
}
function addDoc(s, id, body, { kind = "markdown", project = "pa", rev = 1 } = {}) {
  const now = new Date().toISOString();
  if (rev === 1) s.prepare("INSERT INTO artifacts (id, project_id, kind, title, head_rev, created_at, updated_at) VALUES (?, ?, ?, 't', 1, ?, ?)").run(id, project, kind, now, now);
  else s.prepare("UPDATE artifacts SET head_rev = ? WHERE id = ?").run(rev, id);
  s.prepare("INSERT INTO revisions (id, artifact_id, project_id, rev_no, author_id, body, size, sha256, mime, created_at) VALUES (?, ?, ?, ?, 'own', ?, ?, ?, 'text/markdown', ?)")
    .run(`r_${id}_${rev}`, id, project, rev, body, Buffer.byteLength(body), sha(body), now);
}
const ctxs = (s) => ({
  owner: { env: { DB: d1(s) }, principal: { id: "own", kind: "human" } },
  grant: { env: { DB: d1(s) }, principal: { id: "ag", kind: "agent" }, grant: { id: "g1", project_id: "pa", can_write: 0 } },
  apiKey: { env: { DB: d1(s) }, principal: { id: "ak", kind: "agent" }, grant: { id: "k1", project_id: "pa", can_write: 0 }, apiCredential: true },
  oauth: { env: { DB: d1(s) }, principal: { id: "own", kind: "agent" }, grant: { id: "oc1", project_id: "pa", can_write: 0 }, oauthConnection: true },
});
// The exact bytes each transport puts on the wire for a result.
const wire = (r, enc, id = "x".repeat(62)) => enc === "mcp"
  ? Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r, isError: false } }))
  : Buffer.byteLength(JSON.stringify(r));
async function readAll(ctx, pid, aid, opts) {
  const chunks = [];
  let cursor;
  do {
    const r = await M.readTextChunk(ctx, pid, aid, { ...opts, cursor });
    chunks.push(r);
    cursor = r.next_cursor ?? undefined;
  } while (!chunks.at(-1).eof && chunks.length < 10000);
  return chunks;
}
// Text with every class the encoder treats differently: ASCII, JSON escapes, control chars, 2/3/4-byte UTF-8.
const ALPHABET = ["a", "Z", " ", "\"", "\\", "\n", "\t", "\r", "\u0001", "\u001f", "\u007f", "é", "ß", "中", "€", "\u2028", "😀", "𝄞", "/", "<"];
const randText = (n, rnd = () => Math.random()) => Array.from({ length: n }, () => ALPHABET[Math.floor(rnd() * ALPHABET.length)]).join("");

test("exact reconstruction of a >256 KiB document, both encodings, every chunk within max_bytes on the wire", async () => {
  const s = fixture(), C = ctxs(s);
  let seed0 = 99; const body = randText(200_000, () => ((seed0 = (seed0 * 1103515245 + 12345) & 0x7fffffff) / 0x80000000));
  assert.ok(Buffer.byteLength(body) > 256 * 1024, "fixture exceeds 256 KiB");
  addDoc(s, "big", body);
  for (const enc of ["json", "mcp"]) for (const maxBytes of [4096, 16384, 65536]) {
    const chunks = await readAll(C.apiKey, "pa", "big", { maxBytes, encoding: enc });
    assert.equal(chunks.map((c) => c.text).join(""), body, `${enc}/${maxBytes}: exact text`);
    let off = 0;
    for (const c of chunks) {
      assert.equal(c.offset, off, "contiguous offsets");
      assert.equal(c.content_bytes, Buffer.byteLength(c.text), "content_bytes are the chunk's UTF-8 bytes (no split code point)");
      assert.ok(!c.text.includes("\uFFFD"), "no replacement characters");
      assert.ok(wire(c, enc) <= maxBytes, `${enc}/${maxBytes}: wire ${wire(c, enc)} > max`);
      assert.equal(c.revision, 1); assert.equal(c.sha256, sha(body));
      off += c.content_bytes;
    }
    assert.equal(off, Buffer.byteLength(body));
    assert.ok(chunks.length > 1);
  }
});

test("fuzz: random text, sizes and budgets; exact reconstruction and wire bound always hold", async () => {
  const s = fixture(), C = ctxs(s);
  let seed = 12345; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000);
  for (let i = 0; i < 40; i++) {
    const body = randText(Math.floor(rnd() * 9000), rnd);
    addDoc(s, "f" + i, body);
    const enc = i % 2 ? "mcp" : "json", maxBytes = 4096 + Math.floor(rnd() * 8000);
    const chunks = await readAll(C.owner, "pa", "f" + i, { maxBytes, encoding: enc });
    assert.equal(chunks.map((c) => c.text).join(""), body);
    for (const c of chunks) assert.ok(wire(c, enc) <= maxBytes, `fuzz ${i}`);
  }
});

test("MCP bound counts the real JSON-RPC id (long string, number, object); too small a budget is a 422", async () => {
  const s = fixture(), C = ctxs(s);
  const body = randText(30_000);
  addDoc(s, "d", body);
  for (const id of ["x".repeat(3000), 7, { a: "é".repeat(200) }, null]) {
    const ctx = { ...C.oauth, rpcIdBytes: M.rtIdBytes(id) };
    const chunks = await readAll(ctx, "pa", "d", { maxBytes: 8192, encoding: "mcp" });
    assert.equal(chunks.map((c) => c.text).join(""), body);
    for (const c of chunks) assert.ok(wire(c, "mcp", id) <= 8192, `id ${JSON.stringify(id).slice(0, 20)}: ${wire(c, "mcp", id)}`);
  }
  await assert.rejects(M.readTextChunk({ ...C.oauth, rpcIdBytes: M.rtIdBytes("x".repeat(5000)) }, "pa", "d", { maxBytes: 4096, encoding: "mcp" }), (e) => e.status === 422 && e.code === "max_bytes_too_small");
});

test("chunked MCP replies are bounded even for errors: long ids refused, oversized replies replaced by compact errors", () => {
  const call = (args, id = 1) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "read_artifact", arguments: args } });
  // Only chunked read_artifact calls are limited; everything else keeps its exact replies.
  assert.equal(M.rtChunkLimit(call({ artifact_id: "a" })), null);
  assert.equal(M.rtChunkLimit(call({ artifact_id: "a", cursor: null, max_bytes: null })), null);
  assert.equal(M.rtChunkLimit({ ...call({ max_bytes: 4096 }), params: { name: "save_markdown", arguments: { max_bytes: 4096 } } }), null);
  assert.equal(M.rtChunkLimit({ jsonrpc: "2.0", id: 1, method: "tools/list" }), null);
  assert.deepEqual(M.rtChunkLimit(call({ cursor: "x" })), { maxBytes: 65536, idTooLong: false });
  assert.deepEqual(M.rtChunkLimit(call({ max_bytes: 5000 })), { maxBytes: 5000, idTooLong: false });
  for (const bad of [1, "big", 1e9, 4096.5]) assert.equal(M.rtChunkLimit(call({ max_bytes: bad })).maxBytes, 4096, String(bad));
  assert.equal(M.rtChunkLimit(call({ max_bytes: 4096 }, "x".repeat(1022))).idTooLong, false, "1024 bytes as JSON is allowed");
  assert.equal(M.rtChunkLimit(call({ max_bytes: 4096 }, "x".repeat(1023))).idTooLong, true);
  assert.equal(M.rtChunkLimit(call({ max_bytes: 4096 }, { k: "é".repeat(600) })).idTooLong, true);
  assert.ok(Buffer.byteLength(JSON.stringify(M.RT_ID_TOO_LONG)) < 200);
  // rtFit: replies within the bound are unchanged; larger ones become compact errors of the same kind.
  const lim = { maxBytes: 4096 }, id = "x".repeat(1022);
  const small = { jsonrpc: "2.0", id, result: { content: [], structuredContent: { ok: 1 }, isError: false } };
  assert.equal(M.rtFit(small, lim), JSON.stringify(small));
  assert.equal(M.rtFit({ big: "y".repeat(9000) }, null).length > 9000, true, "no limit: unchanged");
  const err2 = { status: 404, code: "not_found", message: "m", projects: Array.from({ length: 50 }, (_, i) => ({ id: "p" + i, title: "t".repeat(200) })) };
  const tool = JSON.parse(M.rtFit({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify({ error: err2 }) }], structuredContent: { error: err2 }, isError: true } }, lim));
  assert.equal(tool.id, id); assert.equal(tool.result.isError, true); assert.equal(tool.result.structuredContent.error.code, "response_too_large");
  const rpcE = JSON.parse(M.rtFit({ jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown argument " + "k".repeat(9000) } }, lim));
  assert.deepEqual([rpcE.id, rpcE.error.code], [id, -32602]);
  for (const r of [tool, rpcE]) assert.ok(Buffer.byteLength(JSON.stringify(r)) <= 4096);
});

test("edge cases: empty, exactly-at-boundary 4-byte chars, single chunk", async () => {
  const s = fixture(), C = ctxs(s);
  addDoc(s, "empty", "");
  const e = await M.readTextChunk(C.owner, "pa", "empty", { maxBytes: 4096 });
  assert.deepEqual([e.text, e.eof, e.next_cursor, e.size, e.content_bytes], ["", true, null, 0, 0]);
  addDoc(s, "emoji", "😀".repeat(5000));
  const chunks = await readAll(C.owner, "pa", "emoji", { maxBytes: 4096 });
  assert.equal(chunks.map((c) => c.text).join(""), "😀".repeat(5000));
  for (const c of chunks) assert.equal(c.content_bytes % 4, 0);
  addDoc(s, "small", "hello");
  const one = await M.readTextChunk(C.owner, "pa", "small", {});
  assert.deepEqual([one.text, one.eof, one.max_bytes], ["hello", true, 65536]);
});

test("a cursor pins the version: later versions never mix in; changed version content -> revision_changed", async () => {
  const s = fixture(), C = ctxs(s);
  const v1 = randText(30_000), v2 = randText(30_000);
  addDoc(s, "d", v1);
  const first = await M.readTextChunk(C.grant, "pa", "d", { maxBytes: 8192 });
  addDoc(s, "d", v2, { rev: 2 });
  let r = first, text = first.text;
  while (!r.eof) {
    r = await M.readTextChunk(C.grant, "pa", "d", { cursor: r.next_cursor, maxBytes: 8192 });
    assert.equal(r.revision, 1); assert.equal(r.head_revision, 2); assert.equal(r.stale, true);
    text += r.text;
  }
  assert.equal(text, v1);
  // Same rev_no, different bytes (e.g. a backup restore replaced the document): refused, never mixed.
  s.prepare("UPDATE revisions SET body = ?, sha256 = ? WHERE artifact_id = 'd' AND rev_no = 1").run(v2, sha(v2));
  await assert.rejects(M.readTextChunk(C.grant, "pa", "d", { cursor: first.next_cursor, maxBytes: 8192 }), (e) => e.status === 409 && e.code === "revision_changed");
});

test("every chunk re-checks current access in its own statement (grant, API key, OAuth connection, owner)", async () => {
  const cases = [
    ["grant revoked", "grant", (s) => s.exec("UPDATE grants SET revoked_at = 1")],
    ["grant expired", "grant", () => { clock += 2 * 864e5; }],
    ["API key revoked", "apiKey", (s) => s.exec("UPDATE api_credentials SET revoked_at = 1")],
    ["API key project removed", "apiKey", (s) => s.exec("DELETE FROM api_credential_projects")],
    ["OAuth connection revoked", "oauth", (s) => s.exec("UPDATE oauth_connections SET revoked_at = 1")],
    ["OAuth project removed", "oauth", (s) => s.exec("DELETE FROM oauth_connection_projects")],
    ["OAuth connection expired", "oauth", () => { clock += 2 * 864e5; }],
    ["owner no longer owns the project", "owner", (s) => s.exec("UPDATE projects SET owner_id = 'ag'")],
  ];
  for (const [name, who, revoke] of cases) {
    clock = Date.now();
    const s = fixture(), C = ctxs(s);
    addDoc(s, "d", randText(20_000));
    const first = await M.readTextChunk(C[who], "pa", "d", { maxBytes: 4096 });
    revoke(s);
    await assert.rejects(M.readTextChunk(C[who], "pa", "d", { cursor: first.next_cursor, maxBytes: 4096 }), (e) => e.status === 404 && e.code === "not_found", name);
  }
  clock = Date.now();
});

test("trash, kinds and cursor validation", async () => {
  const s = fixture(), C = ctxs(s);
  addDoc(s, "d", randText(20_000));
  const first = await M.readTextChunk(C.owner, "pa", "d", { maxBytes: 4096 });
  s.exec("UPDATE artifacts SET trashed_at = 'x' WHERE id = 'd'");
  for (const c of [C.owner, C.grant]) await assert.rejects(M.readTextChunk(c, "pa", "d", { cursor: first.next_cursor }), (e) => e.status === 404);
  s.exec("UPDATE artifacts SET trashed_at = NULL WHERE id = 'd'");
  assert.equal((await M.readTextChunk(C.owner, "pa", "d", { cursor: first.next_cursor, maxBytes: 4096 })).offset, first.content_bytes, "untrash: the same cursor continues");
  // Another project's document, even with a cursor naming it: not found for the agent.
  addDoc(s, "b", "project b only", { project: "pb" });
  await assert.rejects(M.readTextChunk(C.grant, "pb", "b", {}), (e) => e.status === 404);
  await assert.rejects(M.readTextChunk(C.grant, "pa", "b", {}), (e) => e.status === 404);
  // Kinds: binary refused; JSON refused where only documents are allowed.
  s.exec(`INSERT INTO artifacts (id, project_id, kind, title, head_rev, created_at, updated_at) VALUES ('bin','pa','binary','t',1,'x','x');
    INSERT INTO revisions (id, artifact_id, project_id, rev_no, author_id, blob_key, size, sha256, mime, created_at) VALUES ('rb','bin','pa',1,'own','blobs/pa/bin/rb',3,'${"0".repeat(64)}','image/png','x')`);
  await assert.rejects(M.readTextChunk(C.owner, "pa", "bin", {}), (e) => e.status === 415);
  addDoc(s, "j", "{\"a\":1}", { kind: "json" });
  await assert.rejects(M.readTextChunk(C.owner, "pa", "j", { kinds: M.RT_KINDS_DOCS }), (e) => e.status === 415);
  assert.equal((await M.readTextChunk(C.owner, "pa", "j", {})).text, "{\"a\":1}");
  // Cursor tampering: other document, garbage, mid-code-point offset, revision mismatch, out-of-range max_bytes.
  addDoc(s, "u", "é".repeat(5000));
  const u = await M.readTextChunk(C.owner, "pa", "u", { maxBytes: 4096 });
  const [p, a, r, h, o] = JSON.parse(Buffer.from(u.next_cursor.slice(4), "base64url").toString());
  const forge = (x) => "rc1." + Buffer.from(JSON.stringify(x)).toString("base64url");
  const bad = [forge([p, a, r, h, o + 1]), forge([p, "d", r, h, o]), forge(["pb", a, r, h, o]), "rc1.!!", "nope", forge([p, a, r, h, -1]), forge([p, a, r, h, 1e9])];
  for (const c of bad) await assert.rejects(M.readTextChunk(C.owner, "pa", "u", { cursor: c }), (e) => e.status === 400 && /invalid_cursor/.test(e.code), c);
  await assert.rejects(M.readTextChunk(C.owner, "pa", "u", { cursor: u.next_cursor, revision: 2 }), (e) => e.status === 400);
  for (const maxBytes of [0, 4095, 524289, 1.5]) await assert.rejects(M.readTextChunk(C.owner, "pa", "u", { maxBytes }), (e) => e.status === 400);
  await assert.rejects(M.readTextChunk(C.owner, "pa", "u", { revision: 9 }), (e) => e.status === 404);
});
