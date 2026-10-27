// Canonical owner-browser URLs for projects and documents (navigation links, not sharing links).
// Single source of truth for the browser deep-link routes; the owner-app router (index.ts) and the
// browser app (ui.ts boot) accept exactly these paths. URLs never carry tokens, grants or signatures:
// opening one still requires the owner's normal sign-in (Cloudflare Access on the hosted site).

// /p/:project, /p/:project/a/:artifact, /p/:project/a/:artifact/preview (rendered, read-only Markdown view)
export const WEB_ROUTE = /^\/p\/([^/]+)(?:\/a\/([^/]+)(?:\/(preview))?)?\/?$/;

/** Owner app origin: https://<APP_HOST>, or http for loopback dev hosts. null when unknown. */
export function appOrigin(appHost: string | undefined | null): string | null {
  if (!appHost) return null;
  const h = appHost.toLowerCase();
  if (!/^[a-z0-9.-]+(:\d{1,5})?$/.test(h)) return null;
  return /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(h) ? `http://${h}` : `https://${h}`;
}

export const projectWebUrl = (origin: string, projectId: string) => `${origin}/p/${encodeURIComponent(projectId)}`;
export const artifactWebUrl = (origin: string, projectId: string, artifactId: string) =>
  `${projectWebUrl(origin, projectId)}/a/${encodeURIComponent(artifactId)}`;

/** Rendered (read-only) view of a Markdown document. */
export const previewWebUrl = (origin: string, projectId: string, artifactId: string) => `${artifactWebUrl(origin, projectId, artifactId)}/preview`;

export const WEB_URL_DESCRIPTION =
  "web_url: link for the user's web browser (Agent Library owner UI). It opens the item in the app and may require the user to sign in; " +
  "it is not a public share link and grants no access. Do not fetch it as an API.";
export const PREVIEW_URL_DESCRIPTION =
  "preview_url (Markdown documents only): opens the rendered, read-only view of the document. Prefer it when the user wants to read the document; " +
  "use web_url when they want to edit it. Same sign-in rules as web_url; not a share link.";
const isMd = (kind: unknown) => kind === undefined || kind === "markdown";

/**
 * Additive decoration of MCP tool results with web_url fields. Unknown tools / error results unchanged.
 * Revision-specific views have no browser route, so read_artifact(revision) and artifact_history
 * link to the current document and say so (web_url_opens: "current_document").
 */
export function withWebUrls(tool: string, args: any, projectId: string | undefined, result: any, origin: string | null): any {
  if (!origin || !result || typeof result !== "object" || result.error) return result;
  const pid = projectId ?? args?.project_id;
  switch (tool) {
    case "list_projects":
      return { ...result, projects: (result.projects ?? []).map((p: any) => ({ ...p, web_url: projectWebUrl(origin, p.id) })) };
    case "list_artifacts":
      return { ...result, artifacts: (result.artifacts ?? []).map((a: any) => {
        const p = a.project_id ?? pid;
        return { ...a, web_url: artifactWebUrl(origin, p, a.id), ...(a.kind === "markdown" ? { preview_url: previewWebUrl(origin, p, a.id) } : {}) };
      }) };
    case "read_artifact":
      if (!result.artifact) return result;
      {
        const p = result.artifact.project_id ?? pid, id = result.artifact.id;
        return { ...result, artifact: { ...result.artifact, web_url: artifactWebUrl(origin, p, id),
          ...(result.artifact.kind === "markdown" ? { preview_url: previewWebUrl(origin, p, id) } : {}) }, web_url_opens: "current_document" };
      }
    case "artifact_history":
      if (!pid || !args?.artifact_id) return result;
      return { ...result, web_url: artifactWebUrl(origin, pid, args.artifact_id), web_url_opens: "current_document" };
    case "create_markdown":
    case "save_markdown": {
      const aid = result.artifact_id ?? args?.artifact_id;
      if (!pid || !aid) return result;
      // create_markdown / save_markdown are always Markdown.
      return { ...result, web_url: artifactWebUrl(origin, pid, aid), preview_url: previewWebUrl(origin, pid, aid) };
    }
    default:
      return result;
  }
}

const U = { type: "string", description: WEB_URL_DESCRIPTION };
const PU = { type: "string", description: PREVIEW_URL_DESCRIPTION };
const OPENS = { type: "string", enum: ["current_document"], description: "The web_url opens the current document; the browser app has no per-revision link." };
const obj = (props: Record<string, any>) => ({ type: "object", properties: props, additionalProperties: true });
/** Permissive output schemas (no required fields) that document the web_url additions. */
export const WEB_URL_OUTPUT_SCHEMAS: Record<string, any> = {
  list_projects: obj({ projects: { type: "array", items: obj({ id: { type: "string" }, title: { type: "string" }, web_url: { ...U, description: "Project page. " + WEB_URL_DESCRIPTION } }) } }),
  list_artifacts: obj({ artifacts: { type: "array", items: obj({ id: { type: "string" }, project_id: { type: "string" }, title: { type: "string" }, web_url: { ...U, description: "Document page (editor for Markdown). " + WEB_URL_DESCRIPTION }, preview_url: PU }) } }),
  read_artifact: obj({ artifact: obj({ id: { type: "string" }, project_id: { type: "string" }, web_url: { ...U, description: "Current document page, editor for Markdown (even when a past revision was read). " + WEB_URL_DESCRIPTION }, preview_url: PU }), web_url_opens: OPENS }),
  artifact_history: obj({ revisions: { type: "array" }, web_url: { ...U, description: "Current document page; individual revisions have no browser link. " + WEB_URL_DESCRIPTION }, web_url_opens: OPENS }),
  create_markdown: obj({ artifact_id: { type: "string" }, revision: { type: "integer" }, web_url: { ...U, description: "Editor page of the created document. " + WEB_URL_DESCRIPTION }, preview_url: PU }),
  save_markdown: obj({ artifact_id: { type: "string" }, revision: { type: "integer" }, web_url: { ...U, description: "Editor page of the saved document (current revision). " + WEB_URL_DESCRIPTION }, preview_url: PU }),
};
export const WEB_URL_TOOL_NOTE = " Results include browser links for the user (sign-in may be required): web_url opens the item (the editor for Markdown); for Markdown, preview_url opens the rendered read-only view. Share preview_url when the user wants to read a document.";
