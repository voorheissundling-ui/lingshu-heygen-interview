import fs from 'node:fs';
import path from 'node:path';
import {createHash,createPublicKey,randomUUID,verify} from 'node:crypto';
import {withPaidOperationLock} from '../lib/paidOperationLock.js';

const digest=/^[a-f0-9]{64}$/;
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
// A signed ceiling must never round upward, while a one-way hold must never
// round downward. Otherwise five fractional-micro candidate maxima can each
// lose a fraction and collectively exceed the signed weekly CNY ceiling.
const ceilingMicros=(value:number)=>Math.floor(value*1_000_000);
const holdMicros=(value:number)=>Math.ceil(value*1_000_000);
const fail=(code:string):never=>{throw Error(`weekly_candidate_exact_authority_${code}`);};

/** Signed by an independently registered operator, never by the analysis
 * worker. The five candidate entries share a single CNY weekly ceiling. */
export interface WeeklyCandidateExactAuthorityStatement {
 schema:'weekly-candidate-exact-authority.v1';issuerId:string;keyId:string;submitterId:string;reviewerId:string;
 authorizationId:string;tenantId:string;programId:string;packageId:string;packageVersion:number;
 endpoint:string;credentialSha256:string;model:'qwen3-vl-plus';
 /** Explicitly signed accounting basis. Legacy authorities retain original
  * billing settlement; conservative mode never claims an actual billed fee. */
 settlementBasis?:'original_billing'|'conservative_upper_bound';auditApiKeyId?:string;
 /** Separate reviewer-approved ceiling for the existing 3/30 CNY per million
  * token guard. This is an authorization, not proof of a charged amount. */
 conservativePriceApproval?:{inputCnyPerMillion:number;outputCnyPerMillion:number;sourceEvidenceHash:string;validUntil:string};
 issuedAt:string;expiresAt:string;weeklyMaximumCny:number;
 candidates:Array<{candidateId:string;mediaSha256:string;operationId:string;jobId:string;jobHash:string;runId:string;runHash:string;scopeId:string;scopeVersion:number;maximumRequests:number;maximumCny:number}>;
}
export interface WeeklyCandidateExactSignedAuthority {statement:WeeklyCandidateExactAuthorityStatement;signatureBase64url:string}
export interface WeeklyCandidateExactTrustedIssuer {issuerId:string;keyId:string;reviewerId:string;tenantId:string;publicKeyPem:string}
export interface WeeklyCandidateExactAuthorityScope {tenantId:string;programId:string;packageId:string;packageVersion:number;jobId:string;jobHash:string;runId:string;runHash:string;scopeId:string;scopeVersion:number}
export interface WeeklyCandidateExactAuthorityReader {
 /** Must read an independently issued record and its current revocation. */
 read:()=>Promise<WeeklyCandidateExactSignedAuthority|null>;
 isRevoked:(authorizationId:string,authorizationHash:string)=>Promise<boolean>;
 trustedIssuers:readonly WeeklyCandidateExactTrustedIssuer[];
 now?:()=>number;
}
type Ledger={schema:'weekly-candidate-exact-shared-cny.v1';authorizationHash:string;weeklyMaximumMicros:number;entries:Record<string,{candidateId:string;mediaSha256:string;reservedMicros:number}>};

function statementBytes(statement:WeeklyCandidateExactAuthorityStatement){return Buffer.from(JSON.stringify(statement));}
function checked(signed:WeeklyCandidateExactSignedAuthority|null,scope:WeeklyCandidateExactAuthorityScope,reader:WeeklyCandidateExactAuthorityReader,allowExpiredOriginal=false){
 if(!signed)return null;
 const s=signed.statement,now=(reader.now??Date.now)();
 if(!s||s.schema!=='weekly-candidate-exact-authority.v1'||!s.authorizationId||!s.issuerId||!s.keyId||!s.submitterId||!s.reviewerId||s.submitterId===s.reviewerId||
  (['tenantId','programId','packageId','packageVersion'] as const).some(key=>s[key]!==scope[key])||
  !digest.test(s.credentialSha256)||
  (s.settlementBasis!==undefined&&!['original_billing','conservative_upper_bound'].includes(s.settlementBasis))||
  (s.settlementBasis==='conservative_upper_bound'&&(!s.auditApiKeyId||!/^[A-Za-z0-9._:-]{1,128}$/.test(s.auditApiKeyId)))||
  (s.settlementBasis==='conservative_upper_bound'&&(!s.conservativePriceApproval||s.conservativePriceApproval.inputCnyPerMillion!==3||
   s.conservativePriceApproval.outputCnyPerMillion!==30||!digest.test(s.conservativePriceApproval.sourceEvidenceHash)||
   !Number.isFinite(Date.parse(s.conservativePriceApproval.validUntil))||Date.parse(s.conservativePriceApproval.validUntil)<Date.parse(s.expiresAt)))||
  s.model!=='qwen3-vl-plus'||s.endpoint!=='https://maas.qianwenaiapi.com/compatible-mode/v1'||
  !Number.isFinite(Date.parse(s.issuedAt))||!Number.isFinite(Date.parse(s.expiresAt))||Date.parse(s.issuedAt)>now||
  Date.parse(s.expiresAt)<=Date.parse(s.issuedAt)||(!allowExpiredOriginal&&Date.parse(s.expiresAt)<=now)||
  !Number.isSafeInteger(ceilingMicros(s.weeklyMaximumCny))||ceilingMicros(s.weeklyMaximumCny)<1||
  !Array.isArray(s.candidates)||s.candidates.length!==5||new Set(s.candidates.map(c=>c.candidateId)).size!==5||
  new Set(s.candidates.map(c=>c.operationId)).size!==5||s.candidates.some(c=>!c.candidateId||!c.operationId||!digest.test(c.mediaSha256)||
   !c.jobId||!digest.test(c.jobHash)||!c.runId||!digest.test(c.runHash)||!c.scopeId||!Number.isSafeInteger(c.scopeVersion)||c.scopeVersion<1||
   !Number.isSafeInteger(c.maximumRequests)||c.maximumRequests<1||c.maximumRequests>128||
   !Number.isSafeInteger(holdMicros(c.maximumCny))||holdMicros(c.maximumCny)<1||holdMicros(c.maximumCny)>ceilingMicros(s.weeklyMaximumCny)))fail('statement_invalid');
 const matching=reader.trustedIssuers.filter(i=>i.issuerId===s.issuerId&&i.keyId===s.keyId&&i.reviewerId===s.reviewerId&&i.tenantId===scope.tenantId);
 if(matching.length!==1||typeof signed.signatureBase64url!=='string'||!/^[A-Za-z0-9_-]+$/.test(signed.signatureBase64url))fail('issuer_untrusted');
 let valid=false;try{valid=verify(null,statementBytes(s),createPublicKey(matching[0]!.publicKeyPem),Buffer.from(signed.signatureBase64url,'base64url'));}catch{}
 if(!valid)fail('signature_invalid');
 return {statement:s,authorizationHash:sha(statementBytes(s).toString('utf8'))};
}
function readLedger(file:string,authorizationHash:string,weeklyMaximumMicros:number):Ledger{
 if(!fs.existsSync(file))return {schema:'weekly-candidate-exact-shared-cny.v1',authorizationHash,weeklyMaximumMicros,entries:{}};
 let l:Ledger;try{l=JSON.parse(fs.readFileSync(file,'utf8'));}catch{return fail('ledger_corrupt');}
 if(l.schema!=='weekly-candidate-exact-shared-cny.v1'||l.authorizationHash!==authorizationHash||l.weeklyMaximumMicros!==weeklyMaximumMicros||
  !l.entries||typeof l.entries!=='object'||Array.isArray(l.entries))fail('ledger_changed');
 let total=0;for(const [id,e] of Object.entries(l.entries)){
  if(!id||!e||!e.candidateId||!digest.test(e.mediaSha256)||!Number.isSafeInteger(e.reservedMicros)||e.reservedMicros<1)fail('ledger_corrupt');
  total+=e.reservedMicros;
 }
 if(!Number.isSafeInteger(total)||total>weeklyMaximumMicros)fail('ledger_corrupt');
 return l;
}
function writeLedger(file:string,l:Ledger){
 const dir=path.dirname(file);fs.mkdirSync(dir,{recursive:true,mode:0o700});const tmp=`${file}.${randomUUID()}.tmp`,fd=fs.openSync(tmp,'wx',0o600);
 try{fs.writeFileSync(fd,JSON.stringify(l));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 fs.renameSync(tmp,file);const dirfd=fs.openSync(dir,'r');try{fs.fsyncSync(dirfd);}finally{fs.closeSync(dirfd);}
}

/** A shared one-way hold. Restart reads the same hold; a conflicting candidate,
 * changed authorization, or fifth-plus operation cannot reclaim its CNY. */
export function createWeeklyCandidateExactFormalAuthority(input:{root:string;scope:WeeklyCandidateExactAuthorityScope;reader:WeeklyCandidateExactAuthorityReader}){
 const root=path.resolve(input.root),scope=input.scope;
 const file=path.join(root,sha(JSON.stringify([scope.tenantId,scope.programId,scope.packageId,scope.packageVersion]))+'.json');
 const exclusive=<T>(body:()=>Promise<T>)=>withPaidOperationLock(path.join(root,'.locks'),`weekly-exact-authority:${scope.tenantId}:${scope.programId}:${scope.packageId}:${scope.packageVersion}`,body);
 const current=async(allowExpiredOriginal=false)=>{
  const parsed=checked(await input.reader.read(),scope,input.reader,allowExpiredOriginal);if(!parsed)return null;
  const revoked=await input.reader.isRevoked(parsed.statement.authorizationId,parsed.authorizationHash);
  if(revoked!==false)fail('revocation_unknown_or_revoked');
  return parsed;
 };
 return {
  async reserve(candidateId:string,mediaSha256:string,operationId:string){return exclusive(async()=>{
   const auth=await current();if(!auth)return null;
   const candidate=auth.statement.candidates.find(c=>c.candidateId===candidateId&&c.mediaSha256===mediaSha256&&c.operationId===operationId&&
    c.jobId===scope.jobId&&c.jobHash===scope.jobHash&&c.runId===scope.runId&&c.runHash===scope.runHash&&c.scopeId===scope.scopeId&&c.scopeVersion===scope.scopeVersion);
   if(!candidate)return fail('candidate_scope_changed');
   const l=readLedger(file,auth.authorizationHash,ceilingMicros(auth.statement.weeklyMaximumCny));
   const old=l.entries[operationId];
   if(old){if(old.candidateId!==candidateId||old.mediaSha256!==mediaSha256||old.reservedMicros!==holdMicros(candidate.maximumCny))fail('hold_changed');}
   else{
    if(Object.values(l.entries).reduce((sum,e)=>sum+e.reservedMicros,0)+holdMicros(candidate.maximumCny)>l.weeklyMaximumMicros)fail('weekly_cny_exceeded');
    l.entries[operationId]={candidateId,mediaSha256,reservedMicros:holdMicros(candidate.maximumCny)};writeLedger(file,l);
   }
   return {authorizationId:auth.statement.authorizationId,authorizationHash:auth.authorizationHash,
    settlementBasis:auth.statement.settlementBasis??'original_billing',auditApiKeyId:auth.statement.auditApiKeyId??null,
    plan:{operationId,candidateId,mediaSha256,endpoint:auth.statement.endpoint,credentialSha256:auth.statement.credentialSha256,
     model:auth.statement.model,maximumRequests:candidate.maximumRequests,maximumTotalCny:candidate.maximumCny}};
  });},
  /** Recovery is read-only. An original operation cannot manufacture its
   * missing weekly hold merely by asking to settle after a process restart. */
  async readExistingHold(candidateId:string,mediaSha256:string,operationId:string,authorizationHash:string){return exclusive(async()=>{
   const auth=await current(true);if(!auth||auth.authorizationHash!==authorizationHash)throw Error('weekly_candidate_exact_authority_authorization_changed');
   const candidate=auth.statement.candidates.find(c=>c.candidateId===candidateId&&c.mediaSha256===mediaSha256&&c.operationId===operationId&&
    c.jobId===scope.jobId&&c.jobHash===scope.jobHash&&c.runId===scope.runId&&c.runHash===scope.runHash&&c.scopeId===scope.scopeId&&c.scopeVersion===scope.scopeVersion);
   const ledger=readLedger(file,authorizationHash,ceilingMicros(auth.statement.weeklyMaximumCny)),held=ledger.entries[operationId];
   if(!candidate||!held||held.candidateId!==candidateId||held.mediaSha256!==mediaSha256||held.reservedMicros!==holdMicros(candidate.maximumCny))throw Error('weekly_candidate_exact_authority_hold_missing_or_changed');
   return {authorizationId:auth.statement.authorizationId,authorizationHash:auth.authorizationHash,
    settlementBasis:auth.statement.settlementBasis??'original_billing',auditApiKeyId:auth.statement.auditApiKeyId??null,
    plan:{operationId,candidateId,mediaSha256,endpoint:auth.statement.endpoint,credentialSha256:auth.statement.credentialSha256,
     model:auth.statement.model,maximumRequests:candidate.maximumRequests,maximumTotalCny:candidate.maximumCny}};
  });},
  async assertCurrent(candidateId:string,mediaSha256:string,operationId:string,authorizationHash:string){return exclusive(async()=>{
   const auth=await current();if(!auth||auth.authorizationHash!==authorizationHash)return fail('authorization_changed');
   const candidate=auth.statement.candidates.find(c=>c.candidateId===candidateId&&c.mediaSha256===mediaSha256&&c.operationId===operationId&&
    c.jobId===scope.jobId&&c.jobHash===scope.jobHash&&c.runId===scope.runId&&c.runHash===scope.runHash&&c.scopeId===scope.scopeId&&c.scopeVersion===scope.scopeVersion);
   const l=readLedger(file,authorizationHash,ceilingMicros(auth.statement.weeklyMaximumCny)),held=l.entries[operationId];
   if(!candidate||!held||held.candidateId!==candidateId||held.mediaSha256!==mediaSha256||held.reservedMicros!==holdMicros(candidate.maximumCny))fail('hold_missing_or_changed');
  });},
  /** Read-only original settlement may arrive after the signing window. It
   * still requires the same signature, unrecalled authority and original hold;
   * this method must never be used to authorize a new provider request. */
  async assertOriginalForSettlement(candidateId:string,mediaSha256:string,operationId:string,authorizationHash:string){return exclusive(async()=>{
   const auth=await current(true);if(!auth||auth.authorizationHash!==authorizationHash)return fail('authorization_changed');
   const candidate=auth.statement.candidates.find(c=>c.candidateId===candidateId&&c.mediaSha256===mediaSha256&&c.operationId===operationId&&
    c.jobId===scope.jobId&&c.jobHash===scope.jobHash&&c.runId===scope.runId&&c.runHash===scope.runHash&&c.scopeId===scope.scopeId&&c.scopeVersion===scope.scopeVersion);
   const l=readLedger(file,authorizationHash,ceilingMicros(auth.statement.weeklyMaximumCny)),held=l.entries[operationId];
   if(!candidate||!held||held.candidateId!==candidateId||held.mediaSha256!==mediaSha256||held.reservedMicros!==holdMicros(candidate.maximumCny))fail('hold_missing_or_changed');
  });},
 };
}

/** Deployment adapter may only use an existing absolute, non-symlinked shared
 * root configured by the server operator. Missing configuration stays closed;
 * this does not install an issuer or produce a paid execution permit. */
export function prepareDeployedWeeklyCandidateExactFormalAuthority(input:{scope:WeeklyCandidateExactAuthorityScope;reader:WeeklyCandidateExactAuthorityReader}){
 const configured=process.env.WEEKLY_CANDIDATE_EXACT_LEDGER_ROOT;
 if(typeof configured!=='string'||!configured||!path.isAbsolute(configured))return fail('deployed_ledger_root_required');
 const stated=path.resolve(configured),actual=fs.realpathSync(stated);
 if(stated!==actual||!fs.statSync(actual).isDirectory())fail('deployed_ledger_root_invalid');
 return createWeeklyCandidateExactFormalAuthority({root:actual,...input});
}
