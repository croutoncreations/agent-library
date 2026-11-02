
function appOrigin(appHost) {
  if (!appHost) return null;
  const h = appHost.toLowerCase();
  if (!/^[a-z0-9.-]+(:\d{1,5})?$/.test(h)) return null;
  return /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(h) ? `http://${h}` : `https://${h}`;
}
function withWebUrls(tool, args, projectId, result, origin) {
  if (!origin || !result || typeof result !== "object" || result.error) return result;
  const pid = projectId ?? args?.project_id;
  switch (tool) {
    case "list_projects":
      return { ...result, projects: (result.projects ?? []).map((p) => ({ ...p, web_url: projectWebUrl(origin, p.id) })) };
    case "list_artifacts":
      return { ...result, artifacts: (result.artifacts ?? []).map((a) => {
        const p = a.project_id ?? pid;
        return { ...a, web_url: artifactWebUrl(origin, p, a.id), ...a.kind === "markdown" || a.kind === "html" ? { preview_url: previewWebUrl(origin, p, a.id) } : {} };
      }) };
    case "read_artifact":
      if (!result.artifact) return result;
      {
        const p = result.artifact.project_id ?? pid, id = result.artifact.id;
        return { ...result, artifact: {
          ...result.artifact,
          web_url: artifactWebUrl(origin, p, id),
          ...result.artifact.kind === "markdown" || result.artifact.kind === "html" ? { preview_url: previewWebUrl(origin, p, id) } : {}
        }, web_url_opens: "current_document" };
      }
    case "artifact_history":
      if (!pid || !args?.artifact_id) return result;
      return { ...result, revisions: (result.revisions ?? []).map((v) => ({ ...v, version_url: `${artifactWebUrl(origin, pid, args.artifact_id)}?v=${v.rev}` })), web_url: artifactWebUrl(origin, pid, args.artifact_id), web_url_opens: "current_document" };
    case "restore_revision":
    case "restore_metadata":
    case "create_markdown":
    case "save_markdown": {
      const aid = result.artifact_id ?? args?.artifact_id;
      if (!pid || !aid) return result;
      return { ...result, web_url: artifactWebUrl(origin, pid, aid), preview_url: previewWebUrl(origin, pid, aid) };
    }
    default:
      return result;
  }
}
var WEB_ROUTE, projectWebUrl, artifactWebUrl, previewWebUrl, WEB_URL_DESCRIPTION, PREVIEW_URL_DESCRIPTION, U, PU, OPENS, obj, WEB_URL_OUTPUT_SCHEMAS, WEB_URL_TOOL_NOTE;
WEB_ROUTE = /^\/p\/([^/]+)(?:\/a\/([^/]+)(?:\/(preview|edit))?)?\/?$/;
projectWebUrl = (origin, projectId) => `${origin}/p/${encodeURIComponent(projectId)}`;
artifactWebUrl = (origin, projectId, artifactId) => `${projectWebUrl(origin, projectId)}/a/${encodeURIComponent(artifactId)}`;
previewWebUrl = (origin, projectId, artifactId) => `${artifactWebUrl(origin, projectId, artifactId)}/preview`;
WEB_URL_DESCRIPTION = "web_url: link for the user's web browser (Agent Library owner UI). It opens the item in the app and may require the user to sign in; it is not a public share link and grants no access. Do not fetch it as an API.";
PREVIEW_URL_DESCRIPTION = "preview_url (Markdown and HTML documents): opens the rendered, read-only view of the document. Documents also open rendered from web_url, with an Edit tab one tap away. Same sign-in rules as web_url; not a share link.";
U = { type: "string", description: WEB_URL_DESCRIPTION };
PU = { type: "string", description: PREVIEW_URL_DESCRIPTION };
OPENS = { type: "string", enum: ["current_document"], description: "The web_url opens the current document; the browser app has no per-revision link." };
obj = (props) => ({ type: "object", properties: props, additionalProperties: true });
WEB_URL_OUTPUT_SCHEMAS = {
  list_projects: obj({ projects: { type: "array", items: obj({ id: { type: "string" }, title: { type: "string" }, web_url: { ...U, description: "Project page. " + WEB_URL_DESCRIPTION } }) } }),
  list_artifacts: obj({ artifacts: { type: "array", items: obj({ id: { type: "string" }, project_id: { type: "string" }, title: { type: "string" }, web_url: { ...U, description: "Document page (editor for Markdown). " + WEB_URL_DESCRIPTION }, preview_url: PU }) } }),
  read_artifact: obj({ artifact: obj({ id: { type: "string" }, project_id: { type: "string" }, web_url: { ...U, description: "Current document page, editor for Markdown (even when a past revision was read). " + WEB_URL_DESCRIPTION }, preview_url: PU }), web_url_opens: OPENS }),
  artifact_history: obj({ revisions: { type: "array", items: obj({ rev: { type: "integer" }, version_url: { ...U, description: "Opens this version read-only in the owner's app (History tab), with compare and restore. " + WEB_URL_DESCRIPTION } }) }, web_url: { ...U, description: "Current document page. " + WEB_URL_DESCRIPTION }, web_url_opens: OPENS }),
  create_markdown: obj({ artifact_id: { type: "string" }, revision: { type: "integer" }, web_url: { ...U, description: "Editor page of the created document. " + WEB_URL_DESCRIPTION }, preview_url: PU }),
  save_markdown: obj({ artifact_id: { type: "string" }, revision: { type: "integer" }, web_url: { ...U, description: "Editor page of the saved document (current revision). " + WEB_URL_DESCRIPTION }, preview_url: PU })
};
WEB_URL_TOOL_NOTE = " Results include browser links for the user (sign-in may be required): web_url opens the item (the editor for Markdown); for Markdown, preview_url opens the rendered read-only view. Share preview_url when the user wants to read a document.";

export { WEB_ROUTE, WEB_URL_OUTPUT_SCHEMAS, WEB_URL_TOOL_NOTE, appOrigin, artifactWebUrl, previewWebUrl, projectWebUrl, withWebUrls };
