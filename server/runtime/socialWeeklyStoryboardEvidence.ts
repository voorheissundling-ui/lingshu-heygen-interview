import type { VersionedSocialRef } from '../../shared/contracts/socialProgram.js';
import { parseStoredSocialDirectorPlan } from '../starter198/socialContentDirectorPlan.js';
import { weeklyScriptEvidence } from './socialWeeklyScriptEvidence.js';
import { parseStoredSocialScriptBaseline } from '../starter198/socialContentScriptBaseline.js';
import type {WeeklyPreSupplyHandoff} from '../starter198/socialWeeklyPreSupplyHandoff.js';

/** A locked, integrity-checked handoff can finish before the rendered video exists. */
export function weeklyStoryboardEvidence(row: Record<string, unknown>, candidateIds: string[]): VersionedSocialRef | null {
  const script = weeklyScriptEvidence(row, candidateIds);
  if (!script) return null;
  const plan = parseStoredSocialDirectorPlan(row.director_plan);
  const baseline = parseStoredSocialScriptBaseline(row.script_baseline);
  if (!plan || plan.status !== 'ready' || plan.lockStatus !== 'locked'
    || !Number.isFinite(Date.parse(plan.lockedAt ?? ''))
    || plan.scriptSource.kind !== 'inspiration_script'
    || Number(plan.scriptSource.baselineVersion) !== script.version
    || !plan.scriptSource.inspirationReference
    || plan.scriptSource.inspirationReference.recordId !== baseline?.match?.inspirationReference?.recordId
    || !candidateIds.includes(plan.scriptSource.inspirationReference.recordId)
    || !plan.scenes.length || plan.qualityGates.some(gate => gate.status === 'blocked')) return null;
  const version = Number(plan.version);
  return Number.isSafeInteger(version) && version > 0
    ? { type: 'starter_social_content_director_plan', id: script.id, version } : null;
}

/** V2+ storyboards are frozen before asset supply in the original content run.
 * A legacy post-supply Director plan can never settle that graph node. The
 * caller must first obtain preSupply from readWeeklyPreSupplyHandoff. */
export function weeklyStoryboardStageEvidence(row: Record<string,unknown>,candidateIds:string[],graphVersion:number,preSupply:WeeklyPreSupplyHandoff|null):VersionedSocialRef|null{
 if(graphVersion<2)return weeklyStoryboardEvidence(row,candidateIds);
 if(!preSupply||typeof row.run_id!=='string'||!row.run_id||preSupply.runId!==row.run_id||preSupply.taskId!==row.task_id)return null;
 return {type:'starter_weekly_pre_supply_handoff',id:preSupply.runId,version:1};
}
