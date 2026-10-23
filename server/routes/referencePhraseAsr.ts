import {readExistingReferenceNarration,resumeExistingReferenceNarration} from '../lib/referenceNarrationRecovery.js';
import {readReferenceNarrationAdmission} from '../lib/referenceNarrationAdmission.js';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import type {RequestHandler} from 'express';
import type {Record_} from '../storage/datastore.js';
import type {AuthLocals} from '../middleware/auth.js';
import {readCachedReferenceNarration,prepareReferenceNarration} from '../lib/referenceNarration.js';
import {socialJson,socialObject,socialRequestHash} from '../starter198/socialContentValidation.js';
interface Ports {
 readRecord:(id:string)=>Promise<Record_|null>;
 localPath:(fileId:string,tenantId:string)=>string|null;
 exists:(path:string)=>boolean;
 probe:(path:string)=>Promise<{duration:number}>;
 prepare:typeof prepareReferenceNarration;
 readCache:typeof readCachedReferenceNarration;
 admission?:(tenantId?:string)=>ReturnType<typeof readReferenceNarrationAdmission>;
 readExisting?:typeof readExistingReferenceNarration;
 resumeExisting?:typeof resumeExistingReferenceNarration;
}
export function createReferencePhraseAsrHandler(ports:Ports):RequestHandler{return async(req,res)=>{
 const {tenantId}=res.locals as AuthLocals;
 if(typeof tenantId!=='string'||!tenantId.trim()){res.status(401).json({error:'Unauthorized'});return;}
 const record=await ports.readRecord(String(req.params.id));
 if(!record||record.id!==String(req.params.id)||record.tenantId!==tenantId){res.status(404).json({error:'Not found'});return;}
 res.setHeader('Cache-Control','private, no-store');
 const analysis=socialObject(socialJson(record.aiAnalysis))??{};
 const videoPath=ports.localPath(String(record.videoFileId||''),tenantId);
 if(!videoPath||!ports.exists(videoPath)){res.status(422).json({error:'本地原片不可用'});return;}
 try{
  const sourceHash=createHash('sha256').update(fs.readFileSync(videoPath)).digest('hex');
  const analysisHash=socialRequestHash(analysis);
  if(typeof analysis.analysisRunId!=='string'||!analysis.analysisRunId||typeof analysis.contentSha256!=='string'||!/^[a-f0-9]{64}$/.test(analysis.contentSha256)||sourceHash!==analysis.contentSha256){res.status(409).json({error:'原片与分析版本已变化，请重新核对后补证'});return;}
  const admission=ports.admission?ports.admission(tenantId):readReferenceNarrationAdmission(undefined,tenantId);
  const scope={tenantId,filePath:videoPath,expectedSourceSha256:sourceHash};
  const freshSource=async()=>{const fresh=await ports.readRecord(String(req.params.id));const freshAnalysis=socialObject(socialJson(fresh?.aiAnalysis));return !!fresh&&fresh.id===record.id&&fresh.tenantId===tenantId&&fresh.videoFileId===record.videoFileId&&!!freshAnalysis&&socialRequestHash(freshAnalysis)===analysisHash&&ports.exists(videoPath)&&createHash('sha256').update(fs.readFileSync(videoPath)).digest('hex')===sourceHash;};
  const rejectDrift=async()=>{if(await freshSource())return false;res.status(409).json({error:'原片或分析版本在读取期间发生变化，请重新加载'});return true;};
  const existing=(ports.readExisting??readExistingReferenceNarration)(scope);
  const existingTaskId=existing?.record.taskId??null;
  let result;
  if(req.body?.action!==undefined&&req.body.action!=='refresh_existing'){res.status(400).json({error:'原识别任务操作无效'});return;}
  if(req.body?.action==='refresh_existing'){
   if(req.body.confirmed!==false||typeof req.body.expectedTaskId!=='string'||!existingTaskId||req.body.expectedTaskId!==existingTaskId||!['PENDING','RUNNING','SUCCEEDED'].includes(existing!.status)){res.status(409).json({error:'原识别任务身份或状态不一致，请重新读取；未创建新任务'});return;}
   if(await rejectDrift())return;
   const resumed=await (ports.resumeExisting??resumeExistingReferenceNarration)({...scope,expectedTaskId:existingTaskId});
   if(await rejectDrift())return;
   if(!resumed.result){res.json({...admission,ok:true,status:resumed.status,taskId:resumed.taskId,existingTaskId:resumed.taskId,enabled:false,analysisRunId:analysis.analysisRunId,sourceSha256:sourceHash,candidateLines:[]});return;}
   result=resumed.result;
  }else if(req.body?.confirmed!==true){
   result=ports.readCache(videoPath,tenantId);
   if(!result){if(await rejectDrift())return;res.json({...admission,ok:true,status:existing?.status??'not_found',taskId:existingTaskId,existingTaskId,enabled:false,analysisRunId:analysis.analysisRunId,sourceSha256:sourceHash,candidateLines:[]});return;}
  }else{
   if(existing){res.status(409).json({...admission,ok:false,status:existing.status,existingTaskId,error:'已有原识别记录，请查询原任务；未重新提交'});return;}
   if(!admission.canSubmit){res.status(422).json({...admission,ok:false,status:'unavailable',error:admission.budgetReason});return;}
   const clock=await ports.probe(videoPath);
   if(await rejectDrift())return;
   result=await ports.prepare(videoPath,clock.duration,{tenantId,manualSubmission:true});
  }
  if(await rejectDrift())return;
  if(result.sourceVideoSha256!==analysis.contentSha256){res.status(409).json({error:'原片与分析版本已变化，请重新核对后补证'});return;}
  res.json({...admission,ok:true,status:'SUCCEEDED',taskId:result.taskId,existingTaskId:result.taskId??existingTaskId,enabled:true,analysisRunId:analysis.analysisRunId,sourceSha256:analysis.contentSha256,transcript:result.text,candidateLines:result.segments.map((segment:{text:string;start:number;end:number;words:unknown})=>({text:segment.text,start:segment.start,end:segment.end,words:segment.words,precision:'phrase',provenance:result.provenance,visibility:'unknown'}))});
 }catch(error){res.status(422).json({ok:false,status:'unavailable',error:error instanceof Error?error.message:'词级对齐不可用'});}
};}
