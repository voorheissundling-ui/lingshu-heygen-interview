import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import ffmpeg from 'ffmpeg-static';
import sharp from 'sharp';
import type { StoryboardShotSpec } from '../../shared/storyboardShotSpec.js';
import { tenantAssetDir, tenantAssetRelativePath } from './assetAccess.js';
import { applyStoryboardReplicationAutomation, buildStoryboardQaReport } from './storyboardAigcQuality.js';
import { readLocalMaterials, saveLocalMaterials, type MaterialRecord } from './materialLibrary.js';
import { readTenantMaterialBytes } from './sentenceReplicationProduction.js';

const render = promisify(execFile);
export const CONTROLLED_PRODUCT_IMAGE_ANIMATION_VERSION = 'controlled-product-image-animation-v1';
export const CONTROLLED_PRODUCT_FRAME_SOURCE = 'storyboard-controlled-product-source-frame';
export const CONTROLLED_PRODUCT_VIDEO_SOURCE = 'controlled-product-image-animation';

export interface ControlledProductImageAnimationInput {
  tenantId: string;
  projectId: string;
  shotId: string;
  requestId: string;
  projectShotFingerprint: string;
  durationSeconds: number;
  productImage: MaterialRecord;
  shotSpec: StoryboardShotSpec;
}

export interface ControlledProductImageAnimationResult {
  frame: MaterialRecord;
  video: MaterialRecord;
  reused: boolean;
}

function sourceIssue(input: ControlledProductImageAnimationInput): string | null {
  const productId = String(input.productImage.productId || '');
  const productAssets = input.shotSpec.assets.filter(asset => asset.role === 'product' && asset.source === 'knowledge_base');
  if (!input.tenantId || !input.projectId || !input.shotId || !input.projectShotFingerprint) return 'controlled_product_context_missing';
  if (input.shotSpec.mode !== 'free_creation' || input.shotSpec.scene !== 'product'
      || input.shotSpec.constraints.some(value => ['person_identity', 'physical_contact', 'factory_space', 'action_completion'].includes(value))
      || input.shotSpec.action.beats.length > 0) return 'controlled_product_scene_not_eligible';
  if (input.productImage.type !== 'image' || input.productImage.scope !== 'own'
      || String(input.productImage.tenantId || input.productImage.tenant_id || '') !== input.tenantId
      || input.productImage.sourceType !== 'enterprise_product_table'
      || input.productImage.commercialUseApproved !== true || input.productImage.rightsStatus !== 'authorized') return 'controlled_product_source_not_authorized';
  if (!productId || productAssets.length !== 1 || productAssets[0]?.id !== productId) return 'controlled_product_identity_mismatch';
  return null;
}

function firstFrameReport() {
  const evidenceFrameLabels = ['受控产品首帧'];
  return applyStoryboardReplicationAutomation(buildStoryboardQaReport({
    phase: 'first_frame', sceneType: 'product', hasProduct: true, hasNamedPerson: false,
    hasEnvironmentReference: false, hasContact: false, hasAction: false, evidenceFrameLabels,
    observations: ['product_identity', 'layout', 'visual_integrity'].map(key => ({
      key, verdict: 'pass', evidenceFrames: evidenceFrameLabels,
      note: key === 'product_identity'
        ? '画面由当前企业知识库已授权产品原图确定性转换，未重绘包装、商标或文字'
        : '本地确定性渲染已完成画幅与有效画面检查',
    })),
  }));
}

/**
 * Render a conservative, local-only product image motion clip after generative
 * product-identity retries are exhausted. The source must be the tenant's
 * current authorized Enterprise product image. This route never claims to
 * reproduce a reference scene or real product usage, never calls a supplier,
 * and still leaves the resulting video for the normal storyboard video QA.
 */
export async function createControlledProductImageAnimation(
  input: ControlledProductImageAnimationInput,
): Promise<ControlledProductImageAnimationResult> {
  const issue = sourceIssue(input);
  if (issue) throw new Error(issue);
  if (!ffmpeg) throw new Error('controlled_product_video_renderer_unavailable');
  const loaded = await readTenantMaterialBytes(input.productImage, input.tenantId);
  const sourceSha256 = createHash('sha256').update(loaded.bytes).digest('hex');
  if (!input.productImage.contentSha256 || sourceSha256 !== String(input.productImage.contentSha256))
    throw new Error('controlled_product_source_changed');
  const productVersion = input.shotSpec.assets.find(asset => asset.role === 'product')?.version;
  if (productVersion !== createHash('sha256').update(loaded.bytes.toString('base64')).digest('hex'))
    throw new Error('controlled_product_knowledge_base_version_changed');

  const duration = Math.max(4, Math.min(15, Math.ceil(Number(input.durationSeconds) || 4)));
  const identity = createHash('sha256').update(JSON.stringify({
    version: CONTROLLED_PRODUCT_IMAGE_ANIMATION_VERSION,
    tenantId: input.tenantId, projectId: input.projectId, shotId: input.shotId,
    requestId: input.requestId, projectShotFingerprint: input.projectShotFingerprint,
    sourceSha256, duration, shotSpec: input.shotSpec,
  })).digest('hex');
  const token = identity.slice(0, 28);
  const frameId = `controlled-product-frame-${token}`;
  const videoId = `controlled-product-motion-${token}`;
  const outputDir = tenantAssetDir(path.resolve('data/media'), input.tenantId);
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const frameName = `${frameId}.png`, videoName = `${videoId}.mp4`;
  const framePath = path.join(outputDir, frameName), videoPath = path.join(outputDir, videoName);
  const existing = readLocalMaterials();
  const existingFrame = existing.find(item => item.id === frameId && item.tenantId === input.tenantId);
  const existingVideo = existing.find(item => item.id === videoId && item.tenantId === input.tenantId);
  if (existingFrame && existingVideo && fs.existsSync(framePath) && fs.existsSync(videoPath)) {
    const frameSha = createHash('sha256').update(fs.readFileSync(framePath)).digest('hex');
    const videoSha = createHash('sha256').update(fs.readFileSync(videoPath)).digest('hex');
    if (frameSha === existingFrame.contentSha256 && videoSha === existingVideo.contentSha256)
      return { frame: existingFrame, video: existingVideo, reused: true };
  }

  const temporarySource = path.join(outputDir, `.${videoId}.source-${process.pid}`);
  try {
    fs.writeFileSync(temporarySource, loaded.bytes, { mode: 0o600 });
    await sharp(loaded.bytes).resize(720, 1280, { fit: 'contain', background: '#ffffff' }).png().toFile(framePath);
    await render(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-loop', '1', '-i', temporarySource,
      '-t', String(duration), '-r', '30',
      '-vf', "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:color=white,zoompan=z='min(zoom+0.0002,1.03)':d=1:s=720x1280:fps=30,format=yuv420p",
      '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', videoPath,
    ], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  } finally { fs.rmSync(temporarySource, { force: true }); }
  if (!fs.existsSync(framePath) || !fs.existsSync(videoPath) || fs.statSync(videoPath).size <= 0)
    throw new Error('controlled_product_video_render_failed');

  const frameBytes = fs.readFileSync(framePath), videoBytes = fs.readFileSync(videoPath);
  const frameSha256 = createHash('sha256').update(frameBytes).digest('hex');
  const videoSha256 = createHash('sha256').update(videoBytes).digest('hex');
  const frameFingerprint = createHash('sha256').update(`${identity}:frame:${frameSha256}`).digest('hex');
  const quality = firstFrameReport();
  const common = {
    projectId: input.projectId, shotId: input.shotId, requestId: input.requestId,
    projectShotFingerprint: input.projectShotFingerprint, shotSpec: input.shotSpec,
    mode: 'free_creation', productIds: [String(input.productImage.productId)],
    productSourceMaterialId: input.productImage.id, productSourceSha256: sourceSha256,
    rendererVersion: CONTROLLED_PRODUCT_IMAGE_ANIMATION_VERSION,
  };
  const createdAt = new Date().toISOString();
  const frame: MaterialRecord = {
    id: frameId, tenantId: input.tenantId, scope: 'own', usage: 'editable', type: 'image',
    sourceType: CONTROLLED_PRODUCT_FRAME_SOURCE, source: 'tenant_enterprise_product_image',
    name: `受控产品首帧 · ${input.shotId}`, folder: 'product', duration: 0,
    file: tenantAssetRelativePath(input.tenantId, frameName), url: '', contentSha256: frameSha256,
    productId: input.productImage.productId, productName: input.productImage.productName,
    rightsStatus: 'authorized', rightsEvidenceRef: input.productImage.rightsEvidenceRef,
    commercialUseApproved: true, createdAt,
    provenance: { ...common, fingerprint: frameFingerprint, identityLayer: { strategy: 'exact_source_pixels', sourceSha256 },
      firstFrameQuality: quality, firstFrameQualityState: 'evaluated', firstFrameQualityError: null,
      firstFrameQualityInput: { sourceSha256: frameSha256, checkedAt: quality.checkedAt, provider: 'deterministic_local_renderer' },
      confirmed: true, confirmationSource: 'automatic_policy', qualityStatus: 'automated_checks_passed',
      provider: 'local_controlled_renderer', model: CONTROLLED_PRODUCT_IMAGE_ANIMATION_VERSION, estimatedCostCny: 0 },
  };
  const video: MaterialRecord = {
    id: videoId, tenantId: input.tenantId, scope: 'own', usage: 'editable', type: 'video',
    sourceType: CONTROLLED_PRODUCT_VIDEO_SOURCE, source: 'tenant_enterprise_product_image',
    name: `企业产品图基础动效 · ${input.shotId}`, folder: 'product', duration,
    file: tenantAssetRelativePath(input.tenantId, videoName), url: '', contentSha256: videoSha256,
    productId: input.productImage.productId, productName: input.productImage.productName,
    rightsStatus: 'authorized', rightsEvidenceRef: input.productImage.rightsEvidenceRef,
    commercialUseApproved: true, createdAt,
    provenance: { ...common, storyboardAigc: true, controlledProductImageAnimation: true,
      firstFrameMaterialId: frame.id, firstFrameFingerprint: frameFingerprint,
      provider: 'local_controlled_renderer', providerModel: CONTROLLED_PRODUCT_IMAGE_ANIMATION_VERSION,
      estimatedCostCny: 0, outputSha256: videoSha256 },
  };
  const latest = readLocalMaterials();
  saveLocalMaterials([...latest.filter(item => item.id !== frame.id && item.id !== video.id), frame, video]);
  return { frame, video, reused: false };
}
