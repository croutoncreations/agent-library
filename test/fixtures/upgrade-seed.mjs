// Synthetic library for the upgrade test (test/upgrade-from-0.1.test.mjs): everything is created through an OLD
// release's real HTTP APIs, so the rows, R2 objects and KV entries are exactly what that release writes.
// Nothing here is real user content. Secrets (API key, OAuth and publisher tokens) stay in memory.
import { createHash } from "node:crypto";
import { key, grant, sha256 } from "../helpers.mjs";
import { makePng, makePdf } from "../make-fixtures.mjs";
import { synthMeasurements, toCsv } from "./measurements-synthetic.mjs";

export const PROJECT = "upg-notes", APP_PROJECT = "upg-apps";
export const PLAN_BODIES = [
  "# Upgrade plan\n\nalpha zebrafish\n",
  "# Upgrade plan\n\nalpha zebrafish\nbeta narwhal\n",
  "# Upgrade plan\n\nalpha zebrafish\nbeta narwhal\ngamma 日本語 caf\u00e9\n",
];
export const HTML_BODIES = ["<!doctype html><h1>Synthetic report</h1><p>pangolin</p>", "<!doctype html><h1>Synthetic report v2</h1><p>pangolin axolotl</p><script>document.title = 'x'</script>"];
export const TEMPLATE_SOURCE = "# {{title}}\nProject: {{project}}\nDate: {{date}}\n\n## Notes\n";
export const COMMENTS = [{ revision: 3, body: "Synthetic comment on the third version" }, { revision: 1, body: "Synthetic comment on the first version" }];
const CALLBACK = "http://localhost:5173/agent-library/callback", ORIGIN = "http://localhost:5173";

/**
 * Seed one old Worker (an App Connect harness server, see test/fixtures/app-connect-harness.mjs).
 * features: { templates, publisher } say what this release can do. Returns plain data plus the in-memory secrets.
 */
export async function seedLibrary(h, { templates, publisherApi }) {
  const owner = await h.owner();
  const seed = { project: PROJECT, appProject: APP_PROJECT, docs: {}, features: { templates, publisherApi }, untested: [] };
  const ok = (r, what) => { if (r.status < 200 || r.status > 299) throw new Error(`seed ${what}: ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
  const art = (p, id = "") => `/api/projects/${p}/artifacts${id ? "/" + id : ""}`;

  ok(await owner.req("POST", "/api/projects", { id: PROJECT, title: "Upgrade notes" }), "project");
  ok(await owner.req("POST", "/api/projects", { id: APP_PROJECT, title: "Upgrade app data" }), "app project");

  // An API key (read/write on the notes project), used for one of the versions.
  const k = ok(await owner.req("POST", "/api/api-keys", { label: "Synthetic upgrade key", lifetime_days: 90, projects: [{ project_id: PROJECT, access: "read_write" }] }), "api key");
  seed.apiKey = { id: k.id, secret: k.secret };

  // Markdown with three versions (browser, browser, API key), each with a change note, then a rename and tags.
  const plan = ok(await owner.req("POST", art(PROJECT), { title: "Upgrade plan", body: PLAN_BODIES[0] }), "plan");
  const id = plan.artifact_id;
  ok(await owner.req("PUT", art(PROJECT, id), { expected_revision: 1, body: PLAN_BODIES[1], change_note: "Add narwhal" }), "plan v2");
  const v3 = await fetch(`${h.api}/projects/${PROJECT}/files/${id}`, { method: "PUT", headers: { authorization: `Bearer ${k.secret}`, "content-type": "application/json", "idempotency-key": key("seed") },
    body: JSON.stringify({ expected_revision: 2, body: PLAN_BODIES[2], change_note: "Add unicode via API key" }) });
  if (v3.status !== 200) throw new Error(`seed plan v3: ${v3.status}`);
  ok(await owner.req("PATCH", art(PROJECT, id), { expected_meta_version: 1, title: "Upgrade plan (renamed)", tags: ["q4", "synthetic"] }), "plan meta");
  seed.docs.plan = { id, title: "Upgrade plan (renamed)", tags: ["q4", "synthetic"], revisions: PLAN_BODIES.map((body, i) => ({ rev: i + 1, body, sha256: sha256(Buffer.from(body)) })), notes: [null, "Add narwhal", "Add unicode via API key"] };
  for (const c of COMMENTS) ok(await owner.req("POST", art(PROJECT, id) + "/comments", c), "comment");

  // HTML with two versions.
  const html = ok(await owner.req("POST", art(PROJECT), { kind: "html", title: "Synthetic report", body: HTML_BODIES[0] }), "html");
  ok(await owner.req("PUT", art(PROJECT, html.artifact_id), { expected_revision: 1, body: HTML_BODIES[1], change_note: "Add axolotl" }), "html v2");
  seed.docs.html = { id: html.artifact_id, revisions: HTML_BODIES.map((body, i) => ({ rev: i + 1, body, sha256: sha256(Buffer.from(body)) })) };

  // A trashed document.
  const trash = ok(await owner.req("POST", art(PROJECT), { title: "Trashed note", body: "quokka stays in the trash" }), "trash doc");
  ok(await owner.req("PATCH", art(PROJECT, trash.artifact_id), { expected_meta_version: 1, trashed: true }), "trash");
  seed.docs.trashed = { id: trash.artifact_id, body: "quokka stays in the trash" };

  // Binary files through the real upload flow: begin, PUT the bytes to the single-use link, finish.
  for (const [name, mime, bytes] of [["png", "image/png", makePng()], ["pdf", "application/pdf", makePdf()]]) {
    const b = ok(await owner.req("POST", `/api/projects/${PROJECT}/uploads`, { title: `Synthetic ${name}`, mime, size: bytes.length, sha256: sha256(bytes) }), `${name} begin`);
    ok(await owner.req("PUT", b.put_url, undefined, { raw: bytes, headers: { "content-type": "application/octet-stream" }, idem: false }), `${name} put`);
    const f = ok(await owner.req("POST", `/api/projects/${PROJECT}/uploads/${b.upload_id}/finish`), `${name} finish`);
    seed.docs[name] = { id: f.artifact_id, mime, sha256: sha256(bytes), size: bytes.length, base64: bytes.toString("base64") };
  }

  // A document template (releases that have them): a copy of one version of a source document.
  if (templates) {
    const src = ok(await owner.req("POST", art(PROJECT), { title: "Template source", body: TEMPLATE_SOURCE }), "template source");
    const t = ok(await owner.req("POST", `/api/projects/${PROJECT}/templates`, { source_artifact_id: src.artifact_id, source_revision: 1, title: "Weekly note template", description: "Synthetic template" }), "template");
    seed.docs.template = { id: t.artifact_id, source: src.artifact_id };
  }

  // A legacy per-project agent token (real MCP over /mcp).
  seed.legacyGrant = (await grant(owner, PROJECT, "Synthetic legacy agent", true)).token;

  // An MCP OAuth connection (dynamic client registration, consent, code exchange), as ChatGPT or Claude would make.
  const agent = await h.connectMcpAgent({ [PROJECT]: "write" }, { clientName: "Synthetic upgrade agent" });
  seed.oauth = { client_id: agent.client_id, access_token: agent.access_token, refresh_token: agent.refresh_token };

  // App Connect: a registered app, an owner-approved publisher (new folder in the app project) and a published snapshot.
  // A release without the old publisher API cannot seed this; say so rather than fail.
  if (publisherApi) {
    try {
      const app = await h.registerApp({ display_name: "Synthetic upgrade app (local)", redirect_uris: [CALLBACK], origins: [ORIGIN] });
      const a = await h.authorize(app, { project_id: APP_PROJECT, destination: "new", new_folder_name: "Upgrade App" });
      if (!a.code) throw new Error(`authorize: ${a.error ?? a.error_param}`);
      const t = await h.token({ grant_type: "authorization_code", code: a.code, redirect_uri: a.redirect_uri, client_id: app.client_id, code_verifier: a.verifier, resource: h.resource });
      if (t.status !== 200) throw new Error(`token ${t.status}`);
      const recs = synthMeasurements(5, { seed: 7 });
      const json = JSON.stringify({ schema: "agentlib.measurements/1", meta: { source_app: "synthetic" }, records: recs });
      const csv = toCsv(recs);
      const snap = await h.pub(t.body.access_token, "POST", "/publisher/snapshots", { idem: key("snap"), body: {
        source_revision: 1, exported_at: "2026-10-03T00:00:12-07:00", coverage: { from: recs[0].recorded_at, to: recs.at(-1).recorded_at },
        files: [{ name: "measurements.json", kind: "json", role: "authoritative", schema: "agentlib.measurements/1", content: json },
                { name: "measurements.csv", kind: "csv", role: "derived", derived_from: "measurements.json", schema: "agentlib.measurements/1", content: csv }] } });
      if (snap.status !== 201) throw new Error(`snapshot ${snap.status} ${snap.text.slice(0, 200)}`);
      const files = snap.json.snapshot.files;
      seed.publisher = { client_id: app.client_id, access_token: t.body.access_token, refresh_token: t.body.refresh_token,
        files: files.map((f) => ({ name: f.name, file_id: f.file_id, sha256: f.sha256 })), content: { "measurements.json": json, "measurements.csv": csv },
        manifest: { file_id: snap.json.snapshot.manifest.file_id, sha256: snap.json.snapshot.manifest.sha256 } };
    } catch (e) { seed.untested.push(`App Connect publisher seeding failed on this release (${e.message})`); }
  } else seed.untested.push("App Connect publisher seeding: this release has no snapshot publisher API");

  // A project backup taken by the OLD Worker (its schema), to be imported by the new one.
  const backup = await owner.req("GET", `/api/projects/${PROJECT}/backup`);
  ok(backup, "old backup");
  seed.oldBackup = backup.body;
  seed.oldBackupDigest = createHash("sha256").update(JSON.stringify(backup.body)).digest("hex");
  return seed;
}
