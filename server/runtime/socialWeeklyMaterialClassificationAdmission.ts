import { readMaterialEvidenceConfiguration } from '../socialPrograms/materialEvidenceConfiguration.js';
import type { DataStore } from '../storage/datastore.js';
import type { WeeklyDirectorPlanningAnalysis, WeeklyDetailedContentScheduleItem, SocialWeeklyPublicationTask, WeeklyMaterialEvidenceRequirements } from '../../shared/contracts/socialProgram.js';
import type { SocialInspirationHandoff } from '../../shared/contracts/socialContentWorkflow.js';
import { socialJson, socialObject, socialRequestHash } from '../starter198/socialContentValidation.js';
import { verifyMaterialEvidenceRequirements } from '../socialPrograms/materialEvidenceClassification.js';
import { WEEKLY_MATERIAL_REQUESTS, type WeeklyMaterialRequest } from '../socialPrograms/weeklyMaterialRequests.js';
export async function checkWeeklyMaterialClassification(input:{store:DataStore;tenantId:string;programId?:string;packageId:string;packageVersion:number;item:WeeklyDetailedContentScheduleItem;analysis:WeeklyDirectorPlanningAnalysis|undefined;requireReferenceBinding?:boolean}):Promise<{ready:true;contract:WeeklyMaterialEvidenceRequirements}|{ready:false;code:string}> {
 const {item,analysis}=input;const c=item.materialEvidenceRequirements;
 if(!c||!analysis?.materialEvidenceRequirements)return {ready:false,code:'weekly_material_classification_required'};
 if(analysis.analysisId!==item.directorAnalysisRef?.id||analysis.packageId!==input.packageId||analysis.packageVersion!==input.packageVersion||analysis.slotId!==item.slotId||socialRequestHash(c)!==socialRequestHash(analysis.materialEvidenceRequirements)||socialRequestHash(item.materialRequirements)!==socialRequestHash(c.items.map(i=>i.description)))return {ready:false,code:'weekly_material_classification_lineage_invalid'};
 // A valid frozen handoff must be the reference named by both Director and
 // dispatch. A copied material contract cannot authorize an unrelated video.
 const directorVideos=analysis.benchmarkVideoRefs,dispatchVideos=item.benchmarkVideoRefs;
 if(c.handoffRef&&(
   (input.requireReferenceBinding&&(!Array.isArray(directorVideos)||!Array.isArray(dispatchVideos)))
   ||(directorVideos!==undefined&&(!Array.isArray(directorVideos)||directorVideos.length!==1||directorVideos[0]?.id!==c.handoffRef.inspirationId))
   ||(dispatchVideos!==undefined&&(!Array.isArray(dispatchVideos)||dispatchVideos.length!==1||dispatchVideos[0]?.id!==c.handoffRef.inspirationId))
   ||(Array.isArray(directorVideos)&&Array.isArray(dispatchVideos)&&socialRequestHash(dispatchVideos)!==socialRequestHash(directorVideos))
 ))return {ready:false,code:'weekly_material_classification_lineage_invalid'};
 let handoff:SocialInspirationHandoff|null=null;
 if(c.handoffRef){const rows=await input.store.list<any>('starter_social_inspiration_handoff_versions',{where:{tenant_id:input.tenantId,handoff_version:c.handoffRef.version,record_hash:c.handoffRef.recordHash},perPage:2});
 const matching=rows.items.map(row=>({row,handoff:socialJson(row.payload) as SocialInspirationHandoff})).filter(v=>v.row.tenant_id===input.tenantId&&v.handoff?.inspirationId===c.handoffRef!.inspirationId&&socialRequestHash(v.handoff)===v.row.record_hash);
 if(rows.totalItems>rows.items.length||matching.length!==1)return {ready:false,code:'weekly_material_classification_source_missing'};handoff=matching[0]!.handoff;}
 const configuration=c.configurationRef&&c.handoffRef&&input.programId ? await readMaterialEvidenceConfiguration(input.store,{tenantId:input.tenantId,programId:input.programId,scope:c.scope,handoffRef:c.handoffRef,ref:c.configurationRef}) : null;
 if(c.configurationRef&&!configuration)return {ready:false,code:'weekly_material_classification_configuration_invalid'};
 if(!verifyMaterialEvidenceRequirements(c,{packageId:input.packageId,packageVersion:input.packageVersion,slotId:item.slotId},analysis.frozenHandoffRefs??[],handoff,configuration))return {ready:false,code:'weekly_material_classification_source_invalid'};
 if(c.items.some(i=>i.classification==='unknown'))return {ready:false,code:'weekly_material_classification_configuration_required'};
 return {ready:true,contract:c};
}
/** IDs map frozen requirements to stable requests; request keys are not forced to change with each week version. */
export async function checkWeeklyHumanRequirementBindings(input:{store:DataStore;tenantId:string;programId:string;packageId:string;packageVersion:number;consumerTaskId:string;publication:SocialWeeklyPublicationTask;contract:WeeklyMaterialEvidenceRequirements}):Promise<string|null> {
 const required=input.contract.items.filter(i=>i.classification==='human_irreplaceable');if(!required.length)return null;
 const requirement=input.publication.materialRequirement;if(requirement?.required!==true||!requirement.requestIds.length)return 'weekly_required_material_contract_missing';
 const bindings=requirement.bindings;if(!Array.isArray(bindings)||bindings.length!==required.length||new Set(bindings.map(b=>b.requirementId)).size!==required.length||bindings.some(b=>!required.some(i=>i.requirementId===b.requirementId)||!requirement.requestIds.includes(b.requestId)))return 'weekly_material_requirement_mapping_required';
 for(const requestId of new Set(bindings.map(b=>b.requestId))){const rows=await input.store.list<any>(WEEKLY_MATERIAL_REQUESTS,{where:{tenant_id:input.tenantId,program_id:input.programId,request_id:requestId},perPage:2});if(rows.totalItems!==1||rows.items.length!==1)return 'weekly_material_requirement_request_missing';
 const request=socialObject(socialJson(rows.items[0]!.payload)) as unknown as WeeklyMaterialRequest|null;
 if(!request||request.tenantId!==input.tenantId||request.programId!==input.programId||request.requestId!==requestId||!Array.isArray(request.consumers))return 'weekly_material_requirement_request_invalid';
 const consumers=request.consumers.filter(c=>c.taskId===input.consumerTaskId&&c.packageId===input.packageId&&c.packageVersion===input.packageVersion);if(consumers.length!==1||typeof consumers[0]!.requirement!=='string')return 'weekly_material_requirement_consumer_missing';
 const lines=consumers[0]!.requirement.split('\n').map(l=>l.trim());for(const b of bindings.filter(b=>b.requestId===requestId)){const item=required.find(i=>i.requirementId===b.requirementId)!;if(!lines.includes(`${item.requirementId}：${item.description}`))return 'weekly_material_requirement_consumer_mapping_missing';}
 }
 return null;
}
