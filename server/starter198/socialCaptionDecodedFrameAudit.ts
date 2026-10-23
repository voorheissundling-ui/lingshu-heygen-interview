import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {spawn} from 'node:child_process';
import {runVisualFfmpeg} from '../lib/renderVisualQuality.js';
import {recognizeProductImageLocally} from '../lib/localProductOcr.js';
import ffmpegStatic from 'ffmpeg-static';
import {inspectSensitiveScreenText} from './socialSceneSensitiveScreenAudit.js';

export interface CaptionDecodedFrameAudit {
 status:'observed_all_decoded_frames'|'unknown';
 mediaSha256:string;
 decodedFrameCount:number;
 checkedFrameCount:number;
 missingFrameIndexes:number[];
 sensitiveFindingFrameIndexes:number[];
 sensitiveFindingCodes:Array<'resident_identity_number'|'private_key_marker'>;
 frames:Array<{index:number;pts:number;timeBase:string;frameSha256:string;ocrSha256:string;findingCodes:Array<'resident_identity_number'|'private_key_marker'>}>;
 reason:string;
}

const PNG_SIGNATURE=Buffer.from([137,80,78,71,13,10,26,10]);
/** Streams one bounded PNG at a time; awaiting the callback back-pressures ffmpeg. */
export async function forEachDecodedPng(filePath:string,visit:(png:Buffer,index:number)=>Promise<void>,region?:{x:number;y:number;width:number;height:number}):Promise<number>{
 if(!ffmpegStatic)throw Error('ffmpeg_unavailable');
 const crop=region?`crop=iw*${region.width}:ih*${region.height}:iw*${region.x}:ih*${region.y},`:'';
 const child=spawn(String(ffmpegStatic),['-hide_banner','-loglevel','error','-nostdin','-i',filePath,'-map','0:v:0','-an','-vsync','0','-vf',`${crop}scale='min(960,iw)':-2`,'-f','image2pipe','-vcodec','png','pipe:1'],{stdio:['ignore','pipe','pipe']});
 let stderr='',buffer=Buffer.alloc(0),index=0;
 child.stderr.on('data',chunk=>{stderr=(stderr+String(chunk)).slice(-2048);});
 const closed=new Promise<number>((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve(code??-1));});
 const timer=setTimeout(()=>child.kill('SIGKILL'),20*60_000);
 try{
  for await(const chunk of child.stdout){
   buffer=Buffer.concat([buffer,chunk]);
   while(buffer.length>=8){
    if(!buffer.subarray(0,8).equals(PNG_SIGNATURE))throw Error('decoded_png_signature_invalid');
    let offset=8,complete=false;
    while(offset+12<=buffer.length){
     const length=buffer.readUInt32BE(offset);
     if(length>8*1024*1024)throw Error('decoded_png_chunk_over_limit');
     const end=offset+12+length;
     if(end>8*1024*1024)throw Error('decoded_png_frame_over_limit');
     if(end>buffer.length)break;
     const type=buffer.toString('ascii',offset+4,offset+8);
     offset=end;
     if(type==='IEND'){complete=true;break;}
    }
    if(!complete){if(buffer.length>8*1024*1024)throw Error('decoded_png_frame_over_limit');break;}
    await visit(buffer.subarray(0,offset),index++);
    buffer=buffer.subarray(offset);
   }
  }
  const code=await closed;
  if(code!==0||buffer.length)throw Error(`decoded_png_stream_incomplete:${code}:${stderr}`);
  return index;
 }catch(error){child.kill('SIGKILL');await closed.catch(()=>{});throw error;}finally{clearTimeout(timer);}
}

const normalize=(value:string)=>value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const unknown=(mediaSha256:string,reason:string,decodedFrameCount=0,checkedFrameCount=0,missingFrameIndexes:number[]=[],frames:CaptionDecodedFrameAudit['frames']=[]):CaptionDecodedFrameAudit=>({status:'unknown',mediaSha256,decodedFrameCount,checkedFrameCount,missingFrameIndexes,sensitiveFindingFrameIndexes:frames.flatMap(frame=>frame.findingCodes.length?[frame.index]:[]),sensitiveFindingCodes:[...new Set(frames.flatMap(frame=>frame.findingCodes))].sort(),frames,reason});
async function fileSha256(filePath:string):Promise<string>{
 const digest=createHash('sha256');
 for await(const chunk of createReadStream(filePath))digest.update(chunk);
 return digest.digest('hex');
}

/**
 * Exhaustively observes a *bounded* final-MP4 decode, not a subtitle pass.
 * Optional ROI excludes unrelated text outside an independently known subtitle
 * region, but even cropped OCR can match scene text within that region and miss
 * partial/occluded glyphs. The caller must never promote this to G4 passed.
 */
export async function auditCaptionDecodedFrames(input:{filePath:string;cues:Array<{start:number;end:number;text:string}>;maxFrames?:number;maxDurationSeconds?:number;region?:{x:number;y:number;width:number;height:number};recognize?:typeof recognizeProductImageLocally}):Promise<CaptionDecodedFrameAudit>{
 const mediaSha256=await fileSha256(input.filePath);
 const maxFrames=Math.min(1800,Math.max(1,Math.floor(input.maxFrames??1500)));
 const maxDurationSeconds=Math.min(60,Math.max(0.1,input.maxDurationSeconds??45));
 const region=input.region;
 if(region&&(![region.x,region.y,region.width,region.height].every(Number.isFinite)||region.x<0||region.y<0||region.width<=0||region.height<=0||region.x+region.width>1||region.y+region.height>1))return unknown(mediaSha256,'字幕 ROI 不合法；未执行有界逐帧检查');
 if(!input.cues.length||input.cues.some(c=>!Number.isFinite(c.start)||!Number.isFinite(c.end)||c.start<0||c.end<=c.start||c.end>maxDurationSeconds||normalize(c.text).length<4))return unknown(mediaSha256,'冻结 cue 缺失、无效或超出有界逐帧检查时长');
 const framehash=await runVisualFfmpeg(['-i',input.filePath,'-map','0:v:0','-an','-vsync','0','-f','framehash','pipe:1'],true,{timeoutMs:120000});
 if(!framehash.ok)return unknown(mediaSha256,`完整帧枚举失败：${framehash.stderr.slice(0,120)}`);
 const text=framehash.stdout.toString('utf8');
 const timeBase=text.match(/^#tb 0: (\d+\/\d+)$/m)?.[1];
 const rows=text.split(/\r?\n/).filter(line=>/^0,/.test(line)).map(line=>line.split(',').map(part=>part.trim()));
 if(!timeBase||!rows.length||rows.length>maxFrames||rows.some(row=>row.length<6||!/^\d+$/.test(row[1]??'')||!/^\d+$/.test(row[2]??'')))return unknown(mediaSha256,'逐帧 PTS 枚举不完整、无效或超过有界帧数',rows.length);
 const [num,den]=timeBase.split('/').map(Number);
 if(!num||!den||rows.some((row,index)=>index>0&&Number(row[2])<=Number(rows[index-1]![2]))||Number(rows.at(-1)![2])*num/den>maxDurationSeconds)return unknown(mediaSha256,'逐帧 PTS 不单调或超过有界时长',rows.length);
 try{
  const frames:CaptionDecodedFrameAudit['frames']=[],missingFrameIndexes:number[]=[];
  const decoded=await forEachDecodedPng(input.filePath,async(bytes,index)=>{
   if(index>=rows.length)throw Error('decoded_frame_count_exceeds_enumeration');
   const pts=Number(rows[index]![2]),seconds=pts*num/den;
   const cue=input.cues.find(c=>seconds>=c.start-0.001&&seconds<c.end-0.001);
   const ocr=await (input.recognize??recognizeProductImageLocally)({bytes,mimeType:'image/png'});
   if(cue&&!normalize(ocr).includes(normalize(cue.text)))missingFrameIndexes.push(index);
   frames.push({index,pts,timeBase,frameSha256:createHash('sha256').update(bytes).digest('hex'),ocrSha256:createHash('sha256').update(ocr).digest('hex'),findingCodes:inspectSensitiveScreenText(ocr)});
  },region);
  if(decoded!==rows.length)return unknown(mediaSha256,'枚举与流式解码帧数不一致',rows.length,decoded,missingFrameIndexes,frames);
  if(await fileSha256(input.filePath)!==mediaSha256)return unknown(mediaSha256,'逐帧检查期间最终 MP4 字节发生变化；原观察不得用于当前成片',rows.length,frames.length,missingFrameIndexes,frames);
  if(missingFrameIndexes.length)return unknown(mediaSha256,'至少一帧未能观察到冻结字幕；OCR 不能独立判定字幕缺失',rows.length,frames.length,missingFrameIndexes,frames);
  return {status:'observed_all_decoded_frames',mediaSha256,decodedFrameCount:rows.length,checkedFrameCount:frames.length,missingFrameIndexes,sensitiveFindingFrameIndexes:frames.flatMap(frame=>frame.findingCodes.length?[frame.index]:[]),sensitiveFindingCodes:[...new Set(frames.flatMap(frame=>frame.findingCodes))].sort(),frames,reason:'最终 MP4 的有界全解码帧均观察到对应文字；OCR（即使限于字幕 ROI）不证明字形来自字幕、无遮挡，也不能作为 G4 自动通过'};
 }catch(error){return unknown(mediaSha256,`流式逐帧核验中断：${String(error)}`,rows.length);}
}
