import type {SocialReplicationScriptVersion,SocialReferenceShotAnalysis} from './contracts/socialContentWorkflow';
import type {SocialReplicationReferenceMode} from './contracts/socialContentReplication';
import {classifySocialAssetSupplyMaterialType} from './socialContentAssetSupply';

/** Plans a new visual timeline. Original ASR, measured words and narration are never rewritten. */
export function planTypeAwareProductScriptTiming(input:{policyVersion?:'type-aware.v1'|'type-aware.v2';referenceMode?:SocialReplicationReferenceMode;script:SocialReplicationScriptVersion;referenceShots?:SocialReferenceShotAnalysis[];explicitFrozenRevision?:boolean}){
 const unchanged={script:input.script,changedShotIds:[] as string[],protectedShotIds:[] as string[],narrationReviewRequired:false};
 if((input.policyVersion!=='type-aware.v1'&&input.policyVersion!=='type-aware.v2')||input.explicitFrozenRevision||['confirmed','superseded'].includes(input.script.status))return unchanged;
 const fidelity=input.referenceMode==='single_source_fidelity';
 const source=input.script,copy=structuredClone(source),changedShotIds:string[]=[],protectedShotIds:string[]=[];
 const allLines=[...(source.narrationLines??[]),...source.shots.flatMap(shot=>shot.speechLines??[])];
 let delta=0,narrationReviewRequired=false;
 for(let index=0;index<source.shots.length;index++){
  const original=source.shots[index],shot=copy.shots[index],duration=original.endSeconds-original.startSeconds;
  if(!Number.isFinite(original.startSeconds)||!Number.isFinite(original.endSeconds)||original.startSeconds<0||duration<=0||(index>0&&original.startSeconds<source.shots[index-1].endSeconds))throw Error(`material_script_timing_invalid:${original.shotId}`);
  const materialType=original.materialPlan.materialRouting?.materialType??classifySocialAssetSupplyMaterialType({shotId:original.shotId,function:original.purpose,requestedDescription:original.visualInstruction,referenceShotId:original.referenceShotId,visualContract:original.materialPlan.visualContract},input.referenceShots);
  const generated=original.materialPlan.sourceStrategy==='aigc_product_scene_replication';
  const explicit=original.materialPlan.materialRouting?.generation?.durationOrigin==='explicit_frozen';
  const ownSpeech=Boolean(original.spokenText?.trim()||original.speechLines?.some(line=>line.draftText.trim()&&(!line.narrationOwnerShotId||line.narrationOwnerShotId===original.shotId)));
  const crossSpeech=allLines.some(line=>Boolean(line.draftText.trim())&&(line.visualShotIds?.includes(original.shotId)||Number.isFinite(line.sourceStartSeconds)&&Number.isFinite(line.sourceEndSeconds)&&line.sourceStartSeconds<original.endSeconds&&line.sourceEndSeconds>original.startSeconds));
  let target=duration;
  if(!fidelity&&materialType==='product'&&generated&&!explicit&&duration!==3){
   if(ownSpeech||crossSpeech){protectedShotIds.push(original.shotId);}
   else{target=3;changedShotIds.push(original.shotId);}
  }
  shot.startSeconds=+(original.startSeconds+delta).toFixed(6);shot.endSeconds=+(shot.startSeconds+target).toFixed(6);
  if(generated&&!explicit){
   const generationDuration=fidelity?3:target;
   if(shot.materialPlan.productSceneReplication)shot.materialPlan.productSceneReplication.cameraLock.durationSeconds=generationDuration;
   if(shot.materialPlan.materialRouting?.generation){shot.materialPlan.materialRouting.generation.durationSeconds=generationDuration;shot.materialPlan.materialRouting.generation.durationOrigin=fidelity?'default_short_shot':'planned_timeline';}
  }
  if(delta!==0&&ownSpeech)narrationReviewRequired=true;
  delta+=target-duration;
 }
 if(!changedShotIds.length&&JSON.stringify(copy)===JSON.stringify(source))return {...unchanged,protectedShotIds};
 copy.status='review_required';
 return {script:copy,changedShotIds,protectedShotIds,narrationReviewRequired};
}
