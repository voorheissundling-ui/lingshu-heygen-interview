import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {DataStore,Record_} from '../storage/datastore.js';
import type {SocialInspirationCollectionRun} from '../../shared/contracts/socialContentWorkflow.js';
import type {WeeklyPreproductionJob} from './weeklyPreproductionProducer.js';
import type {WeeklyPreproductionRetryAttempt} from './weeklyPreproductionRetryAttempts.js';
import {socialJson,socialObject,socialRequestHash} from '../starter198/socialContentValidation.js';
import {readSameRunApifyKvVideo,type VerifiedRunKvMediaBinding} from '../socialDiscovery/apifyRunKvMedia.js';
import {apifySameRunReadUrls,readLocallyVerifiedRunKvMapping,type ApifySameRunPaidReadPermit,type RunKvMappingAuthority} from '../socialDiscovery/apifyRunKvMappingReceipt.js';
import {apifyTokenFingerprint,APIFY_PREPAID_TOKEN_FINGERPRINT_SCHEME,type ApifyTokenFingerprintScheme} from '../socialDiscovery/apifyTokenFingerprint.js';
import {verifiedWeeklyCandidateCanonicalMedia} from './weeklyCandidateExactAnalysisOperation.js';
import {videoSourceIdentity} from '../routes/videoSourceIdentity.js';
import {APIFY_RUN_KV_MAPPING_RECEIPTS,type SignedRunKvMapping} from '../socialDiscovery/apifyRunKvMappingReceipt.js';
import type {StagedWeeklyOriginalDatasetMedia} from '../socialDiscovery/weeklyOriginalDatasetDirectMedia.js';

export const WEEKLY_CANDIDATE_CANONICAL_MEDIA_OPERATIONS='social_weekly_candidate_canonical_media_operations';
export const WEEKLY_CANDIDATE_CANONICAL_MEDIA_READ_RECEIPTS='social_weekly_candidate_canonical_media_read_receipts';
export const WEEKLY_CANDIDATE_CANONICAL_MEDIA_RECEIPTS='social_weekly_candidate_canonical_media_receipts';
type Job=WeeklyPreproductionJob|WeeklyPreproductionRetryAttempt;
type Scope={tenantId:string;programId:string;packageId:string;packageVersion:number;jobId:string;runId:string;runHash:string;candidateId:string;sourceUrl:string;datasetId:string;defaultKeyValueStoreId:string;datasetVideoId:string;mappingReceiptId:string;recordKey:string;mediaSha256:string;mediaByteLength:number};
type Permit={permitId:string;ledgerOperationId:string;ledgerOutcomeHash:string;tokenFingerprintScheme?:ApifyTokenFingerprintScheme;tokenFingerprint:string;scopeHash:string;kind:'apify_same_run_kv_get';status:'authorized'};
type Operation={schema:'weekly-candidate-canonical-media-operation.v1';id:string;scope:Scope;permit:Permit;state:'submitted_or_unknown';recordHash:string};
type ReadReceipt={schema:'weekly-candidate-canonical-media-read-receipt.v1';id:string;operationHash:string;scopeHash:string;filePath:string;contentSha256:string;byteLength:number;recordHash:string};
type Receipt={schema:'weekly-candidate-canonical-media-receipt.v1';id:string;operationHash:string;scope:Scope;permit:Permit;videoFileId:string;recordSnapshotHash:string;recordHash:string};
export type VerifiedDatasetDirectMediaBinding=StagedWeeklyOriginalDatasetMedia&{kind:'original_dataset_direct_media';tenantId:string;packageId:string;packageVersion:number;jobId:string};
type DirectScope={tenantId:string;programId:string;packageId:string;packageVersion:number;jobId:string;runId:string;runHash:string;candidateId:string;sourceUrl:string;providerRunId:string;datasetId:string;datasetVideoId:string;sourceUrlSha256:string;mediaSha256:string;mediaByteLength:number;filePath:string;receiptPath:string};
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const object=(value:unknown)=>socialObject(socialJson(value))??{};
const validHash=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const safeSegment=(value:unknown)=>typeof value==='string'&&/^[A-Za-z0-9_-]{5,80}$/.test(value);
const fail=(code:string):never=>{throw Error(`weekly_candidate_canonical_media_${code}`);};
const seal=<T extends {recordHash:string}>(item:T):T=>({...item,recordHash:socialRequestHash({...item,recordHash:''})});
const isDirectBinding=(value:VerifiedRunKvMediaBinding|VerifiedDatasetDirectMediaBinding):value is VerifiedDatasetDirectMediaBinding=>'kind' in value&&value.kind==='original_dataset_direct_media';

/** Resolves only an already-persisted independent mapping. It grants no paid
 * read and performs no provider call; the canonical worker revalidates the
 * signature, revocation and exact job/run lineage before any claim. */
export function createStoredWeeklyRunKvBindingReader(store:DataStore){
 return async(candidateId:string):Promise<VerifiedRunKvMediaBinding|VerifiedDatasetDirectMediaBinding|null>=>{
  const record=await store.getById<Record_>('trend_videos',candidateId);
  if(!record||typeof record.tenantId!=='string'||typeof record.sourceUrl!=='string')return null;
  const identity=videoSourceIdentity('tiktok',record.sourceUrl),match=/^tiktok:id:(\d{8,30})$/.exec(identity);
  if(!match)return null;
  const analysis=object(record.aiAnalysis),origins=(Array.isArray(analysis.discoveryOrigins)?analysis.discoveryOrigins:[]).map(object);
  const weekly=origins.filter(origin=>object(origin.weeklyOriginalAccountCollection).originalRunKey);
  if(weekly.length!==1||typeof weekly[0]!.runId!=='string')return null;
  const runs=await store.list<Record_>('social_discovery_runs',{where:{tenant_id:record.tenantId,runId:String(weekly[0]!.runId)},perPage:2});
  const producer=object(object(runs.items[0]?.scopeSnapshot).weeklyProducer);
  if(runs.totalItems!==1||producer.originalDatasetCandidateIds&&!Array.isArray(producer.originalDatasetCandidateIds)||
    !Array.isArray(producer.originalDatasetCandidateIds)||!producer.originalDatasetCandidateIds.includes(candidateId))return null;
  const providerRun=String(producer.originalDatasetProviderRunId||''),datasetId=String(producer.originalDatasetId||'');
  if(!providerRun||!datasetId)return null;
  const direct=object(producer.originalDatasetDirectMedia),media=object(direct[match[1]!]);
  if(Object.keys(media).length)return media.providerRunId===providerRun&&media.datasetId===datasetId&&validHash(media.sourceUrlSha256)&&validHash(media.contentSha256)&&Number.isSafeInteger(media.byteLength)&&Number(media.byteLength)>=32&&typeof media.filePath==='string'&&typeof media.receiptPath==='string'
   ?{kind:'original_dataset_direct_media',tenantId:record.tenantId,packageId:String(producer.packageId||''),packageVersion:Number(producer.packageVersion||0),jobId:String(producer.jobId||''),videoId:match[1]!,providerRunId:providerRun,datasetId,sourceUrlSha256:String(media.sourceUrlSha256),contentSha256:String(media.contentSha256),byteLength:Number(media.byteLength),filePath:String(media.filePath),receiptPath:String(media.receiptPath)}:null;
  const rows=await store.list<Record_>(APIFY_RUN_KV_MAPPING_RECEIPTS,{where:{tenant_id:record.tenantId},perPage:500});
  if(rows.items.length!==rows.totalItems)return null;
  const matches=rows.items.flatMap(row=>{
   const signed=row.payload as SignedRunKvMapping|undefined,s=signed?.statement;
   if(!s||s.tenantId!==record.tenantId||s.runId!==providerRun||s.datasetId!==datasetId||s.datasetVideoId!==match[1])return [];
   return [{tenantId:s.tenantId,packageId:s.packageId,packageVersion:s.packageVersion,jobId:s.jobId,runId:s.runId,datasetId:s.datasetId,defaultKeyValueStoreId:s.defaultKeyValueStoreId,datasetVideoId:s.datasetVideoId,recordKey:s.recordKey,mappingReceiptId:row.id}];
  });
  return matches.length===1?matches[0]!:null;
 };
}

/** A paid KV GET must have its own verified ledger permission. The default
 * production path has no such reader and makes no provider request. */
export interface WeeklyCandidateCanonicalMediaPorts {
 readPermit:(scope:Scope)=>Promise<Permit|null>;
 /** For the original five-video operation, an independently deployed wallet
  * reader must verify its exact KV child before any new paid GET claim. */
 assertOriginalKvWalletReady?:(scope:Scope)=>Promise<boolean>;
 /** Recheck the original KV child ledger and complete fee coverage before
  * each separate run/item/keys/media supplier GET. */
 assertPaidRead:(permit:Permit,scope:Scope,request:Parameters<ApifySameRunPaidReadPermit['assertCurrent']>[0])=>Promise<void>;
 token:string;
 mappingAuthorities:readonly RunKvMappingAuthority[];
 isMappingRevoked:(issuerId:string,keyId:string,receiptId:string)=>Promise<boolean|null>;
 fetcher?:typeof fetch;
 /** Tests can replace this with the real same-run reader; never accept caller files. */
 readSameRun?:typeof readSameRunApifyKvVideo;
}
function checkedPermit(value:Permit|null,scope:Scope,token:string):Permit|null{
 if(!value)return null;
 // New canonical operations require the wallet's explicit scheme. Existing
 // immutable operations without a scheme remain read-only recoverable below.
 if(value.kind!=='apify_same_run_kv_get'||value.status!=='authorized'||value.tokenFingerprintScheme!==APIFY_PREPAID_TOKEN_FINGERPRINT_SCHEME||!value.permitId||!value.ledgerOperationId||!validHash(value.ledgerOutcomeHash)||value.scopeHash!==socialRequestHash(scope)||value.tokenFingerprint!==apifyTokenFingerprint(token,APIFY_PREPAID_TOKEN_FINGERPRINT_SCHEME))fail('permit_invalid');
 return value;
}
function readOperation(row:Record_,id:string,scope:Scope):Operation{
 const p=row.payload as Operation;
 if(!p||row.id!==id||row.tenant_id!==scope.tenantId||p.id!==id||p.schema!=='weekly-candidate-canonical-media-operation.v1'||p.state!=='submitted_or_unknown'||socialRequestHash(p.scope)!==socialRequestHash(scope)||p.recordHash!==row.record_hash||seal(p).recordHash!==p.recordHash)fail('operation_changed');
 return p;
}
async function canonicalFile(mediaRoot:string,scope:Pick<Scope,'tenantId'|'candidateId'|'mediaByteLength'|'mediaSha256'>,source:string):Promise<string>{
 const target=path.resolve(mediaRoot,'tenants',scope.tenantId,'reference-videos',`${scope.candidateId}.mp4`);
 const base=path.resolve(mediaRoot,'tenants',scope.tenantId,'reference-videos');
 if(!target.startsWith(base+path.sep)||!path.isAbsolute(mediaRoot))fail('media_root_invalid');
 const bytes=await fs.readFile(source).catch(()=>fail('source_missing'));
 if(bytes.length!==scope.mediaByteLength||sha(bytes)!==scope.mediaSha256)fail('source_changed');
 await fs.mkdir(base,{recursive:true,mode:0o700});
 const existing=await fs.readFile(target).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return null;throw error;});
 if(existing){if(sha(existing)!==scope.mediaSha256)fail('canonical_conflict');return target;}
 // Same directory, SHA-locked copy. A concurrent writer may win; recheck it.
 const temp=path.join(base,`.${scope.candidateId}.${scope.mediaSha256}.tmp`);
 const handle=await fs.open(temp,'wx',0o600).catch(()=>fail('file_claim_busy'));
 try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
 try{await fs.link(temp,target);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
 finally{await fs.rm(temp,{force:true});}
 if(sha(await fs.readFile(target))!==scope.mediaSha256)fail('canonical_conflict');
 const directory=await fs.open(base,'r');try{await directory.sync();}finally{await directory.close();}
 return target;
}

async function advanceDirect(input:{store:DataStore;job:Job;run:SocialInspirationCollectionRun;record:Record_;mediaRoot:string;binding:VerifiedDatasetDirectMediaBinding}):Promise<{state:'completed'|'blocked'|'unknown';code:string;receiptId:string|null}>{
 const {store,job,run,record,binding,mediaRoot}=input,analysis=object(record.aiAnalysis),identity=/^tiktok:id:(\d{8,30})$/.exec(videoSourceIdentity('tiktok',String(record.sourceUrl))),producer=object(object(run.scopeSnapshot).weeklyProducer);
 if(!identity||binding.videoId!==identity[1]||binding.tenantId!==job.tenantId||binding.jobId!==job.jobId||binding.packageId!==job.packageId||binding.packageVersion!==job.packageVersion||binding.providerRunId!==producer.originalDatasetProviderRunId||binding.datasetId!==producer.originalDatasetId||!Array.isArray(producer.originalDatasetCandidateIds)||!producer.originalDatasetCandidateIds.includes(record.id)||record.tenantId!==job.tenantId)return fail('direct_lineage_invalid');
 const scope:DirectScope={tenantId:job.tenantId,programId:job.programId,packageId:job.packageId,packageVersion:job.packageVersion,jobId:job.jobId,runId:run.runId,runHash:socialRequestHash(run),candidateId:record.id,sourceUrl:String(record.sourceUrl),providerRunId:binding.providerRunId,datasetId:binding.datasetId,datasetVideoId:binding.videoId,sourceUrlSha256:binding.sourceUrlSha256,mediaSha256:binding.contentSha256,mediaByteLength:binding.byteLength,filePath:binding.filePath,receiptPath:binding.receiptPath};
 const id=socialRequestHash({kind:'weekly-candidate-canonical-media.direct-dataset.v2',scope}).slice(0,15),expected=`tenants/${job.tenantId}/reference-videos/${record.id}.mp4`;
 const bytes=await fs.readFile(binding.filePath).catch(()=>null),sidecar=await fs.readFile(binding.receiptPath,'utf8').then(JSON.parse).catch(()=>null) as StagedWeeklyOriginalDatasetMedia|null;
 if(!bytes||bytes.length!==binding.byteLength||sha(bytes)!==binding.contentSha256||!sidecar||sidecar.videoId!==binding.videoId||sidecar.datasetId!==binding.datasetId||sidecar.providerRunId!==binding.providerRunId||sidecar.contentSha256!==binding.contentSha256||sidecar.byteLength!==binding.byteLength||sidecar.filePath!==binding.filePath)return fail('direct_media_changed');
 if(!await store.supportsAtomicCompareAndSwap?.()||!store.compareAndSwap)return fail('atomic_cas_required');
 let op=await store.getById<Record_>(WEEKLY_CANDIDATE_CANONICAL_MEDIA_OPERATIONS,id);if(!op){const payload=seal({schema:'weekly-candidate-canonical-media-operation.direct-dataset.v2',id,scope,state:'local_verified',recordHash:''});if(!await store.create(WEEKLY_CANDIDATE_CANONICAL_MEDIA_OPERATIONS,{id,tenant_id:job.tenantId,record_hash:payload.recordHash,payload}))return fail('operation_write_unknown');op=await store.getById<Record_>(WEEKLY_CANDIDATE_CANONICAL_MEDIA_OPERATIONS,id);}const opPayload=object(op?.payload);if(!op||op.tenant_id!==job.tenantId||op.record_hash!==opPayload.recordHash||op.record_hash!==socialRequestHash({...opPayload,recordHash:''})||socialRequestHash(opPayload.scope)!==socialRequestHash(scope))return fail('operation_changed');
 await canonicalFile(mediaRoot,scope,binding.filePath);
 if(record.videoFileId&&record.videoFileId!==expected||analysis.contentSha256&&analysis.contentSha256!==binding.contentSha256)return fail('candidate_media_conflict');
 if(record.videoFileId!==expected){const nextAnalysis=JSON.stringify({...analysis,contentSha256:binding.contentSha256});const changed=await store.compareAndSwap('trend_videos',record.id,{videoFileId:record.videoFileId,aiAnalysis:record.aiAnalysis},{videoFileId:expected,aiAnalysis:nextAnalysis});if(!changed)return fail('candidate_cas_conflict');}
 const saved=await store.getById<Record_>('trend_videos',record.id);if(!saved||!await verifiedWeeklyCandidateCanonicalMedia(saved,mediaRoot))return fail('canonical_changed');
 const receipt=seal({schema:'weekly-candidate-canonical-media-receipt.direct-dataset.v2',id,operationHash:op.record_hash,scope,videoFileId:expected,recordSnapshotHash:socialRequestHash(saved),recordHash:''}),prior=await store.getById<Record_>(WEEKLY_CANDIDATE_CANONICAL_MEDIA_RECEIPTS,id);if(prior){if(prior.record_hash!==receipt.recordHash)return fail('receipt_changed');}else if(!await store.create(WEEKLY_CANDIDATE_CANONICAL_MEDIA_RECEIPTS,{id,tenant_id:job.tenantId,record_hash:receipt.recordHash,payload:receipt}))return fail('receipt_write_unknown');
 return {state:'completed',code:'weekly_postanalysis_canonical_media_ready',receiptId:id};
}
/** New paid GET is allowed once only. Unknown submissions recover solely from
 * the already verified local SHA file; they never issue another supplier GET. */
export async function advanceWeeklyCandidateCanonicalMedia(input:{store:DataStore;job:Job;run:SocialInspirationCollectionRun;record:Record_;mediaRoot:string;binding:VerifiedRunKvMediaBinding|VerifiedDatasetDirectMediaBinding|null;ports?:WeeklyCandidateCanonicalMediaPorts}):Promise<{state:'completed'|'blocked'|'unknown';code:string;receiptId:string|null}>{
 const {store,job,run,record,binding,mediaRoot}=input;
 if(binding&&isDirectBinding(binding))return advanceDirect({store,job,run,record,mediaRoot,binding});
 if(!binding||!input.ports)return {state:'blocked',code:'weekly_postanalysis_canonical_media_permit_required',receiptId:null};
 const analysis=object(record.aiAnalysis),origins=Array.isArray(analysis.discoveryOrigins)?analysis.discoveryOrigins.map(object):[];
 const origin=origins.filter(o=>o.runId===run.runId&&o.scopeId===job.authority?.scopeId&&o.scopeVersion===job.authority?.scopeVersion&&o.mode==='account');
 const weeklyOrigin=origin.length===1?object(origin[0]?.weeklyOriginalAccountCollection):{},producer=object(object(run.scopeSnapshot).weeklyProducer);
 const originalProviderRun=Boolean(weeklyOrigin.originalRunKey);
 const providerLineage=originalProviderRun
  ? producer.key===weeklyOrigin.originalRunKey&&producer.originalDatasetProviderRunId===binding.runId&&producer.originalDatasetId===binding.datasetId&&
    Array.isArray(producer.originalDatasetCandidateIds)&&producer.originalDatasetCandidateIds.includes(record.id)&&validHash(producer.originalDatasetDigest)
  : binding.runId===run.runId;
 if(!safeSegment(job.tenantId)||!safeSegment(record.id)||record.tenantId!==job.tenantId||record.platform!=='tiktok'||origin.length!==1||binding.tenantId!==job.tenantId||binding.packageId!==job.packageId||binding.packageVersion!==job.packageVersion||binding.jobId!==job.jobId||!providerLineage||run.discoveryScopeId!==job.authority?.scopeId||run.discoveryScopeVersion!==job.authority?.scopeVersion||!/^[0-9]{8,30}$/.test(binding.datasetVideoId)||videoSourceIdentity('tiktok',String(record.sourceUrl))!==`tiktok:id:${binding.datasetVideoId}`)fail('lineage_invalid');
 const runRows=await store.list<Record_>('social_discovery_runs',{where:{tenant_id:job.tenantId,runId:run.runId},perPage:2});
 if(runRows.totalItems!==1||socialRequestHash(runRows.items[0])!==socialRequestHash(run))fail('run_changed');
 const current=await store.getById<Record_>('trend_videos',record.id);
 if(!current||socialRequestHash(current)!==socialRequestHash(record))fail('candidate_changed');
 // No permanent unknown claim can be created from a self-reported or revoked
 // mapping. This check is local; it does not consume a chargeable GET.
 const {mappingReceiptId:receiptId,...mappingScope}=binding;
 const signed=await readLocallyVerifiedRunKvMapping({store,scope:mappingScope,receiptId,
  authorities:input.ports.mappingAuthorities,isRevoked:input.ports.isMappingRevoked});
 const statement=signed.statement;
 if(!validHash(statement.mediaSha256)||!Number.isSafeInteger(statement.mediaByteLength)||statement.mediaByteLength<32)fail('mapping_missing');
 const scope:Scope={tenantId:job.tenantId,programId:job.programId,packageId:job.packageId,packageVersion:job.packageVersion,jobId:job.jobId,runId:run.runId,runHash:socialRequestHash(run),candidateId:record.id,sourceUrl:String(record.sourceUrl),datasetId:binding.datasetId,defaultKeyValueStoreId:binding.defaultKeyValueStoreId,datasetVideoId:binding.datasetVideoId,mappingReceiptId:binding.mappingReceiptId,recordKey:binding.recordKey,mediaSha256:String(statement.mediaSha256),mediaByteLength:Number(statement.mediaByteLength)};
 const id=socialRequestHash({kind:'weekly-candidate-canonical-media.v1',scope}).slice(0,15);
 const prior=await store.getById<Record_>(WEEKLY_CANDIDATE_CANONICAL_MEDIA_OPERATIONS,id);
 const operation=prior?readOperation(prior,id,scope):null;
 const expected=`tenants/${job.tenantId}/reference-videos/${record.id}.mp4`;
 if(record.videoFileId===expected&&analysis.contentSha256===scope.mediaSha256){
  if(!await verifiedWeeklyCandidateCanonicalMedia(record,mediaRoot))fail('canonical_changed');
  const receipt=await store.getById<Record_>(WEEKLY_CANDIDATE_CANONICAL_MEDIA_RECEIPTS,id);
  const p=receipt?.payload as Receipt|undefined;
  if(operation&&p&&p.id===id&&p.operationHash===operation.recordHash&&p.videoFileId===expected&&p.recordSnapshotHash===socialRequestHash(record)&&p.recordHash===receipt?.record_hash&&seal(p).recordHash===p.recordHash)return {state:'completed',code:'weekly_postanalysis_canonical_media_ready',receiptId:id};
  if(!operation)return {state:'unknown',code:'weekly_postanalysis_canonical_media_receipt_pending',receiptId:id};
 }
 else if(record.videoFileId||analysis.contentSha256)fail('candidate_media_conflict');
 let op=operation;
 if(!op){
  if(originalProviderRun){
   const walletReady=input.ports.assertOriginalKvWalletReady?await input.ports.assertOriginalKvWalletReady(scope).catch(()=>false):false;
   if(!walletReady)return {state:'blocked',code:'weekly_postanalysis_original_kv_wallet_required',receiptId:null};
  }
  const permit=checkedPermit(await input.ports.readPermit(scope),scope,input.ports.token);
  if(!permit)return {state:'blocked',code:'weekly_postanalysis_canonical_media_permit_required',receiptId:null};
  if(typeof input.ports.assertPaidRead!=='function')return {state:'blocked',code:'weekly_postanalysis_canonical_media_permit_required',receiptId:null};
  // This operation becomes permanently unknown after its claim. Establish
  // current authority for *every* expected paid GET before writing it, so a
  // denied/revoked cost permit does not strand a run that sent no request.
  // The adapter checks authority again immediately before each actual GET.
  const urls=apifySameRunReadUrls(statement);
  try{
   for(const request of [
    {kind:'run_get' as const,url:urls.runGet},
    {kind:'dataset_item_get' as const,url:urls.datasetItemGet},
    {kind:'kv_keys_get' as const,url:urls.kvKeysGet},
    {kind:'kv_media_get' as const,url:urls.kvMediaGet},
   ])await input.ports.assertPaidRead(permit,scope,request);
  }catch{return {state:'blocked',code:'weekly_postanalysis_canonical_media_permit_required',receiptId:null};}
  if(!await store.supportsAtomicCompareAndSwap?.()||!store.compareAndSwap)fail('atomic_cas_required');
  const claim=seal<Operation>({schema:'weekly-candidate-canonical-media-operation.v1',id,scope,permit,state:'submitted_or_unknown',recordHash:''});
  op=claim;
  if(!await store.create(WEEKLY_CANDIDATE_CANONICAL_MEDIA_OPERATIONS,{id,tenant_id:job.tenantId,record_hash:claim.recordHash,payload:claim}))fail('operation_write_unknown');
  const outputDirectory=path.resolve(mediaRoot,'tenants',job.tenantId,'reference-videos','.apify-sha');
  try{
   const paidRead:ApifySameRunPaidReadPermit={permitsPaidCollection:true,tokenFingerprintScheme:permit.tokenFingerprintScheme,tokenFingerprint:permit.tokenFingerprint,runId:scope.runId,datasetId:scope.datasetId,
    assertCurrent:request=>input.ports!.assertPaidRead(permit,scope,request)};
   const read=await (input.ports.readSameRun??readSameRunApifyKvVideo)({binding,store,mappingAuthorities:input.ports.mappingAuthorities,isMappingRevoked:input.ports.isMappingRevoked,token:input.ports.token,outputDirectory,fetcher:input.ports.fetcher,paidRead});
   if(read.filePath!==path.join(outputDirectory,`${scope.mediaSha256}.mp4`)||read.contentSha256!==scope.mediaSha256||read.byteLength!==scope.mediaByteLength||read.mappingReceiptId!==binding.mappingReceiptId)fail('read_result_changed');
   const readReceipt=seal({schema:'weekly-candidate-canonical-media-read-receipt.v1',id,operationHash:claim.recordHash,scopeHash:socialRequestHash(scope),filePath:read.filePath,contentSha256:read.contentSha256,byteLength:read.byteLength,recordHash:''});
   if(!await store.create(WEEKLY_CANDIDATE_CANONICAL_MEDIA_READ_RECEIPTS,{id,tenant_id:job.tenantId,record_hash:readReceipt.recordHash,payload:readReceipt}))fail('read_receipt_write_unknown');
  }
  catch{return {state:'unknown',code:'weekly_postanalysis_canonical_media_get_unknown',receiptId:id};}
 }
 if(!op)fail('operation_missing');
 // After a crash, only the immutable signed media hash and already fsynced
 // bytes may advance. No mapping/MP4 provider GET is repeated.
 const source=path.resolve(mediaRoot,'tenants',job.tenantId,'reference-videos','.apify-sha',`${scope.mediaSha256}.mp4`);
 const readRow=await store.getById<Record_>(WEEKLY_CANDIDATE_CANONICAL_MEDIA_READ_RECEIPTS,id),read=readRow?.payload as ReadReceipt|undefined;
 if(!read||read.schema!=='weekly-candidate-canonical-media-read-receipt.v1'||readRow?.tenant_id!==job.tenantId||read.operationHash!==op.recordHash||read.scopeHash!==socialRequestHash(scope)||read.filePath!==source||read.contentSha256!==scope.mediaSha256||read.byteLength!==scope.mediaByteLength||read.recordHash!==readRow?.record_hash||seal(read).recordHash!==read.recordHash)return {state:'unknown',code:'weekly_postanalysis_canonical_media_get_unknown',receiptId:id};
 if(!await fs.stat(source).catch(()=>null))return {state:'unknown',code:'weekly_postanalysis_canonical_media_get_unknown',receiptId:id};
 if(record.videoFileId!==expected)await canonicalFile(mediaRoot,scope,source);
 const next={...record,videoFileId:expected,aiAnalysis:JSON.stringify({...analysis,contentSha256:scope.mediaSha256})};
 const changed=record.videoFileId===expected?false:await store.compareAndSwap!('trend_videos',record.id,{videoFileId:record.videoFileId,aiAnalysis:record.aiAnalysis},{videoFileId:expected,aiAnalysis:next.aiAnalysis});
 const saved=await store.getById<Record_>('trend_videos',record.id);
 if(!changed&&(!saved||saved.videoFileId!==expected||object(saved.aiAnalysis).contentSha256!==scope.mediaSha256))fail('candidate_cas_conflict');
 if(!saved||!await verifiedWeeklyCandidateCanonicalMedia(saved,mediaRoot))fail('canonical_changed');
 const receipt=seal({schema:'weekly-candidate-canonical-media-receipt.v1',id,operationHash:op.recordHash,scope,permit:op.permit,videoFileId:expected,recordSnapshotHash:socialRequestHash(saved),recordHash:''});
 const previous=await store.getById<Record_>(WEEKLY_CANDIDATE_CANONICAL_MEDIA_RECEIPTS,id);
 if(previous){if(previous.record_hash!==receipt.recordHash||socialRequestHash(previous.payload)!==receipt.recordHash)fail('receipt_changed');}
 else if(!await store.create(WEEKLY_CANDIDATE_CANONICAL_MEDIA_RECEIPTS,{id,tenant_id:job.tenantId,record_hash:receipt.recordHash,payload:receipt}))fail('receipt_write_unknown');
 return {state:'completed',code:'weekly_postanalysis_canonical_media_ready',receiptId:id};
}
