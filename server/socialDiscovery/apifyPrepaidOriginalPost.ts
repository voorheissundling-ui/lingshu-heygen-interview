import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {withPaidOperationLock} from '../lib/paidOperationLock.js';
import type {PrepaidAcceptedPostPort,PrepaidAcceptedPostReceipt} from './weeklyAccountCollectionBudget.js';
import {apifyTokenFingerprint,APIFY_PREPAID_TOKEN_FINGERPRINT_SCHEME} from './apifyTokenFingerprint.js';

/** Provider-enforced hard cap; omitting it would make the supplier request
 * unbounded even when the local authority is correctly reserved. */
export const WEEKLY_ACCOUNT_COLLECTION_ACTOR_RUN_ENDPOINT='https://api.apify.com/v2/actors/clockworks~tiktok-scraper/runs?maxTotalChargeUsd=0.500000';
const ENDPOINT=WEEKLY_ACCOUNT_COLLECTION_ACTOR_RUN_ENDPOINT;
const sha=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const hex=(s:string)=>/^[a-f0-9]{64}$/.test(s);
const fail=():never=>{throw Error('weekly_account_collection_original_post_unverified');};
interface Claim {schema:'apify-original-post-claim.v1';operationIdentity:string;requestHash:string;tokenFingerprint:string;actorInputSha256:string;endpoint:typeof ENDPOINT;createdAt:string;}
interface Accepted {schema:'apify-original-post-accepted.v1';claimSha256:string;status:201;responseSha256:string;responseByteLength:number;receivedAt:string;}

function journalRoot(createIfMissing=true):string|null{
 const configured=process.env.WEEKLY_ACCOUNT_COLLECTION_PREPAID_LEDGER_ROOT;
 if(!configured)return createIfMissing?fail():null;
 if(!path.isAbsolute(configured)||path.normalize(configured)!==configured)return fail();
 const real=fs.realpathSync(configured);
 if(real!==configured||!fs.statSync(real).isDirectory())return fail();
 const root=path.join(real,'.original-apify-post');
 if(createIfMissing)fs.mkdirSync(root,{recursive:true,mode:0o700});
 else if(!fs.existsSync(root))return null;
 if(fs.realpathSync(root)!==root||!fs.statSync(root).isDirectory())return fail();
 return root;
}
function syncWrite(file:string,bytes:Uint8Array){
 const root=path.dirname(file),tmp=file+'.'+randomUUID()+'.tmp',fd=fs.openSync(tmp,'wx',0o600);
 try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 fs.renameSync(tmp,file);const dir=fs.openSync(root,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
}
function readJson<T>(file:string):T|null{if(!fs.existsSync(file))return null;try{return JSON.parse(fs.readFileSync(file,'utf8')) as T;}catch{return fail();}}
function names(root:string,identity:string){const key=sha(identity);return {claim:path.join(root,key+'.claim.json'),accepted:path.join(root,key+'.accepted.json'),body:path.join(root,key+'.response.json')};}
function validClaim(c:Claim|null,identity:string,requestHash:string,fingerprint:string):c is Claim{
 return !!c&&c.schema==='apify-original-post-claim.v1'&&c.operationIdentity===identity&&c.requestHash===requestHash&&c.tokenFingerprint===fingerprint&&hex(c.actorInputSha256)&&c.endpoint===ENDPOINT&&Number.isFinite(Date.parse(c.createdAt));
}
function acceptedBody(body:unknown):boolean{
 if(!body||typeof body!=='object'||Array.isArray(body))return false;
 const data=(body as {data?:unknown}).data;
 if(!data||typeof data!=='object'||Array.isArray(data))return false;
 const run=data as {id?:unknown;actId?:unknown;defaultDatasetId?:unknown};
 return [run.id,run.actId,run.defaultDatasetId].every(v=>typeof v==='string'&&v.length>0);
}

/** The original transport records an fsynced one-shot claim before any POST.
 * A missing 201 after this point is UNKNOWN and cannot be retried locally.
 * The authority callbacks must re-read the frozen job, prepaid ledger and
 * original submitted_unknown entry; this transport does not mint a permit. */
export function createApifyPrepaidOriginalPostJournal(input:{
 assertSubmittedUnknown:(scope:{operationIdentity:string;requestHash:string;tokenFingerprint:string;actorInputSha256:string})=>Promise<void>;
 fetcher?:typeof fetch;
}):PrepaidAcceptedPostPort&{
 submit(scope:{operationIdentity:string;requestHash:string;token:string;actorInput:Record<string,unknown>}):Promise<PrepaidAcceptedPostReceipt>;
}{
 const fetcher=input.fetcher??fetch;
 const read:PrepaidAcceptedPostPort['read']=async scope=>{
  if(!hex(scope.operationIdentity)||!hex(scope.requestHash)||!hex(scope.tokenFingerprint))return fail();
  const root=journalRoot(false);if(!root)return null;
  const files=names(root,scope.operationIdentity),claim=readJson<Claim>(files.claim);
  if(!claim)return null;
  if(!validClaim(claim,scope.operationIdentity,scope.requestHash,scope.tokenFingerprint))return fail();
  const accepted=readJson<Accepted>(files.accepted);if(!accepted)return null;
  if(accepted.schema!=='apify-original-post-accepted.v1'||accepted.status!==201||accepted.claimSha256!==sha(JSON.stringify(claim))||!hex(accepted.responseSha256)||!Number.isSafeInteger(accepted.responseByteLength)||accepted.responseByteLength<2||accepted.responseByteLength>1_000_000)return fail();
  const bytes=fs.readFileSync(files.body);if(bytes.length!==accepted.responseByteLength||sha(bytes)!==accepted.responseSha256)return fail();
  let body:unknown;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return fail();}
  if(!acceptedBody(body))return fail();
  return {operationIdentity:scope.operationIdentity,requestHash:scope.requestHash,tokenFingerprint:scope.tokenFingerprint,actorInputSha256:claim.actorInputSha256,url:ENDPOINT,status:201,body};
 };
 return {read,async submit(scope){
  if(!hex(scope.operationIdentity)||!hex(scope.requestHash)||!scope.token||scope.token.trim()!==scope.token||/[\r\n]/.test(scope.token)||!scope.actorInput||typeof scope.actorInput!=='object'||Array.isArray(scope.actorInput))return fail();
  const tokenFingerprint=apifyTokenFingerprint(scope.token,APIFY_PREPAID_TOKEN_FINGERPRINT_SCHEME);
  const actorInputBytes=Buffer.from(JSON.stringify(scope.actorInput),'utf8');
  if(actorInputBytes.length<2||actorInputBytes.length>1_000_000)return fail();
  const actorInputSha256=sha(actorInputBytes),identity={operationIdentity:scope.operationIdentity,requestHash:scope.requestHash,tokenFingerprint,actorInputSha256};
  const root=journalRoot();if(!root)return fail();return withPaidOperationLock(path.join(root,'.locks'),`original-post:${scope.operationIdentity}`,async()=>{
   const files=names(root,scope.operationIdentity);
   if(fs.existsSync(files.claim)){
    const old=readJson<Claim>(files.claim);
    if(!validClaim(old,scope.operationIdentity,scope.requestHash,tokenFingerprint)||old.actorInputSha256!==actorInputSha256)return fail();
    const previous=await read(identity);if(previous)return previous;
    throw Error('weekly_account_collection_original_post_unknown_no_replay');
   }
   await input.assertSubmittedUnknown(identity);
   const claim:Claim={schema:'apify-original-post-claim.v1',...identity,endpoint:ENDPOINT,createdAt:new Date().toISOString()};
   // Exclusive creation avoids a second process winning the same operation.
   const fd=fs.openSync(files.claim,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(claim));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
   const dir=fs.openSync(root,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
   const response=await fetcher(ENDPOINT,{method:'POST',redirect:'error',cache:'no-store',headers:{Authorization:`Bearer ${scope.token}`,Accept:'application/json','Content-Type':'application/json','Cache-Control':'no-store'},body:actorInputBytes,signal:AbortSignal.timeout(120_000)});
   if(response.url!==ENDPOINT||response.status!==201)throw Error(`weekly_account_collection_original_post_http_${response.status}`);
   const bytes=new Uint8Array(await response.arrayBuffer());if(bytes.length<2||bytes.length>1_000_000)return fail();
   let body:unknown;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return fail();}
   if(!acceptedBody(body))return fail();
   syncWrite(files.body,bytes);
   const accepted:Accepted={schema:'apify-original-post-accepted.v1',claimSha256:sha(JSON.stringify(claim)),status:201,responseSha256:sha(bytes),responseByteLength:bytes.length,receivedAt:new Date().toISOString()};
   syncWrite(files.accepted,Buffer.from(JSON.stringify(accepted)));
   return (await read(identity))!;
  });
 }};
}

/** Non-spending restart port. Its public surface cannot submit an Actor run. */
export function createApifyPrepaidOriginalPostReader():PrepaidAcceptedPostPort{
 const journal=createApifyPrepaidOriginalPostJournal({assertSubmittedUnknown:async()=>fail()});
 return {read:journal.read};
}
