import type { SocialContentTaskDetail } from '../../shared/contracts/socialContentWorkflow.js';
import type { VersionedSocialRef } from '../../shared/contracts/socialProgram.js';
import { socialJson, socialObject, socialRequestHash } from '../starter198/socialContentValidation.js';

export interface WeeklyMaterialDemandScope {taskId:string;programId:string;packageId:string;packageVersion:number;publicationTaskId:string;accountId?:string;factRefs:VersionedSocialRef[]}
export interface FrozenNoSharedMaterialDemand extends WeeklyMaterialDemandScope {
 schemaVersion:'weekly-material-demand.v1';mode:'no_shared_requests';version:number;
 materialRequirements:unknown[];assetSupplyPlan:NonNullable<SocialContentTaskDetail['assetSupplyPlan']>;
 runProof?:{runId:string;runContextHash:string;sourceDigest:string;authorityHash:string;planHash:string};
 recordHash:string;
}
function safePlan(plan:FrozenNoSharedMaterialDemand['assetSupplyPlan'],facts:VersionedSocialRef[],accountId?:string) {
 if(!Array.isArray(facts)||!facts.length||facts.some(ref=>!ref||typeof ref.type!=='string'||!ref.type.trim()||typeof ref.id!=='string'||!ref.id.trim()||!Number.isSafeInteger(ref.version)||ref.version<1))return false;
 if(!plan||plan.status!=='ready'||!plan.planVersion||plan.planVersion==='historic-unversioned'||plan.productionApproach==='shooting_plan'||!Array.isArray(plan.customerActions)||plan.customerActions.length!==0||!Array.isArray(plan.shots)||!plan.shots.length||!plan.canProduceWithoutCustomerShoot)return false;
 const requiredFacts=facts.map(ref=>`${ref.type}:${ref.id}@${ref.version}`);
 return plan.shots.every(shot=> {
  if(!shot||typeof shot!=='object')return false;
  const boundary=shot.truthBoundary;
  if(!boundary||boundary.customerEvidenceRequired||shot.customerShootRequired!==false||!Array.isArray(boundary.confirmedFactRefs)||requiredFacts.some(ref=>!boundary.confirmedFactRefs.includes(ref)))return false;
  if(['non_evidentiary_ai_visual','motion_graphics','verified_fact_card'].includes(shot.sourceStrategy))return true;
  if(shot.sourceStrategy!=='authorized_digital_presenter')return false;
  const lock=plan.accountPresenterLock;
  const shotLock=shot.digitalHumanPlan?.accountPresenterLock;
  return Boolean(accountId&&lock&&lock.socialAccountId===accountId&&shotLock&&socialRequestHash(shotLock)===socialRequestHash(lock)&&Array.isArray(shot.sourceRefs)&&shot.sourceRefs.includes(lock.presenterAssetId)&&lock.status==='published'&&lock.commercialRightsStatus==='cleared'&&lock.consentRef&&lock.presenterAssetId&&lock.presenterProfileId&&lock.presenterProfileVersion&&shot.digitalHumanPlan?.executionState==='ready_for_capability_check');
 });
}
/** Build only from the actual stored requirement list and server-resolved asset plan, never generic readiness. */
export function buildNoSharedMaterialDemand(row:Record<string,unknown>,detail:SocialContentTaskDetail,scope:WeeklyMaterialDemandScope):FrozenNoSharedMaterialDemand|null {
 const requirements=socialJson(row.material_requirements);
 const version=Number(detail.version.replace(/^v/,''));
 if(row.task_id!==scope.taskId||detail.taskId!==scope.taskId||!Number.isSafeInteger(version)||version<1||!Array.isArray(requirements)||requirements.some(item=>!item||typeof item!=='object'||(item as {required?:unknown}).required!==false)||!detail.assetSupplyPlan||!safePlan(detail.assetSupplyPlan,scope.factRefs,scope.accountId))return null;
 const payload={schemaVersion:'weekly-material-demand.v1' as const,mode:'no_shared_requests' as const,...scope,version,materialRequirements:structuredClone(requirements),assetSupplyPlan:structuredClone(detail.assetSupplyPlan)};
 return {...payload,recordHash:socialRequestHash(payload)};
}
/** Validator and adapter share this verifier; a stored demand is immutable and scoped to the frozen publication. */
function verifiedDemandPayload(row:Record<string,unknown>,scope:WeeklyMaterialDemandScope):FrozenNoSharedMaterialDemand|null {
 const brief=socialObject(socialJson(row.brief));
 const demand=brief?._weeklyMaterialDemand as FrozenNoSharedMaterialDemand|undefined;
 if(!demand||row.task_id!==scope.taskId||demand.schemaVersion!=='weekly-material-demand.v1'||demand.mode!=='no_shared_requests'||!Number.isSafeInteger(demand.version)||demand.version<1)return null;
 if(['taskId','programId','packageId','packageVersion','publicationTaskId','accountId'].some(key=>demand[key as keyof WeeklyMaterialDemandScope]!==scope[key as keyof WeeklyMaterialDemandScope]))return null;
 if(socialRequestHash(demand.factRefs)!==socialRequestHash(scope.factRefs)||!Array.isArray(demand.materialRequirements)||demand.materialRequirements.some(item=>!item||typeof item!=='object'||(item as {required?:unknown}).required!==false)||!safePlan(demand.assetSupplyPlan,scope.factRefs,scope.accountId))return null;
 const {recordHash,...payload}=demand;
 if(recordHash!==socialRequestHash(payload))return null;
 const currentRequirements=socialJson(row.material_requirements);
 if(!Array.isArray(currentRequirements)||socialRequestHash(currentRequirements)!==socialRequestHash(demand.materialRequirements)||currentRequirements.some(item=>!item||typeof item!=='object'||(item as {required?:unknown}).required!==false))return null;
 return demand;
}

/** A run-bound demand requires actual store lookup; its self-declared hash is insufficient. */
export function verifiedNoSharedMaterialDemand(row:Record<string,unknown>,scope:WeeklyMaterialDemandScope):FrozenNoSharedMaterialDemand|null {
 const demand=verifiedDemandPayload(row,scope);return demand?.runProof?null:demand;
}
