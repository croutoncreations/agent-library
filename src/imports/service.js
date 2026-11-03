// Client-driven, one item per request. Jobs survive browser closure; tokens never enter storage.
function gdFence(ctx) {
  const d=ctx.driveImport;
  return d ? {sql:"EXISTS (SELECT 1 FROM drive_import_jobs WHERE id=? AND state='confirmed' AND lease=? AND lease_until>?)",params:[d.job.id,d.lease,nowMs()]} : {sql:'1',params:[]};
}
function gdPublication(ctx, aid, rid) {
  const d=ctx.driveImport;if(!d)return [];
  const {job:j,item:t}=d, m=JSON.parse(t.metadata), gate='EXISTS (SELECT 1 FROM revisions WHERE id=?)';
  const provenance={provider:'google-drive',account_id:j.account_id,source_id:t.source_id,source_title:m.name,source_mime:m.mimeType,source_url:m.url,drive_id:m.driveId,source_version:m.version,source_modified_time:m.modifiedTime,export_mime:m.exportMime??m.mimeType,conversion_profile:m.exportMime?'google-native-export/1':'drive-original-bytes/1',imported_sha256:t.sha256,baseline_revision:1,baseline_sha256:t.sha256,baseline_title:t.title,baseline_meta_version:1,import_owner:j.owner_id,imported_at:nowIso(),job_id:j.id,item_id:t.id,role:'primary',state:'detached',sync_enabled:false};
  return [ctx.env.DB.prepare(`INSERT INTO artifact_sources(id,project_id,artifact_id,account_id,source_id,is_primary,provenance) SELECT ?,?,?,?,?,?,? WHERE ${gate}`).bind(randomId('src'),j.project_id,aid,j.account_id,t.source_id,t.another_copy?0:1,JSON.stringify(provenance),rid),
    ctx.env.DB.prepare(`UPDATE drive_import_items SET state='imported',artifact_id=?,error_code=NULL,error_message=NULL WHERE id=? AND ${gate}`).bind(aid,t.id,rid),
    ctx.env.DB.prepare(`UPDATE artifacts SET folder_id=? WHERE id=? AND ${gate}`).bind(j.folder_id,aid,rid)];
}
// Agents, OAuth apps and API keys see where a copy came from, not who imported it or from which account.
const GD_OWNER_ONLY=['account_id','account_label','import_owner','job_id','item_id'];
async function gdProvenance(ctx,pid,aid) {
  await authorizeProject(ctx,pid,false);await loadArtifact(ctx,pid,aid);
  const r=await ctx.env.DB.prepare('SELECT provenance FROM artifact_sources WHERE project_id=? AND artifact_id=? LIMIT 1').bind(pid,aid).first('provenance');
  if(!r)return null;
  const p=JSON.parse(r);
  if(ctx.principal?.kind!=='human')for(const k of GD_OWNER_ONLY)delete p[k];
  return p;
}
function gdConfigured(env) { return !!(env.GOOGLE_DRIVE_CLIENT_ID&&env.GOOGLE_PICKER_API_KEY&&env.GOOGLE_PICKER_APP_ID); }
// Google sources are admitted only on the owner UI document, and only when import is configured.
// API, content, transfer and render responses keep the strict SEC_HEADERS policy.
const GD_CSP={'script-src':'https://accounts.google.com/gsi/client https://apis.google.com/js/api.js https://apis.google.com/_/scs/','style-src':'https://accounts.google.com/gsi/style','connect-src':'https://accounts.google.com/gsi/','frame-src':'https://accounts.google.com/gsi/ https://docs.google.com'};
function gdDocumentCsp(env) {
  if(!gdConfigured(env))return {};
  const seen=new Set(), csp=SEC_HEADERS['content-security-policy'].split(';').map(d=>d.trim()).filter(Boolean).map(d=>{const n=d.split(/\s+/)[0];if(!GD_CSP[n])return d;seen.add(n);return d+' '+GD_CSP[n];});
  if(seen.size!==Object.keys(GD_CSP).length)return {}; // fail closed: keep the strict policy
  return {'content-security-policy':csp.join('; ')};
}
// Retire this item's unfinished upload so a stale snapshot can never be resumed, and so the owner's
// single active-upload slot is released. A sealed upload with a live finalizer lease is left alone.
const GD_RETIRED=JSON.stringify({status:409,code:'source_changed',message:'Source changed; import upload retired'});
async function gdRetireUpload(DB,uploadId) {
  if(!uploadId)return;
  await DB.prepare("UPDATE uploads SET state='failed',result=?,finalize_token=NULL,finalize_until=NULL WHERE id=? AND (state IN ('pending','received') OR (state='sealed' AND (finalize_until IS NULL OR finalize_until<=?) AND NOT EXISTS (SELECT 1 FROM revisions r WHERE r.id=uploads.final_revision_id)))").bind(GD_RETIRED,uploadId,nowMs()).run();
}
async function gdJob(ctx,pid,id) {
  requireHuman(ctx);await authorizeProject(ctx,pid,true);
  const j=await ctx.env.DB.prepare('SELECT * FROM drive_import_jobs WHERE id=? AND project_id=? AND owner_id=?').bind(id,pid,ctx.principal.id).first();
  if(!j)throw gdError(404,'not_found','Import job not found');return j;
}
async function gdSession(ctx,id,token,accountId) {
  const s=await ctx.env.DB.prepare('SELECT * FROM drive_import_sessions WHERE id=? AND owner_id=? AND expires_at>?').bind(id,ctx.principal.id,nowMs()).first();
  if(!s)throw gdError(401,'needs_reauthorization','Authorize Google Drive to resume this job');
  const a=await gdAccount(ctx,token);
  if(a.id!==s.account_id || (accountId && a.id!==accountId))throw gdError(409,'wrong_account','Resume using the original Google account');
  return s;
}
async function gdState(ctx,j,offset=0) {
  const rows=await ctx.env.DB.prepare('SELECT * FROM drive_import_items WHERE job_id=? ORDER BY id LIMIT 10 OFFSET ?').bind(j.id,offset).all();
  return {job_id:j.id,project_id:j.project_id,folder_id:j.folder_id,account:j.account_label,state:j.state,manifest_version:j.manifest_version,confirmed_version:j.confirmed_version,
    items:rows.results.map(t=>({id:t.id,source_id:t.source_id,state:t.state,source:t.metadata?JSON.parse(t.metadata):null,title:t.title,mime:t.mime,kind:t.kind,size:t.size,sha256:t.sha256,preview:t.preview,another_copy:!!t.another_copy,artifact_id:t.artifact_id,library_url:t.artifact_id?artifactWebUrl(ctx.importOrigin||appOrigin(ctx.env),j.project_id,t.artifact_id):null,error_code:t.error_code,error_message:t.error_message})),next_cursor:rows.results.length===10?String(offset+10):null};
}
async function gdMutation(ctx,pid,op,key,input,fn) {
  const i={projectId:pid,op:'drive.'+op,key,digest:await sha256Hex(JSON.stringify(input))};
  const prior=await idemLookup(ctx,i);if(prior)return prior;
  // The closure returns SQL and a result, all stored transactionally with idempotency.
  const {statements,result}=await fn();
  let r;
  try { r=await runBatch(ctx,[...statements,audit(ctx,pid,'drive.import.'+op.split(':')[0],result.job_id??null,null,'ok'),idemInsert(ctx,i,200,result,'1',[])],i); }
  catch(e) { if(/malformed JSON/.test(String(e.message)))throw gdError(409,'manifest_changed','Import changed; reload and review');throw e; }
  return Array.isArray(r)?{status:200,body:result}:r;
}
async function gdInspect(ctx,j,t,token,lease) {
  const DB=ctx.env.DB;
  try {
    const m=await gdMeta(ctx,token,t.source_id), p=gdProfile(m);
    const existing=await DB.prepare('SELECT s.artifact_id,a.trashed_at,a.head_rev FROM artifact_sources s LEFT JOIN artifacts a ON a.id=s.artifact_id AND a.project_id=s.project_id WHERE s.account_id=? AND s.source_id=? AND s.project_id=? AND s.is_primary=1').bind(j.account_id,t.source_id,j.project_id).first();
    if(existing && !t.another_copy) {
      const good=existing.head_rev>0&&!existing.trashed_at;
      await DB.prepare("UPDATE drive_import_items SET state=?,artifact_id=?,metadata=?,error_code=?,error_message=? WHERE id=?").bind(good?'skipped':'failed',good?existing.artifact_id:null,JSON.stringify(m),good?'already_imported':'association_unavailable',good?'Already imported':'Previous copy is trashed or unavailable; explicitly import another copy',t.id).run();
      return;
    }
    const bytes=await gdBytes(ctx,token,m,p), sha=await sha256Hex(bytes);
    const metadata=JSON.stringify({...m,exportMime:p.exportMime??null,native_snapshot:p.native});
    const stage=t.stage_key||('drive-stage/'+j.id+'/'+t.id);
    // Reserve staging space before the R2 write. Repeated inspection keeps one tracked key.
    const used=gdUploadQuota({...ctx,driveImport:{item:t}},nowMs());
    const reserve=await DB.prepare(`UPDATE drive_import_items SET stage_key=?2,size=?3,sha256=?4,kind=?5,mime=?6,title=?7,metadata=?8,stage_writes=stage_writes+1,stage_purged=0
      WHERE id=?9 AND stage_writes=0 AND EXISTS(SELECT 1 FROM drive_import_jobs WHERE id=?10 AND lease=?11 AND state='review')
      AND (${used}) + ?12 <= ?13`).bind(j.project_id,stage,bytes.length,sha,p.kind,p.mime,p.title.slice(0,200),metadata,t.id,j.id,lease,p.kind==='binary'?bytes.length:0,limitsFor(ctx.env).projectBinaryBytes).run();
    if(!reserve.meta.changes)throw gdError(413,'quota_exceeded','Staging quota exhausted or work is still in progress');
    try { await ctx.env.BLOBS.put(stage,bytes,{httpMetadata:{contentType:'application/octet-stream'},sha256:sha}); }
    finally { await DB.prepare('UPDATE drive_import_items SET stage_writes=stage_writes-1 WHERE id=? AND stage_writes>0').bind(t.id).run(); }
    const text=p.kind==='markdown'?new TextDecoder('utf-8',{ignoreBOM:true}).decode(bytes):null;
    await DB.prepare("UPDATE drive_import_items SET state='ready',preview=?,error_code=NULL,error_message=NULL WHERE id=? AND EXISTS(SELECT 1 FROM drive_import_jobs WHERE id=? AND state='review' AND lease=?)").bind(text?.slice(0,8000)??null,t.id,j.id,lease).run();
  } catch(e) {
    await DB.prepare('UPDATE drive_import_items SET state=?,error_code=?,error_message=? WHERE id=? AND state NOT IN (\'imported\',\'cancelled\')').bind(e.code==='needs_reauthorization'?'needs_reauthorization':e.code==='unsupported_type'?'skipped':'failed',e.code||'import_failed',e instanceof HttpError?e.message:'Import failed; retry',t.id).run();
  }
}
async function gdPublish(ctx,j,t,token,lease,req) {
  const DB=ctx.env.DB;
  const dctx={...ctx,driveImport:{job:j,item:t,lease}};
  try {
    const m=JSON.parse(t.metadata), current=await gdMeta(ctx,token,t.source_id);
    if(!gdSame(m,current))throw gdError(409,'source_changed','Source changed since review; review the refreshed manifest');
    const existing=await DB.prepare('SELECT s.artifact_id,a.trashed_at,a.head_rev FROM artifact_sources s JOIN artifacts a ON a.id=s.artifact_id WHERE s.project_id=? AND s.account_id=? AND s.source_id=? AND s.is_primary=1').bind(j.project_id,j.account_id,t.source_id).first();
    if(existing&&!t.another_copy){
      if(existing.trashed_at||!existing.head_rev)throw gdError(409,'association_unavailable','Previous copy is trashed; explicitly import another copy');
      await DB.prepare("UPDATE drive_import_items SET state='skipped',artifact_id=?,error_code='already_imported',error_message='Already imported' WHERE id=? AND state<>'cancelled'").bind(existing.artifact_id,t.id).run();return;
    }
    const o=await ctx.env.BLOBS.get(t.stage_key);
    if(!o)throw gdError(409,'staging_expired','Staged content unavailable; inspect again');
    const bytes=new Uint8Array(await o.arrayBuffer());
    if(bytes.length!==t.size || await sha256Hex(bytes)!==t.sha256)throw gdError(422,'integrity_mismatch','Staged content failed integrity verification');
    if(t.kind==='markdown') {
      await createMarkdown(dctx,j.project_id,{title:t.title,body:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes),folder_id:j.folder_id,change_note:'One-time Google Drive import'},t.id+'-'+t.attempt+'-create');
    } else {
      const u=await uploadBegin(dctx,j.project_id,{title:t.title,mime:t.mime,size:t.size,sha256:t.sha256},t.id+'-'+t.attempt+'-begin');
      const uploadId=u.body.upload_id;
      const row=await DB.prepare('SELECT state FROM uploads WHERE id=?').bind(uploadId).first();
      if(row.state==='pending') {
        const headers=new Headers(req.headers);headers.delete('content-length');headers.set('content-type','application/octet-stream');
        await uploadPut(new Request(ctx.importOrigin+u.body.put_url,{method:'PUT',headers,body:bytes}),ctx.env,ctx.requestId,uploadId);
      }
      await uploadFinish(dctx,j.project_id,uploadId,t.id+'-'+t.attempt+'-finish');
    }
  } catch(e) {
    // A concurrent mapping winner causes the entire publication batch to roll back.
    const imported=await DB.prepare("SELECT 1 AS x FROM drive_import_items WHERE id=? AND state='imported'").bind(t.id).first();
    if(imported)return;
    if(e.code==='source_changed') {
      const cur=await DB.prepare('SELECT upload_id FROM drive_import_items WHERE id=?').bind(t.id).first('upload_id');
      await gdRetireUpload(DB,cur);
      await DB.prepare("UPDATE drive_import_jobs SET state='review',confirmed_version=NULL,manifest_version=manifest_version+1 WHERE id=? AND lease=?").bind(j.id,lease).run();
    }
    await DB.prepare('UPDATE drive_import_items SET state=?,error_code=?,error_message=? WHERE id=? AND state NOT IN (\'imported\',\'cancelled\')').bind(e.code==='needs_reauthorization'?'needs_reauthorization':'failed',e.code||'publish_failed',e instanceof HttpError?e.message:'Publication failed; retry',t.id).run();
  }
}
async function gdCleanup(env) {
  const DB=env.DB, now=nowMs();
  await DB.prepare('DELETE FROM drive_import_sessions WHERE id IN (SELECT id FROM drive_import_sessions WHERE expires_at<=? LIMIT 50)').bind(now).run();
  const rows=await DB.prepare(`SELECT t.id,t.stage_key FROM drive_import_items t JOIN drive_import_jobs j ON j.id=t.job_id WHERE t.stage_key IS NOT NULL AND t.stage_purged=0 AND t.stage_writes=0 AND j.lease_until<? AND (j.expires_at<? OR j.state='cancelled' OR t.state IN ('imported','skipped','cancelled')) LIMIT 25`).bind(now,now).all();
  for(const t of rows.results){await env.BLOBS.delete(t.stage_key);await DB.prepare('UPDATE drive_import_items SET stage_purged=1,preview=NULL WHERE id=? AND stage_writes=0').bind(t.id).run();}
  return {purged:rows.results.length};
}
async function gdRoute(ctx,req,pid,parts,url,key) {
  requireHuman(ctx);await authorizeProject(ctx,pid,true);ctx.importOrigin=url.origin;
  const DB=ctx.env.DB, method=req.method, token=req.headers.get('x-google-access-token');
  const configured=gdConfigured(ctx.env);
  if(parts.length===0&&method==='GET') {
    const jobs=await DB.prepare('SELECT id,state,created_at,account_label FROM drive_import_jobs WHERE project_id=? AND owner_id=? ORDER BY created_at DESC LIMIT 20').bind(pid,ctx.principal.id).all();
    return json({configured,client_id:ctx.env.GOOGLE_DRIVE_CLIENT_ID||null,api_key:ctx.env.GOOGLE_PICKER_API_KEY||null,app_id:ctx.env.GOOGLE_PICKER_APP_ID||null,max_files:25,jobs:jobs.results,connections:await listAccess(ctx),api_keys:await listApiKeys(ctx),folders:appConnectEnabled(ctx.env)?await listFolders(ctx,pid):{folders:[]}});
  }
  if(parts[0]==='sessions'&&method==='POST') {
    const a=await gdAccount(ctx,token);
    return out(await gdMutation(ctx,pid,'session',key(),{account:a.id},async()=>{
      const id=randomId('gis'),expires=nowMs()+3600000;
      return {result:{session_id:id,account:a.label,expires_at:expires},statements:[DB.prepare('INSERT INTO drive_import_sessions VALUES(?,?,?,?,?)').bind(id,ctx.principal.id,a.id,a.label,expires)]};
    }));
  }
  if(parts[0]==='sessions'&&parts.length===2&&method==='DELETE') {
    return out(await gdMutation(ctx,pid,'disconnect',key(),{id:parts[1]},async()=>({result:{ok:true},statements:[DB.prepare('DELETE FROM drive_import_sessions WHERE id=? AND owner_id=?').bind(parts[1],ctx.principal.id)]})));
  }
  if(parts[0]!=='jobs')throw gdError(404,'not_found','Not found');
  if(parts.length===1&&method==='POST') {
    const b=await body(req), s=await gdSession(ctx,b.session_id,token);
    const active=await DB.prepare("SELECT COUNT(*) AS n FROM drive_import_jobs WHERE owner_id=? AND expires_at>? AND state IN ('review','confirmed') AND EXISTS(SELECT 1 FROM drive_import_items WHERE job_id=drive_import_jobs.id AND state NOT IN ('imported','skipped','cancelled'))").bind(ctx.principal.id,nowMs()).first('n');
    if(active>=20)throw gdError(429,'too_many_jobs','Cancel an earlier import before starting another');
    if(!Array.isArray(b.file_ids)||!b.file_ids.length||b.file_ids.length>25||new Set(b.file_ids).size!==b.file_ids.length)throw gdError(400,'invalid_selection','Select 1–25 distinct files');
    b.file_ids.forEach(gdId);const folder=await folderCheck(ctx,pid,b.folder_id);
    const count=await DB.prepare('SELECT COUNT(*) AS n FROM artifacts WHERE project_id=? AND publisher_id IS NULL AND pending_review = 0').bind(pid).first('n');
    if(b.file_ids.length>LIMITS.artifactsPerProject-count)throw gdError(413,'quota_exceeded','Selection exceeds remaining project capacity');
    return out(await gdMutation(ctx,pid,'create',key(),{session:s.id,ids:b.file_ids,folder},async()=>{
      const id=randomId('gjob'),statements=[DB.prepare('INSERT INTO drive_import_jobs(id,project_id,owner_id,session_id,account_id,account_label,folder_id,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(id,pid,ctx.principal.id,s.id,s.account_id,s.account_label,folder,nowIso(),nowMs()+86400000)];
      for(const source of b.file_ids)statements.push(DB.prepare('INSERT INTO drive_import_items(id,job_id,source_id) VALUES(?,?,?)').bind(randomId('gitem'),id,source));
      return {statements,result:{job_id:id}};
    }));
  }
  let j=await gdJob(ctx,pid,parts[1]);
  if(parts.length===2&&method==='GET')return json(await gdState(ctx,j,int(Number(url.searchParams.get('cursor')||0),'cursor',0,25)));
  if(method!=='POST')throw gdError(404,'not_found','Not found');
  const b=await body(req), action=parts[2];
  if(action==='cancel') {
    const result=await gdMutation(ctx,pid,'cancel:'+j.id,key(),{},async()=>({result:{ok:true},statements:[DB.prepare("UPDATE drive_import_jobs SET state='cancelled' WHERE id=?").bind(j.id),DB.prepare("UPDATE drive_import_items SET state='cancelled',preview=NULL WHERE job_id=? AND state NOT IN ('imported','skipped')").bind(j.id),DB.prepare('DELETE FROM drive_import_sessions WHERE id=? AND owner_id=?').bind(j.session_id,ctx.principal.id)]}));
    await gdCleanup(ctx.env);return out(result);
  }
  if(j.state==='cancelled'||j.expires_at<=nowMs())throw gdError(410,'job_expired','Job cancelled or expired; create a new import');
  if(action==='resume') {
    const s=await gdSession(ctx,b.session_id,token,j.account_id);
    return out(await gdMutation(ctx,pid,'resume:'+j.id,key(),{session:s.id},async()=>({result:{ok:true},statements:[DB.prepare('UPDATE drive_import_jobs SET session_id=? WHERE id=?').bind(s.id,j.id),DB.prepare("UPDATE drive_import_items SET state=CASE WHEN stage_key IS NULL OR sha256 IS NULL THEN 'selected' ELSE 'ready' END,error_code=NULL,error_message=NULL WHERE job_id=? AND state='needs_reauthorization'").bind(j.id)]})));
  }
  if(action==='confirm') {
    const version=int(b.manifest_version,'manifest_version',1);
    if(j.lease_until>nowMs())throw gdError(409,'import_busy','Wait for the current file to finish');
    return out(await gdMutation(ctx,pid,'confirm:'+j.id,key(),{version},async()=>{
      const pending=await DB.prepare("SELECT COUNT(*) AS n FROM drive_import_items WHERE job_id=? AND state IN ('selected','inspecting','needs_reauthorization')").bind(j.id).first('n');
      if(j.manifest_version!==version||pending)throw gdError(409,'manifest_changed','Finish inspecting and review the current manifest');
      return {result:{ok:true,manifest_version:version},statements:[gdAssert(DB,"EXISTS(SELECT 1 FROM drive_import_jobs WHERE id=? AND manifest_version=? AND lease_until<=? AND state IN ('review','confirmed'))",[j.id,version,nowMs()]),DB.prepare("UPDATE drive_import_jobs SET state='confirmed',confirmed_version=? WHERE id=? AND manifest_version=? AND lease_until<=? AND state IN ('review','confirmed')").bind(version,j.id,version,nowMs())]};
    }));
  }
  if(action==='edit') {
    if(j.state!=='review'||j.lease_until>nowMs()||b.manifest_version!==j.manifest_version)throw gdError(409,'manifest_changed','Reload the current manifest');
    const t=await DB.prepare('SELECT * FROM drive_import_items WHERE id=? AND job_id=?').bind(b.item_id,j.id).first();
    if(!t||t.state==='imported')throw gdError(409,'item_state','Item cannot be changed');
    return out(await gdMutation(ctx,pid,'edit:'+j.id,key(),b,async()=>({result:{ok:true},statements:[gdAssert(DB,"EXISTS(SELECT 1 FROM drive_import_jobs WHERE id=? AND manifest_version=? AND lease_until<=? AND state='review')",[j.id,b.manifest_version,nowMs()]),DB.prepare("UPDATE drive_import_items SET state=?,another_copy=? WHERE id=? AND state<>'imported'").bind(b.remove?'cancelled':'selected',b.another_copy===true?1:t.another_copy,t.id),DB.prepare('UPDATE drive_import_jobs SET manifest_version=manifest_version+1,confirmed_version=NULL WHERE id=?').bind(j.id)]})));
  }
  if(action!=='process'&&action!=='retry')throw gdError(404,'not_found','Not found');
  // Each process key identifies a durable bounded operation, never a fire-and-forget task.
  const ik=key(), ii={projectId:pid,op:'drive.'+action+':'+j.id,key:ik,digest:await sha256Hex(JSON.stringify(b))};
  const prior=await idemLookup(ctx,ii);if(prior)return out(prior);
  try { await gdSession(ctx,j.session_id,token,j.account_id); } catch(e) {
    if(e.code==='needs_reauthorization') await DB.prepare("UPDATE drive_import_items SET state='needs_reauthorization' WHERE job_id=? AND state IN ('selected','ready')").bind(j.id).run();
    throw e;
  }
  const lease=randomId('gl'), claimed=await DB.prepare('UPDATE drive_import_jobs SET lease=?,lease_until=? WHERE id=? AND lease_until<=? AND state IN (\'review\',\'confirmed\')').bind(lease,nowMs()+120000,j.id,nowMs()).run();
  if(!claimed.meta.changes)throw gdError(409,'import_busy','Another request is processing; retry shortly');
  try {
    if(action==='retry') {
      // Re-inspection invalidates confirmation. Successful items are never revisited.
      // A changed source must be re-read: retire any upload still holding the old snapshot first.
      const stale=await DB.prepare("SELECT upload_id FROM drive_import_items WHERE job_id=? AND state='failed' AND error_code='source_changed' AND upload_id IS NOT NULL").bind(j.id).all();
      for(const r of stale.results)await gdRetireUpload(DB,r.upload_id);
      await DB.batch([
        gdAssert(DB,"EXISTS(SELECT 1 FROM drive_import_jobs WHERE id=? AND lease=? AND state IN ('review','confirmed'))",[j.id,lease]),
        DB.prepare("UPDATE drive_import_items SET state='selected',upload_id=NULL,attempt=attempt+1,error_code=NULL,error_message=NULL WHERE job_id=? AND state='failed' AND (upload_id IS NULL OR EXISTS(SELECT 1 FROM uploads WHERE id=drive_import_items.upload_id AND state IN ('failed','conflict')))").bind(j.id),
        DB.prepare("UPDATE drive_import_items SET state='ready',error_code=NULL,error_message=NULL WHERE job_id=? AND state='failed' AND upload_id IS NOT NULL AND COALESCE(error_code,'')<>'source_changed'").bind(j.id),
        DB.prepare("UPDATE drive_import_jobs SET state='review',manifest_version=manifest_version+1,confirmed_version=NULL WHERE id=?").bind(j.id)]);

    } else {
      const t=await DB.prepare("SELECT * FROM drive_import_items WHERE job_id=? AND state IN ('selected','inspecting','ready','publishing') ORDER BY id LIMIT 1").bind(j.id).first();
      if(t){
        if(j.state==='review'){
          const selected=await DB.prepare("SELECT * FROM drive_import_items WHERE job_id=? AND state IN ('selected','inspecting') ORDER BY id LIMIT 1").bind(j.id).first();
          if(selected){await DB.prepare("UPDATE drive_import_items SET state='inspecting' WHERE id=? AND state='selected'").bind(selected.id).run();await gdInspect(ctx,j,selected,token,lease);}
        } else {
          await DB.prepare("UPDATE drive_import_items SET state='publishing' WHERE id=? AND state='ready'").bind(t.id).run();
          await gdPublish(ctx,j,t,token,lease,req);
        }
      }
    }
    j=await gdJob(ctx,pid,j.id);const result=await gdState(ctx,j);
    await DB.batch([idemInsert(ctx,ii,200,result,'1',[]),audit(ctx,pid,'drive.import.'+action,j.id,null,'ok')]);return json(result);
  } finally {
    await DB.prepare('UPDATE drive_import_jobs SET lease=NULL,lease_until=0 WHERE id=? AND lease=?').bind(j.id,lease).run();
    await gdCleanup(ctx.env);
  }
}

function gdUploadQuota(ctx, now) {
  let sql=quotaUsedSql(now);
  if(ctx.driveImport) {
    const id=ctx.driveImport.item.id;
    if(!/^gitem_[A-Za-z0-9_-]+$/.test(id))throw gdError(500,'item_state','Invalid internal import item');
    sql=sql.replace("WHERE j.project_id=?1 AND t.kind='binary'", "WHERE t.id<>'"+id+"' AND j.project_id=?1 AND t.kind='binary'");
  }
  return sql;
}
function gdRestoreSources(ctx, backup, pid) {
  const rows=backup.sources??[];
  if(!Array.isArray(rows)||rows.length>100)throw gdError(400,'bad_backup','Invalid source provenance');
  return rows.map(row=>{
    let p;try{p=typeof row.provenance==='string'?JSON.parse(row.provenance):null;}catch{throw gdError(400,'bad_backup','Invalid source provenance JSON');}
    const a=backup.artifacts.find(a=>a.id===row.artifact_id);
    const r=backup.revisions.find(r=>r.artifact_id===row.artifact_id&&r.rev_no===p?.baseline_revision);
    if(!a||!p||p.provider!=='google-drive'||!r||r.sha256!==p.baseline_sha256||p.imported_sha256!==r.sha256||JSON.stringify(p).length>12000)throw gdError(400,'bad_backup','Invalid source baseline');
    const detached={provider:'google-drive',account_id:str(p.account_id,'account',200),source_id:gdId(p.source_id),source_title:str(p.source_title,'source title',200),source_mime:str(p.source_mime,'source type',200),source_url:'https://drive.google.com/file/d/'+gdId(p.source_id)+'/view',drive_id:p.drive_id??null,source_version:p.source_version??null,source_modified_time:p.source_modified_time??null,export_mime:p.export_mime,conversion_profile:str(p.conversion_profile,'conversion profile',100),imported_sha256:r.sha256,baseline_revision:r.rev_no,baseline_sha256:r.sha256,baseline_title:a.title,baseline_meta_version:1,imported_at:p.imported_at,state:'detached',sync_enabled:false,role:'primary',restored:true};
    return ctx.env.DB.prepare('INSERT INTO artifact_sources(id,project_id,artifact_id,account_id,source_id,is_primary,provenance) VALUES(?,?,?,?,?,0,?)').bind(randomId('src'),pid,a.id,detached.account_id,detached.source_id,JSON.stringify(detached));
  });
}

// SQLite has no RAISE outside a trigger. Invalid JSON deliberately aborts the entire D1 batch
// when a reviewed precondition no longer holds; no item edits/idempotency result can then commit.
function gdAssert(DB, condition, params) {
  return DB.prepare(`SELECT json(CASE WHEN (${condition}) THEN 'true' ELSE 'manifest_changed' END)`).bind(...params);
}
