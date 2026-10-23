import {createReadStream} from 'node:fs';import fs from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import ffmpeg from 'ffmpeg-static';
import {evaluateVoicePcm} from './voiceQuality.js';
import type {synthesizeStudioVoiceForAutomation} from './socialContentLegacyPorts.js';
export interface CanonicalVoiceTrack {filePath:string;sha256:string;durationSeconds:number;receiptRef:string;receiptHash:string;providerEvidenceRef:string;}
export interface CanonicalVoiceCue {sceneId:string;text:string;startSeconds:number;endSeconds:number;track:CanonicalVoiceTrack;sourceStartSeconds:number;sourceEndSeconds:number;keepCompleteTrack?:boolean;boundaryPaddingSeconds?:.04;words:Array<{text:string;start:number;end:number}>;}
const words=(text:string)=>text.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.join(' ')??'';
async function sha(file:string){const h=createHash('sha256');for await(const part of createReadStream(file))h.update(part);return h.digest('hex');}
/** Local only: source boundaries are measured provider word times, never proportional estimates. */
export function createCanonicalVoiceAssembly(input:{tenantId:string;durationSeconds:number;silentIntervals:Array<{start:number;end:number}>;outputDirectory:string;readCanonicalCues:()=>Promise<CanonicalVoiceCue[]>}):typeof synthesizeStudioVoiceForAutomation{
if(!Number.isFinite(input.durationSeconds)||input.durationSeconds<=0||input.silentIntervals.some(s=>![s.start,s.end].every(Number.isFinite)||s.start<0||s.end<=s.start||s.end>input.durationSeconds))throw Error('canonical_voice_timing_invalid');
return async request=>{
if(!ffmpeg||request.tenantId!==input.tenantId||request.targetDuration!==input.durationSeconds)throw Error('canonical_voice_scope_changed');
const cues=await input.readCanonicalCues();if(!cues.length||words(cues.map(c=>c.text).join(' '))!==words(request.text))throw Error('canonical_voice_words_changed');
let previousEnd=0;
for(const cue of cues){const spokenDuration=cue.sourceEndSeconds-cue.sourceStartSeconds;
if (![cue.startSeconds,cue.endSeconds,cue.sourceStartSeconds,cue.sourceEndSeconds,cue.track.durationSeconds].every(Number.isFinite) || !cue.words.length||words(cue.words.map(w=>w.text).join(' '))!==words(cue.text)||cue.startSeconds<previousEnd||spokenDuration<=0||spokenDuration>cue.endSeconds-cue.startSeconds+.001||cue.endSeconds>input.durationSeconds
||cue.sourceStartSeconds<0||cue.sourceEndSeconds>cue.track.durationSeconds+.001||!cue.track.receiptRef||!/^[a-f0-9]{64}$/.test(cue.track.receiptHash)||!cue.track.providerEvidenceRef
||cue.words.some(w=>!Number.isFinite(w.start)||!(w.end>w.start)||!Number.isFinite(w.end)||w.start<cue.sourceStartSeconds||w.end>cue.sourceEndSeconds)
||input.silentIntervals.some(s=>cue.startSeconds<s.end&&cue.startSeconds+spokenDuration>s.start)
||cue.keepCompleteTrack&&(cue.sourceStartSeconds!==0||Math.abs(cue.sourceEndSeconds-cue.track.durationSeconds)>.001))throw Error('canonical_voice_timing_invalid');
if (cue.boundaryPaddingSeconds === .04 && (Math.abs(cue.sourceStartSeconds - Math.max(0, Math.min(...cue.words.map(w=>w.start)) - .04)) > .000001 || Math.abs(cue.sourceEndSeconds - Math.min(cue.track.durationSeconds, Math.max(...cue.words.map(w=>w.end)) + .04)) > .000001)) throw Error('canonical_voice_boundary_padding_changed');
if(await sha(cue.track.filePath)!==cue.track.sha256)throw Error('canonical_voice_source_hash_changed');
const pcm=await promisify(execFile)(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-i',cue.track.filePath,'-ss',String(cue.sourceStartSeconds),'-t',String(spokenDuration),'-vn','-ac','1','-ar','16000','-f','s16le','pipe:1'],{encoding:'buffer',maxBuffer:10*1024*1024});
const quality=evaluateVoicePcm(pcm.stdout);if(!quality.passed)throw Error(`canonical_voice_technical_QA_failed:${quality.failures.join(',')}`);
previousEnd=cue.startSeconds+spokenDuration;
}
await fs.mkdir(input.outputDirectory,{recursive:true,mode:0o700});const identity=createHash('sha256').update(JSON.stringify({cues,duration:input.durationSeconds})).digest('hex'),file=path.join(input.outputDirectory,identity+'.wav');
const filter=cues.map((cue,i)=>`[${i}:a]atrim=start=${cue.sourceStartSeconds}:end=${cue.sourceEndSeconds},asetpts=PTS-STARTPTS,adelay=${Math.round(cue.startSeconds*1000)}:all=1[a${i}]`).concat(`${cues.map((_,i)=>`[a${i}]`).join('')}amix=inputs=${cues.length}:normalize=0,apad,atrim=duration=${input.durationSeconds}[out]`).join(';');
await promisify(execFile)(ffmpeg,['-hide_banner','-loglevel','error','-nostdin',...cues.flatMap(cue=>['-i',cue.track.filePath]),'-filter_complex',filter,'-map','[out]','-ac','1','-ar','48000','-c:a','pcm_s16le','-y',file],{timeout:90000});await fs.chmod(file,0o600);
const assembledPcm=await promisify(execFile)(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-i',file,'-vn','-ac','1','-ar','16000','-f','s16le','pipe:1'],{encoding:'buffer',maxBuffer:10*1024*1024});
const assembledQuality=evaluateVoicePcm(assembledPcm.stdout);if(!assembledQuality.passed)throw Error(`canonical_voice_assembly_QA_failed:${assembledQuality.failures.join(',')}`);
const alignment=cues.map(cue=>({text:cue.text,start:cue.startSeconds,end:cue.startSeconds+cue.sourceEndSeconds-cue.sourceStartSeconds,words:cue.words.map(word=>({text:word.text,start:cue.startSeconds+word.start-cue.sourceStartSeconds,end:cue.startSeconds+word.end-cue.sourceStartSeconds}))}));
return {ok:true,source:'canonical_provider_audio_local_assembly',localPath:file,url:file,text:request.text,duration:input.durationSeconds,cues:alignment,alignmentSource:'provider_measured_words_local_offset',qualityReport:{...assembledQuality,asrChecked:false,transcriptAccuracy:null}};
};
}
