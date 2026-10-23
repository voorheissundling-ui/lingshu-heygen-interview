import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { dashscopeApiKey } from '../agents/qwen.js';
import { benchmarkTimeRange, recordOf } from '../../shared/benchmarkAnalysis.js';
import type { VideoAiAnalysis } from '../types/index.js';
import {QWEN_COMPATIBLE_BASE_URL} from './qwenCompatibleEndpoint.js';
import { CRITICAL_SHOT_FRAME_POLICY, extractReferenceEvidenceFrames, referenceCriticalFrameSchedule } from './referenceCriticalShotProduction.js';
import { withPaidOperationLock } from './paidOperationLock.js';
import type { ReferenceCriticalFrame } from './referenceCriticalShots.js';
import { GoogleGenAI } from '@google/genai';

export const PRESENTER_CONTINUITY_VERSION = 'source-person-visibility-continuity-v2';
export interface PresenterContinuityEvidence {
  personPresence: 'person' | 'hands_only' | 'none' | 'unknown';
  observedPresenterRole: 'sales_presenter' | 'presenter_action' | 'background' | 'none' | 'unknown';
  personContinuityId: string; confidence: number; evidence: string[]; frameSeconds: number[];
  time: string; model: string; provenance: string; sourceSha256: string;
}
type Input = { analysis: VideoAiAnalysis; frames: ReferenceCriticalFrame[]; sourceSha256: string; videoId: string };
const text = (v: unknown) => typeof v === 'string' ? v.trim() : '';
function invalid(reason: string): never { throw new Error(`presenter_continuity_invalid:${reason}`); }

export function validatePresenterContinuity(input: Input, output: unknown, model: string, provider = 'qwen') {
  const envelope = Array.isArray(output) && output.length === 1 ? output[0] : output;
  const root = recordOf(envelope), details = input.analysis.scriptDetails15s || [];
  const rows = Array.isArray(root.shots) ? root.shots.map(recordOf) : [];
  if (rows.length !== details.length || new Set(rows.map(r => r.shotId)).size !== details.length) invalid('missing_or_duplicate_shots');
  return details.map((shot, index) => {
    const id = `shot-${index + 1}`, row = rows.find(r => r.shotId === id) || invalid(`${id}:missing`);
    const range = benchmarkTimeRange(shot.time || shot.timestamp) || invalid(`${id}:invalid_time`);
    // One mutually exclusive model verdict; deterministic enum projection
    // cannot manufacture a visual judgment or cross-shot identity.
    const mappings: Record<string, [PresenterContinuityEvidence['personPresence'],PresenterContinuityEvidence['observedPresenterRole']]> = {
      foreground_presenter:['person','sales_presenter'],presenter_action:['person','presenter_action'],
      background_people:['person','background'],hands_only:['hands_only','none'],no_person:['none','none'],unknown:['unknown','unknown'] };
    const mapping = mappings[text(row.visibility)] || invalid(`${id}:invalid_visibility`);
    if (typeof row.confidence !== 'number' || row.confidence < 0 || row.confidence > 1) invalid(`${id}:invalid_confidence`);
    const evidence = Array.isArray(row.evidence) ? row.evidence.map(text).filter(Boolean) : [];
    const seconds = Array.isArray(row.frameSeconds) ? row.frameSeconds : [];
    const actual = input.frames.filter(f => f.shotId === id && f.seconds >= range.start && f.seconds < range.end);
    if (!evidence.length || seconds.length < 2 || !seconds.every(v => typeof v === 'number' && actual.some(f => Math.abs(f.seconds-v) < .005))) invalid(`${id}:missing_or_fabricated_frames`);
    const frameSeconds = [...new Set(seconds.map(v => actual.find(f => Math.abs(f.seconds-Number(v)) < .005)!.seconds))];
    if (frameSeconds.length < 2) invalid(`${id}:duplicate_frames`);
    const [presence, role] = mapping;
    const personId = text(row.personContinuityId);
    if ((role === 'sales_presenter' || role === 'presenter_action') && (presence !== 'person' || !personId)) invalid(`${id}:identity_missing`);
    if (role === 'background' && presence !== 'person') invalid(`${id}:background_without_person`);
    if (role === 'none' && !['none','hands_only'].includes(presence)) invalid(`${id}:none_is_not_no_speaker`);
    if (role !== 'sales_presenter' && role !== 'presenter_action' && personId) invalid(`${id}:unverified_identity`);
    if (row.confidence < .85 && role !== 'unknown') invalid(`${id}:low_confidence_must_remain_unknown`);
    const presenterContinuityEvidence: PresenterContinuityEvidence = { personPresence: presence, observedPresenterRole: role,
      personContinuityId: personId, confidence: row.confidence, evidence, frameSeconds, time: String(shot.time || shot.timestamp),
      model, provenance: `${provider}_vl:actual_source_frames_person_continuity`, sourceSha256: input.sourceSha256 };
    return { ...shot, presenterContinuityEvidence, observedPresenterRole: role, personContinuityId: personId,
      salesPresenterConfirmed: role === 'sales_presenter' && row.confidence >= .85 };
  });
}

function presenterContinuityPrompt(input: Input): string {
  const shots = (input.analysis.scriptDetails15s || []).map((shot,index) => ({ shotId: `shot-${index+1}`, time: shot.time || shot.timestamp,
    measuredSpeech: shot.speechAlignment?.words.map(w => ({ text:w.text,start:w.start,end:w.end })),
    frameSeconds: input.frames.filter(f=>f.shotId===`shot-${index+1}`).map(f=>f.seconds) }));
  return `你是产品侧原片人物可见性和跨镜人物身份分析器。这与关键镜头分类无关，不能用关键/非关键猜人物。
仅根据各镜提供的实际原片帧判断。ASR词只是原音频证据，画外音不等于画中人物讲话。不要按旧描述猜人物。
每镜只选择一个互斥visibility枚举：foreground_presenter（可见固定主讲者对镜说话/讲解）、presenter_action（明确同一主讲人物的动作展示）、background_people（可见其他人、背身工人、背景人员，即使无正面脸也属于本项）、hands_only（仅手部产品展示，无可识别主讲脸/人物身体）、no_person（完全无人物及身体部分，只有产品/机器/环境）、unknown（视觉/身份无法确认）。请先检查身体是否出现，再区分是否主讲者。背景环境不等于background_people；无人产品柜/无人展厅/仅机器必须no_person。ASR讲产品不证明手部属于主讲者，只有手必须hands_only，不能填presenter_action。关键性不影响此枚举。
所有可确认的同一主讲人物跨镜共用稳定personContinuityId（person_1等），用脸部特征、身形及跨镜相同人物证据识别，不得仅凭性别/服装断言。同一主讲者即使侧身/走动，明确身份时仍连续，观察讲话/面对镜头行为。背景工人与仅手部不绑定主讲ID。foreground_presenter/presenter_action必须有可识别人物和ID，否则unknown；hands_only/background_people/no_person/unknown必须ID空字符串；置信不足0.85保持unknown，不能猜。每镜至少引用两帧实际秒值，evidence写具体中文视觉和身份依据，不需要人工确认节点。
只输出JSON对象 {"shots":[{"shotId":"shot-1","visibility":"foreground_presenter|presenter_action|background_people|hands_only|no_person|unknown","personContinuityId":"person_1或空字符串","confidence":0.95,"evidence":["中文具体帧和跨镜证据"],"frameSeconds":[实际提供帧秒数]}]}，每镜完整一次，共${shots.length}镜。数据:${JSON.stringify(shots)}`;
}

export async function recognizePresenterContinuity(input: Input, options: { fetcher?: typeof fetch; apiKey?: string; model?: string } = {}) {
  const model = exactQwenScope()?.model || options.model || process.env.QWEN_CRITICAL_SHOT_MODEL || 'qwen3-vl-plus';
  const prompt = presenterContinuityPrompt(input);
  const content: Array<Record<string,unknown>> = [{type:'text',text:prompt}];
  for(const frame of input.frames) { content.push({type:'text',text:`${frame.shotId} 实际源帧 ${frame.seconds.toFixed(3)}s`}); content.push({type:'image_url',image_url:{url:`data:${frame.mimeType};base64,${frame.base64}`}}); }
  const requestBody=JSON.stringify({model,temperature:0,response_format:{type:'json_object'},max_tokens:10000,messages:[{role:'user',content}]});
  if(exactQwenScope())await authorizeExactQwenProviderRequest(requestBody);
  const response = await (options.fetcher || fetch)((exactQwenScope()?.endpoint || process.env.DASHSCOPE_BASE_URL || QWEN_COMPATIBLE_BASE_URL).replace(/\/+$/,'')+'/chat/completions', {
    method:'POST',headers:{Authorization:`Bearer ${options.apiKey || dashscopeApiKey()}`,'Content-Type':'application/json'},
    body:requestBody,signal:AbortSignal.timeout(120000),redirect:'error' });
  if(exactQwenScope())await recordExactQwenProviderResponse(response,requestBody);
  if(!response.ok) throw new Error(`presenter_continuity_http_${response.status}`);
  const payload=recordOf(await response.json()), choice=recordOf(Array.isArray(payload.choices)?payload.choices[0]:undefined);
  const raw=text(recordOf(choice.message).content), providerResponse={raw,model,usage:recordOf(payload.usage)};
  return {providerResponse, finishReason:choice.finish_reason};
}

export async function recognizePresenterContinuityWithGemini(input: Input) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
  const model = (process.env.GEMINI_PRESENTER_CONTINUITY_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim();
  const parts: any[] = [{ text: presenterContinuityPrompt(input) }];
  for (const frame of input.frames) {
    parts.push({ text: `${frame.shotId} 实际源帧 ${frame.seconds.toFixed(3)}s` });
    parts.push({ inlineData: { mimeType: frame.mimeType, data: frame.base64 } });
  }
  const response = await new GoogleGenAI({ apiKey }).models.generateContent({
    model, contents: [{ role: 'user', parts }],
    config: { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: 10000, abortSignal: AbortSignal.timeout(120000) },
  });
  return { providerResponse: { raw: String(response.text || '').trim(), model, usage: response.usageMetadata || {} }, finishReason: 'stop' };
}

export async function producePresenterContinuity(input: { filePath:string;analysis:VideoAiAnalysis;sourceSha256:string;videoId:string;tenantId?:string;duration:number },
  options:{cacheRoot?:string;recognize?:typeof recognizePresenterContinuity}={}) {
  const assertOriginalBytes = () => {
    if (!/^[a-f0-9]{64}$/.test(input.sourceSha256) || createHash('sha256').update(fs.readFileSync(input.filePath)).digest('hex') !== input.sourceSha256)
      throw new Error('presenter_continuity_source_changed');
  };
  assertOriginalBytes();
  const provider=exactQwenScope() ? 'qwen' : (process.env.PRESENTER_CONTINUITY_PROVIDER || 'qwen').trim().toLowerCase();
  const model=provider === 'gemini'
    ? (process.env.GEMINI_PRESENTER_CONTINUITY_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash')
    : (exactQwenScope()?.model || process.env.QWEN_CRITICAL_SHOT_MODEL || 'qwen3-vl-plus');
  const key=createHash('sha256').update(JSON.stringify({version:PRESENTER_CONTINUITY_VERSION,framePolicy:CRITICAL_SHOT_FRAME_POLICY,model,tenantId:input.tenantId,
    videoId:input.videoId,source:input.sourceSha256,duration:input.duration,
    shots:input.analysis.scriptDetails15s?.map(s=>[s.time||s.timestamp]),words:input.analysis.audioTranscript?.words})).digest('hex');
  const root=options.cacheRoot || path.resolve('data/analysis-output/presenter-continuity');fs.mkdirSync(root,{recursive:true});
  const file=path.join(root,`${key}.json`), read=()=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
  return withPaidOperationLock(path.join(root,'.locks'),key,async()=>{
    assertOriginalBytes();
    const prior=read();
    if(prior?.evidence) return {...input.analysis,scriptDetails15s:input.analysis.scriptDetails15s?.map((s,i)=>({...s,...prior.evidence[i]})),presenterContinuitySummary:prior.summary};
    if(prior && !prior.providerResponse?.raw) throw new Error('人物识别提交状态未知，不重复付费；等待原任务自动恢复');
    const schedule=referenceCriticalFrameSchedule(input.analysis,input.duration);
    // Dense identity witnesses for long on-camera segments; no old role label used.
    for(let i=0;i<(input.analysis.scriptDetails15s?.length||0);i++) {
      const range=benchmarkTimeRange(input.analysis.scriptDetails15s![i].time||input.analysis.scriptDetails15s![i].timestamp);
      if(range && range.end-range.start>3 && i!==0) for(const fraction of [.15,.3,.65,.8]) schedule.push({shotId:`shot-${i+1}`,seconds:Number((range.start+(Math.min(range.end,input.duration)-range.start)*fraction).toFixed(3))});
    }
    const frames=await extractReferenceEvidenceFrames(input.filePath,input.analysis,input.duration,schedule,root);
    assertOriginalBytes();
    const classificationInput={analysis:input.analysis,frames,sourceSha256:input.sourceSha256,videoId:input.videoId};
    try {
      let supplier=prior;
      if(!supplier?.providerResponse) {
        fs.writeFileSync(file,JSON.stringify({key,status:'submitting',startedAt:new Date().toISOString()}),{mode:0o600});
        supplier=await (options.recognize || (provider === 'gemini' ? recognizePresenterContinuityWithGemini : recognizePresenterContinuity))(classificationInput);
        fs.writeFileSync(file,JSON.stringify({key,status:'received',...supplier}),{mode:0o600});
      }
      assertOriginalBytes();
      if(supplier.finishReason==='length') throw new Error('人物识别JSON截断，保留原请求不重复付费');
      const details=validatePresenterContinuity(classificationInput,JSON.parse(supplier.providerResponse.raw),model,provider);
      const summary={version:PRESENTER_CONTINUITY_VERSION,provider,model,sourceSha256:input.sourceSha256,videoId:input.videoId,
        framePolicy:CRITICAL_SHOT_FRAME_POLICY,
        cacheKey:key,analyzedAt:new Date().toISOString(),frameCount:frames.length,
        frameEvidence:frames.map(({shotId,seconds,requestedSeconds})=>({shotId,seconds,requestedSeconds})),providerResponse:supplier.providerResponse};
      const evidence=details.map(s=>({presenterContinuityEvidence:s.presenterContinuityEvidence,observedPresenterRole:s.observedPresenterRole,
        personContinuityId:s.personContinuityId,salesPresenterConfirmed:s.salesPresenterConfirmed}));
      const temp=`${file}.${randomUUID()}.tmp`;fs.writeFileSync(temp,JSON.stringify({key,status:'completed',evidence,summary},null,2),{mode:0o600});fs.renameSync(temp,file);
      return {...input.analysis,scriptDetails15s:details,presenterContinuitySummary:summary};
    } catch(error) {
      const saved=read();if(saved) fs.writeFileSync(file,JSON.stringify({...saved,status:saved.providerResponse?'failed_validation':'uncertain',error:error instanceof Error?error.message:String(error)},null,2),{mode:0o600});
      throw error;
    }
  });
}
import {authorizeExactQwenProviderRequest,exactQwenScope,recordExactQwenProviderResponse} from '../agents/exactQwenScope.js';
