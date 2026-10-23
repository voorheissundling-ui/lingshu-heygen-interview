import {createHash} from 'node:crypto';
import type {ExactQwenProviderReceipt} from '../agents/exactQwenScope.js';
import {createWeeklyCandidateDynamicExactPaidRequests,type WeeklyCandidateDynamicExactPlan} from './weeklyCandidateExactPaidRequests.js';
import {inspectWeeklyExactSupplierEnvelopes} from './weeklyCandidateExactProviderEnvelope.js';

const sha=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const supplierFacts=(r:ExactQwenProviderReceipt)=>({provider:r.provider,responseId:r.responseId,model:r.model,usage:r.usage,httpStatus:r.httpStatus,requestModel:r.requestModel,requestHash:r.requestHash});
const digest=/^[a-f0-9]{64}$/;
const fail=(code:string):never=>{throw Error(`weekly_candidate_exact_settlement_${code}`);};

/** These readers must be independent of the worker's response journal and
 * configured by the server, not supplied by a public route or content Agent.
 * No current production implementation satisfies this contract. */
export interface WeeklyCandidateExactIndependentReaders {
 /** A durable unknown claim has no local response ID. The independent supplier
  * source must then locate the original by the exact request hash; it must not
  * submit another request or infer a receipt from the worker journal. */
 readOriginalSupplierResponse:(input:{operationId:string;candidateId:string;requestHash:string;responseId:string|null})=>Promise<{receipt:ExactQwenProviderReceipt;sourceEvidenceHash:string}|null>;
 readOriginalBillingOutcome:(input:{operationId:string;authorizationHash:string;responseIds:string[]})=>Promise<{status:'settled';accountCredentialSha256:string;responseIds:string[];billedCny:number;sourceEvidenceHash:string}|null>;
}

/** Returns null for unknown originals; never settles merely because the SDK
 * received a response or because the local request journal says completed. */
export async function readWeeklyCandidateExactOriginalSettlement(input:{root:string;authorizationId:string;authorizationHash:string;plan:WeeklyCandidateDynamicExactPlan;assertCurrent:()=>Promise<void>;readers?:WeeklyCandidateExactIndependentReaders}){
 if(!input.readers)return null;
 await input.assertCurrent();
 const journal=createWeeklyCandidateDynamicExactPaidRequests({root:input.root,authorizationHash:input.authorizationHash,plan:input.plan,assertCurrent:input.assertCurrent});
 const recorded=await journal.readRecordedChildren();
 if(recorded.entries.length===0)return null;
 const originals:Array<{receipt:ExactQwenProviderReceipt;sourceEvidenceHash:string}>=[];
 for(const child of recorded.entries){
  const original=await input.readers.readOriginalSupplierResponse({operationId:input.plan.operationId,candidateId:input.plan.candidateId,requestHash:child.requestHash,responseId:child.response?.responseId??null});
  if(!original)return null;
  // Re-reading the supplier may have a new observation timestamp. The stable
  // provider ID, request, model, status and exact usage must still agree when
  // a local response exists. For an unknown claim, the original is validated
  // against its reserved request envelope below, never trusted by ID alone.
  if(!digest.test(original.sourceEvidenceHash)||child.response&&sha(supplierFacts(original.receipt))!==sha(supplierFacts(child.response)))fail('supplier_original_changed');
  originals.push(original);
 }
 const responseIds=originals.map(o=>o.receipt.responseId);
 if(responseIds.some(id=>typeof id!=='string'||!id)||new Set(responseIds).size!==responseIds.length)return fail('duplicate_original_response');
 const verifiedResponseIds=responseIds as string[];
 const billing=await input.readers.readOriginalBillingOutcome({operationId:input.plan.operationId,authorizationHash:input.authorizationHash,responseIds:verifiedResponseIds});
 if(!billing)return null;
 if(billing.status!=='settled'||billing.accountCredentialSha256!==input.plan.credentialSha256||
  !digest.test(billing.sourceEvidenceHash)||billing.responseIds.length!==responseIds.length||
  billing.responseIds.some((id,i)=>id!==responseIds[i])||!Number.isFinite(billing.billedCny)||billing.billedCny<0||
  billing.billedCny>input.plan.maximumTotalCny+1e-9)fail('billing_original_changed');
 const envelope=inspectWeeklyExactSupplierEnvelopes({operationId:input.plan.operationId,candidateId:input.plan.candidateId,mediaSha256:input.plan.mediaSha256,
  endpoint:input.plan.endpoint,credentialSha256:input.plan.credentialSha256,model:input.plan.model,maximumTotalCny:input.plan.maximumTotalCny,
  requests:recorded.entries.map(e=>({requestHash:e.requestHash,maximumInputTokens:e.maximumInputTokens,maximumOutputTokens:e.maximumOutputTokens})),
  responses:recorded.entries.map((e,i)=>({requestHash:e.requestHash,response:originals[i]!.receipt}))});
 const receiptRef=`qwen-original:${input.plan.operationId}:${sha(originals.map(o=>o.sourceEvidenceHash))}:${billing.sourceEvidenceHash}`;
 return {status:'completed' as const,operationId:input.plan.operationId,authorizationHash:input.authorizationHash,mediaSha256:input.plan.mediaSha256,
  providerRequestHash:envelope.requestSetHash,providerReceiptRef:receiptRef,ledgerOutcomeHash:sha({journal:recorded.ledgerHash,billing:billing.sourceEvidenceHash,responseIds,
   billedCny:billing.billedCny}),authorizationId:input.authorizationId,requestCount:envelope.requestCount,recordedUpperBoundCny:envelope.reservedUpperBoundCny};
}
