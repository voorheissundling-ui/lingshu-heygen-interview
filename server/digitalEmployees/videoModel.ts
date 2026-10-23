import { callLLM, type LLMCallOptions } from '../agents/llm.js';
/** Qwen is the production script model; provider failures never switch to Gemini. */
export async function callVideoModel(prompt: string, options: LLMCallOptions = {}): Promise<{ text: string; backend: 'qwen'; fallbackReason: string }> {
  return { text: await callLLM(prompt, { ...options, backend: 'qwen', model: undefined }), backend: 'qwen', fallbackReason: '' };
}
