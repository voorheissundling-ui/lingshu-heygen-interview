import {createHash} from 'node:crypto';
import type {DataStore,Record_} from '../storage/datastore.js';
import {store} from '../storage/index.js';
import {socialAccessToken} from '../lib/accountCredentials.js';
import {readCustomerMessagingAuthorization} from '../digitalEmployees/customerMessagingPolicy.js';
import {assertMessengerCapabilityAuthority} from './capabilityAuthority.js';
import {getMessengerCustomers,type MessengerCustomer} from './conversations.js';
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
export function messengerCustomerAccountIdentityHash(account:Record<string,unknown>,openToken=socialAccessToken):string {
 return createHash('sha256').update(JSON.stringify({tenantId:account.tenantId,accountId:account.id,pageId:account.providerAccountId,status:account.status,messengerSubscribed:account.messengerSubscribed,oauthProvider:account.oauthProvider??null,tokenExpiresAt:account.tokenExpiresAt??account.expiresAt??null,credentialHash:createHash('sha256').update(openToken(account)).digest('hex')})).digest('hex');
}
/** Live projection contains only messages admitted for the current native Page and credential version. */
export async function readAuthorizedMessengerCustomers(tenantId:string,dataStore:DataStore=store,dependencies:{customers?:typeof getMessengerCustomers;openToken?:typeof socialAccessToken}={}):Promise<MessengerCustomer[]> {
 if(!tenantId?.trim())return [];
 try{
 const openToken=dependencies.openToken??socialAccessToken;
 const authorization=await readCustomerMessagingAuthorization(tenantId,'messenger',{dataStore,openMessengerToken:openToken});if(!authorization.manualFollowupSendAllowed)return [];
 const result=await dataStore.list<Record_>('social_accounts',{where:{tenantId,platform:'facebook',status:'connected'},perPage:1000});if(result.totalItems!==result.items.length)return [];
 const accounts=new Map<string,{account:Record_;hash:string}>();const ambiguous=new Set<string>();
 for(const raw of result.items){const account=structuredClone(raw);if(account.tenantId!==tenantId||account.platform!=='facebook'||account.status!=='connected'||account.mock||account.synthetic||typeof account.providerAccountId!=='string'||!account.providerAccountId)continue;try{assertMessengerCapabilityAuthority(account,openToken);const expiry=String(account.tokenExpiresAt||account.expiresAt||'');if(expiry&&(!Number.isFinite(Date.parse(expiry))||Date.parse(expiry)<=Date.now()))continue;const page=account.providerAccountId;if(accounts.has(page))ambiguous.add(page);accounts.set(page,{account,hash:messengerCustomerAccountIdentityHash(account,openToken)});}catch{continue;}}
 const customers:MessengerCustomer[]=[];
 for(const raw of (dependencies.customers??getMessengerCustomers)(tenantId)){
 const customer=object(raw);const page=String(customer.pageId||'');const recipient=String(customer.messengerUserId||'');const admitted=accounts.get(page);if(!admitted||ambiguous.has(page)||customer.tenantId!==tenantId||typeof customer.id!=='string'||!customer.id||!recipient||customer.isMock||customer.accountId!==undefined&&customer.accountId!==admitted.account.id)continue;
 const timeline:MessengerCustomer['timeline']=[];
 for(const rawMessage of Array.isArray(customer.timeline)?customer.timeline:[]){const message=object(rawMessage);const audit=object(message.audit);if(message.actor!=='buyer'||typeof message.id!=='string'||!message.id.startsWith('mid.')||typeof message.body!=='string'||typeof message.timestamp!=='number'||!Number.isFinite(message.timestamp)||message.timestamp<=0||message.timestamp>Date.now()||audit.inboundSource!=='verified_meta_webhook'||audit.accountId!==admitted.account.id||audit.pageId!==page||audit.accountHash!==admitted.hash||audit.providerMessageId!==message.id||audit.providerRecipientId!==recipient)continue;
 timeline.push({id:message.id,type:'messenger',actor:'buyer',title:'Customer message',body:message.body,time:new Date(message.timestamp).toISOString(),timestamp:message.timestamp,audit:{providerMessageId:message.id,providerRecipientId:recipient}});}
 if(!timeline.length)continue;timeline.sort((a,b)=>a.timestamp-b.timestamp);customers.push({id:customer.id,tenantId,pageId:page,messengerUserId:recipient,name:recipient,timeline,lastActiveAt:timeline.at(-1)!.timestamp,accountId:admitted.account.id,accountHash:admitted.hash,source:'messenger',isReal:true});
 }
 for(const {account,hash} of accounts.values()){const current=await dataStore.getById<Record_>('social_accounts',account.id);if(!current||current.tenantId!==tenantId||current.status!=='connected'||messengerCustomerAccountIdentityHash(current,openToken)!==hash)return [];assertMessengerCapabilityAuthority(current,openToken);}
 const finalAuthorization=await readCustomerMessagingAuthorization(tenantId,'messenger',{dataStore,openMessengerToken:openToken});if(!finalAuthorization.manualFollowupSendAllowed||finalAuthorization.configVersion!==authorization.configVersion)return [];
 return customers;
 }catch{return [];}
}
