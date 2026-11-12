// Blind-index search tokens (slice 4a, Part 2): a restore on local D1 (wrangler dev, an empty store, port
// SERVER_PORTS["blind-tokens-restore"]) whose documents carry odd ids. D1 stores the number 7 as "7.0" and a byte list as
// a BLOB: the numeric document is indexed under its stored form, the byte-list one alone gets no job, the ordinary
// ones are indexed, and the response is unchanged. Rows are polled with a deadline, never a fixed sleep. Synthetic data.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startServer, LOCAL_CONFIG, ROOT } from "./helpers.mjs";
import { SERVER_PORTS } from "./ports.mjs";

let h;
const d1 = async (q) => JSON.parse((await promisify(execFile)("wrangler", ["d1", "--config", LOCAL_CONFIG, "execute", "DB", "--local", "--persist-to", h.dir, "--json", "--command", q],
  { cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })).stdout)[0].results;
before(async () => { h = await startServer("blind-tokens-restore", SERVER_PORTS["blind-tokens-restore"]); });
after(async () => { await h?.stop(); });

test("restore (local D1): numeric id indexed under \"7.0\", byte-list id skipped alone, ordinary ids indexed; response unchanged", async () => {
  const s = await h.login();
  const at = "2026-01-01T00:00:00.000Z";
  const sha = (t) => createHash("sha256").update(t).digest("hex");
  const entries = [{ id: 7, rev: 8, text: "numeric words" }, { id: [100, 111, 99], rev: "rev_bytes", text: "byte list words" },
    { id: "doc_a", rev: "rev_a", text: "ordinary alpha" }, { id: "doc_b", rev: "rev_b", text: "ordinary beta" }];
  const backup = { schema: "agent-library-backup/1", exported_at: at, project: { id: "podd_d1", title: "Synthetic", created_at: at },
    artifacts: entries.map(({ id, rev }) => ({ id, kind: "markdown", title: "Synthetic", folder: "", tags: "[]", head_rev: 1, head_revision_id: rev, meta_version: 1, trashed_at: null, created_at: at, updated_at: at })),
    revisions: entries.map(({ id, rev, text }) => ({ id: rev, artifact_id: id, rev_no: 1, author_id: "hum_src", body: text, blob_key: null, size: Buffer.byteLength(text), sha256: sha(text), mime: "text/markdown", restored_from: null, created_at: at })),
    comments: [], meta_versions: [], blobs: {} };
  const r = await s.req("POST", "/api/restore", backup);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body, { restored_project: "podd_d1", artifacts: 4, revisions: 4, blobs: 0, grants: 0 });
  const heads = await d1("SELECT id, typeof(id) AS ty, head_revision_id AS h FROM artifacts ORDER BY id");
  assert.ok(heads.some((x) => x.id === "7.0" && x.h === "8.0"), JSON.stringify(heads));
  const want = ["7.0", "doc_a", "doc_b"];
  const end = Date.now() + 20000;
  let rows;
  for (;;) {
    rows = await d1("SELECT d.artifact_id AS a, typeof(d.artifact_id) AS ty, d.revision_id = x.head_revision_id AS done FROM search_token_docs d JOIN artifacts x ON x.id = d.artifact_id ORDER BY d.artifact_id");
    if (rows.filter((x) => x.done).length === 3) break;
    if (Date.now() > end) throw new Error("not indexed: " + JSON.stringify(rows));
    await new Promise((x) => setTimeout(x, 100));
  }
  assert.deepEqual(rows.map((x) => x.a), want, "no row for the byte-list document");
  const secret = Buffer.from((await d1("SELECT secret FROM workspace_search_keys"))[0].secret, "base64url");
  const tok = (t) => createHmac("sha256", secret).update(t).digest().subarray(0, 16).toString("hex");
  const got = (await d1("SELECT lower(hex(s.token)) AS t FROM search_tokens s JOIN search_token_docs d ON d.doc_id = s.doc_id WHERE d.artifact_id = '7.0' ORDER BY s.token")).map((x) => x.t);
  assert.deepEqual(got, ["numeric", "words"].map(tok).sort());
  const missing = (await d1("SELECT id, typeof(id) AS ty FROM search_tokens_missing"));
  assert.deepEqual(missing.map((x) => x.ty), ["blob"], "the byte-list document alone is missing: " + JSON.stringify(missing));
});
