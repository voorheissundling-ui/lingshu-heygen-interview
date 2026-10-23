export interface WeeklyProfileUpgradeScope {tenantId:string;programId:string;packageId:string;packageVersion:number}
export type WeeklyProfileUpgradeBasis='tone_clear_growth_stalled'|'history_material_or_engagement_insufficient';
export interface WeeklyProfileHistoryEvidence {
 evidenceRef:string;accountId:string;platform:string;externalContentId:string;publicUrl:string;publishedAt:string;
 capturedAt:string|null;observationSeconds:number|null;metrics:{views:number|null;likes:number|null;shares:number|null;comments:number|null};
 toneVerified:boolean;evidenceHash:string;gaps:string[];
}
export interface WeeklyProfileUpgrade {
 id:string;version:1;tenantId:string;programId:string;packageId:string;packageVersion:number;
 targetWeekStart:string;basis:WeeklyProfileUpgradeBasis;reason:string;createdBy:string;createdAt:string;
 evidence:WeeklyProfileHistoryEvidence[];evidenceHash:string;
 policy:{profile:'b2b_established';ownedPercent:20|40;externalPercent:80|60;allocationUnit:'mother_content'};
 confirmedBy:string|null;confirmedAt:string|null;
}
