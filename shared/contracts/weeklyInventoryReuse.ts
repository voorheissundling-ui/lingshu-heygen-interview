import type {VersionedSocialRef} from './socialProgram.js';
export interface WeeklyInventorySourceProof {
 artifactRef:VersionedSocialRef;artifactHash:string;productionResultId:string;productionVersion:string;productionHash:string;
 sourceContentTaskId:string;sourcePackageId:string;sourcePackageVersion:number;sourcePublicationTaskId:string;sourceApprovalTaskId:string;
 acceptedApprovalHash:string;lineageHash:string;sourceRefs:VersionedSocialRef[];g4ReceiptIds:string[];g4ReceiptHashes:string[];
 fileRef:string;fileSha256:string;sourceHash:string;title:string;
}
export interface WeeklyInventoryBinding {
 bindingId:string;ref:{type:'weekly_inventory_binding';id:string;version:1};version:1;tenantId:string;programId:string;
 target:{packageId:string;packageVersion:number;publicationTaskId:string;publicationHash:string;accountId:string;platform:string};
 source:WeeklyInventorySourceProof;confirmedBy:string;confirmedAt:string;reason:string;
 rightsConfirmation:{actorUserId:string;confirmedAt:string;statement:string};timelinessConfirmation:{actorUserId:string;confirmedAt:string;statement:string};
 countsAsNewMotherContent:false;startsProduction:false;recordHash:string;
}
export interface ConfirmWeeklyInventoryReuse {artifactRef:VersionedSocialRef;expectedSourceHash:string;publicationTaskId:string;expectedTargetPublicationHash:string;reason:string;rightsStatement:string;timelinessStatement:string}
export interface WeeklyInventoryCandidate {source:WeeklyInventorySourceProof;publicationTaskId:string;targetPublicationHash:string;gap:string|null}
