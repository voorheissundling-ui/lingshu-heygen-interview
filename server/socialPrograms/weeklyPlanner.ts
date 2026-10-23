import { createHash } from 'node:crypto';
import type { BusinessContentGoal } from '../../shared/contracts/socialOperatingDecision.js';
import {
  WEEKLY_OPERATING_WORKFLOW_KINDS,
  type SocialWeeklyPublicationTask,
  type VersionedSocialRef,
  type WeeklyOperatingWorkflow,
  type WeeklyWorkflowTask,
  type WeeklyTaskVersionMapping,
} from '../../shared/contracts/socialProgram.js';

export interface WeeklyCapacitySnapshot {
  ref: VersionedSocialRef;
  status: 'ready' | 'blocked';
  originalContentTarget: number;
  accountPlans: Array<{ accountId: string; publicationCount: number }>;
  productionBudgetCny: number | null;
  blockers: string[];
}

export interface WeeklyAutomationPolicySnapshot {
  ref: VersionedSocialRef;
  status: 'ready' | 'blocked';
  blockers: string[];
}

export interface WeeklyPlannerInput {
  packageId: string;
  version: number;
  businessGoal: BusinessContentGoal | null;
  capacity: WeeklyCapacitySnapshot | null;
  automationPolicy: WeeklyAutomationPolicySnapshot | null;
  publicationTasks: SocialWeeklyPublicationTask[];
  discoveryBudgetCny: number | null;
  previousTasks?: WeeklyWorkflowTask[];
}

const stableId = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);

function task(kind: WeeklyWorkflowTask['kind'], packageId: string, version: number, subjectRefs: VersionedSocialRef[], dependsOnTaskIds: string[]): WeeklyWorkflowTask {
  const taskId = `wwt_${stableId(`${packageId}:${version}:${kind}`)}`;
  return { taskId, kind, taskRef: { type: 'weekly_workflow_task', id: taskId, version: 1 }, dependsOnTaskIds, subjectRefs, status: 'planned', ownBlockingReasons: [], inheritedBlockingTaskIds: [], carriedFromTaskId: null };
}

export function buildWeeklyWorkflow(input: WeeklyPlannerInput): {
  workflows: WeeklyOperatingWorkflow[];
  tasks: WeeklyWorkflowTask[];
  mappings: WeeklyTaskVersionMapping[];
  blockers: string[];
} {
  const goalRef = input.businessGoal ? [{ type: 'business_content_goal', id: input.businessGoal.goalId, version: input.businessGoal.version }] : [];
  const publicationRefs = input.publicationTasks.map(item => ({ type: 'weekly_publication_task', id: item.publicationTaskId, version: input.version }));
  const blockers = [
    ...(!input.businessGoal ? ['business_goal_unavailable'] : [
      ...(input.businessGoal.status === 'blocked' && !input.businessGoal.blockers.length ? ['g2:business_goal_blocked'] : []),
      ...input.businessGoal.blockers.map(item => `g2:${item.code}`),
    ]),
    ...(!input.capacity ? ['capacity_plan_unavailable'] : [
      ...(input.capacity.status === 'blocked' && !input.capacity.blockers.length ? ['capacity:decision_blocked'] : []),
      ...input.capacity.blockers.map(item => `capacity:${item}`),
    ]),
    ...(!input.automationPolicy ? ['automation_policy_unavailable'] : [
      ...(input.automationPolicy.status === 'blocked' && !input.automationPolicy.blockers.length ? ['policy:decision_blocked'] : []),
      ...input.automationPolicy.blockers.map(item => `policy:${item}`),
    ]),
    ...input.publicationTasks.flatMap(item => [
      !item.businessProposition ? `g2:${item.publicationTaskId}:business_proposition_required` : null,
      !item.cta ? `g2:${item.publicationTaskId}:cta_required` : null,
      !item.factRefs.length ? `g2:${item.publicationTaskId}:fact_refs_required` : null,
      !item.metricTargets.length ? `g2:${item.publicationTaskId}:metric_targets_required` : null,
      !item.publishWindow ? `g2:${item.publicationTaskId}:publish_window_required` : null,
    ].filter((item): item is string => Boolean(item))),
  ];
  const readiness = task('readiness', input.packageId, input.version, goalRef, []);
  readiness.ownBlockingReasons = blockers;
  readiness.status = blockers.length ? 'blocked' : 'planned';
  const discovery = task('discovery', input.packageId, input.version, goalRef, [readiness.taskId]);
  const directing = task('directing', input.packageId, input.version, publicationRefs, [readiness.taskId, discovery.taskId]);
  const content = task('content', input.packageId, input.version, publicationRefs, [directing.taskId]);
  const publishing = task('publishing', input.packageId, input.version, publicationRefs, [content.taskId]);
  const engagement = task('engagement', input.packageId, input.version, publicationRefs, [publishing.taskId]);
  const review = task('review', input.packageId, input.version, goalRef, [engagement.taskId]);
  let tasks = [readiness, discovery, directing, content, publishing, engagement, review];
  const blocked = new Set<string>();
  for (const item of tasks) {
    if (item.ownBlockingReasons.length || item.dependsOnTaskIds.some(id => blocked.has(id))) {
      item.status = 'blocked';
      item.inheritedBlockingTaskIds = item.dependsOnTaskIds.filter(id => blocked.has(id));
      blocked.add(item.taskId);
    }
  }
  const previousByKind = new Map((input.previousTasks ?? []).map(item => [item.kind, item]));
  const mappings: WeeklyTaskVersionMapping[] = [];
  for (const next of tasks) {
    const previous = previousByKind.get(next.kind);
    if (previous && previous.subjectRefs.length === next.subjectRefs.length && previous.subjectRefs.every((ref, index) => JSON.stringify(ref) === JSON.stringify(next.subjectRefs[index]))) {
      next.carriedFromTaskId = previous.taskId;
      if (previous.status === 'completed') next.status = 'completed';
      mappings.push({ previousTaskId: previous.taskId, nextTaskId: next.taskId, handling: 'carried' });
    } else if (previous) {
      mappings.push({ previousTaskId: previous.taskId, nextTaskId: next.taskId, handling: 'replaced' });
    }
  }
  for (const previous of input.previousTasks ?? []) {
    if (!tasks.some(next => next.kind === previous.kind)) mappings.push({ previousTaskId: previous.taskId, nextTaskId: null, handling: 'cancelled' });
  }
  const workflows = WEEKLY_OPERATING_WORKFLOW_KINDS.map(kind => {
    const item = tasks.find(candidate => candidate.kind === kind)!;
    return { kind, status: item.status, taskRefs: [item.taskRef], blockingReasons: [...item.ownBlockingReasons, ...item.inheritedBlockingTaskIds.map(id => `upstream:${id}`)] };
  });
  return { workflows, tasks, mappings, blockers };
}
