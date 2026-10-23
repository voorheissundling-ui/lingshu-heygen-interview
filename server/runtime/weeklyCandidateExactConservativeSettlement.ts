import {createHash} from 'node:crypto';
import {createWeeklyCandidateDynamicExactPaidRequests,createWeeklyCandidateDynamicExactPaidRequestsV2,type WeeklyCandidateDynamicExactHeadAnchorV2,type WeeklyCandidateDynamicExactPlan,type WeeklyCandidateDynamicExactPlanV2} from './weeklyCandidateExactPaidRequests.js';
import {inspectWeeklyExactSupplierEnvelopes} from './weeklyCandidateExactProviderEnvelope.js';
import {verifyQwenMaaSPublishedPricingEvidenceForHistoricalSettlement} from '../lib/socialContentPublishedTariffs.js';

const sha=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const digest=/^[a-f0-9]{64}$/;
const fail=(code:string):never=>{throw Error(`weekly_candidate_exact_conservative_${code}`);};

/** Must read platform-side audit originals, not the worker journal or a
 * caller-supplied summary. The audit records usage, not the actual bill. */
export interface WeeklyCandidateExactAuditReader {
 readOriginalAuditRequest:(input:{requestId:string;operationId:string;candidateId:string})=>Promise<{
  requestId:string;apiKeyId:string;model:string;status:number;
  usage:{prompt_tokens:number;completion_tokens:number;total_tokens:number};sourceEvidenceHash:string;
 }|null>;
}

/** A signed upper-bound budget occupation, never an actual-fee settlement.
 * Only response-recorded requests with an observed platform Request ID can be
 * matched to independent audit usage. Unknown POST outcomes remain blocked. */
export async function readWeeklyCandidateExactConservativeSettlement(input:{root:string;authorizationId:string;authorizationHash:string;
 plan:WeeklyCandidateDynamicExactPlan;auditApiKeyId:string;assertCurrent:()=>Promise<void>;reader?:WeeklyCandidateExactAuditReader}){
 if(!input.reader)return null;
 await input.assertCurrent();
 const journal=createWeeklyCandidateDynamicExactPaidRequests({root:input.root,authorizationHash:input.authorizationHash,plan:input.plan,assertCurrent:input.assertCurrent});
 const recorded=await journal.readRecordedChildren();
 if(!recorded.entries.length||recorded.entries.some(e=>e.state!=='response_recorded'||!e.response?.responseId||!e.response.providerRequestId))return null;
 const requestIds=recorded.entries.map(e=>e.response!.providerRequestId!);
 if(new Set(requestIds).size!==requestIds.length)return fail('duplicate_audit_request');
 const auditHashes:string[]=[];
 for(const entry of recorded.entries){
  const local=entry.response!,requestId=local.providerRequestId!;
  const audit=await input.reader.readOriginalAuditRequest({requestId,operationId:input.plan.operationId,candidateId:input.plan.candidateId});
  if(!audit)return null;
  const localUsage=local.usage as Partial<typeof audit.usage>|null;
  if(!digest.test(audit.sourceEvidenceHash)||audit.requestId!==requestId||audit.apiKeyId!==input.auditApiKeyId||
   audit.model!==input.plan.model||audit.status!==200||!localUsage||
   audit.usage?.prompt_tokens!==localUsage.prompt_tokens||audit.usage?.completion_tokens!==localUsage.completion_tokens||
   audit.usage?.total_tokens!==localUsage.total_tokens)fail('audit_original_changed');
  auditHashes.push(audit.sourceEvidenceHash);
 }
 const envelope=inspectWeeklyExactSupplierEnvelopes({operationId:input.plan.operationId,candidateId:input.plan.candidateId,mediaSha256:input.plan.mediaSha256,
  endpoint:input.plan.endpoint,credentialSha256:input.plan.credentialSha256,model:input.plan.model,maximumTotalCny:input.plan.maximumTotalCny,
  requests:recorded.entries.map(e=>({requestHash:e.requestHash,maximumInputTokens:e.maximumInputTokens,maximumOutputTokens:e.maximumOutputTokens})),
  responses:recorded.entries.map(e=>({requestHash:e.requestHash,response:e.response!}))});
 if(envelope.reservedUpperBoundCny>input.plan.maximumTotalCny+1e-9)return fail('authorized_ceiling_exceeded');
 return {status:'completed' as const,settlementBasis:'conservative_upper_bound' as const,operationId:input.plan.operationId,
  authorizationHash:input.authorizationHash,mediaSha256:input.plan.mediaSha256,providerRequestHash:envelope.requestSetHash,
  providerReceiptRef:`qwen-audit-upper-bound:${input.plan.operationId}:${sha(auditHashes)}`,
  ledgerOutcomeHash:sha({basis:'conservative_upper_bound',journal:recorded.ledgerHash,auditHashes,requestIds,
   reservedUpperBoundCny:envelope.reservedUpperBoundCny}),authorizationId:input.authorizationId,
  requestCount:envelope.requestCount,recordedUpperBoundCny:envelope.reservedUpperBoundCny};
}

export interface WeeklyCandidateExactConservativeSettlementV2{
 schema:'weekly-candidate-exact-conservative-settlement.v2';status:'completed';settlementBasis:'conservative_upper_bound_occupation';
 supplierBillingBasis:'platform_audit_usage_not_invoice';operationId:string;candidateId:string;mediaSha256:string;
 authorizationId:string;authorizationHash:string;planHash:string;pricingEvidenceHash:string;pricingPolicyHash:string;measurementPolicyHash:string;
 candidateMaximumMicros:number;headGeneration:number;headLedgerHash:string;journalGeneration:number;journalHash:string;previousHeadHash:string|null;
 children:Array<{sequence:number;requestBodySha256:string;providerRequestId:string;responseId:string;model:'qwen3-vl-plus';httpStatus:200;
  usage:{prompt_tokens:number;completion_tokens:number;total_tokens:number};auditSourceEvidenceHash:string;reservedUpperBoundMicros:number;measuredCeilingMicros:number}>;
 auditSetHash:string;requestCount:number;reservedUpperBoundMicros:number;retainedOccupationMicros:number;measuredCeilingMicros:number;recordHash:string;
}

/** Dormant v2 read model. Platform audit proves independently observed usage,
 * not an invoice; measured usage never releases the already persisted hold. */
export async function readWeeklyCandidateExactConservativeSettlementV2(input:{root:string;authorizationHash:string;
 plan:WeeklyCandidateDynamicExactPlanV2;integrityKey:string;
 assertReservedPlanForSettlement:(plan:WeeklyCandidateDynamicExactPlanV2,authorizationHash:string)=>Promise<{
  authorizationId:string;authorizationHash:string;auditApiKeyId:string;
 }>;
 headAnchor:WeeklyCandidateDynamicExactHeadAnchorV2;reader:WeeklyCandidateExactAuditReader;
}):Promise<WeeklyCandidateExactConservativeSettlementV2|null>{
 if(!input.reader||typeof input.reader.readOriginalAuditRequest!=='function')return fail('v2_audit_reader_required');
 const authority=await input.assertReservedPlanForSettlement(input.plan,input.authorizationHash);
 if(!authority||authority.authorizationHash!==input.authorizationHash||!/^[a-f0-9]{24}$/.test(authority.authorizationId)||
  !/^[A-Za-z0-9._:-]{1,256}$/.test(authority.auditApiKeyId))return fail('v2_authority_binding_changed');
 const historical=verifyQwenMaaSPublishedPricingEvidenceForHistoricalSettlement(input.plan.pricingEvidence,
  {baseUrl:input.plan.endpoint,credentialSha256:input.plan.credentialSha256});
 if(!historical||historical.evidenceHash!==input.plan.pricingEvidenceHash||historical.pricingPolicyHash!==input.plan.pricingPolicyHash)
  return fail('v2_pricing_evidence_changed');
 const journal=createWeeklyCandidateDynamicExactPaidRequestsV2({root:input.root,authorizationHash:input.authorizationHash,plan:input.plan,
  integrityKey:input.integrityKey,assertAuthorizedPlan:async(plan,hash)=>{await input.assertReservedPlanForSettlement(plan,hash);},headAnchor:input.headAnchor});
 const {ledger,head}=await journal.readAnchoredSnapshot();
 if(!ledger.entries.length||ledger.entries.some(entry=>entry.state!=='response_recorded'||!entry.response?.providerRequestId))return null;
 if(head.generation!==ledger.generation||head.ledgerHash!==sha(ledger)||ledger.pricingEvidenceHash!==input.plan.pricingEvidenceHash||
  ledger.pricingPolicyHash!==input.plan.pricingPolicyHash||ledger.measurementPolicyHash!==input.plan.measurementPolicyHash)
  return fail('v2_anchored_journal_changed');
 const requestIds=ledger.entries.map(entry=>entry.response!.providerRequestId!),responseIds=ledger.entries.map(entry=>entry.response!.responseId);
 if(new Set(requestIds).size!==requestIds.length||new Set(responseIds).size!==responseIds.length)return fail('v2_duplicate_provider_identity');
 const audits=await Promise.all(ledger.entries.map(entry=>input.reader.readOriginalAuditRequest({requestId:entry.response!.providerRequestId!,
  operationId:input.plan.operationId,candidateId:input.plan.candidateId})));
 if(audits.some(value=>!value))return null;
 const sourceHashes=new Set<string>();
 const children=ledger.entries.map((entry,index)=>{
  const response=entry.response!,audit=audits[index]!,usage=audit!.usage,requestId=response.providerRequestId!;
  if(!digest.test(audit!.sourceEvidenceHash)||sourceHashes.has(audit!.sourceEvidenceHash)||audit!.requestId!==requestId||
   audit!.apiKeyId!==authority.auditApiKeyId||audit!.model!==input.plan.model||audit!.status!==200||response.model!==input.plan.model||
   response.requestModel!==input.plan.model||response.httpStatus!==200||response.requestHash!==entry.requestBodySha256||
   !Number.isSafeInteger(usage?.prompt_tokens)||usage.prompt_tokens<0||usage.prompt_tokens>entry.inputTokenCeiling||
   !Number.isSafeInteger(usage?.completion_tokens)||usage.completion_tokens<0||usage.completion_tokens>entry.outputTokenCeiling||
   !Number.isSafeInteger(usage?.total_tokens)||usage.total_tokens!==usage.prompt_tokens+usage.completion_tokens||
   JSON.stringify(response.usage)!==JSON.stringify(usage))return fail('v2_audit_original_changed');
  sourceHashes.add(audit!.sourceEvidenceHash);
  const measuredCeilingMicros=Math.ceil(usage.prompt_tokens*entry.inputPriceCnyPerMillion+usage.completion_tokens*entry.outputPriceCnyPerMillion);
  if(!Number.isSafeInteger(measuredCeilingMicros)||measuredCeilingMicros<0||measuredCeilingMicros>entry.reservedMicros)
   return fail('v2_measured_ceiling_exceeded');
  return {sequence:entry.sequence,requestBodySha256:entry.requestBodySha256,providerRequestId:requestId,responseId:response.responseId!,
   model:response.model as 'qwen3-vl-plus',httpStatus:200 as const,usage:structuredClone(usage),auditSourceEvidenceHash:audit!.sourceEvidenceHash,
   reservedUpperBoundMicros:entry.reservedMicros,measuredCeilingMicros};
 });
 const reservedUpperBoundMicros=children.reduce((sum,child)=>sum+child.reservedUpperBoundMicros,0),
  measuredCeilingMicros=children.reduce((sum,child)=>sum+child.measuredCeilingMicros,0);
 if(!Number.isSafeInteger(reservedUpperBoundMicros)||reservedUpperBoundMicros<=0||reservedUpperBoundMicros>input.plan.candidateMaximumMicros)
  return fail('v2_authorized_ceiling_exceeded');
 const body={schema:'weekly-candidate-exact-conservative-settlement.v2' as const,status:'completed' as const,
  settlementBasis:'conservative_upper_bound_occupation' as const,supplierBillingBasis:'platform_audit_usage_not_invoice' as const,
  operationId:input.plan.operationId,candidateId:input.plan.candidateId,mediaSha256:input.plan.mediaSha256,authorizationId:authority.authorizationId,
  authorizationHash:input.authorizationHash,planHash:ledger.planHash,pricingEvidenceHash:ledger.pricingEvidenceHash,
  pricingPolicyHash:ledger.pricingPolicyHash,measurementPolicyHash:ledger.measurementPolicyHash,candidateMaximumMicros:input.plan.candidateMaximumMicros,
  headGeneration:head.generation,headLedgerHash:head.ledgerHash,journalGeneration:ledger.generation,journalHash:sha(ledger),
  previousHeadHash:ledger.previousHeadHash,children,auditSetHash:sha(children.map(child=>({requestId:child.providerRequestId,
   sourceEvidenceHash:child.auditSourceEvidenceHash}))),requestCount:children.length,reservedUpperBoundMicros,
  retainedOccupationMicros:reservedUpperBoundMicros,measuredCeilingMicros};
 return {...body,recordHash:sha({...body,recordHash:''})};
}
