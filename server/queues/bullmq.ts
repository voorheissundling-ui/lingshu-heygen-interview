import { Queue, Worker, type ConnectionOptions, type JobsOptions, type Processor } from 'bullmq';

export type QueueBackend = 'local' | 'bullmq';

export function selectedQueueBackend(env: NodeJS.ProcessEnv = process.env): QueueBackend {
  const value = String(env.QUEUE_BACKEND || 'local').trim().toLowerCase();
  if (value !== 'local' && value !== 'bullmq') throw new Error('Unsupported QUEUE_BACKEND');
  if (env.NODE_ENV === 'production' && value !== 'bullmq') {
    throw new Error('QUEUE_BACKEND=bullmq is required in production; local queue fallback is disabled');
  }
  return value;
}

export function redisConnectionOptions(env: NodeJS.ProcessEnv = process.env): ConnectionOptions {
  const url = String(env.REDIS_URL || '').trim();
  if (!url) throw new Error('REDIS_URL is required when QUEUE_BACKEND=bullmq');
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('REDIS_URL must be a valid Redis URL'); }
  if (!['redis:', 'rediss:'].includes(parsed.protocol)) throw new Error('REDIS_URL must use redis:// or rediss://');
  if (!parsed.hostname || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '' && !/^\/\d+$/.test(parsed.pathname))) {
    throw new Error('REDIS_URL must specify a host and an optional numeric database');
  }
  return {
    url,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

const queues = new Map<string, Queue<any, any, string>>();
const workers = new Map<string, Worker>();

function namespaced(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const prefix = String(env.BULLMQ_PREFIX || 'lingshu').trim().replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 32) || 'lingshu';
  const queue = name.trim().replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64);
  if (!queue) throw new Error('BullMQ queue name is required');
  return `${prefix}-${queue}`;
}

export function bullQueue<Data = unknown>(name: string): Queue<Data, any, string> {
  const canonical = namespaced(name);
  const existing = queues.get(canonical);
  if (existing) return existing as Queue<Data, any, string>;
  const queue = new Queue<Data, any, string>(canonical, {
    connection: redisConnectionOptions(),
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { age: 24 * 60 * 60, count: 5_000 },
      removeOnFail: { age: 14 * 24 * 60 * 60, count: 10_000 },
    },
  });
  queues.set(canonical, queue);
  return queue;
}

export async function enqueueBullJob<Data>(input: {
  queue: string;
  name: string;
  data: Data;
  jobId: string;
  options?: JobsOptions;
}): Promise<string> {
  if (selectedQueueBackend() !== 'bullmq') throw new Error('BullMQ queue backend is not enabled');
  const queue = bullQueue<Data>(input.queue) as Queue<any, any, string>;
  const existing = await queue.getJob(input.jobId);
  if (existing) {
    const state = await existing.getState();
    // API recovery can intentionally resubmit the same durable run. Replaying
    // a failed job is safe because business writes are idempotent by run id;
    // waiting/active/completed jobs remain deduplicated.
    if (state === 'failed') await existing.retry('failed');
    return String(existing.id);
  }
  const job = await queue.add(input.name, input.data, {
    ...input.options,
    jobId: input.jobId,
  });
  return String(job.id);
}

export function startBullWorker<Data, Result = void>(input: {
  queue: string;
  processor: Processor<Data, Result>;
  concurrency?: number;
}): Worker<Data, Result> | null {
  if (selectedQueueBackend() !== 'bullmq') return null;
  const canonical = namespaced(input.queue);
  const existing = workers.get(canonical);
  if (existing) return existing as Worker<Data, Result>;
  const worker = new Worker<Data, Result>(canonical, input.processor, {
    connection: redisConnectionOptions(),
    concurrency: Math.min(Math.max(Math.floor(input.concurrency || 1), 1), 20),
    lockDuration: 10 * 60 * 1000,
  });
  worker.on('failed', (job, error) => console.error(`[bullmq:${canonical}] job=${job?.id || 'unknown'} failed`, error.message));
  worker.on('error', error => console.error(`[bullmq:${canonical}] worker error`, error.message));
  workers.set(canonical, worker);
  return worker;
}

export async function checkBullMq(input: {
  timeoutMs?: number;
  probe?: () => Promise<void>;
} = {}): Promise<void> {
  if (selectedQueueBackend() !== 'bullmq') return;
  const configured = input.timeoutMs ?? Number(process.env.BULLMQ_HEALTH_TIMEOUT_MS || 2_000);
  const timeoutMs = Number.isFinite(configured) ? Math.min(Math.max(Math.floor(configured), 1), 30_000) : 2_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (input.probe || (async () => {
        const queue = bullQueue('__health');
        await queue.waitUntilReady();
        await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
      }))(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('BullMQ health check timed out')), timeoutMs); }),
    ]);
  } catch {
    // Redis client errors can embed connection credentials. Public readiness
    // records must expose a stable failure category only.
    throw new Error('BullMQ health check failed or timed out');
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function closeBullMq(): Promise<void> {
  const activeWorkers = [...workers.values()];
  const activeQueues = [...queues.values()];
  workers.clear();
  queues.clear();
  await Promise.allSettled(activeWorkers.map(worker => worker.close(true)));
  // Disconnect queue clients directly: graceful Redis QUIT can wait forever
  // when the endpoint is unreachable, including after a failed readiness probe.
  await Promise.allSettled(activeQueues.map(queue => queue.disconnect()));
}
