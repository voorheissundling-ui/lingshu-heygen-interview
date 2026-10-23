export type MiniMaxCue = {text: string; start: number; end: number};
/** MiniMax's subtitle JSON uses time_begin/time_end in milliseconds. Missing
 * fields are invalid evidence, never a synthetic 0–80ms timestamp. */
export function parseMiniMaxSubtitleTiming(raw: unknown, duration: number): MiniMaxCue[] {
  const value = raw as any;
  const rows: any[] = Array.isArray(value) ? value : [value?.subtitles,value?.subtitle,value?.sentences,value?.words,value?.data].find(Array.isArray) || [];
  let previousEnd = 0;
  const result: MiniMaxCue[] = [];
  for (const row of rows) {
    const text = String(row?.text ?? row?.word ?? row?.content ?? '').trim();
    const start = Number(row?.time_begin ?? row?.start_time ?? row?.begin_time ?? row?.start ?? row?.startTime) / 1000;
    const end = Number(row?.time_end ?? row?.end_time ?? row?.end ?? row?.endTime) / 1000;
    if (!text || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || start < previousEnd - .03 || end > duration + .3) return [];
    result.push({text,start,end: Math.min(end,duration)}); previousEnd = end;
  }
  return result;
}
