import {createHash} from 'node:crypto';
import {readFile,stat} from 'node:fs/promises';
import {runVisualFfmpeg} from '../lib/renderVisualQuality.js';

export interface FullFrozenAudioAudit {
  status:'matched'|'failed'|'unknown';
  finalSha256:string; frozenSha256:string;
  checkedWindows:number; voicedWindows:number; failedWindowIndexes:number[];
  reason:string;
}
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const unknown=(finalSha256:string,frozenSha256:string,reason:string):FullFrozenAudioAudit=>({status:'unknown',finalSha256,frozenSha256,checkedWindows:0,voicedWindows:0,failedWindowIndexes:[],reason});
function rms(bytes:Buffer,start:number,end:number){let sum=0;for(let i=start;i<end;i+=2){const sample=bytes.readInt16LE(i);sum+=sample*sample;}return Math.sqrt(sum/Math.max(1,(end-start)/2));}
function correlation(a:Buffer,b:Buffer,start:number,end:number):number|null{
 let best=-2;
 // Decode delay is global. Small AAC mux offsets are tolerated, but each
 // independent window must match rather than borrowing a good midpoint.
 for(let shift=-960;shift<=960;shift+=40){
  let dot=0,aa=0,bb=0;
  const first=Math.max(start,-shift),last=Math.min(end,a.length/2,b.length/2-shift);
  for(let i=first;i<last;i+=4){const x=a.readInt16LE(i*2),y=b.readInt16LE((i+shift)*2);dot+=x*y;aa+=x*x;bb+=y*y;}
  if(aa>1e8&&bb>1e8)best=Math.max(best,dot/Math.sqrt(aa*bb));
 }
 return best===-2?null:best;
}
/** Full-track waveform identity, not lip sync or spoken-content recognition. */
export async function auditFullFrozenAudio(input:{finalPath:string;frozenPath:string;expectedFinalSha256:string;expectedFrozenSha256:string;durationSeconds:number}):Promise<FullFrozenAudioAudit>{
 const [finalStat,frozenStat]=await Promise.all([stat(input.finalPath),stat(input.frozenPath)]);
 if(!Number.isFinite(input.durationSeconds)||input.durationSeconds<=0||input.durationSeconds>45||finalStat.size>1024*1024*1024||frozenStat.size>256*1024*1024)return unknown('','','全音轨核验超出有界时长或媒体大小');
 const [finalBytes,frozenBytes]=await Promise.all([readFile(input.finalPath),readFile(input.frozenPath)]);
 const finalSha256=digest(finalBytes),frozenSha256=digest(frozenBytes);
 const fail=(reason:string)=>unknown(finalSha256,frozenSha256,reason);
 if(finalSha256!==input.expectedFinalSha256||frozenSha256!==input.expectedFrozenSha256)return fail('最终 MP4 或冻结主音轨字节与已冻结 SHA 不一致');
 const decode=(source:string)=>runVisualFfmpeg(['-i',source,'-map','0:a:0','-vn','-ac','1','-ar','8000','-f','s16le','pipe:1'],true,{timeoutMs:120000});
 const [finalPcm,frozenPcm]=await Promise.all([decode(input.finalPath),decode(input.frozenPath)]);
 if(!finalPcm.ok||!frozenPcm.ok||!finalPcm.stdout.length||!frozenPcm.stdout.length||finalPcm.stdout.length%2||frozenPcm.stdout.length%2)return fail('完整 PCM 音轨不可解码');
 const a=frozenPcm.stdout,b=finalPcm.stdout,expectedSamples=Math.round(input.durationSeconds*8000);
 if(Math.abs(a.length/2-expectedSamples)>960||Math.abs(b.length/2-expectedSamples)>960||Math.abs(a.length-b.length)>1920)return fail('冻结音轨与最终音轨时长超出 120ms 容差');
 let voicedWindows=0;const failedWindowIndexes:number[]=[];
 const windows=Math.ceil(expectedSamples/8000);
 for(let index=0;index<windows;index++){
  const start=index*8000,end=Math.min(expectedSamples,(index+1)*8000),startByte=start*2,endByte=Math.min(end*2,a.length,b.length);
  if(endByte-startByte<3200)return fail('末端音频窗口不足以核验');
  const frozenRms=rms(a,startByte,endByte),outputRms=rms(b,startByte,endByte);
  if(frozenRms<40&&outputRms<40)continue;
  voicedWindows++;
  if(frozenRms<40||outputRms<40||(correlation(a,b,start,end)??-1)<0.9)failedWindowIndexes.push(index);
 }
 const [finalAfter,frozenAfter]=await Promise.all([readFile(input.finalPath),readFile(input.frozenPath)]);
 if(digest(finalAfter)!==finalSha256||digest(frozenAfter)!==frozenSha256)return fail('完整 PCM 测量期间媒体字节发生变化');
 if(!voicedWindows)return fail('冻结音轨没有可辨识的有声窗口');
 return {status:failedWindowIndexes.length?'failed':'matched',finalSha256,frozenSha256,checkedWindows:windows,voicedWindows,failedWindowIndexes,reason:failedWindowIndexes.length?'最终 MP4 至少一个完整时间窗的声学波形与冻结主音轨明显不一致':'冻结主音轨与最终 MP4 在全部有声时间窗声学一致；未证明口型同步、语音内容转写或隐私'};
}
