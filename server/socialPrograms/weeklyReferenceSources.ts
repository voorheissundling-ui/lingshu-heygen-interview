import {weeklyProductionPopulation} from './weeklyProductionPopulation.js';
import type { SocialWeeklyPublicationTask, WeeklyReferenceSourcePolicy } from '../../shared/contracts/socialProgram.js';
/** Count mothers once; platform variants inherit the same explicitly frozen source allocation. */
export function allocateWeeklyReferenceSources(publications: SocialWeeklyPublicationTask[], policy: WeeklyReferenceSourcePolicy | null | undefined) {
  const mothers = weeklyProductionPopulation(publications).motherContentIds;
  const ownedCount = policy ? Math.round(mothers.length * policy.ownedPercent / 100) : 0;
  return new Map(mothers.map((id, index) => [id, policy ? index < ownedCount ? 'owned' as const : 'external' as const : 'unknown' as const]));
}
