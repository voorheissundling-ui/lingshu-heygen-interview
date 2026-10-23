import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { DigitalHumanExecutionRecord } from '../../src/lib/digitalHumanPlan.js';
import type { ReferenceTechnicalMetrics } from '../../src/lib/digitalHumanQuality.js';
import type { ReferenceVisualMetrics } from '../../src/lib/digitalHumanQuality.js';
import { inspectPersonReplacementPair } from './personReplacementMediaQuality.js';
import { inspectPersonReplacementVisualPair } from './personReplacementVisualQuality.js';
import { readLocalMaterials, saveLocalMaterials, type MaterialRecord } from './materialLibrary.js';
import { isTenantPrivateObjectKey, materialAssetObjectKey } from '../storage/materialAssets.js';
import { objectStorageDownload, objectStorageHead, objectStorageUpload } from '../storage/objectStorage.js';

const MAX_BYTES = 500 * 1024 * 1024;
type Dependencies = {
  transport: typeof fetch;
  download: typeof objectStorageDownload;
  head: typeof objectStorageHead;
  upload: typeof objectStorageUpload;
  materials: () => MaterialRecord[];
  saveMaterials: typeof saveLocalMaterials;
  inspect: typeof inspectPersonReplacementPair;
  inspectVisual?: (sourcePath: string, candidatePath: string) => Promise<ReferenceVisualMetrics>;
  allowedHost: (hostname: string) => boolean;
};

function defaultAllowedHost(hostname: string): boolean {
  const configured = String(process.env.RUNWAY_OUTPUT_HOST_SUFFIXES || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  const suffixes = configured.length ? configured : ['.cloudfront.net'];
  const host = hostname.toLowerCase();
  return suffixes.some(suffix => host === suffix.replace(/^\./, '') || host.endsWith(suffix.startsWith('.') ? suffix : `.${suffix}`));
}

const defaults = (): Dependencies => ({ transport: fetch, download: objectStorageDownload, head: objectStorageHead, upload: objectStorageUpload,
  materials: readLocalMaterials, saveMaterials: saveLocalMaterials, inspect: inspectPersonReplacementPair,
  ...(process.env.DIGITAL_HUMAN_VISUAL_QA_PYTHON ? { inspectVisual: inspectPersonReplacementVisualPair } : {}), allowedHost: defaultAllowedHost });

function safeOutputUrl(raw: string, allowedHost: Dependencies['allowedHost']): URL {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !allowedHost(url.hostname)) {
    throw new Error('Runway 输出不在已配置的 HTTPS 素材域名中，已阻止自动下载');
  }
  return url;
}

async function downloadOutput(url: URL, transport: typeof fetch): Promise<{ bytes: Buffer; contentType: string }> {
  const response = await transport(url, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`Runway 视频下载失败（HTTP ${response.status}）`);
  const contentType = String(response.headers.get('content-type') || '').split(';', 1)[0]!.toLowerCase();
  if (contentType && !contentType.startsWith('video/') && contentType !== 'application/octet-stream') throw new Error('Runway 输出不是可识别的视频文件');
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_BYTES) { await response.body.cancel(); throw new Error('Runway 输出超过 500MB'); }
  const reader = response.body.getReader(); const chunks: Buffer[] = []; let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_BYTES) { await reader.cancel(); throw new Error('Runway 输出超过 500MB'); }
    chunks.push(Buffer.from(part.value));
  }
  if (!size) throw new Error('Runway 输出视频为空');
  return { bytes: Buffer.concat(chunks), contentType: contentType || 'video/mp4' };
}

function technicalMetrics(value: Awaited<ReturnType<typeof inspectPersonReplacementPair>>): ReferenceTechnicalMetrics {
  return { durationDeltaFrames: value.durationDeltaFrames, audioCorrelation: value.audioCorrelation,
    temporalMotionDifference: value.temporalMotionDifference, freezeMismatchRatio: value.freezeMismatchRatio, comparedFrames: value.comparedFrames };
}

/** Downloads one verified Runway output, compares it with the exact source clip and imports it into the current tenant library. */
export async function importRunwayReferenceOutput(rawUrl: string, execution: DigitalHumanExecutionRecord, tenantId: string, overrides: Partial<Dependencies> = {}) {
  const deps = { ...defaults(), ...overrides };
  const evidence = execution.inputSnapshot?.referenceInput;
  if (!evidence?.clipObjectKey || !evidence.materialId) throw new Error('执行记录缺少精确参考片段证据，不能自动入库');
  if (!isTenantPrivateObjectKey(evidence.clipObjectKey, tenantId)) throw new Error('精确参考片段不属于当前租户，不能自动入库或质检');
  if (evidence.clipObjectEtag) {
    const sourceObject = await deps.head(evidence.clipObjectKey);
    if (!sourceObject?.size || String(sourceObject.etag || '') !== evidence.clipObjectEtag) throw new Error('精确参考片段对象版本已变化，不能执行历史任务质检');
  }
  const id = `runway-${execution.id.replace(/[^A-Za-z0-9-]/g, '')}`;
  const existing = deps.materials().find(item => item.id === id && String(item.tenantId || item.tenant_id || '') === tenantId);
  if (existing?.objectKey && !isTenantPrivateObjectKey(String(existing.objectKey), tenantId)) throw new Error('已入库 Runway 候选对象不属于当前租户，不能复用历史质检');
  const existingObject = existing?.objectKey ? await deps.head(String(existing.objectKey)) : null;
  const existingHash = String(existing?.contentSha256 || '').toLowerCase();
  if (existing?.referenceTechnicalMetrics && existing.objectKey && existingObject && existing.objectEtag && /^[a-f0-9]{64}$/.test(existingHash)) {
    if (String(existing.objectEtag) !== String(existingObject.etag || '')) throw new Error('已入库 Runway 候选对象版本已变化，不能复用历史质检');
    return { materialId: id, objectKey: String(existing.objectKey), contentSha256: existingHash, objectEtag: String(existing.objectEtag), technicalMetrics: existing.referenceTechnicalMetrics as ReferenceTechnicalMetrics,
      ...(existing.referenceVisualMetrics ? { visualMetrics: existing.referenceVisualMetrics as ReferenceVisualMetrics } : {}) };
  }
  const url = safeOutputUrl(rawUrl, deps.allowedHost);
  const [remote, source] = await Promise.all([downloadOutput(url, deps.transport), deps.download(evidence.clipObjectKey)]);
  if (!source?.buf.length) throw new Error('执行记录对应的精确参考片段已丢失');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-output-'));
  const candidatePath = path.join(dir, 'candidate.mp4'); const sourcePath = path.join(dir, 'source.mp4');
  try {
    fs.writeFileSync(candidatePath, remote.bytes, { mode: 0o600 }); fs.writeFileSync(sourcePath, source.buf, { mode: 0o600 });
    const [report, visualMetrics] = await Promise.all([deps.inspect(sourcePath, candidatePath), deps.inspectVisual?.(sourcePath, candidatePath)]);
    if (report.candidate.duration <= 0 || report.candidate.width < 64 || report.candidate.height < 64) throw new Error('Runway 输出媒体参数无效');
    const metrics = technicalMetrics(report);
    const hash = createHash('sha256').update(remote.bytes).digest('hex');
    const filename = `${id}-${hash.slice(0, 16)}.mp4`; const objectKey = materialAssetObjectKey(tenantId, filename);
    if (!await deps.head(objectKey)) await deps.upload({ key: objectKey, body: remote.bytes, contentType: remote.contentType.startsWith('video/') ? remote.contentType : 'video/mp4' });
    const storedObject = await deps.head(objectKey);
    if (!storedObject?.size || !String(storedObject.etag || '').trim()) throw new Error('Runway 候选入库后缺少对象版本证据');
    const current = deps.materials();
    const material: MaterialRecord = { id, name: `参考重演 · 分镜 ${execution.shotId}`, folder: 'presenter', type: 'video',
      duration: report.candidate.duration, width: report.candidate.width, height: report.candidate.height,
      aspectRatio: report.candidate.width / report.candidate.height, size: remote.bytes.length, objectKey, url: '',
      scope: 'own', tenantId, usage: 'editable', sourceType: 'runway_act_two', sourceExecutionId: execution.id,
      sourceReferenceMaterialId: evidence.materialId, sourceReferenceClipObjectKey: evidence.clipObjectKey,
      contentSha256: hash, objectEtag: String(storedObject.etag), referenceTechnicalMetrics: metrics, ...(visualMetrics ? { referenceVisualMetrics: visualMetrics } : {}),
      generation: { pipelineId:'digital_human_2',assetGenerationKind:'digital_human',pipelineVersion:'reference-reenact.v1',executionId:execution.id,
        provider:execution.provider,model:execution.model||execution.tool,providerTaskId:execution.externalTaskId||undefined,idempotencyKey:execution.id,
        inputFingerprint:execution.fingerprint,promptOrSpecHash:createHash('sha256').update(JSON.stringify(execution.inputSnapshot?.requirements||{})).digest('hex'),
        inputMaterialIds:[evidence.materialId] },
      lineage:{sourceProjectId:execution.projectId,sourceAssemblyId:execution.assemblyId,sourceShotId:execution.shotId},
      quality:{state:visualMetrics?'accepted':'repair_required',policyVersion:'reference-reenact-automatic.v1',checkedAt:new Date().toISOString(),
        checks:[{key:'technical',status:'passed',evidence:JSON.stringify(metrics)},...(visualMetrics?[{key:'visual',status:'passed' as const,evidence:JSON.stringify(visualMetrics)}]:[{key:'visual',status:'unavailable' as const,evidence:'automatic_visual_check_unavailable'}])],
        rawReport:{technical:metrics,visual:visualMetrics}},
      reuse:{eligible:Boolean(visualMetrics),reason:visualMetrics?'quality_accepted':'automatic_visual_check_unavailable',usageCount:0},rightsScope:'tenant_generated_reusable',generationState:'archived',
      createdAt: existing?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
    deps.saveMaterials([...current.filter(item => !(item.id === id && String(item.tenantId || item.tenant_id || '') === tenantId)), material]);
    return { materialId: id, objectKey, contentSha256: hash, objectEtag: String(storedObject.etag), technicalMetrics: metrics, ...(visualMetrics ? { visualMetrics } : {}) };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
