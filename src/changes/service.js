// Durable project polling. D1 primary reads + one batch snapshot for auth, boundary and events.
// No replica sessions: a cursor never advances past uncommitted sequence allocation.
const CH_RETENTION_MS = 30 * 86400000;
const CH_MAX_BYTES = 65536;
function chQuery(q) {
  for (const k of q.keys())
    if (!["cursor", "limit"].includes(k))
      throw new HttpError(400, "invalid_input", "Unknown query parameter");
  return {
    cursor: q.get("cursor") ?? undefined,
    limit: q.has("limit") ? Number(q.get("limit")) : undefined,
  };
}
function chBytes(v) {
  return new TextEncoder().encode(JSON.stringify(v)).length;
}
function chB64(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
function chUn64(s) {
  return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
}
async function chKey(env) {
  const secret = await env.DB.prepare(
    "SELECT secret FROM change_feed_key WHERE id=1",
  ).first("secret");
  if (typeof secret !== "string" || !/^[a-f0-9]{64}$/.test(secret))
    throw new HttpError(
      503,
      "changes_unavailable",
      "Changes feed migration/key is unavailable",
    );
  return crypto.subtle.importKey(
    "raw",
    Uint8Array.from(secret.match(/../g), (hex) => parseInt(hex, 16)),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}
// Authenticated encryption also hides the global sequence and other scope internals. A merely
// base64-encoded signed cursor would let readers infer activity counts outside their project.
async function chEncode(key, v) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(v));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data),
  );
  return "pc1." + chB64(iv) + "." + chB64(ciphertext);
}
async function chDecode(key, cursor) {
  if (typeof cursor !== "string" || cursor.length > 2048)
    throw new HttpError(400, "invalid_cursor", "Malformed changes cursor");
  if (!/^pc[0-9]+\./.test(cursor))
    throw new HttpError(400, "invalid_cursor", "Malformed changes cursor");
  if (!cursor.startsWith("pc1."))
    throw new HttpError(
      400,
      "unsupported_cursor_version",
      "Expected a pc1 changes cursor",
    );
  try {
    const parts = cursor.split(".");
    if (parts.length !== 3) throw 0;
    const iv = chUn64(parts[1]),
      ciphertext = chUn64(parts[2]);
    if (
      iv.length !== 12 ||
      chB64(iv) !== parts[1] ||
      chB64(ciphertext) !== parts[2]
    )
      throw 0;
    const data = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext,
    );
    const v = JSON.parse(new TextDecoder().decode(data));
    if (
      !Array.isArray(v) ||
      v.length !== 8 ||
      !v.slice(3, 7).every((n) => Number.isSafeInteger(n) && n >= 0) ||
      typeof v[7] !== "string" ||
      (v[4] && v[4] < v[3])
    )
      throw 0;
    return v;
  } catch {
    throw new HttpError(
      400,
      "invalid_cursor",
      "Malformed or modified changes cursor",
    );
  }
}
function chKinds(ctx) {
  if (!ctx.oauthConnection)
    return ["markdown", "html", "json", "csv", "binary"];
  // The App Connect kind gate applies independently of approval to read binaries.
  const kinds = ["markdown", "html"];
  if (appConnectEnabled(ctx.env)) kinds.push("json", "csv");
  if (ctx.ftConn?.file_access === 1) kinds.push("binary");
  return kinds;
}
async function listChanges(ctx, projectId, opts = {}) {
  if (typeof projectId !== "string" || !projectId || projectId.length > 64)
    throw new HttpError(
      400,
      "project_required",
      "Pass one explicit project_id",
    );
  if (ctx.publisher)
    throw new HttpError(
      403,
      "forbidden",
      "Publishers cannot use the project changes feed",
    );
  await authorizeProject(ctx, projectId, false);
  const limit = opts.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50)
    throw new HttpError(
      400,
      "invalid_input",
      "limit must be an integer from 1 to 50",
    );
  const az = rtReadAuthzSql(ctx, projectId);
  const transport = ctx.oauthConnection
    ? "oauth"
    : ctx.apiCredential
      ? "api"
      : "grant";
  const connection =
    ctx.principal.kind === "human"
      ? "owner:" + ctx.principal.id
      : transport + ":" + ctx.grant.id;
  const kinds = chKinds(ctx);
  const mode = kinds.join(",");
  const key = await chKey(ctx.env);
  const c = opts.cursor == null ? null : await chDecode(key, opts.cursor);
  if (c && c[0] !== projectId)
    throw new HttpError(
      400,
      "cursor_wrong_project",
      "Changes cursor belongs to another project",
    );
  if (c && (c[1] !== connection || c[2] !== mode))
    throw new HttpError(
      409,
      "cursor_scope_changed",
      "Reconcile current state and establish a new checkpoint for this scope",
    );
  const after = c?.[3] ?? 0,
    boundary = c?.[4] ?? 0;
  // Both SELECTs use the same transaction. The second repeats the live authorization fence.
  const stateSql = `SELECT COALESCE(s.high,0) high,COALESCE(s.floor,0) floor,
    (SELECT file_access FROM oauth_connections WHERE id=?) file_access,
    (SELECT group_concat(pb.id || ':' || pb.current_snapshot_id, ',') FROM publishers pb
      JOIN publisher_generations pg ON pg.snapshot_id=pb.current_snapshot_id
      LEFT JOIN change_generation_coverage cv ON cv.publisher_id=pb.id
      WHERE pb.project_id=p.id AND cv.snapshot_id IS NOT pb.current_snapshot_id) coverage_gap,
    COALESCE((SELECT epoch FROM change_scope_epochs WHERE transport=? AND connection_id=? AND project_id=?),0) epoch
    FROM projects p LEFT JOIN project_change_state s ON s.project_id=p.id WHERE p.id=? AND ${az.sql}`;
  const [stateResult, eventResult] = await ctx.env.DB.batch([
    ctx.env.DB.prepare(stateSql).bind(
      ctx.grant?.id ?? "",
      transport,
      ctx.grant?.id ?? "",
      projectId,
      projectId,
      ...az.params,
    ),
    ctx.env.DB.prepare(
      `SELECT e.*,a.trashed_at,a.head_rev,a.id current_id FROM project_changes e
      LEFT JOIN artifacts a ON a.id=e.artifact_id AND a.project_id=e.project_id
      WHERE e.project_id=? AND e.seq>? AND e.seq<=COALESCE(NULLIF(?,0),(SELECT high FROM project_change_state WHERE project_id=?),0)
      AND e.kind IN (${kinds.map(() => "?").join(",")}) AND ${az.sql}
      ORDER BY e.seq LIMIT ?`,
    ).bind(
      projectId,
      after,
      boundary,
      projectId,
      ...kinds,
      ...az.params,
      limit + 1,
    ),
  ]);
  const state = stateResult.results[0];
  if (!state)
    throw new HttpError(
      404,
      "not_found",
      "Project not found or access removed",
    );
  if (
    ctx.oauthConnection &&
    !!state.file_access !== (ctx.ftConn?.file_access === 1)
  )
    throw new HttpError(
      409,
      "cursor_scope_changed",
      "Connection file access changed during this poll; retry with the current scope",
    );
  const coverage = await sha256Hex(state.coverage_gap ?? "");
  if (c && c[7] !== coverage)
    throw new HttpError(
      409,
      "cursor_scope_changed",
      "Publication coverage changed after Worker rollback; reconcile and take a new checkpoint",
      { resync_required: true },
    );
  if (c && c[6] !== state.epoch)
    throw new HttpError(
      409,
      "cursor_scope_changed",
      "Project scope changed; reconcile and take a new checkpoint",
    );
  if (c && (after < state.floor || c[5] < nowMs() - CH_RETENTION_MS))
    throw new HttpError(
      410,
      "cursor_expired",
      "Changes cursor expired; take a checkpoint BEFORE listing current content, then consume changes and deduplicate by event_id",
      {
        resync_required: true,
        oldest_usable_cursor: await chEncode(key, [
          projectId,
          connection,
          mode,
          Math.max(after, state.floor),
          0,
          nowMs(),
          state.epoch,
          coverage,
        ]),
      },
    );
  const upper = boundary || state.high;
  const issued = c && boundary ? c[5] : nowMs();
  const encode = (a, b) =>
    chEncode(key, [
      projectId,
      connection,
      mode,
      a,
      b,
      issued,
      state.epoch,
      coverage,
    ]);
  const out = {
    changes: [],
    next_cursor: "",
    has_more: false,
    initialized: !c,
    checkpoint: !c,
    retention_days: 30,
  };
  if (!c) {
    out.next_cursor = await encode(state.high, 0);
    return out;
  }
  let last = after;
  const rows = eventResult.results;
  for (const e of rows.slice(0, limit)) {
    const item = {
      event_id: "chg_" + e.event_id,
      type: e.type,
      project_id: projectId,
      artifact_id: e.artifact_id,
      occurred_at: e.at,
    };
    if (
      !e.current_id ||
      e.trashed_at ||
      !e.head_rev ||
      e.type === "artifact.trashed"
    )
      item.tombstone = true;
    else {
      item.revision = e.revision;
      item.sha256 = e.sha256;
      item.meta_version = e.meta_version;
      item.changed_fields = JSON.parse(e.changed_fields);
      item.restored_from = e.restored_from;
      item.connection_label = String(e.connection_label ?? "Unknown connection")
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .slice(0, 120);
      const origin = appOrigin(ctx.env.APP_HOST);
      if (origin)
        item.web_url = artifactWebUrl(origin, projectId, e.artifact_id); // No old-version URLs: ordinary readers do not gain history access.
    }
    out.changes.push(item);
    out.next_cursor = await encode(e.seq, upper);
    // Complete MCP response includes JSON text AND structured content. Reserve a bounded RPC id + envelope.
    if (
      chBytes({
        jsonrpc: "2.0",
        id: "x".repeat(1024),
        result: {
          content: [{ type: "text", text: JSON.stringify(out) }],
          structuredContent: out,
          isError: false,
        },
      }) >
      CH_MAX_BYTES - 1024
    ) {
      out.changes.pop();
      break;
    }
    last = e.seq;
  }
  out.has_more = rows.length > out.changes.length;
  out.next_cursor = await encode(
    out.has_more ? last : upper,
    out.has_more ? upper : 0,
  );
  return out;
}
async function cleanupChanges(env) {
  // Bounded work on the existing 15 minute cron. Deletion trigger preserves the oldest usable sequence.
  const [result, count] = await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM project_changes WHERE seq IN
    (SELECT seq FROM project_changes WHERE at < ? ORDER BY at,seq LIMIT 1000)`,
    ).bind(new Date(nowMs() - CH_RETENTION_MS).toISOString()),
    // D1 meta.changes includes the retention-floor trigger writes. Measure direct deletes instead.
    env.DB.prepare("SELECT changes() AS deleted"),
  ]);
  const deleted = count.results[0].deleted;
  if (deleted === 1000)
    console.warn(
      JSON.stringify({
        event: "project_changes_cleanup_batch_full",
        deleted,
        limit: 1000,
      }),
    );
  return result;
}
