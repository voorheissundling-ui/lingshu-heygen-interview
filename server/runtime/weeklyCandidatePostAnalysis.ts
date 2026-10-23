import type {DataStore,Record_} from '../storage/datastore.js';
import type {SocialInspirationCollectionRun} from '../../shared/contracts/socialContentWorkflow.js';
import type {WeeklyOperatingPackage} from '../../shared/contracts/socialProgram.js';
import type {WeeklyPreproductionJob} from './weeklyPreproductionProducer.js';
import type {WeeklyPreproductionRetryAttempt} from './weeklyPreproductionRetryAttempts.js';
import {socialJson,socialObject,socialRequestHash} from '../starter198/socialContentValidation.js';
import {readWeeklyCandidateAdmissionSnapshot} from './weeklyCandidateAdmissionSnapshot.js';
import {verifiedWeeklyCandidateMedia} from './weeklyCandidateReassessment.js';
import {createCandidateContextAssessment,readCandidateContextAssessment} from '../socialDiscovery/candidateContextAssessment.js';
import {assessCandidateSemantics,readCandidateSemanticAssessment} from '../socialDiscovery/candidateSemanticAssessment.js';
import {resolveWeeklyCandidateSemanticPaidCall,WEEKLY_CANDIDATE_SEMANTIC_BUDGET_AUTHORIZATIONS} from '../socialDiscovery/weeklyCandidateSemanticBudget.js';
import {readWeeklyPublicationProductSelectionChoices} from '../socialPrograms/weeklyPublicationProductSelection.js';
import {writeWeeklyCandidateReferenceAnalysisHandoff} from './weeklyCandidateReferenceAnalysisHandoff.js';
import {createAutomaticCandidateTransferabilityAssessment} from '../socialDiscovery/candidateTransferabilityAssessment.js';
import {advanceWeeklyCandidateExactAnalysis,type WeeklyCandidateExactAnalysisPorts,verifiedWeeklyCandidateCanonicalMedia} from './weeklyCandidateExactAnalysisOperation.js';
import {advanceWeeklyCandidateCanonicalMedia,type WeeklyCandidateCanonicalMediaPorts,type VerifiedDatasetDirectMediaBinding} from './weeklyCandidateCanonicalMedia.js';
import type {VerifiedRunKvMediaBinding} from '../socialDiscovery/apifyRunKvMedia.js';

export const WEEKLY_CANDIDATE_POSTANALYSIS_PROGRESS='social_weekly_candidate_postanalysis_progress';
type Job=WeeklyPreproductionJob|WeeklyPreproductionRetryAttempt;
export interface WeeklyCandidatePostAnalysisProgress {
 schema:'weekly-candidate-postanalysis-progress.v1';id:string;tenantId:string;programId:string;packageId:string;packageVersion:number;
 jobId:string;runId:string;candidateId:string;originHash:string;analysisRunId:string|null;
 state:'pending'|'blocked'|'context_ready'|'semantic_pending'|'semantic_assessed';code:string;
 contextAssessmentId:string|null;semanticAssessmentId:string|null;referenceAnalysisHandoffId:string|null;
 newProviderRequests:0;newCostCny:0;createdAt:string;updatedAt:string;recordHash:string;
}
const obj=(v:unknown)=>socialObject(socialJson(v))??{};
const seal=(v:WeeklyCandidatePostAnalysisProgress)=>({...v,recordHash:socialRequestHash({...v,recordHash:''})});
function checked(row:Record_,job:Job,run:SocialInspirationCollectionRun,id:string){
 const p=row.payload as WeeklyCandidatePostAnalysisProgress;
 if(!p||row.id!==p.id||row.tenant_id!==job.tenantId||row.job_id!==job.jobId||row.run_id!==run.runId||row.candidate_id!==id||row.record_hash!==p.recordHash||seal(p).recordHash!==p.recordHash||p.schema!=='weekly-candidate-postanalysis-progress.v1'||p.tenantId!==job.tenantId||p.programId!==job.programId||p.packageId!==job.packageId||p.packageVersion!==job.packageVersion||p.jobId!==job.jobId||p.runId!==run.runId||p.candidateId!==id||p.newProviderRequests!==0||p.newCostCny!==0)throw Error('weekly_postanalysis_progress_corrupt');
 return p;
}
async function save(store:DataStore,job:Job,run:SocialInspirationCollectionRun,id:string,source:{originHash:string;analysisRunId:string|null},state:WeeklyCandidatePostAnalysisProgress['state'],code:string,contextAssessmentId:string|null,semanticAssessmentId:string|null,referenceAnalysisHandoffId:string|null){
 const key=socialRequestHash({tenantId:job.tenantId,jobId:job.jobId,runId:run.runId,candidateId:id}).slice(0,15);
 const prior=await store.getById<Record_>(WEEKLY_CANDIDATE_POSTANALYSIS_PROGRESS,key),old=prior?checked(prior,job,run,id):null;
 const now=new Date().toISOString(),item=seal({schema:'weekly-candidate-postanalysis-progress.v1',id:key,tenantId:job.tenantId,programId:job.programId,packageId:job.packageId,packageVersion:job.packageVersion,jobId:job.jobId,runId:run.runId,candidateId:id,...source,state,code,contextAssessmentId,semanticAssessmentId,referenceAnalysisHandoffId,newProviderRequests:0,newCostCny:0,createdAt:old?.createdAt??now,updatedAt:old?.updatedAt??now,recordHash:''});
 if(old&&old.originHash===item.originHash&&old.analysisRunId===item.analysisRunId&&old.state===item.state&&old.code===item.code&&old.contextAssessmentId===item.contextAssessmentId&&old.semanticAssessmentId===item.semanticAssessmentId&&old.referenceAnalysisHandoffId===item.referenceAnalysisHandoffId)return old;
 if(old){item.updatedAt=now;item.recordHash=seal(item).recordHash;if(!await store.update(WEEKLY_CANDIDATE_POSTANALYSIS_PROGRESS,key,{record_hash:item.recordHash,payload:item}))throw Error('weekly_postanalysis_progress_write_unknown');}
 else if(!await store.create(WEEKLY_CANDIDATE_POSTANALYSIS_PROGRESS,{id:key,tenant_id:job.tenantId,job_id:job.jobId,run_id:run.runId,candidate_id:id,record_hash:item.recordHash,payload:item}))throw Error('weekly_postanalysis_progress_write_unknown');
 return item;
}
async function selectedContextInput(store:DataStore,job:Job,pkg:WeeklyOperatingPackage){
 const selection=await readWeeklyPublicationProductSelectionChoices(store,{tenantId:job.tenantId,programId:job.programId,packageId:job.packageId,packageVersion:job.packageVersion});
 const ids=[...new Set(selection.publications.map(p=>p.selectedProductId))];
 if(selection.selectionState!=='consistent'||ids.length!==1||!ids[0])return {code:'weekly_postanalysis_selected_product_required' as const};
 const product=selection.products.find(p=>p.id===ids[0]);if(!product)return {code:'weekly_postanalysis_selected_product_changed' as const};
 const ref=pkg.operatingDecisionSnapshotRef;if(!ref)return {code:'weekly_postanalysis_frozen_facts_required' as const};
 const snapshots=await store.list<Record_>('social_operating_authority_snapshots',{where:{tenant_id:job.tenantId,program_id:job.programId,snapshot_id:ref.id,version:ref.version},perPage:2});
 if(snapshots.totalItems!==1||snapshots.items.length!==1)return {code:'weekly_postanalysis_frozen_facts_required' as const};
 const facts=obj(obj(snapshots.items[0]!.payload).enterprise).publicFacts;
 const matches=(Array.isArray(facts)?facts:[]).map(obj).filter(f=>f.statement===product.name&&obj(f.ref).type==='enterprise_fact');
 if(matches.length!==1)return {code:'weekly_postanalysis_product_fact_required' as const};
 const scope=await store.getById<Record_>('social_discovery_scopes',job.authority?.scopeId??'');
 if(!scope||scope.tenant_id!==job.tenantId||scope.version!==job.authority?.scopeVersion)return {code:'weekly_postanalysis_discovery_scope_changed' as const};
 const audienceRole=obj(obj(obj(scope.payload).keywordSet).scope).audienceRole;
 if(!['brand_buyer','importer','distributor','retailer','consumer'].includes(String(audienceRole)))return {code:'weekly_postanalysis_audience_role_required' as const};
 const fact=obj(matches[0]!.ref);
 return {input:{programId:job.programId,packageId:job.packageId,packageVersion:job.packageVersion,selectedProductFactRefs:[{type:'enterprise_fact',id:String(fact.id),version:Number(fact.version)}],audienceRole:audienceRole as 'brand_buyer'|'importer'|'distributor'|'retailer'|'consumer'},code:null};
}

/** Advance only already-collected candidates. Semantic paid analysis requires
 * its own durable weekly authorization; neither collection nor production
 * budgets are a substitute. */
export async function advanceWeeklyCandidatePostAnalysis(input:{store:DataStore;job:Job;run:SocialInspirationCollectionRun;pkg:WeeklyOperatingPackage;mediaRoot:string;acceptedCandidateIds:string[];exactAnalysisPorts?:WeeklyCandidateExactAnalysisPorts;canonicalMedia?:{bindingForCandidate:(candidateId:string)=>Promise<VerifiedRunKvMediaBinding|VerifiedDatasetDirectMediaBinding|null>;ports?:WeeklyCandidateCanonicalMediaPorts}}):Promise<WeeklyCandidatePostAnalysisProgress[]>{
 const {store,job,run,pkg,mediaRoot}=input;
 if(pkg.packageId!==job.packageId||pkg.programId!==job.programId||pkg.version!==job.packageVersion||!job.authority||run.discoveryScopeId!==job.authority.scopeId||run.discoveryScopeVersion!==job.authority.scopeVersion)throw Error('weekly_postanalysis_scope_invalid');
 const accepted=new Set(input.acceptedCandidateIds),snapshot=await readWeeklyCandidateAdmissionSnapshot({store,job,run,mediaRoot,exactAnalysisPorts:input.exactAnalysisPorts});
 if(accepted.size!==input.acceptedCandidateIds.length||[...accepted].some(id=>!snapshot.some(item=>item.candidateId===id)))throw Error('weekly_postanalysis_candidate_lineage_invalid');
 const results:WeeklyCandidatePostAnalysisProgress[]=[];
 for(const candidate of snapshot.filter(item=>accepted.has(item.candidateId))){
  let record=await store.getById<Record_>('trend_videos',candidate.candidateId);
  if(!record||record.tenantId!==job.tenantId)throw Error('weekly_postanalysis_candidate_changed');
  let analysis=obj(record.aiAnalysis);const origins=(Array.isArray(analysis.discoveryOrigins)?analysis.discoveryOrigins:[]).map(obj).filter(o=>o.runId===run.runId&&o.scopeId===job.authority?.scopeId&&o.scopeVersion===job.authority?.scopeVersion);
  if(origins.length!==1)throw Error('weekly_postanalysis_origin_changed');
  let source={originHash:socialRequestHash(origins[0]),analysisRunId:typeof analysis.analysisRunId==='string'?analysis.analysisRunId:null};
  const progress=(state:WeeklyCandidatePostAnalysisProgress['state'],code:string,context:string|null=null,semantic:string|null=null,handoff:string|null=null)=>save(store,job,run,candidate.candidateId,source,state,code,context,semantic,handoff);
  const alreadyExact=await verifiedWeeklyCandidateMedia(record,mediaRoot);
  if(!alreadyExact){
   // Canonical bytes alone are not exact-video evidence. The operation has a
   // separate authorization and a pre-submit durable claim; no production
   // executor is installed until its real paid permit is available.
   const expected=`tenants/${job.tenantId}/reference-videos/${candidate.candidateId}.mp4`;
   const hasCanonicalLocator=record.videoFileId===expected&&/^[a-f0-9]{64}$/.test(String(analysis.contentSha256??''));
   if(!hasCanonicalLocator){
    if(!input.canonicalMedia){results.push(await progress('blocked','weekly_postanalysis_canonical_media_intervention_required'));continue;}
    const canonical=await advanceWeeklyCandidateCanonicalMedia({store,job,run,record,mediaRoot,binding:await input.canonicalMedia?.bindingForCandidate(candidate.candidateId)??null,ports:input.canonicalMedia?.ports});
    if(canonical.state!=='completed'){results.push(await progress(canonical.state==='unknown'?'pending':'blocked',canonical.code));continue;}
    record=await store.getById<Record_>('trend_videos',candidate.candidateId);
    if(!record)throw Error('weekly_postanalysis_canonical_media_result_missing');
    analysis=obj(record.aiAnalysis);
   }
   if(!await verifiedWeeklyCandidateCanonicalMedia(record,mediaRoot)){results.push(await progress('blocked','weekly_postanalysis_canonical_evidence_intervention_required'));continue;}
  }
  // Even a now-valid analysis cannot bypass an earlier unknown paid attempt
  // for these exact bytes. Settle only the original operation identity.
  const exact=await advanceWeeklyCandidateExactAnalysis({store,job,run,record,mediaRoot,ports:input.exactAnalysisPorts});
  if(exact.state!=='completed'){results.push(await progress(exact.state==='blocked'?'blocked':'pending',exact.code));continue;}
  record=await store.getById<Record_>('trend_videos',candidate.candidateId);
  if(!record||!await verifiedWeeklyCandidateMedia(record,mediaRoot))throw Error('weekly_postanalysis_exact_analysis_result_changed');
  source={...source,analysisRunId:String(obj(record.aiAnalysis).analysisRunId)};
  const selection=await selectedContextInput(store,job,pkg);
  if(!selection.input){results.push(await progress('pending',selection.code));continue;}
  let context=await readCandidateContextAssessment(store,job.tenantId,candidate.candidateId,{programId:job.programId,packageId:job.packageId,packageVersion:job.packageVersion},record);
  if(context&&(context.productFacts.length!==1||socialRequestHash(context.productFacts[0]!.ref)!==socialRequestHash(selection.input.selectedProductFactRefs[0])||context.audienceRole!==selection.input.audienceRole))throw Error('weekly_postanalysis_selected_product_context_changed');
  if(!context){
   try{context=await createCandidateContextAssessment(store,job.tenantId,job.actorUserId,candidate.candidateId,{...selection.input,analysisRunId:String(source.analysisRunId)},mediaRoot);}
   catch(error){if(error instanceof Error&&error.message==='candidate_context_canonical_receipt_required'){results.push(await progress('pending','weekly_postanalysis_canonical_receipt_required'));continue;}throw error;}
  }
  const semantic=await readCandidateSemanticAssessment(store,context);
  if(semantic){
   const relevance=semantic.dimensions.relevance;
   if(relevance.state!=='assessed'||relevance.value===null){results.push(await progress('semantic_assessed','weekly_postanalysis_semantic_evidence_required',context.assessmentId,semantic.assessmentId));continue;}
   if(relevance.value<0.7){results.push(await progress('semantic_assessed','weekly_postanalysis_semantic_rejected',context.assessmentId,semantic.assessmentId));continue;}
   let referenceHandoffId:string|null=null,code='weekly_postanalysis_transferability_mapping_required';
   try{referenceHandoffId=(await writeWeeklyCandidateReferenceAnalysisHandoff({store,job,run,candidateId:candidate.candidateId,mediaRoot})).id;}
   catch(error){if(!(error instanceof Error)||!error.message.startsWith('candidate_reference_'))throw error;code=error.message;}
   if(referenceHandoffId){
    try{
     await createAutomaticCandidateTransferabilityAssessment({store,context,semantic});
     code='weekly_postanalysis_transferability_assessed';
    }catch(error){
     if(!(error instanceof Error)||!error.message.startsWith('candidate_transferability_')&&!error.message.startsWith('weekly_default_voice_')&&!error.message.startsWith('selected_presenter_')&&!error.message.startsWith('heygen_'))throw error;
     code=error.message;
    }
   }
   results.push(await progress('semantic_assessed',code,context.assessmentId,semantic.assessmentId,referenceHandoffId));continue;
  }
  const approvals=await store.list<Record_>(WEEKLY_CANDIDATE_SEMANTIC_BUDGET_AUTHORIZATIONS,{where:{tenant_id:job.tenantId,program_id:job.programId,package_id:job.packageId,package_version:job.packageVersion,status:'approved'},perPage:2});
  if(approvals.totalItems>1||approvals.items.length!==approvals.totalItems)throw Error('weekly_postanalysis_semantic_budget_ambiguous');
  let assessed:Awaited<ReturnType<typeof assessCandidateSemantics>>;
  try{assessed=await assessCandidateSemantics(store,job.tenantId,job.actorUserId,candidate.candidateId,context.assessmentId,approvals.totalItems===1?{
   paidCall:async()=>resolveWeeklyCandidateSemanticPaidCall({store,job,run,candidateId:candidate.candidateId,context:context!,mediaRoot})
  }:{});}
  catch(error){if(error instanceof Error&&error.message.startsWith('weekly_candidate_semantic_budget_')){results.push(await progress('blocked',error.message,context.assessmentId));continue;}throw error;}
  const code=assessed.state==='unknown'?'candidate_semantic_original_receipt_pending':assessed.code??'candidate_context_semantic_budget_authorization_required';
  results.push(await progress(assessed.state==='blocked'?'blocked':'semantic_pending',code,context.assessmentId));
 }
 return results;
}
