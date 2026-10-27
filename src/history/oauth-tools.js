      {
        name: "diff_revisions",
        title: "Compare versions",
        description: "Compare two versions of a document line by line (default: the current version against the one before it). Returns unified hunks (lines start with ' ', '-' or '+') and added/removed counts.",
        inputSchema: S({ project_id: P, artifact_id: A, from: { type: "integer", minimum: 1 }, to: { type: "integer", minimum: 1 } }, ["artifact_id"]),
        annotations: RO,
        write: false,
        run: /* @__PURE__ */ __name((c, p, a) => diffRevisions(c, p, a.artifact_id, a.from, a.to), "run")
      },
      {
        name: "restore_revision",
        title: "Restore a version",
        description: "Restore an earlier version of a document's content. Creates a new version with that content; nothing is deleted, so a restore can itself be undone. expected_revision must be the current revision; on revision_conflict re-read first. Use artifact_history and diff_revisions to pick the version. Set change_note to why.",
        inputSchema: S({ project_id: P, artifact_id: A, expected_revision: { type: "integer", minimum: 1 }, from_revision: { type: "integer", minimum: 1 }, change_note: NOTE, idempotency_key: K }, ["artifact_id", "expected_revision", "from_revision", "idempotency_key"]),
        annotations: RW,
        write: true,
        run: /* @__PURE__ */ __name(async (c, p, a) => unwrap(await restoreRevision(c, p, a.artifact_id, { expected_revision: a.expected_revision, from_revision: a.from_revision, change_note: a.change_note }, idemKey(a.idempotency_key))), "run")
      },
      {
        name: "restore_metadata",
        title: "Restore title and tags",
        description: "Restore an earlier title, folder and tags of a document (listed under meta_versions in artifact_history). Creates a new metadata version; nothing is deleted. expected_meta_version must be the document's current meta_version. Set change_note to why.",
        inputSchema: S({ project_id: P, artifact_id: A, expected_meta_version: { type: "integer", minimum: 1 }, from_version: { type: "integer", minimum: 1 }, change_note: NOTE, idempotency_key: K }, ["artifact_id", "expected_meta_version", "from_version", "idempotency_key"]),
        annotations: RW,
        write: true,
        run: /* @__PURE__ */ __name(async (c, p, a) => unwrap(await restoreMetadata(c, p, a.artifact_id, { expected_meta_version: a.expected_meta_version, from_version: a.from_version, change_note: a.change_note }, idemKey(a.idempotency_key))), "run")
      },
