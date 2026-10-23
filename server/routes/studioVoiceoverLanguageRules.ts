const LATIN_VOICEOVER_LANGUAGES = new Set([
  'en', 'es', 'fr', 'de', 'pt', 'it', 'id', 'vi', 'tr', 'nl', 'pl', 'sv',
  'fil', 'ms', 'cs', 'ro', 'hu',
]);
const HAN_SCRIPT_RE = /[\u3400-\u9fff]/;
const KANA_SCRIPT_RE = /[\u3040-\u30ff]/;
const HANGUL_SCRIPT_RE = /[\uac00-\ud7af]/;
const ARABIC_SCRIPT_RE = /[\u0600-\u06ff]/;
const DEVANAGARI_SCRIPT_RE = /[\u0900-\u097f]/;
const THAI_SCRIPT_RE = /[\u0e00-\u0e7f]/;
const CYRILLIC_SCRIPT_RE = /[\u0400-\u04ff]/;
const NON_LATIN_VOICEOVER_SCRIPT_RE = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af\u0600-\u06ff\u0900-\u097f\u0e00-\u0e7f\u0400-\u04ff]/;

function latinWordCount(value: string): number {
  return String(value || '').match(/[A-Za-zÀ-ž]+(?:[-'][A-Za-zÀ-ž]+)*/g)?.length || 0;
}

/** Detect script-family mismatches before TTS while allowing Latin brand names and model numbers. */
export function voiceoverLineNeedsLanguageRepair(value: string, targetLanguage: string): boolean {
  const line = String(value || '').trim();
  if (!line) return false;
  const target = String(targetLanguage || 'en').toLowerCase();
  if (LATIN_VOICEOVER_LANGUAGES.has(target)) return NON_LATIN_VOICEOVER_SCRIPT_RE.test(line);
  if (target === 'zh') {
    return !HAN_SCRIPT_RE.test(line)
      && (latinWordCount(line) >= 3 || KANA_SCRIPT_RE.test(line) || HANGUL_SCRIPT_RE.test(line)
        || ARABIC_SCRIPT_RE.test(line) || DEVANAGARI_SCRIPT_RE.test(line)
        || THAI_SCRIPT_RE.test(line) || CYRILLIC_SCRIPT_RE.test(line));
  }
  if (target === 'ja') return HANGUL_SCRIPT_RE.test(line) || ARABIC_SCRIPT_RE.test(line)
    || DEVANAGARI_SCRIPT_RE.test(line) || THAI_SCRIPT_RE.test(line) || CYRILLIC_SCRIPT_RE.test(line);
  if (target === 'ko') return KANA_SCRIPT_RE.test(line) || ARABIC_SCRIPT_RE.test(line)
    || DEVANAGARI_SCRIPT_RE.test(line) || THAI_SCRIPT_RE.test(line) || CYRILLIC_SCRIPT_RE.test(line);
  if (target === 'ar') return HAN_SCRIPT_RE.test(line) || KANA_SCRIPT_RE.test(line)
    || HANGUL_SCRIPT_RE.test(line) || DEVANAGARI_SCRIPT_RE.test(line)
    || THAI_SCRIPT_RE.test(line) || CYRILLIC_SCRIPT_RE.test(line)
    || (!ARABIC_SCRIPT_RE.test(line) && latinWordCount(line) >= 3);
  if (target === 'ru' || target === 'uk') return HAN_SCRIPT_RE.test(line) || KANA_SCRIPT_RE.test(line)
    || HANGUL_SCRIPT_RE.test(line) || ARABIC_SCRIPT_RE.test(line)
    || DEVANAGARI_SCRIPT_RE.test(line) || THAI_SCRIPT_RE.test(line)
    || (!CYRILLIC_SCRIPT_RE.test(line) && latinWordCount(line) >= 3);
  if (target === 'hi') return HAN_SCRIPT_RE.test(line) || KANA_SCRIPT_RE.test(line)
    || HANGUL_SCRIPT_RE.test(line) || ARABIC_SCRIPT_RE.test(line)
    || THAI_SCRIPT_RE.test(line) || CYRILLIC_SCRIPT_RE.test(line)
    || (!DEVANAGARI_SCRIPT_RE.test(line) && latinWordCount(line) >= 3);
  if (target === 'th') return HAN_SCRIPT_RE.test(line) || KANA_SCRIPT_RE.test(line)
    || HANGUL_SCRIPT_RE.test(line) || ARABIC_SCRIPT_RE.test(line)
    || DEVANAGARI_SCRIPT_RE.test(line) || CYRILLIC_SCRIPT_RE.test(line)
    || (!THAI_SCRIPT_RE.test(line) && latinWordCount(line) >= 3);
  return false;
}

export function splitVoiceoverLanguageLines(value: string): string[] {
  return String(value || '')
    .split(/\n+/)
    .flatMap(line => line.match(/[^。！？!?；;]+[。！？!?；;]?/g) || [line])
    .map(line => line.trim())
    .filter(Boolean);
}

export function splitStudioNarrationSentences(spoken: string): string[] {
  return spoken.split(/(?<=[。！？!?])\s*|(?<=\.)\s+(?=[¿¡]?[A-ZÀ-ž])/u)
    .map(value => value.trim()).filter(Boolean);
}
