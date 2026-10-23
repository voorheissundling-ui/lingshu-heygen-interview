import type { BenchmarkAnalysis } from '../../shared/benchmarkAnalysis.js';
import type { AssetCandidate } from './contentProductionContracts.js';

export interface ProductMaterialReference {
  id: string;
  name: string;
  sku?: string;
}

export interface MaterialProductAssociation {
  productId: string;
  productName: string;
  source: 'product_id' | 'product_name' | 'product_ref' | 'material_metadata';
}

type MaterialRecordLike = Record<string, unknown>;

function text(value: unknown): string {
  return String(value || '').trim();
}

function normalized(value: unknown): string {
  return text(value).toLocaleLowerCase().replace(/[\s\p{P}\p{S}_]+/gu, '');
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(text).filter(Boolean);
  return text(value).split(/[,，、;；|\n]+/).map(item => item.trim()).filter(Boolean);
}

/**
 * Resolve a durable product boundary for legacy material rows without guessing
 * between similarly named products. Explicit IDs always win. Name/tag fallback
 * is accepted only when it identifies exactly one current enterprise product.
 */
export function resolveMaterialProductAssociation(
  record: MaterialRecordLike,
  products: ProductMaterialReference[],
): MaterialProductAssociation | null {
  const byId = new Map(products.map(product => [product.id, product]));
  const explicitId = text(record.productId);
  if (explicitId) {
    const product = byId.get(explicitId);
    return product ? { productId: product.id, productName: product.name, source: 'product_id' } : null;
  }
  // System-provided cloud material remains reusable cloud material. It must
  // never become a tenant product asset merely because a tag/name happens to
  // overlap with a product. Only owned uploads receive legacy inference.
  if (text(record.scope) === 'shared') return null;

  const exactValues = [record.productName, record.productRef]
    .map(normalized)
    .filter(Boolean);
  const exactMatches = products.filter(product => {
    const keys = [normalized(product.name), normalized(product.sku)].filter(Boolean);
    return exactValues.some(value => keys.includes(value));
  });
  if (exactMatches.length === 1) {
    const product = exactMatches[0]!;
    return {
      productId: product.id,
      productName: product.name,
      source: normalized(record.productName) ? 'product_name' : 'product_ref',
    };
  }

  const metadataValues = [record.name, record.sourceName, ...stringList(record.tags)]
    .map(normalized)
    .filter(Boolean);
  const metadataMatches = products.filter(product => {
    const keys = [normalized(product.name), normalized(product.sku)].filter(key => key.length >= 3);
    return keys.some(key => metadataValues.some(value => value === key || value.includes(key)));
  });
  if (metadataMatches.length !== 1) return null;
  const product = metadataMatches[0]!;
  return { productId: product.id, productName: product.name, source: 'material_metadata' };
}

export type StoryboardMaterialRequirement = 'optional' | 'unresolved' | 'static_product' | 'dynamic_product' | 'factory_evidence';

export type StoryboardMaterialResolution = 'matched_asset' | 'system_fallback' | 'needs_input' | 'optional';

export interface StoryboardMaterialDecision {
  structureIndex: number;
  requirement: StoryboardMaterialRequirement;
  required: boolean;
  resolution: StoryboardMaterialResolution;
  productionRoute: string;
  productionNote: string;
  assetId: string;
  blocker: string;
}

const DYNAMIC_PRODUCT = /(?:使用|试用|涂抹|擦拭|揉搓|起泡|清洁|冲洗|挤出|按压|喷洒|倒入|滴入|吸收|开箱|拆封|旋转|摇晃|操作|前后对比|质地变化|apply|use|demo|before.?after|rub|foam|cleanse|rinse|pour|spray|press|unbox)/i;
const FACTORY_EVIDENCE = /(?:工厂|车间|产线|生产线|流水线|灌装|包装工序|质检|设备|机器|加工|装配|产能|factory|production|assembly|filling|packing|quality.?control|machine)/i;

function assetText(asset: Pick<AssetCandidate, 'name' | 'productName' | 'tags' | 'visualObservations'>): string {
  return [asset.name, asset.productName, ...asset.tags, ...asset.visualObservations].filter(Boolean).join(' ');
}

function stepText(analysis: BenchmarkAnalysis | undefined, shotIds: string[]): string {
  if (!analysis) return '';
  return shotIds.flatMap(shotId => {
    const shot = analysis.shots.find(item => item.shotId === shotId);
    return shot ? [shot.visual, shot.purpose, shot.camera, shot.environment, shot.authenticity, ...Object.values(shot.detailedAnalysis)] : [];
  }).filter(Boolean).join(' ');
}

function requirementForStep(
  analysis: BenchmarkAnalysis,
  step: BenchmarkAnalysis['structure'][number],
): StoryboardMaterialRequirement {
  const description = stepText(analysis, step.shotIds);
  if (step.materialType === 'unknown') return 'unresolved';
  if (step.materialType === 'factory' || step.narrativeRole === 'capability_proof') return 'factory_evidence';
  if (step.materialType === 'consumer_demo' || step.narrativeRole === 'effect_proof') return 'dynamic_product';
  if (step.materialType === 'product') return DYNAMIC_PRODUCT.test(description) ? 'dynamic_product' : 'static_product';
  return 'optional';
}

function candidateForRequirement(requirement: StoryboardMaterialRequirement, assets: AssetCandidate[]): AssetCandidate | undefined {
  if (requirement === 'unresolved') return undefined;
  if (requirement === 'factory_evidence') {
    return assets.find(asset => asset.type === 'video'
      && asset.authorization.scope === 'tenant'
      && asset.authorization.status === 'owned'
      && asset.source !== 'licensed_shared_material'
      && FACTORY_EVIDENCE.test(assetText(asset)));
  }
  // A generic enterprise/common clip can satisfy an environment or action
  // need, but it cannot prove the identity of the product requested by this
  // master. Product decisions therefore only consume assets with a durable
  // product association; legacy owned uploads are associated upstream when
  // their metadata identifies exactly one enterprise product.
  const productAssets = assets.filter(asset => Boolean(asset.productId));
  if (requirement === 'dynamic_product') return productAssets.find(asset => asset.type === 'video');
  if (requirement === 'static_product') return productAssets.find(asset => asset.type === 'image') || productAssets.find(asset => asset.type === 'video');
  return assets.find(asset => asset.type === 'video') || assets.find(asset => asset.type === 'image');
}

function missingMessage(requirement: StoryboardMaterialRequirement, index: number): string {
  if (requirement === 'unresolved') return `第 ${index + 1} 段镜头素材类型待判断，需完成证据复核`;
  if (requirement === 'dynamic_product') return `第 ${index + 1} 段缺少可锁定主体身份的图片或视频；提供一张清晰正面图即可启用系统合成路线`;
  if (requirement === 'static_product') return `第 ${index + 1} 段缺少可锁定主体身份的图片或视频`;
  return '';
}

function fallbackIdentityAsset(assets: AssetCandidate[]): AssetCandidate | undefined {
  const productAssets = assets.filter(asset => Boolean(asset.productId));
  return productAssets.find(asset => asset.type === 'image') || productAssets.find(asset => asset.type === 'video');
}

function resolutionForRequirement(
  requirement: StoryboardMaterialRequirement,
  candidate: AssetCandidate | undefined,
  assets: AssetCandidate[],
): Pick<StoryboardMaterialDecision, 'resolution' | 'productionRoute' | 'productionNote' | 'assetId' | 'blocker'> {
  if (requirement === 'optional') {
    return {
      resolution: 'optional', productionRoute: candidate ? 'reuse_optional_asset' : 'system_select_optional_visual',
      productionNote: candidate ? '复用已选素材' : '由系统从通用素材、动效或数字人能力中选路',
      assetId: candidate?.id || '', blocker: '',
    };
  }
  if (requirement === 'unresolved') {
    return {
      resolution: 'needs_input', productionRoute: 'review_scene_requirement', productionNote: '先确认镜头承担的内容功能，再选择生产能力',
      assetId: '', blocker: missingMessage(requirement, 0),
    };
  }
  if (candidate) {
    return {
      resolution: 'matched_asset', productionRoute: `reuse_${requirement}_asset`, productionNote: '已命中可复用的已授权素材',
      assetId: candidate.id, blocker: '',
    };
  }
  if (requirement === 'factory_evidence') {
    return {
      resolution: 'needs_input', productionRoute: 'confirm_factory_rewrite_or_bind_authorized_asset',
      productionNote: '当前执行链尚不能自动消费“工厂底板 + 事实改写”计划；请确认改为非证据性流程说明，或绑定已授权工厂素材',
      assetId: '', blocker: '缺少可由当前执行链直接消费的工厂素材；请确认改为事实卡片/流程说明，或绑定已授权工厂素材（不会默认创建实拍任务）',
    };
  }
  if (requirement === 'dynamic_product') {
    const identityAsset = fallbackIdentityAsset(assets);
    if (identityAsset) {
      return {
        resolution: 'needs_input', productionRoute: 'confirm_identity_motion_route_or_bind_dynamic_asset',
        productionNote: '真实主体图已具备，但当前内容执行链尚不能自动消费“身份图 + 系统动作”计划；请确认改为静态展示，或绑定已授权动态素材',
        assetId: identityAsset.id,
        blocker: '真实主体图已具备，但系统动作合成尚未接入本执行链；请确认改为静态展示，或绑定已授权动态素材（不会默认创建实拍任务）',
      };
    }
  }
  return {
    resolution: 'needs_input', productionRoute: 'request_minimum_identity_asset', productionNote: '只请求系统无法自行推断的最小身份素材，不创建默认实拍任务',
    assetId: '', blocker: '',
  };
}

/**
 * Evaluate only the material-dependent shots in one master. Missing evidence
 * blocks this master family, not the rest of the weekly plan. Pure-avatar
 * masters remain executable because every scene is rendered by the presenter.
 */
export function assessStoryboardMaterialReadiness(input: {
  analysis?: BenchmarkAnalysis;
  assets: AssetCandidate[];
  presenter: 'material' | 'heygen' | 'avatar';
}): { decisions: StoryboardMaterialDecision[]; blockers: string[] } {
  const structure = input.analysis?.structure || [];
  const decisions = structure.map((step, structureIndex): StoryboardMaterialDecision => {
    const requirement = step.materialType === 'unknown'
      ? 'unresolved'
      : input.presenter === 'avatar' ? 'optional' : requirementForStep(input.analysis!, step);
    const candidate = candidateForRequirement(requirement, input.assets);
    const required = requirement !== 'optional';
    const resolution = resolutionForRequirement(requirement, candidate, input.assets);
    const blocker = resolution.resolution === 'needs_input'
      ? resolution.blocker || missingMessage(requirement, structureIndex)
      : '';
    return {
      structureIndex,
      requirement,
      required,
      ...resolution,
      blocker,
    };
  });
  if (!structure.length && input.presenter !== 'avatar' && !input.assets.length) {
    return { decisions, blockers: ['本条独立视频缺少该产品的可用图片或视频'] };
  }
  return { decisions, blockers: [...new Set(decisions.map(item => item.blocker).filter(Boolean))] };
}
