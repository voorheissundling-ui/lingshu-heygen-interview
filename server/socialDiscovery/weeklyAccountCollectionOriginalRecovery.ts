import {createHash} from 'node:crypto';
import type {DataStore,Record_} from '../storage/datastore.js';
import type {WeeklyPreproductionJob} from '../runtime/weeklyPreproductionProducer.js';
import {verifyFrozenWeeklyAccountCollectionOriginalOperation} from './weeklyAccountCollectionOperationAuthority.js';
import {frozenWeeklyAccountFiveVideoActorInput,type PrepaidAcceptedPostPort,type PrepaidCollectionOperationAuthority,type WeeklyAccountCollectionBudgetAuthorization} from './weeklyAccountCollectionBudget.js';
import {WEEKLY_ACCOUNT_COLLECTION_ACTOR_RUN_ENDPOINT} from './apifyPrepaidOriginalPost.js';

const fail=():never=>{throw Error('weekly_account_collection_original_recovery_unverified');};
const sha=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Service-owned, non-spending restart view. beginRun may create a local
 * reserved ledger entry, but this adapter has no supplier side effect. It has no submit,
 * beforeSubmit, spending permit, token, or provider GET method. The real paid
 * path must independently establish the commercial contract first. */
export async function inspectWeeklyAccountCollectionOriginalRecovery(input:{
 store:DataStore;authorization:WeeklyAccountCollectionBudgetAuthorization;jobId:string;now?:number;
 operationJobRecordHash?:string;
 wallet:{tokenFingerprint:string;beginRun:(operation:PrepaidCollectionOperationAuthority)=>Promise<{
  inspect:()=>Promise<{status?:'reserved'|'submitted_unknown'|'submitted_known'|'completed';requestHash?:string|null}>;
  originalPostScope:()=>{operationIdentity:string;requestHash:string;actorInput:Record<string,unknown>};
 }>};acceptedPost:PrepaidAcceptedPostPort;
}){
 const row=await input.store.getById<Record_>('social_weekly_preproduction_jobs',input.jobId);
 const job=row?.payload as WeeklyPreproductionJob|undefined;
 if(!job||job.jobId!==input.jobId||!job.recordHash||!job.originalRunKey)return fail();
 const a=input.authorization;
 if(a.actorId!=='clockworks/tiktok-scraper')return fail();
 const operation:PrepaidCollectionOperationAuthority={tenantId:a.tenantId,programId:a.programId,packageId:a.packageId,packageVersion:a.packageVersion,scopeId:a.scopeId,scopeVersion:a.scopeVersion,scopeHash:a.scopeHash,jobId:job.jobId,jobRecordHash:input.operationJobRecordHash??job.recordHash,runOperationId:job.originalRunKey};
 await verifyFrozenWeeklyAccountCollectionOriginalOperation({store:input.store,authorization:a,operation,now:input.now});
 const run=await input.wallet.beginRun(operation);
 const scope=run.originalPostScope();
 if(!/^[a-f0-9]{64}$/.test(scope.operationIdentity)||!/^[a-f0-9]{64}$/.test(scope.requestHash)||!/^[a-f0-9]{64}$/.test(input.wallet.tokenFingerprint)||sha(scope.actorInput)!==sha(frozenWeeklyAccountFiveVideoActorInput(a.accountUrl)))return fail();
 const ledger=await run.inspect();
 if(!ledger.status||!['reserved','submitted_unknown','submitted_known','completed'].includes(ledger.status)||ledger.status==='reserved'&&ledger.requestHash!==null||ledger.status!=='reserved'&&ledger.requestHash!==scope.requestHash)return fail();
 const post=await input.acceptedPost.read({operationIdentity:scope.operationIdentity,requestHash:scope.requestHash,tokenFingerprint:input.wallet.tokenFingerprint});
 if(post){
  const expectedUrl=WEEKLY_ACCOUNT_COLLECTION_ACTOR_RUN_ENDPOINT;
  const run=(post.body as {data?:{id?:unknown;actId?:unknown;defaultDatasetId?:unknown}}|null)?.data;
  if(ledger.status==='reserved'||post.operationIdentity!==scope.operationIdentity||post.requestHash!==scope.requestHash||post.tokenFingerprint!==input.wallet.tokenFingerprint||post.actorInputSha256!==sha(scope.actorInput)||post.url!==expectedUrl||post.status!==201||!run||[run.id,run.actId,run.defaultDatasetId].some(value=>typeof value!=='string'||!value))return fail();
 }
 if(!post&&['submitted_known','completed'].includes(ledger.status!))return fail();
 await verifyFrozenWeeklyAccountCollectionOriginalOperation({store:input.store,authorization:a,operation,now:input.now});
 return {schema:'weekly-account-collection-original-recovery.v1' as const,operation,scope,ledgerStatus:ledger.status,
  state:(ledger.status==='reserved'?'not_submitted':post?'accepted_needs_original_get':'submitted_unknown_no_replay') as 'not_submitted'|'accepted_needs_original_get'|'submitted_unknown_no_replay',
  acceptedPost:post??null,permitsPaidCollection:false as const};
}
