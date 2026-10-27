// OAuth renewal fixes, after build-portability-fixes.mjs. Patch the OAuth server module and one connection expiry label in the pinned bundle.
// Tokens remain 15 minutes; grants slide ten years and D1 connections last until revoked. No production I/O.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const sha=s=>createHash('sha256').update(s).digest('hex');
const input=readFileSync('src/index.js','utf8');
const base=JSON.parse(readFileSync('portability-fixes-preservation.json','utf8')).output;
if(sha(input)!==base)throw Error('Run build-portability-fixes.mjs before build-auth-fixes.mjs');
const once=(s,needle)=>{const a=s.indexOf(needle);if(a<0||s.indexOf(needle,a+1)>=0)throw Error('Expected exactly once: '+needle);return a;};
const start=once(input,'// src/oauth/server.ts\n'),end=once(input,'\n// src/index.ts\ninit_access();\n')+1;
let mod=input.slice(start,end);const old=mod;
const replace=(find,rep)=>{const a=once(mod,find);mod=mod.slice(0,a)+rep+mod.slice(a+find.length);};
replace('    refreshTokenTTL: 30 * 24 * 3600,\n    clientRegistrationTTL: 30 * 24 * 3600,',
 '    refreshTokenTTL: 10 * 365 * 24 * 3600,\n    refreshTokenIdleTTL: 10 * 365 * 24 * 3600,\n    clientRegistrationTTL: 10 * 365 * 24 * 3600,');
const a=once(mod,'    tokenExchangeCallback: /* @__PURE__ */ __name('),b=once(mod,'    }, "tokenExchangeCallback"),')+'    }, "tokenExchangeCallback"),'.length;
const callback=readFileSync('src/oauth-renewal/callback.js','utf8').trim();
if(!callback.startsWith('async ({ grantType, props, env }) => {')||/^(import|export)\s/m.test(callback))throw Error('Unexpected callback source');
const pin='b531d4e45151ae13ddde6d84b5ce36435222b7a5511084812ff0a54dafaf8a73';
if(sha(mod.slice(a,b))!==pin)throw Error('OAuth callback changed: '+sha(mod.slice(a,b)));
mod=mod.slice(0,a)+'    tokenExchangeCallback: /* @__PURE__ */ __name('+callback+', "tokenExchangeCallback"),'+mod.slice(b);
const ga=once(mod,'async function singleUseGate(req, env) {'),gb=once(mod,'async function readCapped(req, max) {');
if(sha(mod.slice(ga,gb))!=='285f93b8558002199dfe0bc6160d05cfccb464dad14cfab2212a2ae856d69e3d')throw Error('Single-use gate changed; review before re-pinning');
const gate=readFileSync('src/oauth-renewal/single-use-gate.js','utf8').trimEnd()+'\n';
mod=mod.slice(0,ga)+gate+mod.slice(gb);
replace('const res = gated instanceof Response ? gated : await as.fetch(gated, env, ctx);',
 'const res = gated instanceof Response ? gated : await as.fetch(gated.request ?? gated, { ...env, __oauthRefreshClaimBusy: gated.refreshBusy === true }, ctx);');
replace('at, nowMs() + CONNECTION_TTL_MS),','at, CONNECTION_EXPIRES_AT),');
replace('CONNECTION_TTL_MS, cache,','CONNECTION_EXPIRES_AT, cache,');
replace('    CONNECTION_TTL_MS = 30 * 24 * 36e5;','    CONNECTION_EXPIRES_AT = Date.UTC(9999, 0, 1);');
const suffix=input.slice(end);
const expiry='c.status === "active" ? "Expires " + fmtDate(c.expires_at) : null';
const label='c.status === "active" ? (new Date(c.expires_at).getUTCFullYear() >= 9000 ? "Until you disconnect" : "Expires " + fmtDate(c.expires_at)) : null';
const ui=once(suffix,expiry);
const out=input.slice(0,start)+mod+suffix.slice(0,ui)+label+suffix.slice(ui+expiry.length);
writeFileSync('src/index.js',out);
writeFileSync('auth-fixes-preservation.json',JSON.stringify({base_portability_fixes_sha256:base,integrated_sha256:sha(out),preserved_prefix_sha256:sha(input.slice(0,start)),preserved_suffix_before_label_sha256:sha(suffix.slice(0,ui)),preserved_suffix_after_label_sha256:sha(suffix.slice(ui+expiry.length)),ui_expiry_label_sha256:sha(label),oauth_server_module_sha256:{base:sha(old),candidate:sha(mod)},callback_sha256:sha(callback)},null,2)+'\n');
console.log('OAuth renewal bundle: '+sha(out));
