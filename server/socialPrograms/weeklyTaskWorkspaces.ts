import {createHash} from 'node:crypto';
import type {DataStore,Record_} from '../storage/datastore.js';
import type {WeeklyExecutionTask,WeeklyProductionStepKind} from '../../shared/contracts/socialProgram.js';
import {WEEKLY_TASK_WORKSPACE_SCHEMA_VERSION,type WeeklyTaskWorkspace,type WeeklyTaskWorkspaceKind,type WeeklyTaskWorkspacePhase} from '../../shared/contracts/weeklyTaskWorkspace.js';
import {SocialProgramError} from './service.js';
import {normalizeCustomerTaskDependencies} from './customerTaskDependencies.js';
import {jobFromRow,type ContentExecutionJob} from '../contentExecution/durableQueueRecords.js';
import type {WeeklyTaskWorkspaceRuntime} from '../../shared/contracts/weeklyTaskWorkspace.js';

export const WEEKLY_TASK_WORKSPACES='social_weekly_task_workspaces';
type Row=Record_&{tenant_id:string;program_id:string;package_id:string;package_version:number;execution_task_id:string;workspace_id:string;payload:WeeklyTaskWorkspace};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const workspaceId=(task:WeeklyExecutionTask)=>`wtw_${hash(`${task.tenantId}:${task.programId}:${task.packageId}:${task.packageVersion}:${task.taskId}`).slice(0,24)}`;

const kindByStep:Record<WeeklyProductionStepKind,WeeklyTaskWorkspaceKind>={
 business_outline:'planning',business_schedule:'planning',benchmark_collection:'inspiration',benchmark_scoring:'inspiration',director_analysis:'inspiration',
 material_preparation:'materials',material_readiness:'materials',script:'content',storyboard:'content',asset_generation:'content',video_generation:'content',quality_check:'content',rework:'content',user_approval:'content',
 publishing:'publishing',customer_channel_readiness:'customer',customer_inquiry_handoff:'customer',performance_monitoring:'review',weekly_review:'review',template_extraction:'template',template_performance_validation:'template',
};
function phase(task:WeeklyExecutionTask):WeeklyTaskWorkspacePhase{
 if(task.status==='succeeded')return 'completed';if(task.status==='cancelled')return 'cancelled';if(task.status==='leased')return 'running';
 if(task.schedule.stepKind==='user_approval'&&task.status==='blocked')return 'waiting_human';
 if(task.ownBlockingReasons.length)return 'blocked';
 if(task.status==='blocked'||task.status==='dead_letter')return task.inheritedBlockingTaskIds.length&&!task.ownBlockingReasons.length?'waiting_upstream':'blocked';
 return task.inheritedBlockingTaskIds.length?'waiting_upstream':'ready';
}
const emptyRuntime=():WeeklyTaskWorkspaceRuntime=>({pauseReasons:[],completedWork:[],actualCost:{status:'none',totalCny:null,evidenceRefs:[]},recovery:{taskAttempt:0,taskMaximumAttempts:0,recoveredFromDeadLetterAt:null,jobId:null,jobStatus:null,jobAttempt:null,reconciliationAttempt:null,retryClass:null,nextAttemptAt:null,providerReceipts:[]},checkpoints:[],nextActions:[{code:'none',label:'当前无需用户处理',userRequired:false}],mayChargeAgain:{status:'unknown',reason:'尚无足够执行证据判断后续是否会产生费用'}});
function snapshot(task:WeeklyExecutionTask,createdAt:string,now:string):WeeklyTaskWorkspace{
 task=normalizeCustomerTaskDependencies(task);
 const progress=task.productionProgress;
 return {schemaVersion:WEEKLY_TASK_WORKSPACE_SCHEMA_VERSION,workspaceId:workspaceId(task),tenantId:task.tenantId,programId:task.programId,packageId:task.packageId,packageVersion:task.packageVersion,executionTaskId:task.taskId,taskIdempotencyKey:task.idempotencyKey,stepKind:task.schedule.stepKind,kind:kindByStep[task.schedule.stepKind],phase:phase(task),title:String(task.inputSnapshot?.publicationTask&&typeof task.inputSnapshot.publicationTask==='object'&&(task.inputSnapshot.publicationTask as Record<string,unknown>).businessProposition||task.schedule.stepKind),responsibleActor:task.schedule.responsibleActor,taskStatus:task.status,scheduledStartAt:task.schedule.estimatedStartAt??null,scheduledFinishAt:task.schedule.estimatedFinishAt??null,upstreamTaskIds:[...task.dependsOnTaskIds],blockingCodes:[...new Set([...task.ownBlockingReasons,...task.inheritedBlockingTaskIds.map(id=>`upstream:${id}`),...(task.lastError?.code?[task.lastError.code]:[])])],resultRefs:task.resultRefs.map(ref=>({...ref})),contentTaskId:progress?.contentTaskId??null,runId:progress?.runId??null,accountId:task.accountId??null,publicationTaskId:task.publicationTaskId??null,runtime:emptyRuntime(),createdAt,updatedAt:now};
}

type UsageRow=Record_&{tenant_id?:string;task_id?:string;run_id?:string;event_type?:string;state?:string;reservation_id?:string;usage?:unknown};
const object=(value:unknown):Record<string,unknown>|null=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
function usagePayload(row:UsageRow){if(typeof row.usage!=='string')return object(row.usage);try{return object(JSON.parse(row.usage));}catch{return null;}}
async function exactJob(store:DataStore,task:WeeklyExecutionTask):Promise<ContentExecutionJob|null>{const contentTaskId=task.productionProgress?.contentTaskId,runId=task.productionProgress?.runId;if(!contentTaskId||!runId)return null;const rows=await store.list<Record_>('content_execution_jobs',{where:{tenant_id:task.tenantId,task_id:contentTaskId,run_id:runId},page:1,perPage:2});if(rows.totalItems>1||rows.items.length>1)throw new SocialProgramError('weekly_task_workspace_job_ambiguous',409,'当前任务存在多个内容执行作业。');if(!rows.items[0])return null;try{const job=jobFromRow(rows.items[0]);if(job.tenantId!==task.tenantId||job.taskId!==contentTaskId||job.runId!==runId)throw Error('scope');return job;}catch{throw new SocialProgramError('weekly_task_workspace_job_invalid',503,'内容执行作业记录无法可信读取。');}}
async function actualCost(store:DataStore,task:WeeklyExecutionTask){const contentTaskId=task.productionProgress?.contentTaskId,runId=task.productionProgress?.runId;if(!contentTaskId||!runId)return{status:'none' as const,totalCny:null,evidenceRefs:[]};const rows=await store.list<UsageRow>('starter_usage_ledger',{where:{tenant_id:task.tenantId,task_id:contentTaskId,run_id:runId},page:1,perPage:500});if(rows.totalItems!==rows.items.length)throw new SocialProgramError('weekly_task_workspace_cost_scan_incomplete',503,'实际费用回执未能完整读取。');let total=0,unknown=false;const evidenceRefs:string[]=[];for(const row of rows.items){if(row.tenant_id!==task.tenantId||row.task_id!==contentTaskId||row.run_id!==runId)throw new SocialProgramError('weekly_task_workspace_cost_scope_invalid',409,'费用回执与当前任务身份不一致。');if(row.event_type!=='terminal'||row.state!=='settled')continue;const usage=usagePayload(row),cost=usage?.settled_cost_cny;if(usage?.cost_status==='known'&&typeof cost==='number'&&Number.isFinite(cost)&&cost>=0){total+=cost;evidenceRefs.push(`starter_usage_ledger:${row.id}`);}else unknown=true;}return unknown?{status:'unknown' as const,totalCny:null,evidenceRefs}:{status:evidenceRefs.length?'known' as const:'none' as const,totalCny:evidenceRefs.length?Math.round(total*1_000_000)/1_000_000:null,evidenceRefs};}
async function runtimeProjection(store:DataStore,task:WeeklyExecutionTask,dependencies:WeeklyExecutionTask[]):Promise<WeeklyTaskWorkspaceRuntime>{
 const [job,cost]=await Promise.all([exactJob(store,task),actualCost(store,task)]);
 const completed=[...dependencies,task].filter(value=>value.status==='succeeded').map(value=>({executionTaskId:value.taskId,stepKind:value.schedule.stepKind,finishedAt:value.schedule.actualFinishedAt??null,resultRefs:value.resultRefs.map(ref=>({...ref}))}));
 const pauseReasons=[...task.ownBlockingReasons.map(code=>({code,message:code,retryable:null,occurredAt:null})),...(task.lastError?[{code:task.lastError.code,message:task.lastError.message,retryable:task.lastError.retryable,occurredAt:task.lastError.occurredAt}]:[])];
 const inherited=task.inheritedBlockingTaskIds.length>0,automatic=Boolean(job&&['queued','running','retry_wait','reconciling'].includes(job.status));
 const userRequired=task.schedule.stepKind==='user_approval'||task.status==='blocked'&&!task.lastError?.retryable||Boolean(job&&['blocked','paused','dead_letter'].includes(job.status));
 const nextActions=userRequired?[{code:task.schedule.stepKind==='user_approval'?'review_output' as const:'resolve_task_blocker' as const,label:task.schedule.stepKind==='user_approval'?'验收当前成片':'处理当前任务卡点',userRequired:true}]:inherited?[{code:'wait_upstream' as const,label:'等待真实上游任务完成',userRequired:false}]:automatic?[{code:'wait_automatic_retry' as const,label:'系统正在执行或按原作业恢复',userRequired:false}]:[{code:'none' as const,label:'当前无需用户处理',userRequired:false}];
 const checkpointEntries=job?Object.entries(job.checkpoints).map(([key,value])=>({key,version:value.version,inputHash:value.inputHash,updatedAt:value.updatedAt})).sort((a,b)=>a.key.localeCompare(b.key)):[];
 const terminal=task.status==='succeeded'||task.status==='cancelled'||job?.status==='succeeded'||job?.status==='cancelled',uncertainProvider=job?.providerReceipts.some(receipt=>['submitting','accepted','unknown'].includes(receipt.state));
 const mayChargeAgain=terminal?{status:'not_expected' as const,reason:'当前任务或内容作业已经结束'}:uncertainProvider?{status:'unknown' as const,reason:'供应商请求已提交但费用或结果尚未完成对账，禁止重复提交'}:task.budget.limitCny===0?{status:'not_expected' as const,reason:'当前执行任务的冻结预算上限为 0 元'}:task.budget.limitCny===null?{status:'unknown' as const,reason:'当前任务没有可核验的费用上限，付费步骤继续保持阻塞'}:{status:'possible' as const,reason:'任务尚未结束，后续付费步骤仍须通过原预算和付费准入'};
 return{pauseReasons,completedWork:completed,actualCost:cost,recovery:{taskAttempt:task.attempt,taskMaximumAttempts:task.maxAttempts,recoveredFromDeadLetterAt:task.recoveredFromDeadLetterAt,jobId:job?.id??null,jobStatus:job?.status??null,jobAttempt:job?.attempt??null,reconciliationAttempt:job?.reconciliationAttempt??null,retryClass:job?.retryClass??null,nextAttemptAt:job?.nextAttemptAt??null,providerReceipts:job?.providerReceipts.map(receipt=>({provider:receipt.provider,requestId:receipt.requestId,state:receipt.state,providerTaskId:receipt.providerTaskId,updatedAt:receipt.updatedAt}))??[]},checkpoints:checkpointEntries,nextActions,mayChargeAgain};
}
const rowData=(workspace:WeeklyTaskWorkspace)=>({tenant_id:workspace.tenantId,program_id:workspace.programId,package_id:workspace.packageId,package_version:workspace.packageVersion,execution_task_id:workspace.executionTaskId,workspace_id:workspace.workspaceId,kind:workspace.kind,phase:workspace.phase,payload:workspace,created_at:workspace.createdAt,updated_at:workspace.updatedAt});
function assertIdentity(workspace:WeeklyTaskWorkspace,task:WeeklyExecutionTask){if(workspace.schemaVersion!==WEEKLY_TASK_WORKSPACE_SCHEMA_VERSION||workspace.workspaceId!==workspaceId(task)||workspace.tenantId!==task.tenantId||workspace.programId!==task.programId||workspace.packageId!==task.packageId||workspace.packageVersion!==task.packageVersion||workspace.executionTaskId!==task.taskId||workspace.taskIdempotencyKey!==task.idempotencyKey)throw new SocialProgramError('weekly_task_workspace_identity_changed',409,'任务生产现场身份与真实执行任务不一致。');}

export async function ensureWeeklyTaskWorkspaces(store:DataStore,tasks:WeeklyExecutionTask[],now=new Date().toISOString()):Promise<WeeklyTaskWorkspace[]>{
 const created:string[]=[];const result:WeeklyTaskWorkspace[]=[];
 try{for(const task of tasks){const list=await store.list<Row>(WEEKLY_TASK_WORKSPACES,{where:{tenant_id:task.tenantId,execution_task_id:task.taskId},page:1,perPage:2});if(list.totalItems>1||list.items.length>1)throw new SocialProgramError('weekly_task_workspace_duplicate',409,'一个执行任务存在多个生产现场。');const old=list.items[0];if(old){assertIdentity(old.payload,task);const next=snapshot(task,old.payload.createdAt,now);if(!await store.update(WEEKLY_TASK_WORKSPACES,old.id,rowData(next)))throw Error('workspace update failed');result.push(next);}else{const value=snapshot(task,now,now),row=await store.create<Row>(WEEKLY_TASK_WORKSPACES,rowData(value));if(!row)throw Error('workspace create failed');created.push(row.id);result.push(value);}}
 }catch(error){for(const id of created)await store.delete(WEEKLY_TASK_WORKSPACES,id);if(error instanceof SocialProgramError)throw error;throw new SocialProgramError('weekly_task_workspace_storage_unavailable',503,'任务生产现场暂时无法保存。');}
 if(result.length!==tasks.length||new Set(result.map(item=>item.executionTaskId)).size!==tasks.length)throw new SocialProgramError('weekly_task_workspace_coverage_invalid',409,'真实任务与生产现场未形成一对一闭环。');return result;
}
export async function readWeeklyTaskWorkspace(store:DataStore,scope:{tenantId:string;programId:string;packageId:string;packageVersion:number;executionTaskId:string}):Promise<WeeklyTaskWorkspace>{
 const tasks=await store.list<Record_&{payload:WeeklyExecutionTask}>('social_weekly_execution_tasks',{where:{tenant_id:scope.tenantId,program_id:scope.programId,package_id:scope.packageId,package_version:scope.packageVersion,task_id:scope.executionTaskId},page:1,perPage:2});
 if(tasks.totalItems!==1||tasks.items.length!==1)throw new SocialProgramError('weekly_execution_task_not_found',404,'周包执行任务不存在。');const task=tasks.items[0]!.payload;
 const rows=await store.list<Row>(WEEKLY_TASK_WORKSPACES,{where:{tenant_id:scope.tenantId,program_id:scope.programId,package_id:scope.packageId,package_version:scope.packageVersion,execution_task_id:scope.executionTaskId},page:1,perPage:2});
 if(rows.totalItems!==1||rows.items.length!==1)throw new SocialProgramError('weekly_task_workspace_missing',409,'真实执行任务尚未补建生产现场。');assertIdentity(rows.items[0]!.payload,task);
 const normalized=normalizeCustomerTaskDependencies(task);
 const unfinished:string[]=[];const dependencies:WeeklyExecutionTask[]=[];
 for(const id of normalized.dependsOnTaskIds){
  const upstream=await store.list<Record_&{payload:WeeklyExecutionTask}>('social_weekly_execution_tasks',{where:{tenant_id:scope.tenantId,program_id:scope.programId,package_id:scope.packageId,package_version:scope.packageVersion,task_id:id},page:1,perPage:2});
  if(upstream.totalItems!==1||upstream.items.length!==1)throw new SocialProgramError('weekly_task_workspace_dependency_missing',409,'当前任务的真实上游任务缺失或不唯一。');
  const dependency=upstream.items[0]!.payload;dependencies.push(dependency);if(dependency.status!=='succeeded')unfinished.push(id);
 }
 const actual={...normalized,inheritedBlockingTaskIds:unfinished};return{...snapshot(actual,rows.items[0]!.payload.createdAt,rows.items[0]!.payload.updatedAt),runtime:await runtimeProjection(store,actual,dependencies)};
}

export async function backfillWeeklyTaskWorkspaces(store:DataStore,scope:{tenantId:string;programId:string;packageId:string;packageVersion:number},now=new Date().toISOString()):Promise<{taskCount:number;workspaceCount:number;items:WeeklyTaskWorkspace[]}>{
 const tasks:WeeklyExecutionTask[]=[];let page=1,totalPages=1;
 do{
  const batch=await store.list<Record_&{payload:WeeklyExecutionTask}>('social_weekly_execution_tasks',{where:{tenant_id:scope.tenantId,program_id:scope.programId,package_id:scope.packageId,package_version:scope.packageVersion},page,perPage:200});
  totalPages=batch.totalPages||1;
  for(const row of batch.items){const task=row.payload;if(!task||task.tenantId!==scope.tenantId||task.programId!==scope.programId||task.packageId!==scope.packageId||task.packageVersion!==scope.packageVersion)throw new SocialProgramError('weekly_task_workspace_backfill_scope_mismatch',409,'历史任务身份与补建范围不一致。');tasks.push(task);}
  page++;
 }while(page<=totalPages);
 if(new Set(tasks.map(task=>task.taskId)).size!==tasks.length)throw new SocialProgramError('weekly_task_workspace_backfill_duplicate_task',409,'历史周包存在重复任务身份，不能补建生产现场。');
 const items=await ensureWeeklyTaskWorkspaces(store,tasks,now);
 return{taskCount:tasks.length,workspaceCount:items.length,items};
}
