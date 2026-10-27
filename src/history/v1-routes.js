  if (g = R2.diff.exec(path)) {
    const [, pid, fid] = g;
    if (m !== "GET") throw new HttpError(405, "method_not_allowed", "Method not allowed");
    return json(await diffRevisions(projectCtx(env, k, requestId, pid), pid, fid, url.searchParams.get("from"), url.searchParams.get("to")));
  }
  if (g = R2.revisionRestore.exec(path)) {
    const [, pid, fid, n] = g;
    if (m !== "POST") throw new HttpError(405, "method_not_allowed", "Method not allowed");
    writeAllowed(k, pid);
    const key = idemKey(req.headers.get("idempotency-key"));
    const b = await readJson(req);
    const r = await restoreRevision(projectCtx(env, k, requestId, pid), pid, fid, { expected_revision: b.expected_revision, from_revision: Number(n), change_note: b.change_note }, key);
    return json(withLinks(origin, pid, r).body, r.status);
  }
  if (g = R2.metaVersions.exec(path)) {
    const [, pid, fid] = g;
    if (m !== "GET") throw new HttpError(405, "method_not_allowed", "Method not allowed");
    return json(await metaHistory(projectCtx(env, k, requestId, pid), pid, fid, false, url.searchParams.get("cursor") ?? void 0));
  }
  if (g = R2.metaRestore.exec(path)) {
    const [, pid, fid, n] = g;
    if (m !== "POST") throw new HttpError(405, "method_not_allowed", "Method not allowed");
    writeAllowed(k, pid);
    const key = idemKey(req.headers.get("idempotency-key"));
    const b = await readJson(req);
    const r = await restoreMetadata(projectCtx(env, k, requestId, pid), pid, fid, { expected_meta_version: b.expected_meta_version, from_version: Number(n), change_note: b.change_note }, key);
    return json(r.body, r.status);
  }
