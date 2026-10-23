import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {recognizeProductImageLocally} from '../lib/localProductOcr.js';
import {inspectSensitiveScreenText} from './socialSceneSensitiveScreenAudit.js';
import {forEachDecodedPng} from './socialCaptionDecodedFrameAudit.js';
import type {CaptionDecodedFrameAudit} from './socialCaptionDecodedFrameAudit.js';

type FindingCode=ReturnType<typeof inspectSensitiveScreenText>[number];
export interface FinalSensitiveFrameAudit {
 schemaVersion:'final-sensitive-frame-audit.v1';
 status:'hit'|'not_observed'|'unknown';
 mediaSha256:string;expectedFrameCount:number;checkedFrameCount:number;
 findingFrameIndexes:number[];findingCodes:FindingCode[];
 frameEvidence:Array<{index:number;frameSha256:string;ocrSha256:string;findingCodes:FindingCode[]}>;
 reason:string;
}
export function hasKnownFinalSensitiveFrameFailure(value:unknown,mediaSha256:unknown):boolean{
 const audit=value as Partial<FinalSensitiveFrameAudit>|null;
 return audit?.schemaVersion==='final-sensitive-frame-audit.v1'
  &&(audit.mediaSha256!==mediaSha256||audit.status==='hit');
}
/** Reuse the same full-frame OCR pass already performed for captions. */
export function sensitiveFrameAuditFromCaption(value:CaptionDecodedFrameAudit,expectedMediaSha256:string,expectedFrameCount:number):FinalSensitiveFrameAudit|null{
 if(value.status!=='observed_all_decoded_frames'||value.mediaSha256!==expectedMediaSha256||value.decodedFrameCount!==expectedFrameCount||value.checkedFrameCount!==expectedFrameCount||value.frames.length!==expectedFrameCount||value.frames.some((frame,index)=>frame.index!==index))return null;
 const frameEvidence=value.frames.map(frame=>({index:frame.index,frameSha256:frame.frameSha256,ocrSha256:frame.ocrSha256,findingCodes:frame.findingCodes}));
 const findingFrameIndexes=frameEvidence.flatMap(frame=>frame.findingCodes.length?[frame.index]:[]),findingCodes=[...new Set(frameEvidence.flatMap(frame=>frame.findingCodes))].sort();
 return {schemaVersion:'final-sensitive-frame-audit.v1',status:findingFrameIndexes.length?'hit':'not_observed',mediaSha256:expectedMediaSha256,expectedFrameCount,checkedFrameCount:expectedFrameCount,findingFrameIndexes,findingCodes,frameEvidence,reason:findingFrameIndexes.length?'最终 MP4 完整解码帧 OCR 出现高置信敏感文字；原文不保存':'全部有界解码帧未观察到已知高置信敏感文字；不能证明全片隐私安全'};
}
async function sha(file:string){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
/** Exhaustive only for a short, independently counted final MP4. A clean OCR
 * result is not privacy clearance: OCR may miss text, faces and speech. */
export async function auditFinalSensitiveFrames(input:{filePath:string;expectedMediaSha256:string;expectedFrameCount:number;recognize?:typeof recognizeProductImageLocally}):Promise<FinalSensitiveFrameAudit>{
 const mediaSha256=await sha(input.filePath),expectedFrameCount=input.expectedFrameCount;
 const unknown=(reason:string,frameEvidence:FinalSensitiveFrameAudit['frameEvidence']=[]):FinalSensitiveFrameAudit=>({schemaVersion:'final-sensitive-frame-audit.v1',status:'unknown',mediaSha256,expectedFrameCount,checkedFrameCount:frameEvidence.length,findingFrameIndexes:[],findingCodes:[],frameEvidence,reason});
 if(mediaSha256!==input.expectedMediaSha256)return unknown('最终 MP4 字节与完整解码回执不一致');
 if(!Number.isSafeInteger(expectedFrameCount)||expectedFrameCount<1||expectedFrameCount>300)return unknown('逐帧敏感文字观察超出 300 帧限制');
 const frameEvidence:FinalSensitiveFrameAudit['frameEvidence']=[];
 try{
  const decoded=await forEachDecodedPng(input.filePath,async(bytes,index)=>{
   if(index>=expectedFrameCount)throw Error('privacy_frame_count_exceeded');
   const recognized=await (input.recognize??recognizeProductImageLocally)({bytes,mimeType:'image/png'});
   frameEvidence.push({index,frameSha256:createHash('sha256').update(bytes).digest('hex'),ocrSha256:createHash('sha256').update(recognized).digest('hex'),findingCodes:inspectSensitiveScreenText(recognized)});
  });
  if(decoded!==expectedFrameCount)return unknown('真实解码帧数与独立预期不一致',frameEvidence);
  if(await sha(input.filePath)!==mediaSha256)return unknown('逐帧 OCR 期间最终 MP4 字节变化',frameEvidence);
  const findingFrameIndexes=frameEvidence.flatMap(frame=>frame.findingCodes.length?[frame.index]:[]);
  const findingCodes=[...new Set(frameEvidence.flatMap(frame=>frame.findingCodes))].sort();
  return {schemaVersion:'final-sensitive-frame-audit.v1',status:findingFrameIndexes.length?'hit':'not_observed',mediaSha256,expectedFrameCount,checkedFrameCount:decoded,findingFrameIndexes,findingCodes,frameEvidence,reason:findingFrameIndexes.length?'最终 MP4 完整解码帧 OCR 出现高置信敏感文字；原文不保存':'全部有界解码帧未观察到已知高置信敏感文字；不能证明全片隐私安全'};
 }catch(error){return unknown(`最终 MP4 逐帧 OCR 未完成:${String(error)}`,frameEvidence);}
}
