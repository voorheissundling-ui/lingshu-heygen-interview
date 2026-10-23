/**
 * Shared Step 4 spend ledger.
 *
 * Every paid Step 4 operation (presenter shot or explainer narration) reserves
 * a forecast before the POST and settles it against the observed wallet delta
 * afterwards. The cap is enforced on the sum of settled charges plus live
 * reservations, so a crash cannot silently authorize a second spend.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export interface Step4BudgetOperation {
  kind: 'presenter_shot' | 'explainer_speech';
  id: string;
  at: string;
  requestedAt: string;
  forecastCny: number;
  estimatedCny: number | null;
  observedDeltaCny: number | null;
  chargedCny: number;
  walletBefore: number | null;
  walletAfter: number | null;
  providerRef: string | null;
}

export interface Step4Budget {
  schemaVersion: 1;
  approvedCny: number;
  credentialHash: string;
  storyboardSha256: string;
  fx: {date: string; cnyPerUsd: number};
  avatarUsdPerMinute: number;
  speechUsdPerMillionChars: number;
  reservedCny: number;
  chargedCny: number;
  observedSpendCny: number;
  paidSubmissions: number;
  operations: Step4BudgetOperation[];
  createdAt: string;
  updatedAt: string;
}

export const roundCny = (value: number) => Math.round(value * 1e6) / 1e6;

export function assertBudgetIdentity(
  budget: Step4Budget,
  expected: {approvedCny: number; credentialHash: string; storyboardSha256: string},
): void {
  if (budget.schemaVersion !== 1) throw new Error('step4_budget_schema_invalid');
  if (budget.approvedCny !== expected.approvedCny) throw new Error('step4_approved_budget_changed');
  if (budget.credentialHash !== expected.credentialHash) throw new Error('step4_credential_changed');
  if (budget.storyboardSha256 !== expected.storyboardSha256)
    throw new Error('step4_budget_storyboard_changed');
}

export function assertCanReserve(budget: Step4Budget, forecastCny: number): void {
  if (!Number.isFinite(forecastCny) || forecastCny <= 0) throw new Error('step4_forecast_invalid');
  const committed = roundCny(budget.chargedCny + budget.reservedCny);
  if (roundCny(committed + forecastCny) > budget.approvedCny)
    throw new Error('step4_forecast_exceeds_approved_budget');
}

export function reserve(budget: Step4Budget, forecastCny: number): void {
  assertCanReserve(budget, forecastCny);
  budget.reservedCny = roundCny(budget.reservedCny + forecastCny);
  budget.updatedAt = new Date().toISOString();
}

/** Release a reservation without recording a charge (known provider rejection). */
export function release(budget: Step4Budget, forecastCny: number): void {
  budget.reservedCny = roundCny(Math.max(0, budget.reservedCny - forecastCny));
  budget.updatedAt = new Date().toISOString();
}

/**
 * Settle a reservation. `chargedCny` is the larger of the observed wallet
 * delta and the published-price estimate: wallet display is rounded, so the
 * estimate is the floor while the observed delta is the settlement evidence.
 */
export function settle(
  budget: Step4Budget,
  operation: Omit<Step4BudgetOperation, 'chargedCny'>,
): Step4BudgetOperation {
  const observed = operation.observedDeltaCny;
  const estimated = operation.estimatedCny;
  const charged = roundCny(Math.max(
    Number.isFinite(observed as number) ? (observed as number) : 0,
    Number.isFinite(estimated as number) ? (estimated as number) : 0,
  ));
  budget.reservedCny = roundCny(Math.max(0, budget.reservedCny - operation.forecastCny));
  budget.chargedCny = roundCny(budget.chargedCny + charged);
  budget.observedSpendCny = roundCny(budget.observedSpendCny + (Number.isFinite(observed as number) ? (observed as number) : 0));
  budget.paidSubmissions += 1;
  const settled: Step4BudgetOperation = {...operation, chargedCny: charged};
  budget.operations.push(settled);
  budget.updatedAt = new Date().toISOString();
  return settled;
}

export async function readBudget(file: string, init?: Omit<Step4Budget, 'createdAt' | 'updatedAt'>): Promise<Step4Budget> {
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8')) as Step4Budget;
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !init) throw error;
    const stamp = new Date().toISOString();
    const budget = {...init, createdAt: stamp, updatedAt: stamp};
    await persistBudget(file, budget);
    return budget;
  }
}

export async function persistBudget(file: string, budget: Step4Budget): Promise<void> {
  await fs.mkdir(path.dirname(file), {recursive: true, mode: 0o700});
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(budget, null, 2), {mode: 0o600});
  await fs.rename(temp, file);
}
