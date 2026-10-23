import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import type {DataStore} from '../storage/datastore.js';
import {tenantCatalogImageFile} from '../lib/enterpriseMediaImage.js';
import {upsertSocialTaskMaterial,type MaterialRecord} from '../lib/materialLibrary.js';

const text=(value:unknown)=>String(value??'').trim();
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');

/** Registers exact Enterprise Center product images before task planning reads inventory. */
export async function registerEnterpriseProductMaterials(input:{dataStore:DataStore;tenantId:string;taskId:string;productId:string|null|undefined;mediaRoot?:string;upsert?:typeof upsertSocialTaskMaterial}):Promise<MaterialRecord[]>{
 const productId=text(input.productId);if(!productId)return[];
 const profiles=await input.dataStore.list<Record<string,unknown>>('tenant_profiles',{where:{tenant_id:input.tenantId},page:1,perPage:2});
 if(profiles.totalItems>1||profiles.items.some(row=>row.tenant_id!==input.tenantId))throw Error('enterprise_product_inventory_scope_invalid');
 const profileRow=profiles.items[0];if(!profileRow)return[];
 let profile:Record<string,unknown>|null=null;try{const raw=profileRow.profile;profile=typeof raw==='string'?JSON.parse(raw) as Record<string,unknown>:raw&&typeof raw==='object'?raw as Record<string,unknown>:null;}catch{return[];}
 const products=profile?.products&&typeof profile.products==='object'?profile.products as Record<string,unknown>:null;
 const items=Array.isArray(products?.items)?products.items.filter((v):v is Record<string,unknown>=>!!v&&typeof v==='object'):[];
 const product=items.find(row=>[row.id,row.productId,row.sku].some(value=>text(value)===productId));if(!product)return[];
 const productName=text(product.name)||productId,assets=[...(text(product.imageUrl)?[{url:product.imageUrl,name:`${productName}主图`}]:[]),...(Array.isArray(product.images)?product.images:[]),...(Array.isArray(product.packagingImages)?product.packagingImages:[])];
 const mediaRoot=path.resolve(input.mediaRoot||process.env.SOCIAL_CONTENT_MEDIA_ROOT||path.join(process.cwd(),'data/media')),seen=new Set<string>(),result:MaterialRecord[]=[];
 for(const [index,value] of assets.entries()){if(!value||typeof value!=='object')continue;const asset=value as Record<string,unknown>,url=text(asset.url);if(!url||seen.has(url))continue;seen.add(url);const file=tenantCatalogImageFile(url,input.tenantId,mediaRoot);if(!file)continue;const bytes=fs.readFileSync(file),metadata=await sharp(bytes).metadata();if(!metadata.width||!metadata.height)continue;const sha256=hash(bytes),sourceVersion=hash(JSON.stringify({profileId:text(profileRow.id),profileUpdatedAt:text(profileRow.updated||profileRow.updated_at),productId,url,sha256}));
  const id=`enterprise-product-${hash(`${input.tenantId}\0${productId}\0${url}`).slice(0,24)}`;
  const licenseEvidence=`enterprise_profile:${text(profileRow.id)}:product:${productId}`;
  result.push((input.upsert||upsertSocialTaskMaterial)({id,tenantId:input.tenantId,taskId:input.taskId,taskFileRef:`enterprise-profile:${text(profileRow.id)}:product:${productId}:image:${hash(url).slice(0,24)}`,contentSha256:sha256,productId,productRef:`product:${productId}`,productName,record:{id,name:text(asset.name)||`${productName}图片 ${index+1}`,folder:'product',type:'image',duration:0,width:metadata.width,height:metadata.height,sizeBytes:bytes.length,file:decodeURIComponent(new URL(url,'http://local.invalid').pathname).replace(/^\/media\//,''),url,scope:'own',usage:'editable',sourceType:'enterprise_product_table',sourceProvider:'tenant_enterprise_profile',sourceUrl:url,sourceRevision:sourceVersion,rightsStatus:'authorized',rightsEvidenceRef:licenseEvidence,licenseEvidence,commercialUseApproved:true,provenance:{schemaVersion:'enterprise-product-material.v1',profileId:text(profileRow.id),profileVersion:text(profileRow.updated||profileRow.updated_at),productId,sourceUrl:url,sourceSha256:sha256,sourceVersion},createdAt:text(profileRow.created||profileRow.created_at)||new Date(0).toISOString()}}));
 }
 return result;
}
