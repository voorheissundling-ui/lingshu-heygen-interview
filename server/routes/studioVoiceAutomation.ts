import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { withStudioVoicePaidContext, type StudioVoicePaidContext } from '../lib/studioVoicePaidOperation.js';
import { objectStorageEnabled } from '../storage/objectStorage.js';
import { wavDurationFromBytes } from '../lib/wavDuration.js';
import { dashscopeCredentialConfigured, inspectGeneratedVoice, speechSafeStructuredIdentifiers, type VoiceQualityReport } from '../lib/voiceQuality.js';
import { ttsPostProcessingSpeed } from '../lib/studioVoiceSelection.js';
import { splitStudioNarrationSentences } from './studioVoiceoverLanguageRules.js';
import { minimaxSpeechText, minimaxVoiceFor, normalizeTtsLanguage, normalizeTtsStyle, QWEN_TTS_VOICE_MAP, type TtsStyleOptions } from './studioTtsStyle.js';
import type { AlignedCue, createStudioTtsProviderRuntime } from './studioTtsProviderRuntime.js';
import type { createStudioTtsGeneration } from './studioTtsGeneration.js';

type Providers = ReturnType<typeof createStudioTtsProviderRuntime>;
type Generation = ReturnType<typeof createStudioTtsGeneration>;

interface VoiceAutomationPorts {
  runTenant: <T>(tenantId: string, run: () => T) => T;
  tenantTtsDir: (tenantId: string) => string;
  ttsUrl: (file: string) => string;
  persistPrivateTtsAsset: (tenantId: string, filePath: string) => Promise<string>;
  execFileAsync: (file: string, args: string[], timeout?: number) => Promise<string>;
  ffmpegBin: string;
  providers: Providers;
  generation: Generation;
}

/** Frozen voice planning and verified automation synthesis use the same runtime. */
export function createStudioVoiceAutomation(ports: VoiceAutomationPorts) {
  const { runTenant, tenantTtsDir, ttsUrl, persistPrivateTtsAsset, execFileAsync,
    ffmpegBin, providers, generation } = ports;
  const { generateTtsAudio, readStudioNativeTtsCache } = generation;
  const { minimaxEndpoint, voiceSamplePathFromId, minimaxVoiceCacheKey, readMinimaxVoiceCache,
    qwenTtsLanguageType } = providers;


async function persistTtsResult<T extends { url?: string }>(result: T, tenantId: string): Promise<T> {
  if (!result.url) return result;
  const file = path.basename(new URL(result.url, 'http://local').pathname);
  const filePath = path.join(tenantTtsDir(tenantId), file);
  if (!fs.existsSync(filePath)) return { ...result, ok: false, url: undefined, error: '配音文件未保存，请重试' };
  const diagnostics = await new Promise<string>(resolve => execFile(ffmpegBin, ['-hide_banner', '-i', filePath, '-af', 'volumedetect', '-f', 'null', '-'], { timeout: 30000 }, (_error, _stdout, stderr) => resolve(String(stderr))));
  const durationMatch = diagnostics.match(/Duration: (\d+):(\d+):([\d.]+)/);
  const duration = durationMatch ? +durationMatch[1] * 3600 + +durationMatch[2] * 60 + +durationMatch[3] : 0;
  const volume = Number(diagnostics.match(/max_volume: ([-\d.]+) dB/)?.[1] ?? '-Infinity');
  if (duration < 0.2 || volume < -60) return { ...result, ok: false, url: undefined, error: '配音为空或接近静音，请选择此语言的其他音色或服务' };
  return { ...result, duration, ...(objectStorageEnabled() ? { url: await persistPrivateTtsAsset(tenantId, filePath) } : {}) };
}

/**
 * Trusted in-process entry point used by the digital-employee content worker.
 * It deliberately returns the tenant-scoped local file path as well as the
 * public URL so the background renderer does not need to forge an HTTP user
 * session. No publishing side effect happens here.
 */
/** Read-only view of the exact native selection policy used below. Physical
 * voices and prepared paid text are resolved before supplier pricing. */
function resolveStudioVoiceExecutionPlan(input:{tenantId:string;text:string;voice?:string;language?:string;style?:TtsStyleOptions;sentenceLines?:string[];measuredSentenceTiming?:boolean;env?:NodeJS.ProcessEnv;nativeProvider?:'qwen'|'minimax'|'heygen'}) {
 return runTenant(input.tenantId,()=>{
  const env=input.env||process.env;
  const spoken=String(input.text||'').trim(),voice=input.voice||'v1',language=input.language||'en';
  const style=normalizeTtsStyle(input.style||{preset:'authentic_review'});
  const requested=input.sentenceLines?.map(line=>line.trim()).filter(Boolean)||[];
  if(requested.length && requested.join(' ').replace(/\s+/g,'')!==spoken.replace(/\s+/g,''))throw Error('voice_plan_sentence_text_mismatch');
  const lines=requested.length?requested:splitStudioNarrationSentences(spoken);
  const continuous=!input.measuredSentenceTiming&&lines.length>1&&lines.length<=100&&spoken.length<=5000;
  const texts=(continuous?[spoken]:lines).map(text=>speechSafeStructuredIdentifiers(text,language));
  const minimaxConfigured=Boolean((env.MINIMAX_API_KEY||env.MINIMAX_API_TOKEN||'').trim());
  const qwenConfigured=Boolean(String(env.DASHSCOPE_API_KEY||'').trim())&&Boolean(qwenTtsLanguageType(language));
  const expressive=env.TTS_PREFER_EXPRESSIVE_PROVIDER!=='false'&&minimaxConfigured&&Boolean(style.preset||style.emotion||style.pauseStyle||style.pronunciations?.length);
  const account=(provider:'minimax'|'qwen')=>createHash('sha256').update(provider==='minimax'?env.MINIMAX_API_KEY||env.MINIMAX_API_TOKEN||'':env.DASHSCOPE_API_KEY||'').digest('hex');
  const native=(provider:'minimax'|'qwen')=>({provider,model:provider==='minimax'?env.MINIMAX_TTS_MODEL||'speech-2.8-hd':env.QWEN_TTS_MODEL||'qwen3-tts-flash',accountKeyHash:account(provider),endpoint:provider==='minimax'?minimaxEndpoint('/v1/t2a_v2',env):env.DASHSCOPE_TTS_ENDPOINT||'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',voiceId:provider==='minimax'?minimaxVoiceFor(voice,language,env):env[`QWEN_TTS_VOICE_${voice.toUpperCase()}`]||QWEN_TTS_VOICE_MAP[voice]||'Cherry',texts:texts.map(text=>provider==='minimax'?minimaxSpeechText(text,style).slice(0,5000):text.slice(0,5000))});
  if (voice.startsWith('heygen:')) {
   const voiceId = voice.split(':')[1];
   if (!voiceId || !env.HEYGEN_API_KEY?.trim()) throw Error('selected_presenter_heygen_voice_unavailable');
   if (spoken.length > 5000) throw Error('selected_presenter_voice_text_exceeds_provider_limit');
   if (input.nativeProvider && input.nativeProvider !== 'heygen') throw Error('selected_presenter_frozen_voice_provider_mismatch');
   return {mode:!spoken?'none' as const:'continuous' as const,lines,texts:[speechSafeStructuredIdentifiers(spoken,language)],logicalVoice:voice,language,custom:null,primary:{provider:'heygen' as const,model:'starfish',accountKeyHash:createHash('sha256').update(env.HEYGEN_API_KEY.trim()).digest('hex'),endpoint:'https://api.heygen.com/v3/voices/speech',voiceId,texts:[speechSafeStructuredIdentifiers(spoken,language)]},fallback:null,cacheCandidates:[],asrConfigured:env.TTS_ASR_QA_ENABLED!=='false'&&dashscopeCredentialConfigured(env)};
  }
  if(voice.startsWith('custom:')) {
   const sample=voiceSamplePathFromId(voice);const key=sample?minimaxVoiceCacheKey(voice,sample):null;
   const cached=key?readMinimaxVoiceCache()[key]:null;
   return {mode:continuous?'continuous' as const:'sentences' as const,lines,texts,logicalVoice:voice,language,custom:{sampleSha256:sample?createHash('sha256').update(fs.readFileSync(sample)).digest('hex'):null,voiceId:cached?.voiceId||null,activationState:cached?.activationState||null,requiresClone:!cached?.voiceId,requiresActivation:cached?.activationState!=='activated',clonePreviewText:env.MINIMAX_CLONE_PREVIEW_TEXT||'这是一段用于确认真人音色的试读音频。',activationText:env.MINIMAX_ACTIVATION_TEXT||'你好，这是我的品牌授权音色。'},cacheCandidates:[],primary:minimaxConfigured&&cached?.voiceId?{...native('minimax'),voiceId:cached.voiceId}:null,fallback:null,asrConfigured:env.TTS_ASR_QA_ENABLED!=='false'&&dashscopeCredentialConfigured(env)};
  }
  const primary=input.nativeProvider ? (input.nativeProvider==='qwen'&&qwenConfigured?native('qwen'):input.nativeProvider==='minimax'&&minimaxConfigured?native('minimax'):null) : expressive?native('minimax'):qwenConfigured?native('qwen'):minimaxConfigured?native('minimax'):null;
  const fallback=primary?.provider==='minimax'&&expressive&&env.TTS_REQUIRE_MINIMAX==='true'?null:primary?.provider==='minimax'&&qwenConfigured?native('qwen'):primary?.provider==='qwen'&&minimaxConfigured?native('minimax'):null;
  return {mode:!spoken?'none' as const:continuous?'continuous' as const:'sentences' as const,lines,texts,logicalVoice:voice,language,custom:null,primary,fallback,cacheCandidates:texts.map(text=>readStudioNativeTtsCache(input.tenantId,text,voice,language,style)),asrConfigured:env.TTS_ASR_QA_ENABLED!=='false'&&dashscopeCredentialConfigured(env)};
 });
}

async function synthesizeStudioVoiceForAutomation(input: {
  tenantId: string; text: string; language?: string; voice?: string; targetDuration?: number;
  paidContext?: StudioVoicePaidContext;
  style?: TtsStyleOptions; sentenceLines?: string[]; measuredSentenceTiming?: boolean;
}): Promise<{ ok: boolean; source?: string; url?: string; localPath?: string; duration?: number; text?: string; error?: string; cues?: AlignedCue[]; alignmentSource?: string; qualityReport?: VoiceQualityReport }> {
  return withStudioVoicePaidContext(input.paidContext, () => runTenant(input.tenantId, async () => {
    const spoken = String(input.text || '').trim();
    if (!spoken) return { ok: false, error: '口播为空' };
    if (!['zh','ja'].includes(normalizeTtsLanguage(input.language || 'en')) && /[\u4e00-\u9fff]/.test(spoken)) return { ok: false, error: '口播含中文，请先统一为目标语种后再生成配音。' };
    // Short social scripts need one continuous performance. Synthesizing every
    // sentence separately resets pitch and emotion four times and makes a
    // natural recommendation sound like stitched system prompts. Keep longer
    // automation scripts on the measured per-sentence path below.
    const requestedLines = Array.isArray(input.sentenceLines) ? input.sentenceLines.map(line => String(line).trim()).filter(Boolean) : [];
    if (requestedLines.length && requestedLines.join(' ').replace(/\s+/g, '') !== spoken.replace(/\s+/g, '')) {
      return { ok: false, error: '逐句口播与完整口播不一致' };
    }
    const lines = requestedLines.length ? requestedLines : splitStudioNarrationSentences(spoken);
    const synthesisSpoken = speechSafeStructuredIdentifiers(spoken, input.language || 'en');
    const synthesisLines = lines.map(line => speechSafeStructuredIdentifiers(line, input.language || 'en'));
    const dir = tenantTtsDir(input.tenantId); fs.mkdirSync(dir, { recursive: true });
    const files: string[] = [], cues: AlignedCue[] = [];
    const providers = new Set<string>();
    let cursor = 0;
    const speed = Math.max(.75, Math.min(1.35, Number(input.style?.speed) || 1));
    if (!input.measuredSentenceTiming && lines.length > 1 && lines.length <= 100 && spoken.length <= 5000) {
      const audio = await generateTtsAudio(synthesisSpoken, input.voice || 'v1', input.language || 'en', normalizeTtsStyle(input.style || { preset: 'authentic_review' }), true);
      if (!audio.ok || !audio.url) return { ok: false, error: audio.error || '配音生成失败' };
      const trustedProvider = ['qwen_tts', 'minimax', 'xtts_clone', 'heygen'].includes(audio.source);
      if (!trustedProvider) return { ok: false, source: audio.source, error: audio.error || '自然人声服务暂不可用，已停止使用系统机械音色；请检查语音服务或录入个人声音' };
      const source = path.join(dir, path.basename(new URL(audio.url, 'http://local').pathname));
      const joined = path.join(dir, randomUUID() + '.wav');
      const postSpeed = ttsPostProcessingSpeed(audio.source, speed);
      await execFileAsync(ffmpegBin, ['-y', '-i', source, '-af', 'atempo=' + postSpeed + ',highpass=f=60,loudnorm=I=-16:TP=-1.5:LRA=7,alimiter=limit=0.95,apad=pad_dur=0.15', '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', joined], 30000);
      let duration = wavDurationFromBytes(fs.readFileSync(joined));
      // The provider may return a track a few hundred milliseconds longer
      // than the frozen film. Fit that performance locally before ASR/align so
      // metered seconds stay inside the whole-film reservation and the final
      // word is preserved instead of being cut off by the renderer.
      const frozenDuration = Number(input.targetDuration);
      if (Number.isFinite(frozenDuration) && frozenDuration > .15 && duration > frozenDuration + .02) {
        const fitted = joined + '.fitted.wav';
        const ratio = duration / frozenDuration;
        if (ratio > 2) return { ok: false, source: audio.source, error: '口播明显超过成片时长，请调整脚本。' };
        await execFileAsync(ffmpegBin, ['-y', '-i', joined, '-af', `atempo=${ratio},atrim=duration=${frozenDuration}`, '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', fitted], 30000);
        fs.renameSync(fitted, joined);
        duration = wavDurationFromBytes(fs.readFileSync(joined));
      }
      if (!(duration > .15)) return { ok: false, error: '无法测量实际配音时长' };
      const spokenDuration = Math.max(.15, duration - .15);
      const weights = lines.map(line => Math.max(1, [...line.replace(/[\s，,。.!！?？；;：:、]/g, '')].length));
      const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
      let cueCursor = 0;
      const continuousCues = lines.map((line, index) => {
        const start = cueCursor;
        const end = index === lines.length - 1
          ? spokenDuration
          : Math.min(spokenDuration, start + spokenDuration * weights[index]! / totalWeight);
        cueCursor = end;
        return { start, end, text: line };
      });
      const hasNativeTiming = audio.alignmentSource === 'minimax_native' && Boolean(audio.cues?.length);
      const outputCues = hasNativeTiming ? audio.cues!.map(cue => ({
        ...cue,
        start: Math.max(0, Math.min(spokenDuration, cue.start / postSpeed)),
        end: Math.max(0, Math.min(spokenDuration, cue.end / postSpeed)),
        ...(cue.words ? { words: cue.words.map(word => ({ ...word, start: word.start / postSpeed, end: word.end / postSpeed })) } : {}),
      })).filter(cue => cue.text && cue.end > cue.start) : continuousCues;
      const result = await persistTtsResult({ ok: true, url: ttsUrl(path.basename(joined)), duration }, input.tenantId);
      const qualityReport = await inspectGeneratedVoice({ filePath: joined, expectedText: spoken, language: input.language || 'en', asrRequired: false,
        deferAsrToAlignment: audio.source === 'heygen' && Boolean(input.paidContext) });
      if (!qualityReport.passed) return { ok: false, source: audio.source, error: `口播质量未通过：${qualityReport.failures.join('；')}`, qualityReport };
      // Proportional sentence splits of one continuous performance are useful
      // for subtitle preview, but they are not measured audio boundaries.
      // Never cache them as an ASR alignment or pass them to production as exact.
      if (hasNativeTiming) fs.writeFileSync(joined + '.alignment.json', JSON.stringify({ text: spoken, cues: outputCues, source: 'minimax_native' }));
      return { ...result, localPath: joined, text: spoken, cues: outputCues, source: audio.source, alignmentSource: hasNativeTiming ? 'minimax_native' : 'pending_alignment', qualityReport };
    }
    // Longer scripts retain independently measured sentence boundaries.
    for (const [lineIndex, line] of lines.entries()) {
      const audio = await generateTtsAudio(synthesisLines[lineIndex]!, input.voice || 'v1', input.language || 'en', normalizeTtsStyle(input.style || { preset: 'authentic_review' }), true);
      if (!audio.ok || !audio.url) return { ok: false, error: audio.error || '配音生成失败' };
      const trustedProvider = ['qwen_tts', 'minimax', 'xtts_clone', 'heygen'].includes(audio.source);
      if (!trustedProvider) return { ok: false, source: audio.source, error: audio.error || '自然人声服务暂不可用，已停止使用系统机械音色；请检查语音服务或录入个人声音' };
      providers.add(audio.source);
      const source = path.join(dir, path.basename(new URL(audio.url, 'http://local').pathname));
      const output = path.join(dir, randomUUID() + '.wav');
      const postSpeed = ttsPostProcessingSpeed(audio.source, speed);
      await execFileAsync(ffmpegBin, ['-y', '-i', source, '-af', 'atempo=' + postSpeed + ',highpass=f=60,apad=pad_dur=0.15', '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', output], 30000);
      let duration = wavDurationFromBytes(fs.readFileSync(output));
      const measuredSpeechDuration = Math.max(.15, duration - .15);
      const singleLineTarget = lines.length === 1 && Number.isFinite(Number(input.targetDuration))
        ? Number(input.targetDuration) : 0;
      // Every sentence render adds 150 ms of trailing silence to protect the
      // last phoneme. If speech itself fits the frozen interval, trim only that
      // padding; never time-compress or truncate spoken content here.
      if (singleLineTarget > .15 && duration > singleLineTarget + .01
        && duration - .15 <= singleLineTarget + .01) {
        const trimmed = output + '.trimmed.wav';
        await execFileAsync(ffmpegBin, ['-y', '-i', output, '-af', `atrim=duration=${singleLineTarget}`,
          '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', trimmed], 30000);
        fs.renameSync(trimmed, output);
        duration = wavDurationFromBytes(fs.readFileSync(output));
      }
      if (!(duration > .15)) return { ok: false, error: `第 ${cues.length + 1} 句未生成有效语音：${line.slice(0, 60)}。请修改该句或选择支持此语言的音色。` };
      cues.push({ start: cursor, end: cursor + Math.min(duration, measuredSpeechDuration), text: line });
      cursor += duration; files.push(output);
    }
    const joined = path.join(dir, randomUUID() + '.wav');
    const inputs = files.flatMap(file => ['-i', file]);
    await execFileAsync(ffmpegBin, ['-y', ...inputs, '-filter_complex', files.map((_,i) => '['+i+':a]').join('') + 'concat=n=' + files.length + ':v=0:a=1[joined];[joined]loudnorm=I=-16:TP=-1.5:LRA=7,alimiter=limit=0.95[out]', '-map', '[out]', '-c:a', 'pcm_s16le', joined], 60000);
    const result = await persistTtsResult({ ok: true, url: ttsUrl(path.basename(joined)), duration: cursor }, input.tenantId);
    const qualityReport = await inspectGeneratedVoice({ filePath: joined, expectedText: spoken, language: input.language || 'en', asrRequired: false });
    if (!qualityReport.passed) return { ok: false, source: [...providers].join('+'), error: `口播质量未通过：${qualityReport.failures.join('；')}`, qualityReport };
    fs.writeFileSync(joined + '.alignment.json', JSON.stringify({ text: spoken, cues, source: 'synthesized_sentence_audio' }));
    for (const file of files) fs.unlinkSync(file);
    return { ...result, localPath: joined, text: spoken, cues, source: [...providers].join('+'), alignmentSource: 'synthesized_sentence_audio', qualityReport };
  }));
}

  return {
    resolveStudioVoiceExecutionPlan,
    synthesizeStudioVoiceForAutomation,
  };
}
