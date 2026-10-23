/** In-process deduplication with a bounded number of active jobs. */
export class KeyedWorkQueue {
  private jobs = new Map<string, {prepared: Promise<void>; done: Promise<void>}>();
  private waiting: Array<() => void> = [];
  private active = 0;
  constructor(private concurrency = 2) {}
  has(key: string) { return this.jobs.has(key); }
  get(key: string) { return this.jobs.get(key)?.done; }
  private async slot(action: () => Promise<void>) {
    if (this.active >= this.concurrency) await new Promise<void>(resolve => this.waiting.push(resolve));
    else this.active++;
    try { await action(); } finally { const next = this.waiting.shift(); if (next) next(); else this.active--; }
  }
  async enqueue(key: string, prepare: () => Promise<void>, action: () => Promise<void>, onError: (error: unknown) => void): Promise<boolean> {
    const existing = this.jobs.get(key);
    if (existing) { await existing.prepared; return false; }
    // Reserve before executing any asynchronous persistence.
    const prepared = Promise.resolve().then(prepare);
    const done = prepared.then(() => this.slot(action)).finally(() => this.jobs.delete(key));
    this.jobs.set(key, {prepared,done});
    void done.catch(onError);
    await prepared;
    return true;
  }
}
