import {parseSocialContentAuthorityLineage} from '../starter198/socialContentLineage.js';
import type {StarterRecord} from '../starter198/repository.js';
import type {DataStore,Record_} from '../storage/datastore.js';
import type {WeeklyOperatingPackage,WeeklyExecutionTask} from '../../shared/contracts/socialProgram.js';
import type {StoredPublicationAssignment} from './weeklyLineage.js';
/** Structural identity applies to both new submission and observation of an old request.
 * Lifecycle withdrawal is intentionally not permission to change the original identity. */
export function assertWeeklyPublicationStoredScope(row:StoredPublicationAssignment,pkg:WeeklyOperatingPackage):void{
 if(!pkg||typeof pkg!=='object')throw Error('weekly_publication_assignment_scope_invalid');
 const a=row.payload,lineage=a?.lineage;
 const pub=pkg.socialContentPackage?.publicationTasks?.filter(pub=>pub.publicationTaskId===row.publication_task_id);
 if(!a||!lineage||!row.tenant_id||!row.assignment_id||a.tenantId!==row.tenant_id||a.assignmentId!==row.assignment_id||a.packageId!==row.package_id||a.accountId!==row.account_id||a.platform!==row.platform||a.publicationTaskId!==row.publication_task_id||a.assignmentHash!==row.assignment_hash||lineage.productionResultRef?.id!==row.production_result_id||pkg.packageId!==row.operating_package_id||pkg.version!==row.operating_package_version||lineage.operatingPackageRef?.id!==pkg.packageId||lineage.operatingPackageRef?.version!==pkg.version||lineage.programRef?.id!==pkg.programId||lineage.weeklyPublicationTaskRef?.id!==row.publication_task_id||lineage.weeklyPublicationTaskRef?.version!==pkg.version||pub?.length!==1||pub[0]!.accountId!==row.account_id||pub[0]!.platform!==row.platform)throw Error('weekly_publication_assignment_scope_invalid');
}
/** A missing modern consumer is a broken formal graph, never permission to publish via legacy. */
export async function weeklyFormalPublicationBoundary(store:DataStore,assignment:StoredPublicationAssignment,pkg:WeeklyOperatingPackage):Promise<'formal'|'legacy'>{
 assertWeeklyPublicationStoredScope(assignment,pkg);
 const rows=await store.list<Record_>('social_weekly_execution_tasks',{where:{tenant_id:assignment.tenant_id,package_id:assignment.operating_package_id,package_version:assignment.operating_package_version},page:1,perPage:1000});
 if(rows.totalItems!==rows.items.length)throw Error('weekly_task_scan_truncated');
 const tasks=rows.items.map(row=>{const task=row.payload as WeeklyExecutionTask|undefined;if(!task||row.tenant_id!==assignment.tenant_id||row.package_id!==assignment.operating_package_id||row.package_version!==assignment.operating_package_version||row.task_id!==task.taskId||row.program_id!==pkg.programId||task.tenantId!==assignment.tenant_id||task.programId!==pkg.programId||task.packageId!==pkg.packageId||task.packageVersion!==pkg.version)throw Error('weekly_formal_consumer_scope_invalid');return task;});
 let formal=assignment.payload.lineage.upstreamRefs.some(ref=>['social_director_g5_review','weekly_execution_continuation','weekly_inventory_binding'].includes(ref.type))||tasks.length>0||pkg.agentPlanning!==undefined||pkg.referenceSourcePolicy!==undefined||pkg.executionTaskRefs!==undefined||pkg.workflowStateVersion!==undefined||Boolean(pkg.operatingDecisionSnapshotRef)||Boolean(pkg.profileUpgradeConsumption)||pkg.socialContentPackage.publicationTasks.some(pub=>Boolean(pub.inventoryReuseRef));
 const source=await store.list<Record_>('starter_social_content_lineage',{where:{tenant_id:assignment.tenant_id,production_result_id:assignment.production_result_id},page:1,perPage:2});
 if(source.totalItems!==source.items.length||source.items.length>1)throw Error('weekly_publication_source_ambiguous');
 if(source.items.length){const row=source.items[0]!;if(row.tenant_id!==assignment.tenant_id||row.production_result_id!==assignment.production_result_id)throw Error('weekly_publication_source_scope_invalid');const lineage=parseSocialContentAuthorityLineage(row as StarterRecord);if(lineage.productionResultRef?.id!==assignment.production_result_id||lineage.programRef.id!==pkg.programId||lineage.invalidation.status!=='valid')throw Error('weekly_publication_source_scope_invalid');formal ||= lineage.packageRef.type==='weekly_operating_package'&&lineage.weeklyTaskRef.type==='weekly_workflow_task';}

 const matching=tasks.filter(task=>task.publicationTaskId===assignment.publication_task_id&&task.schedule?.stepKind==='publishing');
 if(matching.length>1)throw Error('weekly_formal_consumer_ambiguous');
 if(matching.length===1){if(matching[0]!.workflowKind!=='publishing'||matching[0]!.accountId!==assignment.account_id)throw Error('weekly_formal_consumer_scope_invalid');return 'formal';}
 if(formal)throw Error('weekly_formal_publishing_consumer_missing');
 return 'legacy';
}
