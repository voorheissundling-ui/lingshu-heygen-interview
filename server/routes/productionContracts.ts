import type { HeyGenClient, HeyGenInput } from '../lib/heygen.js';
import type { AvatarJob, PresenterAsset, ShotProduction } from '../../src/lib/shotProduction.js';
import type { DigitalHumanExecutionAdapter, DigitalHumanToolId } from '../lib/digitalHumanProviderRegistry.js';
import type { DigitalHumanExecutionRecord, DigitalHumanPlanRecord, DigitalHumanReferenceCue, SentenceFirstFrameDraftResult, SentenceReplicationResult } from '../../src/lib/digitalHumanPlan.js';
import type { ModelQualityDecision, ModelQualityKey, ReferenceTechnicalMetrics, ReferenceVisualMetrics } from '../../src/lib/digitalHumanQuality.js';
import type { SentenceReplicationReadiness } from '../runtime/readiness.js';
import type { MaterialRecord } from '../lib/materialLibrary.js';

export type JobRecord = { id: string; tenant_id: string; project_id: string; request_id: string; payload: AvatarJob; input: HeyGenInput };
export type PlanStoreRecord = { id: string; tenant_id: string; project_id: string; shot_key: string; fingerprint: string; payload: DigitalHumanPlanRecord };
export type ExecutionStoreRecord = { id: string; tenant_id: string; project_id: string; job_id: string; plan_id: string; request_id?: string; payload: DigitalHumanExecutionRecord };
export type SentenceJobRecord = { id: string; tenant_id: string; project_id: string; request_id: string; payload: { state: 'running' | 'completed' | 'failed' | 'uncertain'; fingerprint: string; assemblyId: string; shotId: string; providerTasks?: Record<string,string>; result?: SentenceReplicationResult; error?: string; createdAt: string; updatedAt: string } };
export type FirstFrameDraftJobRecord = { id: string; tenant_id: string; project_id: string; request_id: string; payload: { state: 'running' | 'completed' | 'failed'; fingerprint: string; assemblyId: string; shotId: string; result?: SentenceFirstFrameDraftResult; error?: string; createdAt: string; updatedAt: string } };
export type ImportedVideoResult = { materialId: string; objectKey?: string; localFile?: string; contentSha256?: string; objectEtag?: string };
export type ReferenceImportResult = ImportedVideoResult & { technicalMetrics?: ReferenceTechnicalMetrics; visualMetrics?: ReferenceVisualMetrics };
export interface ProductionRouterOptions {
  recoverAvatarSourceCaptions?: (remoteId: string, duration: number, script: string) => Promise<Array<{ text: string; start: number; end: number }>>;
  measureAvatarSourceCaptions?: (material: MaterialRecord, tenantId: string, bytes?: Buffer) => Promise<{ transcript: string; cues: Array<{ text: string; start: number; end: number }>; provenance: string; sourceHash: string }>;
  reserveAvatarSourceAsr?: (operationId: string) => Promise<void>;
  preparePhotoTalkingFirstFrames?: (input:{tenantId:string;projectId:string;assemblyId:string;presenter:PresenterAsset;cues:DigitalHumanReferenceCue[];certifyForSeedance?:boolean;requirements?:import('../../shared/contracts/digitalHumanRequirements.js').DigitalHumanRequirements})=>Promise<{cues:DigitalHumanReferenceCue[]}>;
  client?: HeyGenClient; enabled?: () => boolean; lockRoot?: string; reserve?: (id: string) => Promise<void>;
  prepareAudio?: (ref: NonNullable<HeyGenInput['audioRef']>, tenantId: string) => Promise<Uint8Array | { bytes: Uint8Array; segmentId: string; checksumSha256: string; start: number; duration: number }>;
  adapters?: DigitalHumanExecutionAdapter[]; referenceBudgetLimitCny?: number; maxAttemptsPerShot?: number;
  reserveReference?: (tool: DigitalHumanToolId, id: string, estimatedCostCny: number | null, tenantId: string) => Promise<void>; releaseReference?: (tool: DigitalHumanToolId, id: string, tenantId: string) => Promise<void>;
  importReferenceVideo?: (url: string, execution: DigitalHumanExecutionRecord, tenantId: string) => Promise<ReferenceImportResult>; importReferenceObject?: (objectKey: string, execution: DigitalHumanExecutionRecord, tenantId: string) => Promise<ReferenceImportResult>;
  resolveReferenceInputs?: (input: { shot: ShotProduction; presenter: PresenterAsset; tenantId: string }) => Promise<{ characterUrl: string; characterType: 'image' | 'video'; characterMaterialId?: string; characterObjectKey?: string; characterObjectEtag?: string; referenceVideoUrl: string; referenceClipKey?: string; referenceClipObjectEtag?: string; referenceSourceObjectEtag?: string; referenceMaterialId?: string; referenceStart?: number; referenceDuration?: number }>;
  inspectReferenceQuality?: (input: { referenceClipObjectKey: string; referenceMaterialId: string; presenterReferenceMaterialIds: string[]; candidateMaterialId: string; candidateVideoUrl: string; execution: DigitalHumanExecutionRecord; tenantId: string }) => Promise<Partial<Record<ModelQualityKey, ModelQualityDecision>>>;
  verifyCandidateOutput?: (evidence: NonNullable<DigitalHumanExecutionRecord['candidateOutput']>, tenantId: string) => Promise<boolean>; verifyReferenceInputs?: (snapshot: NonNullable<DigitalHumanExecutionRecord['inputSnapshot']>, tenantId: string) => Promise<boolean>;
  reconcileHeyGenCost?: (externalTaskId: string) => Promise<{ actualCostCny?: number; costSourceRef?: string }>; validatePresenterMaterials?: (tenantId: string, materialIds: string[]) => Promise<void>;
  verifyArkAsset?: (input: { tenantId: string; projectName: string; groupId: string; assetId: string }) => Promise<{ status: 'processing' | 'active' | 'failed'; assetType: 'image' | 'video'; failureReason?: string }>; bindArkAsset?: (input: { tenantId: string; presenterId: string; certification: NonNullable<PresenterAsset['arkCertification']> }) => Promise<void>;
  prepareSentenceFirstFrames?: (input: { tenantId: string; referenceMaterialId: string; cues: DigitalHumanReferenceCue[]; sourceMaterial?: MaterialRecord; autoSplitPhysicalCuts?: boolean }) => Promise<DigitalHumanReferenceCue[]>; generateSentenceFirstFrameDrafts?: (input:{tenantId:string;projectId:string;assemblyId:string;presenter:PresenterAsset;cues:DigitalHumanReferenceCue[]})=>Promise<SentenceFirstFrameDraftResult>;
  runSentenceReplication?: (input: { tenantId: string; projectId: string; assemblyId: string; shotId: string; fingerprint: string; shot: ShotProduction; presenter: PresenterAsset; cues: DigitalHumanReferenceCue[]; requestId: string; maxCostCny?: number; targetLanguage?: string; sourceMaterial?: MaterialRecord; existingProviderTasks?: Record<string,string>; reuseCueMaterialIds?:Record<string,string>; reuseCueQuality?:NonNullable<SentenceReplicationResult['cueQuality']>; onProviderTaskSubmitted?: (cueId:string,taskId:string)=>Promise<void> }) => Promise<SentenceReplicationResult>;
  sentenceReplicationReadiness?: () => SentenceReplicationReadiness; toolUnavailableReasons?: Partial<Record<DigitalHumanToolId, string>>;
}
