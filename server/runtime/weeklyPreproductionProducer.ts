import {weeklyScopeMatches,type WeeklyScanScope} from './weeklyScanScope.js';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {deterministicFingerprint} from '../socialOperating/businessGoalBuilder.js';
import { evaluateProductionOutlineReadiness, type ProductionOutlineReadiness } from '../socialOperating/productionReadiness.js';
import { readIndependentAdmission } from '../socialPrograms/weeklyIndependentAdmission.js';
import { readWeeklyAutomaticPreproductionAdmission } from '../socialPrograms/weeklyAutomaticSchedule.js';
import { discoveryRunFailureCode } from '../socialDiscovery/sourceFailure.js';
import {ensureWeeklyPreproductionRetryAttempt,readWeeklyPreproductionRetryAttempt,PREPRODUCTION_RETRY_ATTEMPTS,type WeeklyPreproductionRetryAttempt} from './weeklyPreproductionRetryAttempts.js';
import {reassessWeeklyCandidates,readWeeklyCandidateReassessment,type CandidateReassessmentPorts} from './weeklyCandidateReassessment.js';
import type { DataStore, Record_ } from '../storage/datastore.js';
import type { WeeklyExecutionTask, WeeklyOperatingPackage, VersionedSocialRef } from '../../shared/contracts/socialProgram.js';
import type { SocialDiscoveryMode, SocialInspirationCollectionRun } from '../../shared/contracts/socialContentWorkflow.js';
import { socialJson, socialObject, socialRequestHash } from '../starter198/socialContentValidation.js';
import { organizationRoleOrNull,localTenantMember } from '../lib/organizationRole.js';
import { supplementConsumerHash } from '../socialPrograms/weeklySupplementRequests.js';
import { withExecutionPackageGate, executionPackageFrozen } from '../socialPrograms/weeklyExecutionGate.js';
import { createWeeklyExecutionTaskService } from '../socialPrograms/executionTasks.js';
import { createWeeklyPlanningAuthority } from '../socialPrograms/planningAuthority.js';
import { SocialProgramError } from '../socialPrograms/service.js';
import { createSocialOperatingOrchestrationService } from '../socialOperating/orchestration.js';
import { verifyEnterpriseFactContent, type EnterpriseProfile } from '../routes/enterprise.js';
import { executeApprovedDiscoveryRun, type ApprovedDiscoveryRunDependencies, type DiscoveryScopeRecord } from '../socialDiscovery/service.js';
import {readWeeklyAccountCollectionPaidBlocker} from '../socialDiscovery/weeklyAccountCollectionPaidGate.js';
import {inspectWeeklyAccountCollectionOriginalRecovery} from '../socialDiscovery/weeklyAccountCollectionOriginalRecovery.js';
import {readWeeklyAccountCollectionRecovery,readWeeklyAccountCollectionRecoveryEvidence,recordWeeklyAccountCollectionRecovery} from '../socialDiscovery/weeklyAccountCollectionRecoveryProjection.js';
import {createApifyPrepaidOriginalPostReader,WEEKLY_ACCOUNT_COLLECTION_ACTOR_RUN_ENDPOINT} from '../socialDiscovery/apifyPrepaidOriginalPost.js';
import {frozenWeeklyAccountFiveVideoActorInput} from '../socialDiscovery/weeklyAccountCollectionBudget.js';
import {advanceWeeklyAccountCollectionOriginalTransport,continueAcceptedWeeklyAccountCollectionOriginal} from '../socialDiscovery/weeklyAccountCollectionOriginalTransport.js';
import {continueWeeklyAccountCollectionOriginalDataset} from '../socialDiscovery/weeklyAccountCollectionDatasetContinuation.js';
import { linkObservedWeeklyAccounts } from '../socialDiscovery/observedAccountLink.js';
import {readDailyCollectionCapacity} from '../socialDiscovery/dailyCollectionQuota.js';
import {ensureWeeklyQualifiedShortfallReceipt,ensureWeeklyPostAdmissionShortfallReceipt} from './weeklyQualifiedShortfallReceipt.js';
import {ensureWeeklyQualifiedContinuationAttempt} from './weeklyQualifiedContinuationStage.js';
import {allocateWeeklyReferenceSources} from '../socialPrograms/weeklyReferenceSources.js';
import {readWeeklyCandidateAdmissionSnapshot} from './weeklyCandidateAdmissionSnapshot.js';
import {advanceWeeklyCandidatePostAnalysis} from './weeklyCandidatePostAnalysis.js';
import {advanceWeeklyCandidateCanonicalMedia} from './weeklyCandidateCanonicalMedia.js';
import type {WeeklyQualifiedCandidate} from './weeklyQualifiedCandidateContinuation.js';
export const WEEKLY_PREPRODUCTION_JOBS = 'social_weekly_preproduction_jobs';
const parse = <T>(v: unknown) => socialObject(socialJson(v)) as unknown as T;
export type PreproductionStatus = 'bound' | 'blocked' | 'running' | 'succeeded' | 'no_data' | 'unknown';
export interface WeeklyPreproductionJob {
    jobId: string;
    tenantId: string;
    programId: string;
    packageId: string;
    packageVersion: number;
    consumerTaskId: string;
    consumerInputHash: string;
    kind: 'outline' | 'discovery';
    status: PreproductionStatus;
    originalRunKey: string;
    actorUserId: string;
    dueAt: string;
    boundAt: string;
    updatedAt: string;
    sourceHash: string;
    authority?: {
        scopeId: string;
        scopeVersion: number;
        scopeHash: string;
        requestedModes: SocialDiscoveryMode[];
    };
    code: string | null;
    resultRefs: VersionedSocialRef[];
    planningEvidenceHash?: string;
    collectionEvidenceHash?: string;
    /** Scoped outline proof; explicitly grants no production/outbound permission. */
    outlineReadiness?: ProductionOutlineReadiness;
    recordHash: string;
}
export type WeeklyExactSettlementPortsForRun=(job:WeeklyPreproductionJob|WeeklyPreproductionRetryAttempt,run:SocialInspirationCollectionRun)=>Promise<NonNullable<Parameters<typeof readWeeklyCandidateAdmissionSnapshot>[0]['exactAnalysisPorts']>|null>;
const seal = (j: WeeklyPreproductionJob) => ({ ...j, recordHash: socialRequestHash({ ...j, recordHash: '' }) });
async function all(store: DataStore, c: string, where: Record<string, string | number>) { const rows: Record_[] = []; let total: number | undefined; for (let page = 1; page <= 10000; page++) {
    const r = await store.list<Record_>(c, { where, page, perPage: 500, sort: 'id' });
    if (!Number.isSafeInteger(r.totalItems) || r.totalItems < 0 || total !== undefined && total !== r.totalItems || new Set(r.items.map(x => x.id)).size !== r.items.length || r.items.some(x => !x.id || rows.some(y => y.id === x.id) || Object.entries(where).some(([k, v]) => x[k] !== v)))
        throw Error('weekly_preproduction_scan_invalid');
    total = r.totalItems;
    rows.push(...r.items);
    if (rows.length === total)
        return rows;
    if (!r.items.length || rows.length > total)
        throw Error('weekly_preproduction_scan_incomplete');
} throw Error('weekly_preproduction_scan_limit'); }
async function unique(store: DataStore, c: string, where: Record<string, string | number>) { const r = await all(store, c, where); if (r.length !== 1)
    throw Error('weekly_preproduction_source_not_unique'); return r[0]!; }
async function member(store: DataStore, tenant: string, user: string) { const local=localTenantMember(tenant,user);const actor = local===undefined?await store.getById<Record_>('users', user):local as Record_ | null; if (!actor || actor.tenantId !== tenant || !organizationRoleOrNull(actor.role) || actor.disabled === true || actor.active === false || ['disabled', 'suspended'].includes(String(actor.status)))
    throw Error('weekly_preproduction_member_required'); }
async function scope(store: DataStore, a: {
    tenantId: string;
    programId: string;
    packageId: string;
    packageVersion: number;
    consumerTaskId: string;
}) { const tr = await unique(store, 'social_weekly_execution_tasks', { tenant_id: a.tenantId, program_id: a.programId, task_id: a.consumerTaskId }), task = parse<WeeklyExecutionTask>(tr.payload), pr = await unique(store, 'social_weekly_operating_packages', { tenant_id: a.tenantId, program_id: a.programId, package_id: a.packageId, version: a.packageVersion }), pkg = parse<WeeklyOperatingPackage>(pr.payload); if (!task || task.taskId !== a.consumerTaskId || task.tenantId !== a.tenantId || task.programId !== a.programId || task.packageId !== a.packageId || task.packageVersion !== a.packageVersion || !pkg || pkg.programId !== a.programId || pkg.packageId !== a.packageId || pkg.version !== a.packageVersion || !['draft', 'active'].includes(pkg.status))
    throw Error('weekly_preproduction_scope_changed'); return { task, pkg }; }
async function facts(store: DataStore, tenant: string) { const r = await unique(store, 'tenant_profiles', { tenant_id: tenant }), p = parse<EnterpriseProfile>(r.profile), v = p?.factVersion; if (!p || !v || !v.id || !Number.isSafeInteger(v.revision) || v.revision < 1 || !verifyEnterpriseFactContent(p).verified || !Number.isFinite(Date.parse(v.confirmedAt)) || Date.parse(v.confirmedAt) > Date.now())
    throw Error('weekly_preproduction_confirmed_facts_required'); await member(store, tenant, v.confirmedBy); return socialRequestHash({ id: v.id, revision: v.revision, contentHash: v.contentHash, confirmedBy: v.confirmedBy }); }
function checked(row: Record_) { const j = parse<WeeklyPreproductionJob>(row.payload); if (!j || !['outline','discovery'].includes(j.kind)||!['bound','blocked','running','succeeded','no_data','unknown'].includes(j.status)||!Number.isSafeInteger(j.packageVersion)||j.packageVersion<1||!Number.isFinite(Date.parse(j.dueAt))||!j.originalRunKey||!j.actorUserId||j.recordHash !== seal(j).recordHash || row.id !== j.jobId || row.tenant_id !== j.tenantId || row.program_id !== j.programId || row.package_id !== j.packageId || row.package_version !== j.packageVersion || row.task_id !== j.consumerTaskId || row.input_hash !== j.consumerInputHash || row.kind !== j.kind || row.original_run_key !== j.originalRunKey || row.status !== j.status || row.record_hash !== j.recordHash)
    throw Error('weekly_preproduction_job_corrupt'); return j; }
export async function bindWeeklyPreproductionAuthority(input: {
    store: DataStore;
    tenantId: string;
    programId: string;
    packageId: string;
    packageVersion: number;
    taskId: string;
    actorUserId: string;
    kind: 'outline' | 'discovery';
    expectedConsumerInputHash: string;
    discovery?: {
        scopeId: string;
        scopeVersion: number;
        requestedModes: SocialDiscoveryMode[];
    };
    now?: Date;
}) {
    const a = { ...input, consumerTaskId: input.taskId };
    await member(input.store, input.tenantId, input.actorUserId);
    return withExecutionPackageGate(input.store, a, async (assert) => {
        const { task } = await scope(input.store, a);
        if (task.lease || ['succeeded', 'cancelled', 'dead_letter'].includes(task.status) || task.schedule.stepKind !== (input.kind === 'outline' ? 'business_outline' : 'benchmark_collection') || supplementConsumerHash(task) !== input.expectedConsumerInputHash || await executionPackageFrozen(input.store, a))
            throw Error('weekly_preproduction_consumer_changed');
        let authority: WeeklyPreproductionJob['authority'];
        let sourceHash = '';
        let code: string | null = null;
        if (input.kind === 'outline') {
            try {
                sourceHash = await facts(input.store, input.tenantId);
            }
            catch {
                code = 'weekly_preproduction_confirmed_facts_required';
            }
        }
        else {
            const d = input.discovery;
            if (!d || !d.requestedModes.length || new Set(d.requestedModes).size !== d.requestedModes.length)
                throw Error('weekly_preproduction_discovery_authority_required');
            const scopeRow = await input.store.getById<DiscoveryScopeRecord>('social_discovery_scopes', d.scopeId);
            if (!scopeRow || scopeRow.tenant_id !== input.tenantId || scopeRow.status !== 'active' || scopeRow.version !== d.scopeVersion || scopeRow.payload.approval?.status !== 'approved' || scopeRow.payload.approval.scopeVersion !== d.scopeVersion || d.requestedModes.some(m => !scopeRow.payload.discoveryBrief.discoveryModes.includes(m) || !scopeRow.payload.discoveryBrief.modePolicies?.[m]?.enabled))
                throw Error('weekly_preproduction_scope_not_approved');
            const approval=scopeRow.payload.approval;
            // Old UI scopes stored a role enum in approvedBy and the actual
            // authenticated saver in created_by. Neither is an invented user.
            const approvalActor=approval.approvedByUserId ?? (approval.approvedBy==='user'?scopeRow.created_by:approval.approvedBy);
            if(typeof approvalActor!=='string'||!approvalActor||['user','business_agent'].includes(approvalActor))throw Error('weekly_preproduction_scope_not_approved');
            if(approval.approvedBy==='user'&&scopeRow.created_by&&approvalActor!==scopeRow.created_by)throw Error('weekly_preproduction_scope_approver_mismatch');
            await member(input.store,input.tenantId,approvalActor);
            authority = { scopeId: d.scopeId, scopeVersion: d.scopeVersion, scopeHash: socialRequestHash(scopeRow.payload), requestedModes: [...d.requestedModes] };
            sourceHash = authority.scopeHash;
        }
        const jobId = socialRequestHash({ tenantId: input.tenantId, taskId: task.taskId, inputHash: input.expectedConsumerInputHash, kind: input.kind }).slice(0, 15), now = (input.now ?? new Date()).toISOString(), job: WeeklyPreproductionJob = { jobId, tenantId: input.tenantId, programId: input.programId, packageId: input.packageId, packageVersion: input.packageVersion, consumerTaskId: task.taskId, consumerInputHash: input.expectedConsumerInputHash, kind: input.kind, status: code ? 'blocked' : 'bound', originalRunKey: `weekly-preproduction:${jobId}`, actorUserId: input.actorUserId, dueAt: task.schedule.latestStartAt || task.schedule.estimatedStartAt, boundAt: now, updatedAt: now, sourceHash, authority, code, resultRefs: [], recordHash: '' };
        if (!Number.isFinite(Date.parse(job.dueAt)))
            throw Error('weekly_preproduction_deadline_missing');
        const prior = await input.store.getById<Record_>(WEEKLY_PREPRODUCTION_JOBS, jobId);
        if (prior) {
            const existing = checked(prior);
            if (existing.kind === 'outline' && existing.status === 'blocked' && !existing.sourceHash && job.sourceHash && existing.actorUserId === job.actorUserId && existing.dueAt === job.dueAt) {
                await assert();
                const rebound = seal({ ...existing, sourceHash: job.sourceHash, status: 'bound', code: null, updatedAt: now });
                if (!await input.store.update(WEEKLY_PREPRODUCTION_JOBS, jobId, { status: rebound.status, record_hash: rebound.recordHash, payload: rebound }))
                    throw Error('weekly_preproduction_binding_write_failed');
                return rebound;
            }
            if (existing.actorUserId !== job.actorUserId || socialRequestHash(existing.authority ?? null) !== socialRequestHash(job.authority ?? null) || existing.sourceHash !== job.sourceHash || existing.dueAt !== job.dueAt)
                throw Error('weekly_preproduction_binding_conflict');
            return existing;
        }
        await assert();
        if (!await input.store.create(WEEKLY_PREPRODUCTION_JOBS, { id: jobId, tenant_id: job.tenantId, program_id: job.programId, package_id: job.packageId, package_version: job.packageVersion, task_id: job.consumerTaskId, input_hash: job.consumerInputHash, kind: job.kind, status: job.status, original_run_key: job.originalRunKey, record_hash: seal(job).recordHash, payload: seal(job) }))
            throw Error('weekly_preproduction_binding_write_failed');
        return seal(job);
    });
}
export async function listWeeklyPreproductionJobs(input: {
    store: DataStore;
    tenantId: string;
    programId: string;
    packageId: string;
    packageVersion: number;
}) { const parent=await unique(input.store, 'social_weekly_operating_packages', { tenant_id: input.tenantId, program_id: input.programId, package_id: input.packageId, version: input.packageVersion });const pkg=parse<WeeklyOperatingPackage>(parent.payload);if(!pkg||pkg.programId!==input.programId||pkg.packageId!==input.packageId||pkg.version!==input.packageVersion||!['active','draft'].includes(pkg.status))throw Error('weekly_preproduction_scope_changed'); const rows = await all(input.store, WEEKLY_PREPRODUCTION_JOBS, { tenant_id: input.tenantId, program_id: input.programId, package_id: input.packageId, package_version: input.packageVersion }); const result: Array<WeeklyPreproductionJob & {activeForConsumer:boolean;accountCollectionRecovery:Awaited<ReturnType<typeof readWeeklyAccountCollectionRecovery>>}> = []; for (const row of rows) {
    const job = checked(row);
    const { task } = await scope(input.store, job);
    if (job.consumerInputHash !== supplementConsumerHash(task) || job.dueAt !== (task.schedule.latestStartAt || task.schedule.estimatedStartAt))
        throw Error('weekly_preproduction_consumer_changed');
    const retry=job.kind==='discovery'?await readWeeklyPreproductionRetryAttempt(input.store,job):null;
    result.push({...job,activeForConsumer:!retry,accountCollectionRecovery:job.kind==='discovery'?await readWeeklyAccountCollectionRecovery(input.store,job):null});
    if(retry)result.push({...retry,activeForConsumer:true,accountCollectionRecovery:null});
} return result; }
export async function runWeeklyPreproductionProducerScan(input: {
    store: DataStore;
    now?: Date;
    discoveryDependencies?: ApprovedDiscoveryRunDependencies;
    /** Optional durable original-operation inspection. It never supplies a paid permit. */
    accountOriginalRecovery?: (job: WeeklyPreproductionJob) => Promise<Omit<Parameters<typeof inspectWeeklyAccountCollectionOriginalRecovery>[0], 'store'|'jobId'> | null>;
    /** Explicit metered start binding. Absence keeps the paid gate closed. */
    accountOriginalStart?: (job: WeeklyPreproductionJob) => Promise<Omit<Parameters<typeof advanceWeeklyAccountCollectionOriginalTransport>[0], 'store'|'jobId'> | null>;
    accountOriginalContinuation?: (job: WeeklyPreproductionJob) => Promise<Omit<Parameters<typeof continueAcceptedWeeklyAccountCollectionOriginal>[0], 'store'|'jobId'> | null>;
    accountOriginalDataset?: (job: WeeklyPreproductionJob) => Promise<Omit<Parameters<typeof continueWeeklyAccountCollectionOriginalDataset>[0], 'store'|'jobId'> | null>;
    candidatePorts?:CandidateReassessmentPorts & {transferabilityPorts?:NonNullable<Parameters<typeof readWeeklyCandidateAdmissionSnapshot>[0]['transferabilityPorts']>;exactAnalysisPorts?:NonNullable<Parameters<typeof advanceWeeklyCandidatePostAnalysis>[0]['exactAnalysisPorts']>;exactAnalysisPortsForRun?:(job:WeeklyPreproductionJob|WeeklyPreproductionRetryAttempt,run:SocialInspirationCollectionRun)=>Promise<NonNullable<Parameters<typeof advanceWeeklyCandidatePostAnalysis>[0]['exactAnalysisPorts']>|null>;canonicalMedia?:NonNullable<Parameters<typeof advanceWeeklyCandidatePostAnalysis>[0]['canonicalMedia']>};
    scope?:WeeklyScanScope;
}) {
    if (input.discoveryDependencies && input.discoveryDependencies.dataStore !== input.store)
        throw Error('weekly_preproduction_store_mismatch');
    // Only server-owned isolation tests may replace live inventory and GET
    // transport. The admission verdict, hashes and lineage remain real.
    const directorTestPorts=input.candidatePorts?.transferabilityPorts?{
        mediaRoot:input.candidatePorts.mediaRoot??fileURLToPath(new URL('../../data/media',import.meta.url)),
        transferabilityPorts:input.candidatePorts.transferabilityPorts,
    }:undefined;
    if(directorTestPorts&&(process.env.NODE_ENV!=='test'||!path.isAbsolute(directorTestPorts.mediaRoot)))throw Error('weekly_director_test_ports_forbidden');
    const report = { succeeded: 0, blocked: 0, noData: 0, unknown: 0, failed: 0, failures: [] as Array<{
            jobId: string;
            code: string;
        }> };
    for (const row of await all(input.store, WEEKLY_PREPRODUCTION_JOBS, {})) {
        let job: WeeklyPreproductionJob;
        try {
            job = checked(row);
            const rootJob=job;
            if(!weeklyScopeMatches(input.scope,job))continue;
            if (job.status === 'succeeded') {
                await withExecutionPackageGate(input.store, job, async (assert) => { await recoverConsumer(input.store, job, assert, input.candidatePorts?.exactAnalysisPortsForRun); });
                continue;
            }
            await withExecutionPackageGate(input.store, job, async (assert) => {
                let receiptCollection=WEEKLY_PREPRODUCTION_JOBS;
                let sharedLeader:WeeklyPreproductionJob|null=null;
                if(job.kind==='discovery'){
                    const peers=(await all(input.store,WEEKLY_PREPRODUCTION_JOBS,{tenant_id:job.tenantId,program_id:job.programId,package_id:job.packageId,package_version:job.packageVersion}))
                        .map(checked)
                        .filter(peer=>peer.kind==='discovery'&&peer.sourceHash===job.sourceHash&&socialRequestHash(peer.authority??null)===socialRequestHash(job.authority??null))
                        .sort((a,b)=>a.jobId.localeCompare(b.jobId));
                    sharedLeader=peers[0]??null;
                }
                if(job.kind==='discovery'&&sharedLeader?.jobId===rootJob.jobId){
                    let retry=await ensureWeeklyPreproductionRetryAttempt(input.store,job,(input.now??new Date()).toISOString());
                    if(!retry&&['weekly_qualified_admission_unverified','weekly_qualified_quota_exhausted'].includes(job.code??'')){
                        const rootRunId=`weekly_discovery_${socialRequestHash({tenantId:job.tenantId,key:job.originalRunKey})}`;
                        const rootRuns=await all(input.store,'social_discovery_runs',{tenant_id:job.tenantId,runId:rootRunId});
                        if(rootRuns.length===1){
                            const childRows=await all(input.store,PREPRODUCTION_RETRY_ATTEMPTS,{tenant_id:job.tenantId,program_id:job.programId,package_id:job.packageId,package_version:job.packageVersion,root_job_id:job.jobId});
                            const runs=[rootRuns[0] as unknown as SocialInspirationCollectionRun];
                            const pending=[...childRows];
                            while(pending.length){
                                const parentHash=socialRequestHash(runs.at(-1));
                                const index=pending.findIndex(row=>(row.payload as WeeklyPreproductionRetryAttempt).retry?.parentRunHash===parentHash);
                                if(index<0)break;
                                const child=pending.splice(index,1)[0]!.payload as WeeklyPreproductionRetryAttempt;
                                const childId=`weekly_discovery_${socialRequestHash({tenantId:job.tenantId,key:child.originalRunKey})}`;
                                const found=await all(input.store,'social_discovery_runs',{tenant_id:job.tenantId,runId:childId});
                                if(found.length!==1)break;
                                runs.push(found[0] as unknown as SocialInspirationCollectionRun);
                            }
                            if(!pending.length){
                                const staged=await ensureWeeklyQualifiedContinuationAttempt({store:input.store,job,runs,mediaRoot:input.candidatePorts?.mediaRoot??fileURLToPath(new URL('../../data/media',import.meta.url)),now:input.now??new Date()});
                                retry=staged.attempt;
                            }
                        }
                    }
                    if(retry){job=retry;receiptCollection=PREPRODUCTION_RETRY_ATTEMPTS;}
                }
                if(job.status==='succeeded'){await recoverConsumer(input.store,job,assert,input.candidatePorts?.exactAnalysisPortsForRun);return;}
                const { task, pkg } = await scope(input.store, job);
                if (task.lease || ['succeeded', 'cancelled', 'dead_letter'].includes(task.status) || supplementConsumerHash(task) !== job.consumerInputHash || job.dueAt !== (task.schedule.latestStartAt || task.schedule.estimatedStartAt) || await executionPackageFrozen(input.store, job))
                    throw Error('weekly_preproduction_consumer_changed');
                await member(input.store, job.tenantId, job.actorUserId);
                const save = async (status: PreproductionStatus, code: string | null, refs: VersionedSocialRef[] = []) => { await assert(); job = seal({ ...job, status, code, resultRefs: refs, updatedAt: (input.now ?? new Date()).toISOString() }); if (!await input.store.update(receiptCollection, job.jobId, { status, record_hash: job.recordHash, payload: job }))
                    throw Error('weekly_preproduction_receipt_write_failed'); if (status === 'succeeded')
                    await recoverConsumer(input.store, job, assert, input.candidatePorts?.exactAnalysisPortsForRun); };
                if(job.kind==='discovery'&&sharedLeader&&sharedLeader.jobId!==rootJob.jobId){
                    const leaderTask=(await scope(input.store,sharedLeader)).task;
                    const gate=await readWeeklyPreproductionExecutionGate(input.store,leaderTask,input.candidatePorts?.exactAnalysisPortsForRun);
                    const activeLeader=await readWeeklyPreproductionRetryAttempt(input.store,sharedLeader)??sharedLeader;
                    if(gate.ready){
                        job={...job,planningEvidenceHash:activeLeader.planningEvidenceHash,collectionEvidenceHash:activeLeader.collectionEvidenceHash};
                        await save('succeeded',null,gate.resultRefs);report.succeeded++;
                    }else{
                        const status:PreproductionStatus=activeLeader.status==='no_data'?'no_data':'blocked';
                        await save(status,activeLeader.status==='bound'||activeLeader.status==='running'?'weekly_preproduction_shared_collection_pending':gate.code??'weekly_preproduction_shared_collection_pending');
                        if(status==='no_data')report.noData++;else report.blocked++;
                    }
                    return;
                }
                if (job.kind === 'outline') {
                    let source: string;
                    try {
                        source = await facts(input.store, job.tenantId);
                    }
                    catch {
                        await save('blocked', 'weekly_preproduction_confirmed_facts_required');
                        report.blocked++;
                        return;
                    }
                    if (!job.sourceHash || source !== job.sourceHash) {
                        await save('blocked', 'weekly_preproduction_facts_changed');
                        report.blocked++;
                        return;
                    }
                    let snapshot;
                    if (pkg.operatingDecisionSnapshotRef) {
                        snapshot = await createSocialOperatingOrchestrationService(input.store).getSnapshot(job.tenantId, job.programId, pkg.operatingDecisionSnapshotRef.id, pkg.operatingDecisionSnapshotRef.version);
                        if (snapshot.programId !== job.programId || snapshot.planningWeekStart !== pkg.weekStart || snapshot.businessContentGoalRef.id !== pkg.businessContentGoalRef?.id || snapshot.businessContentGoalRef.version !== pkg.businessContentGoalRef?.version)
                            throw Error('weekly_preproduction_frozen_snapshot_changed');
                    }
                    else {
                        const recoveryOnly = ['running', 'unknown'].includes(job.status);
                        await save('running', null);
                        snapshot = (await createSocialOperatingOrchestrationService(input.store).resolve(job.tenantId, job.actorUserId, job.programId, { weekStart: pkg.weekStart, desiredOriginalContents: pkg.socialContentPackage.originalContentTarget, desiredAdaptations: pkg.socialContentPackage.adaptationVersionTarget }, { key: job.originalRunKey, recoveryOnly }).catch(async (error) => { await save('unknown', 'weekly_preproduction_original_write_unknown'); throw error; })).snapshot;
                    }
                    try{job = { ...job, outlineReadiness: await assertOutlineProof(input.store,job,snapshot) };}catch(error){await save('blocked',error instanceof Error?error.message:'weekly_preproduction_outline_source_mismatch');report.blocked++;return;}
                    const planning = await createWeeklyPlanningAuthority(input.store).initialize(job.tenantId, pkg);
                    await save('succeeded', null, [{ type: 'operating_authority_snapshot', id: snapshot.snapshotId, version: snapshot.version }, snapshot.businessContentGoalRef, { type: 'weekly_agent_planning', id: planning.planningId, version: planning.version }]);
                    report.succeeded++;
                }
                else {
                    // A provider run can be durably completed before the child
                    // attempt is advanced from bound. Recover that exact run
                    // without demanding fresh credentials or resubmitting it.
                    const existingRunId=`weekly_discovery_${socialRequestHash({tenantId:job.tenantId,key:job.originalRunKey})}`;
                    const existingRuns=await all(input.store,'social_discovery_runs',{tenant_id:job.tenantId,runId:existingRunId});
                    if(existingRuns.length>1)throw Error('weekly_preproduction_original_not_unique');
                    const recoveryOnly = ['running','unknown'].includes(job.status)||existingRuns.length===1;
                    if (!recoveryOnly) {
                        const parents=await all(input.store,'social_weekly_execution_tasks',{tenant_id:job.tenantId,program_id:job.programId,package_id:job.packageId,package_version:job.packageVersion});
                        if(task.dependsOnTaskIds.some(id=>parents.filter(r=>r.task_id===id&&(parse<WeeklyExecutionTask>(r.payload)).status==='succeeded').length!==1)){
                            await save('blocked','weekly_preproduction_upstream_delivery_required');report.blocked++;return;
                        }
                        const now=(input.now??new Date()).toISOString();
                        const independent=await readIndependentAdmission(input.store,task);
                        const automatic=independent?await readWeeklyAutomaticPreproductionAdmission(input.store,task,now):null;
                        const scheduledAt=Date.parse(task.schedule.estimatedStartAt);
                        if(!Number.isFinite(scheduledAt)||(independent?!automatic?.eligible:Date.parse(now)<scheduledAt)){
                            await save('blocked','weekly_preproduction_execution_window_required');report.blocked++;return;
                        }
                    }
                    const a = job.authority;
                    if (!a)
                        throw Error('weekly_preproduction_discovery_authority_required');
                    const bound = await input.store.getById<DiscoveryScopeRecord>('social_discovery_scopes', a.scopeId);
                    if (!bound || bound.tenant_id !== job.tenantId || bound.version !== a.scopeVersion || bound.status !== 'active' || socialRequestHash(bound.payload) !== a.scopeHash || bound.payload.approval?.status !== 'approved' || bound.payload.approval.scopeVersion !== a.scopeVersion) {
                        await save('blocked', 'weekly_preproduction_scope_changed');
                        report.blocked++;
                        return;
                    }
                    const retry=(job as WeeklyPreproductionRetryAttempt).retry;
                    if(!retry&&existingRuns.length===0&&input.accountOriginalRecovery&&(bound.payload as typeof bound.payload&{weeklyAccountRevision?:{accountUrl?:string}}).weeklyAccountRevision){
                        const recoveryPorts=await input.accountOriginalRecovery(job);
                        if(recoveryPorts){
                            const recovery=await inspectWeeklyAccountCollectionOriginalRecovery({store:input.store,jobId:job.jobId,...recoveryPorts});
                            if(recovery.state!=='not_submitted'){
                                // Append outside the original job. Resealing it would change
                                // the record hash pinned by the prepaid operation.
                                await recordWeeklyAccountCollectionRecovery({store:input.store,job,operationIdentity:recovery.scope.operationIdentity,requestHash:recovery.scope.requestHash,tokenFingerprint:recoveryPorts.wallet.tokenFingerprint,state:recovery.state,acceptedPost:recovery.acceptedPost});
                                // Always re-project below: a 201 journal may have arrived
                                // after an injected recovery reader observed UNKNOWN.
                            }
                        }
                    }
                    if(!retry&&(existingRuns.length===0||['running','failed'].includes(String(existingRuns[0]?.status??'')))){
                        let recoveredDatasetReady=false;
                        let projected=await readWeeklyAccountCollectionRecoveryEvidence(input.store,job);
                        if(projected){
                            let code=projected.code;
                            const revision=(bound.payload as typeof bound.payload&{weeklyAccountRevision?:{accountUrl?:string;targetCount?:number}}).weeklyAccountRevision;
                            if(projected.state==='submitted_unknown_no_replay'&&revision?.targetCount===5&&revision.accountUrl){
                                // No wallet, token, POST or provider GET is needed to notice a
                                // previously fsynced 201. The original sidecar pins the exact
                                // operation; the frozen approved scope pins the five-video body.
                                const post=await createApifyPrepaidOriginalPostReader().read(projected);
                                if(post){
                                    const expectedBodyHash=createHash('sha256').update(JSON.stringify(frozenWeeklyAccountFiveVideoActorInput(revision.accountUrl))).digest('hex');
                                    if(post.actorInputSha256!==expectedBodyHash||post.operationIdentity!==projected.operationIdentity||post.requestHash!==projected.requestHash||post.tokenFingerprint!==projected.tokenFingerprint||post.status!==201||post.url!==WEEKLY_ACCOUNT_COLLECTION_ACTOR_RUN_ENDPOINT)throw Error('weekly_account_collection_original_recovery_unverified');
                                    await recordWeeklyAccountCollectionRecovery({store:input.store,job,operationIdentity:projected.operationIdentity,requestHash:projected.requestHash,tokenFingerprint:projected.tokenFingerprint,state:'accepted_needs_original_get',acceptedPost:post});
                                    code='weekly_preproduction_original_accepted_needs_get';
                                    projected=await readWeeklyAccountCollectionRecoveryEvidence(input.store,job);
                                }
                            }
                            if(projected?.state==='accepted_needs_original_get'&&input.accountOriginalContinuation){
                                const continuation=await input.accountOriginalContinuation(job);
                                if(continuation?.permit?.permitsPaidCollection===true){
                                    const pinned=await continuation.acceptedPost.read(projected);
                                    if(!pinned||pinned.operationIdentity!==projected.operationIdentity||pinned.requestHash!==projected.requestHash||pinned.tokenFingerprint!==projected.tokenFingerprint||socialRequestHash(pinned)!==projected.acceptedPostHash)throw Error('weekly_account_collection_original_continuation_changed');
                                    const result=await continueAcceptedWeeklyAccountCollectionOriginal({store:input.store,jobId:job.jobId,...continuation});
                                    if(result.acceptedPost.operationIdentity!==projected.operationIdentity||result.acceptedPost.requestHash!==projected.requestHash||result.acceptedPost.tokenFingerprint!==projected.tokenFingerprint||socialRequestHash(result.acceptedPost)!==projected.acceptedPostHash)throw Error('weekly_account_collection_original_continuation_changed');
                                    await recordWeeklyAccountCollectionRecovery({store:input.store,job,operationIdentity:projected.operationIdentity,requestHash:projected.requestHash,tokenFingerprint:projected.tokenFingerprint,state:'original_run_verified_needs_dataset',acceptedPost:result.acceptedPost});
                                    code='weekly_preproduction_original_run_verified_needs_dataset';
                                }
                            }
                            if(projected?.state==='original_run_verified_needs_dataset'&&input.accountOriginalDataset){
                                const datasetPorts=await input.accountOriginalDataset(job);
                                if(datasetPorts){
                                    const acceptedPost=datasetPorts.walletArgs?.acceptedPost??datasetPorts.acceptedPost;
                                    if(!acceptedPost)throw Error('weekly_account_collection_original_dataset_accepted_post_missing');
                                    const pinned=await acceptedPost.read(projected);
                                    if(!pinned||pinned.operationIdentity!==projected.operationIdentity||pinned.requestHash!==projected.requestHash||pinned.tokenFingerprint!==projected.tokenFingerprint||socialRequestHash(pinned)!==projected.acceptedPostHash)throw Error('weekly_account_collection_original_dataset_changed');
                                    const dataset=await continueWeeklyAccountCollectionOriginalDataset({store:input.store,jobId:job.jobId,...datasetPorts});
                                    code=dataset.code;
                                    if(dataset.status==='verified'&&dataset.replay&&(existingRuns.length===1||Boolean(input.candidatePorts?.canonicalMedia))&&(existingRuns.length===0||['running','failed'].includes(String(existingRuns[0]?.status??'')))){
                                        const imported=await executeApprovedDiscoveryRun({tenantId:job.tenantId,triggerType:'manual',expectedScopeId:a.scopeId,expectedScopeVersion:a.scopeVersion,requestedModes:a.requestedModes,
                                            originalRun:{key:job.originalRunKey,scopeHash:a.scopeHash,recoveryOnly:existingRuns.length===1,weeklyScope:{programId:job.programId,packageId:job.packageId,packageVersion:job.packageVersion,originalRunKey:job.originalRunKey}},
                                            originalDatasetReplay:dataset.replay,now:input.now},input.discoveryDependencies);
                                        if(!imported.run||!['running','succeeded','partial','stopped'].includes(imported.run.status))throw Error('weekly_original_dataset_replay_run_unavailable');
                                        code='weekly_preproduction_original_dataset_imported_analysis_pending';
                                        if(input.candidatePorts?.canonicalMedia){
                                            const ids=socialObject(socialObject(socialJson(imported.run.scopeSnapshot))?.weeklyProducer)?.originalDatasetCandidateIds;
                                            if(!Array.isArray(ids)||ids.length>5||ids.some(id=>typeof id!=='string'))throw Error('weekly_original_dataset_candidate_lineage_invalid');
                                            for(const candidateId of ids as string[]){
                                                const record=await input.store.getById<Record_>('trend_videos',candidateId);
                                                if(!record||record.tenantId!==job.tenantId)throw Error('weekly_original_dataset_candidate_missing');
                                                const binding=await input.candidatePorts.canonicalMedia.bindingForCandidate(candidateId);
                                                const result=await advanceWeeklyCandidateCanonicalMedia({store:input.store,job,run:imported.run,record,
                                                    mediaRoot:input.candidatePorts.mediaRoot??fileURLToPath(new URL('../../data/media',import.meta.url)),
                                                    binding,ports:input.candidatePorts.canonicalMedia.ports});
                                                if(result.state!=='completed'){code=result.code;break;}
                                            }
                                            if(code==='weekly_preproduction_original_dataset_imported_analysis_pending'&&ids.length===5)
                                                code='weekly_preproduction_original_canonical_five_analysis_pending';
                                        }
                                        recoveredDatasetReady=['succeeded','partial','stopped'].includes(imported.run.status)&&code==='weekly_preproduction_original_canonical_five_analysis_pending';
                                    }
                                }
                            }
                            if(!recoveredDatasetReady){report.failures.push({jobId:job.jobId,code});report.unknown++;return;}
                        }
                    }
                    if (!recoveryOnly) {
                        const revision=(bound.payload as typeof bound.payload&{weeklyAccountRevision?:{accountUrl?:string}}).weeklyAccountRevision;
                        if(revision){
                            const paidBlocker=await readWeeklyAccountCollectionPaidBlocker({store:input.store,tenantId:job.tenantId,programId:job.programId,packageId:job.packageId,packageVersion:job.packageVersion,scopeId:a.scopeId,scopeVersion:a.scopeVersion,scopeHash:a.scopeHash,accountUrl:revision.accountUrl??''});
                            if(paidBlocker==='weekly_preproduction_collection_metered_runtime_binding_required'&&input.accountOriginalStart){
                                const start=await input.accountOriginalStart(job);
                                if(start){
                                    const result=await advanceWeeklyAccountCollectionOriginalTransport({store:input.store,jobId:job.jobId,...start});
                                    const recovery=await inspectWeeklyAccountCollectionOriginalRecovery({store:input.store,authorization:start.authorization,jobId:job.jobId,wallet:start.wallet,acceptedPost:start.acceptedPost});
                                    if(result.status==='original_run_verified'&&recovery.acceptedPost){
                                        await recordWeeklyAccountCollectionRecovery({store:input.store,job,operationIdentity:recovery.scope.operationIdentity,requestHash:recovery.scope.requestHash,tokenFingerprint:start.wallet.tokenFingerprint,state:'original_run_verified_needs_dataset',acceptedPost:recovery.acceptedPost});
                                        report.failures.push({jobId:job.jobId,code:'weekly_preproduction_original_run_verified_needs_dataset'});
                                    }else{
                                        await recordWeeklyAccountCollectionRecovery({store:input.store,job,operationIdentity:recovery.scope.operationIdentity,requestHash:recovery.scope.requestHash,tokenFingerprint:start.wallet.tokenFingerprint,state:'submitted_unknown_no_replay',acceptedPost:null});
                                        report.failures.push({jobId:job.jobId,code:'weekly_preproduction_original_submitted_unknown_no_replay'});
                                    }
                                    report.unknown++;return;
                                }
                            }
                            await save('blocked',paidBlocker);report.blocked++;return;
                        }
                        if (!process.env.APIFY_TOKEN?.trim()) {
                            await save('blocked', 'weekly_preproduction_collection_credentials_required');
                            report.blocked++;
                            return;
                        }
                    }
                    await save('running', null);
                    const result = await executeApprovedDiscoveryRun({ tenantId: job.tenantId, triggerType: 'manual', expectedScopeId: a.scopeId, expectedScopeVersion: a.scopeVersion, requestedModes: a.requestedModes, originalRun: { key: job.originalRunKey, scopeHash: a.scopeHash, recoveryOnly,...(!retry?{weeklyScope:{programId:job.programId,packageId:job.packageId,packageVersion:job.packageVersion,originalRunKey:job.originalRunKey}}:{}) },now:input.now,...(retry?{retry:{parentRunId:retry.parentRunId,parentRunHash:retry.parentRunHash,sourceSelection:retry.sourceSelection,...(retry.kind?{kind:retry.kind,continuationStageId:retry.continuationStageId}:{}),...(retry.authorization?{authorization:retry.authorization}:retry.grant?{grant:retry.grant}:{})}}:{}) }, input.discoveryDependencies);
                    const run = result.run;
                    if (!run) {
                        await save(recoveryOnly?'unknown':'blocked', result.reason ?? 'weekly_preproduction_collection_unavailable');
                        if(recoveryOnly)report.unknown++;else report.blocked++;
                        return;
                    }
                    if (run.status === 'running') {
                        await save('unknown', 'weekly_preproduction_original_run_pending');
                        report.unknown++;
                        return;
                    }
                    // Only five distinct post-analysis admissions from this exact
                    // package/version and immutable run chain can fill the mothers.
                    // Metadata acceptance alone never authorizes the director.
                    const externalReferencesNeeded=!pkg.referenceSourcePolicy||[...allocateWeeklyReferenceSources(pkg.socialContentPackage.publicationTasks,pkg.referenceSourcePolicy).values()].includes('external');
                    let qualifiedDirectorIds:string[]=[];
                    if (pkg.socialContentPackage.originalContentTarget >= 5 && externalReferencesNeeded && run.status !== 'failed' && run.stopReason !== 'source_failed') {
                        const lineage = await weeklyDiscoveryLineageEvidence(input.store,job,run,run.evidenceOutcomes);
                        // Fewer than five metadata accepts is already a strict
                        // upper bound; do not read or pay for candidate analysis
                        // to establish a shortage that is mathematically proven.
                        if (lineage.acceptedCandidateIds.length < 5) {
                            const capacity=await readDailyCollectionCapacity(input.store,{tenantId:job.tenantId,runId:`weekly-qualified-capacity:${job.jobId}`,now:input.now});
                            if(capacity.kind==='normal_daily_window'&&capacity.remainingCount===0){
                                const persistedRun=await unique(input.store,'social_discovery_runs',{tenant_id:job.tenantId,runId:run.runId});
                                if(persistedRun.status!==run.status||socialRequestHash(persistedRun.evidenceOutcomes)!==socialRequestHash(run.evidenceOutcomes))throw Error('weekly_qualified_shortfall_run_changed');
                                await assert();
                                await ensureWeeklyQualifiedShortfallReceipt(input.store,{tenantId:job.tenantId,programId:job.programId,packageId:job.packageId,packageVersion:job.packageVersion,
                                    taskId:job.consumerTaskId,jobId:job.jobId,runId:run.runId,runHash:socialRequestHash(persistedRun),businessDate:capacity.businessDate,observedCandidateIds:lineage.observedCandidateIds,evidenceAcceptedCandidateIds:lineage.acceptedCandidateIds});
                                await save('blocked','weekly_qualified_quota_exhausted',[{type:'social_discovery_run',id:run.runId,version:1}]);
                                report.blocked++;
                                return;
                            }
                            // A new calendar window is not cross-day permission;
                            // the qualified continuation stage owns bounded
                            // same-day attempts and their durable receipts.
                            await save('blocked','weekly_qualified_admission_unverified',[{type:'social_discovery_run',id:run.runId,version:1}]);
                            report.blocked++;
                            return;
                        }
                        // Metadata below five already proves shortage; never
                        // start analysis solely to restate that arithmetic.
                        // Once five exist, advance safe local post-analysis for
                        // this exact run before reading formal mother admission.
                        await advanceWeeklyCandidatePostAnalysisChain({store:input.store,rootJob,job,run,pkg,mediaRoot:input.candidatePorts?.mediaRoot??fileURLToPath(new URL('../../data/media',import.meta.url)),acceptedCandidateIds:lineage.acceptedCandidateIds,exactAnalysisPorts:input.candidatePorts?.exactAnalysisPorts,exactAnalysisPortsForRun:input.candidatePorts?.exactAnalysisPortsForRun,canonicalMedia:input.candidatePorts?.canonicalMedia});
                        const admitted=await readWeeklyQualifiedDirectorAdmission({store:input.store,rootJob,job,run,mediaRoot:input.candidatePorts?.mediaRoot??fileURLToPath(new URL('../../data/media',import.meta.url)),exactAnalysisPorts:input.candidatePorts?.exactAnalysisPorts,exactAnalysisPortsForRun:input.candidatePorts?.exactAnalysisPortsForRun,...(directorTestPorts?{transferabilityPorts:directorTestPorts.transferabilityPorts}:{})});
                        qualifiedDirectorIds=admitted.candidateIds;
                        if(qualifiedDirectorIds.length<5){
                            const capacity=await readDailyCollectionCapacity(input.store,{tenantId:job.tenantId,runId:`weekly-qualified-capacity:${job.jobId}`,now:input.now});
                            if(capacity.kind==='normal_daily_window'&&capacity.remainingCount===0){
                                const persistedRun=await unique(input.store,'social_discovery_runs',{tenant_id:job.tenantId,runId:run.runId});
                                if(persistedRun.status!==run.status||socialRequestHash(persistedRun.evidenceOutcomes)!==socialRequestHash(run.evidenceOutcomes))throw Error('weekly_qualified_shortfall_run_changed');
                                await assert();
                                await ensureWeeklyPostAdmissionShortfallReceipt(input.store,{tenantId:job.tenantId,programId:job.programId,packageId:job.packageId,packageVersion:job.packageVersion,taskId:job.consumerTaskId,jobId:job.jobId,runId:run.runId,runHash:socialRequestHash(persistedRun),businessDate:capacity.businessDate,observedCandidateIds:lineage.observedCandidateIds,evidenceAcceptedCandidateIds:lineage.acceptedCandidateIds,postAdmissionAcceptedCandidateIds:qualifiedDirectorIds});
                            }
                            await save('blocked',capacity.kind==='normal_daily_window'&&capacity.remainingCount===0?'weekly_qualified_quota_exhausted':'weekly_qualified_admission_unverified',[{type:'social_discovery_run',id:run.runId,version:1}]);
                            report.blocked++;return;
                        }
                    }
                    let reassessment:Awaited<ReturnType<typeof reassessWeeklyCandidates>>['item']=null;
                    if(retry&&Object.values(run.evidenceOutcomes??{}).some(o=>o?.suggestionCandidateIds.length)&&!Object.values(run.modeStats).some(s=>(s?.accepted??0)>0)){
                        const read=await reassessWeeklyCandidates(input.store,job as WeeklyPreproductionRetryAttempt,run,input.candidatePorts);
                        if(!read.ready||!read.item){await save('unknown',read.code??'weekly_candidate_analysis_pending',[{type:'social_discovery_run',id:run.runId,version:1}]);report.unknown++;return;}
                        reassessment=read.item;
                    }
                    const reassessmentRef=reassessment?{type:'social_discovery_candidate_reassessment',id:reassessment.id,version:1}:null;
                    const effectiveOutcomes=reassessment?.evidenceOutcomes??run.evidenceOutcomes;
                    const weeklyEvidence=await weeklyDiscoveryLineageEvidence(input.store,job,run,effectiveOutcomes);
                    if (qualifiedDirectorIds.length>=5||reassessment||(['succeeded','partial'].includes(run.status) && Object.values(run.modeStats).some(s => (s?.accepted ?? 0) > 0))) {
                        await linkObservedWeeklyAccounts(input.store,job.tenantId,weeklyEvidence.acceptedCandidateIds);
                        const planner = createWeeklyPlanningAuthority(input.store,directorTestPorts,
                          input.candidatePorts?.exactAnalysisPortsForRun);
                        let planning = await planner.initialize(job.tenantId, pkg);
                        if (['confirmed', 'dispatched'].includes(planning.status)) {
                            await save('blocked', 'weekly_preproduction_plan_requires_replan');
                            report.blocked++;
                            return;
                        }
                        try {
                            if (planning.status !== 'awaiting_confirmation') {
                                planning = await planner.runDirectorAnalysis({ tenantId: job.tenantId, programId: job.programId, packageId: job.packageId, packageVersion: job.packageVersion, expectedPlanningVersion: planning.version, actor: 'director_agent', ...(pkg.socialContentPackage.originalContentTarget>=5&&externalReferencesNeeded?{eligibleVideoIds:qualifiedDirectorIds,discoveryAuthority:{rootJobId:rootJob.jobId,currentJobId:job.jobId,runId:run.runId}}:{}), now: input.now });
                                planning = await planner.mergeDetailedSchedule({ tenantId: job.tenantId, programId: job.programId, package: pkg, expectedPlanningVersion: planning.version, actor: 'business_agent', now: input.now });
                            }
                            await assertPlanningCollection(input.store,job,planning,{evidenceOutcomes:{weeklyLineage:weeklyEvidence}});
                        if (!planning.detailedSchedule || planning.status !== 'awaiting_confirmation')
                                throw Error('weekly_preproduction_director_schedule_incomplete');
                            job = { ...job, planningEvidenceHash: socialRequestHash({ directorAnalyses: planning.directorAnalyses, detailedSchedule: planning.detailedSchedule }), collectionEvidenceHash: socialRequestHash({ modeStats: run.modeStats, evidenceOutcomes: run.evidenceOutcomes, scopeSnapshot: run.scopeSnapshot,...(reassessmentRef?{reassessmentRef}:{}) }) };
                            await save('succeeded', null, [{ type: 'social_discovery_run', id: run.runId, version: 1 },...(reassessmentRef?[reassessmentRef]:[]), { type: 'weekly_agent_planning', id: planning.planningId, version: planning.version }]);
                            report.succeeded++;
                        }
                        catch (error) {
                            await save('blocked', error instanceof SocialProgramError ? error.code : error instanceof Error ? error.message : 'weekly_preproduction_director_schedule_incomplete', [{ type: 'social_discovery_run', id: run.runId, version: 1 }]);
                            report.blocked++;
                        }
                    }
                    else {
                        const completeEmpty = run.status === 'stopped' && socialObject(socialObject(run.scopeSnapshot)?.weeklyProducer)?.completeEmptyVerified === true && Object.values(run.modeStats).every(s => s?.fetched === 0 && s.failed === 0 && s.requested > 0);
                        await save(completeEmpty ? 'no_data' : 'blocked', completeEmpty ? 'weekly_preproduction_no_data' : run.stopReason === 'source_failed' ? discoveryRunFailureCode(run) : run.stopReason ?? 'weekly_preproduction_collection_incomplete');
                        if (completeEmpty)
                            report.noData++;
                        else
                            report.blocked++;
                    }
                }
            });
        }
        catch (error) {
            report.failed++;
            report.failures.push({ jobId: row.id, code: error instanceof Error ? error.message : 'weekly_preproduction_failed' });
        }
    }
    return report;
}
/** Read-only exact original-consumer gate; never authorizes planning dispatch. */
export async function readWeeklyPreproductionExecutionGate(store: DataStore, task: WeeklyExecutionTask, exactAnalysisPortsForRun?:WeeklyExactSettlementPortsForRun): Promise<{
    ready: boolean;
    code: string | null;
    resultRefs: VersionedSocialRef[];
    jobId?:string;
    originalRunKey?:string;
    retryParentRunId?:string;
    producerStatus?:PreproductionStatus;
}> {
    const kind = task.schedule.stepKind === 'business_outline' ? 'outline' : task.schedule.stepKind === 'benchmark_collection' ? 'discovery' : null;
    if (!kind)
        return { ready: true, code: null, resultRefs: [] };
    const records = await all(store, WEEKLY_PREPRODUCTION_JOBS, { tenant_id: task.tenantId, program_id: task.programId, package_id: task.packageId, package_version: task.packageVersion, task_id: task.taskId, kind, input_hash: supplementConsumerHash(task) });
    if (records.length !== 1)
        return { ready: false, code: 'weekly_preproduction_authority_required', resultRefs: [] };
    const root=checked(records[0]!);
    const job=root.kind==='discovery'?(await readWeeklyPreproductionRetryAttempt(store,root)??root):root;
    await scope(store, job);
    if (job.dueAt !== (task.schedule.latestStartAt || task.schedule.estimatedStartAt))
        return { ready: false, code: 'weekly_preproduction_consumer_changed', resultRefs: [] };
    const identity={jobId:job.jobId,originalRunKey:job.originalRunKey,producerStatus:job.status,...((job as WeeklyPreproductionRetryAttempt).retry?{retryParentRunId:(job as WeeklyPreproductionRetryAttempt).retry.parentRunId}:{})};
    if(kind==='discovery'&&job===root&&job.status!=='succeeded'){const recovery=await readWeeklyAccountCollectionRecovery(store,job);if(recovery)return {ready:false,code:recovery.code,resultRefs:[],...identity};}
    if (job.status !== 'succeeded')
        return { ready: false, code: job.code ?? 'weekly_preproduction_pending', resultRefs: [],...identity };
    if(kind==='outline'){const ref=job.resultRefs.find(r=>r.type==='operating_authority_snapshot');if(!ref)throw Error('weekly_preproduction_outline_evidence_missing');const snapshot=await createSocialOperatingOrchestrationService(store).getSnapshot(job.tenantId,job.programId,ref.id,ref.version);await assertOutlineProof(store,job,snapshot);}
    if (kind === 'outline' && await facts(store, job.tenantId) !== job.sourceHash)
        return { ready: false, code: 'weekly_preproduction_facts_changed', resultRefs: [] };
    if (kind === 'discovery') {
        const a = job.authority;
        if (!a)
            return { ready: false, code: 'weekly_preproduction_discovery_authority_required', resultRefs: [] };
        const r = await store.getById<DiscoveryScopeRecord>('social_discovery_scopes', a.scopeId);
        if (!r || r.tenant_id !== job.tenantId || r.status !== 'active' || r.version !== a.scopeVersion || socialRequestHash(r.payload) !== a.scopeHash)
            return { ready: false, code: 'weekly_preproduction_scope_changed', resultRefs: [] };
    }
    if (kind === 'discovery') {
        const authority=job.authority;if(!authority)throw Error('weekly_preproduction_discovery_authority_required');
        const ref = job.resultRefs.find(r => r.type === 'social_discovery_run');
        if (!ref)
            throw Error('weekly_preproduction_collection_evidence_missing');
        const run = await unique(store, 'social_discovery_runs', { tenant_id: job.tenantId, runId: ref.id });
        const reassessmentRef=job.resultRefs.find(r=>r.type==='social_discovery_candidate_reassessment');
        const reassessment=reassessmentRef?await readWeeklyCandidateReassessment(store,job as WeeklyPreproductionRetryAttempt,run as unknown as import('../../shared/contracts/socialContentWorkflow.js').SocialInspirationCollectionRun,reassessmentRef):null;
        if ((!reassessment&&!['succeeded','partial'].includes(String(run.status))) || run.discoveryScopeId !== authority.scopeId || run.discoveryScopeVersion !== authority.scopeVersion || job.collectionEvidenceHash !== socialRequestHash({ modeStats: run.modeStats, evidenceOutcomes: run.evidenceOutcomes, scopeSnapshot: run.scopeSnapshot,...(reassessmentRef?{reassessmentRef}:{}) }))
            return { ready: false, code: 'weekly_preproduction_collection_evidence_changed', resultRefs: [] };
        const planning = await createWeeklyPlanningAuthority(store).get(job.tenantId, job.programId, job.packageId, job.packageVersion);
        const {pkg}=await scope(store,job);
        const externalReferencesNeeded=!pkg.referenceSourcePolicy||[...allocateWeeklyReferenceSources(pkg.socialContentPackage.publicationTasks,pkg.referenceSourcePolicy).values()].includes('external');
        if(pkg.socialContentPackage.originalContentTarget>=5&&externalReferencesNeeded){
            try{
                const rootId=(job as WeeklyPreproductionRetryAttempt).retry?.rootJobId??job.jobId;
                const rootRow=await unique(store,WEEKLY_PREPRODUCTION_JOBS,{tenant_id:job.tenantId,program_id:job.programId,package_id:job.packageId,package_version:job.packageVersion,id:rootId});
                const admitted=await readWeeklyQualifiedDirectorAdmission({store,rootJob:checked(rootRow),job,run:run as unknown as SocialInspirationCollectionRun,mediaRoot:fileURLToPath(new URL('../../data/media',import.meta.url)),exactAnalysisPortsForRun});
                const chosen=new Set(planning.directorAnalyses.flatMap(analysis=>analysis.benchmarkVideoRefs.map(ref=>ref.id)));
                if(admitted.candidateIds.length<5||chosen.size<5||[...chosen].some(id=>!admitted.candidateIds.includes(id)))return {ready:false,code:'weekly_qualified_admission_unverified',resultRefs:[]};
            }catch{return {ready:false,code:'weekly_qualified_admission_unverified',resultRefs:[]};}
        }
        const weeklyEvidence=await weeklyDiscoveryLineageEvidence(store,job,run as unknown as SocialInspirationCollectionRun,reassessment?.evidenceOutcomes??run.evidenceOutcomes);
        await assertPlanningCollection(store,job,planning,{evidenceOutcomes:{weeklyLineage:weeklyEvidence}});
        if (!planning.detailedSchedule || job.planningEvidenceHash !== socialRequestHash({ directorAnalyses: planning.directorAnalyses, detailedSchedule: planning.detailedSchedule }))
            return { ready: false, code: 'weekly_preproduction_planning_evidence_changed', resultRefs: [] };
    }
    return { ready: true, code: null, resultRefs: job.resultRefs,...identity };
}
async function recoverConsumer(store: DataStore, job: WeeklyPreproductionJob, assert: () => Promise<void>, exactAnalysisPortsForRun?:WeeklyExactSettlementPortsForRun) {
    const { task } = await scope(store, job);
    if (task.status !== 'blocked' || task.lease)
        return;
    if (supplementConsumerHash(task) !== job.consumerInputHash || job.dueAt !== (task.schedule.latestStartAt || task.schedule.estimatedStartAt))
        throw Error('weekly_preproduction_consumer_changed');
    const gate = await readWeeklyPreproductionExecutionGate(store, task, exactAnalysisPortsForRun);
    if (!gate.ready)
        return;
    for (const reason of task.ownBlockingReasons.filter(reason => reason.startsWith('weekly_preproduction_'))) {
        await assert();
        await createWeeklyExecutionTaskService(store).unblock(job.tenantId, job.programId, job.packageId, job.consumerTaskId, reason);
    }
}

/** The discovery service returns the domain run, while DataStore adds row
 * metadata such as id and tenant_id. Compare every domain field before
 * continuing; row metadata must not make an identical run look changed. */
const discoveryRunFields:ReadonlyArray<keyof SocialInspirationCollectionRun>=[
 'runId','planId','keywordSetId','keywordSetVersion','discoveryScopeId','discoveryScopeVersion',
 'status','triggerType','scopeSnapshot','modeStats','platformStats','keywordTierStats',
 'evidenceOutcomes','sourceRunRefs','failureDetails','queryBasis','market','language',
 'stopReason','startedAt','finishedAt','error'];
function weeklyDiscoveryRunPayloadHash(run:SocialInspirationCollectionRun):string{
 return socialRequestHash(Object.fromEntries(discoveryRunFields.map(key=>[key,run[key]])));
}

/** A continuation's accepted IDs include its parents. Verify the entire
 * immutable chain before doing local analysis, then give each run only its
 * own candidates. A parent with fewer than five metadata accepts has not
 * been analyzed yet, so passing the union to the child loses that work. */
export async function advanceWeeklyCandidatePostAnalysisChain(input:{store:DataStore;rootJob:WeeklyPreproductionJob;job:WeeklyPreproductionJob|WeeklyPreproductionRetryAttempt;run:SocialInspirationCollectionRun;pkg:WeeklyOperatingPackage;mediaRoot:string;acceptedCandidateIds:string[];exactAnalysisPorts?:NonNullable<Parameters<typeof advanceWeeklyCandidatePostAnalysis>[0]['exactAnalysisPorts']>;exactAnalysisPortsForRun?:(job:WeeklyPreproductionJob|WeeklyPreproductionRetryAttempt,run:SocialInspirationCollectionRun)=>Promise<NonNullable<Parameters<typeof advanceWeeklyCandidatePostAnalysis>[0]['exactAnalysisPorts']>|null>;canonicalMedia?:NonNullable<Parameters<typeof advanceWeeklyCandidatePostAnalysis>[0]['canonicalMedia']>;advance?:typeof advanceWeeklyCandidatePostAnalysis}){
 const {store,rootJob}=input,rootRunId=`weekly_discovery_${socialRequestHash({tenantId:rootJob.tenantId,key:rootJob.originalRunKey})}`;
 const chain:Array<{job:WeeklyPreproductionJob|WeeklyPreproductionRetryAttempt;run:SocialInspirationCollectionRun;ids:string[]}>=[],seenRuns=new Set<string>(),seenCandidates=new Set<string>();
 let job=input.job,run=input.run;
 for(let depth=0;depth<10;depth++){
  if(seenRuns.has(run.runId)||job.tenantId!==rootJob.tenantId||job.programId!==rootJob.programId||job.packageId!==rootJob.packageId||job.packageVersion!==rootJob.packageVersion||job.consumerTaskId!==rootJob.consumerTaskId||job.authority?.scopeId!==rootJob.authority?.scopeId||job.authority?.scopeVersion!==rootJob.authority?.scopeVersion)throw Error('weekly_postanalysis_chain_invalid');
  seenRuns.add(run.runId);
  const persisted=await all(store,'social_discovery_runs',{tenant_id:rootJob.tenantId,runId:run.runId});
  if(persisted.length!==1||weeklyDiscoveryRunPayloadHash(persisted[0] as unknown as SocialInspirationCollectionRun)!==weeklyDiscoveryRunPayloadHash(run))throw Error('weekly_postanalysis_chain_run_changed');
  run=persisted[0] as unknown as SocialInspirationCollectionRun;
  const ids=[...new Set(Object.values(socialObject(run.evidenceOutcomes)??{}).flatMap(value=>{
   const outcome=socialObject(value);return Array.isArray(outcome?.acceptedCandidateIds)?outcome.acceptedCandidateIds.filter((id):id is string=>typeof id==='string'):[];
  }))];
  for(const id of ids){if(seenCandidates.has(id))throw Error('weekly_postanalysis_chain_candidate_reused');seenCandidates.add(id);}
  chain.push({job,run,ids});
  const marker=socialObject((socialObject((socialObject(run.scopeSnapshot)??{}).weeklyProducer)??{}).retry)??{};
  const parentId=typeof marker.parentRunId==='string'?marker.parentRunId:null;
  if(!parentId){if(run.runId!==rootRunId||job.jobId!==rootJob.jobId)throw Error('weekly_postanalysis_chain_root_changed');break;}
  const child=job as WeeklyPreproductionRetryAttempt;
  if(child.retry?.parentRunId!==parentId||child.retry.parentRunHash!==marker.parentRunHash||child.retry.rootJobId!==rootJob.jobId||child.retry.rootJobHash!==rootJob.recordHash)throw Error('weekly_postanalysis_chain_attempt_changed');
  const parents=await all(store,'social_discovery_runs',{tenant_id:rootJob.tenantId,runId:parentId});
  if(parents.length!==1||socialRequestHash(parents[0])!==marker.parentRunHash)throw Error('weekly_postanalysis_chain_parent_changed');
  const parent=parents[0] as unknown as SocialInspirationCollectionRun;
  if(parentId===rootRunId)job=rootJob;
  else{
   const parentKey=(socialObject(parent.scopeSnapshot)?.weeklyProducer as {key?:string}|undefined)?.key;
   const rows=await all(store,PREPRODUCTION_RETRY_ATTEMPTS,{tenant_id:rootJob.tenantId,program_id:rootJob.programId,package_id:rootJob.packageId,package_version:rootJob.packageVersion,root_job_id:rootJob.jobId});
   const matches=rows.filter(row=>(row.payload as WeeklyPreproductionRetryAttempt)?.originalRunKey===parentKey);
   if(matches.length!==1)throw Error('weekly_postanalysis_chain_parent_attempt_missing');
   job=matches[0]!.payload as WeeklyPreproductionRetryAttempt;
   if(matches[0]!.record_hash!==job.recordHash||job.recordHash!==socialRequestHash({...job,recordHash:''}))throw Error('weekly_postanalysis_chain_parent_attempt_changed');
  }
  run=parent;
  if(depth===9)throw Error('weekly_postanalysis_chain_attempt_limit');
 }
 if(seenCandidates.size!==input.acceptedCandidateIds.length||input.acceptedCandidateIds.some(id=>!seenCandidates.has(id)))throw Error('weekly_postanalysis_chain_accepted_changed');
 const advance=input.advance??advanceWeeklyCandidatePostAnalysis;
 for(const item of chain.reverse())if(item.ids.length)await advance({store,job:item.job,run:item.run,pkg:input.pkg,mediaRoot:input.mediaRoot,acceptedCandidateIds:item.ids,exactAnalysisPorts:input.exactAnalysisPortsForRun?await input.exactAnalysisPortsForRun(item.job,item.run)??undefined:input.exactAnalysisPorts,canonicalMedia:input.canonicalMedia});
}

/** Read all settled attempts in one immutable current-week chain. Discovery
 * acceptance is deliberately not part of this return value: only the exact
 * post-analysis admission for the current package/version can fill a mother. */
export async function readWeeklyQualifiedDirectorAdmission(input:{store:DataStore;rootJob:WeeklyPreproductionJob;job:WeeklyPreproductionJob|WeeklyPreproductionRetryAttempt;run:SocialInspirationCollectionRun;mediaRoot:string;readSnapshot?:typeof readWeeklyCandidateAdmissionSnapshot;transferabilityPorts?:NonNullable<Parameters<typeof readWeeklyCandidateAdmissionSnapshot>[0]['transferabilityPorts']>;exactAnalysisPorts?:NonNullable<Parameters<typeof readWeeklyCandidateAdmissionSnapshot>[0]['exactAnalysisPorts']>;exactAnalysisPortsForRun?:(job:WeeklyPreproductionJob|WeeklyPreproductionRetryAttempt,run:SocialInspirationCollectionRun)=>Promise<NonNullable<Parameters<typeof readWeeklyCandidateAdmissionSnapshot>[0]['exactAnalysisPorts']>|null>}){
 const {store,rootJob,mediaRoot}=input,readSnapshot=input.readSnapshot??readWeeklyCandidateAdmissionSnapshot;
 const rootRunId=`weekly_discovery_${socialRequestHash({tenantId:rootJob.tenantId,key:rootJob.originalRunKey})}`;
 const candidates=new Map<string,WeeklyQualifiedCandidate>(),runIds:string[]=[],seen=new Set<string>(),accountTargets=new Set<string>();
 let job:WeeklyPreproductionJob|WeeklyPreproductionRetryAttempt=input.job,run=input.run;
 for(let depth=0;depth<10;depth++){
  if(seen.has(run.runId)||job.tenantId!==rootJob.tenantId||job.programId!==rootJob.programId||job.packageId!==rootJob.packageId||job.packageVersion!==rootJob.packageVersion||job.consumerTaskId!==rootJob.consumerTaskId||job.authority?.scopeId!==rootJob.authority?.scopeId||job.authority?.scopeVersion!==rootJob.authority?.scopeVersion)throw Error('weekly_qualified_director_lineage_invalid');
  seen.add(run.runId);runIds.push(run.runId);
  const persisted=await all(store,'social_discovery_runs',{tenant_id:rootJob.tenantId,runId:run.runId});
  if(persisted.length!==1||persisted[0]!.status!==run.status||socialRequestHash(persisted[0]!.evidenceOutcomes)!==socialRequestHash(run.evidenceOutcomes))throw Error('weekly_qualified_director_run_changed');
  run=persisted[0] as unknown as SocialInspirationCollectionRun;
  accountTargets.add(socialRequestHash(socialObject(socialObject(run.scopeSnapshot)?.weeklyAccountCollectionTarget)??null));
  const exactAnalysisPorts=input.exactAnalysisPortsForRun?await input.exactAnalysisPortsForRun(job,run)??undefined:input.exactAnalysisPorts;
  const observed=await readSnapshot({store,job,run,mediaRoot,...(input.transferabilityPorts?{transferabilityPorts:input.transferabilityPorts}:{}),...(exactAnalysisPorts?{exactAnalysisPorts}:{})});
  for(const item of observed){const prior=candidates.get(item.candidateId);if(prior&&socialRequestHash(prior)!==socialRequestHash(item))throw Error('weekly_qualified_director_candidate_changed');candidates.set(item.candidateId,item);}
  const marker=socialObject((socialObject((socialObject(run.scopeSnapshot)??{}).weeklyProducer)??{}).retry)??{};
  const parentId=typeof marker.parentRunId==='string'?marker.parentRunId:null;
  if(!parentId){if(run.runId!==rootRunId||job.jobId!==rootJob.jobId)throw Error('weekly_qualified_director_root_changed');break;}
  const child=job as WeeklyPreproductionRetryAttempt;
  if(child.retry?.parentRunId!==parentId||child.retry.parentRunHash!==marker.parentRunHash||child.retry.rootJobId!==rootJob.jobId||child.retry.rootJobHash!==rootJob.recordHash)throw Error('weekly_qualified_director_attempt_changed');
  const parents=await all(store,'social_discovery_runs',{tenant_id:rootJob.tenantId,runId:parentId});
  if(parents.length!==1||socialRequestHash(parents[0])!==marker.parentRunHash)throw Error('weekly_qualified_director_parent_changed');
  const parent=parents[0] as unknown as SocialInspirationCollectionRun;
  if(parentId===rootRunId)job=rootJob;
  else{
   const parentKey=(socialObject(parent.scopeSnapshot)?.weeklyProducer as {key?:string}|undefined)?.key;
   const rows=await all(store,PREPRODUCTION_RETRY_ATTEMPTS,{tenant_id:rootJob.tenantId,program_id:rootJob.programId,package_id:rootJob.packageId,package_version:rootJob.packageVersion,root_job_id:rootJob.jobId});
   const matches=rows.filter(row=>(row.payload as WeeklyPreproductionRetryAttempt)?.originalRunKey===parentKey);
   if(matches.length!==1)throw Error('weekly_qualified_director_parent_attempt_missing');
   job=matches[0]!.payload as WeeklyPreproductionRetryAttempt;
   if(matches[0]!.record_hash!==job.recordHash||job.recordHash!==socialRequestHash({...job,recordHash:''}))throw Error('weekly_qualified_director_parent_attempt_changed');
  }
  run=parent;
  if(depth===9)throw Error('weekly_qualified_director_attempt_limit');
 }
 // The root run freezes the user-approved five-from-one-account revision.
 // Other admitted weekly candidates remain useful inventory, but cannot fill
 // this account-specific director assignment.
 if(accountTargets.size!==1)throw Error('weekly_qualified_director_account_target_changed');
 const accountTarget=socialObject(socialObject(run.scopeSnapshot)?.weeklyAccountCollectionTarget);
 const requiredAccount=accountTarget?.targetCount===5&&typeof accountTarget.accountUrl==='string'?accountTarget.accountUrl:null;
 const accepted=[...candidates.values()].filter(item=>item.postAdmission==='accepted'&&(!requiredAccount||item.accountId===requiredAccount));
 if(accepted.some(item=>!item.evidenceRef||!item.exactHandoffRef||!item.accountId))throw Error('weekly_qualified_director_evidence_incomplete');
 return {candidateIds:accepted.map(item=>item.candidateId).sort(),candidates:[...candidates.values()],runIds};
}

async function weeklyDiscoveryLineageEvidence(store:DataStore,job:WeeklyPreproductionJob,run:SocialInspirationCollectionRun,currentOutcomes:unknown){
 const acceptedCandidateIds=new Set<string>(),acceptedEvidenceRefs=new Set<string>(),observedCandidateIds=new Set<string>(),visited=new Set<string>();
 let current:SocialInspirationCollectionRun|null=run,outcomes:unknown=currentOutcomes;
 for(let depth=0;current&&depth<32;depth++){
  const active:SocialInspirationCollectionRun=current;
  if(visited.has(active.runId)||active.discoveryScopeId!==job.authority?.scopeId||active.discoveryScopeVersion!==job.authority.scopeVersion)throw Error('weekly_preproduction_discovery_lineage_invalid');
  visited.add(active.runId);
  for(const value of Object.values(socialObject(outcomes)??{})){const o=socialObject(value)??{};for(const id of Array.isArray(o.acceptedCandidateIds)?o.acceptedCandidateIds:[])if(typeof id==='string'){acceptedCandidateIds.add(id);observedCandidateIds.add(id);}for(const id of Array.isArray(o.suggestionCandidateIds)?o.suggestionCandidateIds:[])if(typeof id==='string')observedCandidateIds.add(id);for(const id of Array.isArray(o.failedCandidateIds)?o.failedCandidateIds:[])if(typeof id==='string')observedCandidateIds.add(id);for(const ref of Array.isArray(o.acceptedEvidenceRefs)?o.acceptedEvidenceRefs:[])if(typeof ref==='string')acceptedEvidenceRefs.add(ref);}
  const retry:Record<string,unknown>=socialObject((socialObject((socialObject(active.scopeSnapshot)??{}).weeklyProducer)??{}).retry)??{};
  const parentId:string|null=typeof retry.parentRunId==='string'?retry.parentRunId:null;
  if(!parentId)return {acceptedCandidateIds:[...acceptedCandidateIds],acceptedEvidenceRefs:[...acceptedEvidenceRefs],observedCandidateIds:[...observedCandidateIds].sort()};
  const rows:Awaited<ReturnType<DataStore['list']>>=await store.list<SocialInspirationCollectionRun>('social_discovery_runs',{where:{tenant_id:job.tenantId,runId:parentId},perPage:2});
  if(rows.totalItems!==1||rows.items.length!==1||socialRequestHash(rows.items[0])!==retry.parentRunHash)throw Error('weekly_preproduction_discovery_lineage_invalid');
  current=rows.items[0] as SocialInspirationCollectionRun;outcomes=current.evidenceOutcomes;
 }
 throw Error('weekly_preproduction_discovery_lineage_limit');
}

async function assertPlanningCollection(store:DataStore,job:WeeklyPreproductionJob,planning:import('../../shared/contracts/socialProgram.js').WeeklyAgentPlanningState,run:{evidenceOutcomes?:unknown}){
 const outcomes=socialObject(run.evidenceOutcomes);const ids=new Set<string>(),refs=new Set<string>();for(const value of Object.values(outcomes??{})){const o=socialObject(value);for(const id of Array.isArray(o?.acceptedCandidateIds)?o.acceptedCandidateIds:[])if(typeof id==='string')ids.add(id);for(const ref of Array.isArray(o?.acceptedEvidenceRefs)?o.acceptedEvidenceRefs:[])if(typeof ref==='string')refs.add(ref);}
 for(const analysis of planning.directorAnalyses){const slot=planning.skeleton.slots.find(s=>s.slotId===analysis.slotId);if(!slot)throw Error('weekly_preproduction_analysis_source_mismatch');
 if(slot.referenceSource==='owned'){if(!analysis.targetAccountPlaybooks?.length||analysis.targetAccountPlaybooks.some(a=>!slot.accountIds.includes(a.accountId)))throw Error('weekly_preproduction_analysis_source_mismatch');continue;}
 if(!analysis.benchmarkVideoRefs.length)throw Error('weekly_preproduction_analysis_source_mismatch');for(const video of analysis.benchmarkVideoRefs){if(!ids.has(video.id))throw Error('weekly_preproduction_analysis_source_mismatch');const evidence=await all(store,'social_candidate_evidence',{tenant_id:job.tenantId,candidateId:video.id,version:video.version});if(evidence.length!==1||!refs.has(`${evidence[0]!.evidenceId}@${video.version}`)||!analysis.benchmarkEvidenceRefs.includes(String(evidence[0]!.evidenceId)))throw Error('weekly_preproduction_analysis_source_mismatch');}
 }
}

async function assertOutlineProof(store:DataStore,job:WeeklyPreproductionJob,snapshot:import('../../shared/contracts/socialOperatingDecision.js').OperatingAuthoritySnapshot){
 const{pkg}=await scope(store,job);if(snapshot.programId!==job.programId||snapshot.planningWeekStart!==pkg.weekStart)throw Error('weekly_preproduction_outline_source_mismatch');await member(store,job.tenantId,snapshot.createdBy);
 const pr=await unique(store,'tenant_profiles',{tenant_id:job.tenantId}),p=parse<EnterpriseProfile>(pr.profile);
 const statements=[p.company?.description,p.brand?.usp,p.products?.highlights,p.products?.certifications,...(p.products?.items??[]).flatMap(v=>[v.name,v.highlights,v.certifications])].map(v=>String(v??'').trim().slice(0,1000)).filter(Boolean);
 const stableId=(prefix:string,value:unknown)=>`${prefix}_${createHash('sha256').update(deterministicFingerprint(value)).digest('hex').slice(0,24)}`;
 const enterprise=snapshot.enterprise;if(!enterprise||enterprise.ref.type!=='enterprise_operating_snapshot'||enterprise.ref.id!==stableId('enterprise',{tenantId:job.tenantId,programId:job.programId})||!enterprise.publicFacts.length||enterprise.publicFacts.some(f=>!statements.includes(f.statement)||f.ref.type!=='enterprise_fact'||f.ref.version!==enterprise.ref.version||f.ref.id!==stableId('fact',{enterpriseId:enterprise.ref.id,statement:f.statement})))throw Error('weekly_preproduction_outline_source_mismatch');
 const row=await unique(store,'social_business_content_goals',{tenant_id:job.tenantId,program_id:job.programId,goal_id:snapshot.businessContentGoalRef.id,version:snapshot.businessContentGoalRef.version}),goal=parse<import('../../shared/contracts/socialOperatingDecision.js').BusinessContentGoal>(row.payload);if(goal.programId!==job.programId||goal.goalId!==snapshot.businessContentGoalRef.id||goal.version!==snapshot.businessContentGoalRef.version||goal.publicFactRefs.some(r=>!enterprise.publicFacts.some(f=>socialRequestHash(f.ref)===socialRequestHash(r))))throw Error('weekly_preproduction_outline_goal_not_ready');
 const readiness=evaluateProductionOutlineReadiness(goal);if(!readiness.ready)throw Error('weekly_preproduction_outline_goal_not_ready');
 if(job.status==='succeeded'&&job.outlineReadiness&&socialRequestHash(job.outlineReadiness)!==socialRequestHash(readiness))throw Error('weekly_preproduction_outline_evidence_changed');
 // Legacy successful outlines had to reference a fully-ready commercial goal.
 if(job.status==='succeeded'&&!job.outlineReadiness&&goal.status!=='ready')throw Error('weekly_preproduction_outline_scope_evidence_required');
 return readiness;
}
