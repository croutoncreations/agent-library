// Real D1/Worker + official legacy MCP SDK + OAuth + machine API. Synthetic fixtures only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { startAppConnectServer } from "./fixtures/app-connect-harness.mjs";
import { SERVER_PORTS } from "./ports.mjs";
import { mcpClient, grant, key, ROOT, LOCAL_CONFIG } from "./helpers.mjs";
import { makePng } from "./make-fixtures.mjs";
import { createHash } from "node:crypto";
const P = "synthetic-changes";
let h, o, g, m, apiKey, oauth;
const path = `/api/projects/${P}`;
const sha = (s) => createHash("sha256").update(s).digest("hex");
const create = async (title = "Synthetic note") => {
  const r = await o.req("POST", path + "/artifacts", {
    title,
    body: "# Synthetic\nA test document.",
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.artifact_id;
};
const poll = async (cursor, limit) => {
  const r = await o.req(
    "GET",
    path +
      "/changes?" +
      new URLSearchParams({
        ...(cursor ? { cursor } : {}),
        ...(limit ? { limit } : {}),
      }),
  );
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
const sql = async (q) =>
  JSON.parse(
    (
      await promisify(execFile)(
        "wrangler",
        [
          "d1",
          "--config",
          LOCAL_CONFIG,
          "execute",
          "DB",
          "--local",
          "--persist-to",
          h.dir,
          "--json",
          "--command",
          q,
        ],
        { cwd: ROOT, env: { ...process.env, CI: "1", NO_COLOR: "1" } },
      )
    ).stdout,
  )[0].results;
before(async () => {
  h = await startAppConnectServer({ port: SERVER_PORTS["project-changes"] });
  o = await h.owner();
  for (const id of [P, "synthetic-other"])
    assert.equal(
      (await o.req("POST", "/api/projects", { id, title: id })).status,
      201,
    );
  g = await grant(o, P, "Synthetic legacy reader", false);
  m = await mcpClient(h.appUi, g.token);
  apiKey = (
    await o.req("POST", "/api/api-keys", {
      label: "Synthetic API reader",
      lifetime_days: 1,
      projects: [{ project_id: P, access: "read" }],
    })
  ).body;
  oauth = await h.connectMcpAgent(
    { [P]: "write" },
    { clientName: "Synthetic OAuth writer" },
  );
});
after(async () => {
  await m?.close();
  await h?.stop();
});
test("explicit checkpoints; two agents create/edit, ordered distinct events, idempotency and conflicts", async () => {
  await create("Preexisting content");
  const initial = await poll();
  assert.equal(initial.initialized, true);
  assert.deepEqual(initial.changes, []);
  const cp = await m.call("list_changes", { project_id: P });
  assert.equal(cp.isError, false, JSON.stringify(cp));
  const agent = await oauth.call("create_markdown", {
    project_id: P,
    title: "Agent report",
    body: "Synthetic report",
    idempotency_key: key(),
  });
  assert.equal(agent.isError, false, JSON.stringify(agent));
  const id = agent.data.artifact_id;
  const idem = key();
  const save = {
    project_id: P,
    artifact_id: id,
    expected_revision: 1,
    body: "Synthetic v2",
    idempotency_key: idem,
  };
  assert.equal((await oauth.call("save_markdown", save)).isError, false);
  assert.equal((await oauth.call("save_markdown", save)).isError, false);
  assert.equal(
    (await oauth.call("save_markdown", { ...save, idempotency_key: key() }))
      .isError,
    true,
  );
  assert.equal(
    (
      await o.req("PUT", path + "/artifacts/" + id, {
        expected_revision: 2,
        body: "Owner v3",
      })
    ).status,
    200,
  );
  const catchup = await m.call("list_changes", {
    project_id: P,
    cursor: cp.data.next_cursor,
  });
  assert.equal(catchup.isError, false, JSON.stringify(catchup));
  assert.deepEqual(
    catchup.data.changes.map((x) => x.revision),
    [1, 2, 3],
  );
  assert.deepEqual(
    catchup.data.changes.map((x) => x.type),
    [
      "artifact.created",
      "artifact.content_updated",
      "artifact.content_updated",
    ],
  );
  assert.equal(new Set(catchup.data.changes.map((x) => x.event_id)).size, 3);
  assert.equal(
    catchup.data.changes[0].connection_label,
    "Synthetic OAuth writer",
  );
  assert.deepEqual(
    (
      await m.call("list_changes", {
        project_id: P,
        cursor: cp.data.next_cursor,
      })
    ).data.changes,
    catchup.data.changes,
  );
  assert.equal(
    (
      await m.call("list_changes", {
        project_id: P,
        cursor: catchup.data.next_cursor,
      })
    ).data.changes.length,
    0,
  );
  mkdirSync("tmp/proof-of-work/project-changes", { recursive: true });
  writeFileSync(
    "tmp/proof-of-work/project-changes/catch-up.json",
    JSON.stringify(
      {
        checkpoint: {
          initialized: cp.data.initialized,
          changes: cp.data.changes,
        },
        catch_up: catchup.data.changes,
      },
      null,
      2,
    ),
  );
});
test("rename, tag, folder, trash safe tombstones, untrash, content and metadata restore", async () => {
  const cp = await poll();
  const id = await create();
  let r = await o.req("PATCH", path + "/artifacts/" + id, {
    expected_meta_version: 1,
    title: "Renamed",
    folder: "Research",
    tags: ["decision"],
  });
  assert.equal(r.status, 200);
  r = await o.req("PATCH", path + "/artifacts/" + id, {
    expected_meta_version: 2,
    trashed: true,
  });
  assert.equal(r.status, 200);
  const hidden = await poll(cp.next_cursor);
  assert.equal(hidden.changes.length, 3);
  for (const e of hidden.changes) {
    assert.equal(e.tombstone, true);
    assert.deepEqual(
      Object.keys(e).sort(),
      [
        "event_id",
        "type",
        "project_id",
        "artifact_id",
        "occurred_at",
        "tombstone",
      ].sort(),
    );
  }
  assert.equal(
    (
      await o.req("PATCH", path + "/artifacts/" + id, {
        expected_meta_version: 3,
        trashed: false,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await o.req("PUT", path + "/artifacts/" + id, {
        expected_revision: 1,
        body: "Updated",
      })
    ).status,
    200,
  );
  const restore = await o.req("POST", path + "/artifacts/" + id + "/restore", {
    expected_revision: 2,
    from_revision: 1,
  });
  assert.equal(restore.status, 200, JSON.stringify(restore));
  const all = await poll(cp.next_cursor);
  assert.deepEqual(
    all.changes.map((e) => e.type),
    [
      "artifact.created",
      "artifact.metadata_updated",
      "artifact.trashed",
      "artifact.restored",
      "artifact.content_updated",
      "artifact.content_updated",
    ],
  );
  assert.deepEqual(all.changes[1].changed_fields, ["title", "folder", "tags"]);
  assert.equal(all.changes.at(-1).restored_from, 1);
  assert.ok(!all.changes[0].web_url.includes("?v="));
  const meta = await o.req(
    "POST",
    path + "/artifacts/" + id + "/meta-restore",
    { expected_meta_version: 4, from_version: 1 },
  );
  assert.equal(meta.status, 200, JSON.stringify(meta.body));
  const restored = await poll(all.next_cursor);
  assert.equal(restored.changes.length, 1);
  assert.equal(restored.changes[0].restored_from, 1);
});
test("frozen paging boundary, writes during paging, empty boundaries and retry", async () => {
  const cp = await poll();
  for (let n = 0; n < 3; n++) await create("Page " + n);
  const first = await poll(cp.next_cursor, 1);
  assert.equal(first.has_more, true);
  await create("Committed during paging");
  const second = await poll(first.next_cursor, 1);
  assert.equal(second.has_more, true);
  const third = await poll(second.next_cursor, 1);
  assert.equal(third.has_more, false);
  assert.equal((await poll(third.next_cursor)).changes.length, 1);
  assert.deepEqual((await poll(first.next_cursor, 1)).changes, second.changes);
  const end = await poll((await poll(third.next_cursor)).next_cursor);
  assert.deepEqual(end.changes, []);
  await create("After empty");
  assert.equal((await poll(end.next_cursor)).changes.length, 1);
});
test("machine API read-only credentials; malformed/tampered/wrong project/wrong caller cursors; bounded MCP IDs", async () => {
  const url = h.api + "/projects/" + P + "/changes";
  const req = async (suffix) =>
    fetch(url + suffix, {
      headers: { authorization: "Bearer " + apiKey.secret },
    });
  const first = await (await req("")).json();
  assert.equal(first.initialized, true, JSON.stringify(first));
  await create();
  const next = await (
    await req("?cursor=" + encodeURIComponent(first.next_cursor))
  ).json();
  assert.equal(next.changes.length, 1);
  const bad = await o.req("GET", path + "/changes?cursor=pc1.bad.bad");
  assert.equal(bad.status, 400);
  assert.equal(
    (await o.req("GET", path + "/changes?cursor=pc2.bad")).body.error.code,
    "unsupported_cursor_version",
  );
  assert.equal(
    (
      await o.req(
        "GET",
        "/api/projects/synthetic-other/changes?cursor=" +
          encodeURIComponent((await poll()).next_cursor),
      )
    ).body.error.code,
    "cursor_wrong_project",
  );
  assert.equal(
    (
      await o.req(
        "GET",
        path + "/changes?cursor=" + encodeURIComponent(first.next_cursor),
      )
    ).body.error.code,
    "cursor_scope_changed",
  );
  assert.equal((await o.req("GET", path + "/changes?limit=51")).status, 400);
  assert.equal(
    (await oauth.call("list_changes", {})).data.error.code,
    "project_required",
  );
  const raw = async (id) =>
    fetch(h.appUi + "/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer " + g.token,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "list_changes", arguments: { project_id: P } },
      }),
    });
  let r = await raw("x".repeat(1022));
  assert.ok(Buffer.byteLength(await r.text()) <= 65536);
  r = await raw("x".repeat(1023));
  assert.equal(r.status, 400);
  assert.equal((await r.json()).id, null);
});
test("binary creation only at upload_finish; abandoned/rejected uploads produce no change", async () => {
  const cp = await poll();
  const png = makePng(20, 20);
  const docOnly = await h.connectMcpAgent({ [P]: "read" });
  await sql(
    "UPDATE oauth_connections SET file_access=0 WHERE client_name='synthetic agent'",
  );
  const docCheckpoint = (await docOnly.call("list_changes", { project_id: P }))
    .data;
  const begin = async () =>
    o.req("POST", path + "/uploads", {
      title: "Synthetic PNG",
      mime: "image/png",
      size: png.length,
      sha256: sha(png),
    });
  const abandoned = await begin();
  assert.equal(abandoned.status, 201, JSON.stringify(abandoned));
  assert.deepEqual((await poll(cp.next_cursor)).changes, []);
  const b = abandoned;
  const put = await o.req("PUT", b.body.put_url, undefined, {
    raw: png,
    headers: { "content-type": "application/octet-stream" },
  });
  assert.ok([200, 204].includes(put.status), JSON.stringify(put));
  assert.deepEqual((await poll(cp.next_cursor)).changes, []);
  const finish = await o.req(
    "POST",
    path + "/uploads/" + b.body.upload_id + "/finish",
    {},
  );
  assert.equal(finish.status, 200, JSON.stringify(finish));
  const done = await poll(cp.next_cursor);
  assert.equal(done.changes.length, 1);
  assert.equal(done.changes[0].type, "artifact.created");
  const hidden = await docOnly.call("list_changes", {
    project_id: P,
    cursor: docCheckpoint.next_cursor,
  });
  assert.equal(hidden.isError, false, JSON.stringify(hidden));
  assert.deepEqual(hidden.data.changes, []);
  await create();
  const visible = await docOnly.call("list_changes", {
    project_id: P,
    cursor: hidden.data.next_cursor,
  });
  assert.equal(visible.data.changes.length, 1);
});
test("App Connect staged generations stay invisible; atomic commit emits each artifact once; publishers excluded", async () => {
  const cp = await poll();
  const app = await h.registerApp({
    display_name: "Synthetic publisher",
    redirect_uris: ["http://localhost:5173/cb"],
    origins: [],
  });
  const pub = await h.connectPublisher(app, {
    project_id: P,
    destination: "root",
  });
  assert.equal(
    (await h.pub(pub.access_token, "GET", "/projects/" + P + "/changes"))
      .status,
    401,
  );
  const gid = "g_feed";
  const data = JSON.stringify({
    format: "agentlib.generation.part/1",
    generation_id: gid,
    source_revision: 1,
    records: [{ synthetic: true }],
  });
  const root = JSON.stringify({
    format: "agentlib.generation.index/1",
    generation_id: gid,
    source_revision: 1,
    entries: [
      {
        name: "part.json",
        sha256: sha(data),
        bytes: Buffer.byteLength(data),
        kind: "synthetic",
        count: 1,
        file: "part.json",
        utf8_bytes: Buffer.byteLength(data),
      },
    ],
  });
  const b = {
    generation_id: gid,
    source_revision: 1,
    expected_current_snapshot_id: null,
    root_name: "root.json",
    root_sha256: sha(root),
    part_count: 2,
    total_bytes: Buffer.byteLength(data) + Buffer.byteLength(root),
  };
  const base = "/publisher/generations";
  let r = await h.pub(pub.access_token, "POST", base, { body: b, idem: key() });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  for (const [name, content] of [
    ["part.json", data],
    ["root.json", root],
  ]) {
    r = await h.pub(
      pub.access_token,
      "PUT",
      base + "/" + gid + "/parts/" + name,
      {
        body: {
          content,
          sha256: sha(content),
          bytes: Buffer.byteLength(content),
        },
      },
    );
    assert.ok([200, 201].includes(r.status), JSON.stringify(r.json));
  }
  assert.deepEqual((await poll(cp.next_cursor)).changes, []);
  r = await h.pub(pub.access_token, "POST", base + "/" + gid + "/commit", {
    body: {},
    idem: key(),
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal((await poll(cp.next_cursor)).changes.length, 3);
  r = await h.pub(pub.access_token, "POST", base + "/" + gid + "/commit", {
    body: {},
    idem: key(),
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((await poll(cp.next_cursor)).changes.length, 3);
  const tracked = await poll();
  await sql("UPDATE change_generation_coverage SET snapshot_id=NULL");
  const gap = await o.req(
    "GET",
    path + "/changes?cursor=" + encodeURIComponent(tracked.next_cursor),
  );
  assert.equal(gap.status, 409);
  assert.equal(gap.body.error.code, "cursor_scope_changed");
  assert.equal((await poll()).initialized, true);
  await sql(
    "UPDATE change_generation_coverage SET snapshot_id=(SELECT current_snapshot_id FROM publishers WHERE id=publisher_id)",
  );
});
test("large escaped labels paginate within the full encoded MCP response budget", async () => {
  const gg = await grant(o, P, "Response budget reader", false);
  const client = await mcpClient(h.appUi, gg.token);
  try {
    const cp = await client.call("list_changes", { project_id: P });
    const id = await create("Wire budget");
    const label = '\\"'.repeat(60);
    await sql(
      "INSERT INTO project_changes(project_id,artifact_id,kind,type,revision_id,revision,sha256,meta_version,changed_fields,connection_label) SELECT project_id,artifact_id,kind,type,revision_id,revision,sha256,meta_version,changed_fields,'" +
        label +
        "' FROM project_changes WHERE artifact_id='" +
        id +
        "' LIMIT 1",
    );
    // Expand to >=50 retained events without another listener or mocked transport.
    for (let n = 0; n < 6; n++)
      await sql(
        "INSERT INTO project_changes(project_id,artifact_id,kind,type,revision_id,revision,sha256,meta_version,changed_fields,connection_label) SELECT project_id,artifact_id,kind,type,revision_id,revision,sha256,meta_version,changed_fields,connection_label FROM project_changes WHERE artifact_id='" +
          id +
          "'",
      );
    let cursor = cp.data.next_cursor,
      count = 0;
    for (let n = 0; n < 10; n++) {
      const r = await fetch(h.appUi + "/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer " + gg.token,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "x".repeat(1022),
          method: "tools/call",
          params: {
            name: "list_changes",
            arguments: { project_id: P, cursor, limit: 50 },
          },
        }),
      });
      const wire = await r.text();
      assert.ok(Buffer.byteLength(wire) <= 65536);
      const page = JSON.parse(wire).result;
      assert.equal(page.isError, false, wire);
      assert.ok(page.structuredContent.changes.length > 0);
      count += page.structuredContent.changes.length;
      cursor = page.structuredContent.next_cursor;
      if (!page.structuredContent.has_more) break;
    }
    assert.equal(count, 128);
  } finally {
    await client.close();
  }
});
test("scope removal/re-add invalidates old cursor; revocation stops later pages", async () => {
  const first = await fetch(h.api + "/projects/" + P + "/changes", {
    headers: { authorization: "Bearer " + apiKey.secret },
  }).then((r) => r.json());
  await sql(
    "UPDATE api_credential_projects SET can_write=1 WHERE project_id='" +
      P +
      "'",
  );
  let r = await fetch(
    h.api +
      "/projects/" +
      P +
      "/changes?cursor=" +
      encodeURIComponent(first.next_cursor),
    { headers: { authorization: "Bearer " + apiKey.secret } },
  );
  assert.equal(r.status, 409);
  const cp = await m.call("list_changes", { project_id: P });
  await create();
  await create();
  const page = await m.call("list_changes", {
    project_id: P,
    cursor: cp.data.next_cursor,
    limit: 1,
  });
  assert.equal(page.data.has_more, true);
  assert.equal(
    (await o.req("PATCH", path + "/grants/" + g.grant_id, { revoke: true }))
      .status,
    200,
  );
  await assert.rejects(
    () =>
      m.call("list_changes", { project_id: P, cursor: page.data.next_cursor }),
    (e) => e.code === 401,
  );
});
test("expired API keys and removed scopes fail with existing cursor; unknown projects reveal nothing", async () => {
  const k = (
    await o.req("POST", "/api/api-keys", {
      label: "Expiry test",
      lifetime_days: 1,
      projects: [{ project_id: P, access: "read" }],
    })
  ).body;
  const req = async (cursor, pid = P) =>
    fetch(
      h.api +
        "/projects/" +
        pid +
        "/changes" +
        (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
      { headers: { authorization: "Bearer " + k.secret } },
    );
  const cp = await (await req()).json();
  assert.equal((await req(undefined, "synthetic-other")).status, 404);
  await sql(
    "DELETE FROM api_credential_projects WHERE credential_id=(SELECT id FROM api_credentials WHERE label='Expiry test')",
  );
  assert.ok([401, 404].includes((await req(cp.next_cursor)).status));
  await sql(
    "UPDATE api_credentials SET expires_at=0 WHERE label='Expiry test'",
  );
  assert.equal((await req(cp.next_cursor)).status, 401);
});
test("retention floor refuses missing events instead of silently checkpointing; bounded cron cleanup", async () => {
  const cp = await poll();
  await create();
  await sql("DELETE FROM project_changes WHERE project_id='" + P + "'");
  const r = await o.req(
    "GET",
    path + "/changes?cursor=" + encodeURIComponent(cp.next_cursor),
  );
  assert.equal(r.status, 410);
  assert.equal(r.body.error.code, "cursor_expired");
  assert.ok(r.body.error.oldest_usable_cursor.startsWith("pc1."));
  const fresh = await poll();
  assert.equal(fresh.initialized, true);
});

test("disabling App Connect hides JSON/CSV for file-enabled OAuth, keeps binaries, and invalidates prior cursors", async () => {
  const reader = await h.connectMcpAgent(
    { [P]: "read" },
    { clientName: "Kind gate reader" },
  );
  const checkpoint = (await reader.call("list_changes", { project_id: P }))
    .data;
  const ids = {};
  for (const [kind, content] of [
    ["json", '{"synthetic":true}'],
    ["csv", "label,value\nsynthetic,1\n"],
  ]) {
    const r = await o.req("POST", path + "/artifacts", {
      kind,
      title: "Gate " + kind,
      content,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    ids[kind] = r.body.artifact_id;
  }
  ids.markdown = await create("Gate Markdown");
  const png = makePng(16, 16);
  const upload = await o.req("POST", path + "/uploads", {
    title: "Gate PNG",
    mime: "image/png",
    size: png.length,
    sha256: sha(png),
  });
  assert.equal(upload.status, 201, JSON.stringify(upload.body));
  assert.equal(
    (
      await o.req("PUT", upload.body.put_url, undefined, {
        raw: png,
        headers: { "content-type": "application/octet-stream" },
      })
    ).status,
    200,
  );
  const finish = await o.req(
    "POST",
    path + "/uploads/" + upload.body.upload_id + "/finish",
    {},
  );
  assert.equal(finish.status, 200, JSON.stringify(finish.body));
  ids.binary = finish.body.artifact_id;
  const enabled = await reader.call("list_changes", {
    project_id: P,
    cursor: checkpoint.next_cursor,
  });
  assert.equal(enabled.isError, false, JSON.stringify(enabled));
  assert.deepEqual(
    enabled.data.changes.map((e) => e.artifact_id).sort(),
    Object.values(ids).sort(),
  );

  // Real configuration transition on the same D1/KV/R2 state, retaining the already approved OAuth token.
  await h.stop();
  h = await startAppConnectServer({
    port: SERVER_PORTS["project-changes"],
    fresh: false,
    vars: { APP_CONNECT_ENABLED: "0" },
  });
  o = await h.owner();
  const old = await reader.call("list_changes", {
    project_id: P,
    cursor: enabled.data.next_cursor,
  });
  assert.equal(
    old.data.error.code,
    "cursor_scope_changed",
    JSON.stringify(old),
  );
  const fresh = (await reader.call("list_changes", { project_id: P })).data;
  // Seed publication receipts for existing synthetic heads, including now-hidden JSON/CSV.
  const clone = async () =>
    sql(`INSERT INTO project_changes(project_id,artifact_id,kind,type,revision_id,revision,sha256,meta_version,changed_fields)
    SELECT a.project_id,a.id,a.kind,'artifact.content_updated',r.id,r.rev_no,r.sha256,a.meta_version,'["content"]'
    FROM artifacts a JOIN revisions r ON r.id=a.head_revision_id WHERE a.id IN (${Object.values(
      ids,
    )
      .map((id) => "'" + id + "'")
      .join(",")})`);
  await clone();
  const observed = [];
  let cursor = fresh.next_cursor;
  for (;;) {
    const r = await reader.call("list_changes", {
      project_id: P,
      cursor,
      limit: 1,
    });
    assert.equal(r.isError, false, JSON.stringify(r));
    observed.push(...r.data.changes.map((e) => e.artifact_id));
    cursor = r.data.next_cursor;
    if (!r.data.has_more) break;
  }
  assert.deepEqual(observed.sort(), [ids.markdown, ids.binary].sort());
  assert.equal(
    (
      await reader.call("read_artifact", {
        project_id: P,
        artifact_id: ids.json,
      })
    ).isError,
    true,
  );
  assert.equal(
    (
      await reader.call("read_file", {
        project_id: P,
        artifact_id: ids.binary,
        include_image: false,
      })
    ).isError,
    false,
  );

  const docs = await h.connectMcpAgent(
    { [P]: "read" },
    { clientName: "Documents with gate off" },
  );
  await sql(
    "UPDATE oauth_connections SET file_access=0 WHERE client_name='Documents with gate off'",
  );
  const docCheckpoint = (await docs.call("list_changes", { project_id: P }))
    .data;
  await clone();
  const docPage = await docs.call("list_changes", {
    project_id: P,
    cursor: docCheckpoint.next_cursor,
  });
  assert.equal(docPage.isError, false, JSON.stringify(docPage));
  assert.deepEqual(
    docPage.data.changes.map((e) => e.artifact_id),
    [ids.markdown],
  );
});
