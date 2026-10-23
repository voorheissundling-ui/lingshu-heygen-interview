import {createHash} from 'node:crypto';
import type {SocialAssetSupplyPlan, SocialAssetSupplyShotPlan} from '../../shared/contracts/socialContentReplication.js';
import {hasVerifiedSameClassSocialLocalMatch} from '../../shared/socialContentMaterialRouting.js';
import type {SocialContentTaskDetail} from '../../shared/contracts/socialContentTaskContract.js';

export interface SocialWholeFilmRouteQuote {
  maximumCny:number;
  wholeTaskUpperBoundCny:number;
  retainedCny?:number;
  items?:Array<{operationId?:string;stage?:string;shotId?:string|null;upperBoundCny:number;quoteRef:string}>;
}
type Workflow=NonNullable<SocialContentTaskDetail['agentWorkflow']>;
const fail=(reason:string):never=>{throw Error(`user_input_required:whole_film_budget_routing:${reason}`);};
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

function hasLocal(shot:SocialAssetSupplyShotPlan,duration:number){
  const segment=shot.selectedMaterialSegment;
  return hasVerifiedSameClassSocialLocalMatch(shot)&&Boolean(segment&&segment.endSeconds-segment.startSeconds+1e-6>=duration);
}
function eligible(shot:SocialAssetSupplyShotPlan){
  const routing=shot.materialRouting;
  return routing?.materialType==='product'&&['eligible','selected'].includes(routing.productGenerationDecision?.state||'')
    &&Boolean(shot.productSceneReplication&&routing.generation?.productImageRefs.length
      &&routing.generation.method==='enterprise_authored_product_first_frame_i2v'&&routing.generation.videoProvider==='seedance');
}
function localShot(original:SocialAssetSupplyShotPlan,reason:string):SocialAssetSupplyShotPlan{
  const shot=structuredClone(original),routing=shot.materialRouting!;
  shot.sourceStrategy='customer_real_asset';shot.fallbackSourceStrategy=null;
  shot.sourceRefs=[...routing.localMatch.sourceRefs];
  shot.productSceneReplication=undefined;
  shot.digitalHumanPlan=undefined;
  routing.policy='local_only';routing.generation=undefined;
  if(routing.productGenerationDecision)routing.productGenerationDecision={state:'local_only',importance:routing.productGenerationDecision.importance,reason};
  shot.productionInstruction='使用当前分镜已核验的同类本地片段，保持主体、SKU、动作和冻结时长；不跨类补画面。';
  shot.feasibility='functional_equivalent';shot.feasibilityReason=reason;
  return shot;
}
function generationShot(original:SocialAssetSupplyShotPlan,reason:string):SocialAssetSupplyShotPlan{
  const shot=structuredClone(original),routing=shot.materialRouting!;
  shot.sourceStrategy='aigc_product_scene_replication';shot.fallbackSourceStrategy=null;
  shot.digitalHumanPlan=undefined;
  shot.sourceRefs=[...routing.generation!.productImageRefs];
  // Preserve the verified fallback segment as provenance. sourceRefs identify
  // the product images, and the selected generation strategy alone dispatches.
  routing.policy='local_first_product_i2v';
  routing.productGenerationDecision={...routing.productGenerationDecision!,state:'selected',reason};
  shot.feasibility='functional_equivalent';shot.feasibilityReason=reason;
  shot.truthBoundary={...shot.truthBoundary,syntheticVisualAllowed:true,mustNotImplyCustomerReality:true};
  shot.productionInstruction='生成产品镜头：使用本企业产品首帧及Seedance，保留SKU和冻结分镜身份；不得称为真实拍摄。';
  return shot;
}

/** Server-only pre-reservation allocator. Advisory scene prices are deliberately
 * ignored. Every candidate is quoted as a complete deliverable film, including
 * presenters, later processing, retries and retained/unknown historical spend. */
export async function applyPresenterFirstBudgetRouting(input:{plan:SocialAssetSupplyPlan;workflow:Workflow;maximumCny:number;
  quote:(plan:SocialAssetSupplyPlan)=>Promise<SocialWholeFilmRouteQuote>}):Promise<SocialAssetSupplyPlan>{
  if(!Number.isFinite(input.maximumCny)||input.maximumCny<=0)fail('maximum_missing');
  const maximum=Math.min(15,input.maximumCny),original=structuredClone(input.plan),plan=structuredClone(input.plan);
  const scenes=new Map(input.workflow.directorBrief.scenes.map(scene=>[scene.sceneId,scene]));
  if(scenes.size!==original.shots.length||new Set(original.shots.map(s=>s.shotId)).size!==original.shots.length)fail('scene_mapping_invalid');
  const upgrades:string[]=[];
  plan.shots=original.shots.map(shot=>{
    const scene=scenes.get(shot.shotId),duration=scene?scene.duration.endSeconds-scene.duration.startSeconds:NaN;
    if(!Number.isFinite(duration)||duration<=0)fail(`scene_duration_invalid:${shot.shotId}`);
    if(shot.materialRouting?.materialType==='talking_head'){
      if(shot.sourceStrategy!=='authorized_digital_presenter')fail(`presenter_route_invalid:${shot.shotId}`);
      return shot;
    }
    if(hasLocal(shot,duration)){
      if(eligible(shot)&&shot.materialRouting?.productGenerationDecision?.importance==='critical')upgrades.push(shot.shotId);
      return localShot(shot,'真人及必要处理预算优先；采用当前分镜已核验的同类本地素材。');
    }
    if(eligible(shot))return generationShot(shot,'同SKU本地素材缺失，必须对整片真实报价后才能使用允许的产品生成路线。');
    return fail(`local_material_required:${shot.shotId}:${shot.materialRouting?.materialType||'unknown'}`);
  });
  const readQuote=async(candidate:SocialAssetSupplyPlan)=>{
    const q=await input.quote(structuredClone(candidate));
    if(!q||!Number.isFinite(q.maximumCny)||q.maximumCny<=0||!Number.isFinite(q.wholeTaskUpperBoundCny)||q.wholeTaskUpperBoundCny<0
      ||(q.retainedCny!==undefined&&(!Number.isFinite(q.retainedCny)||q.retainedCny<0||q.retainedCny>q.wholeTaskUpperBoundCny))
      ||q.items?.some(item=>!item.quoteRef?.trim()||!Number.isFinite(item.upperBoundCny)||item.upperBoundCny<=0))fail('verified_whole_film_quote_missing');
    for(const shot of candidate.shots.filter(shot=>shot.sourceStrategy==='aigc_product_scene_replication')){
      const items=q.items?.filter(item=>item.shotId===shot.shotId)||[];
      const amount=items.reduce((sum,item)=>sum+item.upperBoundCny,0);
      if(!items.length||!Number.isFinite(amount)||amount<=0||amount>q.wholeTaskUpperBoundCny+1e-6)fail(`verified_product_quote_missing:${shot.shotId}`);
    }
    return {...q,maximumCny:Math.min(maximum,q.maximumCny)};
  };
  let quote=await readQuote(plan);
  if(quote.wholeTaskUpperBoundCny>quote.maximumCny+1e-6)fail(`mandatory_plan_exceeds_budget:${quote.wholeTaskUpperBoundCny}:${quote.maximumCny}`);
  for(const shotId of upgrades){
    const candidate=structuredClone(plan),index=candidate.shots.findIndex(shot=>shot.shotId===shotId);
    candidate.shots[index]=generationShot(original.shots.find(shot=>shot.shotId===shotId)!,'关键产品镜头，在真人和整片必要费用后的真实余量内升级。');
    try{
      const proposed=await readQuote(candidate);
      if(proposed.wholeTaskUpperBoundCny>proposed.maximumCny+1e-6){
        plan.shots[index]!.materialRouting!.productGenerationDecision!.reason='关键产品生成整片报价超过剩余额度，保留同SKU本地素材。';
        continue;
      }
      plan.shots=candidate.shots;quote=proposed;
    }catch(error){
      // Optional quality upgrades must not strand a complete, verified local
      // film. The final admission still requotes/reserves the accepted plan.
      plan.shots[index]!.materialRouting!.productGenerationDecision!.reason=`可选产品升级报价未核验，保留本地素材：${error instanceof Error?error.message:'quote_unavailable'}`;
    }
  }
  const quoteRef=`whole-film-quote:${digest(quote)}`;
  for(const shot of plan.shots)if(shot.materialRouting?.productGenerationDecision?.state==='selected'){
    shot.materialRouting.productGenerationDecision.quoteRef=quoteRef;
    shot.materialRouting.productGenerationDecision.budgetPlanRef=quoteRef;
    const costs=quote.items?.filter(item=>item.shotId===shot.shotId)||[];
    if(costs.length)shot.materialRouting.productGenerationDecision.estimatedCostCny=costs.reduce((sum,item)=>sum+item.upperBoundCny,0);
  }
  return plan;
}
