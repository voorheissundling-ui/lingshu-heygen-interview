import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type {MvpBudgetRecord} from '../lib/mvpBudgetAdmission.js';
import type {SocialTaskBudgetEntry} from '../lib/socialContentTaskBudget.js';

export interface ProductRecoveryFundingInput {
  budgetRoot: string;
  tenantId: string;
  taskId: string;
  runId: string;
  shotId: string;
  productId: string;
  accountId: string | null;
  provider: string;
  model: string;
  fingerprint: string;
  operationId: string;
  wholeFilmEntries: SocialTaskBudgetEntry[];
  binding?: {poolId: string; authorizationRef: string; scopeHash: string};
}
/** Accepted work retains its original reservation. This reader never quotes,
 * reserves, refunds, or extends authorization; explicit revocation still blocks. */
export function readProductRecoveryFunding(input: ProductRecoveryFundingInput): number {
  const whole = input.wholeFilmEntries.filter(entry => entry.operationId === input.operationId
    && entry.fingerprint === input.fingerprint && entry.runId === input.runId
    && entry.provider === input.provider && entry.model === input.model && entry.shotId === input.shotId
    && entry.accountRef === (input.accountId || 'unbound') && entry.status !== 'rejected');
  if (whole.length !== 1) throw Error('product_recovery_original_whole_film_reservation_missing');
  const candidates: number[] = [];
  for (const name of fs.existsSync(input.budgetRoot) ? fs.readdirSync(input.budgetRoot).filter(n => /^[a-f0-9]{64}\.json$/.test(n)) : []) {
    const record = JSON.parse(fs.readFileSync(path.join(input.budgetRoot, name), 'utf8')) as MvpBudgetRecord;
    if (record.tenantId !== input.tenantId || record.taskId !== input.taskId || input.binding && record.id !== input.binding.poolId) continue;
    const entry = record.entries?.[input.operationId];
    if (!entry || entry.fingerprint !== input.fingerprint || entry.operationId !== input.operationId
      || !['reserved', 'completed'].includes(entry.status) || !Number.isFinite(entry.amountCny) || entry.amountCny <= 0
      || Math.round(entry.amountCny * 1e6) !== whole[0]!.reservedMicros) continue;
    if (record.schemaVersion !== 1 || createHash('sha256').update(record.id).digest('hex') + '.json' !== name) continue;
    const grants = record.authorizations.filter(scope => scope.tenantId === input.tenantId && scope.taskId === input.taskId
      && scope.runId === input.runId && scope.productId === input.productId && scope.accountId === input.accountId
      && scope.provider === input.provider && scope.model === input.model && scope.shotIds.includes(input.shotId)
      && scope.budgetPoolId === record.id && scope.budgetLimitCny === record.limitCny && scope.session === record.session
      && scope.action === 'generate_media' && scope.revoked === false && Number.isSafeInteger(scope.version) && scope.version >= 1
      && ['customer', 'authorized_business_reviewer'].includes(scope.authority) && !!scope.authorizedBy && !!scope.authorizationRef
      && Number.isFinite(Date.parse(scope.expiresAt))
      && (!input.binding || scope.authorizationRef === input.binding.authorizationRef && createHash('sha256').update(JSON.stringify(scope)).digest('hex') === input.binding.scopeHash));
    if (grants.length === 1) candidates.push(entry.amountCny);
  }
  if (candidates.length !== 1) throw Error('product_recovery_original_server_authorization_missing_or_ambiguous');
  return candidates[0]!;
}
