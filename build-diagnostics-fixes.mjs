// Runs last, after build-template-fixes.mjs. Exact once-matching, module-checked patches; preserves every other byte.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const input = readFileSync('src/index.js', 'utf8');
const base = JSON.parse(readFileSync('template-fixes-preservation.json', 'utf8')).integrated_sha256;
if (sha(input) !== base) throw Error('Run build-template-fixes.mjs first');
const mod = readFileSync('src/diagnostics/service.js', 'utf8');
const once = (needle, what) => { const i = input.indexOf(needle); if (i < 0 || input.indexOf(needle, i + 1) >= 0) throw Error('Expected exactly one ' + what); return i; };
const moduleOf = (i) => { const m = input.lastIndexOf('\n// src/', i); return input.slice(m + 1, input.indexOf('\n', m + 1)); };
// The diagnostic calls the bundled generation write gate directly, in the same IIFE.
// Fail the build if that maintained helper moves or changes its callable name.
if (moduleOf(once("  async function assertStillAuthorized(env, p) {\n", "publisher write gate")) !== "// src/api/publisher.ts — isolated readable-generation integration") throw Error("Publisher write gate moved");
// Ranked search already advertises legacy annotations (templates adds the read-only write filter). Preserve that shared catalog behavior.
if (moduleOf(once('TOOLS2.filter(t => (t.name !== "search_artifacts" || searchReady) && (!t.write || !!ctx.grant?.can_write)).map(({ name, description, inputSchema, annotations }) => ({\n        annotations,', "legacy annotation catalog")) !== "// src/mcp.ts") throw Error("Legacy annotation catalog moved");
const PATCHES = [
  [
    "shared diagnostic serializer",
    "// src/service.ts",
    `async function listProjects(ctx) {
`,
    mod + `async function listProjects(ctx) {
`
  ],
  [
    "OAuth diagnostic discovery",
    "// src/oauth/mcp.ts",
    `    TOOLS = [
`,
    `    TOOLS = [
      { name: "connection_info", title: "Check connection access", description: "Identify this authenticated connection and its current effective project access. No document reads or writes. Compare the safe ID in Connections.", inputSchema: S({}, []), annotations: RO, write: false },
`
  ],
  [
    "OAuth diagnostic before project selection",
    "// src/oauth/mcp.ts",
    `      if (tool.name === "list_projects") {
`,
    `      if (tool.name === "connection_info") {
        const result = connectionInfo("oauth", conn.id, conn.client_name, conn.projects.map((p) => ({ ...p, can_write: projectWrite(p) })), conn.expires_at, conn.last_used_at, { files: conn.file_access === 1 });
        return reply(rpc(msg.id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false }));
      }
      if (tool.name === "list_projects") {
`
  ],
  [
    "legacy diagnostic discovery",
    "// src/mcp.ts",
    `var TOOLS2 = [
`,
    `var TOOLS2 = [
  { name: "connection_info", description: "Identify this authenticated grant and current project access. Read-only; compare the safe ID in Connections.", inputSchema: S2({}, []), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, run: (c) => legacyConnectionInfo(c) },
`
  ],
  [
    "key safe diagnostic metadata",
    "// src/api/credentials.ts",
    `    credentialId: row.id,
`,
    `    expiresAt: row.expires_at,
    lastActivityAt: row.last_used_at,
    credentialId: row.id,
`
  ],
  [
    "machine diagnostic route",
    "// src/api/v1.ts",
    `var R2 = {
`,
    `var R2 = {
  connectionInfo: /^\\/v1\\/connection-info$/,
`
  ],
  [
    "key diagnostic after authentication and rate limit",
    "// src/api/v1.ts",
    `  if (R2.projects.test(path)) {
`,
    `  if (R2.connectionInfo.test(path)) {
    if (m !== "GET") throw new HttpError(405, "method_not_allowed", "Method not allowed");
    if (url.search) throw new HttpError(400, "invalid_input", "This diagnostic accepts no parameters");
    return json(connectionInfo("api_key", k.credentialId, k.label, k.projects, k.expiresAt, k.lastActivityAt), 200, { "cache-control": "no-store" });
  }
  if (R2.projects.test(path)) {
`
  ],
  [
    "publisher own-destination diagnostic",
    "// src/api/publisher.ts — isolated readable-generation integration",
    `    if (R.me.test(path)) {
`,
    `    if (path === "/v1/publisher/connection-info") {
      only("GET");
      if (url.search) throw new live_HttpError(400, "invalid_input", "This diagnostic accepts no parameters");
      const project = await env.DB.prepare("SELECT id, title FROM projects WHERE id = ?").bind(p.project_id).first();
      // Reuse the actual publisher write gate; metadata reads remain available when writes are blocked.
      let canWrite = true, writeRestrictions = [];
      try { await assertStillAuthorized(env, p); }
      catch (e) {
        if (!(e instanceof live_HttpError) || ![401, 403].includes(e.status)) throw e;
        canWrite = false;
        writeRestrictions.push(p.client_disabled !== null ? "Writes blocked: app client disabled; ask the owner to inspect this app." : "Writes blocked: " + e.message);
      }
      return live_json(connectionInfo("publisher", p.id, p.display_name, [], null, null, {
        destination: { project_id: project.id, title: project.title, folder_id: p.folder_id, can_read_own_files: true, can_write_own_files: canWrite },
        restrictions: ["Only this publisher's own files in its approved destination; no general project browsing.", "Kind rules, quotas, revisions and snapshot ordering still apply. No rendering, transfer or write was tested."].concat(writeRestrictions)
      }), 200, { "cache-control": "no-store" });
    }
    if (R.me.test(path)) {
`
  ]
];
const spans = PATCHES.map(([name, module, find, replace]) => {
  const a = once(find, name);
  if (moduleOf(a) !== module) throw Error(`${name}: anchor is in ${moduleOf(a)}, expected ${module}`);
  return { name, module, a, b: a + find.length, find, replace };
}).sort((x, y) => x.a - y.a);
for (let k = 1; k < spans.length; k++) if (spans[k].a < spans[k - 1].b) throw Error('Overlapping patches');
let out = '', pos = 0;
const gaps = [];
for (const s of spans) { gaps.push(input.slice(pos, s.a)); out += input.slice(pos, s.a) + s.replace; pos = s.b; }
gaps.push(input.slice(pos)); out += input.slice(pos);
writeFileSync('src/index.js', out);
const meta = { base_templates_sha256: base, integrated_sha256: sha(out), preserved_outside_patches_sha256: sha(gaps.join('\u0000')), module_sha256: sha(mod), patches: spans.map((s) => ({ name: s.name, module: s.module, find_sha256: sha(s.find), replace_sha256: sha(s.replace) })) };
writeFileSync('diagnostics-preservation.json', JSON.stringify(meta, null, 2) + '\n');
console.log('Connection diagnostics bundle: ' + sha(out));
