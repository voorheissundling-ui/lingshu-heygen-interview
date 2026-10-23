import type {DataStore,Record_} from '../storage/datastore.js';
import {canonicalWeeklyProductionPublication} from '../runtime/weeklyContentProductionIdentity.js';
import type {WeeklyExecutionTask,WeeklyOperatingPackage} from '../../shared/contracts/socialProgram.js';
import {listContentExecutionLimits,readContentExecutionJob} from '../contentExecution/durableQueue.js';
import {observeWeeklyQueueResources} from './weeklyObservedQueueResources.js';
import {socialObject,socialJson,socialRequestHash} from '../starter198/socialContentValidation.js';
import {backwardTaskEvidenceFingerprint} from './weeklyBackwardSchedule.js';
import {SocialProgramError} from './service.js';
import type {WeeklyScheduleTargetGraph} from '../../shared/contracts/socialWeeklyScheduleRevision.js';
export interface WeeklyQueueSchedulingEvidence {
 verifiedAt:string;configurationHash:string;inputEvidenceHash:string;
 pools:Record<string,{concurrency:number;configurationHash:string;unknownRunningOccupation:boolean}>;
 tasks:Record<string,{taskFingerprint:string;productionSubjectId:string|null;resourceKeys:string[];reasons:string[]}>;
}
// quality_check/rework adapter only verifies existing artifacts and G4/G5; it
// does not enqueue production. Their actual work/time/cost remains user capacity.
const productionSteps=new Set(['script','script_generation','storyboard','storyboard_matching','material_readiness','asset_generation','video_generation']);
const fail=():never=>{throw new SocialProgramError('weekly_queue_schedule_identity_invalid',409,'生产资源身份发生变化，未预留排期。');};
/** Server-only: real queued production identity and all three persisted limits.
 * Running jobs have no verified ETA, so their affected pools remain unavailable
 * for a future promise, regardless of snapshot free slots or lease expiry. */
export async function readWeeklyQueueSchedulingEvidence(store:DataStore,tasks:WeeklyExecutionTask[],now:Date,frozenPackage?:WeeklyOperatingPackage,target?:{pkg:WeeklyOperatingPackage;graph:WeeklyScheduleTargetGraph}):Promise<WeeklyQueueSchedulingEvidence>{
 const scopes=new Set(tasks.map(t=>socialRequestHash([t.tenantId,t.programId,t.packageId,t.packageVersion])));if(scopes.size!==1||!Number.isFinite(now.getTime()))return fail();
 const tenantId=tasks[0]!.tenantId,limits=await listContentExecutionLimits(store,tenantId);
 if(target){const first=tasks[0]!,p=target.pkg,g=target.graph;if(!frozenPackage||g.tenantId!==tenantId||g.programId!==first.programId||g.packageId!==first.packageId||g.sourceVersion!==first.packageVersion||g.targetVersion!==first.packageVersion+1||p.programId!==g.programId||p.packageId!==g.packageId||p.version!==g.targetVersion||p.previousVersion!==g.sourceVersion||frozenPackage.version!==g.sourceVersion||socialRequestHash(g.tasks)!==socialRequestHash(tasks))return fail();}
 const output:WeeklyQueueSchedulingEvidence={verifiedAt:now.toISOString(),configurationHash:'',inputEvidenceHash:'',pools:{},tasks:{}};
 const putPool=(key:string,pool:WeeklyQueueSchedulingEvidence['pools'][string])=>{const existing=output.pools[key];if(existing&&socialRequestHash(existing)!==socialRequestHash(pool))return fail();output.pools[key]=pool;};
 const groups=new Map<string,WeeklyExecutionTask[]>();
 const identityPackage=(task:WeeklyExecutionTask)=>{
  if(frozenPackage?.socialContentPackage.publicationTasks.some(p=>p.publicationTaskId===task.publicationTaskId))return frozenPackage;
  if(target?.graph.bindings.some(b=>b.planningTaskId===task.taskId&&b.origin==='new_planned'&&b.sourceTaskId===null))return target.pkg;
  return undefined;
 };
 for(const task of tasks.filter(t=>productionSteps.has(t.schedule.stepKind)&&t.status!=='succeeded')){const pkg=identityPackage(task),key=pkg&&task.publicationTaskId?canonicalWeeklyProductionPublication(pkg,task.publicationTaskId).publicationTaskId:task.publicationTaskId??task.taskId;groups.set(key,[...(groups.get(key)??[]),task]);}
 for(const group of groups.values()){
 const candidate=group[0]!,canonicalPackage=identityPackage(candidate),canonical=canonicalPackage&&candidate.publicationTaskId?canonicalWeeklyProductionPublication(canonicalPackage,candidate.publicationTaskId):null;
 const first=canonical?{...candidate,publicationTaskId:canonical.publicationTaskId,accountId:canonical.accountId}:candidate,key=`weekly-production:${first.packageId}:${first.packageVersion}:${first.publicationTaskId}`;
 const result=await store.list<Record_>('starter_social_content_tasks',{where:{tenant_id:tenantId,create_idempotency_key:key},perPage:2});
 const assign=(subject:string|null,keys:string[],reasons:string[])=>{for(const task of group)output.tasks[task.taskId]={taskFingerprint:backwardTaskEvidenceFingerprint(task),productionSubjectId:subject,resourceKeys:keys,reasons};};
 if(!first.publicationTaskId){assign(null,[],['queue_job_identity_required']);continue;}
 if(result.totalItems===1&&result.items.length===1&&!result.items[0]!.run_id){const row=result.items[0]!,brief=socialObject(socialJson(row.brief)),authority=socialObject(brief?._weeklyAuthority),pkg=socialObject(authority?.weeklyPackage);if(row.tenant_id!==tenantId||row.create_idempotency_key!==key||row.task_mode!=='weekly'||pkg?.programId!==first.programId||pkg.packageId!==first.packageId||pkg.version!==first.packageVersion||['cancelled','paused','failed'].includes(String(row.status)))return fail();}
 if(result.totalItems===0||(result.totalItems===1&&result.items.length===1&&!result.items[0]!.run_id)){
 // The actual weekly producer's CreateSocialContentTaskInput fixes mode='weekly';
 // enqueueSocialContentAutoProduction fixes taskType=`social_content_${task.mode}`.
 // This is a planned handler manifest, never an actual job or running reservation.
 let pkg=frozenPackage;
 // Only newly planned graph bindings may borrow the verified target package.
 // Existing jobs and existing source publications always retain source authority.
 if(target&&!frozenPackage?.socialContentPackage.publicationTasks.some(p=>p.publicationTaskId===first.publicationTaskId)&&group.every(t=>target.graph.bindings.some(b=>b.planningTaskId===t.taskId&&b.origin==='new_planned'&&b.sourceTaskId===null)))pkg=target.pkg;
 const publication=pkg?.socialContentPackage.publicationTasks.filter(p=>p.publicationTaskId===first.publicationTaskId);
 if(!pkg||pkg.programId!==first.programId||pkg.packageId!==first.packageId||(pkg!==target?.pkg&&pkg.version!==first.packageVersion)||publication?.length!==1||publication[0]!.inventoryReuseRef||group.some(t=>pkg.socialContentPackage.productionIdentityVersion!=='shared-original.v1'&&t.accountId!==publication[0]!.accountId)){assign(null,[],['queue_planned_handler_authority_required']);continue;}
 const manifest={handler:'weekly_social_content_production.v1',tenantId,programId:first.programId,packageId:first.packageId,packageVersion:pkg.version,publicationTaskId:first.publicationTaskId,accountId:publication[0]!.accountId,taskType:'social_content_weekly',publicationHash:socialRequestHash(publication[0])};
 const observation=await observeWeeklyQueueResources(store,{tenantId,accountId:manifest.accountId,taskType:manifest.taskType},limits,now),keys:string[]=[];
 for(const r of observation.resources){keys.push(r.resourceKey);putPool(r.resourceKey,{concurrency:r.configuration.maximumRunning,configurationHash:r.configuration.recordHash,unknownRunningOccupation:r.observation.runningJobCount>0});}
 assign(`planned-handler:${socialRequestHash(manifest)}`,keys,observation.missingScopes.map(s=>`persisted_${s}_queue_limit_missing`));continue;
 }
 if(result.totalItems!==1||result.items.length!==1)return fail();const row=result.items[0]!,brief=socialObject(socialJson(row.brief)),authority=socialObject(brief?._weeklyAuthority),pkg=socialObject(authority?.weeklyPackage);
 if(row.tenant_id!==tenantId||row.create_idempotency_key!==key||pkg?.programId!==first.programId||pkg.packageId!==first.packageId||pkg.version!==first.packageVersion||typeof row.task_id!=='string'||typeof row.run_id!=='string')return fail();
 const run=await store.getById<Record_>('workflow_runs',row.run_id);if(!run||run.tenant_id!==tenantId)return fail();
 const job=await readContentExecutionJob(store,tenantId,row.task_id,row.run_id);
 if(!job){assign(null,[],['queue_job_identity_required']);continue;}
 if(!job.accountId||group.some(t=>t.accountId!==job.accountId)||job.taskType!==`social_content_${row.task_mode}`)return fail();
 const observation=await observeWeeklyQueueResources(store,job,limits,now);const keys:string[]=[],reasons=observation.missingScopes.map(s=>`persisted_${s}_queue_limit_missing`);
 for(const resource of observation.resources){keys.push(resource.resourceKey);const pool={concurrency:resource.configuration.maximumRunning,configurationHash:resource.configuration.recordHash,unknownRunningOccupation:resource.observation.runningJobCount>0};putPool(resource.resourceKey,pool);}
 if(job.status==='succeeded')reasons.push('queue_completed_generation_requires_result_evidence');
 else if(job.status!=='queued'||job.lastStartedAt)reasons.push('queue_production_remaining_work_unverified');
 assign(job.id,keys,reasons);
 }
 output.configurationHash=socialRequestHash(output.pools);output.inputEvidenceHash=socialRequestHash({pools:output.pools,tasks:output.tasks});return output;
}
