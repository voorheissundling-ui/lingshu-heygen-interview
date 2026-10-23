import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { withPaidOperationLock } from './paidOperationLock.js';
import { assertMvpExecutionScope, type MvpExecutionScope } from '../../shared/mvpExecutionScope.js';

type Entry = { operationId: string; fingerprint: string; amountCny: number; status: 'reserved' | 'completed'; at: string };
export interface MvpBudgetRecord {
  schemaVersion: 1;
  id: string; tenantId: string; taskId: string; session: 'A' | 'B'; limitCny: number;
  /** Provisioned only by an authorized internal owner. No HTTP/body write path. */
  authorizations: MvpExecutionScope[];
  pricing: { verifiedAccountPrice: boolean; checkedAt: string; validUntil: string; balanceCny: number; evidenceRef: string;
    operationQuotes: Record<string, { provider: string; model: string; upperBoundCny: number }> };
  entries: Record<string, Entry>;
}
/** Separate from the project ledger: changing project, version or request ID
 * cannot reset an authorized session pool. Missing provisioning fails closed. */
export class MvpBudgetAdmission {
  constructor(private readonly root = path.resolve(process.env.MVP_BUDGET_POOL_DIR || 'data/mvp-budget-pools')) {}
  private file(id: string) { return path.join(this.root, `${createHash('sha256').update(id).digest('hex')}.json`); }
  private read(id: string): MvpBudgetRecord {
    if (!id?.trim()) throw Error('mvp_budget_pool_missing');
    const file = this.file(id);
    if (!fs.existsSync(file)) throw Error('mvp_budget_pool_not_provisioned');
    const x = JSON.parse(fs.readFileSync(file, 'utf8')) as MvpBudgetRecord;
    if (x.schemaVersion !== 1 || x.id !== id || !x.entries || Array.isArray(x.entries)
      || !Array.isArray(x.authorizations) || Object.values(x.entries).some(e => !e || !Number.isFinite(e.amountCny)
        || e.amountCny < 0 || !['reserved', 'completed'].includes(e.status))) throw Error('mvp_budget_pool_corrupt');
    return x;
  }
  private write(x: MvpBudgetRecord) {
    const file = this.file(x.id); const temp = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(x), { mode: 0o600 }); fs.renameSync(temp, file);
  }
  async reserve(input: Parameters<typeof assertMvpExecutionScope>[0] & { operationId: string; fingerprint: string }) {
    if (!input.scope) return null;
    const scope = input.scope;
    return withPaidOperationLock(path.join(this.root, '.locks'), scope.budgetPoolId, async () => {
      const x = this.read(scope.budgetPoolId);
      const grant = x.authorizations.find(g => g.authorizationRef === scope.authorizationRef);
      if (!grant || JSON.stringify(grant) !== JSON.stringify(scope)) throw Error('mvp_authorization_not_server_recorded');
      if (!/^[A-Za-z0-9_:.-]{1,180}$/.test(input.operationId) || !/^[a-f0-9]{64}$/.test(input.fingerprint)) throw Error('mvp_operation_invalid');
      const previous = x.entries[input.operationId];
      if (previous && (previous.fingerprint !== input.fingerprint || previous.amountCny !== input.estimatedCostCny)) throw Error('mvp_operation_input_changed');
      const used = Object.values(x.entries).reduce((sum, e) => sum + e.amountCny, 0);
      assertMvpExecutionScope({ ...input, estimatedCostCny: previous ? 0 : input.estimatedCostCny,
        pool: { id: x.id, tenantId: x.tenantId, taskId: x.taskId, session: x.session,
          limitCny: x.limitCny, spentCny: 0, reservedCny: used } });
      if (previous) return { existing: true, entry: previous };
      const now = input.now === undefined ? Date.now() : Date.parse(input.now);
      const quote = x.pricing?.operationQuotes?.[input.fingerprint];
      if (!x.pricing?.verifiedAccountPrice || !x.pricing.evidenceRef || !Number.isFinite(Date.parse(x.pricing.checkedAt))
        || Date.parse(x.pricing.checkedAt) > now || !Number.isFinite(Date.parse(x.pricing.validUntil))
        || Date.parse(x.pricing.validUntil) <= now || !Number.isFinite(x.pricing.balanceCny)
        || x.pricing.balanceCny < used + input.estimatedCostCny || !quote || quote.provider !== input.provider
        || quote.model !== input.model || !Number.isFinite(quote.upperBoundCny) || quote.upperBoundCny < 0
        || input.estimatedCostCny < quote.upperBoundCny) throw Error('mvp_account_price_or_balance_unverified');
      const entry: Entry = { operationId: input.operationId, fingerprint: input.fingerprint,
        amountCny: input.estimatedCostCny, status: 'reserved', at: new Date(now).toISOString() };
      x.entries[input.operationId] = entry; this.write(x);
      return { existing: false, entry };
    });
  }
  /** Only a definitive pre-acceptance rejection permits releasing a reservation. */
  async releaseRejected(poolId: string, operationId: string) {
    return withPaidOperationLock(path.join(this.root, '.locks'), poolId, async () => {
      const x = this.read(poolId); if (x.entries[operationId]?.status === 'reserved') {
        delete x.entries[operationId]; this.write(x);
      }
    });
  }
}
export const mvpBudgetAdmission = new MvpBudgetAdmission();
