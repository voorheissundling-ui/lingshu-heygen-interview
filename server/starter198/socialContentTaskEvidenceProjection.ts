import type { EnterpriseProfile } from '../lib/socialContentLegacyPorts.js';
import { verifyEnterpriseFactContent } from '../lib/socialContentLegacyPorts.js';
import { enterpriseProductIdentity } from '../lib/enterpriseProductIdentity.js';
import type {
  SocialAssetSupplyPlan,
  SocialMaterialRequirement,
  SocialShotMaterialMapEntry,
  SocialContentThemeId,
} from '../../shared/contracts/socialContentWorkflow.js';

export interface SocialEnterpriseProductBinding {
  productId: string;
  productName: string;
  productSku: string | null;
  enterpriseFactRef: string;
  enterpriseFactId: string;
  enterpriseFactRevision: number;
  enterpriseFactContentHash: string;
  confirmedAt: string;
}

/**
 * Bind production only to an exact product row inside the currently confirmed
 * Enterprise Center fact revision. A matching display name is deliberately not
 * accepted here: names are review snapshots, not durable production identity.
 */
export function resolveSocialEnterpriseProductBinding(
  profile: EnterpriseProfile | null | undefined,
  selectedProductId: string | null | undefined,
): SocialEnterpriseProductBinding | null {
  const productId = String(selectedProductId ?? '').trim();
  const version = profile?.factVersion;
  if (!profile || !productId || !version?.id || !Number.isSafeInteger(version.revision) || version.revision < 1
    || !version.contentHash || !Number.isFinite(Date.parse(version.confirmedAt))
    || !verifyEnterpriseFactContent(profile).verified) return null;
  const matches = (profile.products.items ?? []).map((item, index) => ({
    item,
    canonicalId: enterpriseProductIdentity(item, index),
  })).filter(candidate => candidate.canonicalId === productId);
  if (matches.length !== 1 || !String(matches[0]!.item.name ?? '').trim()) return null;
  const selected = matches[0]!;
  return {
    productId: selected.canonicalId,
    productName: String(selected.item.name).trim(),
    productSku: String(selected.item.sku ?? '').trim() || null,
    enterpriseFactRef: `enterprise_fact:${version.id}@${version.revision}`,
    enterpriseFactId: version.id,
    enterpriseFactRevision: version.revision,
    enterpriseFactContentHash: version.contentHash,
    confirmedAt: version.confirmedAt,
  };
}

function requirementReason(shot: SocialAssetSupplyPlan['shots'][number]): string {
  if (shot.truthBoundary.customerEvidenceRequired) return '缺少该镜头要求的客户真实证据素材；生成内容不能替代客户事实证据';
  if (shot.sourceStrategy === 'aigc_product_scene_replication') return '缺少可直接消费的镜头成片；需使用已授权产品身份图完成受控生成并通过身份质检';
  if (shot.sourceStrategy === 'authorized_digital_presenter') return '缺少已渲染的人物镜头；需先确认人物授权与账号身份锁，再生成可消费素材';
  if (shot.sourceStrategy === 'licensed_stock_asset') return '缺少已选定并核验商业使用权的库存镜头';
  if (shot.sourceStrategy === 'customer_real_asset') return '缺少与分镜语义、产品身份和权利范围一致的客户原始素材';
  if (shot.sourceStrategy === 'verified_fact_card') return '缺少基于已确认企业事实生成的图文镜头';
  if (shot.sourceStrategy === 'motion_graphics') return '缺少承载该分镜信息的动态图文镜头';
  return '缺少可供该分镜直接消费的已授权视觉素材';
}

/**
 * Project the actual shot plan into actionable requirements. This projection
 * is independent from the old theme/formula checklist and therefore cannot
 * interpret an empty compatibility column as seven satisfied shots.
 */
export function projectShotMaterialRequirements(input: {
  plan: SocialAssetSupplyPlan;
  shotMaterialMap: SocialShotMaterialMapEntry[];
  themeId: SocialContentThemeId | null | undefined;
  aspectRatio?: string | null;
  recalculatedAt: string;
}): SocialMaterialRequirement[] {
  const mapped = new Map(input.shotMaterialMap.map(entry => [entry.shotId, entry]));
  const plannedSystemSupply = input.plan.status === 'ready'
    && input.plan.canProduceWithoutCustomerShoot
    && input.plan.productionApproach !== 'shooting_plan'
    && input.plan.customerActions.length === 0;
  return input.plan.shots.map(shot => {
    const entry = mapped.get(shot.shotId);
    const consumed = entry
      ? [...entry.customerAssetIds, ...entry.generatedAssetIds, ...entry.licensedAssetIds]
      : [];
    const duration = shot.productSceneReplication?.cameraLock.durationSeconds
      ?? shot.materialRouting?.generation?.durationSeconds
      ?? null;
    const visual = shot.visualContract;
    const subject = visual?.subjects.map(item => item.description).filter(Boolean).join('、')
      || shot.truthBoundary.subject.replaceAll('_', ' ')
      || '镜头主体';
    const action = visual?.interaction.description || visual?.action.path
      || shot.requestedDescription || shot.productionInstruction;
    const environment = visual?.environment.description || visual?.environment.kind || null;
    const satisfied = consumed.length > 0;
    // A server-approved executable generation route is work for the existing
    // producer, not a request for the customer to upload the producer's future
    // output. Provider admission, budget, rights and product-identity gates
    // still run later. Customer evidence and shooting routes remain required.
    const generatedByPlannedExecutor = plannedSystemSupply
      && shot.customerShootRequired === false
      && shot.truthBoundary.syntheticVisualAllowed
      && !shot.truthBoundary.customerEvidenceRequired
      && ['aigc_product_scene_replication', 'non_evidentiary_ai_visual', 'motion_graphics', 'verified_fact_card'].includes(shot.sourceStrategy);
    return {
      requirementId: `shot-material:${shot.shotId}`,
      required: !generatedByPlannedExecutor,
      targetTheme: input.themeId ?? 'product_value',
      shotFunction: shot.function,
      subject,
      action,
      environment,
      orientation: input.aspectRatio?.startsWith('16:9') ? 'landscape'
        : input.aspectRatio?.startsWith('9:16') ? 'portrait' : 'either',
      durationSeconds: duration && duration > 0 ? { minimum: duration, maximum: duration } : null,
      status: satisfied ? 'satisfied' : 'missing',
      matchedSourceIds: consumed,
      confidence: satisfied ? 1 : null,
      reason: satisfied ? '已有经分镜素材映射确认的可消费素材'
        : generatedByPlannedExecutor ? '已由服务端冻结的执行器生成路线承担，非用户补交素材' : requirementReason(shot),
      recalculatedAt: input.recalculatedAt,
      ruleVersion: 'shot-material-projection-v1',
    };
  });
}
