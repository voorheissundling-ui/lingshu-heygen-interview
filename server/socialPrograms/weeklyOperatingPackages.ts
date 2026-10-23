import {assertProfileUpgradeCreationInput,assertProfileUpgradePublicationWindow,findProfileUpgradeCreation,profileUpgradePublicationHash,profileUpgradeTargetHash,type ProfileUpgradeConsumption} from './profileUpgradeCreation.js';
import {socialRequestHash} from '../starter198/socialContentValidation.js';
import {createWeeklyInventoryReuseService,inventoryPublicationHash,assertInventoryMaterialContract} from './weeklyInventoryReuse.js';
import {createWeeklyProfileUpgradeService} from './weeklyProfileUpgrade.js';
import {assertExecutionPackageGate,withExecutionPackageGate} from './weeklyExecutionGate.js';
import {scheduleHash,readScheduleSnapshot} from './weeklyScheduleSnapshots.js';
import type {WeeklyScheduledPackage} from '../../shared/contracts/socialWeeklyScheduleRevision.js';
import { randomUUID } from 'node:crypto';
import {naturalWeek} from '../../shared/naturalWeek.js';
import type { DataStore } from '../storage/datastore.js';
import {
  type VersionedSocialRef,
  type WeeklyOperatingPackage,
  type WeeklyAgentPlanningMutation,
  type WeeklyWorkflowEvent,
} from '../../shared/contracts/socialProgram.js';
import type { VersionedQuotaReference } from '../../shared/contracts/socialReview.js';
import { SocialProgramError } from './service.js';
import { buildWeeklyWorkflow, type WeeklyAutomationPolicySnapshot, type WeeklyCapacitySnapshot } from './weeklyPlanner.js';
import { applyWorkflowEvent } from './workflowState.js';
import { createSocialOperatingRepository } from '../socialOperating/repository.js';
import type { CapacityPlan } from '../socialOperating/capacityPlanner.js';
import type { AutomationPolicyResolution } from '../socialOperating/automationPolicyResolver.js';
import {evaluateProductionOutlineReadiness} from '../socialOperating/productionReadiness.js';
import { rejectClientAuthorityObjects, resolveWeeklyAuthoritativePlanning } from './weeklyAuthoritativePlanning.js';
import {
  activateWeeklyExecutionTasks,
  applyBusinessDispatchToExecutionTasks,
  cancelWeeklyExecutionTasks,
  listWeeklyExecutionTasks,
  materializeWeeklyExecutionTasks,
  projectWeeklyExecution,
  summarizeWeeklyExecutionTasks,
} from './executionTasks.js';
import { enqueueAgentNotificationDomainEvent } from '../notifications/agentNotificationOutbox.js';
import { createWeeklyPlanningAuthority } from './planningAuthority.js';
import {
  PACKAGES, PROGRAMS, PROMOTION_QUOTAS, WEEKLY_REVIEWS, WORKFLOW_EVENTS,
  type PackageRow, type ProgramRow, type WorkflowEventRow,
  accountsForProgram, at, dateOnly, eventDigest,
  latestPackageRow, packageFromInput, programRow, projectWorkflowState,
  requireExpectedVersion, savePackage, serializeWorkflowMutation, stable, versionedRef,
  workflowEventRows,
} from './weeklyOperatingPackageSupport.js';

export function createWeeklyOperatingPackageService(dataStore: DataStore) {
  const operatingRepository = createSocialOperatingRepository(dataStore);
  const agentPlanning = createWeeklyPlanningAuthority(dataStore);

  async function withAuthoritativePlanning(
    tenantId: string,
    programId: string,
    input: Record<string, unknown>,
  ) {
    return resolveWeeklyAuthoritativePlanning(operatingRepository, tenantId, programId, input);
  }

  async function withExecutionProjection(tenantId: string, item: WeeklyOperatingPackage): Promise<WeeklyOperatingPackage> {
    const tasks = await listWeeklyExecutionTasks(
      dataStore, tenantId, item.programId, item.packageId, item.version,
    );
    const projected = projectWeeklyExecution(item, tasks);
    try {
      return { ...projected, agentPlanning: await agentPlanning.get(tenantId, item.programId, item.packageId, item.version) };
    } catch (error) {
      if (error instanceof SocialProgramError && error.code === 'weekly_agent_planning_not_found') return projected;
      throw error;
    }
  }

  async function withAuthoritativeDecisions(
    tenantId: string,
    programId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (input.businessContentGoal || input.capacityPlan || input.automationPolicy) {
      throw new SocialProgramError('client_authority_forbidden', 400, '周包不接受客户端提交的目标、容量或自动化结果。');
    }
    const snapshotRef = versionedRef(input.operatingDecisionSnapshotRef);
    if (!snapshotRef) return input;
    if (snapshotRef.type !== 'operating_authority_snapshot') throw new SocialProgramError('operating_snapshot_ref_invalid', 400, '经营编排快照引用类型无效。');
    const snapshot = await operatingRepository.getSnapshot(tenantId, programId, snapshotRef.id, snapshotRef.version);
    if (!snapshot) throw new SocialProgramError('operating_snapshot_not_found', 404, '经营编排快照不存在。');
    if (snapshot.planningWeekStart !== undefined && input.weekStart !== undefined && snapshot.planningWeekStart !== input.weekStart) throw new SocialProgramError('operating_snapshot_week_conflict', 409, '容量与经营快照属于另一周，请明确生成目标周的新规划。');
    if (snapshot.status === 'blocked') throw new SocialProgramError('operating_snapshot_blocked', 409, '经营编排快照尚未就绪，不能生成权威周包。');
    const goalRef = snapshot.businessContentGoalRef;
    const goal = await operatingRepository.getGoal(tenantId, programId, goalRef.id, goalRef.version);
    if (!goal) throw new SocialProgramError('business_goal_not_found', 404, '经营目标不存在。');
    const [capacityDecision, policyDecision] = await Promise.all([
      operatingRepository.getOperatingDecision<CapacityPlan>(tenantId, programId, snapshot.capacityPlanRef.id),
      operatingRepository.getOperatingDecision<AutomationPolicyResolution>(tenantId, programId, snapshot.automationPolicyRef.id),
    ]);
    if (!capacityDecision || !policyDecision) throw new SocialProgramError('operating_decision_missing', 503, '经营编排快照缺少决策记录。');
    const capacity: WeeklyCapacitySnapshot = {
      ref: snapshot.capacityPlanRef,
      status: capacityDecision.output.status === 'blocked' ? 'blocked' : 'ready',
      originalContentTarget: capacityDecision.output.originalContentQuota,
      accountPlans: capacityDecision.output.accountQuotas.filter(item => item.publicationQuota > 0).map(item => ({ accountId: item.accountId, publicationCount: item.publicationQuota })),
      productionBudgetCny: goal.weeklyBudgetCny,
      blockers: capacityDecision.blockers.map(item => item.code),
    };
    const policy: WeeklyAutomationPolicySnapshot = {
      ref: snapshot.automationPolicyRef,
      status: policyDecision.output.status === 'blocked' ? 'blocked' : 'ready',
      blockers: policyDecision.blockers.map(item => item.code),
    };
    const productionOnly=snapshot.status==='degraded'&&goal.status==='blocked'&&evaluateProductionOutlineReadiness(goal).ready&&capacity.status==='ready'&&policy.status==='ready';
    return {
      ...input,
      // These allocation fields are projections of the persisted resolver
      // output. Never let same-request values shadow the authority snapshot.
      accountPlans: productionOnly?input.accountPlans:undefined,
      originalContentTarget: productionOnly?input.originalContentTarget:undefined,
      weeklyBudgetCny: productionOnly?input.weeklyBudgetCny:undefined,
      enterpriseProfileRef: snapshot.enterprise.ref,
      businessContentGoalRef: goalRef,
      capacityPlanRef: snapshot.capacityPlanRef,
      automationPolicyRef: snapshot.automationPolicyRef,
      businessContentGoal: goal,
      capacityPlan: capacity,
      automationPolicy: policy,
      referenceModeRef: snapshot.referenceModeRef,
    };
  }

  async function withPromotionQuota(
    tenantId: string,
    programId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const ref = versionedRef(input.promotionQuotaRef);
    if (!ref) return input;
    if (ref.type !== 'weekly_promotion_quota') {
      throw new SocialProgramError('promotion_quota_ref_invalid', 400, '晋级配额引用类型无效。');
    }
    const found = await dataStore.list<{ id: string; program_id?: string; snapshot_id: string; quota: VersionedQuotaReference }>(PROMOTION_QUOTAS, {
      where: { tenant_id: tenantId, quota_id: ref.id, version: ref.version }, page: 1, perPage: 2,
    });
    if (found.items.length !== 1) throw new SocialProgramError('promotion_quota_not_found', 404, '晋级配额不存在或不唯一。');
    const row = found.items[0];
    const quota = row.quota;
    if (!quota || quota.quotaId !== ref.id || quota.version !== ref.version || (quota.programId && quota.programId !== programId)
      || (row.program_id && row.program_id !== programId)) {
      throw new SocialProgramError('promotion_quota_lineage_invalid', 409, '晋级配额与当前项目不匹配。');
    }
    if (!quota.allocations.length) {
      throw new SocialProgramError('promotion_quota_observe_only', 409, '样本仍在观察，不能进入下周配额。');
    }
    const snapshots = await dataStore.list<{ id: string; snapshot: { programId?: string; window?: { endsAt?: string } } }>(WEEKLY_REVIEWS, {
      where: { tenant_id: tenantId, snapshot_id: quota.sourceSnapshotId }, page: 1, perPage: 2,
    });
    const snapshot = snapshots.items[0]?.snapshot;
    const weekStart = dateOnly(input.weekStart, 'week_start_invalid');
    if (snapshots.items.length !== 1 || !snapshot || (snapshot.programId && snapshot.programId !== programId)
      || !snapshot.window?.endsAt || Date.parse(`${weekStart}T00:00:00.000Z`) < Date.parse(snapshot.window.endsAt)) {
      throw new SocialProgramError('promotion_quota_window_invalid', 409, '晋级配额只能输入复盘窗口之后的周计划。');
    }
    const byAccount = new Map<string, { accountId: string; publicationCount: number; accountPositioning: string }>();
    for (const allocation of quota.allocations) {
      const current = byAccount.get(allocation.accountId);
      if (current) current.publicationCount += allocation.contentCount;
      else byAccount.set(allocation.accountId, {
        accountId: allocation.accountId,
        publicationCount: allocation.contentCount,
        accountPositioning: allocation.businessDirection,
      });
    }
    const accountPlans = [...byAccount.values()];
    const allocatedCount = accountPlans.reduce((sum, item) => sum + item.publicationCount, 0);
    return {
      ...input,
      promotionQuotaRef: ref,
      accountPlans,
      originalContentTarget: Math.max(1, Math.min(allocatedCount, Number(input.originalContentTarget) || allocatedCount)),
    };
  }

  async function enqueuePackageChange(input: {
    tenantId: string;
    item: WeeklyOperatingPackage;
    operation: 'created' | 'revised' | 'activated' | 'retired';
    before?: WeeklyOperatingPackage;
    authorizationRequired?: boolean;
  }): Promise<void> {
    const kind = input.authorizationRequired ? 'authorization.required' as const : 'weekly_package.adjusted' as const;
    await enqueueAgentNotificationDomainEvent({
      eventId: `weekly-package:${input.item.packageId}:v${input.item.version}:${input.operation}`,
      kind,
      tenantId: input.tenantId,
      programId: input.item.programId,
      packageId: input.item.packageId,
      packageVersion: input.item.version,
      entityId: input.item.packageId,
      title: input.authorizationRequired ? '周任务包需要发布授权' : '周任务包已更新',
      summary: input.authorizationRequired
        ? '周任务包已激活，但真实发布仍保持关闭，需由有权限的人员确认。'
        : `周任务包已${input.operation === 'created' ? '创建' : input.operation === 'revised' ? '修订' : input.operation === 'activated' ? '激活' : '撤回'}。`,
      sourceAgent: 'business_agent',
      changes: [{
        field: input.authorizationRequired ? 'publishingAuthorization' : 'weeklyPackageVersion',
        label: input.authorizationRequired ? '发布授权' : '周任务包版本',
        before: input.authorizationRequired ? false : input.before?.version ?? null,
        after: input.authorizationRequired ? 'required' : input.item.version,
      }],
      occurredAt: input.item.updatedAt,
    }, dataStore);
  }

  async function buildRevisionDraft(tenantId:string,userId:string,programId:string,packageId:string,input:Record<string,unknown>,current:PackageRow,createdAt?:string):Promise<WeeklyOperatingPackage>{
      const projectedCurrent = await projectWorkflowState(dataStore, tenantId, current);
      const program = await programRow(dataStore, tenantId, programId);
      const accounts = await accountsForProgram(dataStore, tenantId, programId);
      const merged = {
        objective: current.payload.objective,
        weekStart: current.payload.weekStart,
        enterpriseProfileRef: current.payload.enterpriseProfileRef,
        monthlyPlanRef: current.payload.monthlyPlanRef,
        businessContentGoalRef: current.payload.businessContentGoalRef,
        capacityPlanRef: current.payload.capacityPlanRef,
        automationPolicyRef: current.payload.automationPolicyRef,
        operatingDecisionSnapshotRef: current.payload.operatingDecisionSnapshotRef,
        referenceModeRef: current.payload.referenceModeRef,
        referenceSourcePolicy: current.payload.referenceSourcePolicy,
        promotionQuotaRef: current.payload.promotionQuotaRef,
        originalContentTarget: current.payload.socialContentPackage.originalContentTarget,
        weeklyBudgetCny: current.payload.socialContentPackage.weeklyBudgetCny,
        perItemBudgetCny: current.payload.socialContentPackage.perItemBudgetCny,
        capacityNotes: current.payload.socialContentPackage.capacityNotes,
        publicationTasks: current.payload.socialContentPackage.publicationTasks,
        authorizationMode: current.payload.socialContentPackage.authorization.mode,
        successCriteria: current.payload.successCriteria,
        accountPlans: current.payload.socialContentPackage.publicationTasks.reduce<Array<Record<string, unknown>>>((plans, task) => {
          const existing = plans.find(plan => plan.accountId === task.accountId);
          if (existing) existing.publicationCount = Number(existing.publicationCount) + 1;
          else plans.push({ accountId: task.accountId, publicationCount: 1, accountPositioning: task.accountPositioning });
          return plans;
        }, []),
        ...input,
      };
      const orchestrated = await withAuthoritativeDecisions(tenantId, programId, merged);
      const resolved = await withAuthoritativePlanning(tenantId, programId, orchestrated);
      const resolvedWithQuota = await withPromotionQuota(tenantId, programId, resolved.input);
      const effectiveOriginalTarget=(resolvedWithQuota.capacityPlan as WeeklyCapacitySnapshot|null|undefined)?.originalContentTarget??resolvedWithQuota.originalContentTarget;
      if(input.publicationTasks===undefined&&input.originalContentTarget!==undefined&&Number(input.originalContentTarget)!==current.payload.socialContentPackage.originalContentTarget&&Number(effectiveOriginalTarget)!==current.payload.socialContentPackage.originalContentTarget){
        resolvedWithQuota.publicationTasks=current.payload.socialContentPackage.publicationTasks.map(p=>{if(p.inventoryReuseRef)return p;const {motherContentId:oldMother,adaptationOfPublicationTaskId:oldParent,...freshGrouping}=p;return freshGrouping;});
      }
      const item = packageFromInput({
        input: resolvedWithQuota, programId, userId, accounts, program: program.payload,
        packageId, contentPackageId: current.payload.socialContentPackage.contentPackageId,
        version: current.payload.version + 1, previousVersion: current.payload.version,
        previousPackage: projectedCurrent,
        createdAt,
      });
      // A normal revision keeps the source graph contract. Historical packages
      // without an explicit version continue through the established v2
      // schedule-upgrade path; only newly-created packages opt in to v3.
      item.executionGraphVersion=current.payload.executionGraphVersion??2;
      return item;

  }
  return {
    async list(tenantId: string, programId: string, weekStart?: string): Promise<WeeklyOperatingPackage[]> {
      await programRow(dataStore, tenantId, programId);
      const where: Record<string, string> = { tenant_id: tenantId, program_id: programId };
      if (weekStart) where.week_start = dateOnly(weekStart, 'week_start_invalid');
      const result = await dataStore.list<PackageRow>(PACKAGES, { where, sort: '-version', page: 1, perPage: 300 });
      return Promise.all(result.items.map(async row => withExecutionProjection(tenantId, await projectWorkflowState(dataStore, tenantId, row))));
    },

    async get(tenantId: string, programId: string, packageId: string): Promise<WeeklyOperatingPackage> {
      await programRow(dataStore, tenantId, programId);
      const row = await latestPackageRow(dataStore, tenantId, programId, packageId);
      if (!row) throw new SocialProgramError('weekly_operating_package_not_found', 404, '周任务包不存在。');
      return withExecutionProjection(tenantId, await projectWorkflowState(dataStore, tenantId, row));
    },

    async findProfileUpgradeCreation(tenantId:string,userId:string,programId:string,input:{id:string;sourcePackageId:string;sourcePackageVersion:number;creationRequestId:string}){
      return findProfileUpgradeCreation(dataStore,{tenantId,programId,packageId:input.sourcePackageId,packageVersion:input.sourcePackageVersion},userId,input.id,input.creationRequestId);
    },
    async create(tenantId: string, userId: string, programId: string, input: Record<string, unknown>): Promise<WeeklyOperatingPackage> {
      input={...input,weekStart:naturalWeek(dateOnly(input.weekStart,'week_start_invalid')).start};
      rejectClientAuthorityObjects(input);
      if(Array.isArray(input.publicationTasks)&&input.publicationTasks.some(p=>p&&typeof p==='object'&&(p as Record<string,unknown>).inventoryReuseRef!==undefined))throw new SocialProgramError('inventory_create_not_revision',400,'库存确认只能绑定原发布目标的下一次修订。');
      if(input.profileUpgradeRef && typeof input.profileUpgradeRef==='object'&&!Array.isArray(input.profileUpgradeRef)){
        const ref=input.profileUpgradeRef as Record<string,unknown>;
        if(typeof ref.sourcePackageId==='string'&&Number.isSafeInteger(ref.sourcePackageVersion)&&Number(ref.sourcePackageVersion)>0){
          const scope={tenantId,programId,packageId:ref.sourcePackageId,packageVersion:Number(ref.sourcePackageVersion)};
          if(!await assertExecutionPackageGate(dataStore,scope))return withExecutionPackageGate(dataStore,scope,()=>createWeeklyOperatingPackageService(dataStore).create(tenantId,userId,programId,input));
        }
      }
      const creationInputHash=socialRequestHash(input);
      if(input.profileUpgradeRef!==undefined){
        assertProfileUpgradeCreationInput(input);
        const ref=input.profileUpgradeRef as Record<string,unknown>;
        if(!ref||typeof ref.id!=='string'||typeof ref.sourcePackageId!=='string'||!Number.isSafeInteger(ref.sourcePackageVersion))throw new SocialProgramError('profile_upgrade_ref_invalid',400,'升级引用无效。');
        const existing=await findProfileUpgradeCreation(dataStore,{tenantId,programId,packageId:ref.sourcePackageId,packageVersion:Number(ref.sourcePackageVersion)},userId,ref.id,String(input.profileUpgradeCreationRequestId));
        if(existing){if(existing.profileUpgradeConsumption!.creationInputHash!==creationInputHash)throw new SocialProgramError('profile_upgrade_creation_intent_changed',409,'原创建请求已保存，不能更换目标后复用请求身份。');return this.get(tenantId,programId,existing.packageId);}
      }
      const program = await programRow(dataStore, tenantId, programId);
      const accounts = await accountsForProgram(dataStore, tenantId, programId);
      input = await withAuthoritativeDecisions(tenantId, programId, input);
      input = (await withAuthoritativePlanning(tenantId, programId, input)).input;
      input = await withPromotionQuota(tenantId, programId, input);
      let packageProgram = program.payload;
      let consumedUpgrade:Awaited<ReturnType<ReturnType<typeof createWeeklyProfileUpgradeService>['readForNextWeek']>>|null=null;
      if(input.profileUpgradeRef!==undefined){
        const ref=input.profileUpgradeRef;
        if(!ref||typeof ref!=='object'||Array.isArray(ref)||Object.keys(ref).some(key=>!['id','sourcePackageId','sourcePackageVersion'].includes(key)))throw new SocialProgramError('profile_upgrade_ref_invalid',400,'画像升级必须引用已确认的建议。');
        const r=ref as Record<string,unknown>;
        if(typeof r.id!=='string'||typeof r.sourcePackageId!=='string'||!Number.isSafeInteger(r.sourcePackageVersion)||Number(r.sourcePackageVersion)<1)throw new SocialProgramError('profile_upgrade_ref_invalid',400,'画像升级引用不完整。');
        const upgrade=await createWeeklyProfileUpgradeService(dataStore).readForNextWeek({tenantId,programId,packageId:r.sourcePackageId,packageVersion:Number(r.sourcePackageVersion)},userId,r.id,String(input.weekStart));
        if(input.referenceSourcePolicy!==undefined&&stable(input.referenceSourcePolicy)!==stable(upgrade.referenceSourcePolicy))throw new SocialProgramError('profile_upgrade_policy_conflict',409,'配额必须与明确确认的画像建议一致。');
        consumedUpgrade=upgrade;
        input={...input,referenceSourcePolicy:upgrade.referenceSourcePolicy};
        packageProgram={...program.payload,route:upgrade.route};
      }
      const item = packageFromInput({
        input, programId, userId, accounts, program: packageProgram,
        packageId: randomUUID(), contentPackageId: randomUUID(), version: 1, previousVersion: null,
      });
      item.executionGraphVersion=3;
      if(consumedUpgrade){
        for(const publication of item.socialContentPackage.publicationTasks)assertProfileUpgradePublicationWindow(publication.publishWindow,item.weekStart,String(input.profileUpgradeTimeZone));
        const targets=input.publicationTasks as Array<Record<string,unknown>>;
        const distribution=(items:Array<{accountId:unknown;publishWindow:unknown}>)=>{const counts=new Map<string,number>();for(const p of items){const key=JSON.stringify([p.accountId,p.publishWindow]);counts.set(key,(counts.get(key)??0)+1);}return [...counts].sort(([a],[b])=>a.localeCompare(b));};
        if(stable(distribution(targets as Array<{accountId:unknown;publishWindow:unknown}>))!==stable(distribution(item.socialContentPackage.publicationTasks)))throw new SocialProgramError('profile_upgrade_publication_quota_mismatch',409,'明确提交的新目标必须与真实账号容量和生成目标逐条一致，不能丢弃或自动补空。');
        const r=consumedUpgrade.receipt;
        const body:Omit<ProfileUpgradeConsumption,'recordHash'>={schemaVersion:'weekly-profile-upgrade-consumption.v1',upgradeId:r.id,sourcePackageId:r.packageId,sourcePackageVersion:r.packageVersion,confirmationHash:socialRequestHash(r),evidenceHash:r.evidenceHash,confirmedBy:r.confirmedBy!,confirmedAt:r.confirmedAt!,creationRequestId:String(input.profileUpgradeCreationRequestId),creationInputHash,createdBy:userId,createdAt:item.createdAt,targetPackageId:item.packageId,targetPackageVersion:1,targetWeekStart:item.weekStart,timeZone:String(input.profileUpgradeTimeZone),publicationTaskIds:item.socialContentPackage.publicationTasks.map(p=>p.publicationTaskId),publicationInputHash:profileUpgradePublicationHash(item),targetInputHash:profileUpgradeTargetHash(item)};
        item.profileUpgradeConsumption={...body,recordHash:socialRequestHash(body)};
      }
      if (!item.objective || !item.successCriteria.length) {
        throw new SocialProgramError('weekly_operating_package_incomplete', 400, '周任务包必须包含经营目标和成功标准。');
      }
      const saved = await savePackage(dataStore, tenantId, item);
      try {
        const planning = await agentPlanning.initialize(tenantId, item);
        const tasks = await materializeWeeklyExecutionTasks(dataStore, tenantId, item);
        await enqueuePackageChange({ tenantId, item, operation: 'created' });
        return { ...projectWeeklyExecution(item, tasks, item.updatedAt), agentPlanning: planning };
      } catch (error) {
        await dataStore.delete(PACKAGES, saved.id);
        throw error;
      }
    },

    async previewRevision(tenantId:string,userId:string,programId:string,packageId:string,input:Record<string,unknown>,options?:{createdAt?:string}):Promise<WeeklyOperatingPackage>{
      rejectClientAuthorityObjects(input);if(input.profileUpgradeRef!==undefined)throw new SocialProgramError('profile_upgrade_next_week_only',400,'画像升级仅下一周创建消费。');
      const current=await latestPackageRow(dataStore,tenantId,programId,packageId);if(!current)throw new SocialProgramError('weekly_operating_package_not_found',404,'周任务包不存在。');requireExpectedVersion(current.payload.version,input.expectedVersion);
      const createdAt=options?.createdAt;if(createdAt!==undefined&&(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(createdAt)||!Number.isFinite(Date.parse(createdAt))))throw new SocialProgramError('weekly_revision_preview_time_invalid',400,'排期预览时间必须为明确服务器时刻。');
      const item=await buildRevisionDraft(tenantId,userId,programId,packageId,input,current,createdAt);
      if(!item.objective||!item.successCriteria.length)throw new SocialProgramError('weekly_operating_package_incomplete',400,'周任务包必须包含经营目标和成功标准。');
      return item;
    },
    async revise(tenantId: string, userId: string, programId: string, packageId: string, input: Record<string, unknown>, internal?: {scheduleRevisionRef?:VersionedSocialRef;templateApplicationRef?:VersionedSocialRef;createdAt?:string}): Promise<WeeklyOperatingPackage> {
      rejectClientAuthorityObjects(input);
      if(input.profileUpgradeRef!==undefined)throw new SocialProgramError('profile_upgrade_next_week_only',400,'画像升级只允许下一周创建时消费。');
      const current = await latestPackageRow(dataStore, tenantId, programId, packageId);
      if (!current) throw new SocialProgramError('weekly_operating_package_not_found', 404, '周任务包不存在。');
      const gateScope={tenantId,programId,packageId,packageVersion:current.payload.version};
      if(!await assertExecutionPackageGate(dataStore,gateScope))return withExecutionPackageGate(dataStore,gateScope,()=>createWeeklyOperatingPackageService(dataStore).revise(tenantId,userId,programId,packageId,input,internal));
      requireExpectedVersion(current.payload.version, input.expectedVersion);
      const item=await buildRevisionDraft(tenantId,userId,programId,packageId,input,current,internal?.createdAt);
      if(internal?.scheduleRevisionRef){
 const snapshot=await readScheduleSnapshot(dataStore,tenantId,item,internal.scheduleRevisionRef);
 for(const plan of snapshot.templateCarryovers??[]){
 const publication=item.socialContentPackage.publicationTasks.find(p=>p.publicationTaskId===plan.targetScope.publicationTaskId);
 const sourcePublication=current.payload.socialContentPackage.publicationTasks.find(p=>p.publicationTaskId===plan.sourceScope.publicationTaskId);
 const bindingRow=await dataStore.getById<import('../storage/datastore.js').Record_>('social_weekly_content_template_bindings',plan.targetBindingRef.id);
 const binding=bindingRow?.payload as import('../../shared/contracts/socialWeeklyContentTemplates.js').WeeklyContentTemplateBinding|undefined;
 if(!binding)throw new SocialProgramError('weekly_schedule_template_binding_missing',409,'weekly_schedule_template_binding_missing');
 const {recordHash,...body}=binding;
 if(plan.sourceScope.tenantId!==tenantId||plan.sourceScope.programId!==programId||plan.sourceScope.packageId!==packageId||plan.sourceScope.packageVersion!==current.payload.version||plan.targetScope.packageVersion!==item.version||plan.plannedBy!==userId||scheduleHash(sourcePublication?.contentTemplateBindingRef)!==scheduleHash(plan.sourceBindingRef)||scheduleHash(publication?.contentTemplateBindingRef)!==scheduleHash(plan.targetBindingRef)||binding.bindingId!==plan.targetBindingRef.id||binding.tenantId!==tenantId||binding.programId!==programId||binding.packageId!==packageId||binding.packageVersion!==item.version||binding.publicationTaskId!==plan.targetScope.publicationTaskId||binding.confirmedBy!==userId||recordHash!==scheduleHash(body)||bindingRow?.record_hash!==recordHash||binding.carryover?.planHash!==plan.planHash||binding.carryover.sourceBindingHash!==plan.sourceBindingHash)throw new SocialProgramError('weekly_schedule_template_binding_invalid',409,'weekly_schedule_template_binding_invalid');
 }
 (item as WeeklyScheduledPackage).scheduleRevisionRef=internal.scheduleRevisionRef;
 }
      if(internal?.templateApplicationRef){
        const ref=internal.templateApplicationRef,bindingRow=await dataStore.getById<import('../storage/datastore.js').Record_>('social_weekly_content_template_bindings',ref.id);
        const binding=bindingRow?.payload as import('../../shared/contracts/socialWeeklyContentTemplates.js').WeeklyContentTemplateBinding|undefined;
        if(!binding)throw new SocialProgramError('content_template_application_binding_missing',409,'模板待绑定凭据不存在。');
        const {recordHash,...content}=binding;
        if(ref.type!=='weekly_content_template_application'||ref.version!==1||binding.bindingId!==ref.id||binding.tenantId!==tenantId||binding.programId!==programId||binding.packageId!==packageId||binding.packageVersion!==item.version||binding.confirmedBy!==userId||recordHash!==scheduleHash(content)||bindingRow?.record_hash!==recordHash||item.socialContentPackage.publicationTasks.filter(p=>p.publicationTaskId===binding.publicationTaskId&&p.contentTemplateBindingRef?.id===binding.bindingId&&p.contentTemplateBindingRef.type==='weekly_content_template_binding'&&p.contentTemplateBindingRef.version===1).length!==1)throw new SocialProgramError('content_template_application_binding_invalid',409,'模板修订凭据与实际新版本不一致。');
        (item as WeeklyOperatingPackage&{templateApplicationRef:VersionedSocialRef}).templateApplicationRef=ref;
      }
      if (!item.objective || !item.successCriteria.length) {
        throw new SocialProgramError('weekly_operating_package_incomplete', 400, '周任务包必须包含经营目标和成功标准。');
      }
      if(current.payload.profileUpgradeConsumption)item.profileUpgradeConsumption=structuredClone(current.payload.profileUpgradeConsumption);
      const inventoryService=createWeeklyInventoryReuseService(dataStore);
      for(const publication of item.socialContentPackage.publicationTasks.filter(p=>p.inventoryReuseRef)){
        assertInventoryMaterialContract(publication);
        const receipt=await inventoryService.get({tenantId,programId,packageId,packageVersion:current.payload.version,actorUserId:userId},publication.inventoryReuseRef!.id);
        if(receipt.item.target.packageVersion!==item.version||receipt.item.target.publicationTaskId!==publication.publicationTaskId||receipt.item.confirmedBy!==userId||receipt.item.target.publicationHash!==inventoryPublicationHash(publication)||item.referenceSourcePolicy?.profile!=='b2b_established')throw new SocialProgramError('inventory_revision_binding_changed',409,'库存确认与实际新版本发布目标不一致。');
      }
      const saved = await savePackage(dataStore, tenantId, item);
      let projected: WeeklyOperatingPackage;
      try {
        for(const publication of item.socialContentPackage.publicationTasks.filter(p=>p.inventoryReuseRef))await inventoryService.readVerifiedBinding({tenantId,programId,packageId,packageVersion:item.version,publicationTaskId:publication.publicationTaskId,accountId:publication.accountId,inputSnapshot:{publicationTask:publication}});
        const planning = await agentPlanning.initialize(tenantId, item);
        projected = { ...projectWeeklyExecution(item, await materializeWeeklyExecutionTasks(dataStore, tenantId, item), item.updatedAt), agentPlanning: planning };
      } catch (error) {
        // A confirmed immutable snapshot owns this real draft; retain it and
        // any already persisted tasks so the same proposal can resume it.
        if(!internal?.scheduleRevisionRef&&!internal?.templateApplicationRef)await dataStore.delete(PACKAGES, saved.id);
        throw error;
      }
      await enqueuePackageChange({ tenantId, item, operation: 'revised', before: current.payload });
      if (current.payload.socialContentPackage.authorization.allowRealPublishing) {
        const timestamp = at();
        const invalidated: WeeklyOperatingPackage = {
          ...current.payload,
          socialContentPackage: {
            ...current.payload.socialContentPackage,
            authorization: {
              ...current.payload.socialContentPackage.authorization,
              allowRealPublishing: false,
              revokedBy: userId,
              revokedAt: timestamp,
            },
          },
          updatedAt: timestamp,
        };
        if (!await dataStore.update(PACKAGES, current.id, { payload: invalidated, updated_by: userId, updated_at: timestamp })) {
          throw new SocialProgramError('weekly_operating_package_storage_unavailable', 503, '旧版本发布授权暂时无法失效。');
        }
      }
      return projected;
    },

    async getAgentPlanning(tenantId: string, programId: string, packageId: string, packageVersion?: number) {
      const row = await latestPackageRow(dataStore, tenantId, programId, packageId);
      if (!row) throw new SocialProgramError('weekly_operating_package_not_found', 404, '周任务包不存在。');
      const version = packageVersion ?? row.payload.version;
      return agentPlanning.get(tenantId, programId, packageId, version);
    },

    async runDirectorPlanning(tenantId: string, programId: string, packageId: string, versions: WeeklyAgentPlanningMutation) {
      return serializeWorkflowMutation(`${tenantId}:${programId}:${packageId}`, async () => {
        const row = await latestPackageRow(dataStore, tenantId, programId, packageId);
        if (!row) throw new SocialProgramError('weekly_operating_package_not_found', 404, '周任务包不存在。');
        if (!Number.isSafeInteger(versions.expectedPackageVersion) || versions.expectedPackageVersion < 1) {
          throw new SocialProgramError('weekly_package_version_required', 400, '请提供有效的周任务包版本。');
        }
        if (row.payload.version !== versions.expectedPackageVersion) {
          throw new SocialProgramError('weekly_package_version_conflict', 409, '周任务包已更新，请从后端刷新后重试；已有计划已保留。');
        }
        return agentPlanning.runDirectorAnalysis({ tenantId, programId, packageId, packageVersion: row.payload.version, expectedPlanningVersion: versions.expectedPlanningVersion, selectedSlotIds: versions.selectedSlotIds, actor: 'director_agent' });
      });
    },

    async pinAgentReference(tenantId:string,userId:string,programId:string,packageId:string,input:{expectedPackageVersion:number;expectedPlanningVersion:number;candidateId:string;expectedAccountUrl:string;discoveryAuthority:{rootJobId:string;currentJobId:string;runId:string}}){
      return serializeWorkflowMutation(`${tenantId}:${programId}:${packageId}`,async()=>{
        const row=await latestPackageRow(dataStore,tenantId,programId,packageId);
        if(!row)throw new SocialProgramError('weekly_operating_package_not_found',404,'周任务包不存在。');
        if(!Number.isSafeInteger(input.expectedPackageVersion)||input.expectedPackageVersion<1)throw new SocialProgramError('weekly_package_version_required',400,'请提供有效的周任务包版本。');
        if(row.payload.version!==input.expectedPackageVersion)throw new SocialProgramError('weekly_package_version_conflict',409,'周任务包已更新，请刷新后重试。');
        return agentPlanning.pinDirectorReference({tenantId,programId,packageId,packageVersion:row.payload.version,expectedPlanningVersion:input.expectedPlanningVersion,candidateId:input.candidateId,expectedAccountUrl:input.expectedAccountUrl,discoveryAuthority:input.discoveryAuthority,selectedBy:userId});
      });
    },

    async mergeAgentSchedule(tenantId: string, programId: string, packageId: string, versions: WeeklyAgentPlanningMutation) {
      return serializeWorkflowMutation(`${tenantId}:${programId}:${packageId}`, async () => {
        const row = await latestPackageRow(dataStore, tenantId, programId, packageId);
        if (!row) throw new SocialProgramError('weekly_operating_package_not_found', 404, '周任务包不存在。');
        if (!Number.isSafeInteger(versions.expectedPackageVersion) || versions.expectedPackageVersion < 1) {
          throw new SocialProgramError('weekly_package_version_required', 400, '请提供有效的周任务包版本。');
        }
        if (row.payload.version !== versions.expectedPackageVersion) {
          throw new SocialProgramError('weekly_package_version_conflict', 409, '周任务包已更新，请从后端刷新后重试；已有计划已保留。');
        }
        return agentPlanning.mergeDetailedSchedule({ tenantId, programId, package: row.payload, expectedPlanningVersion: versions.expectedPlanningVersion, selectedSlotIds: versions.selectedSlotIds, actor: 'business_agent' });
      });
    },

    async confirmAgentSchedule(tenantId: string, userId: string, programId: string, packageId: string, versions: WeeklyAgentPlanningMutation) {
      return serializeWorkflowMutation(`${tenantId}:${programId}:${packageId}`, async () => {
        const row = await latestPackageRow(dataStore, tenantId, programId, packageId);
        if (!row) throw new SocialProgramError('weekly_operating_package_not_found', 404, '周任务包不存在。');
        if (!Number.isSafeInteger(versions.expectedPackageVersion) || versions.expectedPackageVersion < 1) {
          throw new SocialProgramError('weekly_package_version_required', 400, '请提供有效的周任务包版本。');
        }
        if (row.payload.version !== versions.expectedPackageVersion) {
          throw new SocialProgramError('weekly_package_version_conflict', 409, '周任务包已更新，请从后端刷新后重试；已有计划已保留。');
        }
        return agentPlanning.confirm({ tenantId, programId, packageId, packageVersion: row.payload.version, expectedPlanningVersion: versions.expectedPlanningVersion, selectedSlotIds: versions.selectedSlotIds, userId });
      });
    },

    async dispatchAgentSchedule(tenantId: string, programId: string, packageId: string, versions: WeeklyAgentPlanningMutation) {
      return serializeWorkflowMutation(`${tenantId}:${programId}:${packageId}`, async () => {
        const row = await latestPackageRow(dataStore, tenantId, programId, packageId);
        if (!row) throw new SocialProgramError('weekly_operating_package_not_found', 404, '周任务包不存在。');
        if (!Number.isSafeInteger(versions.expectedPackageVersion) || versions.expectedPackageVersion < 1) {
          throw new SocialProgramError('weekly_package_version_required', 400, '请提供有效的周任务包版本。');
        }
        if (row.payload.version !== versions.expectedPackageVersion) {
          throw new SocialProgramError('weekly_package_version_conflict', 409, '周任务包已更新，请从后端刷新后重试；已有计划已保留。');
        }
        const state = await agentPlanning.dispatch({ tenantId, programId, packageId, packageVersion: row.payload.version, expectedPlanningVersion: versions.expectedPlanningVersion, selectedSlotIds: versions.selectedSlotIds, actor: 'business_agent' });
        if (!state.dispatch) throw new SocialProgramError('business_dispatch_missing', 503, '经营派单记录生成失败。');
        await applyBusinessDispatchToExecutionTasks(dataStore, tenantId, programId, packageId, row.payload.version, state.dispatch, state.updatedAt);
        return state;
      });
    },


    async activate(
      tenantId: string,
      userId: string,
      programId: string,
      packageId: string,
      input: Record<string, unknown>,
    ): Promise<WeeklyOperatingPackage> {
      const current = await latestPackageRow(dataStore, tenantId, programId, packageId);
      if (!current) throw new SocialProgramError('weekly_operating_package_not_found', 404, '周任务包不存在。');
      requireExpectedVersion(current.payload.version, input.expectedVersion);
      if (current.payload.status !== 'draft') throw new SocialProgramError('weekly_operating_package_not_draft', 409, '只能激活草稿版本。');
      const projectedCurrent = await projectWorkflowState(dataStore, tenantId, current);
      const authority = await withAuthoritativePlanning(tenantId, programId, {
        businessContentGoalRef: current.payload.businessContentGoalRef,
        capacityPlanRef: current.payload.capacityPlanRef,
        automationPolicyRef: current.payload.automationPolicyRef,
      });
      const checked = buildWeeklyWorkflow({
        packageId: current.payload.packageId,
        version: current.payload.version,
        businessGoal: authority.goal,
        capacity: authority.capacity,
        automationPolicy: authority.policy,
        publicationTasks: current.payload.socialContentPackage.publicationTasks,
        discoveryBudgetCny: current.payload.discoveryBudgetCny,
      });
      const activationBlockers = [...new Set([
        ...current.payload.planningBlockers,
        ...checked.blockers,
        ...projectedCurrent.workflowTasks.flatMap(task => task.status === 'blocked'
          ? [...task.ownBlockingReasons, ...task.inheritedBlockingTaskIds.map(id => `upstream:${id}`)]
          : []),
      ])];
      if (activationBlockers.length) {
        throw new SocialProgramError(
          'weekly_operating_package_activation_blocked',
          409,
          `周任务包尚有未解决的规划/G2 缺项：${activationBlockers.join('、')}`,
        );
      }
      const program = await programRow(dataStore, tenantId, programId);
      const expectedProgramVersion = Number(input.expectedProgramVersion);
      const actualProgramVersion = Number(program.payload.version);
      if (!Number.isSafeInteger(expectedProgramVersion) || expectedProgramVersion !== actualProgramVersion) {
        throw new SocialProgramError('program_version_conflict', 409, `项目已更新，当前版本为 ${actualProgramVersion}。`);
      }
      const activeResult = await dataStore.list<PackageRow>(PACKAGES, {
        where: { tenant_id: tenantId, program_id: programId, week_start: current.payload.weekStart, status: 'active' },
        page: 1, perPage: 100,
      });
      const supersededRows: PackageRow[] = [];
      for (const active of activeResult.items) {
        const superseded = { ...active.payload, status: 'superseded' as const, socialContentPackage: { ...active.payload.socialContentPackage, status: 'superseded' as const } };
        if (!await dataStore.update(PACKAGES, active.id, { status: 'superseded', payload: superseded })) {
          for (const previous of supersededRows) {
            await dataStore.update(PACKAGES, previous.id, { status: previous.status, payload: previous.payload });
          }
          throw new SocialProgramError('weekly_operating_package_storage_unavailable', 503, '旧活动周任务包暂时无法退役。');
        }
        supersededRows.push(active);
      }
      const activated: WeeklyOperatingPackage = {
        ...projectedCurrent,
        status: 'active',
        socialContentPackage: {
          ...current.payload.socialContentPackage,
          status: 'active',
          authorization: input.authorizePublishing === true
            ? {
              ...current.payload.socialContentPackage.authorization,
              mode: 'bounded',
              maxPublishItems: current.payload.socialContentPackage.publicationTaskTarget,
              allowRealPublishing: true,
              authorizedBy: userId,
              authorizedAt: at(),
              revokedBy: null,
              revokedAt: null,
            }
            : current.payload.socialContentPackage.authorization,
        },
        updatedAt: at(),
      };
      if (!await dataStore.update(PACKAGES, current.id, {
        status: 'active', payload: activated, updated_by: userId, updated_at: activated.updatedAt,
      })) {
        for (const previous of supersededRows) {
          await dataStore.update(PACKAGES, previous.id, { status: previous.status, payload: previous.payload });
        }
        throw new SocialProgramError('weekly_operating_package_storage_unavailable', 503, '周任务包暂时无法激活。');
      }
      const nextProgram = {
        ...program.payload,
        activeWeeklyOperatingPackageRef: { type: 'weekly_operating_package', id: packageId, version: activated.version },
        version: actualProgramVersion + 1,
        updatedAt: at(),
      };
      if (!await dataStore.update(PROGRAMS, program.id, {
        payload: nextProgram, version: nextProgram.version, updated_by: userId, updated_at: nextProgram.updatedAt,
      })) {
        await dataStore.update(PACKAGES, current.id, { status: 'draft', payload: current.payload });
        for (const previous of supersededRows) {
          await dataStore.update(PACKAGES, previous.id, { status: previous.status, payload: previous.payload });
        }
        throw new SocialProgramError('program_storage_unavailable', 503, '周任务包激活失败，已回滚当前版本。');
      }
      for (const previous of supersededRows) {
        await cancelWeeklyExecutionTasks(
          dataStore, tenantId, previous.payload.programId, previous.payload.packageId, previous.payload.version,
          `superseded_by:${activated.packageId}:${activated.version}`, activated.updatedAt,
        );
      }
      const tasks = await activateWeeklyExecutionTasks(dataStore, tenantId, activated, activated.updatedAt);
      await enqueuePackageChange({ tenantId, item: activated, operation: 'activated', before: current.payload, authorizationRequired: input.authorizePublishing !== true });
      return projectWeeklyExecution(activated, tasks, activated.updatedAt);
    },

    async retire(
      tenantId: string,
      userId: string,
      programId: string,
      packageId: string,
      input: Record<string, unknown>,
    ): Promise<WeeklyOperatingPackage> {
      const current = await latestPackageRow(dataStore, tenantId, programId, packageId);
      if (!current) throw new SocialProgramError('weekly_operating_package_not_found', 404, '周任务包不存在。');
      requireExpectedVersion(current.payload.version, input.expectedVersion);
      if (current.payload.status === 'retired') {
        // Resume the durable cancellation after an interrupted partial success.
        const program = await programRow(dataStore, tenantId, programId);
        const activeRef = program.payload.activeWeeklyOperatingPackageRef as VersionedSocialRef | null;
        if (activeRef?.id === packageId && activeRef.version === current.payload.version) {
          const timestamp = at();
          const next = { ...program.payload, activeWeeklyOperatingPackageRef: null, version: Number(program.payload.version) + 1, updatedAt: timestamp };
          if (!await dataStore.update(PROGRAMS, program.id, { payload: next, version: next.version, updated_by: userId, updated_at: timestamp })) throw new SocialProgramError('program_storage_unavailable', 503, '撤回已停止新执行，项目引用清理待重试。');
        }
        const tasks = await cancelWeeklyExecutionTasks(dataStore, tenantId, programId, packageId, current.payload.version, `package_retired:${userId}`, at());
        return projectWeeklyExecution(current.payload, tasks, at());
      }
      const timestamp = at();
      let activeProgram: ProgramRow | null = null;
      let nextProgram: Record<string, unknown> | null = null;
      if (current.payload.status === 'active') {
        activeProgram = await programRow(dataStore, tenantId, programId);
        const expectedProgramVersion = Number(input.expectedProgramVersion);
        const actualProgramVersion = Number(activeProgram.payload.version);
        if (!Number.isSafeInteger(expectedProgramVersion) || expectedProgramVersion !== actualProgramVersion) {
          throw new SocialProgramError('program_version_conflict', 409, `项目已更新，当前版本为 ${actualProgramVersion}。`);
        }
        const activeRef = activeProgram.payload.activeWeeklyOperatingPackageRef as VersionedSocialRef | null | undefined;
        if (activeRef?.id !== packageId || activeRef.version !== current.payload.version) {
          throw new SocialProgramError('program_active_package_mismatch', 409, '项目当前活动周任务包引用与撤回版本不一致。');
        }
        nextProgram = {
          ...activeProgram.payload,
          activeWeeklyOperatingPackageRef: null,
          version: actualProgramVersion + 1,
          updatedAt: timestamp,
        };
      }
      const retired: WeeklyOperatingPackage = {
        ...current.payload,
        status: 'retired',
        socialContentPackage: {
          ...current.payload.socialContentPackage,
          status: 'retired',
          authorization: {
            ...current.payload.socialContentPackage.authorization,
            allowRealPublishing: false,
            revokedBy: userId,
            revokedAt: timestamp,
          },
        },
        updatedAt: timestamp,
      };
      if (!await dataStore.update(PACKAGES, current.id, {
        status: 'retired', payload: retired, updated_by: userId, updated_at: timestamp,
      })) {
        throw new SocialProgramError('weekly_operating_package_storage_unavailable', 503, '周任务包暂时无法撤回。');
      }

      if (activeProgram && nextProgram) {
        if (!await dataStore.update(PROGRAMS, activeProgram.id, {
          payload: nextProgram, version: nextProgram.version, updated_by: userId, updated_at: timestamp,
        })) {
          await dataStore.update(PACKAGES, current.id, {
            status: current.status, payload: current.payload, updated_at: current.payload.updatedAt,
          });
          throw new SocialProgramError('program_storage_unavailable', 503, '周任务包撤回失败，已回滚当前版本。');
        }
      }
      const tasks = await cancelWeeklyExecutionTasks(
        dataStore, tenantId, programId, packageId, retired.version, `package_retired:${userId}`, timestamp,
      );
      await enqueuePackageChange({ tenantId, item: retired, operation: 'retired', before: current?.payload });
      return projectWeeklyExecution(retired, tasks, timestamp);
    },

    async applyWorkflowEvent(
      tenantId: string,
      userId: string,
      programId: string,
      packageId: string,
      input: Record<string, unknown>,
    ): Promise<WeeklyOperatingPackage> {
      const event = input.event as WeeklyWorkflowEvent | undefined;
      if (!event?.eventId || !event.taskId || !['start', 'complete', 'block', 'unblock', 'cancel'].includes(event.type) || !event.occurredAt || !Number.isFinite(Date.parse(event.occurredAt))) {
        throw new SocialProgramError('workflow_event_invalid', 400, '工作流事件字段不完整。');
      }
      return serializeWorkflowMutation(`${tenantId}:${programId}:${packageId}`, async () => {
        const current = await latestPackageRow(dataStore, tenantId, programId, packageId);
        if (!current) throw new SocialProgramError('weekly_operating_package_not_found', 404, '周任务包不存在。');
        requireExpectedVersion(current.payload.version, input.expectedVersion);
        const projected = await projectWorkflowState(dataStore, tenantId, current);
        const prior = projected.appliedWorkflowEvents.find(item => item.eventId === event.eventId);
        if (prior) {
          if (eventDigest(prior) !== eventDigest(event)) {
            throw new SocialProgramError('workflow_event_conflict', 409, '同一事件 ID 不得承载不同内容。');
          }
          return withExecutionProjection(tenantId, projected);
        }
        const expectedStateVersion = Number(input.expectedStateVersion);
        if (!Number.isSafeInteger(expectedStateVersion) || expectedStateVersion < 0) {
          throw new SocialProgramError('expected_state_version_required', 400, '工作流写入必须提供 expectedStateVersion。');
        }
        if (expectedStateVersion !== projected.workflowStateVersion) {
          throw new SocialProgramError('workflow_state_version_conflict', 409, `工作流状态已更新，当前版本为 ${projected.workflowStateVersion}。`);
        }
        const lastEvent = projected.appliedWorkflowEvents.at(-1);
        if (lastEvent && Date.parse(event.occurredAt) < Date.parse(lastEvent.occurredAt)) {
          throw new SocialProgramError('workflow_event_time_conflict', 409, '工作流事件时间不得早于已提交的最新事件。');
        }
        if (event.type === 'unblock') {
          const target = projected.workflowTasks.find(task => task.taskId === event.taskId);
          if (!target) throw new SocialProgramError('workflow_task_not_found', 404, '周工作流任务不存在。');
          if (target.kind !== 'readiness' || target.ownBlockingReasons.some(reason => !current.payload.planningBlockers.includes(reason))) {
            throw new SocialProgramError('workflow_unblock_authority_required', 409, '缺少可由服务端复核的权威事实，不得仅凭客户端事件解除阻塞。');
          }
          const authority = await withAuthoritativePlanning(tenantId, programId, {
            businessContentGoalRef: current.payload.businessContentGoalRef,
            capacityPlanRef: current.payload.capacityPlanRef,
            automationPolicyRef: current.payload.automationPolicyRef,
          });
          const checked = buildWeeklyWorkflow({
            packageId: current.payload.packageId,
            version: current.payload.version,
            businessGoal: authority.goal,
            capacity: authority.capacity,
            automationPolicy: authority.policy,
            publicationTasks: current.payload.socialContentPackage.publicationTasks,
            discoveryBudgetCny: current.payload.discoveryBudgetCny,
          });
          if (checked.blockers.length) {
            throw new SocialProgramError('workflow_unblock_recheck_failed', 409, `权威事实复核未通过：${checked.blockers.join('、')}`);
          }
        }
        const updated = applyWorkflowEvent(projected, event, { authoritativeUnblockVerified: true });
        const nextStateVersion = projected.workflowStateVersion + 1;
        const digest = eventDigest(event);
        let saved = false;
        try {
          saved = Boolean(await dataStore.create<WorkflowEventRow>(WORKFLOW_EVENTS, {
            tenant_id: tenantId,
            program_id: programId,
            package_id: packageId,
            package_version: current.payload.version,
            event_id: event.eventId,
            state_version: nextStateVersion,
            event_digest: digest,
            event,
            created_by: userId,
            created_at: at(),
          }));
        } catch {
          saved = false;
        }
        if (!saved) {
          const rows = await workflowEventRows(dataStore, tenantId, programId, packageId, current.payload.version);
          const replay = rows.find(row => row.event_id === event.eventId);
          if (replay) {
            if (replay.event_digest !== digest) throw new SocialProgramError('workflow_event_conflict', 409, '同一事件 ID 不得承载不同内容。');
            return withExecutionProjection(tenantId, await projectWorkflowState(dataStore, tenantId, current));
          }
          const latest = await projectWorkflowState(dataStore, tenantId, current);
          if (latest.workflowStateVersion !== expectedStateVersion) {
            throw new SocialProgramError('workflow_state_version_conflict', 409, `工作流状态已更新，当前版本为 ${latest.workflowStateVersion}。`);
          }
          throw new SocialProgramError('workflow_event_storage_unavailable', 503, '工作流事件暂时无法保存。');
        }
        return withExecutionProjection(tenantId, { ...updated, workflowStateVersion: nextStateVersion });
      });
    },
  };
}
