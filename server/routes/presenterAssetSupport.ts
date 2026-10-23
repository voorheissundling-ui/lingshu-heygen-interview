import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { currentDataAuthority } from '../storage/dataAuthority.js';
import type { DataStore } from '../storage/datastore.js';
import { HeyGenPresenterClient, HeyGenRequestError } from '../lib/heygenPresenters.js';
import { StudioPaidBudget } from '../lib/studioPaidBudget.js';
import { isInternalBudgetExemptTenant } from '../lib/tenantBudgetExemption.js';
import type { PresenterVideoInfo } from '../lib/presenterVideo.js';
import type { PresenterCreation, PresenterLook } from '../../src/lib/presenterAssets.js';

const COLLECTION = 'studio_presenter_assets';
type Row = { id: string; tenant_id: string; request_id: string; kind: string; payload: any };
const validId = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_:.-]{1,150}$/.test(v);
const message = (e: unknown) => e instanceof Error ? e.message : '人物服务暂时不可用';
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const consentAccepted = (value: unknown) => ['accepted', 'approved'].includes(String(value || '').toLowerCase());
const consentStatus = (value: unknown) => consentAccepted(value) ? 'accepted' : String(value || '').toLowerCase() || 'pending';
const consentAlreadyProcessing = (error: unknown) => error instanceof HeyGenRequestError
  && error.status === 409
  && /consent.*processing|processing.*consent|already.*consent/i.test(error.message);
type CuratedPresenterGroup = { name: string; groupId: string; asian?: boolean };
const presenterCuration = (tenantId: string): { favoriteNames: Set<string>; asianNames: Set<string>; favoriteGroups: CuratedPresenterGroup[] } => {
  try {
    const document = JSON.parse(fs.readFileSync(path.resolve('data/heygen-presenter-curation.json'), 'utf8'));
    const tenantEntries = document?.tenants && typeof document.tenants === 'object' ? Object.values(document.tenants) : [];
    const entry = document?.tenants?.[tenantId] || (currentDataAuthority() === 'local' && tenantEntries.length === 1 ? tenantEntries[0] : {}) || {};
    const names = (value: unknown) => new Set((Array.isArray(value) ? value : []).map(item => String(item).trim().toLowerCase()).filter(Boolean));
    const favoriteGroups = (Array.isArray((entry as any).favoriteGroups) ? (entry as any).favoriteGroups : [])
      .filter((item: any) => item && typeof item.name === 'string' && typeof item.groupId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(item.groupId))
      .map((item: any) => ({ name: item.name.trim().slice(0, 100), groupId: item.groupId, asian: item.asian === true }));
    return { favoriteNames: names((entry as any).favoriteNames), asianNames: names((entry as any).asianNames), favoriteGroups };
  } catch { return { favoriteNames: new Set(), asianNames: new Set(), favoriteGroups: [] }; }
};
const curatedName = (names: Set<string>, value: string): string | undefined => {
  const normalized = value.trim().toLowerCase();
  return [...names].find(name => normalized === name || normalized.startsWith(`${name} `));
};
export interface PresenterAssetsOptions {
  client?: HeyGenPresenterClient; configured?: () => boolean; enabled?: () => boolean; directConsent?: () => boolean;
  reserve?: (id: string) => Promise<void>;
  budgetExempt?: (tenantId: string) => boolean;
  trimVideo?: (bytes: Buffer, seconds: number) => Promise<Buffer>;
  extractFrame?: (bytes: Buffer, seconds: number) => Promise<Buffer>;
  normalizeTrainingVideo?: (bytes: Buffer) => Promise<Buffer>;
  normalizeVoiceAudio?: (bytes: Buffer) => Promise<Buffer>;
  inspectVideo?: (bytes: Buffer) => Promise<PresenterVideoInfo>;
  materialBelongs?: (tenantId: string, materialId: string, type: 'image' | 'video') => boolean;
}

export function createPresenterAssetsContext(store: DataStore, options: PresenterAssetsOptions) {
  const client = () => options.client || new HeyGenPresenterClient(process.env.HEYGEN_API_KEY || '');
  const configured = () => options.configured?.() ?? Boolean(process.env.HEYGEN_API_KEY);
  const enabled = () => options.enabled?.() ?? (configured() && process.env.HEYGEN_GENERATION_ENABLED === 'true');
  const directConsent = () => options.directConsent?.() ?? process.env.HEYGEN_DIRECT_CONSENT_ENABLED === 'true';
  const budgetExempt = (tenant: string) => options.budgetExempt?.(tenant) ?? isInternalBudgetExemptTenant(tenant);
  const privateCatalog = (tenant: string) => Boolean(tenant && process.env.HEYGEN_PRIVATE_ASSET_TENANT_ID === tenant);
  const canCreateFor = (tenant: string) => !process.env.HEYGEN_PRIVATE_ASSET_TENANT_ID || privateCatalog(tenant);
  const creationReservation = (type: 'photo' | 'digital_twin') => type === 'photo'
    ? process.env.STUDIO_HEYGEN_PHOTO_AVATAR_RESERVE_CNY || process.env.STUDIO_HEYGEN_AVATAR_RESERVE_CNY || process.env.STUDIO_HEYGEN_RESERVE_CNY || ''
    : process.env.STUDIO_HEYGEN_DIGITAL_TWIN_RESERVE_CNY || process.env.STUDIO_HEYGEN_AVATAR_RESERVE_CNY || process.env.STUDIO_HEYGEN_RESERVE_CNY || '';
  const creationBudget = (type: 'photo' | 'digital_twin') => new StudioPaidBudget(path.resolve('data/studio-presenter-paid-budget'), () => {
    const amount = (value: string | undefined, zero = false) => { if (!value || !/^\d+(\.\d{1,6})?$/.test(value)) throw new Error('人物创建预算尚未配置'); const units = Math.round(Number(value) * 1e6); if (!Number.isSafeInteger(units) || (zero ? units < 0 : units <= 0)) throw new Error('人物创建预算无效'); return units; };
    return { limit: amount(process.env.STUDIO_PRESENTER_PAID_BUDGET_CNY || process.env.STUDIO_PAID_BUDGET_CNY), openingUsed: amount(process.env.STUDIO_PRESENTER_PAID_OPENING_USED_CNY || process.env.STUDIO_PAID_OPENING_USED_CNY, true), reserve: { heygen: amount(creationReservation(type)), qwen_asr: 1 } };
  });
  const checkPrivateAccount = async (tenant: string) => {
    if (!privateCatalog(tenant)) throw new Error('企业专属人物账号尚未连接');
    // A platform key that has created other tenants' people cannot later be
    // exposed wholesale just by adding an owner setting.
    for (const kind of ['creation', 'voice_clone']) {
      let complete = false;
      for (let page = 1; page <= 20; page++) {
        const rows = await store.list<Row>(COLLECTION, { where: { kind }, page, perPage: 100 });
        // Legacy preview mocks never reached HeyGen and therefore do not prove
        // that the provider workspace contains another tenant's private data.
        if (rows.items.some(row => row.tenant_id !== tenant && row.payload?.mock !== true)) throw new Error('此 HeyGen 工作区已有其他企业的私人资产记录，不能作为当前企业专属账号使用');
        if (page >= rows.totalPages) { complete = true; break; }
      }
      if (!complete) throw new Error('专属账号归属记录尚未核验完整，暂不能读取私人资产');
    }
  };
  // Only provider-confirmed public looks can be imported from this catalog.
  const publicLooks = new Map<string, { look: PresenterLook; at: number; private: boolean }>();
  const publicVoices = new Map<string, number>();
  const validVoice = (id: string) => Date.now() - (publicVoices.get(id) || 0) < 1800000;
  const privateVoice = async (id: string) => {
    let token = '';
    for (let page = 0; page < 20; page++) {
      const result = await client().voices(token, '', 'private');
      const voice = result.items.find(item => item.id === id);
      if (voice) return voice;
      if (!result.nextToken) break;
      token = result.nextToken;
    }
    throw new Error('该音色不在当前 HeyGen 私人音色库中');
  };
  const own = async (id: string, tenant: string, kind: string) => {
    const row = await store.getById<Row>(COLLECTION, id);
    if (!row || row.tenant_id !== tenant || row.kind !== kind) throw new Error('当前企业的人物任务或素材不存在');
    return row;
  };
  const find = async (tenant: string, kind: string, requestId: string) => (await store.list<Row>(COLLECTION, { where: { tenant_id: tenant, kind, request_id: requestId }, perPage: 1 })).items[0];
  const cloneByHeygenVoice = async (tenant: string, voiceId: string) => {
    const rows = await store.list<Row>(COLLECTION, { where: { tenant_id: tenant, kind: 'voice_clone' }, perPage: 100 });
    return rows.items.find(row => row.payload?.voiceId === voiceId || (Array.isArray(row.payload?.candidateVoiceIds) && row.payload.candidateVoiceIds.includes(voiceId)));
  };
  const write = async (row: Row, patch: Record<string, unknown>) => {
    const payload = { ...row.payload, ...patch, updatedAt: new Date().toISOString() };
    if (!await store.update(COLLECTION, row.id, { payload })) throw new Error('人物状态保存失败，请刷新原任务，不要重复创建');
    row.payload = payload;
    return publicJob(row);
  };
  const publicJob = (row: Row): PresenterCreation => {
    const p = row.payload;
    return { id: row.id, name: p.name, type: p.type, voiceId: p.voiceId, status: p.status, look: p.look,
      groupId: p.groupId, error: p.error, failureCategory: p.failureCategory, consentUrl: p.consentUrl,
      consentStatus: p.consentStatus,
      consentRequestedAt: p.consentRequestedAt || (p.consentUrl ? p.updatedAt : undefined),
      arkPreparation: p.arkPreparation,
      createdAt: p.createdAt, updatedAt: p.updatedAt };
  };
  const refresh = async (row: Row) => {
    // Older builds recorded every provider 400 as "uncertain" even though an
    // HTTP 400 is a definitive rejection and no remote task was accepted.
    // Reconcile those retained rows on the user's explicit refresh without
    // issuing another paid create call.
    if (!row.payload.groupId && row.payload.status === 'uncertain' && /^HeyGen 400[：:]/.test(String(row.payload.error || ''))) {
      return write(row, { status: 'failed', error: 'HeyGen 未受理这次人物创建。请返回修改素材后重新提交' });
    }
    if (!row.payload.groupId) throw new Error('提交结果尚未核实，请管理员核对原任务；刷新不会重新创建或计费');
    const group = await client().group(row.payload.groupId);
    const looks = row.payload.look?.id ? [await client().look(row.payload.look.id)] : await client().groupLooks(row.payload.groupId);
    const look = looks.find(item => item.id === row.payload.look?.id) || looks[0];
    const failed = group.status === 'failed' || look?.status === 'failed';
    // Every tenant-created person must be backed by provider-confirmed consent.
    // A local declaration or a completed avatar render is never sufficient.
    // HeyGen's hosted consent flow applies only to digital twins. Photo
    // avatars deliberately return a null consent_status; the explicit local
    // subject authorization retained on the creation is the evidence for them.
    const consentPending = group.status === 'pending_consent'
      || (row.payload.type === 'digital_twin' && !consentAccepted(group.consent_status));
    const status = failed ? 'failed' : consentPending ? 'pending_consent' : group.status === 'completed' && look?.status === 'completed' ? 'completed' : 'processing';
    return write(row, { status, look, consentStatus: consentStatus(group.consent_status), authorized: status === 'completed', error: failed ? '人物处理失败，请检查素材或授权录制要求' : '', ...(status === 'completed' ? { consentUrl: undefined } : {}) });
  };
  return { client, configured, enabled, directConsent, budgetExempt, privateCatalog, canCreateFor, creationBudget,
    checkPrivateAccount, publicLooks, publicVoices, validVoice, privateVoice, own, find, cloneByHeygenVoice,
    write, publicJob, refresh };
}

export { COLLECTION, validId, message, hash, consentAccepted, consentStatus, consentAlreadyProcessing, presenterCuration, curatedName };
export type { Row };
