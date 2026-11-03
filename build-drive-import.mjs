// Last step (after build-review.mjs): exact once-matching integration of the maintained one-time importer.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const sha=s=>createHash('sha256').update(s).digest('hex');
const input=readFileSync('src/index.js','utf8');
const base=JSON.parse(readFileSync('review-preservation.json','utf8')).integrated_sha256;
if(sha(input)!==base)throw Error('Expected review output');
let out=input;const patches=[];
function patch(name,find,replace){const i=out.indexOf(find);if(i<0||out.indexOf(find,i+1)>=0)throw Error('Expected exactly one '+name);out=out.slice(0,i)+replace+out.slice(i+find.length);patches.push({name,find,replace});}
patch('import owner UI helpers', 'var APP_JS = String.raw`(function () {\n', 'var APP_JS = String.raw`(function () {\n'+readFileSync('src/imports/ui.js','utf8')+'\n');
patch('import owner UI entry', '    actions = [newDocBtn, uploadBtn, keepBtn];\n    panel = [newDoc, upload];', '    var drivePanel = driveImportPanel(pid, function () { load(true); });\n    var driveBtn = h("button", {type:"button",class:"secondary",onclick:function(){drivePanel.open();}}, "Import → Google Drive");\n    actions = [newDocBtn, uploadBtn, driveBtn, keepBtn];\n    panel = [newDoc, upload, drivePanel];');
patch('source provenance in owner details', '  // comments\n  var comMsg', '  if (data.source) details.append(driveSourceCard(data.source));\n  // comments\n  var comMsg');
patch('visible source on binary card', '  shell(projCrumbs(A.pid, [{ t: A.meta.title }]), h("div", { class: "titlebar" }, ui.titleEl, copyBar(A, null, offlineToggle(A))), info, ui.tabNav);', '  shell(projCrumbs(A.pid, [{ t: A.meta.title }]), h("div", { class: "titlebar" }, ui.titleEl, copyBar(A, null, offlineToggle(A))), info, driveSourceCard(data.source), ui.tabNav);');
patch('import UI styles', 'var APP_CSS = `', 'var APP_CSS = `'+readFileSync('src/imports/ui.css','utf8')+'\n');
patch('maintained importer','// src/index.ts\nvar SEC_HEADERS',readFileSync('src/imports/google.js','utf8')+'\n'+readFileSync('src/imports/service.js','utf8')+'\n// src/index.ts\nvar SEC_HEADERS');
patch('owner routes','  if (rest[0] === "grants") {','  if (rest[0] === "drive-import") return gdRoute(ctx, req, pid, rest.slice(1), url, key);\n  if (rest[0] === "grants") {');
patch('provenance for authenticated artifact reads','  return {\n    artifact: { ...artifactView(a, appConnectEnabled(ctx.env)), ...await tplProvenance(ctx, projectId, a) },','  return {\n    source: await gdProvenance(ctx, projectId, artifactId),\n    artifact: { ...artifactView(a, appConnectEnabled(ctx.env)), ...await tplProvenance(ctx, projectId, a) },');
patch('text creation publication hook','    audit(ctx, projectId, "artifact.create", artId, 1, "ok", "EXISTS (SELECT 1 FROM artifacts WHERE id = ?)", [artId])',
'    audit(ctx, projectId, "artifact.create", artId, 1, "ok", "EXISTS (SELECT 1 FROM artifacts WHERE id = ?)", [artId]),\n    ...gdPublication(ctx, artId, revId)');
patch('text import publication fence','  const az = authzSql(ctx, projectId);\n  const now = nowIso();\n  const result = { status: 201, body: kind',
'  const az0 = authzSql(ctx, projectId), gf = gdFence(ctx);\n  const az = { sql: `${az0.sql} AND ${gf.sql}`, params: [...az0.params, ...gf.params] };\n  const now = nowIso();\n  const result = { status: 201, body: kind');
patch('binary import publication fence','  const azBase = authzSql(ctx, projectId);\n  const cw = contentWriteSql',
'  const az0 = authzSql(ctx, projectId), gf = gdFence(ctx);\n  const azBase = { sql: `${az0.sql} AND ${gf.sql}`, params: [...az0.params, ...gf.params] };\n  const cw = contentWriteSql');
patch('binary atomic mapping','    ...extra.map((s) => s)\n','    ...extra.map((s) => s),\n    ...gdPublication(ctx, artifactId, revId)\n');
// Atomically enforce the existing regular-file count during every creation, including imports.
patch('atomic text artifact count','AND (? IS NULL OR EXISTS (SELECT 1 FROM folders WHERE id = ? AND project_id = ?))`).bind(artId, projectId, kind, title, folder, folderId, schema, revId, now, now, ...az.params, folderId, folderId, projectId),',
'AND (? IS NULL OR EXISTS (SELECT 1 FROM folders WHERE id = ? AND project_id = ?))\n        AND (SELECT COUNT(*) FROM artifacts WHERE project_id=? AND publisher_id IS NULL AND pending_review = 0) < ?`).bind(artId, projectId, kind, title, folder, folderId, schema, revId, now, now, ...az.params, folderId, folderId, projectId, projectId, LIMITS.artifactsPerProject),');
patch('atomic creation idempotency quota gate', '    idemInsert(ctx, i, 201, result.body, az.sql, az.params),', '    idemInsert(ctx, i, 201, result.body, `${az.sql} AND (SELECT COUNT(*) FROM artifacts WHERE project_id=? AND publisher_id IS NULL AND pending_review = 0) < ?`, [...az.params, projectId, LIMITS.artifactsPerProject]),');
patch('creation quota error after race', '  if (!out2[1].meta.changes) throw new HttpError(403, "forbidden", "Grant no longer valid");', '  if (!out2[1].meta.changes) {\n    const countNow = await db(ctx).prepare("SELECT COUNT(*) AS n FROM artifacts WHERE project_id = ? AND publisher_id IS NULL AND pending_review = 0").bind(projectId).first("n");\n    if (countNow >= LIMITS.artifactsPerProject) throw new HttpError(413, "quota_exceeded", "Artifact limit reached");\n    throw new HttpError(403, "forbidden", "Grant no longer valid");\n  }');
patch('atomic binary count','SELECT ?, ?, \'binary\', ?, ?, 0, ?, ?, ?, ? WHERE ${az.sql}`).bind(artifactId, projectId, rvMeta ? RV_PLACEHOLDER : title, rvMeta ? "" : folder, nowIso(), nowIso(), rvMeta ? "required" : "off", rvMeta ? 1 : 0, ...az.params)',
'SELECT ?, ?, \'binary\', ?, ?, 0, ?, ?, ?, ? WHERE ${az.sql} AND (SELECT COUNT(*) FROM artifacts WHERE project_id=? AND publisher_id IS NULL AND pending_review = 0) < ?`).bind(artifactId, projectId, rvMeta ? RV_PLACEHOLDER : title, rvMeta ? "" : folder, nowIso(), nowIso(), rvMeta ? "required" : "off", rvMeta ? 1 : 0, ...az.params, projectId, LIMITS.artifactsPerProject)');
patch('track import upload in reservation transaction','  const gate = "EXISTS (SELECT 1 FROM uploads WHERE id = ?)";\n  stmts.push(',
'  const gate = "EXISTS (SELECT 1 FROM uploads WHERE id = ?)";\n  if (ctx.driveImport) stmts.push(db2(ctx).prepare("UPDATE drive_import_items SET upload_id=? WHERE id=?").bind(uploadId, ctx.driveImport.item.id));\n  stmts.push(');
patch('import upload result index', 'const uploadRow = res[input.artifact_id ? 0 : 1];', 'const uploadRow = res[(input.artifact_id ? 0 : 1) + (ctx.driveImport ? 1 : 0)];');
patch('preserve Office download extension', '  if (ext[r.mime] && !safeName.toLowerCase().endsWith(ext[r.mime])) safeName += ext[r.mime];', '  if (r.mime === "application/octet-stream" && a.title.length > 100 && /\\.(xlsx|pptx)$/i.test(a.title)) safeName = a.title.replace(/[^A-Za-z0-9._ -]/g, "_").slice(0,90) + a.title.slice(-5).toLowerCase();\n  if (ext[r.mime] && !safeName.toLowerCase().endsWith(ext[r.mime])) safeName += ext[r.mime];');
patch('import reservation quota transition','WHERE ${quotaUsedSql(nowMs())} + ?6 <= ?12 AND ${az.sql}',
'WHERE ${gdUploadQuota(ctx, nowMs())} + ?6 <= ?12 AND ${az.sql} AND EXISTS(SELECT 1 FROM artifacts WHERE id=?3)');
// Staging participates in every upload quota calculation, so ordinary uploads cannot consume reserved import bytes.
patch('charge private import staging',"AND NOT EXISTS (SELECT 1 FROM revisions rq WHERE rq.blob_key = pq.blob_key)))`, \"quotaUsedSql\");",
"AND NOT EXISTS (SELECT 1 FROM revisions rq WHERE rq.blob_key = pq.blob_key)))\n  + (SELECT COALESCE(SUM(t.size),0) FROM drive_import_items t JOIN drive_import_jobs j ON j.id=t.job_id WHERE j.project_id=?1 AND t.kind='binary' AND t.stage_key IS NOT NULL AND t.stage_purged=0 AND NOT EXISTS(SELECT 1 FROM uploads u WHERE u.id=t.upload_id))`, \"quotaUsedSql\");");
patch('Picker and GIS CSP', "script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; frame-src 'self';", "script-src 'self' https://accounts.google.com/gsi/client https://apis.google.com https://www.gstatic.com; style-src 'self' https://accounts.google.com/gsi/style; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self' https://accounts.google.com/gsi/ https://www.googleapis.com; frame-src 'self' https://accounts.google.com/gsi/ https://docs.google.com;");
patch('cleanup cron','ctx.waitUntil(reconcileUploads(env, { limit: 100 }).then(', 'ctx.waitUntil(gdCleanup(env));\n    ctx.waitUntil(reconcileUploads(env, { limit: 100 }).then(');
patch('backup provenance','    meta_versions: metaVersionsExport,\n    ...rvSection ?? {},\n    blobs','    meta_versions: metaVersionsExport,\n    ...rvSection ?? {},\n    sources: (await DB.prepare("SELECT artifact_id,provenance FROM artifact_sources WHERE project_id=?").bind(projectId).all()).results,\n    blobs');
patch('restore provenance validation','  const blobs = backup.blobs ?? {};','  const sourceRestore = gdRestoreSources(ctx, backup, pid);\n  const blobs = backup.blobs ?? {};');
patch('restore detached provenance','  for (const c of backup.comments)\n    stmts.push(DB.prepare(', '  stmts.push(...sourceRestore);\n  for (const c of backup.comments)\n    stmts.push(DB.prepare(');
let back=out;for(const p of [...patches].reverse()){const i=back.indexOf(p.replace);if(i<0)throw Error('Cannot reverse '+p.name);back=back.slice(0,i)+p.find+back.slice(i+p.replace.length);}
if(back!==input)throw Error('Unlisted bytes changed');
writeFileSync('src/index.js',out);
writeFileSync('drive-import-preservation.json',JSON.stringify({base_review_sha256:base,integrated_sha256:sha(out),sources_sha256:Object.fromEntries(['google.js','service.js','ui.js','ui.css'].map(f=>[f,sha(readFileSync('src/imports/'+f))])),patches:patches.map(p=>({name:p.name,find_sha256:sha(p.find)})),unchanged_outside_patches:true},null,2)+'\n');
console.log('Integrated Google Drive importer; '+patches.length+' exact patches');
