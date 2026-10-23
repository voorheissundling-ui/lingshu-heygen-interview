export interface ApproxSpeechLine {
  text: string;
  start: number;
  end: number;
  timingPrecision: 'coarse';
  provenance: string;
  visibility: 'unknown';
}

/** Split an ASR window only at sentence punctuation. Times are estimates,
 * proportionally distributed within the source window, never verified cues. */
export function approximateSpeechLines(segments: unknown): ApproxSpeechLine[] {
  if (!Array.isArray(segments)) return [];
  return segments.flatMap((raw, index) => {
    if (!raw || typeof raw !== 'object') return [];
    const item = raw as Record<string, unknown>;
    const start = Number(item.start), end = Number(item.end);
    const text = typeof item.text === 'string' ? item.text.trim() : '';
    if (!text || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return [];
    const sentences = (text.match(/[^.!?。！？;；]+[.!?。！？;；]*/g) || [text]).map(part => part.trim()).filter(Boolean);
    const total = sentences.reduce((sum, part) => sum + part.length, 0);
    let cursor = start;
    return sentences.map((part, sentenceIndex) => {
      const next = sentenceIndex === sentences.length - 1 ? end
        : start + (end - start) * sentences.slice(0, sentenceIndex + 1).reduce((sum, sentence) => sum + sentence.length, 0) / total;
      const line = { text: part, start: Number(cursor.toFixed(2)), end: Number(next.toFixed(2)),
        timingPrecision: 'coarse' as const,
        provenance: `${typeof item.provenance === 'string' && item.provenance.trim() || 'source_asr'}:window-${index + 1}`,
        visibility: 'unknown' as const };
      cursor = next;
      return line;
    }).filter(line => line.end > line.start);
  });
}
