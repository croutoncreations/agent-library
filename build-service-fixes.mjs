// Service fixes integration step (run AFTER build-design-bundle.mjs --consent-style).
// Starts from the design bundle (build-design-bundle.mjs output) and applies exact, reviewed text patches
// inside the service module (// src/service.ts) only; every byte outside that module must stay identical.
// Each patch must match exactly once. The TypeScript sources are NOT rebuilt (see build-design-bundle.mjs).
// No config, credentials, database or network is used.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
const DESIGN='182f3cc35f623373ca2082e6564cbd60223a8ef8dd16f92f78186154d9265472';
const input=readFileSync('src/index.js','utf8');
if(sha(input)!==DESIGN)throw Error('Input is not the design bundle 7f0efe69; run build-design-bundle.mjs --consent-style first');
const once=(s,needle,what)=>{const i=s.indexOf(needle);if(i<0||s.indexOf(needle,i+1)>=0)throw Error('Expected exactly one '+what);return i;};
const start=once(input,'// src/service.ts\n','service module start');
const end=once(input,'\n// src/links.ts\n','service module end')+1;
const oldMod=input.slice(start,end);

// A concurrent retry with the same idempotency key can lose the gated batch to its twin; the twin has already
// stored the result, so the loser must replay it (as the request contract promises) instead of reporting a conflict.
const REPLAY='    // A concurrent retry with the same idempotency key may have won: replay its stored result.\n    const replay = await idemLookup(ctx, i);\n    if (replay) return replay;\n';
const PATCHES=[
 {name:'publishRevision: replay a same-key twin before revision_conflict',
  find:'  if (!out2[0].meta.changes) {\n    const cur = await db(ctx).prepare("SELECT head_rev, trashed_at FROM artifacts WHERE id = ? AND project_id = ?").bind(artifactId, projectId).first();\n'},
 {name:'updateMetadata: replay a same-key twin before metadata_conflict',
  find:'  if (!out2[0].meta.changes) {\n    const cur = await db(ctx).prepare("SELECT meta_version FROM artifacts WHERE id = ? AND project_id = ?").bind(artifactId, projectId).first("meta_version");\n'},
];
let mod=oldMod;
for(const p of PATCHES){
 const i=once(mod,p.find,p.name);
 const head='  if (!out2[0].meta.changes) {\n';
 mod=mod.slice(0,i)+head+REPLAY+mod.slice(i+head.length);
}
const out=input.slice(0,start)+mod+input.slice(end);
if(out.slice(0,start)!==input.slice(0,start)||!out.endsWith(input.slice(end)))throw Error('Bytes outside the service module changed');
writeFileSync('src/index.js',out);
const meta={base_design_sha256:DESIGN,integrated_sha256:sha(out),
 preserved_prefix_sha256:sha(input.slice(0,start)),preserved_suffix_sha256:sha(input.slice(end)),
 service_module_sha256:{design:sha(oldMod),candidate:sha(mod)},patched_module:'src/service.ts',patches:PATCHES.map(p=>p.name)};
writeFileSync('service-fixes-preservation.json',JSON.stringify(meta,null,2)+'\n');
console.log(JSON.stringify(meta,null,1));
