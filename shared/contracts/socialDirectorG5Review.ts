import type {DirectorG5RuleCheck,DirectorG5SourceRecordEvidence} from './socialDirectorG5AccountRules';
import type {SocialReplicationJobContext} from './socialContentReplication';
export interface DirectorG5AccountPlaybookRequirement {
 accountRef:NonNullable<SocialReplicationJobContext['targetAccountRef']>;
 playbookRef:NonNullable<SocialReplicationJobContext['accountPlaybookRef']>;
 rules:NonNullable<SocialReplicationJobContext['verifiedAccountPlaybook']>;
 constraintHash:string;
 reviewStatus:'unverified';
}
export const DIRECTOR_G5_CHECK_CODES=['hook','evidence_order','account_tone','cta','truth_boundary','variant_difference'] as const;
export type DirectorG5CheckCode=typeof DIRECTOR_G5_CHECK_CODES[number];
export interface SocialDirectorG5Scope{tenantId:string;taskId:string;runId:string;artifactId:string}
export interface SocialDirectorG5Check{code:DirectorG5CheckCode;outcome:'passed'|'failed'|'unknown';observation:string;evidenceSceneIds:string[];accountRuleChecks?:DirectorG5RuleCheck[]}
export interface SocialDirectorG5Context extends SocialDirectorG5Scope{
 sourceHash:string;contextHash:string;artifactHash:string;fileRef:string;fileSha256:string;previewUrl:string;
 handoffId:string;handoffVersion:string;g4:{ready:boolean;scenes:Array<{sceneId:string;productionSceneId:string;status:'passed'|'failed'|'review_required';receiptId:string;receiptHash:string}>};
 sourceRecordEvidence?:DirectorG5SourceRecordEvidence[];
 requirements:{accountPlaybook?:DirectorG5AccountPlaybookRequirement;accountTone:string[];script:Array<{sceneId:string;startSeconds:number;endSeconds:number;purpose:string;visual:string;voiceover:string|null;dialogue:string|null;caption:string|null;acceptanceCriteria:string[]}>;facts:Array<{key:string;label:string;value:string}>;truthBoundaries:Array<{sceneId:string;requirements:unknown}>;cta:string|null;variantDifference:unknown};
 reviewerUserId:string|null;reviewerAuthorityHash:string|null;agent:{reviewCostCny:number|null;taskBudgetCny:number|null;remainingBudgetCny:number|null;authorization:SocialDirectorG5ExecutionAuthorization|null;configured:boolean;executionPermitted:boolean;internalBudgetExempt:boolean;model:string|null;gaps:string[]};gaps:string[];
}
export interface SocialDirectorG5Review extends SocialDirectorG5Scope{
 reviewId:string;requestId:string;version:1;mode:'agent'|'human_fallback';sourceHash:string;contextHash:string;artifactHash:string;fileRef:string;fileSha256:string;
 requestedBy:string;requestedAt:string;reviewedBy:string|null;reviewerAuthorityHash:string|null;state:'running'|'unknown'|'completed';status:'passed'|'failed'|'review_required'|null;
 checks:SocialDirectorG5Check[];receiptId:string|null;receiptHash:string|null;completedAt:string|null;model:string|null;recordHash:string;
}
export interface SocialDirectorG5ReviewRead{runtimeObservationResumeAvailable:boolean;item:SocialDirectorG5Review|null;projectionStatus:'not_found'|'pending'|'applied';currentSourceVerified:boolean}

export interface SocialDirectorG5ExecutionAuthorization extends SocialDirectorG5Scope {sourceHash:string;executionActor:"director_agent";capability:"director_review";budgetBucket:"content";model:string;maximumCostCny:number;authorizedBy:string;authorizedAt:string;recordHash:string}
