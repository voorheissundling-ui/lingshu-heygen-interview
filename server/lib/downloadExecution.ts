/** A shared budget prevents format x cookie retries multiplying a timeout. */
export class DownloadBudget {
  private readonly deadline: number;
  readonly failures: string[] = [];
  constructor(milliseconds: number, private readonly clock = Date.now) {
    this.deadline = clock() + milliseconds;
  }
  remaining(): number {
    const left = this.deadline - this.clock();
    if (left <= 0) throw this.error('下载累计超时');
    return Math.max(1, Math.floor(left));
  }
  record(label: string, error: unknown): void {
    this.failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 600));
  }
  error(reason = '所有下载渠道均失败'): Error {
    return new Error(`${reason}；${this.failures.join('；')}`);
  }
}

/** Register before waiting for a concurrency slot, so recovery sees queued work. */
export class RecordWorkRegistry {
  private readonly work = new Map<string, Promise<unknown>>();
  has(key: string): boolean { return this.work.has(key); }
  run<T>(key: string, action: () => Promise<T>): Promise<T> {
    const existing = this.work.get(key);
    if (existing) return existing as Promise<T>;
    const promise = Promise.resolve().then(action).finally(() => {
      if (this.work.get(key) === promise) this.work.delete(key);
    });
    this.work.set(key, promise);
    return promise;
  }
}

export function terminalDownloadFailure(error: unknown): boolean {
  return /video (?:has been removed|unavailable)|private video|copyright|not available in your country|unsupported url|下载累计超时/i.test(error instanceof Error ? error.message : String(error));
}
