import { createHash, randomBytes } from 'node:crypto';
import type { DataStore } from '../storage/datastore.js';

export const WEEKLY_PRODUCTION_RUNTIME_PROBES = 'weekly_production_runtime_probes';
const FORMAT = 'weekly-production-runtime-probe.v1';

type ProbeRow = {
  id: string;
  probe_id?: unknown;
  status?: unknown;
  challenge_hash?: unknown;
  web_build_sha?: unknown;
  worker_build_sha?: unknown;
  enqueued_at?: unknown;
  claimed_at?: unknown;
  completed_at?: unknown;
  checkpoint?: unknown;
};

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object'
  ? value as Record<string, unknown> : {};
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const validBuild = (value: string) => /^[a-f0-9]{7,64}$/i.test(value);

export async function completeWeeklyProductionRuntimeProbes(input: {
  dataStore: DataStore;
  workerBuildSha: string;
  now?: Date;
}): Promise<number> {
  if (!validBuild(input.workerBuildSha) || !input.dataStore.compareAndSwap
    || await input.dataStore.supportsAtomicCompareAndSwap?.() !== true) return 0;
  const now = input.now ?? new Date();
  const rows = await input.dataStore.list<ProbeRow>(WEEKLY_PRODUCTION_RUNTIME_PROBES, {
    where: { status: 'queued' }, sort: 'enqueued_at', page: 1, perPage: 20,
  });
  let completed = 0;
  for (const row of rows.items) {
    const enqueuedAt = Date.parse(String(row.enqueued_at || ''));
    const webBuildSha = String(row.web_build_sha || '');
    const challengeHash = String(row.challenge_hash || '');
    if (!Number.isFinite(enqueuedAt) || now.getTime() - enqueuedAt < 0) continue;
    if (now.getTime() - enqueuedAt > 120_000) {
      await input.dataStore.delete(WEEKLY_PRODUCTION_RUNTIME_PROBES, row.id).catch(() => false);
      continue;
    }
    if (webBuildSha.toLowerCase() !== input.workerBuildSha.toLowerCase() || !/^[a-f0-9]{64}$/.test(challengeHash)) continue;
    const at = now.toISOString();
    const checkpoint = { format: FORMAT, probeId: String(row.probe_id || ''), challengeHash,
      webBuildSha, workerBuildSha: input.workerBuildSha, writtenAt: at };
    const saved = await input.dataStore.compareAndSwap(WEEKLY_PRODUCTION_RUNTIME_PROBES, row.id,
      { status: 'queued', challenge_hash: challengeHash, web_build_sha: webBuildSha },
      { status: 'completed', worker_build_sha: input.workerBuildSha, claimed_at: at, completed_at: at, checkpoint });
    if (!saved) continue;
    const readback = await input.dataStore.getById<ProbeRow>(WEEKLY_PRODUCTION_RUNTIME_PROBES, row.id);
    const stored = object(readback?.checkpoint);
    if (readback?.status !== 'completed' || stored.format !== FORMAT || stored.challengeHash !== challengeHash
      || String(readback.worker_build_sha || '').toLowerCase() !== input.workerBuildSha.toLowerCase()) {
      // A readiness canary must fail closed without taking down the business
      // worker that proved the failure. The web-side verifier will observe no
      // valid completion and reject release readiness.
      await input.dataStore.delete(WEEKLY_PRODUCTION_RUNTIME_PROBES, row.id).catch(() => false);
      continue;
    }
    completed++;
  }
  const abandoned = await input.dataStore.list<ProbeRow>(WEEKLY_PRODUCTION_RUNTIME_PROBES, {
    where: { status: 'completed' }, sort: 'completed_at', page: 1, perPage: 20,
  });
  for (const row of abandoned.items) {
    const completedAt = Date.parse(String(row.completed_at || ''));
    if (Number.isFinite(completedAt) && now.getTime() - completedAt > 300_000)
      await input.dataStore.delete(WEEKLY_PRODUCTION_RUNTIME_PROBES, row.id).catch(() => false);
  }
  return completed;
}

export async function runWeeklyProductionRuntimeProbe(input: {
  dataStore: DataStore;
  webBuildSha: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<boolean> {
  if (!validBuild(input.webBuildSha)) return false;
  const probeId = randomBytes(16).toString('hex');
  const id = `wprp${randomBytes(8).toString('hex')}`.slice(0, 15);
  const challengeHash = sha(randomBytes(32).toString('hex'));
  const enqueuedAt = new Date().toISOString();
  const created = await input.dataStore.create<ProbeRow>(WEEKLY_PRODUCTION_RUNTIME_PROBES, {
    id, probe_id: probeId, status: 'queued', challenge_hash: challengeHash,
    web_build_sha: input.webBuildSha, worker_build_sha: '', enqueued_at: enqueuedAt,
    claimed_at: '', completed_at: '', checkpoint: {},
  });
  if (!created?.id) return false;
  const deadline = Date.now() + Math.min(Math.max(input.timeoutMs ?? 30_000, 1_000), 60_000);
  const pollIntervalMs = Math.min(Math.max(input.pollIntervalMs ?? 250, 25), 2_000);
  try {
    while (Date.now() < deadline) {
      const row = await input.dataStore.getById<ProbeRow>(WEEKLY_PRODUCTION_RUNTIME_PROBES, id);
      if (!row) return false;
      if (row.status === 'completed') {
        const checkpoint = object(row.checkpoint);
        return checkpoint.format === FORMAT && checkpoint.probeId === probeId
          && checkpoint.challengeHash === challengeHash
          && String(row.worker_build_sha || '').toLowerCase() === input.webBuildSha.toLowerCase()
          && checkpoint.workerBuildSha === row.worker_build_sha;
      }
      if (row.status !== 'queued') return false;
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
    return false;
  } finally {
    await input.dataStore.delete(WEEKLY_PRODUCTION_RUNTIME_PROBES, id).catch(() => false);
  }
}
