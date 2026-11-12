// Search excerpts must cost at most linear time in the indexed text, whatever a document contains.
// FTS5 snippet() is quadratic in the matches inside one document: a 1 MiB body of one repeated two-byte word
// took minutes on staging. Through the real local Worker: HTTP search and legacy MCP search_artifacts.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { grant, mcpClient } from "./helpers.mjs";
import { SERVER_PORTS } from "./ports.mjs";
import { startAppConnectServer } from "./fixtures/app-connect-harness.mjs";

const PORT = SERVER_PORTS["search-excerpt-bounds"], APP = `http://localhost:${PORT}`;
const BOUND_MS = 10_000; // Before the fix one such search takes minutes; this is not a tuning knob.
let server, owner;
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const create = async (p, title, body) => ok(await owner.req("POST", `/api/projects/${p}/artifacts`, { title, body }), 201).artifact_id;
const timed = async (fn) => { const t = performance.now(); const r = await fn(); return { r, ms: performance.now() - t }; };
const search = (a) => timed(() => owner.req("GET", "/api/search?" + new URLSearchParams(a)));
const words = (p, n, sep = " ") => Array.from({ length: n }, (_, i) => p + i).join(sep);
// One two-byte word repeated to fill exactly 1 MiB (1,048,576 bytes), the size of the indexed prefix.
const mibOf = (w) => (w + " ").repeat(1048576 / (w.length + 1));

before(async () => {
  server = await startAppConnectServer({ port: PORT });
  owner = await server.owner();
  for (const id of ["excerpt-small", "excerpt-big", "excerpt-page", "excerpt-late"]) ok(await owner.req("POST", "/api/projects", { id, title: id }), 201);
});
after(async () => { await server?.stop(); });

// Excerpts recorded against the unchanged code (snippet(artifact_search,4,'','',' … ',40)) before the fix.
const SMALL = [
  ["first word", "pinzz " + words("w", 100) + " end.", "pinzz"],
  ["last word", words("w", 100) + " pinzz tail.", "pinzz"],
  ["sentence start", words("w", 30, ", ") + " pinzz " + words("v", 30) + "!", "pinzz"],
  ["short", "Short pinzz doc.", "pinzz"],
  ["leading space", "  lead space, pinzz. Then x y.  ", "pinzz"],
  ["near start", words("w", 10) + " pinzz " + words("v", 100), "pinzz"],
  ["middle", words("w", 100) + " pinzz pinyy " + words("v", 100), "pinzz"],
  ["two words", words("w", 100) + " pinyy " + words("v", 10) + " pinzz " + words("u", 100), "pinzz pinyy"],
  ["accent fold", "Notes on the café menu. " + words("w", 60), "cafe"],
  ["markdown", "# Heading\n\nSome *pinmd* text with [a link](https://example.com/x).\n\n- item one\n- item two", "pinmd"],
];
const PINNED = {
  "first word": "pinzz w0 w1 w2 w3 w4 w5 w6 w7 w8 w9 w10 w11 w12 w13 w14 w15 w16 w17 w18 w19 w20 w21 w22 w23 w24 w25 w26 w27 w28 w29 w30 w31 w32 w33 w34 w35 w36 w37 w38 … ",
  "last word": " … w62 w63 w64 w65 w66 w67 w68 w69 w70 w71 w72 w73 w74 w75 w76 w77 w78 w79 w80 w81 w82 w83 w84 w85 w86 w87 w88 w89 w90 w91 w92 w93 w94 w95 w96 w97 w98 w99 pinzz tail.",
  "sentence start": "w0, w1, w2, w3, w4, w5, w6, w7, w8, w9, w10, w11, w12, w13, w14, w15, w16, w17, w18, w19, w20, w21, w22, w23, w24, w25, w26, w27, w28, w29 pinzz v0 v1 v2 v3 v4 v5 v6 v7 v8 … ",
  "short": "Short pinzz doc.",
  "leading space": "  lead space, pinzz. Then x y.  ",
  "near start": "w0 w1 w2 w3 w4 w5 w6 w7 w8 w9 pinzz v0 v1 v2 v3 v4 v5 v6 v7 v8 v9 v10 v11 v12 v13 v14 v15 v16 v17 v18 v19 v20 v21 v22 v23 v24 v25 v26 v27 v28 … ",
  "middle": " … w81 w82 w83 w84 w85 w86 w87 w88 w89 w90 w91 w92 w93 w94 w95 w96 w97 w98 w99 pinzz pinyy v0 v1 v2 v3 v4 v5 v6 v7 v8 v9 v10 v11 v12 v13 v14 v15 v16 v17 v18 … ",
  "two words": " … w86 w87 w88 w89 w90 w91 w92 w93 w94 w95 w96 w97 w98 w99 pinyy v0 v1 v2 v3 v4 v5 v6 v7 v8 v9 pinzz u0 u1 u2 u3 u4 u5 u6 u7 u8 u9 u10 u11 u12 u13 … ",
  "accent fold": "Notes on the café menu. w0 w1 w2 w3 w4 w5 w6 w7 w8 w9 w10 w11 w12 w13 w14 w15 w16 w17 w18 w19 w20 w21 w22 w23 w24 w25 w26 w27 w28 w29 w30 w31 w32 w33 w34 … ",
  "markdown": "# Heading\n\nSome *pinmd* text with [a link](https://example.com/x).\n\n- item one\n- item two",
};

test("ordinary small documents keep their excerpts", async () => {
  const actual = {};
  for (const [name, body, query] of SMALL) {
    const id = await create("excerpt-small", "Small " + name, body);
    const { r } = await search({ query, project_ids: "excerpt-small" });
    const hit = ok(r).results.find((x) => x.artifact_id === id);
    assert.ok(hit, name);
    actual[name] = hit.snippet;
  }
  console.log("EXCERPTS", JSON.stringify(actual));
  assert.deepEqual(actual, PINNED);
});

test("a 1 MiB document of one repeated word is found quickly with a bounded excerpt", async () => {
  const id = await create("excerpt-big", "Repeated word", mibOf("qx"));
  const { r, ms } = await search({ query: "qx", project_ids: "excerpt-big" });
  console.log("BIG_ONE_MS", Math.round(ms));
  const hit = ok(r).results.find((x) => x.artifact_id === id);
  assert.ok(hit);
  assert.ok(ms < BOUND_MS, `took ${ms} ms`);
  assert.match(hit.snippet, /^qx( qx)+ … $/);
  assert.ok(hit.snippet.length <= 500);
});

test("a full page of 1 MiB repeated-word documents stays bounded; legacy MCP uses the same service", async () => {
  const ids = [];
  for (let i = 0; i < 20; i++) ids.push(await create("excerpt-page", "Page doc " + i, mibOf("qy")));
  const { r, ms } = await search({ query: "qy", project_ids: "excerpt-page", limit: 20 });
  console.log("BIG_PAGE_MS", Math.round(ms));
  const body = ok(r);
  assert.ok(ms < BOUND_MS, `took ${ms} ms`);
  assert.equal(body.results.length, 20);
  assert.deepEqual(new Set(body.results.map((x) => x.artifact_id)), new Set(ids));
  for (const hit of body.results) assert.match(hit.snippet, /^qy( qy)+ … $/);
  const g = await grant(owner, "excerpt-page", "excerpt page reader", false), m = await mcpClient(APP, g.token);
  try {
    const t = performance.now();
    const res = await m.call("search_artifacts", { query: "qy", limit: 20 });
    const mcpMs = performance.now() - t;
    console.log("BIG_PAGE_MCP_MS", Math.round(mcpMs));
    assert.equal(res.isError, false, JSON.stringify(res));
    assert.ok(mcpMs < BOUND_MS, `MCP took ${mcpMs} ms`);
    assert.deepEqual(res.data.results.map((x) => x.artifact_id), body.results.map((x) => x.artifact_id));
    assert.deepEqual(res.data.results.map((x) => x.snippet), body.results.map((x) => x.snippet));
  } finally { await m.close(); }
});

test("a word only late in a large document is still found; the excerpt does not pretend to show it", async () => {
  const head = "Opening line of the record. " + words("w", 20000) + " ";
  const id = await create("excerpt-late", "Late word", head + "latezq closing.");
  const { r } = await search({ query: "latezq", project_ids: "excerpt-late" });
  const hit = ok(r).results.find((x) => x.artifact_id === id);
  assert.ok(hit);
  assert.ok(hit.snippet.length <= 500);
  // Either the excerpt contains the word, or it is the plain start of the text.
  if (!hit.snippet.includes("latezq")) assert.ok(hit.snippet.startsWith("Opening line of the record."), hit.snippet);
});
