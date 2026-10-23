export type FollowupWorkerMode = 'scheduled' | 'manual_only';

export function followupWorkerMode(): FollowupWorkerMode {
  return process.env.FOLLOWUP_WORKER_ENABLED === 'true' ? 'scheduled' : 'manual_only';
}

export function followupWorkerIntervalMs(): number {
  const configured = Number(process.env.FOLLOWUP_WORKER_INTERVAL_MS || 15_000);
  return Number.isFinite(configured) ? Math.max(5_000, configured) : 15_000;
}

export function followupWorkerMaxAttempts(): number {
  const configured = Number(process.env.FOLLOWUP_WORKER_MAX_ATTEMPTS || 3);
  return Number.isFinite(configured) ? Math.max(1, Math.min(10, Math.floor(configured))) : 3;
}
