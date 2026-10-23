import type { DataStore } from '../storage/datastore.js';
import { createWeeklyMaterialRequestService, type WeeklyMaterialPorts, type WeeklyMaterialRequestService } from './weeklyMaterialRequests.js';

export interface FrozenWeeklyMaterialRequirement { required:boolean; requestIds:string[] }
export interface WeeklyRequiredMaterialAdmissionInput {
 tenantId:string;programId:string;consumerTaskId:string;
 /** Undefined means legacy workflow, not a statement that required inputs are ready. */
 requirement?:FrozenWeeklyMaterialRequirement|null;
}
export interface WeeklyRequiredMaterialAdmission {
 status:'ready'|'blocked'|'legacy_unhandled';
 materials:Array<{recordId:string;sha256:string;type:'image'|'video';byteSize:number}>;
 verifiedRequestRefs:Array<{requestId:string;submissionVersion:number}>;
 gaps:Array<{requestId:string|null;code:string}>;
}
export type WeeklyRequiredMaterialAdmissionPort=Pick<WeeklyMaterialRequestService,'acceptedForConsumer'>;
const empty=(status:WeeklyRequiredMaterialAdmission['status'],code:string):WeeklyRequiredMaterialAdmission=>({status,materials:[],verifiedRequestRefs:[],gaps:[{requestId:null,code}]});
/** A live byte-verifying admission gate over frozen request identities. It never fills missing contracts from current UI state. */
export async function assessWeeklyRequiredMaterialAdmission(input:WeeklyRequiredMaterialAdmissionInput,port:WeeklyRequiredMaterialAdmissionPort):Promise<WeeklyRequiredMaterialAdmission> {
 if(!input.requirement)return empty('legacy_unhandled','weekly_material_contract_not_frozen');
 const requirement=input.requirement;
 if(typeof requirement.required!=='boolean'||!Array.isArray(requirement.requestIds)||requirement.requestIds.some(id=>typeof id!=='string'||!id.trim())||new Set(requirement.requestIds).size!==requirement.requestIds.length)return empty('blocked','weekly_material_contract_invalid');
 if(!input.tenantId||!input.programId||!input.consumerTaskId)return empty('blocked','weekly_material_consumer_identity_missing');
 if(requirement.required&&requirement.requestIds.length===0)return empty('blocked','weekly_required_material_request_ids_missing');
 if(!requirement.required&&requirement.requestIds.length===0)return {status:'ready',materials:[],verifiedRequestRefs:[],gaps:[]};
 const gaps:WeeklyRequiredMaterialAdmission['gaps']=[];
 const verifiedRequestRefs:WeeklyRequiredMaterialAdmission['verifiedRequestRefs']=[];
 const materials=new Map<string,WeeklyRequiredMaterialAdmission['materials'][number]>();
 for(const requestId of requirement.requestIds) {
  try {
   const evidence=await port.acceptedForConsumer({tenantId:input.tenantId,programId:input.programId,requestId,consumerTaskId:input.consumerTaskId});
   if(!evidence){gaps.push({requestId,code:'weekly_required_material_not_verified_for_consumer'});continue;}
   if(evidence.requestId!==requestId||evidence.consumer.taskId!==input.consumerTaskId||!Number.isSafeInteger(evidence.submissionVersion)||evidence.submissionVersion<1||!evidence.materials.length){gaps.push({requestId,code:'weekly_required_material_evidence_identity_invalid'});continue;}
   const decision=evidence.verification?.consumerDecisions.find(item=>item.taskId===input.consumerTaskId);
   if(!decision?.accepted||!evidence.verification?.reviewedBy||!decision.factCheck||!decision.rightsCheck||!decision.visualCheck){gaps.push({requestId,code:'weekly_required_material_review_evidence_missing'});continue;}
   for(const material of evidence.materials) {
    if(!(/^[a-z0-9]{15}$/.test(material.recordId)||/^generated-[a-f0-9]{24}$/.test(material.recordId))||!/^[a-f0-9]{64}$/.test(material.sha256)||!['image','video'].includes(material.type)||!Number.isSafeInteger(material.byteSize)||material.byteSize<1){gaps.push({requestId,code:'weekly_required_material_revision_invalid'});continue;}
    const previous=materials.get(material.recordId);
    if(previous&&(previous.sha256!==material.sha256||previous.byteSize!==material.byteSize||previous.type!==material.type)){gaps.push({requestId,code:'weekly_required_material_revision_conflict'});continue;}
    materials.set(material.recordId,{...material});
   }
   verifiedRequestRefs.push({requestId,submissionVersion:evidence.submissionVersion});
  } catch(cause) {
   // Preserve the first authoritative error. No missing, cancelled or broken request becomes a waiver.
   const code=cause&&typeof cause==='object'&&'code' in cause&&typeof cause.code==='string'?cause.code:'weekly_required_material_verification_failed';
   gaps.push({requestId,code});
  }
 }
 if(gaps.length)return {status:'blocked',materials:[],verifiedRequestRefs,gaps};
 return {status:'ready',materials:[...materials.values()].sort((a,b)=>a.recordId.localeCompare(b.recordId)),verifiedRequestRefs,gaps:[]};
}
export function createWeeklyRequiredMaterialAdmission(store:DataStore,ports:WeeklyMaterialPorts={}) {
 const service=createWeeklyMaterialRequestService(store,ports);
 return (input:WeeklyRequiredMaterialAdmissionInput)=>assessWeeklyRequiredMaterialAdmission(input,service);
}
