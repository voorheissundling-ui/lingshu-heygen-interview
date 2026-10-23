const cleanText = (value: unknown, max = 500): string => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);

export function containsInternalContentMarker(value: unknown): boolean {
  const content = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return /\be2e[-_][\w-]*|(?:https?:\/\/)?(?:[\w-]+\.)?local\.test\b|\bplaceholder\b|\bmock[-_](?:data|asset|project|content|video|image|test|product)\b/i.test(content);
}

export function subtitleCuesAreSafe(value: unknown, duration: number): boolean {
  const cues = Array.isArray(value) ? value as Array<Record<string, unknown>> : [];
  if (!cues.length) return false;
  let previousEnd = 0;
  return cues.every(cue => {
    const start = Number(cue.start), end = Number(cue.end), content = cleanText(cue.text);
    const valid = Number.isFinite(start) && Number.isFinite(end) && start >= previousEnd && end > start && end <= duration + 0.1
      && content.length > 0 && content.length <= 80 && !containsInternalContentMarker(content);
    previousEnd = end;
    return valid;
  });
}

/** Split only inside an aligned interval; preserve its exact text and endpoints. */
export function paginateAlignedCues(value: unknown, duration: number): Array<{ start: number; end: number; text: string }> | null {
  if (!Array.isArray(value) || !value.length) return null;
  const result: Array<{ start: number; end: number; text: string }> = [];
  let previousEnd = 0;
  for (const cue of value) {
    if (!cue || typeof cue.text !== 'string') return null;
    const start = Number(cue.start), end = Number(cue.end), content = cue.text;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < previousEnd || end <= start || end > duration + 0.1 || !content.trim() || containsInternalContentMarker(content)) return null;
    const chunks: string[] = [];
    let remaining = content;
    const pageLimit = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(content) ? 16 : 42;
    while (remaining.length > pageLimit) {
      const pagesLeft = Math.ceil(remaining.length / pageLimit);
      const target = remaining.length / pagesLeft;
      const minimum = Math.max(1, remaining.length - (pagesLeft - 1) * pageLimit);
      const boundaries: number[] = [];
      for (let index = minimum; index <= pageLimit; index += 1) {
        if (/\s|[，。！？；、]/u.test(remaining[index - 1])) boundaries.push(index);
      }
      const nearby = boundaries.filter(index => Math.abs(index - target) <= target / 3);
      let cut = nearby.length ? nearby.reduce((best, index) => Math.abs(index - target) < Math.abs(best - target) ? index : best) : Math.round(target);
      if (/[\uD800-\uDBFF]/.test(remaining[cut - 1])) cut += cut < pageLimit ? 1 : -1;
      chunks.push(remaining.slice(0, cut)); remaining = remaining.slice(cut);
    }
    if (remaining) chunks.push(remaining);
    let consumed = 0;
    for (const chunk of chunks) {
      const chunkStart = start + (end - start) * consumed / content.length;
      consumed += chunk.length;
      result.push({ start: chunkStart, end: consumed === content.length ? end : start + (end - start) * consumed / content.length, text: chunk });
    }
    previousEnd = end;
  }
  return subtitleCuesAreSafe(result, duration) ? result : null;
}
