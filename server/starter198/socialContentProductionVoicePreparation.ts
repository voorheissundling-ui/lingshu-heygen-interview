import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { assertCurrentContentExecutionActive, recordCurrentContentExecutionCheckpoint } from '../contentExecution/context.js';
import { beginContentProviderOperation, completeContentProviderOperation, failContentProviderOperation, markContentProviderOperationUnknown } from '../contentExecution/providerGateway.js';
import { createNativeStudioVoicePaidContext } from '../lib/studioNativeVoicePaidContext.js';
import { synthesizeStudioVoiceForAutomation } from '../lib/socialContentLegacyPorts.js';
import type { BoundPresenterVoice } from './socialContentBoundPresenterVoice.js';
import { readNarrationAudioCheckpoint, recordNarrationAudioCheckpoint } from './socialContentProductionCheckpoints.js';
import type { prepareSocialContentProductionBudget } from './socialContentProductionBudgetPreflight.js';
import type { prepareSocialContentProductionDirector } from './socialContentProductionDirectorPreparation.js';
import type { runSocialContentAutoProduction } from './socialContentProductionExecution.js';
import type { PreparedWholeVoice } from './socialContentPreparedWholeVoice.js';
import { publicSocialDirectorPlanSummary, reviseSocialDirectorPlanForVoiceoverFit, socialDirectorContentHandoff, socialDirectorHandoffWithBoundVoice } from './socialContentDirectorPlan.js';
import { persistSocialDirectorPlanVersion } from './socialContentDirectorPlanVersions.js';
import type { readSocialTaskDetail } from './socialContentRecords.js';
import { STARTER_COLLECTIONS } from './repository.js';
import { writeExecutionStage } from './socialContentProductionRuntimeSupport.js';
import { socialRequestHash, socialText } from './socialContentValidation.js';

type Execution = Parameters<typeof runSocialContentAutoProduction>[0];
type Detail = NonNullable<Awaited<ReturnType<typeof readSocialTaskDetail>>>;
type Director = Awaited<ReturnType<typeof prepareSocialContentProductionDirector>>;
type Budget = Awaited<ReturnType<typeof prepareSocialContentProductionBudget>>;

/** Restore frozen narration or claim one new TTS operation; persist every voice/director revision. */
export async function prepareSocialContentProductionVoice(scope: {
  execution: Execution;
  detail: Detail;
  agentWorkflow: NonNullable<Detail['agentWorkflow']>;
  director: Pick<Director, 'directorPlan' | 'persistedDirectorPlan' | 'directorSummary' | 'contentHandoff'>;
  directorCheckpointInputHash: string;
  taskRecord: { id: string };
  baseline: Parameters<typeof persistSocialDirectorPlanVersion>[0]['baseline'];
  verifiedContext: Parameters<typeof persistSocialDirectorPlanVersion>[0]['verifiedContext'];
  productionBudget: Budget;
  selectedVoice: BoundPresenterVoice | null;
  preparedWholeVoice: PreparedWholeVoice | null;
  preparedWholeVoiceInput: Parameters<typeof synthesizeStudioVoiceForAutomation>[0] | null;
  assertWeeklyCtaNewSubmit: () => Promise<void>;
}) {
  const input = scope.execution;
  const { detail, agentWorkflow, directorCheckpointInputHash, taskRecord, selectedVoice,
    preparedWholeVoice, preparedWholeVoiceInput, productionBudget, assertWeeklyCtaNewSubmit } = scope;
  const activeBaseline = scope.baseline;
  const executionVerifiedContext = scope.verifiedContext;
  let { directorPlan, persistedDirectorPlan, directorSummary, contentHandoff } = scope.director;
  let transientVoicePath = '';
  let retainVoiceForRecovery = false;
  try {
      let voice: Awaited<ReturnType<typeof synthesizeStudioVoiceForAutomation>> | null = null;
      let duration = 0;
      let voiceDuration = 0;
      const preserveReferenceTimeline = (agentWorkflow.replicationJob?.referenceMode ?? agentWorkflow.directorBrief.referenceMode ?? detail.brief.referenceMode) === 'single_source_fidelity';
      let narrationCheckpointInputHash = '';
      let narrationCheckpointReused = false;
      for (let revisionAttempt = 0; revisionAttempt <= 2; revisionAttempt += 1) {
        narrationCheckpointInputHash = socialRequestHash({
          directorPlanHash: directorPlan.lineageHash,
          narration: contentHandoff.narration,
          language: contentHandoff.outputSpec.language,
          voice: selectedVoice?.logicalVoice || contentHandoff.direction.voiceover.voice,
          targetDuration: contentHandoff.outputSpec.targetDurationSeconds,
          preset: contentHandoff.direction.voiceover.preset,
          speed: contentHandoff.direction.voiceover.speed,
          pauseStyle: contentHandoff.direction.voiceover.pauseStyle,
        });
        const recoveredVoice = await readNarrationAudioCheckpoint({
          inputHash: narrationCheckpointInputHash,
          narration: contentHandoff.narration,
        });
        narrationCheckpointReused = Boolean(recoveredVoice);
        if (preparedWholeVoice && preparedWholeVoiceInput) {
          const actualInput={tenantId:input.tenantId,text:contentHandoff.narration,language:contentHandoff.outputSpec.language,voice:selectedVoice?.logicalVoice || contentHandoff.direction.voiceover.voice,
            style:{preset:contentHandoff.direction.voiceover.preset,speed:contentHandoff.direction.voiceover.speed,pauseStyle:contentHandoff.direction.voiceover.pauseStyle}};
          if(socialRequestHash(actualInput)!==socialRequestHash(preparedWholeVoiceInput))throw Error('director_voice_text_changed_requires_budget_replan');
          voice=preparedWholeVoice.voice;
          retainVoiceForRecovery=true;
          narrationCheckpointReused=true;
        } else if (recoveredVoice) {
          voice = recoveredVoice;
          retainVoiceForRecovery = true;
        } else {
          await assertCurrentContentExecutionActive();
          if (input.assetSupplyRecoveryOnly && !input.runtime?.synthesizeVoice) throw new Error('user_input_required:canonical_voice_tracks_missing_no_paid_tts');
          const ttsRequestId = `social-tts:${narrationCheckpointInputHash}`;
          const ttsAdmission = await beginContentProviderOperation({
            provider: 'studio_tts', requestId: ttsRequestId,
            metadata: { narrationCheckpointInputHash },
          });
          if (ttsAdmission.action !== 'submit') {
            // The provider has no task-status API. Failing closed is safer than
            // silently charging a second TTS request after a crash between the
            // response and the audio checkpoint.
            throw new Error('provider_submission_unknown:studio_tts');
          }
          // A custom voice runtime may not use the formal paid permit. Keep the
          // frozen weekly claim check at the actual new-call boundary as well.
          await assertWeeklyCtaNewSubmit();
          try {
            voice = await (input.runtime?.synthesizeVoice ?? synthesizeStudioVoiceForAutomation)({
              tenantId: input.tenantId,
              paidContext: productionBudget.status === 'reserved' ? createNativeStudioVoicePaidContext({
                scope: productionBudget.scope, requirements: productionBudget.requirements,
                routeBindings: productionBudget.routeBindings, intents: productionBudget.reserved.intents,
                permit: productionBudget.paidPermit, assertCurrent: assertCurrentContentExecutionActive,
                voiceInput: {tenantId: input.tenantId, text: contentHandoff.narration,
                  language: contentHandoff.outputSpec.language, voice: selectedVoice?.logicalVoice || contentHandoff.direction.voiceover.voice,
                  style: {preset: contentHandoff.direction.voiceover.preset,
                    speed: contentHandoff.direction.voiceover.speed, pauseStyle: contentHandoff.direction.voiceover.pauseStyle}},
              }) : undefined,
              text: contentHandoff.narration,
              language: contentHandoff.outputSpec.language,
              voice: selectedVoice?.logicalVoice || contentHandoff.direction.voiceover.voice,
              targetDuration: contentHandoff.outputSpec.targetDurationSeconds,
              style: {
                preset: contentHandoff.direction.voiceover.preset,
                speed: contentHandoff.direction.voiceover.speed,
                pauseStyle: contentHandoff.direction.voiceover.pauseStyle,
              },
            });
          } catch (error) {
            await markContentProviderOperationUnknown({
              provider: 'studio_tts', requestId: ttsRequestId,
              metadata: { narrationCheckpointInputHash },
            });
            throw error;
          }
        }
        transientVoicePath = voice.localPath || '';
        if (!voice.ok || !voice.localPath || !existsSync(voice.localPath) || !voice.cues?.length) {
          if (!voice.ok) {
            await failContentProviderOperation({
              provider: 'studio_tts', requestId: `social-tts:${narrationCheckpointInputHash}`,
              metadata: { narrationCheckpointInputHash },
            });
          }
          throw new Error(voice.error || '口播服务未返回可用音频和字幕时间轴');
        }
        if (socialText(voice.text) !== contentHandoff.narration) {
          throw new Error('内容 Agent 返回的口播与编导方案不一致，已停止生成');
        }
        voiceDuration = Math.max(1, Number(voice.duration || voice.cues.at(-1)?.end
          || contentHandoff.outputSpec.targetDurationSeconds));
        duration = preserveReferenceTimeline ? contentHandoff.outputSpec.targetDurationSeconds : voiceDuration;
        retainVoiceForRecovery = await recordNarrationAudioCheckpoint({
          inputHash: narrationCheckpointInputHash,
          narration: contentHandoff.narration,
          voice: {
            ok: true,
            source: voice.source,
            localPath: voice.localPath,
            duration: voiceDuration,
            text: voice.text || contentHandoff.narration,
            cues: voice.cues,
            alignmentSource: voice.alignmentSource,
            qualityReport: voice.qualityReport,
          },
        }) || retainVoiceForRecovery;
        await completeContentProviderOperation({
          provider: 'studio_tts', requestId: `social-tts:${narrationCheckpointInputHash}`,
          metadata: { narrationCheckpointInputHash, duration: voiceDuration, filmDuration: duration },
        });
        if (voiceDuration <= contentHandoff.outputSpec.maximumDurationSeconds + 0.25) break;
        if(preparedWholeVoice)throw Error('director_revision_required:whole_track_speech_exceeds_frozen_film_requires_formal_replan');
        if (revisionAttempt >= 2) {
          throw new Error(`director_revision_required:口播经过 2 次编导内部压缩仍为 ${voiceDuration.toFixed(1)} 秒，超过锁定素材 ${contentHandoff.outputSpec.maximumDurationSeconds.toFixed(1)} 秒`);
        }
        await writeExecutionStage({
          ...input,
          stage: 'director_revision_required',
          message: '实际口播超过素材时长，已退回编导 Agent 内部压缩；无需用户补填。',
          extra: {
            directorPlanId: directorPlan.directorPlanId,
            previousDirectorPlanVersion: directorPlan.version,
            measuredVoiceoverSeconds: voiceDuration,
            maximumMaterialSeconds: contentHandoff.outputSpec.maximumDurationSeconds,
            revisionAttempt: revisionAttempt + 1,
          },
        });
        await Promise.all([
          fsp.rm(transientVoicePath, { force: true }),
          fsp.rm(`${transientVoicePath}.alignment.json`, { force: true }),
        ]).catch(() => undefined);
        transientVoicePath = '';
        retainVoiceForRecovery = false;
        directorPlan = reviseSocialDirectorPlanForVoiceoverFit({
          previous: directorPlan,
          measuredDurationSeconds: voiceDuration,
          createdAt: new Date().toISOString(),
        });
        persistedDirectorPlan = await persistSocialDirectorPlanVersion({
          repository: input.repository,
          tenantId: input.tenantId,
          taskId: input.taskId,
          plan: directorPlan,
          baseline: activeBaseline,
          verifiedContext: executionVerifiedContext,
        });
        directorSummary = publicSocialDirectorPlanSummary(directorPlan)!;
        await input.repository.update(STARTER_COLLECTIONS.socialContentTasks, input.tenantId, taskRecord.id, {
          director_plan: directorPlan,
          updated_at: directorPlan.createdAt,
        });
        contentHandoff = socialDirectorContentHandoff(directorPlan);
        if(selectedVoice)contentHandoff=socialDirectorHandoffWithBoundVoice(contentHandoff,selectedVoice.logicalVoice);
        await recordCurrentContentExecutionCheckpoint({
          stage: 'social.director_storyboard',
          version: '1',
          inputHash: directorCheckpointInputHash,
          payload: {
            directorPlan,
            directorPlanReference: persistedDirectorPlan.reference,
            narration: contentHandoff.narration,
            scenes: contentHandoff.scenes.map(scene => ({
              sceneId: scene.sceneId,
              source: structuredClone(scene.source),
              voiceover: scene.voiceover,
              caption: scene.caption,
            })),
          },
        });
        await writeExecutionStage({
          ...input,
          stage: 'content_production',
          message: `编导 Agent 已锁定第 ${directorPlan.version} 版执行方案，内容 Agent 自动重试配音。`,
          extra: {
            directorPlanId: directorPlan.directorPlanId,
            directorPlanVersion: directorPlan.version,
            directorPlanHash: directorPlan.lineageHash,
            directorPlanSummary: directorSummary,
          },
        });
      }
      if (!voice || !voice.localPath || !voice.cues?.length) throw new Error('口播执行状态异常');
      const readyVoice = voice as typeof voice & {
        localPath: string;
        cues: NonNullable<typeof voice.cues>;
      };
      const voiceOutputSha256 = createHash('sha256').update(await fsp.readFile(voice.localPath)).digest('hex');
      const voiceCheckpointInputHash = socialRequestHash({
        directorPlanHash: directorPlan.lineageHash,
        narrationCheckpointInputHash,
        voice: selectedVoice?.logicalVoice || contentHandoff.direction.voiceover.voice,
      });
      await recordCurrentContentExecutionCheckpoint({
        stage: 'social.graph_voice', version: '1', inputHash: voiceCheckpointInputHash,
        payload: {
          outputSha256: voiceOutputSha256,
          durationSeconds: voiceDuration,
          cueCount: voice.cues.length,
          source: voice.source || 'unknown',
          alignmentSource: voice.alignmentSource || 'unknown',
          narrationCheckpointInputHash,
        },
      });

  return { voice: readyVoice, duration, voiceDuration, preserveReferenceTimeline, narrationCheckpointInputHash,
    narrationCheckpointReused, voiceOutputSha256, directorPlan, persistedDirectorPlan,
    directorSummary, contentHandoff, transientVoicePath, retainVoiceForRecovery };
  } catch (error) {
    // The outer worker only owns cleanup after a successful handoff from this stage.
    if (transientVoicePath && !retainVoiceForRecovery) {
      await Promise.all([
        fsp.rm(transientVoicePath, { force: true }),
        fsp.rm(`${transientVoicePath}.alignment.json`, { force: true }),
      ]).catch(() => undefined);
    }
    throw error;
  }
}
