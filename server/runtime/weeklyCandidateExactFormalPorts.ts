import fs from 'node:fs';
import path from 'node:path';
import type {Record_} from '../storage/datastore.js';
import type {SocialInspirationCollectionRun} from '../../shared/contracts/socialContentWorkflow.js';
import type {WeeklyPreproductionJob} from './weeklyPreproductionProducer.js';
import type {WeeklyPreproductionRetryAttempt} from './weeklyPreproductionRetryAttempts.js';
import {socialRequestHash} from '../starter198/socialContentValidation.js';
import {weeklyCandidateExactRunBindingHash} from './weeklyCandidateExactRunBinding.js';
import {createWeeklyCandidateExactFormalAuthority,type WeeklyCandidateExactAuthorityReader} from './weeklyCandidateExactFormalAuthority.js';
import {withWeeklyCandidateDynamicExactPaidScope} from './weeklyCandidateExactPaidRequests.js';
import {readWeeklyCandidateExactOriginalSettlement,type WeeklyCandidateExactIndependentReaders} from './weeklyCandidateExactOriginalSettlement.js';
import {readWeeklyCandidateExactConservativeSettlement,type WeeklyCandidateExactAuditReader} from './weeklyCandidateExactConservativeSettlement.js';
import type {WeeklyCandidateExactAnalysisPorts} from './weeklyCandidateExactAnalysisOperation.js';

type Job=WeeklyPreproductionJob|WeeklyPreproductionRetryAttempt;
type AnalysisInput={job:Job;run:SocialInspirationCollectionRun;record:Record_;operationId:string};

/** The producer legitimately changes status, code, results and updatedAt
 * while the original paid operation is awaiting its supplier/billing receipt.
 * Sign only the immutable job authority, including child retry lineage. */
export function weeklyCandidateExactJobBindingHash(job:Job):string{
 const retry='retry' in job?job.retry:null;
 return socialRequestHash({tenantId:job.tenantId,programId:job.programId,packageId:job.packageId,packageVersion:job.packageVersion,
  jobId:job.jobId,consumerTaskId:job.consumerTaskId,consumerInputHash:job.consumerInputHash,kind:job.kind,
  originalRunKey:job.originalRunKey,actorUserId:job.actorUserId,dueAt:job.dueAt,boundAt:job.boundAt,
  sourceHash:job.sourceHash,authority:job.authority,retry});
}

/** Integration boundary for a separately issued five-candidate authority.
 * There is intentionally no production singleton: the issuer, original
 * supplier/billing readers, and analysis runner must all be installed by a
 * trusted server composition root before any paid request is possible. */
export function createWeeklyCandidateExactFormalPorts(input:{
 root:string;job:Job;run:SocialInspirationCollectionRun;authorityReader:WeeklyCandidateExactAuthorityReader;
 originalReaders?:WeeklyCandidateExactIndependentReaders;auditReader?:WeeklyCandidateExactAuditReader;configurationHash:string;
 runAnalysis:(input:AnalysisInput)=>Promise<void>;
}):WeeklyCandidateExactAnalysisPorts{
 const {job,run}=input;
 if(!job.authority||!input.configurationHash||!/^[a-f0-9]{64}$/.test(input.configurationHash)||
  Number(!!input.originalReaders)+Number(!!input.auditReader)!==1)throw Error('weekly_candidate_exact_formal_configuration_invalid');
 const scope={tenantId:job.tenantId,programId:job.programId,packageId:job.packageId,packageVersion:job.packageVersion,
  jobId:job.jobId,jobHash:weeklyCandidateExactJobBindingHash(job),runId:run.runId,runHash:weeklyCandidateExactRunBindingHash(run),
  scopeId:job.authority.scopeId,scopeVersion:job.authority.scopeVersion};
 const authority=createWeeklyCandidateExactFormalAuthority({root:input.root,scope,reader:input.authorityReader});
 const check=(j:Job,r:SocialInspirationCollectionRun)=>{
  if(weeklyCandidateExactJobBindingHash(j)!==scope.jobHash||weeklyCandidateExactRunBindingHash(r)!==scope.runHash)throw Error('weekly_candidate_exact_formal_lineage_changed');
 };
 const plans=new Map<string,NonNullable<Awaited<ReturnType<typeof authority.reserve>>>>();
 const held=async(candidateId:string,mediaSha256:string,operationId:string,authorizationId:string,authorizationHash:string)=>{
  const reservation=await authority.readExistingHold(candidateId,mediaSha256,operationId,authorizationHash);
  if(reservation.authorizationId!==authorizationId||reservation.authorizationHash!==authorizationHash)throw Error('weekly_candidate_exact_formal_authorization_changed');
  return reservation;
 };
 return {
  authorize:async({job:j,run:r,record,mediaSha256,operationId})=>{
   check(j,r);
   const reservation=await authority.reserve(record.id,mediaSha256,operationId);
   if(!reservation)return null;
   plans.set(operationId,reservation);
   return {authorizationId:reservation.authorizationId,authorizationHash:reservation.authorizationHash};
  },
  execute:async({job:j,run:r,record,mediaSha256,operationId,authorizationId,authorizationHash})=>{
   check(j,r);
   const reservation=plans.get(operationId);
   if(!reservation||reservation.authorizationId!==authorizationId||reservation.authorizationHash!==authorizationHash||
    reservation.plan.candidateId!==record.id||reservation.plan.mediaSha256!==mediaSha256)throw Error('weekly_candidate_exact_formal_fresh_reservation_required');
   await authority.assertCurrent(record.id,mediaSha256,operationId,authorizationHash);
   await withWeeklyCandidateDynamicExactPaidScope({root:input.root,authorizationHash,plan:reservation.plan,
    configurationHash:input.configurationHash,
    assertCurrent:()=>authority.assertCurrent(record.id,mediaSha256,operationId,authorizationHash),
    run:()=>input.runAnalysis({job:j,run:r,record,operationId})});
  },
  readSettledReceipt:async({operationId,authorizationId,authorizationHash,mediaSha256,candidateId})=>{
   const reservation=await held(candidateId,mediaSha256,operationId,authorizationId,authorizationHash);
   if(reservation.settlementBasis==='conservative_upper_bound'){
    if(!input.auditReader||input.originalReaders||!reservation.auditApiKeyId)throw Error('weekly_candidate_exact_formal_accounting_basis_changed');
    return readWeeklyCandidateExactConservativeSettlement({root:input.root,authorizationId,authorizationHash,plan:reservation.plan,
     auditApiKeyId:reservation.auditApiKeyId,assertCurrent:()=>authority.assertOriginalForSettlement(candidateId,mediaSha256,operationId,authorizationHash),reader:input.auditReader});
   }
   if(!input.originalReaders||input.auditReader)throw Error('weekly_candidate_exact_formal_accounting_basis_changed');
   return readWeeklyCandidateExactOriginalSettlement({root:input.root,authorizationId,authorizationHash,plan:reservation.plan,
    assertCurrent:()=>authority.assertOriginalForSettlement(candidateId,mediaSha256,operationId,authorizationHash),readers:input.originalReaders});
  },
 };
}

/** Server deployment composition only. A route-supplied ledger path must
 * never split the shared five-candidate hold or the child request journal. */
export function prepareDeployedWeeklyCandidateExactFormalPorts(input:Omit<Parameters<typeof createWeeklyCandidateExactFormalPorts>[0],'root'>){
 const configured=process.env.WEEKLY_CANDIDATE_EXACT_LEDGER_ROOT;
 if(!configured||!path.isAbsolute(configured))throw Error('weekly_candidate_exact_formal_deployed_ledger_root_required');
 const absolute=path.resolve(configured),actual=fs.realpathSync(absolute);
 if(actual!==absolute||!fs.statSync(actual).isDirectory())throw Error('weekly_candidate_exact_formal_deployed_ledger_root_invalid');
 return createWeeklyCandidateExactFormalPorts({...input,root:actual});
}
