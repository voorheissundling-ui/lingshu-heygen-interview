import type { FixedYieldArchetypeId } from '../fixedYieldMaterialRegistry.js';

export const PRODUCTION_CONTACT_KINDS = [
  'whatsapp', 'email', 'phone', 'website', 'wechat', 'none',
] as const;
export type ProductionContactKind = typeof PRODUCTION_CONTACT_KINDS[number];

export const PRODUCTION_PRESENTER_POLICIES = [
  'digital_presenter', 'local_video_only',
] as const;
export type ProductionPresenterPolicy = typeof PRODUCTION_PRESENTER_POLICIES[number];

/** User choices collected before planning. Readiness facts are deliberately not
 * stored here: presenter authorization, inventory and provider availability
 * must always be read from their authoritative server-side stores. */
export interface ProductionOnboardingPreferences {
  schemaVersion: 'fixed-yield.production-onboarding.v1';
  contact: {
    kind: ProductionContactKind;
    value: string;
    primaryCta: string;
  };
  presenterPolicy: ProductionPresenterPolicy;
  output: {
    primaryLanguage: string;
    aspectRatio: '9:16' | '16:9' | '1:1';
    resolution: '720p' | '1080p';
  };
  includeOneRevision: boolean;
  confirmedAt: string;
}

export interface ProductionOnboardingEvidence {
  companyReady: boolean;
  brandReady: boolean;
  productFactsReady: boolean;
  presenterReady: boolean;
  voiceReady: boolean;
  /** Archetypes with at least one tenant-owned, authorized, analyzed segment. */
  inventoryArchetypes: FixedYieldArchetypeId[];
  budgetConfirmed: boolean;
}

export type ProductionOnboardingBlockerCode =
  | 'production_preferences_missing'
  | 'company_profile_missing'
  | 'brand_profile_missing'
  | 'product_facts_missing'
  | 'public_contact_missing'
  | 'primary_cta_missing'
  | 'presenter_missing'
  | 'voice_missing'
  | 'local_material_missing'
  | 'budget_unconfirmed';

export interface ProductionOnboardingReadiness {
  ready: boolean;
  blockers: Array<{
    code: ProductionOnboardingBlockerCode;
    archetypeId?: FixedYieldArchetypeId;
    message: string;
    action: 'complete_production_onboarding' | 'complete_enterprise_profile' | 'complete_product_profile' | 'configure_contact'
      | 'configure_presenter' | 'configure_voice' | 'upload_local_material'
      | 'confirm_budget';
  }>;
}

const clean = (value: unknown, max: number): string => String(value ?? '').normalize('NFKC').trim().slice(0, max);

export function normalizeProductionOnboardingPreferences(value: unknown): ProductionOnboardingPreferences | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Partial<ProductionOnboardingPreferences>;
  const contact = source.contact && typeof source.contact === 'object' ? source.contact : undefined;
  const output = source.output && typeof source.output === 'object' ? source.output : undefined;
  const contactKind = PRODUCTION_CONTACT_KINDS.includes(contact?.kind as ProductionContactKind)
    ? contact!.kind as ProductionContactKind : 'none';
  const presenterPolicy = PRODUCTION_PRESENTER_POLICIES.includes(source.presenterPolicy as ProductionPresenterPolicy)
    ? source.presenterPolicy as ProductionPresenterPolicy : 'local_video_only';
  const primaryLanguage = clean(output?.primaryLanguage, 20) || 'en';
  const aspectRatio = ['9:16', '16:9', '1:1'].includes(String(output?.aspectRatio))
    ? output!.aspectRatio as ProductionOnboardingPreferences['output']['aspectRatio'] : '9:16';
  const resolution = output?.resolution === '720p' ? '720p' : '1080p';
  return {
    schemaVersion: 'fixed-yield.production-onboarding.v1',
    contact: {
      kind: contactKind,
      value: contactKind === 'none' ? '' : clean(contact?.value, 300),
      primaryCta: contactKind === 'none' ? '' : clean(contact?.primaryCta, 240),
    },
    presenterPolicy,
    output: { primaryLanguage, aspectRatio, resolution },
    includeOneRevision: source.includeOneRevision !== false,
    confirmedAt: clean(source.confirmedAt, 80),
  };
}

/** Single zero-cost gate shared by onboarding, reference selection and the
 * production-start preflight. It never trusts a browser-supplied readiness
 * boolean and never changes a requested archetype into a cheaper route. */
export function evaluateProductionOnboardingReadiness(input: {
  preferences: ProductionOnboardingPreferences;
  evidence: ProductionOnboardingEvidence;
  requiredArchetypes: FixedYieldArchetypeId[];
}): ProductionOnboardingReadiness {
  const blockers: ProductionOnboardingReadiness['blockers'] = [];
  const add = (blocker: ProductionOnboardingReadiness['blockers'][number]) => {
    if (!blockers.some(item => item.code === blocker.code && item.archetypeId === blocker.archetypeId)) blockers.push(blocker);
  };
  if (!input.evidence.companyReady) add({ code: 'company_profile_missing', message: '企业资料尚未完成', action: 'complete_enterprise_profile' });
  if (!input.evidence.brandReady) add({ code: 'brand_profile_missing', message: '品牌资料尚未完成', action: 'complete_enterprise_profile' });
  if (!input.evidence.productFactsReady) add({ code: 'product_facts_missing', message: '主推产品事实尚未完成', action: 'complete_product_profile' });
  if (input.preferences.contact.kind !== 'none') {
    if (!input.preferences.contact.value) add({ code: 'public_contact_missing', message: '已选择联系方式，但尚未填写可公开的联系信息', action: 'configure_contact' });
    if (!input.preferences.contact.primaryCta) add({ code: 'primary_cta_missing', message: '已选择联系方式，但尚未确认视频行动号召', action: 'configure_contact' });
  }
  const requiresPresenter = input.requiredArchetypes.some(item => item.startsWith('P1'));
  if (requiresPresenter) {
    if (input.preferences.presenterPolicy !== 'digital_presenter' || !input.evidence.presenterReady) {
      add({ code: 'presenter_missing', message: '参考时间线包含真人口播，但默认数字人物尚未授权可用', action: 'configure_presenter' });
    } else if (!input.evidence.voiceReady) {
      add({ code: 'voice_missing', message: '默认数字人物尚未绑定可用声音', action: 'configure_voice' });
    }
  }
  const available = new Set(input.evidence.inventoryArchetypes);
  for (const archetypeId of new Set(input.requiredArchetypes.filter(item => !item.startsWith('P1')))) {
    if (!available.has(archetypeId)) add({
      code: 'local_material_missing', archetypeId,
      message: `${archetypeId} 缺少企业自有且已授权的同类视频片段`, action: 'upload_local_material',
    });
  }
  if (!input.evidence.budgetConfirmed) add({ code: 'budget_unconfirmed', message: '开工预算尚未确认', action: 'confirm_budget' });
  return { ready: blockers.length === 0, blockers };
}
