import fs from 'node:fs';import path from 'node:path';import{createHash,randomUUID}from'node:crypto';import{execFile}from'node:child_process';import{promisify}from'node:util';import ffmpegStatic from 'ffmpeg-static';
import{mvpHeyGenSpeechFingerprint,type MvpHeyGenSpeechInput,type MvpHeyGenSpeechResult}from'./mvpHeyGenSpeech.js';
import{withPaidOperationLock}from'./paidOperationLock.js';import type{MvpExecutionScope}from'../../shared/mvpExecutionScope.js';
const hash=(x:string|Uint8Array)=>createHash('sha256').update(x).digest('hex');const defaultRoot=()=>path.resolve('data/mvp-heygen-speech-adoptions');
export interface SpeechPresenterBinding { presenterAssetId:string; presenterAssetVersion:number; providerAvatarId:string; voiceId:string; }
function samePresenter(a:SpeechPresenterBinding,b:SpeechPresenterBinding){return a.presenterAssetId===b.presenterAssetId&&a.presenterAssetVersion===b.presenterAssetVersion&&a.providerAvatarId===b.providerAvatarId&&a.voiceId===b.voiceId;}
export interface SpeechAdoptionInput { sourceReceiptRef:string;sourceReceiptSha256:string;sourceAudioSha256:string;sourceProviderEvidenceSha256:string;
 targetScope:MvpExecutionScope;targetShotId:string;targetText:string;frozenHookDurationSeconds:number;presenter:SpeechPresenterBinding; }
export interface SpeechSourceEvidence { sourceReceiptRef:string;sourceReceiptSha256:string;sourceAudioSha256:string;sourceProviderEvidenceSha256:string;
 sourceScope:MvpExecutionScope;sourceReservationCny:number;sourceOperationId:string;actualCostCny:null;providerRequestId:string|null;reportedDurationSeconds:number; }
export interface AdoptedMvpHeyGenSpeech extends MvpHeyGenSpeechResult { adoption:true;presenter:SpeechPresenterBinding;source:SpeechSourceEvidence; }
export interface SpeechAdoptionPorts { sourceRoot?:string;root?:string;probe?:(file:string)=>Promise<number>;
 /** Must load original frozen/source evidence and current actual task/person/voice/text/spec. */
 assertSourceAndTargetBinding:(source:MvpHeyGenSpeechInput,input:SpeechAdoptionInput)=>Promise<{source:SpeechPresenterBinding;target:SpeechPresenterBinding}>;
 /** Reads real reallocated pool grant AND source TTS pool/legacy entries, without reserving/refunding. */
 authorizeAdoption:(input:SpeechAdoptionInput,evidence:SpeechSourceEvidence)=>Promise<void>;
}
function source(input:SpeechAdoptionInput,root:string){
 if(![input.sourceReceiptRef,input.sourceReceiptSha256,input.sourceAudioSha256,input.sourceProviderEvidenceSha256].every(x=>/^[a-f0-9]{64}$/.test(x)))throw Error('speech_adoption_source_invalid');
 const bytes=fs.readFileSync(path.join(root,input.sourceReceiptRef+'.json'));if(hash(bytes)!==input.sourceReceiptSha256)throw Error('speech_adoption_source_receipt_changed');
 const row=JSON.parse(bytes.toString());if(row.schemaVersion!==1||row.fingerprint!==input.sourceReceiptRef||mvpHeyGenSpeechFingerprint(row.input)!==input.sourceReceiptRef
  ||!['accepted','completed'].includes(row.state)||row.input.operationRole!=='hook'||row.provider?.engine!=='starfish'||!row.provider.responseEvidence
  ||hash(JSON.stringify(row.provider.responseEvidence))!==input.sourceProviderEvidenceSha256)throw Error('speech_adoption_source_receipt_corrupt');
 const response=row.provider.responseEvidence.data||row.provider.responseEvidence;
 if(response.engine!=='starfish'||response.duration!==row.provider.duration||response.audio_url!==row.provider.audioUrl||(response.request_id??null)!==(row.provider.requestId??null)||!Number.isFinite(row.provider.duration)||row.provider.duration<=0)throw Error('speech_adoption_provider_evidence_mismatch');
 const s=row.input.scope,t=input.targetScope;if(s.tenantId!==t.tenantId||s.taskId!==t.taskId||s.productId!==t.productId||s.accountId!==t.accountId
  ||s.provider!=='heygen'||s.model!=='starfish'||t.provider!=='heygen'||t.model!=='starfish'||t.action!=='generate_media'||t.session!=='A'
  ||t.revoked!==false||!Number.isFinite(Date.parse(t.expiresAt))||Date.parse(t.expiresAt)<=Date.now()||!t.shotIds.includes(input.targetShotId)
  ||!['customer','authorized_business_reviewer'].includes(t.authority)||![t.authorizationRef,t.authorizedBy,t.budgetPoolId,input.presenter.presenterAssetId,input.presenter.providerAvatarId,input.presenter.voiceId].every(v=>typeof v==='string'&&v.trim())||!Number.isSafeInteger(input.presenter.presenterAssetVersion)||input.presenter.presenterAssetVersion<1||!Number.isFinite(t.budgetLimitCny)||t.budgetLimitCny<=0
  ||!Number.isSafeInteger(t.version)||t.version<=s.version||!t.runId||t.runId===s.runId||row.input.voiceId!==input.presenter.voiceId||row.input.text!==input.targetText
  ||!Number.isFinite(input.frozenHookDurationSeconds)||input.frozenHookDurationSeconds<=4||input.frozenHookDurationSeconds>6)throw Error('speech_adoption_scope_or_frozen_spec_mismatch');
 const file=path.join(path.resolve(root),'audio',hash(s.tenantId),input.sourceReceiptRef+'.mp3');const audio=fs.readFileSync(file);if(hash(audio)!==input.sourceAudioSha256)throw Error('speech_adoption_source_audio_changed');
 const evidence:SpeechSourceEvidence={sourceReceiptRef:input.sourceReceiptRef,sourceReceiptSha256:input.sourceReceiptSha256,sourceAudioSha256:input.sourceAudioSha256,
  sourceProviderEvidenceSha256:input.sourceProviderEvidenceSha256,sourceScope:s,sourceReservationCny:row.input.reservationCny,sourceOperationId:`mvp-tts:${input.sourceReceiptRef}`,
  actualCostCny:null,providerRequestId:row.provider.requestId??null,reportedDurationSeconds:row.provider.duration};
 return{row,file,audio,evidence};
}
async function probe(file:string){const decoded=await promisify(execFile)(process.env.FFMPEG_PATH||ffmpegStatic||'ffmpeg',['-hide_banner','-i',file,'-vn','-ac','1','-ar','48000','-f','s16le','pipe:1'],{encoding:'buffer',maxBuffer:4000000,timeout:45000});if(!/Audio:/.test(String(decoded.stderr)))throw Error('speech_adoption_probe_failed');return decoded.stdout.length/(48000*2);}
export async function adoptAcceptedMvpHeyGenSpeech(input:SpeechAdoptionInput,ports:SpeechAdoptionPorts):Promise<AdoptedMvpHeyGenSpeech>{
 const root=path.resolve(ports.root||defaultRoot()),sourceRoot=path.resolve(ports.sourceRoot||'data/mvp-heygen-speech');const s=source(input,sourceRoot);
 const bindings=await ports.assertSourceAndTargetBinding(s.row.input,input);if(!samePresenter(bindings.source,input.presenter)||!samePresenter(bindings.target,input.presenter))throw Error('speech_adoption_original_presenter_changed');
 await ports.authorizeAdoption(input,s.evidence);const duration=await(ports.probe||probe)(s.file);
 if(!Number.isFinite(duration)||duration<=0||duration>input.frozenHookDurationSeconds||Math.abs(duration-s.evidence.reportedDurationSeconds)>.15)throw Error('speech_adoption_duration_mismatch');
 const ref=hash(JSON.stringify(input));fs.mkdirSync(root,{recursive:true,mode:0o700});return withPaidOperationLock(path.join(root,'.locks'),ref,async()=>{
  const file=path.join(root,ref+'.json');if(fs.existsSync(file))return readAdoptedMvpHeyGenSpeech(ref,root);
  // Recheck source just before writing. Source row and original preoccupations remain untouched.
  const fresh=source(input,sourceRoot);const freshBindings=await ports.assertSourceAndTargetBinding(fresh.row.input,input);if(!samePresenter(freshBindings.source,input.presenter)||!samePresenter(freshBindings.target,input.presenter))throw Error('speech_adoption_original_presenter_changed');await ports.authorizeAdoption(input,fresh.evidence);
  const dir=path.join(root,'audio',hash(input.targetScope.tenantId));fs.mkdirSync(dir,{recursive:true,mode:0o700});const filePath=path.join(dir,ref+'.mp3');if(fs.existsSync(filePath)){if(hash(fs.readFileSync(filePath))!==input.sourceAudioSha256)throw Error('speech_adoption_output_corrupt');}else{const audioTemp=filePath+'.'+randomUUID()+'.tmp';fs.writeFileSync(audioTemp,fresh.audio,{mode:0o600,flag:'wx'});fs.renameSync(audioTemp,filePath);}
  const body={adoption:true as const,receiptRef:ref,tenantId:input.targetScope.tenantId,taskId:input.targetScope.taskId,taskVersion:input.targetScope.version,accountId:input.targetScope.accountId,
   runId:input.targetScope.runId,shotId:input.targetShotId,operationRole:'hook' as const,maxDurationSeconds:input.frozenHookDurationSeconds,voiceId:input.presenter.voiceId,scriptSha256:hash(input.targetText),
   clipSha256:input.sourceAudioSha256,durationSeconds:duration,filePath,providerRequestId:fresh.evidence.providerRequestId,providerEvidenceSha256:input.sourceProviderEvidenceSha256,
   usage:{reportedDurationSeconds:fresh.evidence.reportedDurationSeconds,actualCostCny:null},presenter:input.presenter,source:fresh.evidence};
  const result={...body,receiptHash:hash(JSON.stringify(body))};const temp=file+'.'+randomUUID()+'.tmp';fs.writeFileSync(temp,JSON.stringify({schemaVersion:1,sourceRoot,input,result}),{mode:0o600});fs.renameSync(temp,file);return result;
 });
}
export function readAdoptedMvpHeyGenSpeech(ref:string,root=defaultRoot()):AdoptedMvpHeyGenSpeech{
 if(!/^[a-f0-9]{64}$/.test(ref))throw Error('speech_adoption_ref_invalid');const row=JSON.parse(fs.readFileSync(path.join(root,ref+'.json'),'utf8'));const r=row.result as AdoptedMvpHeyGenSpeech;
 if(!r)throw Error('speech_adoption_receipt_missing');const{receiptHash,...body}=r;const i=row.input as SpeechAdoptionInput;
 if(typeof row.sourceRoot!=='string')throw Error('speech_adoption_source_root_missing');
 const originalBytes=fs.readFileSync(path.join(row.sourceRoot,i.sourceReceiptRef+'.json'));const original=JSON.parse(originalBytes.toString());
 if(hash(originalBytes)!==i.sourceReceiptSha256||hash(JSON.stringify(original.provider?.responseEvidence))!==i.sourceProviderEvidenceSha256||JSON.stringify(r.source.sourceScope)!==JSON.stringify(original.input?.scope)||r.source.sourceReservationCny!==original.input?.reservationCny||r.providerRequestId!==(original.provider?.requestId??null)||r.usage.reportedDurationSeconds!==original.provider?.duration)throw Error('speech_adoption_source_lineage_changed');
 const expectedPath=path.join(path.resolve(root),'audio',hash(i.targetScope.tenantId),ref+'.mp3');
 if(row.schemaVersion!==1||hash(JSON.stringify(i))!==ref||r.receiptRef!==ref||hash(JSON.stringify(body))!==receiptHash||path.resolve(r.filePath)!==expectedPath||hash(fs.readFileSync(r.filePath))!==i.sourceAudioSha256
  ||r.clipSha256!==i.sourceAudioSha256||r.providerEvidenceSha256!==i.sourceProviderEvidenceSha256||r.source.sourceReceiptSha256!==i.sourceReceiptSha256||r.source.sourceReceiptRef!==i.sourceReceiptRef
  ||r.tenantId!==i.targetScope.tenantId||r.taskId!==i.targetScope.taskId||r.taskVersion!==i.targetScope.version||r.runId!==i.targetScope.runId||r.accountId!==i.targetScope.accountId
  ||r.voiceId!==i.presenter.voiceId||!samePresenter(r.presenter,i.presenter)||r.scriptSha256!==hash(i.targetText)||r.shotId!==i.targetShotId||r.maxDurationSeconds!==i.frozenHookDurationSeconds
  ||r.operationRole!=='hook'||r.adoption!==true||!Number.isFinite(r.durationSeconds)||r.durationSeconds<=0||r.durationSeconds>i.frozenHookDurationSeconds||i.frozenHookDurationSeconds>6
  ||r.source.actualCostCny!==null||r.usage.actualCostCny!==null)throw Error('speech_adoption_receipt_corrupt');return r;
}
