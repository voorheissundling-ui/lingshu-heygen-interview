import { PresenterAudioPreparationError, extractPresenterVoiceCandidate, normalizePresenterAudio, normalizePresenterTrainingVideo } from '../lib/presenterVideo.js';
import fs from 'node:fs';
import { currentDataAuthority } from '../storage/dataAuthority.js';
import { readLocalMaterials, saveLocalMaterials } from '../lib/materialLibrary.js';
import { tenantAssetRelativePath } from '../lib/assetAccess.js';
import { materialAssetObjectKey } from '../storage/materialAssets.js';
import { objectStorageUpload, objectStorageHead } from '../storage/objectStorage.js';
import { Router, raw } from 'express';
import type { DataStore } from '../storage/datastore.js';
import { HeyGenRequestError, asianPresenterLook, mediaUrl, presenterLook } from '../lib/heygenPresenters.js';
import type { ArkPresenterPreparation, PresenterLook } from '../../src/lib/presenterAssets.js';
import type { ProductionDefaults, PresenterAsset } from '../../src/lib/shotProduction.js';
import { EMPTY_DEFAULTS } from '../../src/lib/shotProduction.js';
import path from 'node:path';
import { inspectPresenterVideo, presenterVideoFrame, trimPresenterVideo, type PresenterVideoInfo } from '../lib/presenterVideo.js';
import { cloneVolcengineVoice } from '../lib/volcengineVoiceClone.js';
import {
  COLLECTION, validId, message, hash, consentAccepted, consentAlreadyProcessing,
  presenterCuration, curatedName, createPresenterAssetsContext,
  type Row, type PresenterAssetsOptions,
} from './presenterAssetSupport.js';

type Exclusive = <T>(key: string, operation: () => Promise<T>) => Promise<T>;
export function createPresenterAssetsRouter(store: DataStore, exclusive: Exclusive, options: PresenterAssetsOptions = {}) {
  const router = Router();
  const { client, configured, enabled, directConsent, budgetExempt, privateCatalog, canCreateFor, creationBudget,
    checkPrivateAccount, publicLooks, publicVoices, validVoice, privateVoice, own, find, cloneByHeygenVoice,
    write, publicJob, refresh } = createPresenterAssetsContext(store, options);
  router.get('/capabilities', (_req, res) => {
    const tenant = res.locals.tenantId as string;
    const tenantBudgetExempt = budgetExempt(tenant);
    const photoBudget = creationBudget('photo').status('heygen');
    const digitalTwinBudget = creationBudget('digital_twin').status('heygen');
    const commonReason = !configured() ? '管理员尚未配置 HeyGen 服务密钥' : !canCreateFor(tenant) ? '当前企业尚未连接人物创建账号，可使用公共人物库' : !enabled() ? '人物创建尚未启用，可导入已有可用人物' : '';
    const photoCreationReason = commonReason || (options.reserve || tenantBudgetExempt ? '' : photoBudget.reason);
    const digitalTwinCreationReason = commonReason || (options.reserve || tenantBudgetExempt ? '' : digitalTwinBudget.reason);
    const photoCreationEnabled = !photoCreationReason;
    const digitalTwinCreationEnabled = !digitalTwinCreationReason;
    res.json({ localPhotoUpload: currentDataAuthority() === 'local', configured: configured(), creationEnabled: photoCreationEnabled || digitalTwinCreationEnabled, photoCreationEnabled, digitalTwinCreationEnabled, photoCreationReason, digitalTwinCreationReason, directConsent: directConsent(), privateCatalog: privateCatalog(tenant), budgetExempt: tenantBudgetExempt, reservationCny: photoBudget.reservationCny,
      photoReservationCny: photoBudget.reservationCny, digitalTwinReservationCny: digitalTwinBudget.reservationCny,
      reason: commonReason || (!photoCreationEnabled && !digitalTwinCreationEnabled ? photoCreationReason || digitalTwinCreationReason : '') });
  });
  router.post('/photo-materials', raw({ type: 'application/octet-stream', limit: '32mb' }), async (req, res) => {
    try {
      if (currentDataAuthority() !== 'local') { res.status(409).json({ error: '请使用企业素材库上传人物照片' }); return; }
      const tenantId = res.locals.tenantId as string; const bytes = req.body as Buffer;
      const mime = String(req.query.mime || '');
      if (!Buffer.isBuffer(bytes) || !bytes.length || !['image/jpeg', 'image/png'].includes(mime)
        || (mime === 'image/jpeg' ? bytes[0] !== 255 || bytes[1] !== 216 : !bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))) throw new Error('请选择32MB以内的有效 JPG 或 PNG 人物照片');
      const id = `presenter-photo-${hash(`${tenantId}:${hash(bytes)}`).slice(0,24)}`;
      const material = await exclusive('presenter-photo-library', async () => {
        const records = readLocalMaterials(); const existing = records.find(item => item.id === id && item.tenantId === tenantId); if (existing) return existing;
        const filename = `${id}.${mime === 'image/png' ? 'png' : 'jpg'}`; const relative = tenantAssetRelativePath(tenantId, filename);
        const target = path.resolve('data/media', relative); fs.mkdirSync(path.dirname(target), {recursive: true}); fs.writeFileSync(target, bytes, {mode:0o600});
        const objectKey = materialAssetObjectKey(tenantId, filename); await objectStorageUpload({key:objectKey, body:bytes, contentType:mime}); const head = await objectStorageHead(objectKey); if (!head?.etag) throw new Error('人物照片存储校验失败');
        const item = {id, name:String(req.query.name || '企业人物照片').slice(0,100), type:'image' as const, folder:'presenter', scope:'own' as const, tenantId, file:relative, url:`/media/${relative}`, objectKey, objectEtag:head.etag, contentSha256:hash(bytes), duration:0, size:`${Math.ceil(bytes.length/1024)} KB`, sourceType:'presenter-inline-upload', createdAt:new Date().toISOString()};
        saveLocalMaterials([...records,item]); return item;
      }); res.status(201).json({ok:true, material});
    } catch(error) {res.status(400).json({error:message(error)});}
  });
  router.post('/profiles', async (req, res) => {
    try {
      const tenant = res.locals.tenantId as string;
      const b = req.body || {};
      const requestId = String(b.requestId || '');
      const name = String(b.name || '').trim();
      const photoMaterialId = String(b.photoMaterialId || '');
      const videoMaterialId = String(b.videoMaterialId || '');
      if (!validId(requestId) || !name || name.length > 100 || !validId(photoMaterialId) || !validId(videoMaterialId)) {
        throw new Error('请完整填写人物名称并上传本人照片和视频');
      }
      if (b.storageAuthorized !== true || b.adultConfirmed !== true) {
        throw new Error('请确认肖像素材可由灵枢安全保存，且画面主体为成年人');
      }
      const ownsMaterial = (id: string, type: 'image' | 'video') => options.materialBelongs?.(tenant, id, type)
        ?? readLocalMaterials().some(item => item.id === id && item.tenantId === tenant && item.scope === 'own' && item.type === type);
      if (!ownsMaterial(photoMaterialId, 'image') || !ownsMaterial(videoMaterialId, 'video')) {
        throw new Error('人物照片或视频不属于当前企业，无法录入');
      }
      const fingerprint = hash(JSON.stringify([name, photoMaterialId, videoMaterialId]));
      const result = await exclusive(`defaults:${tenant}`, async () => {
        let evidence = await find(tenant, 'profile_intake', requestId);
        if (evidence && evidence.payload?.fingerprint !== fingerprint) throw new Error('请求标识已用于另一组人物资料');
        if (!evidence) {
          const created = await store.create<Row>(COLLECTION, {
            tenant_id: tenant,
            kind: 'profile_intake',
            request_id: requestId,
            payload: {
              fingerprint,
              name,
              photoMaterialId,
              videoMaterialId,
              storageAuthorized: true,
              adultConfirmed: true,
              createdAt: new Date().toISOString(),
            },
          });
          if (!created) throw new Error('人物资料留档失败，请保持文件不变后重试');
          evidence = created;
        }
        const row = (await store.list<Row>('studio_production_defaults', { where: { tenant_id: tenant }, perPage: 1 })).items[0];
        const defaults: ProductionDefaults = row?.payload || EMPTY_DEFAULTS;
        const referenceMaterialIds = [photoMaterialId, videoMaterialId];
        const matching = defaults.presenters.find(item => item.authorized === false
          && item.arkCertification?.status === 'profile_incomplete'
          && referenceMaterialIds.every(id => item.referenceMaterialIds?.includes(id)));
        const presenterId = matching?.id || `presenter-profile-${hash(`${tenant}:${photoMaterialId}:${videoMaterialId}`).slice(0, 24)}`;
        if (!matching && defaults.presenters.length >= 50) throw new Error('企业人物已达到 50 个上限');
        const changed = !matching || matching.name !== name
          || JSON.stringify(matching.referenceMaterialIds || []) !== JSON.stringify(referenceMaterialIds);
        const presenter: PresenterAsset = {
          id: presenterId,
          name,
          avatarId: '',
          voiceId: '',
          authorized: false,
          supportsAlpha: false,
          nativeOrientation: 'unknown',
          assetVersion: matching ? Math.max(1, matching.assetVersion || 1) + (changed ? 1 : 0) : 1,
          capabilities: ['reference_image', 'reference_video'],
          referenceMaterialIds,
          arkCertification: {
            projectName: 'default',
            assetUri: '',
            assetType: '',
            status: 'profile_incomplete',
            materialId: photoMaterialId,
          },
          toolMappings: {
            runway: { referenceMaterialIds },
            sd: { referenceMaterialIds },
            seedance: { referenceMaterialIds },
          },
        };
        const presenters = matching
          ? defaults.presenters.map(item => item.id === matching.id ? presenter : item)
          : [...defaults.presenters, presenter];
        const payload: ProductionDefaults = { ...EMPTY_DEFAULTS, ...defaults, presenters, defaultPresenterId: presenter.id };
        const saved = row
          ? await store.update('studio_production_defaults', row.id, { payload })
          : await store.create('studio_production_defaults', { tenant_id: tenant, payload });
        if (!saved) throw new Error('人物资料保存失败，请保持文件不变后重试');
        return { defaults: payload, presenter };
      });
      res.status(201).json(result);
    } catch (error) { res.status(400).json({ error: message(error) }); }
  });
  router.get('/catalog', async (req, res) => {
    try {
      const tenant = res.locals.tenantId as string;
      const isPrivate = req.query.scope === 'private';
      if (isPrivate && !privateCatalog(tenant)) { res.status(403).json({ error: '企业专属人物账号尚未连接' }); return; }
      if (isPrivate) await checkPrivateAccount(tenant);
      const page = await client().looks(String(req.query.token || '').slice(0, 2000), isPrivate ? 'private' : 'public');
      const curation = presenterCuration(tenant);
      const favorite = (look: PresenterLook) => look.favorite || Boolean(curatedName(curation.favoriteNames, look.name));
      const asian = (look: PresenterLook) => asianPresenterLook(look) || Boolean(curatedName(curation.asianNames, look.name));
      for (const [id, entry] of publicLooks) if (Date.now() - entry.at > 300000) publicLooks.delete(id);
      for (const look of page.items) publicLooks.set(`${tenant}:${look.id}`, { look, at: Date.now(), private: isPrivate });
      while (publicLooks.size > 3000) publicLooks.delete(publicLooks.keys().next().value!);
      res.json({ ...page, items: [...page.items].sort((a, b) => Number(asian(b)) - Number(asian(a)) || Number(favorite(b)) - Number(favorite(a))) });
    } catch (e) { res.status(503).json({ error: message(e) }); }
  });
  router.post('/favorites/sync', async (_req, res) => {
    try {
      const tenant = res.locals.tenantId as string;
      const curation = presenterCuration(tenant);
      const favorites: PresenterLook[] = [];
      if (curation.favoriteGroups.length) {
        const groups = await Promise.all(curation.favoriteGroups.map(async group => ({ group, looks: await client().groupLooks(group.groupId) })));
        for (const { group, looks } of groups) {
          const preferred = looks.find(item => item.status === 'completed' && item.voiceId) || looks.find(item => item.status === 'completed');
          if (preferred) favorites.push({ ...preferred, name: group.name, favorite: true, tags: [...(preferred.tags || []), ...(group.asian ? ['asian'] : [])] });
        }
      } else {
        let token = '';
        for (let pageNumber = 0; pageNumber < 30; pageNumber++) {
          const page = await client().looks(token, 'public');
          favorites.push(...page.items.filter(item => (item.favorite || curatedName(curation.favoriteNames, item.name)) && item.status === 'completed'));
          if (!page.nextToken || page.nextToken === token) break;
          token = page.nextToken;
        }
      }
      const result = await exclusive(`defaults:${tenant}`, async () => {
        const row = (await store.list<Row>('studio_production_defaults', { where: { tenant_id: tenant }, perPage: 1 })).items[0];
        const defaults: ProductionDefaults = row?.payload || EMPTY_DEFAULTS;
        const existing = new Set(defaults.presenters.map(item => item.avatarId));
        const preferred = new Map<string, PresenterLook>();
        for (const look of favorites) {
          const group = curatedName(curation.favoriteNames, look.name) || look.groupId || look.id;
          const current = preferred.get(group);
          if (!current || (!current.voiceId && look.voiceId)) preferred.set(group, look);
        }
        const selectedFavorites = [...preferred.values()];
        const importable = selectedFavorites.filter(item => item.voiceId && !existing.has(item.id));
        const capacity = Math.max(0, 50 - defaults.presenters.length);
        const selected = importable.slice(0, capacity);
        const additions: PresenterAsset[] = selected.map(look => ({ id: `presenter-${hash(`${look.id}:${look.voiceId}`).slice(0, 24)}`, name: look.name.slice(0, 100), avatarId: look.id, voiceId: look.voiceId!, authorized: true,
          supportsAlpha: false, nativeOrientation: look.orientation, imageUrl: look.imageUrl, videoUrl: look.videoUrl, assetVersion: 1, capabilities: ['talking'], toolMappings: { heygen: { avatarId: look.id, voiceId: look.voiceId! } }, rightsEvidence: { authorizationRef: `document://studio_presenter_assets/catalog/${look.id}`, consentRef: `consent://heygen/${look.groupId || look.id}`, grantedAt: new Date().toISOString(), subjectAdultConfirmed: true, permittedProviders: ['heygen'], permittedUses: ['digital_presenter', 'voice_synthesis'] } }));
        const isAsian = (presenter: PresenterAsset) => Boolean(curatedName(curation.asianNames, presenter.name)) || asianPresenterLook(favorites.find(item => item.id === presenter.avatarId) || { id: '', name: '', orientation: 'unknown', status: '' });
        const presenters = [...defaults.presenters, ...additions].sort((a, b) => Number(isAsian(b)) - Number(isAsian(a)));
        const payload = { ...defaults, presenters, defaultPresenterId: defaults.defaultPresenterId || additions[0]?.id || '' };
        if (additions.length) {
          const saved = row ? await store.update('studio_production_defaults', row.id, { payload }) : await store.create('studio_production_defaults', { tenant_id: tenant, payload });
          if (!saved) throw new Error('收藏人物保存失败，请重试');
        }
        return { defaults: payload, favoriteCount: selectedFavorites.length, importedCount: additions.length, skippedWithoutVoice: selectedFavorites.filter(item => !item.voiceId).length, capacityReached: importable.length > selected.length };
      });
      res.json(result);
    } catch (e) { res.status(503).json({ error: message(e) }); }
  });
  router.get('/voices', async (req, res) => {
    try {
      const tenant = res.locals.tenantId as string;
      const scope = req.query.scope === 'private' ? 'private' : 'public';
      if (scope === 'private') await checkPrivateAccount(tenant);
      const page = await client().voices(String(req.query.token || '').slice(0, 2000), String(req.query.language || '').slice(0, 40), scope);
      if (scope === 'public') for (const voice of page.items) publicVoices.set(voice.id, Date.now());
      while (publicVoices.size > 5000) publicVoices.delete(publicVoices.keys().next().value!);
      res.json(page);
    }
    catch (e) { res.status(503).json({ error: message(e) }); }
  });
  router.post('/voices/candidate-from-video', raw({ type: 'application/octet-stream', limit: '200mb' }), async (req, res) => {
    try {
      const bytes = req.body as Buffer;
      if (!Buffer.isBuffer(bytes) || bytes.length < 10_000 || bytes.length > 200 * 1024 * 1024) throw new Error('请选择 200MB 以内的有效本人视频');
      const result = await extractPresenterVoiceCandidate(bytes);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ audioBase64: result.audio.toString('base64'), durationSeconds: result.durationSeconds, nonSilentSeconds: result.nonSilentSeconds });
    } catch (error) { res.status(400).json({ error: message(error) }); }
  });
  router.post('/voices/clones', raw({ type: ['audio/webm', 'audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/ogg'], limit: '10mb' }), async (req, res) => {
    try {
      const tenant = res.locals.tenantId as string;
      await checkPrivateAccount(tenant);
      const name = String(req.query.name || '').trim();
      const language = String(req.query.language || '').trim();
      const requestId = String(req.query.requestId || '');
      const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const bytes = req.body as Buffer;
      const audioMatches = mime === 'audio/webm' ? bytes?.subarray(0, 4).equals(Buffer.from([26,69,223,163]))
        : mime === 'audio/wav' ? bytes?.toString('ascii', 0, 4) === 'RIFF' && bytes?.toString('ascii', 8, 12) === 'WAVE'
        : mime === 'audio/ogg' ? bytes?.toString('ascii', 0, 4) === 'OggS'
        : mime === 'audio/mp4' ? bytes?.toString('ascii', 4, 8) === 'ftyp'
        : mime === 'audio/mpeg' ? bytes?.toString('ascii', 0, 3) === 'ID3' || bytes?.[0] === 255 && (bytes?.[1] & 224) === 224 : false;
      if (req.query.consent !== 'true') throw new Error('请确认已取得本人声音克隆及商业口播使用授权');
      if (!validId(requestId) || !name || name.length > 100 || !/^[a-z]{2}(?:-[A-Z]{2})?$/.test(language)
        || !['audio/webm','audio/wav','audio/mpeg','audio/mp4','audio/ogg'].includes(mime)
        || !Buffer.isBuffer(bytes) || bytes.length < 10_000 || bytes.length > 10 * 1024 * 1024 || !audioMatches) throw new Error('请提供名称、语言和 10MB 以内的有效录音');
      const digest = hash(bytes);
      const result = await exclusive(`voice-clone:${tenant}:${requestId}`, async () => {
        const previous = await find(tenant, 'voice_clone', requestId);
        if (previous) {
          if (previous.payload.digest !== digest || previous.payload.name !== name) throw new Error('同一提交标识不能更换录音或名称');
          return { id: previous.id, status: previous.payload.status, voiceId: previous.payload.voiceId || '', arkVoice: previous.payload.arkVoice };
        }
        const created = await store.create<Row>(COLLECTION, { tenant_id: tenant, kind: 'voice_clone', request_id: requestId,
          payload: { name, language, digest, status: 'submitting', voiceId: '', authorizationConfirmedAt: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
        if (!created) throw new Error('音色任务记录保存失败，未调用 HeyGen');
        try {
          const normalizedAudio = await (options.normalizeVoiceAudio || normalizePresenterAudio)(bytes);
          const candidateVoiceIds = await client().cloneVoice(name, normalizedAudio, 'audio/mpeg', language, `voice-clone:${tenant}:${requestId}`);
          const voiceId = candidateVoiceIds[0]!;
          const materialId = `presenter-voice-${hash(`${tenant}:${digest}`).slice(0,24)}`;
          const filename = `${materialId}.mp3`, relative = tenantAssetRelativePath(tenant, filename);
          const target = path.resolve('data/media', relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, normalizedAudio, { mode: 0o600 });
          const objectKey = materialAssetObjectKey(tenant, filename); await objectStorageUpload({ key: objectKey, body: normalizedAudio, contentType: 'audio/mpeg' });
          const head = await objectStorageHead(objectKey); if (!head?.etag) throw new Error('本人声音素材存储校验失败');
          const records = readLocalMaterials();
          saveLocalMaterials([...records.filter(item => item.id !== materialId), { id: materialId, name: `${name} · 本人声音`, type: 'audio', folder: 'presenter', scope: 'own', tenantId: tenant, file: relative, url: `/media/${relative}`, objectKey, objectEtag: head.etag, contentSha256: hash(normalizedAudio), size: `${Math.ceil(normalizedAudio.length / 1024)} KB`, sourceType: 'presenter-voice-reference', createdAt: new Date().toISOString() }]);
          let arkVoice: { speakerId?: string; status: string; error?: string } = { status: 'not_configured' };
          const arkVoiceKey = String(process.env.VOLCENGINE_VOICE_API_KEY || '').trim();
          if (arkVoiceKey) {
            const speakerId = `lingshu_${hash(`${tenant}:${requestId}`).slice(0,24)}`;
            try { arkVoice = await cloneVolcengineVoice({ apiKey: arkVoiceKey, speakerId, audio: normalizedAudio, language, requestId }); }
            catch (arkError) { arkVoice = { speakerId, status: 'failed', error: message(arkError) }; }
          }
          await write(created, { voiceId, candidateVoiceIds, status: 'processing', referenceAudioMaterialId: materialId, arkVoice });
          return { id: created.id, status: 'processing', voiceId, arkVoice };
        } catch (error) {
          const rejected = error instanceof PresenterAudioPreparationError || error instanceof HeyGenRequestError && error.definitive;
          await write(created, { status: rejected ? 'failed' : 'uncertain', error: message(error) });
          throw new Error(rejected ? `${message(error)}；本次声音克隆未受理，可修正录音后重试` : `${message(error)}；任务已留档，请先核对 HeyGen 私人音色列表，勿重复提交`);
        }
      });
      res.status(result.status === 'processing' ? 202 : 200).json(result);
    } catch (error) { res.status(400).json({ error: message(error) }); }
  });
  router.get('/voices/clones', async (_req, res) => {
    try {
      const tenant = res.locals.tenantId as string;
      await checkPrivateAccount(tenant);
      const rows = await store.list<Row>(COLLECTION, { where: { tenant_id: tenant, kind: 'voice_clone' }, perPage: 100 });
      const realRows = rows.items.filter(row => row.payload.mock !== true);
      for (const row of realRows) if (!row.payload.voiceId && row.payload.status === 'uncertain' && /^HeyGen 400[：:]/.test(String(row.payload.error || ''))) await write(row, { status: 'failed' });
      res.json(realRows.map(row => ({ id: row.id, name: row.payload.name, status: row.payload.status, error: row.payload.error || '', voiceId: row.payload.voiceId || '', arkVoice: row.payload.arkVoice, createdAt: row.payload.createdAt })));
    } catch (error) { res.status(400).json({ error: message(error) }); }
  });
  router.get('/voices/clones/:id', async (req, res) => {
    try {
      const tenant = res.locals.tenantId as string;
      await checkPrivateAccount(tenant);
      const row = await own(req.params.id, tenant, 'voice_clone');
      if (!row.payload.voiceId && row.payload.status === 'uncertain' && /^HeyGen 400[：:]/.test(String(row.payload.error || ''))) await write(row, { status: 'failed' });
      if (!row.payload.voiceId) { res.json({ id: row.id, status: row.payload.status, error: row.payload.error || '', arkVoice: row.payload.arkVoice }); return; }
      const candidateIds = Array.isArray(row.payload.candidateVoiceIds) && row.payload.candidateVoiceIds.length ? row.payload.candidateVoiceIds : [row.payload.voiceId];
      const voices = await Promise.all(candidateIds.map((id: string) => client().voice(id)));
      const usable = await Promise.all(voices.map(async voice => /^(complete|active)$/i.test(voice.status) || (!voice.status && await privateVoice(voice.id).then(() => true).catch(() => false))));
      const failed = voices.map(voice => /^(failed|expired)$/i.test(voice.status));
      const candidates = voices.filter((_voice, index) => usable[index]).map(voice => ({ ...voice, provider: 'heygen' as const, selected: voice.id === row.payload.voiceId }));
      const status = candidates.length && voices.every((_voice, index) => usable[index] || failed[index]) ? 'completed' : failed.every(Boolean) ? 'failed' : 'processing';
      await write(row, { status, error: status === 'failed' ? 'HeyGen 音色克隆失败' : '' });
      const voice = candidates.find(candidate => candidate.id === row.payload.voiceId) || candidates[0];
      res.json({ id: row.id, status, voice, candidates, arkVoice: row.payload.arkVoice });
    } catch (error) { res.status(400).json({ error: message(error) }); }
  });
  router.post('/voices/bind', async (req, res) => {
    try {
      const tenant = res.locals.tenantId as string;
      await checkPrivateAccount(tenant);
      const presenterId = String(req.body?.presenterId || '');
      const voiceId = String(req.body?.voiceId || '');
      if (!validId(presenterId) || !validId(voiceId) || req.body?.voiceAuthorized !== true) throw new Error('请选择人物与音色，并确认本人声音使用授权');
      await privateVoice(voiceId);
      const voice = await client().voice(voiceId);
      if (voice.id !== voiceId || (voice.status && !/^(complete|active)$/i.test(voice.status))) throw new Error('所选 HeyGen 私人音色尚不可用');
      const saved = await exclusive(`defaults:${tenant}`, async () => {
        const row = (await store.list<Row>('studio_production_defaults', { where: { tenant_id: tenant }, perPage: 1 })).items[0];
        const defaults = row?.payload as ProductionDefaults | undefined;
        const presenter = defaults?.presenters.find(item => item.id === presenterId && item.authorized);
        if (!defaults || !presenter) throw new Error('当前企业人物不存在或未授权');
        const avatarId = presenter.toolMappings?.heygen?.avatarId || presenter.avatarId || '';
        if (!avatarId || !presenter.rightsEvidence?.authorizationRef) throw new Error('人物原始授权未登记，不能绑定声音');
        const requestId = hash(`${tenant}:${presenterId}:${avatarId}:${voiceId}`);
        let evidence = await find(tenant, 'voice_binding_authorization', requestId);
        if (!evidence) {
          const created = await store.create<Row>(COLLECTION, { tenant_id: tenant, kind: 'voice_binding_authorization', request_id: requestId,
            payload: { presenterId, avatarId, voiceId, authorizationDeclared: true, providerVoiceConfirmed: true, recordedAt: new Date().toISOString() } });
          if (!created) throw new Error('声音授权留档失败，未修改默认声音');
          evidence = created;
        }
        if (evidence.tenant_id !== tenant || evidence.kind !== 'voice_binding_authorization' || evidence.request_id !== requestId
          || evidence.payload?.presenterId !== presenterId || evidence.payload?.avatarId !== avatarId || evidence.payload?.voiceId !== voiceId
          || evidence.payload?.authorizationDeclared !== true || evidence.payload?.providerVoiceConfirmed !== true
          || evidence.payload?.revokedAt) {
          throw new Error('声音授权原始记录不一致，不能修改默认声音');
        }
        const clone = await cloneByHeygenVoice(tenant, voiceId);
        const arkVoice = clone?.payload?.arkVoice;
        const arkMapping = clone?.payload?.referenceAudioMaterialId ? { referenceAudioMaterialId: String(clone.payload.referenceAudioMaterialId), ...(arkVoice?.speakerId && arkVoice.status !== 'failed' ? { speakerId: String(arkVoice.speakerId) } : {}) } : undefined;
        const presenters = defaults.presenters.map(item => item.id === presenterId ? {
          ...item, voiceId, assetVersion: Math.max(1, item.assetVersion || 1) + (item.voiceId === voiceId ? 0 : 1),
          voiceAuthorization: { voiceId, recordedAt: evidence.payload.recordedAt, source: 'user_confirmation' as const,
            authorizationRef: `document://studio_presenter_assets/${evidence.id}/${voiceId}` },
          toolMappings: { ...item.toolMappings, heygen: { avatarId: item.avatarId || item.toolMappings?.heygen?.avatarId || '', voiceId }, ...(arkMapping ? { volcengineArk: arkMapping } : {}) },
          rightsEvidence: arkMapping && item.rightsEvidence ? { ...item.rightsEvidence,
            permittedProviders: [...new Set([...item.rightsEvidence.permittedProviders, 'volcengine_ark' as const])],
            permittedUses: [...new Set([...item.rightsEvidence.permittedUses, 'voice_synthesis' as const])],
            providerScopes: [...(item.rightsEvidence.providerScopes || []).filter(scope => scope.provider !== 'volcengine_ark'), { provider: 'volcengine_ark' as const, uses: ['voice_synthesis' as const] }],
          } : item.rightsEvidence,
        } : item);
        const next = { ...defaults, presenters };
        if (!await store.update('studio_production_defaults', row.id, { payload: next })) throw new Error('音色绑定保存失败');
        return next;
      });
      res.json({ defaults: saved, voice });
    } catch (error) { res.status(400).json({ error: message(error) }); }
  });
  router.get('/creations', async (_req, res) => {
    try {
      const result = await store.list<Row>(COLLECTION, { where: { tenant_id: res.locals.tenantId, kind: 'creation' }, perPage: 100 });
      // Legacy local-preview rows are intentionally excluded: they have no
      // provider-backed identity or consent evidence and cannot become assets.
      const rows = result.items.filter(row => row.tenant_id === res.locals.tenantId && row.payload.mock !== true);
      const jobs = await Promise.all(rows.map(row => {
        if (!row.payload.groupId && /limit.*(?:avatar|group)|avatar.*slots|slots.*limit/i.test(String(row.payload.error || ''))) return write(row, { status: 'failed', failureCategory: 'capacity', error: 'HeyGen 人物名额已满，当前账号不能新增视频人物。请先处理账号人物名额，或使用同一人的已有授权人物；本次未创建人物。' });
        return !row.payload.groupId && row.payload.status === 'uncertain' && /^HeyGen 400[：:]/.test(String(row.payload.error || ''))
          ? write(row, { status: 'failed', error: 'HeyGen 未受理这次人物创建。请返回修改素材后重新提交' })
          : publicJob(row);
      }));
      res.json(jobs);
    } catch { res.status(503).json({ error: '企业人物任务读取失败，请检查人物资产数据表' }); }
  });
  // Auth is inherited from studioRouter, before buffering a bounded binary body.
  router.get('/uploads/status', async (req, res) => {
    try {
      const requestId = String(req.query.requestId || '');
      if (!validId(requestId)) throw new Error('上传请求标识无效');
      const row = await find(res.locals.tenantId, 'upload', requestId);
      if (!row) { res.json({ status: 'receiving', stage: 'checking_video' }); return; }
      res.json({ id: row.id, status: row.payload.status || (row.payload.assetId ? 'completed' : 'uncertain'), stage: row.payload.stage || '', error: row.payload.error || '', updatedAt: row.payload.updatedAt || row.payload.createdAt });
    } catch (error) { res.status(400).json({ error: message(error) }); }
  });
  router.post('/uploads', raw({ type: 'application/octet-stream', limit: '200mb' }), async (req, res) => {
    try {
      if (!configured()) throw new Error('管理员尚未配置 HeyGen 服务密钥');
      let mime = String(req.query.mime || ''); const requestId = String(req.query.requestId || '');
      let bytes = req.body as Buffer;
      if (!validId(requestId) || !Buffer.isBuffer(bytes) || bytes.length < 12) throw new Error('上传文件或请求标识无效');
      const matches = mime === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : mime === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : ['video/mp4', 'video/quicktime'].includes(mime) ? bytes.toString('ascii', 4, 8) === 'ftyp' : mime === 'video/webm' ? bytes.subarray(0, 4).equals(Buffer.from([26,69,223,163])) : false;
      if (!matches) throw new Error('文件内容与格式不匹配，请使用 JPG、PNG、MP4、MOV 或 WebM');
      const originalDigest = hash(bytes);
      const trimSeconds = Number(req.query.trimSeconds);
      const frameAtSeconds = Number(req.query.frameAtSeconds);
      let trainingInfo: PresenterVideoInfo | undefined;
      if (frameAtSeconds >= 0 && req.query.frameAtSeconds !== undefined) {
        if (!mime.startsWith('video/') || frameAtSeconds > 10) throw new Error('只能从上传视频的前 10 秒提取本人照片');
        bytes = await (options.extractFrame || presenterVideoFrame)(bytes, frameAtSeconds);
        mime = 'image/jpeg';
      } else if (trimSeconds) {
        if (!mime.startsWith('video/') || trimSeconds !== 7) throw new Error('仅支持将真人人物视频截取为前 7 秒');
        bytes = await (options.trimVideo || trimPresenterVideo)(bytes, trimSeconds);
        mime = 'video/mp4';
      } else if (req.query.trainingVideo === 'true') {
        if (!mime.startsWith('video/')) throw new Error('专家模式必须上传完整真人视频');
        trainingInfo = await (options.inspectVideo || inspectPresenterVideo)(bytes);
        if (trainingInfo.duration < 30 || trainingInfo.duration > 300) throw new Error('专家模式训练视频须为 30 秒至 5 分钟的连续录制');
        if (!trainingInfo.hasAudio) throw new Error('专家模式训练视频必须包含本人清晰说话音频');
        if (mime !== 'video/mp4' || Math.min(trainingInfo.width, trainingInfo.height) < 720 || trainingInfo.fps < 24) {
          bytes = await (options.normalizeTrainingVideo || normalizePresenterTrainingVideo)(bytes);
          mime = 'video/mp4';
          trainingInfo = await (options.inspectVideo || inspectPresenterVideo)(bytes);
        }
        if (Math.min(trainingInfo.width, trainingInfo.height) < 720 || trainingInfo.fps < 24) throw new Error('专家模式训练视频至少需要 720p、24fps；推荐 1080p、30fps');
      }
      const tenant = res.locals.tenantId as string;
      const result = await exclusive(`presenter:${tenant}`, async () => {
        const digest = req.query.trainingVideo === 'true' ? originalDigest : hash(bytes), previous = await find(tenant, 'upload', requestId);
        if (previous) {
          if (previous.payload.digest !== digest) throw new Error('请求标识已用于其他文件');
          if (!previous.payload.assetId) throw new Error('上次上传结果待核实，请重新选择文件上传');
          return { id: previous.id, ...(trimSeconds ? { processedDurationSeconds: trimSeconds } : {}), ...(frameAtSeconds >= 0 && req.query.frameAtSeconds !== undefined ? { extractedFrame: true } : {}), ...(trainingInfo ? { trainingInfo } : {}) };
        }
        const row = await store.create<Row>(COLLECTION, { tenant_id: tenant, kind: 'upload', request_id: requestId, payload: { mime, digest, status: 'uploading', stage: 'registered', updatedAt: new Date().toISOString(), ...(trainingInfo ? { trainingInfo } : {}), createdAt: new Date().toISOString() } });
        if (!row) throw new Error('素材登记失败，未上传到供应商');
        let assetId: string;
        let progress = row.payload;
        try {
          assetId = await client().upload(bytes, mime, `presenter-upload:${row.id}`, async (stage, remoteAssetId) => {
            progress = { ...progress, stage, ...(remoteAssetId ? { remoteAssetId } : {}), updatedAt: new Date().toISOString() };
            if (!await store.update(COLLECTION, row.id, { payload: progress })) throw new Error('上传阶段登记失败');
          });
        } catch (error) {
          await store.update(COLLECTION, row.id, { payload: { ...progress, status: error instanceof HeyGenRequestError && error.definitive ? 'failed' : 'uncertain', error: message(error), updatedAt: new Date().toISOString() } });
          throw error;
        }
        if (!await store.update(COLLECTION, row.id, { payload: { ...progress, assetId, status: 'completed', stage: 'completed', updatedAt: new Date().toISOString() } })) throw new Error('素材登记失败，请重新选择文件');
        return { id: row.id, ...(trimSeconds ? { processedDurationSeconds: trimSeconds } : {}), ...(frameAtSeconds >= 0 && req.query.frameAtSeconds !== undefined ? { extractedFrame: true } : {}), ...(trainingInfo ? { trainingInfo } : {}) };
      });
      res.json(result);
    } catch (e) { res.status(400).json({ error: message(e) }); }
  });
  router.post('/creations', async (req, res) => {
    try {
      const b = req.body || {}, tenant = res.locals.tenantId as string;
      if (!validId(b.requestId) || !['photo', 'digital_twin'].includes(b.type) || typeof b.name !== 'string' || !b.name.trim() || b.name.length > 100 || b.authorized !== true || b.adultConfirmed !== true || b.confirmed !== true) throw new Error('请填写人物名称，并确认肖像授权、主体已成年与创建费用');
      const result = await exclusive(`presenter:${tenant}`, async () => {
        const reusePresenterId = String(b.reusePresenterId || '');
        let arkPreparation: ArkPresenterPreparation | undefined;
        if (b.arkPreparation) {
          const photoMaterialId = String(b.arkPreparation.photoMaterialId || '');
          const videoMaterialId = String(b.arkPreparation.videoMaterialId || '');
          if (!validId(photoMaterialId) || !validId(videoMaterialId)) throw new Error('方舟复用资料缺少照片或视频');
          const materials = readLocalMaterials();
          const ownsMaterial = (id: string, type: 'image' | 'video') => options.materialBelongs?.(tenant, id, type)
            ?? materials.some(item => item.id === id && item.tenantId === tenant && item.scope === 'own' && item.type === type);
          if (!ownsMaterial(photoMaterialId, 'image') || !ownsMaterial(videoMaterialId, 'video')) throw new Error('方舟复用资料不属于当前企业或类型不匹配');
          arkPreparation = { photoMaterialId, videoMaterialId, processingAuthorized: b.arkPreparation.processingAuthorized === true };
        }
        const fingerprint = hash(JSON.stringify([b.type, b.name.trim(), b.uploadId, b.voiceId, reusePresenterId, arkPreparation]));
        const previous = await find(tenant, 'creation', b.requestId);
        if (previous) { if (previous.payload.fingerprint !== fingerprint) throw new Error('请求标识已用于其他人物'); return publicJob(previous); }
        if (!enabled()) throw new Error('管理员尚未启用人物创建');
        if (!canCreateFor(tenant)) throw new Error('当前企业尚未连接人物创建账号');
        let reuseGroupId = '';
        if (reusePresenterId) {
          if (!validId(reusePresenterId) || b.samePersonConfirmed !== true) throw new Error('复用 HeyGen 本人授权前，请确认新增素材属于同一人物');
          await checkPrivateAccount(tenant);
          const defaults = (await store.list<Row>('studio_production_defaults', { where: { tenant_id: tenant }, perPage: 1 })).items[0]?.payload as ProductionDefaults | undefined;
          const presenter = defaults?.presenters.find(item => item.id === reusePresenterId && item.authorized);
          if (!presenter?.avatarId) throw new Error('当前人物没有可复用的 HeyGen 人物组');
          const priorLook = await client().look(presenter.avatarId);
          if (!priorLook.groupId) throw new Error('当前人物缺少已核验的 HeyGen 人物组归属');
          let ownershipVerified = presenter.rightsEvidence?.consentRef === `consent://heygen/${priorLook.groupId}`;
          const sourceId = presenter.rightsEvidence?.authorizationRef?.match(/^document:\/\/studio_presenter_assets\/([^/]+)\//)?.[1];
          if (!ownershipVerified && sourceId) {
            const source = await own(sourceId, tenant, 'creation');
            ownershipVerified = source.payload.mock !== true && source.payload.authorizationDeclared === true && source.payload.look?.id === priorLook.id && source.payload.groupId === priorLook.groupId;
          }
          if (!ownershipVerified) {
            let token = '';
            for (let page = 0; page < 20; page++) {
              const catalog = await client().looks(token, 'private');
              if (catalog.items.some(item => item.id === priorLook.id && item.groupId === priorLook.groupId)) { ownershipVerified = true; break; }
              if (!catalog.nextToken) break;
              token = catalog.nextToken;
            }
          }
          if (!ownershipVerified) throw new Error('当前人物缺少已核验的 HeyGen 人物组归属');
          const group = await client().group(priorLook.groupId);
          if (group.status !== 'completed' || (group.consent_status && !consentAccepted(group.consent_status))) throw new Error('原 HeyGen 人物组尚未完成本人验证');
          reuseGroupId = priorLook.groupId;
        }
        const upload = await own(String(b.uploadId), tenant, 'upload');
        if (!upload.payload.assetId || !(b.type === 'photo' ? upload.payload.mime.startsWith('image/') : upload.payload.mime.startsWith('video/'))) throw new Error('请上传与创建类型匹配的素材');
        if (b.type === 'digital_twin' && !upload.payload.trainingInfo) throw new Error('请使用经过时长、画幅、帧率和音轨检查的完整人物视频');
        const existing = (await store.list<Row>(COLLECTION, { where: { tenant_id: tenant, kind: 'creation' }, perPage: 100 })).items
          .filter(row => row.payload.mock !== true);
        if (existing.length >= 100) throw new Error('人物创建任务已达到当前上限');
        const sameSource = existing.find(row => row.payload.sourceDigest === upload.payload.digest && row.payload.status !== 'failed');
        // A repeated click, refresh, or a newly generated browser request id must
        // recover the existing paid provider task instead of creating another
        // task or leaving the user at an unrecoverable duplicate-file error.
        if (sameSource) return arkPreparation
          ? write(sameSource, { arkPreparation })
          : publicJob(sameSource);
        if (b.voiceId && (!validId(b.voiceId) || (!validVoice(b.voiceId) && !(privateCatalog(tenant) && await privateVoice(b.voiceId))))) throw new Error('请重新加载声音列表后选择可用声音');
        const row = await store.create<Row>(COLLECTION, { tenant_id: tenant, kind: 'creation', request_id: b.requestId,
          payload: { name: b.name.trim(), type: b.type, voiceId: b.voiceId, uploadId: b.uploadId, sourceDigest: upload.payload.digest, fingerprint, authorizationDeclared: true, authorized: false, subjectAdultConfirmed: true, ...(arkPreparation ? { arkPreparation } : {}), ...(reusePresenterId ? { reusePresenterId } : {}), status: 'submitting', consentStatus: 'pending', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
        if (!row) throw new Error('人物任务登记失败，未创建人物');
        const tenantBudgetExempt = budgetExempt(tenant);
        let internalBudgetReserved = false;
        try {
          if (!tenantBudgetExempt) {
            await (options.reserve ? options.reserve(`presenter:${row.id}`) : creationBudget(b.type).reserve('heygen', `presenter:${row.id}`));
            internalBudgetReserved = !options.reserve;
          }
        }
        catch (e) { await write(row, { status: 'failed', error: message(e) }); throw e; }
        try {
          const remote = await client().create(b.type, b.name.trim(), upload.payload.assetId, `presenter:${row.id}`, reuseGroupId || undefined);
          const look = remote.avatar_item ? presenterLook(remote.avatar_item) : undefined;
          const groupId = remote.avatar_group?.id || look?.groupId;
          if (!groupId) throw new Error('创建结果未返回人物组，需管理员核对原任务');
          if (reuseGroupId && groupId !== reuseGroupId) throw new Error('HeyGen 返回的人物组与原授权人物不一致，需核对原任务');
          await write(row, { groupId, look, status: 'processing' });
        } catch (e) {
          if (e instanceof HeyGenRequestError && e.definitive) {
            if (internalBudgetReserved) await creationBudget(b.type).releaseRejected('heygen', `presenter:${row.id}`);
            const capacity = /limit.*(?:avatar|group)|avatar.*slots|slots.*limit/i.test(message(e));
            return write(row, { status: 'failed', failureCategory: capacity ? 'capacity' : 'material', error: capacity ? 'HeyGen 人物名额已满，当前账号不能新增视频人物。请先处理账号人物名额，或使用同一人的已有授权人物；本次未创建人物。' : `${message(e)}。人物任务未创建，请修改素材后重新提交` });
          }
          return write(row, { status: 'uncertain', error: `${message(e)}；请核实原任务，不要重复创建` });
        }
        try { return await refresh(row); } catch (e) { return write(row, { error: message(e) }); }
      });
      res.json(result);
    } catch (e) { res.status(400).json({ error: message(e) }); }
  });
  router.post('/creations/:id/refresh', async (req, res) => {
    // Refresh only reads provider state and reconciles the existing local row. It
    // must remain available after a crashed paid operation leaves a fail-closed
    // creation lock for operator review.
    try { res.json(await refresh(await own(req.params.id, res.locals.tenantId, 'creation'))); }
    catch (e) { res.status(400).json({ error: message(e) }); }
  });
  router.post('/creations/:id/discard', async (req, res) => {
    try {
      const tenant = res.locals.tenantId as string;
      const result = await exclusive(`presenter:${tenant}`, async () => {
        const row = await own(req.params.id, tenant, 'creation');
        if (['submitting', 'processing', 'pending_consent', 'uncertain'].includes(String(row.payload.status || ''))) {
          throw new Error('人物任务仍在处理或待授权，不能删除；请先刷新到明确结果');
        }
        const defaults = (await store.list<Row>('studio_production_defaults', { where: { tenant_id: tenant }, perPage: 1 })).items[0]?.payload as ProductionDefaults | undefined;
        const lookId = String(row.payload.look?.id || '');
        const inUse = defaults?.presenters.some(item => item.avatarId === lookId
          || item.rightsEvidence?.authorizationRef === `document://studio_presenter_assets/${row.id}/${lookId}`);
        if (inUse) throw new Error('该人物已加入企业人物资产，请先在人物资产中取消授权后再删除记录');
        if (!await store.delete(COLLECTION, row.id)) throw new Error('人物创建记录删除失败，请刷新后重试');
        return { ok: true as const, id: row.id };
      });
      res.json(result);
    } catch (e) { res.status(400).json({ error: message(e) }); }
  });
  router.post('/creations/:id/consent', async (req, res) => {
    try {
      const tenant = res.locals.tenantId as string;
      res.json(await exclusive(`presenter:${tenant}`, async () => {
        const row = await own(req.params.id, tenant, 'creation');
        if (!row.payload.groupId) throw new Error('人物尚未创建成功');
        if (!validId(req.body?.requestId)) throw new Error('授权请求标识无效');
        if (row.payload.consentRequestId === req.body.requestId && row.payload.consentRequestedAt) return publicJob(row);
        let assetId: string | undefined;
        if (req.body.uploadId) {
          if (!directConsent()) throw new Error('当前账号未开通直接提交授权视频，请使用本人授权验证入口');
          const upload = await own(String(req.body.uploadId), tenant, 'upload');
          if (!upload.payload.mime.startsWith('video/') || !upload.payload.assetId) throw new Error('请上传授权视频');
          assetId = upload.payload.assetId;
        }
        if (row.payload.type !== 'digital_twin') {
          const refreshed = await refresh(row);
          if (refreshed.status !== 'completed') throw new Error('照片人物仍在处理中，请稍后刷新状态');
          return refreshed;
        }
        if (row.payload.consentRequestedAt) return refresh(row);
        let rerouteUrl: string | undefined;
        if (!assetId && req.body?.rerouteUrl) {
          const candidate = new URL(String(req.body.rerouteUrl));
          const requestOrigin = String(req.get('origin') || '');
          if (!requestOrigin || candidate.origin !== requestOrigin || !['http:', 'https:'].includes(candidate.protocol)) throw new Error('授权返回地址无效');
          rerouteUrl = candidate.href;
        }
        let result;
        try {
          result = await client().consent(row.payload.groupId, `consent:${row.id}:${req.body.requestId}`, assetId, rerouteUrl);
        } catch (error) {
          if (!consentAlreadyProcessing(error)) throw error;
          const refreshed = await refresh(row);
          if (refreshed.status === 'completed') return refreshed;
          return write(row, { consentStatus: refreshed.consentStatus || 'pending', authorized: false,
            consentRequestedAt: row.payload.consentRequestedAt || new Date().toISOString(), status: 'pending_consent', error: '' });
        }
        const consentUrl = mediaUrl(result.url);
        if (consentUrl && !/(^|\.)heygen\.(com|ai)$/.test(new URL(consentUrl).hostname)) throw new Error('授权链接不属于可信供应商');
        if (!assetId && !consentUrl) throw new Error('未返回有效授权链接，请重新获取');
        return write(row, { consentUrl, consentRequestId: req.body.requestId, consentStatus: 'pending', authorized: false, consentRequestedAt: new Date().toISOString(), status: 'pending_consent',
          error: assetId ? '授权视频已提交审核，请稍后刷新状态' : '' });
      }));
    } catch (e) { res.status(400).json({ error: message(e) }); }
  });
  router.post('/import', async (req, res) => {
    try {
      const b = req.body || {}, tenant = res.locals.tenantId as string;
      if (b.reviewed !== true) throw new Error('请预览并确认使用所选人物和声音');
      if (b.makeDefault === true && b.authorized !== true) throw new Error('请确认人物和声音使用授权后再保存为默认人物');
      let look: PresenterLook;
      let defaultVoice: string | undefined;
      let creationMode: PresenterAsset['creationMode'];
      let arkPreparation: ArkPresenterPreparation | undefined;
      let privateLook = false;
      let privateGroupConsent = false;
      if (b.creationId) {
        const job = await refresh(await own(String(b.creationId), tenant, 'creation'));
        if (job.status !== 'completed' || !job.look) throw new Error('人物训练或本人授权尚未完成');
        look = job.look; defaultVoice = job.voiceId; creationMode = job.type === 'digital_twin' ? 'expert' : 'quick';
        arkPreparation = job.arkPreparation;
      } else {
        const cached = publicLooks.get(`${tenant}:${String(b.lookId)}`);
        if (!cached || Date.now() - cached.at > 300000) throw new Error('请刷新可用人物列表后重新选择');
        privateLook = cached.private;
        if (privateLook) await checkPrivateAccount(tenant);
        look = await client().look(cached.look.id);
        if (privateLook) {
          if (!look.groupId) throw new Error('人物缺少可核验的授权记录');
          const group = await client().group(look.groupId);
          if (group.status !== 'completed' || (group.consent_status && !consentAccepted(group.consent_status))) throw new Error('人物训练或本人授权尚未完成');
          privateGroupConsent = consentAccepted(group.consent_status);
          if (!privateGroupConsent && look.avatarType !== 'photo_avatar') throw new Error('当前人物缺少可核验的本人授权');
          if (b.authorized !== true || b.adultConfirmed !== true) throw new Error('请确认当前企业拥有此人物及声音的使用授权，且人物为成年人');
        }
      }
      if (look.status !== 'completed') throw new Error('人物尚不可用');
      const voiceId = String(b.voiceId || defaultVoice || look.voiceId || '');
      if (!voiceId) throw new Error('请选择声音');
      if (voiceId !== defaultVoice && voiceId !== look.voiceId) {
        if (!validVoice(voiceId) && !(privateCatalog(tenant) && await privateVoice(voiceId))) throw new Error('请重新加载声音列表后选择可用声音');
      }
      const clonedVoice = await cloneByHeygenVoice(tenant, voiceId);
      const arkVoice = clonedVoice?.payload?.arkVoice;
      const arkVoiceMapping = clonedVoice?.payload?.referenceAudioMaterialId ? {
        referenceAudioMaterialId: String(clonedVoice.payload.referenceAudioMaterialId),
        ...(arkVoice?.speakerId && arkVoice.status !== 'failed' ? { speakerId: String(arkVoice.speakerId) } : {}),
      } : undefined;
      const result = await exclusive(`defaults:${tenant}`, async () => {
        const row = (await store.list<Row>('studio_production_defaults', { where: { tenant_id: tenant }, perPage: 1 })).items[0];
        const defaults: ProductionDefaults = row?.payload || EMPTY_DEFAULTS;
        const previous = defaults.presenters.find(p => p.avatarId === look.id && p.voiceId === voiceId);
        const privateRights = async (allowCreate = true): Promise<NonNullable<PresenterAsset['rightsEvidence']>> => {
          const requestId = hash(`${tenant}:${look.id}:${voiceId}:${look.groupId}`);
          let evidence = await find(tenant, 'import_authorization', requestId);
          if (!evidence && !allowCreate) throw new Error('人物授权原始记录不存在，不能重新选为默认人物');
          if (!evidence) {
            const created = await store.create<Row>(COLLECTION, { tenant_id: tenant, kind: 'import_authorization', request_id: requestId,
              payload: { lookId: look.id, voiceId, groupId: look.groupId, avatarType: look.avatarType,
                authorizationDeclared: true, adultConfirmed: true, reviewed: true, providerConsentAccepted: privateGroupConsent,
                createdAt: new Date().toISOString() } });
            if (!created) throw new Error('人物授权留档失败，未导入企业资产');
            evidence = created;
          }
          if (evidence.tenant_id !== tenant || evidence.kind !== 'import_authorization'
            || evidence.request_id !== requestId || evidence.payload?.lookId !== look.id
            || evidence.payload?.voiceId !== voiceId || evidence.payload?.groupId !== look.groupId
            || evidence.payload?.authorizationDeclared !== true || evidence.payload?.adultConfirmed !== true
            || evidence.payload?.reviewed !== true || evidence.payload?.providerConsentAccepted !== privateGroupConsent
            || evidence.payload?.revokedAt) {
            throw new Error('人物授权原始记录不一致，不能导入企业资产');
          }
          return { authorizationRef: `document://studio_presenter_assets/${evidence.id}/${look.id}`,
            consentRef: privateGroupConsent ? `consent://heygen/${look.groupId}` : `consent://user-declaration/${evidence.id}`,
            grantedAt: evidence.payload.createdAt, subjectAdultConfirmed: true,
            permittedProviders: ['heygen'], permittedUses: ['digital_presenter', 'voice_synthesis'] };
        };
        if (previous) {
          if (!previous.authorized) throw new Error('该人物使用授权尚未确认，请重新完成授权');
          let upgradedRightsEvidence = previous.rightsEvidence;
          let rightsEvidenceChanged = false;
          if (privateLook && String(previous.rightsEvidence?.authorizationRef || '').startsWith('document://studio_presenter_assets/')) {
            const retained = await privateRights(false);
            if (previous.rightsEvidence?.authorizationRef !== retained.authorizationRef
              || previous.rightsEvidence?.consentRef !== retained.consentRef) {
              throw new Error('人物授权原始记录不一致，不能重新选为默认人物');
            }
          } else if (privateLook) {
            upgradedRightsEvidence = await privateRights();
            rightsEvidenceChanged = true;
          }
          const preparedIds = arkPreparation ? [arkPreparation.photoMaterialId, arkPreparation.videoMaterialId] : [];
          const referenceMaterialIds = [...new Set([...(previous.referenceMaterialIds || []), ...preparedIds])];
          const needsMaterials = referenceMaterialIds.length !== (previous.referenceMaterialIds || []).length;
          const needsArkVoice = Boolean(arkVoiceMapping && JSON.stringify(previous.toolMappings?.volcengineArk || null) !== JSON.stringify(arkVoiceMapping));
          if (!needsMaterials && !needsArkVoice && !rightsEvidenceChanged && (b.makeDefault !== true || defaults.defaultPresenterId === previous.id)) return defaults;
          const payload = { ...defaults,
            presenters: defaults.presenters.map(p => p.id === previous.id ? { ...p,
              ...(rightsEvidenceChanged ? { rightsEvidence: upgradedRightsEvidence, assetVersion: Math.max(1, Number(p.assetVersion) || 1) + 1 } : {}),
              ...(needsMaterials ? { referenceMaterialIds } : {}),
              ...(arkVoiceMapping ? { toolMappings: { ...p.toolMappings, volcengineArk: arkVoiceMapping } } : {}) } : p),
            defaultPresenterId: b.makeDefault === true ? previous.id : defaults.defaultPresenterId };
          if (!await store.update('studio_production_defaults', row!.id, { payload })) throw new Error('默认人物保存失败，请重试');
          return payload;
        }
        if (defaults.presenters.length >= 50) throw new Error('企业人物已达到 50 个上限');
        const createdByTenant = Boolean(b.creationId);
        const baseRightsEvidence: NonNullable<PresenterAsset['rightsEvidence']> = createdByTenant
          ? { authorizationRef: `document://studio_presenter_assets/${String(b.creationId)}/${look.id}`, consentRef: creationMode === 'quick' ? `consent://user-declaration/${String(b.creationId)}` : `consent://heygen/${look.groupId || look.id}`, grantedAt: new Date().toISOString(), subjectAdultConfirmed: true, permittedProviders: arkVoiceMapping ? ['heygen', 'volcengine_ark'] : ['heygen'], permittedUses: ['digital_presenter', 'voice_synthesis'], ...(arkVoiceMapping ? { providerScopes: [{ provider: 'heygen' as const, uses: ['digital_presenter' as const, 'voice_synthesis' as const] }, { provider: 'volcengine_ark' as const, uses: ['voice_synthesis' as const] }] } : {}) }
          : privateLook
            ? await privateRights()
            : { authorizationRef: `license://heygen/public-catalog/${look.id}`, consentRef: `license://heygen/public-catalog/${look.groupId || look.id}`, grantedAt: new Date().toISOString(), subjectAdultConfirmed: false, permittedProviders: ['heygen'], permittedUses: ['digital_presenter', 'voice_synthesis'] };
        const rightsEvidence = arkVoiceMapping && privateLook
          ? { ...baseRightsEvidence,
              permittedProviders: [...new Set([...baseRightsEvidence.permittedProviders, 'volcengine_ark' as const])],
              permittedUses: [...new Set([...baseRightsEvidence.permittedUses, 'voice_synthesis' as const])],
              providerScopes: [...(baseRightsEvidence.providerScopes || []).filter(scope => scope.provider !== 'volcengine_ark'), { provider: 'volcengine_ark' as const, uses: ['voice_synthesis' as const] }],
            }
          : baseRightsEvidence;
        const presenter: PresenterAsset = { id: `presenter-${hash(`${look.id}:${voiceId}`).slice(0, 24)}`, name: String(b.name || look.name).slice(0, 100), avatarId: look.id, voiceId, authorized: true,
          ...(arkPreparation ? { referenceMaterialIds: [arkPreparation.photoMaterialId, arkPreparation.videoMaterialId] } : {}),
          supportsAlpha: false, nativeOrientation: look.orientation, imageUrl: look.imageUrl, videoUrl: look.videoUrl, creationMode, assetVersion: 1, capabilities: ['talking'], toolMappings: { heygen: { avatarId: look.id, voiceId }, ...(arkVoiceMapping ? { volcengineArk: arkVoiceMapping } : {}) }, rightsEvidence };
        const payload = { ...defaults, presenters: [...defaults.presenters, presenter], defaultPresenterId: b.makeDefault === true ? presenter.id : defaults.defaultPresenterId || presenter.id };
        const saved = row ? await store.update('studio_production_defaults', row.id, { payload }) : await store.create('studio_production_defaults', { tenant_id: tenant, payload });
        if (!saved) throw new Error('企业人物保存失败，请重试导入');
        return payload;
      });
      res.json(result);
    } catch (e) { res.status(400).json({ error: message(e) }); }
  });
  router.post('/revoke', async (req, res) => {
    try {
      const tenant = res.locals.tenantId as string;
      const presenterId = String(req.body?.presenterId || '');
      if (!validId(presenterId)) throw new Error('人物标识无效');
      const result = await exclusive(`defaults:${tenant}`, async () => {
        const row = (await store.list<Row>('studio_production_defaults', { where: { tenant_id: tenant }, perPage: 1 })).items[0];
        if (!row) throw new Error('企业人物资料不存在');
        const defaults = row.payload as ProductionDefaults;
        const presenter = defaults.presenters.find(item => item.id === presenterId);
        if (!presenter) return defaults;
        const revokedAt = new Date().toISOString();
        const requestId = `revoke:${presenterId}:${Math.max(1, presenter.assetVersion || 1)}`;
        const previous = await find(tenant, 'revocation', requestId);
        if (!previous) {
          const audit = await store.create<Row>(COLLECTION, {
            tenant_id: tenant,
            kind: 'revocation',
            request_id: requestId,
            payload: {
              presenterId,
              presenterName: presenter.name,
              assetVersion: Math.max(1, presenter.assetVersion || 1),
              rightsEvidence: presenter.rightsEvidence ? { ...presenter.rightsEvidence, revokedAt } : undefined,
              revokedAt,
            },
          });
          if (!audit) throw new Error('人物授权取消记录保存失败');
        }
        const presenters = defaults.presenters.filter(item => item.id !== presenterId);
        const next: ProductionDefaults = {
          ...defaults,
          presenters,
          defaultPresenterId: defaults.defaultPresenterId === presenterId ? presenters[0]?.id || '' : defaults.defaultPresenterId,
          presenterRoutes: (defaults.presenterRoutes || []).map(route => route.presenterId === presenterId
            ? { ...route, presenterId: '', voiceId: '' }
            : route),
        };
        if (!await store.update('studio_production_defaults', row.id, { payload: next })) throw new Error('人物授权取消失败，请刷新后重试');
        return next;
      });
      res.json(result);
    } catch (e) { res.status(400).json({ error: message(e) }); }
  });
  return router;
}
