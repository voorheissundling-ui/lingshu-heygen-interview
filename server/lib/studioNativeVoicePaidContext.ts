import {nativeVoiceBillableCharacters} from './studioVoiceBilling.js';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {resolveStudioVoiceExecutionPlan} from '../routes/studio.js';
import {productionBillingAccountRef} from '../starter198/socialContentProductionBudgetRoutes.js';
import {paidProductionHash,type PaidStageRequirement,type BoundPaidRoute} from '../starter198/socialContentPaidOperationPlan.js';
import type {SocialTaskBudgetScope} from './socialContentTaskBudget.js';
import type {SocialPaidOperationIntent} from './socialContentTaskBudgetAuthority.js';
import type {createSocialContentPaidOperationPermit} from './socialContentPaidOperationPermit.js';
import type {StudioVoicePaidContext,StudioVoicePaidRequest} from './studioVoicePaidOperation.js';
const sha=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
type VoiceInput=Parameters<typeof resolveStudioVoiceExecutionPlan>[0];
export function nativeStudioVoiceReceiptPath(scope:SocialTaskBudgetScope,operationId:string,root=path.resolve('data/social-content-native-voice-receipts')) {
 return path.join(root,sha(scope.tenantId),sha(scope.taskId),sha(scope.runId),sha(operationId)+'.json');
}

/** Trusted runtime factory. Uses automatic canonical requirements and real live
 * Studio voices. No body supplied pricing, routes, account or receipt paths. */
export function createNativeStudioVoicePaidContext(input:{scope:SocialTaskBudgetScope;requirements:PaidStageRequirement[];routeBindings:Record<string,BoundPaidRoute>;intents:SocialPaidOperationIntent[];permit:ReturnType<typeof createSocialContentPaidOperationPermit>;voiceInput:VoiceInput;assertCurrent:()=>Promise<void>;root?:string}):StudioVoicePaidContext {
 const nativeRoute=input.routeBindings['voice:0:tts'];
 const selectedProvider:'qwen'|'minimax'|'heygen'|undefined=nativeRoute?.provider==='qwen'||nativeRoute?.provider==='minimax'||nativeRoute?.provider==='heygen'?nativeRoute.provider:undefined;
 const voiceInput={...input.voiceInput,...(selectedProvider?{nativeProvider:selectedProvider}:{})};
 const plan=resolveStudioVoiceExecutionPlan(voiceInput);
 if(!plan.primary)throw Error('native_voice_route_requires_exact_clone_or_provider_plan');
 const primary=plan.primary;
 const root=path.join(input.root||path.resolve('data/social-content-native-voice-receipts'),sha(input.scope.tenantId),sha(input.scope.taskId));
 const completed=new Map<string,string>();
 const write=(file:string,row:unknown)=>{
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  if(fs.existsSync(file)){if(sha(JSON.parse(fs.readFileSync(file,'utf8')))!==sha(row))throw Error('native_voice_original_receipt_conflict');return;}
  const temp=file+'.'+randomUUID()+'.tmp';const fd=fs.openSync(temp,'wx',0o600);
  try{fs.writeFileSync(fd,JSON.stringify(row));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  try{fs.linkSync(temp,file);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST'||sha(JSON.parse(fs.readFileSync(file,'utf8')))!==sha(row))throw Error('native_voice_original_receipt_conflict');}
  finally{fs.unlinkSync(temp);}
  const dir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
 };
 const cacheKey=(record:{text:string;logicalVoice:string;language:string;provider:string;audioSha256:string})=>sha(record);
 const cacheFile=(record:{text:string;logicalVoice:string;language:string;provider:string;audioSha256:string})=>path.join(root,'audio-proof',cacheKey(record)+'.json');
 const selectedText=(r:StudioVoicePaidRequest)=>String(r.request.text??(r.request.input as any)?.text??'');
 const providerName=(source:string)=>source==='qwen_tts'?'qwen':source;
 return {
  primaryProvider:primary.provider,
  async forRequest(request){
   await input.assertCurrent();
   if(request.stage==='voice_asr'&&input.intents.some(intent=>intent.correction?.cause==='approved_first_frame_not_consumed_and_bound_voice_mismatch'))throw Error('corrected_bound_voice_forbids_legacy_asr');
   // Fallback candidates in the resolver are configuration, not same-voice
   // permission. Only a separately frozen exact route may add that in future.
   if(request.stage==='tts_fallback')throw Error('same_voice_fallback_route_not_frozen');
   if(request.stage==='voice_clone')throw Error('clone_preview_activation_paid_plan_required');
   const index=['voice_asr','voice_alignment'].includes(request.stage)?0:primary.texts.indexOf(selectedText(request));
   if(index<0)throw Error('director_voice_text_changed_requires_budget_replan');
   const key=request.stage==='voice_alignment'?'voice:alignment':request.stage==='voice_asr'?'voice:asr':`voice:${index}:tts`;
   const requirements=input.requirements.filter(r=>r.key===key);
   const requirement=requirements[0],route=input.routeBindings[key];
   if(requirements.length!==1 || !requirement || !route)throw Error('native_voice_canonical_requirement_route_missing');
   if(request.stage==='tts' && requirement.text!==plan.texts[index])throw Error('director_voice_text_changed_requires_budget_replan');
   const corrections=input.intents.filter(i=>i.correction&&i.stage===request.stage&&i.correction.kind===(request.stage==='tts'?'voice_tts':'voice_alignment'));
   if(corrections.length>1)throw Error('native_voice_correction_ambiguous');
   const correction=corrections[0]?.correction;
   const operationId=correction?'paid-plan:'+paidProductionHash({scope:input.scope,key,attempt:1,correction}):'paid-plan:'+paidProductionHash({scope:input.scope,key,attempt:0});
   const intents=input.intents.filter(i=>i.operationId===operationId),intent=intents[0];
   const expected=correction?paidProductionHash({requirement,route,attempt:1,correction}):paidProductionHash({requirement,route,attempt:0});
   if(intents.length!==1||!intent||intent.inputContractHash!==expected||intent.provider!==route.provider||intent.model!==route.model||intent.accountRef!==route.accountRef||intent.stage!==requirement.stage||intent.shotId!==requirement.shotId||paidProductionHash(intent.maximumUnits)!==paidProductionHash(route.maximumUnits))throw Error('native_voice_canonical_intent_changed');
   return {
    intent,permit:input.permit,
    async assertProviderBinding(actual){
     await input.assertCurrent();
     const live=resolveStudioVoiceExecutionPlan(voiceInput);
     if(sha({primary:live.primary,mode:live.mode,texts:live.texts,custom:live.custom})!==sha({primary:plan.primary,mode:plan.mode,texts:plan.texts,custom:plan.custom}))throw Error('native_voice_live_route_changed');
     if(actual.stage==='tts' && (actual.provider!==primary.provider||actual.model!==primary.model||actual.voiceId!==primary.voiceId||actual.accountKeyHash!==primary.accountKeyHash||actual.endpoint!==primary.endpoint))throw Error('native_voice_actual_provider_voice_changed');
     if(actual.provider!==route.provider||actual.model!==route.model)throw Error('native_voice_tariff_route_changed');
     // ASR account validation uses the actual credential-bound accountRef.
     if(!actual.accountKeyHash||route.accountRef!==productionBillingAccountRef(actual.provider,actual.stage==='voice_asr'?(actual.endpoint||'').replace(/\/chat\/completions$/, ''):actual.endpoint||'',actual.accountKeyHash))throw Error('native_voice_actual_account_changed');
    },
    async measureUsage(actual){
     const units:Record<string,number>={};
     for(const dimension of Object.keys(intent.maximumUnits)){
      if(dimension==='characters')units.characters=nativeVoiceBillableCharacters(selectedText(actual));
      else if(dimension==='audioSeconds'||dimension==='providerSeconds'){if(!actual.audioSeconds)throw Error('native_voice_actual_audio_duration_missing');units[dimension]=actual.audioSeconds;}
      else if(dimension==='requests')units.requests=1;
      else throw Error('native_voice_provider_usage_dimension_unverified:'+dimension);
     }
     return units;
    },
    async persistProviderReceipt(receipt){
     const file=path.join(root,sha(input.scope.runId),sha(operationId)+'.json');
     const row={schemaVersion:1,scope:input.scope,operationId,inputContractHash:intent.inputContractHash,provider:request.provider,model:request.model,voiceId:request.voiceId,endpoint:request.endpoint,accountKeyHash:request.accountKeyHash,requestSha256:receipt.requestSha256,response:receipt.response,audioSha256:receipt.audioSha256??null,audioSeconds:receipt.audioSeconds??null,humanApproved:false};
     write(file,row);if(request.stage==='tts')completed.set(String(index),file);return file;
    },
   };
  },
  async persistAudioCacheProof(record){
   const index=plan.texts.indexOf(record.text),receipt=index>=0?completed.get(String(index)):null;
   if(!receipt||record.tenantId!==input.scope.tenantId||record.logicalVoice!==plan.logicalVoice||record.language!==plan.language||providerName(record.provider)!==primary.provider)throw Error('native_voice_audio_cache_receipt_binding_missing');
   const key={text:record.text,logicalVoice:record.logicalVoice,language:record.language,provider:record.provider,audioSha256:record.audioSha256};
   write(cacheFile(key),{...record,providerVoiceId:primary.voiceId,accountKeyHash:primary.accountKeyHash,receipt,receiptSha256:sha(JSON.parse(fs.readFileSync(receipt,'utf8')))});
  },
  async verifyCachedAudio(record){
   await input.assertCurrent();const key={text:record.text,logicalVoice:record.logicalVoice,language:record.language,provider:record.provider,audioSha256:record.audioSha256};const file=cacheFile(key);
   if(!fs.existsSync(file))return false;const proof=JSON.parse(fs.readFileSync(file,'utf8'));
   if(record.tenantId!==input.scope.tenantId||record.audioSha256!==proof.audioSha256||record.durationSeconds!==proof.durationSeconds||record.logicalVoice!==plan.logicalVoice||record.language!==plan.language||providerName(record.provider)!==primary.provider||proof.providerVoiceId!==primary.voiceId||proof.accountKeyHash!==primary.accountKeyHash)return false;
   const receipt=path.resolve(proof.receipt||'');if(!receipt.startsWith(path.resolve(root)+path.sep)||!fs.existsSync(receipt))return false;
   const raw=JSON.parse(fs.readFileSync(receipt,'utf8'));return raw.scope?.tenantId===input.scope.tenantId&&raw.scope?.taskId===input.scope.taskId&&sha(raw)===proof.receiptSha256&&raw.voiceId===primary.voiceId&&raw.accountKeyHash===primary.accountKeyHash;
  },
 };
}
