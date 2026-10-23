import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateSeedanceCostCny, reconcileSeedanceBudget, releaseSeedanceBudget, reserveSeedanceBudget } from './seedanceBudget.js';
import {
  currentContentProviderReceipt,
  recordCurrentContentProviderReceipt,
} from '../contentExecution/context.js';

export interface ConceptVideoResult {
  providerId: 'seedance' | 'veo';
  model: string;
  providerTaskId: string;
  bytes: Buffer;
  duration: number;
  estimatedCostCny: number;
}

export interface ConceptVideoInput {
  tenantId: string;
  prompt: string;
  durationSeconds: number;
  ratio: '9:16';
  resolution?: '720p';
  idempotencyKey: string;
  timeoutMs: number;
}

type SeedanceTask = Record<string, any>;

function transportFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error || 'network_error');
  const cause = error.cause;
  if (cause && typeof cause === 'object') {
    const record = cause as { code?: unknown; message?: unknown };
    return [error.message, record.code, record.message].filter(Boolean).map(String).join(' / ').slice(0, 400);
  }
  return error.message.slice(0, 400);
}

function reportedSeedanceCostCny(model: string, task: SeedanceTask, fallback: number): number {
  const tokens = Number(task.usage?.total_tokens ?? task.usage?.completion_tokens ?? task.data?.usage?.total_tokens);
  if (!Number.isFinite(tokens) || tokens <= 0) return fallback;
  const perMillion = /seedance-1-0-pro-fast/i.test(model)
    ? 4.2
    : /seedance-1-0-pro/i.test(model)
      ? 15
      : /seedance-2-0-fast/i.test(model)
        ? Math.max(0, Number(process.env.SEEDANCE_2_FAST_CNY_PER_MILLION || 22))
        : /seedance-2-0-mini/i.test(model)
          ? Math.max(0, Number(process.env.SEEDANCE_2_MINI_CNY_PER_MILLION || 14))
          : /seedance-2-0(?!-)/i.test(model)
            ? Math.max(0, Number(process.env.SEEDANCE_2_CNY_PER_MILLION || 28))
            : null;
  return perMillion === null ? fallback : Math.round((tokens * perMillion / 1_000_000) * 10_000) / 10_000;
}

function deepUrl(value: unknown): string | null {
  if (typeof value === 'string') return /^https:\/\//i.test(value) ? value : null;
  if (Array.isArray(value)) return value.map(deepUrl).find(Boolean) || null;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['video_url', 'videoUrl', 'url', 'content_url']) {
      const found = deepUrl(record[key]);
      if (found) return found;
    }
    return Object.values(record).map(deepUrl).find(Boolean) || null;
  }
  return null;
}

async function jsonRequest(fetcher: typeof fetch, url: string, apiKey: string, init?: RequestInit): Promise<SeedanceTask> {
  let response: Response;
  try {
    response = await fetcher(url, {
      ...init,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...(init?.headers || {}) },
      signal: init?.signal || AbortSignal.timeout(45_000),
    });
  } catch (error) {
    throw new Error(`Seedance network: ${transportFailure(error)}`);
  }
  const value = await response.json().catch(() => ({})) as SeedanceTask;
  if (!response.ok) {
    const detail = value?.error?.message || value?.message || value?.error || response.statusText;
    throw new Error(`Seedance ${response.status}: ${String(detail).slice(0, 500)}`);
  }
  return value;
}

export async function generateSeedanceConceptVideo(input: ConceptVideoInput & {
  apiKey: string;
  model: string;
  baseUrl?: string;
  pollMs?: number;
  transport?: typeof fetch;
  reserveBudget?: typeof reserveSeedanceBudget;
  releaseBudget?: typeof releaseSeedanceBudget;
  reconcileBudget?: typeof reconcileSeedanceBudget;
  firstFrameDataUrl?: string;
  referenceImageDataUrls?: string[];
  referenceVideoUrl?: string;
  beforeSubmit?: (request: Record<string, unknown>) => Promise<void>;
  checkpointPath?: string;
}): Promise<ConceptVideoResult> {
  if (!input.apiKey.trim()) throw new Error('Seedance 未配置方舟 API Key');
  const fetcher = input.transport || fetch;
  const duration = Math.max(4, Math.min(15, Math.round(input.durationSeconds)));
  const resolution = input.resolution || '720p';
  const reserve = input.reserveBudget || reserveSeedanceBudget;
  const release = input.releaseBudget || releaseSeedanceBudget;
  let checkpoint: { taskId: string; reservationId: string; reservedCny: number } | null = null;
  if (input.checkpointPath) {
    checkpoint = await fsp.readFile(input.checkpointPath, 'utf8')
      .then(value => JSON.parse(value) as { taskId: string; reservationId: string; reservedCny: number })
      .catch(() => null);
    if (!checkpoint?.taskId || !checkpoint.reservationId || !Number.isFinite(checkpoint.reservedCny)) checkpoint = null;
  }
  const durableReceipt = currentContentProviderReceipt({ provider: 'seedance', requestId: input.idempotencyKey });
  if (!checkpoint && durableReceipt?.providerTaskId) {
    const reservationId = String(durableReceipt.metadata.reservationId || '').trim();
    const reservedCny = Number(durableReceipt.metadata.reservedCny);
    if (reservationId && Number.isFinite(reservedCny)) {
      checkpoint = { taskId: durableReceipt.providerTaskId, reservationId, reservedCny };
    }
  }
  if (!checkpoint && durableReceipt && ['submitting', 'accepted', 'unknown'].includes(durableReceipt.state)) {
    throw new Error('provider_submission_unknown:seedance:missing_provider_task_id');
  }
  const budget = checkpoint
    ? { ok: true, reservationId: checkpoint.reservationId, reservedCny: checkpoint.reservedCny }
    : reserve({ tenantId: input.tenantId, duration, resolution });
  if (!budget.ok || !budget.reservationId) throw new Error('seedance_monthly_budget_exceeded');
  const baseUrl = (input.baseUrl || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/+$/, '');
  let accepted = Boolean(checkpoint);
  let reservationReleased = false;
  try {
    const content: Array<Record<string, unknown>> = [{ type: 'text', text: input.prompt.slice(0, 8000) }];
    const fullModalReference = Boolean(input.referenceVideoUrl || input.referenceImageDataUrls?.length);
    if (input.firstFrameDataUrl) content.push({
      type: 'image_url',
      image_url: { url: input.firstFrameDataUrl },
      role: fullModalReference ? 'reference_image' : 'first_frame',
    });
    for (const url of (input.referenceImageDataUrls || []).slice(0, 8)) {
      content.push({ type: 'image_url', image_url: { url }, role: 'reference_image' });
    }
    if (input.referenceVideoUrl) {
      content.push({ type: 'video_url', video_url: { url: input.referenceVideoUrl }, role: 'reference_video' });
    }
    let taskId = checkpoint?.taskId || '';
    if (!taskId) {
      await recordCurrentContentProviderReceipt({
        provider: 'seedance', requestId: input.idempotencyKey, state: 'submitting',
        metadata: { reservationId: budget.reservationId, reservedCny: budget.reservedCny, model: input.model },
      });
      const request = {model: input.model, content, ratio: input.ratio, duration, resolution, generate_audio: false, watermark: false};
      await input.beforeSubmit?.(structuredClone(request));
      let created: SeedanceTask;
      try {
        created = await jsonRequest(fetcher, `${baseUrl}/contents/generations/tasks`, input.apiKey, {
          method: 'POST',
          headers: { 'X-Client-Request-Id': input.idempotencyKey },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(Math.min(input.timeoutMs, 180_000)),
        });
      } catch (error) {
        const definitive = /Seedance (?:400|401|403|404|422):/i.test(String(error instanceof Error ? error.message : error));
        await recordCurrentContentProviderReceipt({
          provider: 'seedance', requestId: input.idempotencyKey,
          state: definitive ? 'failed' : 'unknown',
          metadata: { reservationId: budget.reservationId, reservedCny: budget.reservedCny, model: input.model },
        });
        throw error;
      }
      taskId = String(created.id || created.data?.id || created.task?.id || '').trim();
      if (!taskId) {
        await recordCurrentContentProviderReceipt({
          provider: 'seedance', requestId: input.idempotencyKey, state: 'unknown',
          metadata: { reservationId: budget.reservationId, reservedCny: budget.reservedCny, model: input.model },
        });
        throw new Error('Seedance 提交结果未知：未返回任务 ID，不能自动重试');
      }
      accepted = true;
      await recordCurrentContentProviderReceipt({
        provider: 'seedance', requestId: input.idempotencyKey, state: 'accepted', providerTaskId: taskId,
        metadata: { reservationId: budget.reservationId, reservedCny: budget.reservedCny, model: input.model },
      });
      if (input.checkpointPath) {
        await fsp.mkdir(path.dirname(input.checkpointPath), { recursive: true });
        const temporary = `${input.checkpointPath}.${process.pid}.tmp`;
        await fsp.writeFile(temporary, JSON.stringify({ taskId, reservationId: budget.reservationId, reservedCny: budget.reservedCny }), 'utf8');
        await fsp.rename(temporary, input.checkpointPath);
      }
    }
    const deadline = Date.now() + input.timeoutMs;
    let completed: SeedanceTask | null = null;
    let lastPollError = '';
    while (Date.now() < deadline) {
      let task: SeedanceTask;
      try {
        task = await jsonRequest(fetcher, `${baseUrl}/contents/generations/tasks/${encodeURIComponent(taskId)}`, input.apiKey);
        lastPollError = '';
      } catch (error) {
        lastPollError = transportFailure(error);
        await new Promise(resolve => setTimeout(resolve, input.pollMs || 8_000));
        continue;
      }
      const status = String(task.status || task.data?.status || task.task?.status || '').toLowerCase();
      if (['succeeded', 'success', 'completed', 'done'].includes(status)) { completed = task; break; }
      if (['failed', 'error', 'expired', 'cancelled', 'canceled'].includes(status)) {
        await recordCurrentContentProviderReceipt({
          provider: 'seedance', requestId: input.idempotencyKey, state: 'failed', providerTaskId: taskId,
          metadata: { providerStatus: status },
        });
        if (input.checkpointPath) await fsp.rm(input.checkpointPath, { force: true });
        release(input.tenantId, budget.reservationId);
        reservationReleased = true;
        throw new Error(`Seedance ${status}: ${String(task.error?.message || task.message || task.error || '').slice(0, 500)}`);
      }
      await new Promise(resolve => setTimeout(resolve, input.pollMs || 8_000));
    }
    if (!completed) throw new Error(`Seedance task ${taskId} timed out; do not resubmit automatically${lastPollError ? `; last poll error: ${lastPollError}` : ''}`);
    const url = deepUrl(completed);
    if (!url) throw new Error('Seedance 任务成功但没有输出 URL');
    let media: Response | null = null;
    let mediaError = '';
    for (let attempt = 0; attempt < 3 && !media; attempt += 1) {
      try { media = await fetcher(url, { signal: AbortSignal.timeout(Math.min(input.timeoutMs, 120_000)) }); }
      catch (error) {
        mediaError = transportFailure(error);
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 1_500 * (attempt + 1)));
      }
    }
    if (!media) throw new Error(`Seedance 视频下载连接失败：${mediaError || 'network_error'}`);
    if (!media.ok) throw new Error(`Seedance 视频下载失败：${media.status}`);
    const actualCostCny = reportedSeedanceCostCny(input.model, completed, budget.reservedCny);
    const reconcile = input.reconcileBudget || (input.reserveBudget ? null : reconcileSeedanceBudget);
    reconcile?.(input.tenantId, budget.reservationId, actualCostCny);
    await recordCurrentContentProviderReceipt({
      provider: 'seedance', requestId: input.idempotencyKey, state: 'completed', providerTaskId: taskId,
      metadata: { reservationId: budget.reservationId, reservedCny: budget.reservedCny, actualCostCny, outputUrl: url, model: input.model },
    });
    return {
      providerId: 'seedance', model: input.model, providerTaskId: taskId,
      bytes: Buffer.from(await media.arrayBuffer()), duration,
      estimatedCostCny: actualCostCny,
    };
  } catch (error) {
    if (!accepted && !reservationReleased) release(input.tenantId, budget.reservationId);
    throw error;
  }
}

export type VeoWorker = (job: Record<string, unknown>, timeoutMs: number) => Promise<Record<string, any>>;

function videoWorkerEnvironment(): NodeJS.ProcessEnv {
  const proxy = process.env.GEMINI_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'http://127.0.0.1:7890';
  return {
    ...process.env,
    NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY || '1',
    HTTPS_PROXY: process.env.HTTPS_PROXY || proxy,
    HTTP_PROXY: process.env.HTTP_PROXY || proxy,
    https_proxy: process.env.https_proxy || process.env.HTTPS_PROXY || proxy,
    http_proxy: process.env.http_proxy || process.env.HTTP_PROXY || proxy,
  };
}

export async function runVeoWorker(job: Record<string, unknown>, timeoutMs: number): Promise<Record<string, any>> {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const worker = path.resolve(moduleDir, '../../scripts/gemini-video-worker.mjs');
  const outputDir = String(job.outputDir || path.resolve(process.cwd(), 'data/media/generated'));
  await fsp.mkdir(outputDir, { recursive: true });
  const jobFile = path.join(outputDir, `veo-job-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  await fsp.writeFile(jobFile, JSON.stringify(job), 'utf8');
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [worker, jobFile], { cwd: process.cwd(), env: videoWorkerEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Veo worker timed out')); }, timeoutMs + 30_000);
      child.stdout.on('data', chunk => { stdout += String(chunk); });
      child.stderr.on('data', chunk => { stderr += String(chunk); });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => {
        clearTimeout(timer);
        try { resolve(JSON.parse(stdout.trim())); }
        catch { reject(new Error((stderr || `Veo worker exited with ${code}`).slice(0, 500))); }
      });
    });
  } finally {
    await fsp.rm(jobFile, { force: true });
  }
}

export async function generateVeoConceptVideo(input: ConceptVideoInput & {
  model: string;
  outputDirectory: string;
  worker?: VeoWorker;
  estimatedCostCny: number;
}): Promise<ConceptVideoResult> {
  const duration = Math.max(5, Math.min(8, Math.round(input.durationSeconds)));
  const prior = currentContentProviderReceipt({ provider: 'veo', requestId: input.idempotencyKey });
  if (prior?.state === 'completed') {
    const storedFile = String(prior.metadata.file || '').trim();
    const storedPath = storedFile && path.basename(storedFile) === storedFile
      ? path.join(input.outputDirectory, storedFile) : '';
    if (!storedPath || !fs.existsSync(storedPath)) {
      throw new Error('provider_submission_unknown:veo:completed_output_missing');
    }
    return {
      providerId: 'veo', model: String(prior.metadata.model || input.model),
      providerTaskId: prior.providerTaskId || input.idempotencyKey,
      bytes: await fsp.readFile(storedPath), duration: Number(prior.metadata.duration) || duration,
      estimatedCostCny: input.estimatedCostCny,
    };
  }
  if (prior && ['submitting', 'accepted', 'unknown'].includes(prior.state)) {
    throw new Error('provider_submission_unknown:veo:requires_provider_reconciliation');
  }
  await recordCurrentContentProviderReceipt({
    provider: 'veo', requestId: input.idempotencyKey, state: 'submitting', metadata: { model: input.model },
  });
  let output: Record<string, any>;
  try {
    output = await (input.worker || runVeoWorker)({
      prompt: input.prompt, model: input.model, ratio: input.ratio, duration,
      resolution: input.resolution || '720p', outputDir: input.outputDirectory,
      timeoutMs: input.timeoutMs, idempotencyKey: input.idempotencyKey,
    }, input.timeoutMs);
  } catch (error) {
    await recordCurrentContentProviderReceipt({
      provider: 'veo', requestId: input.idempotencyKey, state: 'unknown', metadata: { model: input.model },
    });
    throw error;
  }
  if (output.ok !== true) {
    await recordCurrentContentProviderReceipt({
      provider: 'veo', requestId: input.idempotencyKey, state: 'failed', metadata: { model: input.model },
    });
    throw new Error(String(output.error || 'Veo generation failed'));
  }
  const file = String(output.file || '').trim();
  if (!file || path.basename(file) !== file) throw new Error('Veo worker returned an unsafe output filename');
  const filePath = path.join(input.outputDirectory, file);
  if (!fs.existsSync(filePath)) throw new Error('Veo worker output file is missing');
  const providerTaskId = String(output.id || input.idempotencyKey);
  await recordCurrentContentProviderReceipt({
    provider: 'veo', requestId: input.idempotencyKey, state: 'completed', providerTaskId,
    metadata: { model: String(output.model || input.model), file, duration },
  });
  return {
    providerId: 'veo', model: String(output.model || input.model),
    providerTaskId,
    bytes: await fsp.readFile(filePath), duration,
    estimatedCostCny: input.estimatedCostCny,
  };
}

export { estimateSeedanceCostCny };
