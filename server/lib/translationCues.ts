export type TimestampedTranslationCue = { timestamp: string; text: string };

const TRANSLATION_CUE_LINE_RE = /^\s*(\[[^\]]*?\d+(?:\.\d+)?\s*(?:s|秒)?\s*[-–—]\s*\d+(?:\.\d+)?\s*(?:s|秒)?[^\]]*\])\s*(.+?)\s*$/i;

export function timestampedTranslationCues(value: string): TimestampedTranslationCue[] {
  return String(value || '').split(/\n+/)
    .map(line => line.match(TRANSLATION_CUE_LINE_RE))
    .filter((match): match is RegExpMatchArray => Boolean(match?.[1] && match?.[2]))
    .map(match => ({ timestamp: match[1]!.trim(), text: match[2]!.trim() }))
    .filter(cue => cue.text.length > 0);
}

/** Keep one translated line per source cue and rebuild the exact source timeline. */
export function normalizeCompleteTimestampTranslation(source: string, translated: string, targetCode: string): string {
  const sourceCues = timestampedTranslationCues(source);
  if (!sourceCues.length) return String(translated || '').trim();
  const translatedCues = timestampedTranslationCues(translated);
  if (translatedCues.length !== sourceCues.length) return '';
  const targetTexts = translatedCues.map(cue => cue.text.replace(/^[-*•]\s*/, '').trim());
  if (targetTexts.some(text => !text || /translation unavailable|无法翻译|不能翻译|作为AI|Here is|```/i.test(text))) return '';
  if (targetCode !== 'zh' && targetTexts.some(text => {
    const hanCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const letterCount = (text.match(/\p{L}/gu) || []).length;
    return hanCount >= 6 && hanCount / Math.max(1, letterCount) > 0.45;
  })) return '';
  const distinctSource = new Set(sourceCues.map(cue => cue.text.replace(/\s+/g, '').toLowerCase())).size;
  const distinctTarget = new Set(targetTexts.map(text => text.replace(/\s+/g, '').toLowerCase())).size;
  if (sourceCues.length > 1 && distinctSource > 1 && distinctTarget === 1) return '';
  return sourceCues.map((cue, index) => `${cue.timestamp} ${targetTexts[index]}`).join('\n');
}

function translationLinesFromUnknown(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(item => {
    if (typeof item === 'string' || typeof item === 'number') return String(item).trim();
    if (item && typeof item === 'object') {
      const row = item as Record<string, unknown>;
      return String(row.text ?? row.translation ?? row.content ?? row.value ?? '').trim();
    }
    return '';
  }).filter(Boolean);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['lines', 'translations', 'translation', 'text', 'content', 'result', 'output']) {
      if (record[key] !== undefined) {
        const nested = translationLinesFromUnknown(record[key]);
        if (nested.length) return nested;
      }
    }
    return [];
  }
  const text = String(value ?? '').trim();
  if (!text) return [];
  const match = text.match(/[\[{][\s\S]*[\]}]/);
  if (match) try {
    const parsed: unknown = JSON.parse(match[0]);
    if (parsed && parsed !== value) {
      const nested = translationLinesFromUnknown(parsed);
      if (nested.length) return nested;
    }
  } catch { /* plain text follows */ }
  return text.split(/\n+/).map(line => line.replace(/^\s*(?:[-*•]|\d+[.)．、])\s*/, '').trim()).filter(Boolean);
}

export function normalizeTimestampTranslationValue(source: string, value: unknown, targetCode: string): string {
  const sourceCues = timestampedTranslationCues(source);
  if (!sourceCues.length) return translationLinesFromUnknown(value).join('\n').trim();
  if (typeof value === 'string') {
    const direct = normalizeCompleteTimestampTranslation(source, value, targetCode);
    if (direct) return direct;
  }
  const lines = translationLinesFromUnknown(value);
  if (lines.length !== sourceCues.length) return '';
  const rebuilt = sourceCues.map((cue, index) => `${cue.timestamp} ${String(lines[index] || '').replace(/^\s*\[[^\]]+\]\s*/, '').trim()}`).join('\n');
  return normalizeCompleteTimestampTranslation(source, rebuilt, targetCode);
}

export function translationValueForLanguage(value: Record<string, unknown>, code: string, languageLabel: string): unknown {
  const names = [code.toLowerCase(), languageLabel.toLowerCase()];
  const containers: Record<string, unknown>[] = [value];
  if (value.translations && typeof value.translations === 'object' && !Array.isArray(value.translations)) containers.push(value.translations as Record<string, unknown>);
  for (const container of containers) {
    const key = Object.keys(container).find(candidate => names.includes(candidate.toLowerCase()));
    if (key) return container[key];
  }
  if (Array.isArray(value.translations)) {
    const row = value.translations.find(item => item && typeof item === 'object'
      && names.includes(String((item as Record<string, unknown>).language ?? (item as Record<string, unknown>).code ?? '').toLowerCase())) as Record<string, unknown> | undefined;
    if (row) return row.lines ?? row.translation ?? row.text ?? row.content;
  }
  return undefined;
}
