import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import {qwenCompatibleBaseUrl} from '../lib/qwenCompatibleEndpoint.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLinkedAbort } from '../lib/abort.js';
import { AbortableSemaphore } from '../lib/abortableSemaphore.js';

export type LLMBackend = 'gemini' | 'qwen' | 'claude';

export interface LLMCallOptions {
  backend?: LLMBackend;
  model?: string;
  systemPrompt?: string;
  deepThinking?: boolean;
  requireSources?: boolean;
  /** Cancels the upstream provider request when the HTTP caller disconnects. */
  signal?: AbortSignal;
  /** Hard per-provider deadline. Defaults to LLM_REQUEST_TIMEOUT_MS or 90s. */
  timeoutMs?: number;
}

function resolveBackend(opts: LLMCallOptions): LLMBackend {
  return opts.backend ?? (process.env.OVERSEAS_LLM_BACKEND as LLMBackend) ?? 'qwen';
}

const configuredConcurrency = Number(process.env.LLM_MAX_CONCURRENT_REQUESTS || 6);
const llmSemaphore = new AbortableSemaphore(
  Number.isFinite(configuredConcurrency) ? Math.max(1, Math.min(32, Math.floor(configuredConcurrency))) : 6,
);

async function callGemini(prompt: string, opts: LLMCallOptions): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const ai = new GoogleGenAI({ apiKey });
  const model = opts.model ?? process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';

  const response = await ai.models.generateContent({
    model,
    contents: prompt,
    config: {
      ...(opts.systemPrompt ? { systemInstruction: { parts: [{ text: opts.systemPrompt }] } } : {}),
      ...(opts.signal ? { abortSignal: opts.signal } : {}),
      ...(opts.timeoutMs ? { httpOptions: { timeout: opts.timeoutMs } } : {}),
    },
  });
  return response.text ?? '';
}

async function callQwen(prompt: string, opts: LLMCallOptions): Promise<string> {
  const completion = await completeQwenMessages([
    ...(opts.systemPrompt ? [{ role: 'system' as const, content: opts.systemPrompt }] : []),
    { role: 'user' as const, content: prompt },
  ], opts);
  return completion;
}

export async function callLLM(prompt: string, opts: LLMCallOptions = {}): Promise<string> {
  const backend = resolveBackend(opts);
  const configuredTimeout = Number(opts.timeoutMs ?? process.env.LLM_REQUEST_TIMEOUT_MS ?? 90_000);
  const timeoutMs = Number.isFinite(configuredTimeout)
    ? Math.max(1_000, Math.min(10 * 60_000, configuredTimeout))
    : 90_000;
  const deadline = createLinkedAbort({ timeoutMs, parentSignal: opts.signal, label: `${backend} LLM request` });
  const callOpts = { ...opts, signal: deadline.signal, timeoutMs };
  let release: (() => void) | undefined;
  try {
    release = await llmSemaphore.acquire(deadline.signal);
    switch (backend) {
      case 'gemini': return await callGemini(prompt, callOpts);
      case 'qwen':   return await callQwen(prompt, callOpts);
      default:       throw new Error(`Unsupported backend: ${backend}`);
    }
  } catch (error) {
    if (deadline.timedOut) throw new Error(`${backend} LLM request timed out after ${Math.round(timeoutMs / 1000)}s`);
    if (opts.signal?.aborted) {
      const reason = opts.signal.reason;
      throw reason instanceof Error ? reason : new Error(`${backend} LLM request cancelled`);
    }
    throw error;
  } finally {
    release?.();
    deadline.cleanup();
  }
}

export type ChatMessage = { role: 'user' | 'assistant'; content: string };

// 流式事件：文本块 或 联网引用来源
export interface GroundingSource { title: string; uri: string }
export type StreamEvent = { text: string } | { sources: GroundingSource[] };

async function* streamGeminiChat(messages: ChatMessage[], opts: LLMCallOptions): AsyncGenerator<StreamEvent> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const ai = new GoogleGenAI({ apiKey });
  const modelId = opts.model ?? process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';

  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const baseConfig: Record<string, unknown> = {
    // 默认低延迟；用户打开深度思考时给中等预算，避免明显拖慢首字。
    thinkingConfig: { thinkingBudget: opts.deepThinking ? 768 : 0 },
    maxOutputTokens: opts.deepThinking ? 8192 : 4096,
    ...(opts.systemPrompt ? { systemInstruction: { parts: [{ text: opts.systemPrompt }] } } : {}),
  };

  // 记录最后一个 chunk 的收尾原因：MAX_TOKENS 等异常收尾不会抛错，只能靠它识别静默截断
  let finishReason: string | undefined;
  const sources: GroundingSource[] = [];
  const seenSources = new Set<string>();

  // 单次尝试：withSearch 时挂联网检索（可引用真实来源），否则纯生成（更稳）
  async function* attempt(withSearch: boolean, model = modelId): AsyncGenerator<StreamEvent> {
    const stream = await ai.models.generateContentStream({
      model,
      contents,
      config: withSearch ? { ...baseConfig, tools: [{ googleSearch: {} }] } : baseConfig,
    });
    for await (const chunk of stream) {
      const text = chunk.text;
      if (text) yield { text };
      const candidate = (chunk as any).candidates?.[0];
      finishReason = candidate?.finishReason ?? finishReason;
      const gm = candidate?.groundingMetadata;
      for (const g of gm?.groundingChunks ?? []) {
        const uri = g?.web?.uri;
        if (uri && !seenSources.has(uri)) { seenSources.add(uri); sources.push({ title: g.web.title ?? uri, uri }); }
      }
    }
    if (sources.length) yield { sources: sources.slice(0, 6) };
  }

  // 断流续写：把已吐出的半截回复作为 model 轮塞回去，让模型无联网从断点接着写。
  async function* continueFrom(partial: string): AsyncGenerator<StreamEvent> {
    const stream = await ai.models.generateContentStream({
      model: modelId,
      contents: [
        ...contents,
        { role: 'model', parts: [{ text: partial }] },
        { role: 'user', parts: [{ text: '你上一条回复在中途被截断了。请紧接着已输出的内容继续写完剩余部分：不要重复已写过的内容，不要重新开头或自我介绍，直接从断点续写。' }] },
      ],
      config: baseConfig,
    });
    for await (const chunk of stream) {
      const text = chunk.text;
      if (text) yield { text };
      finishReason = (chunk as any).candidates?.[0]?.finishReason ?? finishReason;
    }
  }

  // 联网流偶发中途断流（terminated）。几乎没吐就无联网整体重试一次（很稳）；
  // 已吐出较多内容时不丢弃，改为带上下文续写补全剩余部分。
  let emittedText = '';
  try {
    for await (const ev of attempt(true)) {
      if ('text' in ev) emittedText += ev.text;
      yield ev;
    }
  } catch (err) {
    if (emittedText.length < 20) {
      if (opts.requireSources) throw err;
      // 整体重试是从头生成，前面吐出的零星几个字不再算进续写上下文
      try {
        emittedText = '';
        for await (const ev of attempt(false)) {
          if ('text' in ev) emittedText += ev.text;
          yield ev;
        }
      } catch (fallbackErr) {
        const raw = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        if (/RESOURCE_EXHAUSTED|Too Many Requests|429|quota/i.test(raw) && modelId !== 'gemini-2.5-flash-lite') {
          emittedText = '';
          for await (const ev of attempt(false, 'gemini-2.5-flash-lite')) {
            if ('text' in ev) emittedText += ev.text;
            yield ev;
          }
        } else {
          throw fallbackErr;
        }
      }
    } else {
      // 续写请求本身也可能被偶发 terminated 打断，失败后再试一次
      let continued = false;
      for (let i = 0; i < 2 && !continued; i++) {
        try {
          for await (const ev of continueFrom(emittedText)) {
            if ('text' in ev) emittedText += ev.text;
            yield ev;
          }
          continued = true;
        } catch { /* retry */ }
      }
      if (!continued) {
        const raw = err instanceof Error ? err.message : String(err);
        yield { text: `\n\n（联网检索中断：${raw.slice(0, 120)}）` };
      }
    }
  }

  // MAX_TOKENS 是正常收尾而非异常，上面的 catch 接不住；从断点自动续写，最多补两轮
  for (let i = 0; i < 2 && finishReason === 'MAX_TOKENS' && emittedText; i++) {
    finishReason = undefined;
    try {
      for await (const ev of continueFrom(emittedText)) {
        if ('text' in ev) emittedText += ev.text;
        yield ev;
      }
    } catch {
      break;
    }
  }
  if (finishReason === 'MAX_TOKENS') {
    yield { text: '\n\n（内容较长已达单次输出上限，回复「继续」可接着写）' };
  } else if (finishReason && finishReason !== 'STOP') {
    yield { text: `\n\n（回复被模型策略提前结束：${finishReason}）` };
  }
  if (opts.requireSources && sources.length === 0) {
    yield { text: '\n\n（本次问题需要联网来源，但模型没有返回可跳转来源；请重试或把问题限定到更具体的市场/平台/时间范围。）' };
  }
}

async function* streamQwenChat(messages: ChatMessage[], opts: LLMCallOptions): AsyncGenerator<StreamEvent> {
  const msgs = buildQwenMessages(messages, opts);
  let emittedText = '';

  try {
    for await (const ev of streamQwenMessages(msgs, opts)) {
      if ('text' in ev) emittedText += ev.text;
      yield ev;
    }
    return;
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    const fallbackMessages: OpenAI.Chat.ChatCompletionMessageParam[] = emittedText
      ? [
          ...msgs,
          { role: 'assistant', content: emittedText },
          {
            role: 'user',
            content: '你上一条回复在中途被截断了。请紧接着已输出的内容继续写完剩余部分：不要重复已写过的内容，不要重新开头或自我介绍，直接从断点续写。',
          },
        ]
      : msgs;
    try {
      const text = await completeQwenMessages(fallbackMessages, opts);
      if (text) yield { text };
      return;
    } catch {
      throw err;
    }
  }
}

function createQwenClient(): OpenAI {
  // Keep the text-generation client consistent with the Qwen video/ASR client:
  // local development stores the key in a protected file instead of .env.
  const keyFile = (process.env.DASHSCOPE_API_KEY_FILE
    || path.join(os.homedir(), '.config/lingshu/dashscope.key')).trim();
  let fileKey = '';
  try { fileKey = fs.readFileSync(keyFile, 'utf8').trim(); } catch { /* optional local secret file */ }
  const apiKey = process.env.DASHSCOPE_API_KEY?.trim() || fileKey;
  if (!apiKey) throw new Error('DASHSCOPE_API_KEY is not set');

  return new OpenAI({
    apiKey,
    baseURL: qwenCompatibleBaseUrl(),
    timeout: Math.max(1_000, Number(process.env.QWEN_TEXT_REQUEST_TIMEOUT_MS || process.env.LLM_REQUEST_TIMEOUT_MS || 90_000)),
    // Retrying at this layer hides latency from callers. Routes decide whether
    // and when to fall back to another provider within their own total budget.
    maxRetries: 0,
  });
}

function buildQwenMessages(messages: ChatMessage[], opts: LLMCallOptions): OpenAI.Chat.ChatCompletionMessageParam[] {
  const msgs: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (opts.systemPrompt) msgs.push({ role: 'system', content: opts.systemPrompt });
  msgs.push(...messages.map(m => ({ role: m.role, content: m.content }) as OpenAI.Chat.ChatCompletionMessageParam));
  return msgs;
}

async function* streamQwenMessages(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  opts: LLMCallOptions,
): AsyncGenerator<StreamEvent> {
  const client = createQwenClient();
  const request = {
    model: opts.model ?? process.env.QWEN_TEXT_MODEL ?? 'qwen-plus',
    messages,
    stream: true as const,
    max_tokens: opts.deepThinking ? 8192 : 4096,
    ...(opts.requireSources ? {
      enable_search: true,
      search_options: { forced_search: true, search_strategy: 'turbo' },
    } : {}),
  };
  // DashScope's Node-compatible endpoint accepts web-search fields at the top level.
  const stream = await client.chat.completions.create(request as OpenAI.Chat.ChatCompletionCreateParamsStreaming, {
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
  });
  let finishReason: string | null = null;
  let hasText = false;
  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content;
    if (text?.trim()) hasText = true;
    if (text) yield { text };
    finishReason = chunk.choices[0]?.finish_reason ?? finishReason;
  }
  // Let the caller's existing continuation path finish answers cut at the token limit.
  if (finishReason === 'length') throw new Error('QWEN_MAX_TOKENS');
  if (finishReason !== 'stop') throw new Error('模型回答未完整结束，请重试。');
  if (!hasText) throw new Error('模型回答为空，请重试。');
}

async function completeQwenMessages(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  opts: LLMCallOptions,
): Promise<string> {
  const client = createQwenClient();
  const request = {
    model: opts.model ?? process.env.QWEN_TEXT_MODEL ?? 'qwen-plus',
    messages,
    max_tokens: opts.deepThinking ? 8192 : 4096,
    ...(opts.requireSources ? {
      enable_search: true,
      search_options: { forced_search: true, search_strategy: 'turbo' },
    } : {}),
  };
  const completion = await client.chat.completions.create(request as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming, {
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
  });
  if (completion.choices[0]?.finish_reason !== 'stop') throw new Error('模型续写未完整结束，请重试。');
  const text = completion.choices[0]?.message?.content;
  if (!text?.trim()) throw new Error('模型续写为空，请重试。');
  return text;
}

export async function* callLLMChatStream(messages: ChatMessage[], opts: LLMCallOptions = {}): AsyncGenerator<StreamEvent> {
  const backend = resolveBackend(opts);
  switch (backend) {
    case 'gemini': yield* streamGeminiChat(messages, opts); break;
    case 'qwen':   yield* streamQwenChat(messages, opts); break;
    default:       throw new Error(`Unsupported backend: ${backend}`);
  }
}
