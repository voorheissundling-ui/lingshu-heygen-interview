import type {DataStore,Record_} from '../storage/datastore.js';
import type {WeeklyExecutionTask,WeeklyOperatingPackage} from '../../shared/contracts/socialProgram.js';
import {socialJson,socialObject,socialRequestHash} from '../starter198/socialContentValidation.js';
import {createWeeklyExecutionTaskService,getWeeklyExecutionTaskRow} from '../socialPrograms/executionTasks.js';
import {executionPackageFrozen,withExecutionPackageGate} from '../socialPrograms/weeklyExecutionGate.js';
import {latestPackageRow} from '../socialPrograms/weeklyOperatingPackageSupport.js';
import {readWeeklySamplePolicyEvidence,type WeeklySamplePolicyAuthority} from '../socialPrograms/weeklySamplePolicyEvidence.js';
import {weeklyScopeMatches,type WeeklyScanScope} from './weeklyScanScope.js';

const REASON='weekly_production_cta_evidence_required';
const CONTENT_STEPS=new Set(['material_preparation','script','storyboard','material_readiness','asset_generation','video_generation','quality_check','rework']);
const identity=(task:WeeklyExecutionTask)=>socialRequestHash({tenantId:task.tenantId,programId:task.programId,packageId:task.packageId,packageVersion:task.packageVersion,taskId:task.taskId,publicationTaskId:task.publicationTaskId,accountId:task.accountId,inputSnapshot:task.inputSnapshot,upstreamVersionRefs:task.upstreamVersionRefs,dependsOnTaskIds:task.dependsOnTaskIds});

/** Reopens only the original CTA-blocked preparation task after an independent
 * issuer and live Meta number pass the same admission used by production.
 * The worker rechecks that admission before creating content or spending money. */
export async function runWeeklyCtaEvidenceRecoveryScan(input:{store:DataStore;scope?:WeeklyScanScope;authority?:WeeklySamplePolicyAuthority}){
 if(input.authority&&process.env.NODE_ENV!=='test')throw Error('weekly_cta_recovery_test_authority_forbidden');
 const report={examined:0,resumed:0,blocked:0,failed:0};
 const candidates:Record_[]=[];
 for(let page=1;;page++){
  const rows=await input.store.list<Record_>('social_weekly_execution_tasks',{where:{status:'blocked'},page,perPage:500,sort:'id'});
  if(!Number.isSafeInteger(rows.totalItems)||rows.totalItems<0||rows.items.length>500)throw Error('weekly_cta_recovery_scan_invalid');
  candidates.push(...rows.items);
  if(page>=rows.totalPages||!rows.items.length)break;
 }
 for(const row of candidates){
  const task=socialObject(socialJson(row.payload)) as unknown as WeeklyExecutionTask|null;
  if(!task||!weeklyScopeMatches(input.scope,task)||task.status!=='blocked'||task.workflowKind!=='content'||!CONTENT_STEPS.has(task.schedule?.stepKind)||!task.ownBlockingReasons?.includes(REASON)||task.lease)continue;
  report.examined++;
  try{await withExecutionPackageGate(input.store,task,async assert=>{
   if(await executionPackageFrozen(input.store,task)){report.blocked++;return;}
   const currentRow=await getWeeklyExecutionTaskRow(input.store,task.tenantId,task.taskId),current=currentRow.payload;
   if(currentRow.program_id!==task.programId||currentRow.package_id!==task.packageId||currentRow.package_version!==task.packageVersion||current.status!=='blocked'||current.lease||!current.ownBlockingReasons.includes(REASON)||identity(current)!==identity(task)){report.blocked++;return;}
   const latest=await latestPackageRow(input.store,task.tenantId,task.programId,task.packageId);
   const pkg=latest?.payload as WeeklyOperatingPackage|undefined;
   if(!pkg||latest?.version!==task.packageVersion||pkg.version!==task.packageVersion||pkg.packageId!==task.packageId||pkg.programId!==task.programId||!['draft','active'].includes(pkg.status)){report.blocked++;return;}
   const publications=pkg.socialContentPackage?.publicationTasks?.filter(item=>item.publicationTaskId===task.publicationTaskId&&item.accountId===task.accountId)??[];
   if(publications.length!==1||!task.publicationTaskId){report.blocked++;return;}
   // No trust root, no signed product policy, no contact or no live Meta
   // membership all resolve to null. A saved phone alone never resumes work.
   const proof=await readWeeklySamplePolicyEvidence({store:input.store,scope:{tenantId:task.tenantId,programId:task.programId,packageId:task.packageId,packageVersion:task.packageVersion,publicationTaskId:task.publicationTaskId},authority:input.authority});
   if(!proof?.authorizesProduction){report.blocked++;return;}
   await assert();
   const reread=(await getWeeklyExecutionTaskRow(input.store,task.tenantId,task.taskId)).payload;
   if(reread.status!=='blocked'||reread.lease||!reread.ownBlockingReasons.includes(REASON)||identity(reread)!==identity(current)||await executionPackageFrozen(input.store,reread)){report.blocked++;return;}
   const changed=await createWeeklyExecutionTaskService(input.store).unblock(task.tenantId,task.programId,task.packageId,task.taskId,REASON);
   if(!changed.some(item=>item.taskId===task.taskId&&item.packageVersion===task.packageVersion&&!item.ownBlockingReasons.includes(REASON)))throw Error('weekly_cta_recovery_not_committed');
   report.resumed++;
  });}catch{report.failed++;}
 }
 return report;
}
