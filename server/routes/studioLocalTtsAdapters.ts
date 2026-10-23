import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeTtsLanguage, SAY_LANGUAGE_VOICE_MAP } from './studioTtsStyle.js';

export interface LocalTtsPorts {
  ttsDir(): string;
  ttsUrl(file: string): string;
  voiceSamplePath(voice: string): string | null;
  runFfmpeg(args: string[]): Promise<boolean>;
}

function piperModelForLanguage(language: string, env: NodeJS.ProcessEnv): string {
  const code = normalizeTtsLanguage(language).toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return env[`PIPER_MODEL_${code}`] || (normalizeTtsLanguage(env.PIPER_LANGUAGE) === normalizeTtsLanguage(language) ? env.PIPER_MODEL : '') || '';
}

function piperConfigForLanguage(language: string, modelPath: string, env: NodeJS.ProcessEnv): string {
  const code = normalizeTtsLanguage(language).toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return env[`PIPER_CONFIG_${code}`] || env.PIPER_CONFIG || `${modelPath}.json`;
}

function xttsLanguageCode(language: string): string {
  const code = normalizeTtsLanguage(language);
  return code === 'zh' ? 'zh-cn' : code;
}

function durationFromText(text: string): number {
  const chars = String(text || '').replace(/\s+/g, '').length;
  return Math.max(2, Math.min(60, Math.ceil(chars / 9)));
}

function execFileOk(file: string, args: string[], timeout = 45_000): Promise<boolean> {
  return new Promise(resolve => {
    execFile(file, args, { timeout }, err => resolve(!err));
  });
}

export async function generatePiperTts(
  text: string, language: string, ports: LocalTtsPorts, env: NodeJS.ProcessEnv = process.env,
): Promise<{ url: string; duration: number; source: string } | null> {
  const piperBin = env.PIPER_BIN || env.PIPER_PATH || '';
  const modelPath = piperModelForLanguage(language, env);
  if (!piperBin || !modelPath) return null;
  const dir = ports.ttsDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* preserve existing fallback behavior */ }
  const file = `${randomUUID()}.wav`;
  const outPath = path.join(dir, file);
  const args = ['--model', modelPath, '--output_file', outPath];
  const configPath = piperConfigForLanguage(language, modelPath, env);
  if (configPath && fs.existsSync(configPath)) args.splice(2, 0, '--config', configPath);
  const spoken = text.slice(0, 1500);
  const ok = await new Promise<boolean>(resolve => {
    const child = spawn(piperBin, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    const timer = setTimeout(() => { child.kill('SIGTERM'); resolve(false); }, 60_000);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('close', code => { clearTimeout(timer); resolve(code === 0 && fs.existsSync(outPath)); });
    child.stdin.end(spoken);
  });
  return ok ? { url: ports.ttsUrl(file), duration: durationFromText(text), source: 'piper' } : null;
}

export async function generateXttsCloneTts(
  text: string, voice: string, language: string, ports: LocalTtsPorts, env: NodeJS.ProcessEnv = process.env,
): Promise<{ url: string; duration: number; source: string } | null> {
  const xttsBin = env.XTTS_BIN || env.COQUI_TTS_BIN || '';
  if (!xttsBin) return null;
  const samplePath = ports.voiceSamplePath(voice);
  if (!samplePath) return null;
  const dir = ports.ttsDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* preserve existing fallback behavior */ }
  const file = `${randomUUID()}.wav`;
  const outPath = path.join(dir, file);
  const modelName = env.XTTS_MODEL_NAME || 'tts_models/multilingual/multi-dataset/xtts_v2';
  const args = [
    '--model_name', modelName, '--text', text.slice(0, 1500),
    '--speaker_wav', samplePath, '--language_idx', xttsLanguageCode(language), '--out_path', outPath,
  ];
  const ok = await new Promise<boolean>(resolve => {
    const child = spawn(xttsBin, args, { stdio: ['ignore', 'ignore', 'ignore'] });
    const timer = setTimeout(() => { child.kill('SIGTERM'); resolve(false); }, Number(env.XTTS_TIMEOUT_MS || 120_000));
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('close', code => { clearTimeout(timer); resolve(code === 0 && fs.existsSync(outPath)); });
  });
  return ok ? { url: ports.ttsUrl(file), duration: durationFromText(text), source: 'xtts_clone' } : null;
}

export async function generateLocalSayTts(
  text: string, voice: string, language: string, ports: LocalTtsPorts, platform = process.platform,
): Promise<{ url: string; duration: number; source: string } | null> {
  if (platform !== 'darwin') return null;
  const dir = ports.ttsDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* preserve existing fallback behavior */ }
  const base = randomUUID();
  const aiffFile = `${base}.aiff`;
  const wavFile = `${base}.wav`;
  const aiffPath = path.join(dir, aiffFile);
  const wavPath = path.join(dir, wavFile);
  const localLanguage = /[\u3040-\u30ff]/.test(text) && !/[A-Za-z]/.test(text) ? 'ja' : /[\u4e00-\u9fff]/.test(text) ? 'zh' : language;
  const lang = normalizeTtsLanguage(localLanguage);
  const candidates = SAY_LANGUAGE_VOICE_MAP[lang]?.[voice] ?? SAY_LANGUAGE_VOICE_MAP[lang]?.v1 ?? [];
  const spoken = text.slice(0, 1500);
  let made = false;
  for (const candidate of candidates) {
    made = await execFileOk('/usr/bin/say', ['-v', candidate, '-o', aiffPath, spoken]);
    if (made && fs.existsSync(aiffPath)) break;
  }
  if (!made || !fs.existsSync(aiffPath)) return null;
  const converted = await ports.runFfmpeg(['-i', aiffPath, '-ar', '24000', '-ac', '1', '-y', wavPath]);
  try { fs.unlinkSync(aiffPath); } catch { /* ignore */ }
  if (converted && fs.existsSync(wavPath)) return { url: ports.ttsUrl(wavFile), duration: durationFromText(text), source: 'local_say' };
  return { url: ports.ttsUrl(aiffFile), duration: durationFromText(text), source: 'local_say' };
}
