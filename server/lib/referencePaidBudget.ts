import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { withPaidOperationLock } from './paidOperationLock.js';
import { isInternalBudgetExemptTenant } from './tenantBudgetExemption.js';

type Ledger = { version: 1; limitMicros: number; entries: Record<string, { tool: string; amountMicros: number; at: string }> };
const micros = (value: number) => {
  const result = Math.round(value * 1e6);
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error('参考人物任务缺少有效的预计费用，未调用供应商');
  return result;
};

/** Durable admission ledger for reference-driven digital-human suppliers. Reservations are never auto-refunded. */
export class ReferencePaidBudget {
  constructor(private readonly root: string, private readonly monthlyLimitCny: () => number = () => Number(process.env.DIGITAL_HUMAN_REFERENCE_MONTHLY_BUDGET_CNY)) {}
  async reserve(tool: string, operationId: string, estimatedCostCny: number | null, tenantId?: string) {
    // Exempt tenants still require valid administrator pricing/budget configuration
    // and a valid estimate, but do not consume the shared internal monthly ceiling.
    if (isInternalBudgetExemptTenant(tenantId)) {
      micros(this.monthlyLimitCny());
      micros(Number(estimatedCostCny));
      return;
    }
    return withPaidOperationLock(path.join(this.root, '.locks'), 'budget', async () => {
      const limitMicros = micros(this.monthlyLimitCny()); const amountMicros = micros(Number(estimatedCostCny));
      const file = path.join(this.root, 'ledger.json');
      const ledger: Ledger = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, limitMicros, entries: {} };
      if (ledger.version !== 1 || ledger.limitMicros !== limitMicros || !ledger.entries || typeof ledger.entries !== 'object' || Array.isArray(ledger.entries)
        || Object.values(ledger.entries).some(item => !item || !Number.isSafeInteger(item.amountMicros) || item.amountMicros <= 0)) {
        throw new Error('参考人物预算账本异常或月度预算配置已改变，请管理员核账；未调用供应商');
      }
      const id = createHash('sha256').update(`${tool}:${operationId}`).digest('hex');
      if (ledger.entries[id]) return;
      const used = Object.values(ledger.entries).reduce((sum, item) => sum + item.amountMicros, 0);
      if (!Number.isSafeInteger(used) || used + amountMicros > limitMicros) throw new Error('参考人物月度预算余额不足，未调用供应商');
      ledger.entries[id] = { tool, amountMicros, at: new Date().toISOString() };
      fs.mkdirSync(this.root, { recursive: true }); const temporary = path.join(this.root, `ledger.${randomUUID()}.tmp`);
      fs.writeFileSync(temporary, JSON.stringify(ledger), { mode: 0o600 }); fs.renameSync(temporary, file);
    });
  }
  async release(tool: string, operationId: string, tenantId?: string) {
    if (isInternalBudgetExemptTenant(tenantId)) return;
    return withPaidOperationLock(path.join(this.root, '.locks'), 'budget', async () => {
      const file = path.join(this.root, 'ledger.json');
      if (!fs.existsSync(file)) return;
      const ledger = JSON.parse(fs.readFileSync(file, 'utf8')) as Ledger;
      if (ledger.version !== 1 || !ledger.entries || typeof ledger.entries !== 'object' || Array.isArray(ledger.entries)
        || Object.values(ledger.entries).some(item => !item || !Number.isSafeInteger(item.amountMicros) || item.amountMicros <= 0)) {
        throw new Error('参考人物预算账本异常，无法释放明确未提交的预算预占');
      }
      const id = createHash('sha256').update(`${tool}:${operationId}`).digest('hex');
      if (!ledger.entries[id]) return;
      delete ledger.entries[id];
      const temporary = path.join(this.root, `ledger.${randomUUID()}.tmp`);
      fs.writeFileSync(temporary, JSON.stringify(ledger), { mode: 0o600 }); fs.renameSync(temporary, file);
    });
  }
}

export const referencePaidBudget = new ReferencePaidBudget(path.resolve(process.cwd(), 'data/studio-reference-budget'));
