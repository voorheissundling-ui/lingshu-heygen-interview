import type {DataStore,Record_} from '../storage/datastore.js';
import type {WeeklyPreproductionJob} from '../runtime/weeklyPreproductionProducer.js';
import {socialRequestHash} from '../starter198/socialContentValidation.js';

export const WEEKLY_ACCOUNT_COLLECTION_RECOVERY_EVENTS='social_weekly_account_collection_recovery_events';
export type CollectionRecoveryState='submitted_unknown_no_replay'|'accepted_needs_original_get'|'original_run_verified_needs_dataset';
type Event={schema:'weekly-account-collection-recovery-event.v1';id:string;tenantId:string;programId:string;packageId:string;packageVersion:number;taskId:string;jobId:string;jobRecordHash:string;originalRunKey:string;operationIdentity:string;requestHash:string;tokenFingerprint:string;state:CollectionRecoveryState;acceptedPostHash:string|null;recordHash:string};
const fail=():never=>{throw Error('weekly_account_collection_recovery_projection_invalid');};
const hash=(event:Event)=>socialRequestHash({...event,recordHash:''});
const same=(row:Record_,event:Event)=>row.id===event.id&&row.tenant_id===event.tenantId&&row.program_id===event.programId&&row.package_id===event.packageId&&row.package_version===event.packageVersion&&row.task_id===event.taskId&&row.job_id===event.jobId&&row.job_record_hash===event.jobRecordHash&&row.operation_identity===event.operationIdentity&&row.request_hash===event.requestHash&&row.state===event.state&&row.record_hash===event.recordHash;
const valid=(row:Record_,job:WeeklyPreproductionJob,allowedJobRecordHashes=new Set([job.recordHash])):Event=>{
 const e=row.payload as Event;
 if(!e||e.schema!=='weekly-account-collection-recovery-event.v1'||!same(row,e)||e.recordHash!==hash(e)||e.tenantId!==job.tenantId||e.programId!==job.programId||e.packageId!==job.packageId||e.packageVersion!==job.packageVersion||e.taskId!==job.consumerTaskId||e.jobId!==job.jobId||!allowedJobRecordHashes.has(e.jobRecordHash)||e.originalRunKey!==job.originalRunKey||!['submitted_unknown_no_replay','accepted_needs_original_get','original_run_verified_needs_dataset'].includes(e.state)||![e.operationIdentity,e.requestHash,e.tokenFingerprint].every(x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x))||(e.state!=='submitted_unknown_no_replay'?!/^[a-f0-9]{64}$/.test(e.acceptedPostHash??''):e.acceptedPostHash!==null))return fail();
 if(e.id!==socialRequestHash({jobId:e.jobId,jobRecordHash:e.jobRecordHash,operationIdentity:e.operationIdentity,requestHash:e.requestHash,tokenFingerprint:e.tokenFingerprint,state:e.state,acceptedPostHash:e.acceptedPostHash}).slice(0,15))return fail();
 return e;
};
/** Append-only observation. Never changes the frozen job, original operation or paid ledger. */
export async function recordWeeklyAccountCollectionRecovery(input:{store:DataStore;job:WeeklyPreproductionJob;operationIdentity:string;requestHash:string;tokenFingerprint:string;state:CollectionRecoveryState;acceptedPost:unknown|null}){
 const j=input.job;
 if(j.kind!=='discovery'||!j.recordHash||!j.originalRunKey||!['submitted_unknown_no_replay','accepted_needs_original_get','original_run_verified_needs_dataset'].includes(input.state))return fail();
 const acceptedPostHash=input.state!=='submitted_unknown_no_replay'&&input.acceptedPost?socialRequestHash(input.acceptedPost):null;
 if((input.state!=='submitted_unknown_no_replay')!==Boolean(acceptedPostHash))return fail();
 const id=socialRequestHash({jobId:j.jobId,jobRecordHash:j.recordHash,operationIdentity:input.operationIdentity,requestHash:input.requestHash,tokenFingerprint:input.tokenFingerprint,state:input.state,acceptedPostHash}).slice(0,15);
 const e:Event={schema:'weekly-account-collection-recovery-event.v1',id,tenantId:j.tenantId,programId:j.programId,packageId:j.packageId,packageVersion:j.packageVersion,taskId:j.consumerTaskId,jobId:j.jobId,jobRecordHash:j.recordHash,originalRunKey:j.originalRunKey,operationIdentity:input.operationIdentity,requestHash:input.requestHash,tokenFingerprint:input.tokenFingerprint,state:input.state,acceptedPostHash,recordHash:''};e.recordHash=hash(e);
 const row={id,tenant_id:e.tenantId,program_id:e.programId,package_id:e.packageId,package_version:e.packageVersion,task_id:e.taskId,job_id:e.jobId,job_record_hash:e.jobRecordHash,operation_identity:e.operationIdentity,request_hash:e.requestHash,state:e.state,record_hash:e.recordHash,payload:e};
 valid(row,j);
 const existing=await input.store.getById<Record_>(WEEKLY_ACCOUNT_COLLECTION_RECOVERY_EVENTS,id);
 if(existing){if(socialRequestHash(valid(existing,j))!==socialRequestHash(e))return fail();return e;}
 if(!await input.store.create(WEEKLY_ACCOUNT_COLLECTION_RECOVERY_EVENTS,row)){const concurrent=await input.store.getById<Record_>(WEEKLY_ACCOUNT_COLLECTION_RECOVERY_EVENTS,id);if(!concurrent||socialRequestHash(valid(concurrent,j))!==socialRequestHash(e))return fail();}
 return e;
}
/** Verified local observation identity for read-only reconciliation; never a spending permit. */
export async function readWeeklyAccountCollectionRecoveryEvidence(store:DataStore,job:WeeklyPreproductionJob):Promise<{state:CollectionRecoveryState;code:string;permitsRetry:false;operationIdentity:string;requestHash:string;tokenFingerprint:string;acceptedPostHash:string|null}|null>{
 const authorities=await store.list<Record_>('social_weekly_account_collection_cost_ceilings',{where:{tenant_id:job.tenantId,job_id:job.jobId},perPage:2}),allowed=new Set([job.recordHash]);
 if(authorities.totalItems>1||authorities.items.length!==authorities.totalItems)return fail();
 if(authorities.items[0]){const authority=authorities.items[0].payload as {recordHash?:string;jobId?:string;jobRecordHash?:string;originalRunKey?:string;permitsPaidCollection?:boolean};if(authorities.items[0].record_hash!==authority.recordHash||authority.recordHash!==socialRequestHash({...authority,recordHash:''})||authority.jobId!==job.jobId||authority.originalRunKey!==job.originalRunKey||authority.permitsPaidCollection!==true||typeof authority.jobRecordHash!=='string')return fail();allowed.add(authority.jobRecordHash);}
 const rows=await store.list<Record_>(WEEKLY_ACCOUNT_COLLECTION_RECOVERY_EVENTS,{where:{tenant_id:job.tenantId,program_id:job.programId,package_id:job.packageId,package_version:job.packageVersion,job_id:job.jobId},page:1,perPage:20});
 if(rows.totalItems!==rows.items.length||rows.totalItems>20)return fail();
 const events=rows.items.map(row=>valid(row,job,allowed));
 if(!events.length)return null;
 if(new Set(events.map(e=>e.id)).size!==events.length||new Set(events.map(e=>`${e.operationIdentity}:${e.requestHash}:${e.tokenFingerprint}`)).size!==1)return fail();
 const accepted=events.filter(e=>e.state!=='submitted_unknown_no_replay');
 if(accepted.length>1&&new Set(accepted.map(e=>e.acceptedPostHash)).size>1)return fail();
 const state:CollectionRecoveryState=events.some(e=>e.state==='original_run_verified_needs_dataset')?'original_run_verified_needs_dataset':accepted.length?'accepted_needs_original_get':'submitted_unknown_no_replay';
 return {state,code:state==='original_run_verified_needs_dataset'?'weekly_preproduction_original_run_verified_needs_dataset':state==='accepted_needs_original_get'?'weekly_preproduction_original_accepted_needs_get':'weekly_preproduction_original_submitted_unknown_no_replay',permitsRetry:false,operationIdentity:events[0]!.operationIdentity,requestHash:events[0]!.requestHash,tokenFingerprint:events[0]!.tokenFingerprint,acceptedPostHash:accepted[0]?.acceptedPostHash??null};
}
/** Historical non-retry task-card projection. It is not a current provider status or spending permit. */
export async function readWeeklyAccountCollectionRecovery(store:DataStore,job:WeeklyPreproductionJob):Promise<{state:CollectionRecoveryState;code:string;permitsRetry:false}|null>{
 const evidence=await readWeeklyAccountCollectionRecoveryEvidence(store,job);
 return evidence?{state:evidence.state,code:evidence.code,permitsRetry:false}:null;
}
