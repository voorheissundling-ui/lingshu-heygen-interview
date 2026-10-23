import fs from 'node:fs';
import path from 'node:path';
import { tenantAssetRelativePath } from './assetAccess.js';
import { createHash } from 'node:crypto';
import type { PresenterAsset } from '../../src/lib/shotProduction.js';
import type { DigitalHumanReferenceCue, DigitalHumanRequirements } from '../../src/lib/digitalHumanPlan.js';
import { planPersonShotClusters, clusterSourceFirstFrameMaterialId } from '../../src/lib/personShotClustering.js';
import { readLocalMaterials, saveLocalMaterials } from './materialLibrary.js';
import { acceptPresenterPortraitReference } from './presenterAssetAcceptance.js';
import { certifySeedanceTargetFrame, readTenantMaterialBytes } from './sentenceReplicationProduction.js';
import { SeedreamFirstFrameGenerator } from './seedreamFirstFrameGenerator.js';
import { firstFrameInputFingerprint, type FirstFrameReference } from './firstFrameGenerator.js';
import { produceFirstFrame } from './firstFrameProduction.js';
import { objectStorageHead, objectStorageSignedGetUrl, objectStorageDownload } from '../storage/objectStorage.js';
import { inspectFirstFrameBackgroundFidelity } from './firstFrameBackgroundFidelity.js';
import { pipeline3FirstFramePrompt, PIPELINE3_FIRST_FRAME_PROMPT_VERSION } from './pipeline3FirstFramePrompt.js';
export async function preparePhotoTalkingFirstFrames(input: {tenantId:string; projectId:string; assemblyId:string; presenter:PresenterAsset; cues:DigitalHumanReferenceCue[]; certifyForSeedance?:boolean;requirements?:DigitalHumanRequirements}) {
  const materials = readLocalMaterials(); const clusterPlan = planPersonShotClusters(input.cues, Math.max(1, Number(process.env.DIGITAL_HUMAN_MAX_FIRST_FRAMES_PER_VIDEO) || 3));
  if (clusterPlan.state !== 'ready') throw new Error(clusterPlan.blockers.join('；'));
  if (input.certifyForSeedance && (input.presenter.arkCertification?.status !== 'active' || !input.presenter.arkCertification.projectName || !input.presenter.arkCertification.groupId)) throw new Error('请先完成当前人物的方舟真人认证');
  const ids = [...(input.presenter.referenceMaterialIds || []), ...(input.presenter.toolMappings?.seedance?.referenceMaterialIds || [])];
  const portrait = materials.find(item => ids.includes(String(item.id)) && item.type === 'image' && (item.tenantId === input.tenantId || item.tenant_id === input.tenantId || item.scope === 'shared'));
  if (!portrait) throw new Error('请选择企业人物照片'); acceptPresenterPortraitReference({tenantId:input.tenantId,presenter:input.presenter,material:portrait,provider:'volcengine_ark',uses:['person_replacement']});
  const reference = async (material: typeof portrait, role: FirstFrameReference['role']): Promise<FirstFrameReference> => { const loaded = await readTenantMaterialBytes(material,input.tenantId); return {role,bytes:loaded.bytes,mimeType:/png/i.test(loaded.mimeType)?'image/png':/webp/i.test(loaded.mimeType)?'image/webp':'image/jpeg',sha256:createHash('sha256').update(loaded.bytes).digest('hex')}; };
  const identity = await reference(portrait,'authorized_presenter'); const generator = new SeedreamFirstFrameGenerator(); const frames = new Map<string,{materialId:string;imageUrl:string;state:'ready'}>();
  for (const cluster of clusterPlan.clusters) {
    const sourceId = clusterSourceFirstFrameMaterialId(cluster,input.cues); const source = materials.find(item=>item.id===sourceId); if(!source) throw new Error('请先提取爆款口播首帧');
    const request = {tenantId:input.tenantId,videoId:`${input.projectId}:${input.assemblyId}`,compositionId:cluster.fingerprint,presenterVersion:`${input.presenter.id}:${input.presenter.assetVersion||1}`,ratio:'9:16' as const,
      prompt:pipeline3FirstFramePrompt(input.requirements),references:[await reference(source,'source_composition'),identity],idempotencyKey:''};
    request.idempotencyKey=firstFrameInputFingerprint(request,generator.provider,generator.model); const output=await produceFirstFrame(request,generator); const head=await objectStorageHead(output.objectKey); if(!head?.etag) throw new Error('目标首帧存储校验失败');
    const generated=await objectStorageDownload(output.objectKey); if(!generated?.buf.length) throw new Error('目标首帧无法读取');
    const sourceBytes=await readTenantMaterialBytes(source,input.tenantId); const background=await inspectFirstFrameBackgroundFidelity(sourceBytes.bytes,generated.buf);
    if(!background.passed) throw new Error(`目标首帧背景偏离原片：${background.evidence}；已阻止视频生成`);
    const id=`target-frame-${output.operationId.slice(0,24)}`; let imageUrl=await objectStorageSignedGetUrl(output.objectKey,3600); let localFile='';
    if (imageUrl.startsWith('/media/object-storage/')) {
      localFile=tenantAssetRelativePath(input.tenantId,`${id}.${generated.contentType.includes('png')?'png':'jpg'}`);
      const target=path.resolve('data/media',localFile); fs.mkdirSync(path.dirname(target),{recursive:true}); fs.writeFileSync(target,generated.buf,{mode:0o600}); imageUrl=`/media/${localFile}`;
    }
    const latest=readLocalMaterials(); saveLocalMaterials([...latest.filter(item=>item.id!==id),{id,name:'照片口播目标首帧',type:'image',folder:'presenter',scope:'own',tenantId:input.tenantId,file:localFile,url:imageUrl,objectKey:output.objectKey,objectEtag:head.etag,contentSha256:output.contentSha256,size:'',duration:0,sourceType:'digital-human-target-first-frame',presenterAssetId:input.presenter.id,presenterAssetVersion:input.presenter.assetVersion||1,sourceFrameMaterialId:sourceId,providerModel:output.model,pipeline3Quality:{version:PIPELINE3_FIRST_FRAME_PROMPT_VERSION,backgroundLock:background},createdAt:new Date().toISOString()}]);
    if (input.certifyForSeedance) {
      const material = readLocalMaterials().find(item => item.id === id)!;
      await certifySeedanceTargetFrame({presenter:input.presenter, material, objectKey:output.objectKey});
    }
    for(const cueId of cluster.cueIds) frames.set(cueId,{materialId:id,imageUrl,state:'ready'});
  }
  return {cues:input.cues.map(cue=>frames.has(cue.id)?{...cue,targetFirstFrame:frames.get(cue.id)}:cue)};
}
