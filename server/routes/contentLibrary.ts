import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { store } from '../storage/index.js';
import { signAssetUrl } from '../lib/assetAccess.js';
import { contentAccepted } from '../digitalEmployees/contentAcceptance.js';
import { publishableStudioGenerationFromSpec } from '../lib/studioGenerationVerification.js';

type Row = Record<string, any>;
const object = (value: any): Row => { try { return typeof value === 'string' ? JSON.parse(value || '{}') : value && typeof value === 'object' ? value : {}; } catch { return {}; } };
const decode = (value: string) => { try { return decodeURIComponent(value); } catch { return value; } };
const folder = (tenant: string) => path.resolve('data/publishing-uploads', tenant.replace(/[^\w.-]+/g, '-'));
export function safeContentFile(tenant: string, file: unknown) {
  if (typeof file !== 'string' || !fs.existsSync(file)) return '';
  const resolved = fs.realpathSync(file), configuredRoot = folder(tenant);
  const root = fs.existsSync(configuredRoot) ? fs.realpathSync(configuredRoot) : configuredRoot;
  return resolved.startsWith(root + path.sep) && fs.statSync(resolved).isFile() ? path.resolve(file) : '';
}
async function projects(tenant: string) {
  const rows: Row[] = [];
  for (let page = 1; ; page++) {
    const result = await store.list<any>('studio_projects', { where: { tenant_id: tenant }, page, perPage: 100 });
    rows.push(...result.items);
    if (result.items.length < 100) break;
  }
  return rows;
}
export function projectOutputs(project: Row) {
  const spec = object(project.spec), outputs: Row[] = [];
  const seen = new Set<string>();
  const add = (key: string, file: any, language: string, version: number, current: boolean, snapshot?: Row) => {
    if (!file || seen.has(file)) return; seen.add(file);
    outputs.push({ id: project.id + ':' + key, projectId: project.id, title: project.title || '未命名成片', language, platform: spec.platform, product: spec.contentOrder?.productName || spec.productInfo?.slice?.(0, 80) || '', mode: spec.presentationMode || 'material', taskId: spec.workflowTaskId || '', runId: spec.workflowRunId || '', file, version, current, pinned: spec.libraryPinned === true, createdAt: project.updated_at || project.created_at, productionStatus: spec.automation?.stage || project.status, reviewStatus: current && contentAccepted(spec) ? 'approved' : 'pending', published: Boolean(spec.publishingReceipt?.id || spec.publishedAt), cover: (snapshot || spec).coverImagePath, spec: current || snapshot ? { ...spec, ...(snapshot || {}) } : { lang: language, ratio: spec.ratio }, metadataComplete: current || Boolean(snapshot) });
  };
  add('current', spec.renderOutputPath || spec.automation?.renderOutputPath, spec.lang || 'en', spec.automation?.contentVersion || 1, true);
  for (const [key, value] of Object.entries<Row>(spec.languageRenderOutputs || {})) if (value.status === 'done') add(key, value.path, decode(key.split('::')[1] || spec.lang || 'en'), 1, true);
  for (const [key, versions] of Object.entries<Row[]>(spec.languageRenderVersions || {})) for (const v of versions) if (v.status === 'done') add(key + '-' + v.id, v.path, decode(key.split('::')[1] || spec.lang || 'en'), v.versionNumber || 1, false);
  for (const [index, revision] of (spec.revisionHistory || []).entries()) add('revision-' + index, revision.renderOutputPath, spec.lang || 'en', revision.version || 1, false, revision.snapshot);
  return outputs;
}
async function library(tenant: string) {
 const outputs = (await projects(tenant)).flatMap(projectOutputs);
 const posts: any[] = [];
 for (let page=1;;page++) { const result=await store.list<any>('posts',{where:{tenant_id:tenant},page,perPage:100}); posts.push(...result.items); if(result.items.length<100)break; }
 for (const row of outputs) row.published = posts.some(post => { const stats=object(post.stats); return stats.sourceProjectId===row.projectId && stats.videoPath===row.file && Object.values<any>(stats.publishResults||{}).some(result=>result.status==='published' && (result.platformPostId || result.postId || result.url || result.id)); });
 return outputs.sort(contentLibraryOutputOrder);
}
export function contentLibraryOutputOrder(a: Row, b: Row) {
  return Number(b.pinned) - Number(a.pinned)
    || Date.parse(String(b.createdAt || '')) - Date.parse(String(a.createdAt || ''));
}
const root = (tenant: string) => path.resolve('data/content-exports', tenant.replace(/[^\w.-]+/g, '-'));
const jobsFile = (tenant: string) => path.join(root(tenant), 'jobs.json');
const bootId = randomUUID();
function readJobs(tenant: string): Row[] {
  try {
    return JSON.parse(fs.readFileSync(jobsFile(tenant), 'utf8')).map((job: Row) => job.status === 'running' && job.bootId !== bootId ? { ...job, status: 'failed', error: '服务重启中断，请重试' } : job);
  } catch { return []; }
}
function saveJob(tenant: string, job: Row) {
  fs.mkdirSync(root(tenant), { recursive: true });
  const jobs = readJobs(tenant), next = [job, ...jobs.filter(j => j.id !== job.id)];
  const tmp = jobsFile(tenant) + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(next)); fs.renameSync(tmp, jobsFile(tenant));
}
function srt(cues: Row[]) {
  const stamp = (s: number) => new Date(Math.max(0, s) * 1000).toISOString().slice(11, 23).replace('.', ',');
  return cues.map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`).join('\n');
}
async function executeExport(tenant: string, job: Row, rows: Row[]) {
  const dir = path.join(root(tenant), job.id); fs.mkdirSync(dir, { recursive: true });
  try {
    for (const row of rows) {
      const item = job.items.find((i: Row) => i.id === row.id);
      try {
        const file = safeContentFile(tenant, row.file);
        if (!file) throw Error('成片不存在或不属于当前企业');
        const stem = 'video-' + String(job.items.indexOf(item) + 1).padStart(3, '0') + '-' + String(row.language).replace(/[^a-zA-Z0-9_-]/g, '');
        item.filename = stem + '.mp4';
        fs.copyFileSync(file, path.join(dir, stem + '.mp4'));
        if (job.includeExtras && row.metadataComplete) {
          fs.writeFileSync(path.join(dir, stem + '.txt'), String(row.spec.caption || row.spec.script || ''));
          const cues = row.spec.alignedCuesByLang?.[row.language];
          if (Array.isArray(cues)) fs.writeFileSync(path.join(dir, stem + '.srt'), srt(cues));
          if (safeContentFile(tenant, row.cover)) fs.copyFileSync(row.cover, path.join(dir, stem + '.jpg'));
        }
        item.status = 'done';
      } catch (error) { item.status = 'failed'; item.error = String((error as Error).message); }
      job.progress = Math.round(job.items.filter((i: Row) => i.status !== 'pending').length / job.items.length * 100);
      saveJob(tenant, job);
    }
    if (!job.items.some((i: Row) => i.status === 'done')) throw Error('没有可导出的成片');
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(job.items, null, 2));
    await new Promise<void>((resolve, reject) => execFile('zip', ['-q', '-r', path.join(root(tenant), job.id + '.zip'), '.'], { cwd: dir, timeout: 120000 }, err => err ? reject(err) : resolve()));
    job.status = job.items.some((i: Row) => i.status === 'failed') ? 'partial' : 'done';
    job.expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
  } catch (error) { job.status = 'failed'; job.error = (error as Error).message; }
  saveJob(tenant, job);
}
export const contentLibraryRouter = Router();
contentLibraryRouter.get('/library', async (_req, res) => {
  try {
    const tenant = res.locals.tenantId;
    const outputs = await library(tenant);
    res.json({ items: outputs.map(({ file, spec, cover, ...row }) => ({ ...row, available: Boolean(safeContentFile(tenant, file)), previewUrl: safeContentFile(tenant, file) ? signAssetUrl('/api/overseas/publishing/local-videos/' + encodeURIComponent(path.basename(file)), tenant) : '', coverUrl: safeContentFile(tenant, cover) ? signAssetUrl('/api/overseas/studio/library/cover/' + encodeURIComponent(row.id), tenant) : '', exportSpec: spec.exportSpec || { ratio: spec.ratio || '9:16', resolution: '1080p', fps: 30 } })) });
  } catch { res.status(500).json({ error: '读取成片库失败' }); }
});
contentLibraryRouter.get('/library/publish-draft/:id', async (req, res) => {
  const row = (await library(res.locals.tenantId)).find(item => item.id === req.params.id);
  if (!row || !row.current || !safeContentFile(res.locals.tenantId, row.file)) { res.status(404).json({ error: '当前成片不可用' }); return; }
  if (row.runId && row.reviewStatus !== 'approved') { res.status(409).json({ error: '数字员工成片需先在交付看板审核通过' }); return; }
  const generation = publishableStudioGenerationFromSpec(row.spec);
  if (!generation) { res.status(409).json({ error: '当前脚本缺少与正文一致且已通过的 AI 质量记录，请返回内容创作重新审核' }); return; }
  res.json({ videoPath: row.file, title: row.title, description: row.spec.caption || '', ratio: row.spec.ratio || '9:16', platform: row.platform || 'youtube', sourceProjectId: row.projectId, workflowRunId: row.runId || undefined, workflowTaskId: row.taskId || undefined, workflowTaskKey: row.runId ? 'content_production' : undefined, language: row.language, ...generation });
});
contentLibraryRouter.get('/library/cover/:projectId', async (req, res) => {
  const tenant = res.locals.tenantId;
  const row = (await library(tenant)).find(item => item.id === req.params.projectId);
  const file = row && safeContentFile(tenant, row.cover);
  if (!file || !['.jpg','.png'].includes(path.extname(file))) { res.status(404).end(); return; }
  res.sendFile(file);
});
contentLibraryRouter.get('/library/download', async (req, res) => {
  const tenant = res.locals.tenantId;
  const row = (await library(tenant)).find(item => item.id === req.query.id);
  const file = row && safeContentFile(tenant, row.file);
  if (!file) { res.status(404).json({ error: '成片不存在或无权访问' }); return; }
  res.download(file, String(row.title).replace(/[/\\]/g, '_') + '.mp4');
});
contentLibraryRouter.post('/library/download-file', (req, res) => {
  const file = safeContentFile(res.locals.tenantId, req.body?.path);
  if (!file) { res.status(404).json({ error: '成片不存在或无权访问' }); return; }
  res.download(file);
});
contentLibraryRouter.get('/exports', (_req, res) => res.json({ items: readJobs(res.locals.tenantId).map(({ bootId, ...job }) => job) }));
contentLibraryRouter.post('/exports', async (req, res) => {
  const tenant = res.locals.tenantId;
  if (readJobs(tenant).filter(j => j.status === 'running').length >= 2) { res.status(409).json({ error: '已有两个导出任务正在处理，请稍后重试' }); return; }
  const ids = Array.isArray(req.body?.ids) ? [...new Set<string>(req.body.ids)] : [];
  if (!ids.length || ids.length > 100) { res.status(400).json({ error: '每批请选择1至100个成片' }); return; }
  const rows = (await library(tenant)).filter(row => ids.includes(row.id));
  if (readJobs(tenant).filter(j => j.status === 'running').length >= 2) { res.status(409).json({ error: '已有导出任务处理中，请稍后重试' }); return; }
  if (rows.length !== ids.length) { res.status(404).json({ error: '部分成片已变化或不可访问，请刷新' }); return; }
  const job = { id: randomUUID(), bootId, status: 'running', progress: 0, includeExtras: req.body.includeExtras !== false, createdAt: new Date().toISOString(), items: rows.map(row => ({ id: row.id, title: row.title, status: 'pending' })) };
  saveJob(tenant, job); res.status(202).json(job); void executeExport(tenant, job, rows);
});
contentLibraryRouter.get('/exports/:id/download', (req, res) => {
  const job = readJobs(res.locals.tenantId).find(j => j.id === req.params.id);
  if (!job || !['done', 'partial'].includes(job.status) || Date.parse(job.expiresAt) < Date.now()) { res.status(410).json({ error: '导出尚未完成或已过期，请重新导出' }); return; }
  res.download(path.join(root(res.locals.tenantId), job.id + '.zip'), '成片导出-' + job.id + '.zip');
});
