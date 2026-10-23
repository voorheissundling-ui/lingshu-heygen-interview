type Release = () => void;

interface Waiter {
  signal?: AbortSignal;
  resolve: (release: Release) => void;
  reject: (reason: unknown) => void;
  onAbort?: () => void;
}

/** A small FIFO semaphore whose queued entries can be cancelled. */
export class AbortableSemaphore {
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('semaphore limit must be a positive integer');
  }

  acquire(signal?: AbortSignal): Promise<Release> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('operation cancelled'));
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.releaseHandle());
    }

    return new Promise<Release>((resolve, reject) => {
      const waiter: Waiter = { signal, resolve, reject };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          reject(signal.reason ?? new Error('operation cancelled'));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.queue.push(waiter);
    });
  }

  get activeCount() { return this.active; }
  get queuedCount() { return this.queue.length; }

  private releaseHandle(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      this.admitNext();
    };
  }

  private admitNext() {
    while (this.active < this.limit && this.queue.length) {
      const waiter = this.queue.shift()!;
      waiter.signal?.removeEventListener('abort', waiter.onAbort!);
      if (waiter.signal?.aborted) {
        waiter.reject(waiter.signal.reason ?? new Error('operation cancelled'));
        continue;
      }
      this.active += 1;
      waiter.resolve(this.releaseHandle());
    }
  }
}
