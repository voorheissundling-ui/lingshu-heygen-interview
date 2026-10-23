import { Router } from 'express';
import type { DataStore } from '../storage/datastore.js';
import type { AuthLocals } from '../middleware/auth.js';
import type { ScriptGapTask, ShootingSlot } from '../../src/lib/shootingWorkflow.js';

type TaskRecord = { id: string; tenant_id: string; payload: ScriptGapTask };
type ProjectRecord = { tenant_id: string; status: string; spec: { shootingSlots?: ShootingSlot[]; activeAssemblyId?: string; shotProductions?: Record<string, { sound: string; narration: string }> } };
export function createShootingTasksRouter(store: DataStore, ownsVideo: (id: string, tenantId: string) => Promise<boolean>) {
  const router = Router();
  // Serializes appends on this server. Multi-instance deployments need a database transaction.
  const pending = new Map<string, Promise<unknown>>();
  router.get('/', async (_req, res) => {
    try {
      const { tenantId } = res.locals as AuthLocals;
      const tasks: ScriptGapTask[] = [];
      let page = 1;
      while (true) {
        const result = await store.list<TaskRecord>('studio_shooting_tasks', { where: { tenant_id: tenantId }, page, perPage: 200 });
        tasks.push(...result.items.filter(item => item.tenant_id === tenantId).map(item => ({ ...item.payload, id: item.id })));
        if (page++ >= result.totalPages) break;
      }
      res.setHeader('Cache-Control', 'private, no-store');
      res.json(tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    } catch { res.status(503).json({ error: '待拍任务读取失败，请稍后重试' }); }
  });
  router.post('/', async (req, res) => {
    try {
      const { tenantId } = res.locals as AuthLocals;
      const input = req.body || {};
      if (typeof input.title !== 'string' || !input.title.trim() || typeof input.shotBrief !== 'string' || !input.shotBrief.trim()) {
        res.status(400).json({ error: '请填写任务标题和拍摄要求' }); return;
      }
      if (!Number.isFinite(input.suggestedDurationSec) || input.suggestedDurationSec < 0.5 || input.suggestedDurationSec > 600) {
        res.status(400).json({ error: '拍摄时长须为 0.5–600 秒' }); return;
      }
      if (input.sourceProjectId) {
        const project = await store.getById<ProjectRecord>('studio_projects', String(input.sourceProjectId));
        if (!project || project.tenant_id !== tenantId || project.status !== 'draft') { res.status(404).json({ error: '创作草稿不存在或不可编辑' }); return; }
        const slot = project.spec.shootingSlots?.find(item => item.id === input.sourceShotId);
        if (!slot || slot.requirements !== input.requirements || project.spec.activeAssemblyId !== input.sourceAssemblyId) {
          res.status(409).json({ error: '分镜要求已变化，请保存草稿后重新创建任务' }); return;
        }
        const production = project.spec.shotProductions?.[`${input.sourceAssemblyId}:${input.sourceShotId}`];
        if ((production && production.sound !== input.soundMode) || (input.soundMode === 'source' && (!production || !production.narration.trim() || production.narration !== input.expectedNarration))) {
          res.status(409).json({ error: '声音或口播要求与已保存镜头不一致，请先应用台词并保存' }); return;
        }
      } else if (input.sourceShotId || input.requirements || input.sourceAssemblyId) {
        res.status(400).json({ error: '绑定分镜前须先保存草稿' }); return;
      }
      const payload: ScriptGapTask = {
        id: '', origin: 'script_gap', title: input.title.trim().slice(0, 200),
        productLabel: String(input.productLabel || '').slice(0, 300), themeTitle: String(input.themeTitle || '').slice(0, 300),
        shotBrief: input.shotBrief.trim().slice(0, 10000), suggestedDurationSec: input.suggestedDurationSec,
        ...(typeof input.ratio === 'string' && ['9:16', '16:9', '1:1', '4:5'].includes(input.ratio) ? { ratio: input.ratio } : {}),
        ...(input.sourceProjectId ? { sourceProjectId: String(input.sourceProjectId), sourceStoryboardSlotId: String(input.sourceStoryboardSlotId || ''),
          sourceAssemblyId: String(input.sourceAssemblyId), sourceShotId: String(input.sourceShotId), requirements: String(input.requirements), soundMode: input.soundMode === 'source' ? 'source' as const : input.soundMode === 'silent' ? 'silent' as const : 'voiceover' as const,
          expectedNarration: String(input.expectedNarration || '').slice(0, 5000) } : {}),
        createdAt: new Date().toISOString(), uploadedMaterialIds: [],
      };
      const record = await store.create<TaskRecord>('studio_shooting_tasks', { tenant_id: tenantId, payload });
      if (!record) throw new Error('storage unavailable');
      res.status(201).json({ ...payload, id: record.id });
    } catch { res.status(503).json({ error: '待拍任务保存失败，请检查任务存储配置' }); }
  });
  router.post('/:id/uploads', async (req, res) => {
    const { tenantId } = res.locals as AuthLocals;
    const key = `${tenantId}:${req.params.id}`;
    const operation = (pending.get(key) || Promise.resolve()).catch(() => undefined).then(async () => {
      const record = await store.getById<TaskRecord>('studio_shooting_tasks', req.params.id);
      if (!record || record.tenant_id !== tenantId) { res.status(404).json({ error: '待拍任务不存在' }); return; }
      const ids = req.body?.uploadedMaterialIds;
      if (!Array.isArray(ids) || !ids.length || ids.length > 20 || ids.some(id => typeof id !== 'string' || !id)) {
        res.status(400).json({ error: '请上传有效视频素材' }); return;
      }
      for (const id of ids) {
        if (!await ownsVideo(id, tenantId)) { res.status(400).json({ error: '仅可关联本企业上传的视频素材' }); return; }
      }
      const payload = { ...record.payload, uploadedMaterialIds: [...new Set([...record.payload.uploadedMaterialIds, ...ids])] };
      if (!await store.update('studio_shooting_tasks', record.id, { payload })) throw new Error('storage unavailable');
      res.json({ ...payload, id: record.id });
    });
    pending.set(key, operation);
    try { await operation; } catch { res.status(503).json({ error: '视频已入库，但任务关联失败，请重试关联' }); }
    finally { if (pending.get(key) === operation) pending.delete(key); }
  });
  return router;
}
