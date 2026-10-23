/**
 * Pure Step 4 timeline and manifest planning.
 *
 * The storyboard is the authored plan; the generated presenter clips and TTS
 * audio are the measured inputs. This module reconciles them into a contiguous
 * 30-37 s timeline, then emits the manifest consumed by desktop/render.cjs.
 * It performs no I/O and no spending.
 */

export interface Step4StoryboardShot {
  id: string;
  kind: 'presenter' | 'illustration';
  startSeconds: number;
  durationSeconds: number;
  speech: string;
  subtitle: string;
  framing: string;
  source?: {localFile?: string} | null;
}

export interface Step4Storyboard {
  targetDurationSeconds: number;
  language: string;
  shots: Step4StoryboardShot[];
}

export interface Step4PlanShot {
  id: string;
  kind: 'presenter' | 'illustration';
  speech: string;
  subtitle: string;
  framing: string;
  startSeconds: number;
  durationSeconds: number;
  endSeconds: number;
  localFile: string;
  measuredDurationSeconds: number;
  narrationDurationSeconds: number | null;
  narrationFile: string | null;
}

export interface Step4Plan {
  schemaVersion: 1;
  language: string;
  totalDurationSeconds: number;
  preferredDurationSeconds: number;
  presenterShots: number;
  illustrationShots: number;
  shots: Step4PlanShot[];
}

export interface Step4PlanInput {
  storyboard: Step4Storyboard;
  presenterFiles: Record<string, {file: string; durationSeconds: number}>;
  narrationFiles: Record<string, {file: string; durationSeconds: number}>;
  preferredDurationSeconds?: number;
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;
const MIN_TOTAL = 30;
const MAX_TOTAL = 37;

function fail(message: string): never {
  throw new Error(message);
}

/**
 * Build the final timeline.
 *
 * - Presenter shots keep their measured duration so speech is never cut or
 *   time-stretched.
 * - Illustration shots last at least their storyboard duration and always
 *   outlast their narration by a small tail.
 * - If the sum is below 30 s, illustration tails absorb the difference. If it
 *   is above 37 s, illustration tails shrink to +0.15 s over narration; a
 *   presenter-driven overrun is a hard failure rather than silently cutting
 *   approved speech.
 */
export function buildStep4Plan(input: Step4PlanInput): Step4Plan {
  const {storyboard} = input;
  if (!Array.isArray(storyboard.shots) || !storyboard.shots.length) fail('step4_storyboard_shots_missing');
  const preferred = round3(input.preferredDurationSeconds ?? storyboard.targetDurationSeconds ?? 33.5);
  const shots: Step4PlanShot[] = [];

  for (const shot of storyboard.shots) {
    if (shot.kind === 'presenter') {
      const measured = round3(Number(input.presenterFiles[shot.id]?.durationSeconds));
      if (!input.presenterFiles[shot.id]?.file) fail(`step4_presenter_media_missing:${shot.id}`);
      if (!(measured >= 2 && measured <= 12)) fail(`step4_presenter_duration_invalid:${shot.id}`);
      shots.push({
        id: shot.id, kind: shot.kind, speech: shot.speech, subtitle: shot.subtitle,
        framing: shot.framing, startSeconds: 0, durationSeconds: measured, endSeconds: 0,
        localFile: input.presenterFiles[shot.id]!.file,
        measuredDurationSeconds: measured, narrationDurationSeconds: null, narrationFile: null,
      });
    } else if (shot.kind === 'illustration') {
      const narration = input.narrationFiles[shot.id];
      if (!narration?.file) fail(`step4_narration_missing:${shot.id}`);
      const narrationDuration = round3(Number(narration.durationSeconds));
      if (!(narrationDuration > 0 && narrationDuration <= 20)) fail(`step4_narration_duration_invalid:${shot.id}`);
      if (!shot.source?.localFile) fail(`step4_illustration_source_missing:${shot.id}`);
      const duration = round3(Math.max(Number(shot.durationSeconds) || 0, narrationDuration + 0.35));
      if (!(duration >= narrationDuration + 0.15)) fail(`step4_illustration_shorter_than_narration:${shot.id}`);
      shots.push({
        id: shot.id, kind: shot.kind, speech: shot.speech, subtitle: shot.subtitle,
        framing: shot.framing, startSeconds: 0, durationSeconds: duration, endSeconds: 0,
        localFile: shot.source.localFile, measuredDurationSeconds: duration,
        narrationDurationSeconds: narrationDuration, narrationFile: narration.file,
      });
    } else {
      fail(`step4_unknown_shot_kind:${shot.id}`);
    }
  }

  const sum = () => round3(shots.reduce((total, shot) => total + shot.durationSeconds, 0));
  const presenters = shots.filter(shot => shot.kind === 'presenter');
  const illustrations = shots.filter(shot => shot.kind === 'illustration');
  if (presenters.length < 2 || illustrations.length < 2) fail('step4_requires_at_least_two_presenter_and_two_illustration_shots');

  // Grow the illustration tails first: they are static graphics, so holding
  // them longer preserves every spoken word. Presenter clips never change.
  if (sum() < MIN_TOTAL && illustrations.length) {
    let deficit = round3(MIN_TOTAL - sum());
    for (let index = 0; index < illustrations.length && deficit > 0; index += 1) {
      const shot = illustrations[index]!;
      const headroom = Math.max(0, round3(MAX_TOTAL - sum()));
      const add = Math.min(deficit, Math.min(4, headroom));
      shot.durationSeconds = round3(shot.durationSeconds + add);
      deficit = round3(deficit - add);
    }
    if (sum() < MIN_TOTAL) fail('step4_cannot_reach_minimum_duration_without_cutting_speech');
  }

  if (sum() > MAX_TOTAL) {
    let excess = round3(sum() - MAX_TOTAL);
    for (let index = illustrations.length - 1; index >= 0 && excess > 0; index -= 1) {
      const shot = illustrations[index]!;
      const minimum = round3((shot.narrationDurationSeconds ?? 0) + 0.15);
      const removable = Math.max(0, round3(shot.durationSeconds - minimum));
      const cut = Math.min(excess, removable);
      shot.durationSeconds = round3(shot.durationSeconds - cut);
      excess = round3(excess - cut);
    }
    if (sum() > MAX_TOTAL) fail('step4_presenter_speech_exceeds_maximum_duration');
  }

  // Prefer the authored 33.5 s target when the measured clips leave room.
  if (sum() < preferred && preferred <= MAX_TOTAL) {
    let deficit = round3(preferred - sum());
    for (let index = 0; index < illustrations.length && deficit > 0; index += 1) {
      const shot = illustrations[index]!;
      const storyboardTail = Math.max(0, round3(Number(storyboard.shots.find(item => item.id === shot.id)?.durationSeconds || 0) + 2.5 - shot.durationSeconds));
      const add = Math.min(deficit, storyboardTail, round3(MAX_TOTAL - sum()));
      shot.durationSeconds = round3(shot.durationSeconds + add);
      deficit = round3(deficit - add);
    }
  }

  let cursor = 0;
  for (const shot of shots) {
    shot.startSeconds = round3(cursor);
    shot.endSeconds = round3(cursor + shot.durationSeconds);
    cursor = shot.endSeconds;
  }
  const totalDurationSeconds = round3(cursor);
  if (!(totalDurationSeconds >= MIN_TOTAL && totalDurationSeconds <= MAX_TOTAL))
    fail(`step4_total_out_of_range:${totalDurationSeconds}`);
  for (const shot of shots) {
    if (!(shot.durationSeconds > 0) || shot.endSeconds <= shot.startSeconds)
      fail(`step4_shot_timing_invalid:${shot.id}`);
  }

  return {
    schemaVersion: 1, language: storyboard.language, totalDurationSeconds,
    preferredDurationSeconds: preferred,
    presenterShots: presenters.length, illustrationShots: illustrations.length,
    shots,
  };
}

export interface Step4ManifestInput {
  plan: Step4Plan;
  jobId: string;
}

export function buildStep4RenderManifest(input: Step4ManifestInput): Record<string, unknown> {
  const {plan} = input;
  const duration = plan.totalDurationSeconds;
  const timeline = plan.shots.map(shot => shot.kind === 'presenter'
    ? {
        url: shot.localFile, type: 'video', sceneId: shot.id,
        targetStart: shot.startSeconds, targetDuration: shot.durationSeconds,
        trimStart: 0, trimEnd: shot.measuredDurationSeconds, speed: 1, cropMode: 'cover',
        production: {sound: 'source'},
      }
    : {
        url: shot.localFile, type: 'image', sceneId: shot.id,
        targetStart: shot.startSeconds, targetDuration: shot.durationSeconds,
        production: {sound: 'voiceover'},
        voiceAligned: true,
        voiceStart: shot.startSeconds,
        voiceEnd: round3(shot.startSeconds + (shot.narrationDurationSeconds ?? 0)),
      });
  const cues = plan.shots.map((shot, index) => ({
    start: round3(shot.startSeconds + (index === 0 ? 0.1 : 0.08)),
    end: round3(Math.max(shot.startSeconds + 0.5, shot.endSeconds - 0.08)),
    text: shot.subtitle,
  }));
  return {
    schemaVersion: 'step4-multishot-manifest.v1',
    jobId: input.jobId,
    spec: {
      duration, ratio: '9:16', resolution: '1080p',
      bgmVol: 0, voiceVol: 100,
    },
    frameContract: {
      schemaVersion: 'social-render-frame-contract.v1',
      fps: 30, durationSeconds: duration, expectedFrames: Math.round(duration * 30),
    },
    requireVisualAssets: true,
    timeline,
    subtitles: {
      mode: 'on',
      cues,
      style: {font: 'sans', fontScale: 1.3, bottomRatio: 0.2, lineWidth: 12},
    },
  };
}

/** Contiguous, subtitle-bearing, 30-37 s, >=2 presenter + >=2 illustration. */
export function validateStep4Plan(plan: Step4Plan): string[] {
  const errors: string[] = [];
  if (!(plan.totalDurationSeconds >= MIN_TOTAL && plan.totalDurationSeconds <= MAX_TOTAL))
    errors.push('total_out_of_range');
  if (plan.presenterShots < 2) errors.push('presenter_shots_lt_2');
  if (plan.illustrationShots < 2) errors.push('illustration_shots_lt_2');
  let cursor = 0;
  for (const shot of plan.shots) {
    if (Math.abs(shot.startSeconds - cursor) > 1e-6) errors.push(`not_contiguous:${shot.id}`);
    if (!(shot.durationSeconds > 0)) errors.push(`non_positive_duration:${shot.id}`);
    if (!String(shot.subtitle || '').trim()) errors.push(`subtitle_missing:${shot.id}`);
    if (shot.kind === 'illustration' && shot.narrationDurationSeconds !== null
      && shot.narrationDurationSeconds > shot.durationSeconds - 0.1) errors.push(`narration_overruns_shot:${shot.id}`);
    cursor = shot.endSeconds;
  }
  if (Math.abs(cursor - plan.totalDurationSeconds) > 1e-6) errors.push('timeline_sum_mismatch');
  return errors;
}
