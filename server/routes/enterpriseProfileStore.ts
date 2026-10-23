import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash, randomUUID } from 'crypto';
import { enterpriseProductIdentity } from '../lib/enterpriseProductIdentity.js';
import { ensureProductScenePreparationPlan } from '../../shared/contracts/productScenePreparation.js';
import { store } from '../storage/index.js';
import type { AutonomyLevel } from '../autonomy/actionRules.js';
import { mergeEnterpriseProfilePatch, profileWithSavedGovernance, verifyEnterpriseFactContentWithHash } from './enterpriseProfileHelpers.js';
import type { QuoteMode, BargainPolicy, NotificationChannel, BizRules, FaqItem, NotificationSettings, HandoffRules,
  PartialAutoReplyDecision, CustomerServiceSettings, CustomerServicePolicy, CustomerServiceStatus, SalesStyleProfile, EnterpriseProfile } from './enterpriseProfileContracts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, '../../data/enterprise.json');

export const DEFAULT_BIZ_RULES: BizRules = {
  quoteMode: 'human_only',
  priceRange: '',
  bargainPolicy: 'no',
  bargainFloor: '',
  moq: '',
  samplePolicy: '',
  paymentTerms: '',
  leadTime: '',
};

export const DEFAULT_NOTIFICATIONS: NotificationSettings = {
  receivers: [],
  workHours: { start: '09:00', end: '22:00' },
  quietOutsideHours: true,
  nightMode: { enabled: false, autoCategories: 'approved' },
  lastTestAt: '',
};

const CUSTOMER_SERVICE_OBSERVATION_MS = 3 * 24 * 60 * 60 * 1000;
const DEFAULT_CUSTOMER_SERVICE: CustomerServiceSettings = {
  enabled: false,
  enabledAt: '',
  disabledAt: '',
  partialAutoReplyEnabled: false,
  partialAutoReplyDecision: 'pending',
  partialAutoReplyDecisionAt: '',
};

const DEFAULT_HANDOFF_RULES: HandoffRules = {
  keywords: ['人工', '老板', 'manager', 'complaint', 'refund'],
  missStreakToDraft: 2,
  negativeSentiment: true,
};

export function readProfile(): EnterpriseProfile {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    // Reads are side-effect free. Legacy embedded integration credentials are
    // ignored here; any historical credential migration must be an explicit,
    // audited operator command rather than an implicit GET-time write.
    delete parsed.integrations;
    return normalizeProfile(parsed);
  } catch {
    return normalizeProfile({
      company: { name: '', industry: '', companyType: '', mainMarkets: '', primaryLanguages: '', founded: '', description: '' },
      products: {
        categories: '',
        priceRange: '',
        moq: '',
        certifications: '',
        highlights: '',
        items: [],
      },
      brand: { name: '', tone: '', style: '', taboos: '', usp: '', preferredLanguages: '' },
      strategy: { currentGoal: '', focusProducts: '', focusMarkets: '', excludedMarkets: '', pricingStrategy: '', minMargin: '', agentAutonomy: '', aiAutonomy: 'draft' },
      customers: { targetProfiles: '', highValueSignals: '', lowQualitySignals: '', commonQuestions: '', followupStyle: '' },
      operations: { leadTime: '', customization: '', logistics: '', paymentTerms: '', riskNotes: '' },
      agentLearning: { provenAngles: '', weakAngles: '', pendingAssumptions: '', userCorrections: '' },
      bizRules: { ...DEFAULT_BIZ_RULES },
      faq: [],
      notifications: { ...DEFAULT_NOTIFICATIONS, workHours: { ...DEFAULT_NOTIFICATIONS.workHours } },
      handoffRules: { ...DEFAULT_HANDOFF_RULES, keywords: [...DEFAULT_HANDOFF_RULES.keywords] },
      customerService: { ...DEFAULT_CUSTOMER_SERVICE },
      salesStyleProfile: { learnedFromCount: 0, sample_pairs: [] },
      knowledge: '',
    });
  }
}

function emptyProduct(index: number): NonNullable<EnterpriseProfile['products']['items']>[number] {
  return {
    id: randomUUID(),
    name: `产品${index + 1}`,
    images: [],
    videos: [],
    documents: [],
    factoryImages: [],
    packagingImages: [],
    certificateImages: [],
    sceneImages: [],
    brandAssets: [],
  };
}

function normalizedIso(value: unknown): string {
  const timestamp = Date.parse(text(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
}

export function normalizeCustomerServiceSettings(input: EnterpriseProfile['customerService']): CustomerServiceSettings {
  const enabled = input?.enabled === true;
  const partialAutoReplyEnabled = enabled && input?.partialAutoReplyEnabled === true;
  const rawDecision = input?.partialAutoReplyDecision;
  const partialAutoReplyDecision: PartialAutoReplyDecision = partialAutoReplyEnabled
    ? 'enabled'
    : rawDecision === 'declined'
      ? 'declined'
      : 'pending';
  return {
    enabled,
    enabledAt: enabled ? normalizedIso(input?.enabledAt) : '',
    disabledAt: normalizedIso(input?.disabledAt),
    partialAutoReplyEnabled,
    partialAutoReplyDecision,
    partialAutoReplyDecisionAt: normalizedIso(input?.partialAutoReplyDecisionAt),
  };
}

export function customerServicePolicyFromSettings(
  input: CustomerServiceSettings | undefined,
  nowMs = Date.now(),
): CustomerServicePolicy {
  const settings = normalizeCustomerServiceSettings(input);
  const enabledAtMs = Date.parse(settings.enabledAt || '');
  const elapsedMs = settings.enabled && Number.isFinite(enabledAtMs)
    ? Math.max(0, nowMs - enabledAtMs)
    : 0;
  const eligibleForPartialAutoReply = settings.enabled
    && Number.isFinite(enabledAtMs)
    && elapsedMs >= CUSTOMER_SERVICE_OBSERVATION_MS;
  const partialAutoReplyEnabled = eligibleForPartialAutoReply && settings.partialAutoReplyEnabled;
  return {
    enabled: settings.enabled,
    enabledAt: settings.enabledAt || '',
    observationDay: settings.enabled ? Math.min(3, Math.floor(elapsedMs / (24 * 60 * 60 * 1000)) + 1) : 0,
    remainingHours: settings.enabled
      ? Math.max(0, Math.ceil((CUSTOMER_SERVICE_OBSERVATION_MS - elapsedMs) / (60 * 60 * 1000)))
      : 72,
    eligibleForPartialAutoReply,
    partialAutoReplyEnabled,
    partialAutoReplyDecision: settings.partialAutoReplyDecision,
    shouldAskPartialAutoReply: eligibleForPartialAutoReply
      && settings.partialAutoReplyDecision === 'pending'
      && !partialAutoReplyEnabled,
    canAutoSend: settings.enabled && partialAutoReplyEnabled,
  };
}

export function customerServicePolicy(profile: EnterpriseProfile, nowMs = Date.now()): CustomerServicePolicy {
  return customerServicePolicyFromSettings(profile.customerService, nowMs);
}

export function customerServiceStatus(profile: EnterpriseProfile, nowMs = Date.now()): CustomerServiceStatus {
  const policy = customerServicePolicy(profile, nowMs);
  const approvedFaqCount = (profile.faq ?? []).filter(item => item.approvedForAuto && item.question && item.answer).length;
  return {
    ...policy,
    approvedFaqCount,
    autoReplyReady: policy.canAutoSend
      && approvedFaqCount >= 5
      && normalizeAutonomy(profile.strategy?.aiAutonomy) === 'auto',
  };
}

export function normalizeProfile(profile: EnterpriseProfile): EnterpriseProfile {
  const companyInput = (profile.company ?? {}) as Partial<EnterpriseProfile['company']>;
  const company = {
    name: text(companyInput.name),
    industry: text(companyInput.industry),
    companyType: text(companyInput.companyType),
    mainMarkets: text(companyInput.mainMarkets),
    primaryLanguages: text(companyInput.primaryLanguages),
    socialPlatformExperience: text(companyInput.socialPlatformExperience),
    founded: text(companyInput.founded),
    description: text(companyInput.description),
  };
  const products = profile.products ?? { categories: '', priceRange: '', moq: '', certifications: '', highlights: '' };
  const existing = Array.isArray(products.items) ? products.items : [];
  const items = existing.length
    ? existing.map((item, index) => {
      const id = enterpriseProductIdentity(item, index);
      return {
        ...item,
        id,
        // 空名称代表尚在编辑的产品草稿，不能在保存时隐式删除。
        name: typeof item.name === 'string' ? item.name : (item.sku || ''),
        images: Array.isArray(item.images) ? item.images : [],
        videos: Array.isArray(item.videos) ? item.videos : [],
        documents: Array.isArray(item.documents) ? item.documents : [],
        factoryImages: Array.isArray(item.factoryImages) && item.factoryImages.length ? item.factoryImages : (Array.isArray(item.videos) ? item.videos : []),
        packagingImages: Array.isArray(item.packagingImages) ? item.packagingImages : [],
        certificateImages: Array.isArray(item.certificateImages) && item.certificateImages.length ? item.certificateImages : (Array.isArray(item.documents) ? item.documents : []),
        sceneImages: Array.isArray(item.sceneImages) ? item.sceneImages : [],
        brandAssets: Array.isArray(item.brandAssets) ? item.brandAssets : [],
        productScenePreparation: ensureProductScenePreparationPlan(id, item.productScenePreparation),
      };
    })
    : [];
  const operations = {
    leadTime: '',
    customization: '',
    logistics: '',
    paymentTerms: '',
    riskNotes: '',
    ...(profile.operations ?? {}),
  };
  const bizRules = normalizeBizRules(profile.bizRules, products, operations);
  const notifications = normalizeNotifications(profile.notifications);
  const handoffRules = normalizeHandoffRules(profile.handoffRules);
  const customerService = normalizeCustomerServiceSettings(profile.customerService);
  const salesStyleProfile = normalizeSalesStyleProfile(profile.salesStyleProfile);
  const faq = normalizeFaq(profile.faq);
  const strategy = { ...(profile.strategy ?? {}), aiAutonomy: normalizeAutonomy(profile.strategy?.aiAutonomy) };
  const brandInput = (profile.brand ?? {}) as Partial<EnterpriseProfile['brand']>;
  const brand = {
    name: text(brandInput.name),
    tone: text(brandInput.tone),
    style: text(brandInput.style),
    taboos: text(brandInput.taboos),
    usp: text(brandInput.usp),
    preferredLanguages: text(brandInput.preferredLanguages),
  };
  const dataGovernance = {
    aiAccessEnabled: profile.dataGovernance?.aiAccessEnabled !== false,
    lastSavedAt: text(profile.dataGovernance?.lastSavedAt),
    lastSavedSource: profile.dataGovernance?.lastSavedSource,
  };
  const onboardingInput = profile.digitalEmployeeOnboarding ?? {};
  const digitalEmployeeOnboarding = {
    profileConfirmedAt: text(onboardingInput.profileConfirmedAt),
    productSelectionConfirmedAt: text(onboardingInput.productSelectionConfirmedAt),
    continuedWithoutProducts: onboardingInput.continuedWithoutProducts === true,
  };
  const socialInput: NonNullable<EnterpriseProfile['socialStrategy']> = profile.socialStrategy ?? { enabledRoutes: [], routeStrategies: {} };
  const allowedRoutes = ['oem_odm', 'wholesale_distribution', 'consumer_retail'] as const;
  let enabledRoutes = Array.isArray(socialInput.enabledRoutes)
    ? socialInput.enabledRoutes.filter((route): route is typeof allowedRoutes[number] => allowedRoutes.includes(route))
    : [];
  if (!enabledRoutes.length) {
    const inferenceSource = `${company.companyType} ${products.categories} ${products.highlights} ${operations.customization}`.toLowerCase();
    if (/oem|odm|定制|贴牌|工厂|工贸/.test(inferenceSource)) enabledRoutes = ['oem_odm'];
    else if (/批发|经销|现货|wholesale|distributor/.test(inferenceSource)) enabledRoutes = ['wholesale_distribution'];
    else if (/零售|消费者|retail|consumer/.test(inferenceSource)) enabledRoutes = ['consumer_retail'];
  }
  const defaultBuyers: Record<typeof allowedRoutes[number], string[]> = {
    oem_odm: ['品牌创始人', '产品经理', '采购'],
    wholesale_distribution: ['进口商', '经销商', '渠道采购'],
    consumer_retail: ['终端消费者'],
  };
  const routeStrategies = Object.fromEntries(enabledRoutes.map(route => {
    const source: { targetBuyerRoles: string[]; primaryCta: string } = socialInput.routeStrategies?.[route] ?? { targetBuyerRoles: defaultBuyers[route], primaryCta: '引导通过 Messenger 联系' };
    return [route, { targetBuyerRoles: Array.isArray(source.targetBuyerRoles) && source.targetBuyerRoles.length ? source.targetBuyerRoles.map(text).filter(Boolean) : defaultBuyers[route], primaryCta: text(source.primaryCta) || '引导通过 Messenger 联系' }];
  }));
  const allowedContentStages = ['b2b_launch', 'b2b_growth', 'd2c_brand'] as const;
  const contentStage = allowedContentStages.includes(socialInput.contentStage as typeof allowedContentStages[number])
    ? socialInput.contentStage as typeof allowedContentStages[number]
    : undefined;
  const presetByStage = { b2b_launch: 'b2b_starting', b2b_growth: 'b2b_growing', d2c_brand: 'dtc_sales' } as const;
  const weeklyTaskPackagePreset = contentStage ? presetByStage[contentStage] : undefined;
  const factVersionInput = profile.factVersion;
  const factVersion = factVersionInput && Number.isInteger(Number(factVersionInput.revision))
    && Number(factVersionInput.revision) > 0 && text(factVersionInput.contentHash)
    ? {
      id: text(factVersionInput.id),
      revision: Number(factVersionInput.revision),
      contentHash: text(factVersionInput.contentHash),
      confirmedAt: text(factVersionInput.confirmedAt),
      confirmedBy: text(factVersionInput.confirmedBy),
    }
    : undefined;
  return {
    ...profile,
    company,
    brand,
    operations,
    strategy,
    products: { ...products, searchKeywords: text(products.searchKeywords), items },
    bizRules,
    faq,
    notifications,
    handoffRules,
    customerService,
    salesStyleProfile,
    dataGovernance,
    digitalEmployeeOnboarding,
    socialStrategy: { enabledRoutes, routeStrategies, manuallyEditedFields: Array.isArray(socialInput.manuallyEditedFields) ? socialInput.manuallyEditedFields.map(text).filter(Boolean) : [], contentStage, weeklyTaskPackagePreset },
    ...(factVersion ? { factVersion } : {}),
  };
}

function stableFactJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableFactJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'factVersion' && key !== 'lastSavedAt' && key !== 'lastSavedSource'
        && key !== 'lastSavedBy' && key !== 'productScenePreparation')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableFactJson(child)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function enterpriseFactContentHash(profile: EnterpriseProfile): string {
  return createHash('sha256').update(stableFactJson(normalizeProfile(profile))).digest('hex');
}

/** Verify an existing confirmation without issuing a new confirmation. The old
 * minimal-onboarding writer explicitly assigned focusProducts: undefined; the
 * hash serializer encoded it as null, while JSON storage omitted the property.
 * Replay only that documented write shape and require the ENTIRE old digest to
 * match. A changed product, company field, or other missing property still fails.
 */
export function verifyEnterpriseFactContent(profile: EnterpriseProfile) {
  return verifyEnterpriseFactContentWithHash(profile, enterpriseFactContentHash);
}

function confirmedFactVersion(
  profile: EnterpriseProfile,
  previous?: EnterpriseProfile | null,
  confirmedBy = 'system',
  now = new Date(),
): NonNullable<EnterpriseProfile['factVersion']> {
  const contentHash = enterpriseFactContentHash(profile);
  const prior = previous?.factVersion;
  if (prior?.contentHash === contentHash && prior.id && prior.revision > 0) return prior;
  const revision = Math.max(0, Number(prior?.revision || 0)) + 1;
  return {
    id: `enterprise-facts-v${revision}-${contentHash.slice(0, 12)}`,
    revision,
    contentHash,
    confirmedAt: now.toISOString(),
    confirmedBy: text(confirmedBy) || 'system',
  };
}

function withConfirmedFactVersion(
  profile: EnterpriseProfile,
  previous?: EnterpriseProfile | null,
  confirmedBy = 'system',
  now = new Date(),
): EnterpriseProfile {
  const normalized = normalizeProfile(profile);
  normalized.factVersion = confirmedFactVersion(normalized, previous, confirmedBy, now);
  return normalized;
}

export function mergeEnterpriseProfile(current: EnterpriseProfile, patch: Partial<EnterpriseProfile>): EnterpriseProfile {
  return normalizeProfile(mergeEnterpriseProfilePatch(current, patch) as EnterpriseProfile);
}

export function markProfileSaved(profile: EnterpriseProfile, source: NonNullable<EnterpriseProfile['dataGovernance']>['lastSavedSource']): EnterpriseProfile {
  return normalizeProfile(profileWithSavedGovernance(profile, source));
}

function styleField(input: unknown): { value: string; evidence: string; manual?: boolean } | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as Record<string, unknown>;
  const value = text(raw.value);
  const evidence = text(raw.evidence);
  if (!value && !evidence) return undefined;
  return { value, evidence, manual: raw.manual === true };
}

function normalizeSalesStyleProfile(input: EnterpriseProfile['salesStyleProfile']): SalesStyleProfile {
  const tabooRaw = input?.taboo_phrases;
  const tabooValue = Array.isArray(tabooRaw?.value) ? tabooRaw.value.map(item => text(item)).filter(Boolean) : [];
  return {
    learnedFromCount: Math.max(0, Number(input?.learnedFromCount || 0) || 0),
    lastDistilledAt: text(input?.lastDistilledAt),
    greeting_style: styleField(input?.greeting_style),
    quoting_stance: styleField(input?.quoting_stance),
    followup_rhythm: styleField(input?.followup_rhythm),
    taboo_phrases: tabooValue.length || tabooRaw?.manual ? { value: tabooValue, evidence: text(tabooRaw?.evidence), manual: tabooRaw?.manual === true } : undefined,
    sample_pairs: Array.isArray(input?.sample_pairs) ? input.sample_pairs.map(item => ({
      trigger: text(item?.trigger),
      final: text(item?.final),
      evidence: text(item?.evidence),
    })).filter(item => item.trigger || item.final).slice(0, 8) : [],
  };
}

function normalizeHandoffRules(input: EnterpriseProfile['handoffRules']): HandoffRules {
  const rawKeywords = Array.isArray(input?.keywords) ? input.keywords : DEFAULT_HANDOFF_RULES.keywords;
  const keywords = Array.from(new Set(rawKeywords.map(item => text(item)).filter(Boolean))).slice(0, 20);
  const missRaw = Number(input?.missStreakToDraft);
  return {
    keywords: keywords.length ? keywords : [...DEFAULT_HANDOFF_RULES.keywords],
    missStreakToDraft: missRaw === 1 || missRaw === 3 ? missRaw : 2,
    negativeSentiment: input?.negativeSentiment !== false,
  };
}

function normalizeQuoteMode(value: unknown): QuoteMode {
  return value === 'range' || value === 'human_only' ? 'human_only' : '';
}

function normalizeBargainPolicy(value: unknown): BargainPolicy {
  return value === 'limited' || value === 'open' || value === 'no' ? value : 'no';
}

export function normalizeBizRules(
  input: EnterpriseProfile['bizRules'],
  products: EnterpriseProfile['products'],
  operations: NonNullable<EnterpriseProfile['operations']>,
): BizRules {
  const merged = { ...DEFAULT_BIZ_RULES, ...(input ?? {}) };
  const priceRange = text(merged.priceRange) || text(products.priceRange);
  const moq = text(merged.moq) || text(products.moq);
  const paymentTerms = text(merged.paymentTerms) || text(operations.paymentTerms);
  const leadTime = text(merged.leadTime) || text(operations.leadTime);
  const quoteMode = normalizeQuoteMode(merged.quoteMode) || (priceRange ? 'human_only' : '');
  return {
    quoteMode,
    priceRange,
    bargainPolicy: normalizeBargainPolicy(merged.bargainPolicy),
    bargainFloor: text(merged.bargainFloor),
    moq,
    samplePolicy: text(merged.samplePolicy),
    paymentTerms,
    leadTime,
  };
}

function normalizeFaq(input: EnterpriseProfile['faq']): FaqItem[] {
  if (!Array.isArray(input)) return [];
  return input.map(item => ({
    id: text(item?.id) || randomUUID(),
    question: text(item?.question),
    answer: text(item?.answer),
    approvedForAuto: Boolean(item?.approvedForAuto),
    source: normalizeFaqSource(item?.source),
  })).filter(item => item.question || item.answer);
}

function normalizeFaqSource(value: unknown): 'manual' | 'pack' | 'learned' {
  return value === 'pack' || value === 'learned' ? value : 'manual';
}

export function normalizeNotifications(input: EnterpriseProfile['notifications']): NotificationSettings {
  const receivers = Array.isArray(input?.receivers)
    ? input.receivers.map(receiver => ({
      name: text(receiver?.name),
      channel: normalizeNotificationChannel(receiver?.channel),
      target: text(receiver?.target),
    })).filter(receiver => receiver.name || receiver.target)
    : [];
  return {
    receivers,
    workHours: {
      start: normalizeHour(input?.workHours?.start, DEFAULT_NOTIFICATIONS.workHours.start),
      end: normalizeHour(input?.workHours?.end, DEFAULT_NOTIFICATIONS.workHours.end),
    },
    quietOutsideHours: input?.quietOutsideHours !== false,
    nightMode: {
      enabled: Boolean(input?.nightMode?.enabled),
      autoCategories: 'approved',
    },
    lastTestAt: text(input?.lastTestAt),
  };
}

export function normalizeNotificationChannel(value: unknown): NotificationChannel {
  return value === 'wecom' || value === 'dingtalk' || value === 'feishu' || value === 'sms' ? value : 'wecom';
}

function normalizeHour(value: unknown, fallback: string): string {
  const raw = text(value);
  return /^\d{2}:\d{2}$/.test(raw) ? raw : fallback;
}

export function normalizeAutonomy(value: unknown): AutonomyLevel {
  return value === 'remind' || value === 'auto' || value === 'draft' ? value : 'draft';
}

export function writeProfile(profile: EnterpriseProfile): void {
  const clean = normalizeProfile(profile) as EnterpriseProfile & { integrations?: unknown };
  delete clean.integrations;
  fs.writeFileSync(DATA_FILE, JSON.stringify(clean, null, 2), 'utf8');
}

function storedProfile(value: unknown): EnterpriseProfile | null {
  if (!value) return null;
  if (typeof value === 'string') {
    try { return normalizeProfile(JSON.parse(value)); } catch { return null; }
  }
  return typeof value === 'object' ? normalizeProfile(value as EnterpriseProfile) : null;
}

export async function readTenantProfile(tenantId: string): Promise<EnterpriseProfile> {
  const result = await store.list<Record<string, unknown>>('tenant_profiles', {
    where: { tenant_id: tenantId }, page: 1, perPage: 1,
  });
  const profile = storedProfile(result.items[0]?.profile);
  // GET must not manufacture a new member confirmation from changed bytes.
  // Consumers verify the preserved version (including the proven legacy JSON
  // omission above); an actual business save is the only new confirmation path.
  if (profile?.factVersion) return profile;
  if (profile) return withConfirmedFactVersion(
    profile,
    profile,
    profile.factVersion?.confirmedBy || 'legacy_migration',
    new Date(profile.factVersion?.confirmedAt || profile.dataGovernance?.lastSavedAt || 0),
  );
  const fallback = process.env.DEMO_MODE === 'true' ? readProfile() : normalizeProfile({} as EnterpriseProfile);
  return withConfirmedFactVersion(
    fallback,
    fallback,
    fallback.factVersion?.confirmedBy || 'system',
    new Date(fallback.factVersion?.confirmedAt || fallback.dataGovernance?.lastSavedAt || 0),
  );
}

export async function readTenantEnterpriseProfile(tenantId: string): Promise<EnterpriseProfile> {
  return readTenantProfile(tenantId);
}

/** Assistant grounding must never substitute a global demo profile for missing tenant facts. */
export async function readTenantEnterpriseProfileStrict(tenantId: string): Promise<EnterpriseProfile | null> {
  if (!tenantId.trim()) throw new Error('enterprise_context_tenant_required');
  const result = await store.list<Record<string, unknown>>('tenant_profiles', {
    where: { tenant_id: tenantId }, page: 1, perPage: 1,
  });
  const row = result.items[0];
  if (!row) return null;
  if (row.tenant_id !== tenantId) throw new Error('enterprise_context_tenant_mismatch');
  const profile = storedProfile(row.profile);
  if (!profile) return null;
  if (profile.factVersion) return profile;
  return withConfirmedFactVersion(profile, profile, 'legacy_migration',
    new Date(profile.dataGovernance?.lastSavedAt || 0));
}

export async function updateTenantEnterpriseProfile(
  tenantId: string,
  patch: Partial<EnterpriseProfile>,
  updatedBy = 'system',
): Promise<EnterpriseProfile> {
  const current = await readTenantProfile(tenantId);
  const next = mergeEnterpriseProfile(current, patch);
  await writeTenantProfile(tenantId, next, updatedBy);
  return next;
}

export class EnterpriseFactVersionConflictError extends Error {
  constructor(readonly current: NonNullable<EnterpriseProfile['factVersion']>) {
    super('enterprise_fact_version_conflict');
  }
}

const enterpriseProfileWriteQueues = new Map<string, Promise<void>>();

export function normalizeExpectedFactVersion(value: string | undefined): string {
  return String(value || '').trim().replace(/^W\//, '').replace(/^"|"$/g, '');
}

export async function writeTenantProfile(
  tenantId: string,
  profile: EnterpriseProfile,
  userId: string,
  expectedFactVersion = '',
): Promise<void> {
  const previousWrite = enterpriseProfileWriteQueues.get(tenantId) || Promise.resolve();
  const currentWrite = previousWrite.catch(() => undefined).then(async () => {
    await writeTenantProfileUnlocked(tenantId, profile, userId, expectedFactVersion);
  });
  enterpriseProfileWriteQueues.set(tenantId, currentWrite);
  try { await currentWrite; }
  finally { if (enterpriseProfileWriteQueues.get(tenantId) === currentWrite) enterpriseProfileWriteQueues.delete(tenantId); }
}

async function writeTenantProfileUnlocked(
  tenantId: string,
  profile: EnterpriseProfile,
  userId: string,
  expectedFactVersion = '',
): Promise<void> {
  const result = await store.list<Record<string, unknown>>('tenant_profiles', {
    where: { tenant_id: tenantId }, page: 1, perPage: 1,
  });
  const existing = result.items[0];
  const previous = storedProfile(existing?.profile);
  if (expectedFactVersion) {
    const current = previous?.factVersion ? previous : withConfirmedFactVersion(
      previous || ({} as EnterpriseProfile),
      previous,
      previous?.factVersion?.confirmedBy || 'system',
      new Date(previous?.factVersion?.confirmedAt || previous?.dataGovernance?.lastSavedAt || 0),
    );
    if (expectedFactVersion !== current.factVersion?.contentHash && expectedFactVersion !== current.factVersion?.id) {
      throw new EnterpriseFactVersionConflictError(current.factVersion!);
    }
  }
  // Transient connection details are not persisted enterprise facts. Strip them
  // before hashing, otherwise every later strict consumer sees a stale hash.
  // Hash the same JSON shape storage will retain. In particular undefined
  // optional business fields must not be hashed as null and then disappear.
  const persisted = JSON.parse(JSON.stringify(normalizeProfile(profile))) as EnterpriseProfile & { integrations?: unknown };
  delete persisted.integrations;
  const clean = withConfirmedFactVersion(persisted, previous, userId);
  profile.factVersion = clean.factVersion;
  const ok = existing?.id
    ? await store.update('tenant_profiles', String(existing.id), { profile: clean, updated_by: userId })
    : Boolean(await store.create('tenant_profiles', { tenant_id: tenantId, profile: clean, updated_by: userId }));
  if (!ok) throw new Error('tenant_profile_storage_unavailable');
}

export function readEnterpriseProfile(): EnterpriseProfile {
  return readProfile();
}

export function text(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

