export const SCENE_G4_CHECK_CODES=['format','duration','audio_visual_sync','caption','linked_assets','render','sensitive_data'] as const;
export type SceneG4CheckCode=typeof SCENE_G4_CHECK_CODES[number];
export interface SocialSceneG4ReviewScope{tenantId:string;taskId:string;runId:string;artifactId:string}
export interface SocialSceneG4ManualCheck{code:SceneG4CheckCode;outcome:'passed'|'failed'|'unknown';observation:string}
export interface SocialSceneG4ReviewContext extends SocialSceneG4ReviewScope{
 sceneId:string;productionSceneId:string;sourceHash:string;contextHash:string;artifactHash:string;fileRef:string;fileSha256:string;sceneSha256:string;
 latestReceiptId:string;latestReceiptHash:string;latestAttempt:number;reviewerUserId:string|null;reviewerAuthorityHash:string|null;
 previewUrl:string;startSeconds:number|null;endSeconds:number|null;checks:Array<{code:string;passed:boolean;message:string}>;
}
export interface SocialSceneG4HumanReview extends SocialSceneG4ReviewScope{
 reviewId:string;requestId:string;version:1;sceneId:string;productionSceneId:string;sourceHash:string;artifactHash:string;fileRef:string;fileSha256:string;sceneSha256:string;
 contextHash:string;reviewedBy:string;reviewerAuthorityHash:string;reviewedAt:string;checks:SocialSceneG4ManualCheck[];
 status:'passed'|'failed'|'review_required';receiptId:string;receiptHash:string;recordHash:string;
}
export interface SocialSceneG4ReviewRead{item:SocialSceneG4HumanReview|null;projectionStatus:'not_found'|'pending'|'applied';currentSourceVerified:boolean}
