// App icon integration step (run AFTER build-ui-fixes.mjs).
// Starts from the UI-fixes bundle d4eb0b0a and replaces the installed-app (PWA) icons with the approved "Fold"
// brand mark the nav already shows (src/web/brand/app-*.png, made by scripts/design/make-app-icons.mjs).
// Changes exactly these spans; every other byte must stay identical:
//   1. the icon data module (// src/pwa-icons.ts), rebuilt from the committed PNGs
//   2. in the PWA module (// src/pwa.ts): manifest icon URLs, shell cache name and shell paths (exact, once-matching)
//   3. in the UI module's APP_HTML: the favicon and apple-touch-icon links (exact, once-matching)
// New URLs (/icons/app-*.png) make browsers and launchers fetch the new icons instead of reusing cached ones; the
// old URLs keep answering with the new images for pages still holding old HTML. The shell cache name changes so
// installed apps drop their cached copies. No config, credentials, database or network is used.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
const UI_FIXES='16483c0748dc26b1d4691fd99893e745498482736c233bfd482a7cd38e0c9f59';
const input=readFileSync('src/index.js','utf8');
if(sha(input)!==UI_FIXES)throw Error('Input is not the UI-fixes bundle d4eb0b0a; run build-ui-fixes.mjs first');
const once=(s,needle,what,from=0)=>{const i=s.indexOf(needle,from);if(i<0||s.indexOf(needle,i+1)>=0)throw Error('Expected exactly one '+what);return i;};

// New icon file name -> committed PNG. Old names are served the matching new image.
const PNG=(f)=>{const b=readFileSync('src/web/brand/'+f);if(b.readUInt32BE(0)!==0x89504e47)throw Error(f+' is not a PNG');return b;};
const FILES={
 'app-icon-192.png':PNG('app-icon-192.png'),
 'app-icon-512.png':PNG('app-icon-512.png'),
 'app-maskable-512.png':PNG('app-maskable-512.png'),
 'app-apple-180.png':PNG('app-apple-180.png'),
};
const OLD_TO_NEW={'icon-192.png':'app-icon-192.png','icon-512.png':'app-icon-512.png','maskable-512.png':'app-maskable-512.png','apple-180.png':'app-apple-180.png'};
const entries=Object.entries(FILES).map(([k,b])=>`  "${k}": "${b.toString('base64')}"`);
// Old names alias the new data (getters; Object.entries in servePwa evaluates them) instead of a second base64 copy.
const aliases=Object.entries(OLD_TO_NEW).map(([o,n])=>`  get "${o}"() {\n    return this["${n}"];\n  }`);

// 1. Icon data module: same shape as the release (var ICONS = { "<name>": "<base64>", ... };).
const iStart=once(input,'// src/pwa-icons.ts\n','pwa-icons module start');
const iEnd=once(input,'\n// src/pwa.ts\n','pwa module start')+1;
const iconsOld=input.slice(iStart,iEnd);
if(!/^\/\/ src\/pwa-icons\.ts\nvar ICONS = \{\n/.test(iconsOld))throw Error('Unexpected pwa-icons module');
for(const k of Object.keys(OLD_TO_NEW))if(!iconsOld.includes(`  "${k}": "`))throw Error('Release icon missing: '+k);
const iconsNew='// src/pwa-icons.ts\nvar ICONS = {\n'+[...entries,...aliases].join(',\n')+'\n};\n\n';

// 2. PWA module text patches.
// The bundle has two "// src/api/v1.ts" markers; the PWA module ends at the first one after it.
const pEnd=input.indexOf('\n// src/api/v1.ts\n',iEnd)+1;
if(pEnd<=iEnd||!input.slice(iEnd,pEnd).includes('function servePwa(path)'))throw Error('Unexpected pwa module end');
let pwa=input.slice(iEnd,pEnd);const pwaOld=pwa;
const PWA_PATCHES=[
 ['manifest any-purpose 192','{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" }','{ src: "/icons/app-icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" }'],
 ['manifest any-purpose 512','{ src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" }','{ src: "/icons/app-icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" }'],
 ['manifest maskable 512','{ src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }','{ src: "/icons/app-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }'],
 ['shell cache name','var SHELL_CACHE = "al-shell-v1";','var SHELL_CACHE = "al-shell-v2";'],
 ['shell paths','"/icons/icon-192.png", "/icons/apple-180.png"]','"/icons/app-icon-192.png", "/icons/app-apple-180.png"]'],
];
for(const [name,a,b] of PWA_PATCHES){const i=once(pwa,a,name);pwa=pwa.slice(0,i)+b+pwa.slice(i+a.length);}

// 3. APP_HTML icon links (the UI module precedes the PWA modules).
const uStart=once(input,'// src/ui.ts\n','ui module start');
if(uStart>=iStart)throw Error('Unexpected module order');
const HTML_PATCHES=[
 ['favicon link','<link rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192.png">','<link rel="icon" type="image/png" sizes="192x192" href="/icons/app-icon-192.png">'],
 ['apple-touch-icon link','<link rel="apple-touch-icon" href="/icons/apple-180.png">','<link rel="apple-touch-icon" href="/icons/app-apple-180.png">'],
];
let head=input.slice(0,iStart);const headOld=head;
const htmlRegions=[];
for(const [name,a,b] of HTML_PATCHES){const i=once(head,a,name,uStart);htmlRegions.push(i);head=head.slice(0,i)+b+head.slice(i+a.length);}

const out=head+iconsNew+pwa+input.slice(pEnd);
// Preservation checks on the output by content: only the listed spans differ.
if(!out.endsWith(input.slice(pEnd)))throw Error('Bytes after the PWA module changed');
const firstHtml=Math.min(...htmlRegions);
if(out.slice(0,firstHtml)!==input.slice(0,firstHtml))throw Error('Bytes before the icon links changed');
const strip=(s)=>HTML_PATCHES.reduce((t,[,a,b])=>t.replace(b,a),s);
if(strip(head)!==headOld)throw Error('UI module changed beyond the icon links');
if(PWA_PATCHES.reduce((t,[,a,b])=>t.replace(b,a),pwa)!==pwaOld)throw Error('PWA module changed beyond the listed patches');
writeFileSync('src/index.js',out);
const meta={base_ui_fixes_sha256:UI_FIXES,integrated_sha256:sha(out),
 preserved_prefix_sha256:sha(input.slice(0,firstHtml)),preserved_suffix_sha256:sha(input.slice(pEnd)),
 pwa_icons_module_sha256:{ui_fixes:sha(iconsOld),candidate:sha(iconsNew)},
 pwa_module_sha256:{ui_fixes:sha(pwaOld),candidate:sha(pwa)},
 icons_sha256:Object.fromEntries(Object.entries(FILES).map(([k,b])=>[k,sha(b)])),
 old_urls_serve:OLD_TO_NEW,
 patches:[...PWA_PATCHES,...HTML_PATCHES].map(([n])=>n)};
writeFileSync('icon-fixes-preservation.json',JSON.stringify(meta,null,2)+'\n');
console.log(JSON.stringify(meta,null,1));
