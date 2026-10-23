import {normalizeSocialChannelId} from '../../shared/contracts/socialChannels.js';
import type { DataStore } from '../storage/datastore.js';
import type { OwnedSocialAccount, WeeklyDirectorPlanningAnalysis } from '../../shared/contracts/socialProgram.js';
import type { SocialDiscoverySupplyItem } from '../../shared/contracts/socialContentWorkflow.js';
import { SocialProgramError } from './service.js';

const object = (value: unknown): Record<string, any> | null => {
  if (typeof value === 'string') { try { return JSON.parse(value); } catch { return null; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null;
};
function url(value: unknown): string | null {
  try { const parsed = new URL(String(value)); if (!['https:','http:'].includes(parsed.protocol)) return null; parsed.hash=''; return parsed.toString(); } catch { return null; }
}

async function allRows(dataStore: DataStore, collection: string, where: Record<string, string>) {
  const items: any[] = [];
  const ids = new Set<string>();
  for (let page = 1; ; page++) {
    const result = await dataStore.list<any>(collection, { where, sort: 'id', perPage: 500, page });
    for (const row of result.items) {
      if (ids.has(row.id)) throw new SocialProgramError('owned_reference_scan_changed', 409, '历史数据读取期间发生变化，请刷新后重新分析。');
      ids.add(row.id); items.push(row);
    }
    if (items.length >= result.totalItems) return { items, totalItems: items.length };
    if (!result.items.length) throw new SocialProgramError('owned_reference_scan_truncated', 409, '历史数据读取不完整，请重试后再分配来源。');
  }
}

export function ownedReferenceChannelId(platform: string){return platform==='douyin'?'douyin_cn':normalizeSocialChannelId(platform);}

/** Only exact owned account IDs or explicitly bound connection IDs establish ownership. */
export async function ownedReferenceSupply(dataStore: DataStore, tenantId: string, programId: string, videos: SocialDiscoverySupplyItem[], now = new Date()) {
  const [accounts, contents, metrics] = await Promise.all([
    allRows(dataStore, 'social_owned_accounts', { tenant_id: tenantId, program_id: programId }),
    allRows(dataStore, 'social_external_contents', { tenant_id: tenantId }),
    allRows(dataStore, 'social_channel_metric_snapshots', { tenant_id: tenantId }),
  ]);
  if ([accounts, contents, metrics].some(result => result.totalItems > result.items.length)) throw new SocialProgramError('owned_reference_scan_truncated', 409, '历史视频供给超出读取范围，需分页核验后才能分配来源。');
  const owned = accounts.items.map(row => object(row.payload) as unknown as OwnedSocialAccount).filter(account => account?.programId === programId && Number.isSafeInteger(account.version) && account.version > 0);
  const supply=videos.flatMap(video => {
    const source = url(video.sourceUrl);
    if (!source) return [];
    const matches = contents.items.flatMap(row => {
      const content = object(row.content);
      if (row.tenant_id !== tenantId || content?.tenantId !== tenantId || content.status !== 'published'
        || content.accountId !== row.account_id || content.channelId !== row.channel_id || content.externalContentId !== row.external_content_id
        || url(content.publicUrl) !== source) return [];
      return owned.filter(account => account.platform === video.platform && ownedReferenceChannelId(account.platform)!==null && ownedReferenceChannelId(account.platform) === ownedReferenceChannelId(String(content.channelId))
        && (account.accountId === content.accountId || account.connectionId === content.accountId))
        .map(account => {
          const snapshots = metrics.items.flatMap(metricRow => {
            const snapshot = object(metricRow.snapshot);
            if (metricRow.tenant_id !== tenantId || snapshot?.tenantId !== tenantId || snapshot.snapshotId !== metricRow.snapshot_id
              || snapshot.accountId !== content.accountId || snapshot.channelId !== content.channelId || snapshot.externalContentId !== content.externalContentId
              || snapshot.accountId !== metricRow.account_id || snapshot.channelId !== metricRow.channel_id || snapshot.externalContentId !== metricRow.external_content_id
              || !Number.isFinite(Date.parse(snapshot.capturedAt)) || Date.parse(snapshot.capturedAt) > now.getTime()) return [];
            return [snapshot];
          }).sort((a,b) => Date.parse(b.capturedAt)-Date.parse(a.capturedAt));
          const snapshot = snapshots[0];
          const value = (key: string) => typeof snapshot?.metrics?.[key] === 'number' && Number.isFinite(snapshot.metrics[key]) && snapshot.metrics[key] >= 0 ? snapshot.metrics[key] as number : null;
          const historicalPerformance: WeeklyDirectorPlanningAnalysis['historicalPerformance'] = snapshot ? {
            snapshotRef: { type: 'social_channel_metric_snapshot', id: snapshot.snapshotId, version: 1 }, capturedAt: snapshot.capturedAt, source: String(snapshot.source || 'unknown'),
            metrics: { views: value('views'), likes: value('likes'), shares: value('shares'), comments: value('comments') },
          } : null;
          return { video, account, evidenceRef: `owned_content:${row.id}`, externalContentId: content.externalContentId, historicalPerformance };
        });
    });
    const identities = new Set(matches.map(match => match.account.accountId));
    if (identities.size > 1) throw new SocialProgramError('owned_reference_account_ambiguous', 409, '历史视频对应多个经营账号，需确认归属后再排期。');
    return matches.length ? [matches[0]!] : [];
  });
  // Complete real platform observations take precedence over discovery scores or row order.
  // Incomplete history remains visible as an explicit gap when no measured reference exists.
  const measured=(pair:typeof supply[number])=>{const p=pair.historicalPerformance;return p&&p.source.trim()&&!/^(?:unknown|mock|simulated|demo|fixture)$/i.test(p.source)&&(['views','likes','shares','comments'] as const).every(key=>typeof p.metrics[key]==='number'&&Number.isFinite(p.metrics[key])&&p.metrics[key]!>=0)?p.metrics:null;};
  return supply.sort((a,b)=>{const first=measured(a),second=measured(b);if(Boolean(first)!==Boolean(second))return first?-1:1;if(first&&second){for(const key of ['views','shares','comments','likes'] as const){const difference=second[key]!-first[key]!;if(difference)return difference;}}return a.video.candidateId.localeCompare(b.video.candidateId);});
}
