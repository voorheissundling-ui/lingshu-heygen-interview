import type {DataStore} from '../storage/datastore.js';
import {socialJson,socialObject,socialRequestHash} from './socialContentValidation.js';
import {readContentExecutionJob} from '../contentExecution/durableQueue.js';
const fields=['mode','contentMode','ratio','lang','duration','script','scriptType','scriptVersion','voiceoverLines','shootingSlots','storyboardTimeline','activeAssemblyId','videoKickoff','storyboardSourcePlans','socialDigitalHumanPlans','selectedProductIds','productInfo','callToAction','primaryCta','allowRealPublishing','presenterMode','presentationMode','presentationSources','socialContentTaskId','workflowRunId','contextRunId','taskVersion'] as const;
function plan(spec:Record<string,any>){return Object.fromEntries(fields.map(key=>[key,spec[key]??null]));}
export function frozenStudioProjectSpec(value:unknown):Record<string,any>{
 const spec=socialObject(socialJson(value))??{},contract=socialObject(spec.resolvedStudioContract);
 if(!contract)return spec;
 const snapshot=socialObject(contract.planSnapshot);
 if(contract.schemaVersion!=='social-frozen-studio.v1'||!snapshot||socialRequestHash(snapshot)!==contract.planSnapshotHash)throw Error('studio_frozen_contract_corrupt');
 return {...spec,...snapshot,resolvedStudioContract:contract};
}
export function assertFrozenStudioProjectWrite(stored:unknown,incoming:Record<string,any>){
 const original=socialObject(socialJson(stored))??{},contract=socialObject(original.resolvedStudioContract);
 if(!contract){if(incoming.resolvedStudioContract)throw Error('studio_frozen_contract_server_owned');return;}
 const canonical=frozenStudioProjectSpec(original);
 if(socialRequestHash(plan(incoming))!==socialRequestHash(plan(canonical)))throw Error('studio_frozen_plan_changed');
 if(incoming.resolvedStudioContract&&socialRequestHash(incoming.resolvedStudioContract)!==socialRequestHash(contract))throw Error('studio_frozen_contract_server_owned');
 incoming.resolvedStudioContract=contract;
}
/** Trusted CAS binding only; never changes task/job, approvals, provider receipts or generation evidence. */
export async function bindFrozenSocialStudioProject(input:{dataStore:DataStore;tenantId:string;taskId:string;runId:string;projectId:string;expectedUpdatedAt:string;planSpec:Record<string,any>;dryRun?:boolean}){
 const project=await input.dataStore.getById<any>('studio_projects',input.projectId),stored=socialObject(socialJson(project?.spec));
 if(!project||project.tenant_id!==input.tenantId||stored?.socialContentTaskId!==input.taskId)throw Error('studio_frozen_scope_invalid');
 const rows=await input.dataStore.list<any>('starter_social_content_tasks',{where:{tenant_id:input.tenantId,task_id:input.taskId},perPage:2});
 if(rows.totalItems!==1)throw Error('studio_frozen_task_ambiguous');
 const task=rows.items[0],brief=socialObject(socialJson(task.brief)),marker=socialObject(brief?._productionRevision);
 const {planHash,preparedAt:_,preparedBy:__,...immutable}=marker??{};
 const job=await readContentExecutionJob(input.dataStore,input.tenantId,input.taskId,input.runId);
 const binding=socialObject(job?.checkpoints['social.executor']?.payload),approved=socialObject(binding?.approvedContext);
 if(task.run_id!==input.runId||!marker||marker.tenantId!==input.tenantId||marker.taskId!==input.taskId||socialRequestHash(immutable)!==planHash||approved?.revisionPlanHash!==planHash||binding?.executor!=='langgraph')throw Error('studio_frozen_authority_changed');
 const shots=(socialObject(marker.resolved)?.replicationScript as any)?.shots;
 const spec=structuredClone(input.planSpec),slots=spec.shootingSlots,timeline=spec.storyboardTimeline;
 if(!Array.isArray(shots)||!Array.isArray(slots)||!Array.isArray(timeline)||slots.length!==shots.length||timeline.length!==shots.length)throw Error('studio_frozen_scene_count_changed');
 shots.forEach((shot:any,i:number)=>{const slot=slots[i],time=timeline[i],detail=String(slot.detail||'');
  if(slot.id!==shot.shotId||slot.slotId!==shot.shotId||time.start!==shot.startSeconds||time.end!==shot.endSeconds||Math.abs(slot.duration-(shot.endSeconds-shot.startSeconds))>.000001||detail.match(/Spoken: ([^\n]*)/)?.[1]!== (shot.spokenText||'None')||detail.match(/Visual: ([^\n]*)/)?.[1]!==shot.visualInstruction||!spec.storyboardSourcePlans?.[shot.shotId])throw Error('studio_frozen_scene_changed');
 });
 if(spec.callToAction!==brief?.callToAction||spec.allowRealPublishing!==false||!spec.selectedProductIds?.includes(String(brief?.productId||'')))throw Error('studio_frozen_facts_changed');
 spec.script=shots.map((shot:any,i:number)=>`${shot.startSeconds}s-${shot.endSeconds}s\n${slots[i].detail}`).join('\n\n');
 spec.voiceoverLines=shots.filter((shot:any)=>shot.spokenText).map((shot:any)=>`${shot.startSeconds}s-${shot.endSeconds}s\n${shot.spokenText}`).join('\n\n');
 spec.scriptType='storyboard';
 spec.storyboardTimeline=shots.map((shot:any,i:number)=>({...timeline[i],id:shot.shotId,start:shot.startSeconds,end:shot.endSeconds,time:`${shot.startSeconds}s-${shot.endSeconds}s`,detail:slots[i].detail}));
 spec.socialContentTaskId=input.taskId;spec.workflowRunId=input.runId;spec.contextRunId=input.runId;spec.taskVersion=Number(approved.version);spec.scriptVersion=(socialObject(marker.resolved)?.replicationScript as any)?.version;
 spec.presenterMode='digital';spec.presentationMode='heygen';spec.presentationSources=Object.fromEntries(shots.map((s:any)=>[s.shotId,s.materialPlan?.digitalHumanPlan?'avatar':'material']));
 const snapshot=plan(spec),contract={schemaVersion:'social-frozen-studio.v1',tenantId:input.tenantId,taskId:input.taskId,taskVersion:spec.taskVersion,runId:input.runId,jobId:job!.id,planHash,inputHash:binding.inputHash,scriptVersion:spec.scriptVersion,readOnlyPlan:true,planSnapshot:snapshot,planSnapshotHash:socialRequestHash(snapshot)};
 const current=String(project.updated_at||project.updated||'');
 if(current!==input.expectedUpdatedAt)throw Error('studio_project_version_conflict');
 const oldContract=socialObject(stored?.resolvedStudioContract);
 if(oldContract?.planHash===contract.planHash&&oldContract?.inputHash===contract.inputHash&&oldContract?.runId===contract.runId&&oldContract.adoptedAssets)(contract as any).adoptedAssets=oldContract.adoptedAssets;
 const next={...stored,...snapshot,resolvedStudioContract:contract};
 if(input.dryRun)return {replayed:false,projectId:input.projectId,contract,dryRun:true};
 if(socialRequestHash(stored?.resolvedStudioContract??null)===socialRequestHash(contract))return {replayed:true,projectId:input.projectId,contract};
 const updatedAt=new Date().toISOString();
 if(!input.dataStore.compareAndSwap||!await input.dataStore.compareAndSwap('studio_projects',input.projectId,{tenant_id:input.tenantId,updated_at:current},{spec:next,updated_at:updatedAt}))throw Error('studio_project_version_conflict');
 const saved=await input.dataStore.getById<any>('studio_projects',input.projectId);
 if(socialRequestHash(socialObject(socialJson(saved?.spec))?.resolvedStudioContract??null)!==socialRequestHash(contract))throw Error('studio_frozen_binding_unconfirmed');
 return {replayed:false,projectId:input.projectId,contract};
}
