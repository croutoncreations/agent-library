// Revision-pinned chunked text reads through the real Worker (wrangler dev, local D1) on every user-facing transport:
// /v1 (API key), legacy /mcp (grant, real MCP SDK client + raw JSON-RPC for wire sizes) and the owner's browser API.
// The OAuth MCP endpoint is covered in test/oauth-chatgpt.test.mjs. Synthetic data only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { startServer, mcpClient, grant, key, barrier } from "./helpers.mjs";
import { SERVER_PORTS } from "./ports.mjs";

const PORT = SERVER_PORTS["chunked-reads"];
const API = `http://127.0.0.1:${PORT}`;   // machine host (MCP_HOST): /v1
const APP = `http://localhost:${PORT}`;   // owner host (APP_HOST): /api, legacy /mcp
const PA = "syn-chunks", PB = "syn-other";
const sha = (s) => createHash("sha256").update(s).digest("hex");
let s, owner;

// Deterministic synthetic text over every class the encoder treats differently (ASCII, JSON escapes, controls, 2/3/4-byte UTF-8).
const ALPHABET = ["a", "b", " ", "\"", "\\", "\n", "\t", "\u0001", "é", "中", "€", "\u2028", "😀", "𝄞", "<"];
function synth(n, seed) { let x = seed; return Array.from({ length: n }, () => ALPHABET[(x = (x * 1103515245 + 12345) & 0x7fffffff) % ALPHABET.length]).join(""); }

async function v1(path, token) {
  const r = await fetch(API + path, { headers: { authorization: `Bearer ${token}` } });
  const text = await r.text();
  return { status: r.status, wire: Buffer.byteLength(text), json: text ? JSON.parse(text) : null };
}
async function rawMcp(token, args, id = 1) {
  const r = await fetch(APP + "/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "read_artifact", arguments: args } }) });
  const text = await r.text();
  assert.match(r.headers.get("content-type") ?? "", /json/);
  return { status: r.status, wire: Buffer.byteLength(text), body: text ? JSON.parse(text) : null };
}
const mkKey = async (projects) => {
  const r = await owner.req("POST", "/api/api-keys", { label: "chunk test", lifetime_days: 1, projects });
  assert.equal(r.status, 201); return r.body;
};
const create = async (title, body, pid = PA) => {
  const r = await owner.req("POST", `/api/projects/${pid}/artifacts`, { title, body });
  assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.artifact_id;
};
const save = async (id, rev, body) => {
  const r = await owner.req("PUT", `/api/projects/${PA}/artifacts/${id}`, { expected_revision: rev, body });
  assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.revision;
};

before(async () => {
  s = await startServer("chunked-reads", PORT, {
    vars: { MCP_HOST: `127.0.0.1:${PORT}`, APP_HOST: `localhost:${PORT}`, RATE_READS_PER_MIN: "100000", RATE_WRITES_PER_MIN: "100000", RATE_AUTHFAIL_PER_MIN: "100000" },
    readyBase: APP,
  });
  owner = await s.loginAt(APP);
  for (const p of [PA, PB]) assert.equal((await owner.req("POST", "/api/projects", { id: p, title: p })).status, 201);
});
after(async () => { await s?.stop(); });

test("small reads keep their exact previous shape on every transport", async () => {
  const id = await create("small", "# hello\nsmall");
  const k = await mkKey([{ project_id: PA, access: "read" }]);
  const f = await v1(`/v1/projects/${PA}/files/${id}`, k.secret);
  assert.equal(f.json.body, "# hello\nsmall"); assert.equal(f.json.next_cursor, undefined);
  const g = await grant(owner, PA, "small reader", false);
  const m = await mcpClient(APP, g.token);
  try {
    const r = await m.call("read_artifact", { project_id: PA, artifact_id: id });
    assert.equal(r.data.body, "# hello\nsmall"); assert.equal(r.data.revision.rev, 1); assert.equal(r.data.text, undefined);
    const tool = (await m.client.listTools()).tools.find((t) => t.name === "read_artifact");
    assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ["artifact_id", "cursor", "max_bytes", "project_id", "revision"]);
    // Clients that send null for optional arguments still get the whole-body read.
    const nul = await m.call("read_artifact", { project_id: PA, artifact_id: id, cursor: null, max_bytes: null });
    assert.equal(nul.data.body, "# hello\nsmall");
  } finally { await m.close(); }
  const o = await owner.req("GET", `/api/projects/${PA}/artifacts/${id}`);
  assert.equal(o.body.body, "# hello\nsmall");
});

test(">256 KiB document: exact reconstruction over /v1, legacy MCP (SDK) and the browser API; wire bytes <= max_bytes", async () => {
  const body = synth(160_000, 7);
  assert.ok(Buffer.byteLength(body) > 256 * 1024 && Buffer.byteLength(body) < 1024 * 1024);
  const id = await create("big", body);
  const k = await mkKey([{ project_id: PA, access: "read" }]);
  const g = await grant(owner, PA, "big reader", false);
  const evidence = {};
  // /v1: GET .../text, JSON encoding.
  for (const max of [16384, 65536]) {
    let cur = "", text = "", n = 0, maxWire = 0;
    for (;;) {
      const r = await v1(`/v1/projects/${PA}/files/${id}/text?max_bytes=${max}${cur ? "&cursor=" + cur : ""}`, k.secret);
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.ok(r.wire <= max, `/v1 wire ${r.wire} > ${max}`);
      assert.equal(r.json.encoding, "json"); assert.equal(r.json.sha256, sha(body)); assert.equal(r.json.size, Buffer.byteLength(body));
      text += r.json.text; n++; maxWire = Math.max(maxWire, r.wire);
      if (r.json.eof) break;
      cur = encodeURIComponent(r.json.next_cursor);
    }
    assert.equal(text, body); evidence[`v1_${max}`] = { chunks: n, max_wire: maxWire };
  }
  // Legacy MCP with the real SDK client.
  const m = await mcpClient(APP, g.token);
  try {
    let r = await m.call("read_artifact", { project_id: PA, artifact_id: id, max_bytes: 32768 }), text = r.data.text, n = 1;
    while (!r.data.eof) { r = await m.call("read_artifact", { project_id: PA, artifact_id: id, cursor: r.data.next_cursor }); assert.equal(r.isError, false); text += r.data.text; n++; }
    assert.equal(text, body); evidence.mcp_sdk_32768 = { chunks: n };
  } finally { await m.close(); }
  // Legacy MCP, raw JSON-RPC to measure what is actually on the wire.
  let r = await rawMcp(g.token, { project_id: PA, artifact_id: id, max_bytes: 8192 }), text = "", n = 0, maxWire = 0, content = 0;
  for (;;) {
    const out = r.body.result.structuredContent;
    assert.equal(r.body.result.isError, false, JSON.stringify(out));
    assert.ok(r.wire <= 8192, `MCP wire ${r.wire} > 8192`);
    assert.equal(r.body.result.content[0].text, JSON.stringify(out));
    text += out.text; n++; maxWire = Math.max(maxWire, r.wire); content += out.content_bytes;
    if (out.eof) break;
    r = await rawMcp(g.token, { project_id: PA, artifact_id: id, cursor: out.next_cursor, max_bytes: 8192 });
  }
  assert.equal(text, body); assert.equal(content, Buffer.byteLength(body));
  // A long JSON-RPC id is echoed in the reply and counted in the bound.
  const longId = "id-" + "x".repeat(1019); // 1024 bytes as JSON: the longest id a chunked read accepts
  const li = await rawMcp(g.token, { project_id: PA, artifact_id: id, max_bytes: 8192 }, longId);
  assert.equal(li.body.id, longId); assert.equal(li.body.result.isError, false);
  assert.ok(li.wire <= 8192, `long-id MCP wire ${li.wire} > 8192`);
  const tooLong = await rawMcp(g.token, { project_id: PA, artifact_id: id, max_bytes: 8192 }, longId + "x");
  assert.equal(tooLong.status, 400); assert.equal(tooLong.body.id, null);
  evidence.mcp_raw_8192 = { chunks: n, max_wire: maxWire, content_bytes: content };
  // Browser API (owner session).
  let o = await owner.req("GET", `/api/projects/${PA}/artifacts/${id}/text?max_bytes=524288`), otext = o.body.text;
  while (!o.body.eof) { o = await owner.req("GET", `/api/projects/${PA}/artifacts/${id}/text?cursor=${encodeURIComponent(o.body.next_cursor)}&max_bytes=524288`); otext += o.body.text; }
  assert.equal(otext, body);
  console.log("chunk evidence", JSON.stringify(evidence));
});

test("concurrent edits while reading: every chunk comes from the pinned version; the next read sees the new head", async () => {
  const v1body = synth(60_000, 11);
  const id = await create("racing", v1body);
  const k = await mkKey([{ project_id: PA, access: "read" }]);
  let r = await v1(`/v1/projects/${PA}/files/${id}/text?max_bytes=8192`, k.secret), text = r.json.text, rev = 1, i = 0;
  const written = [v1body];
  while (!r.json.eof) {
    // Race a save against each chunk read.
    const next = synth(60_000, 100 + i++);
    const [chunk, saved] = await barrier([
      () => v1(`/v1/projects/${PA}/files/${id}/text?max_bytes=8192&cursor=${encodeURIComponent(r.json.next_cursor)}`, k.secret),
      () => save(id, rev, next),
    ]);
    rev = saved; written.push(next);
    assert.equal(chunk.status, 200);
    assert.equal(chunk.json.revision, 1); assert.equal(chunk.json.sha256, sha(v1body));
    text += chunk.json.text; r = chunk;
  }
  assert.equal(text, v1body, "no bytes from later versions");
  assert.ok(r.json.stale && r.json.head_revision > 1, "the last chunk reports the newer head");
  const fresh = await v1(`/v1/projects/${PA}/files/${id}/text?max_bytes=524288`, k.secret);
  assert.equal(fresh.json.revision, rev); assert.equal(fresh.json.text, written.at(-1));
  // A pinned historical version can be read in chunks too.
  let h = await v1(`/v1/projects/${PA}/files/${id}/text?revision=2&max_bytes=8192`, k.secret), ht = h.json.text;
  while (!h.json.eof) { h = await v1(`/v1/projects/${PA}/files/${id}/text?max_bytes=8192&cursor=${encodeURIComponent(h.json.next_cursor)}`, k.secret); ht += h.json.text; }
  assert.equal(ht, written[1]);
});

test("revocation, trash and project scope between chunks", async () => {
  const body = synth(40_000, 23);
  const id = await create("guarded", body);
  const other = await create("other project", "project other only", PB);
  // API key revoked mid-read.
  const k = await mkKey([{ project_id: PA, access: "read" }]);
  const first = await v1(`/v1/projects/${PA}/files/${id}/text?max_bytes=4096`, k.secret);
  assert.equal(first.status, 200);
  const cur = encodeURIComponent(first.json.next_cursor);
  // A cursor does not carry access: another project's key cannot use it, nor reach that project.
  const kb = await mkKey([{ project_id: PB, access: "read" }]);
  assert.equal((await v1(`/v1/projects/${PA}/files/${id}/text?cursor=${cur}`, kb.secret)).status, 404);
  assert.equal((await v1(`/v1/projects/${PB}/files/${id}/text?cursor=${cur}`, kb.secret)).status, 400, "cursor is bound to its project and document");
  assert.equal((await v1(`/v1/projects/${PB}/files/${other}/text`, k.secret)).status, 404);
  assert.equal((await owner.req("POST", `/api/api-keys/${k.id}/revoke`, {})).status, 200);
  const after = await v1(`/v1/projects/${PA}/files/${id}/text?cursor=${cur}`, k.secret);
  assert.equal(after.status, 401); assert.equal(JSON.stringify(after.json).includes(body.slice(4000, 4100)), false);
  // Legacy grant revoked mid-read (MCP).
  const g = await grant(owner, PA, "revoked reader", false);
  const m1 = await rawMcp(g.token, { project_id: PA, artifact_id: id, max_bytes: 4096 });
  assert.equal(m1.body.result.isError, false);
  assert.equal((await owner.req("PATCH", `/api/projects/${PA}/grants/${g.grant_id}`, { revoke: true })).status, 200);
  assert.equal((await rawMcp(g.token, { project_id: PA, artifact_id: id, cursor: m1.body.result.structuredContent.next_cursor })).status, 401);
  // Trash mid-read: agents and the owner get 404; untrash and the same cursor continues.
  const g2 = await grant(owner, PA, "trash reader", false);
  const t1 = await rawMcp(g2.token, { project_id: PA, artifact_id: id, max_bytes: 4096 });
  const meta = (await owner.req("GET", `/api/projects/${PA}/artifacts/${id}`)).body.artifact.meta_version;
  assert.equal((await owner.req("PATCH", `/api/projects/${PA}/artifacts/${id}`, { expected_meta_version: meta, trashed: true })).status, 200);
  const t2 = await rawMcp(g2.token, { project_id: PA, artifact_id: id, cursor: t1.body.result.structuredContent.next_cursor });
  assert.equal(t2.body.result.isError, true); assert.equal(t2.body.result.structuredContent.error.status, 404);
  assert.equal((await owner.req("GET", `/api/projects/${PA}/artifacts/${id}/text`)).status, 404);
  assert.equal((await owner.req("PATCH", `/api/projects/${PA}/artifacts/${id}`, { expected_meta_version: meta + 1, trashed: false })).status, 200);
  const t3 = await rawMcp(g2.token, { project_id: PA, artifact_id: id, cursor: t1.body.result.structuredContent.next_cursor, max_bytes: 4096 });
  assert.equal(t3.body.result.isError, false); assert.equal(t3.body.result.structuredContent.offset, t1.body.result.structuredContent.content_bytes);
  // Error replies of chunked reads are bounded too (legacy MCP): an over-long id is refused before it is echoed, and
  // errors with an allowed id stay within max_bytes, even when the error would echo a long argument name.
  const g3 = await grant(owner, PA, "error envelopes", false);
  const env = {};
  for (const [name, args] of [
    ["too_small", { project_id: PA, artifact_id: id, max_bytes: 4096 }],
    ["not_found", { project_id: PA, artifact_id: "art_missing", max_bytes: 4096 }],
    ["invalid_cursor", { project_id: PA, artifact_id: id, cursor: "rc1.zz", max_bytes: 4096 }],
  ]) {
    for (const rid of ["i".repeat(10000), "i".repeat(100000)]) {
      const e = await rawMcp(g3.token, args, rid);
      assert.equal(e.status, 400, name); assert.equal(e.body.id, null); assert.equal(e.body.error.code, -32600);
      assert.ok(e.wire <= 4096, `${name} id ${rid.length}: ${e.wire}`);
      env[`${name}_id${rid.length}`] = e.wire;
    }
    const ok = await rawMcp(g3.token, args, "j".repeat(1022));
    assert.ok(ok.wire <= 4096, `${name} id 1022: ${ok.wire}`); assert.equal(ok.body.id, "j".repeat(1022));
    env[`${name}_id1022`] = ok.wire;
  }
  const longArg = await rawMcp(g3.token, { project_id: PA, artifact_id: id, max_bytes: 4096, ["k".repeat(9000)]: 1 }, "j".repeat(1022));
  assert.ok(longArg.wire <= 4096, `unknown-argument error ${longArg.wire}`); assert.equal(longArg.body.error.code, -32602);
  env.unknown_long_argument_id1022 = longArg.wire;
  // Not a chunked read: replies are exactly as before (the id is echoed in full).
  const plain = await rawMcp(g3.token, { project_id: PA, artifact_id: "art_missing" }, "i".repeat(10000));
  assert.equal(plain.body.id.length, 10000); assert.equal(plain.body.result.structuredContent.error.code, "not_found");
  console.log("error envelope evidence", JSON.stringify(env));
  // Bad input is a clean 400, never a 500.
  const k2 = await mkKey([{ project_id: PA, access: "read" }]);
  for (const q of ["max_bytes=1", "max_bytes=abc", "max_bytes=999999999", "cursor=garbage", "revision=0"])
    assert.equal((await v1(`/v1/projects/${PA}/files/${id}/text?${q}`, k2.secret)).status, 400, q);
  assert.equal((await fetch(`${API}/v1/projects/${PA}/files/${id}/text`, { method: "POST", headers: { authorization: `Bearer ${k2.secret}` } })).status, 405);
});
