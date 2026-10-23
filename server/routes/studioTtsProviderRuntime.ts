import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'node:crypto';
import { submitStudioVoicePaidRequest, rethrowStudioVoicePaidBoundary } from '../lib/studioVoicePaidOperation.js';
import { parseMiniMaxSubtitleTiming } from '../lib/minimaxSubtitleTiming.js';
import { credentialFingerprint, DurableCredentialQuarantine } from '../lib/providerCredentialQuarantine.js';
import { wavDurationFromBytes } from '../lib/wavDuration.js';
import {
  minimaxLanguageBoost, minimaxPronunciationDict, minimaxSpeechText, minimaxVoiceModify,
  normalizeTtsLanguage, QWEN_TTS_VOICE_MAP, type TtsStyleOptions,
} from './studioTtsStyle.js';

interface AlignedWord { text: string; start: number; end: number }
export interface AlignedCue { text: string; start: number; end: number; words?: AlignedWord[] }

interface TtsProviderPorts {
  voiceSamplesRoot: string;
  ttsRoot: string;
  scopedStudioAssetDir: (root: string) => string;
  scopedStudioAssetUrl: (prefix: string, file: string) => string;
  runFfmpeg: (args: string[]) => Promise<boolean>;
}

/** Owns provider adapters and cache; paid requests still use the existing voice admission. */
export function createStudioTtsProviderRuntime(ports: TtsProviderPorts) {
  const {
    voiceSamplesRoot: VOICE_SAMPLES_ROOT, ttsRoot: TTS_ROOT,
    scopedStudioAssetDir, scopedStudioAssetUrl, runFfmpeg,
  } = ports;

interface StoredVoiceSample { voiceId: string; name: string; file: string; duration: number; createdAt: string }
function voiceSampleIndexFile(): string { return path.join(scopedStudioAssetDir(VOICE_SAMPLES_ROOT), 'voice-samples.json'); }
function readVoiceSampleIndex(): StoredVoiceSample[] {
  try { return JSON.parse(fs.readFileSync(voiceSampleIndexFile(), 'utf8')) as StoredVoiceSample[]; } catch { return []; }
}
function writeVoiceSampleIndex(items: StoredVoiceSample[]): void {
  fs.mkdirSync(scopedStudioAssetDir(VOICE_SAMPLES_ROOT), { recursive: true });
  fs.writeFileSync(voiceSampleIndexFile(), JSON.stringify(items, null, 2), 'utf8');
}
function minimaxVoiceCacheFile(): string {
  return path.join(scopedStudioAssetDir(VOICE_SAMPLES_ROOT), 'minimax-voice-cache.json');
}
function minimaxCredentialQuarantineFile(): string {
  return path.join(scopedStudioAssetDir(VOICE_SAMPLES_ROOT), 'minimax-credential-quarantine.json');
}

function minimaxEndpoint(pathname: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = (env.MINIMAX_BASE_URL || 'https://api.minimax.io').replace(/\/+$/, '');
  const url = new URL(`${base}${pathname.startsWith('/') ? pathname : `/${pathname}`}`);
  const groupId = process.env.MINIMAX_GROUP_ID || env.MINIMAX_GROUPID || '';
  if (groupId) url.searchParams.set(env.MINIMAX_GROUP_ID_PARAM || 'GroupId', groupId);
  return url.toString();
}

interface MinimaxVoiceCacheEntry {
  voiceId: string;
  clonedAt: string;
  activatedAt?: string;
  lastSynthesizedAt?: string;
  lastActivationAttemptAt?: string;
  activationState: 'pending' | 'activated';
  lastError?: string;
}

function readMinimaxVoiceCache(): Record<string, MinimaxVoiceCacheEntry> {
  try {
    const raw = JSON.parse(fs.readFileSync(minimaxVoiceCacheFile(), 'utf8')) as Record<string, string | MinimaxVoiceCacheEntry>;
    return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, typeof value === 'string'
      ? { voiceId: value, clonedAt: '', activationState: 'pending' as const }
      : value]));
  } catch {
    return {};
  }
}

function writeMinimaxVoiceCache(cache: Record<string, MinimaxVoiceCacheEntry>) {
  try {
    fs.mkdirSync(scopedStudioAssetDir(VOICE_SAMPLES_ROOT), { recursive: true });
    fs.writeFileSync(minimaxVoiceCacheFile(), JSON.stringify(cache, null, 2), 'utf8');
  } catch {
    // Cache is only an optimization. If it cannot be written, synthesis can still proceed.
  }
}

function minimaxVoiceCacheKey(voice: string, samplePath: string): string {
  const stat = fs.statSync(samplePath);
  return `${voice}:${stat.mtimeMs}:${stat.size}`;
}

function updateMinimaxVoiceCache(cacheKey: string, patch: Partial<MinimaxVoiceCacheEntry>) {
  const cache = readMinimaxVoiceCache();
  const current = cache[cacheKey];
  if (!current) return;
  cache[cacheKey] = { ...current, ...patch };
  writeMinimaxVoiceCache(cache);
}

function clearMinimaxVoiceCache(cacheKey: string) {
  const cache = readMinimaxVoiceCache();
  if (!cache[cacheKey]) return;
  delete cache[cacheKey];
  writeMinimaxVoiceCache(cache);
}

function minimaxCustomVoiceId(voice: string): string {
  const id = String(voice || '').replace(/^custom:/, '').replace(/[^a-zA-Z0-9_-]/g, '');
  const normalized = `lingshu_${id}`.replace(/[-_]+$/g, '');
  return normalized.length >= 8 ? normalized.slice(0, 120) : `lingshu_${randomUUID().replace(/-/g, '')}`;
}

function bufferFromMinimaxAudio(audio: string, outputFormat: string): Buffer | null {
  const raw = String(audio || '').trim();
  if (!raw) return null;
  if (outputFormat === 'url' || /^https?:\/\//i.test(raw)) return null;
  if (/^[0-9a-f]+$/i.test(raw) && raw.length % 2 === 0) return Buffer.from(raw, 'hex');
  try {
    return Buffer.from(raw.replace(/^data:audio\/[^;]+;base64,/, ''), 'base64');
  } catch {
    return null;
  }
}

function voiceSamplePathFromId(voice: string): string | null {
  const id = String(voice || '').replace(/^custom:/, '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!id) return null;
  try {
    const files = fs.readdirSync(scopedStudioAssetDir(VOICE_SAMPLES_ROOT));
    const found = files.find(file => file.startsWith(`${id}.`));
    return found ? path.join(scopedStudioAssetDir(VOICE_SAMPLES_ROOT), found) : null;
  } catch {
    return null;
  }
}

function isNonSpeechSfxText(text: string): boolean {
  const normalized = String(text || '')
    .replace(/[\s"'“”‘’.,，。!！?？~～…·:：;；-]/g, '')
    .trim()
    .toLowerCase();
  if (!normalized) return true;
  if (/^(噗|噗噗|砰|砰砰|咚|咚咚|哒|哒哒|啪|啪啪|嗒|嗒嗒|咔|咔哒|咔嚓|咯吱|嘎吱|吱呀|叮|叮咚|嘀|滴滴|唰|嗖|嗡|嗡嗡|轰|轰隆|沙沙|刷刷)$/i.test(normalized)) return true;
  if (/^(whoosh|swoosh|pop|popop|bang|boom|ding|beep|click|clack|creak|crack|snap|buzz|whirr|rustle)$/i.test(normalized)) return true;
  if (normalized.length <= 4 && /^([\u54c8\u563f\u5566\u5662\u7830\u549a\u53ee\u6ef4\u54d2\u55d2\u556a\u54d7\u55d2\u5530\u55e1\u5431\u5494\u55d2])\1+$/.test(normalized)) return true;
  return false;
}

/** 从脚本里提取可朗读的口语文本（去掉 [Hook]、Scene、Shot/Camera/Visual 等标注） */
function spokenText(script: string): string {
  const out: string[] = [];
  for (let line of String(script || '').split('\n')) {
    line = line.trim();
    if (!line) continue;
    if (/^\[.*\]$/.test(line)) continue;
    line = line.replace(/^\[[^\]]*?\d+(?:\.\d+)?\s*(?:s|秒)?\s*[-–]\s*\d+(?:\.\d+)?\s*(?:s|秒)?[^\]]*\]\s*/i, '').trim();
    if (!line) continue;
    if (/^scene\s*\d/i.test(line)) continue;
    const vo = line.match(/^(voiceover|vo|台词|人物说|口播)\s*[:：]\s*(.+)$/i);
    if (vo) {
      if (!isNonSpeechSfxText(vo[2])) out.push(vo[2]);
      continue;
    }
    if (/^(shot|camera|visual|music|environment|subtitle|caption|画面|镜头|运镜|景别|环境|配乐|字幕)\s*[:：]/i.test(line)) continue;
    if (!/[：:]/.test(line) && !isNonSpeechSfxText(line)) out.push(line);
  }
  return out.join(' ').slice(0, 1500);
}

/** PCM(16-bit LE) → WAV 容器 */
function wavFromPcm(pcm: Buffer, sampleRate: number, channels = 1, bits = 16): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * bits / 8, 28);
  header.writeUInt16LE(channels * bits / 8, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function minimaxFetchJson(pathname: string, body: Record<string, unknown>, timeoutMs = 90_000): Promise<any> {
  const apiKey = process.env.MINIMAX_API_KEY || process.env.MINIMAX_API_TOKEN || '';
  if (!apiKey) throw new Error('MINIMAX_API_KEY not set');
  const send = async () => {
  const response = await fetch(minimaxEndpoint(pathname), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`MiniMax HTTP ${response.status}: ${JSON.stringify(json).slice(0, 240)}`);
  const statusCode = Number(json?.base_resp?.status_code ?? 0);
  if (statusCode !== 0) {
    throw new Error(`MiniMax ${statusCode}: ${String(json?.base_resp?.status_msg || 'request failed')}`);
  }
  forgetRejectedMinimaxCredential();
  return json;
  };
  if (pathname === '/v1/t2a_v2' || pathname === '/v1/voice_clone') return submitStudioVoicePaidRequest({stage:pathname === '/v1/voice_clone'?'voice_clone':'tts',provider:'minimax',endpoint:minimaxEndpoint(pathname),accountKeyHash:createHash('sha256').update(apiKey).digest('hex'),model:String(body.model||''),voiceId:String((body.voice_setting as any)?.voice_id || body.voice_id || ''),request:body},send);
  return send();
}

async function minimaxSubtitleCues(url: unknown, duration: number): Promise<AlignedCue[]> {
  if (!/^https?:\/\//i.test(String(url || ''))) return [];
  try {
    const response = await fetch(String(url), { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return [];
    const json = await response.json().catch(() => null) as any;
    return parseMiniMaxSubtitleTiming(json, duration);
  } catch {
    return [];
  }
}

async function generateMinimaxTts(text: string, voiceId: string, language: string, style: TtsStyleOptions = {}): Promise<{ url: string; duration: number; source: string; cues?: AlignedCue[]; alignmentSource?: 'minimax_native' } | null> {
  const apiKey = process.env.MINIMAX_API_KEY || process.env.MINIMAX_API_TOKEN || '';
  if (!apiKey) return null;
  try { fs.mkdirSync(scopedStudioAssetDir(TTS_ROOT), { recursive: true }); } catch { /* ignore */ }
  const format = (process.env.MINIMAX_TTS_FORMAT || 'mp3').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'mp3';
  const outputFormat = (process.env.MINIMAX_TTS_OUTPUT_FORMAT || 'hex').toLowerCase();
  const sampleRate = Math.min(44100, Math.max(16000, Number(process.env.MINIMAX_TTS_SAMPLE_RATE || 32000) || 32000));
  const bitrate = Math.min(256000, Math.max(32000, Number(process.env.MINIMAX_TTS_BITRATE || 128000) || 128000));
  const speed = Math.min(2, Math.max(0.5, Number(style.speed ?? process.env.MINIMAX_TTS_SPEED ?? 1) || 1));
  const volume = Math.min(10, Math.max(0.1, Number(process.env.MINIMAX_TTS_VOLUME || 1) || 1));
  const pitch = Math.min(12, Math.max(-12, Number(process.env.MINIMAX_TTS_PITCH || 0) || 0));
  const model = process.env.MINIMAX_TTS_MODEL || 'speech-2.8-hd';
  const spokenText = minimaxSpeechText(text, style);
  const payload: Record<string, unknown> = {
    model,
    text: spokenText.slice(0, 5000),
    stream: false,
    language_boost: minimaxLanguageBoost(language),
    output_format: outputFormat,
    voice_setting: {
      voice_id: voiceId,
      speed,
      vol: volume,
      pitch,
    },
    voice_modify: minimaxVoiceModify(style),
    audio_setting: {
      sample_rate: sampleRate,
      bitrate,
      format,
      channel: 1,
    },
    ...(minimaxPronunciationDict(style) ? { pronunciation_dict: minimaxPronunciationDict(style) } : {}),
    subtitle_enable: true,
    subtitle_type: 'word',
  };
  const json = await minimaxFetchJson('/v1/t2a_v2', payload, Number(process.env.MINIMAX_TTS_TIMEOUT_MS || 90_000));
  const audio = String(json?.data?.audio || '');
  const remoteUrl = outputFormat === 'url' && /^https?:\/\//i.test(audio) ? audio : '';
  const measuredDuration = Number(json?.extra_info?.audio_length || 0) / 1000;
  if (!(measuredDuration > 0)) throw new Error('MiniMax 未返回实际音频时长');
  const duration = Number(measuredDuration.toFixed(3));
  const cues = await minimaxSubtitleCues(json?.data?.subtitle_file, duration);
  if (remoteUrl) return { url: remoteUrl, duration, source: 'minimax', ...(cues.length ? { cues, alignmentSource: 'minimax_native' as const } : {}) };

  const buf = bufferFromMinimaxAudio(audio, outputFormat);
  if (!buf?.length) throw new Error('MiniMax did not return audio data');
  const file = `${randomUUID()}.${format}`;
  fs.writeFileSync(path.join(scopedStudioAssetDir(TTS_ROOT), file), buf);
  return { url: scopedStudioAssetUrl('tts', file), duration, source: 'minimax', ...(cues.length ? { cues, alignmentSource: 'minimax_native' as const } : {}) };
}

async function uploadMinimaxVoiceSample(samplePath: string): Promise<string> {
  const apiKey = process.env.MINIMAX_API_KEY || process.env.MINIMAX_API_TOKEN || '';
  if (!apiKey) throw new Error('MINIMAX_API_KEY not set');
  const ext = path.extname(samplePath).toLowerCase();
  if (!['.mp3', '.m4a', '.wav'].includes(ext)) {
    throw new Error('MiniMax 真人音色录入仅支持 mp3/m4a/wav，请重新上传清晰录音。');
  }
  const buf = fs.readFileSync(samplePath);
  const mime = ext === '.mp3' ? 'audio/mpeg' : ext === '.m4a' ? 'audio/mp4' : 'audio/wav';
  const form = new FormData();
  form.append('purpose', 'voice_clone');
  form.append('file', new Blob([new Uint8Array(buf)], { type: mime }), path.basename(samplePath));
  const response = await fetch(minimaxEndpoint('/v1/files/upload'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(Number(process.env.MINIMAX_UPLOAD_TIMEOUT_MS || 90_000)),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`MiniMax upload HTTP ${response.status}: ${JSON.stringify(json).slice(0, 240)}`);
  const statusCode = Number(json?.base_resp?.status_code ?? 0);
  if (statusCode !== 0) throw new Error(`MiniMax upload ${statusCode}: ${String(json?.base_resp?.status_msg || 'request failed')}`);
  const fileId = String(json?.file?.file_id || '').trim();
  if (!fileId) throw new Error('MiniMax upload did not return file_id');
  return fileId;
}

async function ensureMinimaxClonedVoice(voice: string, language: string): Promise<{ voiceId: string; cacheKey: string } | null> {
  const apiKey = process.env.MINIMAX_API_KEY || process.env.MINIMAX_API_TOKEN || '';
  if (!apiKey) return null;
  const samplePath = voiceSamplePathFromId(voice);
  if (!samplePath) return null;
  const cacheKey = minimaxVoiceCacheKey(voice, samplePath);
  const cache = readMinimaxVoiceCache();
  if (cache[cacheKey]?.voiceId) {
    const existing = cache[cacheKey];
    if (existing.activationState !== 'activated') {
      const attemptedAt = Date.parse(existing.lastActivationAttemptAt || '');
      if (!Number.isFinite(attemptedAt) || Date.now() - attemptedAt > 60 * 60 * 1000) {
        updateMinimaxVoiceCache(cacheKey, { lastActivationAttemptAt: new Date().toISOString() });
        try {
          const activation = await generateMinimaxTts(
            process.env.MINIMAX_ACTIVATION_TEXT || '你好，这是我的品牌授权音色。',
            existing.voiceId,
            language,
            { preset: 'authentic_review', emotion: '自然可信', emotionIntensity: 55, speed: 1 },
          );
          if (activation) {
            const now = new Date().toISOString();
            updateMinimaxVoiceCache(cacheKey, { activationState: 'activated', activatedAt: now, lastSynthesizedAt: now, lastError: undefined });
          }
        } catch (error) {
          rethrowStudioVoicePaidBoundary(error);
          updateMinimaxVoiceCache(cacheKey, { lastError: String(error instanceof Error ? error.message : error).slice(0, 240) });
        }
      }
    }
    return { voiceId: existing.voiceId, cacheKey };
  }

  const voiceId = minimaxCustomVoiceId(voice);
  const fileId = await uploadMinimaxVoiceSample(samplePath);
  try {
    await minimaxFetchJson('/v1/voice_clone', {
      file_id: Number(fileId),
      voice_id: voiceId,
      text: process.env.MINIMAX_CLONE_PREVIEW_TEXT || '这是一段用于确认真人音色的试读音频。',
      model: process.env.MINIMAX_TTS_MODEL || 'speech-2.8-hd',
      language_boost: minimaxLanguageBoost(language),
    }, Number(process.env.MINIMAX_CLONE_TIMEOUT_MS || 120_000));
  } catch (error: any) {
    rethrowStudioVoicePaidBoundary(error);
    const message = String(error?.message || error);
    if (!/duplicate|already exists|exist|重复/i.test(message)) throw error;
  }
  cache[cacheKey] = {
    voiceId,
    clonedAt: new Date().toISOString(),
    activationState: 'pending',
  };
  writeMinimaxVoiceCache(cache);
  updateMinimaxVoiceCache(cacheKey, { lastActivationAttemptAt: new Date().toISOString() });
  try {
    const activation = await generateMinimaxTts(
      process.env.MINIMAX_ACTIVATION_TEXT || '你好，这是我的品牌授权音色。',
      voiceId,
      language,
      { preset: 'authentic_review', emotion: '自然可信', emotionIntensity: 55, speed: 1 },
    );
    if (activation) {
      const now = new Date().toISOString();
      updateMinimaxVoiceCache(cacheKey, { activationState: 'activated', activatedAt: now, lastSynthesizedAt: now, lastError: undefined });
    }
  } catch (error) {
          rethrowStudioVoicePaidBoundary(error);
    updateMinimaxVoiceCache(cacheKey, { lastError: String(error instanceof Error ? error.message : error).slice(0, 240) });
  }
  return { voiceId, cacheKey };
}

function minimaxVoiceNeedsReclone(error: unknown): boolean {
  return /voice[^\n]*(?:not found|does not exist|invalid|expired|deleted)|(?:not found|不存在|已删除|过期)[^\n]*voice|voice_id[^\n]*(?:invalid|不存在)/i.test(String(error instanceof Error ? error.message : error));
}

function qwenTtsLanguageType(language: string): string {
  const map: Record<string, string> = {
    zh: 'Chinese', en: 'English', es: 'Spanish', pt: 'Portuguese',
    fr: 'French', de: 'German', ja: 'Japanese', ko: 'Korean',
    ru: 'Russian', it: 'Italian',
  };
  return map[normalizeTtsLanguage(language)] || '';
}


function friendlyTtsProviderError(value: unknown, provider = '语音服务'): string {
  const message = String(value instanceof Error ? value.message : value || '').trim();
  if (/arrears|recharge|past due|overdue|欠费|充值/i.test(message)) {
    return `${provider}账户欠费，暂时无法生成口播。请为该 API Key 所属账户充值，或改用“上传口播”。`;
  }
  if (/quota|insufficient|balance|credit|resource_exhausted|额度|余额/i.test(message)) {
    return `${provider}额度或余额不足，暂时无法生成口播。请补充额度，或改用“上传口播”。`;
  }
  if (/401|403|unauthorized|forbidden|api.?key|permission|鉴权|权限/i.test(message)) {
    return `${provider}鉴权失败。请检查 API Key 与模型调用权限，或改用“上传口播”。`;
  }
  return message || `${provider}暂时不可用，请稍后重试或改用“上传口播”。`;
}

// A credential rejected by MiniMax cannot recover through repeated paid
// synthesis attempts. Quarantine only that exact credential fingerprint for
// this process; rotating the key changes the fingerprint and automatically
// re-enables the provider. Account balance failures are deliberately not
// cached here because a recharge must become usable without a restart.
const rejectedMinimaxCredentials = new DurableCredentialQuarantine(minimaxCredentialQuarantineFile);
function currentMinimaxCredentialHash(): string {
  const key = String(process.env.MINIMAX_API_KEY || process.env.MINIMAX_API_TOKEN || '').trim();
  return credentialFingerprint(key);
}
function minimaxCredentialRejected(value: unknown): boolean {
  const message = String(value instanceof Error ? value.message : value || '');
  return /(?:invalid|incorrect|expired|revoked)[ _-]*api[ _-]*key|MiniMax\s+2049|unauthori[sz]ed|forbidden/i.test(message);
}
function rememberRejectedMinimaxCredential(value: unknown): void {
  if (!minimaxCredentialRejected(value)) return;
  const fingerprint = currentMinimaxCredentialHash();
  rejectedMinimaxCredentials.remember(fingerprint);
}
function forgetRejectedMinimaxCredential(): void {
  rejectedMinimaxCredentials.clear(currentMinimaxCredentialHash());
}
function minimaxCredentialUsable(): boolean {
  const fingerprint = currentMinimaxCredentialHash();
  return Boolean(fingerprint) && !rejectedMinimaxCredentials.isRejected(fingerprint);
}

async function generateQwenTts(text: string, voice: string, language: string): Promise<{ url: string; duration: number; source: string } | null> {
  if (!qwenTtsLanguageType(language)) return null;
  const apiKey = String(process.env.DASHSCOPE_API_KEY || '').trim();
  if (!apiKey) return null;
  const endpoint = process.env.DASHSCOPE_TTS_ENDPOINT
    || 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
  const request = { model: process.env.QWEN_TTS_MODEL || 'qwen3-tts-flash', input: {text:text.slice(0,5000),voice:process.env[`QWEN_TTS_VOICE_${String(voice || 'v1').toUpperCase()}`] || QWEN_TTS_VOICE_MAP[voice] || 'Cherry',language_type:qwenTtsLanguageType(language)}};
  const json = await submitStudioVoicePaidRequest({stage:'tts',provider:'qwen',endpoint,accountKeyHash:createHash('sha256').update(apiKey).digest('hex'),model:request.model,voiceId:request.input.voice,request},async()=>{
    const response=await fetch(endpoint,{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(Number(process.env.QWEN_TTS_TIMEOUT_MS || 90_000))});
    const json=await response.json().catch(()=>({} as any)) as any;
    if(!response.ok || json?.code)throw Error(`Qwen TTS HTTP ${response.status}: ${String(json?.message||'request failed')}`);
    return json;
  });
  const remoteUrl = String(json?.output?.audio?.url || '').trim();
  if (!/^https?:\/\//i.test(remoteUrl)) throw new Error('Qwen TTS did not return an audio URL');
  const audioResponse = await fetch(remoteUrl, { signal: AbortSignal.timeout(Number(process.env.QWEN_TTS_DOWNLOAD_TIMEOUT_MS || 60_000)) });
  if (!audioResponse.ok) throw new Error(`Qwen TTS audio download HTTP ${audioResponse.status}`);
  const bytes = Buffer.from(await audioResponse.arrayBuffer());
  if (bytes.length < 1000) throw new Error('Qwen TTS returned empty audio');
  try { fs.mkdirSync(scopedStudioAssetDir(TTS_ROOT), { recursive: true }); } catch { /* ignore */ }
  const base = randomUUID();
  const file = `${base}.wav`;
  const wavPath = path.join(scopedStudioAssetDir(TTS_ROOT), file);
  let measuredDuration = wavDurationFromBytes(bytes);
  if (measuredDuration >= 0.5) {
    fs.writeFileSync(wavPath, bytes);
  } else {
    const contentType = String(audioResponse.headers.get('content-type') || '').toLowerCase();
    let sourceExt = '.bin';
    if (/mpeg|mp3/.test(contentType)) sourceExt = '.mp3';
    else if (/mp4|m4a/.test(contentType)) sourceExt = '.m4a';
    else if (/ogg/.test(contentType)) sourceExt = '.ogg';
    else if (/aac/.test(contentType)) sourceExt = '.aac';
    else if (/webm/.test(contentType)) sourceExt = '.webm';
    else {
      try {
        const remoteExt = path.extname(new URL(remoteUrl).pathname).toLowerCase();
        if (/^\.(mp3|m4a|mp4|ogg|aac|webm|wav)$/.test(remoteExt)) sourceExt = remoteExt;
      } catch { /* keep generic extension; ffmpeg probes the byte stream */ }
    }
    const sourcePath = path.join(scopedStudioAssetDir(TTS_ROOT), `${base}${sourceExt}`);
    fs.writeFileSync(sourcePath, bytes);
    const converted = await runFfmpeg(['-i', sourcePath, '-ar', '24000', '-ac', '1', '-y', wavPath]);
    try { fs.unlinkSync(sourcePath); } catch { /* ignore */ }
    if (!converted || !fs.existsSync(wavPath)) throw new Error('Qwen TTS returned an unsupported audio format');
    measuredDuration = wavDurationFromBytes(fs.readFileSync(wavPath));
  }
  if (measuredDuration < 0.5) {
    try { fs.unlinkSync(wavPath); } catch { /* ignore */ }
    throw new Error('Qwen TTS returned invalid audio');
  }
  return {
    url: scopedStudioAssetUrl('tts', file),
    duration: Math.max(1, Number(measuredDuration.toFixed(3))),
    source: 'qwen_tts',
  };
}

  return {
    readVoiceSampleIndex, writeVoiceSampleIndex, voiceSamplePathFromId, spokenText,
    minimaxEndpoint, minimaxFetchJson, minimaxVoiceCacheKey, readMinimaxVoiceCache,
    writeMinimaxVoiceCache, clearMinimaxVoiceCache, updateMinimaxVoiceCache,
    minimaxVoiceNeedsReclone, qwenTtsLanguageType, friendlyTtsProviderError,
    rememberRejectedMinimaxCredential, minimaxCredentialUsable,
    generateMinimaxTts, ensureMinimaxClonedVoice, generateQwenTts,
  };
}
