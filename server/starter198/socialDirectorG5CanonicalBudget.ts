import path from 'node:path';
import type {Starter198Repository} from './repository.js';
import type {SocialDirectorG5Scope} from '../../shared/contracts/socialDirectorG5Review.js';
import {readContentExecutionJob} from '../contentExecution/durableQueue.js';
import {STARTER_COLLECTIONS} from './repository.js';
import {resolveSocialContentCostLineage} from './socialContentCostLineage.js';
import {paidProductionHash} from './socialContentPaidOperationPlan.js';
import {SocialContentTaskBudget,type SocialTaskBudgetScope} from '../lib/socialContentTaskBudget.js';
import {createSocialContentPaidOperationPermit} from '../lib/socialContentPaidOperationPermit.js';
import {quoteSocialPaidOperationTariff,socialPaidIntentOperation,type SocialPaidOperationIntent,type SocialVerifiedAccountTariff} from '../lib/socialContentTaskBudgetAuthority.js';

export function verifyDirectorG5OriginalFilmBudget(input:{
  reviewScope:SocialDirectorG5Scope;budgetTaskId:string;
  checkpoint:{inputHash:string;payload:unknown}|null|undefined;
  status:ReturnType<SocialContentTaskBudget['status']>;
}):SocialTaskBudgetScope{
  const {reviewScope,checkpoint,status}=input;
  const payload=checkpoint?.payload as Record<string,unknown>|undefined;
  const plan=payload?.plan as {scope?:SocialTaskBudgetScope;paidOperations?:Array<{operationId:string}>}|undefined;
  const scope=plan?.scope,operationIds=payload?.operationIds;
  if(!checkpoint||!payload||!scope||scope.tenantId!==reviewScope.tenantId
    ||scope.taskId!==reviewScope.taskId||scope.runId!==reviewScope.runId
    ||scope.budgetTaskId!== (input.budgetTaskId===reviewScope.taskId?undefined:input.budgetTaskId)
    ||!/^[a-f0-9]{64}$/.test(scope.planHash)||checkpoint.inputHash!==scope.planHash
    ||payload.scopeHash!==paidProductionHash(scope)
    ||!Array.isArray(operationIds)||!Array.isArray(plan.paidOperations)
    ||plan.paidOperations.length===0||plan.paidOperations.some(op=>!operationIds.includes(op.operationId)))
    throw Error('director_g5_original_film_checkpoint_required');
  if(!status||status.limitCny!==10||status.authorizedLimitCny!==10||status.hasCorrectionAuthorization
    ||plan.paidOperations.some(op=>status.entries.filter(entry=>entry.operationId===op.operationId
      &&(entry.executionTaskId??input.budgetTaskId)===scope.taskId
      &&entry.runId===scope.runId&&entry.planHash===scope.planHash&&entry.status!=='rejected').length!==1))
    throw Error('director_g5_original_ten_yuan_ledger_required');
  return structuredClone(scope);
}

/** A repair may spend only from its pre-funded child checkpoint under the
 * original film's ledger. This pure verifier is also used by the persisted
 * reader; a G5 outcome or weekly qualityRecoveries row is never an input. */
export function verifyDirectorG5RepairChildBudget(input:{
  reviewScope:SocialDirectorG5Scope;rootTaskId:string;rootRunId:string;
  originalMaximumCny:number|null;maximumAdditionalCostCny:number|null;
  childCheckpoint:{inputHash:string;payload:unknown}|null|undefined;
  rootCheckpoint:{inputHash:string;payload:unknown}|null|undefined;
  status:ReturnType<SocialContentTaskBudget['status']>;
}):SocialTaskBudgetScope{
  const {reviewScope,rootTaskId,rootRunId,childCheckpoint,rootCheckpoint,status}=input;
  if(rootTaskId===reviewScope.taskId||input.originalMaximumCny!==10
    ||!input.maximumAdditionalCostCny||input.maximumAdditionalCostCny>10)
    throw Error('director_g5_repair_budget_lineage_invalid');
  const child=verifyDirectorG5OriginalFilmBudget({reviewScope,budgetTaskId:rootTaskId,checkpoint:childCheckpoint,status});
  const root=verifyDirectorG5OriginalFilmBudget({reviewScope:{...reviewScope,taskId:rootTaskId,runId:rootRunId},
    budgetTaskId:rootTaskId,checkpoint:rootCheckpoint,status});
  if(root.taskId!==rootTaskId||root.budgetTaskId!==undefined||root.runId!==rootRunId
    ||child.budgetTaskId!==rootTaskId)
    throw Error('director_g5_repair_root_required');
  const plan=(childCheckpoint?.payload as {plan?:{paidOperations?:Array<{stage?:string}>}}|undefined)?.plan;
  if((plan?.paidOperations??[]).filter(op=>op.stage==='director_review_capacity').length!==1)
    throw Error('director_g5_repair_child_hold_required');
  return child;
}

/** Resolve the film budget from the original persisted production checkpoint.
 * A G5 request, artifact, or caller-supplied plan hash is never ledger authority. */
export async function readDirectorG5OriginalFilmBudget(input:{
  repository:Starter198Repository;reviewScope:SocialDirectorG5Scope;ledgerRoot?:string;
}):Promise<SocialTaskBudgetScope>{
  const {repository,reviewScope}=input,store=repository.dataStore;
  if(!store)throw Error('director_g5_original_store_required');
  const lineage=await resolveSocialContentCostLineage({repository,tenantId:reviewScope.tenantId,taskId:reviewScope.taskId});
  const job=await readContentExecutionJob(store,reviewScope.tenantId,reviewScope.taskId,reviewScope.runId);
  const checkpoint=job?.checkpoints['social.whole_film_budget'];
  const payload=checkpoint?.payload as Record<string,unknown>|undefined;
  const plan=payload?.plan as {scope?:SocialTaskBudgetScope}|undefined;
  const scope=plan?.scope;
  if(!scope)throw Error('director_g5_original_film_checkpoint_required');
  const ledger=new SocialContentTaskBudget(input.ledgerRoot,{assertCurrent:async()=>{},
    authorization:async()=>{throw Error('director_g5_original_ledger_required');},
    quote:async()=>{throw Error('director_g5_original_ledger_required');},verifyRejection:async()=>false});
  const status=ledger.status(scope);
  if(lineage.kind==='creative_repair'){
    // A post-audit recovery card is not a funding grant. The child must have
    // reserved its own complete film plan before execution, under the root
    // ledger, while the root's original ten-yuan authorization remains frozen.
    if(lineage.contentId!==lineage.budgetTaskId)
      throw Error('director_g5_repair_budget_lineage_invalid');
    const roots=await repository.list(STARTER_COLLECTIONS.socialContentTasks,reviewScope.tenantId,
      {where:{task_id:lineage.budgetTaskId},perPage:2});
    if(roots.totalItems!==1||roots.items.length!==1||!roots.items[0]?.run_id)
      throw Error('director_g5_repair_root_required');
    const rootRunId=String(roots.items[0].run_id);
    const rootJob=await readContentExecutionJob(store,reviewScope.tenantId,lineage.budgetTaskId,rootRunId);
    const rootCheckpoint=rootJob?.checkpoints['social.whole_film_budget'];
    const rootScope=(rootCheckpoint?.payload as {plan?:{scope?:SocialTaskBudgetScope}}|undefined)?.plan?.scope;
    if(!rootScope||rootScope.taskId!==lineage.budgetTaskId||rootScope.budgetTaskId!==undefined
      ||rootScope.runId!==rootRunId||rootScope.tenantId!==reviewScope.tenantId)
      throw Error('director_g5_repair_root_required');
    return verifyDirectorG5RepairChildBudget({reviewScope,rootTaskId:lineage.budgetTaskId,rootRunId,
      originalMaximumCny:lineage.originalMaximumCny,maximumAdditionalCostCny:lineage.maximumAdditionalCostCny,
      childCheckpoint:checkpoint,rootCheckpoint,status});
  }
  return verifyDirectorG5OriginalFilmBudget({reviewScope,budgetTaskId:lineage.budgetTaskId,checkpoint,status});
}

/** The G5 POST must retain capacity in the original content ledger, never only
 * in the Starter usage ledger. This adapter deliberately cannot create the
 * original film ledger or invent a price from a runtime/environment estimate. */
export async function reserveDirectorG5CanonicalBudget(input:{
  scope:SocialTaskBudgetScope;
  intent:SocialPaidOperationIntent;
  /** Verified original-film capacity intent, if the frozen plan reserved one. */
  capacityIntent?:SocialPaidOperationIntent;
  readVerifiedTariff(intent:SocialPaidOperationIntent):Promise<SocialVerifiedAccountTariff|null>;
  assertCurrent(scope:SocialTaskBudgetScope):Promise<void>;
  ledgerRoot?:string;
}){
  const {scope,intent}=input;
  if(intent.stage!=='director_review'||intent.shotId!==null||intent.maximumUnits.inputTokens===undefined||intent.maximumUnits.outputTokens===undefined)
    throw Error('director_g5_canonical_intent_invalid');
  await input.assertCurrent(scope);
  const original=new SocialContentTaskBudget(input.ledgerRoot,{assertCurrent:input.assertCurrent,
    authorization:async()=>{throw Error('director_g5_original_ledger_required');},
    quote:async()=>{throw Error('director_g5_original_ledger_required');},
    verifyRejection:async()=>false});
  const existing=original.status(scope);
  if(!existing||existing.limitCny!==10||existing.authorizedLimitCny!==10||existing.hasCorrectionAuthorization)
    throw Error('director_g5_original_ten_yuan_ledger_required');
  const operation=socialPaidIntentOperation(scope,intent);
  const prior=existing.entries.filter(entry=>entry.operationId===operation.operationId);
  if(prior.length>1)
    throw Error('director_g5_original_operation_changed');
  const capacity=input.capacityIntent;
  if(capacity){
    if(capacity.stage!=='director_review_capacity'||capacity.operationId!==intent.operationId
      ||capacity.provider!==intent.provider||capacity.model!==intent.model
      ||capacity.accountRef!==intent.accountRef||capacity.shotId!==null
      ||capacity.maximumUnits.inputTokens<intent.maximumUnits.inputTokens
      ||capacity.maximumUnits.outputTokens<intent.maximumUnits.outputTokens)
      throw Error('director_g5_original_capacity_invalid');
    const capacityOperation=socialPaidIntentOperation(scope,capacity);
    if(!prior[0])throw Error('director_g5_original_capacity_missing');
    const alreadyExact=prior[0].fingerprint===operation.fingerprint&&prior[0].stage==='director_review';
    if(!alreadyExact){
      const exactQuote=quoteSocialPaidOperationTariff(intent,await input.readVerifiedTariff(intent));
      await original.bindDirectorReviewCapacity(scope,{capacityOperation,exactOperation:operation,exactQuote});
    }
  }else if(prior[0]&&(['fingerprint','provider','model','accountRef','stage','shotId'] as const).some(key=>prior[0]![key]!==operation[key]))
    throw Error('director_g5_original_operation_changed');
  // Existing same-operation recovery keeps the original quote and occupied
  // capacity; only a new G5 reservation needs a current verified tariff.
  const quote=prior.length?null:quoteSocialPaidOperationTariff(intent,await input.readVerifiedTariff(intent));
  const ledger=new SocialContentTaskBudget(input.ledgerRoot,{assertCurrent:input.assertCurrent,
    authorization:async()=>({maximumCny:10,authorizationRef:'director-g5-existing-film-ledger'}),
    quote:async(_scope,candidate)=>{if(candidate.operationId!==operation.operationId||!quote)throw Error('director_g5_operation_changed');return quote;},
    verifyRejection:async()=>false});
  const status=await ledger.reserveBatch(scope,[operation]);
  if(status.limitCny!==10||status.retainedCny>10||status.entries.filter(entry=>entry.operationId===operation.operationId).length!==1)
    throw Error('director_g5_canonical_reservation_invalid');
  return {scope,operation,intent,quote,status,permit:createSocialContentPaidOperationPermit({scope,operations:[operation],intents:[intent],ledger,
    root:path.join(input.ledgerRoot||process.env.SOCIAL_CONTENT_TASK_BUDGET_DIR||'data/social-content-task-budget','.permits'),assertCurrent:input.assertCurrent})};
}
