/**
 * Single-content Studio historically persisted the same production state twice:
 * once on the project root and once in `analysisResults`.  Different consumers
 * then read different copies.  This module makes the editable project root the
 * only authority and keeps the analysis bundle as a derived compatibility
 * snapshot.
 */

export const STUDIO_PRODUCTION_CONTRACT_VERSION = 'studio-production-contract.v1' as const;

type UnknownRecord = Record<string, any>;

const record = (value: unknown): UnknownRecord => value && typeof value === 'object' && !Array.isArray(value)
  ? value as UnknownRecord
  : {};

const hasOwn = (value: UnknownRecord, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value as UnknownRecord).sort()
    .map(key => [key, stableValue((value as UnknownRecord)[key])]));
}

const sameValue = (left: unknown, right: unknown): boolean =>
  JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));

const MIRRORS = [
  ['script', 'storyboard', 'script', '脚本'],
  ['storyboardAssignments', 'storyboard', 'assignments', '逐镜素材绑定'],
  ['clipEdits', 'storyboard', 'clipEdits', '剪辑参数'],
  ['storyboardSourcePlans', 'storyboard', 'sourcePlans', '逐镜来源方案'],
  ['storyboardAssemblies', 'storyboard', 'assemblies', '成片组合方案'],
  ['voiceoverLines', 'voiceover', 'text', '口播文本'],
  ['voiceDrafts', 'voiceover', 'drafts', '多语言口播草稿'],
  ['voiceoverAudios', 'voiceover', 'audios', '口播音频'],
  ['alignedCuesByLang', 'voiceover', 'alignedCuesByLang', '口播时间码'],
  ['shootingSlots', 'shots', 'shootingSlots', '拍摄时间段'],
  ['shotProductions', 'shots', 'productions', '逐镜生产结果'],
] as const;

function isFrozenProductionSpec(spec: UnknownRecord): boolean {
  return record(spec.resolvedStudioContract).schemaVersion === 'social-frozen-studio.v1';
}

/** Return every conflicting duplicate instead of silently choosing one. */
export function studioProductionSnapshotIssues(value: unknown): string[] {
  const spec = record(value);
  if (isFrozenProductionSpec(spec)) return [];
  const analysis = record(spec.analysisResults);
  if (analysis.schemaVersion !== 'studio-analysis.v1') return [];
  const issues: string[] = [];
  for (const [rootKey, sectionKey, snapshotKey, label] of MIRRORS) {
    const section = record(analysis[sectionKey]);
    if (hasOwn(spec, rootKey) && hasOwn(section, snapshotKey) && !sameValue(spec[rootKey], section[snapshotKey])) {
      issues.push(`${label}存在两个不一致版本`);
    }
  }
  const kickoff = record(spec.videoKickoff);
  if (hasOwn(kickoff, 'referenceAnalysis') && hasOwn(analysis, 'reference')
    && !sameValue(kickoff.referenceAnalysis, analysis.reference)) {
    issues.push('参考视频分析存在两个不一致版本');
  }
  return issues;
}

/**
 * Rebuild the compatibility snapshot from the current project root.  The
 * function is pure and intentionally does not add timestamps, so autosave can
 * still detect a truly unchanged project.
 */
export function reconcileStudioProductionSpec<T extends UnknownRecord>(value: T): T {
  const spec = record(value);
  if (isFrozenProductionSpec(spec)) return value;
  const analysis = record(spec.analysisResults);
  // The authority marker is issued only while reconciling a known analysis
  // schema.  Keeping a marker supplied with an unversioned/unknown bundle
  // would let a client suppress the legacy recovery path without proving that
  // the authoritative root fields were ever populated.
  if (analysis.schemaVersion !== 'studio-analysis.v1') {
    if (!hasOwn(spec, 'studioProductionContract')) return value;
    const withoutMarker = { ...spec };
    delete withoutMarker.studioProductionContract;
    return withoutMarker as T;
  }
  const nextSpec: UnknownRecord = { ...spec };
  const nextAnalysis: UnknownRecord = {
    ...analysis,
    storyboard: { ...record(analysis.storyboard) },
    voiceover: { ...record(analysis.voiceover) },
    shots: { ...record(analysis.shots) },
  };
  for (const [rootKey, sectionKey, snapshotKey] of MIRRORS) {
    const section = record(analysis[sectionKey]);
    // A v1 compatibility snapshot may predate the root-authority contract.
    // Promote only the explicitly allow-listed mirrors, and only when the root
    // field is genuinely absent.  Existing root values remain authoritative.
    if (!hasOwn(nextSpec, rootKey) && hasOwn(section, snapshotKey)) {
      nextSpec[rootKey] = section[snapshotKey];
    }
    if (hasOwn(nextSpec, rootKey)) nextAnalysis[sectionKey][snapshotKey] = nextSpec[rootKey];
  }
  let kickoff = record(nextSpec.videoKickoff);
  if (!hasOwn(kickoff, 'referenceAnalysis') && hasOwn(analysis, 'reference')) {
    kickoff = { ...kickoff, referenceAnalysis: analysis.reference };
    nextSpec.videoKickoff = kickoff;
  }
  if (hasOwn(kickoff, 'referenceAnalysis')) nextAnalysis.reference = kickoff.referenceAnalysis;
  return {
    ...nextSpec,
    analysisResults: nextAnalysis,
    studioProductionContract: {
      schemaVersion: STUDIO_PRODUCTION_CONTRACT_VERSION,
      authority: 'project_spec',
      compatibilitySnapshot: 'analysisResults',
    },
  } as unknown as T;
}
