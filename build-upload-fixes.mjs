// Upload finalization fixes (run AFTER build-session-fixes.mjs, the last step before it). Security review 2026-10-23:
//  1. cleanup could fail an expired sealed upload and delete its final object while a retried finish was publishing
//     it (HTTP 200, revision pointing at deleted bytes);
//  3. concurrent finishes each wrote their own final object, leaving untracked objects outside quota and cleanup.
// Starts from the session-fixes bundle and changes exactly five pinned regions; every other byte stays identical:
//  - // src/service.ts publishRevision: an optional rev.fence predicate joins the revision insert's guard;
//  - // src/uploads.ts uploadFinish: replaced by src/upload-fixes/finish.js (exclusive expiring lease, one final key);
//  - // src/cleanup.ts reconcileUploads: a sealed upload whose lease is live is never failed, and a failed upload's
//    final object is purged only when no final write is in flight (uploads.final_writes), so no late write survives.
// Needs migration 0011_upload_finalize_lease.sql. The TypeScript sources are NOT rebuilt (see build-design-bundle.mjs).
// No config, credentials, database or network is used.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
const BASE=JSON.parse(readFileSync('session-fixes-preservation.json','utf8')).integrated_sha256;
const input=readFileSync('src/index.js','utf8');
if(sha(input)!==BASE)throw Error('Input is not the session-fixes bundle; run build-session-fixes.mjs first');
const once=(s,needle,what,from=0)=>{const i=s.indexOf(needle,from);if(i<0||s.indexOf(needle,i+1)>=0)throw Error('Expected exactly one '+what);return i;};
const between=(startMark,endMark,what)=>{const a=once(input,startMark,what+' start');const b=input.indexOf(endMark,a);if(b<0)throw Error('No end for '+what);return [a,b];};

const finish=readFileSync('src/upload-fixes/finish.js','utf8');
if(!finish.includes('async function uploadFinish(ctx, projectId, uploadId, key) {\n')||/^(import|export)\s/m.test(finish))throw Error('src/upload-fixes/finish.js must define uploadFinish and nothing importable');
const REGIONS=[
 {name:'service: publishRevision accepts a fence predicate on the revision insert',module:'// src/service.ts\n',
  find:'  const az = { sql: `${azBase.sql} AND ${cw.sql}`, params: [...azBase.params, ...cw.params] };\n',
  replace:'  const az = { sql: `${azBase.sql} AND ${cw.sql}${rev.fence ? " AND " + rev.fence.sql : ""}`, params: [...azBase.params, ...cw.params, ...rev.fence?.params ?? []] };\n'},
 {name:'uploads: uploadFinish holds an exclusive expiring lease and writes one final object per upload',module:'// src/uploads.ts\n',
  region:['async function uploadFinish(ctx, projectId, uploadId, key) {\n','__name(uploadFinish, "uploadFinish");\n'],
  pin:'4b400cad24e3c95615a53ea84c9d6950942f4e8694738c23bfa28c6902438ae5',
  replace:finish.replace(/\n*$/,'\n')},
 {name:'cleanup: a sealed upload with a live finalization lease is never failed',module:'// src/cleanup.ts\n',
  find:"  const e3 = await DB.prepare(`UPDATE uploads SET state = 'failed', result = ? WHERE state = 'sealed' AND expires_at <= ?${pf}\n      AND NOT EXISTS (SELECT 1 FROM revisions r WHERE r.id = uploads.final_revision_id)`).bind(CRASHED, now - grace, ...pp).run();\n",
  replace:"  const e3 = await DB.prepare(`UPDATE uploads SET state = 'failed', result = ?, finalize_token = NULL, finalize_until = NULL WHERE state = 'sealed' AND expires_at <= ? AND (finalize_until IS NULL OR finalize_until <= ?)${pf}\n      AND NOT EXISTS (SELECT 1 FROM revisions r WHERE r.id = uploads.final_revision_id)`).bind(CRASHED, now - grace, now, ...pp).run();\n"},
 {name:'cleanup: warn about retained terminal or published uploads with pending write accounting',module:'// src/cleanup.ts\n',
  find:'  let purgedStaging = 0, purgedFinal = 0;\n',
  replace:`  const retained = await DB.prepare(\`SELECT COUNT(*) AS count, MIN(expires_at) AS oldest_expiry FROM uploads WHERE state IN ('failed','conflict','published') AND final_writes > 0 AND final_key IS NOT NULL AND final_purged_at IS NULL\${pf}\`).bind(...pp).first();
  if (retained?.count > 0) console.warn(JSON.stringify({ event: "upload_final_writes_retained", count: retained.count, oldest_expiry_age_ms: Math.max(0, now - retained.oldest_expiry) }));
  let purgedStaging = 0, purgedFinal = 0;
`},
 {name:'cleanup: a failed upload\'s final object is purged only when no final write is in flight',module:'// src/cleanup.ts\n',
  find:"  const fi = await DB.prepare(`SELECT id, final_key FROM uploads u WHERE final_key IS NOT NULL AND final_purged_at IS NULL AND state IN ('failed','conflict')\n",
  replace:"  const fi = await DB.prepare(`SELECT id, final_key FROM uploads u WHERE final_key IS NOT NULL AND final_purged_at IS NULL AND state IN ('failed','conflict') AND final_writes = 0\n"},
];
// Locate every region in the input (each inside its module, after that module's marker), then splice back to front.
const spans=REGIONS.map(r=>{
 const m=once(input,r.module,r.name+' module');
 let a,b;
 if(r.find){a=once(input,r.find,r.name);b=a+r.find.length;}
 else{a=once(input,r.region[0],r.name);b=once(input,r.region[1],r.name+' end')+r.region[1].length;
  const got=sha(input.slice(a,b));if(got!==r.pin)throw Error(`${r.name}: pinned region changed (now ${got}); re-review it, then update its pin`);}
 const next=input.indexOf('\n// src/',m+r.module.length);
 if(a<m||(next>=0&&b>next+1))throw Error(r.name+': region is not inside '+r.module.trim());
 return {...r,a,b,old:input.slice(a,b)};
}).sort((x,y)=>x.a-y.a);
for(let k=1;k<spans.length;k++)if(spans[k].a<spans[k-1].b)throw Error('Overlapping regions');
let out='',pos=0;
for(const s of spans){out+=input.slice(pos,s.a)+s.replace;pos=s.b;}
out+=input.slice(pos);
// Everything outside the regions is byte-identical to the input.
const gaps=[];pos=0;for(const s of spans){gaps.push(input.slice(pos,s.a));pos=s.b;}gaps.push(input.slice(pos));
{let o=0,k=0;for(const g of gaps){if(out.slice(o,o+g.length)!==g)throw Error('Bytes outside the patched regions changed');o+=g.length+(k<spans.length?spans[k].replace.length:0);k++;}}
writeFileSync('src/index.js',out);
const meta={base_session_fixes_sha256:BASE,integrated_sha256:sha(out),preserved_outside_regions_sha256:sha(gaps.join('\u0000')),
 regions:spans.map(s=>({name:s.name,module:s.module.trim(),base_sha256:sha(s.old),candidate_sha256:sha(s.replace)})),
 requires_migration:'0011_upload_finalize_lease.sql'};
writeFileSync('upload-fixes-preservation.json',JSON.stringify(meta,null,2)+'\n');
console.log(JSON.stringify(meta,null,1));
