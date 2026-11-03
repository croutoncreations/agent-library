import {execFileSync} from 'node:child_process';
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {startServer,setupProject,grant,agentHttp,sha256,LOCAL_CONFIG} from './helpers.mjs';
import {createRequire} from 'node:module';
import {existsSync,mkdirSync} from 'node:fs';
import {SERVER_PORTS} from './ports.mjs';
import {driveFixture} from './fixtures/drive-harness.mjs';
const P='drive-fixtures';let s,h,g,fx;
const DOC='application/vnd.google-apps.document',SHEET='application/vnd.google-apps.spreadsheet',SLIDE='application/vnd.google-apps.presentation';
const X='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',T='application/vnd.openxmlformats-officedocument.presentationml.presentation';
const office=Buffer.from('PK\x03\x04synthetic immutable Office bytes');
let serial=0;const key=()=>`drive-test-key-${++serial}`;
const headers={'x-google-access-token':'synthetic-drive-a'};
async function req(method,path,b,opts={}){if(method==='DELETE')opts={...opts,headers:{...headers,...opts.headers,'idempotency-key':key()}};return h.req(method,`/api/projects/${P}/drive-import`+path,b,{headers,...opts});}
async function ok(method,path,b,opts){const r=await req(method,path,b,opts);assert.ok(r.status<300,JSON.stringify(r));return r.body;}
async function session(){return (await ok('POST','/sessions',{})).session_id;}
async function create(ids){return (await ok('POST','/jobs',{session_id:await session(),file_ids:ids})).job_id;}
async function read(id){let r=await ok('GET','/jobs/'+id),c=r.next_cursor;while(c){const p=await ok('GET','/jobs/'+id+'?cursor='+c);r.items.push(...p.items);c=p.next_cursor;}return r;}
async function step(id){return ok('POST','/jobs/'+id+'/process',{});}
async function inspect(id){for(let n=0;n<30;n++){const r=await read(id);if(!r.items.some(t=>['selected','inspecting'].includes(t.state)))return r;await step(id);}throw Error('did not finish');}
async function confirm(id){const r=await read(id);return ok('POST','/jobs/'+id+'/confirm',{manifest_version:r.manifest_version});}
async function publish(id){await confirm(id);for(let n=0;n<30;n++){const r=await read(id);if(r.state!=='confirmed'||!r.items.some(t=>['ready','publishing'].includes(t.state)))return r;await step(id);}throw Error('did not publish');}
before(async()=>{
 fx=await driveFixture();
 fx.files.set('doc',{name:'Research',mimeType:DOC,native:true,version:'1',bytes:Buffer.from('# Synthetic notes\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n![image](https://example.invalid/image.png)\n\nFootnote[^1].\n\n[^1]: Text\n\n[link](https://drive.google.com/file/d/linked/view)\n')});
 fx.files.set('pdf',{name:'Sample.pdf',mimeType:'application/pdf',bytes:Buffer.from('%PDF-1.4\nSynthetic PDF fixture\n%%EOF')});
 fx.files.set('sheet',{name:'Workbook',mimeType:SHEET,native:true,bytes:office});
 fx.files.set('slides',{name:'Deck',mimeType:SLIDE,native:true,bytes:office});
 fx.files.set('xlsx',{name:'Original.xlsx',mimeType:X,bytes:office});
 fx.files.set('pptx',{name:'Original.pptx',mimeType:T,bytes:office});
 s=await startServer('drive-import',SERVER_PORTS['drive-import'],{vars:{GOOGLE_DRIVE_TEST_ORIGIN:fx.origin,GOOGLE_DRIVE_CLIENT_ID:'synthetic.apps.googleusercontent.com',GOOGLE_PICKER_APP_ID:'123456',GOOGLE_PICKER_API_KEY:'synthetic-public-api-key',RATE_READS_PER_MIN:'100000',RATE_WRITES_PER_MIN:'100000'}});
 h=await s.login();await setupProject(h,P);g=await grant(h,P,'Synthetic drive reader');
});
after(async()=>{await s?.stop();await fx?.stop();});
test('owner-only + CSRF; config and missing credentials; agent cannot operate import',async()=>{
 const a=agentHttp(s.base,g.token);
 assert.equal((await a('GET',`/api/projects/${P}/drive-import`)).status,403);
 assert.equal((await h.req('POST',`/api/projects/${P}/drive-import/sessions`,{}, {headers,noCsrf:true})).status,403);
 assert.equal((await h.req('POST',`/api/projects/${P}/drive-import/sessions`,{})).status,401);
 assert.equal((await ok('GET','')).configured,true);
 assert.equal((await req('POST','/jobs',{session_id:await session(),file_ids:['https://evil.invalid']})).status,400);
});
test('real Worker: Doc/PDF/Sheet/Slides + original Office bytes, immutable baselines and authenticated downloads',async()=>{
 const id=await create(['doc','pdf','sheet','slides','xlsx','pptx']);let r=await inspect(id);assert.ok(r.items.every(t=>t.state==='ready'),JSON.stringify(r));
 assert.equal((await h.req('GET',`/api/projects/${P}/artifacts`)).body.artifacts.length,0,'staging is private');
 r=await publish(id);assert.ok(r.items.every(t=>t.state==='imported'),JSON.stringify(r));
 for(const t of r.items){
  const d=await h.req('GET',`/api/projects/${P}/artifacts/${t.artifact_id}`);assert.equal(d.status,200);
  assert.equal(d.body.source.imported_sha256,t.sha256);assert.equal(d.body.source.sync_enabled,false);
  if(t.source_id==='doc')assert.equal(d.body.body,fx.files.get('doc').bytes.toString());
  else {const download=await agentHttp(s.base,g.token)('GET',d.body.content_url,undefined,{binary:true});assert.equal(download.status,200);assert.equal(sha256(download.body),t.sha256);assert.equal(download.headers.get('content-disposition'),'attachment; filename=\"'+t.title+'\"');}
 }
 assert.ok(fx.calls.every(c=>c.method==='GET'),'no Google writes');
 assert.ok(fx.calls.some(c=>c.path.includes('mimeType=text%2Fmarkdown')));
 assert.ok(fx.calls.some(c=>c.path.includes('mimeType='+encodeURIComponent(X))));
 assert.ok(fx.calls.some(c=>c.path.includes('mimeType='+encodeURIComponent(T))));
});
test('duplicate primary, stale manifest, explicit another copy and idempotency input conflicts',async()=>{
 const existing=(await h.req('GET',`/api/projects/${P}/artifacts`)).body.artifacts.find(a=>a.title==='Research.md');
 assert.equal((await h.req('PUT',`/api/projects/${P}/artifacts/${existing.id}`,{expected_revision:1,body:'Local owner edit'})).status,200);
 const id=await create(['doc']);let r=await inspect(id);assert.equal(r.items[0].error_code,'already_imported');
 assert.equal((await h.req('GET',`/api/projects/${P}/artifacts/${existing.id}`)).body.body,'Local owner edit');
 const old=r.manifest_version;
 await ok('POST','/jobs/'+id+'/edit',{manifest_version:old,item_id:r.items[0].id,another_copy:true});
 assert.equal((await req('POST','/jobs/'+id+'/confirm',{manifest_version:old})).status,409);
 r=await inspect(id);assert.equal(r.items[0].state,'ready');r=await publish(id);assert.equal(r.items[0].state,'imported');
 const k=key();await ok('POST','/jobs/'+id+'/confirm',{manifest_version:r.manifest_version},{idem:k});
 assert.equal((await req('POST','/jobs/'+id+'/confirm',{manifest_version:r.manifest_version+1},{idem:k})).body.error.code,'idempotency_key_reused');
});
test('unsupported/denied/invalid UTF8/truncated/oversize/source change are per-file outcomes',async()=>{
 const variants={badpdf:{mimeType:'application/pdf'},folder:{mimeType:'application/vnd.google-apps.folder'},shortcut:{mimeType:'application/vnd.google-apps.shortcut'},denied:{mimeType:DOC,canDownload:false},invalid:{mimeType:'text/markdown',bytes:Buffer.from([255,254])},truncated:{mimeType:'text/markdown',declaredSize:100},large:{mimeType:'text/markdown',bytes:Buffer.alloc(1048577,65)},changing:{mimeType:DOC,native:true,changeDuringRead:true,version:'1'}};
 for(const [id,v]of Object.entries(variants))fx.files.set(id,{name:id,bytes:Buffer.from('synthetic'),...v});
 const id=await create(Object.keys(variants));const r=await inspect(id);
 const codes=Object.fromEntries(r.items.map(t=>[t.source_id,t.error_code]));
 assert.deepEqual(codes,{badpdf:'signature_mismatch',folder:'unsupported_type',shortcut:'unsupported_type',denied:'source_access',invalid:'invalid_utf8',truncated:'integrity_mismatch',large:'too_large',changing:'source_changed'});
});
test('source changed after review invalidates confirmation; retry safely re-inspects; wrong account resume refused',async()=>{
 fx.files.set('change',{name:'Change',mimeType:DOC,native:true,version:'1',bytes:Buffer.from('before')});
 const id=await create(['change']);await inspect(id);fx.files.get('change').version='2';fx.files.get('change').bytes=Buffer.from('after');
 let r=await publish(id);assert.equal(r.state,'review');assert.equal(r.items[0].error_code,'source_changed');
 await ok('POST','/jobs/'+id+'/retry',{});await inspect(id);r=await publish(id);assert.equal(r.items[0].state,'imported');
 const other=await req('POST','/sessions',{}, {headers:{'x-google-access-token':'synthetic-drive-b'}});
 const wrong=await req('POST','/jobs/'+id+'/resume',{session_id:other.body.session_id},{headers:{'x-google-access-token':'synthetic-drive-b'}});
 assert.equal(wrong.body.error.code,'wrong_account');
});
test('cancel preserves completed artifacts; resumed job survives browser/server interruption; concurrent jobs publish one primary',async()=>{
 fx.files.set('parallel',{name:'Same name',mimeType:DOC,native:true,bytes:Buffer.from('Parallel')});
 const a=await create(['parallel']),b=await create(['parallel']);await inspect(a);await inspect(b);await confirm(a);await confirm(b);
 await Promise.all([step(a),step(b)]);let aa=await read(a),bb=await read(b);
 assert.equal([aa,bb].filter(r=>r.items[0].state==='imported').length,1);
 await step(aa.items[0].state==='imported'?b:a);aa=await read(a);bb=await read(b);assert.equal([aa,bb].filter(r=>r.items[0].state==='skipped').length,1);
 await ok('POST','/jobs/'+a+'/cancel',{});const copy=aa.items[0].artifact_id;assert.equal((await h.req('GET',`/api/projects/${P}/artifacts/${copy}`)).status,200);
 fx.files.set('restart',{name:'Restart',mimeType:DOC,native:true,bytes:Buffer.from('Restart')});const id=await create(['restart']);await inspect(id);await s.stop();s=await startServer('drive-import',SERVER_PORTS['drive-import'],{fresh:false,vars:{GOOGLE_DRIVE_TEST_ORIGIN:fx.origin,RATE_READS_PER_MIN:'100000',RATE_WRITES_PER_MIN:'100000'}});h=await s.login();const ss=await session();await ok('POST','/jobs/'+id+'/resume',{session_id:ss});const result=await publish(id);assert.equal(result.items[0].state,'imported');
});
test('publication failure rolls back text/binary mapping and revision together; terminal uploads retry safely',async()=>{
 const sql=q=>execFileSync('wrangler',['d1','execute','DB','--config',LOCAL_CONFIG,'--local','--persist-to',s.dir,'--command',q],{stdio:'pipe'});
 fx.files.set('failure-text',{name:'Atomic text',mimeType:DOC,native:true,bytes:Buffer.from('Atomic text')});
 fx.files.set('failure-bin',{name:'Atomic.xlsx',mimeType:X,bytes:office});
 const id=await create(['failure-text','failure-bin']);await inspect(id);
 sql("CREATE TRIGGER synthetic_mapping_failure BEFORE INSERT ON artifact_sources WHEN NEW.source_id IN ('failure-text','failure-bin') BEGIN SELECT RAISE(ABORT,'synthetic_mapping_failure'); END;");
 try{const r=await publish(id);assert.ok(r.items.every(t=>t.state==='failed'),JSON.stringify(r));const files=await h.req('GET',`/api/projects/${P}/artifacts`);assert.ok(!files.body.artifacts.some(a=>a.title==='Atomic text'||a.title==='Atomic.xlsx'),'no visible partial publication');}
 finally{sql('DROP TRIGGER synthetic_mapping_failure;');}
 await ok('POST','/jobs/'+id+'/retry',{});await inspect(id);const r=await publish(id);assert.ok(r.items.every(t=>t.state==='imported'),JSON.stringify(r));
});
test('revocation denies the next provenance and range download; disconnected authorization preserves job/copies',async()=>{
 const id=await create(['pdf']);const r=await inspect(id),t=r.items[0];assert.equal(t.error_code,'already_imported');
 const gg=await grant(h,P,'Range revocation fixture'),a=agentHttp(s.base,gg.token);
 const path=`/api/projects/${P}/artifacts/${t.artifact_id}`;
 assert.equal((await a('GET',path)).status,200);
 await h.req('PATCH',`/api/projects/${P}/grants/${gg.grant_id}`,{revoke:true});
 assert.ok([401,403].includes((await a('GET',path)).status));
 assert.ok([401,403].includes((await a('GET',path+'/content',undefined,{headers:{range:'bytes=0-3'}})).status));
 const ss=await session();await ok('DELETE','/sessions/'+ss);
 assert.equal((await req('POST','/jobs/'+id+'/resume',{session_id:ss})).body.error.code,'needs_reauthorization');
 assert.equal((await h.req('GET',path)).status,200);
});
test('parallel edit/confirm cannot publish a changed, unreviewed manifest',async()=>{
 fx.files.set('review-race',{name:'Review race',mimeType:DOC,native:true,bytes:Buffer.from('Review race')});
 const id=await create(['review-race']);const r=await inspect(id),version=r.manifest_version;
 const results=await Promise.all([req('POST','/jobs/'+id+'/confirm',{manifest_version:version}),req('POST','/jobs/'+id+'/edit',{manifest_version:version,item_id:r.items[0].id,remove:true})]);
 assert.equal(results.filter(x=>x.status===200).length,1,JSON.stringify(results));
 const state=await read(id);if(state.state==='confirmed')assert.equal(state.items[0].state,'ready');else{assert.equal(state.items[0].state,'cancelled');assert.equal((await req('POST','/jobs/'+id+'/confirm',{manifest_version:version})).status,409);}
});
test('private measured import bytes respect the project budget before publication',async()=>{
 const q=await startServer('drive-quota',SERVER_PORTS['drive-quota'],{vars:{GOOGLE_DRIVE_TEST_ORIGIN:fx.origin,PROJECT_BINARY_BYTES:'32'}});
 try{
 const hh=await q.login();await setupProject(hh,'quota-drive');const base='/api/projects/quota-drive/drive-import';
 const ss=await hh.req('POST',base+'/sessions',{}, {headers});assert.equal(ss.status,200);
 const j=await hh.req('POST',base+'/jobs',{session_id:ss.body.session_id,file_ids:['xlsx']},{headers});assert.equal(j.status,200);
 await hh.req('POST',base+'/jobs/'+j.body.job_id+'/process',{}, {headers});
 const r=await hh.req('GET',base+'/jobs/'+j.body.job_id);assert.equal(r.body.items[0].error_code,'quota_exceeded');
 assert.equal((await hh.req('GET','/api/projects/quota-drive/artifacts')).body.artifacts.length,0);
 }finally{await q.stop();}
});
test('cancel during an active source read fences publication and cleans staging',async()=>{
 fx.files.set('cancel-race',{name:'Cancel race',mimeType:DOC,native:true,bytes:Buffer.from('Do not publish')});
 const id=await create(['cancel-race']);await inspect(id);await confirm(id);
 let release,entered;const gate=new Promise(r=>release=r),reading=new Promise(r=>entered=r);
 Object.assign(fx.files.get('cancel-race'),{metadataGate:gate,onMetadata:entered});
 const publishing=req('POST','/jobs/'+id+'/process',{});
 try {await Promise.race([reading,new Promise((_,reject)=>setTimeout(()=>reject(Error('Read did not start')),5000))]);await ok('POST','/jobs/'+id+'/cancel',{});}
 finally {release();}
 assert.equal((await publishing).status,200);const r=await read(id);assert.equal(r.state,'cancelled');assert.equal(r.items[0].state,'cancelled');
 const files=await h.req('GET',`/api/projects/${P}/artifacts`);assert.ok(!files.body.artifacts.some(a=>a.title==='Cancel race.md'));
});
test('agents see source provenance without the owner Google identity',async()=>{
 const id=await create(['pdf']);const t=(await inspect(id)).items[0];assert.equal(t.error_code,'already_imported');
 const owner=(await h.req('GET',`/api/projects/${P}/artifacts/${t.artifact_id}`)).body.source;
 const agent=(await agentHttp(s.base,g.token)('GET',`/api/projects/${P}/artifacts/${t.artifact_id}`)).body.source;
 assert.equal(owner.account_id,'account-a');assert.ok(owner.import_owner);
 for(const k of ['account_id','account_label','import_owner','job_id','item_id'])assert.equal(agent[k],undefined,k);
 assert.equal(agent.source_id,'pdf');assert.equal(agent.imported_sha256,owner.imported_sha256);
 assert.ok(!JSON.stringify(owner).includes('a@example.test'),'Google email never stored in provenance');
});
test('source change with an unfinished import upload: retry retires it and re-reads the source',async()=>{
 const sql=q=>execFileSync('wrangler',['d1','execute','DB','--config',LOCAL_CONFIG,'--local','--persist-to',s.dir,'--command',q],{stdio:'pipe'});
 fx.files.set('stale-upload',{name:'Stale.xlsx',mimeType:X,version:'1',bytes:office});
 const id=await create(['stale-upload']);let r=await inspect(id);const item=r.items[0];assert.equal(item.state,'ready');
 // Simulate an interrupted publication: the upload was reserved but never received its bytes.
 const begun=await h.req('POST',`/api/projects/${P}/uploads`,{title:'Stale.xlsx',mime:'application/octet-stream',size:office.length,sha256:sha256(office)});assert.equal(begun.status,201,JSON.stringify(begun.body));
 sql(`UPDATE drive_import_items SET upload_id='${begun.body.upload_id}' WHERE id='${item.id}'`);
 await confirm(id);
 const changed=Buffer.from('PK\x03\x04synthetic changed Office bytes');Object.assign(fx.files.get('stale-upload'),{version:'2',bytes:changed});
 await step(id);r=await read(id);assert.equal(r.state,'review');assert.equal(r.items[0].error_code,'source_changed');
 await ok('POST','/jobs/'+id+'/retry',{});r=await inspect(id);
 assert.equal(r.items[0].state,'ready',JSON.stringify(r.items[0]));assert.equal(r.items[0].sha256,sha256(changed),'re-read the changed source');
 r=await publish(id);assert.equal(r.items[0].state,'imported',JSON.stringify(r.items[0]));
 const dl=await agentHttp(s.base,g.token)('GET',`/api/projects/${P}/artifacts/${r.items[0].artifact_id}/content`,undefined,{binary:true});assert.equal(sha256(dl.body),sha256(changed));
});
test('artifact limit: imports return quota_exceeded; ordinary binary uploads are not newly capped',async()=>{
 const q=await startServer('drive-quota',SERVER_PORTS['drive-quota'],{vars:{GOOGLE_DRIVE_TEST_ORIGIN:fx.origin,GOOGLE_DRIVE_CLIENT_ID:'synthetic.apps.googleusercontent.com',GOOGLE_PICKER_APP_ID:'123456',GOOGLE_PICKER_API_KEY:'synthetic-public-api-key',RATE_READS_PER_MIN:'100000',RATE_WRITES_PER_MIN:'100000'}});
 try{
  const hh=await q.login(),PP='limit-drive',base=`/api/projects/${PP}/drive-import`;await setupProject(hh,PP);
  const ss=(await hh.req('POST',base+'/sessions',{}, {headers})).body.session_id;
  const j=(await hh.req('POST',base+'/jobs',{session_id:ss,file_ids:['xlsx']},{headers})).body.job_id;
  for(let n=0;n<5;n++)await hh.req('POST',base+'/jobs/'+j+'/process',{}, {headers});
  let st=(await hh.req('GET',base+'/jobs/'+j)).body;assert.equal(st.items[0].state,'ready',JSON.stringify(st));
  await hh.req('POST',base+'/jobs/'+j+'/confirm',{manifest_version:st.manifest_version});
  // Fill the project to its 100-artifact limit after review, so publication itself hits the cap.
  const qsql=x=>execFileSync('wrangler',['d1','execute','DB','--config',LOCAL_CONFIG,'--local','--persist-to',q.dir,'--command',x],{stdio:'pipe'});
  qsql(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<100) INSERT INTO artifacts (id,project_id,kind,title,folder,head_rev,created_at,updated_at) SELECT 'art_fill'||i,'${PP}','markdown','Fill '||i,'',1,'2026-01-01','2026-01-01' FROM n`);
  await hh.req('POST',base+'/jobs/'+j+'/process',{}, {headers});
  st=(await hh.req('GET',base+'/jobs/'+j)).body;assert.equal(st.items[0].state,'failed');assert.equal(st.items[0].error_code,'quota_exceeded',JSON.stringify(st.items[0]));
  const up=await hh.req('POST',`/api/projects/${PP}/uploads`,{title:'Ordinary.pdf',mime:'application/pdf',size:4,sha256:sha256(Buffer.from('%PDF'))});
  assert.equal(up.status,201,'ordinary uploads keep their existing behavior: '+JSON.stringify(up.body));
 }finally{await q.stop();}
});
test('Chrome owner flow: synthetic Google Picker → manifest → imports; keyboard, mobile and offline states',async t=>{
 const chrome=process.env.CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
 const pp=process.env.HOME+'/.npm-packages/lib/node_modules/puppeteer';
 if(!existsSync(chrome)||!existsSync(pp)){t.skip('Chrome/Puppeteer unavailable');return;}
 // Reconfigure the local harness after the durability restart; no live Google access.
 await s.stop();s=await startServer('drive-import',SERVER_PORTS['drive-import'],{fresh:false,vars:{GOOGLE_DRIVE_TEST_ORIGIN:fx.origin,GOOGLE_DRIVE_CLIENT_ID:'synthetic.apps.googleusercontent.com',GOOGLE_PICKER_APP_ID:'123456',GOOGLE_PICKER_API_KEY:'synthetic-public-api-key',RATE_READS_PER_MIN:'100000',RATE_WRITES_PER_MIN:'100000'}});h=await s.login();
 await setupProject(h,'browser-drive','Browser import fixtures');
 const puppeteer=createRequire(import.meta.url)(pp), browser=await puppeteer.launch({executablePath:chrome,headless:true});
 mkdirSync('tmp/test-evidence/drive-import',{recursive:true});
 try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.setRequestInterception(true);
 page.on('request',r=>{
 if(r.url()==='https://accounts.google.com/gsi/client')return r.respond({contentType:'application/javascript',body:`window.google={accounts:{oauth2:{initTokenClient:function(c){return{requestAccessToken:function(){c.callback({access_token:'synthetic-drive-a'});}};}}}};`});
 if(r.url()==='https://apis.google.com/js/api.js')return r.respond({contentType:'application/javascript',body:`window.gapi={load:function(n,c){google.picker={Action:{PICKED:'picked',CANCEL:'cancel'},Feature:{MULTISELECT_ENABLED:1},DocsView:function(){this.setIncludeFolders=function(){return this;}},PickerBuilder:function(){var cb;['addView','enableFeature','setMaxItems','setOAuthToken','setDeveloperKey','setAppId','setOrigin'].forEach(k=>this[k]=function(){return this;});this.setCallback=function(c){cb=c;return this;};this.build=function(){return{setVisible:function(){cb({action:'picked',docs:['doc','pdf','sheet','slides'].map(id=>({id:id}))});}};};}};c.callback();}};`});
 r.continue();});
 await page.setViewport({width:1280,height:1000});
 const cookieParts=h.cookie.split(';')[0].split('=');await page.setCookie({name:cookieParts[0],value:cookieParts.slice(1).join('='),url:s.base});
 await page.goto(s.base+'/#/p/browser-drive');
 const click=async text=>{try { await page.waitForFunction(t=>Array.from(document.querySelectorAll('button')).some(b=>b.textContent===t),{},text); } catch(e) {throw Error('Missing '+text+'; page: '+(await page.evaluate(()=>document.body.innerText)).slice(0,2500)+'; errors: '+errors.join(';'));}await page.evaluate(t=>Array.from(document.querySelectorAll('button')).find(b=>b.textContent===t).click(),text);};
 await click('Import → Google Drive');await click('Select files with Google Picker');
 await page.waitForFunction(()=>document.querySelectorAll('.drive-import article').length===4&&Array.from(document.querySelectorAll('.drive-import article')).every(x=>x.textContent.includes('ready')));
 await page.screenshot({path:'tmp/test-evidence/drive-import/manifest-desktop.png',fullPage:true});
 await page.setViewport({width:390,height:844});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no mobile horizontal overflow');
 await page.screenshot({path:'tmp/test-evidence/drive-import/manifest-mobile.png',fullPage:true});
 await page.keyboard.press('Tab');assert.ok(await page.evaluate(()=>document.activeElement!==document.body));
 await click('Confirm import');await page.waitForFunction(()=>Array.from(document.querySelectorAll('.drive-import article')).every(x=>x.textContent.includes('imported')));
 await page.screenshot({path:'tmp/test-evidence/drive-import/results-mobile.png',fullPage:true});
 const workbookUrl=await page.$$eval('.drive-import article',cards=>Array.from(cards).find(c=>c.querySelector('strong').textContent==='Workbook.xlsx').querySelector('a[href*=\"/p/browser-drive/a/\"]').href);
 await page.setOfflineMode(true);await click('Retry failed files');await page.waitForFunction(()=>document.querySelector('.drive-import [role=status]').textContent.includes('Offline'));await page.screenshot({path:'tmp/test-evidence/drive-import/offline-mobile.png',fullPage:true});await page.setOfflineMode(false);
 await page.goto(workbookUrl);await page.waitForSelector('.media a[download]');
 assert.equal(await page.$$eval('.editor,.ed-host',els=>els.length),0,'Office file has no content editor');
 assert.ok(await page.evaluate(()=>Array.from(document.querySelectorAll('a')).some(a=>a.textContent==='Open source in Google Drive'&&a.getBoundingClientRect().height>0)));
 await page.screenshot({path:'tmp/test-evidence/drive-import/office-card-mobile.png',fullPage:true});
 assert.deepEqual(errors,[]);
 const rows=await h.req('GET','/api/projects/browser-drive/artifacts');assert.equal(rows.body.artifacts.length,4);
 }finally{await browser.close();}
});
test('CSP: strict everywhere except the owner UI document, and only when Drive import is configured',async()=>{
 const csp=async(base,path)=>(await fetch(base+path)).headers.get('content-security-policy');
 // Dedicated servers, so the result never depends on another test's restart.
 let q=await startServer('drive-quota',SERVER_PORTS['drive-quota'],{vars:{GOOGLE_DRIVE_CLIENT_ID:'synthetic.apps.googleusercontent.com',GOOGLE_PICKER_APP_ID:'123456',GOOGLE_PICKER_API_KEY:'synthetic-public-api-key'}});
 try{
  const doc=await csp(q.base,'/'),api=await csp(q.base,'/api/projects/any/artifacts'),js=await csp(q.base,'/app.js');
  assert.match(doc,/script-src 'self' https:\/\/accounts\.google\.com\/gsi\/client https:\/\/apis\.google\.com\/js\/api\.js /);
  assert.match(doc,/frame-src 'self' https:\/\/accounts\.google\.com\/gsi\/ https:\/\/docs\.google\.com/);
  assert.ok(!/gstatic|googleapis\.com[;\s]|apis\.google\.com[;\s]/.test(doc),'no broad Google hosts: '+doc);
  for(const strict of [api,js]){assert.match(strict,/script-src 'self';/);assert.ok(!strict.includes('google'),strict);}
 }finally{await q.stop();}
 q=await startServer('drive-quota',SERVER_PORTS['drive-quota']);
 try{const off=await csp(q.base,'/');assert.match(off,/script-src 'self';/);assert.ok(!off.includes('google'),'unconfigured installation keeps the strict policy');}
 finally{await q.stop();}
});
test('browser: an expired Google authorization keeps the library session',async t=>{
 const chrome=process.env.CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
 const pp=process.env.HOME+'/.npm-packages/lib/node_modules/puppeteer';
 if(!existsSync(chrome)||!existsSync(pp)){t.skip('Chrome/Puppeteer unavailable');return;}
 // Configure Google import on the shared server here, rather than relying on an earlier test's restart.
 await s.stop();s=await startServer('drive-import',SERVER_PORTS['drive-import'],{fresh:false,vars:{GOOGLE_DRIVE_TEST_ORIGIN:fx.origin,GOOGLE_DRIVE_CLIENT_ID:'synthetic.apps.googleusercontent.com',GOOGLE_PICKER_APP_ID:'123456',GOOGLE_PICKER_API_KEY:'synthetic-public-api-key',RATE_READS_PER_MIN:'100000',RATE_WRITES_PER_MIN:'100000'}});h=await s.login();
 fx.files.set('reauth',{name:'Reauth',mimeType:DOC,native:true,bytes:Buffer.from('Reauth')});
 await setupProject(h,'reauth-drive','Reauthorization fixtures');
 const puppeteer=createRequire(import.meta.url)(pp),browser=await puppeteer.launch({executablePath:chrome,headless:true});
 try{
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.setRequestInterception(true);
  page.on('request',r=>{
   // Google accepts the token for session/job creation, then revokes it: processing gets needs_reauthorization.
   if(r.url()==='https://accounts.google.com/gsi/client')return r.respond({contentType:'application/javascript',body:`window.google={accounts:{oauth2:{initTokenClient:function(c){return{requestAccessToken:function(){c.callback({access_token:'synthetic-drive-a'});}};}}}};`});
   if(r.url()==='https://apis.google.com/js/api.js')return r.respond({contentType:'application/javascript',body:`window.gapi={load:function(n,c){google.picker={Action:{PICKED:'picked',CANCEL:'cancel'},Feature:{MULTISELECT_ENABLED:1},DocsView:function(){this.setIncludeFolders=function(){return this;}},PickerBuilder:function(){var cb,self=this;['addView','enableFeature','setMaxItems','setOAuthToken','setDeveloperKey','setAppId','setOrigin'].forEach(function(m){self[m]=function(){return self;};});this.setCallback=function(f){cb=f;return self;};this.build=function(){return{setVisible:function(){cb({action:'picked',docs:[{id:'reauth'}]});}};};}};c.callback();}};`});
   if(/\/drive-import\/jobs\/[^/]+\/process$/.test(r.url())&&r.method()==='POST')return r.continue({headers:{...r.headers(),'x-google-access-token':'synthetic-drive-revoked'}});
   r.continue();
  });
  const cookieParts=h.cookie.split(';')[0].split('=');await page.setCookie({name:cookieParts[0],value:cookieParts.slice(1).join('='),url:s.base});
  await page.goto(s.base+'/#/p/reauth-drive');
  const click=async text=>{await page.waitForFunction(t=>Array.from(document.querySelectorAll('button')).some(b=>b.textContent===t),{},text);await page.evaluate(t=>Array.from(document.querySelectorAll('button')).find(b=>b.textContent===t).click(),text);};
  await click('Import → Google Drive');await click('Select files with Google Picker');
  await page.waitForFunction(()=>(document.querySelector('.drive-import [role=status]')?.textContent||'').includes('Google authorization expired'));
  assert.ok(await page.evaluate(()=>!!document.querySelector('.drive-import')&&!document.querySelector('input[type=password]')),'still signed in to the library');
  assert.equal((await h.req('GET','/api/me')).status,200,'library session still valid server-side');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
test('backup/restore provenance detached and no sessions or Google tokens; downloads persist',async()=>{
 const bk=await h.req('GET',`/api/projects/${P}/backup`);assert.equal(bk.status,200);assert.ok(bk.body.sources.length);
 assert.ok(!JSON.stringify(bk.body).includes('synthetic-drive-a'));
 const t=await startServer('drive-restore',SERVER_PORTS['drive-restore']);try{
  const hh=await t.login();
  const bad=structuredClone(bk.body),provenance=JSON.parse(bad.sources[0].provenance);provenance.baseline_sha256='0'.repeat(64);bad.sources[0].provenance=JSON.stringify(provenance);assert.equal((await hh.req('POST','/api/restore',bad)).status,400);
  const r=await hh.req('POST','/api/restore',bk.body);assert.equal(r.status,201,JSON.stringify(r.body));
  const row=bk.body.sources[0];const d=await hh.req('GET',`/api/projects/${P}/artifacts/${row.artifact_id}`);assert.equal(d.body.source.restored,true);assert.equal(d.body.source.sync_enabled,false);
 }finally{await t.stop();}
});
