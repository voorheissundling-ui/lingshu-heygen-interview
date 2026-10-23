import {createHash} from 'node:crypto';
import type {TenantPlatformAppRecord} from '../lib/tenantPlatformApps.js';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function whatsappAssetAuthorityHash(app:TenantPlatformAppRecord):string{return hash({tenantId:app.tenant_id,appId:app.app_id,wabaId:app.waba_id,phoneNumberId:app.phone_number_id,credentialHash:hash(app.access_token),signingCredentialHash:hash(app.app_secret)});}
export function assertVerifiedWhatsAppAssets(app:TenantPlatformAppRecord):void{
 let checklist:Record<string,unknown>={};try{checklist=JSON.parse(app.last_checklist||'{}') as Record<string,unknown>;}catch{throw Error('whatsapp_asset_authority_unverified');}
 const proof=checklist.whatsappAssetProof as {authorityHash?:unknown;verifiedAt?:unknown}|undefined;
 if(!proof||proof.authorityHash!==whatsappAssetAuthorityHash(app)||typeof proof.verifiedAt!=='string'||!Number.isFinite(Date.parse(proof.verifiedAt))||Date.parse(proof.verifiedAt)>Date.now())throw Error('whatsapp_asset_authority_unverified');
}
