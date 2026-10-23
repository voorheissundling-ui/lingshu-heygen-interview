import {weeklyScopeMatches,type WeeklyScanScope} from './weeklyScanScope.js';
import {ENTERPRISE_FACT_GAP,checkWeeklyEnterpriseFactSupplement} from './weeklyEnterpriseFactSupplement.js';
import type { DataStore, Record_ } from '../storage/datastore.js';
import type { WeeklyExecutionTask, WeeklyOperatingPackage, VersionedSocialRef } from '../../shared/contracts/socialProgram.js';
import { SUPPLEMENT_EVENTS, supplementConsumerHash } from '../socialPrograms/weeklySupplementRequests.js';
import { ACCOUNT_AUTHORIZATION_GAP_CODES, checkWeeklyAccountAuthorizationSupplement } from '../socialPrograms/weeklyAccountAuthorizationSupplement.js';
import { socialObject, socialJson, socialRequestHash } from '../starter198/socialContentValidation.js';
import { executionPackageFrozen, withExecutionPackageGate } from '../socialPrograms/weeklyExecutionGate.js';
import { createWeeklyExecutionTaskService } from '../socialPrograms/executionTasks.js';
const supportedGap=(code:string)=>code===ENTERPRISE_FACT_GAP||ACCOUNT_AUTHORIZATION_GAP_CODES.has(code);
const checkSupplement=async(store:DataStore,task:WeeklyExecutionTask,platform:string,now?:Date)=>task.lastError?.code===ENTERPRISE_FACT_GAP?checkWeeklyEnterpriseFactSupplement({store,task,now}):checkWeeklyAccountAuthorizationSupplement({store,tenantId:task.tenantId,accountId:task.accountId!,platform,now});
const seal = (value: WeeklySupplementException) => ({ ...value, recordHash: socialRequestHash({ ...value, recordHash: '' }) });
const valid = (value: WeeklySupplementException) => value && value.recordHash === socialRequestHash({ ...value, recordHash: '' });
const assertReceipt = (row: Record_, exception: WeeklySupplementException, version: number) => { const value = parsed<WeeklySupplementException>(row.payload); if (row.id !== socialRequestHash({ exceptionId: exception.exceptionId, version }).slice(0, 15) || value.type !== 'scheduler_supplement_exception' || value.kind !== exception.kind || value.status !== (version === 2 ? 'assignment_pending' : 'resolved') || version === 3 && value.verificationRef?.type !== (exception.kind==='enterprise_facts'?'enterprise_fact':'platform_capability_evidence') || value.dueAt !== exception.dueAt || value.responsibleActor !== exception.responsibleActor || row.tenant_id !== exception.tenantId || row.request_id !== exception.exceptionId || row.version !== version || !valid(value) || ['tenantId', 'programId', 'packageId', 'packageVersion', 'consumerTaskId', 'consumerInputHash', 'gapCode', 'exceptionId'].some(k => (value as unknown as Record<string, unknown>)[k] !== (exception as unknown as Record<string, unknown>)[k]))
    throw Error('supplement_exception_resolution_corrupt'); return value; };
const packageMatches = (pkg: WeeklyOperatingPackage, task: WeeklyExecutionTask) => pkg && pkg.programId === task.programId && pkg.packageId === task.packageId && pkg.version === task.packageVersion && ['active', 'draft'].includes(pkg.status);
const parsed = <T>(value: unknown) => socialObject(socialJson(value)) as unknown as T;
const rows = async (store: DataStore, collection: string, where: Record<string, string | number>) => { const out: Record_[] = []; let total: number | undefined; for (let page = 1; page <= 10000; page++) {
    const r = await store.list<Record_>(collection, { where, page, perPage: 500, sort: 'id' });
    if (!Number.isSafeInteger(r.totalItems) || r.totalItems < 0 || r.items.some(x => !x.id || out.some(y => y.id === x.id) || Object.entries(where).some(([k, v]) => x[k] !== v)) || total !== undefined && total !== r.totalItems)
        throw Error('supplement_exception_scan_changed');
    total = r.totalItems;
    out.push(...r.items);
    if (out.length === total)
        return out;
    if (!r.items.length || out.length > total)
        throw Error('supplement_exception_scan_incomplete');
} throw Error('supplement_exception_scan_limit'); };
export interface WeeklySupplementException {
    type: 'scheduler_supplement_exception';
    exceptionId: string;
    tenantId: string;
    programId: string;
    packageId: string;
    packageVersion: number;
    consumerTaskId: string;
    consumerInputHash: string;
    gapCode: string;
    kind: 'account_authorization'|'enterprise_facts';
    status: 'assignment_pending' | 'resolved';
    dueAt: string;
    responsibleActor: string;
    createdAt: string;
    resolvedAt?: string;
    verificationRef?: VersionedSocialRef | null;
    recordHash?: string;
}
async function materialize(input: {
    store: DataStore;
    task: WeeklyExecutionTask;
    gapCode: string;
    now?: Date;
}): Promise<WeeklySupplementException | null> {
    if (!supportedGap(input.gapCode))
        return null;
    const found = await rows(input.store, 'social_weekly_execution_tasks', { tenant_id: input.task.tenantId, program_id: input.task.programId, task_id: input.task.taskId });
    if (found.length !== 1)
        throw Error('supplement_exception_consumer_not_unique');
    const task = parsed<WeeklyExecutionTask>(found[0]!.payload);
    if (task.tenantId !== input.task.tenantId || task.programId !== input.task.programId || task.packageId !== input.task.packageId || task.packageVersion !== input.task.packageVersion || task.status !== 'blocked' || task.lastError?.code !== input.gapCode || supplementConsumerHash(task) !== supplementConsumerHash(input.task))
        throw Error('supplement_exception_consumer_changed');
    const packages = await rows(input.store, 'social_weekly_operating_packages', { tenant_id: task.tenantId, program_id: task.programId, package_id: task.packageId, version: task.packageVersion });
    if (packages.length !== 1 || !packageMatches(parsed<WeeklyOperatingPackage>(packages[0]!.payload), task))
        return null;
    const dueAt = task.schedule.latestStartAt || task.schedule.estimatedStartAt;
    if (!Number.isFinite(Date.parse(dueAt)))
        throw Error('supplement_exception_deadline_missing');
    const exceptionId = socialRequestHash({ type: 'scheduler_supplement_exception', consumerInputHash: supplementConsumerHash(task), gapCode: input.gapCode }).slice(0, 15);
    const id = socialRequestHash({ exceptionId, version: 2 }).slice(0, 15);
    const prior = await input.store.getById<Record_>(SUPPLEMENT_EVENTS, id);
    if (prior) {
        const value = parsed<WeeklySupplementException>(prior.payload);
        if (prior.tenant_id !== task.tenantId || prior.request_id !== exceptionId || prior.version !== 2 || !valid(value) || value.tenantId !== task.tenantId || value.programId !== task.programId || value.packageId !== task.packageId || value.packageVersion !== task.packageVersion || value.type !== 'scheduler_supplement_exception' || value.kind !== (input.gapCode===ENTERPRISE_FACT_GAP?'enterprise_facts':'account_authorization') || value.status !== 'assignment_pending' || value.exceptionId !== exceptionId || value.consumerInputHash !== supplementConsumerHash(task) || value.gapCode !== input.gapCode || value.consumerTaskId !== task.taskId || value.dueAt !== dueAt || value.responsibleActor !== task.schedule.responsibleActor)
            throw Error('supplement_exception_corrupt');
        return value;
    }
    const value: WeeklySupplementException = { type: 'scheduler_supplement_exception', exceptionId, tenantId: task.tenantId, programId: task.programId, packageId: task.packageId, packageVersion: task.packageVersion, consumerTaskId: task.taskId, consumerInputHash: supplementConsumerHash(task), gapCode: input.gapCode, kind: input.gapCode===ENTERPRISE_FACT_GAP?'enterprise_facts':'account_authorization', status: 'assignment_pending', dueAt, responsibleActor: task.schedule.responsibleActor, createdAt: (input.now ?? new Date()).toISOString() };
    if (!await input.store.create(SUPPLEMENT_EVENTS, { id, tenant_id: task.tenantId, request_id: exceptionId, version: 2, payload: seal(value) })) {
        const reread = await input.store.getById<Record_>(SUPPLEMENT_EVENTS, id);
        if (!reread)
            throw Error('supplement_exception_write_failed');
        return materializeWeeklySupplementException(input);
    }
    return seal(value);
}
export async function materializeWeeklySupplementException(input: {
    store: DataStore;
    task: WeeklyExecutionTask;
    gapCode: string;
    now?: Date;
}): Promise<WeeklySupplementException | null> {
    if (!supportedGap(input.gapCode))
        return null;
    return withExecutionPackageGate(input.store, input.task, async (assert) => { await assert(); if (await executionPackageFrozen(input.store, input.task))
        return null; return materialize(input); });
}
export async function runWeeklySupplementExceptionScan(input: {
    store: DataStore;
    tenantIds?: string[];
    scope?:WeeklyScanScope;
    now?: Date;
}) {
    const report = { materialized: 0, resolved: 0, failed: 0 };
    const tasks = await rows(input.store, 'social_weekly_execution_tasks', {});
    for (const row of tasks) {
        const task = parsed<WeeklyExecutionTask>(row.payload);
        if(!weeklyScopeMatches(input.scope,task))continue;
        if (!task || input.tenantIds && !input.tenantIds.includes(task.tenantId) || task.status !== 'blocked' || !supportedGap(task.lastError?.code ?? ''))
            continue;
        let exception: WeeklySupplementException | null;
        try {
            exception = await materializeWeeklySupplementException({ store: input.store, task, gapCode: task.lastError!.code, now: input.now });
        }
        catch {
            report.failed++;
            continue;
        }
        if (!exception)
            continue;
        report.materialized++;
        try {
            await withExecutionPackageGate(input.store, task, async (assert) => {
                const before = await rows(input.store, 'social_weekly_execution_tasks', { tenant_id: task.tenantId, program_id: task.programId, task_id: task.taskId });
                const beforeTask = parsed<WeeklyExecutionTask>(before[0]?.payload);
                if (before.length !== 1 || !beforeTask || beforeTask.status !== 'blocked' || beforeTask.lease || supplementConsumerHash(beforeTask) !== exception.consumerInputHash || beforeTask.lastError?.code !== exception.gapCode || exception.dueAt !== (beforeTask.schedule.latestStartAt || beforeTask.schedule.estimatedStartAt) || exception.responsibleActor !== beforeTask.schedule.responsibleActor)
                    return;
                const packages = await rows(input.store, 'social_weekly_operating_packages', { tenant_id: task.tenantId, program_id: task.programId, package_id: task.packageId, version: task.packageVersion });
                if (packages.length !== 1)
                    return;
                const pkg = parsed<WeeklyOperatingPackage>(packages[0]!.payload);
                if (!packageMatches(pkg, task))
                    return;
                const pub = pkg.socialContentPackage.publicationTasks.find(p => p.publicationTaskId === task.publicationTaskId && p.accountId === task.accountId);
                if (!pub || !['active', 'draft'].includes(pkg.status) || task.lease || await executionPackageFrozen(input.store, task))
                    return;
                const check = await checkSupplement(input.store,{...task,lastError:{code:exception.gapCode,message:'',occurredAt:'',retryable:false}},pub.platform,input.now);
                if (!check.ready)
                    return;
                await assert();
                const id = socialRequestHash({ exceptionId: exception.exceptionId, version: 3 }).slice(0, 15);
                const priorResolution = await input.store.getById<Record_>(SUPPLEMENT_EVENTS, id);
                if (priorResolution)
                    assertReceipt(priorResolution, exception, 3);
                if (!priorResolution && !await input.store.create(SUPPLEMENT_EVENTS, { id, tenant_id: task.tenantId, request_id: exception.exceptionId, version: 3, payload: seal({ ...exception, status: 'resolved', resolvedAt: (input.now ?? new Date()).toISOString(), verificationRef: check.evidenceRef }) }))
                    throw Error('supplement_exception_resolution_write_failed');
                report.resolved++;
                const current = await rows(input.store, 'social_weekly_execution_tasks', { tenant_id: task.tenantId, program_id: task.programId, task_id: task.taskId });
                const live = parsed<WeeklyExecutionTask>(current[0]?.payload);
                if (current.length !== 1 || supplementConsumerHash(live) !== exception.consumerInputHash || live.lease || await executionPackageFrozen(input.store, task))
                    throw Error('supplement_exception_consumer_changed');
                await assert();
                const changed = await createWeeklyExecutionTaskService(input.store).unblock(task.tenantId, task.programId, task.packageId, task.taskId, exception.gapCode);
                if (!changed.some(t => t.taskId === task.taskId && t.packageVersion === task.packageVersion && !t.ownBlockingReasons.includes(exception.gapCode)))
                    throw Error('supplement_exception_resume_failed');
            });
        }
        catch {
            report.failed++;
        }
    }
    // Repair a lost resolution write after the original consumer was already unblocked.
    for (const event of await rows(input.store, SUPPLEMENT_EVENTS, { version: 2 })) {
        const exception = parsed<WeeklySupplementException>(event.payload);
        if (exception?.type !== 'scheduler_supplement_exception')
            continue;
        if (!valid(exception) || event.tenant_id !== exception.tenantId || event.request_id !== exception.exceptionId) {
            report.failed++;
            continue;
        }
        if (input.tenantIds && !input.tenantIds.includes(exception.tenantId))
            continue;
        const id = socialRequestHash({ exceptionId: exception.exceptionId, version: 3 }).slice(0, 15);
        const resolution = await input.store.getById<Record_>(SUPPLEMENT_EVENTS, id);
        const consumers = await rows(input.store, 'social_weekly_execution_tasks', { tenant_id: exception.tenantId, program_id: exception.programId, task_id: exception.consumerTaskId });
        if (consumers.length !== 1)
            continue;
        let task = parsed<WeeklyExecutionTask>(consumers[0]!.payload);
        try {
            await withExecutionPackageGate(input.store, task, async (assert) => {
                const currentResolution = await input.store.getById<Record_>(SUPPLEMENT_EVENTS, id);
                const fresh = await rows(input.store, 'social_weekly_execution_tasks', { tenant_id: exception.tenantId, program_id: exception.programId, task_id: exception.consumerTaskId });
                if (fresh.length !== 1)
                    return;
                task = parsed<WeeklyExecutionTask>(fresh[0]!.payload);
                if (!['blocked', 'queued', 'succeeded'].includes(task.status) || task.lease || supplementConsumerHash(task) !== exception.consumerInputHash || exception.dueAt !== (task.schedule.latestStartAt || task.schedule.estimatedStartAt) || exception.responsibleActor !== task.schedule.responsibleActor)
                    return;
                if (!currentResolution && (task.ownBlockingReasons.includes(exception.gapCode) || task.lastError?.code === exception.gapCode))
                    return;
                const packages = await rows(input.store, 'social_weekly_operating_packages', { tenant_id: exception.tenantId, program_id: exception.programId, package_id: exception.packageId, version: exception.packageVersion });
                if (packages.length !== 1)
                    return;
                const pkg = parsed<WeeklyOperatingPackage>(packages[0]!.payload);
                if (!packageMatches(pkg, task))
                    return;
                const pub = pkg.socialContentPackage.publicationTasks.find(p => p.publicationTaskId === task.publicationTaskId && p.accountId === task.accountId);
                if (!pub || !['active', 'draft'].includes(pkg.status) || await executionPackageFrozen(input.store, task))
                    return;
                const check = await checkSupplement(input.store,{...task,lastError:{code:exception.gapCode,message:'',occurredAt:'',retryable:false}},pub.platform,input.now);
                if (!check.ready)
                    return;
                if (currentResolution) {
                    const receipt = assertReceipt(currentResolution, exception, 3);
                    if (receipt.status !== 'resolved')
                        throw Error('supplement_exception_resolution_corrupt');
                    if (task.status === 'blocked' && task.ownBlockingReasons.includes(exception.gapCode)) {
                        await assert();
                        await createWeeklyExecutionTaskService(input.store).unblock(task.tenantId, task.programId, task.packageId, task.taskId, exception.gapCode);
                    }
                    return;
                }
                await assert();
                if (!await input.store.create(SUPPLEMENT_EVENTS, { id, tenant_id: exception.tenantId, request_id: exception.exceptionId, version: 3, payload: seal({ ...exception, status: 'resolved', resolvedAt: (input.now ?? new Date()).toISOString(), verificationRef: check.evidenceRef }) }))
                    throw Error('supplement_exception_resolution_write_failed');
                report.resolved++;
            });
        }
        catch {
            report.failed++;
        }
    }
    return report;
}
/** Authenticated routes supply exact tenant/package authority; this reader never repairs or writes. */
export async function listWeeklySupplementExceptions(input: {
    store: DataStore;
    tenantId: string;
    programId: string;
    packageId: string;
    packageVersion: number;
}): Promise<WeeklySupplementException[]> {
    const packages = await rows(input.store, 'social_weekly_operating_packages', { tenant_id: input.tenantId, program_id: input.programId, package_id: input.packageId, version: input.packageVersion });
    const pkg = parsed<WeeklyOperatingPackage>(packages[0]?.payload);
    if (packages.length !== 1 || !pkg || pkg.programId !== input.programId || pkg.packageId !== input.packageId || pkg.version !== input.packageVersion)
        throw Error('supplement_exception_package_invalid');
    const result: WeeklySupplementException[] = [];
    for (const row of await rows(input.store, SUPPLEMENT_EVENTS, { tenant_id: input.tenantId, version: 2 })) {
        const pending = parsed<WeeklySupplementException>(row.payload);
        if (pending?.type !== 'scheduler_supplement_exception')
            continue;
        if (pending.programId !== input.programId || pending.packageId !== input.packageId || pending.packageVersion !== input.packageVersion)
            continue;
        assertReceipt(row, pending, 2);
        if (pending.tenantId !== input.tenantId || pending.status !== 'assignment_pending')
            throw Error('supplement_exception_scope_invalid');
        const consumers = await rows(input.store, 'social_weekly_execution_tasks', { tenant_id: input.tenantId, program_id: input.programId, task_id: pending.consumerTaskId });
        if (consumers.length !== 1)
            throw Error('supplement_exception_consumer_not_unique');
        const task = parsed<WeeklyExecutionTask>(consumers[0]!.payload);
        if (task.tenantId !== input.tenantId || task.programId !== input.programId || task.packageId !== input.packageId || task.packageVersion !== input.packageVersion || supplementConsumerHash(task) !== pending.consumerInputHash || pending.dueAt !== (task.schedule.latestStartAt || task.schedule.estimatedStartAt) || pending.responsibleActor !== task.schedule.responsibleActor)
            throw Error('supplement_exception_consumer_changed');
        const id = socialRequestHash({ exceptionId: pending.exceptionId, version: 3 }).slice(0, 15), resolved = await input.store.getById<Record_>(SUPPLEMENT_EVENTS, id);
        const current = resolved ? assertReceipt(resolved, pending, 3) : pending;
        if (resolved && current.status !== 'resolved')
            throw Error('supplement_exception_resolution_corrupt');
        result.push(current);
    }
    return result;
}
