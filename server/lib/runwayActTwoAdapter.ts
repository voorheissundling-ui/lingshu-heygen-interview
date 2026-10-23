import { DefinitiveSupplierSubmissionError, type DigitalHumanExecutionAdapter } from './digitalHumanProviderRegistry.js';

class RunwayApiError extends Error { constructor(readonly status: number, message: string) { super(message); } }

type RunwayTask = {
  id?: string;
  status?: 'PENDING' | 'THROTTLED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  output?: string[];
  failure?: string;
  failureCode?: string;
  cost?: { credits?: number };
};

export interface RunwayActTwoSubmitInput {
  characterUrl: string;
  characterType: 'image' | 'video';
  referenceVideoUrl: string;
  ratio: '1280:720' | '720:1280' | '960:960';
  bodyControl: boolean;
  expressionIntensity?: number;
}

export class RunwayActTwoAdapter implements DigitalHumanExecutionAdapter {
  readonly id = 'runway_act_two' as const;
  readonly methods: Array<'reenact'> = ['reenact'];
  readonly executionProfile;
  constructor(private readonly options: { apiSecret: string; cnyPerCredit: number; transport?: typeof fetch; baseUrl?: string; estimatedCostCnyPerSecond?: number; qualityInspection?: boolean }) {
    this.executionProfile = { maxDurationSeconds: 30, preserves: ['identity', 'motion'] as Array<'identity' | 'motion'>, qualityInspection: options.qualityInspection === true,
      ...(options.estimatedCostCnyPerSecond != null ? { estimatedCostCnyPerSecond: options.estimatedCostCnyPerSecond } : {}) };
  }
  private async request(path: string, init: RequestInit): Promise<RunwayTask> {
    if (!this.options.apiSecret.trim()) throw new Error('Runway Act-Two 未配置 API Secret');
    const response = await (this.options.transport || fetch)(`${this.options.baseUrl || 'https://api.dev.runwayml.com'}${path}`, {
      ...init, redirect: 'error', signal: AbortSignal.timeout(45_000), headers: { Authorization: `Bearer ${this.options.apiSecret}`, 'X-Runway-Version': '2024-11-06', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers || {}) },
    });
    if (response.status === 204) return {};
    const value = await response.json().catch(() => ({})) as RunwayTask & { error?: string };
    if (!response.ok) throw new RunwayApiError(response.status, `Runway ${response.status}: ${value.error || value.failureCode || 'request_failed'}`);
    return value;
  }
  async submit(raw: unknown, _idempotencyKey: string): Promise<{ externalTaskId: string }> {
    const input = raw as Partial<RunwayActTwoSubmitInput>;
    if (!/^https:\/\//i.test(String(input.characterUrl || '')) || !/^https:\/\//i.test(String(input.referenceVideoUrl || ''))) throw new Error('Runway Act-Two 需要可访问的 HTTPS 人物素材与参考视频');
    if (!['image', 'video'].includes(String(input.characterType || ''))) throw new Error('Runway Act-Two 人物素材类型无效');
    if (!['1280:720', '720:1280', '960:960'].includes(String(input.ratio || ''))) throw new Error('Runway Act-Two 画幅无效');
    const expressionIntensity = Number(input.expressionIntensity ?? 3);
    if (!Number.isInteger(expressionIntensity) || expressionIntensity < 1 || expressionIntensity > 5) throw new Error('Runway Act-Two 表情强度须为 1–5 的整数');
    let result: RunwayTask;
    try {
      result = await this.request('/v1/character_performance', { method: 'POST', body: JSON.stringify({ model: 'act_two',
        character: { type: input.characterType, uri: input.characterUrl },
        reference: { type: 'video', uri: input.referenceVideoUrl }, ratio: input.ratio, bodyControl: input.bodyControl !== false, expressionIntensity }) });
    } catch (error) {
      if (error instanceof RunwayApiError && [400, 401, 403, 404, 422].includes(error.status)) throw new DefinitiveSupplierSubmissionError(error.message);
      throw error;
    }
    if (!result.id) throw new Error('Runway 提交结果未知：未返回任务 ID，请核对供应商后台且不要重复提交');
    return { externalTaskId: result.id };
  }
  async status(externalTaskId: string) {
    const task = await this.request(`/v1/tasks/${encodeURIComponent(externalTaskId)}`, { method: 'GET' });
    if (task.status === 'SUCCEEDED') {
      if (!task.output?.[0]) throw new Error('Runway 任务成功但没有输出 URL');
      return { state: 'completed' as const, outputUrl: task.output[0], ...this.costEvidence(externalTaskId, task) };
    }
    if (task.status === 'FAILED' || task.status === 'CANCELLED') return { state: 'failed' as const, error: task.failure || task.failureCode || (task.status === 'CANCELLED' ? 'Runway 任务已取消' : 'Runway 任务失败'), ...this.costEvidence(externalTaskId, task) };
    if (task.status === 'PENDING' || task.status === 'THROTTLED' || task.status === 'RUNNING') return { state: 'pending' as const };
    throw new Error(`Runway 返回未知任务状态：${String(task.status || 'missing')}`);
  }
  async cancel(externalTaskId: string): Promise<{ cancelled: boolean; reason?: string }> {
    await this.request(`/v1/tasks/${encodeURIComponent(externalTaskId)}`, { method: 'DELETE' });
    return { cancelled: true, reason: 'runway_cancelled' };
  }
  async cost(externalTaskId: string) {
    const task = await this.request(`/v1/tasks/${encodeURIComponent(externalTaskId)}`, { method: 'GET' });
    return this.costEvidence(externalTaskId, task);
  }
  private costEvidence(id: string, task: RunwayTask): { actualCostCny?: number; costSourceRef?: string } {
    const credits = Number(task.cost?.credits);
    if (!Number.isFinite(credits) || credits < 0 || !Number.isFinite(this.options.cnyPerCredit) || this.options.cnyPerCredit <= 0) return {};
    return { actualCostCny: Number((credits * this.options.cnyPerCredit).toFixed(4)), costSourceRef: `runway-task:${id}:credits:${credits}` };
  }
}
