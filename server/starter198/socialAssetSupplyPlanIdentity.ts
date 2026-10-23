import type {SocialAssetSupplyPlan} from '../../shared/contracts/socialContentReplication.js';
import {socialRequestHash} from './socialContentValidation.js';
/** Byte, rights, dimensions and eligibility remain authoritative; read timestamps do not. */
export function socialAssetSupplyPlanIdentityHash(plan:SocialAssetSupplyPlan){
 const inventory=plan.inventoryAudit;
 const {scannedAt,...authority}=inventory??{};
 void scannedAt;
 return socialRequestHash({...plan,...(inventory?{inventoryAudit:{...authority,records:[...inventory.records].sort((a,b)=>a.id.localeCompare(b.id))}}:{})});
}
