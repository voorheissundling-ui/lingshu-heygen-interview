import { DefinitiveSupplierSubmissionError, type DigitalHumanExecutionAdapter } from './digitalHumanProviderRegistry.js';

type Task = { id?: string; status?: string; content?: { video_url?: string }; error?: { message?: string } | string; usage?: { completion_tokens?: number } };

export class SeedanceReferenceAdapter implements DigitalHumanExecutionAdapter {
  readonly id = 'runway_seedance' as const;
  readonly methods: Array<'reenact'> = ['reenact'];
  readonly executionProfile;
  constructor(private readonly options: { apiKey: string; model: string; baseUrl?: string; transport?: typeof fetch; estimatedCostCnyPerSecond: number; cnyPerThousandTokens?: number; resolution?: '480p' | '720p' | '1080p'; generateAudio?: boolean }) {
    this.executionProfile = { maxDurationSeconds: 15, preserves: ['identity', 'motion'] as Array<'identity' | 'motion'>, qualityInspection: true,
      estimatedCostCnyPerSecond: options.estimatedCostCnyPerSecond };
  }
  private async request(path: string, init: RequestInit): Promise<Task> {
    if (!this.options.apiKey.trim()) throw new Error('Seedance 未配置方舟 API Key');
    const response = await (this.options.transport || fetch)(`${(this.options.baseUrl || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/+$/, '')}${path}`, {
      ...init, redirect: 'error', signal: AbortSignal.timeout(45_000), headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    });
    const value = await response.json().catch(() => ({})) as Task & { message?: string };
    if (!response.ok) {
      const message = typeof value.error === 'string' ? value.error : value.error?.message || value.message || `HTTP ${response.status}`;
      const error = new Error(`Seedance ${response.status}: ${message}`);
      if ([400, 401, 403, 404, 422].includes(response.status)) throw new DefinitiveSupplierSubmissionError(error.message);
      throw error;
    }
    return value;
  }
  async submit(raw: unknown): Promise<{ externalTaskId: string }> {
    const input = raw as { characterUrl?: string; characterType?: 'image' | 'video'; referenceVideoUrl?: string; ratio?: string; targetDurationSeconds?: number; shot?: { narration?: string; digitalHuman?: { action?: string; scene?: string; preserve?: string } }; revisionFeedback?: string };
    const isSupportedReference = (value: unknown) => /^(?:https:\/\/|asset:\/\/asset-)/i.test(String(value || '').trim());
    if (!isSupportedReference(input.characterUrl) || !isSupportedReference(input.referenceVideoUrl)) {
      throw new Error('Seedance 需要 HTTPS 素材或已入库的 asset:// 可信人像素材');
    }
    const duration = Math.max(4, Math.min(15, Math.round(Number(input.targetDurationSeconds) || 5)));
    const ratio = ({ '1280:720': '16:9', '720:1280': '9:16', '960:960': '1:1' } as Record<string, string>)[String(input.ratio)]
      || (['16:9', '9:16', '1:1'].includes(String(input.ratio)) ? String(input.ratio) : '9:16');
    const requirements = input.shot?.digitalHuman;
    const prompt = [input.shot?.narration, requirements?.action, requirements?.scene, requirements?.preserve, input.revisionFeedback].map(value => String(value || '').trim()).filter(Boolean).join('\n');
    const content: unknown[] = [{ type: 'text', text: prompt || 'Use the reference person and follow the source performance.' }];
    const sameTrustedVideo = input.characterType === 'video'
      && String(input.characterUrl).trim() === String(input.referenceVideoUrl).trim();
    content.push({
      type: input.characterType === 'video' ? 'video_url' : 'image_url',
      [input.characterType === 'video' ? 'video_url' : 'image_url']: { url: input.characterUrl },
      role: input.characterType === 'video' ? 'reference_video' : 'reference_image',
    });
    if (!sameTrustedVideo) content.push({ type: 'video_url', video_url: { url: input.referenceVideoUrl }, role: 'reference_video' });
    let task: Task;
    try {
      task = await this.request('/contents/generations/tasks', { method: 'POST', body: JSON.stringify({
        model: this.options.model,
        content,
        ratio,
        duration,
        resolution: this.options.resolution || '720p',
        generate_audio: this.options.generateAudio ?? true,
        watermark: false,
      }) });
    } catch (error) { throw error; }
    if (!task.id) throw new Error('Seedance 提交结果未知：未返回任务 ID，请核对方舟后台且不要重复提交');
    return { externalTaskId: task.id };
  }
  async status(externalTaskId: string) {
    const task = await this.request(`/contents/generations/tasks/${encodeURIComponent(externalTaskId)}`, { method: 'GET' });
    const status = String(task.status || '').toLowerCase(); const cost = this.costEvidence(externalTaskId, task);
    if (['queued', 'pending', 'running', 'processing'].includes(status)) return { state: 'pending' as const };
    if (['succeeded', 'success', 'completed', 'done'].includes(status)) {
      if (!task.content?.video_url) throw new Error('Seedance 任务成功但没有输出 URL');
      return { state: 'completed' as const, outputUrl: task.content.video_url, ...cost };
    }
    if (['failed', 'error', 'expired', 'cancelled', 'canceled'].includes(status)) return { state: 'failed' as const, error: typeof task.error === 'string' ? task.error : task.error?.message || status, ...cost };
    throw new Error(`Seedance 返回未知任务状态：${status || 'missing'}`);
  }
  async cost(externalTaskId: string) { return this.costEvidence(externalTaskId, await this.request(`/contents/generations/tasks/${encodeURIComponent(externalTaskId)}`, { method: 'GET' })); }
  private costEvidence(id: string, task: Task) {
    const tokens = Number(task.usage?.completion_tokens); const rate = Number(this.options.cnyPerThousandTokens);
    if (!Number.isFinite(tokens) || tokens < 0 || !Number.isFinite(rate) || rate <= 0) return {};
    return { actualCostCny: Number((tokens / 1000 * rate).toFixed(4)), costSourceRef: `seedance-task:${id}:completion_tokens:${tokens}` };
  }
}
