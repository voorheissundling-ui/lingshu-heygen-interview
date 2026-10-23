import type {SocialShotMaterialMapEntry} from '../../shared/contracts/socialContentDiscovery.js';
import type {SocialTaskSource} from '../../shared/contracts/socialContentWorkflow.js';
import type {SocialWorkflowMaterialClipCandidate} from './socialContentMaterialCandidateSupport.js';
import {decodeMaterialRef} from './socialContentProductionMaterials.js';
import type {ReviewedMaterialRoutingBinding} from './socialContentMaterialRoutingRequests.js';
import {sameProduct,type SocialWorkflowMaterialCandidateSet} from './socialContentMaterialCandidateSupport.js';

export const uniqueMaterialAssetIds=(rows:SocialWorkflowMaterialClipCandidate[])=>[...new Set(rows.map(row=>row.assetId))];
export const matchesRequestedMaterialProduct=(candidate:SocialWorkflowMaterialClipCandidate,set:SocialWorkflowMaterialCandidateSet)=>sameProduct(candidate,{productId:set.requestedProductId,productRef:set.requestedProductRef});

/** Projects only the reviewed weekly video bindings whose active task source,
 * immutable revision and frozen rights request all still agree. */
export function projectWeeklyReviewedMaterialRouting(input:{
 tenantId:string; requestIds:string[]; shotMaterialMap:SocialShotMaterialMapEntry[];
 candidates:SocialWorkflowMaterialClipCandidate[]; activeMaterials:SocialTaskSource[];
}):ReviewedMaterialRoutingBinding[]{
 const requestIds=new Set(input.requestIds);
 if(!requestIds.size)return[];
 return input.shotMaterialMap.flatMap(mapped=>mapped.customerAssetIds.flatMap(recordId=>input.candidates.flatMap(candidate=>{
  const profile=candidate.segmentProfile;
  if(!new Set([recordId,`pb-${recordId}`]).has(candidate.assetId)||!profile?.productionEligible
   ||profile.tenantId!==input.tenantId||profile.assetId!==candidate.assetId||profile.segmentId!==candidate.segmentId
   ||profile.sourceRevision!==candidate.sourceRevision)return[];
  const sources=input.activeMaterials.filter(source=>decodeMaterialRef(source.sourceRef)===candidate.assetId&&source.sourceVersion===candidate.sourceRevision);
  const evidenceRefs=profile.rightsEvidenceRefs.filter(ref=>requestIds.has(ref));
  if(sources.length!==1||evidenceRefs.length!==1||!profile.commercialUseApproved
   ||!profile.commercialUseApprovalEvidenceRefs.includes(evidenceRefs[0]!)||!profile.derivativeUseAllowed)return[];
  return[{shotId:mapped.shotId,assetId:candidate.assetId,segmentId:candidate.segmentId,sourceRef:candidate.sourceRef,
   sourceRevision:candidate.sourceRevision,rightsEvidenceRef:evidenceRefs[0]!}];
 })));
}
