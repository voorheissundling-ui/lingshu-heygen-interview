/** 面试阅读注释：真实结果校验：检查原任务、文件持久化、版本和产物证据。视频生成完成与G4/G5审核通过是不同结论。 */
import type {WeeklyOwnedProductIdentityPorts} from './weeklyOwnedProductIdentityDemand.js';
import {weeklyProductionEvidenceTask,currentSharedWeeklyArtifactRef} from './weeklyContentProductionIdentity.js';
export interface WeeklyExecutionResultValidationPorts {ownedProductIdentity?:WeeklyOwnedProductIdentityPorts; exactAnalysisPortsForRun?:import('./weeklyPreproductionProducer.js').WeeklyExactSettlementPortsForRun}
import type { VersionedSocialRef, WeeklyExecutionTask, WeeklyOperatingPackage } from '../../shared/contracts/socialProgram.js';
import {assertWeeklyPublicationStoredScope} from '../publishing/weeklyFormalPublicationBoundary.js';
import type {StoredPublicationAssignment} from '../publishing/weeklyLineage.js';
import {readStarterPublicationPackage} from '../publishing/starterPublicationPackage.js';
import {publicationInstant} from '../socialPrograms/publicationDeadlines.js';
import type { DataStore, Record_ } from '../storage/datastore.js';
import { SocialProgramError } from '../socialPrograms/service.js';
import { assertSocialContentFilePersisted } from '../starter198/socialContentFiles.js';
import { socialTaskSummary } from '../starter198/socialContentRecords.js';
import { weeklyScriptEvidence } from './socialWeeklyScriptEvidence.js';
import { weeklyStoryboardEvidence } from './socialWeeklyStoryboardEvidence.js';
import { createWeeklyRequiredMaterialAdmission } from '../socialPrograms/weeklyRequiredMaterialAdmission.js';
import { socialContentSourceOptions } from '../starter198/socialContentSourceOptions.js';
import { readVerifiedNoSharedMaterialDemand } from './socialWeeklyOriginalRunMaterialDemand.js';
import { ownedDiagnosisReady } from '../socialPrograms/ownedReferenceDiagnosis.js';
import { verifyMaterialEvidenceRequirements } from '../socialPrograms/materialEvidenceClassification.js';
import { readMaterialEvidenceConfiguration } from '../socialPrograms/materialEvidenceConfiguration.js';
import { createCustomerFeedbackTopicService } from '../socialPrograms/customerFeedbackTopics.js';
import { createWeeklyExecutionContinuationService } from '../socialPrograms/weeklyExecutionContinuations.js';
import { assertWeeklyPlanningCoverage } from '../socialPrograms/weeklyPlanningCoverage.js';
import {weeklyPlanningExecutionActor,weeklyPlanningExecutionSelection} from '../socialPrograms/weeklyPlanningTemplateAdoption.js';
import { socialJson, socialRequestHash } from '../starter198/socialContentValidation.js';
import { checkWeeklyMaterialClassification, checkWeeklyHumanRequirementBindings } from './socialWeeklyMaterialClassificationAdmission.js';
import { readContentExecutionJob } from '../contentExecution/durableQueue.js';
import { assertSocialContentGraphQuality } from '../starter198/socialContentGraphQualityGate.js';

const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const version = (value: unknown): number => Number(String(value).replace(/^v/, ''));
function requireResult(condition: unknown, code = 'weekly_execution_result_unverified'): asserts condition {
  if (!condition) throw new SocialProgramError(code, 409, '执行结果资源、归属、版本或完成凭据尚未验证。');
}
async function unique(store: DataStore, collection: string, where: Record<string, string | number>): Promise<Record_> {
  const rows = await store.list<Record_>(collection, { where, page: 1, perPage: 2 });
  requireResult(rows.totalItems === 1 && rows.items.length === 1);
  const row = rows.items[0]!;
  requireResult(Object.entries(where).every(([key, value]) => row[key] === value));
  return row;
}

async function materialClassification(store: DataStore, task: WeeklyExecutionTask) {
  const rows = await store.list<Record_>('social_weekly_agent_planning', { where: { tenant_id: task.tenantId, program_id: task.programId, package_id: task.packageId, package_version: task.packageVersion }, sort: '-planning_version', page: 1, perPage: 2 });
  requireResult(rows.items.length > 0 && (!rows.items[1] || rows.items[0]!.planning_version !== rows.items[1].planning_version));
  const row = rows.items[0]!;
  const plan = object(socialJson(row.payload));
  requireResult(row.tenant_id === task.tenantId && row.program_id === task.programId && row.package_id === task.packageId && row.package_version === task.packageVersion && plan.status === 'dispatched');
  const items = (plan.dispatch?.scheduleItems ?? []).filter((item: any) => item.publicationTaskId === task.publicationTaskId);
  requireResult(items.length === 1);
  const analyses = (plan.directorAnalyses ?? []).filter((analysis: any) => analysis.analysisId === items[0].directorAnalysisRef?.id);
  requireResult(analyses.length === 1);
  const result = await checkWeeklyMaterialClassification({ store, tenantId: task.tenantId, programId: task.programId, packageId: task.packageId, packageVersion: task.packageVersion, item: items[0], analysis: analyses[0] });
  requireResult(result.ready, result.ready ? undefined : result.code);
  return result.contract;
}

/** Verify persisted authority, never accept a client-supplied success label. */
export async function validateWeeklyExecutionResults(store: DataStore, task: WeeklyExecutionTask, refs: VersionedSocialRef[], now = new Date(),ports:WeeklyExecutionResultValidationPorts={}): Promise<void> {
  if(['material_preparation','material_readiness','script','storyboard','asset_generation','video_generation','quality_check','rework'].includes(task.schedule.stepKind)&&!task.inputSnapshot?.weeklyCreativeRepairRef){
    const canonical=await weeklyProductionEvidenceTask(store,task);
    if(canonical.taskId!==task.taskId){const canonicalRefs=await Promise.all(canonical.resultRefs.map(ref=>currentSharedWeeklyArtifactRef(store,{tenantId:task.tenantId,programId:task.programId,packageId:task.packageId,packageVersion:task.packageVersion,publicationTaskId:task.publicationTaskId!},ref)));requireResult(canonical.status==='succeeded'&&socialRequestHash(canonicalRefs)===socialRequestHash(refs),'weekly_shared_original_result_unverified');task=canonical;}
  }
  requireResult(Array.isArray(refs) && refs.length > 0 && refs.every(ref => text(ref?.type) && text(ref?.id) && Number.isSafeInteger(ref?.version) && ref.version > 0), 'weekly_execution_result_refs_invalid');
  if (task.inputSnapshot?.inventoryReuseRef && task.schedule.stepKind === 'user_approval') {
    requireResult(task.schedule.stepKind === 'user_approval' && task.schedule.responsibleActor === 'user', 'inventory_result_step_unsupported');
    const { validateInventoryUserApproval } = await import('./weeklyInventoryApprovalEvidence.js');
    await validateInventoryUserApproval(store, task, refs);
    return;
  }
  if (refs.some(ref => ref.type === 'weekly_execution_continuation')) {
    requireResult(refs.length === 1 && socialRequestHash(task.inputSnapshot?.weeklyContinuationRef) === socialRequestHash(refs[0]), 'weekly_execution_continuation_ref_unbound');
    const read = await createWeeklyExecutionContinuationService(store).readValidated({ tenantId: task.tenantId, programId: task.programId, packageId: task.packageId, targetVersion: task.packageVersion, targetTaskId: task.taskId, ref: refs[0]! }, now.toISOString());
    requireResult(read.status === 'ready' && read.detail.sourceVersion < task.packageVersion && read.resultRefs.length > 0, 'weekly_execution_continuation_not_ready');
    return;
  }
  requireResult(!task.inputSnapshot?.weeklyContinuationPending && !task.inputSnapshot?.weeklyContinuationRef, 'weekly_execution_continuation_result_required');
  const {readWeeklyCreativeRepairExecutionLineage}=await import('./weeklyCreativeRepairExecutionGraph.js');if(readWeeklyCreativeRepairExecutionLineage(task)){const {validateWeeklyCreativeRepairStageEvidence}=await import('./weeklyCreativeRepairExecutionAdapter.js');await validateWeeklyCreativeRepairStageEvidence(store,task,refs);return;}
  if (['template_extraction','template_performance_validation'].includes(String(task.schedule?.stepKind))) {const {createWeeklyContentTemplateService}=await import('../socialPrograms/weeklyContentTemplates.js');await createWeeklyContentTemplateService(store,{now:()=>now.toISOString()}).validateTemplateExecutionEvidence(task,refs);return;}
  if(refs.some(ref=>ref.type==='weekly_inventory_outline')){const {validateWeeklyInventoryOutlineRefs}=await import('./weeklyInventoryOutlineEvidence.js');await validateWeeklyInventoryOutlineRefs(store,task,refs);return;}
  if(refs.some(ref=>ref.type==='weekly_customer_channel_execution')){const {validateWeeklyCustomerChannelExecution}=await import('./socialWeeklyCustomerChannelAdapter.js');await validateWeeklyCustomerChannelExecution(store,task,refs);return;}
  if(refs.some(ref=>['operating_authority_snapshot','social_discovery_run'].includes(ref.type))){
    requireResult(['business_outline','benchmark_collection'].includes(task.schedule.stepKind),'weekly_preproduction_step_invalid');
    const {readWeeklyPreproductionExecutionGate}=await import('./weeklyPreproductionProducer.js');
    const gate=await readWeeklyPreproductionExecutionGate(store,task,ports.exactAnalysisPortsForRun);
    requireResult(gate.ready&&gate.resultRefs.length>0&&socialRequestHash(gate.resultRefs)===socialRequestHash(refs),'weekly_preproduction_result_unverified');
    return;
  }
  if(refs.some(ref=>ref.type==='quality_receipt')){
    requireResult(task.workflowKind==='content'&&['quality_check','rework'].includes(task.schedule.stepKind),'weekly_quality_receipt_step_invalid');
    const artifacts=refs.filter(ref=>ref.type==='starter_social_content_artifact');
    const receipts=refs.filter(ref=>ref.type==='quality_receipt');
    requireResult(refs.length===2&&artifacts.length===1&&receipts.length===1&&receipts[0]!.version===1,'weekly_quality_receipt_refs_invalid');
    await validateContentArtifact(store,task,artifacts[0]!);
    const {readVerifiedWeeklyContentQualityAudit}=await import('./weeklyContentQualityAudit.js');
    const verified=await readVerifiedWeeklyContentQualityAudit(store,task,artifacts[0]!);
    requireResult(receipts[0]!.id===verified.receiptId,'weekly_quality_receipt_unverified');
    return;
  }
  if (refs.some(ref => ref.type === 'social_metric_snapshot')) {
    const { validateWeeklyPublicationMetricRefs } = await import('./weeklyPublicationMetricEvidence.js');
    await validateWeeklyPublicationMetricRefs(store, task, refs, now);
    return;
  }
  for (const ref of refs) {
    if (ref.type === 'weekly_agent_planning' && ['readiness', 'discovery', 'directing'].includes(task.workflowKind)) {
      const planningWorkflow = { business_outline: 'readiness', benchmark_collection: 'discovery', benchmark_scoring: 'directing', director_analysis: 'directing', business_schedule: 'directing' } as const;
      requireResult(planningWorkflow[task.schedule.stepKind as keyof typeof planningWorkflow] === task.workflowKind, 'weekly_planning_step_evidence_invalid');
      const row = await unique(store, 'social_weekly_agent_planning', { tenant_id: task.tenantId, program_id: task.programId, package_id: task.packageId, package_version: task.packageVersion, planning_version: ref.version });
      const plan = object(row.payload);
      requireResult(plan.planningId === ref.id && plan.version === ref.version && plan.status === 'dispatched' && weeklyPlanningExecutionActor(plan as any) && plan.dispatch?.scheduleItems?.length && plan.detailedSchedule?.items?.length);
      if ('referenceSourcePolicy' in task.inputSnapshot) {
        const weekly = await unique(store, 'social_weekly_operating_packages', { tenant_id: task.tenantId, package_id: task.packageId, version: task.packageVersion });
        const pkg = object(weekly.payload);
        const policy = object(pkg.referenceSourcePolicy);
        const planned = object(plan.referenceSourcePolicy);
        const frozen = object(task.inputSnapshot.referenceSourcePolicy);
        requireResult(pkg.programId === task.programId && ['b2b_cold_start', 'b2b_established'].includes(policy.profile)
          && ['profile', 'ownedPercent', 'externalPercent', 'allocationUnit'].every(key => policy[key] === planned[key] && policy[key] === frozen[key]), 'weekly_reference_source_policy_unverified');
        if (policy.profile === 'b2b_cold_start') requireResult((plan.skeleton?.slots ?? []).every((slot: any) => slot.referenceSource === 'external'), 'weekly_reference_source_policy_unverified');
      }
      const step = task.schedule.stepKind;
      const motherId = String(task.inputSnapshot.motherContentId ?? '');
      const coverage = plan.dispatch.coverage;
      if (coverage) {
        assertWeeklyPlanningCoverage(plan as any, coverage, weeklyPlanningExecutionSelection(plan as any)??[]);
        requireResult(socialRequestHash(plan.detailedSchedule.coverage) === socialRequestHash(coverage), 'weekly_partial_coverage_changed');
        if (task.publicationTaskId) requireResult(plan.skeleton.slots.some((slot: any) => coverage.selectedSlotIds.includes(slot.slotId) && slot.publicationTaskIds.includes(task.publicationTaskId)) && plan.dispatch.scheduleItems.some((item: any) => item.publicationTaskId === task.publicationTaskId), 'weekly_slot_not_dispatched');
      }
      const slots = (plan.skeleton?.slots ?? []).filter((slot: any) => (!coverage || coverage.selectedSlotIds.includes(slot.slotId)) && (!motherId || slot.motherContentId === motherId) && (!task.accountId || slot.accountIds.includes(task.accountId)));
      requireResult(slots.length && (!task.accountId || slots.some((slot: any) => slot.accountIds.includes(task.accountId))));
      if (step === 'business_outline') requireResult(plan.skeleton?.slots?.length);
      else if (step === 'business_schedule') requireResult(slots.every((slot: any) => slot.publicationTaskIds.every((id: string) => plan.detailedSchedule.items.some((item: any) => item.publicationTaskId === id) && plan.dispatch.scheduleItems.some((item: any) => item.publicationTaskId === id))));
      else if (['benchmark_collection', 'benchmark_scoring', 'director_analysis'].includes(step)) {
        const analyses = (plan.directorAnalyses ?? []).filter((analysis: any) => slots.some((slot: any) => slot.slotId === analysis.slotId));
        requireResult(analyses.length && analyses.every((analysis: any) => analysis.packageVersion === task.packageVersion && analysis.benchmarkAccountRefs?.length && analysis.benchmarkVideoRefs?.length && analysis.benchmarkEvidenceRefs?.length && text(analysis.contentDirection)));
        for (const analysis of analyses) {
          const frozen = await unique(store, 'social_weekly_operating_packages', { tenant_id: task.tenantId, package_id: task.packageId, version: task.packageVersion });
          const frozenPackage = object(frozen.payload);
          requireResult(frozenPackage.programId === task.programId);
          const slot = slots.find((item: any) => item.slotId === analysis.slotId);
          const feedbackPublications = (frozenPackage.socialContentPackage?.publicationTasks ?? []).filter((publication: any) => slot?.publicationTaskIds.includes(publication.publicationTaskId) && publication.customerFeedbackTopicRef);
          const topicRefs = analysis.customerFeedbackTopicRefs ?? [];
          const topicEvidence = analysis.customerFeedbackTopicEvidence ?? [];
          requireResult(topicRefs.length === feedbackPublications.length && topicEvidence.length === feedbackPublications.length, 'weekly_customer_feedback_topic_evidence_missing');
          for (const publication of feedbackPublications) {
            const matchingRefs = topicRefs.filter((ref: any) => socialRequestHash(ref) === socialRequestHash(publication.customerFeedbackTopicRef));
            const matchingEvidence = topicEvidence.filter((evidence: any) => evidence.publicationTaskId === publication.publicationTaskId);
            requireResult(matchingRefs.length === 1 && matchingEvidence.length === 1, 'weekly_customer_feedback_topic_evidence_ambiguous');
            const verified = await createCustomerFeedbackTopicService(store).verifiedPlanningReference({ tenantId: task.tenantId, programId: task.programId, pkg: frozen.payload as any, publicationTaskId: publication.publicationTaskId, ref: publication.customerFeedbackTopicRef });
            const evidence = matchingEvidence[0];
            requireResult(evidence.question === verified.candidate.source.question && evidence.topicAngle === verified.candidate.topicAngle
              && socialRequestHash(evidence.confirmationRef) === socialRequestHash(publication.customerFeedbackTopicRef)
              && socialRequestHash(evidence.candidateRef) === socialRequestHash(verified.confirmation.candidateRef), 'weekly_customer_feedback_topic_evidence_changed');
          }
          const requirement = analysis.materialEvidenceRequirements;
          if (!requirement) continue;
          let handoff: any = null;
          if (requirement.handoffRef) {
            const rows = await store.list<Record_>('starter_social_inspiration_handoff_versions', { where: { tenant_id: task.tenantId, record_hash: requirement.handoffRef.recordHash }, page: 1, perPage: 2 });
            requireResult(rows.totalItems === 1 && rows.items.length === 1);
            const row = rows.items[0]!;
            handoff = socialJson(row.payload);
            requireResult(row.tenant_id === task.tenantId && row.record_hash === socialRequestHash(handoff));
          }
          const configuration = requirement.configurationRef && requirement.handoffRef ? await readMaterialEvidenceConfiguration(store, { tenantId: task.tenantId, programId: task.programId, scope: requirement.scope, handoffRef: requirement.handoffRef, ref: requirement.configurationRef }) : null;
          requireResult(!requirement.configurationRef || configuration, 'weekly_material_classification_configuration_invalid');
          requireResult(verifyMaterialEvidenceRequirements(requirement, { packageId: task.packageId, packageVersion: task.packageVersion, slotId: analysis.slotId }, analysis.frozenHandoffRefs ?? [], handoff, configuration), 'weekly_material_classification_unverified');
        }
        const ownedSlots = slots.filter((slot: any) => slot.referenceSource === 'owned');
        if (ownedSlots.length) {
          const weekly = await unique(store, 'social_weekly_operating_packages', { tenant_id: task.tenantId, package_id: task.packageId, version: task.packageVersion });
          const pkg = object(weekly.payload);
          const policy = object(pkg.referenceSourcePolicy);
          requireResult(pkg.programId === task.programId && policy.profile === 'b2b_established');
          const plannedPolicy = object(plan.referenceSourcePolicy);
          requireResult(['profile', 'ownedPercent', 'externalPercent', 'allocationUnit'].every(key => plannedPolicy[key] === policy[key]), 'weekly_reference_source_policy_unverified');
          requireResult(ownedSlots.every((slot: any) => {
            const matches = analyses.filter((analysis: any) => analysis.slotId === slot.slotId);
            if (matches.length !== 1 || !ownedDiagnosisReady(matches[0])) return false;
            const diagnosisPolicy = matches[0].ownedReferenceDiagnosis.policy;
            return diagnosisPolicy.profile === policy.profile && diagnosisPolicy.ownedPercent === policy.ownedPercent && diagnosisPolicy.externalPercent === policy.externalPercent && diagnosisPolicy.allocationUnit === policy.allocationUnit;
          }), 'weekly_owned_reference_diagnosis_unverified');
        }
      } else requireResult(false);
    } else if(ref.type==='starter_weekly_pre_supply_handoff') {
      requireResult(task.workflowKind==='directing'&&task.schedule.stepKind==='storyboard'&&ref.version===1);
      const rows=await store.list<Record_>('starter_social_content_tasks',{where:{tenant_id:task.tenantId,create_idempotency_key:`weekly-production:${task.packageId}:${task.packageVersion}:${task.publicationTaskId}`},perPage:2});
      requireResult(rows.totalItems===1&&rows.items.length===1);const row=rows.items[0]!;
      requireResult(row.run_id===ref.id&&!['cancelled','paused','attention','needs_input'].includes(String(row.status)));
      const {createStarter198Repository}=await import('../starter198/repository.js');
      const {readWeeklyPreSupplyHandoff}=await import('../starter198/socialWeeklyPreSupplyHandoff.js');
      const handoff=await readWeeklyPreSupplyHandoff(createStarter198Repository(store),task.tenantId,String(row.task_id));
      requireResult(handoff?.programId===task.programId&&handoff.packageId===task.packageId&&handoff.packageVersion===task.packageVersion&&handoff.publicationTaskId===task.publicationTaskId);
      requireResult(handoff);
      const {validateWeeklyTemplateProductionOutput}=await import('../socialPrograms/weeklyTemplateStructure.js');
      await validateWeeklyTemplateProductionOutput({store,task,contentRow:row,preSupply:handoff});
    } else if (['content', 'directing'].includes(task.workflowKind) && (ref.type === 'starter_social_content_script_baseline' && task.schedule.stepKind === 'script'
      || ref.type === 'starter_social_content_director_plan' && task.schedule.stepKind === 'storyboard')) {
      if (task.schedule.stepKind === 'storyboard') {
        const packageRow = await unique(store, 'social_weekly_operating_packages', { tenant_id: task.tenantId, program_id: task.programId, package_id: task.packageId, version: task.packageVersion });
        const weeklyPackage = object(socialJson(packageRow.payload));
        requireResult(weeklyPackage.programId === task.programId && weeklyPackage.packageId === task.packageId && weeklyPackage.version === task.packageVersion
          && Number(weeklyPackage.executionGraphVersion ?? 1) < 2, 'weekly_pre_supply_handoff_required');
      }
      const row = await unique(store, 'starter_social_content_tasks', { tenant_id: task.tenantId, task_id: ref.id });
      const brief = object(row.brief);
      requireResult(brief.programRef?.id === task.programId && row.create_idempotency_key === `weekly-production:${task.packageId}:${task.packageVersion}:${task.publicationTaskId}`);
      requireResult(text(row.run_id) && !['cancelled','paused','attention','needs_input'].includes(String(row.status)));
      const run = await store.getById<Record_>('workflow_runs', String(row.run_id));
      requireResult(run?.tenant_id === task.tenantId && !['cancelled','failed','dead_letter'].includes(String(run.status)));
      const ids = (brief._weeklyAuthority?.referenceSelection?.selected ?? []).map((item: any) => String(item.candidateId));
      const verified = ref.type === 'starter_social_content_director_plan' ? weeklyStoryboardEvidence(row, ids) : weeklyScriptEvidence(row, ids);
      requireResult(verified?.id === ref.id && verified.version === ref.version);
      const { validateWeeklyTemplateProductionOutput } = await import('../socialPrograms/weeklyTemplateStructure.js');
      await validateWeeklyTemplateProductionOutput({ store, task, contentRow: row });
    } else if(ref.type==='starter_social_material_preparation') {
      const {validateWeeklyMaterialPreparationEvidence}=await import('./weeklyMaterialPreparationEvidence.js');
      await validateWeeklyMaterialPreparationEvidence(store,task,ref,ports.ownedProductIdentity);
    } else if(ref.type==='starter_social_owned_product_identity_demand') {
      requireResult(task.workflowKind==='content'&&task.schedule.stepKind==='material_readiness'&&Boolean(task.publicationTaskId),'weekly_owned_product_identity_consumer_invalid');
      const consumer=await unique(store,'social_weekly_execution_tasks',{tenant_id:task.tenantId,task_id:task.taskId});const persisted=object(consumer.payload);
      requireResult(consumer.program_id===task.programId&&consumer.package_id===task.packageId&&consumer.package_version===task.packageVersion&&consumer.task_id===task.taskId&&persisted.taskId===task.taskId&&persisted.tenantId===task.tenantId&&persisted.programId===task.programId&&persisted.packageId===task.packageId&&persisted.packageVersion===task.packageVersion&&persisted.publicationTaskId===task.publicationTaskId&&persisted.accountId===task.accountId&&persisted.workflowKind===task.workflowKind&&persisted.schedule?.stepKind===task.schedule.stepKind&&socialRequestHash(persisted.inputSnapshot)===socialRequestHash(task.inputSnapshot)&&socialRequestHash(persisted.upstreamVersionRefs)===socialRequestHash(task.upstreamVersionRefs),'weekly_owned_product_identity_consumer_invalid');
      const row=await unique(store,'starter_social_content_tasks',{tenant_id:task.tenantId,task_id:ref.id});
      requireResult(row.create_idempotency_key===`weekly-production:${task.packageId}:${task.packageVersion}:${task.publicationTaskId}`&&text(row.run_id)&&!['cancelled','paused','attention','needs_input'].includes(String(row.status)));
      const run=await store.getById<Record_>('workflow_runs',String(row.run_id));requireResult(run?.tenant_id===task.tenantId&&!['cancelled','failed','dead_letter'].includes(String(run.status)),'weekly_owned_product_identity_original_run_invalid');
      const {assessWeeklyOwnedProductIdentity}=await import('./weeklyOwnedProductIdentityDemand.js');const {createStarter198Repository}=await import('../starter198/repository.js');
      const result=await assessWeeklyOwnedProductIdentity(store,{tenantId:task.tenantId,programId:task.programId,packageId:task.packageId,packageVersion:task.packageVersion,publicationTaskId:task.publicationTaskId!,contentTaskId:ref.id},ports.ownedProductIdentity??{repository:createStarter198Repository(store)});
      const frozen=object(row.brief)._weeklyOwnedProductIdentityDemand;
      requireResult(result.status==='ready'&&result.consumerTaskId===task.taskId&&frozen?.version===ref.version&&result.materials.length>0&&result.materials.every(material=>material.sourceBound),'weekly_owned_product_identity_unverified');
      const classification=await materialClassification(store,task);requireResult(classification.items.every(item=>item.classification==='generatable_non_evidentiary'),'weekly_required_materials_unverified');
    } else if (ref.type === 'starter_social_content_material_demand' && task.workflowKind === 'content' && task.schedule.stepKind === 'material_readiness') {
      const row = await unique(store, 'starter_social_content_tasks', { tenant_id: task.tenantId, task_id: ref.id });
      requireResult(row.create_idempotency_key === `weekly-production:${task.packageId}:${task.packageVersion}:${task.publicationTaskId}` && text(row.run_id) && !['cancelled', 'paused', 'attention', 'needs_input'].includes(String(row.status)));
      const run = await store.getById<Record_>('workflow_runs', String(row.run_id));
      requireResult(run?.tenant_id === task.tenantId && !['cancelled', 'failed', 'dead_letter'].includes(String(run.status)));
      const weekly = await unique(store, 'social_weekly_operating_packages', { tenant_id: task.tenantId, package_id: task.packageId, version: task.packageVersion });
      const pkg = object(weekly.payload);
      const publications = object(pkg.socialContentPackage).publicationTasks;
      const matches = Array.isArray(publications) ? publications.filter((item: any) => item.publicationTaskId === task.publicationTaskId) : [];
      requireResult(pkg.programId === task.programId && matches.length === 1 && !matches[0].materialRequirement && Array.isArray(matches[0].factRefs));
      const demand = await readVerifiedNoSharedMaterialDemand(store, row, { tenantId: task.tenantId, taskId: ref.id, programId: task.programId, packageId: task.packageId, packageVersion: task.packageVersion, publicationTaskId: task.publicationTaskId!, accountId: matches[0].accountId, factRefs: matches[0].factRefs });
      requireResult(demand?.version === ref.version, 'weekly_material_demand_unverified');
      const classification = await materialClassification(store, task);
      requireResult(classification.items.every(item => item.classification === 'generatable_non_evidentiary'), 'weekly_required_materials_unverified');
    } else if (ref.type === 'starter_social_content_task' && task.workflowKind === 'content' && task.schedule.stepKind === 'material_readiness') {
      const row = await unique(store, 'starter_social_content_tasks', { tenant_id: task.tenantId, task_id: ref.id });
      requireResult(version(row.version) === ref.version);
      const summary = socialTaskSummary(row);
      requireResult(summary.readiness.complete && summary.runId && !['cancelled', 'paused', 'attention', 'needs_input'].includes(summary.status));
      const run = await store.getById<Record_>('workflow_runs', summary.runId!);
      requireResult(run?.tenant_id === task.tenantId && !['cancelled', 'failed', 'dead_letter'].includes(String(run.status)));
      const brief = object(row.brief);
      requireResult(brief.programRef?.id === task.programId && row.create_idempotency_key === `weekly-production:${task.packageId}:${task.packageVersion}:${task.publicationTaskId}`);
      const weekly = await unique(store, 'social_weekly_operating_packages', { tenant_id: task.tenantId, package_id: task.packageId, version: task.packageVersion });
      const pkg = object(weekly.payload);
      requireResult(pkg.programId === task.programId);
      const publications = object(pkg.socialContentPackage).publicationTasks;
      const matches = Array.isArray(publications) ? publications.filter((item: any) => item.publicationTaskId === task.publicationTaskId) : [];
      requireResult(matches.length === 1);
      requireResult(matches[0].materialRequirement?.required === true, 'weekly_material_contract_required');
      if (matches[0].materialRequirement) {
        const admitted = await createWeeklyRequiredMaterialAdmission(store,ports.ownedProductIdentity?.materialPorts)({ tenantId: task.tenantId, programId: task.programId, consumerTaskId: task.taskId, requirement: matches[0].materialRequirement });
        requireResult(admitted.status === 'ready' && admitted.materials.length > 0, 'weekly_required_materials_unverified');
        const classification = await materialClassification(store, task);
        const gap = await checkWeeklyHumanRequirementBindings({ store, tenantId: task.tenantId, programId: task.programId, packageId: task.packageId, packageVersion: task.packageVersion, consumerTaskId: task.taskId, publication: matches[0], contract: classification });
        requireResult(!gap, gap ?? undefined);
        for (const material of admitted.materials) {
          const sourceRef = `socialmaterial:${Buffer.from(`pb-${material.recordId}`, 'utf8').toString('base64url')}`;
          const option = await (ports.ownedProductIdentity?.sourceOptions??socialContentSourceOptions).resolve({ tenantId: task.tenantId, kind: 'material', sourceRef });
          requireResult(option?.sourceVersion, 'weekly_required_material_source_unverified');
          const source = await unique(store, 'starter_social_task_sources', { tenant_id: task.tenantId, task_id: ref.id, source_kind: 'material', source_ref: sourceRef, status: 'active' });
          requireResult(source.source_version === option.sourceVersion, 'weekly_required_material_source_unverified');
        }
      }
    } else if (ref.type === 'starter_social_content_artifact' && task.workflowKind === 'content') {
      await validateContentArtifact(store, task, ref);
    } else if (ref.type === 'weekly_publication_attempt' && task.workflowKind === 'publishing' && task.schedule.stepKind === 'publishing') {
      requireResult(ref.version === 1);
      const attempt = await unique(store, 'social_publication_attempts', { tenant_id: task.tenantId, attempt_id: ref.id });
      requireResult(attempt.status === 'published' && text(attempt.provider_receipt_id) && text(attempt.platform_post_id) && Number.isFinite(Date.parse(String(attempt.resolved_at))) && text(attempt.provider) && !attempt.mock && !attempt.simulated && !/mock|simulat|test[_-]?provider/i.test(String(attempt.provider)) && !/^(simr_|mock|simulat)/i.test(String(attempt.provider_receipt_id)) && !/^(simp_|mock|simulat)/i.test(String(attempt.platform_post_id)));
      const startedAt = publicationInstant(String(attempt.started_at)), resolvedAt = publicationInstant(String(attempt.resolved_at));
      requireResult(startedAt !== null && resolvedAt !== null && resolvedAt >= startedAt && resolvedAt <= now.getTime(), 'weekly_publication_result_time_invalid');
      const assignment = await unique(store, 'social_publication_assignments', { tenant_id: task.tenantId, assignment_id: String(attempt.assignment_id) });
      requireResult(assignment.status !== 'revoked' && !assignment.authorization_revoked_at && assignment.package_id === attempt.package_id && assignment.operating_package_id === task.packageId && assignment.operating_package_version === task.packageVersion && assignment.publication_task_id === task.publicationTaskId && assignment.account_id === task.accountId);
      const weekly = await unique(store, 'social_weekly_operating_packages', { tenant_id: task.tenantId, package_id: task.packageId, version: task.packageVersion });
      const pkg = object(weekly.payload) as WeeklyOperatingPackage;
      requireResult(weekly.program_id === task.programId && pkg.programId === task.programId && pkg.status === 'active', 'weekly_publication_result_scope_invalid');
      try { assertWeeklyPublicationStoredScope(assignment as unknown as StoredPublicationAssignment, pkg); }
      catch { requireResult(false, 'weekly_publication_result_scope_invalid'); }
      const expectedProvider = assignment.platform === 'tiktok' ? 'tiktok-content-posting-api' : assignment.platform === 'youtube' ? 'youtube-data-api' : ['instagram', 'facebook'].includes(String(assignment.platform)) ? 'meta-graph-api' : null;
      requireResult(expectedProvider && attempt.provider === expectedProvider, 'weekly_publication_result_provider_invalid');
      const manifest = await readStarterPublicationPackage(task.tenantId, String(attempt.package_id), store);
      requireResult(manifest && manifest.operatingLineage, 'weekly_publication_result_manifest_invalid');
      const lineage = manifest.operatingLineage;
      requireResult(lineage && manifest.tenantId === task.tenantId && manifest.packageId === assignment.package_id && manifest.platform === assignment.platform && lineage.assignmentId === assignment.assignment_id && lineage.assignmentHash === assignment.assignment_hash && lineage.productionResultRef.id === assignment.production_result_id, 'weekly_publication_result_manifest_invalid');
      const pack = object(object(weekly.payload).socialContentPackage);
      requireResult(pack.authorization?.allowRealPublishing === true && !pack.authorization.revokedAt && pack.authorization.accountIds?.includes(task.accountId));
      await validateWeeklyPublicationAcceptance(store, task, String(assignment.production_result_id));
    } else if (ref.type === 'weekly_review_snapshot' && task.workflowKind === 'review') {
      requireResult(ref.version === 1);
      const row = await unique(store, 'social_weekly_review_snapshots', { tenant_id: task.tenantId, package_id: task.packageId, package_version: task.packageVersion, snapshot_id: ref.id });
      const snapshot = object(row.snapshot);
      requireResult(snapshot.snapshotId === ref.id && snapshot.tenantId === task.tenantId && snapshot.programId === task.programId && text(row.source_digest) && text(row.frozen_by) && Number.isFinite(Date.parse(String(row.frozen_at))) && snapshot.window?.frozenAt === row.frozen_at && snapshot.sourceDigest === row.source_digest && snapshot.operatingPackageRef?.id === task.packageId && snapshot.operatingPackageRef?.version === task.packageVersion);
    } else requireResult(false, 'weekly_execution_result_type_unsupported');
  }
}

export async function validateContentArtifact(store: DataStore, task: WeeklyExecutionTask, ref: VersionedSocialRef) {
  ref=await currentSharedWeeklyArtifactRef(store,{tenantId:task.tenantId,programId:task.programId,packageId:task.packageId,packageVersion:task.packageVersion,publicationTaskId:task.publicationTaskId!},ref);
  task=await weeklyProductionEvidenceTask(store,task);
  const row = await unique(store, 'starter_social_content_artifacts', { tenant_id: task.tenantId, artifact_id: ref.id });
  requireResult(version(row.version) === ref.version && ['draft', 'review_required', 'approved'].includes(String(row.status)));
  const content = object(row.content);
  const source = await unique(store, 'starter_social_content_tasks', { tenant_id: task.tenantId, task_id: String(row.task_id) });
  const { resolveWeeklyCreativeRepairApprovalEvidence } = await import('../socialPrograms/weeklyCreativeRepairApprovalEvidence.js');
  const creativeRepair = await resolveWeeklyCreativeRepairApprovalEvidence(store, task);
  if (creativeRepair) {
    requireResult(creativeRepair.contentTask.task_id === source.task_id && creativeRepair.artifactRef.id === ref.id && creativeRepair.artifactRef.version === ref.version, 'weekly_creative_repair_approval_artifact_changed');
  } else {
    requireResult(source.create_idempotency_key === `weekly-production:${task.packageId}:${task.packageVersion}:${task.publicationTaskId}` && object(source.brief).programRef?.id === task.programId);
  }
  requireResult(text(source.run_id) && !['cancelled', 'paused', 'attention', 'needs_input'].includes(String(source.status)));
  const run = await store.getById<Record_>('workflow_runs', String(source.run_id));
  requireResult(run?.tenant_id === task.tenantId && !['cancelled', 'failed', 'dead_letter'].includes(String(run.status)));
  // A recovered weekly result cannot borrow a completed artifact from another
  // execution of the same content task. Legacy artifacts predate this field;
  // current graph-produced artifacts must pin their actual producer run.
  const workspaceSource = object(content.productionWorkspaceSource);
  if (content.workflowSchema === 'social-content.auto-production.v3' || workspaceSource.runId !== undefined)
    requireResult(text(workspaceSource.runId) === text(source.run_id), 'weekly_production_artifact_run_changed');
  if (content.workflowSchema === 'social-content.auto-production.v3' && ['quality_check', 'rework'].includes(task.schedule.stepKind)) {
    const job = await readContentExecutionJob(store, task.tenantId, String(source.task_id), String(source.run_id));
    const checkpoint = object(job?.checkpoints['social.graph_review']);
    const subject = object(checkpoint.payload);
    const media = object(object(content.mediaStorage).video);
    requireResult(job && job.runId === source.run_id && checkpoint.version === '1'
      && subject.waitingReview === true && subject.runId === source.run_id
      && subject.artifactId === ref.id && Number(subject.version) === ref.version - (row.status === 'approved' ? 1 : 0)
      && subject.contentHash === socialRequestHash(socialJson(row.content))
      && /^[a-f0-9]{64}$/i.test(text(subject.outputSha256))
      && subject.outputSha256 === workspaceSource.outputSha256
      && subject.outputSha256 === media.sha256,
    'weekly_production_graph_review_unverified');
    if (row.status === 'approved') {
      const { loadSocialProductionGraphApproval } = await import('../starter198/socialContentProductionGraph.js');
      requireResult(await loadSocialProductionGraphApproval((await import('../starter198/repository.js')).createStarter198Repository(store), job), 'weekly_production_graph_review_unverified');
    } else {
      requireResult(job.status === 'paused' && run.status === 'waiting_human'
        && run.pause_reason === 'langgraph_artifact_review_required', 'weekly_production_graph_review_unverified');
    }
    try { assertSocialContentGraphQuality(content); }
    catch { requireResult(false, 'weekly_production_graph_quality_unverified'); }
  }
  requireResult(row.artifact_kind === 'short_video' && row.origin === 'agent' && text(row.resource_ref) && content.render?.completed === true);
  const media = object(content.mediaStorage?.video);
  requireResult(text(media.fileId) && /^[a-f0-9]{64}$/i.test(text(media.sha256)) && text(media.url));
  const file = await unique(store, 'starter_social_content_files', { tenant_id: task.tenantId, file_id: media.fileId });
  requireResult(row.resource_ref === `socialfile:${media.fileId}` && file.task_id === row.task_id && file.content_sha256 === media.sha256 && Number(file.byte_size) > 0 && ['object', 'backend_file', 'local'].includes(String(file.storage_kind)));
  await assertSocialContentFilePersisted({ record: file, tenantId: task.tenantId });
  const { validateWeeklyTemplateProductionOutput } = await import('../socialPrograms/weeklyTemplateStructure.js');
  await validateWeeklyTemplateProductionOutput({ store, task, contentRow: source, artifactRow: row });
  const productionId=text(content.productionResult?.productionResultId);
  if(productionId){
    // actor is payload authority; do not rely on optional indexed actor metadata.
    const allReceipts=await store.list<Record_>('starter_social_production_receipts',{where:{tenant_id:task.tenantId,production_result_id:productionId},perPage:500});requireResult(allReceipts.totalItems===allReceipts.items.length);
    const {parseSocialProductionReceiptRecord}=await import('../starter198/socialContentProductionHandoff.js');const {verifyTrustedHumanProductionReceipt}=await import('../starter198/socialSceneG4ReviewService.js');
    const {createStarter198Repository}=await import('../starter198/repository.js');for(const receiptRow of allReceipts.items){const receipt=parseSocialProductionReceiptRecord(receiptRow as import('../starter198/repository.js').StarterRecord);if(receipt.actor==='human_reviewer')await verifyTrustedHumanProductionReceipt(createStarter198Repository(store),task.tenantId,receipt);}
  }
  const step = task.schedule.stepKind;
  if (step === 'script') requireResult(content.scriptBaseline?.scenes?.length && content.scriptBaseline.scenes.every((scene: any) => text(scene.script) || text(scene.voiceover)));
  else if (step === 'storyboard') requireResult(content.directorPlan?.sceneCount > 0);
  else if (step === 'asset_generation') requireResult(content.render?.selectedAssetIds?.length > 0);
  else if (step === 'video_generation') requireResult(text(content.mediaStorage?.video?.url) && text(content.mediaStorage?.video?.sha256));
  else if (['quality_check', 'rework'].includes(step)) {
    requireResult(text(content.mediaStorage?.video?.url));
    if (!creativeRepair && (content.workflowSchema === 'social-content.auto-production.v3' || !(content.productionResult?.technicalReview?.approved === true && content.productionResult?.creativeReview?.approved === true))) {
      const { assertWeeklyContentQualityAudit } = await import('./weeklyContentQualityAudit.js');
      await assertWeeklyContentQualityAudit(store, task, ref);
    }
  }
  else requireResult(false, 'weekly_execution_result_type_unsupported');
}

/** Pre-effect gate: acceptance cannot be inferred from a user approval marker alone. */
export async function validateWeeklyPublicationAcceptance(store: DataStore, task: WeeklyExecutionTask, assignmentProductionId?: string): Promise<void> {
  const approvals = await store.list<Record_>('social_weekly_execution_tasks', { where: { tenant_id: task.tenantId, package_id: task.packageId, package_version: task.packageVersion }, page: 1, perPage: 1000 });
  requireResult(approvals.totalItems <= approvals.items.length);
  const matchingApprovals = approvals.items.filter(row => {
    const item = object(row.payload);
    return row.tenant_id === task.tenantId && item.tenantId === task.tenantId && item.programId === task.programId && item.packageId === task.packageId && item.packageVersion === task.packageVersion && item.publicationTaskId === task.publicationTaskId && item.schedule?.stepKind === 'user_approval' && item.status === 'succeeded' && item.resultRefs?.some((ref: any) => ref.type === 'user_content_approval');
  });
  requireResult(matchingApprovals.length === 1, 'weekly_production_approval_ambiguous');
  const approval = matchingApprovals[0]!;
  const acceptedTask = object(approval.payload) as WeeklyExecutionTask;
  const { resolveWeeklyCreativeRepairApprovalEvidence } = await import('../socialPrograms/weeklyCreativeRepairApprovalEvidence.js');
  const creativeRepair = await resolveWeeklyCreativeRepairApprovalEvidence(store, task);
  if (creativeRepair) requireResult(creativeRepair.caseItem.approvalTaskId === acceptedTask.taskId && !acceptedTask.ownBlockingReasons.length, 'weekly_creative_repair_approval_scope_changed');
  if (acceptedTask.inputSnapshot?.inventoryReuseRef) {
    const { validateInventoryUserApproval } = await import('./weeklyInventoryApprovalEvidence.js');
    await validateInventoryUserApproval(store, acceptedTask, acceptedTask.resultRefs);
    const { createWeeklyInventoryReuseService } = await import('../socialPrograms/weeklyInventoryReuse.js');
    const current = await createWeeklyInventoryReuseService(store).readVerifiedBinding(task);
    requireResult(!assignmentProductionId || current.item.source.productionResultId === assignmentProductionId, 'inventory_assignment_production_changed');
    return;
  }
  const artifactRef = object(approval.payload).resultRefs.find((ref: any) => ref.type === 'starter_social_content_artifact') as VersionedSocialRef | undefined;
  requireResult(artifactRef && Number.isSafeInteger(artifactRef.version) && artifactRef.version > 0);
  const artifact = await unique(store, 'starter_social_content_artifacts', { tenant_id: task.tenantId, artifact_id: artifactRef.id });
  requireResult(artifact.status === 'approved' && text(object(artifact.content).productionResult?.productionResultId) && (!assignmentProductionId || object(artifact.content).productionResult.productionResultId === assignmentProductionId));
  await validateContentArtifact(store, { ...task, workflowKind: 'content', schedule: { ...task.schedule, stepKind: 'quality_check' } }, artifactRef);
}
