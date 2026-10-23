import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {withPaidOperationLock} from '../lib/paidOperationLock.js';
import {apifyTokenFingerprint,APIFY_PREPAID_TOKEN_FINGERPRINT_SCHEME} from './apifyTokenFingerprint.js';
import type {PrepaidOriginalGetPort,PrepaidOriginalGetReceipt} from './weeklyAccountCollectionBudget.js';

const sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
const hex=(v:string)=>/^[a-f0-9]{64}$/.test(v);
const fail=(reason:string):never=>{throw Error(`weekly_account_collection_original_dataset_${reason}`);};
type Kind='actor_get'|'run_get'|'dataset_get';
export interface OriginalDatasetJournalScope {
 operationIdentity:string;requestHash:string;tokenFingerprint:string;
 jobId:string;runId:string;datasetId:string;pageKey:'0';
}
type Claim={schema:'apify-original-dataset-get-claim.v1';scope:OriginalDatasetJournalScope;kind:Kind;url:string;createdAt:string};
type Accepted={schema:'apify-original-dataset-get-accepted.v1';claimSha256:string;status:200;responseSha256:string;responseByteLength:number;receivedAt:string};
const urls=(s:OriginalDatasetJournalScope)=>({
 actor_get:'https://api.apify.com/v2/actors/clockworks~tiktok-scraper',
 run_get:`https://api.apify.com/v2/actor-runs/${encodeURIComponent(s.runId)}`,
 dataset_get:`https://api.apify.com/v2/datasets/${encodeURIComponent(s.datasetId)}/items?offset=0&limit=5&format=json`,
});
function root(create:boolean):string|null{
 const configured=process.env.WEEKLY_ACCOUNT_COLLECTION_PREPAID_LEDGER_ROOT;
 if(!configured)return create?fail('ledger_root_required'):null;
 if(!path.isAbsolute(configured)||path.normalize(configured)!==configured)return fail('ledger_root_invalid');
 const real=fs.realpathSync(configured);
 if(real!==configured||!fs.statSync(real).isDirectory())return fail('ledger_root_invalid');
 const folder=path.join(real,'.original-apify-dataset');
 if(create)fs.mkdirSync(folder,{recursive:true,mode:0o700});
 else if(!fs.existsSync(folder))return null;
 if(fs.realpathSync(folder)!==folder||!fs.statSync(folder).isDirectory())return fail('ledger_root_invalid');
 return folder;
}
function scopeValid(s:OriginalDatasetJournalScope){
 return hex(s.operationIdentity)&&hex(s.requestHash)&&hex(s.tokenFingerprint)&&/^[A-Za-z0-9_-]{5,80}$/.test(s.jobId)&&/^[A-Za-z0-9_-]{5,80}$/.test(s.runId)&&/^[A-Za-z0-9_-]{5,80}$/.test(s.datasetId)&&s.pageKey==='0';
}
function files(folder:string,s:OriginalDatasetJournalScope,kind:Kind){
 const stem=sha(JSON.stringify([s.operationIdentity,s.jobId,kind]));
 return {claim:path.join(folder,stem+'.claim.json'),accepted:path.join(folder,stem+'.accepted.json'),body:path.join(folder,stem+'.response.json')};
}
function json<T>(file:string):T|null{if(!fs.existsSync(file))return null;try{return JSON.parse(fs.readFileSync(file,'utf8')) as T;}catch{return fail('journal_corrupt');}}
function write(file:string,bytes:Uint8Array){
 const temp=file+'.'+randomUUID()+'.tmp',fd=fs.openSync(temp,'wx',0o600);
 try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 fs.renameSync(temp,file);const dir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
}
function verifyBody(kind:Kind,body:unknown,s:OriginalDatasetJournalScope):boolean{
 if(kind==='dataset_get')return Array.isArray(body)&&body.length<=5&&body.every(row=>row&&typeof row==='object'&&!Array.isArray(row));
 if(!body||typeof body!=='object'||Array.isArray(body))return false;
 const data=(body as {data?:unknown}).data;
 if(!data||typeof data!=='object'||Array.isArray(data))return false;
 const record=data as {id?:unknown;actId?:unknown;defaultDatasetId?:unknown};
 return kind==='actor_get'?typeof record.id==='string'&&record.id.length>0:record.id===s.runId&&record.defaultDatasetId===s.datasetId&&typeof record.actId==='string'&&record.actId.length>0;
}
/** Durable, one-shot GET journal for the original five-item page. It never
 * submits an Actor or infers a second run. A claimed request without a fsynced
 * 200 response is terminal UNKNOWN for local replay. */
export function createApifyPrepaidOriginalDatasetJournal(input:{
 scope:OriginalDatasetJournalScope;
 assertSubmittedUnknown:(scope:OriginalDatasetJournalScope)=>Promise<void>;
 paidPermit?:{permitsPaidCollection:true;assertCurrent:(kind:Kind,url:string)=>Promise<void>};
 fetcher?:typeof fetch;
}):PrepaidOriginalGetPort&{scope:OriginalDatasetJournalScope;read:(kind:Kind)=>Promise<PrepaidOriginalGetReceipt|null>;inspect:(kind:Kind)=>Promise<'not_started'|'submitted_unknown'|'accepted'>}{
 const s=input.scope;if(!scopeValid(s))fail('scope_invalid');
 const addresses=urls(s),fetcher=input.fetcher??fetch;
 const read=async(kind:Kind):Promise<PrepaidOriginalGetReceipt|null>=>{
  const folder=root(false);if(!folder)return null;
  const f=files(folder,s,kind),claim=json<Claim>(f.claim);
  if(!claim)return null;
  if(claim.schema!=='apify-original-dataset-get-claim.v1'||JSON.stringify(claim.scope)!==JSON.stringify(s)||claim.kind!==kind||claim.url!==addresses[kind]||!Number.isFinite(Date.parse(claim.createdAt)))fail('claim_changed');
  const accepted=json<Accepted>(f.accepted);if(!accepted)return null;
  if(accepted.schema!=='apify-original-dataset-get-accepted.v1'||accepted.status!==200||accepted.claimSha256!==sha(JSON.stringify(claim))||!hex(accepted.responseSha256)||!Number.isSafeInteger(accepted.responseByteLength)||accepted.responseByteLength<2||accepted.responseByteLength>2_000_000)fail('accepted_changed');
  const bytes=fs.readFileSync(f.body);if(bytes.length!==accepted.responseByteLength||sha(bytes)!==accepted.responseSha256)fail('response_changed');
  let body:unknown;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return fail('response_invalid');}
  if(!verifyBody(kind,body,s))fail('response_invalid');
  return {url:addresses[kind],status:200,body};
 };
 const inspect=async(kind:Kind)=>{const folder=root(false);if(!folder)return 'not_started' as const;const f=files(folder,s,kind);if(!fs.existsSync(f.claim))return 'not_started' as const;return await read(kind)?'accepted' as const:'submitted_unknown' as const;};
 return {scope:s,read,inspect,async get({url,token}){
  const kind=(Object.keys(addresses) as Kind[]).find(k=>addresses[k]===url)??fail('request_changed');
  if(!token||apifyTokenFingerprint(token,APIFY_PREPAID_TOKEN_FINGERPRINT_SCHEME)!==s.tokenFingerprint)fail('request_changed');
  const folder=root(true)!;
  return withPaidOperationLock(path.join(folder,'.locks'),`original-dataset-get:${s.operationIdentity}:${kind}`,async()=>{
   const prior=await read(kind);if(prior)return prior;
   const f=files(folder,s,kind);
   if(fs.existsSync(f.claim))fail('unknown_no_replay');
   const permit=input.paidPermit;
   if(!permit||permit.permitsPaidCollection!==true)fail('paid_permit_required');
   await permit!.assertCurrent(kind,url);
   await input.assertSubmittedUnknown(s);
   const claim:Claim={schema:'apify-original-dataset-get-claim.v1',scope:s,kind,url,createdAt:new Date().toISOString()};
   const fd=fs.openSync(f.claim,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(claim));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
   const dir=fs.openSync(folder,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
   const response=await fetcher(url,{method:'GET',redirect:'error',cache:'no-store',headers:{Authorization:`Bearer ${token}`,Accept:'application/json','Cache-Control':'no-store'},signal:AbortSignal.timeout(30_000)});
   if(response.url!==url||response.status!==200)fail('provider_response_invalid');
   const bytes=new Uint8Array(await response.arrayBuffer());if(bytes.length<2||bytes.length>2_000_000)fail('response_invalid');
   let body:unknown;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return fail('response_invalid');}
   if(!verifyBody(kind,body,s))fail('response_invalid');
   write(f.body,bytes);
   write(f.accepted,Buffer.from(JSON.stringify({schema:'apify-original-dataset-get-accepted.v1',claimSha256:sha(JSON.stringify(claim)),status:200,responseSha256:sha(bytes),responseByteLength:bytes.length,receivedAt:new Date().toISOString()} satisfies Accepted)));
   return (await read(kind))!;
  });
 }};
}
