import { createHash } from 'node:crypto';
import { objectStorageHead, objectStorageUpload } from '../storage/objectStorage.js';
import { FirstFrameProviderError, firstFrameInputFingerprint, type FirstFrameGenerator, type FirstFrameRequest } from './firstFrameGenerator.js';
import { firstFrameBudget, type FirstFrameBudget } from './firstFrameBudget.js';

export type ProducedFirstFrame = { status: 'completed'; operationId: string; objectKey: string; contentSha256: string; provider: string; model: string; providerRequestId: string; estimatedCostCny: number };

export async function produceFirstFrame(input: FirstFrameRequest, generator: FirstFrameGenerator, dependencies: { budget?: FirstFrameBudget; upload?: typeof objectStorageUpload; head?: typeof objectStorageHead } = {}): Promise<ProducedFirstFrame> {
  const operationId = firstFrameInputFingerprint(input, generator.provider, generator.model);
  if (input.idempotencyKey !== operationId) throw new Error('首帧幂等键与生成输入不一致');
  const budget = dependencies.budget || firstFrameBudget;
  const reservation = await budget.reserve({ tenantId: input.tenantId, videoId: input.videoId, operationId, compositionId: input.compositionId, estimatedCostCny: generator.estimatedCostCny });
  if (reservation.existing) {
    if (reservation.entry.status === 'completed' && reservation.entry.output) return reservation.entry.output as ProducedFirstFrame;
    throw new Error(`首帧请求 ${reservation.entry.status}，请核对原请求，禁止自动重提`);
  }
  try {
    const generated = await generator.generate(input); const contentSha256 = createHash('sha256').update(generated.bytes).digest('hex');
    const extension = generated.mimeType === 'image/png' ? 'png' : generated.mimeType === 'image/webp' ? 'webp' : 'jpg';
    const objectKey = `first-frames/tenants/${encodeURIComponent(input.tenantId)}/${encodeURIComponent(input.videoId)}/${operationId}.${extension}`;
    await (dependencies.upload || objectStorageUpload)({ key: objectKey, body: generated.bytes, contentType: generated.mimeType });
    const stored = await (dependencies.head || objectStorageHead)(objectKey); if (!stored || stored.size !== generated.bytes.length) throw new FirstFrameProviderError('首帧已生成但入库校验失败', 'uncertain', generated.providerRequestId);
    const output: ProducedFirstFrame = { status: 'completed', operationId, objectKey, contentSha256, provider: generated.provider, model: generated.model, providerRequestId: generated.providerRequestId, estimatedCostCny: generated.estimatedCostCny };
    await budget.mark(input.tenantId, input.videoId, operationId, 'completed', output); return output;
  } catch (error) {
    if (error instanceof FirstFrameProviderError && error.status === 'rejected' && error.submissionBoundary === 'before_submit') await budget.releaseRejected(input.tenantId, input.videoId, operationId);
    else await budget.mark(input.tenantId, input.videoId, operationId, 'uncertain', {
      error: error instanceof Error ? error.message : 'unknown',
      ...(error instanceof FirstFrameProviderError && error.providerRequestId ? { providerRequestId: error.providerRequestId } : {}),
    });
    throw error;
  }
}
