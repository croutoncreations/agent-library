import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {createContext,runInContext} from 'node:vm';
import {readMigrations} from '../scripts/deploy/lib.mjs';
import {loadWorker} from './load-worker.mjs';
import { moduleScript } from "./module-source.mjs";

// node:sqlite behind the D1 surface the indexing module uses (prepare/bind/first/all/run and an atomic batch).
function d1(sql) {
 const stmt=(q,p=[])=>({q,p,bind:(...b)=>stmt(q,b),
  first:async c=>{const r=sql.prepare(q).get(...p);return c?r?.[c]??null:r??null;},
  all:async()=>({results:sql.prepare(q).all(...p).map(r=>({...r}))}),
  run:async()=>({meta:{changes:Number(sql.prepare(q).run(...p).changes)}})});
 return {prepare:q=>stmt(q),batch:async list=>{sql.exec('BEGIN');try{const out=list.map(s=>({meta:{changes:Number(sql.prepare(s.q).run(...s.p).changes)}}));sql.exec('COMMIT');return out;}catch(e){sql.exec('ROLLBACK');throw e;}}};
}
test('upgrade drops the old index, starts unavailable with existing content and the cron rebuild activates it from inline and R2 text',async()=>{
 const db=new DatabaseSync(':memory:'),migrations=readMigrations('migrations');
 const upgrade=migrations.find(x=>x.name==='0031_search_contentless.sql').sql;
 for(const m of migrations.filter(x=>x.name<'0031'))db.exec(m.sql);
 db.exec(`INSERT INTO principals (id, kind, issuer, subject, label, created_at) VALUES ('owner','human','synthetic','owner','Owner','2026-01-01');
 INSERT INTO projects (id, owner_id, title, created_at) VALUES ('fixture','owner','Fixture','2026-01-01');
 INSERT INTO artifacts(id,project_id,kind,title,head_rev,head_revision_id,created_at,updated_at) VALUES('art_inline','fixture','markdown','Inline fixture',1,'rev_inline','2026-01-01','2026-01-01'),('art_r2','fixture','markdown','R2 fixture',1,'rev_r2','2026-01-01','2026-01-01');
 INSERT INTO revisions(id,artifact_id,project_id,rev_no,author_id,body,body_key,size,sha256,mime,created_at) VALUES('rev_inline','art_inline','fixture',1,'owner','bootstrapword',NULL,13,'${'0'.repeat(64)}','text/markdown','2026-01-01'),('rev_r2','art_r2','fixture',1,'owner',NULL,'text/fixture/art_r2/rev_r2',9,'${'1'.repeat(64)}','text/markdown','2026-01-01');`);
 assert.equal(db.prepare("SELECT count(*) AS n FROM artifact_search WHERE artifact_search MATCH 'bootstrapword'").get().n,1,'the old trigger-maintained index held the inline body');
 db.exec(upgrade);
 for(const old of ['search_artifact_insert','search_artifact_update','search_revision_insert','search_artifact_delete'])assert.equal(db.prepare('SELECT count(*) AS n FROM sqlite_master WHERE name=?').get(old).n,0,old);
 assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE name='artifact_search'").get().sql,/content=''.*contentless_delete=1/s);
 assert.equal(db.prepare("SELECT count(*) AS n FROM artifact_search WHERE artifact_search MATCH 'bootstrapword'").get().n,0);
 assert.equal(db.prepare('SELECT ready FROM artifact_search_state').get().ready,0);
 assert.equal(db.prepare('SELECT count(*) AS n FROM artifact_search_missing').get().n,2);
 const key=db.prepare('SELECT cursor_key FROM artifact_search_state').get().cursor_key;
 const objects=new Map([['text/fixture/art_r2/rev_r2',new TextEncoder().encode('r2rebuilt')]]);
 const BLOBS={async get(k,o){let b=objects.get(k);if(!b)return null;if(o?.range)b=b.slice(o.range.offset,o.range.offset+o.range.length);return{async arrayBuffer(){return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);}};}};
 const lib=await loadWorker({'search/indexing.js':['rebuildSearchIndex']});
 const env={DB:d1(db),BLOBS};
 assert.deepEqual(await lib.rebuildSearchIndex(env,{limit:1}),{processed:1,failed:0,ready:false});
 assert.equal(db.prepare('SELECT ready FROM artifact_search_state').get().ready,0);
 assert.deepEqual(await lib.rebuildSearchIndex(env,{limit:1}),{processed:1,failed:0,ready:true});
 assert.deepEqual(await lib.rebuildSearchIndex(env),{processed:0,failed:0,ready:true},'a repeat finds nothing to do');
 assert.equal(db.prepare('SELECT cursor_key FROM artifact_search_state').get().cursor_key,key);
 for(const [word,id] of [['bootstrapword','art_inline'],['r2rebuilt','art_r2'],['fixture','art_inline']])assert.ok(db.prepare("SELECT k.artifact_id FROM artifact_search s JOIN artifact_search_keys k ON k.search_id=s.rowid WHERE artifact_search MATCH ?").all(word).some(r=>r.artifact_id===id),word);
 db.exec('UPDATE artifacts SET rowid=100 WHERE id=\'art_inline\'; VACUUM;');
 assert.equal(db.prepare("SELECT count(*) AS n FROM artifact_search s JOIN artifact_search_keys k ON k.search_id=s.rowid JOIN artifacts a ON a.id=k.artifact_id WHERE artifact_search MATCH 'bootstrapword'").get().n,1);
 assert.equal(db.prepare('SELECT count(*) AS n FROM artifact_search_missing').get().n,0);
 db.exec("UPDATE artifacts SET title='Renamed' WHERE id='art_r2'");
 assert.deepEqual(db.prepare('SELECT id FROM artifact_search_missing').all().map(r=>r.id),['art_r2'],'a title the index did not see is reported');
 objects.delete('text/fixture/art_r2/rev_r2');
 // A text object that is gone is indexed by title only (logged), so one broken document cannot keep search unavailable.
 const logged=console.error;console.error=()=>{};
 try{assert.deepEqual(await lib.rebuildSearchIndex(env),{processed:1,failed:0,ready:true});}finally{console.error=logged;}
 assert.equal(db.prepare("SELECT count(*) AS n FROM artifact_search WHERE artifact_search MATCH 'renamed'").get().n,1);
 assert.equal(db.prepare("SELECT count(*) AS n FROM artifact_search WHERE artifact_search MATCH 'r2rebuilt'").get().n,0);
 // Any other read failure leaves the document missing for the next run.
 db.exec("UPDATE artifacts SET title='Renamed again' WHERE id='art_r2'");
 const broken={DB:env.DB,BLOBS:{async get(){throw new Error('synthetic R2 outage');}}};
 console.error=()=>{};
 try{assert.deepEqual(await lib.rebuildSearchIndex(broken),{processed:1,failed:1,ready:true});}finally{console.error=logged;}
 assert.equal(db.prepare('SELECT count(*) AS n FROM artifact_search_missing').get().n,1,'still reported, so searches answer 503 rather than a gap');
 db.close();
});

test('signed cursors reject payload edits, expiry, other bindings and signing-key changes without KV',async()=>{
 let clock=1000000;
 class HttpError extends Error {constructor(status,code,message){super(message);this.status=status;this.code=code;}}
 const ctx=createContext({crypto:webcrypto,TextEncoder,TextDecoder,Uint8Array,btoa,atob,HttpError,nowMs:()=>clock});
 runInContext(moduleScript('packages/core/src/search/service.js'),ctx);
 const key='synthetic-signing-key',binding='fixture-binding',after=[1001,'2026-10-28T00:00:00.000Z','art_fixture'];
 const cursor=await ctx.rsCursorEncode(key,binding,after);assert.ok(cursor.length<=512);
 assert.deepEqual(Array.from(await ctx.rsCursorDecode(key,binding,cursor)),after);
 const bad=fn=>assert.rejects(fn,e=>e.status===400&&e.code==='invalid_cursor');
 await bad(()=>ctx.rsCursorDecode(key,'other-binding',cursor));
 await bad(()=>ctx.rsCursorDecode('other-key',binding,cursor));
 const parts=cursor.split('.');const payload=JSON.parse(Buffer.from(parts[1],'base64url'));payload.a[0]=0;
 parts[1]=Buffer.from(JSON.stringify(payload)).toString('base64url');await bad(()=>ctx.rsCursorDecode(key,binding,parts.join('.')));
 clock+=900000;await bad(()=>ctx.rsCursorDecode(key,binding,cursor));
 assert.ok(!moduleScript('packages/core/src/search/service.js').includes('OAUTH_KV.'));
});

test('MCP initialize/ping/unrelated calls bypass search; catalogs use only the singleton flag and tolerate search outages',async()=>{
 const ctx=createContext({});runInContext(moduleScript('packages/core/src/search/service.js'),ctx);
 const queries=[],env={DB:{prepare(query){queries.push(query);return {first:async()=>1};}}};
 for(const msg of [{method:'initialize'},{method:'ping'},{method:'tools/call',params:{name:'read_artifact'}},{method:'tools/call',params:{name:'save_markdown'}}]) assert.equal(await ctx.rsToolReady(env,msg),true);
 assert.deepEqual(queries,[]);
 assert.equal(await ctx.rsToolReady(env,{method:'tools/list'}),true);
 assert.equal(await ctx.rsToolReady(env,{method:'tools/call',params:{name:'search_artifacts'}}),true);
 assert.deepEqual(queries,['SELECT ready FROM artifact_search_state WHERE id=1','SELECT ready FROM artifact_search_state WHERE id=1']);
 const outage={DB:{prepare(){throw Error('synthetic search-state outage');}}};
 assert.equal(await ctx.rsToolReady(outage,{method:'tools/list'}),false);
 assert.equal(await ctx.rsToolReady(outage,{method:'ping'}),true);
});

test('owner status reads only the singleton flag, without a corpus scan',async()=>{
 const queries=[],ctx=createContext({});runInContext(moduleScript('packages/core/src/search/service.js'),ctx);
 const env={DB:{prepare(q){queries.push(q);return{first:async()=>1};}}};
 assert.equal(await ctx.rsReady(env),true);assert.deepEqual(queries,['SELECT ready FROM artifact_search_state WHERE id=1']);
});
