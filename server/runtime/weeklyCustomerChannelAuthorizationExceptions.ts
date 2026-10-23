import { weeklyScopeMatches, type WeeklyScanScope } from './weeklyScanScope.js';
import type { DataStore, Record_ } from '../storage/datastore.js';
import type { WeeklyExecutionTask, WeeklyOperatingPackage } from '../../shared/contracts/socialProgram.js';
import { socialObject, socialJson, socialRequestHash } from '../starter198/socialContentValidation.js';
import { withExecutionPackageGate, executionPackageFrozen } from '../socialPrograms/weeklyExecutionGate.js';
import { createWeeklyExecutionTaskService } from '../socialPrograms/executionTasks.js';
import { readWeeklyCustomerChannelReadiness, type WeeklyCustomerChannelPorts } from './socialWeeklyCustomerChannelAdapter.js';
export const CUSTOMER_CHANNEL_AUTHORIZATION_EXCEPTIONS = 'social_weekly_supplement_events';
const eventId = (exceptionId: string, version: number) => socialRequestHash({ exceptionId, version }).slice(0, 15);
const parse = <T>(v: unknown) => socialObject(socialJson(v)) as unknown as T;
const hash = (t: WeeklyExecutionTask) => socialRequestHash({ tenantId: t.tenantId, programId: t.programId, packageId: t.packageId, packageVersion: t.packageVersion, taskId: t.taskId, accountId: t.accountId, publicationTaskId: t.publicationTaskId, inputSnapshot: t.inputSnapshot, schedule: { stepKind: t.schedule.stepKind, responsibleActor: t.schedule.responsibleActor, estimatedStartAt: t.schedule.estimatedStartAt, estimatedFinishAt: t.schedule.estimatedFinishAt, latestStartAt: t.schedule.latestStartAt ?? null } });
const gaps = new Set(['digital_employee_configuration_inactive', 'customer_agent_not_enabled', 'tenant_real_customer_messages_not_authorized', 'customer_channel_not_authorized', 'followup_background_worker_disabled', 'whatsapp_provider_not_ready', 'messenger_provider_not_ready', 'instagram_provider_not_ready', 'whatsapp_account_ambiguous', 'messenger_account_ambiguous', 'instagram_account_ambiguous', 'messenger_selected_account_unavailable', 'instagram_selected_account_unavailable', 'weekly_whatsapp_account_not_ready', 'tenant_whatsapp_not_configured']);
const eligible = (t: WeeklyExecutionTask, gap: string) => t.schedule.stepKind === 'customer_channel_readiness' && t.schedule.responsibleActor === 'customer_agent' && t.status === 'blocked' && !t.lease && t.lastError?.code === gap && t.ownBlockingReasons.includes(gap) && gaps.has(gap);
async function rows(store: DataStore, name: string, where: Record<string, string | number> = {}) { const out: Record_[] = []; let total: number | undefined; for (let page = 1; page <= 1000; page++) {
    const r = await store.list<Record_>(name, { where, page, perPage: 250, sort: 'id' });
    if (!Number.isSafeInteger(r.totalItems) || r.totalItems < 0 || total !== undefined && total !== r.totalItems || r.items.some(x => !x.id || out.some(y => x.id === y.id) || Object.entries(where).some(([k, v]) => x[k] !== v)))
        throw Error('customer_authorization_read_invalid');
    total = r.totalItems;
    out.push(...r.items);
    if (out.length === total)
        return out;
    if (!r.items.length || out.length > total)
        break;
} throw Error('customer_authorization_read_incomplete'); }
async function live(store: DataStore, t: WeeklyExecutionTask) { const rs = await rows(store, 'social_weekly_execution_tasks', { tenant_id: t.tenantId, program_id: t.programId, task_id: t.taskId }); if (rs.length !== 1)
    throw Error('customer_authorization_consumer_missing'); const v = parse<WeeklyExecutionTask>(rs[0]!.payload); if (hash(v) !== hash(t))
    throw Error('customer_authorization_consumer_changed'); const ps = await rows(store, 'social_weekly_operating_packages', { tenant_id: t.tenantId, program_id: t.programId, package_id: t.packageId, version: t.packageVersion }); const pkg = parse<WeeklyOperatingPackage>(ps[0]?.payload); if (ps.length !== 1 || pkg.programId !== t.programId || pkg.packageId !== t.packageId || pkg.version !== t.packageVersion || !['active', 'draft'].includes(pkg.status))
    throw Error('customer_authorization_package_changed'); return v; }
/** Freeze the real run and existing channel account/selection identity even while credentials are missing. */
async function identity(store: DataStore, t: WeeklyExecutionTask) { const b = await rows(store, 'social_weekly_customer_bindings', { tenant_id: t.tenantId, program_id: t.programId, package_id: t.packageId, package_version: t.packageVersion });
    if(!['whatsapp','messenger','instagram'].includes(String(t.inputSnapshot.customerChannel)))throw Error('customer_authorization_channel_invalid');
    // Recording a missing prerequisite must not require that prerequisite to
    // already exist. Null is a missing binding, never a fabricated run/account.
    if (b.length === 0) return { runId: null, selectionHash: null, accountId: null, nativeAccountId: null, accountIdentityHash: null };
    if (b.length !== 1 || !b[0]!.run_id)
    throw Error('customer_authorization_binding_missing'); const run = await store.getById<Record_>('workflow_runs', String(b[0]!.run_id)); if (!run || run.tenant_id !== t.tenantId)
    throw Error('customer_authorization_run_scope_invalid'); const c = String(t.inputSnapshot.customerChannel); if (!['whatsapp', 'messenger', 'instagram'].includes(c))
    throw Error('customer_authorization_channel_invalid'); const selections = await rows(store, 'social_weekly_customer_channel_selections', { tenant_id: t.tenantId, run_id: String(b[0]!.run_id), package_id: t.packageId, package_version: t.packageVersion, channel: c }); if (selections.length > 1)
    throw Error('customer_authorization_selection_ambiguous'); const accounts = await rows(store, c === 'whatsapp' ? 'tenant_platform_apps' : 'social_accounts', c === 'whatsapp' ? { tenant_id: t.tenantId, platform: 'meta' } : { tenantId: t.tenantId, platform: c === 'messenger' ? 'facebook' : 'instagram' }); const selected = parse<Record<string, unknown>>(selections[0]?.payload); const preferred = accounts.filter(a => a.id === (selected?.accountId ?? t.accountId)); const matches = preferred.length ? preferred : accounts; if (matches.length > 1)
    throw Error('customer_authorization_account_ambiguous'); const account = matches[0]; if (selected?.accountId && account && account.id !== selected.accountId)
    throw Error('customer_authorization_selected_account_changed'); return { runId: String(b[0]!.run_id), selectionHash: selections.length ? socialRequestHash(selections[0]) : null, accountId: account?.id ?? null, nativeAccountId: account ? String(c === 'whatsapp' ? account.phone_number_id ?? '' : account.providerAccountId ?? '') : null, accountIdentityHash: account ? socialRequestHash(c === 'whatsapp' ? { appId: account.app_id ?? null, wabaId: account.waba_id ?? null } : { oauthProvider: account.oauthProvider ?? null, parentPageId: account.parentPageId ?? null, platform: account.platform }) : null }; }
export interface CustomerChannelAuthorizationException {
    type: 'customer_channel_authorization_exception';
    exceptionId: string;
    tenantId: string;
    programId: string;
    packageId: string;
    packageVersion: number;
    consumerTaskId: string;
    consumerHash: string;
    gapCode: string;
    channel: string;
    status: 'missing' | 'resolved';
    dueAt: string;
    responsibleActor: string;
    frozenIdentity: Awaited<ReturnType<typeof identity>>;
    createdAt: string;
    resolvedAt?: string;
    verifiedAuthority?: Awaited<ReturnType<typeof readWeeklyCustomerChannelReadiness>>;
    recordHash: string;
}
const seal = (v: Omit<CustomerChannelAuthorizationException, 'recordHash'> & {
    recordHash?: string;
}) => { const { recordHash: _, ...body } = v; return { ...body, recordHash: socialRequestHash(body) }; };
function validated(row: Record_, t: WeeklyExecutionTask) { const e = parse<CustomerChannelAuthorizationException>(row.payload), { recordHash, ...body } = e; if (e.type !== 'customer_channel_authorization_exception' || e.exceptionId !== socialRequestHash({ kind: 'customer_authorization', consumerHash: hash(t), gapCode: e.gapCode }).slice(0, 15) || !gaps.has(e.gapCode) || e.channel !== String(t.inputSnapshot.customerChannel) || e.dueAt !== (t.schedule.latestStartAt || t.schedule.estimatedStartAt) || e.responsibleActor !== t.schedule.responsibleActor || row.id !== eventId(e.exceptionId, Number(row.version)) || row.request_id !== e.exceptionId || ![2, 3].includes(Number(row.version)) || (row.version === 2 ? e.status !== 'missing' : e.status !== 'resolved') || row.tenant_id !== t.tenantId || e.tenantId !== t.tenantId || e.programId !== t.programId || e.packageId !== t.packageId || e.packageVersion !== t.packageVersion || e.consumerTaskId !== t.taskId || e.consumerHash !== hash(t) || recordHash !== socialRequestHash(body) || !['missing', 'resolved'].includes(e.status))
    throw Error('customer_authorization_exception_corrupt'); return e; }
export async function materializeWeeklyCustomerChannelAuthorizationException(input: {
    store: DataStore;
    task: WeeklyExecutionTask;
    gapCode: string;
    now?: Date;
}) { if (input.task.schedule.stepKind !== 'customer_channel_readiness' || input.task.schedule.responsibleActor !== 'customer_agent' || !gaps.has(input.gapCode))
    return null; return withExecutionPackageGate(input.store, input.task, async (assert) => { const t = await live(input.store, input.task); if (!eligible(t, input.gapCode) || await executionPackageFrozen(input.store, t))
    return null; const frozenIdentity = await identity(input.store, t), exceptionId = socialRequestHash({ kind: 'customer_authorization', consumerHash: hash(t), gapCode: input.gapCode }).slice(0, 15); const existing = await rows(input.store, CUSTOMER_CHANNEL_AUTHORIZATION_EXCEPTIONS, { tenant_id: t.tenantId, version: 2 }); if (existing.some(row => { const old = parse<CustomerChannelAuthorizationException>(row.payload); return old?.type === 'customer_channel_authorization_exception' && old.programId === t.programId && old.packageId === t.packageId && old.consumerTaskId === t.taskId && row.request_id !== exceptionId; }))
    throw Error('customer_authorization_consumer_changed'); const prior = await input.store.getById<Record_>(CUSTOMER_CHANNEL_AUTHORIZATION_EXCEPTIONS, eventId(exceptionId, 2)); if (prior)
    return validated(prior, t); const dueAt = t.schedule.latestStartAt || t.schedule.estimatedStartAt; if (!Number.isFinite(Date.parse(dueAt)))
    throw Error('customer_authorization_deadline_missing'); const e = seal({ type: 'customer_channel_authorization_exception', exceptionId, tenantId: t.tenantId, programId: t.programId, packageId: t.packageId, packageVersion: t.packageVersion, consumerTaskId: t.taskId, consumerHash: hash(t), gapCode: input.gapCode, channel: String(t.inputSnapshot.customerChannel), status: 'missing', dueAt, responsibleActor: t.schedule.responsibleActor, frozenIdentity, createdAt: (input.now ?? new Date()).toISOString() }); await assert(); if (!await input.store.create(CUSTOMER_CHANNEL_AUTHORIZATION_EXCEPTIONS, { id: eventId(exceptionId, 2), request_id: exceptionId, version: 2, tenant_id: t.tenantId, payload: e }))
    throw Error('customer_authorization_exception_write_failed'); return e; }); }
export async function runWeeklyCustomerChannelAuthorizationExceptionScan(input: {
    store: DataStore;
    now?: Date;
    tenantIds?: string[];
    scope?: WeeklyScanScope;
    ports?: WeeklyCustomerChannelPorts;
}) { const report = { materialized: 0, resolved: 0, failed: 0 }; for (const row of await rows(input.store, 'social_weekly_execution_tasks')) {
    const task = parse<WeeklyExecutionTask>(row.payload);
    if (!weeklyScopeMatches(input.scope, task))
        continue;
    if (input.tenantIds && !input.tenantIds.includes(task.tenantId) || !eligible(task, task.lastError?.code ?? ''))
        continue;
    try {
        const exception = await materializeWeeklyCustomerChannelAuthorizationException({ store: input.store, task, gapCode: task.lastError!.code, now: input.now });
        if (!exception)
            continue;
        report.materialized++;
        await withExecutionPackageGate(input.store, task, async (assert) => { const t = await live(input.store, task); if (!eligible(t, exception.gapCode) || await executionPackageFrozen(input.store, t))
            return; const current = await identity(input.store, t); if (exception.frozenIdentity.runId !== null && (current.runId !== exception.frozenIdentity.runId || current.selectionHash !== exception.frozenIdentity.selectionHash) || exception.frozenIdentity.accountId && current.accountId !== exception.frozenIdentity.accountId || exception.frozenIdentity.nativeAccountId && current.nativeAccountId !== exception.frozenIdentity.nativeAccountId || exception.frozenIdentity.accountIdentityHash && current.accountIdentityHash !== exception.frozenIdentity.accountIdentityHash || exception.verifiedAuthority && (current.accountId !== exception.verifiedAuthority.accountId || current.nativeAccountId !== exception.verifiedAuthority.nativeAccountId))
            throw Error('customer_authorization_identity_changed'); const authority = await readWeeklyCustomerChannelReadiness(input.store, t, { ...input.ports, now: () => input.now ?? new Date() }); if (authority.runId !== current.runId || current.accountId && authority.accountId !== current.accountId || current.nativeAccountId && authority.nativeAccountId !== current.nativeAccountId)
            throw Error('customer_authorization_identity_changed'); const confirmed = await live(input.store, t); if (!eligible(confirmed, exception.gapCode) || await executionPackageFrozen(input.store, t) || socialRequestHash(await identity(input.store, confirmed)) !== socialRequestHash(current))
            throw Error('customer_authorization_consumer_changed'); const freshAuthority = await readWeeklyCustomerChannelReadiness(input.store, confirmed, { ...input.ports, now: () => input.now ?? new Date() }); if (socialRequestHash(freshAuthority) !== socialRequestHash(authority))
            throw Error('customer_authorization_authority_changed'); const e = seal({ ...exception, status: 'resolved', resolvedAt: (input.now ?? new Date()).toISOString(), verifiedAuthority: authority }); await assert(); const priorResolution = await input.store.getById<Record_>(CUSTOMER_CHANNEL_AUTHORIZATION_EXCEPTIONS, eventId(exception.exceptionId, 3)); if (priorResolution) {
            const prior = validated(priorResolution, t);
            if (prior.status !== 'resolved' || socialRequestHash(prior.verifiedAuthority) !== socialRequestHash(authority))
                throw Error('customer_authorization_resolution_changed');
        }
        else if (!await input.store.create(CUSTOMER_CHANNEL_AUTHORIZATION_EXCEPTIONS, { id: eventId(exception.exceptionId, 3), request_id: exception.exceptionId, version: 3, tenant_id: t.tenantId, payload: e }))
            throw Error('customer_authorization_resolution_write_failed'); await assert(); const result = await createWeeklyExecutionTaskService(input.store).unblock(t.tenantId, t.programId, t.packageId, t.taskId, exception.gapCode); if (!result.some(v => v.taskId === t.taskId && v.packageVersion === t.packageVersion && !v.ownBlockingReasons.includes(exception.gapCode)))
            throw Error('customer_authorization_resume_failed'); report.resolved++; });
    }
    catch {
        report.failed++;
    }
} return report; }
/** Read only; HTTP caller supplies verified member/program authority. */
export async function listWeeklyCustomerChannelAuthorizationExceptions(input: {
    store: DataStore;
    tenantId: string;
    programId: string;
    packageId: string;
    packageVersion: number;
}) {
    const result: CustomerChannelAuthorizationException[] = [];
    for (const row of await rows(input.store, CUSTOMER_CHANNEL_AUTHORIZATION_EXCEPTIONS, { tenant_id: input.tenantId, version: 2 })) {
        const pending = parse<CustomerChannelAuthorizationException>(row.payload);
        if (pending?.type !== 'customer_channel_authorization_exception' || pending.programId !== input.programId || pending.packageId !== input.packageId || pending.packageVersion !== input.packageVersion)
            continue;
        const consumers = await rows(input.store, 'social_weekly_execution_tasks', { tenant_id: input.tenantId, program_id: input.programId, task_id: pending.consumerTaskId });
        if (consumers.length !== 1)
            throw Error('customer_authorization_consumer_missing');
        const t = parse<WeeklyExecutionTask>(consumers[0]!.payload);
        await live(input.store, t);
        validated(row, t);
        if (t.tenantId !== input.tenantId || t.programId !== input.programId || t.packageId !== input.packageId || t.packageVersion !== input.packageVersion)
            throw Error('customer_authorization_consumer_changed');
        const resolved = await input.store.getById<Record_>(CUSTOMER_CHANNEL_AUTHORIZATION_EXCEPTIONS, eventId(pending.exceptionId, 3));
        result.push(resolved ? validated(resolved, t) : pending);
    }
    return result;
}
