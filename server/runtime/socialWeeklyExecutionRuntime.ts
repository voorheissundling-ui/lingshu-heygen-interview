import { runWeeklyPreproductionProducerScan, readWeeklyPreproductionExecutionGate } from './weeklyPreproductionProducer.js';
import { runWeeklyTemplateExtractionRecoveryScan } from './weeklyContentTemplateCandidateProducer.js';
import { runWeeklyMetricCollectionRecoveryScan } from './weeklyPublicationMetricProducer.js';
import type { WeeklyMaterialPorts } from '../socialPrograms/weeklyMaterialRequests.js';
import { checkWeeklyEnterpriseFactSupplement, WEEKLY_ENTERPRISE_FACT_STEPS } from './weeklyEnterpriseFactSupplement.js';
import { runWeeklyHumanMaterialRecoveryScan } from './weeklyHumanMaterialRecoveryScan.js';
import { runWeeklyProductionSelectionRecoveryScan } from './weeklyProductionSelectionRecoveryScan.js';
import { runWeeklyCtaEvidenceRecoveryScan } from './weeklyCtaEvidenceRecoveryScan.js';
import { runWeeklyPresenterVoiceRecoveryScan } from './weeklyPresenterVoiceRecoveryScan.js';
import { materializeWeeklyCustomerChannelAuthorizationException, runWeeklyCustomerChannelAuthorizationExceptionScan } from './weeklyCustomerChannelAuthorizationExceptions.js';
import { materializeWeeklySupplementException, runWeeklySupplementExceptionScan } from './weeklySupplementExceptionMaterializer.js';
import {weeklyExecutionObservation} from './weeklyExecutionObservation.js';
import {weeklyScopeMatches,type WeeklyScanScope} from './weeklyScanScope.js';
import { runWeeklyDeadlineRecoveryScan, type DeadlineRecoveryEvidenceReader } from './socialWeeklyDeadlineRecovery.js';
import { randomUUID } from 'node:crypto';
import { SocialProgramError } from '../socialPrograms/service.js';
import { SocialContentWorkflowError } from '../starter198/socialContentValidation.js';
import { assertWeeklyPlanningCoverage } from '../socialPrograms/weeklyPlanningCoverage.js';
import {weeklyPlanningExecutionActor,weeklyPlanningExecutionSelection} from '../socialPrograms/weeklyPlanningTemplateAdoption.js';
import type { DataStore } from '../storage/datastore.js';
import { store } from '../storage/index.js';
import type { WeeklyAgentPlanningState, WeeklyExecutionTask, WeeklyOperatingWorkflowKind, WeeklyProductionStepKind } from '../../shared/contracts/socialProgram.js';
import { PACKAGES, type PackageRow } from '../socialPrograms/weeklyOperatingPackageSupport.js';
import { WEEKLY_AGENT_PLANNING } from '../socialPrograms/planningAuthority.js';
import { ownedDiagnosisReady } from '../socialPrograms/ownedReferenceDiagnosis.js';
import { WEEKLY_EXECUTION_TASKS, type WeeklyExecutionTaskRow } from '../socialPrograms/executionTasks.js';
import { createSocialWeeklyExecutionWorker } from './socialWeeklyExecutionWorker.js';
import { createWeeklyExecutionContinuationService } from '../socialPrograms/weeklyExecutionContinuations.js';
import type { SocialWeeklyExecutionAdapter, WeeklyExecutionAdapterResult } from './socialWeeklyExecutionAdapter.js';

import {TEMPLATE_EXECUTION_INPUT_BLOCKERS} from '../socialPrograms/templateExecutionBlockingCodes.js';
import {readIndependentAdmission} from '../socialPrograms/weeklyIndependentAdmission.js';
import {runWeeklyIndependentPreproductionRecovery} from './weeklyIndependentPreproductionRecovery.js';
import {projectWeeklyBlockedTaskNotifications} from './weeklyExecutionBlockedNotification.js';

export const WEEKLY_PREPRODUCTION_STEPS: WeeklyProductionStepKind[] = ['business_outline', 'benchmark_collection', 'benchmark_scoring', 'director_analysis', 'business_schedule'];
export type WeeklyTrustedPreproductionPorts=Omit<Parameters<typeof runWeeklyPreproductionProducerScan>[0], 'store' | 'now'>;

/** Reconcile work already performed before formal dispatch against its frozen authority. */
export function createSocialWeeklyPlanningAdapter(dataStore: DataStore,exactAnalysisPortsForRun?:import('./weeklyPreproductionProducer.js').WeeklyExactSettlementPortsForRun): SocialWeeklyExecutionAdapter {
  return { async execute(task) {
    const packages = await dataStore.list<PackageRow>(PACKAGES, { where: { tenant_id: task.tenantId, program_id: task.programId, package_id: task.packageId, version: task.packageVersion }, page: 1, perPage: 1 });
    const pkg = packages.items[0]?.payload;
    if (!pkg || !['draft', 'active'].includes(pkg.status) || pkg.packageId !== task.packageId || pkg.version !== task.packageVersion) return { status: 'blocked', code: 'weekly_package_not_executable', message: '本周任务包已被替代、停用或不存在。' };
    if(['business_outline','benchmark_collection'].includes(task.schedule.stepKind)){
      const producer=await readWeeklyPreproductionExecutionGate(dataStore,task,exactAnalysisPortsForRun);
      if(producer.ready)return {status:'succeeded',resultRefs:producer.resultRefs};
    }
    if(task.schedule.stepKind==='business_outline'&&pkg.socialContentPackage?.publicationTasks?.length&&pkg.socialContentPackage.publicationTasks.every(p=>p.inventoryReuseRef)){
      try{const {readWeeklyInventoryOutlineEvidence}=await import('./weeklyInventoryOutlineEvidence.js');const result=await readWeeklyInventoryOutlineEvidence(dataStore,task);return {status:'succeeded',resultRefs:result.resultRefs};}
      catch(error){if(error instanceof SocialProgramError)return {status:'blocked',code:error.code,message:error.message};throw error;}
    }
    const rows = await dataStore.list<{ id: string; payload: WeeklyAgentPlanningState }>(WEEKLY_AGENT_PLANNING, {
      where: { tenant_id: task.tenantId, program_id: task.programId, package_id: task.packageId, package_version: task.packageVersion },
      sort: '-planning_version', page: 1, perPage: 1,
    });
    const plan = rows.items[0]?.payload;
    const blocked = (code: string, message: string): WeeklyExecutionAdapterResult => ({ status: 'blocked', code, message });
    if (!plan || plan.packageId !== task.packageId || plan.packageVersion !== task.packageVersion
      || plan.status !== 'dispatched' || !weeklyPlanningExecutionActor(plan) || !plan.dispatch || !plan.detailedSchedule
      || plan.dispatch.packageVersion !== task.packageVersion
      || plan.dispatch.detailedScheduleRef.id !== plan.detailedSchedule.ref.id
      || plan.dispatch.detailedScheduleRef.version !== plan.detailedSchedule.ref.version) {
      return blocked('business_dispatch_required', '等待本周详细排期确认并正式派单。');
    }
    const step = task.schedule.stepKind;
    if (!WEEKLY_PREPRODUCTION_STEPS.includes(step)) return blocked('weekly_step_adapter_unavailable', '该步骤没有可用执行适配器。');
    const coverage = plan.dispatch.coverage;
    if (coverage) {
      try { assertWeeklyPlanningCoverage(plan, coverage, weeklyPlanningExecutionSelection(plan)??[]); }
      catch (error) { if (error instanceof SocialProgramError) return blocked(error.code, error.message); throw error; }
      if (JSON.stringify(plan.detailedSchedule.coverage) !== JSON.stringify(coverage)) return blocked('weekly_partial_coverage_changed', '实际派单与确认排期的视频范围不一致。');
      if (task.publicationTaskId && (!plan.skeleton.slots.some(slot => coverage.selectedSlotIds.includes(slot.slotId) && slot.publicationTaskIds.includes(task.publicationTaskId!)) || !plan.dispatch.scheduleItems.some(item => item.publicationTaskId === task.publicationTaskId))) return blocked('weekly_slot_not_dispatched', '此条目尚未确认派单，保留原来源配额等待补齐。');
    }
    const motherId = String(task.inputSnapshot.motherContentId ?? '');
    if ('referenceSourcePolicy' in task.inputSnapshot && (!task.inputSnapshot.referenceSourcePolicy || JSON.stringify(task.inputSnapshot.referenceSourcePolicy) !== JSON.stringify(plan.referenceSourcePolicy) || JSON.stringify(plan.referenceSourcePolicy) !== JSON.stringify(pkg.referenceSourcePolicy))) return blocked('reference_source_policy_required', '本任务参考来源配额尚未明确冻结或与计划版本不一致。');
    const slots = plan.skeleton.slots.filter(slot => (!coverage || coverage.selectedSlotIds.includes(slot.slotId)) && (!motherId || slot.motherContentId === motherId) && (!task.accountId || slot.accountIds.includes(task.accountId)));
    const analyses = plan.directorAnalyses.filter(analysis => slots.some(slot => slot.slotId === analysis.slotId));
    if (task.inputSnapshot.referenceSource && slots.some(slot => slot.referenceSource !== task.inputSnapshot.referenceSource)) return blocked('reference_source_allocation_mismatch', '视频来源与冻结任务不一致，不能用外部参考替换自有配额。');
    if (plan.referenceSourcePolicy?.profile === 'b2b_cold_start' && slots.some(slot => slot.referenceSource === 'owned')) return blocked('cold_start_external_reference_required', '零基础首周仅允许外部参考。');
    if (['benchmark_scoring', 'director_analysis'].includes(step) && slots.some(slot => slot.referenceSource === 'owned' && !analyses.some(analysis => analysis.slotId === slot.slotId && ownedDiagnosisReady(analysis) && JSON.stringify(analysis.ownedReferenceDiagnosis!.policy) === JSON.stringify(plan.referenceSourcePolicy)))) return blocked('owned_reference_diagnosis_pending', '自有参考需完整播放、赞转评和冻结调性分析；缺项保留待诊断，不改成外部。');
    if (!slots.length || (task.accountId && !slots.some(slot => slot.accountIds.includes(task.accountId!)))) {
      return blocked('frozen_schedule_input_missing', '冻结计划缺少对应内容或账号排期。');
    }
    if (step !== 'business_outline' && (!analyses.length || analyses.some(analysis =>
      analysis.packageVersion !== task.packageVersion || !analysis.benchmarkAccountRefs.length
      || !analysis.benchmarkVideoRefs.length || !analysis.benchmarkEvidenceRefs.length || !analysis.contentDirection.trim()))) {
      return blocked('qualified_benchmark_supply_required', '冻结计划缺少已评分对标证据及编导分析。');
    }
    if (step === 'business_schedule' && slots.some(slot => slot.publicationTaskIds.some(id =>
      !plan.dispatch!.scheduleItems.some(item => item.publicationTaskId === id)
      || !plan.detailedSchedule!.items.some(item => item.publicationTaskId === id)))) {
      return blocked('frozen_schedule_input_missing', '正式派单缺少对应详细排期条目。');
    }
    return { status: 'succeeded', resultRefs: [{ type: 'weekly_agent_planning', id: plan.planningId, version: plan.version }] };
  } };
}

export async function runSocialWeeklyExecutionScan(input: {
  dataStore?: DataStore;
  adapters: Partial<Record<WeeklyProductionStepKind, SocialWeeklyExecutionAdapter>>;
  workerId?: string;
  maxTasksPerTenant?: number;
  leaseDurationMs?: number;
  now?: Date;
  scope?:WeeklyScanScope;
  readRecoveryEvidence?: DeadlineRecoveryEvidenceReader;
  humanMaterialPorts?: WeeklyMaterialPorts;
  preproductionPorts?: WeeklyTrustedPreproductionPorts;
  metricRecoveryPorts?: Omit<Parameters<typeof runWeeklyMetricCollectionRecoveryScan>[0], 'store' | 'now'>;
}) {
  const dataStore = input.dataStore ?? store;
  const trace=(phase:string)=>{if(process.env.LINGSHU_WEEKLY_SCAN_TRACE==='1')console.log('[weekly-scan-trace]',phase);};
  trace('preproduction:start');
  const preproduction = await runWeeklyPreproductionProducerScan({ ...input.preproductionPorts, store: dataStore, now: input.now,scope:input.scope });
  trace('preproduction:finish');
  const exactAnalysisPortsForRun=input.preproductionPorts?.candidatePorts?.exactAnalysisPortsForRun;
  const preproductionRecovery = await runWeeklyIndependentPreproductionRecovery({ store: dataStore, now: input.now, scope: input.scope, exactAnalysisPortsForRun });
  trace('preproduction-recovery:finish');
  const metricRecovery = await runWeeklyMetricCollectionRecoveryScan({ ...input.metricRecoveryPorts, store: dataStore, now: input.now,scope:input.scope });
  trace('metric-recovery:finish');
  const templateRecovery = await runWeeklyTemplateExtractionRecoveryScan({ store: dataStore, now: input.now,scope:input.scope });
  trace('template-recovery:finish');
  const deadlineRecovery = await runWeeklyDeadlineRecoveryScan({ dataStore, now: input.now, readEvidence: input.readRecoveryEvidence,scope:input.scope });
  trace('deadline-recovery:finish');
  const supplementRecovery = await runWeeklySupplementExceptionScan({ store: dataStore, now: input.now,scope:input.scope });
  trace('supplement-recovery:finish');
  const customerAuthorizationRecovery = await runWeeklyCustomerChannelAuthorizationExceptionScan({ store: dataStore, now: input.now,scope:input.scope });
  trace('customer-recovery:finish');
  const humanMaterialRecovery = await runWeeklyHumanMaterialRecoveryScan({ store: dataStore, now: input.now, materialPorts: input.humanMaterialPorts,scope:input.scope });
  trace('human-material-recovery:finish');
  const productionSelectionRecovery = await runWeeklyProductionSelectionRecoveryScan({store:dataStore,scope:input.scope});
  trace('production-selection-recovery:finish');
  const ctaEvidenceRecovery = await runWeeklyCtaEvidenceRecoveryScan({store:dataStore,scope:input.scope});
  trace('cta-evidence-recovery:finish');
  const presenterVoiceRecovery = await runWeeklyPresenterVoiceRecoveryScan({store:dataStore,scope:input.scope});
  trace('presenter-voice-recovery:finish');
  const worker = createSocialWeeklyExecutionWorker(dataStore,{exactAnalysisPortsForRun});
  const planningAuthority = createSocialWeeklyPlanningAdapter(dataStore,exactAnalysisPortsForRun);
  const workerId = input.workerId ?? `weekly-execution-${process.pid}-${randomUUID()}`;
  const tenants = new Set<string>();
  // Pagination matters: one large tenant must not starve later tenants.
  for (const status of ['queued', 'leased']) {
    for (let page = 1; ; page++) {
      const rows = await dataStore.list<WeeklyExecutionTaskRow>(WEEKLY_EXECUTION_TASKS, { where: { status }, page, perPage: 500 });
      for (const row of rows.items) if (row.tenant_id && row.payload?.tenantId === row.tenant_id&&weeklyScopeMatches(input.scope,row.payload)) tenants.add(row.tenant_id);
      if (page >= rows.totalPages || !rows.items.length) break;
    }
  }
  const report = { claimed: 0, succeeded: 0, pending: 0, blocked: 0, failed: 0, projectionFailed:0 };
  let scopedKinds:WeeklyOperatingWorkflowKind[]|undefined;
  if(input.scope){
    const packages=await dataStore.list<PackageRow>(PACKAGES,{where:{tenant_id:input.scope.tenantId,program_id:input.scope.programId,package_id:input.scope.packageId,version:input.scope.packageVersion},perPage:2});
    const pkg=packages.items[0]?.payload;
    if(packages.totalItems===1&&pkg?.status==='draft'&&await readIndependentAdmission(dataStore,input.scope))scopedKinds=['readiness','discovery','directing','content'];
  }
  for (const tenantId of tenants) {
    for (let count = 0; count < (input.maxTasksPerTenant ?? 25); count++) {
      // Local JSON reads resolve synchronously; a long chain of resolved
      // promises otherwise starves HTTP/health timers while scanning a week.
      await new Promise<void>(resolve=>setImmediate(resolve));
      let claim = await worker.claimNext({ tenantId, workerId, now: input.now, leaseDurationMs: input.leaseDurationMs ?? 120_000,scope:input.scope,kinds:scopedKinds });
      if (!claim) break;
      report.claimed++;
      let lostLease: unknown;
      let renewal = Promise.resolve();
      const timer = setInterval(() => {
        renewal = renewal.then(async () => {
          if (!lostLease) { try { claim = await worker.renew(claim!, { leaseDurationMs: input.leaseDurationMs ?? 120_000, now: input.now }); } catch (error) { lostLease = error; } }
        });
      }, Math.max(100, Math.floor((input.leaseDurationMs ?? 120_000) / 3)));
      timer.unref?.();
      let validatingCompletion = false;
      try {
        const adapter = input.adapters[claim.task.schedule.stepKind];
        let dispatchGate:WeeklyExecutionAdapterResult;
        let inventoryGateReady=false;
        try{
          if(['customer_channel_readiness','customer_inquiry_handoff'].includes(claim.task.schedule.stepKind)){
            const rows=await dataStore.list<PackageRow>(PACKAGES,{where:{tenant_id:claim.task.tenantId,program_id:claim.task.programId,package_id:claim.task.packageId,version:claim.task.packageVersion},perPage:2});
            const pkg=rows.items[0]?.payload;
            // Independent preproduction admissions are deliberately typed with
            // authorizeMessaging:false. Customer work remains dormant until
            // the package is formally active; a draft cannot borrow the
            // production opt-in as customer-message authority.
            dispatchGate=rows.totalItems===1&&pkg?.status==='active'?{status:'succeeded',resultRefs:[]}:{status:'blocked',code:'weekly_package_not_executable',message:'客服任务所属周包尚未启用或未取得消息权限。'};
          }else{
            const {readWeeklyInventoryExecutionGate}=await import('./weeklyInventoryOutlineEvidence.js');const inventoryGate=await readWeeklyInventoryExecutionGate(dataStore,claim.task);inventoryGateReady=Boolean(inventoryGate);dispatchGate=inventoryGate?{status:'succeeded',resultRefs:inventoryGate.resultRefs}:await planningAuthority.execute({ ...claim.task, accountId: null, inputSnapshot: {}, schedule: { ...claim.task.schedule, stepKind: 'business_outline' } });
            // Bound, verified preproduction is necessarily before formal
            // dispatch. Do not make collection wait for its own downstream.
            if(!inventoryGateReady&&['business_outline','benchmark_collection'].includes(claim.task.schedule.stepKind)){
              const producer=await readWeeklyPreproductionExecutionGate(dataStore,claim.task,exactAnalysisPortsForRun);
              if(producer.ready)dispatchGate={status:'succeeded',resultRefs:producer.resultRefs};
            }
          }
        }
        catch(error){if(error instanceof SocialProgramError)dispatchGate={status:'blocked',code:error.code,message:error.message};else throw error;}
        if (dispatchGate.status === 'succeeded' && WEEKLY_ENTERPRISE_FACT_STEPS.has(claim.task.schedule.stepKind)) {
          const facts = await checkWeeklyEnterpriseFactSupplement({ store: dataStore, task: claim.task, now: input.now });
          if (facts.applicable && !facts.ready) dispatchGate = { status: 'blocked', code: facts.code, message: facts.reason };
        }
        if (dispatchGate.status === 'succeeded' && !inventoryGateReady && ['business_outline', 'benchmark_collection'].includes(claim.task.schedule.stepKind)) {
          const preproductionGate = await readWeeklyPreproductionExecutionGate(dataStore, claim.task,exactAnalysisPortsForRun);
          if (!preproductionGate.ready) dispatchGate = { status: 'blocked', code: preproductionGate.code ?? 'weekly_preproduction_evidence_required', message: '前置经营或采集尚缺绑定原任务的正式执行证据。' };
        }
        const continuationPending = claim.task.inputSnapshot.weeklyContinuationPending;
        const continuationRef = claim.task.inputSnapshot.weeklyContinuationRef;
        let continuationResult: WeeklyExecutionAdapterResult | undefined;
        if (dispatchGate.status === 'succeeded' && (continuationPending || continuationRef)) {
          try {
            if (!continuationRef) throw new SocialProgramError('weekly_execution_continuation_verification_required', 409, '等待核验原任务复用记录；不能重新启动制作。');
            const ref = continuationRef as import('../../shared/contracts/socialProgram.js').VersionedSocialRef;
            const read = await createWeeklyExecutionContinuationService(dataStore).readValidated({ tenantId: claim.task.tenantId, programId: claim.task.programId, packageId: claim.task.packageId, targetVersion: claim.task.packageVersion, targetTaskId: claim.task.taskId, ref });
            continuationResult = read.status === 'ready' ? { status: 'succeeded', resultRefs: [ref] }
              : { status: read.status, code: read.code ?? 'weekly_continuation_waiting_real_source_settlement', message: '正在核对原任务的真实产物或运行结果；不会启动新版本制作。' };
          } catch (error) {
            if (!(error instanceof SocialProgramError) && !(error instanceof SocialContentWorkflowError)) throw error;
            continuationResult = { status: 'blocked', code: error.code, message: error.message };
          }
        }
        const result = dispatchGate.status !== 'succeeded' ? dispatchGate : continuationResult
          ? continuationResult
          : adapter ? await adapter.execute(claim.task) : { status: 'blocked' as const, code: 'weekly_step_adapter_unavailable', message: '该生产步骤暂缺执行适配器。' };
        clearInterval(timer);
        await renewal;
        if (lostLease) throw lostLease;
        if (result.status === 'succeeded') { validatingCompletion = true; await worker.complete(claim, result.resultRefs, input.now); report.succeeded++; }
        else {
          await worker.defer(claim, { now: input.now, code: result.code, message: result.message, progress: result.progress, retryDelayMs: result.status === 'pending' ? result.retryDelayMs : undefined, blockingReason: result.status === 'blocked' ? result.code : undefined });
          report[result.status]++;
          if (result.status === 'blocked') {
            // The durable task was already deferred. An auxiliary exception
            // projection must not re-fail that settled lease or hide its block.
            // Recovery scans retry projections from the preserved exact gap.
            for(const materialize of [materializeWeeklySupplementException,materializeWeeklyCustomerChannelAuthorizationException])try{await materialize({ store: dataStore, task: claim.task, gapCode: result.code, now: input.now });}catch{report.projectionFailed++;}
          }
        }
      } catch (error) {
        clearInterval(timer);
        await renewal;
        report.failed++;
        const templateInputBlocked = error instanceof SocialProgramError && [400,403,409].includes(error.status) && TEMPLATE_EXECUTION_INPUT_BLOCKERS.has(error.code);
        if (!lostLease && ((error instanceof SocialProgramError && [400,403,409].includes(error.status) && TEMPLATE_EXECUTION_INPUT_BLOCKERS.has(error.code)) || validatingCompletion && ((error instanceof SocialProgramError && [400, 401, 403, 404, 409, 422].includes(error.status)) || (error instanceof SocialContentWorkflowError && ([400, 401, 403, 404, 409, 422].includes(error.status) || ['social_content_file_integrity_violation', 'social_content_file_record_invalid'].includes(error.code)))))) {
          await worker.defer(claim, { now: input.now, code: error.code, message: error.message, blockingReason: error.code }).catch(() => undefined);
          if(templateInputBlocked){report.failed--;report.blocked++;}
        } else if (!lostLease) await worker.fail(claim, { now: input.now, code: 'weekly_execution_adapter_failed', message: error instanceof Error ? error.message : String(error), retryable: true }).catch(() => undefined);
      } finally { clearInterval(timer); }
    }
  }
  const humanMaterialAfterExecution = await runWeeklyHumanMaterialRecoveryScan({ store: dataStore, now: input.now, materialPorts: input.humanMaterialPorts,scope:input.scope });
  const blockedNotifications = await projectWeeklyBlockedTaskNotifications({store:dataStore,scope:input.scope});
  return { ...report, preproduction, preproductionRecovery, metricRecovery, templateRecovery, deadlineRecovery, supplementRecovery, customerAuthorizationRecovery, humanMaterialRecovery, productionSelectionRecovery, ctaEvidenceRecovery, presenterVoiceRecovery, humanMaterialAfterExecution, blockedNotifications };
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
export function initSocialWeeklyExecutionRuntime(adapters: Partial<Record<WeeklyProductionStepKind, SocialWeeklyExecutionAdapter>>, options: { readRecoveryEvidence?: DeadlineRecoveryEvidenceReader; preproductionPorts?:WeeklyTrustedPreproductionPorts } = {}): void {
  if(timer)return;
  if(process.env.SOCIAL_WEEKLY_EXECUTION_WORKER_ENABLED!=='true'){weeklyExecutionObservation.initialize(false);return;}
  const workerId = `weekly-execution-${process.pid}-${randomUUID()}`;
  const tick = () => {
    if (running) return;
    running = true;
    void weeklyExecutionObservation.scan(()=>runSocialWeeklyExecutionScan({ adapters, workerId, readRecoveryEvidence: options.readRecoveryEvidence,preproductionPorts:options.preproductionPorts })).catch(error => console.error('[social-weekly-execution] scan unavailable:', error instanceof Error ? error.message : String(error))).finally(() => { running = false; });
  };
  timer = setInterval(tick, Math.max(1_000, Number(process.env.SOCIAL_WEEKLY_EXECUTION_INTERVAL_MS) || 15_000));
  timer.unref?.();
  weeklyExecutionObservation.initialize(true,workerId);
  tick();
}
