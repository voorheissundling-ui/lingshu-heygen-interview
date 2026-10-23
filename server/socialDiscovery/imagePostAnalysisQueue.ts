import { randomUUID } from 'node:crypto';
import type { DataStore } from '../storage/datastore.js';
import { dataBackend } from '../storage/index.js';
import { runWithDataAuthority } from '../storage/dataAuthority.js';
import { localFallbacksEnabled } from '../lib/localFallbackPolicy.js';
import { acquireDurableOperationLease, assertDurableOperationLease, releaseDurableOperationLease } from '../runtime/durableLease.js';
import { serializeImagePostAnalysis, videoAnalysisOf } from '../lib/videoAnalysisCodec.js';
import type { ImagePostEvidenceAnalysis } from '../agents/qwenContracts.js';
import type { CrawledImagePost } from './imagePostEvidenceAnalysis.js';
import { imagePostSourceHash } from './imagePostReanalysis.js';
import { imagePostAtomicLeaseAvailable } from './imagePostLeaseCapability.js';

type AnalysisResult = { status: 'analyzed' | 'failed'; analysis?: ImagePostEvidenceAnalysis;
  error?: string; provider?: 'qwen' | 'gemini'; providerAttempted?: boolean };
type QueuePayload = { item: CrawledImagePost; keyword: string; sourceHash: string };
const QUEUE_STATE = 'imageAnalysisQueueState';
const QUEUE_INPUT = 'imageAnalysisQueueInput';

function payloadOf(value: unknown): QueuePayload | null {
  if (!value || typeof value !== 'object') return null;
  const payload = value as Partial<QueuePayload>;
  if (!payload.item || typeof payload.item !== 'object' || typeof payload.item.sourceUrl !== 'string'
    || typeof payload.keyword !== 'string' || !/^[a-f0-9]{64}$/.test(String(payload.sourceHash || ''))) return null;
  return payload as QueuePayload;
}

/** Only queued work can be picked after restart. A started attempt is never auto-replayed. */
export function createImagePostAnalysisQueue(input: {
  store: DataStore;
  collection: string;
  analyze(item: CrawledImagePost, keyword: string): Promise<AnalysisResult>;
  leaseAvailable?: () => Promise<boolean>;
}) {
  const { store, collection } = input;
  const leaseAvailable = input.leaseAvailable || (() => imagePostAtomicLeaseAvailable(store));

  async function queue(recordId: string, item: CrawledImagePost, keyword: string): Promise<void> {
    const record = await store.getById<Record<string, unknown>>(collection, recordId);
    if (!record || !String(record.tenantId || '') || record.sourceUrl !== item.sourceUrl
      || record.contentFormat !== 'image') throw Error('image_post_queue_source_invalid');
    const analysis = videoAnalysisOf(record);
    if (['processing', 'unknown'].includes(String(analysis[QUEUE_STATE] || ''))) {
      throw Error('image_post_queue_requires_reconciliation');
    }
    const payload: QueuePayload = { item: structuredClone(item), keyword, sourceHash: imagePostSourceHash(record) };
    if (!await store.update(collection, recordId, {
      status: 'pending', aiAnalysis: serializeImagePostAnalysis({ ...analysis,
        imageAnalysisStatus: 'queued', [QUEUE_STATE]: 'queued', [QUEUE_INPUT]: payload,
        imageAnalysisQueuedAt: new Date().toISOString(), imageAnalysisError: undefined,
      }),
    })) throw Error('image_post_queue_persistence_failed');
  }

  async function runOne(record: Record<string, unknown>): Promise<'completed' | 'failed' | 'unknown' | 'skipped'> {
    const tenantId = String(record.tenantId || '');
    const recordId = String(record.id || '');
    if (!tenantId || !recordId) return 'skipped';
    const lease = await acquireDurableOperationLease({ dataStore: store, tenantId,
      scope: 'image-post-analysis', subjectId: recordId, ownerId: randomUUID(), leaseDurationMs: 2 * 60 * 60_000 });
    if (!lease) return 'skipped';
    let started = false;
    try {
      const latest = await store.getById<Record<string, unknown>>(collection, recordId);
      if (!latest || latest.tenantId !== tenantId || latest.contentFormat !== 'image') return 'skipped';
      const analysis = videoAnalysisOf(latest);
      const payload = payloadOf(analysis[QUEUE_INPUT]);
      if (analysis[QUEUE_STATE] !== 'queued' || !payload) return 'skipped';
      if (payload.item.sourceUrl !== latest.sourceUrl || payload.sourceHash !== imagePostSourceHash(latest)) {
        if (!await store.update(collection, recordId, { status: 'failed',
          aiAnalysis: serializeImagePostAnalysis({ ...analysis, imageAnalysisStatus: 'failed',
            [QUEUE_STATE]: 'source_changed', imageAnalysisError: 'image_post_queue_source_changed' }) })) {
          throw Error('image_post_queue_source_change_persistence_failed');
        }
        return 'failed';
      }
      const attemptId = randomUUID();
      if (!await store.update(collection, recordId, { status: 'pending',
        aiAnalysis: serializeImagePostAnalysis({ ...analysis, imageAnalysisStatus: 'processing',
          [QUEUE_STATE]: 'processing', imageAnalysisAttemptId: attemptId,
          imageAnalysisStartedAt: new Date().toISOString() }) })) {
        throw Error('image_post_queue_start_persistence_failed');
      }
      started = true;
      const output = await input.analyze(payload.item, payload.keyword);
      if (output.status === 'failed' && output.providerAttempted) {
        throw Error('image_post_queue_provider_result_unknown');
      }
      await assertDurableOperationLease({ dataStore: store, lease });
      const after = await store.getById<Record<string, unknown>>(collection, recordId);
      if (!after || after.tenantId !== tenantId) throw Error('image_post_queue_record_disappeared');
      const current = videoAnalysisOf(after);
      if (current.imageAnalysisAttemptId !== attemptId || payload.sourceHash !== imagePostSourceHash(after)) {
        throw Error('image_post_queue_result_superseded');
      }
      if (!await store.update(collection, recordId, { status: output.status,
        aiAnalysis: serializeImagePostAnalysis({ ...current,
          imageEvidence: output.analysis || current.imageEvidence,
          imageAnalysisStatus: output.status, imageAnalysisError: output.error,
          [QUEUE_STATE]: output.status === 'analyzed' ? 'completed' : 'failed',
          analysisSource: output.status === 'analyzed' ? `${output.provider || 'qwen'}-image-evidence-v2` : 'image-metadata',
          analysisQuality: output.status === 'analyzed' ? 'image' : 'metadata',
          imageAnalysisCompletedAt: new Date().toISOString(),
        }) })) throw Error('image_post_queue_result_persistence_failed');
      return output.status === 'analyzed' ? 'completed' : 'failed';
    } catch (error) {
      if (started) {
        const latest = await store.getById<Record<string, unknown>>(collection, recordId).catch(() => null);
        if (latest?.tenantId === tenantId) {
          const analysis = videoAnalysisOf(latest);
          if (analysis[QUEUE_STATE] === 'processing'
            && payloadOf(analysis[QUEUE_INPUT])?.sourceHash === imagePostSourceHash(latest)) {
            await store.update(collection, recordId, { status: 'pending',
              aiAnalysis: serializeImagePostAnalysis({ ...analysis, imageAnalysisStatus: 'unknown',
                [QUEUE_STATE]: 'unknown', imageAnalysisError: 'image_post_queue_result_unknown' }) }).catch(() => false);
          }
        }
      }
      console.warn('[image-post-analysis] attempt needs reconciliation:', error instanceof Error ? error.message : error);
      return 'unknown';
    } finally {
      await releaseDurableOperationLease({ dataStore: store, lease }).catch(error => {
        console.error('[image-post-analysis] lease release failed:', error);
      });
    }
  }

  async function runOnce(): Promise<{ available: boolean; picked: number; completed: number; failed: number; unknown: number }> {
    if (!await leaseAvailable()) return { available: false, picked: 0, completed: 0, failed: 0, unknown: 0 };
    let picked = 0, completed = 0, failed = 0, unknown = 0;
    for (let page = 1; page <= 20 && picked < 10; page += 1) {
      const rows = await store.list<Record<string, unknown>>(collection, {
        where: { contentFormat: 'image', status: 'pending' }, page, perPage: 100,
      });
      for (const record of rows.items) {
        if (videoAnalysisOf(record)[QUEUE_STATE] !== 'queued') continue;
        picked++;
        const outcome = await runOne(record);
        if (outcome === 'completed') completed++;
        if (outcome === 'failed') failed++;
        if (outcome === 'unknown') unknown++;
        if (picked >= 10) break;
      }
      if (page >= rows.totalPages) break;
    }
    return { available: true, picked, completed, failed, unknown };
  }
  return { queue, runOnce };
}

export function startImagePostAnalysisWorker(queue: ReturnType<typeof createImagePostAnalysisQueue>): () => void {
  let active = false;
  const tick = async () => {
    if (active) return;
    active = true;
    try {
      const remote = await runWithDataAuthority('pocketbase', () => queue.runOnce());
      if (remote.picked || !remote.available) console.log('[image-post-analysis] remote queue:', remote);
      if (dataBackend === 'pocketbase' && localFallbacksEnabled()) {
        const local = await runWithDataAuthority('local', () => queue.runOnce());
        if (local.picked) console.log('[image-post-analysis] local queue:', local);
      }
    } catch (error) { console.warn('[image-post-analysis] queue scan failed:', error); }
    finally { active = false; }
  };
  const timer = setInterval(() => { void tick(); }, 30_000);
  timer.unref?.();
  void tick();
  return () => clearInterval(timer);
}
