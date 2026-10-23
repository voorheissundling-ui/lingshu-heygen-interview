import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {verifiedAudioCues} from '../integrations/qwenAlignment.js';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import ffmpegStatic from 'ffmpeg-static';
import type {HeyGenClient} from '../lib/heygen.js';
import type {SocialTaskBudgetScope} from '../lib/socialContentTaskBudget.js';
import {withPaidOperationLock} from '../lib/paidOperationLock.js';
import type {DigitalPresenterExecutionRequest,VerifiedPresenterSpeechAudio,PresenterHookSpeechAudio} from './socialContentDigitalPresenterAdapter.js';
const run=promisify(execFile);
const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const normalized=(text:string)=>text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
export interface WholeTrackPresenterSpeech extends Omit<PresenterHookSpeechAudio,'operationRole'> {
 operationRole:'production_scene';runId:string;planHash:string;wholeTrackSha256:string;
 frozenSceneDurationSeconds:number;nativeVoice:{provider:'qwen'|'minimax'|'heygen';model:string;physicalVoiceId:string};
 sourceReceiptRef:string;sourceReceiptSha256:string;alignmentReceiptRef:string;alignmentReceiptSha256:string;
}
/** Visual cuts share one continuous voice performance. Words and sentences
 * may cross scene cuts; clips use exact frozen visual windows. */
export function measuredWholeTrackSceneRanges(input:{scenes:Array<{shotId:string;spokenText:string;durationSeconds:number;startSeconds:number;endSeconds:number}>;cues:Array<{start:number;end:number;text:string}>;durationSeconds:number}) {
 const ranges=new Map<string,{start:number;end:number}>();let lastEnd=0;
 for(const cue of input.cues){
  if(!Number.isFinite(cue.start)||!Number.isFinite(cue.end)||cue.start<lastEnd-.03||cue.end<=cue.start||cue.end>input.durationSeconds+.02)throw Error('presenter_whole_track_alignment_invalid');
  lastEnd=cue.end;
 }
 if(normalized(input.cues.map(c=>c.text).join(' '))!==normalized(input.scenes.map(s=>s.spokenText).join(' ')))throw Error('presenter_scene_alignment_not_unique');
 let previousEnd=0;
 for(const scene of input.scenes){
  if(!Number.isFinite(scene.startSeconds)||!Number.isFinite(scene.endSeconds)||scene.startSeconds<previousEnd-.02||scene.endSeconds<=scene.startSeconds||Math.abs(scene.endSeconds-scene.startSeconds-scene.durationSeconds)>.02)throw Error('presenter_frozen_scene_timeline_missing');
  ranges.set(scene.shotId,{start:scene.startSeconds,end:scene.endSeconds});previousEnd=scene.endSeconds;
 }
 return ranges;
}
/** Trusted server-only port. Each clip derives from the same paid full track;
 * asset uploads cannot trigger another TTS or avatar generation. */
export function createWholeTrackPresenterAudioPort(input:{
 scope:SocialTaskBudgetScope;taskVersion:string;filePath:string;wholeTrackSha256:string;durationSeconds:number;
 scenes:Array<{shotId:string;spokenText:string;durationSeconds:number;startSeconds:number;endSeconds:number}>;cues:Array<{start:number;end:number;text:string}>;
 nativeVoice:WholeTrackPresenterSpeech['nativeVoice'];sourceReceiptRef:string;alignmentReceiptRef:string;
 client:Pick<HeyGenClient,'uploadAudio'>;assertCurrent:()=>Promise<void>;root?:string;
}) {
 const ranges=measuredWholeTrackSceneRanges(input);
 const root=path.join(input.root||path.resolve('data/social-content-presenter-audio'),sha(input.scope.tenantId),sha(input.scope.taskId),sha(input.scope.runId));
 const resolved=new Map<string,WholeTrackPresenterSpeech>();
 const persist=(file:string,row:unknown,exclusive=false)=>{
  const target=exclusive?file:file+'.'+randomUUID()+'.tmp';
  const fd=fs.openSync(target,'wx',0o600);
  try{fs.writeFileSync(fd,JSON.stringify(row));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  if(!exclusive)fs.renameSync(target,file);
  const directory=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}
 };
 const readEvidence=()=>{
  if(sha(fs.readFileSync(input.filePath))!==input.wholeTrackSha256)throw Error('presenter_whole_track_bytes_changed');
  const source=fs.readFileSync(input.sourceReceiptRef),alignment=fs.readFileSync(input.alignmentReceiptRef);
  const original=JSON.parse(source.toString()),timing=JSON.parse(alignment.toString());
  if(original.scope?.tenantId!==input.scope.tenantId||original.scope?.taskId!==input.scope.taskId||original.scope?.runId!==input.scope.runId||original.scope?.planHash!==input.scope.planHash||original.provider!==input.nativeVoice.provider||original.model!==input.nativeVoice.model||original.voiceId!==input.nativeVoice.physicalVoiceId||timing.state!=='completed'||timing.scope?.audioSha256!==input.wholeTrackSha256||!timing.result)throw Error('presenter_whole_track_paid_evidence_changed');
  const measured = verifiedAudioCues(timing.result, input.scenes.map(scene => scene.spokenText).filter(Boolean).join(' '), input.durationSeconds);
  if (JSON.stringify(measured) !== JSON.stringify(input.cues)) throw Error('presenter_whole_track_alignment_proof_changed');
  return {sourceReceiptSha256:sha(source),alignmentReceiptSha256:sha(alignment)};
 };
 const resolve=async(request:DigitalPresenterExecutionRequest):Promise<WholeTrackPresenterSpeech>=>{
  await input.assertCurrent();const evidence=readEvidence(),range=ranges.get(request.shotId),scene=input.scenes.find(s=>s.shotId===request.shotId);
  if(!range||!scene||request.tenantId!==input.scope.tenantId||request.taskId!==input.scope.taskId||normalized(request.script)!==normalized(scene.spokenText))throw Error('presenter_whole_track_scene_scope_changed');
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  const identity={scope:input.scope,taskVersion:input.taskVersion,shotId:request.shotId,range,wholeTrackSha256:input.wholeTrackSha256,nativeVoice:input.nativeVoice,presenter:request.presenter,...evidence};
  const key=sha(JSON.stringify(identity)),file=path.join(root,key+'.wav'),stateFile=path.join(root,key+'.json');
  return withPaidOperationLock(path.join(root,'.locks'),key,async()=>{
   if(!fs.existsSync(file))await run(ffmpegStatic||'ffmpeg',['-y','-i',input.filePath,'-af',`apad=whole_dur=${range.end},atrim=start=${range.start}:end=${range.end},asetpts=PTS-STARTPTS`,'-ac','1','-ar','24000','-c:a','pcm_s16le',file],{timeout:30000});
   const pcm=await run(ffmpegStatic||'ffmpeg',['-v','error','-i',file,'-f','s16le','-ac','1','-ar','24000','pipe:1'],{encoding:'buffer',maxBuffer:64*1024*1024,timeout:30000});
   const durationSeconds=pcm.stdout.length/(24000*2),bytes=fs.readFileSync(file),clipSha256=sha(bytes);
   if(!(durationSeconds>0)||Math.abs(durationSeconds-(range.end-range.start))>.02||durationSeconds>scene.durationSeconds+.02)throw Error('presenter_scene_clip_probe_invalid');
   let prior:any;try{prior=JSON.parse(fs.readFileSync(stateFile,'utf8'));}catch{}
   if(prior&&(prior.identityHash!==key||prior.clipSha256!==clipSha256))throw Error('presenter_scene_upload_original_changed');
   if(prior&&!prior.audioAssetId)throw Error('presenter_scene_upload_unknown_no_repost');
   if(!prior){
    persist(stateFile,{identityHash:key,clipSha256,status:'uploading'},true);
    const audioAssetId=await input.client.uploadAudio(bytes,'whole-track-audio:'+key,'audio/wav');
    if(!audioAssetId)throw Error('presenter_scene_upload_asset_missing');
    prior={identityHash:key,clipSha256,audioAssetId,status:'uploaded'};persist(stateFile,prior);
   }
   if(!request.presenter.providerPresenterId)throw Error('presenter_scene_avatar_mapping_required');
   const audio:WholeTrackPresenterSpeech={tenantId:request.tenantId,taskId:request.taskId,taskVersion:input.taskVersion,runId:input.scope.runId,planHash:input.scope.planHash,shotId:request.shotId,presenterAssetId:request.presenter.presenterAssetId,presenterAssetVersion:request.presenter.assetVersion,providerAvatarId:request.presenter.providerPresenterId,voiceId:input.nativeVoice.physicalVoiceId,scriptSha256:sha(request.script),clipSha256,durationSeconds,frozenSceneDurationSeconds:scene.durationSeconds,wholeTrackSha256:input.wholeTrackSha256,nativeVoice:input.nativeVoice,sourceReceiptRef:input.sourceReceiptRef,alignmentReceiptRef:input.alignmentReceiptRef,...evidence,receiptRef:stateFile,receiptHash:sha(fs.readFileSync(stateFile)),audioAssetId:prior.audioAssetId,engine:'avatar_iv',operationRole:'production_scene'};
   resolved.set(audio.audioAssetId,audio);return audio;
  });
 };
 return {resolve,async verify(request:DigitalPresenterExecutionRequest,audio:VerifiedPresenterSpeechAudio|WholeTrackPresenterSpeech){const actual=await resolve(request);return JSON.stringify(actual)===JSON.stringify(audio);},readResolvedAsset(assetId:string){return resolved.get(assetId)||null;}};
}
