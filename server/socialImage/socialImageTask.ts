import { createHash, randomUUID } from 'node:crypto';
import type { DataStore } from '../storage/datastore.js';
import {
  SOCIAL_IMAGE_CONTENT_TYPES,
  socialImageTaskCanPublish,
  socialImageTaskIssues,
  type SocialImageCreationTask,
  type SocialImageContentType,
  type SocialImageCreationPath,
  type SocialImageReferenceLayerBlueprint,
} from '../../shared/contracts/socialImageCreation.js';

// Reuse the canonical Studio project collection so PocketBase and Postgres
// deployments persist image drafts without a second migration-only task silo.
export const SOCIAL_IMAGE_TASKS_COLLECTION = 'studio_projects';
type StoredImageTask = { id: string; tenant_id: string; title: string; status: string; spec: { socialImageTask?: SocialImageCreationTask }; created_at: string; updated_at: string };

const text = (value: unknown, max = 5000) => String(value ?? '').trim().slice(0, max);
const stringArray = (value: unknown, max = 20) => Array.isArray(value) ? value.map(item => text(item, 500)).filter(Boolean).slice(0, max) : [];
const clamp01 = (value: unknown) => Number.isFinite(Number(value)) ? Math.max(0, Math.min(1, Number(value))) : 0;
const normalizedRect = (value: unknown) => {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const x = clamp01(row.x), y = clamp01(row.y);
  return { x, y, width: Math.min(1 - x, clamp01(row.width)), height: Math.min(1 - y, clamp01(row.height)) };
};

export function normalizeSocialImageReferenceLayerBlueprints(value: unknown): SocialImageReferenceLayerBlueprint[] {
  const roles = new Set(['background', 'mask', 'product', 'text', 'logo', 'decoration']);
  const shapes = new Set(['rectangle', 'rounded_rectangle', 'ellipse', 'polygon', 'linear_gradient']);
  if (!Array.isArray(value)) return [];
  return value.slice(0, 10).flatMap((raw, blueprintIndex) => {
    if (!raw || typeof raw !== 'object') return [];
    const row = raw as Record<string, unknown>;
    const layers = (Array.isArray(row.layers) ? row.layers : []).slice(0, 20).flatMap((rawLayer, layerIndex) => {
      if (!rawLayer || typeof rawLayer !== 'object') return [];
      const layer = rawLayer as Record<string, unknown>, role = String(layer.role || '');
      const bounds = normalizedRect(layer.bounds);
      if (!roles.has(role) || !bounds.width || !bounds.height) return [];
      return [{ id: text(layer.id, 80) || `${role}-${layerIndex + 1}`, role: role as SocialImageReferenceLayerBlueprint['layers'][number]['role'], zIndex: Math.max(0, Math.min(100, Math.round(Number(layer.zIndex) || layerIndex))), bounds, confidence: clamp01(layer.confidence) }];
    });
    const masks = (Array.isArray(row.masks) ? row.masks : []).slice(0, 12).flatMap((rawMask, maskIndex) => {
      if (!rawMask || typeof rawMask !== 'object') return [];
      const mask = rawMask as Record<string, unknown>, shape = String(mask.shape || '');
      const bounds = normalizedRect(mask.bounds);
      if (!shapes.has(shape) || !bounds.width || !bounds.height) return [];
      const points = Array.isArray(mask.points) ? mask.points.slice(0, 24).flatMap(point => {
        if (!point || typeof point !== 'object') return [];
        const item = point as Record<string, unknown>;
        return [{ x: clamp01(item.x), y: clamp01(item.y) }];
      }) : [];
      return [{ id: text(mask.id, 80) || `mask-${maskIndex + 1}`, shape: shape as SocialImageReferenceLayerBlueprint['masks'][number]['shape'], bounds,
        opacity: clamp01(mask.opacity), color: /^#[0-9a-f]{6}$/i.test(String(mask.color || '')) ? String(mask.color) : undefined,
        cornerRadius: mask.cornerRadius === undefined ? undefined : clamp01(mask.cornerRadius), feather: mask.feather === undefined ? undefined : clamp01(mask.feather),
        angle: Number.isFinite(Number(mask.angle)) ? Math.max(-360, Math.min(360, Number(mask.angle))) : undefined,
        points: points.length >= 3 ? points : undefined, zIndex: Math.max(0, Math.min(100, Math.round(Number(mask.zIndex) || maskIndex + 1))), confidence: clamp01(mask.confidence) }];
    });
    return layers.length || masks.length ? [{ imageIndex: Math.max(1, Math.round(Number(row.imageIndex) || blueprintIndex + 1)), layers, masks }] : [];
  });
}

export function defaultSocialImageTask(input: Record<string, unknown>, now = new Date().toISOString()): SocialImageCreationTask {
  const imageType = SOCIAL_IMAGE_CONTENT_TYPES.includes(input.imageType as SocialImageContentType) ? input.imageType as SocialImageContentType : 'product_poster';
  const creationPath: SocialImageCreationPath = input.creationPath === 'viral_replication' ? 'viral_replication' : 'material_processing';
  const isGif = imageType === 'gif_poster';
  const isCarousel = imageType === 'carousel';
  const productRefs = stringArray(input.productRefs, 10);
  const productNames = stringArray(input.productNames, 10);
  const referenceUrls = stringArray(input.referenceUrls, 10);
  const rawSnapshot = input.referenceSnapshot && typeof input.referenceSnapshot === 'object' ? input.referenceSnapshot as Record<string, unknown> : null;
  const snapshotImageUrls = stringArray(rawSnapshot?.imageUrls, 10);
  const layerBlueprints = creationPath === 'viral_replication' ? normalizeSocialImageReferenceLayerBlueprints(input.referenceLayerBlueprints) : [];
  const referenceSnapshot = creationPath === 'viral_replication' ? {
    sourceRecordId: text(rawSnapshot?.sourceRecordId, 200) || undefined,
    sourceUrl: text(rawSnapshot?.sourceUrl, 2000) || referenceUrls[0] || undefined,
    platform: text(rawSnapshot?.platform, 80) || undefined,
    accountName: text(rawSnapshot?.accountName, 200) || undefined,
    title: text(rawSnapshot?.title, 500) || undefined,
    caption: text(rawSnapshot?.caption, 5000) || undefined,
    imageUrls: snapshotImageUrls.length ? snapshotImageUrls : referenceUrls.filter(url => /\.(?:png|jpe?g|webp|gif)(?:\?|$)/i.test(url)),
    collectedAt: text(rawSnapshot?.collectedAt, 80) || now,
    fingerprint: text(rawSnapshot?.fingerprint, 200) || createHash('sha256').update(JSON.stringify(rawSnapshot || referenceUrls)).digest('hex'),
  } : undefined;
  const enterpriseAssets = Array.isArray(input.enterpriseAssets) ? input.enterpriseAssets.slice(0, 30).flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const asset = item as Record<string, unknown>;
    const role = ['product', 'logo', 'scene', 'evidence'].includes(String(asset.role)) ? String(asset.role) as 'product' | 'logo' | 'scene' | 'evidence' : 'scene';
    return [{ assetId: text(asset.assetId, 200), role, name: text(asset.name, 500), source: asset.source === 'enterprise_knowledge_base' ? 'enterprise_knowledge_base' as const : 'enterprise_material_library' as const, contentHash: text(asset.contentHash, 200) || undefined, required: asset.required !== false }];
  }).filter(asset => asset.assetId) : [];
  return {
    schemaVersion: 'social-image-creation.v2', id: '', version: 1,
    title: text(input.title, 200) || (creationPath === 'viral_replication' ? '爆款复刻 · 图片草稿' : '自由创作 · 图片草稿'),
    creationPath, contentMode: 'image', imageType, step: 'inputs', status: 'draft',
    contentBrief: {
      objective: input.objective === 'awareness' || input.objective === 'trust' || input.objective === 'education' || input.objective === 'event_conversion' ? input.objective : 'lead_generation',
      topicType: input.topicType === 'partnership_news' || input.topicType === 'brand_news' || input.topicType === 'experiment_comparison' || input.topicType === 'trend' ? input.topicType : 'technical_solution',
      coreClaim: text(input.coreClaim, 2000), audience: stringArray(input.audience, 10), productRefs, productNames,
      evidenceItems: [], partnerName: text(input.partnerName, 300) || undefined,
      factuality: input.factuality === 'mock' || input.factuality === 'user_supplied' ? input.factuality : 'verified',
      targetAction: text(input.targetAction, 500) || undefined, prohibitedClaims: stringArray(input.prohibitedClaims, 20),
    },
    creativeRecipe: {
      narrativePattern: imageType === 'brand_news' ? 'news_announcement' : imageType === 'experiment_comparison' ? 'visible_experiment' : imageType === 'trend' ? 'trend_to_opportunity' : 'problem_solution',
      visualProof: imageType === 'brand_news' ? 'event_photo' : imageType === 'experiment_comparison' ? 'before_after' : 'product_hero',
      layoutRecipe: imageType === 'brand_news' ? 'news_search_card' : imageType === 'carousel' ? 'step_carousel' : imageType === 'infographic' ? 'technical_infographic' : 'hero_product_poster',
      copyPattern: imageType === 'brand_news' ? '新闻结论→合作主体→事实→行业意义→CTA' : '用户问题→产品价值→证据→CTA',
      imageTextRelation: imageType === 'experiment_comparison' || imageType === 'brand_news' ? 'image_proves_copy' : 'image_contextualizes_copy',
      colorStrategy: 'derive_from_product', referenceStrength: creationPath === 'viral_replication' ? 0.8 : 0.35,
    },
    imageTextContract: { headline: '', caption: '', hashtags: [], requiredFacts: [], prohibitedInferences: [], visualMustShow: [], visualMustNotImply: [] },
    deliverySpec: {
      format: isGif ? 'gif' : isCarousel ? 'carousel' : 'jpg', platform: 'facebook', aspectRatio: '4:5', language: 'en', outputCount: isCarousel || isGif ? 4 : 1,
      imageGeneration: { provider: 'openai', model: 'gpt-image-2', quality: 'low' },
      ...(isGif ? { motion: { mechanism: 'background_switch' as const, fixedLayers: ['headline', 'content_module', 'brand'], dynamicLayers: ['background'], loopDurationMs: 6000 } } : {}),
    },
    materialIds: [], referenceUrls, referenceSnapshot,
    replicationRecipe: creationPath === 'viral_replication' ? {
      contentArchetype: imageType === 'brand_news' ? 'brand_news' : imageType,
      imageCopyRelation: imageType === 'brand_news' || imageType === 'experiment_comparison' ? 'image_proves_copy' : 'image_contextualizes_copy',
      preserve: ['背景的语义与明暗分区', '产品主体数量与组合节奏', '左上角角标 UI', '底栏 UI', '主副标题层级与相对坐标', '留白区与图文关系'],
      replace: ['品牌身份', '产品资产', '商业事实', '文字内容'], palette: [],
      layoutRegions: [
        { id: 'background', role: '背景图与场景透视', x: 0, y: 0, width: 1, height: 1 },
        { id: 'corner-badge', role: '左上角角标 UI', x: 0, y: 0, width: .32, height: .18 },
        { id: 'headline-zone', role: '参考图主要留白区中的关键标题、副标题与补充说明', x: .36, y: .03, width: .6, height: .34 },
        { id: 'product-stage', role: '单品、单品组合或套组主体', x: .04, y: .34, width: .92, height: .54 },
        { id: 'bottom-bar', role: '底栏 UI 与 CTA', x: 0, y: .88, width: 1, height: .12 },
      ],
      productPresentation: 'auto_from_reference',
      typographyRegions: [
        { role: 'headline', region: 'headline-zone', relativeSize: 'display', alignment: 'left', preserveLineBreaks: true },
        { role: 'subheadline', region: 'headline-zone', relativeSize: 'large', alignment: 'left', preserveLineBreaks: true },
        { role: 'supporting', region: 'headline-zone', relativeSize: 'small', alignment: 'left', preserveLineBreaks: true },
      ],
      protectedSubjects: ['产品包装', '主体人物'], overlayZones: ['标题区', '内容模块区', 'CTA区'],
      ...(layerBlueprints.length ? { referenceLayerBlueprints: layerBlueprints } : {}),
      ...(isGif ? { motionMechanism: 'background_switch' as const } : {}),
    } : undefined,
    enterpriseAssets, generationJobs: [], repairInstructions: [], outputs: [], fieldsToConfirm: [], publishable: false, createdAt: now, updatedAt: now,
  };
}

export async function createSocialImageTask(store: DataStore, tenantId: string, input: Record<string, unknown>) {
  const now = new Date().toISOString();
  const payload = defaultSocialImageTask(input, now);
  const issues = socialImageTaskIssues(payload).filter(issue => issue !== '缺少核心主张' && issue !== '至少选择一个企业产品');
  if (issues.length) throw new Error(issues.join('；'));
  const created = await store.create<StoredImageTask>(SOCIAL_IMAGE_TASKS_COLLECTION, {
    tenant_id: tenantId, title: payload.title, status: 'draft',
    spec: { contentMode: 'image', creationPath: payload.creationPath, socialImageTask: payload }, created_at: now, updated_at: now,
  });
  if (!created) throw new Error('图片任务保存失败');
  const task = { ...payload, id: created.id };
  if (!await store.update(SOCIAL_IMAGE_TASKS_COLLECTION, created.id, { spec: { contentMode: 'image', creationPath: task.creationPath, socialImageTask: task } })) {
    throw new Error('图片任务标识保存失败');
  }
  return task;
}

export async function readSocialImageTask(store: DataStore, tenantId: string, id: string) {
  const row = await store.getById<StoredImageTask>(SOCIAL_IMAGE_TASKS_COLLECTION, id);
  const payload = row?.spec?.socialImageTask;
  if (!row || row.tenant_id !== tenantId || !payload || payload.contentMode !== 'image') return null;
  return {
    ...payload, id: row.id, version: payload.version || 1,
    enterpriseAssets: payload.enterpriseAssets || [],
    generationJobs: payload.generationJobs || [],
    repairInstructions: payload.repairInstructions || [],
    layerGraph: payload.layerGraph,
  };
}

/** A browser may request repair, but may not invent or approve a delivery node. */
export function socialImageClientOutputPatchIssue(
  current: SocialImageCreationTask['outputs'],
  proposed: SocialImageCreationTask['outputs'],
): string | null {
  if (!Array.isArray(proposed) || proposed.length !== current.length) return 'social_image_outputs_server_owned';
  for (let index = 0; index < current.length; index += 1) {
    const existing = current[index]!;
    const candidate = proposed[index]!;
    if (!candidate || candidate.id !== existing.id) return 'social_image_outputs_server_owned';
    const { state: oldState, ...oldFields } = existing;
    const { state: nextState, ...nextFields } = candidate;
    if (JSON.stringify(nextFields) !== JSON.stringify(oldFields)) return 'social_image_outputs_server_owned';
    if (nextState !== oldState && (nextState !== 'repair_required' || oldState === 'superseded')) {
      return 'social_image_output_transition_invalid';
    }
  }
  return null;
}

export async function updateSocialImageTask(store: DataStore, tenantId: string, id: string, expectedVersion: number, patch: Partial<SocialImageCreationTask>) {
  const row = await store.getById<StoredImageTask>(SOCIAL_IMAGE_TASKS_COLLECTION, id);
  const current = row?.tenant_id === tenantId && row.spec?.socialImageTask ? { ...row.spec.socialImageTask, id: row.id } : null;
  if (!current) return { kind: 'missing' as const };
  if (current.version !== expectedVersion) return { kind: 'conflict' as const, task: current };
  const paidInputPatch = ['imageType', 'creationPath', 'contentBrief', 'creativeRecipe', 'imageTextContract', 'renderBrief', 'deliverySpec',
    'materialIds', 'referenceUrls', 'referenceSnapshot', 'replicationRecipe', 'enterpriseAssets', 'layerGraph', 'renderPlan']
    .some(field => Object.prototype.hasOwnProperty.call(patch, field));
  if (paidInputPatch && (current.renderPlan || current.generationJobs?.some(job =>
    ['queued', 'running', 'outcome_unknown'].includes(job.status) && !job.outputNodeIds.length))) {
    return { kind: 'invalid' as const, issues: ['图片付费输入已冻结；先显式撤销计划并核对已有回执'], task: current };
  }
  const now = new Date().toISOString();
  const next: SocialImageCreationTask = {
    ...current, ...patch, id: current.id, version: current.version + 1, schemaVersion: 'social-image-creation.v2', contentMode: 'image',
    contentBrief: { ...current.contentBrief, ...(patch.contentBrief || {}) },
    creativeRecipe: { ...current.creativeRecipe, ...(patch.creativeRecipe || {}) },
    imageTextContract: { ...current.imageTextContract, ...(patch.imageTextContract || {}) },
    deliverySpec: { ...current.deliverySpec, ...(patch.deliverySpec || {}) },
    replicationRecipe: patch.replicationRecipe ? {
      ...patch.replicationRecipe,
      referenceLayerBlueprints: normalizeSocialImageReferenceLayerBlueprints(patch.replicationRecipe.referenceLayerBlueprints),
    } : current.replicationRecipe,
    enterpriseAssets: patch.enterpriseAssets || current.enterpriseAssets || [],
    generationJobs: patch.generationJobs || current.generationJobs || [],
    repairInstructions: patch.repairInstructions || current.repairInstructions || [],
    layerGraph: patch.layerGraph || current.layerGraph,
    updatedAt: now, publishable: false,
  };
  if (patch.status === 'approved') next.publishable = socialImageTaskCanPublish({ ...next, publishable: false, status: 'approved' });
  const issues = socialImageTaskIssues(next);
  if (issues.length && patch.status === 'approved') return { kind: 'invalid' as const, issues, task: next };
  const update = {
    title: next.title, status: next.status === 'approved' ? 'done' : 'draft',
    spec: { contentMode: 'image', creationPath: next.creationPath, socialImageTask: next }, updated_at: now,
  };
  const saved = store.compareAndSwap && row
    ? await store.compareAndSwap(SOCIAL_IMAGE_TASKS_COLLECTION, id, { tenant_id: tenantId, spec: row.spec }, update)
    : await store.update(SOCIAL_IMAGE_TASKS_COLLECTION, id, update);
  if (!saved && store.compareAndSwap) return { kind: 'conflict' as const, task: await readSocialImageTask(store, tenantId, id) || current };
  if (!saved) throw new Error('图片任务保存失败');
  return { kind: 'updated' as const, task: next };
}
