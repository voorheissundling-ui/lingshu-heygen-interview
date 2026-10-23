import type {SocialInspirationCollectionRun} from '../../shared/contracts/socialContentWorkflow.js';
import {socialObject,socialRequestHash} from '../starter198/socialContentValidation.js';

/** Discovery writes outcomes after creating the run. Those mutable outcomes
 * cannot bind an already submitted paid operation. The weekly producer's
 * completeEmptyVerified result is likewise written only at completion. */
export function weeklyCandidateExactRunBindingHash(run:SocialInspirationCollectionRun):string{
 const snapshot=socialObject(run.scopeSnapshot);
 const producer=socialObject(snapshot?.weeklyProducer);
 const stableProducer=producer?Object.fromEntries(Object.entries(producer).filter(([key])=>key!=='completeEmptyVerified')):null;
 const stableSnapshot=snapshot?{...snapshot,...(producer?{weeklyProducer:stableProducer}:{})}:run.scopeSnapshot;
 return socialRequestHash({runId:run.runId,planId:run.planId,keywordSetId:run.keywordSetId,
  keywordSetVersion:run.keywordSetVersion,discoveryScopeId:run.discoveryScopeId,
  discoveryScopeVersion:run.discoveryScopeVersion,triggerType:run.triggerType,
  scopeSnapshot:stableSnapshot,market:run.market,language:run.language,startedAt:run.startedAt});
}
