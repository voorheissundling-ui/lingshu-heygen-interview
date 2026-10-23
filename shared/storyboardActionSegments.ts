import type { StoryboardShotSpec } from './storyboardShotSpec';

/** An observed or explicitly approved state AFTER the numbered beat. */
export interface StoryboardKeyState {
  afterBeat: number;
  description: string;
  source: 'confirmed_reference_analysis' | 'confirmed_storyboard' | 'approved_generated_frame';
  /** A usable image must be attached before a segment can be submitted. */
  imageAssetId?: string;
}

export interface StoryboardVideoCapability {
  minDurationSeconds: number;
  maxDurationSeconds: number;
  integerDurationSeconds: boolean;
  supportsFirstFrame: boolean;
  supportsEndFrame: boolean;
}

export interface StoryboardActionSegment {
  index: number;
  beatStart: number;
  beatEnd: number;
  beats: string[];
  startState: string;
  endState: string;
  targetDurationSeconds: number;
  providerDurationSeconds: number;
  /** Only a verified completed tail may be trimmed at assembly. */
  trimTailSeconds: number;
  startImageAssetId: string | null;
  endImageAssetId: string | null;
  requiresStartFrame: true;
  requiresEndFrameQualityGate: true;
}

export type StoryboardActionSegmentPlan =
  | { status: 'blocked'; reason: string; missingAfterBeats: number[] }
  | {
      status: 'planned';
      segments: StoryboardActionSegment[];
      totalProviderDurationSeconds: number;
      requiresSequentialGeneration: boolean;
      /** First-frame-only providers cannot force the planned end state. */
      endStateConditioning: 'provider' | 'quality_gate_only';
      readyForSubmission: boolean;
    };

const finitePositive = (value: number): boolean => Number.isFinite(value) && value > 0;
const rounded = (value: number): number => Math.round(value * 1000) / 1000;

/**
 * Plans one or more action clips without inventing unseen intermediate states.
 * A split requires a documented key state at every seam. Planning never claims
 * that a text prompt or a first frame alone guarantees an action's end state.
 */
export function planStoryboardActionSegments(input: {
  shot: StoryboardShotSpec;
  capability: StoryboardVideoCapability;
  keyStates?: StoryboardKeyState[];
  firstFrameAssetId?: string;
  beatDurationsSeconds?: number[];
  /** Use every confirmed intermediate state as a QA seam, even when one provider clip could fit the full duration. */
  requireKeyStateSegments?: boolean;
}): StoryboardActionSegmentPlan {
  const { shot, capability } = input;
  const beats = shot.action.beats;
  if (shot.scene !== 'usage') return { status: 'blocked', reason: 'not_usage_scene', missingAfterBeats: [] };
  if (!shot.action.startState || !shot.action.endState || !beats.length)
    return { status: 'blocked', reason: 'missing_action_states', missingAfterBeats: [] };
  if (!finitePositive(shot.targetDurationSeconds) || !finitePositive(capability.minDurationSeconds)
      || !finitePositive(capability.maxDurationSeconds) || capability.maxDurationSeconds < capability.minDurationSeconds)
    return { status: 'blocked', reason: 'invalid_duration_or_capability', missingAfterBeats: [] };
  if (!capability.supportsFirstFrame) return { status: 'blocked', reason: 'provider_missing_first_frame', missingAfterBeats: [] };
  if (input.beatDurationsSeconds && (input.beatDurationsSeconds.length !== beats.length
      || input.beatDurationsSeconds.some(value => !finitePositive(value))
      || Math.abs(input.beatDurationsSeconds.reduce((sum, value) => sum + value, 0) - shot.targetDurationSeconds) > .001))
    return { status: 'blocked', reason: 'invalid_beat_durations', missingAfterBeats: [] };

  const durations = input.beatDurationsSeconds ?? (Number.isInteger(shot.targetDurationSeconds)
    ? beats.map((_, index) => Math.floor(shot.targetDurationSeconds / beats.length)
      + (index < shot.targetDurationSeconds % beats.length ? 1 : 0))
    : beats.map(() => shot.targetDurationSeconds / beats.length));
  const states = new Map<number, StoryboardKeyState>();
  for (const state of input.keyStates ?? []) {
    if (!Number.isInteger(state.afterBeat) || state.afterBeat < 1 || state.afterBeat >= beats.length
        || !state.description?.trim() || state.source === 'approved_generated_frame' && !state.imageAssetId?.trim()
        || states.has(state.afterBeat))
      return { status: 'blocked', reason: 'invalid_key_state', missingAfterBeats: [] };
    states.set(state.afterBeat, state);
  }

  // Only explicit, evidenced states may become a cut point. The final state
  // comes from the confirmed shot specification, not a generated inference.
  const boundaries = [0, ...[...states.keys()].sort((a, b) => a - b), beats.length];
  const cumulative = [0];
  for (const duration of durations) cumulative.push(rounded(cumulative[cumulative.length - 1]! + duration));
  type Candidate = { cuts: number[]; providerTotal: number };
  const best: Array<Candidate | null> = Array(boundaries.length).fill(null);
  best[0] = { cuts: [], providerTotal: 0 };
  for (let end = 1; end < boundaries.length; end++) {
    for (let start = 0; start < end; start++) {
      if (input.requireKeyStateSegments && end !== start + 1) continue;
      const previous = best[start];
      if (!previous) continue;
      const duration = rounded(cumulative[boundaries[end]!]! - cumulative[boundaries[start]!]!);
      const providerDuration = capability.integerDurationSeconds ? Math.ceil(duration - 1e-9) : duration;
      if (providerDuration < capability.minDurationSeconds || providerDuration > capability.maxDurationSeconds) continue;
      const candidate: Candidate = { cuts: [...previous.cuts, end], providerTotal: previous.providerTotal + providerDuration };
      const incumbent = best[end];
      if (!incumbent || candidate.cuts.length < incumbent.cuts.length
          || candidate.cuts.length === incumbent.cuts.length && candidate.providerTotal < incumbent.providerTotal)
        best[end] = candidate;
    }
  }
  const chosen = best[boundaries.length - 1];
  if (!chosen) {
    const missingAfterBeats = beats.map((_, index) => index + 1).filter(index => index < beats.length && !states.has(index));
    return { status: 'blocked', reason: missingAfterBeats.length ? 'missing_split_key_states' : 'unsupported_segment_duration', missingAfterBeats };
  }

  const segments: StoryboardActionSegment[] = [];
  let previous = 0;
  for (const cut of chosen.cuts) {
    const from = boundaries[previous]!;
    const to = boundaries[cut]!;
    const targetDuration = rounded(cumulative[to]! - cumulative[from]!);
    const providerDuration = capability.integerDurationSeconds ? Math.ceil(targetDuration - 1e-9) : targetDuration;
    const start = from ? states.get(from)! : null;
    const end = to < beats.length ? states.get(to)! : null;
    segments.push({
      index: segments.length, beatStart: from + 1, beatEnd: to,
      beats: beats.slice(from, to),
      startState: start?.description ?? shot.action.startState,
      endState: end?.description ?? shot.action.endState,
      targetDurationSeconds: targetDuration,
      providerDurationSeconds: providerDuration,
      trimTailSeconds: rounded(providerDuration - targetDuration),
      startImageAssetId: (start?.imageAssetId ?? (from === 0 ? input.firstFrameAssetId : undefined))?.trim() || null,
      endImageAssetId: end?.imageAssetId?.trim() || null,
      requiresStartFrame: true,
      requiresEndFrameQualityGate: true,
    });
    previous = cut;
  }
  return {
    status: 'planned', segments,
    totalProviderDurationSeconds: rounded(segments.reduce((sum, segment) => sum + segment.providerDurationSeconds, 0)),
    requiresSequentialGeneration: segments.length > 1,
    endStateConditioning: capability.supportsEndFrame ? 'provider' : 'quality_gate_only',
    readyForSubmission: Boolean(input.firstFrameAssetId?.trim()) && segments.every((segment, index) => index === 0 || Boolean(segment.startImageAssetId)),
  };
}
