const LANG_NAME: Record<string, string> = {
  en: 'English', zh: 'Chinese (Simplified)', es: 'Spanish', fr: 'French',
  de: 'German', pt: 'Portuguese', it: 'Italian', ru: 'Russian',
  ja: 'Japanese', ko: 'Korean', ar: 'Arabic', hi: 'Hindi',
  id: 'Indonesian', th: 'Thai', vi: 'Vietnamese', tr: 'Turkish',
  nl: 'Dutch', pl: 'Polish', sv: 'Swedish', fil: 'Filipino',
  ms: 'Malay', uk: 'Ukrainian', el: 'Greek', cs: 'Czech',
  ro: 'Romanian', hu: 'Hungarian',
};

export function langName(code: string): string {
  return LANG_NAME[code] ?? 'English';
}

/** Extract the first JSON object or array from model text. */
export function extractJSON<T>(text: string): T | null {
  const match = text.match(/[[{][\s\S]*[\]}]/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as T;
  } catch {
    return null;
  }
}
