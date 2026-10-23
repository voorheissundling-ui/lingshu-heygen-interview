import type { ReferenceSemanticPlanning } from './socialContentSemanticConsolidation.js';
import type {
  SocialContentThemeId,
  SocialReferenceVideoAnalysis,
  SocialReplicationScriptVersion,
  SocialShotMaterialMapEntry,
  SocialTaskSource,
} from '../../shared/contracts/socialContentWorkflow.js';
import { store, type DataStore } from '../storage/index.js';
import { resolveSocialReferenceReuseOnly, type SocialReferenceReuseBinding } from './socialContentReferenceReuse.js';
import {
  SocialContentWorkflowError,
  socialJson,
  socialObject,
  socialText,
} from './socialContentValidation.js';
import type {
  SocialInspirationScriptMatch,
  VerifiedSocialScriptContext,
} from './socialContentScriptBaseline.js';
import {
  buildSocialTaskReferencePackage,
  matchSocialInspirationScript,
  normalizedReferenceIdentity,
  recordReferenceIdentities,
  sourceReferenceIdentities,
  type ResolvedSocialTaskReference,
} from './socialContentScriptSources.js';

export async function resolveSocialInspirationScript(input: {
  tenantId: string;
  themeId: SocialContentThemeId;
  verifiedContext: VerifiedSocialScriptContext;
}): Promise<SocialInspirationScriptMatch | null> {
  try {
    const sharedTenantId = socialText(process.env.SOCIAL_SHARED_INSPIRATION_TENANT_ID)
      || 'demo-shared-video-pool';
    const tenantIds = [...new Set([input.tenantId, sharedTenantId].filter(Boolean))];
    const results = await Promise.allSettled(tenantIds.map(tenantId => store.list<Record<string, unknown>>('trend_videos', {
      where: { tenantId },
      sort: '-crawledAt',
      page: 1,
      perPage: 300,
    })));
    const records = [...new Map(results.flatMap(result => result.status === 'fulfilled' ? result.value.items : [])
      .map(record => [socialText(record.id), record] as const)
      .filter(([id]) => Boolean(id))).values()];
    return matchSocialInspirationScript({ ...input, records });
  } catch {
    // The inspiration catalog is an optional enhancement. A catalog outage
    // must not turn into copying task text; callers continue with a formula or
    // the verified-knowledge fallback and record the lower confidence.
    return null;
  }
}

/** Resolve only an exact active reference selected on the current task. It
 * never falls back to a same-theme catalog item, so a recommendation cannot be
 * mistaken for a customer-confirmed reference. */
export async function resolveSocialTaskReferenceScript(input: {
  tenantId: string;
  themeId: SocialContentThemeId;
  verifiedContext: VerifiedSocialScriptContext;
  referenceSources: Array<Pick<SocialTaskSource, 'sourceId' | 'sourceRef' | 'sourceVersion' | 'createdAt'>>;
  referenceReuse?: SocialReferenceReuseBinding;
  /** Server-owned repository transport; never read from a request body. */
  referenceStore?: Pick<DataStore, 'getById'>;
  planning?: ReferenceSemanticPlanning;
}): Promise<ResolvedSocialTaskReference | null> {
  // Explicit reuse never enters catalog fallback, analysis queue or crawler.
  // Keep failures outside the legacy best-effort catch so the gap is visible.
  if (input.referenceReuse) return resolveSocialReferenceReuseOnly({ ...input, binding: input.referenceReuse }, {
    readRecord: async id => await (input.referenceStore ?? store).getById<Record<string, unknown>>('trend_videos', id),
  });
  if (!input.referenceSources.length) return null;
  try {
    const sharedTenantId = socialText(process.env.SOCIAL_SHARED_INSPIRATION_TENANT_ID)
      || 'demo-shared-video-pool';
    const tenantIds = [...new Set([input.tenantId, sharedTenantId].filter(Boolean))];
    const results = await Promise.allSettled(tenantIds.map(tenantId => store.list<Record<string, unknown>>('trend_videos', {
      where: { tenantId },
      sort: '-crawledAt',
      page: 1,
      perPage: 500,
    })));
    const records = [...new Map(results.flatMap(result => result.status === 'fulfilled' ? result.value.items : [])
      .map(record => [socialText(record.id), record] as const)
      .filter(([id]) => Boolean(id))).values()];
    // The latest active task reference wins when more than one is attached.
    const sources = [...input.referenceSources].sort((left, right) => (
      Date.parse(right.createdAt) - Date.parse(left.createdAt)
      || right.sourceId.localeCompare(left.sourceId)
    ));
    for (const source of sources) {
      for (const record of records) {
        const resolved = buildSocialTaskReferencePackage({
          record,
          source,
          themeId: input.themeId,
          verifiedContext: input.verifiedContext,
          planning: input.planning,
        });
        if (resolved) return resolved;
      }
    }
    const trackedButNotExact = sources.flatMap(source => {
      const identities = sourceReferenceIdentities(source);
      return records.filter(record => [...identities].some(identity => recordReferenceIdentities(record).has(identity)));
    })[0];
    if (trackedButNotExact) {
      void import('../routes/videos.js').then(module => module.queueExactSourceAnalysisForTenant({
        // Inspiration-center records may come from the shared catalog. Queue
        // the one-time Director analysis against the record's owning tenant;
        // subsequent customer tasks reuse the persisted exact script.
        tenantId: socialText(trackedButNotExact.tenantId) || input.tenantId,
        recordId: socialText(trackedButNotExact.id),
      })).catch(() => undefined);
    }
    const untracked = sources.find(source => {
      const identities = sourceReferenceIdentities(source);
      return !records.some(record => [...identities].some(identity => recordReferenceIdentities(record).has(identity)));
    });
    if (untracked && /^https?:\/\//i.test(untracked.sourceRef)) {
      // Do not block the beginner workflow on network collection. The task
      // keeps an explicit `analyzing` projection while the existing crawler
      // imports this exact URL and queues full-video analysis.
      void import('../routes/videos.js').then(async module => {
        const crawled = await module.crawlVideosForTenant({
          tenantId: input.tenantId,
          platform: module.inferPlatformFromUrl(untracked.sourceRef),
          keyword: untracked.sourceRef,
          limit: 1,
          disableBackfill: true,
          deferAnalysis: false,
        });
        const exactRecord = (crawled.items as Record<string, unknown>[]).find(item => (
          normalizedReferenceIdentity(item.sourceUrl) === normalizedReferenceIdentity(untracked.sourceRef)
        ));
        if (exactRecord?.id) {
          await module.queueExactSourceAnalysisForTenant({
            tenantId: input.tenantId,
            recordId: socialText(exactRecord.id),
          });
        }
      }).catch(() => undefined);
    }
    return null;
  } catch {
    return null;
  }
}

/** System-selected exact reference. This produces the same full public
 * analysis package, but deliberately omits `match.referenceSource` so it can
 * never be presented as a customer-confirmed choice. */
export async function resolveSocialRecommendedReferenceScript(input: {
  tenantId: string;
  themeId: SocialContentThemeId;
  verifiedContext: VerifiedSocialScriptContext;
  createdAt: string;
  planning?: ReferenceSemanticPlanning;
}): Promise<ResolvedSocialTaskReference | null> {
  try {
    const sharedTenantId = socialText(process.env.SOCIAL_SHARED_INSPIRATION_TENANT_ID)
      || 'demo-shared-video-pool';
    const tenantIds = [...new Set([input.tenantId, sharedTenantId].filter(Boolean))];
    const results = await Promise.allSettled(tenantIds.map(tenantId => store.list<Record<string, unknown>>('trend_videos', {
      where: { tenantId }, sort: '-crawledAt', page: 1, perPage: 300,
    })));
    const records = [...new Map(results.flatMap(result => result.status === 'fulfilled' ? result.value.items : [])
      .map(record => [socialText(record.id), record] as const)
      .filter(([id]) => Boolean(id))).values()];
    const match = matchSocialInspirationScript({ records, themeId: input.themeId, verifiedContext: input.verifiedContext });
    if (!match) return null;
    const record = records.find(item => socialText(item.id) === match.recordId);
    if (!record) return null;
    const sourceRef = socialText(record.sourceUrl) || socialText(record.url) || match.recordId;
    const resolved = buildSocialTaskReferencePackage({
      record,
      source: {
        sourceId: `system-reference:${match.recordId}`,
        sourceRef,
        sourceVersion: null,
        createdAt: input.createdAt,
      },
      themeId: input.themeId,
      verifiedContext: input.verifiedContext,
      planning: input.planning,
    });
    if (!resolved) return null;
    return {
      ...resolved,
      match: { ...resolved.match, title: '系统推荐参考视频分析', referenceSource: null },
      referenceVideoAnalysis: {
        ...resolved.referenceVideoAnalysis,
        rightsNotice: '这是系统推荐的结构参考，尚未被用户确认为指定参考，也不代表版权已经确认；系统只复刻镜头功能与节奏，不复制原视频文件、原文案、人物身份、品牌标识、水印或原声音频。',
      },
      replicationScript: {
        ...resolved.replicationScript,
        status: 'review_required',
      },
    };
  } catch {
    return null;
  }
}

export function parseStoredSocialReferenceVideoAnalysis(value: unknown): SocialReferenceVideoAnalysis | null {
  const raw = socialJson(value);
  if (raw === undefined || raw === null || raw === '') return null;
  const row = socialObject(raw);
  const status = socialText(row?.status);
  const shots = socialJson(row?.shots);
  const hook = row?.hookAnalysis === null ? null : socialObject(row?.hookAnalysis);
  if (!row || !socialText(row.analysisId) || !socialText(row.referenceSourceId)
    || !['analyzing', 'ready', 'blocked'].includes(status)
    || !Array.isArray(shots) || !socialText(row.rightsNotice) || !socialText(row.createdAt)
    || (status === 'ready' && (!shots.length || !hook))) {
    throw new SocialContentWorkflowError('social_reference_video_analysis_record_invalid', 503);
  }
  return structuredClone(row) as unknown as SocialReferenceVideoAnalysis;
}

export function parseStoredSocialReplicationScript(value: unknown): SocialReplicationScriptVersion | null {
  const raw = socialJson(value);
  if (raw === undefined || raw === null || raw === '') return null;
  const row = socialObject(raw);
  const hooks = socialJson(row?.hookOptions);
  const shots = socialJson(row?.shots);
  if (!row || !/^\d+$/.test(socialText(row.version)) || !socialText(row.referenceAnalysisId)
    || !['draft', 'review_required', 'confirmed', 'superseded'].includes(socialText(row.status))
    || !socialText(row.primaryHookId) || !Array.isArray(hooks) || hooks.length < 3
    || !Array.isArray(shots) || !shots.length || !socialText(row.structureFidelitySummary)
    || !socialText(row.originalityDifferenceSummary) || !socialText(row.createdAt)) {
    throw new SocialContentWorkflowError('social_replication_script_record_invalid', 503);
  }
  return structuredClone(row) as unknown as SocialReplicationScriptVersion;
}

export function parseStoredSocialShotMaterialMap(value: unknown): SocialShotMaterialMapEntry[] {
  const raw = socialJson(value);
  if (raw === undefined || raw === null || raw === '') return [];
  if (!Array.isArray(raw)) throw new SocialContentWorkflowError('social_shot_material_map_record_invalid', 503);
  return structuredClone(raw) as SocialShotMaterialMapEntry[];
}
