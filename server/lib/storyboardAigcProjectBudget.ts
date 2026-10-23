import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { withPaidOperationLock } from './paidOperationLock.js';
import { isInternalBudgetExemptTenant } from './tenantBudgetExemption.js';

export type StoryboardAigcStage = 'first_frame' | 'video';
export interface StoryboardAigcSpendEntry {
  operationId: string;
  /** Stable pre-provider input identity, before optional observations enrich the final shot spec. */
  inputFingerprint?: string;
  shotId: string;
  stage: StoryboardAigcStage;
  amountMicros: number;
  /** Original reservation stays stable after partial settlement for replay checks. */
  originalAmountMicros?: number;
  status: 'reserved' | 'uncertain' | 'completed';
  at: string;
  output?: Record<string, unknown>;
}
type Ledger = { version: 1; tenantId: string; projectId: string; entries: Record<string, StoryboardAigcSpendEntry> };

const micros = (amount: number) => {
  const result = Math.round(amount * 1e6);
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error('AIGC 预计费用无效，未调用供应商');
  return result;
};

/** Project-local paid-call admission ledger. A supplier-accepted or uncertain
 * call retains its allocation; only a definitively rejected call is released.
 * The same durable operation ID cannot submit twice. */
export class StoryboardAigcProjectBudget {
  constructor(private readonly root = path.resolve(process.env.STORYBOARD_AIGC_BUDGET_DIR || path.join(process.cwd(), 'data/storyboard-aigc-budget')),
    private readonly limitCny = () => Number(process.env.STORYBOARD_AIGC_BATCH_BUDGET_CNY || 30),
    private readonly maxRetries = () => Number(process.env.STORYBOARD_AIGC_MAX_RETRIES || 1)) {}

  private file(tenantId: string, projectId: string) {
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    return path.join(this.root, hash(tenantId), `${hash(projectId)}.json`);
  }
  private read(tenantId: string, projectId: string): Ledger {
    const file = this.file(tenantId, projectId);
    const ledger: Ledger = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8'))
      : { version: 1, tenantId, projectId, entries: {} };
    if (ledger.version !== 1 || ledger.tenantId !== tenantId || ledger.projectId !== projectId
      || !ledger.entries || typeof ledger.entries !== 'object' || Array.isArray(ledger.entries)
      || Object.values(ledger.entries).some(entry => !entry || !Number.isSafeInteger(entry.amountMicros)
        || entry.amountMicros <= 0 || !['first_frame', 'video'].includes(entry.stage)
        || !['reserved', 'uncertain', 'completed'].includes(entry.status))) {
      throw new Error('分镜 AIGC 预算账本异常，请先核账；未调用供应商');
    }
    return ledger;
  }
  private write(ledger: Ledger) {
    const file = this.file(ledger.tenantId, ledger.projectId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(ledger), { mode: 0o600 });
    fs.renameSync(temporary, file);
  }
  private lock<T>(tenantId: string, projectId: string, operation: () => Promise<T>) {
    return withPaidOperationLock(path.join(this.root, '.locks'), `${tenantId}:${projectId}`, operation);
  }
  async status(tenantId: string, projectId: string) {
    return this.lock(tenantId, projectId, async () => {
      const ledger = this.read(tenantId, projectId);
      const limitMicros = micros(this.limitCny());
      const usedMicros = Object.values(ledger.entries).reduce((sum, entry) => sum + entry.amountMicros, 0);
      return { limitCny: limitMicros / 1e6, usedCny: usedMicros / 1e6,
        remainingCny: Math.max(0, limitMicros - usedMicros) / 1e6,
        entries: Object.values(ledger.entries) };
    });
  }
  async reserve(input: { tenantId: string; projectId: string; shotId: string;
    stage: StoryboardAigcStage; operationId: string; estimatedCostCny: number; inputFingerprint?: string; limitCny?: number;
    /** A managed order whose exact maximum was approved before production may
     * consume that frozen ceiling. Start/reforecast validates any explicit
     * installation ceiling before recording the approval, so the ledger must
     * not re-apply its historical ¥30 fallback halfway through production. */
    approvedFrozenLimit?: boolean }) {
    if (!input.tenantId || !input.projectId || !input.shotId || !/^[A-Za-z0-9_:.-]{1,180}$/.test(input.operationId))
      throw new Error('分镜 AIGC 预算请求标识无效，未调用供应商');
    return this.lock(input.tenantId, input.projectId, async () => {
      const ledger = this.read(input.tenantId, input.projectId);
      const existing = ledger.entries[input.operationId];
      if (existing) {
        if (existing.shotId !== input.shotId || existing.stage !== input.stage
          || (existing.originalAmountMicros ?? existing.amountMicros) !== micros(input.estimatedCostCny))
          throw new Error('分镜 AIGC 请求标识已用于不同输入，未调用供应商');
        if (existing.inputFingerprint !== input.inputFingerprint)
          throw new Error('分镜 AIGC 请求标识对应的参考资产或镜头输入已变化，未调用供应商');
        return { existing: true, entry: existing };
      }
      const budgetExempt = isInternalBudgetExemptTenant(input.tenantId);
      const maxRetries = this.maxRetries();
      if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 20) throw new Error('分镜 AIGC 重试上限配置无效');
      // Retries protect one exact supplier input.  A newly uploaded product
      // cutout or other reference asset changes the input fingerprint and is
      // a new production revision, not a third retry of the old bad asset.
      // It remains subject to the project-wide cost ceiling below.
      const acceptedAttempts = Object.values(ledger.entries).filter(entry => entry.shotId === input.shotId
        && entry.stage === input.stage && entry.inputFingerprint === input.inputFingerprint).length;
      if (acceptedAttempts >= maxRetries + 1) throw new Error(`当前镜头${input.stage === 'first_frame' ? '首帧' : '视频'}已达到 ${maxRetries + 1} 次生成上限，未调用供应商`);
      const configuredLimit = this.limitCny();
      const requestedLimit = input.limitCny === undefined
        ? (budgetExempt ? 1_000_000_000 : configuredLimit)
        : Number(input.limitCny);
      if (!Number.isFinite(requestedLimit) || requestedLimit <= 0) throw new Error('冻结制作额度无效，未调用供应商');
      const limitMicros = micros(input.approvedFrozenLimit || budgetExempt ? requestedLimit : Math.min(configuredLimit, requestedLimit));
      const usedMicros = Object.values(ledger.entries).reduce((sum, entry) => sum + entry.amountMicros, 0);
      const amountMicros = micros(input.estimatedCostCny);
      if (!Number.isSafeInteger(usedMicros) || usedMicros + amountMicros > limitMicros)
        throw new Error(`当前项目 AIGC 预算剩余 ¥${(Math.max(0, limitMicros - usedMicros) / 1e6).toFixed(2)}，本次预计 ¥${(amountMicros / 1e6).toFixed(2)}；未调用供应商`);
      const entry: StoryboardAigcSpendEntry = { operationId: input.operationId, shotId: input.shotId,
        stage: input.stage, amountMicros, originalAmountMicros: amountMicros, status: 'reserved', at: new Date().toISOString(),
        ...(input.inputFingerprint ? { inputFingerprint: input.inputFingerprint } : {}) };
      ledger.entries[input.operationId] = entry;
      this.write(ledger);
      return { existing: false, entry };
    });
  }
  /** Persist provider acceptance before polling: a timeout must not erase the
   * only receipt that lets us inspect the original paid task without resubmitting. */
  async recordProviderAcceptance(tenantId: string, projectId: string, operationId: string,
    providerTaskId: string, providerModel: string) {
    if (!providerTaskId.trim() || !providerModel.trim()) throw new Error('供应商任务回执不完整');
    return this.lock(tenantId, projectId, async () => {
      const ledger = this.read(tenantId, projectId);
      const entry = ledger.entries[operationId];
      if (!entry) throw new Error('分镜 AIGC 预算预留不存在');
      if (entry.output?.providerTaskId && entry.output.providerTaskId !== providerTaskId)
        throw new Error('同一付费请求不能绑定不同供应商任务');
      entry.output = { ...entry.output, providerTaskId, providerModel,
        providerAcceptedAt: entry.output?.providerAcceptedAt || new Date().toISOString() };
      this.write(ledger);
      return entry;
    });
  }
  async mark(tenantId: string, projectId: string, operationId: string,
    status: 'reserved' | 'uncertain' | 'completed', output?: Record<string, unknown>) {
    return this.lock(tenantId, projectId, async () => {
      const ledger = this.read(tenantId, projectId);
      const entry = ledger.entries[operationId];
      if (!entry) throw new Error('分镜 AIGC 预算预留不存在');
      entry.status = status;
      if (output) entry.output = { ...entry.output, ...output };
      this.write(ledger);
      return entry;
    });
  }
  async releaseRejected(tenantId: string, projectId: string, operationId: string) {
    return this.lock(tenantId, projectId, async () => {
      const ledger = this.read(tenantId, projectId);
      if (ledger.entries[operationId]?.status === 'reserved' && !ledger.entries[operationId]?.output?.providerTaskId) {
        delete ledger.entries[operationId];
        this.write(ledger);
      }
    });
  }
  /**
   * Recover a reservation left before any supplier acknowledgement was saved.
   *
   * A process can stop after local admission but before the provider request is
   * accepted (for example during a local hot restart).  Such an empty
   * reservation must not look "in progress" forever.  We only release it after
   * a conservative timeout and only when there is no provider/task/request or
   * partial-call receipt whatsoever.  The caller then replays the exact same
   * operation and provider idempotency key; accepted or uncertain spend is
   * never released here.
   */
  async releaseExpiredUnacceptedReservation(tenantId: string, projectId: string, operationId: string,
    input: { now?: Date; minimumAgeMs?: number } = {}): Promise<boolean> {
    const now = input.now || new Date();
    const minimumAgeMs = input.minimumAgeMs ?? 10 * 60_000;
    if (!Number.isFinite(now.getTime()) || !Number.isFinite(minimumAgeMs) || minimumAgeMs < 60_000)
      throw new Error('分镜 AIGC 空预留恢复窗口无效');
    return this.lock(tenantId, projectId, async () => {
      const ledger = this.read(tenantId, projectId);
      const entry = ledger.entries[operationId];
      if (!entry || entry.status !== 'reserved') return false;
      const acceptedAt = Date.parse(entry.at);
      if (!Number.isFinite(acceptedAt) || now.getTime() - acceptedAt < minimumAgeMs) return false;
      const output = entry.output || {};
      const hasReceipt = ['providerTaskId', 'providerRequestId', 'uncertainProviderRequestId']
        .some(key => Boolean(String(output[key] || '').trim()))
        || ['seedreamReceipts', 'acceptedTaskIds', 'segmentTaskIds']
          .some(key => Array.isArray(output[key]) && (output[key] as unknown[]).length > 0);
      if (hasReceipt) return false;
      delete ledger.entries[operationId];
      this.write(ledger);
      return true;
    });
  }
  /** After a partially accepted multi-segment attempt, charge only segments
   * known to have reached the supplier. Never use when a submission is
   * uncertain; that case retains the full reservation for reconciliation. */
  async settlePartial(tenantId: string, projectId: string, operationId: string,
    acceptedCostCny: number, output?: Record<string, unknown>) {
    return this.lock(tenantId, projectId, async () => {
      const ledger = this.read(tenantId, projectId);
      const entry = ledger.entries[operationId];
      if (!entry || entry.status !== 'reserved') throw new Error('分镜 AIGC 预算预留不可部分结算');
      const acceptedMicros = Math.round(acceptedCostCny * 1e6);
      if (!Number.isSafeInteger(acceptedMicros) || acceptedMicros < 0 || acceptedMicros > entry.amountMicros)
        throw new Error('已提交片段的费用无效');
      if (acceptedMicros === 0) {
        delete ledger.entries[operationId];
        this.write(ledger);
        return null;
      }
      entry.amountMicros = acceptedMicros;
      entry.status = 'completed';
      if (output) entry.output = { ...entry.output, ...output };
      this.write(ledger);
      return entry;
    });
  }
}

export const storyboardAigcProjectBudget = new StoryboardAigcProjectBudget();
