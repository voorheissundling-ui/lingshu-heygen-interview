import type {Starter198Repository} from '../starter198/repository.js';
import {STARTER_COLLECTIONS} from '../starter198/repository.js';
import {readSocialTaskDetail} from '../starter198/socialContentRecords.js';
import {socialText,SocialContentWorkflowError} from '../starter198/socialContentValidation.js';
import {decodeMaterialRef} from '../starter198/socialContentProductionMaterials.js';
import type {SocialContentTaskDetail} from '../../shared/contracts/socialContentWorkflow.js';

export interface ReviewedWeeklyVideoBinding {recordId:string;sha256:string;sourceRef:string;sourceVersion:string;type:'video'}
const fail=(code:string):never=>{throw new SocialContentWorkflowError(code,409);};
const required=<T>(value:T|null|undefined,code:string):T=>value??fail(code);

/** Projects already-admitted weekly video evidence into the existing per-shot routing contract. */
export async function bindReviewedWeeklyVideosToShots(input:{repository:Starter198Repository;tenantId:string;taskId:string;bindings:ReviewedWeeklyVideoBinding[]}):Promise<SocialContentTaskDetail>{
 const {repository,tenantId,taskId}=input;if(!tenantId||!taskId||!input.bindings.length)fail('weekly_reviewed_material_binding_invalid');
 const detail=required(await readSocialTaskDetail({repository,tenantId,taskId}),'weekly_reviewed_material_binding_closed');
 const plan=required(detail.assetSupplyPlan,'weekly_reviewed_material_binding_closed');
 const unique=new Map(input.bindings.map(binding=>[binding.recordId,binding]));if(unique.size!==input.bindings.length||input.bindings.some(binding=>binding.type!=='video'||!/^[a-z0-9]{15}$/.test(binding.recordId)||!/^[a-f0-9]{64}$/.test(binding.sha256)||binding.sourceVersion!==binding.sha256))fail('weekly_reviewed_material_binding_invalid');
 for(const binding of unique.values()){const decoded=decodeMaterialRef(binding.sourceRef);if(decoded!==binding.recordId&&decoded!==`pb-${binding.recordId}`)fail('weekly_reviewed_material_source_unverified');const matching=detail.sources.filter(source=>source.status==='active'&&source.kind==='material'&&source.sourceRef===binding.sourceRef&&source.sourceVersion===binding.sourceVersion);if(matching.length!==1)fail('weekly_reviewed_material_source_unverified');}
 if(detail.runId)return detail;
 const ids=[...unique.keys()].sort(),existingByShot=new Map((detail.shotMaterialMap??[]).map(item=>[item.shotId,item]));const mapped=plan.shots.map(shot=>{const existing=existingByShot.get(shot.shotId);return{shotId:shot.shotId,customerAssetIds:[...new Set([...(existing?.customerAssetIds??[]),...ids])].sort(),generatedAssetIds:[...(existing?.generatedAssetIds??[])],licensedAssetIds:[...(existing?.licensedAssetIds??[])],sourceStrategy:'customer_real_asset' as const,truthBoundary:structuredClone(existing?.truthBoundary??shot.truthBoundary),functionalEquivalentReplacement:structuredClone(existing?.functionalEquivalentReplacement??shot.functionalEquivalentReplacement)};});
 const existing=detail.shotMaterialMap??[];if(existing.length===mapped.length&&mapped.every(expected=>existing.some(item=>item.shotId===expected.shotId&&JSON.stringify([...item.customerAssetIds].sort())===JSON.stringify(ids))))return detail;
 if(detail.runId)fail('weekly_reviewed_material_binding_closed');const rows=await repository.list(STARTER_COLLECTIONS.socialContentTasks,tenantId,{where:{task_id:taskId},perPage:2});if(rows.totalItems!==1||rows.items.length!==1)fail('weekly_reviewed_material_task_changed');const row=rows.items[0]!;if(row.run_id||socialText(row.version)!==detail.version)fail('weekly_reviewed_material_task_changed');
 const nextVersion=String(Number(row.version)+1),store=repository.dataStore;if(!store||!await store.update(STARTER_COLLECTIONS.socialContentTasks,row.id,{shot_material_map:mapped,director_plan:'',version:nextVersion,updated_at:new Date().toISOString()}))fail('weekly_reviewed_material_binding_save_failed');
 const fresh=required(await readSocialTaskDetail({repository,tenantId,taskId}),'weekly_reviewed_material_binding_save_failed');if(fresh.runId||fresh.shotMaterialMap?.length!==mapped.length||fresh.shotMaterialMap.some(entry=>entry.customerAssetIds.some(id=>!unique.has(id))))fail('weekly_reviewed_material_binding_save_failed');return fresh;
}
