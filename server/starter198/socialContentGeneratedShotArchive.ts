import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { generatedAssetArchive } from '../lib/generatedAssetArchive.js';
import type { SocialAssetSupplyExecution } from './socialContentAssetSupplyExecution.js';
import type { SocialProductionAsset } from './socialContentProductionPlan.js';
import { socialObject, socialRequestHash, socialText } from './socialContentValidation.js';

export type SocialGeneratedShotArchiveCandidate = {
  sceneId: string;
  assetGenerationKind: 'product_scene' | 'concept_visual' | 'motion_graphics';
  asset: SocialProductionAsset;
  execution: SocialAssetSupplyExecution['shots'][number];
};

/** Select only media created by this supply run. Customer uploads, licensed
 * stock and digital presenters already have their own ownership/archive path
 * and must not be duplicated into the non-person generation collection. */
export function socialGeneratedShotArchiveCandidates(input: {
  assets: SocialProductionAsset[];
  execution: SocialAssetSupplyExecution | null;
}): SocialGeneratedShotArchiveCandidate[] {
  if (!input.execution) return [];
  const assets = new Map(input.assets.map(asset => [asset.id, asset]));
  return input.execution.shots.flatMap(execution => {
    if (!execution.provenance.synthetic) return [];
    const assetGenerationKind = execution.sourceStrategy === 'aigc_product_scene_replication'
      ? 'product_scene' as const
      : execution.sourceStrategy === 'non_evidentiary_ai_visual'
        ? 'concept_visual' as const
        : ['motion_graphics', 'verified_fact_card'].includes(execution.sourceStrategy)
          ? 'motion_graphics' as const
          : null;
    if (!assetGenerationKind) return [];
    const asset = assets.get(execution.assetId);
    return asset ? [{ sceneId: execution.sceneId, assetGenerationKind, asset, execution }] : [];
  });
}

function archiveMimeType(asset: SocialProductionAsset): string {
  if (asset.type === 'image') {
    const ext = path.extname(asset.localPath || asset.url).toLowerCase();
    return ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
  }
  return path.extname(asset.localPath || asset.url).toLowerCase() === '.webm' ? 'video/webm' : 'video/mp4';
}

export async function archiveSocialGeneratedShots(input: {
  tenantId: string;
  taskId: string;
  assets: SocialProductionAsset[];
  execution: SocialAssetSupplyExecution | null;
  now?: Date;
  archiveMedia?: typeof generatedAssetArchive.archiveNewMedia;
}): Promise<void> {
  const adoptedAt = (input.now ?? new Date()).toISOString();
  for (const candidate of socialGeneratedShotArchiveCandidates(input)) {
    const { asset, execution } = candidate;
    if (!asset.localPath && !asset.objectKey) {
      throw new Error(`generated_asset_archive_media_missing:${candidate.sceneId}`);
    }
    let contentSha256 = socialText(asset.contentHash).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(contentSha256) && asset.localPath) {
      contentSha256 = createHash('sha256').update(await fsp.readFile(asset.localPath)).digest('hex');
    }
    const segment = socialObject(asset.segments[0]) ?? {};
    const providerTaskId = socialText(asset.providerTaskId || segment.providerTaskId);
    const idempotencyKey = socialText(asset.idempotencyKey || segment.idempotencyKey)
      || socialRequestHash({ taskId: input.taskId, sceneId: candidate.sceneId, assetId: asset.id });
    const generationExecutionId = providerTaskId || idempotencyKey;
    const qualityReport = segment.quality ?? null;
    const archived = await (input.archiveMedia ?? generatedAssetArchive.archiveNewMedia)({
      tenantId: input.tenantId,
      ...(asset.automaticMaterial?{automaticMaterial:asset.automaticMaterial}:{}),
      name: asset.name,
      media: {
        type: asset.type,
        ...(asset.localPath ? { localPath: asset.localPath } : {}),
        ...(asset.objectKey ? { objectKey: asset.objectKey } : {}),
        mimeType: archiveMimeType(asset),
        duration: asset.duration,
        contentSha256,
      },
      generation: {
        pipelineId: 'non_person_generation',
        assetGenerationKind: candidate.assetGenerationKind,
        pipelineVersion: 'social-content.asset-supply-execution.v1',
        executionId: generationExecutionId,
        provider: execution.providerId,
        model: socialText(segment.model) || execution.providerId,
        ...(providerTaskId ? { providerTaskId } : {}),
        idempotencyKey,
        inputFingerprint: socialRequestHash({ taskId: input.taskId, sceneId: candidate.sceneId, assetId: asset.id, idempotencyKey }),
        promptOrSpecHash: socialRequestHash({ sceneId: candidate.sceneId, segment, strategy: execution.sourceStrategy }),
        inputMaterialIds: Array.from(new Set([
          ...(execution.truthBoundary.customerEvidenceRefs ?? []),
          ...[segment.productIdentityRefs].flatMap(value => Array.isArray(value) ? value.map(socialText) : []),
        ].filter(Boolean))),
        ...(Number.isFinite(Number(segment.estimatedCostCny)) ? { estimatedCostCny: Number(segment.estimatedCostCny) } : {}),
        ...(typeof segment.actualCostCny === 'number' && Number.isFinite(segment.actualCostCny) && segment.actualCostCny >= 0 ? { actualCostCny: segment.actualCostCny } : {}),
      },
      lineage: { sourceTaskId: input.taskId, sourceShotId: candidate.sceneId },
      quality: {
        state: 'accepted',
        policyVersion: 'social-generated-shot.v1',
        checkedAt: adoptedAt,
        checks: [
          { key: 'provider_completed', status: 'passed', evidence: `${execution.providerId}:${providerTaskId || asset.sourceId}` },
          { key: 'truth_boundary', status: 'passed', evidence: execution.provenance.representation },
          ...(qualityReport ? [{ key: 'pipeline_quality', status: 'passed' as const, evidence: 'adapter_quality_gate_passed' }] : []),
          ...(asset.automaticMaterial?.requirement.evidenceRequirement==='product_identity'? [{key:'product_identity',status:'passed' as const,evidence:asset.automaticMaterial.independentVisualCheckRef}]:[]),
        ],
        ...(qualityReport ? { rawReport: qualityReport } : {}),
      },
      rightsScope: 'tenant_generated_reusable',
    });
    execution.archivedMaterial = {
      materialId: archived.id,
      materialRevision: contentSha256,
      generationExecutionId,
      adoptedAt,
    };
  }
}
