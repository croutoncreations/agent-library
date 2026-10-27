// Bounded staged generations (local App Connect contract extension, agentlib.generations/1).
// Parts are staged invisibly in publisher_generation_parts. Commit verifies the complete index closure, then ONE
// gated D1 batch moves the publisher pointer (CAS + live publisher + token epoch + project/folder scope + quotas)
// and materializes every part, plus a small immutable server manifest, as new json artifacts and a snapshots row.
// If the gate fails, every later statement (all gated on the new pointer) writes nothing.
// Legacy /publisher/snapshots behaviour and its 32-file quota are unchanged (generation artifacts are excluded).
// Cleanup touches only uncommitted (staged-expired or abandoned) generations of the calling publisher.
import type { Env, Ctx } from "../auth";
import { authzSql } from "../auth";
import { checkFile, byteLength } from "../formats";
import { HttpError, json, nowIso, randomId, sha256Hex, idemKey } from "../util";
export const GENERATION_CONTRACT = {
    version: "agentlib.generations/1", max_part_bytes: 32768, max_parts: 2048, max_generation_bytes: 33554432,
    max_staged_generations: 2, staging_ttl_ms: 86400000, max_retained_bytes: 268435456, max_retained_parts: 16384,
    max_index_bytes: 2097152, max_name_chars: 128, name_pattern: "[A-Za-z0-9._-]{1,128}", generation_id_pattern: "g_[A-Za-z0-9_-]{1,62}",
    index_format: "agentlib.generation.index/1", part_format: "agentlib.generation.part/1", auto_prune_committed: false,
} as const;
const C = GENERATION_CONTRACT;
// Format names accepted from clients. The original names from the first App Connect client stay valid forever,
// so existing exporters keep working; new clients should use the agentlib.* names in GENERATION_CONTRACT.
const INDEX_FORMATS = [C.index_format, "healthconnect.readable.index/1"] as const;
const PART_FORMATS = [C.part_format, "healthconnect.readable.part/1"] as const;
const isIndex = (f: unknown) => (INDEX_FORMATS as readonly unknown[]).includes(f);
const isPart = (f: unknown) => (PART_FORMATS as readonly unknown[]).includes(f);
const NAME = /^[A-Za-z0-9._-]{1,128}$/;
const GID = /^g_[A-Za-z0-9_-]{1,62}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_REQUEST = 262144; // a 32 KiB part JSON-escaped (<= 6 bytes/char) plus envelope
const MAX_DEPTH = 8;
type Pub = Record<string, any>;
const bad = (message: string): never => { throw new HttpError(400, "invalid_input", message); };
const conflict = (message: string, extra?: Record<string, unknown>): never => { throw new HttpError(409, "generation_conflict", message, extra); };
const invalidClosure = (detail: string, file?: string): never => {
    throw new HttpError(422, "invalid_content", `Invalid generation: ${detail}`, { format: "schema", detail, ...(file ? { file } : {}) });
};
const isUnique = (e: unknown) => /UNIQUE constraint|PRIMARY KEY/i.test(String((e as any)?.message));
const manifestName = (gid: string) => `${gid}.manifest.json`;
/** Test-only clock offset and lowered retained quotas: AC_TEST_HOOKS=1 AND loopback host only (as testPause). */
function hooks(env: Env, req: Request) {
    const on = (env as any).AC_TEST_HOOKS === "1" && /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(new URL(req.url).host);
    const n = (h: string) => { const raw = req.headers.get(h); const v = on && raw !== null ? Number(raw) : NaN; return Number.isSafeInteger(v) ? v : null; };
    const off = n("x-test-clock-offset-ms") ?? 0;
    const lower = (h: string, max: number) => { const v = n(h); return v !== null && v >= 0 && v < max ? v : max; };
    return { now: Date.now() + off, maxRetainedParts: lower("x-test-max-retained-parts", C.max_retained_parts), maxRetainedBytes: lower("x-test-max-retained-bytes", C.max_retained_bytes) };
}
async function body(req: Request) {
    if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json"))
        throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/json");
    const declared = req.headers.get("content-length");
    if (declared !== null && !(Number(declared) <= MAX_REQUEST))
        throw new HttpError(413, "too_large", "Generation request too large");
    let n = 0;
    const chunks: Uint8Array[] = [];
    const reader = req.body?.getReader();
    if (reader)
        for (;;) {
            const r = await reader.read();
            if (r.done)
                break;
            n += r.value.length;
            if (n > MAX_REQUEST) {
                await reader.cancel().catch(() => { });
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
    }
    catch {
        return bad("Body must be a JSON object");
    }
}
const context = (env: Env, p: Pub, requestId: string): Ctx => ({ env, requestId, publisher: true,
    principal: { id: p.principal_id, kind: "agent", label: `publisher:${p.display_name}` }, grant: { id: p.id, project_id: p.project_id, can_write: 1 } });
/** Own generation only (publisher_id key), and still bound to the publisher's project/folder. */
async function generation(env: Env, p: Pub, id: string) {
    const g = await env.DB.prepare("SELECT * FROM publisher_generations WHERE publisher_id = ? AND id = ?").bind(p.id, id).first<any>();
    if (!g)
        throw new HttpError(404, "not_found", "Generation not found");
    if (g.project_id !== p.project_id || (g.folder_id ?? null) !== (p.folder_id ?? null))
        throw new HttpError(403, "scope_mismatch", "Generation scope mismatch");
    return g;
}
/** Deletes only uncommitted staging of this publisher: expired staged or explicitly abandoned. Never committed rows. */
async function cleanup(env: Env, p: Pub, now: number) {
    const sel = "SELECT id FROM publisher_generations WHERE publisher_id = ? AND state != 'committed' AND ((state = 'staged' AND expires_at < ?) OR state = 'abandoned')";
    await env.DB.batch([
        env.DB.prepare(`DELETE FROM publisher_generation_parts WHERE publisher_id = ? AND artifact_id IS NULL AND generation_id IN (${sel})`).bind(p.id, p.id, now),
        env.DB.prepare(`DELETE FROM publisher_generations WHERE publisher_id = ? AND state != 'committed' AND snapshot_id IS NULL AND ((state = 'staged' AND expires_at < ?) OR state = 'abandoned')`).bind(p.id, now),
    ]);
}
// Retained = all stored revisions of this publisher (legacy + generation) + reserved bytes of staged generations.
const RETAINED_BYTES = `((SELECT COALESCE(SUM(r.size), 0) FROM revisions r JOIN artifacts a ON a.id = r.artifact_id WHERE a.publisher_id = ?)
  + (SELECT COALESCE(SUM(total_bytes), 0) FROM publisher_generations WHERE publisher_id = ? AND state = 'staged'))`;
// Retained parts = materialized generation artifacts (incl. server manifests) + reserved parts (+1 manifest) of staged generations.
const RETAINED_PARTS = `((SELECT COUNT(*) FROM artifacts WHERE publisher_id = ? AND generation_id IS NOT NULL)
  + (SELECT COALESCE(SUM(part_count + 1), 0) FROM publisher_generations WHERE publisher_id = ? AND state = 'staged'))`;
const MANIFEST_RESERVE = 4096;
function beginFields(b: any) {
    const ok = GID.test(b.generation_id) && Number.isSafeInteger(b.source_revision) && b.source_revision >= 1 && typeof b.root_name === "string" && NAME.test(b.root_name)
        && typeof b.root_sha256 === "string" && HASH.test(b.root_sha256) && Number.isSafeInteger(b.part_count) && b.part_count >= 1 && b.part_count <= C.max_parts
        && Number.isSafeInteger(b.total_bytes) && b.total_bytes >= 1 && b.total_bytes <= C.max_generation_bytes && b.total_bytes <= b.part_count * C.max_part_bytes;
    if (!ok)
        bad("Invalid generation bounds/identity");
    if (b.root_name === manifestName(b.generation_id))
        bad("root_name is reserved");
    const exp = b.expected_current_snapshot_id;
    if (exp !== null && (typeof exp !== "string" || !/^snp_[A-Za-z0-9_-]{1,64}$/.test(exp)))
        bad("expected_current_snapshot_id must be null or a snapshot id");
    if (b.exported_at !== undefined && b.exported_at !== null && (typeof b.exported_at !== "string" || b.exported_at.length > 64))
        bad("Invalid exported_at");
    let coverage: {
        from: string;
        to: string;
    } | null = null;
    if (b.coverage !== undefined && b.coverage !== null) {
        if (typeof b.coverage !== "object" || Array.isArray(b.coverage) || ["from", "to"].some((k) => typeof b.coverage[k] !== "string" || b.coverage[k].length > 64))
            bad("Invalid coverage");
        coverage = { from: b.coverage.from, to: b.coverage.to };
    }
    return { generation_id: b.generation_id as string, source_revision: b.source_revision as number, expected_current_snapshot_id: exp as string | null,
        root_name: b.root_name as string, root_sha256: b.root_sha256 as string, part_count: b.part_count as number, total_bytes: b.total_bytes as number,
        coverage, exported_at: (b.exported_at ?? null) as string | null };
}
const beginView = (g: any) => ({ generation_id: g.id, state: g.state, source_revision: g.source_revision, expected_current_snapshot_id: g.expected_current_snapshot_id,
    root_name: g.root_name, root_sha256: g.root_sha256, part_count: g.part_count, total_bytes: g.total_bytes,
    expires_at: g.state === "staged" ? new Date(g.expires_at).toISOString() : null, snapshot_id: g.snapshot_id ?? null });
async function assertStillAuthorized(env: Env, p: Pub) {
    const row = await env.DB.prepare(`SELECT pb.token_epoch,pb.revoked_at,pb.project_id,pb.folder_id,ac.disabled_at AS client_disabled,
      pj.owner_id,pb.owner_principal_id,CASE WHEN pb.folder_id IS NULL THEN 1 ELSE EXISTS(SELECT 1 FROM folders f WHERE f.id=pb.folder_id AND f.project_id=pb.project_id) END AS folder_valid
      FROM publishers pb JOIN app_clients ac ON ac.id=pb.app_client_id JOIN projects pj ON pj.id=pb.project_id WHERE pb.id=?`).bind(p.id).first<any>();
    if (!row || row.revoked_at !== null || row.client_disabled !== null || row.token_epoch !== p.token_epoch) throw new HttpError(401,"unauthenticated","Publisher/client revoked or token superseded; reconnect required");
    if (row.project_id !== p.project_id || (row.folder_id ?? null) !== (p.folder_id ?? null) || row.owner_id !== row.owner_principal_id || !row.folder_valid) throw new HttpError(403,"scope_mismatch","Publisher destination unavailable or changed");
}
async function begin(env: Env, p: Pub, req: Request) {
    idemKey(req.headers.get("idempotency-key"));
    const h = hooks(env, req);
    const f = beginFields(await body(req));
    const digest = await sha256Hex(JSON.stringify(f)); // canonical field order: exact-metadata retries replay
    await cleanup(env, p, h.now); // recreate expired invisible staging from the same immutable outbox; committed rows untouched
    const replay = async () => {
        const prior = await env.DB.prepare("SELECT * FROM publisher_generations WHERE publisher_id = ? AND id = ?").bind(p.id, f.generation_id).first<any>();
        if (!prior)
            return null;
        if (prior.begin_digest !== digest)
            conflict("Generation metadata is immutable", { generation_id: f.generation_id, state: prior.state });
        await generation(env, p, f.generation_id); // scope check
        return json({ ...beginView(prior), idempotent_replay: true }, 200);
    };
    const r0 = await replay();
    if (r0)
        return r0;
    const az = authzSql(context(env, p, "generation-begin"), p.project_id);
    let changes = 0;
    try {
        const r = await env.DB.prepare(`INSERT INTO publisher_generations (publisher_id, id, project_id, folder_id, token_epoch, source_revision, expected_current_snapshot_id,
        root_name, root_sha256, part_count, total_bytes, coverage, exported_at, begin_digest, state, created_at, expires_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'staged', ?, ?
      WHERE EXISTS (SELECT 1 FROM publishers WHERE id = ? AND token_epoch = ? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM app_clients c WHERE c.id=publishers.app_client_id AND c.disabled_at IS NULL) AND (folder_id IS NULL OR EXISTS (SELECT 1 FROM folders f WHERE f.id=publishers.folder_id AND f.project_id=publishers.project_id)) AND project_id = ? AND folder_id IS ?) AND ${az.sql}
        AND (SELECT COUNT(*) FROM publisher_generations WHERE publisher_id = ? AND state = 'staged') < ${C.max_staged_generations}
        AND ${RETAINED_BYTES} + ? <= ? AND ${RETAINED_PARTS} + ? <= ?`)
            .bind(p.id, f.generation_id, p.project_id, p.folder_id ?? null, p.token_epoch, f.source_revision, f.expected_current_snapshot_id, f.root_name, f.root_sha256, f.part_count, f.total_bytes, f.coverage ? JSON.stringify(f.coverage) : null, f.exported_at, digest, nowIso(), h.now + C.staging_ttl_ms, p.id, p.token_epoch, p.project_id, p.folder_id ?? null, ...az.params, p.id, p.id, p.id, f.total_bytes + MANIFEST_RESERVE, h.maxRetainedBytes, p.id, p.id, f.part_count + 1, h.maxRetainedParts).run();
        changes = r.meta.changes ?? 0;
    }
    catch (e) {
        if (!isUnique(e))
            throw e;
        const r1 = await replay();
        if (r1)
            return r1; // concurrent identical begin
        throw e;
    }
    if (!changes) {
        await assertStillAuthorized(env,p);
        const staged = await env.DB.prepare("SELECT COUNT(*) AS n FROM publisher_generations WHERE publisher_id = ? AND state = 'staged'").bind(p.id).first<number>("n");
        if ((staged ?? 0) >= C.max_staged_generations)
            throw new HttpError(409, "too_many_staged_generations", "Two generations are already staged; commit or DELETE one", { max_staged_generations: C.max_staged_generations });
        throw new HttpError(413, "quota_exceeded", "Retained generation quota or authorization check failed; nothing was staged", { max_retained_bytes: h.maxRetainedBytes, max_retained_parts: h.maxRetainedParts });
    }
    const g = await generation(env, p, f.generation_id);
    return json(beginView(g), 201);
}
async function put(env: Env, p: Pub, id: string, name: string, req: Request) {
    if (!NAME.test(name))
        bad("Invalid part name");
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
    const finite = (v: any): boolean => typeof v === "number" ? Number.isFinite(v) : v && typeof v === "object" ? Object.values(v).every(finite) : true;
    if (!finite(doc)) invalidClosure("Nonfinite JSON number", name);
    if (!doc || typeof doc !== "object" || Array.isArray(doc))
        invalidClosure("part must be a JSON object", name);
    if (doc.generation_id !== id)
        invalidClosure("part generation_id does not match", name);
    const g = await generation(env, p, id);
    if (doc.source_revision !== g.source_revision)
        invalidClosure("part source_revision does not match", name);
    const existing = async () => {
        const prior = await env.DB.prepare("SELECT sha256, bytes FROM publisher_generation_parts WHERE publisher_id = ? AND generation_id = ? AND name = ?").bind(p.id, id, name).first<any>();
        if (!prior)
            return null;
        if (prior.sha256 !== b.sha256 || prior.bytes !== size)
            conflict("Part name is immutable", { name });
        return json({ name, sha256: prior.sha256, size: prior.bytes, state: g.state, idempotent_replay: true }, 200); // also after commit
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
        AND (SELECT COALESCE(SUM(bytes), 0) FROM publisher_generation_parts WHERE publisher_id = ? AND generation_id = ?) + ? <= ?`)
            .bind(p.id, id, name, b.sha256, size, b.content, nowIso(), p.id, id, h.now, p.id, p.token_epoch, ...az.params, p.id, id, g.part_count, p.id, id, size, g.total_bytes).run();
        changes = r.meta.changes ?? 0;
    }
    catch (e) {
        if (!isUnique(e))
            throw e;
        const r1 = await existing();
        if (r1)
            return r1; // concurrent identical PUT
        throw e;
    }
    if (!changes) {
        await assertStillAuthorized(env,p);
        conflict("Generation part count/bytes exceed its declaration, or the generation/authorization changed");
    }
    return json({ name, sha256: b.sha256, size, state: "staged" }, 201);
}
type PartMeta = {
    name: string;
    sha256: string;
    bytes: number;
    format: string | null;
    gid: unknown;
    rev: unknown;
    body: string | null;
};
/** Verifies the root/index closure: every part reachable exactly once, hashes/bytes match, kinds consistent, no cycles. */
function verifyClosure(g: any, parts: PartMeta[]) {
    const byName = new Map(parts.map((x) => [x.name, x]));
    const root = byName.get(g.root_name);
    if (!root || root.sha256 !== g.root_sha256)
        conflict("Root part missing or checksum differs from begin", { root_name: g.root_name });
    if (!isIndex(root!.format))
        invalidClosure(`root must be a ${C.index_format} document`, g.root_name);
    const visited = new Set<string>([g.root_name]);
    const walk = (part: PartMeta, depth: number) => {
        if (depth > MAX_DEPTH)
            invalidClosure(`index depth exceeds ${MAX_DEPTH}`, part.name);
        let doc: any;
        try {
            doc = JSON.parse(part.body!);
        }
        catch {
            invalidClosure("index is not JSON", part.name);
        }
        if (!isIndex(doc.format) || doc.generation_id !== g.id || doc.source_revision !== g.source_revision)
            invalidClosure("index identity mismatch", part.name);
        if (!Array.isArray(doc.entries) || doc.entries.length > C.max_parts)
            invalidClosure("index entries must be an array of at most 2048", part.name);
        for (const e of doc.entries) {
            if (!e || typeof e !== "object" || typeof e.name !== "string" || !NAME.test(e.name) || typeof e.sha256 !== "string" || !HASH.test(e.sha256)
                || !Number.isSafeInteger(e.bytes) || typeof e.kind !== "string" || !e.kind || e.kind.length > 64 || (e.count !== undefined && (!Number.isSafeInteger(e.count) || e.count < 0)))
                invalidClosure("index entry requires name, sha256, bytes, kind and optional non-negative count", part.name);
            if (e.utf8_bytes !== undefined && e.utf8_bytes !== e.bytes)
                invalidClosure(`entry ${e.name} utf8_bytes differs from bytes`, part.name);
            const child = byName.get(e.name);
            if (!child)
                invalidClosure(`entry ${e.name} was not uploaded`, part.name);
            if (child!.sha256 !== e.sha256 || child!.bytes !== e.bytes)
                invalidClosure(`entry ${e.name} sha256/bytes mismatch`, part.name);
            if (visited.has(e.name))
                invalidClosure(`entry ${e.name} referenced more than once (cycle or duplicate)`, part.name);
            visited.add(e.name);
            if (child!.gid !== g.id || child!.rev !== g.source_revision)
                invalidClosure(`entry ${e.name} generation identity mismatch`, part.name);
            if (e.kind === "index") {
                if (!isIndex(child!.format))
                    invalidClosure(`entry ${e.name} declared index but is not an index`, part.name);
                walk(child!, depth + 1);
            }
            else if (!isPart(child!.format))
                invalidClosure(`entry ${e.name} must be a ${C.part_format} payload`, part.name);
        }
    };
    walk(root!, 0);
    if (visited.size !== parts.length)
        invalidClosure(`${parts.length - visited.size} uploaded part(s) are not reachable from the root`);
    return root!;
}
async function commit(env: Env, p: Pub, id: string, req: Request, requestId: string) {
    idemKey(req.headers.get("idempotency-key"));
    const h = hooks(env, req);
    const b = await body(req);
    if (Object.keys(b).length)
        bad("Commit body must be {}");
    const g = await generation(env, p, id);
    // A committed generation always replays its original receipt, even after newer generations became current.
    if (g.state === "committed")
        return json({ ...JSON.parse(g.receipt), idempotent_replay: true }, 200);
    if (g.state !== "staged" || g.expires_at < h.now)
        conflict("Generation expired or abandoned", { state: g.state });
    const indexBytes = await env.DB.prepare("SELECT COALESCE(SUM(bytes),0) AS n FROM publisher_generation_parts WHERE publisher_id=? AND generation_id=? AND json_extract(body,'$.format') IN (?,?)").bind(p.id,id,...INDEX_FORMATS).first<number>("n");
    if ((indexBytes ?? 0) > C.max_index_bytes) throw new HttpError(413,"index_too_large","Index tree exceeds bounded verification memory",{max_index_bytes:C.max_index_bytes});
    // Only index bodies are loaded; payload identity was verified at PUT and is re-read here via SQL.
    const rows = await env.DB.prepare(`SELECT name, sha256, bytes, json_extract(body, '$.format') AS format, json_extract(body, '$.generation_id') AS gid,
      json_extract(body, '$.source_revision') AS rev, CASE WHEN json_extract(body, '$.format') IN (?, ?) THEN body END AS body
    FROM publisher_generation_parts WHERE publisher_id = ? AND generation_id = ? ORDER BY name`).bind(...INDEX_FORMATS, p.id, id).all<PartMeta>();
    const parts = rows.results;
    const sum = parts.reduce((n, x) => n + x.bytes, 0);
    if (parts.length !== g.part_count || sum !== g.total_bytes)
        conflict("Generation incomplete", { uploaded_parts: parts.length, part_count: g.part_count, uploaded_bytes: sum, total_bytes: g.total_bytes });
    const root = verifyClosure(g, parts);
    const now = nowIso();
    const sid = randomId("snp", 15);
    const ids: Record<string, {
        a: string;
        r: string;
    }> = {};
    for (const x of parts)
        ids[x.name] = { a: randomId("art"), r: randomId("rev") };
    const files = parts.map((x) => ({ name: x.name, file_id: ids[x.name].a, kind: "json", role: x.name === g.root_name ? "authoritative" : "payload",
        derived_from: null, schema: null, revision: 1, sha256: x.sha256, size: x.bytes }));
    const coverage = g.coverage ? JSON.parse(g.coverage) : null;
    const mName = manifestName(id);
    const mArt = randomId("art");
    const mRev = randomId("rev");
    const manifestText = JSON.stringify({ manifest_version: "agentlib.generation-manifest/1", publisher_id: p.id, snapshot_id: sid, generation_id: id,
        source_revision: g.source_revision, committed_at: now, exported_at: g.exported_at, coverage,
        root: { name: g.root_name, file_id: ids[g.root_name].a, revision: 1, sha256: root.sha256, size: root.bytes },
        part_count: parts.length, total_bytes: g.total_bytes }, null, 2) + "\n";
    const mSha = await sha256Hex(manifestText);
    const mSize = byteLength(manifestText);
    if (mSize > C.max_part_bytes) throw new HttpError(413,"manifest_too_large","Server manifest exceeds readable byte cap");
    const receipt = { snapshot: { snapshot_id: sid, publisher_id: p.id, generation_id: id, source_revision: g.source_revision, status: "current", committed_at: now,
            exported_at: g.exported_at, coverage, manifest: { name: mName, file_id: mArt, revision: 1, sha256: mSha, size: mSize },
            root: { name: g.root_name, file_id: ids[g.root_name].a, sha256: root.sha256, size: root.bytes }, files }, already_current: false };
    const receiptText = JSON.stringify(receipt);
    const az = authzSql(context(env, p, requestId), p.project_id);
    const idsJson = JSON.stringify(ids);
    const gate = "EXISTS (SELECT 1 FROM publishers WHERE id = ? AND current_snapshot_id = ?)";
    const gp = [p.id, sid];
    const q: D1PreparedStatement[] = [];
    // Gate: live publisher/epoch/scope, CAS on the expected pointer, monotonic revision, still staged + unexpired with the
    // exact verified part set, retained quotas, and no name collision with any existing artifact of this publisher.
    q.push(env.DB.prepare(`UPDATE publishers SET current_snapshot_id = ?, current_source_revision = ?
    WHERE id = ? AND token_epoch = ? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM app_clients c WHERE c.id=publishers.app_client_id AND c.disabled_at IS NULL) AND (folder_id IS NULL OR EXISTS (SELECT 1 FROM folders f WHERE f.id=publishers.folder_id AND f.project_id=publishers.project_id)) AND project_id = ? AND folder_id IS ? AND current_snapshot_id IS ?
      AND (current_source_revision IS NULL OR current_source_revision < ?) AND ${az.sql}
      AND EXISTS (SELECT 1 FROM publisher_generations WHERE publisher_id = ? AND id = ? AND state = 'staged' AND expires_at >= ? AND project_id = ? AND folder_id IS ?)
      AND (SELECT COUNT(*) FROM publisher_generation_parts WHERE publisher_id = ? AND generation_id = ? AND artifact_id IS NULL) = ?
      AND ${RETAINED_PARTS} <= ? AND ${RETAINED_BYTES} + ? <= ?
      AND NOT EXISTS (SELECT 1 FROM publisher_generation_parts t JOIN artifacts a ON a.publisher_id = ? AND a.export_name = t.name WHERE t.publisher_id = ? AND t.generation_id = ?)
      AND NOT EXISTS (SELECT 1 FROM artifacts WHERE publisher_id = ? AND export_name = ?)`)
        .bind(sid, g.source_revision, p.id, p.token_epoch, p.project_id, p.folder_id ?? null, g.expected_current_snapshot_id, g.source_revision, ...az.params, p.id, id, h.now, p.project_id, p.folder_id ?? null, p.id, id, parts.length, p.id, p.id, h.maxRetainedParts, p.id, p.id, mSize, h.maxRetainedBytes, p.id, p.id, id, p.id, mName));
    q.push(env.DB.prepare(`INSERT INTO artifacts (id, project_id, kind, title, folder, folder_id, schema_id, publisher_id, export_name, generation_id, head_rev, head_revision_id, created_at, updated_at)
    SELECT json_extract(j.value, '$.a'), ?, 'json', t.name, '', ?, NULL, ?, t.name, ?, 1, json_extract(j.value, '$.r'), ?, ?
    FROM json_each(?) j JOIN publisher_generation_parts t ON t.publisher_id = ? AND t.generation_id = ? AND t.name = j.key WHERE ${gate}`)
        .bind(p.project_id, p.folder_id ?? null, p.id, id, now, now, idsJson, p.id, id, ...gp));
    q.push(env.DB.prepare(`INSERT INTO revisions (id, artifact_id, project_id, rev_no, author_id, body, size, sha256, mime, created_at)
    SELECT json_extract(j.value, '$.r'), json_extract(j.value, '$.a'), ?, 1, ?, t.body, t.bytes, t.sha256, 'application/json', ?
    FROM json_each(?) j JOIN publisher_generation_parts t ON t.publisher_id = ? AND t.generation_id = ? AND t.name = j.key WHERE ${gate}`)
        .bind(p.project_id, p.principal_id, now, idsJson, p.id, id, ...gp));
    q.push(env.DB.prepare(`INSERT INTO artifacts (id, project_id, kind, title, folder, folder_id, schema_id, publisher_id, export_name, generation_id, head_rev, head_revision_id, created_at, updated_at)
    SELECT ?, ?, 'json', ?, '', ?, NULL, ?, ?, ?, 1, ?, ?, ? WHERE ${gate}`)
        .bind(mArt, p.project_id, mName, p.folder_id ?? null, p.id, mName, id, mRev, now, now, ...gp));
    q.push(env.DB.prepare(`INSERT INTO revisions (id, artifact_id, project_id, rev_no, author_id, body, size, sha256, mime, created_at)
    SELECT ?, ?, ?, 1, ?, ?, ?, ?, 'application/json', ? WHERE ${gate}`)
        .bind(mRev, mArt, p.project_id, p.principal_id, manifestText, mSize, mSha, now, ...gp));
    q.push(env.DB.prepare(`UPDATE publisher_generation_parts AS t SET body = NULL, artifact_id = json_extract(j.value, '$.a'), revision_id = json_extract(j.value, '$.r')
    FROM json_each(?) j WHERE t.publisher_id = ? AND t.generation_id = ? AND t.name = j.key AND ${gate}`).bind(idsJson, p.id, id, ...gp));
    q.push(env.DB.prepare(`INSERT INTO snapshots (id, publisher_id, source_revision, committed_at, exported_at, coverage, manifest_file_id, manifest_revision, manifest_sha256, files)
    SELECT ?, ?, ?, ?, ?, ?, ?, 1, ?, ? WHERE ${gate}`)
        .bind(sid, p.id, g.source_revision, now, g.exported_at, g.coverage, mArt, mSha, JSON.stringify(files), ...gp));
    q.push(env.DB.prepare(`UPDATE publisher_generations SET state = 'committed', snapshot_id = ?, receipt = ?, committed_at = ? WHERE publisher_id = ? AND id = ? AND state = 'staged' AND ${gate}`)
        .bind(sid, receiptText, now, p.id, id, ...gp));
    q.push(env.DB.prepare(`INSERT INTO audits (at, actor_id, project_id, action, object_id, rev_no, result, request_id) SELECT ?, ?, ?, 'generation.commit', ?, ?, 'ok', ? WHERE ${gate}`)
        .bind(now, p.principal_id, p.project_id, sid, g.source_revision, requestId, ...gp));
    let res: D1Result[];
    try {
        res = await env.DB.batch(q);
    }
    catch (e) {
        const again = await generation(env, p, id).catch(() => null);
        if (again?.state === "committed")
            return json({ ...JSON.parse(again.receipt), idempotent_replay: true }, 200);
        if (isUnique(e))
            conflict("A concurrent commit or name collision won; nothing was written");
        throw e;
    }
    if (!res[0].meta.changes) {
        await assertStillAuthorized(env,p);
        const again = await generation(env, p, id).catch(() => null);
        if (again?.state === "committed")
            return json({ ...JSON.parse(again.receipt), idempotent_replay: true }, 200);
        const pub = await env.DB.prepare("SELECT current_snapshot_id, current_source_revision, revoked_at, token_epoch FROM publishers WHERE id = ?").bind(p.id).first<any>();
        if (!pub || pub.revoked_at !== null || pub.token_epoch !== p.token_epoch)
            throw new HttpError(401, "unauthenticated", "Publisher revoked or token superseded; nothing was written");
        if ((pub.current_snapshot_id ?? null) !== (g.expected_current_snapshot_id ?? null) || (pub.current_source_revision !== null && pub.current_source_revision >= g.source_revision))
            throw new HttpError(409, "stale_generation", "Current snapshot changed since this generation began; nothing was written", { current_snapshot_id: pub.current_snapshot_id ?? null, current_source_revision: pub.current_source_revision ?? null, expected_current_snapshot_id: g.expected_current_snapshot_id });
        const clash = await env.DB.prepare(`SELECT a.export_name FROM publisher_generation_parts t JOIN artifacts a ON a.publisher_id = ? AND a.export_name = t.name WHERE t.publisher_id = ? AND t.generation_id = ? LIMIT 1`).bind(p.id, p.id, id).first<string>("export_name");
        if (clash)
            conflict("A part name already exists as a file of this publisher", { name: clash });
        throw new HttpError(413, "quota_exceeded", "Retained generation quota exceeded or generation changed; nothing was written", { max_retained_bytes: h.maxRetainedBytes, max_retained_parts: h.maxRetainedParts });
    }
    const expect = [1, parts.length, parts.length, 1, 1, parts.length, 1, 1, 1];
    if (res.some((r, i) => (r.meta.changes ?? 0) !== expect[i])) {
        console.error("generation_commit_partial", requestId);
        throw new HttpError(500, "internal", "Generation commit inconsistency");
    }
    return json(receipt, 201);
}
async function view(env: Env, p: Pub, id: string) {
    const g = await generation(env, p, id);
    const rows = await env.DB.prepare("SELECT name, sha256, bytes AS size, artifact_id AS file_id FROM publisher_generation_parts WHERE publisher_id = ? AND generation_id = ? ORDER BY name LIMIT ?")
        .bind(p.id, id, C.max_parts).all();
    return json({ ...beginView(g), uploaded_parts: rows.results.length, parts: rows.results });
}
async function abandon(env: Env, p: Pub, id: string, req: Request) {
    const h = hooks(env, req);
    const g = await generation(env, p, id);
    if (g.state === "committed")
        conflict("Committed generations cannot be deleted", { snapshot_id: g.snapshot_id });
    await env.DB.prepare("UPDATE publisher_generations SET state = 'abandoned', abandoned_at = ? WHERE publisher_id = ? AND id = ? AND state = 'staged'").bind(nowIso(), p.id, id).run();
    const after = await generation(env, p, id);
    if (after.state === "committed")
        conflict("Committed generations cannot be deleted", { snapshot_id: after.snapshot_id });
    await cleanup(env, p, h.now);
    return json({ generation_id: id, state: "abandoned", deleted_staging: true });
}
/** Returns null for non-generation paths so the legacy router handles them unchanged. */
export async function routeGeneration(req: Request, env: Env, p: Pub, requestId: string): Promise<Response | null> {
    const path = new URL(req.url).pathname.replace(/\/$/, "");
    if ((path === "/v1/publisher/generations" || path.startsWith("/v1/publisher/generations/")) && p.client_disabled !== null) throw new HttpError(401,"unauthenticated","App client is disabled; generation access requires an enabled client");
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
