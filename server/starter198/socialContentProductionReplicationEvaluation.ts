import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type {ProductionAsset} from './socialContentAutoProduction.js';
import {writeExecutionStage} from './socialContentProductionRuntimeSupport.js';
import {evaluateSocialReplicationResult} from './replicationEvaluationAdapter.js';
import type {readSocialTaskDetail} from './socialContentRecords.js';
import type {Starter198Repository} from './repository.js';
import {socialJson,socialObject,socialText} from './socialContentValidation.js';

type ProductionTaskDetail=NonNullable<Awaited<ReturnType<typeof readSocialTaskDetail>>>;

/** Resolve only tenant-owned, hash-checked reference bytes for media review. */
export async function resolveSocialProductionReferenceVideoPath(input:{
  repository:Starter198Repository;
  tenantId:string;
  detail:Pick<ProductionTaskDetail,'brief'|'referenceVideoAnalysis'|'sources'>;
  rawAssets:ProductionAsset[];
}):Promise<string|null>{
  const {detail,rawAssets}=input;
    const referenceSourceId = detail.referenceVideoAnalysis?.referenceSourceId;
    const referenceAsset = referenceSourceId
      ? rawAssets.find(asset => asset.sourceId === referenceSourceId || asset.id === referenceSourceId)
      : undefined;
    let referenceVideoPath = referenceAsset?.localPath && existsSync(referenceAsset.localPath)
      ? referenceAsset.localPath
      : null;
    // The original viral video is reference-only and is intentionally absent
    // from the production material pool. Resolve its tenant-owned cached bytes
    // independently for post-render evaluation, with both path and content
    // hash checks, so exclusion from editing does not erase QA evidence.
    if (!referenceVideoPath) {
      const reuse = detail.brief.referenceReuse;
      const recordId = socialText(reuse?.recordId || detail.referenceVideoAnalysis?.referenceRecordId);
      if (/^[a-zA-Z0-9_-]{8,100}$/.test(recordId)) {
        const record = await input.repository.dataStore?.getById<Record<string, unknown>>('trend_videos', recordId);
        const storedAnalysis = socialObject(socialJson(record?.aiAnalysis));
        const expectedSha = socialText(reuse?.contentSha256 || storedAnalysis?.contentSha256).toLowerCase();
        const relative = socialText(record?.videoFileId).replace(/\\/g, '/');
        const expectedRelative = `tenants/${input.tenantId}/reference-videos/${recordId}.mp4`;
        const mediaRoot = path.resolve(process.env.SOCIAL_CONTENT_MEDIA_ROOT || path.join(process.cwd(), 'data/media'));
        const candidate = path.resolve(mediaRoot, relative);
        const tenantRoot = path.resolve(mediaRoot, 'tenants', input.tenantId);
        const activeReference = detail.sources.filter(source => source.kind === 'reference_link' && source.status === 'active');
        if (/^[a-f0-9]{64}$/.test(expectedSha) && socialText(storedAnalysis?.analysisRunId)
          && activeReference.length === 1 && record && activeReference[0]!.sourceRef === record.sourceUrl
          && [record.tenantId, record.tenant_id].includes(input.tenantId)
          && relative === expectedRelative && candidate.startsWith(`${tenantRoot}${path.sep}`) && existsSync(candidate)) {
          const actualSha = createHash('sha256').update(await fsp.readFile(candidate)).digest('hex');
          if (actualSha === expectedSha) referenceVideoPath = candidate;
        }
      }
    }
  return referenceVideoPath;
}

/** Run the independent viral-replication evaluation after rendering. */
export async function evaluateSocialProductionReplication(input:{
  repository:Starter198Repository;
  tenantId:string;
  taskId:string;
  runId:string;
  runtime?:{evaluateReplication?:typeof evaluateSocialReplicationResult};
  detail:ProductionTaskDetail;
  agentWorkflow:NonNullable<ProductionTaskDetail['agentWorkflow']>;
  rawAssets:ProductionAsset[];
  productionResultId:string;
  outputPath:string;
  adaptedScript:string;
}){
  const {detail,agentWorkflow,productionResultId,adaptedScript}=input;
  let replicationEvaluation = null;
  if (agentWorkflow.replicationJob) {
    const referenceVideoPath=await resolveSocialProductionReferenceVideoPath(input);
    const referenceText = (detail.replicationScript?.shots ?? [])
      .map(shot => shot.spokenText || shot.captionText || shot.visualInstruction)
      .map(socialText).filter(Boolean).join('\n') || null;
    await writeExecutionStage({
      ...input,
      stage: 'media_evaluation',
      message: '独立媒体评估 Worker 正在核对爆点保真、身份替换、原创差异、复用风险和账号适配。',
      extra: {
        replicationJobId: agentWorkflow.replicationJob.replicationJobId,
        factorSpecVersion: agentWorkflow.replicationJob.factorSpecVersion,
      },
    });
    const evaluated = await (input.runtime?.evaluateReplication ?? evaluateSocialReplicationResult)({
      workflow: agentWorkflow,
      referenceAnalysis: detail.referenceVideoAnalysis ?? null,
      replicationScript: detail.replicationScript ?? null,
      productionResultId,
      outputVideoPath: input.outputPath,
      evidence: {
        referenceVideoPath,
        referenceText,
        outputText: adaptedScript,
      },
    });
    replicationEvaluation = evaluated.evaluation;
  }

  return replicationEvaluation;
}
