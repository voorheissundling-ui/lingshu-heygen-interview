import type {DataStore,Record_} from '../storage/datastore.js';
import type {WeeklyExecutionTask,WeeklyOperatingPackage} from '../../shared/contracts/socialProgram.js';
import {socialJson,socialObject,socialRequestHash} from '../starter198/socialContentValidation.js';
import {createSocialOperatingRepository} from '../socialOperating/repository.js';
import {createWeeklyExecutionTaskService,getWeeklyExecutionTaskRow} from '../socialPrograms/executionTasks.js';
import {executionPackageFrozen,withExecutionPackageGate} from '../socialPrograms/weeklyExecutionGate.js';
import {latestPackageRow} from '../socialPrograms/weeklyOperatingPackageSupport.js';
import {requireWeeklyPublicationProductSelection} from '../socialPrograms/weeklyPublicationProductSelection.js';
import {weeklyScopeMatches,type WeeklyScanScope} from './weeklyScanScope.js';

const REASON='weekly_production_product_selection_required';
const parsed=(value:unknown)=>socialObject(socialJson(value)) as unknown as WeeklyExecutionTask;
const identity=(task:WeeklyExecutionTask)=>socialRequestHash({tenantId:task.tenantId,programId:task.programId,packageId:task.packageId,packageVersion:task.packageVersion,taskId:task.taskId,publicationTaskId:task.publicationTaskId,accountId:task.accountId,inputSnapshot:task.inputSnapshot,upstreamVersionRefs:task.upstreamVersionRefs,dependsOnTaskIds:task.dependsOnTaskIds});

/** Reopens only the original selection-blocked preparation task. A selection
 * receipt is revalidated by the authenticated issuer reader under the package
 * gate; the worker must still recheck every other production admission. */
export async function runWeeklyProductionSelectionRecoveryScan(input:{store:DataStore;scope?:WeeklyScanScope}){
 const report={examined:0,resumed:0,blocked:0,failed:0};
 const candidates:Record_[]=[];
 for(let page=1;;page++){
  const list=await input.store.list<Record_>('social_weekly_execution_tasks',{where:{status:'blocked'},page,perPage:500,sort:'id'});
  if(!Number.isSafeInteger(list.totalItems)||list.totalItems<0||list.items.length>500)throw Error('weekly_selection_recovery_scan_invalid');
  candidates.push(...list.items);
  if(page>=list.totalPages||!list.items.length)break;
 }
 for(const row of candidates){
   const task=parsed(row.payload);
   if(!task||!weeklyScopeMatches(input.scope,task)||task.status!=='blocked'||task.schedule?.stepKind!=='material_preparation'||!task.ownBlockingReasons?.includes(REASON)||task.lease)continue;
   report.examined++;
   try{
    await withExecutionPackageGate(input.store,task,async assert=>{
     if(await executionPackageFrozen(input.store,task)){report.blocked++;return;}
     const currentRow=await getWeeklyExecutionTaskRow(input.store,task.tenantId,task.taskId),current=currentRow.payload;
     if(currentRow.program_id!==task.programId||currentRow.package_id!==task.packageId||currentRow.package_version!==task.packageVersion||current.status!=='blocked'||current.lease||!current.ownBlockingReasons.includes(REASON)||identity(current)!==identity(task)){report.blocked++;return;}
     const latest=await latestPackageRow(input.store,task.tenantId,task.programId,task.packageId);
     const pkg=latest?.payload as WeeklyOperatingPackage|undefined;
     if(!pkg||latest?.version!==task.packageVersion||pkg.version!==task.packageVersion||pkg.packageId!==task.packageId||pkg.programId!==task.programId||!['draft','active'].includes(pkg.status)){report.blocked++;return;}
     const publication=pkg.socialContentPackage?.publicationTasks?.find(item=>item.publicationTaskId===task.publicationTaskId&&item.accountId===task.accountId);
     if(!publication||pkg.socialContentPackage.publicationTasks.filter(item=>item.publicationTaskId===task.publicationTaskId).length!==1||pkg.businessContentGoalRef?.type!=='business_content_goal'){report.blocked++;return;}
     const goal=await createSocialOperatingRepository(input.store).getGoal(task.tenantId,task.programId,pkg.businessContentGoalRef.id,pkg.businessContentGoalRef.version);
     if(!goal||goal.goalId!==pkg.businessContentGoalRef.id||goal.version!==pkg.businessContentGoalRef.version||goal.programId!==task.programId){report.blocked++;return;}
     try{await requireWeeklyPublicationProductSelection({store:input.store,tenantId:task.tenantId,programId:task.programId,packageId:task.packageId,packageVersion:task.packageVersion,publication,goal});}
     catch{report.blocked++;return;}
     await assert();
     const reread=(await getWeeklyExecutionTaskRow(input.store,task.tenantId,task.taskId)).payload;
     if(reread.status!=='blocked'||reread.lease||!reread.ownBlockingReasons.includes(REASON)||identity(reread)!==identity(current)){report.blocked++;return;}
     const changed=await createWeeklyExecutionTaskService(input.store).unblock(task.tenantId,task.programId,task.packageId,task.taskId,REASON);
     if(!changed.some(item=>item.taskId===task.taskId&&item.packageVersion===task.packageVersion&&!item.ownBlockingReasons.includes(REASON)))throw Error('weekly_selection_recovery_not_committed');
     report.resumed++;
    });
   }catch{report.failed++;}
 }
 return report;
}
