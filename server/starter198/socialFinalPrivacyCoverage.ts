import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import ffmpegStatic from 'ffmpeg-static';

/** Decode coverage only. A complete decode is not a finding of privacy safety. */
export interface SocialFinalPrivacyCoverage {
  schemaVersion:'final-privacy-coverage.v1'; finalMp4Sha256:string;
  detectorVersion:'decode-coverage.v1'; status:'observed'|'unknown';
  /** A measured defect in the final file, unlike missing independent evidence. */
  failureCode?:'full_stream_decode_failed'|'media_streams_invalid'|'video_frames_invalid'|'audio_samples_invalid'|'frozen_speech_audio_silent'|'frame_count_mismatch'|'media_duration_mismatch'|'media_bytes_changed';
  video:{streamCount:number;decodedFrames:number;firstPtsSeconds:number|null;lastPtsSeconds:number|null;monotonicPts:boolean};
  audio:{streamCount:number;decodedSamples:number;decodedSeconds:number};
  reason:string;
}

export function hasKnownFinalMediaCoverageFailure(value:unknown):boolean {
 const result=value as Partial<SocialFinalPrivacyCoverage>|null;
 return result?.schemaVersion==='final-privacy-coverage.v1'&&result.status==='unknown'&&[
  'full_stream_decode_failed','media_streams_invalid','video_frames_invalid','audio_samples_invalid','frozen_speech_audio_silent',
  'frame_count_mismatch','media_duration_mismatch','media_bytes_changed',
 ].includes(String(result.failureCode));
}

function ffmpeg(args:string[],onLine?:(line:string)=>void,onOutput?:(chunk:Buffer)=>void):Promise<{ok:boolean;bytes:number;stderr:string}>{
 return new Promise(resolve=>{
  if(!ffmpegStatic)return resolve({ok:false,bytes:0,stderr:'ffmpeg unavailable'});
  const child=spawn(String(ffmpegStatic),['-hide_banner','-nostdin','-loglevel','info',...args],{stdio:['ignore','pipe','pipe']});
  let bytes=0,stderr='',lineBuffer='',settled=false;
  const timer=setTimeout(()=>{child.kill('SIGKILL');finish(false,'privacy_coverage_timeout');},90_000);
  function finish(ok:boolean,message=stderr){if(settled)return;settled=true;clearTimeout(timer);resolve({ok,bytes,stderr:message});}
  child.stdout.on('data',(chunk:Buffer)=>{bytes+=chunk.length;onOutput?.(chunk);if(bytes>180_000_000){child.kill('SIGKILL');finish(false,'privacy_coverage_output_limit');}});
  child.stderr.on('data',(chunk:Buffer)=>{lineBuffer+=String(chunk);let cut:number;while((cut=lineBuffer.indexOf('\n'))>=0){const line=lineBuffer.slice(0,cut);lineBuffer=lineBuffer.slice(cut+1);onLine?.(line);stderr=(stderr+line+'\n').slice(-4096);}if(lineBuffer.length>4096)lineBuffer=lineBuffer.slice(-4096);});
  child.on('error',error=>finish(false,String(error)));
  child.on('close',code=>{if(lineBuffer)onLine?.(lineBuffer);finish(code===0);});
 });
}

export async function probeFinalPrivacyCoverage(input:{filePath:string;expectedDurationSeconds:number;expectedFrames?:number;frozenSpeechExpected?:boolean}):Promise<SocialFinalPrivacyCoverage>{
 const sha=createHash('sha256').update(await readFile(input.filePath)).digest('hex');
 let frames=0,first:number|null=null,last:number|null=null,monotonic=true;
 const duration=input.expectedDurationSeconds;
 const bounded=Number.isFinite(duration)&&duration>0&&duration<=45&&(!input.expectedFrames||input.expectedFrames>0&&input.expectedFrames<=1500);
 let videoStreams=0;
 const unknown=(reason:string,audioStreams=0,audioSamples=0,failureCode?:SocialFinalPrivacyCoverage['failureCode']):SocialFinalPrivacyCoverage=>({schemaVersion:'final-privacy-coverage.v1',finalMp4Sha256:sha,detectorVersion:'decode-coverage.v1',status:'unknown',...(failureCode?{failureCode}:{}),video:{streamCount:videoStreams,decodedFrames:frames,firstPtsSeconds:first,lastPtsSeconds:last,monotonicPts:monotonic},audio:{streamCount:audioStreams,decodedSamples:audioSamples,decodedSeconds:audioSamples/16000},reason});
 if(!bounded)return unknown('媒体时长或帧预算超出受限完整解码范围');
 let audioStreams=0,inInput=false;
 const info=await ffmpeg(['-i',input.filePath,'-f','null','-'],line=>{
  if(/^Input #\d+,/.test(line.trimStart()))inInput=true;
  if(/^Output #\d+,/.test(line.trimStart()))inInput=false;
  if(!inInput)return;
  if(/Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?: Audio:/.test(line))audioStreams++;
  if(/Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?: Video:/.test(line))videoStreams++;
 });
 if(!info.ok)return unknown('最终 MP4 全流解码失败',audioStreams,0,'full_stream_decode_failed');
 if(audioStreams!==1||videoStreams!==1)return unknown('最终 MP4 缺少唯一视频/音频轨或包含额外媒体轨；仅解码第一轨不足以覆盖实际播放',audioStreams,0,'media_streams_invalid');
 const video=await ffmpeg(['-i',input.filePath,'-map','0:v:0','-vf','showinfo','-an','-f','null','-'],line=>{
  const hit=line.match(/showinfo[^\n]*\bn:\s*(\d+)\s+pts:\s*[-\d]+\s+pts_time:\s*([-\d.]+)/);
  if(!hit)return;
  const n=Number(hit[1]),pts=Number(hit[2]);if(!Number.isFinite(pts)||n!==frames||last!==null&&pts<=last)monotonic=false;
  if(first===null)first=pts;last=pts;frames++;
 });
 if(!video.ok||!frames||!monotonic)return unknown('最终 MP4 全帧解码或 PTS 顺序不完整',audioStreams,0,'video_frames_invalid');
 let anyNonzeroPcmByte=false;
 const pcm=await ffmpeg(['-i',input.filePath,'-map','0:a:0','-vn','-ac','1','-ar','16000','-f','s16le','pipe:1'],undefined,chunk=>{if(!anyNonzeroPcmByte)anyNonzeroPcmByte=chunk.some(byte=>byte!==0);});
 const samples=pcm.bytes/2;
 if(!pcm.ok||pcm.bytes%2||!samples)return unknown('最终 MP4 全音轨 PCM 解码失败',audioStreams,samples,'audio_samples_invalid');
 if(input.frozenSpeechExpected&&!anyNonzeroPcmByte)return unknown('冻结口播要求发声，但最终 MP4 全音轨 PCM 均为零',audioStreams,samples,'frozen_speech_audio_silent');
 if(input.expectedFrames===undefined)return unknown('缺少独立冻结的预期帧数；解码计数不能自证全帧覆盖',audioStreams,samples);
 if(input.expectedFrames!==undefined&&frames!==input.expectedFrames)return unknown('完整解码帧数与冻结预期不符',audioStreams,samples,'frame_count_mismatch');
 if(first===null||last===null||first<-.02||first>.12||last<duration-.15||last>duration+.1||Math.abs(samples/16000-duration)>.12)return unknown('最终 MP4 视频 PTS 或音频 PCM 未覆盖冻结时长',audioStreams,samples,'media_duration_mismatch');
 if(createHash('sha256').update(await readFile(input.filePath)).digest('hex')!==sha)return unknown('解码期间最终 MP4 字节发生变化',audioStreams,samples,'media_bytes_changed');
 return {schemaVersion:'final-privacy-coverage.v1',finalMp4Sha256:sha,detectorVersion:'decode-coverage.v1',status:'observed',video:{streamCount:videoStreams,decodedFrames:frames,firstPtsSeconds:first,lastPtsSeconds:last,monotonicPts:monotonic},audio:{streamCount:audioStreams,decodedSamples:samples,decodedSeconds:samples/16000},reason:'最终 MP4 唯一视频轨全帧 PTS 与唯一音轨 PCM 已完整解码；没有进行逐帧敏感内容识别或音频转写，不证明隐私安全'};
}
