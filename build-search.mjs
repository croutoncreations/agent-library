// Add ranked search after file tools. Exact once-matching patches; reverse reconstruction proves preservation.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
const BASE=JSON.parse(readFileSync('file-tools-fixes-preservation.json','utf8')).integrated_sha256;
const input=readFileSync('src/index.js','utf8');
if(sha(input)!==BASE)throw Error('Input is not the file-tools-fixes bundle');
const once=(s,needle,what)=>{const i=s.indexOf(needle);if(i<0||s.indexOf(needle,i+1)>=0)throw Error('Expected exactly one '+what);return i;};
const span=(marker,after=0)=>{const a=input.indexOf('\n'+marker+'\n',after)+1;if(a<=0)throw Error('No module '+marker);const n=input.indexOf('\n// src/',a+marker.length);return [a,n<0?input.length:n+1];};
const MOD={publisher:span('// src/api/publisher.ts — isolated readable-generation integration'), ui:span('// src/ui.ts'), service:span('// src/service.ts'), oauthMcp:span('// src/oauth/mcp.ts'),
 mcp:span('// src/mcp.ts',input.indexOf('\n// src/uploads.ts\n')),
 v1:span('// src/api/v1.ts',input.indexOf('\n// src/api/credentials.ts\n')),
 index:span('// src/index.ts',input.indexOf('\n// src/api/app-clients.ts\n'))};
const read=f=>readFileSync(f,'utf8');
const P=[];
const add=(m,name,find,rep)=>P.push([m,name,find,rep]);
add('service','shared ranked search', 'async function getArtifact(ctx, projectId, artifactId, revNo) {\n',read('src/search/service.js')+'\nasync function getArtifact(ctx, projectId, artifactId, revNo) {\n');
add('service','bound search RPC envelopes including request IDs',
 '  const a = msg?.method === "tools/call" && msg.params?.name === "read_artifact" ? msg.params.arguments : void 0;',
 '  if (msg?.method === "tools/call" && msg.params?.name === "search_artifacts") return { maxBytes: 65536, idTooLong: rtIdBytes(msg.id) > RT_MAX_ID_BYTES };\n  const a = msg?.method === "tools/call" && msg.params?.name === "read_artifact" ? msg.params.arguments : void 0;');
// rtFit uses maxBytes, inspect with the build guard below if upstream changes this contract.
add('oauthMcp','read-only global search tool', '    TOOLS = [\n', `    TOOLS = [
      { name: "search_artifacts", title: "Search library", description: "Ranked lexical search across currently readable projects. All words must match stored title/text; punctuation separates words. Returns bounded plain-text excerpts and revision-pinned links. Live pagination expires after 15 minutes.", inputSchema: RS_SCHEMA, annotations: RO, write: false, run: (c, p, a) => searchArtifacts(c,a,"mcp") },
`);
add('oauthMcp','search spans connection projects without project selection',
 '      let proj = conn.projects.length === 1 && args.project_id === void 0 ? conn.projects[0] : void 0;',
 `      if (tool.name === "search_artifacts") {
        try {
          const result = await searchArtifacts({ env, requestId: randomId("req",9), principal: { id: conn.owner_principal_id, kind: "agent" }, grant: { id: conn.id }, oauthConnection: true, ftConn: conn, rpcIdBytes: rtIdBytes(msg.id) }, args, "mcp");
          return reply(rpc(msg.id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false }));
        } catch(e) {
          if (!(e instanceof HttpError)) throw e;
          return reply(rpc(msg.id, toolError({ status: e.status, code: e.code, message: e.message })));
        }
      }
      let proj = conn.projects.length === 1 && args.project_id === void 0 ? conn.projects[0] : void 0;`);
add('mcp','legacy search tool', 'var TOOLS2 = [\n',`var TOOLS2 = [
  { name: "search_artifacts", description: "Ranked lexical search of currently readable projects, with excerpts and revision-pinned links. All words must match. Live pagination.", inputSchema: RS_SCHEMA, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, run: (c,a) => searchArtifacts(c,a,"mcp") },
`);
add('mcp','advertise read-only hints', 'TOOLS2.map(({ name, description, inputSchema }) => ({\n        name,', 'TOOLS2.map(({ name, description, inputSchema, annotations }) => ({\n        annotations,\n        name,');
add('v1','machine search route recognition', 'var R2 = {\n', 'var R2 = {\n  search: /^\\/v1\\/search$/,\n');
add('v1','machine search endpoint', '  if (R2.projects.test(path)) {', `  if (R2.search.test(path)) {
    if (m !== "GET") throw new HttpError(405,"method_not_allowed","Method not allowed");
    return json(await searchArtifacts({ env, requestId, apiCredential: true, principal: { id: k.principalId, kind: "agent" }, grant: { id: k.credentialId } }, rsQuery(url.searchParams)));
  }
  if (R2.projects.test(path)) {`);
add('index','owner search endpoint', '  if (seg[0] === "me" && m === "GET")', '  if (seg[0] === "search" && seg[1] === "status" && seg.length === 2 && m === "GET") { requireHuman(ctx); return json({ready: await rsReady(env)}); }\n  if (seg[0] === "search" && seg.length === 1 && m === "GET") { requireHuman(ctx); return json(await searchArtifacts(ctx, rsQuery(url.searchParams))); }\n  if (seg[0] === "me" && m === "GET")');
add('ui','global search browser screen', '// ---------- home: authorized', read('src/search/browser.js')+'// ---------- home: authorized');
add('ui','global search browser route', '  if (p[0] === "projects") return viewProjects();', '  if (p[0] === "search") return viewSearch();\n  if (p[0] === "projects") return viewProjects();');
add('ui','Home search entry', 'actions: h("a", { class: "btn secondary", href: "#/projects" }, icon("folder"), "All projects")', 'actions: [searchEntry(), h("a", { class: "btn secondary", href: "#/projects" }, icon("folder"), "All projects")]');
add('ui','search layout', 'var APP_CSS = `', 'var APP_CSS = `'+read('src/search/browser.css'));
add('publisher','index generations in the existing atomic publication batch', '    let res;\n    try {\n      res = await env.DB.batch(q);', read('src/search/generation-index.js')+'    let res;\n    try {\n      res = await env.DB.batch(q);');
add('publisher','keep every original commit count check and verify the derived index', 'if (res.some((r, i) => (r.meta.changes ?? 0) !== expect[i])) {', 'if (res.slice(0, expect.length).some((r, i) => (r.meta.changes ?? 0) !== expect[i]) || res.at(-1).results[0].indexed_count !== parts.length + 1) {');
add('oauthMcp','check index readiness before advertising tools', '  const tool = msg.method === "tools/call" ? ftToolsFor(env, conn).find', '  const searchReady = await rsToolReady(env,msg);\n  const tool = msg.method === "tools/call" ? ftToolsFor(env, conn).filter(t => t.name !== "search_artifacts" || searchReady).find');
add('oauthMcp','hide search from the tool catalog until ready', 'ftToolsFor(env, conn).filter((t) => anyWrite || !t.write)', 'ftToolsFor(env, conn).filter((t) => (t.name !== "search_artifacts" || searchReady) && (anyWrite || !t.write))');
add('mcp','check legacy search readiness', '  switch (msg.method) {', '  const searchReady = await rsToolReady(env,msg);\n  switch (msg.method) {');
add('mcp','hide legacy search from catalog', 'TOOLS2.map(({ name, description, inputSchema, annotations })', 'TOOLS2.filter(t => t.name !== "search_artifacts" || searchReady).map(({ name, description, inputSchema, annotations })');
add('mcp','hide legacy search calls until ready', 'const tool = TOOLS2.find(', 'const tool = TOOLS2.filter(t => t.name !== "search_artifacts" || searchReady).find(');
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
const meta={base_file_tools_fixes_sha256:BASE,integrated_sha256:sha(out),
 sources_sha256:Object.fromEntries(['service.js','browser.js','browser.css','generation-index.js'].map(f=>[f,sha(read('src/search/'+f))])),
 patches:applied};
writeFileSync('search-preservation.json',JSON.stringify(meta,null,2)+'\n');
console.log(`Applied ${applied.length} patches; ${sha(out)}`);
