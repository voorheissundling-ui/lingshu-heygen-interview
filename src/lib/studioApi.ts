/* 混剪工作台 AI 接口封装 */
import { readStudioHttpError } from './studioQuotaMessage';
import { authHeader } from './auth';
import type { DigitalHumanCapabilities, DigitalHumanJob, TransformationAssessment, TransformationAssessmentInput } from './studioDigitalHuman';
import { fetchMaterialLibrary, type MaterialLibraryPurpose } from './studioDigitalHuman';
import type { ProductSceneKind } from '../../shared/contracts/productScenePreparation';
import type { FbPosterRenderResult } from './studioPosterRenderContract';
export type { FbPosterRenderResult } from './studioPosterRenderContract';
import { studioMaterialFileMimeType } from './studioMaterialFile';
import { mergeStudioProjectWrite, studioProjectValueChanged, type StudioProjectMergeWrite } from './studioProjectMerge';

import { post } from './studioApiTransport';
import type { HeyGenAvatarOption, StudioGenerationProvenance, StudioScriptQualityStatus, StudioScriptQualityChecks, StudioScriptMaterialCoverage, StudioScriptResult, StudioRenderJob, StudioManualHandoff, SelectInput, SubCue, TtsStyleOptions, TtsAudioResult, StudioAudioCapabilities, SubtitleSpec, RenderSpec, RenderManifest, RenderAuthorization, DesktopRenderBridge, StudioProject, VariationBatch, SeedanceVideoResult, StoryboardFirstFrameResult, FreeCreationHookFrameResult, StoryboardQualityResult, FbPosterBrief, FbPosterResult, LeadContentPackageResult, BgmTrack, CoverFont, CoverStyle, Material, VideoGenerationVersion, MaterialSegment } from './studioApiContracts';
export type { HeyGenAvatarOption, StudioGenerationProvenance, StudioScriptQualityStatus, StudioScriptQualityChecks, StudioScriptMaterialCoverage, StudioScriptResult, StudioRenderJob, StudioManualHandoff, SelectInput, SubCue, TtsStyleOptions, TtsAudioResult, StudioAudioCapabilities, SubtitleSpec, RenderSpec, RenderManifest, RenderAuthorization, DesktopRenderBridge, StudioProject, VariationBatch, SeedanceVideoResult, StoryboardFirstFrameResult, FreeCreationHookFrameResult, StoryboardQualityResult, FbPosterBrief, FbPosterResult, LeadContentPackageResult, BgmTrack, CoverFont, CoverStyle, Material, VideoGenerationVersion, MaterialSegment } from './studioApiContracts';

async function get<T>(path: string, fallback: T): Promise<T & { source?: string }> {
  try {
    const r = await fetch(`/api/overseas/studio/${path}`, { headers: authHeader() });
    if (!r.ok) throw new Error(String(r.status));
    return (await r.json()) as T & { source?: string };
  } catch {
    return { ...fallback, source: 'local' };
  }
}

async function postSeedanceVideo(body: unknown): Promise<SeedanceVideoResult> {
  try {
    const r = await fetch('/api/overseas/studio/seedance-video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify(body),
    });
    if (r.status === 402 || r.status === 429) {
      throw new Error(await readStudioHttpError(r));
    }
    if (!r.ok) throw new Error(String(r.status));
    return (await r.json()) as SeedanceVideoResult;
  } catch (err: any) {
    if (String(err?.message || '').includes('Demo')) throw err;
    return { ok: false, source: 'seedance', error: String(err?.message || err || 'Seedance video request failed') };
  }
}

/** 取桌面端本机合成桥（仅 Electron 客户端有） */
export function getDesktopRender(): DesktopRenderBridge | undefined {
  return typeof window !== 'undefined' ? window.desktopRender : undefined;
}

const studioProjectRevisions = new Map<string, string>();
const studioProjectBaselines = new Map<string, StudioProject>();
const studioProjectSaveQueues = new Map<string, Promise<void>>();

type StudioProjectWrite = StudioProjectMergeWrite & { baseUpdatedAt?: string };
type StudioProjectSaveResult = {
  ok: boolean;
  project: StudioProject;
  error?: string;
  code?: string;
  conflicts?: string[];
  recovery?: 'merged' | 'reload_required';
  recoveredFromConflict?: boolean;
};

function detachedStudioProject(project: StudioProject): StudioProject {
  const { _baseUpdatedAt: _transportRevision, ...spec } = project.spec || {};
  return { ...project, spec: structuredClone(spec) };
}

function adoptStudioProject(project: StudioProject) {
  const baseline = detachedStudioProject(project);
  studioProjectRevisions.set(baseline.id, baseline.updatedAt);
  studioProjectBaselines.set(baseline.id, baseline);
}

function normalizedStudioProjectWrite(input: StudioProjectWrite): StudioProjectWrite {
  const { _baseUpdatedAt: _transportRevision, ...spec } = input.spec || {};
  return { ...input, spec };
}

function reloadRequiredProjectSave(
  project: StudioProject,
  conflicts: string[],
  code = 'studio_project_version_conflict',
): StudioProjectSaveResult {
  return {
    ok: false,
    project,
    code,
    conflicts,
    recovery: 'reload_required',
    error: '后台生产结果与本页同时修改了同一内容。系统未覆盖服务端更新，请重新载入最新版本后再修改。',
  };
}

async function del(path: string): Promise<{ ok: boolean; error?: string; code?: string }> {
  try {
    const r = await fetch(`/api/overseas/studio/${path}`, { method: 'DELETE', headers: authHeader() });
    const data = await r.json().catch(() => ({})) as { error?: string; code?: string };
    return { ok: r.ok, error: data.error, code: data.code };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '删除请求失败' };
  }
}

export const studioApi = {
  script: (b: {
    materials: string[];
    productInfo?: string;
    selectedProductId?: string;
    selectedProductIds?: string[];
    language: string;
    platform: string;
    duration: number;
    scriptType?: 'voiceover' | 'storyboard';
    generationMode?: 'material' | 'product' | 'clone';
    cooperationRoute?: string;
    voiceoverMode?: 'none' | 'ai' | 'upload';
    materialInfos?: Array<{ name: string; type: string; folder: string; duration: number; effectiveDuration?: number; role?: string; targetStart?: number; targetEnd?: number; industry?: string; shotFunction?: string; tags?: string; observations?: string[] }>;
    provider?: 'gemini' | 'qwen';
    audience?: string;
    sellingPoints?: string;
    tone?: string;
    videoTheme?: { id: string; title: string; painPoint: string; conversionGoal: string; primaryCta?: string; contentGoal?: 'reach' | 'leads' };
    referenceTitle?: string;
    referenceAnalysis?: string;
    referenceHighlights?: string[];
    existingScripts?: string[];
    variantSeed?: number;
  }, _fb: string, options?: { signal?: AbortSignal }) =>
    post<StudioScriptResult>('script', b, { script: '' }, options?.signal),

  covers: (b: { script?: string; productInfo?: string; language: string; provider?: 'gemini' | 'qwen'; tone?: string }, _fb: string[] = []) =>
    post<{ ok: boolean; source?: 'ai' | 'ai_rejected' | 'ai_failed'; provenance?: StudioGenerationProvenance | string; publishable?: boolean; covers: string[]; error?: string }>('covers', b, { ok: false, covers: [] }),

  caption: (b: {
    script?: string;
    productInfo?: string;
    platform: string;
    language: string;
    provider?: 'gemini' | 'qwen';
    audience?: string;
    sellingPoints?: string;
    tone?: string; referenceCaption?: string; brandName?: string; categoryTerms?: string[]; targetMarket?: string;
  }, _fb: { caption: string; hashtags: string[] } = { caption: '', hashtags: [] }) =>
    post<{ ok: boolean; source?: 'ai' | 'ai_rejected' | 'ai_failed'; provenance?: StudioGenerationProvenance | string; publishable?: boolean; caption: string; hashtags: string[]; fieldsToConfirm?: string[]; error?: string }>('caption', b, { ok: false, caption: '', hashtags: [] }),

  fbPoster: (b: {
    /** Legacy callers may still send mode; current UI selects a deliverable instead. */
    mode?: 'material' | 'clone' | 'product';
    deliverableType?: import('../../shared/imageCreativePlanning').ImageDeliverable;
    productionStrategy?: import('../../shared/imageCreativePlanning').ImageProductionStrategy;
    productInfo?: string;
    platform: string;
    ratio: string;
    posterStyle: string;
    language: string;
    provider?: 'gemini' | 'qwen';
    materials?: Array<{ id?: string; name: string; type?: string; folder?: string; role?: string }>;
    referenceNotes?: string; referenceCaption?: string; brandName?: string; categoryTerms?: string[]; targetMarket?: string;
    confirmedFields?: Record<string, string>;
  }) =>
    post<FbPosterResult>('fb-poster', b, { ok: false, caption: '', hashtags: [], commentCta: '', dmOpening: '', fieldsToConfirm: [], imagePrompt: '' }),

  leadContentPackage: (b: { productInfo: string; platform: string; language: string; ratio: string; referenceTitle: string; referenceEvidence: unknown }) =>
    post<LeadContentPackageResult>('lead-content-package', b, { ok: false, strategySummary: '', referenceModulesUsed: [], items: [], fieldsToConfirm: [], error: '获客内容包生成失败' }),

  fbPosterRender: (b: {
    poster: FbPosterBrief;
    caption?: string;
    imagePrompt?: string; imageQuality?: 'low' | 'medium' | 'high';
    ratio: string;
    materialIds?: string[];
    productIds?: string[];
    deliverableType?: import('../../shared/imageCreativePlanning').ImageDeliverable;
    productionStrategy?: import('../../shared/imageCreativePlanning').ImageProductionStrategy;
    referencePlan?: Array<{ materialId: string; role: 'exact_product' | 'style' | 'supporting' }>;    referenceImageUrls?: string[];
    idempotencyKey?: string;
    imageTaskId?: string;
    imageJobId?: string;
    confirmedFields?: Record<string, string>;
  }, options?: { signal?: AbortSignal }) =>
    post<FbPosterRenderResult>('fb-poster/render', b, { ok: false }, options?.signal),

  select: (b: SelectInput, _fb: string[]) =>
    post<{ ok: boolean; source?: 'ai' | 'ai_rejected' | 'ai_failed'; provenance?: StudioGenerationProvenance | string; publishable?: boolean; selectedIds: string[]; reason: string; error?: string }>('select', b, { ok: false, selectedIds: [], reason: '' }),

  speechNames: (b: { names: string[]; language: string }) => post<{ ok: boolean; names: Record<string,string>; error?: string }>('speech-names', b, { ok: false, names: {} }),
  // 配音 TTS
  tts: (b: { script?: string; text?: string; sentenceLines?: string[]; measuredSentenceTiming?: boolean; voice: string; language: string; style?: Partial<TtsStyleOptions> }) =>
    post<TtsAudioResult>('tts', b, { ok: false }),
  ttsBatch: (b: { voice: string; items: { code: string; text: string; language?: string; sentenceLines?: string[]; measuredSentenceTiming?: boolean }[]; style?: Partial<TtsStyleOptions> }) =>
    post<{ ok: boolean; audios: Record<string, TtsAudioResult>; error?: string }>('tts/batch', b, { ok: false, audios: {} }),
  alignTts: (b: { text: string; url: string; duration: number }) =>
    post<{ ok: boolean; cues: SubCue[]; source?: 'audio_ai' | 'proportional' | 'qwen_asr'; error?: string }>('tts/align', b, { ok: false, cues: [] }),
  qwenAsr: (b: { text?: string; url: string; duration: number; confirmed?: boolean }) =>
    post<{ ok: boolean; id?: string; taskId?: string; status?: string; text?: string; cues?: SubCue[]; matches?: boolean; source?: 'qwen_asr'; error?: string }>('tts/asr', b, { ok: false }),
  transcribeMaterial: (id: string) => post<{ ok: boolean; text?: string; error?: string }>(`materials/${encodeURIComponent(id)}/transcribe`, {}, { ok: false }),
  transcribeVoiceover: (b: { url: string; duration: number; language?: string; transcriptHint?: string }) =>
    post<{ ok: boolean; text: string; cues: SubCue[]; matches?: boolean; status?: string; source?: 'audio_ai' | 'proportional' | 'qwen_asr'; error?: string }>('tts/transcribe', b, { ok: false, text: '', cues: [] }),
  audioCapabilities: async () => {
    try {
      const r = await fetch('/api/overseas/studio/tts/capabilities', { headers: authHeader() });
      if (!r.ok) throw new Error(String(r.status));
      return await r.json() as StudioAudioCapabilities;
    } catch {
      return {
        ok: false,
        customVoice: { upload: true, synthesis: false, engines: { minimax: false, xtts: false }, message: '暂时无法读取真人音色引擎状态。' },
        subtitles: { automatic: true, audioTranscription: false, wordAlignment: false, fallback: 'proportional' },
      } as StudioAudioCapabilities;
    }
  },
  diagnoseMinimax: () =>
    post<{ ok: boolean; configured: boolean; latencyMs?: number; model?: string; clonedVoices?: number; message?: string; error?: string }>(
      'tts/minimax/diagnose', {}, { ok: false, configured: false, error: 'MiniMax 诊断请求失败' },
    ),
  uploadVoiceSample: (b: { name: string; dataBase64: string; mimeType?: string; duration?: number; replacesVoiceId?: string }) =>
    post<{ ok: boolean; id?: string; voiceId?: string; name?: string; url?: string; duration?: number; synthesisReady?: boolean; engine?: 'minimax' | 'xtts'; warning?: string; error?: string }>('voice-samples', b, { ok: false }),
  listVoiceSamples: async (): Promise<Array<{ voiceId: string; name: string; url: string; duration: number; createdAt: string }>> => {
    try {
      const r = await fetch('/api/overseas/studio/voice-samples', { headers: authHeader() });
      return r.ok ? await r.json() : [];
    } catch { return []; }
  },
  uploadVoiceover: (b: { name: string; dataBase64: string; mimeType?: string; duration?: number }) =>
    post<{ ok: boolean; url?: string; duration?: number; error?: string }>('voiceover', b, { ok: false }),
  productDocumentOcr: (b: { dataBase64: string; mimeType: string }) =>
    post<{ ok: boolean; text?: string; source?: 'local_tesseract'; needsReview?: true; code?: string; error?: string }>('product-document-ocr', b, { ok: false }),

  // 封面 SVG
  cover: (b: { title: string; ratio: string; accent: string; bgImageUrl?: string } & Partial<CoverStyle>) =>
    post<{ ok: boolean; url?: string }>('cover', b, { ok: false }),

  // 文本翻译（默认译成简体中文，供用户确认外语文案）
  translate: (b: { text: string; target?: string; source?: string }, options?: { signal?: AbortSignal }) =>
    post<{ ok: boolean; text: string; error?: string }>('translate', b, { ok: false, text: '' }, options?.signal),
  translateBatch: (b: { text: string; targets: string[]; source?: string }, options?: { signal?: AbortSignal }) =>
    post<{ ok: boolean; translations: Record<string, string>; error?: string }>('translate/batch', b, { ok: false, translations: {} }, options?.signal),

  // Seedance 视频生成
  freeCreationHookFirstFrame: (b: {
    projectId: string;
    requestId: string;
    productIds: string[];
    goal: string;
    audience: string;
    visualIntent: string;
    ratio?: '9:16' | '16:9' | '1:1';
  }) => post<FreeCreationHookFrameResult>('free-creation-hook/first-frame', b, { ok: false }),
  storyboardFirstFrame: (b: {
    projectId?: string;
    requestId: string;
    keyStates?: Array<{ afterBeat: number; description: string; source: 'confirmed_reference_analysis' | 'confirmed_storyboard' }>;
    shotId: string;
    mode: 'replication' | 'free_creation';
    shotDescription: string;
    startSeconds?: number;
    endSeconds?: number;
    layout?: Record<string, unknown>;
    action?: { startState?: string; beats?: string[]; endState?: string; cameraMotion?: string; forbiddenChanges?: string[]; evidence?: string };
    sourceFirstFrameUrl?: string;
    productId?: string;
    productIds?: string[];
    productImageUrl?: string;
    productName?: string;
    characterMaterialId?: string;
    environmentMaterialId?: string;
    sceneType: 'product' | 'factory' | 'usage' | 'general';
    ratio?: string;
  }) => post<StoryboardFirstFrameResult>('storyboard-first-frame', b, { ok: false }),
  storyboardProductMatch: (b: { projectId: string; shotId: string }) =>
    post<{ ok: boolean; productIds?: string[]; confidence?: number; reason?: string; source?: string; needsReview?: boolean; error?: string }>('storyboard-product-match', b, { ok: false }),
  confirmStoryboardFirstFrame: (id: string, b: { fingerprint: string; shotId: string }) =>
    post<StoryboardFirstFrameResult>(`storyboard-first-frame/${encodeURIComponent(id)}/confirm`, b, { ok: false }),
  seedanceVideo: (b: {
    requestId?: string;
    script: string;
    productInfo?: string;
    language: string;
    ratio?: string;
    duration?: number;
    resolution?: string;
    title?: string;
    referenceImageUrl?: string;
    firstFrameMaterialId?: string;
    firstFrameFingerprint?: string;
    shotId?: string;
    generationGroupKey?: string;
    generationContext?: Record<string, unknown>;
    parentVersionId?: string;
  }) =>
    postSeedanceVideo(b),
  storyboardActionVideo: (b: {
    requestId: string;
    firstFrameMaterialId: string;
    firstFrameFingerprint: string;
    shotId: string;
    ratio?: string;
    resolution: '480p' | '720p';
    title?: string;
    keyStates: Array<{ afterBeat: number; description: string; source: 'confirmed_reference_analysis' | 'confirmed_storyboard' }>;
    beatDurationsSeconds?: number[];
  }) => post<SeedanceVideoResult>('storyboard-action-video', b, { ok: false }),

  listVideoVersions: async (groupKey: string): Promise<VideoGenerationVersion[]> => {
    try {
      const r = await fetch(`/api/overseas/studio/video-versions?groupKey=${encodeURIComponent(groupKey)}`, { headers: authHeader() });
      return r.ok ? await r.json() as VideoGenerationVersion[] : [];
    } catch { return []; }
  },
  selectVideoVersion: async (id: string) => {
    try {
      const r = await fetch(`/api/overseas/studio/video-versions/${encodeURIComponent(id)}/select`, { method: 'PATCH', headers: authHeader() });
      return await r.json() as { ok: boolean; version?: VideoGenerationVersion };
    } catch { return { ok: false }; }
  },

  storyboardQualityCheck: (b: { materialId: string; storyboard: string; productInfo?: string; critical?: boolean }) =>
    post<{ ok: boolean; quality?: StoryboardQualityResult; error?: string }>('storyboard-quality-check', b, { ok: false }),
  reviewStoryboardQuality: (materialId: string, b: { shotId: string; reportId: string; decision: 'accept' | 'reject' }) =>
    post<{ ok: boolean; quality?: StoryboardQualityResult; error?: string }>(`storyboard-quality-check/${encodeURIComponent(materialId)}/review`, b, { ok: false }),

  // 数据看板 AI 结论
  insight: (b: { scope: string; metrics: Record<string, unknown> }) =>
    post<{ ok: boolean; source?: 'ai' | 'ai_rejected' | 'ai_failed'; provenance?: StudioGenerationProvenance | string; publishable?: boolean; summary: string; actions: string[]; error?: string }>('insight', b, { ok: false, summary: '', actions: [] }),

  // ⑥ 渲染授权：服务器下发原料 manifest + 短期令牌，合成交给客户端本机 ffmpeg
  render: async (spec: RenderSpec): Promise<RenderAuthorization & { source?: string }> => {
    try {
      const r = await fetch('/api/overseas/studio/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify(spec),
      });
      if (r.status === 402 || r.status === 429) {
        throw new Error(await readStudioHttpError(r));
      }
      if (!r.ok) throw new Error(String(r.status));
      return (await r.json()) as RenderAuthorization;
    } catch (err: any) {
      throw err instanceof Error ? err : new Error('渲染授权服务不可用，请稍后重试');
    }
  },

  renderLocal: async (manifest: RenderManifest, token: string | null): Promise<{ ok: boolean; outputPath?: string; previewUrl?: string; error?: string }> => {
    if (!token) return { ok: false, error: '缺少服务端签发的渲染授权，请重试' };
    try {
      const r = await fetch('/api/overseas/studio/render/local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ manifest, token }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data?.error || String(r.status));
      return data as { ok: boolean; outputPath?: string; previewUrl?: string; error?: string };
    } catch (err: any) {
      return { ok: false, error: err?.message || '本地 MP4 导出失败' };
    }
  },

  createRenderJob: async (body: { projectId: string; outputKey: string; inputSignature: string; spec: RenderSpec }): Promise<{ ok: boolean; replayed?: boolean; job?: StudioRenderJob; error?: string }> => {
    try {
      const r = await fetch('/api/overseas/studio/render/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeader() }, body: JSON.stringify(body) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data?.error || String(r.status));
      return data;
    } catch (err: any) { return { ok: false, error: err?.message || '渲染任务创建失败' }; }
  },
  latestRenderJob: async (projectId: string): Promise<{ ok: boolean; job: StudioRenderJob | null; error?: string }> => {
    try {
      const r = await fetch(`/api/overseas/studio/render/jobs/project/${encodeURIComponent(projectId)}/latest`, { headers: authHeader(), cache: 'no-store' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data?.error || String(r.status));
      return data;
    } catch (err: any) { return { ok: false, job: null, error: err?.message || '渲染任务查询失败' }; }
  },
  retryRenderJob: async (id: string): Promise<{ ok: boolean; job?: StudioRenderJob; error?: string }> => {
    try {
      const r = await fetch(`/api/overseas/studio/render/jobs/${encodeURIComponent(id)}/retry`, { method: 'POST', headers: authHeader() });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data?.error || String(r.status));
      return data;
    } catch (err: any) { return { ok: false, error: err?.message || '渲染任务重试失败' }; }
  },

  openRenderOutput: async (path: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const r = await fetch('/api/overseas/studio/render/open-output', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ path }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, error: data?.error || `打开本地文件夹失败（${r.status}）` };
      return data as { ok: boolean; error?: string };
    } catch (err: any) {
      return { ok: false, error: err?.message || '打开本地文件夹失败' };
    }
  },

  // 草稿 / 作品
  listProjects: async (options?: { throwOnError?: boolean }): Promise<StudioProject[]> => {
    try {
      const r = await fetch('/api/overseas/studio/projects', { headers: authHeader() });
      if (!r.ok) throw new Error(String(r.status));
      const data = await r.json();
      // Listing is passive. The editor adopts a snapshot only when it actually
      // loads that project, never merely because another surface refreshed.
      return Array.isArray(data) ? (data as StudioProject[]) : [];
    } catch (error) {
      if (options?.throwOnError) throw error;
      return [];
    }
  },
  getProject: async (id: string, workflow?: { runId?: string; taskId?: string }): Promise<StudioProject> => {
    const query = new URLSearchParams();
    if (workflow?.runId) query.set('workflowRunId', workflow.runId);
    if (workflow?.taskId) query.set('workflowTaskId', workflow.taskId);
    const suffix = query.size ? `?${query.toString()}` : '';
    const r = await fetch(`/api/overseas/studio/projects/${encodeURIComponent(id)}${suffix}`, { headers: authHeader(), cache: 'no-store' });
    const data = await r.json().catch(() => ({})) as StudioProject & { error?: string };
    if (!r.ok) throw new Error(data.error || String(r.status));
    if (!data.id || data.id !== id) throw new Error('项目读取身份不一致');
    // Reading can also be a status poll. Callers that replace editor state
    // explicitly adopt the returned project via adoptProjectRevision.
    return data;
  },
  adoptProjectRevision: (project: StudioProject) => {
    adoptStudioProject(project);
  },
  saveProject: async (raw: StudioProjectWrite): Promise<StudioProjectSaveResult & { source?: string }> => {
    const b = normalizedStudioProjectWrite(raw);
    // Capture the editor's actual comparison base now, before an earlier
    // queued write can advance the module-level revision and baseline.
    const invocationRevision = b.id ? b.baseUpdatedAt || studioProjectRevisions.get(b.id) : undefined;
    const knownBaseline = b.id ? studioProjectBaselines.get(b.id) : undefined;
    const invocationBaseline = knownBaseline && knownBaseline.updatedAt === invocationRevision
      ? detachedStudioProject(knownBaseline)
      : undefined;
    // Serialize each existing project across all save callers. Read its revision
    // after the previous write settles; independent projects can save in parallel.
    const previous = b.id ? studioProjectSaveQueues.get(b.id) : undefined;
    let release: (() => void) | undefined;
    const pending = b.id ? new Promise<void>(resolve => { release = resolve; }) : undefined;
    if (b.id && pending) studioProjectSaveQueues.set(b.id, pending);
    try {
      if (previous) await previous;
      let write = b;
      let writeBaseline = invocationBaseline;
      let baseUpdatedAt = invocationRevision;
      let recoveredFromConflict = false;
      const currentBaseline = b.id ? studioProjectBaselines.get(b.id) : undefined;

      // A remounted editor can outlive this module (Vite Fast Refresh) and, in
      // older callers, arrive without either an explicit revision or an adopted
      // baseline. Read the server snapshot and require the page to reload; never
      // send an unversioned full-spec POST merely to discover that it is stale.
      if (b.id && !baseUpdatedAt && !currentBaseline) {
        try {
          const remote = await studioApi.getProject(b.id);
          return reloadRequiredProjectSave(remote, ['<editor-baseline>'], 'studio_project_editor_baseline_missing');
        } catch {
          return {
            ok: false,
            project: null as unknown as StudioProject,
            code: 'studio_project_editor_baseline_unavailable',
            recovery: 'reload_required',
            error: '无法确认当前草稿版本，系统未发送自动保存。请重新载入项目后继续。',
          };
        }
      }

      // A full snapshot can wait behind another save. If that previous save
      // changed the authoritative project, merge this invocation against the
      // baseline it actually saw instead of relabelling stale bytes with the
      // newer revision and overwriting the first save.
      if (b.id && currentBaseline && currentBaseline.updatedAt !== invocationRevision) {
        if (!invocationBaseline) {
          return reloadRequiredProjectSave(currentBaseline, ['<editor-baseline>'], 'studio_project_editor_baseline_missing');
        }
        const queuedMerge = mergeStudioProjectWrite(invocationBaseline, write, currentBaseline);
        if (!queuedMerge.ok) {
          return reloadRequiredProjectSave(currentBaseline, queuedMerge.conflictPaths, 'studio_project_local_queue_conflict');
        }
        write = { ...queuedMerge.write, baseUpdatedAt: currentBaseline.updatedAt };
        writeBaseline = currentBaseline;
        baseUpdatedAt = currentBaseline.updatedAt;
        recoveredFromConflict = true;
      } else if (!writeBaseline && currentBaseline?.updatedAt === baseUpdatedAt) {
        writeBaseline = currentBaseline;
      }

      const result = await post<StudioProjectSaveResult>(
        'projects',
        { ...write, ...(baseUpdatedAt ? { baseUpdatedAt } : {}) },
        { ok: false, project: null as unknown as StudioProject },
      );
      if (result.ok && result.project?.id) {
        adoptStudioProject(result.project);
        return { ...result, ...(recoveredFromConflict ? { recoveredFromConflict: true, recovery: 'merged' as const } : {}) };
      }

      if (result.code !== 'studio_project_version_conflict' || !result.project?.id) return result;
      const remote = detachedStudioProject(result.project);
      if (!writeBaseline || writeBaseline.updatedAt !== baseUpdatedAt) {
        return reloadRequiredProjectSave(remote, ['<editor-baseline>']);
      }
      const merge = mergeStudioProjectWrite(writeBaseline, write, remote);
      if (!merge.ok) return reloadRequiredProjectSave(remote, merge.conflictPaths);

      const mergedWrite = normalizedStudioProjectWrite({ ...merge.write, baseUpdatedAt: remote.updatedAt });
      const remoteAlreadyContainsMerge = !studioProjectValueChanged(mergedWrite.spec, remote.spec)
        && mergedWrite.title === remote.title
        && mergedWrite.status === remote.status
        && mergedWrite.thumbSeed === remote.thumbSeed;
      if (remoteAlreadyContainsMerge) {
        adoptStudioProject(remote);
        return { ok: true, project: result.project, recovery: 'merged', recoveredFromConflict: true };
      }

      const retried = await post<StudioProjectSaveResult>(
        'projects',
        { ...mergedWrite, baseUpdatedAt: remote.updatedAt },
        { ok: false, project: null as unknown as StudioProject },
      );
      if (retried.ok && retried.project?.id) {
        adoptStudioProject(retried.project);
        return { ...retried, recovery: 'merged', recoveredFromConflict: true };
      }
      if (retried.code === 'studio_project_version_conflict' && retried.project?.id) {
        return reloadRequiredProjectSave(detachedStudioProject(retried.project), ['<second-concurrent-update>']);
      }
      return retried;
    } finally {
      if (b.id && studioProjectSaveQueues.get(b.id) === pending) studioProjectSaveQueues.delete(b.id);
      release?.();
    }
  },
  requalityProject: (projectId: string) => post<{
    ok: boolean; replayed?: boolean; error?: string; issues?: string[];
    record?: { id: string; inputFingerprint: string; generationProvenance: 'ai'; qualityStatus: 'passed'; publishable: true; createdAt: string; renderPath: string; report: { gateVersion: string; checks: Array<{ id: string; passed: true; detail: string }> } };
    project?: StudioProject;
  }>(`projects/${encodeURIComponent(projectId)}/requality`, {}, { ok: false }),
  deleteProject: async (id: string) => {
    const result = await del(`projects/${encodeURIComponent(id)}`);
    if (result.ok) {
      studioProjectRevisions.delete(id);
      studioProjectBaselines.delete(id);
      studioProjectSaveQueues.delete(id);
    }
    return result;
  },
  listManualHandoffs: (projectId: string) => get<{ ok: boolean; handoffs: StudioManualHandoff[] }>(
    `projects/${encodeURIComponent(projectId)}/manual-handoffs`, { ok: false, handoffs: [] }),
  createManualHandoff: (projectId: string, body: { action: StudioManualHandoff['action']; renderPath: string; reviewed: true }) =>
    post<{ ok: boolean; replayed?: boolean; handoff?: StudioManualHandoff; error?: string }>(
      `projects/${encodeURIComponent(projectId)}/manual-handoffs`, body, { ok: false }),
  createVariationBatch: (b: { title: string; templateProjectId?: string; duration: number; maxItems: number; dimensions: Record<string, string[]>; plan?: VariationBatch['plan'] }) =>
    post<{ ok: boolean; batch: VariationBatch }>('variation-batches', b, { ok: false, batch: null as unknown as VariationBatch }),
  listVariationBatches: async (): Promise<VariationBatch[]> => {
    try { const r = await fetch('/api/overseas/studio/variation-batches', { headers: authHeader() }); return r.ok ? await r.json() as VariationBatch[] : []; } catch { return []; }
  },
  updateVariationItem: async (batchId: string, itemId: string, body: { status: string; note?: string }) => {
    try {
      const r = await fetch(`/api/overseas/studio/variation-batches/${batchId}/items/${itemId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...authHeader() }, body: JSON.stringify(body) });
      return await r.json() as { ok: boolean; batch?: VariationBatch };
    } catch { return { ok: false }; }
  },

  // 素材库
  listMaterialLibrary: fetchMaterialLibrary,
  listMaterials: async (purpose: MaterialLibraryPurpose = 'library'): Promise<Material[]> => (await fetchMaterialLibrary(purpose)).items,
  uploadMaterial: (b: { name: string; folder?: string; type: 'video' | 'image' | 'audio'; duration?: number; width?: number; height?: number; dataBase64: string; mimeType?: string; sourceType?: string; productId?: string; productSceneType?: ProductSceneKind; rightsConfirmed?: boolean }) =>
    post<{ ok: boolean; material: Material }>('materials', b, { ok: false, material: null as unknown as Material }),
  uploadMaterialFile: async (
    file: File,
    metadata: {
      folder?: string;
      type: 'video' | 'image' | 'audio';
      duration?: number;
      width?: number;
      height?: number;
      sourceType?: string;
      productId?: string;
      productSceneType?: ProductSceneKind;
      rightsConfirmed?: boolean;
    },
  ): Promise<{ ok: boolean; material: Material; error?: string }> => {
    const maxBytes = 100 * 1024 * 1024;
    if (!file.size) return { ok: false, material: null as unknown as Material, error: '素材文件为空' };
    if (file.size > maxBytes) return { ok: false, material: null as unknown as Material, error: '单个素材不能超过 100 MB' };
    const mimeType = studioMaterialFileMimeType(file, metadata.type);
    if (!mimeType) return {
      ok: false,
      material: null as unknown as Material,
      error: `「${file.name}」的文件格式无法识别，请使用 MP4、MOV、WebM 或受支持的图片/音频格式`,
    };
    const query = new URLSearchParams({
      name: file.name,
      folder: metadata.folder || 'upload',
      type: metadata.type,
      duration: String(metadata.duration || 0),
      width: String(metadata.width || 0),
      height: String(metadata.height || 0),
      mimeType,
      sourceType: metadata.sourceType || '',
    });
    if (metadata.productId) query.set('productId', metadata.productId);
    if (metadata.productSceneType) query.set('productSceneType', metadata.productSceneType);
    if (metadata.rightsConfirmed) query.set('rightsConfirmed', '1');
    try {
      const response = await fetch(`/api/overseas/studio/materials/file?${query.toString()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', ...authHeader() },
        body: file,
      });
      const payload = await response.json().catch(() => ({})) as { ok?: boolean; material?: Material; error?: string };
      if (!response.ok || !payload.ok || !payload.material) {
        return { ok: false, material: null as unknown as Material, error: payload.error || `上传失败（HTTP ${response.status}）` };
      }
      return { ok: true, material: payload.material };
    } catch (error) {
      return {
        ok: false,
        material: null as unknown as Material,
        error: error instanceof Error ? error.message : '素材上传失败',
      };
    }
  },
  startMaterialAnalysis: (id: string, retry = false) => post<{ ok: boolean; status?: string; error?: string }>(`materials/${encodeURIComponent(id)}/analysis`, { retry }, { ok: false }),
  analyzeMaterialSegments: (id: string) =>
    post<{ ok: boolean; material?: Material; segments?: MaterialSegment[]; error?: string }>(`materials/${id}/analyze-segments`, {}, { ok: false, error: '片段分析失败' }),
  classifyMaterial: (id: string) =>
    post<{ ok: boolean; material?: Material; error?: string }>(`materials/${id}/classify`, {}, { ok: false, error: '智能分类失败' }),
  updateMaterialSegment: async (materialId: string, segmentId: string, patch: Partial<MaterialSegment>) => {
    try {
      const response = await fetch(`/api/overseas/studio/materials/${materialId}/segments/${segmentId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', ...authHeader() }, body: JSON.stringify(patch),
      });
      return await response.json() as { ok: boolean; material?: Material; segment?: MaterialSegment; error?: string };
    } catch { return { ok: false, error: '片段更新失败' }; }
  },
  materialProducts: () => get<{items:Array<{id:string;name:string}>}>('material-products', {items:[]}),
  reviewGeneratedImage: async (id: string): Promise<{ ok: boolean; material?: Material; error?: string }> => {
    try {
      const response = await fetch(`/api/overseas/studio/materials/${encodeURIComponent(id)}/generated-image-review`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', ...authHeader() }, body: JSON.stringify({ accepted: true }),
      });
      return await response.json();
    } catch { return { ok: false, error: '图片复核结果保存失败' }; }
  },
  updateMaterial: async (id: string, changes: { name?: string; tags?: string; productId?: string; productSceneType?: ProductSceneKind; enterpriseCommon?: boolean; materialV2?: Partial<import('../../shared/contracts/materialAssetV2').MaterialAssetV2Metadata>; primaryTheme?: import('../../shared/materialTaxonomy').MaterialTheme }): Promise<{ ok: boolean; material?: Material; error?: string }> => {
    try {
      const response = await fetch(`/api/overseas/studio/materials/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify(changes),
      });
      return await response.json();
    } catch {
      return { ok: false, error: '素材编辑失败' };
    }
  },
  setMaterialPinned: async (id: string, pinned: boolean): Promise<{ ok: boolean; material?: Partial<Material>; error?: string }> => {
    try {
      const response = await fetch(`/api/overseas/studio/materials/${encodeURIComponent(id)}/pin`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ pinned }),
      });
      const payload = await response.json().catch(() => ({})) as { ok?: boolean; material?: Partial<Material>; error?: string };
      return response.ok && payload.ok ? { ok: true, material: payload.material } : { ok: false, error: payload.error || '收藏状态保存失败' };
    } catch {
      return { ok: false, error: '收藏状态保存失败' };
    }
  },
  deleteMaterial: async (id: string): Promise<{ ok: boolean; error?: string; retainedForProjectReferences?: boolean }> => {
    try {
      const response = await fetch(`/api/overseas/studio/materials/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: authHeader(),
      });
      const payload = await response.json().catch(() => ({})) as { ok?: boolean; error?: string; retainedForProjectReferences?: boolean };
      return response.ok && payload.ok
        ? { ok: true, retainedForProjectReferences: payload.retainedForProjectReferences === true }
        : { ok: false, error: payload.error || `素材删除失败（HTTP ${response.status}）` };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '素材删除失败' };
    }
  },

  digitalHumanAvatars: () => get<{ items: HeyGenAvatarOption[] }>('digital-human/avatars', { items: [] }),
  approveDigitalHumanJob: (id: string) => post<{ ok: boolean; job?: DigitalHumanJob }>(`digital-human/jobs/${encodeURIComponent(id)}/approve`, { reviewed: true }, { ok: false }),
  digitalHumanCapabilities: () => get<DigitalHumanCapabilities>('digital-human/capabilities', {
    available: false, provider: 'unconfigured', modes: [{ id: 'fast', label: '极速模式' }, { id: 'quality', label: '高质量模式' }],
    output: { ratio: '9:16', container: 'mp4' }, qualityGateRequired: true, maxConcurrentJobs: 2,
    unavailableReason: '无法连接数字人服务',
  }),
  createDigitalHumanJob: (body: { projectId?: string; avatarMaterialId?: string; heygenAvatarId?: string; voiceoverUrl: string; script: string; language: string; mode: 'fast' | 'quality'; consentConfirmed: boolean }) =>
    post<{ ok: boolean; job?: DigitalHumanJob; error?: string; code?: string }>('digital-human/jobs', body, { ok: false, error: '数字人任务提交失败' }),
  getDigitalHumanJob: (id: string) =>
    get<{ ok: boolean; job?: DigitalHumanJob; outputMaterial?: Material; error?: string }>(`digital-human/jobs/${encodeURIComponent(id)}`, { ok: false, error: '数字人任务查询失败' }),
  listDigitalHumanJobs: async (projectId?: string): Promise<DigitalHumanJob[]> => {
    try {
      const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
      const response = await fetch(`/api/overseas/studio/digital-human/jobs${query}`, { headers: authHeader(), cache: 'no-store' });
      if (!response.ok) return [];
      const payload = await response.json();
      return Array.isArray(payload) ? payload as DigitalHumanJob[] : [];
    } catch { return []; }
  },
  retryDigitalHumanJob: (id: string) =>
    post<{ ok: boolean; job?: DigitalHumanJob; error?: string }>(`digital-human/jobs/${encodeURIComponent(id)}/retry`, {}, { ok: false, error: '数字人任务重试失败' }),
  cancelDigitalHumanJob: (id: string) =>
    post<{ ok: boolean; job?: DigitalHumanJob; error?: string }>(`digital-human/jobs/${encodeURIComponent(id)}/cancel`, {}, { ok: false, error: '数字人任务取消失败' }),
  assessTransformation: (body: TransformationAssessmentInput) =>
    post<{ ok: boolean; assessment?: TransformationAssessment; error?: string }>('transformations/assess', body, { ok: false, error: '替换兼容性评估失败' }),

  // BGM 曲库
  listBgm: async (): Promise<BgmTrack[]> => {
    try {
      const r = await fetch('/api/overseas/studio/bgm', { headers: authHeader() });
      if (!r.ok) throw new Error(String(r.status));
      const data = await r.json();
      return Array.isArray(data) ? (data as BgmTrack[]) : [];
    } catch {
      return [];
    }
  },
  uploadBgm: (b: { name: string; mood?: string; duration?: number; dataBase64: string; mimeType?: string }) =>
    post<{ ok: boolean; track: BgmTrack }>('bgm', b, { ok: false, track: null as unknown as BgmTrack }),
  deleteBgm: (id: string) => del(`bgm/${id}`),
};

export { ensureMaterialAnalysis, fetchMaterialLibrary, getMaterialLibraryState } from './studioDigitalHuman';
export type { DigitalHumanCapabilities, DigitalHumanJob, DigitalHumanQualityReport, MaterialLibraryState, TransformationAssessment, TransformationAssessmentInput, TransformationMode } from './studioDigitalHuman';
