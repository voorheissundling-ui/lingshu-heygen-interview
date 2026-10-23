import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegStatic from 'ffmpeg-static';
import { createHash, randomUUID } from 'node:crypto';
import { withPaidOperationLock } from '../lib/paidOperationLock.js';
import { nativeStudioVoiceReceiptPath, createNativeStudioVoicePaidContext } from '../lib/studioNativeVoicePaidContext.js';
import { paidProductionHash } from './socialContentPaidOperationPlan.js';
import {
  alignStudioVoiceForAutomation,
  resolveStudioVoiceExecutionPlan,
  synthesizeStudioVoiceForAutomation,
} from '../lib/socialContentLegacyPorts.js';
import { measuredWholeTrackSceneRanges } from './socialContentWholeTrackPresenterAudio.js';
import { verifiedAudioCues } from '../integrations/qwenAlignment.js';
import { ttsPostProcessingSpeed } from '../lib/studioVoiceSelection.js';

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
type Funding = Parameters<typeof createNativeStudioVoicePaidContext>[0];
type Voice = Awaited<ReturnType<typeof synthesizeStudioVoiceForAutomation>>;
export function verifiedHeyGenNativeTiming(response:any,text:string,speed:number,targetDuration:number,duration:number) {
  const natural=Number(response.duration)/speed+.15;
  const fit=natural>targetDuration+.02?natural/targetDuration:1;
  if(!(speed>0)||!Number.isFinite(natural)||Math.abs(Math.min(natural,targetDuration)-duration)>.12)throw Error('native_voice_timing_transform_changed');
  const words=response.word_timestamps.filter((word:any)=>!['<start>','<end>'].includes(word.word)).map((word:any)=>({text:String(word.word||''),begin_time:Number(word.start)/speed/fit*1000,end_time:Number(word.end)/speed/fit*1000}));
  const result={transcripts:[{text:words.map((word:any)=>word.text).join(' '),sentences:words.map((word:any)=>({...word,words:[word]}))}]};
  return {fit,result,cues:verifiedAudioCues(result,text,duration)};
}
export interface PreparedWholeVoice {
  voice: Voice & { localPath: string; duration: number; cues: Array<{ start: number; end: number; text: string }> };
  inputHash: string;
  receiptRef: string;
  wholeTrackSha256: string;
  sourceReceiptRefs: string[];
  alignmentReceiptRef: string;
  nativeVoice: { provider: 'qwen' | 'minimax' | 'heygen'; model: string; physicalVoiceId: string };
}
export class WholeVoiceDurationRevisionRequired extends Error {
  readonly code = 'director_whole_voice_duration_revision_required';
  constructor(readonly proofRef:string, readonly actualDurationSeconds:number, readonly maximumDurationSeconds:number) {
    super('director_revision_required:whole_track_speech_exceeds_frozen_film_requires_formal_replan');
  }
}
/** Prepares one full performance using the preallocated voice operations.
 * Avatar providers only consume measured slices of this already-paid track. */
export async function prepareSocialContentWholeVoice(input: {
  funding: Funding;
  targetDuration: number;
  scenes: Array<{ shotId: string; spokenText: string; durationSeconds: number; startSeconds: number; endSeconds: number }>;
  root?: string;
  alignmentRoot?: string;
  synthesize?: typeof synthesizeStudioVoiceForAutomation;
  align?: typeof alignStudioVoiceForAutomation;
}): Promise<PreparedWholeVoice> {
  const funding = input.funding;
  const route = funding.routeBindings['voice:0:tts'];
  const nativeProvider = route?.provider === 'qwen' || route?.provider === 'minimax' || route?.provider === 'heygen' ? route.provider : undefined;
  const plan = resolveStudioVoiceExecutionPlan({ ...funding.voiceInput, nativeProvider });
  if (!plan.primary || plan.mode !== 'continuous' || plan.texts.length !== 1)
    throw Error('presenter_whole_track_continuous_native_voice_required');
  const primary=plan.primary;
  const inputHash = paidProductionHash({ scope: funding.scope, voiceInput: funding.voiceInput, primary: plan.primary, scenes: input.scenes });
  const root = path.join(input.root || path.resolve('data/social-content-whole-voice'), sha(funding.scope.tenantId), sha(funding.scope.taskId), sha(funding.scope.runId));
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stateFile = path.join(root, inputHash + '.json');
  const persist = (row: unknown) => {
    const temporary = stateFile + '.' + randomUUID() + '.tmp';
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(row)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, stateFile);
    const directory = fs.openSync(root, 'r'); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  };
  return withPaidOperationLock(path.join(root, '.locks'), inputHash, async () => {
    await funding.assertCurrent();
    let state: any;
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* first execution */ }
    if (state && (state.inputHash !== inputHash || paidProductionHash(state.scope) !== paidProductionHash(funding.scope)))
      throw Error('prepared_whole_voice_scope_changed');
    const paidContext = createNativeStudioVoicePaidContext(funding);
    let voice: Voice;
    if (state?.voice) {
      voice = state.voice;
      if (!voice.localPath || sha(fs.readFileSync(voice.localPath)) !== state.wholeTrackSha256)
        throw Error('prepared_whole_voice_bytes_changed');
    } else {
      // A crash after a paid request is recovered only through the native
      // receipt/cache guard. It can never initiate a second supplier request.
      const candidate = await (input.synthesize || synthesizeStudioVoiceForAutomation)({
        ...funding.voiceInput, targetDuration: input.targetDuration, paidContext,
      });
      if (!candidate.ok || !candidate.localPath || !candidate.url || !candidate.duration)
        throw Error(candidate.error || 'prepared_whole_voice_audio_missing');
      if (candidate.text && candidate.text !== funding.voiceInput.text.trim())
        throw Error('director_voice_text_changed_requires_budget_replan');
      const bytes = fs.readFileSync(candidate.localPath);
      const file = path.join(root, inputHash + '.wav');
      if(fs.existsSync(file)){
        if(sha(fs.readFileSync(file))!==sha(bytes))throw Error('prepared_whole_voice_original_copy_changed');
      }else{
        const temporary=file+'.'+randomUUID()+'.tmp';const fd=fs.openSync(temporary,'wx',0o600);
        try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
        try{fs.linkSync(temporary,file);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST'||sha(fs.readFileSync(file))!==sha(bytes))throw Error('prepared_whole_voice_original_copy_changed');}
        finally{fs.unlinkSync(temporary);}
      }
      voice = { ...candidate, localPath: file };
      state = { inputHash, scope: funding.scope, voice, scenes:input.scenes, wholeTrackSha256: sha(bytes), status: 'audio_prepared' };
      persist(state);
    }
    if (!voice.localPath || !voice.url || !voice.duration) throw Error('prepared_whole_voice_cache_invalid');
    const sourceReceiptRefs = plan.texts.map((_, index) => {const key=`voice:${index}:tts`,correction=funding.intents.find(intent=>intent.stage==='tts'&&intent.correction?.kind==='voice_tts')?.correction;return nativeStudioVoiceReceiptPath(funding.scope,
      'paid-plan:' + paidProductionHash(correction?{ scope: funding.scope, key, attempt: 1,correction }:{ scope: funding.scope, key, attempt: 0 }), funding.root);});
    for (let index=0;index<sourceReceiptRefs.length;index++) {
      const receipt=sourceReceiptRefs[index]!;
      if (!fs.existsSync(receipt)) throw Error('prepared_whole_voice_original_receipt_missing');
      const raw=JSON.parse(fs.readFileSync(receipt,'utf8'));
      if(paidProductionHash(raw.scope)!==paidProductionHash(funding.scope)||raw.provider!==primary.provider||raw.model!==primary.model||raw.voiceId!==primary.voiceId)throw Error('prepared_whole_voice_original_receipt_changed');
      await funding.permit.assertRecovery(raw.operationId);
    }
    const alignmentCorrection=funding.intents.find(intent=>intent.stage==='voice_alignment'&&intent.correction?.kind==='voice_alignment')?.correction;
    const alignmentId = 'paid-plan:' + paidProductionHash(alignmentCorrection?{ scope: funding.scope, key: 'voice:alignment', attempt: 1,correction:alignmentCorrection }:{ scope: funding.scope, key: 'voice:alignment', attempt: 0 });
    let alignmentReceiptRef = path.resolve(input.alignmentRoot || 'data/social-content-voice-alignment', sha(alignmentId) + '.json');
    // Native timestamps are part of the already-paid exact voice receipt.
    // Keep an unresolved ASR submission intact; it must never be reposted.
    let nativeCues: Array<{start:number;end:number;text:string}> | undefined;
    if(primary.provider==='heygen') {
      const original=JSON.parse(fs.readFileSync(sourceReceiptRefs[0]!,'utf8'));
      const response=original.response?.data||original.response;
      if(Array.isArray(response?.word_timestamps)&&response.word_timestamps.length) {
        const speed=ttsPostProcessingSpeed('heygen',Number(funding.voiceInput.style?.speed)||1);
        const {fit,result,cues:measured}=verifiedHeyGenNativeTiming(response,funding.voiceInput.text,speed,input.targetDuration,voice.duration);
        nativeCues=measured;
        alignmentReceiptRef=path.resolve(input.alignmentRoot||'data/social-content-voice-alignment',sha(JSON.stringify({audio:state.wholeTrackSha256,source:sha(fs.readFileSync(sourceReceiptRefs[0]!)),speed,fit,result}))+'.native.json');
        const evidence={state:'completed',scope:{audioSha256:state.wholeTrackSha256},result,source:'heygen_native',sourceReceiptRef:sourceReceiptRefs[0],sourceReceiptSha256:sha(fs.readFileSync(sourceReceiptRefs[0]!)),transform:{speed,fit}};
        if(fs.existsSync(alignmentReceiptRef)){if(sha(fs.readFileSync(alignmentReceiptRef))!==sha(JSON.stringify(evidence)))throw Error('native_voice_timing_evidence_changed');}
        else {fs.mkdirSync(path.dirname(alignmentReceiptRef),{recursive:true});fs.writeFileSync(alignmentReceiptRef,JSON.stringify(evidence),{flag:'wx',mode:0o600});}
      }
    }
    let cues: Array<{ start: number; end: number; text: string }>;
    if(nativeCues) { cues=nativeCues; }
    else if (state.status === 'completed' || state.status === 'audio_aligned') {
      await funding.permit.assertRecovery(alignmentId);
      const alignment = JSON.parse(fs.readFileSync(alignmentReceiptRef, 'utf8'));
      if (alignment.state !== 'completed' || alignment.scope?.audioSha256 !== state.wholeTrackSha256)
        throw Error('prepared_whole_voice_alignment_changed');
      cues = verifiedAudioCues(alignment.result, funding.voiceInput.text, voice.duration);
    } else {
      const aligned = await (input.align || alignStudioVoiceForAutomation)({ tenantId: funding.scope.tenantId,
        text: funding.voiceInput.text, url: voice.url, duration: voice.duration, paidContext,
        preparedTrack:{scope:funding.scope,receiptRef:stateFile,filePath:voice.localPath,audioSha256:state.wholeTrackSha256} });
      cues = aligned.cues;
    }
    // Persist the paid original performance before checking the whole-film
    // maximum. Visual cuts may cross sentences; the source track stays intact.
    persist({ ...state, status: 'audio_aligned', voice: { ...voice, cues }, proof: { sourceReceiptRefs, alignmentReceiptRef, nativeVoice: { provider: primary.provider, model: primary.model, physicalVoiceId: primary.voiceId } } });
    if (voice.duration > input.targetDuration + .02) {
      throw new WholeVoiceDurationRevisionRequired(stateFile, voice.duration, input.targetDuration);
    }
    measuredWholeTrackSceneRanges({ scenes: input.scenes, cues, durationSeconds: voice.duration });
    const result: PreparedWholeVoice = { voice: { ...voice, localPath: voice.localPath, duration: voice.duration, cues, alignmentSource: 'audio_ai' as any },
      inputHash, receiptRef:stateFile, wholeTrackSha256: state.wholeTrackSha256, sourceReceiptRefs, alignmentReceiptRef,
      nativeVoice: { provider: primary.provider, model: primary.model, physicalVoiceId: primary.voiceId } };
    persist({ ...state, status: 'completed', voice: result.voice, proof:{sourceReceiptRefs,alignmentReceiptRef,nativeVoice:result.nativeVoice} });
    return result;
  });
}

/** Provider-independent real scene audio. A video provider may upload these
 * bytes once under its own durable fence; no TTS is performed here. */
export async function readPreparedWholeVoiceScene(input: {
  prepared: PreparedWholeVoice;
  scope: Funding['scope'];
  shotId: string;
  memberShotIds?: string[];
  spokenText: string;
  assertCurrent: () => Promise<void>;
}) {
  await input.assertCurrent();
  const state=JSON.parse(fs.readFileSync(input.prepared.receiptRef,'utf8'));
  if(state.status!=='completed'||state.inputHash!==input.prepared.inputHash
    ||paidProductionHash(state.scope)!==paidProductionHash(input.scope)
    ||state.wholeTrackSha256!==input.prepared.wholeTrackSha256
    ||paidProductionHash(state.voice)!==paidProductionHash(input.prepared.voice)
    ||paidProductionHash(state.proof)!==paidProductionHash({sourceReceiptRefs:input.prepared.sourceReceiptRefs,alignmentReceiptRef:input.prepared.alignmentReceiptRef,nativeVoice:input.prepared.nativeVoice}))
    throw Error('prepared_whole_voice_scene_receipt_changed');
  if(sha(fs.readFileSync(input.prepared.voice.localPath))!==state.wholeTrackSha256)
    throw Error('prepared_whole_voice_bytes_changed');
  const alignmentBytes=fs.readFileSync(input.prepared.alignmentReceiptRef);
  const alignment=JSON.parse(alignmentBytes.toString());
  if(alignment.state!=='completed'||alignment.scope?.audioSha256!==state.wholeTrackSha256)
    throw Error('prepared_whole_voice_alignment_changed');
  const transcript=state.scenes.map((scene:{spokenText:string})=>scene.spokenText).filter(Boolean).join(' ');
  const cues=verifiedAudioCues(alignment.result,transcript,state.voice.duration);
  if(paidProductionHash(cues)!==paidProductionHash(state.voice.cues))throw Error('prepared_whole_voice_measured_cues_changed');
  const ranges=measuredWholeTrackSceneRanges({scenes:state.scenes,cues,durationSeconds:state.voice.duration});
  const frozenGroupScene=state.scenes.some((item:{shotId:string})=>item.shotId===input.shotId);
  const members=frozenGroupScene?[input.shotId]:input.memberShotIds?.length?input.memberShotIds:[input.shotId];
  if(new Set(members).size!==members.length)throw Error('prepared_whole_voice_scene_not_frozen');
  const memberScenes=members.map(id=>state.scenes.find((item:{shotId:string})=>item.shotId===id));
  const memberRanges=members.map(id=>ranges.get(id));
  if(memberScenes.some((scene:unknown)=>!scene)||memberRanges.some((range:unknown)=>!range))throw Error('prepared_whole_voice_scene_not_frozen');
  const scene={shotId:input.shotId,spokenText:memberScenes.map((item:any)=>item.spokenText).join(' '),durationSeconds:memberScenes.reduce((sum:number,item:any)=>sum+item.durationSeconds,0)};
  const range={start:memberRanges[0]!.start,end:memberRanges.at(-1)!.end};
  if(scene.spokenText!==input.spokenText||Math.abs((range.end-range.start)-scene.durationSeconds)>.02)throw Error('prepared_whole_voice_scene_not_frozen');
  const sourceReceipts=input.prepared.sourceReceiptRefs.map(receiptRef=>{
    const bytes=fs.readFileSync(receiptRef),raw=JSON.parse(bytes.toString());
    if(paidProductionHash(raw.scope)!==paidProductionHash(input.scope)||raw.provider!==input.prepared.nativeVoice.provider||raw.model!==input.prepared.nativeVoice.model||raw.voiceId!==input.prepared.nativeVoice.physicalVoiceId)
      throw Error('prepared_whole_voice_original_receipt_changed');
    return {receiptRef,sha256:sha(bytes),operationId:raw.operationId};
  });
  const key=paidProductionHash({scope:input.scope,shotId:input.shotId,members,range,wholeTrackSha256:state.wholeTrackSha256});
  const file=path.join(path.dirname(input.prepared.receiptRef),key+'.scene.wav');
  return withPaidOperationLock(path.join(path.dirname(file),'.locks'),key,async()=>{
    const execute=promisify(execFile);
    if(!fs.existsSync(file))await execute(ffmpegStatic||'ffmpeg',['-y','-i',state.voice.localPath,'-af',`apad=whole_dur=${range.end},atrim=start=${range.start}:end=${range.end},asetpts=PTS-STARTPTS`,'-ac','1','-ar','24000','-c:a','pcm_s16le',file],{timeout:30000});
    const pcm=await execute(ffmpegStatic||'ffmpeg',['-v','error','-i',file,'-f','s16le','-ac','1','-ar','24000','pipe:1'],{encoding:'buffer',maxBuffer:64*1024*1024,timeout:30000});
    const durationSeconds=pcm.stdout.length/(24000*2),bytes=fs.readFileSync(file);
    if(!(durationSeconds>0)||Math.abs(durationSeconds-(range.end-range.start))>.02||durationSeconds>scene.durationSeconds+.02)
      throw Error('presenter_scene_clip_probe_invalid');
    await input.assertCurrent();
    return {filePath:file,bytes,clipSha256:sha(bytes),durationSeconds,range,wholeTrackSha256:state.wholeTrackSha256,
      scope:input.scope,shotId:input.shotId,spokenText:scene.spokenText,nativeVoice:input.prepared.nativeVoice,
      sourceReceipts,alignmentReceiptRef:input.prepared.alignmentReceiptRef,alignmentReceiptSha256:sha(alignmentBytes),
      preparedReceiptRef:input.prepared.receiptRef,preparedReceiptSha256:sha(fs.readFileSync(input.prepared.receiptRef))};
  });
}
