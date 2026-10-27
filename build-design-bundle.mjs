// Design pass integration step (run AFTER build-current-bundle.mjs).
// Starts from the publisher-integrated baseline (build-current-bundle.mjs output) and replaces exactly these spans; every other byte must stay identical:
//   1. the browser UI module (// src/ui.ts: APP_HTML, APP_CSS, APP_JS) from src/web/app.{html,css,js}
//   2. the Markdown renderer module (// src/markdown.ts) from src/render/markdown.module.js (GFM pipe tables);
//      the release module was extracted verbatim (sha256 1896bc44…) because src/markdown.ts is older than the bundle
//   3. with --consent-style: only the <style> text of the OAuth page() helper, from src/web/consent.css
// The publisher/generation module, grants/scopes/consent logic, HOSTED_CALLBACKS and all API modules stay byte-identical.
// The TypeScript sources are NOT rebuilt (the bundle contains modules newer than src/). No config, credentials,
// database or network is used.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
const RELEASE='7ca4365663bd3518a3613510b3d511a1357c5b2b53be9692d1ab82fcbbd50ef1';
const MARKDOWN_RELEASE='1896bc44836ba5c3ee0a7c92a95dee9346c42f3d15c795a0cc54409d6efda4e0';
const consentStyle=process.argv.includes('--consent-style');
const release=readFileSync(process.env.DESIGN_RELEASE_INPUT||'src/index.js','utf8');
if(sha(release)!==RELEASE)throw Error('Input is not the publisher-integrated baseline 7ca43656; run build-current-bundle.mjs first');
const once=(s,needle,what,from=0)=>{const i=s.indexOf(needle,from);if(i<0||s.indexOf(needle,i+1)>=0)throw Error('Expected exactly one '+what);return i;};
// A module spans from its "// <name>\n" marker to the next module's marker.
const mod=(name,next)=>{const a=once(release,`// ${name}\n`,name+' start');const b=release.indexOf(`\n// ${next}\n`,a)+1;if(b<=a)throw Error(name+' end not found');return [a,b];};
const [srvStart,srvEnd]=mod('src/oauth/server.ts','src/index.ts');
const [mdStart,mdEnd]=mod('src/markdown.ts','src/html.ts');
const [uiStart,uiEnd]=mod('src/ui.ts','src/index.ts');
if(!(srvEnd<=mdStart&&mdEnd<=uiStart))throw Error('Unexpected module order');
const pubStart=once(release,'// src/api/publisher.ts \u2014 isolated readable-generation integration\n','publisher module');
if(pubStart>=srvStart)throw Error('Unexpected publisher position');
const pub=release.slice(pubStart,srvStart);

// 1. UI module
const read=f=>readFileSync('src/web/'+f,'utf8');
const html=read('app.html'),css=read('app.css'),js=read('app.js');
for(const [n,t] of [['app.html',html],['app.css',css]])if(/`|\$\{/.test(t))throw Error(n+' must not contain backticks or ${');
if(/`/.test(js.replace(/\\`/g,'')))throw Error('app.js must not contain unescaped backticks');
const ui='// src/ui.ts\nvar APP_HTML = `'+html+'`;\nvar APP_CSS = `'+css+'`;\nvar APP_JS = String.raw`'+js+'`;\n\n';

// 2. Markdown module
const mdOld=release.slice(mdStart,mdEnd);
if(sha(mdOld)!==MARKDOWN_RELEASE)throw Error('Release Markdown module changed');
// Module text ends with one blank line before the next module marker, exactly like the release.
const md=readFileSync('src/render/markdown.module.js','utf8').replace(/\s*$/,'\n\n');
if(!md.startsWith('// src/markdown.ts\n'))throw Error('markdown.module.js must start with its module marker');
for(const name of ['esc2','imageRefs','renderMarkdown'])if(!new RegExp(`(var|function) ${name}\\b`).test(md))throw Error('markdown.module.js must define '+name);

// 3. Optional consent style (page() <style> only)
let srv=release.slice(srvStart,srvEnd),styleOld=null,styleNew=null;
if(consentStyle){
  const a=once(srv,'<title>${esc(title)}</title>\n<style>','page() style start')+'<title>${esc(title)}</title>\n'.length;
  const b=once(srv,'</style>${body2}`','page() style end',a)+'</style>'.length;
  styleOld=srv.slice(a,b);
  if(!styleOld.startsWith('<style>')||(styleOld.match(/<style>/g)||[]).length!==1)throw Error('Unexpected release page() style span');
  const raw=readFileSync('src/web/consent.css','utf8').trim();
  if(/[`$\\]|<\/style/i.test(raw))throw Error('consent.css must not contain backticks, $, backslashes or </style');
  styleNew='<style>'+raw+'</style>';
  srv=srv.slice(0,a)+styleNew+srv.slice(b);
}

// Assemble: release with exactly three spans replaced, in file order.
const out=release.slice(0,srvStart)+srv+release.slice(srvEnd,mdStart)+md+release.slice(mdEnd,uiStart)+ui+release.slice(uiEnd);
// Protected blocks, checked again on the output by content (not only by construction).
const callbacks=s=>{const i=once(s,'HOSTED_CALLBACKS = /* @__PURE__ */ new Set([','HOSTED_CALLBACKS');return s.slice(i,s.indexOf(']);',i)+3);};
if(out.slice(pubStart,srvStart)!==pub)throw Error('Publisher module changed');
if(callbacks(out)!==callbacks(release))throw Error('HOSTED_CALLBACKS changed');
if(!consentStyle&&srv!==release.slice(srvStart,srvEnd))throw Error('OAuth server module changed');
if(out.slice(0,srvStart)!==release.slice(0,srvStart))throw Error('Bytes before the OAuth server module changed');
if(!out.endsWith(release.slice(uiEnd)))throw Error('Bytes after the UI module changed');

writeFileSync(process.env.DESIGN_OUTPUT||'src/index.js',out);
const meta={base_release_sha256:RELEASE,integrated_sha256:sha(out),
 preserved_prefix_sha256:sha(release.slice(0,srvStart)),preserved_suffix_sha256:sha(release.slice(uiEnd)),
 preserved_between_server_and_markdown_sha256:sha(release.slice(srvEnd,mdStart)),preserved_between_markdown_and_ui_sha256:sha(release.slice(mdEnd,uiStart)),
 publisher_module_sha256:sha(pub),oauth_server_module_sha256:{release:sha(release.slice(srvStart,srvEnd)),candidate:sha(srv)},
 hosted_callbacks_sha256:sha(callbacks(out)),markdown_module_sha256:{release:sha(mdOld),candidate:sha(md)},
 ui_module_release_sha256:sha(release.slice(uiStart,uiEnd)),ui_module_candidate_sha256:sha(ui),
 consent_style_applied:consentStyle,consent_style_release_sha256:styleOld&&sha(styleOld),consent_style_candidate_sha256:styleNew&&sha(styleNew),
 replaced:['src/ui.ts (APP_HTML, APP_CSS, APP_JS)','src/markdown.ts (renderer)'].concat(consentStyle?['OAuth page() <style> only']:[])};
if(!process.env.DESIGN_OUTPUT)writeFileSync('design-bundle-preservation.json',JSON.stringify(meta,null,2)+'\n');
console.log(JSON.stringify(meta,null,1));
