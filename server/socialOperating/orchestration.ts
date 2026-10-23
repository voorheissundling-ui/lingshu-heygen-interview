import { createHash } from 'node:crypto';
import {naturalWeek} from '../../shared/naturalWeek.js';
import type {
  BusinessGoalBuildInput,
  ConversionRouteInput,
  EnterpriseOperatingInput,
  OperatingAuthoritySnapshot,
  OperatingCapabilityKey,
  OperatingCapabilityState,
  OperatingPlanningRequest,
  OperatingPlanningResolution,
  SocialOperatingConstraints,
} from '../../shared/contracts/socialOperatingDecision.js';
import type { OwnedSocialAccount, SocialProgram, VersionedSocialRef, WeeklyOperatingPackage } from '../../shared/contracts/socialProgram.js';
import type { DataStore } from '../storage/datastore.js';
import { normalizeDigitalEmployeeConfig, type DigitalEmployeeConfig } from '../digitalEmployees/domain.js';
import { resolveAutomationPolicy } from './automationPolicyResolver.js';
import { deterministicFingerprint } from './businessGoalBuilder.js';
import { planCapacity } from './capacityPlanner.js';
import { resolveReferenceMode } from './referenceModeResolver.js';
import { evaluateProductionOutlineReadiness } from './productionReadiness.js';
import { createSocialOperatingRepository } from './repository.js';
import { createSocialOperatingDecisionService, SocialOperatingDecisionError } from './service.js';

type Row = Record<string, unknown> & { id: string };
type ProgramRow = Row & { payload: SocialProgram };
type AccountRow = Row & { payload: OwnedSocialAccount };
type Profile = {
  company?: { name?: string; mainMarkets?: string; primaryLanguages?: string; description?: string };
  products?: { categories?: string; certifications?: string; highlights?: string; items?: Array<Record<string, unknown>> };
  brand?: { taboos?: string; usp?: string; preferredLanguages?: string };
  strategy?: { currentGoal?: string; focusProducts?: string; focusMarkets?: string };
  customers?: { targetProfiles?: string };
  operations?: { riskNotes?: string };
};

const text = (value: unknown, max = 1_000) => String(value ?? '').trim().slice(0, max);
const split = (value: unknown) => [...new Set(text(value, 4_000).split(/[\n,\uff0c;\uff1b\u3001]/).map(item => item.trim()).filter(Boolean))].sort();
const ref = (type: string, id: string, version: number): VersionedSocialRef => ({ type, id, version });
const stableId = (prefix: string, value: unknown) => `${prefix}_${createHash('sha256').update(deterministicFingerprint(value)).digest('hex').slice(0, 24)}`;
const finite = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

function profileFrom(row: Row | undefined): Profile {
  let value = row?.profile;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return {}; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Profile : {};
}

function sourceVersion(row: Row | undefined, fallback = 1): number {
  for (const value of [row?.version, row?.config_version]) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

function assets(profile: Profile): number {
  return (profile.products?.items ?? []).reduce<number>((sum, item) => sum + [
    item.images, item.videos, item.documents, item.factoryImages, item.packagingImages,
    item.certificateImages, item.sceneImages, item.brandAssets,
  ].reduce<number>((count, value) => count + (Array.isArray(value) ? value.length : 0), 0), 0);
}

function routeKind(value: string): ConversionRouteInput['kind'] {
  if (value === 'whatsapp') return 'whatsapp';
  if (value === 'direct_message' || value === 'comment') return 'direct_message';
  if (value === 'form') return 'form';
  if (value === 'profile_link' || value === 'store') return 'website';
  return 'other';
}

function normalizeMode(value: unknown): 'suggest' | 'collaborate' | 'managed' {
  return value === 'suggest' || value === 'collaborate' ? value : 'managed';
}

function validateWeekStart(value: unknown): string {
  const date = text(value, 10);
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new SocialOperatingDecisionError('week_start_invalid', 400, '周起始日期必须使用 YYYY-MM-DD。');
  }
  return naturalWeek(date).start;
}

export function createSocialOperatingOrchestrationService(
  dataStore: DataStore,
  clock: () => string = () => new Date().toISOString(),
) {
  const repository = createSocialOperatingRepository(dataStore);
  const goals = createSocialOperatingDecisionService(dataStore, clock);

  async function requiredProgram(tenantId: string, programId: string): Promise<ProgramRow> {
    const result = await dataStore.list<ProgramRow>('social_programs', { where: { tenant_id: tenantId, program_id: programId }, page: 1, perPage: 2 });
    if (result.items.length !== 1) throw new SocialOperatingDecisionError(result.items.length ? 'program_integrity_violation' : 'program_not_found', result.items.length ? 503 : 404, '社媒项目不存在或记录不唯一。');
    return result.items[0]!;
  }

  return {
    async getConstraints(tenantId: string, programId: string): Promise<SocialOperatingConstraints | null> {
      await requiredProgram(tenantId, programId);
      return repository.latestConstraints(tenantId, programId);
    },

    async saveConstraints(tenantId: string, userId: string, programId: string, input: Record<string, unknown>): Promise<SocialOperatingConstraints> {
      await requiredProgram(tenantId, programId);
      const accountRows = await dataStore.list<AccountRow>('social_owned_accounts', { where: { tenant_id: tenantId, program_id: programId }, page: 1, perPage: 101 });
      const accounts = accountRows.items.map(item => item.payload).filter(item => item.status !== 'retired');
      const capacity = input.accountWeeklyPublicationCapacity && typeof input.accountWeeklyPublicationCapacity === 'object' && !Array.isArray(input.accountWeeklyPublicationCapacity)
        ? input.accountWeeklyPublicationCapacity as Record<string, unknown> : {};
      const allowed = new Set(accounts.map(item => item.accountId));
      if (Object.keys(capacity).some(id => !allowed.has(id))) throw new SocialOperatingDecisionError('account_capacity_out_of_scope', 400, '账号容量包含不属于当前项目的账号。');
      const numericKeys = [
        'weeklyBudgetCny', 'costPerOriginalCny', 'costPerAdaptationCny', 'materialUnitsPerOriginal',
        'productionItemsPerDay', 'interactionItemsPerWeek', 'salesLeadsPerWeek',
        'expectedInteractionsPerPublication', 'expectedLeadsPerPublication',
      ] as const;
      const values = Object.fromEntries(numericKeys.map(key => [key, finite(input[key])])) as Record<typeof numericKeys[number], number | null>;
      if (Object.values(values).some(value => value === null) || Object.values(capacity).some(value => finite(value) === null)) {
        throw new SocialOperatingDecisionError('operating_constraints_invalid', 400, '预算与容量事实必须是非负有限数值。');
      }
      const current = await repository.latestConstraints(tenantId, programId);
      const expected = Number(input.expectedVersion ?? 0);
      if (expected !== (current?.version ?? 0)) throw new SocialOperatingDecisionError('version_conflict', 409, `经营约束已更新，当前版本为 ${current?.version ?? 0}。`);
      const version = (current?.version ?? 0) + 1;
      const constraints: SocialOperatingConstraints = {
        constraintsId: current?.constraintsId ?? stableId('constraints', { tenantId, programId }), programId, version,
        weeklyBudgetCny: values.weeklyBudgetCny!, costPerOriginalCny: values.costPerOriginalCny!,
        costPerAdaptationCny: values.costPerAdaptationCny!, materialUnitsPerOriginal: values.materialUnitsPerOriginal!,
        productionItemsPerDay: values.productionItemsPerDay!, interactionItemsPerWeek: values.interactionItemsPerWeek!,
        salesLeadsPerWeek: values.salesLeadsPerWeek!, expectedInteractionsPerPublication: values.expectedInteractionsPerPublication!,
        expectedLeadsPerPublication: values.expectedLeadsPerPublication!,
        accountWeeklyPublicationCapacity: Object.fromEntries(Object.entries(capacity).sort(([a], [b]) => a.localeCompare(b)).map(([id, value]) => [id, finite(value)!])),
        sourceRefs: accounts.map(item => ref('owned_social_account', item.accountId, item.version)), createdBy: userId, createdAt: clock(),
      };
      await repository.saveConstraints(tenantId, constraints);
      return constraints;
    },

    async getSnapshot(tenantId: string, programId: string, snapshotId: string, version?: number): Promise<OperatingAuthoritySnapshot> {
      const snapshot = await repository.getSnapshot(tenantId, programId, snapshotId, version);
      if (!snapshot) throw new SocialOperatingDecisionError('operating_snapshot_not_found', 404, '经营编排快照不存在。');
      return snapshot;
    },

    async resolve(tenantId: string, userId: string, programId: string, request: OperatingPlanningRequest, producerOriginal?:{key:string;recoveryOnly?:boolean}): Promise<OperatingPlanningResolution> {
      const weekStart = validateWeekStart(request.weekStart);
      request={...request,weekStart};
      const producerHash=producerOriginal?deterministicFingerprint({tenantId,userId,programId,request}):null;
      if(producerOriginal){
        if(!producerOriginal.key)throw Error('weekly_outline_original_key_required');
        const rows=await dataStore.list<Row>('social_operating_authority_snapshots',{where:{tenant_id:tenantId,program_id:programId},perPage:1000});if(rows.totalItems!==rows.items.length)throw Error('weekly_outline_original_scan_incomplete');
        const matches=rows.items.filter(r=>(r.payload as OperatingAuthoritySnapshot & {weeklyProducer?:{key:string}})?.weeklyProducer?.key===producerOriginal.key);if(matches.length>1)throw Error('weekly_outline_original_not_unique');
        if(matches[0]){const snapshot=matches[0].payload as OperatingAuthoritySnapshot & {weeklyProducer:{key:string;inputHash:string}};if(matches[0].tenant_id!==tenantId||matches[0].program_id!==programId||snapshot.programId!==programId||snapshot.weeklyProducer.inputHash!==producerHash||snapshot.planningWeekStart!==request.weekStart)throw Error('weekly_outline_original_scope_changed');
          const [goal,capacity,automation,reference]=await Promise.all([goals.getGoal(tenantId,programId,snapshot.businessContentGoalRef.id,snapshot.businessContentGoalRef.version),repository.getOperatingDecision<OperatingPlanningResolution['capacityPlan']>(tenantId,programId,snapshot.capacityPlanRef.id),repository.getOperatingDecision<OperatingPlanningResolution['automationPolicy']>(tenantId,programId,snapshot.automationPolicyRef.id),repository.getOperatingDecision<OperatingPlanningResolution['referenceMode']>(tenantId,programId,snapshot.referenceModeRef.id)]);if(!capacity||!automation||!reference)throw Error('weekly_outline_original_evidence_missing');return {snapshot,goal,capacityPlan:capacity.output,automationPolicy:automation.output,referenceMode:reference.output};
        }
        if(producerOriginal.recoveryOnly)throw Error('weekly_outline_original_write_unknown');
      }

      const [programRow, profileRows, accountRows, configRows, studioRows, constraints, previous] = await Promise.all([
        requiredProgram(tenantId, programId),
        dataStore.list<Row>('tenant_profiles', { where: { tenant_id: tenantId }, page: 1, perPage: 2 }),
        dataStore.list<AccountRow>('social_owned_accounts', { where: { tenant_id: tenantId, program_id: programId }, sort: 'created_at', page: 1, perPage: 101 }),
        dataStore.list<Row>('digital_employee_configs', { where: { tenant_id: tenantId }, sort: '-updated_at', page: 1, perPage: 2 }),
        dataStore.list<Row>('studio_production_defaults', { where: { tenant_id: tenantId }, page: 1, perPage: 2 }),
        repository.latestConstraints(tenantId, programId),
        repository.latestSnapshot(tenantId, programId),
      ]);
      if (profileRows.items.length > 1 || configRows.items.length > 1 || studioRows.items.length > 1 || accountRows.totalItems > accountRows.items.length) {
        throw new SocialOperatingDecisionError('authority_integrity_violation', 503, '权威经营输入记录不唯一或读取不完整。');
      }
      if (request.expectedSnapshotVersion !== undefined && request.expectedSnapshotVersion !== (previous?.version ?? 0)) {
        throw new SocialOperatingDecisionError('version_conflict', 409, `经营编排快照已更新，当前版本为 ${previous?.version ?? 0}。`);
      }
      const profileRow = profileRows.items[0];
      const profile = profileFrom(profileRow);
      const configRow = configRows.items[0];
      const config = normalizeDigitalEmployeeConfig((configRow?.config && typeof configRow.config === 'object' ? configRow.config : {}) as Partial<DigitalEmployeeConfig>);
      const accounts = accountRows.items.map(item => item.payload).filter(item => item.status !== 'retired');
      const enterprisePayload = {
        products: split(profile.strategy?.focusProducts).length ? split(profile.strategy?.focusProducts)
          : [...new Set((profile.products?.items ?? []).map(item => text(item.name, 200)).filter(Boolean).concat(split(profile.products?.categories)))].sort(),
        markets: split(profile.strategy?.focusMarkets).length ? split(profile.strategy?.focusMarkets) : split(profile.company?.mainMarkets || programRow.payload.market),
        audiences: split(profile.customers?.targetProfiles).length ? split(profile.customers?.targetProfiles) : split(programRow.payload.targetAudience),
        languages: split(profile.company?.primaryLanguages || profile.brand?.preferredLanguages || config.videoLanguages.join(',')),
        prohibitedClaims: [...new Set([...split(profile.brand?.taboos), ...split(profile.operations?.riskNotes)])].sort(),
      };
      const factStatements = [
        text(profile.company?.description), text(profile.brand?.usp), text(profile.products?.highlights), text(profile.products?.certifications),
        ...(profile.products?.items ?? []).flatMap(item => [text(item.name), text(item.highlights), text(item.certifications)]),
      ].filter(Boolean);
      const enterpriseComparable = { ...enterprisePayload, weeklyBudgetCny: constraints?.weeklyBudgetCny ?? null, salesOwnerId: text(accounts.find(item => item.conversionRoute?.handoffTarget)?.conversionRoute?.handoffTarget || config.approvalOwner) || null };
      const previousComparable = previous ? { ...previous.enterprise, ref: undefined, publicFacts: previous.enterprise.publicFacts.map(item => ({ statement: item.statement })) } : null;
      const nextComparable = { ...enterpriseComparable, publicFacts: [...new Set(factStatements)].sort().map(statement => ({ statement })) };
      const changed = !previousComparable || deterministicFingerprint(previousComparable) !== deterministicFingerprint(nextComparable);
      const enterpriseVersion = previous ? previous.enterprise.ref.version + (changed ? 1 : 0) : sourceVersion(profileRow);
      const enterpriseRef = ref('enterprise_operating_snapshot', stableId('enterprise', { tenantId, programId }), enterpriseVersion);
      const publicFacts = [...new Set(factStatements)].sort().map(statement => ({
        ref: ref('enterprise_fact', stableId('fact', { enterpriseId: enterpriseRef.id, statement }), enterpriseVersion), statement,
      }));
      const enterprise: EnterpriseOperatingInput = { ref: enterpriseRef, ...enterpriseComparable, publicFacts };
      const conversionRoutes = accounts.flatMap(account => account.conversionRoute ? [{
        ref: ref('conversion_route', account.conversionRoute.routeId, account.playbookRef?.version ?? account.version),
        routeId: account.conversionRoute.routeId, kind: routeKind(account.conversionRoute.entryType),
        target: account.conversionRoute.entryRef || account.conversionRoute.callToAction || null,
        verified: Boolean(account.conversionRoute.verifiedAt),
      } satisfies ConversionRouteInput] : []);
      const goalInput: BusinessGoalBuildInput = {
        programRef: ref('social_program', programId, programRow.payload.version), enterprise,
        accounts: accounts.map(account => ({ ref: ref('owned_social_account', account.accountId, account.version), accountId: account.accountId, platform: account.platform, role: account.businessRole, status: account.status, conversionRouteId: account.conversionRoute?.routeId ?? null })),
        conversionRoutes,
        objective: text(profile.strategy?.currentGoal) || undefined,
      };
      const legacyGoal = previous ? null : await repository.latestGoal(tenantId, programId);
      const goalResult = await goals.buildAndSave({
        tenantId, operator: { type: 'user', id: userId }, input: goalInput,
        ...(previous && changed ? { previousEnterprise: previous.enterprise } : {}),
        expectedVersion: previous ? previous.businessContentGoalRef.version : legacyGoal?.version ?? 0,
      });
      const goal = goalResult.goal;
      const configRef = configRow ? ref('digital_employee_config', text(configRow.id), sourceVersion(configRow)) : null;
      const studioRef = studioRows.items[0] ? ref('studio_production_defaults', text(studioRows.items[0].id), sourceVersion(studioRows.items[0])) : null;
      const activeConfig = text(configRow?.status) === 'active' && Boolean(text(configRow?.activated_at));
      const capabilityStates: Record<OperatingCapabilityKey, OperatingCapabilityState> = {
        // The workflow configuration proves that the studio production system
        // is enabled. A missing default presenter/voice is a shot-level input
        // exception handled by the existing production adapter and decision
        // card; it must not disable factory/product/local-material production
        // or prevent the package from reaching that auditable exception.
        'studio.production': activeConfig && config.enabledWorkflows.some(item => item === 'product_content' || item === 'material_content' || item === 'viral_clone') ? 'available' : configRow ? 'unavailable' : 'unknown',
        'publishing.calendar': activeConfig && config.enabledWorkflows.includes('content_publish') && config.publishingTargets.length > 0 ? 'available' : configRow ? 'unavailable' : 'unknown',
        'customer.attribution': activeConfig && config.enabledWorkflows.includes('customer_segmentation') && conversionRoutes.some(item => item.verified) ? 'available' : configRow ? 'unavailable' : 'unknown',
      };
      const capabilitySourceRefs: OperatingAuthoritySnapshot['capabilitySourceRefs'] = {
        'studio.production': [configRef, studioRef].filter((item): item is VersionedSocialRef => Boolean(item)),
        'publishing.calendar': [configRef, ...accounts.map(item => ref('owned_social_account', item.accountId, item.version))].filter((item): item is VersionedSocialRef => Boolean(item)),
        'customer.attribution': [configRef, ...conversionRoutes.map(item => item.ref)].filter((item): item is VersionedSocialRef => Boolean(item)),
      };
      const options = { operator: { type: 'system' as const, id: 'social-operating-orchestrator' }, decidedAt: clock() };
      const capacity = planCapacity({
        goal, desiredOriginalContents: Number.isSafeInteger(request.desiredOriginalContents) ? Math.max(0, Number(request.desiredOriginalContents)) : 10,
        desiredAdaptations: Number.isSafeInteger(request.desiredAdaptations) ? Math.max(0, Number(request.desiredAdaptations)) : 16,
        costPerOriginalCny: constraints?.costPerOriginalCny ?? null, costPerAdaptationCny: constraints?.costPerAdaptationCny ?? null,
        readyMaterialUnits: profileRow ? assets(profile) : null, materialUnitsPerOriginal: constraints?.materialUnitsPerOriginal ?? null,
        productionItemsPerDay: constraints?.productionItemsPerDay ?? null, daysUntilDeadline: 7,
        accounts: accounts.map(account => ({ ref: ref('owned_social_account', account.accountId, account.version), accountId: account.accountId, status: account.status, weeklyPublicationCapacity: constraints?.accountWeeklyPublicationCapacity[account.accountId] ?? null })),
        interactionItemsPerWeek: constraints?.interactionItemsPerWeek ?? null, salesLeadsPerWeek: constraints?.salesLeadsPerWeek ?? null,
        expectedInteractionsPerPublication: constraints?.expectedInteractionsPerPublication ?? null, expectedLeadsPerPublication: constraints?.expectedLeadsPerPublication ?? null,
        capabilities: capabilityStates,
      }, options);
      const automation = resolveAutomationPolicy({
        goal, mode: normalizeMode(config.autonomyMode), action: 'draft', capability: { key: 'studio.production', availability: capabilityStates['studio.production'] },
        factsVerified: goal.status === 'ready' || evaluateProductionOutlineReadiness(goal).ready, withinBudget: capacity.plan.status !== 'blocked', rightsSufficient: true,
      }, options);
      let referenceRef = request.referenceSelectionRef ?? ref('inspiration_inventory', programId, 1);
      let referenceRights: 'authorized' | 'restricted' | 'unknown' = 'restricted';
      let exactAnalysis: 'available' | 'unavailable' | 'unknown' = 'unavailable';
      if (request.referenceSelectionRef) {
        if (request.referenceSelectionRef.type !== 'reference_selection' || !text(request.referenceSelectionRef.id) || !Number.isSafeInteger(request.referenceSelectionRef.version) || request.referenceSelectionRef.version < 1) {
          throw new SocialOperatingDecisionError('reference_selection_ref_invalid', 400, '参考选择引用类型无效。');
        }
        const selectionRows = await dataStore.list<Row>('social_reference_selections', { where: { tenant_id: tenantId, selectionId: request.referenceSelectionRef.id, version: request.referenceSelectionRef.version }, page: 1, perPage: 2 });
        const selection = selectionRows.items[0];
        if (!selection || selectionRows.items.length !== 1) throw new SocialOperatingDecisionError('reference_selection_not_found', 404, '参考选择不存在。');
        const selected = Array.isArray(selection.selected) ? selection.selected[0] as Record<string, unknown> | undefined : undefined;
        referenceRights = selected?.rightsClear === true ? 'authorized' : selected ? 'restricted' : 'unknown';
        exactAnalysis = selected?.readiness === 'production_reference' ? 'available' : selected ? 'unavailable' : 'unknown';
        referenceRef = request.referenceSelectionRef;
      }
      const reference = resolveReferenceMode({
        goal, requestedMode: request.requestedReferenceMode ?? 'auto', referenceRef, referenceRights, exactAnalysis,
        productionCapability: capabilityStates['studio.production'], estimatedCostCny: constraints?.costPerAdaptationCny ?? null,
        remainingBudgetCny: constraints ? Math.max(0, constraints.weeklyBudgetCny - capacity.plan.estimatedCostCny) : null,
      }, options);
      await Promise.all([
        repository.saveOperatingDecision(tenantId, programId, capacity.decision as never),
        repository.saveOperatingDecision(tenantId, programId, automation.decision as never),
        repository.saveOperatingDecision(tenantId, programId, reference.decision as never),
      ]);
      const version = (previous?.version ?? 0) + 1;
      const impacts = goalResult.decision.impacts;
      const invalidations: OperatingAuthoritySnapshot['invalidations'] = [];
      if (previous && impacts.length) {
        invalidations.push({ ref: ref('operating_authority_snapshot', previous.snapshotId, previous.version), reason: '企业关键事实已变化，旧快照仅可审计，不得用于新周包。', handling: 'new_work_only' });
        const packages = await dataStore.list<{ payload: WeeklyOperatingPackage }>('social_weekly_operating_packages', { where: { tenant_id: tenantId, program_id: programId }, page: 1, perPage: 300 });
        for (const row of packages.items.filter(item => item.payload.status === 'draft' || item.payload.status === 'active')) {
          if (row.payload.businessContentGoalRef?.version === goal.version) continue;
          invalidations.push({ ref: ref('weekly_operating_package', row.payload.packageId, row.payload.version), reason: '周包仍引用企业变化前的经营目标；继续执行前需按影响范围复核。', handling: 'review_required' });
        }
      }
      const decisionRefs = [
        goal.decisionRecordRef,
        ref('decision_record', capacity.decision.decisionId, 1),
        ref('decision_record', automation.decision.decisionId, 1),
        ref('decision_record', reference.decision.decisionId, 1),
      ];
      const productionOnlyReady=evaluateProductionOutlineReadiness(goal).ready&&capacity.plan.status!=='blocked'&&automation.policy.automaticExecutionAllowed;
      // A production-only snapshot may be degraded while conversion routes,
      // publishing or a concrete reference selection remain unresolved. It is
      // sufficient only for draft production; the weekly package continues to
      // carry no publishing, acceptance or customer-message authorization.
      const status = productionOnlyReady
        ? 'degraded' as const
        : goal.status === 'blocked' || capacity.plan.status === 'blocked' || automation.policy.status === 'blocked' || reference.resolution.status === 'blocked'
          ? 'blocked' as const : capacity.plan.status === 'degraded' || automation.policy.status === 'approval_required' || reference.resolution.status === 'degraded' ? 'degraded' as const : 'ready' as const;
      const snapshot: OperatingAuthoritySnapshot = {
        snapshotId: stableId('operating_snapshot', { tenantId, programId }), programId, version, status, planningWeekStart: weekStart,
        programRef: ref('social_program', programId, programRow.payload.version), enterprise,
        accountRefs: accounts.map(item => ref('owned_social_account', item.accountId, item.version)),
        conversionRouteRefs: conversionRoutes.map(item => item.ref),
        constraintsRef: constraints ? ref('social_operating_constraints', constraints.constraintsId, constraints.version) : null,
        capabilityStates, capabilitySourceRefs,
        businessContentGoalRef: ref('business_content_goal', goal.goalId, goal.version),
        capacityPlanRef: ref('capacity_plan', capacity.decision.decisionId, 1),
        automationPolicyRef: ref('automation_policy', automation.decision.decisionId, 1),
        referenceModeRef: ref('reference_mode', reference.decision.decisionId, 1),
        decisionRefs, impacts, invalidations,
        inputFingerprint: deterministicFingerprint({ weekStart, goal: goal.inputFingerprint, constraints, capabilities: capabilityStates, referenceRef, request: { desiredOriginalContents: request.desiredOriginalContents, desiredAdaptations: request.desiredAdaptations, requestedReferenceMode: request.requestedReferenceMode } }),
        createdBy: userId, createdAt: options.decidedAt,
      };
      const storedSnapshot=producerOriginal?{...snapshot,weeklyProducer:{key:producerOriginal.key,inputHash:producerHash}}:snapshot;
      await repository.saveSnapshot(tenantId, storedSnapshot);
      return { snapshot, goal, capacityPlan: capacity.plan, automationPolicy: automation.policy as OperatingPlanningResolution['automationPolicy'], referenceMode: reference.resolution };
    },
  };
}

export function weeklyAuthorityFromResolution(resolution: OperatingPlanningResolution) {
  return {
    operatingDecisionSnapshotRef: ref('operating_authority_snapshot', resolution.snapshot.snapshotId, resolution.snapshot.version),
  };
}
