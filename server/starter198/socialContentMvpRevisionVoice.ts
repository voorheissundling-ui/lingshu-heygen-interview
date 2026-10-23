import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import type {DataStore} from '../storage/datastore.js';import {readContentExecutionJob} from '../contentExecution/durableQueue.js';
import {readMvpSpeechRevision} from '../lib/mvpSpeechRevisionReuse.js';import {readMvpHeyGenSpeechProviderEvidence} from '../lib/mvpHeyGenSpeech.js';
import {createCanonicalVoiceAssembly,type CanonicalVoiceCue,type CanonicalVoiceTrack} from '../lib/socialContentCanonicalVoiceAssembly.js';import {socialObject} from './socialContentValidation.js';import type {StudioAdoptionScope} from './socialContentStudioAdoption.js';
const tokens=(s:string)=>s.toLowerCase().match(/[\p{L}\p{N}]+/gu)??[];
/** Reads verified revision-reuse receipts, original provider words, and the immutable graph director timeline. */
export interface MvpRevisionVoiceInput {dataStore:DataStore;scope:StudioAdoptionScope;hookRef:string;bodyRef:string;authorityRoot:string}
export function createMvpRevisionVoiceRuntime(input:MvpRevisionVoiceInput){return createCanonicalVoiceAssembly({tenantId:input.scope.tenantId,durationSeconds:24,silentIntervals:[{start:10.1,end:14.1},{start:18.8,end:20.5}],outputDirectory:path.join(input.authorityRoot,'data/mvp-voice-assemblies'),readCanonicalCues:()=>readMvpRevisionVoiceCues(input)});}
export async function readMvpRevisionVoiceCues(input:MvpRevisionVoiceInput):Promise<CanonicalVoiceCue[]>{
const dataRoot=fs.realpathSync(path.join(input.authorityRoot,'data')),hook=readMvpSpeechRevision(input.hookRef,path.join(dataRoot,'mvp-speech-revision-reuse')),body=readMvpSpeechRevision(input.bodyRef,path.join(dataRoot,'mvp-speech-revision-reuse'));
const job=await readContentExecutionJob(input.dataStore,input.scope.tenantId,input.scope.taskId,input.scope.runId),binding=socialObject(job?.checkpoints['social.executor']?.payload),approved=socialObject(binding?.approvedContext);
if(!job||job.id!==input.scope.jobId||[hook,body].some(audio=>audio.tenantId!==input.scope.tenantId||audio.taskId!==input.scope.taskId||audio.runId!==input.scope.runId||audio.taskVersion!==Number(approved?.version)||audio.targetIdentity.planHash!==approved?.revisionPlanHash))throw Error('canonical_voice_revision_scope_changed');
const hookSource=(hook.sourceResult as unknown as {source:{sourceReceiptRef:string}}).source?.sourceReceiptRef;if(!hookSource)throw Error('canonical_hook_source_lineage_missing');
const hookRow=JSON.parse(fs.readFileSync(path.join(dataRoot,'mvp-heygen-speech',hookSource+'.json'),'utf8')),hookEvidence=hookRow.provider?.responseEvidence;
if(createHash('sha256').update(JSON.stringify(hookEvidence)).digest('hex')!==hook.providerEvidenceSha256)throw Error('canonical_hook_provider_words_changed');
const bodyEvidence=readMvpHeyGenSpeechProviderEvidence(body.sourceRef,path.join(dataRoot,'mvp-heygen-speech')) as {data?:{word_timestamps?:Array<{word:string;start:number;end:number}>}};
const parse=(e:any)=>{if(!Array.isArray(e?.data?.word_timestamps))throw Error('canonical_provider_word_timing_missing');return e.data.word_timestamps.filter((w:any)=>!/^<.*>$/.test(String(w.word))).map((w:any)=>({text:String(w.word),start:Number(w.start),end:Number(w.end)}));};
const hookWords=parse(hookEvidence),bodyWords=parse(bodyEvidence);let cursor=0;const result:CanonicalVoiceCue[]=[];
const director=socialObject(socialObject(approved?.agentWorkflow)?.directorBrief),scenes=director?.scenes as Array<{sceneId:string;audioLayers:{voiceover:string|null};duration:{startSeconds:number;endSeconds:number;targetSeconds:number}}>;
if(!Array.isArray(scenes)||scenes.length!==8)throw Error('canonical_voice_frozen_scenes_missing');
for(const scene of scenes){const text=scene.audioLayers.voiceover?.trim();if(!text)continue;const isHook=scene.sceneId==='S01',trackResult=isHook?hook:body;const expected=tokens(text),all=isHook?hookWords:bodyWords;const offset=isHook?0:cursor;let consumed=0;const selected=[];while(offset+consumed<all.length&&selected.flatMap(w=>tokens(w.text)).length<expected.length)selected.push(all[offset+consumed++]);
if(selected.flatMap(w=>tokens(w.text)).join(' ')!==expected.join(' '))throw Error('canonical_voice_provider_words_do_not_match_frozen_copy');
if(!isHook)cursor+=consumed;
const start=isHook?0:Math.max(0,selected[0].start-.04),end=isHook?trackResult.durationSeconds:Math.min(trackResult.durationSeconds,selected.at(-1)!.end+.04);
if(!isHook&&(offset>0&&all[offset-1].end>start||offset+consumed<all.length&&all[offset+consumed].start<end))throw Error('canonical_voice_context_padding_touches_neighbor');
const track:CanonicalVoiceTrack={filePath:trackResult.filePath,sha256:trackResult.clipSha256,durationSeconds:trackResult.durationSeconds,receiptRef:trackResult.receiptRef,receiptHash:trackResult.receiptHash,providerEvidenceRef:`provider_word_evidence:${trackResult.providerEvidenceSha256}`};
result.push({sceneId:scene.sceneId,text,startSeconds:scene.duration.startSeconds,endSeconds:scene.duration.endSeconds,track,sourceStartSeconds:start,sourceEndSeconds:end,words:selected,...(isHook?{keepCompleteTrack:true}:{boundaryPaddingSeconds:.04 as const})});
}
if(cursor!==bodyWords.length||tokens(result[0]?.text??'').join(' ')!==hookWords.flatMap((w:any)=>tokens(w.text)).join(' '))throw Error('canonical_voice_words_dropped');return result;
}
