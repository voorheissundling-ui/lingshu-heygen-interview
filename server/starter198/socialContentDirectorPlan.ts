import {assertSocialAccountProductionConstraints,type SocialAccountProductionConstraints} from './socialAccountProductionConstraints.js';
import {validContentTemplateStructure} from '../../shared/socialContentTemplateStructure.js';
import type {
  SocialContentThemeId,
  SocialDirectorPlanSummary,
} from '../../shared/contracts/socialContentWorkflow.js';
import type { InternalSocialContentFormula } from './socialContentThemes.js';
import type { SocialProductionAsset, SocialProductionPlan } from './socialContentProductionPlan.js';
import type { StoredSocialScriptBaseline } from './socialContentScriptBaseline.js';
import { createIntentEffectPlan, type BeatGridEvidenceV1, type EffectPlanV1 } from '../../shared/contracts/effectPlan.js';
import { compactLockedSpeech } from './socialContentLockedSpeech.js';
import {
  SocialContentWorkflowError,
  socialJson,
  socialObject,
  socialRequestHash,
  socialText,
} from './socialContentValidation.js';

export const SOCIAL_DIRECTOR_PLAN_SCHEMA = 'social-content-director-plan.v2';
const LEGACY_DIRECTOR_PLAN_SCHEMA = 'social-content-director-plan.v1';

export type SocialDirectorPace = 'fast' | 'balanced' | 'steady';
export type SocialDirectorQualityGateStatus = 'passed' | 'warning' | 'blocked';

export interface SocialDirectorBgmTrack {
  trackId: string;
  name: string;
  mood: string;
  authorization: {
    status: 'authorized';
    basis: 'lingshu_builtin_library' | 'mixkit_free_license' | 'tenant_uploaded_warranty';
    license: string;
    evidence: string;
  };
  beatEvidence?: BeatGridEvidenceV1;
}

export interface SocialDirectorBgmSelection {
  primary: SocialDirectorBgmTrack;
  fallbacks: SocialDirectorBgmTrack[];
  fallbackPolicy: 'ordered_preapproved_tracks_only';
  volume: number;
}

export interface SocialDirectorOutputSpec {
  aspectRatio: string;
  resolution: '720p';
  platform: string;
  language: 'zh' | 'en';
  targetDurationSeconds: number;
  maximumDurationSeconds: number;
  voiceVolume: number;
}

export interface StoredSocialDirectorPlan {
  accountPlaybookConstraints?:SocialAccountProductionConstraints;
  schemaVersion: typeof SOCIAL_DIRECTOR_PLAN_SCHEMA;
  directorPlanId: string;
  version: string;
  status: 'ready' | 'blocked';
  lockStatus: 'locked' | 'blocked';
  lockedAt: string | null;
  createdAt: string;
  createdBy: 'director_agent';
  revision: {
    kind: 'initial' | 'voiceover_fit';
    previousVersion: string | null;
    reasonCode: 'initial_lock' | 'voiceover_exceeds_material';
    measuredDurationSeconds: number | null;
    targetDurationSeconds: number;
  };
  themeId: SocialContentThemeId | null;
  language: 'zh' | 'en';
  scriptSource: {
    kind: StoredSocialScriptBaseline['source'];
    baselineVersion: string;
    formulaReference: { formulaId: string; version: string } | null;
    inspirationReference: { recordId: string; confidence: number } | null;
    referenceSource?: {
      sourceId: string;
      sourceRef: string;
      sourceVersion: string | null;
    } | null;
    matchConfidence: number;
    verifiedKnowledgeSource: 'enterprise_product' | 'enterprise_profile' | 'user_product_association' | 'none';
  };
  direction: {
    targetDurationSeconds: number;
    pace: SocialDirectorPace;
    music: { mood: string; volume: number };
    voiceover: {
      voice: string;
      preset: 'tiktok_excited' | 'authentic_review' | 'professional_b2b' | 'warm_story' | 'urgent_cta';
      speed: number;
      pauseStyle: 'few' | 'natural' | 'dramatic';
    };
    subtitles: {
      mode: 'director_locked';
      fontScale: number;
      bottomRatio: number;
    };
  };
  outputSpec: SocialDirectorOutputSpec;
  bgmSelection: SocialDirectorBgmSelection;
  /** Explicitly versioned at the final Director review. Missing means a legacy
   * plan and must remain effect-free on rerender. */
  effectPlan?: EffectPlanV1;
  collaboration?: {
    schemaVersion: 'social-agent-collaboration.v1';
    directorBrief: { id: string; version: string };
    contentExecutionPlan: { id: string; version: string; selectedBy: 'content_agent' };
    directorReview: { id: string; version: string; approvedBy: 'director_agent' };
    finalSelection?: { hash: string; selectedBy: 'content_agent'; reviewedBy: 'director_agent' };
  };
  materialSnapshot: Array<{
    assetId: string;
    sourceId: string;
    sourceVersion: string | null;
    assetName: string;
    type: 'video' | 'image';
    durationSeconds: number;
    contentHash: string;
    hashKind: 'content_sha256' | 'reference_sha256';
    cloudRecordId: string | null;
    objectKey: string | null;
    renderUrl: string;
    availability: 'available_at_lock';
    selectionOrigin?: SocialProductionAsset['selectionOrigin'];
    clips: Array<{
      clipId: string;
      sourceStart: number;
      sourceEnd: number;
      confidence: number;
      observations: string[];
    }>;
  }>;
  scenes: Array<{
    accountPlaybookConstraints?:SocialAccountProductionConstraints;
    sceneId: string;
    order: number;
    /** Safe timing/camera grammar copied from this task's analyzed reference
     * video. Original dialogue, brand and identity never enter this object. */
    referenceStructure?: NonNullable<StoredSocialScriptBaseline['scenes'][number]['referenceStructure']>;
    script: {
      text: string;
      shotFunction: string;
      subject: string;
      action: string;
    };
    voiceover: string;
    caption: string;
    shotPlan: {
      clipId: string;
      assetId: string;
      assetName: string;
      type: 'video' | 'image';
      sourceStart: number;
      sourceEnd: number;
      confidence: number;
      semanticScore: number;
    };
    materialMapping: {
      sourceAssetId: string;
      observations: string[];
      adaptation: 'none' | 'trim_only' | 'trim_and_duration_fit';
    };
  }>;
  coverIntent: {
    sceneId: string;
    assetId: string;
    sourceTimestampSeconds: number;
    framePosition: 'scene_midpoint';
    purpose: string;
  };
  selectedAssetIds: string[];
  unusedAssets: Array<{ assetId: string; assetName: string; reason: string }>;
  optionalReshootSuggestions: string[];
  qualityGates: Array<{
    gateId: 'script_grounding' | 'material_coverage' | 'material_confidence' | 'content_agent_lock';
    status: SocialDirectorQualityGateStatus;
    message: string;
  }>;
  contentAgentHandoff: {
    scriptLocked: true;
    creativeFieldsLocked: ['timeline', 'voiceover', 'subtitles', 'output_spec', 'bgm', 'cover'];
    allowedAdaptations: ['execute_locked_timeline', 'ordered_bgm_fallback'];
    forbiddenActions: ['rewrite_script', 'invent_product_facts', 'replace_real_material_with_text_cards', 'select_unplanned_bgm', 'change_output_spec'];
  };
  lineageHash: string;
}

export interface SocialDirectorContentHandoff {
  directorPlanId: string;
  planVersion: string;
  lockStatus: 'locked';
  lineageHash: string;
  narration: string;
  direction: StoredSocialDirectorPlan['direction'];
  outputSpec: SocialDirectorOutputSpec;
  bgmSelection: SocialDirectorBgmSelection;
  effectPlan: EffectPlanV1 | null;
  collaboration: StoredSocialDirectorPlan['collaboration'] | null;
  coverIntent: StoredSocialDirectorPlan['coverIntent'];
  scenes: Array<{
    sceneId: string;
    order: number;
    referenceStructure?: StoredSocialDirectorPlan['scenes'][number]['referenceStructure'];
    script: StoredSocialDirectorPlan['scenes'][number]['script'];
    voiceover: string;
    caption: string;
    source: {
      assetId: string;
      sourceId: string;
      assetName: string;
      type: 'video' | 'image';
      renderUrl: string;
      contentHash: string;
      clipId: string;
      sourceStart: number;
      sourceEnd: number;
    };
  }>;
  rules: StoredSocialDirectorPlan['contentAgentHandoff'];
  handoffHash: string;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function roundSeconds(value: number): number {
  return Number(Math.max(0, value).toFixed(3));
}

function nextVersion(previous: StoredSocialDirectorPlan | null | undefined): string {
  const version = Number(previous?.version);
  return Number.isSafeInteger(version) && version > 0 ? String(version + 1) : '1';
}

function stableDirectorPlanId(taskId: string): string {
  const id = socialText(taskId);
  if (!id) throw new SocialContentWorkflowError('social_content_director_plan_identity_invalid', 503);
  return `director_plan_${socialRequestHash({ scope: 'social_content_task', taskId: id }).slice(0, 24)}`;
}

export function applyLockedTemplateDirection(direction: StoredSocialDirectorPlan['direction'], baseline: StoredSocialScriptBaseline): StoredSocialDirectorPlan['direction'] {
 const c=baseline.contentTemplateStructure;if(!c)return direction;if(!validContentTemplateStructure(c))throw new SocialContentWorkflowError('content_template_structure_invalid',409);return {...direction,pace:c.pace,voiceover:{...direction.voiceover,speed:c.voiceSpeed,pauseStyle:c.pauseStyle}};
}

/** The same direction selection used before budget admission and during render. */
export function socialDirectorFrozenDirection(input: {baseline: StoredSocialScriptBaseline; formula?: InternalSocialContentFormula | null; duration: number}): StoredSocialDirectorPlan['direction'] {
 return applyLockedTemplateDirection(directionFor({formula: input.formula, themeId: input.baseline.themeId, duration: input.duration}), input.baseline);
}

function directionFor(input: {
  formula?: InternalSocialContentFormula | null;
  themeId: SocialContentThemeId | null;
  duration: number;
}): StoredSocialDirectorPlan['direction'] {
  const configured = input.formula?.direction;
  const defaultPace: SocialDirectorPace = input.themeId === 'supplier_capability' ? 'steady' : 'balanced';
  const defaultVoicePreset = input.themeId === 'product_value' ? 'authentic_review' : 'professional_b2b';
  const defaultVoiceSpeed = input.themeId === 'product_value' ? 1.02 : 1.08;
  const defaultMood = input.themeId === 'supplier_capability'
    ? '稳重、可信、商务'
    : input.themeId === 'customer_case'
      ? '温暖、克制、可信'
      : '清晰、轻快、专业';
  return {
    targetDurationSeconds: roundSeconds(input.duration),
    pace: configured?.pace ?? defaultPace,
    music: {
      mood: socialText(configured?.music?.mood) || defaultMood,
      volume: clamp(Number(configured?.music?.volume ?? 18), 0, 100),
    },
    voiceover: {
      voice: socialText(configured?.voiceover?.voice) || 'v1',
      preset: configured?.voiceover?.preset ?? defaultVoicePreset,
      speed: clamp(Number(configured?.voiceover?.speed ?? defaultVoiceSpeed), 0.75, 1.5),
      pauseStyle: configured?.voiceover?.pauseStyle ?? 'natural',
    },
    subtitles: {
      mode: 'director_locked',
      fontScale: clamp(Number(configured?.subtitles?.fontScale ?? 1.45), 0.75, 1.5),
      bottomRatio: clamp(Number(configured?.subtitles?.bottomRatio ?? 0.18), 0.08, 0.35),
    },
  };
}

function reshootSuggestions(plan: SocialProductionPlan): string[] {
  const suggestions: string[] = [];
  if (plan.scenes.length < 3) suggestions.push('可选补拍：增加一个与主题直接相关的动态近景，便于丰富镜头节奏。');
  if (plan.averageConfidence < 0.78) suggestions.push('可选补拍：在光线稳定、主体清晰的环境中补充一段 3–5 秒实拍。');
  if (plan.unusedAssets.some(asset => /不相关/.test(asset.reason))) {
    suggestions.push('可选补拍：补充与本次主题一致的产品、使用过程或生产现场画面。');
  }
  return suggestions.slice(0, 3);
}

function sameSpokenContent(left: string, right: string): boolean {
  const normalize = (value: string) => value.toLocaleLowerCase().replace(/[\s，,。.!！?？；;：:、]/g, '');
  return normalize(left) === normalize(right);
}

function materialSnapshots(input: {
  assets: SocialProductionAsset[];
  plan: SocialProductionPlan;
  sourceVersions?: Record<string, string>;
}): StoredSocialDirectorPlan['materialSnapshot'] {
  const byId = new Map(input.assets.map(asset => [asset.id, asset]));
  return input.plan.selectedAssetIds.map(assetId => {
    const asset = byId.get(assetId);
    if (!asset || !socialText(asset.url)) {
      throw new SocialContentWorkflowError('social_content_director_plan_material_snapshot_invalid', 503);
    }
    const contentHash = /^[a-f0-9]{64}$/i.test(socialText(asset.contentHash))
      ? socialText(asset.contentHash).toLocaleLowerCase()
      : socialRequestHash({
          assetId: asset.id,
          sourceId: asset.sourceId,
          cloudRecordId: asset.cloudRecordId ?? null,
          objectKey: asset.objectKey ?? null,
          duration: roundSeconds(asset.duration),
        });
    const clips = input.plan.scenes.filter(scene => scene.clip.assetId === assetId).map(scene => ({
      clipId: scene.clip.clipId,
      sourceStart: roundSeconds(scene.clip.start),
      sourceEnd: roundSeconds(scene.clip.end),
      confidence: Number(scene.clip.confidence.toFixed(4)),
      observations: [...scene.clip.observations],
    }));
    if (!clips.length) throw new SocialContentWorkflowError('social_content_director_plan_material_snapshot_invalid', 503);
    return {
      assetId: asset.id,
      sourceId: asset.sourceId,
      sourceVersion: socialText(input.sourceVersions?.[asset.sourceId]) || null,
      assetName: asset.name,
      type: asset.type,
      durationSeconds: roundSeconds(asset.duration),
      contentHash,
      hashKind: /^[a-f0-9]{64}$/i.test(socialText(asset.contentHash))
        ? 'content_sha256' as const
        : 'reference_sha256' as const,
      cloudRecordId: socialText(asset.cloudRecordId) || null,
      objectKey: socialText(asset.objectKey) || null,
      renderUrl: asset.url,
      availability: 'available_at_lock' as const,
      ...(asset.selectionOrigin ? { selectionOrigin: asset.selectionOrigin } : {}),
      clips,
    };
  });
}

function directorPlanPayload(plan: StoredSocialDirectorPlan): Omit<StoredSocialDirectorPlan, 'lineageHash'> {
  const { lineageHash: _lineageHash, ...payload } = plan;
  return payload;
}

function withDirectorPlanHash(plan: Omit<StoredSocialDirectorPlan, 'lineageHash'>): StoredSocialDirectorPlan {
  return { ...plan, lineageHash: socialRequestHash(plan) };
}

export function assertDirectorPlanIntegrity(plan: StoredSocialDirectorPlan): void {
  if (socialRequestHash(directorPlanPayload(plan)) !== plan.lineageHash) {
    throw new SocialContentWorkflowError('social_content_director_plan_lineage_invalid', 503);
  }
}

/** Final Director-approved lock: creative requirements originate in the
 * DirectorBrief; concrete assets and trims originate in the Content Agent plan. */
export function buildSocialDirectorPlan(input: {
  taskId: string;
  baseline: StoredSocialScriptBaseline;
  productionPlan: SocialProductionPlan;
  productionAssets: SocialProductionAsset[];
  sourceVersions?: Record<string, string>;
  outputSpec: { aspectRatio?: string | null; resolution?: '720p'; platform?: string | null };
  bgmSelection: SocialDirectorBgmSelection;
  formula?: InternalSocialContentFormula | null;
  createdAt: string;
  previous?: StoredSocialDirectorPlan | null;
  collaboration?: StoredSocialDirectorPlan['collaboration'];
}): StoredSocialDirectorPlan {
  if (!input.productionPlan.ok || input.productionPlan.scenes.length < 1) {
    throw new SocialContentWorkflowError('social_content_director_plan_material_not_ready', 409);
  }
  const directorPlanId = stableDirectorPlanId(input.taskId);
  if (input.previous && input.previous.directorPlanId !== directorPlanId) {
    throw new SocialContentWorkflowError('social_content_director_plan_identity_invalid', 503);
  }
  const direction = socialDirectorFrozenDirection({baseline: input.baseline, formula: input.formula, duration: input.productionPlan.maxDuration});
  if(input.baseline.accountPlaybookConstraints)assertSocialAccountProductionConstraints(input.baseline.accountPlaybookConstraints);
  const baselineById = new Map(input.baseline.scenes.map(scene => [scene.sceneId, scene]));
  const scenes = input.productionPlan.scenes.map((scene, index) => {
    const baselineScene = baselineById.get(scene.sceneId);
    if (!baselineScene) throw new SocialContentWorkflowError('social_content_director_plan_lineage_invalid', 503);
    const script = {
      text: socialText(baselineScene.script) || `${baselineScene.shotFunction}：${baselineScene.subject}，${baselineScene.action}`,
      shotFunction: socialText(baselineScene.shotFunction),
      subject: socialText(baselineScene.subject),
      action: socialText(baselineScene.action),
    };
    const voiceover = socialText(scene.narration);
    const caption = sameSpokenContent(scene.narration, baselineScene.voiceover || baselineScene.narration)
      ? socialText(baselineScene.caption) || voiceover
      : voiceover;
    if (Object.values(script).some(value => !value)) {
      throw new SocialContentWorkflowError('social_content_director_plan_script_invalid', 503);
    }
    return {
      ...(input.baseline.accountPlaybookConstraints?{accountPlaybookConstraints:structuredClone(input.baseline.accountPlaybookConstraints)}:{}),
      sceneId: scene.sceneId,
      order: index + 1,
      ...(baselineScene.referenceStructure ? {
        referenceStructure: {
          ...baselineScene.referenceStructure,
          sourceTiming: { ...baselineScene.referenceStructure.sourceTiming },
        },
      } : {}),
      script,
      voiceover,
      caption,
      shotPlan: {
        clipId: scene.clip.clipId,
        assetId: scene.clip.assetId,
        assetName: scene.clip.assetName,
        type: scene.clip.type,
        sourceStart: roundSeconds(scene.clip.start),
        sourceEnd: roundSeconds(scene.clip.end),
        confidence: Number(scene.clip.confidence.toFixed(4)),
        semanticScore: Number(scene.semanticScore.toFixed(4)),
      },
      materialMapping: {
        sourceAssetId: scene.clip.assetId,
        observations: [...scene.clip.observations],
        adaptation: scene.narration === scene.baselineNarration ? 'trim_only' as const : 'trim_and_duration_fit' as const,
      },
    };
  });
  if (!scenes.some(scene => socialText(scene.voiceover))) {
    throw new SocialContentWorkflowError('social_content_director_plan_script_invalid', 503);
  }
  const qualityGates: StoredSocialDirectorPlan['qualityGates'] = [
    {
      gateId: 'script_grounding',
      status: input.baseline.source !== 'system_theme_baseline'
        && input.baseline.match?.verifiedKnowledgeSource === 'none'
        && !input.baseline.match?.inspirationReference
        && !input.baseline.formulaReference ? 'blocked' : 'passed',
      message: input.baseline.source === 'system_theme_baseline'
        ? '采用平台安全主题结构，不使用未经核验的企业或产品事实。'
        : input.baseline.match?.verifiedKnowledgeSource === 'none'
        && !input.baseline.match?.inspirationReference
        && !input.baseline.formulaReference
        ? '没有可追溯的公式、灵感脚本或企业知识来源。'
        : '脚本来源可追溯，用户自由输入仅用于表达意图。',
    },
    {
      gateId: 'material_coverage',
      status: scenes.length >= 2 && input.productionPlan.sourceClipSeconds >= 5.5 ? 'passed' : 'blocked',
      message: `已锁定 ${scenes.length} 个可用视觉镜头，约 ${input.productionPlan.sourceClipSeconds.toFixed(1)} 秒有效画面。`,
    },
    {
      gateId: 'material_confidence',
      status: input.productionPlan.averageConfidence >= 0.7 ? 'passed' : 'warning',
      message: `素材分析平均置信度 ${Math.round(input.productionPlan.averageConfidence * 100)}%。`,
    },
    {
      gateId: 'content_agent_lock',
      status: 'passed',
      message: '时间线、脚本、口播、字幕、输出规格、配乐和封面意图均已锁定；内容 Agent 只执行。',
    },
  ];
  const blocked = qualityGates.some(gate => gate.status === 'blocked');
  const snapshot = materialSnapshots({
    assets: input.productionAssets,
    plan: input.productionPlan,
    sourceVersions: input.sourceVersions,
  });
  const coverScene = [...scenes].sort((left, right) => (
    right.shotPlan.semanticScore - left.shotPlan.semanticScore
    || right.shotPlan.confidence - left.shotPlan.confidence
    || left.order - right.order
  ))[0]!;
  const createdAt = new Date(input.createdAt).toISOString();
  const bgmSelection: SocialDirectorBgmSelection = {
    ...input.bgmSelection,
    primary: { ...input.bgmSelection.primary, authorization: { ...input.bgmSelection.primary.authorization } },
    fallbacks: input.bgmSelection.fallbacks.map(track => ({ ...track, authorization: { ...track.authorization } })),
    volume: direction.music.volume,
  };
  const outputSpec: SocialDirectorOutputSpec = {
    aspectRatio: socialText(input.outputSpec.aspectRatio) || '9:16',
    resolution: input.outputSpec.resolution ?? '720p',
    platform: socialText(input.outputSpec.platform) || 'douyin',
    language: input.baseline.language,
    targetDurationSeconds: direction.targetDurationSeconds,
    maximumDurationSeconds: roundSeconds(input.productionPlan.maxDuration),
    voiceVolume: 100,
  };
  const effectPlan = input.previous && !input.previous.effectPlan ? undefined : createIntentEffectPlan(scenes.map(scene => ({
    sceneId: scene.sceneId,
    targetDuration: Math.max(.5, scene.shotPlan.sourceEnd - scene.shotPlan.sourceStart),
    purpose: scene.script.shotFunction,
    targetVisual: scene.script.subject,
    action: scene.script.action,
    caption: scene.caption,
    music: direction.music.mood,
    pace: direction.pace === 'balanced' ? 'medium' : direction.pace,
    // Captions/SFX remain post-production layers and never alter the locked
    // product or factory pixels underneath.
    protectedVisual: false,
  })), 2, 198, input.bgmSelection.primary.beatEvidence);
  return withDirectorPlanHash({
    ...(input.baseline.accountPlaybookConstraints?{accountPlaybookConstraints:structuredClone(input.baseline.accountPlaybookConstraints)}:{}),
    schemaVersion: SOCIAL_DIRECTOR_PLAN_SCHEMA,
    directorPlanId,
    version: nextVersion(input.previous),
    status: blocked ? 'blocked' : 'ready',
    lockStatus: blocked ? 'blocked' : 'locked',
    lockedAt: blocked ? null : createdAt,
    createdAt,
    createdBy: 'director_agent',
    revision: {
      kind: 'initial',
      previousVersion: input.previous?.version ?? null,
      reasonCode: 'initial_lock',
      measuredDurationSeconds: null,
      targetDurationSeconds: direction.targetDurationSeconds,
    },
    themeId: input.baseline.themeId,
    language: input.baseline.language,
    scriptSource: {
      kind: input.baseline.source,
      baselineVersion: input.baseline.version,
      formulaReference: input.baseline.formulaReference,
      inspirationReference: input.baseline.match?.inspirationReference ?? null,
      referenceSource: input.baseline.match?.referenceSource
        ? { ...input.baseline.match.referenceSource }
        : null,
      matchConfidence: input.baseline.match?.confidence ?? 0,
      verifiedKnowledgeSource: input.baseline.match?.verifiedKnowledgeSource ?? 'none',
    },
    direction,
    outputSpec,
    bgmSelection,
    ...(effectPlan ? { effectPlan } : {}),
    ...(input.collaboration ? { collaboration: {
      ...structuredClone(input.collaboration),
      finalSelection: {
        hash: socialRequestHash(scenes.map(scene => ({ sceneId: scene.sceneId, shotPlan: scene.shotPlan }))),
        selectedBy: 'content_agent',
        reviewedBy: 'director_agent',
      },
    } } : {}),
    materialSnapshot: snapshot,
    scenes,
    coverIntent: {
      sceneId: coverScene.sceneId,
      assetId: coverScene.shotPlan.assetId,
      sourceTimestampSeconds: roundSeconds((coverScene.shotPlan.sourceStart + coverScene.shotPlan.sourceEnd) / 2),
      framePosition: 'scene_midpoint',
      purpose: `${coverScene.script.shotFunction}：${coverScene.script.subject}`,
    },
    selectedAssetIds: [...input.productionPlan.selectedAssetIds],
    unusedAssets: [...input.productionPlan.unusedAssets],
    optionalReshootSuggestions: reshootSuggestions(input.productionPlan),
    qualityGates,
    contentAgentHandoff: {
      scriptLocked: true,
      creativeFieldsLocked: ['timeline', 'voiceover', 'subtitles', 'output_spec', 'bgm', 'cover'],
      allowedAdaptations: ['execute_locked_timeline', 'ordered_bgm_fallback'],
      forbiddenActions: [
        'rewrite_script',
        'invent_product_facts',
        'replace_real_material_with_text_cards',
        'select_unplanned_bgm',
        'change_output_spec',
      ],
    },
  });
}


/** Internal Director Agent correction. It creates a new locked version; the
 * Content Agent never shortens or rewrites speech by itself. */
export function reviseSocialDirectorPlanForVoiceoverFit(input: {
  previous: StoredSocialDirectorPlan;
  measuredDurationSeconds: number;
  createdAt: string;
}): StoredSocialDirectorPlan {
  assertDirectorPlanIntegrity(input.previous);
  if (input.previous.lockStatus !== 'locked' || input.previous.status !== 'ready') {
    throw new SocialContentWorkflowError('social_content_director_plan_not_ready', 409);
  }
  const measured = Number(input.measuredDurationSeconds);
  const target = input.previous.outputSpec.maximumDurationSeconds;
  if (!Number.isFinite(measured) || measured <= target) {
    throw new SocialContentWorkflowError('social_content_director_revision_not_required', 409);
  }
  if (input.previous.scriptSource.kind === 'inspiration_script') {
    // Viral replication keeps the reference wording intact. A duration drift
    // needs more visual coverage or a new asset match, never shortened copy.
    throw new SocialContentWorkflowError('social_content_reference_voiceover_requires_more_material', 409);
  }
  const ratio = clamp((target / measured) * 0.82, 0.28, 0.82);
  let changed = false;
  const scenes = input.previous.scenes.map(scene => {
    const voiceover = compactLockedSpeech(scene.voiceover, ratio, input.previous.language);
    if (!voiceover) throw new SocialContentWorkflowError('social_content_director_revision_not_possible', 409);
    if (voiceover !== scene.voiceover) changed = true;
    return { ...scene, voiceover, caption: voiceover };
  });
  if (!changed) throw new SocialContentWorkflowError('social_content_director_revision_not_possible', 409);
  const createdAt = new Date(input.createdAt).toISOString();
  const { lineageHash: _lineageHash, ...previous } = input.previous;
  return withDirectorPlanHash({
    ...previous,
    version: nextVersion(input.previous),
    createdAt,
    lockedAt: createdAt,
    revision: {
      kind: 'voiceover_fit',
      previousVersion: input.previous.version,
      reasonCode: 'voiceover_exceeds_material',
      measuredDurationSeconds: roundSeconds(measured),
      targetDurationSeconds: roundSeconds(target),
    },
    scenes,
    qualityGates: input.previous.qualityGates.map(gate => gate.gateId === 'content_agent_lock'
      ? { ...gate, message: '口播超时已由编导 Agent 压缩并生成新锁定版本；内容 Agent 继续只执行。' }
      : gate),
  });
}

function stringArray(value: unknown): string[] {
  const parsed = socialJson(value);
  return Array.isArray(parsed) ? parsed.map(socialText).filter(Boolean) : [];
}

export function parseStoredSocialDirectorPlan(value: unknown): StoredSocialDirectorPlan | null {
  const raw = socialJson(value);
  if (raw === undefined || raw === null || raw === '') return null;
  const row = socialObject(raw);
  if (socialText(row?.schemaVersion) === LEGACY_DIRECTOR_PLAN_SCHEMA) return null;
  const source = socialObject(row?.scriptSource);
  const formulaReference = socialObject(source?.formulaReference);
  const direction = socialObject(row?.direction);
  const music = socialObject(direction?.music);
  const voiceover = socialObject(direction?.voiceover);
  const subtitles = socialObject(direction?.subtitles);
  const outputSpec = socialObject(row?.outputSpec);
  const bgmSelection = socialObject(row?.bgmSelection);
  const primaryBgm = socialObject(bgmSelection?.primary);
  const coverIntent = socialObject(row?.coverIntent);
  const handoff = socialObject(row?.contentAgentHandoff);
  const scenesValue = socialJson(row?.scenes);
  const materialsValue = socialJson(row?.materialSnapshot);
  const gatesValue = socialJson(row?.qualityGates);
  const kind = socialText(source?.kind) as StoredSocialDirectorPlan['scriptSource']['kind'];
  const language = socialText(row?.language) as StoredSocialDirectorPlan['language'];
  const status = socialText(row?.status) as StoredSocialDirectorPlan['status'];
  if (!row || socialText(row.schemaVersion) !== SOCIAL_DIRECTOR_PLAN_SCHEMA
    || !/^director_plan_[a-f0-9]{24}$/.test(socialText(row.directorPlanId))
    || !/^\d+$/.test(socialText(row.version))
    || !['ready', 'blocked'].includes(status)
    || !['locked', 'blocked'].includes(socialText(row.lockStatus))
    || (status === 'ready' ? socialText(row.lockStatus) !== 'locked' || !socialText(row.lockedAt) : socialText(row.lockStatus) !== 'blocked')
    || socialText(row.createdBy) !== 'director_agent'
    || !socialText(row.createdAt)
    || !['zh', 'en'].includes(language)
    || !['formula', 'inspiration_script', 'knowledge_fallback', 'system_theme_baseline'].includes(kind)
    || !source || !direction || !music || !voiceover || !subtitles || !outputSpec || !bgmSelection || !primaryBgm
    || !coverIntent || !handoff || handoff.scriptLocked !== true
    || !Array.isArray(scenesValue) || !scenesValue.length
    || !Array.isArray(materialsValue) || !materialsValue.length
    || !Array.isArray(gatesValue) || gatesValue.length < 4
    || !socialText(row.lineageHash)) {
    throw new SocialContentWorkflowError('social_content_director_plan_record_invalid', 503);
  }
  if ((kind === 'formula' && (!socialText(formulaReference?.formulaId) || !socialText(formulaReference?.version)))
    || (kind !== 'formula' && formulaReference)) {
    throw new SocialContentWorkflowError('social_content_director_plan_record_invalid', 503);
  }
  if (!socialText(outputSpec.aspectRatio) || socialText(outputSpec.resolution) !== '720p'
    || !socialText(outputSpec.platform) || socialText(outputSpec.language) !== language
    || Number(outputSpec.targetDurationSeconds) <= 0 || Number(outputSpec.maximumDurationSeconds) <= 0
    || Number(outputSpec.voiceVolume) !== 100
    || !socialText(primaryBgm.trackId) || !socialText(primaryBgm.name)
    || socialText(bgmSelection.fallbackPolicy) !== 'ordered_preapproved_tracks_only'
    || Number(bgmSelection.volume) !== Number(music.volume)) {
    throw new SocialContentWorkflowError('social_content_director_plan_record_invalid', 503);
  }
  let spokenSceneCount = 0;
  for (const value of scenesValue) {
    const scene = socialObject(value);
    const script = socialObject(scene?.script);
    const shotPlan = socialObject(scene?.shotPlan);
    const mapping = socialObject(scene?.materialMapping);
    if (!scene || !script || !shotPlan || !mapping
      || !socialText(scene.sceneId) || typeof scene.voiceover !== 'string' || typeof scene.caption !== 'string'
      || !socialText(script.text) || !socialText(script.shotFunction) || !socialText(script.subject) || !socialText(script.action)
      || !socialText(shotPlan.clipId) || !socialText(shotPlan.assetId) || !socialText(shotPlan.assetName)
      || !['video', 'image'].includes(socialText(shotPlan.type))) {
      throw new SocialContentWorkflowError('social_content_director_plan_record_invalid', 503);
    }
    if (socialText(scene.voiceover)) spokenSceneCount += 1;
  }
  if (!spokenSceneCount) throw new SocialContentWorkflowError('social_content_director_plan_record_invalid', 503);
  for (const value of materialsValue) {
    const material = socialObject(value);
    const clips = socialJson(material?.clips);
    if (!material || !socialText(material.assetId) || !socialText(material.sourceId) || !socialText(material.assetName)
      || !['video', 'image'].includes(socialText(material.type))
      || !/^[a-f0-9]{64}$/i.test(socialText(material.contentHash))
      || !['content_sha256', 'reference_sha256'].includes(socialText(material.hashKind))
      || !socialText(material.renderUrl) || socialText(material.availability) !== 'available_at_lock'
      || !Array.isArray(clips) || !clips.length) {
      throw new SocialContentWorkflowError('social_content_director_plan_record_invalid', 503);
    }
  }
  for (const value of gatesValue) {
    const gate = socialObject(value);
    if (!gate
      || !['script_grounding', 'material_coverage', 'material_confidence', 'content_agent_lock'].includes(socialText(gate.gateId))
      || !['passed', 'warning', 'blocked'].includes(socialText(gate.status))
      || !socialText(gate.message)) {
      throw new SocialContentWorkflowError('social_content_director_plan_record_invalid', 503);
    }
  }
  const effectPlan = socialObject(row.effectPlan);
  if (row.effectPlan !== undefined && (!effectPlan || Number(effectPlan.schemaVersion) !== 1
    || !Array.isArray(socialJson(effectPlan.scenes))
    || (socialJson(effectPlan.scenes) as unknown[]).some(value => {
      const effectScene = socialObject(value);
      return !effectScene || !scenesValue.some(scene => socialText(socialObject(scene)?.sceneId) === socialText(effectScene.sceneId));
    }))) {
    throw new SocialContentWorkflowError('social_content_director_plan_record_invalid', 503);
  }
  const collaboration = socialObject(row.collaboration);
  const finalSelection = socialObject(collaboration?.finalSelection);
  if (row.collaboration !== undefined && (!collaboration
    || socialText(collaboration.schemaVersion) !== 'social-agent-collaboration.v1'
    || !socialText(socialObject(collaboration.directorBrief)?.id)
    || !socialText(socialObject(collaboration.contentExecutionPlan)?.id)
    || socialText(socialObject(collaboration.contentExecutionPlan)?.selectedBy) !== 'content_agent'
    || !socialText(socialObject(collaboration.directorReview)?.id)
    || socialText(socialObject(collaboration.directorReview)?.approvedBy) !== 'director_agent'
    || (collaboration.finalSelection !== undefined && (!finalSelection
      || !/^[a-f0-9]{64}$/i.test(socialText(finalSelection.hash))
      || socialText(finalSelection.selectedBy) !== 'content_agent'
      || socialText(finalSelection.reviewedBy) !== 'director_agent')))) {
    throw new SocialContentWorkflowError('social_content_director_plan_record_invalid', 503);
  }
  const selectedAssetIds = stringArray(row.selectedAssetIds);
  const sceneAssetIds = scenesValue.map(value => socialText(socialObject(socialObject(value)?.shotPlan)?.assetId));
  const materialAssetIds = materialsValue.map(value => socialText(socialObject(value)?.assetId));
  if (!selectedAssetIds.length
    || selectedAssetIds.some(id => !sceneAssetIds.includes(id) || !materialAssetIds.includes(id))
    || !sceneAssetIds.includes(socialText(coverIntent.assetId))
    || !scenesValue.some(value => socialText(socialObject(value)?.sceneId) === socialText(coverIntent.sceneId))) {
    throw new SocialContentWorkflowError('social_content_director_plan_record_invalid', 503);
  }
  const plan = row as unknown as StoredSocialDirectorPlan;
  if(plan.accountPlaybookConstraints)assertSocialAccountProductionConstraints(plan.accountPlaybookConstraints);
  assertDirectorPlanIntegrity(plan);
  return plan;
}

export {
  publicSocialDirectorPlanSummary,
  socialDirectorContentHandoff,
  socialDirectorHandoffWithBoundVoice,
  socialDirectorCoverTimestamp,
  socialDirectorRenderTimeline,
  socialDirectorSceneTimingCues,
  socialDirectorVoiceAlignedCaptionCues,
  socialDirectorScriptText,
} from './socialContentDirectorHandoff.js';
