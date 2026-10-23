/** 面试阅读注释：恢复既有run对应的队列登记。证据不全时必须阻塞，不能另开run规避原请求结果不明的问题。 */
import type {ContentExecutionJobStatus} from '../contentExecution/durableQueue.js';
import type {Starter198Repository} from './repository.js';
import {requireSocialTask} from './socialContentRecords.js';
import {socialJson,socialObject,SocialContentWorkflowError} from './socialContentValidation.js';
import {withExecutionPackageGate,executionPackageFrozen} from '../socialPrograms/weeklyExecutionGate.js';
import {enqueueSocialContentAutoProduction} from './socialContentProductionQueue.js';
export async function ensureOriginalSocialContentProductionQueued(input:{repository:Starter198Repository;tenantId:string;userId:string;taskId:string;runId:string}):Promise<{status:'existing'|'registered';jobId:string;jobStatus:ContentExecutionJobStatus}>{
 function fail(code:string):never{throw new SocialContentWorkflowError(code,409);}
 const row=await requireSocialTask(input),authority=socialObject(socialObject(socialJson(row.brief))?._weeklyAuthority),pkg=socialObject(authority?.weeklyPackage),store=input.repository.dataStore;
 if(!store||!pkg||typeof pkg.programId!=='string'||typeof pkg.packageId!=='string'||!Number.isSafeInteger(pkg.version))fail('weekly_production_start_authority_invalid');
 const scope={tenantId:input.tenantId,programId:pkg.programId,packageId:pkg.packageId,packageVersion:Number(pkg.version)};
 return withExecutionPackageGate(store,scope,async assert=>{
 if(await executionPackageFrozen(store,scope))fail('weekly_execution_package_frozen');const actual=await requireSocialTask(input);
 if(actual.run_id!==input.runId||!input.runId||!['producing','needs_input','attention'].includes(String(actual.status)))fail('weekly_original_run_queue_state_changed');
 const run=await store.getById<Record<string,unknown>>('workflow_runs',input.runId),context=socialObject(socialJson(run?.starter_context));if(!run||run.tenant_id!==input.tenantId||run.status!=='running'||context?.schemaVersion!=='starter-social-content.auto-execution.v1'||context.socialTaskId!==input.taskId)fail('weekly_original_run_queue_identity_invalid');
 const jobs=await store.list<any>('content_execution_jobs',{where:{tenant_id:input.tenantId,task_id:input.taskId,run_id:input.runId},perPage:2});if(jobs.totalItems>1||jobs.items.length!==jobs.totalItems)fail('weekly_original_run_queue_ambiguous');if(jobs.items.length){const job=jobs.items[0];if(job.tenant_id!==input.tenantId||job.task_id!==input.taskId||job.run_id!==input.runId||job.task_type!==`social_content_${actual.task_mode}`)fail('weekly_original_run_queue_identity_invalid');if(!['queued','running','retry_wait','reconciling','blocked','paused','succeeded','cancelled','dead_letter'].includes(job.status))fail('weekly_original_run_queue_identity_invalid');return {status:'existing',jobId:job.id,jobStatus:job.status};}
 const tasks=await store.list<any>('workflow_tasks',{where:{tenant_id:input.tenantId,run_id:input.runId,task_key:'social_content_auto_production'},perPage:500});if(tasks.totalItems!==tasks.items.length||tasks.items.length!==1)fail('weekly_original_run_execution_unverified');const execution=tasks.items[0],output=socialObject(socialJson(execution.output));
 if(execution.owner_id!==input.userId||execution.status!=='running'||output?.schemaVersion!=='starter-social-content.auto-execution.v1'||output.socialTaskId!==input.taskId||output.production||execution.external_effect!=='none')fail('weekly_original_run_execution_unverified');
 await assert();await enqueueSocialContentAutoProduction(input);await assert();
 const registered=await store.list<any>('content_execution_jobs',{where:{tenant_id:input.tenantId,task_id:input.taskId,run_id:input.runId},perPage:2});if(registered.totalItems!==1||registered.items.length!==1||!['queued','running','retry_wait','reconciling','blocked','paused','succeeded','cancelled','dead_letter'].includes(registered.items[0].status)||registered.items[0].tenant_id!==input.tenantId||registered.items[0].task_id!==input.taskId||registered.items[0].run_id!==input.runId||registered.items[0].task_type!==`social_content_${actual.task_mode}`)fail('weekly_original_run_queue_registration_failed');return {status:'registered',jobId:registered.items[0].id,jobStatus:registered.items[0].status};
 });
}
