export type Platform = 'tiktok' | 'instagram' | 'youtube' | 'facebook' | 'linkedin';
export type VideoStatus = 'pending' | 'analyzed' | 'failed';
export type ScriptType = 'voiceover' | 'storyboard';
export type ScriptStatus = 'draft' | 'reviewed' | 'published';
export type AssetType = 'image' | 'video';
export type AssetStatus = 'generating' | 'done' | 'failed';
export type TrendStatus = 'pending' | 'selected';

export interface VideoGlobalSettings {
  visualStyle?: string;
  aspectRatio?: string;
  lighting?: string;
  subtitlePolicy?: string;
  audioPolicy?: string;
  identityConsistency?: string;
  productConsistency?: string;
  negativeConstraints?: string[];
}

export interface VideoSpatialContinuity {
  scene?: string;
  subjectAnchors?: Array<{
    subject?: string;
    position?: string;
    facing?: string;
    gazeTarget?: string;
    orientation?: string;
  }>;
  background?: string;
  backgroundPriority?: 'low' | 'medium' | 'high';
  depthOfField?: 'shallow' | 'moderate' | 'deep';
}

export interface VideoAiAnalysis {
  theme: string;
  /** Container clock measured from the exact source bytes used by this analysis. */
  sourceMediaClock?: {
    schemaVersion: 1;
    duration: number;
    fps: number | null;
    sourceSha256: string;
    analysisRunId: string;
    videoObjectKey?: string;
    measuredAt: string;
  };
  /** Raw ASR remains available for review; coarse chunks are never treated as shot dialogue. */
  audioTranscript?: { text: string; words?: import('../lib/referenceWordAlignment.js').ReferenceTimedWord[];
    segments: Array<{ start: number; end: number; text: string; words?: import('../lib/referenceWordAlignment.js').ReferenceTimedWord[];
      timingPrecision: 'phrase' | 'coarse'; provenance?: string; needsReview?: boolean }>; [key: string]: unknown };
  speechAlignmentSummary?: { schemaVersion: 1; acceptedWordCount: number; invalidWordCount: number;
    unassignedWordIds: string[]; clippedShotIds: string[]; limitations: string[]; fps: number | null };
  criticalShotSummary?: import('../lib/referenceCriticalShots.js').ReferenceCriticalShotSummary;
  /** Names explicitly visible/audible in the reference; never inferred. */
  identityEntities?: Array<{
    type: 'company' | 'brand' | 'product';
    text: string;
    evidence?: string;
    confidence?: number;
  }>;
  hooks: string[];
  sellingPoints: string[];
  mood: string;
  structure: string;
  baseRequirements?: string;
  globalSettings?: VideoGlobalSettings;
  spatialContinuity?: VideoSpatialContinuity;
  firstTenSeconds?: {
    atmosphere?: string;
    audioVisual?: string;
    camera?: string;
    visuals?: string;
    voiceMusic?: string;
  };
  coarseStructure?: Array<{
    time?: string;
    frame?: string;
    label?: string;
    description?: string;
  }>;
  scriptSummary15s?: {
    visualStyle?: string;
    coreEmotion?: string;
    competitors?: string[];
  };
  presenterContinuitySummary?: Record<string, unknown>;
  referenceProductionRoutingSummary?: Record<string, unknown>;
  referenceProductionRoutingError?: string;
  scriptDetails15s?: Array<{
    materialType?: import('../../shared/benchmarkAnalysis.js').BenchmarkMaterialType;
    narrativeRole?: import('../../shared/benchmarkAnalysis.js').BenchmarkShotRole;
    classificationEvidence?: string;
    time?: string;
    timestamp?: string;
    environment?: string;
    shot?: string;
    camera?: string;
    angle?: string;
    composition?: string;
    visual?: string;
    /** Stable source-person ID shared by shots of the same visible person; empty when unverified. */
    personContinuityId?: string;
    presenterContinuityEvidence?: import('../lib/referencePresenterContinuity.js').PresenterContinuityEvidence;
    referenceProductionRouting?: import('../../shared/referenceShotProductionRouting.js').ReferenceShotProductionRouting;
    observedPresenterRole?: 'sales_presenter' | 'presenter_action' | 'background' | 'none' | 'unknown';
    subtitle?: string;
    audio?: string;
    note?: string;
    purpose?: string;
    dialogue?: string;
    /** Confirmed off-screen narration; unknown remains absent, separate from on-screen speech. */
    voiceover?: string;
    onScreenText?: string;
    ambientSound?: string;
    bgm?: string;
    soundEffects?: string[];
    beats?: Array<{ time?: string; originalTime?: string; action?: string; dialogue?: string; onScreenText?: string;
      speechAlignment?: import('../lib/referenceWordAlignment.js').ReferenceWordSpeechAlignment;
      speechSyncStatus?: 'candidate' | 'insufficient_evidence' }>;
    speechAlignment?: import('../lib/referenceWordAlignment.js').ReferenceWordSpeechAlignment;
    criticalShot?: import('../lib/referenceCriticalShots.js').ReferenceCriticalShot;
    originalTime?: string;
    timelineCorrection?: string;
    /** Frame-derived performance category; walking narration must not collapse into standing narration. */
    motionClass?: '走播' | '站播' | '坐播' | '其他' | string;
    /** Time-ordered subject translation observed across sampled frames. */
    bodyMovement?: string;
    /** Camera translation/pan/track observed independently from subject motion. */
    cameraMovement?: string;
    /** Frame-derived speed changes, especially a fast opening hook followed by slower narration. */
    tempoPhases?: Array<{ time?: string; tempo?: '快速冲击' | '中速' | '慢速稳定' | string; action?: string }>;
    persistentState?: string;
    startState?: string;
    endState?: string;
    transitionToNext?: string;
    backgroundPriority?: 'low' | 'medium' | 'high';
    depthOfField?: 'shallow' | 'moderate' | 'deep';
    authenticity?: string;
    observedFacts?: string;
    inferredIntent?: string;
    causalGap?: string;
    omniPrompt?: string;
    omniNegativePrompt?: string;
    confidence?: number;
    needsReview?: boolean;
    estimatedSpeechDuration?: number;
    dialogueFits?: boolean;
    /** Independently sampled, time ordered evidence for the opening action hook. */
    hookMotionEvidence?: {
      observations: Array<{ time: number; visibleState: string; confidence: number }>;
      transitions: Array<{ from: number; to: number; action: string; evidence: string; confidence: number }>;
      uncertainties: string[];
      status?: 'verified' | 'needs_review';
    };
    /**
     * 该镜头的爆款潜力判断，由模型基于实际画面给出。
     * 缺失时前端回退到关键词启发式（历史记录没有这个字段）。
     */
    viralPotential?: {
      score?: number;
      mechanisms?: string[];
      whyEffective?: string;
    };
  }>;
  recommendedScriptType: 'voiceover' | 'storyboard';
}

export interface VoiceoverContent {
  hook: string;
  body: string[];
  cta: string;
  duration: string;
  hashtags: string[];
}

export interface StoryboardScene {
  index: number;
  duration: number;
  shot: string;
  camera: string;
  action: string;
  voiceover: string;
  caption: string;
  startTime?: number;
  endTime?: number;
  angle?: string;
  composition?: string;
  purpose?: string;
  startState?: string;
  endState?: string;
  transitionToNext?: string;
  lighting?: string;
  backgroundPriority?: 'low' | 'medium' | 'high';
  depthOfField?: 'shallow' | 'moderate' | 'deep';
  estimatedSpeechDuration?: number;
  dialogueFits?: boolean;
  ambientSound?: string;
  bgm?: string;
  soundEffects?: string[];
  generationPrompt?: string;
  negativePrompt?: string;
}

export interface StoryboardContent {
  scenes: StoryboardScene[];
  globalSettings?: VideoGlobalSettings;
  spatialContinuity?: VideoSpatialContinuity;
  totalDuration?: number;
  continuitySummary?: string;
  emotionArc?: string[];
}

export type ScriptContent = VoiceoverContent | StoryboardContent;

export const SUPPORTED_LANGUAGES = [
  'en', 'zh', 'es', 'ar', 'fr', 'de', 'pt', 'ru', 'ja', 'ko',
  'it', 'nl', 'pl', 'tr', 'vi', 'th', 'id', 'ms', 'hi', 'bn',
  'fa', 'uk', 'ro', 'sv', 'da', 'fi',
] as const;

export type Language = (typeof SUPPORTED_LANGUAGES)[number];

export const LANGUAGE_NAMES: Record<Language, string> = {
  en: 'English', zh: '中文', es: 'Español', ar: 'العربية', fr: 'Français',
  de: 'Deutsch', pt: 'Português', ru: 'Русский', ja: '日本語', ko: '한국어',
  it: 'Italiano', nl: 'Nederlands', pl: 'Polski', tr: 'Türkçe', vi: 'Tiếng Việt',
  th: 'ภาษาไทย', id: 'Bahasa Indonesia', ms: 'Bahasa Melayu', hi: 'हिन्दी',
  bn: 'বাংলা', fa: 'فارسی', uk: 'Українська', ro: 'Română', sv: 'Svenska',
  da: 'Dansk', fi: 'Suomi',
};
