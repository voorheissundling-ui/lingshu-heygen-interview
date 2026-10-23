import path from 'node:path';
import { HeyGenClient } from '../lib/heygen.js';
import { withPaidOperationLock } from '../lib/paidOperationLock.js';
import { sentenceReplicationReadiness } from '../runtime/readiness.js';
import type { DigitalHumanExecutionRecord } from '../../src/lib/digitalHumanPlan.js';
import type { DigitalHumanToolId } from '../lib/digitalHumanProviderRegistry.js';
import type { ExecutionStoreRecord, ImportedVideoResult, ProductionRouterOptions } from './productionContracts.js';
import type { DataStore } from '../storage/datastore.js';
import { isInternalBudgetExemptTenant } from '../lib/tenantBudgetExemption.js';

const REFERENCE_BUDGET_EXEMPT_CEILING_CNY = 1_000_000_000;

export function candidateOutputFromImport(imported: ImportedVideoResult): NonNullable<DigitalHumanExecutionRecord['candidateOutput']> | undefined {
  const contentSha256 = String(imported.contentSha256 || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(contentSha256)) return undefined;
  if (imported.objectKey && imported.objectEtag) return { materialId: imported.materialId, objectKey: imported.objectKey, contentSha256, objectEtag: imported.objectEtag };
  if (imported.localFile) return { materialId: imported.materialId, localFile: imported.localFile, contentSha256 };
  return undefined;
}

export function createProductionRuntime(options: ProductionRouterOptions) {
  const locks = new Map<string, Promise<unknown>>();
  const exclusive = async <T>(key: string, operation: () => Promise<T>): Promise<T> => {
    const next = (locks.get(key) || Promise.resolve()).catch(() => undefined).then(() => withPaidOperationLock(options.lockRoot || path.resolve(process.cwd(), 'data/studio-production-locks'), key, operation));
    locks.set(key, next); try { return await next; } finally { if (locks.get(key) === next) locks.delete(key); }
  };
  const enabled = () => options.enabled?.() ?? Boolean(process.env.HEYGEN_API_KEY && process.env.HEYGEN_GENERATION_ENABLED === 'true');
  const client = () => options.client || new HeyGenClient(process.env.HEYGEN_API_KEY || '');
  const referenceBudgetLimitCny = (tenantId?: string) => {
    if (isInternalBudgetExemptTenant(tenantId)) return REFERENCE_BUDGET_EXEMPT_CEILING_CNY;
    const raw = options.referenceBudgetLimitCny ?? process.env.DIGITAL_HUMAN_REFERENCE_MAX_CNY_PER_SHOT;
    if (raw == null || String(raw).trim() === '') return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return null;
    return value;
  };
  // Configured ports do not authorize an unbounded paid reference operation.
  const executableReferenceAdapters = (tenantId?: string) => options.reserveReference && options.importReferenceVideo && options.resolveReferenceInputs && referenceBudgetLimitCny(tenantId) !== null ? options.adapters || [] : [];
  const maxAttemptsPerShot = () => { const value = Number(options.maxAttemptsPerShot ?? process.env.DIGITAL_HUMAN_MAX_ATTEMPTS_PER_SHOT ?? 3); return Number.isSafeInteger(value) && value >= 1 && value <= 10 ? value : 3; };
  const sentenceReadiness = () => options.sentenceReplicationReadiness?.() ?? sentenceReplicationReadiness();
  const releaseReferenceReservation = async (tool: DigitalHumanToolId, requestId: string, tenantId: string): Promise<string> => { if (!options.releaseReference) return ''; try { await options.releaseReference(tool, requestId, tenantId); return ''; } catch (error) { return `预算预占释放失败，请管理员核对账本：${error instanceof Error ? error.message : '未知错误'}`; } };
  const assertCandidateOutputCurrent = async (record: ExecutionStoreRecord, tenantId: string) => { const evidence = record.payload.candidateOutput; if (!evidence) return; if (evidence.materialId !== record.payload.materialId || !options.verifyCandidateOutput) throw new Error('候选输出缺少可复核的存储证据服务，不能验收或填入分镜'); if (!await options.verifyCandidateOutput(evidence, tenantId)) throw new Error('候选输出对象版本已变化，或本地文件内容已变化，历史质检失效；请恢复原文件或生成新候选'); };
  return { exclusive, enabled, client, executableReferenceAdapters, referenceBudgetLimitCny, maxAttemptsPerShot, sentenceReadiness, releaseReferenceReservation, assertCandidateOutputCurrent };
}

export function createProductionStoreRuntime(store: DataStore, maxAttemptsPerShot: () => number) {
  const assertAttemptAvailable = async (input: { tenantId: string; projectId: string; assemblyId: string; shotId: string; fingerprint: string; presenterAssetVersion: number }) => {
    const records = await store.list<ExecutionStoreRecord>('studio_digital_human_executions', { where: { tenant_id: input.tenantId, project_id: input.projectId }, perPage: 500 });
    const attempts = records.items.filter(item => item.payload.assemblyId === input.assemblyId && item.payload.shotId === input.shotId && item.payload.fingerprint === input.fingerprint && item.payload.presenterAssetVersion === input.presenterAssetVersion && item.payload.submissionOutcome !== 'rejected').length;
    if (attempts >= maxAttemptsPerShot()) throw new Error(`本镜头当前要求与人物版本已达到 ${maxAttemptsPerShot()} 次生成上限；请先比较已有候选，或修改镜头要求后保存新方案`);
  };
  const readDefaults = async (tenantId: string) => (await store.list<any>('studio_production_defaults', { where: { tenant_id: tenantId }, perPage: 1 })).items[0];
  return { assertAttemptAvailable, readDefaults };
}
