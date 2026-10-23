import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireDurableOperationLease,
  assertDurableOperationLease,
  releaseDurableOperationLease,
  renewDurableOperationLease,
  type DurableOperationLease,
} from '../runtime/durableLease.js';
import { externalEffectLeaseStore } from '../runtime/externalEffectLeaseStore.js';
import type { DataStore } from '../storage/datastore.js';
import { store } from '../storage/index.js';
import type { PostRecord } from './waLink.js';

export const DIRECT_PUBLISH_LEASE_SCOPE = 'direct-publish';
const DIRECT_PUBLISH_BUSY_MESSAGE = '该内容正在发布或存在待核对操作，禁止重复提交，请稍后重试';

export interface DirectPublishingLeaseGuard {
  beforeEffect(now?: Date): Promise<void>;
}

export class DirectPublishingLeaseError extends Error {
  readonly statusCode: 409 | 503;

  constructor(readonly code: 'direct_publish_busy' | 'direct_publish_lock_unavailable') {
    super(code === 'direct_publish_busy' ? DIRECT_PUBLISH_BUSY_MESSAGE : '发布安全锁不可用，尚未调用平台');
    this.name = 'DirectPublishingLeaseError';
    this.statusCode = code === 'direct_publish_busy' ? 409 : 503;
  }
}

export interface DirectPublishingLeaseDependencies {
  dataStore?: DataStore;
  ownerId?: string;
  now?: () => Date;
  leaseDurationMs?: number;
  reclaimGraceMs?: number;
}

function directPublishLeaseDurationMs(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(Math.max(Math.floor(parsed), 30_000), 2 * 60 * 60_000)
    : 30 * 60_000;
}

export function directPublishingContentFingerprint(input: {
  contentId?: string;
  videoPath?: string;
  videoUrl?: string;
}): string {
  const resolvedPath = file(input.videoPath);
  let source = '';
  if (String(input.contentId || '').trim()) {
    source = `content:${String(input.contentId).trim()}`;
  } else if (resolvedPath) {
    try {
      const stat = fs.statSync(resolvedPath);
      source = `file:${resolvedPath}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      source = `file:${resolvedPath}`;
    }
  } else if (String(input.videoUrl || '').trim()) {
    source = `url:${String(input.videoUrl).trim()}`;
  } else source = 'missing-source';
  return createHash('sha256').update(source).digest('hex');
}

export function directPublishingLeaseSubject(input: {
  platform: string;
  accountId: string;
  contentFingerprint: string;
}): string {
  return createHash('sha256').update(JSON.stringify([
    input.platform.trim().toLowerCase(),
    input.accountId.trim(),
    input.contentFingerprint,
  ])).digest('hex');
}

/** Serialize one real direct delivery across processes and fence each provider call. */
export async function withDirectPublishingLease<T>(
  input: {
    tenantId: string;
    platform: string;
    accountId: string;
    contentId?: string;
    videoPath?: string;
    videoUrl?: string;
  },
  action: (guard: DirectPublishingLeaseGuard) => Promise<T>,
  dependencies: DirectPublishingLeaseDependencies = {},
): Promise<T> {
  const dataStore = dependencies.dataStore ?? externalEffectLeaseStore;
  const now = dependencies.now ?? (() => new Date());
  const leaseDurationMs = directPublishLeaseDurationMs(
    dependencies.leaseDurationMs ?? process.env.DIRECT_PUBLISH_LEASE_MS,
  );
  let lease: DurableOperationLease | null = null;
  try {
    try {
      lease = await acquireDurableOperationLease({
        dataStore,
        tenantId: input.tenantId,
        scope: DIRECT_PUBLISH_LEASE_SCOPE,
        subjectId: directPublishingLeaseSubject({
          platform: input.platform,
          accountId: input.accountId,
          contentFingerprint: directPublishingContentFingerprint(input),
        }),
        ownerId: dependencies.ownerId ?? `direct-publish:${process.pid}:${randomUUID()}`,
        now: now(),
        leaseDurationMs,
        reclaimGraceMs: dependencies.reclaimGraceMs ?? 30_000,
      });
    } catch {
      throw new DirectPublishingLeaseError('direct_publish_lock_unavailable');
    }
    if (!lease) throw new DirectPublishingLeaseError('direct_publish_busy');
    const guard: DirectPublishingLeaseGuard = {
      async beforeEffect(effectNow = now()) {
        try {
          lease = await renewDurableOperationLease({ dataStore, lease: lease!, now: effectNow, leaseDurationMs });
          await assertDurableOperationLease({
            dataStore,
            lease,
            now: effectNow,
            minimumRemainingMs: Math.min(30_000, Math.max(1_000, Math.floor(leaseDurationMs / 3))),
          });
        } catch {
          throw new DirectPublishingLeaseError('direct_publish_lock_unavailable');
        }
      },
    };
    return await action(guard);
  } finally {
    if (lease) {
      try {
        await releaseDurableOperationLease({ dataStore, lease });
      } catch {
        // A bounded unresolved lease is safer than converting an ambiguous
        // provider outcome into a retryable request.
      }
    }
  }
}

const object = (value: unknown): Record<string, any> => {
  if (typeof value === 'string') { try { return object(JSON.parse(value)); } catch { return {}; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
};
export function publishingMutationBlocked(post: PostRecord): boolean {
  const stats = object(post.stats);
  return ['publishing', 'provider_processing', 'needs_attention', 'finalize_pending'].includes(String(stats.status))
    || Object.values(object(stats.publishResults)).some((result: any) => ['in_flight', 'provider_accepted', 'unknown'].includes(result.status));
}
function file(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  try { return value.startsWith('file://') ? fileURLToPath(value) : path.resolve(value); } catch { return value; }
}
/** Guards manual/duplicate submissions against an already unresolved delivery.
 * The current scheduler may enter only with its server-created attempt token. */
export async function assertNoUnresolvedPublishing(input: {
  tenantId: string; platform: string; accountIds: string[]; contentId?: string; videoPath?: string; videoUrl?: string;
  currentPostId?: string; currentAttemptId?: string;
}): Promise<void> {
  for (let page = 1; ; page++) {
    const posts = await store.list<PostRecord>('posts', { where: { tenant_id: input.tenantId }, page, perPage: 500 });
    for (const post of posts.items) {
      if (post.tenant_id !== input.tenantId || post.platform !== input.platform || !publishingMutationBlocked(post)) continue;
      const stats = object(post.stats), results = object(stats.publishResults);
      const sameSource = (input.contentId && input.contentId === post.content_id)
        || (input.videoPath && file(input.videoPath) === file(stats.videoPath))
        || (input.videoUrl && input.videoUrl === stats.videoUrl);
      if (!sameSource && input.currentPostId !== post.id) continue;
      const targets = Array.isArray(stats.targetAccountIds) ? stats.targetAccountIds.map(String) : Object.keys(results);
      if (input.accountIds.length && targets.length && !targets.some((id: string) => input.accountIds.includes(id))) continue;
      if (input.currentPostId === post.id && input.currentAttemptId && input.accountIds.length === 1
        && results[input.accountIds[0]]?.status === 'in_flight' && results[input.accountIds[0]]?.attemptId === input.currentAttemptId) continue;
      throw Object.assign(new Error('该视频已有待核对的发布尝试，请先恢复平台回执，禁止重复提交'), { statusCode: 409 });
    }
    if (!posts.items.length || page >= posts.totalPages) return;
  }
}
