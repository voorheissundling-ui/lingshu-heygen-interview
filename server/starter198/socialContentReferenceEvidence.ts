import type {
  SocialContentThemeId,
  SocialReferenceShotAnalysis,
  SocialReferenceVideoAnalysis,
  SocialReplicationScriptVersion,
  SocialShotMaterialMapEntry,
  SocialTaskSource,
} from '../../shared/contracts/socialContentWorkflow.js';
import type { SocialInspirationScriptMatch, VerifiedSocialScriptContext } from './socialContentScriptBaseline.js';
import {
  socialJson,
  socialObject,
  socialRequestHash,
  socialText,
} from './socialContentValidation.js';
import { reviewShotMaterialRefs } from '../lib/referenceShotReview.js';
import { validateVerifiedSpeechLines } from '../lib/verifiedReferenceSpeech.js';
import { approximateSpeechLines } from '../lib/referenceApproxSpeech.js';
import { parseAnalysisTimeRange } from '../lib/videoAnalysisCodec.js';

export const THEME_TERMS: Record<SocialContentThemeId, readonly string[]> = {
  product_value: ['产品', '卖点', '细节', '成分', '材质', '性能', 'product', 'feature', 'detail'],
  scenario_solution: ['场景', '使用', '问题', '解决', '效果', 'use', 'problem', 'solution', 'result'],
  supplier_capability: ['工厂', '车间', '产线', '生产', '质检', '仓储', '供应', 'factory', 'production', 'quality'],
  customization_process: ['定制', '打样', '包装', '合作', '流程', 'oem', 'odm', 'sample', 'custom'],
  customer_case: ['客户', '案例', '合作', '成果', '授权', 'case', 'customer', 'result'],
};

export function recordObject(value: unknown): Record<string, unknown> {
  return socialObject(socialJson(value)) ?? {};
}

export function listText(value: unknown): string[] {
  return Array.isArray(value) ? value.map(socialText).filter(Boolean) : [];
}

export type ExactReferenceDetail = {
  detail: Record<string, unknown>;
  timing: { startSeconds: number; endSeconds: number; durationSeconds: number };
};

export const REFERENCE_BOUNDARY_NORMALIZATION_SECONDS = 0.2;

/**
 * The frame sampler can emit a sub-200ms transition row which is too short to
 * become its own production slot.  Removing that row must not leave a hole in
 * the production timeline.  Prefer the analyzer's physical scene cut; only
 * use the deterministic midpoint when the unfiltered L3 ranges prove that the
 * entire interval was analyzed.  Slot identity and count are never changed.
 */
export function normalizeReferenceTimelineBoundaries(
  details: ExactReferenceDetail[],
  exactRanges: Array<{ startSeconds: number; endSeconds: number }>,
  detectedSceneCuts: number[],
): ExactReferenceDetail[] {
  const rows = details.map(row => ({ ...row, timing: { ...row.timing } }));
  const ranges = exactRanges
    .filter(range => Number.isFinite(range.startSeconds) && Number.isFinite(range.endSeconds) && range.endSeconds > range.startSeconds)
    .sort((left, right) => left.startSeconds - right.startSeconds || left.endSeconds - right.endSeconds);
  const cuts = detectedSceneCuts.filter(Number.isFinite).sort((left, right) => left - right);
  const fullyCovered = (start: number, end: number) => {
    if (end <= start) return true;
    let cursor = start;
    for (const range of ranges) {
      if (range.endSeconds <= cursor || range.startSeconds >= end) continue;
      if (range.startSeconds - cursor > 0.03) return false;
      cursor = Math.max(cursor, range.endSeconds);
      if (cursor >= end - 0.001) return true;
    }
    return cursor >= end - 0.001;
  };
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1]!;
    const current = rows[index]!;
    const left = Math.min(previous.timing.endSeconds, current.timing.startSeconds);
    const right = Math.max(previous.timing.endSeconds, current.timing.startSeconds);
    if (right - left > REFERENCE_BOUNDARY_NORMALIZATION_SECONDS + 0.001) continue;
    const hardCuts = cuts.filter(cut => cut >= left - 0.001 && cut <= right + 0.001);
    const boundary = hardCuts.length
      ? hardCuts.reduce((best, cut) => Math.abs(cut - (left + right) / 2) < Math.abs(best - (left + right) / 2) ? cut : best)
      : fullyCovered(left, right) ? +((left + right) / 2).toFixed(3) : null;
    if (boundary === null || boundary <= previous.timing.startSeconds || boundary >= current.timing.endSeconds) continue;
    previous.timing.endSeconds = boundary;
    previous.timing.durationSeconds = +(boundary - previous.timing.startSeconds).toFixed(3);
    current.timing.startSeconds = boundary;
    current.timing.durationSeconds = +(current.timing.endSeconds - boundary).toFixed(3);
  }
  return rows;
}

export interface ResolvedSocialTaskReference {
  match: SocialInspirationScriptMatch;
  referenceVideoAnalysis: SocialReferenceVideoAnalysis;
  replicationScript: SocialReplicationScriptVersion;
  shotMaterialMap: SocialShotMaterialMapEntry[];
}

export function pendingSocialTaskReferenceAnalysis(
  source: Pick<SocialTaskSource, 'sourceId' | 'sourceRef' | 'createdAt'>,
): SocialReferenceVideoAnalysis {
  const recommendation = source.sourceId.startsWith('system-reference:');
  return {
    analysisId: `reference-analysis-${socialRequestHash({ sourceId: source.sourceId, sourceRef: normalizedReferenceIdentity(source.sourceRef) }).slice(0, 20)}`,
    version: socialRequestHash({ sourceId: source.sourceId, sourceRef: normalizedReferenceIdentity(source.sourceRef), createdAt: source.createdAt }).slice(0, 12),
    referenceSourceId: source.sourceId,
    status: 'analyzing',
    durationSeconds: null,
    analysisLayers: [
      { level: 'L0', status: 'partial', scope: '已记录参考来源，等待读取平台元数据与完整时长', confidence: null },
      { level: 'L1', status: 'pending', scope: '等待 ASR、OCR、抽帧和镜头切分', confidence: null },
      { level: 'L2', status: 'pending', scope: '等待全片结构与节奏分析', confidence: null },
      { level: 'L3', status: 'pending', scope: '等待精确分镜与连续性分析', confidence: null },
      { level: 'L4', status: 'pending', scope: '等待人工修正与真实制作结果回流', confidence: null },
    ],
    coverage: {
      fullDurationSeconds: null,
      precisionIntervals: [],
      gaps: [],
      overallConfidence: null,
      fullTimelineCovered: false,
    },
    shots: [],
    hookAnalysis: null,
    rightsNotice: recommendation
      ? '系统正在寻找并分析适合当前任务的参考视频；推荐结果需要明确展示为系统推荐，不代表用户已确认，也不代表版权已经确认。'
      : '参考链接正在进行逐镜分析。提交链接仅代表允许系统分析，不代表版权已经确认；分析完成后口播会逐字逐句冻结并仅替换企业名、品牌名或产品名，系统不会复用原视频文件、人物身份、水印或原声音频。',
    createdAt: source.createdAt,
  };
}

export function timeSeconds(value: string): number {
  const parts = value.split(':').map(Number);
  if (!parts.length || parts.some(part => !Number.isFinite(part))) return Number.NaN;
  return parts.reduce((sum, part) => sum * 60 + part, 0);
}

export function detailTiming(detail: Record<string, unknown>, minimumSeconds = 0.2): ExactReferenceDetail['timing'] | null {
  const value = socialText(detail.time) || socialText(detail.timestamp);
  const token = String.raw`(?:\d{1,2}:){1,2}\d{1,2}(?:\.\d+)?|\d+(?:\.\d+)?`;
  const match = value.match(new RegExp(`(${token})\\s*(?:s|秒)?\\s*(?:-|–|—|~|～|至|to)\\s*(${token})`, 'i'));
  if (!match) return null;
  const startSeconds = timeSeconds(match[1]!);
  const endSeconds = timeSeconds(match[2]!);
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || startSeconds < 0 || endSeconds - startSeconds < minimumSeconds) return null;
  return {
    startSeconds: +startSeconds.toFixed(2),
    endSeconds: +endSeconds.toFixed(2),
    durationSeconds: +(endSeconds - startSeconds).toFixed(2),
  };
}

export function exactAnalysis(record: Record<string, unknown>): {
  analysis: Record<string, unknown>;
  gemini: Record<string, unknown>;
  details: ExactReferenceDetail[];
  allDetails: ExactReferenceDetail[];
  reviewedSpeech: Record<string, unknown>[] | null;
  reviewedSpeechPrecision: 'phrase' | 'coarse' | null;
} | null {
  const analysis = recordObject(record.aiAnalysis);
  const gemini = recordObject(analysis.gemini);
  let rawDetails = Array.isArray(socialJson(gemini.scriptDetails15s))
    ? (socialJson(gemini.scriptDetails15s) as unknown[]).map(recordObject).filter(item => Object.keys(item).length)
    : [];
  let reviewedSpeech: Record<string, unknown>[] | null = null;
  let reviewedSpeechPrecision: 'phrase' | 'coarse' | null = null;
  const savedReview = recordObject(record.referenceShotReview);
  // The automatic content path consumes exact video evidence directly. A
  // partially saved director review must not become a prerequisite for the
  // digital employee to draft speech from source ASR.
  if (savedReview.reviewComplete === true) {
    const review = savedReview;
    const speech = recordObject(record.referenceVerifiedSpeech);
    const recordId = socialText(record.id);
    const runId = socialText(analysis.analysisRunId);
    const sourceHash = socialText(analysis.contentSha256);
    const sections = Array.isArray(review.sections) ? review.sections.map(recordObject) : [];
    const reviewedShots = Array.isArray(review.shots) ? review.shots.map(recordObject) : [];
    // A discarded cut remains in the review audit trail, but is not a
    // production shot. The review endpoint validates those decisions before
    // setting reviewComplete; projecting them here would resurrect flashes.
    const retainedShots = reviewedShots.filter(shot => shot.reviewStatus !== 'discarded');
    const manualLines = Array.isArray(speech.lines) ? speech.lines.map(recordObject) : [];
    // A saved review is a versioned override. Never fall back to the original
    // model output if it is incomplete or bound to an older upload/run.
    const duration = Number(record.duration || record.durationSeconds || analysis.durationSeconds);
    let validSpeech = false;
    try {
      validSpeech = validateVerifiedSpeechLines(manualLines, duration).length === manualLines.length;
    } catch { /* A bad manual transcript must not be projected as phrase timing. */ }
    const manualSpeech = socialText(speech.analysisRunId) === runId
      && socialText(speech.sourceSha256) === sourceHash
      && speech.coverageConfirmed === true && Boolean(socialText(speech.reviewerId))
      && Boolean(socialText(speech.verifiedAt)) && validSpeech;
    const approximateLines = approximateSpeechLines(recordObject(gemini.audioTranscript).segments);
    const lines = manualSpeech ? manualLines : approximateLines.map(recordObject);
    if (!recordId || !runId || !sourceHash || review.reviewComplete !== true
      || socialText(review.referenceRecordId) !== recordId
      || socialText(review.sourceAnalysisRunId) !== runId
      || sections.length !== 6 || sections.some(section => section.confirmed !== true)
      || !retainedShots.length || retainedShots.some(shot => shot.reviewStatus !== 'confirmed')
      || !lines.length) return null;
    const sourceDetails = rawDetails;
    rawDetails = retainedShots.map(shot => {
      const start = Number(shot.start), end = Number(shot.end);
      const sourceIds = Array.isArray(shot.sourceShotIds) ? shot.sourceShotIds.map(socialText) : [];
      const sourceIndex = sourceIds.length === 1 ? Number(sourceIds[0]?.replace(/^shot-/, '')) - 1 : -1;
      const source = sourceDetails[sourceIndex] ?? {};
      const original = detailTiming(source);
      const sameRange = original && Math.abs(original.startSeconds - start) < .06 && Math.abs(original.endSeconds - end) < .06;
      const refs = reviewShotMaterialRefs(record, { shotId: socialText(shot.shotId), start, end });
      const evidenceRefs = Array.isArray(shot.evidenceRefs) ? shot.evidenceRefs.map(socialText) : [];
      const generatedEvidence = refs.every(ref => evidenceRefs.includes(ref));
      const originalEvidence = recordObject(source.materialEvidence);
      const inheritedEvidence = sameRange && originalEvidence.extractionStatus === 'ready'
        && [originalEvidence.clipRef, originalEvidence.firstFrameRef].every(ref => evidenceRefs.includes(socialText(ref)));
      if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < .15
        || !socialText(shot.content) || !socialText(shot.purpose)
        || !socialText(shot.shotId) || (!generatedEvidence && !inheritedEvidence)) return {};
      return {
        ...source, ...shot, time: `${start}-${end}`, visual: shot.content, purpose: shot.purpose,
        dialogue: lines.filter(line => Number(line.start) < end && Number(line.end) > start)
          .map(line => socialText(line.text)).join(' '),
        needsReview: false,
        materialEvidence: generatedEvidence
          ? { sourceVideoRef: `/api/overseas/videos/${encodeURIComponent(recordId)}/media`, clipRef: refs[0], firstFrameRef: refs[1], extractionStatus: 'ready' }
          : originalEvidence,
      };
    });
    if (rawDetails.some(detail => !Object.keys(detail).length)) return null;
    reviewedSpeech = lines;
    reviewedSpeechPrecision = manualSpeech ? 'phrase' : 'coarse';
  }
  const seenRanges = new Set<string>();
  const allDetails = rawDetails.flatMap(detail => {
    const timing = detailTiming(detail, 0.01);
    return timing ? [{ detail, timing }] : [];
  }).sort((left, right) => left.timing.startSeconds - right.timing.startSeconds
    || left.timing.endSeconds - right.timing.endSeconds);
  const filteredDetails = rawDetails.flatMap(detail => {
    const timing = detailTiming(detail, reviewedSpeech ? 0.15 : 0.2);
    const physicalEvidence = recordObject(detail.materialEvidence);
    // A model uncertainty flag is advisory when the original video clip and
    // first frame have already been extracted. It must not force a human
    // reviewer into the autonomous creation path.
    if (!timing || (detail.needsReview === true && physicalEvidence.extractionStatus !== 'ready')) return [];
    const key = `${timing.startSeconds.toFixed(2)}-${timing.endSeconds.toFixed(2)}`;
    if (seenRanges.has(key)) return [];
    seenRanges.add(key);
    return [{ detail, timing }];
  }).sort((left, right) => left.timing.startSeconds - right.timing.startSeconds
    || left.timing.endSeconds - right.timing.endSeconds);
  const details = normalizeReferenceTimelineBoundaries(
    filteredDetails,
    allDetails.map(row => row.timing),
    Array.isArray(gemini.detectedSceneCuts) ? gemini.detectedSceneCuts.map(Number) : [],
  );
  if (socialText(analysis.analysisMode) !== 'exact'
    || !['video', 'video_review_required'].includes(socialText(analysis.analysisQuality))
    || details.length < 2) return null;
  return { analysis, gemini, details, allDetails, reviewedSpeech, reviewedSpeechPrecision };
}

export function synthetic(record: Record<string, unknown>, analysis: Record<string, unknown>): boolean {
  if ([record.synthetic, record.isMock, record.isDemo, analysis.synthetic, analysis.isMock].some(value => value === true)) return true;
  const marker = [record.source, record.sourceType, analysis.source, analysis.sourceType]
    .map(socialText).join(' ').toLowerCase();
  return /(?:^|[\s_./:-])(fixture|mock|placeholder|demo_seed|sample_data)(?:$|[\s_./:-])/.test(marker);
}

export function referenceCoverage(input: {
  record: Record<string, unknown>;
  exact: NonNullable<ReturnType<typeof exactAnalysis>>;
  shots: SocialReferenceShotAnalysis[];
}): NonNullable<SocialReferenceVideoAnalysis['coverage']> {
  const declaredDuration = Number(input.record.duration || recordObject(input.record.videoMeta).duration || 0);
  const analyzedUntil = Math.max(0, ...input.shots.map(shot => shot.endSeconds));
  const fullDurationSeconds = declaredDuration > 0 ? declaredDuration : analyzedUntil || null;
  const gaps: Array<{ startSeconds: number; endSeconds: number; reason: string }> = [];
  const exactRanges = input.exact.allDetails.flatMap(item => {
    const range = parseAnalysisTimeRange(socialText(item.detail.time || item.detail.timestamp));
    return range ? [range] : [];
  });
  const exactCovers = (start: number, end: number) => {
    let coveredUntil = start;
    for (const range of exactRanges.filter(range => range.end > start && range.start < end)
      .sort((left, right) => left.start - right.start)) {
      if (range.start - coveredUntil > 0.03) return false;
      coveredUntil = Math.max(coveredUntil, range.end);
      if (coveredUntil >= end - 0.03) return true;
    }
    return coveredUntil >= end - 0.03;
  };
  let cursor = 0;
  for (const shot of input.shots) {
    if (shot.startSeconds - cursor > 0.15 && !exactCovers(cursor, shot.startSeconds)) {
      gaps.push({ startSeconds: +cursor.toFixed(2), endSeconds: +shot.startSeconds.toFixed(2), reason: '该区间没有通过精确分析校验，保留为空档等待补充分析' });
    }
    cursor = Math.max(cursor, shot.endSeconds);
  }
  if (fullDurationSeconds !== null && fullDurationSeconds - cursor > 0.15) {
    gaps.push({ startSeconds: +cursor.toFixed(2), endSeconds: +fullDurationSeconds.toFixed(2), reason: '精确分析尚未覆盖视频尾部，不能用已分析区间代替整片时长' });
  }
  const confidenceValues = input.exact.details
    .map(item => Number(item.detail.confidence))
    .filter(value => Number.isFinite(value) && value >= 0 && value <= 1);
  const overallConfidence = confidenceValues.length
    ? +(confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length).toFixed(3)
    : null;
  return {
    fullDurationSeconds,
    precisionIntervals: input.shots.map(shot => ({ startSeconds: shot.startSeconds, endSeconds: shot.endSeconds, level: 'L3' as const })),
    gaps,
    overallConfidence,
    fullTimelineCovered: fullDurationSeconds !== null && gaps.length === 0 && cursor >= fullDurationSeconds - 0.15,
  };
}

export function combinedText(detail: Record<string, unknown>, fields: string[]): string {
  return fields.flatMap(field => field === 'beats'
    ? (Array.isArray(socialJson(detail.beats))
      ? (socialJson(detail.beats) as unknown[]).map(item => socialText(recordObject(item).action))
      : [])
    : [socialText(detail[field])]).filter(Boolean).join(' ').toLocaleLowerCase();
}

export function safeShotFunction(detail: Record<string, unknown>, themeId: SocialContentThemeId): string {
  const text = combinedText(detail, ['purpose', 'visual', 'observedFacts', 'inferredIntent']);
  if (/(?:钩子|开场|吸引|首屏|痛点|hook|opening|attention|problem)/i.test(text)) return '开场吸引';
  if (/(?:质检|检测|证据|数据|对比|结果|认证|test|inspect|evidence|data|comparison|result)/i.test(text)) return '证据呈现';
  if (/(?:工厂|车间|产线|生产|灌装|机器|factory|workshop|production|manufactur)/i.test(text)) return '现场过程展示';
  if (/(?:使用|操作|涂抹|演示|步骤|use|apply|demo|operation|step)/i.test(text)) return '真实过程演示';
  if (/(?:细节|质地|纹理|成分|包装|瓶身|特写|detail|texture|ingredient|package|close)/i.test(text)) return '细节展示';
  if (/(?:装箱|仓储|发货|交付|shipment|warehouse|delivery|packing)/i.test(text)) return '包装与交付展示';
  if (/(?:收束|结尾|行动|咨询|ending|summary|call.to.action|cta)/i.test(text)) return '信息收束';
  return ({
    product_value: '产品画面展示',
    scenario_solution: '场景过程展示',
    supplier_capability: '供应现场展示',
    customization_process: '合作过程展示',
    customer_case: '合作证据展示',
  } satisfies Record<SocialContentThemeId, string>)[themeId];
}

export function safeSubject(detail: Record<string, unknown>): string {
  // This is a closed taxonomy. It intentionally never copies a brand, a
  // person's identity/appearance, original dialogue or reference-video claim.
  const text = combinedText(detail, ['visual', 'observedFacts', 'environment', 'purpose', 'beats']);
  if (/(?:质检|检测|仪器|记录|参数|证书|inspect|test|instrument|record|certificate|data)/i.test(text)) return '素材中可见的检验或记录';
  if (/(?:工厂|车间|产线|生产|机器|设备|factory|workshop|production|machine|equipment)/i.test(text)) return '素材中的真实生产现场';
  if (/(?:装箱|仓储|发货|包装线|shipment|warehouse|delivery|packing)/i.test(text)) return '素材中的包装或交付过程';
  if (/(?:质地|纹理|液体|膏体|粉体|配方|texture|liquid|cream|powder|formula)/i.test(text)) return '素材中可见的产品细节';
  if (/(?:使用|操作|涂抹|手部|拿取|演示|use|apply|operation|hand|demo)/i.test(text)) return '素材中的真实操作动作';
  if (/(?:产品|瓶|罐|盒|包装|实物|product|bottle|jar|box|package)/i.test(text)) return '素材中的产品实物';
  return '素材中的真实场景';
}

export function safeReferenceStructure(row: ExactReferenceDetail): SocialInspirationScriptMatch['nodes'][number]['referenceStructure'] {
  const shotText = combinedText(row.detail, ['shot', 'visual', 'composition']);
  const cameraText = combinedText(row.detail, ['camera']);
  const transitionText = combinedText(row.detail, ['transitionToNext']);
  const beats = Array.isArray(socialJson(row.detail.beats)) ? (socialJson(row.detail.beats) as unknown[]) : [];
  const shotScale = /(?:大特写|极近|macro|extreme.close)/i.test(shotText) ? '极近特写'
    : /(?:特写|近景|close)/i.test(shotText) ? '近景特写'
      : /(?:中景|medium)/i.test(shotText) ? '中景'
        : /(?:全景|远景|wide|long.shot)/i.test(shotText) ? '全景' : '通用景别';
  const cameraMovement = /(?:推进|推镜|push|dolly.in|zoom.in)/i.test(cameraText) ? '推进镜头'
    : /(?:拉远|拉镜|pull|dolly.out|zoom.out)/i.test(cameraText) ? '拉远镜头'
      : /(?:横移|摇镜|平移|pan|slide)/i.test(cameraText) ? '横向摇移'
        : /(?:跟随|跟拍|tracking|follow)/i.test(cameraText) ? '跟随镜头'
          : /(?:手持|handheld)/i.test(cameraText) ? '手持镜头'
            : /(?:固定|静止|static|locked)/i.test(cameraText) ? '固定镜头' : '通用运镜';
  const paceText = `${cameraText} ${transitionText} ${socialText(row.detail.purpose)}`;
  const pace = /(?:慢|舒缓|缓慢|slow|gentle)/i.test(paceText) ? '舒缓'
    : /(?:快|闪切|跳切|fast|rapid|jump)/i.test(paceText) || beats.length >= 3 || row.timing.durationSeconds <= 1.5 ? '快速'
      : row.timing.durationSeconds <= 3.2 ? '紧凑' : '舒缓';
  const transition = /(?:闪切|跳切|硬切|jump|hard.cut|flash)/i.test(transitionText) ? '快速切换'
    : /(?:淡入|淡出|叠化|溶解|fade|dissolve)/i.test(transitionText) ? '柔和过渡'
      : /(?:动作|匹配|match|movement)/i.test(transitionText) ? '动作衔接' : '自然衔接';
  return { sourceTiming: row.timing, shotScale, cameraMovement, pace, transition };
}

export function safeReferenceNodes(
  themeId: SocialContentThemeId,
  details: ExactReferenceDetail[],
): SocialInspirationScriptMatch['nodes'] {
  return details.map((row, index, nodes) => {
    const referenceStructure = safeReferenceStructure(row);
    return {
      nodeId: `inspiration-${index + 1}`,
      shotFunction: safeShotFunction(row.detail, themeId),
      subject: safeSubject(row.detail),
      action: `${referenceStructure.shotScale} · ${referenceStructure.cameraMovement} · ${referenceStructure.pace}节奏 · ${referenceStructure.transition}`,
      referenceStructure,
      narrationTemplate: {
        zh: index === 0 ? '通过客户上传的真实画面，看看{{product}}。'
          : index === nodes.length - 1 ? '只呈现真实画面和已确认资料。{{callToAction}}'
            : '以下内容只说明素材中真实可见的画面。',
        en: index === 0 ? 'See {{product}} through real customer-supplied footage.'
          : index === nodes.length - 1 ? 'Only real footage and verified information are presented. {{callToAction}}'
            : 'This section stays within what is visibly supported by the supplied footage.',
      },
    };
  });
}

export function referenceNarrationLines(details: ExactReferenceDetail[]): string[] {
  return details.map(item => {
    const direct = [item.detail.spokenText, item.detail.dialogue, item.detail.voiceover]
      .find(value => typeof value === 'string' && value.length > 0);
    if (typeof direct === 'string') return direct;
    const audio = typeof item.detail.audio === 'string' ? item.detail.audio : '';
    const match = audio.match(/^ASR\s*:\s*([\s\S]*)$/i);
    return match?.[1] ?? '';
  });
}

export function sourceSpeechTiming(
  row: ExactReferenceDetail,
  originalSpeech: string,
  transcript: unknown,
): SocialReferenceShotAnalysis['spokenTextTiming'] {
  const segments = Array.isArray(recordObject(transcript).segments)
    ? (recordObject(transcript).segments as unknown[]).map(recordObject)
    : [];
  const overlapping = segments.filter(segment => {
    const start = Number(segment.start), end = Number(segment.end);
    return Number.isFinite(start) && Number.isFinite(end) && end > start
      && start < row.timing.endSeconds && end > row.timing.startSeconds;
  });
  const normalize = (value: unknown) => socialText(value).toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  const phrase = overlapping.filter(segment => segment.timingPrecision === 'phrase'
    && Number(segment.start) >= row.timing.startSeconds - 0.05
    && Number(segment.end) <= row.timing.endSeconds + 0.05
    && socialText(segment.provenance));
  const verifiedText = phrase.map(segment => socialText(segment.text)).join('');
  if (originalSpeech && normalize(verifiedText) === normalize(originalSpeech) && phrase.length) {
    return {
      precision: 'phrase',
      provenance: [...new Set(phrase.map(segment => socialText(segment.provenance)))].join(','),
      startSeconds: Math.min(...phrase.map(segment => Number(segment.start))),
      endSeconds: Math.max(...phrase.map(segment => Number(segment.end))),
    };
  }
  if (overlapping.length) return {
    precision: 'coarse',
    provenance: [...new Set(overlapping.map(segment => socialText(segment.provenance)).filter(Boolean))].join(',') || null,
    startSeconds: Math.min(...overlapping.map(segment => Number(segment.start))),
    endSeconds: Math.max(...overlapping.map(segment => Number(segment.end))),
  };
  return { precision: 'none', provenance: null, startSeconds: null, endSeconds: null };
}

export function verifiedSpokenLines(
  row: ExactReferenceDetail,
  originalSpeech: string,
  transcript: unknown,
): NonNullable<SocialReferenceShotAnalysis['spokenLines']> {
  if (!originalSpeech) return [];
  const raw = recordObject(transcript).segments;
  const segments = Array.isArray(raw) ? raw.map(recordObject) : [];
  const phrases = segments.filter(segment => segment.timingPrecision === 'phrase'
    && socialText(segment.provenance)
    && Number.isFinite(Number(segment.start)) && Number.isFinite(Number(segment.end))
    && Number(segment.end) > Number(segment.start)
    && Number(segment.start) >= row.timing.startSeconds - 0.05
    && Number(segment.end) <= row.timing.endSeconds + 0.05);
  const normalize = (value: unknown) => socialText(value).toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  if (!phrases.length || normalize(phrases.map(segment => socialText(segment.text)).join('')) !== normalize(originalSpeech)) return [];
  return phrases.map(segment => ({
    text: socialText(segment.text),
    startSeconds: Number(segment.start),
    endSeconds: Number(segment.end),
    precision: 'phrase' as const,
    provenance: socialText(segment.provenance),
  }));
}

export function reviewedShotSpeech(row: ExactReferenceDetail, lines: Record<string, unknown>[], runId: string,
  precision: 'phrase' | 'coarse' = 'phrase'): {
  spokenText: string;
  timing: SocialReferenceShotAnalysis['spokenTextTiming'];
  lines: NonNullable<SocialReferenceShotAnalysis['spokenLines']>;
} {
  const overlapping = lines.filter(line => Number(line.start) < row.timing.endSeconds
    && Number(line.end) > row.timing.startSeconds);
  const spokenLines = overlapping.map(line => ({
    text: socialText(line.text),
    startSeconds: Number(line.start),
    endSeconds: Number(line.end),
    precision,
    provenance: socialText(line.provenance) || `${precision === 'phrase' ? 'human_verified' : 'approximate_asr'}:${runId}`,
  }));
  return {
    spokenText: overlapping.map(line => socialText(line.text)).join(' '),
    timing: overlapping.length ? {
      precision, provenance: [...new Set(spokenLines.map(line => line.provenance))].join(','),
      startSeconds: Math.min(...overlapping.map(line => Number(line.start))),
      endSeconds: Math.max(...overlapping.map(line => Number(line.end))),
    } : { precision: 'none', provenance: null, startSeconds: null, endSeconds: null },
    lines: spokenLines,
  };
}

export function referenceCaptionLines(details: ExactReferenceDetail[]): string[] {
  return details.map(item => {
    const direct = [item.detail.captionText, item.detail.onScreenText, item.detail.subtitle]
      .find(value => typeof value === 'string' && value.length > 0);
    return typeof direct === 'string' ? direct : '';
  });
}

export type IdentityEntityType = 'company' | 'brand' | 'product';
export type ReferenceIdentityPlan = Record<IdentityEntityType, { originals: string[]; replacement: string | null }>;

export function identityStrings(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap(item => typeof item === 'string' ? [item] : []).filter(Boolean);
}

/** Model entity labels are proposals, not proof that a phrase is a name.
 * Pain points and benefit headings such as "fake white shade" or "Three
 * core perks" must never become product identity replacement tokens. */
export function isNamedIdentity(value: string, title: string): boolean {
  const token = value.trim();
  if (!token || token.length > 80) return false;
  const titleContains = title.toLocaleLowerCase().includes(token.toLocaleLowerCase());
  if (/^[\p{Script=Han}]+$/u.test(token)) return titleContains && token.length >= 2;
  if (/^@[\p{L}\p{N}_.-]{2,40}$/u.test(token)) return true;
  if (/^[A-Z0-9_-]{2,40}$/.test(token)) return titleContains;
  if (/^[A-Za-z0-9_-]+$/.test(token) && /[A-Z].*[A-Z]/.test(token)) return titleContains;
  // Multiword Latin names require name-like casing in every component and
  // corroboration from the video's title, not just an ASR subtitle.
  if (/^[A-Z][a-zA-Z0-9-]*(?:\s+[A-Z][a-zA-Z0-9-]*)+$/.test(token)) return titleContains;
  return false;
}

export function structuredIdentityTokens(
  type: IdentityEntityType,
  record: Record<string, unknown>,
  exact: NonNullable<ReturnType<typeof exactAnalysis>>,
): string[] {
  const keys = type === 'company'
    ? ['companyName', 'enterpriseName', 'company']
    : type === 'brand'
      ? ['brandName', 'brand']
      : ['productName', 'productRef', 'product'];
  // Per-shot `product` fields often describe a category, pain point or
  // visual subject. They are not a product catalogue or named-entity source.
  const containers = [record, exact.analysis, exact.gemini];
  const title = socialText(record.title);
  const direct = containers.flatMap(container => keys.flatMap(key => identityStrings(container[key])))
    .filter(value => isNamedIdentity(value, title));
  const entityRows = containers.flatMap(container => {
    const value = container.identityEntities ?? container.namedEntities ?? container.entities;
    return Array.isArray(value) ? value.map(recordObject) : [];
  });
  const tagged = entityRows.flatMap(entity => {
    const entityType = socialText(entity.type || entity.kind || entity.entityType).toLocaleLowerCase();
    const matches = type === 'company' ? /company|enterprise|企业|公司/.test(entityType)
      : type === 'brand' ? /brand|品牌/.test(entityType)
        : /product|sku|产品|商品/.test(entityType);
    return matches ? identityStrings(entity.text ?? entity.value ?? entity.name)
      .filter(value => isNamedIdentity(value, title)) : [];
  });
  return [...new Set([...direct, ...tagged].map(value => value.trim()).filter(Boolean))];
}

/** Legacy exact analyses did not always emit named entities. Only infer a
 * leading handle/acronym when it is repeated in title and visible analysis;
 * ordinary nouns, claims and the remainder of the sentence are never touched. */
export function conservativeLegacyProductIdentity(
  record: Record<string, unknown>,
  exact: NonNullable<ReturnType<typeof exactAnalysis>>,
  lines: string[],
): string[] {
  const first = lines.find(Boolean) ?? '';
  const token = first.match(/^\s*((?:@[\p{L}\p{N}_.-]{2,40})|(?:[A-Z][A-Z0-9_-]{1,31}))(?=\s|[，,。.!！?？:：]|$)/u)?.[1];
  if (!token) return [];
  const title = socialText(record.title);
  const visuals = exact.details.map(item => socialText(item.detail.visual)).join(' ');
  return title.includes(token) && visuals.includes(token) ? [token] : [];
}

export function identityPlan(input: {
  record: Record<string, unknown>;
  exact: NonNullable<ReturnType<typeof exactAnalysis>>;
  referenceLines: string[];
  verifiedContext: VerifiedSocialScriptContext;
  replacements?: Partial<Record<`${IdentityEntityType}Name`, string | null>>;
}): ReferenceIdentityPlan {
  const explicitProduct = structuredIdentityTokens('product', input.record, input.exact);
  return {
    company: {
      originals: structuredIdentityTokens('company', input.record, input.exact),
      replacement: socialText(input.replacements?.companyName) || input.verifiedContext.enterpriseName || null,
    },
    brand: {
      originals: structuredIdentityTokens('brand', input.record, input.exact),
      replacement: socialText(input.replacements?.brandName) || input.verifiedContext.brandName || null,
    },
    product: {
      originals: explicitProduct.length
        ? explicitProduct
        : conservativeLegacyProductIdentity(input.record, input.exact, input.referenceLines),
      replacement: socialText(input.replacements?.productName) || input.verifiedContext.productName || null,
    },
  };
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function replaceIdentityOnly(text: string, plan: ReferenceIdentityPlan): {
  text: string;
  replacedEntityTypes: IdentityEntityType[];
} {
  let output = text;
  const replaced = new Set<IdentityEntityType>();
  const replacements = (['company', 'brand', 'product'] as const).flatMap(type => {
    const replacement = plan[type].replacement;
    if (!replacement) return [];
    return plan[type].originals.map(original => ({ type, original, replacement }));
  }).filter(item => item.original && item.original !== item.replacement)
    .sort((left, right) => right.original.length - left.original.length);
  for (const item of replacements) {
    const escaped = escapeRegExp(item.original);
    // ASCII names need token boundaries (so `ACME` does not alter
    // `ACMECorp`). Chinese identity words are normally adjacent to particles
    // such as “的”; Unicode word boundaries would incorrectly prevent those
    // exact replacements.
    const tokenLike = /^[A-Za-z0-9_@.-]+$/.test(item.original);
    const pattern = new RegExp(tokenLike ? `(?<![\\p{L}\\p{N}_-])${escaped}(?![\\p{L}\\p{N}_-])` : escaped, 'giu');
    const next = output.replace(pattern, item.replacement);
    if (next !== output) replaced.add(item.type);
    output = next;
  }
  return { text: output, replacedEntityTypes: (['company', 'brand', 'product'] as const).filter(type => replaced.has(type)) };
}

export function normalizedReferenceIdentity(value: unknown): string {
  return socialText(value).trim().replace(/\/$/, '').toLocaleLowerCase();
}

export function recordReferenceIdentities(record: Record<string, unknown>): Set<string> {
  return new Set([
    record.id,
    record.sourceUrl,
    record.url,
    record.originalUrl,
    record.shareUrl,
    record.videoUrl,
  ].map(normalizedReferenceIdentity).filter(Boolean));
}

export function sourceReferenceIdentities(source: Pick<SocialTaskSource, 'sourceRef'>): Set<string> {
  const reference = normalizedReferenceIdentity(source.sourceRef);
  const suffix = reference.match(/^(?:trendvideo|trend_video|video):(.+)$/)?.[1]
    ?? reference.match(/^local:\/\/([a-z0-9._-]+)$/)?.[1] ?? '';
  return new Set([reference, normalizedReferenceIdentity(suffix)].filter(Boolean));
}
