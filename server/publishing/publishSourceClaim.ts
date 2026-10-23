import type {SocialInstagramDeliveryPublishProof} from '../../shared/contracts/socialInstagramDelivery.js';
import {verifyInstagramDeliveryPublicationProof} from './instagramDeliveryPublicationProof.js';
import type {PublicationAssignment} from '../digitalEmployees/publishingExecution.js';
import {verifyWeeklyPublishSourceEvidence} from './weeklyPublishSourceEvidence.js';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTENT_SCRIPT_QUALITY_RULE_VERSION } from '../digitalEmployees/contentQualityContract.js';
import { contentAcceptanceHash } from '../digitalEmployees/contentAcceptance.js';
import {
  claimedStudioGeneration,
  verifiedStudioGenerationFromSpec,
  type StudioGenerationMetadata,
} from '../lib/studioGenerationVerification.js';
import { store } from '../storage/index.js';
import type { DataStore } from '../storage/datastore.js';
import { enterpriseAssetTenantKey } from '../storage/enterpriseAssets.js';
import { socialImageCurrentOutputs, socialImageTaskCanPublish, type SocialImageCreationTask } from '../../shared/contracts/socialImageCreation.js';

export const PUBLISH_VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi']);
export type PublishSourceRequestKind = 'project' | 'manual_upload';
export type FrozenPublishSourceKind = 'studio_project' | 'digital_employee_project' | 'manual_upload' | 'social_content_artifact' | 'social_production_artifact' | 'social_instagram_delivery' | 'social_image_artifact';

export interface PublishSourceRequest {
  sourceKind?: PublishSourceRequestKind;
  projectId?: string;
  videoPath?: string;
  videoUrl?: string;
  imagePaths?: string[];
  sourceVideoPath?: string;
  generationKind?: 'script' | 'poster';
  generationProvenance?: string;
  qualityStatus?: string;
  publishable?: boolean;
  generationRecordId?: string;
}

export interface FrozenPublishSourceClaim {
  instagramDeliveryProof?:SocialInstagramDeliveryPublishProof;
  weeklyAssignment?:PublicationAssignment;
  weeklySourceAuditHash?:string;
  schemaVersion: 1;
  sourceKind: FrozenPublishSourceKind;
  projectId: string;
  artifactId?: string;
  sourceVideoPath: string;
  deliveryVideoPath: string;
  generationKind: 'script' | 'poster' | 'digital_employee' | 'manual_upload' | 'social_content';
  generationProvenance: 'ai' | 'digital_employee' | 'human_upload';
  qualityStatus: 'passed' | 'not_applicable';
  publishable: true;
  generationRecordId: string;
  sourceFingerprint: string;
  productionResultId?: string;
  contentVersion?: string;
  contentHash?: string;
  videoHash?: string;
  artifactVideoUrl?: string;
  artifactFileId?: string;
  artifactFileRef?: string;
  sourceImagePaths?: string[];
  imageHashes?: string[];
}

type StoredProject = { id: string; tenant_id?: unknown; tenantId?: unknown; status?: unknown; spec?: unknown };

export class PublishSourceVerificationError extends Error {
  constructor(public readonly code: string, public readonly statusCode = 409, message = code) {
    super(message);
    this.name = 'PublishSourceVerificationError';
  }
}

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const record = (value: unknown): Record<string, any> => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, any>;
    } catch { /* malformed source records are not publishable */ }
  }
  return {};
};

const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function normalizedFilePath(value: unknown): string {
  const raw = text(value);
  if (!raw) return '';
  try { return raw.startsWith('file://') ? path.resolve(fileURLToPath(raw)) : path.resolve(raw); }
  catch { return ''; }
}

export function publishingUploadDir(tenantId: string): string {
  const tenantFolder = String(tenantId || 'local').replace(/[^\w.-]+/g, '-');
  return path.resolve(process.cwd(), 'data', 'publishing-uploads', tenantFolder);
}

export function localPublishingVideo(tenantId: string, videoPath: unknown): string | null {
  const resolved = normalizedFilePath(videoPath);
  const uploadDir = publishingUploadDir(tenantId);
  if (!resolved || !resolved.startsWith(`${uploadDir}${path.sep}`)) return null;
  if (!PUBLISH_VIDEO_EXTENSIONS.has(path.extname(resolved).toLowerCase())) return null;
  // A lexical prefix alone does not protect the tenant boundary when an
  // uploaded path (or a parent directory) is a symlink.
  try {
    const realUploadDir = fs.realpathSync(uploadDir);
    const realVideoPath = fs.realpathSync(resolved);
    if (!realVideoPath.startsWith(`${realUploadDir}${path.sep}`)) return null;
  } catch {
    return null;
  }
  return resolved;
}

function assertReadableVideo(videoPath: string, statusCode = 409): void {
  if (!videoPath || !PUBLISH_VIDEO_EXTENSIONS.has(path.extname(videoPath).toLowerCase())) {
    throw new PublishSourceVerificationError('publish_source_video_invalid', 400, '发布来源必须绑定受支持的视频文件。');
  }
  try {
    if (!fs.statSync(videoPath).isFile()) throw new Error('not_file');
  } catch {
    throw new PublishSourceVerificationError('publish_source_video_missing', statusCode, '已审核的视频产物不存在，请重新上传或生成后审批。');
  }
}

export function currentPublishableVideoPaths(spec: Record<string, any>): string[] {
  const automation = record(spec.automation);
  if (text(automation.renderOutputPath)) return [normalizedFilePath(automation.renderOutputPath)].filter(Boolean);
  const outputs = record(spec.languageRenderOutputs);
  const current = Object.values(outputs).map(record)
    .filter(item => text(item.status) === 'done' && text(item.path))
    .map(item => normalizedFilePath(item.path)).filter(Boolean);
  if (current.length) return [...new Set(current)];
  return ['renderOutputPath', 'videoPath', 'outputPath']
    .map(key => normalizedFilePath(spec[key])).filter(Boolean).slice(0, 1);
}

function projectTenant(project: StoredProject): string {
  return text(project.tenant_id) || text(project.tenantId);
}

function assertProjectArtifact(project: StoredProject, sourceVideoPath: string): Record<string, any> {
  const spec = record(project.spec);
  if (record(spec.contentOrder).publishMode === 'draft_only') {
    throw new PublishSourceVerificationError('publish_source_production_only', 409, '这条新增内容仅授权制作；请先明确确认发布账号、时间与发布授权。');
  }
  if (record(record(spec.contentOrder).explicitPublishingIntent).state === 'pending') {
    throw new PublishSourceVerificationError('publish_configuration_uncommitted', 409, '发布配置尚未完整保存，不能使用旧审批发布。');
  }
  if (!sourceVideoPath || !currentPublishableVideoPaths(spec).includes(sourceVideoPath)) {
    throw new PublishSourceVerificationError(
      'publish_source_artifact_stale',
      409,
      '当前排期绑定的成片已不是项目的当前产物，请重新审核后发布。',
    );
  }
  return spec;
}

function assertDeliveryArtifact(tenantId: string, deliveryVideoPath: string, sourceVideoPath: string): void {
  const controlledCopy = localPublishingVideo(tenantId, deliveryVideoPath);
  if (deliveryVideoPath !== sourceVideoPath && !controlledCopy) {
    throw new PublishSourceVerificationError('publish_delivery_artifact_uncontrolled', 400, '发布文件不是当前项目产物或本企业受控副本。');
  }
  assertReadableVideo(deliveryVideoPath, 409);
}

function digitalEmployeeClaim(input: {
  tenantId: string;
  project: StoredProject;
  sourceVideoPath: string;
  deliveryVideoPath: string;
}): FrozenPublishSourceClaim {
  const spec = assertProjectArtifact(input.project, input.sourceVideoPath);
  const automation = record(spec.automation);
  const quality = record(automation.quality);
  if (text(input.project.status) !== 'ready_for_approval'
    || automation.managedBy !== 'digital_employee'
    || automation.stage !== 'completed'
    || quality.passed !== true
    || Number(quality.ruleVersion) !== CONTENT_SCRIPT_QUALITY_RULE_VERSION) {
    throw new PublishSourceVerificationError('digital_employee_generation_stale', 409, '数字员工成片不再是当前已通过质检的版本，请重新质检和审批。');
  }
  const generationRecordId = contentAcceptanceHash(spec);
  return {
    schemaVersion: 1,
    sourceKind: 'digital_employee_project',
    projectId: input.project.id,
    sourceVideoPath: input.sourceVideoPath,
    deliveryVideoPath: input.deliveryVideoPath,
    generationKind: 'digital_employee',
    generationProvenance: 'digital_employee',
    qualityStatus: 'passed',
    publishable: true,
    generationRecordId,
    sourceFingerprint: fingerprint({
      projectId: input.project.id,
      projectStatus: text(input.project.status),
      sourceVideoPath: input.sourceVideoPath,
      deliveryVideoPath: input.deliveryVideoPath,
      generationRecordId,
      qualityRuleVersion: Number(quality.ruleVersion),
    }),
  };
}

function studioClaim(input: {
  tenantId: string;
  project: StoredProject;
  sourceVideoPath: string;
  deliveryVideoPath: string;
  generation: unknown;
}): FrozenPublishSourceClaim {
  const spec = assertProjectArtifact(input.project, input.sourceVideoPath);
  const verification = verifiedStudioGenerationFromSpec(spec, input.generation);
  if (!verification.ok) {
    throw new PublishSourceVerificationError(verification.code, 409, verification.message);
  }
  const generation = verification.metadata;
  return {
    schemaVersion: 1,
    sourceKind: 'studio_project',
    projectId: input.project.id,
    sourceVideoPath: input.sourceVideoPath,
    deliveryVideoPath: input.deliveryVideoPath,
    ...generation,
    sourceFingerprint: fingerprint({
      projectId: input.project.id,
      sourceVideoPath: input.sourceVideoPath,
      deliveryVideoPath: input.deliveryVideoPath,
      generation,
    }),
  };
}

export function projectPublishSourceClaim(input: {
  tenantId: string;
  project: StoredProject;
  videoPath: string;
  artifactVideoUrl?: string;
  artifactFileId?: string;
  artifactFileRef?: string;
  sourceVideoPath?: string;
  generation?: unknown;
  requireReadableVideo?: boolean;
}): FrozenPublishSourceClaim {
  if (projectTenant(input.project) && projectTenant(input.project) !== input.tenantId) {
    throw new PublishSourceVerificationError('publish_source_project_not_found', 404, '当前企业的发布项目不存在。');
  }
  const sourceVideoPath = normalizedFilePath(input.sourceVideoPath || input.videoPath);
  const deliveryVideoPath = normalizedFilePath(input.videoPath);
  const spec = record(input.project.spec);
  const claim = record(spec.automation).managedBy === 'digital_employee'
    ? digitalEmployeeClaim({ ...input, sourceVideoPath, deliveryVideoPath })
    : studioClaim({ ...input, sourceVideoPath, deliveryVideoPath, generation: input.generation });
  if (input.requireReadableVideo !== false) assertDeliveryArtifact(input.tenantId, deliveryVideoPath, sourceVideoPath);
  return claim;
}

function manualUploadClaim(tenantId: string, videoPathValue: unknown): FrozenPublishSourceClaim {
  const videoPath = localPublishingVideo(tenantId, videoPathValue);
  if (!videoPath || !path.basename(videoPath).startsWith('manual-')) {
    throw new PublishSourceVerificationError('manual_upload_source_uncontrolled', 400, '手工发布必须重新选择并上传本企业的视频文件。');
  }
  assertReadableVideo(videoPath, 400);
  const stat = fs.statSync(videoPath);
  const generationRecordId = fingerprint({ path: videoPath, size: stat.size, mtimeMs: Math.floor(stat.mtimeMs) });
  return {
    schemaVersion: 1,
    sourceKind: 'manual_upload',
    projectId: '',
    sourceVideoPath: videoPath,
    deliveryVideoPath: videoPath,
    generationKind: 'manual_upload',
    generationProvenance: 'human_upload',
    qualityStatus: 'not_applicable',
    publishable: true,
    generationRecordId,
    sourceFingerprint: fingerprint({ tenantId, generationRecordId }),
  };
}

async function socialImagePublishSourceClaim(input: { tenantId: string; projectId: string; imagePaths: string[] }): Promise<FrozenPublishSourceClaim> {
  const row = await store.getById<StoredProject & { spec?: { socialImageTask?: SocialImageCreationTask } }>('studio_projects', input.projectId);
  const task = row?.spec?.socialImageTask;
  if (!row || projectTenant(row) !== input.tenantId || !task || !socialImageTaskCanPublish(task)) {
    throw new PublishSourceVerificationError('social_image_artifact_not_publishable', 409, '图片任务尚未完成统一质检与批准。');
  }
  const root = path.resolve(process.cwd(), 'data', 'social-image-renders', enterpriseAssetTenantKey(input.tenantId));
  const expected = socialImageCurrentOutputs(task).flatMap(output => {
    const filename = path.basename(text(output.mediaUrl));
    return filename ? [path.resolve(root, filename)] : [];
  });
  const images = [...new Set(input.imagePaths.map(normalizedFilePath).filter(Boolean))];
  if (!images.length || images.length !== expected.length || images.some((item, index) => item !== expected[index])) {
    throw new PublishSourceVerificationError('social_image_artifact_stale', 409, '发布图片与已批准的当前输出不一致。');
  }
  const imageHashes = images.map(imagePath => {
    if (!imagePath.startsWith(`${root}${path.sep}`) || !fs.existsSync(imagePath) || !fs.statSync(imagePath).isFile()) {
      throw new PublishSourceVerificationError('social_image_artifact_missing', 409, '已批准图片文件不存在。');
    }
    return createHash('sha256').update(fs.readFileSync(imagePath)).digest('hex');
  });
  return {
    schemaVersion: 1,
    sourceKind: 'social_image_artifact',
    projectId: input.projectId,
    sourceVideoPath: '',
    deliveryVideoPath: '',
    sourceImagePaths: images,
    imageHashes,
    generationKind: 'poster',
    generationProvenance: 'ai',
    qualityStatus: 'passed',
    publishable: true,
    generationRecordId: `${task.id}:v${task.version}`,
    sourceFingerprint: fingerprint({ tenantId: input.tenantId, projectId: input.projectId, version: task.version, images, imageHashes }),
  };
}

function sameClaim(left: FrozenPublishSourceClaim, right: FrozenPublishSourceClaim): boolean {
  // PocketBase canonicalizes JSON object key order while persisting the claim.
  // The frozen values matter; serialization order does not.
  return isDeepStrictEqual(left, right);
}

/** Freeze the approved social production row itself, never reclassify it as a manual upload. */
export async function socialProductionPublishSourceClaim(input: {
  weeklyAssignment?:PublicationAssignment;
  tenantId: string;
  artifactId: string;
  productionResultId: string;
  contentVersion: string;
  contentHash: string;
  videoHash: string;
  videoPath: string;
  artifactVideoUrl?: string;
  artifactFileId?: string;
  artifactFileRef?: string;
  dataStore?: DataStore;
}): Promise<FrozenPublishSourceClaim> {
  const dataStore = input.dataStore ?? store;
  const result = await dataStore.list<{
    id: string; tenant_id: string; artifact_id: string; version: string; status: string;
    content_hash: string; resource_ref?: string; task_id?: string; content: unknown;
  }>('starter_social_content_artifacts', {
    where: { tenant_id: input.tenantId, artifact_id: input.artifactId }, page: 1, perPage: 2,
  });
  if (result.totalItems !== 1 || !result.items[0]) throw new PublishSourceVerificationError('social_production_artifact_not_found');
  const row = result.items[0];
  const content = record(row.content);
  const production = record(content.productionResult);
  const video = record(record(content.mediaStorage).video);
  const videoPath = normalizedFilePath(input.videoPath);
  const artifactFileId = text(video.fileId);
  const artifactFileRef = text(video.fileRef);
  const weeklyProof=input.weeklyAssignment?await verifyWeeklyPublishSourceEvidence(dataStore,input.weeklyAssignment,row):null;
  if (row.status !== 'approved' || text(production.version) !== input.contentVersion
    || text(production.productionResultId) !== input.productionResultId
    || production.status !== 'asset_review'
    || (!weeklyProof&&(record(production.technicalReview).approved !== true||record(production.creativeReview).approved !== true))
    || (text(row.content_hash) || text(video.sha256)).toLowerCase() !== input.contentHash.toLowerCase()
    || text(video.sha256).toLowerCase() !== input.videoHash.toLowerCase()
    || !artifactFileId || artifactFileRef !== `socialfile:${artifactFileId}`
    || text(row.resource_ref) !== artifactFileRef
    || (input.artifactFileId && input.artifactFileId !== artifactFileId)
    || (input.artifactFileRef && input.artifactFileRef !== artifactFileRef)
    || (input.artifactVideoUrl ? text(video.url) !== input.artifactVideoUrl : normalizedFilePath(video.url) !== videoPath)) {
    throw new PublishSourceVerificationError('social_production_artifact_stale');
  }
  assertReadableVideo(videoPath);
  const videoDigest = createHash('sha256');
  for await (const chunk of fs.createReadStream(videoPath)) videoDigest.update(chunk);
  const actualVideoHash = videoDigest.digest('hex');
  if (actualVideoHash !== input.videoHash.toLowerCase()) throw new PublishSourceVerificationError('social_production_video_hash_mismatch');
  return {
    schemaVersion: 1, sourceKind: 'social_production_artifact', projectId: '',
    ...(weeklyProof?{weeklyAssignment:input.weeklyAssignment,weeklySourceAuditHash:weeklyProof.sourceAuditHash}:{}),
    sourceVideoPath: videoPath, deliveryVideoPath: videoPath,
    generationKind: 'script', generationProvenance: 'ai', qualityStatus: 'passed',
    publishable: true, generationRecordId: input.productionResultId,
    artifactId: input.artifactId, productionResultId: input.productionResultId,
    contentVersion: input.contentVersion, contentHash: input.contentHash.toLowerCase(),
    videoHash: input.videoHash.toLowerCase(), artifactVideoUrl: input.artifactVideoUrl,
    artifactFileId, artifactFileRef,
    sourceFingerprint: fingerprint({ rowId: row.id, artifactId: row.artifact_id, version: row.version,
      productionResultId: input.productionResultId, contentHash: input.contentHash.toLowerCase(),
      videoHash: input.videoHash.toLowerCase(), artifactVideoUrl: input.artifactVideoUrl || '',
      artifactFileId, artifactFileRef, videoPath,...(weeklyProof?{weeklySourceAuditHash:weeklyProof.sourceAuditHash,weeklyAssignmentHash:input.weeklyAssignment!.assignmentHash}: {}) }),
  };
}

export async function freezePublishSourceClaim(
  tenantId: string,
  request: PublishSourceRequest,
): Promise<FrozenPublishSourceClaim> {
  const imagePaths = [...new Set((request.imagePaths ?? []).map(normalizedFilePath).filter(Boolean))];
  if (imagePaths.length) {
    if (request.videoPath || request.videoUrl || !text(request.projectId) || request.sourceKind === 'manual_upload') {
      throw new PublishSourceVerificationError('publish_image_source_invalid', 400, '图片发布必须绑定一个已批准的图片任务。');
    }
    return socialImagePublishSourceClaim({ tenantId, projectId: text(request.projectId), imagePaths });
  }
  if (request.videoUrl || !text(request.videoPath)) {
    throw new PublishSourceVerificationError('publish_source_local_video_required', 400, '发布必须绑定当前项目成片或本企业手工上传的视频。');
  }
  const projectId = text(request.projectId);
  if (!projectId) {
    if (request.sourceKind !== 'manual_upload') {
      throw new PublishSourceVerificationError('publish_source_required', 400, '请选择明确的项目产物或手工上传来源后再发布。');
    }
    return manualUploadClaim(tenantId, request.videoPath);
  }
  if (request.sourceKind && request.sourceKind !== 'project') {
    throw new PublishSourceVerificationError('publish_source_kind_mismatch', 400, '项目产物不能伪装为手工上传来源。');
  }
  const project = await store.getById<StoredProject>('studio_projects', projectId);
  if (!project || projectTenant(project) !== tenantId) {
    throw new PublishSourceVerificationError('publish_source_project_not_found', 404, '当前企业的发布项目不存在。');
  }
  return projectPublishSourceClaim({
    tenantId,
    project,
    videoPath: text(request.videoPath),
    sourceVideoPath: text(request.sourceVideoPath),
    generation: claimedStudioGeneration(request),
  });
}

export async function instagramDeliveryPublishSourceClaim(input:{tenantId:string;assignment:PublicationAssignment;sourceClaim:FrozenPublishSourceClaim;videoPath:string;dataStore?:DataStore}):Promise<FrozenPublishSourceClaim>{
 const dataStore=input.dataStore??store,proof=input.assignment.lineage.instagramDelivery;
 if(!proof||input.assignment.platform!=='instagram'||input.sourceClaim.sourceKind!=='social_production_artifact'||input.sourceClaim.weeklyAssignment?.assignmentHash!==input.assignment.assignmentHash||proof.sourceFileSha256!==input.sourceClaim.videoHash||proof.scope.tenantId!==input.tenantId||proof.scope.programId!==input.assignment.lineage.programRef.id||proof.scope.packageId!==input.assignment.lineage.operatingPackageRef.id||proof.scope.packageVersion!==input.assignment.lineage.operatingPackageRef.version||proof.scope.publicationTaskId!==input.assignment.publicationTaskId||proof.scope.artifactId!==input.sourceClaim.artifactId)throw new PublishSourceVerificationError('instagram_delivery_frozen_proof_missing');
 await verifyInstagramDeliveryPublicationProof(dataStore,proof);const deliveryVideoPath=normalizedFilePath(input.videoPath);assertReadableVideo(deliveryVideoPath);const hash=createHash('sha256');for await(const chunk of fs.createReadStream(deliveryVideoPath))hash.update(chunk);if(hash.digest('hex')!==proof.fileSha256)throw new PublishSourceVerificationError('instagram_delivery_file_hash_changed');
 return {...input.sourceClaim,sourceKind:'social_instagram_delivery',deliveryVideoPath,instagramDeliveryProof:proof,sourceFingerprint:fingerprint({sourceFingerprint:input.sourceClaim.sourceFingerprint,proof,deliveryVideoPath})};
}

export async function verifyFrozenPublishSourceClaim(
  tenantId: string,
  claimValue: unknown,
  deliveryVideoPathValue?: unknown,
  deliveryImagePathsValue?: unknown,
): Promise<FrozenPublishSourceClaim> {
  const claim = record(claimValue) as unknown as FrozenPublishSourceClaim;
  if (claim.schemaVersion !== 1) {
    throw new PublishSourceVerificationError('publish_source_claim_missing', 409, '排期缺少冻结的发布来源，请重新审核。');
  }
  let current: FrozenPublishSourceClaim;
  if (claim.sourceKind === 'social_image_artifact') {
    current = await socialImagePublishSourceClaim({ tenantId, projectId: text(claim.projectId), imagePaths: Array.isArray(claim.sourceImagePaths) ? claim.sourceImagePaths : [] });
  } else if (claim.sourceKind === 'social_content_artifact') {
    const { verifySocialContentPublishSource } = await import('./socialContentSourceClaim.js');
    current = await verifySocialContentPublishSource(tenantId, claim);
  } else if (claim.sourceKind === 'social_instagram_delivery') {
    if(!claim.weeklyAssignment)throw new PublishSourceVerificationError('instagram_delivery_frozen_proof_missing');
    const original=await socialProductionPublishSourceClaim({tenantId,artifactId:text(claim.artifactId),productionResultId:text(claim.productionResultId),contentVersion:text(claim.contentVersion),contentHash:text(claim.contentHash),videoHash:text(claim.videoHash),videoPath:text(claim.sourceVideoPath),artifactVideoUrl:text(claim.artifactVideoUrl),artifactFileId:text(claim.artifactFileId),artifactFileRef:text(claim.artifactFileRef),weeklyAssignment:claim.weeklyAssignment});
    current=await instagramDeliveryPublishSourceClaim({tenantId,assignment:claim.weeklyAssignment,sourceClaim:original,videoPath:claim.deliveryVideoPath});
  } else if (claim.sourceKind === 'social_production_artifact') {
    current = await socialProductionPublishSourceClaim({
      tenantId, artifactId: text(claim.artifactId), productionResultId: text(claim.productionResultId),
      contentVersion: text(claim.contentVersion), contentHash: text(claim.contentHash),
      videoHash: text(claim.videoHash), videoPath: text(claim.deliveryVideoPath), artifactVideoUrl: text(claim.artifactVideoUrl),
      artifactFileId: text(claim.artifactFileId), artifactFileRef: text(claim.artifactFileRef),
      ...(claim.weeklyAssignment?{weeklyAssignment:claim.weeklyAssignment}:{}),
    });
  } else if (claim.sourceKind === 'manual_upload') {
    current = manualUploadClaim(tenantId, claim.deliveryVideoPath);
  } else {
    const project = await store.getById<StoredProject>('studio_projects', text(claim.projectId));
    if (!project || projectTenant(project) !== tenantId) {
      throw new PublishSourceVerificationError('publish_source_project_not_found', 404, '排期绑定的项目已不存在或不属于当前企业。');
    }
    current = projectPublishSourceClaim({
      tenantId,
      project,
      videoPath: text(claim.deliveryVideoPath),
      sourceVideoPath: text(claim.sourceVideoPath),
      generation: claim.sourceKind === 'studio_project' ? claim : undefined,
    });
  }
  if (deliveryVideoPathValue !== undefined
    && normalizedFilePath(deliveryVideoPathValue) !== text(claim.deliveryVideoPath)) {
    throw new PublishSourceVerificationError('publish_delivery_artifact_stale', 409, '排期中的发布文件与已审核产物不一致，请重新审核。');
  }
  if (deliveryImagePathsValue !== undefined) {
    const supplied = Array.isArray(deliveryImagePathsValue) ? deliveryImagePathsValue.map(normalizedFilePath) : [];
    if (!isDeepStrictEqual(supplied, claim.sourceImagePaths ?? [])) {
      throw new PublishSourceVerificationError('publish_delivery_artifact_stale', 409, '排期中的发布图片与已审核产物不一致，请重新审核。');
    }
  }
  if (!sameClaim(current, claim)) {
    throw new PublishSourceVerificationError('publish_source_claim_stale', 409, '项目、生成记录或视频产物已变化，请重新审核后发布。');
  }
  return current;
}

export function digitalEmployeePublishSourceClaim(
  tenantId: string,
  project: StoredProject,
  videoPath: string,
): FrozenPublishSourceClaim {
  return projectPublishSourceClaim({ tenantId, project, videoPath, requireReadableVideo: false });
}

export function studioGenerationFromClaim(claim: FrozenPublishSourceClaim): StudioGenerationMetadata | null {
  return claim.sourceKind === 'studio_project' ? claimedStudioGeneration(claim) : null;
}
