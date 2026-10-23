import type {SocialWeeklyG6Scope,SocialOwnedVideoMetadata} from './socialWeeklyG6Review.js';
/** Packaging preserves production provenance; it is not a new mother video or publication. */
export interface SocialInstagramDelivery extends SocialWeeklyG6Scope {
 deliveryId:string;requestId:string;version:1;preparedBy:string;preparedAt:string;
 sourceContextHash:string;sourceArtifactHash:string;sourceFileRef:string;sourceFileSha256:string;
 sourceHandoffId:string;sourceHandoffVersion:string;sourceProductionResultId:string;sourceProductionResultHash:string;
 sourceAuditHash:string;
 conversionVersion:string;conversionHash:string;fileRef:string;fileSha256:string;fileId:string;
 metadata:SocialOwnedVideoMetadata;recordHash:string;
}
export interface SocialInstagramDeliveryPublishProof {
 scope:SocialWeeklyG6Scope;deliveryId:string;deliveryHash:string;sourceFileSha256:string;
 fileRef:string;fileId:string;fileSha256:string;conversionVersion:string;
 technicalReviewHash:string;creativeReviewHash:string;g6RequestId:string;g6ReviewHash:string;g6ReceiptHash:string;
}
export const INSTAGRAM_DELIVERY_TECHNICAL_CHECKS=['format','duration','av_sync','subtitles','material_association','render','sensitive_data'] as const;
export const INSTAGRAM_DELIVERY_CREATIVE_CHECKS=['hook','evidence_order','account_tone','cta','truth_boundary','variant_difference'] as const;
export type InstagramDeliveryReviewKind='technical'|'creative';
export interface InstagramDeliveryObservation {code:string;outcome:'passed'|'failed'|'unknown';observation:string}
/** Independent explicit human review of the actual packaged file, never an inherited G4/G5 result. */
export interface SocialInstagramDeliveryReview {
 reviewId:string;requestId:string;deliveryId:string;deliveryHash:string;fileSha256:string;
 kind:InstagramDeliveryReviewKind;actorUserId:string;actorRole:'human_technical_reviewer'|'human_director_reviewer';
 checks:InstagramDeliveryObservation[];status:'passed'|'failed'|'review_required';reviewedAt:string;recordHash:string;
}
export interface SocialInstagramDeliveryRead {
 item:SocialInstagramDelivery|null;currentSourceVerified:boolean;
 reviews:SocialInstagramDeliveryReview[];previewUrl:string|null;gaps:string[];
}
