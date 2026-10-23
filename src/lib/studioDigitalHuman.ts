import { authHeader } from './auth';
import { studioApi, type Material } from './studioApi';
import type { MaterialSourceCategory, MaterialTheme } from '../../shared/materialTaxonomy';
import type { ProductScenePreparationReadModel } from '../../shared/contracts/productScenePreparation';

export interface DigitalHumanCapabilities {
  available: boolean;
  provider: string;
  features?: Array<'lip_sync' | 'expression' | 'head_motion' | 'source_motion' | 'neck_shoulder_preservation'>;
  modes: Array<{ id: 'fast' | 'quality'; label: string }>;
  output: { ratio: '9:16'; container: 'mp4' };
  qualityGateRequired: boolean;
  maxConcurrentJobs: number;
  unavailableReason?: string;
}

export interface DigitalHumanQualityReport {
  passed: boolean;
  lipSyncScore?: number;
  avOffsetFrames?: number;
  identityScore?: number;
  freezeSegments?: number;
  durationSeconds?: number;
  faceDetectionRate?: number;
  mouthJumpP95?: number;
  gateVersion?: string;
  gateFailures?: string[];
  notes?: string[];
}

export type TransformationMode = 'talking_avatar' | 'face_swap' | 'head_swap' | 'person_replace' | 'product_replace' | 'structure_remake';
export interface TransformationAssessmentInput {
  mode: TransformationMode;
  rights: {
    referenceVideo: 'cleared' | 'unknown' | 'not_required';
    sourcePerson: 'cleared' | 'unknown' | 'not_required';
    targetPerson: 'cleared' | 'unknown' | 'not_required';
    voice: 'cleared' | 'unknown' | 'not_required';
    productBrand: 'cleared' | 'unknown' | 'not_required';
  };
  source: {
    personCount?: number; continuousShot?: boolean; durationSeconds?: number; faceForwardRatio?: number;
    maximumOcclusionRatio?: number; productVisibleRatio?: number; productCount?: number;
    productCategory?: string; targetProductCategory?: string; gripSimilarity?: number; transparentOrReflective?: boolean;
  };
}
export interface TransformationAssessment {
  status: 'compatible' | 'review' | 'blocked';
  blockers: string[];
  warnings: string[];
  requiredQa: string[];
  recommendedMode: TransformationMode;
}

export interface DigitalHumanJob {
  voiceoverUrl: string;
  subtitleCues?: Array<{ start: number; end: number; text: string }>;
  id: string;
  projectId?: string;
  avatarMaterialId: string;
  avatarName: string;
  scriptSnapshot: string;
  language: string;
  mode: 'fast' | 'quality';
  provider: string;
  status: 'queued' | 'submitting' | 'processing' | 'quality_check' | 'review' | 'completed' | 'failed' | 'cancelled';
  stage: string;
  progress: number;
  outputMaterialId?: string;
  outputUrl?: string;
  qualityReport?: DigitalHumanQualityReport;
  errorCode?: string;
  errorMessage?: string;
  versionNumber: number;
  parentJobId?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export type MaterialLibraryPurpose = 'library' | 'reference' | 'all';
export type MaterialLibraryFacets = { sources: Record<MaterialSourceCategory, number>; themes: Record<MaterialTheme, number> };
export type MaterialLibraryQuery = {
  sourceCategory?: MaterialSourceCategory;
  theme?: MaterialTheme;
  query?: string;
  productId?: string;
  excludeProductAssociated?: boolean;
  page?: number;
  pageSize?: number;
};
export type MaterialLibraryState = { items?: Material[]; status: 'ready' | 'partial' | 'unavailable'; sources: Array<{ source: string; state: string; message: string }>; total?: number; page?: number; pageSize?: number; facets?: MaterialLibraryFacets; productSceneSlots?: ProductScenePreparationReadModel[] };
let latestMaterialLibraryState: MaterialLibraryState | null = null;
export const getMaterialLibraryState = () => latestMaterialLibraryState;
function publishMaterialLibraryState(state: MaterialLibraryState) { latestMaterialLibraryState = state; window.dispatchEvent(new CustomEvent('lingshu:material-library-status', { detail: state })); }
export async function fetchMaterialLibrary(purpose: MaterialLibraryPurpose = 'library', filters: MaterialLibraryQuery = {}): Promise<MaterialLibraryState & { items: Material[] }> {
  try {
    const query = new URLSearchParams({ envelope: '1', purpose });
    if (filters.sourceCategory) query.set('sourceCategory', filters.sourceCategory);
    if (filters.theme) query.set('theme', filters.theme);
    if (filters.query) query.set('query', filters.query);
    if (filters.productId) query.set('productId', filters.productId);
    if (filters.excludeProductAssociated) query.set('excludeProductAssociated', '1');
    if (filters.page) query.set('page', String(filters.page));
    if (filters.pageSize) query.set('pageSize', String(filters.pageSize));
    const response = await fetch(`/api/overseas/studio/materials?${query.toString()}`, { headers: authHeader(), cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (response.status === 401) throw Error('登录已失效，请重新登录后读取素材');
    const data = await response.json();
    if (!response.ok || !Array.isArray(data.items)) throw Error(data.error || '素材库暂时无法读取，请重试');
    const state = { ...data, productSceneSlots: Array.isArray(data.productSceneSlots) ? data.productSceneSlots : [] } as MaterialLibraryState & { items: Material[] };
    publishMaterialLibraryState(state);
    return state;
  } catch (error) {
    const message = error instanceof Error ? error.message : '素材库读取失败';
    publishMaterialLibraryState({ status: 'unavailable', sources: [{ source: 'server', state: 'unavailable', message: /timeout|abort|fetch|network/i.test(message) ? '素材库连接中断或超时，请重试' : message }] });
    throw error;
  }
}

/** Wait only for explicitly selected assets; server deduplicates repeated requests. */
export async function ensureMaterialAnalysis(ids: string[], isCurrent: () => boolean, progress: (message: string) => void): Promise<Material[]> {
  for (const id of [...new Set(ids)]) {
    if (!isCurrent()) throw Error('本次生成已取消');
    const result = await studioApi.startMaterialAnalysis(id);
    if (!result.ok) throw Error(result.error || '素材分析无法启动');
  }
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    if (!isCurrent()) throw Error('本次生成已取消');
    const inventory = await fetchMaterialLibrary();
    const records = ids.map(id => inventory.items.find(item => item.id === id));
    if (records.some(item => !item)) throw Error('所选素材暂不可读取，请检查素材库连接');
    const failed = records.find(item => item?.segmentAnalysisStatus === 'failed');
    if (failed) throw Error(`「${failed.name}」分析失败：${failed.segmentAnalysisError || '请在素材库重试分析'}`);
    const completed = records.filter(item => item?.segmentAnalysisStatus === 'completed').length;
    progress(`正在分析所选素材 ${completed}/${ids.length}，完成后生成分镜…`);
    if (completed === ids.length) {
      const unconfirmed = records.find(item => item?.type === 'video' && !item.segments?.some(segment => !segment.needsReview && Number(segment.confidence) >= .65));
      if (unconfirmed) throw Error(`「${unconfirmed.name}」暂没有可信的可用片段，请在素材库查看分析结果并复核`);
      return records as Material[];
    }
    await new Promise(resolve => window.setTimeout(resolve, 3000));
  }
  throw Error('素材分析仍在后台进行，请稍后从素材库查看进度，再继续生成');
}
