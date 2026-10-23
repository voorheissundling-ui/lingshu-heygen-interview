import {createHash} from 'node:crypto';
import type {BusinessContentGoal} from '../../shared/contracts/socialOperatingDecision.js';
import type {SocialWeeklyPublicationTask,VersionedSocialRef} from '../../shared/contracts/socialProgram.js';
import type {DataStore,Record_} from '../storage/datastore.js';
import type {EnterpriseProfile} from '../routes/enterprise.js';
import {socialJson,socialObject,socialRequestHash} from '../starter198/socialContentValidation.js';
import {readWeeklyExistingFactSource} from './weeklyExistingFactSource.js';
import {readWeeklyReviewActor} from './weeklyReviewEvidence.js';
import {organizationRoleOrNull} from '../lib/organizationRole.js';
import {SocialProgramError} from './service.js';
import {latestPackageRow} from './weeklyOperatingPackageSupport.js';
import {createSocialOperatingRepository} from '../socialOperating/repository.js';
import {withExecutionPackageGate,type ExecutionPackageScope} from './weeklyExecutionGate.js';

export const WEEKLY_PUBLICATION_PRODUCT_SELECTIONS='social_weekly_publication_product_selections';
export const WEEKLY_PUBLICATION_PRODUCT_SELECTION_ISSUANCES='social_weekly_publication_product_selection_issuances';

/** Mutable task state is deliberately excluded. A state-only transition
 * cannot change which immutable publication subject a product was chosen for. */
export function weeklyPublicationProductSubjectHash(publication:SocialWeeklyPublicationTask){
  const {status:_,...subject}=publication;
  return socialRequestHash(subject);
}

/** A future authenticated issuer must write this immutable receipt. The reader
 * deliberately has no fallback to the discovery scope, catalogue order, a
 * free-text factRef, or the number of products in the business goal. */
export interface WeeklyPublicationProductSelection {
  schemaVersion:'weekly-publication-product-selection.v1';
  tenantId:string;programId:string;packageId:string;packageVersion:number;publicationTaskId:string;
  publicationHash:string;productId:string;productName:string;productSku:string|null;
  motherContentId:string;groupPublicationTaskIds:string[];
  enterpriseFactRef:VersionedSocialRef;enterpriseFactContentHash:string;
  selectedBy:string;selectedAt:string;issuerOperationId:string;authorizesPublishing:false;authorizesCustomerMessages:false;
}

/** This operation is produced only by a future authenticated issuer, never by
 * an import, direct profile edit or the discovery planner. The separate
 * operation row is mandatory; a self-hashed selection row is not authority. */
export interface WeeklyPublicationProductSelectionIssuance {
  kind:'authenticated_weekly_publication_product_selection.v1';operationId:string;
  tenantId:string;programId:string;packageId:string;packageVersion:number;publicationTaskId:string;
  publicationHash:string;productId:string;enterpriseFactContentHash:string;
  authenticatedActorUserId:string;authenticatedAt:string;requestHash:string;resultReceiptHash:string;
  status:'succeeded';
}

export function weeklyPublicationProductSelectionId(scope:{tenantId:string;programId:string;packageId:string;packageVersion:number;publicationTaskId:string}){
  return createHash('sha256').update(JSON.stringify([scope.tenantId,scope.programId,scope.packageId,scope.packageVersion,scope.publicationTaskId,'publication-product-selection.v1'])).digest('hex').slice(0,15);
}

/** Read-only admission contract. Absence is an ordinary missing user choice;
 * storage failure is technical unavailability and must not be treated as a
 * negative choice. A later issuer must enforce authenticated consent and CAS. */
export async function readWeeklyPublicationProductSelection(input:{
  store:DataStore;tenantId:string;programId:string;packageId:string;packageVersion:number;
  publication:SocialWeeklyPublicationTask;goal:BusinessContentGoal;skipGroupCompleteness?:boolean;skipPendingIssuance?:boolean;
}):Promise<WeeklyPublicationProductSelection|null>{
  const {store,tenantId,programId,packageId,packageVersion,publication,goal}=input;
  if(goal.programId!==programId||!Number.isSafeInteger(packageVersion)||packageVersion<1)throw Error('weekly_product_selection_scope_invalid');
  const publicationTaskId=publication.publicationTaskId;
  const id=weeklyPublicationProductSelectionId({tenantId,programId,packageId,packageVersion,publicationTaskId});
  const rows=await store.list<Record_>(WEEKLY_PUBLICATION_PRODUCT_SELECTIONS,{where:{tenant_id:tenantId,program_id:programId,package_id:packageId,package_version:packageVersion,publication_task_id:publicationTaskId},perPage:2});
  if(rows.totalItems===0){
    if(!input.skipPendingIssuance){
      const pending=await store.list<Record_>(WEEKLY_PUBLICATION_PRODUCT_SELECTION_ISSUANCES,{where:{tenant_id:tenantId,program_id:programId,package_id:packageId,package_version:packageVersion,publication_task_id:publicationTaskId},perPage:2});
      if(pending.totalItems!==0)throw Error(pending.totalItems===1&&pending.items.length===1?'weekly_product_selection_issuance_pending':'weekly_product_selection_issuance_ambiguous');
    }
    return null;
  }
  if(rows.totalItems!==1||rows.items.length!==1)throw Error('weekly_product_selection_ambiguous');
  const row=rows.items[0]!,receipt=row.payload as WeeklyPublicationProductSelection|undefined;
  if(row.id!==id||!receipt||row.content_hash!==socialRequestHash(receipt)
    ||receipt.schemaVersion!=='weekly-publication-product-selection.v1'
    ||receipt.tenantId!==tenantId||receipt.programId!==programId||receipt.packageId!==packageId
    ||receipt.packageVersion!==packageVersion||receipt.publicationTaskId!==publicationTaskId
    ||receipt.publicationHash!==weeklyPublicationProductSubjectHash(publication)
    ||receipt.authorizesPublishing!==false||receipt.authorizesCustomerMessages!==false
    ||!receipt.productId||!receipt.productName||!receipt.selectedBy||!receipt.motherContentId||receipt.motherContentId!==publication.motherContentId||!Array.isArray(receipt.groupPublicationTaskIds)||!receipt.groupPublicationTaskIds.includes(publicationTaskId)||!/^[a-z0-9]{15}$/.test(receipt.issuerOperationId)
    ||!Number.isFinite(Date.parse(receipt.selectedAt))||Date.parse(receipt.selectedAt)>Date.now())throw Error('weekly_product_selection_invalid');
  const issueRow=await store.getById<Record_>(WEEKLY_PUBLICATION_PRODUCT_SELECTION_ISSUANCES,receipt.issuerOperationId);
  const issue=issueRow?.payload as WeeklyPublicationProductSelectionIssuance|undefined;
  const requestHash=socialRequestHash({tenantId,programId,packageId,packageVersion,publicationTaskId,publicationHash:receipt.publicationHash,productId:receipt.productId,enterpriseFactContentHash:receipt.enterpriseFactContentHash,actorUserId:receipt.selectedBy});
  if(!issueRow||!issue||issueRow.content_hash!==socialRequestHash(issue)
    ||issueRow.tenant_id!==tenantId||issue.operationId!==receipt.issuerOperationId
    ||issue.kind!=='authenticated_weekly_publication_product_selection.v1'||issue.status!=='succeeded'
    ||issue.tenantId!==tenantId||issue.programId!==programId||issue.packageId!==packageId
    ||issue.packageVersion!==packageVersion||issue.publicationTaskId!==publicationTaskId
    ||issue.publicationHash!==receipt.publicationHash||issue.productId!==receipt.productId
    ||issue.enterpriseFactContentHash!==receipt.enterpriseFactContentHash
    ||issue.authenticatedActorUserId!==receipt.selectedBy||issue.authenticatedAt!==receipt.selectedAt
    ||issue.requestHash!==requestHash||issue.resultReceiptHash!==row.content_hash)throw Error('weekly_product_selection_issuer_unverified');
  const source=await readWeeklyExistingFactSource(store,tenantId);
  if(socialRequestHash(receipt.enterpriseFactRef)!==socialRequestHash(source.ref)
    ||receipt.enterpriseFactContentHash!==source.sourceHash)throw Error('weekly_product_selection_fact_changed');
  const profileRows=await store.list<Record_>('tenant_profiles',{where:{tenant_id:tenantId},perPage:2});
  if(profileRows.totalItems!==1||profileRows.items.length!==1)throw Error('weekly_product_selection_profile_ambiguous');
  const profile=socialObject(socialJson(profileRows.items[0]!.profile)) as unknown as EnterpriseProfile;
  const products=(profile.products?.items??[]).filter(item=>item.id===receipt.productId);
  if(products.length!==1||products[0]!.name!==receipt.productName
    ||(products[0]!.sku??null)!==receipt.productSku
    ||goal.products.filter(name=>name===receipt.productName).length!==1)throw Error('weekly_product_selection_product_changed');
  const actor=await readWeeklyReviewActor(store,tenantId,receipt.selectedBy);
  if(!actor||actor.tenantId!==tenantId||!['super_admin','admin','social_operator'].includes(organizationRoleOrNull(actor.role)??'')
    ||actor.disabled===true||actor.active===false||['disabled','suspended'].includes(String(actor.status)))throw Error('weekly_product_selection_actor_revoked');
  if(!input.skipGroupCompleteness){
    const latest=await latestPackageRow(store,tenantId,programId,packageId);
    if(!latest||latest.version!==packageVersion||latest.payload.packageId!==packageId||latest.payload.programId!==programId)throw Error('weekly_product_selection_package_changed');
    const group=(latest.payload.socialContentPackage?.publicationTasks??[]).filter(p=>p.motherContentId===receipt.motherContentId);
    if(!receipt.motherContentId||!group.length||socialRequestHash(group.map(p=>p.publicationTaskId).sort())!==socialRequestHash([...receipt.groupPublicationTaskIds].sort())||new Set(receipt.groupPublicationTaskIds).size!==group.length)throw Error('weekly_product_selection_group_changed');
    for(const sibling of group){
      if(sibling.publicationTaskId===publicationTaskId)continue;
      const peer=await readWeeklyPublicationProductSelection({...input,publication:sibling,skipGroupCompleteness:true});
      if(!peer||peer.productId!==receipt.productId||peer.motherContentId!==receipt.motherContentId)throw Error('weekly_product_selection_group_incomplete');
    }
  }
  return receipt;
}

export async function requireWeeklyPublicationProductSelection(input:Parameters<typeof readWeeklyPublicationProductSelection>[0]){
  const selected=await readWeeklyPublicationProductSelection(input);
  if(!selected)throw Error('weekly_production_product_selection_required');
  return selected;
}

const selectionError=(code:string,status=409):never=>{throw new SocialProgramError(code,status,code);};
type SelectionContext={scope:ExecutionPackageScope;publications:SocialWeeklyPublicationTask[];goal:BusinessContentGoal;products:Array<{id:string;name:string;sku:string|null}>;fact:Awaited<ReturnType<typeof readWeeklyExistingFactSource>>;contextHash:string};
async function selectionContext(store:DataStore,scope:ExecutionPackageScope):Promise<SelectionContext>{
 const latest=await latestPackageRow(store,scope.tenantId,scope.programId,scope.packageId);
 if(!latest||latest.tenant_id!==scope.tenantId||latest.program_id!==scope.programId||latest.package_id!==scope.packageId)return selectionError('weekly_product_selection_package_missing',404);
 if(latest.version!==scope.packageVersion)return selectionError('weekly_product_selection_package_version_changed');
 const pkg=latest.payload,publications=pkg.socialContentPackage?.publicationTasks;
 if(pkg.packageId!==scope.packageId||pkg.programId!==scope.programId||pkg.version!==scope.packageVersion||!Array.isArray(publications)||!publications.length||new Set(publications.map(p=>p.publicationTaskId)).size!==publications.length||publications.some(p=>!p.publicationTaskId||!p.motherContentId))return selectionError('weekly_product_selection_package_invalid');
 const goalRef=pkg.businessContentGoalRef;
 if(goalRef?.type!=='business_content_goal')return selectionError('weekly_product_selection_goal_missing');
 const goal=await createSocialOperatingRepository(store).getGoal(scope.tenantId,scope.programId,goalRef.id,goalRef.version);
 if(!goal||goal.goalId!==goalRef.id||goal.programId!==scope.programId||goal.version!==goalRef.version||!Array.isArray(goal.products))return selectionError('weekly_product_selection_goal_invalid');
 const fact=await readWeeklyExistingFactSource(store,scope.tenantId);
 const rows=await store.list<Record_>('tenant_profiles',{where:{tenant_id:scope.tenantId},perPage:2});
 if(rows.totalItems!==1||rows.items.length!==1)return selectionError('weekly_product_selection_profile_ambiguous');
 const profile=socialObject(socialJson(rows.items[0]!.profile)) as unknown as EnterpriseProfile;
 const products=(profile.products?.items??[]).filter(p=>Boolean(p.id&&p.name&&goal.products.filter(name=>name===p.name).length===1)).map(p=>({id:p.id!,name:p.name,sku:p.sku??null}));
 if(new Set(products.map(p=>p.id)).size!==products.length)return selectionError('weekly_product_selection_products_ambiguous');
 const contextHash=socialRequestHash({scope,goalRef,goalHash:socialRequestHash(goal),factRef:fact.ref,factHash:fact.sourceHash,publications:publications.map(p=>({id:p.publicationTaskId,motherContentId:p.motherContentId,subjectHash:weeklyPublicationProductSubjectHash(p)})).sort((a,b)=>a.id.localeCompare(b.id)),products});
 return{scope,publications,goal,products,fact,contextHash};
}

export async function readWeeklyPublicationProductSelectionChoices(store:DataStore,scope:ExecutionPackageScope){
 const context=await selectionContext(store,scope);
 const publications:Array<{publicationTaskId:string;motherContentId:string;selectedProductId:string|null;receiptId:string|null;pendingOperation:boolean;pendingProductId:string|null}>=[];
 let pendingOperation=false;
 for(const publication of context.publications){
  const selected=await readWeeklyPublicationProductSelection({...scope,store,publication,goal:context.goal,skipGroupCompleteness:true,skipPendingIssuance:true});
  let thisPendingOperation=false;
  let pendingProductId:string|null=null;
  if(!selected){
   const pending=await store.list<Record_>(WEEKLY_PUBLICATION_PRODUCT_SELECTION_ISSUANCES,{where:{tenant_id:scope.tenantId,program_id:scope.programId,package_id:scope.packageId,package_version:scope.packageVersion,publication_task_id:publication.publicationTaskId},perPage:2});
   if(pending.totalItems>1||pending.totalItems!==pending.items.length)throw Error('weekly_product_selection_issuance_ambiguous');
   if(pending.totalItems===1){
    const row=pending.items[0]!,issue=row.payload as WeeklyPublicationProductSelectionIssuance|undefined;
    const expectedRequestHash=issue&&socialRequestHash({...scope,publicationTaskId:publication.publicationTaskId,publicationHash:weeklyPublicationProductSubjectHash(publication),productId:issue.productId,enterpriseFactContentHash:context.fact.sourceHash,actorUserId:issue.authenticatedActorUserId});
    const expectedId=expectedRequestHash&&createHash('sha256').update(`weekly-selection-issuer:${expectedRequestHash}`).digest('hex').slice(0,15);
    const actor=issue?await readWeeklyReviewActor(store,scope.tenantId,issue.authenticatedActorUserId):null;
    if(!issue||row.id!==expectedId||row.content_hash!==socialRequestHash(issue)||row.tenant_id!==scope.tenantId||issue.operationId!==row.id||issue.kind!=='authenticated_weekly_publication_product_selection.v1'||issue.status!=='succeeded'||issue.tenantId!==scope.tenantId||issue.programId!==scope.programId||issue.packageId!==scope.packageId||issue.packageVersion!==scope.packageVersion||issue.publicationTaskId!==publication.publicationTaskId||issue.publicationHash!==weeklyPublicationProductSubjectHash(publication)||issue.enterpriseFactContentHash!==context.fact.sourceHash||issue.requestHash!==expectedRequestHash||!context.products.some(product=>product.id===issue.productId)||!/^[a-f0-9]{64}$/.test(issue.resultReceiptHash)||!Number.isFinite(Date.parse(issue.authenticatedAt))||Date.parse(issue.authenticatedAt)>Date.now()||actor?.tenantId!==scope.tenantId||!['super_admin','admin','social_operator'].includes(organizationRoleOrNull(actor.role)??'')||actor.disabled===true||actor.active===false||['disabled','suspended'].includes(String(actor.status)))throw Error('weekly_product_selection_issuance_invalid');
    pendingOperation=true;thisPendingOperation=true;pendingProductId=issue.productId;
   }
  }
  publications.push({publicationTaskId:publication.publicationTaskId,motherContentId:publication.motherContentId,selectedProductId:selected?.productId??null,receiptId:selected?weeklyPublicationProductSelectionId({...scope,publicationTaskId:publication.publicationTaskId}):null,pendingOperation:thisPendingOperation,pendingProductId});
 }
 const complete=publications.every(p=>!p.selectedProductId||publications.filter(other=>other.motherContentId===p.motherContentId).every(other=>other.selectedProductId===p.selectedProductId));
 return{packageVersion:scope.packageVersion,contextHash:context.contextHash,products:context.products,publications,selectionState:pendingOperation?'pending_operation' as const:complete?'consistent' as const:'incomplete_group' as const};
}

/** One-shot immutable selection per publication. A batch can be retried after
 * interruption: each deterministic issuer operation is persisted before its
 * corresponding receipt, and the same request resumes without changing time. */
export async function issueWeeklyPublicationProductSelections(store:DataStore,scope:ExecutionPackageScope,actorUserId:string,input:{expectedContextHash:string;productId:string;publicationTaskIds:string[]}){
 if(!/^[a-f0-9]{64}$/.test(input.expectedContextHash)||!input.productId||!Array.isArray(input.publicationTaskIds)||!input.publicationTaskIds.length||new Set(input.publicationTaskIds).size!==input.publicationTaskIds.length||input.publicationTaskIds.some(id=>typeof id!=='string'||!id))return selectionError('weekly_product_selection_input_invalid',400);
 const actor=await readWeeklyReviewActor(store,scope.tenantId,actorUserId);
 if(actor?.tenantId!==scope.tenantId||!['super_admin','admin','social_operator'].includes(organizationRoleOrNull(actor.role)??'')||actor.disabled===true||actor.active===false||['disabled','suspended'].includes(String(actor.status)))return selectionError('weekly_product_selection_actor_forbidden',403);
 return withExecutionPackageGate(store,scope,async assert=>{
  const c=await selectionContext(store,scope);
  if(c.contextHash!==input.expectedContextHash)return selectionError('weekly_product_selection_context_changed');
  const product=c.products.find(p=>p.id===input.productId);
  if(!product)return selectionError('weekly_product_selection_product_missing');
  const chosen=new Set(input.publicationTaskIds),selected=c.publications.filter(p=>chosen.has(p.publicationTaskId));
  if(selected.length!==chosen.size)return selectionError('weekly_product_selection_publication_missing');
  for(const publication of selected)if(c.publications.some(other=>other.motherContentId===publication.motherContentId&&!chosen.has(other.publicationTaskId)))return selectionError('weekly_product_selection_mother_group_incomplete');
  const current=new Map<string,WeeklyPublicationProductSelection|null>();
  for(const publication of c.publications)current.set(publication.publicationTaskId,await readWeeklyPublicationProductSelection({...scope,store,publication,goal:c.goal,skipGroupCompleteness:true,skipPendingIssuance:true}));
  for(const publication of selected){const old=current.get(publication.publicationTaskId);if(old&&(old.productId!==product.id||old.selectedBy!==actorUserId))return selectionError('weekly_product_selection_already_issued');}
  for(const publication of c.publications){const old=current.get(publication.publicationTaskId);if(old&&selected.some(p=>p.motherContentId===publication.motherContentId)&&old.productId!==product.id)return selectionError('weekly_product_selection_mother_group_conflict');}
  for(const publication of selected){
   if(current.get(publication.publicationTaskId))continue;
   const publicationTaskId=publication.publicationTaskId,publicationHash=weeklyPublicationProductSubjectHash(publication);
   const requestHash=socialRequestHash({...scope,publicationTaskId,publicationHash,productId:product.id,enterpriseFactContentHash:c.fact.sourceHash,actorUserId});
   const operationId=createHash('sha256').update(`weekly-selection-issuer:${requestHash}`).digest('hex').slice(0,15);
   const oldOperation=await store.getById<Record_>(WEEKLY_PUBLICATION_PRODUCT_SELECTION_ISSUANCES,operationId);
   const selectedAt=oldOperation?(oldOperation.payload as WeeklyPublicationProductSelectionIssuance)?.authenticatedAt:new Date().toISOString();
   if(!selectedAt||!Number.isFinite(Date.parse(selectedAt)))return selectionError('weekly_product_selection_issuer_invalid');
   const receipt:WeeklyPublicationProductSelection={schemaVersion:'weekly-publication-product-selection.v1',...scope,publicationTaskId,publicationHash,productId:product.id,productName:product.name,productSku:product.sku,motherContentId:publication.motherContentId,groupPublicationTaskIds:c.publications.filter(p=>p.motherContentId===publication.motherContentId).map(p=>p.publicationTaskId).sort(),enterpriseFactRef:c.fact.ref,enterpriseFactContentHash:c.fact.sourceHash,selectedBy:actorUserId,selectedAt,issuerOperationId:operationId,authorizesPublishing:false,authorizesCustomerMessages:false};
   const resultReceiptHash=socialRequestHash(receipt);
   const issuance:WeeklyPublicationProductSelectionIssuance={kind:'authenticated_weekly_publication_product_selection.v1',operationId,...scope,publicationTaskId,publicationHash,productId:product.id,enterpriseFactContentHash:c.fact.sourceHash,authenticatedActorUserId:actorUserId,authenticatedAt:selectedAt,requestHash,resultReceiptHash,status:'succeeded'};
   if(oldOperation){if(oldOperation.tenant_id!==scope.tenantId||oldOperation.content_hash!==socialRequestHash(issuance))return selectionError('weekly_product_selection_issuer_conflict');}
   else{await assert();const created=await store.create(WEEKLY_PUBLICATION_PRODUCT_SELECTION_ISSUANCES,{id:operationId,tenant_id:scope.tenantId,program_id:scope.programId,package_id:scope.packageId,package_version:scope.packageVersion,publication_task_id:publicationTaskId,content_hash:socialRequestHash(issuance),payload:issuance});if(!created)return selectionError('weekly_product_selection_issuer_write_failed',503);}
   await assert();
   const id=weeklyPublicationProductSelectionId({...scope,publicationTaskId});
   const created=await store.create(WEEKLY_PUBLICATION_PRODUCT_SELECTIONS,{id,tenant_id:scope.tenantId,program_id:scope.programId,package_id:scope.packageId,package_version:scope.packageVersion,publication_task_id:publicationTaskId,content_hash:resultReceiptHash,payload:receipt});
   if(!created){const raced=await readWeeklyPublicationProductSelection({...scope,store,publication,goal:c.goal,skipGroupCompleteness:true,skipPendingIssuance:true});if(raced?.issuerOperationId!==operationId)return selectionError('weekly_product_selection_receipt_conflict');}
  }
  await assert();
  return readWeeklyPublicationProductSelectionChoices(store,scope);
 });
}
