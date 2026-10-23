import {createHash} from 'node:crypto';
import type {DataStore,Record_} from '../storage/datastore.js';
import type {WeeklyExecutionTask,WeeklyOperatingPackage} from '../../shared/contracts/socialProgram.js';
import type {WeeklyScheduleCapacityInput} from '../../shared/contracts/socialWeeklyScheduleRevision.js';
import {WEEKLY_AUTOMATION_TEMPLATE as template} from '../../shared/weeklyAutomationTemplate.js';
import {adoptWeeklyAutomationTemplate} from './weeklyAutomationTemplate.js';
import {assertWeeklyScheduleActor} from './weeklyScheduleActor.js';
import {withExecutionPackageGate} from './weeklyExecutionGate.js';
import {latestPackageRow} from './weeklyOperatingPackageSupport.js';
import {listWeeklyExecutionTasks} from './executionTasks.js';
import {hasWeeklyInitialExecution} from './weeklyInitialExecution.js';
import {createWeeklyScheduleRevisionService} from './socialWeeklyScheduleRevisions.js';
import {listContentExecutionLimits,setContentExecutionLimit} from '../contentExecution/durableQueue.js';
import {socialRequestHash} from '../starter198/socialContentValidation.js';
import {SocialProgramError} from './service.js';
import {SCHEDULE_PROPOSALS,scheduleHash} from './weeklyScheduleSnapshots.js';
import {weeklyContinuationInputHash,createWeeklyExecutionContinuationService} from './weeklyExecutionContinuations.js';
import type {WeeklyScheduleProposal} from '../../shared/contracts/socialWeeklyScheduleRevision.js';

type Scope={tenantId:string;programId:string;packageId:string;packageVersion:number;actorUserId:string};
export const AUTOMATIC_WEEKLY_SCHEDULES='social_weekly_automatic_schedules';
const fail=(code:string):never=>{throw new SocialProgramError(code,409,code);};
const plusDay=(date:string,days:number)=>new Date(Date.parse(`${date}T00:00:00Z`)+days*86400000).toISOString().slice(0,10);

/** Independent preproduction consumes the adopted task window even when an
 * unrelated publication deadline makes the complete package infeasible. This
 * is scheduling eligibility only; factual inputs, source rights, dependencies,
 * provider readiness and collection quantity limits remain executor gates. */
export async function readWeeklyAutomaticPreproductionAdmission(store:DataStore,task:WeeklyExecutionTask,now:string){
 if(!['business_outline','benchmark_collection'].includes(task.schedule.stepKind))return null;
 if(!Number.isFinite(Date.parse(now)))return null;
 const scopes={tenant_id:task.tenantId,program_id:task.programId,package_id:task.packageId,package_version:task.packageVersion};
 const records:Record_[]=[];
 for(let page=1;;page++){
  const rows=await store.list<Record_>(AUTOMATIC_WEEKLY_SCHEDULES,{where:scopes,page,perPage:250,sort:'id'});
  if(!Number.isSafeInteger(rows.totalPages)||!Number.isSafeInteger(rows.totalItems)||rows.totalPages<1)fail('weekly_template_schedule_pagination_invalid');
  records.push(...rows.items);if(page>=rows.totalPages){if(records.length!==rows.totalItems)fail('weekly_template_schedule_pagination_invalid');break;}
  if(!rows.items.length)fail('weekly_template_schedule_pagination_invalid');
 }
 for(const row of records.reverse()){
  const receipt=row.payload as {proposalId:string;source:string;userApproval:null;templateVersion:string};
  if(row.content_hash!==socialRequestHash(receipt)||receipt.source!=='automatic_template'||receipt.userApproval!==null||receipt.templateVersion!==template.version)fail('weekly_template_schedule_receipt_invalid');
  const proposals=await store.list<Record_>(SCHEDULE_PROPOSALS,{where:{...scopes,proposal_id:receipt.proposalId},perPage:2});
  if(proposals.totalItems!==1||proposals.items.length!==1)fail('weekly_template_schedule_proposal_missing');
  const stored=proposals.items[0],proposal=stored.payload as WeeklyScheduleProposal;
  if(stored.content_hash!==scheduleHash(proposal)||proposal.tenantId!==task.tenantId||proposal.programId!==task.programId||proposal.packageId!==task.packageId||proposal.packageVersion!==task.packageVersion||proposal.inputAuthority!=='target_graph_with_automatic_template_capacity'||proposal.automaticAdoption?.userApproval!==null||proposal.automaticAdoption.source!=='automatic_template'||proposal.automaticAdoption.templateVersion!==template.version)fail('weekly_template_schedule_proposal_invalid');
  const projected=proposal.targetGraph?.tasks.find(t=>t.taskId===task.taskId),constraint=proposal.capacity.constraints[task.taskId];
  if(!projected||!constraint||weeklyContinuationInputHash(projected)!==weeklyContinuationInputHash(task))continue;
  const limits=await listContentExecutionLimits(store,task.tenantId);
  if(!limits.some(l=>l.scope==='tenant'&&l.scopeKey==='*'&&l.maxRunning<=template.productionConcurrency)||!limits.some(l=>l.scope==='task_type'&&l.scopeKey==='social_content_weekly'&&l.maxRunning<=template.productionConcurrency))return null;
  // Proposals created before the per-task prelaunch fix already contain the
  // signed prelaunch resource window, but their benchmark constraints still
  // point at the following week's calendar slot.  Interpret that existing
  // authority consistently instead of rewriting the immutable proposal or
  // requiring the user to accept the same template again.
  const resource=proposal.capacity.resources?.[constraint.resourceKey];
  const activePrelaunch=resource?.workingWindows.find(window=>Date.parse(window.startAt)<=Date.parse(now)&&Date.parse(now)<Date.parse(window.finishAt));
  const availableAt=Date.parse(constraint.availableAt)>Date.parse(now)&&activePrelaunch
   ?activePrelaunch.startAt
   :constraint.availableAt;
  return {source:'automatic_template' as const,templateVersion:template.version,proposalId:proposal.proposalId,availableAt,eligible:Date.parse(now)>=Date.parse(availableAt),authority:'independent_preproduction_window_only' as const,userApproval:null,outboundAuthorization:false as const};
 }
 return null;
}

/** Conservative planning assumptions, not measured throughput, provider quotes,
 * delivery, approval, or outbound authorization. Existing execution is never
 * assigned zero remaining work/cost: it must use verified continuation evidence. */
export function automaticWeeklyCapacity(pkg:WeeklyOperatingPackage,tasks:WeeklyExecutionTask[],now:string,verifiedCompletedPreproductionIds:ReadonlySet<string>=new Set()):WeeklyScheduleCapacityInput {
 if(!Number.isFinite(Date.parse(now)))fail('weekly_template_clock_invalid');
 if(pkg.socialContentPackage.productionIdentityVersion!=='shared-original.v1')fail('weekly_template_shared_production_identity_required');
 const blockedPreproductionForecast=(task:WeeklyExecutionTask)=>task.schedule.stepKind==='benchmark_collection'&&task.status==='blocked'&&task.attempt===0&&!task.lease&&!task.resultRefs.length&&!task.schedule.actualFinishedAt&&!task.productionProgress&&task.lastError?.code==='business_dispatch_required'&&task.ownBlockingReasons.length===1&&task.ownBlockingReasons[0]==='business_dispatch_required';
 // A dispatch preflight timestamp is retained as history, not reinterpreted as
 // zero work. The conservative planner still reports started_work_requires_
 // verified_continuation; this merely permits forecasting the other branches.
 if(tasks.some(task=>hasWeeklyInitialExecution(task)&&!blockedPreproductionForecast(task)&&!(['business_outline','benchmark_collection'].includes(task.schedule.stepKind)&&task.status==='succeeded'&&task.budget.category!=='production'&&verifiedCompletedPreproductionIds.has(task.taskId))))fail('weekly_template_existing_work_requires_reconciliation');
 const windows:Array<{startAt:string;finishAt:string}>=[],resident:Array<{startAt:string;finishAt:string}>=[];
 const weekStartsAt=Date.parse(`${pkg.weekStart}T00:00:00+08:00`);
 // A next-week package is intentionally prepared as soon as its recommended
 // template is accepted. This window authorizes draft production only; it does
 // not move publication times or grant any outbound permission.
 if(Date.parse(now)<weekStartsAt)windows.push({startAt:now,finishAt:new Date(weekStartsAt).toISOString()});
 for(let date=pkg.weekStart;date<=pkg.weekEnd;date=plusDay(date,1)){
  const finishAt=`${plusDay(date,1)}T00:00:00+08:00`;
  if(Date.parse(finishAt)<=Date.parse(now))continue;
  windows.push({startAt:new Date(Math.max(Date.parse(now),Date.parse(`${date}T06:00:00+08:00`))).toISOString(),finishAt});
  resident.push({startAt:new Date(Math.max(Date.parse(now),Date.parse(`${date}T00:00:00+08:00`))).toISOString(),finishAt});
 }
 if(!windows.length)fail('weekly_template_week_expired_requires_explicit_carryover');
 const resources:WeeklyScheduleCapacityInput['resources']={};
 const constraints:WeeklyScheduleCapacityInput['constraints']={},operationalDeadlines:Record<string,string>={};
 const productionRoots=new Set<string>();
 const rootDays=new Map<string,string>();
 for(const publication of pkg.socialContentPackage.publicationTasks){
  const root=publication.motherContentId,date=publication.publishWindow?.slice(0,10);
  if(root&&date&&/^\d{4}-\d{2}-\d{2}$/.test(date)&&(!rootDays.has(root)||date<rootDays.get(root)!))rootDays.set(root,date);
 }
 for(const task of tasks){
  const actor=task.schedule.responsibleActor,key=`template:${actor}`;
  resources[key]??={concurrency:actor==='customer_agent'?1:template.productionConcurrency,workingWindows:actor==='customer_agent'?resident:windows};
  // Reserve the whole film ceiling only once for each shared production root.
  // This is not an assertion that unpaid stages incur no cost: all stages and
  // revisions consume that same film budget in the existing production ledger.
  let reserve=0;
  if(task.schedule.stepKind==='video_generation'){
   const pub=pkg.socialContentPackage.publicationTasks.find(p=>p.publicationTaskId===task.publicationTaskId);
   const root=pub?.motherContentId;
   if(!root)fail('weekly_template_production_root_missing');
   if(!productionRoots.has(root!)){reserve=template.perFinishedVideoMaxCny;productionRoots.add(root!);}
  }
  const publication=pkg.socialContentPackage.publicationTasks.find(p=>p.publicationTaskId===task.publicationTaskId);
  const rollingDay=typeof task.inputSnapshot.rollingDate==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(task.inputSnapshot.rollingDate)
   ?task.inputSnapshot.rollingDate
   :null;
  const localDay=rollingDay??(publication?.motherContentId?rootDays.get(publication.motherContentId):null)??pkg.weekStart;
  const normalEligible=Date.parse(`${localDay??pkg.weekStart}T${actor==='customer_agent'?'00':'06'}:00:00+08:00`);
  // Accepting the recommended template opens only the two independent
  // preproduction stages immediately.  Keeping their per-day calendar date
  // here made the prelaunch window above unreachable for benchmark tasks, so
  // the product appeared to accept the template and then silently waited for
  // the following week.  Production, review and every outbound stage retain
  // their normal calendar eligibility.
  const eligible=Date.parse(now)<weekStartsAt&&['business_outline','benchmark_collection'].includes(task.schedule.stepKind)
   ?Date.parse(now)
   :normalEligible;
  constraints[task.taskId]={resourceKey:key,remainingMinutes:task.schedule.estimatedDurationMinutes,remainingCostCny:reserve,bufferMinutes:0,availableAt:new Date(Math.max(Date.parse(now),eligible)).toISOString()};
  if(['business_schedule','performance_monitoring','weekly_review','template_extraction','template_performance_validation'].includes(task.schedule.stepKind)){
   const today=new Date(Date.parse(now)+8*3600000).toISOString().slice(0,10);
   const day=['business_schedule','performance_monitoring'].includes(task.schedule.stepKind)?(localDay<today?today:localDay):pkg.weekEnd;
   operationalDeadlines[task.taskId]=`${day}T23:59:59+08:00`;
  }
 }
 return {constraints,resources,operationalDeadlines,remainingBudgetCny:Math.min(pkg.socialContentPackage.weeklyBudgetCny??template.originalVideosPerWeek*template.perFinishedVideoMaxCny,template.originalVideosPerWeek*template.perFinishedVideoMaxCny)};
}

/** Server-owned adoption and real durable queue limit configuration. The normal
 * revision service still verifies leases, unknown receipts, queue identity and
 * complete feasibility before freezing anything. A blocked proposal is retained
 * with its actual reasons; never rewrite a historical deadline to claim success. */
export function createWeeklyAutomaticScheduleService(store:DataStore,ports:{now?:()=>string}={}){
 return {async apply(a:Scope){
  await assertWeeklyScheduleActor(store,a);
  const recovered=await recoverCommittedAutomaticWeeklySchedule(store,a);
  if(recovered)return recovered;
  const now=ports.now?.()??new Date().toISOString();
  let id='';
  const prepared=await withExecutionPackageGate(store,a,async()=>{
   const row=await latestPackageRow(store,a.tenantId,a.programId,a.packageId);
   if(row?.payload.version!==a.packageVersion)fail('weekly_template_schedule_version_conflict');
   const pkg=row!.payload,tasks=await listWeeklyExecutionTasks(store,a.tenantId,a.programId,a.packageId,a.packageVersion);
   if(pkg.status!=='draft'||pkg.socialContentPackage.authorization.allowRealPublishing)fail('weekly_template_schedule_requires_unapproved_draft');
   const evidence=await createWeeklyExecutionContinuationService(store).derivePlannerEvidence(a,now);
   const verifiedCompletedPreproductionIds=new Set(tasks.filter(task=>['business_outline','benchmark_collection'].includes(task.schedule.stepKind)&&evidence.completedEvidence[task.taskId]).map(task=>task.taskId));
   const capacity=automaticWeeklyCapacity(pkg,tasks,now,verifiedCompletedPreproductionIds);
   const adoption=await adoptWeeklyAutomationTemplate(store,a,a.actorUserId);
   const limits=await listContentExecutionLimits(store,a.tenantId);
   // Keep every stricter existing limit; do not raise account/platform limits.
   for(const [scope,scopeKey] of [['tenant','*'],['task_type','social_content_weekly']] as const){
    const old=limits.find(l=>l.scope===scope&&l.scopeKey===scopeKey);
    if(!old||old.maxRunning>template.productionConcurrency)await setContentExecutionLimit({dataStore:store,tenantId:a.tenantId,scope,scopeKey,maxRunning:template.productionConcurrency,updatedBy:`automatic_template:${template.version}:${a.actorUserId}`,now:new Date(now)});
   }
   // Account production concurrency is conservatively one unless an existing
   // stricter/equivalent configuration exists. This does not alter publish API
   // throttles or grant connection permissions.
   for(const accountId of new Set(pkg.socialContentPackage.publicationTasks.map(p=>p.accountId))){
    if(!limits.some(l=>l.scope==='account'&&(l.scopeKey===accountId||l.scopeKey==='*')))await setContentExecutionLimit({dataStore:store,tenantId:a.tenantId,scope:'account',scopeKey:accountId,maxRunning:1,updatedBy:`automatic_template:${template.version}:${a.actorUserId}`,now:new Date(now)});
   }
   id=createHash('sha256').update(socialRequestHash([a.tenantId,a.programId,a.packageId,a.packageVersion,template.version,tasks,await listContentExecutionLimits(store,a.tenantId)])).digest('hex');
   const existing=await store.getById<Record_>(AUTOMATIC_WEEKLY_SCHEDULES,id);
   if(existing){if(existing.content_hash!==socialRequestHash(existing.payload))fail('weekly_template_schedule_receipt_invalid');return {receipt:existing.payload as Record<string,unknown>};}
   return {capacity,adoption,verifiedCompletedPreproductionIds};
  });
  if('receipt' in prepared)return prepared.receipt;
  const automaticAdoption={source:'automatic_template' as const,templateVersion:template.version,adoptedAt:prepared.adoption.adoptedAt,userApproval:null};
  const scheduling=createWeeklyScheduleRevisionService(store,{now:()=>now,automaticAdoption});
  const graph=await scheduling.preview(a);
  // Build against the complete projected graph so new material/quality nodes
  // are not silently omitted from the adopted capacity constraints.
  const pkg=(await latestPackageRow(store,a.tenantId,a.programId,a.packageId))!.payload;
  const capacity=automaticWeeklyCapacity(pkg,graph.tasks,now,prepared.verifiedCompletedPreproductionIds);
  const proposal=await scheduling.propose(a,capacity);
  const blockers=proposal.plan.assignments.filter(r=>!r.startAt||r.reasons.some(reason=>reason!=='human_completion_not_verified')).map(r=>({taskId:r.taskId,reasons:r.reasons}));
  const feasible=proposal.plan.publicationGap===0&&blockers.length===0;
  const confirmation=feasible?await scheduling.confirm(a,{proposalId:proposal.proposalId,expectedVersion:a.packageVersion,inputEvidenceHash:proposal.inputEvidenceHash,confirmedTemplateCarryoverPlanHashes:(proposal.templateCarryovers??[]).map(p=>p.planHash)}):null;
  const payload={scope:{tenantId:a.tenantId,programId:a.programId,packageId:a.packageId,packageVersion:a.packageVersion},...automaticAdoption,proposalId:proposal.proposalId,status:confirmation?'scheduled':'blocked',targetVersion:confirmation?.item.version??null,blockers,acceptance:{originalVideos:5,platforms:template.sharedPublicationPlatforms,perFilmIncludingRevisionsMaxCny:10,requiresRealArtifact:true,requiresProductionPageAcceptance:true},activated:false,outboundAuthorization:false};
  const saved=await store.create(AUTOMATIC_WEEKLY_SCHEDULES,{id,tenant_id:a.tenantId,program_id:a.programId,package_id:a.packageId,package_version:a.packageVersion,payload,content_hash:socialRequestHash(payload)});
  if(!saved)fail('weekly_template_schedule_receipt_write_failed');
  return payload;
 }};
}

/** Repair only the crash window after an immutable automatic schedule
 * confirmation created its target version but before apply wrote its receipt.
 * The proposal and the confirmed snapshot are re-read; no new approval or
 * schedule confirmation is inferred from the target version alone. */
export async function recoverCommittedAutomaticWeeklySchedule(store:DataStore,a:Scope,ports:{readConfirmation?:(scope:Scope,proposalId:string)=>ReturnType<ReturnType<typeof createWeeklyScheduleRevisionService>['readConfirmation']>}={}){
 const latest=await latestPackageRow(store,a.tenantId,a.programId,a.packageId);
 if(!latest||latest.payload.version===a.packageVersion)return null;
 if(latest.payload.version!==a.packageVersion+1||latest.payload.status!=='draft')fail('weekly_template_schedule_version_conflict');
 const proposals=await store.list<Record_>(SCHEDULE_PROPOSALS,{where:{tenant_id:a.tenantId,program_id:a.programId,package_id:a.packageId,package_version:a.packageVersion},page:1,perPage:500});
 if(proposals.totalItems!==proposals.items.length)fail('weekly_template_schedule_recovery_scan_incomplete');
 const scheduling=createWeeklyScheduleRevisionService(store);
 const committed:Array<{proposal:WeeklyScheduleProposal;targetVersion:number}>=[];
 for(const row of proposals.items){
  const proposal=row.payload as WeeklyScheduleProposal;
  if(row.content_hash!==scheduleHash(proposal))fail('weekly_template_schedule_proposal_invalid');
  if(proposal.inputAuthority!=='target_graph_with_automatic_template_capacity'||proposal.automaticAdoption?.source!=='automatic_template'||proposal.automaticAdoption.templateVersion!==template.version||proposal.automaticAdoption.userApproval!==null)continue;
  if(proposal.tenantId!==a.tenantId||proposal.programId!==a.programId||proposal.packageId!==a.packageId||proposal.packageVersion!==a.packageVersion||proposal.createdBy!==a.actorUserId||row.proposal_id!==proposal.proposalId)fail('weekly_template_schedule_proposal_invalid');
  const receipt=await (ports.readConfirmation??scheduling.readConfirmation)(a,proposal.proposalId);
  if(receipt.status==='committed'){
   if(receipt.targetVersion!==latest.payload.version||receipt.item.scheduleRevisionRef?.id!==receipt.snapshot.snapshotId||receipt.item.packageId!==a.packageId||receipt.item.previousVersion!==a.packageVersion||receipt.snapshot.confirmedBy!==a.actorUserId||receipt.snapshot.automaticAdoption?.source!=='automatic_template'||receipt.snapshot.automaticAdoption.templateVersion!==template.version||receipt.snapshot.automaticAdoption.userApproval!==null)fail('weekly_template_schedule_recovery_target_invalid');
   committed.push({proposal,targetVersion:receipt.targetVersion});
  }
 }
 if(committed.length!==1)fail('weekly_template_schedule_recovery_ambiguous');
 const {proposal,targetVersion}=committed[0]!;
 const old=await store.list<Record_>(AUTOMATIC_WEEKLY_SCHEDULES,{where:{tenant_id:a.tenantId,program_id:a.programId,package_id:a.packageId,package_version:a.packageVersion},page:1,perPage:500});
 if(old.totalItems!==old.items.length)fail('weekly_template_schedule_recovery_scan_incomplete');
 const matching=old.items.filter(row=>(row.payload as {proposalId?:string}).proposalId===proposal.proposalId);
 if(matching.length>1)fail('weekly_template_schedule_recovery_ambiguous');
 if(old.items.length!==matching.length)fail('weekly_template_schedule_recovery_ambiguous');
 if(matching.length){const row=matching[0]!,payload=row.payload as Record<string,unknown>;if(row.content_hash!==socialRequestHash(payload)||payload.status!=='scheduled'||payload.targetVersion!==targetVersion||payload.userApproval!==null||payload.source!=='automatic_template'||payload.templateVersion!==template.version)fail('weekly_template_schedule_receipt_invalid');return payload;}
 const blockers=proposal.plan.assignments.filter(r=>!r.startAt||r.reasons.some(reason=>reason!=='human_completion_not_verified')).map(r=>({taskId:r.taskId,reasons:r.reasons}));
 if(proposal.plan.publicationGap!==0||blockers.length)fail('weekly_template_schedule_recovery_proposal_not_feasible');
 const payload={scope:{tenantId:a.tenantId,programId:a.programId,packageId:a.packageId,packageVersion:a.packageVersion},source:'automatic_template' as const,templateVersion:template.version,adoptedAt:proposal.automaticAdoption!.adoptedAt,userApproval:null,proposalId:proposal.proposalId,status:'scheduled' as const,targetVersion,blockers,acceptance:{originalVideos:5,platforms:template.sharedPublicationPlatforms,perFilmIncludingRevisionsMaxCny:10,requiresRealArtifact:true,requiresProductionPageAcceptance:true},activated:false,outboundAuthorization:false};
 const stillLatest=await latestPackageRow(store,a.tenantId,a.programId,a.packageId);
 if(stillLatest?.payload.version!==targetVersion||(stillLatest.payload as WeeklyOperatingPackage&{scheduleRevisionRef?:{id:string}}).scheduleRevisionRef?.id!==(latest.payload as WeeklyOperatingPackage&{scheduleRevisionRef?:{id:string}}).scheduleRevisionRef?.id)fail('weekly_template_schedule_recovery_target_changed');
 const id=createHash('sha256').update(socialRequestHash([a.tenantId,a.programId,a.packageId,a.packageVersion,template.version,proposal.proposalId,'committed-recovery'])).digest('hex');
 const created=await store.create(AUTOMATIC_WEEKLY_SCHEDULES,{id,tenant_id:a.tenantId,program_id:a.programId,package_id:a.packageId,package_version:a.packageVersion,payload,content_hash:socialRequestHash(payload)});
 if(!created){const raced=await store.getById<Record_>(AUTOMATIC_WEEKLY_SCHEDULES,id);if(!raced||raced.content_hash!==socialRequestHash(payload))fail('weekly_template_schedule_receipt_write_failed');}
 return payload;
}
