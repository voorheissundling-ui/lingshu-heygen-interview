import type { SocialReplicationScriptShot, SocialReplicationScriptVersion } from '../../shared/contracts/socialContentWorkflow.js';

export type PresenterProductAction = 'none' | 'pick_up' | 'put_down' | 'rotate' | 'move_toward_camera' | 'detail_display' | 'holding_still';

/** Verified, time-coded output of the dense-frame presenter classifier. */
export interface PresenterTemporalObservation {
  startSeconds: number;
  endSeconds: number;
  subject: 'presenter' | 'non_presenter' | 'unknown';
  motion: 'stable' | 'dynamic' | 'unknown';
  productAction: PresenterProductAction;
  /** Maximum time between adjacent inspected frames in this interval. */
  sampleIntervalSeconds: number;
  frameRefs: string[];
}

export interface PresenterTemporalSplitResult {
  script: SocialReplicationScriptVersion;
  splitShotIds: string[];
  blockedShotIds: string[];
  pipelineByShotId: Record<string, 'dynamic_presenter' | 'heygen'>;
}

type ExactPresenterDetail = {
  referenceShotId: string;
  startSeconds: number;
  endSeconds: number;
  detail: Record<string, unknown>;
  clipRef: string | null;
};

/** Legacy exact-analysis text does not carry decoded-frame semantic evidence. */
export function presenterTemporalObservationsFromExactAnalysis(input: {
  script: SocialReplicationScriptVersion;
  details: ExactPresenterDetail[];
  denseSampling: { intervalSeconds: number; ranges: Array<{ startSeconds: number; endSeconds: number }> } | null;
}): Record<string, PresenterTemporalObservation[]> {
  // `presenterDenseSampling` is model/analysis metadata, not a decoded-frame
  // ledger. A clip URL fragment is not a frame reference. A real decoded-frame
  // ledger still proves only pixels and timing, not presenter/product semantics.
  // Do not infer a production route from beats prose.
  void input;
  return {};
}

export function applyExactPresenterTemporalSplit(input: {
  script: SocialReplicationScriptVersion;
  presenterDenseSampling: unknown;
  details: Array<{ timing: { startSeconds: number; endSeconds: number }; detail: Record<string, unknown> }>;
  referenceShotIds: string[];
}): SocialReplicationScriptVersion {
  const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const dense = object(input.presenterDenseSampling);
  const denseRanges = Array.isArray(dense.ranges) ? dense.ranges.map(object).flatMap(item => {
    const startSeconds = Number(item.startSeconds), endSeconds = Number(item.endSeconds);
    return Number.isFinite(startSeconds) && endSeconds > startSeconds ? [{ startSeconds, endSeconds }] : [];
  }) : [];
  const observationsByShotId = presenterTemporalObservationsFromExactAnalysis({
    script: input.script,
    denseSampling: denseRanges.length ? { intervalSeconds: Number(dense.intervalSeconds), ranges: denseRanges } : null,
    details: input.details.map((row, index) => {
      const evidence = object(row.detail.materialEvidence);
      return { referenceShotId: input.referenceShotIds[index]!, startSeconds: row.timing.startSeconds,
        endSeconds: row.timing.endSeconds, detail: row.detail,
        clipRef: typeof evidence.clipRef === 'string' && evidence.clipRef.trim() ? evidence.clipRef.trim() : null };
    }),
  });
  return Object.keys(observationsByShotId).length
    ? splitPresenterTemporalShots({ script: input.script, observationsByShotId }).script
    : input.script;
}

const ACTIVE_PRODUCT_ACTIONS = new Set<PresenterProductAction>([
  'pick_up', 'put_down', 'rotate', 'move_toward_camera', 'detail_display', 'holding_still',
]);

function validDenseCoverage(shot: SocialReplicationScriptShot, rows: PresenterTemporalObservation[]) {
  if (!rows.length || rows.some(row => row.subject !== 'presenter' || row.motion === 'unknown'
    || row.frameRefs.length < 2 || !Number.isFinite(row.sampleIntervalSeconds)
    || row.sampleIntervalSeconds <= 0 || row.sampleIntervalSeconds > 0.5
    || row.endSeconds <= row.startSeconds)) return false;
  const sorted = [...rows].sort((a, b) => a.startSeconds - b.startSeconds);
  if (Math.abs(sorted[0]!.startSeconds - shot.startSeconds) > 0.05
    || Math.abs(sorted.at(-1)!.endSeconds - shot.endSeconds) > 0.05) return false;
  return sorted.every((row, index) => index === 0
    || Math.abs(row.startSeconds - sorted[index - 1]!.endSeconds) <= 0.05);
}

function state(row: PresenterTemporalObservation): 'stable' | 'dynamic' {
  return row.motion === 'dynamic' || ACTIVE_PRODUCT_ACTIONS.has(row.productAction) ? 'dynamic' : 'stable';
}

function splitOne(shot: SocialReplicationScriptShot, observations: PresenterTemporalObservation[]) {
  if (!validDenseCoverage(shot, observations)) return { shots: [shot], blocked: observations.length > 0, routes: {} };
  const sorted = [...observations].sort((a, b) => a.startSeconds - b.startSeconds);
  const groups: Array<{ startSeconds: number; endSeconds: number; route: 'stable' | 'dynamic' }> = [];
  for (const row of sorted) {
    const route = state(row);
    const last = groups.at(-1);
    if (last?.route === route) last.endSeconds = row.endSeconds;
    else groups.push({ startSeconds: row.startSeconds, endSeconds: row.endSeconds, route });
  }
  if (groups.length < 2) return { shots: [shot], blocked: false,
    routes: { [shot.shotId]: groups[0]?.route === 'dynamic' ? 'dynamic_presenter' as const : 'heygen' as const } };
  const ids = groups.map((_, index) => `${shot.shotId}__part-${String(index + 1).padStart(2, '0')}`);
  const ownerByLine = new Map<string, string>();
  for (const line of shot.speechLines ?? []) {
    const lineKey = line.lineId || `${line.sourceStartSeconds}:${line.sourceEndSeconds}:${line.draftText}`;
    const first = groups.findIndex(group => line.sourceStartSeconds < group.endSeconds && line.sourceEndSeconds > group.startSeconds);
    if (first >= 0) ownerByLine.set(lineKey, line.narrationOwnerShotId === shot.shotId ? ids[first]! : line.narrationOwnerShotId || ids[first]!);
  }
  return { blocked: false, routes: Object.fromEntries(groups.map((group, index) => [ids[index],
    group.route === 'dynamic' ? 'dynamic_presenter' : 'heygen'])) as Record<string, 'dynamic_presenter' | 'heygen'>,
  shots: groups.map((group, index) => {
    const shotId = ids[index]!;
    const speechLines = (shot.speechLines ?? []).filter(line => line.sourceStartSeconds < group.endSeconds
      && line.sourceEndSeconds > group.startSeconds).map(line => {
      const key = line.lineId || `${line.sourceStartSeconds}:${line.sourceEndSeconds}:${line.draftText}`;
      const visualShotIds = groups.flatMap((candidate, candidateIndex) => line.sourceStartSeconds < candidate.endSeconds
        && line.sourceEndSeconds > candidate.startSeconds ? [ids[candidateIndex]!] : []);
      return { ...line, narrationOwnerShotId: ownerByLine.get(key), visualShotIds };
    });
    const owned = speechLines.filter(line => line.narrationOwnerShotId === shotId);
    return {
      ...shot, shotId, startSeconds: group.startSeconds, endSeconds: group.endSeconds,
      visualInstruction: `${shot.visualInstruction} 真人时序分段：${group.route === 'dynamic' ? '动态真人口播' : '稳定真人口播（HeyGen）'}。`,
      spokenText: owned.map(line => line.draftText).join(' ') || null,
      referenceSpokenText: owned.map(line => line.referenceText).join(' ') || null,
      speechLines,
      materialPlan: { ...shot.materialPlan, shotId },
    };
  }) };
}

/**
 * Split presenter shots only. Non-presenter material bypasses dense temporal
 * splitting. Narration is still owned exactly once while every intersecting
 * visual child is retained in visualShotIds.
 */
export function splitPresenterTemporalShots(input: {
  script: SocialReplicationScriptVersion;
  observationsByShotId: Readonly<Record<string, PresenterTemporalObservation[]>>;
}): PresenterTemporalSplitResult {
  const splitShotIds: string[] = [], blockedShotIds: string[] = [];
  const pipelineByShotId: Record<string, 'dynamic_presenter' | 'heygen'> = {};
  const replacements = new Map<string, string[]>();
  const shots = input.script.shots.flatMap(shot => {
    const observations = input.observationsByShotId[shot.shotId] ?? [];
    if (!observations.length || observations.every(row => row.subject === 'non_presenter')) return [shot];
    const result = splitOne(shot, observations);
    Object.assign(pipelineByShotId, result.routes);
    if (result.blocked) blockedShotIds.push(shot.shotId);
    if (result.shots.length > 1) {
      splitShotIds.push(shot.shotId);
      replacements.set(shot.shotId, result.shots.map(item => item.shotId));
    }
    return result.shots;
  });
  const narrationLines = (input.script.narrationLines ?? []).map(line => {
    const visualShotIds = (line.visualShotIds ?? []).flatMap(id => replacements.get(id) ?? [id])
      .filter(id => shots.some(shot => shot.shotId === id && line.sourceStartSeconds < shot.endSeconds && line.sourceEndSeconds > shot.startSeconds));
    const replacement = line.narrationOwnerShotId ? replacements.get(line.narrationOwnerShotId) : undefined;
    return { ...line, visualShotIds, narrationOwnerShotId: replacement?.find(id => visualShotIds.includes(id)) ?? line.narrationOwnerShotId };
  });
  return { script: { ...input.script, shots,
    ...(input.script.narrationLines ? { narrationLines } : {}) }, splitShotIds, blockedShotIds, pipelineByShotId };
}
