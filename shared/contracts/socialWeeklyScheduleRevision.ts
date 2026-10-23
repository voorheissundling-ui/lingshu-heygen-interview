import type {WeeklyContentTemplateRevisionPlan} from './socialWeeklyContentTemplates.js';
import type { VersionedSocialRef, WeeklyOperatingPackage,WeeklyExecutionTask } from './socialProgram.js';
import type { WeeklyBackwardSchedule, RecoveryResource, RecoveryTaskConstraint } from './socialWeeklyCapacity.js';
export interface WeeklyScheduleCapacityInput {constraints:Record<string,RecoveryTaskConstraint>;resources:Record<string,RecoveryResource>;remainingBudgetCny:number;operationalDeadlines?:Record<string,string>;}
export interface WeeklyScheduleTargetGraph {tenantId:string;programId:string;packageId:string;sourceVersion:number;targetVersion:number;executionGraphVersion:1|2|3;targetGraphHash:string;tasks:WeeklyExecutionTask[];bindings:Array<{planningTaskId:string;targetTaskId:string;sourceTaskId:string|null;signature:string;origin:'existing_source'|'new_planned'}>;}
export interface WeeklyScheduleProposal {
 proposalId:string;tenantId:string;programId:string;packageId:string;packageVersion:number;createdBy:string;createdAt:string;inputEvidenceHash:string;
 templateCarryovers?:WeeklyContentTemplateRevisionPlan[];
 targetGraph?:WeeklyScheduleTargetGraph;capacity:WeeklyScheduleCapacityInput;plan:WeeklyBackwardSchedule;inputAuthority:'stored_tasks_with_user_confirmed_capacity_assumptions'|'target_graph_with_verified_source_tasks_and_user_confirmed_capacity'|'target_graph_with_automatic_template_capacity';
 automaticAdoption?:{source:'automatic_template';templateVersion:string;adoptedAt:string;userApproval:null};
}
export interface WeeklyScheduleSnapshot {
 snapshotId:string;proposalId:string;tenantId:string;programId:string;packageId:string;sourceVersion:number;targetVersion:number;confirmedBy:string;confirmedAt:string;inputEvidenceHash:string;
 targetGraphHash?:string;targetExecutionGraphVersion?:1|2|3;templateCarryovers?:WeeklyContentTemplateRevisionPlan[];
 assignments:Array<{sourceTaskId:string|null;targetTaskId?:string;origin?:'existing_source'|'new_planned';signature:string;startAt:string;finishAt:string;resourceKey:string|null;mode?:'planned'|'completed_verified'|'running_reserved';sourceInputHash?:string}>;
 publicationTimes:Array<{publicationTaskId:string;publishWindow:string|null}>;
 queueConfigurationHash?:string;queueCapacityEvidenceHash?:string;
 capacity:WeeklyScheduleCapacityInput;previousPublishingAuthorizationAllowed:boolean;
 automaticAdoption?:WeeklyScheduleProposal['automaticAdoption'];
}
export type WeeklyScheduledPackage=WeeklyOperatingPackage&{scheduleRevisionRef?:VersionedSocialRef};
export interface WeeklyScheduleConfirmation {item:WeeklyScheduledPackage;snapshot:WeeklyScheduleSnapshot;materialConsumerRepairs:Array<{requestId:string;reason:string}>;activated:false;previousPublishingAuthorizationRevoked:boolean;}
export type WeeklyScheduleConfirmationReceipt=
 | {status:'not_committed';proposalId:string;sourceVersion:number;targetVersion:number}
 | {status:'pending_recovery';proposalId:string;sourceVersion:number;targetVersion:number;snapshot:WeeklyScheduleSnapshot}
 | {status:'committed';proposalId:string;sourceVersion:number;targetVersion:number;snapshot:WeeklyScheduleSnapshot;item:WeeklyScheduledPackage;activated:false};
