import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {socialAccessToken} from '../lib/accountCredentials.js';
const prefix='messenger-proof-v1:';
const required=['pages_messaging','pages_manage_metadata'];
/** Existing scope storage holds actual permission names plus this distinctly named server proof. */
export function createMessengerCapabilityScope(input:{tenantId:string;accountId:string;pageId:string;appId:string;accessToken:string;grantedScopes:string[];validUntil?:number}):string{
 const grants=[...new Set(input.grantedScopes)].sort();
 if(!required.every(scope=>grants.includes(scope))||![input.tenantId,input.accountId,input.pageId,input.appId,input.accessToken].every(value=>value.trim()))throw Error('messenger_capability_identity_invalid');
 const verifiedAt=Date.now();const validUntil=Math.min(input.validUntil??verifiedAt+10*60*1000,verifiedAt+10*60*1000);if(!Number.isFinite(validUntil)||validUntil<=verifiedAt)throw Error('messenger_capability_expired');
 const payload=Buffer.from(JSON.stringify({version:1,verifiedAt,validUntil,tenantId:input.tenantId,accountId:input.accountId,pageId:input.pageId,appId:input.appId,grants,credentialHash:createHash('sha256').update(input.accessToken).digest('hex')})).toString('base64url');
 const signature=createHmac('sha256',input.accessToken).update(payload).digest('hex');
 return [...grants,`${prefix}${payload}.${signature}`].join(',');
}
export function assertMessengerCapabilityAuthority(account:Record<string,unknown>,openToken=socialAccessToken):string{
 if(account.platform!=='facebook'||account.status!=='connected'||account.messengerSubscribed!==true||typeof account.tenantId!=='string'||typeof account.id!=='string'||typeof account.providerAccountId!=='string')throw Error('messenger_capability_unverified');
 const expiry=String(account.tokenExpiresAt||account.expiresAt||'');if(account.mock||account.synthetic||account.simulated||(expiry&&(!Number.isFinite(Date.parse(expiry))||Date.parse(expiry)<=Date.now())))throw Error('messenger_capability_expired');
 const scopes=String(account.scope||'').split(',');const markers=scopes.filter(scope=>scope.startsWith(prefix));
 if(markers.length!==1||!required.every(scope=>scopes.includes(scope)))throw Error('messenger_capability_unverified');
 const [payload,signature,...extra]=markers[0]!.slice(prefix.length).split('.');const token=openToken(account);
 if(!token||!payload||!signature||extra.length||!/^[a-f0-9]{64}$/.test(signature))throw Error('messenger_capability_unverified');
 const expected=createHmac('sha256',token).update(payload).digest();
 if(!timingSafeEqual(expected,Buffer.from(signature,'hex')))throw Error('messenger_capability_changed');
 let proof:Record<string,unknown>;try{proof=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));}catch{throw Error('messenger_capability_unverified');}
 if(typeof proof.verifiedAt!=='number'||typeof proof.validUntil!=='number'||!Number.isFinite(proof.verifiedAt)||!Number.isFinite(proof.validUntil)||proof.verifiedAt>Date.now()||proof.validUntil<=Date.now()||proof.validUntil<=proof.verifiedAt||proof.validUntil-proof.verifiedAt>10*60*1000)throw Error('messenger_capability_expired');
 if(proof.version!==1||proof.tenantId!==account.tenantId||proof.accountId!==account.id||proof.pageId!==account.providerAccountId||typeof proof.appId!=='string'||!proof.appId||proof.credentialHash!==createHash('sha256').update(token).digest('hex')||!Array.isArray(proof.grants)||JSON.stringify(proof.grants)!==JSON.stringify(scopes.filter(scope=>!scope.startsWith(prefix)).sort())||!required.every(scope=>(proof.grants as unknown[]).includes(scope)))throw Error('messenger_capability_changed');
 return createHash('sha256').update(markers[0]!).digest('hex');
}
