import type {DataStore,Record_} from '../storage/datastore.js';
import type {SocialInspirationCollectionRun} from '../../shared/contracts/socialContentWorkflow.js';
import type {WeeklyPreproductionJob} from './weeklyPreproductionProducer.js';
import {socialRequestHash} from '../starter198/socialContentValidation.js';
import {readDailyCollectionCapacity,DAILY_COLLECTION_RESERVATIONS,collectionBusinessDate} from '../socialDiscovery/dailyCollectionQuota.js';
import {planWeeklyQualifiedCandidateContinuation,weeklyQualifiedSourceKey,type WeeklyQualifiedAttempt,type WeeklyQualifiedCandidate,type WeeklyQualifiedSource} from './weeklyQualifiedCandidateContinuation.js';
import {readWeeklyCandidateAdmissionSnapshot} from './weeklyCandidateAdmissionSnapshot.js';
import type {WeeklyPreproductionRetryAttempt} from './weeklyPreproductionRetryAttempts.js';
import {PREPRODUCTION_RETRY_ATTEMPTS,readWeeklyPreproductionRetryAttempt} from './weeklyPreproductionRetryAttempts.js';
import {readIndependentAdmission} from '../socialPrograms/weeklyIndependentAdmission.js';
import {readWeeklyAutomaticPreproductionAdmission} from '../socialPrograms/weeklyAutomaticSchedule.js';
import type {WeeklyExecutionTask} from '../../shared/contracts/socialProgram.js';
import {assertExecutionPackageGate} from '../socialPrograms/weeklyExecutionGate.js';

export const WEEKLY_QUALIFIED_CONTINUATION_STAGES='social_weekly_qualified_continuation_stages';
export const WEEKLY_QUALIFIED_CONTINUATION_MIN_INTERVAL_MS=5*60_000;
export interface WeeklyQualifiedContinuationStage {
 schema:'weekly-qualified-continuation-stage.v1';stageId:string;tenantId:string;programId:string;packageId:string;packageVersion:number;taskId:string;
 rootJobId:string;rootJobHash:string;parentRunId:string;parentRunHash:string;runIds:string[];runHashes:string[];
 source:WeeklyQualifiedSource;businessDate:string;minimumIntervalMs:300000;candidateSnapshotHash:string;planHash:string;scopeId:string;scopeVersion:number;scopeHash:string;
 authorizesExecution:false;grantsAdditionalDailyQuota:false;recordHash:string;
}
async function all(store:DataStore,collection:string,where:Record<string,string|number>){
 const rows:Record_[]=[];let total:number|undefined;
 for(let page=1;page<=1000;page++){
  const result=await store.list<Record_>(collection,{where,page,perPage:100,sort:'id'});
  if(!Number.isSafeInteger(result.totalItems)||result.totalItems<0||total!==undefined&&total!==result.totalItems||result.items.some(row=>Object.entries(where).some(([k,v])=>row[k]!==v)||rows.some(old=>old.id===row.id)))throw Error('weekly_qualified_stage_scan_changed');
  total=result.totalItems;rows.push(...result.items);
  if(rows.length===total)return rows;
  if(!result.items.length||rows.length>total)throw Error('weekly_qualified_stage_scan_incomplete');
 }throw Error('weekly_qualified_stage_scan_limit');
}

/** Preparation only: the existing weekly package gate must be held by the
 * caller. This records a proposed source, never a collection permit. */
export async function ensureWeeklyQualifiedContinuationStage(input:{store:DataStore;job:WeeklyPreproductionJob;runs:SocialInspirationCollectionRun[];mediaRoot:string;now:Date;readOnly?:boolean;pendingAttemptKey?:string;candidateReader?:typeof readWeeklyCandidateAdmissionSnapshot}){
 const {store,job,runs,mediaRoot,now}=input;
 if(input.candidateReader&&process.env.NODE_ENV!=='test')throw Error('weekly_qualified_candidate_test_reader_forbidden');
 if(job.kind!=='discovery'||!job.authority||!runs.length||!Number.isFinite(now.getTime())||!job.recordHash||job.recordHash!==socialRequestHash({...job,recordHash:''}))throw Error('weekly_qualified_stage_scope_invalid');
 const businessDate=collectionBusinessDate(now);
 if(runs.some(run=>!Number.isFinite(Date.parse(run.startedAt??''))||collectionBusinessDate(new Date(run.startedAt))!==businessDate))return {ready:false as const,code:'weekly_qualified_cross_day_authorization_required',plan:null};
 const jobRows=await all(store,'social_weekly_preproduction_jobs',{tenant_id:job.tenantId,program_id:job.programId,package_id:job.packageId,package_version:job.packageVersion,task_id:job.consumerTaskId});
 const matchingJob=jobRows.filter(row=>row.id===job.jobId);
 if(matchingJob.length!==1||matchingJob[0]!.record_hash!==job.recordHash||socialRequestHash(matchingJob[0]!.payload)!==socialRequestHash(job))throw Error('weekly_qualified_stage_job_changed');
 const scopeRows=await all(store,'social_discovery_scopes',{tenant_id:job.tenantId,id:job.authority.scopeId});
 const scope=scopeRows[0];
 const scopePayload=scope?.payload as {approval?:{status?:string;scopeVersion?:number};discoveryBrief?:{modePolicies?:Record<string,{enabled?:boolean;sourceRefs?:string[];platforms?:string[]}>;competitorAccounts?:string[];weeklyAccountCollectionTarget?:{accountUrl?:string;targetCount?:number}}}|undefined;
 if(scopeRows.length!==1||scope.status!=='active'||scope.version!==job.authority.scopeVersion||socialRequestHash(scope.payload)!==job.authority.scopeHash||scopePayload?.approval?.status!=='approved'||scopePayload.approval.scopeVersion!==scope.version)throw Error('weekly_qualified_stage_scope_changed');
 const packages=await all(store,'social_weekly_operating_packages',{tenant_id:job.tenantId,program_id:job.programId,package_id:job.packageId,version:job.packageVersion});
 const pkg=packages[0]?.payload as {packageId?:string;version?:number;status?:string;socialContentPackage?:{originalContentTarget?:number;authorization?:{allowRealPublishing?:boolean}}}|undefined;
 if(packages.length!==1||pkg?.packageId!==job.packageId||pkg.version!==job.packageVersion||!['draft','active'].includes(pkg.status??'')||pkg.socialContentPackage?.originalContentTarget!==5)throw Error('weekly_qualified_stage_package_changed');
 const tasks=await all(store,'social_weekly_execution_tasks',{tenant_id:job.tenantId,program_id:job.programId,task_id:job.consumerTaskId});
 const task=tasks[0]?.payload as {packageId?:string;packageVersion?:number;schedule?:{stepKind?:string}}|undefined;
 if(tasks.length!==1||task?.packageId!==job.packageId||task.packageVersion!==job.packageVersion||task.schedule?.stepKind!=='benchmark_collection')throw Error('weekly_qualified_stage_task_changed');
 const capacity=await readDailyCollectionCapacity(store,{tenantId:job.tenantId,runId:`weekly-qualified-stage:${job.jobId}`,now});
 if(capacity.remainingCount===0)return {ready:false as const,code:'weekly_qualified_quota_exhausted',plan:null};
 if(runs.length>10||new Set(runs.map(run=>run.runId)).size!==runs.length)throw Error('weekly_qualified_stage_attempt_lineage_invalid');
 const allChildRows=await all(store,'social_weekly_preproduction_retry_attempts',{tenant_id:job.tenantId,program_id:job.programId,package_id:job.packageId,package_version:job.packageVersion,root_job_id:job.jobId});
 const pending=input.pendingAttemptKey?allChildRows.filter(row=>(row.payload as WeeklyPreproductionRetryAttempt).originalRunKey===input.pendingAttemptKey):[];
 if(input.pendingAttemptKey&&(pending.length!==1||pending[0]!.status!=='bound'||(pending[0]!.payload as WeeklyPreproductionRetryAttempt).retry?.kind!=='qualified_continuation'))throw Error('weekly_qualified_stage_pending_attempt_invalid');
 const childRows=allChildRows.filter(row=>!pending.includes(row));
 if(childRows.length!==runs.length-1)throw Error('weekly_qualified_stage_attempt_set_incomplete');
 const reservations=await all(store,DAILY_COLLECTION_RESERVATIONS,{tenant_id:job.tenantId});
 const runHashes:string[]=[],attempts:WeeklyQualifiedAttempt[]=[],candidates:WeeklyQualifiedCandidate[]=[];
 for(let index=0;index<runs.length;index++){
  const run=runs[index]!;
  const saved=await all(store,'social_discovery_runs',{tenant_id:job.tenantId,runId:run.runId});
  if(saved.length!==1||socialRequestHash(saved[0])!==socialRequestHash(run)||run.discoveryScopeId!==job.authority.scopeId||run.discoveryScopeVersion!==job.authority.scopeVersion)throw Error('weekly_qualified_stage_run_changed');
  const marker=(run.scopeSnapshot as any)?.weeklyProducer;
  let admissionJob:WeeklyPreproductionJob|WeeklyPreproductionRetryAttempt=job;
  if(index===0){if(run.runId!==`weekly_discovery_${socialRequestHash({tenantId:job.tenantId,key:job.originalRunKey})}`||marker?.key!==job.originalRunKey)throw Error('weekly_qualified_stage_root_changed');}
  else if(marker?.retry?.parentRunId!==runs[index-1]!.runId||marker?.retry?.parentRunHash!==runHashes[index-1])throw Error('weekly_qualified_stage_attempt_lineage_invalid');
  if(index>0){
   const matching=childRows.filter(row=>(row.payload as WeeklyPreproductionRetryAttempt)?.originalRunKey===marker?.key);
   const child=matching[0]?.payload as WeeklyPreproductionRetryAttempt|undefined;
   if(matching.length!==1||!child||child.recordHash!==socialRequestHash({...child,recordHash:''})||matching[0]!.record_hash!==child.recordHash||child.retry?.parentRunId!==marker.retry.parentRunId||child.retry?.parentRunHash!==marker.retry.parentRunHash||socialRequestHash(child.retry?.sourceSelection)!==socialRequestHash(marker.retry.sourceSelection))throw Error('weekly_qualified_stage_attempt_binding_invalid');
   admissionJob=child;
  }
  runHashes.push(socialRequestHash(run));
  const keys=reservations.filter(row=>row.run_id===run.runId).map(row=>String(row.request_key));
  if(!keys.length&&Object.values(run.modeStats??{}).some(stat=>(stat?.requested??0)>0))throw Error('weekly_qualified_stage_source_ledger_missing');
  attempts.push({runId:run.runId,status:run.status as WeeklyQualifiedAttempt['status'],finishedAt:run.finishedAt??null,sourceKeys:keys});
  if(['failed','partial','stopped','succeeded'].includes(run.status))candidates.push(...await (input.candidateReader??readWeeklyCandidateAdmissionSnapshot)({store,job:admissionJob,run,mediaRoot}));
 }
 const observedIds=new Set(runs.flatMap(run=>Object.values(run.evidenceOutcomes??{}).flatMap(outcome=>[
  ...(outcome?.acceptedCandidateIds??[]),...(outcome?.suggestionCandidateIds??[]),...(outcome?.failedCandidateIds??[]),
 ])));
 if(candidates.some(candidate=>!observedIds.has(candidate.candidateId)))throw Error('weekly_qualified_stage_candidate_lineage_invalid');
 const deduplicated=new Map<string,WeeklyQualifiedCandidate>();
 for(const candidate of candidates){const old=deduplicated.get(candidate.candidateId);if(old&&socialRequestHash(old)!==socialRequestHash(candidate))throw Error('weekly_qualified_stage_candidate_duplicate_changed');deduplicated.set(candidate.candidateId,candidate);}
 const verifiedCandidates=[...deduplicated.values()];
 const sources:WeeklyQualifiedSource[]=[],allowed=new Set<string>();
 const policies=scopePayload.discoveryBrief?.modePolicies??{};
 const accountTarget=scopePayload.discoveryBrief?.weeklyAccountCollectionTarget;
 let repeatableSourceKey:string|undefined;
 if(accountTarget){
  const accountUrl=accountTarget.accountUrl;
  const accountPolicy=policies.account;
  const frozenSnapshot=runs[0]!.scopeSnapshot as {weeklyAccountCollectionTarget?:{accountUrl?:string;targetCount?:number};discoveryBrief?:{weeklyAccountCollectionTarget?:{accountUrl?:string;targetCount?:number}}};
  const frozenTarget=frozenSnapshot.discoveryBrief?.weeklyAccountCollectionTarget??frozenSnapshot.weeklyAccountCollectionTarget;
  if(accountTarget.targetCount!==5||!accountUrl||!/^https:\/\/www\.tiktok\.com\/@[A-Za-z0-9._]{2,24}\/?$/.test(accountUrl)
    ||frozenTarget?.accountUrl!==accountUrl||frozenTarget.targetCount!==5
    ||!job.authority.requestedModes.includes('account')||!accountPolicy?.enabled
    ||!scopePayload.discoveryBrief?.competitorAccounts?.includes(accountUrl)
    ||!accountPolicy.sourceRefs?.includes(accountUrl)||!accountPolicy.platforms?.includes('tiktok')
    ||!(runs[0]!.queryBasis?.account??[]).includes(accountUrl))throw Error('weekly_qualified_stage_account_target_changed');
  const source={mode:'account',platform:'tiktok',queryRef:accountUrl,limit:1};
  sources.push(source);repeatableSourceKey=weeklyQualifiedSourceKey(source);
 }else for(const mode of job.authority.requestedModes){const policy=policies[mode];if(!policy?.enabled)continue;for(const ref of policy.sourceRefs??[])for(const platform of policy.platforms??[]){
  const candidate={mode,platform,queryRef:ref,limit:1},sourceKey=weeklyQualifiedSourceKey(candidate);if(!allowed.has(sourceKey)){sources.push(candidate);allowed.add(sourceKey);}
 }}
 if(!sources.length)throw Error('weekly_qualified_stage_source_unapproved');
 const plan=planWeeklyQualifiedCandidateContinuation({parentRunId:runs[0]!.runId,parentRunHash:runHashes[0]!,attempts,candidates:verifiedCandidates,sources,reservedSourceKeys:reservations.map(row=>String(row.request_key)),remainingAuthorizedCapacity:capacity.remainingCount,now:now.toISOString(),minimumIntervalMs:WEEKLY_QUALIFIED_CONTINUATION_MIN_INTERVAL_MS,...(repeatableSourceKey?{repeatableSourceKey}:{})});
 if(!plan.ready||!plan.source)return {ready:false as const,code:plan.code,plan};
 const body={schema:'weekly-qualified-continuation-stage.v1' as const,tenantId:job.tenantId,programId:job.programId,packageId:job.packageId,packageVersion:job.packageVersion,taskId:job.consumerTaskId,rootJobId:job.jobId,rootJobHash:job.recordHash,parentRunId:runs.at(-1)!.runId,parentRunHash:runHashes.at(-1)!,runIds:runs.map(run=>run.runId),runHashes,source:plan.source,businessDate:capacity.businessDate,minimumIntervalMs:WEEKLY_QUALIFIED_CONTINUATION_MIN_INTERVAL_MS as 300000,candidateSnapshotHash:socialRequestHash(verifiedCandidates),planHash:plan.planHash,scopeId:job.authority.scopeId,scopeVersion:job.authority.scopeVersion,scopeHash:job.authority.scopeHash,authorizesExecution:false as const,grantsAdditionalDailyQuota:false as const};
 const stageId=socialRequestHash(body).slice(0,24),stage:WeeklyQualifiedContinuationStage={...body,stageId,recordHash:socialRequestHash({...body,stageId,recordHash:''})};
 const prior=await store.getById<Record_>(WEEKLY_QUALIFIED_CONTINUATION_STAGES,stageId);
 if(prior){if(prior.record_hash!==stage.recordHash||socialRequestHash(prior.payload)!==socialRequestHash(stage))throw Error('weekly_qualified_stage_changed');return {ready:true as const,code:plan.code,plan,stage};}
 if(input.readOnly)return {ready:true as const,code:plan.code,plan,stage};
 if(!await store.create(WEEKLY_QUALIFIED_CONTINUATION_STAGES,{id:stageId,tenant_id:job.tenantId,program_id:job.programId,package_id:job.packageId,package_version:job.packageVersion,task_id:job.consumerTaskId,record_hash:stage.recordHash,payload:stage}))throw Error('weekly_qualified_stage_write_unknown');
 return {ready:true as const,code:plan.code,plan,stage};
}

/** Fresh, read-only paid-submit guard for a bound child. Existing discovery
 * runs are recovered before this guard, so an uncertain POST is never retried. */
export async function readWeeklyQualifiedContinuationSubmitReadiness(input:{store:DataStore;stage:WeeklyQualifiedContinuationStage;now:Date;mediaRoot:string;pendingAttemptKey:string;candidateReader?:typeof readWeeklyCandidateAdmissionSnapshot}){
 const {store,stage,now}=input;
 const rows=await all(store,'social_weekly_preproduction_jobs',{tenant_id:stage.tenantId,program_id:stage.programId,package_id:stage.packageId,package_version:stage.packageVersion,task_id:stage.taskId});
 const job=rows.find(row=>row.id===stage.rootJobId)?.payload as WeeklyPreproductionJob|undefined;
 if(!job||rows.filter(row=>row.id===stage.rootJobId).length!==1||job.recordHash!==stage.rootJobHash)throw Error('weekly_qualified_submit_root_changed');
 const runs:SocialInspirationCollectionRun[]=[];
 for(const id of stage.runIds){const saved=await all(store,'social_discovery_runs',{tenant_id:stage.tenantId,runId:id});if(saved.length!==1)throw Error('weekly_qualified_submit_run_changed');runs.push(saved[0] as unknown as SocialInspirationCollectionRun);}
 const current=await ensureWeeklyQualifiedContinuationStage({store,job,runs,mediaRoot:input.mediaRoot,now,readOnly:true,pendingAttemptKey:input.pendingAttemptKey,...(input.candidateReader?{candidateReader:input.candidateReader}:{})});
 if(!current.ready||current.stage.stageId!==stage.stageId||current.stage.recordHash!==stage.recordHash||current.stage.planHash!==stage.planHash||current.stage.candidateSnapshotHash!==stage.candidateSnapshotHash)
  throw Error(`weekly_qualified_submit_${current.code}`);
 const taskRows=await all(store,'social_weekly_execution_tasks',{tenant_id:stage.tenantId,program_id:stage.programId,task_id:stage.taskId});
 const task=taskRows[0]?.payload as WeeklyExecutionTask|undefined;
 if(taskRows.length!==1||!task)throw Error('weekly_qualified_submit_template_authority_unavailable');
 const independent=await readIndependentAdmission(store,{tenantId:stage.tenantId,programId:stage.programId,packageId:stage.packageId,packageVersion:stage.packageVersion});
 const automatic=independent?await readWeeklyAutomaticPreproductionAdmission(store,task,now.toISOString()):null;
 if(!independent||!automatic?.eligible)throw Error('weekly_qualified_submit_template_authority_unavailable');
 return current;
}

/** Commits one same-day attempt identity after independently rechecking the
 * accepted-template execution window. The caller must hold the package gate.
 * The child is still only bound here; provider submission remains in the
 * existing discovery service and must revalidate this stage before reserve. */
export async function ensureWeeklyQualifiedContinuationAttempt(input:{store:DataStore;job:WeeklyPreproductionJob;runs:SocialInspirationCollectionRun[];mediaRoot:string;now:Date;candidateReader?:typeof readWeeklyCandidateAdmissionSnapshot}){
 if(!await assertExecutionPackageGate(input.store,{tenantId:input.job.tenantId,programId:input.job.programId,packageId:input.job.packageId,packageVersion:input.job.packageVersion}))throw Error('weekly_qualified_attempt_package_gate_required');
 const previous=await readWeeklyPreproductionRetryAttempt(input.store,input.job);
 if(previous?.retry.kind==='qualified_continuation'&&['bound','running','unknown'].includes(previous.status)){
  if(previous.retry.authorization?.kind!=='normal_daily_window'||previous.retry.authorization.businessDate!==collectionBusinessDate(input.now))return {ready:false as const,code:'weekly_qualified_cross_day_authorization_required',plan:null,attempt:null};
  return {ready:true as const,code:'weekly_qualified_existing_attempt',plan:null,attempt:previous};
 }
 const staged=await ensureWeeklyQualifiedContinuationStage(input);
 if(!staged.ready)return {...staged,attempt:null};
 const {store,job,now}=input,taskRows=await all(store,'social_weekly_execution_tasks',{tenant_id:job.tenantId,program_id:job.programId,task_id:job.consumerTaskId});
 const task=taskRows[0]?.payload as WeeklyExecutionTask|undefined;
 if(taskRows.length!==1||!task)return {ready:false as const,code:'weekly_qualified_template_authority_unavailable',plan:staged.plan,attempt:null};
 const independent=await readIndependentAdmission(store,{tenantId:job.tenantId,programId:job.programId,packageId:job.packageId,packageVersion:job.packageVersion});
 const automatic=independent?await readWeeklyAutomaticPreproductionAdmission(store,task,now.toISOString()):null;
 if(!independent||!automatic?.eligible)return {ready:false as const,code:'weekly_qualified_template_authority_unavailable',plan:staged.plan,attempt:null};
 const source=staged.stage.source;
 const id=socialRequestHash({rootJobId:job.jobId,rootJobHash:job.recordHash,stageId:staged.stage.stageId,parentRunHash:staged.stage.parentRunHash}).slice(0,15);
 const existing=await store.getById<Record_>(PREPRODUCTION_RETRY_ATTEMPTS,id);
 if(existing){const prior=existing.payload as WeeklyPreproductionRetryAttempt;if(existing.record_hash!==prior.recordHash||prior.recordHash!==socialRequestHash({...prior,recordHash:''})||prior.jobId!==id||prior.retry?.kind!=='qualified_continuation'||prior.retry.continuationStageId!==staged.stage.stageId||prior.retry.rootJobHash!==job.recordHash||prior.retry.parentRunHash!==staged.stage.parentRunHash)throw Error('weekly_qualified_attempt_changed');return {...staged,attempt:prior};}
 const base={...job,jobId:id,originalRunKey:`${job.originalRunKey}:qualified:${id}`,status:'bound' as const,code:null,resultRefs:[],boundAt:now.toISOString(),updatedAt:now.toISOString(),recordHash:'',retry:{kind:'qualified_continuation' as const,continuationStageId:staged.stage.stageId,rootJobId:job.jobId,rootJobHash:job.recordHash,parentRunId:staged.stage.parentRunId,parentRunHash:staged.stage.parentRunHash,sourceSelection:[{mode:source.mode as WeeklyPreproductionRetryAttempt['retry']['sourceSelection'][number]['mode'],platform:source.platform,queryRef:source.queryRef}],authorization:{kind:'normal_daily_window' as const,businessDate:staged.stage.businessDate}}};
 const attempt:WeeklyPreproductionRetryAttempt={...base,recordHash:socialRequestHash(base)};
 if(!await store.create(PREPRODUCTION_RETRY_ATTEMPTS,{id,tenant_id:job.tenantId,program_id:job.programId,package_id:job.packageId,package_version:job.packageVersion,task_id:job.consumerTaskId,input_hash:job.consumerInputHash,kind:'discovery',status:'bound',original_run_key:attempt.originalRunKey,root_job_id:job.jobId,record_hash:attempt.recordHash,payload:attempt}))throw Error('weekly_qualified_attempt_write_unknown');
 return {...staged,attempt};
}
