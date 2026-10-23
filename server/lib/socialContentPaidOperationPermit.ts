import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {withPaidOperationLock} from './paidOperationLock.js';
import type {SocialContentTaskBudget,SocialTaskBudgetScope,SocialTaskBudgetOperation} from './socialContentTaskBudget.js';
import type {SocialPaidOperationIntent} from './socialContentTaskBudgetAuthority.js';
import {isInternalBudgetExemptTenant} from './tenantBudgetExemption.js';
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fail=(reason:string):never=>{throw Error(`social_paid_permit_${reason}`);};
export type PaidOperationSubmission = Omit<SocialPaidOperationIntent,'maximumUnits'> & {actualUnits:Record<string,number>};
/** Constructed only from the trusted authority's reserved operation plan. Claims
 * are shared-volume durable; a crash before POST is deliberately unknown. */
export function createSocialContentPaidOperationPermit(input:{scope:SocialTaskBudgetScope;operations:SocialTaskBudgetOperation[];
 intents:SocialPaidOperationIntent[];ledger:Pick<SocialContentTaskBudget,'status'|'markOutcome'>;
 root?:string;assertCurrent(scope:SocialTaskBudgetScope):Promise<void>;
 /** Only new provider claims, never existing-operation recovery. */
 assertNewSubmit?(scope:SocialTaskBudgetScope):Promise<void>}){
 const scope=structuredClone(input.scope),operations=structuredClone(input.operations),intents=structuredClone(input.intents);
 const root=path.resolve(input.root||process.env.SOCIAL_CONTENT_PAID_PERMIT_DIR||'data/social-content-paid-permits');
 const key=(id:string)=>JSON.stringify([scope.tenantId,scope.taskId,scope.runId,scope.planHash,id]);
 const file=(id:string)=>path.join(root,hash(key(id))+'.json');
 const write=(id:string,row:unknown)=>{fs.mkdirSync(root,{recursive:true,mode:0o700});const temp=file(id)+'.'+randomUUID()+'.tmp';const fd=fs.openSync(temp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(row));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,file(id));const dir=fs.openSync(root,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}};
 const read=(id:string):Record<string,unknown>|null=>{if(!fs.existsSync(file(id)))return null;try{const row=JSON.parse(fs.readFileSync(file(id),'utf8'));const {op,intent}=bound(id);if(row.schemaVersion!==1||row.scopeHash!==hash(scope)||row.operationId!==id||row.fingerprint!==op.fingerprint||!['unknown','accepted','completed'].includes(row.status)||!row.submission||row.submissionHash!==hash(row.submission)||(['operationId','provider','model','accountRef','stage','shotId','inputContractHash'] as const).some(k=>row.submission[k]!==intent[k])||hash(row.actualUnits)!==hash(row.submission.actualUnits))fail('claim_corrupt');return row;}catch{return fail('claim_corrupt');}};
 const bound=(id:string)=>{const ops=operations.filter(o=>o.operationId===id),plans=intents.filter(o=>o.operationId===id);if(ops.length!==1||plans.length!==1)fail('operation_missing_or_ambiguous');return {op:ops[0]!,intent:plans[0]!};};
 const entry=(id:string)=>{const {op}=bound(id);const entries=input.ledger.status(scope)?.entries.filter(e=>e.operationId===id)||[];if(entries.length!==1)fail('reservation_missing');const e=entries[0]!;if((e.executionTaskId??scope.budgetTaskId??scope.taskId)!==scope.taskId||e.runId!==scope.runId||e.planHash!==scope.planHash||(['operationId','fingerprint','provider','model','accountRef','stage','shotId'] as const).some(k=>e[k]!==op[k]))fail('reservation_changed');return e;};
 const assertWholePlanReserved=()=>{
	  const current=input.ledger.status(scope);
	  if(!current)throw Error('social_paid_permit_whole_plan_budget_invalid');
	  const correction=current.correctionAuthorization;
  const validCorrection=Boolean(correction&&correction.tenantId===scope.tenantId&&correction.taskId===scope.taskId
   &&correction.runId===scope.runId&&correction.planHash===scope.planHash&&correction.reason==='provider_correction'
   &&['approved_first_frame_not_consumed','approved_first_frame_not_consumed_and_bound_voice_mismatch'].includes(correction.correctionCause)&&correction.affectedPresenterGroupIds.length===3
	   &&correction.maximumCny===current.limitCny&&correction.maximumCny<=(correction.correctionCause==='approved_first_frame_not_consumed'?16.5:20));
  const maximum=validCorrection?correction!.maximumCny:15;
	  if(!Number.isFinite(current.limitCny)||current.limitCny<=0
	   ||!Number.isFinite(current.retainedCny)||current.retainedCny<0)fail('whole_plan_budget_invalid');
  if(!isInternalBudgetExemptTenant(scope.tenantId)
	   &&(current.limitCny>maximum||current.retainedCny>current.limitCny||current.retainedCny>maximum))fail('whole_plan_budget_invalid');
  for(const op of operations){
   const entries=current.entries.filter(e=>e.operationId===op.operationId);
   if(entries.length!==1)fail('whole_plan_reservation_missing');
   const e=entries[0]!;
   if((e.executionTaskId??scope.budgetTaskId??scope.taskId)!==scope.taskId||e.status==='rejected'||e.runId!==scope.runId||e.planHash!==scope.planHash
    ||(['operationId','fingerprint','provider','model','accountRef','stage','shotId'] as const).some(k=>e[k]!==op[k]))fail('whole_plan_reservation_changed');
  }
 };
 const result = {
  isProvenUnsubmitted:(async(operationId:string)=>withPaidOperationLock(path.join(root,'.locks'),key(operationId),async()=>{
   await input.assertCurrent(scope);return entry(operationId).status==='reserved'&&!read(operationId);
  })) as ((operationId:string)=>Promise<boolean>)|undefined,
  async assertRecovery(operationId:string){return withPaidOperationLock(path.join(root,'.locks'),key(operationId),async()=>{
   await input.assertCurrent(scope);const e=entry(operationId),prior=read(operationId);
   if(!prior||!['unknown','accepted','completed'].includes(e.status))fail('recovery_original_receipt_missing');
   if(prior!.status==='completed'&&(e.status!=='completed'||e.receiptRef!==prior!.receiptRef))fail('claim_corrupt');
   return {operation:structuredClone(bound(operationId).op),status:e.status,receiptRef:e.receiptRef,
    submission:structuredClone(prior!.submission) as PaidOperationSubmission,submissionHash:String(prior!.submissionHash)};
  });},
  async beforeSubmit(request:PaidOperationSubmission){return withPaidOperationLock(path.join(root,'.locks'),key(request.operationId),async()=>{
   await input.assertCurrent(scope);assertWholePlanReserved();const {op,intent}=bound(request.operationId);
   // This is only a budget hold. It has no provider request and must never
   // produce a submission claim, even if a caller retains the film permit.
   if(op.stage==='director_review_capacity'||intent.stage==='director_review_capacity')fail('capacity_not_submittable');
   if((['provider','model','accountRef','stage','shotId','inputContractHash'] as const).some(k=>request[k]!==intent[k])
    ||(['provider','model','accountRef','stage','shotId'] as const).some(k=>op[k]!==intent[k]))fail('request_binding_changed');
   const actual=Object.keys(request.actualUnits).sort(),maximum=Object.keys(intent.maximumUnits).sort();
   if(!actual.length||JSON.stringify(actual)!==JSON.stringify(maximum)||actual.some(k=>!Number.isFinite(request.actualUnits[k])||request.actualUnits[k]!<0||!Number.isFinite(intent.maximumUnits[k])||request.actualUnits[k]!>intent.maximumUnits[k]!))
    fail(`usage_exceeds_bound:${intent.stage}:actual=${JSON.stringify(request.actualUnits)}:maximum=${JSON.stringify(intent.maximumUnits)}`);
   const e=entry(request.operationId),prior=read(request.operationId);
   if(prior||['accepted','unknown','completed'].includes(e.status))fail('receipt_recovery_required');
   if(e.status!=='reserved')fail('reservation_not_submittable');
   await input.assertCurrent(scope);
   await input.assertNewSubmit?.(scope);
   write(request.operationId,{schemaVersion:1,scopeHash:hash(scope),operationId:request.operationId,fingerprint:op.fingerprint,
    submissionHash:hash(request),submission:structuredClone(request),actualUnits:request.actualUnits,status:'unknown',receiptRef:null});
   // This is the real local submission-boundary receipt, not a fabricated
   // supplier acceptance. Failure keeps the durable claim and reserved charge.
   await input.ledger.markOutcome(scope,request.operationId,'unknown',`paid_permit_claim:${hash(key(request.operationId))}`);
   return {operationId:op.operationId,fingerprint:op.fingerprint};
  });},
  async markOutcome(operationId:string,status:'accepted'|'unknown'|'completed',receiptRef:string){return withPaidOperationLock(path.join(root,'.locks'),key(operationId),async()=>{
   await input.assertCurrent(scope);entry(operationId);const prior=read(operationId);
   if(!prior||typeof receiptRef!=='string'||!receiptRef.trim()||!['accepted','unknown','completed'].includes(status))fail('receipt_or_claim_missing');
   if(prior!.status==='completed'&&(status!=='completed'||prior!.receiptRef!==receiptRef))fail('outcome_conflict');
   await input.ledger.markOutcome(scope,operationId,status,receiptRef);
   write(operationId,{...prior,status,receiptRef});
  });},
 };
 return result as Omit<typeof result,"isProvenUnsubmitted"> & Partial<Pick<typeof result,"isProvenUnsubmitted">>;
}
