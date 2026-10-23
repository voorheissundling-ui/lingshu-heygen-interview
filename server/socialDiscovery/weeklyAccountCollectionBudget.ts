import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import type {DataStore,Record_} from '../storage/datastore.js';
import {withPaidOperationLock} from '../lib/paidOperationLock.js';
import {readWeeklyReviewActor} from '../socialPrograms/weeklyReviewEvidence.js';
import {organizationRoleOrNull} from '../lib/organizationRole.js';
import {socialRequestHash} from '../starter198/socialContentValidation.js';
import {createApifyPrepaidOriginalGetPort} from './apifyPrepaidOriginalGet.js';
import {apifyTokenFingerprint,APIFY_PREPAID_TOKEN_FINGERPRINT_SCHEME} from './apifyTokenFingerprint.js';
import {WEEKLY_ACCOUNT_COLLECTION_ACTOR_RUN_ENDPOINT} from './apifyPrepaidOriginalPost.js';

export const WEEKLY_ACCOUNT_COLLECTION_BUDGET_AUTHORIZATIONS='social_weekly_account_collection_budget_authorizations';
export const WEEKLY_ACCOUNT_COLLECTION_BUDGET_REVOCATIONS='social_weekly_account_collection_budget_revocations';
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fail=(code:string):never=>{throw Error(`weekly_account_collection_budget_${code}`);};
const micros=(n:number)=>Math.round(n*1_000_000);
const money=(n:unknown)=>typeof n==='number'&&Number.isFinite(n)&&n>0&&Number.isSafeInteger(micros(n))&&Math.abs(micros(n)/1_000_000-n)<1e-9;
const id=(scope:{tenantId:string;programId:string;packageId:string;packageVersion:number})=>hash(['weekly-account-collection-budget.v1',scope.tenantId,scope.programId,scope.packageId,scope.packageVersion]).slice(0,15);
const revocationId=(authorizationId:string)=>hash(['weekly-account-collection-budget-revocation.v1',authorizationId]).slice(0,15);
const ledgerFile=(root:string,scope:{tenantId:string;programId:string;packageId:string;packageVersion:number})=>path.join(root,hash([scope.tenantId,scope.programId,scope.packageId,scope.packageVersion])+'.json');
async function one<T>(store:DataStore,collection:string,where:Record<string,string|number>):Promise<T&Record_>{const rows=await store.list<T&Record_>(collection,{where,perPage:2});if(rows.totalItems!==1||rows.items.length!==1)return fail('lineage_missing_or_ambiguous');return rows.items[0]!;}
async function actor(store:DataStore,tenantId:string,userId:string){const a=await readWeeklyReviewActor(store,tenantId,userId);if(!a||a.tenantId!==tenantId||!['admin','super_admin','social_operator'].includes(organizationRoleOrNull(a.role)??'')||a.active===false||a.disabled===true||['disabled','suspended'].includes(String(a.status)))fail('actor_invalid');}

export interface WeeklyAccountCollectionBudgetAuthorization {
 schema:'weekly-account-collection-budget.v1';authorizationId:string;tenantId:string;programId:string;packageId:string;packageVersion:number;
 scopeId:string;scopeVersion:number;scopeHash:string;accountUrl:string;actorId:string;
 totalLimitCny:number;perRunLimitCny:number;approvedBy:string;approvedAt:string;expiresAt:string;status:'approved';recordHash:string;
}
export async function issueWeeklyAccountCollectionBudgetAuthorization(input:{store:DataStore;tenantId:string;actorUserId:string;programId:string;packageId:string;packageVersion:number;scopeId:string;scopeVersion:number;scopeHash:string;actorId:string;totalLimitCny:number;perRunLimitCny:number;expiresAt:string;now?:()=>number}):Promise<WeeklyAccountCollectionBudgetAuthorization>{
 const {store}=input,now=input.now??Date.now;await actor(store,input.tenantId,input.actorUserId);
 const configuredActor=process.env.APIFY_TIKTOK_ACTOR?.trim()||'clockworks/tiktok-scraper';
 if(!input.tenantId||!input.programId||!input.packageId||!Number.isSafeInteger(input.packageVersion)||input.packageVersion<1||!input.scopeId||!Number.isSafeInteger(input.scopeVersion)||input.scopeVersion<1||!money(input.totalLimitCny)||!money(input.perRunLimitCny)||input.perRunLimitCny > input.totalLimitCny||!Number.isFinite(Date.parse(input.expiresAt))||Date.parse(input.expiresAt)<=now()||Date.parse(input.expiresAt)>now()+31*86400000||!input.scopeHash||input.actorId!==configuredActor)fail('approval_input_invalid');
 const pkg=await one<{payload:{packageId?:string;version?:number;status?:string;discoveryBudgetCny?:number|null}}>(store,'social_weekly_operating_packages',{tenant_id:input.tenantId,program_id:input.programId,package_id:input.packageId,version:input.packageVersion});
 if(pkg.payload?.packageId!==input.packageId||pkg.payload.version!==input.packageVersion||!['draft','active'].includes(String(pkg.payload.status)))fail('package_changed');
 if(!money(pkg.payload.discoveryBudgetCny)||input.totalLimitCny>pkg.payload.discoveryBudgetCny!)fail('package_discovery_budget_exceeded');
 const scope=await store.getById<Record_>('social_discovery_scopes',input.scopeId),strategy=scope?.payload as {approval?:{status?:string;scopeVersion?:number};weeklyAccountRevision?:{accountUrl?:string;targetCount?:number}}|undefined;
 if(!scope||scope.tenant_id!==input.tenantId||scope.version!==input.scopeVersion||scope.status!=='active'||socialRequestHash(scope.payload)!==input.scopeHash||strategy?.approval?.status!=='approved'||strategy.approval.scopeVersion!==input.scopeVersion||strategy.weeklyAccountRevision?.targetCount!==5||!strategy.weeklyAccountRevision.accountUrl)fail('scope_changed');
 const accountUrl=strategy!.weeklyAccountRevision!.accountUrl!;
 const jobs=await store.list<{record_hash?:string;payload?:{recordHash?:string;tenantId?:string;programId?:string;packageId?:string;packageVersion?:number;kind?:string;authority?:{scopeId?:string;scopeVersion?:number;scopeHash?:string}}}>('social_weekly_preproduction_jobs',{where:{tenant_id:input.tenantId,program_id:input.programId,package_id:input.packageId,package_version:input.packageVersion},perPage:100});
 if(jobs.totalItems!==jobs.items.length||!jobs.items.some(row=>{const job=row.payload;return job?.kind==='discovery'&&job.tenantId===input.tenantId&&job.programId===input.programId&&job.packageId===input.packageId&&job.packageVersion===input.packageVersion&&job.authority?.scopeId===input.scopeId&&job.authority.scopeVersion===input.scopeVersion&&job.authority.scopeHash===input.scopeHash&&job.recordHash===row.record_hash&&job.recordHash===socialRequestHash({...job,recordHash:''});}))fail('job_lineage_missing');
 const accounts=await store.list<{tenantId:string;platform:string;accountUrl:string}>('competitor_accounts',{where:{tenantId:input.tenantId},perPage:200});
 if(accounts.totalItems!==accounts.items.length||!accounts.items.some(account=>account.platform==='tiktok'&&account.accountUrl===accountUrl))fail('account_library_changed');
 const authorizationId=id(input);if(await store.getById(WEEKLY_ACCOUNT_COLLECTION_BUDGET_AUTHORIZATIONS,authorizationId))fail('authorization_already_exists');
 const item:WeeklyAccountCollectionBudgetAuthorization={schema:'weekly-account-collection-budget.v1',authorizationId,tenantId:input.tenantId,programId:input.programId,packageId:input.packageId,packageVersion:input.packageVersion,scopeId:input.scopeId,scopeVersion:input.scopeVersion,scopeHash:input.scopeHash,accountUrl,actorId:input.actorId,totalLimitCny:input.totalLimitCny,perRunLimitCny:input.perRunLimitCny,approvedBy:input.actorUserId,approvedAt:new Date(now()).toISOString(),expiresAt:input.expiresAt,status:'approved',recordHash:''};
 item.recordHash=socialRequestHash({...item,recordHash:''});
 if(!await store.create(WEEKLY_ACCOUNT_COLLECTION_BUDGET_AUTHORIZATIONS,{id:authorizationId,tenant_id:item.tenantId,program_id:item.programId,package_id:item.packageId,package_version:item.packageVersion,scope_id:item.scopeId,status:'approved',record_hash:item.recordHash,payload:item}))fail('authorization_write_unknown');
 return item;
}
export async function revokeWeeklyAccountCollectionBudgetAuthorization(input:{store:DataStore;tenantId:string;actorUserId:string;authorizationId:string;reason:string;now?:()=>number}){
 await actor(input.store,input.tenantId,input.actorUserId);const row=await input.store.getById<Record_>(WEEKLY_ACCOUNT_COLLECTION_BUDGET_AUTHORIZATIONS,input.authorizationId),a=row?.payload as WeeklyAccountCollectionBudgetAuthorization|undefined;
 if(!a||a.tenantId!==input.tenantId||row?.record_hash!==a.recordHash||socialRequestHash({...a,recordHash:''})!==a.recordHash||!input.reason?.trim()||input.reason.length>1000)fail('revocation_scope_invalid');
 const checked=a!,key=revocationId(checked.authorizationId),prior=await input.store.getById<Record_>(WEEKLY_ACCOUNT_COLLECTION_BUDGET_REVOCATIONS,key);if(prior)return prior.payload;
 const item={schema:'weekly-account-collection-budget-revocation.v1',revocationId:key,authorizationId:checked.authorizationId,authorizationHash:checked.recordHash,tenantId:checked.tenantId,revokedBy:input.actorUserId,revokedAt:new Date((input.now??Date.now)()).toISOString(),reason:input.reason.trim()};
 if(!await input.store.create(WEEKLY_ACCOUNT_COLLECTION_BUDGET_REVOCATIONS,{id:key,tenant_id:checked.tenantId,authorization_id:checked.authorizationId,record_hash:socialRequestHash(item),payload:item}))fail('revocation_write_unknown');return item;
}
export async function readCurrentWeeklyAccountCollectionBudget(store:DataStore,scope:{tenantId:string;programId:string;packageId:string;packageVersion:number;scopeId:string;scopeVersion:number;scopeHash:string;accountUrl:string},now=Date.now()):Promise<WeeklyAccountCollectionBudgetAuthorization>{
 const row=await one<{payload:WeeklyAccountCollectionBudgetAuthorization;record_hash:string}>(store,WEEKLY_ACCOUNT_COLLECTION_BUDGET_AUTHORIZATIONS,{tenant_id:scope.tenantId,program_id:scope.programId,package_id:scope.packageId,package_version:scope.packageVersion,status:'approved'}),a=row.payload;
 if(!a||a.schema!=='weekly-account-collection-budget.v1'||row.id!==a.authorizationId||row.record_hash!==a.recordHash||socialRequestHash({...a,recordHash:''})!==a.recordHash||a.tenantId!==scope.tenantId||a.programId!==scope.programId||a.packageId!==scope.packageId||a.packageVersion!==scope.packageVersion||a.scopeId!==scope.scopeId||a.scopeVersion!==scope.scopeVersion||a.scopeHash!==scope.scopeHash||a.accountUrl!==scope.accountUrl||!money(a.totalLimitCny)||!money(a.perRunLimitCny)||a.perRunLimitCny>a.totalLimitCny||!Number.isFinite(Date.parse(a.expiresAt))||Date.parse(a.expiresAt)<=now)fail('authorization_changed_or_expired');
 const pkg=await one<{payload:{packageId?:string;version?:number;status?:string;discoveryBudgetCny?:number|null}}>(store,'social_weekly_operating_packages',{tenant_id:a.tenantId,program_id:a.programId,package_id:a.packageId,version:a.packageVersion});
 if(pkg.payload?.packageId!==a.packageId||pkg.payload.version!==a.packageVersion||!['draft','active'].includes(String(pkg.payload.status)))fail('package_budget_changed');
 // Packages created before discoveryBudgetCny became mandatory can adopt the
 // already-issued, immutable authorization as their version-scoped budget
 // addendum. New grants still require a package budget in the issuer above.
 // Once a concrete package budget exists it remains authoritative, including
 // a later reduction below the signed amount.
 if(pkg.payload.discoveryBudgetCny!==null&&pkg.payload.discoveryBudgetCny!==undefined&&(!money(pkg.payload.discoveryBudgetCny)||a.totalLimitCny>pkg.payload.discoveryBudgetCny))fail('package_budget_changed');
 const currentScope=await store.getById<Record_>('social_discovery_scopes',a.scopeId),revision=(currentScope?.payload as {weeklyAccountRevision?:{accountUrl?:string;targetCount?:number};approval?:{status?:string;scopeVersion?:number}}|undefined);
 if(!currentScope||currentScope.tenant_id!==a.tenantId||currentScope.status!=='active'||currentScope.version!==a.scopeVersion||socialRequestHash(currentScope.payload)!==a.scopeHash||revision?.approval?.status!=='approved'||revision.approval.scopeVersion!==a.scopeVersion||revision.weeklyAccountRevision?.accountUrl!==a.accountUrl||revision.weeklyAccountRevision.targetCount!==5)fail('scope_changed');
 const accounts=await store.list<{accountUrl:string;platform:string}>('competitor_accounts',{where:{tenantId:a.tenantId},perPage:200});
 if(accounts.totalItems!==accounts.items.length||!accounts.items.some(account=>account.platform==='tiktok'&&account.accountUrl===a.accountUrl))fail('account_library_changed');
 const revoked=await store.getById<Record_>(WEEKLY_ACCOUNT_COLLECTION_BUDGET_REVOCATIONS,revocationId(a.authorizationId));if(revoked)fail('authorization_revoked');return a;
}

export interface WeeklyAccountCollectionLedgerEntry {operationId:string;requestHash:string|null;actorId:string;capUsd:number;fxCnyPerUsdUpper:number;fxEvidenceRef:string;reservedCnyMicros:number;status:'reserved'|'submitted_unknown'|'submitted_known'|'completed';runId:string|null;datasetId:string|null;usageTotalUsd:number|null;}
interface Ledger {schema:1;authorizationId:string;authorizationHash:string;limitMicros:number;entries:Record<string,WeeklyAccountCollectionLedgerEntry>;}
function readLedger(file:string,a:WeeklyAccountCollectionBudgetAuthorization):Ledger|null{
 if(!fs.existsSync(file))return null;let l:Ledger;try{l=JSON.parse(fs.readFileSync(file,'utf8'));}catch{return fail('ledger_corrupt');}
 if(l.schema!==1||l.authorizationId!==a.authorizationId||l.authorizationHash!==a.recordHash||l.limitMicros!==micros(a.totalLimitCny)||!l.entries||typeof l.entries!=='object'||Array.isArray(l.entries))fail('ledger_changed');
 let total=0;for(const [key,e] of Object.entries(l.entries)){if(key!==hash(e.operationId)||!e.operationId||e.actorId!==a.actorId||!Number.isSafeInteger(e.reservedCnyMicros)||e.reservedCnyMicros<=0||e.reservedCnyMicros>micros(a.perRunLimitCny)||!Number.isFinite(e.capUsd)||e.capUsd<=0||!Number.isFinite(e.fxCnyPerUsdUpper)||e.fxCnyPerUsdUpper<=0||!e.fxEvidenceRef||e.reservedCnyMicros!==Math.ceil(e.capUsd*e.fxCnyPerUsdUpper*1_000_000-1e-9)||!['reserved','submitted_unknown','submitted_known','completed'].includes(e.status)||e.status!=='reserved'&&!/^[a-f0-9]{64}$/.test(e.requestHash??'')||e.status==='submitted_known'&&!e.runId||e.status==='completed'&&(!e.runId||e.usageTotalUsd===null))fail('ledger_corrupt');total+=e.reservedCnyMicros;}
 if(!Number.isSafeInteger(total)||total>l.limitMicros)fail('ledger_corrupt');return l;
}
function writeLedger(root:string,file:string,l:Ledger|PrepaidLedger|PrepaidBinding){fs.mkdirSync(root,{recursive:true,mode:0o700});const tmp=file+'.'+randomUUID()+'.tmp',fd=fs.openSync(tmp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(l));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);const dir=fs.openSync(root,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}}

/** Experimental bookkeeping shape for an independently verified, non-reloadable
 * prepaid token. This is not a paid permit; the formal collection gate stays
 * closed until a provider contract and purchase evidence can be authenticated.
 * The caller must use one shared root across all tenants and package weeks. */
type PrepaidChildKind='run'|'dataset_read'|'kv_get';
interface PrepaidChildEntry {kind:PrepaidChildKind;operationId:string;requestHash:string|null;status:'reserved'|'submitted_unknown'|'submitted_known'|'completed';providerRef:string|null;}
interface PrepaidLedger {schema:2;authorizationId:string;authorizationHash:string;tokenFingerprint:string;purchaseEvidenceHash:string;costCoverageEvidenceHash:string;purchaseCnyMicros:number;limitMicros:number;entries:Record<string,PrepaidChildEntry>;}
interface PrepaidBinding {schema:'weekly-account-collection-prepaid-binding.v1';authorizationId:string;authorizationHash:string;tenantId:string;programId:string;packageId:string;packageVersion:number;tokenFingerprint:string;purchaseEvidenceHash:string;costCoverageEvidenceHash:string;purchaseCnyMicros:number;}
const sha256=(s:string)=>/^[a-f0-9]{64}$/.test(s);
function readPrepaidLedger(file:string,b:PrepaidBinding,a:WeeklyAccountCollectionBudgetAuthorization):PrepaidLedger|null{
 if(!fs.existsSync(file))return null;
 let l:PrepaidLedger;try{l=JSON.parse(fs.readFileSync(file,'utf8'));}catch{return fail('ledger_corrupt');}
 if(l.schema!==2||l.authorizationId!==a.authorizationId||l.authorizationHash!==a.recordHash||l.tokenFingerprint!==b.tokenFingerprint||l.purchaseEvidenceHash!==b.purchaseEvidenceHash||l.costCoverageEvidenceHash!==b.costCoverageEvidenceHash||l.purchaseCnyMicros!==b.purchaseCnyMicros||l.limitMicros!==micros(a.totalLimitCny)||!l.entries||typeof l.entries!=='object'||Array.isArray(l.entries))fail('ledger_changed');
 for(const [key,e] of Object.entries(l.entries)){
  if(!e||!['run','dataset_read','kv_get'].includes(e.kind)||!e.operationId||key!==hash([e.kind,e.operationId])||!['reserved','submitted_unknown','submitted_known','completed'].includes(e.status)||e.status==='reserved'&&e.requestHash!==null||e.status!=='reserved'&&!sha256(e.requestHash??'')||e.status==='submitted_known'&&!e.providerRef||e.status==='completed'&&!e.providerRef)fail('ledger_corrupt');
 }
 return l;
}
function readBinding(file:string):PrepaidBinding|null{
 if(!fs.existsSync(file))return null;
 let b:PrepaidBinding;try{b=JSON.parse(fs.readFileSync(file,'utf8'));}catch{return fail('prepaid_binding_corrupt');}
 if(b.schema!=='weekly-account-collection-prepaid-binding.v1'||!b.authorizationId||!sha256(b.authorizationHash)||!b.tenantId||!b.programId||!b.packageId||!Number.isSafeInteger(b.packageVersion)||!sha256(b.tokenFingerprint)||!sha256(b.purchaseEvidenceHash)||!sha256(b.costCoverageEvidenceHash)||!Number.isSafeInteger(b.purchaseCnyMicros)||b.purchaseCnyMicros<=0)fail('prepaid_binding_corrupt');
 return b;
}

/** Registers the entire settled CNY purchase once, instead of charging every
 * child run for the same wallet. The authoritative verifier must independently
 * prove the purchase, no recharge/overage, and that Actor + platform + dataset
 * charges all drain this one token. No network calls or spend permission here. */
export async function prepareWeeklyAccountCollectionPrepaidWallet(input:{authorization:WeeklyAccountCollectionBudgetAuthorization;root:string;token:string;purchaseCostCny:number;purchaseEvidenceHash:string;costCoverageEvidenceHash:string;assertCurrent:()=>Promise<void>;assertVerifiedPurchase:()=>Promise<void>}){
 const a=input.authorization,root=path.resolve(input.root),fingerprint=apifyTokenFingerprint(input.token,APIFY_PREPAID_TOKEN_FINGERPRINT_SCHEME),purchaseCnyMicros=micros(input.purchaseCostCny);
 if(!input.token.trim()||!money(input.purchaseCostCny)||purchaseCnyMicros>micros(a.totalLimitCny)||purchaseCnyMicros>micros(a.perRunLimitCny)||!sha256(input.purchaseEvidenceHash)||!sha256(input.costCoverageEvidenceHash))fail('prepaid_purchase_invalid');
 const binding:PrepaidBinding={schema:'weekly-account-collection-prepaid-binding.v1',authorizationId:a.authorizationId,authorizationHash:a.recordHash,tenantId:a.tenantId,programId:a.programId,packageId:a.packageId,packageVersion:a.packageVersion,tokenFingerprint:fingerprint,purchaseEvidenceHash:input.purchaseEvidenceHash,costCoverageEvidenceHash:input.costCoverageEvidenceHash,purchaseCnyMicros};
 const file=ledgerFile(root,a),bindingRoot=path.join(root,'.prepaid-token-bindings'),bindingFile=path.join(bindingRoot,fingerprint+'.json');
 await withPaidOperationLock(path.join(root,'.locks'),`prepaid:${fingerprint}`,async()=>{
  await input.assertCurrent();await input.assertVerifiedPurchase();
  const existing=readBinding(bindingFile);
  if(existing&&JSON.stringify(existing)!==JSON.stringify(binding))fail('prepaid_token_already_bound');
  if(!existing)writeLedger(bindingRoot,bindingFile,binding);
  const current=readPrepaidLedger(file,binding,a);
  if(!current)writeLedger(root,file,{schema:2,authorizationId:a.authorizationId,authorizationHash:a.recordHash,tokenFingerprint:fingerprint,purchaseEvidenceHash:input.purchaseEvidenceHash,costCoverageEvidenceHash:input.costCoverageEvidenceHash,purchaseCnyMicros,limitMicros:micros(a.totalLimitCny),entries:{}});
 });
 const child=async(kind:PrepaidChildEntry['kind'],operationId:string)=>{
  if(!operationId)fail('prepaid_operation_invalid');
  const key=hash([kind,operationId]);
  const mutate=<T>(fn:(ledger:PrepaidLedger,entry:PrepaidChildEntry)=>T|Promise<T>)=>withPaidOperationLock(path.join(root,'.locks'),`prepaid:${fingerprint}`,async()=>{
   await input.assertCurrent();const currentBinding=readBinding(bindingFile);
   if(JSON.stringify(currentBinding)!==JSON.stringify(binding))fail('prepaid_binding_changed');
   const ledger=readPrepaidLedger(file,binding,a);if(!ledger)throw Error('weekly_account_collection_budget_prepaid_operation_missing');const entry=ledger.entries[key];if(!entry)throw Error('weekly_account_collection_budget_prepaid_operation_missing');
   const result=await fn(ledger,entry);writeLedger(root,file,ledger);return result;
  });
  await withPaidOperationLock(path.join(root,'.locks'),`prepaid:${fingerprint}`,async()=>{
   await input.assertCurrent();const currentBinding=readBinding(bindingFile);
   if(JSON.stringify(currentBinding)!==JSON.stringify(binding))fail('prepaid_binding_changed');
   const ledger=readPrepaidLedger(file,binding,a);if(!ledger)throw Error('weekly_account_collection_budget_prepaid_ledger_missing');
   if(!ledger.entries[key]){ledger.entries[key]={kind,operationId,requestHash:null,status:'reserved',providerRef:null};writeLedger(root,file,ledger);}
  });
  return {
   async inspect(){await input.assertCurrent();if(JSON.stringify(readBinding(bindingFile))!==JSON.stringify(binding))fail('prepaid_binding_changed');const ledger=readPrepaidLedger(file,binding,a),entry=ledger?.entries[key];if(!entry)fail('prepaid_operation_missing');return {...entry};},
   async beforeSubmit(requestHash:string){return mutate(async(_l,e)=>{await input.assertVerifiedPurchase();if(e.status!=='reserved'||!sha256(requestHash))fail('prepaid_submission_unknown_or_changed');e.requestHash=requestHash;e.status='submitted_unknown';});},
   async recordKnown(requestHash:string,providerRef:string){return mutate((_l,e)=>{if(e.status==='submitted_known'&&e.requestHash===requestHash&&e.providerRef===providerRef)return;if(e.status!=='submitted_unknown'||e.requestHash!==requestHash||!providerRef)fail('prepaid_receipt_changed');e.providerRef=providerRef;e.status='submitted_known';});},
   async recordCompleted(requestHash:string,providerRef:string){return mutate((_l,e)=>{if(e.status==='completed'&&e.requestHash===requestHash&&e.providerRef===providerRef)return;if(e.status!=='submitted_known'||e.requestHash!==requestHash||e.providerRef!==providerRef)fail('prepaid_receipt_changed');e.status='completed';});},
  };
 };
 return {schema:'weekly-account-collection-prepaid-bookkeeping.v1' as const,tokenFingerprint:fingerprint,purchaseCnyMicros,permitsPaidCollection:false as const,child};
}

/** This contract deliberately cannot issue a paid permit. The deployment must
 * mount one private shared ledger volume for every worker; a caller cannot pick
 * a separate root to re-bind the same prepaid token to another tenant. */
function deployedPrepaidRoot():string {
 const configured=process.env.WEEKLY_ACCOUNT_COLLECTION_PREPAID_LEDGER_ROOT;
 if(!configured||!path.isAbsolute(configured)||path.normalize(configured)!==configured)fail('prepaid_deployment_root_missing');
 const root=fs.realpathSync(configured!);
 if(root!==configured||!fs.statSync(root).isDirectory())fail('prepaid_deployment_root_unsafe');
 return root;
}
export interface PrepaidCollectionOperationAuthority {
 tenantId:string;programId:string;packageId:string;packageVersion:number;
 scopeId:string;scopeVersion:number;scopeHash:string;
 jobId:string;jobRecordHash:string;
 /** The run operation belongs to the frozen job; dataset reads additionally
  * bind the already accepted run and its default dataset. */
 runOperationId:string;runId?:string;datasetId?:string;pageKey?:string;
 /** KV child is bound to the same run/dataset and one independently signed
  * mapping, one exact record key and one immutable media digest. */
 defaultKeyValueStoreId?:string;datasetPageKey?:string;datasetVideoId?:string;mappingReceiptId?:string;
 recordKey?:string;mediaSha256?:string;mediaByteLength?:number;
}
export interface PrepaidOriginalGetReceipt {
 status:number;body:unknown;url:string;
}
export interface PrepaidOriginalGetPort {
 /** Authenticated GET with the exact dedicated token. No cached or caller-
  * supplied JSON may be substituted. The port must not log the token. */
 get(input:{url:string;token:string}):Promise<PrepaidOriginalGetReceipt>;
}
export interface PrepaidDatasetPaidReadPermit {
 permitsPaidCollection:true;tokenFingerprintScheme:typeof APIFY_PREPAID_TOKEN_FINGERPRINT_SCHEME;tokenFingerprint:string;runId:string;datasetId:string;
 assertCurrent:(request:'actor_get'|'run_get'|'dataset_get')=>Promise<void>;
}
export interface PrepaidAcceptedPostReceipt {
 operationIdentity:string;requestHash:string;tokenFingerprint:string;actorInputSha256:string;
 url:string;status:number;body:unknown;
}
export interface PrepaidAcceptedPostPort {
 /** Read only the durable HTTP 201 response captured by the original POST
  * transport for this exact operation. No run-list search or inferred retry. */
 read(input:{operationIdentity:string;requestHash:string;tokenFingerprint:string}):Promise<PrepaidAcceptedPostReceipt|null>;
}
export interface PrepaidAcceptedKvGetReceipt {
 /** Durable original transport receipt, not a caller-composed success value. */
 operationIdentity:string;requestHash:string;tokenFingerprint:string;
 url:string;status:number;mediaSha256:string;mediaByteLength:number;
 runId:string;datasetId:string;defaultKeyValueStoreId:string;
 datasetVideoId:string;mappingReceiptId:string;recordKey:string;
}
export interface PrepaidAcceptedKvGetPort {
 /** Trusted internal original-transport journal contract only. Merely
  * implementing this callback does not prove provider bytes, fees, or a
  * commercial purchase and never grants a production paid-read permit. */
 read(input:{operationIdentity:string;requestHash:string;tokenFingerprint:string}):Promise<PrepaidAcceptedKvGetReceipt|null>;
}
function originalRunReceipt(receipt:PrepaidOriginalGetReceipt,runId:string,opaqueActorId:string,datasetId:string):void {
 const expected=`https://api.apify.com/v2/actor-runs/${encodeURIComponent(runId)}`;
 if(receipt.url!==expected||receipt.status!==200||!receipt.body||typeof receipt.body!=='object')fail('prepaid_original_get_invalid');
 const data=(receipt.body as {data?:unknown}).data;
 if(!data||typeof data!=='object')fail('prepaid_original_get_invalid');
 const run=data as {id?:unknown;actId?:unknown;defaultDatasetId?:unknown};
 if(run.id!==runId||run.actId!==opaqueActorId||run.defaultDatasetId!==datasetId)fail('prepaid_original_get_mismatch');
}
function acceptedPost(receipt:PrepaidAcceptedPostReceipt|null,identity:string,requestHash:string,fingerprint:string,actorSlug:string,actorInputSha256:string){
 const url=actorSlug==='clockworks/tiktok-scraper'?WEEKLY_ACCOUNT_COLLECTION_ACTOR_RUN_ENDPOINT:'';
 if(!receipt||receipt.operationIdentity!==identity||receipt.requestHash!==requestHash||receipt.tokenFingerprint!==fingerprint||receipt.actorInputSha256!==actorInputSha256||receipt.url!==url||receipt.status!==201||!receipt.body||typeof receipt.body!=='object')fail('prepaid_original_post_unavailable');
 const data=(receipt!.body as {data?:unknown}).data;
 if(!data||typeof data!=='object')fail('prepaid_original_post_invalid');
 const run=data as {id?:unknown;actId?:unknown;defaultDatasetId?:unknown};
 if(typeof run.id!=='string'||!run.id||typeof run.actId!=='string'||!run.actId||typeof run.defaultDatasetId!=='string'||!run.defaultDatasetId)fail('prepaid_original_post_invalid');
 return {runId:run.id as string,opaqueActorId:run.actId as string,datasetId:run.defaultDatasetId as string};
}
async function officialActorId(port:PrepaidOriginalGetPort,token:string,slug:string){
 const [owner,name]=slug.split('/');
 if(!owner||!name||slug.split('/').length!==2)fail('prepaid_actor_slug_invalid');
 const url=`https://api.apify.com/v2/actors/${encodeURIComponent(`${owner}~${name}`)}`;
 const receipt=await port.get({url,token}),data=(receipt.body as {data?:unknown}|null)?.data;
 if(receipt.url!==url||receipt.status!==200||!data||typeof data!=='object')fail('prepaid_actor_get_invalid');
 const actor=data as {id?:unknown;username?:unknown;name?:unknown};
 if(typeof actor.id!=='string'||!actor.id||actor.username!==owner||actor.name!==name)fail('prepaid_actor_get_mismatch');
 return actor.id as string;
}
const opScope=(a:WeeklyAccountCollectionBudgetAuthorization,o:PrepaidCollectionOperationAuthority)=>
 o.tenantId===a.tenantId&&o.programId===a.programId&&o.packageId===a.packageId&&o.packageVersion===a.packageVersion&&o.scopeId===a.scopeId&&o.scopeVersion===a.scopeVersion&&o.scopeHash===a.scopeHash&&!!o.jobId&&sha256(o.jobRecordHash)&&!!o.runOperationId;

/** The account-only request keeps the original Dataset but deliberately does
 * not copy media into Apify KV storage. The Dataset continuation must consume
 * each row's short-lived, provider-returned media URL immediately and fail
 * closed when it cannot prove one. */
export function frozenWeeklyAccountFiveVideoActorInput(accountUrl:string):Record<string,unknown>{
 const match=/^https:\/\/www\.tiktok\.com\/@([A-Za-z0-9._-]+)$/.exec(accountUrl);
 const username=match?.[1];
 if(!username||username.length>64)fail('prepaid_account_url_invalid');
 return {resultsPerPage:5,shouldDownloadVideos:false,shouldDownloadCovers:false,
  shouldDownloadSubtitles:false,shouldDownloadSlideshowImages:false,
  shouldDownloadAvatars:false,shouldDownloadMusicCovers:false,
  shouldDownloadMusic:false,profiles:[username]};
}

/** Offline integration surface. `verifyAuthority` must re-read the original
 * frozen job/run in the authoritative store on every call. A hash string or a
 * self-reported provider reference is never sufficient. This adapter remains
 * non-spending until purchase, fee coverage and exact supplier responses have
 * been independently proven in a controlled live run. */
export async function prepareDeployedWeeklyAccountCollectionPrepaidWallet(input:{
 authorization:WeeklyAccountCollectionBudgetAuthorization;token:string;purchaseCostCny:number;
 purchaseEvidenceHash:string;costCoverageEvidenceHash:string;
 assertCurrent:()=>Promise<void>;assertVerifiedPurchase:()=>Promise<void>;
 verifyAuthority:(operation:PrepaidCollectionOperationAuthority)=>Promise<void>;
 originalGet?:PrepaidOriginalGetPort;
 acceptedPost:PrepaidAcceptedPostPort;
 acceptedKvGet?:PrepaidAcceptedKvGetPort;
}){
 const root=deployedPrepaidRoot();
 const originalGet=input.originalGet??createApifyPrepaidOriginalGetPort();
 const wallet=await prepareWeeklyAccountCollectionPrepaidWallet({...input,root});
 const validate=async(o:PrepaidCollectionOperationAuthority,kind:PrepaidChildKind)=>{
  const hasKv=o.defaultKeyValueStoreId!==undefined||o.datasetPageKey!==undefined||o.datasetVideoId!==undefined||o.mappingReceiptId!==undefined||o.recordKey!==undefined||o.mediaSha256!==undefined||o.mediaByteLength!==undefined;
  // The original account job freezes one five-item page. Later pages require
  // a separately authorized continuation, never this original operation.
  if(!opScope(input.authorization,o)||kind==='run'&&(o.runId!==undefined||o.datasetId!==undefined||o.pageKey!==undefined||hasKv)||kind==='dataset_read'&&(!o.runId||!o.datasetId||o.pageKey!=='0'||hasKv)||kind==='kv_get'&&(!o.runId||!o.datasetId||o.pageKey!==undefined||o.datasetPageKey!=='0'||!o.defaultKeyValueStoreId||!/^\d{8,30}$/.test(o.datasetVideoId??'')||!o.mappingReceiptId||!o.recordKey||!sha256(o.mediaSha256??'')||!Number.isSafeInteger(o.mediaByteLength)||Number(o.mediaByteLength)<32))fail('prepaid_operation_scope_invalid');
  await input.assertCurrent();await input.verifyAuthority(o);
 };
 const bound=async(kind:PrepaidChildKind,operation:PrepaidCollectionOperationAuthority)=>{
  await validate(operation,kind);
  const identity=hash(['weekly-account-collection-bound-operation.v1',kind,operation]);
  const child=await wallet.child(kind,identity);
  const requestHash=socialRequestHash({schema:'weekly-account-collection-bound-request.v1',kind,operation});
  return {
   async inspect(){await validate(operation,kind);const entry=await child.inspect();if(entry.requestHash&&entry.requestHash!==requestHash)fail('prepaid_operation_request_changed');return entry;},
   async beforeSubmit(){await validate(operation,kind);return child.beforeSubmit(requestHash);},
   /** Connects the original POST journal's fsynced claim to this precise
    * already-unknown run and frozen five-video body. It never issues a paid
    * permit and is not called by the production discovery path yet. */
   async assertOriginalPostClaim(claim:{operationIdentity:string;requestHash:string;tokenFingerprint:string;actorInputSha256:string}){
    if(kind!=='run')fail('prepaid_receipt_scope_invalid');
    await validate(operation,kind);
    const expectedInput=frozenWeeklyAccountFiveVideoActorInput(input.authorization.accountUrl);
    const expectedBodyHash=createHash('sha256').update(JSON.stringify(expectedInput)).digest('hex');
    const entry=await child.inspect();
    if(entry.status!=='submitted_unknown'||entry.requestHash!==requestHash||claim.operationIdentity!==identity||claim.requestHash!==requestHash||claim.tokenFingerprint!==wallet.tokenFingerprint||claim.actorInputSha256!==expectedBodyHash)fail('prepaid_original_post_claim_changed');
   },
   /** Service-owned code may pass this frozen request to the original journal
    * only after independent spending authorization; this object does not
    * carry a token or authorize a POST. */
   originalPostScope(){if(kind!=='run')fail('prepaid_receipt_scope_invalid');return {operationIdentity:identity,requestHash,actorInput:frozenWeeklyAccountFiveVideoActorInput(input.authorization.accountUrl)};},
   async recordOriginalRun(assertPaidRead:(request:'actor_get'|'run_get')=>Promise<void>){
    if(kind!=='run')fail('prepaid_receipt_scope_invalid');
    await validate(operation,kind);
    if(typeof assertPaidRead!=='function')fail('prepaid_original_paid_permit_required');
    const frozenBodySha256=createHash('sha256').update(JSON.stringify(frozenWeeklyAccountFiveVideoActorInput(input.authorization.accountUrl))).digest('hex');
    const post=acceptedPost(await input.acceptedPost.read({operationIdentity:identity,requestHash,tokenFingerprint:wallet.tokenFingerprint}),identity,requestHash,wallet.tokenFingerprint,input.authorization.actorId,frozenBodySha256);
    await assertPaidRead('actor_get');
    const actorId=await officialActorId(originalGet,input.token,input.authorization.actorId);
    if(post.opaqueActorId!==actorId)fail('prepaid_original_post_actor_mismatch');
    const {runId,datasetId}=post;
    const url=`https://api.apify.com/v2/actor-runs/${encodeURIComponent(runId)}`;
    await assertPaidRead('run_get');
    originalRunReceipt(await originalGet.get({url,token:input.token}),runId,actorId,datasetId);
    await validate(operation,kind);
    return child.recordKnown(requestHash,hash(['apify-original-post-and-run-get.v1',runId,datasetId]));
   },
   async recordOriginalDatasetRead(paidRead:PrepaidDatasetPaidReadPermit){
    if(kind!=='dataset_read'||!operation.runId||!operation.datasetId)fail('prepaid_receipt_scope_invalid');
    await validate(operation,kind);
    if(!paidRead||paidRead.permitsPaidCollection!==true||paidRead.tokenFingerprintScheme!==APIFY_PREPAID_TOKEN_FINGERPRINT_SCHEME||paidRead.tokenFingerprint!==wallet.tokenFingerprint||paidRead.runId!==operation.runId||paidRead.datasetId!==operation.datasetId||typeof paidRead.assertCurrent!=='function')fail('prepaid_dataset_paid_permit_required');
    const entry=await child.inspect();
    if(entry.status!=='submitted_unknown'||entry.requestHash!==requestHash)fail('prepaid_dataset_not_submitted');
    const runId=operation.runId!,datasetId=operation.datasetId!,pageKey=operation.pageKey!;
    const parentOperation={...operation};delete parentOperation.runId;delete parentOperation.datasetId;delete parentOperation.pageKey;
    const parentIdentity=hash(['weekly-account-collection-bound-operation.v1','run',parentOperation]);
    const parent=readPrepaidLedger(ledgerFile(root,input.authorization),{
     schema:'weekly-account-collection-prepaid-binding.v1',authorizationId:input.authorization.authorizationId,authorizationHash:input.authorization.recordHash,tenantId:input.authorization.tenantId,programId:input.authorization.programId,packageId:input.authorization.packageId,packageVersion:input.authorization.packageVersion,tokenFingerprint:wallet.tokenFingerprint,purchaseEvidenceHash:input.purchaseEvidenceHash,costCoverageEvidenceHash:input.costCoverageEvidenceHash,purchaseCnyMicros:wallet.purchaseCnyMicros,
    },input.authorization)?.entries[hash(['run',parentIdentity])];
    if(!parent||!['submitted_known','completed'].includes(parent.status)||parent.providerRef!==hash(['apify-original-post-and-run-get.v1',runId,datasetId]))fail('prepaid_dataset_parent_unverified');
    await paidRead.assertCurrent('actor_get');
    const actorId=await officialActorId(originalGet,input.token,input.authorization.actorId);
    const url=`https://api.apify.com/v2/actor-runs/${encodeURIComponent(runId)}`;
    await paidRead.assertCurrent('run_get');
    originalRunReceipt(await originalGet.get({url,token:input.token}),runId,actorId,datasetId);
    const datasetUrl=`https://api.apify.com/v2/datasets/${encodeURIComponent(datasetId)}/items?offset=${pageKey}&limit=5&format=json`;
    await paidRead.assertCurrent('dataset_get');
    const page=await originalGet.get({url:datasetUrl,token:input.token});
    if(page.url!==datasetUrl||page.status!==200||!Array.isArray(page.body)||page.body.length>5)fail('prepaid_original_dataset_get_invalid');
    await validate(operation,kind);
    return child.recordKnown(requestHash,hash(['apify-original-dataset-get.v1',runId,datasetId,pageKey,page.body]));
   },
   async recordOriginalKvRead(){
    // This settles the local ledger only against a trusted transport journal;
    // the deployment still needs independent byte/fee verification and a
    // separate explicit permit. `permitsPaidCollection` remains false.
    const kvPort=input.acceptedKvGet,storeId=operation.defaultKeyValueStoreId,recordKey=operation.recordKey;
    if(kind!=='kv_get'||!operation.runId||!operation.datasetId||!storeId||!recordKey||!kvPort)fail('prepaid_kv_receipt_scope_invalid');
    await validate(operation,kind);
    const entry=await child.inspect();if(entry.status!=='submitted_unknown'||entry.requestHash!==requestHash)fail('prepaid_kv_not_submitted');
    const parentOperation={...operation};delete parentOperation.runId;delete parentOperation.datasetId;delete parentOperation.defaultKeyValueStoreId;delete parentOperation.datasetPageKey;delete parentOperation.datasetVideoId;delete parentOperation.mappingReceiptId;delete parentOperation.recordKey;delete parentOperation.mediaSha256;delete parentOperation.mediaByteLength;
    const parentIdentity=hash(['weekly-account-collection-bound-operation.v1','run',parentOperation]);
    const binding:PrepaidBinding={schema:'weekly-account-collection-prepaid-binding.v1',authorizationId:input.authorization.authorizationId,authorizationHash:input.authorization.recordHash,tenantId:input.authorization.tenantId,programId:input.authorization.programId,packageId:input.authorization.packageId,packageVersion:input.authorization.packageVersion,tokenFingerprint:wallet.tokenFingerprint,purchaseEvidenceHash:input.purchaseEvidenceHash,costCoverageEvidenceHash:input.costCoverageEvidenceHash,purchaseCnyMicros:wallet.purchaseCnyMicros};
    const ledger=readPrepaidLedger(ledgerFile(root,input.authorization),binding,input.authorization);
    const parent=ledger?.entries[hash(['run',parentIdentity])];
    if(!parent||!['submitted_known','completed'].includes(parent.status)||parent.providerRef!==hash(['apify-original-post-and-run-get.v1',operation.runId,operation.datasetId]))fail('prepaid_kv_parent_unverified');
    const datasetOperation={...parentOperation,runId:operation.runId,datasetId:operation.datasetId,pageKey:operation.datasetPageKey};
    const datasetIdentity=hash(['weekly-account-collection-bound-operation.v1','dataset_read',datasetOperation]);
    const dataset=ledger?.entries[hash(['dataset_read',datasetIdentity])];
    if(!dataset||!['submitted_known','completed'].includes(dataset.status)||!dataset.providerRef)fail('prepaid_kv_dataset_unverified');
    const receipt=await kvPort!.read({operationIdentity:identity,requestHash,tokenFingerprint:wallet.tokenFingerprint});
    const expectedUrl=`https://api.apify.com/v2/key-value-stores/${encodeURIComponent(storeId!)}/records/${encodeURIComponent(recordKey!)}`;
    if(!receipt||receipt.operationIdentity!==identity||receipt.requestHash!==requestHash||receipt.tokenFingerprint!==wallet.tokenFingerprint||receipt.url!==expectedUrl||receipt.status!==200||receipt.runId!==operation.runId||receipt.datasetId!==operation.datasetId||receipt.defaultKeyValueStoreId!==operation.defaultKeyValueStoreId||receipt.datasetVideoId!==operation.datasetVideoId||receipt.mappingReceiptId!==operation.mappingReceiptId||receipt.recordKey!==operation.recordKey||receipt.mediaSha256!==operation.mediaSha256||receipt.mediaByteLength!==operation.mediaByteLength)fail('prepaid_original_kv_get_invalid');
    await validate(operation,kind);
    return child.recordKnown(requestHash,hash(['apify-original-kv-get.v1',identity,requestHash,receipt]));
   },
  };
 };
 return {schema:'weekly-account-collection-deployed-prepaid-contract.v1' as const,permitsPaidCollection:false as const,tokenFingerprint:wallet.tokenFingerprint,
  beginRun:(operation:PrepaidCollectionOperationAuthority)=>bound('run',operation),
  beginDatasetRead:(operation:PrepaidCollectionOperationAuthority)=>bound('dataset_read',operation),
  beginKvRead:(operation:PrepaidCollectionOperationAuthority)=>bound('kv_get',operation)};
}

/** Reserve the full worst-case amount. Completed entries retain their original
 * reservation: release requires a separate audited reconciliation contract. */
export async function reserveWeeklyAccountCollectionRun(input:{store:DataStore;authorization:WeeklyAccountCollectionBudgetAuthorization;root:string;operationId:string;capUsd:number;fxCnyPerUsdUpper:number;fxEvidenceRef:string;assertCurrent:()=>Promise<void>}){
 const a=input.authorization,root=path.resolve(input.root),file=ledgerFile(root,a),key=JSON.stringify([a.tenantId,a.programId,a.packageId,a.packageVersion]),entryId=hash(input.operationId),reservedCnyMicros=Math.ceil(input.capUsd*input.fxCnyPerUsdUpper*1_000_000-1e-9);
 if(!input.operationId||!Number.isFinite(input.capUsd)||input.capUsd<=0||!Number.isFinite(input.fxCnyPerUsdUpper)||input.fxCnyPerUsdUpper<=0||!input.fxEvidenceRef||!Number.isSafeInteger(reservedCnyMicros)||reservedCnyMicros<=0||reservedCnyMicros>micros(a.perRunLimitCny))fail('reservation_input_invalid');
 await withPaidOperationLock(path.join(root,'.locks'),key,async()=>{await input.assertCurrent();const l=readLedger(file,a)??{schema:1 as const,authorizationId:a.authorizationId,authorizationHash:a.recordHash,limitMicros:micros(a.totalLimitCny),entries:{}};const prior=l.entries[entryId];if(prior){if(prior.operationId!==input.operationId||prior.capUsd!==input.capUsd||prior.reservedCnyMicros!==reservedCnyMicros||prior.fxCnyPerUsdUpper!==input.fxCnyPerUsdUpper||prior.fxEvidenceRef!==input.fxEvidenceRef)fail('operation_conflict');return;}
  if(Object.values(l.entries).reduce((sum,e)=>sum+e.reservedCnyMicros,0)+reservedCnyMicros>l.limitMicros)fail('weekly_limit_exceeded');l.entries[entryId]={operationId:input.operationId,requestHash:null,actorId:a.actorId,capUsd:input.capUsd,fxCnyPerUsdUpper:input.fxCnyPerUsdUpper,fxEvidenceRef:input.fxEvidenceRef,reservedCnyMicros,status:'reserved',runId:null,datasetId:null,usageTotalUsd:null};await input.assertCurrent();writeLedger(root,file,l);
 });
 const mutate=<T>(fn:(l:Ledger,e:WeeklyAccountCollectionLedgerEntry)=>T|Promise<T>)=>withPaidOperationLock(path.join(root,'.locks'),key,async()=>{const l=readLedger(file,a),e=l?.entries[entryId];if(!l||!e||e.operationId!==input.operationId||e.capUsd!==input.capUsd)fail('operation_missing_or_changed');const result=await fn(l!,e!);writeLedger(root,file,l!);return result;});
 return {
  async inspect(body:{actorId:string;requestHash:string;maxTotalChargeUsd:number}){await input.assertCurrent();const l=readLedger(file,a),e=l?.entries[entryId];if(!e||e.operationId!==input.operationId||body.actorId!==e.actorId||body.maxTotalChargeUsd!==e.capUsd||!/^[a-f0-9]{64}$/.test(body.requestHash)||e.requestHash!==null&&e.requestHash!==body.requestHash)fail('operation_missing_or_changed');
   const checked=e!;
   if(checked.status==='reserved')return {status:'reserved' as const};
   if(checked.status==='submitted_unknown')return {status:'submitted_unknown' as const};
   if(checked.status==='submitted_known')return {status:'submitted_known' as const,runId:checked.runId!,datasetId:checked.datasetId!};
   return {status:'completed' as const,runId:checked.runId!,datasetId:checked.datasetId!,usageTotalUsd:checked.usageTotalUsd!};},
  async beforeSubmit(body:{actorId:string;requestHash:string;maxTotalChargeUsd:number}){return mutate(async(_l,e)=>{await input.assertCurrent();if(e.status!=='reserved'||body.actorId!==a.actorId||body.maxTotalChargeUsd!==e.capUsd||!/^[a-f0-9]{64}$/.test(body.requestHash))fail('submission_changed_or_uncertain');e.status='submitted_unknown';e.requestHash=body.requestHash;});},
  async recordRun(body:{runId:string;datasetId:string;maxTotalChargeUsd:number}){return mutate((_l,e)=>{if(e.status==='submitted_known'&&e.runId===body.runId&&e.datasetId===body.datasetId)return;if(e.status!=='submitted_unknown'||!e.requestHash||!body.runId||!body.datasetId||body.maxTotalChargeUsd!==e.capUsd)fail('run_receipt_changed_or_unknown');e.status='submitted_known';e.runId=body.runId;e.datasetId=body.datasetId;});},
  async recordTerminal(body:{runId:string;status:string;usageTotalUsd:number}){return mutate((_l,e)=>{if(e.status==='completed'&&e.runId===body.runId&&e.usageTotalUsd===body.usageTotalUsd)return;if(e.status!=='submitted_known'||e.runId!==body.runId||!['SUCCEEDED','FAILED','ABORTED','TIMED-OUT'].includes(body.status)||!Number.isFinite(body.usageTotalUsd)||body.usageTotalUsd<0||body.usageTotalUsd>e.capUsd+1e-8)fail('terminal_receipt_changed_or_unknown');e.status='completed';e.usageTotalUsd=body.usageTotalUsd;});},
  async beforeDatasetRead(_body:{runId:string;datasetId:string;maxItems:number}):Promise<void>{
   // A run cap does not prove the cost of subsequent storage/API reads.
   throw Error('weekly_preproduction_collection_dataset_cost_unverified');
  },
 };
}
