import {createHash} from 'node:crypto';
import type {DataStore,Record_} from '../storage/datastore.js';
import type {WeeklyPreproductionJob} from '../runtime/weeklyPreproductionProducer.js';
import {prepareDeployedWeeklyAccountCollectionPrepaidWallet,type PrepaidAcceptedPostPort,type PrepaidCollectionOperationAuthority,type PrepaidDatasetPaidReadPermit,type PrepaidOriginalGetPort,type WeeklyAccountCollectionBudgetAuthorization} from './weeklyAccountCollectionBudget.js';
import {inspectWeeklyAccountCollectionOriginalRecovery} from './weeklyAccountCollectionOriginalRecovery.js';
import {createApifyPrepaidOriginalDatasetJournal,type OriginalDatasetJournalScope} from './apifyPrepaidOriginalDatasetJournal.js';
import {verifyFrozenWeeklyAccountCollectionOriginalOperation} from './weeklyAccountCollectionOperationAuthority.js';
import {sourceAccountFromVideoUrl,videoSourceIdentity} from '../routes/videoSourceIdentity.js';
import {stageWeeklyOriginalDatasetDirectMedia,weeklyOriginalDatasetDirectMediaUrl,type StagedWeeklyOriginalDatasetMedia} from './weeklyOriginalDatasetDirectMedia.js';
import {fileURLToPath} from 'node:url';

const sha=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fail=(reason:string):never=>{throw Error(`weekly_account_collection_dataset_continuation_${reason}`);};
type WalletArgs=Omit<Parameters<typeof prepareDeployedWeeklyAccountCollectionPrepaidWallet>[0],'originalGet'>;
type DatasetWallet={
 tokenFingerprint:string;
 beginRun:(operation:PrepaidCollectionOperationAuthority)=>Promise<{
  inspect:()=>Promise<{status?:'reserved'|'submitted_unknown'|'submitted_known'|'completed';requestHash?:string|null}>;
  originalPostScope:()=>{operationIdentity:string;requestHash:string;actorInput:Record<string,unknown>};
 }>;
 beginDatasetRead:(operation:PrepaidCollectionOperationAuthority)=>Promise<{
  inspect:()=>Promise<{status?:'reserved'|'submitted_unknown'|'submitted_known'|'completed';requestHash?:string|null}>;
  beforeSubmit:()=>Promise<unknown>;
  recordOriginalDatasetRead:(paidRead:PrepaidDatasetPaidReadPermit)=>Promise<unknown>;
 }>;
};
const replayRows=new WeakMap<object,{jobId:string;tenantId:string;originalRunKey:string;accountUrl:string;providerRunId:string;datasetId:string;rows:Record<string,unknown>[];digest:string;directMedia:StagedWeeklyOriginalDatasetMedia[]}>();
export type VerifiedWeeklyOriginalDatasetReplay=Readonly<{kind:'verified-weekly-original-dataset-replay'}>;
export function readVerifiedWeeklyOriginalDatasetReplay(capability:VerifiedWeeklyOriginalDatasetReplay){
 const value=replayRows.get(capability);
 if(!value)throw Error('weekly_original_dataset_replay_unverified');
 return {...value,rows:structuredClone(value.rows)};
}
function issueReplay(value:NonNullable<ReturnType<typeof replayRows.get>>):VerifiedWeeklyOriginalDatasetReplay{
 const capability=Object.freeze({kind:'verified-weekly-original-dataset-replay' as const});
 replayRows.set(capability,value);
 return capability;
}

/** Metadata identity plus an immediately consumable media source; neither
 * condition by itself counts a row as a qualified video. */
export function assertWeeklyOriginalDatasetAccountRows(rows:unknown,accountUrl:string):Record<string,unknown>[]{
 if(!Array.isArray(rows)||rows.length>5)return fail('dataset_page_invalid');
 const seen=new Set<string>();
 for(const value of rows){
  if(!value||typeof value!=='object'||Array.isArray(value))return fail('dataset_page_invalid');
  const item=value as Record<string,unknown>,videoId=String(item.id??item.videoId??'');
  const sourceUrl=String(item.webVideoUrl??item.url??item.shareUrl??'');
  if(!/^\d{8,30}$/.test(videoId)||videoSourceIdentity('tiktok',sourceUrl)!==`tiktok:id:${videoId}`||sourceAccountFromVideoUrl('tiktok',sourceUrl)!==accountUrl||seen.has(videoId))return fail('dataset_account_or_video_identity_unverified');
  seen.add(videoId);
 }
 return rows as Record<string,unknown>[];
}

/** The journal is the *only* OriginalGet port handed to the wallet. A 200 GET
 * is first persisted by that journal and can be consumed across a restart;
 * an in-flight request without a 200 is never issued again. No default paid
 * permit or commercial proof is supplied here. */
export async function continueWeeklyAccountCollectionOriginalDataset(input:{
 store:DataStore;jobId:string;journalScope:OriginalDatasetJournalScope;
 operationJobRecordHash?:string;
 walletArgs?:WalletArgs;authorization?:WeeklyAccountCollectionBudgetAuthorization;acceptedPost?:PrepaidAcceptedPostPort;
 walletFactory?:(originalGet:PrepaidOriginalGetPort)=>Promise<DatasetWallet>;
 paidRead?:PrepaidDatasetPaidReadPermit;fetcher?:typeof fetch;mediaFetcher?:typeof fetch;mediaRoot?:string;
}):Promise<{status:'blocked'|'unknown'|'verified';code:string;rows:Record<string,unknown>[]|null;datasetResponseSha256:string|null;newProviderRequests:number;replay?:VerifiedWeeklyOriginalDatasetReplay}>{
 const row=await input.store.getById<Record_>('social_weekly_preproduction_jobs',input.jobId),job=row?.payload as WeeklyPreproductionJob|undefined;
 if(!job||job.kind!=='discovery'||job.jobId!==input.jobId||row?.record_hash!==job.recordHash||!job.originalRunKey)return fail('job_changed');
 const a=input.walletArgs?.authorization??input.authorization;if(!a)return fail('authorization_missing');
 const operation:PrepaidCollectionOperationAuthority={tenantId:a.tenantId,programId:a.programId,packageId:a.packageId,packageVersion:a.packageVersion,scopeId:a.scopeId,scopeVersion:a.scopeVersion,scopeHash:a.scopeHash,jobId:job.jobId,jobRecordHash:input.operationJobRecordHash??job.recordHash,runOperationId:job.originalRunKey};
 await verifyFrozenWeeklyAccountCollectionOriginalOperation({store:input.store,authorization:a,operation});
 const paidRead=input.paidRead,journalScope=input.journalScope;
 let wallet:DatasetWallet|null=null;
 let expectedPage:PrepaidCollectionOperationAuthority|null=null;
 const journal=createApifyPrepaidOriginalDatasetJournal({scope:journalScope,fetcher:input.fetcher,
  ...(paidRead?.permitsPaidCollection===true?{paidPermit:{permitsPaidCollection:true as const,assertCurrent:async(kind:'actor_get'|'run_get'|'dataset_get')=>paidRead.assertCurrent(kind)}}:{}),
  assertSubmittedUnknown:async scope=>{
   if(!wallet||!expectedPage||scope.jobId!==job.jobId||scope.runId!==expectedPage.runId||scope.datasetId!==expectedPage.datasetId||scope.pageKey!=='0'||scope.tokenFingerprint!==wallet.tokenFingerprint)return fail('journal_scope_changed');
   const page=await wallet.beginDatasetRead(expectedPage),entry=await page.inspect();
   if(entry.status!=='submitted_unknown'||entry.requestHash!==scope.requestHash)return fail('journal_claim_unverified');
  }});
 wallet=input.walletFactory?await input.walletFactory(journal):input.walletArgs?await prepareDeployedWeeklyAccountCollectionPrepaidWallet({...input.walletArgs,originalGet:journal}):null;
 if(!wallet)return fail('wallet_missing');
 const acceptedPost=input.walletArgs?.acceptedPost??input.acceptedPost;
 if(!acceptedPost)return fail('accepted_post_missing');
 const recovered=await inspectWeeklyAccountCollectionOriginalRecovery({store:input.store,authorization:a,jobId:job.jobId,operationJobRecordHash:operation.jobRecordHash,wallet,acceptedPost});
 if(recovered.state!=='accepted_needs_original_get'||!recovered.acceptedPost||!['submitted_known','completed'].includes(recovered.ledgerStatus))return fail('original_run_unverified');
 const refs=(recovered.acceptedPost.body as {data?:{id?:unknown;defaultDatasetId?:unknown}}).data;
 if(typeof refs?.id!=='string'||typeof refs.defaultDatasetId!=='string'||journalScope.jobId!==job.jobId||journalScope.runId!==refs.id||journalScope.datasetId!==refs.defaultDatasetId||journalScope.pageKey!=='0'||journalScope.tokenFingerprint!==wallet.tokenFingerprint)return fail('journal_scope_changed');
 expectedPage={...operation,runId:refs.id,datasetId:refs.defaultDatasetId,pageKey:'0'};
 const page=await wallet.beginDatasetRead(expectedPage),entry=await page.inspect();
 if(entry.status==='reserved'){
  if(paidRead?.permitsPaidCollection!==true)return {status:'blocked',code:'weekly_preproduction_original_dataset_paid_permit_required',rows:null,datasetResponseSha256:null,newProviderRequests:0};
  // Only a current, exact paid-read authority can create the irreversible
  // submitted_unknown claim. The wallet rechecks each GET independently.
  // One preflight protects the durable operation transition. Each actual GET
  // is revalidated again by the journal immediately before its own claim.
  await paidRead.assertCurrent('dataset_get');
  await page.beforeSubmit();
 }else if(entry.status==='submitted_unknown'){
  const states=await Promise.all((['actor_get','run_get','dataset_get'] as const).map(kind=>journal.inspect(kind)));
  if(states.includes('submitted_unknown'))return {status:'unknown',code:'weekly_preproduction_original_dataset_get_unknown_no_replay',rows:null,datasetResponseSha256:null,newProviderRequests:0};
 }else if(!['submitted_known','completed'].includes(entry.status??''))return fail('ledger_changed');
 const before=[await journal.read('actor_get'),await journal.read('run_get'),await journal.read('dataset_get')].filter(Boolean).length;
 if(!['submitted_known','completed'].includes(entry.status??'')){
  if(paidRead?.permitsPaidCollection!==true)return {status:'blocked',code:'weekly_preproduction_original_dataset_paid_permit_required',rows:null,datasetResponseSha256:null,newProviderRequests:0};
  try{await page.recordOriginalDatasetRead(paidRead);}catch(error){
   const states=await Promise.all((['actor_get','run_get','dataset_get'] as const).map(kind=>journal.inspect(kind)));
   if(!states.includes('submitted_unknown'))return {status:'blocked',code:error instanceof Error?error.message:'weekly_preproduction_original_dataset_preflight_unavailable',rows:null,datasetResponseSha256:null,newProviderRequests:states.filter(state=>state==='accepted').length};
   return {status:'unknown',code:'weekly_preproduction_original_dataset_get_unknown_no_replay',rows:null,datasetResponseSha256:null,newProviderRequests:states.filter(state=>state==='accepted').length};
  }
 }
 const actor=await journal.read('actor_get'),run=await journal.read('run_get'),dataset=await journal.read('dataset_get');
 if(!actor||!run||!dataset||!Array.isArray(dataset.body)||dataset.body.length>5)return fail('journal_incomplete');
 const acceptedActor=(recovered.acceptedPost.body as {data?:{actId?:unknown}}).data?.actId;
 const actorId=(actor.body as {data?:{id?:unknown}}).data?.id;
 const runData=(run.body as {data?:{id?:unknown;actId?:unknown;defaultDatasetId?:unknown}}).data;
 if(typeof acceptedActor!=='string'||actorId!==acceptedActor||runData?.id!==refs.id||runData.actId!==acceptedActor||runData.defaultDatasetId!==refs.defaultDatasetId)return fail('provider_lineage_changed');
 const rows=assertWeeklyOriginalDatasetAccountRows(dataset.body,a.accountUrl);
 const directMedia:StagedWeeklyOriginalDatasetMedia[]=[];
 for(const item of rows)directMedia.push(await stageWeeklyOriginalDatasetDirectMedia({mediaRoot:input.mediaRoot??fileURLToPath(new URL('../../data/media',import.meta.url)),tenantId:job.tenantId,jobId:job.jobId,providerRunId:refs.id,datasetId:refs.defaultDatasetId,accountUrl:a.accountUrl,row:item,fetcher:input.mediaFetcher}));
 if((await page.inspect()).status!=='submitted_known'&&(await page.inspect()).status!=='completed')return fail('ledger_unsettled');
 const digest=sha(dataset.body);
 return {status:'verified',code:'weekly_preproduction_original_dataset_verified_needs_import',rows,datasetResponseSha256:digest,newProviderRequests:3-before,replay:issueReplay({jobId:job.jobId,tenantId:job.tenantId,originalRunKey:job.originalRunKey,accountUrl:a.accountUrl,providerRunId:refs.id,datasetId:refs.defaultDatasetId,rows:structuredClone(rows),digest,directMedia})};
}
