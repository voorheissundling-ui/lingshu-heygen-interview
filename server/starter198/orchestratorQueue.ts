import { createHash } from 'node:crypto';
import type { DataStore, ListResult, Record_ } from '../storage/datastore.js';
import { store } from '../storage/index.js';
import {
  normalizeDigitalEmployeeConfig,
  validateDigitalEmployeeConfig,
  type DigitalEmployeeConfig,
} from '../digitalEmployees/domain.js';
import {
  buildStarter198CapabilityManifest,
  starter198CapabilityAllowed,
  type Starter198AccessSnapshot,
} from './profile.js';
import {
  STARTER_COLLECTIONS,
  starter198Repository,
  type Starter198Repository,
  type StarterRecord,
} from './repository.js';
import {
  assertOrchestratorAdmissionQuota,
  assertStarter198AccessCycleOpen,
  Starter198QuotaError,
} from './quota.js';
import {
  Starter198RuntimePortError,
  type Starter198OrchestratorQueuePort,
  type Starter198OrchestratorQueueResult,
} from './runtimePorts.js';
import { STARTER_CONTENT_RELEASE_APPROVAL_TASK_KEY } from '../../shared/contracts/starter198.js';
import { scheduleSocialContentWork } from './socialContentScheduler.js';
import type { SocialContentAccessResolver } from './socialContentAccess.js';
import { enqueueSocialContentAutoProduction } from './socialContentAutoProduction.js';
import { isInternalBudgetExemptTenant } from '../lib/tenantBudgetExemption.js';

type JsonObject = Record<string, unknown>;
type Row = Record_ & JsonObject;

type StarterPlanTask = {
  key: string;
  title: string;
  description: string;
  agentRole: 'orchestrator' | 'content' | 'traffic' | 'sales';
  kind: 'analysis' | 'planning' | 'production' | 'approval' | 'review';
  sequence: number;
  priority: 'high' | 'medium';
  requiresApproval: boolean;
  dependsOn: string[];
  businessDomain: 'foundation' | 'content' | 'publishing' | 'customer' | 'review';
  capabilityKey: string;
  destination: 'enterprise' | 'socialInspiration' | 'smartAssets' | 'conversion' | 'digitalEmployees';
  destinationView?: 'create' | 'publish';
  statusSource: string;
  executionMode: 'internal' | 'observe' | 'draft_executor' | 'approval';
  externalEffect: 'none' | 'draft';
  automaticExecutionAllowed: boolean;
  policySource: 'starter_198.v1';
};

type ReadyConfiguration = {
  config: DigitalEmployeeConfig;
  configVersion: number;
  policyVersion: string;
  factsVersion: string;
  knowledgeBinding: JsonObject;
};

type StarterInitializationContext = ReadyConfiguration & {
  schemaVersion: 'starter-198.run-initialization.v1';
  initializationId: string;
  input: string;
  inputVersion: string;
  entitlementSnapshotId: string;
  userId: string;
  goalId: string;
  planId: string;
  runId: string;
  startsAt: string;
  endsAt: string;
  primaryPlatform: 'facebook' | 'instagram' | 'tiktok' | 'youtube';
  primaryLanguage: string;
};

const ACTIVE_RUN_STATUSES = [
  'initializing',
  'queued',
  'planning',
  'running',
  'waiting_external',
  'waiting_approval',
  'waiting_human',
  'paused',
  'cancelling',
] as const;

const terminalInboxStates = new Set([
  'queued',
  'attached_to_run',
  'awaiting_initial_confirmation',
]);

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

function jsonObject(value: unknown): JsonObject | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as JsonObject;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonObject : null;
  } catch {
    return null;
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as JsonObject;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function deterministicId(namespace: string, tenantId: string, initializationId: string): string {
  return createHash('sha256').update(`${namespace}:${tenantId}:${initializationId}`).digest('hex').slice(0, 15);
}

function dateOnlyInShanghai(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function primaryPlatform(config: DigitalEmployeeConfig): 'facebook' | 'instagram' | 'tiktok' | 'youtube' {
  const allowed = new Set(['facebook', 'instagram', 'tiktok', 'youtube']);
  const configured = config.publishingTargets.find(target => allowed.has(target.platform))?.platform;
  const preferred = text(config.videoDefaults?.platform);
  return (configured || (allowed.has(preferred) ? preferred : 'tiktok')) as 'facebook' | 'instagram' | 'tiktok' | 'youtube';
}

function starterTasks(operatingPlan?: DigitalEmployeeConfig['confirmedOperatingPlan']): StarterPlanTask[] {
  const task = (
    value: Omit<StarterPlanTask, 'sequence' | 'priority' | 'policySource'>,
    index: number,
  ): StarterPlanTask => ({ ...value, sequence: index + 1, priority: index < 7 ? 'high' : 'medium', policySource: 'starter_198.v1' });
  return [
    task({
      key: 'starter_context_snapshot', title: '固化本轮事实、目标与预算',
      description: '灵小枢只读取已确认配置和事实版本，固化 7 日范围与预算；未知字段保持未知。',
      agentRole: 'orchestrator', kind: 'planning', requiresApproval: false, dependsOn: [],
      businessDomain: 'foundation', capabilityKey: 'workflow.standard.run', destination: 'digitalEmployees',
      statusSource: 'starter_orchestrator_inbox + weekly_plans', executionMode: 'internal', externalEffect: 'none', automaticExecutionAllowed: true,
    }, 0),
    task({
      key: 'starter_content_research', title: '研究灵感并保留选题依据',
      description: '灵小图在灵感大屏读取已授权趋势、产品与素材，只产出有来源的内容方向。',
      agentRole: 'content', kind: 'analysis', requiresApproval: false, dependsOn: ['starter_context_snapshot'],
      businessDomain: 'content', capabilityKey: 'production_site.read', destination: 'socialInspiration',
      statusSource: 'trend_videos + content evidence', executionMode: 'observe', externalEffect: 'none', automaticExecutionAllowed: true,
    }, 1),
    task({
      key: 'starter_content_production', title: '生成首发内容与一次优化版',
      description: operatingPlan
        ? `灵小图先推进首条内容的脚本、素材、标题、Tag、成片与版本记录；本周期确认上限为 ${operatingPlan.weeklyMasterCount} 条独立视频、${operatingPlan.weeklyVariantCount} 条平台版本，后续批次须按真实任务继续创建，不把上限伪装为已执行。`
        : '灵小图完成脚本、素材、标题、Tag、基础成片与版本记录；不直接发布。',
      agentRole: 'content', kind: 'production', requiresApproval: false, dependsOn: ['starter_content_research'],
      businessDomain: 'content', capabilityKey: 'workflow.standard.run', destination: 'smartAssets', destinationView: 'create',
      statusSource: 'studio_projects + render jobs', executionMode: 'draft_executor', externalEffect: 'draft', automaticExecutionAllowed: true,
    }, 2),
    task({
      key: 'starter_content_quality_gate', title: '核对事实、品牌、版权与平台格式',
      description: '灵小图淘汰无法证明的表述，并为最终内容版本生成可核验哈希。',
      agentRole: 'content', kind: 'analysis', requiresApproval: false, dependsOn: ['starter_content_production'],
      businessDomain: 'content', capabilityKey: 'workflow.standard.run', destination: 'smartAssets', destinationView: 'create',
      statusSource: 'studio project quality state', executionMode: 'observe', externalEffect: 'none', automaticExecutionAllowed: true,
    }, 3),
    task({
      key: STARTER_CONTENT_RELEASE_APPROVAL_TASK_KEY, title: '等待最终内容版本审批',
      description: '用户只在灵小枢批准或退回最终版本；批准仅允许生成发布包，不授权平台发布或广告消费。',
      agentRole: 'content', kind: 'approval', requiresApproval: true, dependsOn: ['starter_content_quality_gate'],
      businessDomain: 'content', capabilityKey: 'orchestrator.decision.resolve', destination: 'digitalEmployees',
      statusSource: 'approval_requests', executionMode: 'approval', externalEffect: 'none', automaticExecutionAllowed: false,
    }, 4),
    task({
      key: 'starter_publication_package', title: '生成主平台自助发布包',
      description: operatingPlan
        ? `已确认 ${operatingPlan.plannedAccounts.length} 个计划账号；当前标准链只为已批准的首条内容生成主平台自助发布包，不建立发布日历、不调用官方发布 API，也不标记已发布。`
        : '灵小量只为已批准内容生成发布包；不调用官方发布 API、不建立发布日历、不标记已发布。',
      agentRole: 'traffic', kind: 'production', requiresApproval: false, dependsOn: [STARTER_CONTENT_RELEASE_APPROVAL_TASK_KEY],
      businessDomain: 'publishing', capabilityKey: 'publishing.package.generate', destination: 'smartAssets', destinationView: 'publish',
      statusSource: 'starter_publication_packages', executionMode: 'internal', externalEffect: 'draft', automaticExecutionAllowed: true,
    }, 5),
    task({
      key: 'starter_publication_evidence', title: '等待并核验人工发布证据',
      description: '灵小量等待公开 URL 或平台 ID；没有可验证证据时保持等待，不把发布包当成发布成功。',
      agentRole: 'traffic', kind: 'analysis', requiresApproval: false, dependsOn: ['starter_publication_package'],
      businessDomain: 'publishing', capabilityKey: 'publishing.evidence.submit', destination: 'smartAssets', destinationView: 'publish',
      statusSource: 'starter_publication_packages.evidence', executionMode: 'observe', externalEffect: 'none', automaticExecutionAllowed: true,
    }, 6),
    task({
      key: 'starter_inquiry_intake', title: '等待并结构化真实询盘',
      description: '灵小售只处理真实导入的询盘并合并必要缺项；不预造客户、不自动对外回复。',
      agentRole: 'sales', kind: 'analysis', requiresApproval: false, dependsOn: ['starter_context_snapshot'],
      businessDomain: 'customer', capabilityKey: 'quotation.calculate', destination: 'conversion',
      statusSource: 'inquiries + inquiry_sources', executionMode: 'observe', externalEffect: 'none', automaticExecutionAllowed: true,
    }, 7),
    task({
      key: 'starter_quote_draft', title: '生成确定性报价草稿',
      description: '灵小售提取字段后调用版本化计价服务；模型不计算金额，草稿未经批准不会发送。',
      agentRole: 'sales', kind: 'production', requiresApproval: true, dependsOn: ['starter_inquiry_intake'],
      businessDomain: 'customer', capabilityKey: 'quotation.calculate', destination: 'conversion',
      statusSource: 'quote_drafts + quote_calculations', executionMode: 'internal', externalEffect: 'draft', automaticExecutionAllowed: true,
    }, 8),
    task({
      key: 'starter_result_summary', title: '汇总 7 日成果与真实数据缺口',
      description: '灵小枢汇总内容、发布证据、真实询盘和报价；未发生或未知的结果不会写成成功。',
      agentRole: 'orchestrator', kind: 'review', requiresApproval: false,
      dependsOn: ['starter_publication_evidence', 'starter_quote_draft'],
      businessDomain: 'review', capabilityKey: 'workflow.standard.run', destination: 'digitalEmployees',
      statusSource: 'workflow_tasks + evidence', executionMode: 'internal', externalEffect: 'none', automaticExecutionAllowed: true,
    }, 9),
  ];
}

function assertConfirmedPlanAllowed(config: DigitalEmployeeConfig, access: Starter198AccessSnapshot): void {
  const plan = config.confirmedOperatingPlan;
  if (!plan) return;
  const limits = access.resourceLimits;
  const overallBudget = Math.max(0, Number(limits.budgetCnyPerCycle) || 0);
  const contentBudget = Math.max(0, Number(limits.agentBudgetCny?.content) || 0);
  const effectiveBudget = Math.min(overallBudget, contentBudget);
  if (plan.plannedAccounts.length > limits.primaryPlatformCount
    || plan.weeklyMasterCount > limits.contentArtifactCountPerCycle
    || (!isInternalBudgetExemptTenant(access.tenantId) && plan.estimatedCostCny.max > effectiveBudget)) {
    throw new Starter198RuntimePortError('starter_198_confirmed_plan_entitlement_changed', 409);
  }
}

function inboxResult(record: StarterRecord): Starter198OrchestratorQueueResult | null {
  const queueItemId = text(record.queue_item_id);
  const disposition = text(record.disposition);
  if (!queueItemId || !terminalInboxStates.has(disposition)) return null;
  return {
    queueItemId,
    disposition: disposition as Starter198OrchestratorQueueResult['disposition'],
    ...(text(record.run_id) ? { runId: text(record.run_id) } : {}),
    missingFacts: Array.isArray(record.missing_facts)
      ? record.missing_facts.filter((item): item is string => typeof item === 'string')
      : [],
  };
}

function ensureListComplete(result: ListResult<Row>, code: string): void {
  if (!Array.isArray(result.items) || !Number.isFinite(result.totalItems) || result.totalItems > result.items.length) {
    throw new Starter198RuntimePortError(code, 503);
  }
}

async function listActiveRuns(dataStore: DataStore, tenantId: string): Promise<Row[]> {
  const results = await Promise.all(ACTIVE_RUN_STATUSES.map(status => dataStore.list<Row>('workflow_runs', {
    where: { tenant_id: tenantId, status }, perPage: 2, sort: '-started_at',
  })));
  results.forEach(result => ensureListComplete(result, 'starter_198_run_state_unavailable'));
  const runs = results.flatMap(result => result.items);
  if (runs.some(run => text(run.tenant_id) !== tenantId)) {
    throw new Starter198RuntimePortError('starter_198_run_state_integrity_violation', 503);
  }
  if (runs.length > 1) {
    throw new Starter198RuntimePortError('starter_198_concurrent_run_integrity_violation', 503);
  }
  return runs;
}

async function readConfiguration(dataStore: DataStore, tenantId: string): Promise<{
  ready: ReadyConfiguration | null;
  missingFacts: string[];
}> {
  const result = await dataStore.list<Row>('digital_employee_configs', {
    where: { tenant_id: tenantId }, sort: '-updated_at', perPage: 2,
  });
  ensureListComplete(result, 'starter_198_configuration_unavailable');
  if (result.items.length > 1) {
    throw new Starter198RuntimePortError('starter_198_configuration_integrity_violation', 503);
  }
  const record = result.items[0];
  if (!record) return { ready: null, missingFacts: ['digital_employee_configuration'] };
  if (text(record.tenant_id) !== tenantId) {
    throw new Starter198RuntimePortError('starter_198_configuration_integrity_violation', 503);
  }
  const source = jsonObject(record.config);
  const effective = jsonObject(record.effective_config);
  const knowledgeBinding = jsonObject(effective?.knowledgeBinding);
  const config = normalizeDigitalEmployeeConfig(source ?? {});
  const missing = validateDigitalEmployeeConfig(config).map(label => `configuration:${label}`);
  if (source && Object.prototype.hasOwnProperty.call(source, 'confirmedOperatingPlan') && !config.confirmedOperatingPlan) {
    missing.push('configuration:confirmed_operating_plan_invalid');
  }
  if (text(record.status) !== 'active') missing.push('configuration:not_active');
  if (!text(record.activated_at)) missing.push('configuration:not_confirmed');
  const configVersion = Number(record.config_version);
  const policyVersion = text(record.policy_version);
  const factsVersion = text(record.facts_version);
  if (!Number.isInteger(configVersion) || configVersion < 1) missing.push('configuration:version');
  if (!policyVersion) missing.push('policy:version');
  if (!factsVersion) missing.push('facts:version');
  if (!knowledgeBinding) missing.push('facts:confirmed_snapshot');
  if (text(knowledgeBinding?.factsVersion) !== factsVersion) missing.push('facts:snapshot_version_mismatch');
  const warnings = knowledgeBinding?.warnings;
  if (Array.isArray(warnings)) {
    missing.push(...warnings.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())));
  }
  if (!text(config.focusProducts)) missing.push('enterprise.focus_products_missing');
  const unique = [...new Set(missing)];
  return unique.length ? { ready: null, missingFacts: unique } : {
    ready: { config, configVersion, policyVersion, factsVersion, knowledgeBinding: knowledgeBinding! },
    missingFacts: [],
  };
}

async function requiredUpdate(
  dataStore: DataStore,
  collection: string,
  id: string,
  patch: JsonObject,
  errorCode: string,
): Promise<void> {
  if (!await dataStore.update(collection, id, patch)) {
    throw new Starter198RuntimePortError(errorCode, 503);
  }
}

async function ensureRecord(
  dataStore: DataStore,
  collection: string,
  id: string,
  tenantId: string,
  payload: JsonObject,
  integrity: (row: Row) => boolean,
): Promise<Row> {
  const current = await dataStore.getById<Row>(collection, id);
  if (current) {
    if (text(current.tenant_id) !== tenantId || !integrity(current)) {
      throw new Starter198RuntimePortError('starter_198_run_initialization_integrity_violation', 503);
    }
    return current;
  }
  let created: Row | null = null;
  try {
    created = await dataStore.create<Row>(collection, { id, ...payload, tenant_id: tenantId });
  } catch {
    // A concurrent initializer may have won the deterministic unique key.
    // Always re-read and verify the immutable identity before deciding.
  }
  if (created) {
    if (text(created.tenant_id) !== tenantId || !integrity(created)) {
      throw new Starter198RuntimePortError('starter_198_run_initialization_integrity_violation', 503);
    }
    return created;
  }
  const raced = await dataStore.getById<Row>(collection, id);
  if (!raced || text(raced.tenant_id) !== tenantId || !integrity(raced)) {
    throw new Starter198RuntimePortError('starter_198_run_initialization_storage_unavailable', 503);
  }
  return raced;
}

function initializationFromRun(run: Row): StarterInitializationContext | null {
  const context = jsonObject(run.starter_context);
  if (!context || context.schemaVersion !== 'starter-198.run-initialization.v1') return null;
  const required = [
    'initializationId', 'input', 'inputVersion', 'entitlementSnapshotId', 'userId',
    'goalId', 'planId', 'runId', 'startsAt', 'endsAt', 'policyVersion', 'factsVersion',
    'primaryPlatform', 'primaryLanguage',
  ];
  if (required.some(key => !text(context[key])) || Number(context.configVersion) < 1 || !jsonObject(context.config) || !jsonObject(context.knowledgeBinding)) return null;
  if (text(context.runId) !== run.id || text(run.tenant_id) === '') return null;
  return context as unknown as StarterInitializationContext;
}

function buildInitialization(input: {
  tenantId: string;
  userId: string;
  commandId: string;
  text: string;
  access: Starter198AccessSnapshot;
  ready: ReadyConfiguration;
  now: Date;
}): StarterInitializationContext {
  assertConfirmedPlanAllowed(input.ready.config, input.access);
  const inputVersion = hash({ schemaVersion: 1, input: input.text });
  const initializationId = hash({
    tenantId: input.tenantId,
    commandId: input.commandId,
    inputVersion,
    configVersion: input.ready.configVersion,
    factsVersion: input.ready.factsVersion,
    policyVersion: input.ready.policyVersion,
    entitlementSnapshotId: input.access.entitlementSnapshotId,
  });
  const startsAt = dateOnlyInShanghai(input.now);
  return {
    schemaVersion: 'starter-198.run-initialization.v1',
    initializationId,
    input: input.text,
    inputVersion,
    entitlementSnapshotId: input.access.entitlementSnapshotId,
    userId: input.userId,
    goalId: deterministicId('goal', input.tenantId, initializationId),
    planId: deterministicId('plan', input.tenantId, initializationId),
    runId: deterministicId('run', input.tenantId, initializationId),
    startsAt,
    endsAt: addDays(startsAt, 6),
    primaryPlatform: primaryPlatform(input.ready.config),
    primaryLanguage: input.ready.config.videoLanguages[0] || 'en',
    ...input.ready,
  };
}

async function finalizeStarterRun(dataStore: DataStore, tenantId: string, run: Row, now: Date): Promise<Row> {
  const context = initializationFromRun(run);
  if (!context || text(run.product_profile) !== 'starter_198') {
    throw new Starter198RuntimePortError('starter_198_run_initialization_context_invalid', 503);
  }
  const operatingPlan = context.config.confirmedOperatingPlan;
  const tasks = starterTasks(operatingPlan);
  const plan = {
    schemaVersion: 'starter-198.standard-plan.v1',
    planVersion: 1,
    initializationId: context.initializationId,
    inputVersion: context.inputVersion,
    objective: context.input,
    startsAt: context.startsAt,
    endsAt: context.endsAt,
    primaryPlatform: context.primaryPlatform,
    primaryLanguage: context.primaryLanguage,
    ...(operatingPlan ? { operatingPlan } : {}),
    configSnapshot: context.config,
    configVersion: context.configVersion,
    policyVersion: context.policyVersion,
    knowledgeBinding: context.knowledgeBinding,
    entitlementSnapshotId: context.entitlementSnapshotId,
    publicationMode: 'self_service_package',
    paidAdsAllowed: false,
    officialApiPublishingAllowed: false,
    quotationMode: 'deterministic_draft_with_human_approval',
    tasks,
  };
  await ensureRecord(dataStore, 'weekly_goals', context.goalId, tenantId, {
    title: `${context.config.companyName} 7 日数字员工任务`,
    objective: context.input,
    metric: 'verified_business_outputs',
    baseline: 0,
    target: 1,
    unit: '轮',
    starts_at: context.startsAt,
    ends_at: context.endsAt,
    scope: {
      schemaVersion: 'starter-198.goal-scope.v1',
      initializationId: context.initializationId,
      product: context.config.focusProducts,
      market: context.config.targetMarkets,
      buyerPersona: context.config.customerProfile,
      platform: context.primaryPlatform,
      ...(operatingPlan ? {
        plannedAccounts: operatingPlan.plannedAccounts,
        weeklyMasterCount: operatingPlan.weeklyMasterCount,
        weeklyVariantCount: operatingPlan.weeklyVariantCount,
        estimatedCostCny: operatingPlan.estimatedCostCny,
        deliveryDays: operatingPlan.deliveryDays,
      } : {}),
      language: context.primaryLanguage,
    },
    constraints: context.config.constraints,
    owner_id: context.userId,
    status: 'active',
    version: 1,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  }, row => text(jsonObject(row.scope)?.initializationId) === context.initializationId);
  await ensureRecord(dataStore, 'weekly_plans', context.planId, tenantId, {
    goal_id: context.goalId,
    status: 'generated',
    plan,
    created_at: now.toISOString(),
  }, row => text(row.goal_id) === context.goalId && text(jsonObject(row.plan)?.initializationId) === context.initializationId);
  for (const planned of tasks) {
    const taskId = deterministicId(`task:${planned.key}`, tenantId, context.initializationId);
    await ensureRecord(dataStore, 'workflow_tasks', taskId, tenantId, {
      goal_id: context.goalId,
      plan_id: context.planId,
      run_id: context.runId,
      task_key: planned.key,
      title: planned.title,
      description: planned.description,
      agent_role: planned.agentRole,
      kind: planned.kind,
      status: 'pending',
      sequence: planned.sequence,
      priority: planned.priority,
      requires_approval: planned.requiresApproval,
      depends_on: planned.dependsOn,
      output: {
        schemaVersion: 'starter-198.task-checkpoint.v1',
        planVersion: 1,
        inputVersion: context.inputVersion,
        executionStatus: 'not_started',
      },
      blocked_reason: '',
      owner_id: '',
      business_domain: planned.businessDomain,
      capability_key: planned.capabilityKey,
      destination: planned.destination,
      destination_view: planned.destinationView ?? '',
      status_source: planned.statusSource,
      execution_mode: planned.executionMode,
      external_effect: planned.externalEffect,
      automatic_execution_allowed: planned.automaticExecutionAllowed,
      policy_source: planned.policySource,
      business_refs: [],
      task_version: 1,
      correction_version: 0,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    }, row => text(row.run_id) === context.runId && text(row.task_key) === planned.key);
  }
  const eventId = deterministicId('event:queued', tenantId, context.initializationId);
  await ensureRecord(dataStore, 'run_events', eventId, tenantId, {
    run_id: context.runId,
    task_id: '',
    sequence: 1,
    type: 'workflow.queued',
    level: 'info',
    summary: '198 标准 7 日工作图已固化，等待专用执行器领取',
    payload: {
      schemaVersion: 'starter-198.workflow-queued.v1',
      planVersion: 1,
      inputVersion: context.inputVersion,
      factsVersion: context.factsVersion,
      policyVersion: context.policyVersion,
      executed: false,
    },
    occurred_at: now.toISOString(),
  }, row => text(row.run_id) === context.runId && Number(row.sequence) === 1);
  await requiredUpdate(dataStore, 'workflow_runs', run.id, {
    status: 'queued',
    current_controller: 'agent',
    pause_reason: '等待 starter_198 专用执行器领取；尚未执行',
    queued_at: now.toISOString(),
  }, 'starter_198_run_initialization_storage_unavailable');
  const updated = await dataStore.getById<Row>('workflow_runs', run.id);
  if (!updated || text(updated.tenant_id) !== tenantId || text(updated.status) !== 'queued') {
    throw new Starter198RuntimePortError('starter_198_run_initialization_storage_unavailable', 503);
  }
  return updated;
}

async function createOrRecoverRun(input: {
  dataStore: DataStore;
  repository: Starter198Repository;
  tenantId: string;
  userId: string;
  commandId: string;
  text: string;
  access: Starter198AccessSnapshot;
  ready: ReadyConfiguration;
  now: Date;
}): Promise<Row> {
  try {
    await assertOrchestratorAdmissionQuota({
      repository: input.repository,
      tenantId: input.tenantId,
      limits: input.access.resourceLimits,
    });
  } catch (error) {
    if (error instanceof Starter198QuotaError) {
      throw new Starter198RuntimePortError(error.code, error.status);
    }
    throw error;
  }
  const context = buildInitialization(input);
  let run = await input.dataStore.getById<Row>('workflow_runs', context.runId);
  if (!run) {
    try {
      run = await input.dataStore.create<Row>('workflow_runs', {
        id: context.runId,
        tenant_id: input.tenantId,
        goal_id: context.goalId,
        plan_id: context.planId,
        status: 'initializing',
        current_controller: 'agent',
        pause_reason: '正在持久化 198 标准工作图；尚未执行',
        product_profile: 'starter_198',
        starter_initialization_id: context.initializationId,
        starter_input_version: context.inputVersion,
        starter_plan_version: 1,
        starter_context: context,
        started_at: input.now.toISOString(),
        completed_at: '',
      });
    } catch {
      // The partial unique active-run guard may have selected another request.
      // Resolve that race below instead of reporting a false new run.
    }
  }
  if (!run) {
    const winner = await listActiveRuns(input.dataStore, input.tenantId);
    if (winner.length === 1) return winner[0];
    throw new Starter198RuntimePortError('starter_198_run_initialization_storage_unavailable', 503);
  }
  if (text(run.tenant_id) !== input.tenantId
    || text(run.product_profile) !== 'starter_198'
    || text(run.starter_initialization_id) !== context.initializationId) {
    throw new Starter198RuntimePortError('starter_198_run_initialization_integrity_violation', 503);
  }
  return finalizeStarterRun(input.dataStore, input.tenantId, run, input.now);
}

async function createInbox(input: {
  repository: Starter198Repository;
  tenantId: string;
  userId: string;
  commandId: string;
  text: string;
  idempotencyKey: string;
  now: Date;
}): Promise<{ record: StarterRecord; created: boolean }> {
  const inputHash = hash({ schemaVersion: 1, input: input.text });
  const find = async () => input.repository.list(STARTER_COLLECTIONS.orchestratorInbox, input.tenantId, {
    where: { idempotency_key: input.idempotencyKey }, perPage: 2,
  });
  const existing = await find();
  if (existing.totalItems > 1 || existing.items.length > 1) {
    throw new Starter198RuntimePortError('starter_198_orchestrator_inbox_integrity_violation', 503);
  }
  if (existing.items[0]) {
    const record = existing.items[0];
    if (text(record.command_id) !== input.commandId || text(record.input_hash) !== inputHash) {
      throw new Starter198RuntimePortError('starter_198_orchestrator_inbox_idempotency_conflict', 409);
    }
    return { record, created: false };
  }
  const queueItemId = `orchestrator:${hash({ tenantId: input.tenantId, idempotencyKey: input.idempotencyKey }).slice(0, 32)}`;
  try {
    const record = await input.repository.create(STARTER_COLLECTIONS.orchestratorInbox, input.tenantId, {
      queue_item_id: queueItemId,
      command_id: input.commandId,
      idempotency_key: input.idempotencyKey,
      input_text: input.text,
      input_hash: inputHash,
      input_version: inputHash,
      run_id: '',
      disposition: 'processing',
      status: 'processing',
      missing_facts: [],
      error_code: '',
      created_by: input.userId,
      created_at: input.now.toISOString(),
      updated_at: input.now.toISOString(),
    });
    return { record, created: true };
  } catch {
    const raced = await find();
    const record = raced.items.length === 1 ? raced.items[0] : null;
    if (!record || text(record.command_id) !== input.commandId || text(record.input_hash) !== inputHash) {
      throw new Starter198RuntimePortError('starter_198_orchestrator_inbox_storage_unavailable', 503);
    }
    return { record, created: false };
  }
}

export function createStarter198OrchestratorQueue(dependencies: {
  repository?: Starter198Repository;
  dataStore?: DataStore;
  socialContentAccessResolver?: SocialContentAccessResolver;
  socialContentProductionRunner?: (
    input: Parameters<typeof enqueueSocialContentAutoProduction>[0],
  ) => void | Promise<void>;
  materialEvidencePorts?: Parameters<typeof scheduleSocialContentWork>[0]['materialEvidencePorts'];
  now?: () => Date;
} = {}): Starter198OrchestratorQueuePort {
  const repository = dependencies.repository ?? starter198Repository;
  const dataStore = dependencies.dataStore ?? store;
  return {
    async enqueue(input): Promise<Starter198OrchestratorQueueResult> {
      const now = dependencies.now?.() ?? new Date();
      if (!text(input.tenantId) || !text(input.userId) || !text(input.commandId)
        || !text(input.input) || !text(input.idempotencyKey)) {
        throw new Starter198RuntimePortError('starter_198_orchestrator_input_invalid', 400);
      }
      if (input.workflowScope === 'social_content') {
        return scheduleSocialContentWork({
          repository,
          queue: input,
          now,
          accessResolver: dependencies.socialContentAccessResolver,
          productionRunner: dependencies.socialContentProductionRunner
            ?? (dataStore === store ? enqueueSocialContentAutoProduction : undefined),
          materialEvidencePorts: dependencies.materialEvidencePorts,
        });
      }
      const access = await repository.access(input.tenantId);
      try { assertStarter198AccessCycleOpen({ access, now }); }
      catch (error) {
        if (error instanceof Starter198QuotaError) {
          throw new Starter198RuntimePortError(error.code, error.status);
        }
        throw error;
      }
      const manifest = buildStarter198CapabilityManifest(access, now);
      if (!starter198CapabilityAllowed(manifest, 'workflow.standard.run')) {
        throw new Starter198RuntimePortError('starter_198_standard_workflow_not_entitled', 403);
      }
      const inbox = await createInbox({
        repository, tenantId: input.tenantId, userId: input.userId, commandId: input.commandId,
        text: input.input, idempotencyKey: input.idempotencyKey, now,
      });
      const prior = inboxResult(inbox.record);
      if (prior) return prior;
      if (!inbox.created && text(inbox.record.status) !== 'processing' && text(inbox.record.status) !== 'failed') {
        throw new Starter198RuntimePortError('starter_198_orchestrator_inbox_state_unknown', 409);
      }
      try {
        let active = await listActiveRuns(dataStore, input.tenantId);
        if (active[0] && text(active[0].status) === 'initializing' && text(active[0].product_profile) === 'starter_198') {
          active = [await finalizeStarterRun(dataStore, input.tenantId, active[0], now)];
        }
        if (active[0]) {
          if (text(active[0].product_profile) !== 'starter_198') {
            throw new Starter198RuntimePortError('starter_198_active_run_profile_mismatch', 409);
          }
          await repository.update(STARTER_COLLECTIONS.orchestratorInbox, input.tenantId, inbox.record.id, {
            run_id: active[0].id,
            disposition: 'attached_to_run',
            status: 'pending',
            missing_facts: [],
            error_code: '',
            updated_at: now.toISOString(),
          });
          return { queueItemId: text(inbox.record.queue_item_id), runId: active[0].id, disposition: 'attached_to_run', missingFacts: [] };
        }
        const configuration = await readConfiguration(dataStore, input.tenantId);
        if (!configuration.ready) {
          await repository.update(STARTER_COLLECTIONS.orchestratorInbox, input.tenantId, inbox.record.id, {
            disposition: 'awaiting_initial_confirmation',
            status: 'waiting_user',
            missing_facts: configuration.missingFacts,
            error_code: '',
            updated_at: now.toISOString(),
          });
          return {
            queueItemId: text(inbox.record.queue_item_id),
            disposition: 'awaiting_initial_confirmation',
            missingFacts: configuration.missingFacts,
          };
        }
        const run = await createOrRecoverRun({
          dataStore, repository, tenantId: input.tenantId, userId: input.userId,
          commandId: input.commandId, text: input.input, access, ready: configuration.ready, now,
        });
        const disposition = text(run.starter_initialization_id) === text(jsonObject(run.starter_context)?.initializationId)
          && text(jsonObject(run.starter_context)?.inputVersion) === text(inbox.record.input_version)
          ? 'queued'
          : 'attached_to_run';
        await repository.update(STARTER_COLLECTIONS.orchestratorInbox, input.tenantId, inbox.record.id, {
          run_id: run.id,
          disposition,
          status: 'pending',
          missing_facts: [],
          error_code: '',
          updated_at: now.toISOString(),
        });
        return { queueItemId: text(inbox.record.queue_item_id), runId: run.id, disposition, missingFacts: [] };
      } catch (error) {
        const failure = error instanceof Starter198RuntimePortError
          ? error
          : new Starter198RuntimePortError('starter_198_orchestrator_queue_failed', 503);
        await repository.update(STARTER_COLLECTIONS.orchestratorInbox, input.tenantId, inbox.record.id, {
          disposition: 'failed', status: 'failed', error_code: failure.code, updated_at: now.toISOString(),
        }).catch(() => undefined);
        throw failure;
      }
    },
  };
}
