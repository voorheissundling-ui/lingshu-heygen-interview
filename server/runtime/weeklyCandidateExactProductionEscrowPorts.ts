import type {DataStore,Record_} from '../storage/datastore.js';
import type {SocialInspirationCollectionRun} from '../../shared/contracts/socialContentWorkflow.js';
import type {WeeklyOperatingPackage} from '../../shared/contracts/socialProgram.js';
import type {WeeklyPreproductionJob} from './weeklyPreproductionProducer.js';
import type {WeeklyPreproductionRetryAttempt} from './weeklyPreproductionRetryAttempts.js';
import {verifiedWeeklyCandidateCanonicalMedia,weeklyCandidateExactAnalysisOperationId,WEEKLY_CANDIDATE_EXACT_ANALYSIS_OPERATIONS,WEEKLY_CANDIDATE_EXACT_ANALYSIS_RECEIPTS,type WeeklyCandidateExactAnalysisPorts} from './weeklyCandidateExactAnalysisOperation.js';
import {openWeeklyCandidateExactProductionEscrow,openWeeklyCandidateExactProductionEscrowV2,prepareWeeklyCandidateExactProductionEscrow,WEEKLY_CANDIDATE_EXACT_PRODUCTION_ESCROWS,type WeeklyCandidateExactProductionEscrow,type WeeklyCandidateExactProductionEscrowV2} from './weeklyCandidateExactProductionEscrow.js';
import {withWeeklyCandidateDynamicExactPaidScope} from './weeklyCandidateExactPaidRequests.js';
import {readWeeklyCandidateExactConservativeSettlement,readWeeklyCandidateExactConservativeSettlementV2,type WeeklyCandidateExactAuditReader} from './weeklyCandidateExactConservativeSettlement.js';
import type {WeeklyCandidateDynamicExactHeadAnchorV2,WeeklyCandidateDynamicExactPlanV2} from './weeklyCandidateExactPaidRequests.js';
import {readWeeklyAutomationTemplate} from '../socialPrograms/weeklyAutomationTemplate.js';
import {readIndependentAdmission} from '../socialPrograms/weeklyIndependentAdmission.js';
import {weeklyCandidateExactJobBindingHash} from './weeklyCandidateExactFormalPorts.js';
import {weeklyCandidateExactRunBindingHash} from './weeklyCandidateExactRunBinding.js';
import {PREPRODUCTION_RETRY_ATTEMPTS} from './weeklyPreproductionRetryAttempts.js';
import {WEEKLY_PREPRODUCTION_JOBS} from './weeklyPreproductionProducer.js';
import {SocialContentTaskBudget,type SocialTaskBudgetOperation,type SocialTaskBudgetScope} from '../lib/socialContentTaskBudget.js';
import {socialJson,socialObject,socialRequestHash} from '../starter198/socialContentValidation.js';

type Job=WeeklyPreproductionJob|WeeklyPreproductionRetryAttempt;
type AnalysisInput={job:Job;run:SocialInspirationCollectionRun;record:Record_;operationId:string};

/**
 * Uses the accepted weekly production budget as the authorization parent while
 * retaining the existing exact-analysis claim, paid request journal and
 * independent platform-audit settlement. It never treats a user confirmation
 * as supplier evidence and never grants publishing or acceptance.
 */
export async function prepareWeeklyCandidateExactProductionEscrowPorts(input:{
 store:DataStore;mediaRoot:string;ledgerRoot:string;job:Job;run:SocialInspirationCollectionRun;configurationHash:string;
 provider:{endpoint:string;credentialSha256:string;model:'qwen3-vl-plus';tariffEvidenceHash:string;auditApiKeyId:string};
 auditReader:WeeklyCandidateExactAuditReader;runAnalysis:(input:AnalysisInput)=>Promise<void>;
}):Promise<WeeklyCandidateExactAnalysisPorts>{
 const ids=[...new Set(Object.values(input.run.evidenceOutcomes??{}).flatMap(outcome=>[
  ...(outcome?.acceptedCandidateIds??[]),...(outcome?.suggestionCandidateIds??[]),...(outcome?.failedCandidateIds??[]),
 ]))];
 if(ids.length!==5)throw Error('weekly_candidate_exact_production_escrow_five_candidates_required');
 const candidates=[] as Array<{candidateId:string;mediaSha256:string;operationId:string}>;
 for(const candidateId of ids){const record=await input.store.getById<Record_>('trend_videos',candidateId);if(!record||record.tenantId!==input.job.tenantId)throw Error('weekly_candidate_exact_production_escrow_candidate_changed');const canonical=await verifiedWeeklyCandidateCanonicalMedia(record,input.mediaRoot);if(!canonical)throw Error('weekly_candidate_exact_production_escrow_canonical_required');candidates.push({candidateId,mediaSha256:canonical.sha256,operationId:weeklyCandidateExactAnalysisOperationId(input.job,input.run,record,canonical.sha256)});}
 const handle=await prepareWeeklyCandidateExactProductionEscrow({store:input.store,job:input.job,run:input.run,root:input.ledgerRoot,provider:input.provider,candidates});
 const plans=new Map<string,{authorizationId:string;authorizationHash:string;maximumRequests:number;maximumCny:number}>();
 const plan=(candidateId:string,mediaSha256:string,operationId:string)=>({operationId,candidateId,mediaSha256,endpoint:input.provider.endpoint,credentialSha256:input.provider.credentialSha256,model:input.provider.model,maximumRequests:handle.escrow.maximumRequestsPerCandidate,maximumTotalCny:handle.escrow.maximumCnyPerCandidate});
 return{
  authorize:async({job,run,record,mediaSha256,operationId})=>{if(job.jobId!==input.job.jobId||run.runId!==input.run.runId)throw Error('weekly_candidate_exact_production_escrow_scope_changed');const reservation=await handle.reserve(record.id,mediaSha256,operationId);plans.set(operationId,reservation);return{authorizationId:reservation.authorizationId,authorizationHash:reservation.authorizationHash};},
  execute:async({job,run,record,mediaSha256,operationId,authorizationId,authorizationHash})=>{const reservation=plans.get(operationId);if(job.jobId!==input.job.jobId||run.runId!==input.run.runId||!reservation||reservation.authorizationId!==authorizationId||reservation.authorizationHash!==authorizationHash)throw Error('weekly_candidate_exact_production_escrow_fresh_reservation_required');await withWeeklyCandidateDynamicExactPaidScope({root:input.ledgerRoot,authorizationHash,plan:plan(record.id,mediaSha256,operationId),configurationHash:input.configurationHash,assertCurrent:handle.assertCurrent,run:()=>input.runAnalysis({job,run,record,operationId})});},
  readSettledReceipt:async({operationId,authorizationId,authorizationHash,mediaSha256,candidateId})=>{if(authorizationId!==handle.escrow.escrowId||authorizationHash!==handle.escrow.recordHash||!handle.escrow.candidates.some(candidate=>candidate.operationId===operationId&&candidate.candidateId===candidateId&&candidate.mediaSha256===mediaSha256))throw Error('weekly_candidate_exact_production_escrow_authorization_changed');return readWeeklyCandidateExactConservativeSettlement({root:input.ledgerRoot,authorizationId,authorizationHash,plan:plan(candidateId,mediaSha256,operationId),auditApiKeyId:input.provider.auditApiKeyId,assertCurrent:handle.assertCurrent,reader:input.auditReader});},
 };
}

type ExactReceipt={schema:'weekly-candidate-exact-analysis-receipt.v1';operationId:string;tenantId:string;jobId:string;runId:string;candidateId:string;mediaSha256:string;authorizationHash:string;providerRequestHash:string;providerReceiptRef:string;ledgerOutcomeHash:string;analysisRunId:string;recordSnapshotHash:string;settlementBasis?:'original_billing'|'conservative_upper_bound';recordedUpperBoundCny?:number};
const hash64=/^[a-f0-9]{64}$/;
const failCarry=(code:string):never=>{throw Error(`weekly_candidate_exact_production_carry_${code}`);};
async function unique<T=Record_>(store:DataStore,collection:string,where:Record<string,string|number>):Promise<T>{const rows=await store.list<T>(collection,{where,perPage:2});if(rows.totalItems!==1||rows.items.length!==1)failCarry(`${collection}_missing_or_ambiguous`);return rows.items[0]!;}

/** Move one settled exact-analysis charge into its canonical original-content
 * ledger. Read mode performs every authority/evidence check but never writes.
 * Carry mode fsyncs the target task ledger first and only then marks the source
 * escrow, so a crash between the two writes is safely replayable. */
export async function carryForwardWeeklyCandidateExactProductionCost(input:{
 store:DataStore;escrowRoot:string;scope:SocialTaskBudgetScope;taskRow:Record_;budget:SocialContentTaskBudget;
 mode:'read'|'carry';afterTargetWrite?:()=>Promise<void>;
}){
 if(!input.taskRow||input.taskRow.tenant_id!==input.scope.tenantId||input.taskRow.task_id!==input.scope.taskId||input.taskRow.run_id!==input.scope.runId||input.scope.budgetTaskId!==undefined)return null;
 const brief=socialObject(socialJson(input.taskRow.brief)),authority=socialObject(brief?._weeklyAuthority),frozenPackage=socialObject(authority?.weeklyPackage),frozenPublication=socialObject(authority?.publicationTask);
 if(!frozenPackage||!frozenPublication)return null;
 const packageId=String(frozenPackage.packageId??''),packageVersion=Number(frozenPackage.version),programId=String(frozenPackage.programId??''),publicationTaskId=String(frozenPublication.publicationTaskId??''),motherContentId=String(frozenPublication.motherContentId??'');
 if(!packageId||!programId||!publicationTaskId||!motherContentId||!Number.isSafeInteger(packageVersion)||packageVersion<=0)failCarry('weekly_authority_invalid');
 const packageRow=await unique<Record_>(input.store,'social_weekly_operating_packages',{tenant_id:input.scope.tenantId,program_id:programId,package_id:packageId,version:packageVersion}),pkg=packageRow.payload as WeeklyOperatingPackage,frozenPkg=frozenPackage as unknown as WeeklyOperatingPackage;
 if(!pkg||pkg.packageId!==packageId||pkg.programId!==programId||pkg.version!==packageVersion||!['draft','active'].includes(pkg.status))failCarry('package_changed');
 const escrowRows=await input.store.list<Record_>(WEEKLY_CANDIDATE_EXACT_PRODUCTION_ESCROWS,{where:{tenant_id:input.scope.tenantId,program_id:programId,package_id:packageId,package_version:packageVersion},perPage:2});
 if(!escrowRows.totalItems)return null;if(escrowRows.totalItems!==1||escrowRows.items.length!==1)failCarry('escrow_missing_or_ambiguous');
 if(!frozenPkg.agentPlanning?.dispatch)failCarry('package_changed');
 const agentPlanning=frozenPkg.agentPlanning!;
 const publication=pkg.socialContentPackage.publicationTasks.find(item=>item.publicationTaskId===publicationTaskId);
 const frozenPublicationCurrent=frozenPkg.socialContentPackage?.publicationTasks?.find(item=>item.publicationTaskId===publicationTaskId);
 const slot=agentPlanning.skeleton.slots.find(item=>item.motherContentId===motherContentId&&item.publicationTaskIds.includes(publicationTaskId));
 const analysis=slot&&agentPlanning.directorAnalyses.find(item=>item.slotId===slot.slotId);
 if(!publication||publication.motherContentId!==motherContentId||!frozenPublicationCurrent||socialRequestHash(frozenPublicationCurrent)!==socialRequestHash(publication)||!slot||!analysis||analysis.benchmarkVideoRefs.length!==1)failCarry('candidate_mapping_invalid');
 const mappedAnalysis=analysis!;const candidateId=mappedAnalysis.benchmarkVideoRefs[0]!.id;
 const escrowRow=escrowRows.items[0]!,escrow=escrowRow.payload as WeeklyCandidateExactProductionEscrow;
 if(!escrow||escrowRow.id!==escrow.escrowId||escrowRow.record_hash!==escrow.recordHash||escrow.recordHash!==socialRequestHash({...escrow,recordHash:''})||escrow.packageHash!==socialRequestHash(packageRow.payload))failCarry('escrow_changed');
 const candidate=escrow.candidates.find(item=>item.candidateId===candidateId);
 if(!candidate)failCarry('candidate_not_escrowed');
 const escrowCandidate=candidate!;
 const operationRow=await input.store.getById<Record_>(WEEKLY_CANDIDATE_EXACT_ANALYSIS_OPERATIONS,escrowCandidate.operationId),receiptRow=await input.store.getById<Record_>(WEEKLY_CANDIDATE_EXACT_ANALYSIS_RECEIPTS,escrowCandidate.operationId);
 if(!operationRow||!receiptRow||typeof operationRow.record_hash!=='string'||typeof receiptRow.record_hash!=='string')failCarry('settled_receipt_invalid');
 const exactOperationRow=operationRow!,exactReceiptRow=receiptRow!,operation=socialObject(socialJson(exactOperationRow.payload)),receipt=exactReceiptRow.payload as ExactReceipt|undefined;
 if(!operation||!receipt)failCarry('settled_receipt_invalid');
 const exactOperation=operation!,exactReceipt=receipt!,sourceReceiptHash=exactReceiptRow.record_hash as string;
 if(exactOperationRow.record_hash!==exactOperation.recordHash||exactOperation.recordHash!==socialRequestHash({...exactOperation,recordHash:''})||sourceReceiptHash!==socialRequestHash(exactReceipt)||exactReceipt.schema!=='weekly-candidate-exact-analysis-receipt.v1'||exactReceipt.operationId!==escrowCandidate.operationId||exactReceipt.tenantId!==input.scope.tenantId||exactReceipt.jobId!==escrow.jobId||exactReceipt.runId!==escrow.runId||exactReceipt.candidateId!==candidateId||exactReceipt.mediaSha256!==escrowCandidate.mediaSha256||exactReceipt.authorizationHash!==escrow.recordHash||exactReceipt.analysisRunId!==escrowCandidate.operationId||exactReceipt.settlementBasis!=='conservative_upper_bound'||typeof exactReceipt.providerReceiptRef!=='string'||!exactReceipt.providerReceiptRef.startsWith(`qwen-audit-upper-bound:${escrowCandidate.operationId}:`)||!hash64.test(exactReceipt.providerRequestHash)||!hash64.test(exactReceipt.ledgerOutcomeHash)||!hash64.test(sourceReceiptHash)||!Number.isFinite(exactReceipt.recordedUpperBoundCny)||exactReceipt.recordedUpperBoundCny!<=0||exactReceipt.recordedUpperBoundCny!>escrow.maximumCnyPerCandidate)failCarry('settled_receipt_invalid');
 if(exactOperation.operationId!==escrowCandidate.operationId||exactOperation.authorizationId!==escrow.escrowId||exactOperation.authorizationHash!==escrow.recordHash||exactOperation.candidateId!==candidateId||exactOperation.mediaSha256!==escrowCandidate.mediaSha256||exactOperation.jobId!==escrow.jobId||exactOperation.runId!==escrow.runId||exactOperation.state!=='submitted_or_unknown')failCarry('operation_changed');
 const scope={tenantId:input.scope.tenantId,programId,packageId,packageVersion},jobRows=await Promise.all([input.store.getById<Record_>(WEEKLY_PREPRODUCTION_JOBS,escrow.jobId),input.store.getById<Record_>(PREPRODUCTION_RETRY_ATTEMPTS,escrow.jobId)]),jobRowsPresent=jobRows.filter((row):row is Record_=>Boolean(row)),runRow=await unique<SocialInspirationCollectionRun&Record_>(input.store,'social_discovery_runs',{tenant_id:input.scope.tenantId,runId:escrow.runId});
 if(jobRowsPresent.length!==1)failCarry('job_missing_or_ambiguous');const job=jobRowsPresent[0]!.payload as Job,run=runRow as SocialInspirationCollectionRun;
 const assertSourceCurrent=async()=>{const [livePackage,adoption,independent,liveEscrow,liveOperation,liveReceipt,liveJob,liveRun]=await Promise.all([unique<Record_>(input.store,'social_weekly_operating_packages',{tenant_id:input.scope.tenantId,program_id:programId,package_id:packageId,version:packageVersion}),readWeeklyAutomationTemplate(input.store,scope),readIndependentAdmission(input.store,scope),input.store.getById<Record_>(WEEKLY_CANDIDATE_EXACT_PRODUCTION_ESCROWS,escrow.escrowId),input.store.getById<Record_>(WEEKLY_CANDIDATE_EXACT_ANALYSIS_OPERATIONS,escrowCandidate.operationId),input.store.getById<Record_>(WEEKLY_CANDIDATE_EXACT_ANALYSIS_RECEIPTS,escrowCandidate.operationId),input.store.getById<Record_>(jobRowsPresent[0]===jobRows[0]?WEEKLY_PREPRODUCTION_JOBS:PREPRODUCTION_RETRY_ATTEMPTS,escrow.jobId),unique<SocialInspirationCollectionRun&Record_>(input.store,'social_discovery_runs',{tenant_id:input.scope.tenantId,runId:escrow.runId})]);if(socialRequestHash(livePackage.payload)!==escrow.packageHash||!adoption||socialRequestHash(adoption)!==escrow.templateAdoptionHash||!independent||socialRequestHash(independent)!==escrow.independentAdmissionHash||!liveEscrow||liveEscrow.record_hash!==escrow.recordHash||socialRequestHash(liveEscrow.payload)!==socialRequestHash(escrow)||!liveOperation||liveOperation.record_hash!==exactOperationRow.record_hash||socialRequestHash(liveOperation.payload)!==socialRequestHash(exactOperationRow.payload)||!liveReceipt||liveReceipt.record_hash!==sourceReceiptHash||socialRequestHash(liveReceipt.payload)!==socialRequestHash(exactReceiptRow.payload)||!liveJob||weeklyCandidateExactJobBindingHash(liveJob.payload as Job)!==escrow.jobHash||weeklyCandidateExactRunBindingHash(liveRun)!==escrow.runHash)failCarry('source_changed');};
 if(weeklyCandidateExactJobBindingHash(job)!==escrow.jobHash||weeklyCandidateExactRunBindingHash(run)!==escrow.runHash)failCarry('source_changed');
 const handle=openWeeklyCandidateExactProductionEscrow(input.escrowRoot,escrow,assertSourceCurrent);await assertSourceCurrent();const sourceLedger=input.mode==='read'?handle.readOnlyStatus():await handle.status(),sourceEntry=sourceLedger.entries[escrowCandidate.operationId];
 if(!sourceEntry||sourceEntry.candidateId!==candidateId||sourceEntry.mediaSha256!==escrowCandidate.mediaSha256||Math.round(exactReceipt.recordedUpperBoundCny!*1e6)>sourceEntry.reservedMicros||(sourceEntry.state==='carried_forward'&&sourceEntry.motherContentId!==motherContentId))failCarry('source_ledger_invalid');
 const targetOperation:SocialTaskBudgetOperation={operationId:escrowCandidate.operationId,fingerprint:socialRequestHash({source:'weekly_candidate_exact_analysis',escrowHash:escrow.recordHash,receiptHash:sourceReceiptHash,candidateId,mediaSha256:escrowCandidate.mediaSha256,motherContentId}),provider:'qwen',model:escrow.model,accountRef:`qwen:${escrow.credentialSha256}`,stage:'weekly_candidate_exact_analysis',shotId:null};
 const binding={schema:'social-task-preproduction-budget-binding.v1' as const,source:'weekly_candidate_exact_analysis' as const,tenantId:input.scope.tenantId,packageId,packageVersion,motherContentId,candidateId,sourceOperationId:escrowCandidate.operationId,sourceAuthorizationHash:escrow.recordHash,sourceLedgerOutcomeHash:exactReceipt.ledgerOutcomeHash,sourceReceiptHash,retainedUpperBoundCny:exactReceipt.recordedUpperBoundCny!};
 if(input.mode==='read')return{retainedUpperBoundCny:binding.retainedUpperBoundCny,operationId:escrowCandidate.operationId,contentLedgerRef:sourceEntry.contentLedgerRef};
 const carried=await input.budget.carryForwardPreproduction(input.scope,targetOperation,binding,async(scopeCandidate,operationCandidate,bindingCandidate)=>{await assertSourceCurrent();return socialRequestHash(scopeCandidate)===socialRequestHash(input.scope)&&socialRequestHash(operationCandidate)===socialRequestHash(targetOperation)&&socialRequestHash(bindingCandidate)===socialRequestHash(binding);});
 await input.afterTargetWrite?.();
 await handle.carryForward({candidateId,mediaSha256:escrowCandidate.mediaSha256,operationId:escrowCandidate.operationId,motherContentId,contentLedgerRef:carried.contentLedgerRef});
 return{retainedUpperBoundCny:binding.retainedUpperBoundCny,operationId:escrowCandidate.operationId,contentLedgerRef:carried.contentLedgerRef};
}

/** Dormant Phase 3B2 adapter. No production composition imports this symbol.
 * It derives the v2 settlement from the authenticated journal and audit source,
 * writes the original mother ledger first, then marks the source escrow. */
export async function carryForwardWeeklyCandidateExactProductionCostV2(input:{
 store:DataStore;exactRoot:string;scope:SocialTaskBudgetScope;taskRow:Record_;budget:SocialContentTaskBudget;
 mode:'read'|'carry';integrityKey:string;headAnchor:WeeklyCandidateDynamicExactHeadAnchorV2;auditReader:WeeklyCandidateExactAuditReader;
 afterTargetWrite?:()=>Promise<void>;
}){
 if(!input.taskRow||input.taskRow.tenant_id!==input.scope.tenantId||input.taskRow.task_id!==input.scope.taskId||
  input.taskRow.run_id!==input.scope.runId||input.scope.budgetTaskId!==undefined)return null;
 const brief=socialObject(socialJson(input.taskRow.brief)),authority=socialObject(brief?._weeklyAuthority),
  frozenPackage=socialObject(authority?.weeklyPackage),frozenPublication=socialObject(authority?.publicationTask);
 if(!frozenPackage||!frozenPublication)return null;
 const packageId=String(frozenPackage.packageId??''),packageVersion=Number(frozenPackage.version),programId=String(frozenPackage.programId??''),
  publicationTaskId=String(frozenPublication.publicationTaskId??''),motherContentId=String(frozenPublication.motherContentId??'');
 if(!packageId||!programId||!publicationTaskId||!motherContentId||!Number.isSafeInteger(packageVersion)||packageVersion<=0)
  failCarry('v2_weekly_authority_invalid');
 const packageRow=await unique<Record_>(input.store,'social_weekly_operating_packages',{tenant_id:input.scope.tenantId,program_id:programId,
  package_id:packageId,version:packageVersion}),pkg=packageRow.payload as WeeklyOperatingPackage,frozenPkg=frozenPackage as unknown as WeeklyOperatingPackage;
 if(!pkg||pkg.packageId!==packageId||pkg.programId!==programId||pkg.version!==packageVersion||!['draft','active'].includes(pkg.status)||
  socialRequestHash(frozenPkg)!==socialRequestHash(pkg)||!frozenPkg.agentPlanning?.dispatch)failCarry('v2_package_changed');
 const agentPlanning=frozenPkg.agentPlanning!;
 const publication=pkg.socialContentPackage.publicationTasks.find(item=>item.publicationTaskId===publicationTaskId),
  frozenPublicationCurrent=frozenPkg.socialContentPackage.publicationTasks.find(item=>item.publicationTaskId===publicationTaskId),
  slot=agentPlanning.skeleton.slots.find(item=>item.motherContentId===motherContentId&&item.publicationTaskIds.includes(publicationTaskId)),
  analysis=slot&&agentPlanning.directorAnalyses.find(item=>item.slotId===slot.slotId);
 if(!publication||publication.motherContentId!==motherContentId||!frozenPublicationCurrent||
  socialRequestHash(frozenPublicationCurrent)!==socialRequestHash(publication)||!slot||!analysis||analysis.benchmarkVideoRefs.length!==1)
  failCarry('v2_candidate_mapping_invalid');
 const candidateId=analysis!.benchmarkVideoRefs[0]!.id;
 const escrowRows=await input.store.list<Record_>(WEEKLY_CANDIDATE_EXACT_PRODUCTION_ESCROWS,{where:{tenant_id:input.scope.tenantId,
  program_id:programId,package_id:packageId,package_version:packageVersion},perPage:10});
 if(!escrowRows.totalItems)return null;
 if(escrowRows.totalItems!==1||escrowRows.items.length!==1)failCarry('v2_escrow_missing_or_ambiguous');
 const escrowRow=escrowRows.items[0]!,escrow=escrowRow.payload as WeeklyCandidateExactProductionEscrowV2;
 if(escrow.schema!=='weekly-candidate-exact-production-escrow.v2'||escrowRow.id!==escrow.escrowId||escrowRow.record_hash!==escrow.recordHash||
  escrow.recordHash!==socialRequestHash({...escrow,recordHash:''})||escrow.packageHash!==socialRequestHash(packageRow.payload))
  failCarry('v2_escrow_changed');
 const matching=escrow.candidates.filter(item=>item.candidateId===candidateId);
 if(matching.length!==1)failCarry('v2_candidate_not_escrowed');const candidate=matching[0]!;
 const jobRows=await Promise.all([input.store.getById<Record_>(WEEKLY_PREPRODUCTION_JOBS,escrow.jobId),
  input.store.getById<Record_>(PREPRODUCTION_RETRY_ATTEMPTS,escrow.jobId)]),present=jobRows.filter((row):row is Record_=>Boolean(row));
 if(present.length!==1)failCarry('v2_job_missing_or_ambiguous');
 const jobCollection=present[0]===jobRows[0]?WEEKLY_PREPRODUCTION_JOBS:PREPRODUCTION_RETRY_ATTEMPTS,job=present[0]!.payload as Job;
 const run=await unique<SocialInspirationCollectionRun&Record_>(input.store,'social_discovery_runs',{tenant_id:input.scope.tenantId,runId:escrow.runId});
 if(weeklyCandidateExactJobBindingHash(job)!==escrow.jobHash||weeklyCandidateExactRunBindingHash(run)!==escrow.runHash)
  failCarry('v2_source_changed');
 const sourceScope={tenantId:input.scope.tenantId,programId,packageId,packageVersion};
 const assertSourceCurrent=async()=>{
  const [livePackage,adoption,independent,liveEscrow,liveJob,liveRun]=await Promise.all([
   unique<Record_>(input.store,'social_weekly_operating_packages',{tenant_id:input.scope.tenantId,program_id:programId,package_id:packageId,version:packageVersion}),
   readWeeklyAutomationTemplate(input.store,sourceScope),readIndependentAdmission(input.store,sourceScope),
   input.store.getById<Record_>(WEEKLY_CANDIDATE_EXACT_PRODUCTION_ESCROWS,escrow.escrowId),input.store.getById<Record_>(jobCollection,escrow.jobId),
   unique<SocialInspirationCollectionRun&Record_>(input.store,'social_discovery_runs',{tenant_id:input.scope.tenantId,runId:escrow.runId})]);
  if(socialRequestHash(livePackage.payload)!==escrow.packageHash||!adoption||socialRequestHash(adoption)!==escrow.templateAdoptionHash||
   !independent||socialRequestHash(independent)!==escrow.independentAdmissionHash||!liveEscrow||liveEscrow.record_hash!==escrow.recordHash||
   socialRequestHash(liveEscrow.payload)!==socialRequestHash(escrow)||!liveJob||weeklyCandidateExactJobBindingHash(liveJob.payload as Job)!==escrow.jobHash||
   weeklyCandidateExactRunBindingHash(liveRun)!==escrow.runHash)failCarry('v2_source_changed');
 };
 const handle=openWeeklyCandidateExactProductionEscrowV2(input.exactRoot,escrow,assertSourceCurrent);
 const plan:WeeklyCandidateDynamicExactPlanV2={schema:'weekly-candidate-dynamic-exact-plan.v2',operationId:candidate.operationId,
  candidateId:candidate.candidateId,mediaSha256:candidate.mediaSha256,endpoint:escrow.endpoint,credentialSha256:escrow.credentialSha256,
  ledgerIntegrityKeySha256:escrow.ledgerIntegrityKeySha256,model:escrow.model,pricingEvidence:structuredClone(escrow.pricingEvidence),
  pricingEvidenceHash:escrow.pricingEvidenceHash,pricingPolicyHash:escrow.pricingPolicyHash,measurementPolicyHash:escrow.measurementPolicyHash,
  protocolMaximumRequests:escrow.protocolMaximumRequests,candidateMaximumMicros:escrow.candidateMaximumMicros};
 const readSettlement=async()=>readWeeklyCandidateExactConservativeSettlementV2({root:input.exactRoot,authorizationHash:escrow.recordHash,
  plan,integrityKey:input.integrityKey,assertReservedPlanForSettlement:handle.assertReservedPlanForSettlement,
  headAnchor:input.headAnchor,reader:input.auditReader});
 await assertSourceCurrent();const sourceEntry=handle.readOnlyStatus().entries[candidate.operationId];
 if(!sourceEntry||sourceEntry.candidateId!==candidate.candidateId||sourceEntry.mediaSha256!==candidate.mediaSha256)
  failCarry('v2_source_ledger_invalid');
 const settlement=await readSettlement();if(!settlement)return null;
 if(settlement.operationId!==candidate.operationId||settlement.candidateId!==candidate.candidateId||
  settlement.mediaSha256!==candidate.mediaSha256||settlement.authorizationId!==escrow.escrowId||
  settlement.authorizationHash!==escrow.recordHash||settlement.retainedOccupationMicros>sourceEntry.reservedMicros)
  failCarry('v2_settlement_changed');
 const targetOperation:SocialTaskBudgetOperation={operationId:candidate.operationId,fingerprint:socialRequestHash({
  source:'weekly_candidate_exact_analysis_v2',escrowHash:escrow.recordHash,settlementRecordHash:settlement.recordHash,
  journalHash:settlement.journalHash,candidateId:candidate.candidateId,mediaSha256:candidate.mediaSha256,motherContentId}),
  provider:'qwen',model:escrow.model,accountRef:`qwen:${escrow.credentialSha256}`,stage:'weekly_candidate_exact_analysis',shotId:null};
 const binding={schema:'social-task-preproduction-budget-binding.v1' as const,source:'weekly_candidate_exact_analysis' as const,
  tenantId:input.scope.tenantId,packageId,packageVersion,motherContentId,candidateId:candidate.candidateId,
  sourceOperationId:candidate.operationId,sourceAuthorizationHash:escrow.recordHash,sourceLedgerOutcomeHash:settlement.journalHash,
  sourceReceiptHash:settlement.recordHash,retainedUpperBoundCny:settlement.retainedOccupationMicros/1_000_000};
 if(sourceEntry.state==='carried_forward'&&(sourceEntry.motherContentId!==motherContentId||sourceEntry.settlementRecordHash!==settlement.recordHash||
  sourceEntry.retainedOccupationMicros!==settlement.retainedOccupationMicros))failCarry('v2_source_marker_changed');
 if(input.mode==='read')return{retainedUpperBoundCny:binding.retainedUpperBoundCny,operationId:candidate.operationId,
  contentLedgerRef:sourceEntry.contentLedgerRef,settlementRecordHash:settlement.recordHash};
 const carried=await input.budget.carryForwardPreproduction(input.scope,targetOperation,binding,async(scopeCandidate,operationCandidate,bindingCandidate)=>{
  await assertSourceCurrent();const current=await readSettlement();return Boolean(current&&current.recordHash===settlement.recordHash&&
   socialRequestHash(scopeCandidate)===socialRequestHash(input.scope)&&socialRequestHash(operationCandidate)===socialRequestHash(targetOperation)&&
   socialRequestHash(bindingCandidate)===socialRequestHash(binding));
 });
 await input.afterTargetWrite?.();
 await assertSourceCurrent();const current=await readSettlement();
 if(!current||current.recordHash!==settlement.recordHash||current.journalHash!==settlement.journalHash)failCarry('v2_settlement_changed');
 await handle.markCarriedForward({candidateId:candidate.candidateId,mediaSha256:candidate.mediaSha256,operationId:candidate.operationId,
  motherContentId,contentLedgerRef:carried.contentLedgerRef,settlementRecordHash:settlement.recordHash,
  retainedOccupationMicros:settlement.retainedOccupationMicros});
 return{retainedUpperBoundCny:binding.retainedUpperBoundCny,operationId:candidate.operationId,contentLedgerRef:carried.contentLedgerRef,
  settlementRecordHash:settlement.recordHash};
}
