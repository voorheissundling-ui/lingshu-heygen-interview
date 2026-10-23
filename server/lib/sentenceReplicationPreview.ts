import type { ShotProduction, PresenterAsset } from '../../src/lib/shotProduction.js';
import { referenceCues, type SentenceReplicationResult } from '../../src/lib/digitalHumanPlan.js';
import { sentenceCueImpact, sentenceVideoInputFingerprint } from '../../shared/contracts/sentenceReplicationImpact.js';
import { planPersonShotClusters } from '../../src/lib/personShotClustering.js';
import { photoTalkingBudget } from './photoTalkingBudget.js';
import { planSeedanceReplication } from './seedanceReplicationPlan.js';

export function sentenceReplicationPreview(shot: ShotProduction, presenter: PresenterAsset, language: string,
  previous: SentenceReplicationResult[] = [], env: NodeJS.ProcessEnv = process.env, tenantId?: string) {
  const cues = referenceCues(shot.digitalHuman);
  const reuseCueMaterialIds: Record<string, string> = {};
  const reuseCueQuality = [] as NonNullable<SentenceReplicationResult['cueQuality']>;
  const impacts = cues.map(cue => {
    const fingerprint = sentenceVideoInputFingerprint(cue, {presenterId: presenter.id,
      presenterVersion: presenter.assetVersion, voiceId: presenter.voiceId, language,
      narration: shot.narration, requirements: shot.digitalHuman});
    const prior = previous.find(result => result.cues.some(old => old.id === cue.id
      && old.generatedClip?.inputFingerprint === fingerprint && old.generatedClip.state === 'ready'
      && old.generatedClip.materialId && result.cueQuality?.some(quality => quality.cueId === cue.id && quality.state === 'accepted')));
    if (prior && cue.personShot !== false) {
      const old = prior.cues.find(old => old.id === cue.id)!;
      reuseCueMaterialIds[cue.id] = old.generatedClip!.materialId!;
      reuseCueQuality.push(prior.cueQuality!.find(quality => quality.cueId === cue.id)!);
      return {cueId: cue.id, stage: 'reusable' as const, reason: '输入未变化且已通过质量验收，沿用原视频'};
    }
    // A saved clip alone is not proof of completed quality review.
    const impact = sentenceCueImpact({...cue,generatedClip:cue.generatedClip ? {...cue.generatedClip,inputFingerprint:undefined} : undefined}, fingerprint);
    return {cueId:cue.id,...impact};
  });
  const clusters = planPersonShotClusters(cues, Math.max(1,Number(env.DIGITAL_HUMAN_MAX_FIRST_FRAMES_PER_VIDEO)||3));
  const pendingFrames = clusters.clusters.filter(cluster => cluster.cueIds.some(id => impacts.some(impact => impact.cueId===id && impact.stage==='frame')));
  let estimatedCostCny: number | null = null; let estimateError = '';
  try {
    if (shot.digitalHuman?.presenterMode === 'photo_talking') {
      estimatedCostCny = photoTalkingBudget({tenantId,cues:cues.filter(cue=>!reuseCueMaterialIds[cue.id]),frameCount:pendingFrames.length,
        fixedHeygenReserveCny:Number(env.STUDIO_HEYGEN_RESERVE_CNY),env}).totalCny;
    } else {
      const plan = planSeedanceReplication({cues,reuseCueMaterialIds,compositionClusterIds:pendingFrames.map(cluster=>cluster.id),
        resolution:env.SEEDANCE_SENTENCE_RESOLUTION==='480p'?'480p':'720p',firstFrameCostCny:Number(env.SEEDREAM_FIRST_FRAME_ESTIMATED_CNY||0.22)});
      if (plan.invalidCueIds.length) throw new Error('请先调整人物镜头生成时长至 4–15 秒');
      estimatedCostCny = plan.estimatedCostCny;
    }
  } catch(error) {estimateError=error instanceof Error?error.message:String(error);}
  return {impacts,estimatedCostCny,estimateError,reuseCueMaterialIds,reuseCueQuality};
}
