import type {DataStore,Record_} from '../storage/datastore.js';
import {controlContentExecutionJob,type ContentExecutionJob} from '../contentExecution/durableQueue.js';
import {parseContentExecutionCheckpoints,parseContentProviderReceipts} from '../contentExecution/context.js';
import {readGraphContextSnapshot} from '../starter198/socialContentGraphContextSnapshots.js';
import {readWeeklyProductionVoice,weeklyProductionPresenterIds} from '../starter198/socialContentBoundPresenterVoice.js';
import {socialObject} from '../starter198/socialContentValidation.js';
import {socialJson} from '../starter198/socialContentValidation.js';
import type {WeeklyScanScope} from './weeklyScanScope.js';

const VOICE_BLOCK=/^user_input_required:(weekly_default_voice_(?:registry_missing|identity_missing|authorization_missing:[^\s]+|source_missing|source_mismatch|binding_missing|binding_mismatch)|multiple_presenter_voices_require_separate_audio_tracks)$/;

function contentJob(row:Record_):ContentExecutionJob{
 return {id:row.id,tenantId:String(row.tenant_id||''),jobKey:String(row.job_key||''),taskId:String(row.task_id||''),runId:String(row.run_id||''),userId:String(row.user_id||''),accountId:String(row.account_id||''),taskType:String(row.task_type||''),status:String(row.status) as ContentExecutionJob['status'],attempt:Number(row.attempt)||0,reconciliationAttempt:Number(row.reconciliation_attempt)||0,nextAttemptAt:row.next_attempt_at?String(row.next_attempt_at):null,workerId:row.worker_id?String(row.worker_id):null,leaseExpiresAt:row.lease_expires_at?String(row.lease_expires_at):null,retryClass:row.retry_class?String(row.retry_class):null,lastError:row.last_error?String(row.last_error):null,providerState:String(row.provider_state||'none'),providerReceipts:parseContentProviderReceipts(row.provider_receipts),checkpoints:parseContentExecutionCheckpoints(row.checkpoints),createdAt:String(row.created_at||''),updatedAt:String(row.updated_at||''),lastStartedAt:row.last_started_at?String(row.last_started_at):null,completedAt:row.completed_at?String(row.completed_at):null};
}

/** Rechecks the original weekly gate and retries the same durable job. It does
 * not write presenter evidence or change the frozen production plan. */
export async function runWeeklyPresenterVoiceRecoveryScan(input:{store:DataStore;scope?:WeeklyScanScope}){
 const report={examined:0,resumed:0,blocked:0,failed:0};
 for(let page=1;;page++){
  const rows=await input.store.list<Record_>('content_execution_jobs',{where:{status:'blocked',...(input.scope?{tenant_id:input.scope.tenantId}:{})},page,perPage:500,sort:'id'});
  if(!Number.isSafeInteger(rows.totalItems)||rows.totalItems<0||rows.items.length>500)throw Error('weekly_presenter_voice_recovery_scan_invalid');
  for(const row of rows.items){
   const current=contentJob(row);
   if(!VOICE_BLOCK.test(current.lastError||'')||!current.taskType.startsWith('social_content_weekly'))continue;
   report.examined++;
   try{
    if(current.workerId||current.leaseExpiresAt||current.providerReceipts.length){report.blocked++;continue;}
    if(input.scope){
     const tasks=await input.store.list<Record_>('starter_social_content_tasks',{where:{tenant_id:current.tenantId,task_id:current.taskId},perPage:2});
     const brief=socialObject(socialJson(tasks.items[0]?.brief)),authority=socialObject(brief?._weeklyAuthority),pkg=socialObject(authority?.weeklyPackage);
     if(tasks.totalItems!==1||pkg?.programId!==input.scope.programId||pkg?.packageId!==input.scope.packageId||pkg?.version!==input.scope.packageVersion){report.blocked++;continue;}
    }
    const checkpoint=current.checkpoints['social.executor'],binding=socialObject(checkpoint?.payload);
    if(checkpoint?.version!=='1'||!binding||binding.executor!=='langgraph'||binding.inputHash!==checkpoint.inputHash){report.blocked++;continue;}
    if(current.checkpoints['social.corrected_executor']){report.blocked++;continue;}
    const approved=readGraphContextSnapshot(binding);
    if(!approved?.assetSupplyPlan){report.blocked++;continue;}
    await readWeeklyProductionVoice(input.store,current.tenantId,weeklyProductionPresenterIds(approved.assetSupplyPlan));
    const latest=await input.store.getById<Record_>('content_execution_jobs',current.id);
    if(!latest||latest.tenant_id!==current.tenantId||latest.status!=='blocked'||latest.last_error!==current.lastError){report.blocked++;continue;}
    const resumed=await controlContentExecutionJob({dataStore:input.store,tenantId:current.tenantId,jobId:current.id,action:'retry'});
    if(resumed.id!==current.id||!['queued','reconciling'].includes(resumed.status))throw Error('weekly_presenter_voice_recovery_not_committed');
    report.resumed++;
   }catch{report.blocked++;}
  }
  if(page>=rows.totalPages||!rows.items.length)break;
 }
 return report;
}
