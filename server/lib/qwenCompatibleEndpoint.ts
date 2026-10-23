/** Default for Qwen OpenAI-compatible text, vision and image APIs.
 * Native DashScope APIs (Wan, file transcription and TTS) intentionally do
 * not use this value. */
export const QWEN_COMPATIBLE_BASE_URL = 'https://maas.qianwenaiapi.com/compatible-mode/v1';

export type QwenCompatibleEndpointKind = 'qianwen-maas' | 'dashscope-legacy' | 'other';

export function classifyQwenCompatibleEndpoint(value: string): QwenCompatibleEndpointKind {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || url.pathname.replace(/\/+$/, '') !== '/compatible-mode/v1') return 'other';
    if (url.hostname === 'maas.qianwenaiapi.com') return 'qianwen-maas';
    if (url.hostname === 'dashscope.aliyuncs.com') return 'dashscope-legacy';
  } catch { /* invalid overrides remain caller-visible as other */ }
  return 'other';
}

export function qwenCompatibleBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.DASHSCOPE_BASE_URL || QWEN_COMPATIBLE_BASE_URL).trim();
}
