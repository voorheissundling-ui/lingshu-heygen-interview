import { socialRequestHash } from './socialContentValidation.js';
import type {
  SocialAssetSupplyShotPlan,
  SocialReferenceVideoAnalysis,
} from '../../shared/contracts/socialContentReplication.js';
import type { SocialReferenceReuseBinding } from '../../shared/contracts/socialContentTaskContract.js';

export type SocialReferenceBackgroundAssetLock = NonNullable<
  SocialAssetSupplyShotPlan['referenceBackgroundAssetLock']
>;

const SHA256 = /^[a-f0-9]{64}$/;

function fail(code: string): never {
  throw new Error(code);
}

function lockPayload(lock: Omit<SocialReferenceBackgroundAssetLock, 'lockHash'>) {
  return {
    schemaVersion: lock.schemaVersion,
    referenceRecordId: lock.referenceRecordId,
    referenceSourceId: lock.referenceSourceId,
    sourceContentSha256: lock.sourceContentSha256,
    analysisId: lock.analysisId,
    analysisHash: lock.analysisHash,
    referenceShotId: lock.referenceShotId,
    startSeconds: lock.startSeconds,
    endSeconds: lock.endSeconds,
    clipRef: lock.clipRef,
    firstFrameRef: lock.firstFrameRef,
    firstFrameSeconds: lock.firstFrameSeconds,
  };
}

/** Freeze the exact benchmark-shot background already extracted by reference analysis. */
export function freezeSocialReferenceBackgroundAsset(input: {
  referenceReuse: SocialReferenceReuseBinding;
  referenceAnalysis: SocialReferenceVideoAnalysis;
  referenceShotId: string;
}): SocialReferenceBackgroundAssetLock {
  const { referenceReuse: reuse, referenceAnalysis: analysis } = input;
  if (!SHA256.test(reuse.contentSha256) || !SHA256.test(reuse.analysisHash)) {
    fail('reference_background_source_hash_invalid');
  }
  if (analysis.status !== 'ready'
    || analysis.analysisId !== reuse.analysisId
    || analysis.referenceRecordId !== reuse.recordId) {
    fail('reference_background_analysis_binding_changed');
  }
  const shot = analysis.shots.find(item => item.shotId === input.referenceShotId);
  if (!shot) fail('reference_background_shot_missing');
  const evidence = shot.materialEvidence;
  if (evidence?.extractionStatus !== 'ready'
    || !evidence.clipRef || !evidence.firstFrameRef
    || !Number.isFinite(evidence.firstFrameSeconds)
    || evidence.firstFrameSeconds < shot.startSeconds
    || evidence.firstFrameSeconds > shot.endSeconds
    || !(shot.endSeconds > shot.startSeconds)) {
    fail('reference_background_evidence_missing');
  }
  const payload: Omit<SocialReferenceBackgroundAssetLock, 'lockHash'> = {
    schemaVersion: 'social-reference-background-lock.v1',
    referenceRecordId: reuse.recordId,
    referenceSourceId: analysis.referenceSourceId,
    sourceContentSha256: reuse.contentSha256,
    analysisId: analysis.analysisId,
    analysisHash: reuse.analysisHash,
    referenceShotId: shot.shotId,
    startSeconds: shot.startSeconds,
    endSeconds: shot.endSeconds,
    clipRef: evidence.clipRef,
    firstFrameRef: evidence.firstFrameRef,
    firstFrameSeconds: evidence.firstFrameSeconds,
  };
  return { ...payload, lockHash: socialRequestHash(payload) };
}

/** Fail closed immediately before provider preparation if source, interval or pixels drifted. */
export function assertSocialReferenceBackgroundAssetCurrent(input: {
  lock: SocialReferenceBackgroundAssetLock | null | undefined;
  referenceReuse: SocialReferenceReuseBinding | null | undefined;
  referenceAnalysis: SocialReferenceVideoAnalysis | null | undefined;
  expectedReferenceShotId: string | null | undefined;
}): SocialReferenceBackgroundAssetLock {
  const { lock, referenceReuse: reuse, referenceAnalysis: analysis } = input;
  if (!lock) fail('reference_background_lock_missing');
  if (!reuse || !analysis) fail('reference_background_source_missing');
  if (lock.schemaVersion !== 'social-reference-background-lock.v1'
    || !SHA256.test(lock.sourceContentSha256)
    || !SHA256.test(lock.analysisHash)
    || lock.lockHash !== socialRequestHash(lockPayload(lock))) {
    fail('reference_background_lock_changed');
  }
  if (lock.referenceRecordId !== reuse.recordId
    || lock.referenceSourceId !== analysis.referenceSourceId
    || lock.sourceContentSha256 !== reuse.contentSha256
    || lock.analysisId !== reuse.analysisId
    || lock.analysisId !== analysis.analysisId
    || lock.analysisHash !== reuse.analysisHash
    || lock.referenceRecordId !== analysis.referenceRecordId) {
    fail('reference_background_source_changed');
  }
  if (!input.expectedReferenceShotId || lock.referenceShotId !== input.expectedReferenceShotId) {
    fail('reference_background_shot_changed');
  }
  const shot = analysis.shots.find(item => item.shotId === lock.referenceShotId);
  const evidence = shot?.materialEvidence;
  if (!shot
    || shot.startSeconds !== lock.startSeconds
    || shot.endSeconds !== lock.endSeconds
    || evidence?.extractionStatus !== 'ready'
    || evidence.clipRef !== lock.clipRef
    || evidence.firstFrameRef !== lock.firstFrameRef
    || evidence.firstFrameSeconds !== lock.firstFrameSeconds) {
    fail('reference_background_evidence_changed');
  }
  return lock;
}
