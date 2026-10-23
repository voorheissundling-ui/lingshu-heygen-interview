import {STARTER_COLLECTIONS,type Starter198Repository} from '../starter198/repository.js';
import {socialJson,socialObject,socialRequestHash} from '../starter198/socialContentValidation.js';
/** A failed prerequisite admission may be retried against a revised subject;
 * a pending/unknown original operation always retains its original key/version. */
export async function readWeeklyProductionStartAttempt(input:{repository:Starter198Repository;tenantId:string;taskId:string;binding:string;version:string}){
 const base=`${input.binding}:start`;
 const rows=await input.repository.list(STARTER_COLLECTIONS.socialContentOperations,input.tenantId,{where:{target_id:input.taskId,operation:'start_social_content_task'},perPage:200});
 if(rows.totalItems!==rows.items.length)throw Error('weekly_start_attempt_ambiguous');
 const family=rows.items.filter(row=>row.idempotency_key===base||String(row.idempotency_key).startsWith(`${base}:version:`));
 if(!family.length)return{idempotencyKey:base,expectedVersion:input.version};
 const selected=family.filter(row=>row.status!=='failed');
 if(selected.length>1)throw Error('weekly_start_attempt_ambiguous');
 const current=family.find(row=>row.idempotency_key===`${base}:version:${input.version}`);
 const row=selected[0]??current??family.sort((a,b)=>String(b.updated_at).localeCompare(String(a.updated_at)))[0]!;
 const receipt=socialObject(socialJson(row.result));
 const version=receipt?.expectedVersion;
 if(typeof version!=='string'||row.request_hash!==socialRequestHash({expectedVersion:version})||row.target_id!==input.taskId||row.operation!=='start_social_content_task')throw Error('weekly_start_attempt_corrupt');
 if(row.status!=='failed'||version===input.version)return{idempotencyKey:String(row.idempotency_key),expectedVersion:version};
 const retryable=new Set(['social_content_execution_director_review_required','social_content_execution_budget_required','social_content_execution_rights_required','social_content_execution_facts_required','social_content_execution_goal_degraded','social_content_task_inputs_incomplete']);
 if(!retryable.has(String(row.error_code)))return{idempotencyKey:String(row.idempotency_key),expectedVersion:version};
 const tasks=await input.repository.list(STARTER_COLLECTIONS.socialContentTasks,input.tenantId,{where:{task_id:input.taskId},perPage:2});
 if(tasks.totalItems!==1||tasks.items.length!==1)throw Error('weekly_start_attempt_subject_changed');
 const task=tasks.items[0]!;
 const dataStore=input.repository.dataStore;if(!dataStore)throw Error('weekly_start_attempt_store_missing');
 const jobs=await dataStore.list('content_execution_jobs',{where:{tenant_id:input.tenantId,task_id:input.taskId},perPage:1});
 if(task.run_id||task.orchestrator_item_id||jobs.totalItems) return{idempotencyKey:String(row.idempotency_key),expectedVersion:version};
 return{idempotencyKey:`${base}:version:${input.version}`,expectedVersion:input.version};
}
