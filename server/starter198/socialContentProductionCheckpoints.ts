import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  readCurrentContentExecutionCheckpoint,
  recordCurrentContentExecutionCheckpoint,
} from '../contentExecution/context.js';
import type { ContentProviderReceiptState } from '../contentExecution/context.js';
import type { MaterialScriptAnalysis } from '../../shared/materialScriptAnalysis.js';
import type { SocialAssetSupplyPlan } from '../../shared/contracts/socialContentWorkflow.js';
import type { VoiceQualityReport } from '../lib/voiceQuality.js';
import type { SocialProductionAsset } from './socialContentProductionPlan.js';
import { socialRequestHash } from './socialContentValidation.js';

export const SOCIAL_MATERIAL_ANALYSIS_CHECKPOINT = 'social.material_analysis';
export const SOCIAL_MATERIAL_ANALYSIS_CHECKPOINT_VERSION = '1';
export const SOCIAL_NARRATION_AUDIO_CHECKPOINT = 'social.narration_audio';
export const SOCIAL_NARRATION_AUDIO_CHECKPOINT_VERSION = '1';

/** A prior non-failed TTS handoff without a verified audio checkpoint is an
 * ambiguous paid-provider result. The worker must recover/fail closed instead
 * of issuing a second charge, including when the receipt says completed but
 * the durable audio is unavailable on this host. */
export function narrationReceiptRequiresRecovery(
  state: ContentProviderReceiptState | null | undefined,
): boolean {
  return Boolean(state && state !== 'failed');
}

type AnalysisFailure = { assetId: string; assetName: string; reason: string };

type AnalyzedAssetCheckpoint = {
  assetId: string;
  sourceFingerprint: string;
  duration: number;
  visualObservations: string[];
  segments: Array<Record<string, unknown>>;
  scriptAnalysis?: MaterialScriptAnalysis;
};

type MaterialAnalysisCheckpoint = {
  analyzedAssets: AnalyzedAssetCheckpoint[];
  failures: AnalysisFailure[];
};

export type ProductionAssetAnalysisResult = {
  assets: SocialProductionAsset[];
  failures: AnalysisFailure[];
};

/** Inventory audits are observation-time diagnostics. They include scannedAt
 * and can also change when an unrelated library item is inspected, so they
 * must not invalidate an otherwise identical paid asset-supply checkpoint. */
export function socialAssetSupplyCheckpointInputHash(input: {
  materialAnalysisInputHash: string;
  baselineVersion: string;
  assetSupplyPlan: SocialAssetSupplyPlan;
  executionPlanId: string;
  executionPlanVersion: string;
}): string {
  const { inventoryAudit: _inventoryAudit, ...stableAssetSupplyPlan } = input.assetSupplyPlan;
  return socialRequestHash({
    materialAnalysisInputHash: input.materialAnalysisInputHash,
    baselineVersion: input.baselineVersion,
    assetSupplyPlan: stableAssetSupplyPlan,
    executionPlanId: input.executionPlanId,
    executionPlanVersion: input.executionPlanVersion,
  });
}

export type DurableSelectedProductionAsset = {
  assetId: string;
  sourceId: string;
  contentHash: string | null;
  asset?: SocialProductionAsset;
};

/** Restore both source-library assets and AIGC outputs. Generated outputs are
 * reusable only while their exact local bytes still exist; otherwise the
 * caller must re-enter the provider adapter, whose durable receipt reconciles
 * and downloads the prior task without another paid submission. */
export function restoreSocialAssetSupplyCheckpointAssets(input: {
  availableAssets: SocialProductionAsset[];
  selectedAssets: DurableSelectedProductionAsset[];
}): SocialProductionAsset[] | null {
  const availableById = new Map(input.availableAssets.map(asset => [asset.id, asset]));
  const restored = input.selectedAssets.map(selected => {
    const asset = availableById.get(selected.assetId);
    if (asset && asset.sourceId === selected.sourceId
      && (!selected.contentHash || selected.contentHash === (asset.contentHash ?? null))) return asset;
    const generated = selected.asset;
    return generated
      && generated.id === selected.assetId
      && generated.sourceId === selected.sourceId
      && Boolean(generated.providerTaskId || generated.idempotencyKey)
      && Boolean(generated.localPath && existsSync(generated.localPath))
      && (!selected.contentHash || generated.contentHash === selected.contentHash)
      ? structuredClone(generated)
      : null;
  });
  return restored.length === input.selectedAssets.length
    && restored.every((asset): asset is SocialProductionAsset => Boolean(asset))
    ? restored
    : null;
}

export type DurableNarrationVoice = {
  ok: true;
  source?: string;
  localPath: string;
  duration: number;
  text: string;
  cues: Array<{
    text: string;
    start: number;
    end: number;
    words?: Array<{ text: string; start: number; end: number }>;
  }>;
  alignmentSource?: string;
  qualityReport?: VoiceQualityReport;
};

type NarrationAudioCheckpoint = {
  narration: string;
  relativeAudioPath: string | null;
  audioSha256: string | null;
  voice: Omit<DurableNarrationVoice, 'localPath'>;
  captionCues?: unknown;
  renderTimeline?: unknown;
};

const DURABLE_TTS_ROOT = path.resolve(process.cwd(), 'data', 'tts');

async function sha256File(filePath: string): Promise<string> {
  return createHash('sha256').update(await fsp.readFile(filePath)).digest('hex');
}

function durableTtsRelativePath(filePath: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(`${DURABLE_TTS_ROOT}${path.sep}`)) return null;
  const relative = path.relative(DURABLE_TTS_ROOT, resolved);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : null;
}

export async function readNarrationAudioCheckpoint(input: {
  inputHash: string;
  narration: string;
}): Promise<DurableNarrationVoice | null> {
  const checkpoint = readCurrentContentExecutionCheckpoint<NarrationAudioCheckpoint>({
    stage: SOCIAL_NARRATION_AUDIO_CHECKPOINT,
    version: SOCIAL_NARRATION_AUDIO_CHECKPOINT_VERSION,
    inputHash: input.inputHash,
  });
  if (!checkpoint || checkpoint.narration !== input.narration
    || !checkpoint.relativeAudioPath || !checkpoint.audioSha256
    || checkpoint.voice.ok !== true || !checkpoint.voice.cues?.length) return null;
  const localPath = path.resolve(DURABLE_TTS_ROOT, checkpoint.relativeAudioPath);
  if (!localPath.startsWith(`${DURABLE_TTS_ROOT}${path.sep}`)) return null;
  try {
    const stat = await fsp.stat(localPath);
    if (!stat.isFile() || stat.size < 1 || await sha256File(localPath) !== checkpoint.audioSha256) return null;
  } catch {
    return null;
  }
  return { ...structuredClone(checkpoint.voice), localPath };
}

export async function recordNarrationAudioCheckpoint(input: {
  inputHash: string;
  narration: string;
  voice: DurableNarrationVoice;
  captionCues?: unknown;
  renderTimeline?: unknown;
}): Promise<boolean> {
  const relativeAudioPath = durableTtsRelativePath(input.voice.localPath);
  const audioSha256 = relativeAudioPath ? await sha256File(input.voice.localPath) : null;
  const { localPath: _localPath, ...voice } = input.voice;
  await recordCurrentContentExecutionCheckpoint({
    stage: SOCIAL_NARRATION_AUDIO_CHECKPOINT,
    version: SOCIAL_NARRATION_AUDIO_CHECKPOINT_VERSION,
    inputHash: input.inputHash,
    payload: {
      narration: input.narration,
      relativeAudioPath,
      audioSha256,
      voice,
      ...(input.captionCues !== undefined ? { captionCues: input.captionCues } : {}),
      ...(input.renderTimeline !== undefined ? { renderTimeline: input.renderTimeline } : {}),
    } satisfies NarrationAudioCheckpoint,
  });
  return Boolean(relativeAudioPath && audioSha256);
}

function sourceFingerprint(asset: SocialProductionAsset): string {
  return socialRequestHash({
    assetId: asset.id,
    sourceId: asset.sourceId,
    type: asset.type,
    contentHash: asset.contentHash ?? null,
    objectKey: asset.objectKey ?? null,
    // sourceId/contentHash/objectKey are preferred because temporary local
    // paths and signed URLs legitimately change after a worker restart.
    sourceFallback: asset.contentHash || asset.objectKey || asset.sourceId || asset.url || asset.id,
    duration: asset.duration,
    initialObservations: asset.visualObservations,
    initialSegments: asset.segments,
    explicitProductAssociation: asset.explicitProductAssociation ?? null,
    selectionOrigin: asset.selectionOrigin ?? null,
  });
}

export function socialMaterialAnalysisInputHash(input: {
  tenantId: string;
  assets: SocialProductionAsset[];
}): string {
  return socialRequestHash({
    tenantId: input.tenantId,
    assets: input.assets.map(asset => ({ id: asset.id, fingerprint: sourceFingerprint(asset) }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  });
}

function restoreCheckpoint(
  rawAssets: SocialProductionAsset[],
  checkpoint: MaterialAnalysisCheckpoint,
): ProductionAssetAnalysisResult | null {
  const rawById = new Map<string, SocialProductionAsset>();
  for (const asset of rawAssets) {
    if (rawById.has(asset.id)) return null;
    rawById.set(asset.id, asset);
  }
  const restored: SocialProductionAsset[] = [];
  for (const analyzed of checkpoint.analyzedAssets) {
    const raw = rawById.get(analyzed.assetId);
    if (!raw || sourceFingerprint(raw) !== analyzed.sourceFingerprint) return null;
    restored.push({
      ...raw,
      duration: analyzed.duration,
      visualObservations: structuredClone(analyzed.visualObservations),
      segments: structuredClone(analyzed.segments),
      ...(analyzed.scriptAnalysis ? { scriptAnalysis: structuredClone(analyzed.scriptAnalysis) } : {}),
    });
  }
  const accounted = new Set([
    ...restored.map(asset => asset.id),
    ...checkpoint.failures.map(failure => failure.assetId),
  ]);
  if (accounted.size !== rawAssets.length || rawAssets.some(asset => !accounted.has(asset.id))) return null;
  return { assets: restored, failures: structuredClone(checkpoint.failures) };
}

/**
 * Executes material analysis at most once for an exact set of source
 * revisions. The durable queue context owns the checkpoint, so a new browser,
 * login, HTTP process or worker process resumes from the same result.
 */
export async function analyzeSocialProductionAssetsWithCheckpoint(input: {
  tenantId: string;
  assets: SocialProductionAsset[];
  analyze(value: { tenantId: string; assets: SocialProductionAsset[] }): Promise<ProductionAssetAnalysisResult>;
}): Promise<ProductionAssetAnalysisResult & { checkpointReused: boolean; inputHash: string }> {
  const inputHash = socialMaterialAnalysisInputHash(input);
  const rawFingerprints = new Map(input.assets.map(asset => [asset.id, sourceFingerprint(asset)]));
  const checkpoint = readCurrentContentExecutionCheckpoint<MaterialAnalysisCheckpoint>({
    stage: SOCIAL_MATERIAL_ANALYSIS_CHECKPOINT,
    version: SOCIAL_MATERIAL_ANALYSIS_CHECKPOINT_VERSION,
    inputHash,
  });
  if (checkpoint) {
    const restored = restoreCheckpoint(input.assets, checkpoint);
    if (restored) return { ...restored, checkpointReused: true, inputHash };
  }

  const analyzed = await input.analyze({ tenantId: input.tenantId, assets: input.assets });
  await recordCurrentContentExecutionCheckpoint({
    stage: SOCIAL_MATERIAL_ANALYSIS_CHECKPOINT,
    version: SOCIAL_MATERIAL_ANALYSIS_CHECKPOINT_VERSION,
    inputHash,
    payload: {
      analyzedAssets: analyzed.assets.map(asset => ({
        assetId: asset.id,
        sourceFingerprint: rawFingerprints.get(asset.id) ?? sourceFingerprint(asset),
        duration: asset.duration,
        visualObservations: structuredClone(asset.visualObservations),
        segments: structuredClone(asset.segments),
        ...(asset.scriptAnalysis ? { scriptAnalysis: structuredClone(asset.scriptAnalysis) } : {}),
      })),
      failures: structuredClone(analyzed.failures),
    } satisfies MaterialAnalysisCheckpoint,
  });
  return { ...analyzed, checkpointReused: false, inputHash };
}
