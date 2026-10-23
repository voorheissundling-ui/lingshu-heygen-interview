export interface SpeechCue { text: string; start: number; end: number; words?: SpeechCue[] }
export const speechText = (text: string) => String(text || '').normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '');
export const spokenText = (text: string) => /^(无|none|无口播|无台词)$/i.test(String(text || '').trim()) ? '' : String(text || '').trim();
export function narrationFromDetail(detail: string): string {
  return spokenText(String(detail || '').match(/(?:人物说|台词|Voiceover|VO|口播)\s*[：:]\s*(.*?)(?=\s+(?:环境|景别|运镜|画面|Visual|字幕|Caption|素材|素材依据|配乐|真实性要求|可见事实)\s*[：:]|$)/is)?.[1]?.replace(/^[“"]|[”"]$/g, '') || '');
}

/** Validate actual timestamps without fabricating/clamping missing ones. */
export function validateSpeechCues(cues: SpeechCue[], transcript: string, duration: number): boolean {
  if (!Array.isArray(cues) || !cues.length || !Number.isFinite(duration) || duration <= 0) return false;
  let end = 0;
  for (const cue of cues) {
    if (!cue || typeof cue.text !== 'string' || !speechText(cue.text) || !Number.isFinite(cue.start) || !Number.isFinite(cue.end)
      || cue.start < end || cue.end <= cue.start || cue.end > duration) return false;
    end = cue.end;
  }
  return speechText(cues.map(cue => cue.text).join('')) === speechText(transcript);
}

/** Match complete cues in order. Never split a sentence by guessed character ratios. */
export function mapNarrationCues(narrations: string[], cues: SpeechCue[], duration: number, source?: string) {
  const texts = narrations.map(spokenText);
  if (!['audio_ai', 'minimax_native', 'synthesized_sentence_audio', 'manual_confirmed', 'qwen_asr'].includes(source || '')) throw new Error('配音仍为估算时间，请在分镜与声音页逐句试听、调整并确认时间轴');
  if (source === 'qwen_asr') {
    const words = cues.flatMap(cue => cue.words || []);
    if (!validateSpeechCues(words, cues.map(cue => cue.text).join(''), duration)) throw new Error('千问字词时间戳无效');
    cues = words;
  }
  if (!validateSpeechCues(cues, texts.join(''), duration)) throw new Error('字幕时间越界、重叠或与逐镜台词不一致，请重新对齐');
  let cursor = 0;
  return texts.map(text => {
    if (!text) return null;
    const expected = speechText(text); const first = cursor; let actual = '';
    while (cursor < cues.length && actual.length < expected.length) actual += speechText(cues[cursor++].text);
    if (actual !== expected) throw new Error('字幕句子跨越镜头边界，请拆分字幕并按音频确认边界，不自动按字数切分');
    const start = cues[first].start, end = cues[cursor - 1].end;
    return { start, end, cues: source === 'qwen_asr' ? [{ text, start, end, words: cues.slice(first, cursor) }] : cues.slice(first, cursor) };
  });
}
