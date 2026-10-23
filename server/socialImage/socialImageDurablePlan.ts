import { createHash } from 'node:crypto';
import type { DataStore } from '../storage/datastore.js';
import type { SocialImageCreationTask, SocialImageFrozenRenderPlan, SocialImageGenerationJob } from '../../shared/contracts/socialImageCreation.js';
import { requireSocialImageAtomicStore, SocialImagePaidJobError } from './socialImagePaidJob.js';
import { planSocialImageRenderUnits } from './socialImageRenderPlan.js';
import { readSocialImageTask, updateSocialImageTask, SOCIAL_IMAGE_TASKS_COLLECTION } from './socialImageTask.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

/** Snapshot every field that can affect a paid multi-output render. */
export function socialImagePlanSourceHash(task: SocialImageCreationTask): string {
  return digest({
    taskId: task.id, imageType: task.imageType, creationPath: task.creationPath,
    contentBrief: task.contentBrief, creativeRecipe: task.creativeRecipe,
    imageTextContract: task.imageTextContract, renderBrief: task.renderBrief,
    deliverySpec: task.deliverySpec, materialIds: task.materialIds,
    referenceUrls: task.referenceUrls, referenceSnapshot: task.referenceSnapshot,
    replicationRecipe: task.replicationRecipe, enterpriseAssets: task.enterpriseAssets,
    layerGraph: task.layerGraph,
  });
}

/** Derive paid render inputs solely from the frozen task, never from browser fields. */
export function socialImagePlannedRenderInput(task: SocialImageCreationTask, jobId: string) {
  const plan = task.renderPlan;
  if ((task.imageType !== 'carousel' && task.imageType !== 'gif_poster') || !plan
    || plan.sourceHash !== socialImagePlanSourceHash(task)) {
    throw new SocialImagePaidJobError('social_image_frozen_plan_invalid');
  }
  const unit = plan.units.find(item => item.jobId === jobId);
  const job = task.generationJobs.find(item => item.id === jobId);
  if (!unit || !job || job.planVersion !== plan.version || job.unitIndex !== unit.index
    || job.plannedInputHash !== unit.plannedInputHash || job.idempotencyKey !== unit.idempotencyKey
    || unit.role !== (task.imageType === 'carousel' ? 'carousel_page' : 'gif_plate')) {
    throw new SocialImagePaidJobError('social_image_planned_unit_identity_invalid');
  }
  if (unit.plannedInputHash !== digest({ sourceHash: plan.sourceHash, planVersion: plan.version,
    unitIndex: unit.index, role: unit.role, poster: unit.poster })) {
    throw new SocialImagePaidJobError('social_image_planned_unit_content_changed');
  }
  if (job.status !== 'queued' || job.inputHash || job.outputNodeIds.length) {
    throw new SocialImagePaidJobError('social_image_paid_job_already_started');
  }
  const ratio = task.deliverySpec.aspectRatio;
  const quality = task.deliverySpec.imageGeneration?.quality || 'low';
  if (!['1:1', '4:5', '9:16'].includes(ratio) || !['low', 'medium', 'high'].includes(quality)) {
    throw new SocialImagePaidJobError('social_image_planned_unit_render_config_invalid');
  }
  return {
    unit,
    poster: structuredClone(unit.poster),
    ratio,
    quality,
    // GIF units buy background plates only. Frozen enterprise product bytes are
    // added by the deterministic compositor, never sent to the image model.
    materialIds: task.imageType === 'gif_poster' ? [] : [...task.materialIds],
    productIds: task.imageType === 'gif_poster' ? [] : [...task.contentBrief.productRefs],
    referenceImageUrls: task.referenceSnapshot?.imageUrls.slice(0, 1) || [],
    referencePlan: [],
    deliverableType: unit.index === 0 && task.imageType === 'carousel' ? 'carousel_cover' : 'social_poster',
    productionStrategy: 'reference_generate',
    idempotencyKey: unit.idempotencyKey,
    imagePrompt: task.imageType === 'gif_poster'
      ? `Variable scene background ${unit.index + 1} of ${unit.count}; use a distinct lighting or atmosphere state. No product, package, brand or text.`
      : [
          `Create carousel page ${unit.index + 1} of ${unit.count}.`,
          `Unit role: ${unit.role}. Core claim: ${task.contentBrief.coreClaim}.`,
          `Narrative page role: ${String(unit.poster.pageRole || 'cover')}.`,
          'Preserve the frozen page headline and subheadline. This page must remain distinct from the other carousel pages.',
        ].join(' '),
  };
}

/** Freeze carousel/GIF units and receipt identities before any paid call. */
export async function persistSocialImageMultiUnitPlan(input: {
  store: DataStore; tenantId: string; taskId: string; expectedVersion: number;
  productHashes?: Record<string, string>;
}): Promise<SocialImageCreationTask> {
  await requireSocialImageAtomicStore(input.store);
  const task = await readSocialImageTask(input.store, input.tenantId, input.taskId);
  if (!task) throw new SocialImagePaidJobError('social_image_task_missing');
  if (task.imageType !== 'carousel' && task.imageType !== 'gif_poster') {
    throw new SocialImagePaidJobError('social_image_multi_plan_type_required');
  }
  if (task.imageType === 'gif_poster' && input.productHashes
    && (task.contentBrief.productRefs.length < 1 || task.contentBrief.productRefs.length > 2)) {
    throw new SocialImagePaidJobError('social_image_gif_product_count_invalid');
  }
  if (!task.renderBrief?.headline) throw new SocialImagePaidJobError('social_image_render_brief_required');
  const frozenAssets = input.productHashes ? task.enterpriseAssets.map(asset => asset.role === 'product'
    && task.contentBrief.productRefs.includes(asset.assetId)
    ? { ...asset, contentHash: input.productHashes![asset.assetId] } : asset) : task.enterpriseAssets;
  if (input.productHashes && task.contentBrief.productRefs.some(id => !/^[a-f0-9]{64}$/.test(input.productHashes?.[id] || '')
    || !frozenAssets.some(asset => asset.role === 'product' && asset.assetId === id && asset.contentHash === input.productHashes?.[id]))) {
    throw new SocialImagePaidJobError('social_image_product_asset_unavailable');
  }
  const sourceHash = socialImagePlanSourceHash({ ...task, enterpriseAssets: frozenAssets });
  if (task.renderPlan?.sourceHash === sourceHash && task.renderPlan.units.every(unit => task.generationJobs.some(job => (
    job.id === unit.jobId && job.idempotencyKey === unit.idempotencyKey && job.plannedInputHash === unit.plannedInputHash
  )))) return task;
  if (task.version !== input.expectedVersion) throw new SocialImagePaidJobError('social_image_plan_version_conflict');
  if (task.generationJobs.some(job => ['queued', 'running', 'outcome_unknown'].includes(job.status) && !job.outputNodeIds.length)) {
    throw new SocialImagePaidJobError('social_image_prior_paid_job_unresolved');
  }
  const planVersion = Math.max(task.renderPlan?.version || 0, ...task.generationJobs.map(job => job.planVersion || 0)) + 1;
  const createdAt = new Date().toISOString();
  const units = planSocialImageRenderUnits({
    imageType: task.imageType, poster: task.renderBrief as Record<string, unknown>,
    idempotencyKey: `${task.id}:plan:${planVersion}`, requestedCount: task.deliverySpec.outputCount,
  }).map(unit => {
    if (unit.role === 'single') throw new SocialImagePaidJobError('social_image_multi_plan_unit_invalid');
    return {
      ...unit, role: unit.role as 'carousel_page' | 'gif_plate',
      jobId: digest({ taskId: task.id, planVersion, unitIndex: unit.index }).slice(0, 32),
      plannedInputHash: digest({ sourceHash, planVersion, unitIndex: unit.index, role: unit.role, poster: unit.poster }),
    };
  });
  const renderPlan: SocialImageFrozenRenderPlan = { version: planVersion, sourceHash, createdAt, units };
  const jobs: SocialImageGenerationJob[] = units.map(unit => ({
    id: unit.jobId, idempotencyKey: unit.idempotencyKey,
    planVersion, unitIndex: unit.index, plannedInputHash: unit.plannedInputHash,
    status: 'queued', outputNodeIds: [], attempt: 0, createdAt, updatedAt: createdAt,
  }));
  const saved = await updateSocialImageTask(input.store, input.tenantId, task.id, task.version, {
    status: 'planned', step: 'generate', renderPlan, generationJobs: [...task.generationJobs, ...jobs],
    enterpriseAssets: frozenAssets,
    gifDelivery: undefined,
    outputs: task.outputs.map(output => task.gifDelivery
      && [...task.gifDelivery.frameOutputIds, task.gifDelivery.finalOutputId].includes(output.id)
      ? { ...output, state: 'superseded' as const } : output),
  });
  if (saved.kind !== 'updated') throw new SocialImagePaidJobError('social_image_plan_write_conflict');
  return saved.task;
}

/** Retire an unresolvable plan without erasing receipts or retrying any paid unit. */
export async function abandonSocialImageMultiUnitPlan(input: {
  store: DataStore; tenantId: string; taskId: string; expectedVersion: number;
}): Promise<SocialImageCreationTask> {
  await requireSocialImageAtomicStore(input.store);
  const row = await input.store.getById<{ id: string; tenant_id: string; spec: { socialImageTask?: SocialImageCreationTask } }>(
    SOCIAL_IMAGE_TASKS_COLLECTION, input.taskId);
  const task = row?.spec?.socialImageTask;
  if (!row || row.tenant_id !== input.tenantId || !task || task.contentMode !== 'image') {
    throw new SocialImagePaidJobError('social_image_task_missing');
  }
  if (task.version !== input.expectedVersion) throw new SocialImagePaidJobError('social_image_plan_version_conflict');
  const plan = task.renderPlan;
  if ((task.imageType !== 'carousel' && task.imageType !== 'gif_poster') || !plan) {
    throw new SocialImagePaidJobError('social_image_frozen_plan_invalid');
  }
  if (task.status === 'approved') throw new SocialImagePaidJobError('social_image_approved_plan_immutable');
  const planJobs = plan.units.map(unit => task.generationJobs.find(job => job.id === unit.jobId
    && job.planVersion === plan.version && job.unitIndex === unit.index && job.plannedInputHash === unit.plannedInputHash));
  if (planJobs.some((job, index) => !job || job.idempotencyKey !== plan.units[index]?.idempotencyKey)) {
    throw new SocialImagePaidJobError('social_image_planned_unit_identity_invalid');
  }
  if (planJobs.some(job => !job || ['running', 'outcome_unknown'].includes(job.status)
    || (job.status === 'queued' && (job.attempt !== 0 || job.inputHash || job.providerReceipt || job.outputNodeIds.length))
    || (job.status === 'failed' && (job.providerReceipt || job.outputNodeIds.length))
    || (!['queued', 'failed'].includes(job.status) && (!['quality_checking', 'completed'].includes(job.status)
      || !job.outputNodeIds.length || !job.outputNodeIds.every(id => task.outputs.some(output => output.id === id && output.materialId && output.mediaUrl)))))) {
    throw new SocialImagePaidJobError('social_image_plan_outcome_unresolved');
  }
  const retiredIds = new Set([
    ...planJobs.flatMap(job => job?.outputNodeIds || []),
    ...(task.gifDelivery?.planVersion === plan.version
      ? [...task.gifDelivery.frameOutputIds, task.gifDelivery.finalOutputId] : []),
  ]);
  const now = new Date().toISOString();
  const next: SocialImageCreationTask = {
    ...task, version: task.version + 1, renderPlan: undefined, gifDelivery: undefined,
    status: 'planned', step: 'inputs', publishable: false, updatedAt: now,
    generationJobs: task.generationJobs.map(job => planJobs.some(current => current?.id === job.id) && job.status === 'queued'
      ? { ...job, status: 'failed', error: 'plan_abandoned_before_submission', updatedAt: now } : job),
    outputs: task.outputs.map(output => retiredIds.has(output.id) ? { ...output, state: 'superseded' } : output),
  };
  const saved = await input.store.compareAndSwap!(SOCIAL_IMAGE_TASKS_COLLECTION, row.id,
    { tenant_id: input.tenantId, spec: row.spec },
    { spec: { ...row.spec, socialImageTask: next }, status: 'draft', updated_at: now });
  if (!saved) throw new SocialImagePaidJobError('social_image_plan_abandon_conflict');
  return next;
}

/** Reserve one frozen multi-output unit with the exact server-built provider request hash. This does not submit it. */
export async function claimSocialImagePlannedUnit(input: {
  store: DataStore; tenantId: string; taskId: string; jobId: string; idempotencyKey: string;
  plannedInputHash: string; renderRequestHash: string;
}): Promise<SocialImageCreationTask> {
  await requireSocialImageAtomicStore(input.store);
  if (!/^[a-f0-9]{64}$/.test(input.renderRequestHash)) {
    throw new SocialImagePaidJobError('social_image_render_request_hash_invalid');
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const task = await readSocialImageTask(input.store, input.tenantId, input.taskId);
    if (!task) throw new SocialImagePaidJobError('social_image_task_missing');
    socialImagePlannedRenderInput(task, input.jobId);
    const plan = task.renderPlan;
    if ((task.imageType !== 'carousel' && task.imageType !== 'gif_poster') || !plan || plan.sourceHash !== socialImagePlanSourceHash(task)) {
      throw new SocialImagePaidJobError('social_image_frozen_plan_invalid');
    }
    const unit = plan.units.find(item => item.jobId === input.jobId);
    const job = task.generationJobs.find(item => item.id === input.jobId);
    if (!unit || !job || unit.idempotencyKey !== input.idempotencyKey || unit.plannedInputHash !== input.plannedInputHash
      || job.idempotencyKey !== unit.idempotencyKey || job.planVersion !== plan.version
      || job.unitIndex !== unit.index || job.plannedInputHash !== unit.plannedInputHash) {
      throw new SocialImagePaidJobError('social_image_planned_unit_identity_invalid');
    }
    if (job.status !== 'queued' || job.inputHash || job.outputNodeIds.length) {
      throw new SocialImagePaidJobError('social_image_paid_job_already_started');
    }
    if (plan.units.some(other => other.index < unit.index && task.generationJobs.some(previous =>
      previous.id === other.jobId && !previous.outputNodeIds.length))) {
      throw new SocialImagePaidJobError('social_image_prior_paid_job_unresolved');
    }
    const now = new Date().toISOString();
    const saved = await updateSocialImageTask(input.store, input.tenantId, task.id, task.version, {
      status: 'generating', step: 'generate',
      generationJobs: task.generationJobs.map(item => item.id === job.id
        ? { ...item, status: 'running', inputHash: input.renderRequestHash, attempt: item.attempt + 1, updatedAt: now }
        : item),
    });
    if (saved.kind === 'updated') return saved.task;
    if (saved.kind !== 'conflict') throw new SocialImagePaidJobError('social_image_planned_unit_claim_invalid');
  }
  throw new SocialImagePaidJobError('social_image_planned_unit_claim_conflict');
}
