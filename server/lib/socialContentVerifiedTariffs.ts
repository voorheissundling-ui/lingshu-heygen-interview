import {verifyHeyGenPublishedTariff} from './heygenPublishedPricing.js';
import {verifySeedreamPublishedTariff} from './seedreamPublishedPricing.js';
import {verifyNativeVoicePublishedTariff} from './studioVoicePublishedPricing.js';
import {verifyWanPublishedTariff} from './wanPublishedPricing.js';
import {isVerifiedPublishedTariff} from './socialContentPublishedTariffs.js';
import { createHash } from 'node:crypto';
import type { DataStore, Record_ } from '../storage/datastore.js';
import type { SocialPaidOperationIntent, SocialVerifiedAccountTariff } from './socialContentTaskBudgetAuthority.js';
export const SOCIAL_VERIFIED_TARIFFS = 'social_content_verified_tariffs';
export const SOCIAL_TARIFF_EVIDENCE = 'social_content_tariff_evidence';
/** Only a trusted internal price-verification writer may create these records.
 * There is intentionally no HTTP write/provision operation in this module. */
export interface SocialVerifiedTariffPayload {
    schemaVersion: 1;
    tenantId: string;
    tariff: SocialVerifiedAccountTariff;
    evidenceSha256: string;
    verifiedBy: string;
    verifiedAt: string;
}
export interface SocialTariffEvidencePayload {
    schemaVersion: 1;
    tenantId: string;
    tariff: SocialVerifiedAccountTariff;
    sourceRef: string;
    sourceSha256: string;
    verifiedBy: string;
    verifiedAt: string;
}
function sorted(value: unknown): unknown { if (Array.isArray(value))
    return value.map(sorted); if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sorted(v)])); return value; }
export function socialTariffRecordHash(payload: SocialVerifiedTariffPayload | SocialTariffEvidencePayload) { return createHash('sha256').update(JSON.stringify(sorted(payload))).digest('hex'); }
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
function fail(code: string): never { throw Error(`social_verified_tariff_${code}`); }
function string(s: unknown): s is string { return typeof s === 'string' && s.trim() === s && s.length > 0 && s.length <= 512; }
function payload(row: Record_): unknown { try {
    return typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
}
catch {
    return fail('record_corrupt');
} }
function time(value: string, now: number) { return Number.isFinite(Date.parse(value)) && Date.parse(value) <= now; }
function binding(row: Record_, tenantId: string, intent: SocialPaidOperationIntent) { if (row.tenant_id !== tenantId || row.provider !== intent.provider || row.model !== intent.model || row.account_ref !== intent.accountRef || row.stage !== intent.stage)
    fail('scope_mismatch'); }
function tariffValid(t: SocialVerifiedAccountTariff, intent: SocialPaidOperationIntent, now: number) {
    if (!t || t.currency !== 'CNY' || !((t.verifiedAccountPrice===true&&(!t.pricingBasis||t.pricingBasis==='negotiated_verified_account'))||isVerifiedPublishedTariff(t)||verifyWanPublishedTariff(t)||verifySeedreamPublishedTariff(t)||verifyHeyGenPublishedTariff(t)) || !string(t.evidenceRef) || ['provider', 'model', 'accountRef', 'stage'].some(k => t[k as 'provider'] !== intent[k as 'provider']) || !time(t.checkedAt, now) || !Number.isFinite(Date.parse(t.validUntil)) || Date.parse(t.validUntil) <= now || !t.meters || typeof t.meters !== 'object' || Array.isArray(t.meters) || !Object.keys(t.meters).length)
        fail('invalid_or_expired');
    const keys = Object.keys(t.meters).sort();
    if (JSON.stringify(keys) !== JSON.stringify(Object.keys(intent.maximumUnits).sort()))
        fail('usage_units_mismatch');
    for (const [unit, meter] of Object.entries(t.meters))
        if (!string(unit) || !meter || !Number.isFinite(meter.priceCny) || meter.priceCny < 0 || !Number.isFinite(meter.unitsPerPrice) || meter.unitsPerPrice <= 0 || !Number.isFinite(meter.minimumUnits) || meter.minimumUnits < 0 || !Number.isFinite(meter.increment) || meter.increment <= 0)
            fail('meter_invalid');
}
/** Missing data returns null; ambiguous/corrupt evidence fails closed. Prices are
 * read from tenant-scoped durable account evidence, never request or env values. */
export function createSocialContentVerifiedTariffReader(store: Pick<DataStore, 'list' | 'getById'>, tenantId: string, clock: () => number = Date.now) {
    if (!string(tenantId))
        fail('tenant_invalid');
    return { async read(intent: SocialPaidOperationIntent): Promise<SocialVerifiedAccountTariff | null> {
            if (![intent.provider, intent.model, intent.accountRef, intent.stage].every(string) || !intent.maximumUnits || typeof intent.maximumUnits !== 'object' || Array.isArray(intent.maximumUnits))
                fail('request_invalid');
            const rows = await store.list<Record_>(SOCIAL_VERIFIED_TARIFFS, { where: { tenant_id: tenantId, provider: intent.provider, model: intent.model, account_ref: intent.accountRef, stage: intent.stage, status: 'active' }, page: 1, perPage: 2 });
            if (!Number.isSafeInteger(rows.totalItems) || rows.totalItems < 0 || rows.totalItems !== rows.items.length || rows.items.length > 1)
                fail('ambiguous');
            if (!rows.items.length)
                return null;
            const row = rows.items[0]!;
            binding(row, tenantId, intent);
            if (row.status !== 'active')
                fail('record_corrupt');
            const p = payload(row) as SocialVerifiedTariffPayload;
            const now = clock();
            if (!p || p.schemaVersion !== 1 || p.tenantId !== tenantId || !string(p.verifiedBy) || !time(p.verifiedAt, now) || !/^[a-f0-9]{64}$/.test(p.evidenceSha256) || row.record_hash !== socialTariffRecordHash(p))
                fail('record_corrupt');
            tariffValid(p.tariff, intent, now);
            const evidence = await store.getById<Record_>(SOCIAL_TARIFF_EVIDENCE, p.tariff.evidenceRef);
            if (!evidence)
                return null;
            binding(evidence, tenantId, intent);
            if (evidence.id !== p.tariff.evidenceRef || evidence.status !== 'verified')
                fail('evidence_unverified');
            const e = payload(evidence) as SocialTariffEvidencePayload;
            if (!e || e.schemaVersion !== 1 || e.tenantId !== tenantId || !string(e.sourceRef) || !string(e.verifiedBy) || !time(e.verifiedAt, now) || !/^[a-f0-9]{64}$/.test(e.sourceSha256) || e.sourceSha256 !== p.evidenceSha256 || evidence.record_hash !== socialTariffRecordHash(e) || JSON.stringify(sorted(e.tariff)) !== JSON.stringify(sorted(p.tariff)))
                fail('evidence_mismatch');
            if (typeof evidence.source_body !== 'string' || evidence.source_body.length < 1 || Buffer.byteLength(evidence.source_body) > 2 * 1024 * 1024 || sha(evidence.source_body) !== e.sourceSha256)
                fail('source_bytes_changed');
            return structuredClone(p.tariff);
        } };
}
