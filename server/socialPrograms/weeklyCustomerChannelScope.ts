import {readAuthorizedMessengerCustomers} from '../messenger/authorizedCustomerRead.js';
import {assertMessengerCapabilityAuthority} from '../messenger/capabilityAuthority.js';
import {readCanonicalWhatsAppAccount} from '../whatsapp/canonicalAccount.js';
import {store as runtimeStore} from '../storage/index.js';
import {socialJson,socialObject} from '../starter198/socialContentValidation.js';
import {createHash} from 'node:crypto';
import type {DataStore,Record_} from '../storage/datastore.js';
import type {WeeklyCustomerRelationshipScope} from './weeklyCustomerRelationshipScope.js';
import {getMessengerCustomers} from '../messenger/conversations.js';
import {getInstagramCustomers} from '../instagram/conversations.js';

export type WeeklyCustomerChannel='whatsapp'|'messenger'|'instagram';
export interface WeeklyChannelConversation {
 tenantId:string;customerId:string;channel:WeeklyCustomerChannel;nativeAccountId:string;recipientId:string;
 /** Actual native account/recipient pair, never a client-supplied arbitrary conversation identifier. */
 conversationId:string;messages:unknown[];customerSnapshot?:Record<string,unknown>;
}
export interface WeeklyChannelSelection {
 scope:WeeklyCustomerRelationshipScope;channel:WeeklyCustomerChannel;accountId:string;nativeAccountId:string;
 customerId:string;recipientId:string;conversationId:string;inboundMessageId:string;inboundAt:string;
 accountHash:string;inboundHash:string;recordHash:string;
}
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const obj=(v:unknown):Record<string,unknown>|null=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:null;
const text=(v:unknown)=>typeof v==='string'&&v.trim()?v:null;
function fail(code:string):never{throw Error(code);}
export interface WeeklyChannelConversationPort {read(tenantId:string,channel:WeeklyCustomerChannel):Promise<WeeklyChannelConversation[]>}
/** M/IG source is the actual webhook conversation store. WA remains the existing canonical workflow source. */
export const nativeWeeklyConversationPort:WeeklyChannelConversationPort={async read(tenantId,channel){
 if(channel==='whatsapp')return readCanonicalWeeklyWhatsAppConversations(runtimeStore,tenantId);
 const customers=channel==='messenger'?await readAuthorizedMessengerCustomers(tenantId,runtimeStore):getInstagramCustomers(tenantId);
 return customers.map(c=>{const account=String(channel==='messenger'?c.pageId:c.instagramAccountId),recipient=String(channel==='messenger'?c.messengerUserId:c.instagramUserId);return {tenantId:c.tenantId,customerId:c.id,channel,nativeAccountId:account,recipientId:recipient,conversationId:`${channel}:${account}:${recipient}`,messages:c.timeline,customerSnapshot:c};});
}};
async function account(store:DataStore,scope:WeeklyCustomerRelationshipScope,channel:WeeklyCustomerChannel,accountId:string){
 if(channel==='whatsapp'){const proof=await readCanonicalWhatsAppAccount(store,scope.tenantId,accountId);return {id:proof.accountId,tenantId:scope.tenantId,platform:'whatsapp',providerAccountId:proof.nativeAccountId,canonicalAuthorityHash:proof.accountHash,wabaId:proof.wabaId,status:'connected'} as Record_;}
 const a=await store.getById<Record_>('social_accounts',accountId);
 const platform=channel==='messenger'?'facebook':channel;
 if(!a||a.tenantId!==scope.tenantId||a.platform!==platform||a.status!=='connected'||!text(a.providerAccountId)||a.mock||a.synthetic)fail('weekly_customer_channel_not_connected');
 if(channel==='messenger')assertMessengerCapabilityAuthority(a!);
 return a!;
}
/** Freeze one actual provider inbound and connected account, after the caller has checked run/actor authority. No send or relation inference. */
export async function selectWeeklyChannelConversation(store:DataStore,input:{scope:WeeklyCustomerRelationshipScope;channel:WeeklyCustomerChannel;accountId:string;customerId:string;inboundMessageId:string},port:WeeklyChannelConversationPort=weeklyConversationPortForStore(store)):Promise<WeeklyChannelSelection>{
 const {scope}=input;if(!['whatsapp','messenger','instagram'].includes(input.channel))fail('weekly_customer_channel_invalid');
 const start=Date.parse(scope.weekStart),end=Date.parse(scope.weekEnd);
 if(!Number.isFinite(start)||!Number.isFinite(end)||end<start||!Number.isSafeInteger(scope.packageVersion)||scope.packageVersion<1)fail('weekly_customer_channel_scope_invalid');
 const a=await account(store,scope,input.channel,input.accountId);
 const all=await port.read(scope.tenantId,input.channel);
 const matches=all.filter(c=>c.tenantId===scope.tenantId&&c.channel===input.channel&&c.customerId===input.customerId&&c.nativeAccountId===a.providerAccountId);
 if(matches.length!==1)fail('weekly_customer_channel_conversation_missing');
 const c=matches[0]!;
 if(!text(c.recipientId)||c.conversationId!==`${input.channel}:${c.nativeAccountId}:${c.recipientId}`)fail('weekly_customer_channel_conversation_invalid');
 const messages=c.messages.map(obj).filter((m):m is Record<string,unknown>=>!!m&&m.id===input.inboundMessageId);
 if(messages.length!==1)fail('weekly_customer_channel_inbound_ambiguous');
 const m=messages[0]!,audit=obj(m.audit);
 if(m.actor!=='buyer'||!text(m.body)||typeof m.timestamp!=='number'||!Number.isFinite(m.timestamp)||m.timestamp<=0||m.timestamp>Date.now()||m.mock||m.synthetic||m.simulated||audit?.providerMessageId!==m.id||audit?.providerRecipientId!==c.recipientId)fail('weekly_customer_channel_real_inbound_required');
 // Existing relationships may intentionally use a prior true conversation. New inquiry classification is checked separately.
 const payload={scope:{...scope},channel:input.channel,accountId:input.accountId,nativeAccountId:c.nativeAccountId,customerId:c.customerId,recipientId:c.recipientId,conversationId:c.conversationId,inboundMessageId:String(m.id),inboundAt:new Date(m.timestamp).toISOString(),accountHash:typeof a.canonicalAuthorityHash==='string'?a.canonicalAuthorityHash:hash({platform:a.platform,providerAccountId:a.providerAccountId,parentPageId:a.parentPageId??null,oauthProvider:a.oauthProvider??null,...(a.platform==='facebook'?{messengerCapability:assertMessengerCapabilityAuthority(a)}:{})}),inboundHash:hash(m)};
 return {...payload,recordHash:hash(payload)};
}
export async function verifyWeeklyChannelSelection(store:DataStore,scope:WeeklyCustomerRelationshipScope,value:unknown,port:WeeklyChannelConversationPort=weeklyConversationPortForStore(store)){
 const v=obj(value);if(!v||Object.entries(scope).some(([k,val])=>obj(v.scope)?.[k]!==val))fail('weekly_customer_channel_selection_scope_changed');
 const live=await selectWeeklyChannelConversation(store,{scope,channel:v.channel as WeeklyCustomerChannel,accountId:String(v.accountId),customerId:String(v.customerId),inboundMessageId:String(v.inboundMessageId)},port);
 if(hash({...v,recordHash:undefined})!==live.recordHash||v.recordHash!==live.recordHash)fail('weekly_customer_channel_selection_evidence_changed');
 return live;
}

async function actualRows(store:DataStore,collection:string,tenantId:string){const all:Record_[]=[];const ids=new Set<string>();let total:number|undefined;for(let page=1;page<=1000;page++){const r=await store.list<Record_>(collection,{where:{tenant_id:tenantId},page,perPage:250,sort:'id'});if(!Number.isSafeInteger(r.totalItems)||r.totalItems<0||total!==undefined&&total!==r.totalItems)fail('weekly_whatsapp_source_pagination_changed');total=r.totalItems;for(const row of r.items){if(!row.id||ids.has(row.id)||row.tenant_id!==tenantId)fail('weekly_whatsapp_source_pagination_invalid');ids.add(row.id);all.push(row);}if(all.length===total)return all;if(!r.items.length)break;}return fail('weekly_whatsapp_source_pagination_incomplete');}
export async function readCanonicalWeeklyWhatsAppConversations(store:DataStore,tenantId:string):Promise<WeeklyChannelConversation[]>{const [customers,interactions]=await Promise.all([actualRows(store,'whatsapp_customers',tenantId),actualRows(store,'whatsapp_interactions',tenantId)]);const groups=new Map<string,WeeklyChannelConversation>();for(const row of interactions){const p=socialObject(socialJson(row.payload)),audit=socialObject(p?.audit);if(!p||!audit||p.tenantId!==tenantId||p.customerId!==row.customer_id||p.id!==row.interaction_id||p.type!=='msg_in'||audit.inboundSource!=='verified_meta_webhook'||typeof p.metaMessageId!=='string'||audit.providerMessageId!==p.metaMessageId||typeof audit.accountId!=='string'||typeof audit.phoneNumberId!=='string'||typeof audit.wabaId!=='string'||typeof p.waNumber!=='string'||audit.providerRecipientId!==p.waNumber||p.mock||p.synthetic||p.simulated)continue;let proof;try{proof=await readCanonicalWhatsAppAccount(store,tenantId,audit.accountId);}catch{continue;}if(proof.nativeAccountId!==audit.phoneNumberId||proof.wabaId!==audit.wabaId)continue;const customerRows=customers.filter(c=>c.customer_id===p.customerId);const customer=customerRows.length===1?socialObject(socialJson(customerRows[0]!.payload)):null;if(!customer||customer.tenantId!==tenantId||customer.id!==p.customerId||customer.mock||customer.synthetic)continue;const key=`whatsapp:${proof.nativeAccountId}:${p.waNumber}`;let c=groups.get(key);if(!c){c={tenantId,customerId:String(p.customerId),channel:'whatsapp',nativeAccountId:proof.nativeAccountId,recipientId:p.waNumber,conversationId:key,messages:[],customerSnapshot:customer};groups.set(key,c);}c.messages.push({id:p.metaMessageId,actor:'buyer',body:p.body,timestamp:p.timestamp,audit:{providerMessageId:p.metaMessageId,providerRecipientId:p.waNumber},canonicalInteractionId:p.id,canonicalAccountId:audit.accountId});}return [...groups.values()];}

export function weeklyConversationPortForStore(store:DataStore):WeeklyChannelConversationPort{return{read:(tenantId,channel)=>channel==='whatsapp'?readCanonicalWeeklyWhatsAppConversations(store,tenantId):nativeWeeklyConversationPort.read(tenantId,channel)};}
