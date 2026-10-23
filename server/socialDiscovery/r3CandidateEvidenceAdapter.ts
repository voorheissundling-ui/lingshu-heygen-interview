import type { DataStore } from '../storage/datastore.js';
import { store } from '../storage/index.js';
import type { CrawlVideosResult } from '../routes/videos.js';
import type { SocialAudienceRole, SocialDiscoveryMode, SocialDiscoveryPath } from '../../shared/contracts/socialContentWorkflow.js';
import type { CandidateEvidenceWorkItem } from './candidateEvidenceWorker.js';
import type { InnovationEvidence } from './qualityOrchestration.js';

export interface R3CandidateEvidenceAdapterInput {
  tenantId: string;
  runId: string;
  scopeId: string;
  scopeVersion: number;
  mode: SocialDiscoveryMode;
  queryRef: string;
  result: CrawlVideosResult;
  observedAt: string;
  platform?: string;
  keywordTier?: 'broad' | 'medium' | 'evidence' | 'account' | 'unknown';
  audienceRole?: SocialAudienceRole;
}

/**
 * Boundary owned by R4. R3 may evolve the crawler/media record shape without
 * leaking it into quota, evidence, or Starter198 authority code.
 */
export interface R3CandidateEvidenceAdapter {
  toEvidenceWorkItems(input: R3CandidateEvidenceAdapterInput): Promise<CandidateEvidenceWorkItem[]>;
}

function object(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map(item => String(item || '').trim()).filter(Boolean))] : [];
}

function finite(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function metric(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  const normalized = String(value || '').trim().toLowerCase().replace(/,/g, '');
  const match = normalized.match(/^(-?\d+(?:\.\d+)?)\s*([kmb万亿])?/);
  if (!match) return undefined;
  const multiplier = match[2] === 'k' ? 1_000
    : match[2] === 'm' ? 1_000_000
      : match[2] === 'b' ? 1_000_000_000
        : match[2] === '万' ? 10_000
          : match[2] === '亿' ? 100_000_000 : 1;
  const parsed = Number(match[1]) * multiplier;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function paths(mode: SocialDiscoveryMode): SocialDiscoveryPath[] {
  if (mode === 'account') return ['account'];
  if (mode === 'innovation') return ['innovation'];
  return ['keyword', 'performance'];
}

function innovationEvidence(value: unknown): InnovationEvidence | undefined {
  const raw = object(value);
  if (raw.kind === 'adjacent_industry') return {
    kind: 'adjacent_industry',
    businessAnchor: typeof raw.businessAnchor === 'string' ? raw.businessAnchor : null,
    independentSourceRefs: strings(raw.independentSourceRefs),
    userConfirmed: raw.userConfirmed === true,
  };
  if (raw.kind === 'comment_question') return {
    kind: 'comment_question',
    commentRefs: strings(raw.commentRefs),
    contentRefs: strings(raw.contentRefs),
  };
  return undefined;
}

function recordId(record: Record<string, unknown>): string {
  return String(record.id || '').trim();
}

function workItem(input: R3CandidateEvidenceAdapterInput, record: Record<string, unknown>): CandidateEvidenceWorkItem | null {
  const candidateId = recordId(record);
  if (!candidateId) return null;
  const analysis = object(record.aiAnalysis);
  const gemini = object(analysis.gemini);
  const sourceUrl = String(record.sourceUrl || '').trim();
  const origin = (Array.isArray(analysis.discoveryOrigins) ? analysis.discoveryOrigins : [])
    .map(object)
    .find(item => item.runId === input.runId && item.mode === input.mode && item.queryRef === input.queryRef);
  const analysisRef = String(analysis.analysisId || gemini.analysisId || analysis.analysisRunId || '').trim();
  const evidenceRefs = [...new Set([
    sourceUrl,
    analysisRef ? `reference_analysis:${analysisRef}` : '',
    ...strings(analysis.evidenceRefs),
  ].filter(Boolean))];
  const analysisQuality = String(analysis.analysisQuality || '').trim();
  const contentFormat = String(record.contentFormat || analysis.contentFormat || 'video').trim();
  const taskRelevance = finite(analysis.taskRelevance ?? analysis.relevanceScore);
  const transferability = finite(analysis.transferability ?? analysis.structuralTransferability);
  const mechanisms = strings(analysis.mechanisms).length ? strings(analysis.mechanisms) : strings(gemini.hooks);
  const hasUsableMedia = contentFormat === 'image'
    ? strings(analysis.imageUrls).length > 0 && String(analysis.imageAnalysisStatus || object(analysis.imageEvidence).status || '').trim() === 'analyzed'
    : analysisQuality === 'video';
  const productionEligibilityIssues = [
    ...(input.mode === 'account' ? [] : ['只允许已确认对标账号内容进入生产库存']),
    ...(sourceUrl ? [] : ['缺少可追溯原帖地址']),
    ...([record.title, analysis.caption].some(value => String(value || '').trim()) ? [] : ['缺少原帖标题或配文']),
    ...(hasUsableMedia ? [] : [contentFormat === 'image' ? '图片与配文尚未完成统一分析' : '视频尚未完成可信多模态分析']),
    ...(taskRelevance !== undefined && taskRelevance >= 0.7 ? [] : ['与当前生产任务的相关性不足']),
    ...(transferability !== undefined && transferability >= 0.6 ? [] : ['结构可迁移性不足']),
    ...(mechanisms.length ? [] : ['尚未提炼可复用内容机制']),
  ];
  return {
    tenantId: input.tenantId,
    candidateId,
    discoveryPath: paths(input.mode),
    sceneIds: strings(analysis.sceneIds),
    taskRelevance,
    currentPerformance: metric(analysis.currentPerformance ?? analysis.views ?? analysis.plays),
    accountPlatformBaseline: metric(analysis.accountPlatformBaseline),
    performanceSnapshots: Array.isArray(analysis.performanceSnapshots)
      ? analysis.performanceSnapshots.map(object).flatMap(item => {
        const value = metric(item.value);
        const observedAt = String(item.observedAt || '').trim();
        return value === undefined || !observedAt ? [] : [{ observedAt, value }];
      }) : [],
    transferability,
    mechanisms,
    limitations: [
      ...strings(analysis.limitations),
      ...(analysisQuality && analysisQuality !== 'video' ? [`analysis_quality:${analysisQuality}`] : []),
    ],
    evidenceRefs,
    novelty: finite(analysis.novelty),
    platform: input.platform || String(record.platform || input.result.platform || 'unknown'),
    keywordTier: input.keywordTier ?? (input.mode === 'account' ? 'account' : 'unknown'),
    audienceRole: input.audienceRole,
    sourceText: [record.title, analysis.caption, analysis.author, gemini.summary, input.queryRef]
      .map(value => String(value || '').trim()).filter(Boolean).join(' '),
    innovationEvidence: innovationEvidence(analysis.innovationEvidence),
    productionEligibilityIssues,
    g1: {
      runId: input.runId,
      queryRef: input.queryRef,
      discoveryMode: input.mode,
      sourceType: input.mode === 'account' ? 'account' : input.mode === 'innovation' ? 'adjacent_industry' : 'keyword',
      sourceUrl: sourceUrl || undefined,
      observedAt: String(origin?.observedAt || record.crawledAt || input.observedAt).trim() || undefined,
      publishedAt: String(analysis.uploadedAt || '').trim() || undefined,
      followerCount: finite(analysis.followers),
      commentText: String(analysis.commentText || '').trim() || undefined,
    },
  };
}

export function createR3CandidateEvidenceAdapter(dataStore: DataStore = store): R3CandidateEvidenceAdapter {
  return {
    async toEvidenceWorkItems(input) {
      const supplied = (Array.isArray(input.result.items) ? input.result.items : [])
        .map(object)
        .filter(item => recordId(item));
      const byId = new Map(supplied.map(item => [recordId(item), item]));
      for (const candidateId of input.result.candidateIds ?? []) {
        if (byId.has(candidateId)) continue;
        const record = await dataStore.getById<Record<string, unknown>>('trend_videos', candidateId);
        if (record && String(record.tenantId || '') === input.tenantId) byId.set(candidateId, record);
      }
      return [...byId.values()].flatMap(record => {
        const item = workItem(input, record);
        return item ? [item] : [];
      });
    },
  };
}
