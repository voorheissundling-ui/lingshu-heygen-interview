import type { SocialDirectorPlanSummary } from '../../shared/contracts/socialContentWorkflow.js';
import {
  SocialContentWorkflowError,
  socialRequestHash,
} from './socialContentValidation.js';
import {
  assertDirectorPlanIntegrity,
  roundSeconds,
  type SocialDirectorContentHandoff,
  type StoredSocialDirectorPlan,
} from './socialContentDirectorPlan.js';

function oneLine(value: string, maximum: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length <= maximum ? clean : `${clean.slice(0, maximum - 1)}…`;
}

export function publicSocialDirectorPlanSummary(plan: StoredSocialDirectorPlan | null): SocialDirectorPlanSummary | undefined {
  if (!plan) return undefined;
  assertDirectorPlanIntegrity(plan);
  const passed = plan.status === 'ready' && plan.lockStatus === 'locked'
    && plan.qualityGates.every(gate => gate.status !== 'blocked');
  const first = plan.scenes[0]!;
  const shotKinds = [...new Set(plan.scenes.map(scene => scene.script.shotFunction))].slice(0, 3).join('、');
  const publicScriptSource: SocialDirectorPlanSummary['scriptSource'] = plan.scriptSource.kind !== 'formula'
    ? plan.scriptSource.kind
    : plan.scriptSource.inspirationReference
      ? 'inspiration_script'
      : plan.scriptSource.verifiedKnowledgeSource !== 'none'
        ? 'knowledge_fallback'
        : 'system_theme_baseline';
  return {
    version: plan.version,
    status: plan.status,
    scriptSource: publicScriptSource,
    baselineVersion: plan.scriptSource.baselineVersion,
    sceneCount: plan.scenes.length,
    language: plan.language,
    createdAt: plan.createdAt,
    // Compatibility field in the public contract. Formula configuration is no
    // longer part of the customer workflow, including for historic plans.
    formulaConfigured: false,
    qualityPassed: passed,
    reshootSuggestionCount: plan.optionalReshootSuggestions.length,
    scriptSummary: oneLine(`${first.script.text}；共 ${plan.scenes.length} 个镜头`, 120),
    voiceoverSummary: oneLine(plan.scenes.map(scene => scene.voiceover).join(plan.language === 'en' ? ' ' : ''), 160),
    subtitleSummary: oneLine(plan.scenes.map(scene => scene.caption).join(' / '), 160),
    shotRhythmSummary: oneLine(`${plan.direction.pace === 'fast' ? '明快' : plan.direction.pace === 'steady' ? '稳健' : '自然'}节奏 · 约 ${Math.round(plan.direction.targetDurationSeconds)} 秒 · ${shotKinds}`, 120),
    referenceSourceId: plan.scriptSource.referenceSource?.sourceId ?? null,
  };
}

function assertHandoffIntegrity(handoff: SocialDirectorContentHandoff): void {
  const { handoffHash, ...payload } = handoff;
  if (socialRequestHash(payload) !== handoffHash) {
    throw new SocialContentWorkflowError('social_content_director_handoff_lineage_invalid', 503);
  }
}

export function socialDirectorHandoffWithBoundVoice(handoff:SocialDirectorContentHandoff,voice:SocialDirectorContentHandoff['direction']['voiceover']['voice']):SocialDirectorContentHandoff{
  assertHandoffIntegrity(handoff);
  const {handoffHash:_previousHash,...rest}=handoff;
  const payload={...rest,direction:{...rest.direction,voiceover:{...rest.direction.voiceover,voice}}};
  return {...payload,handoffHash:socialRequestHash(payload)};
}

/** Exact immutable execution contract handed to Content Agent. No prompt,
 * brief, raw assets or generative/rewrite input exists in this object. */
export function socialDirectorSpokenNarration(scenes: ReadonlyArray<{voiceover: string}>, language: string): string {
 return scenes.map(scene => scene.voiceover.trim()).filter(Boolean).join(language === 'en' ? ' ' : '');
}

export function socialDirectorContentHandoff(plan: StoredSocialDirectorPlan): SocialDirectorContentHandoff {
  assertDirectorPlanIntegrity(plan);
  if (plan.status !== 'ready' || plan.lockStatus !== 'locked'
    || plan.qualityGates.some(gate => gate.status === 'blocked')) {
    throw new SocialContentWorkflowError('social_content_director_plan_not_ready', 409);
  }
  const materialById = new Map(plan.materialSnapshot.map(material => [material.assetId, material]));
  const spokenNarration = socialDirectorSpokenNarration(plan.scenes, plan.language);
  if (!spokenNarration) throw new SocialContentWorkflowError('social_content_director_plan_script_invalid', 503);
  const payload: Omit<SocialDirectorContentHandoff, 'handoffHash'> = {
    directorPlanId: plan.directorPlanId,
    planVersion: plan.version,
    lockStatus: 'locked',
    lineageHash: plan.lineageHash,
    narration: spokenNarration,
    direction: plan.direction,
    outputSpec: plan.outputSpec,
    bgmSelection: plan.bgmSelection,
    effectPlan: plan.effectPlan ?? null,
    collaboration: plan.collaboration ? structuredClone(plan.collaboration) : null,
    coverIntent: plan.coverIntent,
    scenes: plan.scenes.map(scene => {
      const material = materialById.get(scene.shotPlan.assetId);
      if (!material || !material.clips.some(clip => clip.clipId === scene.shotPlan.clipId)) {
        throw new SocialContentWorkflowError('social_content_director_plan_lineage_invalid', 503);
      }
      return {
        sceneId: scene.sceneId,
        order: scene.order,
        ...(scene.referenceStructure ? { referenceStructure: structuredClone(scene.referenceStructure) } : {}),
        script: scene.script,
        voiceover: scene.voiceover,
        caption: scene.caption,
        source: {
          assetId: material.assetId,
          sourceId: material.sourceId,
          assetName: material.assetName,
          type: material.type,
          renderUrl: material.renderUrl,
          contentHash: material.contentHash,
          clipId: scene.shotPlan.clipId,
          sourceStart: scene.shotPlan.sourceStart,
          sourceEnd: scene.shotPlan.sourceEnd,
        },
      };
    }),
    rules: plan.contentAgentHandoff,
  };
  return { ...payload, handoffHash: socialRequestHash(payload) };
}

export function socialDirectorSceneTimingCues(
  handoff: SocialDirectorContentHandoff,
  duration: number,
  preserveReferenceTimeline = false,
): Array<{ start: number; end: number; text: string }> {
  assertHandoffIntegrity(handoff);
  if (preserveReferenceTimeline) {
    const cues = handoff.scenes.map(scene => ({
      start: Number(scene.referenceStructure?.sourceTiming.startSeconds),
      end: Number(scene.referenceStructure?.sourceTiming.endSeconds), text: scene.caption,
    }));
    if (!cues.length || cues.some((cue, index) => !Number.isFinite(cue.start) || !Number.isFinite(cue.end)
      || cue.end <= cue.start || Math.abs(cue.start - (index ? cues[index - 1]!.end : 0)) > .05)
      || Math.abs(cues.at(-1)!.end - duration) > .05) {
      throw new Error('director_revision_required:reference_timeline_missing_or_drifted');
    }
    return cues;
  }
  const exactDuration = Math.max(0.5, Number(duration));
  const weights = handoff.scenes.map(scene => Math.max(1,
    scene.source.type === 'image' ? 2.8 : (scene.source.sourceEnd - scene.source.sourceStart) / 0.82));
  const total = weights.reduce((sum, value) => sum + value, 0);
  let elapsed = 0;
  return handoff.scenes.map((scene, index) => {
    const start = elapsed;
    elapsed = index === handoff.scenes.length - 1
      ? exactDuration
      : Math.min(exactDuration, elapsed + exactDuration * weights[index]! / total);
    return { start, end: elapsed, text: scene.caption };
  });
}

/** Project locked captions onto the measured/provider TTS timeline. Source
 * duration weights remain a render fallback only; subtitles follow the audio
 * that the audience actually hears. */
export function socialDirectorVoiceAlignedCaptionCues(
  handoff: SocialDirectorContentHandoff,
  voiceCues: Array<{ start: number; end: number; text: string }>,
  duration: number,
): Array<{ start: number; end: number; text: string }> {
  assertHandoffIntegrity(handoff);
  const limit = Math.max(.5, Number(duration));
  const cues = voiceCues
    .map(cue => ({ start: Math.max(0, Number(cue.start)), end: Math.min(limit, Number(cue.end)), text: String(cue.text || '') }))
    .filter(cue => Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.end > cue.start && cue.text.trim())
    .sort((left, right) => left.start - right.start);
  if (!cues.length) return socialDirectorSceneTimingCues(handoff, limit);
  // Measured transcript boundaries are the master timeline. Caption styling
  // may wrap within a cue; scene text length must never move its audio time.
  return cues;
}

export function socialDirectorRenderTimeline(
  handoff: SocialDirectorContentHandoff,
  duration: number,
  measuredCues?: Array<{ start: number; end: number }>,
  preserveReferenceTimeline = false,
) {
  const cues = preserveReferenceTimeline ? socialDirectorSceneTimingCues(handoff, duration, true)
    : measuredCues?.length === handoff.scenes.length
    && measuredCues.every((cue, index) => Number.isFinite(cue.start) && Number.isFinite(cue.end)
      && cue.end > cue.start && (index === 0 || cue.start >= measuredCues[index - 1]!.end - .05))
    ? measuredCues : socialDirectorSceneTimingCues(handoff, duration);
  const beatEvidence = handoff.effectPlan?.beatSync ? handoff.effectPlan.beatEvidence : null;
  const renderCues = cues.map(cue => ({ start: cue.start, end: cue.end }));
  if (!preserveReferenceTimeline && beatEvidence && beatEvidence.confidence >= .65) {
    for (let index = 0; index < renderCues.length - 1; index += 1) {
      const boundary = renderCues[index]!.end;
      const nearest = beatEvidence.beats.slice().sort((left, right) => Math.abs(left - boundary) - Math.abs(right - boundary))[0];
      if (nearest === undefined || Math.abs(nearest - boundary) > .12) continue;
      const previous = index === 0 ? 0 : renderCues[index]!.start;
      const following = renderCues[index + 1]!.end;
      if (nearest - previous < .5 || following - nearest < .5) continue;
      renderCues[index]!.end = nearest;
      renderCues[index + 1]!.start = nearest;
    }
  }
  return handoff.scenes.map((scene, index) => {
    const targetStart = index === 0 ? 0 : renderCues[index]!.start;
    const targetEnd = index === handoff.scenes.length - 1 ? duration : renderCues[index]!.end;
    const targetDuration = preserveReferenceTimeline ? targetEnd - targetStart : Math.max(0.5, targetEnd - targetStart);
    if (scene.source.type === 'image') {
      if (targetDuration > 4.2) throw new Error('director_revision_required:单张图片的锁定停留时长过长');
      return { name: scene.source.assetName, type: 'image' as const, url: scene.source.renderUrl, targetStart, targetEnd, targetDuration };
    }
    const availableSourceDuration = scene.source.sourceEnd - scene.source.sourceStart;
    const sourceDuration = Math.min(availableSourceDuration, targetDuration * 1.1);
    const speed = sourceDuration / targetDuration;
    if (!Number.isFinite(speed) || speed < 0.8 || speed > 1.25) {
      throw new Error('director_revision_required:锁定口播与镜头时长不匹配');
    }
    return {
      name: scene.source.assetName,
      type: 'video' as const,
      url: scene.source.renderUrl,
      trimStart: scene.source.sourceStart,
      trimEnd: scene.source.sourceStart + sourceDuration,
      speed,
      targetStart,
      targetEnd,
      targetDuration,
    };
  });
}

export function socialDirectorCoverTimestamp(handoff: SocialDirectorContentHandoff, duration: number, measuredCues?: Array<{ start: number; end: number }>, preserveReferenceTimeline = false): number {
  const cues = preserveReferenceTimeline ? socialDirectorSceneTimingCues(handoff, duration, true)
    : measuredCues?.length === handoff.scenes.length ? measuredCues : socialDirectorSceneTimingCues(handoff, duration);
  const index = handoff.scenes.findIndex(scene => scene.sceneId === handoff.coverIntent.sceneId);
  if (index < 0) throw new SocialContentWorkflowError('social_content_director_handoff_lineage_invalid', 503);
  const cue = cues[index]!;
  return roundSeconds(cue.start + (cue.end - cue.start) / 2);
}

export function socialDirectorScriptText(handoff: SocialDirectorContentHandoff, duration: number, preserveReferenceTimeline = false): string {
  const cues = socialDirectorSceneTimingCues(handoff, duration, preserveReferenceTimeline);
  return handoff.scenes.map((scene, index) => {
    const cue = cues[index]!;
    return `[${cue.start.toFixed(2)}-${cue.end.toFixed(2)}s]\n镜头功能：${scene.script.shotFunction}\n画面：使用“${scene.source.assetName}”的已锁定片段 ${scene.source.sourceStart.toFixed(2)}-${scene.source.sourceEnd.toFixed(2)}s\n口播：${scene.voiceover}\n字幕：${scene.caption}`;
  }).join('\n\n');
}
