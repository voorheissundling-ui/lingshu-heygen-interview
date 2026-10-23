import type {SocialDirectorG5Scope} from './socialDirectorG5Review.js';
import type {WeeklyExecutionTask,VersionedSocialRef} from './socialProgram.js';
export interface WeeklyContentQualityRecoveryReceipt extends SocialDirectorG5Scope {
 requestId:string;executionTaskId:string;programId:string;packageId:string;packageVersion:number;publicationTaskId:string;
 expectedContextHash:string;sourceHash:string;artifactRef:VersionedSocialRef;g5ReceiptId:string;g5ReviewId:string;auditSourceHash:string;g5ReceiptHash:string;g5ReviewHash:string;
 clearedBlocker?:'weekly_production_quality_review_required'|'weekly_quality_audit_actual_repair_required';
 repairParentArtifactRef?:VersionedSocialRef|null;
 recoveredBy:string;recoveredAt:string;recordHash:string;
}
export interface WeeklyContentQualityRecoveryConsumer {
 executionTaskId:string;programId:string;packageId:string;packageVersion:number;publicationTaskId:string;
 stepKind:'quality_check'|'rework';status:WeeklyExecutionTask['status'];ownBlockingReasons:string[];inheritedBlockingTaskIds:string[];
 contextHash:string;resumeAvailable:boolean;gap:{code:string;message:string}|null;
 recoveries:WeeklyContentQualityRecoveryReceipt[];
}
export interface WeeklyContentQualityRecoveryContext extends SocialDirectorG5Scope {
 artifactRef:VersionedSocialRef;artifactHash:string;sourceHash:string;consumers:WeeklyContentQualityRecoveryConsumer[];
}
export interface WeeklyContentQualityRecoveryRead {
 item:WeeklyContentQualityRecoveryReceipt|null;currentSourceVerified:boolean;task:WeeklyExecutionTask;
}
