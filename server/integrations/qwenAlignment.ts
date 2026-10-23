import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {withPaidOperationLock} from '../lib/paidOperationLock.js';
import {studioVoicePaidContext,type StudioVoicePaidRequest} from '../lib/studioVoicePaidOperation.js';
import fs from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import ffmpegStatic from 'ffmpeg-static';
import { dashscopeApiKey } from '../agents/qwen.js';

export type TimedCue = { start: number; end: number; text: string };

type RawSentence = {
  begin_time?: unknown;
  end_time?: unknown;
  text?: unknown;
  punctuation?: unknown;
  words?: Array<{ begin_time?: unknown; end_time?: unknown; text?: unknown; punctuation?: unknown }>;
};

const normalizedSpeech = (value: string) => value
  .normalize('NFKC')
  .toLowerCase()
  .replace(/you['’]re/g, 'you are')
  .replace(/\b(\d{1,3})(?:,(\d{3}))+\b/g, match => match.replace(/,/g, ''))
  .replace(/[^\p{L}\p{N}]/gu, '');

function editSimilarity(left: string, right: string): number {
  const a = normalizedSpeech(left);
  const b = normalizedSpeech(right);
  if (a === b) return 1;
  if (!a || !b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= b.length; column += 1) {
      current[column] = Math.min(
        current[column - 1]! + 1,
        previous[column]! + 1,
        previous[column - 1]! + (a[row - 1] === b[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return 1 - previous[b.length]! / Math.max(a.length, b.length);
}

function splitSentences(value: string): string[] {
  return String(value || '')
    .match(/[^。！？!?.]+[。！？!?.]?/gu)
    ?.map(item => item.trim())
    .filter(Boolean) || [];
}

/** Recover sentence boundaries from the actual waveform when an already
 * accepted file-transcription task cannot download a local-preview URL. The
 * spoken text has already passed the separately funded ASR check; this only
 * measures pauses and never creates or changes words. */
export async function measuredLocalAudioCues(filePath:string,transcript:string,duration:number,audioSha256:string):Promise<TimedCue[]> {
  const file=path.resolve(filePath),bytes=fs.readFileSync(file);
  if(createHash('sha256').update(bytes).digest('hex')!==audioSha256)throw Error('voice_alignment_local_audio_changed');
  const sentences=splitSentences(transcript);
  if(!sentences.length||!(duration>0&&duration<=300))throw Error('voice_alignment_local_input_invalid');
  if(sentences.length===1)return [{start:0,end:duration,text:sentences[0]!}];
  const run=promisify(execFile);
  const result=await run(ffmpegStatic||'ffmpeg',['-hide_banner','-nostdin','-i',file,'-af','silencedetect=noise=-38dB:d=0.12','-f','null','-'],{timeout:30000,maxBuffer:2*1024*1024}).catch((error:any)=>({stderr:String(error?.stderr||'')}));
  const stderr=String(result.stderr||'');
  const starts=[...stderr.matchAll(/silence_start:\s*([0-9.]+)/g)].map(match=>Number(match[1]));
  const ends=[...stderr.matchAll(/silence_end:\s*([0-9.]+)/g)].map(match=>Number(match[1]));
  const candidates=starts.map((start,index)=>({start,end:ends[index]})).filter((gap):gap is {start:number;end:number}=>Number.isFinite(gap.start)&&Number.isFinite(gap.end)&&gap.end>gap.start&&gap.start>.05&&gap.end<duration-.05).map(gap=>(gap.start+gap.end)/2);
  if(candidates.length<sentences.length-1)throw Error('voice_alignment_local_pauses_insufficient');
  const weights=sentences.map(sentence=>Math.max(1,normalizedSpeech(sentence).length));
  const total=weights.reduce((sum,value)=>sum+value,0);let cumulative=0,minimum=0;
  const boundaries:number[]=[];
  for(let index=0;index<sentences.length-1;index+=1){
    cumulative+=weights[index]!;const target=duration*cumulative/total;
    const remaining=sentences.length-index-2;
    const available=candidates.filter((value,candidateIndex)=>value>minimum+.03&&candidates.length-candidateIndex-1>=remaining);
    const selected=available.reduce((best,value)=>Math.abs(value-target)<Math.abs(best-target)?value:best,available[0]!);
    boundaries.push(selected);minimum=selected;
  }
  const cues=sentences.map((text,index)=>({start:index?boundaries[index-1]!:0,end:index<boundaries.length?boundaries[index]!:duration,text}));
  assertTimeline(cues,duration);return cues;
}

function rawText(value: { text?: unknown; punctuation?: unknown }): string {
  const text = String(value.text || '');
  const punctuation = String(value.punctuation || '');
  return punctuation && !text.trimEnd().endsWith(punctuation) ? text + punctuation : text;
}

function assertTimeline(cues: TimedCue[], duration: number): void {
  let end = 0;
  for (const cue of cues) {
    if (!cue.text.trim() || !Number.isFinite(cue.start) || !Number.isFinite(cue.end)
      || cue.start < end - 0.03 || cue.end <= cue.start || cue.end > duration + 0.3) {
      throw new Error('音频对齐时间轴无效');
    }
    end = cue.end;
  }
}

function sentenceCues(sentences: RawSentence[]): TimedCue[] {
  return sentences.map(sentence => ({
    start: Number(sentence.begin_time) / 1000,
    end: Number(sentence.end_time) / 1000,
    text: rawText(sentence),
  }));
}

/**
 * DashScope occasionally emits zero-length timestamps for unstressed English
 * words (for example "a", "in" and "us"). Keep their measured boundary by
 * merging them into the following timed token instead of rejecting the whole
 * audio track or inventing a duration.
 */
function mergedWordCues(sentences: RawSentence[]): TimedCue[] {
  const cues: TimedCue[] = [];
  for (const sentence of sentences) {
    const words = Array.isArray(sentence.words) ? sentence.words : [];
    let pendingText = '';
    let pendingStart: number | null = null;
    for (const word of words) {
      const start = Number(word.begin_time) / 1000;
      const end = Number(word.end_time) / 1000;
      const text = rawText(word);
      if (!(Number.isFinite(start) && Number.isFinite(end))) {
        cues.push({ start, end, text });
        continue;
      }
      if (end <= start) {
        pendingText += text;
        pendingStart ??= start;
        continue;
      }
      cues.push({ start: pendingStart ?? start, end, text: pendingText + text });
      pendingText = '';
      pendingStart = null;
    }
    if (pendingText && cues.length) cues[cues.length - 1]!.text += pendingText;
  }
  return cues;
}

export function verifiedAudioCues(raw: any, transcript: string, duration: number): TimedCue[] {
  const transcriptRecord = raw?.transcripts?.[0];
  const sentences = Array.isArray(transcriptRecord?.sentences) ? transcriptRecord.sentences as RawSentence[] : [];
  const expectedSentences = splitSentences(transcript);
  const recognizedText = String(transcriptRecord?.text || sentences.map(rawText).join(' ')).trim();

  // Sentence boundaries come directly from the finished audio. ASR spelling
  // can legitimately differ for acronyms and spoken numbers, so require a
  // strong whole-track match and one-to-one sentence structure, then retain
  // the user's authoritative copy on those measured boundaries.
  const measuredSentences = sentenceCues(sentences);
  const similarity = editSimilarity(recognizedText, transcript);
  if (measuredSentences.length && measuredSentences.length === expectedSentences.length && similarity >= 0.82) {
    assertTimeline(measuredSentences, duration);
    return measuredSentences.map((cue, index) => ({ ...cue, text: expectedSentences[index]! }));
  }

  const words = mergedWordCues(sentences);
  assertTimeline(words, duration);
  if (!words.length || normalizedSpeech(words.map(cue => cue.text).join('')) !== normalizedSpeech(transcript)) {
    throw new Error('实际音频与口播文本不一致，请复核文本');
  }
  return words;
}

/** DashScope returns a signed result URL on an OSS regional endpoint. */
export function trustedQwenTranscriptionUrl(value: unknown): URL {
  if (typeof value !== 'string') throw new Error('音频字幕下载地址不可信');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('音频字幕下载地址不可信'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash
    || !/^(?:[a-z0-9][a-z0-9-]*\.)?oss-[a-z0-9-]+\.aliyuncs\.com$/i.test(url.hostname)) {
    throw new Error('音频字幕下载地址不可信');
  }
  url.protocol = 'https:';
  return url;
}

async function downloadQwenTranscription(url: URL): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: 'error' });
  if (!response.ok || !response.body) throw new Error('音频字幕下载失败');
  const parts: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 8 * 1024 * 1024) throw new Error('音频字幕文件过大');
      parts.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw new Error('音频字幕格式无效'); }
}

export async function alignQwenFile(url: string, transcript: string, duration: number, cacheFile: string, trusted?:{audioSha256:string;durableRoot?:string;localFilePath?:string}) {
  const context=studioVoicePaidContext();
  if(context) {
    if(!trusted||!/^[a-f0-9]{64}$/.test(trusted.audioSha256)||!(duration>0&&duration<=300))throw Error('voice_alignment_actual_audio_evidence_missing');
    const base=(process.env.DASHSCOPE_ASR_BASE_URL||'https://dashscope.aliyuncs.com/api/v1').replace(/\/$/,'');
    const request:StudioVoicePaidRequest={stage:'voice_alignment',provider:'qwen',model:'qwen3-asr-flash-filetrans',voiceId:null,endpoint:base+'/services/audio/asr/transcription',accountKeyHash:createHash('sha256').update(dashscopeApiKey()).digest('hex'),audioSha256:trusted.audioSha256,audioSeconds:duration,request:{model:'qwen3-asr-flash-filetrans',input:{file_url:url},parameters:{channel_id:[0],enable_itn:false,enable_words:true}}};
    const paid=await context.forRequest(request);await paid.assertProviderBinding(request);
    const root=trusted.durableRoot||path.resolve('data/social-content-voice-alignment');
    const hash=createHash('sha256').update(paid.intent.operationId).digest('hex');
    const durable=path.join(root,hash+'.json');fs.mkdirSync(root,{recursive:true,mode:0o700});
    return withPaidOperationLock(path.join(root,'.locks'),hash,()=>alignQwenFileInternal(url,transcript,duration,durable,{request,paid,localFilePath:trusted.localFilePath,audioSha256:trusted.audioSha256}));
  }
  return alignQwenFileInternal(url,transcript,duration,cacheFile);
}
async function alignQwenFileInternal(url:string,transcript:string,duration:number,cacheFile:string,guard?:{request:StudioVoicePaidRequest;paid:Awaited<ReturnType<NonNullable<ReturnType<typeof studioVoicePaidContext>>['forRequest']>>;localFilePath?:string;audioSha256:string}) {
  const base = (process.env.DASHSCOPE_ASR_BASE_URL || 'https://dashscope.aliyuncs.com/api/v1').replace(/\/$/, '');
  const headers = {
    Authorization: `Bearer ${dashscopeApiKey()}`,
    'Content-Type': 'application/json',
    'X-DashScope-Async': 'enable',
  };
  let cache: any = {};
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { /* no cached task yet */ }
  const scope=guard?{audioSha256:guard.request.audioSha256,transcriptSha256:createHash('sha256').update(transcript).digest('hex'),duration,endpoint:guard.request.endpoint,accountKeyHash:guard.request.accountKeyHash,operationId:guard.paid.intent.operationId,inputContractHash:guard.paid.intent.inputContractHash}:null;
  if(guard&&Object.keys(cache).length&&JSON.stringify(cache.scope)!==JSON.stringify(scope))throw Error('voice_alignment_original_scope_changed');
  const persist=(value:unknown)=>{const temporary=cacheFile+'.'+randomUUID()+'.tmp';const fd=fs.openSync(temporary,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temporary,cacheFile);const directory=fs.openSync(path.dirname(cacheFile),'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}};
  if (cache.result) {if(guard)await guard.paid.permit.assertRecovery(guard.paid.intent.operationId);return verifiedAudioCues(cache.result, transcript, duration);}
  if(guard&&cache.state==='submitting'&&!cache.taskId) {
    const recovery=await guard.paid.permit.assertRecovery(guard.paid.intent.operationId);
    let raw:any;try {raw=JSON.parse(fs.readFileSync(recovery.receiptRef || '', 'utf8'));}catch{}
    const originalId=raw?.response?.output?.task_id;
    if(recovery?.status!=='accepted'||typeof originalId!=='string'||!originalId||raw.operationId!==guard.paid.intent.operationId||raw.inputContractHash!==guard.paid.intent.inputContractHash||raw.audioSha256!==guard.request.audioSha256||raw.audioSeconds!==duration||raw.accountKeyHash!==guard.request.accountKeyHash)throw Error('voice_alignment_submission_unknown_no_repost');
    cache={scope,state:'accepted',taskId:originalId};persist(cache);
  }
  if(guard&&cache.taskId)await guard.paid.permit.assertRecovery(guard.paid.intent.operationId);

  const call = async (route: string, body?: any) => {
    const response = await fetch(base + route, {
      method: body ? 'POST' : 'GET',
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    const json: any = await response.json();
    if (!response.ok || json.code) throw new Error('千问音频对齐服务暂不可用');
    return json;
  };

  if (!cache.taskId) {
    const body={model:'qwen3-asr-flash-filetrans',input:{file_url:url},parameters:{channel_id:[0],enable_itn:false,enable_words:true}};
    if(guard){const {maximumUnits:_,...binding}=guard.paid.intent;await guard.paid.permit.beforeSubmit({...binding,actualUnits:await guard.paid.measureUsage(guard.request)});persist({scope,state:'submitting'});}
    const task = await call('/services/audio/asr/transcription', body);
    if(guard){const receipt=await guard.paid.persistProviderReceipt({requestSha256:createHash('sha256').update(JSON.stringify(body)).digest('hex'),response:task,audioSha256:guard.request.audioSha256,audioSeconds:duration});await guard.paid.permit.markOutcome(guard.paid.intent.operationId,'accepted',receipt);}
    if (!task.output?.task_id) throw new Error('音频对齐未返回任务ID');
    cache = { taskId: task.output.task_id,...(guard?{scope,state:'accepted'}:{}) };
    persist(cache);
  }

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const state = await call(`/tasks/${encodeURIComponent(cache.taskId)}`);
    if (state.output?.task_status === 'FAILED') {
      const code=String(state.output.code||'');
      if(code==='FILE_DOWNLOAD_FAILED'&&guard?.localFilePath){
        const cues=await measuredLocalAudioCues(guard.localFilePath,transcript,duration,guard.audioSha256);
        const result={transcripts:[{text:transcript,sentences:cues.map(cue=>({text:cue.text,begin_time:Math.round(cue.start*1000),end_time:Math.round(cue.end*1000)}))}]};
        persist({...cache,result,state:'completed',completion:{task_status:'FAILED',code},recovery:'verified_local_waveform'});
        return verifiedAudioCues(result,transcript,duration);
      }
      throw new Error(`音频对齐失败：${code||'请重新生成音频'}`);
    }
    if (state.output?.task_status === 'SUCCEEDED') {
      const target = trustedQwenTranscriptionUrl(state.output.result?.transcription_url);
      const result = await downloadQwenTranscription(target);
      const cues=verifiedAudioCues(result,transcript,duration);
      persist({...cache,result,...(guard?{state:'completed',completion:state}:{})});
      if(guard)await guard.paid.permit.markOutcome(guard.paid.intent.operationId,'completed',cacheFile);
      return cues;
    }
    await new Promise(resolve => setTimeout(resolve, 1_500));
  }
  throw new Error('音频对齐仍在处理，请稍后重试；不会重复提交任务');
}
