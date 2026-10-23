/** 面试阅读注释：核心考核文件：周任务与内容生产的桥接。先核验冻结范围和来源，再创建/恢复原任务。已有run不等于已有可验收产物；不要删除准入校验来让状态变绿。 */
import {readWeeklyProductionStartAttempt} from './weeklyProductionStartAttempt.js';
import {readWeeklyAutomationTemplate} from '../socialPrograms/weeklyAutomationTemplate.js';
import {assessWeeklyOwnedProductIdentity,type WeeklyOwnedProductIdentityPorts} from './weeklyOwnedProductIdentityDemand.js';
import {createExactShotMaterializationService} from '../lib/referenceExactShotMaterialization.js';
import { weeklyProductionAdmissionMessage } from './weeklyProductionAdmissionMessage.js';
import {ensureOriginalSocialContentProductionQueued} from '../starter198/socialContentOriginalRunQueueRecovery.js';
import {readWeeklyReferenceSources,weeklyReferenceResolver,assertWeeklyReferenceBindings} from './socialWeeklyReferenceSource.js';
import {readVerifiedNoSharedMaterialDemand,freezeOriginalRunMaterialDemand} from './socialWeeklyOriginalRunMaterialDemand.js';
import {publicationPreparationDeadline} from '../socialPrograms/publicationDeadlines.js';
import {assertWeeklyProductionCoverage} from './weeklyProductionCoverageAdmission.js';
import {readWeeklyTemplateStructure} from '../socialPrograms/weeklyTemplateStructure.js';
import { checkWeeklyMaterialClassification, checkWeeklyHumanRequirementBindings } from './socialWeeklyMaterialClassificationAdmission.js';
import { withWeeklyProductionAdmissionGuard } from '../socialPrograms/weeklyCancellation.js';
import type { DataStore } from '../storage/datastore.js';
import type { WeeklyExecutionTask, VersionedSocialRef, WeeklyOperatingPackage } from '../../shared/contracts/socialProgram.js';
import type { SocialContentTaskDetail, CreateSocialContentTaskInput } from '../../shared/contracts/socialContentWorkflow.js';
import { createStarter198Repository, STARTER_COLLECTIONS, type Starter198Repository } from '../starter198/repository.js';
import { addSocialTaskSource, createSocialContentTask, startSocialContentTask } from '../starter198/socialContentTasks.js';
import { readSocialTaskDetail } from '../starter198/socialContentRecords.js';
import { createStarter198OrchestratorQueue } from '../starter198/orchestratorQueue.js';
import { bindWeeklyProductionAuthority, persistWeeklyProductionResultAuthority } from './socialWeeklyProductionAuthority.js';
import { socialJson, socialObject, socialRequestHash } from '../starter198/socialContentValidation.js';
import { readContentExecutionJob } from '../contentExecution/durableQueue.js';
import { createSocialOperatingRepository } from '../socialOperating/repository.js';
import { createWeeklyPlanningAuthority } from '../socialPrograms/planningAuthority.js';
import { readWeeklyAutomaticProductionIntent, readWeeklyAutomaticProductionCapacity } from '../socialPrograms/weeklyAutomaticProductionPlanning.js';
import { weeklyPlanningExecutionActor } from '../socialPrograms/weeklyPlanningTemplateAdoption.js';
import { PACKAGES, type PackageRow } from '../socialPrograms/weeklyOperatingPackageSupport.js';
import type { SocialWeeklyExecutionAdapter, WeeklyExecutionAdapterResult } from './socialWeeklyExecutionAdapter.js';
import { weeklyScriptEvidence } from './socialWeeklyScriptEvidence.js';
import { createWeeklyRequiredMaterialAdmission, type WeeklyRequiredMaterialAdmissionInput, type WeeklyRequiredMaterialAdmission } from '../socialPrograms/weeklyRequiredMaterialAdmission.js';
import { socialContentSourceOptions, type SocialContentSourceOptionsPort } from '../starter198/socialContentSourceOptions.js';
import { getOwnedCloudMaterialRecord } from '../lib/cloudMaterials.js';
import { buildNoSharedMaterialDemand, verifiedNoSharedMaterialDemand } from './socialWeeklyMaterialDemand.js';
import { createHash } from 'node:crypto';
import { weeklyStoryboardStageEvidence } from './socialWeeklyStoryboardEvidence.js';
import {resolveWeeklyProductionRow,canonicalWeeklyProductionPublication,weeklyProductionEvidenceTask,persistWeeklySharedProductionBindings,currentSharedWeeklyArtifactRef,assertWeeklySharedProductionGroupUnsplit} from './weeklyContentProductionIdentity.js';
import {registerSocialContentWeeklyPlan} from '../starter198/socialContentOrderPlanning.js';
import {requireWeeklyPublicationProductSelection,type WeeklyPublicationProductSelection} from '../socialPrograms/weeklyPublicationProductSelection.js';
import {readWeeklySamplePolicyEvidence} from '../socialPrograms/weeklySamplePolicyEvidence.js';
import {readWeeklyOriginalRunSettlementProof} from './weeklyOriginalRunSettlementProof.js';

export const WEEKLY_PRODUCTION_STEPS = ['material_preparation', 'material_readiness', 'script', 'storyboard', 'asset_generation', 'video_generation', 'quality_check', 'rework'] as const;
export function weeklyProductionBindingKey(task: Pick<WeeklyExecutionTask, 'packageId' | 'packageVersion' | 'publicationTaskId'>): string {
  return `weekly-production:${task.packageId}:${task.packageVersion}:${task.publicationTaskId}`;
}

/** The creation receipt is the durable binding; recovery never guesses by title or account. */
export async function findWeeklyProductionTask(dataStore: DataStore, task: WeeklyExecutionTask): Promise<SocialContentTaskDetail | null> {
  const repository = createStarter198Repository(dataStore);
  if(!task.publicationTaskId)return null;
  const row=await resolveWeeklyProductionRow(dataStore,{tenantId:task.tenantId,programId:task.programId,packageId:task.packageId,packageVersion:task.packageVersion,publicationTaskId:task.publicationTaskId});
  const taskId = row?.task_id;
  return typeof taskId === 'string' ? readSocialTaskDetail({ repository, tenantId: task.tenantId, taskId }) : null;
}

export interface WeeklyProductionPorts {
  repository?: Starter198Repository;
  ownedProductIdentity?:Omit<WeeklyOwnedProductIdentityPorts,'repository'>;
  create?: typeof createSocialContentTask;
  start?: typeof startSocialContentTask;
  read?: typeof readSocialTaskDetail;
  addSource?:typeof addSocialTaskSource;
  sourceOptions?:SocialContentSourceOptionsPort;
  materialRecord?:typeof getOwnedCloudMaterialRecord;
  materialAdmission?:(input:WeeklyRequiredMaterialAdmissionInput)=>Promise<WeeklyRequiredMaterialAdmission>;
  bindAuthority?: typeof bindWeeklyProductionAuthority;
  persistResultAuthority?: typeof persistWeeklyProductionResultAuthority;
  orchestratorQueue?: Parameters<typeof startSocialContentTask>[0]['orchestratorQueue'];
  /** Shared scan clock for lease and continuation authorization checks. */
  now?: () => Date;
}
/** Explicit customer evidence promises cannot be replaced by an automatic visual plan. */
export function requiresFrozenHumanMaterialContract(requirements: string[]): boolean {
  return requirements.some(requirement => /不可替代|真人|客户实证|必须.{0,24}(?:实拍|真实客户|工厂证据|产品实证)|(?:实拍|客户证据).{0,12}(?:必须|必需)/.test(requirement));
}
const blocked = (code: string, message: string): WeeklyExecutionAdapterResult => ({ status: 'blocked', code, message });
const pending = (code: string, message: string): Extract<WeeklyExecutionAdapterResult, { status: 'pending' }> => ({ status: 'pending', code, message, retryDelayMs: 15_000 });
function version(value: string): number | null {
  const parsed = Number(value.replace(/^v/, ''));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
function success(ref: VersionedSocialRef): WeeklyExecutionAdapterResult { return { status: 'succeeded', resultRefs: [ref] }; }

/**
 * New source mutations are scoped to the content task because the operation
 * ledger is tenant-wide and different weekly videos may legitimately reuse
 * the same frozen source version. A persisted legacy operation remains the
 * replay authority only for the task it originally targeted; addSource still
 * validates its operation and request hash before recovering it.
 */
export async function weeklySourceBindingIdempotencyKey(input: {
  repository: Starter198Repository;
  tenantId: string;
  taskId: string;
  legacyKey: string;
}): Promise<string> {
  const legacy = await input.repository.list(STARTER_COLLECTIONS.socialContentOperations, input.tenantId, {
    where: { idempotency_key: input.legacyKey }, perPage: 2,
  });
  if (legacy.totalItems === 1 && legacy.items.length === 1
    && legacy.items[0]?.operation === 'add_social_task_source'
    && legacy.items[0]?.target_id === input.taskId) return input.legacyKey;
  return `${input.legacyKey}:task:${input.taskId}`;
}

/** Admission uses the same guarded starter command and durable provider queue as the content workbench. */
export function createSocialWeeklyProductionAdapter(dataStore: DataStore, ports: WeeklyProductionPorts = {}): SocialWeeklyExecutionAdapter {
  const repository = ports.repository ?? createStarter198Repository(dataStore);
  const create = ports.create ?? createSocialContentTask;
  const start = ports.start ?? startSocialContentTask;
  const read = ports.read ?? readSocialTaskDetail;
  const materialAdmission=ports.materialAdmission??createWeeklyRequiredMaterialAdmission(dataStore,ports.ownedProductIdentity?.materialPorts);
  const sourceOptions=ports.sourceOptions??socialContentSourceOptions;
  const addSource=ports.addSource??addSocialTaskSource;
  const orchestratorQueue = ports.orchestratorQueue ?? createStarter198OrchestratorQueue({ repository, dataStore });
  const now = ports.now ?? (() => new Date());
  return { async execute(task: WeeklyExecutionTask): Promise<WeeklyExecutionAdapterResult> {
    if(task.inputSnapshot?.weeklyContinuationPending||task.inputSnapshot?.weeklyContinuationRef)return blocked('weekly_execution_continuation_observation_required','该任务承接已有真实运行，只能由承接适配器观察及结算，禁止新启动生产。');
    // An original quality task may finish graph QA after its natural week.
    // Observe the already-finished run before any admission guard, task/source
    // mutation or queue recovery. This is not a new-week production grant.
    if(['quality_check','rework'].includes(task.schedule.stepKind)){
      const observedAt=now().toISOString();
      const packages=await dataStore.list<PackageRow>(PACKAGES,{where:{tenant_id:task.tenantId,program_id:task.programId,package_id:task.packageId,version:task.packageVersion},perPage:2});
      if(packages.totalItems===1&&packages.items.length===1){
        const original=packages.items[0]!.payload;
        const weekEnd=Date.parse(`${original.weekEnd}T23:59:59.999+08:00`);
        if(Number.isFinite(weekEnd)&&Date.parse(observedAt)>weekEnd){
          const planning=await createWeeklyPlanningAuthority(dataStore).get(task.tenantId,task.programId,task.packageId,task.packageVersion).catch(()=>null);
          if(original.socialContentPackage?.productionIdentityVersion==='shared-original.v1'&&planning?.automaticTemplateAdoption){
          const proof=planning?await readWeeklyOriginalRunSettlementProof({store:dataStore,task,pkg:original,planning,now:observedAt}).catch(()=>null):null;
          if(!proof)return blocked('weekly_original_run_settlement_unverified','原周内容运行、成片与独立质量回执尚不能同源核验；周外禁止新建、重提或重预算。');
          try{
            const {validateWeeklyExecutionResults}=await import('./socialWeeklyResultValidation.js');
            await validateWeeklyExecutionResults(dataStore,task,[proof.artifactRef],new Date(observedAt));
          }catch{return blocked('weekly_original_run_step_unverified','原周成片不满足当前周任务的冻结结果约束；周外不会重新生产。');}
          return success(proof.artifactRef);
          }
        }
      }
    }
    try {
      return await withWeeklyProductionAdmissionGuard({ dataStore, tenantId: task.tenantId, packageId: task.packageId, packageVersion: task.packageVersion, action: async (assertAdmission) => {
    if (!task.publicationTaskId || !WEEKLY_PRODUCTION_STEPS.includes(task.schedule.stepKind as typeof WEEKLY_PRODUCTION_STEPS[number])) {
      return blocked('weekly_production_step_unsupported', '该排期节点没有内容生产执行器。');
    }
    const {readWeeklyCreativeRepairExecutionLineage}=await import('./weeklyCreativeRepairExecutionGraph.js');
    if(readWeeklyCreativeRepairExecutionLineage(task)){const {executeWeeklyCreativeRepairStage}=await import('./weeklyCreativeRepairExecutionAdapter.js');return executeWeeklyCreativeRepairStage({store:dataStore,repository,task,now:now(),ownedProductIdentity:ports.ownedProductIdentity,assertAdmission});}
    const rows = await dataStore.list<PackageRow>(PACKAGES, { where: {
      tenant_id: task.tenantId, program_id: task.programId, package_id: task.packageId, version: task.packageVersion,
    }, perPage: 2 });
    if (rows.totalItems !== 1 || rows.items.length !== 1) return blocked('weekly_package_required', '缺少唯一的冻结周任务包。');
    const pkg = rows.items[0]!.payload;
    if (!pkg || pkg.programId !== task.programId || pkg.packageId !== task.packageId || pkg.version !== task.packageVersion) {
      return blocked('weekly_production_package_scope_invalid', '真实周包内容与当前任务身份不一致，未创建或启动生产。');
    }
    const planning = await createWeeklyPlanningAuthority(dataStore).get(task.tenantId, task.programId, task.packageId, task.packageVersion).catch(() => null);
    pkg.agentPlanning = planning ?? undefined;
    const dispatch = planning?.dispatch;
    const item = dispatch?.scheduleItems.find(item => item.publicationTaskId === task.publicationTaskId);
    const publication = pkg.socialContentPackage.publicationTasks.find(item => item.publicationTaskId === task.publicationTaskId);
    const executionActor = planning ? weeklyPlanningExecutionActor(planning) : null;
    const automatic = planning?.automaticTemplateAdoption && planning.status === 'dispatched' && task.publicationTaskId
      ? await readWeeklyAutomaticProductionIntent(dataStore, { tenantId: task.tenantId, programId: task.programId, packageId: task.packageId, packageVersion: task.packageVersion }, pkg, task.publicationTaskId)
      : null;
    if (!['draft', 'active'].includes(pkg.status) || planning?.status !== 'dispatched' || !executionActor
      || (planning.automaticTemplateAdoption && !automatic)
      || !dispatch || dispatch.packageId !== pkg.packageId || dispatch.packageVersion !== pkg.version || !item || !publication) {
      return blocked('business_dispatch_required', '内容生产需要用户确认后正式派单的冻结排期。');
    }
    try{assertWeeklyProductionCoverage(pkg,planning,task.publicationTaskId!);}catch(error){return blocked(error instanceof Error&&'code' in error?String(error.code):'weekly_production_coverage_invalid','实际确认、派单范围或来源配额不一致，未开始生产。');}
    if (publication.accountId !== task.accountId || item.accountId !== publication.accountId) return blocked('weekly_production_account_mismatch', '排期账号身份不一致。');
    const canonicalPublication=canonicalWeeklyProductionPublication(pkg,publication.publicationTaskId);
    if(canonicalPublication.publicationTaskId!==publication.publicationTaskId){
      // Platform variants observe the original's durable stage; they never
      // launch a second producer or borrow another platform's publish approval.
      const canonicalTask=await weeklyProductionEvidenceTask(dataStore,task);
      if(canonicalTask.status!=='succeeded'||!canonicalTask.resultRefs.length)return pending('weekly_shared_original_stage_pending','等待共享原创视频的对应真实生产节点交付。');
      const production=await resolveWeeklyProductionRow(dataStore,{tenantId:task.tenantId,programId:task.programId,packageId:task.packageId,packageVersion:task.packageVersion,publicationTaskId:publication.publicationTaskId});
      if(!production)return pending('weekly_shared_original_stage_pending','共享原创生产身份尚未建立。');
      await persistWeeklySharedProductionBindings(dataStore,task.tenantId,pkg,production);
      return {status:'succeeded',resultRefs:await Promise.all(canonicalTask.resultRefs.map(ref=>currentSharedWeeklyArtifactRef(dataStore,{tenantId:task.tenantId,programId:task.programId,packageId:task.packageId,packageVersion:task.packageVersion,publicationTaskId:publication.publicationTaskId},ref)))};
    }
    if(automatic){
      const capacity=await readWeeklyAutomaticProductionCapacity(dataStore,{intent:automatic.intent,pkg,planning,task,now:now().toISOString()});
      if(!capacity)return blocked('weekly_automatic_production_capacity_required','自动周生产的冻结容量、当前任务图或队列并发已失效，不能创建内容任务或开始付费执行。');
      if(!capacity.eligible)return pending('weekly_automatic_production_not_yet_eligible','已冻结生产容量，但当前节点尚未进入其计划执行时间。');
    }
    let automaticProductSelection:WeeklyPublicationProductSelection|null=null;
    const readAutomaticProductSelection=()=>requireWeeklyPublicationProductSelection({store:dataStore,tenantId:task.tenantId,programId:task.programId,packageId:task.packageId,packageVersion:task.packageVersion,publication,goal:automatic!.authority.goal});
    const assertProductionAdmission=async()=>{
      await assertAdmission();
      if(!automatic)return;
      const capacity=await readWeeklyAutomaticProductionCapacity(dataStore,{intent:automatic.intent,pkg,planning,task,now:now().toISOString()});
      if(!capacity?.eligible)throw Error(capacity?'weekly_automatic_production_not_yet_eligible':'weekly_automatic_production_capacity_required');
      const selected=await readAutomaticProductSelection();
      if(!automaticProductSelection||socialRequestHash(selected)!==socialRequestHash(automaticProductSelection))throw Error('weekly_production_product_selection_required');
    };
    const adopted=await readWeeklyAutomationTemplate(dataStore,task);
    const callToAction=adopted?.template.callToAction??publication.cta;
    // The accepted template includes a WhatsApp/free-sample promise. A
    // production-only proof defers outbound readiness; it does not establish
    // that this on-screen claim has a real destination or an offered sample.
    const frozenCtaNeedsClaimProof = Boolean(automatic
      && /whats\s*app|free\s+samples?|免费样品/i.test(callToAction??''));
    if (automatic?.authority.proof.deferredOutboundBlockers.includes('conversion_route_required') || frozenCtaNeedsClaimProof) {
      const proof = frozenCtaNeedsClaimProof ? await readWeeklySamplePolicyEvidence({store:dataStore,
        scope:{tenantId:task.tenantId,programId:task.programId,packageId:task.packageId,
          packageVersion:task.packageVersion,publicationTaskId:task.publicationTaskId!},now:now()}).catch(()=>null) : null;
      if(!proof)return blocked('weekly_production_cta_evidence_required', '冻结行动引导中的 WhatsApp 渠道或免费样品承诺缺少独立核验的归属、可达与选中产品政策证据；普通转化入口不能代替。');
    }
    if(automatic){
      try{automaticProductSelection=await readAutomaticProductSelection();}
      catch(error){
        if(error instanceof Error&&error.message==='weekly_production_product_selection_required')return blocked('weekly_production_product_selection_required','当前发布任务尚无同周包版本、可复核的唯一选中产品回执；不会把企业货盘首项或采集选品当作发布选品。');
        return blocked('weekly_production_product_selection_unavailable','当前发布任务的选品回执或企业产品事实无法核验；未创建内容任务或启动付费生产。');
      }
    }
    const perItemBudgetCny=adopted?Math.min(Number.isFinite(pkg.socialContentPackage.perItemBudgetCny)&&pkg.socialContentPackage.perItemBudgetCny!==null?pkg.socialContentPackage.perItemBudgetCny:adopted.template.perFinishedVideoMaxCny,adopted.template.perFinishedVideoMaxCny):pkg.socialContentPackage.perItemBudgetCny;
    if (!publication.businessProposition || !callToAction || !publication.factRefs.length || !item.topic) {
      return blocked('weekly_production_inputs_required', '经营主张、事实凭据、行动指引及排期主题必须完整。');
    }
    if (perItemBudgetCny === null || !Number.isFinite(perItemBudgetCny) || perItemBudgetCny < 0) {
      return blocked('weekly_production_budget_required', '生产预算尚未明确，不能开始供应商生成。');
    }
    const classification = await checkWeeklyMaterialClassification({store:dataStore,tenantId:task.tenantId,programId:task.programId,packageId:pkg.packageId,packageVersion:pkg.version,item,analysis:planning.directorAnalyses?.find(analysis=>analysis.analysisId===item.directorAnalysisRef?.id),requireReferenceBinding:Boolean(automatic)&&(pkg.executionGraphVersion??1)>=2});
    if(!classification.ready)return blocked(classification.code,'真实素材需求尚未明确分类或其来源版本与冻结排期不一致；请修订分析和排期后再生产。');
    if(publication.contentTemplateBindingRef){try{const structure=await readWeeklyTemplateStructure(dataStore,{tenantId:task.tenantId,programId:task.programId,packageId:task.packageId,packageVersion:task.packageVersion,publicationTaskId:task.publicationTaskId!},publication.contentTemplateBindingRef);if(!item.contentTemplateStructure||JSON.stringify(item.contentTemplateStructure)!==JSON.stringify(structure))return blocked('content_template_dispatch_mismatch','实际模板结构与冻结编导派单不一致，未进入生产。');}catch{return blocked('content_template_admission_failed','确认模板缺少实际来源或下一周绑定证据，未进入生产。');}}
    const binding = weeklyProductionBindingKey(task);
    await assertWeeklySharedProductionGroupUnsplit(dataStore,task.tenantId,pkg,publication.publicationTaskId);
    const existing = await repository.list(STARTER_COLLECTIONS.socialContentTasks, task.tenantId, { where: { create_idempotency_key: binding }, perPage: 2 });
    if (existing.totalItems > 1) return blocked('weekly_production_binding_ambiguous', '内容生产任务绑定不唯一。');
    let detail: SocialContentTaskDetail | null = existing.items[0]
      ? await read({ repository, tenantId: task.tenantId, taskId: String(existing.items[0].task_id) }) : null;
    if(adopted&&detail&&Number(detail.brief.perItemBudgetCny)>adopted.template.perFinishedVideoMaxCny)return blocked('weekly_existing_production_budget_exceeds_template',`原生产任务预算高于${adopted.template.perFinishedVideoMaxCny}元，需在真实生产页面选择增加预算或采用降级方案；不会重建任务掩盖费用。`);
    let scriptEvidence: VersionedSocialRef | null = null;
    let storyboardEvidence: VersionedSocialRef | null = null;
    let automaticMaterialEvidence:VersionedSocialRef|null=null;
    let startedHere=false;
    try {
      if (!detail) {
        const goalRef = pkg.businessContentGoalRef;
        const goal = goalRef ? await createSocialOperatingRepository(dataStore).getGoal(task.tenantId, task.programId, goalRef.id, goalRef.version) : null;
        const programRows = await dataStore.list<any>('social_programs', { where: { tenant_id: task.tenantId, program_id: task.programId }, perPage: 2 });
        const accountRows = await dataStore.list<any>('social_owned_accounts', { where: { tenant_id: task.tenantId, program_id: task.programId, account_id: publication.accountId }, perPage: 2 });
        const conditionalGoal = automatic?.authority.goal;
        const goalAuthorized = goal?.status === 'ready' || Boolean(conditionalGoal && goal && pkg.businessContentGoalRef
          && automatic?.authority.proof.goalRef.id === pkg.businessContentGoalRef.id
          && automatic.authority.proof.goalRef.version === pkg.businessContentGoalRef.version
          && socialRequestHash(conditionalGoal) === socialRequestHash(goal));
        if (!goal || !goalAuthorized || programRows.totalItems !== 1 || accountRows.totalItems !== 1) return blocked('weekly_production_authority_required', '经营目标、计划身份或账号身份缺少有效依据。');
        const value: CreateSocialContentTaskInput = {
          title: item.topic, objective: goal.status === 'ready' ? goal.objective : pkg.objective, productRef: automatic ? automaticProductSelection!.productName : goal.products[0], audience: goal.audiences[0], markets: goal.markets, customTopic: item.topic,
          callToAction, platforms: [publication.platform], languages: goal.languages,
          formats: ['short_video'], requestedOutputCount: 1, dueAt: publicationPreparationDeadline(publication.publishWindow),
          weeklyPlanId: pkg.packageId, mode: 'weekly', creationMode:'viral_replication', themeId:'product_value', managementMode: 'one_click_managed', productionApproach: 'ai_enhanced', productionMode: 'social_ready',
          weeklyBudgetCny: pkg.socialContentPackage.weeklyBudgetCny??(perItemBudgetCny*pkg.socialContentPackage.publicationTasks.length),
          perItemBudgetCny,
          programRef: { objectType: 'social_program', id: task.programId, version: String(programRows.items[0].payload.version) },
          targetAccountRef: { objectType: 'social_owned_account', id: publication.accountId, version: String(accountRows.items[0].payload.version) },
          specialRequirements: [item.topic, ...item.materialRequirements, `事实凭据：${publication.factRefs.map(ref => `${ref.type}:${ref.id}@${ref.version}`).join('，')}`].join('\n'),
        };
        await assertProductionAdmission();
        detail = await create({ repository, tenantId: task.tenantId, userId: executionActor, idempotencyKey: binding, value });
      }
      if(!detail)return blocked('weekly_production_binding_missing','内容任务创建后无法读取，未继续生产。');
      const boundRows = await repository.list(STARTER_COLLECTIONS.socialContentTasks, task.tenantId, { where: { task_id: detail.taskId }, perPage: 2 });
      const boundRow = boundRows.items[0];
      if (!boundRow || boundRows.totalItems !== 1) return blocked('weekly_production_binding_missing', '内容任务身份无法核对。');
      if (task.schedule.stepKind === 'script') scriptEvidence = weeklyScriptEvidence(boundRow, (item.benchmarkVideoRefs ?? []).map(ref => ref.id));
      if(task.schedule.stepKind==='script'&&(pkg.executionGraphVersion??1)>=2){
        scriptEvidence=null;
        if(boundRow.run_id){const {readWeeklyReplicationAuthority}=await import('../starter198/socialWeeklyReplicationAuthority.js');const proof=await readWeeklyReplicationAuthority(repository,boundRow);const {freezeSocialAccountProductionConstraints}=await import('../starter198/socialAccountProductionConstraints.js');const baseline=socialObject(socialJson(boundRow.script_baseline));const expected=proof?freezeSocialAccountProductionConstraints(proof.context,detail.brief.callToAction):undefined;if(expected&&socialRequestHash(baseline?.accountPlaybookConstraints)===socialRequestHash(expected))scriptEvidence=weeklyScriptEvidence(boundRow,(item.benchmarkVideoRefs??[]).map(ref=>ref.id));}
      }
      if(task.schedule.stepKind==='storyboard'){
        let handoff:null|import('../starter198/socialWeeklyPreSupplyHandoff.js').WeeklyPreSupplyHandoff=null;
        if((pkg.executionGraphVersion??1)>=2&&boundRow.run_id){
        const {readWeeklyPreSupplyHandoff}=await import('../starter198/socialWeeklyPreSupplyHandoff.js');
        handoff=await readWeeklyPreSupplyHandoff(repository,task.tenantId,detail.taskId);
        if(handoff&&(handoff.programId!==task.programId||handoff.packageId!==task.packageId||handoff.packageVersion!==task.packageVersion||handoff.publicationTaskId!==task.publicationTaskId))handoff=null;
        }
        storyboardEvidence=weeklyStoryboardStageEvidence(boundRow,(item.benchmarkVideoRefs??[]).map(ref=>ref.id),pkg.executionGraphVersion??1,handoff);
      }
      if(publication.contentTemplateBindingRef){const baseline=socialObject(socialJson(boundRow.script_baseline));if(JSON.stringify(baseline?.contentTemplateStructure)!==JSON.stringify(item.contentTemplateStructure)){scriptEvidence=null;storyboardEvidence=null;}}
      const brief = socialObject(socialJson(boundRow.brief))!;
      let authority = brief._weeklyAuthority as Awaited<ReturnType<typeof bindWeeklyProductionAuthority>> | undefined;
      if (!authority && detail.artifacts.some(a=>a.content?.render&&(a.content.render as Record<string,unknown>).completed===true)) return blocked('weekly_production_result_authority_missing','原成片缺少冻结生产身份，不能补造历史来源凭据。');
      if (!authority) {
        authority = await (ports.bindAuthority ?? bindWeeklyProductionAuthority)({ dataStore, repository, tenantId: task.tenantId, pkg, publication, detail });
        await repository.update(STARTER_COLLECTIONS.socialContentTasks, task.tenantId, boundRow.id, { brief: { ...brief, _weeklyAuthority: authority } });
        detail = (await read({ repository, tenantId: task.tenantId, taskId: detail.taskId }))!;
      }
      await persistWeeklySharedProductionBindings(dataStore,task.tenantId,pkg,{...boundRow,brief:{...brief,_weeklyAuthority:authority}});
      if(pkg.socialContentPackage.productionIdentityVersion==='shared-original.v1')await registerSocialContentWeeklyPlan({repository,tenantId:task.tenantId,task:{...boundRow,brief:{...brief,_weeklyAuthority:authority}}});
      // Existing owned output is consumed read only; fresh reference admission is
      // reserved for creating or enqueueing production, never retrofitted into a run.
      if (['asset_generation','video_generation','quality_check','rework'].includes(task.schedule.stepKind)) {
        let pinnedArtifactRef:VersionedSocialRef|null=null;
        const requiresPinnedQualityArtifact=(pkg.executionGraphVersion??1)>=2&&['quality_check','rework'].includes(task.schedule.stepKind);
        if(requiresPinnedQualityArtifact){
          const recovery=task.schedule.stepKind==='quality_check'&&task.qualityRecoveries?.length?task.qualityRecoveries.at(-1)!.artifactRef:null;
          if(recovery)pinnedArtifactRef=recovery;
          else{
            const refs:VersionedSocialRef[]=[];
            for(const dependencyId of task.dependsOnTaskIds){
              const dependencyRows=await dataStore.list<{payload:WeeklyExecutionTask}>('social_weekly_execution_tasks',{where:{tenant_id:task.tenantId,task_id:dependencyId},perPage:2});
              if(dependencyRows.totalItems!==1)continue;
              const dependency=dependencyRows.items[0]!.payload;
              if(dependency.programId!==task.programId||dependency.packageId!==task.packageId||dependency.packageVersion!==task.packageVersion||dependency.status!=='succeeded')continue;
              refs.push(...dependency.resultRefs.filter(ref=>ref.type==='starter_social_content_artifact'));
            }
            const unique=[...new Map(refs.map(ref=>[`${ref.id}:${ref.version}`,ref])).values()];
            if(unique.length===1)pinnedArtifactRef=unique[0]!;
          }
          if(!pinnedArtifactRef)return blocked('weekly_production_quality_artifact_required','质量与返工任务必须绑定唯一的上游成片，不能按最新产物猜测。');
        }
        const completed = [...detail.artifacts].sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)).find(a=>a.kind==='short_video'&&a.origin==='agent'&&!['changes_requested','superseded'].includes(a.status)&&a.resourceRef&&a.content?.render&&(a.content.render as Record<string,unknown>).completed===true&&(!pinnedArtifactRef||(a.artifactId===pinnedArtifactRef.id&&version(a.version)===pinnedArtifactRef.version)));
        if(requiresPinnedQualityArtifact&&!completed)return blocked('weekly_production_pinned_artifact_missing','上游已核验成片已失效或版本不一致，不能回选其他产物或重新发起生产。');
        if(completed){
          const v=version(completed.version);if(!v)return blocked('weekly_production_version_invalid','内容产物版本无效。');
          const ref={type:'starter_social_content_artifact' as const,id:completed.artifactId,version:v};
          if(automatic&&task.schedule.stepKind==='quality_check'&&completed.content?.workflowSchema==='social-content.auto-production.v3'){
            try{const {advanceWeeklyAutomaticG5}=await import('./weeklyG5AutomaticAuthority.js');await advanceWeeklyAutomaticG5(dataStore,task,ref,executionActor);}
            catch(error){return blocked('weekly_production_quality_review_required',error instanceof Error?error.message:'自动编导质量审核缺少当前可信证据。');}
          }
          const {validateContentArtifact}=await import('./socialWeeklyResultValidation.js');
          await validateContentArtifact(dataStore,task,ref);
          const {resolveSceneCacheSourceRun}=await import('../starter198/socialContentSceneCacheSource.js');
          const sourceRun=await resolveSceneCacheSourceRun(repository,{tenantId:task.tenantId,taskId:detail.taskId,parentArtifactId:completed.artifactId});
          const {createSocialSceneReworkService}=await import('../starter198/socialContentSceneReworkService.js');
          await createSocialSceneReworkService(repository).readCache({tenantId:task.tenantId,taskId:detail.taskId,runId:sourceRun,parentArtifactId:completed.artifactId});
          await (ports.persistResultAuthority ?? persistWeeklyProductionResultAuthority)({repository,tenantId:task.tenantId,authority,detail});
          if(['quality_check','rework'].includes(task.schedule.stepKind)){
            try{const {readVerifiedWeeklyContentQualityAudit}=await import('./weeklyContentQualityAudit.js');const verified=await readVerifiedWeeklyContentQualityAudit(dataStore,task,ref);return{status:'succeeded',resultRefs:[ref,{type:'quality_receipt',id:verified.receiptId,version:1}]};}
            catch(error){return blocked('weekly_production_quality_review_required',error instanceof Error?error.message:'产物缺少可核验的质量审核证据。');}
          }
          return success(ref);
        }
      }
      const references=await readWeeklyReferenceSources(dataStore,task.tenantId,authority,planning.directorAnalyses.find(analysis=>analysis.analysisId===item.directorAnalysisRef?.id)!);
      if(!detail.sources.some(source=>source.kind==='reference_link'&&source.status==='active')) {
        if(detail.runId)return blocked('weekly_reference_binding_revision_required','原运行未冻结参考来源，请修订生产任务后再启动；不能修改已启动运行的来源。');
        for(const reference of references){await assertAdmission();const legacyKey=`weekly-reference:${reference.sourceVersion}`;const idempotencyKey=await weeklySourceBindingIdempotencyKey({repository,tenantId:task.tenantId,taskId:detail.taskId,legacyKey});const attached=await addSource({repository,tenantId:task.tenantId,userId:executionActor,taskId:detail.taskId,idempotencyKey,referenceResolver:weeklyReferenceResolver(references),value:{kind:'reference_link',sourceRef:reference.sourceRef,sourceVersion:reference.sourceVersion,label:reference.label,purpose:'冻结排期已确认参考；保留原来源与权利'}});detail=attached.task;}
      }
      assertWeeklyReferenceBindings(detail,references);
      if(['material_preparation','material_readiness'].includes(task.schedule.stepKind)&&!detail.runId){
        for(const reference of references){const sourceAnalysis=socialObject(socialJson(reference.record.aiAnalysis));
          if(typeof sourceAnalysis?.analysisRunId!=='string'||!sourceAnalysis.analysisRunId||typeof sourceAnalysis.contentSha256!=='string'||!/^[a-f0-9]{64}$/.test(sourceAnalysis.contentSha256))return blocked('weekly_reference_source_evidence_required','参考原片缺少可信分析运行或原片字节校验，尚未补抽分镜；请先完成原片证据准备。');
          await assertAdmission();await createExactShotMaterializationService(dataStore).materialize({tenantId:task.tenantId,recordId:String(reference.record.id),expectedSourceSha256:sourceAnalysis.contentSha256,expectedAnalysisRunId:sourceAnalysis.analysisRunId,expectedAnalysisHash:(await import('../starter198/socialContentValidation.js')).socialRequestHash(sourceAnalysis)});await assertAdmission();
        }
        detail=(await read({repository,tenantId:task.tenantId,taskId:detail.taskId}))!;
      }
      await (ports.persistResultAuthority ?? persistWeeklyProductionResultAuthority)({ repository, tenantId: task.tenantId, authority, detail });
      if ((classification.contract.items.some(item=>item.classification==='human_irreplaceable') || requiresFrozenHumanMaterialContract(item.materialRequirements ?? [])) && !publication.materialRequirement) {
        return {
          status: 'blocked', code: 'weekly_required_material_contract_missing',
          message: '冻结排期承诺了不可替代的真人或客户实证素材，但尚未绑定真实素材任务。请显式绑定并核验，或由经营修订该承诺；自动计划不能代替。',
          progress: { contentTaskId: detail.taskId, runId: detail.runId, step: 'material_readiness', activity: '等待不可替代素材需求冻结与核验', updatedAt: new Date().toISOString() },
        };
      }
      if(!publication.materialRequirement) {
        const owned=await assessWeeklyOwnedProductIdentity(dataStore,{tenantId:task.tenantId,programId:task.programId,packageId:task.packageId,packageVersion:task.packageVersion,publicationTaskId:task.publicationTaskId!,contentTaskId:detail.taskId},{...ports.ownedProductIdentity,repository,sourceOptions});
        if(owned.required){if(owned.status!=='ready')return blocked(owned.gaps[0]??'weekly_owned_product_identity_verification_required','产品身份素材尚未完成指定消费者的事实、权利与镜头核验，请先关联真实素材任务；未启动生产。');const frozen=socialObject(socialJson(boundRow.brief))?._weeklyOwnedProductIdentityDemand as {version:number};automaticMaterialEvidence={type:'starter_social_owned_product_identity_demand',id:detail.taskId,version:frozen.version};}
        else {
        const demandScope={taskId:detail.taskId,programId:task.programId,packageId:task.packageId,packageVersion:task.packageVersion,publicationTaskId:task.publicationTaskId,accountId:publication.accountId,factRefs:publication.factRefs};
        let demand=await readVerifiedNoSharedMaterialDemand(dataStore,boundRow,{...demandScope,tenantId:task.tenantId},{repository});
        if(!demand&&detail.runId){await assertAdmission();demand=await freezeOriginalRunMaterialDemand(dataStore,{...demandScope,tenantId:task.tenantId},{repository});}
        if(!demand&&!detail.runId) {
          demand=buildNoSharedMaterialDemand(boundRow,detail,demandScope);
          if(demand) {
            await assertAdmission();
            const latest=await repository.list(STARTER_COLLECTIONS.socialContentTasks,task.tenantId,{where:{task_id:detail.taskId},perPage:2});
            if(latest.totalItems!==1||latest.items[0].run_id)return blocked('weekly_material_demand_changed','素材计划冻结期间内容运行状态已变化。');
            const currentBrief=socialObject(socialJson(latest.items[0].brief))??{};
            await repository.update(STARTER_COLLECTIONS.socialContentTasks,task.tenantId,latest.items[0].id,{brief:{...currentBrief,_weeklyMaterialDemand:demand}});
            const persisted=await repository.list(STARTER_COLLECTIONS.socialContentTasks,task.tenantId,{where:{task_id:detail.taskId},perPage:2});
            demand=persisted.totalItems===1?verifiedNoSharedMaterialDemand(persisted.items[0],demandScope):null;
            if(!demand)return blocked('weekly_material_demand_storage_failed','自动素材需求计划尚未持久冻结。');
          }
        }
        if(demand)automaticMaterialEvidence={type:'starter_social_content_material_demand',id:detail.taskId,version:demand.version};
        }
      }
      let requiredMaterialAdmission:WeeklyRequiredMaterialAdmission|null=null,reviewedVideoRoutingBound=false;
      if(publication.materialRequirement) {
        const materialRows:any[]=[];
        for(let page=1;;page++) {
          const batch=await dataStore.list<any>('social_weekly_execution_tasks',{where:{tenant_id:task.tenantId,program_id:task.programId,package_id:task.packageId,package_version:task.packageVersion},sort:'id',page,perPage:500});
          materialRows.push(...batch.items);
          if(page>=batch.totalPages)break;
          if(!batch.items.length)return blocked('weekly_material_consumer_lookup_incomplete','素材消费者任务列表需完整读取后才能核验。');
        }
        const matching=materialRows.filter(row=>{const payload=socialObject(socialJson(row.payload));return payload?.publicationTaskId===task.publicationTaskId&&socialObject(payload.schedule)?.stepKind==='material_readiness';});
        if(matching.length!==1)return blocked('weekly_material_consumer_required','缺少唯一的真实素材核验消费者。');
        const consumer=socialObject(socialJson(matching[0].payload))!;
        if(['cancelled','dead_letter'].includes(String(consumer.status)))return blocked('weekly_material_consumer_inactive','素材核验消费者已取消或失败，需明确恢复。');
        if(consumer.tenantId!==task.tenantId||consumer.programId!==task.programId||consumer.packageId!==task.packageId||consumer.packageVersion!==task.packageVersion||consumer.taskId!==matching[0].task_id)return blocked('weekly_material_consumer_identity_invalid','素材消费者身份与冻结视频版本不一致。');
        const mappingGap=await checkWeeklyHumanRequirementBindings({store:dataStore,tenantId:task.tenantId,programId:task.programId,packageId:task.packageId,packageVersion:task.packageVersion,consumerTaskId:String(consumer.taskId),publication,contract:classification.contract});
        if(mappingGap)return blocked(mappingGap,'不可替代素材必须逐需求明确绑定，并由本视频消费者核验对应镜头。');
        requiredMaterialAdmission=await materialAdmission({tenantId:task.tenantId,programId:task.programId,consumerTaskId:String(consumer.taskId),requirement:publication.materialRequirement});
        if(requiredMaterialAdmission.status!=='ready'||!requiredMaterialAdmission.materials.length)return {status:'blocked',code:'weekly_required_materials_missing',message:`冻结必需素材未就绪：${requiredMaterialAdmission.gaps.map(gap=>`${gap.requestId??'合同'}:${gap.code}`).join('、')}`,progress:{contentTaskId:detail.taskId,runId:detail.runId,step:'material_readiness',activity:'等待共享素材提交与逐视频核验',updatedAt:new Date().toISOString()}};
        for(const material of requiredMaterialAdmission.materials) {
          const sourceRef=`socialmaterial:${Buffer.from(`pb-${material.recordId}`,'utf8').toString('base64url')}`;
          const option=await sourceOptions.resolve({tenantId:task.tenantId,kind:'material',sourceRef});
          const raw=await (ports.materialRecord??getOwnedCloudMaterialRecord)(material.recordId,task.tenantId);
          if(!option||option.kind!=='material'||option.sourceRef!==sourceRef||!option.sourceVersion||!raw||raw.id!==material.recordId||String(raw.tenantId||raw.tenant_id)!==task.tenantId||String(raw.scope||'own')==='shared'||String(raw.sha256||'')!==material.sha256)return blocked('weekly_material_source_revision_invalid','生产素材选项或实际字节版本与审核凭据不一致。');
          const attached=(detail.sources??[]).filter(source=>source.kind==='material'&&source.sourceRef===sourceRef&&source.status==='active');
          if(attached.length>1||attached.some(source=>source.sourceVersion!==option.sourceVersion))return blocked('weekly_material_source_version_conflict','现有生产素材版本与当前已核验版本冲突，请显式修订。');
          if(attached.length)continue;
          if(detail.runId)return blocked('weekly_running_material_binding_change_required','生产已运行，但缺少被冻结素材绑定；不能运行中编辑输入或重新付费执行。');
          await assertAdmission();
          const sourceKey=createHash('sha256').update(JSON.stringify([binding,material.recordId,option.sourceVersion])).digest('hex');
          const legacyKey=`weekly-material:${sourceKey}`;
          const idempotencyKey=await weeklySourceBindingIdempotencyKey({repository,tenantId:task.tenantId,taskId:detail.taskId,legacyKey});
          const added=await addSource({repository,tenantId:task.tenantId,userId:executionActor,taskId:detail.taskId,idempotencyKey,sourceOptions,value:{kind:'material',sourceRef,sourceVersion:option.sourceVersion,label:option.label,purpose:'冻结周排期必需素材；逐视频事实、权利与镜头已核验'}});
          if(!added.task)return blocked('weekly_material_source_binding_missing','真实素材来源绑定后无法读取内容任务。');
          detail=added.task;
          if(!(detail.sources??[]).some(source=>source.kind==='material'&&source.sourceRef===sourceRef&&source.sourceVersion===option.sourceVersion&&source.status==='active'))return blocked('weekly_material_source_binding_missing','真实素材来源绑定尚未持久保存。');
        }
        const currentDetail=detail;
        const videos=requiredMaterialAdmission.materials.filter(material=>material.type==='video').map(material=>{const sourceRef=`socialmaterial:${Buffer.from(`pb-${material.recordId}`,'utf8').toString('base64url')}`;const source=currentDetail.sources.find(item=>item.status==='active'&&item.sourceRef===sourceRef);return source?{recordId:material.recordId,sha256:material.sha256,sourceRef,sourceVersion:source.sourceVersion!,type:'video' as const}:null;});
        if(videos.length){if(videos.some(video=>!video))return blocked('weekly_reviewed_material_source_unverified','核验视频尚未绑定精确来源版本。');await assertAdmission();const {bindReviewedWeeklyVideosToShots}=await import('./weeklyReviewedMaterialShotBinding.js');detail=await bindReviewedWeeklyVideosToShots({repository,tenantId:task.tenantId,taskId:detail.taskId,bindings:videos.filter((video):video is NonNullable<typeof video>=>Boolean(video))});reviewedVideoRoutingBound=true;}
      }
      if(task.schedule.stepKind==='material_preparation'){
        const current=await repository.list(STARTER_COLLECTIONS.socialContentTasks,task.tenantId,{where:{task_id:detail.taskId},perPage:2});
        const v=current.totalItems===1?version(String(current.items[0]?.version??'')):null;if(!v)return blocked('weekly_material_preparation_content_changed','素材准备所依赖的原内容版本已变化。');
        const ref={type:'starter_social_material_preparation',id:detail.taskId,version:v};
        const {validateWeeklyMaterialPreparationEvidence}=await import('./weeklyMaterialPreparationEvidence.js');
        await validateWeeklyMaterialPreparationEvidence(dataStore,task,ref,{...ports.ownedProductIdentity,repository,sourceOptions,materialPorts:ports.ownedProductIdentity?.materialPorts,getMaterial:ports.materialRecord??ports.ownedProductIdentity?.getMaterial});
        return success(ref);
      }
      const unmetMaterials = new Set([
        ...(detail.materialReadiness?.blockingRequirementIds ?? []),
        ...(detail.materialRequirements ?? []).filter(requirement => requirement.required && requirement.status !== 'satisfied').map(requirement => requirement.requirementId),
      ]);
      if (!reviewedVideoRoutingBound && (unmetMaterials.size || detail.materialReadiness?.complete === false)) {
        return { status: 'blocked', code: 'weekly_required_materials_missing', message: `必需素材尚未核验通过：${[...unmetMaterials].join('、') || '素材核验未完成'}。请在原内容任务补交并核验后继续；不能默认以生成素材替代。`,
          progress: { contentTaskId: detail.taskId, runId: detail.runId, step: 'material_readiness', activity: '等待必需素材补交与核验', updatedAt: new Date().toISOString() } };
      }
      // Never restart an existing run after a provider timeout. Its durable job owns receipt reconciliation.
      if (!detail.runId && ['draft', 'needs_input', 'plan_review'].includes(detail.status)) {
        if (!detail.readiness.complete) return { status: 'blocked', code: 'weekly_production_inputs_required', message: `内容输入待补全：${detail.readiness.missing.join('、')}`,
          progress: { contentTaskId: detail.taskId, runId: null, step: 'material_readiness', activity: '等待内容输入补齐', updatedAt: new Date().toISOString() } };
        await assertProductionAdmission();
        const attempt=await readWeeklyProductionStartAttempt({repository,tenantId:task.tenantId,taskId:detail.taskId,binding,version:detail.version});
        startedHere=true;
        detail = await start({ repository, orchestratorQueue, tenantId: task.tenantId,
          userId: executionActor, taskId: detail.taskId,
          expectedVersion: attempt.expectedVersion, referenceResolver:weeklyReferenceResolver(references), idempotencyKey: attempt.idempotencyKey });
        if(!detail)return blocked('weekly_production_start_unverified','内容生产启动后无法读取原任务，未继续执行。');
      }
      if(detail.runId&&!startedHere&&['asset_generation','video_generation','quality_check','rework'].includes(task.schedule.stepKind)&&!await readContentExecutionJob(dataStore,task.tenantId,detail.taskId,detail.runId)){await assertProductionAdmission();await ensureOriginalSocialContentProductionQueued({repository,tenantId:task.tenantId,userId:executionActor,taskId:detail.taskId,runId:detail.runId});}
    } catch (error) {
      const code = error instanceof Error && /^reference_[a-z_]+(?::|$)/.test(error.message) ? error.message.split(':', 1)[0]! : error instanceof Error && /^weekly_/.test(error.message) ? error.message : error && typeof error === 'object' && 'code' in error ? String(error.code) : 'weekly_production_admission_failed';
      return blocked(code, weeklyProductionAdmissionMessage(code, detail, error instanceof Error ? error.message : '内容生产准入失败。'));
    }
    if (!detail.runId) return blocked('weekly_production_confirmation_required', '内容任务已保留，等待既有生产准入确认。');
    let job = await readContentExecutionJob(dataStore, task.tenantId, detail.taskId, detail.runId);
    if(task.schedule.stepKind==='asset_generation'&&job?.status==='paused'&&job.retryClass==='weekly_production_waiting_asset_claim'){
      try{const {resumeWeeklyProductionAssetStage}=await import('../starter198/socialWeeklyProductionStageResume.js');await resumeWeeklyProductionAssetStage({repository,assetTask:task,now:now(),assertAdmission:assertProductionAdmission,validationPorts:{ownedProductIdentity:ports.ownedProductIdentity?{...ports.ownedProductIdentity,repository}:undefined}});job=await readContentExecutionJob(dataStore,task.tenantId,detail.taskId,detail.runId);}
      catch(error){return blocked(error instanceof Error?error.message:'weekly_production_stage_resume_unverified','原生产任务尚不能进入资产阶段，请核验本周前置任务及原运行凭据。');}
    }
    if(task.schedule.stepKind==='asset_generation'){
      const candidates=await repository.list(STARTER_COLLECTIONS.socialContentTasks,task.tenantId,{perPage:500});
      if(candidates.totalItems!==candidates.items.length)return blocked('weekly_creative_repair_lookup_incomplete','创意返工生产任务列表未完整读取，不能恢复资产生产。');
      const {resolveWeeklyCreativeRepairAuthority}=await import('./weeklyCreativeRepairAuthority.js');
      const {readWeeklyPreSupplyHandoff}=await import('../starter198/socialWeeklyPreSupplyHandoff.js');
      const {resumeWeeklyProductionAssetStage}=await import('../starter198/socialWeeklyProductionStageResume.js');
      for(const candidate of candidates.items.filter(row=>String(row.create_idempotency_key??'').startsWith('weekly-creative-repair:'))){
        const authority=await resolveWeeklyCreativeRepairAuthority({store:dataStore,tenantId:task.tenantId,task:candidate});
        if(!authority||authority.repairCase.packageId!==task.packageId||authority.repairCase.packageVersion!==task.packageVersion||authority.repairCase.publicationTaskId!==task.publicationTaskId)continue;
        const taskId=String(candidate.task_id??''),runId=String(candidate.run_id??'');if(!taskId||!runId)continue;
        const creativeJob=await readContentExecutionJob(dataStore,task.tenantId,taskId,runId);if(creativeJob?.status!=='paused'||creativeJob.retryClass!=='weekly_production_waiting_asset_claim')continue;
        const handoff=await readWeeklyPreSupplyHandoff(repository,task.tenantId,taskId);if(!handoff)return blocked('weekly_creative_repair_handoff_missing','创意返工任务缺少已冻结的生产交接凭证。');
        try{await resumeWeeklyProductionAssetStage({repository,assetTask:task,contentTaskId:taskId,now:now(),assertAdmission:assertProductionAdmission,validationPorts:{ownedProductIdentity:ports.ownedProductIdentity?{...ports.ownedProductIdentity,repository}:undefined}});}
        catch(error){return blocked(error instanceof Error?error.message:'weekly_creative_repair_stage_resume_unverified','创意返工任务尚不能恢复资产生产，请核验真实前置产物。');}
      }
    }
    if (['draft', 'needs_input', 'plan_review'].includes(detail.status) && !job) return blocked('weekly_production_confirmation_required', '运行身份已保留，但尚未完成生产准入确认。');
    const progress = detail.productionProgress ? { contentTaskId: detail.taskId, runId: detail.runId, step: detail.productionProgress.step, activity: detail.productionProgress.activity, updatedAt: detail.productionProgress.updatedAt } : undefined;
    if(job&&['blocked','cancelled','dead_letter'].includes(job.status)||job?.status==='paused'&&job.retryClass!=='weekly_production_waiting_asset_claim')return blocked(job!.retryClass||`content_execution_${job!.status}`,job!.lastError||'后台生产需要处理后才能继续。');
    if (task.schedule.stepKind === 'script' && scriptEvidence) return success(scriptEvidence);
    if (task.schedule.stepKind === 'storyboard' && storyboardEvidence) return success(storyboardEvidence);
    if(task.schedule.stepKind==='material_readiness'&&automaticMaterialEvidence)return success(automaticMaterialEvidence);
    if(job&&['blocked','paused','cancelled','dead_letter'].includes(job.status)&&!(job.status==='paused'&&job.retryClass==='weekly_production_waiting_asset_claim'&&task.schedule.stepKind==='material_readiness'))return blocked(job.retryClass || `content_execution_${job.status}`, job.lastError || '后台生产需要处理后才能继续。');
    if (task.schedule.stepKind === 'script' || task.schedule.stepKind === 'storyboard') {
      if (['attention', 'needs_input', 'paused'].includes(detail.status)) return blocked('weekly_production_user_action_required', detail.productionProgress?.activity || '生产已暂停，需先处理真实输入或执行异常。');
      return { ...pending('weekly_locked_handoff_pending', '等待对应冻结参考的锁定脚本或分镜交接凭证。'), progress };
    }
    if (job?.status === 'reconciling') return { ...pending('provider_reconciliation', '供应商结果未知，沿用原生产身份对账，不能重新付费提交。'), progress };
    if(task.schedule.stepKind==='material_readiness'&&automaticMaterialEvidence)return success(automaticMaterialEvidence);
    if (task.schedule.stepKind === 'material_readiness' && !publication.materialRequirement) return blocked('weekly_material_contract_required','旧版任务没有冻结素材合同，不能以通用输入完整作为素材已核验凭据。');
    if (task.schedule.stepKind === 'material_readiness' && detail.readiness.complete) {
      const v = version(detail.version);
      return v ? success({ type: 'starter_social_content_task', id: detail.taskId, version: v }) : blocked('weekly_production_version_invalid', '内容任务版本无效。');
    }
    const artifact = [...detail.artifacts].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)).find(artifact => artifact.kind === 'short_video' && artifact.origin === 'agent'
      && artifact.resourceRef && artifact.status !== 'changes_requested' && artifact.status !== 'superseded'
      && artifact.content?.render && (artifact.content.render as Record<string, unknown>).completed === true);
    if (artifact) {
      const content = artifact.content! as Record<string, any>;
      const step = task.schedule.stepKind;
      let qualityReceipt:VersionedSocialRef|null=null;
      const evidence = step === 'asset_generation' ? content.render?.selectedAssetIds?.length > 0
        : step === 'video_generation' ? content.render?.completed === true
        : content.productionResult?.technicalReview?.approved === true && content.productionResult?.creativeReview?.approved === true;
      const v = version(artifact.version);
      if (!v) return blocked('weekly_production_version_invalid', '内容产物版本无效。');
      if (['quality_check', 'rework'].includes(step)) {
        // Immutable pending-review flags may be superseded only by independently verified,
        // same-output G4 and G5 receipts; the artifact and final user approval stay separate.
        const { readVerifiedWeeklyContentQualityAudit } = await import('./weeklyContentQualityAudit.js');
        try {
          const verified=await readVerifiedWeeklyContentQualityAudit(dataStore, task, { type: 'starter_social_content_artifact', id: artifact.artifactId, version: v });
          qualityReceipt={type:'quality_receipt',id:verified.receiptId,version:1};
        } catch (error) {
          return blocked('weekly_production_quality_review_required', error instanceof Error ? error.message : '产物缺少可核验的质量审核证据。');
        }
      } else if (!evidence) return blocked('weekly_production_quality_review_required', '产物已保留，但该生产节点缺少通过验收的真实证据。');
      const artifactRef={ type: 'starter_social_content_artifact' as const, id: artifact.artifactId, version: v };
      return qualityReceipt?{status:'succeeded',resultRefs:[artifactRef,qualityReceipt]}:success(artifactRef);
    }
    if (['attention', 'needs_input', 'paused'].includes(detail.status)) return blocked('weekly_production_user_action_required', detail.productionProgress?.activity || '生产已暂停，需处理输入、凭据、余额或质检问题。');
    return { ...pending('weekly_production_in_progress', detail.productionProgress?.activity || '后台生产进行中，正在等待真实产物或供应商回执对账。'), progress };
      } });
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'weekly_production_admission_failed';
      if (code === 'weekly_cancellation_busy') return pending(code, '撤回或生产准入正在处理，等待安全恢复。');
      return blocked(code, error instanceof Error ? error.message : '该周版本不能继续生产。');
    }
  } };
}
