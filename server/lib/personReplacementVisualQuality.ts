import path from 'node:path';
import { execFile } from 'node:child_process';
import type { ReferenceVisualMetrics } from '../../src/lib/digitalHumanQuality.js';

type RawReport = Record<string, unknown>;
const finiteOrNull = (value: unknown, key: string): number | null => {
  if (value === null) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`视觉质检结果 ${key} 无效`);
  return number;
};
const count = (value: unknown, key: string) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`视觉质检结果 ${key} 无效`);
  return number;
};

export function parsePersonReplacementVisualReport(raw: unknown): ReferenceVisualMetrics {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('视觉质检没有返回结构化结果');
  const value = raw as RawReport;
  if (value.version !== 1) throw new Error('视觉质检结果版本不受支持');
  const report: ReferenceVisualMetrics = {
    normalizedPoseError: finiteOrNull(value.normalizedPoseError, 'normalizedPoseError'), posePairCount: count(value.posePairCount, 'posePairCount'),
    handPckAt008: finiteOrNull(value.handPckAt008, 'handPckAt008'), handPairCount: count(value.handPairCount, 'handPairCount'),
    wristSeparationMae: finiteOrNull(value.wristSeparationMae, 'wristSeparationMae'), wristMotionCorrelation: finiteOrNull(value.wristMotionCorrelation, 'wristMotionCorrelation'),
    wristPosePairCount: count(value.wristPosePairCount, 'wristPosePairCount'), backgroundSsim: finiteOrNull(value.backgroundSsim, 'backgroundSsim'),
    landmarkArtifactCount: count(value.landmarkArtifactCount, 'landmarkArtifactCount'),
    faceAppearanceCorrelationProxy: finiteOrNull(value.faceAppearanceCorrelationProxy, 'faceAppearanceCorrelationProxy'), facePairCount: count(value.facePairCount, 'facePairCount'),
  };
  for (const [key, metric] of Object.entries(report)) {
    if (metric === null || key.endsWith('Count')) continue;
    if (['normalizedPoseError', 'handPckAt008', 'backgroundSsim', 'faceAppearanceCorrelationProxy', 'wristMotionCorrelation'].includes(key)
      && (Number(metric) < -1 || Number(metric) > 1)) throw new Error(`视觉质检结果 ${key} 超出范围`);
  }
  return report;
}

/** Runs the pinned local Python visual proxy pipeline. It does not claim identity verification. */
export async function inspectPersonReplacementVisualPair(sourcePath: string, candidatePath: string, options: { pythonPath?: string; scriptPath?: string; timeoutMs?: number } = {}) {
  const pythonPath = String(options.pythonPath || process.env.DIGITAL_HUMAN_VISUAL_QA_PYTHON || '').trim();
  if (!pythonPath) throw new Error('未配置数字人视觉质检 Python 环境');
  const scriptPath = options.scriptPath || path.resolve(process.cwd(), 'scripts/person_replacement_visual_qa.py');
  const stdout = await new Promise<string>((resolve, reject) => execFile(pythonPath, [scriptPath, sourcePath, candidatePath, '--sample-fps', '5'], {
    timeout: options.timeoutMs || 180_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, PYTHONNOUSERSITE: '1' },
  }, (error, output, stderr) => error ? reject(new Error(`视觉质检执行失败：${String(stderr || error.message).slice(0, 500)}`)) : resolve(output)));
  let raw: unknown;
  try { raw = JSON.parse(stdout); } catch { throw new Error('视觉质检没有返回合法 JSON'); }
  return parsePersonReplacementVisualReport(raw);
}
