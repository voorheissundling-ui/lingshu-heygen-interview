import type { DataStore } from '../storage/datastore.js';
import { compareAndSwapStudioProject } from './studioProjectRevision.js';

/** Project progress is a projection, not the paid-call ledger. Only bind a real
 * provider receipt to the exact managed shot that owns this first frame. */
export async function projectStoryboardProviderReceipt(input: {
  store: DataStore; tenantId: string; projectId: string; slotId: string;
  firstFrameMaterialId: string; firstFrameFingerprint: string;
  providerTaskId: string; providerModel: string; providerAcceptedAt: string;
}) {
  if (!input.providerTaskId || !input.providerModel || !Number.isFinite(Date.parse(input.providerAcceptedAt)))
    throw new Error('供应商接单回执不完整');
  const project = await input.store.getById<any>('studio_projects', input.projectId);
  if (!project || project.tenant_id !== input.tenantId) throw new Error('供应商回执对应项目不可访问');
  const spec = project.spec || {};
  const shot = (Array.isArray(spec.automatedReplicationShots) ? spec.automatedReplicationShots : [])
    .find((item: any) => item.slotId === input.slotId && item.kind === 'nonperson');
  // Non-managed workbench projects still retain their durable budget receipt.
  if (!shot) return;
  const progress = spec.automatedReplicationProgress || {};
  const current = progress[shot.shotId];
  if (!current || current.firstFrameMaterialId !== input.firstFrameMaterialId
    || current.firstFrameFingerprint !== input.firstFrameFingerprint)
    throw new Error('供应商回执对应的首帧版本已变化');
  if (current.providerTaskId && current.providerTaskId !== input.providerTaskId)
    throw new Error('当前镜头已绑定另一个供应商作业');
  const saved = await compareAndSwapStudioProject(input.store, project, { spec: { ...spec,
    automatedReplicationProgress: { ...progress, [shot.shotId]: { ...current,
      providerTaskId: input.providerTaskId, providerModel: input.providerModel,
      providerAcceptedAt: input.providerAcceptedAt, updatedAt: new Date().toISOString() } } } });
  if (!saved.ok) throw new Error('供应商回执保存期间草稿已更新，未覆盖最新内容；原生账本已保留原任务');
}
