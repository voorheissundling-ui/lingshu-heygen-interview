import {socialRequestHash,socialObject,socialJson} from '../starter198/socialContentValidation.js';
import {fileURLToPath} from 'node:url';
import {collectionBusinessDate,readDailyCollectionCapacity,reserveDailyCollection,DAILY_COLLECTION_RESERVATIONS} from './dailyCollectionQuota.js';
import {assertWeeklyOriginalCrossDayFence,type WeeklyOriginalCollectionScope} from './weeklyCrossDayOriginalFence.js';
import {WEEKLY_AUTOMATION_TEMPLATE} from '../../shared/weeklyAutomationTemplate.js';
import {classifyDiscoverySourceFailure} from './sourceFailure.js';
import {readWeeklyAccountCollectionPaidBlocker} from './weeklyAccountCollectionPaidGate.js';
import {frozenWeeklyAccountFiveVideoActorInput} from './weeklyAccountCollectionBudget.js';
import {readVerifiedWeeklyOriginalDatasetReplay,type VerifiedWeeklyOriginalDatasetReplay} from './weeklyAccountCollectionDatasetContinuation.js';
import {createHash} from 'node:crypto';
import {planTerminalDiscoverySourceRetry} from './retryPlan.js';
import type {RetryGrantScope} from '../runtime/weeklyPreproductionRetryAttempts.js';
import {PREPRODUCTION_RETRY_ATTEMPTS} from '../runtime/weeklyPreproductionRetryAttempts.js';
import {WEEKLY_QUALIFIED_CONTINUATION_STAGES,readWeeklyQualifiedContinuationSubmitReadiness,type WeeklyQualifiedContinuationStage} from '../runtime/weeklyQualifiedContinuationStage.js';
import type {readWeeklyCandidateAdmissionSnapshot} from '../runtime/weeklyCandidateAdmissionSnapshot.js';
import { store } from '../storage/index.js';
import { crawlImagePostsForTenant, crawlVideosForTenant, inferPlatformFromUrl } from '../routes/videos.js';
import { dueDiscoveryModes, nextDiscoveryRunAt, validateDiscoveryBrief } from './domain.js';
import { planRollingSevenDayQuotas } from './qualityOrchestration.js';
import { normalizeSocialPlatformQuotas } from '../../shared/socialInspirationStrategy.js';
import { runCandidateEvidenceWorker, type CandidateEvidenceWorkResult } from './candidateEvidenceWorker.js';
import { createR3CandidateEvidenceAdapter, type R3CandidateEvidenceAdapter } from './r3CandidateEvidenceAdapter.js';
import type { CrawlVideosInput, CrawlVideosResult } from '../routes/videos.js';
import type { DataStore } from '../storage/datastore.js';
import type {
  SocialCrawlStrategy,
  SocialDiscoveryBrief,
  SocialDiscoveryMode,
  SocialDiscoveryModeRunStats,
  SocialInspirationCollectionRun,
} from '../../shared/contracts/socialContentWorkflow.js';

type SocialDiscoveryBriefWithQuality = SocialDiscoveryBrief & { innovationExperimentShare?: number };

export const DISCOVERY_SCOPE_COLLECTION = 'social_discovery_scopes';
export const DISCOVERY_RUN_COLLECTION = 'social_discovery_runs';

export interface ApprovedDiscoveryRunDependencies {
  dataStore: DataStore;
  crawl(input: CrawlVideosInput): Promise<CrawlVideosResult>;
  crawlImages?: typeof crawlImagePostsForTenant;
  candidateEvidenceAdapter: R3CandidateEvidenceAdapter;
  runCandidateEvidence(items: Parameters<typeof runCandidateEvidenceWorker>[0]): Promise<CandidateEvidenceWorkResult>;
  /** Isolation-only; production always uses the real persisted admission reader. */
  qualifiedCandidateReader?: typeof readWeeklyCandidateAdmissionSnapshot;
}

/** The one production composition for the already-existing discovery service.
 * It adds no spending authority: the service still enforces its current paid
 * gate before `crawl` for an account-only five-video run. */
export function createDefaultApprovedDiscoveryRunDependencies(dataStore:DataStore=store):ApprovedDiscoveryRunDependencies{return {
  dataStore,
  crawl: crawlVideosForTenant,
  crawlImages: crawlImagePostsForTenant,
  candidateEvidenceAdapter: createR3CandidateEvidenceAdapter(),
  runCandidateEvidence: runCandidateEvidenceWorker,
};}
const defaultDependencies: ApprovedDiscoveryRunDependencies = createDefaultApprovedDiscoveryRunDependencies();

function emptyStats(): SocialDiscoveryModeRunStats {
  return { requested: 0, fetched: 0, deduplicated: 0, accepted: 0, momentumCandidates: 0, failed: 0, costCny: null, effectiveRate: null };
}

function addStats(target: SocialDiscoveryModeRunStats, value: Partial<SocialDiscoveryModeRunStats>): void {
  target.requested += value.requested ?? 0;
  target.fetched += value.fetched ?? 0;
  target.deduplicated += value.deduplicated ?? 0;
  if(value.exactDuplicates!==undefined)target.exactDuplicates=(target.exactDuplicates??0)+value.exactDuplicates;
  if(value.nearDuplicates!==undefined)target.nearDuplicates=(target.nearDuplicates??0)+value.nearDuplicates;
  if(value.nearDuplicateUnchecked!==undefined)target.nearDuplicateUnchecked=(target.nearDuplicateUnchecked??0)+value.nearDuplicateUnchecked;
  if(value.analyzed!==undefined)target.analyzed=(target.analyzed??0)+value.analyzed;
  target.accepted += value.accepted ?? 0;
  target.momentumCandidates += value.momentumCandidates ?? 0;
  target.failed += value.failed ?? 0;
  target.effectiveRate = target.fetched > 0 ? target.accepted / target.fetched : null;
}

function keywordTier(scope: DiscoveryScopeRecord, mode: SocialDiscoveryMode, ref: string): 'broad' | 'medium' | 'evidence' | 'account' | 'unknown' {
  if (mode === 'account' || /^https?:\/\//i.test(ref)) return 'account';
  const category = scope.payload.keywords.find(item => item.values.includes(ref))?.category;
  if (category === 'discovery_seed') return 'broad';
  if (category === 'scene_cluster') return 'medium';
  if (category === 'evidence_query' || category === 'task_override') return 'evidence';
  return 'unknown';
}

export type DiscoveryScopeRecord = {
  id: string;
  tenant_id: string;
  keyword_set_id: string;
  version: number;
  status: 'active' | 'retired';
  payload: SocialCrawlStrategy;
  created_by: string;
  created_at: string;
  updated_at: string;
};

export async function loadActiveDiscoveryScope(tenantId: string): Promise<DiscoveryScopeRecord | null> {
  const result = await store.list<DiscoveryScopeRecord>(DISCOVERY_SCOPE_COLLECTION, {
    where: { tenant_id: tenantId, status: 'active' }, sort: '-updated_at', page: 1, perPage: 1,
  });
  return result.items[0] ?? null;
}

function modeRefs(scope: DiscoveryScopeRecord, mode: SocialDiscoveryMode): string[] {
  const brief = scope.payload.discoveryBrief;
  const policy = brief.modePolicies?.[mode];
  if (policy?.sourceRefs.length) return policy.sourceRefs;
  if (mode === 'account') return brief.competitorAccounts;
  if (mode === 'innovation' && brief.productionGap) return [brief.productionGap];
  return scope.payload.keywords
    .filter(item => mode === 'momentum'
      ? item.category === 'discovery_seed' || item.category === 'scene_cluster'
      : item.category === 'evidence_query')
    .flatMap(item => item.values);
}

export async function executeApprovedDiscoveryRun(input: {
  tenantId: string;
  triggerType: 'scheduled' | 'manual' | 'production_gap';
  requestedModes?: SocialDiscoveryMode[];
  originalRun?:{key:string;scopeHash:string;recoveryOnly?:boolean;weeklyScope?:WeeklyOriginalCollectionScope};
  /** Read-only replay of a wallet-settled original Dataset; never authorizes a provider request. */
  originalDatasetReplay?:VerifiedWeeklyOriginalDatasetReplay;
  retry?:{parentRunId:string;parentRunHash:string;sourceSelection:Array<{mode:SocialDiscoveryMode;platform:string;queryRef:string}>;authorization?:import('../runtime/weeklyPreproductionRetryAttempts.js').RetryAuthorization;/** v1 compatibility */grant?:RetryGrantScope;kind?:'qualified_continuation';continuationStageId?:string};
  now?:Date;
  expectedScopeId?: string;
  expectedScopeVersion?: number;
  productionGapContext?: {
    gapTaskId: string;
    upstreamTaskRef: string;
    description: string;
    remainingBudgetCny: number;
  };
}, dependencies: ApprovedDiscoveryRunDependencies = defaultDependencies): Promise<{ run?: SocialInspirationCollectionRun; skipped?: true; reason?: string; nextRunAt?: string | null }> {
  if (input.triggerType === 'production_gap' && !input.productionGapContext) throw new Error('production_gap_context_required');
  const scopeResult = await dependencies.dataStore.list<DiscoveryScopeRecord>(DISCOVERY_SCOPE_COLLECTION, {
    where: { tenant_id: input.tenantId, status: 'active' }, sort: '-updated_at', page: 1, perPage: 1,
  });
  const scope = scopeResult.items[0] ?? null;
  if (!scope) throw new Error('discovery_scope_not_found');
  if (input.expectedScopeId && input.expectedScopeId !== scope.id) return { skipped: true, reason: 'discovery_scope_superseded' };
  if (input.expectedScopeVersion && input.expectedScopeVersion !== scope.version) return { skipped: true, reason: 'discovery_scope_version_superseded' };
  if (scope.payload.approval?.status !== 'approved' || scope.payload.approval.scopeVersion !== scope.version) {
    throw new Error('discovery_scope_not_approved');
  }

  const originalId=input.originalRun?`weekly_discovery_${socialRequestHash({tenantId:input.tenantId,key:input.originalRun.key})}`:null;
  if(input.retry){
    if(!input.originalRun||!input.retry.sourceSelection.length)throw Error('weekly_discovery_retry_identity_required');
    const parents=await dependencies.dataStore.list<SocialInspirationCollectionRun & {tenant_id:string}>(DISCOVERY_RUN_COLLECTION,{where:{tenant_id:input.tenantId,runId:input.retry.parentRunId},perPage:2});
    if(parents.totalItems!==1||parents.items.length!==1||socialRequestHash(parents.items[0])!==input.retry.parentRunHash)throw Error('weekly_discovery_retry_parent_changed');
    const parent=parents.items[0]!,plan=input.retry.kind==='qualified_continuation'?null:planTerminalDiscoverySourceRetry(parent);
    if(input.retry.kind==='qualified_continuation'){
      const stageRow=await dependencies.dataStore.getById<{record_hash:string;payload:WeeklyQualifiedContinuationStage}>(WEEKLY_QUALIFIED_CONTINUATION_STAGES,input.retry.continuationStageId??''),stage=stageRow?.payload;
      const attempts=await dependencies.dataStore.list<{record_hash:string;payload:{jobId:string;recordHash:string;originalRunKey:string;retry?:{kind?:string;continuationStageId?:string;parentRunHash?:string}}}>(PREPRODUCTION_RETRY_ATTEMPTS,{where:{tenant_id:input.tenantId,original_run_key:input.originalRun.key},perPage:2});
      const attempt=attempts.items[0]?.payload;
      if(!stage||stageRow?.record_hash!==stage.recordHash||stage.recordHash!==socialRequestHash({...stage,recordHash:''})||stage.stageId!==input.retry.continuationStageId||stage.tenantId!==input.tenantId||stage.parentRunId!==parent.runId||stage.parentRunHash!==input.retry.parentRunHash||stage.scopeId!==input.expectedScopeId||stage.scopeVersion!==input.expectedScopeVersion||stage.scopeHash!==input.originalRun.scopeHash||stage.minimumIntervalMs!==300000||stage.authorizesExecution!==false||stage.grantsAdditionalDailyQuota!==false||input.retry.sourceSelection.length!==1||socialRequestHash(input.retry.sourceSelection[0])!==socialRequestHash({mode:stage.source.mode,platform:stage.source.platform,queryRef:stage.source.queryRef})||attempts.totalItems!==1||!attempt||attempt.recordHash!==attempts.items[0]!.record_hash||attempt.recordHash!==socialRequestHash({...attempt,recordHash:''})||attempt.retry?.kind!=='qualified_continuation'||attempt.retry.continuationStageId!==stage.stageId||attempt.retry.parentRunHash!==stage.parentRunHash)throw Error('weekly_discovery_qualified_continuation_unverified');
    }else{
      if(!plan||plan.scopeId!==input.expectedScopeId||plan.scopeVersion!==input.expectedScopeVersion)throw Error('weekly_discovery_retry_scope_changed');
      if(plan.blockingCodes.length||input.retry.sourceSelection.some(source=>!plan.eligibleSources.some(s=>socialRequestHash(s)===socialRequestHash(source))))throw Error('weekly_discovery_retry_source_unsettled');
    }
    const authorization=input.retry.authorization??(input.retry.grant?{kind:'explicit_grant' as const,grant:input.retry.grant}:null);
    if(!authorization)throw Error('weekly_discovery_retry_authorization_required');
    if(authorization.kind==='explicit_grant'&&(authorization.grant.parentRunId!==input.retry.parentRunId||authorization.grant.parentRunHash!==input.retry.parentRunHash))throw Error('weekly_discovery_retry_grant_scope_invalid');
  }
  const originalHash=input.originalRun?socialRequestHash({tenantId:input.tenantId,key:input.originalRun.key,scopeId:input.expectedScopeId,scopeVersion:input.expectedScopeVersion,scopeHash:input.originalRun.scopeHash,modes:input.requestedModes,triggerType:input.triggerType,productionGapContext:input.productionGapContext,...(input.retry?{retry:input.retry}:{})}):null;
  let weeklyRootScope:WeeklyOriginalCollectionScope|undefined;
  if(input.originalRun){
    if(!input.originalRun.key||!input.expectedScopeId||!input.expectedScopeVersion||socialRequestHash(scope.payload)!==input.originalRun.scopeHash)throw Error('weekly_discovery_frozen_scope_changed');
    const prior=await dependencies.dataStore.list<SocialInspirationCollectionRun & {id:string;tenant_id:string}>(DISCOVERY_RUN_COLLECTION,{where:{tenant_id:input.tenantId,runId:originalId!},perPage:2});
    if(prior.totalItems>1||prior.items.length!==prior.totalItems)throw Error('weekly_discovery_original_not_unique');
    if(prior.items[0]){
      let run=prior.items[0],marker=socialObject(socialObject(socialJson(run.scopeSnapshot))?.weeklyProducer);
      if(run.tenant_id!==input.tenantId||run.discoveryScopeId!==input.expectedScopeId||run.discoveryScopeVersion!==input.expectedScopeVersion||marker?.inputHash!==originalHash)throw Error('weekly_discovery_original_scope_changed');
      // A process can stop after the durable running marker is written but
      // before a provider receipt is persisted. Recovery must never resubmit
      // that paid call, but it also must not leave the weekly package pending
      // forever. A recent marker may still belong to a live worker; an old one
      // is closed with an explicit, auditable interruption outcome.
      if(input.originalDatasetReplay){
        const replay=readVerifiedWeeklyOriginalDatasetReplay(input.originalDatasetReplay),priorProducer=socialObject(socialObject(socialJson(run.scopeSnapshot))?.weeklyProducer);
        if(['succeeded','partial','stopped'].includes(run.status)&&priorProducer?.originalDatasetDigest===replay.digest&&priorProducer?.originalDatasetProviderRunId===replay.providerRunId&&priorProducer?.originalDatasetId===replay.datasetId)return {run};
        const replayableAdapterFailure=run.status==='failed'&&run.stopReason==='source_failed'&&
          run.error===`tiktok/${(scope.payload as typeof scope.payload&{weeklyAccountRevision?:{accountUrl?:string}}).weeklyAccountRevision?.accountUrl}: weekly_preproduction_collection_original_transport_required`&&
          run.sourceRunRefs.length===0&&Object.values(run.evidenceOutcomes??{}).every(outcome=>
            (outcome.acceptedCandidateIds?.length??0)===0&&(outcome.suggestionCandidateIds?.length??0)===0&&(outcome.failedCandidateIds?.length??0)===0)&&
          run.failureDetails?.length===1&&run.failureDetails[0]?.error==='weekly_preproduction_collection_original_transport_required';
        if((run.status!=='running'&&!replayableAdapterFailure)||input.triggerType!=='manual'||input.retry)throw Error('weekly_original_dataset_replay_run_changed');
        const revision=(scope.payload as typeof scope.payload&{weeklyAccountRevision?:{accountUrl?:string;targetCount?:number}}).weeklyAccountRevision;
        if(replay.tenantId!==input.tenantId||replay.originalRunKey!==input.originalRun.key||revision?.accountUrl!==replay.accountUrl||revision.targetCount!==5||
          scope.payload.discoveryBrief.weeklyAccountCollectionTarget?.accountUrl!==replay.accountUrl||
          scope.payload.discoveryBrief.weeklyAccountCollectionTarget.targetCount!==5||!input.requestedModes?.includes('account'))throw Error('weekly_original_dataset_replay_scope_changed');
        const reservations=await dependencies.dataStore.list<{tenant_id:string;run_id:string;request_key:string;count:number;day:string}>(DAILY_COLLECTION_RESERVATIONS,{where:{tenant_id:input.tenantId,run_id:originalId!},perPage:2});
        if(reservations.totalItems!==1||reservations.items.length!==1||reservations.items[0]?.request_key!==`account:tiktok:${replay.accountUrl}`||reservations.items[0].count!==5||
          reservations.items[0].day!==collectionBusinessDate(new Date(run.startedAt)))throw Error('weekly_original_dataset_replay_reservation_unverified');
        const result=await dependencies.crawl({tenantId:input.tenantId,platform:'tiktok',mode:'account',accountUrl:replay.accountUrl,accountName:replay.accountUrl,
          limit:5,newCandidatesOnly:true,disableBackfill:true,deferAnalysis:true,dataStore:dependencies.dataStore,originalDatasetReplay:input.originalDatasetReplay,
          discoveryContext:{runId:run.runId,scopeId:scope.id,scopeVersion:scope.version,mode:'account',queryRef:replay.accountUrl,
            weeklyOriginalAccountCollection:{originalRunKey:input.originalRun.key,accountUrl:replay.accountUrl,actorInputSha256:createHash('sha256').update(JSON.stringify(frozenWeeklyAccountFiveVideoActorInput(replay.accountUrl))).digest('hex')}}});
        if(!Array.isArray(result.candidateIds)||result.candidateIds.length>5||!Number.isSafeInteger(result.total)||result.total>5)throw Error('weekly_original_dataset_replay_import_incomplete');
        const priorIds=Array.isArray(priorProducer?.originalDatasetCandidateIds)?priorProducer.originalDatasetCandidateIds.filter((id):id is string=>typeof id==='string'):[];
        const candidateIds=result.candidateIds.length?result.candidateIds:priorIds;
        if(candidateIds.length!==5||new Set(candidateIds).size!==5)throw Error('weekly_original_dataset_replay_import_incomplete');
        const evidenceInput={...result,candidateIds,total:Math.max(result.total,candidateIds.length)};
        const workItems=await dependencies.candidateEvidenceAdapter.toEvidenceWorkItems({tenantId:input.tenantId,runId:run.runId,scopeId:scope.id,scopeVersion:scope.version,mode:'account',queryRef:replay.accountUrl,result:evidenceInput,observedAt:new Date().toISOString(),platform:'tiktok',keywordTier:'account',audienceRole:scope.payload.keywordSet?.scope?.audienceRole});
        if(workItems.length!==5||new Set(workItems.map(item=>item.candidateId)).size!==5||workItems.some(item=>!candidateIds.includes(item.candidateId)))throw Error('weekly_original_dataset_replay_evidence_incomplete');
        const evidence=await dependencies.runCandidateEvidence(workItems);
        const acceptedIds=[...new Set(evidence.accepted.map(item=>item.candidateId))],suggestionIds=[...new Set(evidence.suggestions.map(item=>item.candidateId))],failedIds=[...new Set(evidence.failed.map(item=>item.candidateId))];
        const finalStatus=evidence.failed.length?(acceptedIds.length?'partial' as const:'failed' as const):acceptedIds.length?'succeeded' as const:'stopped' as const;
        const previous=socialObject(socialObject(socialJson(run.scopeSnapshot))?.weeklyProducer);
        const mediaByVideoId=Object.fromEntries(replay.directMedia.map(media=>[media.videoId,{providerRunId:media.providerRunId,datasetId:media.datasetId,sourceUrlSha256:media.sourceUrlSha256,contentSha256:media.contentSha256,byteLength:media.byteLength,filePath:media.filePath,receiptPath:media.receiptPath}]));
        if(Object.keys(mediaByVideoId).length!==replay.rows.length)throw Error('weekly_original_dataset_direct_media_incomplete');
        const scopeSnapshot={...run.scopeSnapshot,weeklyProducer:{...previous,jobId:replay.jobId,packageId:input.originalRun.weeklyScope?.packageId,packageVersion:input.originalRun.weeklyScope?.packageVersion,originalDatasetDigest:replay.digest,originalDatasetProviderRunId:replay.providerRunId,originalDatasetId:replay.datasetId,originalDatasetCandidateIds:candidateIds,originalDatasetDirectMedia:mediaByVideoId,
          ...(replayableAdapterFailure?{recoveryHistory:[{status:run.status,stopReason:run.stopReason,error:run.error,finishedAt:run.finishedAt,failureDetails:run.failureDetails,recoveredAt:new Date().toISOString(),reason:'weekly_original_dataset_replay_adapter_wiring_repaired'}]}:{})}} as typeof run.scopeSnapshot;
        const stats={requested:5,fetched:5,deduplicated:0,analyzed:workItems.length,accepted:acceptedIds.length,momentumCandidates:0,failed:evidence.failed.length,costCny:null,effectiveRate:acceptedIds.length/5};
        const evidenceOutcomes={account:{acceptedCandidateIds:acceptedIds,acceptedEvidenceRefs:evidence.accepted.map(item=>`${item.evidenceId}@${item.version}`),suggestionCandidateIds:suggestionIds,failedCandidateIds:failedIds}};
        const finishedAt=new Date().toISOString(),failureDetails=evidence.failed.map(item=>({mode:'account' as const,platform:'tiktok',queryRef:replay.accountUrl,error:item.error,errorCode:'source_failed' as const}));
        const stopReason=finalStatus==='failed'?'source_failed' as const:finalStatus==='stopped'?'no_valid_results' as const:'completed' as const,error=evidence.failed.map(item=>item.error).join('；')||null;
        const saved=await dependencies.dataStore.update(DISCOVERY_RUN_COLLECTION,run.id,{status:finalStatus,scopeSnapshot,modeStats:{account:stats},platformStats:{tiktok:stats},keywordTierStats:{account:stats},evidenceOutcomes,sourceRunRefs:['account:tiktok:apify-tiktok-original-dataset-journal'],stopReason,finishedAt,error,failureDetails});
        if(!saved)throw Error('discovery_run_storage_unavailable');
        return {run:{...run,status:finalStatus,scopeSnapshot,modeStats:{account:stats},platformStats:{tiktok:stats},keywordTierStats:{account:stats},evidenceOutcomes,sourceRunRefs:['account:tiktok:apify-tiktok-original-dataset-journal'],stopReason,finishedAt,error,failureDetails}};
      }
      const startedAt=Date.parse(run.startedAt??'');
      if(input.originalRun.recoveryOnly&&run.status==='running'&&Number.isFinite(startedAt)&&Date.now()-startedAt>=5*60_000){
        const finishedAt=new Date().toISOString(),error='weekly_discovery_original_execution_interrupted';
        if(!await dependencies.dataStore.update(DISCOVERY_RUN_COLLECTION,run.id,{status:'failed',stopReason:'source_failed',finishedAt,error}))throw Error('discovery_run_storage_unavailable');
        run={...run,status:'failed',stopReason:'source_failed',finishedAt,error};
      }
      return {run};
    }
    if(input.originalRun.recoveryOnly)return {skipped:true,reason:'weekly_discovery_original_write_unknown'};
  }
  if(input.originalRun&&!input.retry){
    const jobs=await dependencies.dataStore.list<{program_id:string;package_id:string;package_version:number;kind:string}>('social_weekly_preproduction_jobs',{where:{tenant_id:input.tenantId,original_run_key:input.originalRun.key},perPage:2});
    if(jobs.totalItems>1||jobs.items.length!==jobs.totalItems)throw Error('weekly_discovery_original_authority_ambiguous');
    const job=jobs.items[0];
    if(job){if(job.kind!=='discovery')throw Error('weekly_discovery_original_authority_changed');weeklyRootScope={programId:job.program_id,packageId:job.package_id,packageVersion:job.package_version,originalRunKey:input.originalRun.key};}
    else if(input.originalRun.key.startsWith('weekly-preproduction:'))throw Error('weekly_discovery_original_authority_missing');
    if(input.originalRun.weeklyScope&&socialRequestHash(input.originalRun.weeklyScope)!==socialRequestHash(weeklyRootScope))throw Error('weekly_discovery_original_authority_changed');
    if(weeklyRootScope)await assertWeeklyOriginalCrossDayFence(dependencies.dataStore,input.tenantId,weeklyRootScope,input.now??new Date());
  }
  // A previously submitted child is read above even after midnight. A new
  // provider submission must use the business date frozen on its attempt.
  const retryAuthorization=input.retry?.authorization??(input.retry?.grant?{kind:'explicit_grant' as const,grant:input.retry.grant}:null);
  if(input.retry&&input.retry.kind!=='qualified_continuation'&&retryAuthorization?.kind==='normal_daily_window')
    throw Error('weekly_discovery_cross_day_authorization_required');
  if(retryAuthorization?.kind==='normal_daily_window'&&retryAuthorization.businessDate!==collectionBusinessDate(input.now??new Date()))throw Error('weekly_discovery_retry_daily_window_changed');
  // A bound continuation can survive a restart or a clock correction. The
  // immutable stage proved the interval when it was written, but a fresh paid
  // submission must independently recheck the persisted parent completion.
  if(input.retry?.kind==='qualified_continuation'){
    const parents=await dependencies.dataStore.list<SocialInspirationCollectionRun>(DISCOVERY_RUN_COLLECTION,{where:{tenant_id:input.tenantId,runId:input.retry.parentRunId},perPage:2});
    const parent=parents.items[0],finishedAt=Date.parse(parent?.finishedAt??''),current= (input.now??new Date()).getTime();
    if(parents.totalItems!==1||parents.items.length!==1||!parent||socialRequestHash(parent)!==input.retry.parentRunHash||!Number.isFinite(finishedAt)||!Number.isFinite(current)||current-finishedAt<300000)
      throw Error('weekly_discovery_qualified_interval_pending');
    const row=await dependencies.dataStore.getById<{payload:WeeklyQualifiedContinuationStage}>(WEEKLY_QUALIFIED_CONTINUATION_STAGES,input.retry.continuationStageId??'');
    if(!row?.payload)throw Error('weekly_discovery_qualified_stage_missing');
    await readWeeklyQualifiedContinuationSubmitReadiness({store:dependencies.dataStore,stage:row.payload,now:input.now??new Date(),mediaRoot:fileURLToPath(new URL('../../data/media',import.meta.url)),pendingAttemptKey:input.originalRun!.key,...(dependencies.qualifiedCandidateReader?{candidateReader:dependencies.qualifiedCandidateReader}:{})});
  }
  const brief = structuredClone(scope.payload.discoveryBrief);
  // A user-approved weekly account revision is an account-only authority, not
  // an addition to the ordinary keyword allocation inherited from its scope.
  const revision = (scope.payload as typeof scope.payload & {weeklyAccountRevision?:{accountUrl?:string;targetCount?:number}}).weeklyAccountRevision;
  // Scheduled/manual entry points without the frozen weekly producer identity
  // must not silently spend the inherited keyword scope. A production-gap run
  // has its own explicit authority and budget and remains independent.
  if (revision && input.triggerType !== 'production_gap' && !input.originalRun) throw Error('weekly_discovery_account_only_authority_required');
  if (revision && input.triggerType !== 'production_gap' && (revision.targetCount !== 5 || !revision.accountUrl)) throw Error('weekly_discovery_account_only_authority_invalid');
  const accountOnlyUrl = input.triggerType !== 'production_gap' && input.originalRun && revision ? revision.accountUrl : undefined;
  if (accountOnlyUrl) {
    if (input.triggerType !== 'manual' || brief.weeklyAccountCollectionTarget?.accountUrl !== accountOnlyUrl || brief.weeklyAccountCollectionTarget.targetCount !== 5 ||
      (input.retry && input.retry.sourceSelection.some(source => source.mode !== 'account' || source.platform !== 'tiktok' || source.queryRef !== accountOnlyUrl))) {
      throw Error('weekly_discovery_account_only_authority_invalid');
    }
    const attempts=await dependencies.dataStore.list<{id:string;program_id:string;package_id:string;package_version:number}>('social_weekly_preproduction_jobs',{where:{tenant_id:input.tenantId,original_run_key:input.originalRun!.key},perPage:2});
    const retries=attempts.totalItems===0?await dependencies.dataStore.list<{program_id:string;package_id:string;package_version:number}>('social_weekly_preproduction_retry_attempts',{where:{tenant_id:input.tenantId,original_run_key:input.originalRun!.key},perPage:2}):null;
    const lineage=attempts.totalItems===1&&attempts.items.length===1?attempts.items[0]:retries?.totalItems===1&&retries.items.length===1?retries.items[0]:null;
    if(!lineage)throw Error('weekly_preproduction_collection_budget_authorization_required');
    // The first Actor request is frozen at five videos. A partial daily quota
    // must never turn that request into a smaller paid run. A continuation has
    // its own one-item attempt identity and is checked separately.
    if(!input.retry){
      const capacity=await readDailyCollectionCapacity(dependencies.dataStore,{tenantId:input.tenantId,runId:originalId!,now:input.now});
      if(capacity.kind!=='normal_daily_window'||capacity.remainingCount<5)throw Error('weekly_discovery_account_five_capacity_required');
    }
    if(input.originalDatasetReplay){
      const replay=readVerifiedWeeklyOriginalDatasetReplay(input.originalDatasetReplay);
      const job=attempts.totalItems===1?attempts.items[0]:null;
      if(!job||replay.tenantId!==input.tenantId||replay.jobId!==job.id||replay.originalRunKey!==input.originalRun!.key||replay.accountUrl!==accountOnlyUrl)throw Error('weekly_original_dataset_replay_scope_changed');
    }else{
      const paidBlocker=await readWeeklyAccountCollectionPaidBlocker({store:dependencies.dataStore,tenantId:input.tenantId,programId:lineage.program_id,packageId:lineage.package_id,packageVersion:lineage.package_version,scopeId:scope.id,scopeVersion:scope.version,scopeHash:socialRequestHash(scope.payload),accountUrl:accountOnlyUrl});
      throw Error(paidBlocker);
    }
  }
  // The account library is the user's current source of truth. A saved scope
  // snapshot must not keep collecting an account after it is removed there.
  const savedAccounts = await dependencies.dataStore.list<{ accountUrl: string; accountName?: string }>('competitor_accounts', {
    where: { tenantId: input.tenantId }, page: 1, perPage: 200,
  });
  const accountNameByUrl = new Map(savedAccounts.items.map(account => [account.accountUrl, account.accountName || account.accountUrl]));
  if(input.originalRun&&brief.discoveryModes.includes('account')&&socialRequestHash([...brief.competitorAccounts].sort())!==socialRequestHash([...accountNameByUrl.keys()].sort()))throw Error('weekly_discovery_account_sources_changed');
  brief.competitorAccounts = [...accountNameByUrl.keys()];
  const weeklyAccountTarget = input.originalRun && !input.retry && input.triggerType === 'manual'
    ? brief.weeklyAccountCollectionTarget : undefined;
  if (weeklyAccountTarget) {
    if (!input.requestedModes?.includes('account') || !brief.discoveryModes.includes('account') ||
      !brief.modePolicies?.account?.enabled || !scope.payload.approval?.approvedBy ||
      typeof weeklyAccountTarget.accountUrl !== 'string' ||
      !accountNameByUrl.has(weeklyAccountTarget.accountUrl) ||
      !Number.isSafeInteger(weeklyAccountTarget.targetCount) ||
      weeklyAccountTarget.targetCount < 1 ||
      weeklyAccountTarget.targetCount + brief.competitorAccounts.length - 1 > WEEKLY_AUTOMATION_TEMPLATE.dailyCollectionLimit) {
      throw Error('weekly_discovery_account_target_scope_invalid');
    }
  }
  if (brief.modePolicies?.account) brief.modePolicies.account.sourceRefs = brief.competitorAccounts;
  if (input.triggerType !== 'production_gap' && brief.competitorAccounts.length > WEEKLY_AUTOMATION_TEMPLATE.dailyCollectionLimit) throw Error('daily_collection_account_minimum_exceeds_limit');
  if (input.triggerType !== 'production_gap' && brief.competitorAccounts.length && (!brief.discoveryModes.includes('account') || !brief.modePolicies?.account?.enabled)) throw Error('daily_collection_account_mode_required');
  const reservedDailySources = new Set<string>();
  if (!input.retry && input.triggerType !== 'production_gap') {
    const day = collectionBusinessDate(input.now ?? new Date());
    for (let page = 1;;page++) {
      const reservations = await dependencies.dataStore.list<{request_key:string}>('social_discovery_daily_reservations', {where:{tenant_id:input.tenantId,day},page,perPage:100});
      for (const reservation of reservations.items) reservedDailySources.add(reservation.request_key);
      if (page >= reservations.totalPages) break;
    }
  }
  const authorizedAccounts = accountOnlyUrl ? [accountOnlyUrl] : brief.competitorAccounts;
  const accountRefsToCollect = input.retry ? authorizedAccounts : authorizedAccounts.filter(account => !reservedDailySources.has(`account:${inferPlatformFromUrl(account)}:${account}`));
  if (input.productionGapContext) {
    brief.productionGap = input.productionGapContext.description;
    brief.budgetLimitCny = Math.max(0, input.productionGapContext.remainingBudgetCny);
  }
  const previousRuns = (await dependencies.dataStore.list<SocialInspirationCollectionRun>(DISCOVERY_RUN_COLLECTION, {
      where: { tenant_id: input.tenantId, keywordSetId: brief.keywordSetId }, sort: '-startedAt', page: 1, perPage: 200,
    })).items;
  const dueCandidates = input.triggerType === 'scheduled'
    ? dueDiscoveryModes(brief, previousRuns)
    : input.requestedModes ?? brief.discoveryModes;
  const candidates = dueCandidates.includes('account') || accountRefsToCollect.length ? ['account' as const] : [];
  const configuredShare = Number((brief as SocialDiscoveryBriefWithQuality).innovationExperimentShare ?? 0.1);
  const quotaPlan = planRollingSevenDayQuotas(previousRuns, {
    totalAcceptedTarget: brief.resultLimit,
    innovationShare: configuredShare,
    accountShare: 1,
    enabledModes: accountRefsToCollect.length > 0 ? ['account'] : [],
  });
  const requestedModes = [...new Set(candidates)].filter(mode => brief.discoveryModes.includes(mode)
    && brief.modePolicies?.[mode]?.enabled
    && (mode !== 'account' || accountRefsToCollect.length > 0)
    && mode === 'account')
    .sort((left,right)=>Number(right==='account')-Number(left==='account'));
  if (!requestedModes.length) return { skipped: true, reason: 'no_discovery_mode_due', nextRunAt: nextDiscoveryRunAt(brief, previousRuns) };
  brief.discoveryModes = requestedModes;
  const issues = validateDiscoveryBrief(brief);
  if (issues.length) throw new Error(`discovery_run_scope_invalid: ${issues.join('; ')}`);

  const startedAt = new Date().toISOString();
  let completeEmptyVerified=true;
  let dailyLimitReached=false;
  const runId = originalId??`discovery_run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const queryBasis = Object.fromEntries(requestedModes.map(mode => [mode, mode === 'account' ? accountRefsToCollect : modeRefs(scope, mode)])) as Partial<Record<SocialDiscoveryMode, string[]>>;
  const initial: SocialInspirationCollectionRun & { tenant_id: string } = {
    tenant_id: input.tenantId, runId, planId: brief.discoveryBriefId, keywordSetId: brief.keywordSetId, keywordSetVersion: brief.keywordSetVersion,
    discoveryScopeId: scope.id, discoveryScopeVersion: scope.version, status: 'running', triggerType: input.triggerType,
    scopeSnapshot: input.originalRun?({...brief,weeklyProducer:{inputHash:originalHash,key:input.originalRun.key,...(input.retry?{retry:input.retry}:{})}} as typeof brief):brief, modeStats: {}, platformStats: {}, keywordTierStats: {}, evidenceOutcomes: {}, sourceRunRefs: [], queryBasis, market: scope.payload.market || brief.market, language: scope.payload.language || '',
    stopReason: null, startedAt, finishedAt: null, error: null,
  };
  const created = await dependencies.dataStore.create<SocialInspirationCollectionRun & { id: string }>(DISCOVERY_RUN_COLLECTION, {...(input.originalRun?{id:socialRequestHash({tenantId:input.tenantId,key:input.originalRun.key}).slice(0,15)}:{}), ...initial });
  if (!created){if(input.originalRun){const prior=await dependencies.dataStore.list<SocialInspirationCollectionRun>(DISCOVERY_RUN_COLLECTION,{where:{tenant_id:input.tenantId,runId:runId},perPage:2});if(prior.totalItems===1&&prior.items.length===1)return executeApprovedDiscoveryRun(input,dependencies);}throw new Error('discovery_run_storage_unavailable');}

  const modeStats: SocialInspirationCollectionRun['modeStats'] = {};
  const platformStats: NonNullable<SocialInspirationCollectionRun['platformStats']> = {};
  const keywordTierStats: NonNullable<SocialInspirationCollectionRun['keywordTierStats']> = {};
  const evidenceOutcomes: NonNullable<SocialInspirationCollectionRun['evidenceOutcomes']> = {};
  const sourceRunRefs: string[] = [];
  const failureDetails: NonNullable<SocialInspirationCollectionRun['failureDetails']> = [];
  const quotaPlatforms = [...new Set([
    ...brief.platforms,
    ...brief.competitorAccounts.map(account => inferPlatformFromUrl(account)),
  ])];
  const retryPlatformLimits = input.retry ? new Map<string,number>([...new Set(input.retry.sourceSelection.map(source => source.platform))].map(platform => [platform,input.retry!.sourceSelection.filter(source => source.platform === platform).length])) : null;
  const remainingPlatformQuota = new Map<string, number>(retryPlatformLimits
    ?? normalizeSocialPlatformQuotas(quotaPlatforms, brief.resultLimit).map(item => [item.platform, item.limit]));
  let error: string | null = null;
  for (const mode of requestedModes) {
    const policy = brief.modePolicies![mode]!;
    const stats: SocialDiscoveryModeRunStats = emptyStats();
    const refs = queryBasis[mode] ?? [];
    const configuredPlatforms = policy.platforms.length ? policy.platforms : brief.platforms;
    const ordinaryTargets = refs.flatMap(ref => {
      const tier = keywordTier(scope, mode, ref);
      if (/^https?:\/\//i.test(ref)) return [{ ref, platform: inferPlatformFromUrl(ref), tier }];
      return configuredPlatforms
        .filter(platform => ['linkedin', 'facebook', 'tiktok', 'instagram', 'youtube'].includes(platform))
        .filter(platform => platform !== 'youtube' || tier !== 'broad')
        .map(platform => ({ ref, platform: platform as ReturnType<typeof inferPlatformFromUrl>, tier }));
    }).filter(target=>!input.retry||input.retry.sourceSelection.some(source=>source.mode===mode&&source.platform===target.platform&&source.queryRef===target.ref));
    const targets = ordinaryTargets;
    // Scheduled/manual discovery fills accepted-item gaps. A production gap owns its
    // independent budget and is therefore bounded by its explicit mode policy.
    let remaining = input.retry ? input.retry.sourceSelection.filter(source => source.mode === mode).length
      : input.triggerType === 'production_gap'
      ? policy.resultLimit
      : mode === 'account' ? accountOnlyUrl ? 5 : Math.max(brief.competitorAccounts.length + (weeklyAccountTarget ? weeklyAccountTarget.targetCount - 1 : 0), Math.min(policy.resultLimit, quotaPlan.remainingByMode[mode]))
        : Math.min(policy.resultLimit, quotaPlan.remainingByMode[mode]);
    const alreadyAccepted = new Set(quotaPlan.acceptedCandidateIdsByMode[mode]);
    const acceptedCandidateIds = new Set<string>();
    const acceptedEvidenceRefs = new Set<string>();
    const suggestionCandidateIds = new Set<string>();
    const failedCandidateIds = new Set<string>();
    const momentumCandidateIds = new Set<string>();
    for (const [index, target] of targets.entries()) {
      if (remaining <= 0) break;
      const configuredPlatformRemaining = remainingPlatformQuota.get(target.platform) ?? 0;
      const accountLimit = mode === 'account' && !input.retry && target.ref === weeklyAccountTarget?.accountUrl ? weeklyAccountTarget.targetCount : 1;
      const platformRemaining = mode === 'account' ? accountLimit : configuredPlatformRemaining > 0
        ? configuredPlatformRemaining
        : /^https?:\/\//i.test(target.ref) && configuredPlatformRemaining === 0 ? 1 : 0;
      if (platformRemaining <= 0) continue;
      const requestedLimit = input.retry ? 1 : mode === 'account' ? Math.min(accountLimit, remaining) : Math.min(platformRemaining, 'limit' in target && typeof target.limit === 'number' ? target.limit : Math.max(1, Math.ceil(remaining / Math.max(1, targets.length - index))));
      let perSourceLimit:number;
      try{const retryAuthorization=input.retry?.authorization??(input.retry?.grant?{kind:'explicit_grant' as const,grant:input.retry.grant}:null);perSourceLimit=await reserveDailyCollection(dependencies.dataStore,{tenantId:input.tenantId,runId,requestKey:`${mode}:${target.platform}:${target.ref}`,requested:requestedLimit,now:input.now,...(accountOnlyUrl&&!input.retry&&mode==='account'&&target.ref===accountOnlyUrl?{minimumRequired:5}:{}),...(retryAuthorization?.kind==='explicit_grant'?{retryGrant:retryAuthorization.grant}:{}),...(weeklyRootScope?{weeklyOriginal:weeklyRootScope}:{})});}
      catch(cause){completeEmptyVerified=false;const message=cause instanceof Error?cause.message:'daily_collection_quota_unavailable';stats.failed++;error=message;failureDetails.push({mode,platform:target.platform,queryRef:target.ref,error:message});break;}
      if(!perSourceLimit){dailyLimitReached=true;completeEmptyVerified=false;break;}
      if (mode !== 'account') remainingPlatformQuota.set(target.platform, configuredPlatformRemaining - perSourceLimit);
      stats.requested += perSourceLimit;
      platformStats[target.platform] ??= emptyStats();
      keywordTierStats[target.tier] ??= emptyStats();
      addStats(platformStats[target.platform]!, { requested: perSourceLimit });
      addStats(keywordTierStats[target.tier]!, { requested: perSourceLimit });
      try {
        const dateTo = new Date().toISOString().slice(0, 10);
        const dateFrom = new Date(Date.now() - brief.lookbackDays * 86_400_000).toISOString().slice(0, 10);
        const videoResult = await dependencies.crawl({
          tenantId: input.tenantId,
          platform: target.platform,
          newCandidatesOnly: true,
          disableBackfill: true,
          mode: mode === 'account' ? 'account' : 'keyword',
          ...(mode === 'account' ? { accountUrl: target.ref, accountName: accountNameByUrl.get(target.ref) || target.ref } : { keyword: target.ref }),
          limit: perSourceLimit,
          dateFrom,
          dateTo,
          discoveryContext: { runId, scopeId: scope.id, scopeVersion: scope.version, mode, queryRef: target.ref,
          ...(accountOnlyUrl && mode === 'account' && target.ref === accountOnlyUrl ? {weeklyOriginalAccountCollection: {
            originalRunKey: input.originalRun!.key,
            accountUrl: accountOnlyUrl,
            actorInputSha256: createHash('sha256').update(JSON.stringify(frozenWeeklyAccountFiveVideoActorInput(accountOnlyUrl))).digest('hex'),
          }} : {}) },
          ...(input.originalDatasetReplay?{originalDatasetReplay:input.originalDatasetReplay}:{}),
        });
        const sourceResults: CrawlVideosResult[] = [videoResult];
        if (!input.originalRun && mode === 'account' && dependencies.crawlImages) {
          sourceResults.push(await dependencies.crawlImages({
            tenantId: input.tenantId,
            platform: target.platform,
            mode: 'account',
            accountUrl: target.ref,
            accountName: accountNameByUrl.get(target.ref) || target.ref,
            limit: perSourceLimit,
            dateFrom,
            dateTo,
          }));
        }
        for (const sourceResult of sourceResults) {
          if ((sourceResult.items?.length ?? 0) > perSourceLimit || (sourceResult.candidateIds?.length ?? 0) > perSourceLimit) throw Error('daily_collection_provider_limit_exceeded');
        }
        const combinedItems = sourceResults.flatMap(sourceResult => sourceResult.items ?? []);
        const result: CrawlVideosResult = {
          ...videoResult,
          total: sourceResults.reduce((sum, sourceResult) => sum + Number(sourceResult.total || 0), 0),
          imported: sourceResults.reduce((sum, sourceResult) => sum + Number(sourceResult.imported || 0), 0),
          skipped: sourceResults.reduce((sum, sourceResult) => sum + Number(sourceResult.skipped || 0), 0),
          skippedExisting: sourceResults.reduce((sum, sourceResult) => sum + Number(sourceResult.skippedExisting || 0), 0),
          items: combinedItems,
          candidateIds: [...new Set(sourceResults.flatMap(sourceResult => sourceResult.candidateIds ?? sourceResult.items?.map(item => String((item as { id?: unknown }).id || '')).filter(Boolean) ?? []))],
          source: sourceResults.map(sourceResult => sourceResult.source).filter(Boolean).join('+'),
        };
        if(input.originalRun&&(!Array.isArray(result.items)||!Array.isArray(result.candidateIds)||!Number.isSafeInteger(result.total)||result.total<0))throw Error('weekly_discovery_source_incomplete');
        if(result.total!==0||result.items?.length!==0||result.candidateIds?.length!==0)completeEmptyVerified=false;
        stats.fetched += Number(result.total || 0);
        const exactDuplicates=Number(result.skippedExisting || 0),nearDuplicates=Number(result.skippedNearDuplicate || 0),nearDuplicateUnchecked=Number(result.nearDuplicateUnchecked || 0);
        stats.deduplicated += exactDuplicates+nearDuplicates;
        stats.exactDuplicates=(stats.exactDuplicates??0)+exactDuplicates;
        stats.nearDuplicates=(stats.nearDuplicates??0)+nearDuplicates;
        stats.nearDuplicateUnchecked=(stats.nearDuplicateUnchecked??0)+nearDuplicateUnchecked;
        addStats(platformStats[target.platform]!, { fetched: Number(result.total || 0), deduplicated: exactDuplicates+nearDuplicates,exactDuplicates,nearDuplicates,nearDuplicateUnchecked });
        addStats(keywordTierStats[target.tier]!, { fetched: Number(result.total || 0), deduplicated: exactDuplicates+nearDuplicates,exactDuplicates,nearDuplicates,nearDuplicateUnchecked });
        const acceptedBefore = acceptedCandidateIds.size;
        const workItems = await dependencies.candidateEvidenceAdapter.toEvidenceWorkItems({
          tenantId: input.tenantId, runId, scopeId: scope.id, scopeVersion: scope.version,
          mode, queryRef: target.ref, result, observedAt: new Date().toISOString(), platform: target.platform,
          keywordTier: target.tier, audienceRole: scope.payload.keywordSet?.scope?.audienceRole,
        });
        stats.analyzed=(stats.analyzed??0)+workItems.length;
        addStats(platformStats[target.platform]!,{analyzed:workItems.length});
        addStats(keywordTierStats[target.tier]!,{analyzed:workItems.length});
        const evidenceResult = await dependencies.runCandidateEvidence(workItems);
        for (const item of evidenceResult.accepted) {
          acceptedCandidateIds.add(item.candidateId);
          acceptedEvidenceRefs.add(`${item.evidenceId}@${item.version}`);
        }
        evidenceResult.suggestions.forEach(item => suggestionCandidateIds.add(item.candidateId));
        evidenceResult.failed.forEach(item => failedCandidateIds.add(item.candidateId));
        stats.failed += evidenceResult.failed.length;
        const callAccepted = acceptedCandidateIds.size - acceptedBefore;
        addStats(platformStats[target.platform]!, { accepted: callAccepted, failed: evidenceResult.failed.length });
        addStats(keywordTierStats[target.tier]!, { accepted: callAccepted, failed: evidenceResult.failed.length });
        const newlyQualified = evidenceResult.accepted
          .filter(item => !alreadyAccepted.has(item.candidateId))
          .filter((item, itemIndex, values) => values.findIndex(value => value.candidateId === item.candidateId) === itemIndex).length;
        evidenceResult.accepted.forEach(item => alreadyAccepted.add(item.candidateId));
        remaining = Math.max(0, remaining - newlyQualified);
        sourceRunRefs.push(`${mode}:${target.platform}:${result.source}`);
      } catch (cause) {
        stats.failed += 1;
        addStats(platformStats[target.platform]!, { failed: 1 });
        addStats(keywordTierStats[target.tier]!, { failed: 1 });
        const causeMessage = cause instanceof Error ? cause.message : '采集来源失败';
        failureDetails.push({ mode, platform: target.platform, queryRef: target.ref, error: causeMessage, errorCode: classifyDiscoverySourceFailure(causeMessage) });
        error = causeMessage;
      }
    }
    stats.accepted = acceptedCandidateIds.size;
    stats.momentumCandidates = momentumCandidateIds.size;
    stats.effectiveRate = stats.fetched > 0 ? stats.accepted / stats.fetched : null;
    modeStats[mode] = stats;
    evidenceOutcomes[mode] = {
      acceptedCandidateIds: [...acceptedCandidateIds], acceptedEvidenceRefs: [...acceptedEvidenceRefs],
      suggestionCandidateIds: [...suggestionCandidateIds], failedCandidateIds: [...failedCandidateIds],
    };
  }
  const failed = Object.values(modeStats).reduce((sum, item) => sum + (item?.failed || 0), 0);
  const accepted = Object.values(modeStats).reduce((sum, item) => sum + (item?.accepted || 0), 0);
  const status = failed ? (accepted ? 'partial' as const : 'failed' as const) : accepted ? 'succeeded' as const : 'stopped' as const;
  const finishedAt = new Date().toISOString();
  const failureSummary = [...new Set(failureDetails.map(item => `${item.platform}/${item.queryRef}: ${item.error}`))].join('；');
  const run: SocialInspirationCollectionRun = {
    ...initial, ...(input.originalRun?{scopeSnapshot:{...initial.scopeSnapshot,weeklyProducer:{inputHash:originalHash,key:input.originalRun.key,...(input.retry?{retry:input.retry}:{ }),completeEmptyVerified:completeEmptyVerified&&failed===0&&Object.values(modeStats).every(s=>(s?.requested??0)>0)}} as typeof initial.scopeSnapshot}:{}), status, modeStats, platformStats, keywordTierStats, evidenceOutcomes, sourceRunRefs, failureDetails,
    stopReason: dailyLimitReached?'daily_collection_limit_reached':status === 'failed' ? 'source_failed' : status === 'stopped' ? 'no_valid_results' : 'completed', finishedAt, error: failureSummary || error,
  };
  const saved = await dependencies.dataStore.update(DISCOVERY_RUN_COLLECTION, created.id, { status, scopeSnapshot:run.scopeSnapshot, modeStats, platformStats, keywordTierStats, evidenceOutcomes, sourceRunRefs, failureDetails, stopReason: run.stopReason, finishedAt, error: run.error });
  if (!saved) throw new Error('discovery_run_storage_unavailable');
  return { run };
}
