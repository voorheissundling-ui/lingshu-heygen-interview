import type {MaterialRecord} from '../lib/materialLibrary.js';
import type {SocialAssetSupplyPlan} from '../../shared/contracts/socialContentWorkflow.js';
import {socialRequestHash} from './socialContentValidation.js';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {readTenantMaterialBytes} from '../lib/sentenceReplicationProduction.js';

const sha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const tenant=(record:MaterialRecord)=>String(record.tenantId||record.tenant_id||'');
const product=(record:MaterialRecord)=>String(record.productId||record.productRef||'').replace(/^product:/,'');
const contentHash=(record:MaterialRecord)=>String(record.contentSha256||record.contentHash||'').toLowerCase();

export interface ProductAssetFallbackRevision {
 schemaVersion:'social-product-asset-fallback-revision.v1';revisionId:string;parentPlanVersion:string;planVersion:string;
 tenantId:string;productId:string;failedAssetId:string;replacementAssetId:string;replacementSha256:string;
 rightsEvidenceRef:string;reason:'primary_product_image_unreadable';affectedShotIds:string[];createdAt:string;recordHash:string;
}

/** Eligibility is deliberately stricter than ordinary library visibility. A
 * fallback is production authority, so shared, synthetic, reference-only and
 * merely tagged records cannot inherit the selected product's authorization. */
export function isAuthorizedProductFallback(record:MaterialRecord,input:{tenantId:string;productId:string;failedAssetId:string}){
 const rights=String(record.rightsEvidenceRef||record.licenseEvidence||'').trim();
 return record.id!==input.failedAssetId&&tenant(record)===input.tenantId&&record.scope!=='shared'
  &&record.type==='image'&&product(record)===input.productId&&record.commercialUseApproved===true
  &&record.rightsStatus==='authorized'&&Boolean(rights)&&sha(contentHash(record))
  &&record.sourceType==='enterprise_product_table'
  &&record.synthetic!==true&&!/ai.generated|seedream|seedance|synthetic|generated|reference/i.test(String(record.sourceType||''));
}

/** A planning record alone is not a usable backup. Resolve current owned bytes
 * immediately before preparing the immutable task revision; the caller must
 * repeat this check at the existing paid-start/first-frame admission boundary. */
export async function createVerifiedProductAssetFallbackRevision(input:{
 tenantId:string;productId:string;failedAssetId:string;plan:SocialAssetSupplyPlan;materials:MaterialRecord[];
 /** Frozen source record may be absent from the current inventory once its bytes disappear. */
 failedAsset?:MaterialRecord;
 loadBytes?:(record:MaterialRecord,tenantId:string)=>Promise<Buffer>;createdAt?:string;
}):Promise<{plan:SocialAssetSupplyPlan;revision:ProductAssetFallbackRevision}|null>{
 const source=input.failedAsset?[input.failedAsset]:input.materials.filter(item=>item.id===input.failedAssetId);
 if(source.length!==1||source[0]!.id!==input.failedAssetId||tenant(source[0]!)!==input.tenantId||product(source[0]!)!==input.productId
  ||source[0]!.sourceType!=='enterprise_product_table')throw Error('product_fallback_source_identity_invalid');
 const load=input.loadBytes??(async(record:MaterialRecord,tenantId:string)=>(await readTenantMaterialBytes(record,tenantId)).bytes);
 const readValid=async(record:MaterialRecord):Promise<boolean>=>{
  try{
   const bytes=await load(record,input.tenantId);
   if(createHash('sha256').update(bytes).digest('hex')!==contentHash(record))return false;
   const metadata=await sharp(bytes,{failOn:'error'}).metadata();
   return Boolean(metadata.width&&metadata.height&&metadata.width>=64&&metadata.height>=64);
  }catch{return false;}
 };
 if(await readValid(source[0]!))throw Error('product_fallback_primary_still_readable');
 const verified:MaterialRecord[]=[];
 for(const candidate of input.materials.filter(item=>isAuthorizedProductFallback(item,input))){
  if(await readValid(candidate))verified.push(candidate);
 }
 return createProductAssetFallbackRevision({...input,materials:verified,isReadable:()=>true});
}

function replace(values:string[],before:string,after:string){return [...new Set(values.map(value=>value===before?after:value))];}

/** Creates a new immutable supply-plan revision; it never mutates the frozen
 * run and never touches presenter/voice identity. The caller persists and
 * admits this revision through the existing task revision/start path. */
export function createProductAssetFallbackRevision(input:{
 tenantId:string;productId:string;failedAssetId:string;plan:SocialAssetSupplyPlan;materials:MaterialRecord[];
 isReadable:(record:MaterialRecord)=>boolean;createdAt?:string;
}):{plan:SocialAssetSupplyPlan;revision:ProductAssetFallbackRevision}|null{
 const candidates=input.materials.filter(record=>isAuthorizedProductFallback(record,input)&&input.isReadable(record))
  .sort((left,right)=>String(left.createdAt||'').localeCompare(String(right.createdAt||''))||left.id.localeCompare(right.id));
 const replacement=candidates[0];
 if(!replacement)return null;
 const affected=input.plan.shots.filter(shot=>shot.sourceRefs.includes(input.failedAssetId)
  ||shot.materialRouting?.generation?.productImageRefs.includes(input.failedAssetId)
  ||shot.productSceneReplication?.productIdentity.groups.some(group=>group.referenceImageIds.includes(input.failedAssetId)));
 if(!affected.length)return null;
 const replacementSha256=contentHash(replacement),rightsEvidenceRef=String(replacement.rightsEvidenceRef||replacement.licenseEvidence);
 const revisionBody={schemaVersion:'social-product-asset-fallback-revision.v1' as const,parentPlanVersion:input.plan.planVersion,
  tenantId:input.tenantId,productId:input.productId,failedAssetId:input.failedAssetId,replacementAssetId:replacement.id,
  replacementSha256,rightsEvidenceRef,reason:'primary_product_image_unreadable' as const,
  affectedShotIds:affected.map(shot=>shot.shotId).sort(),createdAt:input.createdAt||new Date().toISOString()};
 const revisionId=socialRequestHash(revisionBody),planVersion=`${input.plan.planVersion}:asset-fallback:${revisionId.slice(0,12)}`;
 const plan:SocialAssetSupplyPlan={...structuredClone(input.plan),planVersion,shots:input.plan.shots.map(shot=>{
  if(!revisionBody.affectedShotIds.includes(shot.shotId))return structuredClone(shot);
  const next=structuredClone(shot);
  next.sourceRefs=replace(next.sourceRefs,input.failedAssetId,replacement.id);
  if(next.materialRouting?.generation)next.materialRouting.generation.productImageRefs=replace(next.materialRouting.generation.productImageRefs,input.failedAssetId,replacement.id);
  if(next.productSceneReplication)next.productSceneReplication.productIdentity.groups=next.productSceneReplication.productIdentity.groups.map(group=>({
   ...group,referenceImageIds:replace(group.referenceImageIds,input.failedAssetId,replacement.id),
  }));
  return next;
 })};
 const record={...revisionBody,revisionId,planVersion};
 return{plan,revision:{...record,recordHash:socialRequestHash(record)}};
}
