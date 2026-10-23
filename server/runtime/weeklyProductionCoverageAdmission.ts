import {allocateWeeklyReferenceSources} from '../socialPrograms/weeklyReferenceSources.js';
import type {WeeklyAgentPlanningState,WeeklyOperatingPackage} from '../../shared/contracts/socialProgram.js';
import type {DataStore,Record_} from '../storage/datastore.js';
import {assertWeeklyPlanningCoverage,selectWeeklyPlanningCoverage} from '../socialPrograms/weeklyPlanningCoverage.js';
import {scheduleHash} from '../socialPrograms/weeklyScheduleSnapshots.js';
import {SocialProgramError} from '../socialPrograms/service.js';
import {socialJson,socialObject} from '../starter198/socialContentValidation.js';
import {verifiedWeeklyPlanningTemplateAdoption,weeklyPlanningExecutionActor,weeklyPlanningExecutionSelection} from '../socialPrograms/weeklyPlanningTemplateAdoption.js';
const fail=(code:string):never=>{throw new SocialProgramError(code,409,'实际确认范围、待补范围或原来源配额不一致，不能开始该内容生产。');};
/** Never interpret an item alone as confirmation of partial dispatch. */
export function assertWeeklyProductionCoverage(pkg:WeeklyOperatingPackage,plan:WeeklyAgentPlanningState,publicationTaskId:string):void {
 const detailed=plan.detailedSchedule,dispatch=plan.dispatch,confirmation=plan.userConfirmation,adoption=verifiedWeeklyPlanningTemplateAdoption(plan);
 const actor=weeklyPlanningExecutionActor(plan),confirmedSlots=weeklyPlanningExecutionSelection(plan),confirmedAt=confirmation?.confirmedAt??adoption?.adoptedAt;
 if(plan.status!=='dispatched'||!dispatch||!actor||dispatch.packageId!==pkg.packageId||dispatch.packageVersion!==pkg.version)return fail('weekly_production_dispatch_unconfirmed');
 const hasCoverage=!!(detailed?.coverage||dispatch.coverage||confirmedSlots);
 // Historical full dispatch must prove every original slot; it cannot masquerade as partial approval.
 if(!plan.skeleton||!detailed||!confirmedAt||(hasCoverage&&(!detailed.coverage||!dispatch.coverage||!confirmedSlots)))return fail('weekly_production_coverage_required');
 const coverage=detailed.coverage??selectWeeklyPlanningCoverage(plan);const dispatchCoverage=dispatch.coverage??coverage;const selectedSlots=confirmedSlots??coverage.selectedSlotIds;
 if(plan.programId!==pkg.programId||plan.packageId!==pkg.packageId||plan.packageVersion!==pkg.version||plan.skeleton.packageId!==pkg.packageId||plan.skeleton.packageVersion!==pkg.version)return fail('weekly_production_coverage_scope_changed');
 assertWeeklyPlanningCoverage(plan,coverage,selectedSlots);
 if(scheduleHash(coverage)!==scheduleHash(dispatchCoverage)||scheduleHash(coverage.referenceSourcePolicy)!==scheduleHash(pkg.referenceSourcePolicy??null)||scheduleHash(plan.referenceSourcePolicy??null)!==scheduleHash(pkg.referenceSourcePolicy??null)||scheduleHash(selectedSlots)!==scheduleHash(coverage.selectedSlotIds))return fail('weekly_production_coverage_changed');
 const publications=pkg.socialContentPackage.publicationTasks,allPublicationIds=plan.skeleton.slots.flatMap(slot=>slot.publicationTaskIds);if(new Set(allPublicationIds).size!==allPublicationIds.length||scheduleHash([...allPublicationIds].sort())!==scheduleHash(publications.map(pub=>pub.publicationTaskId).sort()))return fail('weekly_production_skeleton_range_changed');if(pkg.referenceSourcePolicy){const allocation=allocateWeeklyReferenceSources(publications,pkg.referenceSourcePolicy);for(const slot of plan.skeleton.slots){if(!slot.motherContentId||slot.referenceSource!==allocation.get(slot.motherContentId)||slot.publicationTaskIds.some(id=>publications.find(pub=>pub.publicationTaskId===id)?.motherContentId!==slot.motherContentId))return fail('weekly_production_source_allocation_changed');}}
 const selected=plan.skeleton.slots.filter(slot=>coverage.selectedSlotIds.includes(slot.slotId));
 const expected=selected.flatMap(slot=>slot.publicationTaskIds.map(pub=>({slotId:slot.slotId,publicationTaskId:pub})));
 const signatures=(items:Array<{slotId:string;publicationTaskId:string}>)=>items.map(item=>`${item.slotId}:${item.publicationTaskId}`).sort();
 if(new Set(expected.map(item=>item.publicationTaskId)).size!==expected.length||scheduleHash(signatures(detailed.items))!==scheduleHash(signatures(expected))||scheduleHash(signatures(dispatch.scheduleItems))!==scheduleHash(signatures(expected))||scheduleHash(dispatch.scheduleItemIds)!==scheduleHash(dispatch.scheduleItems.map(item=>item.scheduleItemId))||scheduleHash(dispatch.detailedScheduleRef)!==scheduleHash(detailed.ref)||scheduleHash(dispatch.scheduleItems)!==scheduleHash(detailed.items))return fail('weekly_production_dispatch_range_changed');
 const slots=plan.skeleton.slots.filter(slot=>slot.publicationTaskIds.includes(publicationTaskId));
 if(slots.length!==1||!coverage.selectedSlotIds.includes(slots[0]!.slotId)||dispatch.scheduleItems.filter(item=>item.publicationTaskId===publicationTaskId&&item.slotId===slots[0]!.slotId).length!==1)return fail('weekly_production_slot_pending');
}
export async function assertStoredWeeklyProductionCoverage(input:{store:DataStore;tenantId:string;package:WeeklyOperatingPackage;publicationTaskId:string;frozenPlanning?:unknown}):Promise<void>{
 const packages=await input.store.list<Record_>('social_weekly_operating_packages',{where:{tenant_id:input.tenantId,program_id:input.package.programId,package_id:input.package.packageId,version:input.package.version},perPage:2});if(packages.totalItems!==1||packages.items.length!==1)return fail('weekly_production_package_missing');const actual=socialObject(socialJson(packages.items[0]!.payload)) as unknown as WeeklyOperatingPackage;if(!actual||actual.packageId!==input.package.packageId||actual.version!==input.package.version||actual.programId!==input.package.programId||scheduleHash(actual.referenceSourcePolicy??null)!==scheduleHash(input.package.referenceSourcePolicy??null)||!actual.socialContentPackage.publicationTasks.some(pub=>pub.publicationTaskId===input.publicationTaskId))return fail('weekly_production_package_changed');
 const result=await input.store.list<Record_>('social_weekly_agent_planning',{where:{tenant_id:input.tenantId,program_id:input.package.programId,package_id:input.package.packageId,package_version:input.package.version},sort:'-planning_version',perPage:500});
 if(!result.items.length||result.items.length!==result.totalItems)return fail('weekly_production_planning_missing');
 const highest=Math.max(...result.items.map(row=>Number(row.planning_version))),rows=result.items.filter(row=>Number(row.planning_version)===highest);if(!Number.isSafeInteger(highest)||rows.length!==1)return fail('weekly_production_planning_identity');
 const plan=socialObject(socialJson(rows[0]!.payload)) as unknown as WeeklyAgentPlanningState;
 if(!plan)return fail('weekly_production_planning_identity');assertWeeklyProductionCoverage(actual,plan,input.publicationTaskId);
 if(input.frozenPlanning!==undefined&&scheduleHash(input.frozenPlanning)!==scheduleHash(plan))return fail('weekly_production_frozen_planning_changed');
}
