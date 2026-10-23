import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { socialRequestHash } from './socialContentValidation.js';
import { alignSocialAssetSupplyPlanToBaseline, executeSocialAssetSupplyPlan, type SocialAssetSupplyAdapterResult, type SocialAssetSupplyProviderAdapter } from './socialContentAssetSupplyExecution.js';
import type { SocialAssetSupplyPlan } from '../../shared/contracts/socialContentWorkflow.js';
import type { StoredSocialScriptBaseline } from './socialContentScriptBaseline.js';
import type { PresenterMotherExecutionReceipt, PresenterSlotCropReceipt } from './presenterMotherSegmentExecution.js';

export const sceneReworkHash = (value: unknown): string => socialRequestHash(value);
export interface SocialSceneMediaCache {
  schemaVersion: 'social-scene-media-cache.v1';
  tenantId: string; taskId: string; runId: string; parentArtifactId: string;
  parentArtifactHash: string; planVersion: string; planHash: string;
  scenes: Array<{ sceneId: string; productionSceneId: string; shotHash: string; sha256: string; result: SocialAssetSupplyAdapterResult; technicalReceiptId: string; status: 'passed' | 'failed' | 'review_required'; presenterMotherLineage?:{groupingHash:string;providerReceipt:PresenterMotherExecutionReceipt;slotCropReceipt:PresenterSlotCropReceipt} }>;
  /** Whole audio and timing are frozen: visual-only retry must never regenerate narration. */
  renderInput: { sourceManifest: Record<string, unknown>;mediaRemap:Array<{source:string;target:string}>;manifest: Record<string, unknown>; voice: { localPath: string; sha256: string }; bgm: { localPath: string; sha256: string } | null };
  recordHash: string;
}
export interface SocialSceneReworkIntent {
  schemaVersion: 'social-scene-rework-intent.v1';
  tenantId: string; taskId: string; actorUserId: string; parentArtifactId: string;
  parentArtifactHash: string; cacheHash: string; sourceRunId: string; executionRunId: string; planVersion: string; planHash: string;
  affectedSceneIds: string[]; failedReceiptIds: string[]; operationId: string;
}
function fail(code: string): never { throw new Error(code); }
function exactIds(value: string[]): void {
  if (!Array.isArray(value) || !value.length || value.some(v => typeof v !== 'string' || !v.trim() || v !== v.trim()) || new Set(value).size !== value.length) fail('scene_rework_selection_invalid');
}
export function sealSocialSceneMediaCache(input: Omit<SocialSceneMediaCache, 'recordHash'>): SocialSceneMediaCache {
  return { ...input, recordHash: sceneReworkHash(input) };
}
export function createSocialSceneReworkIntent(cache: SocialSceneMediaCache, actorUserId: string, affectedSceneIds: string[], executionRunId: string): SocialSceneReworkIntent {
  exactIds(affectedSceneIds);
  if (!actorUserId.trim()) fail('scene_rework_actor_required');
  const selected = affectedSceneIds.map(id => cache.scenes.filter(scene => scene.sceneId === id));
  if (selected.some(matches => matches.length !== 1 || matches[0]!.status !== 'failed' || !matches[0]!.technicalReceiptId)) fail('scene_rework_failed_receipt_required');
  const value = { schemaVersion: 'social-scene-rework-intent.v1' as const, tenantId: cache.tenantId, taskId: cache.taskId, actorUserId,
    sourceRunId:cache.runId,parentArtifactId: cache.parentArtifactId, parentArtifactHash: cache.parentArtifactHash, cacheHash: cache.recordHash,
    planVersion: cache.planVersion, planHash: cache.planHash, affectedSceneIds: [...affectedSceneIds].sort(),
    failedReceiptIds: selected.map(matches => matches[0]!.technicalReceiptId).sort() };
  return { ...value, executionRunId, operationId: `scene_rework_${sceneReworkHash(value).slice(0, 24)}` };
}
/** Called only after the worker has read the persisted intent, parent artifact and cache under its task lease.
 * Supply stays on the existing truth-boundary executor; successful scenes cannot reach paid providers. */
export async function executeSocialSceneReworkSupply(input: {
  intent: SocialSceneReworkIntent; cache: SocialSceneMediaCache; actorUserId: string;
  parentArtifactHash: string; plan: SocialAssetSupplyPlan; baseline: StoredSocialScriptBaseline;
  outputDirectory: string; adapters: SocialAssetSupplyProviderAdapter[];
  verifyReceipt: (receiptId: string, sceneId: string, status: 'passed' | 'failed') => Promise<void>;
}) {
  const { cache, intent } = input;
  const { recordHash, ...payload } = cache;
  if (recordHash !== sceneReworkHash(payload)) fail('scene_rework_cache_integrity_invalid');
  const expected = createSocialSceneReworkIntent(cache, input.actorUserId, intent.affectedSceneIds, intent.executionRunId);
  if (sceneReworkHash(expected) !== sceneReworkHash(intent) || input.parentArtifactHash !== cache.parentArtifactHash) fail('scene_rework_intent_scope_invalid');
  const plan = alignSocialAssetSupplyPlanToBaseline({ plan: input.plan, baseline: input.baseline });
  if (plan.planVersion !== cache.planVersion || sceneReworkHash(plan) !== cache.planHash || cache.scenes.length !== plan.shots.length || new Set(cache.scenes.map(s => s.sceneId)).size !== cache.scenes.length) fail('scene_rework_plan_changed');
  for (const [index, shot] of plan.shots.entries()) {
    const sceneId = input.baseline.scenes[index]?.sceneId;
    const receipt = cache.scenes.find(s => s.sceneId === sceneId);
    if (!receipt || receipt.shotHash !== sceneReworkHash(shot)) fail('scene_rework_scene_binding_invalid');
    const affected = intent.affectedSceneIds.includes(receipt.sceneId);
    if (receipt.status !== (affected ? 'failed' : 'passed')) fail('scene_rework_unselected_failure');
    await input.verifyReceipt(receipt.technicalReceiptId, receipt.sceneId, affected ? 'failed' : 'passed');
    if (!affected) {
      if (!receipt.result.asset.localPath || !/^[a-f0-9]{64}$/.test(receipt.sha256)) fail('scene_rework_media_missing');
      if (createHash('sha256').update(await readFile(receipt.result.asset.localPath)).digest('hex') !== receipt.sha256) fail('scene_rework_media_hash_changed');
    }
  }
  for (const audio of [cache.renderInput.voice, cache.renderInput.bgm].filter(Boolean)) {
    if (!audio || !/^[a-f0-9]{64}$/.test(audio.sha256) || createHash('sha256').update(await readFile(audio.localPath)).digest('hex') !== audio.sha256) fail('scene_rework_audio_hash_changed');
  }
  const cacheAdapter: SocialAssetSupplyProviderAdapter = {
    adapterId: 'verified_scene_media_reuse', sourceStrategies: [...new Set(cache.scenes.map(s => s.result.sourceStrategy))],
    async execute(context) {
      if (intent.affectedSceneIds.includes(context.baselineScene.sceneId)) return null;
      const receipt = cache.scenes.find(s => s.sceneId === context.baselineScene.sceneId)!;
      return receipt.result.sourceStrategy === context.shot.sourceStrategy ? structuredClone(receipt.result) : null;
    },
  };
  const guarded = input.adapters.map(adapter => ({ ...adapter, async execute(context: Parameters<SocialAssetSupplyProviderAdapter['execute']>[0]) {
    if (!intent.affectedSceneIds.includes(context.baselineScene.sceneId)) return null;
    return adapter.execute(context);
  } }));
  return executeSocialAssetSupplyPlan({ tenantId: intent.tenantId, taskId: intent.taskId, outputDirectory: input.outputDirectory,
    operationId:intent.operationId, plan, baseline: input.baseline, availableAssets: cache.scenes.map(s => s.result.asset), adapters: [cacheAdapter, ...guarded] });
}
