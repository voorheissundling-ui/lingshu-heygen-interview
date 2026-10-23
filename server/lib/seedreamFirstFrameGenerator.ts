import { FirstFrameProviderError, validateFirstFrameRequest, type FirstFrameGenerator, type FirstFrameRequest, type FirstFrameResult } from './firstFrameGenerator.js';

type SeedreamPayload = { data?: Array<{ b64_json?: string; url?: string }>; model?: string; error?: { message?: string }; message?: string };

function dataUrl(reference: FirstFrameRequest['references'][number]): string {
  return `data:${reference.mimeType};base64,${reference.bytes.toString('base64')}`;
}

function seedreamSize(ratio: FirstFrameRequest['ratio'], model: string): string {
  // Pro/Flash accept the documented 1.5K tier. Earlier 5.0/4.x models require
  // the larger 2K pixel floor. Returning a URL keeps the response socket small.
  const supports15k = /seedream-5-0-(?:pro|flash)-/i.test(model);
  if (ratio === '9:16') return supports15k ? '1152x2048' : '1600x2848';
  if (ratio === '16:9') return supports15k ? '2048x1152' : '2848x1600';
  return '1536x1536';
}

function mimeFromResponse(contentType: string | null): FirstFrameResult['mimeType'] {
  if (/webp/i.test(contentType || '')) return 'image/webp';
  if (/jpe?g/i.test(contentType || '')) return 'image/jpeg';
  return 'image/png';
}

function transportFailure(error: unknown): string {
  if (!(error instanceof Error)) return 'network_error';
  const cause = error.cause;
  if (cause && typeof cause === 'object') {
    const record = cause as { code?: unknown; message?: unknown };
    const code = String(record.code || '').trim();
    const message = String(record.message || '').trim();
    return [error.message, code, message].filter(Boolean).join(' / ').slice(0, 300);
  }
  return error.message.slice(0, 300);
}

export class SeedreamFirstFrameGenerator implements FirstFrameGenerator {
  readonly provider = 'seedream' as const;
  readonly model: string;
  readonly estimatedCostCny: number;
  constructor(private readonly options: { apiKey?: string; baseUrl?: string; model?: string; estimatedCostCny?: number; timeoutMs?: number; transport?: typeof fetch; beforeSubmit?: (request: Record<string, unknown>) => Promise<void> } = {}) {
    this.model = options.model || process.env.SEEDREAM_IMAGE_MODEL || 'doubao-seedream-5-0-pro-260628';
    this.estimatedCostCny = options.estimatedCostCny ?? Number(process.env.SEEDREAM_FIRST_FRAME_ESTIMATED_CNY || 0.22);
  }

  async generate(input: FirstFrameRequest): Promise<FirstFrameResult> {
    validateFirstFrameRequest(input);
    const apiKey = String(this.options.apiKey || process.env.SEEDREAM_API_KEY || process.env.SEEDANCE_API_KEY || '').trim();
    if (!apiKey) throw new FirstFrameProviderError('Seedream 未配置方舟 API Key', 'rejected', '', 'before_submit');
    if (!Number.isFinite(this.estimatedCostCny) || this.estimatedCostCny <= 0) throw new FirstFrameProviderError('Seedream 首帧预计费用配置无效', 'rejected', '', 'before_submit');
    const base = String(this.options.baseUrl || process.env.SEEDREAM_BASE_URL || process.env.SEEDANCE_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/+$/, '');
    const fetcher = this.options.transport || fetch;
    const timeoutMs = Math.max(30_000, this.options.timeoutMs ?? Number(process.env.SEEDREAM_TIMEOUT_MS || 300_000));
    const request = { model: this.model, prompt: input.prompt.trim(), ...(input.references.length ? { image: input.references.map(dataUrl) } : {}), size: seedreamSize(input.ratio, this.model), response_format: 'url', output_format: 'jpeg', watermark: false };
    await this.options.beforeSubmit?.(structuredClone(request));
    let response: Response;
    try {
      response = await fetcher(`${base}/images/generations`, { method: 'POST', headers: {
        Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Client-Request-Id': input.idempotencyKey,
      }, body: JSON.stringify(request), signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    } catch (error) {
      throw new FirstFrameProviderError(`Seedream 请求状态未知：${transportFailure(error)}`, 'uncertain', input.idempotencyKey);
    }
    const requestId = response.headers.get('x-request-id') || response.headers.get('x-tt-logid') || input.idempotencyKey;
    const payload = await response.json().catch(() => ({})) as SeedreamPayload;
    if (!response.ok) {
      // A timeout, throttled response or upstream fault does not prove that the
      // billable generation was rejected. Keep its reservation for reconciliation.
      const rejected = [400, 401, 403, 404, 422].includes(response.status);
      throw new FirstFrameProviderError(`Seedream ${response.status}: ${String(payload.error?.message || payload.message || response.statusText).slice(0, 300)}`, rejected ? 'rejected' : 'uncertain', requestId);
    }
    const item = payload.data?.[0];
    let bytes: Buffer; let mimeType: FirstFrameResult['mimeType'] = 'image/jpeg';
    if (item?.b64_json) bytes = Buffer.from(item.b64_json, 'base64');
    else if (/^https:\/\//i.test(String(item?.url || ''))) {
      let download: Response;
      try { download = await fetcher(String(item!.url), { signal: AbortSignal.timeout(90_000), redirect: 'error' }); }
      catch (error) { throw new FirstFrameProviderError(`Seedream 已生成但产物下载状态未知：${transportFailure(error)}`, 'uncertain', requestId); }
      if (!download.ok) throw new FirstFrameProviderError(`Seedream 已生成但产物下载失败：HTTP ${download.status}`, 'uncertain', requestId);
      mimeType = mimeFromResponse(download.headers.get('content-type'));
      try { bytes = Buffer.from(await download.arrayBuffer()); }
      catch (error) { throw new FirstFrameProviderError(`Seedream 已生成但产物读取状态未知：${error instanceof Error ? error.message : 'body_error'}`, 'uncertain', requestId); }
    } else throw new FirstFrameProviderError('Seedream 返回成功但缺少图片产物', 'uncertain', requestId);
    if (!bytes.length) throw new FirstFrameProviderError('Seedream 返回空图片', 'uncertain', requestId);
    return { bytes, mimeType, provider: this.provider, model: payload.model || this.model, providerRequestId: requestId, estimatedCostCny: this.estimatedCostCny };
  }
}
