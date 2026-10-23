import path from 'node:path';
import {createHash} from 'node:crypto';
import type {DataStore,Record_} from '../storage/datastore.js';
import {getQwenProviderBinding} from '../agents/qwen.js';
import {createSocialContentTaskBudgetAuthority,type SocialPaidOperationIntent,type SocialVerifiedAccountTariff} from '../lib/socialContentTaskBudgetAuthority.js';
import {createSocialContentPaidOperationPermit} from '../lib/socialContentPaidOperationPermit.js';
import {createSocialContentVerifiedTariffReader} from '../lib/socialContentVerifiedTariffs.js';
import {createSocialContentLocalPublishedTariffReader} from '../lib/socialContentPublishedTariffs.js';
import type {MaterialAnalysisPaidCall} from '../digitalEmployees/materialAnalysisPaidOperation.js';
import {socialJson,socialObject,socialRequestHash,socialText} from '../starter198/socialContentValidation.js';
import type {CandidateContextAssessment} from './candidateContextAssessment.js';

export interface CandidateSemanticBudgetResolverPorts {
  binding?:()=>{baseUrl:string;credentialSha256:string;materialModel:string};
  readTariff?:(intent:SocialPaidOperationIntent)=>Promise<SocialVerifiedAccountTariff|null>;
  measureInputTokens?:(body:Record<string,unknown>)=>Promise<number>;
  ledgerRoot?:string;
  permitRoot?:string;
}

const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const fail=(code:string):never=>{throw Error(`candidate_semantic_budget_${code}`);};
/** Qwen3-VL-Plus publishes 260,096 maximum input tokens; 262,144 is the
 * combined context, not an executable input allowance. Keep output headroom. */
export const QWEN3_VL_SEMANTIC_MAX_INPUT_TOKENS=260096;
const QWEN3_VL_SEMANTIC_MAX_REQUEST_BYTES=240000;

/** Text-only Qwen requests have no image-token ambiguity. Reserve the
 * documented maximum input (not the larger combined context) and keep the
 * serialized request below it with framing headroom. */
export async function measureCandidateSemanticInputUpperBound(body:Record<string,unknown>){
  if(!Array.isArray(body.messages))throw Error('candidate_semantic_budget_request_shape_unsupported');
  const messages = body.messages;
  if(typeof body.model!=='string'||!/^(qwen3-vl-(?:flash|plus)|qwen-vl-max)(?:-\d{4}-\d{2}-\d{2})?$/.test(body.model)
    ||messages.length!==1||!Number.isSafeInteger(body.max_tokens)||Number(body.max_tokens)!==1600
    ||Object.keys(body).some(key=>!['model','messages','temperature','response_format','max_tokens'].includes(key)))fail('request_shape_unsupported');
  const message=messages[0] as Record<string,unknown>;
  if(!message||message.role!=='user'||typeof message.content!=='string'||Object.keys(message).some(key=>!['role','content'].includes(key)))fail('request_shape_unsupported');
  const ceiling=String(body.model).startsWith('qwen-vl-max')?129024:QWEN3_VL_SEMANTIC_MAX_INPUT_TOKENS;
  if(Buffer.byteLength(JSON.stringify(body),'utf8')>Math.min(ceiling,QWEN3_VL_SEMANTIC_MAX_REQUEST_BYTES))fail('request_exceeds_context');
  return ceiling;
}

/** Resolve one candidate-semantic operation from an existing content task.
 * taskId is only a selector: reference identity, model/account, tariff and the
 * shared <=15 CNY authorization are all re-read from trusted server state. */
export async function resolveCandidateSemanticPaidCall(input:{store:DataStore;tenantId:string;taskId:string;candidateId:string;context:CandidateContextAssessment;ports?:CandidateSemanticBudgetResolverPorts}):Promise<MaterialAnalysisPaidCall>{
  const {store,tenantId,taskId,candidateId,context}=input,ports=input.ports??{};
  const readTask=async()=>{
    const rows=await store.list<Record_>('starter_social_content_tasks',{where:{tenant_id:tenantId,task_id:taskId},perPage:2});
    if(rows.totalItems!==1||rows.items.length!==1)return fail('task_missing_or_ambiguous');
    const row=rows.items[0]!,brief=socialObject(socialJson(row.brief)),reference=socialObject(socialJson(row.reference_video_analysis));
    if(row.tenant_id!==tenantId||socialText(row.task_id)!==taskId||reference?.referenceRecordId!==candidateId||reference?.status!=='ready')return fail('task_reference_unbound');
    const amount=Math.min(15,Number(brief?.perItemBudgetCny??15));
    if(!Number.isFinite(amount)||amount<=0)return fail('task_budget_invalid');
    return {row,amount,authorityHash:socialRequestHash({taskId,createdBy:row.created_by,brief,referenceRecordId:reference.referenceRecordId,referenceAnalysisId:reference.analysisId,contextHash:context.recordHash})};
  };
  const contextRow=await store.getById<Record_>('social_candidate_context_assessments',context.assessmentId);
  if(context.tenantId!==tenantId||context.candidateId!==candidateId||contextRow?.tenant_id!==tenantId||contextRow.record_hash!==context.recordHash
    ||context.recordHash!==socialRequestHash({...context,recordHash:''})||socialRequestHash(contextRow.payload)!==socialRequestHash(context))return fail('context_scope_invalid');
  const initial=await readTask(),binding=ports.binding?.()??getQwenProviderBinding();
  if(!/^[a-f0-9]{64}$/.test(binding.credentialSha256))return fail('provider_binding_invalid');
  const accountRef=`qwen:${sha(JSON.stringify({baseUrl:binding.baseUrl.replace(/\/+$/,''),credentialSha256:binding.credentialSha256}))}`;
  const operationId=`candidate-semantic:${context.assessmentId}`;
  const scope={tenantId,taskId,runId:`candidate-context:${taskId}`,planHash:socialRequestHash({taskId,contextHash:context.recordHash,operationId})};
  const intent:SocialPaidOperationIntent={operationId,provider:'qwen',model:binding.materialModel,accountRef,stage:'candidate_context_semantic',shotId:null,inputContractHash:context.recordHash,maximumUnits:{inputTokens:binding.materialModel.startsWith('qwen-vl-max')?129024:QWEN3_VL_SEMANTIC_MAX_INPUT_TOKENS,outputTokens:1600}};
  const plan={scope,authorizationRef:`task-budget:${initial.authorityHash}`,maximumCny:initial.amount,paidOperations:[intent]};
  const assertCurrent=async()=>{const current=await readTask();if(current.authorityHash!==initial.authorityHash||current.amount!==initial.amount)fail('task_authority_changed');};
  const durable=createSocialContentVerifiedTariffReader(store,tenantId),published=createSocialContentLocalPublishedTariffReader({readProviderBinding:async candidate=>candidate.operationId===operationId?{provider:'qwen',model:binding.materialModel,baseUrl:binding.baseUrl,credentialSha256:binding.credentialSha256}:null});
  const authority=createSocialContentTaskBudgetAuthority({ledgerRoot:ports.ledgerRoot,ports:{assertCurrent,readApprovedPlan:async()=>{await assertCurrent();return plan;},readVerifiedTariff:async candidate=>await ports.readTariff?.(candidate)||await durable.read(candidate)||await published.read(candidate),verifyRejection:async()=>false}});
  const reserved=await authority.prepareAndReserve(scope);
  const permit=createSocialContentPaidOperationPermit({...reserved,root:ports.permitRoot??path.join(ports.ledgerRoot||process.env.SOCIAL_CONTENT_TASK_BUDGET_DIR||'data/social-content-task-budget','.permits'),assertCurrent});
  return {requirementKey:operationId,intent,permit,measureInputTokens:ports.measureInputTokens??measureCandidateSemanticInputUpperBound,persistProviderReceipt:async({requestSha256,response})=>{
    await assertCurrent();if(!/^[a-f0-9]{64}$/.test(requestSha256)||response===undefined)fail('provider_receipt_invalid');
    // The semantic module persists the canonical response receipt in its data
    // store before invoking this callback. This ref binds ledger settlement to it.
    return `candidate-semantic-provider-receipt:${operationId}:${requestSha256}`;
  }};
}
