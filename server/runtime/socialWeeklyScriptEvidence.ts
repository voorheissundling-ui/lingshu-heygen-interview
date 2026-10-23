import type { VersionedSocialRef } from '../../shared/contracts/socialProgram.js';
import { parseStoredSocialScriptBaseline } from '../starter198/socialContentScriptBaseline.js';

export function weeklyScriptEvidence(row: Record<string, unknown>, candidateIds: string[]): VersionedSocialRef | null {
  const baseline = parseStoredSocialScriptBaseline(row.script_baseline);
  if (!baseline || baseline.source !== 'inspiration_script' || !baseline.match?.inspirationReference
    || !candidateIds.includes(baseline.match.inspirationReference.recordId)
    || !Number.isFinite(Date.parse(baseline.lockedAt))) return null;
  const version = Number(baseline.version);
  return Number.isSafeInteger(version) && version > 0 && typeof row.task_id === 'string'
    ? { type: 'starter_social_content_script_baseline', id: row.task_id, version } : null;
}
