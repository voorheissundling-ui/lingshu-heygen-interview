import { createHash } from 'node:crypto';
import {
  currentContentProviderReceipt,
  recordCurrentContentProviderReceipt,
} from '../contentExecution/context.js';
import {QWEN_COMPATIBLE_BASE_URL} from './qwenCompatibleEndpoint.js';

export interface ReferenceImage {
  mimeType: string;
  base64: string;
}

export interface GeneratedImage {
  bytes: Buffer;
  mimeType: string;
  source: 'openai' | 'qwen';
  model: string;
}

export type ImageGenerationQuality = 'low' | 'medium' | 'high';

export function normalizeImageGenerationQuality(value: unknown): ImageGenerationQuality {
  return value === 'medium' || value === 'high' ? value : 'low';
}

/** A definitive client-side provider rejection: no image task was accepted. */
export class ImageProviderRejectedError extends Error {
  constructor(public readonly statusCode: number, message: string) { super(message); }
}

function normalizeMime(mimeType?: string): string {
  if (!mimeType) return 'image/png';
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'image/jpeg';
  if (mimeType.includes('webp')) return 'image/webp';
  return 'image/png';
}

function extFromMime(mimeType: string): string {
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
  if (mimeType.includes('webp')) return 'webp';
  if (mimeType.includes('gif')) return 'gif';
  return 'png';
}

export function imageExt(mimeType: string): string {
  return extFromMime(mimeType);
}

function qwenImageEndpoint(): string {
  const configured = String(process.env.DASHSCOPE_IMAGE_BASE_URL || process.env.DASHSCOPE_BASE_URL || '').trim();
  const base = (configured || QWEN_COMPATIBLE_BASE_URL).replace(/\/+$/, '');
  if (!/\/compatible-mode\/v1$/i.test(base)) throw new Error('DASHSCOPE_IMAGE_BASE_URL 必须是百炼 OpenAI 兼容端点（…/compatible-mode/v1）');
  return `${base}/images/generations`;
}

function qwenSizeFor(ratio: string): string {
  const normalized = String(ratio || '').trim();
  if (normalized === '9:16' || normalized === '720:1280') return '1024x1792';
  if (normalized === '16:9' || normalized === '1280:720') return '1792x1024';
  return '1024x1024';
}

function qwenImageUrl(payload: any): string {
  const item = Array.isArray(payload?.data) ? payload.data[0] : undefined;
  const url = String(item?.url || payload?.output?.choices?.[0]?.message?.content?.[0]?.image || '').trim();
  if (!/^https:\/\//i.test(url)) throw new Error('Qwen Image 返回结果缺少 HTTPS 图片地址');
  return url;
}

async function generateQwenImage(input: {
  prompt: string;
  ratio: string;
  references?: ReferenceImage[];
  idempotencyKey?: string;
  recoveryOnly?: boolean;
}): Promise<GeneratedImage> {
  const apiKey = (process.env.DASHSCOPE_API_KEY || '').trim();
  if (!apiKey) throw new Error('DASHSCOPE_API_KEY is not configured');
  const model = (process.env.QWEN_IMAGE_MODEL || 'qwen-image-3.0').trim();
  const requestId = createHash('sha256').update(input.idempotencyKey ? JSON.stringify({operationKey:input.idempotencyKey,model,ratio:input.ratio,prompt:input.prompt,references:(input.references||[]).slice(0,3).map(ref=>({mimeType:normalizeMime(ref.mimeType),sha256:createHash('sha256').update(Buffer.from(ref.base64,'base64')).digest('hex')}))}) : `${model}\0${input.ratio}\0${input.prompt}`).digest('hex');
  const prior = currentContentProviderReceipt({ provider: 'qwen_image', requestId });
  if (prior && ['submitting', 'unknown'].includes(prior.state)) {
    throw new Error('provider_submission_unknown:qwen_image:requires_manual_reconciliation');
  }
  if(prior&&['accepted','completed'].includes(prior.state)&&!/^https:\/\//i.test(String(prior.metadata.outputUrl||'')))throw new Error('provider_submission_unknown:qwen_image:accepted_output_reference_missing');
  // Qwen Image accepts at most three ordered reference images.
  const refs = (input.references || []).slice(0, 3);
  let url = String(prior?.metadata.outputUrl || '');
  if (!/^https:\/\//i.test(url)) {
    if(input.recoveryOnly)throw new Error('provider_submission_unknown:qwen_image:recovery_requires_existing_output');
    await recordCurrentContentProviderReceipt({
      provider: 'qwen_image', requestId, state: 'submitting', metadata: { model },
    });
    let response: Response;
    try {
      response = await fetch(qwenImageEndpoint(), {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: input.prompt, ...(refs.length ? { image: refs.map(ref => `data:${normalizeMime(ref.mimeType)};base64,${ref.base64}`) } : {}), n: 1, size: qwenSizeFor(input.ratio) }),
        // Image synthesis is synchronous on this endpoint and can exceed the
        // text-generation timeout. Avoid turning a healthy long render into an
        // outcome-unknown request that must not be blindly submitted again.
        signal: AbortSignal.timeout(180_000),
      });
    } catch (error) {
      await recordCurrentContentProviderReceipt({ provider: 'qwen_image', requestId, state: 'unknown', metadata: { model } });
      throw new Error('provider_submission_unknown:qwen_image:transport_outcome_uncertain');
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const definitive=[400,401,403,404,422].includes(response.status);
      await recordCurrentContentProviderReceipt({ provider: 'qwen_image', requestId, state: definitive?'failed':'unknown', metadata: { model, statusCode: response.status } });
      const message = `Qwen Image ${response.status}: ${String(payload?.message || payload?.error?.message || response.statusText).slice(0, 500)}`;
      if ([400, 401, 403, 404, 422].includes(response.status)) throw new ImageProviderRejectedError(response.status, message);
      throw new Error('provider_submission_unknown:qwen_image:response_outcome_uncertain');
    }
    try{url=qwenImageUrl(payload);}catch{await recordCurrentContentProviderReceipt({provider:'qwen_image',requestId,state:'unknown',metadata:{model}});throw new Error('provider_submission_unknown:qwen_image:output_reference_missing');}
    await recordCurrentContentProviderReceipt({
      provider: 'qwen_image', requestId, state: 'accepted', metadata: { model, outputUrl: url },
    });
  }
  const image = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!image.ok) throw new Error(`Qwen Image 产物下载失败：HTTP ${image.status}`);
  const result = { bytes: Buffer.from(await image.arrayBuffer()), mimeType: normalizeMime(image.headers.get('content-type') || 'image/png'), source: 'qwen' as const, model };
  await recordCurrentContentProviderReceipt({
    provider: 'qwen_image', requestId, state: 'completed', metadata: { model, outputUrl: url, mimeType: result.mimeType },
  });
  return result;
}

function openAiImageBaseUrl(): string {
  const base = String(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
  if (!/^https:\/\//i.test(base) && !/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/|$)/i.test(base)) {
    throw new Error('OPENAI_BASE_URL 必须是 HTTPS 地址或本机测试地址');
  }
  return base;
}

function openAiSizeFor(ratio: string): string {
  const normalized = String(ratio || '').trim();
  if (['9:16', '720:1280', '4:5'].includes(normalized)) return '1024x1536';
  if (['16:9', '1280:720'].includes(normalized)) return '1536x1024';
  return '1024x1024';
}

type OpenAiImageOutput = { base64?: string; url?: string };

/**
 * OpenAI-compatible image gateways do not all expose the completed image at
 * the same JSON path. Keep the accepted shapes explicit so an unrelated
 * string in the response can never be mistaken for image bytes.
 */
export function openAiImageOutput(payload: any): OpenAiImageOutput {
  const dataItem = Array.isArray(payload?.data) ? payload.data[0] : undefined;
  const outputItem = Array.isArray(payload?.output)
    ? payload.output.find((item: any) => item?.b64_json || item?.url || item?.image_url)
    : payload?.output;
  const resultItem = Array.isArray(payload?.result) ? payload.result[0] : payload?.result;
  const base64 = String(
    dataItem?.b64_json || payload?.b64_json || outputItem?.b64_json || resultItem?.b64_json || '',
  ).trim();
  if (base64) return { base64 };
  const url = String(
    dataItem?.url || dataItem?.image_url || payload?.url || payload?.image_url
      || outputItem?.url || outputItem?.image_url || resultItem?.url || resultItem?.image_url || '',
  ).trim();
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(url)) return { base64: url.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '') };
  if (/^https:\/\//i.test(url)) return { url };
  return {};
}

export function openAiImageStreamOutput(body: string): OpenAiImageOutput {
  let latest: OpenAiImageOutput = {};
  for (const block of String(body || '').split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trim())
      .join('\n');
    if (!data || data === '[DONE]') continue;
    try {
      const parsed = JSON.parse(data);
      const candidate = openAiImageOutput(parsed);
      if (candidate.base64 || candidate.url) latest = candidate;
    } catch {
      // Ignore keep-alives or non-JSON gateway notices. A missing completed
      // image is handled as an outcome-unknown response below.
    }
  }
  return latest;
}

async function readOpenAiImageResponse(response: Response): Promise<{ payload: any; output: OpenAiImageOutput }> {
  const body = await response.text();
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('text/event-stream') || /^\s*(?:event:|data:)/m.test(body)) {
    return { payload: { stream: true }, output: openAiImageStreamOutput(body) };
  }
  try {
    const payload = JSON.parse(body || '{}');
    return { payload, output: openAiImageOutput(payload) };
  } catch {
    return { payload: { invalidJson: true }, output: {} };
  }
}

function openAiPayloadShape(payload: any): Record<string, unknown> {
  const item = Array.isArray(payload?.data) ? payload.data[0] : undefined;
  return {
    topLevelKeys: payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 20) : [],
    dataLength: Array.isArray(payload?.data) ? payload.data.length : undefined,
    dataItemKeys: item && typeof item === 'object' ? Object.keys(item).slice(0, 20) : [],
    outputType: Array.isArray(payload?.output) ? 'array' : typeof payload?.output,
  };
}

async function generateOpenAiImage(input: {
  prompt: string;
  ratio: string;
  references?: ReferenceImage[];
  quality: ImageGenerationQuality;
  idempotencyKey?: string;
  recoveryOnly?: boolean;
}): Promise<GeneratedImage> {
  const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');
  const model = 'gpt-image-2';
  const quality = input.quality;
  const size = openAiSizeFor(input.ratio);
  const refs = (input.references || []).slice(0, 16);
  const requestId = createHash('sha256').update(input.idempotencyKey ? JSON.stringify({
    operationKey: input.idempotencyKey, model, quality, size, prompt: input.prompt,
    references: refs.map(ref => ({ mimeType: normalizeMime(ref.mimeType), sha256: createHash('sha256').update(Buffer.from(ref.base64, 'base64')).digest('hex') })),
  }) : `${model}\0${quality}\0${size}\0${input.prompt}`).digest('hex');
  const prior = currentContentProviderReceipt({ provider: 'openai_image', requestId });
  if (prior && ['submitting', 'unknown'].includes(prior.state)) throw new Error('provider_submission_unknown:openai_image:requires_manual_reconciliation');
  if (prior && ['accepted', 'completed'].includes(prior.state)) throw new Error('provider_submission_unknown:openai_image:completed_output_not_persisted');
  if (input.recoveryOnly) throw new Error('provider_submission_unknown:openai_image:recovery_requires_existing_output');

  await recordCurrentContentProviderReceipt({ provider: 'openai_image', requestId, state: 'submitting', metadata: { model, quality, size } });
  let response: Response;
  try {
    response = await fetch(`${openAiImageBaseUrl()}${refs.length ? '/images/edits' : '/images/generations'}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, prompt: input.prompt, quality, size, n: 1, output_format: 'png',
        stream: true, partial_images: 0,
        ...(refs.length ? { images: refs.map(ref => ({ image_url: `data:${normalizeMime(ref.mimeType)};base64,${ref.base64}` })) } : {}),
      }),
      signal: AbortSignal.timeout(Number(process.env.OPENAI_IMAGE_TIMEOUT_MS || 360_000)),
    });
  } catch {
    await recordCurrentContentProviderReceipt({ provider: 'openai_image', requestId, state: 'unknown', metadata: { model, quality, size } });
    throw new Error('provider_submission_unknown:openai_image:transport_outcome_uncertain');
  }
  const { payload, output } = await readOpenAiImageResponse(response);
  if (!response.ok) {
    const definitive = [400, 401, 403, 404, 422].includes(response.status);
    await recordCurrentContentProviderReceipt({ provider: 'openai_image', requestId, state: definitive ? 'failed' : 'unknown', metadata: { model, quality, size, statusCode: response.status } });
    const message = `OpenAI Image ${response.status}: ${String(payload?.error?.message || payload?.message || response.statusText).slice(0, 500)}`;
    if (definitive) throw new ImageProviderRejectedError(response.status, message);
    throw new Error('provider_submission_unknown:openai_image:response_outcome_uncertain');
  }
  if (!output.base64 && !output.url) {
    await recordCurrentContentProviderReceipt({ provider: 'openai_image', requestId, state: 'unknown', metadata: { model, quality, size, responseShape: openAiPayloadShape(payload) } });
    throw new Error('provider_submission_unknown:openai_image:output_missing');
  }
  let bytes: Buffer;
  let mimeType = 'image/png';
  if (output.base64) {
    bytes = Buffer.from(output.base64, 'base64');
  } else {
    const image = await fetch(output.url!, { signal: AbortSignal.timeout(180_000), redirect: 'follow' });
    if (!image.ok) {
      await recordCurrentContentProviderReceipt({ provider: 'openai_image', requestId, state: 'unknown', metadata: { model, quality, size, outputUrl: output.url, statusCode: image.status } });
      throw new Error('provider_submission_unknown:openai_image:output_download_failed');
    }
    bytes = Buffer.from(await image.arrayBuffer());
    mimeType = normalizeMime(image.headers.get('content-type') || 'image/png');
  }
  if (!bytes.length) {
    await recordCurrentContentProviderReceipt({ provider: 'openai_image', requestId, state: 'unknown', metadata: { model, quality, size, outputUrl: output.url } });
    throw new Error('provider_submission_unknown:openai_image:output_empty');
  }
  const result = { bytes, mimeType, source: 'openai' as const, model };
  await recordCurrentContentProviderReceipt({ provider: 'openai_image', requestId, state: 'completed', metadata: { model, quality, size, mimeType: result.mimeType } });
  return result;
}

export async function generatePosterImage(input: {
  prompt: string;
  ratio: string;
  references?: ReferenceImage[];
  provider?: 'openai' | 'qwen';
  quality?: ImageGenerationQuality;
  idempotencyKey?: string;
  recoveryOnly?: boolean;
}): Promise<GeneratedImage> {
  // Provider choice is explicit at the product route. A failed paid request must
  // never fan out to another supplier and create an unreviewed second charge.
  if (input.provider === 'openai') return generateOpenAiImage({ ...input, quality: input.quality || 'low' });
  return generateQwenImage(input);
}
