import {
  normalizeMaterialAssetV2,
  materialAssetV2FromRecord,
  type MaterialAssetV2Metadata,
} from './materialAssetV2.js';
import type { MaterialScriptAnalysis, MaterialScriptShot } from '../materialScriptAnalysis.js';

export const MATERIAL_CAPABILITY_MANIFEST_VERSION = 'material-capability-manifest.v1' as const;

export const MATERIAL_PRODUCTION_CAPABILITIES = [
  'semantic_search',
  'exact_product_reference',
  'style_reference',
  'image_generation_reference',
  'video_edit_source',
  'fact_evidence',
  'background_composite',
  'template_reuse',
] as const;
export type MaterialProductionCapability = typeof MATERIAL_PRODUCTION_CAPABILITIES[number];

export type MaterialCapabilityBlocker = {
  code: 'analysis_pending' | 'analysis_failed' | 'analysis_stale' | 'review_required'
    | 'rights_evidence_missing' | 'commercial_use_not_approved'
    | 'derivative_use_not_approved' | 'model_input_not_approved' | 'unsupported_media';
  message: string;
};

export interface MaterialCapabilityManifestSegment {
  segmentId: string;
  startSeconds: number;
  endSeconds: number;
  confidence: number;
  needsReview: boolean;
  materialRoles: string[];
  observedEvidence: string[];
  cleanEntry: boolean;
  cleanExit: boolean;
  boundaryConfidence: number;
}
/**
 * The one read model delivered by the material library to every Content Agent.
 * It joins visual analysis, product identity, rights and production admission;
 * consumers must not reconstruct those decisions from folders or filenames.
 */
export interface MaterialCapabilityManifest {
  schemaVersion: typeof MATERIAL_CAPABILITY_MANIFEST_VERSION;
  materialId: string;
  sourceRevision: string;
  analyzedAt: string | null;
  status: 'ready' | 'review_required' | 'blocked';
  blockers: MaterialCapabilityBlocker[];
  capabilities: MaterialProductionCapability[];
  media: {
    type: 'image' | 'video' | 'audio' | 'unknown';
    durationSeconds: number;
    width: number | null;
    height: number | null;
    aspectRatio: string | null;
  };
  identity: {
    productId: string | null;
    productRef: string | null;
    productName: string | null;
    level: MaterialAssetV2Metadata['productIdentityLevel'];
    enterpriseCommon: boolean;
    subjectRefs: string[];
  };
  classification: {
    assetRole: MaterialAssetV2Metadata['assetRole'];
    contentRole: MaterialAssetV2Metadata['contentRole'];
    sceneType: string | null;
    materialRoles: string[];
    themeTags: string[];
  };
  search: {
    summary: string;
    searchableText: string;
    subjects: string[];
    actions: string[];
    environments: string[];
    shotLanguage: string[];
    functions: string[];
  };
  quality: {
    analysisCompleted: boolean;
    confidence: number;
    needsReview: boolean;
    labelReadability: MaterialAssetV2Metadata['labelReadability'];
    occlusion: MaterialAssetV2Metadata['occlusion'];
    cleanPlate: boolean | null;
    templateEligible: boolean;
    reuseScore: number;
  };
  rights: {
    evidenceRefs: string[];
    commercialUseApproved: boolean;
    derivativeUseAllowed: boolean;
    modelInputAllowed: boolean;
  };
  segments: MaterialCapabilityManifestSegment[];
}

const object = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
);
const valueText = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const finite = (value: unknown, fallback = 0): number => Number.isFinite(Number(value)) ? Number(value) : fallback;
const strings = (value: unknown): string[] => Array.isArray(value)
  ? value.map(valueText).filter(Boolean)
  : valueText(value) ? [valueText(value)] : [];
const unique = (values: string[], limit = 80): string[] => [...new Set(values.filter(Boolean))].slice(0, limit);

function scriptAnalysisFromRecord(record: Record<string, unknown>): MaterialScriptAnalysis | null {
  const provenance = object(record.provenance);
  const candidate = record.scriptAnalysis ?? provenance?.materialScriptAnalysis;
  const row = object(candidate);
  return row?.schemaVersion === 'material-script-analysis.v3' && row.status === 'ready' && Array.isArray(row.shots)
    ? candidate as MaterialScriptAnalysis
    : null;
}

function explicitEnterpriseProductMetadata(record: Record<string, unknown>): MaterialAssetV2Metadata | null {
  const productId = valueText(record.productId ?? record.product_id);
  if (!productId || valueText(record.sourceType) !== 'enterprise_product_table') return null;
  return normalizeMaterialAssetV2({
    assetRole: 'exact_product',
    contentRole: 'product_front',
    productIdentityLevel: 'exact',
    enterpriseCommon: false,
    subjectRefs: [`product:${productId}`],
    cleanPlate: null,
    labelReadability: 'medium',
    templateEligible: false,
    reuseScore: .8,
    segmentCandidates: [],
  });
}

function fallbackMetadata(): MaterialAssetV2Metadata {
  return normalizeMaterialAssetV2({
    assetRole: 'supporting', contentRole: 'other', productIdentityLevel: 'none', enterpriseCommon: false,
    subjectRefs: [], cleanPlate: null, labelReadability: null, templateEligible: false, reuseScore: 0,
    segmentCandidates: [],
  });
}

function manifestSegments(shots: MaterialScriptShot[]): MaterialCapabilityManifestSegment[] {
  return shots.map(shot => ({
    segmentId: shot.segmentId,
    startSeconds: finite(shot.startSeconds),
    endSeconds: finite(shot.endSeconds),
    confidence: Math.max(0, Math.min(1, finite(shot.confidence))),
    needsReview: shot.needsReview === true,
    materialRoles: unique(strings(shot.materialRoles), 16),
    observedEvidence: unique(strings(shot.observedEvidence), 24),
    cleanEntry: shot.editorial?.trim?.cleanEntry === true,
    cleanExit: shot.editorial?.trim?.cleanExit === true,
    boundaryConfidence: Math.max(0, Math.min(1, finite(shot.editorial?.trim?.boundaryConfidence))),
  }));
}

export function buildMaterialCapabilityManifest(record: Record<string, unknown>): MaterialCapabilityManifest {
  const materialId = valueText(record.id);
  const provenance = object(record.provenance);
  const script = scriptAnalysisFromRecord(record);
  const metadata = materialAssetV2FromRecord(record) || explicitEnterpriseProductMetadata(record) || fallbackMetadata();
  const currentRevision = valueText(record.analysisSourceRevision ?? record.sourceRevision ?? record.contentSha256 ?? record.sha256);
  const sourceRevision = currentRevision || valueText(script?.sourceRevision) || `material:${materialId || 'unknown'}`;
  const analysisFailed = valueText(record.segmentAnalysisStatus) === 'failed';
  const explicitEnterpriseProduct = valueText(record.sourceType) === 'enterprise_product_table';
  const analysisCompleted = Boolean(script && (!currentRevision || script.sourceRevision === currentRevision)) || explicitEnterpriseProduct;
  const analysisStale = Boolean(script && currentRevision && script.sourceRevision !== currentRevision);
  const shots = script?.shots || [];
  const segments = manifestSegments(shots);
  const materialRoles = unique([
    ...segments.flatMap(segment => segment.materialRoles),
    ...strings(record.materialRoles),
  ], 24);
  const rightsEvidenceRefs = unique([
    ...strings(record.rightsEvidenceRefs),
    ...strings(record.commercialUseApprovalEvidenceRefs),
    valueText(record.rightsEvidenceRef), valueText(record.licenseEvidence), valueText(record.licenseUrl),
  ]);
  const commercialUseApproved = record.commercialUseApproved === true;
  const derivativeUseAllowed = record.derivativeUseAllowed === true || record.derivativesApproved === true;
  const modelInputAllowed = record.modelInputAllowed === true || record.rawLibraryUseApproved === true;
  const generatedQualityStatus = valueText(provenance?.qualityStatus);
  const generationReviewRequired = generatedQualityStatus === 'needs_review';
  const segmentReview = segments.some(segment => segment.needsReview);
  const type = ['image', 'video', 'audio'].includes(valueText(record.type))
    ? valueText(record.type) as 'image' | 'video' | 'audio'
    : 'unknown';
  const blockers: MaterialCapabilityBlocker[] = [];
  if (!['image', 'video'].includes(type)) blockers.push({ code: 'unsupported_media', message: '当前统一生产清单只接收图片和视频素材' });
  if (analysisFailed) blockers.push({ code: 'analysis_failed', message: valueText(record.segmentAnalysisError) || '编导分析失败，请重试' });
  else if (analysisStale) blockers.push({ code: 'analysis_stale', message: '素材文件已变化，需要重新分析当前版本' });
  else if (!analysisCompleted) blockers.push({ code: 'analysis_pending', message: '编导分析尚未形成统一生产清单' });
  if (segmentReview) blockers.push({ code: 'review_required', message: '部分镜头仍需人工复核' });
  if (generationReviewRequired) blockers.push({ code: 'review_required', message: 'AI 生成图片尚未完成人工外观与文字复核' });
  if (!rightsEvidenceRefs.length) blockers.push({ code: 'rights_evidence_missing', message: '缺少可追溯的素材授权证据' });
  if (!commercialUseApproved) blockers.push({ code: 'commercial_use_not_approved', message: '尚未确认可用于商业内容' });
  if (!derivativeUseAllowed) blockers.push({ code: 'derivative_use_not_approved', message: '尚未确认可剪辑或改编' });
  if (!modelInputAllowed) blockers.push({ code: 'model_input_not_approved', message: '尚未确认可作为生成模型输入' });

  const capabilities = new Set<MaterialProductionCapability>();
  if (analysisCompleted) capabilities.add('semantic_search');
  if (record.usage === 'reference_only' || valueText(record.folder) === 'hot') capabilities.add('style_reference');
  if (metadata.assetRole === 'exact_product' && valueText(record.productId ?? record.product_id)) capabilities.add('exact_product_reference');
  if (analysisCompleted && type === 'image' && commercialUseApproved && derivativeUseAllowed && modelInputAllowed && !generationReviewRequired) {
    capabilities.add('image_generation_reference');
  }
  if (analysisCompleted && type === 'video' && segments.length && commercialUseApproved && derivativeUseAllowed && rightsEvidenceRefs.length) {
    capabilities.add('video_edit_source');
  }
  if (metadata.assetRole === 'fact_evidence' && commercialUseApproved && rightsEvidenceRefs.length) capabilities.add('fact_evidence');
  if (metadata.assetRole === 'generic_scene_plate' && metadata.cleanPlate === true && derivativeUseAllowed && modelInputAllowed) capabilities.add('background_composite');
  if (metadata.templateEligible && derivativeUseAllowed && modelInputAllowed) capabilities.add('template_reuse');

  const hardBlocked = analysisFailed || analysisStale || !['image', 'video'].includes(type);
  const status = hardBlocked ? 'blocked'
    : blockers.length ? 'review_required'
      : 'ready';
  const confidenceValues = segments.map(segment => segment.confidence);
  const confidence = confidenceValues.length
    ? confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length
    : analysisCompleted ? metadata.reuseScore : 0;
  const index = script?.directorIndex;
  const aspectRatio = valueText(record.aspectRatio) || (finite(record.width) > 0 && finite(record.height) > 0
    ? `${finite(record.width)}:${finite(record.height)}` : null);

  return {
    schemaVersion: MATERIAL_CAPABILITY_MANIFEST_VERSION,
    materialId,
    sourceRevision,
    analyzedAt: valueText(script?.analyzedAt ?? record.updatedAt ?? record.createdAt) || null,
    status,
    blockers,
    capabilities: MATERIAL_PRODUCTION_CAPABILITIES.filter(capability => capabilities.has(capability)),
    media: {
      type,
      durationSeconds: Math.max(0, finite(record.duration)),
      width: finite(record.width) > 0 ? finite(record.width) : null,
      height: finite(record.height) > 0 ? finite(record.height) : null,
      aspectRatio,
    },
    identity: {
      productId: valueText(record.productId ?? record.product_id) || null,
      productRef: valueText(record.productRef) || null,
      productName: valueText(record.productName) || null,
      level: metadata.productIdentityLevel,
      enterpriseCommon: metadata.enterpriseCommon,
      subjectRefs: metadata.subjectRefs,
    },
    classification: {
      assetRole: metadata.assetRole,
      contentRole: metadata.contentRole,
      sceneType: metadata.sceneType,
      materialRoles,
      themeTags: unique(strings(record.themeTags), 20),
    },
    search: {
      summary: valueText(script?.summary) || [valueText(record.name), metadata.assetRole, metadata.contentRole].filter(Boolean).join(' · '),
      searchableText: valueText(script?.searchableText) || unique([
        valueText(record.name), valueText(record.tags), ...strings(record.visualObservations),
      ]).join(' '),
      subjects: unique(strings(index?.subjects), 30),
      actions: unique(strings(index?.actions), 30),
      environments: unique(strings(index?.environments), 20),
      shotLanguage: unique(strings(index?.shotLanguage), 20),
      functions: unique(strings(index?.functions ?? script?.functions), 20),
    },
    quality: {
      analysisCompleted,
      confidence: Number(confidence.toFixed(3)),
      needsReview: segmentReview || generationReviewRequired || status !== 'ready',
      labelReadability: metadata.labelReadability,
      occlusion: metadata.occlusion,
      cleanPlate: metadata.cleanPlate,
      templateEligible: metadata.templateEligible,
      reuseScore: metadata.reuseScore,
    },
    rights: { evidenceRefs: rightsEvidenceRefs, commercialUseApproved, derivativeUseAllowed, modelInputAllowed },
    segments,
  };
}
