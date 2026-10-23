import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import type { DataStore } from '../storage/datastore.js';
import { createProductionRouter } from '../routes/production.js';
import { checkAvatarMedia } from './avatarMediaCheck.js';
import { readLocalMaterials, saveLocalMaterials, updateLocalMaterial } from './materialLibrary.js';
import { tenantAssetDir, tenantAssetRelativePath } from './assetAccess.js';
import { isTenantPrivateObjectKey, materialAssetObjectKey } from '../storage/materialAssets.js';
import { objectStorageEnabled, objectStorageHead, objectStorageUpload } from '../storage/objectStorage.js';
import { materializeShotAudioSegment } from './shotAudioSegment.js';
import { RunwayActTwoAdapter } from './runwayActTwoAdapter.js';
import { prepareRunwayReferenceInputs } from './runwayReferenceInputs.js';
import { importRunwayReferenceOutput } from './runwayReferenceOutput.js';
import { referencePaidBudget } from './referencePaidBudget.js';
import { validatePresenterReferenceMaterials } from './presenterMaterialValidation.js';
import { createFastHeadLocalProcessor, recoverFastHeadOutput } from './fastHeadLocalProcessor.js';
import { RunwayFastHeadAdapter } from './runwayFastHeadAdapter.js';
import { SeedanceReferenceAdapter } from './seedanceReferenceAdapter.js';
import { extractSentenceFirstFrames } from './sentenceFirstFramePipeline.js';
import { runProductionSentenceReplication } from './sentenceReplicationProduction.js';
import { prepareLocalSeedanceMotionGuide } from './seedanceMotionGuide.js';
import { runProductionQwenFirstFrameDrafts } from './sentenceFirstFrameDraftProduction.js';
import { VolcengineArkAssets } from './volcengineArkAssets.js';

const MEDIA_ROOT = path.resolve(process.cwd(), 'data/media');
const TTS_ROOT = path.resolve(process.cwd(), 'data/tts');

export async function verifyStoredCandidateOutput(
  evidence: { objectKey?: string; localFile?: string; contentSha256: string; objectEtag?: string },
  tenantId: string,
  dependencies: { mediaRoot?: string; head?: typeof objectStorageHead } = {},
): Promise<boolean> {
  if (evidence.objectKey && evidence.objectEtag) {
    if (!isTenantPrivateObjectKey(evidence.objectKey, tenantId)) return false;
    const current = await (dependencies.head || objectStorageHead)(evidence.objectKey);
    return Boolean(current?.size && current.etag && String(current.etag) === evidence.objectEtag);
  }
  if (!evidence.localFile) return false;
  const mediaRoot = path.resolve(dependencies.mediaRoot || MEDIA_ROOT);
  const tenantRoot = path.resolve(tenantAssetDir(mediaRoot, tenantId));
  const candidate = path.resolve(mediaRoot, evidence.localFile);
  if (candidate !== tenantRoot && !candidate.startsWith(`${tenantRoot}${path.sep}`)) return false;
  try {
    const bytes = fs.readFileSync(candidate);
    return bytes.length > 0 && createHash('sha256').update(bytes).digest('hex') === evidence.contentSha256;
  } catch { return false; }
}

export async function recoverStoredCandidateOutput(
  material: { id: string; objectKey?: string; file?: string; contentSha256?: string; objectEtag?: string },
  tenantId: string,
  dependencies: { mediaRoot?: string; head?: typeof objectStorageHead } = {},
): Promise<{ materialId: string; objectKey?: string; localFile?: string; contentSha256: string; objectEtag?: string } | undefined> {
  if (!/^[a-f0-9]{64}$/i.test(String(material.contentSha256 || ''))) return undefined;
  const contentSha256 = String(material.contentSha256).toLowerCase();
  let evidence: { materialId: string; objectKey?: string; localFile?: string; contentSha256: string; objectEtag?: string } | undefined;
  if (material.objectKey && material.objectEtag) {
    evidence = { materialId: material.id, objectKey: material.objectKey, contentSha256, objectEtag: material.objectEtag };
  } else if (!material.objectKey && material.file) evidence = { materialId: material.id, localFile: material.file, contentSha256 };
  if (!evidence || !await verifyStoredCandidateOutput(evidence, tenantId, dependencies)) return undefined;
  return evidence;
}

export async function verifyStoredReferenceInputs(
  snapshot: { presenterInput?: { objectKey: string; objectEtag?: string } | null; referenceInput?: { clipObjectKey: string; clipObjectEtag?: string } | null },
  tenantId: string,
  head: typeof objectStorageHead = objectStorageHead,
): Promise<boolean> {
  const presenter = snapshot.presenterInput; const reference = snapshot.referenceInput;
  if (!presenter?.objectKey || !presenter.objectEtag || !reference?.clipObjectKey || !reference.clipObjectEtag
    || !isTenantPrivateObjectKey(presenter.objectKey, tenantId) || !isTenantPrivateObjectKey(reference.clipObjectKey, tenantId)) return false;
  const [presenterObject, referenceObject] = await Promise.all([head(presenter.objectKey), head(reference.clipObjectKey)]);
  return Boolean(presenterObject?.size && referenceObject?.size && presenterObject.etag && referenceObject.etag
    && String(presenterObject.etag) === presenter.objectEtag && String(referenceObject.etag) === reference.clipObjectEtag);
}

function humanSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function tenantTtsFile(url: string, tenantId: string): Buffer | null {
  if (!url.startsWith('/tts/') && !url.includes('/private-assets/tts/')) return null;
  const file = path.join(tenantAssetDir(TTS_ROOT, tenantId), path.basename(new URL(url, 'http://local').pathname));
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

export function runwayActTwoReadiness(input: {
  enabled?: string;
  apiSecret?: string;
  objectStorageEnabled: boolean;
  cnyPerCredit?: string;
  estimatedCnyPerSecond?: string;
  maxCnyPerShot?: string;
  monthlyBudgetCny?: string;
}): { ready: boolean; reason: string } {
  const positiveFinite = (value?: string) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0;
  };
  const missing = [
    ...(input.enabled === 'true' ? [] : ['显式开关 RUNWAY_ACT_TWO_ENABLED=true']),
    ...(input.apiSecret?.trim() ? [] : ['RUNWAYML_API_SECRET']),
    ...(input.objectStorageEnabled ? [] : ['对象存储']),
    ...(positiveFinite(input.cnyPerCredit) ? [] : ['RUNWAY_ACT_TWO_CNY_PER_CREDIT']),
    ...(positiveFinite(input.estimatedCnyPerSecond) ? [] : ['RUNWAY_ACT_TWO_ESTIMATED_CNY_PER_SECOND']),
    ...(positiveFinite(input.maxCnyPerShot) ? [] : ['DIGITAL_HUMAN_REFERENCE_MAX_CNY_PER_SHOT']),
    ...(positiveFinite(input.monthlyBudgetCny) ? [] : ['DIGITAL_HUMAN_REFERENCE_MONTHLY_BUDGET_CNY']),
  ];
  return { ready: missing.length === 0, reason: missing.length ? `Runway Act-Two 尚不可执行，缺少：${missing.join('、')}` : '' };
}

export function seedanceReferenceReadiness(input: { enabled?: string; apiKey?: string; model?: string; objectStorageEnabled: boolean; estimatedCnyPerSecond?: string; maxCnyPerShot?: string; monthlyBudgetCny?: string }) {
  const positive = (value?: string) => Number.isFinite(Number(value)) && Number(value) > 0;
  const missing = [...(input.enabled === 'true' ? [] : ['SEEDANCE_REFERENCE_ENABLED=true']), ...(input.apiKey?.trim() ? [] : ['SEEDANCE_API_KEY']),
    ...(input.model?.trim() ? [] : ['SEEDANCE_MODEL']), ...(input.objectStorageEnabled ? [] : ['对象存储']),
    ...(positive(input.estimatedCnyPerSecond) ? [] : ['SEEDANCE_REFERENCE_ESTIMATED_CNY_PER_SECOND']),
    ...(positive(input.maxCnyPerShot) ? [] : ['DIGITAL_HUMAN_REFERENCE_MAX_CNY_PER_SHOT']), ...(positive(input.monthlyBudgetCny) ? [] : ['DIGITAL_HUMAN_REFERENCE_MONTHLY_BUDGET_CNY'])];
  return { ready: missing.length === 0, reason: missing.length ? `Seedance 参考人物尚不可执行，缺少：${missing.join('、')}` : '' };
}

export function visualQaReadiness(
  pythonPath: string | undefined,
  access: (path: string, mode: number) => void = fs.accessSync,
  probe: (path: string) => { status: number | null; error?: Error } = executable => spawnSync(executable,
    ['-c', 'import cv2, mediapipe, skimage; print("visual-qa-ready")'],
    { timeout: 10_000, encoding: 'utf8', env: { ...process.env, PYTHONNOUSERSITE: '1' } }),
): { ready: boolean; reason: string } {
  const executable = String(pythonPath || '').trim();
  if (!executable) return { ready: false, reason: '未配置 DIGITAL_HUMAN_VISUAL_QA_PYTHON，视觉代理检查转为人工验收' };
  try {
    access(executable, fs.constants.X_OK);
  } catch {
    return { ready: false, reason: 'DIGITAL_HUMAN_VISUAL_QA_PYTHON 不存在或不可执行，视觉代理检查转为人工验收' };
  }
  const result = probe(executable);
  if (result.error || result.status !== 0) return { ready: false, reason: '数字人视觉质检 Python 缺少 OpenCV、MediaPipe 或 scikit-image 依赖，视觉代理检查转为人工验收' };
  return { ready: true, reason: '' };
}

export function createStudioAvatarProductionRouter(store: DataStore) {
  const arkAssets = new VolcengineArkAssets();
  const runwayReadiness = runwayActTwoReadiness({ enabled: process.env.RUNWAY_ACT_TWO_ENABLED, apiSecret: process.env.RUNWAYML_API_SECRET,
    objectStorageEnabled: objectStorageEnabled(), cnyPerCredit: process.env.RUNWAY_ACT_TWO_CNY_PER_CREDIT,
    estimatedCnyPerSecond: process.env.RUNWAY_ACT_TWO_ESTIMATED_CNY_PER_SECOND, maxCnyPerShot: process.env.DIGITAL_HUMAN_REFERENCE_MAX_CNY_PER_SHOT,
    monthlyBudgetCny: process.env.DIGITAL_HUMAN_REFERENCE_MONTHLY_BUDGET_CNY });
  const runwayEnabled = runwayReadiness.ready;
  const seedanceReadiness = seedanceReferenceReadiness({ enabled: process.env.SEEDANCE_REFERENCE_ENABLED, apiKey: process.env.SEEDANCE_API_KEY, model: process.env.SEEDANCE_MODEL,
    objectStorageEnabled: objectStorageEnabled(), estimatedCnyPerSecond: process.env.SEEDANCE_REFERENCE_ESTIMATED_CNY_PER_SECOND,
    maxCnyPerShot: process.env.DIGITAL_HUMAN_REFERENCE_MAX_CNY_PER_SHOT, monthlyBudgetCny: process.env.DIGITAL_HUMAN_REFERENCE_MONTHLY_BUDGET_CNY });
  const visualQa = visualQaReadiness(process.env.DIGITAL_HUMAN_VISUAL_QA_PYTHON);
  const runway = runwayEnabled ? new RunwayActTwoAdapter({ apiSecret: process.env.RUNWAYML_API_SECRET!,
    cnyPerCredit: Number(process.env.RUNWAY_ACT_TWO_CNY_PER_CREDIT), estimatedCostCnyPerSecond: Number(process.env.RUNWAY_ACT_TWO_ESTIMATED_CNY_PER_SECOND),
    qualityInspection: visualQa.ready }) : null;
  const seedance = seedanceReadiness.ready ? new SeedanceReferenceAdapter({ apiKey: process.env.SEEDANCE_API_KEY!, model: process.env.SEEDANCE_MODEL!, baseUrl: process.env.SEEDANCE_BASE_URL,
    estimatedCostCnyPerSecond: Number(process.env.SEEDANCE_REFERENCE_ESTIMATED_CNY_PER_SECOND), cnyPerThousandTokens: Number(process.env.SEEDANCE_CNY_PER_1K_TOKENS) || undefined,
    resolution: (process.env.SEEDANCE_REFERENCE_RESOLUTION || '720p') as '480p' | '720p' | '1080p',
    generateAudio: process.env.SEEDANCE_REFERENCE_GENERATE_AUDIO !== 'false' }) : null;
  const fastHeadEnabled = runway && process.env.DIGITAL_HUMAN_FAST_HEAD_ENABLED === 'true' && Boolean(String(process.env.DIGITAL_HUMAN_FAST_HEAD_PYTHON || '').trim());
  const fastHead = fastHeadEnabled ? new RunwayFastHeadAdapter({ root: path.resolve(process.cwd(), 'data/digital-human/fast-head'), upstream: runway,
    process: createFastHeadLocalProcessor(), estimatedCostCnyPerSecond: Number(process.env.RUNWAY_ACT_TWO_ESTIMATED_CNY_PER_SECOND) }) : null;
  return createProductionRouter(store, async (url, duration, job, input, tenantId) => {
    const id = `avatar-${job.id.replace(/[^A-Za-z0-9-]/g, '')}`;
    const materials = readLocalMaterials();
    const existing = materials.find(item => item.id === id && item.tenantId === tenantId);
    if (existing?.avatarMediaCheck?.version === 1 && (!input.transparent || existing.avatarMediaCheck.alphaVerified)) {
      const recovered = await recoverStoredCandidateOutput(existing, tenantId);
      if (recovered) return recovered;
    }
    const remote = new URL(url);
    if (remote.protocol !== 'https:' || remote.username || remote.password || remote.port || !/(^|\.)heygen\.(ai|com)$/i.test(remote.hostname)) throw new Error('供应商输出不在已核验的HeyGen素材域名中，已阻止自动下载');
    const response = await fetch(remote, { redirect: 'error', signal: AbortSignal.timeout(90000) });
    if (!response.ok || !response.body) throw new Error('数字人视频下载失败');
    const maxBytes = 110 * 1024 * 1024;
    if (Number(response.headers.get('content-length')) > maxBytes) { await response.body.cancel(); throw new Error('数字人素材超过110MB'); }
    const reader = response.body.getReader(); const chunks: Buffer[] = []; let size = 0;
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.length; if (size > maxBytes) { await reader.cancel(); throw new Error('数字人素材超过110MB'); }
      chunks.push(Buffer.from(part.value));
    }
    if (!size) throw new Error('数字人视频为空');
    const file = `${id}-${randomUUID()}.${input.transparent ? 'webm' : 'mp4'}`;
    const relativeFile = tenantAssetRelativePath(tenantId, file);
    const objectKey = objectStorageEnabled() ? materialAssetObjectKey(tenantId, file) : undefined;
    const bytes = Buffer.concat(chunks);
    const contentSha256 = createHash('sha256').update(bytes).digest('hex');
    const checkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingshu-avatar-check-'));
    let checked;
    try {
      const checkFile = path.join(checkDir, file);
      fs.writeFileSync(checkFile, bytes, { mode: 0o600 });
      checked = await checkAvatarMedia(checkFile, { ratio: input.ratio, duration, transparent: input.transparent });
    } finally { fs.rmSync(checkDir, { recursive: true, force: true }); }
    let objectEtag: string | undefined;
    if (objectKey) {
      await objectStorageUpload({ key: objectKey, body: bytes, contentType: input.transparent ? 'video/webm' : 'video/mp4' });
      const uploaded = await objectStorageHead(objectKey);
      if (!uploaded?.size || !uploaded.etag) throw new Error('数字人视频已上传但无法取得对象版本，未写入候选素材');
      objectEtag = String(uploaded.etag);
    }
    else { fs.mkdirSync(tenantAssetDir(MEDIA_ROOT, tenantId), { recursive: true }); fs.writeFileSync(path.join(MEDIA_ROOT, relativeFile), bytes); }
    const material = {
      id, name: `数字人口播 · ${input.title}`, folder: 'presenter', type: 'video', duration: checked.duration,
      width: checked.width, height: checked.height, aspectRatio: checked.width / checked.height, avatarMediaCheck: checked,
      size: humanSize(size), file: relativeFile, url: objectKey ? '' : `/media/${relativeFile}`, objectKey, contentSha256, objectEtag,
      scope: 'own', tenantId, usage: 'editable', sourceType: 'heygen', createdAt: new Date().toISOString(),
      generation: { pipelineId: 'digital_human_1', assetGenerationKind: 'digital_human', pipelineVersion: 'studio-avatar.v1',
        executionId: String(job.id), provider: 'heygen', model: 'avatar_video', providerTaskId: String((job as any).providerTaskId || job.id),
        idempotencyKey: String(job.id), inputFingerprint: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
        promptOrSpecHash: createHash('sha256').update(JSON.stringify({ title: input.title, ratio: input.ratio, transparent: input.transparent })).digest('hex'),
        inputMaterialIds: [] },
      lineage: { sourceShotId: String((job as any).shotId || '') || undefined },
      quality: { state: 'accepted', policyVersion: 'avatar-media-check.v1', checkedAt: new Date().toISOString(),
        checks: [{ key: 'avatar_media', status: 'passed', evidence: `${checked.width}x${checked.height} · ${checked.duration.toFixed(3)}s` }], rawReport: checked },
      reuse: { eligible: true, reason: 'quality_accepted', usageCount: 0 }, rightsScope: 'tenant_generated_reusable', generationState: 'archived',
    };
    saveLocalMaterials([...materials.filter(item => !(item.id === id && item.tenantId === tenantId)), material]);
    return objectKey && objectEtag ? { materialId: id, objectKey, contentSha256, objectEtag } : { materialId: id, localFile: relativeFile, contentSha256 };
  }, { adapters: [...(fastHead ? [fastHead] : []), ...(seedance ? [seedance] : []), ...(runway ? [runway] : [])], referenceBudgetLimitCny: Number.isFinite(Number(process.env.DIGITAL_HUMAN_REFERENCE_MAX_CNY_PER_SHOT)) ? Number(process.env.DIGITAL_HUMAN_REFERENCE_MAX_CNY_PER_SHOT) : undefined,
    reserveReference: (tool, id, estimatedCostCny, tenantId) => referencePaidBudget.reserve(tool, id, estimatedCostCny, tenantId),
    releaseReference: (tool, id, tenantId) => referencePaidBudget.release(tool, id, tenantId),
    verifyCandidateOutput: verifyStoredCandidateOutput,
    verifyReferenceInputs: verifyStoredReferenceInputs,
    resolveReferenceInputs: prepareRunwayReferenceInputs,
    importReferenceVideo: (url, execution, tenantId) => importRunwayReferenceOutput(url, execution, tenantId, {
      ...(visualQa.ready ? {} : { inspectVisual: undefined }),
      allowedHost: hostname => ['.cloudfront.net', '.volces.com'].some(suffix => hostname.toLowerCase().endsWith(suffix)),
    }),
    importReferenceObject: (objectKey, execution, tenantId) => recoverFastHeadOutput(objectKey, tenantId, execution.id),
    validatePresenterMaterials: validatePresenterReferenceMaterials,
    bindArkAsset: async ({ tenantId, presenterId, certification }) => {
      const active = certification.status === 'active' && certification.assetType === 'image';
      const updated = updateLocalMaterial(certification.materialId, tenantId, {
        presenterAssetId: presenterId,
        seedanceTrustedAsset: active ? { uri: certification.assetUri, kind: 'image', status: 'active', provider: 'volcengine_ark' } : null,
        seedanceTrustedAssetUri: active ? certification.assetUri : '', seedanceTrustedAssetKind: active ? 'image' : '',
        seedanceTrustedAssetStatus: active ? 'active' : certification.status, seedanceTrustedAssetProvider: active ? 'volcengine_ark' : '',
      });
      if (!updated) throw new Error('方舟认证对应的人物图片不存在或不属于当前企业');
    },
    verifyArkAsset: async ({ projectName, groupId, assetId }) => {
      const asset = await arkAssets.findImage(projectName, groupId, assetId);
      if (!asset) throw new Error('方舟资产组内未找到该图片资产');
      return { status: asset.Status === 'Active' ? 'active' as const : asset.Status === 'Failed' ? 'failed' as const : 'processing' as const, assetType: 'image' as const, failureReason: asset.Error?.Message };
    },
    prepareSentenceFirstFrames: input => extractSentenceFirstFrames(input),
    generateSentenceFirstFrameDrafts: input=>runProductionQwenFirstFrameDrafts(input),
    runSentenceReplication: input => runProductionSentenceReplication({ ...input, prepareMotionGuide: async value => {
      const prepared = await prepareLocalSeedanceMotionGuide({ tenantId:value.tenantId, cueId:value.cue.id, sourceVideoPath:value.sourceVideoPath,
        padToSeconds: Number(value.cue.generationDurationSeconds || 0) });
      return { url:prepared.url, identityRemoved:prepared.identityRemoved, motionOnly:prepared.motionOnly };
    } }),
    toolUnavailableReasons: { ...(runway ? {} : { runway_act_two: runwayReadiness.reason }), ...(!fastHead ? { local_head_pipeline: !runway ? runwayReadiness.reason : '严格人物替换尚未启用，需配置 DIGITAL_HUMAN_FAST_HEAD_ENABLED=true 和 DIGITAL_HUMAN_FAST_HEAD_PYTHON' } : {}),
      ...(!seedance ? { runway_seedance: seedanceReadiness.reason } : {}), runway_kling_motion: 'Kling 尚未注册真实执行适配器', self_hosted_video: '自有模型尚未注册真实执行适配器' },
    prepareAudio: async (ref, tenantId) => {
    const media = tenantTtsFile(ref.url, tenantId);
    if (!media || !ffmpegStatic) throw new Error('统一旁白不在当前企业可用本地音频中，请重新生成或上传旁白');
    const tenantRoot = tenantAssetDir(TTS_ROOT, tenantId); fs.mkdirSync(tenantRoot, { recursive: true });
    const source = path.join(tenantRoot, `.segment-source-${randomUUID()}`);
    try {
      fs.writeFileSync(source, media, { mode: 0o600 });
      return await materializeShotAudioSegment({ sourcePath: source, outputDir: path.join(tenantRoot, 'shot-segments'), start: ref.start, duration: ref.duration, ffmpegPath: String(ffmpegStatic) });
    } finally { fs.rmSync(source, { force: true }); }
  } });
}
