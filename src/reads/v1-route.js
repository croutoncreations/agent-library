  if (g = R2.text.exec(path)) {
    const [, pid, fid] = g;
    if (m !== "GET") throw new HttpError(405, "method_not_allowed", "Method not allowed");
    return json(await readTextChunk(projectCtx(env, k, requestId, pid), pid, fid, { ...rtQuery(url.searchParams), kinds: appConnectEnabled(env) ? RT_KINDS_ALL : RT_KINDS_DOCS }));
  }
