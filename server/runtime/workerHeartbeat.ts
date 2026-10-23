import {weeklyExecutionObservation} from './weeklyExecutionObservation.js';
import { randomUUID } from 'node:crypto';
import type { DataStore } from '../storage/datastore.js';
import { store } from '../storage/index.js';
import type { ProcessRole } from './processRole.js';
import { runtimeBuildInfo } from './buildInfo.js';
import { completeWeeklyProductionRuntimeProbes } from '../socialPrograms/weeklyProductionRuntimeProbe.js';

export const SOCIAL_OPERATING_WORKER_HEARTBEATS = 'social_operating_worker_heartbeats';

export type BackgroundJobState = 'idle' | 'starting' | 'ready' | 'failed';

export interface BackgroundJobRuntimeState {
  state: BackgroundJobState;
  instanceId: string;
  startedAt: string | null;
  readyAt: string | null;
  error: string | null;
}

const instanceId = `worker-${process.pid}-${randomUUID()}`;
let runtimeState: BackgroundJobRuntimeState = {
  state: 'idle', instanceId, startedAt: null, readyAt: null, error: null,
};
let heartbeatRecordId = '';
let heartbeatTimer: NodeJS.Timeout | null = null;

export function backgroundJobRuntimeState(): BackgroundJobRuntimeState {
  return { ...runtimeState };
}

export function markBackgroundJobsStarting(now = new Date()): void {
  runtimeState = { state: 'starting', instanceId, startedAt: now.toISOString(), readyAt: null, error: null };
}

export function markBackgroundJobsReady(now = new Date()): void {
  runtimeState = { ...runtimeState, state: 'ready', readyAt: now.toISOString(), error: null };
}

export function markBackgroundJobsFailed(error: unknown): void {
  runtimeState = {
    ...runtimeState,
    state: 'failed',
    error: error instanceof Error && error.message.trim() ? error.message.trim().slice(0, 500) : 'unknown',
  };
}

export async function writeWorkerHeartbeat(
  role: ProcessRole,
  dataStore: DataStore = store,
  now = new Date(),
): Promise<void> {
  if (!runtimeState.startedAt) markBackgroundJobsStarting(now);
  const payload = {
    instance_id: instanceId,
    role,
    state: runtimeState.state,
    started_at: runtimeState.startedAt,
    last_seen_at: now.toISOString(),
    details: {
      readyAt: runtimeState.readyAt,
      error: runtimeState.error,
      pid: process.pid,
      build: runtimeBuildInfo(),
      weeklyExecution:weeklyExecutionObservation.read(),
    },
  };
  if (heartbeatRecordId) {
    if (await dataStore.update(SOCIAL_OPERATING_WORKER_HEARTBEATS, heartbeatRecordId, payload)) {
      if (runtimeState.state === 'ready') await completeWeeklyProductionRuntimeProbes({ dataStore, workerBuildSha: runtimeBuildInfo().commitSha, now });
      return;
    }
    heartbeatRecordId = '';
  }
  const existing = await dataStore.list<{ id: string }>(SOCIAL_OPERATING_WORKER_HEARTBEATS, {
    where: { instance_id: instanceId }, page: 1, perPage: 1,
  });
  if (existing.items[0]?.id) {
    heartbeatRecordId = existing.items[0].id;
    if (await dataStore.update(SOCIAL_OPERATING_WORKER_HEARTBEATS, heartbeatRecordId, payload)) {
      if (runtimeState.state === 'ready') await completeWeeklyProductionRuntimeProbes({ dataStore, workerBuildSha: runtimeBuildInfo().commitSha, now });
      return;
    }
  }
  const created = await dataStore.create<{ id: string }>(SOCIAL_OPERATING_WORKER_HEARTBEATS, payload);
  if (!created?.id) throw new Error('worker_heartbeat_storage_unavailable');
  heartbeatRecordId = created.id;
  if (runtimeState.state === 'ready') await completeWeeklyProductionRuntimeProbes({ dataStore, workerBuildSha: runtimeBuildInfo().commitSha, now });
}

export async function startWorkerHeartbeat(role: ProcessRole, dataStore: DataStore = store): Promise<void> {
  await writeWorkerHeartbeat(role, dataStore);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  const configured = Number(process.env.WORKER_HEARTBEAT_INTERVAL_MS || 15_000);
  const intervalMs = Number.isFinite(configured) ? Math.min(Math.max(Math.floor(configured), 5_000), 60_000) : 15_000;
  heartbeatTimer = setInterval(() => {
    void writeWorkerHeartbeat(role, dataStore).catch(error => {
      console.error('[runtime] worker heartbeat failed', error instanceof Error ? error.message : error);
    });
  }, intervalMs);
  heartbeatTimer.unref();
}

export function stopWorkerHeartbeatForTest(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}
