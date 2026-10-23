import {resolveManualConversationScope} from '../customerService/customerManualTakeover.js';
import {readWeeklyCustomerRelationshipScope} from '../socialPrograms/weeklyCustomerRelationshipScope.js';
import {verifyWeeklyCustomerChannelReceipt} from '../socialPrograms/weeklyCustomerChannelSelections.js';
import type {DataStore,Record_} from '../storage/datastore.js';
import {SocialProgramError} from '../socialPrograms/service.js';
import {followupItemContentHash,type FollowupBatchItemRecord} from './customerWorkflow.js';
const object=(v:unknown):Record<string,unknown>=>{if(typeof v==='string'){try{return object(JSON.parse(v));}catch{return {};}}return v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};};
function check(value:unknown,code:string):asserts value{if(!value)throw new SocialProgramError(code,409,'原客服任务、成员或客户身份未能核验。');}
async function one(store:DataStore,collection:string,where:Record<string,string>){const rows=await store.list<Record_>(collection,{where,perPage:2});check(rows.totalItems===1&&rows.items.length===1&&Object.entries(where).every(([k,v])=>rows.items[0]?.[k]===v),'customer_task_navigation_scope_invalid');return rows.items[0]!;}
/** Read-only navigation authority. Customer/channel come from the frozen actual member, never URL customer identifiers. */
export async function readCustomerTaskNavigation(store:DataStore,input:{tenantId:string;runId:string;taskId:string;itemId:string}){
 const run=await one(store,'workflow_runs',{tenant_id:input.tenantId,id:input.runId});
 const task=await one(store,'workflow_tasks',{tenant_id:input.tenantId,run_id:run.id,id:input.taskId});
 check(['customer_segmentation','followup_batch_draft','followup_batch_approval','followup_dispatch'].includes(String(task.task_key)),'customer_task_navigation_task_invalid');
 const item=await one(store,'followup_batch_items',{tenant_id:input.tenantId,id:input.itemId});
 const batch=await one(store,'followup_batches',{tenant_id:input.tenantId,id:String(item.batch_id),run_id:run.id});
 const member=await one(store,'customer_segment_members',{tenant_id:input.tenantId,id:String(item.segment_member_id),segment_id:String(batch.segment_id)});
 check(member.membership==='included'&&member.customer_id===item.customer_id&&typeof item.customer_id==='string'&&!!item.customer_id,'customer_task_navigation_member_changed');
 check(typeof item.content_hash==='string'&&item.content_hash===followupItemContentHash(item as unknown as FollowupBatchItemRecord),'customer_task_navigation_item_changed');
 const snapshot=object(member.customer_snapshot),selection=object(snapshot.weeklyChannelSelection),channel=String(selection.channel||snapshot.source||'');
 check(['whatsapp','messenger','instagram'].includes(channel),'customer_task_navigation_channel_missing');
 const scope=await readWeeklyCustomerRelationshipScope(store,input.tenantId,input.runId);
 if(channel!=='whatsapp'){check(scope,'customer_task_navigation_weekly_scope_missing');const receipt=await verifyWeeklyCustomerChannelReceipt(store,scope,channel as 'messenger'|'instagram');check(receipt&&receipt.recordHash===selection.recordHash,'customer_task_navigation_selection_changed');check(item.channel===channel&&selection.customerId===item.customer_id&&item.account_id===selection.accountId&&item.conversation_id===selection.conversationId&&item.weekly_channel_evidence_hash===selection.recordHash,'customer_task_navigation_native_identity_changed');}
 else check(typeof item.wa_number==='string'&&item.wa_number===snapshot.waNumber&&!!item.wa_number,'customer_task_navigation_whatsapp_identity_changed');
 const actual=channel==='whatsapp'&&scope?await resolveManualConversationScope(store,input.tenantId,String(item.customer_id),'whatsapp'):null;
 return {tenantId:input.tenantId,programId:scope?.programId??null,packageId:scope?.packageId??null,packageVersion:scope?.packageVersion??null,runId:run.id,taskId:task.id,taskKey:String(task.task_key),itemId:item.id,batchId:batch.id,memberId:member.id,customerId:item.customer_id,channel,nativeAccountId:actual?.nativeAccountId??(typeof selection.nativeAccountId==='string'?selection.nativeAccountId:null),accountId:actual?.accountId??(typeof selection.accountId==='string'?selection.accountId:null),conversationId:actual?.conversationId??(typeof selection.conversationId==='string'?selection.conversationId:null),itemHash:item.content_hash};
}
/** Original-batch workspace for item navigation; newer batches cannot silently replace it. */
export async function readCustomerTaskItemWorkspace(store:DataStore,input:{tenantId:string;runId:string;taskId:string;itemId:string}){
 const navigation=await readCustomerTaskNavigation(store,input);
 const run=await one(store,'workflow_runs',{tenant_id:input.tenantId,id:input.runId});
 const batch=await one(store,'followup_batches',{tenant_id:input.tenantId,id:navigation.batchId,run_id:input.runId});
 const segment=await one(store,'customer_segments',{tenant_id:input.tenantId,id:String(batch.segment_id),run_id:input.runId});
 async function rows(collection:string,where:Record<string,string>){const result=await store.list<Record_>(collection,{where,perPage:1000});check(result.totalItems===result.items.length&&result.items.every(row=>Object.entries(where).every(([k,v])=>row[k]===v)),'customer_task_navigation_workspace_incomplete');return result.items;}
 const batches=await rows('followup_batches',{tenant_id:input.tenantId,run_id:input.runId});
 check(batches.every(row=>Number.isSafeInteger(row.version)&&Number(row.version)>0),'customer_task_navigation_batch_version_invalid');
 const latest=Math.max(...batches.map(row=>Number(row.version)));check(batches.filter(row=>row.version===latest).length===1,'customer_task_navigation_batch_ambiguous');
 return {navigation,readOnly:['succeeded','cancelled'].includes(String(run.status))||Number(batch.version)!==latest,segment,batch,members:await rows('customer_segment_members',{tenant_id:input.tenantId,segment_id:segment.id}),items:await rows('followup_batch_items',{tenant_id:input.tenantId,batch_id:batch.id}),tasks:(await rows('workflow_tasks',{tenant_id:input.tenantId,run_id:input.runId})).map(task=>({id:task.id,run_id:run.id,title:task.title,task_key:task.task_key,status:task.status,blocker_reason:task.blocker_reason}))};
}
