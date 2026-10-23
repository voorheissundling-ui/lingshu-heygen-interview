import type {DataStore,Record_} from '../storage/datastore.js';
import type {SocialInspirationCollectionRun} from '../../shared/contracts/socialContentWorkflow.js';
import type {WeeklyPreproductionRetryAttempt} from './weeklyPreproductionRetryAttempts.js';
import type {WeeklyPreproductionJob} from './weeklyPreproductionProducer.js';
import type {WeeklyQualifiedCandidate} from './weeklyQualifiedCandidateContinuation.js';
import {socialJson,socialObject,socialRequestHash} from '../starter198/socialContentValidation.js';
import {readWeeklyCandidateReassessment,verifiedWeeklyCandidateMedia} from './weeklyCandidateReassessment.js';
import {readCandidateContextAssessment} from '../socialDiscovery/candidateContextAssessment.js';
import {readCandidateSemanticAssessment} from '../socialDiscovery/candidateSemanticAssessment.js';
import {readCandidateTransferabilityAssessment} from '../socialDiscovery/candidateTransferabilityAssessment.js';
import {sourceAccountFromProviderMetadata,sourceAccountFromVideoUrl,videoSourceIdentity} from '../routes/videoSourceIdentity.js';
import type {CandidateContextAssessment} from '../socialDiscovery/candidateContextAssessment.js';
import type {CandidateSemanticAssessment} from '../socialDiscovery/candidateSemanticAssessment.js';
import {selectWeeklyDiscoveryProductFacts} from '../digitalEmployees/weeklyDiscoveryScope.js';
import {readWeeklyCandidateReferenceAnalysisHandoff} from './weeklyCandidateReferenceAnalysisHandoff.js';
import {assertCandidateReferenceWindows} from './weeklyCandidateReferenceAnalysisHandoff.js';
import {parseAnalysisTimeRange} from '../lib/videoAnalysisCodec.js';
import {readWeeklyCandidateExactAnalysisSettlement,type WeeklyCandidateExactAnalysisPorts} from './weeklyCandidateExactAnalysisOperation.js';

export type WeeklyReferenceCandidateAdmission=WeeklyQualifiedCandidate&{
 /** Permits only candidate storyboard/shortfall analysis. Never counts as a
  * qualified mother reference or authorizes schedule merge or production. */
 referenceAdmission:'pending'|'rejected'|'accepted';
 candidateAnalysisHandoffRef?:string;
};

export function assessWeeklyReferenceCandidate(input:{context:CandidateContextAssessment|null;semantic:CandidateSemanticAssessment|null;scopeId:string;scopeVersion:number;selectedProductName:string;candidateId:string;tenantId:string;programId:string;packageId:string;packageVersion:number;hasExactEvidence:boolean;hasCandidateAnalysisHandoff:boolean;hasAccount:boolean}):WeeklyReferenceCandidateAdmission['referenceAdmission']{
 const {context:c,semantic:s}=input;
 if(s?.dimensions.relevance.state==='assessed'&&s.dimensions.relevance.value!==null&&s.dimensions.relevance.value<0.7)return 'rejected';
 if(!c||!s||!input.hasExactEvidence||!input.hasCandidateAnalysisHandoff||!input.hasAccount||!input.selectedProductName)return 'pending';
 if(c.tenantId!==input.tenantId||c.candidateId!==input.candidateId||c.programId!==input.programId||c.packageId!==input.packageId||c.packageVersion!==input.packageVersion||c.keyword.scopeId!==input.scopeId||c.keyword.scopeVersion!==input.scopeVersion||!c.observations.length||!c.productFacts.some(f=>f.statement.trim()===input.selectedProductName.trim())||s.tenantId!==c.tenantId||s.candidateId!==c.candidateId||s.contextHash!==c.recordHash||s.dimensions.relevance.state!=='assessed'||s.dimensions.relevance.value===null||s.dimensions.relevance.value<0.7||!s.dimensions.relevance.evidence.length)return 'pending';
 const facts=new Set(c.productFacts.map(f=>`${f.ref.type}:${f.ref.id}@${f.ref.version}`)),shots=new Set(c.observations.map(o=>o.shotIndex));
 return s.dimensions.relevance.evidence.every(e=>facts.has(e.factRef)&&shots.has(e.shotIndex)&&e.quote.trim().length>=4)?'accepted':'pending';
}

const object=(value:unknown)=>socialObject(socialJson(value))??{};
async function all(store:DataStore,collection:string,where:Record<string,string|number>){
 const result:Record_[]=[];let total:number|undefined;
 for(let page=1;page<=1000;page++){
  const rows=await store.list<Record_>(collection,{where,page,perPage:200,sort:'id'});
  if(total!==undefined&&total!==rows.totalItems||!Number.isSafeInteger(rows.totalItems)||rows.totalItems<0||rows.items.some(r=>Object.entries(where).some(([key,value])=>r[key]!==value)||result.some(prior=>prior.id===r.id)))throw Error('weekly_candidate_admission_scan_changed');
  total=rows.totalItems;result.push(...rows.items);
  if(result.length===total)return result;
  if(!rows.items.length||result.length>total)throw Error('weekly_candidate_admission_scan_incomplete');
 }throw Error('weekly_candidate_admission_scan_limit');
}
function currentOrigin(record:Record_,job:WeeklyPreproductionJob|WeeklyPreproductionRetryAttempt,run:SocialInspirationCollectionRun){
 const origins=object(record.aiAnalysis).discoveryOrigins;
 const retry=(job as WeeklyPreproductionRetryAttempt).retry;
 const permitted=(mode:string,platform:string,queryRef:string)=>retry
  ? retry.sourceSelection.some(s=>s.mode===mode&&s.platform===platform&&s.queryRef===queryRef)
  : (run.queryBasis?.[mode as keyof typeof run.queryBasis]??[]).includes(queryRef)
    && (object(object(run.scopeSnapshot).modePolicies)[mode] as {platforms?:string[]}|undefined)?.platforms?.includes(platform);
 return (Array.isArray(origins)?origins:[]).map(object).filter(o=>o.runId===run.runId&&o.scopeId===job.authority?.scopeId&&o.scopeVersion===job.authority?.scopeVersion&&permitted(String(o.mode),String(record.platform),String(o.queryRef)));
}
function candidateIds(run:SocialInspirationCollectionRun){return [...new Set(Object.values(run.evidenceOutcomes??{}).flatMap(o=>[
 ...(o?.acceptedCandidateIds??[]),...(o?.suggestionCandidateIds??[]),...(o?.failedCandidateIds??[]),
]))];}
function exactHandoffRef(row:Record_,record:Record_):string|null{
 const handoff=object(row.payload),source=object(handoff.source),analysis=object(record.aiAnalysis);
 if(row.tenant_id!==record.tenantId||row.record_hash!==socialRequestHash(row.payload)||handoff.inspirationId!==record.id||handoff.readiness!=='production_reference'||source.sourceUrl!==record.sourceUrl||!handoff.analysisId||handoff.analysisId!==analysis.analysisRunId||!handoff.version&&!handoff.analysisVersion)return null;
 return `${String(handoff.inspirationId)}:${String(handoff.version??handoff.analysisVersion)}@${String(row.record_hash)}`;
}
/** Account-only five-mother references need a URL video identity and a
 * measured full-source timeline, not a text proposal copied from another
 * tenant's local file. The byte hash is independently checked by the media
 * reader before this projection is reached. */
function validAccountReferenceTimeline(record:Record_,requiredAccount:string):boolean{
 if(record.platform!=='tiktok'||sourceAccountFromVideoUrl('tiktok',String(record.sourceUrl))!==requiredAccount
  ||!/^tiktok:id:\d+$/.test(videoSourceIdentity('tiktok',String(record.sourceUrl))))return false;
 const analysis=object(record.aiAnalysis),clock=object(object(analysis.gemini).sourceMediaClock);
 const details=object(analysis.gemini).scriptDetails15s;
 if(clock.sourceSha256!==analysis.contentSha256||clock.analysisRunId!==analysis.analysisRunId||!Array.isArray(details))return false;
 const windows=details.map(value=>{const d=object(value),range=parseAnalysisTimeRange(String(d.time??d.timestamp??''));return range?{startSeconds:range.start,endSeconds:range.end}:null;});
 if(windows.some(value=>!value))return false;
 try{assertCandidateReferenceWindows(Number(clock.duration),windows as Array<{startSeconds:number;endSeconds:number}>);return true;}catch{return false;}
}
/** A read-only, fail-closed projection. Historical score rejection is not a
 * post-analysis verdict. Missing or unverified stages remain pending. */
async function readLayeredSnapshot(input:{store:DataStore;job:WeeklyPreproductionJob|WeeklyPreproductionRetryAttempt;run:SocialInspirationCollectionRun;mediaRoot:string;transferabilityPorts?:NonNullable<Parameters<typeof readCandidateTransferabilityAssessment>[0]['ports']>;exactAnalysisPorts?:Pick<WeeklyCandidateExactAnalysisPorts,'readSettledReceipt'>},includeReference:boolean):Promise<WeeklyReferenceCandidateAdmission[]>{
 const {store,job,run,mediaRoot}=input;
 const runRetry=object(object(object(run.scopeSnapshot).weeklyProducer).retry);
 const retry=(job as WeeklyPreproductionRetryAttempt).retry;
 const marker=object(object(run.scopeSnapshot).weeklyProducer);
 if(!job.authority?.scopeId||run.discoveryScopeId!==job.authority.scopeId||run.discoveryScopeVersion!==job.authority.scopeVersion||!['failed','partial','stopped','succeeded'].includes(run.status)
  ||(retry?(runRetry.parentRunId!==retry.parentRunId||runRetry.parentRunHash!==retry.parentRunHash||socialRequestHash(runRetry.sourceSelection)!==socialRequestHash(retry.sourceSelection))
   :(marker.key!==job.originalRunKey||run.runId!==`weekly_discovery_${socialRequestHash({tenantId:job.tenantId,key:job.originalRunKey})}`||Object.keys(runRetry).length>0)))throw Error('weekly_candidate_admission_lineage_invalid');
 const runRow=await all(store,'social_discovery_runs',{tenant_id:job.tenantId,runId:run.runId});
 if(runRow.length!==1||socialRequestHash(runRow[0])!==socialRequestHash(run))throw Error('weekly_candidate_admission_run_changed');
 if(retry){const parent=await all(store,'social_discovery_runs',{tenant_id:job.tenantId,runId:retry.parentRunId});
 if(parent.length!==1||socialRequestHash(parent[0])!==retry.parentRunHash)throw Error('weekly_candidate_admission_parent_changed');}
 const ids=candidateIds(run);
 const acceptedRefs=new Set(Object.values(run.evidenceOutcomes??{}).flatMap(o=>o?.acceptedEvidenceRefs??[]));
 const reassessmentRefs=(job.resultRefs??[]).filter(ref=>ref.type==='social_discovery_candidate_reassessment');
 if(reassessmentRefs.length>1)throw Error('weekly_candidate_admission_reassessment_ambiguous');
 if(reassessmentRefs[0]){
  if(!retry)throw Error('weekly_candidate_admission_reassessment_lineage_invalid');
  const reassessment=await readWeeklyCandidateReassessment(store,job as WeeklyPreproductionRetryAttempt,run,reassessmentRefs[0],mediaRoot);
  for(const outcome of Object.values(reassessment.evidenceOutcomes))for(const ref of outcome?.acceptedEvidenceRefs??[])acceptedRefs.add(ref);
 }
 const output:WeeklyReferenceCandidateAdmission[]=[];
 const frozenAccountTarget=object(object(run.scopeSnapshot).weeklyAccountCollectionTarget);
 const requiredAccount=typeof frozenAccountTarget.accountUrl==='string'&&frozenAccountTarget.targetCount===5
  ? frozenAccountTarget.accountUrl : null;
 for(const id of ids){
  const record=await store.getById<Record_>('trend_videos',id);
  const origins=record?currentOrigin(record,job,run):[];
  if(!record||record.tenantId!==job.tenantId||origins.length!==1)throw Error('weekly_candidate_admission_origin_invalid');
  const basic:WeeklyReferenceCandidateAdmission={candidateId:id,evidenceRef:null,exactHandoffRef:null,accountId:null,postAdmission:'pending',referenceAdmission:'pending'};
  // A weekly five-from-one-account revision must not be satisfied by a
  // keyword hit, another uploader, or a provider's unverified query label.
  // The canonical TikTok video URL (or independently parsed provider
  // account-homepage evidence below) must identify the frozen account.
  if(requiredAccount&&(origins[0]!.mode!=='account'||origins[0]!.queryRef!==requiredAccount)){
   output.push(basic);continue;
  }
  const exact=await verifiedWeeklyCandidateMedia(record,mediaRoot);
  if(!exact){output.push(basic);continue;}
  if(!await readWeeklyCandidateExactAnalysisSettlement({store,job,run,record,mediaRoot,ports:input.exactAnalysisPorts})){output.push(basic);continue;}
  if(requiredAccount&&!validAccountReferenceTimeline(record,requiredAccount)){output.push(basic);continue;}
  if(!includeReference){
   const handoffs=await all(store,'starter_social_inspiration_handoff_versions',{tenant_id:job.tenantId});
   const handoffRefs=handoffs.map(row=>exactHandoffRef(row,record)).filter((v):v is string=>Boolean(v));
   if(handoffRefs.length>1)throw Error('weekly_candidate_admission_handoff_ambiguous');
   basic.exactHandoffRef=handoffRefs[0]??null;
  }
  const evidence=await all(store,'social_candidate_evidence',{tenant_id:job.tenantId,candidateId:id});
  const validEvidence=evidence.filter(row=>object(row.evidence).qualityScore&&object(object(row.evidence).qualityScore).decision==='accepted'&&row.evidenceId&&typeof row.version==='number'&&Number.isSafeInteger(row.version)&&row.version>0&&acceptedRefs.has(`${String(row.evidenceId)}@${String(row.version)}`)&&object(row.g1).runId===run.runId&&object(row.g1).sourceUrl===record.sourceUrl);
  validEvidence.sort((a,b)=>Number(b.version)-Number(a.version));
  basic.evidenceRef=validEvidence[0]?`${String(validEvidence[0].evidenceId)}@${String(validEvidence[0].version)}`:null;
  const analysis=object(record.aiAnalysis),platform=String(record.platform),sourceUrl=String(record.sourceUrl);
  const accountId=sourceAccountFromVideoUrl(platform,sourceUrl)??(['provider_metadata','account_homepage'].includes(String(analysis.sourceAccountEvidence))?sourceAccountFromProviderMetadata(platform,String(analysis.sourceAccount??'')):null);
  if(requiredAccount&&accountId!==requiredAccount){output.push(basic);continue;}
  if(accountId){const accounts=await all(store,'social_tracked_accounts',{tenant_id:job.tenantId,accountId});if(accounts.length>1)throw Error('weekly_candidate_admission_account_ambiguous');if(accounts[0]&&Array.isArray(accounts[0].evidenceVideoIds)&&accounts[0].evidenceVideoIds.includes(id))basic.accountId=accountId;}
  let context:null|Awaited<ReturnType<typeof readCandidateContextAssessment>>=null;
  try{context=await readCandidateContextAssessment(store,job.tenantId,id,{programId:job.programId,packageId:job.packageId,packageVersion:job.packageVersion},record);}catch{output.push(basic);continue;}
  let semantic:null|Awaited<ReturnType<typeof readCandidateSemanticAssessment>>=null;
  if(context)try{semantic=await readCandidateSemanticAssessment(store,context);}catch{output.push(basic);continue;}
  // The transferability contract already rejects measured relevance below
  // 0.7. This is a settled current-package verdict, unlike a historical
  // metadata score or missing semantic receipt.
  if(semantic?.dimensions.relevance.state==='assessed'&&semantic.dimensions.relevance.value!==null&&semantic.dimensions.relevance.value<0.7){basic.postAdmission='rejected';basic.referenceAdmission='rejected';output.push(basic);continue;}
  let selectedProductName='';
  if(includeReference&&context){const scope=await store.getById<Record_>('social_discovery_scopes',job.authority.scopeId),productRef=object(object(object(scope?.payload).keywordSet).scope).productRef;
   const profiles=await all(store,'tenant_profiles',{tenant_id:job.tenantId});
   const products=object(object(profiles[0]?.profile).products).items;
   if(scope?.tenant_id===job.tenantId&&scope.version===job.authority.scopeVersion&&profiles.length===1&&typeof productRef==='string')try{const selected=selectWeeklyDiscoveryProductFacts([productRef],(Array.isArray(products)?products:[]).map(p=>({name:String(object(p).name??'')})));if(selected.length===1)selectedProductName=selected[0]!.name;}catch{/* Unbound selection remains pending. */}
  }
  // Candidate-grade storyboard evidence is a separate immutable, reverified
  // receipt. A later production_reference handoff cannot stand in for it.
  if(includeReference){
   let candidateHandoff:null|Awaited<ReturnType<typeof readWeeklyCandidateReferenceAnalysisHandoff>>=null;
   if(context&&semantic)try{candidateHandoff=await readWeeklyCandidateReferenceAnalysisHandoff({store,job,run,candidateId:id,mediaRoot});}catch{/* Stale/revoked analytical evidence never grants reference admission. */}
   if(candidateHandoff)basic.candidateAnalysisHandoffRef=`${candidateHandoff.id}@${candidateHandoff.recordHash}`;
   basic.referenceAdmission=assessWeeklyReferenceCandidate({context,semantic,scopeId:job.authority.scopeId,scopeVersion:job.authority.scopeVersion,selectedProductName,candidateId:id,tenantId:job.tenantId,programId:job.programId,packageId:job.packageId,packageVersion:job.packageVersion,hasExactEvidence:!!basic.evidenceRef,hasCandidateAnalysisHandoff:!!candidateHandoff,hasAccount:!!basic.accountId});
  }
  // Reference diagnosis is read-only and deliberately never probes HeyGen or
  // target assets. Its postAdmission field is always non-authoritative.
  if(includeReference){output.push(basic);continue;}
  let transferability:null|Awaited<ReturnType<typeof readCandidateTransferabilityAssessment>>=null;
  if(context&&semantic?.dimensions.relevance.state==='assessed')try{transferability=await readCandidateTransferabilityAssessment({store,context,semantic,...(input.transferabilityPorts?{ports:input.transferabilityPorts}:{})});}catch{output.push(basic);continue;}
  if(context&&semantic?.dimensions.relevance.state==='assessed'&&transferability?.state==='assessed'&&basic.evidenceRef&&basic.exactHandoffRef&&basic.accountId)basic.postAdmission='accepted';
  output.push(basic);
 }
 return output;
}
/** The original production-counting reader intentionally strips the reference
 * layer, so existing five-mother continuation and director dispatch remain
 * gated by full target-resource transferability. */
export async function readWeeklyCandidateAdmissionSnapshot(input:Parameters<typeof readLayeredSnapshot>[0]):Promise<WeeklyQualifiedCandidate[]>{
 return (await readLayeredSnapshot(input,false)).map(({referenceAdmission:_referenceAdmission,...production})=>production);
}
export async function readWeeklyReferenceCandidateAdmissionSnapshot(input:Parameters<typeof readLayeredSnapshot>[0]):Promise<WeeklyReferenceCandidateAdmission[]>{
 return readLayeredSnapshot(input,true);
}
