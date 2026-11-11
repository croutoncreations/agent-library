import { authorizeProject } from "./auth.js";
import { getText, getTextRange } from "./content-store.js";
import { db, loadArtifact } from "./service.js";
import { MARKDOWN_PREVIEW_MAX_BYTES, HTML_RENDER_MAX_BYTES } from "./text-limits.js";
import { HttpError } from "./util.js";

/** Render-only reads: inspect stored size before fetching bytes, without changing full document reads. */
export async function getRenderSource(ctx, projectId, artifactId, revNo, kind) {
  await authorizeProject(ctx, projectId, false);
  const artifact = await loadArtifact(ctx, projectId, artifactId);
  const revision = await db(ctx).prepare("SELECT id, rev_no, size, body_key FROM revisions WHERE artifact_id = ? AND project_id = ? AND rev_no = ?")
    .bind(artifactId, projectId, revNo ?? artifact.head_rev).first();
  if (!revision) throw new HttpError(404, "not_found", "Revision not found");
  if (artifact.kind !== kind) throw new HttpError(400, "invalid_input", kind === "markdown" ? "Not Markdown" : "Not an HTML document");
  const truncated = revision.size > (kind === "markdown" ? MARKDOWN_PREVIEW_MAX_BYTES : HTML_RENDER_MAX_BYTES);
  if (kind === "html" && truncated) throw new HttpError(413, "render_too_large", "This page is larger than 1 MB and cannot be shown.");
  // Legacy inline versions also defer their body read until after the size check.
  if (!revision.body_key) revision.body = await db(ctx).prepare("SELECT body FROM revisions WHERE id = ?").bind(revision.id).first("body");
  let body;
  if (truncated) {
    let bytes = await getTextRange(ctx.env, revision, 0, MARKDOWN_PREVIEW_MAX_BYTES);
    // Prefer a complete line, but never discard more than the final 16 KiB for a long line.
    for (let i = bytes.length - 1; i >= Math.max(0, bytes.length - 16384); i--) {
      if (bytes[i] === 10 || bytes[i] === 13) { bytes = bytes.subarray(0, i + 1); break; }
    }
    // Streaming decode retains (rather than replaces) any incomplete trailing UTF-8 character.
    body = new TextDecoder().decode(bytes, { stream: true });
  } else body = await getText(ctx.env, revision);
  await authorizeProject(ctx, projectId, false);
  await loadArtifact(ctx, projectId, artifactId);
  return { artifact, revision, body, truncated };
}
