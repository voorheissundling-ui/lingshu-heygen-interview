import type {DataStore, Record_} from '../storage/datastore.js';
import {socialRequestHash} from '../starter198/socialContentValidation.js';
import {readMaterialLibrary, type MaterialRecord} from '../lib/materialLibrary.js';
import {readWeeklyProductionVoice} from '../starter198/socialContentBoundPresenterVoice.js';
import {readTrustedHeyGenRuntimeBinding, heyGenRuntimeRouteEvidence} from '../starter198/socialContentHeyGenRuntimeBinding.js';
import type {CandidateContextAssessment} from './candidateContextAssessment.js';
import {readCandidateSemanticAssessment, type CandidateSemanticAssessment} from './candidateSemanticAssessment.js';
import {buildSocialWorkflowMaterialCandidates} from '../starter198/socialContentRecords.js';
import {materialRoutingRequests} from '../starter198/socialContentMaterialRoutingRequests.js';
import {normalizeSceneVisualContract} from '../../shared/sceneVisualContract.js';
import {readTenantMaterialBytes} from '../lib/sentenceReplicationProduction.js';
import {createHash} from 'node:crypto';

export const CANDIDATE_TRANSFERABILITY_ASSESSMENTS = 'social_candidate_transferability_assessments';

export type CandidateTargetShotMapping = {
  shotIndex: number;
  route: 'enterprise_product_still';
  productId: string;
  imageId: string;
  factRef: string;
} | {
  shotIndex: number;
  route: 'bound_digital_presenter';
  pipeline: 'heygen' | 'seedance';
  /** A dense, byte-bound temporal classification is required before this
   * route can be admitted. A text label or asset registration is not proof. */
  temporalEvidenceRef: string;
} | {
  shotIndex: number;
  route: 'owned_local_video_segment';
  materialType: 'factory' | 'product' | 'consumer_demo';
  assetId: string;
  segmentId: string;
  sourceRevision: string;
  productId?: string;
  imageId?: string;
  factRef?: string;
};

type MaterialHash = {shotIndex:number; imageId:string; contentSha256:string; assetId?:never; segmentId?:never; sourceRevision?:never}
  | {shotIndex:number; assetId:string; segmentId:string; sourceRevision:string; contentSha256:string; imageId?:never};

export interface CandidateTransferabilityAssessment {
  schema: 'candidate-transferability-assessment.v1';
  assessmentId: string;
  tenantId: string;
  candidateId: string;
  contextHash: string;
  semanticAssessmentId: string;
  mapping: CandidateTargetShotMapping[];
  materialHashes: MaterialHash[];
  presenterAssetId: string;
  presenterVersion: number;
  presenterRouteEvidenceRef: string;
  voiceFingerprint: string;
  state: 'assessed';
  recordHash: string;
}

type Ports = {
  materials?: (tenantId:string)=>Promise<{items:MaterialRecord[];status:string}>;
  materialBytes?: typeof readTenantMaterialBytes;
  livePresenter?: typeof readTrustedHeyGenRuntimeBinding;
  privateAssetTenantId?: ()=>string|undefined;
};
const factKey=(fact:{ref:{type:string;id:string;version:number}})=>`${fact.ref.type}:${fact.ref.id}@${fact.ref.version}`;

/** A semantic score cannot attest to the target enterprise's production
 * resources. This is a separate, no-model, no-paid, exact shot-to-resource
 * proof. Moving non-presenter shots require owned, analyzed, rights-cleared
 * local video segments; a product photo is never an action surrogate. */
async function verify(input:{store:DataStore;context:CandidateContextAssessment;semantic:CandidateSemanticAssessment;mapping:CandidateTargetShotMapping[];presenterAssetId:string;ports?:Ports}) {
  const {store,context,semantic,mapping,presenterAssetId}=input;
  const contextRow=await store.getById<Record_>('social_candidate_context_assessments',context.assessmentId);
  if(!contextRow||contextRow.tenant_id!==context.tenantId||contextRow.record_hash!==context.recordHash||context.recordHash!==socialRequestHash({...context,recordHash:''})||socialRequestHash(contextRow.payload)!==socialRequestHash(context))throw Error('candidate_transferability_context_unverified');
  const recordedSemantic=await readCandidateSemanticAssessment(store,context);
  if(!recordedSemantic||recordedSemantic.assessmentId!==semantic.assessmentId||recordedSemantic.recordHash!==semantic.recordHash)throw Error('candidate_transferability_semantic_unverified');
  if(semantic.tenantId!==context.tenantId||semantic.candidateId!==context.candidateId||semantic.contextHash!==context.recordHash||semantic.dimensions.relevance.state!=='assessed'||semantic.dimensions.relevance.value===null||semantic.dimensions.relevance.value<0.7)throw Error('candidate_transferability_semantic_relevance_required');
  if(!Array.isArray(mapping)||mapping.length!==context.observations.length||!mapping.length||new Set(mapping.map(m=>m.shotIndex)).size!==mapping.length)throw Error('candidate_transferability_complete_mapping_required');
  // The credential may exist for another enterprise. Check its explicit local
  // private-asset owner before touching any remote inventory or supplier API.
  const privateTenant=input.ports?.privateAssetTenantId?input.ports.privateAssetTenantId():process.env.HEYGEN_PRIVATE_ASSET_TENANT_ID;
  if(privateTenant!==context.tenantId)throw Error('candidate_transferability_provider_tenant_binding_required');
  const profiles=await store.list<Record_>('tenant_profiles',{where:{tenant_id:context.tenantId},perPage:2});
  if(profiles.totalItems!==1||profiles.items.length!==1)throw Error('candidate_transferability_enterprise_profile_unverified');
  const rawProfile=profiles.items[0]!.profile;
  const profile=typeof rawProfile==='string'?JSON.parse(rawProfile):rawProfile;
  const products=Array.isArray(profile?.products?.items)?profile.products.items:[];
  const inventory=await (input.ports?.materials??(async tenantId=>readMaterialLibrary(tenantId,{dataStore:store})))(context.tenantId);
  if(inventory.status!=='ready')throw Error('candidate_transferability_inventory_unavailable');
  const materialHashes:CandidateTransferabilityAssessment['materialHashes']=[];
  const usedSegments=new Set<string>();
  const productImage=(target:{productId:string;imageId:string;factRef:string},shotIndex:number)=>{
    const product=products.find((p:Record<string,unknown>,i:number)=>String(p.id||p.productId||p.sku||`product-${i}`)===target.productId);
    if(!product||!context.productFacts.some(f=>factKey(f)===target.factRef&&f.statement.trim()===String(product.name||'').trim()))throw Error('candidate_transferability_product_fact_unverified');
    const matches=inventory.items.filter(item=>item.id===target.imageId);
    if(matches.length!==1)throw Error('candidate_transferability_image_missing_or_ambiguous');
    const image=matches[0]!;
    if(image.tenantId!==context.tenantId||image.productId!==target.productId||image.scope!=='own'||image.type!=='image'||image.sourceType!=='enterprise_product_table'||image.rightsStatus!=='authorized'||image.commercialUseApproved!==true||!String(image.rightsEvidenceRef||'').trim()||!/^[a-f0-9]{64}$/.test(String(image.contentSha256||'')))throw Error('candidate_transferability_product_image_unverified');
    return {shotIndex,imageId:target.imageId,contentSha256:String(image.contentSha256)};
  };
  for(const observation of context.observations){
    const target=mapping.find(m=>m.shotIndex===observation.shotIndex);
    if(!target)throw Error('candidate_transferability_shot_route_unproven');
    const observed=`${observation.observedFacts} ${observation.visual}`;
    if(target.route==='bound_digital_presenter'){
      if(observation.materialType!=='talking_head'||!target.temporalEvidenceRef.trim())throw Error('candidate_transferability_presenter_temporal_proof_required');
      // The candidate context contains only prose and a coarse material type.
      // It does not yet carry a complete, signed dense-frame classification
      // or a certified Seedance lip-sync execution route. Fail closed until
      // that original-shot proof can be read and bound here.
      throw Error('candidate_transferability_presenter_temporal_proof_required');
    }
    if(target.route==='enterprise_product_still'){
      if(observation.materialType!=='product'||/动作|涂抹|使用|喷|开盖|倒|挤|演示|手部|人物|工厂|生产|motion|action|apply|spray|factory|person|hand/i.test(observed))throw Error('candidate_transferability_shot_route_unproven');
      materialHashes.push(productImage(target,target.shotIndex));
      continue;
    }
    if(target.route!=='owned_local_video_segment'||observation.materialType!==target.materialType||!String(observed).trim())throw Error('candidate_transferability_shot_route_unproven');
    const segmentKey=`${target.assetId}\0${target.segmentId}`;
    if(usedSegments.has(segmentKey))throw Error('candidate_transferability_segment_reused');
    usedSegments.add(segmentKey);
    if(target.materialType!=='factory'){
      if(!target.productId||!target.imageId||!target.factRef)throw Error('candidate_transferability_product_binding_required');
      if(target.materialType==='product'&&!/动作|运动|旋转|移动|推进|平移|手持|拿取|晃|展示|motion|move|rotate|pan|push|hold|hand/i.test(observed))throw Error('candidate_transferability_action_observation_required');
      if(target.materialType==='consumer_demo'&&!/使用|涂抹|挤|喷|开盖|操作|演示|效果|use|apply|spray|dispense|open|demo|result/i.test(observed))throw Error('candidate_transferability_action_observation_required');
      materialHashes.push(productImage({productId:target.productId,imageId:target.imageId,factRef:target.factRef},target.shotIndex));
    }
    const records=inventory.items.filter(item=>item.id===target.assetId);
    if(records.length!==1)throw Error('candidate_transferability_video_missing_or_ambiguous');
    const record=records[0]!;
    if(record.tenantId!==context.tenantId||record.scope!=='own'||record.type!=='video'||!/^[a-f0-9]{64}$/.test(String(record.contentSha256||'')))throw Error('candidate_transferability_video_unverified');
    const candidates=buildSocialWorkflowMaterialCandidates({records:[record],tenantId:context.tenantId,voiceoverRows:[],selectedProductId:target.productId??null,selectedProductRef:target.productId?`product:${target.productId}`:null}).candidates;
    const exact=candidates.filter(candidate=>candidate.assetId===target.assetId&&candidate.segmentId===target.segmentId&&candidate.mediaType==='video'&&candidate.segmentProfile?.sourceRevision===target.sourceRevision&&candidate.segmentProfile.productionEligible);
    if(exact.length!==1)throw Error('candidate_transferability_video_segment_unverified');
    const clip=exact[0]!;
    const held=target.materialType==='product'&&/手持|手握|拿取|hand.?held|hold|grip/i.test(observed);
    const visual=normalizeSceneVisualContract({subjects:target.materialType==='factory'?['factory']:target.materialType==='product'&&!held?['product']:['person','product'],interaction:{kind:target.materialType==='factory'?'factory_process':target.materialType==='product'?(held?'person_holding_product':'product_motion'):'person_using_product',description:observed},action:{path:observed},productRef:target.productId?`product:${target.productId}`:null,productPolicy:target.productId?'locked':'open'});
    const range=String(observation.time).split('-').map(Number),duration=range.length===2&&Number.isFinite(range[0])&&Number.isFinite(range[1])&&range[1]!>range[0]!?range[1]!-range[0]!:Number.NaN;
    if(!Number.isFinite(duration))throw Error('candidate_transferability_time_unverified');
    const routed=materialRoutingRequests({policyVersion:'type-aware.v2',tenantId:context.tenantId,productRef:target.productId?`product:${target.productId}`:null,shots:[{shotId:`candidate:${target.shotIndex}`,function:'demonstration',materialType:target.materialType,requestedDescription:observed,visualContract:visual,plannedDurationSeconds:duration}],candidates:[clip]})[0];
    if(routed?.localVideoMatch?.semanticMatch!=='verified'||routed.selectedMaterialSegment?.sourceRef!==target.assetId||routed.selectedMaterialSegment.segmentId!==target.segmentId)throw Error('candidate_transferability_local_route_unproven');
    const {bytes}=await (input.ports?.materialBytes??readTenantMaterialBytes)(record,context.tenantId);
    if(createHash('sha256').update(bytes).digest('hex')!==record.contentSha256)throw Error('candidate_transferability_video_bytes_changed');
    materialHashes.push({shotIndex:target.shotIndex,assetId:target.assetId,segmentId:target.segmentId,sourceRevision:target.sourceRevision,contentSha256:record.contentSha256});
  }
  const voice=await readWeeklyProductionVoice(store,context.tenantId,[presenterAssetId]);
  // A configured credential is not evidence that its private assets belong to
  // this enterprise. Do not even issue a read-only supplier GET on an unknown
  // account until the existing private-catalog tenant binding is explicit.
  const presenter=await (input.ports?.livePresenter??readTrustedHeyGenRuntimeBinding)({tenantId:context.tenantId,presenterAssetId},{store});
  if(!presenter||!voice.presenters.some(item=>item.id===presenter.presenterAssetId&&item.assetVersion===presenter.assetVersion&&item.voiceId===presenter.voiceId&&item.avatarId===presenter.avatarId)||voice.voiceId!==presenter.voiceId)throw Error('candidate_transferability_presenter_voice_unverified');
  return {materialHashes,presenterVersion:presenter.assetVersion,presenterRouteEvidenceRef:heyGenRuntimeRouteEvidence(presenter),voiceFingerprint:voice.fingerprint};
}

export async function createCandidateTransferabilityAssessment(input:{store:DataStore;context:CandidateContextAssessment;semantic:CandidateSemanticAssessment;mapping:CandidateTargetShotMapping[];presenterAssetId:string;ports?:Ports}):Promise<CandidateTransferabilityAssessment>{
  const proof=await verify(input),{context,semantic}=input;
  const identity={schema:'candidate-transferability-assessment.v1' as const,tenantId:context.tenantId,candidateId:context.candidateId,contextHash:context.recordHash,semanticAssessmentId:semantic.assessmentId,mapping:input.mapping,materialHashes:proof.materialHashes,presenterAssetId:input.presenterAssetId,presenterVersion:proof.presenterVersion,presenterRouteEvidenceRef:proof.presenterRouteEvidenceRef,voiceFingerprint:proof.voiceFingerprint,state:'assessed' as const};
  const assessmentId=socialRequestHash(identity),item:CandidateTransferabilityAssessment={...identity,assessmentId,recordHash:''};item.recordHash=socialRequestHash({...item,recordHash:''});
  const prior=await input.store.getById<Record_>(CANDIDATE_TRANSFERABILITY_ASSESSMENTS,assessmentId);
  if(prior){if(prior.tenant_id!==context.tenantId||prior.record_hash!==item.recordHash)throw Error('candidate_transferability_record_changed');return item;}
  if(!await input.store.create(CANDIDATE_TRANSFERABILITY_ASSESSMENTS,{id:assessmentId,tenant_id:context.tenantId,candidate_id:context.candidateId,context_id:context.assessmentId,record_hash:item.recordHash,payload:item}))throw Error('candidate_transferability_write_unknown');
  return item;
}

/** Only a uniquely matched, motionless product-card reference can be mapped
 * without editorial judgement. Every other route remains a diagnosed gap;
 * the normal assessment writer still re-verifies bytes, rights and live voice. */
export async function createAutomaticCandidateTransferabilityAssessment(input:{store:DataStore;context:CandidateContextAssessment;semantic:CandidateSemanticAssessment;ports?:Ports}):Promise<CandidateTransferabilityAssessment>{
 const {store,context,semantic}=input;
 if(context.productFacts.length!==1||!context.observations.length)throw Error('candidate_transferability_auto_product_ambiguous');
 if(context.observations.some(o=>o.materialType==='talking_head'))throw Error('candidate_transferability_presenter_temporal_proof_required');
 const still=(o:CandidateContextAssessment['observations'][number])=>o.materialType==='product'
  &&String(o.observedFacts).trim().length>0&&String(o.visual).trim().length>0
  &&!/动作|涂抹|使用|喷|开盖|倒|挤|演示|手部|人物|工厂|生产|motion|action|apply|spray|factory|person|hand/i.test(`${o.observedFacts} ${o.visual}`);
 if(!context.observations.every(still))throw Error('candidate_transferability_auto_local_video_required');
 const profiles=await store.list<Record_>('tenant_profiles',{where:{tenant_id:context.tenantId},perPage:2});
 if(profiles.totalItems!==1||profiles.items.length!==1)throw Error('candidate_transferability_auto_profile_unverified');
 const raw=profiles.items[0]!.profile,profile=typeof raw==='string'?JSON.parse(raw):raw;
 const products:Record<string,unknown>[]=Array.isArray(profile?.products?.items)?profile.products.items:[];
 const matching=products.map((p:Record<string,unknown>,i:number)=>({id:String(p.id||p.productId||p.sku||`product-${i}`),name:String(p.name||'')})).filter(p=>p.name.trim()===context.productFacts[0]!.statement.trim());
 if(matching.length!==1)throw Error('candidate_transferability_auto_product_ambiguous');
 const inventory=await (input.ports?.materials??(async tenantId=>readMaterialLibrary(tenantId,{dataStore:store})))(context.tenantId);
 if(inventory.status!=='ready')throw Error('candidate_transferability_auto_inventory_unavailable');
 const images=inventory.items.filter(item=>item.tenantId===context.tenantId&&item.productId===matching[0]!.id&&item.scope==='own'&&item.type==='image'&&item.sourceType==='enterprise_product_table'&&item.rightsStatus==='authorized'&&item.commercialUseApproved===true&&String(item.rightsEvidenceRef||'').trim()&&/^[a-f0-9]{64}$/.test(String(item.contentSha256||'')));
 if(images.length!==1)throw Error('candidate_transferability_auto_image_missing_or_ambiguous');
 const voice=await readWeeklyProductionVoice(store,context.tenantId,[]);
 if(voice.presenters.length!==1)throw Error('candidate_transferability_auto_presenter_ambiguous');
 const fact=context.productFacts[0]!,factRef=`${fact.ref.type}:${fact.ref.id}@${fact.ref.version}`;
 const mapping:CandidateTargetShotMapping[]=context.observations.map(o=>({shotIndex:o.shotIndex,route:'enterprise_product_still',productId:matching[0]!.id,imageId:images[0]!.id,factRef}));
 return createCandidateTransferabilityAssessment({...input,mapping,presenterAssetId:voice.presenters[0]!.id});
}

/** Reverify the current inventory and live supplier binding on every admission
 * read. A historical receipt is not perpetual authority after revocation. */
export async function readCandidateTransferabilityAssessment(input:{store:DataStore;context:CandidateContextAssessment;semantic:CandidateSemanticAssessment;ports?:Ports}):Promise<CandidateTransferabilityAssessment|null>{
  const rows=await input.store.list<Record_>(CANDIDATE_TRANSFERABILITY_ASSESSMENTS,{where:{tenant_id:input.context.tenantId,candidate_id:input.context.candidateId,context_id:input.context.assessmentId},perPage:2});
  if(!rows.totalItems)return null;
  if(rows.totalItems!==1)throw Error('candidate_transferability_assessment_ambiguous');
  const row=rows.items[0]!,item=row.payload as CandidateTransferabilityAssessment;
  if(row.tenant_id!==input.context.tenantId||row.record_hash!==item.recordHash||item.recordHash!==socialRequestHash({...item,recordHash:''})||item.contextHash!==input.context.recordHash||item.semanticAssessmentId!==input.semantic.assessmentId||item.state!=='assessed')throw Error('candidate_transferability_record_changed');
  const proof=await verify({...input,mapping:item.mapping,presenterAssetId:item.presenterAssetId});
  if(socialRequestHash(proof.materialHashes)!==socialRequestHash(item.materialHashes)||proof.presenterVersion!==item.presenterVersion||proof.presenterRouteEvidenceRef!==item.presenterRouteEvidenceRef||proof.voiceFingerprint!==item.voiceFingerprint)throw Error('candidate_transferability_current_resources_changed');
  return item;
}
