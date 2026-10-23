import type { WeeklyExecutionTask } from './socialProgram.js';

/** Shared capacity and schedule projections; implementation lives in server/socialPrograms. */
export interface RecoveryResource {
  /** Business actors and provider capabilities can share the same resource key. */
  concurrency: number;
  workingWindows: Array<{ startAt: string; finishAt: string }>;
}
export interface RecoveryTaskConstraint {
  resourceKey: string;
  remainingMinutes: number;
  remainingCostCny: number;
  /** Explicit buffer includes quality/rework allowance; never inferred as already delivered. */
  bufferMinutes: number;
  availableAt: string;
  unresolvedReasons?: string[];
}

export interface WeeklyBackwardSchedule {
  assignments: Array<{ taskId: string; startAt: string | null; finishAt: string | null; resourceKey: string | null; reasons: string[];mode:'planned'|'completed_verified'|'running_reserved'|'unavailable' }>;
  publications: Array<{ publicationId: string; conditionallyReachable: boolean; reasons: string[] }>;
  targetPublicationCount: number;
  conditionallyReachableCount: number;
  publicationGap: number;
  reservedCostCny: number;
  confirmationRequired: boolean;
  fullGraphConditionallyReachable:boolean;
  unscheduledTaskIds:string[];
  crossWeekOperationalTaskIds:string[];
  agentDailyLoads:Array<{responsibleActor:WeeklyExecutionTask['schedule']['responsibleActor'];localDate:string;plannedMinutes:number;taskIds:string[]}>;
  queueConfigurationHash?:string;
  queueCapacityEvidenceHash?:string;
  revisionApplied: false;
}
