// Inputs come only from existing authenticated, live scope evaluators. Never serialize a credential row.
function connectionInfo(type, id, label, projects, expires, activity, extra = {}) {
  const iso = (v) => v == null ? null : new Date(v).toISOString();
  return {
    connection: { type, id, display_label: String(label).slice(0, 200), label_source: type === "oauth" || type === "publisher" ? "registered app name (self-reported; not proof of caller identity)" : "owner-assigned label" },
    checked_at: nowIso(), expires_at: iso(expires), last_activity_at: iso(activity),
    successful_operations: "not measured",
    projects: projects.map((p) => ({ id: p.id, title: p.title, can_read: true, can_write: !!p.can_write })),
    restrictions: ["Editing remains subject to file ownership, supported kinds, quotas and expected revisions.", "This check authenticates this request and evaluates current access. It does not test document rendering, binary transfers or writes."],
    next_action: "Compare this connection ID in Connections. If a project is missing, check its selection or reconnect from the intended client. Expired or revoked credentials require owner inspection and cannot diagnose themselves.",
    ...extra
  };
}
async function legacyConnectionInfo(ctx) {
  if (ctx.principal.kind !== "agent" || !ctx.grant) throw new HttpError(403, "forbidden", "Use an agent connection");
  const row = await db(ctx).prepare("SELECT expires_at, revoked_at FROM grants WHERE id = ?").bind(ctx.grant.id).first();
  if (!row || row.revoked_at !== null || row.expires_at <= nowMs()) throw new HttpError(401, "grant_expired", "Grant revoked or expired");
  const { projects } = await listProjects(ctx);
  return connectionInfo("legacy_grant", ctx.grant.id, ctx.principal.label, projects, row.expires_at, null);
}
