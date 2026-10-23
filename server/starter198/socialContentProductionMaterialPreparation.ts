import fsp from 'node:fs/promises';
import path from 'node:path';
import type {SocialAssetSupplyPlan} from '../../shared/contracts/socialContentWorkflow.js';
import {isInternalBudgetExemptTenant} from '../lib/tenantBudgetExemption.js';
import {applyPresenterFirstBudgetDegradation} from './socialContentBudgetDegradation.js';
import {assetSupplyPlanWithExecutionSelections,assertCompleteTypeAwareExecutionPlan} from './socialContentExecutionPlan.js';
import {assetSupplyPlanWithDynamicPresenterBackgroundLocks,typeAwareRequiredMaterialIds,rebindDivergentLocalRoutesFromApprovedContext} from './socialContentProductionRouting.js';
import {socialContentMaterialAnalysisInputs} from './socialContentMaterialAnalysisInputs.js';
import {taskProductionAssets} from './socialContentAutoProduction.js';
import type {PresenterExecutionSelection} from './socialContentPresenterExecutionPolicy.js';
import type {Starter198Repository} from './repository.js';
import type {readSocialTaskDetail} from './socialContentRecords.js';
import {socialRequestHash} from './socialContentValidation.js';

type ProductionTaskDetail=NonNullable<Awaited<ReturnType<typeof readSocialTaskDetail>>>;

/** Resolve the reviewed material plan before budget allocation or supplier submission. */
export async function prepareSocialProductionMaterialRouting(input:{
  repository:Starter198Repository;
  tenantId:string;
  taskId:string;
  runId:string;
  runtime?:{loadProductionAssets?:typeof taskProductionAssets};
  graphApprovedContext?:{version:string;assetSupplyPlan?:SocialAssetSupplyPlan|null};
  detail:ProductionTaskDetail;
  agentWorkflow:NonNullable<ProductionTaskDetail['agentWorkflow']>;
  presenterExecutions:PresenterExecutionSelection[];
  productionApproach:NonNullable<ProductionTaskDetail['brief']['productionApproach']>;
  usesTypeAwareRouting:boolean;
  canonicalTypeAwareSupplyPlan:SocialAssetSupplyPlan|null|undefined;
  outputDir:string;
}){
  const {detail,agentWorkflow,presenterExecutions,productionApproach,usesTypeAwareRouting,canonicalTypeAwareSupplyPlan,outputDir}=input;
	  const productionMode = detail.brief.productionMode ?? 'concept_preview';
	  const paidVisualProvidersAllowed = productionApproach === 'ai_enhanced';
	  const zeroAssetRoute = detail.assetSupplyPlan?.productionRoute === 'zero_asset_generation';
	  const selectedSupplyPlan = detail.assetSupplyPlan
	    ? assetSupplyPlanWithExecutionSelections(detail.assetSupplyPlan, agentWorkflow)
	    : null;
	  let reviewedSupplyPlan = selectedSupplyPlan && detail.brief.materialRoutingPolicyVersion==='type-aware.v1'
	    && !isInternalBudgetExemptTenant(input.tenantId)
	    ? applyPresenterFirstBudgetDegradation({plan:selectedSupplyPlan,workflow:agentWorkflow,
	      maximumCny:Math.min(10,Number(detail.brief.perItemBudgetCny)||10)})
	    : selectedSupplyPlan;
    if(reviewedSupplyPlan){
      reviewedSupplyPlan={...reviewedSupplyPlan,shots:reviewedSupplyPlan.shots.map(shot=>{
        const selected=presenterExecutions.find(item=>item.sceneId===shot.shotId&&item.providerId==='seedance'&&item.executionStatus==='ready');
        if(!selected)return shot;
        if(!shot.digitalHumanPlan||selected.decision.measurements.lipSyncRequired!==false
          ||typeof selected.decision.measurements.visibleSpeechSeconds!=='number'
          ||selected.decision.measurements.visibleSpeechSeconds>=.5)throw Error(`seedance_presenter_speech_contract_not_supported:${shot.shotId}`);
        return {...shot,
          ...(selected.enterpriseProductAssetLock?{enterpriseProductAssetLock:structuredClone(selected.enterpriseProductAssetLock)}:{}),
          digitalHumanPlan:{...shot.digitalHumanPlan,method:'reenact' as const,silentMotion:true}};
      })};
      reviewedSupplyPlan=assetSupplyPlanWithDynamicPresenterBackgroundLocks({plan:reviewedSupplyPlan,selections:presenterExecutions,
        referenceReuse:detail.brief.referenceReuse,referenceAnalysis:detail.referenceVideoAnalysis,
        scenes:agentWorkflow.directorBrief.scenes});
    }
	  const rawAssets = await (input.runtime?.loadProductionAssets ?? taskProductionAssets)({
	    tenantId: input.tenantId,
	    sources: detail.sources,
	    productRef: detail.brief.productRef,
	    themeId: detail.theme?.themeId ?? null,
	    productionMode,
	    outputDirectory: outputDir,
	    allowAuthorizedSharedLibrary: paidVisualProvidersAllowed,
	    materialLibrary: input.repository.materialLibrary,
	    requiredMaterialIds: usesTypeAwareRouting
	      ? [...new Set([...typeAwareRequiredMaterialIds(reviewedSupplyPlan),
	          ...(input.graphApprovedContext?.version===detail.version?typeAwareRequiredMaterialIds(input.graphApprovedContext.assetSupplyPlan??null):[])])] : undefined,
	    selectedMaterialSegments: reviewedSupplyPlan?.shots.flatMap(shot=>shot.selectedMaterialSegment?[shot.selectedMaterialSegment]:[]) ?? [],
	    productFootageStore: input.repository.dataStore,
	  }).catch(error => {
	    if (zeroAssetRoute && !(error instanceof Error && error.message.startsWith('product_footage_'))) return [];
	    throw error;
	  });
    if(detail.brief.materialRoutingPolicyVersion!=='type-aware.v2'&&reviewedSupplyPlan&&input.graphApprovedContext?.version===detail.version&&input.graphApprovedContext.assetSupplyPlan){
      const rebound=rebindDivergentLocalRoutesFromApprovedContext({plan:reviewedSupplyPlan,approved:input.graphApprovedContext.assetSupplyPlan,assets:rawAssets});
      reviewedSupplyPlan=rebound.plan;
      if(rebound.rebindings.length){
        const evidence={schemaVersion:'social-local-route-rebinding.v1',tenantId:input.tenantId,taskId:input.taskId,runId:input.runId,
          approvedVersion:detail.version,rebindings:rebound.rebindings,planHash:socialRequestHash(rebound.plan)};
        const evidenceRoot=path.resolve('data/social-content-material-rebindings');
        await fsp.mkdir(evidenceRoot,{recursive:true,mode:0o700});
        await fsp.writeFile(path.join(evidenceRoot,`${socialRequestHash([input.tenantId,input.taskId,input.runId])}.json`),
          JSON.stringify({...evidence,evidenceHash:socialRequestHash(evidence)},null,2),{mode:0o600});
      }
    }
    if(usesTypeAwareRouting&&detail.brief.materialRoutingPolicyVersion!=='type-aware.v2'){
      if(!reviewedSupplyPlan)throw Error('type_aware_execution_plan_missing');
      assertCompleteTypeAwareExecutionPlan(reviewedSupplyPlan,canonicalTypeAwareSupplyPlan?.shots.map(shot=>shot.shotId));
    }
	  // Budget preparation and later alignment may project or normalize the plan.
	  // Product generation must retain the exact reviewed routing/spec snapshot
	  // that admitted this run, rather than closing over an object that another
	  // stage can mutate while the adapters execute.
	  // Analyze only assets that the reviewed execution can consume. Scanning an
	  // unrelated tenant video can add minutes, provider cost, and make a bad
	  // legacy timeline block a production that never selected that material.
	  let materialInputs = socialContentMaterialAnalysisInputs({assets: rawAssets, plan: reviewedSupplyPlan,
      policyVersion: detail.brief.materialRoutingPolicyVersion});

  return {productionMode,paidVisualProvidersAllowed,rawAssets,reviewedSupplyPlan,materialInputs};
}
