import { createHash } from 'node:crypto';
import { INITIAL_CAPACITY_SCHEDULE_REQUIRED } from './weeklyInitialScheduleGate.js';
import { applyPublicationDeadlines, publicationInstant } from './publicationDeadlines.js';
import { SocialProgramError } from './service.js';
import { allocateWeeklyReferenceSources } from './weeklyReferenceSources.js';
import { weeklyReviewWindowBounds } from '../socialReview/weeklyReviewTiming.js';
import { WEEKLY_AUTOMATION_TEMPLATE } from '../../shared/weeklyAutomationTemplate.js';
import { applySharedMaterialPreparation, dailyRollingStart, preproductionLocalDate, publicationLocalDate, rollingDayForItems, shareOriginalProductionGraph } from './weeklyExecutionGraph.js';
import type {
  SocialWeeklyPublicationTask, VersionedSocialRef, WeeklyExecutionTask, WeeklyOperatingPackage,
  WeeklyProductionStepKind, WeeklyResponsibleActor, WeeklyAgentChainProfile,
  WeeklyAgentChainTaskCode, WeeklyAgentChainContract,
} from '../../shared/contracts/socialProgram.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const taskId = (key: string) => `wet_${hash(key).slice(0, 24)}`;
const moneyShare = (total: number | null, count: number): number | null => (
  total === null || count < 1 ? null : Math.round((total / count) * 100) / 100
);

function authorityRefs(pkg: WeeklyOperatingPackage): VersionedSocialRef[] {
  return [
    pkg.enterpriseProfileRef,
    pkg.businessContentGoalRef ?? null,
    pkg.monthlyPlanRef,
    pkg.capacityPlanRef,
    pkg.automationPolicyRef,
  ].filter((ref): ref is VersionedSocialRef => Boolean(ref));
}

type TaskSeed = Pick<WeeklyExecutionTask,
  'workflowKind' | 'scope' | 'subjectId' | 'accountId' | 'publicationTaskId'
  | 'dependsOnTaskIds' | 'inputSnapshot' | 'budget' | 'ownBlockingReasons'> & {
    stepKind: WeeklyProductionStepKind;
    responsibleActor: WeeklyResponsibleActor;
    estimatedDurationMinutes: number;
    notBeforeAt?: number | null;
  };

const MAIN_CHAIN_BY_STEP: Record<WeeklyProductionStepKind, number> = {
  business_outline:1, benchmark_collection:2, benchmark_scoring:2, director_analysis:2,
  business_schedule:3, material_preparation:4, material_readiness:4, script:4, storyboard:4,
  asset_generation:5, video_generation:5, quality_check:5, rework:5, user_approval:5,
  publishing:6, customer_channel_readiness:7, customer_inquiry_handoff:7, performance_monitoring:8, weekly_review:8,
  template_extraction:8, template_performance_validation:8,
};

const SIDE_CHAIN_BY_STEP: Partial<Record<WeeklyProductionStepKind, number[]>> = {
  business_outline:[2], business_schedule:[8], material_preparation:[1], material_readiness:[2],
  quality_check:[3], rework:[3], publishing:[4], customer_channel_readiness:[2], customer_inquiry_handoff:[7], performance_monitoring:[5,7],
  template_extraction:[6], template_performance_validation:[9], weekly_review:[9],
};

function chainIdentity(pkg:WeeklyOperatingPackage,seed:TaskSeed):{
  chainProfile?:WeeklyAgentChainProfile;chainTaskCode?:WeeklyAgentChainTaskCode;
  chainSupportTaskCodes?:WeeklyAgentChainTaskCode[];chainContract?:WeeklyAgentChainContract;
}{
  const profile=pkg.referenceSourcePolicy?.profile;if(!profile)return {};
  const prefix=profile==='b2b_cold_start'?'Z':'H';
  const source=seed.inputSnapshot.referenceSource;
  const route=profile==='b2b_cold_start'?'external_cold_start':source==='owned'?'owned_history_iteration':source==='external'?'external_incremental_exploration':'mixed_history_and_external';
  const taskCode=`${prefix}-M${MAIN_CHAIN_BY_STEP[seed.stepKind]}` as WeeklyAgentChainTaskCode;
  const chainSupportTaskCodes=(SIDE_CHAIN_BY_STEP[seed.stepKind]??[]).map(index=>`${prefix}-S${index}` as WeeklyAgentChainTaskCode);
  const commonInputs=['frozen_weekly_package','verified_enterprise_facts','confirmed_schedule_scope'];
  const commonOutputs:[string,string]=[`verified_${seed.stepKind}_receipt`,`profile_route:${route}`];
  if(['customer_channel_readiness','customer_inquiry_handoff'].includes(seed.stepKind))return {
    chainProfile:profile,chainTaskCode:taskCode,chainSupportTaskCodes,
    chainContract:{
      requiredInputKinds:['channel_authorization','customer_runtime_binding','provider_conversation_identity'],
      deliverableKinds:[...commonOutputs,'continuous_channel_observation','customer_followup_receipt'],
    },
  };
  const requiredInputKinds=profile==='b2b_cold_start'
    ?[...commonInputs,'external_reference_evidence','first_week_baseline_gap']
    :[...commonInputs,'historical_account_baseline','confirmed_owned_external_quota',source==='owned'?'owned_video_metrics_and_tone':'external_reference_evidence'];
  const deliverableKinds=profile==='b2b_cold_start'
    ?[...commonOutputs,'cold_start_enterprise_expression']
    :[...commonOutputs,source==='owned'?'tone_preserving_iteration':'brand_adapted_exploration'];
  return {chainProfile:profile,chainTaskCode:taskCode,chainSupportTaskCodes,chainContract:{requiredInputKinds,deliverableKinds}};
}

function makeTask(tenantId: string, pkg: WeeklyOperatingPackage, seed: TaskSeed, createdAt: string, estimatedStartAt: string): WeeklyExecutionTask {
  const idempotencyKey = hash([
    tenantId, pkg.packageId, pkg.version, seed.workflowKind, seed.scope, seed.subjectId, seed.stepKind,
  ].join(':'));
  const duration = Math.max(1, Math.floor(seed.estimatedDurationMinutes));
  const estimatedFinishAt = new Date(Date.parse(estimatedStartAt) + duration * 60_000).toISOString();
  const publication = pkg.socialContentPackage.publicationTasks.find(item => item.publicationTaskId === seed.publicationTaskId);
  const customerWork = ['customer_channel_readiness','customer_inquiry_handoff'].includes(seed.stepKind);
  const calendarAssignmentDate = typeof seed.inputSnapshot.rollingDate === 'string'
    ? seed.inputSnapshot.rollingDate
    : ['weekly_review','template_extraction','template_performance_validation'].includes(seed.stepKind)
      ? pkg.weekEnd
      : publication
        ? customerWork ? preproductionLocalDate(publication,pkg) : publicationLocalDate(publication)
        : pkg.weekStart;
  return {
    taskId: taskId(idempotencyKey),
    tenantId,
    programId: pkg.programId,
    packageId: pkg.packageId,
    packageVersion: pkg.version,
    workflowKind: seed.workflowKind,
    scope: seed.scope,
    subjectId: seed.subjectId,
    accountId: seed.accountId,
    publicationTaskId: seed.publicationTaskId,
    ...chainIdentity(pkg,seed),
    dependsOnTaskIds: seed.dependsOnTaskIds,
    upstreamVersionRefs: authorityRefs(pkg),
    inputSnapshot: structuredClone({ ...seed.inputSnapshot, calendarAssignmentDate, referenceSourcePolicy: pkg.referenceSourcePolicy ?? null }),
    idempotencyKey,
    budget: seed.budget,
    schedule: {
      stepKind: seed.stepKind,
      responsibleActor: seed.responsibleActor,
      estimatedDurationMinutes: duration,
      estimatedStartAt,
      estimatedFinishAt,
      actualStartedAt: null,
      actualFinishedAt: null,
    },
    status: 'pending_activation',
    ownBlockingReasons: [...new Set([...seed.ownBlockingReasons,...((pkg.executionGraphVersion??1)>=2&&seed.publicationTaskId&&(seed.workflowKind==='content'||['script','storyboard'].includes(seed.stepKind))?[INITIAL_CAPACITY_SCHEDULE_REQUIRED]:[])])],
    inheritedBlockingTaskIds: [],
    attempt: 0,
    maxAttempts: 3,
    nextAttemptAt: null,
    lease: null,
    resultRefs: [],
    lastError: null,
    recoveredFromDeadLetterAt: null,
    cancelReason: null,
    createdAt,
    updatedAt: createdAt,
  };
}

function publicationBlockers(item: SocialWeeklyPublicationTask): string[] {
  return [
    !item.businessProposition ? 'business_proposition_required' : null,
    !item.cta ? 'cta_required' : null,
    !item.factRefs.length ? 'fact_refs_required' : null,
    !item.metricTargets.length ? 'metric_targets_required' : null,
    !item.publishWindow ? 'publish_window_required' : null,
  ].filter((value): value is string => Boolean(value));
}

/** Convert the seven package summaries into independently durable units. */
export function planWeeklyExecutionTasks(
  tenantId: string,
  pkg: WeeklyOperatingPackage,
  createdAt = new Date().toISOString(),
): WeeklyExecutionTask[] {
  const tasks: WeeklyExecutionTask[] = [];
  const publications = pkg.socialContentPackage.publicationTasks;
  const publicationIds = new Set(publications.map(item => item.publicationTaskId));
  const deferredOutboundGoalBlockers=new Set(['g2:conversion_route_required','g2:sales_owner_required','g2:account_required']);
  const globalBlockers = pkg.planningBlockers.filter(blocker => ![...publicationIds].some(id => blocker.includes(id))&&!deferredOutboundGoalBlockers.has(blocker));
  const add = (seed: TaskSeed) => {
    const dependencyFinishes = seed.dependsOnTaskIds.map(id => tasks.find(item => item.taskId === id)?.schedule.estimatedFinishAt).filter((value): value is string => Boolean(value));
    // Preparation can belong to the preceding week; publication has its own release time.
    const estimatedStartAt = new Date(Math.max(Date.parse(createdAt), ...dependencyFinishes.map(value => Date.parse(value)), seed.notBeforeAt ?? 0)).toISOString();
    const item = makeTask(tenantId, pkg, seed, createdAt, estimatedStartAt);
    tasks.push(item);
    return item;
  };
  const noBudget = { category: 'none' as const, limitCny: null };
  const readiness = add({
    workflowKind: 'readiness', scope: 'package', subjectId: pkg.packageId,
    accountId: null, publicationTaskId: null, dependsOnTaskIds: [],
    inputSnapshot: { weekStart: pkg.weekStart, weekEnd: pkg.weekEnd, objective: pkg.objective },
    budget: noBudget, ownBlockingReasons: globalBlockers,
    stepKind: 'business_outline', responsibleActor: 'business_agent', estimatedDurationMinutes: 15,
  });

  const accountIds = [...new Set(publications.map(item => item.accountId))];
  const sourceAllocation = allocateWeeklyReferenceSources(publications.filter(p=>!p.inventoryReuseRef), pkg.referenceSourcePolicy);
  // Owned-history mothers consume verified account metrics directly. A
  // collection task with no external consumer is an unbounded paid leaf and
  // cannot acquire a meaningful publication deadline or capacity slot.
  const discoveryKeys = [...new Set(publications.filter(item => !item.inventoryReuseRef && sourceAllocation.get(item.motherContentId)!=='owned').map(item => `${item.accountId}:${preproductionLocalDate(item,pkg)}`))];
  const discovery = discoveryKeys.map(key => {
    const separator = key.lastIndexOf(':');
    const accountId = key.slice(0, separator);
    const rollingDate = key.slice(separator + 1);
    const dayPublications = publications.filter(item => item.accountId === accountId && preproductionLocalDate(item,pkg) === rollingDate && !item.inventoryReuseRef && sourceAllocation.get(item.motherContentId)!=='owned');
    return add({
    notBeforeAt: dailyRollingStart(dayPublications),
    workflowKind: 'discovery', scope: 'account', subjectId: `${accountId}:${rollingDate}`,
    accountId, publicationTaskId: null, dependsOnTaskIds: [readiness.taskId],
    inputSnapshot: {
      accountId, weekStart: pkg.weekStart, objective: pkg.objective,
      rollingCadence: 'daily_incremental', rollingDate,
      publicationTaskIds: dayPublications.map(item => item.publicationTaskId),
      deduplication: 'source_identity_and_content_fingerprint',
      freshnessPolicy: 'created_or_updated_since_previous_successful_collection',
    },
    budget: { category: 'discovery', limitCny: moneyShare(pkg.discoveryBudgetCny, discoveryKeys.length) },
    ownBlockingReasons: [],
    stepKind: 'benchmark_collection', responsibleActor: 'director_agent', estimatedDurationMinutes: 60,
  });});

  const byMother = new Map<string, SocialWeeklyPublicationTask[]>();
  for (const item of publications.filter(p=>!p.inventoryReuseRef)) {
    const key = `${item.motherContentId}:${preproductionLocalDate(item,pkg)}`;
    byMother.set(key, [...(byMother.get(key) ?? []), item]);
  }
  const weeklyShare = moneyShare(pkg.socialContentPackage.weeklyBudgetCny, publications.filter(p=>!p.inventoryReuseRef).length);
  const configuredPerItem = pkg.socialContentPackage.perItemBudgetCny;
  if (configuredPerItem !== null && configuredPerItem !== undefined && (!Number.isFinite(configuredPerItem) || configuredPerItem < 0))
    throw new SocialProgramError('weekly_production_item_budget_invalid', 409, '单条生产预算无效。');
  // The weekly ceiling is not permission to spend its average on one film.
  const productionBudget = weeklyShare === null ? null : Math.min(weeklyShare, configuredPerItem ?? WEEKLY_AUTOMATION_TEMPLATE.perFinishedVideoMaxCny, WEEKLY_AUTOMATION_TEMPLATE.perFinishedVideoMaxCny);
  const directingByMother = new Map<string, WeeklyExecutionTask>();
  const scheduleByMother = new Map<string, WeeklyExecutionTask>();
  const storyboardByPublication = new Map<string, WeeklyExecutionTask>();
  for (const [motherDayKey, items] of byMother) {
    const motherContentId = items[0]!.motherContentId;
    const referenceSource=sourceAllocation.get(motherContentId);
    const rollingDate = rollingDayForItems(items,pkg);
    const scoring = add({
      notBeforeAt: dailyRollingStart(items),
      workflowKind: 'directing', scope: 'content', subjectId: `${motherContentId}:${rollingDate}:benchmark-scoring`,
      accountId: null, publicationTaskId: null,
      dependsOnTaskIds: referenceSource === 'owned' ? [readiness.taskId] : discovery.filter(task => task.inputSnapshot.rollingDate === rollingDate && items.some(item => item.accountId === task.accountId)).map(task => task.taskId),
      inputSnapshot: { motherContentId, referenceSource, rollingCadence: 'daily_incremental', rollingDate, referenceWork: referenceSource === 'owned' ? 'owned_history_metrics_diagnosis' : 'external_benchmark_scoring', candidatePolicy: 'server_score_required' }, budget: noBudget,
      ownBlockingReasons: [], stepKind: 'benchmark_scoring', responsibleActor: 'director_agent', estimatedDurationMinutes: 20,
    });
    const directing = add({
      workflowKind: 'directing', scope: 'content', subjectId: `${motherContentId}:${rollingDate}`,
      accountId: null, publicationTaskId: null, dependsOnTaskIds: [scoring.taskId],
      inputSnapshot: { motherContentId, referenceSource, rollingCadence: 'daily_incremental', rollingDate, referenceWork: referenceSource === 'owned' ? 'owned_tone_inheritance' : 'external_structure_adaptation', variants: items }, budget: noBudget,
      ownBlockingReasons: [...new Set(items.flatMap(publicationBlockers))],
      stepKind: 'director_analysis', responsibleActor: 'director_agent', estimatedDurationMinutes: 45,
    });
    directingByMother.set(motherDayKey, directing);
    scheduleByMother.set(motherDayKey, add({
      workflowKind: 'directing', scope: 'content', subjectId: `${motherContentId}:${rollingDate}:business-schedule`,
      accountId: null, publicationTaskId: null, dependsOnTaskIds: [directing.taskId],
      inputSnapshot: { motherContentId, referenceSource, directorTaskId: directing.taskId, rollingCadence: 'daily_incremental', rollingDate, decisionScope: 'today_content_theme', variants: items }, budget: noBudget,
      ownBlockingReasons: [], stepKind: 'business_schedule', responsibleActor: 'business_agent', estimatedDurationMinutes: 15,
    }));
    items.forEach(item => {
      const mode = item.adaptationOfPublicationTaskId === null ? 'original' : 'adaptation';
      const scope = mode === 'original' ? 'content' as const : 'adaptation' as const;
      const base = `${item.publicationTaskId}:${mode}`;
      const preparation = (pkg.executionGraphVersion??1)>=2 ? add({
        workflowKind:'content',scope,subjectId:`${base}:material-preparation`,accountId:item.accountId,publicationTaskId:item.publicationTaskId,
        dependsOnTaskIds:[readiness.taskId],
        inputSnapshot:{publicationTask:item,motherContentId,mode,referenceSource},budget:noBudget,ownBlockingReasons:[],
        stepKind:'material_preparation',responsibleActor:'content_agent',estimatedDurationMinutes:20,
      }):null;
      const script = add({
        workflowKind: 'directing', scope, subjectId: `${base}:script`, accountId: item.accountId, publicationTaskId: item.publicationTaskId,
        dependsOnTaskIds: [scheduleByMother.get(motherDayKey)!.taskId, ...(preparation ? [preparation.taskId] : [])],
        inputSnapshot: { publicationTask: item, motherContentId, mode, referenceSource, source: 'director_analysis_and_enterprise_facts' },
        budget: { category: 'production', limitCny: productionBudget }, ownBlockingReasons: [],
        stepKind: 'script', responsibleActor: 'director_agent', estimatedDurationMinutes: 30,
      });
      const storyboard = add({
        workflowKind: 'directing', scope, subjectId: `${base}:storyboard`, accountId: item.accountId, publicationTaskId: item.publicationTaskId,
        dependsOnTaskIds: [script.taskId], inputSnapshot: { publicationTask: item, motherContentId, mode, referenceSource }, budget: noBudget, ownBlockingReasons: [],
        stepKind: 'storyboard', responsibleActor: 'director_agent', estimatedDurationMinutes: 35,
      });
      storyboardByPublication.set(item.publicationTaskId, storyboard);
    });

  }

  const approvalByPublication = new Map<string, WeeklyExecutionTask>();
  for (const [motherDayKey, items] of byMother) {
    const motherContentId = items[0]!.motherContentId;
    const referenceSource=sourceAllocation.get(motherContentId);
    const original = items.find(item => item.adaptationOfPublicationTaskId === null) ?? items[0]!;
    let originalQualityTask: WeeklyExecutionTask | null = null;
    for (const item of [original, ...items.filter(candidate => candidate.publicationTaskId !== original.publicationTaskId)]) {
      const mode = item.publicationTaskId === original.publicationTaskId ? 'original' : 'adaptation';
      const scope = mode === 'original' ? 'content' as const : 'adaptation' as const;
      const base = `${item.publicationTaskId}:${mode}`;
      const storyboard = storyboardByPublication.get(item.publicationTaskId)!;
      const material = add({
        workflowKind: 'content', scope, subjectId: `${base}:material-readiness`, accountId: item.accountId, publicationTaskId: item.publicationTaskId,
        dependsOnTaskIds: [scheduleByMother.get(motherDayKey)!.taskId, storyboard.taskId, ...(mode === 'adaptation' && originalQualityTask ? [originalQualityTask.taskId] : [])],
        inputSnapshot: { publicationTask: item, motherContentId, mode, referenceSource, qualityTier: 'premium' },
        budget: noBudget, ownBlockingReasons: ['business_dispatch_required'],
        stepKind: 'material_readiness', responsibleActor: 'content_agent', estimatedDurationMinutes: 20,
      });
      const assets = add({
        workflowKind: 'content', scope, subjectId: `${base}:asset-generation`, accountId: item.accountId, publicationTaskId: item.publicationTaskId,
        dependsOnTaskIds: [material.taskId], inputSnapshot: { publicationTask: item, motherContentId, mode, referenceSource, generationPolicy: 'premium_max_available' },
        budget: { category: 'production', limitCny: productionBudget }, ownBlockingReasons: [],
        stepKind: 'asset_generation', responsibleActor: 'content_agent', estimatedDurationMinutes: 45,
      });
      const video = add({
        workflowKind: 'content', scope, subjectId: `${base}:video-generation`, accountId: item.accountId, publicationTaskId: item.publicationTaskId,
        dependsOnTaskIds: [assets.taskId], inputSnapshot: { publicationTask: item, motherContentId, mode, referenceSource, qualityTier: 'premium' },
        budget: { category: 'production', limitCny: productionBudget }, ownBlockingReasons: [],
        stepKind: 'video_generation', responsibleActor: 'content_agent', estimatedDurationMinutes: 90,
      });
      const quality = add({
        workflowKind: 'content', scope, subjectId: `${base}:quality-check`, accountId: item.accountId, publicationTaskId: item.publicationTaskId,
        dependsOnTaskIds: [video.taskId], inputSnapshot: { publicationTask: item, motherContentId, referenceSource, checks: ['facts', 'visual', 'audio', 'rights', 'platform'] }, budget: noBudget, ownBlockingReasons: [],
        stepKind: 'quality_check', responsibleActor: 'quality_agent', estimatedDurationMinutes: 25,
      });
      const approvalDependency = pkg.executionGraphVersion===3 ? quality : add({
        workflowKind: 'content', scope, subjectId: `${base}:rework`, accountId: item.accountId, publicationTaskId: item.publicationTaskId,
        dependsOnTaskIds: [quality.taskId], inputSnapshot: { publicationTask: item, motherContentId, referenceSource, conditional: true }, budget: { category: 'production', limitCny: productionBudget }, ownBlockingReasons: [],
        stepKind: 'rework', responsibleActor: 'content_agent', estimatedDurationMinutes: 30,
      });
      const approval = add({
        workflowKind: 'content', scope, subjectId: `${base}:user-approval`, accountId: item.accountId, publicationTaskId: item.publicationTaskId,
        dependsOnTaskIds: [approvalDependency.taskId], inputSnapshot: { publicationTask: item, motherContentId, referenceSource, decisionCard: 'content_approval' }, budget: noBudget, ownBlockingReasons: [],
        stepKind: 'user_approval', responsibleActor: 'user', estimatedDurationMinutes: 10,
      });
      if (mode === 'original') originalQualityTask = approvalDependency;
      approvalByPublication.set(item.publicationTaskId, approval);
    }
  }

  for(const item of publications.filter(p=>p.inventoryReuseRef)){
    const ref=item.inventoryReuseRef!;
    if(pkg.referenceSourcePolicy?.profile!=='b2b_established'||ref.type!=='weekly_inventory_binding'||ref.version!==1||!ref.id)throw new SocialProgramError('inventory_execution_ref_invalid',409,'库存任务必须绑定已确认的有基础周版本。');
    const approval=add({workflowKind:'content',scope:'content',subjectId:`${item.publicationTaskId}:inventory-user-approval`,accountId:item.accountId,publicationTaskId:item.publicationTaskId,dependsOnTaskIds:[readiness.taskId],inputSnapshot:{publicationTask:item,decisionCard:'content_approval',inventoryReuseRef:ref,countsAsNewMotherContent:false,startsProduction:false},budget:noBudget,ownBlockingReasons:[],stepKind:'user_approval',responsibleActor:'user',estimatedDurationMinutes:10});
    approvalByPublication.set(item.publicationTaskId,approval);
  }

  const publishing = publications.map(item => add({
    notBeforeAt: publicationInstant(item.publishWindow),
    workflowKind: 'publishing', scope: 'publication', subjectId: item.publicationTaskId,
    accountId: item.accountId, publicationTaskId: item.publicationTaskId,
    dependsOnTaskIds: [approvalByPublication.get(item.publicationTaskId)!.taskId],
    inputSnapshot: {
      publicationTask: item,
      referenceSource: sourceAllocation.get(item.motherContentId),
      authorization: pkg.socialContentPackage.authorization,
    },
    budget: noBudget, ownBlockingReasons: publicationBlockers(item),
    stepKind: 'publishing', responsibleActor: 'publishing_agent', estimatedDurationMinutes: 10,
  }));

  const customerChannels = ['whatsapp', 'messenger', 'instagram'] as const;
  const customerReadiness = new Map<string, WeeklyExecutionTask[]>();
  for (const item of publications) {
    const tasksForPublication = customerChannels.map(channel => add({
      workflowKind: 'engagement', scope: 'publication',
      subjectId: `${item.publicationTaskId}:customer:${channel}:readiness`,
      accountId: item.accountId, publicationTaskId: item.publicationTaskId,
      // Channel observation is an always-on customer-service capability. It
      // must not wait for directing, content production, approval or publish.
      dependsOnTaskIds: [],
      inputSnapshot: { publicationTask: item, referenceSource: sourceAllocation.get(item.motherContentId), customerChannel: channel, publicationAccountId: item.accountId },
      budget: noBudget, ownBlockingReasons: [],
      stepKind: 'customer_channel_readiness', responsibleActor: 'customer_agent', estimatedDurationMinutes: 10,
    }));
    customerReadiness.set(item.publicationTaskId, tasksForPublication);
  }

  const customerHandoffs = publications.flatMap(item => {
    return customerChannels.map(channel => {
      const readiness = customerReadiness.get(item.publicationTaskId)!.find(task => task.inputSnapshot.customerChannel === channel)!;
      return add({
        workflowKind: 'engagement', scope: 'publication',
        subjectId: `${item.publicationTaskId}:customer:${channel}:handoff`,
        accountId: item.accountId, publicationTaskId: item.publicationTaskId,
        // Inquiry intake follows only the same channel's readiness. Published
        // content may provide attribution context, but is not an execution
        // prerequisite for monitoring and responding to inbound messages.
        dependsOnTaskIds: [readiness.taskId],
        inputSnapshot: { publicationTask: item, referenceSource: sourceAllocation.get(item.motherContentId), customerChannel: channel, publicationAccountId: item.accountId },
        budget: noBudget, ownBlockingReasons: [],
        stepKind: 'customer_inquiry_handoff', responsibleActor: 'customer_agent', estimatedDurationMinutes: 30,
      });
    });
  });

  const engagement = publications.map(publication => add({
    workflowKind: 'engagement', scope: 'publication', subjectId: `${publication.publicationTaskId}:daily-feedback`,
    accountId: publication.accountId, publicationTaskId: publication.publicationTaskId,
    dependsOnTaskIds: [publishing.find(item => item.publicationTaskId === publication.publicationTaskId)!.taskId],
    inputSnapshot: { accountId: publication.accountId, publicationTaskId: publication.publicationTaskId, rollingCadence: 'daily_feedback', rollingDate: publicationLocalDate(publication), feedsNextDailyCollection: true, weekStart: pkg.weekStart, weekEnd: pkg.weekEnd, profileWork: pkg.referenceSourcePolicy?.profile==='b2b_established'?'existing_customer_and_dual_source_attribution':'new_inquiry_and_first_baseline_attribution' },
    budget: noBudget, ownBlockingReasons: [],
    stepKind: 'performance_monitoring', responsibleActor: 'business_agent', estimatedDurationMinutes: 30,
  }));
  const reviewWindow = weeklyReviewWindowBounds(pkg);
  const sundayReviewNotBeforeAt = Date.parse(reviewWindow.endsAt);
  const review = add({
    // The card belongs to Sunday evening in the product calendar. Actual
    // execution still waits for every publication and monitoring dependency,
    // so a late data receipt moves the task later instead of fabricating an
    // early completed review.
    notBeforeAt: sundayReviewNotBeforeAt,
    workflowKind: 'review', scope: 'package', subjectId: pkg.packageId,
    accountId: null, publicationTaskId: null,
    dependsOnTaskIds: [...new Set([...publishing.map(item => item.taskId), ...engagement.map(item => item.taskId)])],
    inputSnapshot: {
      objective: pkg.objective,
      successCriteria: pkg.successCriteria,
      reviewWindow,
      waitsForAllWeeklyProductionAndPublishing: true,
      profileWork: pkg.referenceSourcePolicy?.profile==='b2b_established'?'dual_source_performance_and_quota_review':'cold_start_baseline_and_profile_upgrade_review',
    },
    budget: noBudget, ownBlockingReasons: [],
    stepKind: 'weekly_review', responsibleActor: 'business_agent', estimatedDurationMinutes: 45,
  });
  for (const publication of publications.filter(p=>!p.inventoryReuseRef)) {
    const source = tasks.find(task => task.publicationTaskId === publication.publicationTaskId && task.schedule.stepKind === 'video_generation');
    if (!source) throw new SocialProgramError('content_template_source_task_missing', 409, '模板提炼缺少对应真实成片任务。');
    const extraction = add({
      workflowKind: 'directing', scope: 'content', subjectId: `${publication.publicationTaskId}:template-extraction`,
      accountId: publication.accountId, publicationTaskId: publication.publicationTaskId,
      dependsOnTaskIds: [source.taskId, review.taskId],
      inputSnapshot: { publicationTask: publication, referenceSource: sourceAllocation.get(publication.motherContentId), sourceTaskId: source.taskId, reviewTaskId: review.taskId },
      budget: noBudget, ownBlockingReasons: [],
      stepKind: 'template_extraction', responsibleActor: 'director_agent', estimatedDurationMinutes: 20,
    });
    add({
      workflowKind: 'review', scope: 'content', subjectId: `${publication.publicationTaskId}:template-performance-validation`,
      accountId: publication.accountId, publicationTaskId: publication.publicationTaskId,
      dependsOnTaskIds: [extraction.taskId],
      inputSnapshot: { publicationTask: publication, referenceSource: sourceAllocation.get(publication.motherContentId), sourceTaskId: source.taskId, reviewTaskId: review.taskId, extractionTaskId: extraction.taskId },
      budget: noBudget, ownBlockingReasons: [],
      stepKind: 'template_performance_validation', responsibleActor: 'business_agent', estimatedDurationMinutes: 15,
    });
  }
  // Legacy immutable graphs have no preparation stage; retain their original
  // dependencies until an explicit revision upgrades them to the current graph.
  const productionTasks=shareOriginalProductionGraph(pkg,tasks);
  if((pkg.executionGraphVersion??1)>=2)applySharedMaterialPreparation(productionTasks,publications.filter(pub=>pkg.socialContentPackage.productionIdentityVersion!=='shared-original.v1'||pub.inventoryReuseRef||!pub.adaptationOfPublicationTaskId));
  return applyPublicationDeadlines(productionTasks, publications);
}
