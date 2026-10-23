import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const processInstanceId = randomUUID();
export const LOCAL_STORE_MAINTENANCE_FENCE = '.local-store-maintenance.lock';
export function assertLocalStoreWritable(directory: string): void {
  if (fs.existsSync(path.join(directory, LOCAL_STORE_MAINTENANCE_FENCE))) throw Error('local_store_maintenance_active');
}
export interface LocalCollectionLockOwner {
  schema: 'local-collection-lock.v1';
  pid: number;
  host: string;
  processInstanceId: string;
  token: string;
  acquiredAt: string;
}

/** A filesystem mutex, not a business lease. Never reclaim by timeout, missing
 * owner, expired business lease, or a PID that may have been reused. */
export async function acquireLocalCollectionFileLock(file: string, options: { timeoutMs?: number } = {}): Promise<() => void> {
  assertLocalStoreWritable(path.dirname(file));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`, ownerFile = path.join(lock, 'owner.json');
  const deadline = Date.now() + (options.timeoutMs ?? 5_000);
  let waitMs = 5;
  for (;;) {
    assertLocalStoreWritable(path.dirname(file));
    try { fs.mkdirSync(lock); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw Error('local_store_atomic_lock_busy_reconciliation_required');
      // Yield the Node event loop. Atomics.wait here previously starved HTTP
      // during repeated orphan-lock contention, including the health endpoint.
      await delay(Math.min(waitMs, Math.max(1, deadline - Date.now())));
      waitMs = Math.min(50, waitMs * 2);
    }
  }
  const directoryIdentity = fs.statSync(lock);
  const owner: LocalCollectionLockOwner = { schema: 'local-collection-lock.v1', pid: process.pid, host: os.hostname(), processInstanceId, token: randomUUID(), acquiredAt: new Date().toISOString() };
  fs.writeFileSync(ownerFile, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
  let released = false;
  return () => {
    if (released) return;
    // Do not remove a replacement owner's lock or an unexplained file. The
    // absence of evidence remains a reconciliation blocker, never permission.
    try {
      const currentDirectory = fs.statSync(lock);
      const current = JSON.parse(fs.readFileSync(ownerFile, 'utf8')) as LocalCollectionLockOwner;
      const entries = fs.readdirSync(lock);
      if (currentDirectory.dev !== directoryIdentity.dev || currentDirectory.ino !== directoryIdentity.ino
        || current.schema !== owner.schema || current.pid !== owner.pid || current.host !== owner.host
        || current.processInstanceId !== owner.processInstanceId || current.token !== owner.token || current.acquiredAt !== owner.acquiredAt
        || entries.length !== 1 || entries[0] !== 'owner.json') throw Error('ownership_changed');
    } catch {
      throw Error('local_store_atomic_lock_ownership_changed_reconciliation_required');
    }
    // Detach the verified directory atomically before cleanup. A crash between
    // unlink(owner) and rmdir(lock) must not create another ownerless live lock.
    const releasedDirectory = `${lock}.released-${owner.token}`;
    fs.renameSync(lock, releasedDirectory);
    released = true;
    try {
      fs.unlinkSync(path.join(releasedDirectory, 'owner.json'));
      fs.rmdirSync(releasedDirectory);
    } catch {
      // Work is committed and the live mutex was released. Retain any cleanup
      // residue for inspection; do not misreport a failed business write.
      console.warn('[local-store] released lock cleanup retained', { code: 'local_store_released_lock_cleanup_required' });
    }
  };
}

/** Work stays synchronous inside the acquired lock, so read/CAS/write remains
 * one critical section. Only contention waiting is asynchronous. */
export async function withLocalCollectionFileLock<T>(file: string, work: () => T): Promise<T> {
  const release = await acquireLocalCollectionFileLock(file);
  try { assertLocalStoreWritable(path.dirname(file));return work(); } finally { release(); }
}
