/** Product language contract. Provider availability is checked separately. */
export const VIDEO_LANGUAGES = { en: '英语', zh: '中文', es: '西班牙语', fr: '法语', de: '德语', pt: '葡萄牙语', ar: '阿拉伯语', id: '印尼语', vi: '越南语', ja: '日语', ko: '韩语', ru: '俄语', it: '意大利语' } as const;
export function normalizeVideoLanguage(value: unknown): string {
  const raw = String(value || '').trim().toLowerCase();
  const aliases: Record<string, string> = { english: 'en', chinese: 'zh', spanish: 'es', french: 'fr', german: 'de', portuguese: 'pt', arabic: 'ar', indonesian: 'id', vietnamese: 'vi', japanese: 'ja', korean: 'ko', russian: 'ru', italian: 'it', 英文: 'en', 汉语: 'zh' };
  return Object.entries(VIDEO_LANGUAGES).find(([, label]) => label === raw)?.[0] || aliases[raw] || raw.split(/[-_]/)[0];
}
export function narrationLength(text: string, language: string): number {
  const code = normalizeVideoLanguage(language);
  return ['zh', 'ja'].includes(code) ? (text.match(/[\p{L}\p{N}]/gu) || []).length : (text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || []).length;
}
export function narrationRate(language: string): number { return ['zh', 'ja'].includes(normalizeVideoLanguage(language)) ? 4 : 2.3; }
