import { existsSync, statSync } from 'node:fs';
import type { SocialAssetSupplyPlan, SocialContentTaskBrief, SocialContentTaskDetail } from '../../shared/contracts/socialContentWorkflow.js';
import type { ProductionAsset } from './socialContentAutoProduction.js';
import { freezeSocialReferenceBackgroundAsset } from './socialContentReferenceBackgroundLock.js';
import type { PresenterExecutionSelection } from './socialContentPresenterExecutionPolicy.js';

/** Only dynamic presenter shots inherit the task-scoped benchmark background. */
export function assetSupplyPlanWithDynamicPresenterBackgroundLocks(input:{
  plan:SocialAssetSupplyPlan;
  selections:PresenterExecutionSelection[];
  referenceReuse:NonNullable<SocialContentTaskBrief['referenceReuse']>|null|undefined;
  referenceAnalysis:SocialContentTaskDetail['referenceVideoAnalysis'];
  scenes:NonNullable<SocialContentTaskDetail['agentWorkflow']>['directorBrief']['scenes'];
}):SocialAssetSupplyPlan{
  const dynamicIds=new Set(input.selections.filter(item=>item.providerId==='seedance'&&item.executionStatus==='ready').map(item=>item.sceneId));
  if(!dynamicIds.size)return input.plan;
  if(!input.referenceReuse||!input.referenceAnalysis)throw Error('reference_background_source_missing');
  const scenes=new Map(input.scenes.map(scene=>[scene.sceneId,scene]));
  return{...input.plan,shots:input.plan.shots.map(shot=>{
    if(!dynamicIds.has(shot.shotId))return shot;
    const referenceShotId=scenes.get(shot.shotId)?.referenceShotId;
    if(!referenceShotId)throw Error(`reference_background_shot_missing:${shot.shotId}`);
    return{...shot,referenceBackgroundAssetLock:freezeSocialReferenceBackgroundAsset({referenceReuse:input.referenceReuse!,referenceAnalysis:input.referenceAnalysis!,referenceShotId})};
  })};
}

export function typeAwareRequiredMaterialIds(plan:SocialAssetSupplyPlan|null):string[]{
  return [...new Set((plan?.shots??[]).flatMap(shot=>[
    ...shot.sourceRefs,
    ...(shot.materialRouting?.localMatch?.sourceRefs??[]),
    ...(shot.materialRouting?.generation?.productImageRefs??[]),
  ]).filter(Boolean))];
}

export function rebindDivergentLocalRoutesFromApprovedContext(input:{plan:SocialAssetSupplyPlan;approved:SocialAssetSupplyPlan;assets:ProductionAsset[]}){
  const approvedById=new Map(input.approved.shots.map(shot=>[shot.shotId,shot]));
  const usableAssets=new Map(input.assets.filter(asset=>asset.type==='video'&&Boolean(asset.localPath)&&existsSync(asset.localPath!)
    &&statSync(asset.localPath!).size>0).map(asset=>[asset.id,asset]));
  const rebindings:Array<{shotId:string;previousRefs:string[];selectedRefs:string[];approvalEvidenceRef:string;assetHashes:string[]}>=[];
  const plan={...input.plan,shots:input.plan.shots.map(shot=>{
    const route=shot.materialRouting;
    if(route?.policy!=='local_only'||route.localMatch.state!=='matched')return shot;
    const approved=approvedById.get(shot.shotId),approvedRoute=approved?.materialRouting;
    if(approvedRoute?.localMatch.sourceRefs.length===route.localMatch.sourceRefs.length
      &&approvedRoute.localMatch.sourceRefs.every(ref=>route.localMatch.sourceRefs.includes(ref)))return shot;
    if(!approved||approvedRoute?.policy!=='local_only'||approvedRoute.localMatch.state!=='matched'
      ||approvedRoute.materialType!==route.materialType||!approvedRoute.localMatch.evidenceRef
      ||!approvedRoute.localMatch.sourceRefs.length
      ||approvedRoute.localMatch.sourceRefs.some(ref=>!usableAssets.has(ref))
      ||(shot.truthBoundary.subject==='customer_factory'&&approvedRoute.localMatch.sourceRefs.some(ref=>!ref.startsWith('owned-'))))return shot;
    rebindings.push({shotId:shot.shotId,previousRefs:[...route.localMatch.sourceRefs],selectedRefs:[...approvedRoute.localMatch.sourceRefs],
      approvalEvidenceRef:approvedRoute.localMatch.evidenceRef,
      assetHashes:approvedRoute.localMatch.sourceRefs.map(ref=>usableAssets.get(ref)!.contentHash||'')});
    return {...shot,sourceStrategy:'customer_real_asset' as const,sourceRefs:[...approvedRoute.localMatch.sourceRefs],fallbackSourceStrategy:null,
      selectedMaterialSegment:approved.selectedMaterialSegment&&approvedRoute.localMatch.sourceRefs.includes(approved.selectedMaterialSegment.sourceRef)
        ?structuredClone(approved.selectedMaterialSegment):undefined,materialRouting:structuredClone(approvedRoute)};
  })};
  return{plan,rebindings};
}
