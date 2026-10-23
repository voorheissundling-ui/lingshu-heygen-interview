import { managedPublishingGrantErrors, normalizeManagedPublishingGrant } from '../../shared/contracts/managedPublishingGrant.js';
import { normalizeDigitalEmployeeConfig } from '../digitalEmployees/domain.js';
import type { DataStore } from '../storage/datastore.js';
import { store } from '../storage/index.js';
import type { PostRecord } from './waLink.js';

export class ManagedPublishingAuthorizationError extends Error {
  readonly statusCode = 409;
  constructor(message = '持续发布授权已撤销、过期或发生变化，请重新授权后再发布') {
    super(message);
    this.name = 'ManagedPublishingAuthorizationError';
  }
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') { try { return record(JSON.parse(value)); } catch { return {}; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Re-read current consent immediately before a new external submission. Receipt polling is unaffected. */
export async function assertManagedPublishingAuthorization(
  post: Pick<PostRecord, 'id' | 'tenant_id' | 'stats'>,
  accountId: string,
  dependencies: { store: Pick<DataStore, 'getById' | 'list'>; now: () => Date } = { store, now: () => new Date() },
): Promise<void> {
  const stats = record(post.stats);
  const grantId = typeof stats.managedPublishingGrantId === 'string' ? stats.managedPublishingGrantId : '';
  if (!grantId) return; // Existing individually approved posts keep their own frozen approval.
  const current = await dependencies.store.getById<PostRecord>('posts', post.id);
  if (!current || current.tenant_id !== post.tenant_id || record(current.stats).managedPublishingGrantId !== grantId) throw new ManagedPublishingAuthorizationError();
  const configuration = await dependencies.store.list<{ tenant_id: string; config: unknown }>('digital_employee_configs', {
    where: { tenant_id: post.tenant_id }, sort: '-updated_at', page: 1, perPage: 1,
  });
  const row = configuration.items[0];
  if (!row || row.tenant_id !== post.tenant_id) throw new ManagedPublishingAuthorizationError();
  const config = normalizeDigitalEmployeeConfig(record(row.config));
  const grant = normalizeManagedPublishingGrant(config.managedPublishingGrant);
  if (!grant?.enabled || grant.grantId !== grantId || !grant.authorizedBy || !grant.accountIds.includes(accountId)
    || managedPublishingGrantErrors(grant, config, new Date(dependencies.now().getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)).length) {
    throw new ManagedPublishingAuthorizationError();
  }
  const currentStats = record(current.stats);
  if (currentStats.realPublishingAuthorized !== true || !Array.isArray(currentStats.targetAccountIds)
    || !currentStats.targetAccountIds.includes(accountId)) throw new ManagedPublishingAuthorizationError();
  const runId = String(currentStats.workflowRunId || '');
  const run = runId ? await dependencies.store.getById<{ tenant_id: string; plan_id: string; goal_id: string; status: string }>('workflow_runs', runId) : null;
  if (!run || run.tenant_id !== post.tenant_id || !['running', 'waiting_external', 'waiting_approval'].includes(run.status)) throw new ManagedPublishingAuthorizationError('经营周期已暂停或结束，暂不提交新的发布');
  const plan = run?.tenant_id === post.tenant_id
    ? await dependencies.store.getById<{ tenant_id: string; plan: unknown }>('weekly_plans', run.plan_id) : null;
  if (!plan || plan.tenant_id !== post.tenant_id || record(plan.plan).managedPublishingGrantId !== grantId) throw new ManagedPublishingAuthorizationError();
  const authorization = record(record(record(plan.plan).businessPackage).authorization);
  if (authorization.mode !== 'bounded' || !Array.isArray(authorization.accountIds) || !authorization.accountIds.includes(accountId)
    || !Number.isInteger(authorization.maxPublishItems) || Number(authorization.maxPublishItems) < 1
    || Number(authorization.maxPublishItems) > grant.maxPublishItems) throw new ManagedPublishingAuthorizationError();
  const goal = await dependencies.store.getById<{ tenant_id: string; starts_at: string; ends_at: string }>('weekly_goals', run.goal_id);
  const today = new Date(dependencies.now().getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (!goal || goal.tenant_id !== post.tenant_id || !/^\d{4}-\d{2}-\d{2}$/.test(goal.starts_at)
    || !/^\d{4}-\d{2}-\d{2}$/.test(goal.ends_at) || today < goal.starts_at || today > goal.ends_at
    || goal.ends_at > grant.validUntil) throw new ManagedPublishingAuthorizationError('发布已超出授权经营周期');
  let itemCount = 0;
  for (let page = 1; ; page++) {
    const result = await dependencies.store.list<PostRecord>('posts', { where: { tenant_id: post.tenant_id }, page, perPage: 100 });
    itemCount += result.items.filter(item => item.tenant_id === post.tenant_id && record(item.stats).workflowRunId === runId).length;
    if (itemCount > Number(authorization.maxPublishItems)) throw new ManagedPublishingAuthorizationError('本周期发布项超过授权上限');
    if (page >= result.totalPages || !result.items.length) break;
  }
}
