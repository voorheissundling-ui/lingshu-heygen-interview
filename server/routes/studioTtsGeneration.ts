import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'node:crypto';
import { synthesizeBoundHeyGenVoice } from '../lib/studioBoundHeyGenVoice.js';
import { studioVoicePaidContext, StudioVoicePaidBoundaryError, rethrowStudioVoicePaidBoundary } from '../lib/studioVoicePaidOperation.js';
import { dashscopeCredentialConfigured } from '../lib/voiceQuality.js';
import { wavDurationFromBytes } from '../lib/wavDuration.js';
import { VIDEO_LANGUAGES } from '../../shared/contracts/videoLanguages.js';
import { generateLocalSayTts, generatePiperTts, generateXttsCloneTts, type LocalTtsPorts } from './studioLocalTtsAdapters.js';
import { minimaxVoiceFor, normalizeTtsLanguage, normalizeTtsStyle, type TtsStyleOptions } from './studioTtsStyle.js';
import type { AlignedCue, createStudioTtsProviderRuntime } from './studioTtsProviderRuntime.js';

type ProviderRuntime = ReturnType<typeof createStudioTtsProviderRuntime>;

interface GenerationPorts {
  currentTenantId: () => string | undefined;
  tenantTtsDir: (tenantId: string) => string;
  scopedTtsDir: () => string;
  ttsUrl: (file: string) => string;
  localTtsPorts: LocalTtsPorts;
  providers: ProviderRuntime;
}

/** Keeps native audio cache proof and provider fallback sequencing in one boundary. */
export function createStudioTtsGeneration(ports: GenerationPorts) {
  const { currentTenantId, tenantTtsDir, scopedTtsDir, ttsUrl, localTtsPorts, providers } = ports;
  const {
    minimaxCredentialUsable, ensureMinimaxClonedVoice, generateMinimaxTts,
    minimaxVoiceNeedsReclone, clearMinimaxVoiceCache, updateMinimaxVoiceCache,
    rememberRejectedMinimaxCredential, generateQwenTts, friendlyTtsProviderError,
    qwenTtsLanguageType,
  } = providers;

type CachedTtsResult = Awaited<ReturnType<typeof generateTtsAudioUncached>>;
const inFlightTts = new Map<string,Promise<CachedTtsResult>>();
function studioNativeTtsCacheKey(tenantId:string,spoken:string,voice:string,language:string,style:TtsStyleOptions) {
  const providerPolicy = [process.env.TTS_PROVIDER_POLICY_VERSION || 'minimax-subtitle-time-v3-english-boundaries', process.env.TTS_PREFER_EXPRESSIVE_PROVIDER !== 'false', process.env.TTS_REQUIRE_MINIMAX === 'true',
    dashscopeCredentialConfigured(), Boolean((process.env.MINIMAX_API_KEY || process.env.MINIMAX_API_TOKEN || '').trim())];
  return createHash('sha256').update(JSON.stringify([tenantId,spoken,voice,language,normalizeTtsStyle(style),providerPolicy,process.env.QWEN_TTS_MODEL || 'qwen3-tts-flash',process.env.MINIMAX_TTS_MODEL || 'speech-2.8-hd',process.env[`QWEN_TTS_VOICE_${voice.toUpperCase()}`],minimaxVoiceFor(voice,language)])).digest('hex');

}
function readStudioNativeTtsCache(tenantId:string,text:string,voice:string,language:string,style:TtsStyleOptions) {
 const key=studioNativeTtsCacheKey(tenantId,text,voice,language,style),dir=tenantTtsDir(tenantId),file=path.join(dir,`sentence-${key}.json`);
 try {const cached=JSON.parse(fs.readFileSync(file,'utf8'));const audio=path.join(dir,path.basename(new URL(cached.url,'http://local').pathname));
  if(!cached.ok || !['qwen_tts','minimax','heygen'].includes(cached.source) || !fs.existsSync(audio) || !fs.realpathSync(audio).startsWith(fs.realpathSync(dir)+path.sep))return null;
  const bytes=fs.readFileSync(audio);if(bytes.length<=44)return null;
  return {cacheKey:key,provider:cached.source as string,audioSha256:createHash('sha256').update(bytes).digest('hex'),durationSeconds:Number(cached.duration),measuredWavDurationSeconds:wavDurationFromBytes(bytes),receiptVerificationRequired:true};
 } catch {return null;}
}
async function generateTtsAudio(spoken: string, voice: string, language = 'zh', style: TtsStyleOptions = {}, requireNatural = false): Promise<CachedTtsResult> {
  const tenantId = currentTenantId();
  // Custom voice lifecycle is managed by the clone registry, not a text cache.
  if (!tenantId || voice.startsWith('custom:')) return generateTtsAudioUncached(spoken,voice,language,style,requireNatural);
  const key = studioNativeTtsCacheKey(tenantId,spoken,voice,language,style);
  const dir = tenantTtsDir(tenantId);
  const cacheFile = path.join(dir,`sentence-${key}.json`);
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile,'utf8')) as CachedTtsResult;
    const file = cached.url ? path.join(dir,path.basename(new URL(cached.url,'http://local').pathname)) : '';
    if (cached.ok && ['qwen_tts','minimax','heygen'].includes(cached.source) && file && fs.existsSync(file) && fs.statSync(file).size > 44) {
      const context=studioVoicePaidContext();
      if(context && !await context.verifyCachedAudio?.({tenantId,text:spoken,logicalVoice:voice,language,provider:cached.source,audioSha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex'),durationSeconds:Number(cached.duration)})) throw new StudioVoicePaidBoundaryError('voice_existing_cache_requires_canonical_receipt_verification');
      return cached;
    }
  } catch(error) { rethrowStudioVoicePaidBoundary(error); /* missing/invalid cache is regenerated */ }
  const existing = inFlightTts.get(key); if(existing) {if(studioVoicePaidContext())throw new StudioVoicePaidBoundaryError('voice_existing_submission_requires_original_receipt');return existing;}
  const pending = generateTtsAudioUncached(spoken,voice,language,style,requireNatural).then(async result=>{
    if(result.ok && ['qwen_tts','minimax','heygen'].includes(result.source)) {
      const context=studioVoicePaidContext();
      if(context?.persistAudioCacheProof && result.url) {const audioFile=path.join(dir,path.basename(new URL(result.url,'http://local').pathname));if(fs.existsSync(audioFile)) await context.persistAudioCacheProof({tenantId,text:spoken,logicalVoice:voice,language,provider:result.source,audioSha256:createHash('sha256').update(fs.readFileSync(audioFile)).digest('hex'),durationSeconds:Number(result.duration)});}
      fs.mkdirSync(dir,{recursive:true});const tmp=cacheFile+'.tmp';fs.writeFileSync(tmp,JSON.stringify(result),{mode:0o600});fs.renameSync(tmp,cacheFile);
    }
    return result;
  }).finally(()=>inFlightTts.delete(key));
  inFlightTts.set(key,pending);return pending;
}

async function generateTtsAudioUncached(spoken: string, voice: string, language = 'zh', style: TtsStyleOptions = {}, requireNatural = false): Promise<{ ok: boolean; source: string; url?: string; duration?: number; error?: string; customVoiceStatus?: 'activated'; cues?: AlignedCue[]; alignmentSource?: 'minimax_native' }> {
  if (voice.startsWith('heygen:')) {
    const output = path.join(scopedTtsDir(), randomUUID() + '.wav');
    const result = await synthesizeBoundHeyGenVoice({ text: spoken, voiceId: voice.split(':')[1] || '', language, output });
    return { ok: true, source: 'heygen', url: ttsUrl(path.basename(output)), duration: result.duration };
  }
  if (spoken.length > 5000) return { ok: false, source: 'text_too_long', error: '口播超过 5000 字符，请拆分视频；配音不会截断正文。' };
  if (!(normalizeTtsLanguage(language) in VIDEO_LANGUAGES)) return { ok: false, source: 'unsupported_language', error: '当前不支持此配音语言，请重新选择；不会改用中文。' };
  if (String(voice || '').startsWith('custom:')) {
    let minimaxError = '';
    try {
      if (!minimaxCredentialUsable()) throw new Error('MiniMax API Key 已被官方拒绝；请更换有效 Key 后重试。');
      let clonedVoice = await ensureMinimaxClonedVoice(voice, language);
      if (clonedVoice) {
        let minimax: Awaited<ReturnType<typeof generateMinimaxTts>> = null;
        try {
          minimax = await generateMinimaxTts(spoken, clonedVoice.voiceId, language, style);
        } catch (error) {
          rethrowStudioVoicePaidBoundary(error);
          if (!minimaxVoiceNeedsReclone(error)) throw error;
          clearMinimaxVoiceCache(clonedVoice.cacheKey);
          clonedVoice = await ensureMinimaxClonedVoice(voice, language);
          if (!clonedVoice) throw error;
          minimax = await generateMinimaxTts(spoken, clonedVoice.voiceId, language, style);
        }
        if (minimax) {
          const now = new Date().toISOString();
          updateMinimaxVoiceCache(clonedVoice.cacheKey, {
            activationState: 'activated',
            activatedAt: now,
            lastSynthesizedAt: now,
            lastError: undefined,
          });
          return { ok: true, ...minimax, customVoiceStatus: 'activated' };
        }
      }
    } catch (e: any) {
      rethrowStudioVoicePaidBoundary(e);
      rememberRejectedMinimaxCredential(e);
      minimaxError = String(e?.message ?? e).slice(0, 240);
    }
    const cloned = await generateXttsCloneTts(spoken, voice, language, localTtsPorts);
    if (cloned) return { ok: true, ...cloned, error: minimaxError };
    return {
      ok: false,
      source: 'custom_voice_unavailable',
      error: minimaxError
        ? `已录入真人音色，但 MiniMax 克隆/合成失败：${minimaxError}。若要本地兜底，请配置 XTTS/Coqui（XTTS_BIN/COQUI_TTS_BIN）。`
        : '已录入真人音色，但后端未配置 MiniMax（MINIMAX_API_KEY）或 XTTS/Coqui 音色克隆引擎，无法用该音色合成。',
    };
  }
  const paidNative=studioVoicePaidContext()?.primaryProvider;
  if(paidNative) {
    const result=paidNative==='qwen' ? await generateQwenTts(spoken,voice,language) : await generateMinimaxTts(spoken,minimaxVoiceFor(voice,language),language,style);
    if(!result)throw new StudioVoicePaidBoundaryError('frozen_native_voice_provider_unavailable');
    return {ok:true,...result};
  }
  const aiErrors: string[] = [];

  const minimaxAvailable = minimaxCredentialUsable();
  const expressiveMiniMax = process.env.TTS_PREFER_EXPRESSIVE_PROVIDER !== 'false'
    && minimaxAvailable
    && Boolean(style.preset || style.emotion || style.pauseStyle || style.pronunciations?.length);
  const tryMinimax = async () => {
    const minimaxVoiceId = minimaxVoiceFor(voice, language);
    const minimax = await generateMinimaxTts(spoken, minimaxVoiceId, language, style);
    return minimax ? { ok: true as const, ...minimax } : null;
  };

  if (expressiveMiniMax) {
    try {
      const minimax = await tryMinimax();
      if (minimax) return minimax;
    } catch (e: any) {
      rethrowStudioVoicePaidBoundary(e);
      rememberRejectedMinimaxCredential(e);
      aiErrors.push(friendlyTtsProviderError(e, 'MiniMax 语音服务').slice(0, 240));
    }
  }

  if (expressiveMiniMax && process.env.TTS_REQUIRE_MINIMAX === 'true') return { ok: false, source: 'minimax', error: aiErrors.join('；') || 'MiniMax 配音暂不可用，请稍后重试。' };

  try {
    const qwen = await generateQwenTts(spoken, voice, language);
    if (qwen) return { ok: true, ...qwen };
  } catch (e: any) {
    rethrowStudioVoicePaidBoundary(e);
    aiErrors.push(friendlyTtsProviderError(e, 'DashScope 语音服务').slice(0, 240));
  }

  if (!expressiveMiniMax && minimaxAvailable) try {
    const minimax = await tryMinimax();
    if (minimax) return minimax;
  } catch (e: any) {
    rethrowStudioVoicePaidBoundary(e);
    rememberRejectedMinimaxCredential(e);
    aiErrors.push(friendlyTtsProviderError(e, 'MiniMax 语音服务').slice(0, 240));
  }

  const aiError = [...new Set(aiErrors.filter(Boolean))].join('；');
  if (requireNatural) return { ok: false, source: 'natural_voice_unavailable', error: aiError || '自然人声服务暂不可用，请配置语音服务或个人声音克隆。' };
  const piper = await generatePiperTts(spoken, language, localTtsPorts);
  if (piper) return { ok: true, ...piper, error: aiError };

  const local = await generateLocalSayTts(spoken, voice, language, localTtsPorts);
  if (local) return { ok: true, ...local, error: aiError };

  return {
    ok: false,
    source: 'tts_unavailable',
    error: aiError || '没有可用的真人语音合成服务，请检查 DashScope、MiniMax 或本地 TTS 配置。',
  };
}

function splitSubtitleText(text: string): string[] {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const sentences = normalized.match(/[^。！？!?；;,.，]+[。！？!?；;,.，]?/g)?.map(item => item.trim()).filter(Boolean) || [normalized];
  const result: string[] = [];
  for (const sentence of sentences) {
    const max = /[\u3400-\u9fff]/.test(sentence) ? 16 : 42;
    if (sentence.length <= max) { result.push(sentence); continue; }
    for (let cursor = 0; cursor < sentence.length; cursor += max) result.push(sentence.slice(cursor, cursor + max));
  }
  return result;
}

function proportionalCues(text: string, duration: number): AlignedCue[] {
  const parts = splitSubtitleText(text);
  const totalWeight = parts.reduce((sum, item) => sum + Math.max(1, item.replace(/\s/g, '').length), 0) || 1;
  let cursor = 0;
  return parts.map((item, index) => {
    const start = cursor;
    const end = index === parts.length - 1
      ? duration
      : Math.min(duration, start + duration * Math.max(1, item.replace(/\s/g, '').length) / totalWeight);
    cursor = end;
    return { text: item, start: +start.toFixed(2), end: +Math.max(start + 0.2, end).toFixed(2) };
  });
}

function localTtsFile(url?: string): { bytes: Buffer; mimeType: string; filePath: string } | null {
  if (!url || (!url.startsWith('/tts/') && !url.includes('/private-assets/tts/'))) return null;
  const filePath = path.join(scopedTtsDir(), path.basename(new URL(url, 'http://local').pathname));
  if (!fs.existsSync(filePath)) return null;
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = ext === '.mp3' ? 'audio/mpeg'
    : ext === '.m4a' || ext === '.mp4' ? 'audio/mp4'
      : ext === '.ogg' ? 'audio/ogg'
        : ext === '.webm' ? 'audio/webm'
          : ext === '.aac' ? 'audio/aac'
            : 'audio/wav';
  return { bytes: fs.readFileSync(filePath), mimeType, filePath };
}

function studioAudioCapabilities() {
  const minimaxConfigured = Boolean((process.env.MINIMAX_API_KEY || process.env.MINIMAX_API_TOKEN || '').trim());
  const minimax = minimaxCredentialUsable();
  const xtts = Boolean((process.env.XTTS_BIN || process.env.COQUI_TTS_BIN || '').trim());
  const qwen = dashscopeCredentialConfigured();
  return {
    languages: Object.entries(VIDEO_LANGUAGES).map(([code, label]) => ({ code, label, available: Boolean(minimax || (qwen && qwenTtsLanguageType(code)) || process.env[`PIPER_MODEL_${code.toUpperCase()}`]), reason: '需配置支持此语言的配音服务' })),
    customVoice: {
      upload: true,
      synthesis: minimax || xtts,
      engines: { minimax, xtts },
      message: minimax || xtts
        ? `真人音色合成可用（${minimax ? 'MiniMax' : 'XTTS/Coqui'}）`
        : '可以保存声音样本，但服务器尚未配置 MiniMax 或 XTTS/Coqui，暂不能用该音色生成配音。',
    },
    minimax: {
      configured: minimaxConfigured,
      usable: minimax,
      credentialStatus: !minimaxConfigured ? 'missing' : minimax ? 'unchecked_or_ready' : 'rejected',
      baseUrl: process.env.MINIMAX_BASE_URL || 'https://api.minimax.io',
      model: process.env.MINIMAX_TTS_MODEL || 'speech-2.8-hd',
      diagnosticAvailable: minimax,
    },
    subtitles: {
      automatic: true,
      audioTranscription: qwen,
      wordAlignment: minimax,
      fallback: minimax ? 'provider_native_with_proportional_fallback' : 'proportional',
    },
  };
}

  return {
    readStudioNativeTtsCache,
    generateTtsAudio,
    proportionalCues,
    localTtsFile,
    studioAudioCapabilities,
  };
}
