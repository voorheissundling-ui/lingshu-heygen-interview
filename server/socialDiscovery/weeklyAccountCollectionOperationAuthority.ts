import type {DataStore,Record_} from '../storage/datastore.js';
import {socialRequestHash} from '../starter198/socialContentValidation.js';
import {readCurrentWeeklyAccountCollectionBudget,type PrepaidCollectionOperationAuthority,type WeeklyAccountCollectionBudgetAuthorization} from './weeklyAccountCollectionBudget.js';
import type {WeeklyPreproductionJob} from '../runtime/weeklyPreproductionProducer.js';
import type {WeeklyExecutionTask,WeeklyOperatingPackage} from '../../shared/contracts/socialProgram.js';

const fail=():never=>{throw Error('weekly_account_collection_original_operation_authority_changed');};
const one=async<T>(store:DataStore,collection:string,where:Record<string,string|number>):Promise<T&Record_>=>{
 const rows=await store.list<T&Record_>(collection,{where,perPage:2});
 if(rows.totalItems!==1||rows.items.length!==1)return fail();
 return rows.items[0]!;
};

/** Independent store reader for the original five-video job. Retry and
 * qualified-continuation operations need their own parent-run/grant proof and
 * cannot inherit this original-job authority. This is not a paid permit. */
export async function verifyFrozenWeeklyAccountCollectionOriginalOperation(input:{store:DataStore;authorization:WeeklyAccountCollectionBudgetAuthorization;operation:PrepaidCollectionOperationAuthority;now?:number}):Promise<void>{
 const {store,authorization:a,operation:o}=input;
 if(o.tenantId!==a.tenantId||o.programId!==a.programId||o.packageId!==a.packageId||o.packageVersion!==a.packageVersion||o.scopeId!==a.scopeId||o.scopeVersion!==a.scopeVersion||o.scopeHash!==a.scopeHash)return fail();
 const current=await readCurrentWeeklyAccountCollectionBudget(store,a,input.now);
 if(current.authorizationId!==a.authorizationId||current.recordHash!==a.recordHash)return fail();
 const packageRow=await one<{payload:WeeklyOperatingPackage}>(store,'social_weekly_operating_packages',{tenant_id:a.tenantId,program_id:a.programId,package_id:a.packageId,version:a.packageVersion});
 const pkg=packageRow.payload;
 if(!pkg||pkg.packageId!==a.packageId||pkg.programId!==a.programId||pkg.version!==a.packageVersion||!['draft','active'].includes(pkg.status))return fail();
 const jobRow=await store.getById<Record_>('social_weekly_preproduction_jobs',o.jobId),job=jobRow?.payload as WeeklyPreproductionJob|undefined;
 const modes=job?.authority?.requestedModes;
 const scopeRow=await store.getById<Record_>('social_discovery_scopes',a.scopeId);
 const brief=(scopeRow?.payload as {discoveryBrief?:{discoveryModes?:string[];modePolicies?:Record<string,{enabled?:boolean}>}}|undefined)?.discoveryBrief;
 const historicalBinding=job?.recordHash===o.jobRecordHash?true:await (async()=>{const rows=await store.list<Record_>('social_weekly_account_collection_cost_ceilings',{where:{tenant_id:a.tenantId,authorization_id:a.authorizationId,job_id:o.jobId},perPage:2});if(rows.totalItems!==1||rows.items.length!==1)return false;const bound=rows.items[0]!.payload as {recordHash?:string;authorizationId?:string;authorizationHash?:string;jobId?:string;jobRecordHash?:string;originalRunKey?:string;scopeHash?:string;permitsPaidCollection?:boolean};return rows.items[0]!.record_hash===bound.recordHash&&bound.recordHash===socialRequestHash({...bound,recordHash:''})&&bound.authorizationId===a.authorizationId&&bound.authorizationHash===a.recordHash&&bound.jobId===o.jobId&&bound.jobRecordHash===o.jobRecordHash&&bound.originalRunKey===o.runOperationId&&bound.scopeHash===a.scopeHash&&bound.permitsPaidCollection===true;})();
 if(!job||jobRow?.tenant_id!==a.tenantId||jobRow.program_id!==a.programId||jobRow.package_id!==a.packageId||jobRow.package_version!==a.packageVersion||jobRow.task_id!==job.consumerTaskId||jobRow.input_hash!==job.consumerInputHash||jobRow.kind!=='discovery'||jobRow.original_run_key!==job.originalRunKey||jobRow.record_hash!==job.recordHash||jobRow.status!==job.status||job.jobId!==o.jobId||!historicalBinding||job.recordHash!==socialRequestHash({...job,recordHash:''})||job.tenantId!==a.tenantId||job.programId!==a.programId||job.packageId!==a.packageId||job.packageVersion!==a.packageVersion||job.kind!=='discovery'||!['bound','blocked','running','unknown'].includes(job.status)||job.originalRunKey!==`weekly-preproduction:${job.jobId}`||o.runOperationId!==job.originalRunKey||job.sourceHash!==a.scopeHash||job.authority?.scopeId!==a.scopeId||job.authority.scopeVersion!==a.scopeVersion||job.authority.scopeHash!==a.scopeHash||!Array.isArray(modes)||!modes.includes('account')||new Set(modes).size!==modes.length||!Array.isArray(brief?.discoveryModes)||modes.some(mode=>!['momentum','account','innovation'].includes(mode)||!brief.discoveryModes!.includes(mode)||brief.modePolicies?.[mode]?.enabled!==true))return fail();
 const taskRow=await one<{payload:WeeklyExecutionTask}>(store,'social_weekly_execution_tasks',{tenant_id:a.tenantId,program_id:a.programId,package_id:a.packageId,package_version:a.packageVersion,task_id:job.consumerTaskId});
 const task=taskRow.payload;
 if(!task||task.taskId!==job.consumerTaskId||task.tenantId!==a.tenantId||task.programId!==a.programId||task.packageId!==a.packageId||task.packageVersion!==a.packageVersion||task.schedule.stepKind!=='benchmark_collection'||taskRow.input_hash!==undefined&&taskRow.input_hash!==job.consumerInputHash)return fail();
}
