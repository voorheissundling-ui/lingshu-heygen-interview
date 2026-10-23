import type { MaterialScriptAnalysis } from '../../shared/materialScriptAnalysis';
import type { EffectPlanV1 } from '../../shared/contracts/effectPlan';
import type { EmphasisPlanV1 } from '../../shared/contracts/emphasisTimeline';
import type { ProductSceneKind } from '../../shared/contracts/productScenePreparation';

export interface HeyGenAvatarOption {
  id: string;
  name: string;
  gender?: string;
  ownership: 'private' | 'public';
  avatarType?: string;
  defaultVoiceId?: string;
  status?: string;
}

export type StudioGenerationProvenance = 'ai' | 'ai_rejected' | 'ai_failed' | 'template' | 'manual_draft';
export type StudioScriptQualityStatus =
  | 'passed' | 'passed_with_warnings' | 'warning' | 'needs_material'
  | 'unreviewed' | 'rejected'
  // Legacy statuses remain readable while old drafts/backends are in flight.
  | 'repaired' | 'recovered' | 'fallback' | 'failed';
export interface StudioScriptQualityChecks {
  materialGrounded?: boolean;
  timelineGrounded?: boolean;
  productGrounded?: boolean;
  dialogueFits?: boolean;
  structurallyComplete?: boolean;
  ctaComplete?: boolean;
  materialCoverage?: number | StudioScriptMaterialCoverage;
  materialCoveragePercent?: number;
  [key: string]: boolean | number | string | StudioScriptMaterialCoverage | undefined;
}
export interface StudioScriptMaterialCoverage {
  covered?: number;
  total?: number;
  selectedMaterials?: number;
  storyboardScenes?: number;
  boundScenes?: number;
  pendingScenes?: number;
  coverageRatio?: number;
  ratio?: number;
  percent?: number;
  percentage?: number;
  missing?: string[];
  missingShots?: string[];
}
export interface StudioScriptResult {
  ok?: boolean;
  script: string;
  source?: 'ai' | 'fallback' | 'local' | 'ai_failed' | 'ai_rejected' | string;
  provenance?: StudioGenerationProvenance | string;
  publishable?: boolean;
  qualityStatus?: StudioScriptQualityStatus;
  qualityChecks?: StudioScriptQualityChecks;
  validationWarnings?: string[];
  validationIssues?: string[];
  materialCoverage?: number | StudioScriptMaterialCoverage;
  missingMaterials?: string[];
  fallbackReason?: string;
  error?: string;
  code?: string;
  /** Enterprise records that ground this generation. */
  factReferences?: string[];
  /** Canonical multi-select product IDs accepted by the server. */
  selectedProductIds?: string[];
}
export interface StudioRenderJob {
  id: string; projectId: string; outputKey: string; inputSignature: string;
  status: 'queued' | 'processing' | 'completed' | 'failed'; progress: number; attempts: number;
  outputPath?: string; previewUrl?: string; error?: string; createdAt: string; updatedAt: string;
}

export interface StudioManualHandoff {
  id: string;
  action: 'team_review' | 'publishing_plan';
  status: 'pending_review' | 'planned';
  renderPath: string;
  createdAt: string;
  createdBy: string;
}

export interface SelectInput { materials: { id: string; name: string; type: string; duration: number }[]; duration: number }

// 字幕 cue：start/end 为相对成片起点的秒数；zh 为可选中文译文（双语字幕）
export interface SubCue { start: number; end: number; text: string; zh?: string; words?: Array<{ text: string; start: number; end: number }> }
export interface TtsStyleOptions {
  preset: 'tiktok_excited' | 'authentic_review' | 'professional_b2b' | 'warm_story' | 'urgent_cta';
  emotion: string;
  emotionIntensity: number;
  speed: number;
  targetDuration: number;
  pauseStyle: 'few' | 'natural' | 'dramatic';
  pronunciations: Array<{ word: string; pronunciation: string }>;
}
export interface TtsAudioResult {
  ok: boolean;
  source?: string;
  url?: string;
  duration?: number;
  error?: string;
  text?: string;
  adjusted?: boolean;
  targetDuration?: number;
  cues?: SubCue[];
  alignmentSource?: 'audio_ai' | 'proportional' | 'minimax_native' | 'synthesized_sentence_audio' | 'pending_alignment';
  customVoiceStatus?: 'activated';
}
export interface StudioAudioCapabilities {
  ok: boolean;
  customVoice: {
    upload: boolean;
    synthesis: boolean;
    engines: { minimax: boolean; xtts: boolean };
    message: string;
  };
  minimax?: {
    configured: boolean;
    baseUrl: string;
    model: string;
    diagnosticAvailable: boolean;
  };
  subtitles: {
    automatic: boolean;
    audioTranscription: boolean;
    wordAlignment: boolean;
    fallback: 'proportional' | 'provider_native_with_proportional_fallback';
  };
}
export interface SubtitleSpec {
  mode: 'off' | 'target' | 'bilingual';
  cues: SubCue[];
  style: Partial<CoverStyle> & { productNames?: string[]; autoEmphasis?: boolean; fontScale?: number; bottomRatio?: number; outlineColor?: string; outlineWidth?: number; lineWidth?: number };
}

export interface RenderSpec {
  materials: string[];
  timeline?: {
    sceneId?: string;
    clipId?: string;
    name: string;
    url?: string;
    type?: 'video' | 'image' | 'audio';
    poster?: string;
    trimStart?: number;
    trimEnd?: number;
    speed?: number;
    targetStart?: number;
    targetEnd?: number;
    targetDuration?: number;
    cropMode?: 'cover' | 'contain';
    focusX?: number;
    focusY?: number;
  }[];
  script: string;
  voice: string;
  bgm: string;
  bgmVol: number;
  voiceVol: number;
  coverId: string;
  coverTitle: string;
  ratio: string;
  duration: number;
  platform: string;
  language: string;
  voiceoverUrl?: string;
  coverUrl?: string;
  subtitles?: SubtitleSpec;       // 字幕轨（桌面端 ffmpeg 烧录）
  effectPlan?: EffectPlanV1;      // 版本化白名单特效计划
  emphasisPlan?: EmphasisPlanV1;  // 可选人工/Agent 校正；服务端缺省时自动生成
}

export interface RenderManifest {
  jobId: string;
  requireVisualAssets?: boolean;
  spec: { ratio: string; duration: number; platform: string; language: string; bgmVol: number; voiceVol: number };
  script: string;
  timeline: {
    index: number;
    sceneId?: string;
    clipId?: string;
    name: string;
    url: string | null;
    trimStart?: number;
    trimEnd?: number;
    speed?: number;
    targetStart?: number;
    targetEnd?: number;
    targetDuration?: number;
  }[];
  voiceover: { voice: string | null; url: string | null };
  cover: { id: string | null; title: string; url: string | null };
  bgm: { id: string | null; url: string | null };
  subtitles?: SubtitleSpec;
  effectPlan?: EffectPlanV1;
  emphasisPlan?: EmphasisPlanV1;
}

export interface RenderAuthorization {
  token: string | null;        // 短期签名令牌；离线兜底为 null
  expiresAt: string | null;
  manifest: RenderManifest;
}

/* 桌面客户端（Electron）注入的本机 ffmpeg 合成桥；纯网页里为 undefined */
export interface DesktopRenderBridge {
  available: boolean;
  render: (manifest: RenderManifest) => Promise<{ ok: boolean; outputPath?: string; error?: string }>;
  showItemInFolder?: (filePath: string) => Promise<{ ok: boolean; error?: string }>;
  onProgress: (cb: (pct: number) => void) => () => void; // 返回取消订阅函数
}

declare global {
  interface Window { desktopRender?: DesktopRenderBridge }
}


export interface StudioProject {
  id: string;
  title: string;
  status: 'draft' | 'ready_for_approval' | 'published' | 'template';
  spec: Record<string, unknown>;
  thumbSeed?: string;
  createdAt: string;
  updatedAt: string;
}

export interface VariationBatch {
  id: string;
  title: string;
  status: 'queued' | 'running' | 'review' | 'completed' | 'paused';
  estimatedCostCny: number;
  plan?: {
    platform?: string; ratio?: string; contentMode?: string; mode?: string; strategy?: string;
    duration?: number; maxItems?: number; dimensions?: Record<string, string[]>;
    productInfo?: string; productSelectMode?: string; selectedProductIds?: string[];
    audience?: string; sellingPoints?: string; tone?: string; language?: string; provider?: string;
  };
  items: { id: string; variables: Record<string, string>; status: string; qualityScore?: number; note?: string }[];
  createdAt: string;
  updatedAt: string;
}

export interface SeedanceVideoResult {
  ok: boolean;
  source?: string;
  id?: string;
  taskId?: string;
  title?: string;
  url?: string;
  poster?: string;
  duration?: number;
  model?: string;
  material?: Material;
  version?: VideoGenerationVersion;
  error?: string;
  createdAt?: string;
  quality?: StoryboardQualityResult;
  segments?: Array<Record<string, unknown>>;
  code?: string;
  segmentIndex?: number;
}

export interface StoryboardFirstFrameResult {
  ok: boolean;
  material?: Material;
  fingerprint?: string;
  promptVersion?: string;
  firstFrameQuality?: StoryboardQualityResult;
  identityNotice?: string;
  error?: string;
}

export interface FreeCreationHookFrameResult {
  ok: boolean;
  material?: Material;
  fingerprint?: string;
  estimatedCostCny?: number;
  reused?: boolean;
  error?: string;
  code?: string;
}

export interface StoryboardQualityResult {
  score?: number;
  passed: boolean;
  issues?: string[];
  strengths?: string[];
  recommendation?: string;
  checks: Record<string, unknown>;
  checkedAt: string;
  reportId?: string;
  status?: 'passed' | 'needs_review' | 'retry_first_frame' | 'retry_video' | 'needs_assets';
  reasonCodes?: string[];
  findings?: Array<{ key?: string; verdict?: string; note?: string; code: string; severity: 'hard_failure' | 'review'; evidenceFrames?: Array<{ seconds?: number; url?: string } | number | string>; action?: string; message: string }>;
  requiresHumanReview?: boolean;
  automatedPassed?: boolean;
}

export interface FbPosterBrief {
  headline: string;
  subheadline: string;
  originBadge: string;
  trustBadges: string[];
  sellingPoints: string[];
  process: string[];
  categories: { name: string; description: string }[];
  bottomBar: string[];
  cta: string;
}

export interface FbPosterResult {
  ok: boolean;
  source?: 'ai' | 'ai_rejected' | 'ai_failed';
  provenance?: StudioGenerationProvenance | string;
  qualityStatus?: 'passed' | 'needs_confirmation' | 'rejected' | 'failed' | 'unreviewed';
  publishable?: boolean;
  layoutModules?: {
    module: string;
    referencePattern: string;
    localAssetRole: string;
    replacementInstruction: string;
  }[];
  poster?: FbPosterBrief;
  caption: string;
  hashtags: string[];
  commentCta: string;
  dmOpening: string;
  fieldsToConfirm: string[];
  imagePrompt: string;
  error?: string;
}


export interface LeadContentPackageResult {
  ok: boolean;
  source?: 'ai' | 'ai_rejected' | 'ai_failed';
  provenance?: StudioGenerationProvenance | string;
  qualityStatus?: 'passed' | 'needs_confirmation' | 'rejected' | 'failed';
  publishable?: boolean;
  provider?: 'qwen' | 'gemini';
  strategySummary: string;
  referenceModulesUsed: Array<{ module: string; evidence: string; application: string }>;
  items: Array<{
    role: 'buyer_attention' | 'capability_explanation' | 'supplier_trust';
    title: string;
    objective: string;
    slides: Array<{ index: number; role: string; headline: string; body: string; assetRole: string }>;
    caption: string;
    hashtags: string[];
    cta: string;
    dmOpening: string;
    imagePrompt: string;
  }>;
  fieldsToConfirm: string[];
  error?: string;
}

export interface BgmTrack {
  id: string;
  name: string;
  mood: string;
  duration: number;
  url: string;
  recommended?: boolean;
  builtin?: boolean;
  scope?: 'shared' | 'tenant';
  uploadedBy?: string;
}

// 封面标题样式（同时驱动网页预览与服务端 SVG 生成）
export type CoverFont = 'sans' | 'impact' | 'serif' | 'rounded' | 'mono';
export interface CoverStyle {
  color: string;                        // 标题颜色 hex
  size: 'S' | 'M' | 'L';                // 字号档位
  position: 'top' | 'center' | 'bottom';// 垂直位置
  verticalPosition?: number;             // 标题中心纵坐标（0-100%），拖动时精确定位
  align: 'left' | 'center';             // 水平对齐
  font: CoverFont;                      // 字体（系统字体栈，预览与 SVG 一致）
  weight?: 'regular' | 'bold' | 'heavy';// 粗细档位（缺省 bold）
  fontFamily?: string;                  // 自定义导入字体的 family（覆盖 font 字体栈）
  artPreset?: 'clean' | 'outline' | 'highlight' | 'magazine' | 'neon' | 'sticker'; // 艺术字效果
}

export interface Material {
  transcript?: string;
  transcriptCues?: SubCue[];
  transcriptCuesProvenance?: string;
  transcriptSourceHash?: string;
  id: string;
  name: string;
  folder: string;
  type: 'video' | 'image' | 'audio';
  duration: number;
  width?: number;
  height?: number;
  aspectRatio?: number;
  size: string;
  file: string;
  url: string;
  poster?: string;
  scope?: 'shared' | 'own';
  usage?: 'editable' | 'reference_only';
  usageSummary?: import('../../shared/contracts/materialUsageTracking').MaterialUsageSummary;
  canManage?: boolean;
  sourceType?: string;
  /** Canonical generated-library metadata. Physical folders remain presentation metadata. */
  generation?: import('../../shared/contracts/generatedMaterial').GeneratedAssetGeneration;
  lineage?: import('../../shared/contracts/generatedMaterial').GeneratedAssetLineage;
  quality?: import('../../shared/contracts/generatedMaterial').GeneratedAssetQuality;
  reuse?: import('../../shared/contracts/generatedMaterial').GeneratedAssetReuse;
  rightsScope?: string;
  sourceCategory?: import('../../shared/materialTaxonomy').MaterialSourceCategory;
  sourceChannel?: string;
  primaryTheme?: import('../../shared/materialTaxonomy').MaterialTheme;
  themeTags?: import('../../shared/materialTaxonomy').MaterialTheme[];
  classificationStatus?: import('../../shared/materialTaxonomy').MaterialClassificationStatus;
  classificationEvidence?: string[];
  classificationSource?: 'model' | 'user';
  providerTaskId?: string;
  contentSha256?: string;
  sourceName?: string;
  sourceProvider?: string;
  sourceCreator?: string;
  sourceUrl?: string;
  licenseEvidence?: string;
  rightsStatus?: string;
  rightsEvidenceRef?: string;
  licenseName?: string;
  licenseUrl?: string;
  attributionText?: string;
  licenseEvidenceCapturedAt?: string;
  licenseEvidenceTextSha256?: string;
  importBatchId?: string;
  manifestSha256?: string;
  importedAt?: string;
  commercialUseApproved?: boolean;
  derivativesApproved?: boolean;
  rawLibraryUseApproved?: boolean;
  provenance?: Record<string, unknown>;
  materialV2?: import('../../shared/contracts/materialAssetV2').MaterialAssetV2Metadata | null;
  capabilityManifest?: import('../../shared/contracts/materialCapabilityManifest').MaterialCapabilityManifest;
  enterpriseCommon?: boolean;
  pinned?: boolean;
  industry?: string;
  shotFunction?: string;
  applicability?: string;
  tags?: string;
  productId?: string;
  productName?: string;
  productSceneType?: ProductSceneKind;
  segmentAnalysisStatus?: 'pending' | 'analyzing' | 'completed' | 'failed';
  segmentAnalysisError?: string;
  segments?: MaterialSegment[];
  visualObservations?: string[];
  scriptAnalysis?: MaterialScriptAnalysis;
  createdAt: string;
  libraryRemovedAt?: string;
}

export interface VideoGenerationVersion {
  id: string;
  groupKey: string;
  versionNumber: number;
  parentVersionId?: string;
  materialId?: string;
  taskId?: string;
  title: string;
  url?: string;
  poster?: string;
  duration: number;
  source: string;
  model?: string;
  promptSnapshot: { script: string; productInfo: string; language: string; ratio: string; resolution: string };
  context?: Record<string, unknown>;
  isSelected: boolean;
  createdAt: string;
}

export interface MaterialSegment {
  id: string;
  visualTopic?: string;
  expressionPurpose?: string;
  start: number;
  end: number;
  duration: number;
  poster?: string;
  subject: string[];
  action: string;
  productVisible: boolean;
  productClarity: 'none' | 'low' | 'medium' | 'high';
  shot: string;
  angle: string;
  composition: string;
  camera: string;
  environment: string;
  quality: number;
  ocrText: string;
  hasPerson: boolean;
  hasLogo: boolean;
  logoText: string[];
  recommendedFunctions: string[];
  authenticity: string;
  confidence: number;
  needsReview: boolean;
  manualConfirmed?: boolean;
}

