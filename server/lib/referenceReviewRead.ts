import type {DataStore} from '../storage/datastore.js';
import {createExactShotMaterializationService} from './referenceExactShotMaterialization.js';
import {socialJson,socialObject,socialRequestHash,SocialContentWorkflowError} from '../starter198/socialContentValidation.js';
/** Derived read projection only. Catalog analysis, its hash and source version
 * remain unchanged; independent evidence must pass current source + file SHA. */
export async function readReferenceReviewRecord(store:DataStore,tenantId:string,record:Record<string,unknown>,options:{mediaRoot?:string}={}):Promise<Record<string,unknown>>{
 if(record.tenantId!==tenantId||typeof record.id!=='string')throw new SocialContentWorkflowError('reference_shot_source_not_owned',404);
 const analysis=socialObject(socialJson(record.aiAnalysis));
 if(!analysis||analysis.analysisMode!=='exact'||typeof analysis.contentSha256!=='string'||typeof analysis.analysisRunId!=='string')return record;
 try{
  const verified=await createExactShotMaterializationService(store,options).readVerifiedAnalysis({tenantId,recordId:record.id,expectedSourceSha256:analysis.contentSha256,expectedAnalysisRunId:analysis.analysisRunId,expectedAnalysisHash:socialRequestHash(analysis)});
  return verified?{...record,aiAnalysis:typeof record.aiAnalysis==='string'?JSON.stringify(verified):verified}:record;
 }catch(error){
  // Missing/corrupt/stale local evidence never becomes ready during a GET.
  // Unexpected storage failures still surface rather than inventing readiness.
  if(error instanceof SocialContentWorkflowError)return record;
  throw error;
 }
}
