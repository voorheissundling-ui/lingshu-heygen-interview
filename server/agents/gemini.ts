import { GoogleGenAI, type Content } from '@google/genai';
import type { VideoAiAnalysis, VoiceoverContent, StoryboardContent, ScriptType, Language } from '../types/index.js';
import type { ImagePostEvidenceAnalysis } from './qwen.js';
import { GEMINI_ANALYSIS_DIRECTOR_CONTRACT, GEMINI_STORYBOARD_DIRECTOR_CONTRACT } from '../prompts/geminiVideoScriptDirector.js';
import { untrustedPromptData } from '../lib/untrustedPromptData.js';
import { benchmarkMaterialType, benchmarkShotRole } from '../../shared/benchmarkAnalysis.js';

const MODEL = () => (process.env.GEMINI_MODEL ?? 'gemini-2.5-flash').trim();

function client(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
  return new GoogleGenAI({ apiKey });
}

// ─── Concurrency queue ────────────────────────────────────────────────────────

const MAX_CONCURRENT = 2;
const WINDOW_MS = 60_000;
const MAX_STARTS_PER_WINDOW = 15;

let activeCount = 0;
const startTimestamps: number[] = [];
let mutex: Promise<void> = Promise.resolve();

function pruneTsWindow(now: number): void {
  const cutoff = now - WINDOW_MS;
  while (startTimestamps.length > 0 && startTimestamps[0]! < cutoff) startTimestamps.shift();
}

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const next = new Promise<void>((r) => { release = r; });
  const prev = mutex;
  mutex = next;
  await prev;
  try { return await fn(); } finally { release(); }
}

async function tryAdmit(): Promise<boolean> {
  return withLock(async () => {
    const now = Date.now();
    pruneTsWindow(now);
    if (activeCount < MAX_CONCURRENT && startTimestamps.length < MAX_STARTS_PER_WINDOW) {
      activeCount++;
      startTimestamps.push(Date.now());
      return true;
    }
    return false;
  });
}

async function releaseSlot(): Promise<void> {
  await withLock(async () => { activeCount = Math.max(0, activeCount - 1); });
}

async function throughQueue<T>(fn: () => Promise<T>): Promise<T> {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  while (!(await tryAdmit())) {
    await sleep(50 + Math.random() * 200);
  }
  try { return await fn(); } finally { await releaseSlot(); }
}

// ─── Retry ────────────────────────────────────────────────────────────────────

function isRetriable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /503|502|504|429|UNAVAILABLE|high demand|RESOURCE_EXHAUSTED/i.test(msg);
}

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 4): Promise<T> {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const delays = [2000, 5000, 10000];
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await throughQueue(fn);
    } catch (e) {
      lastErr = e;
      if (!isRetriable(e) || attempt >= maxAttempts) throw e;
      await sleep(delays[attempt - 1] ?? 10000);
    }
  }
  throw lastErr;
}

// ─── Core generate helpers ────────────────────────────────────────────────────

async function generateText(opts: {
  contents: string | Content[];
  systemInstruction?: string;
  jsonMode?: boolean;
}): Promise<string> {
  const ai = client();
  const response = await ai.models.generateContent({
    model: MODEL(),
    contents: opts.contents as string,
    config: {
      ...(opts.systemInstruction ? { systemInstruction: opts.systemInstruction } : {}),
      ...(opts.jsonMode ? { responseMimeType: 'application/json' } : {}),
    },
  });
  return response.text ?? '';
}

function parseJson<T>(raw: string, fallback: T): T {
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

export async function analyzeImagePostEvidenceWithGemini(opts: {
  images: Array<{ base64: string; mimeType: string; imageIndex: number }>;
  title?: string;
  caption?: string;
  platform?: string;
  tags?: string[];
}): Promise<ImagePostEvidenceAnalysis> {
  if (!opts.images.length) throw new Error('Gemini image evidence analysis requires at least one image');
  const metadataEvidence = untrustedPromptData('image_post_metadata', JSON.stringify({
    title: opts.title || '',
    caption: opts.caption || '',
    platform: opts.platform || '',
    tags: opts.tags || [],
  }), 12_000);
  const prompt = `你是外贸 B2B 社媒竞品图文的证据提取器。图片按轮播顺序提供。
只写图片中实际可见或原 caption 明确出现的内容；不得推断爆款原因、目标人群、效果、认证、价格、MOQ、工厂资质或互动结果。无法确认就放入 uncertainties。所有字符串用简体中文，只输出合法 JSON。

${metadataEvidence}

Schema:
{"version":2,"status":"analyzed","observedFacts":[{"imageIndex":1,"subjects":[],"scene":"","composition":"","colors":[],"visibleText":[],"confidence":0}],"carouselFlow":[{"imageIndex":1,"role":"attention|product|detail|proof|process|cta|unknown","evidence":"","confidence":0}],"copyEvidence":{"hooks":[{"text":"","source":"caption|ocr","evidence":""}],"sellingPoints":[{"text":"","source":"caption|ocr","evidence":""}],"cta":[]},"reusableModules":[{"module":"","evidence":"","preserve":"","replace":"","confidence":0}],"uncertainties":[]}`;
  const contents: Content[] = [{
    role: 'user',
    parts: [
      { text: prompt },
      ...opts.images.flatMap(image => [
        { text: `第 ${image.imageIndex} 张图片` },
        { inlineData: { mimeType: image.mimeType, data: image.base64.replace(/^data:[^,]+,/, '') } },
      ]),
    ],
  }];
  const raw = await withRetry(() => generateText({ contents, jsonMode: true }));
  const parsed = parseJson<Partial<ImagePostEvidenceAnalysis>>(raw, {});
  if (!Array.isArray(parsed.observedFacts) || !parsed.observedFacts.length) throw new Error('Gemini image evidence result is incomplete');
  return { ...parsed, version: 2, status: 'analyzed' } as ImagePostEvidenceAnalysis;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function parseFirstTenSeconds(value: unknown): VideoAiAnalysis['firstTenSeconds'] | undefined {
  if (!isRecord(value)) return undefined;
  const result = {
    atmosphere: String(value.atmosphere ?? '').trim(),
    audioVisual: String(value.audioVisual ?? '').trim(),
    camera: String(value.camera ?? '').trim(),
    visuals: String(value.visuals ?? '').trim(),
    voiceMusic: String(value.voiceMusic ?? '').trim(),
  };
  return Object.values(result).some(Boolean) ? result : undefined;
}

function parseCoarseStructure(value: unknown): VideoAiAnalysis['coarseStructure'] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows = value.map((item, index) => {
    if (!isRecord(item)) return null;
    const description = String(item.description ?? item.frame ?? item.desc ?? '').trim();
    if (!description) return null;
    return {
      time: String(item.time ?? `${index * 3}-${(index + 1) * 3}s`).trim(),
      label: String(item.label ?? `粗略帧 ${index + 1}`).trim(),
      description,
    };
  }).filter((item): item is NonNullable<typeof item> => Boolean(item));
  return rows.length ? rows.slice(0, 12) : undefined;
}

function parseScriptSummary15s(value: unknown): VideoAiAnalysis['scriptSummary15s'] | undefined {
  if (!isRecord(value)) return undefined;
  const result = {
    visualStyle: String(value.visualStyle ?? '').trim(),
    coreEmotion: String(value.coreEmotion ?? '').trim(),
    competitors: Array.isArray(value.competitors) ? value.competitors.map(String).filter(Boolean) : [],
  };
  return result.visualStyle || result.coreEmotion || result.competitors.length ? result : undefined;
}

function parseGlobalSettings(value: unknown): VideoAiAnalysis['globalSettings'] | undefined {
  if (!isRecord(value)) return undefined;
  return {
    visualStyle: String(value.visualStyle ?? '').trim(),
    aspectRatio: String(value.aspectRatio ?? '').trim(),
    lighting: String(value.lighting ?? '').trim(),
    subtitlePolicy: String(value.subtitlePolicy ?? '').trim(),
    audioPolicy: String(value.audioPolicy ?? '').trim(),
    identityConsistency: String(value.identityConsistency ?? '').trim(),
    productConsistency: String(value.productConsistency ?? '').trim(),
    negativeConstraints: Array.isArray(value.negativeConstraints) ? value.negativeConstraints.map(String).filter(Boolean) : [],
  };
}

function parseSpatialContinuity(value: unknown): VideoAiAnalysis['spatialContinuity'] | undefined {
  if (!isRecord(value)) return undefined;
  const priority = String(value.backgroundPriority ?? '');
  const depth = String(value.depthOfField ?? '');
  return {
    scene: String(value.scene ?? '').trim(),
    subjectAnchors: Array.isArray(value.subjectAnchors) ? value.subjectAnchors.filter(isRecord).map(anchor => ({
      subject: String(anchor.subject ?? '').trim(),
      position: String(anchor.position ?? '').trim(),
      facing: String(anchor.facing ?? '').trim(),
      gazeTarget: String(anchor.gazeTarget ?? '').trim(),
      orientation: String(anchor.orientation ?? '').trim(),
    })) : [],
    background: String(value.background ?? '').trim(),
    backgroundPriority: priority === 'low' || priority === 'high' ? priority : 'medium',
    depthOfField: depth === 'shallow' || depth === 'deep' ? depth : 'moderate',
  };
}

function normalizeAnalysisTime(value: unknown): string {
  const raw = String(value ?? '').trim();
  const numbers = Array.from(raw.matchAll(/(\d+(?:\.\d+)?)/g)).map(match => Number(match[1]));
  const clean = (number: number) => number.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
  if (numbers.length >= 2) return `${clean(numbers[0]!)}-${clean(numbers[1]!)}s`;
  if (numbers.length === 1) return `${clean(numbers[0]!)}s`;
  return raw;
}

type ViralPotential = NonNullable<NonNullable<VideoAiAnalysis['scriptDetails15s']>[number]['viralPotential']>;

/**
 * 爆款潜力改由模型给出。此前是前端拿中文关键词正则重算的，基础分 38 加任一命中即落进
 * 50–74 的“良”区间，几乎所有镜头同一档，看不出差别。模型没返回时留空，前端回退启发式。
 */
function parseViralPotential(value: unknown): ViralPotential | undefined {
  if (!isRecord(value)) return undefined;
  const rawScore = Number(value.score);
  const score = Number.isFinite(rawScore) ? Math.max(0, Math.min(100, Math.round(rawScore))) : undefined;
  const mechanisms = Array.isArray(value.mechanisms)
    ? value.mechanisms.map(String).map(item => item.trim()).filter(Boolean).slice(0, 4)
    : [];
  const whyEffective = String(value.whyEffective ?? '').trim();
  if (score === undefined && !mechanisms.length && !whyEffective) return undefined;
  return { score, mechanisms, whyEffective };
}

function parseScriptDetails15s(value: unknown): VideoAiAnalysis['scriptDetails15s'] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows = value.map((item) => {
    if (!isRecord(item)) return null;
    const visual = String(item.visual ?? '').trim();
    const subtitle = String(item.subtitle ?? '').trim();
    if (!visual && !subtitle) return null;
    return {
      time: normalizeAnalysisTime(item.time ?? item.timestamp),
      materialType: benchmarkMaterialType(item.materialType),
      narrativeRole: benchmarkShotRole(item.narrativeRole),
      classificationEvidence: String(item.classificationEvidence ?? '').trim(),
      environment: String(item.environment ?? '').trim(),
      shot: String(item.shot ?? '').trim(),
      camera: String(item.camera ?? '').trim(),
      angle: String(item.angle ?? '').trim(),
      composition: String(item.composition ?? '').trim(),
      visual,
      personContinuityId: String(item.personContinuityId ?? '').trim(),
      observedPresenterRole: (['sales_presenter', 'presenter_action', 'background', 'none', 'unknown'].includes(String(item.observedPresenterRole)) ? item.observedPresenterRole : undefined) as NonNullable<VideoAiAnalysis['scriptDetails15s']>[number]['observedPresenterRole'],
      subtitle,
      audio: String(item.audio ?? '').trim(),
      note: String(item.note ?? '').trim(),
      purpose: String(item.purpose ?? '').trim(),
      dialogue: String(item.dialogue ?? '').trim(),
      voiceover: typeof item.voiceover === 'string' ? item.voiceover.trim() : '',
      onScreenText: String(item.onScreenText ?? '').trim(),
      ambientSound: String(item.ambientSound ?? '').trim(),
      bgm: String(item.bgm ?? '').trim(),
      soundEffects: Array.isArray(item.soundEffects) ? item.soundEffects.map(String).filter(Boolean) : [],
      beats: Array.isArray(item.beats) ? item.beats.filter(isRecord).map(beat => ({ time: normalizeAnalysisTime(beat.time), action: String(beat.action ?? '').trim(), dialogue: String(beat.dialogue ?? '').trim(), onScreenText: String(beat.onScreenText ?? '').trim() })).filter(beat => beat.action || beat.dialogue || beat.onScreenText) : [],
      viralPotential: parseViralPotential(item.viralPotential),
      persistentState: String(item.persistentState ?? '').trim(),
      startState: String(item.startState ?? '').trim(),
      endState: String(item.endState ?? '').trim(),
      transitionToNext: String(item.transitionToNext ?? '').trim(),
      backgroundPriority: ['low', 'medium', 'high'].includes(String(item.backgroundPriority)) ? String(item.backgroundPriority) as 'low' | 'medium' | 'high' : 'medium',
      depthOfField: ['shallow', 'moderate', 'deep'].includes(String(item.depthOfField)) ? String(item.depthOfField) as 'shallow' | 'moderate' | 'deep' : 'moderate',
      authenticity: String(item.authenticity ?? '').trim(),
      observedFacts: String(item.observedFacts ?? '').trim(),
      inferredIntent: String(item.inferredIntent ?? '').trim(),
      causalGap: String(item.causalGap ?? '').trim(),
      omniPrompt: String(item.omniPrompt ?? '').trim(),
      omniNegativePrompt: String(item.omniNegativePrompt ?? '').trim(),
      confidence: Math.max(0, Math.min(1, Number(item.confidence ?? 1) || 0)),
      needsReview: Boolean(item.needsReview),
      estimatedSpeechDuration: Math.max(0, Number(item.estimatedSpeechDuration ?? 0) || 0),
      dialogueFits: item.dialogueFits !== false,
    };
  }).filter((item): item is NonNullable<typeof item> => Boolean(item));
  return rows.length ? rows : undefined;
}

export function normalizeVideoAnalysis(parsed: Partial<VideoAiAnalysis>): VideoAiAnalysis {
  return {
    theme: String(parsed.theme ?? ''),
    identityEntities: Array.isArray(parsed.identityEntities) ? parsed.identityEntities.flatMap(entity => {
      if (!entity || !['company', 'brand', 'product'].includes(String(entity.type)) || !String(entity.text || '').trim()) return [];
      return [{
        type: entity.type,
        text: String(entity.text).trim(),
        evidence: String(entity.evidence || '').trim(),
        confidence: Math.max(0, Math.min(1, Number(entity.confidence ?? 0) || 0)),
      }];
    }) : [],
    hooks: Array.isArray(parsed.hooks) ? parsed.hooks.map(String) : [],
    sellingPoints: Array.isArray(parsed.sellingPoints) ? parsed.sellingPoints.map(String) : [],
    mood: String(parsed.mood ?? ''),
    structure: String(parsed.structure ?? ''),
    baseRequirements: String(parsed.baseRequirements ?? ''),
    globalSettings: parseGlobalSettings(parsed.globalSettings),
    spatialContinuity: parseSpatialContinuity(parsed.spatialContinuity),
    firstTenSeconds: parseFirstTenSeconds(parsed.firstTenSeconds),
    coarseStructure: parseCoarseStructure(parsed.coarseStructure),
    scriptSummary15s: parseScriptSummary15s(parsed.scriptSummary15s),
    scriptDetails15s: parseScriptDetails15s(parsed.scriptDetails15s),
    recommendedScriptType: parsed.recommendedScriptType === 'storyboard' ? 'storyboard' : 'voiceover',
  };
}

// ─── Public AI operations ─────────────────────────────────────────────────────

/** Analyze a video file (provided as base64) and return structured metadata */
export async function analyzeVideo(opts: {
  videoBase64: string;
  mimeType: string;
  analysisMode?: 'strategy' | 'exact';
}): Promise<VideoAiAnalysis> {
  const modeInstruction = opts.analysisMode === 'exact'
    ? '当前为全片精确分析：按真实镜头、主体动作、对象、构图、运镜、台词或营销功能变化高密度拆分全片，不得合并有效动作。'
    : '当前为默认全片策略分析：必须从 0 秒覆盖到结尾，镜头密度跟随真实内容变化；重复或稳定画面应合并为区间并用 beats 记录变化，禁止无意义逐秒拆分。';
  const systemInstruction = `你是一个面向出海电商营销的短视频内容分析专家。
${modeInstruction}
请分析提供的视频，并提取结构化信息。除合同枚举值、字段键和人物ID外，所有说明字符串内容必须使用简体中文输出。
只输出合法 JSON，不要 markdown，不要代码块，不要前后解释。
${GEMINI_ANALYSIS_DIRECTOR_CONTRACT}

必需 JSON 字段：
- theme: string，用一句中文概括视频核心主题/产品/场景
- identityEntities: array，仅提取口播、字幕或画面中明确出现的企业名、品牌名和产品名；每项包含 type("company"|"brand"|"product")、text、evidence、confidence，不确定时不输出
- hooks: string[], 2–4 个中文开头钩子或吸引注意力的方法
- sellingPoints: string[], 3–6 个中文卖点、利益点或画面展示点
- mood: string，中文情绪/风格描述，例如“高能评测”“种草感”“教程感”“幽默反差”
- structure: string，中文叙事结构，例如“痛点 → 展示 → 证明 → CTA”
- baseRequirements: string，作为第一段“基础要求”输出，必须包含情绪氛围、光影、全片主要场景、质感、基础创作要求；基础创作要求需明确强反转、真人口播、卡点、特效拉满、产品质感等可执行方向
- firstTenSeconds: object，详细分析视频前 10 秒，包含以下中文字段：
  - atmosphere: 氛围
  - audioVisual: 音画配合
  - camera: 运镜
  - visuals: 画面
  - voiceMusic: 配音配乐
- coarseStructure: array，覆盖原视频完整时长，按约 3–8 秒或内容结构变化拆解；每项包含 time、label、description
- scriptSummary15s: object（字段名仅为历史兼容），原视频全片脚本详析摘要，包含 visualStyle（指定画风）、coreEmotion（核心情绪）、competitors（竞品/品牌/视觉参照物数组；如无明确识别则空数组）
- scriptDetails15s: array（字段名仅为历史兼容），必须逐时间戳详析原视频完整时长，从 0 秒连续覆盖到视频结束，不得在 15 秒处截断；每项必须包含：
  - time: string，必须使用 "start-end s" 时间区间，例如 "0.2-1.0s"；按导演镜头切分，主体动作、展示对象、运镜或营销功能改变时新建镜头
  - environment: string，环境/场景，例如“白色浴室台面”“居家卧室”“户外街景”
  - shot: string，景别，例如“特写”“中景”“近景”
  - camera: string，运镜，例如“固定镜头”“微推近”“手持晃动”“旋转运镜”
  - visual: string，具体画面人物/产品/动作/场景
  - observedPresenterRole: sales_presenter（已确认贯穿视频的固定销售主讲者对镜说话，须绑定稳定人物 ID；单独的动作演员、路人、D to C 插镜人物不属于此类）、presenter_action（同一主讲者动作展示但未确认说话）、background（工人/路人/会议背景人物）、none（无人）、unknown（证据不足）。必须依赖可见口型、面向镜头及讲话证据；画外音不算真人口播；工厂背景或手持产品不能排除前景销售。与 personContinuityId 联合记录，身份或角色不确定时 needsReview=true。
  - personContinuityId: string，同一个可确认出镜人物跨镜头使用同一个稳定 ID（如 person_1）；无人出镜或无法确认是否同一人时留空，不得仅凭性别推断
  - purpose: string，镜头营销功能，如“反常识钩子”“效果证明”“价格反差”“CTA”
  - dialogue: string，只填写可确认的画内人物口播原文，听不清或画内/画外不能确认时留空
  - voiceover: string，只填写实际听到且确认是画外旁白的原文；未知留空，不复制 dialogue，不用“无”代替缺证据
  - onScreenText: string，只填写画面真实可见字幕，不得与口播混写
  - ambientSound: string，环境声；bgm: string，配乐；soundEffects: string[]，明确音效
  - beats: array，镜头内节拍；长镜头中动作、台词重点或字幕变化时记录 time、action、dialogue、onScreenText
  - persistentState: string，仅记录贯穿本镜头的构图、人物状态或持续声音，避免每个节拍重复
  - authenticity: string，注明必须使用真实素材或允许AI生成的真实性要求
  - confidence: number，0到1；needsReview: boolean，品牌、价格、型号、专名、左右方向或ASR不确定时必须为true
  - viralPotential: object，本镜头的爆款潜力判断，必须基于本镜头实际画面与声音，禁止套用通用话术：
    - score: number，0到100，必须拉开差距，不要集中在同一档。评分锚点：85以上=强钩子或强证据，观众极可能停留或转化；70-84=有明确记忆点但不够强烈；50-69=功能性过渡，可看但不驱动行为；50以下=信息稀薄或纯铺垫
    - mechanisms: string[]，最多4项，只写本镜头真实成立的机制，如“前3秒悬念”“价格反差”“效果对比”“真人证言”；没有就返回空数组，不要凑数
    - whyEffective: string，一句话说明为什么这个分数，必须引用本镜头的具体画面或台词作为依据；若分数低于50，直接说明弱在哪里
  - subtitle/audio: string，兼容字段，分别汇总 onScreenText 与音频信息
  - note: string，可选，只记录确定可见的信息；禁止编造品牌、@账号、原台词或无法确认的提示
导演镜头数量随原片时长和真实镜头变化决定，不设 15 秒或固定段数上限；不要每句话都切镜，也不要把包含多个动作或功能的长段落塞进一镜。每个分镜必须覆盖环境、景别、运镜、镜头功能、画面、口播、屏幕文字和声音，并用 beats 保留镜头内节奏。
- recommendedScriptType: "voiceover" | "storyboard"`;

  const raw = await withRetry(() =>
    generateText({
      contents: [
        {
          parts: [
            { inlineData: { data: opts.videoBase64.replace(/^data:[^,]+,/, ''), mimeType: opts.mimeType } },
            { text: '请分析这个视频，并返回中文 JSON。' },
          ],
        },
      ] as Content[],
      systemInstruction,
      jsonMode: true,
    }),
  );

  const parsed = parseJson<Partial<VideoAiAnalysis>>(raw, {});
  return normalizeVideoAnalysis(parsed);
}

/** Analyze a public YouTube URL directly with Gemini, avoiding local download when possible. */
export async function analyzeYouTubeUrl(opts: {
  url: string;
}): Promise<VideoAiAnalysis> {
  const systemInstruction = `你是一个面向出海电商营销的短视频内容分析专家。
请分析提供的 YouTube 视频，并提取结构化信息。除合同枚举值、字段键和人物ID外，所有说明字符串内容必须使用简体中文输出。
只输出合法 JSON，不要 markdown，不要代码块，不要前后解释。
${GEMINI_ANALYSIS_DIRECTOR_CONTRACT}

必需 JSON 字段：
- theme: string，用一句中文概括视频核心主题/产品/场景
- hooks: string[], 2–4 个中文开头钩子或吸引注意力的方法
- sellingPoints: string[], 3–6 个中文卖点、利益点或画面展示点
- mood: string，中文情绪/风格描述
- structure: string，中文叙事结构，例如“痛点 → 展示 → 证明 → CTA”
- baseRequirements: string，作为第一段“基础要求”输出，必须包含情绪氛围、光影、全片主要场景、质感、基础创作要求；基础创作要求需明确强反转、真人口播、卡点、特效拉满、产品质感等可执行方向
- firstTenSeconds: object，详细分析视频前 10 秒，包含以下中文字段：
  - atmosphere: 氛围
  - audioVisual: 音画配合
  - camera: 运镜
  - visuals: 画面
  - voiceMusic: 配音配乐
- coarseStructure: array，覆盖原视频完整时长，按内容结构变化拆解；每项包含 time、label、description
- scriptSummary15s: object（字段名仅为历史兼容），原视频全片脚本详析摘要，包含 visualStyle（指定画风）、coreEmotion（核心情绪）、competitors（竞品/品牌/视觉参照物数组；如无明确识别则空数组）
- scriptDetails15s: array（字段名仅为历史兼容），逐时间戳详析原视频完整时长，从 0 秒连续覆盖到视频结束，不得在 15 秒处截断；每项必须包含：
  - time: string，统一使用 "start-end s"，数字最多保留两位小数，例如 "0-0.2s" 或 "5.2-7.25s"
  - environment: string，环境/场景，例如“白色浴室台面”“居家卧室”“户外街景”
  - shot: string，景别，例如“特写”“中景”“近景”
  - camera: string，运镜，例如“固定镜头”“微推近”“手持晃动”“旋转运镜”
  - visual: string，具体画面人物/产品/动作/场景
  - observedPresenterRole: sales_presenter（已确认贯穿视频的固定销售主讲者对镜说话，须绑定稳定人物 ID；单独的动作演员、路人、D to C 插镜人物不属于此类）、presenter_action（同一主讲者动作展示但未确认说话）、background（工人/路人/会议背景人物）、none（无人）、unknown（证据不足）。必须依赖可见口型、面向镜头及讲话证据；画外音不算真人口播；工厂背景或手持产品不能排除前景销售。与 personContinuityId 联合记录，身份或角色不确定时 needsReview=true。
  - personContinuityId: string，同一个可确认出镜人物跨镜头使用同一个稳定 ID（如 person_1）；无人出镜或无法确认是否同一人时留空，不得仅凭性别推断
  - subtitle: string，只填写画面中清晰可见的字幕或可确认的口播原句；看不清/听不清则填空字符串，禁止写“待补全”或猜测台词
  - voiceover: string，只填写实际听到且确认是画外旁白的原文；未知留空，不复制画内 dialogue，不用“无”代替缺证据
  - audio: string，只填写可确认的配音、BGM、音效；无法确认则填空字符串，禁止写“可能有……”或猜测台词
  - note: string，可选，只记录确定可见的信息；禁止编造品牌、@账号、原台词或无法确认的提示
每一个分镜的内容要能被前端按“时间戳 + 段落”展示；段落信息必须覆盖环境、景别、运镜、配乐、台词、画面，字段之间语义上可用分号连接。
- recommendedScriptType: "voiceover" | "storyboard"`;

  const raw = await withRetry(() =>
    generateText({
      contents: [
        {
          parts: [
            { text: '请分析这个 YouTube 视频，并返回中文 JSON。' },
            { fileData: { fileUri: opts.url } },
          ],
        },
      ] as Content[],
      systemInstruction,
      jsonMode: true,
    }),
  );

  const parsed = parseJson<Partial<VideoAiAnalysis>>(raw, {});
  return normalizeVideoAnalysis(parsed);
}

/** Generate a voiceover script from video analysis */
export async function generateVoiceoverScript(opts: {
  analysis: VideoAiAnalysis;
  language: Language;
  productInfo?: string;
}): Promise<VoiceoverContent> {
  const { analysis, language, productInfo } = opts;

  const systemInstruction = `You are a top-tier overseas marketing copywriter specializing in short-video voiceover scripts for e-commerce.
Output ONLY valid JSON — no markdown, no preamble.

JSON structure:
{
  "hook": "Opening line (≤15 words, grabs attention immediately)",
  "body": ["paragraph 1", "paragraph 2", "paragraph 3"],
  "cta": "Call-to-action line (≤10 words)",
  "duration": "estimated total duration in seconds (15–60)",
  "hashtags": ["#tag1", "#tag2", "#tag3", "#tag4", "#tag5"]
}

Write everything in ${language === 'zh' ? 'Chinese (Simplified)' : `language code: ${language}`}.
The script must be natural for voiceover delivery — conversational, energetic, persuasive.
Reuse only the reference video's hook type, reveal order, information density, proof placement, emotional progression, and CTA position. Never copy competitor identity, exact dialogue, distinctive expression, or unsupported claims.
Prioritize verified product information over reference-video claims. If product evidence is missing, omit the claim instead of guessing.
Make the duration physically speakable. For Chinese estimate 4–5 characters per second plus natural pauses; for other languages use a natural advertising delivery rate. Shorten the copy when it does not fit the declared duration.
Keep the hook, body, CTA, and hashtags semantically distinct; do not put filming instructions inside voiceover text.`;

  const userPrompt = `Video analysis:
- Theme: ${analysis.theme}
- Hooks used: ${analysis.hooks.join(', ')}
- Selling points: ${analysis.sellingPoints.join(', ')}
- Mood: ${analysis.mood}
- Structure: ${analysis.structure}
- Reference coarse structure: ${JSON.stringify(analysis.coarseStructure ?? [])}
- Reference detailed shot purposes and dialogue rhythm: ${JSON.stringify((analysis.scriptDetails15s ?? []).map(item => ({ time: item.time, purpose: item.purpose, dialogue: item.dialogue, onScreenText: item.onScreenText })))}
${productInfo ? `\nProduct information (prioritize this):\n${productInfo}` : ''}

Generate a voiceover script that captures this video's energy while promoting the product effectively.`;

  const raw = await withRetry(() =>
    generateText({ contents: userPrompt, systemInstruction, jsonMode: true }),
  );

  const parsed = parseJson<Partial<VoiceoverContent>>(raw, {});
  return {
    hook: String(parsed.hook ?? ''),
    body: Array.isArray(parsed.body) ? parsed.body.map(String) : [],
    cta: String(parsed.cta ?? ''),
    duration: String(parsed.duration ?? '30'),
    hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags.map(String) : [],
  };
}

/** Generate a storyboard script from video analysis */
export async function generateStoryboardScript(opts: {
  analysis: VideoAiAnalysis;
  language: Language;
  productInfo?: string;
}): Promise<StoryboardContent> {
  const { analysis, language, productInfo } = opts;

  const systemInstruction = `You are a professional short-video storyboard director for overseas e-commerce ads.
Output ONLY valid JSON — no markdown, no preamble.
${GEMINI_STORYBOARD_DIRECTOR_CONTRACT}

JSON structure:
{
  "globalSettings": {
    "visualStyle": "string", "aspectRatio": "9:16", "lighting": "string",
    "subtitlePolicy": "string", "audioPolicy": "string",
    "identityConsistency": "string", "productConsistency": "string",
    "negativeConstraints": ["string"]
  },
  "spatialContinuity": {
    "scene": "string",
    "subjectAnchors": [{"subject":"string","position":"string","facing":"string","gazeTarget":"string","orientation":"string"}],
    "background": "string", "backgroundPriority": "low | medium | high", "depthOfField": "shallow | moderate | deep"
  },
  "scenes": [
    {
      "index": 1,
      "startTime": 0,
      "endTime": 3,
      "duration": 3,
      "shot": "close-up | medium | wide | extreme close-up",
      "camera": "static | push-in | pull-out | pan | tilt | handheld | tracking",
      "angle": "eye-level | overhead | low-angle | profile | over-shoulder | POV",
      "composition": "subject and product placement",
      "purpose": "hook | demonstration | proof | objection handling | CTA",
      "action": "Executable visible action with initial state, contact/path, gaze, pose, and end state",
      "startState": "string", "endState": "string", "transitionToNext": "string",
      "lighting": "string", "backgroundPriority": "low | medium | high", "depthOfField": "shallow | moderate | deep",
      "voiceover": "Voiceover text for this scene",
      "estimatedSpeechDuration": 2.2,
      "dialogueFits": true,
      "caption": "On-screen text caption",
      "ambientSound": "string", "bgm": "string", "soundEffects": ["string"],
      "generationPrompt": "English generation prompt",
      "negativePrompt": "English negative prompt"
    }
  ],
  "totalDuration": 15,
  "continuitySummary": "string",
  "emotionArc": ["string"]
}

Write voiceover and captions in ${language === 'zh' ? 'Chinese (Simplified)' : `language code: ${language}`}.
Target: 6–10 scenes, total 15–45 seconds.`;

  const userPrompt = `Video analysis:
- Theme: ${analysis.theme}
- Hooks: ${analysis.hooks.join(', ')}
- Selling points: ${analysis.sellingPoints.join(', ')}
- Mood: ${analysis.mood}
- Structure: ${analysis.structure}
- Global settings: ${JSON.stringify(analysis.globalSettings ?? {})}
- Spatial continuity: ${JSON.stringify(analysis.spatialContinuity ?? {})}
- Reference coarse structure: ${JSON.stringify(analysis.coarseStructure ?? [])}
- Reference detailed shots: ${JSON.stringify(analysis.scriptDetails15s ?? [])}
${productInfo ? `\nProduct information (prioritize this):\n${productInfo}` : ''}

Create a storyboard that replicates the video's winning structure while promoting the product.`;

  const raw = await withRetry(() =>
    generateText({ contents: userPrompt, systemInstruction, jsonMode: true }),
  );

  const parsed = parseJson<Partial<StoryboardContent>>(raw, {});
  let cursor = 0;
  const scenes = Array.isArray(parsed.scenes)
    ? parsed.scenes.map((s, i) => {
        const scene = s as unknown as Record<string, unknown>;
        const requestedDuration = Math.max(0.5, Number(scene.duration ?? 3) || 3);
        const startTime = i === 0 ? 0 : cursor;
        const modelEnd = Number(scene.endTime);
        const endTime = Number.isFinite(modelEnd) && modelEnd > startTime ? modelEnd : startTime + requestedDuration;
        const duration = Math.max(0.5, endTime - startTime);
        cursor = endTime;
        const voiceover = String(scene.voiceover ?? '');
        const estimatedSpeechDuration = Math.max(0, Number(scene.estimatedSpeechDuration ?? ([...voiceover.replace(/\s/g, '')].length / 4.5 + (voiceover ? 0.75 : 0))) || 0);
        return {
          index: Number(scene.index ?? i + 1),
          startTime,
          endTime,
          duration,
          shot: String(scene.shot ?? 'medium'),
          camera: String(scene.camera ?? 'static'),
          angle: String(scene.angle ?? 'eye-level'),
          composition: String(scene.composition ?? ''),
          purpose: String(scene.purpose ?? ''),
          action: String(scene.action ?? ''),
          startState: String(scene.startState ?? ''),
          endState: String(scene.endState ?? ''),
          transitionToNext: String(scene.transitionToNext ?? ''),
          lighting: String(scene.lighting ?? ''),
          backgroundPriority: ['low', 'medium', 'high'].includes(String(scene.backgroundPriority)) ? String(scene.backgroundPriority) as 'low' | 'medium' | 'high' : 'medium',
          depthOfField: ['shallow', 'moderate', 'deep'].includes(String(scene.depthOfField)) ? String(scene.depthOfField) as 'shallow' | 'moderate' | 'deep' : 'moderate',
          voiceover,
          estimatedSpeechDuration,
          dialogueFits: estimatedSpeechDuration <= duration,
          caption: String(scene.caption ?? ''),
          ambientSound: String(scene.ambientSound ?? ''),
          bgm: String(scene.bgm ?? ''),
          soundEffects: Array.isArray(scene.soundEffects) ? scene.soundEffects.map(String).filter(Boolean) : [],
          generationPrompt: String(scene.generationPrompt ?? ''),
          negativePrompt: String(scene.negativePrompt ?? ''),
        };
      })
    : [];
  return {
    scenes,
    globalSettings: parseGlobalSettings(parsed.globalSettings),
    spatialContinuity: parseSpatialContinuity(parsed.spatialContinuity),
    totalDuration: scenes.length ? scenes[scenes.length - 1]!.endTime : 0,
    continuitySummary: String(parsed.continuitySummary ?? '').trim(),
    emotionArc: Array.isArray(parsed.emotionArc) ? parsed.emotionArc.map(String).filter(Boolean) : [],
  };
}

/** Generate a new script from an existing script's structure + new product info */
export async function generateFromProduct(opts: {
  sourceScript: { type: ScriptType; content: VoiceoverContent | StoryboardContent };
  productInfo: string;
  language: Language;
}): Promise<VoiceoverContent | StoryboardContent> {
  const { sourceScript, productInfo, language } = opts;

  const systemInstruction = `You are an overseas marketing script writer. You will receive a reference script and new product information.
Extract the structural framework and emotional pattern from the reference script, then rewrite it entirely for the new product.
Output ONLY valid JSON in the same schema as the input script — no markdown, no preamble.
Write in ${language === 'zh' ? 'Chinese (Simplified)' : `language code: ${language}`}.`;

  const userPrompt = `Reference script (${sourceScript.type}):
${JSON.stringify(sourceScript.content, null, 2)}

New product information:
${productInfo}

Rewrite the script entirely for this new product, keeping the same structural framework.`;

  const raw = await withRetry(() =>
    generateText({ contents: userPrompt, systemInstruction, jsonMode: true }),
  );

  return parseJson<VoiceoverContent | StoryboardContent>(raw, sourceScript.content);
}

/** Translate an existing script to a target language */
export async function translateScript(opts: {
  script: VoiceoverContent | StoryboardContent;
  targetLanguage: Language;
}): Promise<VoiceoverContent | StoryboardContent> {
  const { script, targetLanguage } = opts;

  const systemInstruction = `You are a professional marketing translator specializing in e-commerce content.
Translate all text fields in the provided JSON to ${targetLanguage}.
Preserve the JSON structure exactly. Output ONLY valid JSON — no markdown, no preamble.
Localize idioms and CTAs for the target culture, not just literal translation.`;

  const userPrompt = `Translate this script to ${targetLanguage}:\n${JSON.stringify(script, null, 2)}`;

  const raw = await withRetry(() =>
    generateText({ contents: userPrompt, systemInstruction, jsonMode: true }),
  );

  return parseJson<VoiceoverContent | StoryboardContent>(raw, script);
}

/** Generate an image prompt for a storyboard scene (Pro mode) */
export async function generateImagePrompt(opts: {
  scene: { action: string; shot: string; mood?: string };
  productInfo: string;
}): Promise<string> {
  const systemInstruction = `You are a visual art director for e-commerce ads.
Generate a detailed image generation prompt for the described scene.
Output ONLY the prompt text — no JSON, no explanation.`;

  const userPrompt = `Scene: ${opts.scene.shot} shot. ${opts.scene.action}
Product: ${opts.productInfo}
${opts.scene.mood ? `Mood: ${opts.scene.mood}` : ''}
Write a Stable Diffusion / Imagen prompt (≤100 words) that would produce a compelling ad image for this scene.`;

  return withRetry(() => generateText({ contents: userPrompt, systemInstruction }));
}

export async function proofreadReferenceNarrationWithGemini(transcript: string): Promise<string> {
  return generateText({ contents: transcript, jsonMode: true, systemInstruction: REFERENCE_NARRATION_PROOFREAD_PROMPT });
}
import { REFERENCE_NARRATION_PROOFREAD_PROMPT } from '../prompts/referenceNarrationProofread.js';
