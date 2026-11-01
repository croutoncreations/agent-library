import { requireHuman } from "./auth.js";
import { tplDate } from "./service.js";
import { HttpError, int, nowIso, sha256Hex, str } from "./util.js";

var SCHEMA = "agent-library-backup/1";
var b64 = (b) => {
  let s = "";
  for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode(...b.subarray(i, i + 32768));
  return btoa(s);
};
var unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function exportBackup(ctx, projectId) {
  requireHuman(ctx);
  let metaVersionsExport = [];
  const DB = ctx.env.DB;
  const p = await DB.prepare("SELECT * FROM projects WHERE id = ? AND owner_id = ?").bind(projectId, ctx.principal.id).first();
  if (!p) throw new HttpError(404, "not_found", "Project not found");
  const pubFiles = await DB.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE project_id = ? AND publisher_id IS NOT NULL").bind(projectId).first("n").catch(() => 0);
  if (pubFiles) throw new HttpError(409, "backup_unsupported", "This project contains app exports; backup of App Connect projects is not supported yet");
  const [arts, revs, comments] = await DB.batch([
    DB.prepare("SELECT id, kind, title, folder, tags, head_rev, head_revision_id, meta_version, trashed_at, created_at, updated_at, is_template, template_description, source_artifact_id, source_revision, source_role, template_date FROM artifacts WHERE project_id = ? AND head_rev > 0").bind(projectId),
    DB.prepare("SELECT id, artifact_id, rev_no, author_id, body, blob_key, size, sha256, mime, restored_from, created_at, via_kind, via_id, via_label, client_info, change_note FROM revisions WHERE project_id = ?").bind(projectId),
    DB.prepare("SELECT id, artifact_id, rev_no, author_id, body, created_at FROM comments WHERE project_id = ?").bind(projectId),
    DB.prepare("SELECT id, artifact_id, version, title, folder, tags, trashed, author_id, via_kind, via_id, via_label, client_info, change_note, restored_from, created_at, template_description FROM meta_versions WHERE project_id = ?").bind(projectId)
  ]).then(([a, r, c, mv]) => (metaVersionsExport = mv.results, [a, r, c]));
  const blobs = {};
  for (const r of revs.results) {
    if (!r.blob_key || blobs[r.blob_key]) continue;
    const o = await ctx.env.BLOBS.get(r.blob_key);
    if (!o) throw new HttpError(500, "blob_missing", "Referenced blob missing during export");
    const bytes = new Uint8Array(await o.arrayBuffer());
    const sha2 = await sha256Hex(bytes);
    if (sha2 !== r.sha256) throw new HttpError(500, "blob_corrupt", "Stored blob hash mismatch");
    blobs[r.blob_key] = { sha256: sha2, data: b64(bytes) };
  }
  await DB.prepare("INSERT INTO audits (at, actor_id, project_id, action, object_id, result, request_id) VALUES (?, ?, ?, 'backup.export', ?, 'ok', ?)").bind(nowIso(), ctx.principal.id, projectId, projectId, ctx.requestId).run();
  return {
    schema: arts.results.some(a => a.is_template || a.source_artifact_id) ? "agent-library-backup/2" : SCHEMA,
    features: ["document_templates/1"],
    exported_at: nowIso(),
    project: { id: p.id, title: p.title, created_at: p.created_at },
    artifacts: arts.results,
    revisions: revs.results,
    comments: comments.results,
    meta_versions: metaVersionsExport,
    blobs
  };
}
async function restoreBackup(ctx, backup) {
  requireHuman(ctx);
  const DB = ctx.env.DB;
  if (backup?.schema !== SCHEMA && backup?.schema !== "agent-library-backup/2") throw new HttpError(400, "bad_backup", "Unsupported backup schema");
  const existing = await DB.prepare("SELECT COUNT(*) AS n FROM projects").first("n");
  if (existing) throw new HttpError(409, "store_not_empty", "Restore targets an empty isolated store only");
  const pid = String(backup.project?.id ?? "");
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(pid)) throw new HttpError(400, "bad_backup", "Bad project id");
  for (const a of backup.artifacts ?? []) {
    if (a.is_template != null && a.is_template !== 0 && a.is_template !== 1) throw new HttpError(400, "bad_backup", "Invalid template identity");
    if (a.is_template && (a.kind !== "markdown" || a.publisher_id)) throw new HttpError(400, "bad_backup", "Invalid template kind");
    str(a.template_description ?? "", "template_description", 280);
    if (a.source_artifact_id != null) {
      str(a.source_artifact_id, "source_artifact_id", 64, { min: 1 });
      int(a.source_revision, "source_revision", 1);
      if (!["document", "template"].includes(a.source_role)) throw new HttpError(400, "bad_backup", "Invalid source role");
    }
    if (a.template_date != null) tplDate(a.template_date, true);
  }
  for (const v of Array.isArray(backup.meta_versions) ? backup.meta_versions : []) str(v.template_description ?? "", "template_description", 280);
  const blobs = backup.blobs ?? {};
  const decoded = /* @__PURE__ */ new Map();
  for (const r of backup.revisions) {
    if (r.blob_key === null) {
      if (typeof r.body !== "string" || await sha256Hex(r.body) !== r.sha256) throw new HttpError(400, "bad_backup", `Revision ${r.id} hash mismatch`);
      continue;
    }
    if (!new RegExp(`^blobs/${pid}/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+$`).test(r.blob_key)) throw new HttpError(400, "bad_backup", "Bad blob key");
    const b = blobs[r.blob_key];
    if (!b) throw new HttpError(400, "bad_backup", "Missing blob");
    const bytes = decoded.get(r.blob_key) ?? unb64(b.data);
    if (await sha256Hex(bytes) !== r.sha256 || bytes.length !== r.size) throw new HttpError(400, "bad_backup", `Blob for ${r.id} hash/size mismatch`);
    decoded.set(r.blob_key, bytes);
  }
  for (const [k, bytes] of decoded) await ctx.env.BLOBS.put(k, bytes);
  if (backup.meta_versions !== void 0 && !Array.isArray(backup.meta_versions)) throw new HttpError(400, "bad_backup", "meta_versions must be a list");
  const authors = new Set([...backup.revisions, ...backup.comments, ...backup.meta_versions ?? []].map((x) => x.author_id));
  const stmts = [];
  for (const a of authors) if (a !== ctx.principal.id)
    stmts.push(DB.prepare("INSERT OR IGNORE INTO principals (id, kind, issuer, subject, label, created_at) VALUES (?, 'agent', 'restored', ?, ?, ?)").bind(a, a, "restored " + a, nowIso()));
  stmts.push(DB.prepare("INSERT INTO projects (id, owner_id, title, created_at) VALUES (?, ?, ?, ?)").bind(pid, ctx.principal.id, backup.project.title, backup.project.created_at));
  for (const a of backup.artifacts)
    stmts.push(DB.prepare(`INSERT INTO artifacts (id, project_id, kind, title, folder, tags, head_rev, head_revision_id, meta_version, trashed_at, created_at, updated_at, is_template, template_description, source_artifact_id, source_revision, source_role, template_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(a.id, pid, a.kind, a.title, a.folder, a.tags, a.head_rev, a.head_revision_id, a.meta_version, a.trashed_at, a.created_at, a.updated_at, a.is_template ?? 0, a.template_description ?? "", a.source_artifact_id ?? null, a.source_revision ?? null, a.source_role ?? null, a.template_date ?? null));
  for (const r of backup.revisions)
    stmts.push(DB.prepare(`INSERT INTO revisions (id, artifact_id, project_id, rev_no, author_id, body, blob_key, size, sha256, mime, restored_from, created_at, via_kind, via_id, via_label, client_info, change_note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(r.id, r.artifact_id, pid, r.rev_no, r.author_id, r.body, r.blob_key, r.size, r.sha256, r.mime, r.restored_from, r.created_at, r.via_kind ?? null, r.via_id ?? null, r.via_label ?? null, r.client_info ?? null, r.change_note ?? null));
  for (const v of backup.meta_versions ?? [])
    stmts.push(DB.prepare(`INSERT INTO meta_versions (id, artifact_id, project_id, version, title, folder, tags, trashed, author_id, via_kind, via_id, via_label, client_info, change_note, restored_from, created_at, template_description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(v.id, v.artifact_id, pid, v.version, v.title, v.folder, v.tags, v.trashed ? 1 : 0, v.author_id, v.via_kind ?? null, v.via_id ?? null, v.via_label ?? null, v.client_info ?? null, v.change_note ?? null, v.restored_from ?? null, v.created_at, v.template_description ?? ""));
  for (const c of backup.comments)
    stmts.push(DB.prepare("INSERT INTO comments (id, project_id, artifact_id, rev_no, author_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(c.id, pid, c.artifact_id, c.rev_no, c.author_id, c.body, c.created_at));
  stmts.push(DB.prepare("INSERT INTO audits (at, actor_id, project_id, action, object_id, result, request_id) VALUES (?, ?, ?, 'backup.restore', ?, 'ok', ?)").bind(nowIso(), ctx.principal.id, pid, pid, ctx.requestId));
  await DB.batch(stmts);
  return { restored_project: pid, artifacts: backup.artifacts.length, revisions: backup.revisions.length, blobs: decoded.size, grants: 0 };
}

export { exportBackup, restoreBackup };
