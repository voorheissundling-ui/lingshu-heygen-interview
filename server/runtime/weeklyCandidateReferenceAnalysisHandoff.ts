import type {DataStore,Record_} from '../storage/datastore.js';
import type {SocialInspirationCollectionRun} from '../../shared/contracts/socialContentWorkflow.js';
import type {WeeklyPreproductionJob} from './weeklyPreproductionProducer.js';
import type {WeeklyPreproductionRetryAttempt} from './weeklyPreproductionRetryAttempts.js';
import {socialJson,socialObject,socialRequestHash} from '../starter198/socialContentValidation.js';
import {readCandidateContextAssessment} from '../socialDiscovery/candidateContextAssessment.js';
import {readCandidateSemanticAssessment} from '../socialDiscovery/candidateSemanticAssessment.js';
import {createExactShotMaterializationService} from '../lib/referenceExactShotMaterialization.js';
import {verifiedWeeklyCandidateMedia} from './weeklyCandidateReassessment.js';
import {sourceAccountFromVideoUrl,videoSourceIdentity} from '../routes/videoSourceIdentity.js';
import {readWeeklyReviewActor} from '../socialPrograms/weeklyReviewEvidence.js';

/** Candidate-only analytical evidence. This collection is never a production
 * reference, media licence, schedule authorization or content-creation permit. */
export const WEEKLY_CANDIDATE_REFERENCE_ANALYSIS_HANDOFFS='social_weekly_candidate_reference_analysis_handoffs';
type Job=WeeklyPreproductionJob|WeeklyPreproductionRetryAttempt;
const obj=(v:unknown)=>socialObject(socialJson(v))??{};
const sha=/^[a-f0-9]{64}$/;
export interface WeeklyCandidateReferenceAnalysisHandoff {
 schema:'weekly-candidate-reference-analysis-handoff.v1';id:string;tenantId:string;programId:string;packageId:string;packageVersion:number;
 jobId:string;runId:string;candidateId:string;accountUrl:string;videoUrl:string;scopeId:string;scopeVersion:number;scopeHash:string;
 sourceSha256:string;analysisRunId:string;analysisHash:string;contextAssessmentId:string;contextHash:string;semanticAssessmentId:string;semanticHash:string;
 rights:{internalReferenceAnalysisAuthorized:true;mayAnalyze:true;mayUseOriginalMedia:false;mayAdapt:false;approvalHash:string;approvedByUserId:string};
 shots:Array<{shotIndex:number;startSeconds:number;endSeconds:number;clipSha256:string;firstFrameSha256:string;clipRef:string;firstFrameRef:string;observedFacts:string;visual:string}>;
 status:'candidate_analysis_only';createdAt:string;recordHash:string;
}
export interface WeeklyCandidateReferenceAnalysisInput {store:DataStore;job:Job;run:SocialInspirationCollectionRun;candidateId:string;mediaRoot:string;}
function fail(code:string):never{throw Error(code);}
function sealed(p:WeeklyCandidateReferenceAnalysisHandoff){return socialRequestHash({...p,recordHash:''});}
export function assertCandidateReferenceWindows(duration:number,shots:ReadonlyArray<{startSeconds:number;endSeconds:number}>){
 if(!Number.isFinite(duration)||duration<=0||!shots.length||shots.some((shot,index)=>
   !Number.isFinite(shot.startSeconds)||!Number.isFinite(shot.endSeconds)||
   shot.startSeconds<0||shot.endSeconds<=shot.startSeconds||shot.endSeconds>duration+.05||
   (index===0&&shot.startSeconds>.05)||
   (index>0&&Math.abs(shot.startSeconds-shots[index-1]!.endSeconds)>.05))||
   Math.abs(shots.at(-1)!.endSeconds-duration)>.05)fail('candidate_reference_windows_outside_source_media');
}
async function current(input:WeeklyCandidateReferenceAnalysisInput,materializeMissing=false){
 const {store,job,run,candidateId,mediaRoot}=input,authority=job.authority;
 if(!authority||run.discoveryScopeId!==authority.scopeId||run.discoveryScopeVersion!==authority.scopeVersion||!['succeeded','partial','stopped','failed'].includes(run.status))fail('candidate_reference_run_changed');
 const [scope,record,actor,packages,runs]=await Promise.all([
  store.getById<Record_>('social_discovery_scopes',authority.scopeId),store.getById<Record_>('trend_videos',candidateId),readWeeklyReviewActor(store,job.tenantId,job.actorUserId),
  store.list<Record_>('social_weekly_operating_packages',{where:{tenant_id:job.tenantId,program_id:job.programId,package_id:job.packageId},sort:'-version',perPage:1}),
  store.list<Record_>('social_discovery_runs',{where:{tenant_id:job.tenantId,runId:run.runId},perPage:2}),
 ]);
 const payload=obj(scope?.payload),approval=obj(payload.approval),authorization=obj(payload.authorizationSource),revision=obj(payload.weeklyAccountRevision),target=obj(obj(payload.discoveryBrief).weeklyAccountCollectionTarget),accountUrl=String(target.accountUrl??'');
 if(!scope||scope.tenant_id!==job.tenantId||scope.status!=='active'||scope.version!==authority.scopeVersion||socialRequestHash(scope.payload)!==authority.scopeHash||approval.status!=='approved'||approval.scopeVersion!==scope.version||approval.approvedBy!=='user'||authorization.type!=='confirmed_weekly_plan'||typeof approval.approvedByUserId!=='string'||approval.approvedByUserId!==revision.approvedByUserId||revision.accountUrl!==accountUrl||revision.targetCount!==5||target.targetCount!==5||!accountUrl)fail('candidate_reference_scope_revoked');
 if(!actor||actor.tenantId!==job.tenantId||actor.active===false||actor.disabled===true||['disabled','suspended'].includes(String(actor.status)))fail('candidate_reference_actor_revoked');
 const approvedBy=await readWeeklyReviewActor(store,job.tenantId,String(approval.approvedByUserId));if(!approvedBy||approvedBy.tenantId!==job.tenantId||approvedBy.active===false||approvedBy.disabled===true||['disabled','suspended'].includes(String(approvedBy.status)))fail('candidate_reference_approval_revoked');
 if(packages.totalItems<1||obj(packages.items[0]?.payload).version!==job.packageVersion||!['draft','active'].includes(String(obj(packages.items[0]?.payload).status))||runs.totalItems!==1||runs.items.length!==1||runs.items[0]?.tenant_id!==job.tenantId||socialRequestHash(runs.items[0])!==socialRequestHash(run))fail('candidate_reference_package_or_run_changed');
 const frozen=obj(run.scopeSnapshot),frozenTarget=obj(frozen.weeklyAccountCollectionTarget),marker=obj(frozen.weeklyProducer),retry=(job as WeeklyPreproductionRetryAttempt).retry;
 if(frozenTarget.accountUrl!==accountUrl||frozenTarget.targetCount!==5||!Array.isArray(run.queryBasis?.account)||!run.queryBasis.account.includes(accountUrl))fail('candidate_reference_frozen_query_changed');
 if(retry){const frozenRetry=obj(marker.retry),parent=await store.list<Record_>('social_discovery_runs',{where:{tenant_id:job.tenantId,runId:retry.parentRunId},perPage:2});
  if(parent.totalItems!==1||parent.items.length!==1||parent.items[0]?.tenant_id!==job.tenantId||socialRequestHash(parent.items[0])!==retry.parentRunHash||frozenRetry.parentRunId!==retry.parentRunId||frozenRetry.parentRunHash!==retry.parentRunHash||socialRequestHash(frozenRetry.sourceSelection)!==socialRequestHash(retry.sourceSelection)||!retry.sourceSelection.some(s=>s.mode==='account'&&s.platform==='tiktok'&&s.queryRef===accountUrl))fail('candidate_reference_retry_lineage_changed');
 }else if(marker.key!==job.originalRunKey||run.runId!==`weekly_discovery_${socialRequestHash({tenantId:job.tenantId,key:job.originalRunKey})}`||Object.keys(obj(marker.retry)).length)fail('candidate_reference_root_lineage_changed');
 const ids=Object.values(run.evidenceOutcomes??{}).flatMap(outcome=>[...(outcome?.acceptedCandidateIds??[]),...(outcome?.suggestionCandidateIds??[])]);
 if(ids.filter(id=>id===candidateId).length!==1||!record||record.id!==candidateId||record.tenantId!==job.tenantId||record.platform!=='tiktok'||sourceAccountFromVideoUrl('tiktok',String(record.sourceUrl))!==accountUrl||!/^tiktok:id:\d+$/.test(videoSourceIdentity('tiktok',String(record.sourceUrl))))fail('candidate_reference_source_not_owned');
 const analysis=obj(record.aiAnalysis),gemini=obj(analysis.gemini),clock=obj(gemini.sourceMediaClock),origins=Array.isArray(analysis.discoveryOrigins)?analysis.discoveryOrigins.map(obj):[];
 if(origins.filter(o=>o.runId===run.runId&&o.scopeId===scope.id&&o.scopeVersion===scope.version&&o.mode==='account'&&o.queryRef===accountUrl).length!==1||analysis.analysisMode!=='exact'||analysis.analysisQuality!=='video'||typeof analysis.analysisRunId!=='string'||!sha.test(String(analysis.contentSha256))||analysis.contentSha256!==clock.sourceSha256||clock.analysisRunId!==analysis.analysisRunId)fail('candidate_reference_exact_source_changed');
 const context=await readCandidateContextAssessment(store,job.tenantId,candidateId,{programId:job.programId,packageId:job.packageId,packageVersion:job.packageVersion},record);
 if(!context||context.keyword.scopeId!==scope.id||context.keyword.scopeVersion!==scope.version||context.canonical.mediaSha256!==analysis.contentSha256||context.canonical.analysisRunId!==analysis.analysisRunId)fail('candidate_reference_context_missing');
 const semantic=await readCandidateSemanticAssessment(store,context);
 if(!semantic||semantic.tenantId!==job.tenantId||semantic.candidateId!==candidateId||semantic.contextHash!==context.recordHash||semantic.dimensions.relevance.state!=='assessed'||semantic.dimensions.relevance.value===null||semantic.dimensions.relevance.value<.7||!semantic.dimensions.relevance.evidence.length)fail('candidate_reference_semantic_missing');
 const facts=new Set(context.productFacts.map(f=>`${f.ref.type}:${f.ref.id}@${f.ref.version}`)),observed=new Set(context.observations.map(s=>s.shotIndex));
 if(!semantic.dimensions.relevance.evidence.every(e=>facts.has(e.factRef)&&observed.has(e.shotIndex)&&e.quote.trim().length>=4))fail('candidate_reference_semantic_changed');
 // A saved handoff is not proof that the canonical tenant-owned source bytes
 // still exist. Recheck on both issuance and every read, not just on writes.
 if(!await verifiedWeeklyCandidateMedia(record,mediaRoot))fail('candidate_reference_local_media_required');
 const analysisHash=socialRequestHash(analysis),materializer=createExactShotMaterializationService(store,{mediaRoot});
 const materialScope={tenantId:job.tenantId,recordId:candidateId,expectedSourceSha256:String(analysis.contentSha256),expectedAnalysisRunId:String(analysis.analysisRunId),expectedAnalysisHash:analysisHash};
 let verified=await materializer.readVerifiedAnalysis(materialScope);
 if(!verified&&materializeMissing){
  // Only the write path may create local evidence. Require the canonical
  // tenant-owned MP4 first, so materialization cannot fall back to a remote
  // object fetch or turn an unverified candidate into a reference handoff.
  await materializer.materialize(materialScope);
  verified=await materializer.readVerifiedAnalysis(materialScope);
 }
 if(!verified)fail('candidate_reference_shot_evidence_missing');
 const details=obj(verified.gemini).scriptDetails15s;if(!Array.isArray(details)||details.length!==context.observations.length)fail('candidate_reference_shot_mapping_changed');
 const shots=details.map((value,index)=>{const detail=obj(value),e=obj(detail.materialEvidence),observation=context.observations[index]!;
  if(e.extractionStatus!=='ready'||e.sourceSha256!==analysis.contentSha256||e.analysisRunId!==analysis.analysisRunId||!Number.isFinite(e.startSeconds)||!Number.isFinite(e.endSeconds)||Number(e.endSeconds)<=Number(e.startSeconds)||!sha.test(String(e.clipSha256))||!sha.test(String(e.firstFrameSha256))||String(detail.time??'')!==observation.time||String(detail.observedFacts??'')!==observation.observedFacts||String(detail.visual??'')!==observation.visual)fail('candidate_reference_shot_mapping_changed');
  return {shotIndex:index+1,startSeconds:Number(e.startSeconds),endSeconds:Number(e.endSeconds),clipSha256:String(e.clipSha256),firstFrameSha256:String(e.firstFrameSha256),clipRef:String(e.clipRef),firstFrameRef:String(e.firstFrameRef),observedFacts:observation.observedFacts,visual:observation.visual};
 });
 assertCandidateReferenceWindows(Number(clock.duration),shots);
 return {scope,approval,accountUrl,record,analysis,analysisHash,context,semantic,shots};
}
function validateRow(row:Record_,expected:WeeklyCandidateReferenceAnalysisHandoff){const p=row.payload as WeeklyCandidateReferenceAnalysisHandoff;
 if(!p||row.id!==expected.id||row.tenant_id!==expected.tenantId||row.program_id!==expected.programId||row.package_id!==expected.packageId||row.package_version!==expected.packageVersion||row.job_id!==expected.jobId||row.run_id!==expected.runId||row.candidate_id!==expected.candidateId||row.record_hash!==p.recordHash||sealed(p)!==p.recordHash||socialRequestHash({...p,createdAt:'' ,recordHash:''})!==socialRequestHash({...expected,createdAt:'',recordHash:''}))fail('candidate_reference_handoff_changed');
 return p;
}
async function expected(input:WeeklyCandidateReferenceAnalysisInput,materializeMissing=false){const state=await current(input,materializeMissing),{job,run,candidateId}=input;
 const body:WeeklyCandidateReferenceAnalysisHandoff={schema:'weekly-candidate-reference-analysis-handoff.v1',id:socialRequestHash({tenantId:job.tenantId,programId:job.programId,packageId:job.packageId,packageVersion:job.packageVersion,jobId:job.jobId,runId:run.runId,candidateId,kind:'candidate-reference-analysis.v1'}).slice(0,15),tenantId:job.tenantId,programId:job.programId,packageId:job.packageId,packageVersion:job.packageVersion,jobId:job.jobId,runId:run.runId,candidateId,accountUrl:state.accountUrl,videoUrl:String(state.record.sourceUrl),scopeId:state.scope.id,scopeVersion:Number(state.scope.version),scopeHash:socialRequestHash(state.scope.payload),sourceSha256:String(state.analysis.contentSha256),analysisRunId:String(state.analysis.analysisRunId),analysisHash:state.analysisHash,contextAssessmentId:state.context.assessmentId,contextHash:state.context.recordHash,semanticAssessmentId:state.semantic.assessmentId,semanticHash:state.semantic.recordHash,rights:{internalReferenceAnalysisAuthorized:true,mayAnalyze:true,mayUseOriginalMedia:false,mayAdapt:false,approvalHash:socialRequestHash(state.approval),approvedByUserId:String(state.approval.approvedByUserId)},shots:state.shots,status:'candidate_analysis_only',createdAt:'',recordHash:''};return body;
}
/** Purely local analytical handoff: no crawl, model, merge, supplier or content call. */
export async function writeWeeklyCandidateReferenceAnalysisHandoff(input:WeeklyCandidateReferenceAnalysisInput){const draft=await expected(input,true),store=input.store,prior=await store.getById<Record_>(WEEKLY_CANDIDATE_REFERENCE_ANALYSIS_HANDOFFS,draft.id);
 if(prior)return validateRow(prior,draft);
 const item={...draft,createdAt:new Date().toISOString()};item.recordHash=sealed(item);
 const created=await store.create(WEEKLY_CANDIDATE_REFERENCE_ANALYSIS_HANDOFFS,{id:item.id,tenant_id:item.tenantId,program_id:item.programId,package_id:item.packageId,package_version:item.packageVersion,job_id:item.jobId,run_id:item.runId,candidate_id:item.candidateId,record_hash:item.recordHash,payload:item});
 const saved=created??await store.getById<Record_>(WEEKLY_CANDIDATE_REFERENCE_ANALYSIS_HANDOFFS,item.id);if(!saved)fail('candidate_reference_handoff_write_unknown');
 const reread=await expected(input);return validateRow(saved,reread);
}
/** Recompute every live binding, including scope revocation and source bytes. */
export async function readWeeklyCandidateReferenceAnalysisHandoff(input:WeeklyCandidateReferenceAnalysisInput){const draft=await expected(input),row=await input.store.getById<Record_>(WEEKLY_CANDIDATE_REFERENCE_ANALYSIS_HANDOFFS,draft.id);return row?validateRow(row,draft):null;}
