import { normalizeVideoPlan, type VideoCreationPlan } from './videoCreationPlan';
import { VIDEO_LANGUAGES, normalizeVideoLanguage } from './videoLanguages';
import type { WeeklyPackage } from './weeklyPackage';
import {
  SOCIAL_PLATFORM_EXECUTION_RULES,
  socialOperatingProfile,
  type SocialAccountRole,
} from '../../shared/contracts/socialOperatingProfile';
import type { DigitalEmployeeConfig } from './digitalEmployees';
import { hydrateWeeklyPublishingTargets } from '../../shared/contracts/weeklyPublishingTargets';
import { MASTER_VIDEO_COST_MAX_CNY, MASTER_VIDEO_COST_MIN_CNY, MASTER_VIDEO_COST_POINT_CNY } from '../../shared/contracts/contentCostModel';

export interface MatrixAccountPlan {
  accountId: string;
  /** Planned accounts can exist before a publishing connection is authorized. */
  connected?: boolean;
  accountRole?: SocialAccountRole;
  formats?: string[];
  platform: VideoCreationPlan['platform'];
  audience: string;
  productName: string;
  language: string;
  objective: string;
  contentDirection: string;
  cta: string;
  weeklyCount: number;
  sourceProjectIds: string[];
}
export interface MatrixAccountReview {
  accountId: string;
  platform: string;
  planned: number;
  produced: number;
  published: number;
  views: number | null;
  interactions: number | null;
  inquiries: number | null;
  recommendation: string;
}

/**
 * Build the same deterministic account matrix everywhere the weekly plan is
 * shown. It uses the operating profile selected during setup and only includes
 * connected accounts first, then fills the remaining configured account roles
 * with stable planning-only accounts. Planning is therefore complete before
 * publishing authorization is granted.
 */
export function defaultMatrixPlan(
  config: Pick<DigitalEmployeeConfig, 'socialOperatingProfile' | 'publishingTargets' | 'customerProfile' | 'focusProducts' | 'videoDefaults'> & Partial<Pick<DigitalEmployeeConfig, 'socialCadence'>>,
  platforms: VideoCreationPlan['platform'][],
  objective: string,
): MatrixAccountPlan[] {
  const profile = socialOperatingProfile(config.socialOperatingProfile);
  const publishingTargets = hydrateWeeklyPublishingTargets(config.publishingTargets, config.socialCadence);
  const usedByPlatform = new Map<VideoCreationPlan['platform'], number>();
  const productName = config.focusProducts.split(/[、，,；;\n]/).map(item => item.trim()).filter(Boolean)[0] || '';
  const rows: MatrixAccountPlan[] = [];
  for (const platform of platforms) {
    const candidates = profile.accounts.filter(item => item.platform === platform);
    const targets = publishingTargets.filter(target => target.platform === platform);
    const hasStructuredQuota = targets.some(target => target.weeklyCount !== undefined);
    const count = hasStructuredQuota ? targets.length : Math.max(candidates.length, targets.length);
    for (let index = 0; index < count; index += 1) {
      const target = targets[index];
      const strategy = candidates[index % Math.max(1, candidates.length)];
      const weeklyCount = hasStructuredQuota
        ? Math.max(0, Math.floor(Number(target?.weeklyCount) || 0))
        : Math.max(1, strategy?.weeklyVideoCount || 1);
      if (weeklyCount === 0) continue;
      const used = usedByPlatform.get(platform) || 0;
      usedByPlatform.set(platform, used + 1);
      rows.push({
        accountId: target?.accountId || `planned:${platform}:${strategy?.accountRole || 'brand_combined'}:${used + 1}`,
        connected: Boolean(target),
        platform,
        accountRole: strategy?.accountRole || 'brand_combined',
        formats: [...(strategy?.formats || [])],
        audience: config.customerProfile || '本期目标买家',
        productName,
        language: normalizeVideoLanguage(config.videoDefaults?.language || 'en'),
        objective: objective || strategy?.purpose || '验证本周内容方向并获得有效询盘',
        contentDirection: strategy?.purpose || '围绕买家问题展示产品证据与采购价值',
        cta: SOCIAL_PLATFORM_EXECUTION_RULES[platform].ctaRule,
        weeklyCount,
        sourceProjectIds: [],
      });
    }
  }
  return rows;
}
const clean = (v: unknown, limit = 500) => String(v ?? '').trim().slice(0, limit);
export function normalizeMatrixPlan(value: unknown): MatrixAccountPlan[] {
  if (!Array.isArray(value) || value.length > 30) throw Error('矩阵安排最多支持 30 个账号');
  return value.map(raw => {
    if (!raw || typeof raw !== 'object') throw Error('矩阵账号安排格式无效');
    return { accountId: clean(raw.accountId, 160), ...(raw.connected === false ? { connected: false } : raw.connected === true ? { connected: true } : {}), platform: clean(raw.platform) as MatrixAccountPlan['platform'],
      accountRole: ['brand_capability', 'buyer_advisor', 'brand_combined'].includes(clean(raw.accountRole)) ? clean(raw.accountRole) as SocialAccountRole : 'brand_combined',
      formats: Array.isArray(raw.formats) ? [...new Set<string>(raw.formats.map((item: unknown) => clean(item, 80)).filter(Boolean))].slice(0, 8) : [],
      audience: clean(raw.audience), productName: clean(raw.productName, 180), language: normalizeVideoLanguage(raw.language),
      objective: clean(raw.objective), contentDirection: clean(raw.contentDirection), cta: clean(raw.cta),
      weeklyCount: Number(raw.weeklyCount), sourceProjectIds: Array.isArray(raw.sourceProjectIds) ? [...new Set<string>(raw.sourceProjectIds.map((id: unknown) => clean(id, 160)).filter(Boolean))].slice(0, 30) : [] };
  });
}
export function bindMatrixVideo(plan: VideoCreationPlan, row?: MatrixAccountPlan): VideoCreationPlan {
  // The account product is a default, not a constraint on explicitly selected products.
  const legacyProductChanged = row !== undefined && !plan.productId?.trim() && plan.productName !== row.productName;
  return normalizeVideoPlan({ ...plan, ...(row ? { platform: row.platform, language: row.language,
    ...(!plan.productId?.trim() ? { productName: row.productName } : {}),
    ...(legacyProductChanged ? { materialIds: [], scenePlan: plan.scenePlan?.map(scene => ({ ...scene, materialId: '' })) } : {}) } : {}),
    matrix: row ? { accountId: row.accountId, audience: row.audience, objective: row.objective, cta: row.cta, accountRole: row.accountRole || 'brand_combined', formats: row.formats || [] } : { accountId: '', audience: '', objective: '', cta: '', accountRole: 'brand_combined', formats: [] } });
}

/** Internal lineage compatibility for historic adapted plans. New weekly plans
 * pass one production target per video slot, which makes every slot independent.
 */
export function linkMatrixVersionsToMasters(plans: VideoCreationPlan[], originalTarget: number): VideoCreationPlan[] {
  const target = Math.max(1, Math.min(plans.length || 1, Math.floor(originalTarget) || plans.length || 1));
  const staged = plans.map((source, index) => {
    const plan = normalizeVideoPlan(source);
    const contentId = plan.contentId || crypto.randomUUID();
    return normalizeVideoPlan({
      ...plan,
      contentId,
      contentFamilyId: `weekly-video-${(index % target) + 1}`,
    });
  });
  const masterByFamily = new Map<string, string>();
  for (const plan of staged) {
    if (!masterByFamily.has(plan.contentFamilyId || '')) masterByFamily.set(plan.contentFamilyId || '', plan.contentId || '');
  }
  return staged.map(plan => {
    const masterContentId = masterByFamily.get(plan.contentFamilyId || '') || plan.contentId || '';
    const master = plan.contentId === masterContentId;
    return normalizeVideoPlan({
      ...plan,
      productionRole: master ? 'master' : 'platform_adaptation',
      masterContentId,
      adaptationMode: master ? 'master' : 'platform_light',
    });
  });
}
/** Preserve in-scope authored content while making deliverables exactly match the matrix. */
export function fillMatrixVideos(pack: WeeklyPackage, defaults: Partial<VideoCreationPlan>, dueAt: string): WeeklyPackage {
  const rows = pack.matrixPlan || [];
  const existing = pack.tasks.find(t => t.templateId === 'production');
  const sourcePlans = existing?.videoPlans || [];
  const assignedByAccount = new Map(rows.map(row => [row.accountId, sourcePlans.filter(plan => plan.matrix?.accountId === row.accountId)]));
  const unassigned = sourcePlans.filter(plan => !plan.matrix?.accountId);
  const plans: VideoCreationPlan[] = [];
  for (const row of rows) {
    const targetCount = Math.max(0, row.weeklyCount - row.sourceProjectIds.length);
    const authored = (assignedByAccount.get(row.accountId) || []).slice(0, targetCount);
    for (const plan of authored) plans.push(bindMatrixVideo(plan, row));
    while (plans.filter(plan => plan.matrix?.accountId === row.accountId).length < targetCount && unassigned.length) {
      plans.push(bindMatrixVideo(unassigned.shift()!, row));
    }
    const assigned = plans.filter(plan => plan.matrix?.accountId === row.accountId).length;
    const missing = targetCount - assigned;
    for (let i = 0; i < missing && plans.length < 30; i++) {
      const slot = assigned + i;
      const theme = row.weeklyCount === 1 && row.contentDirection ? row.contentDirection : `待编导确认的买家问题 ${slot + 1}`;
      plans.push(bindMatrixVideo(normalizeVideoPlan({ ...defaults, contentId: crypto.randomUUID(), route: 'clone', theme, buyerProblem: '', directorStatus: 'candidate', plannedPublishDate: '' }), row));
    }
  }
  const linkedPlans = linkMatrixVersionsToMasters(plans, plans.length);
  const production = existing ? { ...existing, videoPlans: linkedPlans } : { templateId: 'production' as const, title: '制作产品视频', ownerId: '', ownerName: '', dueAt, notes: '', sourceProjectIds: [], videoPlans: linkedPlans };
  const projects = [...new Set(rows.flatMap(row => row.sourceProjectIds))];
  let tasks = pack.tasks.map(task => task.templateId === 'production' ? production : task.templateId === 'publishing' ? { ...task, sourceProjectIds: projects } : task);
  if (!existing && plans.length) tasks = [...tasks, production];
  const videoTarget = linkedPlans.length;
  const publishTarget = rows.reduce((sum, row) => sum + row.weeklyCount, 0) || videoTarget;
  const directorPlan = pack.directorPlan ? {
    ...pack.directorPlan,
    originalTarget: videoTarget,
    platformVersionTarget: videoTarget,
    publishTarget,
    productionBudgetMin: Math.max(pack.directorPlan.productionBudgetMin || 0, videoTarget * MASTER_VIDEO_COST_MIN_CNY),
    productionBudget: Math.max(pack.directorPlan.productionBudget || 0, videoTarget * MASTER_VIDEO_COST_POINT_CNY),
    productionBudgetMax: Math.max(pack.directorPlan.productionBudgetMax || 0, videoTarget * MASTER_VIDEO_COST_MAX_CNY),
  } : pack.directorPlan;
  return { ...pack, ...(directorPlan ? { directorPlan } : {}), tasks };
}
export function matrixScopeIssues(pack: WeeklyPackage, targets: Array<{ accountId: string; platform: string }>, platforms: string[]): string[] {
  return pack.matrixPlan?.some(row => !platforms.includes(row.platform) || (row.connected !== false && !targets.some(target => target.accountId === row.accountId && target.platform === row.platform))) ? ['矩阵账号必须属于本计划及本周平台范围'] : [];
}
export function matrixIssues(pack: WeeklyPackage): string[] {
  if (!pack.matrixPlan) return [];
  const rows = pack.matrixPlan;
  const plans = pack.tasks.find(t => t.templateId === 'production')?.videoPlans || [];
  const publishing = pack.tasks.some(t => t.templateId === 'publishing');
  const issues: string[] = [];
  if (new Set(rows.map(row => row.accountId)).size !== rows.length) issues.push('同一账号只能有一份本周矩阵安排');
  for (const row of rows) {
    if (!row.accountId || !['facebook', 'instagram', 'tiktok', 'youtube'].includes(row.platform)) issues.push('请选择有效的矩阵账号');
    if (![row.audience, row.productName, row.objective, row.contentDirection, row.cta].every(Boolean) || !(row.language in VIDEO_LANGUAGES)) issues.push('请补齐矩阵账号的受众、产品、语言、目标、内容方向和行动引导');
    if (!Number.isInteger(row.weeklyCount) || row.weeklyCount < 1 || row.weeklyCount > 30) issues.push('每个账号本周计划条数须为 1–30');
    const assigned = plans.filter(plan => plan.matrix?.accountId === row.accountId);
    if (assigned.length + row.sourceProjectIds.length !== row.weeklyCount) issues.push(`${row.platform} 账号的内容数量与本周计划不一致，请补齐视频计划或调整条数`);
    if (publishing && row.connected !== false && !pack.authorization.accountIds.includes(row.accountId)) issues.push('已连接矩阵账号不在本周允许发布的账号范围内');
    if (assigned.some(plan => {
      const hasIndependentProduct = Boolean(plan.productId?.trim() && plan.productName.trim());
      return plan.platform !== row.platform
        || !plan.productName
        || (!hasIndependentProduct && plan.productName !== row.productName)
        || plan.language !== row.language
        || plan.matrix?.audience !== row.audience
        || plan.matrix?.objective !== row.objective
        || plan.matrix?.cta !== row.cta;
    })) issues.push('账号策略已修改，请同步视频计划后再执行');
  }
  const productIdsByFamily = new Map<string, Set<string>>();
  for (const plan of plans) {
    const familyId = plan.contentFamilyId?.trim();
    const productId = plan.productId?.trim();
    if (!familyId || !productId) continue;
    const productIds = productIdsByFamily.get(familyId) || new Set<string>();
    productIds.add(productId);
    productIdsByFamily.set(familyId, productIds);
  }
  if ([...productIdsByFamily.values()].some(productIds => productIds.size > 1)) issues.push('同一内容系列的发布版本必须使用同一产品');
  for (const platform of [...new Set(rows.map(row => row.platform))]) {
    const families = plans.filter(plan => plan.platform === platform).map(plan => plan.contentFamilyId).filter(Boolean);
    if (new Set(families).size !== families.length) issues.push(`${platform} 平台存在重复内容，请调整内容分配，确保同平台不发布相似内容`);
  }
  const originals = plans.filter(plan => plan.productionRole !== 'platform_adaptation');
  if (pack.directorPlan && originals.length !== pack.directorPlan.originalTarget) issues.push('实际制作视频数量与本周目标不一致，请重新同步账号矩阵');
  if (plans.some(plan => plan.matrix?.accountId && !rows.some(row => row.accountId === plan.matrix?.accountId))) issues.push('视频绑定的账号已从矩阵移除，请重新选择账号');
  const sources = pack.tasks.find(t => t.templateId === 'publishing')?.sourceProjectIds || [];
  if (publishing && (sources.some(id => !rows.some(row => row.sourceProjectIds.includes(id))) || rows.some(row => row.sourceProjectIds.some(id => !sources.includes(id))))) issues.push('已有作品的账号安排与发布任务不一致，请同步视频计划');
  if (publishing && !rows.length) issues.push('请安排至少一个矩阵账号，或移除本周发布任务');
  return [...new Set(issues)];
}
