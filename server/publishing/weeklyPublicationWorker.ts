import {createInstagramDeliveryPublicationProof} from './instagramDeliveryPublicationProof.js';
import path from 'node:path';
import type { SocialProductionResult } from '../../shared/contracts/socialContentWorkflow.js';
import type { VersionedSocialRef, WeeklyOperatingPackage, WeeklyExecutionTask } from '../../shared/contracts/socialProgram.js';
import { buildPublicationAssignment, type PublishableProductionResult } from '../digitalEmployees/publishingExecution.js';
import { parseSocialContentAuthorityLineage, type SocialContentAuthorityLineage } from '../starter198/socialContentLineage.js';
import {socialRequestHash} from '../starter198/socialContentValidation.js';
import type { DataStore,Record_ } from '../storage/datastore.js';
import { store } from '../storage/index.js';
import {
  createAssignedPublicationPackage,
  markPublicationAssignmentPackageReady,
  persistPublicationAssignment,
} from './weeklyLineage.js';
import { runWeeklyPublicationExecutionScan } from './weeklyPublicationExecutionWorker.js';

type ArtifactRow = {
  id: string;
  tenant_id: string;
  task_id: string;
  artifact_id: string;
  version: string;
  status: string;
  content_hash: string;
  resource_ref?: string;
  content?: unknown;
  updated_at?: string;
};

type WeeklyPackageRow = {
  id: string;
  tenant_id: string;
  package_id: string;
  version: number;
  payload: WeeklyOperatingPackage;
};

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => String(value ?? '').trim();
const hash = (value: unknown): string => /^[a-f0-9]{32,128}$/i.test(text(value)) ? text(value).toLowerCase() : '';

function mediaAsset(value: unknown, kind: 'video' | 'cover') {
  const media = object(value);
  const downloadUrl = text(media.url);
  const contentHash = hash(media.sha256);
  if (!downloadUrl || !contentHash) return null;
  let fileName = `${kind}.bin`;
  try { fileName = path.basename(new URL(downloadUrl, 'http://localhost').pathname) || fileName; } catch { /* validated by package builder */ }
  return { kind, fileName, downloadUrl, contentHash } as const;
}

function convertProductionFromArtifact(
  artifact: ArtifactRow,
  lineage: SocialContentAuthorityLineage,
  weekly: WeeklyOperatingPackage,
  options: { preserveProductionVersion?: boolean } = {},
  audit?:{reviewId:string;reviewHash:string;receiptId:string;receiptHash:string;sourceHash:string},
): PublishableProductionResult {
  const content = object(artifact.content);
  const raw = object(content.productionResult) as unknown as SocialProductionResult;
  if (!text(raw.productionResultId) || raw.productionResultId !== lineage.productionResultRef?.id
    || !text(raw.version) || (!audit&&(raw.technicalReview?.approved !== true || raw.creativeReview?.approved !== true))
    || raw.status !== 'asset_review') throw new Error('production_result_not_publishable');
  const storage = object(content.mediaStorage);
  const assets = [mediaAsset(storage.video, 'video'), mediaAsset(storage.cover, 'cover')].filter((item): item is NonNullable<typeof item> => Boolean(item));
  if (!assets.length) throw new Error('production_result_media_missing');
  const contentHash = hash(artifact.content_hash) || assets[0]!.contentHash;
  const body = text(content.adaptedScript) || text(object(content.scriptAdaptation).adaptedScript)
    || weekly.objective;
  const sourceRefs: VersionedSocialRef[] = [
    lineage.programRef, lineage.packageRef, lineage.weeklyTaskRef, lineage.publicationTaskRef,
    lineage.businessGoalRef, lineage.enterpriseProfileRef, lineage.referenceSelectionRef,
    ...lineage.enterpriseFactRefs, ...lineage.candidateEvidenceRefs,
    ...lineage.inspirationHandoffRefs, lineage.directorBriefRef,
  ];
  return {
    productionResultId: raw.productionResultId,
    ...(options.preserveProductionVersion && lineage.productionResultRef ? { productionResultRef: lineage.productionResultRef } : {}),
    contentId: artifact.artifact_id,
    contentVersion: text(raw.version),
    contentHash,
    title: text(object(content.directorPlan).title) || weekly.objective.slice(0, 300) || `Content ${artifact.artifact_id}`,
    body,
    hashtags: [],
    assets,
    sourceRefs:[...sourceRefs,...(audit?[{type:'social_director_g5_review',id:audit.reviewId,version:1},{type:'social_production_receipt',id:audit.receiptId,version:1}]:[])],
    acceptedAt: text(artifact.updated_at) || raw.createdAt,
  };
}

/** Existing automatic-summary conversion remains strict and cannot accept a caller approval override. */
export function productionFromArtifact(artifact:ArtifactRow,lineage:SocialContentAuthorityLineage,weekly:WeeklyOperatingPackage,options:{preserveProductionVersion?:boolean}={}):PublishableProductionResult{return convertProductionFromArtifact(artifact,lineage,weekly,options);}
/** An immutable pending summary requires actual final user approval and fresh same-source G4/G5. */
export async function productionFromApprovedWeeklyArtifact(dataStore:DataStore,artifact:ArtifactRow,lineage:SocialContentAuthorityLineage,weekly:WeeklyOperatingPackage,options:{preserveProductionVersion?:boolean}={}):Promise<PublishableProductionResult>{
 const rows=await dataStore.list<Record_>('starter_social_content_artifacts',{where:{tenant_id:artifact.tenant_id,artifact_id:artifact.artifact_id},perPage:2});const actual=rows.items[0];
 if(rows.totalItems!==1||rows.items.length!==1||!actual||actual.status!=='approved'||actual.content_hash!==artifact.content_hash||socialRequestHash(actual.content)!==socialRequestHash(artifact.content)||String(actual.version)!==artifact.version||actual.task_id!==artifact.task_id)throw Error('production_result_actual_approval_changed');
 const raw=object(object(actual.content).productionResult);if(raw.technicalReview&&object(raw.technicalReview).approved===true&&object(raw.creativeReview).approved===true)return productionFromArtifact(artifact,lineage,weekly,options);
 if(weekly.packageId!==lineage.packageRef.id||weekly.version!==lineage.packageRef.version||weekly.programId!==lineage.programRef.id)throw Error('production_result_weekly_scope_changed');
 const approvals=await dataStore.list<Record_>('social_weekly_execution_tasks',{where:{tenant_id:artifact.tenant_id,package_id:weekly.packageId,package_version:weekly.version},perPage:1000});if(approvals.items.length!==approvals.totalItems)throw Error('production_result_approval_scan_incomplete');
 const matched=approvals.items.map(row=>object(row.payload)as unknown as WeeklyExecutionTask).filter(task=>task.tenantId===artifact.tenant_id&&task.programId===weekly.programId&&task.packageId===weekly.packageId&&task.packageVersion===weekly.version&&task.publicationTaskId===lineage.publicationTaskRef.id&&task.schedule?.stepKind==='user_approval'&&task.status==='succeeded'&&task.resultRefs?.some(ref=>ref.type==='user_content_approval')&&task.resultRefs.some(ref=>ref.type==='starter_social_content_artifact'&&ref.id===artifact.artifact_id&&ref.version===Number(String(artifact.version).replace(/^v/,''))));
 if(matched.length!==1)throw Error('production_result_final_user_approval_required');
 const {validateWeeklyPublicationAcceptance}=await import('../runtime/socialWeeklyResultValidation.js');await validateWeeklyPublicationAcceptance(dataStore,matched[0]!,String(raw.productionResultId));
 const {readVerifiedWeeklyContentQualityAudit}=await import('../runtime/weeklyContentQualityAudit.js');const audit=await readVerifiedWeeklyContentQualityAudit(dataStore,{...matched[0]!,workflowKind:'content',schedule:{...matched[0]!.schedule,stepKind:'quality_check'}},{type:'starter_social_content_artifact',id:artifact.artifact_id,version:Number(String(artifact.version).replace(/^v/,''))});return convertProductionFromArtifact(artifact,lineage,weekly,options,audit);
}

export interface WeeklyPublicationWorkerResult {
  scanned: number;
  createdAssignments: number;
  createdPackages: number;
  skipped: number;
  errors: Array<{ tenantId: string; artifactId: string; code: string }>;
}

/**
 * Turns an approved R4 production artifact plus its authoritative R3 lineage
 * into one immutable assignment/package pair. This worker never publishes.
 */
export async function runWeeklyPublicationPackageScan(input: {
  dataStore?: DataStore;
  limit?: number;
  tenantId?: string;
  taskId?: string;
  artifactId?: string;
} = {}): Promise<WeeklyPublicationWorkerResult> {
  const dataStore = input.dataStore ?? store;
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const rows = await dataStore.list<ArtifactRow>('starter_social_content_artifacts', {
    where: { status: 'approved', ...(input.tenantId ? { tenant_id: input.tenantId } : {}), ...(input.taskId ? { task_id: input.taskId } : {}), ...(input.artifactId ? { artifact_id: input.artifactId } : {}) }, sort: 'updated_at', page: 1, perPage: limit,
  });
  const result: WeeklyPublicationWorkerResult = { scanned: rows.items.length, createdAssignments: 0, createdPackages: 0, skipped: 0, errors: [] };
  for (const artifact of rows.items) {
    const tenantId = text(artifact.tenant_id);
    const artifactId = text(artifact.artifact_id);
    try {
      const production = object(object(artifact.content).productionResult);
      const productionResultId = text(production.productionResultId);
      if (!tenantId || !artifactId || !productionResultId) { result.skipped += 1; continue; }
      const lineageRows = await dataStore.list<any>('starter_social_content_lineage', {
        where: { tenant_id: tenantId, production_result_id: productionResultId }, sort: '-created_at', page: 1, perPage: 2,
      });
      if (!lineageRows.items[0]) { result.skipped += 1; continue; }
      if (lineageRows.totalItems > 1 || lineageRows.items.length > 1) throw new Error('production_result_lineage_ambiguous');
      const lineage = parseSocialContentAuthorityLineage(lineageRows.items[0]);
      if (lineage.invalidation.status !== 'valid') throw new Error('production_result_lineage_invalidated');
      const weeklyRows = await dataStore.list<WeeklyPackageRow>('social_weekly_operating_packages', {
        where: { tenant_id: tenantId, package_id: lineage.packageRef.id, version: lineage.packageRef.version }, page: 1, perPage: 2,
      });
      if (weeklyRows.totalItems !== 1 || !weeklyRows.items[0]) throw new Error('weekly_operating_package_not_found');
      const weekly = weeklyRows.items[0].payload;
      if (weekly.version !== lineage.packageRef.version || weekly.packageId !== lineage.packageRef.id) throw new Error('weekly_operating_package_lineage_mismatch');
      const originalPublication = weekly.socialContentPackage.publicationTasks.find(item => item.publicationTaskId === lineage.publicationTaskRef.id);
      if (!originalPublication) throw new Error('weekly_publication_task_not_found');
      const {canonicalWeeklyProductionPublication}=await import('../runtime/weeklyContentProductionIdentity.js');
      const publications=weekly.socialContentPackage.productionIdentityVersion==='shared-original.v1'
        ?weekly.socialContentPackage.publicationTasks.filter(item=>!item.inventoryReuseRef&&item.motherContentId===originalPublication.motherContentId)
        :[originalPublication];
      for(const publicationTask of publications){try{
      if(canonicalWeeklyProductionPublication(weekly,publicationTask.publicationTaskId).publicationTaskId!==originalPublication.publicationTaskId)throw Error('weekly_content_original_source_changed');
      // Weekly execution acceptance is independent from automatic artifact QC approval.
      const boundTasks = await dataStore.list<any>('starter_social_content_tasks', {
        where: { tenant_id: tenantId, task_id: artifact.task_id }, page: 1, perPage: 2,
      });
      const boundTask = boundTasks.items[0];
      if (String(boundTask?.create_idempotency_key ?? '').startsWith('weekly-production:')) {
        const approvals = await dataStore.list<any>('social_weekly_execution_tasks', {
          where: { tenant_id: tenantId, package_id: weekly.packageId, package_version: weekly.version }, page: 1, perPage: 1000,
        });
        if (approvals.totalItems > approvals.items.length) throw new Error('weekly_approval_scan_truncated');
        const accepted = approvals.items.some(row => row.payload?.publicationTaskId === publicationTask.publicationTaskId
          && row.payload?.schedule?.stepKind === 'user_approval' && row.payload?.status === 'succeeded'
          && row.payload?.resultRefs?.some((ref: any) => ref.type === 'starter_social_content_artifact' && ref.id === artifactId && ref.version === Number(String(artifact.version).replace(/^v/, ''))));
        if (!accepted) { result.skipped += 1; continue; }
      }
      if(weekly.socialContentPackage.productionIdentityVersion==='shared-original.v1'){
        const {validateWeeklyPublicationAcceptance}=await import('../runtime/socialWeeklyResultValidation.js');
        await validateWeeklyPublicationAcceptance(dataStore,{tenantId,programId:weekly.programId,packageId:weekly.packageId,packageVersion:weekly.version,publicationTaskId:publicationTask.publicationTaskId,accountId:publicationTask.accountId,schedule:{stepKind:'publishing'}} as WeeklyExecutionTask,productionResultId);
      }
      const rawQuality=object(object(artifact.content).productionResult);
      const publishable = object(rawQuality.technicalReview).approved===true&&object(rawQuality.creativeReview).approved===true?productionFromArtifact(artifact,lineage,weekly):await productionFromApprovedWeeklyArtifact(dataStore,artifact,lineage,weekly);
      if(publicationTask.platform==='instagram')publishable.instagramDelivery=await createInstagramDeliveryPublicationProof(dataStore,{tenantId,programId:weekly.programId,packageId:weekly.packageId,packageVersion:weekly.version,publicationTaskId:publicationTask.publicationTaskId,taskId:String(artifact.task_id),artifactId});
      const assignment = buildPublicationAssignment({ tenantId, operatingPackage: weekly, publicationTask, productionResult: publishable });
      const persisted = await persistPublicationAssignment(assignment, dataStore);
      if (persisted.created) result.createdAssignments += 1;
      const packaged = await createAssignedPublicationPackage({ assignment, productionResult: publishable }, dataStore);
      if (packaged.created) result.createdPackages += 1;
      await markPublicationAssignmentPackageReady(tenantId, assignment.assignmentId, dataStore);
      }catch(error){result.errors.push({tenantId,artifactId,code:error instanceof Error?error.message:'weekly_publication_worker_failed'});}}
    } catch (error) {
      result.errors.push({ tenantId, artifactId, code: error instanceof Error ? error.message : 'weekly_publication_worker_failed' });
    }
  }
  return result;
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    const result = await runWeeklyPublicationPackageScan();
    if (result.createdAssignments || result.createdPackages || result.errors.length) {
      console.log(`[weekly-publication-worker] scanned=${result.scanned} assignments=${result.createdAssignments} packages=${result.createdPackages} errors=${result.errors.length}`);
    }
    if (process.env.SOCIAL_WEEKLY_REAL_PUBLISHING_ENABLED === 'true') {
      const execution = await runWeeklyPublicationExecutionScan();
      if (execution.published || execution.pending || execution.failed || execution.errors.length) {
        console.log(`[weekly-publication-worker] execution scanned=${execution.scanned} published=${execution.published} pending=${execution.pending} failed=${execution.failed} errors=${execution.errors.length}`);
      }
    }
  } catch (error) {
    console.error('[weekly-publication-worker] cycle failed:', error instanceof Error ? error.message : error);
  } finally { running = false; }
}

export function initWeeklyPublicationPackageWorker(): void {
  if (process.env.SOCIAL_WEEKLY_PUBLISHING_WORKER_ENABLED !== 'true' || timer) return;
  const configured = Number(process.env.SOCIAL_WEEKLY_PUBLISHING_WORKER_INTERVAL_MS || 30_000);
  const interval = Number.isFinite(configured) ? Math.min(Math.max(configured, 5_000), 10 * 60_000) : 30_000;
  void tick();
  timer = setInterval(() => { void tick(); }, interval);
  timer.unref?.();
  console.log(`[weekly-publication-worker] enabled interval=${interval}ms; real-publishing=${process.env.SOCIAL_WEEKLY_REAL_PUBLISHING_ENABLED === 'true'}`);
}
