// Synthetic Google endpoints. No owner data, credentials or live Google calls.
import {createServer} from 'node:http';
import {AUX_PORTS} from '../ports.mjs';
export async function driveFixture(){
 const files=new Map();let reads=0;const calls=[];
 const server=createServer(async (req,res)=>{
  calls.push({method:req.method,path:req.url});
  if(req.method!=='GET'){res.writeHead(405);return res.end();}
  const token=req.headers.authorization;
  if(!['Bearer synthetic-drive-a','Bearer synthetic-drive-b'].includes(token)){res.writeHead(401);return res.end();}
  const url=new URL(req.url,'http://fixture.invalid');
  if(url.pathname==='/drive/v3/about'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({user:{permissionId:token.endsWith('-b')?'account-b':'account-a',emailAddress:token.endsWith('-b')?'b@example.test':'a@example.test'}}));}
  const match=/^\/drive\/v3\/files\/([\w-]+)(\/export)?$/.exec(url.pathname);const f=match&&files.get(match[1]);
  if(!f){res.writeHead(404);return res.end();}
  if(f.fail){res.writeHead(f.fail);return res.end();}
  if(url.searchParams.get('alt')==='media'||match[2]){
   reads++;if(f.changeDuringRead)f.version=String(Number(f.version)+1);
   res.setHeader('content-type',url.searchParams.get('mimeType')||f.mimeType);return res.end(f.bytes);
  }
  if(f.metadataGate){const gate=f.metadataGate;delete f.metadataGate;f.onMetadata?.();await gate;}
  res.setHeader('content-type','application/json');res.end(JSON.stringify({id:match[1],name:f.name,mimeType:f.mimeType,size:f.native?undefined:String(f.declaredSize??f.bytes.length),version:f.version||'1',modifiedTime:'2026-01-01T00:00:00.000Z',capabilities:{canDownload:f.canDownload!==false}}));
 });
 await new Promise(r=>server.listen(AUX_PORTS.driveGoogle,'127.0.0.1',r));
 return {files,calls,get reads(){return reads;},origin:'http://127.0.0.1:'+AUX_PORTS.driveGoogle,stop:()=>new Promise(r=>server.close(r))};
}
