import { commitTextWrites, getText, stageTextWrites, storeText, textKey, textWriteComplete } from "../content-store.js";
import { textSearchBridge } from "../search/service.js";
import { agentRate, authzSql, rateLimit } from "../auth.js";
import { MIME, byteLength, checkFile } from "../formats.js";
import { appOrigin, artifactWebUrl, previewWebUrl } from "../links.js";
import { addressLinksResponse } from "../paths.js";
import { explainLimit, projectLimitGuard, projectWorkspaceId } from "../limits.js";
import { SCOPES, livePublisher } from "../oauth/server.js";
import { appFilesDrainsInUse, appFilesSlotsInUse, baseParams, baseSql, firstCaseTwin, generationConflict, generationNameConflictRows, generationNameConflictSql, isAppFileContentPath, isAppFilesPath, newNameConflictRows, newNameConflictSql, pathConflictAt, routeAppFiles } from "./app-files.js";
import { LIMITS, connectionInfo, idemLookup, servedContentType } from "../service.js";
import { memberRoleSql, readOnlyError } from "../tenancy.js";
import { HttpError, errorBody, idemKey, int, json, nowIso, randomId, sha256Hex, str } from "../util.js";

// src/api/generations.ts
var GENERATION_CONTRACT = {
  version: "agentlib.generations/1",
  max_part_bytes: 32768,
  max_parts: 2048,
  max_generation_bytes: 33554432,
  max_staged_generations: 2,
  staging_ttl_ms: 864e5,
  max_retained_bytes: 268435456,
  max_retained_parts: 16384,
  max_index_bytes: 2097152,
  max_name_chars: 128,
  name_pattern: "[A-Za-z0-9._-]{1,128}",
  generation_id_pattern: "g_[A-Za-z0-9_-]{1,62}",
  index_format: "agentlib.generation.index/1",
  part_format: "agentlib.generation.part/1",
  auto_prune_committed: false
};
var C = GENERATION_CONTRACT;
var INDEX_FORMATS = [C.index_format, "healthconnect.readable.index/1"];
var PART_FORMATS = [C.part_format, "healthconnect.readable.part/1"];
var isIndex = (f) => INDEX_FORMATS.includes(f);
var isPart = (f) => PART_FORMATS.includes(f);
var NAME = /^[A-Za-z0-9._-]{1,128}$/;
var GID = /^g_[A-Za-z0-9_-]{1,62}$/;
var HASH = /^[a-f0-9]{64}$/;
var MAX_REQUEST = 262144;
var MAX_DEPTH = 8;
var bad = (message) => {
  throw new HttpError(400, "invalid_input", message);
};
var conflict = (message, extra) => {
  throw new HttpError(409, "generation_conflict", message, extra);
};
var MANIFEST_NAME_TAKEN = "The generation's manifest name already exists as a file of this publisher";
var invalidClosure = (detail, file) => {
  throw new HttpError(422, "invalid_content", `Invalid generation: ${detail}`, { format: "schema", detail, ...file ? { file } : {} });
};
var isUnique = (e) => /UNIQUE constraint|PRIMARY KEY/i.test(String(e?.message));
var manifestName = (gid) => `${gid}.manifest.json`;
function hooks(env, req) {
  const on = env.AC_TEST_HOOKS === "1" && /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(new URL(req.url).host);
  const n = (h) => {
    const raw = req.headers.get(h);
    const v = on && raw !== null ? Number(raw) : NaN;
    return Number.isSafeInteger(v) ? v : null;
  };
  const off = n("x-test-clock-offset-ms") ?? 0;
  const lower = (h, max) => {
    const v = n(h);
    return v !== null && v >= 0 && v < max ? v : max;
  };
  return { now: Date.now() + off, maxRetainedParts: lower("x-test-max-retained-parts", C.max_retained_parts), maxRetainedBytes: lower("x-test-max-retained-bytes", C.max_retained_bytes) };
}
async function body(req) {
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json"))
    throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/json");
  const declared = req.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= MAX_REQUEST))
    throw new HttpError(413, "too_large", "Generation request too large");
  let n = 0;
  const chunks = [];
  const reader = req.body?.getReader();
  if (reader)
    for (; ; ) {
      const r = await reader.read();
      if (r.done)
        break;
      n += r.value.length;
      if (n > MAX_REQUEST) {
        await reader.cancel().catch(() => {
        });
        throw new HttpError(413, "too_large", "Generation request too large");
      }
      chunks.push(r.value);
    }
  const b = new Uint8Array(n);
  let o = 0;
  for (const x of chunks) {
    b.set(x, o);
    o += x.length;
  }
  try {
    const j = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(b));
    if (!j || Array.isArray(j) || typeof j !== "object")
      throw 0;
    return j;
  } catch {
    return bad("Body must be a JSON object");
  }
}
var context = (env, p, requestId) => ({
  env,
  requestId,
  publisher: true,
  principal: { id: p.principal_id, kind: "agent", label: `publisher:${p.display_name}` },
  grant: { id: p.id, project_id: p.project_id, can_write: 1 }
});
async function generation(env, p, id) {
  const g = await env.DB.prepare("SELECT * FROM publisher_generations WHERE publisher_id = ? AND id = ?").bind(p.id, id).first();
  if (!g)
    throw new HttpError(404, "not_found", "Generation not found");
  if (g.project_id !== p.project_id || (g.folder_id ?? null) !== (p.folder_id ?? null))
    throw new HttpError(403, "scope_mismatch", "Generation scope mismatch");
  return g;
}
async function cleanup(env, p, now) {
  const sel = "SELECT id FROM publisher_generations WHERE publisher_id = ? AND state != 'committed' AND ((state = 'staged' AND expires_at < ?) OR state = 'abandoned')";
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM publisher_generation_parts WHERE publisher_id = ? AND artifact_id IS NULL AND generation_id IN (${sel})`).bind(p.id, p.id, now),
    env.DB.prepare(`DELETE FROM publisher_generations WHERE publisher_id = ? AND state != 'committed' AND snapshot_id IS NULL AND ((state = 'staged' AND expires_at < ?) OR state = 'abandoned')`).bind(p.id, now)
  ]);
}
var RETAINED_BYTES = `((SELECT COALESCE(SUM(r.size), 0) FROM revisions r JOIN artifacts a ON a.id = r.artifact_id WHERE a.publisher_id = ?)
+ (SELECT COALESCE(SUM(total_bytes), 0) FROM publisher_generations WHERE publisher_id = ? AND state = 'staged'))`;
var RETAINED_PARTS = `((SELECT COUNT(*) FROM artifacts WHERE publisher_id = ? AND generation_id IS NOT NULL)
+ (SELECT COALESCE(SUM(part_count + 1), 0) FROM publisher_generations WHERE publisher_id = ? AND state = 'staged'))`;
var MANIFEST_RESERVE = 4096;
function beginFields(b) {
  const ok = GID.test(b.generation_id) && Number.isSafeInteger(b.source_revision) && b.source_revision >= 1 && typeof b.root_name === "string" && NAME.test(b.root_name) && typeof b.root_sha256 === "string" && HASH.test(b.root_sha256) && Number.isSafeInteger(b.part_count) && b.part_count >= 1 && b.part_count <= C.max_parts && Number.isSafeInteger(b.total_bytes) && b.total_bytes >= 1 && b.total_bytes <= C.max_generation_bytes && b.total_bytes <= b.part_count * C.max_part_bytes;
  if (!ok)
    bad("Invalid generation bounds/identity");
  if (b.root_name === manifestName(b.generation_id))
    bad("root_name is reserved");
  if (b.root_name.toLowerCase() === MANIFEST)
    bad("root_name is reserved");
  const exp = b.expected_current_snapshot_id;
  if (exp !== null && (typeof exp !== "string" || !/^snp_[A-Za-z0-9_-]{1,64}$/.test(exp)))
    bad("expected_current_snapshot_id must be null or a snapshot id");
  if (b.exported_at !== void 0 && b.exported_at !== null && (typeof b.exported_at !== "string" || b.exported_at.length > 64))
    bad("Invalid exported_at");
  let coverage = null;
  if (b.coverage !== void 0 && b.coverage !== null) {
    if (typeof b.coverage !== "object" || Array.isArray(b.coverage) || ["from", "to"].some((k) => typeof b.coverage[k] !== "string" || b.coverage[k].length > 64))
      bad("Invalid coverage");
    coverage = { from: b.coverage.from, to: b.coverage.to };
  }
  return {
    generation_id: b.generation_id,
    source_revision: b.source_revision,
    expected_current_snapshot_id: exp,
    root_name: b.root_name,
    root_sha256: b.root_sha256,
    part_count: b.part_count,
    total_bytes: b.total_bytes,
    coverage,
    exported_at: b.exported_at ?? null
  };
}
var beginView = (g) => ({
  generation_id: g.id,
  state: g.state,
  source_revision: g.source_revision,
  expected_current_snapshot_id: g.expected_current_snapshot_id,
  root_name: g.root_name,
  root_sha256: g.root_sha256,
  part_count: g.part_count,
  total_bytes: g.total_bytes,
  expires_at: g.state === "staged" ? new Date(g.expires_at).toISOString() : null,
  snapshot_id: g.snapshot_id ?? null
});
/**
 * The publisher's current authorization, re-read now. Write mode (default): an active workspace and the creator a
 * member. Read mode ({ read: true }): a suspended workspace stays readable. Both: not revoked, same token epoch, an
 * enabled app client, the destination unchanged and valid.
 */
async function assertStillAuthorized(env, p, { read = false } = {}) {
  const row = await env.DB.prepare(`SELECT pb.token_epoch,pb.revoked_at,pb.project_id,pb.folder_id,ac.disabled_at AS client_disabled,
    (SELECT w.status FROM workspaces w WHERE w.id = COALESCE(pj.workspace_id, 'wsp_' || pj.owner_id)) AS ws_status,
    ${memberRoleSql("pj.id", "member", "COALESCE(pb.created_by, pb.owner_principal_id)")} AS creator_ok,
    ${memberRoleSql("pj.id", "member", "COALESCE(pb.created_by, pb.owner_principal_id)", true)} AS creator_ok_suspended,CASE WHEN pb.folder_id IS NULL THEN 1 ELSE EXISTS(SELECT 1 FROM folders f WHERE f.id=pb.folder_id AND f.project_id=pb.project_id) END AS folder_valid
    FROM publishers pb JOIN app_clients ac ON ac.id=pb.app_client_id JOIN projects pj ON pj.id=pb.project_id WHERE pb.id=?`).bind(p.id).first();
  if (!row || row.revoked_at !== null || row.token_epoch !== p.token_epoch) throw new HttpError(401, "unauthenticated", "Publisher/client revoked or token superseded; reconnect required");
  if (row.client_disabled !== null) throw new HttpError(401, "unauthenticated", APP_DISABLED);
  const scopeOk = row.project_id === p.project_id && (row.folder_id ?? null) === (p.folder_id ?? null) && row.folder_valid;
  // Only a publisher that would otherwise be allowed learns the workspace is suspended.
  if (!read && row.ws_status === "suspended" && scopeOk && row.creator_ok_suspended) throw readOnlyError();
  if (!scopeOk || !(read ? row.creator_ok_suspended : row.creator_ok)) throw new HttpError(403, "scope_mismatch", "Publisher destination unavailable or changed");
}
async function begin(env, p, req) {
  idemKey(req.headers.get("idempotency-key"));
  const h = hooks(env, req);
  const f = beginFields(await body(req));
  const digest = await sha256Hex(JSON.stringify(f));
  await cleanup(env, p, h.now);
  const replay = async () => {
    const prior = await env.DB.prepare("SELECT * FROM publisher_generations WHERE publisher_id = ? AND id = ?").bind(p.id, f.generation_id).first();
    if (!prior)
      return null;
    if (prior.begin_digest !== digest)
      conflict("Generation metadata is immutable", { generation_id: f.generation_id, state: prior.state });
    await generation(env, p, f.generation_id);
    return json({ ...beginView(prior), idempotent_replay: true }, 200);
  };
  const r0 = await replay();
  if (r0)
    return r0;
  const az0 = authzSql(context(env, p, "generation-begin"), p.project_id);
  // Workspace storage (Phase 4): a staged generation reserves its declared bytes, like an upload.
  const lg = await projectLimitGuard(env, p.project_id, { storage_bytes: Number(f.total_bytes) || 0 });
  const az = { sql: `${az0.sql} AND ${lg.sql}`, params: [...az0.params, ...lg.params] };
  let changes = 0;
  try {
    const r = await env.DB.prepare(`INSERT INTO publisher_generations (publisher_id, id, project_id, folder_id, token_epoch, source_revision, expected_current_snapshot_id,
      root_name, root_sha256, part_count, total_bytes, coverage, exported_at, begin_digest, state, created_at, expires_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'staged', ?, ?
    WHERE EXISTS (SELECT 1 FROM publishers WHERE id = ? AND token_epoch = ? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM app_clients c WHERE c.id=publishers.app_client_id AND c.disabled_at IS NULL) AND (folder_id IS NULL OR EXISTS (SELECT 1 FROM folders f WHERE f.id=publishers.folder_id AND f.project_id=publishers.project_id)) AND project_id = ? AND folder_id IS ?) AND ${az.sql}
      AND (SELECT COUNT(*) FROM publisher_generations WHERE publisher_id = ? AND state = 'staged') < ${C.max_staged_generations}
      AND ${RETAINED_BYTES} + ? <= ? AND ${RETAINED_PARTS} + ? <= ?`).bind(p.id, f.generation_id, p.project_id, p.folder_id ?? null, p.token_epoch, f.source_revision, f.expected_current_snapshot_id, f.root_name, f.root_sha256, f.part_count, f.total_bytes, f.coverage ? JSON.stringify(f.coverage) : null, f.exported_at, digest, nowIso(), h.now + C.staging_ttl_ms, p.id, p.token_epoch, p.project_id, p.folder_id ?? null, ...az.params, p.id, p.id, p.id, f.total_bytes + MANIFEST_RESERVE, h.maxRetainedBytes, p.id, p.id, f.part_count + 1, h.maxRetainedParts).run();
    changes = r.meta.changes ?? 0;
  } catch (e) {
    if (!isUnique(e))
      throw e;
    const r1 = await replay();
    if (r1)
      return r1;
    throw e;
  }
  if (!changes) {
    await assertStillAuthorized(env, p);
    const staged = await env.DB.prepare("SELECT COUNT(*) AS n FROM publisher_generations WHERE publisher_id = ? AND state = 'staged'").bind(p.id).first("n");
    if ((staged ?? 0) >= C.max_staged_generations)
      throw new HttpError(409, "too_many_staged_generations", "Two generations are already staged; commit or DELETE one", { max_staged_generations: C.max_staged_generations });
    if (lg.workspaceId) await explainLimit(env, lg.workspaceId, { storage_bytes: Number(f.total_bytes) || 0 }, lg.limits);
    throw new HttpError(413, "quota_exceeded", "Retained generation quota or authorization check failed; nothing was staged", { max_retained_bytes: h.maxRetainedBytes, max_retained_parts: h.maxRetainedParts });
  }
  const g = await generation(env, p, f.generation_id);
  return json(beginView(g), 201);
}
async function put(env, p, id, name, req) {
  if (!NAME.test(name))
    bad("Invalid part name");
  if (name.toLowerCase() === MANIFEST)
    bad("Part name is reserved for the server manifest");
  if (name === manifestName(id))
    bad("Part name is reserved for the server manifest");
  const h = hooks(env, req);
  const b = await body(req);
  if (typeof b.content !== "string" || typeof b.sha256 !== "string" || !HASH.test(b.sha256))
    bad("content string and lowercase hex sha256 required");
  const size = byteLength(b.content);
  if (size < 1 || size > C.max_part_bytes)
    throw new HttpError(413, "part_too_large", `Part exceeds ${C.max_part_bytes} UTF-8 bytes`, { size, max_part_bytes: C.max_part_bytes });
  checkFile("json", b.content, null, name);
  if (await sha256Hex(b.content) !== b.sha256)
    throw new HttpError(422, "hash_mismatch", "Part checksum does not match its UTF-8 bytes");
  const doc = JSON.parse(b.content);
  const finite = (v) => typeof v === "number" ? Number.isFinite(v) : v && typeof v === "object" ? Object.values(v).every(finite) : true;
  if (!finite(doc)) invalidClosure("Nonfinite JSON number", name);
  if (!doc || typeof doc !== "object" || Array.isArray(doc))
    invalidClosure("part must be a JSON object", name);
  if (doc.generation_id !== id)
    invalidClosure("part generation_id does not match", name);
  const g = await generation(env, p, id);
  if (doc.source_revision !== g.source_revision)
    invalidClosure("part source_revision does not match", name);
  const existing = async () => {
    const prior = await env.DB.prepare("SELECT sha256, bytes FROM publisher_generation_parts WHERE publisher_id = ? AND generation_id = ? AND name = ?").bind(p.id, id, name).first();
    if (!prior)
      return null;
    if (prior.sha256 !== b.sha256 || prior.bytes !== size)
      conflict("Part name is immutable", { name });
    return json({ name, sha256: prior.sha256, size: prior.bytes, state: g.state, idempotent_replay: true }, 200);
  };
  const r0 = await existing();
  if (r0)
    return r0;
  if (g.state !== "staged" || g.expires_at < h.now)
    conflict("Generation is not active (committed, abandoned or expired)", { state: g.state });
  const az = authzSql(context(env, p, "generation-part"), p.project_id);
  let changes = 0;
  try {
    const r = await env.DB.prepare(`INSERT INTO publisher_generation_parts (publisher_id, generation_id, name, sha256, bytes, body, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM publisher_generations WHERE publisher_id = ? AND id = ? AND state = 'staged' AND expires_at >= ?)
      AND EXISTS (SELECT 1 FROM publishers WHERE id = ? AND token_epoch = ? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM app_clients c WHERE c.id=publishers.app_client_id AND c.disabled_at IS NULL) AND (folder_id IS NULL OR EXISTS (SELECT 1 FROM folders f WHERE f.id=publishers.folder_id AND f.project_id=publishers.project_id))) AND ${az.sql}
      AND (SELECT COUNT(*) FROM publisher_generation_parts WHERE publisher_id = ? AND generation_id = ?) < ?
      AND (SELECT COALESCE(SUM(bytes), 0) FROM publisher_generation_parts WHERE publisher_id = ? AND generation_id = ?) + ? <= ?`).bind(p.id, id, name, b.sha256, size, b.content, nowIso(), p.id, id, h.now, p.id, p.token_epoch, ...az.params, p.id, id, g.part_count, p.id, id, size, g.total_bytes).run();
    changes = r.meta.changes ?? 0;
  } catch (e) {
    if (!isUnique(e))
      throw e;
    const r1 = await existing();
    if (r1)
      return r1;
    throw e;
  }
  if (!changes) {
    await assertStillAuthorized(env, p);
    conflict("Generation part count/bytes exceed its declaration, or the generation/authorization changed");
  }
  return json({ name, sha256: b.sha256, size, state: "staged" }, 201);
}
function verifyClosure(g, parts) {
  const byName = new Map(parts.map((x) => [x.name, x]));
  const root = byName.get(g.root_name);
  if (!root || root.sha256 !== g.root_sha256)
    conflict("Root part missing or checksum differs from begin", { root_name: g.root_name });
  if (!isIndex(root.format))
    invalidClosure(`root must be a ${C.index_format} document`, g.root_name);
  const visited = /* @__PURE__ */ new Set([g.root_name]);
  const walk = (part, depth) => {
    if (depth > MAX_DEPTH)
      invalidClosure(`index depth exceeds ${MAX_DEPTH}`, part.name);
    let doc;
    try {
      doc = JSON.parse(part.body);
    } catch {
      invalidClosure("index is not JSON", part.name);
    }
    if (!isIndex(doc.format) || doc.generation_id !== g.id || doc.source_revision !== g.source_revision)
      invalidClosure("index identity mismatch", part.name);
    if (!Array.isArray(doc.entries) || doc.entries.length > C.max_parts)
      invalidClosure("index entries must be an array of at most 2048", part.name);
    for (const e of doc.entries) {
      if (!e || typeof e !== "object" || typeof e.name !== "string" || !NAME.test(e.name) || typeof e.sha256 !== "string" || !HASH.test(e.sha256) || !Number.isSafeInteger(e.bytes) || typeof e.kind !== "string" || !e.kind || e.kind.length > 64 || e.count !== void 0 && (!Number.isSafeInteger(e.count) || e.count < 0))
        invalidClosure("index entry requires name, sha256, bytes, kind and optional non-negative count", part.name);
      if (e.utf8_bytes !== void 0 && e.utf8_bytes !== e.bytes)
        invalidClosure(`entry ${e.name} utf8_bytes differs from bytes`, part.name);
      const child = byName.get(e.name);
      if (!child)
        invalidClosure(`entry ${e.name} was not uploaded`, part.name);
      if (child.sha256 !== e.sha256 || child.bytes !== e.bytes)
        invalidClosure(`entry ${e.name} sha256/bytes mismatch`, part.name);
      if (visited.has(e.name))
        invalidClosure(`entry ${e.name} referenced more than once (cycle or duplicate)`, part.name);
      visited.add(e.name);
      if (child.gid !== g.id || child.rev !== g.source_revision)
        invalidClosure(`entry ${e.name} generation identity mismatch`, part.name);
      if (e.kind === "index") {
        if (!isIndex(child.format))
          invalidClosure(`entry ${e.name} declared index but is not an index`, part.name);
        walk(child, depth + 1);
      } else if (!isPart(child.format))
        invalidClosure(`entry ${e.name} must be a ${C.part_format} payload`, part.name);
    }
  };
  walk(root, 0);
  if (visited.size !== parts.length)
    invalidClosure(`${parts.length - visited.size} uploaded part(s) are not reachable from the root`);
  return root;
}
async function commit(env, p, id, req, requestId) {
  idemKey(req.headers.get("idempotency-key"));
  const h = hooks(env, req);
  const b = await body(req);
  if (Object.keys(b).length)
    bad("Commit body must be {}");
  const g = await generation(env, p, id);
  if (g.state === "committed")
    return json({ ...JSON.parse(g.receipt), idempotent_replay: true }, 200);
  if (g.state !== "staged" || g.expires_at < h.now)
    conflict("Generation expired or abandoned", { state: g.state });
  const indexBytes = await env.DB.prepare("SELECT COALESCE(SUM(bytes),0) AS n FROM publisher_generation_parts WHERE publisher_id=? AND generation_id=? AND json_extract(body,'$.format') IN (?,?)").bind(p.id, id, ...INDEX_FORMATS).first("n");
  if ((indexBytes ?? 0) > C.max_index_bytes) throw new HttpError(413, "index_too_large", "Index tree exceeds bounded verification memory", { max_index_bytes: C.max_index_bytes });
  const rows = await env.DB.prepare(`SELECT name, sha256, bytes, json_extract(body, '$.format') AS format, json_extract(body, '$.generation_id') AS gid,
    json_extract(body, '$.source_revision') AS rev, CASE WHEN json_extract(body, '$.format') IN (?, ?) THEN body END AS body
  FROM publisher_generation_parts WHERE publisher_id = ? AND generation_id = ? ORDER BY name`).bind(...INDEX_FORMATS, p.id, id).all();
  const parts = rows.results;
  const sum = parts.reduce((n, x) => n + x.bytes, 0);
  if (parts.length !== g.part_count || sum !== g.total_bytes)
    conflict("Generation incomplete", { uploaded_parts: parts.length, part_count: g.part_count, uploaded_bytes: sum, total_bytes: g.total_bytes });
  const root = verifyClosure(g, parts);
  const now = nowIso();
  const sid = randomId("snp", 15);
  const ids = {};
  for (const x of parts)
    ids[x.name] = { a: randomId("art"), r: randomId("rev") };
  const files = parts.map((x) => ({
    name: x.name,
    file_id: ids[x.name].a,
    kind: "json",
    role: x.name === g.root_name ? "authoritative" : "payload",
    derived_from: null,
    schema: null,
    revision: 1,
    sha256: x.sha256,
    size: x.bytes
  }));
  const coverage = g.coverage ? JSON.parse(g.coverage) : null;
  const mName = manifestName(id);
  const mArt = randomId("art");
  const mRev = randomId("rev");
  const manifestText = JSON.stringify({
    manifest_version: "agentlib.generation-manifest/1",
    publisher_id: p.id,
    snapshot_id: sid,
    generation_id: id,
    source_revision: g.source_revision,
    committed_at: now,
    exported_at: g.exported_at,
    coverage,
    root: { name: g.root_name, file_id: ids[g.root_name].a, revision: 1, sha256: root.sha256, size: root.bytes },
    part_count: parts.length,
    total_bytes: g.total_bytes
  }, null, 2) + "\n";
  const mSha = await sha256Hex(manifestText);
  const mSize = byteLength(manifestText);
  if (mSize > C.max_part_bytes) throw new HttpError(413, "manifest_too_large", "Server manifest exceeds readable byte cap");
  const receipt = { snapshot: {
    snapshot_id: sid,
    publisher_id: p.id,
    generation_id: id,
    source_revision: g.source_revision,
    status: "current",
    committed_at: now,
    exported_at: g.exported_at,
    coverage,
    manifest: { name: mName, file_id: mArt, revision: 1, sha256: mSha, size: mSize },
    root: { name: g.root_name, file_id: ids[g.root_name].a, sha256: root.sha256, size: root.bytes },
    files
  }, already_current: false };
  const receiptText = JSON.stringify(receipt);
  const az = authzSql(context(env, p, requestId), p.project_id);
  const idsJson = JSON.stringify(ids);
  const gate = "EXISTS (SELECT 1 FROM publishers WHERE id = ? AND current_snapshot_id = ?)";
  const gp = [p.id, sid];
  const nameRule = generationNameConflictSql(p.id, id, mName);
  const q = [];
  q.push(env.DB.prepare(`UPDATE publishers SET current_snapshot_id = ?, current_source_revision = ?
  WHERE id = ? AND token_epoch = ? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM app_clients c WHERE c.id=publishers.app_client_id AND c.disabled_at IS NULL) AND (folder_id IS NULL OR EXISTS (SELECT 1 FROM folders f WHERE f.id=publishers.folder_id AND f.project_id=publishers.project_id)) AND project_id = ? AND folder_id IS ? AND current_snapshot_id IS ?
    AND (current_source_revision IS NULL OR current_source_revision < ?) AND ${az.sql}
    AND EXISTS (SELECT 1 FROM publisher_generations WHERE publisher_id = ? AND id = ? AND state = 'staged' AND expires_at >= ? AND project_id = ? AND folder_id IS ?)
    AND (SELECT COUNT(*) FROM publisher_generation_parts WHERE publisher_id = ? AND generation_id = ? AND artifact_id IS NULL) = ?
    AND ${RETAINED_PARTS} <= ? AND ${RETAINED_BYTES} + ? <= ?
    AND ${nameRule.sql}`).bind(sid, g.source_revision, p.id, p.token_epoch, p.project_id, p.folder_id ?? null, g.expected_current_snapshot_id, g.source_revision, ...az.params, p.id, id, h.now, p.project_id, p.folder_id ?? null, p.id, id, parts.length, p.id, p.id, h.maxRetainedParts, p.id, p.id, mSize, h.maxRetainedBytes, ...nameRule.params));
  q.push(env.DB.prepare(`INSERT INTO artifacts (id, project_id, kind, title, folder, folder_id, schema_id, publisher_id, export_name, generation_id, head_rev, head_revision_id, created_at, updated_at)
  SELECT json_extract(j.value, '$.a'), ?, 'json', t.name, '', ?, NULL, ?, t.name, ?, 1, json_extract(j.value, '$.r'), ?, ?
  FROM json_each(?) j JOIN publisher_generation_parts t ON t.publisher_id = ? AND t.generation_id = ? AND t.name = j.key WHERE ${gate}`).bind(p.project_id, p.folder_id ?? null, p.id, id, now, now, idsJson, p.id, id, ...gp));
  // content-store: sql-side copy of staged part bodies (docs/encryption.md); needs its own change for encryption.
  q.push(env.DB.prepare(`INSERT INTO revisions (id, artifact_id, project_id, rev_no, author_id, body, size, sha256, mime, created_at, via_kind, via_id, via_label)
  SELECT json_extract(j.value, '$.r'), json_extract(j.value, '$.a'), ?, 1, ?, t.body, t.bytes, t.sha256, 'application/json', ?, 'publisher', ?, ?
  FROM json_each(?) j JOIN publisher_generation_parts t ON t.publisher_id = ? AND t.generation_id = ? AND t.name = j.key WHERE ${gate}`).bind(p.project_id, p.principal_id, now, p.id, String(p.display_name ?? "").slice(0, 120) || null, idsJson, p.id, id, ...gp));
  q.push(env.DB.prepare(`INSERT INTO artifacts (id, project_id, kind, title, folder, folder_id, schema_id, publisher_id, export_name, generation_id, head_rev, head_revision_id, created_at, updated_at)
  SELECT ?, ?, 'json', ?, '', ?, NULL, ?, ?, ?, 1, ?, ?, ? WHERE ${gate}`).bind(mArt, p.project_id, mName, p.folder_id ?? null, p.id, mName, id, mRev, now, now, ...gp));
  q.push(env.DB.prepare(`INSERT INTO revisions (id, artifact_id, project_id, rev_no, author_id, body, size, sha256, mime, created_at, via_kind, via_id, via_label)
  SELECT ?, ?, ?, 1, ?, ?, ?, ?, 'application/json', ?, 'publisher', ?, ? WHERE ${gate}`).bind(mRev, mArt, p.project_id, p.principal_id, storeText(manifestText), mSize, mSha, now, p.id, String(p.display_name ?? "").slice(0, 120) || null, ...gp));
  q.push(env.DB.prepare(`UPDATE publisher_generation_parts AS t SET body = NULL, artifact_id = json_extract(j.value, '$.a'), revision_id = json_extract(j.value, '$.r')
  FROM json_each(?) j WHERE t.publisher_id = ? AND t.generation_id = ? AND t.name = j.key AND ${gate}`).bind(idsJson, p.id, id, ...gp));
  q.push(env.DB.prepare(`INSERT INTO snapshots (id, publisher_id, source_revision, committed_at, exported_at, coverage, manifest_file_id, manifest_revision, manifest_sha256, files)
  SELECT ?, ?, ?, ?, ?, ?, ?, 1, ?, ? WHERE ${gate}`).bind(sid, p.id, g.source_revision, now, g.exported_at, g.coverage, mArt, mSha, JSON.stringify(files), ...gp));
  q.push(env.DB.prepare(`UPDATE publisher_generations SET state = 'committed', snapshot_id = ?, receipt = ?, committed_at = ? WHERE publisher_id = ? AND id = ? AND state = 'staged' AND ${gate}`).bind(sid, receiptText, now, p.id, id, ...gp));
  q.push(env.DB.prepare(`INSERT INTO audits (at, actor_id, project_id, action, object_id, rev_no, result, request_id) SELECT ?, ?, ?, 'generation.commit', ?, ?, 'ok', ? WHERE ${gate}`).bind(now, p.principal_id, p.project_id, sid, g.source_revision, requestId, ...gp));
  // Derived generation index writes are explicit, not insert triggers: old Workers validate exact
  // D1 meta.changes for their nine-statement commit. Keep those checks intact on the new Worker too.
  q.push(env.DB.prepare(`INSERT OR IGNORE INTO artifact_search_keys(artifact_id)
    SELECT a.id FROM artifacts a WHERE a.publisher_id=? AND a.generation_id=? AND ${gate}`).bind(p.id,id,...gp));
  q.push(env.DB.prepare(`INSERT OR REPLACE INTO artifact_search (rowid,artifact_id,revision_id,sha256,title,body)
    SELECT k.search_id,a.id,r.id,r.sha256,a.title,COALESCE(r.body,'') FROM artifacts a JOIN artifact_search_keys k ON k.artifact_id=a.id
    JOIN revisions r ON r.id=a.head_revision_id AND r.artifact_id=a.id AND r.project_id=a.project_id AND r.rev_no=a.head_rev
    JOIN publisher_generations pg ON pg.id=a.generation_id AND pg.publisher_id=a.publisher_id AND pg.state='committed'
    WHERE a.publisher_id=? AND a.generation_id=? AND a.trashed_at IS NULL AND ${gate}`).bind(p.id,id,...gp));
  q.push(env.DB.prepare(`SELECT count(*) AS indexed_count FROM artifact_search s JOIN artifacts a ON a.id=s.artifact_id
    WHERE a.publisher_id=? AND a.generation_id=? AND s.revision_id=a.head_revision_id`).bind(p.id,id));
  let res;
  try {
    // The context lives only inside this atomic batch. A rolled-back older Worker does not opt in,
    // so trigger side effects cannot break its exact generation row-count checks.
    const measured = await env.DB.batch([
      env.DB.prepare("INSERT INTO change_generation_context VALUES(1)"),
      ...q.flatMap(stmt => [stmt, env.DB.prepare("SELECT changes() AS direct_changes")]),
      env.DB.prepare(`INSERT INTO change_generation_coverage(publisher_id,snapshot_id)
        SELECT id,current_snapshot_id FROM publishers WHERE id=? AND current_snapshot_id=?
        ON CONFLICT(publisher_id) DO UPDATE SET snapshot_id=excluded.snapshot_id`).bind(p.id,sid),
      env.DB.prepare("DELETE FROM change_generation_context WHERE id=1")
    ]);
    res = q.map((_, i) => ({ ...measured[1+2*i], meta: { ...measured[1+2*i].meta, changes: measured[2+2*i].results[0].direct_changes } }));
  } catch (e) {
    const again = await generation(env, p, id).catch(() => null);
    if (again?.state === "committed")
      return json({ ...JSON.parse(again.receipt), idempotent_replay: true }, 200);
    if (isUnique(e))
      conflict("A concurrent commit or name collision won; nothing was written");
    throw e;
  }
  if (!res[0].meta.changes) {
    await assertStillAuthorized(env, p);
    const again = await generation(env, p, id).catch(() => null);
    if (again?.state === "committed")
      return json({ ...JSON.parse(again.receipt), idempotent_replay: true }, 200);
    const pub = await env.DB.prepare("SELECT current_snapshot_id, current_source_revision, revoked_at, token_epoch FROM publishers WHERE id = ?").bind(p.id).first();
    if (!pub || pub.revoked_at !== null || pub.token_epoch !== p.token_epoch)
      throw new HttpError(401, "unauthenticated", "Publisher revoked or token superseded; nothing was written");
    if ((pub.current_snapshot_id ?? null) !== (g.expected_current_snapshot_id ?? null) || pub.current_source_revision !== null && pub.current_source_revision >= g.source_revision)
      throw new HttpError(409, "stale_generation", "Current snapshot changed since this generation began; nothing was written", { current_snapshot_id: pub.current_snapshot_id ?? null, current_source_revision: pub.current_source_revision ?? null, expected_current_snapshot_id: g.expected_current_snapshot_id });
    const clash = await env.DB.prepare(`SELECT a.export_name FROM publisher_generation_parts t JOIN artifacts a ON a.publisher_id = ? AND a.export_name = t.name
      WHERE t.publisher_id = ? AND t.generation_id = ? ORDER BY t.name LIMIT 1`).bind(p.id, p.id, id).first("export_name");
    if (clash)
      conflict("A part name already exists as a file of this publisher", { name: clash });
    const mClash = await env.DB.prepare("SELECT 1 AS hit FROM artifacts WHERE publisher_id = ? AND export_name = ? LIMIT 1").bind(p.id, mName).first("hit");
    if (mClash)
      conflict(MANIFEST_NAME_TAKEN, { name: mName });
    if (again?.state === "staged") {
      const nameRows = generationNameConflictRows(p.id, id, mName);
      const found = generationConflict(parts.map((x) => x.name), (await env.DB.prepare(nameRows.sql).bind(...nameRows.params).first()) ?? null);
      if (found) throw pathConflictAt(found.name, found.conflicts_with);
    }
    throw new HttpError(413, "quota_exceeded", "Retained generation quota exceeded or generation changed; nothing was written", { max_retained_bytes: h.maxRetainedBytes, max_retained_parts: h.maxRetainedParts });
  }
  const expect = [1, parts.length, parts.length, 1, 1, parts.length, 1, 1, 1];
  if (res.slice(0, expect.length).some((r, i) => (r.meta.changes ?? 0) !== expect[i]) || res.at(-1).results[0].indexed_count !== parts.length + 1) {
    console.error("generation_commit_partial", requestId);
    throw new HttpError(500, "internal", "Generation commit inconsistency");
  }
  return json(receipt, 201);
}
async function view(env, p, id) {
  const g = await generation(env, p, id);
  const rows = await env.DB.prepare("SELECT name, sha256, bytes AS size, artifact_id AS file_id FROM publisher_generation_parts WHERE publisher_id = ? AND generation_id = ? ORDER BY name LIMIT ?").bind(p.id, id, C.max_parts).all();
  return json({ ...beginView(g), uploaded_parts: rows.results.length, parts: rows.results });
}
async function abandon(env, p, id, req) {
  const h = hooks(env, req);
  const g = await generation(env, p, id);
  if (g.state === "committed")
    conflict("Committed generations cannot be deleted", { snapshot_id: g.snapshot_id });
  // Abandoning is a write: the publisher's current authorization is checked first and again inside the UPDATE.
  await assertStillAuthorized(env, p);
  const az = authzSql(context(env, p, "generation-abandon"), p.project_id);
  await testPause(env, req);
  const r = await env.DB.prepare(`UPDATE publisher_generations SET state = 'abandoned', abandoned_at = ? WHERE publisher_id = ? AND id = ? AND state = 'staged'
    AND ${baseSql(true)} AND ${az.sql}`).bind(nowIso(), p.id, id, ...baseParams(p), ...az.params).run();
  if (!(r.meta.changes ?? 0)) await assertStillAuthorized(env, p);
  const after = await generation(env, p, id);
  if (after.state === "committed")
    conflict("Committed generations cannot be deleted", { snapshot_id: after.snapshot_id });
  // Still staged although authorized again now: the authorization changed and changed back during the request.
  if (after.state === "staged")
    conflict("The publisher's authorization changed during the request; nothing was abandoned", { state: after.state });
  await cleanup(env, p, h.now);
  return json({ generation_id: id, state: "abandoned", deleted_staging: true });
}
async function routeGeneration(req, env, p, requestId) {
  const path = new URL(req.url).pathname.replace(/\/$/, "");
  if (path === "/v1/publisher/generations") {
    if (req.method !== "POST")
      throw new HttpError(405, "method_not_allowed", "Method not allowed");
    return begin(env, p, req);
  }
  if (!path.startsWith("/v1/publisher/generations/"))
    return null;
  const m = /^\/v1\/publisher\/generations\/(g_[A-Za-z0-9_-]{1,62})(?:\/(commit|parts\/([A-Za-z0-9._-]{1,128})))?$/.exec(path);
  if (!m)
    throw new HttpError(404, "not_found", "Not found");
  const id = m[1];
  if (m[2] === "commit") {
    if (req.method !== "POST")
      throw new HttpError(405, "method_not_allowed", "Method not allowed");
    return commit(env, p, id, req, requestId);
  }
  if (m[3]) {
    if (req.method !== "PUT")
      throw new HttpError(405, "method_not_allowed", "Method not allowed");
    return put(env, p, id, m[3], req);
  }
  if (req.method === "GET" || req.method === "HEAD")
    return view(env, p, id);
  if (req.method === "DELETE")
    return abandon(env, p, id, req);
  throw new HttpError(405, "method_not_allowed", "Method not allowed");
}

// App Connect publisher API (/v1/publisher)
var MAX_BODY = 65e5;
var NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
var MANIFEST = "manifest.json";
var APP_DISABLED = "This app has been disabled by the owner of this library";
var ID = "([A-Za-z0-9_-]{1,64})";
var R = {
  me: /^\/v1\/publisher\/me$/,
  files: /^\/v1\/publisher\/files$/,
  file: new RegExp(`^/v1/publisher/files/${ID}$`),
  content: new RegExp(`^/v1/publisher/files/${ID}/content$`),
  snapshots: /^\/v1\/publisher\/snapshots$/,
  current: /^\/v1\/publisher\/snapshots\/current$/,
  snapshot: new RegExp(`^/v1/publisher/snapshots/(snp_[A-Za-z0-9_-]{1,64})$`)
};
async function readJsonBody(req) {
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/json");
  const declared = req.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= MAX_BODY)) throw new HttpError(413, "too_large", "Request body too large");
  const reader = req.body?.getReader();
  const parts = [];
  let n = 0;
  if (reader) for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > MAX_BODY) {
      await reader.cancel().catch(() => {
      });
      throw new HttpError(413, "too_large", "Request body too large");
    }
    parts.push(value);
  }
  const buf = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    buf.set(p, o);
    o += p.byteLength;
  }
  try {
    const v = n ? JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(buf)) : null;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw 0;
    return v;
  } catch {
    throw new HttpError(400, "invalid_json", "Body must be a JSON object");
  }
}
function pubCtx(env, p, requestId) {
  return {
    env,
    requestId,
    publisher: true,
    principal: { id: p.principal_id, kind: "agent", label: `publisher:${p.display_name}` },
    grant: { id: p.id, project_id: p.project_id, can_write: 1 }
  };
}
var fileView = (env, p, a, currentNames2) => {
  const o = appOrigin(env.APP_HOST);
  return {
    file_id: a.id,
    name: a.export_name,
    kind: a.kind,
    schema: a.schema_id ?? null,
    revision: a.head_rev,
    sha256: a.sha256,
    size: a.size,
    in_current_snapshot: currentNames2.has(a.export_name),
    trashed: !!a.trashed_at,
    updated_at: a.updated_at,
    ...o ? { web_url: artifactWebUrl(o, a.project_id, a.id), preview_url: previewWebUrl(o, a.project_id, a.id) } : {}
  };
};
function snapshotView(row, currentId) {
  return {
    snapshot_id: row.id,
    publisher_id: row.publisher_id,
    source_revision: row.source_revision,
    status: row.id === currentId ? "current" : "previous",
    committed_at: row.committed_at,
    exported_at: row.exported_at ?? null,
    coverage: row.coverage ? JSON.parse(row.coverage) : null,
    manifest: { file_id: row.manifest_file_id, revision: row.manifest_revision, sha256: row.manifest_sha256 },
    files: JSON.parse(row.files)
  };
}
async function currentNames(env, p) {
  if (!p.current_snapshot_id) return /* @__PURE__ */ new Set();
  const s = await env.DB.prepare("SELECT files FROM snapshots WHERE id = ?").bind(p.current_snapshot_id).first("files");
  return /* @__PURE__ */ new Set([MANIFEST, ...(s ? JSON.parse(s) : []).map((f) => f.name)]);
}
async function me(env, p) {
  const proj = await env.DB.prepare("SELECT id, title FROM projects WHERE id = ?").bind(p.project_id).first();
  const f = p.folder_id ? await env.DB.prepare("SELECT id, name FROM folders WHERE id = ?").bind(p.folder_id).first() : null;
  return {
    publisher_id: p.id,
    app_client_id: p.apc_id,
    client_id: p.client_id,
    display_name: p.display_name,
    status: "active",
    project: { id: proj.id, title: proj.title },
    destination: f ? { type: "folder", folder_id: f.id, name: f.name } : { type: "root" },
    current_source_revision: p.current_source_revision ?? null,
    current_snapshot_id: p.current_snapshot_id ?? null,
    created_at: p.created_at,
    resumed_at: p.resumed_at ?? null,
    token_epoch: p.token_epoch,
    generation_contract: GENERATION_CONTRACT,
    retention: { ...JSON.parse(p.retention), auto_prune_enabled: false }
  };
}
// Rows an app deleted through App Files keep publisher_id but lose export_name: they are not this API's files.
var FILE_SQL = `SELECT a.*, r.sha256, r.size FROM artifacts a LEFT JOIN revisions r ON r.id = a.head_revision_id
WHERE a.publisher_id = ? AND a.export_name IS NOT NULL AND a.head_rev > 0`;
async function ownFile(env, p, fid) {
  const a = await env.DB.prepare(`${FILE_SQL} AND a.id = ?`).bind(p.id, fid).first();
  if (!a) throw new HttpError(404, "not_found", "File not found");
  return a;
}
function parseSnapshot(b) {
  const sr = b.source_revision;
  if (typeof sr !== "number" || !Number.isSafeInteger(sr) || sr < 1) throw new HttpError(400, "invalid_input", "source_revision must be an integer between 1 and 2^53-1");
  const src = (v, n) => {
    if (v === void 0 || v === null) return null;
    if (typeof v !== "string" || v.length > 64) throw new HttpError(400, "invalid_input", `${n} must be a string of at most 64 characters`);
    return v;
  };
  const exported_at = src(b.exported_at, "exported_at");
  let coverage = null;
  if (b.coverage !== void 0 && b.coverage !== null) {
    if (typeof b.coverage !== "object" || Array.isArray(b.coverage)) throw new HttpError(400, "invalid_input", "coverage must be an object");
    coverage = { from: src(b.coverage.from, "coverage.from"), to: src(b.coverage.to, "coverage.to") };
  }
  if (!Array.isArray(b.files) || b.files.length < 1 || b.files.length > 8) throw new HttpError(400, "invalid_input", "files must list 1-8 files");
  const names = /* @__PURE__ */ new Set();
  const files = b.files.map((f) => {
    if (!f || typeof f !== "object") throw new HttpError(400, "invalid_input", "each file must be an object");
    if (typeof f.name !== "string" || !NAME_RE.test(f.name)) throw new HttpError(400, "invalid_input", "file name must match [A-Za-z0-9._-]{1,64}");
    if (f.name.toLowerCase() === MANIFEST) throw new HttpError(400, "invalid_input", "manifest.json is reserved for the server");
    if (names.has(f.name)) throw new HttpError(400, "invalid_input", `duplicate file name ${f.name}`);
    names.add(f.name);
    if (f.kind !== "json" && f.kind !== "csv") throw new HttpError(422, "unsupported_kind", "snapshot files must be json or csv");
    const role = f.role ?? (f.kind === "json" ? "authoritative" : "derived");
    if (role !== "authoritative" && role !== "derived") throw new HttpError(400, "invalid_input", "role must be authoritative or derived");
    if (typeof f.content !== "string") throw new HttpError(400, "invalid_input", "content must be a string");
    return { name: f.name, kind: f.kind, role, derived_from: f.derived_from ?? null, schema: f.schema ?? null, content: f.content };
  });
  const auth = files.filter((f) => f.role === "authoritative");
  if (auth.length !== 1 || auth[0].kind !== "json")
    throw new HttpError(422, "invalid_content", "Invalid snapshot: exactly one authoritative json file required", { format: "schema", detail: "exactly one authoritative json file required" });
  for (const f of files) {
    if (f.kind === "csv" && f.role !== "derived") throw new HttpError(422, "invalid_content", "Invalid snapshot: csv files must be derived", { format: "schema", file: f.name, detail: "csv files must be derived" });
    if (f.role === "derived") {
      f.derived_from = f.derived_from ?? auth[0].name;
      if (f.derived_from !== auth[0].name) throw new HttpError(422, "invalid_content", "Invalid snapshot: derived_from must name the authoritative file", { format: "schema", file: f.name, detail: "derived_from must name the authoritative file" });
    } else f.derived_from = null;
  }
  return { source_revision: sr, exported_at, coverage, files };
}
/** Test hooks run only with AC_TEST_HOOKS = "1" on a localhost or 127.0.0.1 host (never in an installation). */
const testHooksOn = (env, req) => env.AC_TEST_HOOKS === "1" && /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(new URL(req.url).host);
/**
 * Test hook: pause for `header` ms (at most 5 s). The pause announces itself in the server log, with the request's
 * x-test-pause-tag, so a race test can act exactly while the request is paused.
 */
async function testPause(env, req, header = "x-test-pause-before-batch-ms") {
  if (!testHooksOn(env, req)) return;
  const ms = Number(req.headers.get(header));
  if (!Number.isInteger(ms) || ms <= 0) return;
  const tag = req.headers.get("x-test-pause-tag");
  console.log(JSON.stringify({ event: "test_pause_entered", tag: tag && /^[A-Za-z0-9_-]{1,40}$/.test(tag) ? tag : null }));
  await new Promise((r) => setTimeout(r, Math.min(ms, 5e3)));
}
var PUB_QUOTA = { files: 32, bytes: 256 * 1024 * 1024 };
/** After a refused snapshot commit: would the publisher quota refuse it, counted as the gate counts (non-generation rows; staged generation bytes)? */
async function snapshotQuotaRefusal(env, publisherId, newCount, addBytes) {
  const q = await env.DB.prepare(`SELECT (SELECT COUNT(*) FROM artifacts WHERE publisher_id = ? AND generation_id IS NULL) AS n,
      (SELECT COALESCE(SUM(r.size), 0) FROM revisions r JOIN artifacts a ON a.id = r.artifact_id WHERE a.publisher_id = ?) AS bytes,
      (SELECT COALESCE(SUM(total_bytes), 0) FROM publisher_generations WHERE publisher_id = ? AND state = 'staged') AS staged`).bind(publisherId, publisherId, publisherId).first();
  if (!q) return false;
  return q.n + newCount > PUB_QUOTA.files || q.bytes + q.staged + addBytes > PUB_QUOTA.bytes;
}
async function commitSnapshot(env, p, req, requestId) {
  const key = idemKey(req.headers.get("idempotency-key"));
  // Authorization before the body: a disabled client or a suspended workspace costs no body read.
  await assertStillAuthorized(env, p);
  const body2 = await readJsonBody(req);
  const ctx = pubCtx(env, p, requestId);
  const digest = await sha256Hex(JSON.stringify(body2));
  const i = { op: "snapshot.commit", key, projectId: p.project_id, digest };
  const prior = await idemLookup(ctx, i);
  if (prior) return prior;
  const snap = parseSnapshot(body2);
  const checked = snap.files.map((f) => ({ ...f, ...checkFile(f.kind, f.content, f.schema, f.name), sha256: "", size: byteLength(f.content) }));
  for (const c of checked) c.sha256 = await sha256Hex(c.content);
  const C2 = p.current_source_revision ?? null;
  const curRow = p.current_snapshot_id ? await env.DB.prepare("SELECT * FROM snapshots WHERE id = ?").bind(p.current_snapshot_id).first() : null;
  const curFiles = curRow ? JSON.parse(curRow.files) : [];
  const conflictExtra = () => ({ current_source_revision: C2, current_snapshot_id: p.current_snapshot_id ?? null, current_files: curFiles.map((f) => ({ name: f.name, sha256: f.sha256 })) });
  if (C2 !== null && snap.source_revision < C2) throw new HttpError(409, "stale_source_revision", "source_revision is older than the current snapshot", conflictExtra());
  if (C2 !== null && snap.source_revision === C2) {
    const same = curFiles.length === checked.length && checked.every((c) => curFiles.some((f) => f.name === c.name && f.kind === c.kind && (f.schema ?? null) === c.schema && f.sha256 === c.sha256 && (f.role ?? null) === c.role));
    if (!same) throw new HttpError(409, "source_revision_conflict", "A different snapshot with this source_revision is already current", conflictExtra());
    return { status: 200, body: { snapshot: snapshotView(curRow, p.current_snapshot_id), already_current: true } };
  }
  const existing = await env.DB.prepare(`SELECT a.id, a.export_name, a.kind, a.schema_id, a.head_rev, a.trashed_at FROM artifacts a WHERE a.publisher_id = ? AND a.generation_id IS NULL`).bind(p.id).all();
  const byName = new Map(existing.results.map((r) => [r.export_name, r]));
  for (const c of checked) {
    const ex = byName.get(c.name);
    if (ex?.trashed_at) throw new HttpError(409, "destination_file_trashed", "The owner moved this app's file to trash; ask the owner to restore it", { name: c.name, file_id: ex.id });
    if (ex && (ex.kind !== c.kind || (ex.schema_id ?? null) !== c.schema)) throw new HttpError(422, "invalid_content", `Invalid snapshot: ${c.name} changed kind or schema`, { format: "schema", file: c.name, detail: "kind and schema of an exported file cannot change" });
  }
  const man = byName.get(MANIFEST);
  if (man?.trashed_at) throw new HttpError(409, "destination_file_trashed", "The owner moved this app's manifest to trash; ask the owner to restore it", { name: MANIFEST, file_id: man.id });
  const az = authzSql(ctx, p.project_id);
  const now = nowIso();
  const snapshotId = randomId("snp", 15);
  const stmts = [];
  const targets = [...checked.map((c) => c.name), MANIFEST];
  const existingTargets = targets.map((n) => byName.get(n)).filter(Boolean);
  const newNames = targets.filter((n) => !byName.has(n));
  const twin = firstCaseTwin(newNames);
  if (twin) throw pathConflictAt(twin.name, twin.conflicts_with);
  const nameRows = newNameConflictRows(p.id, newNames);
  const hit = newNames.length ? await env.DB.prepare(nameRows.sql).bind(...nameRows.params).first() : null;
  if (hit) throw pathConflictAt(hit.name, hit.conflicts_with);
  const nameRule = newNameConflictSql(p.id, newNames);
  const filesStill = existingTargets.map(() => "EXISTS (SELECT 1 FROM artifacts WHERE id = ? AND publisher_id = ? AND project_id = ? AND head_rev = ? AND trashed_at IS NULL)").join(" AND ") || "1";
  const filesParams = existingTargets.flatMap((x) => [x.id, p.id, p.project_id, x.head_rev]);
  const addBytes = checked.reduce((n, c) => n + c.size, 0) + 4096;
  const quota = `(SELECT COUNT(*) FROM artifacts WHERE publisher_id = ? AND generation_id IS NULL) + ? <= ${PUB_QUOTA.files}
    AND (SELECT COALESCE(SUM(r.size), 0) FROM revisions r JOIN artifacts a ON a.id = r.artifact_id WHERE a.publisher_id = ?) + (SELECT COALESCE(SUM(total_bytes),0) FROM publisher_generations WHERE publisher_id = ? AND state='staged') + ? <= ${PUB_QUOTA.bytes}`;
  const quotaParams = [p.id, newNames.length, p.id, p.id, addBytes];
  const lg = await projectLimitGuard(env, p.project_id, { storage_bytes: addBytes }); // workspace storage (Phase 4)
  const noNew = newNames.length ? `NOT EXISTS (SELECT 1 FROM artifacts WHERE publisher_id = ? AND export_name IN (${newNames.map(() => "?").join(",")}))` : "1";
  const noNewParams = newNames.length ? [p.id, ...newNames] : [];
  stmts.push(env.DB.prepare(`UPDATE publishers SET current_snapshot_id = ?, current_source_revision = ?
    WHERE id = ? AND token_epoch = ? AND (current_source_revision IS NULL OR current_source_revision < ?) AND current_snapshot_id IS ? AND ${az.sql} AND ${baseSql(true)}
      AND ${filesStill} AND ${noNew} AND ${nameRule.sql} AND ${quota} AND ${lg.sql}`).bind(snapshotId, snap.source_revision, p.id, p.token_epoch, snap.source_revision, p.current_snapshot_id ?? null, ...az.params, ...baseParams(p), ...filesParams, ...noNewParams, ...nameRule.params, ...quotaParams, ...lg.params));
  const gate = "EXISTS (SELECT 1 FROM publishers WHERE id = ? AND current_snapshot_id = ?)";
  const gp = [p.id, snapshotId];
  await testPause(env, req);
  const outFiles = [];
  const textKeys = [], textWrites = [];
  const bridges = [];
  const writeFile = async (name, kind, schema, content, sha, size) => {
    const ex = byName.get(name);
    const artId = ex?.id ?? randomId("art");
    const nextRev = (ex?.head_rev ?? 0) + 1;
    const revId = randomId("rev");
    if (!ex) {
      stmts.push(env.DB.prepare(`INSERT INTO artifacts (id, project_id, kind, title, folder, folder_id, schema_id, publisher_id, export_name, head_rev, head_revision_id, created_at, updated_at)
        SELECT ?, ?, ?, ?, '', ?, ?, ?, ?, 1, ?, ?, ? WHERE ${gate}`).bind(artId, p.project_id, kind, name, p.folder_id ?? null, schema, p.id, name, revId, now, now, ...gp));
    } else {
      stmts.push(env.DB.prepare(`UPDATE artifacts SET head_rev = ?, head_revision_id = ?, updated_at = ? WHERE id = ? AND head_rev = ? AND trashed_at IS NULL AND ${gate}`).bind(nextRev, revId, now, artId, ex.head_rev, ...gp));
    }
    const bodyKey = textKey(p.project_id, artId, revId);
    textKeys.push(bodyKey);
    textWrites.push({ projectId: p.project_id, artifactId: artId, revisionId: revId, text: content });
    bridges.push(textSearchBridge(env, artId, revId, content), textWriteComplete(env, bodyKey));
    stmts.push(env.DB.prepare(`INSERT INTO revisions (id, artifact_id, project_id, rev_no, author_id, body, body_key, size, sha256, mime, created_at, via_kind, via_id, via_label)
      SELECT ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'publisher', ?, ? WHERE ${gate} AND EXISTS (SELECT 1 FROM artifacts WHERE id = ? AND head_revision_id = ?)`).bind(revId, artId, p.project_id, nextRev, p.principal_id, bodyKey, size, sha, MIME[kind], now, p.id, String(p.display_name ?? "").slice(0, 120) || null, ...gp, artId, revId));
    return { artId, nextRev };
  };
  for (const c of checked) {
    const w = await writeFile(c.name, c.kind, c.schema, c.content, c.sha256, c.size);
    outFiles.push({
      name: c.name,
      file_id: w.artId,
      kind: c.kind,
      role: c.role,
      derived_from: c.derived_from,
      schema: c.schema,
      revision: w.nextRev,
      sha256: c.sha256,
      size: c.size,
      record_count: c.record_count,
      row_count: c.row_count
    });
  }
  const manifestDoc = {
    manifest_version: "agentlib.snapshot-manifest/1",
    publisher_id: p.id,
    snapshot_id: snapshotId,
    source_revision: snap.source_revision,
    committed_at: now,
    exported_at: snap.exported_at,
    coverage: snap.coverage,
    files: outFiles
  };
  const manifestText = JSON.stringify(manifestDoc, null, 2) + "\n";
  const manSha = await sha256Hex(manifestText);
  const mw = await writeFile(MANIFEST, "json", null, manifestText, manSha, byteLength(manifestText));
  const row = {
    id: snapshotId,
    publisher_id: p.id,
    source_revision: snap.source_revision,
    committed_at: now,
    exported_at: snap.exported_at,
    coverage: snap.coverage ? JSON.stringify(snap.coverage) : null,
    manifest_file_id: mw.artId,
    manifest_revision: mw.nextRev,
    manifest_sha256: manSha,
    files: JSON.stringify(outFiles)
  };
  stmts.push(env.DB.prepare(`INSERT INTO snapshots (id, publisher_id, source_revision, committed_at, exported_at, coverage, manifest_file_id, manifest_revision, manifest_sha256, files)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${gate}`).bind(row.id, row.publisher_id, row.source_revision, row.committed_at, row.exported_at, row.coverage, row.manifest_file_id, row.manifest_revision, row.manifest_sha256, row.files, ...gp));
  const respBody = { snapshot: snapshotView(row, snapshotId), already_current: false };
  stmts.push(env.DB.prepare(`INSERT INTO idempotency (principal_id, project_id, op, key, digest, status, response, created_at) SELECT ?, ?, ?, ?, ?, 201, ?, ? WHERE ${gate}`).bind(p.principal_id, p.project_id, i.op, key, digest, JSON.stringify(respBody), now, ...gp));
  stmts.push(env.DB.prepare(`INSERT INTO audits (at, actor_id, project_id, action, object_id, rev_no, result, request_id) SELECT ?, ?, ?, 'snapshot.commit', ?, ?, 'ok', ? WHERE ${gate}`).bind(now, p.principal_id, p.project_id, snapshotId, snap.source_revision, requestId, ...gp));
  await stageTextWrites(env, textWrites);
  let res;
  try {
    res = await commitTextWrites(env, textKeys, (guarded) => env.DB.batch(guarded([...stmts, ...bridges])));
  } catch (e) {
    const replay = await idemLookup(ctx, i).catch(() => null);
    if (replay) return replay;
    if (/UNIQUE constraint/i.test(String(e?.message))) throw new HttpError(409, "conflict", "A concurrent snapshot commit won; re-read /publisher/me and retry");
    throw e;
  }
  if (!res[0].meta.changes) {
    await assertStillAuthorized(env, p);
    const fresh = await livePublisher(env, { publisher_id: p.id, epoch: p.token_epoch });
    if (fresh?.revoked) throw new HttpError(401, "publisher_revoked", "This publisher has been revoked by the owner");
    if (!fresh) throw new HttpError(401, "unauthenticated", "Token is no longer valid; reconnect the app");
    if (fresh.disabled) throw new HttpError(401, "unauthenticated", APP_DISABLED);
    for (const x of existingTargets) {
      const now2 = await env.DB.prepare("SELECT trashed_at FROM artifacts WHERE id = ?").bind(x.id).first();
      if (now2?.trashed_at) throw new HttpError(409, "destination_file_trashed", "The owner moved this app's file to trash; ask the owner to restore it", { name: x.export_name, file_id: x.id });
    }
    if (await snapshotQuotaRefusal(env, p.id, newNames.length, addBytes))
      throw new HttpError(413, "quota_exceeded", "This app has reached its storage quota in the library; ask the owner", { max_files: PUB_QUOTA.files, max_bytes: PUB_QUOTA.bytes });
    if (lg.workspaceId) await explainLimit(env, lg.workspaceId, { storage_bytes: addBytes }, lg.limits);
    const late = newNames.length ? await env.DB.prepare(nameRows.sql).bind(...nameRows.params).first() : null;
    if (late) throw pathConflictAt(late.name, late.conflicts_with);
    throw new HttpError(409, "conflict", "A concurrent snapshot commit won; re-read /publisher/me and retry");
  }
  if (res.some((r, idx) => idx > 0 && !r.meta.changes)) {
    console.error("snapshot_commit_partial", requestId);
    throw new HttpError(500, "internal", "Snapshot commit inconsistency");
  }
  return { status: 201, body: respBody };
}
async function route(req, env, execCtx, p, requestId) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/$/, "");
  const m = req.method;
  const write = m !== "GET" && m !== "HEAD";
  const wsId = p.workspace_id ?? await projectWorkspaceId(env, p.project_id);
  await rateLimit(env, `${write ? "w" : "r"}:${p.principal_id}`, await agentRate(env, wsId, write));
  // Before the trailing-slash strip: App Files checks the raw path itself.
  if (isAppFilesPath(url.pathname)) return routeAppFiles(req, env, execCtx, p, requestId, wsId);
  const only = (method) => {
    if (m !== method && !(method === "GET" && m === "HEAD")) throw new HttpError(405, "method_not_allowed", "Method not allowed");
  };
  const generationResponse = await routeGeneration(req, env, p, requestId);
  if (generationResponse) return generationResponse;
  let g;
  if (path === "/v1/publisher/connection-info") {
    only("GET");
    if (url.search) throw new HttpError(400, "invalid_input", "This diagnostic accepts no parameters");
    const project = await env.DB.prepare("SELECT id, title FROM projects WHERE id = ?").bind(p.project_id).first();
    // Reuse the actual publisher write gate; metadata reads remain available when writes are blocked.
    let canWrite = true, writeRestrictions = [];
    try { await assertStillAuthorized(env, p); }
    catch (e) {
      if (!(e instanceof HttpError) || ![401, 403].includes(e.status)) throw e;
      canWrite = false;
      writeRestrictions.push("Writes blocked: " + e.message);
    }
    return json(connectionInfo("publisher", p.id, p.display_name, [], null, null, {
      destination: { project_id: project.id, title: project.title, folder_id: p.folder_id, can_read_own_files: true, can_write_own_files: canWrite },
      restrictions: ["Only this publisher's own files in its approved destination; no general project browsing.", "Kind rules, quotas, revisions and snapshot ordering still apply. No rendering, transfer or write was tested."].concat(writeRestrictions)
    }), 200, { "cache-control": "no-store" });
  }
  if (R.me.test(path)) {
    only("GET");
    return json(await me(env, p));
  }
  if (R.files.test(path)) {
    only("GET");
    const off = url.searchParams.get("cursor") ? int(Number(url.searchParams.get("cursor")), "cursor", 0, 1e5) : 0;
    const rows = await env.DB.prepare(`${FILE_SQL} ORDER BY a.export_name LIMIT 101 OFFSET ?`).bind(p.id, off).all();
    const names = await currentNames(env, p);
    return json({ files: rows.results.slice(0, 100).map((a) => fileView(env, p, a, names)), next_cursor: rows.results.length > 100 ? String(off + 100) : null });
  }
  if (g = R.file.exec(path)) {
    only("GET");
    return json(fileView(env, p, await ownFile(env, p, g[1]), await currentNames(env, p)));
  }
  if (g = R.content.exec(path)) {
    only("GET");
    const a = await ownFile(env, p, g[1]);
    const revQ = url.searchParams.get("revision");
    const revNo = revQ !== null ? int(Number(revQ), "revision", 1) : a.head_rev;
    const r = await env.DB.prepare("SELECT body, body_key, mime, sha256 FROM revisions WHERE artifact_id = ? AND rev_no = ?").bind(a.id, revNo).first();
    if (!r) throw new HttpError(404, "not_found", "File not found");
    const bytes = new TextEncoder().encode(await getText(env, r));
    return new Response(m === "HEAD" ? null : bytes, { status: 200, headers: {
      "content-type": servedContentType(r.mime),
      "content-length": String(bytes.length),
      etag: `"${r.sha256}"`,
      "content-disposition": `attachment; filename="${a.export_name}"`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'; sandbox"
    } });
  }
  if (R.snapshots.test(path)) {
    if (m === "POST") {
      const r = await commitSnapshot(env, p, req, requestId);
      return json(r.body, r.status);
    }
    only("GET");
    const limit = url.searchParams.get("limit") ? int(Number(url.searchParams.get("limit")), "limit", 1, 100) : 20;
    const cur = url.searchParams.get("cursor");
    const before = cur !== null ? int(Number(cur), "cursor", 1) : Number.MAX_SAFE_INTEGER;
    const rows = await env.DB.prepare("SELECT * FROM snapshots WHERE publisher_id = ? AND source_revision < ? ORDER BY source_revision DESC LIMIT ?").bind(p.id, before, limit + 1).all();
    const page = rows.results.slice(0, limit);
    return json({ snapshots: page.map((r) => snapshotView(r, p.current_snapshot_id ?? null)), next_cursor: rows.results.length > limit ? String(page[page.length - 1].source_revision) : null });
  }
  if (R.current.test(path)) {
    only("GET");
    if (!p.current_snapshot_id) return json({ snapshot: null });
    const row = await env.DB.prepare("SELECT * FROM snapshots WHERE id = ?").bind(p.current_snapshot_id).first();
    return json({ snapshot: row ? snapshotView(row, p.current_snapshot_id) : null });
  }
  if (g = R.snapshot.exec(path)) {
    only("GET");
    const row = await env.DB.prepare("SELECT * FROM snapshots WHERE id = ? AND publisher_id = ?").bind(g[1], p.id).first();
    if (!row) throw new HttpError(404, "not_found", "Snapshot not found");
    return json({ snapshot: snapshotView(row, p.current_snapshot_id ?? null) });
  }
  throw new HttpError(404, "not_found", "Not found");
}
async function handlePublisherApi(req, env, ctx) {
  const requestId = randomId("req", 9);
  const fail = (e) => {
    const h = { "x-request-id": requestId };
    if (e.status === 401) h["www-authenticate"] = `Bearer error="invalid_token"${e.code === "publisher_revoked" ? ', error_description="revoked"' : ""}`;
    if (e.status === 403 && e.code === "insufficient_scope") h["www-authenticate"] = `Bearer error="insufficient_scope", scope="${SCOPES.publish}"`;
    if ((e.status === 429 || e.status === 503) && e.extra?.retry_after_seconds) h["retry-after"] = String(e.extra.retry_after_seconds);
    const b = errorBody(e);
    b.error.request_id = requestId;
    return slotsHeader(json(b, e.status, h));
  };
  // Test hook: every App Files answer reports the isolate's held body slots.
  const slotsHeader = (r) => {
    if (testHooksOn(env, req) && isAppFilesPath(new URL(req.url).pathname)) {
      r.headers.set("x-test-slots-in-use", String(appFilesSlotsInUse()));
      r.headers.set("x-test-drains-in-use", String(appFilesDrainsInUse()));
    }
    return r;
  };
  try {
    if (req.headers.get("cookie")) throw new HttpError(400, "invalid_request", "Cookies are not accepted on the API");
    if (!ctx.auth.scope.includes(SCOPES.publish)) throw new HttpError(403, "insufficient_scope", "Token lacks agentlib:publish");
    const p = await livePublisher(env, ctx.props).catch(() => null);
    if (!p) throw new HttpError(401, "unauthenticated", "Token is no longer valid; reconnect the app");
    if (p.revoked) throw new HttpError(401, "publisher_revoked", "This publisher has been revoked by the owner");
    if (p.disabled) throw new HttpError(401, "unauthenticated", APP_DISABLED);
    const pathname = new URL(req.url).pathname;
    const routed = await route(req, env, ctx, p, requestId);
    // App Files content carries stored bytes: never rewritten (lists are, like every other JSON answer).
    const res = isAppFileContentPath(pathname) ? routed : await addressLinksResponse(env, routed, pathname, [p.project_id]);
    const r = new Response(res.body, res);
    r.headers.set("x-request-id", requestId);
    return slotsHeader(r);
  } catch (e) {
    if (e instanceof HttpError) return fail(e);
    console.error("publisher_unhandled", requestId, e?.name ?? "error");
    return json({ error: { code: "internal", message: "Internal error", request_id: requestId } }, 500, { "x-request-id": requestId });
  }
}

export { assertStillAuthorized, handlePublisherApi, pubCtx, snapshotQuotaRefusal, testHooksOn, testPause };
