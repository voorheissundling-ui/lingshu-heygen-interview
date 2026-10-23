import {socialRequestHash} from '../starter198/socialContentValidation.js';
import fs from 'node:fs';import path from 'node:path';import {createHash,randomUUID} from 'node:crypto';
import {ASR_MODEL,QwenAsrService,qwenMeasuredWordTimeline,type QwenAsrRecord} from './qwenAsr.js';
import {REFERENCE_AUDIO_CLOCK_POLICY} from './referenceNarrationClockPolicy.js';
export interface ReferenceNarrationScope{tenantId:string;filePath:string;expectedSourceSha256:string}
export interface ReferenceNarrationBinding{version:1;tenantId:string;sourceVideoSha256:string;audioSha256:string;clockPolicy:string;durationSeconds:number;audioExtraction:unknown;providerEndpoint:string;taskId:string|null;status:string}
const roots=()=>({narration:path.resolve('data/analysis-output/narration-cache'),asr:path.resolve('data/analysis-output/qwen-word-asr-v1')});
function key(scope:ReferenceNarrationScope){if(!/^[\w-]{1,128}$/.test(scope.tenantId)||!/^[a-f0-9]{64}$/.test(scope.expectedSourceSha256)||createHash('sha256').update(fs.readFileSync(scope.filePath)).digest('hex')!==scope.expectedSourceSha256)throw new Error('原片字节身份已变化');return createHash('sha256').update(`${scope.tenantId}:${scope.expectedSourceSha256}:measured-word-v2:${REFERENCE_AUDIO_CLOCK_POLICY}`).digest('hex');}
export async function saveReferenceNarrationBinding(scope:ReferenceNarrationScope,durationSeconds:number,audioExtraction:unknown,record:QwenAsrRecord){
 const hash=key(scope);if(!/^[a-f0-9]{64}$/.test(record.sourceSha256)||record.id!==record.sourceSha256||record.model!==ASR_MODEL||!record.providerEndpoint||!(durationSeconds>0&&durationSeconds<=180))throw new Error('原转写绑定无效');
 const binding:ReferenceNarrationBinding={version:1,tenantId:scope.tenantId,sourceVideoSha256:scope.expectedSourceSha256,audioSha256:record.sourceSha256,clockPolicy:REFERENCE_AUDIO_CLOCK_POLICY,durationSeconds,audioExtraction,providerEndpoint:record.providerEndpoint,taskId:record.taskId??null,status:record.status};
 const dir=roots().narration;fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,`${hash}.binding.json`);if(fs.existsSync(file)){const prior=JSON.parse(fs.readFileSync(file,'utf8'));if(prior.audioSha256!==binding.audioSha256||prior.providerEndpoint!==binding.providerEndpoint||prior.taskId&&prior.taskId!==binding.taskId)throw new Error('原转写绑定已变化');}
 const temp=`${file}.${randomUUID()}.tmp`;fs.writeFileSync(temp,JSON.stringify(binding),{mode:0o600});fs.renameSync(temp,file);
}
export function readExistingReferenceNarration(scope:ReferenceNarrationScope){
 const file=path.join(roots().narration,`${key(scope)}.binding.json`);if(!fs.existsSync(file))return null;
 const binding:ReferenceNarrationBinding=JSON.parse(fs.readFileSync(file,'utf8'));
 if(binding.version!==1||binding.tenantId!==scope.tenantId||binding.sourceVideoSha256!==scope.expectedSourceSha256||binding.clockPolicy!==REFERENCE_AUDIO_CLOCK_POLICY||!/^[a-f0-9]{64}$/.test(binding.audioSha256)||!(binding.durationSeconds>0&&binding.durationSeconds<=180))throw new Error('原转写绑定不匹配');
 const recordFile=path.join(roots().asr,scope.tenantId,`${binding.audioSha256}.json`);if(!fs.existsSync(recordFile))throw new Error('原转写记录缺失');const record:QwenAsrRecord=JSON.parse(fs.readFileSync(recordFile,'utf8'));
 if(record.id!==binding.audioSha256||record.sourceSha256!==binding.audioSha256||record.model!==ASR_MODEL||record.providerEndpoint!==binding.providerEndpoint||(record.taskId??null)!==binding.taskId)throw new Error('原转写任务身份已变化');
 return {binding,record,status:record.status};
}
export async function resumeExistingReferenceNarration(scope:ReferenceNarrationScope&{expectedTaskId:string},ports:{request?:typeof fetch}={}){
 const original=readExistingReferenceNarration(scope);if(!original||!original.binding.taskId||original.binding.taskId!==scope.expectedTaskId||['uncertain','submitting','needs_confirmation'].includes(original.status))throw new Error('原任务无法只读恢复，禁止重新提交');
 const {status:_originalStatus,...originalAuthority}=original.binding;
 const authorityHash=socialRequestHash(originalAuthority);
 const service=new QwenAsrService(roots().asr,ports.request??fetch,async()=>{throw new Error('只读恢复禁止预留预算');});
 const record=await service.pollExisting(scope.tenantId,original.binding.audioSha256,scope.expectedTaskId);
 key(scope);const fresh=readExistingReferenceNarration(scope);if(!fresh||fresh.binding.taskId!==scope.expectedTaskId||fresh.binding.audioSha256!==original.binding.audioSha256)throw new Error('原转写绑定在查询期间变化');
 const {status:_freshStatus,...freshAuthority}=fresh.binding;if(socialRequestHash(freshAuthority)!==authorityHash)throw new Error('原转写时钟或来源绑定在查询期间变化');
 if(record.status!=='SUCCEEDED')return {status:record.status,taskId:scope.expectedTaskId};
 const measured=qwenMeasuredWordTimeline(record.raw,original.binding.durationSeconds);const result={...measured,alignmentStatus:'aligned' as const,provider:'qwen',model:record.model,timingPrecision:'word',provenance:'qwen_filetrans:measured_words',sourceSha256:record.sourceSha256,taskId:record.taskId,usage:record.usage,timestampResolutionMs:1,accuracyMs:null,confidence:null,version:2,sourceVideoSha256:scope.expectedSourceSha256,sourceHash:key(scope),rawText:measured.text,alignmentError:'',durationSeconds:original.binding.durationSeconds,audioExtraction:original.binding.audioExtraction,createdAt:new Date().toISOString()};
 const file=path.join(roots().narration,`${key(scope)}.json`),temp=`${file}.${randomUUID()}.tmp`;fs.writeFileSync(temp,JSON.stringify(result),{mode:0o600});fs.renameSync(temp,file);return {status:record.status,taskId:scope.expectedTaskId,result};
}
