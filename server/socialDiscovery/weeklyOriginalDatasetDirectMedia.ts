import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createVideoDownloaderPythonResolver} from '../lib/videoDownloaderPython.js';
import {sourceAccountFromVideoUrl,videoSourceIdentity} from '../routes/videoSourceIdentity.js';

const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const fail=(code:string):never=>{throw Error(`weekly_original_dataset_direct_media_${code}`);};
const trusted=(value:string)=>{try{const u=new URL(value),h=u.hostname.toLowerCase();return u.protocol==='https:'&&['tiktok.com','tiktokcdn.com','tiktokcdn-us.com','tiktokv.com','byteoversea.com','ibytedtos.com','muscdn.com'].some(s=>h===s||h.endsWith('.'+s))&&!['www.tiktok.com','m.tiktok.com'].includes(h)?u:null;}catch{return null;}};
const isMp4=(bytes:Buffer)=>bytes.length>=12&&bytes.subarray(4,8).toString('ascii')==='ftyp';
const executeFile=promisify(execFile);
const ytDlpPythonPath=createVideoDownloaderPythonResolver();
export interface StagedWeeklyOriginalDatasetMedia {videoId:string;datasetId:string;providerRunId:string;sourceUrlSha256:string;contentSha256:string;byteLength:number;filePath:string;receiptPath:string}
function mediaUrlCandidates(item:Record<string,unknown>):unknown[]{const meta=item.videoMeta&&typeof item.videoMeta==='object'&&!Array.isArray(item.videoMeta)?item.videoMeta as Record<string,unknown>:{};const flatten=(value:unknown):unknown[]=>Array.isArray(value)?value.flatMap(flatten):value&&typeof value==='object'&&!Array.isArray(value)?Object.values(value as Record<string,unknown>).flatMap(flatten):[value];return [meta.downloadAddr,meta.downloadUrl,item.downloadAddr,item.downloadUrl,item.videoDownloadUrl,item.mediaUrls,item.videoUrl].flatMap(flatten);}
export function weeklyOriginalDatasetDirectMediaUrl(item:Record<string,unknown>):string|null{for(const value of mediaUrlCandidates(item)){if(typeof value!=='string'||value.length<12||value.length>8192)continue;const url=trusted(value);if(url&&!/^\/@[^/]+\/video\/\d+\/?$/.test(url.pathname))return url.toString();}return null;}

/** Downloads an uncharged short-lived CDN object immediately after its exact
 * Dataset row was journaled. The immutable sidecar makes a restart reuse the
 * verified bytes; it never treats an HTML page or arbitrary redirect as MP4. */
export async function stageWeeklyOriginalDatasetDirectMedia(input:{mediaRoot:string;tenantId:string;jobId:string;providerRunId:string;datasetId:string;accountUrl:string;row:Record<string,unknown>;fetcher?:typeof fetch;maximumBytes?:number;executeDownload?:typeof executeFile}):Promise<StagedWeeklyOriginalDatasetMedia>{
 const videoId=String(input.row.id??input.row.videoId??''),pageUrl=String(input.row.webVideoUrl??input.row.url??input.row.shareUrl??''),direct=weeklyOriginalDatasetDirectMediaUrl(input.row),source=direct??pageUrl,maximum=input.maximumBytes??100*1024*1024;
 if(!/^[A-Za-z0-9_-]{5,80}$/.test(input.tenantId)||!/^\d{8,30}$/.test(videoId)||!source||videoSourceIdentity('tiktok',pageUrl)!==`tiktok:id:${videoId}`||sourceAccountFromVideoUrl('tiktok',pageUrl)!==input.accountUrl||!input.jobId||!input.providerRunId||!input.datasetId||!Number.isSafeInteger(maximum)||maximum<32)return fail('scope_invalid');
 const base=path.resolve(input.mediaRoot,'tenants',input.tenantId,'reference-videos','.dataset-direct',sha([input.jobId,input.providerRunId,input.datasetId].join('\0'))),filePath=path.join(base,`${videoId}.mp4`),receiptPath=path.join(base,`${videoId}.json`),sourceUrlSha256=sha(source);
 await fs.mkdir(base,{recursive:true,mode:0o700});
 const prior=await fs.readFile(receiptPath,'utf8').then(JSON.parse).catch(()=>null) as StagedWeeklyOriginalDatasetMedia|null;
 if(prior){const bytes=await fs.readFile(filePath).catch(()=>null);if(prior.videoId!==videoId||prior.datasetId!==input.datasetId||prior.providerRunId!==input.providerRunId||prior.sourceUrlSha256!==sourceUrlSha256||prior.filePath!==filePath||prior.receiptPath!==receiptPath||!bytes||bytes.length!==prior.byteLength||sha(bytes)!==prior.contentSha256||!isMp4(bytes))return fail('receipt_changed');return prior;}
 let bytes:Buffer;
 if(direct){
  const fetcher=input.fetcher??fetch;let current=direct,response:Response|null=null;
  for(let redirects=0;redirects<=3;redirects++){
   if(!trusted(current))return fail('redirect_untrusted');
   response=await fetcher(current,{redirect:'manual',signal:AbortSignal.timeout(30_000),headers:{Accept:'video/mp4,video/*;q=0.9'}});
   if(response.status>=300&&response.status<400){const location=response.headers.get('location');if(!location)return fail('redirect_invalid');current=new URL(location,current).toString();continue;}break;
  }
  if(!response||response.status!==200||!response.body||!trusted(response.url||current))return fail('response_invalid');
  const declared=Number(response.headers.get('content-length')||0);if(declared>maximum)return fail('too_large');
  const chunks:Buffer[]=[];let length=0,reader=response.body.getReader();try{for(;;){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>maximum)return fail('too_large');chunks.push(Buffer.from(part.value));}}finally{await reader.cancel().catch(()=>undefined);}bytes=Buffer.concat(chunks,length);
 }else{
  const downloadBase=filePath+'.download',template=downloadBase+'.%(ext)s',run=input.executeDownload??executeFile;
  await run(ytDlpPythonPath(),['-m','yt_dlp','--no-playlist','--no-warnings','--max-filesize',String(maximum),'-f','best[ext=mp4]/best','-o',template,pageUrl],{timeout:120_000,maxBuffer:4*1024*1024});
  const candidates=(await fs.readdir(base)).filter(name=>name.startsWith(path.basename(downloadBase)+'.')&&!name.endsWith('.part'));
  if(candidates.length!==1)return fail('downloader_output_invalid');const downloaded=path.join(base,candidates[0]!);bytes=await fs.readFile(downloaded);await fs.unlink(downloaded);
 }
 if(bytes.length>maximum)return fail('too_large');if(!isMp4(bytes))return fail('not_mp4');
 const temp=filePath+'.'+randomUUID()+'.tmp',handle=await fs.open(temp,'wx',0o600);try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}await fs.rename(temp,filePath);
 const result:StagedWeeklyOriginalDatasetMedia={videoId,datasetId:input.datasetId,providerRunId:input.providerRunId,sourceUrlSha256,contentSha256:sha(bytes),byteLength:bytes.length,filePath,receiptPath};
 const receiptTemp=receiptPath+'.'+randomUUID()+'.tmp',receipt=await fs.open(receiptTemp,'wx',0o600);try{await receipt.writeFile(JSON.stringify(result));await receipt.sync();}finally{await receipt.close();}await fs.rename(receiptTemp,receiptPath);const directory=await fs.open(base,'r');try{await directory.sync();}finally{await directory.close();}return result;
}
