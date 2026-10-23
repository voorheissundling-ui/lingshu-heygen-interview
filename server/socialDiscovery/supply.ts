import type { DataStore } from '../storage/datastore.js';
import { store } from '../storage/index.js';
import type {
  SocialAccountTrackingDecision,
  SocialAudienceRole,
  SocialBusinessModel,
  SocialDiscoveryCandidateScore,
  SocialDiscoveryReadiness,
  SocialDiscoveryScoreDecision,
  SocialDiscoverySupplyItem,
} from '../../shared/contracts/socialContentWorkflow.js';
import { evaluateSocialCandidateEvidence, scoreSocialDiscoveryCandidate } from '../../shared/socialInspirationStrategy.js';
import type { VersionedCandidateEvidence } from './qualityOrchestration.js';
import { CANDIDATE_EVIDENCE_COLLECTION } from './orchestration.js';
import { DISCOVERY_SCOPE_COLLECTION, type DiscoveryScopeRecord } from './service.js';

const ACCOUNT_COLLECTION = 'social_tracked_accounts';

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map(item => String(item || '').trim()).filter(Boolean))] : [];
}

function platformFrom(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized.includes('tiktok')) return 'tiktok';
  if (normalized.includes('instagram')) return 'instagram';
  if (normalized.includes('facebook')) return 'facebook';
  if (normalized.includes('youtu')) return 'youtube';
  return 'unknown';
}

function latestByCandidate(rows: Array<VersionedCandidateEvidence & { id: string }>): Array<VersionedCandidateEvidence & { id: string }> {
  const latest = new Map<string, VersionedCandidateEvidence & { id: string }>();
  for (const row of rows) {
    const existing = latest.get(row.candidateId);
    if (!existing || row.version > existing.version) latest.set(row.candidateId, row);
  }
  return [...latest.values()];
}

function sourceText(record: Record<string, unknown>): string {
  const analysis = object(record.aiAnalysis);
  const gemini = object(analysis.gemini);
  return [record.title, record.author, analysis.caption, analysis.author, gemini.summary]
    .map(value => String(value || '').trim()).filter(Boolean).join(' ');
}

function scoreForEvidence(
  row: VersionedCandidateEvidence,
  record: Record<string, unknown>,
  audienceRole: SocialAudienceRole,
  now: Date,
): { score: SocialDiscoveryCandidateScore; businessModel: SocialBusinessModel; platform: string } {
  const platform = row.evidence.classification?.platform || String(record.platform || '') || platformFrom(String(record.sourceUrl || ''));
  if (row.evidence.qualityScore && row.evidence.classification) {
    return { score: row.evidence.qualityScore, businessModel: row.evidence.classification.businessModel, platform };
  }
  const { businessModel, ...score } = scoreSocialDiscoveryCandidate({
    evidence: row.evidence,
    platform,
    keywordTier: row.evidence.classification?.keywordTier,
    audienceRole,
    sourceText: sourceText(record),
    hasSource: Boolean(row.g1.sourceUrl && row.g1.sourceUrl !== 'unknown'),
    now,
  });
  return { score, businessModel, platform };
}

export interface SocialDiscoverySupplyFilters {
  candidateType?: 'video' | 'account' | 'all';
  platform?: string;
  businessModel?: SocialBusinessModel;
  decision?: SocialDiscoveryScoreDecision;
  minScore?: number;
  sceneId?: string;
  search?: string;
  sort?: 'score' | 'latest';
  page?: number;
  perPage?: number;
}

async function querySocialDiscoverySupply(input: {
  tenantId: string;
  filters?: SocialDiscoverySupplyFilters;
  dataStore?: DataStore;
  now?: Date;
}, paginate = true): Promise<{ items: SocialDiscoverySupplyItem[]; totalItems: number; page: number; perPage: number; filtersApplied: SocialDiscoverySupplyFilters }> {
  const dataStore = input.dataStore ?? store;
  const now = input.now ?? new Date();
  const filters = input.filters ?? {};
  const scope = (await dataStore.list<DiscoveryScopeRecord>(DISCOVERY_SCOPE_COLLECTION, {
    where: { tenant_id: input.tenantId, status: 'active' }, sort: '-updated_at', page: 1, perPage: 1,
  })).items[0];
  const audienceRole = scope?.payload.keywordSet?.scope?.audienceRole ?? 'consumer';
  const output: SocialDiscoverySupplyItem[] = [];

  if (filters.candidateType !== 'account') {
    const evidenceRows = latestByCandidate(await allTenantRows<VersionedCandidateEvidence & { id: string; tenant_id: string }>(dataStore, CANDIDATE_EVIDENCE_COLLECTION, input.tenantId));
    for (const row of evidenceRows) {
      const record = await dataStore.getById<Record<string, unknown>>('trend_videos', row.candidateId) ?? {};
      const { score, businessModel, platform } = scoreForEvidence(row, record, audienceRole, now);
      const analysis = object(record.aiAnalysis);
      output.push({
        candidateId: row.candidateId,
        candidateType: 'video',
        platform,
        title: String(record.title || analysis.caption || row.candidateId),
        author: String(record.author || analysis.author || ''),
        sourceUrl: String(record.sourceUrl || row.g1.sourceUrl || ''),
        thumbnailUrl: String(record.thumbnailUrl || analysis.thumbnailUrl || '').trim() || null,
        publishedAt: String(analysis.uploadedAt || record.publishedAt || '').trim() || null,
        sceneIds: row.evidence.sceneIds,
        businessModel,
        score,
        evidenceRef: row.evidenceId,
        evidenceVersion: row.version,
        raw: record,
      });
    }
  }

  if (filters.candidateType !== 'video') {
    const accounts = await allTenantRows<SocialAccountTrackingDecision & { id: string; updated_at?: string; tenant_id: string }>(dataStore, ACCOUNT_COLLECTION, input.tenantId);
    for (const account of accounts) {
      const confidence = Math.max(0, Math.min(1, Number(account.confidence || 0)));
      const evidence = evaluateSocialCandidateEvidence({
        inspirationId: account.accountId,
        discoveryPath: ['account'],
        sceneIds: account.relatedSceneIds,
        taskRelevance: confidence,
        transferability: account.evidenceVideoIds.length >= 3 ? 0.9 : account.evidenceVideoIds.length ? 0.65 : 0.25,
        mechanisms: account.reasons,
        limitations: account.missingEvidence,
        evidenceRefs: account.evidenceVideoIds,
      });
      const platform = platformFrom(account.accountId);
      const { businessModel, ...score } = scoreSocialDiscoveryCandidate({
        evidence,
        platform,
        keywordTier: 'account',
        audienceRole,
        sourceText: [account.accountId, ...account.reasons].join(' '),
        hasSource: /^https?:\/\//i.test(account.accountId) && account.evidenceVideoIds.length > 0,
        now,
      });
      output.push({
        candidateId: account.accountId,
        candidateType: 'account',
        platform,
        title: account.accountId,
        author: account.accountId,
        sourceUrl: account.accountId,
        thumbnailUrl: null,
        publishedAt: account.updated_at ?? null,
        sceneIds: account.relatedSceneIds,
        businessModel,
        score,
        evidenceRef: `account_decision:${account.id}`,
        evidenceVersion: 1,
        raw: { status: account.status, decision: account.decision, accountRole: account.accountRole, businessConfirmation: account.businessConfirmation, evidenceVideoIds: account.evidenceVideoIds },
      });
    }
  }

  const search = String(filters.search || '').trim().toLowerCase();
  const filtered = output.filter(item => !filters.platform || item.platform === filters.platform)
    .filter(item => !filters.businessModel || item.businessModel === filters.businessModel)
    .filter(item => !filters.decision || item.score.decision === filters.decision)
    .filter(item => item.score.overall >= Math.max(0, Number(filters.minScore || 0)))
    .filter(item => !filters.sceneId || item.sceneIds.includes(filters.sceneId))
    .filter(item => !search || [item.title, item.author, item.sourceUrl, ...item.score.reasons].join(' ').toLowerCase().includes(search));
  filtered.sort(filters.sort === 'latest'
    ? (a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')) || b.score.overall - a.score.overall
    : (a, b) => b.score.overall - a.score.overall || a.candidateId.localeCompare(b.candidateId));
  const page = Math.max(1, Math.floor(Number(filters.page || 1)));
  const perPage = Math.min(100, Math.max(1, Math.floor(Number(filters.perPage || 30))));
  return {
    items: paginate ? filtered.slice((page - 1) * perPage, page * perPage) : filtered,
    totalItems: filtered.length,
    page,
    perPage,
    filtersApplied: filters,
  };
}

export async function listSocialDiscoverySupply(input: Parameters<typeof querySocialDiscoverySupply>[0]) {
  return querySocialDiscoverySupply(input);
}

/** Internal planning read: the supply query already scans and ranks the full
 * tenant inventory, so do not discard a weekly run's valid candidates at the
 * first UI page boundary. */
export async function listCompleteSocialDiscoverySupply(input: Parameters<typeof querySocialDiscoverySupply>[0]) {
  return querySocialDiscoverySupply(input, false);
}

async function allTenantRows<T extends { tenant_id?: string }>(dataStore: DataStore, collection: string, tenantId: string): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 1; ; page += 1) {
    const result = await dataStore.list<T>(collection, { where: { tenant_id: tenantId }, sort: 'id', page, perPage: 500 });
    rows.push(...result.items.filter(row => row.tenant_id === tenantId));
    if (page >= result.totalPages || !result.items.length) return rows;
  }
}

export async function evaluateSocialDiscoveryReadiness(input: {
  tenantId: string;
  dataStore?: DataStore;
  thresholds?: Partial<SocialDiscoveryReadiness['thresholds']>;
  now?: Date;
}): Promise<SocialDiscoveryReadiness> {
  const dataStore = input.dataStore ?? store;
  const thresholds = {
    acceptedVideos: Math.max(1, Math.floor(input.thresholds?.acceptedVideos ?? 12)),
    benchmarkAccounts: Math.max(1, Math.floor(input.thresholds?.benchmarkAccounts ?? 3)),
    sceneClusters: Math.max(1, Math.floor(input.thresholds?.sceneClusters ?? 3)),
  };
  const [scopeResult, supply, accounts] = await Promise.all([
    dataStore.list<DiscoveryScopeRecord>(DISCOVERY_SCOPE_COLLECTION, { where: { tenant_id: input.tenantId, status: 'active' }, sort: '-updated_at', page: 1, perPage: 1 }),
    querySocialDiscoverySupply({ tenantId: input.tenantId, filters: { candidateType: 'video', decision: 'accepted' }, dataStore, now: input.now }, false),
    allTenantRows<SocialAccountTrackingDecision & { tenant_id: string }>(dataStore, ACCOUNT_COLLECTION, input.tenantId),
  ]);
  const scope = scopeResult.items[0];
  const acceptedVideos = supply.totalItems;
  const benchmarkAccounts = accounts.filter(account => account.status === 'tracked' && account.businessConfirmation?.status === 'confirmed').length;
  const sceneClusters = new Set([
    ...(scope?.payload.keywordSet?.graph?.sceneClusters ?? []).filter(scene => scene.status === 'approved' || scene.status === 'watching').map(scene => scene.sceneId),
    ...supply.items.flatMap(item => item.sceneIds),
  ]).size;
  const actual = { acceptedVideos, benchmarkAccounts, sceneClusters };
  const gaps: SocialDiscoveryReadiness['gaps'] = [];
  if (!scope) gaps.push({ code: 'scope', label: '尚未确认采集范围', missing: 1 });
  if (acceptedVideos < thresholds.acceptedVideos) gaps.push({ code: 'videos', label: '合格爆款视频', missing: thresholds.acceptedVideos - acceptedVideos });
  if (benchmarkAccounts < thresholds.benchmarkAccounts) gaps.push({ code: 'accounts', label: '已确认对标账号', missing: thresholds.benchmarkAccounts - benchmarkAccounts });
  if (sceneClusters < thresholds.sceneClusters) gaps.push({ code: 'scenes', label: '有效中词场景', missing: thresholds.sceneClusters - sceneClusters });
  return {
    readyForOutline: Boolean(scope?.payload.approval?.status === 'approved'),
    readyForDetailedPlan: Boolean(scope?.payload.approval?.status === 'approved') && gaps.length === 0,
    thresholds,
    actual,
    gaps,
    evaluatedAt: (input.now ?? new Date()).toISOString(),
  };
}
