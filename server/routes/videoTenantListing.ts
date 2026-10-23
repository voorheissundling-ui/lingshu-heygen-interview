import type { DataStore } from '../storage/datastore.js';
import { isAutoSeededVideo, videoAnalysisOf } from '../lib/videoAnalysisCodec.js';
import { publicVideoRecord } from './videoPublicRecordProjection.js';
import { compareCrawledAtDesc, isDisplayableTestTenantVideo, isPublicImageRecord, isValidImagePostRecord, recordContentFormat, type ContentFormat } from './videoRecordVisibility.js';

/**
 * 列表搜索的统一匹配规则（标题 + 标签，大小写不敏感）。
 *
 * 搜索此前只在前端对已加载的那一页做过滤，用户以为是全局搜索，实际翻页之外的记录
 * 一律搜不到。改为服务端匹配后，两个列表接口共用同一套规则。
 */
export function matchesVideoSearch(record: Record<string, unknown>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (String(record.title || '').toLowerCase().includes(q)) return true;
  const rawTags = record.tags;
  const tags = Array.isArray(rawTags) ? rawTags : String(rawTags || '').split(/[,，\s]+/);
  return tags.some(tag => String(tag).toLowerCase().includes(q));
}

export function matchesCrawlRange(record: Record<string, unknown>, range?: string): boolean {
  if (!range || range === 'all') return true;
  const crawledAt = Date.parse(String(record.crawledAt || ''));
  if (!Number.isFinite(crawledAt)) return false;
  if (range === 'today') {
    const beijingNow = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const startUtc = Date.UTC(beijingNow.getUTCFullYear(), beijingNow.getUTCMonth(), beijingNow.getUTCDate()) - 8 * 60 * 60 * 1000;
    return crawledAt >= startUtc;
  }
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 0;
  return days > 0 ? crawledAt >= Date.now() - days * 24 * 60 * 60 * 1000 : true;
}

function publicMetricNumber(value: unknown): number {
  const text = String(value ?? '').trim().toLowerCase().replace(/,/g, '');
  const match = text.match(/([\d.]+)\s*([kmb万亿]?)/);
  if (!match) return 0;
  const scale = match[2] === 'k' ? 1_000 : match[2] === 'm' ? 1_000_000 : match[2] === 'b' ? 1_000_000_000 : match[2] === '万' ? 10_000 : match[2] === '亿' ? 100_000_000 : 1;
  return Number(match[1] || 0) * scale;
}

export function withImagePublicBaselines(items: Record<string, unknown>[], baselineUniverse: Record<string, unknown>[] = items): Record<string, unknown>[] {
  const toRow = (record: Record<string, unknown>) => {
    const analysis = videoAnalysisOf(record);
    const metrics = (analysis.publicMetrics && typeof analysis.publicMetrics === 'object' ? analysis.publicMetrics : {}) as Record<string, unknown>;
    const engagement = publicMetricNumber(metrics.likes) + publicMetricNumber(metrics.comments) + publicMetricNumber(metrics.shares);
    return { record, analysis, author: String(analysis.author || '').trim().toLowerCase(), engagement };
  };
  const rows = items.map(toRow);
  const universeRows = baselineUniverse.map(toRow);
  const groups = new Map<string, number[]>();
  for (const row of universeRows) {
    if (!row.author || row.engagement <= 0) continue;
    const recent = groups.get(row.author) || [];
    if (recent.length < 20) groups.set(row.author, [...recent, row.engagement]);
  }
  return rows.map(row => {
    const values = (groups.get(row.author) || []).sort((a, b) => a - b);
    const middle = values.length ? values[Math.floor(values.length / 2)]! : 0;
    const relative = middle > 0 ? Number((row.engagement / middle).toFixed(2)) : null;
    return publicVideoRecord({
      ...row.record,
      aiAnalysis: JSON.stringify({
        ...row.analysis,
        publicBaseline: {
          sampleSize: values.length,
          medianWeightedEngagement: middle || null,
          currentWeightedEngagement: row.engagement || null,
          relativeMultiple: relative,
          status: values.length >= 5 ? 'usable' : 'insufficient_sample',
          method: '同账号最近最多 20 条的公开互动总和（点赞+评论+分享）中位数',
        },
      }),
    });
  });
}

export function createVideoTenantListing(input: {
  store: DataStore;
  collection: string;
  isTestTenantId: (tenantId: string) => Promise<boolean>;
}) {
  const store = input.store;
  const COL = input.collection;
  const isTestTenantId = input.isTestTenantId;

function videoListWhere(tenantId: string, platform?: string, status?: string): Record<string, string> {
  const where: Record<string, string> = { tenantId };
  if (platform) where.platform = platform;
  if (status) where.status = status;
  return where;
}

const testTenantVisibleListCache = new Map<string, {
  expiresAt: number;
  items: Record<string, unknown>[];
}>();

async function listPublicVideosForTenant(input: {
  tenantId: string;
  page: number;
  perPage: number;
  platform?: string;
  status?: string;
  contentFormat?: ContentFormat;
  search?: string;
  crawlRange?: string;
}): Promise<{
  items: Record<string, unknown>[];
  totalItems: number;
  totalPages: number;
  page: number;
  perPage: number;
}> {
  const where = videoListWhere(input.tenantId, input.platform, input.status);
  const contentFormat = input.contentFormat || 'video';
  const testTenant = await isTestTenantId(input.tenantId);
  if (contentFormat === 'image') {
    if (input.search?.trim() || (input.crawlRange && input.crawlRange !== 'all')) {
      const scanned = await scanRecordsByContentFormat(where, 'image');
      const matched = scanned
        .filter(isPublicImageRecord)
        .filter(record => matchesCrawlRange(record, input.crawlRange))
        .filter(record => !input.search?.trim() || matchesVideoSearch(record, input.search));
      const start = (input.page - 1) * input.perPage;
      return { items: matched.slice(start, start + input.perPage).map(record => publicVideoRecord(record)), totalItems: matched.length, totalPages: Math.max(1, Math.ceil(matched.length / input.perPage)), page: input.page, perPage: input.perPage };
    }
    const result = await store.list<Record<string, unknown>>(COL, {
      where: { ...where, contentFormat: 'image' },
      sort: '-crawledAt',
      page: input.page,
      perPage: input.perPage,
    });
    const seenSourceUrls = new Set<string>();
    const items = result.items
      .filter(record => !isAutoSeededVideo(record) && isPublicImageRecord(record))
      .filter(record => {
        const sourceUrl = String(record.sourceUrl || '').trim();
        if (sourceUrl && seenSourceUrls.has(sourceUrl)) return false;
        if (sourceUrl) seenSourceUrls.add(sourceUrl);
        return true;
      })
      .map(record => publicVideoRecord(record));
    return { ...result, items };
  }
  if (!testTenant) {
    // 存储层的 where 只支持等值匹配，做不了标题子串检索；有搜索词时全量扫描后再分页。
    if (input.search?.trim() || (input.crawlRange && input.crawlRange !== 'all')) {
      const scanned = await scanRecordsByContentFormat({ ...where, contentFormat: 'video' }, 'video');
      const matched = scanned
        .filter(record => matchesCrawlRange(record, input.crawlRange))
        .filter(record => !input.search?.trim() || matchesVideoSearch(record, input.search));
      const start = (input.page - 1) * input.perPage;
      return {
        items: matched.slice(start, start + input.perPage).map(record => publicVideoRecord(record)),
        totalItems: matched.length,
        totalPages: Math.max(1, Math.ceil(matched.length / input.perPage)),
        page: input.page,
        perPage: input.perPage,
      };
    }
    const result = await store.list<Record<string, unknown>>(COL, {
      where: { ...where, contentFormat: 'video' },
      sort: '-crawledAt',
      page: input.page,
      perPage: input.perPage,
    });
    const items = result.items.filter(record => !isAutoSeededVideo(record));
    return { ...result, items: items.map(record => publicVideoRecord(record)) };
  }

  const visible: Record<string, unknown>[] = [];
  const seenSourceUrls = new Set<string>();
  const cacheKey = JSON.stringify([input.tenantId, input.platform || '', input.status || '', 'video']);
  const scanTenantVideos = async () => {
    visible.length = 0;
    seenSourceUrls.clear();
    const cached = testTenantVisibleListCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      visible.push(...cached.items);
      return;
    }
    let scanPage = 1;
    let totalPages = 1;
    do {
      const result = await store.list<Record<string, unknown>>(COL, {
        where: { ...where, contentFormat: 'video' },
        sort: '-crawledAt',
        page: scanPage,
        perPage: 100,
      });
      for (const record of result.items) {
        if (isAutoSeededVideo(record)) continue;
        if (!isDisplayableTestTenantVideo(record)) continue;
        const sourceUrl = String(record.sourceUrl || '').trim();
        if (sourceUrl && seenSourceUrls.has(sourceUrl)) continue;
        if (sourceUrl) seenSourceUrls.add(sourceUrl);
        visible.push(publicVideoRecord(record));
      }
      totalPages = result.totalPages || 1;
      scanPage += 1;
    } while (scanPage <= totalPages && scanPage <= 50);
    testTenantVisibleListCache.set(cacheKey, {
      expiresAt: Date.now() + 12_000,
      items: [...visible],
    });
  };

  await scanTenantVideos();
  // PocketBase and the local fallback do not always return identical ordering.
  // Sort after the full scan so today's crawl results consistently land first.
  visible.sort(compareCrawledAtDesc);
  const ranged = visible.filter(record => matchesCrawlRange(record, input.crawlRange));
  const searched = input.search?.trim() ? ranged.filter(record => matchesVideoSearch(record, input.search!)) : ranged;
  const totalItems = searched.length;
  const totalVisiblePages = Math.max(1, Math.ceil(totalItems / input.perPage));
  const start = (input.page - 1) * input.perPage;
  return {
    items: searched.slice(start, start + input.perPage),
    totalItems,
    totalPages: totalVisiblePages,
    page: input.page,
    perPage: input.perPage,
  };
}

async function scanRecordsByContentFormat(where: Record<string, string> | undefined, contentFormat: ContentFormat): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  const seenSourceUrls = new Set<string>();
  let page = 1;
  let totalPages = 1;
  do {
    const result = await store.list<Record<string, unknown>>(COL, {
      where,
      sort: '-crawledAt',
      page,
      perPage: 100,
    });
    for (const record of result.items) {
      if (isAutoSeededVideo(record)) continue;
      if (recordContentFormat(record) !== contentFormat) continue;
      if (contentFormat === 'image' && !isValidImagePostRecord(record)) continue;
      const sourceUrl = String(record.sourceUrl || '').trim();
      if (sourceUrl && seenSourceUrls.has(sourceUrl)) continue;
      if (sourceUrl) seenSourceUrls.add(sourceUrl);
      out.push(record);
    }
    totalPages = result.totalPages || 1;
    page += 1;
  } while (page <= totalPages && page <= 50);
  return out;
}

async function tenantInventoryTotal(tenantId: string, contentFormat: ContentFormat): Promise<number> {
  const imageInventory = await store.list<Record<string, unknown>>(COL, {
    where: { tenantId, contentFormat: 'image' },
    page: 1,
    perPage: 1,
  });
  if (contentFormat === 'image') return imageInventory.totalItems;
  // Legacy crawled videos predate the contentFormat column. Count them as
  // video by subtracting the explicit image inventory from all tenant records.
  const allInventory = await store.list<Record<string, unknown>>(COL, {
    where: { tenantId },
    page: 1,
    perPage: 1,
  });
  return Math.max(0, allInventory.totalItems - imageInventory.totalItems);
}

  return {
    listPublicVideosForTenant,
    tenantInventoryTotal,
    clearTenantVisibleListCache: () => testTenantVisibleListCache.clear(),
  };
}
