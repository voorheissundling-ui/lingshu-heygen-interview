import {socialRequestHash} from './socialContentValidation.js';
type Cue={start:number;end:number;text:string};
const text=(v:string)=>v.normalize('NFKC').replace(/\s+/g,' ').trim();
/** Exact boundaries from the measured master track, including silence gaps. */
export function assertMeasuredCaptionTiming(input:{measured:Cue[];captions:Cue[];duration:number;toleranceSeconds?:number}){
 const tolerance=input.toleranceSeconds??.02;
 if(!input.measured.length||input.measured.length!==input.captions.length)throw Error('caption_measured_timeline_missing');
 let previousEnd=0,maxBoundaryErrorSeconds=0;
 for(let i=0;i<input.measured.length;i++){
  const actual=input.captions[i]!,expected=input.measured[i]!;
  if(!Number.isFinite(actual.start)||!Number.isFinite(actual.end)||actual.start<previousEnd-.03||actual.end<=actual.start||actual.end>input.duration+tolerance||text(actual.text)!==text(expected.text))throw Error('caption_measured_timeline_changed');
  const error=Math.max(Math.abs(actual.start-expected.start),Math.abs(actual.end-expected.end));
  maxBoundaryErrorSeconds=Math.max(error,maxBoundaryErrorSeconds);
  if(error>tolerance)throw Error('caption_measured_timeline_drift');previousEnd=actual.end;
 }
 return {passed:true as const,cueCount:input.captions.length,cueTimelineHash:socialRequestHash(input.captions),firstCueStart:input.captions[0]!.start,lastCueEnd:input.captions.at(-1)!.end,maxBoundaryErrorSeconds};
}
