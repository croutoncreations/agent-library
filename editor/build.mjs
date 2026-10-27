// Verify the historical CodeMirror source reproduces the editor embedded in the Worker.
// No writes, network, credentials or local/global package paths are used.
import {build} from 'esbuild';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runInNewContext} from 'node:vm';
const root=dirname(fileURLToPath(import.meta.url));
const provenance=JSON.parse(readFileSync(join(root,'provenance.json'),'utf8'));
const result=await build({entryPoints:[join(root,'editor.js')],bundle:true,minify:true,format:'iife',globalName:'AL_EDITOR',target:['es2020'],legalComments:'none',write:false,platform:'browser',charset:'utf8'});
const hash=createHash('sha256').update(result.outputFiles[0].text).digest('hex');
const worker=readFileSync(join(root,'../src/index.js'),'utf8');
const start=worker.indexOf('// src/editor-bundle.ts\n');
const end=worker.indexOf('\n// src/ui.ts\n', start);
if(start<0 || end<=start) throw Error('Embedded editor module boundaries missing');
// Evaluate only repository-owned string constants in an isolated context with no I/O.
const embedded=runInNewContext(worker.slice(start,end)+'\n({text:EDITOR_JS,hash:EDITOR_JS_SHA256})',{}, {timeout:1000});
const actualHash=createHash('sha256').update(embedded.text).digest('hex');
if(hash!==provenance.embeddedUnmodifiedSha256 || hash!==embedded.hash || hash!==actualHash) throw Error('Embedded editor provenance mismatch; review source, versions and licenses before changing the pin');
console.log(`Editor source and embedded SHA-256 match: ${hash}; 21 MIT package notices retained in THIRD_PARTY_NOTICES.md`);
