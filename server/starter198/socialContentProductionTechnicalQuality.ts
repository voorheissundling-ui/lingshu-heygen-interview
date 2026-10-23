import { recordCurrentContentExecutionCheckpoint } from '../contentExecution/context.js';
import { inspectRenderedScenes, inspectRenderedVisuals, runVisualFfmpeg } from '../lib/renderVisualQuality.js';
import type { runSocialContentAutoProduction } from './socialContentProductionExecution.js';
import type { SocialDirectorContentHandoff } from './socialContentDirectorPlan.js';
import { socialProductionReferenceFidelityFailures } from './socialContentProductionCollaboration.js';
import type { InitialSceneQualityReport } from './socialContentInitialSceneCache.js';
import { executeSocialQualityStage, type executeSocialRenderStage } from './socialContentProductionStages.js';
import { socialRequestHash } from './socialContentValidation.js';
import { writeExecutionStage } from './socialContentProductionRuntimeSupport.js';
import type { readSocialTaskDetail } from './socialContentRecords.js';
import type { probeSocialSceneMedia } from './socialSceneMediaHardProbe.js';

type Execution = Parameters<typeof runSocialContentAutoProduction>[0];
type Detail = NonNullable<Awaited<ReturnType<typeof readSocialTaskDetail>>>;
type RenderResult = Awaited<ReturnType<typeof executeSocialRenderStage>>;

/** Bind technical approval to the actual rendered bytes and frozen scene/voice evidence. */
export async function inspectSocialContentProductionTechnicalQuality(input: {
  execution: Execution;
  detail: Detail;
  agentWorkflow: NonNullable<Detail['agentWorkflow']>;
  contentHandoff: SocialDirectorContentHandoff;
  renderResult: RenderResult;
  manifest: Record<string, unknown>;
  duration: number;
  timeline: Array<{ sceneId: string; targetStart: number; targetEnd: number }>;
  preserveReferenceTimeline: boolean;
  bgmQualitySource: { source: string; sourceHash: string };
  frozenVoiceCues: Parameters<typeof probeSocialSceneMedia>[0]['frozenVoiceCues'];
}) {
  const { execution, detail, agentWorkflow, contentHandoff, renderResult } = input;
  await writeExecutionStage({ ...execution, stage: 'quality_check',
    message: '内容 Agent 正在检查成片画面、音轨和字幕。' });
  const { quality, sceneQuality, audio, measuredDurationSeconds } = await executeSocialQualityStage({
    outputPath: renderResult.outputPath, duration: input.duration,
    scenes: input.timeline.map(clip => ({ start: clip.targetStart, end: clip.targetEnd })),
    expectedUniqueScenes: contentHandoff.scenes.length,
    inspectVisuals: execution.runtime?.inspectVisuals ?? inspectRenderedVisuals,
    inspectScenes: execution.runtime?.inspectScenes ?? inspectRenderedScenes,
    runFfmpeg: execution.runtime?.runFfmpeg ?? runVisualFfmpeg,
    checkpointEnabled: Boolean(execution.graphPhase),
    verifyDuration: input.preserveReferenceTimeline,
    expectedBgm: { ...input.bgmQualitySource, volume: contentHandoff.bgmSelection.volume },
  });
  const finalFidelityFailures = socialProductionReferenceFidelityFailures(agentWorkflow, contentHandoff, {
    referenceAnalysis: detail.referenceVideoAnalysis,
    renderedDurationSeconds: measuredDurationSeconds ?? input.duration,
    renderedTimeline: input.timeline.map(clip => ({ sceneId: clip.sceneId,
      startSeconds: clip.targetStart, endSeconds: clip.targetEnd })),
  });
  const technicalFailures = [...quality.failures, ...sceneQuality.issues.map(issue => issue.reason),
    ...(!audio.ok ? ['成片音轨无法解码'] : []), ...finalFidelityFailures];
  const technicalApproved = quality.passed && sceneQuality.passed && audio.ok
    && (!audio.bgm || audio.bgm.passed) && !finalFidelityFailures.length;
  const { probeSocialSceneMedia } = await import('./socialSceneMediaHardProbe.js');
  const mediaHardProbe = await probeSocialSceneMedia({ filePath: renderResult.outputPath,
    manifest: input.manifest, frozenVoiceCues: input.frozenVoiceCues,
    subtitleRenderEvidence: renderResult.receipt.subtitleRenderEvidence,
    frameRenderEvidence: renderResult.receipt.frameRenderEvidence,
    ...(renderResult.receipt.captionBaselineSidecar && renderResult.receipt.subtitleAssSidecar
      ? { captionMaskSources: {
        baselinePath: renderResult.receipt.captionBaselineSidecar.path,
        baselineSha256: renderResult.receipt.captionBaselineSidecar.sha256,
        assPath: renderResult.receipt.subtitleAssSidecar.path,
        assSha256: renderResult.receipt.subtitleAssSidecar.sha256,
      } } : {}),
  });
  const technicalQualityReport: InitialSceneQualityReport = {
    schemaVersion: 'initial-scene-quality.v1', visual: quality, scenes: sceneQuality,
    audio: { ok: audio.ok && (!audio.bgm || audio.bgm.passed),
      error: !audio.ok ? '成片音轨无法解码' : audio.bgm?.failure ?? null,
      ...(audio.bgm ? { bgm: audio.bgm } : {}) }, mediaHardProbe,
  };
  const technicalQualityInputHash = socialRequestHash({ outputSha256: renderResult.receipt.sha256,
    manifestHash: socialRequestHash(input.manifest), policyVersion: 'social-technical-quality.v2' });
  await recordCurrentContentExecutionCheckpoint({ stage: 'social.graph_technical_quality',
    version: '1', inputHash: technicalQualityInputHash,
    payload: { outputSha256: renderResult.receipt.sha256, approved: technicalApproved,
      failureCount: technicalFailures.length, failures: technicalFailures.slice(0, 100),
      reportHash: socialRequestHash(technicalQualityReport), checkedScenes: sceneQuality.checkedScenes },
  });
  return { quality, sceneQuality, audio, measuredDurationSeconds, technicalFailures,
    technicalApproved, technicalQualityReport };
}
