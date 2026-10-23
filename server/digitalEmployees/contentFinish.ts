import fs from 'node:fs';
import path from 'node:path';
import { runVisualFfmpeg } from '../lib/renderVisualQuality.js';

export type BgmAudibility = {
  checked: boolean;
  passed: boolean;
  quietVoiceSeconds: number;
  dryDb: number | null;
  mixedDb: number | null;
  reason?: string;
};

function db(power: number) {
  return 10 * Math.log10(power + 1e-15);
}

export async function inspectBgmAudibility(file: string, voiceFile?: string): Promise<BgmAudibility> {
  if (!voiceFile || !fs.existsSync(voiceFile)) return { checked: false, passed: true, quietVoiceSeconds: 0, dryDb: null, mixedDb: null, reason: '缺少独立口播音频，未执行配乐可听度对比' };
  const decode = (input: string) => runVisualFfmpeg(['-loglevel','error','-i',input,'-vn','-ac','1','-ar','16000','-f','f32le','pipe:1'], true);
  const [dry, mixed] = await Promise.all([decode(voiceFile), decode(file)]);
  if (!dry.ok || !mixed.ok) return { checked: true, passed: false, quietVoiceSeconds: 0, dryDb: null, mixedDb: null, reason: '无法读取成片或口播音频' };
  const sample = (buffer: Buffer, index: number) => buffer.readFloatLE(index * 4);
  const samples = Math.min(Math.floor(dry.stdout.length / 4), Math.floor(mixed.stdout.length / 4));
  const window = 320;
  let quietSamples = 0, dryEnergy = 0, mixedEnergy = 0;
  for (let start = 1600; start + window <= samples - 320; start += window) {
    let dryWindow = 0, mixedWindow = 0;
    for (let index = start; index < start + window; index += 1) {
      const dryValue = sample(dry.stdout, index), mixedValue = sample(mixed.stdout, index);
      dryWindow += dryValue * dryValue;
      mixedWindow += mixedValue * mixedValue;
    }
    if (dryWindow / window >= 1e-7) continue;
    quietSamples += window;
    dryEnergy += dryWindow;
    mixedEnergy += mixedWindow;
  }
  const quietVoiceSeconds = quietSamples / 16000;
  if (quietVoiceSeconds < 0.12) return { checked: false, passed: true, quietVoiceSeconds, dryDb: null, mixedDb: null, reason: '口播停顿不足，无法独立测量配乐' };
  const dryDb = db(dryEnergy / quietSamples), mixedDb = db(mixedEnergy / quietSamples);
  const passed = mixedDb >= -31 && mixedDb >= dryDb + 12;
  return { checked: true, passed, quietVoiceSeconds, dryDb, mixedDb, ...(passed ? {} : { reason: '口播停顿处的配乐低于可听阈值' }) };
}

export async function finishContent(file: string, spec: Record<string, any>) {
  const audio = await runVisualFfmpeg(['-loglevel','info','-i',file,'-vn','-af','volumedetect','-f','null','-'],false);
  const peak = Number(audio.stderr.match(/max_volume: ([-\d.]+) dB/)?.[1] ?? '-Infinity');
  const mean = Number(audio.stderr.match(/mean_volume: ([-\d.]+) dB/)?.[1] ?? '-Infinity');
  if (!audio.ok || peak < -55 || !Number.isFinite(mean)) throw Error('成片音轨缺失或近乎静音');
  const bgmRequested = Boolean(spec.bgm) && Number(spec.bgmVol || 0) > 0;
  const bgmAudibility = bgmRequested ? await inspectBgmAudibility(file, String(spec.voiceLocalPath || spec.automation?.voiceLocalPath || '')) : null;
  if (bgmAudibility?.checked && !bgmAudibility.passed) throw Error(`成片配乐音量过低：${bgmAudibility.reason}（${bgmAudibility.mixedDb?.toFixed(1)} dB）`);
  const probe = audio.stderr.match(/Video: .*?, (\d{2,5})x(\d{2,5})/);
  const duration = Number(spec.duration || 20);
  const cover = file.replace(/\.mp4$/i, '-cover-v'+Number(spec.automation?.contentVersion||1)+'.jpg');
  const titleFile = file.replace(/\.mp4$/i, '-cover.txt');
  const title = String(spec.coverTitle || '').slice(0, 100).replace(/(.{28})/gu, '$1\n').trim();
  fs.writeFileSync(titleFile, title);
  const escape = (value:string) => value.replace(/\\/g,'\\\\').replace(/:/g,'\\:').replace(/'/g,"'\\''");
  let frame = Number.isFinite(Number(spec.coverFrameTime)) ? Number(spec.coverFrameTime) : Math.min(1, duration / 4);
  if (spec.coverFrameTime === undefined) {
    let best = -Infinity;
    for (const candidate of [.15, .4, .65].map(f => duration * f)) {
      const sample = await runVisualFfmpeg(['-ss',String(candidate),'-i',file,'-vf','scale=64:64,format=gray','-frames:v','1','-f','rawvideo','pipe:1'],true);
      if (!sample.ok || sample.stdout.length !== 4096) continue;
      const mean = sample.stdout.reduce((sum,n) => sum+n,0)/4096;
      const variance = sample.stdout.reduce((sum,n) => sum+(n-mean)**2,0)/4096;
      const score = variance - Math.abs(mean-120)*12;
      if (score>best) { best=score;frame=candidate; }
    }
  }
  // Prefer an actual frame selected by the renderer's image checks; human time overrides it.
  const textFilter = title ? ",drawtext=textfile='"+escape(titleFile)+"':fontsize=h/24:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=16:x=(w-tw)/2:y=h*0.12" : '';
  const rendered = await runVisualFfmpeg(['-y','-ss',String(Math.max(0,Math.min(duration-.1,frame))),'-i',file,'-vf','scale=iw:ih'+textFilter,'-frames:v','1',cover]);
  if (!rendered.ok || !fs.existsSync(cover)) throw Error('封面生成失败：'+rendered.stderr.slice(-200));
  return { coverImagePath: cover, coverFrameTime: frame, coverSelection: { source: spec.coverFrameTime === undefined ? 'frame_contrast' : 'human', titleSource: 'script_or_human' }, exportSpec: { ratio: spec.ratio || '9:16', resolution: spec.exportSpec?.resolution || '1080p', fps: 30, codec:'h264', width:probe ? Number(probe[1]) : undefined,height:probe ? Number(probe[2]) : undefined }, audioQuality: { passed:true, peakDb:peak, meanDb:mean, reviewedByHuman:false, bgmAudibility } };
}
