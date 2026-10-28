// Durable project changes feed. Run after build-search.mjs. See docs/project-changes.md.
// Starts from the ranked-search bundle and applies exact, once-matching text patches; each patch names the module it
// belongs to and must match exactly once inside it. Everything outside the patched spans stays byte-identical
// (checked below by undoing every patch on the output). The TypeScript sources are NOT rebuilt.
// No migration, config, credentials, database or network is used.
//
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
const BASE=JSON.parse(readFileSync('search-preservation.json','utf8')).integrated_sha256;
const input=readFileSync('src/index.js','utf8');
if(sha(input)!==BASE)throw Error('Input is not the ranked-search bundle; run build-search.mjs first');
const once=(s,needle,what)=>{const i=s.indexOf(needle);if(i<0||s.indexOf(needle,i+1)>=0)throw Error('Expected exactly one '+what);return i;};
const span=(marker,after=0)=>{const a=input.indexOf('\n'+marker+'\n',after)+1;if(a<=0)throw Error('No module '+marker);const n=input.indexOf('\n// src/',a+marker.length);return [a,n<0?input.length:n+1];};
const MOD={
 publisher:span('// src/api/publisher.ts — isolated readable-generation integration'),
 service:span('// src/service.ts'),
 oauthMcp:span('// src/oauth/mcp.ts'),
 mcp:span('// src/mcp.ts',input.indexOf('\n// src/uploads.ts\n')),
 v1:span('// src/api/v1.ts',input.indexOf('\n// src/api/credentials.ts\n')),
 index:span('// src/index.ts',input.indexOf('\n// src/api/app-clients.ts\n')),
};
const read=(f)=>readFileSync(f,'utf8');
const P=[];
const add=(m,name,find,rep)=>P.push([m,name,find,rep]);

add('service','shared durable changes polling service', 'async function getArtifact(ctx, projectId, artifactId, revNo) {\n', read('src/changes/service.js')+'async function getArtifact(ctx, projectId, artifactId, revNo) {\n');
const description='Poll published changes in one explicit project. WITHOUT cursor establishes a current checkpoint and returns NO history (initialized=true). Store next_cursor; follow has_more, then poll again. At-least-once: deduplicate by event_id. Cursors expire after 30 days; checkpoint BEFORE reconciling current content. Publishers excluded. No bodies or push notifications.';
const props='{ project_id: { type: "string", maxLength: 64 }, cursor: { type: "string", maxLength: 2048 }, limit: { type: "integer", minimum: 1, maximum: 50 } }';
add('oauthMcp','OAuth MCP list_changes', '    TOOLS = [\n', `    TOOLS = [
      { name: "list_changes", title: "List project changes", description: ${JSON.stringify(description)}, inputSchema: S(${props}, ["project_id"]), annotations: RO, write: false, run: (c,p,a) => listChanges(c,p,a) },
`);
add('oauthMcp','require explicit project on changes even for single project connections',
 '      let proj = conn.projects.length === 1 && args.project_id === void 0 ? conn.projects[0] : void 0;',
 '      if (tool.name === "list_changes" && !args.project_id) return reply(rpc(msg.id, toolError({ status: 400, code: "project_required", message: "Pass one explicit project_id" })));\n      let proj = conn.projects.length === 1 && args.project_id === void 0 ? conn.projects[0] : void 0;');
add('mcp','legacy MCP list_changes', 'var TOOLS2 = [\n', `var TOOLS2 = [
  { name: "list_changes", description: ${JSON.stringify(description)}, inputSchema: S2(${props}, ["project_id"]), run: (c,a) => listChanges(c,a.project_id,a) },
`);
// Existing reply guards cover successful, failing and oversized RPC-ID responses for both MCP implementations.
add('service','bound the complete changes MCP response',
 '  const a = msg?.method === "tools/call" && msg.params?.name === "read_artifact" ? msg.params.arguments : void 0;',
 '  if (msg?.method === "tools/call" && msg.params?.name === "list_changes") return { maxBytes: 65536, idTooLong: rtIdBytes(msg.id) > RT_MAX_ID_BYTES };\n  const a = msg?.method === "tools/call" && msg.params?.name === "read_artifact" ? msg.params.arguments : void 0;');
add('v1','machine API changes route', '  projects: /^\\/v1\\/projects$/,\n', '  projects: /^\\/v1\\/projects$/,\n  changes: new RegExp(`^/v1/projects/${SEG}/changes$`),\n');
add('v1','machine API changes handler', '  if (g = R2.files.exec(path)) {\n', `  if (g = R2.changes.exec(path)) {
    if (m !== "GET") throw new HttpError(405, "method_not_allowed", "Method not allowed");
    return json(await listChanges(projectCtx(env,k,requestId,g[1]),g[1],chQuery(url.searchParams)));
  }
  if (g = R2.files.exec(path)) {
`);
add('index','owner API changes route', '  if (rest[0] === "audit" && m === "GET") return json(await listAudit(ctx, pid));',
 '  if (rest[0] === "changes" && rest.length === 1 && m === "GET") return json(await listChanges(ctx,pid,chQuery(url.searchParams)));\n  if (rest[0] === "audit" && m === "GET") return json(await listAudit(ctx, pid));');
add('index','bounded changes retention on existing cron', '  async scheduled(_ev, env, ctx) {\n',
 '  async scheduled(_ev, env, ctx) {\n    ctx.waitUntil(cleanupChanges(env));\n');
// D1 meta.changes includes trigger writes. Keep the exact generation cardinality check using
// SQLite changes(), which excludes triggers, inside the same atomic batch, including derived search statements.
add('publisher','generation checks count direct writes, excluding trigger side effects',
 '      res = await env.DB.batch(q);', read('src/changes/generation-batch.js').trimEnd());

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
const meta={base_search_sha256:BASE,integrated_sha256:sha(out),
 sources_sha256:Object.fromEntries(['service.js','generation-batch.js'].map(f=>[f,sha(read('src/changes/'+f))])),
 patches:applied};
writeFileSync('changes-preservation.json',JSON.stringify(meta,null,2)+'\n');
console.log(`Applied ${applied.length} patches; ${sha(out)}`);
