import { validTimeZone } from './continuationPolicy.js';
import { store } from '../storage/index.js';
import { currentDataAuthority } from '../storage/dataAuthority.js';
import type { PublishingPlatform, PublishingTarget } from './domain.js';

interface SocialAccountRecord {
  id: string;
  tenantId: string;
  platform: Exclude<PublishingPlatform, 'youtube'>;
  title?: string;
  handle?: string;
  status?: string;
}

interface YouTubeAccountRecord {
  id: string;
  tenantId: string;
  channelTitle?: string;
  customUrl?: string;
  status?: string;
}

export interface ConnectedPublishingAccount extends PublishingTarget {
  status: 'connected';
}

const text = (value: unknown): string => String(value ?? '').trim();

export function localPublishingAccountMocksEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  // Local preview is also used for real end-to-end production rehearsals. It
  // must not silently fabricate connected publishing accounts, otherwise the
  // weekly preflight passes and the workflow only fails at the release gate.
  // Tests/demos that intentionally need placeholders must opt in explicitly.
  return env.LINGSHU_LOCAL_PUBLISHING_ACCOUNT_MOCKS === '1'
    && (currentDataAuthority() === 'local' || env.LINGSHU_LOCAL_PREVIEW === '1');
}

export async function listConnectedPublishingAccounts(tenantId: string, companyName = ''): Promise<ConnectedPublishingAccount[]> {
  const [social, youtube] = await Promise.all([
    store.list<SocialAccountRecord>('social_accounts', { where: { tenantId }, perPage: 200 }),
    store.list<YouTubeAccountRecord>('youtube_accounts', { where: { tenantId }, perPage: 200 }),
  ]);
  const connected: ConnectedPublishingAccount[] = [
    ...social.items
      .filter(account => account.status === 'connected' && ['facebook', 'instagram', 'tiktok', 'linkedin'].includes(account.platform))
      .map(account => ({
        platform: account.platform,
        accountId: account.id,
        accountLabel: text(account.title) || text(account.handle) || account.id,
        status: 'connected' as const,
      })),
    ...youtube.items
      .filter(account => account.status === 'connected')
      .map(account => ({
        platform: 'youtube' as const,
        accountId: account.id,
        accountLabel: text(account.channelTitle) || text(account.customUrl) || account.id,
        status: 'connected' as const,
      })),
  ];
  if (!localPublishingAccountMocksEnabled()) return connected;
  const localLabel = text(companyName) || '本地演示企业';
  for (const platform of ['youtube', 'tiktok', 'instagram', 'facebook', 'linkedin'] as const) {
    if (connected.some(account => account.platform === platform)) continue;
    connected.push({
      platform,
      accountId: `local-${platform}-${tenantId}`,
      accountLabel: localLabel,
      status: 'connected',
    });
  }
  return connected;
}

/**
 * Never trust labels or platform names posted by the browser. Every target is
 * re-bound to a currently connected account owned by the authenticated tenant.
 */
export async function bindPublishingTargets(
  tenantId: string,
  requested: PublishingTarget[],
): Promise<{ targets: PublishingTarget[]; invalidAccountIds: string[] }> {
  const connected = await listConnectedPublishingAccounts(tenantId);
  const byId = new Map(connected.map(account => [account.accountId, account]));
  const invalidAccountIds: string[] = [];
  const targets: PublishingTarget[] = [];
  for (const requestedTarget of requested) {
    const account = byId.get(text(requestedTarget.accountId));
    if (!account || account.platform !== requestedTarget.platform) {
      invalidAccountIds.push(text(requestedTarget.accountId));
      continue;
    }
    if (!targets.some(target => target.platform === account.platform && target.accountId === account.accountId)) {
      if (requestedTarget.timezone && !validTimeZone(requestedTarget.timezone)) throw new Error('invalid_publishing_timezone');
      targets.push({
        platform: account.platform,
        accountId: account.accountId,
        accountLabel: account.accountLabel,
        ...(requestedTarget.timezone ? { timezone: requestedTarget.timezone } : {}),
        ...(Number.isInteger(requestedTarget.weeklyCount) && Number(requestedTarget.weeklyCount) >= 0 && Number(requestedTarget.weeklyCount) <= 30
          ? { weeklyCount: Number(requestedTarget.weeklyCount) }
          : {}),
      });
    }
  }
  return { targets, invalidAccountIds: invalidAccountIds.filter(Boolean) };
}

export function publishingTargetPlatforms(targets: PublishingTarget[]): PublishingPlatform[] {
  return [...new Set(targets.map(target => target.platform))];
}
