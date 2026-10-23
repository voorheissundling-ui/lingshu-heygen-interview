import fs from 'node:fs';
import { Readable } from 'node:stream';
import type { CreateSocialArtifactInput, SocialContentFile } from '../../shared/contracts/socialContentWorkflow.js';
import { STARTER_COLLECTIONS, type Starter198Repository, type StarterRecord } from './repository.js';
import {
  assertSocialContentFilePersisted,
  readSocialContentFile,
  requireOwnedSocialFileRef,
  type SocialContentBackendFilePort,
} from './socialContentFiles.js';
import { findSocialRecord, socialArtifact } from './socialContentRecords.js';
import { SocialContentWorkflowError, socialText } from './socialContentValidation.js';

export interface SocialArtifactMediaDescriptor {
  artifactId: string;
  fileRef: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
}

const VIDEO_ARTIFACT_KINDS = new Set(['short_video', 'video']);
const IMAGE_ARTIFACT_KINDS = new Set(['image_post', 'poster', 'image', 'carousel']);

export function socialArtifactMediaFamily(kind: unknown, content?: Record<string, unknown> | null): 'video' | 'image' | null {
  const normalized = socialText(kind).toLowerCase();
  const contentType = socialText(content?.contentType).toLowerCase();
  if (VIDEO_ARTIFACT_KINDS.has(normalized) || VIDEO_ARTIFACT_KINDS.has(contentType)
    || /(?:^|[_-])(?:video|reel)(?:$|[_-])/.test(normalized)) return 'video';
  if (IMAGE_ARTIFACT_KINDS.has(normalized) || IMAGE_ARTIFACT_KINDS.has(contentType)
    || /(?:^|[_-])(?:image|poster|carousel)(?:$|[_-])/.test(normalized)) return 'image';
  return null;
}

function assertMimeFamily(file: SocialContentFile, family: 'video' | 'image' | null): void {
  if (!['video/mp4', 'video/quicktime', 'video/webm', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimeType)) {
    throw new SocialContentWorkflowError('social_artifact_media_type_invalid', 415);
  }
  if (family && !file.mimeType.startsWith(`${family}/`)) {
    throw new SocialContentWorkflowError('social_artifact_media_type_invalid', 415);
  }
}

async function ownedMediaRecord(input: {
  repository: Starter198Repository;
  tenantId: string;
  taskId: string;
  fileRef: string;
  backendFilePort?: SocialContentBackendFilePort;
}): Promise<{ record: StarterRecord; file: SocialContentFile }> {
  const record = await requireOwnedSocialFileRef({ ...input, usage: 'artifact_media' });
  const file = await assertSocialContentFilePersisted({
    record,
    tenantId: input.tenantId,
    ...(input.backendFilePort ? { backendFilePort: input.backendFilePort } : {}),
  });
  assertMimeFamily(file, null);
  return { record, file };
}

/** Resolve only a task-owned, already persisted artifact media reference. */
export async function resolveSocialArtifactMedia(input: {
  repository: Starter198Repository;
  tenantId: string;
  taskId: string;
  value: CreateSocialArtifactInput;
  backendFilePort?: SocialContentBackendFilePort;
}): Promise<{ record: StarterRecord; file: SocialContentFile } | null> {
  const family = socialArtifactMediaFamily(input.value.kind, input.value.content);
  const fileRef = socialText(input.value.resourceRef);
  if (!fileRef) {
    if (family) throw new SocialContentWorkflowError('social_artifact_media_required', 400);
    return null;
  }
  if (!fileRef.startsWith('socialfile:')) {
    if (family) throw new SocialContentWorkflowError('social_artifact_media_ref_invalid', 400);
    return null;
  }
  const resolved = await ownedMediaRecord({ ...input, fileRef });
  assertMimeFamily(resolved.file, family);
  return resolved;
}

export function socialArtifactMediaDescriptor(
  artifactId: string,
  file: SocialContentFile,
): SocialArtifactMediaDescriptor {
  return {
    artifactId,
    fileRef: file.fileRef,
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
    sha256: file.sha256,
  };
}

/** Re-open a frozen manifest media entry within the requesting tenant and task. */
export async function openSocialArtifactMedia(input: {
  repository: Starter198Repository;
  tenantId: string;
  taskId: string;
  descriptor: SocialArtifactMediaDescriptor;
  backendFilePort?: SocialContentBackendFilePort;
}): Promise<AsyncIterable<Uint8Array>> {
  const resolved = await ownedMediaRecord({
    repository: input.repository,
    tenantId: input.tenantId,
    taskId: input.taskId,
    fileRef: input.descriptor.fileRef,
    backendFilePort: input.backendFilePort,
  });
  const actual = socialArtifactMediaDescriptor(input.descriptor.artifactId, resolved.file);
  if (actual.fileRef !== input.descriptor.fileRef
    || actual.name !== input.descriptor.name
    || actual.mimeType !== input.descriptor.mimeType
    || actual.size !== input.descriptor.size
    || actual.sha256 !== input.descriptor.sha256) {
    throw new SocialContentWorkflowError('social_delivery_media_integrity_violation', 503);
  }
  const opened = await readSocialContentFile({
    repository: input.repository,
    tenantId: input.tenantId,
    fileId: resolved.file.fileId,
    ...(input.backendFilePort ? { backendFilePort: input.backendFilePort } : {}),
  });
  if (opened.localPath) return fs.createReadStream(opened.localPath);
  if (opened.object) return opened.object.body;
  if (opened.backend) return Readable.from(opened.backend.buf);
  throw new SocialContentWorkflowError('social_content_file_storage_unavailable', 503);
}

/** Open media through its task-owned artifact identity; callers never supply a storage reference. */
export async function openSocialArtifactPreviewMedia(input: {
  repository: Starter198Repository;
  tenantId: string;
  taskId: string;
  artifactId: string;
  backendFilePort?: SocialContentBackendFilePort;
}): Promise<{ file: SocialContentFile; body: AsyncIterable<Uint8Array> }> {
  const record = await findSocialRecord({
    ...input,
    collection: STARTER_COLLECTIONS.socialContentArtifacts,
    where: { task_id: input.taskId, artifact_id: input.artifactId },
    notFoundCode: 'social_artifact_not_found',
  });
  const artifact = socialArtifact(record);
  const resolved = await resolveSocialArtifactMedia({
    repository: input.repository,
    tenantId: input.tenantId,
    taskId: input.taskId,
    backendFilePort: input.backendFilePort,
    value: {
      kind: artifact.kind,
      platform: artifact.platform,
      language: artifact.language,
      origin: artifact.origin,
      resourceRef: artifact.resourceRef,
      content: artifact.content,
      parentArtifactId: artifact.parentArtifactId,
    },
  });
  if (!resolved) throw new SocialContentWorkflowError('social_artifact_media_not_found', 404);
  const opened = await readSocialContentFile({
    repository: input.repository,
    tenantId: input.tenantId,
    fileId: resolved.file.fileId,
    ...(input.backendFilePort ? { backendFilePort: input.backendFilePort } : {}),
  });
  if (opened.localPath) return { file: resolved.file, body: fs.createReadStream(opened.localPath) };
  if (opened.object) return { file: resolved.file, body: opened.object.body };
  if (opened.backend) return { file: resolved.file, body: Readable.from(opened.backend.buf) };
  throw new SocialContentWorkflowError('social_content_file_storage_unavailable', 503);
}
