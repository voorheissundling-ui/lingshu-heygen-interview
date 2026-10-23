import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { withPaidOperationLock } from './paidOperationLock.js';
import { isTenantPrivateObjectKey } from '../storage/materialAssets.js';
import type { DigitalHumanExecutionAdapter } from './digitalHumanProviderRegistry.js';

type RecordV1 = {
  version: 1;
  id: string;
  requestHash: string;
  tenantId: string;
  sourceObjectKey: string;
  sourceObjectEtag: string;
  state: 'submitting' | 'upstream_pending' | 'processing' | 'completed' | 'failed';
  upstreamTaskId: string | null;
  outputObjectKey: string | null;
  error: string;
  createdAt: string;
  updatedAt: string;
};

type FastHeadInput = {
  tenantId?: string;
  referenceClipKey?: string;
  referenceClipObjectEtag?: string;
};

type Processor = (input: { id: string; tenantId: string; sourceObjectKey: string; sourceObjectEtag: string; candidateUrl: string }) => Promise<{ outputObjectKey: string }>;

/** Durable Runway Act-Two -> local head composite orchestration.
 * The upstream adapter remains the only paid step; processing must be idempotent by id. */
export class RunwayFastHeadAdapter implements DigitalHumanExecutionAdapter {
  readonly id = 'local_head_pipeline' as const;
  readonly methods: Array<'replace'> = ['replace'];
  readonly executionProfile;

  constructor(private readonly options: {
    root: string;
    upstream: DigitalHumanExecutionAdapter;
    process: Processor;
    estimatedCostCnyPerSecond?: number;
  }) {
    this.executionProfile = { maxDurationSeconds: 15, preserves: ['identity', 'motion', 'product', 'background', 'composition'] as Array<'identity' | 'motion' | 'product' | 'background' | 'composition'>,
      qualityInspection: true, ...(options.estimatedCostCnyPerSecond != null ? { estimatedCostCnyPerSecond: options.estimatedCostCnyPerSecond } : {}) };
  }

  private file(id: string) { return path.join(this.options.root, `${id}.json`); }
  private read(id: string): RecordV1 {
    const file = this.file(id);
    if (!fs.existsSync(file)) throw new Error('本地人物替换编排任务不存在');
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as RecordV1;
    if (value.version !== 1 || value.id !== id || !value.tenantId || !value.sourceObjectKey || !value.sourceObjectEtag) throw new Error('本地人物替换编排记录损坏');
    return value;
  }
  private save(record: RecordV1) {
    fs.mkdirSync(this.options.root, { recursive: true });
    const temporary = path.join(this.options.root, `${record.id}.${randomUUID()}.tmp`);
    fs.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 }); fs.renameSync(temporary, this.file(record.id));
  }

  async submit(raw: unknown, idempotencyKey: string): Promise<{ externalTaskId: string }> {
    const input = raw as FastHeadInput;
    const tenantId = String(input.tenantId || ''); const sourceObjectKey = String(input.referenceClipKey || ''); const sourceObjectEtag = String(input.referenceClipObjectEtag || '');
    if (!tenantId || !sourceObjectEtag || !isTenantPrivateObjectKey(sourceObjectKey, tenantId)) throw new Error('本地人物替换需要当前租户的精确参考片段及对象版本');
    const requestHash = createHash('sha256').update(idempotencyKey).digest('hex'); const id = `fast-${requestHash}`;
    return withPaidOperationLock(path.join(this.options.root, '.locks'), id, async () => {
      if (fs.existsSync(this.file(id))) {
        const existing = this.read(id);
        if (existing.requestHash !== requestHash || existing.tenantId !== tenantId || existing.sourceObjectKey !== sourceObjectKey || existing.sourceObjectEtag !== sourceObjectEtag) throw new Error('本地人物替换幂等请求与原输入不一致');
        if (!existing.upstreamTaskId) throw new Error('Runway 提交结果未知：已有提交标记但缺少任务 ID，请核对供应商后台且不要重复提交');
        return { externalTaskId: id };
      }
      const now = new Date().toISOString(); const record: RecordV1 = { version: 1, id, requestHash, tenantId, sourceObjectKey, sourceObjectEtag,
        state: 'submitting', upstreamTaskId: null, outputObjectKey: null, error: '', createdAt: now, updatedAt: now };
      this.save(record);
      const submitted = await this.options.upstream.submit(raw, idempotencyKey);
      this.save({ ...record, state: 'upstream_pending', upstreamTaskId: submitted.externalTaskId, updatedAt: new Date().toISOString() });
      return { externalTaskId: id };
    });
  }

  async status(externalTaskId: string) {
    return withPaidOperationLock(path.join(this.options.root, '.locks'), externalTaskId, async () => {
      let record = this.read(externalTaskId);
      if (record.state === 'completed' && record.outputObjectKey) return { state: 'completed' as const, outputObjectKey: record.outputObjectKey };
      if (record.state === 'failed') return { state: 'failed' as const, error: record.error || '本地人物替换失败' };
      if (!record.upstreamTaskId) throw new Error('Runway 提交结果未知：缺少供应商任务 ID');
      const upstream = await this.options.upstream.status(record.upstreamTaskId);
      if (upstream.state === 'pending') return { state: 'pending' as const };
      if (upstream.state === 'failed') {
        record = { ...record, state: 'failed', error: upstream.error || 'Runway 驱动候选生成失败', updatedAt: new Date().toISOString() }; this.save(record);
        return { state: 'failed' as const, error: record.error, ...(upstream.actualCostCny != null ? { actualCostCny: upstream.actualCostCny } : {}), ...(upstream.costSourceRef ? { costSourceRef: upstream.costSourceRef } : {}) };
      }
      if (!upstream.outputUrl) throw new Error('Runway 驱动任务已完成但缺少候选视频地址');
      this.save({ ...record, state: 'processing', updatedAt: new Date().toISOString() });
      try {
        const result = await this.options.process({ id: record.id, tenantId: record.tenantId, sourceObjectKey: record.sourceObjectKey, sourceObjectEtag: record.sourceObjectEtag, candidateUrl: upstream.outputUrl });
        if (!isTenantPrivateObjectKey(result.outputObjectKey, record.tenantId)) throw new Error('本地人物替换输出不属于当前租户');
        record = { ...record, state: 'completed', outputObjectKey: result.outputObjectKey, error: '', updatedAt: new Date().toISOString() }; this.save(record);
        return { state: 'completed' as const, outputObjectKey: result.outputObjectKey, ...(upstream.actualCostCny != null ? { actualCostCny: upstream.actualCostCny } : {}), ...(upstream.costSourceRef ? { costSourceRef: upstream.costSourceRef } : {}) };
      } catch (error) {
        record = { ...record, state: 'upstream_pending', error: `本地处理待重试：${error instanceof Error ? error.message : '本地人物替换处理失败'}`, updatedAt: new Date().toISOString() }; this.save(record);
        return { state: 'pending' as const, error: record.error, ...(upstream.actualCostCny != null ? { actualCostCny: upstream.actualCostCny } : {}), ...(upstream.costSourceRef ? { costSourceRef: upstream.costSourceRef } : {}) };
      }
    });
  }

  async cancel(externalTaskId: string) {
    const record = this.read(externalTaskId);
    if (record.state === 'completed' || record.state === 'failed') return { cancelled: false, reason: 'local_pipeline_already_finished' };
    if (!record.upstreamTaskId || !this.options.upstream.cancel) return { cancelled: false, reason: 'upstream_cancel_unavailable' };
    return this.options.upstream.cancel(record.upstreamTaskId);
  }

  async cost(externalTaskId: string) {
    const record = this.read(externalTaskId);
    if (!record.upstreamTaskId || !this.options.upstream.cost) return {};
    return this.options.upstream.cost(record.upstreamTaskId);
  }
}
