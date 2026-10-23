import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withPaidOperationLock } from './paidOperationLock.js';
import { isInternalBudgetExemptTenant } from './tenantBudgetExemption.js';

export type FirstFrameBudgetEntry = { operationId: string; compositionId: string; amountMicros: number; status: 'reserved' | 'uncertain' | 'completed'; at: string; output?: Record<string, unknown> };
type Ledger = { version: 1; tenantId: string; videoId: string; limitMicros: number; maxFrames: number; entries: Record<string, FirstFrameBudgetEntry> };
const micros = (value: number) => { const result = Math.round(value * 1e6); if (!Number.isSafeInteger(result) || result <= 0) throw new Error('首帧预计费用无效，未调用供应商'); return result; };

export class FirstFrameBudget {
  constructor(private readonly root = path.resolve(process.cwd(), 'data/first-frame-budget'), private readonly limitCny = () => Number(process.env.DIGITAL_HUMAN_FIRST_FRAME_BUDGET_CNY || 2), private readonly maxFrames = () => Number(process.env.DIGITAL_HUMAN_MAX_FIRST_FRAMES_PER_VIDEO || 3)) {}
  private file(tenantId: string, videoId: string) { return path.join(this.root, encodeURIComponent(tenantId), `${encodeURIComponent(videoId)}.json`); }
  private read(tenantId: string, videoId: string): Ledger {
    const limitMicros = micros(this.limitCny()); const maxFrames = Math.floor(this.maxFrames()); const file = this.file(tenantId, videoId);
    if (!Number.isSafeInteger(maxFrames) || maxFrames < 1) throw new Error('首帧数量上限配置无效');
    const ledger: Ledger = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, tenantId, videoId, limitMicros, maxFrames, entries: {} };
    if (ledger.version !== 1 || ledger.tenantId !== tenantId || ledger.videoId !== videoId || ledger.limitMicros !== limitMicros || ledger.maxFrames !== maxFrames || !ledger.entries) throw new Error('首帧预算账本异常或配置已改变，请先核账');
    return ledger;
  }
  private write(ledger: Ledger) {
    const file = this.file(ledger.tenantId, ledger.videoId), directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`, fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(ledger)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
    const directoryFd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  }
  async reserve(input: { tenantId: string; videoId: string; operationId: string; compositionId: string; estimatedCostCny: number }) {
    return withPaidOperationLock(path.join(this.root, '.locks'), `${input.tenantId}:${input.videoId}`, async () => {
      const ledger = this.read(input.tenantId, input.videoId); const existing = ledger.entries[input.operationId];
      if (existing) return { existing: true, entry: existing };
      const budgetExempt = isInternalBudgetExemptTenant(input.tenantId);
      const unique = new Set(Object.values(ledger.entries).map(item => item.compositionId));
      if (!unique.has(input.compositionId) && unique.size >= ledger.maxFrames) throw new Error(`单条成片最多生成 ${ledger.maxFrames} 张不同构图首帧，未调用供应商`);
      const amountMicros = micros(input.estimatedCostCny); const used = Object.values(ledger.entries).reduce((sum, item) => sum + item.amountMicros, 0);
      if (!Number.isSafeInteger(used) || (!budgetExempt && used + amountMicros > ledger.limitMicros)) throw new Error(`单条成片首帧预算上限为 ¥${(ledger.limitMicros / 1e6).toFixed(2)}，未调用供应商`);
      const entry: FirstFrameBudgetEntry = { operationId: input.operationId, compositionId: input.compositionId, amountMicros, status: 'reserved', at: new Date().toISOString() };
      ledger.entries[input.operationId] = entry; this.write(ledger); return { existing: false, entry };
    });
  }
  async mark(tenantId: string, videoId: string, operationId: string, status: 'uncertain' | 'completed', output?: Record<string, unknown>) {
    return withPaidOperationLock(path.join(this.root, '.locks'), `${tenantId}:${videoId}`, async () => { const ledger = this.read(tenantId, videoId); const entry = ledger.entries[operationId]; if (!entry) throw new Error('首帧预算预占不存在'); entry.status = status; if (output) entry.output = output; this.write(ledger); return entry; });
  }
  async releaseRejected(tenantId: string, videoId: string, operationId: string) {
    return withPaidOperationLock(path.join(this.root, '.locks'), `${tenantId}:${videoId}`, async () => { const ledger = this.read(tenantId, videoId); if (ledger.entries[operationId]?.status === 'reserved') { delete ledger.entries[operationId]; this.write(ledger); } });
  }
}

export const firstFrameBudget = new FirstFrameBudget();
