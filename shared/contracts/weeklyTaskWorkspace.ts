import type { VersionedSocialRef, WeeklyExecutionTask, WeeklyProductionStepKind } from './socialProgram.js';

export const WEEKLY_TASK_WORKSPACE_SCHEMA_VERSION = 'weekly-task-workspace.v1' as const;

export type WeeklyTaskWorkspaceKind = 'planning'|'inspiration'|'materials'|'content'|'publishing'|'customer'|'review'|'template';
export type WeeklyTaskWorkspacePhase = 'waiting_upstream'|'ready'|'running'|'waiting_human'|'blocked'|'completed'|'cancelled';
export type WeeklyTaskWorkspaceNextActionCode = 'wait_upstream'|'wait_automatic_retry'|'resolve_task_blocker'|'review_output'|'none';

export type WeeklyTaskWorkspaceRuntime = {
  pauseReasons: Array<{code:string;message:string;retryable:boolean|null;occurredAt:string|null}>;
  completedWork: Array<{executionTaskId:string;stepKind:WeeklyProductionStepKind;finishedAt:string|null;resultRefs:VersionedSocialRef[]}>;
  actualCost: {status:'none'|'known'|'unknown';totalCny:number|null;evidenceRefs:string[]};
  recovery: {
    taskAttempt:number;
    taskMaximumAttempts:number;
    recoveredFromDeadLetterAt:string|null;
    jobId:string|null;
    jobStatus:string|null;
    jobAttempt:number|null;
    reconciliationAttempt:number|null;
    retryClass:string|null;
    nextAttemptAt:string|null;
    providerReceipts:Array<{provider:string;requestId:string;state:string;providerTaskId:string|null;updatedAt:string}>;
  };
  checkpoints:Array<{key:string;version:string;inputHash:string;updatedAt:string}>;
  nextActions:Array<{code:WeeklyTaskWorkspaceNextActionCode;label:string;userRequired:boolean}>;
  mayChargeAgain:{status:'possible'|'not_expected'|'unknown';reason:string};
};

export type WeeklyTaskWorkspace = {
  schemaVersion: typeof WEEKLY_TASK_WORKSPACE_SCHEMA_VERSION;
  workspaceId: string;
  tenantId: string;
  programId: string;
  packageId: string;
  packageVersion: number;
  executionTaskId: string;
  taskIdempotencyKey: string;
  stepKind: WeeklyProductionStepKind;
  kind: WeeklyTaskWorkspaceKind;
  phase: WeeklyTaskWorkspacePhase;
  title: string;
  responsibleActor: WeeklyExecutionTask['schedule']['responsibleActor'];
  taskStatus: WeeklyExecutionTask['status'];
  scheduledStartAt: string|null;
  scheduledFinishAt: string|null;
  upstreamTaskIds: string[];
  blockingCodes: string[];
  resultRefs: VersionedSocialRef[];
  contentTaskId: string|null;
  runId: string|null;
  accountId: string|null;
  publicationTaskId: string|null;
  /** Live, read-only projection. It is rebuilt from authoritative execution,
   * queue, checkpoint and settled-ledger records and is never a new workflow. */
  runtime: WeeklyTaskWorkspaceRuntime;
  createdAt: string;
  updatedAt: string;
};
