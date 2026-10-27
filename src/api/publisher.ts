// App Connect publisher API (contract app-connect/0.4 §9): /v1/publisher/* for publisher access tokens only.
// Token audience {ISSUER}/v1 and scope agentlib:publish are verified by the library resource server before this
// runs; here: live publisher row (revocation, token epoch, app client enabled), own-files-only reads, and atomic
// complete-snapshot commits with monotonic source_revision ordering.
import type { OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import type { Ctx, Env } from "../auth";
import { rateLimit, limitsFor, authzSql } from "../auth";
import { checkFile, MIME, CONTENT_TYPE, byteLength } from "../formats";
import { appOrigin, artifactWebUrl, previewWebUrl } from "../links";
import { idemLookup, LIMITS, type Idem } from "../service";
import { errorBody, HttpError, idemKey, int, json, nowIso, randomId, sha256Hex, str } from "../util";
import { livePublisher, SCOPES, type PubProps } from "../oauth/server";

import { routeGeneration, GENERATION_CONTRACT } from "./generations";

const MAX_BODY = 6_500_000;
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MANIFEST = "manifest.json";
const ID = "([A-Za-z0-9_-]{1,64})";
const R = {
  me: /^\/v1\/publisher\/me$/,
  files: /^\/v1\/publisher\/files$/,
  file: new RegExp(`^/v1/publisher/files/${ID}$`),
  content: new RegExp(`^/v1/publisher/files/${ID}/content$`),
  snapshots: /^\/v1\/publisher\/snapshots$/,
  current: /^\/v1\/publisher\/snapshots\/current$/,
  snapshot: new RegExp(`^/v1/publisher/snapshots/(snp_[A-Za-z0-9_-]{1,64})$`),
};

type Pub = Record<string, any>;

async function readJsonBody(req: Request): Promise<any> {
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/json");
  const declared = req.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= MAX_BODY)) throw new HttpError(413, "too_large", "Request body too large");
  const reader = req.body?.getReader();
  const parts: Uint8Array[] = []; let n = 0;
  if (reader) for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > MAX_BODY) { await reader.cancel().catch(() => {}); throw new HttpError(413, "too_large", "Request body too large"); }
    parts.push(value);
  }
  const buf = new Uint8Array(n); let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.byteLength; }
  try {
    const v = n ? JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(buf)) : null;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw 0;
    return v;
  } catch { throw new HttpError(400, "invalid_json", "Body must be a JSON object"); }
}

function pubCtx(env: Env, p: Pub, requestId: string): Ctx {
  return { env, requestId, publisher: true, principal: { id: p.principal_id, kind: "agent", label: `publisher:${p.display_name}` },
    grant: { id: p.id, project_id: p.project_id, can_write: 1 } };
}

const fileView = (env: Env, p: Pub, a: any, currentNames: Set<string>) => {
  const o = appOrigin(env.APP_HOST);
  return { file_id: a.id, name: a.export_name, kind: a.kind, schema: a.schema_id ?? null, revision: a.head_rev, sha256: a.sha256, size: a.size,
    in_current_snapshot: currentNames.has(a.export_name), trashed: !!a.trashed_at, updated_at: a.updated_at,
    ...(o ? { web_url: artifactWebUrl(o, a.project_id, a.id), preview_url: previewWebUrl(o, a.project_id, a.id) } : {}) };
};

function snapshotView(row: any, currentId: string | null) {
  return { snapshot_id: row.id, publisher_id: row.publisher_id, source_revision: row.source_revision,
    status: row.id === currentId ? "current" : "previous", committed_at: row.committed_at,
    exported_at: row.exported_at ?? null, coverage: row.coverage ? JSON.parse(row.coverage) : null,
    manifest: { file_id: row.manifest_file_id, revision: row.manifest_revision, sha256: row.manifest_sha256 },
    files: JSON.parse(row.files) };
}

async function currentNames(env: Env, p: Pub): Promise<Set<string>> {
  if (!p.current_snapshot_id) return new Set();
  const s = await env.DB.prepare("SELECT files FROM snapshots WHERE id = ?").bind(p.current_snapshot_id).first<string>("files");
  return new Set([MANIFEST, ...((s ? JSON.parse(s) : []) as any[]).map((f) => f.name)]);
}

async function me(env: Env, p: Pub) {
  const proj = await env.DB.prepare("SELECT id, title FROM projects WHERE id = ?").bind(p.project_id).first<any>();
  const f = p.folder_id ? await env.DB.prepare("SELECT id, name FROM folders WHERE id = ?").bind(p.folder_id).first<any>() : null;
  return { publisher_id: p.id, app_client_id: p.apc_id, client_id: p.client_id, display_name: p.display_name, status: "active",
    project: { id: proj.id, title: proj.title },
    destination: f ? { type: "folder", folder_id: f.id, name: f.name } : { type: "root" },
    current_source_revision: p.current_source_revision ?? null, current_snapshot_id: p.current_snapshot_id ?? null,
    created_at: p.created_at, resumed_at: p.resumed_at ?? null, token_epoch: p.token_epoch, generation_contract: GENERATION_CONTRACT, retention: { ...JSON.parse(p.retention), auto_prune_enabled: false } };
}

const FILE_SQL = `SELECT a.*, r.sha256, r.size FROM artifacts a LEFT JOIN revisions r ON r.id = a.head_revision_id
  WHERE a.publisher_id = ? AND a.head_rev > 0`;

async function ownFile(env: Env, p: Pub, fid: string) {
  const a = await env.DB.prepare(`${FILE_SQL} AND a.id = ?`).bind(p.id, fid).first<any>();
  if (!a) throw new HttpError(404, "not_found", "File not found");
  return a;
}

// ---------- snapshot commit ----------
type InFile = { name: string; kind: "json" | "csv"; role: "authoritative" | "derived"; derived_from: string | null; schema: string | null; content: string };

function parseSnapshot(b: any): { source_revision: number; exported_at: string | null; coverage: { from: string | null; to: string | null } | null; files: InFile[] } {
  const sr = b.source_revision;
  if (typeof sr !== "number" || !Number.isSafeInteger(sr) || sr < 1) throw new HttpError(400, "invalid_input", "source_revision must be an integer between 1 and 2^53-1");
  const src = (v: unknown, n: string) => {
    if (v === undefined || v === null) return null;
    if (typeof v !== "string" || v.length > 64) throw new HttpError(400, "invalid_input", `${n} must be a string of at most 64 characters`);
    return v;
  };
  const exported_at = src(b.exported_at, "exported_at");
  let coverage = null;
  if (b.coverage !== undefined && b.coverage !== null) {
    if (typeof b.coverage !== "object" || Array.isArray(b.coverage)) throw new HttpError(400, "invalid_input", "coverage must be an object");
    coverage = { from: src(b.coverage.from, "coverage.from"), to: src(b.coverage.to, "coverage.to") };
  }
  if (!Array.isArray(b.files) || b.files.length < 1 || b.files.length > 8) throw new HttpError(400, "invalid_input", "files must list 1-8 files");
  const names = new Set<string>();
  const files: InFile[] = b.files.map((f: any) => {
    if (!f || typeof f !== "object") throw new HttpError(400, "invalid_input", "each file must be an object");
    if (typeof f.name !== "string" || !NAME_RE.test(f.name)) throw new HttpError(400, "invalid_input", "file name must match [A-Za-z0-9._-]{1,64}");
    if (f.name === MANIFEST) throw new HttpError(400, "invalid_input", "manifest.json is reserved for the server");
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

/**
 * Test-only: deterministic race window between pre-checks and the atomic batch. Active only with AC_TEST_HOOKS=1
 * (never in wrangler.toml; a test asserts that) AND a loopback host. Bounded to 5 s.
 */
async function testPause(env: Env, req: Request) {
  if ((env as any).AC_TEST_HOOKS !== "1" || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(new URL(req.url).host)) return;
  const ms = Number(req.headers.get("x-test-pause-before-batch-ms"));
  if (Number.isInteger(ms) && ms > 0) await new Promise((r) => setTimeout(r, Math.min(ms, 5000)));
}

/** Per-publisher storage quota (all retained versions; nothing is ever pruned automatically). Local values. */
export const PUB_QUOTA = { files: 32, bytes: 256 * 1024 * 1024 };

async function commitSnapshot(env: Env, p: Pub, req: Request, requestId: string) {
  const key = idemKey(req.headers.get("idempotency-key"));
  const body = await readJsonBody(req);
  const ctx = pubCtx(env, p, requestId);
  const digest = await sha256Hex(JSON.stringify(body));
  const i: Idem = { op: "snapshot.commit", key, projectId: p.project_id, digest };
  const prior = await idemLookup(ctx, i);
  if (prior) return prior;

  const snap = parseSnapshot(body);
  // Validate every file before touching anything.
  const checked = snap.files.map((f) => ({ ...f, ...checkFile(f.kind, f.content, f.schema, f.name), sha256: "", size: byteLength(f.content) }));
  for (const c of checked) c.sha256 = await sha256Hex(c.content);

  const C: number | null = p.current_source_revision ?? null;
  const curRow = p.current_snapshot_id ? await env.DB.prepare("SELECT * FROM snapshots WHERE id = ?").bind(p.current_snapshot_id).first<any>() : null;
  const curFiles: any[] = curRow ? JSON.parse(curRow.files) : [];
  const conflictExtra = () => ({ current_source_revision: C, current_snapshot_id: p.current_snapshot_id ?? null, current_files: curFiles.map((f) => ({ name: f.name, sha256: f.sha256 })) });
  if (C !== null && snap.source_revision < C) throw new HttpError(409, "stale_source_revision", "source_revision is older than the current snapshot", conflictExtra());
  if (C !== null && snap.source_revision === C) {
    const same = curFiles.length === checked.length && checked.every((c) => curFiles.some((f) =>
      f.name === c.name && f.kind === c.kind && (f.schema ?? null) === c.schema && f.sha256 === c.sha256 && (f.role ?? null) === c.role));
    if (!same) throw new HttpError(409, "source_revision_conflict", "A different snapshot with this source_revision is already current", conflictExtra());
    return { status: 200, body: { snapshot: snapshotView(curRow, p.current_snapshot_id), already_current: true } };
  }

  // Map names to the publisher's stable files (create on first use, in its destination).
  const existing = await env.DB.prepare(`SELECT a.id, a.export_name, a.kind, a.schema_id, a.head_rev, a.trashed_at FROM artifacts a WHERE a.publisher_id = ? AND a.generation_id IS NULL`).bind(p.id).all<any>();
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
  const stmts: D1PreparedStatement[] = [];
  // Every existing file this commit writes (snapshot files + manifest) must still be exactly as pre-checked:
  // same head revision, not trashed, still owned by this publisher. And no new file of these names may have
  // appeared. Folded into gate 1, so if anything changed in between (owner trash, concurrent commit) the pointer
  // does not move and every later statement (all gated on the pointer) writes nothing.
  const targets = [...checked.map((c) => c.name), MANIFEST];
  const existingTargets = targets.map((n) => byName.get(n)).filter(Boolean) as any[];
  const newNames = targets.filter((n) => !byName.has(n));
  const filesStill = existingTargets.map(() => "EXISTS (SELECT 1 FROM artifacts WHERE id = ? AND publisher_id = ? AND project_id = ? AND head_rev = ? AND trashed_at IS NULL)").join(" AND ") || "1";
  const filesParams = existingTargets.flatMap((x) => [x.id, p.id, p.project_id, x.head_rev]);
  // Per-publisher quota (contract §9.2 "quota"): distinct files and total stored bytes, checked in the gate.
  const addBytes = checked.reduce((n, c) => n + c.size, 0) + 4096; // + manifest upper bound
  const quota = `(SELECT COUNT(*) FROM artifacts WHERE publisher_id = ? AND generation_id IS NULL) + ? <= ${PUB_QUOTA.files}
      AND (SELECT COALESCE(SUM(r.size), 0) FROM revisions r JOIN artifacts a ON a.id = r.artifact_id WHERE a.publisher_id = ?) + (SELECT COALESCE(SUM(total_bytes),0) FROM publisher_generations WHERE publisher_id = ? AND state='staged') + ? <= ${PUB_QUOTA.bytes}`;
  const quotaParams = [p.id, newNames.length, p.id, p.id, addBytes];
  const noNew = newNames.length ? `NOT EXISTS (SELECT 1 FROM artifacts WHERE publisher_id = ? AND export_name IN (${newNames.map(() => "?").join(",")}))` : "1";
  const noNewParams = newNames.length ? [p.id, ...newNames] : [];
  // Gate 1 (first statement): publisher still live, ordering still holds, nobody committed in between, files intact.
  stmts.push(env.DB.prepare(`UPDATE publishers SET current_snapshot_id = ?, current_source_revision = ?
      WHERE id = ? AND token_epoch = ? AND (current_source_revision IS NULL OR current_source_revision < ?) AND current_snapshot_id IS ? AND ${az.sql}
        AND ${filesStill} AND ${noNew} AND ${quota}`)
    .bind(snapshotId, snap.source_revision, p.id, p.token_epoch, snap.source_revision, p.current_snapshot_id ?? null, ...az.params, ...filesParams, ...noNewParams, ...quotaParams));
  const gate = "EXISTS (SELECT 1 FROM publishers WHERE id = ? AND current_snapshot_id = ?)";
  const gp = [p.id, snapshotId];
  await testPause(env, req);
  const outFiles: any[] = [];
  const writeFile = (name: string, kind: string, schema: string | null, content: string, sha: string, size: number) => {
    const ex = byName.get(name);
    const artId = ex?.id ?? randomId("art");
    const nextRev = (ex?.head_rev ?? 0) + 1;
    const revId = randomId("rev");
    if (!ex) {
      stmts.push(env.DB.prepare(`INSERT INTO artifacts (id, project_id, kind, title, folder, folder_id, schema_id, publisher_id, export_name, head_rev, head_revision_id, created_at, updated_at)
          SELECT ?, ?, ?, ?, '', ?, ?, ?, ?, 1, ?, ?, ? WHERE ${gate}`)
        .bind(artId, p.project_id, kind, name, p.folder_id ?? null, schema, p.id, name, revId, now, now, ...gp));
    } else {
      stmts.push(env.DB.prepare(`UPDATE artifacts SET head_rev = ?, head_revision_id = ?, updated_at = ? WHERE id = ? AND head_rev = ? AND trashed_at IS NULL AND ${gate}`)
        .bind(nextRev, revId, now, artId, ex.head_rev, ...gp));
    }
    stmts.push(env.DB.prepare(`INSERT INTO revisions (id, artifact_id, project_id, rev_no, author_id, body, size, sha256, mime, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${gate} AND EXISTS (SELECT 1 FROM artifacts WHERE id = ? AND head_revision_id = ?)`)
      .bind(revId, artId, p.project_id, nextRev, p.principal_id, content, size, sha, MIME[kind], now, ...gp, artId, revId));
    return { artId, nextRev };
  };
  for (const c of checked) {
    const w = writeFile(c.name, c.kind, c.schema, c.content, c.sha256, c.size);
    outFiles.push({ name: c.name, file_id: w.artId, kind: c.kind, role: c.role, derived_from: c.derived_from, schema: c.schema,
      revision: w.nextRev, sha256: c.sha256, size: c.size, record_count: c.record_count, row_count: c.row_count });
  }
  const manifestDoc = { manifest_version: "agentlib.snapshot-manifest/1", publisher_id: p.id, snapshot_id: snapshotId, source_revision: snap.source_revision,
    committed_at: now, exported_at: snap.exported_at, coverage: snap.coverage, files: outFiles };
  const manifestText = JSON.stringify(manifestDoc, null, 2) + "\n";
  const manSha = await sha256Hex(manifestText);
  const mw = writeFile(MANIFEST, "json", null, manifestText, manSha, byteLength(manifestText));
  const row = { id: snapshotId, publisher_id: p.id, source_revision: snap.source_revision, committed_at: now, exported_at: snap.exported_at,
    coverage: snap.coverage ? JSON.stringify(snap.coverage) : null, manifest_file_id: mw.artId, manifest_revision: mw.nextRev, manifest_sha256: manSha, files: JSON.stringify(outFiles) };
  stmts.push(env.DB.prepare(`INSERT INTO snapshots (id, publisher_id, source_revision, committed_at, exported_at, coverage, manifest_file_id, manifest_revision, manifest_sha256, files)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${gate}`)
    .bind(row.id, row.publisher_id, row.source_revision, row.committed_at, row.exported_at, row.coverage, row.manifest_file_id, row.manifest_revision, row.manifest_sha256, row.files, ...gp));
  const respBody = { snapshot: snapshotView(row, snapshotId), already_current: false };
  stmts.push(env.DB.prepare(`INSERT INTO idempotency (principal_id, project_id, op, key, digest, status, response, created_at) SELECT ?, ?, ?, ?, ?, 201, ?, ? WHERE ${gate}`)
    .bind(p.principal_id, p.project_id, i.op, key, digest, JSON.stringify(respBody), now, ...gp));
  stmts.push(env.DB.prepare(`INSERT INTO audits (at, actor_id, project_id, action, object_id, rev_no, result, request_id) SELECT ?, ?, ?, 'snapshot.commit', ?, ?, 'ok', ? WHERE ${gate}`)
    .bind(now, p.principal_id, p.project_id, snapshotId, snap.source_revision, requestId, ...gp));

  let res: D1Result[];
  try { res = await env.DB.batch(stmts); }
  catch (e: any) {
    // A concurrent commit (unique source_revision / head revision) rolled the whole batch back. Anything else
    // (size limits, foreign keys, outages) is not a conflict: surface it as an internal error (nothing written).
    const replay = await idemLookup(ctx, i).catch(() => null);
    if (replay) return replay;
    if (/UNIQUE constraint/i.test(String(e?.message))) throw new HttpError(409, "conflict", "A concurrent snapshot commit won; re-read /publisher/me and retry");
    throw e;
  }
  if (!res[0].meta.changes) {
    // Nothing was written (gate 1 failed). Report why.
    const fresh = await livePublisher(env, { publisher_id: p.id, epoch: p.token_epoch });
    if (fresh?.revoked) throw new HttpError(401, "publisher_revoked", "This publisher has been revoked by the owner");
    if (!fresh) throw new HttpError(401, "unauthenticated", "Token is no longer valid; reconnect the app");
    for (const x of existingTargets) {
      const now2 = await env.DB.prepare("SELECT trashed_at FROM artifacts WHERE id = ?").bind(x.id).first<any>();
      if (now2?.trashed_at) throw new HttpError(409, "destination_file_trashed", "The owner moved this app's file to trash; ask the owner to restore it", { name: x.export_name, file_id: x.id });
    }
    const q = await env.DB.prepare(`SELECT (SELECT COUNT(*) FROM artifacts WHERE publisher_id = ?) AS n,
        (SELECT COALESCE(SUM(r.size), 0) FROM revisions r JOIN artifacts a ON a.id = r.artifact_id WHERE a.publisher_id = ?) AS bytes`).bind(p.id, p.id).first<any>();
    if (q && (q.n + newNames.length > PUB_QUOTA.files || q.bytes + addBytes > PUB_QUOTA.bytes))
      throw new HttpError(413, "quota_exceeded", "This app has reached its storage quota in the library; ask the owner", { max_files: PUB_QUOTA.files, max_bytes: PUB_QUOTA.bytes });
    throw new HttpError(409, "conflict", "A concurrent snapshot commit won; re-read /publisher/me and retry");
  }
  // Defence in depth: every gated write must have landed (all-or-nothing is guaranteed by the gate; verify anyway).
  if (res.some((r, idx) => idx > 0 && !r.meta.changes)) {
    console.error("snapshot_commit_partial", requestId);
    throw new HttpError(500, "internal", "Snapshot commit inconsistency");
  }
  return { status: 201, body: respBody };
}

// ---------- router ----------
async function route(req: Request, env: Env, p: Pub, requestId: string): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/$/, "");
  const m = req.method;
  const write = m !== "GET" && m !== "HEAD";
  const lim = limitsFor(env);
  await rateLimit(env, `${write ? "w" : "r"}:${p.principal_id}`, write ? lim.writesPerMin : lim.readsPerMin);
  const only = (method: string) => { if (m !== method && !(method === "GET" && m === "HEAD")) throw new HttpError(405, "method_not_allowed", "Method not allowed"); };
  const generationResponse=await routeGeneration(req,env,p,requestId);if(generationResponse)return generationResponse;
  let g: RegExpExecArray | null;
  if (R.me.test(path)) { only("GET"); return json(await me(env, p)); }
  if (R.files.test(path)) {
    only("GET");
    const off = url.searchParams.get("cursor") ? int(Number(url.searchParams.get("cursor")), "cursor", 0, 100000) : 0;
    const rows = await env.DB.prepare(`${FILE_SQL} ORDER BY a.export_name LIMIT 101 OFFSET ?`).bind(p.id, off).all<any>();
    const names = await currentNames(env, p);
    return json({ files: rows.results.slice(0, 100).map((a) => fileView(env, p, a, names)), next_cursor: rows.results.length > 100 ? String(off + 100) : null });
  }
  if ((g = R.file.exec(path))) { only("GET"); return json(fileView(env, p, await ownFile(env, p, g[1]), await currentNames(env, p))); }
  if ((g = R.content.exec(path))) {
    only("GET");
    const a = await ownFile(env, p, g[1]);
    const revQ = url.searchParams.get("revision");
    const revNo = revQ !== null ? int(Number(revQ), "revision", 1) : a.head_rev;
    const r = await env.DB.prepare("SELECT body, mime, sha256 FROM revisions WHERE artifact_id = ? AND rev_no = ?").bind(a.id, revNo).first<any>();
    if (!r) throw new HttpError(404, "not_found", "File not found");
    const bytes = new TextEncoder().encode(r.body);
    return new Response(m === "HEAD" ? null : bytes, { status: 200, headers: {
      "content-type": CONTENT_TYPE[r.mime] ?? r.mime, "content-length": String(bytes.length), etag: `"${r.sha256}"`,
      "content-disposition": `attachment; filename="${a.export_name}"`, "x-content-type-options": "nosniff", "cache-control": "private, no-store",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'; sandbox" } });
  }
  if (R.snapshots.test(path)) {
    if (m === "POST") { const r = await commitSnapshot(env, p, req, requestId); return json(r.body, r.status); }
    only("GET");
    const limit = url.searchParams.get("limit") ? int(Number(url.searchParams.get("limit")), "limit", 1, 100) : 20;
    const cur = url.searchParams.get("cursor");
    const before = cur !== null ? int(Number(cur), "cursor", 1) : Number.MAX_SAFE_INTEGER;
    const rows = await env.DB.prepare("SELECT * FROM snapshots WHERE publisher_id = ? AND source_revision < ? ORDER BY source_revision DESC LIMIT ?").bind(p.id, before, limit + 1).all<any>();
    const page = rows.results.slice(0, limit);
    return json({ snapshots: page.map((r) => snapshotView(r, p.current_snapshot_id ?? null)), next_cursor: rows.results.length > limit ? String(page[page.length - 1].source_revision) : null });
  }
  if (R.current.test(path)) {
    only("GET");
    if (!p.current_snapshot_id) return json({ snapshot: null });
    const row = await env.DB.prepare("SELECT * FROM snapshots WHERE id = ?").bind(p.current_snapshot_id).first<any>();
    return json({ snapshot: row ? snapshotView(row, p.current_snapshot_id) : null });
  }
  if ((g = R.snapshot.exec(path))) {
    only("GET");
    const row = await env.DB.prepare("SELECT * FROM snapshots WHERE id = ? AND publisher_id = ?").bind(g[1], p.id).first<any>();
    if (!row) throw new HttpError(404, "not_found", "Snapshot not found");
    return json({ snapshot: snapshotView(row, p.current_snapshot_id ?? null) });
  }
  throw new HttpError(404, "not_found", "Not found");
}

/** OAuthResourceServer handler for {ISSUER}/v1 (publisher tokens). */
export async function handlePublisherApi(req: Request, env: Env, ctx: OAuthResourceContext<PubProps>): Promise<Response> {
  const requestId = randomId("req", 9);
  const fail = (e: HttpError) => {
    const h: Record<string, string> = { "x-request-id": requestId };
    if (e.status === 401) h["www-authenticate"] = `Bearer error="invalid_token"${e.code === "publisher_revoked" ? ', error_description="revoked"' : ""}`;
    if (e.status === 403 && e.code === "insufficient_scope") h["www-authenticate"] = `Bearer error="insufficient_scope", scope="${SCOPES.publish}"`;
    if (e.status === 429 && e.extra?.retry_after_seconds) h["retry-after"] = String(e.extra.retry_after_seconds);
    const b = errorBody(e) as any; b.error.request_id = requestId;
    return json(b, e.status, h);
  };
  try {
    if (req.headers.get("cookie")) throw new HttpError(400, "invalid_request", "Cookies are not accepted on the API");
    if (!ctx.auth.scope.includes(SCOPES.publish)) throw new HttpError(403, "insufficient_scope", "Token lacks agentlib:publish");
    const p = await livePublisher(env, ctx.props).catch(() => null);
    if (!p) throw new HttpError(401, "unauthenticated", "Token is no longer valid; reconnect the app");
    if (p.revoked) throw new HttpError(401, "publisher_revoked", "This publisher has been revoked by the owner");
    const res = await route(req, env, p, requestId);
    const r = new Response(res.body, res);
    r.headers.set("x-request-id", requestId);
    return r;
  } catch (e) {
    if (e instanceof HttpError) return fail(e);
    console.error("publisher_unhandled", requestId, (e as Error)?.name ?? "error");
    return json({ error: { code: "internal", message: "Internal error", request_id: requestId } }, 500, { "x-request-id": requestId });
  }
}
