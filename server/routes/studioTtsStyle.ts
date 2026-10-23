import { MINIMAX_ENGLISH_PRESETS } from '../lib/studioVoiceSelection.js';
import { normalizeVideoLanguage } from '../../shared/contracts/videoLanguages.js';

export type TtsPreset = 'tiktok_excited' | 'authentic_review' | 'professional_b2b' | 'warm_story' | 'urgent_cta';

export interface TtsStyleOptions {
  preset?: TtsPreset;
  emotion?: string;
  emotionIntensity?: number;
  speed?: number;
  targetDuration?: number;
  pauseStyle?: 'few' | 'natural' | 'dramatic';
  pronunciations?: Array<{ word: string; pronunciation: string }>;
}

const TTS_PRESET_GUIDE: Record<TtsPreset, string> = {
  tiktok_excited: 'High-energy TikTok product recommendation. Start with excited surprise, use crisp emphasis and quick but intelligible pacing, then land the CTA strongly.',
  authentic_review: 'Authentic personal product review. Sound conversational, specific and pleasantly surprised, never like a hard-sell announcer.',
  professional_b2b: 'Professional cross-border B2B presenter. Sound confident, credible and restrained, with clear pronunciation of specifications and sourcing terms.',
  warm_story: 'Warm lifestyle storytelling. Use a gentle smile, natural breathing and slightly slower emotional pacing.',
  urgent_cta: 'Conversion-focused call to action. Build urgency without shouting, emphasize the offer and finish decisively.',
};

export function normalizeTtsStyle(input: unknown): TtsStyleOptions {
  const raw = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const preset = String(raw.preset || '') as TtsPreset;
  return {
    preset: preset in TTS_PRESET_GUIDE ? preset : 'authentic_review',
    emotion: String(raw.emotion || '自然可信').slice(0, 40),
    emotionIntensity: Math.max(0, Math.min(100, Number(raw.emotionIntensity ?? 65) || 65)),
    speed: Math.max(0.75, Math.min(1.35, Number(raw.speed ?? 1) || 1)),
    targetDuration: Math.max(0, Math.min(180, Number(raw.targetDuration ?? 0) || 0)),
    pauseStyle: raw.pauseStyle === 'few' || raw.pauseStyle === 'dramatic' ? raw.pauseStyle : 'natural',
    pronunciations: Array.isArray(raw.pronunciations) ? raw.pronunciations.slice(0, 20).map(item => {
      const row = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      return { word: String(row.word || '').trim().slice(0, 60), pronunciation: String(row.pronunciation || '').trim().slice(0, 120) };
    }).filter(item => item.word && item.pronunciation) : [],
  };
}

export function minimaxSpeechText(text: string, style: TtsStyleOptions): string {
  const clean = String(text || '').replace(/<#\d+(?:\.\d+)?#>/g, '').trim();
  if (style.pauseStyle === 'few') return clean;
  // The deterministic variation keeps retried copy predictable.
  const sentencePauses = style.pauseStyle === 'dramatic'
    ? [0.34, 0.46, 0.39, 0.52]
    : [0.18, 0.27, 0.22, 0.31];
  const clausePauses = style.pauseStyle === 'dramatic'
    ? [0.16, 0.24, 0.19]
    : [0.07, 0.13, 0.09];
  let sentenceIndex = 0;
  let clauseIndex = 0;
  return clean
    .replace(/([。！？!?；;]|\.(?=\s+[\p{Lu}]))(?=\s*\S)/gu, punctuation => {
      const pause = sentencePauses[sentenceIndex++ % sentencePauses.length];
      return `${punctuation}<#${pause.toFixed(2)}#>`;
    })
    .replace(/([，,：:])(?=\s*\S)/g, punctuation => {
      const pause = clausePauses[clauseIndex++ % clausePauses.length];
      return `${punctuation}<#${pause.toFixed(2)}#>`;
    });
}

export function minimaxVoiceModify(style: TtsStyleOptions): { pitch: number; intensity: number; timbre: number } {
  const preset = style.preset || 'authentic_review';
  const presetShape: Record<TtsPreset, { pitch: number; timbre: number }> = {
    tiktok_excited: { pitch: 2, timbre: 2 },
    authentic_review: { pitch: 0, timbre: 1 },
    professional_b2b: { pitch: -1, timbre: -2 },
    warm_story: { pitch: -1, timbre: 3 },
    urgent_cta: { pitch: 1, timbre: -1 },
  };
  const intensity = Math.max(-8, Math.min(14, Math.round(((style.emotionIntensity ?? 65) - 50) * 0.35)));
  return { ...presetShape[preset], intensity };
}

export function minimaxPronunciationDict(style: TtsStyleOptions): { tone: string[] } | undefined {
  const tone = (style.pronunciations || [])
    .map(item => `${item.word}/${item.pronunciation}`)
    .filter(item => !/[\r\n]/.test(item));
  return tone.length ? { tone } : undefined;
}

// 工作台音色 → Qwen3-TTS 系统人声。三种音色均支持中、英等主要语种。
export const QWEN_TTS_VOICE_MAP: Record<string, string> = {
  v1: 'Cherry',
  v2: 'Ethan',
  v3: 'Serena',
};

const MINIMAX_VOICE_MAP: Record<string, Record<string, string>> = {
  zh: { v1: 'Chinese (Mandarin)_Warm_Bestie', v2: 'Chinese (Mandarin)_Reliable_Executive', v3: 'Chinese (Mandarin)_Warm_Girl' },
  en: { v1: MINIMAX_ENGLISH_PRESETS.v1.voiceId, v2: MINIMAX_ENGLISH_PRESETS.v2.voiceId, v3: MINIMAX_ENGLISH_PRESETS.v3.voiceId },
  es: { v1: 'Spanish_SereneWoman', v2: 'Spanish_MaturePartner', v3: 'Spanish_ConfidentWoman' },
  ar: { v1: 'Arabic_CalmWoman', v2: 'Arabic_FriendlyGuy', v3: 'Arabic_CalmWoman' },
  pt: { v1: 'Portuguese_SentimentalLady', v2: 'Portuguese_Deep-VoicedGentleman', v3: 'Portuguese_ConfidentWoman' },
  id: { v1: 'Indonesian_SweetGirl', v2: 'Indonesian_ReservedYoungMan', v3: 'Indonesian_CalmWoman' },
  fr: { v1: 'French_MovieLeadFemale', v2: 'French_MaleNarrator', v3: 'French_FemaleAnchor' },
  de: { v1: 'German_SweetLady', v2: 'German_FriendlyMan', v3: 'German_SweetLady' },
};

export const SAY_LANGUAGE_VOICE_MAP: Record<string, Record<string, string[]>> = {
  ja: { v1: ['Kyoko'], v2: ['Reed (日语（日本）)'], v3: ['Kyoko'] },
  zh: {
    // Use the exact macOS identifiers; old hyphenated names silently fell back to Cantonese.
    v1: ['Tingting', 'Sandy (中文（中国大陆）)', 'Meijia', 'Sinji'],
    v2: ['Reed (中文（中国大陆）)', 'Tingting', 'Sinji'],
    v3: ['Sandy (中文（中国大陆）)', 'Tingting', 'Meijia', 'Sinji'],
  },
  en: { v1: ['Samantha', 'Karen', 'Moira'], v2: ['Daniel', 'Alex', 'Fred'], v3: ['Karen', 'Samantha', 'Moira'] },
  es: { v1: ['Monica', 'Paulina'], v2: ['Jorge', 'Juan', 'Diego'], v3: ['Paulina', 'Monica'] },
  ar: { v1: ['Maged'], v2: ['Maged'], v3: ['Maged'] },
  pt: { v1: ['Luciana', 'Joana'], v2: ['Felipe'], v3: ['Joana', 'Luciana'] },
  id: { v1: ['Damayanti'], v2: ['Damayanti'], v3: ['Damayanti'] },
  fr: { v1: ['Amelie', 'Thomas'], v2: ['Thomas'], v3: ['Amelie'] },
  de: { v1: ['Anna', 'Markus'], v2: ['Markus'], v3: ['Anna'] },
};

export function normalizeTtsLanguage(value: unknown): string {
  return normalizeVideoLanguage(value || 'zh');
}

export function minimaxLanguageBoost(language: string): string {
  const code = normalizeTtsLanguage(language);
  const map: Record<string, string> = {
    zh: 'Chinese', en: 'English', es: 'Spanish', ar: 'Arabic', pt: 'Portuguese',
    id: 'Indonesian', fr: 'French', de: 'German',
  };
  return map[code] || 'auto';
}

export function minimaxVoiceFor(voice: string, language: string, env: NodeJS.ProcessEnv = process.env): string {
  const lang = normalizeTtsLanguage(language);
  const envCode = lang.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const voiceCode = String(voice || 'v1').toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return env[`MINIMAX_VOICE_${envCode}_${voiceCode}`]
    || env[`MINIMAX_VOICE_${voiceCode}`]
    || MINIMAX_VOICE_MAP[lang]?.[voice]
    || MINIMAX_VOICE_MAP.en?.[voice]
    || MINIMAX_ENGLISH_PRESETS.v1.voiceId;
}
