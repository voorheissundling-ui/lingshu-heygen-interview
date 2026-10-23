import type {DataStore, Record_} from '../storage/datastore.js';
import {socialRequestHash} from '../starter198/socialContentValidation.js';

export const WEEKLY_QUALIFIED_SHORTFALL_RECEIPTS = 'social_weekly_qualified_shortfall_receipts';

export interface WeeklyQualifiedShortfallReceipt {
  schema: 'weekly-qualified-shortfall.v1';
  receiptId: string;
  tenantId: string;
  programId: string;
  packageId: string;
  packageVersion: number;
  taskId: string;
  jobId: string;
  runId: string;
  runHash: string;
  businessDate: string;
  observedCandidateIds: string[];
  evidenceAcceptedCandidateIds: string[];
  target: 5;
  remainingAuthorizedCapacity: 0;
  code: 'weekly_qualified_quota_exhausted';
  authorizesExecution: false;
  grantsAdditionalDailyQuota: false;
  recordHash: string;
}

export interface WeeklyPostAdmissionShortfallReceipt {
  schema:'weekly-qualified-shortfall.v2';receiptId:string;tenantId:string;programId:string;packageId:string;packageVersion:number;taskId:string;jobId:string;runId:string;runHash:string;businessDate:string;
  observedCandidateIds:string[];evidenceAcceptedCandidateIds:string[];postAdmissionAcceptedCandidateIds:string[];
  target:5;remainingAuthorizedCapacity:0;code:'weekly_qualified_quota_exhausted';authorizesExecution:false;grantsAdditionalDailyQuota:false;recordHash:string;
}

/** An immutable statement of a proven current-run shortfall. It neither
 * reserves quota nor advances a collection run. */
export async function ensureWeeklyQualifiedShortfallReceipt(store: DataStore, input: Omit<WeeklyQualifiedShortfallReceipt, 'schema'|'receiptId'|'target'|'remainingAuthorizedCapacity'|'code'|'authorizesExecution'|'grantsAdditionalDailyQuota'|'recordHash'>): Promise<WeeklyQualifiedShortfallReceipt> {
  const ids = [...new Set(input.observedCandidateIds)].sort();
  const evidenceAcceptedIds=[...new Set(input.evidenceAcceptedCandidateIds)].sort();
  if (!input.tenantId || !input.programId || !input.packageId || !input.taskId || !input.jobId || !input.runId || !input.runHash
    || !Number.isSafeInteger(input.packageVersion) || input.packageVersion < 1 || !/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate)
    || evidenceAcceptedIds.length >= 5 || ids.some(id => !id) || evidenceAcceptedIds.some(id=>!id||!ids.includes(id))) throw Error('weekly_qualified_shortfall_scope_invalid');
  const body = {schema:'weekly-qualified-shortfall.v1' as const,...input,observedCandidateIds:ids,evidenceAcceptedCandidateIds:evidenceAcceptedIds,target:5 as const,
    remainingAuthorizedCapacity:0 as const,code:'weekly_qualified_quota_exhausted' as const,
    authorizesExecution:false as const,grantsAdditionalDailyQuota:false as const};
  const receiptId=socialRequestHash(body).slice(0,24);
  const receipt:WeeklyQualifiedShortfallReceipt={...body,receiptId,recordHash:socialRequestHash({...body,receiptId})};
  const prior=await store.getById<Record_>(WEEKLY_QUALIFIED_SHORTFALL_RECEIPTS,receiptId);
  if(prior){if(prior.record_hash!==receipt.recordHash||socialRequestHash(prior.payload)!==socialRequestHash(receipt))throw Error('weekly_qualified_shortfall_receipt_changed');return receipt;}
  const saved=await store.create(WEEKLY_QUALIFIED_SHORTFALL_RECEIPTS,{id:receiptId,tenant_id:input.tenantId,program_id:input.programId,package_id:input.packageId,package_version:input.packageVersion,task_id:input.taskId,job_id:input.jobId,run_id:input.runId,record_hash:receipt.recordHash,payload:receipt});
  if(!saved){const after=await store.getById<Record_>(WEEKLY_QUALIFIED_SHORTFALL_RECEIPTS,receiptId);if(!after||after.record_hash!==receipt.recordHash||socialRequestHash(after.payload)!==socialRequestHash(receipt))throw Error('weekly_qualified_shortfall_receipt_write_unknown');}
  return receipt;
}

/** v2 records the distinct post-analysis deficit when metadata acceptance
 * reached five. v1 receipts remain byte-for-byte immutable and readable. */
export async function ensureWeeklyPostAdmissionShortfallReceipt(store:DataStore,input:Omit<WeeklyPostAdmissionShortfallReceipt,'schema'|'receiptId'|'target'|'remainingAuthorizedCapacity'|'code'|'authorizesExecution'|'grantsAdditionalDailyQuota'|'recordHash'>):Promise<WeeklyPostAdmissionShortfallReceipt>{
 const observedCandidateIds=[...new Set(input.observedCandidateIds)].sort(),evidenceAcceptedCandidateIds=[...new Set(input.evidenceAcceptedCandidateIds)].sort(),postAdmissionAcceptedCandidateIds=[...new Set(input.postAdmissionAcceptedCandidateIds)].sort();
 if(!input.tenantId||!input.programId||!input.packageId||!input.taskId||!input.jobId||!input.runId||!input.runHash||!Number.isSafeInteger(input.packageVersion)||input.packageVersion<1||!/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate)||evidenceAcceptedCandidateIds.length<5||postAdmissionAcceptedCandidateIds.length>=5||observedCandidateIds.some(id=>!id)||evidenceAcceptedCandidateIds.some(id=>!id||!observedCandidateIds.includes(id))||postAdmissionAcceptedCandidateIds.some(id=>!id||!evidenceAcceptedCandidateIds.includes(id)))throw Error('weekly_qualified_shortfall_v2_scope_invalid');
 const body={schema:'weekly-qualified-shortfall.v2' as const,...input,observedCandidateIds,evidenceAcceptedCandidateIds,postAdmissionAcceptedCandidateIds,target:5 as const,remainingAuthorizedCapacity:0 as const,code:'weekly_qualified_quota_exhausted' as const,authorizesExecution:false as const,grantsAdditionalDailyQuota:false as const};
 const receiptId=socialRequestHash(body).slice(0,24),receipt:WeeklyPostAdmissionShortfallReceipt={...body,receiptId,recordHash:socialRequestHash({...body,receiptId})};
 const prior=await store.getById<Record_>(WEEKLY_QUALIFIED_SHORTFALL_RECEIPTS,receiptId);
 if(prior){if(prior.record_hash!==receipt.recordHash||socialRequestHash(prior.payload)!==socialRequestHash(receipt))throw Error('weekly_qualified_shortfall_v2_changed');return receipt;}
 const saved=await store.create(WEEKLY_QUALIFIED_SHORTFALL_RECEIPTS,{id:receiptId,tenant_id:input.tenantId,program_id:input.programId,package_id:input.packageId,package_version:input.packageVersion,task_id:input.taskId,job_id:input.jobId,run_id:input.runId,record_hash:receipt.recordHash,payload:receipt});
 if(!saved){const after=await store.getById<Record_>(WEEKLY_QUALIFIED_SHORTFALL_RECEIPTS,receiptId);if(!after||after.record_hash!==receipt.recordHash||socialRequestHash(after.payload)!==socialRequestHash(receipt))throw Error('weekly_qualified_shortfall_v2_write_unknown');}
 return receipt;
}
