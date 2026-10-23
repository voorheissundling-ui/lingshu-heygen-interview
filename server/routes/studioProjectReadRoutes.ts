import { Router } from 'express';
import { auditShotEvidence } from '../lib/shotEvidenceAudit.js';
import { refreshStudioProjectAssetUrls } from '../lib/studioProjectAssets.js';
import type { AuthLocals } from '../middleware/auth.js';
import type { DataStore } from '../storage/datastore.js';
import { store } from '../storage/index.js';
import { readFrozenStudioOperationalEvidence } from '../starter198/socialContentStudioOperationalEvidence.js';
import { frozenStudioProjectSpec } from '../starter198/socialContentStudioFrozenBridge.js';
import { digitalEmployeeProjectBelongs, socialProjectBelongs, socialProjectTaskId } from '../starter198/socialProjectScope.js';

export interface StudioProject {
  id: string;
  title: string;
  status: 'draft' | 'ready_for_approval' | 'published' | 'template';
  spec: Record<string, unknown>;
  thumbSeed?: string;
  createdAt: string;
  updatedAt: string;
}

type StoredStudioProject = StudioProject & { tenant_id: string };

export function projectFromRecord(record: any, tenantId: string): StudioProject {
  return {
    id: String(record.id),
    title: String(record.title || '未命名草稿'),
    status: record.status || 'draft',
    spec: { ...refreshStudioProjectAssetUrls(frozenStudioProjectSpec(record.spec || {}), tenantId), _baseUpdatedAt: String(record.updated_at || record.updated || '') },
    thumbSeed: record.thumb_seed || undefined,
    createdAt: String(record.created_at || record.created || ''),
    updatedAt: String(record.updated_at || record.updated || ''),
  };
}

/** Mounted after Studio authentication. Material reads stay in the parent route. */
export function createStudioProjectReadRouter(loadMaterials: () => Parameters<typeof auditShotEvidence>[1], dataStore: DataStore = store) {
  const router = Router();

  router.get('/', async (_req, res) => {
    const { tenantId } = res.locals as AuthLocals;
    const result = await dataStore.list<StoredStudioProject>('studio_projects', { where: { tenant_id: tenantId }, sort: '-updated_at', perPage: 500 });
    const taskId = socialProjectTaskId(res.locals);
    res.json(result.items
      .filter(project => socialProjectBelongs(project, taskId))
      .map(project => projectFromRecord(project, tenantId)));
  });

  router.get('/:id/evidence', async (req, res) => {
    try {
      const tenantId = res.locals.tenantId as string;
      const project = await dataStore.getById<any>('studio_projects', req.params.id);
      if (!project || project.tenant_id !== tenantId || !socialProjectBelongs(project, socialProjectTaskId(res.locals))) { res.status(404).json({ error: '草稿不存在' }); return; }
      const gaps = auditShotEvidence(project.spec || {}, loadMaterials(), tenantId);
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ ok: true, projectId: project.id, revision: project.updated_at, gaps, status: gaps.length ? 'needs_review' : 'range_checked', note: '范围和动作文本校验，不代表视觉或产品功效已验证；未读取到的云端素材需人工核对。' });
    } catch { res.status(503).json({ error: '素材依据检查失败，请稍后重试' }); }
  });

  router.get('/:id', async (req, res) => {
    const { tenantId } = res.locals as AuthLocals;
    const p = await dataStore.getById<any>('studio_projects', req.params.id);
    const workflowRunId = String(req.query.workflowRunId || '').trim();
    const workflowTaskId = String(req.query.workflowTaskId || '').trim();
    const belongs = p && (socialProjectBelongs(p, socialProjectTaskId(res.locals))
      || digitalEmployeeProjectBelongs(p, workflowRunId, workflowTaskId));
    if (!p || p.tenant_id !== tenantId || !belongs) { res.status(404).json({ ok: false, error: 'Project not found' }); return; }
    const projected = projectFromRecord(p, tenantId);
    const contract = projected.spec.resolvedStudioContract as Record<string, unknown> | undefined;
    if (contract) {
      const readonlyContract = structuredClone(contract);
      projected.spec.resolvedStudioContract = readonlyContract;
      try {
        readonlyContract.operationalEvidence = await readFrozenStudioOperationalEvidence({ dataStore, tenantId, projectId: String(p.id), spec: p.spec });
      } catch (error) {
        const reason = error instanceof Error && /^(?:studio|speech|mvp|content)_[a-z_]+$/.test(error.message) ? error.message : 'canonical_evidence_unavailable';
        readonlyContract.operationalEvidence = { schemaVersion: 'social-studio-operational.v1', status: 'unavailable', reason, artifactCompleted: false, humanApproved: false };
      }
    }
    res.json(projected);
  });

  router.get('/:id/manual-handoffs', async (req, res) => {
    const { tenantId } = res.locals as AuthLocals;
    const project = await dataStore.getById<any>('studio_projects', req.params.id);
    if (!project || project.tenant_id !== tenantId) { res.status(404).json({ ok: false, error: 'Project not found' }); return; }
    const result = await dataStore.list<any>('studio_manual_handoffs', {
      where: { tenant_id: tenantId, project_id: req.params.id }, sort: '-created_at', perPage: 100,
    });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, handoffs: result.items.map(item => ({ id: item.id, action: item.action,
      status: item.status, renderPath: item.render_path, createdAt: item.created_at, createdBy: item.created_by })) });
  });

  return router;
}
