import type {DataStore,Record_,Where} from '../storage/datastore.js';
import type {WeeklyExecutionTask,WeeklyOperatingPackage,VersionedSocialRef} from '../../shared/contracts/socialProgram.js';
import {SocialProgramError} from '../socialPrograms/service.js';
import {createWeeklyInventoryReuseService} from '../socialPrograms/weeklyInventoryReuse.js';
import {socialRequestHash} from '../starter198/socialContentValidation.js';
import {verifyEnterpriseFactContent,type EnterpriseProfile} from '../routes/enterprise.js';
import {publicationInstant} from '../socialPrograms/publicationDeadlines.js';

const obj=(v:unknown):any=>{try{const x=typeof v==='string'?JSON.parse(v):v;if(x&&typeof x==='object'&&!Array.isArray(x))return x;}catch{}throw new SocialProgramError('inventory_outline_payload_invalid',409,'库存经营证据损坏。');};
function need(ok:unknown,code:string):asserts ok{if(!ok)throw new SocialProgramError(code,409,code);}
async function unique(s:DataStore,c:string,w:Where){const r=await s.list<Record_>(c,{where:w,page:1,perPage:2});need(r.totalItems===1&&r.items.length===1,'inventory_outline_authority_missing');return r.items[0]!;}
const same=(a:unknown,b:unknown)=>socialRequestHash(a)===socialRequestHash(b);

/** Full inventory business conditions, independently of a new-production director dispatch. */
export async function readWeeklyInventoryOutlineEvidence(store:DataStore,task:WeeklyExecutionTask){
 need(task.workflowKind==='readiness'&&task.schedule.stepKind==='business_outline'&&task.schedule.responsibleActor==='business_agent'&&!task.publicationTaskId,'inventory_outline_step_invalid');
 const stored=obj((await unique(store,'social_weekly_execution_tasks',{tenant_id:task.tenantId,program_id:task.programId,package_id:task.packageId,package_version:task.packageVersion,task_id:task.taskId})).payload);need(stored.taskId===task.taskId&&stored.tenantId===task.tenantId&&stored.programId===task.programId&&stored.packageId===task.packageId&&stored.packageVersion===task.packageVersion&&stored.workflowKind===task.workflowKind&&stored.schedule?.stepKind===task.schedule.stepKind&&stored.schedule.responsibleActor===task.schedule.responsibleActor&&same(stored.dependsOnTaskIds,task.dependsOnTaskIds)&&same(stored.inputSnapshot,task.inputSnapshot)&&same(stored.upstreamVersionRefs,task.upstreamVersionRefs),'inventory_outline_task_changed');
 const row=await unique(store,'social_weekly_operating_packages',{tenant_id:task.tenantId,program_id:task.programId,package_id:task.packageId,version:task.packageVersion}),pkg=obj(row.payload) as WeeklyOperatingPackage;
 need(pkg.programId===task.programId&&pkg.packageId===task.packageId&&pkg.version===task.packageVersion&&['draft','active'].includes(pkg.status),'inventory_outline_scope_invalid');
 const pubs=pkg.socialContentPackage.publicationTasks;
 need(pubs.length>0&&pubs.every(p=>p.inventoryReuseRef?.type==='weekly_inventory_binding'&&p.inventoryReuseRef.version===1),'inventory_outline_full_inventory_required');
 need(pkg.referenceSourcePolicy?.profile==='b2b_established','inventory_outline_established_profile_required');
 if('referenceSourcePolicy' in task.inputSnapshot)need(same(task.inputSnapshot.referenceSourcePolicy,pkg.referenceSourcePolicy),'inventory_outline_policy_changed');
 const goalRef=pkg.businessContentGoalRef,snapshotRef=pkg.operatingDecisionSnapshotRef;
 need(goalRef?.type==='business_content_goal'&&snapshotRef?.type==='operating_authority_snapshot','inventory_outline_goal_snapshot_required');
 const goal=obj((await unique(store,'social_business_content_goals',{tenant_id:task.tenantId,program_id:task.programId,goal_id:goalRef.id,version:goalRef.version})).payload);
 need(goal.goalId===goalRef.id&&goal.version===goalRef.version&&goal.programId===task.programId&&goal.status==='ready'&&goal.objective?.trim()&&Array.isArray(goal.blockers)&&!goal.blockers.length,'inventory_outline_goal_unverified');
 const decision=obj((await unique(store,'social_operating_decisions',{tenant_id:task.tenantId,program_id:task.programId,decision_id:goal.decisionRecordRef?.id})).payload);
 need(decision.outcome==='accepted'&&decision.decisionType==='business_content_goal'&&same(decision.output,goalRef)&&decision.inputFingerprint===goal.inputFingerprint,'inventory_outline_goal_decision_changed');
 const snapshot=obj((await unique(store,'social_operating_authority_snapshots',{tenant_id:task.tenantId,program_id:task.programId,snapshot_id:snapshotRef.id,version:snapshotRef.version})).payload);
 need(snapshot.snapshotId===snapshotRef.id&&snapshot.version===snapshotRef.version&&snapshot.programId===task.programId&&snapshot.status==='ready'&&same(snapshot.businessContentGoalRef,goalRef),'inventory_outline_snapshot_changed');
 const profile=obj((await unique(store,'tenant_profiles',{tenant_id:task.tenantId})).profile) as EnterpriseProfile;
 need(profile.factVersion?.confirmedBy&&publicationInstant(profile.factVersion.confirmedAt)!==null&&Date.parse(profile.factVersion.confirmedAt)<=Date.now()&&verifyEnterpriseFactContent(profile).verified,'inventory_outline_enterprise_facts_unconfirmed');
 const statements=[profile.company?.description,profile.brand?.usp,profile.products?.highlights,profile.products?.certifications,...(profile.products?.items??[]).flatMap(p=>[p.name,p.highlights,p.certifications])].filter(v=>typeof v==='string'&&v.trim()).map(v=>v!.trim());
 const facts=snapshot.enterprise?.publicFacts;
 need(Array.isArray(facts)&&facts.length>0&&facts.every((f:any)=>f.ref?.type==='enterprise_fact'&&f.ref.version===snapshot.enterprise.ref?.version&&typeof f.statement==='string'&&statements.includes(f.statement.trim())),'inventory_outline_enterprise_facts_changed');
 need(goal.publicFactRefs?.length&&goal.publicFactRefs.every((ref:VersionedSocialRef)=>facts.some((f:any)=>same(f.ref,ref))),'inventory_outline_goal_facts_changed');
 const capacityRef=pkg.capacityPlanRef;
 need(capacityRef?.type==='capacity_plan'&&same(snapshot.capacityPlanRef,capacityRef),'inventory_outline_capacity_required');
 const capacity=obj((await unique(store,'social_operating_decisions',{tenant_id:task.tenantId,program_id:task.programId,decision_id:capacityRef.id})).payload);
 need(capacity.version===capacityRef.version&&capacity.outcome==='accepted'&&capacity.decisionType==='capacity_plan'&&same(capacity.subjectRef,goalRef)&&capacity.output?.status==='ready','inventory_outline_capacity_unverified');
 need(typeof goal.weeklyBudgetCny==='number'&&Number.isFinite(goal.weeklyBudgetCny)&&goal.weeklyBudgetCny>=0&&typeof pkg.socialContentPackage.weeklyBudgetCny==='number'&&pkg.socialContentPackage.weeklyBudgetCny>=0&&pkg.socialContentPackage.weeklyBudgetCny<=goal.weeklyBudgetCny,'inventory_outline_budget_required');
 const policyRef=pkg.automationPolicyRef;need(policyRef?.type==='automation_policy'&&same(snapshot.automationPolicyRef,policyRef),'inventory_outline_automation_policy_required');
 const policy=obj((await unique(store,'social_operating_decisions',{tenant_id:task.tenantId,program_id:task.programId,decision_id:policyRef.id})).payload);need(policy.version===policyRef.version&&policy.outcome==='accepted'&&policy.decisionType==='automation_policy'&&same(policy.subjectRef,goalRef)&&policy.output?.status==='allowed','inventory_outline_automation_policy_unverified');
 const confirmer=await store.getById<Record_>('users',profile.factVersion!.confirmedBy);need(confirmer?.tenantId===task.tenantId&&confirmer.disabled!==true&&confirmer.active!==false&&!['disabled','suspended'].includes(String(confirmer.status)),'inventory_outline_enterprise_confirmer_unavailable');
 const accounts=[],bindings=[];for(const pub of pubs){
  const account=obj((await unique(store,'social_owned_accounts',{tenant_id:task.tenantId,program_id:task.programId,account_id:pub.accountId})).payload);
  need(account.accountId===pub.accountId&&account.programId===task.programId&&account.platform===pub.platform&&account.status==='active'&&Number.isSafeInteger(account.version)&&account.version>0,'inventory_outline_account_unavailable');
  need(pub.businessProposition?.trim()&&pub.cta?.trim()&&pub.factRefs.length&&pub.factRefs.every(ref=>facts.some((f:any)=>same(f.ref,ref)))&&publicationInstant(pub.publishWindow)!==null,'inventory_outline_publication_conditions_missing');
  const accountQuota=capacity.output.accountQuotas?.find((q:any)=>q.accountId===pub.accountId);need(accountQuota&&accountQuota.publicationQuota>=pubs.filter(p=>p.accountId===pub.accountId).length,'inventory_outline_account_capacity_insufficient');
  const verified=await createWeeklyInventoryReuseService(store).readVerifiedBinding({...task,publicationTaskId:pub.publicationTaskId,accountId:pub.accountId,inputSnapshot:{publicationTask:pub}});
  bindings.push({publicationTaskId:pub.publicationTaskId,bindingRef:verified.item.ref,bindingHash:verified.item.recordHash,sourceHash:verified.item.source.sourceHash});accounts.push(account);
 }
 const evidence={tenantId:task.tenantId,programId:task.programId,packageId:task.packageId,packageVersion:task.packageVersion,taskId:task.taskId,taskInputHash:socialRequestHash(task.inputSnapshot),packageHash:socialRequestHash({weekStart:pkg.weekStart,weekEnd:pkg.weekEnd,objective:pkg.objective,successCriteria:pkg.successCriteria,policy:pkg.referenceSourcePolicy,content:pkg.socialContentPackage,goalRef:pkg.businessContentGoalRef,snapshotRef:pkg.operatingDecisionSnapshotRef,capacityRef:pkg.capacityPlanRef}),goalHash:socialRequestHash(goal),snapshotHash:socialRequestHash(snapshot),capacityHash:socialRequestHash(capacity),policyHash:socialRequestHash(policy),enterpriseFactHash:profile.factVersion!.contentHash,accounts,bindings,startsProduction:false,publishesSubmitted:0};
 const evidenceHash=socialRequestHash(evidence);return {evidence,evidenceHash,resultRefs:[{type:'weekly_inventory_outline',id:`${task.taskId}:${evidenceHash}`,version:1}] as VersionedSocialRef[]};
}
export async function validateWeeklyInventoryOutlineRefs(store:DataStore,task:WeeklyExecutionTask,refs:VersionedSocialRef[]){const fresh=await readWeeklyInventoryOutlineEvidence(store,task);need(same(refs,fresh.resultRefs),'inventory_outline_result_changed');return fresh;}

export async function readWeeklyInventoryExecutionGate(store:DataStore,task:WeeklyExecutionTask){
 const pkg=obj((await unique(store,'social_weekly_operating_packages',{tenant_id:task.tenantId,program_id:task.programId,package_id:task.packageId,version:task.packageVersion})).payload) as WeeklyOperatingPackage;
 if(!pkg.socialContentPackage?.publicationTasks?.length||!pkg.socialContentPackage.publicationTasks.every(p=>p.inventoryReuseRef))return null;
 if(task.schedule.stepKind==='business_outline')return readWeeklyInventoryOutlineEvidence(store,task);
 const rows=await store.list<Record_>('social_weekly_execution_tasks',{where:{tenant_id:task.tenantId,program_id:task.programId,package_id:task.packageId,package_version:task.packageVersion},perPage:500});need(rows.totalItems===rows.items.length,'inventory_outline_task_scan_incomplete');
 const outlines=rows.items.map(r=>obj(r.payload) as WeeklyExecutionTask).filter(t=>t.schedule?.stepKind==='business_outline'&&t.workflowKind==='readiness');need(outlines.length===1&&outlines[0]!.status==='succeeded','inventory_outline_upstream_incomplete');
 return validateWeeklyInventoryOutlineRefs(store,outlines[0]!,outlines[0]!.resultRefs);
}
