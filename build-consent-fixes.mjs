// Connect (OAuth consent) page redesign (run AFTER build-history-fixes.mjs, the last step before it).
// Starts from the history-fixes bundle and replaces exact, hash-pinned regions inside the OAuth server module
// (// src/oauth/server.ts) only, from src/web/connect-pages.js (page markup and the reconnect logic) and
// src/web/connect.css (the page() <style>). Every byte outside that module must stay identical. Each anchor must
// match exactly once. HOSTED_CALLBACKS, scopes, token/refresh handling and the publisher API stay byte-identical.
// The TypeScript sources are NOT rebuilt (see build-design-bundle.mjs). No config, credentials, database or network.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
const BASE=JSON.parse(readFileSync('history-fixes-preservation.json','utf8')).integrated_sha256;
const input=readFileSync('src/index.js','utf8');
if(sha(input)!==BASE)throw Error('Input is not the history-fixes bundle; run build-history-fixes.mjs first');
const once=(s,needle,what,from=0)=>{const i=s.indexOf(needle,from);if(i<0||s.indexOf(needle,i+1)>=0)throw Error('Expected exactly one '+what);return i;};
const start=once(input,'// src/oauth/server.ts\n','oauth server module start');
const end=once(input,'\n// src/index.ts\ninit_access();\n','oauth server module end')+1;
if(end<=start)throw Error('oauth server module end before start');
const oldMod=input.slice(start,end);

// Source sections: "//== region: <name>\n" ... up to the next marker or end of file.
const src=readFileSync('src/web/connect-pages.js','utf8');
if(/<\/script|<script/i.test(src))throw Error('connect-pages.js must not contain script tags (connect pages run no scripts)');
const SECTIONS={};
for(const part of src.split(/^\/\/== region: /m).slice(1)){
 const nl=part.indexOf('\n'),name=part.slice(0,nl).trim();
 if(name in SECTIONS)throw Error('connect-pages.js has region '+name+' twice');
 SECTIONS[name]=part.slice(nl+1);
}
const css=readFileSync('src/web/connect.css','utf8').trim();
if(/[`$\\]|<\/style/i.test(css))throw Error('connect.css must not contain backticks, $, backslashes or </style');

// [name, start anchor, end anchor (exclusive), sha256 of the replaced region]
const REGIONS=[
 ['toClient','function toClient(location, headers, clientHost) {\n','function allowedRedirect(u) {\n','c63929c90a643bb2819ae630ac1ed87865642896cb20a085687af11cd39711c9'],
 ['helpers','function clientFacts(d) {\n','async function appClientFor(env, clientId) {\n','af6bbcda33c7097f671136758593eae1784ce73099a91c9f0bdd8fb6e49e2a0b'],
 ['authorizeGet','async function authorizeGet(req, env, as, origin) {\n','async function authorizePost(req, env, as, origin) {\n','c4a5ad9faf315cf4ca4cf01f337eb45ee7f952c4fc6a4af740c12863bf30d5e8'],
 ['grantSave','  if (step === "grant") {\n','    const { redirectTo } = await oauth.completeAuthorization({\n      request: ar,\n      userId: connectionId,\n','2504ab51a7034014f2fcd9740c5138b750bcaea60494727461a57b55b6f4ec23'],
 ['grantPage','  const details = await oauth.describeConsent(resumed.request);\n','async function readerAudience(env, ownerId, projectId) {\n','6ee1c22d0b47108ec6d0e5388815a52a7db610a6c7a7b4c03cc396fa6920a00e'],
 ['publishConsentPage','async function publishConsentPage(env, oauth, resumed, app, principalId, email, projects) {\n','async function publishConsentPost(req, env, oauth, form, handle, origin) {\n','b3cf6558973e9a1bd462352577730db8f6a8a5e25609bd486b40dd8ff07a9070'],
 ['publishValidate','async function publishConsentPost(req, env, oauth, form, handle, origin) {\n','  const approved = await oauth.approveConsent(req, handle, { scope: [SCOPES.publish, SCOPES.offline] });\n','39f6263d9513da07abf922e177ceddf25aea17bfe52c529c1da34009857d7e4f'],
 ['errorPage','    errorPage = /* @__PURE__ */ __name(','    __name(clientFacts, "clientFacts");\n','3588fbc778e834cc1b2ebbb438472ea52e84b5dc948f6a042b37bda8a3dfe9a4'],
];
const expected=REGIONS.map(r=>r[0]).sort().join(),found=Object.keys(SECTIONS).sort().join();
if(expected!==found)throw Error(`connect-pages.js regions [${found}] must be exactly [${expected}]`);
// To re-pin after a release changes a region, read the actual hash from the error message; nothing is written on failure.
let mod=oldMod;const regions=[];
for(const [name,a,b,pin] of REGIONS){
 const rep=SECTIONS[name];
 const i=once(mod,a,name);
 const j=once(mod,b,name+' end');
 if(j<=i)throw Error('End anchor before start for '+name);
 const old=mod.slice(i,j);
 if(sha(old)!==pin)throw Error('Region changed for '+name+': '+sha(old));
 regions.push({name,replaced_sha256:sha(old),replacement_sha256:sha(rep)});
 mod=mod.slice(0,i)+rep+mod.slice(j);
}
// page(): declare the page language (WCAG 3.1.1).
{const d='return new Response(`<!doctype html><meta charset="utf-8">';const i=once(mod,d,'page() doctype');mod=mod.slice(0,i)+'return new Response(`<!doctype html><html lang="en"><meta charset="utf-8">'+mod.slice(i+d.length);}
// page() <style>: exactly one style element in the helper.
const sa=once(mod,'<title>${esc(title)}</title>\n<style>','page() style start')+'<title>${esc(title)}</title>\n'.length;
const sb=once(mod,'</style>${body2}`','page() style end',sa)+'</style>'.length;
const styleOld=mod.slice(sa,sb);
mod=mod.slice(0,sa)+'<style>'+css+'</style>'+mod.slice(sb);
// Protected: the hosted callback allow-list and scope catalogue, compared as complete statements.
const stmt=(s,head,tail)=>{const i=once(s,head,head.slice(0,30));return s.slice(i,s.indexOf(tail,i)+tail.length);};
for(const [head,tail] of [['HOSTED_CALLBACKS = /* @__PURE__ */ new Set([',']);'],['    SCOPES = {','};'],['    CATALOGUE = [','];'],['    AC_CATALOGUE = [','];']])
 if(stmt(mod,head,tail)!==stmt(oldMod,head,tail))throw Error('Protected block changed: '+head.trim());
const out=input.slice(0,start)+mod+input.slice(end);
if(out.slice(0,start)!==input.slice(0,start)||!out.endsWith(input.slice(end)))throw Error('Bytes outside the oauth server module changed');
writeFileSync('src/index.js',out);
const meta={base_history_fixes_sha256:BASE,integrated_sha256:sha(out),
 preserved_prefix_sha256:sha(input.slice(0,start)),preserved_suffix_sha256:sha(input.slice(end)),
 oauth_server_module_sha256:{history_fixes:sha(oldMod),candidate:sha(mod)},patched_module:'src/oauth/server.ts',
 style:{replaced_sha256:sha(styleOld),candidate_sha256:sha(css)},regions};
writeFileSync('consent-fixes-preservation.json',JSON.stringify(meta,null,2)+'\n');
console.log(JSON.stringify(meta,null,1));
