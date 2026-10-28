import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {createContext,runInContext} from 'node:vm';
import {readMigrations} from '../scripts/deploy/lib.mjs';
import {backfillSql} from '../scripts/search/backfill.mjs';

test('upgrade starts unavailable with existing content, activates only after indexing and is retry-safe',()=>{
 const db=new DatabaseSync(':memory:'),migrations=readMigrations('migrations');
 for(const m of migrations.filter(x=>x.name!=='0014_ranked_search.sql'))db.exec(m.sql);
 db.exec(`INSERT INTO principals VALUES('owner','human','synthetic','owner','Owner','2026-01-01');
 INSERT INTO projects VALUES('fixture','owner','Fixture','2026-01-01');
 INSERT INTO artifacts(id,project_id,kind,title,head_rev,head_revision_id,created_at,updated_at) VALUES('art_fixture','fixture','markdown','Bootstrap fixture',1,'rev_fixture','2026-01-01','2026-01-01');
 INSERT INTO revisions(id,artifact_id,project_id,rev_no,author_id,body,size,sha256,mime,created_at) VALUES('rev_fixture','art_fixture','fixture',1,'owner','bootstrapword',13,'${'0'.repeat(64)}','text/markdown','2026-01-01');`);
 const migration=migrations.find(x=>x.name==='0014_ranked_search.sql').sql;
 db.exec(migration);assert.equal(db.prepare('SELECT ready FROM artifact_search_state').get().ready,0);
 assert.equal(db.prepare('SELECT count(*) AS n FROM artifact_search_missing').get().n,1);
 db.exec(backfillSql(999,1));assert.equal(db.prepare('SELECT ready FROM artifact_search_state').get().ready,0);
 db.exec(backfillSql(0,1));assert.equal(db.prepare('SELECT ready FROM artifact_search_state').get().ready,1);
 const key=db.prepare('SELECT cursor_key FROM artifact_search_state').get().cursor_key;
 db.exec(migration);db.exec(backfillSql(0,1));assert.equal(db.prepare('SELECT cursor_key FROM artifact_search_state').get().cursor_key,key);
 assert.equal(db.prepare('SELECT count(*) AS n FROM artifact_search').get().n,1);
 db.exec('UPDATE artifacts SET rowid=100; VACUUM;');
 assert.equal(db.prepare("SELECT count(*) AS n FROM artifact_search s JOIN artifacts a ON a.id=s.artifact_id WHERE artifact_search MATCH 'bootstrapword'").get().n,1);
 assert.equal(db.prepare('SELECT count(*) AS n FROM artifact_search_missing').get().n,0);db.close();
});

test('signed cursors reject payload edits, expiry, other bindings and signing-key changes without KV',async()=>{
 let clock=1000000;
 class HttpError extends Error {constructor(status,code,message){super(message);this.status=status;this.code=code;}}
 const ctx=createContext({crypto:webcrypto,TextEncoder,TextDecoder,Uint8Array,btoa,atob,HttpError,nowMs:()=>clock});
 runInContext(readFileSync('src/search/service.js','utf8'),ctx);
 const key='synthetic-signing-key',binding='fixture-binding',after=[1001,'2026-10-28T00:00:00.000Z','art_fixture'];
 const cursor=await ctx.rsCursorEncode(key,binding,after);assert.ok(cursor.length<=512);
 assert.deepEqual(Array.from(await ctx.rsCursorDecode(key,binding,cursor)),after);
 const bad=fn=>assert.rejects(fn,e=>e.status===400&&e.code==='invalid_cursor');
 await bad(()=>ctx.rsCursorDecode(key,'other-binding',cursor));
 await bad(()=>ctx.rsCursorDecode('other-key',binding,cursor));
 const parts=cursor.split('.');const payload=JSON.parse(Buffer.from(parts[1],'base64url'));payload.a[0]=0;
 parts[1]=Buffer.from(JSON.stringify(payload)).toString('base64url');await bad(()=>ctx.rsCursorDecode(key,binding,parts.join('.')));
 clock+=900000;await bad(()=>ctx.rsCursorDecode(key,binding,cursor));
 assert.ok(!readFileSync('src/search/service.js','utf8').includes('OAUTH_KV.'));
});

test('MCP initialize/ping/unrelated calls bypass search; catalogs use only the singleton flag and tolerate search outages',async()=>{
 const ctx=createContext({});runInContext(readFileSync('src/search/service.js','utf8'),ctx);
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
