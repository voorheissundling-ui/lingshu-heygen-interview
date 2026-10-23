import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import {SeedreamFirstFrameGenerator} from './seedreamFirstFrameGenerator.js';
import {firstFrameInputFingerprint,type FirstFrameRequest} from './firstFrameGenerator.js';
import {withPaidOperationLock} from './paidOperationLock.js';
import {evaluateStoryboardFirstFrameQuality} from './storyboardFirstFrameQualityEvaluation.js';
import {inspectStoryboardTechnicalFrames} from './storyboardAigcQuality.js';
import {inspectStoryboardAigcFramesWithQwen} from '../agents/qwen.js';
/** Trusted internal generation stage. Every irreversible boundary has durable local
 * evidence; an unknown Seedream submission may only be reconciled, never re-POSTed. */
export async function prepareTrustedStoryboardSeedream(input:{request:FirstFrameRequest;model:string;estimatedCostCny:number;root:string;productInfo:string;execute:boolean;qaModel?:string;beforeFrameSubmit?:(request:Record<string,unknown>)=>Promise<void>;beforeQaSubmit?:(request:Record<string,unknown>)=>Promise<void>},ports:{assertCurrent:()=>Promise<void>;reserve:(fingerprint:string)=>Promise<void>;reserveQa:(fingerprint:string)=>Promise<void>}){
const generator=new SeedreamFirstFrameGenerator({model:input.model,estimatedCostCny:input.estimatedCostCny,beforeSubmit:input.beforeFrameSubmit});
const fingerprint=firstFrameInputFingerprint(input.request,generator.provider,generator.model);
if(!input.execute)return{dryRun:true,fingerprint,model:generator.model,estimatedCostCny:input.estimatedCostCny};
fs.mkdirSync(input.root,{recursive:true,mode:0o700});
return withPaidOperationLock(path.join(input.root,'.locks'),fingerprint,async()=>{
 await ports.assertCurrent();const file=path.join(input.root,`${fingerprint}.json`),image=path.join(input.root,`${fingerprint}.png`);
 const write=(value:unknown)=>{const temp=`${file}.tmp`;fs.writeFileSync(temp,JSON.stringify(value,null,2),{mode:0o600});fs.renameSync(temp,file);};
 const prior=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
 let bytes:Buffer,providerRequestId:string;
 if(prior){if(prior.fingerprint!==fingerprint||!['generated','evaluated'].includes(prior.state)||!fs.existsSync(image))throw Error('seedream_unknown_requires_original_receipt_reconciliation');bytes=fs.readFileSync(image);if(createHash('sha256').update(bytes).digest('hex')!==prior.outputSha256)throw Error('seedream_original_bytes_changed');providerRequestId=prior.providerRequestId;if(prior.state==='evaluated')return prior;}
 else{await ports.reserveQa(fingerprint);await ports.reserve(fingerprint);await ports.assertCurrent();write({fingerprint,state:'prepared',model:generator.model,requestSha256:fingerprint});
  const generated=await generator.generate(input.request);bytes=generated.bytes;providerRequestId=generated.providerRequestId;fs.writeFileSync(image,bytes,{mode:0o600});write({fingerprint,state:'generated',model:generator.model,providerRequestId,outputSha256:createHash('sha256').update(bytes).digest('hex')});}
 const refs=input.request.references.filter(x=>x.role==='product_identity'||(input.request.referenceMode==='product_scene'&&x.role==='source_composition')).map((x,i)=>({base64:x.bytes.toString('base64'),mimeType:x.mimeType,timeLabel:x.role==='source_composition'?'原分镜构图':`企业产品原图${i+1}`}));
 await ports.assertCurrent();
 await ports.reserveQa(fingerprint);
 write({...prior,fingerprint,state:'qa_prepared',model:generator.model,providerRequestId,outputSha256:createHash('sha256').update(bytes).digest('hex')});
 let qaReceipt:unknown=null;
 const quality=await evaluateStoryboardFirstFrameQuality({sceneType:'product',hasProduct:true,hasNamedPerson:false,hasContact:true,hasAction:true,candidateLabels:['候选首帧'],referenceLabels:refs.map(x=>x.timeLabel),applyReplicationAutomation:true,
  inspectTechnical:()=>inspectStoryboardTechnicalFrames('first_frame',[{bytes,timeLabel:'候选首帧'}]),inspectVisual:()=>inspectStoryboardAigcFramesWithQwen({model:input.qaModel||process.env.QWEN_VL_MODEL,boundedPaidQa:true,paidSubmission:input.beforeQaSubmit,onReceipt:r=>{qaReceipt=r;fs.writeFileSync(`${file}.qa-provider.json`,JSON.stringify(r),{mode:0o600});},phase:'first_frame',sceneType:'product',frames:[{base64:bytes.toString('base64'),mimeType:'image/png',timeLabel:'候选首帧'}],productReferences:refs,storyboard:input.request.prompt,productInfo:input.productInfo})});
 const result={tenantId:input.request.tenantId,projectId:input.request.videoId,shotId:input.request.compositionId,sourceHashes:input.request.references.map(x=>x.sha256),fingerprint,state:'evaluated',model:generator.model,providerRequestId,outputSha256:createHash('sha256').update(bytes).digest('hex'),filePath:image,quality,canProceedToVideo:quality.canProceedToVideo,humanApproved:false,qaModel:input.qaModel||process.env.QWEN_VL_MODEL,qaProviderReceiptRef:`${file}.qa-provider.json`,qaReceipt};write(result);return result;
});
}
