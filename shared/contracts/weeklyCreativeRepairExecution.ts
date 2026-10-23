export type WeeklyCreativeRepairExecutionState =
  | 'capacity_confirmed'
  | 'start_pending'
  | 'reconciling'
  | 'running';

export interface WeeklyCreativeRepairCapacityPreview {
  caseId:string;
  caseRecordHash:string;
  configurationHash:string;
  previewHash:string;
  authorityHash:string;
  estimatedDurationMinutes:number;
  maximumCostCny:number;
  localOnly:boolean;
  quoteHash:string|null;
  availableUntil:string;
}

/** Durable correlation for admission and start. Null child identifiers are an
 * explicit unknown/not-started state and must never be replaced by placeholders. */
export interface WeeklyCreativeRepairChildExecution {
  schemaVersion:'weekly-creative-repair-child-execution.v1';
  version:1;
  tenantId:string;
  caseId:string;
  caseRequestHash:string;
  configurationHash:string;
  parentTaskId:string;
  parentRunId:string;
  parentArtifactHash:string;
  authorityHash:string;
  previewHash:string;
  capacityReservationId:string;
  capacityExpiresAt:string;
  localOnly:boolean;
  quoteHash:string|null;
  authorizedMaximumCostCny:number;
  startIdempotencyKey:string;
  state:WeeklyCreativeRepairExecutionState;
  childTaskId:string|null;
  childBindingKey:string|null;
  runId:string|null;
  jobId:string|null;
  confirmedBy:string;
  confirmedAt:string;
  lastReconciledAt:string|null;
  createdAt:string;
  updatedAt:string;
  recordHash:string;
}
