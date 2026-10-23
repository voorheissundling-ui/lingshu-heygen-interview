import type { Starter198Repository } from './repository.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { MaterialScriptAnalysis } from '../../shared/materialScriptAnalysis.js';
import type { SocialAssetSupplyPlan } from '../../shared/contracts/socialContentReplication.js';
import type { SocialTaskBudgetScope } from '../lib/socialContentTaskBudget.js';
import type { SocialProductionAsset } from './socialContentProductionPlan.js';
import type { StoredSocialScriptBaseline } from './socialContentScriptBaseline.js';
import { existingAssetSupplyAdapters } from './socialContentProductionSupport.js';
import { paidProductionHash, type PaidStageRequirement, type VerifiedLocalExecution } from './socialContentPaidOperationPlan.js';

export const LOCAL_SUPPLY_EXECUTOR = 'existing_customer_asset.v1' as const;
export interface CanonicalLocalSupplyMaterial {
  tenantId: string;
  materialId: string;
  sourceRef: string;
  contentSha256: string;
  localPath: string;
  synthetic: boolean;
  scriptAnalysis: MaterialScriptAnalysis;
}
/** Trusted server ports only. This is a readonly selection proof, never a vendor receipt. */
export function createSocialContentLocalSupplyBudgetProofReader(input: {
  scope: SocialTaskBudgetScope;
  supplyPlan: SocialAssetSupplyPlan;
  baseline: StoredSocialScriptBaseline;
  assets: SocialProductionAsset[];
  assertCurrent(scope: SocialTaskBudgetScope): Promise<void>;
  repository: Pick<Starter198Repository, 'materialLibrary' | 'dataStore'>;
  readCanonicalMaterial?(sourceRef: string): Promise<CanonicalLocalSupplyMaterial | null>;
}) {
  const frozen = structuredClone({ scope: input.scope, supplyPlan: input.supplyPlan, baseline: input.baseline, assets: input.assets });
  return async (requirement: PaidStageRequirement): Promise<VerifiedLocalExecution | null> => {
    if (requirement.stage !== 'local_supply_selection' || !requirement.shotId) return null;
    await input.assertCurrent(frozen.scope);
    const shot = frozen.supplyPlan.shots.find(item => item.shotId === requirement.shotId);
    const scene = frozen.baseline.scenes.find(item => item.sceneId === requirement.shotId);
    const selected = shot?.selectedMaterialSegment;
    const route = shot?.materialRouting;
    if (shot && scene && ['motion_graphics','verified_fact_card'].includes(shot.sourceStrategy)
      && requirement.key === `scene:${shot.shotId}:${shot.sourceStrategy}`
      && /^[a-f0-9]{64}$/.test(requirement.inputContractHash)) {
      const adapter=existingAssetSupplyAdapters().find(item=>item.sourceStrategies.includes(shot.sourceStrategy));
      if(!adapter)throw new Error('local_supply_executor_missing');
      const outputDirectory=await mkdtemp(path.join(os.tmpdir(),'social-local-graphics-proof-'));
      try{
        const result=await adapter.execute({tenantId:frozen.scope.tenantId,taskId:frozen.scope.taskId,
          outputDirectory,shot,baselineScene:scene,availableAssets:[]});
        if(!result?.synthetic||result.providerId!==adapter.adapterId||result.sourceStrategy!==shot.sourceStrategy
          ||result.asset.type!=='video'||!result.asset.localPath||!result.asset.contentHash
          ||!Number.isFinite(result.asset.duration)||requirement.durationSeconds===null
          ||result.asset.duration+1e-6<requirement.durationSeconds)return null;
        const outputSha256=createHash('sha256').update(await readFile(result.asset.localPath)).digest('hex');
        if(outputSha256!==result.asset.contentHash)return null;
        await input.assertCurrent(frozen.scope);
        const sourceSha256=paidProductionHash({executor:adapter.adapterId,scope:frozen.scope,
          inputContractHash:requirement.inputContractHash,shot,scene});
        return{kind:'local_render',scopeHash:paidProductionHash(frozen.scope),inputContractHash:requirement.inputContractHash,
          sourceSha256,sourceRef:shot.shotId,receiptRef:`local_render:${paidProductionHash({executor:adapter.adapterId,
            inputContractHash:requirement.inputContractHash,sourceSha256,outputSha256,duration:result.asset.duration})}`};
      }finally{await rm(outputDirectory,{recursive:true,force:true});}
    }
    if (shot && scene && shot.sourceStrategy === 'customer_product_image_animation'
      && requirement.key === `scene:${shot.shotId}:customer_product_image_animation`
      && /^[a-f0-9]{64}$/.test(requirement.inputContractHash)) {
      const readLibrary = input.repository.materialLibrary;
      if (!readLibrary) throw new Error('local_supply_canonical_reader_missing');
      const inventory = await readLibrary(frozen.scope.tenantId, { dataStore: input.repository.dataStore });
      if (inventory.status === 'unavailable') throw new Error('local_supply_inventory_unavailable');
      const candidates = frozen.assets.filter(asset => asset.type === 'image'
        && shot.sourceRefs.some(ref => ref === asset.id || ref === asset.sourceId));
      if (candidates.length !== 1) return null;
      const asset = candidates[0]!;
      const record = inventory.items.find(item => item.id === asset.id);
      const expectedHash = String(record?.contentSha256 || record?.sha256 || '');
      if (!record || String(record.tenantId || record.tenant_id || '') !== frozen.scope.tenantId
        || record.type !== 'image' || record.scope === 'shared' || !asset.localPath
        || asset.contentHash !== expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash)) return null;
      const sourceHash = createHash('sha256').update(await readFile(asset.localPath)).digest('hex');
      if (sourceHash !== expectedHash) throw new Error('local_supply_source_bytes_changed');
      const adapter = existingAssetSupplyAdapters().find(item => item.adapterId === LOCAL_SUPPLY_EXECUTOR);
      if (!adapter) throw new Error('local_supply_executor_missing');
      const outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'social-product-motion-proof-'));
      try {
        const result = await adapter.execute({ tenantId: frozen.scope.tenantId, taskId: frozen.scope.taskId,
          outputDirectory, shot, baselineScene: scene, availableAssets: [asset] });
        if (!result || !result.synthetic || result.providerId !== LOCAL_SUPPLY_EXECUTOR
          || result.sourceStrategy !== 'customer_product_image_animation'
          || result.asset.type !== 'video' || !/^[a-f0-9]{64}$/.test(result.asset.contentHash || '')) return null;
        await input.assertCurrent(frozen.scope);
        return { kind: 'local_render', scopeHash: paidProductionHash(frozen.scope),
          inputContractHash: requirement.inputContractHash, sourceSha256: sourceHash, sourceRef: asset.id,
          receiptRef: `local_render:${paidProductionHash({ executor: LOCAL_SUPPLY_EXECUTOR, scope: frozen.scope,
            inputContractHash: requirement.inputContractHash, sourceSha256: sourceHash,
            result: { contentHash: result.asset.contentHash, duration: result.asset.duration } })}` };
      } finally { await rm(outputDirectory, { recursive: true, force: true }); }
    }
    if (!shot || !scene || shot.sourceStrategy !== 'customer_real_asset' || !selected
      || !route || route.policy !== 'local_only' && route.policy !== 'local_first_product_i2v'
      || route.localMatch.state !== 'matched' || !route.localMatch.evidenceRef
      || !route.localMatch.sourceRefs.includes(selected.sourceRef) || !shot.sourceRefs.includes(selected.sourceRef)
      || requirement.key !== `scene:${shot.shotId}:customer_real_asset`
      || !/^[a-f0-9]{64}$/.test(requirement.inputContractHash)) return null;
    const readLibrary = input.repository.materialLibrary;
    if (!readLibrary) throw new Error('local_supply_canonical_reader_missing');
    const inventory = await readLibrary(frozen.scope.tenantId, { dataStore: input.repository.dataStore });
    if (inventory.status === 'unavailable') throw new Error('local_supply_inventory_unavailable');
    const candidate = frozen.assets.find(item => item.sourceId === selected.sourceRef || item.id === selected.sourceRef);
    const record = inventory.items.find(item => item.id === candidate?.id);
    if (!record || String(record.tenantId || record.tenant_id || '') !== frozen.scope.tenantId
      || record.type !== 'video' || record.synthetic === true || /generated|synthetic|aigc/i.test(String(record.sourceType || ''))
      || !record.scriptAnalysis) return null;
    const canonical: CanonicalLocalSupplyMaterial | null = input.readCanonicalMaterial
      ? await input.readCanonicalMaterial(selected.sourceRef)
      : candidate?.localPath ? { tenantId: frozen.scope.tenantId, materialId: record.id, sourceRef: selected.sourceRef,
        contentSha256: String(record.contentSha256 || record.sha256 || ''), localPath: candidate.localPath,
        synthetic: false, scriptAnalysis: record.scriptAnalysis } : null;
    if (canonical && (canonical.contentSha256 !== String(record.contentSha256 || record.sha256 || '')
      || canonical.materialId !== record.id
      || paidProductionHash(canonical.scriptAnalysis) !== paidProductionHash(record.scriptAnalysis))) return null;
    if (!canonical || canonical.tenantId !== frozen.scope.tenantId || canonical.synthetic
      || canonical.sourceRef !== selected.sourceRef || !/^[a-f0-9]{64}$/.test(canonical.contentSha256)) return null;
    const asset = frozen.assets.find(item => item.id === canonical.materialId && item.type === 'video'
      && (item.sourceId === selected.sourceRef || item.id === selected.sourceRef));
    if (!asset || asset.contentHash !== canonical.contentSha256 || !canonical.localPath
      || canonical.scriptAnalysis.status !== 'ready'
      || !canonical.scriptAnalysis.sourceRevision
      || paidProductionHash(asset.scriptAnalysis) !== paidProductionHash(canonical.scriptAnalysis)) return null;
    const segment = canonical.scriptAnalysis.shots.find(item => item.segmentId === selected.segmentId);
    if (!segment || segment.needsReview || !Number.isFinite(selected.startSeconds) || !Number.isFinite(selected.endSeconds)
      || selected.startSeconds < segment.startSeconds || selected.endSeconds > segment.endSeconds
      // Container time bases can report 3.9999967 for an exact four-second
      // source. Permit only sub-millisecond measurement quantization; this
      // must not authorize a genuinely shorter source or padded scene.
      || selected.endSeconds <= selected.startSeconds || selected.endSeconds - asset.duration > 0.001
      || requirement.durationSeconds === null || requirement.durationSeconds <= 0
      || selected.endSeconds - selected.startSeconds < requirement.durationSeconds) return null;
    const sha = createHash('sha256').update(await readFile(canonical.localPath)).digest('hex');
    if (sha !== canonical.contentSha256) throw new Error('local_supply_source_bytes_changed');
    const adapter = existingAssetSupplyAdapters().find(item => item.adapterId === LOCAL_SUPPLY_EXECUTOR);
    if (!adapter) throw new Error('local_supply_executor_missing');
    const result = await adapter.execute({ tenantId: frozen.scope.tenantId, taskId: frozen.scope.taskId,
      outputDirectory: '', shot, baselineScene: scene,
      availableAssets: [{ ...asset, localPath: canonical.localPath, scriptAnalysis: canonical.scriptAnalysis }] });
    if (!result || result.synthetic || result.providerId !== LOCAL_SUPPLY_EXECUTOR
      || result.sourceStrategy !== 'customer_real_asset' || result.sourceRef !== selected.sourceRef
      || result.asset.id !== canonical.materialId || result.asset.type !== 'video'
      || result.asset.scriptAnalysis?.shots.length !== 1
      || result.asset.scriptAnalysis.shots[0].segmentId !== selected.segmentId) return null;
    await input.assertCurrent(frozen.scope);
    return { kind: 'existing_media', scopeHash: paidProductionHash(frozen.scope),
      inputContractHash: requirement.inputContractHash, sourceSha256: sha, sourceRef: selected.sourceRef,
      receiptRef: `local_selection:${paidProductionHash({ executor: LOCAL_SUPPLY_EXECUTOR, scope: frozen.scope,
        inputContractHash: requirement.inputContractHash, sourceSha256: sha, selected,
        analysisHash: paidProductionHash(canonical.scriptAnalysis), result: { assetId: result.asset.id, sourceRef: result.sourceRef } })}` };
  };
}
