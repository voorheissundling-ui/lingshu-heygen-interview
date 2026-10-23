import type {
  SocialAccountPresenterLock, SocialAssetAvailability, SocialAssetSupplyRoute,
  SocialContentCreationMode, SocialProductionApproach, SocialShotSourceStrategy,
} from './contracts/socialContentWorkflow';
import type { SocialAssetInventory, SocialAssetSupplyShotRequest } from './socialContentAssetSupplyContracts';

export const EMPTY_INVENTORY: Required<SocialAssetInventory> = {
  customerVideoIds: [], productImageIds: [], productIdentityGroups: [], presenterAssetIds: [],
  referenceVideoIds: [], factoryEvidenceAssetIds: [], customerCaseEvidenceAssetIds: [],
  productEffectEvidenceAssetIds: [], licensedStockAssetIds: [],
};

export const DEFAULT_SHOTS: Record<SocialContentCreationMode, SocialAssetSupplyShotRequest[]> = {
  material_processing: [
    { shotId: 'shot-hook', function: 'hook', requestedDescription: '前三秒呈现清楚主体和核心利益点' },
    { shotId: 'shot-value', function: 'value', requestedDescription: '解释产品或服务能解决什么问题' },
    { shotId: 'shot-demonstration', function: 'demonstration', requestedDescription: '用可验证信息说明使用方式或工作原理' },
    { shotId: 'shot-cta', function: 'call_to_action', requestedDescription: '给出与真实业务一致的下一步行动' },
  ],
  viral_replication: [
    { shotId: 'shot-hook', function: 'hook', requestedDescription: '复用参考视频的前三秒吸引机制，不复用原素材和原文案' },
    { shotId: 'shot-problem', function: 'problem', requestedDescription: '保持参考视频的信息推进功能，换成客户自己的表达' },
    { shotId: 'shot-demonstration', function: 'demonstration', requestedDescription: '保持镜头节奏，用可生产且真实的画面完成说明' },
    { shotId: 'shot-cta', function: 'call_to_action', requestedDescription: '按照客户真实业务重写行动引导' },
  ],
};

export function unique(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map(value => value.trim()).filter(Boolean))];
}

export function normalizeInventory(input?: SocialAssetInventory): Required<SocialAssetInventory> {
  const productIdentityGroups = (input?.productIdentityGroups ?? []).flatMap(group => {
    const productRef = group.productRef?.trim();
    const imageIds = unique(group.imageIds);
    return productRef && imageIds.length ? [{ productRef, imageIds }] : [];
  });
  return {
    customerVideoIds: unique(input?.customerVideoIds),
    productImageIds: unique([...(input?.productImageIds ?? []), ...productIdentityGroups.flatMap(group => group.imageIds)]),
    productIdentityGroups,
    presenterAssetIds: unique(input?.presenterAssetIds),
    referenceVideoIds: unique(input?.referenceVideoIds),
    factoryEvidenceAssetIds: unique(input?.factoryEvidenceAssetIds),
    customerCaseEvidenceAssetIds: unique(input?.customerCaseEvidenceAssetIds),
    productEffectEvidenceAssetIds: unique(input?.productEffectEvidenceAssetIds),
    licensedStockAssetIds: unique(input?.licensedStockAssetIds),
  };
}

export function inferSocialAssetAvailability(input?: SocialAssetInventory): SocialAssetAvailability {
  const inventory = normalizeInventory(input);
  const customerMotionCount = inventory.customerVideoIds.length + inventory.presenterAssetIds.length
    + inventory.factoryEvidenceAssetIds.length + inventory.customerCaseEvidenceAssetIds.length
    + inventory.productEffectEvidenceAssetIds.length;
  if (customerMotionCount > 0) return 'ready';
  if (inventory.productImageIds.length > 0 || inventory.licensedStockAssetIds.length > 0) return 'limited';
  return 'none';
}

export function productionRoute(availability: SocialAssetAvailability, inventory: Required<SocialAssetInventory>): SocialAssetSupplyRoute {
  if (availability === 'ready') return 'real_asset_enhancement';
  if (inventory.productImageIds.length > 0) return 'product_anchored_generation';
  return 'zero_asset_generation';
}

export function presenterLockReady(lock: SocialAccountPresenterLock | null | undefined): lock is SocialAccountPresenterLock {
  return Boolean(lock && lock.status === 'published' && lock.commercialRightsStatus === 'cleared'
    && lock.socialAccountId.trim() && lock.presenterProfileId.trim() && lock.presenterProfileVersion.trim()
    && lock.presenterAssetId.trim() && lock.avatarId.trim() && lock.voiceProfileId.trim()
    && lock.consentRef.trim() && lock.consistencyKey.trim());
}

export function fallbackFor(strategy: SocialShotSourceStrategy, productionApproach: SocialProductionApproach = 'ai_enhanced'): SocialShotSourceStrategy | null {
  if (productionApproach === 'material_cut' || productionApproach === 'shooting_plan') return null;
  if (productionApproach === 'material_polish') return strategy === 'verified_fact_card' ? 'motion_graphics' : null;
  if (strategy === 'motion_graphics') return 'authorized_digital_presenter';
  if (strategy === 'authorized_digital_presenter' || strategy === 'aigc_product_scene_replication') return null;
  if (strategy === 'licensed_stock_asset') return 'non_evidentiary_ai_visual';
  if (strategy === 'non_evidentiary_ai_visual' || strategy === 'verified_fact_card') return 'motion_graphics';
  return 'motion_graphics';
}

export function digitalHumanMethod(creationMode: SocialContentCreationMode, description: string | null | undefined): 'talking' | 'replace' | 'reenact' {
  if (creationMode !== 'viral_replication') return 'talking';
  const text = String(description || '');
  if (/动态真人口播|真人时序分段：动态|重新演绎|reenact|re-?perform/i.test(text)) return 'reenact';
  if (/换脸|替换(?:原)?人物|人物复刻|复刻参考片|face\s*swap|person\s*replacement/i.test(text)) return 'replace';
  return 'talking';
}
