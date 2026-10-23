import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import ffmpegStatic from 'ffmpeg-static';
import {inspectSentenceLipSyncQuality,type SentenceLipSyncQualityReport} from '../lib/sentenceLipSyncQuality.js';

const run=promisify(execFile);
const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const HASH=/^[a-f0-9]{64}$/;
const SAMPLE_RATE=8000;

/** No paid presenter POST is allowed if the independent detector is absent. */
export function assertPresenterMotherSpeechQaReady(env:NodeJS.ProcessEnv=process.env):void {
 const python=String(env.DIGITAL_HUMAN_SYNCNET_QA_PYTHON||'').trim();
 const root=String(env.DIGITAL_HUMAN_SYNCNET_DIR||'').trim();
 const files=[python,path.join(root,'data','syncnet_v2.model'),path.join(root,'detectors','s3fd','weights','sfd_face.pth'),path.join(root,'run_pipeline.py'),
  path.join(root,'run_syncnet.py'),path.resolve(process.cwd(),'scripts/validate-syncnet.py')];
 if(env.DIGITAL_HUMAN_SYNCNET_QA_ENABLED!=='true'||!python||!root||files.some(file=>!fs.existsSync(file)))
  throw Error('presenter_mother_frozen_audio_and_lip_sync_qa_unavailable');
 // The Oxford pretrained SyncNet and S3FD weight files have not been granted
 // independently verified commercial-production rights in this product. A
 // configured directory, file existence, or an environment assertion cannot
 // establish those rights. Keep the paid presenter POST closed until an
 // independently reviewed, revocable rights ledger binds both actual weight
 // hashes and the detector version at this boundary.
 throw Error('presenter_mother_commercial_lip_sync_model_rights_unverified');
}

async function decodedPcm(filePath:string):Promise<Int16Array> {
 const result=await run(String(ffmpegStatic||'ffmpeg'),['-hide_banner','-loglevel','error','-nostdin','-i',filePath,
  '-map','0:a:0','-vn','-ac','1','-ar',String(SAMPLE_RATE),'-f','s16le','pipe:1'],
 {encoding:'buffer',timeout:120_000,maxBuffer:64*1024*1024});
 const bytes=result.stdout as Buffer;
 if(bytes.length<.2*SAMPLE_RATE*2||bytes.length%2)throw Error('presenter_mother_audio_decode_invalid');
 return new Int16Array(bytes.buffer,bytes.byteOffset,bytes.length/2);
}

/** Bounded normalized waveform correlation is invariant to AAC gain but not
 * to a different performance. It is deliberately stricter than voice-ID
 * similarity: the rendered track must be this exact frozen utterance. */
export function compareFrozenPcm(frozen:Int16Array,rendered:Int16Array):{passed:boolean;correlation:number;offsetMs:number;durationDriftMs:number} {
 const drift=Math.abs(frozen.length-rendered.length)/SAMPLE_RATE*1000;
 let best=-1,bestOffset=0;
 const step=4,maxOffset=Math.round(.12*SAMPLE_RATE),stride=80;
 for(let offset=-maxOffset;offset<=maxOffset;offset+=stride){
  let dot=0,a2=0,b2=0;
  const start=Math.max(0,-offset),end=Math.min(frozen.length,rendered.length-offset);
  for(let index=start;index<end;index+=step){const a=frozen[index]!,b=rendered[index+offset]!;dot+=a*b;a2+=a*a;b2+=b*b;}
  const score=a2>1e8&&b2>1e8?dot/Math.sqrt(a2*b2):-1;
  if(score>best){best=score;bestOffset=offset;}
 }
 const correlation=Number(best.toFixed(6)),offsetMs=bestOffset/SAMPLE_RATE*1000;
 return{passed:drift<=120&&correlation>=.9,correlation,offsetMs,durationDriftMs:Number(drift.toFixed(3))};
}

export async function inspectPresenterMotherSpeechQa(input:{segmentHash:string;outputPath:string;outputSha256:string;
 frozenAudioPath:string;frozenAudioSha256:string;workDir:string;
 inspectLipSync?:(videoPath:string,options:{workDir:string})=>Promise<SentenceLipSyncQualityReport>}) {
 if(!HASH.test(input.segmentHash)||!HASH.test(input.outputSha256)||!HASH.test(input.frozenAudioSha256))throw Error('presenter_mother_speech_qa_scope_invalid');
 const [videoBytes,audioBytes]=await Promise.all([fs.promises.readFile(input.outputPath),fs.promises.readFile(input.frozenAudioPath)]);
 if(hash(videoBytes)!==input.outputSha256||hash(audioBytes)!==input.frozenAudioSha256)throw Error('presenter_mother_speech_qa_bytes_changed');
 const [frozen,rendered]=await Promise.all([decodedPcm(input.frozenAudioPath),decodedPcm(input.outputPath)]);
 const track=compareFrozenPcm(frozen,rendered);
 const outputAudioSha256=hash(Buffer.from(rendered.buffer,rendered.byteOffset,rendered.byteLength));
 const audioBody={schemaVersion:'presenter-mother-audio-track.v1',segmentHash:input.segmentHash,
  outputVideoSha256:input.outputSha256,frozenAudioSha256:input.frozenAudioSha256,outputAudioSha256,
  sampleRate:SAMPLE_RATE,comparison:track};
 const audioTrackReportHash=hash(JSON.stringify(audioBody));
 await fs.promises.mkdir(input.workDir,{recursive:true,mode:0o700});
 const audioTrackReceiptRef=path.join(input.workDir,`${audioTrackReportHash}.audio.json`);
 await fs.promises.writeFile(audioTrackReceiptRef,JSON.stringify({...audioBody,reportHash:audioTrackReportHash}),{mode:0o600});
 if(!track.passed)throw Error('presenter_mother_frozen_audio_track_mismatch');
 const sync=await(input.inspectLipSync||inspectSentenceLipSyncQuality)(input.outputPath,{workDir:path.join(input.workDir,'syncnet')});
 const lipBody={schemaVersion:'presenter-mother-syncnet.v1',segmentHash:input.segmentHash,
  outputVideoSha256:input.outputSha256,outputAudioSha256,sync};
 const lipHash=hash(JSON.stringify(lipBody)),lipSyncReceiptRef=path.join(input.workDir,`${lipHash}.lip.json`);
 await fs.promises.writeFile(lipSyncReceiptRef,JSON.stringify({...lipBody,reportHash:lipHash}),{mode:0o600});
 if(!sync.passed)throw Error('presenter_mother_lip_sync_failed');
 return {segmentHash:input.segmentHash,outputVideoSha256:input.outputSha256,frozenAudioSha256:input.frozenAudioSha256,
  outputAudioSha256,audioTrackMatchesFrozen:true,audioTrackReceiptRef,audioTrackReportHash,
  lipSyncStatus:'passed' as const,lipSyncModelSha256:sync.modelSha256,lipSyncReceiptRef,
  lipSyncScore:sync.confidence,lipSyncThreshold:sync.thresholds.confidenceMin};
}
