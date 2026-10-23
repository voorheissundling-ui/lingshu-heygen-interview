import { createHash } from 'node:crypto';
import { validateFirstFrameRequest, type FirstFrameReference, type FirstFrameRequest } from './firstFrameGenerator.js';
/** New product-scene path: reuse a verified local match first, otherwise replace
 * the reference-shot product with actual enterprise KB packaging. No paid call. */
export function planStoryboardProductScene(input: {
    tenantId: string;
    projectId: string;
    shotId: string;
    productId: string;
    productVersion: string;
    directorScene: string;
    ratio: '9:16' | '16:9' | '1:1';
    firstFrameOrigin?: 'original_reference_pixels' | 'enterprise_authored_storyboard';
    composition?: FirstFrameReference;
    product: FirstFrameReference;
    compositionAuthorized: boolean;
    productOwned: boolean;
    operationId: string;
    frozenDurationSeconds?: number;
    localMatch?: {
        materialId: string;
        tenantId: string;
        productId: string;
        durationSeconds: number;
        semanticMatch: boolean;
        identityPassed: boolean;
        qualityPassed: boolean;
    };
}) {
    const duration = input.frozenDurationSeconds ?? 3;
    if (!Number.isFinite(duration) || duration <= 0 || !input.tenantId.trim() || !input.projectId.trim() || !input.shotId.trim() || !input.productVersion.trim() || !input.directorScene.trim() || !input.productId.trim())
        throw Error('product_scene_plan_invalid');
    const local = input.localMatch;
    if (local && local.materialId.trim() && local.tenantId === input.tenantId && local.productId === input.productId && local.semanticMatch && local.identityPassed && local.qualityPassed && local.durationSeconds >= duration)
        return { route: 'reuse_local' as const, materialId: local.materialId, desiredDurationSeconds: duration };
    const authored = input.firstFrameOrigin === 'enterprise_authored_storyboard';
    if (!authored && (!input.compositionAuthorized || !input.productOwned || input.composition?.role !== 'source_composition' || input.product.role !== 'product_identity'))
        throw Error('product_scene_authorized_composition_and_KB_required');
    if (!input.productOwned || input.product.role !== 'product_identity') throw Error('product_scene_owned_KB_required');
    const visibilityRule = 'Packaging visibility is mandatory: minor overlap is allowed, but no cap, pump or nozzle may be fully hidden. Keep the brand, primary label and recognizable package form visible; when several units of the same product appear, at least one unit must show all of those identity anchors unobstructed. Reserve explicit negative-space safe zones for all content-packaging modules (headline, search card, gradient, captions, buttons and brand tile); those modules must not cover faces, key actions, hero products or the news-event subject. Preserve the benchmark module positions and create the safe zone by lowering or rescaling the source composition visual centre; do not solve subject overlap by arbitrarily moving the content module away from the template.';
    const prompt = authored ? `Author an original enterprise product storyboard first frame from the supplied actual KB packaging image. Use only the frozen director scene and camera specification for setting, framing, lighting and action; structural references supply no original video pixels. Preserve the exact package geometry and all printed labels, brand, quantity and marks from the KB image. ${visibilityRule} Do not invent product claims or manufacturing evidence, or add on-screen captions. Director shot specification: ${input.directorScene}` : `Edit image 1, the original storyboard first-frame composition. Replace only the depicted product and its packaging with the actual enterprise product packaging in image 2. Preserve the original shot's composition, setting, lighting, object placement and director action unless replacement requires fitting the correct package. Image 2 is the sole product-identity authority: preserve its brand, printed product name, quantity, label texture, marks and package geometry. ${visibilityRule} Do not invent claims, contents or factory/manufacturing evidence. Do not replace the scene with a generic neutral tabletop. No new on-screen captions or logos outside the original packaging. Director shot specification: ${input.directorScene}`;
    const request: FirstFrameRequest = { referenceMode: authored ? 'storyboard_scene' : 'product_scene', tenantId: input.tenantId, videoId: input.projectId, compositionId: input.shotId, presenterVersion: input.productVersion, prompt, ratio: input.ratio, references: authored ? [input.product] : [input.composition!, input.product], idempotencyKey: input.operationId };
    validateFirstFrameRequest(request);
    const identity = createHash('sha256').update(JSON.stringify({ productId: input.productId, productVersion: input.productVersion, firstFrameOrigin: input.firstFrameOrigin ?? 'original_reference_pixels', compositionSha256: authored ? null : input.composition!.sha256, productSha256: input.product.sha256, directorScene: input.directorScene, desiredDurationSeconds: duration })).digest('hex');
    return { route: authored ? 'author_product_first_frame' as const : 'replace_product_first_frame' as const, request, identity, desiredDurationSeconds: duration, seedanceFastProviderDurationSeconds: Math.max(4, Math.ceil(duration)), requiresExplicitTrim: duration < 4 };
}
