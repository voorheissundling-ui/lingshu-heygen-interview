/**
 * Step 5 business-chain pipeline.
 *
 * Two modes share one state machine and one durable job:
 *
 *  - `reuse` (default, zero-cost): consumes the real HeyGen shots that Step 4
 *    generated, re-downloads them through the adoption bridge or reuses the
 *    local media, composes the 1080x1920 final, writes it back through the
 *    ORIGINAL content file/artifact commands, and lets the weekly consumer
 *    settle the run. No paid provider call is possible in this mode.
 *  - `generate`: page-triggered real generation. The page must confirm the
 *    approved CNY cap; a fresh read-only preflight, public-presenter binding
 *    and wallet check run first. Unchanged shots reuse Step 4 media, edited
 *    shots submit exactly once, and a lost response becomes
 *    `submission_unknown` and is only reconciled by GETs.
 *
 * Both modes leave the artifact at review_required.
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
import {
  currentContentProviderReceipts, recordCurrentContentProviderReceipt,
} from '../server/contentExecution/context.js';
import {storeSocialContentFile, registerSocialContentFile} from '../server/starter198/socialContentFiles.js';
import {createSocialContentArtifact} from '../server/starter198/socialContentOutputs.js';
import {
  buildStep4Plan, buildStep4RenderManifest, validateStep4Plan,
} from './step4Plan.js';
import {isStep5LiveBridgeEnabled, prepareStep5LiveAdoption,
  type Step4PresenterSource, type Step5LiveAdoption} from './step5LiveBridge.js';
import {
  isStep5PageGenerationEnabled, prepareStep5Generation, runStep5Generation,
  readStep5GenerationSummary, reconcileStep5Generation, step5GenerationCapFromEnv,
  type PreparedStep5Generation, type Step5GenerationResult,
} from './step5Generation.js';

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
const STEP5_ADOPTED_DIR = path.join(DATA_ROOT, 'step5-adopted');
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
export type Step5Mode = 'reuse' | 'generate';
export type Step5TerminalPhase = 'failed' | 'blocked' | 'idle' | 'submission_unknown';

export const PHASE_LABELS: Record<Step5Phase, string> = {
  prepared: '准备任务与身份',
  submitting: '提交或确认供应商任务',
  accepted: '供应商已受理',
  generating: '查询生成结果',
  downloading: '校验/下载媒体',
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
  step5_live_bridge_key_missing: '真实模式未加载 HeyGen Key，无法在线查询已受理任务；请用 real:dev 与包外 Key 启动。',
  step5_live_bridge_public_evidence_missing: 'Step 4 缺少公共人物证据（目录引用/条款/核验时间/账户），不能用在线桥接。',
  step5_live_bridge_public_evidence_mismatch: 'Step 4 各镜头的人物/声音/公共证据不一致，拒绝混用。',
  step5_live_bridge_media_url_untrusted: '供应商返回的媒体地址不在允许的 HTTPS 下载域，已拒绝下载。',
  step5_public_presenter_registry_ambiguous: '人物注册表不唯一或结构异常，无法绑定公共人物。',
  step5_public_presenter_binding_invalid: '公共人物绑定校验失败：目录证据无效、已过期或注册失败。',
  step5_credential_account_changed: '当前 Key 对应的 HeyGen 账户与 Step 4 公共证据不一致，已拒绝接管。',
  step5_provider_pending: '供应商任务仍在处理中，未下载、未回写；请稍后用同一任务重试。',
  step5_provider_failed: '供应商任务已失败，未重提、未回写；请核对供应商错误。',
  step5_provider_uncertain: '供应商状态未知或下载/上传失败，已停止；不会重复提交付费任务。',
  step5_provider_receipt_incomplete: '供应商回执未全部 completed 或 providerTaskId 不一致，拒绝回写。',
  step5_provider_duration_mismatch: '供应商视频时长与 Step 4 记录不一致，已停止下载。',
  step5_live_bridge_requires_step4_manifest: '真实桥接需要本机保留的 Step 4 清单、说明图与旁白；缺失时拒绝用旧成片兜底。',
  step5_adoption_only_no_new_submission: '零新增费用模式禁止任何创建/上传等写请求；已拦截。',
  step5_generation_disabled: '页面真实生成未启用：需 real:dev、包外 Key 与 STEP5_PAGE_GENERATION_ENABLED=1。',
  step5_generation_key_missing: '真实生成需要 HeyGen Key；Key 只从仓库外读取，页面不会展示。',
  step5_generation_cap_not_configured: '未设置 HEYGEN_INTERVIEW_MAX_CNY；真实生成必须给出明确的 CNY 上限。',
  step5_generation_cap_exceeds_limit: 'HEYGEN_INTERVIEW_MAX_CNY 超过本页允许的 8 CNY 上限，已拒绝。',
  step5_generation_cap_not_confirmed: '页面未确认预算上限；真实生成必须由操作者显式确认。',
  step5_generation_cap_confirmation_mismatch: '页面确认的上限与 HEYGEN_INTERVIEW_MAX_CNY 不一致，已拒绝。',
  step5_generation_budget_missing: '找不到 Step 4 预算账本，无法沿用已批准上限；请先完成 Step 4。',
  step5_generation_budget_exhausted: '预算已用尽（含未结算预占），不能再提交真实生成；请按原预算流程处理。',
  step4_forecast_exceeds_approved_budget: '预算不足：本次预占后超过已批准上限，已在提交前拒绝，未产生供应商任务。',
  step4_forecast_invalid: '预算估算无效（必须为正数），已在提交前拒绝。',
  step4_approved_budget_changed: '预算批准上限已变化，拒绝沿用旧账本；请按原预算流程重新确认。',
  step4_credential_changed: '当前凭据与预算账本不一致，拒绝提交。',
  step4_budget_storyboard_changed: '分镜已变化但预算账本未更新，拒绝提交。',
  step4_budget_schema_invalid: '预算账本格式无效，拒绝提交。',
  step5_generation_budget_approved_above_limit: '预算账本的批准上限超过本页 8 CNY 限制，已拒绝。',
  step5_generation_credential_account_changed: '当前 Key 对应的账户/凭据与预算及 Step 4 证据不一致，已拒绝。',
  step5_generation_wallet_not_safe: '钱包不可安全使用：需 wallet、USD、余额充足且关闭自动充值。',
  step5_generation_wallet_balance_empty: '钱包余额为 0，无法预占真实生成；未提交任何任务。',
  step5_generation_preflight_missing: '找不到只读预检报告；请先运行 pnpm run provider:preflight。',
  step5_generation_preflight_incomplete: '只读预检报告未完成或未通过；请重新运行 provider:preflight。',
  step5_generation_preflight_stale_or_in_future: '只读预检证据已过期或时间异常；请重新运行 provider:preflight。',
  step5_generation_public_avatar_evidence_invalid: '预检中的人物证据无效（需公共 photo_avatar、completed、支持 avatar_iv）。',
  step5_generation_public_voice_evidence_invalid: '预检中的声音证据无效或与分镜语言不一致。',
  step5_generation_public_voice_has_no_speech_engine: '公共声音不支持 orca/starfish 语音引擎，无法生成旁白。',
  step5_generation_public_presenter_binding_invalid: '公共人物实时绑定校验失败（目录、所有权、钱包或注册表），已拒绝提交。',
  step5_generation_public_evidence_must_not_fake_clone_consent: '公共人物证据不得伪造克隆授权/同意字段，已拒绝。',
  step5_generation_speech_missing: '分镜台词为空，无法生成；请先补全台词。',
  step5_generation_presenter_duration_must_be_3_to_8_seconds: '人物镜头时长必须为 3–8 秒，避免超额生成。',
  step5_generation_storyboard_empty: '分镜没有镜头，无法生成。',
  step5_generation_submission_failed_before_send: '提交前失败，已释放预占；未产生供应商任务。',
  step5_generation_rejected_no_resubmit: '供应商明确拒绝该请求，已释放预占且不会重提；请修改内容后重新提交。',
  step5_generation_provider_failed: '供应商任务失败，不会重提；请核对失败原因。',
  step5_generation_provider_pending: '供应商仍在生成，媒体尚未就绪；稍后用同一任务继续轮询，未重复提交。',
  step5_generation_provider_receipt_invalid: '供应商完成回执缺少可用视频/时长，拒绝下载。',
  step5_generation_provider_duration_mismatch: '下载视频时长与供应商回执不一致，已停止。',
  step5_generation_presenter_duration_invalid: '人物视频时长不在 2–12.5 秒的可合成范围，已停止。',
  step5_generation_media_aspect_invalid: '人物视频不是 9:16（720/1080 宽），已停止。',
  step5_generation_media_codec_invalid: '人物视频编码不是 H.264，已停止。',
  step5_generation_media_audio_missing: '人物视频缺少可用音轨，已停止。',
  step5_generation_media_probe_failed: '无法解析下载的人物视频，已停止。',
  step5_generation_narration_probe_failed: '无法解析下载的旁白音频，已停止。',
  step5_generation_narration_duration_invalid: '旁白音频时长必须在 0–20 秒，已停止。',
  step5_generation_narration_receipt_invalid: '语音接口回执缺少 audio_url/duration/engine，已停止且不重提。',
  step5_generation_media_url_untrusted: '供应商返回的媒体地址不在允许的 HTTPS 下载域，已拒绝下载。',
  step5_generation_download_failed: '供应商媒体下载失败；任务 ID 已保存，可重试下载而无需重提。',
  step5_generation_media_too_large: '供应商媒体超过大小上限，已中止下载。',
  step5_generation_media_missing_no_resubmit: '本地媒体缺失且无法证明可重新下载；不重提付费任务，请人工核对。',
  step5_generation_video_id_missing_do_not_resubmit: '已提交但缺少 video_id，不能重提；请用对账接口按标题/时间窗查找。',
  step5_generation_audio_url_missing_do_not_resubmit: '旁白已提交但缺少音频地址，不能重提；请更新台词形成新内容版本。',
  step5_generation_submission_not_authorized: '提交回调未通过前置校验，已在发送前拦截。',
  step5_generation_submission_body_drift: '提交请求体与已记录身份不一致，已拦截，避免换内容复用幂等键。',
  step5_generation_accepted_request_mismatch: '供应商受理回执的 requestId 与本地记录不一致，已中止。',
  step5_generation_presenter_state_invalid: '人物镜头的本地状态不能继续轮询/下载，请查看账本。',
  step5_generation_narration_state_invalid: '旁白镜头的本地状态不能继续下载，请查看账本。',
  step5_generation_shot_not_downloaded: '镜头未达到 downloaded 阶段，拒绝合成。',
  step5_generation_plan_failed: '生成媒体无法组成 30–37 秒连续分镜，未回写；媒体已保留供核查。',
  step5_generation_voiceover_failed: '旁白音轨合成失败，未回写。',
  step5_generation_not_prepared: '真实生成缺少已通过的只读预检结果，已拦截；不会提交任何付费任务。',
  step5_generation_job_busy: '原队列任务仍在运行，无法安全开启新一轮生成；请等待其结束。',
  step5_generation_job_missing: '找不到原队列任务，无法回写；请先运行 pnpm run seed。',
  step5_reconcile_shot_required: '对账需要指定镜头 ID。',
  step5_reconcile_shot_not_found: '找不到该镜头的生成账本。',
  step5_reconcile_video_id_required: '人工对账需要提供 video_id。',
  step5_reconcile_video_id_invalid: 'video_id 格式无效。',
  step5_reconcile_not_found: '未在供应商任务列表中找到与标题、提交时间窗匹配的唯一任务。',
  step5_reconcile_ambiguous: '找到多个匹配任务，不能自动认定；请人工指定 video_id。',
  step5_reconcile_video_identity_mismatch: '指定视频的标题或创建时间与本地提交身份不一致，已拒绝。',
  step5_reconcile_list_failed: '读取供应商任务列表失败，请检查网络/鉴权后重试。',
  step5_reconcile_read_failed: '读取供应商任务详情失败，请稍后重试。',
  step5_reconcile_not_in_unknown_state: '该镜头不在待对账状态，无需对账。',
  step5_reconcile_requires_new_content_revision: '旁白任务无法按列表对账；请修改台词形成新的内容版本后再提交。',
  step5_submission_unknown: '提交结果未知：已停止，未重提；请先对账确认供应商任务，再继续下载与回写。',
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
  mode?: Step5Mode;
}): string {
  const base = [input.taskId, input.runId, input.storyboardSha256, input.avatarId, input.voiceId].join('|');
  // Reuse-mode keys stay byte-identical to the previously delivered contract;
  // generation gets a distinct identity so an adoption run and a paid run can
  // never be mistaken for each other.
  return sha(input.mode === 'generate' ? `${base}|live-generated` : base);
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

export interface Step5GenerationSummary {
  capCny: number;
  approvedCny: number;
  budgetChargedCny: number;
  budgetReservedCny: number;
  budgetRemainingCny: number;
  newPaidSubmissions: number;
  newChargedCny: number;
  reusedShots: number;
  presentersGenerated: number;
  narrationGenerated: number;
  reconciledShots: number;
  narrationEngine: 'orca' | 'starfish';
  preflightCheckedAt: string;
  accountRef: string;
  shots: Array<{
    shotId: string;
    kind: 'presenter' | 'illustration';
    phase: string;
    requestId: string;
    title: string;
    providerTaskId: string | null;
    providerStatus: string | null;
    durationSeconds: number | null;
    chargedCny: number;
    reusedFrom: 'step4' | 'generation' | null;
    reconciliation: Record<string, unknown> | null;
  }>;
}

export interface Step5State {
  schemaVersion: 1;
  idempotencyKey: string;
  mode?: Step5Mode;
  phase: Step5Phase | Step5TerminalPhase;
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
    source: 'local-step4-state' | 'committed-step4-evidence' | 'mixed' | 'live-bridge' | 'live-generated';
    shots: Array<{
      id: string; kind: 'presenter' | 'illustration'; videoId: string | null;
      requestId: string | null; durationSeconds: number | null; chargedCny: number | null;
      providerStatus?: string | null;
      phase?: string | null;
      mediaSha256?: string | null;
      mediaBytes?: number | null;
    }>;
    approvedCny: number | null;
    chargedCny: number | null;
    paidSubmissions: number | null;
    note: string;
    live?: {
      mode?: 'adoption' | 'generation';
      newPaidSubmissions: number;
      newChargedCny: number;
      statusCalls: number;
      downloads: number;
      uploads: number;
      presentersAdopted: number;
      accountRef: string;
      presenterAssetId: string;
    };
    generation?: Step5GenerationSummary;
  };
  composition?: {
    mode: 'recomposed' | 'reused-verified-evidence';
    providerMedia: 'step4-local' | 'live-adopted' | 'live-generated' | 'committed-evidence';
    file: string; bytes: number; sha256: string;
    probe: FinalProbe; manifestSha256: string | null;
    adoptedManifestSha256: string | null;
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
  mode: Step5Mode;
  active: boolean;
  phases: Array<{name: string; label: string; status: string; startedAt: string | null;
    completedAt: string | null; detail: string | null; source: string | null}>;
  generation: Step5GenerationSummary | null;
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
  const active = !['review_required', 'failed', 'blocked', 'idle', 'submission_unknown'].includes(state.phase);
  return {
    phase: state.phase,
    mode: state.mode ?? 'reuse',
    active,
    phases: STEP5_PHASES.map(name => publicStage(state.stages[name])),
    generation: state.provider?.generation ?? null,
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

interface CollectedProviderEvidence {
  provider: NonNullable<Step5State['provider']>;
  presenters: Step4PresenterSource[];
}

async function collectProviderEvidence(read: Awaited<ReturnType<typeof readStoryboardFile>>):
  Promise<CollectedProviderEvidence> {
  if (!read.storyboard) fail('step5_storyboard_invalid');
  const shots: NonNullable<Step5State['provider']>['shots'] = [];
  const presenters: Step4PresenterSource[] = [];
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
        const durationSeconds = Number(state.duration) || null;
        const mediaSha256 = String(state.mediaSha256 || '') || null;
        const mediaBytes = Number.isFinite(state.mediaBytes) ? Number(state.mediaBytes) : null;
        shots.push({
          id: shot.id, kind: 'presenter', videoId: String(state.videoId),
          requestId: state.requestId ?? null, durationSeconds,
          chargedCny: Number.isFinite(state.chargedCny) ? Number(state.chargedCny) : null,
          providerStatus: state.providerStatus ?? state.phase ?? null,
          phase: state.phase ?? null,
          mediaSha256, mediaBytes,
        });
        presenters.push({
          id: shot.id, script: String(state.speech || ''), requestId: String(state.requestId || ''),
          videoId: String(state.videoId), durationSeconds: Number(durationSeconds) || 0,
          mediaSha256: String(mediaSha256 || ''),
          ...(mediaBytes !== null ? {mediaBytes} : {}),
          avatarId: String(state.avatarId || ''), voiceId: String(state.voiceId || ''),
          publicEvidence: state.publicEvidence,
          ...(state.providerEvidenceRef ? {providerEvidenceRef: String(state.providerEvidenceRef)} : {}),
        });
        localCount += 1;
        continue;
      }
      const evidenceFile = path.join(EVIDENCE_DIR, `step4-${shot.id}.json`);
      if (!await exists(evidenceFile)) fail('step5_provider_evidence_missing', shot.id);
      const evidence = await readJson(evidenceFile);
      if (evidence.phase !== 'downloaded' || !evidence.videoId) fail('step5_provider_evidence_missing', shot.id);
      if (evidence.storyboardSha256 !== read.sha256) fail('step5_provider_evidence_missing', `${shot.id}:storyboard_drift`);
      const durationSeconds = Number(evidence.providerDuration ?? evidence.duration) || null;
      const mediaBytes = Number.isFinite(evidence.mediaBytes) ? Number(evidence.mediaBytes) : null;
      shots.push({
        id: shot.id, kind: 'presenter', videoId: String(evidence.videoId),
        requestId: evidence.requestId ?? null,
        durationSeconds,
        chargedCny: Number.isFinite(evidence.chargedCny) ? Number(evidence.chargedCny) : null,
        providerStatus: evidence.providerStatus ?? evidence.phase ?? null,
        phase: evidence.phase ?? null,
        mediaSha256: evidence.mediaSha256 ?? null,
        mediaBytes,
      });
      presenters.push({
        id: shot.id, script: String(evidence.speech || ''), requestId: String(evidence.requestId || ''),
        videoId: String(evidence.videoId), durationSeconds: Number(durationSeconds) || 0,
        mediaSha256: String(evidence.mediaSha256 || ''),
        ...(mediaBytes !== null ? {mediaBytes} : {}),
        avatarId: String(evidence.avatarId || ''), voiceId: String(evidence.voiceId || ''),
        publicEvidence: evidence.publicEvidence,
        ...(evidence.providerEvidenceRef ? {providerEvidenceRef: String(evidence.providerEvidenceRef)} : {}),
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
          providerStatus: state.providerStatus ?? state.phase ?? null,
          phase: state.phase ?? null,
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
        providerStatus: evidence.phase ?? null,
        phase: evidence.phase ?? null,
      });
      evidenceCount += 1;
    }
  }
  const presenterCount = shots.filter(shot => shot.kind === 'presenter').length;
  const illustrations = shots.filter(shot => shot.kind === 'illustration').length;
  if (presenterCount < 2 || illustrations < 2) fail('step5_provider_evidence_missing', 'two_presenter_two_illustration_required');

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
    provider: {
      source: evidenceCount === 0 ? 'local-step4-state' : (localCount === 0 ? 'committed-step4-evidence' : 'mixed'),
      shots, approvedCny, chargedCny, paidSubmissions,
      note: '供应商阶段复用 Step 4 已付费并落盘的镜头记录；Step 5 不重复提交、不再扣费。',
    },
    presenters,
  };
}

function manifestFileList(manifest: any, includePresenterVideos: boolean): string[] {
  const files: string[] = [];
  if (manifest?.voiceover?.url) files.push(String(manifest.voiceover.url));
  for (const item of Array.isArray(manifest?.timeline) ? manifest.timeline : []) {
    if (!includePresenterVideos && item?.type === 'video') continue;
    if (typeof item?.url === 'string' && !/^https?:/i.test(item.url)) files.push(item.url);
  }
  return files;
}

async function filesPresent(files: string[]): Promise<boolean> {
  for (const file of files) {
    if (!await exists(path.isAbsolute(file) ? file : path.resolve(file))) return false;
  }
  return true;
}

async function manifestInputsPresent(): Promise<boolean> {
  if (!await exists(STEP4_MANIFEST)) return false;
  const files = manifestFileList(await readJson(STEP4_MANIFEST), true);
  return files.length > 0 && filesPresent(files);
}

/** Non-presenter inputs must stay local in live mode; presenter files are
 * replaced by freshly downloaded, hash-verified media. */
async function liveManifestInputsPresent(manifest: any): Promise<boolean> {
  const files = manifestFileList(manifest, false);
  const presenters = Array.isArray(manifest?.timeline)
    ? manifest.timeline.filter((item: any) => item?.type === 'video' && typeof item.sceneId === 'string' && item.sceneId).length
    : 0;
  return presenters > 0 && files.length > 0 && filesPresent(files);
}

/** Pure manifest adoption: only presenter video URLs (matched by sceneId) are
 * replaced. Illustrations, subtitles and the voiceover remain untouched. */
export function adoptStep4Manifest(manifest: any, downloads: Record<string, string>): any {
  if (!manifest || !Array.isArray(manifest.timeline)) fail('step5_live_bridge_requires_step4_manifest', 'timeline');
  let replaced = 0;
  const timeline = manifest.timeline.map((item: any) => {
    if (item?.type === 'video' && typeof item.sceneId === 'string' && item.sceneId) {
      const local = downloads[item.sceneId];
      if (!local) fail('step5_provider_evidence_missing', item.sceneId);
      replaced += 1;
      return {...item, url: local};
    }
    return {...item};
  });
  if (!replaced) fail('step5_live_bridge_requires_step4_manifest', 'presenter_video');
  return {...manifest, timeline};
}

async function composeFinal(state: Step5State, live?: {providerFiles: Record<string, string>}):
  Promise<NonNullable<Step5State['composition']>> {
  await fs.mkdir(STEP5_OUTPUT_DIR, {recursive: true, mode: 0o700});
  let sourceFile: string;
  let mode: 'recomposed' | 'reused-verified-evidence';
  let manifestSha256: string | null = null;
  let adoptedManifestSha256: string | null = null;
  let providerMedia: NonNullable<Step5State['composition']>['providerMedia'];

  if (live) {
    if (!await exists(STEP4_MANIFEST)) fail('step5_live_bridge_requires_step4_manifest', 'manifest');
    const original = await readJson(STEP4_MANIFEST);
    if (!await liveManifestInputsPresent(original)) fail('step5_live_bridge_requires_step4_manifest', 'assets');
    const manifest = adoptStep4Manifest(original, live.providerFiles);
    if (!await filesPresent(manifestFileList(manifest, true))) fail('step5_live_bridge_requires_step4_manifest', 'adopted_files');
    manifestSha256 = sha(JSON.stringify(manifest));
    adoptedManifestSha256 = manifestSha256;
    providerMedia = 'live-adopted';
    const rendered = await composite(manifest, () => undefined, STEP5_OUTPUT_DIR);
    if (!rendered.ok || !rendered.outputPath) fail('step5_render_failed', rendered.error || 'unknown');
    sourceFile = rendered.outputPath;
    mode = 'recomposed';
  } else if (await manifestInputsPresent()) {
    const manifest = await readJson(STEP4_MANIFEST);
    const manifestText = JSON.stringify(manifest);
    manifestSha256 = sha(manifestText);
    const rendered = await composite(manifest, () => undefined, STEP5_OUTPUT_DIR);
    if (!rendered.ok || !rendered.outputPath) fail('step5_render_failed', rendered.error || 'unknown');
    sourceFile = rendered.outputPath;
    mode = 'recomposed';
    providerMedia = 'step4-local';
  } else {
    if (!await exists(EVIDENCE_FINAL_MP4)) fail('step5_media_missing', 'step4-final');
    const record = await readJson(EVIDENCE_FINAL_JSON);
    const bytes = await fs.readFile(EVIDENCE_FINAL_MP4);
    if (record?.final?.sha256 && sha(bytes) !== record.final.sha256) fail('step5_media_hash_mismatch', 'step4-final');
    sourceFile = EVIDENCE_FINAL_MP4;
    mode = 'reused-verified-evidence';
    providerMedia = 'committed-evidence';
  }

  const bytes = await fs.readFile(sourceFile);
  const finalSha = sha(bytes);
  const stableFile = path.join(STATE_DIR, 'final.mp4');
  await fs.writeFile(stableFile, bytes, {mode: 0o600});
  const probe = await probeFinal(stableFile);
  const errors = validateFinalProbe(probe);
  if (errors.length) fail('step5_final_probe_failed', errors.join(','));
  return {mode, providerMedia, file: stableFile, bytes: bytes.length, sha256: finalSha, probe,
    manifestSha256, adoptedManifestSha256};
}

async function buildGeneratedVoiceover(plan: ReturnType<typeof buildStep4Plan>, outFile: string):
  Promise<{sha256: string; bytes: number}> {
  const narration = plan.shots.filter(shot => shot.kind === 'illustration' && shot.narrationFile);
  if (!narration.length) fail('step5_generation_voiceover_failed', 'no_narration');
  const args = ['-y', '-hide_banner', '-nostdin'];
  for (const shot of narration) args.push('-i', shot.narrationFile!);
  const filters = narration.map((shot, index) => {
    const delay = Math.round(shot.startSeconds * 1000);
    return `[${index}:a]aformat=sample_rates=44100:channel_layouts=stereo,adelay=${delay}|${delay}[n${index}]`;
  });
  filters.push(`${narration.map((_, index) => `[n${index}]`).join('')}amix=inputs=${narration.length}:duration=longest:normalize=0,apad,atrim=duration=${plan.totalDurationSeconds.toFixed(3)},asetpts=PTS-STARTPTS[aout]`);
  args.push('-filter_complex', filters.join(';'), '-map', '[aout]',
    '-t', plan.totalDurationSeconds.toFixed(3), '-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '2', outFile);
  try {
    await execFileAsync(ffmpegStatic as string, args, {
      encoding: 'utf8', timeout: 600_000, maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    fail('step5_generation_voiceover_failed', String((error as {stderr?: string}).stderr || '').slice(-400));
  }
  const bytes = await fs.readFile(outFile);
  if (bytes.length < 10_000) fail('step5_generation_voiceover_failed', 'too_small');
  return {sha256: sha(bytes), bytes: bytes.length};
}

/** Builds the same plan/manifest contract as Step 4, but from freshly
 * generated media, then calls the original compositor. */
async function composeGeneratedFinal(
  state: Step5State,
  storyboard: NonNullable<Awaited<ReturnType<typeof readStoryboardFile>>['storyboard']>,
  generated: Step5GenerationResult,
): Promise<NonNullable<Step5State['composition']>> {
  await fs.mkdir(STEP5_OUTPUT_DIR, {recursive: true, mode: 0o700});
  let plan: ReturnType<typeof buildStep4Plan>;
  try {
    plan = buildStep4Plan({
      storyboard,
      presenterFiles: generated.media.presenters,
      narrationFiles: generated.media.narration,
    });
  } catch (error) {
    fail('step5_generation_plan_failed', error instanceof Error ? error.message : String(error));
  }
  const planErrors = validateStep4Plan(plan);
  if (planErrors.length) fail('step5_generation_plan_failed', planErrors.join(','));

  const voiceoverFile = path.join(STEP5_OUTPUT_DIR, 'voiceover.wav');
  await buildGeneratedVoiceover(plan, voiceoverFile);
  const manifest = buildStep4RenderManifest({
    plan, jobId: `step5-${state.idempotencyKey.slice(0, 12)}`,
  }) as any;
  manifest.voiceover = {url: voiceoverFile};
  const manifestText = JSON.stringify(manifest, null, 2);
  const manifestFile = path.join(STEP5_OUTPUT_DIR, 'manifest.json');
  await fs.writeFile(manifestFile, manifestText, {mode: 0o600});
  const manifestSha256 = sha(manifestText);
  if (!await filesPresent(manifestFileList(manifest, true)))
    fail('step5_generation_plan_failed', 'generated_inputs_missing');

  const rendered = await composite(manifest, () => undefined, STEP5_OUTPUT_DIR);
  if (!rendered.ok || !rendered.outputPath) fail('step5_render_failed', rendered.error || 'unknown');
  const bytes = await fs.readFile(rendered.outputPath);
  const finalSha = sha(bytes);
  const stableFile = path.join(STATE_DIR, 'final.mp4');
  await fs.writeFile(stableFile, bytes, {mode: 0o600});
  const probe = await probeFinal(stableFile);
  const errors = validateFinalProbe(probe);
  if (errors.length) fail('step5_final_probe_failed', errors.join(','));
  return {
    mode: 'recomposed', providerMedia: 'live-generated', file: stableFile,
    bytes: bytes.length, sha256: finalSha, probe,
    manifestSha256, adoptedManifestSha256: null,
  };
}

function providerFromGeneration(
  state: Step5State, result: Step5GenerationResult,
): NonNullable<Step5State['provider']> {
  const shots: NonNullable<Step5State['provider']>['shots'] = result.shots.map(shot => ({
    id: shot.shotId,
    kind: shot.kind,
    videoId: shot.kind === 'presenter' ? shot.providerTaskId : null,
    requestId: shot.requestId,
    durationSeconds: shot.durationSeconds,
    chargedCny: shot.chargedCny,
    providerStatus: shot.providerStatus,
    phase: shot.phase,
    mediaSha256: shot.mediaSha256,
    mediaBytes: shot.mediaBytes,
  }));
  const generation: Step5GenerationSummary = {
    capCny: result.prepared.capCny,
    approvedCny: result.budget.approvedCny,
    budgetChargedCny: result.budget.chargedCny,
    budgetReservedCny: result.budget.reservedCny,
    budgetRemainingCny: result.budget.remainingCny,
    newPaidSubmissions: result.counters.newPaidSubmissions,
    newChargedCny: result.counters.newChargedCny,
    reusedShots: result.counters.reusedShots,
    presentersGenerated: result.counters.presentersGenerated,
    narrationGenerated: result.counters.narrationGenerated,
    reconciledShots: result.counters.reconciledShots,
    narrationEngine: result.prepared.narrationEngine,
    preflightCheckedAt: result.prepared.preflight.checkedAt,
    accountRef: result.prepared.accountRef,
    shots: result.shots.map(shot => ({
      shotId: shot.shotId, kind: shot.kind, phase: shot.phase,
      requestId: shot.requestId, title: shot.title,
      providerTaskId: shot.providerTaskId, providerStatus: shot.providerStatus,
      durationSeconds: shot.durationSeconds, chargedCny: shot.chargedCny,
      reusedFrom: shot.reusedFrom,
      reconciliation: shot.reconciliation ? {...shot.reconciliation} as Record<string, unknown> : null,
    })),
  };
  return {
    source: 'live-generated', shots,
    approvedCny: result.budget.approvedCny,
    chargedCny: result.counters.newChargedCny,
    paidSubmissions: result.budget.paidSubmissions,
    note: '本次由页面确认后真实提交；未变化镜头复用既有媒体，失败/未知均不重复付费提交。',
    live: {
      mode: 'generation',
      newPaidSubmissions: result.counters.newPaidSubmissions,
      newChargedCny: result.counters.newChargedCny,
      statusCalls: result.counters.statusCalls,
      downloads: result.counters.downloads,
      uploads: 0,
      presentersAdopted: 0,
      accountRef: result.prepared.accountRef,
      presenterAssetId: result.prepared.presenterAssetId,
    },
    generation,
  };
}

async function findCompletedArtifact(key: string): Promise<any | null> {
  return local(async () => {
    const rows = await store.list<any>('starter_social_content_artifacts', {perPage: 1000});
    return rows.items.find(row => row.tenant_id === TENANT_ID
      && row.content?.step5IdempotencyKey === key
      && ['review_required', 'approved'].includes(String(row.status))) ?? null;
  });
}

/**
 * A generation run needs the durable job to execute again even after an earlier
 * attempt settled it. Reusing the same job (instead of admitting a new task)
 * keeps the write-back authority and allows a new artifact revision. Running
 * jobs are left untouched so the normal abandoned-worker recovery decides.
 */
async function prepareGenerationJobForRun(): Promise<void> {
  const job = await readContentExecutionJob(store, TENANT_ID, CONTENT_TASK_ID, RUN_ID);
  if (!job) fail('step5_job_terminal_error', 'job_missing');
  if (job.status === 'running') return;
  const patch: Record<string, unknown> = {
    status: 'queued', attempt: 0, reconciliation_attempt: 0, retry_class: '',
    next_attempt_at: '', worker_id: '', lease_expires_at: '', last_error: '',
    completed_at: '', provider_state: '',
  };
  // A settled job's completed receipts belong to the previous artifact. New
  // generation identity must start from a clean attribution list.
  if (job.status === 'succeeded') patch.provider_receipts = [];
  await store.update('content_execution_jobs', job.id, {...patch, updated_at: now()});
}

/** Lets an already-succeeded weekly consumer settle the newly generated
 * artifact. Both the row status and payload status must be reset together. */
async function resetWeeklyTaskForNewArtifact(): Promise<void> {
  const {getWeeklyExecutionTaskRow, writeWeeklyExecutionTask, withWeeklyExecutionTaskMutation} = await import(
    '../server/socialPrograms/executionTasks.js'
  );
  let row;
  try { row = await getWeeklyExecutionTaskRow(store, TENANT_ID, 'video'); }
  catch { return; }
  if (!row || row.payload?.status !== 'succeeded') return;
  await withWeeklyExecutionTaskMutation(store, TENANT_ID, 'video', async () => {
    const latest = await getWeeklyExecutionTaskRow(store, TENANT_ID, 'video');
    if (!latest || latest.payload.status !== 'succeeded') return;
    const next = {
      ...latest.payload,
      status: 'queued' as const,
      lease: null,
      nextAttemptAt: null,
      resultRefs: null as any,
      productionProgress: null,
      lastError: null as any,
      ownBlockingReasons: [] as string[],
      updatedAt: now(),
    };
    await writeWeeklyExecutionTask(store, latest, next as any);
  }, 'settlement');
}

async function writeBack(state: Step5State, live?: {run: () => Promise<void>; generation?: boolean}):
  Promise<NonNullable<Step5State['writeBack']>> {
  let session: PinnedIdentity['session'];
  try { session = await readJson(SESSION_FILE); }
  catch { fail('step5_seed_required'); }

  return local(async () => {
    let job = await readContentExecutionJob(store, TENANT_ID, CONTENT_TASK_ID, RUN_ID);
    if (!job) fail('step5_job_terminal_error', 'job_missing');
    if (live?.generation) {
      await prepareGenerationJobForRun();
      job = await readContentExecutionJob(store, TENANT_ID, CONTENT_TASK_ID, RUN_ID);
    } else if (live && job.status === 'succeeded') {
      fail('step5_job_terminal_error', 'live_job_already_settled');
    }
    if (!job) fail('step5_job_terminal_error', 'job_missing');

    if (job.status !== 'succeeded') {
      const worker = new DurableContentExecutionWorker({
        dataStore: store, dataAuthority: 'local', allowedJobIds: [session.jobId], now: FIXED_NOW,
        execute: async claimed => {
          // Adoption + composition must run inside this callback so provider
          // receipts are written under the durable execution context.
          if (live) await live.run();
          const composition = state.composition;
          if (!composition) fail('step5_media_missing');
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
        if (job && ['succeeded', 'failed', 'blocked', 'dead_letter', 'retry_wait', 'reconciling'].includes(job.status)) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      worker.stop();
      if (!job || job.status !== 'succeeded') {
        if (live?.generation) {
          // Surface an unknown paid submission as its own terminal phase. A
          // plain reconciling state is retryable and must not look like one.
          const summary = await readStep5GenerationSummary();
          if (summary?.unknownShots.length)
            fail('step5_submission_unknown', summary.unknownShots.join(','));
          if (job?.status === 'reconciling') fail('step5_provider_pending', 'reconciling');
        }
        fail('step5_job_terminal_error', job?.status ?? 'timeout');
      }
    }

    const composition = state.composition;
    if (!composition) fail('step5_media_missing');
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

    if (live?.generation) await resetWeeklyTaskForNewArtifact();

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

/**
 * Paid generation path. The model is prepared (identity, cap, wallet,
 * preflight, public presenter) before this function is called; every actual
 * provider submission runs inside the durable job callback so receipts are
 * attributable and a crash can never lose the write-ahead record.
 */
async function runGeneratedPipeline(
  state: Step5State,
  story: Awaited<ReturnType<typeof readStoryboardFile>>,
  prepared: PreparedStep5Generation,
): Promise<void> {
  const storyboard = story.storyboard;
  if (!storyboard) fail('step5_generation_storyboard_empty');
  state.mode = 'generate';
  state.provider = {
    source: 'live-generated',
    shots: storyboard.shots.map(shot => ({
      id: shot.id, kind: shot.kind, videoId: null, requestId: null,
      durationSeconds: null, chargedCny: null, providerStatus: null, phase: 'prepared',
    })),
    approvedCny: prepared.capCny,
    chargedCny: null,
    paidSubmissions: null,
    note: `页面已确认 ${prepared.capCny} CNY 上限；逐镜提交，结果未知时只对账、不重提。`,
    live: {
      mode: 'generation', newPaidSubmissions: 0, newChargedCny: 0,
      statusCalls: 0, downloads: 0, uploads: 0, presentersAdopted: 0,
      accountRef: prepared.accountRef, presenterAssetId: prepared.presenterAssetId,
    },
  };
  await persist(state);
  await finishPhase(state, 'submitting',
    `已确认 ${prepared.capCny} CNY 上限、公开形象、预算身份与只读预检；开始逐镜真实生成`,
    'live-generated');

  state.writeBack = await writeBack(state, {
    generation: true,
    run: async () => {
      const result = await runStep5Generation({
        store, storyboard,
        storyboardSha256: story.sha256 ?? state.storyboardSha256,
        confirmedCapCny: prepared.capCny,
        prepared,
        recordReceipt: async receipt => {
          await recordCurrentContentProviderReceipt({provider: 'heygen', ...receipt});
        },
        onEvent: async event => {
          const shot = state.provider?.shots.find(item => item.id === event.shotId);
          if (shot) {
            shot.phase = event.phase;
            if (event.providerTaskId) {
              if (shot.kind === 'presenter') shot.videoId = event.providerTaskId;
              else shot.requestId = event.providerTaskId;
            }
          }
          await persist(state);
        },
      });
      state.provider = providerFromGeneration(state, result);
      await persist(state);

      const presenters = result.shots.filter(item => item.kind === 'presenter');
      const narration = result.shots.filter(item => item.kind === 'illustration');
      await finishPhase(state, 'accepted',
        `${presenters.length} 段人物视频、${narration.length} 段旁白已受理；`
        + `新增付费提交 ${result.counters.newPaidSubmissions} 次、${result.counters.newChargedCny.toFixed(2)} CNY`,
        'live-generated');

      await beginPhase(state, 'generating');
      await finishPhase(state, 'generating',
        `供应商任务均已到 downloaded；状态查询 ${result.counters.statusCalls} 次，对账 ${result.counters.reconciledShots} 镜`,
        'live-generated');

      await beginPhase(state, 'downloading');
      await finishPhase(state, 'downloading',
        `已下载 ${result.counters.downloads} 个媒体并校验哈希与时长；复用 ${result.counters.reusedShots} 镜`,
        'live-generated');

      await beginPhase(state, 'compositing');
      state.composition = await composeGeneratedFinal(state, storyboard, result);
      await finishPhase(state, 'compositing',
        `用本次生成/复用媒体自动合成：${state.composition.probe.durationSeconds.toFixed(2)}s，`
        + `${state.composition.probe.width}×${state.composition.probe.height}，`
        + `${state.composition.probe.videoCodec}/${state.composition.probe.audioCodec}`,
        'live-generated');

      const receipts = currentContentProviderReceipts();
      for (const shot of result.shots) {
        const receipt = receipts.find(item => item.provider === 'heygen' && item.requestId === shot.requestId);
        if (!receipt || receipt.state !== 'completed')
          fail('step5_provider_receipt_incomplete', shot.shotId);
      }
      const summary = await readStep5GenerationSummary();
      if (summary?.unknownShots.length)
        fail('step5_submission_unknown', summary.unknownShots.join(','));
      await beginPhase(state, 'writing_back');
    },
  });

  await finishPhase(state, 'writing_back',
    `产物 ${state.writeBack.artifactId} 已登记；周任务结算 ${state.settlement?.status ?? 'unknown'}`,
    'original-content-commands');

  await beginPhase(state, 'review_required');
  await finishPhase(state, 'review_required', 'technicalReview=false、creativeReview=false，等待人工审核');
  state.phase = 'review_required';
  state.completedAt = now();
  await persist(state);
}

async function runPipeline(
  state: Step5State, owner: string,
  options: {mode: Step5Mode; prepared?: PreparedStep5Generation},
): Promise<void> {
  const timer = setInterval(() => {
    void heartbeat(owner).catch(() => undefined);
  }, Math.floor(LEASE_MS / 3));
  timer.unref?.();
  try {
    await beginPhase(state, 'submitting');
    const story = await readStoryboardFile(STORYBOARD_FILE, {checkLocalFiles: true});

    if (options.mode === 'generate') {
      if (!options.prepared) fail('step5_generation_not_prepared');
      await runGeneratedPipeline(state, story, options.prepared);
      return;
    }

    const collected = await collectProviderEvidence(story);
    state.provider = collected.provider;

    let liveBridge: Step5LiveAdoption | null = null;
    if (isStep5LiveBridgeEnabled()) {
      if (!await exists(STEP4_MANIFEST)) fail('step5_live_bridge_requires_step4_manifest', 'manifest');
      if (!await liveManifestInputsPresent(await readJson(STEP4_MANIFEST)))
        fail('step5_live_bridge_requires_step4_manifest', 'assets');
      state.provider.source = 'live-bridge';
      state.provider.note = '通过原 bridge 在线查询并重新下载 Step 4 已受理的 video_id；本次新增付费提交 0 次、0 CNY，钱包不变。';
      const bridge = await prepareStep5LiveAdoption({
        store,
        sources: collected.presenters,
        avatarId: state.avatarId,
        voiceId: state.voiceId,
        outputDirectory: STEP5_ADOPTED_DIR,
        onEvent: async (shotId, event) => {
          const shot = state.provider?.shots.find(item => item.id === shotId);
          if (shot) {
            shot.phase = event.state;
            if (event.providerStatus) shot.providerStatus = event.providerStatus;
            if (event.durationSeconds) shot.durationSeconds = event.durationSeconds;
            if (event.contentHash) shot.mediaSha256 = event.contentHash;
            if (event.bytes) shot.mediaBytes = event.bytes;
            if (event.state === 'completed') shot.providerStatus = 'completed';
          }
          const live = state.provider?.live;
          if (live) {
            live.statusCalls = bridge.counters.statusCalls;
            live.downloads = bridge.counters.downloads;
            live.uploads = bridge.counters.uploads;
            live.presentersAdopted = bridge.counters.presentersAdopted;
          }
          await persist(state);
        },
      });
      liveBridge = bridge;
      state.provider.live = {
        newPaidSubmissions: 0, newChargedCny: 0,
        statusCalls: 0, downloads: 0, uploads: 0, presentersAdopted: 0,
        accountRef: bridge.accountRef, presenterAssetId: bridge.presenter.presenterAssetId,
      };
    }
    await finishPhase(state, 'submitting',
      liveBridge
        ? '已通过原 bridge 准备在线查询 Step 4 已受理任务；不会创建新的付费提交'
        : '已确认 Step 4 的供应商请求记录，未重新提交',
      state.provider.source);

    if (!liveBridge) {
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
    } else {
      const bridge = liveBridge;
      const downloaded: Record<string, string> = {};
      state.writeBack = await writeBack(state, {
        run: async () => {
          await beginPhase(state, 'accepted');
          for (const source of collected.presenters) {
            const result = await bridge.adopt(source);
            if (!result.localPath) fail('step5_media_missing', source.id);
            downloaded[source.id] = result.localPath;
          }
          const accepted = state.provider!.shots.every(shot => shot.kind !== 'presenter' || Boolean(shot.videoId));
          if (!accepted) fail('step5_provider_receipt_incomplete', 'presenter_video_id_missing');
          state.provider!.live = {
            newPaidSubmissions: 0, newChargedCny: 0,
            statusCalls: bridge.counters.statusCalls, downloads: bridge.counters.downloads,
            uploads: bridge.counters.uploads, presentersAdopted: bridge.counters.presentersAdopted,
            accountRef: bridge.accountRef, presenterAssetId: bridge.presenter.presenterAssetId,
          };
          await persist(state);
          await finishPhase(state, 'accepted',
            '3 段人物 video_id 已通过原 bridge 接管；没有创建新的付费任务', 'live-bridge');

          await beginPhase(state, 'generating');
          await finishPhase(state, 'generating', '供应商状态均为 completed，时长与 Step 4 记录一致（容差 0.2s）', 'live-bridge');

          await beginPhase(state, 'downloading');
          await finishPhase(state, 'downloading',
            `已重新下载 3 段人物媒体并校验 SHA-256，上传 ${bridge.counters.uploads} 次；旁白/说明图使用本地 Step 4 输入`,
            'live-bridge');

          await beginPhase(state, 'compositing');
          state.composition = await composeFinal(state, {providerFiles: downloaded});
          await finishPhase(state, 'compositing',
            `用新下载媒体替换 3 个人物时间轴后重新自动合成：${state.composition.probe.durationSeconds.toFixed(2)}s，`
            + `${state.composition.probe.width}×${state.composition.probe.height}，${state.composition.probe.videoCodec}/${state.composition.probe.audioCodec}`,
            'live-adopted');

          const receipts = currentContentProviderReceipts();
          for (const source of collected.presenters) {
            const receipt = receipts.find(item => item.provider === 'heygen' && item.requestId === source.requestId);
            if (!receipt || receipt.state !== 'completed' || receipt.providerTaskId !== source.videoId)
              fail('step5_provider_receipt_incomplete', source.id);
          }
          await beginPhase(state, 'writing_back');
        },
      });
    }

    await finishPhase(state, 'writing_back',
      `产物 ${state.writeBack.artifactId} 已登记；周任务结算 ${state.settlement?.status ?? 'unknown'}`,
      'original-content-commands');

    await beginPhase(state, 'review_required');
    await finishPhase(state, 'review_required', 'technicalReview=false、creativeReview=false，等待人工审核');
    state.phase = 'review_required';
    state.completedAt = now();
    await persist(state);
  } catch (error) {
    const active = STEP5_PHASES.find(name => state.stages[name].status === 'active');
    const code = step5ErrorCode(error);
    state.error = {code, message: describeError(error), phase: active ?? state.phase, at: now()};
    if (active) state.stages[active].status = 'failed';
    // A lost submission is not a failure that may be retried blindly; keep it
    // as its own terminal phase so the page offers reconciliation instead.
    state.phase = code === 'step5_submission_unknown' ? 'submission_unknown' : 'failed';
    await persist(state);
    console.error('[step5] pipeline failed', code, describeError(error).slice(0, 500));
  } finally {
    clearInterval(timer);
    await releaseLease(owner);
  }
}

export interface StartResult {
  status: 'started' | 'already_running' | 'already_complete' | 'recovered';
  pipeline: PublicStep5State | null;
}

export interface StartOptions {
  mode?: Step5Mode;
  confirmedCapCny?: number;
}

const ACTIVE_PHASES: string[] = [
  'prepared', 'submitting', 'accepted', 'generating', 'downloading', 'compositing', 'writing_back',
];

export async function startPipeline(options: StartOptions = {}): Promise<StartResult> {
  await fs.mkdir(STATE_DIR, {recursive: true, mode: 0o700});
  const mode: Step5Mode = options.mode === 'generate' ? 'generate' : 'reuse';
  const pinned = await readPinnedIdentity();
  const idempotencyKey = buildIdempotencyKey({
    taskId: pinned.session.taskId, runId: pinned.session.runId,
    storyboardSha256: pinned.storyboardSha256, avatarId: pinned.avatarId, voiceId: pinned.voiceId,
    mode,
  });

  let state = await readPipelineState();
  if (state && state.idempotencyKey !== idempotencyKey) {
    const sameIdentity = state.storyboardSha256 === pinned.storyboardSha256
      && state.avatarId === pinned.avatarId && state.voiceId === pinned.voiceId;
    // Only a mode switch may replace history. A changed storyboard or presenter
    // identity still requires a deliberate re-seed.
    if (!sameIdentity) fail('step5_storyboard_or_identity_changed');
    if (ACTIVE_PHASES.includes(state.phase) && await leaseLive())
      return {status: 'already_running', pipeline: toPublicState(state)};
    await fs.copyFile(STATE_FILE, path.join(
      STATE_DIR, `state-${state.idempotencyKey.slice(0, 16)}.json`,
    )).catch(() => undefined);
    state = null;
  }

  if (state?.phase === 'review_required') {
    // Seed/reset removes the business store but not this state directory. Do
    // not claim completion when the referenced artifact no longer exists.
    if (await findCompletedArtifact(idempotencyKey)) {
      return {status: 'already_complete', pipeline: toPublicState(state)};
    }
    state = null;
  }

  if (state && ACTIVE_PHASES.includes(state.phase)) {
    if (await leaseLive()) return {status: 'already_running', pipeline: toPublicState(state)};
  }

  const existing = await findCompletedArtifact(idempotencyKey);
  if (existing) {
    state = state ?? {
      schemaVersion: 1, idempotencyKey, mode, phase: 'review_required',
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

  // Paid generation is prepared before the lease: the readiness checks are
  // read-only and a failed precondition must never leave a running pipeline.
  let prepared: PreparedStep5Generation | undefined;
  if (mode === 'generate') {
    if (typeof options.confirmedCapCny !== 'number' || !Number.isFinite(options.confirmedCapCny))
      fail('step5_generation_cap_not_confirmed');
    const story = await readStoryboardFile(STORYBOARD_FILE, {checkLocalFiles: true});
    if (!story.storyboard) fail('step5_generation_storyboard_empty');
    prepared = await local(() => prepareStep5Generation({
      store, storyboard: story.storyboard!, confirmedCapCny: options.confirmedCapCny!,
    }));
  }

  const owner = `${process.pid}-${randomUUID()}`;
  if (!await acquireLease(owner)) return {status: 'already_running', pipeline: toPublicState(state)};
  try {
    if (!state) {
      state = {
        schemaVersion: 1, idempotencyKey, mode, phase: 'prepared',
        taskId: pinned.session.taskId, contentTaskId: CONTENT_TASK_ID, runId: pinned.session.runId,
        jobId: pinned.session.jobId, weeklyTaskId: 'video',
        storyboardSha256: pinned.storyboardSha256, avatarId: pinned.avatarId, voiceId: pinned.voiceId,
        startedAt: now(), updatedAt: now(), stages: blankStages(),
      };
    } else {
      state.mode = mode;
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
    void runPipeline(state, owner, {mode, ...(prepared ? {prepared} : {})});
    return {status: 'started', pipeline: toPublicState(state)};
  } catch (error) {
    await releaseLease(owner);
    throw error;
  }
}

