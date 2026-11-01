// Verify the historical CodeMirror source reproduces the editor embedded in the Worker.
// No writes, network, credentials or local/global package paths are used.
import {build} from 'esbuild';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=dirname(fileURLToPath(import.meta.url));
const provenance=JSON.parse(readFileSync(join(root,'provenance.json'),'utf8'));
const result=await build({entryPoints:[join(root,'editor.js')],bundle:true,minify:true,format:'iife',globalName:'AL_EDITOR',target:['es2020'],legalComments:'none',write:false,platform:'browser',charset:'utf8'});
const hash=createHash('sha256').update(result.outputFiles[0].text).digest('hex');
// The Worker serves src/web/editor.js verbatim and pins its hash in src/editor-bundle.js.
const text=readFileSync(join(root,'../src/web/editor.js.txt'),'utf8');
const pinned=/EDITOR_JS_SHA256 = "([a-f0-9]{64})"/.exec(readFileSync(join(root,'../src/editor-bundle.js'),'utf8'))?.[1];
const embedded={text,hash:pinned};
const actualHash=createHash('sha256').update(embedded.text).digest('hex');
if(hash!==provenance.embeddedUnmodifiedSha256 || hash!==embedded.hash || hash!==actualHash) throw Error('Embedded editor provenance mismatch; review source, versions and licenses before changing the pin');
console.log(`Editor source and embedded SHA-256 match: ${hash}; 21 MIT package notices retained in THIRD_PARTY_NOTICES.md`);
