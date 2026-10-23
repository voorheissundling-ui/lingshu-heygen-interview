import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import OpenAI from 'openai';
import {
  authorizeExactQwenProviderRequest,
  exactQwenScope,
  recordExactQwenProviderResponse,
} from './exactQwenScope.js';
import { qwenCompatibleBaseUrl } from '../lib/qwenCompatibleEndpoint.js';

export const qwenAsrBaseUrl = (env: NodeJS.ProcessEnv = process.env) =>
  String(env.QWEN_ASR_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').trim();

export function dashscopeApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const envKey = env.DASHSCOPE_API_KEY?.trim();
  if (envKey) return envKey;
  const keyFile = (env.DASHSCOPE_API_KEY_FILE || path.join(os.homedir(), '.config/lingshu/dashscope.key')).trim();
  try {
    const fileKey = fs.readFileSync(keyFile, 'utf8').trim();
    if (fileKey) return fileKey;
  } catch { /* optional local secret file */ }
  throw new Error('DASHSCOPE_API_KEY is not set');
}

export function getQwenProviderBinding(input: {
  materialModel: string;
  imageModel: string;
  env?: NodeJS.ProcessEnv;
}) {
  const env = input.env ?? process.env;
  return {
    baseUrl: qwenCompatibleBaseUrl(env),
    credentialSha256: createHash('sha256').update(dashscopeApiKey(env)).digest('hex'),
    materialModel: input.materialModel,
    imageModel: input.imageModel,
  };
}

export function getQwenAsrProviderBinding(env: NodeJS.ProcessEnv = process.env) {
  return {
    baseUrl: qwenAsrBaseUrl(env),
    credentialSha256: createHash('sha256').update(dashscopeApiKey(env)).digest('hex'),
  };
}

export function createQwenClient(baseURL = qwenCompatibleBaseUrl()): OpenAI {
  const apiKey = dashscopeApiKey();
  const scoped = exactQwenScope();
  const digest = createHash('sha256').update(apiKey).digest('hex');
  if (scoped && (scoped.endpoint !== baseURL || scoped.credentialDigest !== digest)) {
    throw Error('weekly_candidate_model_provider_binding_changed');
  }
  return new OpenAI({
    apiKey,
    baseURL,
    ...(scoped ? { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, { ...init, redirect: 'error' });
      const body = await request.clone().text();
      await authorizeExactQwenProviderRequest(body);
      const response = await fetch(request);
      await recordExactQwenProviderResponse(response, body);
      return response;
    } } : {}),
    timeout: Math.max(30_000, Number(process.env.QWEN_REQUEST_TIMEOUT_MS || 120_000)),
    maxRetries: scoped ? 0 : Math.max(0, Math.min(2, Number(process.env.QWEN_MAX_RETRIES || 0))),
  });
}
