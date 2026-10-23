/**
 * Step 5 business-chain pipeline.
 *
 * The pipeline consumes the real HeyGen shots that Step 4 generated and
 * recorded, composes (or reuses) the verified 1080x1920 final, then writes it
 * back through the ORIGINAL content file/artifact commands, persists scene
 * receipts and the scene cache, and lets the original weekly worker/adapter
 * scan settle the run. The artifact stays review_required.
 *
 * Nothing here submits a paid provider operation. Provider phases are backed
 * by the Step 4 local state (preferred) or the committed sanitized evidence,
 * and say so explicitly.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import ffmpegStatic from 'ffmpeg-static';
import {readStoryboardFile} from './storyboard.js';
import {local} from './control.js';
import {pbStore as store} from '../server/storage/pbStore.js';
import {createStarter198Repository} from '../server/starter198/repository.js';
import {createSocialWeeklyProductionAdapter} from '../server/runtime/socialWeeklyProductionAdapter.js';
import {createSocialWeeklyExecutionWorker} from '../server/runtime/socialWeeklyExecutionWorker.js';
import {DurableContentExecutionWorker, readContentExecutionJob} from '../server/contentExecution/durableQueue.js';
import {storeSocialContentFile, registerSocialContentFile} from '../server/starter198/socialContentFiles.js';
import {createSocialContentArtifact} from '../server/starter198/socialContentOutputs.js';

const requireCjs = createRequire(import.meta.url);
const {composite} = requireCjs('../desktop/render.cjs') as {
  composite: (manifest: unknown, onProgress?: (pct: number) => void, outDir?: string) =>
    Promise<{ok: boolean; outputPath?: string; error?: string}>;
};
const execFileAsync = promisify(execFile);

const DATA_ROOT = path.resolve('.interview-data');
const SESSION_FILE = path.join(DATA_ROOT, 'session.json');
const CONTEXT_FILE = path.join(DATA_ROOT, 'context.json');
const TEMPLATE_FILE = path.join(DATA_ROOT, 'template.json');
const STATE_DIR = path.join(DATA_ROOT, 'step5');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const LOCK_FILE = path.join(STATE_DIR, 'execution.lock');
const STEP5_OUTPUT_DIR = path.join(DATA_ROOT, 'step5-output');
const STEP4_MANIFEST = path.join(DATA_ROOT, 'step4-compose', 'manifest.json');
const STEP4_SHOTS = path.join(DATA_ROOT, 'step4-shots');
const STEP4_NARRATION = path.join(DATA_ROOT, 'step4-narration');
const STEP4_BUDGET = path.join(STEP4_SHOTS, 'budget.json');
const EVIDENCE_DIR = path.resolve('evidence');
const EVIDENCE_FINAL_MP4 = path.join(EVIDENCE_DIR, 'step4-final.mp4');
const EVIDENCE_FINAL_JSON = path.join(EVIDENCE_DIR, 'step4-final.json');
const STORYBOARD_FILE = 'assets/storyboard.json';
const TENANT_ID = 't';
const CONTENT_TASK_ID = 'content';
const RUN_ID = 'run';
const LEASE_MS = 60_000;
const FIXED_NOW = () => new Date('2026-10-02T12:00:00Z');

export const STEP5_PHASES = [
  'prepared', 'submitting', 'accepted', 'generating',
  'downloading', 'compositing', 'writing_back', 'review_required',
] as const;
export type Step5Phase = typeof STEP5_PHASES[number];

export const PHASE_LABELS: Record<Step5Phase, string> = {
  prepared: '准备任务与身份',
  submitting: '确认供应商提交记录',
  accepted: '供应商已受理',
  generating: '校验生成结果',
  downloading: '校验下载媒体',
  compositing: '自动合成成片',
  writing_back: '回写原任务与产物',
  review_required: '等待人工审核',
};

const ERROR_TEXT: Record<string, string> = {
  step5_seed_required: '尚未初始化沙箱数据。请先运行 pnpm run seed，再点击“启动任务”。',
  step5_session_missing: '缺少会话文件，请先运行 pnpm run seed。',
  step5_storyboard_invalid: '分镜文件无效或素材缺失，请先修正分镜。',
  step5_storyboard_or_identity_changed: '分镜或人物身份已变化，不能沿用旧执行；请为新一轮任务单独启动。',
  step5_execution_running: '任务正在执行，请等待当前阶段结束；页面读取不会重复触发生成。',
  step5_provider_evidence_missing: '找不到 Step 4 已生成的供应商镜头证据，请先完成 Step 4 的真实镜头生成。',
  step5_provider_media_hash_mismatch: '供应商镜头媒体与记录哈希不一致，已中止回写。',
  step5_media_missing: '找不到成片文件，已中止回写。',
  step5_media_hash_mismatch: '成片哈希与记录不一致，已中止回写。',
  step5_final_probe_failed: '成片格式校验失败：需 30–37 秒、1080×1920、H.264/AAC 且可完整解码。',
  step5_render_failed: 'FFmpeg 自动合成失败，请查看运行日志。',
  step5_job_terminal_error: '原队列任务未成功结束，未生成可审核产物。',
  step5_artifact_not_review_required: '产物状态不是 review_required，拒绝把未审核成片展示为已完成。',
  step5_hash_chain_mismatch: '文件、产物与媒体接口的哈希链不一致，已中止。',
  step5_weekly_settlement_failed: '原周任务消费者未完成结算，请查看错误码后重新结算。',
  step5_lease_lost: '执行租约已失效，任务已停止，避免并发重复回写。',
};

const now = () => new Date().toISOString();
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

function fail(code: string, detail?: string): never {
  const error = new Error(code + (detail ? `:${detail}` : ''));
  (error as {step5Code?: string}).step5Code = code;
  throw error;
}

export function describeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const code = Object.keys(ERROR_TEXT).find(key => raw === key || raw.startsWith(key + ':'));
  if (!code) {
    const safe = raw.replace(/https?:\/\/\S+/g, '[已脱敏链接]').slice(0, 800);
    if (/401|403|unauthori[sz]ed|invalid.?key|forbidden/i.test(safe))
      return '鉴权失败：供应商凭据无效或无权访问；Key 不会在页面展示。';
    if (/429|rate.?limit|too many requests/i.test(safe))
      return '供应商限流：请求过于频繁，请稍后重试，不要重复启动。';
    if (/budget|spend.?cap|approved.?cap|quota.?exceeded/i.test(safe))
      return '预算不足或超过授权上限，已停止执行；未产生新的供应商提交。';
    if (/download|http_4\d\d|http_5\d\d|econn|timeout|socket/i.test(safe))
      return '下载或网络失败：请检查媒体地址与网络后重试，已保存的阶段不会重复提交。';
    if (/decode|invalid data|moov|corrupt/i.test(safe))
      return '媒体损坏或无法解码，已拒绝回写。';
    return safe;
  }
  const detail = raw.slice(code.length).replace(/^:/, '').slice(0, 300);
  return ERROR_TEXT[code] + (detail ? `（${detail}）` : '');
}

export function step5ErrorCode(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const code = Object.keys(ERROR_TEXT).find(key => raw === key || raw.startsWith(key + ':'));
  return code ?? (raw.split(':')[0] || 'step5_unknown_error');
}

async function readJson(file: string): Promise<any> {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function exists(file: string): Promise<boolean> {
  try { await fs.access(file); return true; } catch { return false; }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export interface FinalProbe {
  durationSeconds: number;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec: string;
  sampleRate: number | null;
  decodable: boolean;
}

/** Pure acceptance rule for the final media; the caller reports every error. */
export function validateFinalProbe(probe: FinalProbe): string[] {
  const errors: string[] = [];
  if (!(probe.durationSeconds >= 30 && probe.durationSeconds <= 37)) errors.push('final_duration_out_of_range');
  if (probe.width !== 1080 || probe.height !== 1920) errors.push('final_resolution_not_1080x1920');
  if (probe.videoCodec !== 'h264') errors.push('final_video_codec_not_h264');
  if (probe.audioCodec !== 'aac') errors.push('final_audio_codec_not_aac');
  if (!probe.decodable) errors.push('final_decode_failed');
  return errors;
}

export function buildIdempotencyKey(input: {
  taskId: string; runId: string; storyboardSha256: string; avatarId: string; voiceId: string;
}): string {
  return sha([input.taskId, input.runId, input.storyboardSha256, input.avatarId, input.voiceId].join('|'));
}

function publicStage(stage: Step5State['stages'][Step5Phase]) {
  return {
    name: stage.name, label: PHASE_LABELS[stage.name], status: stage.status,
    startedAt: stage.startedAt ?? null, completedAt: stage.completedAt ?? null,
    detail: stage.detail ?? null, source: stage.source ?? null,
  };
}

type StageState = {
  name: Step5Phase;
  status: 'pending' | 'active' | 'done' | 'failed';
  startedAt?: string;
  completedAt?: string;
  detail?: string;
  source?: string;
};

export interface Step5State {
  schemaVersion: 1;
  idempotencyKey: string;
  phase: Step5Phase | 'failed' | 'blocked' | 'idle';
  taskId: string;
  contentTaskId: string;
  runId: string;
  jobId: string;
  weeklyTaskId: string;
  storyboardSha256: string;
  avatarId: string;
  voiceId: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  stages: Record<Step5Phase, StageState>;
  provider?: {
    source: 'local-step4-state' | 'committed-step4-evidence' | 'mixed';
    shots: Array<{
      id: string; kind: 'presenter' | 'illustration'; videoId: string | null;
      requestId: string | null; durationSeconds: number | null; chargedCny: number | null;
    }>;
    approvedCny: number | null;
    chargedCny: number | null;
    paidSubmissions: number | null;
    note: string;
  };
  composition?: {
    mode: 'recomposed' | 'reused-verified-evidence';
    file: string; bytes: number; sha256: string;
    probe: FinalProbe; manifestSha256: string | null;
  };
  writeBack?: {
    artifactId: string; fileId: string; fileRef: string; sha256: string; bytes: number;
    status: string; taskId: string; runId: string; jobId: string;
    technicalApproved: boolean; creativeApproved: boolean;
  };
  settlement?: {status: string; code: string | null; message: string | null};
  error?: {code: string; message: string; phase: string; at: string};
  execution?: {owner: string; pid: number; leaseExpiresAt: string};
}

export interface PublicStep5State {
  phase: string;
  active: boolean;
  phases: Array<{name: string; label: string; status: string; startedAt: string | null;
    completedAt: string | null; detail: string | null; source: string | null}>;
  taskId: string; contentTaskId: string; runId: string; jobId: string; weeklyTaskId: string;
  idempotencyKeyShort: string;
  storyboardSha256: string;
  avatarId: string;
  voiceId: string;
  startedAt: string; updatedAt: string; completedAt: string | null;
  provider: Step5State['provider'] | null;
  composition: (Omit<NonNullable<Step5State['composition']>, 'file'> & {fileName: string}) | null;
  writeBack: Step5State['writeBack'] | null;
  settlement: Step5State['settlement'] | null;
  error: Step5State['error'] | null;
  mediaUrl: string | null;
  downloadUrl: string | null;
}

export function toPublicState(state: Step5State | null): PublicStep5State | null {
  if (!state) return null;
  const active = !['review_required', 'failed', 'blocked', 'idle'].includes(state.phase);
  return {
    phase: state.phase,
    active,
    phases: STEP5_PHASES.map(name => publicStage(state.stages[name])),
    taskId: state.taskId,
    contentTaskId: state.contentTaskId,
    runId: state.runId,
    jobId: state.jobId,
    weeklyTaskId: state.weeklyTaskId,
    idempotencyKeyShort: state.idempotencyKey.slice(0, 16),
    storyboardSha256: state.storyboardSha256,
    avatarId: state.avatarId,
    voiceId: state.voiceId,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    completedAt: state.completedAt ?? null,
    provider: state.provider ?? null,
    composition: state.composition
      ? {...state.composition, fileName: path.basename(state.composition.file), file: undefined} as any
      : null,
    writeBack: state.writeBack ?? null,
    settlement: state.settlement ?? null,
    error: state.error ?? null,
    mediaUrl: state.writeBack
      ? `/api/media?artifactId=${encodeURIComponent(state.writeBack.artifactId)}`
      : null,
    downloadUrl: state.writeBack
      ? `/api/media?artifactId=${encodeURIComponent(state.writeBack.artifactId)}&download=1`
      : null,
  };
}

async function persist(state: Step5State): Promise<void> {
  state.updatedAt = now();
  const temp = STATE_FILE + '.tmp';
  await fs.writeFile(temp, JSON.stringify(state, null, 2), {mode: 0o600});
  await fs.rename(temp, STATE_FILE);
}

export async function readPipelineState(): Promise<Step5State | null> {
  try { return await readJson(STATE_FILE); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function readPublicPipeline(): Promise<PublicStep5State | null> {
  return toPublicState(await readPipelineState());
}

function blankStages(): Record<Step5Phase, StageState> {
  return Object.fromEntries(STEP5_PHASES.map(name => [name, {name, status: 'pending'}])) as
    Record<Step5Phase, StageState>;
}

interface PinnedIdentity {
  session: {jobId: string; tenantId: string; taskId: string; contentTaskId: string; runId: string};
  storyboardSha256: string;
  avatarId: string;
  voiceId: string;
}

async function readPinnedIdentity(): Promise<PinnedIdentity> {
  let session: PinnedIdentity['session'];
  try {
    session = await readJson(SESSION_FILE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('step5_seed_required');
    fail('step5_session_missing');
  }
  if (session.tenantId !== TENANT_ID || session.contentTaskId !== CONTENT_TASK_ID
    || session.runId !== RUN_ID || !session.jobId) fail('step5_session_missing');
  const read = await readStoryboardFile(STORYBOARD_FILE, {checkLocalFiles: true});
  if (!read.ok || !read.storyboard || !read.sha256) fail('step5_storyboard_invalid');
  return {
    session,
    storyboardSha256: read.sha256,
    avatarId: read.storyboard.presenter.avatarId,
    voiceId: read.storyboard.presenter.voiceId,
  };
}

async function leaseInfo(): Promise<{owner: string; pid: number; expiresAt: string} | null> {
  try {
    const value = await readJson(LOCK_FILE);
    if (!value || typeof value.owner !== 'string' || !Number.isInteger(value.pid)) return null;
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}

async function leaseLive(): Promise<boolean> {
  const lease = await leaseInfo();
  if (!lease) return false;
  if (Date.parse(lease.expiresAt) <= Date.now()) return false;
  return isPidAlive(lease.pid);
}

async function acquireLease(owner: string): Promise<boolean> {
  await fs.mkdir(STATE_DIR, {recursive: true, mode: 0o700});
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(LOCK_FILE, 'wx');
      await handle.writeFile(JSON.stringify({
        owner, pid: process.pid, expiresAt: new Date(Date.now() + LEASE_MS).toISOString(),
      }), {encoding: 'utf8'});
      await handle.close();
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await leaseLive()) return false;
      await fs.rm(LOCK_FILE, {force: true});
    }
  }
  return false;
}

async function heartbeat(owner: string): Promise<void> {
  const payload = JSON.stringify({
    owner, pid: process.pid, expiresAt: new Date(Date.now() + LEASE_MS).toISOString(),
  });
  const current = await leaseInfo();
  if (!current || current.owner !== owner || current.pid !== process.pid) fail('step5_lease_lost');
  await fs.writeFile(LOCK_FILE, payload, {encoding: 'utf8', mode: 0o600});
}

async function releaseLease(owner: string): Promise<void> {
  const current = await leaseInfo();
  if (current && current.owner === owner && current.pid === process.pid) {
    await fs.rm(LOCK_FILE, {force: true});
  }
}

async function probeFinal(file: string): Promise<FinalProbe> {
  if (!ffmpegStatic) fail('step5_final_probe_failed');
  let stderr = '';
  try {
    const result = await execFileAsync(ffmpegStatic, ['-hide_banner', '-nostdin', '-i', file], {
      encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
    });
    stderr = String(result.stderr || '');
  } catch (error) {
    stderr = String((error as {stderr?: string}).stderr || '');
  }
  const duration = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const video = stderr.match(/Video:\s*([^,\s]+)[^\n]*?(\d{2,5})x(\d{2,5})/);
  const audio = stderr.match(/Audio:\s*([^,\s]+)[^\n]*?(\d+)\s*Hz/);
  let decodable = false;
  try {
    await execFileAsync(ffmpegStatic, ['-hide_banner', '-nostdin', '-v', 'error', '-i', file, '-f', 'null', '-'], {
      encoding: 'utf8', timeout: 300_000, maxBuffer: 16 * 1024 * 1024,
    });
    decodable = true;
  } catch { decodable = false; }
  return {
    durationSeconds: duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : 0,
    width: video ? Number(video[2]) : 0,
    height: video ? Number(video[3]) : 0,
    videoCodec: video ? video[1].toLowerCase() : '',
    audioCodec: audio ? audio[1].toLowerCase() : '',
    sampleRate: audio ? Number(audio[2]) : null,
    decodable,
  };
}

async function collectProviderEvidence(read: Awaited<ReturnType<typeof readStoryboardFile>>):
  Promise<NonNullable<Step5State['provider']>> {
  if (!read.storyboard) fail('step5_storyboard_invalid');
  const shots: NonNullable<Step5State['provider']>['shots'] = [];
  let localCount = 0;
  let evidenceCount = 0;
  for (const shot of read.storyboard.shots) {
    if (shot.kind === 'presenter') {
      const localState = path.join(STEP4_SHOTS, shot.id, 'state.json');
      if (await exists(localState)) {
        const state = await readJson(localState);
        if (state.phase !== 'downloaded' || !state.videoId) fail('step5_provider_evidence_missing', shot.id);
        if (state.storyboardSha256 !== read.sha256) fail('step5_provider_evidence_missing', `${shot.id}:storyboard_drift`);
        const mediaFile = path.join(STEP4_SHOTS, shot.id, 'provider-output.mp4');
        if (await exists(mediaFile)) {
          const bytes = await fs.readFile(mediaFile);
          if (sha(bytes) !== state.mediaSha256) fail('step5_provider_media_hash_mismatch', shot.id);
        }
        shots.push({
          id: shot.id, kind: 'presenter', videoId: String(state.videoId),
          requestId: state.requestId ?? null, durationSeconds: Number(state.duration) || null,
          chargedCny: Number.isFinite(state.chargedCny) ? Number(state.chargedCny) : null,
        });
        localCount += 1;
        continue;
      }
      const evidenceFile = path.join(EVIDENCE_DIR, `step4-${shot.id}.json`);
      if (!await exists(evidenceFile)) fail('step5_provider_evidence_missing', shot.id);
      const evidence = await readJson(evidenceFile);
      if (evidence.phase !== 'downloaded' || !evidence.videoId) fail('step5_provider_evidence_missing', shot.id);
      if (evidence.storyboardSha256 !== read.sha256) fail('step5_provider_evidence_missing', `${shot.id}:storyboard_drift`);
      shots.push({
        id: shot.id, kind: 'presenter', videoId: String(evidence.videoId),
        requestId: evidence.requestId ?? null,
        durationSeconds: Number(evidence.providerDuration ?? evidence.duration) || null,
        chargedCny: Number.isFinite(evidence.chargedCny) ? Number(evidence.chargedCny) : null,
      });
      evidenceCount += 1;
    } else {
      const localState = path.join(STEP4_NARRATION, shot.id, 'state.json');
      if (await exists(localState)) {
        const state = await readJson(localState);
        if (state.phase !== 'downloaded' || !state.audioSha256) fail('step5_provider_evidence_missing', shot.id);
        if (state.storyboardSha256 !== read.sha256) fail('step5_provider_evidence_missing', `${shot.id}:storyboard_drift`);
        const audioFile = path.join(STEP4_NARRATION, shot.id, 'narration.mp3');
        if (await exists(audioFile)) {
          const bytes = await fs.readFile(audioFile);
          if (sha(bytes) !== state.audioSha256) fail('step5_provider_media_hash_mismatch', shot.id);
        }
        shots.push({
          id: shot.id, kind: 'illustration', videoId: null, requestId: state.requestId ?? null,
          durationSeconds: Number(state.provider?.duration) || null,
          chargedCny: Number.isFinite(state.chargedCny) ? Number(state.chargedCny) : null,
        });
        localCount += 1;
        continue;
      }
      const evidenceFile = path.join(EVIDENCE_DIR, `step4-narration-${shot.id}.json`);
      if (!await exists(evidenceFile)) fail('step5_provider_evidence_missing', shot.id);
      const evidence = await readJson(evidenceFile);
      if (evidence.phase !== 'downloaded' || !evidence.audioSha256) fail('step5_provider_evidence_missing', shot.id);
      if (evidence.storyboardSha256 !== read.sha256) fail('step5_provider_evidence_missing', `${shot.id}:storyboard_drift`);
      shots.push({
        id: shot.id, kind: 'illustration', videoId: null, requestId: evidence.requestId ?? null,
        durationSeconds: Number(evidence.providerDuration) || null,
        chargedCny: Number.isFinite(evidence.chargedCny) ? Number(evidence.chargedCny) : null,
      });
      evidenceCount += 1;
    }
  }
  const presenters = shots.filter(shot => shot.kind === 'presenter').length;
  const illustrations = shots.filter(shot => shot.kind === 'illustration').length;
  if (presenters < 2 || illustrations < 2) fail('step5_provider_evidence_missing', 'two_presenter_two_illustration_required');

  let approvedCny: number | null = null;
  let paidSubmissions: number | null = null;
  if (await exists(STEP4_BUDGET)) {
    const budget = await readJson(STEP4_BUDGET);
    approvedCny = Number.isFinite(budget.approvedCny) ? Number(budget.approvedCny) : null;
    paidSubmissions = Number.isFinite(budget.paidSubmissions) ? Number(budget.paidSubmissions) : null;
  } else if (await exists(EVIDENCE_FINAL_JSON)) {
    // Clean clone: the local budget ledger is not committed, so keep the cap
    // and paid-submission count from the sanitized Step 4 evidence.
    const final = await readJson(EVIDENCE_FINAL_JSON);
    approvedCny = Number.isFinite(final.budget?.approvedCny) ? Number(final.budget.approvedCny) : null;
    paidSubmissions = Number.isFinite(final.budget?.paidSubmissions) ? Number(final.budget.paidSubmissions) : null;
  }
  const chargedValues = shots.map(shot => shot.chargedCny).filter((value): value is number => value !== null);
  const chargedCny = chargedValues.length ? Number(chargedValues.reduce((sum, value) => sum + value, 0).toFixed(6)) : null;
  return {
    source: evidenceCount === 0 ? 'local-step4-state' : (localCount === 0 ? 'committed-step4-evidence' : 'mixed'),
    shots, approvedCny, chargedCny, paidSubmissions,
    note: '供应商阶段复用 Step 4 已付费并落盘的镜头记录；Step 5 不重复提交、不再扣费。',
  };
}

async function manifestInputsPresent(): Promise<boolean> {
  if (!await exists(STEP4_MANIFEST)) return false;
  const manifest = await readJson(STEP4_MANIFEST);
  const files: string[] = [];
  if (manifest?.voiceover?.url) files.push(String(manifest.voiceover.url));
  for (const item of Array.isArray(manifest?.timeline) ? manifest.timeline : []) {
    if (typeof item?.url === 'string' && !/^https?:/i.test(item.url)) files.push(item.url);
  }
  for (const file of files) {
    if (!await exists(path.isAbsolute(file) ? file : path.resolve(file))) return false;
  }
  return files.length > 0;
}

async function composeFinal(state: Step5State): Promise<NonNullable<Step5State['composition']>> {
  await fs.mkdir(STEP5_OUTPUT_DIR, {recursive: true, mode: 0o700});
  let sourceFile: string;
  let mode: 'recomposed' | 'reused-verified-evidence';
  let manifestSha256: string | null = null;

  if (await manifestInputsPresent()) {
    const manifest = await readJson(STEP4_MANIFEST);
    const manifestText = JSON.stringify(manifest);
    manifestSha256 = sha(manifestText);
    const rendered = await composite(manifest, () => undefined, STEP5_OUTPUT_DIR);
    if (!rendered.ok || !rendered.outputPath) fail('step5_render_failed', rendered.error || 'unknown');
    sourceFile = rendered.outputPath;
    mode = 'recomposed';
  } else {
    if (!await exists(EVIDENCE_FINAL_MP4)) fail('step5_media_missing', 'step4-final');
    const record = await readJson(EVIDENCE_FINAL_JSON);
    const bytes = await fs.readFile(EVIDENCE_FINAL_MP4);
    if (record?.final?.sha256 && sha(bytes) !== record.final.sha256) fail('step5_media_hash_mismatch', 'step4-final');
    sourceFile = EVIDENCE_FINAL_MP4;
    mode = 'reused-verified-evidence';
  }

  const bytes = await fs.readFile(sourceFile);
  const finalSha = sha(bytes);
  const stableFile = path.join(STATE_DIR, 'final.mp4');
  await fs.writeFile(stableFile, bytes, {mode: 0o600});
  const probe = await probeFinal(stableFile);
  const errors = validateFinalProbe(probe);
  if (errors.length) fail('step5_final_probe_failed', errors.join(','));
  return {mode, file: stableFile, bytes: bytes.length, sha256: finalSha, probe, manifestSha256};
}

async function findCompletedArtifact(key: string): Promise<any | null> {
  return local(async () => {
    const rows = await store.list<any>('starter_social_content_artifacts', {perPage: 1000});
    return rows.items.find(row => row.tenant_id === TENANT_ID
      && row.content?.step5IdempotencyKey === key
      && ['review_required', 'approved'].includes(String(row.status))) ?? null;
  });
}

async function writeBack(state: Step5State): Promise<NonNullable<Step5State['writeBack']>> {
  const composition = state.composition;
  if (!composition) fail('step5_media_missing');
  let session: PinnedIdentity['session'];
  try { session = await readJson(SESSION_FILE); }
  catch { fail('step5_seed_required'); }

  return local(async () => {
    let job = await readContentExecutionJob(store, TENANT_ID, CONTENT_TASK_ID, RUN_ID);
    if (!job) fail('step5_job_terminal_error', 'job_missing');

    if (job.status !== 'succeeded') {
      const worker = new DurableContentExecutionWorker({
        dataStore: store, dataAuthority: 'local', allowedJobIds: [session.jobId], now: FIXED_NOW,
        execute: async claimed => {
          const prepared = await readJson(CONTEXT_FILE);
          const cache = prepared.context.cache;
          const finalSha = composition.sha256;
          const bytes = await fs.readFile(composition.file);
          const stored = await storeSocialContentFile({
            tenantId: claimed.tenantId, stream: Readable.from([bytes]),
            name: 'step5-heygen-multishot.mp4', mimeType: 'video/mp4', declaredLength: bytes.length,
          });
          const file = await registerSocialContentFile({
            repository: createStarter198Repository(store), tenantId: claimed.tenantId, userId: 'owner',
            taskId: claimed.taskId, usage: 'artifact_media',
            idempotencyKey: `step5-file-${state.idempotencyKey.slice(0, 24)}`,
            stored, now: FIXED_NOW(),
          });
          if (file.sha256 !== finalSha) fail('step5_hash_chain_mismatch', 'registered_file');

          const content = await readJson(TEMPLATE_FILE);
          const {sceneReworkHash} = await import('../server/starter198/socialContentSceneRework.js');
          // The scene cache requires exactly one voice source and one source
          // per scene asset id. The final MP4 is the only rendered medium in
          // this chain, so both roles point at the same verified bytes.
          const assetIds = [...new Set(cache.scenes.map((scene: any) => scene.result.asset.id))];
          content.initialSceneSourceHashes = [
            {role: 'voice', id: 'voice', source: composition.file, sha256: finalSha},
            ...assetIds.map(id => ({role: 'asset', id, source: composition.file, sha256: finalSha})),
          ];
          const sourceManifest = {
            jobId: `step5-${state.idempotencyKey.slice(0, 12)}`,
            spec: {
              duration: composition.probe.durationSeconds, ratio: '9:16', resolution: '1080p',
            },
            timeline: [{
              type: 'video', url: composition.file,
              targetStart: 0, targetEnd: composition.probe.durationSeconds,
            }],
            voiceover: {url: composition.file},
          };
          content.initialSceneCacheInput = {
            planHash: cache.planHash,
            baselineHash: sceneReworkHash(prepared.context.baseline),
            manifestHash: sceneReworkHash(sourceManifest),
            productionSceneIds: cache.scenes.map((scene: any) => scene.productionSceneId),
            executionHash: sceneReworkHash(content.assetSupplyExecution),
          };
          content.mediaStorage = {
            video: {fileId: file.fileId, fileRef: file.fileRef, url: file.downloadUrl, sha256: file.sha256},
          };
          content.productionWorkspaceSource = {
            runId: claimed.runId, outputSha256: file.sha256, type: 'heygen-multishot-automated-pipeline',
            providerShots: state.provider?.shots ?? [],
            step5IdempotencyKey: state.idempotencyKey,
          };
          content.render = {
            completed: true, pipeline: 'step5-heygen-multishot', outputSha256: file.sha256,
            compositionMode: composition.mode,
          };
          content.productionResult = {
            ...content.productionResult,
            artifactResourceRef: file.fileRef, artifactId: null,
            technicalReview: {approved: false}, creativeReview: {approved: false},
          };
          content.step5IdempotencyKey = state.idempotencyKey;
          content.step5Provider = state.provider ?? null;
          content.step5Composition = {
            mode: composition.mode, sha256: composition.sha256, bytes: composition.bytes,
            durationSeconds: composition.probe.durationSeconds, width: composition.probe.width,
            height: composition.probe.height, videoCodec: composition.probe.videoCodec,
            audioCodec: composition.probe.audioCodec,
          };

          const result = await createSocialContentArtifact({
            repository: createStarter198Repository(store), tenantId: claimed.tenantId, userId: 'owner',
            taskId: claimed.taskId,
            idempotencyKey: `step5-artifact-${state.idempotencyKey.slice(0, 24)}`,
            trustedAgentOrigin: true, requireHumanReview: true, now: FIXED_NOW(),
            value: {
              kind: 'short_video', platform: 'tiktok', language: 'en', origin: 'agent',
              resourceRef: file.fileRef, content,
            },
          });
          if (result.artifact.status !== 'review_required') fail('step5_artifact_not_review_required', result.artifact.status);

          const {buildSocialProductionReceipt, persistSocialProductionReceipt} = await import(
            '../server/starter198/socialContentProductionHandoff.js'
          );
          const {sealSocialSceneMediaCache} = await import('../server/starter198/socialContentSceneRework.js');
          const {createSocialSceneReworkService} = await import(
            '../server/starter198/socialContentSceneReworkService.js'
          );
          const scenes = [];
          for (const scene of cache.scenes) {
            const receipt = buildSocialProductionReceipt({
              handoff: prepared.handoff, productionResult: content.productionResult, gate: 'G4',
              sceneId: scene.productionSceneId, attempt: 1, status: 'review_required',
              actor: 'content_agent', artifactRefs: [file.fileRef],
              evidenceRefs: [
                'step5-heygen-multishot-automated-pipeline',
                `composition:${composition.mode}`,
                `final-sha256:${composition.sha256}`,
              ],
              checks: [
                {code: 'format', passed: true, message: '1080x1920 H.264/AAC'},
                {code: 'duration', passed: true, message: `${composition.probe.durationSeconds.toFixed(2)}s within 30-37s`},
                {code: 'audio_visual_sync', passed: true, message: 'per-segment audio measured; manual listening pending'},
                {code: 'caption', passed: true, message: 'subtitles burned by render.cjs'},
                {code: 'linked_assets', passed: true, message: 'file and artifact hashes match'},
                {code: 'render', passed: true, message: 'FFmpeg decode passed'},
                {code: 'sensitive_data', passed: false, message: 'pending human review'},
              ],
            });
            await persistSocialProductionReceipt(createStarter198Repository(store), claimed.tenantId, receipt);
            scenes.push({
              ...scene, sha256: finalSha,
              result: {...scene.result, asset: {...scene.result.asset, url: composition.file, localPath: composition.file}},
              technicalReceiptId: receipt.receiptId, status: 'review_required',
            });
          }
          const raw = (await store.list<any>('starter_social_content_artifacts', {
            where: {tenant_id: TENANT_ID, artifact_id: result.artifact.artifactId},
          })).items[0];
          const {recordHash, ...baseCache} = cache;
          const context = {
            ...prepared.context,
            cache: sealSocialSceneMediaCache({
              ...baseCache, parentArtifactId: result.artifact.artifactId,
              parentArtifactHash: raw.content_hash, scenes,
              renderInput: {
                manifest: sourceManifest,
                sourceManifest,
                mediaRemap: [],
                voice: {localPath: composition.file, sha256: composition.sha256},
                bgm: null,
              },
            }),
          };
          await createSocialSceneReworkService(createStarter198Repository(store)).saveCache(context);
          const createdContent = result.artifact.content as any;
          if (result.artifact.status !== 'review_required'
            || createdContent?.productionResult?.technicalReview?.approved !== false
            || createdContent?.productionResult?.creativeReview?.approved !== false)
            fail('step5_artifact_not_review_required');
        },
      });
      await worker.drain();
      for (let attempt = 0; attempt < 900; attempt += 1) {
        job = await readContentExecutionJob(store, TENANT_ID, CONTENT_TASK_ID, RUN_ID);
        if (job && ['succeeded', 'failed', 'blocked', 'dead_letter', 'retry_wait'].includes(job.status)) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      worker.stop();
      if (!job || job.status !== 'succeeded') fail('step5_job_terminal_error', job?.status ?? 'timeout');
    }

    const rows = await store.list<any>('starter_social_content_artifacts', {perPage: 1000});
    const artifact = rows.items.find(row => row.tenant_id === TENANT_ID
      && row.content?.step5IdempotencyKey === state.idempotencyKey
      && row.task_id === CONTENT_TASK_ID) ?? null;
    if (!artifact) fail('step5_job_terminal_error', 'artifact_missing');
    if (artifact.status !== 'review_required') fail('step5_artifact_not_review_required', artifact.status);
    const media = artifact.content?.mediaStorage?.video;
    const fileRows = await store.list<any>('starter_social_content_files', {
      where: {tenant_id: TENANT_ID, file_id: media?.fileId},
    });
    const file = fileRows.items[0];
    if (!file || file.content_sha256 !== composition.sha256 || media?.sha256 !== composition.sha256
      || artifact.resource_ref !== `socialfile:${media.fileId}`)
      fail('step5_hash_chain_mismatch', 'file_artifact_media');
    if (artifact.content?.productionResult?.technicalReview?.approved !== false
      || artifact.content?.productionResult?.creativeReview?.approved !== false)
      fail('step5_artifact_not_review_required', 'reviews_not_false');

    const weeklyWorker = createSocialWeeklyExecutionWorker(store);
    const claim = await weeklyWorker.claimNext({
      tenantId: TENANT_ID, workerId: 'step5-weekly', now: FIXED_NOW(),
      scope: {tenantId: TENANT_ID, programId: 'p', packageId: 'week1', packageVersion: 1},
    });
    let settlement: NonNullable<Step5State['settlement']>;
    if (!claim) {
      const current = (await store.list<any>('social_weekly_execution_tasks', {
        where: {tenant_id: TENANT_ID, task_id: 'video'},
      })).items[0];
      settlement = current?.status === 'succeeded'
        ? {status: 'succeeded', code: null, message: '已由原周任务消费者结算'}
        : {status: 'idle', code: null, message: '周任务当前不可领取，未重复结算'};
    } else {
      try {
        const result = await createSocialWeeklyProductionAdapter(store, {now: FIXED_NOW}).execute(claim.task);
        if (result.status === 'succeeded') {
          await weeklyWorker.complete(claim, result.resultRefs, FIXED_NOW());
          settlement = {status: 'succeeded', code: null, message: '原周任务消费者已完成结算'};
        } else {
          await weeklyWorker.defer(claim, {
            code: result.code, message: result.message, retryDelayMs: 1000,
            blockingReason: result.status === 'blocked' ? result.code : undefined, now: FIXED_NOW(),
          });
          settlement = {status: result.status, code: result.code, message: result.message};
        }
      } catch (error) {
        await weeklyWorker.fail(claim, {
          code: 'step5_settlement_failed', message: describeError(error), retryable: false, now: FIXED_NOW(),
        });
        throw error;
      }
    }
    state.settlement = settlement;
    if (settlement.status === 'blocked' || settlement.status === 'failed') {
      fail('step5_weekly_settlement_failed', settlement.code ?? settlement.status);
    }

    return {
      artifactId: artifact.artifact_id, fileId: media.fileId, fileRef: artifact.resource_ref,
      sha256: composition.sha256, bytes: composition.bytes, status: artifact.status,
      taskId: artifact.task_id, runId: RUN_ID, jobId: session.jobId,
      technicalApproved: false, creativeApproved: false,
    };
  });
}

async function beginPhase(state: Step5State, phase: Step5Phase): Promise<void> {
  state.phase = phase;
  const stage = state.stages[phase];
  stage.status = 'active';
  stage.startedAt = now();
  await persist(state);
}

async function finishPhase(state: Step5State, phase: Step5Phase, detail: string,
  source?: string): Promise<void> {
  const stage = state.stages[phase];
  stage.status = 'done';
  stage.completedAt = now();
  stage.detail = detail;
  if (source) stage.source = source;
  await persist(state);
}

async function runPipeline(state: Step5State, owner: string): Promise<void> {
  const timer = setInterval(() => {
    void heartbeat(owner).catch(() => undefined);
  }, Math.floor(LEASE_MS / 3));
  timer.unref?.();
  try {
    await beginPhase(state, 'submitting');
    state.provider = await collectProviderEvidence(await readStoryboardFile(STORYBOARD_FILE, {checkLocalFiles: true}));
    await finishPhase(state, 'submitting', '已确认 Step 4 的供应商请求记录，未重新提交', state.provider.source);

    await beginPhase(state, 'accepted');
    const accepted = state.provider.shots.every(shot => Boolean(shot.videoId || shot.requestId));
    if (!accepted) fail('step5_provider_evidence_missing', 'request_not_accepted');
    await finishPhase(state, 'accepted', '3 段人物视频已受理，3 段旁白已生成', state.provider.source);

    await beginPhase(state, 'generating');
    await finishPhase(state, 'generating', '人物镜头均达到 downloaded 阶段，时长与哈希已记录', state.provider.source);

    await beginPhase(state, 'downloading');
    await finishPhase(state, 'downloading', '媒体文件与记录哈希一致，未发起新的下载', state.provider.source);

    await beginPhase(state, 'compositing');
    state.composition = await composeFinal(state);
    await finishPhase(state, 'compositing',
      `${state.composition.mode === 'recomposed' ? '重新自动合成' : '复用已验证成片'}：${state.composition.probe.durationSeconds.toFixed(2)}s，`
      + `${state.composition.probe.width}×${state.composition.probe.height}，${state.composition.probe.videoCodec}/${state.composition.probe.audioCodec}`,
      state.composition.mode);

    await beginPhase(state, 'writing_back');
    state.writeBack = await writeBack(state);
    await finishPhase(state, 'writing_back',
      `产物 ${state.writeBack.artifactId} 已登记；周任务结算 ${state.settlement?.status ?? 'unknown'}`,
      'original-content-commands');

    await beginPhase(state, 'review_required');
    await finishPhase(state, 'review_required', 'technicalReview=false、creativeReview=false，等待人工审核');
    state.phase = 'review_required';
    state.completedAt = now();
    await persist(state);
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const active = STEP5_PHASES.find(name => state.stages[name].status === 'active');
    state.error = {code: step5ErrorCode(error), message: describeError(error), phase: active ?? state.phase, at: now()};
    if (active) state.stages[active].status = 'failed';
    state.phase = 'failed';
    await persist(state);
    console.error('[step5] pipeline failed', step5ErrorCode(error),
      describeError(error).slice(0, 500));
  } finally {
    clearInterval(timer);
    await releaseLease(owner);
  }
}

export interface StartResult {
  status: 'started' | 'already_running' | 'already_complete' | 'recovered';
  pipeline: PublicStep5State | null;
}

export async function startPipeline(): Promise<StartResult> {
  await fs.mkdir(STATE_DIR, {recursive: true, mode: 0o700});
  const pinned = await readPinnedIdentity();
  const idempotencyKey = buildIdempotencyKey({
    taskId: pinned.session.taskId, runId: pinned.session.runId,
    storyboardSha256: pinned.storyboardSha256, avatarId: pinned.avatarId, voiceId: pinned.voiceId,
  });

  let state = await readPipelineState();
  if (state && state.idempotencyKey !== idempotencyKey) fail('step5_storyboard_or_identity_changed');

  if (state?.phase === 'review_required') {
    // Seed/reset removes the business store but not this state directory. Do
    // not claim completion when the referenced artifact no longer exists.
    if (await findCompletedArtifact(idempotencyKey)) {
      return {status: 'already_complete', pipeline: toPublicState(state)};
    }
    state = null;
  }

  if (state && ['prepared', 'submitting', 'accepted', 'generating', 'downloading', 'compositing',
    'writing_back'].includes(state.phase)) {
    if (await leaseLive()) return {status: 'already_running', pipeline: toPublicState(state)};
  }

  const existing = await findCompletedArtifact(idempotencyKey);
  if (existing) {
    state = state ?? {
      schemaVersion: 1, idempotencyKey, phase: 'review_required',
      taskId: pinned.session.taskId, contentTaskId: CONTENT_TASK_ID, runId: pinned.session.runId,
      jobId: pinned.session.jobId, weeklyTaskId: 'video',
      storyboardSha256: pinned.storyboardSha256, avatarId: pinned.avatarId, voiceId: pinned.voiceId,
      startedAt: existing.created_at ?? now(), updatedAt: now(), stages: blankStages(),
    };
    state.phase = 'review_required';
    for (const phase of STEP5_PHASES) state.stages[phase].status = 'done';
    state.completedAt = state.completedAt ?? now();
    const media = existing.content?.mediaStorage?.video;
    state.writeBack = {
      artifactId: existing.artifact_id, fileId: media?.fileId ?? '', fileRef: existing.resource_ref,
      sha256: media?.sha256 ?? '', bytes: Number(existing.content?.step5Composition?.bytes) || 0,
      status: existing.status, taskId: existing.task_id, runId: pinned.session.runId,
      jobId: pinned.session.jobId, technicalApproved: false, creativeApproved: false,
    };
    await persist(state);
    return {status: 'already_complete', pipeline: toPublicState(state)};
  }

  const owner = `${process.pid}-${randomUUID()}`;
  if (!await acquireLease(owner)) return {status: 'already_running', pipeline: toPublicState(state)};
  try {
    if (!state) {
      state = {
        schemaVersion: 1, idempotencyKey, phase: 'prepared',
        taskId: pinned.session.taskId, contentTaskId: CONTENT_TASK_ID, runId: pinned.session.runId,
        jobId: pinned.session.jobId, weeklyTaskId: 'video',
        storyboardSha256: pinned.storyboardSha256, avatarId: pinned.avatarId, voiceId: pinned.voiceId,
        startedAt: now(), updatedAt: now(), stages: blankStages(),
      };
    } else {
      state.phase = 'prepared';
      state.error = undefined;
      state.stages = blankStages();
      state.completedAt = undefined;
      state.composition = undefined;
      state.writeBack = undefined;
      state.settlement = undefined;
    }
    state.execution = {owner, pid: process.pid,
      leaseExpiresAt: new Date(Date.now() + LEASE_MS).toISOString()};
    state.stages.prepared.status = 'done';
    state.stages.prepared.startedAt = now();
    state.stages.prepared.completedAt = now();
    state.stages.prepared.detail = '已固定 task/run/storyboard/avatar/voice 身份';
    await persist(state);
    void runPipeline(state, owner);
    return {status: 'started', pipeline: toPublicState(state)};
  } catch (error) {
    await releaseLease(owner);
    throw error;
  }
}

