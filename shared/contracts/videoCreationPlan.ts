import { VIDEO_LANGUAGES, normalizeVideoLanguage } from './videoLanguages.js';
import type { SocialAccountRole } from './socialOperatingProfile.js';
import { normalizeBenchmarkAnalysisSnapshot, type BenchmarkAnalysis, type BenchmarkMaterialType, type BenchmarkShotRole } from '../benchmarkAnalysis.js';

/** Frozen user choices shared by planning, script, voice and rendering. */
export interface VideoCreationPlan {
  contentId?: string;
  /** Five weekly originals fan out into platform delivery versions. */
  contentFamilyId?: string;
  productionRole?: 'master' | 'platform_adaptation';
  masterContentId?: string;
  adaptationMode?: 'master' | 'platform_light';
  plannedPublishDate?: string;
  /** Explicit publish instant. The calendar defaults generated plans to 18:00 Asia/Shanghai. */
  plannedPublishAt?: string;
  buyerProblem?: string;
  evidenceRequirement?: string;
  directorStatus?: 'candidate' | 'script_draft' | 'script_approved' | 'in_production' | 'review' | 'approved' | 'blocked';
  estimatedCost?: number;
  estimatedCostRange?: {
    minCny: number;
    maxCny: number;
    basis: 'blended_master' | 'included_platform_adaptation' | 'verified_storyboard_provider_envelope';
  };
  /** Frozen publication copy produced together with the video brief. */
  publication?: {
    title: string;
    caption: string;
    tags: string[];
    status: 'planned' | 'generated' | 'confirmed';
    generatedBy: 'business_agent' | 'content_agent';
    /** One canonical copy is reused by every platform delivery. */
    copyMode?: 'canonical_original' | 'authorized_source_reuse';
    sourceReferenceId?: string;
    factReplacements?: Array<{ from: string; to: string; kind: 'company' | 'brand' | 'product' }>;
  };
  /** Auditable evidence used by the Business Agent when it proposed this slot. */
  planningEvidence?: {
    generatedFrom: 'matrix_benchmark_viral' | 'matrix_viral' | 'matrix_product';
    matrixAccountId: string;
    requiredCount: number;
    slot: number;
    referenceTitle: string;
    referenceViews: string;
    referenceThumbnailUrl: string;
    referenceSourceUrl: string;
    benchmarkAccount: string;
    matchScore: number;
    factors: string[];
  };
  /** Frozen Director evidence. Content Agent must use this exact structure. */
  benchmarkAnalysis?: BenchmarkAnalysis;
  /** Persisted pre-production result reused across refreshes and production. */
  preproduction?: VideoPreproductionPreview;
  matrix?: { accountId: string; audience: string; objective: string; cta: string; accountRole?: SocialAccountRole; formats?: string[] };
  reviewRequirements?: Array<{ todoId: string; reference: string; scene: number; startsAt: number; endsAt: number; requirements: string; materials: string; acceptance: string }>;
  route: 'clone' | 'material' | 'product';
  /** Stable enterprise product identity. Names remain display-only. */
  productId?: string;
  productName: string;
  theme: string;
  language: string;
  duration: number;
  platform: 'facebook' | 'instagram' | 'tiktok' | 'youtube' | 'linkedin';
  materialIds: string[];
  referenceId: string;
  presenter: 'material' | 'heygen' | 'avatar';
  scenePlan?: VideoSceneChoice[];
  heygenAvatarId: string;
  avatarConsent: boolean;
  voice: string;
}
export interface VideoPreproductionPreview {
  version: 1;
  status: 'ready' | 'blocked';
  generatedAt: string;
  benchmark: {
    status: 'ready' | 'not_applicable' | 'missing';
    referenceId: string;
    title: string;
    account: string;
    views: string;
    thumbnailUrl: string;
    sourceUrl: string;
    hook: string;
    shotSummary: string[];
  };
  materials: {
    status: 'ready' | 'blocked';
    items: Array<{
      id: string;
      name: string;
      type: 'image' | 'video';
      previewUrl: string;
      status: 'ready' | 'missing' | 'pending_shoot' | 'needs_authorization' | 'system_planned';
    }>;
    storyboard?: Array<{
      materialType: BenchmarkMaterialType;
      materialLabel: string;
      narrativeRole: BenchmarkShotRole;
      shotIds: string[];
      referenceFirstFrameUrl: string;
      materialId: string;
      materialPreviewUrl: string;
      status: 'ready' | 'missing' | 'pending_shoot' | 'needs_authorization' | 'system_planned';
      supplyMode?: 'matched_asset' | 'system_fallback' | 'needs_input' | 'optional';
      supplyRoute?: string;
      supplyNote?: string;
    }>;
    blockers: string[];
    pendingShootTaskIds: string[];
  };
  readiness: {
    canStart: boolean;
    blockers: string[];
  };
  confidence: {
    onTimeRate: number | null;
    effectLevel: 'medium' | 'low' | 'insufficient';
    reasons: string[];
  };
  /** Frozen Director Agent output reused by production instead of paying twice. */
  directorScript?: {
    version: number;
    body: string;
    hash: string;
    language: string;
    status: 'confirmed';
    generatedBy: 'director_agent';
    generatedAt: string;
    source: 'llm' | 'deterministic_closed_world_fallback';
    degradedReason: string;
  };
}
export interface VideoSceneChoice { source: 'avatar' | 'material'; materialId: string }
export const VIDEO_PRESENTATIONS = { material: '纯素材剪辑', avatar: '纯数字人口播', heygen: '数字人 + 素材混剪' } as const;
export const usesDigitalPresenter = (plan: Pick<VideoCreationPlan, 'presenter'>) => plan.presenter === 'avatar' || plan.presenter === 'heygen';
export const defaultMixedScenes = (count = 4): VideoSceneChoice[] => Array.from({ length: count }, (_, index) => ({ source: index === 0 || index === count - 1 ? 'avatar' : 'material', materialId: '' }));
export function presentationScenes(plan: VideoCreationPlan, count: number): VideoSceneChoice[] {
  if (!Number.isInteger(count) || count < 1) throw Error('缺少有效分镜');
  if (plan.presenter === 'avatar') return Array.from({ length: count }, () => ({ source: 'avatar', materialId: '' }));
  if (plan.presenter === 'material') {
    if (plan.scenePlan?.length) {
      if (plan.scenePlan.length !== count || plan.scenePlan.some(s => s.source !== 'material' || s.materialId && !plan.materialIds.includes(s.materialId))) throw Error('纯素材分镜绑定无效');
      return plan.scenePlan;
    }
    return Array.from({ length: count }, () => ({ source: 'material', materialId: '' }));
  }
  const scenes = plan.scenePlan?.length ? plan.scenePlan : defaultMixedScenes(count);
  if (scenes.length !== count) throw Error('分镜数量与已确认画面安排不同，请重新生成或调整分镜');
  if (!scenes.some(scene => scene.source === 'avatar') || !scenes.some(scene => scene.source === 'material')) throw Error('混剪必须同时包含数字人和素材镜头，请调整分镜或更改成片方式');
  for (const scene of scenes) {
    if (!['avatar', 'material'].includes(scene.source)) throw Error('未知分镜画面来源');
    if (scene.source === 'material' && scene.materialId && !plan.materialIds.includes(scene.materialId)) throw Error('分镜引用了未选择的素材，请重新绑定');
  }
  return scenes;
}
export const VIDEO_ROUTES = { clone: '爆款裂变', material: '从素材生成', product: '从产品生成' } as const;
export const isMasterVideoPlan = (plan: Pick<VideoCreationPlan, 'productionRole'>) => plan.productionRole !== 'platform_adaptation';
export function normalizeVideoPlan(value: Partial<VideoCreationPlan>): VideoCreationPlan {
  const preview = value.preproduction && typeof value.preproduction === 'object'
    ? value.preproduction
    : undefined;
  const previewStatus = preview && ['ready', 'blocked'].includes(String(preview.status))
    ? preview.status
    : undefined;
  const cleanPreviewUrl = (raw: unknown) => {
    const candidate = String(raw || '').trim().slice(0, 2_000);
    return /^(?:https?:\/\/|\/api\/|\/media\/|\/covers\/|\/generated\/)/i.test(candidate) ? candidate : '';
  };
  const cleanList = (raw: unknown, limit: number, itemLimit = 500) => Array.isArray(raw)
    ? [...new Set(raw.map(item => String(item || '').trim()).filter(Boolean))].slice(0, limit).map(item => item.slice(0, itemLimit))
    : [];
  const benchmarkAnalysis = normalizeBenchmarkAnalysisSnapshot(value.benchmarkAnalysis);
  return {
    contentId: String(value.contentId || '').trim().slice(0, 120),
    contentFamilyId: String(value.contentFamilyId || '').trim().slice(0, 120),
    productionRole: value.productionRole === 'platform_adaptation' ? 'platform_adaptation' : 'master',
    masterContentId: String(value.masterContentId || '').trim().slice(0, 120),
    adaptationMode: value.adaptationMode === 'platform_light' ? 'platform_light' : 'master',
    plannedPublishDate: /^\d{4}-\d{2}-\d{2}$/.test(String(value.plannedPublishDate || '')) ? String(value.plannedPublishDate) : '',
    plannedPublishAt: /(?:Z|[+-]\d{2}:\d{2})$/.test(String(value.plannedPublishAt || '')) && Number.isFinite(Date.parse(String(value.plannedPublishAt))) ? String(value.plannedPublishAt) : '',
    buyerProblem: String(value.buyerProblem || '').trim().slice(0, 500),
    evidenceRequirement: String(value.evidenceRequirement || '').trim().slice(0, 1000),
    directorStatus: ['candidate', 'script_draft', 'script_approved', 'in_production', 'review', 'approved', 'blocked'].includes(String(value.directorStatus)) ? value.directorStatus : 'candidate',
    estimatedCost: Math.max(0, Math.round((Number(value.estimatedCost) || 0) * 100) / 100),
    ...(value.estimatedCostRange && typeof value.estimatedCostRange === 'object' ? { estimatedCostRange: {
      minCny: Math.max(0, Math.round((Number(value.estimatedCostRange.minCny) || 0) * 100) / 100),
      maxCny: Math.max(0, Math.round((Number(value.estimatedCostRange.maxCny) || 0) * 100) / 100),
      basis: value.estimatedCostRange.basis === 'included_platform_adaptation'
        ? 'included_platform_adaptation' as const
        : value.estimatedCostRange.basis === 'verified_storyboard_provider_envelope'
          ? 'verified_storyboard_provider_envelope' as const
          : 'blended_master' as const,
    } } : {}),
    ...(value.publication && typeof value.publication === 'object' ? { publication: {
      title: String(value.publication.title || '').trim().slice(0, 300),
      caption: String(value.publication.caption || '').trim().slice(0, 2_000),
      tags: cleanList(value.publication.tags, 20, 80).map(item => item.replace(/^#+/, '')),
      status: ['planned', 'generated', 'confirmed'].includes(String(value.publication.status)) ? value.publication.status : 'planned',
      generatedBy: value.publication.generatedBy === 'content_agent' ? 'content_agent' as const : 'business_agent' as const,
      copyMode: value.publication.copyMode === 'authorized_source_reuse' ? 'authorized_source_reuse' as const : 'canonical_original' as const,
      sourceReferenceId: String(value.publication.sourceReferenceId || '').trim().slice(0, 160),
      factReplacements: Array.isArray(value.publication.factReplacements)
        ? value.publication.factReplacements.flatMap(item => item && typeof item === 'object' && ['company', 'brand', 'product'].includes(String(item.kind))
          ? [{ from: String(item.from || '').trim().slice(0, 160), to: String(item.to || '').trim().slice(0, 160), kind: item.kind as 'company' | 'brand' | 'product' }]
          : []).filter(item => item.from && item.to).slice(0, 20)
        : [],
    } } : {}),
    ...(value.planningEvidence && typeof value.planningEvidence === 'object' ? { planningEvidence: {
      generatedFrom: ['matrix_benchmark_viral', 'matrix_viral', 'matrix_product'].includes(String(value.planningEvidence.generatedFrom))
        ? value.planningEvidence.generatedFrom
        : 'matrix_product',
      matrixAccountId: String(value.planningEvidence.matrixAccountId || '').trim().slice(0, 160),
      requiredCount: Math.max(1, Math.min(30, Math.floor(Number(value.planningEvidence.requiredCount) || 1))),
      slot: Math.max(1, Math.min(30, Math.floor(Number(value.planningEvidence.slot) || 1))),
      referenceTitle: String(value.planningEvidence.referenceTitle || '').trim().slice(0, 500),
      referenceViews: String(value.planningEvidence.referenceViews || '').trim().slice(0, 80),
      referenceThumbnailUrl: cleanPreviewUrl(value.planningEvidence.referenceThumbnailUrl),
      referenceSourceUrl: cleanPreviewUrl(value.planningEvidence.referenceSourceUrl),
      benchmarkAccount: String(value.planningEvidence.benchmarkAccount || '').trim().slice(0, 300),
      matchScore: Math.max(0, Math.min(100, Math.round(Number(value.planningEvidence.matchScore) || 0))),
      factors: Array.isArray(value.planningEvidence.factors)
        ? [...new Set(value.planningEvidence.factors.map(item => String(item || '').trim()).filter(Boolean))].slice(0, 8).map(item => item.slice(0, 160))
        : [],
    } } : {}),
    ...(benchmarkAnalysis ? { benchmarkAnalysis } : {}),
    ...(preview && previewStatus ? { preproduction: {
      version: 1,
      status: previewStatus,
      generatedAt: String(preview.generatedAt || '').trim().slice(0, 80),
      benchmark: {
        status: ['ready', 'not_applicable', 'missing'].includes(String(preview.benchmark?.status)) ? preview.benchmark.status : 'missing',
        referenceId: String(preview.benchmark?.referenceId || '').trim().slice(0, 160),
        title: String(preview.benchmark?.title || '').trim().slice(0, 500),
        account: String(preview.benchmark?.account || '').trim().slice(0, 300),
        views: String(preview.benchmark?.views || '').trim().slice(0, 80),
        thumbnailUrl: cleanPreviewUrl(preview.benchmark?.thumbnailUrl),
        sourceUrl: cleanPreviewUrl(preview.benchmark?.sourceUrl),
        hook: String(preview.benchmark?.hook || '').trim().slice(0, 1_000),
        shotSummary: cleanList(preview.benchmark?.shotSummary, 8, 500),
      },
      materials: {
        status: preview.materials?.status === 'ready' ? 'ready' : 'blocked',
        items: Array.isArray(preview.materials?.items) ? preview.materials.items.slice(0, 30).map(item => ({
          id: String(item?.id || '').trim().slice(0, 160),
          name: String(item?.name || '').trim().slice(0, 240),
          type: item?.type === 'video' ? 'video' as const : 'image' as const,
          previewUrl: cleanPreviewUrl(item?.previewUrl),
          status: ['ready', 'missing', 'pending_shoot', 'needs_authorization', 'system_planned'].includes(String(item?.status)) ? item.status : 'missing',
        })) : [],
        storyboard: Array.isArray(preview.materials?.storyboard) ? preview.materials.storyboard.slice(0, 30).map(item => ({
          materialType: ['talking_head', 'factory', 'product', 'consumer_demo', 'general', 'unknown'].includes(String(item?.materialType)) ? item.materialType : 'unknown',
          materialLabel: String(item?.materialLabel || '').trim().slice(0, 80),
          narrativeRole: ['hook', 'pain_point', 'capability_proof', 'product_intro', 'effect_proof', 'cta', 'transition', 'unknown'].includes(String(item?.narrativeRole)) ? item.narrativeRole : 'unknown',
          shotIds: cleanList(item?.shotIds, 20, 120),
          referenceFirstFrameUrl: cleanPreviewUrl(item?.referenceFirstFrameUrl),
          materialId: String(item?.materialId || '').trim().slice(0, 160),
          materialPreviewUrl: cleanPreviewUrl(item?.materialPreviewUrl),
          status: ['ready', 'missing', 'pending_shoot', 'needs_authorization', 'system_planned'].includes(String(item?.status)) ? item.status : 'missing',
          ...(['matched_asset', 'system_fallback', 'needs_input', 'optional'].includes(String(item?.supplyMode))
            ? { supplyMode: item.supplyMode }
            : {}),
          ...(String(item?.supplyRoute || '').trim()
            ? { supplyRoute: String(item?.supplyRoute || '').trim().slice(0, 160) }
            : {}),
          ...(String(item?.supplyNote || '').trim()
            ? { supplyNote: String(item?.supplyNote || '').trim().slice(0, 500) }
            : {}),
        })) : [],
        blockers: cleanList(preview.materials?.blockers, 20, 500),
        pendingShootTaskIds: cleanList(preview.materials?.pendingShootTaskIds, 20, 160),
      },
      readiness: {
        canStart: preview.readiness?.canStart === true,
        blockers: cleanList(preview.readiness?.blockers, 20, 500),
      },
      confidence: {
        onTimeRate: preview.confidence?.onTimeRate !== null
          && preview.confidence?.onTimeRate !== undefined
          && Number.isFinite(Number(preview.confidence.onTimeRate))
          ? Math.max(0, Math.min(100, Math.round(Number(preview.confidence?.onTimeRate))))
          : null,
        effectLevel: ['medium', 'low', 'insufficient'].includes(String(preview.confidence?.effectLevel)) ? preview.confidence.effectLevel : 'insufficient',
        reasons: cleanList(preview.confidence?.reasons, 10, 500),
      },
      ...(preview.directorScript && typeof preview.directorScript === 'object' ? { directorScript: {
        version: Math.max(1, Math.floor(Number(preview.directorScript.version) || 1)),
        body: String(preview.directorScript.body || '').trim().slice(0, 30_000),
        hash: String(preview.directorScript.hash || '').trim().slice(0, 128),
        language: normalizeVideoLanguage(preview.directorScript.language || value.language || 'en'),
        status: 'confirmed' as const,
        generatedBy: 'director_agent' as const,
        generatedAt: String(preview.directorScript.generatedAt || preview.generatedAt || '').trim().slice(0, 80),
        source: preview.directorScript.source === 'deterministic_closed_world_fallback' ? 'deterministic_closed_world_fallback' as const : 'llm' as const,
        degradedReason: String(preview.directorScript.degradedReason || '').trim().slice(0, 1_000),
      } } : {}),
    } } : {}),
    ...(value.matrix && typeof value.matrix === 'object' ? { matrix: {
      accountId: String(value.matrix.accountId || '').trim().slice(0, 160), audience: String(value.matrix.audience || '').trim().slice(0, 500), objective: String(value.matrix.objective || '').trim().slice(0, 500), cta: String(value.matrix.cta || '').trim().slice(0, 500),
      accountRole: ['brand_capability', 'buyer_advisor', 'brand_combined'].includes(String(value.matrix.accountRole)) ? value.matrix.accountRole : 'brand_combined',
      formats: Array.isArray(value.matrix.formats) ? [...new Set(value.matrix.formats.map(item => String(item).trim()).filter(Boolean))].slice(0, 8) : [],
    } } : {}),
    ...(Array.isArray(value.reviewRequirements) ? { reviewRequirements: value.reviewRequirements.slice(0, 5).map(r => ({ todoId: String(r.todoId || '').slice(0, 80), reference: String(r.reference || '').slice(0, 4000), scene: 1, startsAt: 0, endsAt: 3, requirements: String(r.requirements || '').slice(0, 4000), materials: String(r.materials || '').slice(0, 4000), acceptance: String(r.acceptance || '').slice(0, 4000) })) } : {}),
    route: ['clone', 'material', 'product'].includes(String(value.route)) ? value.route! : 'product',
    productId: String(value.productId || '').trim().slice(0, 160),
    productName: String(value.productName || '').trim().slice(0, 180), theme: String(value.theme || '').trim().slice(0, 500),
    language: normalizeVideoLanguage(value.language || 'en'), duration: Math.max(10, Math.min(180, Number(value.duration) || 30)),
    platform: ['facebook', 'instagram', 'tiktok', 'youtube', 'linkedin'].includes(String(value.platform)) ? value.platform! : 'youtube',
    materialIds: Array.isArray(value.materialIds) ? [...new Set(value.materialIds.map(String))].slice(0, 30) : [],
    referenceId: String(value.referenceId || '').trim().slice(0, 160),
    presenter: value.presenter === 'heygen' || value.presenter === 'avatar' ? value.presenter : 'material',
    ...(Array.isArray(value.scenePlan) ? { scenePlan: value.scenePlan.slice(0, 8).map(scene => ({ source: String(scene.source) as VideoSceneChoice['source'], materialId: scene.source === 'material' ? String(scene.materialId || '').slice(0, 160) : '' })) } : {}), heygenAvatarId: String(value.heygenAvatarId || '').trim().slice(0, 160),
    avatarConsent: value.avatarConsent === true, voice: String(value.voice || 'v1').slice(0, 160),
  };
}
export function videoPlanErrors(plan: VideoCreationPlan): string[] {
  const sceneErrors: string[] = [];
  if (plan.presenter === 'heygen' && plan.scenePlan?.length) {
    if (plan.scenePlan.length < 3) sceneErrors.push('混剪需要至少三镜');
    try { presentationScenes(plan, plan.scenePlan.length); } catch (error) { sceneErrors.push((error as Error).message); }
  }
  return [...sceneErrors,!(plan.language in VIDEO_LANGUAGES) && '请选择支持的语言', !plan.productName && '请选择产品', !plan.theme && '请填写本条主题或买家问题',
    plan.route === 'clone' && !plan.referenceId && '请选择爆款参考',
    plan.route === 'material' && !plan.materialIds.length && '请选择本条素材',
    plan.presenter === 'heygen' && !plan.materialIds.length && '数字人混剪需选择产品画面素材',
    usesDigitalPresenter(plan) && (!plan.heygenAvatarId || !plan.avatarConsent) && '请选择 HeyGen 人物并确认使用权',
  ].filter(Boolean) as string[];
}
// Scheduling can precede reference collection; production still uses videoPlanErrors.
export function videoSchedulingErrors(plan: VideoCreationPlan): string[] {
  return videoPlanErrors(plan).filter(error => !(
    plan.route === 'clone' && plan.directorStatus === 'candidate' && error === '请选择爆款参考'
  ));
}
export function spokenLanguageMatches(text: string, language: string): boolean {
  const code = normalizeVideoLanguage(language);
  const letters = (text.match(/[\p{L}]/gu) || []).length;
  if (!letters || !(code in VIDEO_LANGUAGES)) return false;
  const ratio = (pattern: RegExp) => (text.match(pattern) || []).length / letters;
  if (code === 'zh') return ratio(/[\u3400-\u9fff]/g) > 0.2 && ratio(/[\u3040-\u30ff]/g) < 0.05;
  if (code === 'ja') return ratio(/[\u3040-\u30ff]/g) > 0.1;
  if (code === 'ko') return ratio(/[\uac00-\ud7af]/g) > 0.2;
  if (code === 'ar') return ratio(/[\u0600-\u06ff]/g) > 0.2;
  if (code === 'ru') return ratio(/[\u0400-\u04ff]/g) > 0.2;
  return ratio(/[\p{Script=Latin}]/gu) > 0.8;
}
