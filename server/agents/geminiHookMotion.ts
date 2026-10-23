import { GoogleGenAI } from '@google/genai';
import type { HookMotionEvidence } from '../routes/hookMotionEvidence.js';

/** Observe the first second only. Visual motion evidence never establishes
 * audio, dialogue, or the director's intended gesture by itself. */
export async function inspectOpeningHookMotionWithGemini(opts: {
  frames: Array<{ base64: string; mimeType: string; timeLabel: string }>;
  signal?: AbortSignal;
}): Promise<HookMotionEvidence> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new Error('GEMINI_API_KEY is not set');
  const frames = opts.frames.filter(frame => Number.isFinite(Number.parseFloat(frame.timeLabel))
    && Number.parseFloat(frame.timeLabel) >= 0 && Number.parseFloat(frame.timeLabel) < 1).slice(0, 12);
  if (frames.length < 8) return { observations: [], transitions: [], uncertainties: ['opening_hook_insufficient_frames'] };
  const ai = new GoogleGenAI({ apiKey: key });
  const response = await ai.models.generateContent({
    model: (process.env.GEMINI_HOOK_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim(),
    contents: [{ role: 'user', parts: [
      { text: `下面是原视频 0–1 秒按 12 帧/秒提取的连续画面，时间依次为 ${frames.map(frame => frame.timeLabel).join('、')}。只根据这些画面记录可见证据。区分人物身体朝镜头移动、仅手臂/手靠近镜头、摄像机移动；要判定敲门手势，必须指出手形变化和接近/接触的位置证据，否则写不确定。第一帧可能是封面闪帧，不要把它当作动作起点。每帧分别描述人物占画比例、身体/手部与镜头的相对距离、手形、接触点和镜头状态。转换须引用至少两个具体时间点。不可推断配乐、口播、意图或画外动作。仅输出 JSON：{"observations":[{"time":0,"visibleState":"","confidence":0}],"transitions":[{"from":0,"to":0,"action":"","evidence":"","confidence":0}],"uncertainties":[]}。` },
      ...frames.map(frame => ({ inlineData: { mimeType: frame.mimeType, data: frame.base64 } })),
    ] }],
    config: { responseMimeType: 'application/json', maxOutputTokens: 6000,
      thinkingConfig: { thinkingBudget: 0 },
      httpOptions: { timeout: 60_000 }, ...(opts.signal ? { abortSignal: opts.signal } : {}) },
  });
  if (!response.text?.trim()) throw new Error('gemini_hook_empty_response');
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(response.text) as Record<string, unknown>; }
  catch { throw new Error('gemini_hook_invalid_json'); }
  const rows = (value: unknown): Record<string, unknown>[] => Array.isArray(value)
    ? value.filter(row => row && typeof row === 'object' && !Array.isArray(row)) as Record<string, unknown>[] : [];
  const finite = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : NaN;
  const confidence = (value: unknown) => Number.isFinite(Number(value)) ? Math.max(0, Math.min(1, Number(value))) : 0;
  const observations = rows(parsed.observations).map(row => ({
    time: finite(row.time), visibleState: String(row.visibleState || '').trim(), confidence: confidence(row.confidence),
  })).filter(row => Number.isFinite(row.time) && row.time >= 0 && row.time <= 1 && row.visibleState);
  const transitions = rows(parsed.transitions).map(row => ({
    from: finite(row.from), to: finite(row.to), action: String(row.action || '').trim(),
    evidence: String(row.evidence || '').trim(), confidence: confidence(row.confidence),
  })).filter(row => Number.isFinite(row.from) && Number.isFinite(row.to) && row.from >= 0 && row.to <= 1
    && row.to > row.from && row.action && row.evidence);
  const uncertainties = Array.isArray(parsed.uncertainties) ? parsed.uncertainties.map(value => {
    if (typeof value === 'string') return value.trim();
    if (value && typeof value === 'object') {
      const row = value as Record<string, unknown>;
      return String(row.reason || row.description || row.issue || '').trim();
    }
    return '';
  }).filter(Boolean) : [];
  if (!observations.length) throw new Error('gemini_hook_observation_empty');
  return { observations, transitions, uncertainties };
}
