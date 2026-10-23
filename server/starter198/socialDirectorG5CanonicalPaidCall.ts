import {createHash} from 'node:crypto';
import {buildDirectorG5QwenRequest,getQwenProviderBinding} from '../agents/qwen.js';
import {createSocialContentPublishedTariffReader} from '../lib/socialContentPublishedTariffs.js';
import {quoteSocialPaidOperationTariff,type SocialPaidOperationIntent,type SocialVerifiedAccountTariff} from '../lib/socialContentTaskBudgetAuthority.js';
import {createProductionBudgetRouteReaders,productionBillingAccountRef} from './socialContentProductionBudgetRoutes.js';
import {createSocialContentPaidRuntimePorts,measureQwenRequestInputUpperBound} from './socialContentPaidRuntimePorts.js';
import {readDirectorG5OriginalFilmBudget,reserveDirectorG5CanonicalBudget} from './socialDirectorG5CanonicalBudget.js';
import {readContentExecutionJob} from '../contentExecution/durableQueue.js';
import type {Starter198Repository} from './repository.js';
import type {SocialDirectorG5Scope,SocialDirectorG5Context} from '../../shared/contracts/socialDirectorG5Review.js';
import type {DirectorG5Frame,DirectorG5RuntimeDescriptor} from './socialDirectorG5Runtime.js';
import {qwenVisionInputLimit} from '../lib/qwenVisionInputLimit.js';

export function assertDirectorG5FrozenCapacityEnvelope(capacity:{model:string;maximumUnits:{inputTokens?:number;outputTokens?:number}},model:string,maxTokens:number){
 if(capacity.model!==model||capacity.maximumUnits?.inputTokens!==qwenVisionInputLimit(model)
  ||capacity.maximumUnits?.outputTokens!==maxTokens)throw Error('director_g5_original_capacity_envelope_changed');
}

/** Builds the permit for the exact request later sent by the G5 runtime. The
 * published price is fetched from the official source at reservation time;
 * absence or parser drift stops before the provider POST. */
export async function resolveDirectorG5CanonicalPaidCall(input:{
 repository:Starter198Repository;scope:SocialDirectorG5Scope;requestId:string;
 context:SocialDirectorG5Context;frames:DirectorG5Frame[];descriptor:DirectorG5RuntimeDescriptor;
 assertCurrent():Promise<void>;ledgerRoot?:string;receiptRoot?:string;
 readVerifiedTariff?(intent:SocialPaidOperationIntent):Promise<SocialVerifiedAccountTariff|null>;
}){
 await input.assertCurrent();
 const budgetScope=await readDirectorG5OriginalFilmBudget({repository:input.repository,reviewScope:input.scope,ledgerRoot:input.ledgerRoot});
 const originalJob=await readContentExecutionJob(input.repository.dataStore!,input.scope.tenantId,input.scope.taskId,input.scope.runId);
 const originalPlan=(originalJob?.checkpoints['social.whole_film_budget']?.payload as {plan?:{paidOperations?:SocialPaidOperationIntent[]}}|undefined)?.plan;
 const holds=(originalPlan?.paidOperations??[]).filter(operation=>operation.stage==='director_review_capacity');
 if(holds.length>1||holds.length===1&&holds[0]!.operationId!==input.requestId)throw Error('director_g5_original_capacity_changed');
 const capacityIntent=holds[0]??null;
 const body=buildDirectorG5QwenRequest({context:input.context,frames:input.frames});
 if(capacityIntent)assertDirectorG5FrozenCapacityEnvelope(capacityIntent,body.model,body.max_tokens);
 const binding=getQwenProviderBinding();
 const accountRef=productionBillingAccountRef('qwen',binding.baseUrl,binding.credentialSha256);
 const routes=createProductionBudgetRouteReaders();
 await routes.assertProviderBinding({stage:'director_review',provider:'qwen',model:body.model,accountRef});
 const inputTokens=await measureQwenRequestInputUpperBound(body);
 const intent:SocialPaidOperationIntent={operationId:input.requestId,provider:'qwen',model:body.model,accountRef,
  stage:'director_review',shotId:null,inputContractHash:createHash('sha256').update(JSON.stringify(body)).digest('hex'),
  maximumUnits:{inputTokens,outputTokens:body.max_tokens}};
 const official=createSocialContentPublishedTariffReader({readProviderBinding:async candidate=>({provider:'qwen',model:candidate.model,baseUrl:binding.baseUrl,credentialSha256:binding.credentialSha256})});
 const checked=async()=>{await input.assertCurrent();const current=await readDirectorG5OriginalFilmBudget({repository:input.repository,reviewScope:input.scope,ledgerRoot:input.ledgerRoot});
  if(JSON.stringify(current)!==JSON.stringify(budgetScope))throw Error('director_g5_original_film_changed');
  await routes.assertProviderBinding({stage:'director_review',provider:'qwen',model:body.model,accountRef});};
 const verifiedTariff=await (input.readVerifiedTariff??(candidate=>official.read(candidate)))(intent);
 assertDirectorG5VerifiedCostEnvelope({intent,descriptor:input.descriptor,context:input.context,tariff:verifiedTariff});
 const reserved=await reserveDirectorG5CanonicalBudget({scope:budgetScope,intent,ledgerRoot:input.ledgerRoot,
  ...(capacityIntent?{capacityIntent}:{}),assertCurrent:checked,readVerifiedTariff:async()=>verifiedTariff});
 const runtime=createSocialContentPaidRuntimePorts({scope:budgetScope,assertCurrent:checked,receiptRoot:input.receiptRoot,routes});
 return {requirementKey:`director-g5:${input.requestId}`,intent,permit:reserved.permit,
  measureInputTokens:runtime.material.measureInputTokens,persistProviderReceipt:runtime.material.persistProviderReceipt};
}

export function assertDirectorG5VerifiedCostEnvelope(input:{intent:SocialPaidOperationIntent;
 descriptor:DirectorG5RuntimeDescriptor;context:SocialDirectorG5Context;tariff:SocialVerifiedAccountTariff|null}){
 const {intent,descriptor,context,tariff}=input,meters=tariff?.meters;
 if(descriptor.model!==intent.model||descriptor.reservedCostCny===null
  ||descriptor.inputPricePerMillion===null||descriptor.outputPricePerMillion===null
  ||!context.agent.authorization||context.agent.authorization.maximumCostCny<descriptor.reservedCostCny
  ||!meters||meters.inputTokens?.priceCny!==descriptor.inputPricePerMillion
  ||meters.outputTokens?.priceCny!==descriptor.outputPricePerMillion
  ||meters.inputTokens.unitsPerPrice!==1000000||meters.outputTokens.unitsPerPrice!==1000000)
  throw Error('director_g5_verified_cost_authority_required');
 const quote=quoteSocialPaidOperationTariff(intent,tariff);
 if(quote.upperBoundCny>descriptor.reservedCostCny||quote.upperBoundCny>context.agent.authorization.maximumCostCny)
  throw Error('director_g5_verified_cost_authority_required');
 return quote;
}
