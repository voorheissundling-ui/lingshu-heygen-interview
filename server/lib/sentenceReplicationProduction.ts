import { extractSentenceFirstFrames } from './sentenceFirstFramePipeline.js';
import { preparePhotoTalkingFirstFrames } from './photoTalkingFirstFrames.js';
import { sentenceVideoInputFingerprint } from '../../shared/contracts/sentenceReplicationImpact.js';
import { studioPaidBudget } from './studioPaidBudget.js';
import { generateHeyGenPhotoVideo } from './heygenPhotoVideo.js';
import { createHash, randomUUID } from 'node:crypto'; import fs from 'node:fs'; import path from 'node:path'; import { execFile } from 'node:child_process'; import { promisify } from 'node:util'; import ffmpegStatic from 'ffmpeg-static';
import { generateSeedanceSentenceVideo } from './seedanceImageVideo.js'; import { runSentenceReplicationPipeline } from './sentenceReplicationPipeline.js';
import { readLocalMaterials, saveLocalMaterials, updateLocalMaterial, type MaterialRecord } from './materialLibrary.js'; import { tenantAssetDir, tenantAssetRelativePath } from './assetAccess.js'; import { materialAssetContentType, materialAssetObjectKey } from '../storage/materialAssets.js'; import { objectStorageDownload, objectStorageHead, objectStorageSignedGetUrl, objectStorageSupplierDeliveryReady, objectStorageUpload } from '../storage/objectStorage.js';
import { sentenceReplicationReadiness } from '../runtime/readiness.js';
import type { PresenterAsset, ShotProduction } from '../../src/lib/shotProduction.js'; import type { DigitalHumanReferenceCue, SentenceCueQuality, SentenceReplicationResult } from '../../src/lib/digitalHumanPlan.js';
import { acceptPresenterPortraitReference } from './presenterAssetAcceptance.js';
import { type FirstFrameReference } from './firstFrameGenerator.js';
import { clusterSourceFirstFrameMaterialId, planPersonShotClusters } from '../../src/lib/personShotClustering.js';
import { checkAvatarMedia } from './avatarMediaCheck.js';
import { inspectPersonReplacementPair } from './personReplacementMediaQuality.js';
import { inspectPersonReplacementVisualPair } from './personReplacementVisualQuality.js';
import { sentenceCueQualityFromEvidence } from './sentenceCueQuality.js';
import { inspectSentenceSemanticQuality } from './sentenceSemanticQuality.js';
import { inspectSentenceLipSyncQuality } from './sentenceLipSyncQuality.js';
import { validatePresenterRightsEvidence } from './presenterAssetTrust.js';
import { photoTalkingBudget } from './photoTalkingBudget.js';
import { assertPersonCueShotBoundaries, assertSeedanceCueDurations, assertSplitCueAssignments, hardSceneCutTimes } from './sentenceCueSceneCuts.js';
import { planSeedanceReplication, seedanceTalkingHeadPrompt } from './seedanceReplicationPlan.js';
import { seedanceImageFirstFrameInput, seedanceTrustedAssetForMaterial, type SeedanceTrustedAsset } from './seedanceTrustedAsset.js';
import { VolcengineArkAssets } from './volcengineArkAssets.js';
import { inspectFirstFrameBackgroundFidelity } from './firstFrameBackgroundFidelity.js';
import { PIPELINE3_FIRST_FRAME_PROMPT_VERSION } from './pipeline3FirstFramePrompt.js';

const MEDIA_ROOT = path.resolve(process.cwd(), 'data/media');
const run = promisify(execFile);
export async function readTenantMaterialBytes(material: MaterialRecord, tenantId: string): Promise<{ bytes: Buffer; mimeType: string }> { if (material.scope !== 'shared' && String(material.tenantId || material.tenant_id || '') !== tenantId) throw new Error('逐句素材不属于当前企业'); if (material.file) { const file = path.resolve(MEDIA_ROOT, String(material.file)); if (file.startsWith(path.resolve(MEDIA_ROOT)) && fs.existsSync(file)) return { bytes: fs.readFileSync(file), mimeType: materialAssetContentType(file) }; } if (material.objectKey) { const object = await objectStorageDownload(String(material.objectKey)); if (object) return { bytes: object.buf, mimeType: object.contentType }; } throw new Error(`素材 ${material.id} 没有可读取文件`); }
function stableId(prefix: string, requestId: string, cueId = '') { return `${prefix}-${createHash('sha256').update(`${requestId}:${cueId}`).digest('hex').slice(0,24)}`; }
function persistMaterial(material: MaterialRecord) { const current = readLocalMaterials(); saveLocalMaterials([...current.filter(item => item.id !== material.id), material]); }
export async function certifySeedanceTargetFrame(input: { presenter: PresenterAsset; material: MaterialRecord; objectKey: string }) {
  const certification = input.presenter.arkCertification;
  if (!certification || certification.status !== 'active' || !certification.projectName || !certification.groupId) throw new Error('当前人物缺少 Active 方舟真人认证，无法认证目标首帧');
  const assets = new VolcengineArkAssets(); const name = `pipeline3-${String(input.material.id).replace(/^target-frame-/, '').slice(0,24)}`;
  let asset = await assets.findImageByName(certification.projectName, certification.groupId, name);
  if (!asset) {
    const url = await objectStorageSignedGetUrl(input.objectKey, 3600);
    try { const id = await assets.createImage(certification.projectName, certification.groupId, url, name); asset = await assets.getAsset(certification.projectName, id); }
    catch (error) { asset = await assets.findImageByName(certification.projectName, certification.groupId, name); if (!asset) throw error; }
  }
  for (let attempt = 0; asset.Status === 'Processing' && attempt < 24; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5_000)); asset = await assets.getAsset(certification.projectName, asset.Id);
  }
  if (asset.Status !== 'Active') throw new Error(`方舟目标首帧认证失败：${asset.Error?.Message || asset.Status}`);
  const trusted = { uri:`asset://${asset.Id}`, kind:'image' as const, status:'active' as const, provider:'volcengine_ark' as const };
  const certified: MaterialRecord = { ...input.material, seedanceTrustedAsset:trusted, seedanceTrustedAssetUri:trusted.uri, seedanceTrustedAssetKind:trusted.kind, seedanceTrustedAssetStatus:trusted.status, seedanceTrustedAssetProvider:trusted.provider, updatedAt:new Date().toISOString() };
  persistMaterial(certified); return certified;
}
export async function runProductionSentenceReplication(input: { tenantId: string; projectId: string; assemblyId: string; shotId: string; fingerprint: string; shot: ShotProduction; presenter: PresenterAsset; cues: DigitalHumanReferenceCue[]; requestId: string; maxCostCny?: number; targetLanguage?: string; sourceMaterial?: MaterialRecord; existingProviderTasks?: Record<string,string>; reuseCueMaterialIds?: Record<string,string>; reuseCueQuality?: SentenceCueQuality[]; prepareMotionGuide?: (value: { tenantId: string; projectId: string; shotId: string; cue: DigitalHumanReferenceCue; sourceVideoPath: string }) => Promise<{ url: string; identityRemoved: true; motionOnly: true }>; onProviderTaskSubmitted?: (cueId:string,taskId:string)=>Promise<void> }): Promise<SentenceReplicationResult> {
  const photoTalking = input.shot.digitalHuman?.presenterMode === 'photo_talking';
  const readiness = sentenceReplicationReadiness(process.env, photoTalking ? 'heygen' : 'seedance');
  if (photoTalking) { const rights = validatePresenterRightsEvidence(input.presenter.rightsEvidence, {provider: 'heygen', uses: ['digital_presenter', 'voice_synthesis']}); if (!rights.ok) throw new Error(`HeyGen人物授权未完成：${rights.reasons.join('、')}`); if (!input.presenter.voiceId) throw new Error('请选择 HeyGen 口播声音'); }
  if (!readiness.ready) throw new Error(readiness.reason);
  if (input.cues.some(cue=>cue.personShot!==false && !cue.sourceFirstFrame?.materialId)) {
    const referenceMaterialId=String(input.sourceMaterial?.id || input.shot.digitalHuman?.reference?.materialId || '');
    input.cues=await extractSentenceFirstFrames({tenantId:input.tenantId,referenceMaterialId,cues:input.cues,sourceMaterial:input.sourceMaterial});
  }
  assertSplitCueAssignments(input.cues);
  if (!photoTalking) assertSeedanceCueDurations(input.cues);
  if (!photoTalking && !objectStorageSupplierDeliveryReady()) throw new Error('本地系统存储已启用，但 Seedance 无法访问 localhost；真实出片需生产 COS 签名地址或显式配置 HTTPS 开发地址');
  const materials = readLocalMaterials(); const byId = new Map(materials.map(item => [String(item.id), item])); if (input.sourceMaterial) byId.set(String(input.sourceMaterial.id), input.sourceMaterial); const presenterIds = [...new Set([...(input.presenter.toolMappings?.seedance?.referenceMaterialIds || []), ...(input.presenter.toolMappings?.sd?.referenceMaterialIds || []), ...(input.presenter.toolMappings?.runway?.referenceMaterialIds || []), ...(input.presenter.referenceMaterialIds || [])])];
  if (!presenterIds.length) throw new Error('企业人物缺少可用于首帧重建的参考图片');
  let presenterReference: FirstFrameReference | null = null; let presenterTrustedAsset: SeedanceTrustedAsset | undefined; for (const id of presenterIds) { const material = byId.get(id); if (!material || material.type !== 'image') continue;
    // Fail closed before any portrait bytes are read or sent to an external model.
    if (photoTalking) acceptPresenterPortraitReference({ tenantId: input.tenantId, presenter: input.presenter, material, provider: 'heygen', uses: ['digital_presenter', 'voice_synthesis'] });
    else acceptPresenterPortraitReference({ tenantId: input.tenantId, presenter: input.presenter, material, provider: 'volcengine_ark', uses: ['digital_presenter', 'person_replacement'] });
    const loaded = await readTenantMaterialBytes(material,input.tenantId); presenterReference = { role: 'authorized_presenter', bytes: loaded.bytes,
      mimeType: /png/i.test(loaded.mimeType) ? 'image/png' : /webp/i.test(loaded.mimeType) ? 'image/webp' : 'image/jpeg',
      sha256: createHash('sha256').update(loaded.bytes).digest('hex') }; presenterTrustedAsset = seedanceTrustedAssetForMaterial(material); if (photoTalking || presenterTrustedAsset) break; }
  if (!presenterReference) throw new Error('企业人物没有可读取的参考图片；视频参考不能代替首帧身份图');
  if (!photoTalking && !presenterTrustedAsset) throw new Error('Seedance 真人生成需要当前企业人物绑定状态为 Active 的方舟图片资产');
  let seedanceVoiceReferenceUrl = '';
  const arkVoice = input.presenter.toolMappings?.volcengineArk;
  if (!photoTalking && arkVoice?.referenceAudioMaterialId) {
    const rights = validatePresenterRightsEvidence(input.presenter.rightsEvidence, { provider: 'volcengine_ark', uses: ['voice_synthesis'] });
    if (!rights.ok) throw new Error(`方舟音色使用授权未完成：${rights.reasons.join('、')}`);
    const voiceMaterial = byId.get(arkVoice.referenceAudioMaterialId);
    if (!voiceMaterial || voiceMaterial.type !== 'audio' || !voiceMaterial.objectKey) throw new Error('本人音色参考素材不存在或尚未安全入库');
    await readTenantMaterialBytes(voiceMaterial, input.tenantId);
    seedanceVoiceReferenceUrl = await objectStorageSignedGetUrl(String(voiceMaterial.objectKey), 900);
  }
  const maxFrames = Math.max(1, Number(process.env.DIGITAL_HUMAN_MAX_FIRST_FRAMES_PER_VIDEO) || 3);
  const clusterPlan = planPersonShotClusters(input.cues,maxFrames); if(clusterPlan.state!=='ready') throw new Error(clusterPlan.blockers.join('；'));
  const needsTargetFrame=(cue:DigitalHumanReferenceCue)=>{
    if(cue.personShot===false || input.reuseCueMaterialIds?.[cue.id]) return false;
    const material=byId.get(String(cue.targetFirstFrame?.materialId||''));
    const cluster=clusterPlan.clusters.find(cluster=>cluster.cueIds.includes(cue.id));
    return !cluster || cue.targetFirstFrame?.state!=='ready' || material?.sourceType!=='digital-human-target-first-frame'
      || material.presenterAssetId!==input.presenter.id || Number(material.presenterAssetVersion)!==(input.presenter.assetVersion||1)
      || material.sourceFrameMaterialId!==clusterSourceFirstFrameMaterialId(cluster,input.cues)
      || (!photoTalking && !seedanceTrustedAssetForMaterial(material));
  };
  const pendingFrameClusters=clusterPlan.clusters.filter(cluster=>input.cues.some(cue=>cluster.cueIds.includes(cue.id)&&needsTargetFrame(cue)));
  const photoQuote = photoTalking ? photoTalkingBudget({tenantId:input.tenantId,cues:input.cues,frameCount:pendingFrameClusters.length,fixedHeygenReserveCny:Number(process.env.STUDIO_HEYGEN_RESERVE_CNY)}) : null;
  if (photoQuote) for (const cue of input.cues) if (cue.personShot !== false && !input.existingProviderTasks?.[cue.id] && !input.reuseCueMaterialIds?.[cue.id]) {
    const budget = studioPaidBudget.status('heygen', photoQuote.heygenByCue[cue.id], input.tenantId); if (!budget.allowed) throw new Error(budget.reason);
  }
  if (photoTalking) {
    if (!Number.isFinite(input.maxCostCny) || !(input.maxCostCny! > 0)) throw new Error('请填写本次照片口播费用上限');
    const pendingCount = input.cues.filter(cue => cue.personShot !== false && !input.reuseCueMaterialIds?.[cue.id] && !input.existingProviderTasks?.[cue.id]).length;
    if (pendingCount) {
      const estimated = (photoQuote?.firstFrameCny || 0) + input.cues.filter(cue => cue.personShot !== false && !input.reuseCueMaterialIds?.[cue.id] && !input.existingProviderTasks?.[cue.id]).reduce((sum,cue)=>sum+(photoQuote?.heygenByCue[cue.id]||0),0);
      if (!Number.isFinite(estimated) || estimated <= 0) throw new Error('HeyGen 与 Seedream 合计费用无法预估，未调用供应商');
      if (estimated > input.maxCostCny!) throw new Error(`照片口播预估 ¥${estimated.toFixed(2)} 超过本次 ¥${input.maxCostCny!.toFixed(2)} 上限，未调用供应商`);
    }
  }
  const resolution = process.env.SEEDANCE_SENTENCE_RESOLUTION === '480p' ? '480p' as const : '720p' as const;
  const seedancePlan = !photoTalking ? planSeedanceReplication({
    cues: input.cues,
    reuseCueMaterialIds: input.reuseCueMaterialIds,
    compositionClusterIds: pendingFrameClusters.map(cluster=>cluster.fingerprint),
    resolution,
    firstFrameCostCny: Number(process.env.SEEDREAM_FIRST_FRAME_ESTIMATED_CNY) || .22,
  }) : null;
  if (!photoTalking && input.maxCostCny !== undefined) {
    if (!Number.isFinite(input.maxCostCny) || input.maxCostCny <= 0) throw new Error('逐句生成费用上限无效');
    const estimate = seedancePlan!.estimatedCostCny;
    if (estimate > input.maxCostCny) throw new Error(`逐句生成预估 ${estimate.toFixed(2)} 元，超过本次 ${input.maxCostCny.toFixed(2)} 元上限；未提交供应商`);
  }
  if (pendingFrameClusters.length) {
    const reference=input.shot.digitalHuman?.reference;
    if (reference?.modelInputAuthorized!==true || !reference.modelInputAuthorizationEvidence?.trim()) throw new Error('原片首帧缺少作为模型构图参考的授权依据，未调用供应商');
    const prepared=await preparePhotoTalkingFirstFrames({tenantId:input.tenantId,projectId:input.projectId,assemblyId:input.assemblyId,presenter:input.presenter,cues:input.cues,certifyForSeedance:!photoTalking,requirements:input.shot.digitalHuman});
    input.cues=prepared.cues;
    for(const material of readLocalMaterials()) byId.set(String(material.id),material);
  }
  // Every target frame, including a previously certified/reused one, must pass
  // background locking before a paid video task can be submitted.
  const verifiedBackgroundPairs = new Set<string>();
  for (const cue of input.cues) {
    if (cue.personShot === false || input.reuseCueMaterialIds?.[cue.id]) continue;
    const sourceFrame = byId.get(String(cue.sourceFirstFrame?.materialId || ''));
    const targetFrame = readLocalMaterials().find(item=>String(item.id)===String(cue.targetFirstFrame?.materialId||''))
      || byId.get(String(cue.targetFirstFrame?.materialId || ''));
    if (!sourceFrame || !targetFrame) throw new Error(`镜头 ${cue.id} 缺少背景锁定检查所需首帧`);
    const pair=`${sourceFrame.id}:${targetFrame.id}`; if(verifiedBackgroundPairs.has(pair)) continue;
    const [sourceBytes,targetBytes]=await Promise.all([readTenantMaterialBytes(sourceFrame,input.tenantId),readTenantMaterialBytes(targetFrame,input.tenantId)]);
    const background=await inspectFirstFrameBackgroundFidelity(sourceBytes.bytes,targetBytes.bytes);
    if(!background.passed) throw new Error(`镜头 ${cue.id} 的目标首帧背景偏离原片：${background.evidence}；已阻止付费视频生成`);
    verifiedBackgroundPairs.add(pair);
  }
  const clusterByCue = new Map(clusterPlan.clusters.flatMap(cluster=>cluster.cueIds.map(cueId=>[cueId,cluster] as const)));
  const work = path.join(tenantAssetDir(MEDIA_ROOT,input.tenantId),`.sentence-${createHash('sha256').update(input.requestId).digest('hex').slice(0,16)}`); fs.mkdirSync(work,{recursive:true}); const providerTaskIds: string[] = []; const cueQuality=new Map((input.reuseCueQuality||[]).map(item=>[item.cueId,item]));
  const referenceMaterial=input.sourceMaterial || byId.get(String(input.shot.digitalHuman?.reference?.materialId||'')); if(!referenceMaterial||referenceMaterial.type!=='video')throw new Error('逐句质检缺少可读取的参考视频'); const referenceBytes=await readTenantMaterialBytes(referenceMaterial,input.tenantId); const referencePath=path.join(work,'reference-video'); fs.writeFileSync(referencePath,referenceBytes.bytes,{mode:0o600});
  const sourceSegmentFor=async(cue:DigitalHumanReferenceCue,duration=cue.end-cue.start)=>{const filePath=path.join(work,`reference-${createHash('sha256').update(cue.id).digest('hex').slice(0,12)}.mp4`); await run(String(ffmpegStatic||''),['-hide_banner','-loglevel','error','-nostdin','-ss',String(cue.start),'-i',referencePath,'-t',String(Math.min(duration,cue.end-cue.start)),'-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart','-y',filePath],{timeout:120_000}); return filePath;};
  try { assertPersonCueShotBoundaries(input.cues, await hardSceneCutTimes(String(ffmpegStatic || ''), referencePath));
    const result = await runSentenceReplicationPipeline({ cues: input.cues, outputPath:path.join(work,'joined.mp4'), ffmpegPath:String(ffmpegStatic || ''), useGeneratedDuration: true,
      reuseCompletedClip: async cue=>{ const materialId=String(input.reuseCueMaterialIds?.[cue.id]||''); if(!materialId) return null; const material=byId.get(materialId); if(!material || material.type!=='video') throw new Error(`已通过镜头 ${cue.id} 的复用素材不存在`); const loaded=await readTenantMaterialBytes(material,input.tenantId); if (!material.contentSha256 || createHash('sha256').update(loaded.bytes).digest('hex')!==material.contentSha256) throw new Error(`复用镜头 ${cue.id} 的内容已变化，自动校验未通过`); const filePath=path.join(work,`reuse-${createHash('sha256').update(`${cue.id}:${materialId}`).digest('hex').slice(0,16)}.mp4`); fs.writeFileSync(filePath,loaded.bytes,{mode:0o600}); return {materialId,filePath,url:String(material.url||''),...(Number(material.duration)>0?{duration:Number(material.duration)}:{}),inputFingerprint:sentenceVideoInputFingerprint(cue,{presenterId:input.presenter.id,presenterVersion:input.presenter.assetVersion,voiceId:input.presenter.voiceId,language:input.targetLanguage,narration:input.shot.narration,requirements:input.shot.digitalHuman})}; },
      createTargetFrame: async cue => {
        const material = byId.get(String(cue.targetFirstFrame?.materialId || ''));
        const cluster = clusterByCue.get(cue.id);
        if (!cluster || cue.targetFirstFrame?.state !== 'ready' || material?.sourceType !== 'digital-human-target-first-frame'
          || material.presenterAssetId !== input.presenter.id || material.sourceFrameMaterialId !== clusterSourceFirstFrameMaterialId(cluster,input.cues)
          || Number(material.presenterAssetVersion) !== (input.presenter.assetVersion || 1)) throw new Error('目标首帧自动版本校验失败');
        if (!photoTalking && !seedanceTrustedAssetForMaterial(material)) throw new Error('目标首帧尚未完成方舟认证，请重新准备目标首帧');
        const loaded = await readTenantMaterialBytes(material,input.tenantId);
        const filePath = path.join(work, `${material.id}.${/png/i.test(loaded.mimeType)?'png':/webp/i.test(loaded.mimeType)?'webp':'jpg'}`);
        fs.writeFileSync(filePath,loaded.bytes,{mode:0o600});
        return {materialId:String(material.id),filePath,url:photoTalking ? '' : await objectStorageSignedGetUrl(String(material.objectKey),900)};
      },
      createNonPersonClip: async cue => { const material=byId.get(String(cue.nonPersonMaterialId||'')); if(!material || material.type!=='video') throw new Error(`非人物镜头 ${cue.id} 的替换视频不存在或不可用`); const loaded=await readTenantMaterialBytes(material,input.tenantId); const id=stableId('non-person-clip',input.requestId,cue.id); const filePath=path.join(work,`${id}.mp4`); fs.writeFileSync(filePath,loaded.bytes,{mode:0o600}); return {materialId:String(material.id),filePath,url:String(material.url||'')}; },
      createSentenceVideo: async (cue,frame) => {
        const existingTaskId = input.existingProviderTasks?.[cue.id];
        // Certification persists an updated copy after the initial material index
        // was loaded. Prefer that live record so the same run can continue into
        // Seedance instead of falsely treating the freshly certified frame as stale.
        const targetFrameMaterial = readLocalMaterials().find(item => String(item.id) === frame.materialId) || byId.get(frame.materialId);
        const targetFrameTrustedAsset = targetFrameMaterial ? seedanceTrustedAssetForMaterial(targetFrameMaterial) : undefined;
        if (!photoTalking && !targetFrameTrustedAsset) throw new Error('Seedance 目标首帧尚未注册为 Active 方舟图片资产；不会退回使用原始人物证件照');
        const trustedFrame = targetFrameTrustedAsset ? seedanceImageFirstFrameInput(targetFrameTrustedAsset) : undefined;
        let qualitySourcePath: string | undefined; let motionGuide: { url: string; identityRemoved: true; motionOnly: true } | undefined;
        if (!photoTalking && !existingTaskId) {
          qualitySourcePath = await sourceSegmentFor(cue);
          if (!input.prepareMotionGuide) throw new Error('Seedance 动作复刻缺少去身份 motion-guide 预处理器；原片不会直接提交供应商');
          motionGuide = await input.prepareMotionGuide({ tenantId:input.tenantId, projectId:input.projectId, shotId:input.shotId, cue, sourceVideoPath:qualitySourcePath });
          if (!motionGuide?.identityRemoved || !motionGuide.motionOnly) throw new Error('Seedance motion-guide 预处理未证明已移除原人物身份；原片不会直接提交供应商');
        }
        const generated = photoTalking ? await generateHeyGenPhotoVideo({ tenantId: input.tenantId, bytes: fs.readFileSync(frame.filePath), mimeType: /\.png$/i.test(frame.filePath) ? 'image/png' : /\.webp$/i.test(frame.filePath) ? 'image/webp' : 'image/jpeg', voiceId: input.presenter.voiceId, script: cue.targetText || input.shot.narration, ratio: '9:16', requestId: `${input.tenantId}:${input.requestId}:${cue.id}`, existingTaskId, reserveCny: photoQuote!.heygenByCue[cue.id], onSubmitted: async taskId => { providerTaskIds.push(taskId); await input.onProviderTaskSubmitted?.(cue.id, taskId); } }) : await generateSeedanceSentenceVideo({apiKey:process.env.SEEDANCE_API_KEY||'',model:process.env.SEEDANCE_MODEL||'doubao-seedance-2-0-fast-260128',baseUrl:process.env.SEEDANCE_BASE_URL,imageUrl:trustedFrame!.url,trustedAssetKind:trustedFrame!.kind,referenceVideoUrl:motionGuide?.url,motionGuideAttested:Boolean(motionGuide?.identityRemoved&&motionGuide?.motionOnly),referenceAudioUrl:seedanceVoiceReferenceUrl||undefined,duration:Number(cue.generationDurationSeconds ?? (cue.end-cue.start)),ratio:'9:16',resolution,existingTaskId,prompt:seedanceTalkingHeadPrompt(cue.targetText || input.shot.narration, input.targetLanguage, { action: input.shot.digitalHuman?.action, scene: input.shot.digitalHuman?.scene, preserve: input.shot.digitalHuman?.preserve }),onSubmitted:async taskId=>{providerTaskIds.push(taskId);await input.onProviderTaskSubmitted?.(cue.id,taskId);}});
        if (existingTaskId) providerTaskIds.push(existingTaskId);
        const response=await fetch(generated.videoUrl,{signal:AbortSignal.timeout(90_000)}); if(!response.ok) throw new Error(`逐句视频下载失败：HTTP ${response.status}`);
        const bytes=Buffer.from(await response.arrayBuffer()); const id=stableId('sentence-video',input.requestId,cue.id); const filePath=path.join(work,`${id}.mp4`); fs.writeFileSync(filePath,bytes);
        const providerDuration = 'duration' in generated ? Number(generated.duration) : photoTalking
          ? cue.end - cue.start
          : Number(cue.generationDurationSeconds ?? (cue.end - cue.start));
        if (photoTalking && photoTalkingBudget({tenantId:input.tenantId,cues:[{...cue,end:cue.start+providerDuration}],frameCount:0,fixedHeygenReserveCny:Number(process.env.STUDIO_HEYGEN_RESERVE_CNY)}).heygenByCue[cue.id]! > photoQuote!.heygenByCue[cue.id]!) throw new Error('HeyGen 实际视频时长超过已预占费用，请核对供应商账单');
        const media=await checkAvatarMedia(filePath,{ratio:'9:16',duration:providerDuration,transparent:false,resolution}); const sourcePath=qualitySourcePath || await sourceSegmentFor(cue,photoTalking?media.duration:undefined);
        let technical=null; let technicalError=''; let visual=null; let visualError=''; let semantic=null; let semanticError=''; let lipSync=null; let lipSyncError='';
        try{technical=await inspectPersonReplacementPair(sourcePath,filePath);}catch(error){technicalError=error instanceof Error?error.message:String(error);}
        if(process.env.DIGITAL_HUMAN_VISUAL_QA_PYTHON){try{visual=await inspectPersonReplacementVisualPair(sourcePath,filePath);}catch(error){visualError=error instanceof Error?error.message:String(error);}}
        if(process.env.DIGITAL_HUMAN_SEMANTIC_QA_ENABLED==='true'){
          const semanticRights=validatePresenterRightsEvidence(input.presenter.rightsEvidence,{provider:'dashscope',uses:['quality_inspection']});
          if(!semanticRights.ok)semanticError=`未授权阿里云百炼进行人物质量检测：${semanticRights.reasons.join(',')}`;
          else try{semantic=await inspectSentenceSemanticQuality({presenterBytes:Buffer.from(presenterReference!.bytes),presenterMimeType:presenterReference!.mimeType,sourceVideoPath:sourcePath,candidateVideoPath:filePath,targetText:cue.targetText||input.shot.narration});}catch(error){semanticError=error instanceof Error?error.message:String(error);}
        }
        if(process.env.DIGITAL_HUMAN_SYNCNET_QA_ENABLED==='true'){
          try{lipSync=await inspectSentenceLipSyncQuality(filePath,{workDir:path.join(work,`syncnet-${createHash('sha256').update(cue.id).digest('hex').slice(0,12)}`)});}catch(error){lipSyncError=error instanceof Error?error.message:String(error);}
        }
        cueQuality.set(cue.id,sentenceCueQualityFromEvidence({automaticOnly:true,cueId:cue.id,mediaEvidence:`${media.width}x${media.height} · ${media.duration.toFixed(3)}s · audio=${media.hasAudio}`,technical,technicalError,visual,visualError,semantic,semanticError,lipSync,lipSyncError,
          motionComparable:Number(cue.outputDurationSeconds ?? (cue.end-cue.start)) >= 0.4}));
        const relative=tenantAssetRelativePath(input.tenantId,`${id}.mp4`); const stored=path.join(MEDIA_ROOT,relative); fs.mkdirSync(path.dirname(stored),{recursive:true}); fs.copyFileSync(filePath,stored);
        persistMaterial({id,name:`逐句数字人视频 · ${cue.targetText || cue.originalText}`.slice(0,100),folder:'presenter',type:'video',duration:media.duration,size:`${Math.ceil(bytes.length/1024)} KB`,file:relative,url:`/media/${relative}`,scope:'own',tenantId:input.tenantId,sourceType:'digital-human-sentence-video',providerTaskId:generated.taskId,contentSha256:createHash('sha256').update(bytes).digest('hex'),createdAt:new Date().toISOString()});
        return {materialId:id,filePath,url:`/media/${relative}`,duration:Number(cue.outputDurationSeconds ?? media.duration), inputFingerprint:sentenceVideoInputFingerprint({...cue,targetFirstFrame:{materialId:frame.materialId,state:'ready'}},{presenterId:input.presenter.id,presenterVersion:input.presenter.assetVersion,voiceId:input.presenter.voiceId,language:input.targetLanguage,narration:input.shot.narration,requirements:input.shot.digitalHuman})};
      } });
    for(const cue of result.cues.filter(item=>item.personShot===false)) cueQuality.set(cue.id,{cueId:cue.id,kind:'non_person_material',state:'accepted',checks:[{key:'media',status:'passed',evidence:`tenant material:${cue.nonPersonMaterialId}`},{key:'reuse_risk',status:'passed',evidence:'使用已选本企业素材，不复用未授权爆款原片'},...(['identity','motion','product_brand_text','background','audio_sync'] as const).map(key=>({key,status:'passed' as const,evidence:'非人物素材沿用企业素材验收'}))]});
    const expectedFinalDuration=result.cues.reduce((sum,cue)=>sum+(cue.generatedClip?.duration || cue.end-cue.start),0); const finalMedia=await checkAvatarMedia(result.outputPath,{ratio:'9:16',duration:expectedFinalDuration,transparent:false,resolution});
    const finalBytes=fs.readFileSync(result.outputPath); const id=stableId('viral-replication',input.requestId); const filename=`${id}.mp4`; const relative=tenantAssetRelativePath(input.tenantId,filename); const finalPath=path.join(MEDIA_ROOT,relative); fs.mkdirSync(path.dirname(finalPath),{recursive:true}); fs.copyFileSync(result.outputPath,finalPath); const key=materialAssetObjectKey(input.tenantId,filename); await objectStorageUpload({key,body:finalBytes,contentType:'video/mp4'}); const head=await objectStorageHead(key); if(!head?.etag) throw new Error('拼接候选上传后缺少对象版本'); const contentSha256=createHash('sha256').update(finalBytes).digest('hex'); const final:MaterialRecord={id,name:'爆款逐句复刻 · 数字人候选',folder:'presenter',type:'video',duration:finalMedia.duration,size:`${Math.ceil(finalBytes.length/1024)} KB`,file:relative,url:`/media/${relative}`,objectKey:key,objectEtag:head.etag,scope:'own',tenantId:input.tenantId,sourceType:'viral-sentence-replication',contentSha256,providerTaskIds,pipeline3Quality:{version:PIPELINE3_FIRST_FRAME_PROMPT_VERSION,backgroundLock:'passed_before_supplier_submission',automaticOnly:true},createdAt:new Date().toISOString()}; persistMaterial(final); const quality=[...cueQuality.values()];
    const accepted = quality.length > 0 && quality.every(item => item.state === 'accepted');
    updateLocalMaterial(id, input.tenantId, {
      generation: { pipelineId:'digital_human_3', assetGenerationKind:'digital_human', pipelineVersion:PIPELINE3_FIRST_FRAME_PROMPT_VERSION,
        executionId:input.requestId, provider:photoTalking?'heygen':'volcengine_ark', model:photoTalking?'photo_avatar':'seedance',
        providerTaskId:providerTaskIds.join(','), idempotencyKey:input.requestId, inputFingerprint:input.fingerprint,
        promptOrSpecHash:createHash('sha256').update(JSON.stringify({cues:input.cues,requirements:input.shot.digitalHuman})).digest('hex'),
        inputMaterialIds:Array.from(new Set([String(referenceMaterial.id),...input.cues.flatMap(cue=>[String(cue.sourceFirstFrame?.materialId||''),String(cue.targetFirstFrame?.materialId||''),String(cue.nonPersonMaterialId||'')]).filter(Boolean)])) },
      lineage:{sourceProjectId:input.projectId,sourceAssemblyId:input.assemblyId,sourceShotId:input.shotId},
      quality:{state:accepted?'accepted':'repair_required',policyVersion:'pipeline3-automatic-quality.v1',checkedAt:new Date().toISOString(),
        checks:quality.map(item=>({key:`cue:${item.cueId}`,status:item.state==='accepted'?'passed':'failed',evidence:item.checks.map(check=>check.evidence).filter(Boolean).join('；')||item.state})),rawReport:quality},
      reuse:{eligible:accepted,reason:accepted?'quality_accepted':'automatic_quality_failed',usageCount:0}, rightsScope:'tenant_generated_reusable', generationState:'archived',
    });
    return {cues:result.cues,materialId:id,candidateUrl:final.url,providerTaskIds,candidateOutput:{materialId:id,objectKey:key,contentSha256,objectEtag:head.etag},cueQuality:quality,failedCueIds:quality.filter(item=>item.state==='failed').map(item=>item.cueId),state:'completed'};
  } finally { fs.rmSync(work,{recursive:true,force:true}); }
}
