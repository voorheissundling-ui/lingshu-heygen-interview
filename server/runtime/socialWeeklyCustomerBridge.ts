import {verifyWeeklyCustomerMemberProof} from '../socialPrograms/weeklyCustomerMemberProof.js';
import {verifyWeeklyNativeMember} from '../socialPrograms/weeklyCustomerChannelSelections.js';
import {readWeeklyCustomerRelationshipScope,verifyFrozenWeeklyCustomerRelationship} from '../socialPrograms/weeklyCustomerRelationshipScope.js';
import { createHash } from 'node:crypto';
import type { DataStore, Record_ } from '../storage/datastore.js';
import type { VersionedSocialRef } from '../../shared/contracts/socialProgram.js';
import { SocialProgramError } from '../socialPrograms/service.js';
import { orderedFollowupItems } from '../digitalEmployees/followupDraftFreeze.js';
import { followupItemContentHash, type FollowupBatchItemRecord } from '../digitalEmployees/customerWorkflow.js';
import { withLocalQueue } from '../routes/digitalEmployeeRecords.js';
import { withDigitalEmployeeRunLock } from '../digitalEmployees/runControl.js';

const bindingQueues = new Map<string, Promise<void>>();
export const WEEKLY_CUSTOMER_BINDINGS = 'social_weekly_customer_bindings';
export interface WeeklyCustomerAuthority {
  tenantId: string; programId: string; packageId: string; packageVersion: number;
}
export type WeeklyCustomerStep = 'customer_segmentation' | 'customer_followup_draft' | 'customer_followup_approval' | 'customer_followup_dispatch';
const KEYS: Record<WeeklyCustomerStep, string> = {
  customer_segmentation: 'customer_segmentation', customer_followup_draft: 'followup_batch_draft',
  customer_followup_approval: 'followup_batch_approval', customer_followup_dispatch: 'followup_dispatch',
};
const obj = (value: unknown): Record<string, any> => {
  if (typeof value === 'string') { try { return obj(JSON.parse(value)); } catch { return {}; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
};
function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stableValue(item)]));
}
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
function requireProof(value: unknown, code = 'weekly_customer_evidence_unverified'): asserts value {
  if (!value) throw new SocialProgramError(code, 409, '客服任务的周版本、运行身份或真实完成证据尚未核验。');
}
const identity = (a: WeeklyCustomerAuthority) => ({ tenant_id: a.tenantId, program_id: a.programId, package_id: a.packageId, package_version: a.packageVersion });
async function rows(store: DataStore, collection: string, where: Record<string, string | number>, sort = 'id'): Promise<Record_[]> {
  const result: Record_[] = [];
  for (let page = 1; ; page++) {
    const part = await store.list<Record_>(collection, { where, sort, page, perPage: 250 });
    requireProof(part.items.every(row => Object.entries(where).every(([key, value]) => row[key] === value)));
    requireProof(part.items.every(row => !result.some(old => old.id === row.id)), 'weekly_customer_read_changed');
    result.push(...part.items);
    if (result.length >= part.totalItems) return result;
    requireProof(part.items.length > 0, 'weekly_customer_read_incomplete');
  }
}
async function context(store: DataStore, authority: WeeklyCustomerAuthority, runId: string) {
  requireProof(Object.values(identity(authority)).every(value => typeof value === 'number' ? Number.isSafeInteger(value) && value > 0 : Boolean(text(value))), 'weekly_customer_authority_invalid');
  const packages = await rows(store, 'social_weekly_operating_packages', { tenant_id: authority.tenantId, program_id: authority.programId, package_id: authority.packageId, version: authority.packageVersion });
  requireProof(packages.length === 1, 'weekly_customer_package_missing');
  const pkg = obj(packages[0]!.payload);
  requireProof(pkg.programId === authority.programId && pkg.packageId === authority.packageId && pkg.version === authority.packageVersion);
  const run = await store.getById<Record_>('workflow_runs', runId);
  requireProof(run?.tenant_id === authority.tenantId && text(run.goal_id) && text(run.plan_id), 'weekly_customer_run_unavailable');
  const goal = await store.getById<Record_>('weekly_goals', String(run.goal_id));
  const plan = await store.getById<Record_>('weekly_plans', String(run.plan_id));
  requireProof(goal?.tenant_id === authority.tenantId && plan?.tenant_id === authority.tenantId && plan.goal_id === goal.id);
  requireProof(['full_funnel', 'customer_conversion'].includes(String(goal.business_line)), 'weekly_customer_goal_incompatible');
  const start = Date.parse(String(goal.starts_at)); const end = Date.parse(String(goal.ends_at));
  const weekStart = Date.parse(`${pkg.weekStart}T00:00:00Z`); const weekEnd = Date.parse(`${pkg.weekEnd}T23:59:59.999Z`);
  requireProof([start, end, weekStart, weekEnd].every(Number.isFinite) && start <= end && start <= weekEnd && end >= weekStart, 'weekly_customer_week_mismatch');
  const tasks = await rows(store, 'workflow_tasks', { tenant_id: authority.tenantId, run_id: runId });
  requireProof(tasks.length > 0 && tasks.every(task => task.goal_id === run.goal_id && task.plan_id === run.plan_id));
  return { pkg, run, tasks };
}
/** Called only after an authenticated user explicitly chooses this existing customer run.
 * Binding does not start, approve or send anything. A run cannot be reattributed to a different week/program. */
export async function bindWeeklyCustomerRun(store: DataStore, authority: WeeklyCustomerAuthority, runId: string, actorId: string, now = new Date()) {
  requireProof(text(actorId) && text(runId) && Number.isFinite(now.getTime()), 'weekly_customer_binding_input_invalid');
  return withLocalQueue(bindingQueues, JSON.stringify(identity(authority)), () => withDigitalEmployeeRunLock(authority.tenantId, runId, async () => {
    const { run, tasks } = await context(store, authority, runId);
    requireProof(!['cancelled', 'failed', 'dead_letter'].includes(String(run.status)), 'weekly_customer_run_inactive');
    requireProof(Object.values(KEYS).some(key => tasks.some(task => task.task_key === key && task.agent_role === 'customer')), 'weekly_customer_tasks_missing');
    const existing = await rows(store, WEEKLY_CUSTOMER_BINDINGS, { tenant_id: authority.tenantId, run_id: runId });
    requireProof(existing.length <= 1, 'weekly_customer_binding_ambiguous');
    if (existing.length) {
      requireProof(Object.entries(identity(authority)).every(([key, value]) => existing[0]![key] === value), 'weekly_customer_binding_conflict');
      return existing[0]!;
    }
    const competing = await rows(store, WEEKLY_CUSTOMER_BINDINGS, identity(authority));
    requireProof(competing.length === 0, 'weekly_customer_package_already_bound');
    const bindingId = createHash('sha256').update(JSON.stringify([authority.tenantId, authority.programId, authority.packageId, authority.packageVersion, runId])).digest('hex').slice(0, 24);
    const created = await store.create<Record_>(WEEKLY_CUSTOMER_BINDINGS, {
      ...identity(authority), binding_id: bindingId, run_id: runId, goal_id: run.goal_id, plan_id: run.plan_id,
      version: 1, bound_by: actorId, bound_at: now.toISOString(),
    });
    requireProof(created, 'weekly_customer_binding_write_failed');
    return created;
  }));
}
export interface WeeklyCustomerStepEvidence {
  status: 'succeeded' | 'blocked' | 'no_data'; reason: string | null; runId: string; taskId: string;
  resultRefs: VersionedSocialRef[];
}
/** Read existing production evidence. Never converts a metadata-only task success into customer success. */
export async function readWeeklyCustomerStep(store: DataStore, authority: WeeklyCustomerAuthority, runId: string, step: WeeklyCustomerStep): Promise<WeeklyCustomerStepEvidence> {
  requireProof(Object.hasOwn(KEYS, step), 'weekly_customer_step_unsupported');
  const { run, tasks } = await context(store, authority, runId);
  const bindings = await rows(store, WEEKLY_CUSTOMER_BINDINGS, identity(authority));
  requireProof(bindings.length === 1 && bindings[0]!.run_id === runId && bindings[0]!.goal_id === run.goal_id && bindings[0]!.plan_id === run.plan_id && text(bindings[0]!.bound_by), 'weekly_customer_binding_missing');
  const matching = tasks.filter(task => task.task_key === KEYS[step] && task.agent_role === 'customer');
  requireProof(matching.length === 1, 'weekly_customer_task_ambiguous');
  const task = matching[0]!;
  const result = (status: WeeklyCustomerStepEvidence['status'], reason: string | null, resultRefs: VersionedSocialRef[] = []): WeeklyCustomerStepEvidence => ({ status, reason, runId, taskId: task.id, resultRefs });
  if (['cancelled', 'paused', 'failed', 'dead_letter'].includes(String(run.status))) return result('blocked', `weekly_customer_run_${run.status}`);
  const segments = await rows(store, 'customer_segments', { tenant_id: authority.tenantId, run_id: runId });
  const segmentation = tasks.find(item => item.task_key === 'customer_segmentation' && item.agent_role === 'customer');
  const latestSegments = segments.filter(row => row.goal_id === run.goal_id && row.task_id === segmentation?.id && Number.isSafeInteger(row.version) && Number(row.version) > 0).sort((a,b) => Number(b.version) - Number(a.version));
  const segment = latestSegments[0];
  requireProof(!segments.some(row => row.mock || row.simulated || row.synthetic), 'weekly_customer_synthetic_evidence');
  if (!segment || latestSegments.filter(row => row.version === segment.version).length !== 1) return result('blocked', 'weekly_customer_segment_missing');
  requireProof(Number.isFinite(Date.parse(String(segment.snapshot_at))) && text(segment.criteria_hash) && segment.criteria_hash === createHash('sha256').update(JSON.stringify(stableValue(obj(segment.criteria)))).digest('hex'));
  const members = await rows(store, 'customer_segment_members', { tenant_id: authority.tenantId, segment_id: segment.id });
  const included = members.filter(row => row.membership === 'included');
  requireProof(included.length === segment.member_count && members.every(row => text(row.customer_id) && Object.keys(obj(row.customer_snapshot)).length));
  const relationshipScope=await readWeeklyCustomerRelationshipScope(store,authority.tenantId,runId);
  requireProof(relationshipScope?.programId===authority.programId&&relationshipScope.packageId===authority.packageId&&relationshipScope.packageVersion===authority.packageVersion,'weekly_customer_relationship_scope_mismatch');
  try{for(const member of included){await verifyWeeklyCustomerMemberProof(store,relationshipScope!,String(member.customer_id),member.customer_snapshot);}}catch(error){return result('blocked',error instanceof Error?error.message:'weekly_customer_relationship_evidence_unverified');}
  if(members.some(member=>Array.isArray(member.exclusion_reasons)&&member.exclusion_reasons.includes('weekly_customer_relationship_unknown')))return result('blocked','weekly_customer_relationship_unknown_requires_new_snapshot');
  const skippedNoData = segmentation?.status === 'skipped' && obj(segmentation.output).dataStatus === 'no_data'
    && (Array.isArray(segmentation.business_refs) ? segmentation.business_refs : (()=>{try{const parsed=JSON.parse(String(segmentation.business_refs));return Array.isArray(parsed)?parsed:[];}catch{return [];}})()).some((ref:Record<string,unknown>)=>ref&&ref.type==='customer_segment'&&ref.id===segment.id&&Number(ref.version)===Number(segment.version)&&Number(ref.memberCount)===0);
  if (included.length === 0) return (segmentation?.status === 'succeeded' || skippedNoData) && segment.status === 'generated' ? result('no_data', 'weekly_customer_no_eligible_customers') : result('blocked', 'weekly_customer_segmentation_pending');
  if (step === 'customer_segmentation') {
    if (task.status !== 'succeeded' || segment.status !== 'generated') return result('blocked', 'weekly_customer_segmentation_pending');
    return result('succeeded', null, [{ type: 'weekly_customer_segment', id: segment.id, version: Number(segment.version) }]);
  }
  const batches = (await rows(store, 'followup_batches', { tenant_id: authority.tenantId, run_id: runId })).filter(row => row.goal_id === run.goal_id && row.segment_id === segment.id && row.task_id === tasks.find(item => item.task_key === 'followup_batch_draft')?.id && Number.isSafeInteger(row.version) && Number(row.version) > 0).sort((a,b) => Number(b.version) - Number(a.version));
  const batch = batches[0];
  requireProof(!batches.some(row => row.mock || row.simulated || row.synthetic), 'weekly_customer_synthetic_evidence');
  if (!batch || batches.filter(row => row.version === batch.version).length !== 1) return result('blocked', 'weekly_customer_batch_missing');
  const items = orderedFollowupItems(await rows(store, 'followup_batch_items', { tenant_id: authority.tenantId, batch_id: batch.id }, 'created_at'), batch.delivery_policy);
  requireProof(!members.some(row => row.mock || row.simulated || row.synthetic) && !items.some(row => row.mock || row.simulated || row.synthetic), 'weekly_customer_synthetic_evidence');
  requireProof(items.length > 0 && items.every(row => included.some(member => member.id === row.segment_member_id && member.customer_id === row.customer_id)));
  requireProof(included.every(member => items.some(row => row.segment_member_id === member.id)));
  const active = items.filter(row => !['excluded', 'cancelled'].includes(String(row.status)));
  requireProof(text(batch.content_hash) && items.every(row => text(row.draft_body) && text(row.content_hash)));
  requireProof(items.every(row => row.content_hash === followupItemContentHash(row as unknown as FollowupBatchItemRecord)));
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const legacyBatchHash = hash(stableValue(items.map(row => ({ customerId: row.customer_id, body: row.draft_body, scheduledAt: row.scheduled_at }))));
  const configuredBatchHash = hash(items.map(row => row.content_hash));
  const algorithm = obj(batch.delivery_policy).hashAlgorithm;
  requireProof(algorithm === 'stable_customer_body_schedule_v1' ? batch.content_hash === legacyBatchHash : algorithm === 'ordered_item_content_hashes_v1' ? batch.content_hash === configuredBatchHash : !algorithm && (batch.content_hash === legacyBatchHash || batch.content_hash === configuredBatchHash), 'weekly_customer_batch_hash_mismatch');
  const refs: VersionedSocialRef[] = [{ type: 'weekly_customer_followup_batch', id: batch.id, version: Number(batch.version) }];
  if (step === 'customer_followup_draft') return task.status === 'succeeded' ? result('succeeded', null, refs) : result('blocked', 'weekly_customer_draft_pending');
  if (active.length === 0) return result('blocked', 'weekly_customer_no_sendable_drafts');
  const approvals = await rows(store, 'approval_requests', { tenant_id: authority.tenantId, run_id: runId, task_id: String(tasks.find(row => row.task_key === 'followup_batch_approval')?.id ?? '') });
  const approved = approvals.some(row => row.goal_id === run.goal_id && row.id === batch.approval_id && row.status === 'approved' && row.subject_version === batch.version && row.content_hash === batch.content_hash && text(row.decided_by) && Number.isFinite(Date.parse(String(row.decided_at))));
  if (!approved || batch.approved_version !== batch.version || !text(batch.approved_by)) return result('blocked', 'weekly_customer_approval_required');
  if (step === 'customer_followup_approval') return task.status === 'succeeded' ? result('succeeded', null, refs) : result('blocked', 'weekly_customer_approval_pending');
  for(const item of active.filter(row=>['messenger','instagram'].includes(String(row.channel)))){try{const {validateWeeklyNativeSendReceipt}=await import('../digitalEmployees/weeklyNativeFollowupDispatch.js');await validateWeeklyNativeSendReceipt(store,item,{...authority,runId});}catch(error){return result('blocked',error instanceof Error&&error.message.startsWith('weekly_')?error.message:'weekly_native_dispatch_receipt_unverified');}}
  if (items.some(row => row.exclusion_reason === 'send_outcome_unknown' || row.status === 'partial_sent')) return result('blocked', 'weekly_customer_send_outcome_unknown');
  if (!active.every(row => ['sent', 'delivered', 'read'].includes(String(row.status)) && text(row.provider_message_id) && !/^(mock|simulat)/i.test(String(row.provider_message_id)) && Object.keys(obj(row.provider_receipt)).length > 0 && !obj(row.provider_receipt).synthetic && !obj(row.provider_receipt).mock && Number.isFinite(Date.parse(String(row.sent_at))))) return result('blocked', 'weekly_customer_delivery_receipt_pending');
  return task.status === 'succeeded' ? result('succeeded', null, refs) : result('blocked', 'weekly_customer_dispatch_pending');
}

export interface WeeklyCustomerCalendarTask {
  step: WeeklyCustomerStep; taskId: string; taskKey: string; title: string; status: string;
  evidenceStatus: WeeklyCustomerStepEvidence['status']; reason: string | null; resultRefs: VersionedSocialRef[];
  scheduledAt: string | null; scheduledAtSource: 'workflow_task' | 'followup_batch_item' | null;
  latestFinishAt: string | null; estimateDurationMinutes: number | null;
}
export interface WeeklyCustomerCalendar {
  binding: { bindingId: string; runId: string; goalId: string; planId: string; boundBy: string; boundAt: string } | null;
  tasks: WeeklyCustomerCalendarTask[];
  scheduleGaps: Array<{ step: WeeklyCustomerStep; taskId: string; reason: string }>;
}
/** Actual customer production projection. Missing scheduling data stays absent; goal windows and
 * record creation timestamps are never substituted for per-task execution appointments. */
export async function readWeeklyCustomerCalendar(store: DataStore, authority: WeeklyCustomerAuthority): Promise<WeeklyCustomerCalendar> {
  const packages = await rows(store, 'social_weekly_operating_packages', { tenant_id: authority.tenantId, program_id: authority.programId, package_id: authority.packageId, version: authority.packageVersion });
  requireProof(packages.length === 1, 'weekly_customer_package_missing');
  const bindings = await rows(store, WEEKLY_CUSTOMER_BINDINGS, identity(authority));
  requireProof(bindings.length <= 1, 'weekly_customer_binding_ambiguous');
  if (!bindings.length) return { binding: null, tasks: [], scheduleGaps: [] };
  const binding = bindings[0]!;
  const runId = text(binding.run_id);
  const { run, tasks } = await context(store, authority, runId);
  const plan = await store.getById<Record_>('weekly_plans', String(run.plan_id));
  const planTasks = obj(plan?.plan).tasks;
  const phases: WeeklyCustomerCalendarTask[] = [];
  const timestamp = (value: unknown) => text(value) && Number.isFinite(Date.parse(String(value))) && /(?:Z|[+-]\d{2}:\d{2})$/.test(String(value)) ? text(value) : null;
  for (const step of Object.keys(KEYS) as WeeklyCustomerStep[]) {
    const matching = tasks.filter(task => task.task_key === KEYS[step] && task.agent_role === 'customer');
    if (!matching.length) continue;
    requireProof(matching.length === 1, 'weekly_customer_task_ambiguous');
    const task = matching[0]!;
    const evidence = await readWeeklyCustomerStep(store, authority, runId, step);
    const matches = Array.isArray(planTasks) ? planTasks.filter((item: any) => item.key === task.task_key) : [];
    const planned = matches.length === 1 ? obj(matches[0]) : {};
    let scheduledAt = timestamp(task.scheduled_at);
    let scheduledAtSource: WeeklyCustomerCalendarTask['scheduledAtSource'] = scheduledAt ? 'workflow_task' : null;
    if (!scheduledAt && step === 'customer_followup_dispatch') {
      const latestBatch = (await rows(store, 'followup_batches', { tenant_id: authority.tenantId, run_id: runId })).filter(row => row.goal_id === run.goal_id && !['cancelled', 'superseded'].includes(String(row.status))).sort((left,right) => Number(right.version) - Number(left.version))[0];
      if (latestBatch) {
        const items = await rows(store, 'followup_batch_items', { tenant_id: authority.tenantId, batch_id: latestBatch.id });
        const pending = items.filter(row => !['sent', 'delivered', 'read', 'excluded', 'cancelled'].includes(String(row.status)));
        const windows = (pending.length ? pending : items).map(row => timestamp(row.scheduled_at)).filter((value): value is string => Boolean(value)).sort((left,right) => Date.parse(left) - Date.parse(right));
        scheduledAt = windows[0] ?? null; scheduledAtSource = scheduledAt ? 'followup_batch_item' : null;
      }
    }
    const minutes = planned.expectedMinutes;
    phases.push({ step, taskId: task.id, taskKey: KEYS[step], title: text(task.title) || KEYS[step], status: String(task.status), evidenceStatus: evidence.status, reason: evidence.reason, resultRefs: evidence.resultRefs,
      scheduledAt, scheduledAtSource, latestFinishAt: timestamp(task.due_at), estimateDurationMinutes: typeof minutes === 'number' && Number.isFinite(minutes) && minutes >= 0 ? minutes : null });
  }
  return { binding: { bindingId: text(binding.binding_id), runId, goalId: text(binding.goal_id), planId: text(binding.plan_id), boundBy: text(binding.bound_by), boundAt: text(binding.bound_at) }, tasks: phases,
    scheduleGaps: phases.filter(task => !task.scheduledAt).map(task => ({ step: task.step, taskId: task.taskId, reason: 'weekly_customer_exact_schedule_missing' })) };
}

export interface WeeklyCustomerRunCandidate {
  runId: string; goalId: string; planId: string; title: string; status: string;
  startsAt: string; endsAt: string; customerTaskKeys: string[];
  alreadyBound: boolean; bindingConflict: boolean;
  customerSourceCoverage: 'unverified';
}
/** Enumerate real runs, then verify each one's ownership and week. Selection is always explicit. */
export async function listWeeklyCustomerRunCandidates(store: DataStore, authority: WeeklyCustomerAuthority): Promise<{ items: WeeklyCustomerRunCandidate[]; boundRunId: string | null }> {
  requireProof(Object.values(identity(authority)).every(value => typeof value === 'number' ? Number.isSafeInteger(value) && value > 0 : Boolean(text(value))), 'weekly_customer_authority_invalid');
  const packages = await rows(store, 'social_weekly_operating_packages', { tenant_id: authority.tenantId, program_id: authority.programId, package_id: authority.packageId, version: authority.packageVersion });
  requireProof(packages.length === 1, 'weekly_customer_package_missing');
  const bindings = await rows(store, WEEKLY_CUSTOMER_BINDINGS, { tenant_id: authority.tenantId });
  const current = bindings.filter(row => Object.entries(identity(authority)).every(([key,value]) => row[key] === value));
  requireProof(current.length <= 1, 'weekly_customer_binding_ambiguous');
  const runs = await rows(store, 'workflow_runs', { tenant_id: authority.tenantId });
  const items: WeeklyCustomerRunCandidate[] = [];
  for (const candidate of runs) {
    if (['cancelled', 'failed', 'dead_letter'].includes(String(candidate.status))) continue;
    let verified: Awaited<ReturnType<typeof context>>;
    try { verified = await context(store, authority, candidate.id); }
    catch (error) {
      if (error instanceof SocialProgramError && ['weekly_customer_run_unavailable', 'weekly_customer_goal_incompatible', 'weekly_customer_week_mismatch', 'weekly_customer_evidence_unverified'].includes(error.code)) continue;
      throw error;
    }
    const keys = verified.tasks.filter(task => task.agent_role === 'customer' && Object.values(KEYS).includes(String(task.task_key))).map(task => String(task.task_key));
    if (!keys.length) continue;
    const goal = await store.getById<Record_>('weekly_goals', String(candidate.goal_id));
    const associations = bindings.filter(row => row.run_id === candidate.id);
    requireProof(associations.length <= 1, 'weekly_customer_binding_ambiguous');
    const same = current.some(row => row.run_id === candidate.id);
    items.push({ runId: candidate.id, goalId: String(candidate.goal_id), planId: String(candidate.plan_id), title: text(goal?.title) || candidate.id, status: String(candidate.status), startsAt: text(goal?.starts_at), endsAt: text(goal?.ends_at), customerTaskKeys: keys,
      alreadyBound: same, bindingConflict: associations.length > 0 && !same, customerSourceCoverage: 'unverified' });
  }
  return { items, boundRunId: current.length ? text(current[0]!.run_id) : null };
}
