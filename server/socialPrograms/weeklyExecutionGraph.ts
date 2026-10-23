import type { SocialWeeklyPublicationTask, WeeklyExecutionTask, WeeklyOperatingPackage } from '../../shared/contracts/socialProgram.js';
import { canonicalWeeklyProductionPublication } from '../runtime/weeklyContentProductionIdentity.js';
import { publicationInstant } from './publicationDeadlines.js';
import { SocialProgramError } from './service.js';

export const publicationLocalDate = (item: SocialWeeklyPublicationTask): string => (
  publicationInstant(item.publishWindow) === null || !item.publishWindow ? '' : item.publishWindow.slice(0, 10)
);

export const preproductionLocalDate = (item: SocialWeeklyPublicationTask, pkg: WeeklyOperatingPackage): string => (
  publicationLocalDate(item) || pkg.weekStart
);

export const rollingDayForItems = (items: SocialWeeklyPublicationTask[], pkg: WeeklyOperatingPackage): string => (
  items.map(item => preproductionLocalDate(item, pkg)).sort()[0] ?? pkg.weekStart
);

const DAILY_ROLLING_LEAD_MS = 9.5 * 60 * 60_000;
export const dailyRollingStart = (items: SocialWeeklyPublicationTask[]): number | null => {
  const instants = items.map(item => publicationInstant(item.publishWindow)).filter((value): value is number => value !== null);
  return instants.length ? Math.min(...instants) - DAILY_ROLLING_LEAD_MS : null;
};

export function applySharedMaterialPreparation(tasks: WeeklyExecutionTask[], publications: SocialWeeklyPublicationTask[]): void {
  const byRequest = new Map<string, SocialWeeklyPublicationTask[]>();
  for (const publication of publications) for (const requestId of publication.materialRequirement?.requestIds ?? []) {
    byRequest.set(requestId, [...(byRequest.get(requestId) ?? []), publication]);
  }
  for (const [requestId, rawConsumers] of byRequest) {
    const consumers = [...new Map(rawConsumers.map(item => [item.publicationTaskId, item])).values()];
    if (consumers.length < 2) continue;
    const ordered = consumers.sort((left, right) => (publicationInstant(left.publishWindow) ?? Infinity)
      - (publicationInstant(right.publishWindow) ?? Infinity) || left.publicationTaskId.localeCompare(right.publicationTaskId));
    const preparationByPublication = new Map(ordered.map(publication => {
      const rows = tasks.filter(task => task.publicationTaskId === publication.publicationTaskId && task.schedule.stepKind === 'material_preparation');
      if (rows.length !== 1) throw new SocialProgramError('weekly_shared_material_preparation_ambiguous', 409, '共享素材缺少唯一可执行准备任务。');
      return [publication.publicationTaskId, rows[0]!] as const;
    }));
    const canonical = preparationByPublication.get(ordered[0]!.publicationTaskId)!;
    const preparationIds = [...preparationByPublication.values()].map(task => task.taskId);
    canonical.dependsOnTaskIds = [...new Set([...canonical.dependsOnTaskIds, ...preparationIds.filter(id => id !== canonical.taskId)])];
    const barrier = { requestId, consumerPublicationTaskIds: ordered.map(item => item.publicationTaskId), preparationTaskIds: preparationIds };
    const prior = Array.isArray(canonical.inputSnapshot.sharedMaterialBarriers) ? canonical.inputSnapshot.sharedMaterialBarriers : [];
    canonical.inputSnapshot = { ...canonical.inputSnapshot, sharedMaterialBarrier: canonical.inputSnapshot.sharedMaterialBarrier ?? barrier,
      sharedMaterialBarriers: [...prior, barrier] };
    for (const publication of ordered) {
      const scripts = tasks.filter(task => task.publicationTaskId === publication.publicationTaskId && task.schedule.stepKind === 'script');
      if (scripts.length !== 1) throw new SocialProgramError('weekly_shared_material_script_ambiguous', 409, '共享素材消费者缺少唯一脚本任务。');
      scripts[0]!.dependsOnTaskIds = [...new Set([...scripts[0]!.dependsOnTaskIds, canonical.taskId])];
    }
  }
}

export function shareOriginalProductionGraph(pkg: WeeklyOperatingPackage, tasks: WeeklyExecutionTask[]): WeeklyExecutionTask[] {
  if (pkg.socialContentPackage.productionIdentityVersion !== 'shared-original.v1') return tasks;
  const productionSteps = new Set(['material_preparation', 'material_readiness', 'script', 'storyboard', 'asset_generation', 'video_generation', 'quality_check', 'rework', 'template_extraction', 'template_performance_validation']);
  const replacements = new Map<string, string>(), removed = new Set<string>(), conflicts = new Set<string>();
  for (const publication of pkg.socialContentPackage.publicationTasks.filter(item => !item.inventoryReuseRef)) {
    const roots = pkg.socialContentPackage.publicationTasks.filter(item => !item.inventoryReuseRef && item.motherContentId === publication.motherContentId && !item.adaptationOfPublicationTaskId);
    if (roots.length !== 1) throw new SocialProgramError('weekly_content_original_identity_ambiguous', 409, '同一原创内容必须有唯一生产身份。');
    const root = roots[0]!;
    if (root.publicationTaskId === publication.publicationTaskId) continue;
    try { canonicalWeeklyProductionPublication(pkg, publication.publicationTaskId); }
    catch (error) {
      if (error instanceof Error && error.message === 'weekly_content_original_contract_conflict') conflicts.add(publication.publicationTaskId);
      else throw error;
    }
    for (const task of tasks.filter(item => item.publicationTaskId === publication.publicationTaskId && productionSteps.has(item.schedule.stepKind))) {
      const canonical = tasks.filter(item => item.publicationTaskId === root.publicationTaskId && item.schedule.stepKind === task.schedule.stepKind);
      if (canonical.length !== 1) throw new SocialProgramError('weekly_content_original_stage_ambiguous', 409, '共享原创缺少唯一生产节点。');
      replacements.set(task.taskId, canonical[0]!.taskId);
      removed.add(task.taskId);
    }
  }
  return tasks.filter(task => !removed.has(task.taskId)).map(task => ({ ...task,
    ...(task.schedule.stepKind === 'user_approval' && pkg.socialContentPackage.publicationTasks.some(item => item.publicationTaskId === task.publicationTaskId && item.adaptationOfPublicationTaskId) ? { scope: 'adaptation' as const } : {}),
    dependsOnTaskIds: [...new Set(task.dependsOnTaskIds.map(id => replacements.get(id) ?? id))].filter(id => id !== task.taskId),
    ...(conflicts.has(task.publicationTaskId ?? '') && task.schedule.stepKind === 'user_approval' ? { ownBlockingReasons: [...task.ownBlockingReasons, 'weekly_content_original_contract_conflict'] } : {}),
    inputSnapshot: { ...task.inputSnapshot, ...(typeof task.inputSnapshot.sourceTaskId === 'string'
      ? { sourceTaskId: replacements.get(task.inputSnapshot.sourceTaskId) ?? task.inputSnapshot.sourceTaskId } : {}) },
  }));
}
