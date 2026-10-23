import {createHash} from 'node:crypto';
import type {DataStore} from '../storage/datastore.js';
export const CONTENT_CREATION_QUOTA_COLLECTION='social_content_creation_quotas';
export type QuotaScope={tenantId:string;programId:string;weekStart:string};
export type QuotaEntry='weekly_package'|'workspace'|'assistant';
type State='planned'|'reserved'|'running'|'delivered'|'released';
export interface CreationQuotaOrder {contentId:string;slotId:string;state:State;entry:QuotaEntry;packageId:string|null;packageVersion:number|null;productionTaskId:string|null;deliveryRef:string|null;replacesContentId:string|null;revisions?:Array<{executionTaskId:string;lineageHash:string;commandId:string;deliveries?:Array<{deliveryRef:string;commandId:string;at:string}>}>;}
interface Audit {commandId:string;actorId:string;at:string;reason:string;action:string;contentId:string|null;previousContentId:string|null;}
interface QuotaPayload {scope:QuotaScope;limit:number;orders:Record<string,CreationQuotaOrder>;slots:Array<{slotId:string;contentId:string|null}>;commands:Record<string,{hash:string;contentId:string|null}>;outbox:Array<{commandId:string;contentId:string;executionTaskId?:string;kind:'dispatch'|'cancel_planned';state:'pending'|'acknowledged'}>;audit:Audit[];}
interface Row {id:string;revision:number;payload:QuotaPayload;}
const canonical=(v:unknown):string=>Array.isArray(v)?`[${v.map(canonical).join(',')}]`:v&&typeof v==='object'?`{${Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>`${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`:JSON.stringify(v)??'null';
const hash=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
const fail=(s:string):never=>{throw Error(`content_creation_quota_${s}`);};
const valid=(v:string)=>typeof v==='string'&&v.trim()===v&&v.length>0&&v.length<300&&!['__proto__','constructor','prototype'].includes(v);
export function shanghaiNaturalWeek(date=new Date()):string{
 if(!Number.isFinite(date.getTime()))return fail('date_invalid');
 const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
 const midnight=new Date(`${day}T00:00:00+08:00`),weekday=new Date(`${day}T00:00:00Z`).getUTCDay();
 midnight.setUTCDate(midnight.getUTCDate()-((weekday+6)%7));
 return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(midnight);
}
function checkScope(scope:QuotaScope){if(!valid(scope.tenantId)||!valid(scope.programId)||!/^\d{4}-\d{2}-\d{2}$/.test(scope.weekStart)||shanghaiNaturalWeek(new Date(`${scope.weekStart}T12:00:00+08:00`))!==scope.weekStart)fail('scope_invalid');}
/** One database CAS commits the order, slot, command, audit and outbox together.
 * The caller supplies a verified atomic-store capability, never a request flag.
 * No process lock, parallel counter table, package-version pool or graph state. */
export function createContentCreationQuotaService(input:{store:DataStore;assertAtomicStore:()=>Promise<void>;now?:()=>Date;
 readReleaseSafety:(order:CreationQuotaOrder,scope:QuotaScope)=>Promise<{leaseActive:boolean;inFlight:boolean;paid:boolean;unknown:boolean}>;
 verifyRevisionDispatch?:(order:CreationQuotaOrder,scope:QuotaScope,revision:{executionTaskId:string;lineageHash:string})=>Promise<boolean>;
 verifyDelivery:(order:CreationQuotaOrder,scope:QuotaScope,deliveryRef:string,revision?:{executionTaskId:string;lineageHash:string})=>Promise<boolean>}){
 const now=()=>input.now?.()||new Date();
 const id=(scope:QuotaScope)=>hash([scope.tenantId,scope.programId,scope.weekStart]).slice(0,15);
 async function read(scope:QuotaScope){checkScope(scope);const row=await input.store.getById<Row>(CONTENT_CREATION_QUOTA_COLLECTION,id(scope));
  if(row&&(hash(row.payload.scope)!==hash(scope)||!Number.isInteger(row.revision)||!Array.isArray(row.payload.slots)||row.payload.slots.length!==row.payload.limit))fail('record_corrupt');return row;}
 async function ensure(scope:QuotaScope){await input.assertAtomicStore();if(!input.store.compareAndSwap)fail('atomic_store_unavailable');let row=await read(scope);if(row)return row;
  const payload:QuotaPayload={scope,limit:5,orders:{},slots:Array.from({length:5},(_,i)=>({slotId:`slot-${i+1}`,contentId:null})),commands:{},outbox:[],audit:[]};
  try{await input.store.create(CONTENT_CREATION_QUOTA_COLLECTION,{id:id(scope),tenant_id:scope.tenantId,program_id:scope.programId,week_start:scope.weekStart,revision:0,payload});}catch{/* deterministic unique ID arbitrates creation */}
  row=await read(scope);if(!row)fail('pool_create_failed');return row!;}
 async function command(scope:QuotaScope,cmd:{commandId:string;actorId:string;reason:string},body:unknown,mutate:(p:QuotaPayload)=>Promise<{contentId:string|null;previousContentId?:string|null;action:string}>){
  if(!valid(cmd.commandId)||!valid(cmd.actorId)||!valid(cmd.reason))fail('command_invalid');
  const fingerprint=hash({body,actorId:cmd.actorId,reason:cmd.reason});
  for(let attempt=0;attempt<20;attempt++){
   const row=await ensure(scope),p=structuredClone(row.payload),prior=p.commands[cmd.commandId];
   if(prior){if(prior.hash!==fingerprint)fail('command_reused');return {pool:p,order:prior.contentId?p.orders[prior.contentId]:null};}
   const result=await mutate(p);p.commands[cmd.commandId]={hash:fingerprint,contentId:result.contentId};
   p.audit.push({...cmd,...result,previousContentId:result.previousContentId||null,at:now().toISOString()});
   if(await input.store.compareAndSwap!(CONTENT_CREATION_QUOTA_COLLECTION,row.id,{revision:row.revision},{revision:row.revision+1,payload:p}))return{pool:p,order:result.contentId?p.orders[result.contentId]:null};
  }return fail('contention_retry');
 }
 const orderInput=(value:{contentId:string;entry:QuotaEntry;packageId?:string|null;packageVersion?:number|null}):Omit<CreationQuotaOrder,'slotId'|'state'|'replacesContentId'>=>{
  if(!valid(value.contentId)||!['weekly_package','workspace','assistant'].includes(value.entry))fail('order_invalid');
  if(value.packageId!=null&&!valid(value.packageId)||value.packageVersion!=null&&(!Number.isInteger(value.packageVersion)||value.packageVersion<1))fail('order_invalid');
  return{contentId:value.contentId,entry:value.entry,packageId:value.packageId??null,packageVersion:value.packageVersion??null,productionTaskId:null,deliveryRef:null};};
 return{read:async(scope:QuotaScope)=>(await read(scope))?.payload||null,
  readVersioned:async(scope:QuotaScope)=>{const row=await read(scope);return row?{revision:row.revision,pool:row.payload}:null;},
  replacePlanned:async(scope:QuotaScope,cmd:{commandId:string;actorId:string;reason:string},value:{expectedRevision:number;selectedContentId:string;replacement:Parameters<typeof orderInput>[0]})=>command(scope,cmd,{action:'replace_planned',value},async p=>{
   const current=await read(scope);if(current?.revision!==value.expectedRevision)fail('version_conflict');
   const old=p.orders[value.selectedContentId],fields=orderInput(value.replacement);
   if(!old||old.state!=='planned'||old.productionTaskId||old.deliveryRef||old.revisions?.length||p.orders[fields.contentId])fail('replacement_plan_required');
   if(Object.values(await input.readReleaseSafety(old,scope)).some(Boolean))fail('replacement_not_safe');
   const slot=p.slots.find(s=>s.contentId===old.contentId&&s.slotId===old.slotId);if(!slot)fail('record_corrupt');
   old.state='released';slot!.contentId=fields.contentId;
   p.orders[fields.contentId]={...fields,slotId:slot!.slotId,state:'planned',replacesContentId:old.contentId};
   p.outbox.push({commandId:cmd.commandId,contentId:old.contentId,kind:'cancel_planned',state:'pending'});
   return{contentId:fields.contentId,previousContentId:old.contentId,action:'plan_replaced'};
  }),
  plan:async(scope:QuotaScope,cmd:{commandId:string;actorId:string;reason:string},value:Parameters<typeof orderInput>[0])=>command(scope,cmd,{action:'plan',value},async p=>{
   const order=orderInput(value);if(p.orders[order.contentId]){if(p.orders[order.contentId].state==='released')fail('released_content_requires_explicit_revision');return{contentId:order.contentId,action:'existing'};}
   const slot=p.slots.find(s=>s.contentId===null);if(!slot)fail('full');slot!.contentId=order.contentId;p.orders[order.contentId]={...order,slotId:slot!.slotId,state:'planned',replacesContentId:null};return{contentId:order.contentId,action:'planned'};
  }),
  reserve:async(scope:QuotaScope,cmd:{commandId:string;actorId:string;reason:string},value:Parameters<typeof orderInput>[0])=>command(scope,cmd,{action:'reserve',value},async p=>{
   const fields=orderInput(value),existing=p.orders[fields.contentId];
   if(existing&&existing.state!=='planned'){if(existing.state==='released')fail('released_content_requires_explicit_revision');return{contentId:fields.contentId,action:'existing'};}
   let previous:string|null=existing?.replacesContentId??null,slot=existing?p.slots.find(s=>s.slotId===existing.slotId):undefined;
   if(!slot&&value.entry!=='weekly_package')slot=p.slots.find(s=>s.contentId&&p.orders[s.contentId]?.state==='planned'&&p.orders[s.contentId]?.entry==='weekly_package');
   if(!slot)slot=p.slots.find(s=>s.contentId===null);
   if(!slot)fail('full');
   if(slot!.contentId&&slot!.contentId!==fields.contentId){const prior=p.orders[slot!.contentId]!;const safety=await input.readReleaseSafety(prior,scope);if(Object.values(safety).some(Boolean))fail('replacement_not_safe');previous=prior.contentId;prior.state='released';p.outbox.push({commandId:cmd.commandId,contentId:prior.contentId,kind:'cancel_planned',state:'pending'});}
   slot!.contentId=fields.contentId;p.orders[fields.contentId]={...(existing||fields),slotId:slot!.slotId,state:'reserved',replacesContentId:previous};p.outbox.push({commandId:cmd.commandId,contentId:fields.contentId,kind:'dispatch',state:'pending'});return{contentId:fields.contentId,previousContentId:previous,action:'reserved'};
  }),
  transition:async(scope:QuotaScope,cmd:{commandId:string;actorId:string;reason:string},value:{contentId:string;state:'running'|'delivered';productionTaskId:string;deliveryRef?:string})=>command(scope,cmd,{action:'transition',value},async p=>{
   const o=p.orders[value.contentId];if(!o||o.state==='planned'||o.state==='released'||!valid(value.productionTaskId))fail('transition_invalid');
   if(o!.productionTaskId&&o!.productionTaskId!==value.productionTaskId)fail('production_identity_changed');
   if(o!.state==='delivered'){if(value.state!=='delivered'||o!.deliveryRef!==value.deliveryRef)fail('delivery_conflict');return{contentId:value.contentId,action:'existing'};}
   if(value.state==='delivered'&&(!value.deliveryRef||!await input.verifyDelivery({...o!,productionTaskId:value.productionTaskId},scope,value.deliveryRef)))fail('real_delivery_required');
   o!.productionTaskId=value.productionTaskId;o!.state=value.state;o!.deliveryRef=value.deliveryRef||null;return{contentId:value.contentId,action:value.state};
  }),
  release:async(scope:QuotaScope,cmd:{commandId:string;actorId:string;reason:string},contentId:string)=>command(scope,cmd,{action:'release',contentId},async p=>{
   const o=p.orders[contentId];if(!o||o.state==='delivered')fail('release_invalid');if(o!.state==='released')return{contentId,action:'existing'};
   const safety=await input.readReleaseSafety(o!,scope);if(Object.values(safety).some(Boolean))fail('release_not_safe');
   o!.state='released';const slot=p.slots.find(s=>s.contentId===contentId);if(slot)slot.contentId=null;return{contentId,action:'released'};
  }),
  increaseTarget:async(scope:QuotaScope,cmd:{commandId:string;actorId:string;reason:string},value:{newLimit:number;confirmationRef:string;expectedRevision?:number})=>command(scope,cmd,{action:'increase_target',value},async p=>{
   if(value.expectedRevision!==undefined&&(await read(scope))?.revision!==value.expectedRevision)fail('version_conflict');
   if(!Number.isInteger(value.newLimit)||value.newLimit<=p.limit||value.newLimit>100||!valid(value.confirmationRef))fail('explicit_target_revision_required');
   for(let i=p.limit;i<value.newLimit;i++)p.slots.push({slotId:`slot-${i+1}`,contentId:null});p.limit=value.newLimit;return{contentId:null,action:'target_increased'};
  }),
  acknowledgeOutbox:async(scope:QuotaScope,cmd:{commandId:string;actorId:string;reason:string},value:{outboxCommandId:string;contentId:string;kind:'dispatch'|'cancel_planned'})=>command(scope,cmd,{action:'acknowledge_outbox',value},async p=>{
   const item=p.outbox.find(o=>o.commandId===value.outboxCommandId&&o.contentId===value.contentId&&o.kind===value.kind);if(!item)fail('outbox_missing');item!.state='acknowledged';return{contentId:value.contentId,action:'outbox_acknowledged'};
  }),
  registerRevisionDispatch:async(scope:QuotaScope,cmd:{commandId:string;actorId:string;reason:string},value:{contentId:string;executionTaskId:string;lineageHash:string})=>command(scope,cmd,{action:'revision_dispatch',value},async p=>{
   const order=p.orders[value.contentId];
   if(!order||['planned','released'].includes(order.state)||!valid(value.executionTaskId)||!/^[a-f0-9]{64}$/.test(value.lineageHash)
    ||!await input.verifyRevisionDispatch?.(order,scope,value))fail('revision_lineage_required');
   const prior=order!.revisions?.find(r=>r.executionTaskId===value.executionTaskId&&r.lineageHash===value.lineageHash);
   if(prior)return{contentId:value.contentId,action:'existing'};
   (order!.revisions??=[]).push({executionTaskId:value.executionTaskId,lineageHash:value.lineageHash,commandId:cmd.commandId});
   p.outbox.push({commandId:cmd.commandId,contentId:value.contentId,executionTaskId:value.executionTaskId,kind:'dispatch',state:'pending'});
   return{contentId:value.contentId,action:'revision_dispatched'};
  }),
  recordRevisionDelivery:async(scope:QuotaScope,cmd:{commandId:string;actorId:string;reason:string},value:{contentId:string;executionTaskId:string;lineageHash:string;deliveryRef:string})=>command(scope,cmd,{action:'revision_delivery',value},async p=>{
   const order=p.orders[value.contentId];
   const revision=order?.revisions?.find(r=>r.executionTaskId===value.executionTaskId&&r.lineageHash===value.lineageHash);
   if(!order||['planned','released'].includes(order.state)||!revision||!valid(value.deliveryRef))fail('revision_delivery_binding_required');
   // The verifier receives the actual executing child/root task. This is only
   // a verification view: original productionTaskId, deliveryRef and quota
   // settlement remain immutable on the aggregate's original-content order.
   if(!await input.verifyDelivery({...order!,productionTaskId:value.executionTaskId},scope,value.deliveryRef,{executionTaskId:value.executionTaskId,lineageHash:value.lineageHash}))fail('real_revision_delivery_required');
   const deliveries=(revision!.deliveries??=[]);
   if(deliveries.some(d=>d.deliveryRef===value.deliveryRef))return{contentId:value.contentId,action:'existing'};
   deliveries.push({deliveryRef:value.deliveryRef,commandId:cmd.commandId,at:now().toISOString()});
   return{contentId:value.contentId,action:'revision_delivery_recorded'};
  }),
 };
}
