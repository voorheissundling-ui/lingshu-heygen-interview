import type { VideoAiAnalysis } from '../types/index.js';
import { buildReferenceShotProductionRouting } from '../../shared/referenceShotProductionRouting.js';
import { producePresenterContinuity } from './referencePresenterContinuity.js';

/** Identity is determined before the criticality/cost decision. This is a
 * production plan, not a paid generation or an account avatar selection. */
export async function produceReferenceProductionRouting(input: {
  filePath:string; analysis:VideoAiAnalysis;sourceSha256:string;videoId:string;tenantId?:string;duration:number;
}) {
  const observed=await producePresenterContinuity(input);
  const routed=buildReferenceShotProductionRouting({sourceSha256:input.sourceSha256,
    shots:(observed.scriptDetails15s||[]).map((s,i)=>({shotId:`shot-${i+1}`,time:String(s.time||s.timestamp||''),
      criticalShot:s.criticalShot,presenterContinuityEvidence:s.presenterContinuityEvidence}))});
  return {...observed,scriptDetails15s:observed.scriptDetails15s?.map((s,i)=>({...s,
    referenceProductionRouting:routed.shots[i].productionRouting})),
    referenceProductionRoutingSummary:{version:routed.version,sourceSha256:input.sourceSha256,
      presenterGroups:routed.presenterGroups,shotCount:routed.shots.length,
      readyCount:routed.shots.filter(s=>s.productionRouting.state==='ready').length,
      automaticAnalysisRequiredShotIds:routed.shots.filter(s=>s.productionRouting.automaticAnalysisRequired).map(s=>s.shotId)}};
}
