import path from 'node:path';
import { execFile } from 'node:child_process';

export interface SentenceLipSyncQualityReport {
  version: 1;
  detector: 'official_syncnet';
  modelSha256: string;
  passed: boolean;
  confidence: number;
  avOffsetFrames: number;
  thresholds: { confidenceMin: number; absoluteOffsetFramesMax: number };
  failures: string[];
}

const finite = (value: unknown, name: string): number => {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`SyncNet 质检结果 ${name} 无效`);
  return number;
};

/**
 * Accept only reports produced by the separately installed official SyncNet
 * pipeline. Provider self-reported lip-sync scores are intentionally rejected.
 */
export function parseSentenceLipSyncQuality(raw: unknown): SentenceLipSyncQualityReport {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('SyncNet 质检没有返回 JSON 对象');
  const value = raw as Record<string, unknown>;
  const thresholds = value.thresholds as Record<string, unknown> | undefined;
  const modelSha256 = String(value.model_sha256 || '').toLowerCase();
  const confidence = finite(value.syncnet_confidence, 'syncnet_confidence');
  const avOffsetFrames = finite(value.av_offset_frames, 'av_offset_frames');
  const confidenceMin = finite(thresholds?.confidence_min, 'thresholds.confidence_min');
  const absoluteOffsetFramesMax = finite(thresholds?.absolute_offset_frames_max, 'thresholds.absolute_offset_frames_max');
  if (Number(value.version) !== 1 || value.detector !== 'official_syncnet') throw new Error('SyncNet 质检来源或版本不受支持');
  if (!/^[a-f0-9]{64}$/.test(modelSha256)) throw new Error('SyncNet 质检缺少模型 SHA-256 证据');
  if (confidenceMin < 7 || absoluteOffsetFramesMax > 1) throw new Error('SyncNet 质检阈值低于商业成片自动放行标准');
  const failures = Array.isArray(value.failures) ? value.failures.map(String).filter(Boolean).slice(0, 20) : [];
  const measuredPass = confidence >= confidenceMin && Math.abs(avOffsetFrames) <= absoluteOffsetFramesMax;
  if (Boolean(value.passed) !== (measuredPass && failures.length === 0)) throw new Error('SyncNet 质检结论与指标不一致');
  return {
    version: 1,
    detector: 'official_syncnet',
    modelSha256,
    passed: measuredPass && failures.length === 0,
    confidence,
    avOffsetFrames,
    thresholds: { confidenceMin, absoluteOffsetFramesMax },
    failures,
  };
}

/** Run a separately provisioned SyncNet model; failed thresholds still return evidence. */
export async function inspectSentenceLipSyncQuality(videoPath: string, options: {
  pythonPath?: string;
  scriptPath?: string;
  syncnetDir?: string;
  workDir?: string;
  timeoutMs?: number;
} = {}): Promise<SentenceLipSyncQualityReport> {
  const pythonPath = String(options.pythonPath || process.env.DIGITAL_HUMAN_SYNCNET_QA_PYTHON || '').trim();
  const syncnetDir = String(options.syncnetDir || process.env.DIGITAL_HUMAN_SYNCNET_DIR || '').trim();
  if (!pythonPath || !syncnetDir) throw new Error('未配置独立 SyncNet Python 环境或模型目录');
  const scriptPath = options.scriptPath || path.resolve(process.cwd(), 'scripts/validate-syncnet.py');
  const workDir = options.workDir || `${videoPath}.syncnet-work`;
  const args = [scriptPath, '--video', videoPath, '--work-dir', workDir, '--syncnet-dir', syncnetDir,
    '--python', pythonPath, '--min-confidence', '7', '--max-offset', '1'];
  const stdout = await new Promise<string>((resolve, reject) => execFile(pythonPath, args, {
    timeout: options.timeoutMs || 300_000,
    maxBuffer: 4 * 1024 * 1024,
    encoding: 'utf8',
    env: { ...process.env, PYTHONNOUSERSITE: '1' },
  }, (error, output, stderr) => {
    // Exit 2 means the detector ran and rejected the clip. Preserve its JSON
    // as negative evidence instead of converting it into an unavailable check.
    if (!output?.trim()) return reject(new Error(`SyncNet 质检执行失败：${String(stderr || error?.message || '无输出').slice(0, 500)}`));
    resolve(output);
  }));
  let raw: unknown;
  try { raw = JSON.parse(stdout); } catch { throw new Error('SyncNet 质检没有返回合法 JSON'); }
  return parseSentenceLipSyncQuality(raw);
}
