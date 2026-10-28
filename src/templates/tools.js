function tplTools(oauth = false) {
  const project = { type: "string", maxLength: 64, description: "Project ID from list_projects" };
  const text = { type: "string", maxLength: 64 };
  const schema = (properties, required) => ({ type: "object", properties: { project_id: project, ...properties }, required: oauth ? required : ["project_id", ...required], additionalProperties: false });
  const ro = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const rw = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  return [
    { name: "list_templates", title: "List document templates", write: false, annotations: ro,
      description: "List available Markdown templates in this project, without bodies, with revision/hash and authenticated owner UI links (not sharing links). Read the returned template ID with read_artifact at its explicit revision before use; max_bytes/cursor supports long content. Definitions are maintained by the owner only.",
      inputSchema: schema({ cursor: text, limit: { type: "integer", minimum: 1, maximum: 50 } }, []),
      run: oauth ? (c, p, a) => listTemplates(c, p, a) : (c, a) => listTemplates(c, a.project_id, a) },
    { name: "create_from_template", title: "Create document from template", write: true, annotations: rw,
      description: "Create one independent Markdown document from a pinned template revision in this project. Returns ID, revision/hash, authenticated document/preview URLs (not sharing links) and source template ID/revision. Read the template first. Supply date as YYYY-MM-DD from the user's date/timezone context when {{date}} occurs. Only {{title}}, {{project}}, {{date}} are replaced, once; other braces stay literal. Then fill the copy with ordinary save_markdown. Always set change_note to one line on why. Reuse the same inputs and idempotency_key on retry.",
      inputSchema: schema({ template_id: text, template_revision: { type: "integer", minimum: 1 }, title: { type: "string", minLength: 1, maxLength: 200 },
        date: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" }, folder: { type: "string", maxLength: 200 }, folder_id: text,
        change_note: { type: "string", maxLength: 280 }, idempotency_key: { type: "string", minLength: 8, maxLength: 128 } }, ["template_id", "template_revision", "title", "idempotency_key"]),
      run: oauth ? async (c, p, a) => (await createFromTemplate(c, p, a, idemKey(a.idempotency_key))).body
        : async (c, a) => (await createFromTemplate(c, a.project_id, a, idemKey(a.idempotency_key))).body }
  ];
}
