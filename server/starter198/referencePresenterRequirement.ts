import {buildReferenceShotProductionRouting,type ReferenceProductionRouteInput} from '../../shared/referenceShotProductionRouting.js';
import {parseAnalysisTimeRange} from '../lib/videoAnalysisCodec.js';
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const text=(value:unknown)=>typeof value==='string'?value.trim():'';
/** Only independently observed, source-bound complete shot routing can remove
 * the presenter requirement. Review retiming/merging cannot borrow old frames. */
export function verifiedNonPresenterReference(input:{sourceSha256:unknown;duration:unknown;originalDetails:Record<string,unknown>[];retainedDetails:Record<string,unknown>[];reviewComplete:boolean}):boolean{
 if(!/^[a-f0-9]{64}$/.test(text(input.sourceSha256))||typeof input.duration!=='number'||!Number.isFinite(input.duration)||input.duration<=0||!input.originalDetails.length||!input.retainedDetails.length)return false;
 const source=new Map(input.originalDetails.map(detail=>[text(detail.shotId),detail]));if(source.size!==input.originalDetails.length||source.has(''))return false;
 const used=new Set<string>();let end=0;const shots:ReferenceProductionRouteInput[]=[];
 for(const detail of input.retainedDetails){
  const range=parseAnalysisTimeRange(text(detail.time||detail.timestamp));if(!range||Math.abs(range.start-end)>.01)return false;end=range.end;
  const ids=input.reviewComplete?(Array.isArray(detail.sourceShotIds)?detail.sourceShotIds:[]):[detail.shotId];if(ids.length!==1||typeof ids[0]!=='string'||used.has(ids[0]))return false;used.add(ids[0]);
  const original=source.get(ids[0]);if(!original)return false;const originalRange=parseAnalysisTimeRange(text(original.time||original.timestamp));if(!originalRange||Math.abs(range.start-originalRange.start)>.01||Math.abs(range.end-originalRange.end)>.01)return false;
  const evidence=object(original.presenterContinuityEvidence),critical=object(original.criticalShot);
  if(!['critical','non_critical'].includes(text(critical.classification))||!text(critical.model)||!text(critical.provenance))return false;
  shots.push({shotId:ids[0],time:text(original.time||original.timestamp),criticalShot:critical as unknown as ReferenceProductionRouteInput['criticalShot'],presenterContinuityEvidence:evidence as unknown as ReferenceProductionRouteInput['presenterContinuityEvidence']});
 }
 if(Math.abs(end-input.duration)>.01||used.size!==source.size)return false;
 const routing=buildReferenceShotProductionRouting({sourceSha256:text(input.sourceSha256),shots});
 return routing.shots.every(shot=>shot.productionRouting.state==='ready'&&!shot.productionRouting.identityLock&&shot.productionRouting.route!=='reference_frame_presenter'&&shot.productionRouting.route!=='undetermined');
}
