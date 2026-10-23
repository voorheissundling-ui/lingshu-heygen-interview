import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import type {DataStore} from '../storage/datastore.js';
import type {SocialAssetSupplyProviderAdapter,SocialAssetSupplyAdapterContext} from './socialContentAssetSupplyExecution.js';
import type {SocialProductionAsset} from './socialContentProductionPlan.js';
import {readContentExecutionJob} from '../contentExecution/durableQueue.js';
import {socialObject,socialRequestHash} from './socialContentValidation.js';
import {socialProductionExecutor} from './socialContentProductionGraph.js';
/** Only a canonical Studio/provider reader may supply this evidence. Client bodies are not proof. */
export interface StudioCompletedAssetEvidence {
  tenantId:string;taskId:string;runId:string;jobId:string;projectId:string;shotId:string;
  graphInputHash:string;revisionPlanHash:string;frozenShotHash:string;
  providerId:string;providerTaskId:string;providerReceiptRef:string;providerReceiptHash:string;
  providerStatus:'completed';budgetReceiptRef:string;budgetStatus:'completed';
  actualCostCny:number|null;usageEvidenceRef:string|null;
  asset:SocialProductionAsset;mediaSha256:string;durationSeconds:number;
  quality:{status:'passed';evidenceRefs:string[];mediaSha256:string};
  authorizationRef:string;sourceReceiptRefs:string[];
}
export interface StudioAdoptionScope {tenantId:string;taskId:string;runId:string;jobId:string}
async function hashFile(file:string){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
/** A recovery-only adapter: has no submit/generate/authorization-budget port. */
export function createStudioReceiptAdoptionAdapter(input:{dataStore:DataStore;scope:StudioAdoptionScope;
  readCanonicalEvidence:(scope:StudioAdoptionScope & {shotId:string})=>Promise<StudioCompletedAssetEvidence|null>;
}):SocialAssetSupplyProviderAdapter{
  return {adapterId:'studio_completed_receipt_adoption.v1',sourceStrategies:['authorized_digital_presenter','aigc_product_scene_replication'],
    async execute(context:SocialAssetSupplyAdapterContext){
      if(context.tenantId!==input.scope.tenantId||context.taskId!==input.scope.taskId)throw Error('studio_adoption_scope_mismatch');
      const job=await readContentExecutionJob(input.dataStore,input.scope.tenantId,input.scope.taskId,input.scope.runId);
      if(!job||job.id!==input.scope.jobId||socialProductionExecutor(job)!=='langgraph')throw Error('studio_adoption_graph_scope_invalid');
      const binding=socialObject(job.checkpoints['social.executor']?.payload),approved=socialObject(binding?.approvedContext);
      const scenes=socialObject(approved?.agentWorkflow)?.executionPlan as {scenes?:Array<Record<string,unknown>>}|undefined;
      const scene=scenes?.scenes?.find(value=>value.sceneId===context.shot.shotId);
      if(!scene||scene.selectedSourceStrategy!==context.shot.sourceStrategy)throw Error('studio_adoption_frozen_route_changed');
      const proof=await input.readCanonicalEvidence({...input.scope,shotId:context.shot.shotId});
      if(!proof)throw Error('user_input_required:studio_completed_receipt_missing');
      if(Object.entries(input.scope).some(([key,value])=>proof[key as keyof StudioAdoptionScope]!==value)
        ||proof.shotId!==context.shot.shotId||proof.graphInputHash!==binding?.inputHash||proof.revisionPlanHash!==approved?.revisionPlanHash
        ||proof.frozenShotHash!==socialRequestHash(scene)||proof.providerStatus!=='completed'||proof.budgetStatus!=='completed'
        ||!proof.projectId||!proof.providerTaskId||!proof.providerReceiptRef||!proof.budgetReceiptRef
        ||!proof.authorizationRef||!proof.sourceReceiptRefs.length||!/^[a-f0-9]{64}$/.test(proof.providerReceiptHash))throw Error('studio_adoption_receipt_invalid');
      const director = socialObject(approved?.agentWorkflow)?.directorBrief as { scenes?: Array<{sceneId:string;duration?:{targetSeconds:number}}> } | undefined;
      const targetDuration = director?.scenes?.find(value => value.sceneId === context.shot.shotId)?.duration?.targetSeconds;
      if (!(Number(targetDuration) > 0) || Math.abs(proof.durationSeconds - Number(targetDuration)) > .2) throw Error('studio_adoption_duration_mismatch');
      if(proof.quality.status!=='passed'||!proof.quality.evidenceRefs.length||proof.quality.mediaSha256!==proof.mediaSha256
        ||!proof.asset.localPath||proof.asset.type!=='video'||proof.asset.providerTaskId!==proof.providerTaskId
        ||proof.asset.contentHash!==proof.mediaSha256||proof.asset.duration!==proof.durationSeconds||!(proof.durationSeconds>0)
        ||await hashFile(proof.asset.localPath)!==proof.mediaSha256)throw Error('studio_adoption_media_or_quality_invalid');
      if(proof.actualCostCny!==null&&(!Number.isFinite(proof.actualCostCny)||proof.actualCostCny<0||!proof.usageEvidenceRef))throw Error('studio_adoption_cost_evidence_invalid');
      return {asset:{...structuredClone(proof.asset),authorizationRef:proof.authorizationRef,segments:[...(proof.asset.segments??[]),{studioAdoption:{projectId:proof.projectId,jobId:job.id,runId:job.runId,inputHash:binding!.inputHash,revisionPlanHash:approved!.revisionPlanHash,providerReceiptRef:proof.providerReceiptRef,providerReceiptHash:proof.providerReceiptHash,budgetReceiptRef:proof.budgetReceiptRef,actualCostCny:proof.actualCostCny,usageEvidenceRef:proof.usageEvidenceRef,sourceReceiptRefs:proof.sourceReceiptRefs,qualityEvidenceRefs:proof.quality.evidenceRefs}}]},sourceStrategy:context.shot.sourceStrategy,providerId:proof.providerId,sourceRef:proof.providerTaskId,synthetic:true,representation:'non_evidentiary_visual',authorizationRef:proof.authorizationRef,disclosure:'Synthetic media; not customer factory or efficacy evidence'};
    }};
}

const ADOPTIONS='social_studio_asset_adoptions';
/** Persist only evidence returned by a trusted canonical provider/Studio reader, after full validation. */
export async function recordStudioGraphAssetAdoption(input:{dataStore:DataStore;scope:StudioAdoptionScope;shotId:string;
  readCanonicalEvidence:(scope:StudioAdoptionScope & {shotId:string})=>Promise<StudioCompletedAssetEvidence|null>;
}){
  const job=await readContentExecutionJob(input.dataStore,input.scope.tenantId,input.scope.taskId,input.scope.runId);
  const binding=socialObject(job?.checkpoints['social.executor']?.payload),approved=socialObject(binding?.approvedContext);
  const supply=approved?.assetSupplyPlan as {shots?:SocialAssetSupplyAdapterContext['shot'][]}|undefined;
  const shot=supply?.shots?.find(value=>value.shotId===input.shotId);
  if(!shot)throw Error('studio_adoption_frozen_shot_missing');
  const proof=await input.readCanonicalEvidence({...input.scope,shotId:input.shotId});
  if(!proof)throw Error('studio_completed_receipt_missing');
  const adapter=createStudioReceiptAdoptionAdapter({...input,readCanonicalEvidence:async()=>proof});
  await adapter.execute({tenantId:input.scope.tenantId,taskId:input.scope.taskId,shot,baselineScene:{} as SocialAssetSupplyAdapterContext['baselineScene'],availableAssets:[],outputDirectory:''});
  const id=createHash('sha256').update(JSON.stringify({...input.scope,shotId:input.shotId})).digest('hex').slice(0,32),proofHash=socialRequestHash(proof);
  const prior=await input.dataStore.getById<Record<string,unknown>>(ADOPTIONS,id);
  if(prior){if(prior.proof_hash!==proofHash)throw Error('studio_adoption_receipt_conflict');return {id,proofHash,replayed:true};}
  const created=await input.dataStore.create(ADOPTIONS,{id,tenant_id:input.scope.tenantId,task_id:input.scope.taskId,run_id:input.scope.runId,job_id:input.scope.jobId,shot_id:input.shotId,proof_hash:proofHash,proof,created_at:new Date().toISOString()});
  if(!created)throw Error('studio_adoption_persistence_failed');
  const persisted=await input.dataStore.getById<Record<string,unknown>>(ADOPTIONS,id);
  if(!persisted||persisted.proof_hash!==proofHash||socialRequestHash(persisted.proof)!==proofHash)throw Error('studio_adoption_persistence_unconfirmed');
  return {id,proofHash,replayed:false};
}
export function createPersistedStudioReceiptAdoptionAdapter(input:{dataStore:DataStore;scope:StudioAdoptionScope}){
  return createStudioReceiptAdoptionAdapter({...input,readCanonicalEvidence:async scope=>{
    const rows=await input.dataStore.list<Record<string,unknown>>(ADOPTIONS,{where:{tenant_id:scope.tenantId,task_id:scope.taskId,run_id:scope.runId,job_id:scope.jobId,shot_id:scope.shotId},perPage:2});
    if(rows.totalItems===0)return null;
    if(rows.totalItems!==1)throw Error('studio_adoption_receipt_ambiguous');
    const row=rows.items[0],proof=row.proof as StudioCompletedAssetEvidence;
    if(!proof||row.proof_hash!==socialRequestHash(proof))throw Error('studio_adoption_receipt_corrupt');
    return proof;
  }});
}
