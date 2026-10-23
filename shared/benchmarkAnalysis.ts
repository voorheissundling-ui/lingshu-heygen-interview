import { recognizePresenterShot, type ObservedPresenterRole } from './contracts/presenterShotRecognition.js';
/** Evidence contract shared by Inspiration and the future business schedule consumer. */
export const MATERIAL_TYPE_LABELS = {
  talking_head: '真人口播', factory: '工厂实拍', product: '产品实拍',
  consumer_demo: 'D2C', general: '其他通用素材', unknown: '待判断',
} as const;
export const SHOT_ROLE_LABELS = {
  hook: '钩子', pain_point: '痛点', capability_proof: '能力证明', product_intro: '产品介绍',
  effect_proof: '效果证明', cta: '行动引导', transition: '过渡', unknown: '待判断',
} as const;
export type BenchmarkMaterialType = keyof typeof MATERIAL_TYPE_LABELS;
export type BenchmarkShotRole = keyof typeof SHOT_ROLE_LABELS;
export interface BenchmarkShot {
  shotId: string; index: number; time: string; start: number | null; end: number | null;
  materialType: BenchmarkMaterialType; narrativeRole: BenchmarkShotRole;
  classificationSource: 'model' | 'legacy_evidence' | 'missing'; classificationEvidence: string; visual: string; dialogue: string; onScreenText: string;
  purpose: string; firstFrameRef: string | null; clipRef: string | null; needsReview: boolean;
  granularity: 'shot' | 'observation_window';
  environment: string; framing: string; camera: string; audio: string; authenticity: string;
  effectivenessHypothesis: string; detailedAnalysis: Record<string, string>;
}
export interface BenchmarkSpeechGroup {
  groupId: string; start: number; end: number; text: string;
  timingPrecision: 'phrase' | 'coarse'; needsReview: boolean; shotIds: string[];
}
export interface BenchmarkAnalysis {
  schemaVersion: 1;
  source: { videoId: string; analysisRunId: string | null; evidenceRevision: string | null;
    correctionVersion: number; analyzedAt: string | null; analysisMode: string };
  status: 'pending' | 'failed' | 'needs_review' | 'partial' | 'ready';
  gaps: string[]; hookShotId: string | null;
  shots: BenchmarkShot[]; totalShots: number | null; timelineComplete: boolean;
  materialCounts: Record<BenchmarkMaterialType, number>;
  structure: Array<{ materialType: BenchmarkMaterialType; narrativeRole: BenchmarkShotRole; shotIds: string[] }>;
  speechGroups: BenchmarkSpeechGroup[];
}
export const recordOf = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const missingObservation = (value: string): boolean => {
  const normalized = value.toLocaleLowerCase().replace(/[\s，,。.!！?？:：;；()[\]【】{}'"“”‘’_\-/]+/g, '');
  return /^(?:画面内容|画面|视觉|场景|环境|观察事实|内容|描述)?(?:尚未分析|未分析|未确认|未识别|无法分析|无法确认|无法判断|无法识别|未知|不清楚|不确定|待分析|待确认|待判断|暂无|暂无信息|无有效信息|无可用信息|无|unknown|na|none)$/.test(normalized);
};
const legacyObservations = (row: Record<string, unknown>): string[] =>
  [row.visual, row.observedFacts, row.environment]
    .flatMap(value => Array.isArray(value) ? value.map(text) : [text(value)])
    .filter(value => value && !missingObservation(value));
export function benchmarkMaterialType(value: unknown): BenchmarkMaterialType {
  return typeof value === 'string' && Object.hasOwn(MATERIAL_TYPE_LABELS, value) ? value as BenchmarkMaterialType : 'unknown';
}
export function benchmarkShotRole(value: unknown): BenchmarkShotRole {
  return typeof value === 'string' && Object.hasOwn(SHOT_ROLE_LABELS, value) ? value as BenchmarkShotRole : 'unknown';
}
/** No guessed boundaries and no mm:ss-to-seconds ambiguity. */
export function benchmarkTimeRange(value: unknown): { start: number; end: number } | null {
  const match = text(value).match(/^(\d+(?:\.\d+)?)\s*(?:s|秒)?\s*[-–—~至]\s*(\d+(?:\.\d+)?)\s*(?:s|秒)?$/i);
  if (!match) return null;
  const start = Number(match[1]); const end = Number(match[2]);
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : null;
}
/** Conservative compatibility mapping: use visible actions, never factory background alone. */
function legacyMaterial(row: Record<string, unknown>): BenchmarkMaterialType {
  const visual = text(row.visual);
  const observations = legacyObservations(row);
  const facts = observations.join('；');
  const role = text(row.observedPresenterRole) as ObservedPresenterRole;
  const presenter = row.salesPresenterConfirmed === true || role === 'sales_presenter'
    || recognizePresenterShot({ observedPresenterRole: role || undefined,
      detail: `画面：${visual} 镜头功能：${text(row.purpose)} 口播：${text(row.dialogue) || '无'}` }) === 'presenter';
  if (presenter) return 'talking_head';
  if (/(消费者|顾客|用户|模特).{0,30}(使用|涂抹|涂在|试用|上脸)|使用前后|效果对比|before.?and.?after|consumer demo/i.test(facts)) return 'consumer_demo';
  if (!['none', 'background'].includes(role) && row.salesPresenterConfirmed !== false
    && /(主播|主持人|讲解员|销售人员|人物).{0,40}(麦克风|口播|面向镜头|对镜头|讲解)|真人口播/.test(visual)) return 'talking_head';
  if (/(生产线|流水线|灌装|包装工序|机器运转|钻床|车床|冲压|焊接|工[人厂]|女工|男工).{0,35}(操作|生产|组装|分拣|加工|装配|设备|零件)|生产线|流水线|灌装|钻床|工厂车间|factory|assembly line/i.test(facts)) return 'factory';
  // Product/showroom demonstrations are product material unless visible presenter evidence says otherwise.
  if (/产品|商品|瓶身|包装盒|灯具|吊灯|灯饰|灯罩|护肤品|展厅|陈列|product|showroom/i.test(facts)) return 'product';
  // A concrete visible scene that does not belong to the four specialized
  // production types is reusable general footage. Keep `unknown` reserved for
  // records that do not contain enough visual evidence to classify at all.
  return observations.length ? 'general' : 'unknown';
}
function legacyRole(row: Record<string, unknown>): BenchmarkShotRole {
  const purpose = text(row.purpose);
  if (/引导.{0,12}(联系|咨询|下单|购买|行动)|行动号召|联系方式/.test(purpose)) return 'cta';
  if (/效果.{0,8}(证明|展示)|前后对比/.test(purpose)) return 'effect_proof';
  if (/(生产|工厂|制造).{0,12}(能力|实力|证明)|能力证明/.test(purpose)) return 'capability_proof';
  if (/介绍产品|产品介绍|展示产品|产品展示/.test(purpose)) return 'product_intro';
  if (/痛点/.test(purpose)) return 'pain_point';
  if (/过渡|衔接/.test(purpose)) return 'transition';
  return 'unknown';
}
/** Media stays on the existing tenant-scoped API; never publish local paths or object keys. */
export function benchmarkMediaRef(value: unknown, videoId: string, index: number, kind: 'first-frame' | 'clip'): string | null {
  const expected = `/api/overseas/videos/${encodeURIComponent(videoId)}/shot/${index}/${kind}`;
  return videoId && text(value) === expected ? expected : null;
}
export function buildBenchmarkAnalysis(input: {
  analysis: unknown; videoId?: string; duration?: number; evidenceRevision?: string | null;
}): BenchmarkAnalysis {
  const payload = recordOf(input.analysis); const gemini = recordOf(payload.gemini);
  const videoId = input.videoId || ''; const correction = recordOf(payload.correction);
  const gaps: string[] = [];
  const details = Array.isArray(gemini.scriptDetails15s) ? gemini.scriptDetails15s : [];
  const shots: BenchmarkShot[] = details.map((raw, index) => {
    const row = recordOf(raw); const range = benchmarkTimeRange(row.time || row.timestamp);
    const media = recordOf(row.materialEvidence);
    const rawMaterialType = text(row.materialType);
    const explicitType = benchmarkMaterialType(rawMaterialType);
    const materialType = rawMaterialType === 'unknown' ? 'unknown'
      : explicitType === 'unknown' ? legacyMaterial(row) : explicitType;
    const explicitRole = benchmarkShotRole(row.narrativeRole);
    const narrativeRole = index === 0 ? 'hook' : explicitRole === 'unknown' ? legacyRole(row) : explicitRole;
    const derived = (explicitType === 'unknown' && materialType !== 'unknown') || (index > 0 && explicitRole === 'unknown' && narrativeRole !== 'unknown');
    const classificationEvidence = text(row.classificationEvidence) || (derived ? `依据已有描述整理：${legacyObservations(row).slice(0, 3).join('；')}${text(row.purpose) ? `；原镜头作用：${text(row.purpose)}` : ''}` : '');
    return { shotId: `shot_${index + 1}`, index: index + 1, time: text(row.time || row.timestamp),
      start: range?.start ?? null, end: range?.end ?? null,
      materialType, narrativeRole,
      classificationSource: derived ? 'legacy_evidence' : classificationEvidence ? 'model' : 'missing', classificationEvidence, visual: text(row.visual),
      dialogue: text(row.dialogue), onScreenText: text(row.onScreenText || row.subtitle), purpose: text(row.purpose),
      firstFrameRef: benchmarkMediaRef(media.firstFrameRef, videoId, index + 1, 'first-frame'),
      clipRef: benchmarkMediaRef(media.clipRef, videoId, index + 1, 'clip'),
      granularity: row.analysisGranularity === 'observation_window' ? 'observation_window' as const : 'shot' as const,
      environment: text(row.environment), framing: text(row.shot), camera: text(row.camera),
      audio: text(row.audio), authenticity: text(row.authenticity),
      effectivenessHypothesis: text(recordOf(row.viralPotential).whyEffective),
      detailedAnalysis: Object.fromEntries(['angle', 'composition', 'ambientSound', 'bgm', 'soundEffects',
        'observedFacts', 'inferredIntent', 'causalGap', 'startState', 'endState', 'transitionToNext'].flatMap(key => {
          const value = row[key]; const content = Array.isArray(value) ? value.filter(item => typeof item === 'string').join('；') : text(value);
          return content ? [[key, content]] : [];
        })),
      needsReview: row.needsReview === true || !range || !text(row.visual)
        || derived || materialType === 'unknown' || narrativeRole === 'unknown' || !classificationEvidence,
    };
  });
  const ranges = shots.filter(shot => shot.start !== null && shot.end !== null);
  const duration = Number(input.duration);
  const timelineComplete = shots.length > 0 && ranges.length === shots.length
    && ranges[0]!.start! <= 0.35
    && ranges.every((shot, index) => !index || Math.abs(shot.start! - ranges[index - 1]!.end!) <= 0.35)
    && Number.isFinite(duration) && duration > 0 && Math.abs(ranges.at(-1)!.end! - duration) <= 0.75;
  if (!shots.length) gaps.push('尚无逐镜分析');
  else if (!timelineComplete) gaps.push('全片时间线尚未确认完整');
  if (shots.some(shot => shot.materialType === 'unknown' || shot.narrativeRole === 'unknown' || !shot.classificationEvidence)) gaps.push('镜头素材类型、作用或分类依据待补齐');
  if (shots.some(shot => shot.needsReview)) gaps.push('存在待复核镜头');
  if (shots.some(shot => shot.granularity === 'observation_window')) gaps.push('当前为观察窗口，真实切镜数尚未确认');
  if (payload.analysisMode !== 'exact') gaps.push('尚未完成全片精确分析');
  const hookShotId = shots[0]?.shotId || null;
  const materialCounts = Object.fromEntries(Object.keys(MATERIAL_TYPE_LABELS).map(key => [key, 0])) as Record<BenchmarkMaterialType, number>;
  const structure: BenchmarkAnalysis['structure'] = [];
  for (const shot of shots) {
    materialCounts[shot.materialType] += 1;
    const last = structure.at(-1);
    if (last?.materialType === shot.materialType) last.shotIds.push(shot.shotId);
    else structure.push({ materialType: shot.materialType, narrativeRole: shot.narrativeRole, shotIds: [shot.shotId] });
  }
  const transcript = recordOf(gemini.audioTranscript);
  const speechGroups: BenchmarkSpeechGroup[] = (Array.isArray(transcript.segments) ? transcript.segments : []).flatMap((raw, index) => {
    const row = recordOf(raw); const start = row.start; const end = row.end;
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end)
      || start < 0 || end <= start || !text(row.text)) return [];
    const shotIds = shots.filter(shot => shot.start !== null && shot.end !== null && shot.start < end && shot.end > start).map(shot => shot.shotId);
    return [{ groupId: `speech_${index + 1}`, start, end, text: text(row.text),
      timingPrecision: row.timingPrecision === 'phrase' ? 'phrase' as const : 'coarse' as const,
      needsReview: row.needsReview === true || row.timingPrecision !== 'phrase', shotIds }];
  });
  const review = payload.geminiStatus === 'needs_review' || payload.analysisQuality === 'video_review_required'
    || (Array.isArray(payload.analysisReviewReasons) && payload.analysisReviewReasons.length > 0);
  if (review) gaps.push('源分析仍待复核');
  const progress = recordOf(payload.analysisProgress);
  const progressStage = text(progress.stage);
  const hasProgress = Boolean(progressStage);
  const failed = progressStage === 'failed' || Boolean(payload.analysisError) || ['failed', 'video_failed', 'analysis_retryable'].includes(text(payload.geminiStatus));
  const pending = !failed && (hasProgress
    ? ['queued', 'downloading', 'transcoding', 'analyzing', 'extracting_evidence'].includes(progressStage)
    : Boolean(payload.requestedAnalysisMode) || ['queued', 'running', 'analyzing', 'paused', 'waiting_for_video'].includes(text(payload.geminiStatus)));
  if (pending) gaps.push('分析尚未完成或已暂停');
  if (failed) gaps.push('源分析失败，需要重试');
  if (payload.analysisQuality !== 'video' || payload.geminiStatus !== 'analyzed') gaps.push('缺少已完成的原片分析状态');
  if (!videoId || !input.evidenceRevision) gaps.push('服务端分析来源或修订信息待补齐');
  return { schemaVersion: 1, source: { videoId, analysisRunId: text(payload.analysisRunId) || null,
    evidenceRevision: input.evidenceRevision || null, correctionVersion: Number(correction.version) || 0,
    analyzedAt: text(correction.correctedAt || payload.analyzedAt) || null, analysisMode: text(payload.analysisMode) },
    status: failed ? 'failed' : pending || !shots.length ? 'pending' : review ? 'needs_review' : gaps.length ? 'partial' : 'ready',
    gaps: [...new Set(gaps)], hookShotId, shots,
    totalShots: payload.analysisMode === 'exact' && shots.length > 0 && shots.every(shot => shot.granularity === 'shot') ? shots.length : null,
    timelineComplete, materialCounts, structure, speechGroups };
}

/**
 * Keeps an already-normalized benchmark snapshot safe when it crosses the
 * weekly-plan API boundary. Business, Director and Content agents all read
 * this same frozen snapshot instead of rebuilding different interpretations.
 */
export function normalizeBenchmarkAnalysisSnapshot(value: unknown): BenchmarkAnalysis | undefined {
  const payload = recordOf(value);
  if (Number(payload.schemaVersion) !== 1) return undefined;
  const source = recordOf(payload.source);
  const shots = (Array.isArray(payload.shots) ? payload.shots : []).slice(0, 60).flatMap((raw, offset) => {
    const row = recordOf(raw);
    const shotId = text(row.shotId).slice(0, 120) || `shot_${offset + 1}`;
    const index = Math.max(1, Math.min(60, Math.floor(Number(row.index) || offset + 1)));
    const start = typeof row.start === 'number' && Number.isFinite(row.start) ? Math.max(0, row.start) : null;
    const end = typeof row.end === 'number' && Number.isFinite(row.end) && (start === null || row.end > start) ? row.end : null;
    const detailed = recordOf(row.detailedAnalysis);
    return [{
      shotId, index, time: text(row.time).slice(0, 80), start, end,
      materialType: benchmarkMaterialType(row.materialType), narrativeRole: benchmarkShotRole(row.narrativeRole),
      classificationSource: ['model', 'legacy_evidence', 'missing'].includes(text(row.classificationSource))
        ? text(row.classificationSource) as BenchmarkShot['classificationSource'] : 'missing',
      classificationEvidence: text(row.classificationEvidence).slice(0, 1_000),
      visual: text(row.visual).slice(0, 2_000), dialogue: text(row.dialogue).slice(0, 2_000),
      onScreenText: text(row.onScreenText).slice(0, 1_000), purpose: text(row.purpose).slice(0, 1_000),
      firstFrameRef: text(row.firstFrameRef).startsWith('/api/') ? text(row.firstFrameRef).slice(0, 2_000) : null,
      clipRef: text(row.clipRef).startsWith('/api/') ? text(row.clipRef).slice(0, 2_000) : null,
      needsReview: row.needsReview === true,
      granularity: row.granularity === 'observation_window' ? 'observation_window' as const : 'shot' as const,
      environment: text(row.environment).slice(0, 1_000), framing: text(row.framing).slice(0, 500),
      camera: text(row.camera).slice(0, 500), audio: text(row.audio).slice(0, 1_000),
      authenticity: text(row.authenticity).slice(0, 1_000), effectivenessHypothesis: text(row.effectivenessHypothesis).slice(0, 1_000),
      detailedAnalysis: Object.fromEntries(Object.entries(detailed).slice(0, 30).flatMap(([key, item]) => {
        const content = text(item).slice(0, 2_000);
        return content ? [[key.slice(0, 80), content]] : [];
      })),
    } satisfies BenchmarkShot];
  });
  const shotIds = new Set(shots.map(shot => shot.shotId));
  const structure = (Array.isArray(payload.structure) ? payload.structure : []).slice(0, 60).flatMap(raw => {
    const row = recordOf(raw);
    const ids = (Array.isArray(row.shotIds) ? row.shotIds : []).map(item => text(item).slice(0, 120)).filter(id => shotIds.has(id));
    return ids.length ? [{ materialType: benchmarkMaterialType(row.materialType), narrativeRole: benchmarkShotRole(row.narrativeRole), shotIds: ids }] : [];
  });
  const counts = recordOf(payload.materialCounts);
  const materialCounts = Object.fromEntries(Object.keys(MATERIAL_TYPE_LABELS).map(key => [key, Math.max(0, Math.floor(Number(counts[key]) || 0))])) as Record<BenchmarkMaterialType, number>;
  const statuses: BenchmarkAnalysis['status'][] = ['pending', 'failed', 'needs_review', 'partial', 'ready'];
  return {
    schemaVersion: 1,
    source: {
      videoId: text(source.videoId).slice(0, 160),
      analysisRunId: text(source.analysisRunId).slice(0, 160) || null,
      evidenceRevision: text(source.evidenceRevision).slice(0, 160) || null,
      correctionVersion: Math.max(0, Math.floor(Number(source.correctionVersion) || 0)),
      analyzedAt: text(source.analyzedAt).slice(0, 80) || null,
      analysisMode: text(source.analysisMode).slice(0, 80),
    },
    status: statuses.includes(payload.status as BenchmarkAnalysis['status']) ? payload.status as BenchmarkAnalysis['status'] : 'partial',
    gaps: (Array.isArray(payload.gaps) ? payload.gaps : []).map(item => text(item).slice(0, 500)).filter(Boolean).slice(0, 20),
    hookShotId: shotIds.has(text(payload.hookShotId)) ? text(payload.hookShotId) : null,
    shots,
    totalShots: typeof payload.totalShots === 'number' && Number.isFinite(payload.totalShots) ? Math.max(0, Math.floor(payload.totalShots)) : null,
    timelineComplete: payload.timelineComplete === true,
    materialCounts,
    structure,
    speechGroups: [],
  };
}
