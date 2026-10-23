import { randomUUID } from 'node:crypto';
import type { DataStore } from '../storage/datastore.js';
import {
  EMPTY_SOCIAL_PROGRAM_READINESS,
  deriveSocialProgramStage,
  monthlyPlanActivationIssues,
  weeklyPlanActivationIssues,
  type AccountPlaybook,
  type OwnedSocialAccount,
  type SocialMonthlyPlan,
  type SocialPlatform,
  type SocialProgram,
  type SocialProgramReadiness,
  type SocialProgramRoute,
  type SocialWeeklyPlan,
  type VersionedSocialRef,
  type WeeklyContentItem,
} from '../../shared/contracts/socialProgram.js';

const PROGRAMS = 'social_programs';
const ACCOUNTS = 'social_owned_accounts';
const PLAYBOOKS = 'social_playbook_versions';
const PLANS = 'social_plan_versions';

type ProgramRow = { id: string; tenant_id: string; program_id: string; payload: SocialProgram };
type AccountRow = { id: string; tenant_id: string; program_id: string; account_id: string; payload: OwnedSocialAccount };
type PlaybookRow = { id: string; tenant_id: string; program_id: string; account_id: string; playbook_id: string; version: number; status: string; payload: AccountPlaybook };
type PlanRow = { id: string; tenant_id: string; program_id: string; plan_type: 'monthly' | 'weekly'; plan_id: string; version: number; status: string; payload: SocialMonthlyPlan | SocialWeeklyPlan };

export class SocialProgramError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message);
  }
}

const text = (value: unknown, max = 240) => String(value ?? '').trim().slice(0, max);
const unique = (values: unknown, max = 30) => Array.isArray(values)
  ? [...new Set(values.map(value => text(value, 120)).filter(Boolean))].slice(0, max)
  : [];
const finiteBudget = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new SocialProgramError('invalid_budget', 400, '预算必须是非负数。');
  return Math.round(parsed * 100) / 100;
};
const versionedRefs = (value: unknown, max = 100): VersionedSocialRef[] => (
  Array.isArray(value) ? value.slice(0, max).flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const type = text(record.type, 80);
    const id = text(record.id, 160);
    const version = Number(record.version);
    return type && id && Number.isSafeInteger(version) && version > 0 ? [{ type, id, version }] : [];
  }) : []
);
const routeValue = (value: unknown): SocialProgramRoute | null => (
  value === 'cold_start' || value === 'account_repair' ? value : null
);
const platformValues = (value: unknown): SocialPlatform[] => unique(value, 8).filter((platform): platform is SocialPlatform => (
  ['tiktok', 'instagram', 'youtube', 'facebook', 'douyin', 'xiaohongshu', 'other'].includes(platform)
));
const nowIso = () => new Date().toISOString();
const versionedRef = (type: string, id: string, version: number): VersionedSocialRef => ({ type, id, version });
const accountIdentity = (value: unknown) => text(value).replace(/^@/, '').toLowerCase().replace(/\s+/g, '');

type ConnectedSocialAccount = {
  id: string;
  platform?: string;
  providerAccountId?: string;
  title?: string;
  handle?: string;
  status?: string;
};

function matchingConnection(account: OwnedSocialAccount, candidates: ConnectedSocialAccount[]): ConnectedSocialAccount | null {
  const samePlatform = candidates.filter(candidate => candidate.platform === account.platform && candidate.status === 'connected');
  if (!samePlatform.length) return null;
  const identities = [account.handle, account.displayName].map(accountIdentity).filter(Boolean);
  const exact = samePlatform.filter(candidate => [candidate.handle, candidate.title, candidate.providerAccountId]
    .map(accountIdentity).some(candidateIdentity => identities.includes(candidateIdentity)));
  if (exact.length === 1) return exact[0];
  return samePlatform.length === 1 ? samePlatform[0] : null;
}

async function programRow(dataStore: DataStore, tenantId: string, programId: string): Promise<ProgramRow | null> {
  const result = await dataStore.list<ProgramRow>(PROGRAMS, {
    where: { tenant_id: tenantId, program_id: programId }, page: 1, perPage: 1,
  });
  return result.items[0] ?? null;
}

async function accountRow(dataStore: DataStore, tenantId: string, programId: string, accountId: string): Promise<AccountRow | null> {
  const result = await dataStore.list<AccountRow>(ACCOUNTS, {
    where: { tenant_id: tenantId, program_id: programId, account_id: accountId }, page: 1, perPage: 1,
  });
  return result.items[0] ?? null;
}

function requireVersion(actual: number, expected: unknown): void {
  const parsed = Number(expected);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new SocialProgramError('expected_version_required', 400, '写入必须提供 expectedVersion。');
  }
  if (actual !== parsed) {
    throw new SocialProgramError('version_conflict', 409, `数据已更新，当前版本为 ${actual}。`);
  }
}

export function createSocialProgramService(dataStore: DataStore) {
  return {
    async listPrograms(tenantId: string): Promise<SocialProgram[]> {
      const result = await dataStore.list<ProgramRow>(PROGRAMS, {
        where: { tenant_id: tenantId }, sort: '-updated_at', page: 1, perPage: 100,
      });
      return result.items.map(row => row.payload);
    },

    async getProgram(tenantId: string, programId: string): Promise<SocialProgram> {
      const row = await programRow(dataStore, tenantId, programId);
      if (!row) throw new SocialProgramError('program_not_found', 404, '社媒项目不存在。');
      return row.payload;
    },

    async createProgram(tenantId: string, userId: string, input: Record<string, unknown>): Promise<SocialProgram> {
      const brandName = text(input.brandName);
      const market = text(input.market);
      const targetAudience = text(input.targetAudience, 500);
      const candidatePlatforms = platformValues(input.candidatePlatforms);
      if (!brandName || !market || !targetAudience || !candidatePlatforms.length) {
        throw new SocialProgramError('foundation_required', 400, '请填写品牌、市场、目标受众和至少一个候选平台。');
      }
      const route = routeValue(input.route);
      if (input.route && !route) throw new SocialProgramError('invalid_route', 400, '路线只能是从零搭建或已有账号修复。');
      const duplicate = await dataStore.list<ProgramRow>(PROGRAMS, {
        where: { tenant_id: tenantId, brand_name: brandName, market, status: 'active' }, page: 1, perPage: 1,
      });
      if (duplicate.items[0]) throw new SocialProgramError('active_program_exists', 409, '同一品牌和市场已有活动项目。');
      const at = nowIso();
      const readiness: SocialProgramReadiness = { ...EMPTY_SOCIAL_PROGRAM_READINESS };
      const program: SocialProgram = {
        programId: randomUUID(), brandName, businessLine: text(input.businessLine) || null,
        market, targetAudience, candidatePlatforms, route,
        stage: deriveSocialProgramStage(route, readiness), readiness,
        enterpriseProfileRef: null, productMarketingProfileRefs: [],
        activeMonthlyPlanRef: null, activeWeeklyPlanRef: null,
        activeWeeklyOperatingPackageRef: null,
        version: 1, status: 'active', createdAt: at, updatedAt: at,
      };
      const saved = await dataStore.create<ProgramRow>(PROGRAMS, {
        tenant_id: tenantId, program_id: program.programId, version: program.version,
        status: program.status, stage: program.stage, route: program.route || '',
        brand_name: program.brandName, market: program.market, payload: program,
        created_by: userId, updated_by: userId, created_at: at, updated_at: at,
      });
      if (!saved) throw new SocialProgramError('program_storage_unavailable', 503, '社媒项目暂时无法保存。');
      return program;
    },

    async updateProgram(
      tenantId: string,
      userId: string,
      programId: string,
      input: Record<string, unknown>,
    ): Promise<SocialProgram> {
      const row = await programRow(dataStore, tenantId, programId);
      if (!row) throw new SocialProgramError('program_not_found', 404, '社媒项目不存在。');
      requireVersion(row.payload.version, input.expectedVersion);
      const route = input.route === undefined ? row.payload.route : routeValue(input.route);
      if (input.route !== undefined && !route) throw new SocialProgramError('invalid_route', 400, '路线只能是从零搭建或已有账号修复。');
      const readinessInput = input.readiness && typeof input.readiness === 'object'
        ? input.readiness as Partial<SocialProgramReadiness>
        : {};
      const readiness = { ...row.payload.readiness };
      for (const key of Object.keys(readiness) as Array<keyof SocialProgramReadiness>) {
        if (typeof readinessInput[key] === 'boolean') readiness[key] = readinessInput[key] as boolean;
      }
      const at = nowIso();
      const next: SocialProgram = {
        ...row.payload,
        route,
        businessLine: input.businessLine === undefined ? row.payload.businessLine : text(input.businessLine) || null,
        targetAudience: input.targetAudience === undefined ? row.payload.targetAudience : text(input.targetAudience, 500),
        candidatePlatforms: input.candidatePlatforms === undefined ? row.payload.candidatePlatforms : platformValues(input.candidatePlatforms),
        readiness,
        stage: deriveSocialProgramStage(route, readiness),
        version: row.payload.version + 1,
        updatedAt: at,
      };
      if (!next.targetAudience || !next.candidatePlatforms.length) {
        throw new SocialProgramError('foundation_required', 400, '目标受众和候选平台不能为空。');
      }
      const saved = await dataStore.update(PROGRAMS, row.id, {
        version: next.version, stage: next.stage, route: next.route || '', payload: next,
        updated_by: userId, updated_at: at,
      });
      if (!saved) throw new SocialProgramError('program_storage_unavailable', 503, '社媒项目暂时无法保存。');
      return next;
    },

    async listAccounts(tenantId: string, programId: string): Promise<OwnedSocialAccount[]> {
      if (!await programRow(dataStore, tenantId, programId)) {
        throw new SocialProgramError('program_not_found', 404, '社媒项目不存在。');
      }
      const result = await dataStore.list<AccountRow>(ACCOUNTS, {
        where: { tenant_id: tenantId, program_id: programId }, sort: 'created_at', page: 1, perPage: 100,
      });
      const connected = await dataStore.list<ConnectedSocialAccount>('social_accounts', {
        where: { tenantId, status: 'connected' }, page: 1, perPage: 200,
      }).then(response => response.items).catch(() => []);
      const resolved: OwnedSocialAccount[] = [];
      for (const row of result.items) {
        const connection = matchingConnection(row.payload, connected);
        const connectionId = connection?.id || null;
        const capabilities = connection
          ? ['publish', 'read_metrics', ...(connection.platform === 'facebook' ? ['messenger'] : [])]
          : [];
        if (row.payload.connectionId !== connectionId || JSON.stringify(row.payload.connectionCapabilities) !== JSON.stringify(capabilities)) {
          const next = { ...row.payload, connectionId, connectionCapabilities: capabilities, updatedAt: nowIso() };
          await dataStore.update(ACCOUNTS, row.id, { payload: next, updated_at: next.updatedAt });
          resolved.push(next);
        } else resolved.push(row.payload);
      }
      return resolved;
    },

    async createAccount(tenantId: string, userId: string, programId: string, input: Record<string, unknown>): Promise<OwnedSocialAccount> {
      if (!await programRow(dataStore, tenantId, programId)) {
        throw new SocialProgramError('program_not_found', 404, '社媒项目不存在。');
      }
      const platform = platformValues([input.platform])[0];
      const displayName = text(input.displayName);
      const businessRole = text(input.businessRole, 200);
      const audiencePromise = text(input.audiencePromise, 500);
      const contentPromise = text(input.contentPromise, 500);
      if (!platform || !displayName || !businessRole || !audiencePromise || !contentPromise) {
        throw new SocialProgramError('account_definition_required', 400, '账号必须包含平台、名称、业务角色、受众承诺和内容承诺。');
      }
      const at = nowIso();
      const account: OwnedSocialAccount = {
        accountId: randomUUID(), programId, platform, displayName,
        handle: text(input.handle) || null, businessRole, audiencePromise, contentPromise,
        status: 'planned', connectionId: null, connectionCapabilities: [], playbookRef: null,
        conversionRoute: null, version: 1, createdAt: at, updatedAt: at,
      };
      const saved = await dataStore.create<AccountRow>(ACCOUNTS, {
        tenant_id: tenantId, program_id: programId, account_id: account.accountId,
        platform, status: account.status, version: 1, payload: account,
        created_by: userId, updated_by: userId, created_at: at, updated_at: at,
      });
      if (!saved) throw new SocialProgramError('account_storage_unavailable', 503, '账号定义暂时无法保存。');
      return account;
    },

    async savePlaybook(tenantId: string, userId: string, programId: string, accountId: string, input: Record<string, unknown>): Promise<AccountPlaybook> {
      const accountRecord = await accountRow(dataStore, tenantId, programId, accountId);
      if (!accountRecord) throw new SocialProgramError('account_not_found', 404, '业务账号不存在。');
      requireVersion(accountRecord.payload.version, input.expectedAccountVersion);
      const conversion = input.conversionRoute && typeof input.conversionRoute === 'object'
        ? input.conversionRoute as Record<string, unknown>
        : {};
      const callToAction = text(conversion.callToAction, 500);
      const entryType = text(conversion.entryType);
      if (!callToAction || !['profile_link', 'comment', 'direct_message', 'store', 'form', 'whatsapp', 'other'].includes(entryType)) {
        throw new SocialProgramError('conversion_route_required', 400, '账号规则必须包含有效获客入口和 CTA。');
      }
      const existing = await dataStore.list<PlaybookRow>(PLAYBOOKS, {
        where: { tenant_id: tenantId, program_id: programId, account_id: accountId }, sort: '-version', page: 1, perPage: 1,
      });
      const version = Number(existing.items[0]?.version || 0) + 1;
      const at = nowIso();
      const playbook: AccountPlaybook = {
        playbookId: existing.items[0]?.playbook_id || randomUUID(), programId, accountId, version,
        audience: unique(input.audience), pillars: unique(input.pillars), recurringFormats: unique(input.recurringFormats),
        presenterRules: unique(input.presenterRules), visualRules: unique(input.visualRules),
        evidenceRules: unique(input.evidenceRules), languageRules: unique(input.languageRules),
        fixedFactors: unique(input.fixedFactors), experimentFactors: unique(input.experimentFactors),
        conversionRoute: {
          routeId: text(conversion.routeId) || randomUUID(),
          entryType: entryType as AccountPlaybook['conversionRoute']['entryType'],
          entryRef: text(conversion.entryRef, 500) || null,
          callToAction,
          qualificationFields: unique(conversion.qualificationFields),
          handoffTarget: text(conversion.handoffTarget) || null,
          verifiedAt: text(conversion.verifiedAt) || null,
        },
        sourceRefs: versionedRefs(input.sourceRefs),
        status: input.activate === true ? 'active' : 'draft', createdAt: at,
      };
      if (!playbook.audience.length || !playbook.pillars.length || !playbook.evidenceRules.length) {
        throw new SocialProgramError('playbook_rules_required', 400, '账号规则至少需要受众、栏目和证据规则。');
      }
      if (input.activate === true && existing.items[0]?.status === 'active') {
        await dataStore.update(PLAYBOOKS, existing.items[0].id, { status: 'retired' });
      }
      const saved = await dataStore.create<PlaybookRow>(PLAYBOOKS, {
        tenant_id: tenantId, program_id: programId, account_id: accountId,
        playbook_id: playbook.playbookId, version, status: playbook.status, payload: playbook,
        created_by: userId, created_at: at,
      });
      if (!saved) throw new SocialProgramError('playbook_storage_unavailable', 503, '账号规则暂时无法保存。');
      // A draft is not the account's executable rule version. Keep the active
      // reference and conversion route until explicit activation.
      if (input.activate !== true) return playbook;
      const account = { ...accountRecord.payload, playbookRef: versionedRef('account_playbook', playbook.playbookId, version), conversionRoute: playbook.conversionRoute, version: accountRecord.payload.version + 1, updatedAt: at };
      if (!await dataStore.update(ACCOUNTS, accountRecord.id, { payload: account, version: account.version, status: account.status, updated_by: userId, updated_at: at })) {
        await dataStore.update(PLAYBOOKS, saved.id, { status: 'retired' });
        throw new SocialProgramError('account_storage_unavailable', 503, '账号规则已回滚，请稍后重试。');
      }
      return playbook;
    },

    async saveMonthlyPlan(tenantId: string, userId: string, programId: string, input: Record<string, unknown>): Promise<SocialMonthlyPlan> {
      const row = await programRow(dataStore, tenantId, programId);
      if (!row) throw new SocialProgramError('program_not_found', 404, '社媒项目不存在。');
      requireVersion(row.payload.version, input.expectedProgramVersion);
      if (input.activate === true) {
        const issues = monthlyPlanActivationIssues(row.payload);
        if (issues.length) throw new SocialProgramError('activation_blocked', 409, issues.map(issue => issue.message).join(' '));
      }
      const existing = await dataStore.list<PlanRow>(PLANS, {
        where: { tenant_id: tenantId, program_id: programId, plan_type: 'monthly' }, sort: '-created_at', page: 1, perPage: 1,
      });
      const version = Number(existing.items[0]?.version || 0) + 1;
      const at = nowIso();
      const plan: SocialMonthlyPlan = {
        planId: input.planId ? text(input.planId) : randomUUID(), programId, version,
        month: text(input.month), objective: text(input.objective, 1000), accountIds: unique(input.accountIds),
        priorityProductRefs: versionedRefs(input.priorityProductRefs),
        audiencePriorities: unique(input.audiencePriorities),
        contentMix: Array.isArray(input.contentMix) ? (input.contentMix as Array<{ format: string; count: number }>).filter(item => text(item?.format) && Number(item?.count) > 0) : [],
        experimentVariables: unique(input.experimentVariables), budgetLimitCny: finiteBudget(input.budgetLimitCny),
        successCriteria: unique(input.successCriteria), sourceRefs: versionedRefs(input.sourceRefs),
        status: input.activate === true ? 'active' : 'draft', createdAt: at,
      };
      if (!/^\d{4}-\d{2}$/.test(plan.month) || !plan.objective || !plan.accountIds.length || !plan.successCriteria.length) {
        throw new SocialProgramError('monthly_plan_incomplete', 400, '月计划必须包含月份、目标、账号和成功标准。');
      }
      const saved = await dataStore.create<PlanRow>(PLANS, {
        tenant_id: tenantId, program_id: programId, plan_type: 'monthly', plan_id: plan.planId,
        version, status: plan.status, payload: plan, created_by: userId, created_at: at,
      });
      if (!saved) throw new SocialProgramError('plan_storage_unavailable', 503, '月计划暂时无法保存。');
      if (plan.status === 'active') {
        const nextReadiness = { ...row.payload.readiness, monthlyPlanActive: true, weeklyPlanActive: false };
        const next = { ...row.payload, readiness: nextReadiness, activeMonthlyPlanRef: versionedRef('social_monthly_plan', plan.planId, version), activeWeeklyPlanRef: null, version: row.payload.version + 1, updatedAt: at };
        next.stage = deriveSocialProgramStage(next.route, nextReadiness);
        if (!await dataStore.update(PROGRAMS, row.id, { payload: next, version: next.version, stage: next.stage, updated_by: userId, updated_at: at })) {
          await dataStore.update(PLANS, saved.id, { status: 'retired' });
          throw new SocialProgramError('program_storage_unavailable', 503, '月计划激活失败，已保留为非活动版本。');
        }
      }
      return plan;
    },

    async saveWeeklyPlan(tenantId: string, userId: string, programId: string, input: Record<string, unknown>): Promise<SocialWeeklyPlan> {
      const row = await programRow(dataStore, tenantId, programId);
      if (!row) throw new SocialProgramError('program_not_found', 404, '社媒项目不存在。');
      requireVersion(row.payload.version, input.expectedProgramVersion);
      const monthlyRef = versionedRefs([input.monthlyPlanRef], 1)[0];
      if (!monthlyRef) throw new SocialProgramError('monthly_plan_ref_required', 400, '周计划必须绑定月计划版本。');
      const existing = await dataStore.list<PlanRow>(PLANS, {
        where: { tenant_id: tenantId, program_id: programId, plan_type: 'weekly' }, sort: '-created_at', page: 1, perPage: 1,
      });
      const version = Number(existing.items[0]?.version || 0) + 1;
      const at = nowIso();
      const items: WeeklyContentItem[] = Array.isArray(input.items) ? input.items.slice(0, 100).flatMap(value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
        const item = value as Record<string, unknown>;
        const productMarketingProfileRef = versionedRefs([item.productMarketingProfileRef], 1)[0];
        if (!productMarketingProfileRef) return [];
        return [{
          itemId: text(item.itemId) || randomUUID(),
          accountId: text(item.accountId),
          title: text(item.title, 300),
          contentTask: text(item.contentTask, 1000),
          cta: text(item.cta, 500),
          productMarketingProfileRef,
          referenceRefs: versionedRefs(item.referenceRefs),
          factRefs: versionedRefs(item.factRefs),
          dueAt: text(item.dueAt) || null,
          approvalPolicy: item.approvalPolicy === 'owner_approve' ? 'owner_approve' : 'user_confirm',
        }];
      }) : [];
      const plan: SocialWeeklyPlan = {
        planId: input.planId ? text(input.planId) : randomUUID(), programId,
        monthlyPlanRef: monthlyRef, version, weekStart: text(input.weekStart), items,
        budgetLimitCny: finiteBudget(input.budgetLimitCny), status: input.activate === true ? 'active' : 'draft', createdAt: at,
      };
      if (!/^\d{4}-\d{2}-\d{2}$/.test(plan.weekStart) || !plan.items.length) {
        throw new SocialProgramError('weekly_plan_incomplete', 400, '周计划必须包含周起始日期和至少一条内容。');
      }
      if (input.activate === true) {
        const issues = weeklyPlanActivationIssues(row.payload, plan);
        if (issues.length) throw new SocialProgramError('activation_blocked', 409, issues.map(issue => issue.message).join(' '));
      }
      const saved = await dataStore.create<PlanRow>(PLANS, {
        tenant_id: tenantId, program_id: programId, plan_type: 'weekly', plan_id: plan.planId,
        version, status: plan.status, payload: plan, created_by: userId, created_at: at,
      });
      if (!saved) throw new SocialProgramError('plan_storage_unavailable', 503, '周计划暂时无法保存。');
      if (plan.status === 'active') {
        const nextReadiness = { ...row.payload.readiness, weeklyPlanActive: true };
        const next = { ...row.payload, readiness: nextReadiness, activeWeeklyPlanRef: versionedRef('social_weekly_plan', plan.planId, version), version: row.payload.version + 1, updatedAt: at };
        next.stage = deriveSocialProgramStage(next.route, nextReadiness);
        if (!await dataStore.update(PROGRAMS, row.id, { payload: next, version: next.version, stage: next.stage, updated_by: userId, updated_at: at })) {
          await dataStore.update(PLANS, saved.id, { status: 'retired' });
          throw new SocialProgramError('program_storage_unavailable', 503, '周计划激活失败，已保留为非活动版本。');
        }
      }
      return plan;
    },
  };
}
