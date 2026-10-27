  {
    name: "diff_revisions",
    description: "Compare two versions line by line (default: current against the previous one). Unified hunks; lines start with ' ', '-' or '+'.",
    inputSchema: S2({ project_id: P2, artifact_id: A2, from: { type: "integer" }, to: { type: "integer" } }, ["project_id", "artifact_id"]),
    run: /* @__PURE__ */ __name((c, a) => diffRevisions(c, a.project_id, a.artifact_id, a.from, a.to), "run")
  },
  {
    name: "restore_revision",
    description: "Restore an earlier version's content as a new version (nothing is deleted). expected_revision must be the current revision. Set change_note to why.",
    inputSchema: S2({ project_id: P2, artifact_id: A2, expected_revision: { type: "integer" }, from_revision: { type: "integer" }, change_note: CHANGE_NOTE_SCHEMA, idempotency_key: K2 }, ["project_id", "artifact_id", "expected_revision", "from_revision", "idempotency_key"]),
    run: /* @__PURE__ */ __name(async (c, a) => unwrap2(await restoreRevision(c, a.project_id, a.artifact_id, { expected_revision: a.expected_revision, from_revision: a.from_revision, change_note: a.change_note }, idemKey(a.idempotency_key))), "run")
  },
  {
    name: "restore_metadata",
    description: "Restore an earlier title, folder and tags (see meta_versions in artifact_history) as a new metadata version. expected_meta_version must be current. Set change_note to why.",
    inputSchema: S2({ project_id: P2, artifact_id: A2, expected_meta_version: { type: "integer" }, from_version: { type: "integer" }, change_note: CHANGE_NOTE_SCHEMA, idempotency_key: K2 }, ["project_id", "artifact_id", "expected_meta_version", "from_version", "idempotency_key"]),
    run: /* @__PURE__ */ __name(async (c, a) => unwrap2(await restoreMetadata(c, a.project_id, a.artifact_id, { expected_meta_version: a.expected_meta_version, from_version: a.from_version, change_note: a.change_note }, idemKey(a.idempotency_key))), "run")
  },
