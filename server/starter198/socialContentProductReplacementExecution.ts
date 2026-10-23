import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { planStoryboardProductScene } from '../lib/storyboardProductScenePreparation.js';
import { runVisualFfmpeg } from '../lib/renderVisualQuality.js';
import type { FirstFrameReference, FirstFrameRequest } from '../lib/firstFrameGenerator.js';
import type { ProductSceneExecutionPorts, ProductSceneQualityReport } from './socialContentProductSceneAdapter.js';
type Input = Parameters<ProductSceneExecutionPorts['execute']>[0];
export interface ProductReplacementPorts {
    estimatedCostCny?: () => number;
    /** Trusted server receipt directory, independent of render workspace cleanup. */
    evidenceDirectory?: string;
    assertCurrent: () => Promise<void>;
    /** True only when both the video and its QA operation are funded. */
    canUseVideoAttempt?: (attempt: 0 | 1) => boolean;
    composition: (input: Input) => Promise<{
        reference: FirstFrameReference;
        usageEvidenceRef: string;
    } | null>;
    products: (input: Input) => Promise<FirstFrameReference[]>;
    firstFrame: (request: FirstFrameRequest) => Promise<{
        bytes: Buffer;
        providerRequestId: string;
        model: string;
        estimatedCostCny: number;
        canProceedToVideo: boolean;
        evidenceRefs: string[];
    }>;
    video: (input: {
        attempt?: 0 | 1;
        requestId: string;
        firstFrame: Buffer;
        prompt: string;
        providerDurationSeconds: number;
        checkpointPath: string;
    }) => Promise<{
        bytes: Buffer;
        providerTaskId: string;
        model: string;
        estimatedCostCny: number;
    }>;
    quality: (input: {
        attempt?: 0 | 1;
        filePath: string;
        durationSeconds: number;
        productReferences: FirstFrameReference[];
        composition?: FirstFrameReference;
        firstFrame: Buffer;
        directorScene: string;
    }) => Promise<ProductSceneQualityReport>;
}
export async function trimAndProbeProductScene(sourcePath: string, targetPath: string, duration: number) {
    if (!Number.isFinite(duration) || duration <= 0)
        throw Error('product_target_duration_invalid');
    const trim = await runVisualFfmpeg(['-i', sourcePath, '-t', String(duration), '-map', '0:v:0', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '24', '-movflags', '+faststart', '-y', targetPath], false, { timeoutMs: 120000 });
    if (!trim.ok)
        throw Error('product_actual_trim_failed');
    const probe = await runVisualFfmpeg(['-i', targetPath, '-map', '0:v:0', '-f', 'null', '-'], false, { timeoutMs: 120000, logLevel: 'info' });
    const match = probe.stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
    const actual = match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : NaN;
    if (!probe.ok || !Number.isFinite(actual) || Math.abs(actual - duration) > 1 / 24 + .01 || /Stream #0:\d[^\n]*Audio:/.test(probe.stderr))
        throw Error('product_actual_trim_probe_failed');
    return actual;
}

/** Explicit type-aware policy only. Historic shots retain their prior executor. */
export async function executeProductReplacementScene(input: Input, ports: ProductReplacementPorts) {
    const routing = input.materialRouting, g = routing?.generation;
    const authored = g?.method === 'enterprise_authored_product_first_frame_i2v';
    if (routing?.policy !== 'local_first_product_i2v' || routing.materialType !== 'product' || (!authored && g?.method !== 'reference_first_frame_product_replacement_i2v') || (authored && g?.firstFrameOrigin !== 'enterprise_authored_storyboard') || (!authored && g?.firstFrameOrigin !== undefined && g.firstFrameOrigin !== 'original_reference_pixels') || !g || g.durationSeconds !== input.spec.cameraLock.durationSeconds)
        throw Error('product_replacement_contract_invalid');
    if (!authored && (!g.referenceSourceId || !g.referenceShotId))
        throw Error('product_reference_first_frame_missing');
    await ports.assertCurrent();
    const composition = authored ? null : await ports.composition(input);
    if (!authored && (!composition?.usageEvidenceRef || composition.reference.role !== 'source_composition'))
        throw Error('product_reference_pixels_usage_missing');
    const products = await ports.products(input);
    if (!products.length || products.some(p => p.role !== 'product_identity'))
        throw Error('product_KB_packaging_missing');
    const directorScene = JSON.stringify({ scene: input.spec.sceneLock, compositionSafety: input.spec.compositionSafety, camera: input.spec.cameraLock });
    const plan = planStoryboardProductScene({
        tenantId: input.tenantId,
        projectId: input.taskId,
        shotId: input.shotId,
        productId: input.spec.productIdentity.groups[0]?.productRef || '',
        productVersion: products.map(p => p.sha256).join(':'),
        directorScene,
        ratio: '9:16',
        composition: composition?.reference,
        firstFrameOrigin: authored ? 'enterprise_authored_storyboard' : 'original_reference_pixels',
        product: products[0]!,
        compositionAuthorized: true,
        productOwned: true,
        operationId: input.idempotencyKey + ':product-replacement-first-frame',
        frozenDurationSeconds: g.durationSeconds,
    });
    if (plan.route !== 'replace_product_first_frame' && plan.route !== 'author_product_first_frame')
        throw Error('product_replacement_plan_unexpected');
    // Keep every specified same-product KB reference, not a guessed SKU.
    plan.request.references = authored ? products : [composition!.reference, ...products];
    const frame = await ports.firstFrame(plan.request);
    if (!frame.canProceedToVideo || !frame.bytes.length || !frame.evidenceRefs.length)
        throw Error('product_replacement_first_frame_identity_QA_failed');
    await ports.assertCurrent();
    const hash = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
    const providerDurationSeconds = g.videoProvider === 'wan' ? (g.videoModel === 'wan2.2-i2v-flash' ? 5 : Math.max(2,Math.ceil(g.durationSeconds))) : plan.seedanceFastProviderDurationSeconds;
    if(g.videoProvider==='wan'&&(!['wan2.6-i2v-flash','wan2.2-i2v-flash'].includes(g.videoModel||'')||!Number.isInteger(providerDurationSeconds)||providerDurationSeconds<2||providerDurationSeconds>15||(g.videoModel==='wan2.2-i2v-flash'&&g.durationSeconds>5)))throw Error('product_wan_frozen_duration_invalid');
    const identity = hash(JSON.stringify({ request: plan.identity, firstFrameSha256: hash(frame.bytes), providerDuration: providerDurationSeconds, targetDuration: g.durationSeconds }));
    let video!: Awaited<ReturnType<ProductReplacementPorts['video']>>, quality!: ProductSceneQualityReport, duration = 0, target = '';
    const failedAigcQualityEvidence: string[] = [];
    let attemptedVideos = 0;
    const qualityFailed = (report: ProductSceneQualityReport) => input.spec.productIdentity.groups.some(group =>
      Number(report.productIdentitySimilarity[group.productRef] || 0) < input.spec.productIdentity.identitySimilarityMinimum)
      || input.spec.validation.requiredChecks.includes('packaging_visibility') && report.packagingVisibilityPassed !== true
      || input.spec.validation.requiredChecks.includes('subject_visibility') && report.subjectVisibilityPassed !== true
      || input.spec.productIdentity.ocrExactMatchRequired && !report.labelOcrExactMatch
      || report.sceneTopologyScore < .75 || report.productSlotLayoutScore < .75 || report.cameraTrajectoryScore < .75 || !report.evidenceRefs.length;
    for (const attempt of [0, 1] as const) {
      const retry = attempt === 1;
      if (retry && (!input.spec.validation.singleShotRetryOnFailure || !qualityFailed(quality))) break;
      if (ports.canUseVideoAttempt && !ports.canUseVideoAttempt(attempt)) break;
      attemptedVideos++;
      const attemptIdentity = retry ? `${identity}:attempt:1` : identity;
      video = await ports.video({ attempt,
        // Attempt zero keeps its historical durable identity so an in-flight
        // task recovers the accepted provider request instead of resubmitting it.
        requestId: `${input.idempotencyKey}:${attemptIdentity}`,
        firstFrame: frame.bytes,
        prompt: `Animate the supplied actual approved enterprise product first frame according to this director shot: ${directorScene}. Preserve product packaging, labels and composition. Minor overlap is allowed, but no cap, pump or nozzle may be fully hidden; keep at least one complete brand, primary-label and package-form identity anchor visible for each product group. Keep all content-packaging modules inside reserved negative-space safe zones; never cover faces, key actions, hero products or the news-event subject. No added text or fabricated manufacturing facts.${retry ? ' This is the single directed correction: keep the supplied first frame unchanged, restore packaging and subject visibility where needed, and correct the prior video quality failure without changing product identity or scene topology.' : ''}`,
        providerDurationSeconds,
        checkpointPath: path.join(input.outputDirectory, `${attemptIdentity}${g.videoProvider==='wan'?'.wan.json':'.seedance.json'}`),
      });
      fs.mkdirSync(input.outputDirectory, { recursive: true, mode: 0o700 });
      const original = path.join(input.outputDirectory, `${input.shotId}-${identity}-attempt-${attempt}-provider.mp4`);
      target = path.join(input.outputDirectory, `${input.shotId}-${identity}-attempt-${attempt}-delivery.mp4`);
      fs.writeFileSync(original, video.bytes, { mode: 0o600 });
      duration = await trimAndProbeProductScene(original, target, g.durationSeconds);
      quality = await ports.quality({ attempt, filePath: target, durationSeconds: duration, productReferences: products, composition: composition?.reference, firstFrame: frame.bytes, directorScene: plan.request.prompt });
      if (!qualityFailed(quality)) break;
      failedAigcQualityEvidence.push(...quality.evidenceRefs);
    }
    if (!attemptedVideos) throw Error('product_video_funded_attempt_missing');
    if (qualityFailed(quality)) {
      const failureEvidence = path.join(ports.evidenceDirectory || input.outputDirectory, `${input.shotId}-${identity}-product-video-failed-QA.json`);
      fs.mkdirSync(path.dirname(failureEvidence), { recursive: true, mode: 0o700 });
      fs.writeFileSync(failureEvidence, JSON.stringify({
        schemaVersion: 'social-product-video-failed-QA.v1', passed: false,
        attemptedVideoCount: attemptedVideos,
        firstFrameSha256: hash(frame.bytes),
        quality,
        evidenceRefs: failedAigcQualityEvidence,
        reason: 'available_authorized_aigc_video_attempts_failed_quality_gate',
        forbiddenFallbacks: ['still_image_zoom', 'still_image_pan', 'slideshow', 'motion_graphics'],
      }, null, 2), { mode: 0o600 });
      throw Error(`product_scene_quality_failed_after_retry:${failureEvidence}`);
    }
    const contentHash = hash(fs.readFileSync(target));
    const evidenceDirectory = ports.evidenceDirectory || input.outputDirectory;
    fs.mkdirSync(evidenceDirectory, {recursive: true, mode: 0o700});
    const lineage = path.join(evidenceDirectory, input.shotId + '-' + identity + '-trim-lineage.json');
    fs.writeFileSync(lineage, JSON.stringify({provider:g.videoProvider??'seedance',model:video.model,providerTaskId:video.providerTaskId,sourceSha256:hash(video.bytes),deliveredSha256:contentHash,providerDurationSeconds,actualDeliveredDurationSeconds:duration,transform:'ffmpeg video-only re-encode trim; no tempo or still-image synthesis',fallbackCostCny:null,firstFrameOrigin:authored?'enterprise_authored_storyboard':'original_reference_pixels',compositionSha256:composition?.reference.sha256??null,productSha256s:products.map(p=>p.sha256),usageEvidenceRef:composition?.usageEvidenceRef??null,humanApproved:false},null,2),{mode:0o600});
    return {status:'completed' as const,providerId:g.videoProvider==='wan'?'seedream-product-replacement-wan':'seedream-product-replacement-seedance',providerTaskId:video.providerTaskId,model:frame.model+'+'+video.model,localPath:target,contentHash,duration,actualCostCny:null,estimatedCostCny:ports.estimatedCostCny?.()??frame.estimatedCostCny+video.estimatedCostCny,quality:{...quality,evidenceRefs:[...frame.evidenceRefs,...quality.evidenceRefs,lineage]}};
}
