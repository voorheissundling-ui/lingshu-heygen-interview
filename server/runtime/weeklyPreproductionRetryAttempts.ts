import type {DataStore,Record_} from '../storage/datastore.js';
import type {WeeklyPreproductionJob} from './weeklyPreproductionProducer.js';
import type {SocialDiscoveryMode,SocialInspirationCollectionRun} from '../../shared/contracts/socialContentWorkflow.js';
import {socialRequestHash} from '../starter198/socialContentValidation.js';
import {planTerminalDiscoverySourceRetry} from '../socialDiscovery/retryPlan.js';
import {readCollectionRetryGrant,collectionBusinessDate} from '../socialDiscovery/dailyCollectionQuota.js';
import {WEEKLY_QUALIFIED_CONTINUATION_STAGES,type WeeklyQualifiedContinuationStage} from './weeklyQualifiedContinuationStage.js';

export const PREPRODUCTION_RETRY_ATTEMPTS='social_weekly_preproduction_retry_attempts';
export interface RetryGrantScope {grantId:string;programId:string;packageId:string;packageVersion:number;taskId:string;parentRunId:string;parentRunHash:string;}
export type RetryAuthorization={kind:'explicit_grant';grant:RetryGrantScope}|{kind:'normal_daily_window';businessDate:string};
export interface WeeklyPreproductionRetryAttempt extends WeeklyPreproductionJob {
 retry:{rootJobId:string;rootJobHash:string;parentRunId:string;parentRunHash:string;sourceSelection:Array<{mode:SocialDiscoveryMode;platform:string;queryRef:string}>;authorization?:RetryAuthorization;/** v1 compatibility */grant?:RetryGrantScope;kind?:'qualified_continuation';continuationStageId?:string};
}
const seal=(value:WeeklyPreproductionRetryAttempt)=>({...value,recordHash:socialRequestHash({...value,recordHash:''})});
async function runForKey(store:DataStore,root:WeeklyPreproductionJob,key:string){
 const runId=`weekly_discovery_${socialRequestHash({tenantId:root.tenantId,key})}`;
 return runForId(store,root,runId);
}
async function runForId(store:DataStore,root:WeeklyPreproductionJob,runId:string){
 const rows=await store.list<SocialInspirationCollectionRun & Record_>('social_discovery_runs',{where:{tenant_id:root.tenantId,runId},perPage:2});
 if(rows.totalItems!==1||rows.items.length!==1)return null;
 return rows.items[0]!;
}
const authorization=(a:WeeklyPreproductionRetryAttempt):RetryAuthorization|null=>a.retry.authorization??(a.retry.grant?{kind:'explicit_grant',grant:a.retry.grant}:null);
async function latestNaturalWeek(store:DataStore,root:WeeklyPreproductionJob){
 let latestWeek:string|null=null,rootWeek:string|null=null,latestVersion=0,rootFound=false,total:number|null=null,seen=0;
 for(let page=1;page<=1000;page++){
  const rows=await store.list<Record_>('social_weekly_operating_packages',{where:{tenant_id:root.tenantId,program_id:root.programId},page,perPage:250,sort:'id'});
  if(total!==null&&rows.totalItems!==total)throw Error('weekly_preproduction_package_scan_changed');
  total=rows.totalItems;seen+=rows.items.length;
  for(const row of rows.items){
   const pkg=row.payload as {packageId?:string;version?:number;weekStart?:string;status?:string};
   if(!pkg||typeof pkg.weekStart!=='string'||typeof pkg.version!=='number'||!Number.isSafeInteger(pkg.version))continue;
   if(pkg.packageId===root.packageId&&pkg.version===root.packageVersion){rootFound=['draft','active'].includes(String(pkg.status));rootWeek=pkg.weekStart;}
   if(latestWeek===null||pkg.weekStart>latestWeek)latestWeek=pkg.weekStart;
   if(pkg.packageId===root.packageId&&pkg.version>latestVersion)latestVersion=pkg.version;
  }
  if(page>=rows.totalPages){if(seen!==total)throw Error('weekly_preproduction_package_scan_incomplete');return rootFound&&rootWeek===latestWeek&&root.packageVersion===latestVersion;}
  if(!rows.items.length)throw Error('weekly_preproduction_package_scan_incomplete');
 }
 throw Error('weekly_preproduction_package_scan_limit');
}
type GrantReader=typeof readCollectionRetryGrant;
export async function readWeeklyPreproductionRetryAttempt(store:DataStore,root:WeeklyPreproductionJob,readGrant:GrantReader=readCollectionRetryGrant):Promise<WeeklyPreproductionRetryAttempt|null>{
 const rows=await store.list<Record_>(PREPRODUCTION_RETRY_ATTEMPTS,{where:{tenant_id:root.tenantId,program_id:root.programId,package_id:root.packageId,package_version:root.packageVersion,root_job_id:root.jobId},perPage:100});
 if(!rows.totalItems)return null;
 if(rows.items.length!==rows.totalItems)throw Error('weekly_preproduction_retry_scan_incomplete');
 const ordered=rows.items.sort((x,y)=>String((x.payload as WeeklyPreproductionRetryAttempt).boundAt).localeCompare(String((y.payload as WeeklyPreproductionRetryAttempt).boundAt))||x.id.localeCompare(y.id));
 let selected:WeeklyPreproductionRetryAttempt|null=null;
 for(const row of ordered){const a=row.payload as WeeklyPreproductionRetryAttempt,parent=a?.retry?await runForId(store,root,a.retry.parentRunId):null;
 if(!a?.retry||!parent||a.recordHash!==seal(a).recordHash||row.record_hash!==a.recordHash||row.id!==a.jobId||a.tenantId!==root.tenantId||a.programId!==root.programId||a.packageId!==root.packageId||a.packageVersion!==root.packageVersion||a.consumerTaskId!==root.consumerTaskId||a.consumerInputHash!==root.consumerInputHash||a.sourceHash!==root.sourceHash||a.retry.rootJobId!==root.jobId||a.retry.rootJobHash!==root.recordHash||a.retry.parentRunId!==parent.runId||a.retry.parentRunHash!==socialRequestHash(parent)||a.originalRunKey!==`${root.originalRunKey}:${a.retry.kind==='qualified_continuation'?'qualified':'retry'}:${a.jobId}`)throw Error('weekly_preproduction_retry_lineage_changed');
 const plan=a.retry.kind==='qualified_continuation'?null:planTerminalDiscoverySourceRetry(parent);
 if(row.tenant_id!==a.tenantId||row.program_id!==a.programId||row.package_id!==a.packageId||row.package_version!==a.packageVersion||row.task_id!==a.consumerTaskId||row.input_hash!==a.consumerInputHash||row.original_run_key!==a.originalRunKey||row.kind!==a.kind||row.status!==a.status||row.root_job_id!==root.jobId)throw Error('weekly_preproduction_retry_row_corrupt');
 const auth=authorization(a);if(!auth)throw Error('weekly_preproduction_retry_authorization_missing');
 if(a.dueAt!==root.dueAt||a.actorUserId!==root.actorUserId||a.kind!=='discovery'||socialRequestHash(a.authority)!==socialRequestHash(root.authority))throw Error('weekly_preproduction_retry_scope_changed');
 if(a.retry.kind==='qualified_continuation'){
  const stageRow=await store.getById<Record_>(WEEKLY_QUALIFIED_CONTINUATION_STAGES,a.retry.continuationStageId??''),stage=stageRow?.payload as WeeklyQualifiedContinuationStage|undefined;
  if(!stage||stageRow?.record_hash!==stage.recordHash||stage.recordHash!==socialRequestHash({...stage,recordHash:''})||stage.stageId!==a.retry.continuationStageId||stage.tenantId!==root.tenantId||stage.programId!==root.programId||stage.packageId!==root.packageId||stage.packageVersion!==root.packageVersion||stage.taskId!==root.consumerTaskId||stage.rootJobId!==root.jobId||stage.rootJobHash!==root.recordHash||stage.parentRunId!==parent.runId||stage.parentRunHash!==a.retry.parentRunHash||stage.minimumIntervalMs!==300000||stage.authorizesExecution!==false||stage.grantsAdditionalDailyQuota!==false||a.retry.sourceSelection.length!==1||socialRequestHash(a.retry.sourceSelection[0])!==socialRequestHash({mode:stage.source.mode,platform:stage.source.platform,queryRef:stage.source.queryRef}))throw Error('weekly_preproduction_qualified_stage_changed');
 }else if(!plan||plan.blockingCodes.length||!a.retry.sourceSelection.length||a.retry.sourceSelection.some(source=>!plan.eligibleSources.some(s=>socialRequestHash(s)===socialRequestHash(source))))throw Error('weekly_preproduction_retry_source_not_rejected');
 if(auth.kind==='explicit_grant'){const g=auth.grant;if(g.programId!==root.programId||g.packageId!==root.packageId||g.packageVersion!==root.packageVersion||g.taskId!==root.consumerTaskId||g.parentRunId!==parent.runId||g.parentRunHash!==socialRequestHash(parent))throw Error('weekly_preproduction_retry_scope_changed');const grant=await readGrant(store,{tenantId:root.tenantId,programId:root.programId,packageId:root.packageId,packageVersion:root.packageVersion,taskId:root.consumerTaskId,parentRunId:parent.runId,parentRunHash:a.retry.parentRunHash});if(!grant||grant.grantId!==g.grantId)throw Error('weekly_preproduction_retry_grant_changed');}
 else {const parentDay=collectionBusinessDate(new Date(parent.finishedAt??parent.startedAt));if(a.retry.kind==='qualified_continuation'?auth.businessDate!==parentDay:parent.stopReason!=='daily_collection_limit_reached'||auth.businessDate<=parentDay)throw Error('weekly_preproduction_retry_daily_window_invalid');}
 selected=a;}
 return selected;
}

/** Called only under the current package gate. Original run/job are untouched. */
export async function ensureWeeklyPreproductionRetryAttempt(store:DataStore,root:WeeklyPreproductionJob,now:string,readGrant:GrantReader=readCollectionRetryGrant){
 if(root.kind!=='discovery'||root.status!=='blocked')return null;
 if(!await latestNaturalWeek(store,root))return null;
 const prior=await readWeeklyPreproductionRetryAttempt(store,root,readGrant),businessDate=collectionBusinessDate(new Date(now));
 const priorRun=prior?await runForKey(store,root,prior.originalRunKey):null;
 // Pre-existing cross-day children remain readable for audit/reconciliation,
 // but a bound child without a persisted run cannot spend a new day's normal
 // quota. Current automatic packages require an explicit scoped grant.
 if(priorRun&&prior&&['bound','running','unknown','succeeded'].includes(prior.status))return prior;
 if(prior?.retry.kind==='qualified_continuation'&&['running','unknown','succeeded'].includes(prior.status))return prior;
 const priorAuth=prior?authorization(prior):null;
 if(prior?.status==='bound'&&priorAuth?.kind==='explicit_grant'){
  const g=await readGrant(store,{tenantId:root.tenantId,programId:root.programId,packageId:root.packageId,packageVersion:root.packageVersion,taskId:root.consumerTaskId,parentRunId:prior.retry.parentRunId,parentRunHash:prior.retry.parentRunHash});
  if(g?.businessDate===businessDate&&g.remainingCount>0)return prior;
 }
 const parent=priorRun??(prior?await runForId(store,root,prior.retry.parentRunId):await runForKey(store,root,root.originalRunKey));if(!parent)return null;
 const plan=planTerminalDiscoverySourceRetry(parent);if(plan.blockingCodes.length||!plan.eligibleSources.length)return null;
 const grant=await readGrant(store,{tenantId:root.tenantId,programId:root.programId,packageId:root.packageId,packageVersion:root.packageVersion,taskId:root.consumerTaskId,parentRunId:parent.runId,parentRunHash:plan.parentRunHash});
 let auth:RetryAuthorization;
 if(grant&&grant.remainingCount>0&&grant.businessDate===businessDate){auth={kind:'explicit_grant',grant:{grantId:grant.grantId,programId:root.programId,packageId:root.packageId,packageVersion:root.packageVersion,taskId:root.consumerTaskId,parentRunId:parent.runId,parentRunHash:plan.parentRunHash}};}
 else return null;
 const id=socialRequestHash({rootJobId:root.jobId,rootJobHash:root.recordHash,parentRunId:parent.runId,parentRunHash:plan.parentRunHash,authorization:auth}).slice(0,15);
 const attempt=seal({...root,jobId:id,originalRunKey:`${root.originalRunKey}:retry:${id}`,status:'bound',code:null,resultRefs:[],boundAt:now,updatedAt:now,recordHash:'',retry:{rootJobId:root.jobId,rootJobHash:root.recordHash,parentRunId:parent.runId,parentRunHash:plan.parentRunHash,sourceSelection:plan.eligibleSources,authorization:auth}} as WeeklyPreproductionRetryAttempt);
 if(!await store.create(PREPRODUCTION_RETRY_ATTEMPTS,{id,tenant_id:root.tenantId,program_id:root.programId,package_id:root.packageId,package_version:root.packageVersion,task_id:root.consumerTaskId,input_hash:root.consumerInputHash,kind:'discovery',status:attempt.status,original_run_key:attempt.originalRunKey,root_job_id:root.jobId,record_hash:attempt.recordHash,payload:attempt}))throw Error('weekly_preproduction_retry_create_unknown');
 return attempt;
}
