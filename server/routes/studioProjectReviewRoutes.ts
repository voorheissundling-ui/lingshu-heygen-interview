import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { isTrustedSocialOutputWorkspace } from '../starter198/socialContentProductionWorkspace.js';
import { socialProjectBelongs, socialProjectTaskId } from '../starter198/socialProjectScope.js';
import { STUDIO_MANUAL_HANDOFF_ACTIONS, isManualStudioProject, studioProjectRenderPaths } from '../../shared/contracts/studioManualHandoff.js';
import { compareAndSwapStudioProject } from '../lib/studioProjectRevision.js';
import { currentStudioProjectQualityRecord, studioProjectQualityFingerprint, studioProjectQualityIssues, type StudioProjectQualityRecord } from '../lib/studioProjectQuality.js';
import type { AuthLocals } from '../middleware/auth.js';
import type { DataStore } from '../storage/datastore.js';
import { store } from '../storage/index.js';
import { projectFromRecord } from './studioProjectReadRoutes.js';

/** Mounted under the authenticated Studio /projects path. */
export function createStudioProjectReviewRouter(dataStore: DataStore = store) {
  const router = Router();

  // A signed quality record binds to the current inputs and is invalidated by later edits.
  router.post('/:id/requality', async (req, res) => {
    const { tenantId, userId } = res.locals as AuthLocals;
    const project = await dataStore.getById<any>('studio_projects', req.params.id);
    if (!project || project.tenant_id !== tenantId || !socialProjectBelongs(project, socialProjectTaskId(res.locals))) {
      res.status(404).json({ ok: false, code: 'studio_project_not_found', error: 'Project not found' }); return;
    }
    if (isTrustedSocialOutputWorkspace(project)) { res.status(409).json({ ok: false, code: 'social_output_workspace_readonly', error: '真实成片审核须使用原成片核验流程' }); return; }
    const spec = typeof project.spec === 'string' ? JSON.parse(project.spec) : project.spec || {};
    const issues = studioProjectQualityIssues(spec);
    if (issues.length) {
      res.status(422).json({ ok: false, code: 'studio_project_quality_failed', error: '当前版本未通过重新质检', issues }); return;
    }
    const inputFingerprint = studioProjectQualityFingerprint(spec);
    const existing = currentStudioProjectQualityRecord(spec);
    if (existing) { res.json({ ok: true, replayed: true, record: existing }); return; }
    const now = new Date().toISOString();
    const acceptance = spec.renderAcceptance as Record<string, unknown>;
    const record: StudioProjectQualityRecord = {
      id: `project-quality-${randomUUID()}`,
      inputFingerprint,
      generationProvenance: 'ai', qualityStatus: 'passed', publishable: true,
      createdAt: now, createdBy: userId, projectRevision: String(project.updated_at || ''),
      renderPath: String(acceptance.renderPath || ''),
      report: { gateVersion: 'studio-project-quality-v1', checks: [
        { id: 'storyboard_materials', passed: true, detail: '全部分镜已绑定当前项目素材' },
        { id: 'voice_subtitles', passed: true, detail: spec.voiceoverMode === 'none' ? '无口播模式，无需配音' : '配音与字幕输入完整' },
        { id: 'render_acceptance', passed: true, detail: '当前正式成片已完成人工验收' },
        { id: 'input_fingerprint', passed: true, detail: `输入指纹 ${inputFingerprint.slice(0, 12)}` },
      ] },
    };
    const records = Array.isArray(spec.projectQualityRecords) ? spec.projectQualityRecords : [];
    const nextSpec = { ...spec, projectQualityRecords: [...records, record].slice(-50), activeProjectQualityRecordId: record.id };
    const updated = await compareAndSwapStudioProject(dataStore, project, { spec: nextSpec }, now);
    if (!updated.ok) {
      const latest = await dataStore.getById<any>('studio_projects', req.params.id);
      res.status(409).json({
        ok: false,
        code: 'studio_project_version_conflict',
        error: '质检期间草稿已更新，签发记录未覆盖最新内容。请刷新后重新质检。',
        ...(latest?.tenant_id === tenantId ? { project: projectFromRecord(latest, tenantId) } : {}),
      });
      return;
    }
    res.status(201).json({ ok: true, replayed: false, record, project: projectFromRecord({ ...project, spec: nextSpec, updated_at: updated.updatedAt }, tenantId) });
  });

  // Explicit reviewed handoff only; saving or exporting does not create one.
  router.post('/:id/manual-handoffs', async (req, res) => {
    const { tenantId, userId } = res.locals as AuthLocals;
    const project = await dataStore.getById<any>('studio_projects', req.params.id);
    if (!project || project.tenant_id !== tenantId) { res.status(404).json({ ok: false, error: 'Project not found' }); return; }
    if (isTrustedSocialOutputWorkspace(project)) { res.status(409).json({ ok: false, code: 'social_output_workspace_readonly', error: '真实生产快照不能转为人工交付声明' }); return; }
    const spec = typeof project.spec === 'string' ? JSON.parse(project.spec) : project.spec || {};
    if (!isManualStudioProject(spec)) {
      res.status(409).json({ ok: false, code: 'manual_studio_project_required', error: '只有人工自由创作项目可以主动提交此协作请求' }); return;
    }
    const action = String(req.body?.action || '');
    if (!STUDIO_MANUAL_HANDOFF_ACTIONS.includes(action as any)) {
      res.status(400).json({ ok: false, code: 'manual_handoff_action_invalid', error: '协作动作无效' }); return;
    }
    const renderPath = String(req.body?.renderPath || '').trim();
    if (!renderPath || !studioProjectRenderPaths(spec).includes(renderPath)) {
      res.status(422).json({ ok: false, code: 'manual_handoff_render_required', error: '请先完成并保存当前正式成片' }); return;
    }
    const savedAcceptance = spec.renderAcceptance && typeof spec.renderAcceptance === 'object'
      ? spec.renderAcceptance as Record<string, unknown> : {};
    if (req.body?.reviewed !== true || savedAcceptance.accepted !== true || String(savedAcceptance.renderPath || '') !== renderPath) {
      res.status(422).json({ ok: false, code: 'manual_handoff_review_required', error: '请先完成人工成片验收' }); return;
    }
    if (!currentStudioProjectQualityRecord(spec)) {
      res.status(422).json({ ok: false, code: 'manual_handoff_requality_required', error: '当前版本尚未重新质检，或质检记录已因修改失效' }); return;
    }
    const existing = await dataStore.list<any>('studio_manual_handoffs', {
      where: { tenant_id: tenantId, project_id: req.params.id, action, render_path: renderPath }, perPage: 1,
    });
    if (existing.items[0]) {
      const item = existing.items[0];
      res.json({ ok: true, replayed: true, handoff: { id: item.id, action: item.action, status: item.status,
        renderPath: item.render_path, createdAt: item.created_at, createdBy: item.created_by } });
      return;
    }
    const now = new Date().toISOString();
    const created = await dataStore.create<any>('studio_manual_handoffs', {
      tenant_id: tenantId, project_id: req.params.id, action,
      status: action === 'team_review' ? 'pending_review' : 'planned', render_path: renderPath,
      project_revision: String(project.updated_at || ''), created_by: userId, created_at: now, updated_at: now,
    });
    if (!created) { res.status(503).json({ ok: false, code: 'manual_handoff_storage_unavailable', error: '协作请求未能保存，请重试' }); return; }
    res.status(201).json({ ok: true, replayed: false, handoff: { id: created.id, action: created.action,
      status: created.status, renderPath: created.render_path, createdAt: created.created_at, createdBy: created.created_by } });
  });

  router.delete('/:id', async (req, res) => {
    const { tenantId } = res.locals as AuthLocals;
    const existing = await dataStore.getById<any>('studio_projects', req.params.id);
    if (!existing || existing.tenant_id !== tenantId || !socialProjectBelongs(existing, socialProjectTaskId(res.locals))) { res.status(404).json({ ok: false, error: 'Project not found' }); return; }
    if (isTrustedSocialOutputWorkspace(existing)) { res.status(409).json({ ok: false, code: 'social_output_workspace_readonly', error: '真实生产快照不可删除' }); return; }
    await dataStore.delete('studio_projects', req.params.id);
    res.json({ ok: true });
  });

  return router;
}
