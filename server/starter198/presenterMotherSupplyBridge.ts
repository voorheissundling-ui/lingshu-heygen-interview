import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {mkdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import ffmpegStatic from 'ffmpeg-static';
import type {FrozenPresenterMotherSegments} from '../../shared/contracts/presenterMotherSegments.js';
import type {SocialProductionAsset} from './socialContentProductionPlan.js';
import {executePresenterMotherSegments,type PresenterMotherExecutionResult,type PresenterMotherProviderRequest,type PresenterMotherProviderResult,type PresenterSlotCropReceipt} from './presenterMotherSegmentExecution.js';
import type {SocialAssetSupplyProviderAdapter} from './socialContentAssetSupplyExecution.js';

export interface PresenterMotherCropRequest {sourcePath:string;targetPath:string;crop:PresenterSlotCropReceipt}
export type PresenterMotherCropper=(request:PresenterMotherCropRequest)=>Promise<{localPath:string;sha256:string}>;

const run=promisify(execFile);
export async function materializePresenterMotherCropFfmpeg(request:PresenterMotherCropRequest){
 if(!ffmpegStatic)throw Error('presenter_mother_ffmpeg_missing');await mkdir(path.dirname(request.targetPath),{recursive:true});
 await run(String(ffmpegStatic),['-hide_banner','-loglevel','error','-nostdin','-ss',request.crop.cropStartSeconds.toFixed(3),'-i',request.sourcePath,'-t',request.crop.durationSeconds.toFixed(3),'-map','0:v:0','-map','0:a?','-c:v','libx264','-preset','veryfast','-crf','20','-c:a','aac','-movflags','+faststart','-y',request.targetPath],{timeout:120_000});
 const bytes=await readFile(request.targetPath);if(!bytes.length)throw Error(`presenter_mother_crop_empty:${request.crop.slotId}`);return{localPath:request.targetPath,sha256:createHash('sha256').update(bytes).digest('hex')};
}

/** Prepares a group-aware adapter without registering or calling any paid
 * implementation itself. The injected provider runs once per mother group;
 * all scene adapter results are immutable local crops of those outputs. */
export async function preparePresenterMotherSupply(input:{
 grouping:FrozenPresenterMotherSegments;
 outputDirectory:string;
 provider:(request:PresenterMotherProviderRequest)=>Promise<PresenterMotherProviderResult>;
 cropper?:PresenterMotherCropper;
}):Promise<{presenterMotherExecution:PresenterMotherExecutionResult;assets:SocialProductionAsset[];adapter:SocialAssetSupplyProviderAdapter}> {
 await mkdir(input.outputDirectory,{recursive:true});const presenterMotherExecution=await executePresenterMotherSegments({grouping:input.grouping,provider:input.provider}),cropper=input.cropper??materializePresenterMotherCropFfmpeg,assets:SocialProductionAsset[]=[];
 const providers=new Map(presenterMotherExecution.providerReceipts.map(receipt=>[receipt.segmentId,receipt]));
 for(const crop of presenterMotherExecution.slotCropReceipts){const provider=providers.get(crop.segmentId);if(!provider)throw Error(`presenter_mother_bridge_parent_missing:${crop.slotId}`);const sourceBytes=await readFile(provider.outputRef);if(createHash('sha256').update(sourceBytes).digest('hex')!==provider.outputSha256)throw Error(`presenter_mother_bridge_provider_bytes_changed:${crop.slotId}`);
  const target=path.join(input.outputDirectory,`${crop.receiptHash}.mp4`),materialized=await cropper({sourcePath:provider.outputRef,targetPath:target,crop}),bytes=await readFile(materialized.localPath);if(createHash('sha256').update(bytes).digest('hex')!==materialized.sha256)throw Error(`presenter_mother_bridge_crop_bytes_changed:${crop.slotId}`);
  assets.push({id:`presenter-mother-crop-${crop.receiptHash.slice(0,24)}`,name:`${crop.slotId} presenter crop`,type:'video',sourceId:crop.slotId,url:materialized.localPath,localPath:materialized.localPath,contentHash:materialized.sha256,authorizationRef:`presenter-mother:${presenterMotherExecution.groupingHash}`,providerId:provider.providerId,providerTaskId:provider.providerReceiptRef,idempotencyKey:crop.receiptHash,duration:crop.durationSeconds,visualObservations:['已由冻结口播母段按逐槽时间范围本地裁切'],segments:[{start:0,end:crop.durationSeconds,segmentId:crop.segmentId,segmentHash:crop.segmentHash,slotCropReceiptHash:crop.receiptHash}],selectionOrigin:'task'});
 }
 const byScene=new Map(presenterMotherExecution.slotCropReceipts.map((crop,index)=>[crop.slotId,{crop,asset:assets[index]!}]));
 const adapter:SocialAssetSupplyProviderAdapter={adapterId:'presenter_mother_segment.v1',sourceStrategies:['authorized_digital_presenter'],async execute(context){const found=byScene.get(context.baselineScene.sceneId);if(!found)return null;return{asset:structuredClone(found.asset),sourceStrategy:'authorized_digital_presenter',providerId:'presenter_mother_segment.v1',sourceRef:`presenter-mother-crop:${found.crop.receiptHash}`,synthetic:true,representation:'non_evidentiary_visual',authorizationRef:found.asset.authorizationRef??null,disclosure:'由已授权数字人口播母段本地裁切'};}};
 return{presenterMotherExecution,assets,adapter};
}
