// Human-only export and restore-into-empty-store. Excludes sessions, grants/tokens, idempotency and
// transfer capabilities. Restore verifies schema, hashes and key shape; grants stay absent (re-authorize).
import { requireHuman, type Ctx } from "./auth";
import { HttpError, nowIso, sha256Hex } from "./util";

const SCHEMA = "agent-library-backup/1";
const b64 = (b: Uint8Array) => { let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function exportBackup(ctx: Ctx, projectId: string) {
  requireHuman(ctx);
  const DB = ctx.env.DB;
  const p = await DB.prepare("SELECT * FROM projects WHERE id = ? AND owner_id = ?").bind(projectId, ctx.principal.id).first<any>();
  if (!p) throw new HttpError(404, "not_found", "Project not found");
  // App Connect: the Phase 1 backup format can't carry publisher ownership, folders or snapshots. Refuse rather
  // than produce a backup that would restore app exports without source protection (contract §13a.4).
  const pubFiles = await DB.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE project_id = ? AND publisher_id IS NOT NULL").bind(projectId).first<number>("n").catch(() => 0);
  if (pubFiles) throw new HttpError(409, "backup_unsupported", "This project contains app exports; backup of App Connect projects is not supported yet");
  // A single D1 batch executes as one transaction, giving a consistent snapshot of all tables.
  const [arts, revs, comments] = await DB.batch([
    DB.prepare("SELECT id, kind, title, folder, tags, head_rev, head_revision_id, meta_version, trashed_at, created_at, updated_at FROM artifacts WHERE project_id = ? AND head_rev > 0").bind(projectId),
    DB.prepare("SELECT id, artifact_id, rev_no, author_id, body, blob_key, size, sha256, mime, restored_from, created_at FROM revisions WHERE project_id = ?").bind(projectId),
    DB.prepare("SELECT id, artifact_id, rev_no, author_id, body, created_at FROM comments WHERE project_id = ?").bind(projectId),
  ]);
  const blobs: Record<string, { sha256: string; data: string }> = {};
  for (const r of revs.results as any[]) {
    if (!r.blob_key || blobs[r.blob_key]) continue;
    const o = await ctx.env.BLOBS.get(r.blob_key);
    if (!o) throw new HttpError(500, "blob_missing", "Referenced blob missing during export");
    const bytes = new Uint8Array(await o.arrayBuffer());
    const sha = await sha256Hex(bytes);
    if (sha !== r.sha256) throw new HttpError(500, "blob_corrupt", "Stored blob hash mismatch");
    blobs[r.blob_key] = { sha256: sha, data: b64(bytes) };
  }
  await DB.prepare("INSERT INTO audits (at, actor_id, project_id, action, object_id, result, request_id) VALUES (?, ?, ?, 'backup.export', ?, 'ok', ?)")
    .bind(nowIso(), ctx.principal.id, projectId, projectId, ctx.requestId).run();
  return { schema: SCHEMA, exported_at: nowIso(), project: { id: p.id, title: p.title, created_at: p.created_at },
    artifacts: arts.results, revisions: revs.results, comments: comments.results, blobs };
}

export async function restoreBackup(ctx: Ctx, backup: any) {
  requireHuman(ctx);
  const DB = ctx.env.DB;
  if (backup?.schema !== SCHEMA) throw new HttpError(400, "bad_backup", "Unsupported backup schema");
  const existing = await DB.prepare("SELECT COUNT(*) AS n FROM projects").first<number>("n");
  if (existing) throw new HttpError(409, "store_not_empty", "Restore targets an empty isolated store only");
  const pid = String(backup.project?.id ?? "");
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(pid)) throw new HttpError(400, "bad_backup", "Bad project id");
  // Validate everything before writing anything.
  const blobs = backup.blobs ?? {};
  const decoded = new Map<string, Uint8Array>();
  for (const r of backup.revisions as any[]) {
    if (r.blob_key === null) {
      if (typeof r.body !== "string" || (await sha256Hex(r.body)) !== r.sha256) throw new HttpError(400, "bad_backup", `Revision ${r.id} hash mismatch`);
      continue;
    }
    if (!new RegExp(`^blobs/${pid}/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+$`).test(r.blob_key)) throw new HttpError(400, "bad_backup", "Bad blob key");
    const b = blobs[r.blob_key];
    if (!b) throw new HttpError(400, "bad_backup", "Missing blob");
    const bytes = decoded.get(r.blob_key) ?? unb64(b.data);
    if ((await sha256Hex(bytes)) !== r.sha256 || bytes.length !== r.size) throw new HttpError(400, "bad_backup", `Blob for ${r.id} hash/size mismatch`);
    decoded.set(r.blob_key, bytes);
  }
  // Blobs first (content-addressed by verified hash); if the D1 batch then fails the target catalog stays empty.
  for (const [k, bytes] of decoded) await ctx.env.BLOBS.put(k, bytes);
  const authors = new Set<string>([...backup.revisions, ...backup.comments].map((x: any) => x.author_id));
  const stmts: D1PreparedStatement[] = [];
  for (const a of authors) if (a !== ctx.principal.id)
    stmts.push(DB.prepare("INSERT OR IGNORE INTO principals (id, kind, issuer, subject, label, created_at) VALUES (?, 'agent', 'restored', ?, ?, ?)").bind(a, a, "restored " + a, nowIso()));
  stmts.push(DB.prepare("INSERT INTO projects (id, owner_id, title, created_at) VALUES (?, ?, ?, ?)").bind(pid, ctx.principal.id, backup.project.title, backup.project.created_at));
  for (const a of backup.artifacts as any[])
    stmts.push(DB.prepare(`INSERT INTO artifacts (id, project_id, kind, title, folder, tags, head_rev, head_revision_id, meta_version, trashed_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(a.id, pid, a.kind, a.title, a.folder, a.tags, a.head_rev, a.head_revision_id, a.meta_version, a.trashed_at, a.created_at, a.updated_at));
  for (const r of backup.revisions as any[])
    stmts.push(DB.prepare(`INSERT INTO revisions (id, artifact_id, project_id, rev_no, author_id, body, blob_key, size, sha256, mime, restored_from, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(r.id, r.artifact_id, pid, r.rev_no, r.author_id, r.body, r.blob_key, r.size, r.sha256, r.mime, r.restored_from, r.created_at));
  for (const c of backup.comments as any[])
    stmts.push(DB.prepare("INSERT INTO comments (id, project_id, artifact_id, rev_no, author_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(c.id, pid, c.artifact_id, c.rev_no, c.author_id, c.body, c.created_at));
  stmts.push(DB.prepare("INSERT INTO audits (at, actor_id, project_id, action, object_id, result, request_id) VALUES (?, ?, ?, 'backup.restore', ?, 'ok', ?)")
    .bind(nowIso(), ctx.principal.id, pid, pid, ctx.requestId));
  await DB.batch(stmts); // all-or-nothing: a failure leaves the empty target empty
  return { restored_project: pid, artifacts: backup.artifacts.length, revisions: backup.revisions.length, blobs: decoded.size, grants: 0 };
}
