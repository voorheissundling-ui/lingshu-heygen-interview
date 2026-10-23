import {accountProductionConstraintPrompt} from './socialAccountProductionConstraints.js';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { qualityCheckStoryboardFramesWithQwen } from '../agents/qwen.js';
import { generateSeedanceConceptVideo } from '../lib/generativeVideoGateway.js';
import { firstFrameInputFingerprint, type FirstFrameReference, type FirstFrameResult } from '../lib/firstFrameGenerator.js';
import { SeedreamFirstFrameGenerator } from '../lib/seedreamFirstFrameGenerator.js';
import { runVisualFfmpeg } from '../lib/renderVisualQuality.js';
import { objectStorageDownload, objectStorageSignedGetUrl, objectStorageUpload, objectStorageUploadFile } from '../storage/objectStorage.js';
import { store } from '../storage/index.js';
import {executeProductReplacementScene,type ProductReplacementPorts} from './socialContentProductReplacementExecution.js';
import {createEnvironmentProductReplacementPorts,type ProductReplacementEnvironmentContext} from './socialContentProductReplacementEnvironment.js';
import type { ProductSceneExecutionPorts, ProductSceneReferenceImage } from './socialContentProductSceneAdapter.js';

function mimeFor(value: string): 'image/jpeg' | 'image/png' | 'image/webp' {
  if (/png/i.test(value)) return 'image/png';
  if (/webp/i.test(value)) return 'image/webp';
  return 'image/jpeg';
}

async function productBytes(reference: ProductSceneReferenceImage): Promise<{ bytes: Buffer; mimeType: FirstFrameReference['mimeType'] }> {
  if (reference.localPath && fs.existsSync(reference.localPath)) {
    return { bytes: await fsp.readFile(reference.localPath), mimeType: mimeFor(reference.localPath) };
  }
  if (reference.objectKey) {
    const stored = await objectStorageDownload(reference.objectKey);
    if (stored?.buf.length) return { bytes: stored.buf, mimeType: mimeFor(stored.contentType) };
  }
  if (/^\/media\//.test(reference.url)) {
    const local = path.resolve(process.cwd(), 'data', reference.url.replace(/^\/media\//, 'media/'));
    if (local.startsWith(path.resolve(process.cwd(), 'data/media') + path.sep) && fs.existsSync(local)) {
      return { bytes: await fsp.readFile(local), mimeType: mimeFor(local) };
    }
  }
  if (/^https:\/\//i.test(reference.url)) {
    const response = await fetch(reference.url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`product_reference_download_failed:${response.status}`);
    return { bytes: Buffer.from(await response.arrayBuffer()), mimeType: mimeFor(response.headers.get('content-type') || reference.url) };
  }
  throw new Error(`product_reference_unreadable:${reference.assetId}`);
}

async function referenceVideo(sourceId: string | null | undefined): Promise<{ bytes: Buffer; contentType: string } | null> {
  const recordId = String(sourceId || '').replace(/^system-reference:/, '').trim();
  if (!recordId) return null;
  const record = await store.getById<Record<string, unknown>>('trend_videos', recordId).catch(() => null);
  if (!record) return null;
  let analysis: Record<string, unknown> = {};
  try { analysis = typeof record.aiAnalysis === 'string' ? JSON.parse(record.aiAnalysis) : record.aiAnalysis as Record<string, unknown> || {}; }
  catch { analysis = {}; }
  const key = String(record.videoFileId || analysis.videoObjectKey || '').trim();
  if (!key) return null;
  const stored = await objectStorageDownload(key);
  return stored ? { bytes: stored.buf, contentType: stored.contentType } : null;
}

async function extractJpeg(inputPath: string, outputPath: string, second: number): Promise<Buffer> {
  const result = await runVisualFfmpeg([
    '-ss', Math.max(0, second).toFixed(2), '-i', inputPath, '-frames:v', '1',
    '-vf', 'scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280', '-q:v', '2', '-y', outputPath,
  ], false, { timeoutMs: 120_000 });
  if (!result.ok || !fs.existsSync(outputPath)) throw new Error(`product_scene_frame_extract_failed:${result.stderr || 'missing_output'}`);
  return fsp.readFile(outputPath);
}

export async function exactProductComposite(environment: Buffer, product: Buffer): Promise<Buffer> {
  const target = await sharp(environment).metadata();
  const width = Math.max(720, Number(target.width || 1152));
  const height = Math.max(1280, Number(target.height || 2048));
  // Keep the complete source pixels. White packages cannot be separated from
  // an off-white sweep with a threshold mask without destroying labels. A
  // seamless light photography table preserves every SKU and merges the
  // library flat lay into the generated white-wall/plant environment.
  const prepared = await sharp(product).rotate().resize({
    width: Math.round(width * 0.94),
    height: Math.round(height * 0.68),
    fit: 'inside',
    withoutEnlargement: false,
  }).jpeg({ quality: 96, chromaSubsampling: '4:4:4' }).toBuffer({ resolveWithObject: true });
  const tableStart = Math.round(height * 0.07);
  const stage = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="table" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#eef2f1"/><stop offset="0.16" stop-color="#f7f8f8"/><stop offset="1" stop-color="#ffffff"/></linearGradient></defs><rect x="0" y="${tableStart}" width="${width}" height="${height - tableStart}" fill="url(#table)"/></svg>`);
  return sharp(environment).resize(width, height, { fit: 'fill' }).composite([
    { input: stage, top: 0, left: 0 },
    { input: prepared.data, top: Math.round(height * 0.20), left: Math.max(0, Math.round((width - prepared.info.width) / 2)) },
  ]).jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer();
}

function productScenePrompt(spec: Parameters<ProductSceneExecutionPorts['execute']>[0]['spec']): string {
  const productSlots = spec.sceneLock.productSlots.map(slot => `${slot.slotId}:${slot.productRef}:${slot.placement}:${slot.orientation}`).join('；');
  return [
    'Create a photorealistic vertical commercial product shot.',
    `ENVIRONMENT LOCK: ${spec.sceneLock.environment}. Background: ${spec.sceneLock.background}. Platform: ${spec.sceneLock.platform}.`,
    `LIGHTING/COMPOSITION LOCK: ${spec.sceneLock.lighting}; ${spec.sceneLock.composition}.`,
    `PRODUCT IDENTITY LOCK: use the supplied product reference images exactly. Preserve silhouette, material, color, logo, label text and packaging structure. Never invent a second SKU or morph one product into another. Slots: ${productSlots}.`,
    `CAMERA LOCK: ${spec.cameraLock.shotSize}; ${spec.cameraLock.cameraAngle}; ${spec.cameraLock.lensFeel}; begin ${spec.cameraLock.startFrame}; move ${spec.cameraLock.movementPath}; end ${spec.cameraLock.endFrame}; ${spec.cameraLock.easing}.`,
    'The supplied reference video is motion/environment guidance only. Remove its products, people, text, watermark and brand. No subtitles or baked-in text. Stable geometry, natural reflections, no cuts, no slideshow, no still-image pan/zoom.',
  ].join('\n');
}

export function createEnvironmentSeedanceProductScenePorts(options:{replacementPorts?:ProductReplacementPorts; replacementEnvironment?:ProductReplacementEnvironmentContext; maximumCostCny?:number}={}): ProductSceneExecutionPorts {
  return {
    maximumCostCny: options.maximumCostCny === undefined ? Math.min(15, Math.max(0.5, Number(process.env.SEEDANCE_MAX_SHOT_COST_CNY || 3))) : Math.min(15, options.maximumCostCny, Number(process.env.SEEDANCE_MAX_SHOT_COST_CNY || 15)),
    async execute(input) {
      if(input.materialRouting){
        if(input.materialRouting.policy!=='local_first_product_i2v')return{status:'failed',error:'material_route_not_product_generation'};
        let ports = options.replacementPorts;
        if (!ports) {
          try { ports = await createEnvironmentProductReplacementPorts(input, options.replacementEnvironment); }
          catch (error) { return {status:'failed',error:error instanceof Error && error.message.startsWith('product_') ? error.message : 'product_replacement_environment_unavailable'}; }
        }
        return executeProductReplacementScene(input, ports);
      }
      const apiKey = String(process.env.SEEDANCE_API_KEY || '').trim();
      const seedreamKey = String(process.env.SEEDREAM_API_KEY || apiKey).trim();
      const seedanceModel = String(process.env.SEEDANCE_MODEL || 'doubao-seedance-2-0-fast-260128');
      const supportsFullModalReference = /seedance-(?:2-0|2-5)-/i.test(seedanceModel);
      if (!apiKey || (!supportsFullModalReference && !seedreamKey) || process.env.SEEDANCE_VIDEO_ENABLED !== 'true') {
        return { status: 'failed', error: 'seedance_or_seedream_not_enabled' };
      }
      const referenceVideoAsset = await referenceVideo(input.spec.referenceSourceId);
      if (!referenceVideoAsset?.bytes.length) return { status: 'failed', error: 'reference_video_unavailable_for_scene_lock' };
      const referencePath = path.join(input.outputDirectory, `${input.shotId}-reference.mp4`);
      await fsp.writeFile(referencePath, referenceVideoAsset.bytes);
      const compositionPath = path.join(input.outputDirectory, `${input.shotId}-composition.jpg`);
      const compositionBytes = await extractJpeg(referencePath, compositionPath, Number(input.spec.referenceStartSeconds || 0) + 0.18);
      const loadedProducts = await Promise.all(input.referenceImages.slice(0, 9).map(productBytes));
      const compositionReference: FirstFrameReference = {
        role: 'source_composition', bytes: compositionBytes, mimeType: 'image/jpeg',
        sha256: createHash('sha256').update(compositionBytes).digest('hex'),
      };
      const firstFrameRequest = {
        referenceMode: 'environment_plate' as const,
        tenantId: input.tenantId,
        videoId: input.taskId,
        compositionId: input.spec.sceneTemplateKey,
        // The environment plate is reusable across product changes. Product
        // identity is composited from exact source pixels below rather than
        // entrusted to image generation, which can mutate labels and logos.
        presenterVersion: `${input.spec.sceneTemplateKey}:${compositionReference.sha256}`,
        prompt: [
          'Generate a photorealistic vertical commercial environment plate from the supplied reference frame.',
          accountProductionConstraintPrompt(input.accountPlaybookConstraints),
          `Preserve only this environment and composition: ${input.spec.sceneLock.environment}; ${input.spec.sceneLock.background}; ${input.spec.sceneLock.lighting}.`,
          'Remove every product, person, caption, logo, watermark and readable text. Leave a clean foreground photography surface for exact product pixels to be composited later.',
        ].join('\n'),
        ratio: '9:16' as const,
        references: [compositionReference],
        idempotencyKey: '',
      };
      const seedream = supportsFullModalReference ? null : new SeedreamFirstFrameGenerator({ apiKey: seedreamKey });
      firstFrameRequest.idempotencyKey = firstFrameInputFingerprint(
        firstFrameRequest,
        seedream?.provider || 'seedream',
        seedream?.model || 'source-composition',
      );
      const cacheDirectory = path.resolve(
        process.cwd(),
        'data/media/generated/product-scene-cache',
        createHash('sha256').update(input.tenantId).digest('hex').slice(0, 24),
      );
      await fsp.mkdir(cacheDirectory, { recursive: true });
      const cachedFirstFramePath = path.join(cacheDirectory, `${firstFrameRequest.idempotencyKey}.jpg`);
      const cachedFirstFrameMetaPath = path.join(cacheDirectory, `${firstFrameRequest.idempotencyKey}.json`);
      let firstFrame: FirstFrameResult | (Omit<FirstFrameResult, 'provider'> & { provider: 'reference-frame' });
      const cachedBytes = supportsFullModalReference ? null : await fsp.readFile(cachedFirstFramePath).catch(() => null);
      if (supportsFullModalReference) {
        // Seedance 2.x already consumes the reference video and exact product
        // images. Supplying a separately generated Seedream plate here adds
        // latency/cost and can introduce a second, conflicting product set.
        firstFrame = {
          bytes: compositionBytes,
          mimeType: 'image/jpeg',
          provider: 'reference-frame',
          model: 'source-composition',
          providerRequestId: `reference-frame:${compositionReference.sha256}`,
          estimatedCostCny: 0,
        };
      } else if (cachedBytes?.length && seedream) {
        const cachedMeta = await fsp.readFile(cachedFirstFrameMetaPath, 'utf8')
          .then(value => JSON.parse(value) as Record<string, unknown>)
          .catch((): Record<string, unknown> => ({}));
        firstFrame = {
          bytes: cachedBytes,
          mimeType: 'image/jpeg',
          provider: 'seedream',
          model: String(cachedMeta.model || seedream.model),
          providerRequestId: String(cachedMeta.providerRequestId || `cached:${firstFrameRequest.idempotencyKey}`),
          estimatedCostCny: Number(cachedMeta.estimatedCostCny || seedream.estimatedCostCny),
        };
      } else if (seedream) {
        firstFrame = await seedream.generate(firstFrameRequest);
        const temporary = `${cachedFirstFramePath}.${process.pid}.tmp`;
        await fsp.writeFile(temporary, firstFrame.bytes);
        await fsp.rename(temporary, cachedFirstFramePath);
        await fsp.writeFile(cachedFirstFrameMetaPath, JSON.stringify({
          model: firstFrame.model,
          providerRequestId: firstFrame.providerRequestId,
          estimatedCostCny: firstFrame.estimatedCostCny,
        }), 'utf8');
      } else {
        throw new Error('seedream_first_frame_provider_unavailable');
      }
      const identityLockedFirstFrame = await exactProductComposite(firstFrame.bytes, loadedProducts[0]!.bytes);
      const identityLockedHash = createHash('sha256').update(identityLockedFirstFrame).digest('hex');
      await fsp.writeFile(path.join(cacheDirectory, `${firstFrameRequest.idempotencyKey}.identity-locked.jpg`), identityLockedFirstFrame);
      const firstFramePath = path.join(input.outputDirectory, `${input.shotId}-seedream-first-frame.jpg`);
      await fsp.writeFile(firstFramePath, identityLockedFirstFrame);
      const firstFrameDataUrl = `data:image/jpeg;base64,${identityLockedFirstFrame.toString('base64')}`;
      const productDataUrls = loadedProducts.map(item => `data:${item.mimeType};base64,${item.bytes.toString('base64')}`);
      const duration = Math.max(4, Math.min(15, Math.round(input.spec.cameraLock.durationSeconds)));
      let referenceVideoUrl: string | undefined;
      let firstFrameInput = firstFrameDataUrl;
      let productInputs = productDataUrls;
      if (supportsFullModalReference) {
        const inputPrefix = `generated/product-scene-inputs/${createHash('sha256').update(input.tenantId).digest('hex').slice(0, 24)}`;
        const firstFrameKey = `${inputPrefix}/${identityLockedHash}-first-frame.jpg`;
        await objectStorageUpload({ key: firstFrameKey, body: identityLockedFirstFrame, contentType: 'image/jpeg' });
        firstFrameInput = await objectStorageSignedGetUrl(firstFrameKey, 3600);
        productInputs = await Promise.all(loadedProducts.map(async (item, index) => {
          const hash = createHash('sha256').update(item.bytes).digest('hex');
          const extension = item.mimeType === 'image/png' ? 'png' : item.mimeType === 'image/webp' ? 'webp' : 'jpg';
          const key = `${inputPrefix}/${hash}-product-${index + 1}.${extension}`;
          await objectStorageUpload({ key, body: item.bytes, contentType: item.mimeType });
          return objectStorageSignedGetUrl(key, 3600);
        }));
        const referenceClipDuration = Math.max(2, Math.min(15,
          Number(input.spec.referenceEndSeconds || duration) - Number(input.spec.referenceStartSeconds || 0)));
        const referenceClipPath = path.join(input.outputDirectory, `${input.shotId}-seedance-reference.mp4`);
        const trim = await runVisualFfmpeg([
          '-ss', Math.max(0, Number(input.spec.referenceStartSeconds || 0)).toFixed(2),
          '-i', referencePath,
          '-t', referenceClipDuration.toFixed(2),
          '-map', '0:v:0', '-an', '-vf', 'scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280',
          '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
          '-r', '24', '-movflags', '+faststart', '-y', referenceClipPath,
        ], false, { timeoutMs: 180_000 });
        if (!trim.ok || !fs.existsSync(referenceClipPath)) throw new Error(`seedance_reference_trim_failed:${trim.stderr || 'missing_output'}`);
        const referenceClipStat = await fsp.stat(referenceClipPath);
        const referenceClipKey = `generated/product-scene-inputs/${createHash('sha256').update(input.tenantId).digest('hex').slice(0, 24)}/${createHash('sha256').update(`${input.idempotencyKey}:${input.spec.referenceStartSeconds}:${input.spec.referenceEndSeconds}`).digest('hex')}.mp4`;
        await objectStorageUploadFile({ key: referenceClipKey, filePath: referenceClipPath, contentType: 'video/mp4', contentLength: referenceClipStat.size });
        referenceVideoUrl = await objectStorageSignedGetUrl(referenceClipKey, 3600);
      }
      const video = await generateSeedanceConceptVideo({
        tenantId: input.tenantId,
        apiKey,
        model: seedanceModel,
        baseUrl: process.env.SEEDANCE_BASE_URL,
        prompt: supportsFullModalReference
          ? `${productScenePrompt(input.spec)}\n${accountProductionConstraintPrompt(input.accountPlaybookConstraints)}\nREFERENCE MAP: @image1 is the exact opening composition and product layout. Preserve it as the opening visual. The later images lock product identity. @video1 supplies environment, camera motion and timing only.`
          : `${productScenePrompt(input.spec)}\n${accountProductionConstraintPrompt(input.accountPlaybookConstraints)}\nThe supplied first frame is the exact opening composition and product layout. Animate it with the camera path described above while preserving every product.`,
        durationSeconds: duration,
        ratio: '9:16',
        resolution: '720p',
        idempotencyKey: input.idempotencyKey,
        timeoutMs: Math.max(180_000, Number(process.env.SEEDANCE_TIMEOUT_MS || 600_000)),
        firstFrameDataUrl: firstFrameInput,
        referenceImageDataUrls: supportsFullModalReference ? productInputs : undefined,
        referenceVideoUrl,
        checkpointPath: path.join(cacheDirectory, `${createHash('sha256').update(`${input.idempotencyKey}:${seedanceModel}:${identityLockedHash}`).digest('hex')}.seedance.json`),
      });
      const localPath = path.join(input.outputDirectory, `${input.shotId}-seedance-product-scene.mp4`);
      await fsp.writeFile(localPath, video.bytes);
      const qaFrames: Array<{ base64: string; mimeType: string; timeLabel: string }> = loadedProducts.map((item, index) => ({
        base64: item.bytes.toString('base64'), mimeType: item.mimeType, timeLabel: `商品参考${index + 1}`,
      }));
      for (const [index, second] of [0.2, duration / 2, Math.max(0.2, duration - 0.3)].entries()) {
        let bytes: Buffer;
        try {
          bytes = await extractJpeg(localPath, path.join(input.outputDirectory, `${input.shotId}-qa-${index + 1}.jpg`), second);
        } catch (error) {
          throw new Error(`product_scene_qa_frame_extract_${index + 1}:${error instanceof Error ? error.message : String(error)}`);
        }
        qaFrames.push({ base64: bytes.toString('base64'), mimeType: 'image/jpeg', timeLabel: `生成视频${second.toFixed(1)}秒` });
      }
      let qa: Awaited<ReturnType<typeof qualityCheckStoryboardFramesWithQwen>>;
      try {
        qa = await qualityCheckStoryboardFramesWithQwen({
          frames: qaFrames,
          storyboard: productScenePrompt(input.spec),
          productInfo: `前 ${loadedProducts.length} 张是同一生成任务的商品身份参考；后 3 张是生成视频。必须逐项核对外形、颜色、材质、Logo、标签文字和包装结构，不得把不同 SKU 混成同一商品。轻微遮挡可以接受，但任何瓶盖、泵头或喷嘴都不能被完全遮住；同组产品至少有一个必须完整露出品牌、主标签和可识别包装轮廓。标题、搜索框、渐变、字幕、按钮和角标必须留在安全区，不得遮住人物脸部、关键动作、核心产品或新闻事件主体。若违反，请在 issues 中明确写“包装可见性失败”或“主体可见性失败”。`,
          critical: true,
        });
      } catch (error) {
        throw new Error(`product_scene_semantic_qa:${error instanceof Error ? error.message : String(error)}`);
      }
      const issues = qa.issues.join(' ');
      const productIdentity = (qa.checks.productConsistency || 0) / 100;
      const storyboardMatch = (qa.checks.storyboardMatch || 0) / 100;
      const visualIntegrity = (qa.checks.visualIntegrity || 0) / 100;
      const labelOcrExactMatch = productIdentity >= 0.78 && !/(?:logo|label|文字|标签|ocr).{0,20}(?:错误|变化|不一致|模糊|乱码|缺失)/i.test(issues);
      const packagingVisibilityPassed = visualIntegrity >= 0.75 && !/(?:包装可见性失败|瓶盖|泵头|喷嘴|cap|pump|nozzle).{0,24}(?:完全遮挡|被遮住|不可见|缺失|hidden|obscured|missing)/i.test(issues);
      const subjectVisibilityPassed = visualIntegrity >= 0.75 && !/(?:主体可见性失败|人物脸部|关键动作|核心产品|新闻事件主体|hero subject|key action).{0,24}(?:遮挡|被遮住|不可见|hidden|obscured|covered)/i.test(issues);
      const evidencePath = path.join(input.outputDirectory, `${input.shotId}-product-scene-quality.json`);
      await fsp.writeFile(evidencePath, JSON.stringify({ firstFrameProviderRequestId: firstFrame.providerRequestId, seedanceTaskId: video.providerTaskId, qa }, null, 2), 'utf8');
      const contentHash = createHash('sha256').update(video.bytes).digest('hex');
      return {
        status: 'completed',
        providerId: firstFrame.provider === 'seedream' ? 'seedream-seedance' : 'seedance-full-modal',
        providerTaskId: video.providerTaskId,
        model: `${firstFrame.model}+${video.model}`,
        localPath,
        contentHash,
        duration,
        actualCostCny: Number((firstFrame.estimatedCostCny + video.estimatedCostCny).toFixed(4)),
        quality: {
          productIdentitySimilarity: Object.fromEntries(input.spec.productIdentity.groups.map(group => [group.productRef, productIdentity])),
          packagingVisibilityPassed,
          subjectVisibilityPassed,
          labelOcrExactMatch,
          sceneTopologyScore: storyboardMatch,
          productSlotLayoutScore: Math.min(productIdentity, visualIntegrity),
          cameraTrajectoryScore: storyboardMatch,
          evidenceRefs: [firstFramePath, evidencePath, ...qaFrames.slice(-3).map((_item, index) => path.join(input.outputDirectory, `${input.shotId}-qa-${index + 1}.jpg`))],
        },
      };
    },
  };
}
