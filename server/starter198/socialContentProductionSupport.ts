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
import { readMaterialLibrary, updateAccessibleLocalMaterial, type MaterialRecord } from '../lib/materialLibrary.js';
import type { DataStore } from '../storage/datastore.js';
import type { SocialAssetSupplyShotPlan } from '../../shared/contracts/socialContentWorkflow.js';
import { readProductionProductFootageSegment } from './socialProductFootageAdmission.js';
import { resolveSourceDurations } from '../lib/videoSourcePlan.js';
import {
  automationBgmAudio,
  automationBgmCatalog,
  readTenantEnterpriseProfile,
  synthesizeStudioVoiceForAutomation,
} from '../lib/socialContentLegacyPorts.js';
import { analyzeProductionMaterial } from '../digitalEmployees/productionMaterialAnalysis.js';
import { objectStorageDownload, objectStorageEnabled, objectStorageSignedGetUrl } from '../storage/objectStorage.js';
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
import { buildMaterialScriptAnalysis } from '../../shared/materialScriptAnalysis.js';

const require = createRequire(import.meta.url);
const { composite } = require('../../desktop/render.cjs') as {
  composite: (
    manifest: unknown,
    onProgress?: (progress: number) => void,
    outputDir?: string,
  ) => Promise<{ ok: boolean; outputPath?: string; error?: string }>;
};

import { MEDIA_ROOT, type ProductionAsset, type SocialProductionBaseline, type SocialProductionAdaptation, type SocialReviewRevisionDirective, automaticSocialMaterialEligible, detectDistinctTaskVideoSegments, hasExactTaskProductAssociation, resolveTaskProductionMaterialLocation } from './socialContentAutoProduction.js';
import { automaticMaterialScore, decodeMaterialRef, materialTenantId } from './socialContentAutoProduction.js';
export async function taskProductionAssets(input: {
  tenantId: string;
  sources: SocialTaskSource[];
  productRef: string | null;
  themeId: SocialContentThemeId | null;
  productionMode: NonNullable<SocialContentTaskBrief['productionMode']>;
  outputDirectory: string;
  cloudMaterialPort?: SocialContentCloudMaterialPort;
  allowAuthorizedSharedLibrary?: boolean;
  materialLibrary?: typeof readMaterialLibrary;
  /** The planner already scanned the complete library. Execution materializes
   * only the immutable ids selected by the reviewed shot plan. */
  requiredMaterialIds?: string[];
  selectedMaterialSegments?: Array<NonNullable<SocialAssetSupplyShotPlan['selectedMaterialSegment']>>;
  productFootageStore?: DataStore;
}): Promise<ProductionAsset[]> {
  const inventory = await (input.materialLibrary ?? readMaterialLibrary)(input.tenantId);
  if (inventory.status === 'unavailable') throw new Error('素材库暂时不可用，请稍后重试');
  const byId = new Map(inventory.items.map(item => [socialText(item.id), item]));
  const reviewedFootage = new Map<string, MaterialRecord>();
  for (const id of input.requiredMaterialIds ?? []) {
    const material = byId.get(socialText(id));
    if (!material?.provenance?.footageCandidate) continue;
    const frozen = input.selectedMaterialSegments?.filter(segment => segment.sourceRef === id) ?? [];
    if (!input.productFootageStore || !frozen.length || frozen.some(segment => !segment.footageEvidence))
      throw new Error('product_footage_shot_review_required');
    const admittedIds = new Set<string>();
    let admittedOverlay: MaterialRecord | null = null;
    for (const segment of frozen) {
      const evidence = segment.footageEvidence!;
      const admitted = await readProductionProductFootageSegment({
        store: input.productFootageStore, readMaterials: input.materialLibrary ?? readMaterialLibrary,
        tenantId: input.tenantId, productId: evidence.productId, materialId: id,
        sceneFunction: evidence.sceneFunction, segmentId: segment.segmentId,
        startSeconds: segment.startSeconds, endSeconds: segment.endSeconds,
        expectedContentSha256: evidence.contentSha256,
        expectedApprovalId: evidence.approvalId, expectedVisualFindingId: evidence.visualFindingId,
      }).catch(() => null);
      if (!admitted) throw new Error('product_footage_shot_review_required');
      admittedIds.add(segment.segmentId);
      admittedOverlay = admitted.material;
    }
    // A signed visual finding authorizes one bounded use, not every window in
    // the source file. Keep only the windows selected by this frozen shot plan
    // in the production inventory handed to the Content Agent and renderer.
    const selectedShots = admittedOverlay?.scriptAnalysis?.shots.filter((shot: { segmentId: string }) => admittedIds.has(shot.segmentId)) ?? [];
    if (!admittedOverlay || selectedShots.length !== admittedIds.size)
      throw new Error('product_footage_shot_review_required');
    reviewedFootage.set(id, { ...admittedOverlay, scriptAnalysis: {
      ...admittedOverlay.scriptAnalysis, shots: selectedShots,
    } });
  }
  const linkedSources = input.sources.filter(item => item.status === 'active' && item.kind === 'material');
  const linkedCandidates = linkedSources.flatMap(source => {
    const id = decodeMaterialRef(source.sourceRef);
    // Older tasks may still carry the file reference used before uploads were
    // canonicalized into My Materials. Resolve it to the immutable material
    // record instead of treating a text/file row as a renderable visual.
    const record = byId.get(id) ?? inventory.items.find(item => (
      Array.isArray(item.sourceTaskFileRefs) && item.sourceTaskFileRefs.map(socialText).includes(source.sourceRef)
    ));
    if (!record || !automaticSocialMaterialEligible(record, input.tenantId)) return [];
    return [{ record, sourceId: source.sourceId, label: source.label, origin: 'task' as const, linked: true }];
  });
  const linkedIds = new Set(linkedCandidates.map(item => socialText(item.record.id)));
  const requiredIds = input.requiredMaterialIds?.length ? new Set(input.requiredMaterialIds.map(socialText).filter(Boolean)) : null;
  const libraryCandidates = inventory.items
    .filter(record => !linkedIds.has(socialText(record.id))
      && (!requiredIds || requiredIds.has(socialText(record.id)))
      && (reviewedFootage.has(socialText(record.id)) || automaticSocialMaterialEligible(record, input.tenantId))
      && (input.allowAuthorizedSharedLibrary !== false || materialTenantId(record) === input.tenantId))
    .map(record => ({
      record: reviewedFootage.get(socialText(record.id)) ?? record,
      sourceId: `library_material_${socialRequestHash({ id: socialText(record.id) }).slice(0, 24)}`,
      label: socialText(record.name || record.title) || '素材库素材',
      origin: materialTenantId(record) === input.tenantId ? 'tenant_library' as const : 'shared_library' as const,
      linked: false,
    }));
  // The material library is the Content Agent's production inventory. Items
  // do not need to be re-linked or re-authorized per task; relevance is decided
  // by the Director's semantic tags and the per-shot router below.
  const candidates = [
    ...linkedCandidates,
    ...libraryCandidates,
  ]
    .sort((left, right) => automaticMaterialScore({
      record: right.record, tenantId: input.tenantId, productRef: input.productRef, themeId: input.themeId, linked: right.linked,
    }) - automaticMaterialScore({
      record: left.record, tenantId: input.tenantId, productRef: input.productRef, themeId: input.themeId, linked: left.linked,
    }));
  const assets: ProductionAsset[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const { record } = candidate;
    const type = socialText(record.type) as ProductionAsset['type'];
    let location: Awaited<ReturnType<typeof resolveTaskProductionMaterialLocation>>;
    try {
      if (reviewedFootage.has(socialText(record.id))) {
        // Render the very bytes admitted above. A short-lived signed URL could
        // otherwise be replaced after review but before ffmpeg fetches it.
        const object = await objectStorageDownload(socialText(record.objectKey));
        const expected = socialText(record.contentSha256).toLowerCase();
        if (!object || object.contentType !== 'video/mp4' || !/^[a-f0-9]{64}$/.test(expected)
          || createHash('sha256').update(object.buf).digest('hex') !== expected)
          throw Error('product_footage_bytes_changed');
        await fsp.mkdir(input.outputDirectory, { recursive: true, mode: 0o700 });
        const localPath = path.join(input.outputDirectory,
          `reviewed-product-footage-${socialRequestHash([input.tenantId, record.id, expected]).slice(0, 24)}.mp4`);
        await fsp.writeFile(localPath, object.buf, { mode: 0o600 });
        location = { url: localPath, localPath, sha256: expected };
      } else {
        location = await resolveTaskProductionMaterialLocation({
          tenantId: input.tenantId, record, type,
          outputDirectory: input.outputDirectory, index,
          cloudMaterialPort: input.cloudMaterialPort,
        });
      }
    } catch {
      if (reviewedFootage.has(socialText(record.id))) throw new Error('product_footage_material_unreadable');
      // One stale library item must not abort the whole first-content run.
      // Identity and authorization checks still fail closed for that item.
      continue;
    }
    if (!location.url) {
      if (reviewedFootage.has(socialText(record.id))) throw new Error('product_footage_material_unreadable');
      continue;
    }
    const explicitlyAssociated = hasExactTaskProductAssociation(record, input.productRef);
    assets.push({
      id: socialText(record.id),
      name: socialText(record.name) || candidate.label || '内容素材',
      type,
      sourceId: candidate.sourceId,
      url: location.url,
      ...(location.localPath ? { localPath: location.localPath } : {}),
      ...(location.cloudRecordId ? { cloudRecordId: location.cloudRecordId } : {}),
      ...(socialText(record.objectKey) ? { objectKey: socialText(record.objectKey) } : {}),
      ...(socialText(record.contentSha256 || record.sha256 || location.sha256)
        ? { contentHash: socialText(record.contentSha256 || record.sha256 || location.sha256) }
        : {}),
      authorizationRef: reviewedFootage.has(socialText(record.id))
        ? socialText(record.rightsEvidenceRef) : 'material_library_default',
      duration: Math.max(0, Number(record.duration || 0)),
      visualObservations: [record.visualObservations, record.observations]
        .flatMap(value => Array.isArray(value) ? value : [])
        .map(socialText).filter(Boolean),
      ...(explicitlyAssociated ? {
        explicitProductAssociation: {
          productRef: socialText(input.productRef),
          basis: 'tenant_task_upload' as const,
          exactTaskProductMatch: true as const,
        },
      } : {}),
      segments: Array.isArray(record.segments)
        ? record.segments.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
        : [],
      ...(record.scriptAnalysis ? { scriptAnalysis: record.scriptAnalysis } : {}),
      selectionOrigin: candidate.origin,
    });
  }
  return resolveSourceDurations(assets);
}

export function safeGraphicText(value: unknown, maximum: number): string {
  return socialText(value).replace(/[<>\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').slice(0, maximum);
}

export function escapeSvg(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function systemThemeGraphicAssets(input: {
  outputDirectory: string;
  baseline: StoredSocialScriptBaseline;
}): Promise<ProductionAsset[]> {
  const palette = [
    ['#073b32', '#20a36a', '#d8f7e9'],
    ['#102a43', '#3977c3', '#dcecff'],
    ['#3b245c', '#8b5cc7', '#f0e6ff'],
    ['#4a2b13', '#c87932', '#fff0dc'],
  ] as const;
  const assets: ProductionAsset[] = [];
  for (const [index, scene] of input.baseline.scenes.slice(0, 4).entries()) {
    const [dark, accent, light] = palette[index % palette.length]!;
    const title = safeGraphicText(scene.shotFunction, 18) || '内容要点';
    const subject = safeGraphicText(scene.subject, 28) || '通用主题内容';
    const filename = `system-theme-${index + 1}.png`;
    const localPath = path.join(input.outputDirectory, filename);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280" viewBox="0 0 720 1280">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${dark}"/><stop offset="1" stop-color="${accent}"/></linearGradient></defs>
      <rect width="720" height="1280" fill="url(#g)"/>
      <circle cx="620" cy="160" r="210" fill="${light}" opacity=".12"/><circle cx="90" cy="1100" r="260" fill="${light}" opacity=".09"/>
      <rect x="64" y="390" width="592" height="500" rx="36" fill="#ffffff" opacity=".94"/>
      <text x="104" y="500" fill="${accent}" font-size="28" font-family="Arial, PingFang SC, sans-serif" font-weight="700">通用安全版 · ${index + 1}/${Math.min(4, input.baseline.scenes.length)}</text>
      <text x="104" y="610" fill="${dark}" font-size="58" font-family="Arial, PingFang SC, sans-serif" font-weight="800">${escapeSvg(title)}</text>
      <text x="104" y="700" fill="#324b45" font-size="34" font-family="Arial, PingFang SC, sans-serif">${escapeSvg(subject)}</text>
      <text x="104" y="805" fill="#60736e" font-size="24" font-family="Arial, PingFang SC, sans-serif">不使用未经核验的企业或产品事实</text>
    </svg>`;
    await sharp(Buffer.from(svg)).png().toFile(localPath);
    const contentHash = createHash('sha256').update(await fsp.readFile(localPath)).digest('hex');
    assets.push({
      id: `system-theme-${input.baseline.themeId || 'general'}-${index + 1}`,
      name: `${title} · 系统安全图形`,
      type: 'image',
      sourceId: `system_theme_material_${index + 1}`,
      url: localPath,
      localPath,
      contentHash,
      duration: 2.8,
      visualObservations: [`${scene.shotFunction} ${scene.subject} ${scene.action}`, '系统生成的抽象图形与受控主题文字'],
      segments: [],
      selectionOrigin: 'system_graphic',
    });
  }
  return assets;
}

export function existingAssetSupplyAdapters(): SocialAssetSupplyProviderAdapter[] {
  const customerAsset: SocialAssetSupplyProviderAdapter = {
    adapterId: 'existing_customer_asset.v1',
    sourceStrategies: ['customer_real_asset', 'customer_product_image_animation'],
    async execute(context) {
      let candidates = context.availableAssets.filter(candidate => (
        context.shot.sourceRefs.includes(candidate.sourceId) || context.shot.sourceRefs.includes(candidate.id)
      ));
      const selected = context.shot.selectedMaterialSegment;
      const matched = selected
        ? candidates.find(candidate => selected.sourceRef === candidate.sourceId || selected.sourceRef === candidate.id)
        : candidates[0];
      if (!matched) return null;
      const selectedSegments = selected
        ? matched.segments.filter(segment => String(segment.id || '').trim() === selected.segmentId)
        : matched.segments;
      const selectedAnalysis = selected && matched.scriptAnalysis
        ? { ...matched.scriptAnalysis, shots: matched.scriptAnalysis.shots.filter(shot => shot.segmentId === selected.segmentId) }
        : matched.scriptAnalysis;
      if (selected && !selectedSegments.length && !selectedAnalysis?.shots.length) return null;
      const asset: SocialProductionAsset = selected ? {
        ...matched,
        segments: selectedSegments,
        ...(selectedAnalysis ? { scriptAnalysis: selectedAnalysis } : {}),
      } : matched;
      if (context.shot.sourceStrategy === 'customer_product_image_animation' && asset.type === 'image') {
        const referenceTiming = context.baselineScene.referenceStructure?.sourceTiming;
        const frozenDuration = context.shot.materialRouting?.generation?.durationSeconds;
        const requestedDuration = Math.max(1.2, Math.min(12,
          Number(frozenDuration || 0)
            || Number(referenceTiming?.endSeconds || 0) - Number(referenceTiming?.startSeconds || 0)
            || Number(asset.duration || 0)
            || 2.8));
        const sceneKey = socialRequestHash({
          taskId: context.taskId,
          sceneId: context.baselineScene.sceneId,
          sourceId: asset.sourceId,
          contentHash: asset.contentHash ?? null,
          requestedDuration,
        }).slice(0, 20);
        const localPath = path.join(context.outputDirectory, `product-image-motion-${sceneKey}.mp4`);
        const sourcePath = asset.localPath || asset.url;
        const rendered = await runVisualFfmpeg([
          '-y', '-loop', '1', '-i', sourcePath,
          '-t', requestedDuration.toFixed(3), '-r', '30',
          '-vf', "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:color=white,zoompan=z='min(zoom+0.0008,1.08)':d=1:s=720x1280:fps=30,format=yuv420p",
          '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
          localPath,
        ], false, { timeoutMs: 120_000 });
        if (!rendered.ok || !existsSync(localPath) || statSync(localPath).size <= 0) {
          throw new Error(`customer_product_image_animation_failed:${context.baselineScene.sceneId}`);
        }
        const contentHash = createHash('sha256').update(await fsp.readFile(localPath)).digest('hex');
        const animatedAsset: SocialProductionAsset = {
          ...asset,
          id: `${asset.id}:motion:${sceneKey}`,
          name: `${asset.name} · 基础产品动效`,
          type: 'video',
          sourceId: `${asset.sourceId}:motion:${context.baselineScene.sceneId}`,
          url: localPath,
          localPath,
          contentHash,
          duration: requestedDuration,
          visualObservations: [
            ...asset.visualObservations,
            `由已授权产品图生成的 ${requestedDuration.toFixed(2)} 秒受控基础运镜`,
          ],
          segments: [],
          scriptAnalysis: undefined,
        };
        return {
          asset: animatedAsset,
          sourceStrategy: context.shot.sourceStrategy,
          providerId: this.adapterId,
          sourceRef: asset.sourceId,
          synthetic: true,
          representation: 'non_evidentiary_visual',
          authorizationRef: 'material_library_default',
          disclosure: '由客户已授权产品图生成的基础运镜',
        };
      }
      const customerEvidence = context.shot.truthBoundary.customerEvidenceRefs.includes(asset.sourceId)
        || context.shot.truthBoundary.customerEvidenceRefs.includes(asset.id);
      return {
        asset,
        sourceStrategy: context.shot.sourceStrategy,
        providerId: this.adapterId,
        sourceRef: context.shot.sourceRefs.find(ref => ref === asset.sourceId || ref === asset.id) ?? asset.sourceId,
        synthetic: false,
        representation: customerEvidence ? 'customer_evidence' : 'non_evidentiary_visual',
        authorizationRef: 'material_library_default',
        disclosure: null,
      };
    },
  };
  const licensedStock: SocialAssetSupplyProviderAdapter = {
    adapterId: 'authorized_shared_library.v1',
    sourceStrategies: ['licensed_stock_asset'],
    async execute(context) {
      const asset = context.availableAssets.find(candidate => candidate.selectionOrigin === 'shared_library'
        && (!context.shot.sourceRefs.length
          || context.shot.sourceRefs.includes(candidate.sourceId)
          || context.shot.sourceRefs.includes(candidate.id)));
      if (!asset) return null;
      return {
        asset,
        sourceStrategy: 'licensed_stock_asset',
        providerId: this.adapterId,
        sourceRef: asset.sourceId,
        synthetic: false,
        representation: 'non_evidentiary_visual',
        authorizationRef: asset.authorizationRef || 'material_library_default',
        disclosure: null,
      };
    },
  };
  const safeGraphics: SocialAssetSupplyProviderAdapter = {
    adapterId: 'system_safe_motion_graphics.v1',
    sourceStrategies: ['motion_graphics', 'verified_fact_card'],
    async execute(context) {
      const index = [...context.baselineScene.sceneId].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 4;
      const palette = [
        ['#073b32', '#20a36a', '#d8f7e9'],
        ['#102a43', '#3977c3', '#dcecff'],
        ['#3b245c', '#8b5cc7', '#f0e6ff'],
        ['#4a2b13', '#c87932', '#fff0dc'],
      ] as const;
      const [dark, accent, light] = palette[index % palette.length]!;
      const title = safeGraphicText(context.baselineScene.shotFunction, 18) || '内容要点';
      const sensitive = context.shot.truthBoundary.subject !== 'none';
      const replacement = safeGraphicText(
        context.shot.functionalEquivalentReplacement.description || context.baselineScene.subject,
        30,
      ) || '通用主题说明';
      const disclosure = sensitive ? '示意画面 · 非客户实拍/案例/效果' : '系统生成说明画面';
      const filename = `asset-supply-${index + 1}-${context.shot.shotId.replace(/[^a-zA-Z0-9_-]/g, '_')}.png`;
      const localPath = path.join(context.outputDirectory, filename);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280" viewBox="0 0 720 1280">
        <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${dark}"/><stop offset="1" stop-color="${accent}"/></linearGradient></defs>
        <rect width="720" height="1280" fill="url(#g)"/>
        <circle cx="620" cy="160" r="210" fill="${light}" opacity=".12"/><circle cx="90" cy="1100" r="260" fill="${light}" opacity=".09"/>
        <rect x="54" y="350" width="612" height="560" rx="36" fill="#fff" opacity=".95"/>
        <text x="94" y="450" fill="${accent}" font-size="26" font-family="Arial, PingFang SC, sans-serif" font-weight="700">${escapeSvg(disclosure)}</text>
        <text x="94" y="570" fill="${dark}" font-size="56" font-family="Arial, PingFang SC, sans-serif" font-weight="800">${escapeSvg(title)}</text>
        <text x="94" y="680" fill="#324b45" font-size="30" font-family="Arial, PingFang SC, sans-serif">${escapeSvg(replacement)}</text>
        <text x="94" y="825" fill="#60736e" font-size="23" font-family="Arial, PingFang SC, sans-serif">不作为客户工厂、案例或产品效果证据</text>
      </svg>`;
      await sharp(Buffer.from(svg)).png().toFile(localPath);
      const referenceTiming = context.baselineScene.referenceStructure?.sourceTiming;
      const duration = Math.max(3, Math.min(12,
        Number(referenceTiming?.endSeconds || 0) - Number(referenceTiming?.startSeconds || 0) || 2.8));
      const videoPath = localPath.replace(/\.png$/i, '.mp4');
      const rendered = await runVisualFfmpeg([
        '-y', '-loop', '1', '-i', localPath, '-t', duration.toFixed(3), '-r', '30',
        '-vf', "zoompan=z='min(zoom+0.0006,1.06)':d=1:s=720x1280:fps=30,format=yuv420p",
        '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', videoPath,
      ], false, { timeoutMs: 120_000 });
      if (!rendered.ok || !existsSync(videoPath) || statSync(videoPath).size <= 0) {
        throw new Error(`system_motion_graphic_render_failed:${context.baselineScene.sceneId}`);
      }
      const contentHash = createHash('sha256').update(await fsp.readFile(videoPath)).digest('hex');
      const asset: ProductionAsset = {
        id: `asset-supply-${context.taskId}-${context.shot.shotId}`,
        name: `${title} · ${disclosure}`,
        type: 'video',
        sourceId: `asset_supply_${context.shot.shotId}`,
        url: videoPath,
        localPath: videoPath,
        contentHash,
        duration,
        visualObservations: [
          `${context.baselineScene.shotFunction} ${context.baselineScene.subject} ${context.baselineScene.action}`,
          disclosure,
          context.shot.productionInstruction,
        ],
        segments: [],
        selectionOrigin: 'system_graphic',
      };
      return {
        asset,
        sourceStrategy: context.shot.sourceStrategy,
        providerId: this.adapterId,
        sourceRef: context.shot.sourceRefs[0] ?? null,
        synthetic: true,
        representation: 'non_evidentiary_visual',
        authorizationRef: context.shot.sourceStrategy === 'verified_fact_card'
          ? context.shot.truthBoundary.confirmedFactRefs.join(',') || null
          : 'lingshu_system_generated',
        disclosure,
      };
    },
  };
  return [customerAsset, licensedStock, safeGraphics];
}

export async function analyzeProductionAssets(input: {
  tenantId: string;
  assets: ProductionAsset[];
  paidOperationContext?: import('../digitalEmployees/materialAnalysisPaidOperation.js').MaterialAnalysisPaidContext;
}): Promise<{ assets: ProductionAsset[]; failures: Array<{ assetId: string; assetName: string; reason: string }> }> {
  const assets: ProductionAsset[] = [];
  const failures: Array<{ assetId: string; assetName: string; reason: string }> = [];
  for (const asset of input.assets) {
    if (asset.visualObservations.length || asset.segments.length) {
      const scriptAnalysis = asset.scriptAnalysis || buildMaterialScriptAnalysis({
        materialId: asset.id,
        name: asset.name,
        sourceRevision: asset.contentHash || createHash('sha256').update(JSON.stringify([asset.id, asset.duration, asset.segments, asset.visualObservations])).digest('hex'),
        duration: asset.duration,
        segments: asset.segments,
        visualObservations: asset.visualObservations,
      });
      updateAccessibleLocalMaterial(asset.id, input.tenantId, {
        scriptAnalysis,
        directorTags: scriptAnalysis.directorIndex,
        assetClasses: [
          /工厂|车间|产线|生产|灌装|旋盖|设备|factory|production/i.test(scriptAnalysis.searchableText) ? 'factory' : '',
          /产品|瓶|罐|包装|product|bottle|jar|package/i.test(scriptAnalysis.searchableText) ? 'product' : '',
          /人物|员工|工人|person|worker|presenter/i.test(scriptAnalysis.searchableText) ? 'person' : '',
        ].filter(Boolean),
        segmentAnalysisStatus: 'completed',
      });
      assets.push({ ...asset, scriptAnalysis });
      continue;
    }
    try {
      const analyzed = await analyzeProductionMaterial({
        ...asset,
        observations: [],
        authorization: { status: 'owned', scope: 'tenant', evidence: 'social_content_task_source' },
        synthetic: false,
        tags: [],
        source: 'tenant_material',
      }, input.tenantId,false,input.paidOperationContext);
      const scriptAnalysis = buildMaterialScriptAnalysis({
        materialId: asset.id, name: asset.name, sourceRevision: analyzed.revision,
        duration: analyzed.duration, segments: analyzed.segments, visualObservations: analyzed.observations,
      });
      updateAccessibleLocalMaterial(asset.id, input.tenantId, {
        duration: analyzed.duration,
        segments: analyzed.segments,
        visualObservations: analyzed.observations,
        scriptAnalysis,
        directorTags: scriptAnalysis.directorIndex,
        assetClasses: [
          /工厂|车间|产线|生产|灌装|旋盖|设备|factory|production/i.test(scriptAnalysis.searchableText) ? 'factory' : '',
          /产品|瓶|罐|包装|product|bottle|jar|package/i.test(scriptAnalysis.searchableText) ? 'product' : '',
          /人物|员工|工人|person|worker|presenter/i.test(scriptAnalysis.searchableText) ? 'person' : '',
        ].filter(Boolean),
        segmentAnalysisStatus: 'completed',
        analysisSourceRevision: analyzed.revision,
      });
      assets.push({
        ...asset,
        duration: analyzed.duration || asset.duration,
        visualObservations: analyzed.observations,
        segments: analyzed.segments,
        scriptAnalysis,
      });
    } catch (error) {
      const rawReason = String(error instanceof Error ? error.message : error || '素材分析失败');
      const providerUnavailable = /(?:DASHSCOPE|GEMINI|GOOGLE|OPENAI)_API_KEY is not set|analysis provider.+unavailable/i.test(rawReason);
      const directTaskUpload = asset.selectionOrigin === 'task';
      const locallyDistinctSegments = directTaskUpload && asset.type === 'video'
        ? await detectDistinctTaskVideoSegments(asset)
        : [];
      if ((providerUnavailable || rawReason.startsWith('production_input_required:'))
        && directTaskUpload && locallyDistinctSegments.length >= 2) {
        // Keep the user's real footage in the edit. Local detection establishes
        // only that the time windows are visually different; confidence stays
        // at zero and narration remains on the governed, fact-safe baseline.
        assets.push({
          ...asset,
          visualObservations: [],
          segments: locallyDistinctSegments,
        });
        continue;
      }
      if (providerUnavailable && asset.explicitProductAssociation?.exactTaskProductMatch) {
        assets.push({
          ...asset,
          visualObservations: [],
          segments: asset.type === 'video' ? [{
            segmentId: `user-attested:${asset.id}`,
            start: 0,
            end: asset.duration,
            confidence: 0,
            needsReview: true,
            analysisMode: 'user_product_association_only',
            evidenceBasis: 'tenant_task_upload_exact_product_ref',
          }] : [],
        });
        continue;
      }
      if (providerUnavailable) {
        failures.push({
          assetId: asset.id,
          assetName: asset.name,
          reason: '视觉分析服务不可用，且素材没有与当前任务产品的明确关联',
        });
        continue;
      }
      if (/素材逐镜分析未达到可匹配标准/.test(rawReason)) {
        failures.push({ assetId: asset.id, assetName: asset.name,
          reason: `历史逐镜时间线质量不合格，已隔离该素材：${rawReason.slice(0, 240)}` });
        continue;
      }
      if (!rawReason.startsWith('production_input_required:')) throw error;
      const reason = rawReason.replace(/^production_input_required:/, '').slice(0, 300);
      failures.push({ assetId: asset.id, assetName: asset.name, reason });
    }
  }
  return { assets, failures };
}

export function productionAdaptation(plan: SocialProductionPlan, sourceAssetCount: number): SocialProductionAdaptation {
  const counts = new Map<string, number>();
  return {
    narrationChanged: plan.narrationChanged,
    limitedMaterialFallback: plan.scenes.length < 3,
    sourceAssetCount,
    notes: plan.notes,
    sceneAssets: plan.scenes.map(scene => {
      const reuseIndex = counts.get(scene.clip.assetId) ?? 0;
      counts.set(scene.clip.assetId, reuseIndex + 1);
      return {
        sceneId: scene.sceneId,
        assetId: scene.clip.assetId,
        assetName: scene.clip.assetName,
        reuseIndex,
      };
    }),
  };
}

export function zeroAssetNarration(value: string): string {
  return value
    .replace(/别急着划走，先看它真实上手。/g, '别急着划走，先看这组产品信息。')
    .replace(/外观、质地和使用过程，都给你拍清楚。/g, '外观、要点和使用步骤，依次说明。')
    .replace(/先看真实场景/g, '先看场景示意')
    .replace(/结果只说明画面中能够确认的部分/g, '结果只说明已经确认的资料')
    .replace(/真实上手/g, '使用思路')
    .replace(/真实操作/g, '操作步骤')
    .replace(/真实可见/g, '逐项说明')
    .replace(/镜头里的真实呈现/g, '已经确认的资料')
    .replace(/(?:都|逐个)?拍清楚/g, '逐项说明')
    .replace(/拍给你看/g, '依次说明')
    .replace(/one real look at the product/gi, 'a clear overview of the product topic')
    .replace(/the real scenario/gi, 'the scenario outline')
    .replace(/visually supported results/gi, 'confirmed information');
}

/** A zero-asset route may reuse a governed promotional baseline, but its
 * spoken output must never say that a generated card is real footage. */
export function applyZeroAssetTruthSafeNarration(plan: SocialProductionPlan): SocialProductionPlan {
  const scenes = plan.scenes.map(scene => ({ ...scene, narration: zeroAssetNarration(scene.narration) }));
  const changed = scenes.some((scene, index) => scene.narration !== plan.scenes[index]?.narration);
  return changed ? {
    ...plan,
    scenes,
    narrationChanged: true,
    notes: [...plan.notes, '零素材真实性门禁已移除“真实实拍/真实效果”等无法由当前画面证明的口播表达。'],
  } : plan;
}

/** Convert review prose into a small, auditable set of director controls.
 * Raw feedback is never copied into narration, captions or other user-facing
 * creative output. Unknown feedback still creates a new plan version, but it
 * cannot inject unverified claims into the script. */
export function socialReviewRevisionDirective(noteValue: unknown): SocialReviewRevisionDirective {
  const note = socialText(noteValue).replace(/\s+/g, ' ').slice(0, 2_000);
  const categories: SocialReviewRevisionDirective['categories'] = [];
  if (/短|精简|太长|啰嗦|节奏.{0,3}快|shorter|too long/i.test(note)) categories.push('shorter');
  if (/开头|第一秒|前.{0,2}秒|hook|opening/i.test(note)) categories.push('opening');
  if (/字幕|caption|subtitle/i.test(note)) categories.push('captions');
  if (/配乐|音乐|bgm|music/i.test(note)) categories.push('music');
  if (/画面|镜头|素材|visual|shot|footage/i.test(note)) categories.push('visuals');
  if (!categories.length) categories.push('general');
  const musicMood = /沉稳|稳重|商务|calm|corporate/i.test(note) ? '稳重、可信、商务'
    : /轻快|活力|明快|upbeat|energetic/i.test(note) ? '清晰、轻快、专业'
      : /温暖|柔和|warm|soft/i.test(note) ? '温暖、克制、可信'
        : null;
  return {
    feedbackHash: createHash('sha256').update(note || 'revision-without-note').digest('hex'),
    categories,
    narrationRatio: categories.includes('shorter') || categories.includes('captions') ? 0.78 : 1,
    musicMood,
  };
}

export function compactReviewNarration(value: string, ratio: number): string {
  const clean = socialText(value).replace(/\s+/g, ' ').trim();
  if (!clean || ratio >= 1) return clean;
  const maximum = Math.max(8, Math.floor([...clean].length * ratio));
  if ([...clean].length <= maximum) return clean;
  const chinese = /[\u3400-\u9fff]/.test(clean);
  const candidates = new Set(clean
    .split(chinese ? /[，；。！？]/ : /(?<=[,;.!?])\s+/)
    .map(item => item.trim().replace(/[，；。！？,;.!?]+$/g, ''))
    .filter(Boolean));
  if (chinese) {
    if (/^本片使用用户明确关联到.+的素材/.test(clean)) candidates.add('使用用户关联素材');
    if (/^以上为.+的已确认资料与用户关联素材/.test(clean)) candidates.add('资料与关联素材展示完毕');
    if (/未经确认的产品事实/.test(clean)) candidates.add('不扩展未经确认的产品事实');
    if (/不推断画面事实/.test(clean)) candidates.add('不推断画面事实');
  }
  const compacted = [...candidates]
    .filter(item => [...item].length >= 2 && [...item].length <= maximum)
    .sort((left, right) => [...right].length - [...left].length)[0]
    || (chinese ? '只呈现已确认内容' : 'Verified information is shown');
  return `${compacted.replace(/[，,；;：:\s]+$/g, '')}${chinese ? '。' : '.'}`;
}

export function applySocialReviewRevision(
  plan: SocialProductionPlan,
  directive: SocialReviewRevisionDirective,
): SocialProductionPlan {
  const scenes = plan.scenes.map(scene => ({
    ...scene,
    narration: compactReviewNarration(scene.narration, directive.narrationRatio),
  }));
  const changed = scenes.some((scene, index) => scene.narration !== plan.scenes[index]?.narration);
  return {
    ...plan,
    scenes,
    narrationChanged: plan.narrationChanged || changed,
    notes: [...plan.notes, `用户验收反馈已由编导 Agent 转为修订指令：${directive.categories.join('、')}`],
  };
}
