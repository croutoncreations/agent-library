// Release-check failure behavior is isolated here; connection-diagnostics.test.mjs drives real HTTP/MCP.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, runInContext} from 'node:vm';
const source=readFileSync(new URL('../scripts/deploy/smoke.mjs', import.meta.url),'utf8').replace(/^#!.*\n/,'').replace(/^import .*\n/gm,'');
async function run(change = d => d) {
  const fixtureCredential='synthetic-credential-not-for-output', logs=[];
  let results, exit;
  const diagnostic=change({connection:{type:'api_key',id:'akey_synthetic'},checked_at:'2026-01-01T00:00:00Z',successful_operations:'not measured',projects:[{id:'synthetic-project',can_read:true,can_write:true}]});
  const ctx=createContext({URL,Response,AbortSignal,Date,JSON,Number,String,Promise,
    loadTarget:()=>({vars:{APP_HOST:'owner.example.invalid',MCP_HOST:'machine.example.invalid',ACCESS_TEAM_DOMAIN:'team.example.invalid'}}),
    writeFileSync:(_p,s)=>{results=JSON.parse(s);}, console:{log:s=>logs.push(s)},
    process:{argv:['node','smoke.mjs','result.json'],env:{AL_SMOKE_API_TOKEN:fixtureCredential,AL_SMOKE_PROJECT_ID:'synthetic-project'},exit:c=>{exit=c;}},
    setTimeout:fn=>{fn();return 0;},
    fetch:async (url,init)=>{
      const u=new URL(url), auth=init.headers.authorization;
      if(u.hostname==='owner.example.invalid') return new Response(null,{status:302,headers:{location:'https://team.example.invalid/cdn-cgi/access/login/'}});
      if(u.pathname==='/.well-known/oauth-authorization-server') return Response.json({issuer:'https://machine.example.invalid',authorization_endpoint:'https://machine.example.invalid/authorize',token_endpoint:'https://machine.example.invalid/token'});
      if(!auth)return new Response(null,{status:401,headers:{'www-authenticate':'Bearer'}});
      assert.equal(auth,'Bearer '+fixtureCredential);
      if(u.pathname==='/v1/projects')return Response.json({projects:[{id:'synthetic-project'}]});
      if(u.pathname==='/v1/connection-info') return u.search ? Response.json({error:'invalid_input'},{status:400}) : Response.json(diagnostic,{headers:{'cache-control':'no-store'}});
      throw Error('Unexpected smoke route');
    }
  });
  await runInContext('(async()=>{'+source+'})()',ctx);
  assert.ok(!JSON.stringify({logs,results}).includes(fixtureCredential),'release evidence must never print the credential');
  return {results,exit};
}
test('release smoke authenticates the diagnostic and verifies no arbitrary identity lookup',async()=>{
  const r=await run();assert.equal(r.exit,0);
  const app=r.results.filter(x=>x.level==='app');assert.equal(app.length,3);assert.ok(app.every(x=>x.ok));
  assert.ok(r.results.some(x=>x.name.includes('arbitrary identity')&&x.ok));
});
test('release smoke fails closed when diagnostic scope differs from the synthetic credential',async()=>{
  const r=await run(d=>({...d,projects:[{id:'another-project',can_read:true,can_write:true}]}));
  assert.equal(r.exit,1);assert.ok(r.results.some(x=>x.name.includes('connection diagnostic reports')&&x.ok===false));
});
test('release smoke rejects a false successful-operation claim',async()=>{
  const r=await run(d=>({...d,successful_operations:'passed'}));assert.equal(r.exit,1);
  assert.ok(r.results.some(x=>x.detail.includes('activity must not imply a successful document operation')&&x.ok===false));
});
