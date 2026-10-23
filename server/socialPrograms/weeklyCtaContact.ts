import {createHash} from 'node:crypto';
import type {DataStore,Record_} from '../storage/datastore.js';
import {socialRequestHash} from '../starter198/socialContentValidation.js';
import {SocialProgramError} from './service.js';
import {PACKAGES,latestPackageRow,type PackageRow} from './weeklyOperatingPackageSupport.js';
import {readWeeklyAutomationTemplate} from './weeklyAutomationTemplate.js';
import {readWeeklyReviewActor} from './weeklyReviewEvidence.js';
import {organizationRoleOrNull} from '../lib/organizationRole.js';
import {withExecutionPackageGate,type ExecutionPackageScope} from './weeklyExecutionGate.js';
import {readWeeklyPublicationProductSelectionChoices} from './weeklyPublicationProductSelection.js';

export const WEEKLY_CTA_CONTACTS='social_weekly_cta_contacts';
export type WeeklyCtaContactScope=ExecutionPackageScope;
type Contact={contactChannel:'whatsapp';contactValue:string};
type Confirmation={receiptId:string;revision:number;scope:WeeklyCtaContactScope;contextHash:string;frozenCta:string;publicationScopeHash:string;selectedProduct:null;productSelectionStatus:'pending';contactChannel:'whatsapp';contactValue:string;confirmedBy:string;confirmedAt:string;samplePromiseConfirmed:false;authorizesPublishing:false;authorizesCustomerMessages:false};
type ContactRow=Record_&{tenant_id:string;program_id:string;package_id:string;package_version:number;revision:number;payload:Confirmation;record_hash:string};
const fail=(code:string,message:string,status=409):never=>{throw new SocialProgramError(code,status,message);};
const receiptDigest=(s:WeeklyCtaContactScope,revision:number)=>createHash('sha256').update(JSON.stringify([s.tenantId,s.programId,s.packageId,s.packageVersion,'cta-contact',revision])).digest('hex');
// PocketBase base-collection IDs are 15 alphanumeric characters. Keep the
// previous full digest readable for local receipts written before the schema
// existed, but use a deterministic PB-compatible ID for new revisions.
const receiptId=(s:WeeklyCtaContactScope,revision:number)=>receiptDigest(s,revision).slice(0,15);
const scopeWhere=(s:WeeklyCtaContactScope)=>({tenant_id:s.tenantId,program_id:s.programId,package_id:s.packageId,package_version:s.packageVersion});
const phone=(value:string)=>/^\+[1-9]\d{6,14}$/.test(value)&&value===value.trim();

async function currentContext(store:DataStore,s:WeeklyCtaContactScope){
 const latest=await latestPackageRow(store,s.tenantId,s.programId,s.packageId);
 if(!latest||latest.tenant_id!==s.tenantId||latest.program_id!==s.programId||latest.package_id!==s.packageId)return fail('weekly_cta_package_not_found','周包不存在。',404);
 if(latest.version!==s.packageVersion)return fail('weekly_cta_package_version_changed','周包版本已变化，请刷新任务卡。');
 const row=await store.list<PackageRow>(PACKAGES,{where:{tenant_id:s.tenantId,program_id:s.programId,package_id:s.packageId,version:s.packageVersion},perPage:2});
 if(row.totalItems!==1||row.items.length!==1||row.items[0]?.id!==latest.id)return fail('weekly_cta_package_ambiguous','周包身份不唯一。');
 const pkg=latest.payload;
 const publications=pkg.socialContentPackage?.publicationTasks;
 if(!Array.isArray(publications)||!publications.length||publications.some(p=>!p.publicationTaskId||!p.accountId))return fail('weekly_cta_publications_missing','当前周包发布任务身份不完整。');
 const publicationScopeHash=socialRequestHash(publications.map(p=>({publicationTaskId:p.publicationTaskId,accountId:p.accountId,platform:p.platform,motherContentId:p.motherContentId??null,adaptationOfPublicationTaskId:p.adaptationOfPublicationTaskId??null,factRefs:p.factRefs,cta:p.cta??null})).sort((a,b)=>a.publicationTaskId.localeCompare(b.publicationTaskId)));
 const adoption=await readWeeklyAutomationTemplate(store,s);
 if(!adoption)return fail('weekly_cta_template_missing','冻结自动周模板尚未采用。');
 const frozenCta=adoption.template.callToAction;
 if(!/whats\s*app/i.test(frozenCta)||!/free\s+sample/i.test(frozenCta))return fail('weekly_cta_template_unsupported','当前冻结文案不适用于此联系方式入口。');
 // This card collects a package-level contact route. The goal's products
 // are a catalogue, not a selected SKU; a later production claim must prove
 // its own exact product and free-sample policy before being rendered.
 const selectedProduct=null,productSelectionStatus='pending' as const;
 const contextHash=socialRequestHash({scope:s,frozenCta,publicationScopeHash,templateVersion:adoption.template.version,adoptionHash:socialRequestHash(adoption)});
 return{frozenCta,publicationScopeHash,selectedProduct,productSelectionStatus,contextHash};
}

async function latestContact(store:DataStore,s:WeeklyCtaContactScope):Promise<Confirmation|null>{
 const rows=await store.list<ContactRow>(WEEKLY_CTA_CONTACTS,{where:scopeWhere(s),sort:'-revision',perPage:2});
 if(!Number.isSafeInteger(rows.totalItems)||rows.totalItems<0||rows.totalItems>10000)return fail('weekly_cta_receipt_ambiguous','联系方式记录数量异常。');
 const row=rows.items[0];if(!row)return null;
 const p=row.payload;
 if(!p||![receiptId(s,row.revision),receiptDigest(s,row.revision)].includes(row.id)||p.receiptId!==row.id||p.revision!==row.revision||row.record_hash!==socialRequestHash(p)||socialRequestHash(p.scope)!==socialRequestHash(s)||p.confirmedBy===''||!phone(p.contactValue)||p.contactChannel!=='whatsapp'||p.samplePromiseConfirmed!==false||p.authorizesPublishing!==false||p.authorizesCustomerMessages!==false||!Number.isFinite(Date.parse(p.confirmedAt)))return fail('weekly_cta_receipt_invalid','联系方式确认记录已损坏。');
 return p;
}

export async function readWeeklyCtaContact(store:DataStore,s:WeeklyCtaContactScope){
 const context=await currentContext(store,s),saved=await latestContact(store,s);
 const actor=saved?await readWeeklyReviewActor(store,s.tenantId,saved.confirmedBy):null;
 const actorValid=Boolean(actor&&actor.tenantId===s.tenantId&&organizationRoleOrNull(actor.role)&&actor.disabled!==true&&actor.active!==false&&!['disabled','suspended'].includes(String(actor.status)));
 const valid=Boolean(saved&&actorValid&&saved.contextHash===context.contextHash&&saved.frozenCta===context.frozenCta&&saved.publicationScopeHash===context.publicationScopeHash&&saved.selectedProduct===null&&saved.productSelectionStatus==='pending');
 return{status:valid?'recorded' as const:'missing' as const,...context,...(valid&&saved?{contactChannel:saved.contactChannel,contactValue:saved.contactValue,samplePromiseConfirmed:false as const}:{}),receiptId:saved?.receiptId??null,receipt:valid?saved:null};
}

/** Card-only projection: never changes the immutable contact receipt or its CAS context.
 * A package-level product is shown only when every publication has a verified
 * issuer/receipt and all publications resolve to exactly the same product. */
export async function readWeeklyCtaContactCard(store:DataStore,s:WeeklyCtaContactScope){
 const contact=await readWeeklyCtaContact(store,s);
 try{
  const choices=await readWeeklyPublicationProductSelectionChoices(store,s);
  if(choices.selectionState!=='consistent')
   return {...contact,selectedProduct:null,productSelectionStatus:'unavailable' as const};
  if(!choices.publications.length||choices.publications.some(p=>!p.selectedProductId))
   return {...contact,selectedProduct:null,productSelectionStatus:'pending' as const};
  const ids=new Set(choices.publications.map(p=>p.selectedProductId));
  if(ids.size!==1)return {...contact,selectedProduct:null,productSelectionStatus:'multiple' as const};
  const product=choices.products.find(p=>p.id===choices.publications[0]!.selectedProductId);
  if(!product)return {...contact,selectedProduct:null,productSelectionStatus:'unavailable' as const};
  return {...contact,selectedProduct:{productId:product.id,name:product.name},productSelectionStatus:'selected' as const};
 }catch{
  // A broken selection reader is a technical state, not a missing user choice.
  return {...contact,selectedProduct:null,productSelectionStatus:'unavailable' as const};
 }
}

export async function saveWeeklyCtaContact(store:DataStore,s:WeeklyCtaContactScope,actorUserId:string,input:Contact&{expectedContextHash:string;expectedReceiptId:string|null}){
 if(input.contactChannel!=='whatsapp'||!phone(input.contactValue)||!/^[a-f0-9]{64}$/.test(input.expectedContextHash)||(input.expectedReceiptId!==null&&typeof input.expectedReceiptId!=='string'))return fail('weekly_cta_contact_input_invalid','请输入带国家区号的企业 WhatsApp 号码。',400);
 const actor=await readWeeklyReviewActor(store,s.tenantId,actorUserId);
 if(!actor||actor.tenantId!==s.tenantId||!organizationRoleOrNull(actor.role)||actor.disabled===true||actor.active===false||['disabled','suspended'].includes(String(actor.status)))return fail('weekly_cta_actor_forbidden','当前账号不能代表企业确认联系方式。',403);
 return withExecutionPackageGate(store,s,async assert=>{
  const context=await currentContext(store,s);
  if(context.contextHash!==input.expectedContextHash)return fail('weekly_cta_context_changed','周包、商品或企业资料已变化，请刷新后重新确认。');
  const old=await latestContact(store,s);
  if((old?.receiptId??null)!==input.expectedReceiptId)return fail('weekly_cta_contact_revision_changed','联系方式已由其他操作更新，请刷新任务卡。');
  if(old?.contextHash===context.contextHash&&old.contactValue===input.contactValue)return readWeeklyCtaContact(store,s);
  const revision=(old?.revision??0)+1;
  const payload:Confirmation={receiptId:receiptId(s,revision),revision,scope:s,...context,contactChannel:'whatsapp',contactValue:input.contactValue,confirmedBy:actorUserId,confirmedAt:new Date().toISOString(),samplePromiseConfirmed:false,authorizesPublishing:false,authorizesCustomerMessages:false};
  await assert();
  const created=await store.create(WEEKLY_CTA_CONTACTS,{id:payload.receiptId,...scopeWhere(s),revision,payload,record_hash:socialRequestHash(payload)});
  if(!created)return fail('weekly_cta_receipt_write_failed','联系方式确认暂未保存，请重试。',503);
  await assert();
  return readWeeklyCtaContact(store,s);
 });
}
