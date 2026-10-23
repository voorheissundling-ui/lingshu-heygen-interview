import { socialContentAccessResolver } from './socialContentAccess.js';
import { createHash } from 'node:crypto';
import type { DataStore, Record_ } from '../storage/datastore.js';
import type { Starter198Repository } from './repository.js';
import { normalizeDigitalEmployeeConfig, type PublishingPlatform } from '../digitalEmployees/domain.js';
import { managedPublishingGrantErrors } from '../../shared/contracts/managedPublishingGrant.js';
import { buildSocialContentPublishingPackage, createPublishingCalendarEntries } from '../digitalEmployees/publishingExecution.js';
import { listConnectedPublishingAccounts } from '../digitalEmployees/publishingTargets.js';
import { withDigitalEmployeeRunLock } from '../digitalEmployees/runControl.js';
import { withManagedPublishingCycleLease } from '../digitalEmployees/managedPublishingCycleLease.js';
import { assertDurableOperationLease } from '../runtime/durableLease.js';

const obj = (v: unknown): Record<string, any> => {
  if (typeof v === 'string') { try { return obj(JSON.parse(v)); } catch { return {}; } }
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
};
const array = (v: unknown): unknown[] => {
  if (typeof v === 'string') { try { return array(JSON.parse(v)); } catch { return []; } }
  return Array.isArray(v) ? v : [];
};
const text = (v: unknown) => typeof v === 'string' ? v.trim() : '';
const date = (now: Date) => new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
const BINDING_EVENT = 'social_content.publishing_bound';
const activeRun = (row: Record_) => ['running', 'waiting_external', 'waiting_approval'].includes(text(row.status));

async function all(data: DataStore, collection: string, where: Record<string, string>): Promise<Record_[]> {
  const rows: Record_[] = [];
  for (let page = 1; ; page++) {
    const result = await data.list<Record_>(collection, { where, page, perPage: 100 });
    rows.push(...result.items);
    if (page >= result.totalPages || !result.items.length) return rows;
  }
}

export class SocialManagedPublishingBlocked extends Error {}
function requireCondition(value: unknown, reason: string): asserts value {
  if (!value) throw new SocialManagedPublishingBlocked(reason);
}

/** Resolve only an explicit target and a uniquely matching authorized operating cycle. */
export async function resolveSocialPublishingScope(data: DataStore, tenantId: string, taskId: string, now: Date) {
  const tasks = await all(data, 'starter_social_content_tasks', { tenant_id: tenantId, task_id: taskId });
  requireCondition(tasks.length === 1 && tasks[0].tenant_id === tenantId, '内容任务不存在或租户不匹配');
  const task = tasks[0];
  requireCondition(!['paused', 'attention', 'cancelled'].includes(text(task.status)), '内容任务已暂停或需要处理，未继续发布');
  const brief = obj(task.brief);
  requireCondition(brief.managementMode === 'one_click_managed', '此任务未启用托管制作');
  const targetId = text(obj(brief.targetAccountRef).id);
  const programId = text(obj(brief.programRef).id);
  requireCondition(targetId && programId, '任务尚未绑定明确的经营账号，未自动选择发布账号');
  const accounts = await all(data, 'social_owned_accounts', { tenant_id: tenantId, program_id: programId, account_id: targetId });
  requireCondition(accounts.length === 1 && accounts[0].tenant_id === tenantId, '目标经营账号无法唯一解析');
  const account = obj(accounts[0].payload);
  const accountId = text(account.connectionId);
  requireCondition(account.status === 'active' && accountId, '目标账号未连接或已暂停');
  const configs = await data.list<Record_>('digital_employee_configs', { where: { tenant_id: tenantId }, sort: '-updated_at', page: 1, perPage: 1 });
  requireCondition(configs.items[0]?.tenant_id === tenantId, '未找到当前租户托管配置');
  const config = normalizeDigitalEmployeeConfig(obj(configs.items[0].config));
  const grant = config.managedPublishingGrant;
  requireCondition(grant?.enabled && grant.grantId && grant.authorizedBy && grant.accountIds.includes(accountId)
    && !managedPublishingGrantErrors(grant, config, date(now)).length, '当前发布授权未覆盖该账号或已失效');
  const connected = config.publishingTargets.find(item => item.accountId === accountId && item.platform === account.platform);
  requireCondition(connected, '目标账号与当前发布配置不一致');
  const bindings = (await all(data, 'run_events', { tenant_id: tenantId, type: BINDING_EVENT }))
    .filter(event => obj(event.payload).socialTaskId === taskId);
  const prior = bindings[0] && obj(bindings[0].payload);
  requireCondition(!prior || (prior.grantId === grant.grantId && prior.accountId === accountId && prior.programId === programId && prior.productionRunId === text(task.run_id)), '原任务发布绑定已变化，需要重新建立明确授权');
  const candidates: Array<{ run: Record_; plan: Record_; goal: Record_; authorization: Record<string, any> }> = [];
  for (const run of await all(data, 'workflow_runs', { tenant_id: tenantId })) {
    if (run.tenant_id !== tenantId || !activeRun(run) || (prior && prior.businessRunId !== run.id)) continue;
    const plan = await data.getById<Record_>('weekly_plans', text(run.plan_id));
    const goal = await data.getById<Record_>('weekly_goals', text(run.goal_id));
    if (!plan || !goal || plan.tenant_id !== tenantId || goal.tenant_id !== tenantId) continue;
    const body = obj(plan.plan);
    const authorization = obj(obj(body.businessPackage).authorization);
    const today = date(now);
    if (body.managedPublishingGrantId !== grant.grantId || authorization.mode !== 'bounded'
      || !Array.isArray(authorization.accountIds) || !authorization.accountIds.includes(accountId)
      || !Number.isInteger(authorization.maxPublishItems) || authorization.maxPublishItems < 1
      || authorization.maxPublishItems > grant.maxPublishItems
      || text(goal.starts_at) > today || text(goal.ends_at) < today || text(goal.ends_at) > grant.validUntil) continue;
    const goalProgram = text(obj(goal.scope).programId);
    if (goalProgram && goalProgram !== programId) continue;
    candidates.push({ run, plan, goal, authorization });
  }
  requireCondition(candidates.length === 1, candidates.length ? '存在多个可用经营周期，未擅自选择授权周期' : '没有与此账号授权匹配的有效经营周期');
  return { task, brief, accountId, account, programId, grant, target: connected, bindings, ...candidates[0] };
}

export type SocialManagedPublishingResult = { status: 'scheduled'; postIds: string[] } | { status: 'blocked'; reason: string };

/** Called after automatic artifact acceptance; never grants publishing from production mode alone. */
export interface SocialManagedPublishingPorts {
  resolveAccess?: typeof socialContentAccessResolver.resolve;
  connectedAccounts: typeof listConnectedPublishingAccounts;
  buildPackage: typeof buildSocialContentPublishingPackage;
  createEntries: typeof createPublishingCalendarEntries;
}
const publishingPorts: SocialManagedPublishingPorts = {
  connectedAccounts: listConnectedPublishingAccounts,
  buildPackage: buildSocialContentPublishingPackage,
  createEntries: createPublishingCalendarEntries,
};
export async function scheduleManagedSocialArtifact(input: {
  repository: Starter198Repository; tenantId: string; taskId: string; artifactId: string; now?: Date;
}, ports: SocialManagedPublishingPorts = publishingPorts): Promise<SocialManagedPublishingResult> {
  const data = input.repository.dataStore;
  if (!data) return { status: 'blocked', reason: '发布存储服务未就绪' };
  const now = input.now || new Date();
  try {
    await (ports.resolveAccess ?? socialContentAccessResolver.resolve)({ repository: input.repository, tenantId: input.tenantId, requiredCapabilities: ['publishing.official_api'], requireOpenCycle: true, now });
    const scope = await resolveSocialPublishingScope(data, input.tenantId, input.taskId, now);
    return await withDigitalEmployeeRunLock(input.tenantId, scope.run.id, async () => {
      return withManagedPublishingCycleLease({ dataStore: data, tenantId: input.tenantId, runId: scope.run.id, now }, async lease => {
        const current = await resolveSocialPublishingScope(data, input.tenantId, input.taskId, input.now || new Date());
        requireCondition(current.run.id === scope.run.id, '经营周期在发布准备期间发生变化');
        const actual = await ports.connectedAccounts(input.tenantId);
        requireCondition(actual.some(account => account.accountId === current.accountId && account.platform === current.target.platform), '目标账号连接已失效');
        const workflowTasks = await all(data, 'workflow_tasks', { tenant_id: input.tenantId, run_id: current.run.id });
        const publicationTask = workflowTasks.find(task => task.task_key === 'content_release_approval');
        requireCondition(publicationTask && !['cancelled', 'handed_off', 'failed'].includes(text(publicationTask.status)), '经营周期缺少可执行的发布任务');
        const prior = current.bindings.find(event => obj(event.payload).artifactId === input.artifactId);
        const otherArtifact = current.bindings.find(event => obj(event.payload).artifactId !== input.artifactId);
        requireCondition(!otherArtifact, '该任务已绑定另一成片版本，不能自动替换既有发布版本');
        const posts = await all(data, 'posts', { tenant_id: input.tenantId });
        const cyclePosts = posts.filter(post => obj(post.stats).workflowRunId === current.run.id);
        const reservations = await all(data, 'run_events', { tenant_id: input.tenantId, run_id: current.run.id, type: BINDING_EVENT });
        const missingReservations = reservations.filter(event => !cyclePosts.some(post => {
          const stats = obj(post.stats), binding = obj(event.payload);
          return stats.sourceProjectId === binding.socialTaskId && obj(stats.publishSourceClaim).artifactId === binding.artifactId;
        }));
        const used = cyclePosts.length + missingReservations.length;
        requireCondition(prior ? used <= current.authorization.maxPublishItems : used < current.authorization.maxPublishItems,
          '本周期发布额度已用完');
        const scheduledAt = prior ? text(obj(prior.payload).scheduledAt) : new Date(now.getTime() + 60_000).toISOString();
        requireCondition(date(new Date(scheduledAt)) <= text(current.goal.ends_at), '本周期已经没有可用发布时间');
        const binding = { socialTaskId: input.taskId, artifactId: input.artifactId, businessRunId: current.run.id,
          grantId: current.grant.grantId, programId: current.programId, accountId: current.accountId,
          planId: current.plan.id, productionRunId: text(current.task.run_id), scheduledAt };
        if (!prior) {
          const saved = await data.create('run_events', { tenant_id: input.tenantId, run_id: current.run.id,
            task_id: publicationTask.id, type: BINDING_EVENT, level: 'info', summary: '依据已明确授权的经营周期绑定社媒成片', payload: binding, created_at: now.toISOString() });
          requireCondition(saved, '发布绑定未能持久保存');
        }
        const pack = await ports.buildPackage({ tenantId: input.tenantId, allowRealPublishing: true,
          items: [{ taskId: input.taskId, artifactId: input.artifactId, platform: current.target.platform as PublishingPlatform,
            accountId: current.accountId, accountLabel: current.target.accountLabel, title: text(current.brief.title),
            description: '', scheduledAt }] });
        const identity = createHash('sha256').update(JSON.stringify(binding)).digest('hex');
        let approval = (await all(data, 'approval_requests', { tenant_id: input.tenantId, run_id: current.run.id }))
          .find(row => obj(array(row.evidence)[0]).socialBindingHash === identity);
        if (approval) requireCondition(approval.content_hash === pack.contentHash && approval.status === 'approved', '已绑定发布产物或授权发生变化');
        else {
          approval = await data.create<Record_>('approval_requests', { tenant_id: input.tenantId, goal_id: current.goal.id,
            run_id: current.run.id, task_id: publicationTask.id, status: 'approved', action_summary: '经营 Agent 根据持续发布授权安排已验收成片',
            risk_level: 'high', evidence: [{ socialBindingHash: identity, authorizationKind: 'managed_publishing_grant', ...binding }, { type: 'publishing_approval_package', ...pack }],
            requested_by_agent: 'business', decided_by: current.grant.authorizedBy, decision_note: `系统依据持续发布授权 ${current.grant.grantId} 自动执行，非新增人工审批`,
            created_at: now.toISOString(), decided_at: now.toISOString(), subject_version: 1, content_hash: pack.contentHash }) || undefined;
          requireCondition(approval, '系统授权执行记录未能持久保存');
        }
        await assertDurableOperationLease({ dataStore: data, lease, now: input.now });
        const latest = await resolveSocialPublishingScope(data, input.tenantId, input.taskId, input.now || new Date());
        requireCondition(latest.grant.grantId === current.grant.grantId && latest.run.id === current.run.id, '发布授权在执行前发生变化');
        const entries = await ports.createEntries({ tenantId: input.tenantId, runId: current.run.id,
          approvalTaskId: publicationTask.id, approvalId: approval.id, approvedContentHash: pack.contentHash,
          managedPublishingGrantId: current.grant.grantId, package: pack });
        return { status: 'scheduled', postIds: entries.map(entry => entry.id) } as const;
      });
    });
  } catch (error) {
    if (error instanceof SocialManagedPublishingBlocked) return { status: 'blocked', reason: error.message };
    throw error;
  }
}

/** Read-only provider receipts can be reconciled even after authorization is revoked. */
export async function reconcileManagedSocialPublications(input: {
  repository: Starter198Repository; tenantId: string; taskId: string; artifactId: string; postIds: string[];
}, ports?: {
  readTask: typeof import('./socialContentRecords.js').readSocialTaskDetail;
  register: typeof import('./socialContentOutputs.js').registerSocialPublication;
}): Promise<{ registered: number; pending: number }> {
  const data = input.repository.dataStore;
  if (!data) return { registered: 0, pending: input.postIds.length };
  const readTask = ports?.readTask ?? (await import('./socialContentRecords.js')).readSocialTaskDetail;
  const register = ports?.register ?? (await import('./socialContentOutputs.js')).registerSocialPublication;
  const outcome = { registered: 0, pending: 0 };
  const bindings = (await all(data, 'run_events', { tenant_id: input.tenantId, type: BINDING_EVENT }))
    .map(event => obj(event.payload)).filter(binding => binding.socialTaskId === input.taskId && binding.artifactId === input.artifactId);
  for (const postId of [...new Set(input.postIds)]) {
    const post = await data.getById<Record_>('posts', postId);
    const stats = obj(post?.stats), source = obj(stats.publishSourceClaim);
    if (!post || post.tenant_id !== input.tenantId || source.sourceKind !== 'social_content_artifact'
      || source.projectId !== input.taskId || source.artifactId !== input.artifactId) {
      outcome.pending++; continue;
    }
    const accountIds = array(stats.targetAccountIds).filter((id): id is string => typeof id === 'string');
    for (const accountId of accountIds) {
      const result = obj(obj(stats.publishResults)[accountId]);
      if (result.status !== 'published' || !text(result.platformPostId)
        || !Number.isFinite(Date.parse(text(result.publishedAt)))
        || !bindings.some(binding => binding.businessRunId === stats.workflowRunId && binding.accountId === accountId && binding.grantId === stats.managedPublishingGrantId)) {
        outcome.pending++; continue;
      }
      const task = await readTask(input);
      const delivery = task?.deliveryPackages.find(item => item.artifactIds.includes(input.artifactId));
      if (!task || !delivery) { outcome.pending++; continue; }
      const marker = `managed-post:${postId}:${accountId}`;
      if (task.publications.some(item => item.notes === marker && item.platformPostId === result.platformPostId)) continue;
      const labels = array(stats.targetAccountLabels);
      await register({ repository: input.repository, tenantId: input.tenantId, taskId: input.taskId,
        userId: 'system:managed-publishing', idempotencyKey: marker,
        value: { expectedTaskVersion: task.version, packageId: delivery.packageId,
          platform: text(post.platform), accountLabel: text(labels[accountIds.indexOf(accountId)]) || accountId,
          platformPostId: result.platformPostId, publicUrl: text(result.platformUrl) || null,
          publishedAt: result.publishedAt, notes: marker } });
      outcome.registered++;
    }
  }
  return outcome;
}
