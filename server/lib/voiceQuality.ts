import {rethrowStudioVoicePaidBoundary,StudioVoicePaidBoundaryError} from './studioVoicePaidOperation.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import { transcribeAudioWithQwen } from '../agents/qwen.js';

export interface VoiceQualityReport {
  passed: boolean;
  durationSeconds: number;
  peakDb: number;
  rmsDb: number;
  clippingRatio: number;
  silenceRatio: number;
  longestSilenceSeconds: number;
  asrChecked: boolean;
  transcriptAccuracy: number | null;
  /** ASR text used by the quality gate. Persisting it makes a failed gate
   * diagnosable without submitting the same paid ASR request again. */
  recognizedText?: string;
  structuredIdentifierAdjusted?: boolean;
  failures: string[];
}

const db = (ratio: number) => 20 * Math.log10(Math.max(1e-9, ratio));

export function evaluateVoicePcm(pcm: Buffer, sampleRate = 16_000): Omit<VoiceQualityReport, 'asrChecked' | 'transcriptAccuracy'> {
  const samples = Math.floor(pcm.length / 2);
  if (!samples) return { passed: false, durationSeconds: 0, peakDb: -180, rmsDb: -180, clippingRatio: 0, silenceRatio: 1, longestSilenceSeconds: 0, failures: ['口播音频无法解码'] };
  let peak = 0;
  let energy = 0;
  let clipped = 0;
  const windowSamples = Math.max(1, Math.floor(sampleRate * .02));
  let silentWindows = 0;
  let consecutiveSilentWindows = 0;
  let longestSilentWindows = 0;
  let windows = 0;
  for (let start = 0; start < samples; start += windowSamples) {
    let windowEnergy = 0;
    const end = Math.min(samples, start + windowSamples);
    for (let index = start; index < end; index += 1) {
      const value = pcm.readInt16LE(index * 2);
      const absolute = Math.abs(value);
      peak = Math.max(peak, absolute);
      if (absolute >= 32700) clipped += 1;
      const normalized = value / 32768;
      energy += normalized * normalized;
      windowEnergy += normalized * normalized;
    }
    const windowRms = Math.sqrt(windowEnergy / Math.max(1, end - start));
    if (db(windowRms) < -48) {
      silentWindows += 1;
      consecutiveSilentWindows += 1;
      longestSilentWindows = Math.max(longestSilentWindows, consecutiveSilentWindows);
    } else consecutiveSilentWindows = 0;
    windows += 1;
  }
  const durationSeconds = samples / sampleRate;
  const peakDb = db(peak / 32768);
  const rmsDb = db(Math.sqrt(energy / samples));
  const clippingRatio = clipped / samples;
  const silenceRatio = silentWindows / Math.max(1, windows);
  const longestSilenceSeconds = longestSilentWindows * windowSamples / sampleRate;
  const failures: string[] = [];
  if (durationSeconds < .2) failures.push('口播时长异常');
  if (peakDb < -18) failures.push('口播峰值过低');
  if (peakDb > -.05 || clippingRatio > .002) failures.push('口播存在削波风险');
  if (rmsDb < -32 || rmsDb > -8) failures.push('口播平均响度超出可交付范围');
  if (silenceRatio > .55) failures.push('口播静音比例过高');
  if (durationSeconds > 2 && longestSilenceSeconds > Math.max(1.5, durationSeconds * .3)) failures.push('口播存在异常长停顿');
  return {
    passed: failures.length === 0,
    durationSeconds: Number(durationSeconds.toFixed(3)),
    peakDb: Number(peakDb.toFixed(2)),
    rmsDb: Number(rmsDb.toFixed(2)),
    clippingRatio: Number(clippingRatio.toFixed(6)),
    silenceRatio: Number(silenceRatio.toFixed(4)),
    longestSilenceSeconds: Number(longestSilenceSeconds.toFixed(3)),
    failures,
  };
}

export function dashscopeCredentialConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  if (String(env.DASHSCOPE_API_KEY || '').trim()) return true;
  const keyFile = String(env.DASHSCOPE_API_KEY_FILE || path.join(os.homedir(), '.config/lingshu/dashscope.key')).trim();
  try { return Boolean(keyFile && fs.readFileSync(keyFile, 'utf8').trim()); } catch { return false; }
}

function normalizeTranscript(value: string, language: string): string[] {
  const normalized = value.normalize('NFKC').toLowerCase();
  if (/^(?:zh|ja|ko)/i.test(language) || /[\u3400-\u9fff]/.test(normalized)) {
    return [...normalized].filter(char => /[\p{L}\p{N}]/u.test(char));
  }
  const tokens = normalized.match(/[\p{L}\p{N}]+/gu) || [];
  const compactUnits = new Set(['ml', 'l', 'g', 'kg', 'mg', 'oz', 'lb', 'mm', 'cm', 'm', 'w', 'v', 'mah', 'hz', 'khz', 'fps', 'gb', 'mb']);
  const merged: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (/^\d+$/.test(tokens[index]!) && compactUnits.has(tokens[index + 1] || '')) {
      merged.push(tokens[index]! + tokens[index + 1]!);
      index += 1;
    } else merged.push(tokens[index]!);
  }
  return merged;
}

export function transcriptAccuracy(expected: string, actual: string, language: string): number {
  const left = normalizeTranscript(expected, language);
  const right = normalizeTranscript(actual, language);
  if (!left.length) return right.length ? 0 : 1;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1));
    }
    previous.splice(0, previous.length, ...current);
  }
  return Number(Math.max(0, 1 - previous[right.length]! / Math.max(left.length, right.length, 1)).toFixed(4));
}

const STRUCTURED_IDENTIFIER = /\b(?=[\p{L}\p{N}-]*\p{L})(?=[\p{L}\p{N}-]*\p{N})[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)+\b/gu;
const ENGLISH_ASR_ARTICLES = new Set(['a', 'an', 'the']);
const SPOKEN_DIGITS: Record<string, string> = {
  zero: '0', oh: '0', one: '1', won: '1', two: '2', too: '2', three: '3', four: '4',
  five: '5', six: '6', seven: '7', eight: '8', nine: '9',
};

export function speechSafeStructuredIdentifiers(value: string, language: string): string {
  if (!/^en(?:-|$)/i.test(language)) return value;
  return value.replace(STRUCTURED_IDENTIFIER, identifier => identifier.split('-').map((part, index) => {
    if (/^\d+$/.test(part)) return [...part].map(digit => ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'][Number(digit)]).join(' ');
    if (/^\p{L}+$/u.test(part)) {
      if (index === 0 && part.length > 3) return part[0]!.toUpperCase() + part.slice(1).toLocaleLowerCase();
      return [...part.toUpperCase()].join(' ');
    }
    return [...part].map(char => /\d/.test(char)
      ? ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'][Number(char)]
      : char.toUpperCase()).join(' ');
  }).join(', '));
}

function longestCommonSubsequenceLength(left: string[], right: string[]): number {
  const previous = new Array(right.length + 1).fill(0);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [0];
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = left[i - 1] === right[j - 1]
        ? previous[j - 1]! + 1
        : Math.max(previous[j]!, current[j - 1]!);
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] || 0;
}

/**
 * Speech recognizers commonly turn a SKU such as `GUIANFA-RS-001` into a
 * variable-length phonetic phrase (for example, "... R S zero zero one").
 * Comparing that phrase token-for-token makes otherwise exact narration look
 * wrong. Keep the normal edit-distance gate for ordinary copy, but for a
 * structured identifier require all surrounding prose in order plus audible
 * identifier evidence. This does not excuse missing quantities such as
 * `100ml`, nor does it allow unrelated prose to pass.
 */
export function transcriptQualityAccuracy(expected: string, actual: string, language: string): {
  accuracy: number;
  structuredIdentifierAdjusted: boolean;
} {
  const identifiers = expected.match(STRUCTURED_IDENTIFIER) || [];
  if (!identifiers.length || /^(?:zh|ja|ko)/i.test(language)) {
    return { accuracy: transcriptAccuracy(expected, actual, language), structuredIdentifierAdjusted: false };
  }
  const prose = expected.replace(STRUCTURED_IDENTIFIER, ' ');
  // Articles are regularly omitted by short-form English ASR and do not
  // change the verified claim. Only ignore them for the structured-identifier
  // branch; ordinary narration still uses the original 90% edit-distance gate.
  const canonicalProseToken = (token: string) => token === 'skew' ? 'sku' : token === 'confirmed' ? 'confirm' : token;
  const proseTokens = normalizeTranscript(prose, language).filter(token => !ENGLISH_ASR_ARTICLES.has(token)).map(canonicalProseToken);
  const actualTokens = normalizeTranscript(actual, language).filter(token => !ENGLISH_ASR_ARTICLES.has(token)).map(canonicalProseToken);
  if (!proseTokens.length) {
    return { accuracy: transcriptAccuracy(expected, actual, language), structuredIdentifierAdjusted: false };
  }
  const matchedProse = longestCommonSubsequenceLength(proseTokens, actualTokens);
  const proseRecall = matchedProse / proseTokens.length;
  const audibleIdentifierTokens = Math.max(0, actualTokens.length - matchedProse);
  const requiredDigitSequences = identifiers.flatMap(identifier => identifier.match(/\d+/g) || []);
  const actualDigitStream = actualTokens.flatMap(token => {
    const literalDigits = token.match(/\d+/g)?.join('');
    if (literalDigits) return [...literalDigits];
    return SPOKEN_DIGITS[token] ? [SPOKEN_DIGITS[token]!] : [];
  }).join('');
  const expectedIdentifierLetters = identifiers.map(identifier => identifier.replace(/[^\p{L}]/gu, '').toLocaleLowerCase()).join('');
  const actualIdentifierLetters = actualTokens.filter(token => !proseTokens.includes(token)
    && !Object.prototype.hasOwnProperty.call(SPOKEN_DIGITS, token))
    .map(token => token.replace(/[^\p{L}]/gu, '')).join('');
  const identifierAlphaEvidence = Boolean(expectedIdentifierLetters && actualIdentifierLetters)
    && longestCommonSubsequenceLength([...expectedIdentifierLetters], [...actualIdentifierLetters]) / expectedIdentifierLetters.length >= .7;
  const hasIdentifierEvidence = audibleIdentifierTokens >= identifiers.length && identifierAlphaEvidence
    && requiredDigitSequences.every(sequence => actualDigitStream.includes(sequence));
  const identifierOnlyLabel = proseTokens.length > 0
    && proseTokens.every(token => ['sku', 'model', 'code', 'id', 'identifier'].includes(token));
  return {
    accuracy: Number((hasIdentifierEvidence ? (identifierOnlyLabel ? 1 : proseRecall) : Math.min(proseRecall, .89)).toFixed(4)),
    structuredIdentifierAdjusted: true,
  };
}

async function decodePcm(filePath: string): Promise<Buffer> {
  if (!ffmpegStatic) throw new Error('ffmpeg unavailable');
  return new Promise((resolve, reject) => {
    const child = spawn(String(ffmpegStatic), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', filePath, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('口播质检解码超时')); }, 60_000);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) { child.kill('SIGKILL'); return; }
      chunks.push(Buffer.from(chunk));
    });
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-1_000); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 || bytes > 16 * 1024 * 1024) reject(new Error(`口播质检无法解码：${stderr || '输出过大'}`));
      else resolve(Buffer.concat(chunks));
    });
  });
}

export async function inspectGeneratedVoice(input: {
  filePath: string;
  expectedText: string;
  language: string;
  asrRequired?: boolean;
  /** A separately metered file alignment will verify this exact audio. */
  deferAsrToAlignment?: boolean;
}): Promise<VoiceQualityReport> {
  if (!fs.existsSync(input.filePath)) throw new Error('口播质检文件不存在');
  const pcm = await decodePcm(input.filePath);
  const acoustic = evaluateVoicePcm(pcm);
  const failures = [...acoustic.failures];
  const asrConfigured = dashscopeCredentialConfigured();
  const asrEnabled = !input.deferAsrToAlignment && process.env.TTS_ASR_QA_ENABLED !== 'false' && asrConfigured;
  const asrRequired = input.asrRequired ?? (process.env.TTS_ASR_QA_REQUIRED === 'true' || process.env.NODE_ENV === 'production');
  let accuracy: number | null = null;
  let recognizedText: string | undefined;
  let structuredIdentifierAdjusted = false;
  if (asrEnabled) {
    try {
      const result = await transcribeAudioWithQwen({ audio: fs.readFileSync(input.filePath), fileName: `voice${path.extname(input.filePath) || '.wav'}`, audioSeconds: acoustic.durationSeconds, signal: AbortSignal.timeout(Math.max(10000, Number(process.env.TTS_ASR_QA_TIMEOUT_MS || 30000))) });
      recognizedText = result.text;
      const quality = transcriptQualityAccuracy(input.expectedText, result.text, input.language);
      accuracy = quality.accuracy;
      structuredIdentifierAdjusted = quality.structuredIdentifierAdjusted;
      if (accuracy < .9) failures.push(`口播ASR回听一致度仅${Math.round(accuracy * 100)}%`);
    } catch (error) {
      if (!optionalPaidAsrOutage(error) || asrRequired) rethrowStudioVoicePaidBoundary(error);
      if (asrRequired) failures.push(`口播ASR回听失败：${String(error instanceof Error ? error.message : error).slice(0, 160)}`);
    }
  } else if (asrRequired) {
    failures.push('正式口播缺少ASR回听能力');
  }
  return { ...acoustic, passed: failures.length === 0, asrChecked: accuracy !== null, transcriptAccuracy: accuracy,
    ...(recognizedText ? { recognizedText } : {}), ...(structuredIdentifierAdjusted ? { structuredIdentifierAdjusted: true } : {}), failures };
}
export function optionalPaidAsrOutage(error: unknown) {
  return error instanceof StudioVoicePaidBoundaryError
    && (/social_paid_permit_receipt_recovery_required/.test(error.message)
      || /Request was aborted/.test(error.message));
}
