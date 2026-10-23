export type DigitalHumanToolId = 'heygen' | 'local_head_pipeline' | 'runway_seedance' | 'runway_kling_motion' | 'runway_act_two' | 'self_hosted_video';

/** The supplier explicitly rejected task creation, so no remote task needs reconciliation. */
export class DefinitiveSupplierSubmissionError extends Error {
  readonly definitiveSubmissionRejection = true;
}

export function isDefinitiveSupplierSubmissionError(error: unknown): error is DefinitiveSupplierSubmissionError {
  return error instanceof DefinitiveSupplierSubmissionError || Boolean(error && typeof error === 'object'
    && (error as { definitiveSubmissionRejection?: unknown }).definitiveSubmissionRejection === true);
}

export interface DigitalHumanToolCapability {
  id: DigitalHumanToolId;
  label: string;
  methods: Array<'talking' | 'replace' | 'reenact'>;
  planning: boolean;
  execution: boolean;
  qualityInspection: boolean;
  cancellation: boolean;
  costReconciliation: boolean;
  reason: string;
  executionProfile?: DigitalHumanExecutionAdapter['executionProfile'];
}

export interface DigitalHumanExecutionAdapter {
  id: DigitalHumanToolId;
  methods: Array<'talking' | 'replace' | 'reenact'>;
  executionProfile?: {
    maxDurationSeconds?: number;
    preserves: Array<'identity' | 'motion' | 'product' | 'background' | 'composition'>;
    qualityInspection: boolean;
    estimatedCostCnyPerSecond?: number;
  };
  submit(input: unknown, idempotencyKey: string): Promise<{ externalTaskId: string }>;
  status(externalTaskId: string): Promise<{
    state: 'pending' | 'completed' | 'failed';
    outputUrl?: string;
    /** Tenant-scoped durable output produced by a local post-processing step. */
    outputObjectKey?: string;
    error?: string;
    /** Supplier-confirmed amount only. Never put an estimate here. */
    actualCostCny?: number;
    /** Invoice, usage-record or supplier transaction reference supporting actualCostCny. */
    costSourceRef?: string;
  }>;
  /** Query immutable supplier usage or invoice evidence without resubmitting generation. */
  cost?(externalTaskId: string): Promise<{ actualCostCny?: number; costSourceRef?: string }>;
  cancel?(externalTaskId: string): Promise<{ cancelled: boolean; reason?: string }>;
}

export type ReferencePreservation = NonNullable<DigitalHumanExecutionAdapter['executionProfile']>['preserves'][number];

export function requiredReferencePreservation(input: { preserve?: string; productMaterialId?: string; backgroundMaterialId?: string }): ReferencePreservation[] {
  const text = String(input.preserve || '');
  const required: ReferencePreservation[] = ['identity'];
  if (/动作|姿态|手势|节奏|motion|pose|gesture/i.test(text)) required.push('motion');
  if (input.productMaterialId || /产品|商品|设备|配件|product|sku/i.test(text)) required.push('product');
  if (input.backgroundMaterialId || /背景|场景|环境|background|scene/i.test(text)) required.push('background');
  if (/构图|机位|镜头结构|景别|composition|camera|framing/i.test(text)) required.push('composition');
  return [...new Set(required)];
}

export function selectReferenceAdapter(input: {
  adapters: DigitalHumanExecutionAdapter[];
  candidates: string[];
  method: 'replace' | 'reenact';
  targetDurationSeconds?: number | null;
  maxEstimatedCostCny?: number | null;
  requiredPreservation: ReferencePreservation[];
}): { adapter?: DigitalHumanExecutionAdapter; reason: string; estimatedCostCny: number | null; evaluations: Array<{ tool: string; compatible: boolean; reasons: string[]; qualityInspection: boolean; estimatedCostCny: number | null }> } {
  const evaluated = input.candidates.map((id, order) => input.adapters.find(adapter => adapter.id === id && adapter.methods.includes(input.method)))
    .filter((adapter): adapter is DigitalHumanExecutionAdapter => Boolean(adapter))
    .map((adapter, order) => {
      const profile = adapter.executionProfile;
      const duration = Number(input.targetDurationSeconds);
      // Registration proves the adapter can perform the declared method and preserve the
      // target person. Stronger product/background/composition claims require an explicit profile.
      const supported = profile?.preserves || ['identity'];
      const missing = input.requiredPreservation.filter(item => !supported.includes(item));
      const durationInvalid = input.targetDurationSeconds != null && (!Number.isFinite(duration) || duration <= 0);
      const profileInvalid = Boolean(profile && (
        (profile.maxDurationSeconds != null && (!Number.isFinite(profile.maxDurationSeconds) || profile.maxDurationSeconds <= 0))
        || (profile.estimatedCostCnyPerSecond != null && (!Number.isFinite(profile.estimatedCostCnyPerSecond) || profile.estimatedCostCnyPerSecond < 0))
      ));
      const durationExceeded = Boolean(profile?.maxDurationSeconds && Number.isFinite(duration) && duration > profile.maxDurationSeconds);
      const rawEstimatedCostCny = profile?.estimatedCostCnyPerSecond != null && Number.isFinite(duration) && duration > 0
        ? Number((duration * profile.estimatedCostCnyPerSecond).toFixed(2)) : null;
      const estimateInvalid = rawEstimatedCostCny != null && (!Number.isFinite(rawEstimatedCostCny) || rawEstimatedCostCny < 0);
      const estimatedCostCny = estimateInvalid ? null : rawEstimatedCostCny;
      const budgetLimit = Number(input.maxEstimatedCostCny);
      const budgetInvalid = input.maxEstimatedCostCny != null && (!Number.isFinite(budgetLimit) || budgetLimit < 0);
      const budgetConfigured = input.maxEstimatedCostCny != null && Number.isFinite(budgetLimit) && budgetLimit >= 0;
      const budgetUnknown = budgetConfigured && estimatedCostCny == null;
      const budgetExceeded = budgetConfigured && estimatedCostCny != null && estimatedCostCny > budgetLimit;
      return { adapter, order, profile, missing, durationExceeded, durationInvalid, profileInvalid, estimateInvalid, budgetInvalid, estimatedCostCny, budgetUnknown, budgetExceeded };
    });
  const compatible = evaluated.filter(item => !item.durationInvalid && !item.profileInvalid && !item.estimateInvalid && !item.budgetInvalid && !item.durationExceeded && item.missing.length === 0 && !item.budgetUnknown && !item.budgetExceeded)
    .sort((a, b) => Number(Boolean(b.profile?.qualityInspection)) - Number(Boolean(a.profile?.qualityInspection))
      || (a.estimatedCostCny ?? Number.MAX_SAFE_INTEGER) - (b.estimatedCostCny ?? Number.MAX_SAFE_INTEGER) || a.order - b.order)[0];
  const evaluations = evaluated.map(item => ({ tool: item.adapter.id, compatible: !item.durationInvalid && !item.profileInvalid && !item.estimateInvalid && !item.budgetInvalid && !item.durationExceeded && item.missing.length === 0 && !item.budgetUnknown && !item.budgetExceeded,
    reasons: [...(item.durationInvalid ? ['镜头时长必须是有限正数'] : []), ...(item.budgetInvalid ? ['预算上限必须是有限非负数'] : []), ...(item.profileInvalid || item.estimateInvalid ? ['供应商时长或估价配置无效'] : []), ...(item.durationExceeded ? [`最长支持 ${item.profile?.maxDurationSeconds} 秒`] : []), ...(item.missing.length ? [`不能保证保留：${item.missing.join('、')}`] : []),
      ...(item.budgetUnknown ? ['未声明估价，无法验证预算'] : []), ...(item.budgetExceeded ? [`预计 ¥${item.estimatedCostCny?.toFixed(2)} 超出预算上限 ¥${Number(input.maxEstimatedCostCny).toFixed(2)}`] : [])],
    qualityInspection: Boolean(item.profile?.qualityInspection), estimatedCostCny: item.estimatedCostCny }));
  if (compatible) return { adapter: compatible.adapter, reason: '', estimatedCostCny: compatible.estimatedCostCny, evaluations };
  if (!evaluated.length) return { reason: '服务端没有注册支持当前制作方式的真实执行适配器', estimatedCostCny: null, evaluations: [] };
  const details = evaluations.map(item => `${item.tool} ${item.reasons.join('、')}`).join('；');
  return { reason: `已接入工具不满足当前镜头约束：${details}`, estimatedCostCny: null, evaluations };
}

export function referenceAdapterFor(
  adapters: DigitalHumanExecutionAdapter[],
  candidates: string[],
  method: 'replace' | 'reenact',
): DigitalHumanExecutionAdapter | undefined {
  return selectReferenceAdapter({ adapters, candidates, method, requiredPreservation: ['identity'] }).adapter;
}

export function verifiedSupplierCost(input: { actualCostCny?: number; costSourceRef?: string }): { actualCostCny: number; costSourceRef: string } | null {
  if (input.actualCostCny === undefined && input.costSourceRef === undefined) return null;
  const amount = Number(input.actualCostCny); const sourceRef = String(input.costSourceRef || '').trim();
  if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000 || !sourceRef || sourceRef.length > 300) {
    throw new Error('供应商返回了不完整或无效的实际费用依据，执行状态未更新');
  }
  return { actualCostCny: Number(amount.toFixed(4)), costSourceRef: sourceRef };
}

const LABELS: Record<DigitalHumanToolId, string> = {
  heygen: 'HeyGen 人物口播',
  local_head_pipeline: '本地逐帧人物处理',
  runway_seedance: 'Seedance 参考人物重演',
  runway_kling_motion: 'Kling 参考动作生成',
  runway_act_two: 'Runway Act-Two 人物驱动',
  self_hosted_video: '自有数字人模型',
};

const METHODS: Record<DigitalHumanToolId, DigitalHumanToolCapability['methods']> = {
  heygen: ['talking'],
  local_head_pipeline: ['replace'],
  runway_seedance: ['reenact'],
  runway_kling_motion: ['replace', 'reenact'],
  runway_act_two: ['reenact'],
  self_hosted_video: ['replace', 'reenact'],
};

export function digitalHumanToolCapabilities(input: {
  talkingEnabled: boolean;
  talkingCostReconciliation?: boolean;
  adapters?: DigitalHumanExecutionAdapter[];
  unavailableReasons?: Partial<Record<DigitalHumanToolId, string>>;
}): DigitalHumanToolCapability[] {
  const adapters = new Map((input.adapters ?? []).map(adapter => [adapter.id, adapter]));
  return (Object.keys(LABELS) as DigitalHumanToolId[]).map(id => {
    const adapter = adapters.get(id);
    const talking = id === 'heygen' && input.talkingEnabled;
    const execution = talking || Boolean(adapter);
    const methods = adapter?.methods?.length ? [...adapter.methods] : METHODS[id];
    return {
      id,
      label: LABELS[id],
      methods,
      planning: true,
      execution,
      qualityInspection: talking || adapter?.executionProfile?.qualityInspection === true,
      cancellation: Boolean(adapter?.cancel),
      costReconciliation: Boolean(adapter?.cost) || (id === 'heygen' && Boolean(input.talkingCostReconciliation)),
      ...(adapter?.executionProfile ? { executionProfile: structuredClone(adapter.executionProfile) } : {}),
      reason: execution
        ? '服务端已注册真实执行适配器；提交仍需逐镜内容确认、预算准入和幂等任务标识'
        : input.unavailableReasons?.[id]
          ? input.unavailableReasons[id]!
        : id === 'runway_seedance'
          ? '当前仅有通用 Seedance 视频生成，不能执行参考人物身份与逐句保留约束'
          : '服务端未注册该参考人物执行适配器，仅支持方案规划',
    };
  });
}
