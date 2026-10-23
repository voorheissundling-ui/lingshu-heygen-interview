import { randomUUID } from 'node:crypto';

export interface VolcengineVoiceCloneResult {
  speakerId: string;
  status: 'processing';
}

const languageCode = (language: string) => ({
  'zh-CN': 0,
  'en-US': 1,
  'ja-JP': 2,
  'es-ES': 3,
  'id-ID': 4,
  'pt-BR': 5,
  'de-DE': 6,
  'fr-FR': 7,
}[language] ?? 0);

/**
 * Doubao Voice is a separate entitlement from Ark/Seedance. Keep this client
 * explicitly optional so an Ark video key is never mistaken for voice-clone
 * authorization.
 */
export async function cloneVolcengineVoice(input: {
  apiKey: string;
  speakerId: string;
  audio: Buffer;
  language: string;
  requestId?: string;
  transport?: typeof fetch;
}): Promise<VolcengineVoiceCloneResult> {
  if (!input.apiKey.trim()) throw new Error('豆包语音复刻 API Key 未配置');
  if (!/^[A-Za-z][A-Za-z0-9_-]{7,255}$/.test(input.speakerId)) throw new Error('豆包音色标识无效');
  if (!input.audio.length || input.audio.length > 10 * 1024 * 1024) throw new Error('豆包声音复刻录音需在 10MB 以内');
  const response = await (input.transport || fetch)('https://openspeech.bytedance.com/api/v3/tts/voice_clone', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': input.apiKey,
      'X-Api-Request-Id': input.requestId || randomUUID(),
    },
    body: JSON.stringify({
      speaker_id: 'custom_speaker_id',
      custom_speaker_id: input.speakerId,
      audio: { data: input.audio.toString('base64'), format: 'mp3' },
      language: languageCode(input.language),
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const result = await response.json().catch(() => ({})) as { code?: number; message?: string };
  if (!response.ok || result.code && ![0, 20000000].includes(result.code)) {
    throw new Error(`豆包声音复刻未受理 (${response.status})：${String(result.message || '请检查语音服务权限').slice(0, 160)}`);
  }
  return { speakerId: input.speakerId, status: 'processing' };
}
