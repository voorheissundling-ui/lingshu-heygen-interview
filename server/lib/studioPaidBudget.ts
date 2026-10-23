import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { withPaidOperationLock } from './paidOperationLock.js';
import { isInternalBudgetExemptTenant } from './tenantBudgetExemption.js';

export type PaidProvider = 'heygen' | 'qwen_asr';
type Config = { limit: number; openingUsed: number; reserve: Record<PaidProvider, number> };
type Ledger = { version: 1; limit: number; openingUsed: number; entries: Record<string, { provider: PaidProvider; amount: number; at: string }> };
const units = (value: string | undefined, allowZero = false) => {
  if (!value || !/^\d+(\.\d{1,6})?$/.test(value)) throw new Error('预算须显式配置为人民币金额（最多六位小数）');
  const number = Math.round(Number(value) * 1e6);
  if (!Number.isSafeInteger(number) || (allowZero ? number < 0 : number <= 0)) throw new Error('预算金额无效');
  return number;
};
function environmentConfig(): Config {
  return { limit: units(process.env.STUDIO_PAID_BUDGET_CNY), openingUsed: units(process.env.STUDIO_PAID_OPENING_USED_CNY, true),
    reserve: { heygen: units(process.env.STUDIO_HEYGEN_RESERVE_CNY), qwen_asr: units(process.env.STUDIO_ASR_RESERVE_CNY) } };
}

/** Admission budget, NOT an upstream billing limit. No automatic refunds, resets or expiry.
 * Reserves are conservative administrator estimates; unknown/failed calls keep their allocation.
 * This covers HeyGen + Qwen ASR only, not existing script/TTS/image endpoints.
 */
export class StudioPaidBudget {
  constructor(private root: string, private config: () => Config = environmentConfig) {}
  private amount(config: Config, provider: PaidProvider, overrideCny?: number): number {
    if (overrideCny === undefined) return config.reserve[provider];
    if (!Number.isFinite(overrideCny) || overrideCny <= 0 || overrideCny > config.reserve[provider] / 1e6) throw new Error('单任务预占金额无效或超过管理员上限');
    return units(String(overrideCny));
  }
  private exemptReservation(overrideCny?: number): number | null {
    if (overrideCny === undefined) return null;
    if (!Number.isFinite(overrideCny) || overrideCny <= 0) throw new Error('单任务预占金额无效');
    return overrideCny;
  }
  private read(config: Config): Ledger {
    const file = path.join(this.root, 'ledger.json');
    const ledger: Ledger = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, limit: config.limit, openingUsed: config.openingUsed, entries: {} };
    if (ledger.version !== 1 || ledger.limit !== config.limit || ledger.openingUsed !== config.openingUsed || !ledger.entries || typeof ledger.entries !== 'object' || Array.isArray(ledger.entries)
      || Object.values(ledger.entries).some(entry => !entry || !Number.isSafeInteger(entry.amount) || entry.amount <= 0 || !['heygen', 'qwen_asr'].includes(entry.provider))) {
      throw new Error('预算账本异常或配置已改变，请管理员核账；未发起付费调用');
    }
    return ledger;
  }
  private used(ledger: Ledger) {
    const value = ledger.openingUsed + Object.values(ledger.entries).reduce((sum, entry) => sum + entry.amount, 0);
    if (!Number.isSafeInteger(value)) throw new Error('预算账本金额异常');
    return value;
  }
  status(provider: PaidProvider, overrideCny?: number, tenantId?: string) {
    if (isInternalBudgetExemptTenant(tenantId)) {
      try {
        return { allowed: true, remainingCny: null, reservationCny: this.exemptReservation(overrideCny),
          reason: '', budgetExempt: true };
      } catch (error) {
        return { allowed: false, remainingCny: null, reservationCny: null,
          reason: error instanceof Error ? error.message : '预算配置不可用', budgetExempt: true };
      }
    }
    try {
      const config = this.config(), used = this.used(this.read(config)), amount = this.amount(config, provider, overrideCny);
      return { allowed: used + amount <= config.limit,
        remainingCny: Math.max(0, config.limit - used) / 1e6, reservationCny: amount / 1e6,
        reason: used + amount <= config.limit ? '' : '预算余额不足，已禁止新付费任务；已有任务仍可刷新' };
    } catch (error) { return { allowed: false, remainingCny: null, reservationCny: null, reason: error instanceof Error ? error.message : '预算不可用' }; }
  }
  async reserve(provider: PaidProvider, operationId: string, overrideCny?: number, tenantId?: string) {
    if (isInternalBudgetExemptTenant(tenantId)) {
      this.exemptReservation(overrideCny);
      return;
    }
    return withPaidOperationLock(path.join(this.root, '.locks'), 'budget', async () => {
      const config = this.config(), ledger = this.read(config);
      const id = createHash('sha256').update(`${provider}:${operationId}`).digest('hex');
      const amount = this.amount(config, provider, overrideCny);
      if (ledger.entries[id]) {
        if (ledger.entries[id].amount !== amount) throw new Error('同一请求的预算预占已变化，请核对原任务');
        return;
      }
      if (this.used(ledger) + amount > config.limit) throw new Error('预算余额不足，未调用供应商');
      ledger.entries[id] = { provider, amount, at: new Date().toISOString() };
      const temp = path.join(this.root, `ledger.${randomUUID()}.tmp`);
      fs.writeFileSync(temp, JSON.stringify(ledger), { mode: 0o600 });
      fs.renameSync(temp, path.join(this.root, 'ledger.json'));
    });
  }

  /** Release only after the provider explicitly rejected a request before creating a task. */
  async releaseRejected(provider: PaidProvider, operationId: string, tenantId?: string) {
    if (isInternalBudgetExemptTenant(tenantId)) return;
    return withPaidOperationLock(path.join(this.root, '.locks'), 'budget', async () => {
      const config = this.config(), ledger = this.read(config);
      const id = createHash('sha256').update(`${provider}:${operationId}`).digest('hex');
      if (!ledger.entries[id]) return;
      if (ledger.entries[id].provider !== provider) throw new Error('预算预占供应商不一致');
      delete ledger.entries[id];
      const temp = path.join(this.root, `ledger.${randomUUID()}.tmp`);
      fs.writeFileSync(temp, JSON.stringify(ledger), { mode: 0o600 });
      fs.renameSync(temp, path.join(this.root, 'ledger.json'));
    });
  }
}
export const studioPaidBudget = new StudioPaidBudget(path.resolve(process.cwd(), 'data/studio-paid-budget'));
