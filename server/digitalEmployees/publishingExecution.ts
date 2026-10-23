import type {SocialInstagramDeliveryPublishProof} from '../../shared/contracts/socialInstagramDelivery.js';
import { withManagedPublishingCycleLease, managedPublishingCapacity } from './managedPublishingCycleLease.js';
import { assertDurableOperationLease, type DurableOperationLease } from '../runtime/durableLease.js';
import { boundedPublishingSlots } from './continuationPolicy.js';
import { createHash } from 'node:crypto';
import type { MatrixAccountPlan } from '../../src/lib/weeklyMatrix.js';
import { createTrackedPostDraft } from '../publishing/waLink.js';
import { store } from '../storage/index.js';
import type { PublishingPlatform, PublishingTarget } from './domain.js';
import type { SocialWeeklyPublicationTask, VersionedSocialRef, WeeklyOperatingPackage } from '../../shared/contracts/socialProgram.js';
import { runExternalActionBlockedReason, withDigitalEmployeeRunLock } from './runControl.js';
import {
  currentPublishableVideoPaths,
  digitalEmployeePublishSourceClaim,
  verifyFrozenPublishSourceClaim,
  type FrozenPublishSourceClaim,
} from '../publishing/publishSourceClaim.js';

type StoredProject = { id: string; title?: unknown; status?: unknown; spec?: unknown };

export interface PublishingApprovalItem {
  sourceProjectId: string;
  platform: PublishingPlatform;
  accountIds: string[];
  accountLabels: string[];
  title: string;
  description: string;
  tags?: string[];
  videoPath: string;
  scheduledAt: string;
  sourceClaim: FrozenPublishSourceClaim;
  plannedPublishDate?: string;
  plannedPublishAt?: string;
}

export interface PublishingApprovalPackage {
  schemaVersion: 1;
  contentHash: string;
  allowRealPublishing: boolean;
  authorizationSnapshot?: BoundedPublishingAuthorizationSnapshot;
  items: PublishingApprovalItem[];
}

export interface BoundedPublishingAuthorizationSnapshot {
  schemaVersion: 1;
  packageRevision: number;
  authorizedBy: string;
  authorizedAt: string;
  startsAt: string;
  endsAt: string;
  accountBindings: Array<{ accountId: string; platform: PublishingPlatform }>;
  maxPublishItems: number;
  businessBoundary: {
    products: string;
    markets: string;
    audience: string;
    languages: string[];
    platforms: PublishingPlatform[];
    productionBudget: number;
    paidMediaBudget: number;
  };
  snapshotHash: string;
}

export type BoundedPublishingAuthorizationInput = Omit<BoundedPublishingAuthorizationSnapshot, 'schemaVersion' | 'snapshotHash'>;

const text = (value: unknown): string => String(value ?? '').trim();
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/**
 * The intentionally narrow hand-off from T5. Publishing consumes only a
 * frozen, accepted artifact; it neither reconstructs nor copies production.
 */
export interface PublishableProductionResult {
  instagramDelivery?:SocialInstagramDeliveryPublishProof;
  /** Canonical producer version when supplied; legacy handoffs retain their original v1 convention. */
  productionResultRef?: VersionedSocialRef;
  productionResultId: string;
  contentId: string;
  contentVersion: string;
  contentHash: string;
  title: string;
  body: string;
  hashtags?: string[];
  assets: Array<{ kind: 'video' | 'image' | 'cover' | 'subtitle' | 'document'; fileName: string; downloadUrl: string; contentHash: string }>;
  sourceRefs: VersionedSocialRef[];
  acceptedAt: string;
}

export interface PublicationAssignmentLineage {
  instagramDelivery?:SocialInstagramDeliveryPublishProof;
  programRef: VersionedSocialRef;
  operatingPackageRef: VersionedSocialRef;
  contentPackageRef: VersionedSocialRef;
  weeklyPublicationTaskRef: VersionedSocialRef;
  publishingWorkflowTaskRef: VersionedSocialRef;
  businessGoalRef: VersionedSocialRef | null;
  enterpriseProfileRef: VersionedSocialRef | null;
  factRefs: VersionedSocialRef[];
  productionResultRef: VersionedSocialRef;
  upstreamRefs: VersionedSocialRef[];
}

export interface PublicationAssignment {
  schemaVersion: 'publication-assignment.v1';
  assignmentId: string;
  tenantId: string;
  publicationTaskId: string;
  accountId: string;
  platform: PublishingPlatform;
  publishWindow: string;
  packageId: string;
  packageIdempotencyKey: string;
  lineage: PublicationAssignmentLineage;
  assignmentHash: string;
}

const stableRef = (ref: VersionedSocialRef): VersionedSocialRef => ({ type: text(ref.type), id: text(ref.id), version: Number(ref.version) });
const stableRefs = (refs: VersionedSocialRef[]) => refs.map(stableRef).sort((a, b) => `${a.type}:${a.id}:${a.version}`.localeCompare(`${b.type}:${b.id}:${b.version}`));
const stableDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Deterministically maps one authoritative weekly item and one future production result. */
export function buildPublicationAssignment(input: {
  tenantId: string;
  operatingPackage: WeeklyOperatingPackage;
  publicationTask: SocialWeeklyPublicationTask;
  productionResult: PublishableProductionResult;
}): PublicationAssignment {
  const { operatingPackage: weekly, publicationTask: task, productionResult: result } = input;
  const workflow = weekly.workflowTasks.find(item => item.kind === 'publishing');
  if (!workflow) throw new Error('publishing_workflow_task_required');
  if (!weekly.socialContentPackage.publicationTasks.some(item => item.publicationTaskId === task.publicationTaskId)) throw new Error('publication_task_outside_package');
  if (task.status === 'cancelled') throw new Error('publication_task_cancelled');
  if (!task.publishWindow) throw new Error('publication_publish_window_required');
  if (!result.productionResultId || !result.contentId || !/^[a-f0-9]{32,128}$/i.test(result.contentHash)) throw new Error('production_result_invalid');
  if (result.productionResultRef && (result.productionResultRef.type !== 'production_result' || result.productionResultRef.id !== result.productionResultId || !Number.isSafeInteger(result.productionResultRef.version) || result.productionResultRef.version < 1)) throw new Error('production_result_ref_invalid');
  if(task.platform==='instagram'&&!result.instagramDelivery)throw Error('instagram_delivery_required_for_assignment');
  if(result.instagramDelivery){const p=result.instagramDelivery;if(task.platform!=='instagram'||p.scope.tenantId!==input.tenantId||p.scope.programId!==weekly.programId||p.scope.packageId!==weekly.packageId||p.scope.packageVersion!==weekly.version||p.scope.publicationTaskId!==task.publicationTaskId||p.scope.artifactId!==result.contentId||!result.assets.some(a=>a.kind==='video'&&a.contentHash===p.sourceFileSha256))throw Error('instagram_delivery_assignment_scope_changed');}
  const lineage: PublicationAssignmentLineage = {
    ...(result.instagramDelivery?{instagramDelivery:result.instagramDelivery}:{}),
    programRef: { type: 'social_program', id: weekly.programId, version: 1 },
    operatingPackageRef: { type: 'weekly_operating_package', id: weekly.packageId, version: weekly.version },
    contentPackageRef: { type: 'social_weekly_content_package', id: weekly.socialContentPackage.contentPackageId, version: weekly.socialContentPackage.version },
    weeklyPublicationTaskRef: { type: 'weekly_publication_task', id: task.publicationTaskId, version: weekly.version },
    publishingWorkflowTaskRef: stableRef(workflow.taskRef),
    businessGoalRef: weekly.businessContentGoalRef ? stableRef(weekly.businessContentGoalRef) : null,
    enterpriseProfileRef: weekly.enterpriseProfileRef ? stableRef(weekly.enterpriseProfileRef) : null,
    factRefs: stableRefs(task.factRefs),
    productionResultRef: result.productionResultRef ? stableRef(result.productionResultRef) : { type: 'production_result', id: result.productionResultId, version: 1 },
    upstreamRefs: stableRefs(result.sourceRefs),
  };
  const identity = { tenantId: text(input.tenantId), packageId: weekly.packageId, packageVersion: weekly.version, publicationTaskId: task.publicationTaskId, productionResultId: result.productionResultId, contentHash: result.contentHash.toLowerCase(), accountId: task.accountId, platform: task.platform };
  const digest = stableDigest(identity);
  const packageIdempotencyKey = `weekly:${weekly.packageId}:${weekly.version}:${task.publicationTaskId}:${result.productionResultId}`;
  const packageId = `pubpkg_${stableDigest({ tenantId: text(input.tenantId), idempotencyKey: packageIdempotencyKey }).slice(0, 24)}`;
  const assignmentHash = stableDigest({ identity, lineage });
  return {
    schemaVersion: 'publication-assignment.v1', assignmentId: `pasn_${digest.slice(0, 24)}`,
    tenantId: text(input.tenantId), publicationTaskId: task.publicationTaskId, accountId: task.accountId,
    platform: task.platform, publishWindow: task.publishWindow, packageId, packageIdempotencyKey,
    lineage, assignmentHash,
  };
}

function nextDailySlot(index: number, now: Date): string {
  const slot = new Date(now);
  slot.setDate(slot.getDate() + index + 1);
  slot.setHours(20, 0, 0, 0);
  return slot.toISOString();
}

function stableAuthorizationValue(input: BoundedPublishingAuthorizationInput) {
  return {
    ...input,
    accountBindings: [...input.accountBindings].sort((a, b) => `${a.platform}:${a.accountId}`.localeCompare(`${b.platform}:${b.accountId}`)),
    businessBoundary: {
      ...input.businessBoundary,
      languages: [...input.businessBoundary.languages].sort(),
      platforms: [...input.businessBoundary.platforms].sort(),
    },
  };
}

export function buildBoundedPublishingAuthorization(input: BoundedPublishingAuthorizationInput): BoundedPublishingAuthorizationSnapshot {
  const stable = stableAuthorizationValue(input);
  return { schemaVersion: 1, ...stable, snapshotHash: createHash('sha256').update(JSON.stringify(stable)).digest('hex') };
}

export function boundedAuthorizationIssue(snapshot: BoundedPublishingAuthorizationSnapshot | undefined, input: {
  accountId: string;
  platform: PublishingPlatform;
  scheduledAt: string;
}): string {
  if (!snapshot) return 'bounded_authorization_missing';
  const raw = snapshot as unknown as Record<string, unknown>;
  const boundary = record(raw.businessBoundary);
  const bindings = raw.accountBindings;
  const languages = boundary.languages;
  const platforms = boundary.platforms;
  if (!Array.isArray(bindings) || !bindings.every(binding => {
    const item = record(binding);
    return Boolean(text(item.accountId) && text(item.platform));
  }) || !Array.isArray(languages) || !languages.every(language => typeof language === 'string')
    || !Array.isArray(platforms) || !platforms.every(platform => typeof platform === 'string')
    || typeof raw.snapshotHash !== 'string' || !Number.isInteger(raw.packageRevision)
    || !Number.isInteger(raw.maxPublishItems)
    || !Number.isFinite(Number(boundary.productionBudget)) || !Number.isFinite(Number(boundary.paidMediaBudget))) {
    return 'bounded_authorization_malformed';
  }
  if (snapshot.schemaVersion !== 1) return 'bounded_authorization_version_unsupported';
  const { snapshotHash, schemaVersion: _schemaVersion, ...value } = snapshot;
  try {
    if (buildBoundedPublishingAuthorization(value).snapshotHash !== snapshotHash) return 'bounded_authorization_tampered';
  } catch {
    return 'bounded_authorization_malformed';
  }
  if (!snapshot.authorizedBy || !snapshot.authorizedAt) return 'bounded_authorization_actor_missing';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshot.startsAt) || !/^\d{4}-\d{2}-\d{2}$/.test(snapshot.endsAt)
    || snapshot.startsAt > snapshot.endsAt || !Number.isFinite(Date.parse(snapshot.authorizedAt))) return 'bounded_authorization_period_invalid';
  if (snapshot.maxPublishItems < 1) return 'bounded_authorization_empty';
  if (!snapshot.businessBoundary.platforms.includes(input.platform)) return 'bounded_authorization_platform_mismatch';
  const instant = new Date(input.scheduledAt);
  const scheduledDate = Number.isNaN(instant.getTime()) ? '' : new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(instant);
  if (!scheduledDate || scheduledDate < snapshot.startsAt || scheduledDate > snapshot.endsAt) return 'bounded_authorization_week_mismatch';
  if (!snapshot.accountBindings.some(binding => binding.accountId === input.accountId && binding.platform === input.platform)) return 'bounded_authorization_account_mismatch';
  return '';
}

function contentFingerprint(items: PublishingApprovalItem[], allowRealPublishing: boolean, authorizationSnapshot?: BoundedPublishingAuthorizationSnapshot): string {
  return createHash('sha256').update(JSON.stringify({ allowRealPublishing, authorizationSnapshot, items })).digest('hex');
}

/** Build the exact, human-readable subject of a batch approval. */
export function buildPublishingApprovalPackage(input: {
  tenantId: string;
  projects: StoredProject[];
  /** Trusted workflow task scope, never a caller-supplied publishing override. */
  selectedProjectId?: string;
  targets: PublishingTarget[];
  goalPlatforms: PublishingPlatform[];
  allowRealPublishing: boolean;
  now?: Date;
  scheduling?: { startsAt: string; endsAt: string; timezone: 'account' | 'Asia/Shanghai' };
  matrixPlan?: MatrixAccountPlan[];
  boundedAuthorization?: BoundedPublishingAuthorizationInput;
}, dependencies: { sourceClaim: typeof digitalEmployeePublishSourceClaim } = { sourceClaim: digitalEmployeePublishSourceClaim }): PublishingApprovalPackage {
  const now = input.now || new Date();
  const selectedPlatforms = new Set(input.goalPlatforms);
  const targetsByPlatform = new Map<PublishingPlatform, PublishingTarget[]>();
  for (const target of input.targets.filter(item => selectedPlatforms.has(item.platform))) {
    targetsByPlatform.set(target.platform, [...(targetsByPlatform.get(target.platform) || []), target]);
  }
  const items: PublishingApprovalItem[] = [];
  if (input.selectedProjectId && input.projects.filter(p => p.id === input.selectedProjectId).length !== 1) throw Error('selected_publishing_project_unavailable');
  for (const project of input.projects) {
    if (input.selectedProjectId && project.id !== input.selectedProjectId) continue;
    const spec = record(project.spec);
    // A production-only add-on must not inherit the week's default accounts,
    // dates or bounded publishing grant through automatic fan-out.
    if (record(spec.contentOrder).publishMode === 'draft_only') continue;
    const projectIntent = record(record(spec.contentOrder).explicitPublishingIntent);
    if (projectIntent.state === 'pending') continue;
    const projectTargets = Object.keys(projectIntent).length
      ? new Map<PublishingPlatform, PublishingTarget[]>([[text(projectIntent.platform) as PublishingPlatform, [{ platform: text(projectIntent.platform) as PublishingPlatform, accountId: text(projectIntent.accountId), accountLabel: text(projectIntent.accountLabel) || text(projectIntent.accountId) }]]])
      : targetsByPlatform;
    if (!input.matrixPlan) {
      for (const videoPath of currentPublishableVideoPaths(spec)) {
        const publication = record(record(spec.contentOrder).videoPlan && record(record(spec.contentOrder).videoPlan).publication);
        let sourceClaim: FrozenPublishSourceClaim;
        try { sourceClaim = dependencies.sourceClaim(input.tenantId, project, videoPath); }
        catch { continue; }
        for (const [platform, targets] of projectTargets.entries()) items.push({
          sourceProjectId: project.id, platform, accountIds: targets.map(target => target.accountId), accountLabels: targets.map(target => target.accountLabel),
          title: text(publication.title) || text(spec.publicationTitle) || text(project.title) || `内容作品 ${project.id}`,
          description: text(publication.caption) || text(spec.caption) || text(spec.script) || '',
          tags: Array.isArray(publication.tags) ? publication.tags.map(text).filter(Boolean).slice(0, 20) : [], videoPath,
          scheduledAt: nextDailySlot(items.length, now), sourceClaim,
        });
      }
      continue;
    }
    const videoPlan = record(record(spec.contentOrder).videoPlan);
    const publication = record(videoPlan.publication);
    const binding = record(videoPlan.matrix);
    const explicitIntent = record(record(spec.contentOrder).explicitPublishingIntent);
    const matrixRows = Object.keys(explicitIntent).length ? undefined : input.matrixPlan?.filter(row => row.sourceProjectIds.includes(project.id) || row.accountId === binding.accountId);
    const boundIds = Object.keys(explicitIntent).length ? new Set([text(explicitIntent.accountId)]) : matrixRows ? new Set(matrixRows.map(row => row.accountId)) : videoPlan.matrix ? new Set(binding.accountId ? [text(binding.accountId)] : []) : null;
    const publishablePaths = currentPublishableVideoPaths(spec);
    for (const [platform, targets] of projectTargets.entries()) {
      const eligible = targets.filter(target => !boundIds || boundIds.has(target.accountId) && (!matrixRows || matrixRows.some(row => row.accountId === target.accountId && row.platform === platform)));
      if (!eligible.length) continue;
      const groups = input.matrixPlan ? eligible.map(target => [target]) : [eligible];
      for (const group of groups) {
        const row = matrixRows?.find(item => item.accountId === group[0]!.accountId);
        const language = row?.language;
        const automation = record(spec.automation);
        if (language && (automation.renderOutputPath || !Object.keys(record(spec.languageRenderOutputs)).length) && text(spec.lang || videoPlan.language) && text(spec.lang || videoPlan.language) !== language) throw Error(`作品 ${project.id} 的语言与账号安排不一致，请制作对应语言版本后再发布`);
        const languagePath = language ? text(record(record(spec.languageRenderOutputs)[language]).path) : '';
        const declaredLanguage = text(spec.lang || videoPlan.language);
        const paths = language ? publishablePaths.filter(path => path === languagePath || (!languagePath && (!declaredLanguage || declaredLanguage === language))) : publishablePaths;
        if (language && !paths.length) throw Error(`作品 ${project.id} 尚无账号所需的 ${language} 语言成片`);
        for (const videoPath of paths) {
          let sourceClaim: FrozenPublishSourceClaim;
          try { sourceClaim = dependencies.sourceClaim(input.tenantId, project, videoPath); }
          catch { continue; }
          items.push({
            sourceProjectId: project.id, platform,
            accountIds: group.map(target => target.accountId), accountLabels: group.map(target => target.accountLabel),
            title: text(publication.title) || text(spec.publicationTitle) || text(project.title) || `内容作品 ${project.id}`,
            description: text(publication.caption) || text(spec.caption) || text(spec.script) || '',
            tags: Array.isArray(publication.tags) ? publication.tags.map(text).filter(Boolean).slice(0, 20) : [], videoPath,
            scheduledAt: nextDailySlot(items.length, now), sourceClaim,
            ...(text(videoPlan.plannedPublishDate) ? { plannedPublishDate: text(videoPlan.plannedPublishDate) } : {}),
            ...(text(videoPlan.plannedPublishAt) ? { plannedPublishAt: text(videoPlan.plannedPublishAt) } : {}),
          });
        }
      }
    }
  }
  if (input.scheduling) {
    // Schedule independently per account. A group spanning zones must not share one UTC slot.
    const expanded = items.flatMap(item => item.accountIds.map((id, index) => ({ ...item, accountIds: [id], accountLabels: [item.accountLabels[index]] })));
    for (const target of input.targets) {
      const own = expanded.filter(item => item.accountIds[0] === target.accountId);
      if (!own.length) continue;
      const fallbackItems: PublishingApprovalItem[] = [];
      own.forEach(item => {
        const requested = item.plannedPublishDate;
        const requestedAt = item.plannedPublishAt;
        if (requested && requested >= input.scheduling!.startsAt && requested <= input.scheduling!.endsAt) {
          item.scheduledAt = Number.isFinite(Date.parse(requestedAt || ''))
            ? new Date(requestedAt!).toISOString()
            : new Date(`${requested}T18:00:00+08:00`).toISOString();
        } else {
          fallbackItems.push(item);
        }
      });
      // A frozen weekly plan already carries an absolute publish instant (or
      // the product's explicit 18:00 Beijing date default). Account timezone
      // is needed only when this package must calculate an unplanned slot.
      if (fallbackItems.length) {
        const timezone = input.scheduling.timezone === 'account' ? target.timezone || '' : 'Asia/Shanghai';
        const slots = boundedPublishingSlots({ ...input.scheduling, timezone, count: fallbackItems.length, now });
        fallbackItems.forEach((item, index) => { item.scheduledAt = slots[index]!; });
      }
    }
    items.splice(0, items.length, ...expanded);
  }
  // Explicit conversion of a production-only add-on binds one destination and
  // one instant. It must never fall back to other accounts or an older grant.
  const explicitlyBound = items.flatMap(item => {
    const project = input.projects.find(p => p.id === item.sourceProjectId);
    const intent = record(record(record(project?.spec).contentOrder).explicitPublishingIntent);
    if (!Object.keys(intent).length) return [item];
    if (!text(intent.confirmedBy) || !Number.isFinite(Date.parse(text(intent.publishAt)))) throw Error('explicit_publication_intent_invalid');
    if (input.boundedAuthorization) throw Error('explicit_publication_requires_fresh_approval');
    const accountId = text(intent.accountId), index = item.accountIds.indexOf(accountId);
    if (item.platform !== intent.platform || index < 0) return [];
    return [{ ...item, accountIds: [accountId], accountLabels: [item.accountLabels[index]], scheduledAt: new Date(text(intent.publishAt)).toISOString() }];
  });
  items.splice(0, items.length, ...explicitlyBound);
  const authorizationSnapshot = input.boundedAuthorization
    ? buildBoundedPublishingAuthorization(input.boundedAuthorization)
    : undefined;
  if (authorizationSnapshot) {
    const publishActions = items.reduce((count, item) => count + item.accountIds.length, 0);
    if (publishActions > authorizationSnapshot.maxPublishItems) throw new Error('bounded_authorization_item_limit_exceeded');
    for (const item of items) for (const accountId of item.accountIds) {
      const issue = boundedAuthorizationIssue(authorizationSnapshot, { accountId, platform: item.platform, scheduledAt: item.scheduledAt });
      if (issue) throw new Error(issue);
    }
  }
  return {
    schemaVersion: 1,
    contentHash: contentFingerprint(items, input.allowRealPublishing, authorizationSnapshot),
    allowRealPublishing: input.allowRealPublishing,
    ...(authorizationSnapshot ? { authorizationSnapshot } : {}),
    items,
  };
}

async function tenantPosts(tenantId: string): Promise<any[]> {
  const posts: any[] = [];
  for (let page = 1; ; page += 1) {
    const result = await store.list<any>('posts', { where: { tenant_id: tenantId }, page, perPage: 500 });
    posts.push(...result.items);
    if (page >= result.totalPages || !result.items.length) return posts;
  }
}

/** Idempotently materialize an approved package in the publishing calendar. */
export async function createPublishingCalendarEntries(input: {
  tenantId: string;
  runId: string;
  approvalTaskId: string;
  approvalId: string;
  approvedContentHash: string;
  package: PublishingApprovalPackage;
  managedPublishingGrantId?: string;
}, dependencies: {
  verifySource: (tenantId: string, claim: unknown, videoPath?: unknown) => Promise<unknown>;
} = { verifySource: verifyFrozenPublishSourceClaim }): Promise<Array<{ id: string; status: string }>> {
  if (input.package.contentHash !== input.approvedContentHash
    || contentFingerprint(input.package.items, input.package.allowRealPublishing, input.package.authorizationSnapshot) !== input.approvedContentHash) throw new Error('approval_subject_changed');
  return withDigitalEmployeeRunLock(input.tenantId, input.runId, async () => {
  const materialize = async (lease?: DurableOperationLease) => {
  const existing = await tenantPosts(input.tenantId);
  const matchesItem = (post: any, item: PublishingApprovalItem) => {
    const stats = record(post.stats);
    return text(stats.workflowRunId) === input.runId && text(stats.sourceProjectId) === item.sourceProjectId
      && text(post.platform) === item.platform && text(stats.approvedContentHash) === input.approvedContentHash
      && text(stats.videoPath) === item.videoPath && JSON.stringify(stats.publishSourceClaim) === JSON.stringify(item.sourceClaim)
      && Array.isArray(stats.targetAccountIds) && JSON.stringify(stats.targetAccountIds.slice().sort()) === JSON.stringify([...item.accountIds].sort());
  };
  if (input.managedPublishingGrantId) {
    const run = await store.getById<any>('workflow_runs', input.runId);
    const plan = run && await store.getById<any>('weekly_plans', text(run.plan_id));
    const body = record(plan?.plan), authorization = record(record(body.businessPackage).authorization);
    const authorizedAccountIds = Array.isArray(authorization.accountIds) ? authorization.accountIds : null;
    if (run?.tenant_id !== input.tenantId || plan?.tenant_id !== input.tenantId
      || body.managedPublishingGrantId !== input.managedPublishingGrantId || authorization.mode !== 'bounded'
      || !authorizedAccountIds || input.package.items.some(item => item.accountIds.some(id => !authorizedAccountIds.includes(id)))) {
      throw new Error('managed_publishing_scope_changed');
    }
    const bindings: any[] = [];
    for (let page = 1; ; page++) {
      const result = await store.list<any>('run_events', { where: { tenant_id: input.tenantId, run_id: input.runId, type: 'social_content.publishing_bound' }, page, perPage: 100 });
      bindings.push(...result.items);
      if (!result.items.length || page >= result.totalPages) break;
    }
    const capacity = managedPublishingCapacity({ maxPublishItems: Number(authorization.maxPublishItems),
      posts: existing.filter(post => text(record(post.stats).workflowRunId) === input.runId), bindings,
      additions: input.package.items.filter(item => !existing.some(post => matchesItem(post, item))),
    });
    if (!capacity.allowed) throw new Error('managed_publishing_cycle_limit_exceeded');
  }
  const result: Array<{ id: string; status: string }> = [];
  for (const item of input.package.items) {
    try { await dependencies.verifySource(input.tenantId, item.sourceClaim, item.videoPath); }
    catch { throw new Error('approval_subject_changed'); }
    const found = existing.find(post => {
      const stats = record(post.stats);
      return text(stats.workflowRunId) === input.runId && text(stats.sourceProjectId) === item.sourceProjectId
        && text(post.platform) === item.platform && text(stats.approvedContentHash) === input.approvedContentHash
        && text(stats.videoPath) === item.videoPath
        && JSON.stringify(stats.publishSourceClaim) === JSON.stringify(item.sourceClaim)
        && (!Array.isArray(stats.targetAccountIds) || JSON.stringify(stats.targetAccountIds.slice().sort()) === JSON.stringify([...item.accountIds].sort()));
    });
    if (found) { result.push({ id: found.id, status: text(record(found.stats).status) }); continue; }
    if (lease) await assertDurableOperationLease({ dataStore: store, lease });
    const status = input.package.allowRealPublishing ? 'scheduled' : 'awaiting_manual_publish';
    // Save the approval identity and complete calendar subject in the same create.
    // A failed or ambiguously completed write can then be recovered by its identity.
    const tracked = await createTrackedPostDraft(input.tenantId, { contentId: item.sourceProjectId, platform: item.platform, title: item.title, enabled: true }, {
      published_at: item.scheduledAt,
      stats: {
        status, description: item.description, hashtags: item.tags || [], videoPath: item.videoPath,
        targetAccountIds: item.accountIds, targetAccountLabels: item.accountLabels,
        publishAttempts: 0, publishResults: {}, warnings: [], sourceProjectId: item.sourceProjectId,
        publishSourceClaim: item.sourceClaim,
        workflowRunId: input.runId, workflowTaskId: input.approvalTaskId, workflowTaskKey: 'content_release_approval',
        approvalId: input.approvalId, approvedContentHash: input.approvedContentHash,
        realPublishingAuthorized: input.package.allowRealPublishing,
        ...(input.managedPublishingGrantId ? { managedPublishingGrantId: input.managedPublishingGrantId } : {}),
        authorizationMode: input.package.authorizationSnapshot ? 'bounded' : 'each',
        ...(input.package.authorizationSnapshot ? { boundedAuthorization: input.package.authorizationSnapshot } : {}),
      },
    });
    existing.push(tracked);
    result.push({ id: tracked.id, status });
  }
  return result;
  };
  return input.managedPublishingGrantId
    ? withManagedPublishingCycleLease({ tenantId: input.tenantId, runId: input.runId, dataStore: store }, materialize)
    : materialize();
  });
}

/** Stop future delivery when an already approved source project changes. */
export async function invalidatePublishingApprovalForProject(
  tenantId: string,
  projectId: string,
): Promise<number> {
  const posts = await tenantPosts(tenantId);
  const affected = posts.filter(post => {
    const stats = record(post.stats);
    return text(stats.sourceProjectId) === projectId
      && Boolean(text(stats.approvalId))
      && !['published', 'partial'].includes(text(stats.status));
  });
  const invalidatedAt = new Date().toISOString();
  const approvalIds = new Set<string>();
  for (const post of affected) {
    const stats = record(post.stats);
    approvalIds.add(text(stats.approvalId));
    await store.update('posts', post.id, {
      stats: { ...stats, status: 'awaiting_reapproval', approvedContentHash: '', realPublishingAuthorized: false },
    });
  }
  for (const approvalId of approvalIds) {
    const initialApproval = await store.getById<any>('approval_requests', approvalId);
    if (!initialApproval || initialApproval.tenant_id !== tenantId) continue;
    await withDigitalEmployeeRunLock(tenantId, text(initialApproval.run_id), async () => {
    const approval = await store.getById<any>('approval_requests', approvalId);
    if (!approval || approval.tenant_id !== tenantId || approval.status === 'superseded') return;
    await store.update('approval_requests', approvalId, {
      status: 'superseded', decision_note: '源作品已修改，原发布审批自动失效。', decided_at: invalidatedAt,
    });
    const task = await store.getById<any>('workflow_tasks', text(approval.task_id));
    if (task?.tenant_id === tenantId && text(task.run_id) === text(approval.run_id)) {
      await store.update('workflow_tasks', task.id, {
        ...(!['cancelled', 'handed_off'].includes(text(task.status)) ? { status: 'waiting_external' } : {}),
        task_version: Number(task.task_version || 1) + 1,
        blocked_reason: '源作品已修改，需要重新完成质量检查并发起审批。', updated_at: invalidatedAt,
      });
      const run = await store.getById<any>('workflow_runs', text(task.run_id));
      if (!runExternalActionBlockedReason(run, tenantId)) {
        await store.update('workflow_runs', run.id, { status: 'waiting_external', current_controller: 'human', pause_reason: '源作品已修改，等待重新审批。' });
      }
    }
    });
  }
  return affected.length;
}

/** Bridge approved social artifacts into the existing approval/calendar worker.
 * Callers must bind an explicit run/authorization and validate account scope;
 * constructing this immutable package never authorizes or submits a post. */
export async function buildSocialContentPublishingPackage(input: {
  tenantId: string;
  allowRealPublishing: boolean;
  items: Array<{
    taskId: string; artifactId: string; platform: PublishingPlatform;
    accountId: string; accountLabel: string; title: string; description: string; scheduledAt: string;
  }>;
}, dependencies?: {
  freezeSource: (input: { tenantId: string; taskId: string; artifactId: string }) => Promise<FrozenPublishSourceClaim>;
}): Promise<PublishingApprovalPackage> {
  const freezeSource = dependencies?.freezeSource
    ?? (await import('../publishing/socialContentSourceClaim.js')).freezeSocialContentPublishSource;
  const items: PublishingApprovalItem[] = [];
  const seen = new Set<string>();
  for (const item of input.items) {
    if (!item.accountId || !item.taskId || !item.artifactId || !Number.isFinite(Date.parse(item.scheduledAt))) {
      throw new Error('social_publishing_assignment_invalid');
    }
    const identity = JSON.stringify([item.taskId, item.artifactId, item.platform, item.accountId, item.scheduledAt]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const sourceClaim = await freezeSource({ tenantId: input.tenantId, taskId: item.taskId, artifactId: item.artifactId });
    items.push({ sourceProjectId: item.taskId, platform: item.platform, accountIds: [item.accountId],
      accountLabels: [item.accountLabel], title: item.title, description: item.description,
      videoPath: sourceClaim.deliveryVideoPath, scheduledAt: item.scheduledAt, sourceClaim });
  }
  return { schemaVersion: 1, contentHash: contentFingerprint(items, input.allowRealPublishing), allowRealPublishing: input.allowRealPublishing, items };
}

/** Pause queued delivery when the approved weekly-package boundary changes. */
export async function invalidatePublishingAuthorizationForRun(
  tenantId: string,
  runId: string,
): Promise<number> {
  return withDigitalEmployeeRunLock(tenantId, runId, async () => {
    const posts = await tenantPosts(tenantId);
    const affected = posts.filter(post => {
      const stats = record(post.stats);
      if (text(stats.workflowRunId) !== runId || ['published', 'partial', 'awaiting_reapproval'].includes(text(stats.status))) return false;
      const results = record(stats.publishResults);
      // Provider-accepted, successful, or ambiguous calls must remain in the
      // receipt-recovery path. Revoking them here could cause a duplicate send.
      return !Object.values(results).some(value => {
        const status = text(record(value).status);
        return ['published', 'provider_accepted', 'in_flight', 'unknown'].includes(status);
      });
    });
    for (const post of affected) {
      const stats = record(post.stats);
      await store.update('posts', post.id, { stats: {
        ...stats,
        status: 'awaiting_reapproval',
        realPublishingAuthorized: false,
        nextPublishAttemptAt: '',
        authorizationInvalidatedAt: new Date().toISOString(),
        authorizationInvalidatedReason: 'weekly_package_changed',
      } });
    }
    return affected.length;
  });
}
