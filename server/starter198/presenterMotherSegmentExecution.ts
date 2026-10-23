import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { verifyFrozenPresenterMotherSegments, type FrozenPresenterMotherSegments } from '../../shared/contracts/presenterMotherSegments.js';
import type { SocialProductionAsset } from './socialContentProductionPlan.js';

export interface PresenterMotherProviderRequest {
  taskId: string;
  segmentId: string;
  segmentHash: string;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  spokenText: string;
  memberSlotIds: string[];
}

export interface PresenterMotherProviderResult {
  providerId: string;
  providerReceiptRef: string;
  outputRef: string;
  outputSha256: string;
  durationSeconds: number;
  dynamicQa: {
    identitySimilarity:number;
    identityThreshold:number;
    segmentHash?:string;
    outputVideoSha256?:string;
    /** These are measured against the actual frozen scene audio and rendered
     * output, not inferred from the script or the approved first frame. */
    frozenAudioSha256?:string;
    outputAudioSha256?:string;
    audioTrackMatchesFrozen?:boolean;
    audioTrackReceiptRef?:string;
    audioTrackReportHash?:string;
    lipSyncScore?:number|null;
    lipSyncThreshold?:number|null;
    lipSyncStatus?:'passed'|'skipped_unconfigured';
    lipSyncModelSha256?:string;
    lipSyncReceiptRef?:string;
    receiptRef:string;
    reportHash:string;
  };
}

export interface PresenterMotherExecutionReceipt {
  segmentId: string;
  segmentHash: string;
  providerId: string;
  providerReceiptRef: string;
  outputRef: string;
  outputSha256: string;
  durationSeconds: number;
  dynamicQa: PresenterMotherProviderResult['dynamicQa'] & {passed:true};
  receiptHash: string;
}

export interface PresenterSlotCropReceipt {
  slotId: string;
  referenceShotId: string;
  segmentId: string;
  segmentHash: string;
  providerReceiptHash: string;
  sourceOutputRef: string;
  sourceOutputSha256: string;
  cropStartSeconds: number;
  cropEndSeconds: number;
  durationSeconds: number;
  receiptHash: string;
}

export interface PresenterMotherExecutionResult {
  schemaVersion: 'presenter-mother-execution.v1';
  taskId: string;
  groupingHash: string;
  providerReceipts: PresenterMotherExecutionReceipt[];
  slotCropReceipts: PresenterSlotCropReceipt[];
  recordHash: string;
}

const HASH = /^[a-f0-9]{64}$/;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const verifiedQa = (qa:PresenterMotherProviderResult['dynamicQa']|undefined,segmentHash:string,outputSha256:string):boolean => Boolean(qa
  && HASH.test(qa.reportHash) && qa.receiptRef?.trim()
  && qa.segmentHash===segmentHash && qa.outputVideoSha256===outputSha256
  && Number.isFinite(qa.identitySimilarity) && Number.isFinite(qa.identityThreshold)
  && qa.identitySimilarity >= qa.identityThreshold
  && HASH.test(qa.frozenAudioSha256||'') && HASH.test(qa.outputAudioSha256||'')
  && qa.audioTrackMatchesFrozen === true && qa.audioTrackReceiptRef?.trim()
  && HASH.test(qa.audioTrackReportHash||'')
  && qa.lipSyncStatus === 'passed' && HASH.test(qa.lipSyncModelSha256||'')
  && qa.lipSyncReceiptRef?.trim()
  && Number.isFinite(qa.lipSyncScore) && Number.isFinite(qa.lipSyncThreshold)
  && Number(qa.lipSyncScore) >= Number(qa.lipSyncThreshold));

/** Pure orchestration seam: callers own budget admission, cache lookup and the
 * actual provider implementation. This helper guarantees one invocation per
 * frozen mother segment and derives immutable per-slot crop receipts. */
export async function executePresenterMotherSegments(input: {
  grouping: FrozenPresenterMotherSegments;
  provider: (request: PresenterMotherProviderRequest) => Promise<PresenterMotherProviderResult>;
}): Promise<PresenterMotherExecutionResult> {
  if (!verifyFrozenPresenterMotherSegments(input.grouping)) throw new Error('presenter_mother_grouping_invalid');
  const providerReceipts: PresenterMotherExecutionReceipt[] = [];
  const slotCropReceipts: PresenterSlotCropReceipt[] = [];
  for (const group of input.grouping.groups) {
    const provided = await input.provider({
      taskId: input.grouping.taskId,
      segmentId: group.segmentId,
      segmentHash: group.contentHash,
      startSeconds: group.startSeconds,
      endSeconds: group.endSeconds,
      durationSeconds: group.durationSeconds,
      spokenText: group.mergedSpokenText,
      memberSlotIds: [...group.memberSlotIds],
    });
    const qa=provided.dynamicQa;
    const qaPassed=verifiedQa(qa,group.contentHash,provided.outputSha256);
    if (!provided.providerId.trim() || !provided.providerReceiptRef.trim() || !provided.outputRef.trim() || !HASH.test(provided.outputSha256)||!qaPassed
      || !Number.isFinite(provided.durationSeconds) || provided.durationSeconds + .001 < group.durationSeconds) {
      throw new Error(`${qa&&!qaPassed?'presenter_mother_dynamic_qa_failed':'presenter_mother_provider_result_invalid'}:${group.segmentId}`);
    }
    const receiptBody = {
      segmentId: group.segmentId,
      segmentHash: group.contentHash,
      providerId: provided.providerId,
      providerReceiptRef: provided.providerReceiptRef,
      outputRef: provided.outputRef,
      outputSha256: provided.outputSha256,
      durationSeconds: provided.durationSeconds,
      dynamicQa:{...qa,passed:true as const},
    };
    const receipt = { ...receiptBody, receiptHash: digest(receiptBody) };
    providerReceipts.push(receipt);
    for (const member of group.members) {
      const cropBody = {
        slotId: member.slotId,
        referenceShotId: member.referenceShotId,
        segmentId: group.segmentId,
        segmentHash: group.contentHash,
        providerReceiptHash: receipt.receiptHash,
        sourceOutputRef: receipt.outputRef,
        sourceOutputSha256: receipt.outputSha256,
        cropStartSeconds: member.startSeconds - group.startSeconds,
        cropEndSeconds: member.endSeconds - group.startSeconds,
        durationSeconds: member.endSeconds - member.startSeconds,
      };
      slotCropReceipts.push({ ...cropBody, receiptHash: digest(cropBody) });
    }
  }
  const body = {
    schemaVersion: 'presenter-mother-execution.v1' as const,
    taskId: input.grouping.taskId,
    groupingHash: input.grouping.recordHash,
    providerReceipts,
    slotCropReceipts,
  };
  return { ...body, recordHash: digest(body) };
}

export function verifyPresenterMotherExecutionResult(value: PresenterMotherExecutionResult): boolean {
  if(value.schemaVersion!=='presenter-mother-execution.v1'||!value.taskId||!HASH.test(value.groupingHash)||!HASH.test(value.recordHash)||!value.providerReceipts.length||!value.slotCropReceipts.length)return false;
  const providers=new Map<string,PresenterMotherExecutionReceipt>();
  for(const receipt of value.providerReceipts){
    const {receiptHash,...body}=receipt;
    const qa=receipt.dynamicQa;
    if(providers.has(receipt.segmentId)||!HASH.test(receipt.segmentHash)||!HASH.test(receipt.outputSha256)||!qa||qa.passed!==true||!verifiedQa(qa,receipt.segmentHash,receipt.outputSha256)||receiptHash!==digest(body))return false;
    providers.set(receipt.segmentId,receipt);
  }
  const slots=new Set<string>();
  for(const crop of value.slotCropReceipts){
    const {receiptHash,...body}=crop,provider=providers.get(crop.segmentId);
    if(slots.has(crop.slotId)||!provider||crop.segmentHash!==provider.segmentHash||crop.providerReceiptHash!==provider.receiptHash||crop.sourceOutputRef!==provider.outputRef||crop.sourceOutputSha256!==provider.outputSha256||crop.cropStartSeconds<0||crop.cropEndSeconds<=crop.cropStartSeconds||crop.cropEndSeconds>provider.durationSeconds+.001||crop.durationSeconds!==crop.cropEndSeconds-crop.cropStartSeconds||receiptHash!==digest(body))return false;
    slots.add(crop.slotId);
  }
  const {recordHash,...body}=value;return recordHash===digest(body);
}

/** A durable asset-supply checkpoint is not a new QA verdict. Re-open the
 * measured reports and local media before accepting a cached mother segment;
 * old text-only HeyGen checkpoints have no such proof and fail closed. */
export async function assertRestoredPresenterMotherExecution(input: {
  grouping: FrozenPresenterMotherSegments;
  execution: PresenterMotherExecutionResult | null | undefined;
  frozenAudioSha256BySegment: ReadonlyMap<string, string>;
  assets: SocialProductionAsset[];
}): Promise<void> {
  const { grouping, execution } = input;
  if (!verifyFrozenPresenterMotherSegments(grouping) || !execution
    || !verifyPresenterMotherExecutionResult(execution)
    || execution.taskId !== grouping.taskId || execution.groupingHash !== grouping.recordHash
    || execution.providerReceipts.length !== grouping.groups.length
    || execution.slotCropReceipts.length !== grouping.groups.reduce((sum, group) => sum + group.members.length, 0)) {
    throw Error('presenter_mother_cached_qa_unverified');
  }
  const motherAssets = input.assets.filter(asset => asset.id.startsWith('presenter-mother-crop-'));
  const assetBySlot = new Map(motherAssets.map(asset => [asset.sourceId, asset]));
  if (motherAssets.length !== execution.slotCropReceipts.length || assetBySlot.size !== motherAssets.length) throw Error('presenter_mother_cached_qa_unverified');
  for (const group of grouping.groups) {
    const provider = execution.providerReceipts.find(receipt => receipt.segmentId === group.segmentId);
    const audioSha = input.frozenAudioSha256BySegment.get(group.segmentId);
    if (!provider || provider.segmentHash !== group.contentHash || !audioSha
      || provider.dynamicQa.frozenAudioSha256 !== audioSha
      || provider.durationSeconds + .001 < group.durationSeconds) throw Error('presenter_mother_cached_qa_unverified');
    let source: Buffer, audioReport: Record<string, unknown>, lipReport: Record<string, unknown>;
    try {
      source = await readFile(provider.outputRef);
      audioReport = JSON.parse(await readFile(provider.dynamicQa.audioTrackReceiptRef!, 'utf8'));
      lipReport = JSON.parse(await readFile(provider.dynamicQa.lipSyncReceiptRef!, 'utf8'));
    } catch { throw Error('presenter_mother_cached_qa_bytes_unavailable'); }
    if (digestBytes(source) !== provider.outputSha256
      || !verifiedMeasuredAudioReport(audioReport, provider, audioSha)
      || !verifiedMeasuredLipReport(lipReport, provider)) throw Error('presenter_mother_cached_qa_unverified');
    const crops = execution.slotCropReceipts.filter(receipt => receipt.segmentId === group.segmentId);
    if (crops.length !== group.members.length) throw Error('presenter_mother_cached_qa_unverified');
    for (const member of group.members) {
      const crop = crops.find(receipt => receipt.slotId === member.slotId);
      const asset = assetBySlot.get(member.slotId);
      if (!crop || crop.referenceShotId !== member.referenceShotId
        || Math.abs(crop.cropStartSeconds - (member.startSeconds - group.startSeconds)) > .001
        || Math.abs(crop.cropEndSeconds - (member.endSeconds - group.startSeconds)) > .001
        || !asset?.localPath || asset.id !== `presenter-mother-crop-${crop.receiptHash.slice(0, 24)}`
        || asset.authorizationRef !== `presenter-mother:${grouping.recordHash}`
        || !asset.segments?.some(segment => segment.slotCropReceiptHash === crop.receiptHash)
        || !asset.contentHash) throw Error('presenter_mother_cached_qa_unverified');
      let bytes: Buffer;
      try { bytes = await readFile(asset.localPath); } catch { throw Error('presenter_mother_cached_qa_bytes_unavailable'); }
      if (digestBytes(bytes) !== asset.contentHash) throw Error('presenter_mother_cached_qa_unverified');
    }
  }
}

const digestBytes = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function verifiedMeasuredAudioReport(value: Record<string, unknown>, provider: PresenterMotherExecutionReceipt, audioSha: string): boolean {
  const { reportHash, ...body } = value;
  const comparison = value.comparison as Record<string, unknown> | undefined;
  return value.schemaVersion === 'presenter-mother-audio-track.v1'
    && value.segmentHash === provider.segmentHash && value.outputVideoSha256 === provider.outputSha256
    && value.frozenAudioSha256 === audioSha && value.outputAudioSha256 === provider.dynamicQa.outputAudioSha256
    && reportHash === digest(body) && reportHash === provider.dynamicQa.audioTrackReportHash
    && comparison?.passed === true && Number(comparison.correlation) >= .9
    && Number(comparison.durationDriftMs) <= 120;
}
function verifiedMeasuredLipReport(value: Record<string, unknown>, provider: PresenterMotherExecutionReceipt): boolean {
  const { reportHash, ...body } = value;
  const sync = value.sync as Record<string, unknown> | undefined;
  const thresholds = sync?.thresholds as Record<string, unknown> | undefined;
  return value.schemaVersion === 'presenter-mother-syncnet.v1'
    && value.segmentHash === provider.segmentHash && value.outputVideoSha256 === provider.outputSha256
    && value.outputAudioSha256 === provider.dynamicQa.outputAudioSha256
    && reportHash === digest(body) && sync?.version === 1 && sync.detector === 'official_syncnet'
    && sync.modelSha256 === provider.dynamicQa.lipSyncModelSha256
    && sync.passed === true && Number(sync.confidence) === provider.dynamicQa.lipSyncScore
    && Number(thresholds?.confidenceMin) === provider.dynamicQa.lipSyncThreshold
    && Number(sync.confidence) >= Math.max(7, Number(thresholds?.confidenceMin))
    && Number(thresholds?.absoluteOffsetFramesMax) <= 1
    && Math.abs(Number(sync.avOffsetFrames)) <= Number(thresholds?.absoluteOffsetFramesMax)
    && Array.isArray(sync.failures) && sync.failures.length === 0;
}
