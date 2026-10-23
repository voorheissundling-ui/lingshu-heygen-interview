import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';import {createReadStream} from 'node:fs';import {promisify} from 'node:util';import {execFile} from 'node:child_process';import ffmpeg from 'ffmpeg-static';
import {readMvpRevisionVoiceCues,type MvpRevisionVoiceInput} from './socialContentMvpRevisionVoice.js';
import {readContentExecutionJob} from '../contentExecution/durableQueue.js';
import {socialObject,socialRequestHash} from './socialContentValidation.js';
const COLLECTION='social_voice_assembly_previews';
export function assertVoicePreviewPcm(actual:Buffer,expected:Buffer){
 if(actual.length!==24*48000*2||actual.length!==expected.length)throw Error('voice_preview_duration_changed');
 let maxSampleDelta=0;for(let i=0;i<actual.length;i+=2)maxSampleDelta=Math.max(maxSampleDelta,Math.abs(actual.readInt16LE(i)-expected.readInt16LE(i)));
 if(maxSampleDelta>2)throw Error('voice_preview_not_canonical_source_audio');
 return maxSampleDelta;
}
async function sha(file:string){const h=createHash('sha256');for await(const b of createReadStream(file))h.update(b);return h.digest('hex');}
async function artifact(input:MvpRevisionVoiceInput){
 const cues=await readMvpRevisionVoiceCues(input),identity=createHash('sha256').update(JSON.stringify({cues,duration:24})).digest('hex');
 const filePath=path.join(input.authorityRoot,'data/mvp-voice-assemblies',identity+'.wav');if(!fs.existsSync(filePath))throw Error('canonical_voice_assembly_missing');
 const job=await readContentExecutionJob(input.dataStore,input.scope.tenantId,input.scope.taskId,input.scope.runId),binding=socialObject(job?.checkpoints['social.executor']?.payload);
 if(!job||job.id!==input.scope.jobId||!binding)throw Error('voice_preview_frozen_binding_changed');
 return {cues,filePath,identity,sha256:await sha(filePath),inputHash:binding.inputHash,planHash:socialObject(binding.approvedContext)?.revisionPlanHash,version:Number(socialObject(binding.approvedContext)?.version)};
}
/** Trusted registration QA compares existing PCM against source-bound local assembly; no file is rendered. */
export async function verifyExistingVoiceAssembly(input:MvpRevisionVoiceInput){
 const a=await artifact(input);if(!ffmpeg)throw Error('voice_preview_local_decoder_missing');
 const decode=async(args:string[])=>{const r=await promisify(execFile)(ffmpeg!,['-hide_banner','-loglevel','error','-nostdin',...args,'-ac','1','-ar','48000','-f','s16le','pipe:1'],{encoding:'buffer',maxBuffer:8*1024*1024,timeout:90000});return r.stdout;};
 const actual=await decode(['-i',a.filePath,'-vn']);
 const filters=a.cues.map((c,i)=>`[${i}:a]atrim=start=${c.sourceStartSeconds}:end=${c.sourceEndSeconds},asetpts=PTS-STARTPTS,adelay=${Math.round(c.startSeconds*1000)}:all=1[a${i}]`).concat(`${a.cues.map((_,i)=>`[a${i}]`).join('')}amix=inputs=${a.cues.length}:normalize=0,apad,atrim=duration=24[out]`).join(';');
 const expected=await decode([...a.cues.flatMap(c=>['-i',c.track.filePath]),'-filter_complex',filters,'-map','[out]']);
 const maxSampleDelta=assertVoicePreviewPcm(actual,expected);
 return {...a,verification:{pcmMatchesCanonicalAssembly:true,maxSampleDelta,sampleRate:48000,channels:1,durationSeconds:24,wordCount:a.cues.reduce((s,c)=>s+c.words.length,0),asrChecked:false,humanApproved:false}};
}
export async function registerVoiceAssemblyPreview(input:MvpRevisionVoiceInput&{dryRun?:boolean;registerMedia:(file:{filePath:string;sha256:string})=>Promise<{fileRef:string;url:string}>}){
 const checked=await verifyExistingVoiceAssembly(input),id=socialRequestHash({...input.scope,identity:checked.identity});
 const existing=await input.dataStore.getById<any>(COLLECTION,id);
 if(existing){const preview=await readVoiceAssemblyPreview(input);if(!preview)throw Error('voice_preview_record_missing');return {replayed:true,preview};}
 if(input.dryRun)return {replayed:false,dryRun:true,sha256:checked.sha256,durationSeconds:24,verification:checked.verification};
 const file=await input.registerMedia({filePath:checked.filePath,sha256:checked.sha256});if(!file.fileRef||!file.url)throw Error('voice_preview_file_registration_missing');
 const body={...input.scope,version:checked.version,inputHash:checked.inputHash,planHash:checked.planHash,identity:checked.identity,sha256:checked.sha256,filePath:checked.filePath,hookRef:input.hookRef,bodyRef:input.bodyRef,...file,verification:checked.verification,durationSeconds:24,source:'canonical_provider_audio_local_assembly',humanApproved:false,artifactCompleted:false};
 const row=await input.dataStore.create(COLLECTION,{id,tenant_id:input.scope.tenantId,task_id:input.scope.taskId,run_id:input.scope.runId,job_id:input.scope.jobId,proof:body,proof_hash:socialRequestHash(body)});if(!row)throw Error('voice_preview_persistence_failed');
 const preview=await readVoiceAssemblyPreview(input);if(!preview)throw Error('voice_preview_persistence_unconfirmed');return {replayed:false,preview};
}
/** GET reader performs only receipt/source/byte checks, never synthesis, registration or paid work. */
export async function readVoiceAssemblyPreview(input:MvpRevisionVoiceInput){
 const rows=await input.dataStore.list<any>(COLLECTION,{where:{tenant_id:input.scope.tenantId,task_id:input.scope.taskId,run_id:input.scope.runId,job_id:input.scope.jobId},perPage:2});
 if(rows.totalItems===0)return null;
 if(rows.totalItems!==1)throw Error('voice_preview_receipt_ambiguous');
 const a=await artifact(input),id=socialRequestHash({...input.scope,identity:a.identity}),row=await input.dataStore.getById<any>(COLLECTION,id);if(!row)throw Error('voice_preview_identity_changed');
 const p=row.proof;if(!p||row.proof_hash!==socialRequestHash(p)||Object.entries(input.scope).some(([k,v])=>p[k]!==v)||p.inputHash!==a.inputHash||p.planHash!==a.planHash||p.sha256!==a.sha256||p.identity!==a.identity||p.version!==a.version||fs.realpathSync(p.filePath)!==fs.realpathSync(a.filePath)||p.hookRef!==input.hookRef||p.bodyRef!==input.bodyRef||p.durationSeconds!==24||p.verification?.pcmMatchesCanonicalAssembly!==true||!p.fileRef||!p.url)throw Error('voice_preview_receipt_or_bytes_changed');
 return {role:'assembled',receiptRef:`voice_assembly_preview:${id}`,fileRef:p.fileRef,url:p.url,sha256:p.sha256,durationSeconds:24,source:p.source,humanApproved:false,artifactCompleted:false};
}
