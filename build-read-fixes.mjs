// Revision-pinned chunked text reads (run AFTER build-app-connect-fixes.mjs, the last step before it). See docs/chunked-reads.md.
// Starts from the app-connect-fixes bundle and applies exact, once-matching text patches; each patch names the module it
// belongs to and must match exactly once inside it. Everything outside the patched spans stays byte-identical
// (checked below by undoing every patch on the output). The TypeScript sources are NOT rebuilt.
// No migration, config, credentials, database or network is used.
//
// What it adds (one shared service function, readTextChunk in src/reads/service.js, used by every transport):
//   - read_artifact (OAuth MCP and legacy /mcp): optional cursor / max_bytes for bounded chunks of one pinned version
//   - GET /v1/projects/:p/files/:f/text and browser GET /api/projects/:p/artifacts/:a/text
// Reads without cursor/max_bytes keep their exact previous behaviour.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
const BASE=JSON.parse(readFileSync('app-connect-fixes-preservation.json','utf8')).integrated_sha256;
const input=readFileSync('src/index.js','utf8');
if(sha(input)!==BASE)throw Error('Input is not the app-connect-fixes bundle; run build-app-connect-fixes.mjs first');
const once=(s,needle,what)=>{const i=s.indexOf(needle);if(i<0||s.indexOf(needle,i+1)>=0)throw Error('Expected exactly one '+what);return i;};
const span=(marker,after=0)=>{const a=input.indexOf('\n'+marker+'\n',after)+1;if(a<=0)throw Error('No module '+marker);const n=input.indexOf('\n// src/',a+marker.length);return [a,n<0?input.length:n+1];};
const MOD={
 service:span('// src/service.ts'),
 oauthMcp:span('// src/oauth/mcp.ts'),
 mcp:span('// src/mcp.ts',input.indexOf('\n// src/uploads.ts\n')),
 v1:span('// src/api/v1.ts',input.indexOf('\n// src/api/credentials.ts\n')),
 index:span('// src/index.ts',input.indexOf('\n// src/api/app-clients.ts\n')),
};
const read=(f)=>readFileSync(f,'utf8');
const P=[];
const add=(m,name,find,rep)=>P.push([m,name,find,rep]);

// ---------------------------------------------------------------- service: the shared implementation
add('service','readTextChunk and helpers (inserted before getArtifact)',
 'async function getArtifact(ctx, projectId, artifactId, revNo) {\n',
 read('src/reads/service.js')+'async function getArtifact(ctx, projectId, artifactId, revNo) {\n');

// ---------------------------------------------------------------- OAuth MCP (artifacts-mcp host)
const CHUNK_DOC=' For long documents pass max_bytes (4096-524288) to get one bounded chunk, then pass next_cursor until eof: every chunk comes from the same version (revision + sha256), so concurrent edits never mix in; a revision_changed error means start again.';
add('oauthMcp','OAuth MCP: read_artifact accepts cursor and max_bytes',
 `        description: "Read a Markdown or HTML document (current or a given revision). Returns body (source text), kind, revision and sha256.",
        inputSchema: S({ project_id: P, artifact_id: A, revision: { type: "integer", minimum: 1 } }, ["artifact_id"]),`,
 `        description: "Read a Markdown or HTML document (current or a given revision). Returns body (source text), kind, revision and sha256.${CHUNK_DOC} Chunks return text, offset, content_bytes, eof and next_cursor.",
        inputSchema: S({ project_id: P, artifact_id: A, revision: { type: "integer", minimum: 1 }, cursor: RT_CURSOR, max_bytes: RT_MAXB }, ["artifact_id"]),`);
add('oauthMcp','OAuth MCP: read_artifact chunk mode',
 `          const r = await getArtifact(c, p, a.artifact_id, a.revision);
          if ((r.artifact.kind === "json" || r.artifact.kind === "csv") && appConnectEnabled(c.env)) {`,
 `          if (a.cursor != null || a.max_bytes != null) return readTextChunk(c, p, a.artifact_id, { revision: a.revision, cursor: a.cursor, maxBytes: a.max_bytes, encoding: "mcp", kinds: appConnectEnabled(c.env) ? RT_KINDS_ALL : RT_KINDS_DOCS });
          const r = await getArtifact(c, p, a.artifact_id, a.revision);
          if ((r.artifact.kind === "json" || r.artifact.kind === "csv") && appConnectEnabled(c.env)) {`);
add('oauthMcp','OAuth MCP: chunk sizes count the request id (it is echoed in the reply)',
 `        clientInfo: mcpClientInfo(msg.params, conn.client_info)
      };`,
 `        clientInfo: mcpClientInfo(msg.params, conn.client_info),
        rpcIdBytes: rtIdBytes(msg.id)
      };`);
add('oauthMcp','OAuth MCP: chunked reads bound every reply, errors included',
 'const reply = /* @__PURE__ */ __name((body2, status = 200) => new Response(JSON.stringify(body2), { status, headers: HDR }), "reply");',
 'let rtLim = null;\n  const reply = /* @__PURE__ */ __name((body2, status = 200) => new Response(rtFit(body2, rtLim), { status, headers: HDR }), "reply");');
add('oauthMcp','OAuth MCP: refuse an over-long id on a chunked read before any reply echoes it',
 '  if (msg.id === void 0) return new Response(null, { status: 202 });\n',
 '  if (msg.id === void 0) return new Response(null, { status: 202 });\n  rtLim = rtChunkLimit(msg);\n  if (rtLim?.idTooLong) return reply(RT_ID_TOO_LONG, 400);\n');
add('oauthMcp','OAuth MCP: rate-limit reply is bounded too',
 '    return new Response(JSON.stringify(rpcErr(msg.id, -32002, "Too many requests")), { status: 429, headers: { ...HDR, "retry-after": "60" } });',
 '    return new Response(rtFit(rpcErr(msg.id, -32002, "Too many requests"), rtLim), { status: 429, headers: { ...HDR, "retry-after": "60" } });');
add('oauthMcp','OAuth MCP: chunk argument schemas',
 '    NOTE = CHANGE_NOTE_SCHEMA;\n',
 '    NOTE = CHANGE_NOTE_SCHEMA;\n    RT_CURSOR = { type: "string", maxLength: 512, description: "next_cursor from the previous chunk" };\n    RT_MAXB = { type: "integer", minimum: 4096, maximum: 524288, description: "Upper bound in bytes for this whole tool result as encoded (default 65536)" };\n');
add('oauthMcp','OAuth MCP: declare chunk schemas',
 'var MCP_TEXT_MAX, SUPPORTED, S, A, P, K, NOTE, unwrap, RO, RW,',
 'var MCP_TEXT_MAX, SUPPORTED, S, A, P, K, NOTE, RT_CURSOR, RT_MAXB, unwrap, RO, RW,');

// ---------------------------------------------------------------- legacy bearer MCP (/mcp on the app host)
add('mcp','legacy MCP: read_artifact chunk mode',
 `    description: "Read an artifact's current (or given) revision. Markdown returns body; binaries return metadata and an authenticated content_url.",
    inputSchema: S2({ project_id: P2, artifact_id: A2, revision: { type: "integer" } }, ["project_id", "artifact_id"]),
    run: /* @__PURE__ */ __name((c, a) => getArtifact(c, a.project_id, a.artifact_id, a.revision), "run")`,
 `    description: "Read an artifact's current (or given) revision. Markdown returns body; binaries return metadata and an authenticated content_url.${CHUNK_DOC}",
    inputSchema: S2({ project_id: P2, artifact_id: A2, revision: { type: "integer" }, cursor: { type: "string", maxLength: 512 }, max_bytes: { type: "integer", minimum: 4096, maximum: 524288 } }, ["project_id", "artifact_id"]),
    run: /* @__PURE__ */ __name((c, a) => a.cursor != null || a.max_bytes != null ? readTextChunk(c, a.project_id, a.artifact_id, { revision: a.revision, cursor: a.cursor, maxBytes: a.max_bytes, encoding: "mcp" }) : getArtifact(c, a.project_id, a.artifact_id, a.revision), "run")`);
add('mcp','legacy MCP: chunk sizes count the request id (it is echoed in the reply)',
 `await tool.run({ ...ctx, clientInfo: mcpClientInfo(msg.params, ctx.grantClientInfo) }, args)`,
 `await tool.run({ ...ctx, clientInfo: mcpClientInfo(msg.params, ctx.grantClientInfo), rpcIdBytes: rtIdBytes(msg.id) }, args)`);
add('mcp','legacy MCP: refuse an over-long id on a chunked read before any reply echoes it',
 '  if (msg.id === void 0) return new Response(null, { status: 202 });\n',
 '  if (msg.id === void 0) return new Response(null, { status: 202 });\n  const rtLim = rtChunkLimit(msg);\n  if (rtLim?.idTooLong) return new Response(JSON.stringify(RT_ID_TOO_LONG), { status: 400, headers: hdr });\n');
add('mcp','legacy MCP: chunked reads bound every reply, errors included',
 'const reply = /* @__PURE__ */ __name((body2) => new Response(JSON.stringify(body2), { status: 200, headers: hdr }), "reply");',
 'const reply = /* @__PURE__ */ __name((body2) => new Response(rtFit(body2, rtLim), { status: 200, headers: hdr }), "reply");');

// ---------------------------------------------------------------- /v1 machine API
add('v1','route: text chunks',
 '  content: new RegExp(`^/v1/projects/${SEG}/files/${SEG}/content$`),\n',
 '  content: new RegExp(`^/v1/projects/${SEG}/files/${SEG}/content$`),\n  text: new RegExp(`^/v1/projects/${SEG}/files/${SEG}/text$`),\n');
add('v1','handler: text chunks',
 '  if (g = R2.records.exec(path)) {\n',
 read('src/reads/v1-route.js')+'  if (g = R2.records.exec(path)) {\n');

// ---------------------------------------------------------------- browser API (app host)
add('index','browser API: text chunks',
 '    if (sub === "diff" && m === "GET") return json(await diffRevisions(ctx, pid, aid,',
 '    if (sub === "text" && m === "GET") return json(await readTextChunk(ctx, pid, aid, rtQuery(url.searchParams)));\n    if (sub === "diff" && m === "GET") return json(await diffRevisions(ctx, pid, aid,');

// ---------------------------------------------------------------- apply
const order=Object.entries(MOD).sort((a,b)=>a[1][0]-b[1][0]);
for(let i=1;i<order.length;i++)if(order[i][1][0]<order[i-1][1][1])throw Error('Overlapping modules '+order[i-1][0]+'/'+order[i][0]);
const mods=Object.fromEntries(Object.entries(MOD).map(([k,[a,b]])=>[k,input.slice(a,b)]));
const applied=[];
for(const [m,name,find,rep] of P){
 const s=mods[m];const i=once(s,find,`${m}: ${name}`);
 mods[m]=s.slice(0,i)+rep+s.slice(i+find.length);
 applied.push({module:m,name,find_sha256:sha(find)});
}
let out='',pos=0;
for(const [k,[a,b]] of order){out+=input.slice(pos,a)+mods[k];pos=b;}
out+=input.slice(pos);
// Preservation: undo every patch (reverse order, exact) and require the original bundle back.
const undo={...mods};
for(const [m,name,find,rep] of [...P].reverse()){const s=undo[m];const i=s.lastIndexOf(rep);if(i<0)throw Error('Cannot undo '+name);undo[m]=s.slice(0,i)+find+s.slice(i+rep.length);}
let back='';pos=0;for(const [k,[a,b]] of order){back+=input.slice(pos,a)+undo[k];pos=b;}back+=input.slice(pos);
if(back!==input)throw Error('Bytes outside the listed patches changed');
writeFileSync('src/index.js',out);
const meta={base_app_connect_fixes_sha256:BASE,integrated_sha256:sha(out),
 sources_sha256:Object.fromEntries(['service.js','v1-route.js'].map(f=>[f,sha(read('src/reads/'+f))])),
 patches:applied};
writeFileSync('read-fixes-preservation.json',JSON.stringify(meta,null,2)+'\n');
console.log(`Applied ${applied.length} patches; ${sha(out)}`);
