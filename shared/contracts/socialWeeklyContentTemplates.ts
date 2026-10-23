import type {VersionedSocialRef} from './socialProgram.js';
export type WeeklyContentTemplateAction='new'|'retain'|'revise';
export interface WeeklyContentTemplateCandidate {
 templateId:string;version:number;tenantId:string;programId:string;action:WeeklyContentTemplateAction;previousRef:VersionedSocialRef|null;title:string;reason:string;applicability:{platform:string;audience:string;productScope:string;replaceFacts:string[];prohibited:string[]};
 source:{packageId:string;packageVersion:number;weekStart:string;weekEnd:string;publicationTaskId:string;accountId:string;sourceTaskId:string;artifactRef:VersionedSocialRef;reviewRef:VersionedSocialRef;baselineVersion:string;directorPlanVersion:string};
 structure:{scriptBaseline:unknown;directorPlan:unknown};
 performance:{metricRefs:string[];publicationReceiptRefs:string[];metrics:{views:number|null;likes:number|null;comments:number|null;shares:number|null};missingKeys:string[];sampleSufficiency:'sufficient'|'insufficient'|'unavailable';observationStartsAt:string;observationEndsAt:string};
 createdBy:string;createdAt:string;recordHash:string;
}
export interface WeeklyContentTemplateConfirmation {confirmationId:string;templateRef:VersionedSocialRef;tenantId:string;programId:string;candidateHash:string;usage:'trial'|'retain';reason:string;confirmedBy:string;confirmedAt:string;recordHash:string;}
export interface WeeklyContentTemplateRevisionPlan {sourceScope:{tenantId:string;programId:string;packageId:string;packageVersion:number;publicationTaskId:string};targetScope:{tenantId:string;programId:string;packageId:string;packageVersion:number;publicationTaskId:string};sourceBindingRef:VersionedSocialRef;sourceBindingHash:string;sourcePackageHash:string;sourcePublicationHash:string;targetBindingRef:VersionedSocialRef;templateRef:VersionedSocialRef;candidateHash:string;confirmationId:string;plannedBy:string;planHash:string;}
export interface WeeklyContentTemplateBinding {carryover?:{sourceBindingRef:VersionedSocialRef;sourceBindingHash:string;planHash:string};bindingId:string;tenantId:string;programId:string;packageId:string;packageVersion:number;publicationTaskId:string;templateRef:VersionedSocialRef;candidateHash:string;confirmationId:string;confirmedBy:string;confirmedAt:string;recordHash:string;}

/** Immutable explicit selection for one actual extraction task. */
export interface WeeklyContentTemplateExecutionSelection {
 selectionId:string;tenantId:string;programId:string;packageId:string;packageVersion:number;
 taskId:string;extractionTaskId:string;templateRef:VersionedSocialRef;candidateHash:string;
 selectedBy:string;selectedAt:string;version:1;recordHash:string;
}
