import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';

export type PaidOperationLockOptions = {
  /** Recover only a lock whose owner is provably a dead process on this host
   * and whose caller-specific durable intent state proves that no paid request
   * is uncertain.  Cross-host and legacy locks always remain fail-closed. */
  recoverDeadOwner?: () => boolean;
};

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

/** Shared-volume lock; deliberately never expires while an upstream call may still be running.
 * A crashed worker leaves a lock requiring operator reconciliation, not an automatic paid retry.
 * All workers must mount the same data directory. This is not a distributed database lock.
 */
export async function withPaidOperationLock<T>(root: string, key: string, operation: () => Promise<T>, options: PaidOperationLockOptions = {}): Promise<T> {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, `${createHash('sha256').update(key).digest('hex')}.lock`);
  const owner = randomUUID();
  let fd: number;
  for (let attempt = 0; ; attempt += 1) {
    try { fd = fs.openSync(file, 'wx', 0o600); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('付费任务锁不可写，未调用供应商');
      let stale = false;
      try {
        const row = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: unknown; hostname?: unknown };
        const pid = Number(row.pid);
        stale = attempt === 0 && row.hostname === os.hostname() && Number.isInteger(pid) && pid > 0
          && !processIsAlive(pid) && options.recoverDeadOwner?.() === true;
      } catch { /* malformed/legacy locks remain fail-closed */ }
      if (!stale) throw new Error('任务正在处理或上次进程异常中断；请稍后刷新，持续占用需管理员核对，禁止重新付费提交');
      try { fs.unlinkSync(file); } catch { throw new Error('历史任务锁无法安全释放，未调用供应商'); }
    }
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({ owner, pid: process.pid, hostname: os.hostname(), createdAt: new Date().toISOString() }));
    return await operation();
  } finally {
    fs.closeSync(fd);
    // Never remove a replacement lock that belongs to another process.
    try { if (JSON.parse(fs.readFileSync(file, 'utf8')).owner === owner) fs.unlinkSync(file); } catch { /* fail closed */ }
  }
}
