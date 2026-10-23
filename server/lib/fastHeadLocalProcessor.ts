import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import { readLocalMaterials, saveLocalMaterials, type MaterialRecord } from './materialLibrary.js';
import { isTenantPrivateObjectKey, tenantPrivateObjectKey } from '../storage/materialAssets.js';
import { objectStorageDownload, objectStorageHead, objectStorageUpload } from '../storage/objectStorage.js';

type FastHeadReport = {
  status?: string;
  technicalQuality?: Record<string, unknown>;
  visualQuality?: Record<string, unknown>;
  failures?: string[];
};

type Dependencies = {
  downloadObject: typeof objectStorageDownload;
  headObject: typeof objectStorageHead;
  uploadObject: typeof objectStorageUpload;
  transport: typeof fetch;
  runPipeline: (source: string, candidate: string, output: string, workDir: string) => Promise<void>;
  materials: () => MaterialRecord[];
  saveMaterials: typeof saveLocalMaterials;
  allowedHost: (hostname: string) => boolean;
};

const MAX_BYTES = 500 * 1024 * 1024;

function defaultAllowedHost(hostname: string): boolean {
  const configured = String(process.env.RUNWAY_OUTPUT_HOST_SUFFIXES || '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
  const suffixes = configured.length ? configured : ['.cloudfront.net'];
  const host = hostname.toLowerCase();
  return suffixes.some(suffix => host === suffix.replace(/^\./, '') || host.endsWith(suffix.startsWith('.') ? suffix : `.${suffix}`));
}

async function downloadCandidate(raw: string, deps: Dependencies): Promise<Buffer> {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !deps.allowedHost(url.hostname)) throw new Error('Runway 输出不在已配置的 HTTPS 素材域名中');
  const response = await deps.transport(url, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`Runway 视频下载失败（HTTP ${response.status}）`);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_BYTES) { await response.body.cancel(); throw new Error('Runway 输出超过 500MB'); }
  const reader = response.body.getReader(); const chunks: Buffer[] = []; let size = 0;
  while (true) {
    const part = await reader.read(); if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_BYTES) { await reader.cancel(); throw new Error('Runway 输出超过 500MB'); }
    chunks.push(Buffer.from(part.value));
  }
  if (!size) throw new Error('Runway 输出视频为空');
  return Buffer.concat(chunks);
}

function defaultRunPipeline(source: string, candidate: string, output: string, workDir: string): Promise<void> {
  const python = String(process.env.DIGITAL_HUMAN_FAST_HEAD_PYTHON || '').trim();
  if (!python) return Promise.reject(new Error('未配置 DIGITAL_HUMAN_FAST_HEAD_PYTHON'));
  if (!ffmpegStatic) return Promise.reject(new Error('本地人物替换缺少 FFmpeg'));
  const script = path.resolve(process.cwd(), 'scripts/fast_head_pipeline.py');
  return new Promise((resolve, reject) => execFile(python, [script, source, candidate, output, '--work-dir', workDir, '--ffmpeg', String(ffmpegStatic), '--python', python],
    { timeout: 15 * 60_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PYTHONNOUSERSITE: '1' } }, error => error ? reject(error) : resolve()));
}

export function createFastHeadLocalProcessor(overrides: Partial<Dependencies> = {}) {
  const deps: Dependencies = { downloadObject: objectStorageDownload, headObject: objectStorageHead, uploadObject: objectStorageUpload, transport: fetch,
    runPipeline: defaultRunPipeline, materials: readLocalMaterials, saveMaterials: saveLocalMaterials, allowedHost: defaultAllowedHost, ...overrides };
  return async (input: { id: string; tenantId: string; sourceObjectKey: string; sourceObjectEtag: string; candidateUrl: string }) => {
    if (!isTenantPrivateObjectKey(input.sourceObjectKey, input.tenantId)) throw new Error('本地人物替换源片不属于当前租户');
    const sourceHead = await deps.headObject(input.sourceObjectKey);
    if (!sourceHead?.size || String(sourceHead.etag || '') !== input.sourceObjectEtag) throw new Error('本地人物替换源片版本已变化');
    const existing = deps.materials().find(item => String(item.tenantId || item.tenant_id || '') === input.tenantId && item.sourceExecutionId === input.id);
    if (existing?.objectKey && isTenantPrivateObjectKey(String(existing.objectKey), input.tenantId) && await deps.headObject(String(existing.objectKey))) return { outputObjectKey: String(existing.objectKey) };
    const [source, candidate] = await Promise.all([deps.downloadObject(input.sourceObjectKey), downloadCandidate(input.candidateUrl, deps)]);
    if (!source?.buf.length) throw new Error('本地人物替换源片已丢失');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-head-worker-'));
    try {
      const sourcePath = path.join(dir, 'source.mp4'); const candidatePath = path.join(dir, 'candidate.mp4'); const outputPath = path.join(dir, 'output.mp4');
      fs.writeFileSync(sourcePath, source.buf, { mode: 0o600 }); fs.writeFileSync(candidatePath, candidate, { mode: 0o600 });
      await deps.runPipeline(sourcePath, candidatePath, outputPath, dir);
      const report = JSON.parse(fs.readFileSync(path.join(dir, 'fast-pipeline-report.json'), 'utf8')) as FastHeadReport;
      if (report.status !== 'manual_identity_review') throw new Error(`本地人物替换未通过自动门禁：${(report.failures || []).join('；') || report.status || '未知状态'}`);
      const bytes = fs.readFileSync(outputPath); if (!bytes.length) throw new Error('本地人物替换输出为空');
      const hash = createHash('sha256').update(bytes).digest('hex'); const filename = `${input.id}-${hash.slice(0, 16)}.mp4`;
      const objectKey = tenantPrivateObjectKey('runway-fast-head', input.tenantId, filename);
      if (!await deps.headObject(objectKey)) await deps.uploadObject({ key: objectKey, body: bytes, contentType: 'video/mp4' });
      const stored = await deps.headObject(objectKey); if (!stored?.size || !stored.etag) throw new Error('本地人物替换产物入库后缺少对象版本');
      const material: MaterialRecord = { id: input.id, name: '严格人物替换候选', folder: 'presenter', type: 'video', size: bytes.length, objectKey, url: '', scope: 'own',
        tenantId: input.tenantId, usage: 'editable', sourceType: 'local_head_pipeline', sourceExecutionId: input.id, sourceReferenceClipObjectKey: input.sourceObjectKey,
        contentSha256: hash, objectEtag: String(stored.etag), referenceTechnicalMetrics: report.technicalQuality, referenceVisualMetrics: report.visualQuality,
        createdAt: existing?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
      const current = deps.materials(); deps.saveMaterials([...current.filter(item => !(item.id === material.id && String(item.tenantId || item.tenant_id || '') === input.tenantId)), material]);
      return { outputObjectKey: objectKey };
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

export async function recoverFastHeadOutput(objectKey: string, tenantId: string, executionId: string, dependencies: { head?: typeof objectStorageHead; materials?: () => MaterialRecord[] } = {}) {
  if (!isTenantPrivateObjectKey(objectKey, tenantId)) throw new Error('本地人物替换产物不属于当前租户');
  const head = await (dependencies.head || objectStorageHead)(objectKey); if (!head?.size || !head.etag) throw new Error('本地人物替换产物已丢失');
  const material = (dependencies.materials || readLocalMaterials)().find(item => item.objectKey === objectKey && String(item.tenantId || item.tenant_id || '') === tenantId && item.sourceExecutionId === executionId);
  const hash = String(material?.contentSha256 || '').toLowerCase();
  if (!material || !/^[a-f0-9]{64}$/.test(hash) || String(material.objectEtag || '') !== String(head.etag)) throw new Error('本地人物替换产物缺少可复核的素材证据');
  return { materialId: material.id, objectKey, contentSha256: hash, objectEtag: String(head.etag), technicalMetrics: material.referenceTechnicalMetrics, visualMetrics: material.referenceVisualMetrics };
}
