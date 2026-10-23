import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { DataStore } from '../storage/datastore.js';
import { createStarter198Repository } from '../starter198/repository.js';
import { readSocialContentFile, type SocialContentBackendFilePort } from '../starter198/socialContentFiles.js';
import { publishingUploadDir, PublishSourceVerificationError } from './publishSourceClaim.js';

const text = (value: unknown) => String(value ?? '').trim();
const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};

export interface MaterializedSocialProductionMedia { videoPath: string; sourceUrl: string; cleanup(): Promise<void> }

/** Resolve a frozen artifact URL through the tenant-owned social file record. */
export async function materializeSocialProductionVideo(input: {
  tenantId: string;
  artifactId: string;
  attemptId: string;
  expectedHash: string;
  dataStore: DataStore;
  backendFilePort?: SocialContentBackendFilePort;
}): Promise<MaterializedSocialProductionMedia> {
  const artifacts = await input.dataStore.list<any>('starter_social_content_artifacts', { where: { tenant_id: input.tenantId, artifact_id: input.artifactId }, page: 1, perPage: 2 });
  if (artifacts.totalItems !== 1 || !artifacts.items[0]) throw new PublishSourceVerificationError('social_production_artifact_not_found');
  const artifact = artifacts.items[0];
  const video = record(record(record(artifact.content).mediaStorage).video);
  const sourceUrl = text(video.url);
  const urlMatch = /^\/api\/overseas\/starter-198\/social-content\/files\/(socialfile_[a-f0-9]{24})$/.exec(sourceUrl);
  const fileId = text(video.fileId);
  const fileRef = text(video.fileRef);
  if (!urlMatch || urlMatch[1] !== fileId || fileRef !== `socialfile:${fileId}` || text(artifact.resource_ref) !== fileRef
    || text(video.sha256).toLowerCase() !== input.expectedHash.toLowerCase()) {
    throw new PublishSourceVerificationError('social_production_media_identity_mismatch');
  }
  const opened = await readSocialContentFile({ repository: createStarter198Repository(input.dataStore), tenantId: input.tenantId, fileId, ...(input.backendFilePort ? { backendFilePort: input.backendFilePort } : {}) });
  if (opened.view.taskId !== text(artifact.task_id) || opened.view.usage !== 'artifact_media'
    || opened.view.fileRef !== fileRef || opened.view.sha256 !== input.expectedHash.toLowerCase()
    || !opened.view.mimeType.startsWith('video/')) throw new PublishSourceVerificationError('social_production_media_ownership_mismatch');

  const extension = opened.view.mimeType === 'video/webm' ? '.webm' : opened.view.mimeType === 'video/quicktime' ? '.mov' : '.mp4';
  const directory = publishingUploadDir(input.tenantId);
  await fsp.mkdir(directory, { recursive: true });
  const safeAttempt = input.attemptId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  if (!opened.localPath && !opened.backend && !opened.object?.body) throw new PublishSourceVerificationError('social_production_media_unavailable', 503);
  // Each consumer owns its copy: a retry must never delete another attempt's bytes.
  const ownedDirectory = await fsp.mkdtemp(path.join(directory, `social-${safeAttempt}-`));
  const videoPath = path.join(ownedDirectory, `${input.expectedHash.slice(0, 16)}${extension}`);
  try {
    const body = opened.localPath ? fs.createReadStream(opened.localPath) : opened.backend ? Readable.from(opened.backend.buf) : opened.object!.body;
    await pipeline(body, fs.createWriteStream(videoPath, { flags: 'wx', mode: 0o600 }));
    const stat = await fsp.stat(videoPath);
    if (stat.size !== opened.view.size) throw new Error('size_mismatch');
    const digest = createHash('sha256');
    for await (const chunk of fs.createReadStream(videoPath)) digest.update(chunk);
    if (digest.digest('hex') !== opened.view.sha256) throw new Error('hash_mismatch');
    return { videoPath, sourceUrl, async cleanup() {
      await fsp.rm(ownedDirectory, { recursive: true, force: true }).catch(error => {
        console.error('[weekly-publishing] failed to remove materialized social video:', error instanceof Error ? error.message : error);
      });
    } };
  } catch (error) {
    await fsp.rm(ownedDirectory, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof PublishSourceVerificationError) throw error;
    throw new PublishSourceVerificationError('social_production_media_integrity_violation', 503);
  }
}
