import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import type {DataStore,Record_} from '../storage/datastore.js';
import {store as routeStore} from '../storage/index.js';
import type {SocialInspirationCollectionRun,SocialDiscoveryMode} from '../../shared/contracts/socialContentWorkflow.js';
import type {VersionedSocialRef} from '../../shared/contracts/socialProgram.js';
import type {WeeklyPreproductionRetryAttempt} from './weeklyPreproductionRetryAttempts.js';
import {socialJson,socialObject,socialRequestHash} from '../starter198/socialContentValidation.js';
import {createR3CandidateEvidenceAdapter} from '../socialDiscovery/r3CandidateEvidenceAdapter.js';
import {runCandidateEvidenceWorker} from '../socialDiscovery/candidateEvidenceWorker.js';
import {hasCompletedExactVideoEvidence} from '../lib/videoAnalysisCodec.js';
import {probeReferenceMediaClock} from '../lib/referenceMediaClock.js';
import {classifyDiscoverySourceFailure} from '../socialDiscovery/sourceFailure.js';

export const CANDIDATE_REASSESSMENTS='social_weekly_candidate_reassessments';
export const CANDIDATE_ANALYSIS_OPERATIONS='social_weekly_candidate_analysis_operations';
export const CANDIDATE_ANALYSIS_RECEIPTS='social_weekly_candidate_analysis_receipts';
const obj=(v:unknown):Record<string,unknown>=>socialObject(socialJson(v))??{};
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../data/media');
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
export interface CandidateReassessment {
 schema:'weekly-candidate-reassessment.v1';id:string;tenantId:string;programId:string;packageId:string;packageVersion:number;taskId:string;jobId:string;consumerInputHash:string;
 parentRunId:string;parentRunHash:string;candidateSnapshots:Array<{id:string;hash:string}>;
 evidenceOutcomes:NonNullable<SocialInspirationCollectionRun['evidenceOutcomes']>;
 newCollectionRequests:0;newCollectionCostCny:0;analysisCostState:'retained_unknown';createdAt:string;recordHash:string;
}
export interface CandidateReassessmentPorts {
 analyze?:(record:Record_)=>Promise<void>;
 evidence?:typeof runCandidateEvidenceWorker;
 mediaRoot?:string;
}
const allowedIds=(run:SocialInspirationCollectionRun)=>[...new Set(Object.values(run.evidenceOutcomes??{}).flatMap(outcome=>outcome?.suggestionCandidateIds??[]))];
function origin(record:Record_,job:WeeklyPreproductionRetryAttempt,run:SocialInspirationCollectionRun){
 const analysis=obj(record.aiAnalysis);const origins=analysis.discoveryOrigins;
 return (Array.isArray(origins)?origins:[]).map(obj).find(o=>o.runId===run.runId&&o.scopeId===job.authority?.scopeId&&o.scopeVersion===job.authority?.scopeVersion&&job.retry.sourceSelection.some(s=>s.mode===o.mode&&s.platform===record.platform&&s.queryRef===o.queryRef));
}
export async function verifiedWeeklyCandidateMedia(record:Record_,mediaRoot:string){
 const a=obj(record.aiAnalysis),g=obj(a.gemini),clock=obj(g.sourceMediaClock);
 if(a.analysisQuality!=='video'||!hasCompletedExactVideoEvidence(a)||!a.analysisRunId||clock.analysisRunId!==a.analysisRunId||!/^[a-f0-9]{64}$/.test(String(clock.sourceSha256)))return false;
 const expected=`tenants/${record.tenantId}/reference-videos/${record.id}.mp4`;
 if(record.videoFileId!==expected||a.contentSha256!==clock.sourceSha256)return false;
 const absolute=await fs.realpath(path.resolve(mediaRoot,expected)).catch(()=>null),tenantRoot=await fs.realpath(path.resolve(mediaRoot,'tenants',String(record.tenantId))).catch(()=>null);
 if(!absolute||!tenantRoot||!absolute.startsWith(tenantRoot+path.sep))return false;
 const bytes=await fs.readFile(absolute);if(!bytes.length||hash(bytes)!==clock.sourceSha256)return false;
 const measured=await probeReferenceMediaClock(absolute);
 return Math.abs(measured.duration-Number(clock.duration))<.15;
}
const verifiedMedia=verifiedWeeklyCandidateMedia;
async function analyze(record:Record_){
 const {analyzeSourceVideoJob,downloadVideoForAnalysis}=await import('../routes/videos.js');
 const a=obj(record.aiAnalysis),operationId=socialRequestHash({tenantId:record.tenantId,candidateId:record.id,sourceUrl:record.sourceUrl,queuedAt:a.analysisQueuedAt??a.importedAt??record.crawledAt});
 await analyzeSourceVideoJob({record:{...record,aiAnalysis:{...a,analysisRunId:operationId}},sourceUrl:String(record.sourceUrl),title:String(record.title??''),platform:record.platform as 'tiktok'|'youtube'|'facebook'|'instagram',suppressOpsRequeue:true,suppressVisibleBackfill:true},{download:async input=>{
  const downloaded=await downloadVideoForAnalysis({...input,allowPaidFallback:false,allowCookieFallback:false});
  const bytes=await fs.readFile(downloaded.filePath);await probeReferenceMediaClock(downloaded.filePath);
  const relative=`tenants/${record.tenantId}/reference-videos/${record.id}.mp4`,target=path.resolve(root,relative);
  await fs.mkdir(path.dirname(target),{recursive:true});
  try{await fs.writeFile(target,bytes,{flag:'wx'});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST'||hash(await fs.readFile(target))!==hash(bytes))throw Error('weekly_candidate_owned_media_changed');}
  const fresh=await routeStore.getById<Record_>('trend_videos',record.id);if(!fresh||fresh.tenantId!==record.tenantId)throw Error('weekly_candidate_scope_changed');
  await routeStore.update('trend_videos',record.id,{videoFileId:relative,aiAnalysis:JSON.stringify({...obj(fresh.aiAnalysis),contentSha256:hash(bytes)})});
  return downloaded;
 },compressPreview:async()=>{throw Error('weekly_scoped_analysis_uses_verified_local_media');}});
}

/** Only consumes committed candidates of this exact attempt; never crawls. */
export async function reassessWeeklyCandidates(store:DataStore,job:WeeklyPreproductionRetryAttempt,run:SocialInspirationCollectionRun,ports:CandidateReassessmentPorts={}){
 const ids=allowedIds(run);if(!job.retry||!ids.length||!['failed','partial','stopped','succeeded'].includes(run.status))return {ready:false,code:'weekly_candidate_analysis_unavailable',item:null};
 const revised=await (await import('./weeklyCandidateModelRevision.js')).consumeCandidateModelRevision(store,job,ids,ports.mediaRoot??root);
 let spentAnalysisSlot=revised.spentSlot;const records:Record_[]=[],pending:string[]=revised.code?[revised.code]:[];
 // Historical definite model rejection is scoped to these exact committed
 // candidates. Do not rewrite its operation or try another candidate as a
 // surrogate model retry. Completed media may still be independently read.
 let modelCircuitOpen=false;
 for(const id of ids){
  const r=await store.getById<Record_>('trend_videos',id);if(!r||r.tenantId!==job.tenantId||!origin(r,job,run))throw Error('weekly_candidate_source_scope_changed');
  const a=obj(r.aiAnalysis);if(classifyDiscoverySourceFailure(a.analysisError??a.downloadError)==='model_unavailable')modelCircuitOpen=true;
  const op=socialRequestHash({jobId:job.jobId,candidateId:id,sourceUrl:r.sourceUrl,origin:origin(r,job,run)}).slice(0,15),receipt=await store.getById<Record_>(CANDIDATE_ANALYSIS_RECEIPTS,op);
  if(receipt){const p=obj(receipt.payload);if(receipt.record_hash!==socialRequestHash(receipt.payload)||p.operationId!==op||p.jobId!==job.jobId||p.candidateId!==id)throw Error('weekly_candidate_analysis_receipt_changed');if(p.reason==='model_unavailable')modelCircuitOpen=true;}
 }
 for(const id of ids){
  let record=await store.getById<Record_>('trend_videos',id);if(!record||record.tenantId!==job.tenantId||!origin(record,job,run))throw Error('weekly_candidate_source_scope_changed');
  let a=obj(record.aiAnalysis);
  if(!await verifiedMedia(record,ports.mediaRoot??root)){
   const queued=['queued','waiting_for_video'].includes(String(a.downloadStatus))||a.geminiStatus==='waiting_for_video';
   const operationId=socialRequestHash({jobId:job.jobId,candidateId:id,sourceUrl:record.sourceUrl,origin:origin(record,job,run)}).slice(0,15);
   const prior=await store.getById<Record_>(CANDIDATE_ANALYSIS_OPERATIONS,operationId);
   const priorReceipt=await store.getById<Record_>(CANDIDATE_ANALYSIS_RECEIPTS,operationId);
   if(prior&&(prior.record_hash!==socialRequestHash(prior.payload)||obj(prior.payload).jobId!==job.jobId||obj(prior.payload).candidateId!==id||obj(prior.payload).sourceHash!==socialRequestHash(origin(record,job,run))))throw Error('weekly_candidate_analysis_operation_changed');
   if(priorReceipt&&(priorReceipt.record_hash!==socialRequestHash(priorReceipt.payload)||obj(priorReceipt.payload).operationId!==operationId))throw Error('weekly_candidate_analysis_receipt_changed');
   if(modelCircuitOpen)pending.push('model_unavailable');
   if(queued&&!prior&&!spentAnalysisSlot&&!modelCircuitOpen){
    if(!ports.analyze&&store!==routeStore)throw Error('weekly_candidate_analysis_store_mismatch');
    const payload={schema:'weekly-candidate-analysis-operation.v1',jobId:job.jobId,tenantId:job.tenantId,programId:job.programId,packageId:job.packageId,packageVersion:job.packageVersion,taskId:job.consumerTaskId,candidateId:id,parentRunId:run.runId,parentRunHash:socialRequestHash(run),sourceUrl:record.sourceUrl,sourceHash:socialRequestHash(origin(record,job,run)),state:'submitted_or_unknown',paidDownloadPermitted:false,analysisCostState:'retained_unknown'};
    if(!await store.create(CANDIDATE_ANALYSIS_OPERATIONS,{id:operationId,tenant_id:job.tenantId,job_id:job.jobId,candidate_id:id,record_hash:socialRequestHash(payload),payload}))throw Error('weekly_candidate_analysis_submit_unknown');
    spentAnalysisSlot=true;
    let failureCode:string|null=null;
    try{await (ports.analyze??analyze)(record);}catch(error){failureCode=classifyDiscoverySourceFailure(error);}
    record=await store.getById<Record_>('trend_videos',id);if(!record||record.tenantId!==job.tenantId||!origin(record,job,run))throw Error('weekly_candidate_source_scope_changed');a=obj(record.aiAnalysis);
    const verified=await verifiedMedia(record,ports.mediaRoot??root);
    const knownFailure=failureCode??(a.analysisQuality==='video_review_required'?'weekly_candidate_analysis_review_required':['manual_required','failed','ops_failed'].includes(String(a.downloadStatus))||a.geminiStatus==='video_failed'?classifyDiscoverySourceFailure(a.analysisError??a.downloadError??'source_media_unavailable'):null);
    if(verified||knownFailure){const receipt={schema:'weekly-candidate-analysis-receipt.v1',operationId,jobId:job.jobId,candidateId:id,status:verified?'completed':'blocked',reason:verified?null:knownFailure,sourceHash:socialRequestHash(origin(record,job,run)),recordSnapshotHash:socialRequestHash(record),analysisCostState:'retained_unknown',createdAt:new Date().toISOString()};if(!await store.create(CANDIDATE_ANALYSIS_RECEIPTS,{id:operationId,tenant_id:job.tenantId,operation_id:operationId,record_hash:socialRequestHash(receipt),payload:receipt}))throw Error('weekly_candidate_analysis_receipt_write_unknown');}
    if(knownFailure)pending.push(knownFailure);
    if(knownFailure==='model_unavailable')modelCircuitOpen=true;
   }
   if(!await verifiedMedia(record,ports.mediaRoot??root)){
    pending.push(typeof obj(priorReceipt?.payload).reason==='string'?String(obj(priorReceipt?.payload).reason):a.analysisQuality==='video_review_required'?'weekly_candidate_analysis_review_required':prior?'weekly_candidate_analysis_original_receipt_pending':'weekly_candidate_analysis_pending');continue;
   }
  }
  records.push(record);
 }
 const outcomes:CandidateReassessment['evidenceOutcomes']={};
 for(const record of records){
  const sourceAnalysis=obj(record.aiAnalysis);
  if(!Number.isFinite(sourceAnalysis.taskRelevance??sourceAnalysis.relevanceScore)||!Number.isFinite(sourceAnalysis.transferability??sourceAnalysis.structuralTransferability)){
   const context=await (await import('../socialDiscovery/candidateContextAssessment.js')).readCandidateContextAssessment(store,job.tenantId,record.id,{programId:job.programId,packageId:job.packageId,packageVersion:job.packageVersion},record);
   const semantic=context?await (await import('../socialDiscovery/candidateSemanticAssessment.js')).readCandidateSemanticAssessment(store,context):null;
   pending.push(semantic?'weekly_candidate_context_review_required':context?'candidate_context_semantic_budget_authorization_required':'weekly_candidate_context_required');
   // Missing context is unknown, not a measured low score. The old rejected
   // score remains historical; do not append another fabricated 25/25 version.
   continue;
  }
  const o=origin(record,job,run)!,mode=o.mode as SocialDiscoveryMode;
  const items=await createR3CandidateEvidenceAdapter(store).toEvidenceWorkItems({tenantId:job.tenantId,runId:run.runId,scopeId:job.authority!.scopeId,scopeVersion:job.authority!.scopeVersion,mode,queryRef:String(o.queryRef),observedAt:String(o.observedAt),platform:String(record.platform),keywordTier:'unknown',result:{platform:record.platform as 'tiktok',keyword:String(o.queryRef),imported:0,refreshed:0,skipped:0,skippedExisting:0,returnedExisting:1,requested:0,total:0,source:'r3',message:'existing candidate reassessment; no collection',candidateIds:[record.id],items:[]}});
  const scored=await (ports.evidence??runCandidateEvidenceWorker)(items),accepted=scored.accepted.filter(e=>e.evidence.qualityScore?.decision==='accepted');
  const entry=outcomes[mode]??={acceptedCandidateIds:[],acceptedEvidenceRefs:[],suggestionCandidateIds:[],failedCandidateIds:[]};
  for(const e of accepted){entry.acceptedCandidateIds.push(e.candidateId);entry.acceptedEvidenceRefs.push(`${e.evidenceId}@${e.version}`);}
 }
 if(!Object.values(outcomes).some(o=>o?.acceptedCandidateIds.length))return {ready:false,code:pending[0]??'weekly_candidate_quality_insufficient',item:null};
 const snapshot={schema:'weekly-candidate-reassessment.v1' as const,tenantId:job.tenantId,programId:job.programId,packageId:job.packageId,packageVersion:job.packageVersion,taskId:job.consumerTaskId,jobId:job.jobId,consumerInputHash:job.consumerInputHash,parentRunId:run.runId,parentRunHash:socialRequestHash(run),candidateSnapshots:records.map(r=>({id:r.id,hash:socialRequestHash(r)})),evidenceOutcomes:outcomes,newCollectionRequests:0 as const,newCollectionCostCny:0 as const,analysisCostState:'retained_unknown' as const};
 const id=socialRequestHash(snapshot).slice(0,15),existing=await store.getById<Record_>(CANDIDATE_REASSESSMENTS,id);
 const item:CandidateReassessment={...snapshot,id,createdAt:new Date().toISOString(),recordHash:''};item.recordHash=socialRequestHash({...item,recordHash:''});
 if(existing)return {ready:true,code:null,item:await readWeeklyCandidateReassessment(store,job,run,{type:'social_discovery_candidate_reassessment',id,version:1},ports.mediaRoot)};
 if(!await store.create(CANDIDATE_REASSESSMENTS,{id,tenant_id:job.tenantId,job_id:job.jobId,record_hash:item.recordHash,payload:item}))throw Error('weekly_candidate_reassessment_write_unknown');
 return {ready:true,code:null,item};
}

export async function readWeeklyCandidateReassessment(store:DataStore,job:WeeklyPreproductionRetryAttempt,run:SocialInspirationCollectionRun,ref:VersionedSocialRef,mediaRoot=root){
 const row=await store.getById<Record_>(CANDIDATE_REASSESSMENTS,ref.id),a=row?.payload as CandidateReassessment;
 if(!a||ref.type!=='social_discovery_candidate_reassessment'||ref.version!==1||row?.tenant_id!==job.tenantId||row.record_hash!==a.recordHash||a.recordHash!==socialRequestHash({...a,recordHash:''})||a.jobId!==job.jobId||a.consumerInputHash!==job.consumerInputHash||a.parentRunId!==run.runId||a.parentRunHash!==socialRequestHash(run)||a.newCollectionRequests!==0)throw Error('weekly_candidate_reassessment_invalid');
 const allowed=new Set(allowedIds(run));
 for(const candidate of a.candidateSnapshots){const r=await store.getById<Record_>('trend_videos',candidate.id);if(!allowed.has(candidate.id)||!r||r.tenantId!==job.tenantId||!origin(r,job,run)||socialRequestHash(r)!==candidate.hash||!await verifiedMedia(r,mediaRoot))throw Error('weekly_candidate_reassessment_source_changed');}
 for(const outcome of Object.values(a.evidenceOutcomes)){for(const id of outcome?.acceptedCandidateIds??[])if(!a.candidateSnapshots.some(c=>c.id===id))throw Error('weekly_candidate_reassessment_candidate_invalid');for(const ref of outcome?.acceptedEvidenceRefs??[]){const at=ref.lastIndexOf('@'),id=ref.slice(0,at),version=Number(ref.slice(at+1)),e=await store.list<Record_>('social_candidate_evidence',{where:{tenant_id:job.tenantId,evidenceId:id,version},perPage:2});if(e.totalItems!==1||obj(e.items[0]!.evidence).qualityScore===undefined||obj(obj(e.items[0]!.evidence).qualityScore).decision!=='accepted'||!outcome?.acceptedCandidateIds.includes(String(e.items[0]!.candidateId)))throw Error('weekly_candidate_reassessment_evidence_invalid');}}
 return a;
}
