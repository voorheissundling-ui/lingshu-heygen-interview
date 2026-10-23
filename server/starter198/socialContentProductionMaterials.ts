import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import sharp from 'sharp';
import type {
  SocialContentTaskBrief,
  SocialContentThemeId,
  SocialProductionResult,
  SocialTaskSource,
} from '../../shared/contracts/socialContentWorkflow.js';
import { inspectRenderedScenes, inspectRenderedVisuals, runVisualFfmpeg } from '../lib/renderVisualQuality.js';
import { readMaterialLibrary, type MaterialRecord } from '../lib/materialLibrary.js';
import { isReferenceOnlyMaterial } from '../lib/materialPolicy.js';
import { resolveSourceDurations } from '../lib/videoSourcePlan.js';
import {
  automationBgmAudio,
  automationBgmCatalog,
  readTenantEnterpriseProfile,
  synthesizeStudioVoiceForAutomation,
} from '../lib/socialContentLegacyPorts.js';
import { analyzeProductionMaterial } from '../digitalEmployees/productionMaterialAnalysis.js';
import { objectStorageEnabled, objectStorageSignedGetUrl } from '../storage/objectStorage.js';
import { createSocialContentArtifact } from './socialContentOutputs.js';
import {
  inspectTransientSocialContentFile,
  registerSocialContentFile,
  socialContentFileDownloadUrl,
  type SocialContentBackendFilePort,
} from './socialContentFiles.js';
import {
  materializeSocialContentCloudMaterial,
  socialContentCloudMaterialRecordId,
  type SocialContentCloudMaterialPort,
} from './socialContentMaterialAccess.js';
import { withSocialContentRenderWorkspace } from './socialContentRenderWorkspace.js';
import { readSocialTaskDetail, requireSocialTask } from './socialContentRecords.js';
import { STARTER_COLLECTIONS, type Starter198Repository, type StarterRecord } from './repository.js';
import {
  SocialContentWorkflowError,
  socialJson,
  socialObject,
  socialRequestHash,
  socialText,
} from './socialContentValidation.js';
import {
  freezeSocialScriptBaseline,
  parseStoredSocialScriptBaseline,
  SOCIAL_SCRIPT_GROUNDING_VERSION,
  verifiedSocialScriptContext,
  type StoredSocialScriptBaseline,
} from './socialContentScriptBaseline.js';
import { resolveSocialContentFormulaReference } from './socialContentFormulas.js';
import { runOutsideSocialContentMutationScope } from './socialContentMutation.js';
import { resolveSocialInspirationScript } from './socialContentScriptSources.js';
import {
  buildSocialProductionPlan,
  type SocialProductionAsset,
  type SocialProductionPlan,
} from './socialContentProductionPlan.js';
import { evaluateSocialReplicationResult } from './replicationEvaluationAdapter.js';
import {
  executeSocialAssetSupplyPlan,
  type SocialAssetSupplyExecution,
  type SocialAssetSupplyProviderAdapter,
} from './socialContentAssetSupplyExecution.js';
import { createConfiguredSocialAiVisualAdapter } from './socialContentAiVisualAdapter.js';
import { createSocialDigitalPresenterAdapter } from './socialContentDigitalPresenterAdapter.js';
import { createEnvironmentSocialHeyGenBridge } from './socialContentHeyGenBridge.js';
import {
  buildSocialDirectorPlan,
  parseStoredSocialDirectorPlan,
  publicSocialDirectorPlanSummary,
  reviseSocialDirectorPlanForVoiceoverFit,
  socialDirectorContentHandoff,
  socialDirectorCoverTimestamp,
  socialDirectorRenderTimeline,
  socialDirectorSceneTimingCues,
  socialDirectorScriptText,
  type SocialDirectorBgmSelection,
  type SocialDirectorBgmTrack,
  type SocialDirectorContentHandoff,
} from './socialContentDirectorPlan.js';
import {
  persistSocialDirectorPlanVersion,
  resolveSocialDirectorArtifactLineage,
} from './socialContentDirectorPlanVersions.js';
import type { InternalSocialContentFormula } from './socialContentThemes.js';

const require = createRequire(import.meta.url);
const { composite } = require('../../desktop/render.cjs') as {
  composite: (
    manifest: unknown,
    onProgress?: (progress: number) => void,
    outputDir?: string,
  ) => Promise<{ ok: boolean; outputPath?: string; error?: string }>;
};

// API and worker processes may run from different checkouts while sharing one
// canonical media volume. Keep material loading and all derived outputs on the
// configured authority used by the enterprise product projection.
export const MEDIA_ROOT = path.resolve(process.env.SOCIAL_CONTENT_MEDIA_ROOT || path.join(process.cwd(), 'data', 'media'));
export const AUTO_TASK_KEY = 'social_content_auto_production';
export const AUTO_SCHEMA = 'social-content.auto-production.v3';

export type ProductionAsset = SocialProductionAsset;

export type SocialProductionBaseline = StoredSocialScriptBaseline;

export type SocialProductionAdaptation = {
  narrationChanged: boolean;
  limitedMaterialFallback: boolean;
  sourceAssetCount: number;
  notes: string[];
  sceneAssets: Array<{ sceneId: string; assetId: string; assetName: string; reuseIndex: number }>;
};

export type SocialReviewRevisionDirective = {
  feedbackHash: string;
  categories: Array<'shorter' | 'opening' | 'captions' | 'music' | 'visuals' | 'general'>;
  narrationRatio: number;
  musicMood: string | null;
};

export function safeNextVersion(record: StarterRecord): string {
  const version = Number(record.version);
  return Number.isSafeInteger(version) && version > 0 ? String(version + 1) : '1';
}

export function decodeMaterialRef(value: string): string {
  const encoded = value.match(/^socialmaterial:([A-Za-z0-9_-]+)$/)?.[1];
  if (!encoded) return '';
  try { return Buffer.from(encoded, 'base64url').toString('utf8'); }
  catch { return ''; }
}

export function safeLocalMediaPath(value: unknown): string {
  const relative = socialText(value);
  if (!relative) return '';
  const local = path.resolve(MEDIA_ROOT, relative.replace(/^\/+/, ''));
  return local.startsWith(`${MEDIA_ROOT}${path.sep}`) && existsSync(local) && statSync(local).isFile() ? local : '';
}

export function normalizedProductReference(value: unknown): string {
  return socialText(value).normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

const MATERIAL_THEME_TERMS: Record<SocialContentThemeId, readonly string[]> = {
  product_value: ['产品', '细节', '外观', '包装', '使用', 'product', 'detail', 'package', 'use'],
  scenario_solution: ['场景', '使用', '操作', '过程', '结果', 'scenario', 'use', 'operation', 'result'],
  supplier_capability: ['工厂', '车间', '生产', '质检', '仓储', '交付', 'factory', 'production', 'quality', 'delivery'],
  customization_process: ['定制', '打样', '包装', '生产', '交付', 'custom', 'sample', 'package', 'production'],
  customer_case: ['客户', '合作', '方案', '过程', '成果', 'customer', 'case', 'process', 'result'],
};

export function materialTenantId(record: MaterialRecord): string {
  return socialText(record.tenantId || record.tenant_id);
}

/** Tenant-visible visuals are production-ready unless they are explicitly
 * analysis-only references. Missing legacy rights metadata does not block a
 * tenant-owned material, but an inspiration/competitor source may never be
 * promoted into an output merely because it is visible in the library. */
export function automaticSocialMaterialEligible(record: MaterialRecord, tenantId: string): boolean {
  if (!['video', 'image'].includes(socialText(record.type))) return false;
  if (isReferenceOnlyMaterial(record)) return false;
  // An uploaded product video is only an intake candidate. Legacy editable
  // defaults and user-editable product tags must not promote it to production.
  // A separately issued, current review will be checked at the material
  // admission boundary before this class of source is enabled.
  if (record.type === 'video' && record.provenance?.footageCandidate) return false;
  return socialText(record.scope) === 'shared' || materialTenantId(record) === tenantId;
}

export function materialSearchText(record: MaterialRecord): string {
  return [
    record.name, record.title, record.industry, record.shotFunction, record.applicability, record.tags,
    ...(Array.isArray(record.visualObservations) ? record.visualObservations : []),
    ...(Array.isArray(record.observations) ? record.observations : []),
    ...(Array.isArray(record.segments) ? record.segments.flatMap((segment: unknown) => {
      const row = socialObject(segment);
      return row ? [row.observedFacts, row.action, row.visual, row.environment, row.subject, row.purpose] : [];
    }) : []),
  ].map(socialText).filter(Boolean).join(' ').toLocaleLowerCase();
}

export function automaticMaterialScore(input: {
  record: MaterialRecord;
  tenantId: string;
  productRef: string | null;
  themeId: SocialContentThemeId | null;
  linked: boolean;
}): number {
  const origin = input.linked ? 400
    : materialTenantId(input.record) === input.tenantId ? 240
      : socialText(input.record.scope) === 'shared' ? 120 : 0;
  const product = normalizedProductReference(input.productRef);
  const productRefs = [input.record.productRef, input.record.productName, ...(Array.isArray(input.record.productRefs) ? input.record.productRefs : [])]
    .map(normalizedProductReference).filter(Boolean);
  const productScore = product && productRefs.includes(product) ? 80 : 0;
  const searchable = materialSearchText(input.record);
  const themeScore = input.themeId
    ? MATERIAL_THEME_TERMS[input.themeId].filter(term => searchable.includes(term.toLocaleLowerCase())).length * 8
    : 0;
  const analyzed = (Array.isArray(input.record.segments) && input.record.segments.length > 0)
    || (Array.isArray(input.record.visualObservations) && input.record.visualObservations.length > 0) ? 30 : 0;
  return origin + productScore + themeScore + analyzed;
}

const LOCAL_SHOT_WIDTH = 72;
const LOCAL_SHOT_HEIGHT = 96;
const LOCAL_SHOT_BYTES = LOCAL_SHOT_WIDTH * LOCAL_SHOT_HEIGHT;

export function localShotDifference(left: Buffer, right: Buffer): number {
  let total = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    total += Math.abs((left[index] || 0) - (right[index] || 0));
  }
  return total / Math.max(1, length);
}

/**
 * A task upload can be a fully edited source video containing several real
 * shots. When the optional semantic vision provider is unavailable, detect
 * visually distinct time windows locally instead of discarding the source and
 * replacing it with synthetic title cards. These windows prove only visual
 * difference; they deliberately carry no semantic/product claims.
 */
export async function detectDistinctTaskVideoSegments(asset: ProductionAsset): Promise<Array<Record<string, unknown>>> {
  const source = asset.localPath && existsSync(asset.localPath) ? asset.localPath : '';
  const duration = Number(asset.duration || 0);
  if (asset.type !== 'video' || !source || !Number.isFinite(duration) || duration < 4) return [];
  const sampleCount = Math.max(5, Math.min(14, Math.floor(duration / 1.2)));
  const sampleInterval = duration / sampleCount;
  const decoded = await runVisualFfmpeg([
    '-i', source,
    '-map', '0:v:0',
    '-vf', `fps=${(sampleCount / duration).toFixed(6)},scale=${LOCAL_SHOT_WIDTH}:${LOCAL_SHOT_HEIGHT}:force_original_aspect_ratio=decrease,pad=${LOCAL_SHOT_WIDTH}:${LOCAL_SHOT_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black,format=gray`,
    '-frames:v', String(sampleCount),
    '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1',
  ], true, { timeoutMs: 45_000 });
  if (!decoded.ok) return [];
  const frames: Buffer[] = [];
  for (let offset = 0; offset + LOCAL_SHOT_BYTES <= decoded.stdout.length && frames.length < sampleCount; offset += LOCAL_SHOT_BYTES) {
    frames.push(decoded.stdout.subarray(offset, offset + LOCAL_SHOT_BYTES));
  }
  if (frames.length < 3) return [];
  const selected: number[] = [0];
  // Collect spare candidates so the local quality pass can replace a blurry
  // or duplicated interval instead of failing the whole otherwise usable reel.
  const desiredCount = Math.min(7, Math.max(4, Math.floor(duration / 2.3)));
  // Sample the full running time instead of accepting the first four changes.
  // User-edited product reels often contain many quick cuts; a front-loaded
  // selection loses the demonstration/result/hero shots in the second half.
  while (selected.length < desiredCount) {
    const candidates = frames.map((frame, index) => ({
      index,
      temporalDistance: Math.min(...selected.map(previous => Math.abs(index - previous) * sampleInterval)),
      visualDistance: Math.min(...selected.map(previous => localShotDifference(frames[previous]!, frame))),
      localChange: Math.max(
        index > 0 ? localShotDifference(frames[index - 1]!, frame) : 0,
        index + 1 < frames.length ? localShotDifference(frame, frames[index + 1]!) : 0,
      ),
    })).filter(candidate => {
      const enoughTime = candidate.temporalDistance >= 1.45;
      // The renderer treats 0.75 mean-luma movement as real motion. Reuse that
      // conservative floor here; the later per-scene quality gate still
      // rejects genuinely duplicated output scenes.
      const visuallyDistinct = candidate.visualDistance >= 0.75 || candidate.localChange >= 0.75;
      return enoughTime && visuallyDistinct;
    }).sort((left, right) => right.temporalDistance - left.temporalDistance
      || right.visualDistance - left.visualDistance
      || right.localChange - left.localChange);
    const selectedCandidate = candidates[0];
    if (!selectedCandidate) break;
    selected.push(selectedCandidate.index);
  }
  selected.sort((left, right) => left - right);
  if (selected.length < 2) return [];
  const segments: Array<Record<string, unknown>> = [];
  for (const [order, frameIndex] of selected.entries()) {
    const center = Math.min(duration - 0.1, (frameIndex + 0.5) * sampleInterval);
    // Give each selected part enough edit budget for a natural sentence. The
    // previous 1.5–1.8 second windows forced the Director Agent to cut safe
    // copy into fragments even when the uploaded reel had ample running time.
    const targetDuration = Math.max(1.8, Math.min(2.8, sampleInterval * 2.05));
    const start = Math.min(
      Math.max(0, duration - targetDuration),
      Math.max(0, center - targetDuration / 2),
    );
    const end = Math.min(duration, start + targetDuration);
    if (end - start < 1.45) continue;
    segments.push({
      segmentId: `local-distinct:${asset.id}:${order + 1}`,
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
      confidence: 0,
      needsReview: true,
      analysisMode: 'local_distinct_visual_windows',
      evidenceBasis: 'tenant_task_upload_visual_difference_only',
    });
  }
  if (segments.length < 2) return [];
  const visualQuality = await inspectRenderedScenes({
    outputPath: source,
    scenes: segments.map(segment => ({ start: Number(segment.start), end: Number(segment.end) })),
    requireDistinct: true,
  });
  const rejected = new Set(visualQuality.issues.map(issue => issue.sceneIndex));
  const usable = segments.filter((_, index) => !rejected.has(index));
  if (usable.length < 2) return [];
  const withoutOverlap = (items: Array<Record<string, unknown>>) => {
    let previousEnd = 0;
    return items.sort((left, right) => Number(left.start) - Number(right.start)).flatMap(segment => {
      const start = Math.max(previousEnd, Number(segment.start));
      const end = Number(segment.end);
      if (end - start < 1.45) return [];
      previousEnd = end;
      return [{ ...segment, start: Number(start.toFixed(3)) }];
    });
  };
  if (usable.length <= 4) return withoutOverlap(usable);
  // Keep the final edit representative of the full upload after rejecting bad
  // candidates: opening, closing, then the most temporally distant interiors.
  const chosen = [0, usable.length - 1];
  while (chosen.length < 4) {
    const next = usable.map((segment, index) => ({
      index,
      distance: Math.min(...chosen.map(chosenIndex => Math.abs(
        Number(segment.start) - Number(usable[chosenIndex]!.start),
      ))),
    })).filter(item => !chosen.includes(item.index))
      .sort((left, right) => right.distance - left.distance)[0];
    if (!next) break;
    chosen.push(next.index);
  }
  return withoutOverlap(chosen.sort((left, right) => left - right).map(index => usable[index]!));
}

/** Only provenance written when the tenant attached the upload to this exact
 * product may unlock association-only production. Product names, filenames,
 * source labels and purposes are intentionally excluded. */
export function hasExactTaskProductAssociation(record: MaterialRecord, taskProductRef: string | null): boolean {
  const expected = normalizedProductReference(taskProductRef);
  if (!expected) return false;
  const candidates = [
    record.productRef,
    ...(Array.isArray(record.productRefs) ? record.productRefs : []),
  ].map(normalizedProductReference).filter(Boolean);
  return candidates.includes(expected);
}

export async function resolveTaskProductionMaterialLocation(input: {
  tenantId: string;
  record: MaterialRecord;
  type: 'image' | 'video';
  outputDirectory: string;
  index: number;
  cloudMaterialPort?: SocialContentCloudMaterialPort;
}): Promise<{ url: string; localPath?: string; cloudRecordId?: string; sha256?: string }> {
  const record = input.record;
  const cloudRecordId = socialContentCloudMaterialRecordId(record);
  const claimsCloudIdentity = socialText(record.id).startsWith('pb-') || Boolean(socialText(record.cloudRecordId));
  if (claimsCloudIdentity) {
    // A malformed or conflicting cloud identity must fail closed; never fall
    // through to a URL stored on the material record.
    if (!cloudRecordId) throw new SocialContentWorkflowError('social_content_material_identity_invalid', 409);
    return materializeSocialContentCloudMaterial({
      tenantId: input.tenantId,
      record,
      type: input.type,
      outputDirectory: input.outputDirectory,
      index: input.index,
      port: input.cloudMaterialPort,
    });
  }
  const localPath = safeLocalMediaPath(record.file)
    || (socialText(record.url).startsWith('/media/') ? safeLocalMediaPath(socialText(record.url).slice('/media/'.length)) : '');
  if (localPath) return { url: localPath, localPath };
  const objectKey = socialText(record.objectKey);
  if (objectKey && objectStorageEnabled()) return { url: await objectStorageSignedGetUrl(objectKey, 15 * 60) };
  // Arbitrary URLs from inventory data are not render inputs. Importing them
  // into tenant-owned storage is the only supported path, preventing SSRF and
  // removing ambient-cookie/public-route authorization assumptions.
  return { url: '' };
}
