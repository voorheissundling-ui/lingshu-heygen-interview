import type { WeeklyMaterialEvidenceRequirements, WeeklyMaterialEvidenceConfiguration } from '../../shared/contracts/socialProgram.js';
import type { SocialInspirationHandoff } from '../../shared/contracts/socialContentWorkflow.js';
import { socialRequestHash } from '../starter198/socialContentValidation.js';
type Scope = WeeklyMaterialEvidenceRequirements['scope'];
type Ref = NonNullable<WeeklyMaterialEvidenceRequirements['handoffRef']>;
/** Classifies actual source requirements, not invented shots. Uncertain evidence must be explicitly configured. */
export function classifyMaterialEvidence(input:{scope:Scope;handoff?:SocialInspirationHandoff|null;handoffRef?:Ref|null;configuration?:WeeklyMaterialEvidenceConfiguration|null}):WeeklyMaterialEvidenceRequirements {
 if(!input.scope.packageId?.trim()||!input.scope.slotId?.trim()||!Number.isSafeInteger(input.scope.packageVersion)||input.scope.packageVersion<1)throw Error('material_evidence_scope_invalid');
 const h=input.handoff;const ref=input.handoffRef;
 const valid=Boolean(h&&ref&&h.inspirationId===ref.inspirationId&&String(h.version??h.analysisVersion)===ref.version&&socialRequestHash(h)===ref.recordHash&&h.readiness==='production_reference'&&h.rights?.mayAnalyze===true&&h.rights?.mayAdapt===true
 &&Array.isArray(h.productionImplications?.requiredEvidence)&&Array.isArray(h.productionImplications?.likelyAssetNeeds)&&[...h.productionImplications.requiredEvidence,...h.productionImplications.likelyAssetNeeds].every(v=>typeof v==='string'&&v.trim())
 &&h.adaptationBoundary&&['reusable','mustReplace','prohibited'].every(k=>Array.isArray(h.adaptationBoundary[k as keyof typeof h.adaptationBoundary])&&h.adaptationBoundary[k as keyof typeof h.adaptationBoundary].every(v=>typeof v==='string')));
 const source=valid?structuredClone({requiredEvidence:h!.productionImplications.requiredEvidence,likelyAssetNeeds:h!.productionImplications.likelyAssetNeeds,adaptationBoundary:h!.adaptationBoundary}):null;
 const items:WeeklyMaterialEvidenceRequirements['items']=[];
 if(source) for(const field of ['requiredEvidence','likelyAssetNeeds'] as const) source[field].forEach((description,index)=>{
  const human= /不可替代|必须.{0,8}(?:真人|实拍|真实)|(?:工厂|产品|客户|检测|证书|认证|案例|人物|肖像|授权|实测|生产线|包装).{0,12}(?:真实性|真实|证据|证明|实拍)|(?:真实|实拍).{0,12}(?:工厂|产品|客户|人物|生产)/i.test(description);
  // Explicitly decorative and non-evidentiary only; factual requirements never gain an AI fallback from keywords.
  const generated=field==='likelyAssetNeeds'&&!human&&/非证据|不作为.{0,6}(?:证据|证明)|纯装饰/.test(description)&&/AI|动画|动效|图形|背景/i.test(description)&&!source.adaptationBoundary.prohibited.some(boundary=>/AI|生成|动画/i.test(boundary));
  const classification=human?'human_irreplaceable':generated?'generatable_non_evidentiary':'unknown';
  items.push({requirementId:socialRequestHash({ref,field,index,description}).slice(0,15),sourceField:field,sourceIndex:index,description,classification,reason:human?'真实主体或不可替代证据，需要实际素材及核验':generated?'来源明确限定为非证据装饰视觉':'来源未明确替代边界，需逐项确认素材性质'});
 });
 if(!items.length)items.push({requirementId:socialRequestHash({missing:true}).slice(0,15),sourceField:'missing_handoff',sourceIndex:0,description:'缺少可核验的逐项素材需求分析',classification:'unknown',reason:'不能从空需求推断无需真人证据'});
 const configuration=input.configuration;
 if(configuration){const {recordHash,...configurationPayload}=configuration;
  if(!valid||socialRequestHash(configurationPayload)!==recordHash||socialRequestHash(configuration.scope)!==socialRequestHash(input.scope)||socialRequestHash(configuration.handoffRef)!==socialRequestHash(ref)||!Number.isSafeInteger(configuration.version)||configuration.version<1||!configuration.configurationId||!configuration.configuredBy||!Number.isFinite(Date.parse(configuration.configuredAt))||!Array.isArray(configuration.decisions)||!configuration.decisions.length||new Set(configuration.decisions.map(d=>d.requirementId)).size!==configuration.decisions.length)throw Error('material_evidence_configuration_invalid');
  for(const decision of configuration.decisions){const item=items.find(i=>i.requirementId===decision.requirementId);if(!item||item.classification!=='unknown'||decision.classification!=='human_irreplaceable'||!decision.reason?.trim()||!decision.shotUsage?.trim())throw Error('material_evidence_configuration_boundary_invalid');item.classification='human_irreplaceable';item.reason=`明确要求真实素材：${decision.reason}；镜头用途：${decision.shotUsage}`;}
 }
 const payload={...(configuration?{configurationRef:{id:configuration.configurationId,version:configuration.version,recordHash:configuration.recordHash}}:{}),schemaVersion:'weekly-material-evidence.v1' as const,scope:structuredClone(input.scope),handoffRef:valid?structuredClone(ref!):null,source,items};return {...payload,recordHash:socialRequestHash(payload)};
}
export function verifyMaterialEvidenceRequirements(value:WeeklyMaterialEvidenceRequirements|undefined,scope:Scope,frozenHandoffRefs:Ref[],actualHandoff?:SocialInspirationHandoff|null,configuration?:WeeklyMaterialEvidenceConfiguration|null):boolean {
 if(!scope.packageId?.trim()||!scope.slotId?.trim())return false;
 if(!value||value.schemaVersion!=='weekly-material-evidence.v1'||!Number.isSafeInteger(scope.packageVersion)||scope.packageVersion<1||socialRequestHash(value.scope)!==socialRequestHash(scope)||!Array.isArray(value.items)||!value.items.length)return false;
 const {recordHash,...payload}=value;if(recordHash!==socialRequestHash(payload))return false;
 if(!value.handoffRef)return value.source===null&&value.items.every(item=>item.classification==='unknown'&&item.sourceField==='missing_handoff');
 if(!actualHandoff||socialRequestHash(actualHandoff)!==value.handoffRef.recordHash)return false;
 if(value.configurationRef&&(!configuration||configuration.configurationId!==value.configurationRef.id||configuration.version!==value.configurationRef.version||configuration.recordHash!==value.configurationRef.recordHash))return false;
 if(!value.configurationRef&&configuration)return false;
 let expected:WeeklyMaterialEvidenceRequirements;try{expected=classifyMaterialEvidence({scope,handoff:actualHandoff,handoffRef:value.handoffRef,configuration});}catch{return false;}
 if(expected.recordHash!==value.recordHash)return false;
 if(!value.source||!frozenHandoffRefs.some(ref=>socialRequestHash(ref)===socialRequestHash(value.handoffRef)))return false;
 return value.items.every(item=>['human_irreplaceable','generatable_non_evidentiary','unknown'].includes(item.classification)&&item.sourceField!=='missing_handoff'&&value.source![item.sourceField]?.[item.sourceIndex]===item.description);
}
export function materialEvidenceRequiresConfiguration(value:WeeklyMaterialEvidenceRequirements):boolean {return value.items.some(item=>item.classification!=='generatable_non_evidentiary');}
