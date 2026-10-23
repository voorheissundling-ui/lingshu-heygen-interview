import { readMaterialLibrary, type MaterialRecord } from '../lib/materialLibrary.js';
import { isSyntheticMaterial } from '../lib/materialTruthfulness.js';
import { isReferenceOnlyMaterial } from '../lib/materialPolicy.js';
export interface WeeklyMaterialInventoryAudit {
  scannedAt: string;
  records: Array<{ id:string; sha256:string|null; mediaType:string; productRef:string|null; width:number|null; height:number|null; durationSeconds:number|null; rightsEvidenceRef:string|null; productionEligible:boolean; gaps:string[] }>;
}
/** Scans tenant-visible actual library rows. Unknown metadata remains a gap, never an invented clearance. */
export function auditWeeklyMaterialInventory(tenantId:string,records:MaterialRecord[],now=new Date().toISOString()):WeeklyMaterialInventoryAudit {
  return {scannedAt:now,records:records.filter(r=>String(r.tenantId||r.tenant_id||'')===tenantId||r.scope==='shared').map(r=>{
    const sha=String(r.contentSha256||r.sha256||'');
    const rights=String(r.licenseEvidence||r.consentRef||'').trim();
    const gaps:string[]=[];
    if(!/^[a-f0-9]{64}$/.test(sha))gaps.push('byte_version_unknown');
    if(!rights||r.commercialUseApproved!==true)gaps.push('commercial_authorization_unknown');
    if(!(Number(r.width)>0&&Number(r.height)>0))gaps.push('visual_dimensions_unknown');
    if(isSyntheticMaterial(r)||isReferenceOnlyMaterial(r))gaps.push('reference_or_test_only');
    return {id:r.id,sha256:/^[a-f0-9]{64}$/.test(sha)?sha:null,mediaType:String(r.type||''),productRef:String(r.productRef||r.productId||'')||null,width:Number(r.width)>0?Number(r.width):null,height:Number(r.height)>0?Number(r.height):null,durationSeconds:Number.isFinite(r.duration)?Number(r.duration):null,rightsEvidenceRef:rights||null,productionEligible:gaps.length===0&&['image','video'].includes(r.type),gaps};
  })};
}
export async function readWeeklyMaterialInventory(tenantId:string){const inventory=await readMaterialLibrary(tenantId);return {...inventory,audit:auditWeeklyMaterialInventory(tenantId,inventory.items)};}
