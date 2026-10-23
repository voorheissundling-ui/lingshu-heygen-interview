import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { STARTER_COLLECTIONS, starter198Repository, type Starter198Repository } from '../starter198/repository.js';
import { findSocialRecord, socialArtifact } from '../starter198/socialContentRecords.js';
import { requireOwnedSocialFileRef, socialContentFileView } from '../starter198/socialContentFiles.js';
import { openSocialArtifactPreviewMedia } from '../starter198/socialArtifactMedia.js';
import { publishingUploadDir, PublishSourceVerificationError, type FrozenPublishSourceClaim } from './publishSourceClaim.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function approvedSource(input: { tenantId: string; taskId: string; artifactId: string }, repository: Starter198Repository) {
  const record = await findSocialRecord({
    repository, tenantId: input.tenantId, collection: STARTER_COLLECTIONS.socialContentArtifacts,
    where: { task_id: input.taskId, artifact_id: input.artifactId }, notFoundCode: 'social_artifact_not_found',
  });
  const artifact = socialArtifact(record);
  if (artifact.status !== 'approved' || artifact.kind !== 'short_video' || !artifact.resourceRef) {
    throw new PublishSourceVerificationError('social_publish_artifact_not_approved');
  }
  const file = socialContentFileView(await requireOwnedSocialFileRef({
    repository, tenantId: input.tenantId, taskId: input.taskId, fileRef: artifact.resourceRef, usage: 'artifact_media',
  }));
  if (!['video/mp4', 'video/quicktime', 'video/webm'].includes(file.mimeType) || !/^[a-f0-9]{64}$/.test(file.sha256)) {
    throw new PublishSourceVerificationError('social_publish_artifact_invalid');
  }
  return { artifact, file, contentHash: String(record.content_hash || '') };
}

function sourceClaim(input: { tenantId: string; taskId: string; artifactId: string }, source: Awaited<ReturnType<typeof approvedSource>>, localPath: string): FrozenPublishSourceClaim {
  const generationRecordId = hash({ artifactId: source.artifact.artifactId, version: source.artifact.version,
    contentHash: source.contentHash, fileRef: source.file.fileRef, sha256: source.file.sha256 });
  return {
    schemaVersion: 1, sourceKind: 'social_content_artifact', projectId: input.taskId,
    artifactId: input.artifactId, sourceVideoPath: localPath, deliveryVideoPath: localPath,
    generationKind: 'social_content', generationProvenance: source.artifact.origin === 'agent' ? 'digital_employee' : 'human_upload',
    qualityStatus: 'passed', publishable: true, generationRecordId,
    sourceFingerprint: hash({ tenantId: input.tenantId, taskId: input.taskId, generationRecordId }),
  };
}

function sourcePath(input: { tenantId: string; taskId: string; artifactId: string }, source: Awaited<ReturnType<typeof approvedSource>>): string {
  const extension = source.file.mimeType === 'video/webm' ? '.webm' : source.file.mimeType === 'video/quicktime' ? '.mov' : '.mp4';
  return path.join(publishingUploadDir(input.tenantId), `social-${hash(input).slice(0, 24)}-${source.file.sha256}${extension}`);
}

async function verifyLocal(localPath: string, source: Awaited<ReturnType<typeof approvedSource>>): Promise<void> {
  try {
    const stat = await fs.lstat(localPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== source.file.size) throw new PublishSourceVerificationError('social_publish_media_changed');
    const digest = createHash('sha256');
    let size = 0;
    for await (const bytes of createReadStream(localPath)) { size += bytes.length; digest.update(bytes); }
    if (size !== source.file.size || digest.digest('hex') !== source.file.sha256) throw new PublishSourceVerificationError('social_publish_media_changed');
  } catch (error) {
    if (error instanceof PublishSourceVerificationError) throw error;
    throw new PublishSourceVerificationError('social_publish_media_unavailable');
  }
}

/** Materialize a verified PB artifact for the existing local-file publish worker.
 * This creates a truthful source claim, never a synthetic Studio project or a publish grant. */
export async function freezeSocialContentPublishSource(input: {
  tenantId: string; taskId: string; artifactId: string;
}, dependencies: {
  repository?: Starter198Repository;
  openMedia?: typeof openSocialArtifactPreviewMedia;
} = {}): Promise<FrozenPublishSourceClaim> {
  const repository = dependencies.repository ?? starter198Repository;
  const source = await approvedSource(input, repository);
  const localPath = sourcePath(input, source);
  try { await verifyLocal(localPath, source); }
  catch {
    const media = await (dependencies.openMedia ?? openSocialArtifactPreviewMedia)({ ...input, repository });
    if (media.file.fileRef !== source.file.fileRef || media.file.sha256 !== source.file.sha256) throw new PublishSourceVerificationError('social_publish_media_changed');
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    const temporary = `${localPath}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, 'wx', 0o600);
    let size = 0;
    const digest = createHash('sha256');
    try {
      const limiter = new Transform({ transform(chunk: Buffer, _encoding, done) {
        size += chunk.length;
        if (size > source.file.size) { done(new PublishSourceVerificationError('social_publish_media_changed')); return; }
        digest.update(chunk); done(null, chunk);
      } });
      await pipeline(Readable.from(media.body), limiter, handle.createWriteStream());
      if (size !== source.file.size || digest.digest('hex') !== source.file.sha256) throw new PublishSourceVerificationError('social_publish_media_changed');
      await fs.rename(temporary, localPath);
    } finally { await handle.close().catch(() => undefined); await fs.rm(temporary, { force: true }); }
  }
  // Acceptance may have been revoked while downloading. Re-read before issuing a claim.
  const latest = await approvedSource(input, repository);
  const claim = sourceClaim(input, source, localPath);
  if (JSON.stringify(claim) !== JSON.stringify(sourceClaim(input, latest, localPath))) throw new PublishSourceVerificationError('social_publish_artifact_changed');
  return claim;
}

/** Called by the existing publish worker immediately before an external effect. */
export async function verifySocialContentPublishSource(tenantId: string, claim: FrozenPublishSourceClaim, repository: Starter198Repository = starter198Repository): Promise<FrozenPublishSourceClaim> {
  const input = { tenantId, taskId: claim.projectId, artifactId: String(claim.artifactId || '') };
  let source: Awaited<ReturnType<typeof approvedSource>>;
  try { source = await approvedSource(input, repository); }
  catch { throw new PublishSourceVerificationError('social_publish_artifact_unavailable'); }
  const localPath = sourcePath(input, source);
  if (claim.sourceVideoPath !== localPath || claim.deliveryVideoPath !== localPath) throw new PublishSourceVerificationError('social_publish_media_changed');
  await verifyLocal(localPath, source);
  return sourceClaim(input, source, localPath);
}
