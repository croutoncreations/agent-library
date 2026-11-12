// Slice 3b, encrypted binary file versions, in real workerd. Two servers, one after the other on the same port:
// 1. design test 1, the probe. The probe Worker
// (test/fixtures/workerd-encryption-probe.mjs) runs the real crypto/chunked.js against the local R2 binding; each
// workerd behaviour the encrypted PUT and read paths rely on is its own assertion, with the observed value in the
// failure message. Synthetic random bytes and keys only, generated inside the probe; no key material leaves it.
//
// A read that fails mid-body must fail closed: the client never gets a 200/206 whose body delivers all Content-Length
// bytes. Locally that is all (e1) gates on: wrangler dev's proxy may re-run a failed GET up to three times and answer
// 500 itself, so no Real (listener) test may count R2 requests on a read that fails mid-body; such counts belong in
// World tests (test/upload-world.mjs), which have no proxy. Whether production workerd aborts the body mid-stream is
// checked on a deployed Worker, not here.
// 2. the shipped Worker with synthetic content-master-key settings (random bytes generated here, passed as --var,
//    never printed) and CONTENT_ENCRYPTION_REQUIRED "1": design tests 2, 3, 9, 17 and 23 (Real parts).
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer, ROOT, LOCAL_CONFIG, sha256 } from "./helpers.mjs";
import { startAppConnectServer } from "./fixtures/app-connect-harness.mjs";
import { makePng } from "./make-fixtures.mjs";
import { SERVER_PORTS } from "./ports.mjs";
import { buildWorker } from "../scripts/build.mjs";

const PORT = SERVER_PORTS["encryption-files"];
let probe;
const get = async (path) => {
  const r = await fetch(probe.base + path);
  const body = await r.json();
  assert.equal(r.status, 200, `probe ${path} failed: ${JSON.stringify(body)}`);
  return body;
};
const seen = (v) => JSON.stringify(v);

describe("probe (design test 1)", () => {
  before(async () => {
    const out = join(ROOT, "tmp", "test-worker-encryption-probe", "index.js");
    await buildWorker({ entry: join(ROOT, "test/fixtures/workerd-encryption-probe.mjs"), outfile: out });
    probe = await startServer("encryption-files", PORT, { worker: out, vars: {} });
  });
  after(async () => { await probe?.stop(); });

  test("probe (a): crypto.DigestStream over chunked writes, and plainTap's copy-enqueue-hash order", async () => {
    const r = await get("/probe/a");
    assert.equal(r.digestStreamHex, r.expected, `DigestStream over chunked writes: ${seen(r)}`);
    assert.equal(r.tapSha256, r.expected, `plainTap's SHA-256: ${seen(r)}`);
    assert.equal(r.tapCount, 200_000, `plainTap's count: ${seen(r)}`);
    assert.equal(r.storedLength, r.expectedStoredLength, `encryptor output length: ${seen(r)}`);
    assert.equal(r.roundTrip, true, `encryptor input intact after plainTap (decrypts to the original): ${seen(r)}`);
  });

  test("probe (b): a pull-driven encryptor through FixedLengthStream(chunkedStoredLength) into BLOBS.put", async () => {
    const r = await get("/probe/b");
    assert.equal(r.putSize, r.expectedStoredLength, `put() size: ${seen(r)}`);
    assert.equal(r.headSize, r.expectedStoredLength, `head() size: ${seen(r)}`);
    assert.equal(r.decrypts, true, `stored object decrypts to the original: ${seen(r)}`);
  });

  for (const size of [1, 65_536]) {
    test(`probe (c): a plainTap flush throw (wrong SHA-256) at ${size} bytes makes put reject and stores nothing`, async () => {
      const r = await get(`/probe/c?size=${size}`);
      assert.equal(r.mismatchFlag, true, `plainTap flagged the mismatch: ${seen(r)}`);
      assert.equal(r.putRejected, true, `put() rejected: ${seen(r)}`);
      assert.equal(r.headIsNull, true, `head() after the rejected put is null: ${seen(r)}`);
    });
  }

  test("probe (d): a ranged get returns customMetadata and the whole-object size", async () => {
    const r = await get("/probe/d");
    assert.deepEqual(r.customMetadata, { "al-enc": "1", "al-key": "key_probe" }, `ranged get customMetadata: ${seen(r)}`);
    assert.equal(r.size, 100_000, `ranged get size is the whole object's: ${seen(r)}`);
    assert.equal(r.bodyLength, 100, `ranged get body length: ${seen(r)}`);
  });

  /** Fetch the erroring body and read it to the end or the first error; reports what the client saw. */
  async function readErroring(query) {
    const r = await fetch(probe.base + "/probe/e?" + query);
    const declared = r.headers.get("content-length") === null ? null : Number(r.headers.get("content-length"));
    let received = 0, error = null;
    try {
      const reader = r.body.getReader();
      for (;;) { const { done, value } = await reader.read(); if (done) break; received += value.byteLength; }
    } catch (e) { error = `${e.name}: ${e.message}${e.cause ? ` (cause: ${e.cause.message ?? e.cause})` : ""}`; }
    return { status: r.status, declared, received, readRejected: error !== null, error };
  }

  /**
   * Fail closed: a 5xx in place of the response, or a 200/206 that declares the expected Content-Length and whose body
   * read rejects. A 200/206 whose body ends cleanly fails the gate whatever its byte count, and so does one without the
   * expected Content-Length (a clean short end could not be told from a complete one).
   */
  function assertFailClosed(o, label) {
    if (o.status >= 500) return;
    assert.ok(o.status === 200 || o.status === 206, `${label}: unexpected status: ${seen(o)}`);
    assert.equal(o.declared, 300_000, `${label}: a 200/206 must declare the expected Content-Length: ${seen(o)}`);
    assert.equal(o.readRejected, true, `${label}: a 200/206 body must reject, never end cleanly: ${seen(o)}`);
    assert.ok(o.received < o.declared, `${label}: fewer bytes than Content-Length: ${seen(o)}`);
  }

  test("probe (e1): a response body that errors after its first chunk fails closed (never a complete 200/206)", async () => {
    const id = `e1-${Date.now()}`;
    const o = await readErroring(`id=${id}`);
    assertFailClosed(o, "e1");
    const { invocations } = await get(`/probe/e-count?id=${id}`);
    console.log(`probe (e1) observed: ${seen({ ...o, invocations })}`);
  });

  test("probe (e2), information only: the same body erroring 500 ms after the first chunk, and how often the handler ran", async () => {
    const id = `e2-${Date.now()}`;
    const o = await readErroring(`id=${id}&delay=500`);
    const { invocations } = await get(`/probe/e-count?id=${id}`);
    console.log(`probe (e2) observed: ${seen({ ...o, invocations })}`);
    // The exact status, byte count and invocation count are information; failing closed is required here too.
    assertFailClosed(o, "e2");
  });

  test("probe (f), information only: does an R2 conditional put (onlyIf) refuse to overwrite an existing object", async () => {
    const r = await get("/probe/f");
    console.log(`probe (f) observed: ${seen(r)}`);
    assert.equal(typeof r.firstPutOnNewKey, "string", seen(r));
  });
});

describe("shipped Worker with synthetic encryption settings (design tests 2, 3, 9, 17, 23: Real parts)", () => {
  let h, owner, agent;
  const PID = "enc-files";
  const sql = async (q) => JSON.parse((await promisify(execFile)("wrangler", ["d1", "--config", LOCAL_CONFIG, "execute", "DB", "--local", "--persist-to", h.dir, "--json", "--command", q], { cwd: ROOT, env: { ...process.env, CI: "1", NO_COLOR: "1" } })).stdout)[0].results;
  const pngOf = (n) => { const b = randomBytes(n); makePng(4, 4).copy(b, 0, 0, 16); return b; };
  async function upload(bytes, extra = {}) {
    const b = await owner.req("POST", `/api/projects/${PID}/uploads`, { title: "Synthetic.png", mime: "image/png", size: bytes.length, sha256: sha256(bytes), ...extra });
    assert.equal(b.status, 201, JSON.stringify(b.body));
    const p = await owner.req("PUT", b.body.put_url, undefined, { raw: bytes, idem: false });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    return { upload: b.body.upload_id, finish: () => owner.req("POST", `/api/projects/${PID}/uploads/${b.body.upload_id}/finish`, {}) };
  }
  before(async () => {
    h = await startAppConnectServer({ port: PORT, vars: {
      CONTENT_MASTER_KEY_VERSION: "1", CONTENT_MASTER_KEY_V1: randomBytes(32).toString("base64"), CONTENT_ENCRYPTION_REQUIRED: "1",
      PROJECT_BINARY_BYTES: "0", FILE_MAX_BYTES: String(8 * 1024 * 1024) } });
    owner = await h.owner();
    assert.equal((await owner.req("POST", "/api/projects", { id: PID, title: "Encrypted files" })).status, 201);
    agent = await h.connectMcpAgent({ [PID]: "write" }, { clientName: "Synthetic encrypted" });
  });
  after(async () => { await h?.stop(); });

  test("design test 2 and 3 (Real): a 3.5-chunk PNG upload reads back identically, whole and by Range", async () => {
    const bytes = pngOf(Math.floor(3.5 * 65536));
    const u = await upload(bytes);
    const f = await u.finish();
    assert.equal(f.status, 200, JSON.stringify(f.body));
    const [row] = await sql(`SELECT blob_key_id, blob_header FROM revisions WHERE artifact_id = '${f.body.artifact_id}'`);
    assert.match(row.blob_key_id, /^wk_/, "stored encrypted");
    const url = `/api/projects/${PID}/artifacts/${f.body.artifact_id}/content`;
    const whole = await owner.req("GET", url, undefined, { binary: true });
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get("content-length"), String(bytes.length));
    assert.ok(whole.body.equals(bytes));
    const n = bytes.length;
    for (const [spec, start, end] of [["0-0", 0, 0], ["65535-65536", 65535, 65536], ["65536-65551", 65536, 65551], [`${n - 1}-${n - 1}`, n - 1, n - 1], ["-100", n - 100, n - 1], ["1000-140000", 1000, 140000]]) {
      const r = await owner.req("GET", url, undefined, { binary: true, headers: { range: `bytes=${spec}` } });
      assert.equal(r.status, 206, spec);
      assert.equal(r.headers.get("content-range"), `bytes ${start}-${end}/${n}`, spec);
      assert.ok(r.body.equals(bytes.subarray(start, end + 1)), spec);
    }
  });

  test("design test 9 and 17 (Real, HTTP): after a shred, finish answers 410 key_shredded (upload failed), and restoring an encrypted version answers 410 with no new revision", async () => {
    const v1 = pngOf(3000), v2 = pngOf(4000);
    const f1 = await (await upload(v1)).finish();
    assert.equal(f1.status, 200, JSON.stringify(f1.body));
    const art = f1.body.artifact_id;
    const u2 = await upload(v2, { artifact_id: art, expected_revision: 1, title: undefined });
    const f2 = await u2.finish();
    assert.equal(f2.status, 200, JSON.stringify(f2.body));
    const pending = await upload(pngOf(2000));
    // Shred the workspace key exactly as shredWorkspaceKeys does (local D1 only; synthetic data).
    const now = Date.now();
    const [p] = await sql(`SELECT COALESCE(workspace_id, 'wsp_' || owner_id) AS w FROM projects WHERE id = '${PID}'`);
    await sql(`UPDATE workspace_keys SET shredded_at = COALESCE(shredded_at, ${now}), wrapped = '' WHERE workspace_id = '${p.w}'`);
    const fin = await pending.finish();
    assert.deepEqual([fin.status, fin.body?.error?.code], [410, "key_shredded"], JSON.stringify(fin.body));
    const [up] = await sql(`SELECT state FROM uploads WHERE id = '${pending.upload}'`);
    assert.equal(up.state, "failed");
    const r = await owner.req("POST", `/api/projects/${PID}/artifacts/${art}/restore`, { from_revision: 1, expected_revision: 2 });
    assert.deepEqual([r.status, r.body?.error?.code], [410, "key_shredded"], JSON.stringify(r.body));
    const [{ n }] = await sql(`SELECT COUNT(*) AS n FROM revisions WHERE artifact_id = '${art}'`);
    assert.equal(n, 2, "no new revision");
    const read = await owner.req("GET", `/api/projects/${PID}/artifacts/${art}/content`, undefined, { binary: true });
    assert.equal(read.status, 410);
  });
});

describe("official MCP SDK client over OAuth with encryption on (design test 23)", () => {
  let h, sdk;
  const PID = "enc-mcp";
  before(async () => {
    h = await startAppConnectServer({ port: PORT, vars: {
      CONTENT_MASTER_KEY_VERSION: "1", CONTENT_MASTER_KEY_V1: randomBytes(32).toString("base64"), CONTENT_ENCRYPTION_REQUIRED: "1", PROJECT_BINARY_BYTES: "0" } });
    const owner = await h.owner();
    assert.equal((await owner.req("POST", "/api/projects", { id: PID, title: "Encrypted MCP" })).status, 201);
    const rw = await h.connectMcpAgent({ [PID]: "write" }, { clientName: "Synthetic SDK" });
    sdk = new Client({ name: "synthetic-sdk", version: "1.0" });
    await sdk.connect(new StreamableHTTPClientTransport(new URL(`${h.issuer}/mcp`), { requestInit: { headers: { authorization: `Bearer ${rw.access_token}` } } }));
  });
  after(async () => { await sdk?.close(); await h?.stop(); });

  test("upload_file an inline PNG, then read_file returns it inline", async () => {
    const png = makePng(12, 12);
    const made = await sdk.callTool({ name: "upload_file", arguments: { project_id: PID, title: "Inline.png", mime: "image/png", content_base64: png.toString("base64"), change_note: "Synthetic inline image", idempotency_key: "uf-" + randomBytes(6).toString("hex") } });
    assert.equal(made.isError, false, JSON.stringify(made.structuredContent));
    const rd = await sdk.callTool({ name: "read_file", arguments: { project_id: PID, artifact_id: made.structuredContent.artifact_id } });
    assert.equal(rd.isError, false, JSON.stringify(rd.structuredContent));
    const img = rd.content.find((c) => c.type === "image");
    assert.ok(Buffer.from(img.data, "base64").equals(png));
  });
});

describe("backup round trip across installations (design test 18, Real)", () => {
  // Installation A has no encryption; B has synthetic key settings. They run one after the other on the same port.
  const PID = "enc-backup-src";
  let exported, bytes, sourceBlobKey;
  test("export from A (plaintext) carries no encryption columns; import into B encrypts under B's key and downloads identically; A is unchanged", async () => {
    const a = await startAppConnectServer({ port: PORT, vars: { PROJECT_BINARY_BYTES: "0" } });
    try {
      const owner = await a.owner();
      assert.equal((await owner.req("POST", "/api/projects", { id: PID, title: "Backup source" })).status, 201);
      bytes = Buffer.concat([makePng(6, 6), randomBytes(70_000)]);
      const b = await owner.req("POST", `/api/projects/${PID}/uploads`, { title: "Round trip.png", mime: "image/png", size: bytes.length, sha256: sha256(bytes) });
      assert.equal(b.status, 201, JSON.stringify(b.body));
      assert.equal((await owner.req("PUT", b.body.put_url, undefined, { raw: bytes, idem: false })).status, 200);
      const f = await owner.req("POST", `/api/projects/${PID}/uploads/${b.body.upload_id}/finish`, {});
      assert.equal(f.status, 200, JSON.stringify(f.body));
      const e = await owner.req("GET", `/api/projects/${PID}/backup`);
      assert.equal(e.status, 200);
      exported = e.body;
      assert.ok(exported.revisions.every((r) => !("blob_key_id" in r) && !("blob_header" in r)), "no encryption columns in a backup");
      sourceBlobKey = exported.revisions.find((r) => r.blob_key).blob_key;
      assert.ok(Buffer.from(exported.blobs[sourceBlobKey].data, "base64").equals(bytes), "blobs are plaintext");
      const again = await owner.req("GET", `/api/projects/${PID}/artifacts/${f.body.artifact_id}/content`, undefined, { binary: true });
      assert.ok(again.body.equals(bytes), "A unchanged");
    } finally { await a.stop(); }
    const b = await startAppConnectServer({ port: PORT, vars: {
      CONTENT_MASTER_KEY_VERSION: "1", CONTENT_MASTER_KEY_V1: randomBytes(32).toString("base64"), CONTENT_ENCRYPTION_REQUIRED: "1", PROJECT_BINARY_BYTES: "0" } });
    try {
      const owner = await b.owner();
      const me = await owner.req("GET", "/api/me");
      const wid = `wsp_${me.body.principal.id}`; // the owner's personal workspace (migration 0017's trigger)
      const imp = await owner.req("POST", `/api/workspaces/${wid}/import`, exported);
      assert.equal(imp.status, 201, JSON.stringify(imp.body));
      const sql = async (q) => JSON.parse((await promisify(execFile)("wrangler", ["d1", "--config", LOCAL_CONFIG, "execute", "DB", "--local", "--persist-to", b.dir, "--json", "--command", q], { cwd: ROOT, env: { ...process.env, CI: "1", NO_COLOR: "1" } })).stdout)[0].results;
      const [row] = await sql(`SELECT r.artifact_id, r.blob_key_id, k.workspace_id FROM revisions r JOIN workspace_keys k ON k.key_id = r.blob_key_id WHERE r.project_id = '${imp.body.project_id}'`);
      assert.ok(row, "the imported version is encrypted under a key of B");
      assert.equal(row.workspace_id, wid);
      const d = await owner.req("GET", `/api/projects/${imp.body.project_id}/artifacts/${row.artifact_id}/content`, undefined, { binary: true });
      assert.equal(d.status, 200);
      assert.ok(d.body.equals(bytes), "identical download");
    } finally { await b.stop(); }
  });
});
