import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import { recordCurrentContentExecutionCheckpoint } from '../contentExecution/context.js';
import { assertBoundPresenterAudio, type BoundPresenterVoice } from './socialContentBoundPresenterVoice.js';
import type { runSocialContentAutoProduction } from './socialContentProductionExecution.js';
import type { prepareSocialContentProductionVoice } from './socialContentProductionVoicePreparation.js';
import type { prepareSocialProductionScriptBaseline } from './socialContentProductionScriptBaseline.js';
import type { PreparedWholeVoice } from './socialContentPreparedWholeVoice.js';
import { socialDirectorRenderTimeline, socialDirectorVoiceAlignedCaptionCues, type SocialDirectorContentHandoff } from './socialContentDirectorPlan.js';
import type { resolveLockedBgm } from './socialContentAutoProduction.js';
import { writeExecutionStage } from './socialContentProductionRuntimeSupport.js';
import { freezeSocialRenderFrameContract } from './socialRenderFrameContract.js';
import { socialRequestHash } from './socialContentValidation.js';

type Execution = Parameters<typeof runSocialContentAutoProduction>[0];
type Voice = Awaited<ReturnType<typeof prepareSocialContentProductionVoice>>['voice'];
type Script = Awaited<ReturnType<typeof prepareSocialProductionScriptBaseline>>;

/** Verify the selected presenter track and freeze the compositor/effects evidence. */
export async function prepareSocialContentProductionRenderManifest(scope: {
  execution: Execution;
  contentHandoff: SocialDirectorContentHandoff;
  voice: Voice;
  duration: number;
  voiceDuration: number;
  narrationCheckpointReused: boolean;
  selectedVoice: BoundPresenterVoice | null;
  assertSelectedVoiceCurrent: () => Promise<void>;
  preparedWholeVoice: PreparedWholeVoice | null;
  timeline: Array<ReturnType<typeof socialDirectorRenderTimeline>[number] & { sceneId: string }>;
  bgm: Awaited<ReturnType<typeof resolveLockedBgm>>;
  captionCues: ReturnType<typeof socialDirectorVoiceAlignedCaptionCues>;
  verifiedContext: Script['executionVerifiedContext'];
  trimCheckpointInputHash: string;
}) {
  const input = scope.execution;
  const { contentHandoff, voice, duration, voiceDuration, narrationCheckpointReused,
    selectedVoice, assertSelectedVoiceCurrent, preparedWholeVoice, timeline, bgm,
    captionCues, trimCheckpointInputHash } = scope;
  const executionVerifiedContext = scope.verifiedContext;
  await writeExecutionStage({
    ...input,
    stage: 'rendering',
    message: '内容 Agent 正在自动剪辑、混音并烧录字幕。',
    extra: { duration, voiceDuration, sceneCount: timeline.length, voiceQuality: voice.qualityReport ?? null, narrationCheckpointReused },
  });
  if (selectedVoice) {
    await assertSelectedVoiceCurrent();
    if (!preparedWholeVoice || !voice.localPath) throw Error('selected_presenter_voice_render_proof_missing');
    assertBoundPresenterAudio(selectedVoice.voiceId, preparedWholeVoice.nativeVoice);
    if (createHash('sha256').update(await fsp.readFile(voice.localPath)).digest('hex') !== preparedWholeVoice.wholeTrackSha256) throw Error('selected_presenter_voice_render_audio_changed');
    await recordCurrentContentExecutionCheckpoint({stage:'social.selected_presenter_voice_acceptance',version:'1',inputHash:socialRequestHash({binding:selectedVoice,wholeVoiceInputHash:preparedWholeVoice.inputHash,audioSha256:preparedWholeVoice.wholeTrackSha256}),payload:{binding:selectedVoice,audioSha256:preparedWholeVoice.wholeTrackSha256,sourceReceiptRefs:preparedWholeVoice.sourceReceiptRefs,alignmentReceiptRef:preparedWholeVoice.alignmentReceiptRef}});
  }
  const frameContract=Number.isFinite(duration)&&duration>=1&&duration<=45&&Math.abs(duration*1000-Math.round(duration*1000))<=1e-6?freezeSocialRenderFrameContract(duration):null;
  const compositeManifest = {
    jobId: `social-${input.taskId}-${createHash('sha256').update(input.runId).digest('hex').slice(0, 12)}`,
    requireVisualAssets: true,
    captureCaptionBaseline: true,
    spec: {
      ratio: contentHandoff.outputSpec.aspectRatio,
      resolution: contentHandoff.outputSpec.resolution,
      duration,
      platform: contentHandoff.outputSpec.platform,
      language: contentHandoff.outputSpec.language,
      bgmVol: contentHandoff.bgmSelection.volume,
      voiceVol: contentHandoff.outputSpec.voiceVolume,
    },
    ...(frameContract?{frameContract}:{}),
    timeline,
    ...(contentHandoff.effectPlan ? { effectPlan: contentHandoff.effectPlan } : {}),
    voiceover: { url: voice.localPath },
    bgm,
    subtitles: {
      mode: 'target',
      cues: captionCues,
      style: {
        // Automated social films use a mobile-first minimum even when an older
        // frozen Director plan predates the larger caption default.
        fontScale: Math.max(1.45, contentHandoff.direction.subtitles.fontScale),
        bottomRatio: contentHandoff.direction.subtitles.bottomRatio,
        productNames: executionVerifiedContext.productName ? [executionVerifiedContext.productName] : [],
      },
    },
  };
  const effectsCheckpointInputHash = socialRequestHash({
    trimCheckpointInputHash,
    effectPlan: contentHandoff.effectPlan ?? null,
    subtitles: compositeManifest.subtitles,
    audioMix: { bgm: contentHandoff.bgmSelection, voiceVolume: contentHandoff.outputSpec.voiceVolume },
  });
  await recordCurrentContentExecutionCheckpoint({
    stage: 'social.graph_effects', version: '1', inputHash: effectsCheckpointInputHash,
    payload: {
      effectPlanHash: socialRequestHash(contentHandoff.effectPlan ?? null),
      subtitleCueHash: socialRequestHash(captionCues),
      manifestHash: socialRequestHash(compositeManifest),
      sceneCount: timeline.length,
    },
  });
  return compositeManifest;
}
