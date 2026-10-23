import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type {DataStore,Record_} from '../storage/datastore.js';
import type {SocialInspirationCollectionRun} from '../../shared/contracts/socialContentWorkflow.js';
import type {WeeklyPreproductionJob} from './weeklyPreproductionProducer.js';
import type {WeeklyPreproductionRetryAttempt} from './weeklyPreproductionRetryAttempts.js';
import {socialJson,socialObject,socialRequestHash} from '../starter198/socialContentValidation.js';
import {probeReferenceMediaClock} from '../lib/referenceMediaClock.js';
import {verifiedWeeklyCandidateMedia} from './weeklyCandidateReassessment.js';
import {weeklyCandidateExactRunBindingHash} from './weeklyCandidateExactRunBinding.js';

export const WEEKLY_CANDIDATE_EXACT_ANALYSIS_OPERATIONS='social_weekly_candidate_exact_analysis_operations';
export const WEEKLY_CANDIDATE_EXACT_ANALYSIS_RECEIPTS='social_weekly_candidate_exact_analysis_receipts';
type Job=WeeklyPreproductionJob|WeeklyPreproductionRetryAttempt;
const obj=(value:unknown)=>socialObject(socialJson(value))??{};
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
/** A settled operation belongs to the source and model output, not mutable
 * discovery display fields such as title, metrics or score. Media bytes and
 * independent supplier/billing receipts are verified separately on every read. */
export function weeklyCandidateExactRecordBindingHash(record:Record_):string{
 return socialRequestHash({id:record.id,tenantId:record.tenantId,sourceUrl:record.sourceUrl,
  videoFileId:record.videoFileId,aiAnalysis:obj(record.aiAnalysis)});
}
export interface WeeklyCandidateExactAnalysisPorts {
 /** A trusted, independently approved exact-analysis permit. Never infer this
  * from collection, semantic, or production budgets. The production caller has
  * no implementation until its provider-side cost/recovery contract exists. */
 authorize?:(input:{job:Job;run:SocialInspirationCollectionRun;record:Record_;mediaSha256:string;operationId:string})=>Promise<{authorizationId:string;authorizationHash:string}|null>;
 /** Test-only/trusted executor. It must use its own paid-operation permit and
  * update the canonical trend record with real full-video analysis evidence. */
 execute?:(input:{job:Job;run:SocialInspirationCollectionRun;record:Record_;mediaSha256:string;operationId:string;authorizationId:string;authorizationHash:string})=>Promise<void>;
 /** Independent provider receipt and paid-ledger settlement reader. This is
  * deliberately absent in production until both original proofs exist. */
 readSettledReceipt?:(input:{operationId:string;authorizationId:string;authorizationHash:string;mediaSha256:string;candidateId:string})=>Promise<{operationId:string;authorizationHash:string;mediaSha256:string;providerRequestHash:string;providerReceiptRef:string;ledgerOutcomeHash:string;status:'completed';settlementBasis?:'original_billing'|'conservative_upper_bound';recordedUpperBoundCny?:number}|null>;
}
/** Media ownership and byte identity are independent of any model output. */
export async function verifiedWeeklyCandidateCanonicalMedia(record:Record_,mediaRoot:string):Promise<{sha256:string;duration:number}|null>{
 const analysis=obj(record.aiAnalysis),relative=`tenants/${record.tenantId}/reference-videos/${record.id}.mp4`;
 if(record.videoFileId!==relative||!/^[a-f0-9]{64}$/.test(String(analysis.contentSha256??'')))return null;
 const tenant=await fs.realpath(path.resolve(mediaRoot,'tenants',String(record.tenantId))).catch(()=>null);
 const absolute=await fs.realpath(path.resolve(mediaRoot,relative)).catch(()=>null);
 if(!tenant||!absolute||!absolute.startsWith(tenant+path.sep))return null;
 const bytes=await fs.readFile(absolute).catch(()=>null);
 if(!bytes?.length||sha(bytes)!==analysis.contentSha256)return null;
 const measured=await probeReferenceMediaClock(absolute).catch(()=>null);
 return measured&&Number.isFinite(measured.duration)&&measured.duration>0?{sha256:sha(bytes),duration:measured.duration}:null;
}
type Operation={schema:'weekly-candidate-exact-analysis-operation.v1';operationId:string;tenantId:string;programId:string;packageId:string;packageVersion:number;jobId:string;runId:string;runHash:string;candidateId:string;sourceUrl:string;mediaSha256:string;authorizationId:string;authorizationHash:string;state:'submitted_or_unknown';recordHash:string};
export const weeklyCandidateExactAnalysisOperationId=(job:Job,run:SocialInspirationCollectionRun,record:Record_,mediaSha256:string)=>socialRequestHash({kind:'weekly-candidate-exact-analysis-v1',tenantId:job.tenantId,programId:job.programId,packageId:job.packageId,packageVersion:job.packageVersion,jobId:job.jobId,runId:run.runId,candidateId:record.id,sourceUrl:record.sourceUrl,mediaSha256}).slice(0,15);
function checked(row:Record_,expected:Omit<Operation,'authorizationId'|'authorizationHash'|'state'|'recordHash'>):Operation{
 const op=row.payload as Operation;
 if(!op||row.id!==expected.operationId||row.tenant_id!==expected.tenantId||row.record_hash!==op.recordHash||op.recordHash!==socialRequestHash({...op,recordHash:''})||Object.entries(expected).some(([key,value])=>(op as unknown as Record<string,unknown>)[key]!==value)||op.state!=='submitted_or_unknown'||!op.authorizationId||!/^[a-f0-9]{64}$/.test(op.authorizationHash))throw Error('weekly_candidate_exact_analysis_operation_changed');
 return op;
}
/** Read-only admission fence: a separate completed analysis must not launder
 * an unsettled paid submission on this exact candidate and source bytes. */
export async function readWeeklyCandidateExactAnalysisSettlement(input:{store:DataStore;job:Job;run:SocialInspirationCollectionRun;record:Record_;mediaRoot:string;ports?:WeeklyCandidateExactAnalysisPorts}):Promise<boolean>{
 const {store,job,run,record,mediaRoot}=input;
 const canonical=await verifiedWeeklyCandidateCanonicalMedia(record,mediaRoot);
 if(!canonical)return false;
 const operationId=weeklyCandidateExactAnalysisOperationId(job,run,record,canonical.sha256),expected={schema:'weekly-candidate-exact-analysis-operation.v1' as const,operationId,tenantId:job.tenantId,programId:job.programId,packageId:job.packageId,packageVersion:job.packageVersion,jobId:job.jobId,runId:run.runId,runHash:weeklyCandidateExactRunBindingHash(run),candidateId:record.id,sourceUrl:String(record.sourceUrl),mediaSha256:canonical.sha256};
 const row=await store.getById<Record_>(WEEKLY_CANDIDATE_EXACT_ANALYSIS_OPERATIONS,operationId);
 if(!row)return true;
 const op=checked(row,expected),analysisRunId=obj(record.aiAnalysis).analysisRunId;
 if(analysisRunId!==operationId)return false;
 const settled=await input.ports?.readSettledReceipt?.({operationId,authorizationId:op.authorizationId,authorizationHash:op.authorizationHash,mediaSha256:canonical.sha256,candidateId:record.id});
 if(!validSettlement(settled,op,canonical.sha256))return false;
 const receipt={schema:'weekly-candidate-exact-analysis-receipt.v1',operationId,tenantId:job.tenantId,jobId:job.jobId,runId:run.runId,candidateId:record.id,mediaSha256:canonical.sha256,authorizationHash:op.authorizationHash,providerRequestHash:settled.providerRequestHash,providerReceiptRef:settled.providerReceiptRef,ledgerOutcomeHash:settled.ledgerOutcomeHash,analysisRunId,recordSnapshotHash:weeklyCandidateExactRecordBindingHash(record),...(settled.settlementBasis?{settlementBasis:settled.settlementBasis}:{}),...(settled.recordedUpperBoundCny!==undefined?{recordedUpperBoundCny:settled.recordedUpperBoundCny}:{})};
 const saved=await store.getById<Record_>(WEEKLY_CANDIDATE_EXACT_ANALYSIS_RECEIPTS,operationId);
 return !!saved&&saved.tenant_id===job.tenantId&&saved.record_hash===socialRequestHash(receipt)&&socialRequestHash(saved.payload)===saved.record_hash;
}
function validSettlement(value:Awaited<ReturnType<NonNullable<WeeklyCandidateExactAnalysisPorts['readSettledReceipt']>>>|undefined,op:Operation,mediaSha256:string):value is NonNullable<typeof value>{
 return !!value&&value.status==='completed'&&(!value.settlementBasis||['original_billing','conservative_upper_bound'].includes(value.settlementBasis))&&
  typeof value.providerReceiptRef==='string'&&value.providerReceiptRef.length>0&&
  (value.settlementBasis!=='conservative_upper_bound'||value.providerReceiptRef.startsWith(`qwen-audit-upper-bound:${op.operationId}:`))&&
  (value.recordedUpperBoundCny===undefined||(Number.isFinite(value.recordedUpperBoundCny)&&value.recordedUpperBoundCny>0&&value.recordedUpperBoundCny<=10))&&
  value.operationId===op.operationId&&value.authorizationHash===op.authorizationHash&&value.mediaSha256===mediaSha256&&
  /^[a-f0-9]{64}$/.test(value.providerRequestHash)&&/^[a-f0-9]{64}$/.test(value.ledgerOutcomeHash);
}
/** A durable claim is committed before the executor is entered. Re-entry
 * verifies the original output only; it never issues a second paid request. */
export async function advanceWeeklyCandidateExactAnalysis(input:{store:DataStore;job:Job;run:SocialInspirationCollectionRun;record:Record_;mediaRoot:string;ports?:WeeklyCandidateExactAnalysisPorts}):Promise<{state:'completed'|'blocked'|'unknown';code:string;operationId:string|null}>{
 const {store,job,run,record,mediaRoot}=input;
 if(record.tenantId!==job.tenantId||run.discoveryScopeId!==job.authority?.scopeId||run.discoveryScopeVersion!==job.authority?.scopeVersion)throw Error('weekly_candidate_exact_analysis_scope_invalid');
 const canonical=await verifiedWeeklyCandidateCanonicalMedia(record,mediaRoot);
 if(!canonical)return {state:'blocked',code:'weekly_postanalysis_canonical_evidence_intervention_required',operationId:null};
 const operationId=weeklyCandidateExactAnalysisOperationId(job,run,record,canonical.sha256),expected={schema:'weekly-candidate-exact-analysis-operation.v1' as const,operationId,tenantId:job.tenantId,programId:job.programId,packageId:job.packageId,packageVersion:job.packageVersion,jobId:job.jobId,runId:run.runId,runHash:weeklyCandidateExactRunBindingHash(run),candidateId:record.id,sourceUrl:String(record.sourceUrl),mediaSha256:canonical.sha256};
 const prior=await store.getById<Record_>(WEEKLY_CANDIDATE_EXACT_ANALYSIS_OPERATIONS,operationId),op=prior?checked(prior,expected):null;
 const fresh=await store.getById<Record_>('trend_videos',record.id);
 if(!fresh||fresh.tenantId!==record.tenantId||fresh.sourceUrl!==record.sourceUrl||obj(fresh.aiAnalysis).contentSha256!==canonical.sha256)throw Error('weekly_candidate_exact_analysis_source_changed');
 if(await verifiedWeeklyCandidateMedia(fresh,mediaRoot)){
  if(!op)return {state:'completed',code:'weekly_postanalysis_exact_analysis_existing',operationId:null};
  // A different analysis may have completed while this paid submission was
  // unknown. It cannot settle the original operation or its cost receipt.
  if(obj(fresh.aiAnalysis).analysisRunId!==operationId)return {state:'unknown',code:'weekly_postanalysis_exact_analysis_original_receipt_pending',operationId};
  const settled=await input.ports?.readSettledReceipt?.({operationId,authorizationId:op.authorizationId,authorizationHash:op.authorizationHash,mediaSha256:canonical.sha256,candidateId:record.id});
  if(!validSettlement(settled,op,canonical.sha256))return {state:'unknown',code:'weekly_postanalysis_exact_analysis_original_receipt_pending',operationId};
  const receipt={schema:'weekly-candidate-exact-analysis-receipt.v1',operationId,tenantId:job.tenantId,jobId:job.jobId,runId:run.runId,candidateId:record.id,mediaSha256:canonical.sha256,authorizationHash:op.authorizationHash,providerRequestHash:settled.providerRequestHash,providerReceiptRef:settled.providerReceiptRef,ledgerOutcomeHash:settled.ledgerOutcomeHash,analysisRunId:obj(fresh.aiAnalysis).analysisRunId,recordSnapshotHash:weeklyCandidateExactRecordBindingHash(fresh),...(settled.settlementBasis?{settlementBasis:settled.settlementBasis}:{}),...(settled.recordedUpperBoundCny!==undefined?{recordedUpperBoundCny:settled.recordedUpperBoundCny}:{})};
  const old=await store.getById<Record_>(WEEKLY_CANDIDATE_EXACT_ANALYSIS_RECEIPTS,operationId);
  if(old){if(old.record_hash!==socialRequestHash(receipt)||socialRequestHash(old.payload)!==old.record_hash)throw Error('weekly_candidate_exact_analysis_receipt_changed');}
  else if(!await store.create(WEEKLY_CANDIDATE_EXACT_ANALYSIS_RECEIPTS,{id:operationId,tenant_id:job.tenantId,operation_id:operationId,record_hash:socialRequestHash(receipt),payload:receipt}))throw Error('weekly_candidate_exact_analysis_receipt_write_unknown');
  return {state:'completed',code:'weekly_postanalysis_exact_analysis_completed',operationId};
 }
 if(op)return {state:'unknown',code:'weekly_postanalysis_exact_analysis_original_receipt_pending',operationId};
 // Never enter an irreversible paid operation if the caller cannot later
 // independently recover its original supplier and ledger settlement.
 if(!input.ports?.authorize||!input.ports.execute||!input.ports.readSettledReceipt)return {state:'blocked',code:'weekly_postanalysis_exact_analysis_authorization_required',operationId:null};
 const auth=await input.ports.authorize({job,run,record:fresh,mediaSha256:canonical.sha256,operationId});
 if(!auth)return {state:'blocked',code:'weekly_postanalysis_exact_analysis_authorization_required',operationId:null};
 if(!auth.authorizationId||!/^[a-f0-9]{64}$/.test(auth.authorizationHash))throw Error('weekly_candidate_exact_analysis_authorization_invalid');
 const item:Operation={...expected,...auth,state:'submitted_or_unknown',recordHash:''};item.recordHash=socialRequestHash({...item,recordHash:''});
 if(!await store.create(WEEKLY_CANDIDATE_EXACT_ANALYSIS_OPERATIONS,{id:operationId,tenant_id:job.tenantId,job_id:job.jobId,candidate_id:record.id,record_hash:item.recordHash,payload:item}))throw Error('weekly_candidate_exact_analysis_claim_unknown');
 await input.ports.execute({job,run,record:fresh,mediaSha256:canonical.sha256,operationId,...auth});
 return advanceWeeklyCandidateExactAnalysis({...input,record:fresh});
}
