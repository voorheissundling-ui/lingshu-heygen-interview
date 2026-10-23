import {verifyHeyGenPublishedTariff,type HeyGenPublishedPricingEvidence} from './heygenPublishedPricing.js';
import {verifySeedreamPublishedTariff,type SeedreamPublishedPricingEvidence} from './seedreamPublishedPricing.js';
import {verifyNativeVoicePublishedTariff} from './studioVoicePublishedPricing.js';
import {verifyWanPublishedTariff,type WanPublishedPricingEvidence} from './wanPublishedPricing.js';
import {isVerifiedPublishedTariff,type LocalPublishedPricingEvidence,type MaaSPublishedPricingEvidence,type PublishedPricingEvidence} from './socialContentPublishedTariffs.js';
import { createHash } from 'node:crypto';
import { SocialContentTaskBudget, type SocialTaskBudgetScope, type SocialTaskBudgetOperation, type SocialTaskBudgetQuote } from './socialContentTaskBudget.js';
import { isInternalBudgetExemptTenant } from './tenantBudgetExemption.js';
/** Server-frozen maximum input usage. Token stages must bound both prompt and
 * response; retry attempts appear as distinct operations in this complete plan. */
export interface SocialPaidOperationIntent {
    operationId: string;
    provider: string;
    model: string;
    accountRef: string;
    stage: string;
    shotId: string | null;
    inputContractHash: string;
    maximumUnits: Record<string, number>;
    correction?: {attempt:1|2;kind:'presenter_video'|'voice_tts'|'voice_alignment';cause:'approved_first_frame_not_consumed'|'approved_first_frame_not_consumed_and_bound_voice_mismatch';authorizationRef:string;presenterGroupId?:string;approvalRecordHash?:string;selectedVoiceId?:string;selectedVoiceFingerprint?:string};
}
export interface SocialApprovedBudgetPlan {
    scope: SocialTaskBudgetScope;
    authorizationRef: string;
    maximumCny: number;
    maximumExecutionCny?:number;
    /** Includes every paid stage (images, QA, presenter, voice, analysis, retries).
     * This is produced by the trusted planner, never passed from an HTTP body. */
    paidOperations: SocialPaidOperationIntent[];
    presenterGroups?: Array<{
        groupId: string;
        shotIds: string[];
        durationSeconds: number;
        spokenText: string;
        presenterAssetId: string;
        contractHash: string;
    }>;
}
export interface SocialVerifiedAccountTariff {
    provider: string;
    model: string;
    accountRef: string;
    stage: string;
    currency: 'CNY';
    verifiedAccountPrice: boolean;
    pricingBasis?:'negotiated_verified_account'|'published_undiscounted_ceiling'|'published_fx_estimate';
    publicPricingEvidence?:PublishedPricingEvidence|LocalPublishedPricingEvidence|MaaSPublishedPricingEvidence|SeedreamPublishedPricingEvidence|WanPublishedPricingEvidence|HeyGenPublishedPricingEvidence;
    evidenceRef: string;
    checkedAt: string;
    validUntil: string;
    /** e.g. providerSeconds (4s minimum), requests, inputTokens, outputTokens.
     * Price is CNY per unitsPerPrice units; billable usage rounds up to increment. */
    meters: Record<string, {
        priceCny: number;
        unitsPerPrice: number;
        minimumUnits: number;
        increment: number;
    }>;
}
export interface SocialTaskBudgetAuthorityPorts {
    readApprovedPlan(scope: SocialTaskBudgetScope): Promise<SocialApprovedBudgetPlan>;
    readVerifiedTariff(operation: SocialPaidOperationIntent): Promise<SocialVerifiedAccountTariff | null>;
    assertCurrent(scope: SocialTaskBudgetScope): Promise<void>;
    verifyRejection(scope: SocialTaskBudgetScope, operation: SocialTaskBudgetOperation, receiptRef: string): Promise<boolean>;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fail(code: string): never { throw Error(`social_task_budget_authority_${code}`); }
const finite = (n: number) => Number.isFinite(n) && n >= 0;
const nonempty = (s: string) => typeof s === 'string' && s.trim() === s && s.length > 0 && s.length <= 512;
function sameScope(a: SocialTaskBudgetScope, b: SocialTaskBudgetScope) { return ['tenantId', 'taskId', 'runId', 'planHash'].every(k => a[k as keyof typeof a] === b[k as keyof typeof b])&&(a.budgetTaskId??a.taskId)===(b.budgetTaskId??b.taskId); }
function canonicalUnits(units: Record<string, number>) { return Object.fromEntries(Object.entries(units).sort(([a], [b]) => a.localeCompare(b))); }
export function socialPaidIntentOperation(scope: SocialTaskBudgetScope, intent: SocialPaidOperationIntent): SocialTaskBudgetOperation {
    if (![intent.operationId, intent.provider, intent.model, intent.accountRef, intent.stage].every(nonempty) || (intent.shotId !== null && !nonempty(intent.shotId)) || !/^[a-f0-9]{64}$/.test(intent.inputContractHash) || !intent.maximumUnits || !Object.keys(intent.maximumUnits).length || Object.entries(intent.maximumUnits).some(([k, v]) => !nonempty(k) || !finite(v)))
        fail('intent_invalid');
    return { operationId: intent.operationId, provider: intent.provider, model: intent.model, accountRef: intent.accountRef, stage: intent.stage, shotId: intent.shotId,
        fingerprint: digest({ scope, operationId: intent.operationId, provider: intent.provider, model: intent.model, accountRef: intent.accountRef, stage: intent.stage, shotId: intent.shotId, inputContractHash: intent.inputContractHash, maximumUnits: canonicalUnits(intent.maximumUnits) }) };
}
const intentOperation=socialPaidIntentOperation;
function price(intent: SocialPaidOperationIntent, tariff: SocialVerifiedAccountTariff | null): SocialTaskBudgetQuote {
    const now = Date.now();
    if (!tariff || !((tariff.verifiedAccountPrice===true&&(!tariff.pricingBasis||tariff.pricingBasis==='negotiated_verified_account'))||isVerifiedPublishedTariff(tariff)||verifyNativeVoicePublishedTariff(tariff)||verifyWanPublishedTariff(tariff)||verifySeedreamPublishedTariff(tariff)||verifyHeyGenPublishedTariff(tariff)) || tariff.currency !== 'CNY' || !nonempty(tariff.evidenceRef) || ['provider', 'model', 'accountRef', 'stage'].some(k => tariff[k as 'provider'] !== intent[k as 'provider']) || !Number.isFinite(Date.parse(tariff.checkedAt)) || Date.parse(tariff.checkedAt) > now || !Number.isFinite(Date.parse(tariff.validUntil)) || Date.parse(tariff.validUntil) <= now)
        fail('account_tariff_missing_or_expired');
    // A durable MaaS tariff must not be reused outside its published pricing
    // bands even if it was originally imported for a smaller operation.
    if (tariff.publicPricingEvidence?.schemaVersion === 3 &&
        (!Number.isSafeInteger(intent.maximumUnits.inputTokens) || intent.maximumUnits.inputTokens < 0 || intent.maximumUnits.inputTokens > tariff.publicPricingEvidence.maximumInputTokens ||
         !Number.isSafeInteger(intent.maximumUnits.outputTokens) || intent.maximumUnits.outputTokens < 0 || intent.maximumUnits.outputTokens > 32768))
        fail('account_tariff_input_range_unverified');
    const keys = Object.keys(intent.maximumUnits).sort(), meters = Object.keys(tariff.meters || {}).sort();
    if (JSON.stringify(keys) !== JSON.stringify(meters))
        fail('usage_envelope_incomplete');
    let amountMicros = 0;
    for (const key of keys) {
        const meter = tariff.meters[key]!;
        if (!meter || !finite(meter.priceCny) || !(meter.unitsPerPrice > 0) || !Number.isFinite(meter.unitsPerPrice) || !finite(meter.minimumUnits) || !(meter.increment > 0) || !Number.isFinite(meter.increment))
            fail('tariff_invalid');
        const usage = Math.ceil(Math.max(intent.maximumUnits[key]!, meter.minimumUnits) / meter.increment) * meter.increment;
        // Round each component conservatively upward, never underestimate by float rounding.
        const cost = Math.ceil(usage * meter.priceCny / meter.unitsPerPrice * 1e6);
        if (!Number.isSafeInteger(cost) || cost < 0)
            fail('tariff_invalid');
        amountMicros += cost;
    }
    if (!Number.isSafeInteger(amountMicros) || amountMicros <= 0)
        fail('paid_quote_invalid');
    const fxEvidence = tariff.pricingBasis === 'published_fx_estimate' ? tariff.publicPricingEvidence as HeyGenPublishedPricingEvidence : null;
    return { ...(fxEvidence ? { nativePricing: { basis: 'published_fx_estimate' as const, currency: 'USD' as const, usdPerMinute: fxEvidence.usdPerMinute, maximumProviderSeconds: (intent.maximumUnits.providerSeconds ?? intent.maximumUnits.audioSeconds)!, estimatedCnyPerUsd: fxEvidence.estimatedCnyPerUsd, fxDate: fxEvidence.fxDate, pricingSourceSha256: fxEvidence.pricingSourceSha256, fxSourceSha256: fxEvidence.fxSourceSha256 } } : {}), upperBoundCny: amountMicros / 1e6, quoteRef: `tariff:${digest({ evidenceRef: tariff.evidenceRef, tariff, intent })}`, validUntil: tariff.validUntil };
}
/** Shared validator for correction quotes: identical evidence and rounding rules. */
export function quoteSocialPaidOperationTariff(intent: SocialPaidOperationIntent, tariff: SocialVerifiedAccountTariff | null): SocialTaskBudgetQuote { return price(intent, tariff); }
/** No environment price defaults and no manual output-hash quote files. The
 * frozen input envelope makes all-stage quotes available BEFORE first paid POST.
 * Missing trusted pricing is an explicit blocker, not an estimated authorization. */
export function createSocialContentTaskBudgetAuthority(input: {
    ledgerRoot?: string;
    ports: SocialTaskBudgetAuthorityPorts;
}) {
    const { ports } = input;
    async function prepare(scope: SocialTaskBudgetScope) {
        await ports.assertCurrent(scope);
        const plan = await ports.readApprovedPlan(scope);
        if (!sameScope(scope, plan.scope) || !nonempty(plan.authorizationRef) || !Number.isFinite(plan.maximumCny) || plan.maximumCny <= 0 || !Array.isArray(plan.paidOperations) || !plan.paidOperations.length)
            fail('approved_plan_missing');
        const operations = plan.paidOperations.map(i => intentOperation(scope, i));
        if (new Set(operations.map(o => o.operationId)).size !== operations.length)
            fail('duplicate_operation');
        const quotes = new Map<string, SocialTaskBudgetQuote>();
        const existing = new SocialContentTaskBudget(input.ledgerRoot, {
            assertCurrent: ports.assertCurrent, authorization: async () => fail('existing_ledger_read_only'),
            quote: async () => fail('existing_ledger_read_only'), verifyRejection: ports.verifyRejection,
        }).status(scope);
        // Existing same-scope entries retain their original quote and receipt.
        // Only newly appended operations need a current tariff; this permits a
        // safe in-flight plan extension without repricing completed work.
        for (const [index, intent] of plan.paidOperations.entries()) {
            const operation = operations[index]!;
            const prior = existing?.entries.find(entry => entry.operationId === operation.operationId);
            if (prior) {
                if ((prior.executionTaskId??scope.budgetTaskId??scope.taskId)!==scope.taskId || prior.status === 'rejected' || prior.runId !== scope.runId || prior.planHash !== scope.planHash
                    || (['operationId', 'fingerprint', 'provider', 'model', 'accountRef', 'stage', 'shotId'] as const)
                        .some(key => prior[key] !== operation[key])) fail('existing_operation_changed');
                quotes.set(intent.operationId, {upperBoundCny: prior.reservedMicros / 1e6,
                    quoteRef: prior.quoteRef, validUntil: '9999-12-31T23:59:59.999Z'});
            } else {
                try { quotes.set(intent.operationId, price(intent, await ports.readVerifiedTariff(intent))); }
                catch (error) {
                    const reason = error instanceof Error ? error.message : String(error);
                    throw Error(`${reason}:${intent.provider}:${intent.model}:${intent.stage}`);
                }
            }
        }
        await ports.assertCurrent(scope);
        const current = await ports.readApprovedPlan(scope);
        if (digest(current) !== digest(plan))
            fail('plan_changed');
        return { plan, operations, quotes };
    }
    async function prepareAndReserve(scope: SocialTaskBudgetScope) {
        const prepared = await prepare(scope);
        const ledger = new SocialContentTaskBudget(input.ledgerRoot, {
            assertCurrent: async candidate => { if (!sameScope(candidate, scope)) fail('scope_changed'); await ports.assertCurrent(candidate); },
            authorization: async () => { const current = await ports.readApprovedPlan(scope); if (digest(current) !== digest(prepared.plan))
                fail('plan_changed'); return { maximumCny: Math.min(15, current.maximumCny), maximumExecutionCny:current.maximumExecutionCny,authorizationRef: current.authorizationRef }; },
            quote: async (_s, operation) => { const intent = prepared.operations.find(o => o.operationId === operation.operationId); if (!intent || digest(intent) !== digest(operation))
                fail('operation_changed'); return prepared.quotes.get(operation.operationId)!; },
            verifyRejection: ports.verifyRejection,
        });
        const status = await ledger.reserveBatch(scope, prepared.operations);
        return { scope, operations: prepared.operations, intents: structuredClone(prepared.plan.paidOperations), quotes: Object.fromEntries(prepared.quotes), status, ledger };
    }
    /** Receipt recovery grants no new submission authority. A tariff expiry
     * must not strand already accepted requests, while pending stages still
     * require normal quotation before their first POST. */
    async function recoverAccepted(scope: SocialTaskBudgetScope, operationIds: string[]) {
        await ports.assertCurrent(scope);
        const plan = await ports.readApprovedPlan(scope);
        if (!sameScope(scope, plan.scope) || !nonempty(plan.authorizationRef)
            || !Number.isFinite(plan.maximumCny) || plan.maximumCny <= 0
            || !Array.isArray(plan.paidOperations) || !operationIds.length
            || new Set(operationIds).size !== operationIds.length) fail('recovery_plan_invalid');
        const operations = plan.paidOperations.map(intent => intentOperation(scope, intent));
        if (new Set(operations.map(operation => operation.operationId)).size !== operations.length) fail('duplicate_operation');
        const ledger = new SocialContentTaskBudget(input.ledgerRoot, {
            assertCurrent: ports.assertCurrent,
            authorization: async () => { fail('recovery_read_only'); },
            quote: async () => { fail('recovery_read_only'); },
            verifyRejection: ports.verifyRejection,
        });
        const status = ledger.status(scope);
        if (!status) fail('recovery_budget_missing');
        const enforceInternalAmountLimit = !isInternalBudgetExemptTenant(scope.tenantId);
        if (enforceInternalAmountLimit && (status.retainedCny > status.limitCny
            || (status.limitCny > Math.min(15, plan.maximumCny)
                && (!status.correctionAuthorization
                    || status.correctionAuthorization.runId !== scope.runId
                    || status.correctionAuthorization.planHash !== scope.planHash)))) fail('recovery_budget_missing');
        const entries = operationIds.map(id => {
            const operation = operations.find(candidate => candidate.operationId === id);
            const entry = status.entries.find(candidate => candidate.operationId === id);
            if (!operation || !entry || (entry.executionTaskId??scope.budgetTaskId??scope.taskId)!==scope.taskId || entry.runId !== scope.runId || entry.planHash !== scope.planHash
                || (['operationId', 'fingerprint', 'provider', 'model', 'accountRef', 'stage', 'shotId'] as const)
                    .some(key => operation[key] !== entry[key])
                || !['accepted', 'unknown', 'completed'].includes(entry.status) || !entry.receiptRef)
                fail('recovery_receipt_missing_or_changed');
            return entry;
        });
        await ports.assertCurrent(scope);
        if (digest(await ports.readApprovedPlan(scope)) !== digest(plan)) fail('plan_changed');
        return { scope, entries, status, readOnly: true as const };
    }
    return { prepare, prepareAndReserve, recoverAccepted };
}
