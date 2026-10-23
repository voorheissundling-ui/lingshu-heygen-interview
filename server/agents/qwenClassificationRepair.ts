import type { VideoAiAnalysis } from '../types/index.js';
import { exactVideoClassificationQualityError } from '../lib/videoAnalysisCodec.js';
import { untrustedPromptData } from '../lib/untrustedPromptData.js';

export type ShotClassificationRepair = {
  index: number;
  materialType: NonNullable<NonNullable<VideoAiAnalysis['scriptDetails15s']>[number]['materialType']>;
  narrativeRole: NonNullable<NonNullable<VideoAiAnalysis['scriptDetails15s']>[number]['narrativeRole']>;
  classificationEvidence: string;
  needsReview?: boolean;
};

export function mergeShotClassificationRepair(
  analysis: VideoAiAnalysis,
  repairs: ShotClassificationRepair[],
): VideoAiAnalysis {
  const byIndex = new Map(repairs.map(repair => [repair.index, repair]));
  return {
    ...analysis,
    scriptDetails15s: (analysis.scriptDetails15s || []).map((detail, offset) => {
      const repair = byIndex.get(offset + 1);
      if (!repair) return detail;
      const materialType = ['talking_head', 'factory', 'product', 'consumer_demo', 'general'].includes(repair.materialType)
        ? repair.materialType : 'unknown';
      const narrativeRole = ['hook', 'pain_point', 'capability_proof', 'product_intro', 'effect_proof', 'cta', 'transition'].includes(repair.narrativeRole)
        ? repair.narrativeRole : 'unknown';
      return {
        ...detail,
        materialType,
        narrativeRole,
        classificationEvidence: String(repair.classificationEvidence || '').trim(),
        ...(typeof repair.needsReview === 'boolean' ? { needsReview: repair.needsReview } : {}),
      };
    }),
  };
}

export async function repairVideoShotClassifications(input: {
  analysis: VideoAiAnalysis;
  signal?: AbortSignal;
  complete: (prompt: string, maxTokens: number, signal?: AbortSignal) => Promise<string>;
}): Promise<VideoAiAnalysis> {
  const evidenceRows = (input.analysis.scriptDetails15s || []).map((shot, index) => ({
    index: index + 1,
    time: shot.time,
    visual: shot.visual,
    observedFacts: shot.observedFacts,
    purpose: shot.purpose,
    dialogue: shot.dialogue,
    onScreenText: shot.onScreenText,
    materialType: shot.materialType,
    narrativeRole: shot.narrativeRole,
    classificationEvidence: shot.classificationEvidence,
    needsReview: shot.needsReview,
  }));
  if (!evidenceRows.length) throw new Error('exact_classification_repair_missing_shots');
  const evidence = untrustedPromptData('observed_shot_evidence', JSON.stringify(evidenceRows), 24_000);
  const prompt = `你是视频镜头生产交接校验器。只输出合法 JSON：{"shots":[{"index":1,"materialType":"product","narrativeRole":"hook","classificationEvidence":"画面可见产品瓶身特写","needsReview":false}]}。
不得改写或补充观察事实，只能依据下方已经完成的逐镜证据分类；这不是再次分析视频。shots 必须按 index 完整返回 ${evidenceRows.length} 项。
materialType 仅取 talking_head、factory、product、consumer_demo、general，不得返回 unknown；以镜头的主要可见主体为准。
narrativeRole 仅取 hook、pain_point、capability_proof、product_intro、effect_proof、cta、transition，不得返回 unknown；第 1 镜必须为 hook，其余根据 purpose、字幕、台词和可见内容判断。
classificationEvidence 必须引用本镜实际可见画面、已确认台词或用途，不得写空值、模板话术或新增事实。
needsReview 只表示现有画面证据不足以安全用于剪辑或无法确定镜头用途；品牌拼写、ASR措辞等不影响画面剪辑的轻微不确定不得阻塞交接。画面、时间区间、主要主体和用途均清楚时必须为 false。
${evidence}`;
  const raw = await input.complete(
    prompt,
    Math.max(1200, Math.min(4200, evidenceRows.length * 360 + 600)),
    input.signal,
  );
  let parsed: { shots?: ShotClassificationRepair[] } = {};
  try { parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim()); } catch { /* invalid below */ }
  const repairRows = Array.isArray(parsed.shots) ? parsed.shots : [];
  const indexes = repairRows.map(row => Number(row.index));
  if (repairRows.length !== evidenceRows.length
    || new Set(indexes).size !== evidenceRows.length
    || indexes.some(index => !Number.isInteger(index) || index < 1 || index > evidenceRows.length)) {
    throw new Error(`exact_classification_repair_mismatch_${repairRows.length}_of_${evidenceRows.length}`);
  }
  const normalized = mergeShotClassificationRepair(input.analysis, repairRows);
  const remainingError = exactVideoClassificationQualityError(normalized);
  if (remainingError) throw new Error(`exact_classification_incomplete_${remainingError}`);
  return normalized;
}
