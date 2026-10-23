import type {
  WeeklyOperatingPackage,
  WeeklyOperatingWorkflowKind,
  WeeklyWorkflowEvent,
  WeeklyWorkflowTask,
  WeeklyWorkflowTaskStatus,
} from '../../shared/contracts/socialProgram.js';
import { SocialProgramError } from './service.js';

const transitions: Record<WeeklyWorkflowTaskStatus, Partial<Record<WeeklyWorkflowEvent['type'], WeeklyWorkflowTaskStatus>>> = {
  planned: { start: 'in_progress', block: 'blocked', cancel: 'cancelled' },
  blocked: { unblock: 'planned', cancel: 'cancelled' },
  in_progress: { complete: 'completed', block: 'blocked', cancel: 'cancelled' },
  completed: {},
  cancelled: {},
};

function aggregate(tasks: WeeklyWorkflowTask[], kind: WeeklyOperatingWorkflowKind): WeeklyWorkflowTaskStatus {
  const statuses = tasks.filter(task => task.kind === kind).map(task => task.status);
  if (statuses.some(status => status === 'blocked')) return 'blocked';
  if (statuses.length && statuses.every(status => status === 'cancelled')) return 'cancelled';
  if (statuses.length && statuses.every(status => status === 'completed' || status === 'cancelled')) return 'completed';
  if (statuses.some(status => status === 'in_progress' || status === 'completed')) return 'in_progress';
  return 'planned';
}

function recompute(tasks: WeeklyWorkflowTask[]): WeeklyWorkflowTask[] {
  const byId = new Map(tasks.map(task => [task.taskId, task]));
  return tasks.map(task => {
    const inherited = task.dependsOnTaskIds.filter(id => {
      const dependency = byId.get(id);
      return dependency?.status === 'blocked' || dependency?.status === 'cancelled';
    });
    if (inherited.length) return { ...task, status: 'blocked', inheritedBlockingTaskIds: inherited };
    if (task.inheritedBlockingTaskIds.length && !task.ownBlockingReasons.length && task.status === 'blocked') {
      return { ...task, status: 'planned', inheritedBlockingTaskIds: [] };
    }
    return { ...task, inheritedBlockingTaskIds: inherited };
  });
}

export function applyWorkflowEvent(
  pkg: WeeklyOperatingPackage,
  event: WeeklyWorkflowEvent,
  options: { authoritativeUnblockVerified?: boolean } = {},
): WeeklyOperatingPackage {
  const prior = pkg.appliedWorkflowEvents.find(item => item.eventId === event.eventId);
  if (prior) {
    if (JSON.stringify(prior) !== JSON.stringify(event)) {
      throw new SocialProgramError('workflow_event_conflict', 409, '同一事件 ID 不得承载不同内容。');
    }
    return pkg;
  }
  const target = pkg.workflowTasks.find(task => task.taskId === event.taskId);
  if (!target) throw new SocialProgramError('workflow_task_not_found', 404, '周工作流任务不存在。');
  if (event.type === 'start') {
    const byId = new Map(pkg.workflowTasks.map(task => [task.taskId, task]));
    const unfinished = target.dependsOnTaskIds.filter(id => byId.get(id)?.status !== 'completed');
    if (unfinished.length) throw new SocialProgramError('workflow_dependencies_incomplete', 409, '上游任务尚未完成，当前任务不能开始。');
  }
  const nextStatus = transitions[target.status][event.type];
  if (!nextStatus) throw new SocialProgramError('workflow_transition_invalid', 409, `任务不能从 ${target.status} 执行 ${event.type}。`);
  if (event.type === 'block' && !event.reason?.trim()) {
    throw new SocialProgramError('workflow_block_reason_required', 400, '阻塞事件必须提供原因。');
  }
  if (event.type === 'unblock' && options.authoritativeUnblockVerified !== true) {
    throw new SocialProgramError('workflow_unblock_authority_required', 409, '解除阻塞必须先由服务端复核权威事实。');
  }
  let tasks = pkg.workflowTasks.map(task => task.taskId !== event.taskId ? task : {
    ...task,
    status: nextStatus,
    ownBlockingReasons: event.type === 'block'
      ? [...new Set([...task.ownBlockingReasons, event.reason!.trim()])]
      : event.type === 'unblock' ? [] : task.ownBlockingReasons,
  });
  // Dependencies form a DAG in the planner. Repeating reaches transitive dependants without
  // turning unrelated sibling branches into blocked work.
  for (let pass = 0; pass < tasks.length; pass += 1) tasks = recompute(tasks);
  const workflows = pkg.workflows.map(workflow => {
    const kindTasks = tasks.filter(task => task.kind === workflow.kind);
    return {
      ...workflow,
      status: aggregate(tasks, workflow.kind),
      taskRefs: kindTasks.map(task => task.taskRef),
      blockingReasons: [...new Set(kindTasks.flatMap(task => [
        ...task.ownBlockingReasons,
        ...task.inheritedBlockingTaskIds.map(id => `upstream:${id}`),
      ]))],
    };
  });
  const invalidatesAuthorization = (event.type === 'block' || event.type === 'cancel')
    && (target.kind === 'content' || target.kind === 'publishing');
  return {
    ...pkg,
    workflowTasks: tasks,
    workflows,
    appliedWorkflowEvents: [...pkg.appliedWorkflowEvents, event],
    socialContentPackage: invalidatesAuthorization ? {
      ...pkg.socialContentPackage,
      authorization: {
        ...pkg.socialContentPackage.authorization,
        allowRealPublishing: false,
        revokedBy: 'workflow_state_machine',
        revokedAt: event.occurredAt,
      },
    } : pkg.socialContentPackage,
    updatedAt: event.occurredAt,
  };
}
