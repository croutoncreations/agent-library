// Only this adapter talks to Google. No arbitrary URLs, redirects, writes or stored tokens.
const GD_DOC = 'application/vnd.google-apps.document';
const GD_SHEET = 'application/vnd.google-apps.spreadsheet';
const GD_SLIDES = 'application/vnd.google-apps.presentation';
const GD_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const GD_PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
function gdError(status, code, message) { return new HttpError(status, code, message); }
function gdId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw gdError(400,'invalid_source_id','Select a valid Drive file');
  return id;
}
async function gdFetch(ctx, token, path) {
  if (typeof token !== 'string' || token.length > 4096 || !token.length) throw gdError(401,'needs_reauthorization','Authorize Google Drive to continue');
  let base = 'https://www.googleapis.com/drive/v3/';
  // Explicit local synthetic harness only. Cannot redirect production Google traffic.
  if (ctx.env.LOCAL_DEV_LOGIN && ctx.env.GOOGLE_DRIVE_TEST_ORIGIN && ['localhost','127.0.0.1'].includes(new URL(ctx.importOrigin).hostname)) {
    const u = new URL(ctx.env.GOOGLE_DRIVE_TEST_ORIGIN);
    if (u.protocol !== 'http:' || !['localhost','127.0.0.1'].includes(u.hostname)) throw gdError(500,'test_config','Invalid local fixture origin');
    base = u.origin + '/drive/v3/';
  }
  let r;
  try { r = await fetch(base + path, {headers:{authorization:'Bearer '+token},redirect:'manual',signal:AbortSignal.timeout(20000)}); }
  catch { throw gdError(503,'google_unavailable','Google Drive is unavailable; retry'); }
  if (!r.ok) {
    await r.body?.cancel();
    if (r.status===401) throw gdError(401,'needs_reauthorization','Google authorization expired or was revoked');
    if (r.status===403 || r.status===404) throw gdError(403,'source_access','Cannot download this selected file; check source permission and download capability');
    if (r.status===429) throw gdError(429,'source_rate_limit','Google rate limit; retry later');
    throw gdError(502,'google_error','Google could not read the file');
  }
  return r;
}
async function gdAccount(ctx, token) {
  const r = await gdFetch(ctx, token, 'about?fields=user(permissionId,emailAddress,displayName)');
  const u = (await r.json()).user;
  if (!u || typeof u.permissionId !== 'string' || u.permissionId.length>200) throw gdError(401,'needs_reauthorization','Google account identity unavailable');
  return {id:u.permissionId,label:String(u.emailAddress || u.displayName || 'Google account').slice(0,200)};
}
async function gdMeta(ctx, token, id) {
  const r = await gdFetch(ctx, token, 'files/'+gdId(id)+'?supportsAllDrives=true&fields=id,name,mimeType,size,version,modifiedTime,driveId,trashed,capabilities(canDownload)');
  const m = await r.json();
  if (m.id!==id || m.trashed || m.capabilities?.canDownload!==true) throw gdError(403,'source_access','Source is unavailable or downloading is disabled');
  return {id:m.id,name:String(m.name||'Untitled').slice(0,200),mimeType:m.mimeType,size:m.size??null,version:m.version??null,modifiedTime:m.modifiedTime??null,driveId:m.driveId??null,url:'https://drive.google.com/file/d/'+id+'/view'};
}
function gdProfile(m) {
  const native = {[GD_DOC]:['markdown','text/markdown','.md'],[GD_SHEET]:['binary',GD_XLSX,'.xlsx'],[GD_SLIDES]:['binary',GD_PPTX,'.pptx']}[m.mimeType];
  if (native) return {kind:native[0],exportMime:native[1],mime:native[0]==='markdown'?'text/markdown':'application/octet-stream',title:m.name.replace(/\.(md|xlsx|pptx)$/i,'').slice(0,190)+native[2],native:true};
  if (m.mimeType==='text/markdown' || m.mimeType==='text/x-markdown' || (m.mimeType==='text/plain' && /\.md$/i.test(m.name))) return {kind:'markdown',mime:'text/markdown',title:m.name,native:false};
  if ([GD_XLSX,GD_PPTX].includes(m.mimeType) || (m.mimeType==='application/octet-stream' && /\.(xlsx|pptx)$/i.test(m.name))) return {kind:'binary',mime:'application/octet-stream',title:m.name,native:false};
  if (m.mimeType!=='application/octet-stream' && BINARY_TYPES[m.mimeType]) return {kind:'binary',mime:m.mimeType,title:m.name,native:false};
  throw gdError(415,'unsupported_type','Unsupported type, folder or shortcut; skipped without following links');
}
function gdSame(a,b) { return ['id','name','mimeType','version','modifiedTime','size'].every(k=>a[k]===b[k]); }
async function gdBytes(ctx, token, m, p) {
  const cap = p.kind==='markdown'?LIMITS.markdownBytes:LIMITS.binaryBytes;
  if (m.size && Number(m.size)>cap) throw gdError(413,'too_large','Source exceeds the library file limit');
  const path='files/'+gdId(m.id)+(p.native?'/export?mimeType='+encodeURIComponent(p.exportMime):'?alt=media&supportsAllDrives=true');
  const r=await gdFetch(ctx,token,path), reader=r.body.getReader(), chunks=[]; let n=0;
  try {
    for (;;) { const v=await reader.read(); if(v.done)break; n+=v.value.length; if(n>cap)throw gdError(413,'too_large','Export exceeds the library file limit'); chunks.push(v.value); }
  } finally { await reader.cancel(); }
  if (!p.native && m.size!==null && n!==Number(m.size)) throw gdError(422,'integrity_mismatch','Truncated source download');
  const bytes=new Uint8Array(n); let o=0; for(const c of chunks){bytes.set(c,o);o+=c.length;}
  if(p.kind==='markdown') {
    let text; try { text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes); } catch {throw gdError(422,'invalid_utf8','Markdown must be valid UTF-8');}
    mdBody(text); // validation only; preserve the exact exported bytes
  } else if(!n || !BINARY_TYPES[p.mime](bytes)) throw gdError(415,'signature_mismatch','File signature does not match its type');
  const after=await gdMeta(ctx,token,m.id);
  if(!gdSame(m,after))throw gdError(409,'source_changed','Source changed during reading; inspect again');
  return bytes;
}
