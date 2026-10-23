import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { withPaidOperationLock } from './paidOperationLock.js';
import type { StoryboardAigcProjectBudget, StoryboardAigcSpendEntry } from './storyboardAigcProjectBudget.js';

export type SeedanceProductScope = {
  tenantId: string; projectId: string; shotId: string; operationId: string; inputFingerprint: string;
};
export type SeedanceProductRecoveryResult =
  | { state: 'reconciliation_required'; reason: 'missing_task_id' }
  | { state: 'processing' | 'failed'; taskId: string; providerStatus: string }
  | { state: 'ready'; taskId: string; videoUrl: string }
  | { state: 'completed'; taskId: string; materialId: string };

/** Uses the existing admission ledger. Recovery can only GET the original task;
 * it cannot reserve, release, resubmit or convert estimated spend to actual spend.
 * All workers must share the ledger/lock volume. */
export class SeedanceProductRecovery {
  constructor(private readonly budget: Pick<StoryboardAigcProjectBudget, 'status' | 'mark'>,
    private readonly lockRoot = path.resolve(process.env.STORYBOARD_AIGC_BUDGET_DIR || 'data/storyboard-aigc-budget', '.recovery-locks')) {}

  private async entry(scope: SeedanceProductScope): Promise<StoryboardAigcSpendEntry> {
    if (![scope.tenantId, scope.projectId, scope.shotId, scope.operationId, scope.inputFingerprint].every(Boolean))
      throw new Error('Seedance 恢复缺少冻结输入身份');
    const entry = (await this.budget.status(scope.tenantId, scope.projectId)).entries.find(item => item.operationId === scope.operationId);
    if (!entry || entry.stage !== 'video' || entry.shotId !== scope.shotId
      || entry.output?.seedanceInputFingerprint !== scope.inputFingerprint)
      throw new Error('Seedance 恢复请求与原镜头输入不一致');
    return entry;
  }

  /** Call BEFORE POST, so a crash before an accepted response remains blocked. */
  async recordPrepared(scope: SeedanceProductScope, snapshot: { model: string; baseUrl: string; firstFrameMaterialId: string; firstFrameFingerprint: string }) {
    return withPaidOperationLock(this.lockRoot, `${scope.tenantId}:${scope.projectId}:${scope.operationId}`, async () => {
      const entry = (await this.budget.status(scope.tenantId, scope.projectId)).entries.find(item => item.operationId === scope.operationId);
      if (!entry || entry.stage !== 'video' || entry.shotId !== scope.shotId || entry.status !== 'reserved' || entry.output)
        throw new Error('Seedance 原请求已存在或不可提交，禁止重新付费提交');
      if (!scope.inputFingerprint || !snapshot.model || !/^https:\/\//.test(snapshot.baseUrl) || !snapshot.firstFrameMaterialId || !snapshot.firstFrameFingerprint)
        throw new Error('Seedance 冻结输入不完整');
      await this.budget.mark(scope.tenantId, scope.projectId, scope.operationId, 'reserved', {
        ...snapshot, seedanceInputFingerprint: scope.inputFingerprint, submissionPreparedAt: new Date().toISOString(),
      });
    });
  }

  /** Await immediately after POST returns ID, BEFORE polling or downloading. */
  async recordAccepted(scope: SeedanceProductScope, taskId: string) {
    return withPaidOperationLock(this.lockRoot, `${scope.tenantId}:${scope.projectId}:${scope.operationId}`, async () => {
      const entry = await this.entry(scope);
      if (!/^[A-Za-z0-9_.:-]{1,180}$/.test(taskId) || entry.status === 'completed') throw new Error('Seedance 任务 ID 无效或已完成');
      if (entry.output?.providerTaskId && entry.output.providerTaskId !== taskId) throw new Error('禁止替换原 Seedance 任务');
      await this.budget.mark(scope.tenantId, scope.projectId, scope.operationId, 'uncertain', {
        ...entry.output, providerTaskId: taskId, submittedAt: entry.output?.submittedAt || new Date().toISOString(),
      });
    });
  }

  async recover(scope: SeedanceProductScope, config: { apiKey: string; baseUrl: string; model: string; transport?: typeof fetch }): Promise<SeedanceProductRecoveryResult> {
    return withPaidOperationLock(this.lockRoot, `${scope.tenantId}:${scope.projectId}:${scope.operationId}`, async () => {
      const entry = await this.entry(scope);
      const taskId = String(entry.output?.providerTaskId || '');
      if (!taskId) return { state: 'reconciliation_required', reason: 'missing_task_id' };
      if (entry.output?.baseUrl !== config.baseUrl || entry.output?.model !== config.model || !config.apiKey.trim())
        throw new Error('Seedance 恢复供应商配置与原任务不一致');
      if (entry.status === 'completed' && entry.output?.materialId) return { state: 'completed', taskId, materialId: String(entry.output.materialId) };
      const response = await (config.transport || fetch)(`${config.baseUrl.replace(/\/+$/, '')}/contents/generations/tasks/${encodeURIComponent(taskId)}`, {
        method: 'GET', headers: { Authorization: `Bearer ${config.apiKey}` }, signal: AbortSignal.timeout(45_000), redirect: 'error',
      });
      if (!response.ok) throw new Error(`Seedance 原任务查询 HTTP ${response.status}；保留预占，禁止重复提交`);
      const rawReceipt = await response.text();
      const task = JSON.parse(rawReceipt) as { id?: string; status?: string; content?: { video_url?: string }; usage?: Record<string, unknown> };
      const receiptHash = createHash('sha256').update(rawReceipt).digest('hex');
      const receiptDir = path.join(this.lockRoot, 'receipts', createHash('sha256').update(`${scope.tenantId}:${scope.projectId}:${scope.operationId}`).digest('hex'));
      await fs.mkdir(receiptDir, { recursive: true, mode: 0o700 });
      const rawReceiptRef = path.join(receiptDir, `${receiptHash}.json`);
      await fs.writeFile(rawReceiptRef, rawReceipt, { mode: 0o600 });
      if (task.id && task.id !== taskId) throw new Error('Seedance 查询返回不同任务 ID');
      const providerStatus = String(task.status || '').toLowerCase();
      const videoUrl = String(task.content?.video_url || '');
      await this.budget.mark(scope.tenantId, scope.projectId, scope.operationId, 'uncertain', {
        ...entry.output, providerStatus, rawReceiptRef, rawReceiptSha256: receiptHash, actualCostCny: null,
        ...(task.usage && typeof task.usage === 'object' && !Array.isArray(task.usage) ? { usage: task.usage } : {}),
        ...( /^https:\/\//.test(videoUrl) ? { providerVideoUrl: videoUrl } : {}), lastQueriedAt: new Date().toISOString(),
      });
      if (['succeeded', 'success', 'completed', 'done'].includes(providerStatus)) {
        if (!/^https:\/\//.test(videoUrl)) throw new Error('Seedance 原任务成功但缺少有效产物；禁止重复提交');
        return { state: 'ready', taskId, videoUrl };
      }
      return { state: ['failed', 'error', 'expired', 'cancelled', 'canceled'].includes(providerStatus) ? 'failed' : 'processing', taskId, providerStatus };
    });
  }

  /** Call only after local bytes and tenant-scoped material have been persisted. */
  async recordCompleted(scope: SeedanceProductScope, materialId: string) {
    return withPaidOperationLock(this.lockRoot, `${scope.tenantId}:${scope.projectId}:${scope.operationId}`, async () => {
      const entry = await this.entry(scope);
      if (!materialId || !entry.output?.providerTaskId) throw new Error('Seedance 完成缺少原任务或本地素材');
      if (entry.status === 'completed' && entry.output?.materialId !== materialId) throw new Error('禁止替换已完成素材');
      await this.budget.mark(scope.tenantId, scope.projectId, scope.operationId, 'completed', { ...entry.output, materialId, completedAt: new Date().toISOString() });
    });
  }
}
