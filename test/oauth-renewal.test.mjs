// Exercise the actual deployed bundle and OAuth provider with synthetic storage; no accounts or network.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const dir=mkdtempSync(join(tmpdir(),'library-oauth-renewal-'));
after(()=>rmSync(dir,{recursive:true,force:true}));
const source=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
writeFileSync(join(dir,'bundle.mjs'),source.replace('import { WorkerEntrypoint } from "cloudflare:workers";','class WorkerEntrypoint {}')+'\nexport {servers,handleOAuthHost};\n');
const {servers,handleOAuthHost}=await import(join(dir,'bundle.mjs'));
class KV {
 rows=new Map();
 async get(k,options){const r=this.rows.get(k);if(!r||r.expiry&&r.expiry<=Date.now())return null;return options==='json'||options?.type==='json'?JSON.parse(r.value):r.value;}
 async put(k,value,options={}){this.rows.set(k,{value,expiry:options.expiration?options.expiration*1000:options.expirationTtl?Date.now()+options.expirationTtl*1000:undefined});}
 async delete(k){this.rows.delete(k);}
 async list({prefix='' }={}){return {keys:[...this.rows.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name})),list_complete:true};}
}
async function fixture({publisher=false}={}){
 const origin='https://library-'+crypto.randomUUID()+'.example.test',resource=origin+'/mcp',redirect='http://127.0.0.1/callback';
 const connection={id:'oac_synthetic12345',owner_principal_id:'human',revoked_at:null,expires_at:Date.now()+30*86400000};
 let fail,revokedDuringRenewal=false;
 const claims=new Map();
 const DB={prepare(q){return {bind(...p){return {async first(){
  if(q.includes('rate_counters'))return 1;
  if(q.includes('UPDATE oauth_code_redemptions')){const old=claims.get(p[1]);if(old===undefined||old>p[2])return null;claims.set(p[1],p[0]);return {code_hash:p[1]};}
  const stage=q.startsWith('UPDATE')?'renew':'read';if(fail===stage)throw Error('synthetic database outage');
  if(q.startsWith('UPDATE')){if(revokedDuringRenewal)connection.revoked_at=1;if(connection.revoked_at!==null||connection.expires_at<=p[2])return null;connection.expires_at=p[0];return {id:connection.id};}
  if(q.includes('FROM publishers'))return {id:'pub_synthetic12345',revoked_at:connection.revoked_at,token_epoch:1};
  return {...connection};
 },async run(){
  if(q.startsWith('INSERT INTO oauth_code_redemptions')){if(claims.has(p[0]))return {meta:{changes:0}};claims.set(p[0],p[1]);return {meta:{changes:1}};}
  return {meta:{changes:0}};
 },async all(){if(fail==='projects')throw Error('synthetic database outage');return {results:[{id:'project',can_write:0}]};}};}};}};
 const env={DB,OAUTH_KV:new KV()},as=servers(origin).as,api=as.getOAuthApi(env);
 const client=await api.createClient({clientName:'Synthetic client',redirectUris:[redirect],tokenEndpointAuthMethod:'none'});
 const verifier='v'.repeat(64),challenge=createHash('sha256').update(verifier).digest('base64url');
 const complete=await api.completeAuthorization({request:{clientId:client.clientId,redirectUri:redirect,responseType:'code',resource,scope:['agentlib:read','offline_access'],codeChallenge:challenge,codeChallengeMethod:'S256',state:'synthetic'},userId:connection.id,metadata:{},scope:['agentlib:read','offline_access'],props:publisher?{publisher_id:'pub_synthetic12345',epoch:1}:{connection_id:connection.id}});
 const send=async fields=>{const response=await handleOAuthHost(new Request(origin+'/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:client.clientId,resource,...fields})}),env,{},new URL(origin).host);return {status:response.status,body:await response.json(),retryAfter:response.headers.get('retry-after')};};
 const issued=await send({grant_type:'authorization_code',code:new URL(complete.redirectTo).searchParams.get('code'),code_verifier:verifier,redirect_uri:redirect});
 assert.equal(issued.status,200,JSON.stringify(issued.body));
 return {env,connection,issued,as,client,send,claims,expireClaims:()=>{for(const [key,value] of claims)claims.set(key,value-300001);},setFailure:v=>{fail=v;},raceRevocation:()=>{revokedDuringRenewal=true;},refresh:token=>send({grant_type:'refresh_token',refresh_token:token??issued.body.refresh_token})};
}
for(const stage of ['read','projects','renew'])test('temporary '+stage+' failure preserves the grant and original refresh token',async()=>{
 const f=await fixture();f.setFailure(stage);
 const failed=await f.refresh();assert.equal(failed.status,503);assert.equal(failed.body.error,'temporarily_unavailable');assert.equal(failed.retryAfter,'300');
 f.setFailure(undefined);assert.equal((await f.refresh()).status,503,'in-flight claim cools down without burning the token');f.expireClaims();const retry=await f.refresh();assert.equal(retry.status,200,JSON.stringify(retry.body));assert.equal(retry.body.expires_in,900);assert.notEqual(retry.body.refresh_token,f.issued.body.refresh_token);
 assert.equal(f.connection.expires_at,Date.UTC(9999,0,1));
});
for(const state of ['revoked','expired','revoked-during-renewal'])test(state+' connections cannot renew',async()=>{
 const f=await fixture();if(state==='revoked')f.connection.revoked_at=1;else if(state==='expired')f.connection.expires_at=1;else f.raceRevocation();
 const r=await f.refresh();assert.equal(r.status,400);assert.equal(r.body.error,'invalid_grant');
 assert.equal((await f.refresh()).body.error,'invalid_grant','revoked grant remains unusable');
});
test('active legacy connections migrate on renewal; OAuth grants and clients survive the former 30-day deadline',async()=>{
 const f=await fixture(),now=Date.now,at=now();
 let r=await f.refresh();assert.equal(r.status,200);
 try{
  Date.now=()=>at+45*86400000;
  r=await f.refresh(r.body.refresh_token);assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.expires_in,900);
  const grantKey=[...f.env.OAUTH_KV.rows.keys()].find(k=>k.startsWith('grant:'));
  const grant=await f.env.OAUTH_KV.get(grantKey,'json');assert.ok(grant.expiresAt*1000>Date.now()+9*365*86400000);
 }finally{Date.now=now;}
});

test('publisher refresh survives a database outage but confirmed revocation still ends its grant',async()=>{
 const f=await fixture({publisher:true});f.setFailure('read');
 const outage=await f.refresh();assert.equal(outage.status,503);assert.equal(outage.body.error,'temporarily_unavailable');
 f.setFailure(undefined);assert.equal((await f.refresh()).status,503,'in-flight claim cools down without burning the token');f.expireClaims();const retry=await f.refresh();assert.equal(retry.status,200);
 f.connection.revoked_at=1;const revoked=await f.refresh(retry.body.refresh_token);assert.equal(revoked.status,400);assert.equal(revoked.body.error,'invalid_grant');
});

test('cleanup of 31-day redemption history never permits replay of a previous refresh token',async()=>{
 const f=await fixture(),old=f.issued.body.refresh_token;const renewed=await f.refresh();assert.equal(renewed.status,200);
 const now=Date.now,at=now();try{
  Date.now=()=>at+45*86400000;f.claims.clear();
  const replay=await f.refresh(old);assert.equal(replay.status,400);assert.equal(replay.body.error,'invalid_grant');
  assert.equal((await f.refresh(renewed.body.refresh_token)).status,200,'the current token still renews');
 }finally{Date.now=now;}
});

test('confirmed revocation takes priority over a pending refresh claim',async()=>{
 const f=await fixture({publisher:true});f.setFailure('read');assert.equal((await f.refresh()).status,503);
 f.setFailure(undefined);f.connection.revoked_at=1;
 const revoked=await f.refresh();assert.equal(revoked.status,400);assert.equal(revoked.body.error,'invalid_grant');
});
