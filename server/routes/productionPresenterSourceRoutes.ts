import { createHash } from 'node:crypto';
import type { Router } from 'express';
import { selectPresenterPortraitFrame } from '../lib/presenterPortraitFromVideo.js';
import { readTenantMaterialBytes } from '../lib/sentenceReplicationProduction.js';
import { readLocalMaterials, saveLocalMaterials } from '../lib/materialLibrary.js';
import { fetchCloudMaterial, getOwnedCloudMaterialRecord, updateCloudMaterial } from '../lib/cloudMaterials.js';
import { legacyAvatarSourceObjectKey, measureAvatarSourceCaptions } from '../lib/avatarSourceCaptions.js';
import { downloadHeygenSubtitles, heygenRequest } from '../integrations/heygen.js';
import { sourceCaptionCacheMatchesContent, sourceCuesForShot } from '../../src/lib/narrationTimeline.js';
import { materialAssetObjectKey } from '../storage/materialAssets.js';
import { objectStorageDownload, objectStorageHead, objectStorageSignedGetUrl, objectStorageSupplierDeliveryReady, objectStorageUpload } from '../storage/objectStorage.js';
import { studioPaidBudget } from '../lib/studioPaidBudget.js';
import { compareAndSwapStudioProject } from '../lib/studioProjectRevision.js';
import type { DataStore } from '../storage/datastore.js';
import type { ProductionDefaults, ShotProduction } from '../../src/lib/shotProduction.js';
import type { ExecutionStoreRecord, JobRecord, ProductionRouterOptions } from './productionContracts.js';
import type { createProductionRuntime, createProductionStoreRuntime } from './productionRuntime.js';

type PresenterSourceRuntime = Pick<ReturnType<typeof createProductionRuntime>, 'exclusive'>
  & Pick<ReturnType<typeof createProductionStoreRuntime>, 'readDefaults'>;

export function registerPresenterSourceRoutes(
  router: Router,
  store: DataStore,
  { exclusive, readDefaults }: PresenterSourceRuntime,
  options: ProductionRouterOptions,
): void {
  router.post('/avatar-source-captions', async (req, res) => {
    try {
      const tenantId = String(res.locals.tenantId || '');
      const { projectId, assemblyId, shotId, slotId, materialId } = req.body || {};
      if (![projectId, assemblyId, shotId, slotId, materialId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 180))
        throw new Error('数字人分镜与素材标识无效');
      const result = await exclusive(`avatar-source-captions:${tenantId}:${materialId}`, async () => {
        const project = await store.getById<any>('studio_projects', projectId);
        if (!project || project.tenant_id !== tenantId || project.status !== 'draft') throw new Error('创作草稿不存在或不可编辑');
        const assembly = (project.spec?.storyboardAssemblies || []).find((item: any) => item.id === assemblyId);
        const assignments = assemblyId === project.spec?.activeAssemblyId
          ? project.spec?.storyboardAssignments : assembly?.assignments;
        const shot = project.spec?.shotProductions?.[`${assemblyId}:${shotId}`] as ShotProduction | undefined;
        if (assignments?.[slotId] !== materialId || shot?.source !== 'avatar' || shot.sound !== 'source')
          throw new Error('所选素材不是此分镜已确认的数字人原声');
        const adopted = shot.candidates.some(candidate => candidate.id === shot.adoptedId
          && candidate.source === 'avatar' && candidate.materialId === materialId);
        const material = readLocalMaterials().find(item => item.id === materialId && item.tenantId === tenantId && item.scope === 'own');
        const cloudId = materialId.startsWith('pb-') ? materialId.slice(3) : '';
        const cloud = !material && cloudId ? await getOwnedCloudMaterialRecord(cloudId, tenantId) : null;
        const snapshot = !material && !cloud ? (project.spec?.materialSnapshots || []).find((item: any) => item.id === materialId) : null;
        const jobs = await store.list<JobRecord>('studio_avatar_jobs', { where: { tenant_id: tenantId, project_id: projectId }, perPage: 500 });
        // Caption recovery verifies the source video, whose completed job retains its
        // original shot ID when a storyboard is rebuilt. Current assignment/source
        // checks above still bind this request to the authenticated draft and shot.
        const verifiedHeygenJob = jobs.items.find(job => job.tenant_id === tenantId && job.payload.status === 'completed'
          && job.payload.materialId === materialId && job.payload.assemblyId === assemblyId);
        const executions = await store.list<ExecutionStoreRecord>('studio_digital_human_executions', { where: { tenant_id: tenantId, project_id: projectId }, perPage: 500 });
        const verifiedAdoption = executions.items.some(record => record.tenant_id === tenantId
            && record.payload.assemblyId === assemblyId && record.payload.shotId === shotId
            && record.payload.adoption?.materialId === materialId && record.payload.quality.state === 'accepted');
        if (snapshot) {
          if (!verifiedHeygenJob && !verifiedAdoption) throw new Error('旧数字人素材缺少与当前镜头匹配的生成或采纳凭证');
        }
        const cloudProvenance = cloud?.provenance && typeof cloud.provenance === 'object'
          ? cloud.provenance as Record<string, unknown> : (() => { try { return JSON.parse(String(cloud?.provenance || '{}')) as Record<string, unknown>; } catch { return {}; } })();
        const source = material || (cloud ? { id: materialId, tenantId, scope: 'own', type: cloud.type,
          duration: cloud.duration, sourceType: cloud.sourceType,
          transcript: cloudProvenance.avatarSourceTranscript,
          transcriptCues: cloudProvenance.avatarSourceCues,
          transcriptCuesProvenance: cloudProvenance.avatarSourceCuesProvenance,
          transcriptSourceHash: cloudProvenance.avatarSourceHash,
          contentSha256: cloud.sha256 } : snapshot);
        if (!source || source.type !== 'video') throw new Error('数字人源片不存在或不属于当前企业');
        const reusableSentenceVideo = Boolean(material && material.sourceType === 'digital-human-sentence-video'
          && material.providerTaskId && material.contentSha256);
        if (!adopted && !verifiedHeygenJob && !verifiedAdoption && !reusableSentenceVideo)
          throw new Error('所选素材缺少数字人生成与采纳记录');
        const trustedStoredCues = sourceCaptionCacheMatchesContent(
          source.transcriptCuesProvenance, source.transcriptSourceHash, source.contentSha256);
        const existing = trustedStoredCues ? sourceCuesForShot(source.transcriptCues, Number(source.duration)) : [];
        if (existing.length) return { materialId, transcript: String(source.transcript || ''), cues: existing,
          provenance: String(source.transcriptCuesProvenance || 'material_source'),
          sourceHash: String(source.transcriptSourceHash || ''), cached: true };
        let legacyObjectKey = '';
        if (snapshot) {
          legacyObjectKey = legacyAvatarSourceObjectKey(String(snapshot.url || ''), materialId, tenantId);
        }
        let measured: Awaited<ReturnType<typeof measureAvatarSourceCaptions>> | null = null;
        if (verifiedHeygenJob?.payload.remoteId) {
          try {
            const remoteCues = options.recoverAvatarSourceCaptions
              ? await options.recoverAvatarSourceCaptions(verifiedHeygenJob.payload.remoteId, Number(source.duration), String(verifiedHeygenJob.input.script || ''))
              : await (async () => {
                const provider = await heygenRequest(`videos/${encodeURIComponent(verifiedHeygenJob.payload.remoteId!)}`);
                return downloadHeygenSubtitles(String(provider.data?.subtitle_url || ''), Number(source.duration), String(verifiedHeygenJob.input.script || ''));
              })();
            const cues = sourceCuesForShot(remoteCues, Number(source.duration));
            if (cues.length) measured = { transcript: cues.map(cue => cue.text).join(' '), cues,
              provenance: 'heygen:source_video_srt', sourceHash: '' };
          } catch { /* Historical provider captions may be gone; use measured source-audio alignment. */ }
        }
        if (!measured) {
          if (req.body?.confirmedPaidAsr !== true) throw new Error('HeyGen 原字幕不可用；如需用千问从数字人源片实测转写，将产生 ASR 费用，请确认后重试');
          if (!options.measureAvatarSourceCaptions && !objectStorageSupplierDeliveryReady())
            throw new Error('数字人原声字幕需先配置可供千问读取的 HTTPS 对象存储地址');
          let sourceBytes: Buffer | undefined;
          if (cloudId) {
            const cloudMedia = await fetchCloudMaterial(cloudId, 'videoFile', undefined, tenantId);
            if (!cloudMedia) throw new Error('数字人云素材文件不可读取');
            sourceBytes = Buffer.from(await cloudMedia.arrayBuffer());
          } else if (snapshot) {
            const object = await objectStorageDownload(legacyObjectKey);
            if (!object?.buf.length) throw new Error('旧数字人源片文件不可读取');
            sourceBytes = object.buf;
          } else if (material) {
            sourceBytes = (await readTenantMaterialBytes(material, tenantId)).bytes;
          }
          if (!sourceBytes?.length) throw new Error('数字人源片文件不可读取');
          const reservationId = `avatar-source-captions:${tenantId}:${projectId}:${materialId}`;
          await (options.reserveAvatarSourceAsr
            ? options.reserveAvatarSourceAsr(reservationId)
            : studioPaidBudget.reserve('qwen_asr', reservationId, undefined, tenantId));
          measured = await (options.measureAvatarSourceCaptions || measureAvatarSourceCaptions)(source, tenantId, sourceBytes);
        }
        if (cloudId) {
          const saved = await updateCloudMaterial(cloudId, { provenance: { ...cloudProvenance,
            avatarSourceTranscript: measured.transcript, avatarSourceCues: measured.cues,
            avatarSourceCuesProvenance: measured.provenance, avatarSourceHash: measured.sourceHash } });
          if (!saved) throw new Error('数字人源片字幕写回云素材失败');
        } else if (snapshot) {
          const nextSpec = structuredClone(project.spec || {});
          nextSpec.materialSnapshots = (nextSpec.materialSnapshots || []).map((item: any) => item.id === materialId
            ? { ...item, transcript: measured.transcript, transcriptCues: measured.cues,
              transcriptCuesProvenance: measured.provenance, transcriptSourceHash: measured.sourceHash,
              contentSha256: measured.sourceHash || item.contentSha256 } : item);
          const saved = await compareAndSwapStudioProject(store, project, { spec: nextSpec });
          if (!saved.ok) throw new Error('字幕生成期间草稿已更新，未覆盖最新内容；请刷新后重新确认');
        } else {
          const latest = readLocalMaterials();
          const index = latest.findIndex(item => item.id === materialId && item.tenantId === tenantId);
          if (index < 0) throw new Error('字幕生成完成后原素材已不可用');
          latest[index] = { ...latest[index], transcript: measured.transcript, transcriptCues: measured.cues,
            transcriptCuesProvenance: measured.provenance, transcriptSourceHash: measured.sourceHash,
            contentSha256: measured.sourceHash || latest[index].contentSha256 };
          saveLocalMaterials(latest);
        }
        return { materialId, transcript: measured.transcript, cues: measured.cues,
          provenance: measured.provenance, sourceHash: measured.sourceHash, cached: false };
      });
      res.json(result);
    } catch (error) {
      res.status(422).json({ error: error instanceof Error ? error.message : '数字人源片字幕补取失败' });
    }
  });
  router.post('/presenters/portrait-from-video', async (req, res) => {
    try {
      const tenantId = res.locals.tenantId as string;
      const presenterId = String(req.body?.presenterId || '');
      const videoMaterialId = String(req.body?.videoMaterialId || '');
      const result = await exclusive(`presenter-portrait:${tenantId}:${presenterId}:${videoMaterialId}`, async () => {
        const defaults = (await readDefaults(tenantId))?.payload as ProductionDefaults | undefined;
        const presenter = defaults?.presenters.find(item => item.id === presenterId && item.authorized);
        if (!presenter || !presenter.referenceMaterialIds?.includes(videoMaterialId)) throw new Error('请选择已绑定且授权的企业人物视频');
        const video = readLocalMaterials().find(item => item.id === videoMaterialId && item.type === 'video' && item.scope === 'own' && item.tenantId === tenantId);
        if (!video) throw new Error('企业人物视频不存在或不属于当前企业');
        const source = await readTenantMaterialBytes(video, tenantId);
        const portrait = await selectPresenterPortraitFrame(source.bytes);
        const id = `presenter-frame-${createHash('sha256').update(`${tenantId}:${presenterId}:${videoMaterialId}:${portrait.sha256}`).digest('hex').slice(0, 24)}`;
        const existing = readLocalMaterials().find(item => item.id === id);
        if (existing) return { materialId: id, atSeconds: portrait.atSeconds, sharpness: portrait.sharpness, previewUrl: await objectStorageSignedGetUrl(String(existing.objectKey), 900), alreadyExists: true };
        const key = materialAssetObjectKey(tenantId, `${id}.jpg`);
        await objectStorageUpload({ key, body: portrait.bytes, contentType: 'image/jpeg' });
        const head = await objectStorageHead(key);
        if (!head?.etag) throw new Error('人像帧入库后缺少对象版本');
        const material = { id, name: `${presenter.name} · 视频清晰帧`, folder: 'presenter', type: 'image', scope: 'own', tenantId,
          size: `${Math.ceil(portrait.bytes.length / 1024)} KB`, duration: 0, file: '', url: '', objectKey: key, objectEtag: head.etag,
          contentSha256: portrait.sha256, sourceType: 'presenter-video-frame', sourceMaterialId: videoMaterialId,
          frameAtSeconds: portrait.atSeconds, frameSharpness: portrait.sharpness, presenterAssetId: presenterId, createdAt: new Date().toISOString() };
        saveLocalMaterials([...readLocalMaterials(), material]);
        return { materialId: id, atSeconds: portrait.atSeconds, sharpness: portrait.sharpness, previewUrl: await objectStorageSignedGetUrl(key, 900), alreadyExists: false };
      });
      res.json(result);
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : '人物视频取帧失败' }); }
  });
}
