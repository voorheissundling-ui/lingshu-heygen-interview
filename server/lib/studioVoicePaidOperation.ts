import {nativeVoiceBillableCharacters} from './studioVoiceBilling.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import type {SocialPaidOperationIntent} from './socialContentTaskBudgetAuthority.js';
import type {createSocialContentPaidOperationPermit} from './socialContentPaidOperationPermit.js';
export interface StudioVoicePaidRequest {
  stage: 'tts' | 'tts_fallback' | 'voice_clone' | 'voice_asr' | 'voice_alignment';
  provider: 'minimax' | 'qwen' | 'heygen'; model: string; voiceId: string | null;
  endpoint?: string; accountKeyHash?: string;
  request: Record<string,unknown>; audioSha256?: string; audioSeconds?: number;
}
export interface StudioVoicePaidCall {
 intent:SocialPaidOperationIntent;
 permit:ReturnType<typeof createSocialContentPaidOperationPermit>;
 assertProviderBinding(request:StudioVoicePaidRequest):Promise<void>;
 measureUsage(request:StudioVoicePaidRequest):Promise<Record<string,number>>;
 persistProviderReceipt(input:{requestSha256:string;response:unknown;audioSha256?:string;audioSeconds?:number}):Promise<string>;
}
export interface StudioVoicePaidContext {
 /** Read from the actual frozen native voice resolver, never from HTTP input. */
 primaryProvider:'minimax'|'qwen'|'heygen';
 persistAudioCacheProof?(input:{tenantId:string;text:string;logicalVoice:string;language:string;provider:string;audioSha256:string;durationSeconds:number}):Promise<void>;
 verifyCachedAudio?(input:{tenantId:string;text:string;logicalVoice:string;language:string;provider:string;audioSha256:string;durationSeconds:number}):Promise<boolean>;
 forRequest(request:StudioVoicePaidRequest):Promise<StudioVoicePaidCall>;
}
const storage=new AsyncLocalStorage<StudioVoicePaidContext>();
export class StudioVoicePaidBoundaryError extends Error {}
export function studioVoicePaidContext(){return storage.getStore();}
export function withStudioVoicePaidContext<T>(context:StudioVoicePaidContext|undefined,run:()=>T):T{return context?storage.run(context,run):run();}
export function rethrowStudioVoicePaidBoundary(error:unknown){if(error instanceof StudioVoicePaidBoundaryError)throw error;}
/** Unknown failures retain the original durable claim and cannot reach a
 * provider fallback. The actual body/usage are measured at each POST boundary. */
export async function submitStudioVoicePaidRequest<T>(input:StudioVoicePaidRequest,send:()=>Promise<T>):Promise<T>{
 const context=storage.getStore();if(!context)return send();
 const request=structuredClone(input);
 if(request.stage==='tts' && request.provider!==context.primaryProvider)request.stage='tts_fallback';
 try{
  if(!request.endpoint || !/^[a-f0-9]{64}$/.test(request.accountKeyHash||''))throw Error('voice_actual_provider_binding_missing');
  if(['voice_asr','voice_alignment'].includes(request.stage) && (!/^[a-f0-9]{64}$/.test(request.audioSha256||'') || !Number.isFinite(request.audioSeconds) || !(request.audioSeconds!>0)))throw Error('voice_asr_actual_audio_identity_missing');
  const call=await context.forRequest(request);
  if(call.intent.stage!==request.stage||call.intent.provider!==request.provider||call.intent.model!==request.model)throw Error('frozen_voice_paid_route_changed');
  await call.assertProviderBinding(request);
  const actualUnits=await call.measureUsage(request);
  const spoken=String(request.request.text ?? (request.request.input as any)?.text ?? '');
  if ('characters' in actualUnits && actualUnits.characters!==nativeVoiceBillableCharacters(spoken))throw Error('voice_actual_paid_characters_changed');
  if ('audioSeconds' in actualUnits && actualUnits.audioSeconds!==request.audioSeconds)throw Error('voice_actual_paid_audio_seconds_changed');
  const {maximumUnits:_,...binding}=call.intent;
  const requestSha256=createHash('sha256').update(JSON.stringify(request.request)).digest('hex');
  await call.permit.beforeSubmit({...binding,actualUnits});
  const response=await send();
  const receipt=await call.persistProviderReceipt({requestSha256,response,audioSha256:request.audioSha256,audioSeconds:request.audioSeconds});
  if(!receipt)throw Error('voice_paid_provider_receipt_missing');
  await call.permit.markOutcome(call.intent.operationId,'completed',receipt);
  return response;
 }catch(error){throw new StudioVoicePaidBoundaryError(String(error instanceof Error?error.message:error));}
}
