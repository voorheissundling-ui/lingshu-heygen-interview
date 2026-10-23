import {readGraphContextSnapshot} from './socialContentGraphContextSnapshots.js';
import {SocialContentTaskBudget} from '../lib/socialContentTaskBudget.js';
import {matchesAuthorizedCorrectionContext} from './socialContentProductionGraph.js';
import type {DataStore} from '../storage/datastore.js';
import {readContentExecutionJob} from '../contentExecution/durableQueue.js';
import {socialObject,socialRequestHash,socialText} from './socialContentValidation.js';
import type {SocialGraphApprovedContext} from './socialContentProductionExecution.js';
export interface CanonicalRuntimeMedia {providerTaskId:string;sha256:string}
/** Only removes new runtime candidates from the live planning view; never deletes the material. */
export function graphRuntimeInventoryVisible(item:Record<string,any>,input:{tenantId:string;taskId:string;admittedRefs:Set<string>;canonical:CanonicalRuntimeMedia[];freezeToAdmitted?:boolean}){
 if(input.admittedRefs.has(socialText(item.id)))return true;
 if(input.freezeToAdmitted)return false;
 const sourceTask=socialText(socialObject(item.lineage)?.sourceTaskId||item.sourceTaskId||item.taskId);
 if(sourceTask&&sourceTask!==input.taskId)return true;
 if(sourceTask===input.taskId)return false;
 const tenant=socialText(item.tenantId||item.tenant_id);
 return !(tenant===input.tenantId&&input.canonical.some(proof=>proof.providerTaskId===socialText(item.sourceExecutionId)&&proof.sha256===socialText(item.contentSha256)));
}
export async function readCanonicalGraphRuntimeMedia(input:{dataStore:DataStore;tenantId:string;taskId:string;runId:string;approvedContext:SocialGraphApprovedContext}):Promise<CanonicalRuntimeMedia[]>{
 const job=await readContentExecutionJob(input.dataStore,input.tenantId,input.taskId,input.runId);
 const binding=socialObject(job?.checkpoints['social.executor']?.payload);
 if(!job||binding?.executor!=='langgraph')throw Error('graph_runtime_inventory_binding_changed');
 if(socialRequestHash(readGraphContextSnapshot(binding))!==socialRequestHash(input.approvedContext)){
  const ledger=new SocialContentTaskBudget(undefined,{authorization:async()=>{throw Error('read_only')},quote:async()=>{throw Error('read_only')},assertCurrent:async()=>{},verifyRejection:async()=>false});
  const grant=ledger.status({tenantId:input.tenantId,taskId:input.taskId,runId:input.runId,planHash:String(binding.inputHash)})?.correctionAuthorization;
  if(!matchesAuthorizedCorrectionContext(job,input.approvedContext,String(binding.inputHash),grant?.recordHash))throw Error('graph_runtime_inventory_binding_changed');
 }
 const {createPersistedStudioReceiptAdoptionAdapter}=await import('./socialContentStudioAdoption.js');
 const adapter=createPersistedStudioReceiptAdoptionAdapter({dataStore:input.dataStore,scope:{tenantId:input.tenantId,taskId:input.taskId,runId:input.runId,jobId:job.id}}),proofs:CanonicalRuntimeMedia[]=[];
 for(const shot of input.approvedContext.assetSupplyPlan?.shots??[]){
  if(!['authorized_digital_presenter','aigc_product_scene_replication'].includes(shot.sourceStrategy))continue;
  const saved=await input.dataStore.list<any>('social_studio_asset_adoptions',{where:{tenant_id:input.tenantId,task_id:input.taskId,run_id:input.runId,job_id:job.id,shot_id:shot.shotId},perPage:2});
  if(saved.totalItems===0)continue;
  if(saved.totalItems!==1)throw Error('studio_adoption_receipt_ambiguous');
  try{const result=await adapter.execute({tenantId:input.tenantId,taskId:input.taskId,shot,baselineScene:{} as any,availableAssets:[],outputDirectory:''});
   if(result?.asset.providerTaskId&&result.asset.contentHash)proofs.push({providerTaskId:result.asset.providerTaskId,sha256:result.asset.contentHash});
  }catch(error){if(!(error instanceof Error)||error.message!=='user_input_required:studio_completed_receipt_missing')throw error;}
 }
 return proofs;
}
