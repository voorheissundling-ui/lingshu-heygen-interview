type ReferenceTimelineRange = { start: number; end: number };

/** Pure timeline evidence check shared by reference text and structured script details. */
export function referenceTimelineQuality(referenceAnalysis: unknown, requestedDuration: unknown): {
  valid: boolean;
  issues: string[];
  ranges: ReferenceTimelineRange[];
  duration: number;
} {
  const raw = String(referenceAnalysis || '');
  // Only treat a line-leading range as a shot. Beat timestamps embedded inside
  // the shot description must not inflate density or create false overlaps.
  const ranges = Array.from(raw.matchAll(/^\s*\[\s*(\d+(?:\.\d+)?)\s*(?:s|秒)?\s*[-–—~至]\s*(\d+(?:\.\d+)?)\s*(?:s|秒)?\s*\]/gim))
    .map(match => ({ start: Number(match[1]), end: Number(match[2]) }))
    .filter(item => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const requested = Number(requestedDuration || 0);
  const analyzedEnd = ranges.reduce((max, item) => Math.max(max, item.end), 0);
  // The source duration is normally reflected by the last exact-analysis range.
  // Do not let the studio's default target duration make a shorter source look incomplete.
  const duration = analyzedEnd > 0 ? analyzedEnd : Math.max(0, requested);
  const issues: string[] = [];
  if (!ranges.length) issues.push('缺少可解析的逐镜时间戳');
  if (ranges.length && ranges[0]!.start > 0.75) issues.push(`时间线未从片头开始（首段 ${ranges[0]!.start.toFixed(1)}s）`);
  for (let index = 0; index < ranges.length; index += 1) {
    const item = ranges[index]!;
    const next = ranges[index + 1];
    if (next && next.start - item.end > 0.75) issues.push(`时间线存在空档 ${item.end.toFixed(1)}-${next.start.toFixed(1)}s`);
    if (next && item.end - next.start > 0.75) issues.push(`时间线存在重叠 ${next.start.toFixed(1)}-${item.end.toFixed(1)}s`);
  }
  // Physical visual cuts define shots. A continuous shot can last longer than
  // five seconds, and speech cadence must not create artificial picture cuts.
  // A review flag records honest uncertainty about names, prices, handedness
  // or ASR and does not make the visual timeline incomplete. Only genuine
  // timeout/missing-evidence placeholders should block storyboard generation.
  if (/分析超时|缺少真实片段/.test(raw)) {
    issues.push('分析包含超时或缺少真实片段');
  }
  return { valid: issues.length === 0, issues: [...new Set(issues)], ranges, duration };
}

export function analysisDetailsTimelineQuality(details: unknown, duration: unknown) {
  const rows = Array.isArray(details)
    ? details.map(item => `[${String((item as { time?: unknown })?.time || '').replace(/^\s*\[|\]\s*$/g, '')}]`).join('\n')
    : '';
  return referenceTimelineQuality(rows, duration);
}
