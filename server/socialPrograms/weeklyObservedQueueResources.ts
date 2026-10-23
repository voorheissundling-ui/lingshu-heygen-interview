import type {DataStore,Record_} from '../storage/datastore.js';
import type {ContentExecutionJob,ContentExecutionLimit,ContentExecutionLimitScope} from '../contentExecution/durableQueue.js';
import {DURABLE_OPERATION_LEASE_COLLECTION} from '../runtime/durableLease.js';
import {socialRequestHash} from '../starter198/socialContentValidation.js';
import {publicationInstant} from './publicationDeadlines.js';
import {SocialProgramError} from './service.js';
export interface WeeklyObservedQueueResource {
 resourceKey:string;scope:ContentExecutionLimitScope;scopeKey:string;
 configuration:{limitId:string;limitScopeKey:string;maximumRunning:number;configuredBy:string;updatedAt:string;recordHash:string};
 observation:{verifiedAt:string;runningJobCount:number;verifiedOccupiedCount:number;unverifiedOccupancyCount:number;liveJobIds:string[];availableSlots:number|null;recordHash:string};
}
const fail=(code:string):never=>{throw new SocialProgramError(code,409,'真实并发池证据不完整或读取期间已变化，未据此预留排期。');};
async function all(store:DataStore,collection:string,where:Record<string,string>):Promise<Record_[]>{const rows:Record_[]=[];let total:number|undefined;for(let page=1;page<=1000;page++){const result=await store.list<Record_>(collection,{where,page,perPage:100,sort:'id'});if(result.page!==page||!Number.isSafeInteger(result.totalItems)||result.totalItems<0||!Number.isSafeInteger(result.totalPages)||result.totalPages<0||(result.totalItems===0?result.totalPages>1:result.totalPages!==Math.ceil(result.totalItems/100))||result.items.length>100||total!==undefined&&total!==result.totalItems)return fail('weekly_queue_resource_pagination_changed');total=result.totalItems;for(const row of result.items){if(rows.some(r=>r.id===row.id)||!row.id||Object.entries(where).some(([key,value])=>row[key]!==value))return fail('weekly_queue_resource_scope_invalid');rows.push(structuredClone(row));}if(rows.length===total)return rows;if(!result.items.length||page>=result.totalPages)return fail('weekly_queue_resource_pagination_incomplete');}return fail('weekly_queue_resource_pagination_incomplete');}
/** Observe the three independently enforced durableQueue constraints. This does
 * not acquire future capacity, predict completion or certify remaining cost. */
export async function observeWeeklyQueueResources(store:DataStore,job:Pick<ContentExecutionJob,'tenantId'|'accountId'|'taskType'>,limits:ContentExecutionLimit[],now:Date):Promise<{resources:WeeklyObservedQueueResource[];missingScopes:ContentExecutionLimitScope[]}>{
 if(!Number.isFinite(now.getTime()))return fail('weekly_queue_resource_time_invalid');
 const running=await all(store,'content_execution_jobs',{tenant_id:job.tenantId,status:'running'});
 const leases=await all(store,DURABLE_OPERATION_LEASE_COLLECTION,{tenant_id:job.tenantId,lease_scope:'content_execution_job'});
 const configRows=await all(store,'content_execution_limits',{tenant_id:job.tenantId});
 const resources:WeeklyObservedQueueResource[]=[],missingScopes:ContentExecutionLimitScope[]=[];
 for(const scope of ['tenant','account','task_type'] as const){const key=scope==='tenant'?'*':scope==='account'?job.accountId:job.taskType;
 const selected=limits.filter(l=>l.scope===scope&&l.scopeKey===key),wildcard=limits.filter(l=>l.scope===scope&&l.scopeKey==='*');if(selected.length>1||wildcard.length>1)return fail('weekly_queue_resource_limit_ambiguous');const limit=selected[0]??wildcard[0];if(!limit){missingScopes.push(scope);continue;}
 const stored=configRows.filter(r=>r.id===limit.id);if(stored.length!==1||limit.tenantId!==job.tenantId||stored[0]!.limit_scope!==scope||stored[0]!.scope_key!==limit.scopeKey||stored[0]!.max_running!==limit.maxRunning||stored[0]!.updated_by!==limit.updatedBy||typeof stored[0]!.updated_at!=='string'||publicationInstant(String(stored[0]!.updated_at))!==Date.parse(limit.updatedAt)||!limit.updatedBy||!Number.isSafeInteger(limit.maxRunning)||limit.maxRunning<1||publicationInstant(limit.updatedAt)===null)return fail('weekly_queue_resource_limit_changed');
 const occupied=running.filter(r=>scope==='tenant'||(scope==='account'?r.account_id===job.accountId:r.task_type===job.taskType));let unverified=0;const liveJobIds:string[]=[];
 for(const active of occupied){const matched=leases.filter(l=>l.subject_id===active.id);if(matched.length>1)return fail('weekly_queue_resource_lease_ambiguous');const lease=matched[0],expires=typeof lease?.expires_at==='string'?publicationInstant(lease.expires_at):null;
 const acquired=typeof lease?.acquired_at==='string'?publicationInstant(lease.acquired_at):null,started=typeof active.last_started_at==='string'?publicationInstant(active.last_started_at):null;
 if(typeof active.worker_id!=='string'||!active.worker_id||acquired===null||acquired>now.getTime()||expires!==null&&expires<=acquired||started===null||started>now.getTime()||typeof active.account_id!=='string'||!active.account_id||typeof active.task_type!=='string'||!active.task_type||typeof active.task_id!=='string'||!active.task_id||typeof active.run_id!=='string'||!active.run_id||!lease||typeof lease.lease_token!=='string'||!lease.lease_token||lease.owner_id!==active.worker_id||expires===null||typeof active.lease_expires_at!=='string'||publicationInstant(active.lease_expires_at)!==expires||expires<=now.getTime()){unverified++;continue;}liveJobIds.push(active.id);}
 const config={limitId:limit.id,limitScopeKey:limit.scopeKey,maximumRunning:limit.maxRunning,configuredBy:limit.updatedBy,updatedAt:limit.updatedAt};const observation={verifiedAt:now.toISOString(),runningJobCount:occupied.length,verifiedOccupiedCount:liveJobIds.length,unverifiedOccupancyCount:unverified,liveJobIds:liveJobIds.sort(),availableSlots:unverified?null:Math.max(0,limit.maxRunning-occupied.length)};
 resources.push({resourceKey:`content-queue:${socialRequestHash({tenantId:job.tenantId,scope,scopeKey:key})}`,scope,scopeKey:key,configuration:{...config,recordHash:socialRequestHash(config)},observation:{...observation,recordHash:socialRequestHash({resourceKey:{tenantId:job.tenantId,scope,scopeKey:key},config,observation,leases:occupied.map(r=>{const l=leases.find(l=>l.subject_id===r.id);return {jobId:r.id,taskId:r.task_id,runId:r.run_id,accountId:r.account_id,taskType:r.task_type,workerHash:socialRequestHash(r.worker_id??null),leaseTokenHash:l?socialRequestHash(l.lease_token??null):null,expiresAt:l?.expires_at??null};})})}});
 }
 // A second read prevents a changing job/lease/configuration scan being reported as a coherent observation.
 for(const [collection,where,initial] of [['content_execution_jobs',{tenant_id:job.tenantId,status:'running'},running],[DURABLE_OPERATION_LEASE_COLLECTION,{tenant_id:job.tenantId,lease_scope:'content_execution_job'},leases],['content_execution_limits',{tenant_id:job.tenantId},configRows]] as const){if(socialRequestHash(await all(store,collection,where))!==socialRequestHash(initial))return fail('weekly_queue_resource_observation_changed');}
 return {resources,missingScopes};
}
