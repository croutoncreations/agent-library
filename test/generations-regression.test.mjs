// Targeted regressions for staged publisher generations (agentlib.generations/1). Synthetic loopback only:
// in-memory owner/app/publisher credentials, disposable local D1. Uses AC_TEST_HOOKS clock/quota headers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { startAppConnectServer } from "./fixtures/app-connect-harness.mjs";
import { SERVER_PORTS } from "./ports.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const bytes = (s) => Buffer.byteLength(s, "utf8");
const H25 = { "x-test-clock-offset-ms": String(25 * 3600_000) };

/** Builds root(index) -> [payloads...] (+ optional extra unreferenced parts / tampering). */
const FMT = { index: "agentlib.generation.index/1", part: "agentlib.generation.part/1" };
const LEGACY_FMT = { index: "healthconnect.readable.index/1", part: "healthconnect.readable.part/1" };
function gen(gid, rev, parent, { payloads = 1, extra = [], mutateRoot, rootAsPart = false, fmt = FMT } = {}) {
  const files = [];
  for (let i = 0; i < payloads; i++) {
    const content = JSON.stringify({ format: fmt.part, schema: "example.export/1", generation_id: gid, source_revision: rev,
      stream: "step_samples", kind: "step_samples", records: [{ i, note: "синтетика 🌙" }] });
    files.push({ name: `${gid}-hr-${i}.json`, content });
  }
  let rootDoc = { format: rootAsPart ? fmt.part : fmt.index, generation_id: gid, source_revision: rev,
    coverage: { from: "2026-10-01T00:00:00Z", to: "2026-10-02T00:00:00Z" }, source_scopes: ["synthetic"],
    entries: files.map((f) => ({ name: f.name, sha256: sha(f.content), bytes: bytes(f.content), kind: "step_samples", count: 1, file: f.name, utf8_bytes: bytes(f.content) })) };
  if (mutateRoot) rootDoc = mutateRoot(rootDoc);
  const root = JSON.stringify(rootDoc);
  const all = [...files, ...extra, { name: `${gid}-root.json`, content: root }];
  return { begin: { generation_id: gid, source_revision: rev, expected_current_snapshot_id: parent, root_name: `${gid}-root.json`, root_sha256: sha(root),
    part_count: all.length, total_bytes: all.reduce((n, f) => n + bytes(f.content), 0), coverage: rootDoc.coverage, exported_at: "2026-10-02T00:00:00Z" }, files: all };
}

test("generation regressions: TTL scope, committed retention, auth/epoch, closure, quota, replay", { timeout: 600_000 }, async () => {
  const h = await startAppConnectServer({ port: SERVER_PORTS.generations });
  try {
    const owner = await h.owner();
    assert.equal((await owner.req("POST", "/api/projects", { id: "gen-regress", title: "Gen regress" })).status, 201);
    const app = await h.registerApp({ display_name: "Gen regress A", redirect_uris: ["https://publisher.example.test/agent-library/callback"], origins: [] });
    const A = await h.connectPublisher(app, { project_id: "gen-regress", destination: "new", new_folder_name: "Regress A", resume: "new" });
    const appB = await h.registerApp({ display_name: "Gen regress B", redirect_uris: ["https://publisher.example.test/agent-library/callback-b"], origins: [] });
    const B = await h.connectPublisher(appB, { project_id: "gen-regress", destination: "new", new_folder_name: "Regress B", resume: "new" });
    let tokA = A.access_token;
    const call = (tok, method, path, body, { idem, headers } = {}) => h.pub(tok, method, path, { body, idem: idem ?? (method === "POST" ? "k-" + Math.random().toString(36).slice(2, 12) : undefined), headers });
    const begin = (tok, g, opt) => call(tok, "POST", "/publisher/generations", g.begin, opt);
    const putAll = async (tok, g, opt) => { for (const f of g.files) { const r = await call(tok, "PUT", `/publisher/generations/${g.begin.generation_id}/parts/${f.name}`, { content: f.content, sha256: sha(f.content) }, opt); assert.ok([200, 201].includes(r.status), `${f.name} ${r.status} ${r.text}`); } };
    const commit = (tok, gid, opt) => call(tok, "POST", `/publisher/generations/${gid}/commit`, {}, opt);
    const current = async (tok = tokA) => (await call(tok, "GET", "/publisher/snapshots/current")).json.snapshot;
    const fileNames = async (tok = tokA) => (await call(tok, "GET", "/publisher/files")).json.files.map((f) => f.name);

    const me = (await call(tokA, "GET", "/publisher/me")).json;
    assert.equal(me.generation_contract.max_part_bytes, 32768);
    assert.equal(me.generation_contract.max_parts, 2048);
    assert.equal(me.generation_contract.max_staged_generations, 2);
    assert.equal(me.generation_contract.auto_prune_committed, false);
    assert.equal(me.generation_contract.index_format, FMT.index);
    assert.equal(me.generation_contract.part_format, FMT.part);

    // --- 1. Commit g1; staged parts invisible until commit.
    const g1 = gen("g_reg_one", 1, null, { payloads: 3 });
    assert.equal((await begin(tokA, g1)).status, 201);
    await putAll(tokA, g1);
    assert.deepEqual(await fileNames(), [], "staged parts must not be visible as artifacts");
    assert.equal((await owner.req("GET", "/api/search?query=" + encodeURIComponent("синтетика"))).body.results.length, 0, "staged generation text is not searchable");
    const c1 = await commit(tokA, "g_reg_one", { idem: "commit-g1" });
    assert.equal(c1.status, 201, c1.text);
    assert.equal((await owner.req("GET", "/api/search?query=" + encodeURIComponent("синтетика"))).body.results.length, 3, "committed generation payloads are indexed atomically");
    const r1 = c1.json.snapshot;
    assert.equal(r1.publisher_id, A.publisher_id); assert.equal(r1.source_revision, 1); assert.ok(r1.snapshot_id.startsWith("snp_"));
    assert.equal(r1.files.length, 4);
    for (const f of g1.files) { const a = r1.files.find((x) => x.name === f.name); assert.equal(a.kind, "json"); assert.equal(a.sha256, sha(f.content)); }
    const manifest = await call(tokA, "GET", `/publisher/files/${r1.manifest.file_id}/content`);
    assert.equal(manifest.status, 200); assert.ok(bytes(manifest.text) <= 32768);
    assert.equal(JSON.parse(manifest.text).root.sha256, g1.begin.root_sha256);
    assert.ok(!("files" in JSON.parse(manifest.text)), "server manifest is a small root reference, not a file list");
    // Version history: generation parts and the manifest record the publishing app (docs/version-history.md).
    for (const fid of [r1.manifest.file_id, r1.files[0].file_id]) {
      const v = (await owner.req("GET", `/api/projects/gen-regress/artifacts/${fid}/history`)).body.revisions[0];
      assert.deepEqual([v.via.kind, v.via.id, v.via.label, v.who], ["publisher", A.publisher_id, "Gen regress A", "Gen regress A"], fid);
    }

    // --- 1b. The original (pre-rename) format names stay valid for existing exporters, on a separate publisher.
    const appC = await h.registerApp({ display_name: "Gen regress legacy", redirect_uris: ["https://publisher.example.test/agent-library/callback-c"], origins: [] });
    const C = await h.connectPublisher(appC, { project_id: "gen-regress", destination: "new", new_folder_name: "Regress legacy", resume: "new" });
    const gl = gen("g_reg_legacy", 1, null, { payloads: 2, fmt: LEGACY_FMT });
    assert.equal((await begin(C.access_token, gl)).status, 201);
    await putAll(C.access_token, gl);
    const cl = await commit(C.access_token, "g_reg_legacy");
    assert.equal(cl.status, 201, cl.text);
    assert.equal(cl.json.snapshot.files.length, 3);
    // Mixing names inside one generation is fine too (both are accepted per document).
    const gm = gen("g_reg_mixed", 2, cl.json.snapshot.snapshot_id, { payloads: 1, fmt: { index: LEGACY_FMT.index, part: FMT.part } });
    assert.equal((await begin(C.access_token, gm)).status, 201);
    await putAll(C.access_token, gm);
    assert.equal((await commit(C.access_token, "g_reg_mixed")).status, 201);

    // --- 2. Stale expected pointer: begin with expected=null after a commit exists -> 409, pointer kept, nothing visible.
    const stale = gen("g_reg_stale", 2, null);
    assert.equal((await begin(tokA, stale)).status, 201); await putAll(tokA, stale);
    const sc = await commit(tokA, "g_reg_stale");
    assert.equal(sc.status, 409, sc.text); assert.equal(sc.json.error.code, "stale_generation");
    assert.equal((await current()).snapshot_id, r1.snapshot_id);
    assert.ok(!(await fileNames()).some((n) => n.startsWith("g_reg_stale")));
    assert.equal((await call(tokA, "DELETE", "/publisher/generations/g_reg_stale")).status, 200);

    // --- 3. Same source_revision as current -> stale (monotonic).
    const same = gen("g_reg_samerev", 1, r1.snapshot_id);
    assert.equal((await begin(tokA, same)).status, 201); await putAll(tokA, same);
    assert.equal((await commit(tokA, "g_reg_samerev")).status, 409);
    assert.equal((await call(tokA, "DELETE", "/publisher/generations/g_reg_samerev")).status, 200);

    // --- 4. Invalid closures: each fails, pointer unchanged, nothing materialized.
    const closureCases = [
      ["unreachable extra part", gen("g_reg_unreach", 2, r1.snapshot_id, { extra: [{ name: "g_reg_unreach-orphan.json", content: JSON.stringify({ format: FMT.part, generation_id: "g_reg_unreach", source_revision: 2, records: [] }) }] }), 422],
      ["entry sha mismatch", gen("g_reg_badsha", 2, r1.snapshot_id, { mutateRoot: (d) => ({ ...d, entries: d.entries.map((e) => ({ ...e, sha256: "0".repeat(64) })) }) }), 422],
      ["entry bytes mismatch", gen("g_reg_badbytes", 2, r1.snapshot_id, { mutateRoot: (d) => ({ ...d, entries: d.entries.map((e) => ({ ...e, bytes: e.bytes + 1, utf8_bytes: e.bytes + 1 })) }) }), 422],
      ["duplicate reference", gen("g_reg_dup", 2, r1.snapshot_id, { mutateRoot: (d) => ({ ...d, entries: [...d.entries, d.entries[0]] }) }), 422],
      ["root is not an index", gen("g_reg_rootpart", 2, r1.snapshot_id, { rootAsPart: true }), 422],
      ["payload declared as index", gen("g_reg_kindlie", 2, r1.snapshot_id, { mutateRoot: (d) => ({ ...d, entries: d.entries.map((e) => ({ ...e, kind: "index" })) }) }), 422],
    ];
    // Cycle: root -> idxA -> idxB -> idxA.
    {
      const gid = "g_reg_cycle"; const rev = 2;
      const pay = JSON.stringify({ format: FMT.part, generation_id: gid, source_revision: rev, records: [] });
      // idxA and idxB reference each other; hashes must be self-consistent, so B references A's hash and A references B's.
      // That is impossible for honest hashes, so the cycle is detected through the "referenced more than once" rule:
      // idxB references idxA (already visited) with A's real hash.
      const idxA0 = { format: FMT.index, generation_id: gid, source_revision: rev, entries: [{ name: `${gid}-p.json`, sha256: sha(pay), bytes: bytes(pay), kind: "x" }] };
      const idxA = JSON.stringify(idxA0);
      const idxB = JSON.stringify({ format: FMT.index, generation_id: gid, source_revision: rev, entries: [{ name: `${gid}-a.json`, sha256: sha(idxA), bytes: bytes(idxA), kind: "index" }] });
      const root = JSON.stringify({ format: FMT.index, generation_id: gid, source_revision: rev, entries: [
        { name: `${gid}-a.json`, sha256: sha(idxA), bytes: bytes(idxA), kind: "index" }, { name: `${gid}-b.json`, sha256: sha(idxB), bytes: bytes(idxB), kind: "index" }] });
      const files = [{ name: `${gid}-p.json`, content: pay }, { name: `${gid}-a.json`, content: idxA }, { name: `${gid}-b.json`, content: idxB }, { name: `${gid}-root.json`, content: root }];
      closureCases.push(["index cycle/duplicate", { begin: { generation_id: gid, source_revision: rev, expected_current_snapshot_id: r1.snapshot_id, root_name: `${gid}-root.json`, root_sha256: sha(root),
        part_count: files.length, total_bytes: files.reduce((n, f) => n + bytes(f.content), 0), coverage: null, exported_at: null }, files }, 422]);
    }
    {
      const g = gen("g_reg_rootsha", 2, r1.snapshot_id); g.begin.root_sha256 = "a".repeat(64);
      closureCases.push(["root checksum differs from begin", g, 409]);
    }
    const filesBefore = await fileNames();
    for (const [label, g, status] of closureCases) {
      assert.equal((await begin(tokA, g)).status, 201, label);
      await putAll(tokA, g);
      const r = await commit(tokA, g.begin.generation_id);
      assert.equal(r.status, status, `${label}: ${r.text}`);
      assert.equal((await current()).snapshot_id, r1.snapshot_id, label);
      assert.deepEqual(await fileNames(), filesBefore, label);
      assert.equal((await call(tokA, "DELETE", `/publisher/generations/${g.begin.generation_id}`)).status, 200, label);
    }

    // --- 5. PUT validation on a staged generation.
    const v = gen("g_reg_put", 2, r1.snapshot_id);
    assert.equal((await begin(tokA, v)).status, 201);
    const putRaw = (name, content, hash = sha(content)) => call(tokA, "PUT", `/publisher/generations/g_reg_put/parts/${name}`, { content, sha256: hash });
    const okPart = (extra = {}) => JSON.stringify({ format: FMT.part, generation_id: "g_reg_put", source_revision: 2, records: [], ...extra });
    assert.equal((await putRaw("x.json", okPart(), "b".repeat(64))).status, 422, "hash mismatch");
    assert.equal((await putRaw("x.json", okPart({ generation_id: "g_other" }))).status, 422, "foreign generation_id");
    assert.equal((await putRaw("x.json", okPart({ source_revision: 3 }))).status, 422, "mixed source_revision");
    assert.equal((await putRaw("x.json", '{"format":FMT.part,"generation_id":"g_reg_put","source_revision":2,"v":1e999}')).status, 422, "non-finite number");
    assert.equal((await putRaw("x.json", "not json")).status, 422, "not JSON");
    const exact = okPart({ pad: "" }); const fill = 32768 - bytes(exact);
    const at = okPart({ pad: "é".repeat(Math.floor(fill / 2)) + "a".repeat(fill % 2) });
    assert.equal(bytes(at), 32768);
    assert.equal((await putRaw("at-cap.json", at)).status, 409, "32768-byte part accepted by size but exceeds this generation's declared bytes");
    const over = okPart({ pad: "é".repeat(Math.floor(fill / 2)) + "aa".repeat(1) });
    assert.ok(bytes(over) > 32768);
    assert.equal((await putRaw("over.json", over)).status, 413, "UTF-8 byte cap");
    assert.equal((await putRaw("g_reg_put.manifest.json", okPart())).status, 400, "reserved manifest name");
    assert.equal((await putRaw("n".repeat(128), okPart())).status, 201, "128-char name accepted");
    assert.equal((await putRaw("n".repeat(129), okPart())).status, 404, "129-char name rejected");
    assert.equal((await call(tokA, "DELETE", "/publisher/generations/g_reg_put")).status, 200);

    // --- 6. Staging limit: max 2 staged; third begin refused.
    const s1 = gen("g_reg_s1", 2, r1.snapshot_id), s2 = gen("g_reg_s2", 2, r1.snapshot_id), s3 = gen("g_reg_s3", 2, r1.snapshot_id);
    assert.equal((await begin(tokA, s1)).status, 201); await putAll(tokA, { files: s1.files.slice(0, 1), begin: s1.begin });
    assert.equal((await begin(tokA, s2)).status, 201);
    const third = await begin(tokA, s3); assert.equal(third.status, 409); assert.equal(third.json.error.code, "too_many_staged_generations");
    // Metadata immutable on retry.
    assert.equal((await begin(tokA, { begin: { ...s1.begin, total_bytes: s1.begin.total_bytes + 1 } })).status, 409);
    assert.equal((await begin(tokA, s1)).status, 200, "exact begin retry replays");

    // --- 7. TTL cleanup is scope bound and never deletes committed data.
    // Publisher B triggers cleanup at +25h: A's expired staging must survive (other publisher).
    const bg = gen("g_reg_b1", 1, null);
    assert.equal((await begin(B.access_token, bg, { headers: H25 })).status, 201);
    assert.equal((await call(tokA, "GET", "/publisher/generations/g_reg_s1")).json.uploaded_parts, 1, "B's cleanup must not touch A's staging");
    assert.equal((await call(B.access_token, "GET", "/publisher/generations/g_reg_s1")).status, 404, "cross-publisher generation is invisible");
    assert.equal((await call(B.access_token, "DELETE", "/publisher/generations/g_reg_s1")).status, 404, "cross-publisher delete refused");
    assert.equal((await call(B.access_token, "GET", "/publisher/generations/g_reg_one")).status, 404);
    // Expired staged generation: PUT/commit refused at +25h.
    const expiredPut = await call(tokA, "PUT", `/publisher/generations/g_reg_s1/parts/${s1.files[1].name}`, { content: s1.files[1].content, sha256: sha(s1.files[1].content) }, { headers: H25 });
    assert.equal(expiredPut.status, 409);
    assert.equal((await commit(tokA, "g_reg_s1", { headers: H25 })).status, 409);
    // A's own cleanup at +25h (via begin) removes only its expired staging; committed g1 stays intact.
    const s4 = gen("g_reg_s4", 2, r1.snapshot_id);
    assert.equal((await begin(tokA, s4, { headers: H25 })).status, 201);
    assert.equal((await call(tokA, "GET", "/publisher/generations/g_reg_s1")).status, 404, "expired staging cleaned");
    assert.equal((await call(tokA, "GET", "/publisher/generations/g_reg_s2")).status, 404, "expired staging cleaned");
    const kept = await call(tokA, "GET", "/publisher/generations/g_reg_one");
    assert.equal(kept.status, 200); assert.equal(kept.json.state, "committed"); assert.equal(kept.json.parts.length, 4);
    assert.ok(kept.json.parts.every((x) => x.file_id), "committed part receipts retained");
    for (const f of g1.files) {
      const a = r1.files.find((x) => x.name === f.name);
      const got = await call(tokA, "GET", `/publisher/files/${a.file_id}/content`);
      assert.equal(got.status, 200); assert.equal(got.text, f.content);
    }
    // Committed: exact PUT/begin/commit retries still succeed; DELETE refused.
    assert.equal((await begin(tokA, g1, { headers: H25 })).status, 200);
    const rePut = await call(tokA, "PUT", `/publisher/generations/g_reg_one/parts/${g1.files[0].name}`, { content: g1.files[0].content, sha256: sha(g1.files[0].content) }, { headers: H25 });
    assert.equal(rePut.status, 200, rePut.text);
    assert.equal((await call(tokA, "DELETE", "/publisher/generations/g_reg_one")).status, 409);

    // --- 7b. Exact begin retry after TTL restages the same immutable outbox (fresh, empty, commit-able staging).
    const H50 = { "x-test-clock-offset-ms": String(50 * 3600_000) };
    const ex = gen("g_reg_expire", 2, r1.snapshot_id);
    assert.equal((await call(tokA, "DELETE", "/publisher/generations/g_reg_s4", undefined, { headers: H25 })).status, 200);
    assert.equal((await begin(tokA, ex, { headers: H25 })).status, 201);
    await putAll(tokA, { begin: ex.begin, files: ex.files.slice(0, 1) }, { headers: H25 });
    const reb = await begin(tokA, ex, { headers: H50 });
    assert.equal(reb.status, 201, `expired exact begin must restage, got ${reb.status} ${reb.text}`);
    assert.equal(reb.json.state, "staged");
    const fresh = await call(tokA, "GET", "/publisher/generations/g_reg_expire", undefined, { headers: H50 });
    assert.equal(fresh.json.uploaded_parts, 0, "expired parts were cleaned; outbox reuploads all parts");
    assert.equal((await begin(tokA, { begin: { ...ex.begin, part_count: ex.begin.part_count + 1 } }, { headers: H50 })).status, 409, "restaged metadata still immutable");
    await putAll(tokA, ex, { headers: H50 });
    assert.equal((await call(tokA, "GET", "/publisher/generations/g_reg_one", undefined, { headers: H50 })).json.state, "committed", "cleanup kept committed g1");
    assert.equal((await call(tokA, "DELETE", "/publisher/generations/g_reg_expire", undefined, { headers: H50 })).status, 200);
    assert.equal((await begin(tokA, s4, { headers: H25 })).status, 201, "re-stage s4 for later sections");

    // --- 8. Lowered retained-part quota fails closed without deleting anything.
    const q = gen("g_reg_quota", 2, r1.snapshot_id, { payloads: 2 });
    const qr = await begin(tokA, q, { headers: { ...H25, "x-test-max-retained-parts": "6" } });
    assert.equal(qr.status, 413, qr.text);
    assert.equal((await call(tokA, "GET", "/publisher/generations/g_reg_one")).json.state, "committed");
    assert.equal((await call(tokA, "DELETE", "/publisher/generations/g_reg_s4", undefined, { headers: H25 })).status, 200);

    // --- 9. Newer generation commits; g1 commit replay still returns the ORIGINAL receipt.
    const g2 = gen("g_reg_two", 2, r1.snapshot_id, { payloads: 2 });
    assert.equal((await begin(tokA, g2, { headers: H25 })).status, 201); await putAll(tokA, g2, { headers: H25 });
    const c2 = await commit(tokA, "g_reg_two", { headers: H25 }); assert.equal(c2.status, 201, c2.text);
    assert.equal((await current()).snapshot_id, c2.json.snapshot.snapshot_id);
    const replay1 = await commit(tokA, "g_reg_one", { idem: "commit-g1" });
    assert.equal(replay1.status, 200); assert.equal(replay1.json.idempotent_replay, true);
    assert.equal(replay1.json.snapshot.snapshot_id, r1.snapshot_id); assert.deepEqual(replay1.json.snapshot.files, r1.files);

    // --- 10. Legacy snapshots still work and generation artifacts don't count toward the legacy 32-file quota.
    const legacy = await call(tokA, "POST", "/publisher/snapshots", { source_revision: 3, files: [{ name: "export.json", kind: "json", content: JSON.stringify({ synthetic: true, records: [] }) }] });
    assert.equal(legacy.status, 201, legacy.text);
    assert.equal(legacy.json.snapshot.files.length, 1);

    // --- 11. Stale token epoch / revocation: staged work cannot be committed.
    const g3 = gen("g_reg_three", 4, legacy.json.snapshot.snapshot_id);
    assert.equal((await begin(tokA, g3)).status, 201); await putAll(tokA, g3);
    const resumed = await h.connectPublisher(app, { project_id: "gen-regress", destination: "new", new_folder_name: "Regress A2", resume: A.publisher_id }).catch((e) => ({ error: String(e) }));
    if (resumed.access_token) {
      const oldTok = tokA; tokA = resumed.access_token;
      assert.equal((await commit(oldTok, "g_reg_three")).status, 401, "superseded token epoch");
      assert.equal((await current()).snapshot_id, legacy.json.snapshot.snapshot_id);
    }
    const revoke = await owner.req("POST", `/api/publishers/${A.publisher_id}/revoke`, {});
    assert.equal(revoke.status, 200, JSON.stringify(revoke.body));
    assert.equal((await commit(tokA, "g_reg_three")).status, 401, "revoked publisher");
    assert.equal((await begin(tokA, gen("g_reg_after_revoke", 5, null))).status, 401);
    // B unaffected and its generation still committable (scope independent).
    await putAll(B.access_token, bg, { headers: H25 });
    const cb1 = await commit(B.access_token, "g_reg_b1", { headers: H25 });
    assert.equal(cb1.status, 201);

    // --- 12. Owner disables B's app client: staged B work cannot be committed and no new staging starts.
    const bg2 = gen("g_reg_b2", 2, cb1.json.snapshot.snapshot_id);
    assert.equal((await begin(B.access_token, bg2, { headers: H25 })).status, 201);
    await putAll(B.access_token, bg2, { headers: H25 });
    const bFiles = (await owner.req("GET", "/api/projects/gen-regress/artifacts")).body;
    const dis = await owner.req("POST", `/api/app-clients/${appB.app_client_id}/disable`, {});
    assert.equal(dis.status, 200, JSON.stringify(dis.body));
    const dc = await commit(B.access_token, "g_reg_b2", { headers: H25 });
    assert.equal(dc.status,401,dc.text);
    const clients=(await owner.req("GET","/api/app-clients")).body.app_clients;const disabled=clients.find(x=>x.app_client_id===appB.app_client_id);assert.equal(disabled.publishers.find(x=>x.publisher_id===B.publisher_id).current_snapshot_id,cb1.json.snapshot.snapshot_id,"pointer unchanged after disable");
    assert.deepEqual((await owner.req("GET", "/api/projects/gen-regress/artifacts")).body,bFiles,"nothing materialized after disable");
    const db = await begin(B.access_token, gen("g_reg_b3", 3, cb1.json.snapshot.snapshot_id), { headers: H25 });
    assert.equal(db.status,401,db.text);
    const dp = await call(B.access_token, "PUT", `/publisher/generations/g_reg_b2/parts/${bg2.files[0].name}x`, { content: bg2.files[0].content, sha256: sha(bg2.files[0].content) }, { headers: H25 });
    assert.equal(dp.status,401,dp.text);
    console.log("disabled-client statuses", { commit: dc.status, commit_code: dc.json?.error?.code, begin: db.status, begin_code: db.json?.error?.code, put: dp.status });
    console.log("PASS generation regressions", resumed.access_token ? "(incl. resume epoch)" : `(resume skipped: ${resumed.error?.slice(0, 120)})`);
  } finally { await h.stop(); }
});
