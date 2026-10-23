import type { DigitalHumanReferenceCue, DigitalHumanRequirements } from './digitalHumanRequirements.js';

export function sentenceVideoInputFingerprint(cue: DigitalHumanReferenceCue, input: {
  presenterId?: string; presenterVersion?: number; voiceId?: string; language?: string;
  narration?: string; requirements?: DigitalHumanRequirements;
}): string {
  const requirements = input.requirements;
  return JSON.stringify({ presenterId: input.presenterId, presenterVersion: input.presenterVersion || 1,
    voiceId: input.voiceId, language: input.language || '', text: cue.targetText || input.narration || '',
    mode: requirements?.presenterMode, action: requirements?.action, scene: requirements?.scene,
    preserve: requirements?.preserve, source: requirements?.reference?.materialId || requirements?.reference?.videoUrl,
    start: cue.start, end: cue.end, generationDuration: cue.generationDurationSeconds,
    outputDuration: cue.outputDurationSeconds, frame: cue.targetFirstFrame?.materialId,
    nonPersonMaterial: cue.nonPersonMaterialId });
}

export function sentenceCueImpact(cue: DigitalHumanReferenceCue, fingerprint: string) {
  if (cue.personShot === false) return { stage: 'material' as const, reason: '使用已选企业视频素材' };
  if (cue.generatedClip?.state === 'ready' && cue.generatedClip.inputFingerprint === fingerprint)
    return { stage: 'reusable' as const, reason: '生成输入未变化，可沿用已生成视频' };
  if (cue.targetFirstFrame?.state !== 'ready' || !cue.targetFirstFrame.materialId)
    return { stage: 'frame' as const, reason: '系统将自动重建首帧并生成视频' };
  return { stage: 'video' as const, reason: cue.generatedClip?.materialId
    ? '视频输入已变化或旧版本缺少输入记录，需重新生成；首帧可保留'
    : '目标首帧已就绪，需生成视频' };
}
