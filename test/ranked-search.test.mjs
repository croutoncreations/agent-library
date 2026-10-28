import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { grant, mcpClient, sha256 } from './helpers.mjs';
import { SERVER_PORTS } from './ports.mjs';
import { startAppConnectServer } from './fixtures/app-connect-harness.mjs';
import { backfillSql } from '../scripts/search/backfill.mjs';
const PORT=SERVER_PORTS['ranked-search'], APP=`http://localhost:${PORT}`, API=`http://127.0.0.1:${PORT}`;
let server, owner;
const search=async a=>owner.req('GET','/api/search?'+new URLSearchParams(a));
const create=async(p,title,body)=>{const r=await owner.req('POST',`/api/projects/${p}/artifacts`,{title,body});assert.equal(r.status,201,JSON.stringify(r.body));return r.body.artifact_id;};
const sql=async q=>JSON.parse((await promisify(execFile)('wrangler',['d1','execute','DB','--config','wrangler.local.toml','--local','--persist-to',server.dir,'--command',q,'--json'],{encoding:'utf8',env:{...process.env,WRANGLER_SEND_METRICS:'false'}})).stdout);
before(async()=>{
 server=await startAppConnectServer({port:PORT});
 owner=await server.owner();
 for(const id of ['search-planning','search-notes','search-private']) assert.equal((await owner.req('POST','/api/projects',{id,title:id.replace('search-','') })).status,201);
});
after(async()=>{await server?.stop();});
test('exact titles, buried excerpts, static keyset pagination and query-bound opaque cursors',async()=>{
 const exact=await create('search-planning','Annual subscriptions','Decision record');
 const buried=await create('search-notes','Pricing decision',('Unrelated paragraph.\n').repeat(200)+'Annual subscriptions renew in January.');
 await create('search-private','Private annual subscriptions','annual subscriptions');
 const first=await search({query:'Annual subscriptions',limit:1});assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.results[0].artifact_id,exact);assert.equal(first.body.has_more,true);
 const all=[], cursors=[]; let r=first;
 while(true){ all.push(...r.body.results);if(!r.body.has_more)break;cursors.push(r.body.next_cursor);r=await search({query:'Annual subscriptions',limit:1,cursor:r.body.next_cursor});assert.equal(r.status,200,JSON.stringify(r.body)); }
 assert.equal(new Set(all.map(x=>x.artifact_id)).size,3);
 const hit=all.find(x=>x.artifact_id===buried); assert.match(hit.snippet,/subscriptions/);assert.equal(hit.sha256,sha256(('Unrelated paragraph.\n').repeat(200)+'Annual subscriptions renew in January.'));assert.match(hit.preview_url,/\?v=1$/);
 assert.equal((await search({query:'other',limit:1,cursor:cursors[0]})).status,400);
 assert.equal((await search({query:'annual',cursor:'123'})).status,400);
 assert.equal((await search({query:'annual',project_ids:''})).status,400);
});
test('live API key scopes, generic denial, legacy MCP and full wire budgets',async()=>{
 const key=(await owner.req('POST','/api/api-keys',{label:'search reader',lifetime_days:1,projects:[{project_id:'search-planning',access:'read'},{project_id:'search-notes',access:'read'}]})).body;
 const get=async a=>{const r=await fetch(API+'/v1/search?'+new URLSearchParams(a),{headers:{authorization:'Bearer '+key.secret}});return {status:r.status,body:await r.json()};};
 let r=await get({query:'annual subscriptions',limit:1});assert.equal(r.status,200,JSON.stringify(r.body));assert.ok(r.body.has_more);const cursor=r.body.next_cursor;
 assert.equal((await get({query:'annual',project_ids:'search-private'})).status,404);assert.equal((await get({query:'annual',project_ids:'does-not-exist'})).status,404);
 assert.equal((await owner.req('PUT',`/api/api-keys/${key.id}/scope`,{projects:[{project_id:'search-planning',access:'read'}]})).status,200);
 r=await get({query:'annual subscriptions',limit:1,cursor});assert.equal(r.status,200);assert.ok(r.body.results.every(x=>x.project_id==='search-planning'));
 const g=await grant(owner,'search-notes','lexical reader',false), m=await mcpClient(APP,g.token);
 try {const t=(await m.client.listTools()).tools.find(t=>t.name==='search_artifacts');assert.equal(t.annotations.readOnlyHint,true);const r=await m.call('search_artifacts',{query:'annual subscriptions'});assert.equal(r.isError,false,JSON.stringify(r));assert.ok(r.data.results.every(x=>x.project_id==='search-notes'));assert.deepEqual((await m.call('search_artifacts',{query:'annual',project_ids:[]})).data.results,[]);}finally{await m.close();}
 const res=await fetch(APP+'/mcp',{method:'POST',headers:{authorization:'Bearer '+g.token,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'search_artifacts',arguments:{query:'annual'}}})});assert.ok(Buffer.byteLength(await res.text())<=65536);
});
test('create/save/rename/trash/untrash/restore and bounded idempotent existing-data backfill',async()=>{
 const id=await create('search-notes','Lifecycle token','oldsearchword');
 assert.equal((await search({query:'oldsearchword'})).body.results.length,1);
 let r=await owner.req('PUT',`/api/projects/search-notes/artifacts/${id}`,{expected_revision:1,body:'newsearchword'});assert.equal(r.status,200);
 assert.equal((await search({query:'oldsearchword'})).body.results.length,0);
 let hit=(await search({query:'newsearchword'})).body.results[0];assert.equal(hit.revision,2);assert.equal(hit.sha256,sha256('newsearchword'));
 r=await owner.req('PATCH',`/api/projects/search-notes/artifacts/${id}`,{expected_meta_version:1,title:'renamedsearchword'});assert.equal(r.status,200,JSON.stringify(r.body));
 assert.equal((await search({query:'renamedsearchword'})).body.results.length,1);
 r=await owner.req('PATCH',`/api/projects/search-notes/artifacts/${id}`,{expected_meta_version:2,trashed:true});assert.equal(r.status,200,JSON.stringify(r.body));assert.equal((await search({query:'newsearchword'})).body.results.length,0);
 r=await owner.req('PATCH',`/api/projects/search-notes/artifacts/${id}`,{expected_meta_version:3,trashed:false});assert.equal(r.status,200,JSON.stringify(r.body));
 assert.equal((await search({query:'newsearchword'})).body.results.length,1);
 r=await owner.req('POST',`/api/projects/search-notes/artifacts/${id}/restore`,{from_revision:1,expected_revision:2});assert.equal(r.status,200,JSON.stringify(r.body));
 assert.equal((await search({query:'oldsearchword'})).body.results[0].revision,3);
 await sql('DELETE FROM artifact_search;');assert.equal((await search({query:'oldsearchword'})).status,503);
 for(let pass=0;pass<2;pass++){let after=0;while(true){const x=(await sql(backfillSql(after,2))).at(-1).results[0];if(!x.processed)break;after=x.next_after_rowid;}}
 assert.equal((await search({query:'oldsearchword'})).body.results.length,1);
 const counts=(await sql('SELECT count(*) AS n,count(DISTINCT artifact_id) AS u FROM artifact_search;'))[0].results[0];assert.equal(counts.n,counts.u);
});
test('literal operators, Unicode, punctuation, HTML-like text and invalid inputs',async()=>{
 await create('search-notes','Café 中文','<img src=x onerror=alert(1)> café 中文');
 assert.equal((await search({query:'CAFÉ 中文'})).body.results.length,1);
 assert.equal((await search({query:'"café" AND NOT'})).status,200);
 for(const query of ['', '***','x'.repeat(201)])assert.equal((await search({query})).status,400);
 for(const a of [{query:'annual',limit:51},{query:'annual',kind:'sql'},{query:'annual',updated_after:'yesterday'},{query:'annual',unexpected:'x'}])assert.equal((await search(a)).status,400);
 assert.equal((await search({query:'<img src=x onerror=alert(1)>'})).status,200);
});
test('OAuth searches multiple live projects; publisher tokens never gain general search',async()=>{
 const c=await server.connectMcpAgent({'search-planning':'read','search-notes':'read'});
 assert.ok((await c.list()).find(x=>x.name==='search_artifacts'));
 let r=await c.call('search_artifacts',{query:'annual subscriptions'});assert.equal(r.isError,false,JSON.stringify(r));assert.equal(new Set(r.data.results.map(x=>x.project_id)).size,2);
 r=await c.call('search_artifacts',{query:'annual',project_ids:['search-private']});assert.equal(r.isError,true);assert.equal(r.data.error.status,404);
 const app=await server.registerApp({display_name:'Synthetic search publisher',redirect_uris:['http://localhost:5173/callback'],origins:['http://localhost:5173']});
 const p=await server.connectPublisher(app,{project_id:'search-notes',destination:'root'});
 const res=await fetch(API+'/v1/search?query=annual',{headers:{authorization:'Bearer '+p.access_token}});assert.equal(res.status,401);
 // No body is indexed until it becomes the published head; a stale index's old version is never returned.
 const id=await create('search-notes','Concurrent record','concurrentoldword');
 const [saved,found]=await Promise.all([owner.req('PUT',`/api/projects/search-notes/artifacts/${id}`,{expected_revision:1,body:'concurrentnewword'}),search({query:'concurrentoldword'})]);
 assert.equal(saved.status,200);
 for(const hit of found.body.results){assert.equal(hit.revision,1);assert.equal(hit.sha256,sha256('concurrentoldword'));assert.match(hit.preview_url,/v=1$/);}
 assert.equal((await search({query:'concurrentoldword'})).body.results.length,0);
});
test('browser keyboard search, project filter, safe highlighting, loading/empty/error states and screenshots',async()=>{
 const require=createRequire(import.meta.url),puppeteer=require(process.env.HOME+'/.npm-packages/lib/node_modules/puppeteer');
 const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--no-first-run']});
 const out='tmp/proof-of-work/ranked-search';mkdirSync(out,{recursive:true});
 try{
 const page=await browser.newPage();await page.setViewport({width:1440,height:1000});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.setCookie({name:owner.cookie.split('=')[0],value:owner.cookie.split('=')[1],url:APP,httpOnly:true});
 await page.goto(APP+'/#/');await page.waitForSelector('a[href="#/search"]',{visible:true});await page.screenshot({path:out+'/home.png',fullPage:true});await page.click('a[href="#/search"]');await page.waitForSelector('input[name=query]');
 await page.type('input[name=query]','annual subscriptions');await page.keyboard.press('Enter');await page.waitForSelector('.search-hit');
 await page.screenshot({path:out+'/desktop.png',fullPage:true});
 assert.ok(await page.$('.search-hit mark'));
 await page.select('select[name=project]','search-notes');await page.waitForFunction(()=>document.querySelector('[role=status]')?.textContent==='1 results shown');
 assert.equal(await page.$$eval('.search-hit',xs=>xs.length),1);
 await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
 await page.waitForSelector('input[name=query]');await page.click('input[name=query]',{clickCount:3});await page.type('input[name=query]','annual subscriptions');await page.select('select[name=project]','search-notes');await page.keyboard.press('Enter');
 await page.waitForFunction(()=>document.querySelector('[role=status]')?.textContent==='1 results shown');await page.screenshot({path:out+'/mobile.png',fullPage:true});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.click('input[name=query]',{clickCount:3});await page.type('input[name=query]','img');await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('.search-snippet')?.textContent.includes('<img'));
 assert.equal(await page.$('.search-hit img'),null);
 await page.screenshot({path:out+'/safe-text.png',fullPage:true});
 await page.click('input[name=query]',{clickCount:3});await page.type('input[name=query]','nomatchesword');await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('[role=status]')?.textContent.startsWith('No matches'));
 await page.screenshot({path:out+'/empty.png',fullPage:true});
 await page.setRequestInterception(true);let held;
 page.on('request',req=>{if(req.url().includes('/api/search?'))held=req;else req.continue();});
 await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('[role=status]')?.textContent==='Searching…');
 await page.screenshot({path:out+'/loading.png',fullPage:true});
 await held.respond({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'Synthetic service unavailable'}})});
 await page.waitForFunction(()=>document.querySelector('[role=status]')?.textContent.startsWith("Search couldn't load"));await page.screenshot({path:out+'/error.png',fullPage:true});
 assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
test('reproducible synthetic multi-project performance sample',async()=>{
 const body='Synthetic benchmark text. '.repeat(80)+'benchmarkneedle annual renewals';
 for(let i=0;i<6;i++){
 const p='bench-project-'+i;await owner.req('POST','/api/projects',{id:p,title:p});
 const ownerId=(await owner.req('GET','/api/me')).body.principal.id;
 const q=`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<50) INSERT INTO artifacts(id,project_id,kind,title,head_rev,head_revision_id,created_at,updated_at) SELECT 'bench-${i}-'||x,'${p}','markdown','Benchmark '||x,1,'brevision-${i}-'||x,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z' FROM n; INSERT INTO revisions(id,artifact_id,project_id,rev_no,author_id,body,size,sha256,mime,created_at) SELECT head_revision_id,id,project_id,1,'${ownerId}','${body}',${Buffer.byteLength(body)},'${sha256(body)}','text/markdown',created_at FROM artifacts WHERE project_id='${p}';`;
 await sql(q);
 }
 const start=performance.now(),r=await search({query:'benchmarkneedle',limit:20}),ms=performance.now()-start;
 assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.results.length,20);assert.equal(r.body.has_more,true);
 const metrics={synthetic_projects:6,synthetic_documents:300,body_bytes:Buffer.byteLength(body),query_ms:Math.round(ms*100)/100,response_bytes:Buffer.byteLength(JSON.stringify(r.body)),search_sql_queries:2,query_count_basis:'Unfiltered first-page service path executes a readiness SELECT and a candidate SELECT; authentication and KV are separate.'};
 mkdirSync('tmp/proof-of-work/ranked-search',{recursive:true});writeFileSync('tmp/proof-of-work/ranked-search/benchmark.json',JSON.stringify(metrics,null,2));console.log('SEARCH_BENCHMARK',JSON.stringify(metrics));
});
test('large MCP pages fit the encoded 64 KiB envelope and oversized IDs are refused',async()=>{
 for(let i=0;i<25;i++)await create('search-planning','wirebudget '+('界"\\'.repeat(45))+i,'wirebudget '+('\"\\\n界'.repeat(150)));
 const g=await grant(owner,'search-planning','wire budget reader',false);
 const call=async(args,id)=>fetch(APP+'/mcp',{method:'POST',headers:{authorization:'Bearer '+g.token,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name:'search_artifacts',arguments:args}})});
 const res=await call({query:'wirebudget',limit:50},'x'.repeat(1000)),text=await res.text(),r=JSON.parse(text).result;
 assert.ok(Buffer.byteLength(text)<=65536);assert.equal(r.isError,false);assert.equal(r.structuredContent.has_more,true);assert.ok(r.structuredContent.results.length>0);
 const next=await call({query:'wirebudget',limit:50,cursor:r.structuredContent.next_cursor},1);assert.equal((await next.json()).result.isError,false);
 const bad=await call({query:'wirebudget'},'x'.repeat(1100));assert.equal((await bad.json()).id,null);
});
test('App Connect publication, unpublished heads, binary title-only results and live OAuth revocation',async()=>{
 const app=await server.registerApp({display_name:'Search publication fixture',redirect_uris:['http://localhost:5173/callback'],origins:['http://localhost:5173']});
 const pub=await server.connectPublisher(app,{project_id:'search-notes',destination:'root'});
 const published=await server.pub(pub.access_token,'POST','/publisher/snapshots',{idem:'search-snapshot-fixture',body:{source_revision:1,files:[{name:'search-data.json',kind:'json',role:'authoritative',content:JSON.stringify({note:'publicationneedle'})}]}});
 assert.equal(published.status,201,JSON.stringify(published.json));assert.ok((await search({query:'publicationneedle',kind:'json'})).body.results.length>0);
 const id=await create('search-notes','unpublishedneedle','unpublishedneedle');
 await sql(`UPDATE artifacts SET head_rev=0,head_revision_id=NULL WHERE id='${id}';`);
 assert.equal((await search({query:'unpublishedneedle'})).body.results.length,0);
 // Binary fixture through the actual upload protocol.
 const {makePng}=await import('./make-fixtures.mjs'),png=makePng(8,8);
 const begun=await owner.req('POST','/api/projects/search-notes/uploads',{title:'binaryneedle',mime:'image/png',size:png.length,sha256:sha256(png)});
 assert.equal(begun.status,201,JSON.stringify(begun.body));
 assert.equal((await owner.req('PUT',begun.body.put_url,undefined,{raw:png,headers:{'content-type':'application/octet-stream'}})).status,200);
 assert.equal((await owner.req('POST',`/api/projects/search-notes/uploads/${begun.body.upload_id}/finish`,{})).status,200);
 const binary=(await search({query:'binaryneedle'})).body.results[0];assert.equal(binary.indexed_body,false);assert.equal(binary.matched_field,'title');
 const c=await server.connectMcpAgent({'search-planning':'read','search-notes':'read'},{clientName:'revocable search fixture'});
 const first=await c.call('search_artifacts',{query:'annual subscriptions',limit:1});assert.equal(first.isError,false);assert.ok(first.data.has_more);
 const access=(await owner.req('GET','/api/access')).body.connections.find(x=>x.client_name==='revocable search fixture'||x.label==='revocable search fixture');
 const conn=access?.id??(await sql("SELECT id FROM oauth_connections WHERE client_name='revocable search fixture'"))[0].results[0].id;
 assert.equal((await owner.req('POST',`/api/connections/${conn}/revoke`,{})).status,200);
 const revoked=await c.call('search_artifacts',{query:'annual subscriptions',limit:1,cursor:first.data.next_cursor});assert.equal(revoked.status,401);assert.ok(!JSON.stringify(revoked.data).includes('Annual subscriptions'));
});
test('stale index revisions are excluded until repaired; HTML and CSV remain source text',async()=>{
 const id=await create('search-notes','Freshness check','freshnessneedle');
 await sql(`UPDATE artifact_search SET revision_id='stale_revision' WHERE artifact_id='${id}';`);
 assert.equal((await search({query:'freshnessneedle'})).status,503);
 await sql(`UPDATE artifacts SET title=title WHERE id='${id}';`);
 assert.equal((await search({query:'freshnessneedle'})).body.results.length,1);
 for(const [kind,body] of [['html','<h1>formatneedle</h1>'],['csv','name\nformatneedle\n']]){
 const made=await owner.req('POST','/api/projects/search-notes/artifacts',{kind,title:'Format fixture '+kind,body,content:body});assert.equal(made.status,201,JSON.stringify(made.body));
 const r=await search({query:'formatneedle',kind});assert.equal(r.status,200);assert.equal(r.body.results.length,1);assert.equal(r.body.results[0].kind,kind);assert.match(r.body.results[0].snippet,/formatneedle/);
 }
});
test('rollout hides tools and Home entry and returns 503 until a complete bounded backfill',async()=>{
 const c=await server.connectMcpAgent({'search-notes':'read'});
 const g=await grant(owner,'search-notes','readiness reader',false), m=await mcpClient(APP,g.token);
 const k=(await owner.req('POST','/api/api-keys',{label:'readiness key',lifetime_days:1,projects:[{project_id:'search-notes',access:'read'}]})).body;
 const {createRequire}=await import('node:module'),require=createRequire(import.meta.url),puppeteer=require(process.env.HOME+'/.npm-packages/lib/node_modules/puppeteer');
 const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 try {
  await sql('UPDATE artifact_search_state SET ready=0; DELETE FROM artifact_search WHERE artifact_id IN (SELECT id FROM artifacts ORDER BY rowid DESC LIMIT 2);');
  assert.equal((await owner.req('GET','/api/search/status')).body.ready,false);
  assert.equal((await search({query:'annual'})).status,503);
  assert.ok(!(await c.list()).some(x=>x.name==='search_artifacts'));
  assert.ok(!(await m.client.listTools()).tools.some(x=>x.name==='search_artifacts'));
  assert.equal((await fetch(API+'/v1/search?query=annual',{headers:{authorization:'Bearer '+k.secret}})).status,503);
  const partial=(await sql(backfillSql(0,1))).at(-1).results[0];assert.equal(partial.ready,0);
  // Skipping ahead cannot mark an incomplete index ready, even on a zero-row batch.
  assert.equal((await sql(backfillSql(999999999,1))).at(-1).results[0].ready,0);
  const page=await browser.newPage();await page.setViewport({width:1440,height:1000});
  await page.setCookie({name:owner.cookie.split('=')[0],value:owner.cookie.split('=')[1],url:APP,httpOnly:true});
  await page.goto(APP+'/#/search');await page.waitForFunction(()=>document.body.textContent.includes('Search is being prepared'));
  await page.screenshot({path:'tmp/proof-of-work/ranked-search/initializing.png',fullPage:true});assert.equal(await page.$('input[name=query]'),null);
  await page.goto(APP+'/#/');await page.waitForSelector('a[href="#/search"]');assert.equal(await page.$eval('a[href="#/search"]',e=>e.hidden),true);
  let after=0;while(true){const x=(await sql(backfillSql(after,50))).at(-1).results[0];if(!x.processed)break;after=x.next_after_rowid;}
  assert.equal((await owner.req('GET','/api/search/status')).body.ready,true);
  assert.ok((await c.list()).some(x=>x.name==='search_artifacts'));
  assert.ok((await m.client.listTools()).tools.some(x=>x.name==='search_artifacts'));
  assert.equal((await search({query:'annual'})).status,200);
  await page.reload();await page.waitForSelector('a[href="#/search"]',{visible:true});
 } finally {await browser.close();await m.close();}
});
test('stable search keys survive artifacts rowid reassignment and later updates',async()=>{
 const id=await create('search-notes','stablekeyneedle','stablekeyneedle');
 await sql(`UPDATE artifacts SET rowid=rowid+1000000 WHERE id='${id}';`);
 assert.equal((await search({query:'stablekeyneedle'})).body.results[0].artifact_id,id);
 assert.equal((await owner.req('PUT',`/api/projects/search-notes/artifacts/${id}`,{expected_revision:1,body:'stablekeysecondneedle'})).status,200);
 assert.equal((await search({query:'stablekeysecondneedle'})).body.results[0].revision,2);
});
