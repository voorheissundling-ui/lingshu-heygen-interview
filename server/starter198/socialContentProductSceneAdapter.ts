import {canonicalMaterialAspectRatio} from '../lib/weeklyAutomaticMaterialProducer.js';
import {runVisualFfmpeg} from '../lib/renderVisualQuality.js';
import type {SocialAccountProductionConstraints} from './socialAccountProductionConstraints.js';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isInternalBudgetExemptTenant } from '../lib/tenantBudgetExemption.js';
import type { SocialMaterialRouting } from '../../shared/contracts/socialContentReplication.js';
import type { SocialProductSceneReplicationSpec } from '../../shared/contracts/socialContentWorkflow.js';
import type {
  SocialAssetSupplyAdapterContext,
  SocialAssetSupplyProviderAdapter,
} from './socialContentAssetSupplyExecution.js';
import type { SocialProductionAsset } from './socialContentProductionPlan.js';

export interface ProductSceneReferenceImage {
  assetId: string;
  productRef: string;
  url: string;
  localPath?: string;
  objectKey?: string;
  contentHash: string | null;
  authorizationRef?: string | null;
}

export interface ProductSceneQualityReport {
  productIdentitySimilarity: Record<string, number>;
  packagingVisibilityPassed: boolean;
  subjectVisibilityPassed: boolean;
  labelOcrExactMatch: boolean;
  sceneTopologyScore: number;
  productSlotLayoutScore: number;
  cameraTrajectoryScore: number;
  evidenceRefs: string[];
}

export interface CompletedProductSceneExecution {
  status: 'completed';
  providerId: string;
  providerTaskId: string;
  model: string;
  localPath: string;
  url?: string;
  contentHash: string;
  duration: number;
  actualCostCny: number | null;
  estimatedCostCny?: number;
  quality: ProductSceneQualityReport;
}

export interface ProductSceneExecutionPorts {
  maximumCostCny: number;
  execute(input: {
    tenantId: string;
    taskId: string;
    shotId: string;
    idempotencyKey: string;
    spec: SocialProductSceneReplicationSpec;
    materialRouting?: SocialMaterialRouting;
    referenceImages: ProductSceneReferenceImage[];
    outputDirectory: string;
    maximumCostCny: number;
    accountPlaybookConstraints?:SocialAccountProductionConstraints;
  }): Promise<CompletedProductSceneExecution | { status: 'failed' | 'pending' | 'uncertain'; providerTaskId?: string; error: string }>;
}

function stableKey(input: {
  tenantId: string;
  taskId: string;
  operationId?: string;
  accountConstraintHash?:string;
  shotId: string;
  spec: SocialProductSceneReplicationSpec;
  references: ProductSceneReferenceImage[];
}): string {
  return `social-product-scene:${createHash('sha256').update(JSON.stringify({
    tenantId: input.tenantId,
    taskId: input.taskId,
    operationId: input.operationId,
    ...(input.accountConstraintHash?{accountConstraintHash:input.accountConstraintHash}:{}),
    shotId: input.shotId,
    spec: input.spec,
    references: input.references.map(item => ({
      assetId: item.assetId,
      productRef: item.productRef,
      contentHash: item.contentHash,
      url: item.contentHash ? null : item.url,
    })),
  })).digest('hex')}`;
}

function references(context: SocialAssetSupplyAdapterContext, spec: SocialProductSceneReplicationSpec): ProductSceneReferenceImage[] | null {
  const rows: ProductSceneReferenceImage[] = [];
  for (const group of spec.productIdentity.groups) {
    for (const referenceImageId of group.referenceImageIds) {
      const asset = context.availableAssets.find(item => item.id === referenceImageId || item.sourceId === referenceImageId);
      if (!asset || asset.type !== 'image' || !asset.url) return null;
      rows.push({
        assetId: asset.id,
        productRef: group.productRef,
        url: asset.url,
        ...(asset.localPath ? { localPath: asset.localPath } : {}),
        ...(asset.objectKey ? { objectKey: asset.objectKey } : {}),
        contentHash: asset.contentHash || null,
        authorizationRef: asset.authorizationRef || null,
      });
    }
  }
  return rows.length ? rows : null;
}

function score(value: unknown): number {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function qualityFailure(spec: SocialProductSceneReplicationSpec, quality: ProductSceneQualityReport): string | null {
  const missingIdentity = spec.productIdentity.groups
    .filter(group => score(quality.productIdentitySimilarity[group.productRef]) < spec.productIdentity.identitySimilarityMinimum)
    .map(group => group.productRef);
  if (missingIdentity.length) return `product_identity_failed:${missingIdentity.join(',')}`;
  if (spec.productIdentity.ocrExactMatchRequired && !quality.labelOcrExactMatch) return 'label_ocr_failed';
  if (score(quality.sceneTopologyScore) < 0.75) return 'scene_topology_failed';
  if (score(quality.productSlotLayoutScore) < 0.75) return 'product_slot_layout_failed';
  if (score(quality.cameraTrajectoryScore) < 0.75) return 'camera_trajectory_failed';
  if (!quality.evidenceRefs.length) return 'quality_evidence_missing';
  return null;
}

function outputAsset(input: {
  context: SocialAssetSupplyAdapterContext;
  spec: SocialProductSceneReplicationSpec;
  execution: CompletedProductSceneExecution;
  idempotencyKey: string;
  aspectRatio:string;
}): SocialProductionAsset {
  const authorizedRefs=input.spec.productIdentity.groups.flatMap(group=>group.referenceImageIds).map(id=>input.context.availableAssets.find(asset=>asset.id===id)?.authorizationRef||'');
  const rightsReady=authorizedRefs.length>0&&authorizedRefs.every(Boolean);
  const disclosure = 'AIGC 产品场景·真实产品身份锁定·非客户实拍场景';
  return {
    ...(rightsReady&&input.aspectRatio?{automaticMaterial:{requirement:{subjectRef:input.spec.productIdentity.groups.map(g=>g.productRef).join('|'),action:input.spec.cameraLock.movementPath,scene:input.spec.sceneLock.environment,evidenceRequirement:'product_identity',aspectRatio:input.aspectRatio,minimumDurationSeconds:input.spec.cameraLock.durationSeconds,authorizationScope:'tenant_generated_reusable'},independentVisualCheckRef:input.execution.quality.evidenceRefs.join('|'),rightsEvidenceRef:authorizedRefs.join('|'),authorizationScopes:['tenant_generated_reusable']}}:{}),
    id: `product-scene-${input.context.taskId}-${input.context.shot.shotId}`,
    name: `AIGC 产品场景复刻·${input.context.shot.shotId}`,
    type: 'video',
    sourceId: `${input.execution.providerId}:${input.execution.providerTaskId}`,
    url: input.execution.url || input.execution.localPath,
    localPath: input.execution.localPath,
    contentHash: input.execution.contentHash,
    providerId: input.execution.providerId,
    providerTaskId: input.execution.providerTaskId,
    idempotencyKey: input.idempotencyKey,
    duration: input.execution.duration,
    visualObservations: [
      disclosure,
      `场景模板 ${input.spec.sceneTemplateKey}`,
      `产品槽位 ${input.spec.sceneLock.productSlots.length} 个`,
      `镜头轨迹 ${input.spec.cameraLock.movementPath}`,
    ],
    segments: [{
      providerId: input.execution.providerId,
      providerTaskId: input.execution.providerTaskId,
      model: input.execution.model,
      sceneTemplateKey: input.spec.sceneTemplateKey,
      productSceneSpecVersion: input.spec.schemaVersion,
      productIdentityRefs: input.spec.productIdentity.groups.flatMap(group => group.referenceImageIds),
      validationEvidenceRefs: input.execution.quality.evidenceRefs,
      quality: input.execution.quality,
      actualCostCny: input.execution.actualCostCny,
      ...(input.execution.estimatedCostCny !== undefined ? {estimatedCostCny:input.execution.estimatedCostCny} : {}),
      idempotencyKey: input.idempotencyKey,
      disclosure,
    }],
    selectionOrigin: 'system_graphic',
  };
}

/**
 * Provider-neutral execution gate. A deployment can register Seedance, Veo or
 * another image-conditioned video provider, but completion is accepted only
 * when product identity, scene topology, slot layout and camera path all pass.
 */
export function createSocialProductSceneAdapter(ports: ProductSceneExecutionPorts): SocialAssetSupplyProviderAdapter {
  const maximumCostCny = Math.max(0, ports.maximumCostCny);
  return {
    adapterId: 'controlled_product_scene_replication.v1',
    sourceStrategies: ['aigc_product_scene_replication'],
    async execute(context) {
      const spec = context.shot.productSceneReplication;
      if (!spec || !context.shot.truthBoundary.syntheticVisualAllowed || context.shot.truthBoundary.customerEvidenceRequired) return null;
      const productReferences = references(context, spec);
      if (!productReferences) return null;
      const idempotencyKey = stableKey({ tenantId: context.tenantId, taskId: context.taskId,
        operationId: context.operationId, accountConstraintHash:context.accountPlaybookConstraints?.constraintHash,shotId: context.shot.shotId, spec, references: productReferences });
      const execution = await ports.execute({ tenantId: context.tenantId, taskId: context.taskId,
        shotId: context.shot.shotId, idempotencyKey, spec: structuredClone(spec),
        ...(context.shot.materialRouting ? {materialRouting:structuredClone(context.shot.materialRouting)} : {}),
        ...(context.accountPlaybookConstraints?{accountPlaybookConstraints:structuredClone(context.accountPlaybookConstraints)}:{}),
        referenceImages: productReferences, outputDirectory: context.outputDirectory, maximumCostCny });
      if (execution.status !== 'completed') {
        throw new Error(`product_scene_not_completed:${execution.status}:${execution.providerTaskId || 'no_task'}:${execution.error}`);
      }
      if (execution.providerId === 'local-product-low-motion' || /zoompan|still[-_ ]?image/i.test(execution.model)) {
        throw new Error('product_scene_still_image_motion_forbidden');
      }
      const admissionCost=execution.estimatedCostCny??execution.actualCostCny;
      if (admissionCost===null||!Number.isFinite(admissionCost)
        || (!isInternalBudgetExemptTenant(context.tenantId) && admissionCost>maximumCostCny)) throw new Error('product_scene_cost_exceeds_shot_budget');
      const expectedDuration = spec.cameraLock.durationSeconds;
      if (Math.abs(execution.duration - expectedDuration) > spec.tolerance.durationSeconds) {
        throw new Error('product_scene_duration_out_of_tolerance');
      }
      const failed = qualityFailure(spec, execution.quality);
      if (failed) throw new Error(`product_scene_quality_failed:${failed}`);
      const output = await stat(execution.localPath).catch(() => null);
      if (!output?.isFile() || output.size < 1 || !execution.contentHash || !execution.providerTaskId) {
        throw new Error('product_scene_output_invalid');
      }
      const probe=await runVisualFfmpeg(['-i',execution.localPath,'-vf','showinfo','-frames:v','1','-f','null','-'],false,{logLevel:'info'});const size=probe.stderr.match(/s:(\d+)x(\d+)/);
      const asset = outputAsset({ context, spec, execution, idempotencyKey,aspectRatio:probe.ok&&size?canonicalMaterialAspectRatio(Number(size[1]),Number(size[2])):'' });
      return {
        asset,
        sourceStrategy: 'aigc_product_scene_replication',
        providerId: execution.providerId,
        sourceRef: execution.providerTaskId,
        synthetic: true,
        representation: 'non_evidentiary_visual',
        authorizationRef: null,
        disclosure: 'AIGC 产品场景·真实产品身份锁定·非客户实拍场景',
      };
    },
  };
}
