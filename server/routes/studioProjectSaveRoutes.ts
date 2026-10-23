import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { isTrustedSocialOutputWorkspace, socialOutputWorkspaceClientWriteBlocked } from '../starter198/socialContentProductionWorkspace.js';
import { bindSocialProjectSpec, socialProjectBelongs, socialProjectTaskId } from '../starter198/socialProjectScope.js';
import { assertFrozenStudioProjectWrite } from '../starter198/socialContentStudioFrozenBridge.js';
import { normalizeFreeCreationProjectSpec, freeCreationCompletionIssues } from '../../shared/contracts/freeCreationProject.js';
import { reconcileStudioProductionSpec, studioProductionSnapshotIssues } from '../../shared/studioProductionContract.js';
import { studioProjectSpecForStorage } from '../lib/studioProjectAssets.js';
import { storyboardAigcAssignmentIssues } from '../lib/storyboardAigcAssignment.js';
import { compareAndSwapStudioProject, studioProjectRevisionConflict } from '../lib/studioProjectRevision.js';
import { invalidatePublishingApprovalForProject } from '../digitalEmployees/publishingExecution.js';
import type { AuthLocals } from '../middleware/auth.js';
import type { DataStore } from '../storage/datastore.js';
import { projectFromRecord, type StudioProject } from './studioProjectReadRoutes.js';

type ProjectMaterial = Parameters<typeof storyboardAigcAssignmentIssues>[0]['materials'][number];

interface SaveRoutePorts<TMaterial extends ProjectMaterial> {
  dataStore: DataStore;
  loadMaterials: () => TMaterial[];
  kbAssignmentIssues: (tenantId: string, spec: Record<string, unknown>, materials: TMaterial[]) => Promise<string[]>;
  appendCompletedPosterMaterialUsage: (input: {
    tenantId: string; projectId: string; projectTitle: string; spec: Record<string, any>; usedAt: string;
  }) => Promise<Record<string, any>>;
  unpublishableGenerationReasons: (spec: Record<string, unknown>) => string[];
}

/** Mounted under Studio authentication and tenant context at /projects. */
export function createStudioProjectSaveRouter<TMaterial extends ProjectMaterial>(ports: SaveRoutePorts<TMaterial>) {
  const { dataStore, loadMaterials, kbAssignmentIssues, appendCompletedPosterMaterialUsage, unpublishableGenerationReasons } = ports;
  const router = Router();

// POST /studio/projects  Body: { id?, title?, status?, spec, thumbSeed? } → 新建或更新
router.post('/', async (req, res) => {
  const { tenantId } = res.locals as AuthLocals;
  const { id, title, status = 'draft', spec: rawSpec = {}, thumbSeed, baseUpdatedAt } = req.body ?? {};
  const socialTaskId = socialProjectTaskId(res.locals);
  let spec = normalizeFreeCreationProjectSpec(studioProjectSpecForStorage(bindSocialProjectSpec(rawSpec, socialTaskId)));
  const productionSnapshotIssues = studioProductionSnapshotIssues(spec);
  if (productionSnapshotIssues.length) {
    res.status(409).json({
      ok: false,
      code: 'STUDIO_PRODUCTION_CONTRACT_CONFLICT',
      error: '当前草稿的脚本、分镜或生产结果存在不一致版本，已停止保存以避免使用旧数据生产。请刷新后重试。',
      reasons: productionSnapshotIssues,
    });
    return;
  }
  spec = reconcileStudioProductionSpec(spec);
  if (!id && spec.resolvedStudioContract) { res.status(403).json({ok:false,code:'studio_frozen_contract_server_owned',error:'冻结制作计划只能由受信任业务流程绑定'}); return; }
  const automation = spec.automation && typeof spec.automation === 'object' && !Array.isArray(spec.automation)
    ? spec.automation as Record<string, unknown> : {};
  const now = new Date().toISOString();
  if (socialOutputWorkspaceClientWriteBlocked(spec)) { res.status(403).json({ok:false,code:'social_output_workspace_readonly',error:'真实生产快照只能由受信任生产流程保存'}); return; }
  if (automation.managedBy === 'digital_employee') { res.status(403).json({ ok: false, error: '数字员工内容项目只能由受信任的生产流程创建', code: 'managed_production_project_forbidden' }); return; }
  const generationBlocks = unpublishableGenerationReasons(spec);
  if (!['draft', 'template'].includes(String(status)) && generationBlocks.length) {
    res.status(422).json({
      ok: false,
      code: 'UNREVIEWED_GENERATION_DRAFT',
      error: '草稿包含未核实、待确认或失败降级内容，只能先保存为草稿，不能自动进入发布或交付。',
      reasons: generationBlocks,
    });
    return;
  }

  if (id) {
    const existing = await dataStore.getById<any>('studio_projects', String(id));
    if (existing?.tenant_id === tenantId) {
      if (isTrustedSocialOutputWorkspace(existing)) {res.status(409).json({ok:false,code:'social_output_workspace_readonly',error:'真实成片快照只读；请使用逐镜返工创建新运行'});return;}
      if (!socialProjectBelongs(existing, socialTaskId)) { res.status(404).json({ ok: false, error: 'Project not found' }); return; }
      const assignmentIssues = storyboardAigcAssignmentIssues({ tenantId, projectId: String(id), spec, materials: loadMaterials() });
      if (assignmentIssues.length) {
        res.status(409).json({ ok: false, code: 'STORYBOARD_AIGC_ASSIGNMENT_UNVERIFIED', error: 'AI 分镜候选尚未通过当前项目验收', reasons: assignmentIssues }); return;
      }
      const kbIssues = await kbAssignmentIssues(tenantId, spec, loadMaterials());
      if (kbIssues.length) {
        res.status(409).json({ ok: false, code: 'STORYBOARD_AIGC_KB_IMAGE_CHANGED', error: '企业产品或指定人物参考图已变化，AI 分镜候选需重做', reasons: kbIssues }); return;
      }
      const currentUpdatedAt = String(existing.updated_at || existing.updated || '');
      if (studioProjectRevisionConflict(baseUpdatedAt, currentUpdatedAt)) {
        res.status(409).json({
          ok: false,
          code: 'studio_project_version_conflict',
          error: baseUpdatedAt
            ? '该创作已在其他页面更新，请刷新后继续；当前页面的旧数据未覆盖新版本。'
            : '当前页面版本过旧，请刷新后继续；旧页面的自动保存已被拦截。',
          project: projectFromRecord(existing, tenantId),
        });
        return;
      }
      const storedSpec = typeof existing.spec === 'string' ? JSON.parse(existing.spec) : existing.spec;
      try { assertFrozenStudioProjectWrite(storedSpec, spec); }
      catch { res.status(409).json({ok:false,code:'studio_frozen_plan_changed',error:'当前任务制作计划已冻结，请刷新；修改脚本或时长需正式修订',project:projectFromRecord(existing,tenantId)});return; }
      spec = normalizeFreeCreationProjectSpec(spec, storedSpec);
      const freeCreationIssues = spec.creationPath === 'free_creation' ? freeCreationCompletionIssues(spec.freeCreation) : [];
      if (!['draft', 'template'].includes(String(status)) && freeCreationIssues.length) {
        res.status(422).json({ ok: false, code: 'FREE_CREATION_INCOMPLETE', error: '自由创作尚未满足交付条件', reasons: freeCreationIssues }); return;
      }
      // A remounted editor can briefly hold an empty draft while hydration is
      // still in flight. Never let that snapshot erase an established storyboard.
      const savedAssignments = Object.keys(storedSpec?.storyboardAssignments || {}).length;
      const incomingAssignments = Object.keys(spec.storyboardAssignments || {}).length;
      const savedSnapshots = Array.isArray(storedSpec?.materialSnapshots) ? storedSpec.materialSnapshots.length : 0;
      const incomingSnapshots = Array.isArray(spec.materialSnapshots) ? spec.materialSnapshots.length : 0;
      if (savedAssignments > 1 && incomingAssignments === 0 && savedSnapshots > 1 && incomingSnapshots <= 1) {
        res.status(409).json({ ok: false, code: 'STORYBOARD_HYDRATION_INCOMPLETE', error: '项目分镜尚未完整载入，已阻止空草稿覆盖原有素材关联。请刷新页面后重试。' });
        return;
      }
      // Pending avatar jobs can have neither a URL nor a poster yet. The editor
      // cannot turn those snapshots into visual clips, but their candidates
      // still refer to them, so retain the saved metadata during autosave.
      const candidateMaterialIds = new Set<string>(Object.values(spec.shotProductions || {})
        .flatMap((production: any) => Array.isArray(production?.candidates)
          ? production.candidates.map((candidate: any) => String(candidate?.materialId || ''))
          : [])
        .filter(Boolean));
      if (candidateMaterialIds.size && Array.isArray(storedSpec?.materialSnapshots)) {
        const snapshots = Array.isArray(spec.materialSnapshots) ? spec.materialSnapshots : [];
        const incomingIds = new Set(snapshots.map((snapshot: any) => String(snapshot?.id || '')));
        spec.materialSnapshots = [...snapshots, ...storedSpec.materialSnapshots.filter((snapshot: any) =>
          candidateMaterialIds.has(String(snapshot?.id || '')) && !incomingIds.has(String(snapshot?.id || '')))];
      }
      if (storedSpec?.workflowRunId && storedSpec?.automation?.managedBy === 'digital_employee') {
        res.status(409).json({ ok: false, error: '此项目由任务自动生产，请通过交付看板纠偏重跑，或复制为新草稿后编辑。', code: 'managed_production_project' });
        return;
      }

      spec = await appendCompletedPosterMaterialUsage({
        tenantId,
        projectId: String(id),
        projectTitle: String(title ?? existing.title ?? ''),
        spec,
        usedAt: now,
      });

      const changed = JSON.stringify(existing.spec || {}) !== JSON.stringify(spec || {})
        || String(existing.title || '') !== String(title ?? existing.title ?? '')
        || String(existing.status || '') !== String(status || '');
      let write: Awaited<ReturnType<typeof compareAndSwapStudioProject>>;
      try {
        write = await compareAndSwapStudioProject(dataStore, existing, {
          title: title ?? existing.title,
          status,
          spec,
          thumb_seed: thumbSeed || '',
        }, now);
      } catch (error) {
        if (error instanceof Error && error.message === 'STUDIO_PROJECT_ATOMIC_STORE_REQUIRED') {
          res.status(503).json({ ok: false, code: 'studio_project_atomic_storage_required', error: '当前存储暂不支持安全保存，页面修改尚未覆盖服务端项目。请稍后重试。' });
          return;
        }
        throw error;
      }
      if (!write.ok) {
        const latest = await dataStore.getById<any>('studio_projects', String(id));
        if (latest?.tenant_id === tenantId) {
          res.status(409).json({
            ok: false,
            code: 'studio_project_version_conflict',
            error: '保存期间后台生产结果已更新。系统未覆盖新结果，请重新载入最新版本后继续。',
            project: projectFromRecord(latest, tenantId),
          });
        } else {
          res.status(503).json({ ok: false, code: 'studio_project_storage_unavailable', error: '草稿未能写入存储，请重试；当前编辑仍保留在页面中。' });
        }
        return;
      }
      if (changed) await invalidatePublishingApprovalForProject(tenantId, String(id));
      res.json({ ok: true, project: projectFromRecord({ ...existing, title: title ?? existing.title, status, spec, thumb_seed: thumbSeed, updated_at: write.updatedAt }, tenantId) });
      return;
    }
  }

  const project: StudioProject = {
    id: randomUUID(),
    title: title || '未命名草稿',
    status,
    spec,
    thumbSeed,
    createdAt: now,
    updatedAt: now,
  };
  const freeCreationIssues = spec.creationPath === 'free_creation' ? freeCreationCompletionIssues(spec.freeCreation) : [];
  if (!['draft', 'template'].includes(String(status)) && freeCreationIssues.length) {
    res.status(422).json({ ok: false, code: 'FREE_CREATION_INCOMPLETE', error: '自由创作尚未满足交付条件', reasons: freeCreationIssues }); return;
  }
  const assignmentIssues = storyboardAigcAssignmentIssues({ tenantId, projectId: '', spec, materials: loadMaterials() });
  if (assignmentIssues.length) {
    res.status(409).json({ ok: false, code: 'STORYBOARD_AIGC_ASSIGNMENT_UNVERIFIED', error: 'AI 分镜候选尚未通过当前项目验收', reasons: assignmentIssues }); return;
  }
  const kbIssues = await kbAssignmentIssues(tenantId, spec, loadMaterials());
  if (kbIssues.length) {
    res.status(409).json({ ok: false, code: 'STORYBOARD_AIGC_KB_IMAGE_CHANGED', error: '企业产品或指定人物参考图已变化，AI 分镜候选需重做', reasons: kbIssues }); return;
  }
  const created = await dataStore.create<any>('studio_projects', { tenant_id: tenantId, title: project.title, status, spec, thumb_seed: thumbSeed || '', created_at: now, updated_at: now });
  if (!created) { res.status(503).json({ ok: false, error: 'project storage unavailable' }); return; }
  res.status(201).json({ ok: true, project: projectFromRecord(created, tenantId) });
});

  return router;
}
