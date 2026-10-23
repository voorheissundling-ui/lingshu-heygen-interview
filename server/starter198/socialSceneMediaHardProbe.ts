import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {runVisualFfmpeg} from '../lib/renderVisualQuality.js';
import {recognizeProductImageLocally} from '../lib/localProductOcr.js';
import type {CaptionMaskFrameAudit} from './socialCaptionMaskFrameAudit.js';
import {socialObject,socialRequestHash} from './socialContentValidation.js';
import {inspectSensitiveScreenText} from './socialSceneSensitiveScreenAudit.js';
import {probeFinalPrivacyCoverage,type SocialFinalPrivacyCoverage} from './socialFinalPrivacyCoverage.js';
import {readSocialRenderFrameContract} from './socialRenderFrameContract.js';
import {auditCaptionDecodedFrames,type CaptionDecodedFrameAudit} from './socialCaptionDecodedFrameAudit.js';
import {auditFullFrozenAudio,type FullFrozenAudioAudit} from './socialFullFrozenAudioAudit.js';
import {auditFinalSensitiveFrames,sensitiveFrameAuditFromCaption,type FinalSensitiveFrameAudit} from './socialFinalSensitiveFrameAudit.js';

export interface SocialSceneMediaHardProbe {
 version:'scene-media-hard-probe.v1'; mediaSha256:string; timelineHash:string; captionCueHash?:string;
 subtitleTrack?:{status:'rendered'|'unknown';assSha256:string|null;reason:string};
 captionMaskAudit?:CaptionMaskFrameAudit;
 captionDecodedFrameAudit?:CaptionDecodedFrameAudit;
 captionTimeline?:{status:'valid'|'invalid'|'unknown';cueCount:number;sceneCount:number;crossSceneCueIndexes:number[];uncoveredSceneIndexes:number[];reason:string};
 captionSpeechAlignment?:{status:'matched'|'mismatch'|'unknown';frozenVoiceCueHash:string|null;captionCueCount:number;voiceCueCount:number;mismatchIndexes:number[];maxBoundaryErrorSeconds:number|null;reason:string};
 sensitiveFrozenSpeechEvidence?:{status:'hit'|'not_observed'|'unknown';frozenVoiceCueHash:string|null;cueCount:number;findingCodes:Array<'resident_identity_number'|'private_key_marker'>;findingCueIndexes:number[];reason:string};
 finalPrivacyCoverage?:SocialFinalPrivacyCoverage;
 fullFrozenAudioIdentity?:FullFrozenAudioAudit;
 finalSensitiveFrameAudit?:FinalSensitiveFrameAudit;
 container:'mp4'|'unknown'; videoCodec:string|null; audioCodec:string|null;
 width:number|null; height:number|null; measuredDurationSeconds:number|null;
 formatPassed:boolean; formatReason:string;
 frozenVoiceSha256?:string|null;
 scenes:Array<{sceneId:string;startSeconds:number;endSeconds:number;startFrameDecoded:boolean;endFrameDecoded:boolean;audioWindowDecoded?:boolean;audioIdentity?:{status:'passed'|'failed'|'unknown';correlation:number|null;reason:string};captionEvidence?:{status:'observed'|'unknown';cueCount:number;observedTextHashes:string[];sampledFrames?:Array<{cueIndex:number;atSeconds:number;frameSha256:string;ocrSha256:string}>;reason:string};sensitiveScreenEvidence?:{status:'hit'|'not_observed'|'unknown';samples:Array<{atSeconds:number;frameSha256:string;ocrSha256:string;findingCodes:Array<'resident_identity_number'|'private_key_marker'>}>;reason:string};durationPassed:boolean;reason:string}>;
}

export function shouldRunDefaultCaptionDecodedFrameAudit(input:{subtitleRendered:boolean;coverageStatus:'observed'|'unknown'|undefined;coverageSha256:string|undefined;mediaSha256:string;decodedFrames:number|undefined;expectedDurationSeconds:number|null;cueCount:number;manifestValid:boolean}):boolean{
 return input.subtitleRendered&&input.coverageStatus==='observed'&&input.coverageSha256===input.mediaSha256
  &&typeof input.decodedFrames==='number'&&input.decodedFrames>0&&input.decodedFrames<=300
  &&input.expectedDurationSeconds!==null&&input.expectedDurationSeconds>0&&input.expectedDurationSeconds<=10
  &&input.cueCount>0&&input.manifestValid;
}

const number=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)?value:null;
const decoded=(stderr:string)=>/frame=\s*[1-9]\d*/.test(stderr);
function pcmCorrelation(a:Buffer,b:Buffer):number|null{
 if(a.length<3200||b.length<3200||a.length%2||b.length%2||Math.abs(a.length-b.length)>1600)return null;
 let best=-2;
 // AAC delay and muxing may shift the output by a few milliseconds.
 for(let shift=-320;shift<=320;shift+=40){let dot=0,aa=0,bb=0;const begin=Math.max(0,-shift),end=Math.min(a.length/2,b.length/2-shift);for(let i=begin;i<end;i+=4){const x=a.readInt16LE(i*2),y=b.readInt16LE((i+shift)*2);dot+=x*y;aa+=x*x;bb+=y*y;}if(aa>1e8&&bb>1e8)best=Math.max(best,dot/Math.sqrt(aa*bb));}
 return best===-2?null:Number(best.toFixed(6));
}
const captionText=(value:string)=>value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const exactSpeechText=(value:string)=>value.normalize('NFKC').replace(/\s+/g,' ').trim();
/** Alarm on frozen spoken words only. A clean script cannot clear the final audio. */
export function auditSensitiveFrozenSpeech(rawVoiceCues?:unknown[]):NonNullable<SocialSceneMediaHardProbe['sensitiveFrozenSpeechEvidence']>{
 const cueCount=rawVoiceCues?.length??0,frozenVoiceCueHash=rawVoiceCues?socialRequestHash(rawVoiceCues):null;
 if(!cueCount)return {status:'unknown',frozenVoiceCueHash,cueCount,findingCodes:[],findingCueIndexes:[],reason:'缺少冻结主音轨逐句文字；无法检查计划口播中的敏感信息'};
 const findings=new Set<'resident_identity_number'|'private_key_marker'>(),findingCueIndexes:number[]=[];
 let malformed=false;
 rawVoiceCues!.forEach((raw,index)=>{
  const cue=socialObject(raw),spoken=typeof cue?.text==='string'?cue.text:'';
  if(!spoken.trim()){malformed=true;return;}
  const codes=inspectSensitiveScreenText(spoken);
  if(codes.length){findingCueIndexes.push(index);for(const code of codes)findings.add(code);}
 });
 if(findings.size)return {status:'hit',frozenVoiceCueHash,cueCount,findingCodes:[...findings].sort(),findingCueIndexes,reason:'冻结主音轨逐句文字出现高置信敏感标记；原文不写入质量回执'};
 return {status:malformed?'unknown':'not_observed',frozenVoiceCueHash,cueCount,findingCodes:[],findingCueIndexes:[],reason:malformed?'部分冻结口播句缺少可检查文字；不能证明最终音频隐私':'冻结主音轨逐句文字未观察到已知高置信敏感标记；未检查最终音频的额外语音或非文字隐私'};
}
/** Check every frozen caption against the measured master speech cue, not only sampled pixels. */
export function auditCaptionSpeechAlignment(input:{duration:number|null;rawCaptions:unknown[];rawVoiceCues?:unknown[];toleranceSeconds?:number}):NonNullable<SocialSceneMediaHardProbe['captionSpeechAlignment']>{
 const {duration,rawCaptions,rawVoiceCues}=input;
 const voiceCueCount=rawVoiceCues?.length??0;
 const unknown=(reason:string)=>({status:'unknown' as const,frozenVoiceCueHash:rawVoiceCues?socialRequestHash(rawVoiceCues):null,captionCueCount:rawCaptions.length,voiceCueCount,mismatchIndexes:[],maxBoundaryErrorSeconds:null,reason});
 if(!rawVoiceCues?.length||duration===null||duration<=0)return unknown('缺少冻结主音轨逐句时间轴或成片时长');
 const tolerance=input.toleranceSeconds??0.02;
 if(!Number.isFinite(tolerance)||tolerance<0||tolerance>0.05)return unknown('字幕与主音轨时间容差无效');
 const captions=rawCaptions.map(socialObject),voice=rawVoiceCues.map(socialObject);
 const mismatchIndexes:number[]=[];let maxBoundaryErrorSeconds=0;
 for(let index=0;index<Math.max(captions.length,voice.length);index++){
  const caption=captions[index],spoken=voice[index];
  const start=number(caption?.start),end=number(caption?.end),voiceStart=number(spoken?.start),voiceEnd=number(spoken?.end);
  const captionTextValue=typeof caption?.text==='string'?exactSpeechText(caption.text):'';
  const voiceTextValue=typeof spoken?.text==='string'?exactSpeechText(spoken.text):'';
  if(start===null||end===null||voiceStart===null||voiceEnd===null||start<0||voiceStart<0||end<=start||voiceEnd<=voiceStart||end>duration+tolerance||voiceEnd>duration+tolerance||!captionTextValue||!voiceTextValue||captionTextValue!==voiceTextValue){mismatchIndexes.push(index);continue;}
  const drift=Math.max(Math.abs(start-voiceStart),Math.abs(end-voiceEnd));maxBoundaryErrorSeconds=Math.max(maxBoundaryErrorSeconds,drift);
  if(drift>tolerance||index>0&&(start<(number(captions[index-1]?.end)??Infinity)-tolerance||voiceStart<(number(voice[index-1]?.end)??Infinity)-tolerance))mismatchIndexes.push(index);
 }
 return {status:mismatchIndexes.length?'mismatch':'matched',frozenVoiceCueHash:socialRequestHash(rawVoiceCues),captionCueCount:captions.length,voiceCueCount:voice.length,mismatchIndexes,maxBoundaryErrorSeconds:Number(maxBoundaryErrorSeconds.toFixed(6)),reason:mismatchIndexes.length?'冻结字幕与主音轨逐句文本、顺序或实测时窗不一致':'每条冻结字幕与同次冻结主音轨的文本及实测时窗一致；尚未证明最终画面逐帧烧录或口型同步'};
}
/** Structural audit only: no time-axis check can prove pixels or spoken-text completeness. */
export function auditCaptionTimeline(input:{duration:number|null;timeline:Array<Record<string,unknown>>;rawCues:unknown[]}):NonNullable<SocialSceneMediaHardProbe['captionTimeline']>{
 const {duration,timeline,rawCues}=input;
 const unknown=(reason:string)=>({status:'unknown' as const,cueCount:rawCues.length,sceneCount:timeline.length,crossSceneCueIndexes:[],uncoveredSceneIndexes:[],reason});
 if(duration===null||duration<=0||!timeline.length)return unknown('缺少冻结成片时长或镜头时间轴');
 const parsedScenes=timeline.map(scene=>({start:number(scene.targetStart),end:number(scene.targetEnd)}));
 if(parsedScenes.some(scene=>scene.start===null||scene.end===null||scene.start<0||scene.end<=scene.start))return unknown('冻结镜头时间轴自身不连续，无法判定字幕覆盖');
 const scenes=parsedScenes as Array<{start:number;end:number}>;
 if(Math.abs(scenes[0]!.start)>0.02||Math.abs(scenes.at(-1)!.end-duration)>0.15||scenes.some((scene,index)=>index>0&&Math.abs(scene.start-scenes[index-1]!.end)>0.02))return unknown('冻结镜头时间轴自身不连续，无法判定字幕覆盖');
 const cues=rawCues.map(socialObject).map(cue=>({start:number(cue?.start),end:number(cue?.end),text:typeof cue?.text==='string'?captionText(cue.text):''}));
 const invalid=cues.some(cue=>cue.start===null||cue.end===null||cue.start<0||cue.end<=cue.start||cue.end>duration+0.02||!cue.text)||cues.some((cue,index)=>index>0&&cue.start!<cues[index-1]!.start!);
 if(invalid)return {status:'invalid',cueCount:cues.length,sceneCount:scenes.length,crossSceneCueIndexes:[],uncoveredSceneIndexes:[],reason:'冻结字幕包含空白、逆序或越过成片时钟的 cue'};
 const crossSceneCueIndexes=cues.flatMap((cue,index)=>scenes.some(scene=>cue.start!<scene.end-0.001&&cue.end!>scene.start+0.001&&!(cue.start!>=scene.start-0.001&&cue.end!<=scene.end+0.001))?[index]:[]);
 const uncoveredSceneIndexes=scenes.flatMap((scene,index)=>cues.some(cue=>cue.start!<scene.end&&cue.end!>scene.start)?[]:[index]);
 return {status:'valid',cueCount:cues.length,sceneCount:scenes.length,crossSceneCueIndexes,uncoveredSceneIndexes,reason:'冻结字幕与镜头时间轴结构可核对；跨镜 cue 和无字幕镜头仅标记供逐项核验，不证明烧录像素或口播完整性'};
}
/** Dense, bounded cue sampling. Longer windows need more than three anchors; over-budget cues stay unknown. */
export function planCaptionSampleTimes(start:number,end:number):number[]|null{
 if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end-start<0.18)return null;
 const duration=end-start;
 const times=[0.1,0.5,0.9].map(fraction=>Number((start+duration*fraction).toFixed(3)));
 for(let at=start+0.5;at<end;at+=0.5)times.push(Number(at.toFixed(3)));
 const planned=[...new Set(times)].sort((a,b)=>a-b);
 return planned.length<=24?planned:null;
}
/** Every cue window is sampled on a half-second grid plus anchors on final MP4 bytes. OCR is observational only. */
async function captionEvidence(filePath:string,cues:Array<{start:number;end:number;text:string}>,start:number,end:number):Promise<SocialSceneMediaHardProbe['scenes'][number]['captionEvidence']>{
 const intersecting=cues.map((cue,index)=>({cue,index})).filter(({cue})=>cue.start<end&&cue.end>start);
 const relevant=intersecting.filter(({cue})=>cue.start>=start-0.001&&cue.end<=end+0.001&&cue.end>cue.start&&captionText(cue.text).length>=4);
 if(!relevant.length||relevant.length!==intersecting.length||relevant.length>32)return {status:'unknown',cueCount:intersecting.length,observedTextHashes:[],reason:'当前镜头存在跨镜、过短、空白或超出有界核验量的字幕；不能完整逐条核对'};
 const plans=relevant.map(({cue,index})=>({index,cue,times:planCaptionSampleTimes(cue.start,cue.end)}));
 if(plans.some(plan=>!plan.times)||plans.reduce((count,plan)=>count+(plan.times?.length??0),0)>64)return {status:'unknown',cueCount:relevant.length,observedTextHashes:[],reason:'字幕时窗太短或逐条采样超过单镜 64 帧预算；不得降采样后宣称已观察完整时窗'};
 const observedTextHashes:string[]=[],sampledFrames:Array<{cueIndex:number;atSeconds:number;frameSha256:string;ocrSha256:string}>=[];
 for(const {cue,index,times} of plans){
  for(const at of times!){
   const frame=await runVisualFfmpeg(['-ss',at.toFixed(3),'-i',filePath,'-frames:v','1','-an','-vf','scale=960:-2','-f','image2pipe','-vcodec','png','pipe:1'],true);
   if(!frame.ok||!frame.stdout.length)return {status:'unknown',cueCount:relevant.length,observedTextHashes,sampledFrames,reason:'最终媒体字幕采样帧不可读'};
   let recognized:string;
   try{recognized=await recognizeProductImageLocally({bytes:frame.stdout,mimeType:'image/png'});}catch{return {status:'unknown',cueCount:relevant.length,observedTextHashes,sampledFrames,reason:'本机 OCR 不可用，不能证明字幕缺失或存在'};}
   const expected=captionText(cue.text),observed=captionText(recognized);
   if(!observed.includes(expected))return {status:'unknown',cueCount:relevant.length,observedTextHashes,sampledFrames,reason:'实际画面 OCR 未能逐字核对冻结字幕；不能据此判定字幕不存在'};
   const ocrSha256=createHash('sha256').update(recognized).digest('hex');observedTextHashes.push(ocrSha256);
   sampledFrames.push({cueIndex:index,atSeconds:at,frameSha256:createHash('sha256').update(frame.stdout).digest('hex'),ocrSha256});
  }
 }
 return {status:'observed',cueCount:relevant.length,observedTextHashes,sampledFrames,reason:'最终 MP4 当前镜头每条冻结字幕的半秒网格及入口、中点、出口帧均由本机 OCR 逐字核对；未证明帧间连续性、字幕来源或其他画面文字'};
}
/** Bounded half-second grid plus three anchors; no sampling plan establishes privacy clearance. */
export function planSensitiveScreenSampleTimes(start:number,end:number):number[]{
 if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start)return [];
 const duration=end-start;
 const times=[...new Set([0.1,0.5,0.9].map(fraction=>Number((start+duration*fraction).toFixed(3))))];
 for(let at=start+0.5;at<end;at+=0.5)times.push(Number(at.toFixed(3)));
 const sorted=[...new Set(times)].sort((a,b)=>a-b);
 if(sorted.length<=32)return sorted;
 return [...new Set(Array.from({length:32},(_,index)=>sorted[Math.round(index*(sorted.length-1)/31)]!))].sort((a,b)=>a-b);
}
/** Samples actual final-MP4 pixels; absence in these frames cannot establish absence elsewhere. */
async function sensitiveScreenEvidence(filePath:string,start:number,end:number):Promise<SocialSceneMediaHardProbe['scenes'][number]['sensitiveScreenEvidence']>{
 const samples:NonNullable<SocialSceneMediaHardProbe['scenes'][number]['sensitiveScreenEvidence']>['samples']=[];
 const times=planSensitiveScreenSampleTimes(start,end);
 let failedSamples=0;
 for(const at of times){
  const frame=await runVisualFfmpeg(['-ss',at.toFixed(3),'-i',filePath,'-frames:v','1','-an','-vf','scale=960:-2','-f','image2pipe','-vcodec','png','pipe:1'],true);
  if(!frame.ok||!frame.stdout.length){failedSamples++;continue;}
  let recognized:string;
  try{recognized=await recognizeProductImageLocally({bytes:frame.stdout,mimeType:'image/png'});}catch{failedSamples++;continue;}
  samples.push({atSeconds:at,frameSha256:createHash('sha256').update(frame.stdout).digest('hex'),ocrSha256:createHash('sha256').update(recognized).digest('hex'),findingCodes:inspectSensitiveScreenText(recognized)});
 }
 if(samples.some(sample=>sample.findingCodes.length))return {status:'hit',samples,reason:'最终 MP4 抽样帧 OCR 出现疑似身份证号或私钥标记；原文不写入质量回执'};
 if(failedSamples||end-start>14)return {status:'unknown',samples,reason:`隐私抽样未完整核验（计划 ${times.length} 帧，失败 ${failedSamples} 帧）；不证明全片无敏感信息`};
 return {status:'not_observed',samples,reason:`最终 MP4 已核对 ${samples.length} 个抽样帧，未观察到高置信敏感文本；不证明帧间或全片无敏感信息`};
}
/** Byte-bound container, codec, frame-window, PCM and conservative visible-caption checks. It cannot establish lip sync or visual privacy. */
export async function probeSocialSceneMedia(input:{filePath:string;manifest:Record<string,unknown>;frozenVoiceCues?:unknown[];subtitleRenderEvidence?:{schemaVersion:'rendered-subtitle-track.v1';outputSha256:string;assSha256:string|null;filterApplied:boolean};frameRenderEvidence?:{schemaVersion:'renderer-frame-attestation.v1';outputSha256:string;fps:30;durationSeconds:number;expectedFrames:number};captionMaskSources?:{baselinePath:string;baselineSha256:string;assPath:string;assSha256:string}}):Promise<SocialSceneMediaHardProbe>{
 const bytes=await readFile(input.filePath),mediaSha256=createHash('sha256').update(bytes).digest('hex');
 const timeline=Array.isArray(input.manifest.timeline)?input.manifest.timeline.map(socialObject):[];
 const timelineHash=socialRequestHash(timeline);
 const spec=socialObject(input.manifest.spec),expectedDuration=number(spec?.duration);
 const header=bytes.length>=12&&bytes.toString('ascii',4,8)==='ftyp';
 const info=await runVisualFfmpeg(['-i',input.filePath,'-t','0','-f','null','-'],false,{logLevel:'info'});
 const durationMatch=info.stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
 const measuredDurationSeconds=durationMatch?Number(durationMatch[1])*3600+Number(durationMatch[2])*60+Number(durationMatch[3]):null;
 const video=info.stderr.match(/Video:\s*([^,\s]+)[^\n]*?(\d{2,5})x(\d{2,5})/);
 const audio=info.stderr.match(/Audio:\s*([^,\s]+)/);
 const videoCodec=video?.[1]??null,audioCodec=audio?.[1]??null,width=video?Number(video[2]):null,height=video?Number(video[3]):null;
 const voice=socialObject(input.manifest.voiceover),voicePath=typeof voice?.url==='string'&&!/^[a-z][a-z0-9+.-]*:/i.test(voice.url)?voice.url:null;
 let frozenVoiceSha256:string|null=null;try{if(voicePath)frozenVoiceSha256=createHash('sha256').update(await readFile(voicePath)).digest('hex');}catch{/* A missing frozen track is unknown, never a pass. */}
 const mixedMusic=Boolean(input.manifest.bgm);
 const subtitles=socialObject(input.manifest.subtitles),rawCues=Array.isArray(subtitles?.cues)?subtitles.cues:[];
 const cues=rawCues.map(socialObject).flatMap(cue=>{const start=number(cue?.start),end=number(cue?.end),text=typeof cue?.text==='string'?cue.text:'';return start!==null&&end!==null&&text?[{start,end,text}]:[];});
 const captionManifestInvalid=rawCues.length!==cues.length;
 const captionTimeline=auditCaptionTimeline({duration:expectedDuration,timeline:timeline.map(item=>item??{}),rawCues});
 const captionSpeechAlignment=auditCaptionSpeechAlignment({duration:expectedDuration,rawCaptions:rawCues,rawVoiceCues:input.frozenVoiceCues});
 const sensitiveFrozenSpeechEvidence=auditSensitiveFrozenSpeech(input.frozenVoiceCues);
 const frameContract=readSocialRenderFrameContract(input.manifest),frameReceipt=input.frameRenderEvidence;
 const trustedFrames=frameContract&&frameReceipt?.schemaVersion==='renderer-frame-attestation.v1'&&frameReceipt.outputSha256===mediaSha256&&frameReceipt.fps===frameContract.fps&&frameReceipt.durationSeconds===frameContract.durationSeconds&&frameReceipt.expectedFrames===frameContract.expectedFrames?frameContract.expectedFrames:undefined;
 const frozenSpeechExpected=Array.isArray(input.frozenVoiceCues)&&input.frozenVoiceCues.some(raw=>{const cue=socialObject(raw);return typeof cue?.text==='string'&&cue.text.trim().length>0;});
 const finalPrivacyCoverage=expectedDuration!==null?await probeFinalPrivacyCoverage({filePath:input.filePath,expectedDurationSeconds:expectedDuration,expectedFrames:trustedFrames,frozenSpeechExpected}).catch(()=>undefined):undefined;
 const fullFrozenAudioIdentity=voicePath&&frozenVoiceSha256&&expectedDuration!==null&&!mixedMusic
  ?await auditFullFrozenAudio({finalPath:input.filePath,frozenPath:voicePath,expectedFinalSha256:mediaSha256,expectedFrozenSha256:frozenVoiceSha256,durationSeconds:expectedDuration}).catch(()=>undefined)
  :undefined;
 const renderTrack=input.subtitleRenderEvidence;
 const subtitleTrack:NonNullable<SocialSceneMediaHardProbe['subtitleTrack']>=renderTrack?.schemaVersion==='rendered-subtitle-track.v1'&&renderTrack.outputSha256===mediaSha256&&renderTrack.filterApplied&&/^[a-f0-9]{64}$/.test(renderTrack.assSha256??'')?{status:'rendered',assSha256:renderTrack.assSha256,reason:'渲染器报告 ASS 字节摘要和字幕滤镜，且回执绑定最终 MP4 字节'}:{status:'unknown',assSha256:null,reason:'缺少与最终 MP4 字节绑定的渲染器 ASS 字幕轨回执'};
 const maskSources=input.captionMaskSources;
 const captionMaskAudit=maskSources&&subtitleTrack.status==='rendered'&&subtitleTrack.assSha256===maskSources.assSha256&&expectedDuration!==null&&width&&height
  ?await import('./socialCaptionMaskFrameAudit.js').then(module=>module.auditCaptionMaskFrames({finalPath:input.filePath,baselinePath:maskSources.baselinePath,assPath:maskSources.assPath,expectedFinalSha256:mediaSha256,expectedBaselineSha256:maskSources.baselineSha256,expectedAssSha256:maskSources.assSha256,durationSeconds:expectedDuration,width,height,frozenCues:cues})).catch(()=>undefined)
  :undefined;
 // Exhaustive OCR is only attempted for an independently frame-counted short
 // render (at most 10 seconds / 300 frames). Longer films must not spend
 // minutes on an observation that cannot itself approve G4. Matching text may be packaging
 // or other scene text, so it must never turn the G4 caption check positive.
 const captionDecodedFrameAudit=shouldRunDefaultCaptionDecodedFrameAudit({subtitleRendered:subtitleTrack.status==='rendered',coverageStatus:finalPrivacyCoverage?.status,coverageSha256:finalPrivacyCoverage?.finalMp4Sha256,mediaSha256,decodedFrames:finalPrivacyCoverage?.video.decodedFrames,expectedDurationSeconds:expectedDuration,cueCount:cues.length,manifestValid:!captionManifestInvalid})
  ?await auditCaptionDecodedFrames({filePath:input.filePath,cues,maxFrames:300,maxDurationSeconds:10}).catch(()=>undefined)
  :undefined;
 const finalSensitiveFrameAudit=finalPrivacyCoverage?.status==='observed'&&finalPrivacyCoverage.finalMp4Sha256===mediaSha256
  &&finalPrivacyCoverage.video.decodedFrames>0&&finalPrivacyCoverage.video.decodedFrames<=300
  &&expectedDuration!==null&&expectedDuration<=10
  ?(captionDecodedFrameAudit?sensitiveFrameAuditFromCaption(captionDecodedFrameAudit,mediaSha256,finalPrivacyCoverage.video.decodedFrames):null)
   ??await auditFinalSensitiveFrames({filePath:input.filePath,expectedMediaSha256:mediaSha256,expectedFrameCount:finalPrivacyCoverage.video.decodedFrames}).catch(()=>undefined)
  :undefined;
 const formatPassed=header&&info.ok&&videoCodec==='h264'&&audioCodec==='aac'&&!!width&&!!height&&width>=64&&height>=64;
 const formatReason=formatPassed?`MP4/H.264/AAC ${width}x${height}，成片 SHA256 ${mediaSha256}`:'媒体容器、H.264 视频、AAC 音轨或解码证据不完整';
 const scenes=[] as SocialSceneMediaHardProbe['scenes'];
 for(const raw of timeline){const sceneId=typeof raw?.sceneId==='string'?raw.sceneId:'',startSeconds=number(raw?.targetStart),endSeconds=number(raw?.targetEnd);
  if(!sceneId||startSeconds===null||endSeconds===null||startSeconds<0||endSeconds<=startSeconds||!formatPassed||measuredDurationSeconds===null||expectedDuration===null){scenes.push({sceneId,startSeconds:startSeconds??-1,endSeconds:endSeconds??-1,startFrameDecoded:false,endFrameDecoded:false,audioWindowDecoded:false,durationPassed:false,reason:'冻结时间窗或独立媒体时钟不完整'});continue;}
  const first=Math.min(endSeconds-0.001,startSeconds+Math.min(0.05,(endSeconds-startSeconds)/4));
  const last=Math.max(first,endSeconds-Math.min(0.05,(endSeconds-startSeconds)/4));
  const probeFrame=async(at:number)=>{const r=await runVisualFfmpeg(['-i',input.filePath,'-ss',at.toFixed(3),'-frames:v','1','-an','-f','null','-'],false,{logLevel:'info'});return r.ok&&decoded(r.stderr);};
  const startFrameDecoded=await probeFrame(first),endFrameDecoded=await probeFrame(last);
  // PCM samples prove that this particular final-MP4 time window has a
  // decodable audio stream. They do not establish speech identity or lip sync.
  const windowSeconds=Math.min(0.5,endSeconds-startSeconds),windowStart=startSeconds+(endSeconds-startSeconds-windowSeconds)/2;
  const decodeAudio=(source:string,at=windowStart,seconds=windowSeconds)=>runVisualFfmpeg(['-ss',at.toFixed(3),'-i',source,'-t',seconds.toFixed(3),'-map','0:a:0','-ac','1','-ar','8000','-f','s16le','pipe:1'],true);
  const audioWindow=await decodeAudio(input.filePath);
  // A midpoint sample alone misses an audio stream that ends before the
  // visual scene does. Check actual PCM coverage close to both boundaries.
  const edgeSeconds=Math.min(0.2,(endSeconds-startSeconds)/3);
  const edgeStarts=[startSeconds,Math.max(startSeconds,endSeconds-edgeSeconds)];
  const edges=await Promise.all(edgeStarts.map(at=>decodeAudio(input.filePath,at,edgeSeconds)));
  const audioWindowDecoded=audioWindow.ok&&audioWindow.stdout.length>=2&&edges.every(edge=>edge.ok&&edge.stdout.length/16000>=Math.max(0.02,edgeSeconds-0.06));
  let audioIdentity:SocialSceneMediaHardProbe['scenes'][number]['audioIdentity']={status:'unknown',correlation:null,reason:'缺少可核验的冻结主音轨或最终音频窗口'};
  if(audioWindowDecoded&&frozenVoiceSha256&&voicePath){const frozen=await decodeAudio(voicePath);const correlation=frozen.ok?pcmCorrelation(frozen.stdout,audioWindow.stdout):null;
   audioIdentity=correlation===null?{status:'unknown',correlation:null,reason:'当前窗口无足够的有效主音轨采样可比对'}:correlation>=0.85?{status:'passed',correlation,reason:'冻结主音轨与最终 MP4 同窗声学波形一致；未证明真人口型同步'}:!mixedMusic&&correlation<0.2?{status:'failed',correlation,reason:'无背景音乐时最终 MP4 音轨与冻结主音轨明显不一致'}:{status:'unknown',correlation,reason:'混音或压缩后的声学差异不足以独立判定音轨身份'};
  }
  const clockMatches=Math.abs(measuredDurationSeconds-expectedDuration)<=0.15&&endSeconds<=measuredDurationSeconds+0.05;
  const durationPassed=clockMatches&&startFrameDecoded&&endFrameDecoded;
  const caption=durationPassed?(captionManifestInvalid?{status:'unknown' as const,cueCount:rawCues.length,observedTextHashes:[],reason:'冻结字幕清单含无效 cue，不能省略后宣称完整核对'}:await captionEvidence(input.filePath,cues,startSeconds,endSeconds)):undefined;
  const privacy=durationPassed?await sensitiveScreenEvidence(input.filePath,startSeconds,endSeconds):undefined;
  scenes.push({sceneId,startSeconds,endSeconds,startFrameDecoded,endFrameDecoded,audioWindowDecoded,audioIdentity,...(caption?{captionEvidence:caption}:{}),...(privacy?{sensitiveScreenEvidence:privacy}:{}),durationPassed,reason:durationPassed?`媒体时钟 ${measuredDurationSeconds}s；冻结镜头 ${startSeconds}-${endSeconds}s 双边界已解码`:'媒体时钟与冻结时间轴不符，或镜头边界缺少可解码帧'});
 }
 return {version:'scene-media-hard-probe.v1',mediaSha256,timelineHash,captionCueHash:socialRequestHash(cues),subtitleTrack,...(captionMaskAudit?{captionMaskAudit}:{}),...(captionDecodedFrameAudit?{captionDecodedFrameAudit}:{}),captionTimeline,captionSpeechAlignment,sensitiveFrozenSpeechEvidence,...(finalPrivacyCoverage?{finalPrivacyCoverage}:{}),...(finalSensitiveFrameAudit?{finalSensitiveFrameAudit}:{}),...(fullFrozenAudioIdentity?{fullFrozenAudioIdentity}:{}),container:header?'mp4':'unknown',videoCodec,audioCodec,width,height,measuredDurationSeconds,formatPassed,formatReason,frozenVoiceSha256,scenes};
}
