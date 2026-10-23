import {createHash} from 'node:crypto';
import type {DataStore} from '../storage/datastore.js';
import type {PrepaidAcceptedPostPort,PrepaidCollectionOperationAuthority,WeeklyAccountCollectionBudgetAuthorization} from './weeklyAccountCollectionBudget.js';
import {inspectWeeklyAccountCollectionOriginalRecovery} from './weeklyAccountCollectionOriginalRecovery.js';
import {apifyTokenFingerprint,APIFY_PREPAID_TOKEN_FINGERPRINT_SCHEME} from './apifyTokenFingerprint.js';

const fail=(reason:string):never=>{throw Error(`weekly_account_collection_transport_${reason}`);};

/** Deliberately has no default issuer. The deployed prepaid wallet currently
 * advertises permitsPaidCollection:false; that contract cannot be passed here.
 * A future commercial authority must independently prove the complete paid
 * boundary and recheck it immediately before every supplier request. */
export interface WeeklyAccountCollectionPaidPermit {
 permitsPaidCollection:true;
 assertCurrent:(request:{kind:'original_post'|'actor_get'|'run_get'|'dataset_get';operationIdentity:string;requestHash:string;tokenFingerprint:string;actorInputSha256:string;runId:string|null;datasetId:string|null})=>Promise<void>;
}

/** Accepted-201 continuation only. It has no POST journal or submit method.
 * A known wallet entry is recovered locally; an unknown entry needs a fresh
 * independent permit immediately before each chargeable Actor/run GET. */
export async function continueAcceptedWeeklyAccountCollectionOriginal(input:{
 store:DataStore;authorization:WeeklyAccountCollectionBudgetAuthorization;jobId:string;
 wallet:{tokenFingerprint:string;beginRun:(operation:PrepaidCollectionOperationAuthority)=>Promise<{
  inspect:()=>Promise<{status?:'reserved'|'submitted_unknown'|'submitted_known'|'completed';requestHash?:string|null}>;
  originalPostScope:()=>{operationIdentity:string;requestHash:string;actorInput:Record<string,unknown>};
  recordOriginalRun:(assertPaidRead:(request:'actor_get'|'run_get')=>Promise<void>)=>Promise<unknown>;
 }>};acceptedPost:PrepaidAcceptedPostPort;token:string;permit?:WeeklyAccountCollectionPaidPermit;now?:number;
}){
 if(!input.token||apifyTokenFingerprint(input.token,APIFY_PREPAID_TOKEN_FINGERPRINT_SCHEME)!==input.wallet.tokenFingerprint)return fail('token_binding_changed');
 const recovery=await inspectWeeklyAccountCollectionOriginalRecovery(input);
 if(recovery.state!=='accepted_needs_original_get'||!recovery.acceptedPost)return fail('accepted_post_required');
 const refs=(recovery.acceptedPost.body as {data?:{id?:unknown;defaultDatasetId?:unknown}}|null)?.data;
 if(typeof refs?.id!=='string'||!refs.id||typeof refs.defaultDatasetId!=='string'||!refs.defaultDatasetId)return fail('accepted_run_changed');
 if(recovery.ledgerStatus==='submitted_known'||recovery.ledgerStatus==='completed')return {status:'original_run_verified' as const,acceptedPost:recovery.acceptedPost,runId:refs.id,datasetId:refs.defaultDatasetId,newProviderRequests:0 as const};
 const permit=input.permit;
 if(!permit||permit.permitsPaidCollection!==true)return fail('paid_permit_required');
 const frozen={operationIdentity:recovery.scope.operationIdentity,requestHash:recovery.scope.requestHash,tokenFingerprint:input.wallet.tokenFingerprint,actorInputSha256:createHash('sha256').update(JSON.stringify(recovery.scope.actorInput)).digest('hex')};
 const run=await input.wallet.beginRun(recovery.operation);
 await run.recordOriginalRun(kind=>permit.assertCurrent({kind,...frozen,runId:refs.id as string,datasetId:refs.defaultDatasetId as string}));
 return {status:'original_run_verified' as const,acceptedPost:recovery.acceptedPost,runId:refs.id,datasetId:refs.defaultDatasetId,newProviderRequests:2 as const};
}

/** One original five-video operation only. The fsynced POST claim and the
 * prepaid ledger's unknown claim must both exist before network submission.
 * A missing 201 is terminal-unknown for local replay, never a fresh POST.
 * This coordinator is intentionally not installed in the weekly producer. */
export async function advanceWeeklyAccountCollectionOriginalTransport(input:{
 store:DataStore;authorization:WeeklyAccountCollectionBudgetAuthorization;jobId:string;
 wallet:{tokenFingerprint:string;beginRun:(operation:PrepaidCollectionOperationAuthority)=>Promise<{
  inspect:()=>Promise<{status?:'reserved'|'submitted_unknown'|'submitted_known'|'completed';requestHash?:string|null}>;
  beforeSubmit:()=>Promise<unknown>;
  originalPostScope:()=>{operationIdentity:string;requestHash:string;actorInput:Record<string,unknown>};
  recordOriginalRun:(assertPaidRead:(request:'actor_get'|'run_get')=>Promise<void>)=>Promise<unknown>;
 }>};
 acceptedPost:PrepaidAcceptedPostPort;
 journal:{submit:(scope:{operationIdentity:string;requestHash:string;token:string;actorInput:Record<string,unknown>})=>Promise<unknown>};
 token:string;permit?:WeeklyAccountCollectionPaidPermit;now?:number;
}){
 // The journal receives a separate token argument. Bind it to the exact
 // prepaid wallet before even reserving a local operation: otherwise the
 // durable claim could name one wallet while the POST spends another token.
 // The prepaid wallet and original POST journal both fingerprint the JSON
 // string representation of the token. Use that same frozen representation
 // here; hashing the raw token makes every legitimate wallet fail closed.
 if(!input.token||apifyTokenFingerprint(input.token,APIFY_PREPAID_TOKEN_FINGERPRINT_SCHEME)!==input.wallet.tokenFingerprint)return fail('token_binding_changed');
 const recovery=await inspectWeeklyAccountCollectionOriginalRecovery(input);
 if(recovery.state==='submitted_unknown_no_replay')return {status:'submitted_unknown_no_replay' as const};
 const permit=input.permit;
 if(!permit||permit.permitsPaidCollection!==true)return fail('paid_permit_required');
 const run=await input.wallet.beginRun(recovery.operation);
 const frozen={operationIdentity:recovery.scope.operationIdentity,requestHash:recovery.scope.requestHash,tokenFingerprint:input.wallet.tokenFingerprint,actorInputSha256:createHash('sha256').update(JSON.stringify(recovery.scope.actorInput)).digest('hex')};
 if(recovery.state==='not_submitted'){
  await permit.assertCurrent({kind:'original_post',...frozen,runId:null,datasetId:null});
  // The durable local unknown claim precedes the journal's own fsynced claim.
  await run.beforeSubmit();
  await permit.assertCurrent({kind:'original_post',...frozen,runId:null,datasetId:null});
  const scope=run.originalPostScope();
  if(scope.operationIdentity!==recovery.scope.operationIdentity||scope.requestHash!==recovery.scope.requestHash||JSON.stringify(scope.actorInput)!==JSON.stringify(recovery.scope.actorInput))return fail('scope_changed');
  await input.journal.submit({...scope,token:input.token});
 }
 // Never infer accepted from the submit return value: read the durable 201.
 const accepted=await input.acceptedPost.read({operationIdentity:recovery.scope.operationIdentity,requestHash:recovery.scope.requestHash,tokenFingerprint:input.wallet.tokenFingerprint});
 if(!accepted)return {status:'submitted_unknown_no_replay' as const};
 const refs=(accepted.body as {data?:{id?:unknown;defaultDatasetId?:unknown}}|null)?.data;
 if(typeof refs?.id!=='string'||typeof refs.defaultDatasetId!=='string')return fail('accepted_run_changed');
 await run.recordOriginalRun(kind=>permit.assertCurrent({kind,...frozen,runId:refs.id as string,datasetId:refs.defaultDatasetId as string}));
 return {status:'original_run_verified' as const};
}
