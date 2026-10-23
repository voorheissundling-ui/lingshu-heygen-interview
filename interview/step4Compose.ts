/**
 * Step 4 local composition.
 *
 * Reads the measured presenter shots and explainer narration, builds the
 * contiguous 30-37 s plan, writes a single voiceover track at timeline
 * offsets, and (with --render) calls the existing desktop/render.cjs
 * compositor to produce 1080x1920 H.264/AAC with burned subtitles.
 *
 * No provider call and no spending happens here.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import ffmpegStatic from 'ffmpeg-static';
import {readStoryboardFile} from './storyboard.js';
import {buildStep4Plan, buildStep4RenderManifest, validateStep4Plan, type Step4Plan} from './step4Plan.js';

const requireCjs = createRequire(import.meta.url);
const {composite} = requireCjs('../desktop/render.cjs') as {
  composite: (manifest: unknown, onProgress?: (pct: number) => void, outDir?: string) => Promise<{ok: boolean; outputPath?: string; error?: string}>;
};
const execFileAsync = promisify(execFile);
const STEP_ROOT = path.resolve('.interview-data/step4-shots');
const NARRATION_ROOT = path.resolve('.interview-data/step4-narration');
const COMPOSE_ROOT = path.resolve('.interview-data/step4-compose');
const OUTPUT_ROOT = path.resolve('.interview-data/step4-output');
const EVIDENCE_DIR = path.resolve('evidence');
const FRAME_DIR = path.join(EVIDENCE_DIR, 'step4-frames');
const STORYBOARD_FILE = 'assets/storyboard.json';
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

function fail(message: string): never {
  throw new Error(message);
}

async function readJson(file: string): Promise<any> {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function ffmpegRun(args: string[]): Promise<{code: number; stderr: string}> {
  if (!ffmpegStatic) fail('ffmpeg_static_missing');
  try {
    const result = await execFileAsync(ffmpegStatic, args, {
      encoding: 'utf8', timeout: 600_000, maxBuffer: 32 * 1024 * 1024,
    });
    return {code: 0, stderr: String(result.stderr || '')};
  } catch (error) {
    const value = error as {code?: number; stderr?: string};
    return {code: typeof value.code === 'number' ? value.code : 1, stderr: String(value.stderr || '')};
  }
}

async function buildVoiceover(plan: Step4Plan, outFile: string): Promise<{sha256: string; bytes: number}> {
  const narration = plan.shots.filter(shot => shot.kind === 'illustration' && shot.narrationFile);
  if (!narration.length) fail('step4_voiceover_has_no_narration');
  const args = ['-y', '-hide_banner', '-nostdin'];
  for (const shot of narration) args.push('-i', shot.narrationFile!);
  const filters = narration.map((shot, index) => {
    const delay = Math.round(shot.startSeconds * 1000);
    return `[${index}:a]aformat=sample_rates=44100:channel_layouts=stereo,adelay=${delay}|${delay}[n${index}]`;
  });
  filters.push(`${narration.map((_, index) => `[n${index}]`).join('')}amix=inputs=${narration.length}:duration=longest:normalize=0,apad,atrim=duration=${plan.totalDurationSeconds.toFixed(3)},asetpts=PTS-STARTPTS[aout]`);
  args.push('-filter_complex', filters.join(';'), '-map', '[aout]',
    '-t', plan.totalDurationSeconds.toFixed(3), '-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '2', outFile);
  const run = await ffmpegRun(args);
  if (run.code !== 0) fail(`step4_voiceover_build_failed:${run.stderr.slice(-400)}`);
  const bytes = await fs.readFile(outFile);
  if (bytes.length < 10_000) fail('step4_voiceover_file_too_small');
  return {sha256: sha(bytes), bytes: bytes.length};
}

async function collectInputs() {
  const storyboardRead = await readStoryboardFile(STORYBOARD_FILE, {checkLocalFiles: true});
  if (!storyboardRead.ok || !storyboardRead.storyboard || !storyboardRead.sha256) fail('storyboard_invalid');
  const storyboard = storyboardRead.storyboard;
  const presenterFiles: Record<string, {file: string; durationSeconds: number}> = {};
  const narrationFiles: Record<string, {file: string; durationSeconds: number}> = {};
  const provider: Record<string, any> = {};
  for (const shot of storyboard.shots) {
    if (shot.kind === 'presenter') {
      const state = await readJson(path.join(STEP_ROOT, shot.id, 'state.json'));
      if (state.phase !== 'downloaded') fail(`step4_presenter_not_downloaded:${shot.id}`);
      if (state.shotId !== shot.id || state.storyboardSha256 !== storyboardRead.sha256) fail(`step4_presenter_state_drift:${shot.id}`);
      if (state.validation?.errors?.length) fail(`step4_presenter_validation_failed:${shot.id}:${state.validation.errors.join(',')}`);
      const file = path.join(STEP_ROOT, shot.id, 'provider-output.mp4');
      const stat = await fs.stat(file);
      const bytes = await fs.readFile(file);
      if (sha(bytes) !== state.mediaSha256) fail(`step4_presenter_media_hash_drift:${shot.id}`);
      presenterFiles[shot.id] = {file, durationSeconds: Number(state.duration)};
      provider[shot.id] = {
        videoId: state.videoId, requestId: state.requestId, requestHash: state.requestHash,
        duration: state.duration, mediaSha256: state.mediaSha256, mediaBytes: stat.size,
        fit: state.fit, barAnalysis: state.barAnalysis, validation: state.validation,
        chargedCny: state.chargedCny, observedWalletDeltaCny: state.observedWalletDeltaCny,
        providerStatus: state.providerStatus, submittedAt: state.submittedAt, completedAt: state.completedAt,
      };
    } else if (shot.kind === 'illustration') {
      const state = await readJson(path.join(NARRATION_ROOT, shot.id, 'state.json'));
      if (state.phase !== 'downloaded') fail(`step4_narration_not_downloaded:${shot.id}`);
      if (state.shotId !== shot.id || state.storyboardSha256 !== storyboardRead.sha256) fail(`step4_narration_state_drift:${shot.id}`);
      const file = path.join(NARRATION_ROOT, shot.id, 'narration.mp3');
      const bytes = await fs.readFile(file);
      if (sha(bytes) !== state.audioSha256) fail(`step4_narration_media_hash_drift:${shot.id}`);
      narrationFiles[shot.id] = {file, durationSeconds: Number(state.audioProbe?.duration ?? state.provider?.duration)};
      provider[`narration:${shot.id}`] = {
        requestId: state.requestId, provider: state.provider, engine: state.engine,
        duration: state.provider?.duration, audioSha256: state.audioSha256, audioBytes: state.audioBytes,
        chargedCny: state.chargedCny, observedWalletDeltaCny: state.observedWalletDeltaCny,
      };
    }
  }
  return {storyboardRead, storyboard, presenterFiles, narrationFiles, provider};
}

async function probeFinal(file: string) {
  const run = await ffmpegRun(['-hide_banner', '-nostdin', '-i', file]);
  const stderr = run.stderr;
  const duration = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const video = stderr.match(/Video:\s*([^,\s]+)[^\n]*?(\d{2,5})x(\d{2,5})/);
  const audio = stderr.match(/Audio:\s*([^,\s]+)[^\n]*?(\d+)\s*Hz/);
  const decode = await ffmpegRun(['-hide_banner', '-nostdin', '-v', 'error', '-i', file, '-f', 'null', '-']);
  const durationSeconds = duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : 0;
  return {
    durationSeconds,
    width: video ? Number(video[2]) : 0,
    height: video ? Number(video[3]) : 0,
    videoCodec: video ? video[1].toLowerCase() : '',
    audioCodec: audio ? audio[1].toLowerCase() : '',
    sampleRate: audio ? Number(audio[2]) : null,
    decodable: decode.code === 0,
    decodeTail: decode.stderr.trim().split('\n').slice(-2).join(' | '),
  };
}

async function measureSegment(file: string, start: number, duration: number): Promise<{meanVolumeDb: number | null; maxVolumeDb: number | null}> {
  const run = await ffmpegRun(['-hide_banner', '-nostdin', '-ss', start.toFixed(3), '-t', duration.toFixed(3),
    '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-']);
  const mean = run.stderr.match(/mean_volume:\s*(-?[\d.]+)\s*dB/);
  const max = run.stderr.match(/max_volume:\s*(-?[\d.]+)\s*dB/);
  return {
    meanVolumeDb: mean ? Number(mean[1]) : null,
    maxVolumeDb: max ? Number(max[1]) : null,
  };
}

async function extractFrame(file: string, at: number, output: string): Promise<number> {
  await fs.mkdir(path.dirname(output), {recursive: true});
  const run = await ffmpegRun(['-y', '-hide_banner', '-nostdin', '-ss', at.toFixed(3), '-i', file,
    '-frames:v', '1', '-vf', 'scale=540:-2', output]);
  if (run.code !== 0) fail(`step4_frame_extract_failed:${at}`);
  return (await fs.stat(output)).size;
}

async function main(): Promise<void> {
  await fs.mkdir(COMPOSE_ROOT, {recursive: true, mode: 0o700});
  await fs.mkdir(OUTPUT_ROOT, {recursive: true, mode: 0o700});
  await fs.mkdir(FRAME_DIR, {recursive: true});
  const render = process.argv.includes('--render');
  const {storyboardRead, storyboard, presenterFiles, narrationFiles, provider} = await collectInputs();
  const plan = buildStep4Plan({storyboard, presenterFiles, narrationFiles});
  const planErrors = validateStep4Plan(plan);
  if (planErrors.length) fail(`step4_plan_invalid:${planErrors.join(',')}`);

  const contentHash = sha(JSON.stringify(plan.shots.map(shot => ({
    id: shot.id, start: shot.startSeconds, duration: shot.durationSeconds,
    file: path.relative(process.cwd(), shot.localFile), narration: shot.narrationFile ? path.relative(process.cwd(), shot.narrationFile) : null,
  }))));
  const jobId = `step4-${contentHash.slice(0, 12)}`;
  const voiceoverFile = path.join(COMPOSE_ROOT, 'voiceover.wav');
  const voiceover = await buildVoiceover(plan, voiceoverFile);
  const manifest = buildStep4RenderManifest({plan, jobId});
  (manifest as any).voiceover = {url: voiceoverFile};
  const manifestFile = path.join(COMPOSE_ROOT, 'manifest.json');
  const manifestText = JSON.stringify(manifest, null, 2);
  await fs.writeFile(manifestFile, manifestText, {mode: 0o600});
  const planFile = path.join(COMPOSE_ROOT, 'plan.json');
  await fs.writeFile(planFile, JSON.stringify({plan, storyboardSha256: storyboardRead.sha256, jobId,
    voiceover: {file: path.relative(process.cwd(), voiceoverFile), ...voiceover}}, null, 2), {mode: 0o600});
  console.log(JSON.stringify({
    status: 'planned_no_render', jobId, duration: plan.totalDurationSeconds,
    presenterShots: plan.presenterShots, illustrationShots: plan.illustrationShots,
    shots: plan.shots.map(shot => ({id: shot.id, kind: shot.kind, start: shot.startSeconds,
      end: shot.endSeconds, duration: shot.durationSeconds, narration: shot.narrationDurationSeconds})),
    voiceoverSha256: voiceover.sha256, manifestSha256: sha(manifestText),
    files: {plan: path.relative(process.cwd(), planFile), manifest: path.relative(process.cwd(), manifestFile)},
  }));

  if (!render) return;
  console.log('step4_render_starting');
  const result = await composite(manifest, pct => {
    if (pct === 100 || pct % 10 === 0) console.error(`step4_render_progress=${pct}`);
  }, OUTPUT_ROOT);
  if (!result.ok || !result.outputPath) fail(`step4_render_failed:${result.error || 'unknown'}`);

  const finalFile = result.outputPath;
  const finalBytes = await fs.readFile(finalFile);
  const finalSha256 = sha(finalBytes);
  const finalProbe = await probeFinal(finalFile);
  const errors: string[] = [];
  if (!(finalProbe.durationSeconds >= 30 && finalProbe.durationSeconds <= 37)) errors.push('final_duration_out_of_range');
  if (Math.abs(finalProbe.durationSeconds - plan.totalDurationSeconds) > 0.35) errors.push('final_duration_plan_mismatch');
  if (finalProbe.width !== 1080 || finalProbe.height !== 1920) errors.push('final_resolution_not_1080x1920');
  if (finalProbe.videoCodec !== 'h264') errors.push('final_video_codec_not_h264');
  if (finalProbe.audioCodec !== 'aac') errors.push('final_audio_codec_not_aac');
  if (!finalProbe.decodable) errors.push('final_decode_failed');

  const segmentAudio: Array<{id: string; start: number; duration: number; meanVolumeDb: number | null; maxVolumeDb: number | null}> = [];
  for (const shot of plan.shots) {
    const level = await measureSegment(finalFile, shot.startSeconds, shot.durationSeconds);
    segmentAudio.push({id: shot.id, start: shot.startSeconds, duration: shot.durationSeconds, ...level});
    if (level.meanVolumeDb === null || level.meanVolumeDb < -50) errors.push(`segment_silent:${shot.id}`);
  }
  const frames: Array<{id: string; at: number; file: string; bytes: number}> = [];
  for (const shot of plan.shots) {
    const at = Math.min(plan.totalDurationSeconds - 0.2, shot.startSeconds + shot.durationSeconds / 2);
    const output = path.join(FRAME_DIR, `${shot.id}.png`);
    const bytes = await extractFrame(finalFile, at, output);
    frames.push({id: shot.id, at, file: path.relative(process.cwd(), output), bytes});
  }

  const evidenceMp4 = path.join(EVIDENCE_DIR, 'step4-final.mp4');
  await fs.copyFile(finalFile, evidenceMp4);
  const budget = await readJson(path.join(STEP_ROOT, 'budget.json'));
  const sanitized = {
    schemaVersion: 1,
    mode: 'step4_multishot_composition',
    jobId,
    storyboardPath: STORYBOARD_FILE,
    storyboardSha256: storyboardRead.sha256,
    plan,
    timeline: plan.shots.map(shot => ({
      id: shot.id, kind: shot.kind, startSeconds: shot.startSeconds, endSeconds: shot.endSeconds,
      durationSeconds: shot.durationSeconds, speech: shot.speech, subtitle: shot.subtitle,
    })),
    sources: plan.shots.map(shot => ({
      id: shot.id, kind: shot.kind, file: path.relative(process.cwd(), shot.localFile),
      narrationFile: shot.narrationFile ? path.relative(process.cwd(), shot.narrationFile) : null,
      narrationDurationSeconds: shot.narrationDurationSeconds,
    })),
    provider,
    voiceover: {file: path.relative(process.cwd(), voiceoverFile), sha256: voiceover.sha256, bytes: voiceover.bytes},
    manifest: {file: path.relative(process.cwd(), manifestFile), sha256: sha(manifestText)},
    budget: {
      approvedCny: budget.approvedCny, chargedCny: budget.chargedCny,
      reservedCny: budget.reservedCny, paidSubmissions: budget.paidSubmissions,
      operations: budget.operations,
    },
    final: {
      file: 'evidence/step4-final.mp4', outputPath: path.relative(process.cwd(), finalFile),
      bytes: finalBytes.length, sha256: finalSha256,
      durationSeconds: finalProbe.durationSeconds, width: finalProbe.width, height: finalProbe.height,
      videoCodec: finalProbe.videoCodec, audioCodec: finalProbe.audioCodec,
      sampleRate: finalProbe.sampleRate, decodable: finalProbe.decodable,
      frameCount: Math.round(finalProbe.durationSeconds * 30),
      segmentAudio, frames, errors,
    },
    verified: {
      presenterShots: plan.presenterShots, illustrationShots: plan.illustrationShots,
      subtitles: 'burned from manifest cues by desktop/render.cjs',
      fitCover: plan.shots.filter(shot => shot.kind === 'presenter').every(shot => provider[shot.id]?.fit === 'cover'),
      allSegmentsAudible: segmentAudio.every(item => (item.meanVolumeDb ?? -999) >= -50),
      noPresenterBars: plan.shots.filter(shot => shot.kind === 'presenter').every(shot => {
        const bars = provider[shot.id]?.barAnalysis;
        return !bars || (bars.topBarPx <= bars.height * 0.05 && bars.bottomBarPx <= bars.height * 0.05
          && bars.leftBarPx <= bars.width * 0.05 && bars.rightBarPx <= bars.width * 0.05);
      }),
      withinApprovedCap: budget.chargedCny + budget.reservedCny <= budget.approvedCny,
    },
    notes: [
      'Presenter video is generated by HeyGen from the storyboard public avatar/voice with fit=cover; 720p source is upscaled to 1080x1920 by the compositor.',
      'Explainer visuals are original local illustrations; narration uses the same public voice through HeyGen speech.',
      'Numbers such as 15 years, low MOQ and per-batch testing are demo copy from the storyboard, not verified client facts.',
      'This is the isolated Step 4 composition. Business task write-back and workbench playback belong to later steps.',
    ],
    createdAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(EVIDENCE_DIR, 'step4-final.json'), JSON.stringify(sanitized, null, 2), {mode: 0o600});
  await fs.writeFile(path.join(EVIDENCE_DIR, 'step4-manifest.json'), JSON.stringify(manifest, null, 2), {mode: 0o600});
  console.log(JSON.stringify({
    status: errors.length ? 'rendered_with_errors' : 'rendered',
    jobId, final: evidenceMp4, bytes: finalBytes.length, sha256: finalSha256,
    duration: finalProbe.durationSeconds, resolution: `${finalProbe.width}x${finalProbe.height}`,
    videoCodec: finalProbe.videoCodec, audioCodec: finalProbe.audioCodec,
    errors, segmentAudio, frames,
    budget: {approvedCny: budget.approvedCny, chargedCny: budget.chargedCny, paidSubmissions: budget.paidSubmissions},
    evidence: {mp4: 'evidence/step4-final.mp4', json: 'evidence/step4-final.json', manifest: 'evidence/step4-manifest.json'},
  }));
  if (errors.length) process.exitCode = 1;
}

main().catch(error => {
  console.error(String(error instanceof Error ? error.message : error).replace(/https?:\/\/\S+/g, '[redacted-url]').slice(0, 1200));
  process.exitCode = 1;
});
