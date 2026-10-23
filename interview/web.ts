import {createServer} from 'node:http';import fs from 'node:fs/promises';import path from 'node:path';
import {snapshot,scan,executeLocal,local} from './control.js';
import {pbStore} from '../server/storage/pbStore.js';
import {createStarter198Repository} from '../server/starter198/repository.js';
import {openSocialArtifactPreviewMedia} from '../server/starter198/socialArtifactMedia.js';
const html=await fs.readFile(new URL('./public/index.html',import.meta.url));
let busy=false;
const server=createServer(async(req,res)=>{
 const send=(status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value))};
 try{
 const url=new URL(req.url??'/','http://localhost');
 if(req.method==='GET'&&url.pathname==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html);return;}
 if(req.method==='GET'&&url.pathname==='/api/state')return send(200,await snapshot());
 if(req.method==='GET'&&url.pathname==='/api/media'){
  const state=await snapshot();const artifact=state.artifacts.find((a:any)=>a.artifact_id===url.searchParams.get('artifactId')&&a.tenant_id==='t');if(!artifact)return send(404,{error:'artifact_not_found'});
  // Reuse the original artifact/file resolver: storage keys are not filesystem paths.
  const media=await local(()=>openSocialArtifactPreviewMedia({repository:createStarter198Repository(pbStore),tenantId:'t',taskId:artifact.task_id,artifactId:artifact.artifact_id}));
  const chunks:Uint8Array[]=[];for await(const chunk of media.body)chunks.push(chunk);const bytes=Buffer.concat(chunks);
  res.writeHead(200,{'Content-Type':'video/mp4','Content-Length':bytes.length,...(url.searchParams.get('download')==='1'?{'Content-Disposition':'attachment; filename="interview-output.mp4"'}:{})});res.end(bytes);return;
 }
 if(req.method==='POST'&&['/api/scan','/api/render'].includes(url.pathname)){
  if(busy)return send(409,{error:'sandbox_operation_busy'});busy=true;try{return send(200,url.pathname==='/api/scan'?await scan():await executeLocal())}finally{busy=false}
 }
 send(404,{error:'not_found'});
 }catch(error){send(500,{error:error instanceof Error?error.message:String(error)})}
});
server.listen(Number(process.env.PORT??4318),'127.0.0.1',()=>console.log('http://127.0.0.1:'+String(process.env.PORT??4318)));
process.on('SIGINT',()=>server.close(()=>process.exit(0)));process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
