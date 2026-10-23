import type {SocialAssetSupplyPlan, SocialContentTaskDetail} from '../../shared/contracts/socialContentWorkflow.js';

type BudgetRouteCandidate = NonNullable<SocialContentTaskDetail['agentWorkflow']>['executionPlan']['scenes'][number]['candidates'][number];

function localProductFallbackRank(candidate: BudgetRouteCandidate, requestedProductRef: string, minimumDurationSeconds: number) {
  const segment=candidate.materialSegments?.[0];
  if (candidate.kind !== 'asset' || candidate.dataTransfer !== 'local_only' || !candidate.sourceRef || !segment
    || !segment.segmentId?.trim() || !Number.isFinite(segment.startSeconds) || !Number.isFinite(segment.endSeconds)
    || segment.startSeconds < 0 || segment.endSeconds <= segment.startSeconds
    || segment.endSeconds-segment.startSeconds+1e-6<minimumDurationSeconds) return null;
  const roles = new Set(candidate.materialRoles ?? []);
  const normalizedProduct = String(candidate.productRef || candidate.productId || '').normalize('NFKC').trim().toLocaleLowerCase();
  const exactProduct = Boolean(requestedProductRef && normalizedProduct === requestedProductRef);
  const tier = exactProduct ? 0
    : roles.has('product') || Boolean(normalizedProduct) ? 2
      : roles.has('factory') ? 3 : 4;
  const sourceTier = tier===0 ? 'product_high_fidelity_local' as const : tier===2 ? 'product_local' as const
    : tier===3 ? 'factory_local' as const : 'other_local' as const;
  return {candidate,tier,sourceTier,score:candidate.enterpriseOwnershipScore * 4 + candidate.semanticScore * 3
    + candidate.actionAndShotScore * 2 + candidate.qualityScore + candidate.durationFitScore - candidate.repetitionPenalty};
}

/** Legacy v1 budget degradation retained while v2 uses whole-film routing. */
export function applyPresenterFirstBudgetDegradation(input: {
  plan: SocialAssetSupplyPlan;
  workflow: NonNullable<SocialContentTaskDetail['agentWorkflow']>;
  maximumCny: number;
}): SocialAssetSupplyPlan {
  const maximumCny = Math.max(0, Math.min(10, Number(input.maximumCny) || 0));
  const scenes = new Map(input.workflow.executionPlan.scenes.map(scene => [scene.sceneId, scene]));
  const durationByScene=new Map(input.workflow.directorBrief.scenes.map(scene=>[scene.sceneId,
    Math.max(0.001,scene.duration.endSeconds-scene.duration.startSeconds)]));
  const calculatedFixedNonProductCost = input.workflow.executionPlan.scenes
    .filter(scene => input.plan.shots.find(shot=>shot.shotId===scene.sceneId)?.materialRouting?.materialType !== 'product')
    .reduce((sum, scene) => sum + Math.max(0, Number(scene.estimatedCostCny) || 0), 0);
  const hasPresenter=input.plan.shots.some(shot=>shot.sourceStrategy==='authorized_digital_presenter');
  const fixedNonProductCost=Math.max(calculatedFixedNonProductCost,hasPresenter?maximumCny:0);
  let remaining = Math.max(0, maximumCny - fixedNonProductCost);
  const allLocalCandidates = input.workflow.executionPlan.scenes.flatMap(scene=>scene.candidates);
  const assetUseCount=new Map<string,number>(),segmentUseCount=new Map<string,number>();
  const usage=(value:ReturnType<typeof localProductFallbackRank>)=>value?{
    asset:assetUseCount.get(value.candidate.sourceRef!)??0,
    segment:segmentUseCount.get(`${value.candidate.sourceRef}:${value.candidate.materialSegments![0]!.segmentId}`)??0}: {asset:0,segment:0};
  const recordUse=(value:NonNullable<ReturnType<typeof localProductFallbackRank>>)=>{
    const asset=value.candidate.sourceRef!,segment=value.candidate.materialSegments![0]!.segmentId;
    assetUseCount.set(asset,(assetUseCount.get(asset)??0)+1);
    segmentUseCount.set(`${asset}:${segment}`,(segmentUseCount.get(`${asset}:${segment}`)??0)+1);
  };
  return {
    ...structuredClone(input.plan),
    shots: input.plan.shots.map(original => {
      const shot = structuredClone(original);
      const scene = scenes.get(shot.shotId);
      if (!scene) return shot;
      if(shot.sourceStrategy==='authorized_digital_presenter')return shot;
      const requiredDuration=durationByScene.get(shot.shotId)??Math.max(0.001,Number(shot.materialRouting?.generation?.durationSeconds)||3);
      if(shot.materialRouting&&shot.materialRouting.materialType!=='product'&&shot.materialRouting.localMatch.state==='missing'){
        const wantedRole=shot.materialRouting.materialType==='factory'?'factory':shot.materialRouting.materialType==='consumer_demo'?'person_usage':null;
        const candidates=allLocalCandidates.map(candidate=>{
          const ranked=localProductFallbackRank(candidate,'',requiredDuration);if(!ranked)return null;
          const roles=new Set(candidate.materialRoles??[]),rolePenalty=wantedRole&&!roles.has(wantedRole)?1:0;
          return{...ranked,rolePenalty};
        }).filter((value):value is NonNullable<typeof value>=>Boolean(value))
          .sort((a,b)=>a.rolePenalty-b.rolePenalty||usage(a).asset-usage(b).asset||usage(a).segment-usage(b).segment
            ||b.score-a.score||a.candidate.candidateId.localeCompare(b.candidate.candidateId));
        const selected=candidates[0];
        if(selected){recordUse(selected);const segment=selected.candidate.materialSegments![0]!;return{...shot,sourceStrategy:'customer_real_asset',fallbackSourceStrategy:null,
          sourceRefs:[selected.candidate.sourceRef!],selectedMaterialSegment:{sourceRef:selected.candidate.sourceRef!,segmentId:segment.segmentId,startSeconds:segment.startSeconds,endSeconds:segment.endSeconds},
          materialRouting:{...shot.materialRouting,policy:'local_only',localMatch:{state:'matched',sourceRefs:[selected.candidate.sourceRef!],sourceTier:selected.sourceTier,evidenceRef:`execution-plan:${input.workflow.executionPlan.executionPlanId}:candidate:${selected.candidate.candidateId}`},generation:undefined},
          productionInstruction:`预算与可执行性降级：采用本地真实视频 ${selected.candidate.label}，保持本镜头原顺序、时长和表达功能。`,feasibility:'functional_equivalent',feasibilityReason:'原路线缺少可执行候选；已从全片本地候选池选择可覆盖时长的真实视频。'};}
      }
      if (shot.materialRouting?.materialType !== 'product') return shot;
      const requestedProductRef = String(shot.productSceneReplication?.productIdentity.groups[0]?.productRef
        || shot.materialRouting.generation?.productImageRefs[0] || '').normalize('NFKC').trim().toLocaleLowerCase();
      const sceneLocal = scene.candidates.map(candidate => localProductFallbackRank(candidate, requestedProductRef,requiredDuration))
        .filter((value): value is NonNullable<typeof value> => Boolean(value))
        .sort((a,b)=>a.tier-b.tier||usage(a).asset-usage(b).asset||usage(a).segment-usage(b).segment
          ||b.score-a.score||a.candidate.candidateId.localeCompare(b.candidate.candidateId));
      const local = sceneLocal.length ? sceneLocal : allLocalCandidates.map(candidate=>localProductFallbackRank(candidate,'',requiredDuration))
        .filter((value):value is NonNullable<typeof value>=>Boolean(value))
        .sort((a,b)=>a.tier-b.tier||usage(a).asset-usage(b).asset||usage(a).segment-usage(b).segment
          ||b.score-a.score||a.candidate.candidateId.localeCompare(b.candidate.candidateId));
      const exact = sceneLocal.find(value => value.tier === 0);
      const paid = scene.candidates.find(candidate => candidate.kind === 'capability'
        && candidate.sourceStrategy === 'aigc_product_scene_replication');
      const duration=Math.max(0.1,Number(shot.materialRouting.generation?.durationSeconds
        || shot.productSceneReplication?.cameraLock?.durationSeconds || 3));
      const formalProductFloor=0.22+0.15*duration+0.05;
      const paidCost = Math.max(0.67,formalProductFloor,Number(paid?.estimatedCostCny) || Number(scene.estimatedCostCny) || 0);
      const selected = exact?.candidate ?? (paid && paidCost <= remaining ? paid : local[0]?.candidate);
      if (!selected) return shot;
      if (selected.kind === 'capability' && selected.sourceStrategy === 'aigc_product_scene_replication') {
        remaining = Math.max(0, remaining - paidCost);
        return shot;
      }
      const ranked=local.find(value=>value.candidate.candidateId===selected.candidateId)!;
      recordUse(ranked);
      const segment = selected.materialSegments![0]!;
      const replacement:SocialAssetSupplyPlan['shots'][number]={
        ...shot,
        sourceStrategy: 'customer_real_asset',
        fallbackSourceStrategy: null,
        sourceRefs: [selected.sourceRef!],
        selectedMaterialSegment: {sourceRef:selected.sourceRef!,segmentId:segment.segmentId,
          startSeconds:segment.startSeconds,endSeconds:segment.endSeconds},
        productSceneReplication: undefined,
        materialRouting: {...shot.materialRouting,policy:'local_first_product_i2v',
          localMatch:{state:'matched',sourceRefs:[selected.sourceRef!],sourceTier:ranked.sourceTier,evidenceRef:`execution-plan:${input.workflow.executionPlan.executionPlanId}:candidate:${selected.candidateId}`},
          generation: undefined},
        productionInstruction: `预算自动降级：采用本地素材候选 ${selected.label}，保持本镜头原顺序、起止时间和表达功能。`,
        feasibility: 'functional_equivalent',
        feasibilityReason: '数字人口播预算已优先保留；本镜头按产品素材降级顺序选用可执行本地素材。',
      };
      return replacement;
    }),
  };
}
