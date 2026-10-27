// Rebuild ONLY publisher handling inside the byte-pinned baseline Worker (baseline/index.js: the deployed
// release with installation-specific values replaced by neutral defaults; see CONTRIBUTING.md).
// No production config, credentials, database or external network is used.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const esbuild=require(process.env.HB_ESBUILD_MODULE || 'esbuild');
if(esbuild.version!=='0.28.2')throw Error('Use reviewed esbuild 0.28.2');
const {build}=esbuild;
const sha=b=>createHash('sha256').update(b).digest('hex');
const baseline=readFileSync('baseline/index.js','utf8');
if(sha(baseline)!=='da3ffeeaeacbbcf6c9dcac8e323e90ead9b0b8bd8270e38cd268f89e80ae5571')throw Error('Baseline hash changed');
const shared={
 '../auth':['rateLimit','limitsFor','authzSql'],
 '../formats':['checkFile','MIME','CONTENT_TYPE','byteLength'],
 '../links':['appOrigin','artifactWebUrl','previewWebUrl'],
 '../service':['idemLookup','LIMITS'],
 '../util':['errorBody','HttpError','idemKey','int','json','nowIso','randomId','sha256Hex','str'],
 '../oauth/server':['livePublisher','SCOPES'],
};
const result=await build({entryPoints:['src/api/publisher.ts'],bundle:true,write:false,format:'iife',globalName:'__appConnectPublisher',target:'es2022',platform:'neutral',plugins:[{
 name:'pinned-worker-shared-bindings',setup(b){
  b.onResolve({filter:/^\.\.\//},args=>shared[args.path]?{path:args.path,namespace:'live-shared'}:undefined);
  b.onLoad({filter:/.*/,namespace:'live-shared'},args=>({contents:shared[args.path].map(n=>`const live_${n}=${n};export {live_${n} as ${n}};`).join('\n'),loader:'js'}));
 }
}]});
const start=baseline.indexOf('// src/api/publisher.ts\n');
const end=baseline.indexOf('// src/oauth/server.ts\n',start);
if(start<0||end<=start)throw Error('Publisher boundaries missing');
const old=baseline.slice(start,end);
if(!old.includes('var init_publisher = __esm({')||!old.includes('init_server();'))throw Error('Unexpected publisher module');
const replacement=`// src/api/publisher.ts — isolated readable-generation integration\nvar handlePublisherApi;\nvar init_publisher = __esm({\n "src/api/publisher.ts"() {\n init_auth();init_formats();init_links();init_service();init_util();init_server();\nlet implementation;\n handlePublisherApi=async (req,env,ctx)=>{if(!implementation){\n${result.outputFiles[0].text}\nimplementation=__appConnectPublisher.handlePublisherApi;}return implementation(req,env,ctx);};\n }\n});\n\n`;
const integrated=baseline.slice(0,start)+replacement+baseline.slice(end);
// Exact preservation, stronger than a source-only rebuild or list of intended changes.
if(integrated.slice(0,start)!==baseline.slice(0,start)||integrated.slice(start+replacement.length)!==baseline.slice(end))throw Error('Unrelated bundle bytes changed');
writeFileSync('src/index.js',integrated);
writeFileSync('bundle-preservation.json',JSON.stringify({baseline_sha256:sha(baseline),integrated_sha256:sha(integrated),preserved_prefix_sha256:sha(baseline.slice(0,start)),preserved_suffix_sha256:sha(baseline.slice(end)),unchanged_outside_publisher:true,replaced_module:'src/api/publisher.ts',esbuild_version:'0.28.2'},null,2)+'\n');
console.log('Integrated publisher; every byte outside its module is unchanged');
