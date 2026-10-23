import type {VersionedSocialRef} from './socialProgram.js';

export type WeeklyProductionRepairCaseState =
  | 'awaiting_configuration'
  | 'awaiting_capacity'
  | 'ready'
  | 'running'
  | 'awaiting_audit'
  | 'resolved'
  | 'cancelled';

export interface WeeklyRepairAdmissionConfirmation {
  type:'weekly_repair_admission_confirmation';
  version:1;
  caseId:string;
  caseRequestHash:string;
  previewHash:string;
  operationId:string;
  executionRunId:string;
  sceneCacheHash:string;
  planHash:string;
  localOnly:boolean;
  quoteHash:string|null;
  costPolicyHash:string|null;
  authorizedMaximumCostCny:number;
  capacityWindow:{startsAt:string;finishesAt:string;deadlineAt:string;estimatedDurationMinutes:number;recordHash:string};
  confirmedBy:string;
  confirmedAt:string;
  recordHash:string;
}

export interface WeeklyProductionRepairCase {
  schemaVersion:'weekly-production-repair-case.v1';
  caseId:string;
  version:1;
  requestId:string;
  requestHash:string;
  tenantId:string;
  programId:string;
  packageId:string;
  packageVersion:number;
  publicationTaskId:string;
  accountId:string;
  qualityTaskId:string;
  approvalTaskId:string;
  kind:'technical_scene_repair'|'creative_revision';
  trigger:{
    type:'verified_quality_failure';
    blocker:'weekly_quality_audit_actual_repair_required';
    qualityContextHash:string;
    failedReceiptIds:string[];
  }|{
    type:'user_changes_requested';
    operationId:string;
    operationRequestHash:string;
    artifactDecisionVersion:number;
    note:string;
    noteHash:string;
  };
  parent:{
    taskId:string;
    runId:string;
    artifactRef:VersionedSocialRef;
    artifactHash:string;
    sceneCacheHash:string;
  };
  affectedSceneIds:string[];
  ownerUserId:string;
  reviewerUserId:string;
  deadlineAt:string|null;
  affectedPublishWindow:string;
  estimatedDurationMinutes:number|null;
  maximumCostCny:number|null;
  configurationGaps:string[];
  state:WeeklyProductionRepairCaseState;
  admission:WeeklyRepairAdmissionConfirmation|null;
  execution:{operationId:string;runId:string;jobId:string}|null;
  childArtifactRef:VersionedSocialRef|null;
  createdBy:string;
  createdAt:string;
  updatedAt:string;
  recordHash:string;
}
