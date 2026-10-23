import {weeklyExecutionObservation} from './weeklyExecutionObservation.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { getPbUrl, pbListStrict } from '../storage/pb.js';
import { processRoleStartsBackgroundJobs, type ProcessRole } from './processRole.js';
import {
  assertSocialOperatingCollections,
  inspectSocialOperatingSignals,
  type SocialOperatingSignals,
} from './socialOperatingObservability.js';
import type { BackgroundJobRuntimeState } from './workerHeartbeat.js';
import { checkPostgres, selectedDataBackend } from '../storage/postgres.js';
import { checkBullMq, selectedQueueBackend } from '../queues/bullmq.js';
import { store } from '../storage/index.js';
import { runtimeBuildInfo } from './buildInfo.js';

export type RuntimeCapability =
  | 'text_generation'
  | 'qwen_generation'
  | 'tts'
  | 'video_generation'
  | 'digital_human'
  | 'digital_human_quality'
  | 'digital_human_auto_release'
  | 'material_cleanup'
  | 'starter_workers'
  | 'scheduled_publishing'
  | 'quote'
  | 'platform_ads';

export interface CapabilityState {
  ready: boolean;
  reason?: string;
}

/**
 * Prerequisites for the local, per-sentence replication worker. This is kept
 * deliberately configuration-only: it never validates a credential with a
 * provider and never returns a configured value.
 */
export interface SentenceReplicationReadiness {
  ready: boolean;
  missing: string[];
  reason?: string;
}

const KNOWN_CAPABILITIES: RuntimeCapability[] = [
  'text_generation',
  'qwen_generation',
  'tts',
  'video_generation',
  'digital_human',
  'digital_human_quality',
  'digital_human_auto_release',
  'material_cleanup',
  'starter_workers',
  'scheduled_publishing',
  'quote',
  'platform_ads',
];

const enabled = (name: string) => process.env[name] === 'true';
const present = (name: string) => Boolean(String(process.env[name] || '').trim());

const envEnabled = (env: NodeJS.ProcessEnv, name: string) => String(env[name] || '').trim().toLowerCase() === 'true';
const envPresent = (env: NodeJS.ProcessEnv, name: string) => Boolean(String(env[name] || '').trim());
/** Match the provider's environment/key-file fallback without exposing its value. */
function dashscopeCredentialConfigured(env: NodeJS.ProcessEnv): boolean {
  if (envPresent(env, 'DASHSCOPE_API_KEY')) return true;
  const file = String(env.DASHSCOPE_API_KEY_FILE || (env === process.env ? path.join(os.homedir(), '.config/lingshu/dashscope.key') : '')).trim();
  if (!file) return false;
  try { return fs.statSync(file).isFile() && Boolean(fs.readFileSync(file, 'utf8').trim()); }
  catch { return false; }
}
const positiveFinite = (env: NodeJS.ProcessEnv, name: string) => {
  const value = Number(String(env[name] || '').trim());
  return Number.isFinite(value) && value > 0;
};

export interface DigitalHumanProviderReadiness {
  heygen: CapabilityState;
  custom: CapabilityState;
  runwayActTwo: CapabilityState;
  seedanceReference: CapabilityState;
}

/**
 * Configuration-only provider audit. It deliberately performs no network or
 * paid supplier call and never returns credential values.
 */
export function digitalHumanProviderReadiness(
  env: NodeJS.ProcessEnv = process.env,
): DigitalHumanProviderReadiness {
  const objectStorageReady = (envPresent(env, 'OBJECT_STORAGE_ENDPOINT') || envPresent(env, 'R2_ACCOUNT_ID') || envPresent(env, 'COS_ENDPOINT') || envPresent(env, 'COS_REGION'))
    && (envPresent(env, 'OBJECT_STORAGE_ACCESS_KEY_ID') || envPresent(env, 'R2_ACCESS_KEY_ID') || envPresent(env, 'COS_SECRET_ID'))
    && (envPresent(env, 'OBJECT_STORAGE_SECRET_ACCESS_KEY') || envPresent(env, 'R2_SECRET_ACCESS_KEY') || envPresent(env, 'COS_SECRET_KEY'))
    && (envPresent(env, 'OBJECT_STORAGE_BUCKET_NAME') || envPresent(env, 'R2_BUCKET_NAME') || envPresent(env, 'COS_BUCKET'));
  const state = (missing: string[]): CapabilityState => ({
    ready: missing.length === 0,
    ...(missing.length ? { reason: `missing:${missing.join(',')}` } : {}),
  });
  return {
    heygen: state([
      ...(!envEnabled(env, 'HEYGEN_GENERATION_ENABLED') ? ['HEYGEN_GENERATION_ENABLED=true'] : []),
      ...(!envPresent(env, 'HEYGEN_API_KEY') ? ['HEYGEN_API_KEY'] : []),
    ]),
    custom: state([
      ...(!envPresent(env, 'DIGITAL_HUMAN_API_URL') ? ['DIGITAL_HUMAN_API_URL'] : []),
      ...(!envPresent(env, 'DIGITAL_HUMAN_API_KEY') ? ['DIGITAL_HUMAN_API_KEY'] : []),
    ]),
    runwayActTwo: state([
      ...(!envEnabled(env, 'RUNWAY_ACT_TWO_ENABLED') ? ['RUNWAY_ACT_TWO_ENABLED=true'] : []),
      ...(!envPresent(env, 'RUNWAYML_API_SECRET') ? ['RUNWAYML_API_SECRET'] : []),
      ...(!objectStorageReady ? ['object_storage'] : []),
      ...(!positiveFinite(env, 'RUNWAY_ACT_TWO_CNY_PER_CREDIT') ? ['RUNWAY_ACT_TWO_CNY_PER_CREDIT'] : []),
      ...(!positiveFinite(env, 'RUNWAY_ACT_TWO_ESTIMATED_CNY_PER_SECOND') ? ['RUNWAY_ACT_TWO_ESTIMATED_CNY_PER_SECOND'] : []),
      ...(!positiveFinite(env, 'DIGITAL_HUMAN_REFERENCE_MAX_CNY_PER_SHOT') ? ['DIGITAL_HUMAN_REFERENCE_MAX_CNY_PER_SHOT'] : []),
      ...(!positiveFinite(env, 'DIGITAL_HUMAN_REFERENCE_MONTHLY_BUDGET_CNY') ? ['DIGITAL_HUMAN_REFERENCE_MONTHLY_BUDGET_CNY'] : []),
    ]),
    seedanceReference: state([
      ...(!envEnabled(env, 'SEEDANCE_REFERENCE_ENABLED') ? ['SEEDANCE_REFERENCE_ENABLED=true'] : []),
      ...(!envPresent(env, 'SEEDANCE_API_KEY') ? ['SEEDANCE_API_KEY'] : []),
      ...(!envPresent(env, 'SEEDANCE_MODEL') ? ['SEEDANCE_MODEL'] : []),
      ...(!objectStorageReady ? ['object_storage'] : []),
      ...(!positiveFinite(env, 'SEEDANCE_REFERENCE_ESTIMATED_CNY_PER_SECOND') ? ['SEEDANCE_REFERENCE_ESTIMATED_CNY_PER_SECOND'] : []),
      ...(!positiveFinite(env, 'DIGITAL_HUMAN_REFERENCE_MAX_CNY_PER_SHOT') ? ['DIGITAL_HUMAN_REFERENCE_MAX_CNY_PER_SHOT'] : []),
      ...(!positiveFinite(env, 'DIGITAL_HUMAN_REFERENCE_MONTHLY_BUDGET_CNY') ? ['DIGITAL_HUMAN_REFERENCE_MONTHLY_BUDGET_CNY'] : []),
    ]),
  };
}

export function sentenceReplicationReadiness(env: NodeJS.ProcessEnv = process.env, videoProvider: 'seedance' | 'heygen' = 'seedance'): SentenceReplicationReadiness {
  const configured = (name: string) => Boolean(String(env[name] || '').trim());
  const switchedOn = (name: string) => String(env[name] || '').trim().toLowerCase() === 'true';
  const objectEndpoint = configured('OBJECT_STORAGE_ENDPOINT') || configured('R2_ACCOUNT_ID') || configured('COS_ENDPOINT') || configured('COS_REGION');
  const objectAccessKey = configured('OBJECT_STORAGE_ACCESS_KEY_ID') || configured('R2_ACCESS_KEY_ID') || configured('COS_SECRET_ID');
  const objectSecret = configured('OBJECT_STORAGE_SECRET_ACCESS_KEY') || configured('R2_SECRET_ACCESS_KEY') || configured('COS_SECRET_KEY');
  const objectBucket = configured('OBJECT_STORAGE_BUCKET_NAME') || configured('R2_BUCKET_NAME') || configured('COS_BUCKET');
  const storageDriver = String(env.OBJECT_STORAGE_DRIVER || (env.NODE_ENV === 'production' ? 'cos' : 'local')).trim().toLowerCase();
  const cloudStorage = storageDriver !== 'local';
  const missing = [
    videoProvider === 'heygen' && !switchedOn('HEYGEN_GENERATION_ENABLED') && 'HEYGEN_GENERATION_ENABLED=true',
    videoProvider === 'heygen' && !configured('HEYGEN_API_KEY') && 'HEYGEN_API_KEY',
    videoProvider === 'seedance' && !switchedOn('SEEDANCE_SENTENCE_ENABLED') && 'SEEDANCE_SENTENCE_ENABLED=true',
    videoProvider === 'seedance' && !configured('SEEDANCE_API_KEY') && 'SEEDANCE_API_KEY',
    videoProvider === 'seedance' && !configured('SEEDANCE_MODEL') && 'SEEDANCE_MODEL',
    !(configured('SEEDREAM_API_KEY') || configured('SEEDANCE_API_KEY')) && 'SEEDREAM_API_KEY 或 SEEDANCE_API_KEY（Seedream 目标人物首帧生成）',
    switchedOn('DIGITAL_HUMAN_SEMANTIC_QA_ENABLED') && !dashscopeCredentialConfigured(env) && 'DASHSCOPE_API_KEY 或 DASHSCOPE_API_KEY_FILE（独立语义质检）',
    switchedOn('DIGITAL_HUMAN_SEMANTIC_QA_ENABLED') && !configured('QWEN_DIGITAL_HUMAN_QA_MODEL') && 'QWEN_DIGITAL_HUMAN_QA_MODEL',
    cloudStorage && !objectEndpoint && '对象存储 endpoint/account',
    cloudStorage && !objectAccessKey && '对象存储 access key',
    cloudStorage && !objectSecret && '对象存储 secret key',
    cloudStorage && !objectBucket && '对象存储 bucket',
    videoProvider === 'seedance' && storageDriver === 'local' && !/^https:\/\//i.test(String(env.LOCAL_OBJECT_STORAGE_PUBLIC_BASE_URL || '').trim())
      && 'OBJECT_STORAGE_DRIVER=cos 或 LOCAL_OBJECT_STORAGE_PUBLIC_BASE_URL（公网 HTTPS）',
  ].filter(Boolean) as string[];
  return {
    ready: missing.length === 0,
    missing,
    ...(missing.length ? { reason: `逐句复刻尚不可执行，缺少：${missing.join('、')}` } : {}),
  };
}

export interface DigitalHumanQualityRuntimeReadiness {
  localVisual: CapabilityState;
  semantic: CapabilityState;
  lipSync: CapabilityState;
  autoRelease: CapabilityState;
}

function digitalHumanQualityConfig(env: NodeJS.ProcessEnv): DigitalHumanQualityRuntimeReadiness {
  const localVisual = envPresent(env, 'DIGITAL_HUMAN_VISUAL_QA_PYTHON')
    ? { ready: true }
    : { ready: false, reason: 'visual_qa_python_missing' };
  const semanticReady = envEnabled(env, 'DIGITAL_HUMAN_SEMANTIC_QA_ENABLED')
    && dashscopeCredentialConfigured(env)
    && envPresent(env, 'QWEN_DIGITAL_HUMAN_QA_MODEL');
  const semantic: CapabilityState = semanticReady ? { ready: true } : { ready: false, reason: 'semantic_qa_disabled_or_unconfigured' };
  const lipSyncReady = envEnabled(env, 'DIGITAL_HUMAN_SYNCNET_QA_ENABLED')
    && envPresent(env, 'DIGITAL_HUMAN_SYNCNET_QA_PYTHON') && envPresent(env, 'DIGITAL_HUMAN_SYNCNET_DIR');
  const lipSync: CapabilityState = lipSyncReady ? { ready: true } : { ready: false, reason: 'official_syncnet_disabled_or_unconfigured' };
  // SyncNet is an optional diagnostic. Automatic production/release is gated
  // by the independent visual and semantic checks; an absent local lip-sync
  // model must not force a human review or stop the video pipeline.
  const autoRelease: CapabilityState = localVisual.ready && semantic.ready
    ? { ready: true }
    : { ready: false, reason: 'automatic_release_requires_visual_and_semantic_qa' };
  return { localVisual, semantic, lipSync, autoRelease };
}

/**
 * Runtime self-check for independent QA. Local visual dependencies are
 * executed, while paid semantic credentials are configuration-audited only.
 * Every rendered cue must still produce its own evidence before release.
 */
export async function digitalHumanQualityRuntimeReadiness(
  env: NodeJS.ProcessEnv = process.env,
): Promise<DigitalHumanQualityRuntimeReadiness> {
  const report = digitalHumanQualityConfig(env);
  const python = String(env.DIGITAL_HUMAN_VISUAL_QA_PYTHON || '').trim();
  const script = path.resolve(process.cwd(), 'scripts/person_replacement_visual_qa.py');
  if (python) {
    if (!fs.existsSync(script)) report.localVisual = { ready: false, reason: 'visual_qa_script_missing' };
    else {
      try {
        const stdout = await new Promise<string>((resolve, reject) => execFile(python, [script, '--self-check'], {
          timeout: 20_000, maxBuffer: 1024 * 1024, encoding: 'utf8', env: { ...env, PYTHONNOUSERSITE: '1' },
        }, (error, output, stderr) => error ? reject(new Error(String(stderr || error.message))) : resolve(output)));
        const parsed = JSON.parse(stdout) as { ready?: boolean };
        report.localVisual = parsed.ready === true ? { ready: true } : { ready: false, reason: 'visual_qa_self_check_failed' };
      } catch (error) {
        report.localVisual = { ready: false, reason: `visual_qa_self_check_failed:${error instanceof Error ? error.message.slice(0, 160) : 'unknown'}` };
      }
    }
  }
  if (report.lipSync.ready) {
    const syncnetDir = String(env.DIGITAL_HUMAN_SYNCNET_DIR || '').trim();
    const required = [
      path.join(syncnetDir, 'data', 'syncnet_v2.model'),
      path.join(syncnetDir, 'detectors', 's3fd', 'weights', 'sfd_face.pth'),
      path.join(syncnetDir, 'run_pipeline.py'),
      path.join(syncnetDir, 'run_syncnet.py'),
      path.resolve(process.cwd(), 'scripts/validate-syncnet.py'),
    ];
    if (required.some(file => !fs.existsSync(file))) report.lipSync = { ready: false, reason: 'official_syncnet_model_or_runner_missing' };
  }
  report.autoRelease = report.localVisual.ready && report.semantic.ready
    ? { ready: true }
    : { ready: false, reason: 'automatic_release_requires_visual_and_semantic_qa' };
  return report;
}

export async function materialCleanupRuntimeReadiness(env: NodeJS.ProcessEnv = process.env): Promise<CapabilityState> {
  const python = String(env.MATERIAL_CLEANUP_PYTHON || '').trim();
  const configuredScript = String(env.MATERIAL_CLEANUP_SCRIPT || '').trim();
  if (!python || !configuredScript) return { ready: false, reason: 'material_cleanup_worker_unconfigured' };
  const script = path.resolve(configuredScript);
  if (!fs.existsSync(script)) return { ready: false, reason: 'material_cleanup_script_missing' };
  try {
    const stdout = await new Promise<string>((resolve, reject) => execFile(python, [script, '--self-check'], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
      env: { ...env, PYTHONNOUSERSITE: '1' },
    }, (error, output, stderr) => error ? reject(new Error(String(stderr || error.message))) : resolve(output)));
    const parsed = JSON.parse(stdout) as { ready?: boolean; toolchain?: { seedanceUsed?: boolean } };
    return parsed.ready === true && parsed.toolchain?.seedanceUsed === false
      ? { ready: true }
      : { ready: false, reason: 'material_cleanup_self_check_failed' };
  } catch (error) {
    return { ready: false, reason: `material_cleanup_self_check_failed:${error instanceof Error ? error.message.slice(0, 160) : 'unknown'}` };
  }
}

function textGenerationCapability(): CapabilityState {
  const backend = String(process.env.OVERSEAS_LLM_BACKEND || 'qwen').trim().toLowerCase();
  if (backend === 'gemini') {
    const ready = present('GEMINI_API_KEY');
    return { ready, reason: ready ? undefined : 'selected_text_model_key_missing:gemini' };
  }
  if (backend === 'qwen') {
    const ready = dashscopeCredentialConfigured(process.env);
    return { ready, reason: ready ? undefined : 'selected_text_model_key_missing:qwen' };
  }
  return { ready: false, reason: `unsupported_text_model_backend:${backend || 'empty'}` };
}

export function runtimeCapabilities(role: ProcessRole): Record<RuntimeCapability, CapabilityState> {
  const background = processRoleStartsBackgroundJobs(role);
  const textGeneration = textGenerationCapability();
  const qwenReady = dashscopeCredentialConfigured(process.env);
  // Qwen3-TTS uses the same DashScope credential as the verified Qwen
  // generation route. Do not report speech as unavailable merely because the
  // optional MiniMax/custom-voice provider is absent or quarantined.
  const ttsReady = qwenReady || present('MINIMAX_API_KEY') || present('PIPER_BIN') || present('XTTS_BIN');
  const videoReady = (enabled('SEEDANCE_VIDEO_ENABLED') && present('SEEDANCE_API_KEY'))
    || (enabled('GEMINI_VIDEO_ENABLED') && present('GEMINI_API_KEY'));
  const digitalHumanProviders = digitalHumanProviderReadiness();
  const digitalHumanReady = Object.values(digitalHumanProviders).some(provider => provider.ready);
  const quality = digitalHumanQualityConfig(process.env);
  const starterWorkersReady = background
    && enabled('STARTER_PUBLICATION_PACKAGE_WORKER_ENABLED')
    && enabled('STARTER_QUOTE_ARTIFACT_WORKER_ENABLED')
    && enabled('STARTER_198_ORCHESTRATOR_WORKER_ENABLED');

  return {
    text_generation: textGeneration,
    qwen_generation: { ready: qwenReady, reason: qwenReady ? undefined : 'dashscope_key_missing' },
    tts: { ready: ttsReady, reason: ttsReady ? undefined : 'no_tts_provider_configured' },
    video_generation: { ready: videoReady, reason: videoReady ? undefined : 'video_provider_disabled_or_unconfigured' },
    digital_human: { ready: digitalHumanReady, reason: digitalHumanReady ? undefined : 'digital_human_provider_disabled_or_unconfigured' },
    digital_human_quality: quality.localVisual,
    digital_human_auto_release: quality.autoRelease,
    material_cleanup: { ready: present('MATERIAL_CLEANUP_PYTHON') && present('MATERIAL_CLEANUP_SCRIPT'), reason: present('MATERIAL_CLEANUP_PYTHON') && present('MATERIAL_CLEANUP_SCRIPT') ? undefined : 'material_cleanup_worker_unconfigured' },
    starter_workers: { ready: starterWorkersReady, reason: starterWorkersReady ? undefined : background ? 'starter_workers_not_explicitly_enabled' : 'background_jobs_not_running_in_this_role' },
    scheduled_publishing: { ready: background && enabled('PUBLISH_SCHEDULER_ENABLED'), reason: background && enabled('PUBLISH_SCHEDULER_ENABLED') ? undefined : 'publishing_worker_not_enabled' },
    quote: { ready: process.env.NODE_ENV !== 'production' || enabled('QUOTE_SKILL_ENABLED'), reason: process.env.NODE_ENV !== 'production' || enabled('QUOTE_SKILL_ENABLED') ? undefined : 'quote_skill_not_enabled' },
    platform_ads: { ready: present('TENANT_PLATFORM_APP_KEY'), reason: present('TENANT_PLATFORM_APP_KEY') ? undefined : 'tenant_platform_encryption_key_missing' },
  };
}

export function requiredCapabilityIssues(capabilities: Record<RuntimeCapability, CapabilityState>): string[] {
  const configured = String(process.env.REQUIRED_CAPABILITIES || '').trim();
  const defaultProductionCapabilities = 'text_generation,qwen_generation,tts,video_generation,digital_human';
  const required = String(configured || (process.env.NODE_ENV === 'production' ? defaultProductionCapabilities : ''))
    .split(/[\s,;]+/)
    .map(value => value.trim())
    .filter(Boolean);
  const known = new Set<string>(KNOWN_CAPABILITIES);
  const issues: string[] = [];
  for (const name of required) {
    if (!known.has(name)) {
      issues.push(`unknown_required_capability:${name}`);
      continue;
    }
    const state = capabilities[name as RuntimeCapability];
    if (!state.ready) issues.push(`capability_unavailable:${name}:${state.reason || 'not_ready'}`);
  }
  return issues;
}

export async function runtimeReadiness(input: {
  role: ProcessRole;
  startupIssues?: string[];
  checkPocketBase?: () => Promise<void>;
  checkDigitalHumanQuality?: () => Promise<DigitalHumanQualityRuntimeReadiness>;
  checkMaterialCleanup?: () => Promise<CapabilityState>;
  checkSocialOperating?: () => Promise<SocialOperatingSignals>;
  localWorker?: BackgroundJobRuntimeState;
}) {
  const capabilities = runtimeCapabilities(input.role);
  const quality = await (input.checkDigitalHumanQuality || (() => digitalHumanQualityRuntimeReadiness()))();
  capabilities.digital_human_quality = quality.localVisual;
  capabilities.digital_human_auto_release = quality.autoRelease;
  capabilities.material_cleanup = await (input.checkMaterialCleanup || (() => materialCleanupRuntimeReadiness()))();
  const issues = [...(input.startupIssues || []), ...requiredCapabilityIssues(capabilities)];
  let socialOperating: SocialOperatingSignals | null = null;
  try {
    if (input.checkPocketBase) {
      await input.checkPocketBase();
    } else {
      const backend = selectedDataBackend();
      if (backend === 'postgres') await checkPostgres();
      // Authentication remains on PocketBase during the token-exchange
      // window, so its health is still required even after business records
      // switch to PostgreSQL.
      const health = await fetch(`${getPbUrl()}/api/health`, { signal: AbortSignal.timeout(2_000) });
      if (!health.ok) throw new Error(`health_${health.status}`);
      // This collection is the product entitlement authority and proves the
      // starter migration set has reached the connected database.
      if (backend === 'postgres') await store.list('starter_198_access', { page: 1, perPage: 1 });
      else await pbListStrict('starter_198_access', { page: 1, perPage: 1 });
      await assertSocialOperatingCollections();
    }
  } catch (error) {
    const prefix = selectedDataBackend() === 'postgres'
      ? 'data_backend_unavailable_or_unmigrated'
      : 'pocketbase_unavailable_or_unmigrated';
    issues.push(`${prefix}:${error instanceof Error ? error.message : 'unknown'}`);
  }
  try {
    if (!input.checkPocketBase && selectedQueueBackend() === 'bullmq') await checkBullMq();
  } catch (error) {
    issues.push(`queue_backend_unavailable:${error instanceof Error ? error.message : 'unknown'}`);
  }
  try {
    // Focused unit tests that inject only the dependency probe retain their
    // narrow contract. Production probes always include worker and queue state.
    if (input.checkSocialOperating) socialOperating = await input.checkSocialOperating();
    else if (!input.checkPocketBase) socialOperating = await inspectSocialOperatingSignals({
      role: input.role, localWorker: input.localWorker,
    });
    if (socialOperating && !socialOperating.worker.ready) {
      issues.push(`social_operating_worker_unready:${socialOperating.worker.source}:${socialOperating.worker.state}`);
    }
  } catch (error) {
    issues.push(`social_operating_observability_unavailable:${error instanceof Error ? error.message : 'unknown'}`);
  }
  return {
    status: issues.length ? 'degraded' as const : 'ready' as const,
    build: runtimeBuildInfo(),
    role: input.role,
    capabilities,
    digitalHumanQuality: quality,
    weeklyExecution:{source:'local_process' as const,...weeklyExecutionObservation.read()},
    socialOperating,
    issues,
  };
}

export function readinessCacheTtlMs(): number {
  const configured = Number(process.env.READINESS_CACHE_TTL_MS ?? 2_000);
  return Number.isFinite(configured)
    ? Math.min(Math.max(Math.floor(configured), 250), 10_000)
    : 2_000;
}

/**
 * Keep load balancer probes from multiplying PocketBase reads. The result is
 * cached only briefly and concurrent misses share one dependency check.
 */
export function createRuntimeReadinessProbe(input: {
  role: ProcessRole;
  startupIssues?: string[];
  checkPocketBase?: () => Promise<void>;
  checkDigitalHumanQuality?: () => Promise<DigitalHumanQualityRuntimeReadiness>;
  checkSocialOperating?: () => Promise<SocialOperatingSignals>;
  localWorker?: BackgroundJobRuntimeState;
  now?: () => number;
}) {
  type Report = Awaited<ReturnType<typeof runtimeReadiness>>;
  const now = input.now ?? Date.now;
  let cached: { report: Report; expiresAt: number } | null = null;
  let inFlight: Promise<Report> | null = null;
  // Image contents and process environment are immutable for the lifetime of
  // a production container. Import MediaPipe once instead of on every load
  // balancer probe; a failed self-check remains failed until the process is
  // restarted with a corrected image/configuration.
  let qualitySelfCheck: Promise<DigitalHumanQualityRuntimeReadiness> | null = null;
  let materialCleanupSelfCheck: Promise<CapabilityState> | null = null;
  const runQualitySelfCheck = input.checkDigitalHumanQuality || (() => digitalHumanQualityRuntimeReadiness());
  const runMaterialCleanupSelfCheck = () => materialCleanupRuntimeReadiness();
  const checkDigitalHumanQuality = () => {
    qualitySelfCheck ||= runQualitySelfCheck();
    return qualitySelfCheck;
  };
  const checkMaterialCleanup = () => {
    materialCleanupSelfCheck ||= runMaterialCleanupSelfCheck();
    return materialCleanupSelfCheck;
  };
  return async (): Promise<Report> => {
    const timestamp = now();
    if (cached && cached.expiresAt > timestamp) return cached.report;
    if (inFlight) return inFlight;
    const request = runtimeReadiness({ ...input, checkDigitalHumanQuality, checkMaterialCleanup });
    inFlight = request;
    try {
      const report = await request;
      cached = { report, expiresAt: now() + readinessCacheTtlMs() };
      return report;
    } finally {
      if (inFlight === request) inFlight = null;
    }
  };
}
